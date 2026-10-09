// 오픈문서(ODF) 읽기 — ODT(글)·ODS(표)·ODP(발표)를 content.xml 에서 바로 문서 모델로.
// ODT: 문단·제목·목록 번호·표(합친 칸)·각주·글상자·쪽 나뉨 표시, ODS: 시트마다 셀에 적힌 화면 글(숨긴 시트·행·열 뺌),
// ODP: 슬라이드마다 도형 글·표·글머리(숨긴 슬라이드 뺌). 형식은 확장자가 아니라 본문 종류로 가린다.
import { unzipSync, strFromU8 } from '../../vendor/fflate.mjs';
import { parseXml, kids, kid, attr, descendants } from './xml.js';
import { noteMark } from './model.js';
import { finishLevels, SOFT_BREAK } from './hwp.js';
import { resolveSoftBreaks } from './joiner.js';
import { formatNumber } from './numfmt.js';
import { formatGeneral } from './xlfmt.js';
import { sheetsToModel } from './sheet.js';
import { slidesToModel } from './slides.js';
import { fixSymbolText, isSymbolFont } from './symbols.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const KEEP_SP = '\ue020', KEEP_TAB = '\ue021'; // 명시한 빈칸·탭(공백 줄이기에서 지킨다)

function readZip(u8) {
  try {
    return unzipSync(u8, { filter: (f) => /^(mimetype|content\.xml|styles\.xml|meta\.xml|META-INF\/manifest\.xml)$/.test(f.name) });
  } catch {
    throw fail('broken', '문서의 압축을 풀지 못했습니다(손상된 파일일 수 있습니다)');
  }
}

// 길이 → pt
function pt(v) {
  const m = /^(-?[\d.]+)\s*(cm|mm|in|inch|pt|pc|px)?$/.exec(String(v || '').trim());
  if (!m) return null;
  const n = +m[1];
  switch (m[2]) {
    case 'cm': return n * 72 / 2.54;
    case 'mm': return n * 72 / 25.4;
    case 'in': case 'inch': return n * 72;
    case 'pc': return n * 12;
    case 'px': return n * 0.75;
    default: return n;
  }
}

// ─── 꼴(스타일) 모음 ───
function collectStyles(...roots) {
  const st = { para: new Map(), lists: new Map(), table: new Map(), drawPage: new Map(), graphic: new Map(), outline: null, textFont: new Map() };
  for (const root of roots) {
    if (!root) continue;
    for (const holder of [...descendants(root, 'styles'), ...descendants(root, 'automatic-styles')]) {
      for (const s of kids(holder)) {
        const name = attr(s, 'name');
        if (s.l === 'style') {
          const fam = attr(s, 'family');
          if (fam === 'paragraph') st.para.set(name, s);
          else if (fam === 'table') st.table.set(name, s);
          else if (fam === 'drawing-page') st.drawPage.set(name, s);
          else if (fam === 'presentation' || fam === 'graphic') st.graphic.set(name, s);
          else if (fam === 'text') {
            // 글자 꼴의 글꼴(기호 글꼴이면 그 글자들을 보통 글자로 바꾸는 데 쓴다)
            const tp = kid(s, 'text-properties');
            const f = tp ? attr(tp, 'font-name') || attr(tp, 'font-family') || '' : '';
            if (isSymbolFont(f)) st.textFont.set(name, f);
          }
        } else if (s.l === 'list-style') st.lists.set(name, s);
        else if (s.l === 'outline-style') st.outline = s;
      }
    }
  }
  return st;
}

// 문단 꼴의 들여쓰기(왼쪽 여백 + 첫 줄)와 제목 단계 — 부모 꼴을 따라 올라간다
function paraStyleInfo(st, name) {
  let left = null, indent = null, outline = null, list = null, display = '';
  const seen = new Set();
  while (name && st.para.has(name) && !seen.has(name) && seen.size < 20) {
    seen.add(name);
    const s = st.para.get(name);
    if (!display) display = (attr(s, 'display-name') || name || '').toLowerCase();
    const pp = kid(s, 'paragraph-properties');
    if (pp) {
      if (left == null && attr(pp, 'margin-left') != null) left = pt(attr(pp, 'margin-left'));
      if (indent == null && attr(pp, 'text-indent') != null) indent = pt(attr(pp, 'text-indent'));
    }
    if (outline == null && attr(s, 'default-outline-level')) outline = +attr(s, 'default-outline-level');
    if (list == null && attr(s, 'list-style-name')) list = attr(s, 'list-style-name');
    name = attr(s, 'parent-style-name');
  }
  return { left: left || 0, indent: indent || 0, outline, list, display };
}

