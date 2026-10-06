// 워드 DOCX 읽기 — word/document.xml 을 문서 모델로.
// 문단·표(가로·세로 합친 칸)·글상자·각주/미주·자동 번호·필드 결과·쪽 나뉨(워드가 남긴 lastRenderedPageBreak)을 읽는다.
import { unzipSync, strFromU8 } from '../../vendor/fflate.mjs';
import { parseXml, kids, kid, attr, path as xpath, descendants } from './xml.js';
import { noteMark } from './model.js';
import { formatNumber, applyNumberFormat } from './numfmt.js';
import { finishLevels, SOFT_BREAK } from './hwp.js';
import { resolveSoftBreaks } from './joiner.js';

export class DocxError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

// 기호 글꼴(Symbol·Wingdings)의 사용자 정의 영역 글자 → 보통 글자
const SYMBOL_MAP = {
  0xf0b7: '•', 0xf0a7: '▪', 0xf0d8: '➢', 0xf0fc: '✓', 0xf076: '❖', 0xf0a8: '◆', 0xf06c: '●', 0xf06e: '■', 0xf0e0: '→',
  0xf0e8: '➔', 0xf0f0: '⇨', 0xf0b2: '◇', 0xf0a1: '○', 0xf09f: '•', 0xf02d: '-', 0xf0fb: '✗', 0xf0d2: '⇒', 0xf071: '❑',
};
function symChar(code) {
  if (SYMBOL_MAP[code]) return SYMBOL_MAP[code];
  if (code >= 0xf020 && code <= 0xf0ff) return SYMBOL_MAP[code] || '•';
  return String.fromCodePoint(code);
}
function cleanBullet(s) {
  return [...(s || '')].map((ch) => { const c = ch.codePointAt(0); return c >= 0xe000 && c <= 0xf8ff ? symChar(c) : ch === 'o' && s.length === 1 ? '◦' : ch; }).join('');
}

function readZip(u8) {
  try {
    return unzipSync(u8, { filter: (f) => /^(word\/[^/]*\.xml|word\/_rels\/|_rels\/|docProps\/app\.xml|\[Content_Types\]\.xml)/.test(f.name) });
  } catch {
    throw new DocxError('broken', 'DOCX 파일의 압축을 풀지 못했습니다(손상되었거나 암호가 걸린 파일일 수 있습니다)');
  }
}

function xmlOf(files, name) {
  const f = files[name];
  return f ? parseXml(strFromU8(f)) : null;
}

