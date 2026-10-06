// PDF 글 배치 분석 — PDF 쪽마다 흩어진 글자 조각(좌표·크기)과 선(표 테두리)을 받아 문서 모델로 묶는다.
// 순서: ① 선으로 표를 찾아 칸 복원 ② 남은 글자를 줄로 ③ 단(세로 여백)을 갈라 읽는 순서 정하기
//       ④ 줄을 문단으로 묶고 줄 잇기 판단(띄울지 붙일지) ⑤ 머리말·꼬리말·쪽 번호 가려내기 ⑥ 쪽을 넘는 문단 잇기
// pdf.js 에 기대지 않는 순수 계산 — 시험(Node)과 앱(작업 스레드)이 같은 코드를 쓴다.
import { WordStats, joinScore, settleJoins, isListStart } from './joiner.js';
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

// ─────────────────────────────────────────────────────────────
// pdf.js 결과 → 쪽 자료(뷰 좌표: 왼쪽 위가 0, 아래로 갈수록 y 증가)
// ─────────────────────────────────────────────────────────────
export function pageFromPdfjs(textContent, opList, viewport, OPS) {
  const vt = viewport.transform;
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
    const s = it.str;
    if (!horiz) {
      if (s.trim()) rotated.push({ s: s.trim(), x, y, size });
      continue;
    }
    if (!s.trim()) {
      if (s.length && w > 0 && w < size * 4) spaces.push({ x0: x, x1: x + w, y });
      continue;
    }
    items.push({ s, x0: x, x1: x + Math.max(w, 0), y, size, font: it.fontName || '' });
  }
  const rules = opList ? rulesFromOps(opList, vt, OPS) : [];
  return { w: viewport.width, h: viewport.height, items, spaces, rotated, rules };
}