// 목록 꼴 한 단계: { bullet } 또는 { fmt, prefix, suffix, start, display, x }
function listLevel(st, listStyleName, depth) {
  const ls = listStyleName ? st.lists.get(listStyleName) : null;
  if (!ls) return null;
  let lv = null;
  for (const k of kids(ls)) if (+attr(k, 'level') === depth + 1) lv = k;
  if (!lv) return null;
  const props = kid(lv, 'list-level-properties');
  const align = props ? kid(props, 'list-level-label-alignment') : null;
  let x = null;
  if (align && attr(align, 'margin-left') != null) x = (pt(attr(align, 'margin-left')) || 0) + (pt(attr(align, 'text-indent')) || 0);
  else if (props && attr(props, 'space-before') != null) x = pt(attr(props, 'space-before'));
  if (lv.l === 'list-level-style-bullet') return { bullet: attr(lv, 'bullet-char') || '•', x };
  if (lv.l === 'list-level-style-number') {
    const fmt = attr(lv, 'num-format');
    return { fmt: fmt == null ? '' : fmt, prefix: attr(lv, 'num-prefix') || '', suffix: attr(lv, 'num-suffix') || '', start: +(attr(lv, 'start-value') || 1), display: +(attr(lv, 'display-levels') || 1), x };
  }
  return { none: true, x };
}

// 번호 모양(ODF num-format) → 글
function odfNumber(n, fmt) {
  // 한국어·한자 번호 모양은 '가, 나, 다, ...' 처럼 보기 글로 적힌다
  if (/^가/.test(fmt)) return formatNumber(n, 'ganada');
  if (/^ㄱ/.test(fmt)) return formatNumber(n, 'chosung');
  if (/^일/.test(fmt)) return formatNumber(n, 'koreanDigital');
  if (/^①/.test(fmt)) return formatNumber(n, 'decimalEnclosedCircle');
  if (/^一/.test(fmt)) return formatNumber(n, 'ideographTraditional');
  if (/^㉠/.test(fmt)) return formatNumber(n, 'CIRCLED_HANGUL_JAMO');
  if (/^㉮/.test(fmt)) return formatNumber(n, 'CIRCLED_HANGUL_SYLLABLE');
  switch (fmt) {
    case '1': return String(n);
    case 'a': return formatNumber(n, 'lowerLetter');
    case 'A': return formatNumber(n, 'upperLetter');
    case 'i': return formatNumber(n, 'lowerRoman');
    case 'I': return formatNumber(n, 'upperRoman');
    case '가': return formatNumber(n, 'ganada');
    case 'ㄱ': return formatNumber(n, 'chosung');
    case '①': return formatNumber(n, 'decimalEnclosedCircle');
    case '일': return formatNumber(n, 'koreanDigital');
    case '一': return formatNumber(n, 'ideographTraditional');
    case '': return '';
    default: return String(n);
  }
}

function numberLabel(lv, counters, depth, levels) {
  if (!lv || lv.none) return '';
  if (lv.bullet != null) return lv.bullet;
  if (!lv.fmt) return (lv.prefix + lv.suffix).trim();
  const parts = [];
  for (let d = Math.max(0, depth - lv.display + 1); d <= depth; d++) {
    const L = levels[d];
    parts.push(odfNumber(counters[d] ?? 1, d === depth ? lv.fmt : (L && L.fmt) || '1'));
  }
  return lv.prefix + parts.join('.') + lv.suffix;
}