function mainPartName(files) {
  const rels = xmlOf(files, '_rels/.rels');
  if (rels) {
    for (const r of descendants(rels, 'Relationship')) {
      if (/officeDocument$/.test(attr(r, 'Type') || '')) {
        const t = (attr(r, 'Target') || '').replace(/^\//, '');
        if (files[t]) return t;
      }
    }
  }
  return files['word/document.xml'] ? 'word/document.xml' : null;
}

const twip = (v) => (v == null || v === '' ? 0 : +v || 0);

function readStyles(root) {
  const styles = new Map();
  if (!root) return styles;
  for (const s of descendants(root, 'style')) {
    if (attr(s, 'type') !== 'paragraph') continue;
    const id = attr(s, 'styleId');
    const ppr = kid(s, 'pPr');
    const numPr = kid(ppr, 'numPr');
    const ind = kid(ppr, 'ind');
    const ol = kid(ppr, 'outlineLvl');
    styles.set(id, {
      name: (attr(kid(s, 'name'), 'val') || '').toLowerCase(),
      basedOn: attr(kid(s, 'basedOn'), 'val'),
      outline: ol ? +attr(ol, 'val') : null,
      numId: numPr ? attr(kid(numPr, 'numId'), 'val') : null,
      ilvl: numPr && kid(numPr, 'ilvl') ? +attr(kid(numPr, 'ilvl'), 'val') : null,
      ind: ind ? { left: twip(attr(ind, 'left') ?? attr(ind, 'start')), hanging: twip(attr(ind, 'hanging')), first: twip(attr(ind, 'firstLine')) } : null,
    });
  }
  return styles;
}

function styleChain(styles, id) {
  const out = [];
  const seen = new Set();
  while (id && styles.has(id) && !seen.has(id) && out.length < 20) { seen.add(id); const s = styles.get(id); out.push(s); id = s.basedOn; }
  return out;
}

function readNumbering(root) {
  const abs = new Map();
  const nums = new Map();
  if (!root) return { abs, nums };
  root = kid(root, 'numbering') || root;
  for (const a of kids(root, 'abstractNum')) {
    const levels = [];
    for (const l of kids(a, 'lvl')) {
      const ind = xpath(l, 'pPr', 'ind');
      levels[+attr(l, 'ilvl') || 0] = {
        start: kid(l, 'start') ? +attr(kid(l, 'start'), 'val') : 1,
        fmt: attr(kid(l, 'numFmt'), 'val') || 'decimal',
        text: attr(kid(l, 'lvlText'), 'val') ?? '',
        lgl: !!kid(l, 'isLgl'),
        ind: ind ? { left: twip(attr(ind, 'left') ?? attr(ind, 'start')), hanging: twip(attr(ind, 'hanging')), first: twip(attr(ind, 'firstLine')) } : null,
      };
    }
    abs.set(attr(a, 'abstractNumId'), { levels, link: attr(kid(a, 'numStyleLink'), 'val') });
  }
  for (const n of kids(root, 'num')) {
    const overrides = new Map();
    for (const o of kids(n, 'lvlOverride')) {
      const so = kid(o, 'startOverride');
      if (so) overrides.set(+attr(o, 'ilvl') || 0, +attr(so, 'val'));
    }
    nums.set(attr(n, 'numId'), { absId: attr(kid(n, 'abstractNumId'), 'val'), overrides });
  }
  return { abs, nums };
}

export function parseDocx(bytes, { onProgress } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0xd0 && u8[1] === 0xcf) throw new DocxError('password', '암호가 걸린 워드 문서입니다');
  const files = readZip(u8);
  const main = mainPartName(files);
  if (!main) throw new DocxError('broken', '워드 문서 본문을 찾지 못했습니다');
  const doc = xmlOf(files, main);
  const body = xpath(doc, 'document', 'body');
  if (!body) throw new DocxError('broken', '워드 문서 본문이 비어 있습니다');

  const st = {
    styles: readStyles(xmlOf(files, 'word/styles.xml')),
    numbering: readNumbering(xmlOf(files, 'word/numbering.xml')),
    counters: new Map(), started: new Set(),
    footnotes: new Map(), endnotes: new Map(),
    notes: [], noteNo: 0,
    page: 1, useRendered: false, xs: [], blocks: [], pendingGap: 0,
  };
  for (const [name, map] of [['word/footnotes.xml', st.footnotes], ['word/endnotes.xml', st.endnotes]]) {
    const r = xmlOf(files, name);
    if (!r) continue;
    for (const fn of descendants(r, name.includes('foot') ? 'footnote' : 'endnote')) {
      const t = attr(fn, 'type');
      if (t && t !== 'normal') continue;
      map.set(attr(fn, 'id'), fn);
    }
  }
  st.useRendered = descendants(body, 'lastRenderedPageBreak').length > 0;

  const children = kids(body);
  children.forEach((el, i) => {
    topBlock(st, el);
    if (onProgress && i % 200 === 0) onProgress(i / children.length);
  });
  finishLevels(st.blocks, st.xs);

  // 워드가 저장할 때 적어 둔 쪽 수
  let pages = st.page;
  const app = xmlOf(files, 'docProps/app.xml');
  const p = app ? descendants(app, 'Pages')[0] : null;
  const appPages = p ? +p.c.join('') : 0;
  const exactish = st.useRendered && appPages && Math.abs(appPages - pages) <= 0;
  if (appPages && !st.useRendered) pages = Math.max(pages, appPages);
  const out = { format: 'docx', pages, pageExact: false, pageHint: exactish, blocks: st.blocks, notes: st.notes, warnings: [] };
  resolveSoftBreaks(out);
  return out;
}

function paraProps(st, p) {
  const ppr = kid(p, 'pPr');
  const styleId = attr(kid(ppr, 'pStyle'), 'val') || 'Normal';
  const chain = styleChain(st.styles, styleId);
  let numId = null, ilvl = null, ind = null, outline = null;
  const numPr = kid(ppr, 'numPr');
  if (numPr) { numId = attr(kid(numPr, 'numId'), 'val'); ilvl = kid(numPr, 'ilvl') ? +attr(kid(numPr, 'ilvl'), 'val') : 0; }
  for (const s of chain) {
    if (numId == null && s.numId != null) { numId = s.numId; ilvl = s.ilvl ?? 0; }
    if (!ind && s.ind) ind = s.ind;
    if (outline == null && s.outline != null) outline = s.outline;
  }
  const pind = kid(ppr, 'ind');
  if (pind) ind = { left: twip(attr(pind, 'left') ?? attr(pind, 'start')), hanging: twip(attr(pind, 'hanging')), first: twip(attr(pind, 'firstLine')) };
  const ol = kid(ppr, 'outlineLvl');
  if (ol) outline = +attr(ol, 'val');
  const name = chain[0] ? chain[0].name : '';
  const heading = (outline != null && outline < 9) || /^(heading|제목)\s*\d/.test(name) || name === 'title';
  return {
    numId: numId && numId !== '0' ? numId : null, ilvl: ilvl ?? 0, ind, heading,
    pageBreakBefore: !!kid(ppr, 'pageBreakBefore') && attr(kid(ppr, 'pageBreakBefore'), 'val') !== '0',
    sectBreak: kid(ppr, 'sectPr') ? (attr(xpath(ppr, 'sectPr', 'type'), 'val') || 'nextPage') : null,
  };
}

