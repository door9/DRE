// PDF 글 배치 분석 — PDF 쪽마다 흩어진 글자 조각(좌표·크기)과 선(표 테두리)을 받아 문서 모델로 묶는다.
// 순서: ① 선으로 표를 찾아 칸 복원 ② 남은 글자를 줄로 ③ 단(세로 여백)을 갈라 읽는 순서 정하기
//       ④ 줄을 문단으로 묶고 줄 잇기 판단(띄울지 붙일지) ⑤ 머리말·꼬리말·쪽 번호 가려내기 ⑥ 쪽을 넘는 문단 잇기
// pdf.js 에 기대지 않는 순수 계산 — 시험(Node)과 앱(작업 스레드)이 같은 코드를 쓴다.
import { WordStats, joinScore, settleJoins, isListStart, hangulEnum } from './joiner.js';
import { levelize } from './model.js';

const median = (arr) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// 글자 대응표가 잘못 적힌 글꼴 바로잡기
// 신문 조판 체계(SSM 글꼴)의 사용자 글꼴은 따옴표·가운뎃점을 그리면서 PDF 글자표에는 엉뚱한 한글로 적는다
// (글꼴 모양을 직접 확인: 꾜=“ 꾸=” 꾑=‘ 꾕=’ 껜=·). 같은 한글이라도 다른 글꼴이면 진짜 글자이므로 이 글꼴에만 적용한다.
const FONT_FIXES = [
  { re: /SSMUSERFONT/i, map: { '\uAF9C': '\u201C', '\uAFB8': '\u201D', '\uAF91': '\u2018', '\uAF95': '\u2019', '\uAEDC': '\u00B7' } },
];
function fontFixer(name) {
  const fx = name && FONT_FIXES.find((f) => f.re.test(name));
  return fx ? (s) => s.replace(/[\uAC00-\uD7A3]/g, (c) => fx.map[c] || c) : null;
}

// ─────────────────────────────────────────────────────────────
// pdf.js 결과 → 쪽 자료(뷰 좌표: 왼쪽 위가 0, 아래로 갈수록 y 증가)
// ─────────────────────────────────────────────────────────────
export function pageFromPdfjs(textContent, opList, viewport, OPS, fontNames = {}) {
  const vt = viewport.transform;
  const fixers = new Map();
  const items = [];
  const spaces = [];
  const rotated = [];
  for (const it of textContent.items) {
    if (!('str' in it) || !it.transform) continue;
    const m = mul(vt, it.transform);
    const sx = Math.hypot(m[0], m[1]);
    const sy = Math.hypot(m[2], m[3]);
    const size = sy || sx;
    if (!size) continue;
    const horiz = Math.abs(m[1]) < 0.05 * sx && m[0] > 0 && m[3] < 0;
    const x = m[4], y = m[5];
    const w = it.width * (sx / Math.max(1e-6, Math.hypot(it.transform[0], it.transform[1])) || 1);
    let s = it.str;
    let fixed = false;
    if (it.fontName && fontNames[it.fontName]) {
      if (!fixers.has(it.fontName)) fixers.set(it.fontName, fontFixer(fontNames[it.fontName]));
      const fix = fixers.get(it.fontName);
      if (fix) { const t = fix(s); fixed = t !== s; s = t; }
    }
    if (!horiz) {
      if (s.trim()) rotated.push({ s: s.trim(), x, y, size });
      continue;
    }
    if (!s.trim()) {
      if (s.length && w > 0 && w < size * 4) spaces.push({ x0: x, x1: x + w, y });
      continue;
    }
    items.push({ s, x0: x, x1: x + Math.max(w, 0), y, size, font: it.fontName || '', fixed });
  }
  const rules = opList ? rulesFromOps(opList, vt, OPS, viewport) : [];
  if (rules.glyphs && rules.glyphs.length) addVectorGlyphs(rules.glyphs, items, spaces);
  return { w: viewport.width, h: viewport.height, items, spaces, rotated, rules, shapes: rules.shapes || [] };
}

// 그리기 명령에서 가로·세로 선분을 뽑는다(표 테두리 찾기용)
// out.shapes: 그림·도형이 차지한 상자(글이 비켜 간 자리를 알아보는 데 쓴다)
export function rulesFromOps(opList, vt, OPS, viewport) {
  const out = [];
  const shapes = [];
  out.shapes = shapes;
  const glyphs = [];
  out.glyphs = glyphs; // 글자 대신 그림으로 그린 작은 문장부호 후보(따옴표·가운뎃점)
  const pw = viewport ? viewport.width : Infinity, ph = viewport ? viewport.height : Infinity;
  // 점들의 상자(점이 아주 많은 지도·그래프 경로도 있어 펼침(...) 대신 하나씩 센다)
  const boxOf = (pts) => {
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, sy: 0 };
    for (const p of pts) {
      if (p[0] < b.x0) b.x0 = p[0];
      if (p[0] > b.x1) b.x1 = p[0];
      if (p[1] < b.y0) b.y0 = p[1];
      if (p[1] > b.y1) b.y1 = p[1];
      b.sy += p[1];
    }
    return b;
  };
  const addShape = (b) => {
    if (shapes.length > 3000) return;
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (!(w >= 3 && h >= 3) || (w > pw * 0.8 && h > ph * 0.5)) return; // 선·점, 쪽 전체 바탕은 빼고
    shapes.push({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
  };
  const { fnArray, argsArray } = opList;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const PAINT = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const FILLS = new Set([OPS.fill, OPS.eoFill]);
  const addSeg = (a, b) => {
    const dx = Math.abs(a[0] - b[0]), dy = Math.abs(a[1] - b[1]);
    if (dy < 1.2 && dx >= 3) out.push({ h: true, y: (a[1] + b[1]) / 2, a: Math.min(a[0], b[0]), b: Math.max(a[0], b[0]) });
    else if (dx < 1.2 && dy >= 3) out.push({ h: false, x: (a[0] + b[0]) / 2, a: Math.min(a[1], b[1]), b: Math.max(a[1], b[1]) });
  };
  const addRect = (pts, filled) => {
    const { x0, x1, y0, y1 } = boxOf(pts);
    const w = x1 - x0, h = y1 - y0;
    if (filled && h < 3 && w >= 3) { out.push({ h: true, y: (y0 + y1) / 2, a: x0, b: x1 }); return; }
    if (filled && w < 3 && h >= 3) { out.push({ h: false, x: (x0 + x1) / 2, a: y0, b: y1 }); return; }
    if (w < 3 || h < 3) return;
    // 칸 배경색 상자·테두리 상자: 네 변을 선으로
    out.push({ h: true, y: y0, a: x0, b: x1, box: filled }, { h: true, y: y1, a: x0, b: x1, box: filled });
    out.push({ h: false, x: x0, a: y0, b: y1, box: filled }, { h: false, x: x1, a: y0, b: y1, box: filled });
  };
  const handlePath = (paint, subpaths) => {
    if (!PAINT.has(paint)) return;
    const filled = FILLS.has(paint);
    const m = mul(vt, ctm);
    const all = [];
    for (const sp of subpaths) for (const p of sp.pts) all.push(apply(m, p[0], p[1]));
    if (!all.length) return;
    const bb = boxOf(all);
    addShape(bb);
    if (filled && (subpaths.length === 1 || subpaths.length === 2) && all.length >= 3 && glyphs.length < 5000 && bb.x1 - bb.x0 < 30 && bb.y1 - bb.y0 < 30) {
      glyphs.push({ x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1, n: subpaths.length, cy: bb.sy / all.length });
    }
    for (const sp of subpaths) {
      if (sp.curve) continue;
      const pts = sp.pts.map((p) => apply(m, p[0], p[1]));
      if (pts.length < 2) continue;
      // 축에 맞는 사각형인가
      const uniq = pts.filter((p, i) => i === 0 || Math.abs(p[0] - pts[i - 1][0]) > 0.01 || Math.abs(p[1] - pts[i - 1][1]) > 0.01);
      const closedRect = (uniq.length === 4 || (uniq.length === 5 && Math.abs(uniq[0][0] - uniq[4][0]) < 0.5 && Math.abs(uniq[0][1] - uniq[4][1]) < 0.5)) &&
        uniq.slice(0, 4).every((p, i, a) => { const q = a[(i + 1) % 4]; return Math.abs(p[0] - q[0]) < 0.5 || Math.abs(p[1] - q[1]) < 0.5; });
      if (closedRect) { addRect(uniq.slice(0, 4), filled); continue; }
      if (filled) continue; // 채운 다각형(로고 등)은 무시
      for (let i = 1; i < pts.length; i++) addSeg(pts[i - 1], pts[i]);
      if (sp.closed && pts.length > 2) addSeg(pts[pts.length - 1], pts[0]);
    }
  };
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args && args[0] && args[0].length === 6) ctm = mul(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.constructPath) {
      const subpaths = parsePath(args, OPS);
      if (subpaths) handlePath(subpaths.paint, subpaths.list);
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      // 그림은 단위 정사각형을 현재 변환으로 늘려 그린다
      const m = mul(vt, ctm);
      addShape(boxOf([apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)]));
    }
    if (out.length > 20000) break; // 그림처럼 선이 아주 많은 쪽은 그만
  }
  return out;
}