// ─── 문단 안 글 ───
// ctx: { cur, segs, extra, notes 쪽, pageBreak() }
function inline(st, el, ctx, font = '') {
  for (const c of el.c) {
    if (typeof c === 'string') { ctx.cur += fixSymbolText(c, font); continue; }
    switch (c.l) {
      case 's': ctx.cur += KEEP_SP.repeat(Math.min(1000, Math.max(1, +(attr(c, 'c') || 1)))); break;
      case 'tab': ctx.cur += KEEP_TAB; break;
      case 'line-break': ctx.cur += SOFT_BREAK; break;
      case 'soft-page-break': ctx.pageBreak(); break;
      case 'note': {
        st.noteNo++;
        const id = st.noteNo;
        const body = kid(c, 'note-body');
        st.notes.push({ id, s: body ? blockTexts(st, body).join('\n') : '' });
        ctx.cur += noteMark(id);
        break;
      }
      case 'note-citation': case 'annotation': case 'annotation-end': case 'change': case 'bookmark': case 'bookmark-start': case 'bookmark-end':
      case 'reference-mark': case 'reference-mark-start': case 'reference-mark-end': case 'change-start': case 'change-end':
      case 'alphabetical-index-mark': case 'alphabetical-index-mark-start': case 'alphabetical-index-mark-end':
      case 'toc-mark': case 'toc-mark-start': case 'toc-mark-end': case 'user-index-mark': case 'user-index-mark-start': case 'user-index-mark-end':
      case 'ruby-text': case 'event-listeners':
        break;
      case 'hidden-text': case 'hidden-paragraph':
        if (attr(c, 'is-hidden') !== 'true') inline(st, c, ctx, font);
        break;
      case 'frame': case 'custom-shape': case 'rect': case 'ellipse': case 'polygon': case 'polyline': case 'path': case 'g': case 'caption': case 'regular-polygon': case 'text-box': {
        // 글상자: 본문 문단이면 상자째 넘겨 표·문단 그대로 읽게 하고(ctx.boxes), 칸·각주 안이면 글 줄로
        for (const box of textBoxesOf(c)) {
          if (ctx.boxes) ctx.boxes.push(box);
          else for (const t of blockTexts(st, box)) if (t.trim()) ctx.extra.push(t);
        }
        break;
      }
      case 'image': case 'object': case 'object-ole': case 'plugin': case 'applet': case 'title': case 'desc':
        break;
      default: inline(st, c, ctx, (c.l === 'span' && st.textFont.get(attr(c, 'style-name'))) || font); // span, a, meta, ruby, ruby-base, 필드(쪽 번호·날짜·순번…)는 화면 글을 그대로
    }
  }
}

// 도형이 담은 글 상자들 — 바로 아래 것만(상자 속 표 칸 안의 상자는 그 표를 읽을 때 읽는다)
function textBoxesOf(el) {
  if (el.l === 'text-box') return [el];
  if (el.l === 'frame') return kids(el, 'text-box');
  if (el.l === 'g') return kids(el).flatMap(textBoxesOf);
  // 그린 도형(사각형·자유 도형 등)은 글 문단을 직접 품는다
  return kids(el).some((k) => k.l === 'p' || k.l === 'h' || k.l === 'list') ? [el] : [];
}

// 공백 줄이기(ODF 규칙: 이어진 공백은 한 칸, 문단 앞뒤 공백은 버림) 뒤 명시한 빈칸·탭 되살리기
function tidy(s) {
  return s.replace(/‑/g, '-').replace(/\u00ad/g, '').replace(/[ \t\r\n]+/g, ' ').replace(/^ /, '').replace(/ $/, '').replace(/\ue020/g, ' ').replace(/\ue021/g, '\t');
}

function newCtx(st, countPages) {
  const ctx = {
    cur: '', segs: [], extra: [],
    pageBreak: () => {
      if (!countPages) return;
      if (ctx.cur || ctx.segs.length) { ctx.segs.push({ s: ctx.cur, pg: st.page }); ctx.cur = ''; }
      st.page++;
    },
    finish: () => {
      if (ctx.cur || !ctx.segs.length) ctx.segs.push({ s: ctx.cur, pg: st.page });
      ctx.segs = ctx.segs.map((x, i, a) => ({ s: i === 0 ? tidy(x.s) : tidy(x.s), pg: x.pg })).filter((x, i) => x.s || i === 0);
    },
  };
  return ctx;
}

// 문단 하나의 글(번호·글상자 포함, 쪽은 세지 않음) — 표 칸·각주·글상자 안에서 쓴다
function paraTextOf(st, p, label = '') {
  const ctx = newCtx(st, false);
  inline(st, p, ctx);
  ctx.finish();
  const s = label + ctx.segs.map((x) => x.s).join('');
  return ctx.extra.length ? s + '\n' + ctx.extra.join('\n') : s;
}

// 상자 안 문단·목록·표를 글 줄들로
function blockTexts(st, el, out = [], depth = 0, inherited = null) {
  for (const k of kids(el)) {
    if (k.l === 'p' || k.l === 'h') out.push(paraTextOf(st, k, numberOfHeading(k)));
    else if (k.l === 'list') listTexts(st, k, out, depth, inherited);
    else if (k.l === 'table') out.push(flatTable(st, k));
    else if (k.l === 'section' || k.l === 'index-body') blockTexts(st, k, out, depth, inherited);
    else if (/^(table-of-content|alphabetical-index|illustration-index|table-index|object-index|user-index|bibliography)$/.test(k.l)) { const b = kid(k, 'index-body'); if (b) blockTexts(st, b, out); }
  }
  return out;
}

