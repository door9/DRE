// 엑셀 XLSX(XLSM) 읽기 — 시트의 셀 값을 엑셀이 화면에 그리는 글(서식 적용)로 모아 문서 모델로.
// 숨긴 시트·행·열은 빼고, 합친 칸·글상자 글을 살린다. 큰 시트도 빠르게: 셀 부분은 나무로 만들지 않고 바로 훑는다.
import { unzipSync, strFromU8 } from '../../vendor/fflate.mjs';
import { parseXml, kids, kid, attr, descendants, decodeEntities } from './xml.js';
import { formatValue, BUILTIN } from './xlfmt.js';
import { sheetsToModel, cellRef, rangeRef } from './sheet.js';

const fail = (code, message) => Object.assign(new Error(message), { code });

function readZip(u8) {
  try {
    return unzipSync(u8, { filter: (f) => /^(xl\/|_rels\/|\[Content_Types\]\.xml)/i.test(f.name) && !/\.(png|jpe?g|gif|emf|wmf|bin|tiff?|bmp|svg)$/i.test(f.name) });
  } catch {
    throw fail('broken', '엑셀 파일의 압축을 풀지 못했습니다(손상된 파일일 수 있습니다)');
  }
}

const text = (files, name) => (files[name] ? strFromU8(files[name]) : null);

// 관계 파일(_rels/x.rels): Id → 대상 경로(기준 폴더에서 푼 것)
function rels(files, partName) {
  const i = partName.lastIndexOf('/');
  const dir = i >= 0 ? partName.slice(0, i + 1) : '';
  const name = dir + '_rels/' + partName.slice(i + 1) + '.rels';
  const src = text(files, name);
  const map = new Map();
  if (!src) return map;
  for (const r of descendants(parseXml(src), 'Relationship')) {
    if (attr(r, 'TargetMode') === 'External') continue;
    map.set(attr(r, 'Id'), { target: resolvePath(dir, attr(r, 'Target') || ''), type: attr(r, 'Type') || '' });
  }
  return map;
}

export function resolvePath(dir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (dir + target).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

// OOXML 글 안의 _xHHHH_ 표기(줄바꿈 등)
const unX = (s) => (s.indexOf('_x') < 0 ? s : s.replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16))));

// <t> 글 모으기(읽는 법 표시 rPh 는 뺀다)
function runsText(xml) {
  const s = xml.replace(/<(?:[\w.-]+:)?rPh\b[\s\S]*?<\/(?:[\w.-]+:)?rPh>/g, '');
  let out = '';
  const re = /<(?:[\w.-]+:)?t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?t>)/g;
  let m;
  while ((m = re.exec(s))) if (m[1]) out += m[1];
  return unX(decodeEntities(out));
}

function sharedStrings(src) {
  const out = [];
  if (!src) return out;
  const re = /<(?:[\w.-]+:)?si(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?si>)/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1] ? runsText(m[1]) : '');
  return out;
}

function styles(src) {
  const fmts = new Map();
  const xfs = [];
  if (!src) return { xfs, fmts };
  const root = parseXml(src);
  const ss = kid(root, 'styleSheet') || root;
  for (const f of kids(kid(ss, 'numFmts'), 'numFmt')) fmts.set(+attr(f, 'numFmtId'), attr(f, 'formatCode') || 'General');
  for (const x of kids(kid(ss, 'cellXfs'), 'xf')) xfs.push(+(attr(x, 'numFmtId') || 0));
  return { xfs, fmts };
}

const attrOf = (s, n) => { const m = new RegExp('(?:^|\\s)' + n + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')').exec(s); return m ? (m[1] ?? m[2]) : null; };
const truthy = (v) => v === '1' || v === 'true';