// constructPath 인자 풀기 — pdf.js 5 이후: [그리기 명령, [경로 숫자열], 범위], 그 전: [명령 목록, 좌표, 범위]
function parsePath(args, OPS) {
  const list = [];
  let cur = null;
  const start = (x, y) => { cur = { pts: [[x, y]], curve: false, closed: false }; list.push(cur); };
  if (typeof args[0] === 'number' && args[1] && args[1][0] && typeof args[1][0].length === 'number') {
    const d = args[1][0];
    for (let k = 0; k < d.length;) {
      const op = d[k++];
      if (op === 0) { start(d[k], d[k + 1]); k += 2; }
      else if (op === 1) { if (!cur) start(d[k], d[k + 1]); else cur.pts.push([d[k], d[k + 1]]); k += 2; }
      else if (op === 2) { if (cur) { cur.curve = true; cur.pts.push([d[k + 4], d[k + 5]]); } k += 6; }
      else if (op === 3) { if (cur) { cur.curve = true; cur.pts.push([d[k + 2], d[k + 3]]); } k += 4; }
      else if (op === 4) { if (cur) { cur.closed = true; const p = cur.pts[0]; cur = { pts: [[p[0], p[1]]], curve: false, closed: false }; list.push(cur); } }
      else break;
    }
    return { paint: args[0], list: list.filter((s) => s.pts.length > 1) };
  }
  // 옛 모양: 그리기 명령은 뒤따르는 연산으로 오므로 여기선 선만 모아 '그림'으로 본다
  if (Array.isArray(args[0])) {
    const ops = args[0], c = args[1];
    let j = 0;
    for (const op of ops) {
      if (op === OPS.moveTo) { start(c[j], c[j + 1]); j += 2; }
      else if (op === OPS.lineTo) { if (!cur) start(c[j], c[j + 1]); else cur.pts.push([c[j], c[j + 1]]); j += 2; }
      else if (op === OPS.rectangle) {
        const [x, y, w, h] = [c[j], c[j + 1], c[j + 2], c[j + 3]]; j += 4;
        list.push({ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], curve: false, closed: true });
        cur = null;
      } else if (op === OPS.curveTo) { if (cur) cur.curve = true; j += 6; }
      else if (op === OPS.curveTo2 || op === OPS.curveTo3) { if (cur) cur.curve = true; j += 4; }
      else if (op === OPS.closePath) { if (cur) cur.closed = true; }
    }
    return { paint: OPS.stroke, list: list.filter((s) => s.pts.length > 1) };
  }
  return null;
}