function numberOfHeading(h) {
  const n = h.l === 'h' ? kid(h, 'number') : null;
  if (!n) return '';
  const t = n.c.filter((x) => typeof x === 'string').join('').trim();
  return t ? t + ' ' : '';
}

function listTexts(st, list, out, depth, inherited) {
  const name = attr(list, 'style-name') || inherited;
  const counters = [];
  for (const item of kids(list)) {
    if (item.l !== 'list-item' && item.l !== 'list-header') continue;
    const lv = listLevel(st, name, depth);
    let label = '';
    if (item.l === 'list-item') {
      const sv = attr(item, 'start-value');
      counters[depth] = sv != null ? +sv : (counters[depth] ?? ((lv && lv.start) || 1) - 1) + 1;
      label = numberLabel(lv, counters, depth, []);
    }
    let first = true;
    for (const k of kids(item)) {
      if (k.l === 'p' || k.l === 'h') { out.push(paraTextOf(st, k, first && label ? label + ' ' : '')); first = false; }
      else if (k.l === 'list') listTexts(st, k, out, depth + 1, name);
    }
  }
}

function flatTable(st, tbl) {
  return tableRows(st, tbl).map((r) => r.filter((c) => c && c.s.trim()).map((c) => c.s.replace(/\n/g, ' ')).join(' | ')).filter((x) => x.trim()).join('\n');
}

// 표의 행 요소들(머리 행·행 묶음 안까지)
function rowsOf(tbl) {
  const out = [];
  const gather = (el) => {
    for (const k of kids(el)) {
      if (k.l === 'table-row') out.push(k);
      else if (k.l === 'table-header-rows' || k.l === 'table-rows' || k.l === 'table-row-group') gather(k);
    }
  };
  gather(tbl);
  return out;
}

// 칸 요소들(덮인 칸 뺌)
function cellsOf(tbl) {
  return rowsOf(tbl).flatMap((tr) => kids(tr).filter((c) => c.l === 'table-cell'));
}

// 열이 하나뿐인 표인가(모든 행이 칸 하나, 되풀이·합침 없음)
function oneColumn(tbl) {
  const rows = rowsOf(tbl);
  if (!rows.length) return false;
  return rows.every((tr) => {
    const cells = kids(tr).filter((c) => c.l === 'table-cell' || c.l === 'covered-table-cell');
    return cells.length === 1 && cells[0].l === 'table-cell' && +(attr(cells[0], 'number-columns-repeated') || 1) === 1;
  });
}

// 표 → 행들(합친 칸 cs/rs, 덮인 칸 null). 되풀이(repeated)는 빈 것이면 펼치지 않는다
function tableRows(st, tbl) {
  const rows = [];
  for (const tr of rowsOf(tbl)) {
    const rep = Math.max(1, +(attr(tr, 'number-rows-repeated') || 1));
    const row = [];
    for (const c of kids(tr)) {
      if (c.l !== 'table-cell' && c.l !== 'covered-table-cell') continue;
      const crep = Math.max(1, +(attr(c, 'number-columns-repeated') || 1));
      if (c.l === 'covered-table-cell') { for (let j = 0; j < Math.min(crep, 1024); j++) row.push(null); continue; }
      const s = blockTexts(st, c).join('\n').replace(/\s+$/, '');
      const cs = Math.max(1, +(attr(c, 'number-columns-spanned') || 1));
      const rs = Math.max(1, +(attr(c, 'number-rows-spanned') || 1));
      if (!s && crep > 1) { for (let j = 0; j < Math.min(crep, 1024); j++) row.push({ s: '', cs: 1, rs: 1 }); continue; }
      for (let j = 0; j < Math.min(crep, 1024); j++) row.push({ s, cs, rs });
      if (row.length > 4096) break;
    }
    const empty = !row.some((c) => c && c.s.trim());
    for (let k = 0; k < (empty ? 1 : Math.min(rep, 1000)); k++) rows.push(k ? row.map((c) => (c ? { ...c } : c)) : row);
  }
  // 뒤쪽 빈 칸·빈 행 정리
  while (rows.length && !rows[rows.length - 1].some((c) => c && c.s.trim())) rows.pop();
  let n = 0;
  for (const r of rows) { let k = r.length; while (k > 0 && !(r[k - 1] && r[k - 1].s.trim()) ) k--; n = Math.max(n, k); }
  for (const r of rows) { r.length = Math.min(r.length, Math.max(n, 1)); while (r.length < n) r.push(null); }
  // 합친 칸이 덮는 자리는 null 로(ODF 는 덮인 칸을 따로 적지만 되풀이 때문에 어긋날 수 있다)
  rows.forEach((r, i) => r.forEach((c, j) => {
    if (!c || (c.cs <= 1 && c.rs <= 1)) return;
    for (let a = i; a < Math.min(rows.length, i + c.rs); a++) for (let b = j; b < Math.min(n, j + c.cs); b++) if (a !== i || b !== j) rows[a][b] = null;
  }));
  return rows;
}