function numberLabel(st, pr) {
  if (!pr.numId) return { label: '', ind: null };
  const num = st.numbering.nums.get(pr.numId);
  if (!num) return { label: '', ind: null };
  let a = st.numbering.abs.get(num.absId);
  // 번호 스타일에 연결된 목록이면 그 정의를 따른다
  if (a && a.link && !a.levels.length) {
    const s = st.styles.get(a.link);
    const n2 = s && s.numId ? st.numbering.nums.get(s.numId) : null;
    if (n2) a = st.numbering.abs.get(n2.absId) || a;
  }
  if (!a) return { label: '', ind: null };
  const lv = a.levels[pr.ilvl];
  if (!lv) return { label: '', ind: null };
  const key = num.absId;
  let cnt = st.counters.get(key);
  if (!cnt) { cnt = a.levels.map((l) => (l ? l.start - 1 : 0)); st.counters.set(key, cnt); }
  if (!st.started.has(pr.numId)) {
    st.started.add(pr.numId);
    for (const [k, v] of num.overrides) cnt[k] = v - 1;
  }
  cnt[pr.ilvl] = (cnt[pr.ilvl] ?? 0) + 1;
  for (let k = pr.ilvl + 1; k < cnt.length; k++) cnt[k] = a.levels[k] ? a.levels[k].start - 1 : 0;
  let label;
  if (lv.fmt === 'bullet') label = cleanBullet(lv.text);
  else if (lv.fmt === 'none') label = applyNumberFormat(lv.text, () => '');
  else label = applyNumberFormat(lv.text, (k) => formatNumber(Math.max(cnt[k] ?? 1, 1), lv.lgl ? 'decimal' : (a.levels[k] ? a.levels[k].fmt : 'decimal')));
  return { label: label ? label + (/\s$/.test(label) ? '' : ' ') : '', ind: lv.ind };
}

function topBlock(st, el) {
  switch (el.l) {
    case 'p': return topParagraph(st, el);
    case 'tbl': return pushBlocks(st, tableBlocks(st, el));
    case 'sdt': { const c = kid(el, 'sdtContent'); if (c) for (const k of kids(c)) topBlock(st, k); return; }
    case 'customXml': case 'ins': case 'moveTo': case 'smartTag': for (const k of kids(el)) topBlock(st, k); return;
    default: return; // sectPr, bookmark 등
  }
}

function pushBlocks(st, blocks) {
  for (const b of blocks) {
    if (st.pendingGap) { b.gap = Math.max(b.gap || 0, 1); st.pendingGap = 0; }
    st.blocks.push(b);
  }
}

// 문단 안을 훑으며 글을 모은다. 쪽 나뉨은 { pb: true } 표시로, 글상자 글은 extra 로 모은다.
function collectRuns(st, el, ctx) {
  for (const c of el.c) {
    if (typeof c === 'string') continue;
    switch (c.l) {
      case 'r': runContent(st, c, ctx); break;
      case 'hyperlink': case 'smartTag': case 'customXml': case 'fldSimple': case 'ins': case 'moveTo': case 'dir': case 'bdo':
        collectRuns(st, c, ctx); break;
      case 'sdt': { const sc = kid(c, 'sdtContent'); if (sc) collectRuns(st, sc, ctx); break; }
      case 'oMathPara': case 'oMath':
        if (!ctx.skip()) ctx.add(descendants(c, 't').map((t) => t.c.join('')).join(''));
        break;
      case 'AlternateContent': {
        const ch = kid(c, 'Choice') || kid(c, 'Fallback');
        if (ch) collectRuns(st, ch, ctx);
        break;
      }
      default: break; // pPr, bookmark, proofErr, del, moveFrom, commentRange…
    }
  }
}