// 신문 조판 PDF(NewsPlus 등)는 따옴표·가운뎃점을 글자가 아니라 작은 도형으로 그린다 → 글에서 통째로 빠진다.
// 바로 옆 글자의 크기·기준선에 견줘 모양을 가려 글자로 되살린다:
//   두 조각·윗부분 = 큰따옴표, 한 조각·가늘고 윗부분 = 작은따옴표, 한 조각·작고 가운데 높이 = 가운뎃점.
//   여는지 닫는지는 모양으로(무게 중심이 아래면 여는 따옴표), 애매하면 어느 낱말에 붙어 있는지로.
function addVectorGlyphs(glyphs, items, spaces) {
  const added = [];
  // 따옴표·가운뎃점을 도형으로 그리는 조판은 쪽 글에 그 글자가 아예 없다. 글에 이미 있으면 그 쪽은 글자로 쓴 문서다
  const hasQuote = items.some((it) => /[“”‘’"']/.test(it.s));
  const hasDot = items.some((it) => /[·ㆍ‧∙・]/.test(it.s));
  if (hasQuote && hasDot) return;
  for (const g of glyphs) {
    const gx = (g.x0 + g.x1) / 2, gy = (g.y0 + g.y1) / 2;
    let r = null, best = Infinity, inside = null;
    for (const it of items) {
      if (gy < it.y - it.size * 0.95 || gy > it.y + it.size * 0.05) continue;
      // 도형 가운데가 글 조각 밖이면 거리(살짝 겹쳐도 0), 안이면 -1
      const d = gx < it.x0 ? Math.max(0, it.x0 - g.x1) : gx > it.x1 ? Math.max(0, g.x0 - it.x1) : -1;
      if (d < 0) { inside = it; break; }
      if (d < it.size * 1.2 && d < best) { best = d; r = it; }
    }
    const ref = inside || r;
    if (!ref) continue;
    const s = ref.size, w = (g.x1 - g.x0) / s, h = (g.y1 - g.y0) / s;
    const above = (ref.y - g.y1) / s;   // 기준선에서 도형 아래끝까지(위로 +)
    const top = (ref.y - g.y0) / s;     // 기준선에서 도형 위끝까지
    const mid = (ref.y - gy) / s;
    let ch = null;
    if (h >= 0.12 && h <= 0.45 && above >= 0.3 && top <= 1.05) {
      if (g.n === 2 && w >= 0.15 && w <= 0.6) ch = 'dq';
      else if (g.n === 1 && w >= 0.04 && w <= 0.25) ch = 'sq';
    }
    if (!ch && g.n === 1 && w >= 0.06 && w <= 0.3 && h >= 0.06 && h <= 0.3 && w / h > 0.5 && w / h < 2 && mid >= 0.15 && mid <= 0.6) ch = '\u00B7';
    if (!ch || (ch === '\u00B7' ? hasDot : hasQuote)) continue;
    // 글 조각 안에 놓인 문장부호 도형: 그 자리가 빈칸이면(pdf.js 가 도형 자리를 빈칸으로 채움) 조각을 둘로 나눈다.
    // 빈칸이 아닌 자리(글자 위에 겹친 밑줄·강조 표시 등)는 건드리지 않는다
    let parts = null;
    if (inside) {
      parts = splitAtSpace(inside, gx, g);
      if (!parts) continue;
    }
    // 같은 줄에서 왼쪽·오른쪽으로 가장 가까운 글
    let gl = Infinity, gr = Infinity;
    for (const it of parts ? [parts[0], parts[1], ...items] : items) {
      if (it === inside || Math.abs(it.y - ref.y) > s * 0.3) continue;
      if (it.x1 <= g.x0 + 0.5) gl = Math.min(gl, g.x0 - it.x1);
      else if (it.x0 >= g.x1 - 0.5) gr = Math.min(gr, it.x0 - g.x1);
    }
    // 진짜 글에 붙어 있어야 문장부호다(그래프 범례 네모·전화 그림 같은 장식은 아니다):
    // 가운뎃점은 양쪽 글에, 여는 따옴표는 뒤 글에, 닫는 따옴표는 앞 글에 바짝 붙는다
    if (ch === '\u00B7') {
      if (gl > s * 0.4 || gr > s * 0.4) continue;
    } else {
      // 모양이 먼저: 여는 따옴표(6 꼴)는 무게가 아래, 닫는 따옴표(9 꼴)는 위(매일경제 지면 실측 0.56·0.59 대 0.47·0.44). 애매하면 붙은 쪽
      const cr = (g.cy - g.y0) / Math.max(0.01, g.y1 - g.y0);
      let open;
      if (cr > 0.52) open = true;
      else if (cr < 0.48) open = false;
      else if (Math.abs(gl - gr) > s * 0.12) open = gr < gl;
      else open = true;
      if (open ? gr > s * 0.35 : gl > s * 0.35) continue;
      ch = ch === 'dq' ? (open ? '\u201C' : '\u201D') : (open ? '\u2018' : '\u2019');
    }
    if (parts) items.splice(items.indexOf(inside), 1, parts[0], parts[1]);
    added.push({ s: ch, x0: g.x0, x1: g.x1, y: ref.y, size: s, font: '', vec: true });
  }
  if (!added.length) return;
  items.push(...added);
  // 되살린 글자 자리에 pdf.js 가 넣어 둔 빈칸 흔적은 지운다(빈칸 판단은 틈으로 다시). 가운뎃점은 앞뒤를 붙여 쓰므로 둘레까지
  for (let i = spaces.length - 1; i >= 0; i--) {
    const sp = spaces[i];
    if (added.some((a) => {
      // 가운뎃점은 앞뒤, 닫는 따옴표는 앞, 여는 따옴표는 뒤 빈칸 흔적까지(따옴표 바깥쪽 빈칸은 진짜일 수 있어 남긴다)
      const dot = a.s === '\u00B7', open = a.s === '\u201C' || a.s === '\u2018';
      const padL = dot || !open ? a.size * 0.6 : 0.5, padR = dot || open ? a.size * 0.6 : 0.5;
      return Math.abs(sp.y - a.y) < a.size * 0.5 && sp.x1 > a.x0 - padL && sp.x0 < a.x1 + padR;
    })) spaces.splice(i, 1);
  }
}

// 글 조각 안의 빈칸 가운데 x 에 가장 가까운 것에서 조각을 둘로(글자 폭은 어림: 한글·한자 1, 영문 대문자·숫자 0.62, 소문자 0.5)
function splitAtSpace(it, x, g) {
  const chars = [...it.s];
  const wt = (c) => (/\s/.test(c) ? null : /[\u1100-\u11FF\u3000-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF\uFF00-\uFFEF]/.test(c) ? 1 : /[A-Z0-9]/.test(c) ? 0.62 : /[a-z]/.test(c) ? 0.5 : 0.4);
  const nsp = chars.filter((c) => /\s/.test(c)).length;
  if (!nsp) return null;
  const known = chars.reduce((a, c) => a + (wt(c) ?? 0), 0);
  const sp = Math.min(1.5, Math.max(0.1, ((it.x1 - it.x0) / it.size - known) / nsp));
  let at = it.x0, bi = -1, bd = Infinity, bx0 = 0, bx1 = 0;
  for (let i = 0; i < chars.length; i++) {
    const cw = (wt(chars[i]) ?? sp) * it.size;
    if (/\s/.test(chars[i])) {
      const d = Math.abs(at + cw / 2 - x);
      if (d < bd) { bd = d; bi = i; bx0 = at; bx1 = at + cw; }
    }
    at += cw;
  }
  if (bi < 0 || bd > it.size * 0.7) return null;
  const left = chars.slice(0, bi).join(''), right = chars.slice(bi + 1).join('');
  if (!left.trim() || !right.trim()) return null;
  // 어림한 자리가 도형과 겹치지 않게(줄 안 순서가 바뀌지 않도록). 어림이 조각 밖으로 나가면 나누지 않는다(글이 사라지지 않게)
  const lx1 = Math.min(bx0, g.x0 - 0.01), rx0 = Math.max(bx1, g.x1 + 0.01);
  if (lx1 <= it.x0 + it.size * 0.3 || rx0 >= it.x1 - it.size * 0.3) return null;
  return [{ ...it, s: left, x1: lx1 }, { ...it, s: right, x0: rx0 }];
}

// ─────────────────────────────────────────────────────────────
// 표 찾기: 서로 만나는 가로·세로 선 묶음 → 격자 → 칸(합친 칸 포함)
// ─────────────────────────────────────────────────────────────
function mergeSegs(segs, key) {
  // 같은 줄(가로선은 y, 세로선은 x)에 있고 겹치거나 붙은 선분을 하나로
  const groups = new Map();
  const sorted = [...segs].sort((p, q) => p[key] - q[key]);
  const lanes = [];
  for (const s of sorted) {
    let lane = lanes.length ? lanes[lanes.length - 1] : null;
    if (!lane || Math.abs(lane.v - s[key]) > 1.5) { lane = { v: s[key], items: [] }; lanes.push(lane); }
    lane.items.push(s);
  }
  const out = [];
  for (const lane of lanes) {
    const iv = lane.items.sort((p, q) => p.a - q.a);
    let cur = null;
    for (const s of iv) {
      if (cur && s.a <= cur.b + 2) cur.b = Math.max(cur.b, s.b);
      else { cur = { v: lane.v, a: s.a, b: s.b }; out.push(cur); }
    }
  }
  groups.clear();
  return out;
}

export function findTables(rules) {
  const H = mergeSegs(rules.filter((r) => r.h), 'y').filter((s) => s.b - s.a >= 4);
  const V = mergeSegs(rules.filter((r) => !r.h), 'x').filter((s) => s.b - s.a >= 4);
  if (H.length < 2 || V.length < 1 || H.length * V.length > 400000) return [];
  // 만나는 것끼리 묶기
  const n = H.length + V.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const tol = 2;
  for (let i = 0; i < H.length; i++) {
    const h = H[i];
    for (let j = 0; j < V.length; j++) {
      const v = V[j];
      if (v.v >= h.a - tol && v.v <= h.b + tol && h.v >= v.a - tol && h.v <= v.b + tol) {
        const a = find(i), b = find(H.length + j);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const comps = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!comps.has(r)) comps.set(r, { h: [], v: [] });
    if (i < H.length) comps.get(r).h.push(H[i]); else comps.get(r).v.push(V[i - H.length]);
  }
  const tables = [];
  for (const c of comps.values()) {
    if (c.h.length < 2 || c.v.length < 1) continue;
    const cluster = (vals) => {
      const s = [...vals].sort((a, b) => a - b);
      const out = [];
      for (const v of s) if (!out.length || v - out[out.length - 1] > 2.5) out.push(v); else out[out.length - 1] = (out[out.length - 1] + v) / 2;
      return out;
    };
    const xs = cluster(c.v.map((s) => s.v));
    const ys = cluster(c.h.map((s) => s.v));
    // 양옆이 열린 표(바깥 세로 테두리가 없는 한글 공문 서식 등): 가로선 여럿이 같은 자리에서 끝나면 그 자리를 표의 바깥 경계로
    if (xs.length >= 1 && c.h.length >= 3) {
      const edge = (vals, beyond) => {
        const cand = cluster(vals.filter(beyond));
        let best = null, bn = 0;
        for (const x of cand) { const n = vals.filter((v) => Math.abs(v - x) <= 3).length; if (n > bn) { bn = n; best = x; } }
        return best != null && bn >= Math.max(3, c.h.length * 0.6) ? best : null;
      };
      const L = edge(c.h.map((s) => s.a), (v) => v < xs[0] - 5);
      const R = edge(c.h.map((s) => s.b), (v) => v > xs[xs.length - 1] + 5);
      if (L != null) xs.unshift(L);
      if (R != null) xs.push(R);
      // 세로선이 하나뿐이면 양쪽 경계를 다 찾았을 때만 표(두 칸)
      if (c.v.length < 2 && (L == null || R == null)) continue;
    } else if (c.v.length < 2) continue;
    if (xs.length < 2 || ys.length < 2) continue;
    const nr = ys.length - 1, nc = xs.length - 1;
    if (nr * nc > 20000) continue;
    const covered = (segs, at, a, b) => {
      // at 위치의 선이 [a,b] 구간을 70% 이상 덮는가
      let cov = 0;
      for (const s of segs) if (Math.abs(s.v - at) <= 2) cov += Math.max(0, Math.min(b, s.b) - Math.max(a, s.a));
      return cov >= (b - a) * 0.7;
    };
    // 칸 합치기(경계선이 없으면 이웃 칸과 하나)
    const id = (r, k) => r * nc + k;
    const up = Array.from({ length: nr * nc }, (_, i) => i);
    const f2 = (i) => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
    const join = (a, b) => { const x = f2(a), y = f2(b); if (x !== y) up[x] = y; };
    for (let r = 0; r < nr; r++) {
      for (let k = 0; k < nc; k++) {
        if (k + 1 < nc && !covered(c.v, xs[k + 1], ys[r], ys[r + 1])) join(id(r, k), id(r, k + 1));
        if (r + 1 < nr && !covered(c.h, ys[r + 1], xs[k], xs[k + 1])) join(id(r, k), id(r + 1, k));
      }
    }
    const cells = new Map();
    for (let r = 0; r < nr; r++) for (let k = 0; k < nc; k++) {
      const root = f2(id(r, k));
      const cell = cells.get(root) || { r0: r, c0: k, r1: r, c1: k };
      cell.r0 = Math.min(cell.r0, r); cell.c0 = Math.min(cell.c0, k);
      cell.r1 = Math.max(cell.r1, r); cell.c1 = Math.max(cell.c1, k);
      cells.set(root, cell);
    }
    const list = [...cells.values()].map((q) => ({
      r: q.r0, c: q.c0, rs: q.r1 - q.r0 + 1, cs: q.c1 - q.c0 + 1,
      x0: xs[q.c0], x1: xs[q.c1 + 1], y0: ys[q.r0], y1: ys[q.r1 + 1], runs: [],
    }));
    tables.push({ x0: xs[0], x1: xs[nc], y0: ys[0], y1: ys[nr], nr, nc, cells: list });
  }
  // 다른 표 안에 들어간 표(칸 속 표)는 바깥 표에 맡긴다
  return tables.filter((t) => !tables.some((o) => o !== t && o.x0 <= t.x0 + 1 && o.x1 >= t.x1 - 1 && o.y0 <= t.y0 + 1 && o.y1 >= t.y1 - 1 && (o.x1 - o.x0) * (o.y1 - o.y0) > (t.x1 - t.x0) * (t.y1 - t.y0)));
}

// ─────────────────────────────────────────────────────────────
// 글자 조각 → 줄
// ─────────────────────────────────────────────────────────────
function runTop(r) { return r.y - r.size * 0.85; }
function runBot(r) { return r.y + r.size * 0.25; }

// 같은 자리에 두 번 찍은 글(굵게 보이려는 수법) 지우기
// 그림자·외곽선 효과로 같은 글을 조금씩 비켜 여러 번 그린 것도 하나로(겹치는 자리에 같은 글이거나 한쪽이 다른 쪽을 품을 때)
function dedupe(runs) {
  const out = [];
  for (const r of runs) {
    const t = r.s.replace(/\s+/g, '');
    let dup = false;
    for (let k = out.length - 1; k >= 0 && k >= out.length - 12; k--) {
      const p = out[k];
      if (Math.abs(p.y - r.y) > r.size * 0.45 || Math.abs(p.size - r.size) > r.size * 0.15) continue;
      const ov = Math.min(p.x1, r.x1) - Math.max(p.x0, r.x0);
      if (ov <= 0) continue;
      const pt = p.s.replace(/\s+/g, '');
      const minW = Math.min(p.x1 - p.x0, r.x1 - r.x0) || 1;
      if (ov / minW < 0.6) continue;
      if (pt === t || (pt.includes(t) && t.length >= 2)) { dup = true; break; }
      if (t.includes(pt) && pt.length >= 2) { out[k] = r; dup = true; break; } // 더 긴 쪽을 남긴다
    }
    if (!dup) out.push(r);
  }
  return out;
}

// split: 이보다 넓은 틈(글자 크기 배수)에서 조각을 나눈다. own: 조각의 높이·위치를 줄 전체가 아니라 제 글자들로 잡는다
export function buildLines(runs, spaces = [], { split = 2.2, own = false } = {}) {
  const rs = [...runs].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const lines = [];
  for (const r of rs) {
    let best = null, bestScore = 0;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 16; i--) {
      const L = lines[i];
      if (runBot(r) < L.top || runTop(r) > L.bot) continue;
      // 줄 안에서 가로로 가장 가까운 조각과 견준다 — 다른 단의 큰 글이 섞여 줄 높이가 번져도 아래 줄을 삼키지 않게
      let q = L.runs[0], qd = Infinity;
      for (const x of L.runs) { const d = Math.max(0, x.x0 - r.x1, r.x0 - x.x1); if (d < qd) { qd = d; q = x; } }
      const top = Math.max(runTop(q), runTop(r)), bot = Math.min(runBot(q), runBot(r));
      const ov = bot - top;
      const minH = Math.min(runBot(q) - runTop(q), runBot(r) - runTop(r));
      if (ov <= 0) continue;
      const score = ov / minH;
      const baseOk = Math.abs(q.y - r.y) <= Math.max(q.size, r.size) * 0.45 || (r.size < q.size * 0.8 && score > 0.5);
      if (baseOk && score > 0.45 && score > bestScore) { best = L; bestScore = score; }
    }
    if (!best) {
      best = { runs: [], top: runTop(r), bot: runBot(r), y: r.y, size: r.size };
      lines.push(best);
    }
    best.runs.push(r);
    best.top = Math.min(best.top, runTop(r));
    best.bot = Math.max(best.bot, runBot(r));
    if (r.size >= best.size * 0.95) { best.y = r.y; best.size = Math.max(best.size, r.size); }
  }
  // 줄마다 왼→오 정렬 후, 큰 틈에서 조각(fragment)으로 나눈다
  const frags = [];
  for (const L of lines) {
    const runs2 = dedupe(L.runs.sort((a, b) => a.x0 - b.x0));
    let cur = null;
    for (const r of runs2) {
      const gap = cur ? r.x0 - cur.x1 : 0;
      // 잘게 나눌 때(own)는 바로 옆 글자 크기로 잰다 — 같은 높이 어딘가의 큰 제목이 줄 크기를 키워 단 사이를 못 가르지 않게
      const ref = own && cur ? cur.runs[cur.runs.length - 1].size : L.size;
      if (!cur || gap > Math.max(ref, r.size) * split) {
        cur = { runs: [r], x0: r.x0, x1: r.x1, y: L.y, size: L.size, top: L.top, bot: L.bot };
        frags.push(cur);
      } else {
        cur.runs.push(r);
        cur.x1 = Math.max(cur.x1, r.x1);
      }
    }
  }
  if (own) for (const f of frags) ownGeometry(f);
  for (const f of frags) fragText(f, spaces);
  return frags;
}

// 조각의 위·아래·기준선·크기를 제 글자들로(여러 단이 한 줄로 묶여 높이가 부풀지 않게)
function ownGeometry(f) {
  let big = f.runs[0];
  f.top = Infinity; f.bot = -Infinity;
  for (const r of f.runs) {
    f.top = Math.min(f.top, runTop(r));
    f.bot = Math.max(f.bot, runBot(r));
    if (r.size > big.size) big = r;
  }
  f.y = big.y;
  f.size = big.size;
  f.x0 = Math.min(...f.runs.map((r) => r.x0));
  f.x1 = Math.max(...f.runs.map((r) => r.x1));
}

// 조각 안의 글자 잇기(틈이 글자 크기의 0.18배 넘거나 빈칸 흔적이 있으면 띄운다)
function fragText(f, spaces) {
  let s = '';
  let prev = null;
  const gaps = [];
  for (const r of f.runs) {
    let t = r.s;
    if (prev) {
      const gap = r.x0 - prev.x1;
      const hint = spaces.some((sp) => Math.abs(sp.y - r.y) < r.size * 0.5 && sp.x0 >= prev.x1 - r.size * 0.3 && sp.x1 <= r.x0 + r.size * 0.3);
      const sz = Math.min(prev.size, r.size);
      // 문장부호 둘레는 글자 모양 때문에 틈이 넓어 보이기 쉽다: 가운뎃점·마침표·쉼표 둘레는 더 넓어야 띄운다
      const a = s[s.length - 1] || '', b = t[0] || '';
      let th = 0.18;
      if (/[·‧․⋅ㆍ・]/.test(a) || /[·‧․⋅ㆍ・]/.test(b)) th = 0.6;
      else if (/[(\[「『“‘]/.test(a)) th = 0.5;
      else if (prev.vec || r.vec || prev.fixed || r.fixed) {
        // 되살리거나 바로잡은 문장부호(신문 조판). 도형으로 되살린 것(vec)은 글자 폭이 아니라 잉크 폭이라 틈이 실제보다 넓다
        const vec = prev.vec || r.vec;
        if (/[“‘「『〈《]/.test(b)) th = 0.1;                              // 여는 따옴표 앞 빈칸은 좁아도 빈칸
        else if (vec && /[”’」』]/.test(b)) th = 0.5;                       // 닫는 따옴표는 앞 글자에 붙는다
        else if (vec && /[”’」』]/.test(a) && /[가-힣]/.test(b)) th = 0.4;  // 그 뒤 조사도 붙는다(‘러스트벨트화’도)
      }
      const needSpace = !/\s$/.test(s) && !/^\s/.test(t) && (hint || gap > sz * th);
      if (needSpace) { s += ' '; gaps.push(gap / r.size); }
    }
    s += t;
    prev = r;
  }
  f.text = s.replace(/[\s\u00a0]+/g, ' ').trim();
  f.trailSpace = /\s$/.test(f.runs[f.runs.length - 1].s) || spaces.some((sp) => Math.abs(sp.y - f.y) < f.size * 0.5 && sp.x0 >= f.x1 - f.size * 0.3 && sp.x0 <= f.x1 + f.size * 0.5);
  f.spaceGaps = gaps;
  // 글머리표 뒤 본문이 시작하는 x(내어쓰기 맞춤용)
  f.hangX = null;
  const m = f.text.match(/^(\S{1,4})\s/);
  if (m && isListStart(f.text) && f.runs.length) {
    let acc = 0;
    for (const r of f.runs) {
      const t = r.s;
      if (acc + t.length > m[1].length) {
        // 이 조각 안에서 글머리표 다음 글자 위치를 비율로 어림
        const k = Math.max(0, m[0].length - acc);
        f.hangX = r.x0 + ((r.x1 - r.x0) * k) / Math.max(1, t.length);
        break;
      }
      acc += t.length;
    }
  }
  const firstTok = f.text.split(' ')[0] || '';
  const r0 = f.runs[0];
  const cw = r0 ? (r0.x1 - r0.x0) / Math.max(1, [...r0.s].length) : f.size * 0.6;
  f.firstWordW = [...firstTok].length * cw;
  f.charW = cw || f.size * 0.6;
}

// ─────────────────────────────────────────────────────────────
// 읽는 순서: 세로 여백(단)과 가로 여백으로 영역을 나눈다(XY-cut)
// ─────────────────────────────────────────────────────────────
function bbox(els) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const e of els) { x0 = Math.min(x0, e.x0); x1 = Math.max(x1, e.x1); y0 = Math.min(y0, e.top); y1 = Math.max(y1, e.bot); }
  return { x0, x1, y0, y1 };
}

function gapsOf(els, lo, hi, minGap) {
  const iv = els.map((e) => [lo(e), hi(e)]).sort((a, b) => a[0] - b[0]);
  const out = [];
  let end = iv.length ? iv[0][1] : 0;
  for (let i = 1; i < iv.length; i++) {
    if (iv[i][0] - end >= minGap) out.push([end, iv[i][0]]);
    end = Math.max(end, iv[i][1]);
  }
  return out;
}

// 세로 여백으로 나눠도 되는가(표처럼 줄이 나란한 곳은 나누지 않는다)
function columnSplitOk(left, right, size, ctx = {}, gap = null) {
  const lb = bbox(left), rb = bbox(right);
  if (lb.x1 - lb.x0 < size * 5 || rb.x1 - rb.x0 < size * 5) return false;
  const lt = left.filter((e) => !e.table), rt = right.filter((e) => !e.table);
  if (lt.length < 2 || rt.length < 2) return lt.length + rt.length > 0 && (lt.length >= 3 || rt.length >= 3) && (left.some((e) => e.table) || right.some((e) => e.table));
  // 양쪽 모두 긴 글줄(글자 8개 폭 이상)이고, 어느 한쪽에 오른쪽 끝을 맞춘(양쪽 맞춤) 본문 줄이 촘촘히(줄 간격 글자 1.75배 이하) 5줄 넘게
  // 이어지면 단이다 — 신문처럼 단끼리 줄 높이가 같아도 표로 보지 않는다.
  // (항목|날짜 표는 오른쪽 끝에 닿는 줄이 몇 개뿐이고 칸 여백 때문에 줄 간격이 넓다. 한쪽에 여러 단이 함께 있어도 그쪽 맨 오른쪽 단의 줄로 판단)
  const wide = (arr) => median(arr.map((e) => e.x1 - e.x0)) >= size * 8;
  const colLike = (arr, b) => {
    const f = arr.filter((e) => b.x1 - e.x1 < size);
    if (f.length < 5) return false;
    const ys = [...new Set(f.map((e) => Math.round(e.y)))].sort((p, q) => p - q);
    const d = [];
    for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] > size * 0.3) d.push(ys[i] - ys[i - 1]);
    return d.length >= 3 && median(d) <= size * 1.75;
  };
  // 단 사이를 가로지르는 가로줄이 여럿이면 줄마다 칸을 나눈 표다(세로줄 없는 표) — 단으로 보지 않는다
  // (칸마다 따로 그린 줄은 틈 양쪽에서 같은 높이로 틈에 닿는다)
  let rows = 0;
  if (gap && ctx.hRules) {
    const y0 = Math.min(lb.y0, rb.y0), y1 = Math.max(lb.y1, rb.y1);
    const hs = ctx.hRules.filter((r) => r.y > y0 && r.y < y1);
    const leftTouch = hs.filter((r) => r.b >= gap[0] - 3 && r.a < gap[0] - size * 2);
    const rightTouch = hs.filter((r) => r.a <= gap[1] + 3 && r.b > gap[1] + size * 2);
    rows = leftTouch.filter((l) => l.b > gap[1] + 1 || rightTouch.some((r) => Math.abs(r.y - l.y) < 2)).length;
  }
  if (rows < 2 && lt.length >= 3 && rt.length >= 3 && wide(lt) && wide(rt) && (colLike(lt, lb) || colLike(rt, rb))) return true;
  // 나란한 줄(같은 높이)이 많고 조각들이 짧으면 표 → 나누지 않음
  let aligned = 0;
  for (const a of lt) if (rt.some((b) => Math.abs(a.y - b.y) < size * 0.3)) aligned++;
  const alignRatio = aligned / Math.min(lt.length, rt.length);
  // 몇 줄 안 되는 띠에서 왼쪽·오른쪽 줄이 한 줄씩 정확히 짝을 이루면 표의 행이다(항목|날짜) — 가르지 않는다
  if (alignRatio >= 0.99 && lt.length === rt.length && lt.length <= 3) return false;
  const fillL = median(lt.map((e) => (e.x1 - e.x0) / Math.max(1, lb.x1 - lb.x0)));
  const fillR = median(rt.map((e) => (e.x1 - e.x0) / Math.max(1, rb.x1 - rb.x0)));
  if (alignRatio > 0.6 && (fillL < 0.7 || fillR < 0.7)) return false;
  // 양쪽이 모두 '글줄'다워야 단으로 본다
  if (fillL < 0.45 && fillR < 0.45) return false;
  return true;
}