// ─── ODT ───
function parseOdt(st, office) {
  const body = kid(office, 'text');
  const pushBlock = (b) => {
    if (st.pendingGap) { b.gap = Math.max(b.gap || 0, 1); st.pendingGap = 0; }
    st.blocks.push(b);
  };
  const paragraph = (p, { label = '', listX = null, kind = '' } = {}) => {
    const info = paraStyleInfo(st, attr(p, 'style-name'));
    const heading = p.l === 'h' || (info.outline != null && info.outline > 0) || /^(heading|제목)/.test(info.display);
    const hl = numberOfHeading(p);
    const ctx = newCtx(st, true);
    ctx.boxes = [];
    inline(st, p, ctx);
    ctx.finish();
    const text = ctx.segs.map((x) => x.s).join('');
    const lab = label || hl;
    if (text.replace(/[\s\ue000-\ue001]/g, '') || lab.trim()) {
      ctx.segs[0].s = (lab && !hl ? lab + ' ' : hl) + ctx.segs[0].s;
      const x = (listX != null ? listX : info.left + info.indent) * 20 * 5; // pt → HWPUNIT 기준(워드와 같은 셈)
      st.xs.push(x);
      pushBlock({ t: 'p', segs: ctx.segs, joins: 'G'.repeat(ctx.segs.length - 1), lvl: 0, kind: heading ? 'h' : kind || (lab ? 'li' : ''), gap: heading && st.blocks.length ? 1 : 0, _x: x });
    } else if (!ctx.boxes.length) st.pendingGap = 1;
    // 문단에 딸린 글상자: 본문처럼 읽는다(표는 표로)
    for (const box of ctx.boxes) walk(box);
  };
  const list = (el, depth, inherited, continued) => {
    const name = attr(el, 'style-name') || inherited;
    const key = name || '';
    let counters = continued || (attr(el, 'continue-numbering') === 'true' || attr(el, 'continue-list') ? st.listCounters.get(key) : null) || [];
    if (depth === 0) st.listCounters.set(key, counters);
    const levels = [];
    for (let d = 0; d <= depth; d++) levels[d] = listLevel(st, name, d);
    for (const item of kids(el)) {
      if (item.l !== 'list-item' && item.l !== 'list-header') { if (item.l === 'soft-page-break') st.page++; continue; }
      const lv = levels[depth];
      let label = '';
      if (item.l === 'list-item') {
        const sv = attr(item, 'start-value');
        counters[depth] = sv != null ? +sv : (counters[depth] ?? ((lv && lv.start) || 1) - 1) + 1;
        counters.length = depth + 1;
        const cached = kid(item, 'number');
        label = cached ? cached.c.filter((x) => typeof x === 'string').join('').trim() : numberLabel(lv, counters, depth, levels);
      }
      let first = true;
      for (const k of kids(item)) {
        if (k.l === 'p' || k.l === 'h') { paragraph(k, { label: first ? label : '', listX: lv && lv.x != null ? lv.x : depth * 18, kind: label ? 'li' : '' }); first = false; }
        else if (k.l === 'list') list(k, depth + 1, name, counters);
        else if (k.l === 'table') tableBlock(k);
        else if (k.l === 'soft-page-break') st.page++;
      }
    }
  };
  const tableBlock = (tbl) => {
    const pg = st.page;
    // 칸이 한 줄(열 하나)뿐인 표는 글을 두른 상자다: 칸 속 문단·표를 본문처럼 꺼낸다(공문 결재란처럼 표 안의 표가 '|'로 뭉개지지 않게)
    if (oneColumn(tbl)) {
      let first = true;
      for (const cell of cellsOf(tbl)) {
        const n = st.blocks.length;
        walk(cell);
        if (first && st.blocks.length > n) { st.blocks[n].gap = Math.max(st.blocks[n].gap || 0, 1); first = false; }
      }
      return;
    }
    const rows = tableRows(st, tbl);
    if (!rows.length) return;
    const filled = rows.flat().filter((c) => c && c.s.trim());
    if (filled.length <= 1 && rows.length * (rows[0] || []).length <= 2) {
      let first = true;
      if (filled[0]) for (const line of filled[0].s.split('\n')) if (line.trim()) { pushBlock({ t: 'p', segs: [{ s: line.trim(), pg }], joins: '', lvl: 0, kind: '', gap: first ? 1 : 0 }); first = false; }
      return;
    }
    pushBlock({ t: 'tbl', rows, pg, gap: 1 });
    st.page += descendants(tbl, 'soft-page-break').length;
  };
  const walk = (el) => {
    for (const k of kids(el)) {
      switch (k.l) {
        case 'p': case 'h': paragraph(k); break;
        case 'list': list(k, 0, null, null); break;
        case 'numbered-paragraph': {
          const lvl = Math.max(0, +(attr(k, 'level') || 1) - 1);
          const n = kid(k, 'number');
          for (const p of kids(k)) if (p.l === 'p' || p.l === 'h') paragraph(p, { label: n ? n.c.filter((x) => typeof x === 'string').join('').trim() : '', listX: lvl * 18 });
          break;
        }
        case 'table': tableBlock(k); break;
        case 'section': walk(k); break;
        case 'soft-page-break': st.page++; break;
        case 'table-of-content': case 'alphabetical-index': case 'illustration-index': case 'table-index': case 'object-index': case 'user-index': case 'bibliography': {
          const b = kid(k, 'index-body');
          if (b) walk(b);
          break;
        }
        case 'index-title': walk(k); break;
        case 'frame': case 'custom-shape': case 'rect': case 'ellipse': case 'polygon': case 'path': case 'g': case 'text-box':
          // 쪽에 붙은 글상자·도형: 그 안의 문단·표를 본문처럼
          for (const box of textBoxesOf(k)) walk(box);
          break;
        default: break; // 변경 기록·선언·양식 등
      }
    }
  };
  if (body) walk(body);
  finishLevels(st.blocks, st.xs);
  return st.blocks;
}

