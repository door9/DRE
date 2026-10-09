// HTML·XML 꼴로 저장된 엑셀 파일 읽기 — 이름은 '.xls' 지만 속은 웹 페이지 표(한국거래소 상장법인목록 등)이거나
// 엑셀 2003 XML(통계청 KOSIS 내려받기 등)인 파일. 엑셀이 열어 보여 주는 것과 같은 셀 글을 시트 자료로 모은다.
import { parseXml, kids, kid, attr, descendants, decodeEntities, textOf } from './xml.js';
import { formatValue, BUILTIN } from './xlfmt.js';
import { sheetsToModel } from './sheet.js';

const fail = (code, message) => Object.assign(new Error(message), { code });

// 바이트 앞부분으로 꼴 가리기: 'xml' | 'html' | null
export function markupKind(u8) {
  const head = latin1(u8.subarray(0, Math.min(u8.length, 4096))).replace(/^\uFEFF|^\xEF\xBB\xBF/, '');
  if (/urn:schemas-microsoft-com:office:spreadsheet/.test(head) && /<(?:\w+:)?Workbook\b/.test(head + latin1(u8.subarray(4096, 16384)))) return 'xml';
  if (/^\s*<\?xml/i.test(head) && /<(?:ss:)?Workbook\b/.test(head)) return 'xml';
  if (/<(?:!doctype\s+html|html|table|head|body|meta)\b/i.test(head)) return 'html';
  return null;
}

function latin1(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}