function xyCut(els, colBox, out, size, depth = 0, ctx = {}) {
  if (!els.length) return;
  if (els.length === 1 || depth > 60) { out.push({ els, colBox }); return; }
  const box = bbox(els);
  // 1) 세로 여백(단 사이)
  const vgaps = gapsOf(els, (e) => e.x0, (e) => e.x1, Math.max(6, size * 0.8))
    .filter(([a, b]) => a > box.x0 + 1 && b < box.x1 - 1)
    .sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]));
  for (const [a, b] of vgaps) {
    const left = els.filter((e) => e.x1 <= a + 0.5);
    const right = els.filter((e) => e.x0 >= b - 0.5);
    if (left.length + right.length !== els.length) continue;
    if (!columnSplitOk(left, right, size, ctx, [a, b])) continue;
    const L = [], R = [];
    xyCut(left, bbox(left), L, size, depth + 1, ctx);
    xyCut(right, bbox(right), R, size, depth + 1, ctx);
    out.push(...hoistDisplay(L, R, size));
    return;
  }
  // 2) 가로 여백: 가장 넓은 곳에서 나눈다
  const hgaps = gapsOf(els, (e) => e.top, (e) => e.bot, 0.01);
  if (!hgaps.length) { out.push({ els, colBox }); return; }
  let best = hgaps[0];
  for (const g of hgaps) if (g[1] - g[0] > best[1] - best[0]) best = g;
  const cut = (best[0] + best[1]) / 2;
  const top = els.filter((e) => e.bot <= cut + 0.01);
  const bot = els.filter((e) => e.top >= cut - 0.01);
  if (!top.length || !bot.length || top.length + bot.length !== els.length) { out.push({ els, colBox }); return; }
  xyCut(top, colBox, out, size, depth + 1, ctx);
  xyCut(bot, colBox, out, size, depth + 1, ctx);
}