// 시트 XML 훑기
function readSheet(src, ctx) {
  const cells = new Map();
  const hiddenRows = new Set();
  const hiddenCols = new Set();
  const merges = [];
  // 열 숨김
  const colsM = /<(?:[\w.-]+:)?cols\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?cols>/.exec(src);
  if (colsM) {
    const re = /<(?:[\w.-]+:)?col\b([^>]*)>/g;
    let m;
    while ((m = re.exec(colsM[1]))) {
      if (!truthy(attrOf(m[1], 'hidden'))) continue;
      const a = +attrOf(m[1], 'min'), b = +attrOf(m[1], 'max');
      if (a >= 1 && b >= a) for (let c = a; c <= Math.min(b, 16384); c++) hiddenCols.add(c - 1);
    }
  }
  const sdStart = src.search(/<(?:[\w.-]+:)?sheetData\b/);
  const sdEnd = src.search(/<\/(?:[\w.-]+:)?sheetData>/);
  if (sdStart >= 0) {
    const body = src.slice(sdStart, sdEnd > sdStart ? sdEnd : src.length);
    const re = /<(?:[\w.-]+:)?(row|c)\b([^>]*?)(\/?)>/g;
    const endC = /<\/(?:[\w.-]+:)?c>/g;
    let m, row = -1, nextCol = 0, cur = null;
    while ((m = re.exec(body))) {
      if (m[1] === 'row') {
        const r = attrOf(m[2], 'r');
        row = r ? +r - 1 : row + 1;
        nextCol = 0;
        if (truthy(attrOf(m[2], 'hidden'))) hiddenRows.add(row);
        cur = null;
        continue;
      }
      const ref = attrOf(m[2], 'r');
      let col = nextCol;
      if (ref) { const p = cellRef(ref); if (p) { col = p.c; if (p.r !== row) { row = p.r; cur = null; } } }
      nextCol = col + 1;
      if (m[3] === '/') continue; // 서식만 있는 빈 칸
      endC.lastIndex = re.lastIndex;
      const e = endC.exec(body);
      const inner = body.slice(re.lastIndex, e ? e.index : body.length);
      re.lastIndex = e ? endC.lastIndex : body.length;
      const t = attrOf(m[2], 't') || 'n';
      const s = +(attrOf(m[2], 's') || 0);
      let value = null;
      if (t === 'inlineStr') {
        const is = /<(?:[\w.-]+:)?is\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?is>/.exec(inner);
        value = is ? runsText(is[1]) : '';
      } else {
        const v = /<(?:[\w.-]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?v>/.exec(inner);
        if (!v) continue;
        const raw = decodeEntities(v[1]);
        if (t === 's') value = ctx.sst[+raw] ?? '';
        else if (t === 'str') value = unX(raw);
        else if (t === 'b') value = raw.trim() === '1' || raw.trim() === 'true';
        else if (t === 'e') value = { error: raw.trim() };
        else if (t === 'd') { const ms = Date.parse(raw); value = isNaN(ms) ? raw : ms / 86400000 + (ctx.date1904 ? 24107 : 25569); }
        else { const n = Number(raw); value = raw.trim() === '' || isNaN(n) ? raw : n; }
      }
      let shown;
      try {
        const fid = ctx.xfs[s] ?? 0;
        const code = ctx.fmts.get(fid) ?? BUILTIN[fid] ?? 'General';
        shown = formatValue(value, code, { date1904: ctx.date1904 });
      } catch {
        shown = typeof value === 'object' && value ? value.error || '' : String(value);
      }
      if (shown === '') continue;
      if (!cur) { cur = cells.get(row); if (!cur) { cur = new Map(); cells.set(row, cur); } }
      cur.set(col, shown);
    }
  }
  const mc = /<(?:[\w.-]+:)?mergeCells\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?mergeCells>/.exec(src);
  if (mc) {
    const re = /<(?:[\w.-]+:)?mergeCell\b([^>]*)>/g;
    let m;
    while ((m = re.exec(mc[1]))) { const r = rangeRef(attrOf(m[1], 'ref')); if (r) merges.push(r); }
  }
  return { cells, hiddenRows, hiddenCols, merges };
}

// 그림 판(drawing)의 글상자 글 — 놓인 자리(행·열) 순서로
function drawingTexts(files, partName) {
  const src = text(files, partName);
  if (!src) return [];
  const root = parseXml(src);
  const out = [];
  const anchors = [...descendants(root, 'twoCellAnchor'), ...descendants(root, 'oneCellAnchor'), ...descendants(root, 'absoluteAnchor')];
  for (const an of anchors) {
    const from = kid(an, 'from');
    const r = from ? +(kid(from, 'row')?.c.join('') || 0) : 0;
    const c = from ? +(kid(from, 'col')?.c.join('') || 0) : 0;
    const paras = [];
    for (const tb of descendants(an, 'txBody')) {
      for (const p of kids(tb, 'p')) {
        let s = '';
        for (const k of kids(p)) {
          if (k.l === 'r' || k.l === 'fld') s += descendants(k, 't').map((t) => t.c.join('')).join('');
          else if (k.l === 'br') s += '\n';
        }
        paras.push(s);
      }
    }
    const t = paras.join('\n').trim();
    if (t) out.push({ r, c, t });
  }
  out.sort((a, b) => a.r - b.r || a.c - b.c);
  return out.map((x) => x.t);
}

// sheetsOnly: 시험용 — 문서 모델 대신 시트 자료(셀 지도)를 돌려준다
export function parseXlsx(bytes, { onProgress, sheetsOnly = false } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0xd0 && u8[1] === 0xcf) throw fail('password', '암호가 걸린 엑셀 문서입니다');
  const files = readZip(u8);
  // 본문(workbook) 찾기
  let wbName = 'xl/workbook.xml';
  const top = rels(files, '');
  for (const r of top.values()) if (/officeDocument$/.test(r.type) && files[r.target]) wbName = r.target;
  const wbSrc = text(files, wbName);
  if (!wbSrc) throw fail('broken', '엑셀 문서 본문을 찾지 못했습니다');
  const wb = parseXml(wbSrc);
  const wbRoot = kid(wb, 'workbook') || wb;
  const date1904 = truthy(attr(kid(wbRoot, 'workbookPr'), 'date1904'));
  const wbRels = rels(files, wbName);
  const dir = wbName.slice(0, wbName.lastIndexOf('/') + 1);
  let sst = [], st = { xfs: [], fmts: new Map() };
  for (const r of wbRels.values()) {
    if (/sharedStrings$/.test(r.type)) sst = sharedStrings(text(files, r.target));
    else if (/styles$/.test(r.type)) st = styles(text(files, r.target));
  }
  if (!sst.length && files[dir + 'sharedStrings.xml']) sst = sharedStrings(text(files, dir + 'sharedStrings.xml'));
  if (!st.xfs.length && files[dir + 'styles.xml']) st = styles(text(files, dir + 'styles.xml'));
  const ctx = { sst, xfs: st.xfs, fmts: st.fmts, date1904 };
  const sheets = [];
  const list = kids(kid(wbRoot, 'sheets'), 'sheet');
  list.forEach((sh, i) => {
    const rid = attr(sh, 'id');
    const rel = wbRels.get(rid);
    const name = attr(sh, 'name') || `시트${i + 1}`;
    const state = attr(sh, 'state') || 'visible';
    if (!rel || !/\/worksheet$/.test(rel.type)) return; // 차트 시트 등
    const src = text(files, rel.target);
    if (!src) return;
    const data = readSheet(src, ctx);
    // 글상자
    const extras = [];
    const sheetRels = rels(files, rel.target);
    for (const r of sheetRels.values()) if (/\/drawing$/.test(r.type)) extras.push(...drawingTexts(files, r.target));
    sheets.push({ name, hidden: state !== 'visible', ...data, extras });
    if (onProgress) onProgress((i + 1) / list.length);
  });
  if (sheetsOnly) return { sheets, date1904 };
  return sheetsToModel('xlsx', sheets);
}