function runContent(st, r, ctx) {
  for (const c of r.c) {
    if (typeof c === 'string') continue;
    switch (c.l) {
      case 't': if (!ctx.skip()) ctx.add(c.c.join('')); break;
      case 'tab': case 'ptab': if (!ctx.skip()) ctx.add('\t'); break;
      case 'br': {
        const type = attr(c, 'type');
        if (type === 'page') { if (!st.useRendered) ctx.pageBreak(); else ctx.add('\n'); }
        else if (type !== 'column' && !ctx.skip()) ctx.add(SOFT_BREAK);
        break;
      }
      case 'cr': if (!ctx.skip()) ctx.add(SOFT_BREAK); break;
      case 'noBreakHyphen': if (!ctx.skip()) ctx.add('-'); break;
      case 'sym': if (!ctx.skip()) ctx.add(symChar(parseInt(attr(c, 'char') || '2022', 16))); break;
      case 'lastRenderedPageBreak': if (st.useRendered) ctx.pageBreak(); break;
      case 'fldChar': {
        const t = attr(c, 'fldCharType');
        if (t === 'begin') ctx.fields.push('code');
        else if (t === 'separate') { if (ctx.fields.length) ctx.fields[ctx.fields.length - 1] = 'result'; }
        else if (t === 'end') ctx.fields.pop();
        break;
      }
      case 'footnoteReference': case 'endnoteReference': {
        const map = c.l === 'footnoteReference' ? st.footnotes : st.endnotes;
        const fn = map.get(attr(c, 'id'));
        st.noteNo++;
        const id = st.noteNo;
        st.notes.push({ id, s: fn ? kids(fn, 'p').map((p) => innerParaText(st, p)).join('\n') : '' });
        if (!ctx.skip()) ctx.add(noteMark(id));
        break;
      }
      case 'drawing': case 'pict': case 'object': {
        for (const tb of descendants(c, 'txbxContent')) {
          const t = kids(tb).map((k) => (k.l === 'p' ? innerParaText(st, k) : k.l === 'tbl' ? flatTable(st, k) : '')).join('\n').trim();
          if (t) ctx.extra.push(t);
        }
        break;
      }
      case 'AlternateContent': {
        const ch = kid(c, 'Choice') || kid(c, 'Fallback');
        if (ch) runContent(st, ch, ctx);
        break;
      }
      default: break; // rPr, instrText, delText, commentReference…
    }
  }
}

function newCtx(st) {
  const ctx = {
    segs: [], joins: '', extra: [], fields: [], cur: '', breaks: 0,
    skip: () => ctx.fields.length > 0 && ctx.fields[ctx.fields.length - 1] === 'code',
    add: (s) => { ctx.cur += s; },
    pageBreak: () => {
      if (ctx.cur || ctx.segs.length) { ctx.segs.push({ s: ctx.cur, pg: st.page }); ctx.cur = ''; }
      st.page++;
      ctx.breaks++;
    },
    finish: () => {
      if (ctx.cur || !ctx.segs.length) ctx.segs.push({ s: ctx.cur, pg: st.page });
      ctx.segs = ctx.segs.filter((x, i) => x.s || i === 0);
      ctx.joins = 'G'.repeat(Math.max(0, ctx.segs.length - 1));
    },
  };
  return ctx;
}

function indentX(ind, leadSpaces) {
  if (!ind) return leadSpaces * 110 * 5;
  const first = ind.first ? ind.left + ind.first : ind.left - ind.hanging;
  return (Math.max(0, first) + leadSpaces * 110) * 5; // twip → HWPUNIT(5배)로 맞춰 한글과 같은 기준으로 단계 계산
}

function topParagraph(st, p) {
  const pr = paraProps(st, p);
  if (pr.pageBreakBefore && !st.useRendered && st.blocks.length) st.page++;
  const { label, ind: numInd } = numberLabel(st, pr);
  const ctx = newCtx(st);
  collectRuns(st, p, ctx);
  ctx.finish();
  const text = ctx.segs.map((x) => x.s).join('');
  const out = [];
  if (text.replace(/[\s\ue000-\ue001]/g, '') || label.trim()) {
    const s0 = ctx.segs[0].s;
    const lead = s0.match(/^[ \u3000]*/)[0];
    ctx.segs[0].s = label + s0.slice(lead.length);
    const x = indentX(pr.ind || numInd, lead.length);
    st.xs.push(x);
    out.push({ t: 'p', segs: ctx.segs, joins: ctx.joins, lvl: 0, kind: pr.heading ? 'h' : label ? 'li' : '', gap: pr.heading && st.blocks.length ? 1 : 0, _x: x });
  } else if (!ctx.extra.length) {
    st.pendingGap = 1;
  }
  for (const t of ctx.extra) for (const line of t.split('\n')) if (line.trim()) out.push({ t: 'p', segs: [{ s: line.trim(), pg: st.page }], joins: '', lvl: 0, kind: '', gap: 0 });
  pushBlocks(st, out);
  if (pr.sectBreak && pr.sectBreak !== 'continuous' && !st.useRendered) st.page++;
}