// 영역 성질: 큰 글(본문보다 15% 넘게 큰 글자가 대부분)인가, 마지막 줄 글
function leafInfo(leaf, size) {
  const fr = leaf.els.filter((e) => e.frag);
  if (!fr.length) return { display: false, last: '', indented: false };
  let chars = 0, big = 0;
  for (const e of fr) for (const r of e.frag.runs) {
    const n = r.s.replace(/\s+/g, '').length;
    chars += n;
    if (r.size >= size * 1.15) big += n;
  }
  let maxY = -Infinity, minY = Infinity, minX = Infinity;
  for (const e of fr) { if (e.y > maxY) maxY = e.y; if (e.y < minY) minY = e.y; if (e.x0 < minX) minX = e.x0; }
  const last = fr.filter((e) => Math.abs(e.y - maxY) < e.size * 0.45).sort((a, b) => a.x0 - b.x0).map((e) => e.frag.text).join(' ');
  // 첫 줄이 들여 쓰였나(새 문단으로 시작하는 단인가)
  const first = fr.filter((e) => Math.abs(e.y - minY) < e.size * 0.45);
  const left = leaf.colBox ? leaf.colBox.x0 : minX; // 단 왼쪽 끝에 견준다(영역이 첫 줄 하나뿐일 수도 있다)
  const indented = first.reduce((m, e) => Math.min(m, e.x0), Infinity) - left > first[0].size * 0.5;
  return { display: chars > 0 && big / chars > 0.6, last, indented };
}