// ─── ODS ───
function cellDisplay(st, c) {
  const ps = kids(c).filter((k) => k.l === 'p' || k.l === 'h' || k.l === 'list');
  if (ps.length) return blockTexts(st, c).join('\n').replace(/\s+$/, '');
  const type = attr(c, 'value-type');
  if (!type) return '';
  const v = attr(c, 'value');
  switch (type) {
    case 'float': case 'currency': return v != null ? formatGeneral(+v) : '';
    case 'percentage': return v != null ? formatGeneral(+v * 100) + '%' : '';
    case 'boolean': return attr(c, 'boolean-value') === 'true' ? 'TRUE' : 'FALSE';
    case 'date': return attr(c, 'date-value') || '';
    case 'time': return attr(c, 'time-value') || '';
    case 'string': return attr(c, 'string-value') || '';
    default: return '';
  }
}

function readSheetOds(st, tbl) {
  const cells = new Map();
  const hiddenRows = new Set(), hiddenCols = new Set();
  const merges = [];
  const extras = [];
  const tstyle = st.table.get(attr(tbl, 'style-name'));
  const tp = tstyle ? kid(tstyle, 'table-properties') : null;
  const hidden = !!tp && attr(tp, 'display') === 'false';
  // 열 숨김
  let col = 0;
  const cols = (el) => {
    for (const k of kids(el)) {
      if (k.l === 'table-column') {
        const rep = Math.max(1, +(attr(k, 'number-columns-repeated') || 1));
        const vis = attr(k, 'visibility');
        if (vis === 'collapse' || vis === 'filter') for (let j = 0; j < Math.min(rep, 16384 - col); j++) hiddenCols.add(col + j);
        col += rep;
      } else if (k.l === 'table-header-columns' || k.l === 'table-columns' || k.l === 'table-column-group') cols(k);
    }
  };
  cols(tbl);
  let r = 0;
  const rowsOf = (el) => {
    for (const k of kids(el)) {
      if (k.l === 'table-row') {
        const rep = Math.max(1, +(attr(k, 'number-rows-repeated') || 1));
        const vis = attr(k, 'visibility');
        const hid = vis === 'collapse' || vis === 'filter';
        // 행 안 칸들
        const vals = [];
        let c = 0;
        for (const cell of kids(k)) {
          if (cell.l !== 'table-cell' && cell.l !== 'covered-table-cell') continue;
          const crep = Math.max(1, +(attr(cell, 'number-columns-repeated') || 1));
          if (cell.l === 'table-cell') {
            const s = cellDisplay(st, cell);
            const cs = Math.max(1, +(attr(cell, 'number-columns-spanned') || 1));
            const rs = Math.max(1, +(attr(cell, 'number-rows-spanned') || 1));
            if (s) for (let j = 0; j < Math.min(crep, 16384 - c); j++) vals.push([c + j, s]);
            if (cs > 1 || rs > 1) vals.push([c, null, cs, rs]);
          }
          c += crep;
          if (c > 16384) break;
        }
        const n = vals.length ? Math.min(rep, 100000) : 0;
        for (let i = 0; i < n; i++) {
          const rr = r + i;
          let row = null;
          for (const v of vals) {
            if (v[1] == null) { merges.push({ r0: rr, c0: v[0], r1: rr + v[3] - 1, c1: v[0] + v[2] - 1 }); continue; }
            if (!row) { row = cells.get(rr); if (!row) { row = new Map(); cells.set(rr, row); } }
            row.set(v[0], v[1]);
          }
        }
        if (hid) for (let i = 0; i < Math.min(rep, 1048576 - r); i++) { hiddenRows.add(r + i); if (hiddenRows.size > 200000) break; }
        r += rep;
      } else if (k.l === 'table-header-rows' || k.l === 'table-rows' || k.l === 'table-row-group') rowsOf(k);
    }
  };
  rowsOf(tbl);
  const shapes = kid(tbl, 'shapes');
  if (shapes) for (const t of blockTexts(st, shapes)) if (t.trim()) extras.push(t);
  if (shapes) for (const tb of descendants(shapes, 'text-box')) for (const t of blockTexts(st, tb)) if (t.trim()) extras.push(t);
  return { name: attr(tbl, 'name') || '', hidden, cells, merges, hiddenRows, hiddenCols, extras };
}