// 글자 풀기: BOM → UTF-8(틀림 없이 풀리면) → 문서가 밝힌 charset → euc-kr(cp949)
function decodeText(u8) {
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { /* 아래로 */ }
  const head = latin1(u8.subarray(0, Math.min(u8.length, 4096)));
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(head) || /encoding\s*=\s*["']([\w-]+)/i.exec(head);
  let cs = m ? m[1].toLowerCase() : 'euc-kr';
  if (/^(ks_c_5601|ksc5601|cp949|x-windows-949|windows-949|uhc)/.test(cs)) cs = 'euc-kr';
  try { return new TextDecoder(cs).decode(u8); } catch { return new TextDecoder('euc-kr').decode(u8); }
}

// ─── 엑셀 2003 XML(SpreadsheetML) ───
// 이름 붙은 서식 → 서식 글(한국어 엑셀 기준)
const NAMED = {
  general: 'General', 'general number': 'General', 'general date': BUILTIN[22], 'short date': BUILTIN[14], 'medium date': BUILTIN[15],
  'long date': 'yyyy"년" m"월" d"일" aaaa', 'short time': BUILTIN[20], 'medium time': BUILTIN[18], 'long time': BUILTIN[21],
  fixed: '0.00', standard: '#,##0.00', percent: '0.00%', scientific: '0.00E+00', currency: BUILTIN[7], 'euro currency': '"€"#,##0.00',
  'yes/no': '"Yes";"Yes";"No"', 'true/false': '"True";"True";"False"', 'on/off': '"On";"On";"Off"',
};

function xmlSheets(src) {
  const root = parseXml(src);
  const wb = descendants(root, 'Workbook')[0] || root;
  // 꼴: 아이디 → { fmt, parent }
  const styles = new Map();
  for (const s of descendants(kid(wb, 'Styles'), 'Style')) {
    const nf = kid(s, 'NumberFormat');
    styles.set(attr(s, 'ID'), { fmt: nf ? attr(nf, 'Format') : undefined, parent: attr(s, 'Parent') });
  }
  const fmtOf = (id) => {
    const seen = new Set();
    while (id && styles.has(id) && !seen.has(id)) {
      seen.add(id);
      const s = styles.get(id);
      if (s.fmt !== undefined) return NAMED[String(s.fmt).toLowerCase()] ?? s.fmt;
      id = s.parent;
    }
    const d = styles.get('Default');
    return d && d.fmt !== undefined ? NAMED[String(d.fmt).toLowerCase()] ?? d.fmt : 'General';
  };
  const date1904 = /<(?:\w+:)?Date1904\b/.test(src);
  const sheets = [];
  for (const ws of kids(wb, 'Worksheet')) {
    const name = attr(ws, 'Name') || `Sheet${sheets.length + 1}`;
    const opts = kid(ws, 'WorksheetOptions');
    const vis = opts ? textOf(kid(opts, 'Visible') || { c: [] }).trim() : '';
    const hidden = /SheetHidden|SheetVeryHidden/.test(vis);
    const cells = new Map(), merges = [], hiddenRows = new Set(), hiddenCols = new Set();
    const table = kid(ws, 'Table');
    if (table) {
      const tableStyle = attr(table, 'StyleID');
      const colStyle = new Map();
      let c = 0;
      for (const col of kids(table, 'Column')) {
        if (attr(col, 'Index')) c = +attr(col, 'Index') - 1;
        const span = 1 + Math.max(0, +(attr(col, 'Span') || 0));
        for (let k = 0; k < Math.min(span, 16384); k++) {
          if (attr(col, 'Hidden') === '1' || attr(col, 'Hidden') === 'true') hiddenCols.add(c + k);
          if (attr(col, 'StyleID')) colStyle.set(c + k, attr(col, 'StyleID'));
        }
        c += span;
      }
      let r = 0;
      for (const row of kids(table, 'Row')) {
        if (attr(row, 'Index')) r = +attr(row, 'Index') - 1;
        const span = 1 + Math.max(0, +(attr(row, 'Span') || 0));
        if (attr(row, 'Hidden') === '1' || attr(row, 'Hidden') === 'true') for (let k = 0; k < Math.min(span, 100000); k++) hiddenRows.add(r + k);
        const rowStyle = attr(row, 'StyleID');
        let cc = 0;
        let line = null;
        for (const cell of kids(row, 'Cell')) {
          if (attr(cell, 'Index')) cc = +attr(cell, 'Index') - 1;
          const across = Math.max(0, +(attr(cell, 'MergeAcross') || 0)), down = Math.max(0, +(attr(cell, 'MergeDown') || 0));
          if (across || down) merges.push({ r0: r, c0: cc, r1: r + down, c1: cc + across });
          const data = kid(cell, 'Data');
          if (data) {
            const type = attr(data, 'Type') || 'String';
            const raw = textOf(data);
            let value;
            if (type === 'Number') { const n = Number(raw); value = raw.trim() === '' || isNaN(n) ? raw : n; }
            else if (type === 'DateTime') { const ms = Date.parse(raw.replace(/Z?$/, 'Z')); value = isNaN(ms) ? raw : ms / 86400000 + (date1904 ? 24107 : 25569); }
            else if (type === 'Boolean') value = raw.trim() === '1' || /^true$/i.test(raw.trim());
            else if (type === 'Error') value = { error: raw.trim() };
            else value = raw;
            let shown;
            try { shown = formatValue(value, fmtOf(attr(cell, 'StyleID') || rowStyle || colStyle.get(cc) || tableStyle)); } catch { shown = String(raw); }
            if (shown !== '') {
              if (!line) { line = cells.get(r); if (!line) { line = new Map(); cells.set(r, line); } }
              line.set(cc, shown);
            }
          }
          cc += 1 + across;
        }
        r += span;
      }
    }
    sheets.push({ name, hidden, cells, merges, hiddenRows, hiddenCols, extras: [] });
  }
  return sheets;
}

// ─── 웹 페이지 표(HTML) ───
const HTML_ENT = {
  nbsp: ' ', middot: '·', copy: '©', reg: '®', trade: '™', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  bull: '•', laquo: '«', raquo: '»', times: '×', divide: '÷', plusmn: '±', deg: '°', micro: 'µ', para: '¶', sect: '§', cent: '¢', pound: '£',
  yen: '¥', euro: '€', emsp: ' ', ensp: ' ', thinsp: ' ', zwnj: '', zwj: '', lrm: '', rlm: '', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};
function htmlDecode(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);?/g, (m, e) => {
    if (e[0] === '#') { const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(code); } catch { return ''; } }
    const v = HTML_ENT[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}
const attrIn = (s, n) => { const m = new RegExp('(?:^|\\s)' + n + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(s); return m ? (m[1] ?? m[2] ?? m[3]) : null; };

function htmlSheets(src) {
  src = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (m, t) => (t.toLowerCase() === 'title' ? m : ''));
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src);
  const title = titleM ? htmlDecode(titleM[1]).replace(/\s+/g, ' ').trim() : '';
  const tables = [];
  const stack = [];
  let cell = null, row = null;
  const cur = () => stack[stack.length - 1];
  const closeCell = () => {
    const t = cur();
    if (t && t.cell) { t.row.push(t.cell); t.cell = null; }
  };
  const closeRow = () => {
    const t = cur();
    if (!t) return;
    closeCell();
    if (t.row) { if (!t.rowHidden) t.rows.push(t.row); t.row = null; }
  };
  const re = /<(\/?)([a-zA-Z][\w:-]*)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[4] != null) {
      const t = cur();
      if (t && t.cell) t.cell.text += m[4];
      continue;
    }
    const close = m[1] === '/', tag = m[2].toLowerCase(), at = m[3] || '';
    const t = cur();
    if (tag === 'table') {
      if (!close) stack.push({ rows: [], row: null, cell: null, rowHidden: false });
      else if (t) {
        closeRow();
        stack.pop();
        const parent = cur();
        // 칸 안의 표는 그 칸의 글로(줄마다 칸을 ' | ' 로)
        if (parent && parent.cell) parent.cell.text += '\n' + t.rows.map((r) => r.map((c) => tidyCell(c.text)).filter(Boolean).join(' | ')).filter(Boolean).join('\n') + '\n';
        else tables.push(t.rows);
      }
      continue;
    }
    if (!t) continue;
    if (tag === 'tr') {
      closeRow();
      if (!close) { t.row = []; t.rowHidden = /display\s*:\s*none/i.test(attrIn(at, 'style') || ''); }
      continue;
    }
    if (tag === 'td' || tag === 'th') {
      closeCell();
      if (!close) {
        if (!t.row) { t.row = []; t.rowHidden = false; }
        t.cell = { text: '', cs: Math.max(1, Math.min(1000, +(attrIn(at, 'colspan') || 1) || 1)), rs: Math.max(1, Math.min(10000, +(attrIn(at, 'rowspan') || 1) || 1)) };
      }
      continue;
    }
    if (t.cell && (tag === 'br' || (close && /^(p|div|li|h[1-6])$/.test(tag)))) t.cell.text += '\n';
  }
  while (stack.length) { closeRow(); tables.push(stack.pop().rows); }
  // 표들을 한 시트에 위에서 아래로(엑셀이 웹 페이지를 열 때처럼), 표 사이 한 줄 띄움
  const cells = new Map(), merges = [];
  let r = 0;
  for (const rows of tables) {
    const taken = new Set(); // 위 행의 세로 합침이 차지한 자리
    for (const rw of rows) {
      let c = 0;
      for (const cl of rw) {
        while (taken.has(r + ',' + c)) c++;
        const s = tidyCell(cl.text);
        if (s) { let line = cells.get(r); if (!line) { line = new Map(); cells.set(r, line); } line.set(c, s); }
        if (cl.cs > 1 || cl.rs > 1) {
          merges.push({ r0: r, c0: c, r1: r + cl.rs - 1, c1: c + cl.cs - 1 });
          for (let a = 0; a < cl.rs; a++) for (let b = 0; b < cl.cs; b++) if (a || b) taken.add((r + a) + ',' + (c + b));
        }
        c += cl.cs;
      }
      r++;
    }
    r++;
  }
  return { sheets: [{ name: title || 'Sheet1', hidden: false, cells, merges, hiddenRows: new Set(), hiddenCols: new Set(), extras: [] }], tables: tables.length };
}

function tidyCell(s) {
  return htmlDecode(s).split('\n').map((l) => l.replace(/[ \t\r\f\v\u00a0]+/g, ' ').trim()).filter(Boolean).join('\n');
}

// 들머리 — sheetsOnly: 시험용 시트 자료
export function parseXlsMarkup(bytes, { sheetsOnly = false } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const kind = markupKind(u8);
  if (!kind) throw fail('broken', '엑셀 파일을 읽지 못했습니다(손상되었거나 다른 형식입니다)');
  const src = decodeText(u8);
  let sheets, warn = null;
  if (kind === 'xml') sheets = xmlSheets(src);
  else {
    const r = htmlSheets(src);
    sheets = r.sheets;
    if (!r.tables && /<link[^>]+(?:shLink|File-List)|<frameset/i.test(src)) warn = '엑셀이 \'웹 페이지\'로 저장한 파일이라 표 내용이 함께 저장된 폴더(…files)에 따로 있어 읽을 수 없습니다.';
  }
  if (sheetsOnly) return { sheets };
  const model = sheetsToModel('xls', sheets);
  if (warn) model.warnings.push(warn);
  return model;
}
