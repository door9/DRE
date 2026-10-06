// 한글 HWPX(.hwpx) 읽기 — 압축 파일 속 XML(Contents/section*.xml, header.xml)을 문서 모델로.
// 문단·표·글상자·각주/미주·자동 문단 번호·쪽 나뉨(lineseg 의 쪽 첫 줄 표시)을 읽는다.
import { unzipSync, strFromU8 } from '../../vendor/fflate.mjs';
import { parseXml, kids, kid, attr, descendants, firstDescendant } from './xml.js';
import { noteMark } from './model.js';
import { formatNumber, applyNumberFormat } from './numfmt.js';
import { finishLevels, SOFT_BREAK, ZERO_SPACE } from './hwp.js';
import { resolveSoftBreaks } from './joiner.js';
import { PageTracker } from './pagetrack.js';

export class HwpxError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

function readZip(u8) {
  try {
    return unzipSync(u8, { filter: (f) => /^(Contents\/|META-INF\/|mimetype$)/.test(f.name) && !/\.(png|jpe?g|gif|bmp|wmf|emf|ole|bin)$/i.test(f.name) });
  } catch {
    throw new HwpxError('broken', 'HWPX 파일의 압축을 풀지 못했습니다(손상된 파일일 수 있습니다)');
  }
}

function xmlOf(files, name) {
  const f = files[name];
  if (!f) return null;
  const s = strFromU8(f);
  if (!/^\s*(<\?xml|<)/.test(s.slice(0, 200))) throw new HwpxError('password', '암호가 걸린 HWPX 문서입니다');
  return parseXml(s);
}

// 문단 모양·번호·글머리표
function readHeader(root) {
  const info = { paraPr: new Map(), numberings: new Map(), bullets: new Map() };
  if (!root) return info;
  for (const p of descendants(root, 'paraPr')) {
    const heading = kid(p, 'heading');
    // 여백은 <hp:switch> 속 <hp:default> 쪽을 쓴다(단위가 HWPUNIT 로 같음)
    let margin = null;
    const sw = kid(p, 'switch');
    if (sw) margin = firstDescendant(kid(sw, 'default'), 'margin') || firstDescendant(sw, 'margin');
    if (!margin) margin = kid(p, 'margin');
    const val = (l) => { const e = kid(margin, l); return e ? +attr(e, 'value') || 0 : 0; };
    info.paraPr.set(attr(p, 'id'), {
      headType: heading ? attr(heading, 'type') : 'NONE',
      headId: heading ? attr(heading, 'idRef') : '0',
      headLevel: heading ? +attr(heading, 'level') || 0 : 0,
      left: val('left'),
      indent: val('intent'),
    });
  }
  for (const n of descendants(root, 'numbering')) {
    const levels = [];
    for (const h of kids(n, 'paraHead')) {
      const lv = (+attr(h, 'level') || 1) - 1;
      levels[lv] = { shape: attr(h, 'numFormat') || 'DIGIT', fmt: h.c.filter((x) => typeof x === 'string').join(''), start: +attr(h, 'start') || 1 };
    }
    info.numberings.set(attr(n, 'id'), levels);
  }
  for (const b of descendants(root, 'bullet')) info.bullets.set(attr(b, 'id'), attr(b, 'char') || '•');
  return info;
}