// ─── ODP ───
const CLASS_ROLE = { title: 'title', footer: 'hf', 'date-time': 'hf', 'page-number': 'hf', header: 'hf' };

function slideParas(st, el, listStyle) {
  const out = [];
  const para = (p, lvl, bullet) => {
    const s = paraTextOf(st, p);
    out.push({ s, lvl, bullet });
  };
  const list = (l, depth, inherited) => {
    const name = attr(l, 'style-name') || inherited;
    const counters = [];
    for (const item of kids(l)) {
      if (item.l !== 'list-item' && item.l !== 'list-header') continue;
      const lv = listLevel(st, name, depth);
      let bullet = null;
      if (item.l === 'list-item' && lv && !lv.none) {
        if (lv.bullet != null) bullet = lv.bullet.trim() ? lv.bullet : null;
        else if (lv.fmt) {
          const sv = attr(item, 'start-value');
          counters[depth] = sv != null ? +sv : (counters[depth] ?? lv.start - 1) + 1;
          bullet = lv.prefix + odfNumber(counters[depth], lv.fmt) + lv.suffix;
        }
      }
      let first = true;
      for (const k of kids(item)) {
        if (k.l === 'p' || k.l === 'h') { para(k, depth, first ? bullet : null); first = false; }
        else if (k.l === 'list') list(k, depth + 1, name);
      }
    }
  };
  for (const k of kids(el)) {
    if (k.l === 'p' || k.l === 'h') para(k, 0, null);
    else if (k.l === 'list') list(k, 0, listStyle);
  }
  return out;
}

// 도형의 꼴(presentation·graphic)에 든 목록 꼴 이름
function shapeListStyle(st, el) {
  let name = attr(el, 'style-name');
  const seen = new Set();
  while (name && st.graphic.has(name) && !seen.has(name) && seen.size < 10) {
    seen.add(name);
    const s = st.graphic.get(name);
    const ls = kid(s, 'list-style') || descendants(s, 'list-style')[0];
    if (ls) {
      const key = '#inline:' + name;
      if (!st.lists.has(key)) st.lists.set(key, ls);
      return key;
    }
    name = attr(s, 'parent-style-name');
  }
  return null;
}