// 표 칸·각주·글상자 안 문단의 글(번호 포함)
function innerParaText(st, p) {
  const pr = paraProps(st, p);
  const { label } = numberLabel(st, pr);
  const ctx = newCtx(st);
  ctx.pageBreak = () => {}; // 안쪽에서는 쪽을 세지 않는다(표 칸은 아래에서 따로)
  collectRuns(st, p, ctx);
  ctx.finish();
  const s = label + ctx.segs.map((x) => x.s).join('');
  return (ctx.extra.length ? s + '\n' + ctx.extra.join('\n') : s).replace(/\s+$/, '');
}

function cellText(st, tc) {
  const parts = [];
  for (const k of kids(tc)) {
    if (k.l === 'p') parts.push(innerParaText(st, k));
    else if (k.l === 'tbl') parts.push(flatTable(st, k));
    else if (k.l === 'sdt') { const c = kid(k, 'sdtContent'); if (c) for (const x of kids(c)) if (x.l === 'p') parts.push(innerParaText(st, x)); }
  }
  // 칸 안의 쪽 나뉨 표시는 셈에 넣는다(표가 쪽을 넘어가는 경우)
  if (st.useRendered) st.page += descendants(tc, 'lastRenderedPageBreak').length;
  return parts.join('\n').replace(/\s+$/, '');
}

function flatTable(st, tbl) {
  return tableRows(st, tbl).map((r) => r.filter(Boolean).map((c) => c.s.replace(/\n/g, ' ')).join(' | ')).filter((x) => x.trim()).join('\n');
}

function tableRows(st, tbl) {
  const grid = kids(kid(tbl, 'tblGrid'), 'gridCol').length;
  const rows = [];
  const origin = []; // 세로 합침: 열 → 위쪽 시작 칸
  for (const tr of kids(tbl, 'tr')) {
    const trPr = kid(tr, 'trPr');
    let col = trPr && kid(trPr, 'gridBefore') ? +attr(kid(trPr, 'gridBefore'), 'val') || 0 : 0;
    const row = [];
    const cells = [];
    for (const k of kids(tr)) {
      if (k.l === 'tc') cells.push(k);
      else if (k.l === 'sdt' || k.l === 'customXml') for (const x of descendants(k, 'tc')) cells.push(x);
    }
    for (const tc of cells) {
      const tcPr = kid(tc, 'tcPr');
      const span = tcPr && kid(tcPr, 'gridSpan') ? Math.max(1, +attr(kid(tcPr, 'gridSpan'), 'val') || 1) : 1;
      const vm = tcPr ? kid(tcPr, 'vMerge') : null;
      const vmVal = vm ? attr(vm, 'val') || 'continue' : null;
      const s = cellText(st, tc);
      if (vmVal === 'continue' && origin[col]) {
        origin[col].rs = (origin[col].rs || 1) + 1;
        if (s.trim()) origin[col].s += (origin[col].s ? '\n' : '') + s;
        row[col] = null;
      } else {
        const cell = { s, cs: span, rs: 1 };
        row[col] = cell;
        for (let k = 0; k < span; k++) origin[col + k] = cell;
      }
      for (let k = 1; k < span; k++) row[col + k] = null;
      col += span;
    }
    rows.push(row);
  }
  const ncol = Math.max(grid, ...rows.map((r) => r.length));
  for (const r of rows) { for (let i = 0; i < ncol; i++) if (r[i] === undefined) r[i] = null; r.length = ncol; }
  return rows;
}

function tableBlocks(st, tbl) {
  const pg = st.page;
  const rows = tableRows(st, tbl);
  if (!rows.length) return [];
  const filled = rows.flat().filter((c) => c && c.s.trim());
  if (filled.length <= 1 && rows.length * rows[0].length <= 2) {
    const out = [];
    if (filled[0]) for (const line of filled[0].s.split('\n')) if (line.trim()) out.push({ t: 'p', segs: [{ s: line.trim(), pg }], joins: '', lvl: 0, kind: '', gap: 0 });
    if (out.length) out[0].gap = 1;
    return out;
  }
  return [{ t: 'tbl', rows, pg, gap: 1 }];
}