// 섹션 파일 순서(content.hpf 의 spine, 없으면 이름 순)
function sectionNames(files) {
  const names = Object.keys(files).filter((n) => /^Contents\/section\d+\.xml$/i.test(n));
  const hpf = files['Contents/content.hpf'];
  if (hpf) {
    try {
      const root = parseXml(strFromU8(hpf));
      const items = new Map(descendants(root, 'item').map((i) => [attr(i, 'id'), attr(i, 'href')]));
      const order = descendants(root, 'itemref').map((r) => items.get(attr(r, 'idref'))).filter((h) => h && /section\d+\.xml$/i.test(h))
        .map((h) => (h.startsWith('Contents/') ? h : 'Contents/' + h.replace(/^\.?\//, '')));
      const ok = order.filter((n) => files[n]);
      if (ok.length) return ok;
    } catch { /* 이름 순으로 */ }
  }
  return names.sort((a, b) => +a.match(/(\d+)\.xml$/i)[1] - +b.match(/(\d+)\.xml$/i)[1]);
}

export function parseHwpx(bytes, { onProgress } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const files = readZip(u8);
  const manifest = files['META-INF/manifest.xml'] ? strFromU8(files['META-INF/manifest.xml']) : '';
  if (/encryption-data/i.test(manifest)) throw new HwpxError('password', '암호가 걸린 HWPX 문서입니다');
  const info = readHeader(xmlOf(files, 'Contents/header.xml'));
  const secs = sectionNames(files);
  if (!secs.length) throw new HwpxError('broken', 'HWPX 문서에 본문이 없습니다');

  const st = {
    info, pt: new PageTracker(), blocks: [], notes: [], endNotes: [], noteNo: 0,
    counters: new Map(), outlineId: '1', pendingGap: 0, xs: [],
  };
  secs.forEach((name, i) => {
    const root = xmlOf(files, name);
    const sec = kid(root, 'sec') || root;
    for (const p of kids(sec, 'p')) topParagraph(st, p);
    if (onProgress) onProgress((i + 1) / secs.length);
  });
  finishLevels(st.blocks, st.xs);
  const doc = { format: 'hwpx', pages: st.pt.page, pageExact: false, blocks: st.blocks, notes: st.notes.concat(st.endNotes), warnings: [] };
  resolveSoftBreaks(doc);
  return doc;
}

function headingLabel(st, pp) {
  if (!pp || !pp.headType || pp.headType === 'NONE') return '';
  if (pp.headType === 'BULLET') {
    const b = st.info.bullets.get(pp.headId);
    return b && b.trim() ? b + ' ' : '';
  }
  const id = pp.headType === 'OUTLINE' ? st.outlineId : pp.headId;
  const levels = st.info.numberings.get(id);
  const level = pp.headLevel;
  if (!levels || !levels[level]) return '';
  let cnt = st.counters.get(id);
  if (!cnt) { cnt = levels.map((l) => (l ? l.start : 1) - 1); st.counters.set(id, cnt); }
  cnt[level] = (cnt[level] ?? 0) + 1;
  for (let k = level + 1; k < cnt.length; k++) cnt[k] = (levels[k] ? levels[k].start : 1) - 1;
  const label = applyNumberFormat(levels[level].fmt, (k) => formatNumber(Math.max(cnt[k] ?? 1, 1), levels[k] ? levels[k].shape : 'DIGIT'));
  return label ? label + ' ' : '';
}

// 개체 요소(그 안의 글은 따로 블록이 된다)
const OBJECTS = new Set(['tbl', 'pic', 'rect', 'ellipse', 'arc', 'polygon', 'curve', 'connectLine', 'line', 'container', 'ole', 'equation', 'textart', 'chart', 'video', 'compose', 'dutmal', 'formObject', 'btn', 'radioBtn', 'checkBtn', 'comboBox', 'edit', 'listBox', 'scrollBar']);

// 문단 하나를 훑어 글·개체를 순서대로 모은다. pos 는 HWP 글자 위치 셈법(제어 = 8칸)을 흉내 낸다.
function walkParagraph(p) {
  const items = []; // { s } | { obj: el, kind } | { note: el, kind }
  let text = '';
  let w = 0;
  const wmarks = []; // [HWP 위치, 글 위치]
  const add = (s, width) => { wmarks.push([w, text.length]); text += s; w += width; };
  for (const run of kids(p, 'run')) {
    for (const el of run.c) {
      if (typeof el === 'string') continue;
      switch (el.l) {
        case 't':
          for (const c of el.c) {
            if (typeof c === 'string') { for (const ch of c) add(ch, 1); continue; }
            switch (c.l) {
              case 'tab': add('\t', 8); break;
              case 'lineBreak': add(SOFT_BREAK, 1); break;
              case 'hyphen': add('-', 1); break;
              case 'nbSpace': add(' ', 1); break;
              case 'fwSpace': add(ZERO_SPACE, 1); break;
              default: w += 8; // 형광펜·변경 추적 표시 등
            }
          }
          break;
        case 'ctrl':
          for (const c of kids(el)) {
            if (c.l === 'footNote' || c.l === 'endNote') items.push({ at: text.length, w, note: c, kind: c.l });
            w += 8;
          }
          break;
        case 'secPr': case 'colPr':
          if (el.l === 'secPr' && attr(el, 'outlineShapeIDRef')) items.push({ at: text.length, w, outline: attr(el, 'outlineShapeIDRef') });
          w += 8;
          break;
        default:
          if (OBJECTS.has(el.l)) items.push({ at: text.length, w, obj: el });
          w += 8;
      }
    }
  }
  const w2o = (x) => { let o = 0; for (const [ww, oo] of wmarks) { if (ww >= x) return oo; o = oo + 1; } return text.length; };
  return { text, items, w2o };
}

function lineSegs(p) {
  const arr = kid(p, 'linesegarray');
  return arr ? kids(arr, 'lineseg').map((l) => ({ start: +attr(l, 'textpos') || 0, vpos: +attr(l, 'vertpos') || 0, height: +attr(l, 'vertsize') || 0 })) : [];
}

// 구역 설정(용지·단)이 이 문단에 있으면 쪽 세기에 알린다
function sectionSetup(st, p) {
  for (const run of kids(p, 'run')) {
    for (const el of kids(run)) {
      if (el.l === 'secPr') {
        const pp = kid(el, 'pagePr');
        const m = kid(pp, 'margin');
        if (pp && m) {
          const w = +attr(pp, 'width') || 0, h = +attr(pp, 'height') || 0;
          const land = (attr(pp, 'landscape') || '').toUpperCase();
          // HWPX: landscape="WIDELY" 이 세로(보통), "NARROWLY" 가 가로로 눕힌 것
          const paperH = land === 'NARROWLY' ? Math.min(w, h) : Math.max(w, h) === h ? h : h;
          const num = (k) => +attr(m, k) || 0;
          st.pt.setBody(paperH - num('top') - num('bottom') - num('header') - num('footer'));
        }
      } else if (el.l === 'ctrl') {
        const col = kid(el, 'colPr');
        if (col) st.pt.setColumns(+attr(col, 'colCount') || 1);
      }
    }
  }
}

function topParagraph(st, p) {
  const pp = st.info.paraPr.get(attr(p, 'paraPrIDRef'));
  const lines = lineSegs(p);
  if (attr(p, 'pageBreak') === '1') st.pt.forceBreak();
  sectionSetup(st, p);
  const { text, items, w2o } = walkParagraph(p);
  for (const it of items) if (it.outline) st.outlineId = it.outline;

  const cuts = [];
  for (const l of lines) cuts.push([w2o(l.start), st.pt.line(l.vpos, l.height)]);
  if (!cuts.length) cuts.push([0, st.pt.page]);
  const pageAt = (o) => { let pg = cuts[0][1]; for (const [q, g] of cuts) { if (q <= o) pg = g; else break; } return pg; };

  const out = [];
  let segs = [];
  let joins = '';
  const addText = (a, b) => {
    let pos = a;
    while (pos < b) {
      const pg = pageAt(pos);
      let next = b;
      for (const [q] of cuts) if (q > pos && q < next) { next = q; break; }
      const s = text.slice(pos, next);
      if (s) {
        const last = segs[segs.length - 1];
        if (last && last.pg === pg) last.s += s;
        else { if (segs.length) joins += 'G'; segs.push({ s, pg }); }
      }
      pos = next;
    }
  };
  const flush = () => {
    if (segs.some((x) => x.s.trim())) out.push({ t: 'p', segs, joins, lvl: 0, kind: '', gap: 0 });
    segs = []; joins = '';
  };

  let pos = 0;
  for (const it of items) {
    if (it.obj) {
      const pg = pageAt(it.at);
      if (it.obj.l === 'tbl') {
        addText(pos, it.at); pos = it.at; flush();
        out.push(...tableBlocks(st, it.obj, pg));
      } else {
        const inner = objectTexts(st, it.obj).map((s) => s.trim()).filter(Boolean);
        if (inner.length) {
          addText(pos, it.at); pos = it.at; flush();
          for (const s of inner) out.push({ t: 'p', segs: [{ s, pg }], joins: '', lvl: 0, kind: '', gap: 0 });
        }
      }
    } else if (it.note) {
      addText(pos, it.at); pos = it.at;
      st.noteNo++;
      (it.kind === 'footNote' ? st.notes : st.endNotes).push({ id: st.noteNo, s: subListTexts(st, it.note).join('\n') });
      const mark = noteMark(st.noteNo);
      const last = segs[segs.length - 1];
      if (last) last.s += mark; else segs.push({ s: mark, pg: pageAt(it.at) });
    }
  }
  addText(pos, text.length);
  flush();

  const label = headingLabel(st, pp);
  const first = out.find((b) => b.t === 'p');
  if (first) {
    const s0 = first.segs[0].s;
    const lead = s0.match(/^[ \u3000]*/)[0];
    const leadW = [...lead].reduce((a, ch) => a + (ch === '\u3000' ? 1000 : 500), 0);
    first.segs[0].s = label + s0.slice(lead.length);
    if (pp) {
      const x = pp.left + Math.max(0, pp.indent) + leadW;
      st.xs.push(x);
      for (const b of out) if (b.t === 'p') b._x = x;
    }
  }
  if (!out.length) {
    if (!text.trim()) st.pendingGap = 1;
    return;
  }
  for (const b of out) {
    if (st.pendingGap) { b.gap = 1; st.pendingGap = 0; }
    st.blocks.push(b);
  }
}

// 표 칸·글상자·각주 안쪽 문단의 글
function innerParaText(st, p) {
  const pp = st.info.paraPr.get(attr(p, 'paraPrIDRef'));
  const { text, items } = walkParagraph(p);
  let s = headingLabel(st, pp);
  let pos = 0;
  for (const it of items) {
    if (it.obj) {
      s += text.slice(pos, it.at); pos = it.at;
      if (it.obj.l === 'tbl') {
        const rows = tableRows(st, it.obj);
        const flat = rows.map((r) => r.filter(Boolean).map((c) => c.s.replace(/\n/g, ' ')).join(' | ')).filter((x) => x.trim()).join('\n');
        if (flat) s += (s && !s.endsWith('\n') ? '\n' : '') + flat + '\n';
      } else {
        const t = objectTexts(st, it.obj).join('\n');
        if (t.trim()) s += (s && !s.endsWith('\n') ? '\n' : '') + t;
      }
    } else if (it.note) {
      s += text.slice(pos, it.at); pos = it.at;
      st.noteNo++;
      (it.kind === 'footNote' ? st.notes : st.endNotes).push({ id: st.noteNo, s: subListTexts(st, it.note).join('\n') });
      s += noteMark(st.noteNo);
    }
  }
  s += text.slice(pos);
  return s.replace(/\s+$/, '');
}

function subListTexts(st, el) {
  const out = [];
  for (const sl of kids(el, 'subList')) for (const p of kids(sl, 'p')) out.push(innerParaText(st, p));
  return out;
}

// 그림·도형·묶음 개체 속 글(글상자: drawText > subList)
function objectTexts(st, el) {
  const out = [];
  const walk = (e) => {
    for (const c of kids(e)) {
      if (c.l === 'subList') { for (const p of kids(c, 'p')) out.push(innerParaText(st, p)); continue; }
      if (c.l === 'p') continue;
      walk(c);
    }
  };
  walk(el);
  return out;
}

function tableRows(st, tbl) {
  let nRows = +attr(tbl, 'rowCnt') || 0;
  let nCols = +attr(tbl, 'colCnt') || 0;
  const cells = [];
  for (const tr of kids(tbl, 'tr')) {
    for (const tc of kids(tr, 'tc')) {
      const addr = kid(tc, 'cellAddr');
      const span = kid(tc, 'cellSpan');
      const c = {
        col: addr ? +attr(addr, 'colAddr') || 0 : 0,
        row: addr ? +attr(addr, 'rowAddr') || 0 : 0,
        cs: span ? Math.max(1, +attr(span, 'colSpan') || 1) : 1,
        rs: span ? Math.max(1, +attr(span, 'rowSpan') || 1) : 1,
        s: subListTexts(st, tc).join('\n').replace(/\s+$/, ''),
      };
      cells.push(c);
    }
  }
  for (const c of cells) { nRows = Math.max(nRows, c.row + c.rs); nCols = Math.max(nCols, c.col + c.cs); }
  if (nRows > 5000 || nCols > 500) return [];
  const rows = Array.from({ length: nRows }, () => new Array(nCols).fill(null));
  for (const c of cells) if (c.row < nRows && c.col < nCols) rows[c.row][c.col] = { s: c.s, cs: c.cs, rs: c.rs };
  return rows;
}

function tableBlocks(st, tbl, pg) {
  const out = [];
  const cap = kid(tbl, 'caption');
  const capText = cap ? subListTexts(st, cap).join(' ').trim() : '';
  const rows = tableRows(st, tbl);
  const filled = rows.flat().filter((c) => c && c.s.trim());
  if (filled.length <= 1 && rows.length * (rows[0] ? rows[0].length : 0) <= 2) {
    if (filled[0]) for (const line of filled[0].s.split('\n')) if (line.trim()) out.push({ t: 'p', segs: [{ s: line.replace(/^[ \u3000]+/, ''), pg }], joins: '', lvl: 0, kind: '', gap: 0 });
    if (out.length) out[0].gap = 1;
  } else if (rows.length) {
    out.push({ t: 'tbl', rows, pg, gap: 1 });
  }
  if (capText) {
    // 표 제목 자리: side=BOTTOM 이면 표 아래
    const below = (attr(cap, 'side') || '').toUpperCase() === 'BOTTOM';
    const cb = { t: 'p', segs: [{ s: capText, pg }], joins: '', lvl: 0, kind: 'cap', gap: below ? 0 : 1 };
    if (below) out.push(cb); else out.unshift(cb);
  }
  return out;
}