function readSlideOdp(st, page) {
  const ps = st.drawPage.get(attr(page, 'style-name'));
  const pp = ps ? kid(ps, 'drawing-page-properties') : null;
  const hidden = !!pp && (attr(pp, 'visibility') === 'hidden' || attr(pp, 'display') === 'false');
  const shapes = [];
  const visit = (el) => {
    for (const k of kids(el)) {
      if (k.l === 'notes' || k.l === 'forms' || k.l === 'animations' || k.l === 'par') continue;
      if (k.l === 'g') { visit(k); continue; }
      const cls = attr(k, 'class');
      if (cls === 'notes' || cls === 'handout') continue;
      if (attr(k, 'placeholder') === 'true') continue; // 비어 있는 자리표시자
      const x = pt(attr(k, 'x')) || 0, y = pt(attr(k, 'y')) || 0, w = pt(attr(k, 'width')) || 0, h = pt(attr(k, 'height')) || 0;
      const role = CLASS_ROLE[cls] || '';
      const listStyle = shapeListStyle(st, k);
      if (k.l === 'frame') {
        const tb = kid(k, 'text-box');
        const tbl = kid(k, 'table');
        if (tbl) { const rows = tableRows(st, tbl); if (rows.length && rows.some((r) => r.some((c) => c && c.s.trim()))) shapes.push({ x, y, w, h, role: '', paras: [], table: rows }); continue; }
        if (tb) { const paras = slideParas(st, tb, listStyle); if (paras.some((p) => p.s.trim())) shapes.push({ x, y, w, h, role, paras, table: null }); }
        continue;
      }
      if (/^(custom-shape|rect|ellipse|polygon|polyline|path|line|connector|caption|regular-polygon|measure|circle)$/.test(k.l)) {
        const paras = slideParas(st, k, listStyle);
        if (paras.some((p) => p.s.trim())) shapes.push({ x, y, w, h, role, paras, table: null });
      }
    }
  };
  visit(page);
  return { hidden, shapes };
}

// ─── 들머리 ───
// kind: 'odt'|'ods'|'odp'(없으면 본문으로 가림). sheetsOnly·slidesOnly: 시험용 중간 자료
export function parseOdf(bytes, { kind = null, onProgress, sheetsOnly = false, slidesOnly = false } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const files = readZip(u8);
  const manifest = files['META-INF/manifest.xml'] ? strFromU8(files['META-INF/manifest.xml']) : '';
  if (/encryption-data/.test(manifest)) throw fail('password', '암호가 걸린 문서입니다');
  if (!files['content.xml']) throw fail('broken', '문서 본문(content.xml)을 찾지 못했습니다');
  const content = parseXml(strFromU8(files['content.xml']), { keepSpace: true });
  const styles = files['styles.xml'] ? parseXml(strFromU8(files['styles.xml']), { keepSpace: true }) : null;
  const doc = kid(content, 'document-content') || content;
  const body = kid(doc, 'body');
  if (!body) throw fail('broken', '문서 본문이 비어 있습니다');
  const office = body;
  const which = kid(office, 'text') ? 'odt' : kid(office, 'spreadsheet') ? 'ods' : kid(office, 'presentation') ? 'odp' : null;
  if (!which) throw fail('unsupported', '이 오픈문서 종류(그림 등)는 글을 뽑을 수 없습니다');
  // st: 꼴 모음 + 읽는 동안의 상태(쪽 번호·각주·블록·들여쓰기 위치)
  const st = { ...collectStyles(styles, doc), page: 1, noteNo: 0, notes: [], blocks: [], xs: [], pendingGap: 0, listCounters: new Map() };
  if (which === 'ods') {
    const sheets = kids(kid(office, 'spreadsheet'), 'table').map((t) => readSheetOds(st, t));
    if (onProgress) onProgress(1);
    if (sheetsOnly) return { sheets };
    return sheetsToModel('ods', sheets);
  }
  if (which === 'odp') {
    const slides = kids(kid(office, 'presentation'), 'page').map((p) => readSlideOdp(st, p));
    if (onProgress) onProgress(1);
    if (slidesOnly) return { slides };
    return slidesToModel('odp', slides);
  }
  const blocks = parseOdt(st, office);
  const metaPages = files['meta.xml'] ? +(/page-count="(\d+)"/.exec(strFromU8(files['meta.xml'])) || [])[1] || 0 : 0;
  const counted = blocks.reduce((m, b) => Math.max(m, b.t === 'tbl' ? b.pg : Math.max(...b.segs.map((s) => s.pg || 1))), 1);
  const out = { format: 'odt', pages: Math.max(counted, metaPages || 0), pageExact: false, blocks, notes: st.notes, warnings: [] };
  resolveSoftBreaks(out);
  if (onProgress) onProgress(1);
  return out;
}