// 문장이 끝나지 않은 채 끊긴 줄인가(다음 단으로 이어진다)
export function unfinishedLine(t) {
  const s = (t || '').trim();
  return !!s && !/[.!?。…:;][\s"'\u201D\u2019)\]\u300D\u300F]*$/.test(s);
}

// 신문처럼 본문이 왼쪽 단 끝에서 문장 가운데 끊겨 오른쪽 단으로 이어지는데, 오른쪽 단 맨 위에 큰 글(사진 위 부제·인용구)이
// 끼어 있으면 그 큰 글을 단들 앞으로 옮긴다 — 본문이 끊기지 않고 이어 읽히게. (앞 단이 문장 끝으로 끝났으면 제목이므로 그대로)
function hoistDisplay(L, R, size) {
  let k = 0;
  while (k < R.length && leafInfo(R[k], size).display) k++;
  if (k > 0 && k < R.length) {
    let lastBody = null;
    for (let i = L.length - 1; i >= 0; i--) { const inf = leafInfo(L[i], size); if (!inf.display && inf.last) { lastBody = inf; break; } }
    // 큰 글 다음 본문이 들여쓰기 없이 시작해야(앞 단 문장이 이어짐) 옮긴다 — 들여 썼으면 그 큰 글은 다음 기사의 제목이다
    if (lastBody && unfinishedLine(lastBody.last) && !leafInfo(R[k], size).indented) return [...R.slice(0, k), ...L, ...R.slice(k)];
  }
  return [...L, ...R];
}

// 줄글인가(신문 기사 상자): 글자 200자 넘고, 줄 대부분이 글자 10개 폭 넘게 길다. 순서도·조직도 같은 그림 속 짧은 이름표는 아니다
function runningText(runs) {
  const chars = runs.reduce((n, r) => n + r.s.replace(/\s+/g, '').length, 0);
  if (chars < 200) return false;
  const size = median(runs.map((r) => r.size)) || 10;
  const widths = buildLines(runs, []).map((l) => (l.x1 - l.x0) / size);
  return widths.length >= 5 && median(widths) >= 12 && widths.filter((w) => w >= 10).length >= widths.length * 0.6;
}

// ─────────────────────────────────────────────────────────────
// 쪽 하나 분석: 표·줄·읽는 순서
// ─────────────────────────────────────────────────────────────
export function analyzePage(page) {
  const runs = page.items.filter((r) => r.x1 > r.x0 - 0.01);
  const tables = findTables(page.rules || []);
  const realTables = [];
  const frames = [];
  for (const t of tables) {
    if (t.nc >= 2 && t.cells.length >= 2) realTables.push(t);
    else frames.push(t);
  }
  // 표 칸에 글자 나눠 담기
  const free = [];
  for (const r of runs) {
    const cx = (r.x0 + r.x1) / 2, cy = r.y - r.size * 0.3;
    let placed = false;
    for (const t of realTables) {
      if (cx < t.x0 - 1 || cx > t.x1 + 1 || cy < t.y0 - 1 || cy > t.y1 + 1) continue;
      for (const c of t.cells) {
        if (cx >= c.x0 - 1 && cx <= c.x1 + 1 && cy >= c.y0 - 1 && cy <= c.y1 + 1) { c.runs.push(r); placed = true; break; }
      }
      if (placed) break;
    }
    if (!placed) free.push(r);
  }
  // 칸끼리 겹치는 '표'는 표가 아니다(신문 기사 상자·사진 테두리 선이 격자처럼 보인 것: 한 칸이 상자 전체를 덮고
  // 그 안에 다른 칸이 또 있다). 진짜 표의 합친 칸은 겹치지 않는다 → 글을 보통 배치로 돌린다
  const overlaps = (t) => t.cells.some((a, i) => t.cells.some((b, j) => j > i &&
    a.r < b.r + b.rs && b.r < a.r + a.rs && a.c < b.c + b.cs && b.c < a.c + a.cs));
  for (let i = realTables.length - 1; i >= 0; i--) {
    const t = realTables[i];
    const texts = t.cells.filter((c) => c.runs.length);
    if (texts.length !== 1 || t.cells.length > 400 || !overlaps(t) || !runningText(texts[0].runs)) continue;
    for (const c of t.cells) { free.push(...c.runs); c.runs = []; }
    realTables.splice(i, 1);
    frames.push(t);
  }
  // 단 사이가 좁은 신문(글자 1~1.5개 폭)도 가를 수 있게, 먼저 글자 0.8개 폭보다 넓은 틈에서 잘게 나눈 조각으로 영역을 정한다.
  // 영역을 정한 뒤 같은 줄의 가까운 조각(2.2개 폭 이하)은 다시 한 조각으로 붙인다.
  const frags = buildLines(free, page.spaces, { split: 0.8, own: true });
  const sizes = frags.flatMap((f) => f.runs.map((r) => r.size));
  const size = median(sizes) || 10;
  const els = frags.map((f) => ({ x0: f.x0, x1: f.x1, top: f.top, bot: f.bot, y: f.y, size: f.size, frag: f }));
  for (const t of realTables) {
    if (!t.cells.some((c) => c.runs.length)) continue;
    els.push({ table: t, x0: t.x0, x1: t.x1, top: t.y0, bot: t.y1, y: t.y0 });
  }
  const regions = [];
  const hRules = mergeSegs((page.rules || []).filter((r) => r.h), 'y').map((r) => ({ y: r.v, a: r.a, b: r.b }));
  xyCut(els, bbox(els.length ? els : [{ x0: 0, x1: page.w, top: 0, bot: page.h }]), regions, size, 0, { hRules });
  // 영역 안: 같은 높이 조각은 한 줄로(탭으로 이어)
  const seq = [];
  for (const reg of regions) {
    const items = reg.els.sort((a, b) => a.top - b.top || a.x0 - b.x0);
    const lineGroups = [];
    for (const e of items) {
      if (e.table) { lineGroups.push({ table: e.table }); continue; }
      const g = lineGroups.find((x) => !x.table && Math.abs(x.y - e.y) < Math.max(x.size, e.size) * 0.45);
      if (g) { g.frags.push(e.frag); } else lineGroups.push({ y: e.y, size: e.size, frags: [e.frag] });
    }
    for (const g of lineGroups) {
      if (g.table) { seq.push({ table: g.table, colBox: reg.colBox }); continue; }
      g.frags.sort((a, b) => a.x0 - b.x0);
      const frs = rejoin(g.frags, page.spaces);
      // 신문 문단 끝 줄 오른쪽에 붙은 '관련기사 A3면' 같은 안내는 따로 줄로(문단 잇기를 막지 않게)
      if (frs.length >= 2 && /^(?:관련\s*기사|관련\s*기획|▶\s*관련)/.test(frs[frs.length - 1].text)) {
        seq.push({ line: makeLine(frs.slice(0, -1)), colBox: reg.colBox });
        seq.push({ line: makeLine(frs.slice(-1)), colBox: reg.colBox, note: true });
        continue;
      }
      seq.push({ line: makeLine(frs), colBox: reg.colBox });
    }
  }
  return { seq, size, w: page.w, h: page.h, frames, rotated: page.rotated || [], shapes: page.shapes || [] };
}

// 한 줄 안의 잘게 나눈 조각들: 틈이 글자 2.2개 폭 이하면 다시 하나로(띄어쓰기는 fragText 가 다시 판단)
function rejoin(frags, spaces) {
  const out = [];
  let cur = null;
  for (const f of frags) {
    if (cur && f.x0 - cur.x1 <= Math.max(cur.size, f.size) * 2.2) {
      cur.runs.push(...f.runs);
      cur.x1 = Math.max(cur.x1, f.x1);
      cur.merged = true;
    } else {
      cur = { ...f, runs: [...f.runs] };
      out.push(cur);
    }
  }
  for (const f of out) if (f.merged) { ownGeometry(f); fragText(f, spaces); }
  return out;
}

function makeLine(frags) {
  const f0 = frags[0], fl = frags[frags.length - 1];
  const size = median(frags.flatMap((f) => f.runs.map((r) => r.size))) || f0.size;
  return {
    frags,
    text: frags.map((f) => f.text).join('\t'),
    x0: f0.x0, x1: fl.x1, y: median(frags.map((f) => f.y)), size,
    top: Math.min(...frags.map((f) => f.top)), bot: Math.max(...frags.map((f) => f.bot)),
    trailSpace: fl.trailSpace, hangX: f0.hangX, firstWordW: f0.firstWordW, charW: f0.charW,
    spaceGaps: frags.flatMap((f) => f.spaceGaps),
    font: (f0.runs[0] && f0.runs[0].font) || '',
    tabbed: frags.length > 1,
  };
}

// ─────────────────────────────────────────────────────────────
// 문서 전체: 머리말·꼬리말, 문단 묶기, 줄 잇기, 쪽 넘김 잇기
// ─────────────────────────────────────────────────────────────
const PAGE_NUM = /^[\s\-－–—~·.()<>[\]]*(?:\d{1,4}|[ivxlcdm]{1,7}|[ⅰ-ⅻⅠ-Ⅻ]+)(?:\s*[/／]\s*\d{1,4})?[\s\-－–—~·.()<>[\]]*$/i;
const PAGE_WORD = /^(?:page|p\.)\s*\d+(?:\s*(?:of|\/)\s*\d+)?$|^\d+\s*쪽$|^-?\s*\d+\s*페이지\s*-?$/i;

function hfKey(text) {
  return text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function assemble(pagesA, { onProgress } = {}) {
  const nPages = pagesA.length;
  // ── 머리말·꼬리말 ──
  const zoneCount = new Map();
  pagesA.forEach((p) => {
    const seen = new Set();
    for (const it of p.seq) {
      if (!it.line) continue;
      const L = it.line;
      const zone = L.y < p.h * 0.12 ? 'T' : L.y > p.h * 0.88 ? 'B' : null;
      if (!zone || L.text.length > 150) continue;
      const k = zone + hfKey(L.text);
      if (seen.has(k)) continue;
      seen.add(k);
      zoneCount.set(k, (zoneCount.get(k) || 0) + 1);
    }
  });
  const minRepeat = Math.max(2, Math.ceil(nPages * 0.4));
  pagesA.forEach((p) => {
    const zoneOf = (X) => (X.y < p.h * 0.12 ? 'T' : X.y > p.h * 0.88 ? 'B' : null);
    const hfLike = (X) => {
      const tt = X.text.trim(), z = zoneOf(X);
      return PAGE_NUM.test(tt) || PAGE_WORD.test(tt) || (!!z && nPages >= 2 && (zoneCount.get(z + hfKey(tt)) || 0) >= minRepeat);
    };
    const lines = p.seq.filter((x) => x.line).map((x) => x.line);
    for (const it of p.seq) {
      if (!it.line) continue;
      const L = it.line;
      const zone = zoneOf(L);
      if (!zone) continue;
      const t = L.text.trim();
      // 쪽 번호는 쪽 맨 바깥 줄이다 — 그보다 바깥에 본문 줄이 있으면 그래프 눈금·표 숫자(-33 같은)다
      if (PAGE_NUM.test(t) || PAGE_WORD.test(t)) {
        const outer = lines.some((X) => X !== L && (zone === 'B' ? X.y > L.y + L.size * 0.5 : X.y < L.y - L.size * 0.5) && !hfLike(X));
        if (!outer) L.hf = true;
        continue;
      }
      if (nPages >= 2 && (zoneCount.get(zone + hfKey(t)) || 0) >= minRepeat) L.hf = true;
    }
  });

  // ── 낱말 통계(줄 가운데 낱말) ──
  const stats = new WordStats();
  const spaceGapsAll = [];
  for (const p of pagesA) for (const it of p.seq) {
    if (it.line && !it.line.hf) { stats.addLine(it.line.text); spaceGapsAll.push(...it.line.spaceGaps); }
    if (it.table) for (const c of it.table.cells) for (const r of c.runs) stats.addLine(r.s);
  }
  const normalSpace = median(spaceGapsAll) || 0.3;
  // 줄 첫머리 한글 차례 글자(가. 나. …) — '다.'가 목록인지 문장 끝인지 가리는 데 쓴다
  const enums = new Set();
  for (const p of pagesA) for (const it of p.seq) if (it.line && !it.line.hf) { const e = hangulEnum(it.line.text); if (e) enums.add(e); }
  const listStart = (t) => isListStart(t, enums);

  // ── 문단 묶기 ──
  const blocks = [];
  const joinItems = [];
  const xsForLevel = [];
  pagesA.forEach((p, pi) => {
    const pg = pi + 1;
    const items = p.seq;
    // 단(영역)별 오른쪽 끝·줄 간격
    const colRight = new Map();
    const colLeft = new Map();
    for (const it of items) if (it.line && !it.line.hf && !it.line.tabbed) {
      const key = it.colBox;
      colRight.set(key, Math.max(colRight.get(key) || 0, it.line.x1));
      colLeft.set(key, Math.min(colLeft.get(key) ?? Infinity, it.line.x0));
    }
    const pitches = [];
    let prevL = null;
    for (const it of items) {
      if (!it.line || it.line.hf) { prevL = null; continue; }
      if (prevL && prevL.colBox === it.colBox) {
        const dy = it.line.y - prevL.line.y;
        if (dy > 0 && Math.abs(it.line.size - prevL.line.size) < 0.5) pitches.push(dy / it.line.size);
      }
      prevL = it;
    }
    const pitch = median(pitches) || 1.6;
    // 줄 바로 오른쪽(같은 단 안)에 그림·도형이 있으면 줄은 그 앞에서 끝난다(글이 상자를 비켜 감)
    for (const it of items) if (it.line && !it.line.hf && p.shapes && p.shapes.length) {
      const L = it.line;
      const right = colRight.get(it.colBox) || L.x1;
      // 상자를 비켜 가는 본문 줄은 단 너비의 절반은 넘는다(서명 옆 도장처럼 짧은 줄 옆 그림은 아니다)
      if (L.x1 - L.x0 < (right - (colLeft.get(it.colBox) ?? L.x0)) * 0.5) continue;
      let lim = Infinity;
      for (const s of p.shapes) {
        // 글은 상자 둘레에 여백을 두고 비켜 가므로 위아래로 글자 0.6개 높이만큼 넓혀 본다
        if (s.y0 < L.bot + L.size * 0.6 && s.y1 > L.top - L.size * 0.6 && s.x0 >= L.x1 - 0.5 && s.x0 < right - L.size && s.x0 < lim) lim = s.x0;
      }
      if (lim < Infinity) L.wrapRight = lim - L.size * 0.5;
      // 왼쪽: 단 안쪽에 들어온 그림(둥글게 오린 사진 등)을 비켜 줄 첫머리가 들쭉날쭉한 줄
      const left = colLeft.get(it.colBox) ?? L.x0;
      for (const s of p.shapes) {
        if (s.y0 < L.bot + L.size * 0.6 && s.y1 > L.top - L.size * 0.6 && s.x0 < L.x0 - 1 && s.x1 > left + L.size && s.x1 > L.x0 - L.size * 3 && s.x1 < L.x0 + L.size * 3) { L.wrapLeft = true; break; }
      }
    }
    // 단마다 본문 첫 줄 위(큰 글 제외)·마지막 줄 아래 — 단 넘김 잇기에 쓴다
    const colTop = new Map(), colBot = new Map();
    for (const it of items) if (it.line && !it.line.hf) {
      const key = it.colBox;
      colBot.set(key, Math.max(colBot.get(key) ?? -Infinity, it.line.bot));
      if (it.line.size < p.size * 1.15) colTop.set(key, Math.min(colTop.get(key) ?? Infinity, it.line.top));
    }

    let P = null;
    const flush = () => {
      if (!P) return;
      // 첫 줄들만 크게 들어간 문단(옆의 상자·그림을 비켜 간 줄): 뒤 줄이 단 왼쪽에 붙어 있으면 들여쓰기가 아니다
      const b = P.block, L0 = P.lines[0];
      if (b._x != null && b._x > L0.size * 2.5 && P.lines.some((l) => l.x0 - P.left < l.size * 0.5)) b._x = null;
      blocks.push(b);
      P = null;
      // 문단 옆에 붙어 있던 '관련기사' 안내는 문단이 끝난 뒤에
      for (const n of notes) blocks.push({ t: 'p', segs: [{ s: n, pg }], joins: '', lvl: 0, kind: 'note', gap: 0 });
      notes.length = 0;
    };
    const notes = [];
    let prev = null;
    for (const it of items) {
      if (it.table) {
        flush();
        blocks.push(tableBlock(it.table, pg, p.spaces));
        prev = null;
        continue;
      }
      const L = it.line;
      if (L.hf) { flush(); blocks.push({ t: 'p', segs: [{ s: L.text, pg }], joins: '', lvl: 0, kind: 'hf', gap: 0 }); continue; }
      if (it.note) { if (P) notes.push(L.text); else blocks.push({ t: 'p', segs: [{ s: L.text, pg }], joins: '', lvl: 0, kind: 'note', gap: 0 }); continue; }
      const right = colRight.get(it.colBox) || L.x1;
      const left = colLeft.get(it.colBox) ?? L.x0;
      let cont = false;
      let gap = 0;
      if (P && prev) {
        const A = prev.line;
        const dy = L.y - A.y;
        const lead = pitch * L.size;
        cont = shouldContinue(A, L, P, { right, left, lead, dy, sameCol: prev.colBox === it.colBox, normalSpace, listStart, body: p.size });
        if (!cont && dy > lead * 1.7) gap = 1;
      } else if (prev === null && blocks.length) {
        gap = 1;
      }
      if (cont) {
        const A = prev.line;
        const hint = wrapHint(A, rightOf(A, right), normalSpace);
        // 큰 글(제목·부제)은 낱말 단위로 줄을 바꾼다
        const r = joinScore(A.text, L.text, stats, { space: A.trailSpace && hint !== 'char', wrap: A.size >= p.size * 1.15 ? 'word' : hint, enums });
        const it2 = { score: r.score, ling: r.ling, korean: r.korean, hint, a: A.text.slice(-10), b: L.text.slice(0, 10), code: r.code === 'H' ? 'S' : r.code, set: (c) => { it2.code = c; } };
        joinItems.push(it2);
        P.joinRefs.push(it2);
        P.block.segs.push({ s: L.text, pg });
        P.lines.push(L);
      } else {
        flush();
        // 가운데 맞춘 줄(제목 등)은 들여쓰기로 치지 않는다
        const ls = L.x0 - left, rs = right - L.x1;
        const centered = ls > L.size * 1.5 && Math.abs(ls - rs) < Math.max(L.size * 1.6, (right - left) * 0.04);
        // 칸 나눔 줄(탭)·칸 너비 1/4보다 오른쪽에서 시작하는 줄은 '위치'이지 들여쓰기 단계가 아니다
        const x = centered || L.tabbed || L.x0 - left > (right - left) * 0.25 ? null : L.x0 - left;
        if (x != null) xsForLevel.push(x);
        P = { lines: [L], joinRefs: [], left, right, colBox: it.colBox, colTop: colTop.get(it.colBox), colBot: colBot.get(it.colBox), block:{ t: 'p', segs: [{ s: L.text, pg }], joins: '', lvl: 0, kind: L.tabbed ? 'tab' : centered ? 'center' : '', gap, _x: x } };
        P.block._P = P;
      }
      prev = it;
    }
    flush();
    // 기울어진 글(도장·세로 글씨)은 쪽 끝에
    for (const r of p.rotated) if (r.s.length > 1) blocks.push({ t: 'p', segs: [{ s: r.s, pg }], joins: '', lvl: 0, kind: 'rot', gap: 1 });
    if (onProgress) onProgress((pi + 1) / nPages);
  });

  // ── 쪽(또는 단)을 넘는 문단 잇기 표시 ──
  // 단: 앞 문단이 제 단 맨 아래에서 끝나고, 이 문단이 오른쪽 단 맨 위에서 시작할 때만(신문·논문의 단 넘김)
  const colTurn = (Pa, A, Pb, B) => {
    const ca = Pa.colBox, cb = Pb.colBox;
    if (!ca || !cb || ca === cb) return false;
    if (Pa.colBot == null || Pb.colTop == null) return false;
    return Pa.colBot - A.bot < A.size * 1.5 && B.top - Pb.colTop < B.size * 1.5 && B.top < A.top - A.size && cb.x0 > ca.x0 + A.size;
  };
  let lastBody = null;
  for (const b of blocks) {
    if (b.t !== 'p' || b.kind === 'hf') continue;
    const turn = lastBody && lastBody._P && b._P && (b.segs[0].pg !== lastBody.segs[lastBody.segs.length - 1].pg ||
      colTurn(lastBody._P, lastBody._P.lines[lastBody._P.lines.length - 1], b._P, b._P.lines[0]));
    if (turn) {
      const A = lastBody._P.lines[lastBody._P.lines.length - 1];
      const B = b._P.lines[0];
      const full = rightOf(A, lastBody._P.right) - A.x1 < Math.max(A.charW * 1.5, A.size);
      const ended = /[.!?。」』”’)\]다요]$/.test(A.text.trim());
      const indented = B.x0 - b._P.left > B.size * 0.7;
      if (full && !ended && !indented && !listStart(B.text) && !A.tabbed && !B.tabbed && Math.abs(A.size - B.size) < 0.6) {
        const r = joinScore(A.text, B.text, stats, { wrap: wrapHint(A, rightOf(A, lastBody._P.right), normalSpace), enums });
        if (r.code !== 'H') {
          b.cont = true;
          const it2 = { score: r.score, ling: r.ling, korean: r.korean, code: r.code, set: (c) => { it2.code = c; b.contJoin = c; } };
          b.contJoin = r.code;
          joinItems.push(it2);
        }
      }
    }
    lastBody = b;
  }

  settleJoins(joinItems);
  const toLevel = levelize(xsForLevel, 4);
  for (const b of blocks) {
    if (b._P) {
      b.joins = b._P.joinRefs.map((j) => j.code).join('');
      if (b._x != null) b.lvl = toLevel(b._x);
    }
    delete b._P; delete b._x;
  }
  // 줄 잇기 결과의 하이픈 지우기(영어 낱말 끊김): 앞 조각 끝 '-' 를 빼고 붙인다
  for (const b of blocks) {
    if (b.t !== 'p' || !b.joins.includes('D')) continue;
    let j = '';
    for (let i = 0; i < b.joins.length; i++) {
      if (b.joins[i] === 'D') { b.segs[i].s = b.segs[i].s.replace(/-$/, ''); j += 'N'; } else j += b.joins[i];
    }
    b.joins = j;
  }
  return { blocks, stats };
}