// 그리기 명령에서 가로·세로 선분을 뽑는다(표 테두리 찾기용)
export function rulesFromOps(opList, vt, OPS) {
  const out = [];
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
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
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
  if (H.length < 2 || V.length < 2 || H.length * V.length > 400000) return [];
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
    if (c.h.length < 2 || c.v.length < 2) continue;
    const cluster = (vals) => {
      const s = [...vals].sort((a, b) => a - b);
      const out = [];
      for (const v of s) if (!out.length || v - out[out.length - 1] > 2.5) out.push(v); else out[out.length - 1] = (out[out.length - 1] + v) / 2;
      return out;
    };
    const xs = cluster(c.v.map((s) => s.v));
    const ys = cluster(c.h.map((s) => s.v));
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

export function buildLines(runs, spaces = []) {
  const rs = [...runs].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const lines = [];
  for (const r of rs) {
    let best = null, bestScore = 0;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 8; i--) {
      const L = lines[i];
      const top = Math.max(L.top, runTop(r)), bot = Math.min(L.bot, runBot(r));
      const ov = bot - top;
      const minH = Math.min(L.bot - L.top, runBot(r) - runTop(r));
      if (ov <= 0) continue;
      const score = ov / minH;
      const baseOk = Math.abs(L.y - r.y) <= Math.max(L.size, r.size) * 0.45 || (r.size < L.size * 0.8 && score > 0.5);
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
      if (!cur || gap > Math.max(L.size, r.size) * 2.2) {
        cur = { runs: [r], x0: r.x0, x1: r.x1, y: L.y, size: L.size, top: L.top, bot: L.bot };
        frags.push(cur);
      } else {
        cur.runs.push(r);
        cur.x1 = Math.max(cur.x1, r.x1);
      }
    }
  }
  for (const f of frags) fragText(f, spaces);
  return frags;
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
function columnSplitOk(left, right, size) {
  const lb = bbox(left), rb = bbox(right);
  if (lb.x1 - lb.x0 < size * 5 || rb.x1 - rb.x0 < size * 5) return false;
  const lt = left.filter((e) => !e.table), rt = right.filter((e) => !e.table);
  if (lt.length < 2 || rt.length < 2) return lt.length + rt.length > 0 && (lt.length >= 3 || rt.length >= 3) && (left.some((e) => e.table) || right.some((e) => e.table));
  // 나란한 줄(같은 높이)이 많고 조각들이 짧으면 표 → 나누지 않음
  let aligned = 0;
  for (const a of lt) if (rt.some((b) => Math.abs(a.y - b.y) < size * 0.3)) aligned++;
  const alignRatio = aligned / Math.min(lt.length, rt.length);
  const fillL = median(lt.map((e) => (e.x1 - e.x0) / Math.max(1, lb.x1 - lb.x0)));
  const fillR = median(rt.map((e) => (e.x1 - e.x0) / Math.max(1, rb.x1 - rb.x0)));
  if (alignRatio > 0.6 && (fillL < 0.7 || fillR < 0.7)) return false;
  // 양쪽이 모두 '글줄'다워야 단으로 본다
  if (fillL < 0.45 && fillR < 0.45) return false;
  return true;
}

function xyCut(els, colBox, out, size, depth = 0) {
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
    if (!columnSplitOk(left, right, size)) continue;
    xyCut(left, bbox(left), out, size, depth + 1);
    xyCut(right, bbox(right), out, size, depth + 1);
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
  xyCut(top, colBox, out, size, depth + 1);
  xyCut(bot, colBox, out, size, depth + 1);
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
  const frags = buildLines(free, page.spaces);
  const sizes = frags.flatMap((f) => f.runs.map((r) => r.size));
  const size = median(sizes) || 10;
  const els = frags.map((f) => ({ ...f, frag: f }));
  for (const t of realTables) {
    if (!t.cells.some((c) => c.runs.length)) continue;
    els.push({ table: t, x0: t.x0, x1: t.x1, top: t.y0, bot: t.y1, y: t.y0 });
  }
  const regions = [];
  xyCut(els, bbox(els.length ? els : [{ x0: 0, x1: page.w, top: 0, bot: page.h }]), regions, size);
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
      seq.push({ line: makeLine(g.frags), colBox: reg.colBox });
    }
  }
  return { seq, size, w: page.w, h: page.h, frames, rotated: page.rotated || [] };
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
    for (const it of p.seq) {
      if (!it.line) continue;
      const L = it.line;
      const zone = L.y < p.h * 0.12 ? 'T' : L.y > p.h * 0.88 ? 'B' : null;
      if (!zone) continue;
      const t = L.text.trim();
      if (PAGE_NUM.test(t) || PAGE_WORD.test(t)) { L.hf = true; continue; }
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

    let P = null;
    const flush = () => { if (P) { blocks.push(P.block); P = null; } };
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
      const right = colRight.get(it.colBox) || L.x1;
      const left = colLeft.get(it.colBox) ?? L.x0;
      let cont = false;
      let gap = 0;
      if (P && prev) {
        const A = prev.line;
        const dy = L.y - A.y;
        const lead = pitch * L.size;
        cont = shouldContinue(A, L, P, { right, left, lead, dy, sameCol: prev.colBox === it.colBox, normalSpace });
        if (!cont && dy > lead * 1.7) gap = 1;
      } else if (prev === null && blocks.length) {
        gap = 1;
      }
      if (cont) {
        const A = prev.line;
        const hint = wrapHint(A, right, normalSpace);
        const r = joinScore(A.text, L.text, stats, { space: A.trailSpace && hint !== 'char', wrap: hint });
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
        P = { lines: [L], joinRefs: [], left, right, block: { t: 'p', segs: [{ s: L.text, pg }], joins: '', lvl: 0, kind: L.tabbed ? 'tab' : centered ? 'center' : '', gap, _x: x } };
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
  let lastBody = null;
  for (const b of blocks) {
    if (b.t !== 'p' || b.kind === 'hf') continue;
    if (lastBody && lastBody._P && b._P && b.segs[0].pg !== lastBody.segs[lastBody.segs.length - 1].pg) {
      const A = lastBody._P.lines[lastBody._P.lines.length - 1];
      const B = b._P.lines[0];
      const full = lastBody._P.right - A.x1 < Math.max(A.charW * 1.5, A.size);
      const ended = /[.!?。」』”’)\]다요]$/.test(A.text.trim());
      const indented = B.x0 - b._P.left > B.size * 0.7;
      if (full && !ended && !indented && !isListStart(B.text) && !A.tabbed && !B.tabbed && Math.abs(A.size - B.size) < 0.6) {
        const r = joinScore(A.text, B.text, stats, { wrap: wrapHint(A, lastBody._P.right, normalSpace) });
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
function shouldContinue(A, L, P, { right, left, lead, dy, sameCol, normalSpace }) {
  if (!sameCol) return false;
  if (A.tabbed || L.tabbed) return false;
  if (isListStart(L.text)) return false;
  if (dy <= L.size * 0.3) return false;
  if (dy > lead * 1.45) return false;
  if (Math.abs(A.size - L.size) > Math.max(A.size, L.size) * 0.2) return false;
  const width = right - left;
  // 가운데 맞춘 제목 두 줄
  const centered = (X) => { const ls = X.x0 - left, rs = right - X.x1; return ls > X.size * 1.5 && Math.abs(ls - rs) < X.size * 1.6; };
  if (centered(A) && centered(L)) return A.x1 - A.x0 > width * 0.4;
  // 앞 줄이 일찍 끝났으면(다음 낱말이 들어갈 자리가 있었으면) 문단 끝
  const slack = right - A.x1;
  if (slack > Math.max(L.firstWordW * 1.15 + A.size * 0.8, A.size * 1.6)) return false;
  // 들여쓰기 맞춤
  const tol = Math.max(L.size * 0.7, 3);
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