// 줄의 오른쪽 끝(옆에 그림·상자가 있으면 그 앞)
function rightOf(L, right) {
  return L.wrapRight != null ? Math.min(right, Math.max(L.x1, L.wrapRight)) : right;
}

// 줄이 낱말 단위로 넘어갔나(오른쪽이 비었거나 낱말 사이가 늘어남) 글자 단위로 넘어갔나
// (글자 단위로 넘어가면 줄이 늘 끝까지 찬다. 한 글자 넘게 비었으면 낱말 단위로 넘어간 것)
function wrapHint(A, right, normalSpace) {
  const slack = right - A.x1;
  if (slack > A.charW * 1.2) return 'word';
  const g = A.spaceGaps.length >= 2 ? median(A.spaceGaps) : null;
  if (g != null && g > normalSpace * 1.5 && g > 0.45) return 'word';
  return null;
}

// 앞 줄 A 다음 줄 L 이 같은 문단인가
function shouldContinue(A, L, P, { right, left, lead, dy, sameCol, normalSpace, listStart = isListStart, body = 0 }) {
  if (!sameCol) return false;
  if (A.tabbed || L.tabbed) return false;
  if (listStart(L.text)) return false;
  // 문답(인터뷰): '―'로 시작하는 대답 줄은 앞 줄이 문장부호로 끝났거나 문단이 ▶·■ 같은 표로 시작했으면 새 문단
  if (/^[―—]/.test(L.text) && (/[.?!”’"]$/.test(A.text.trim()) || /^[▶►■◆●□◇○]/.test(P.lines[0].text))) return false;
  // 큰 글(제목·부제·인용구): 줄이 끝까지 찬 경우에만 잇는다(줄마다 따로 쓴 문구가 많다)
  // (영문 제목이 줄을 넘긴 것은 예외: 앞 줄이 글자·쉼표로 끝나고 다음 줄이 소문자로 시작)
  if (body && A.size >= body * 1.15 && right - A.x1 > A.size && !(/[A-Za-z,’')]$/.test(A.text) && /^[a-z]/.test(L.text))) return false;
  if (dy <= L.size * 0.3) return false;
  if (dy > lead * 1.45) return false;
  if (Math.abs(A.size - L.size) > Math.max(A.size, L.size) * 0.2) return false;
  const width = right - left;
  // 가운데 맞춘 제목 두 줄
  const centered = (X) => { const ls = X.x0 - left, rs = right - X.x1; return ls > X.size * 1.5 && Math.abs(ls - rs) < X.size * 1.6; };
  if (centered(A) && centered(L)) return A.x1 - A.x0 > width * 0.4;
  // 앞 줄이 일찍 끝났으면(다음 낱말이 들어갈 자리가 있었으면) 문단 끝
  const slack = rightOf(A, right) - A.x1;
  if (slack > Math.max(L.firstWordW * 1.15 + A.size * 0.8, A.size * 1.6)) return false;
  // 들여쓰기 맞춤
  const tol = Math.max(L.size * 0.7, 3);
  // 그림을 비켜 첫머리가 들쭉날쭉한 줄끼리는 첫머리를 견주지 않는다
  if ((A.wrapLeft || L.wrapLeft) && P.lines.length >= 1) return true;
  if (P.lines.length >= 2) {
    const contX = P.lines[1].x0;
    return Math.abs(L.x0 - contX) <= tol;
  }
  if (Math.abs(L.x0 - A.x0) <= tol) return true;
  if (A.hangX != null && Math.abs(L.x0 - A.hangX) <= tol * 1.3) return true;
  if (A.x0 - L.x0 > tol && A.x0 - L.x0 < A.size * 4.5) return true; // 첫 줄 들여쓰기 문단
  if (L.x0 > A.x0 && L.x0 - A.x0 < A.size * 3 && A.hangX == null && /^[\S]{1,3}\s/.test(A.text)) return true; // 글머리표 뒤 맞춤(추정)
  return false;
}

// 표 블록: 칸마다 줄을 만들고 문단으로 잇는다
function tableBlock(t, pg, spaces) {
  const rows = Array.from({ length: t.nr }, () => new Array(t.nc).fill(null));
  for (const c of t.cells) {
    const frags = buildLines(c.runs, spaces);
    frags.sort((a, b) => a.y - b.y || a.x0 - b.x0);
    // 칸 안: 같은 높이 조각은 한 줄, 줄끼리는 단순 문단 잇기(칸이 좁아 생긴 줄바꿈은 잇는다)
    const lines = [];
    for (const f of frags) {
      const L = lines.find((x) => Math.abs(x.y - f.y) < f.size * 0.45);
      if (L) { L.frags.push(f); L.x1 = Math.max(L.x1, f.x1); } else lines.push({ y: f.y, size: f.size, x0: f.x0, x1: f.x1, frags: [f] });
    }
    let s = '';
    let prev = null;
    for (const L of lines) {
      L.frags.sort((a, b) => a.x0 - b.x0);
      const text = L.frags.map((f) => f.text).join(' ');
      if (prev) {
        const full = c.x1 - prev.x1 < Math.max(prev.size * 2.2, (L.frags[0].firstWordW || 0) + prev.size);
        const dy = L.y - prev.y;
        if (full && !isListStart(text) && dy < prev.size * 2.2) s += '\u2028' + text; // 판단은 나중에(resolveSoftBreaks)
        else s += '\n' + text;
      } else s = text;
      prev = L;
    }
    rows[c.r][c.c] = { s, cs: c.cs, rs: c.rs };
  }
  return { t: 'tbl', rows, pg, gap: 1 };
}
