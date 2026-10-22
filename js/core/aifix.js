// AI 교정 — 문자 인식으로 읽은 쪽의 글을 줄 목록으로 꺼내고(DRE.exe 가 이 PC 의 Claude 에게 쪽 그림과 함께 보낸다), 받은 고치기를 문서 모델에 입힌다.
// 줄 = 문단 조각(segs — 인식기가 읽은 한 줄) 또는 표 칸 안의 한 줄. 고치기 { line, from, to } 는 from 이 그 줄에 그대로 있을 때만 그 자리를 바꾼다.
// 2026-10-22 정답 있는 가짜 스캔 16개 문서로 잼(web-tests/tools/ai_ocr_vision_try.mjs): 깨끗한 스캔 줄 정확 33.5→50.1%·글자 정밀 95.0→97.5%,
// 거친 스캔 29.0→42.0%·93.9→97.2%. 글자가 든 보통 PDF 의 줄 잇기는 AI 가 DRE 보다 못해(93.3 대 86.6%) 보내지 않는다.

const GROW = 24; // 고친 글이 원래보다 이만큼 넘게 길어지면 받지 않는다(그림에 없는 줄을 지어 넣기 막이)

// 줄 속 보이지 않는 글자를 화면에 보이는 대로: 줄 잇기 판단 표시(\ue010 띄워 잇기 → 빈칸, \ue011 붙여 잇기 → 없음), 남은 줄 구분(\u2028 → 빈칸),
// 그 밖 사용자 정의 영역·폭 없는 빈칸 → 없음. AI 에겐 보이는 글을 보내고(안 그러면 보이는 글로 돌려준 from 이 원래 글과 안 맞는다 — 017번 실측),
// 고칠 땐 map(보이는 글자 → 원래 글자 자리)으로 원래 자리를 되짚는다
function visible(s) {
  let out = '';
  const map = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let v = c;
    if (c === '\ue010' || c === '\u2028') v = ' ';
    else if (c === '\u200b' || (c >= '\ue000' && c <= '\uf8ff')) v = '';
    for (let j = 0; j < v.length; j++) { out += v[j]; map.push(i); }
  }
  return { out, map };
}

// 쪽 pg 의 줄 목록: [{ text(보이는 글), pg, ref }] — ref 는 입힐 자리({ b, i } 문단 조각 | { b, r, c, k } 표 칸의 k째 줄)
export function pageLines(doc, pg) {
  const out = [];
  const add = (raw, ref) => { const text = visible(raw).out; if (text.trim()) out.push({ text, pg, ref }); };
  doc.blocks.forEach((b, bi) => {
    if (b.t === 'p') {
      b.segs.forEach((s, i) => { if (s.pg === pg) add(s.s, { b: bi, i }); });
    } else if (b.t === 'tbl' && b.pg === pg) {
      b.rows.forEach((row, r) => row.forEach((cell, c) => {
        if (!cell || !cell.s) return;
        cell.s.split('\n').forEach((t, k) => add(t, { b: bi, r, c, k }));
      }));
    }
  });
  return out;
}

// AI 에게 보낼 글: '줄번호: 내용'
export function linesText(lines) {
  return lines.map((l, i) => `${i + 1}: ${l.text}`).join('\n');
}

function getText(doc, ref) {
  const b = doc.blocks[ref.b];
  if (ref.i != null) return b.segs[ref.i].s;
  return b.rows[ref.r][ref.c].s.split('\n')[ref.k];
}

function setText(doc, ref, s) {
  const b = doc.blocks[ref.b];
  if (ref.i != null) { b.segs[ref.i].s = s; return; }
  const cell = b.rows[ref.r][ref.c];
  const parts = cell.s.split('\n');
  parts[ref.k] = s;
  cell.s = parts.join('\n');
}

// groups: [{ lines, edits }] (쪽마다). doc 을 고친다(부르는 쪽이 사본을 넘긴다) → { fixes: [{ pg, from, to }], rejected, skipped: [{ line, from, to, why }] }
export function applyFixes(doc, groups) {
  const fixes = [];
  const skipped = [];
  const emptied = [];
  for (const { lines, edits } of groups) {
    for (const e of edits || []) {
      const L = lines[((e && e.line) | 0) - 1];
      const from = e && typeof e.from === 'string' ? e.from : '';
      const to = e && typeof e.to === 'string' ? e.to : '';
      const skip = (why) => skipped.push({ line: e && e.line, from, to, why, text: L ? visible(getText(doc, L.ref)).out : null });
      if (!L) { skip('줄 없음'); continue; }
      if (!from || from === to) { skip('바뀐 것 없음'); continue; }
      if (/[\r\n\t]/.test(to) || to.length > from.length + GROW) { skip('너무 김'); continue; }
      const cur = getText(doc, L.ref);
      const { out: vis, map } = visible(cur);
      const k = vis.indexOf(from);
      if (k < 0) { skip('그 줄에 없음'); continue; }
      // 보이는 글의 [k, k+길이) → 원래 글 자리. 앞뒤 바깥의 숨은 표시는 그대로 두고, 고친 곳 안의 것만 바뀐다
      const start = map[k], end = map[k + from.length - 1] + 1;
      const next = cur.slice(0, start) + to + cur.slice(end);
      setText(doc, L.ref, next);
      if (!visible(next).out.trim()) emptied.push(L.ref);
      fixes.push({ pg: L.pg, from, to });
    }
  }
  tidy(doc, emptied);
  return { fixes, rejected: skipped.length, skipped };
}

// 고쳐서 빈 줄이 된 것(잡티 줄)을 지운다 — 문단 조각은 이음 기호도 함께, 조각이 다 없어진 문단은 통째로. 자리가 밀리지 않게 뒤에서부터
function tidy(doc, emptied) {
  if (!emptied.length) return;
  const segDrop = new Map(); // 블록 → 지울 조각 번호들
  const cellDrop = new Map(); // 'b,r,c' → 지울 줄 번호들
  for (const ref of emptied) {
    if (ref.i != null) {
      if (!segDrop.has(ref.b)) segDrop.set(ref.b, new Set());
      segDrop.get(ref.b).add(ref.i);
    } else {
      const key = `${ref.b},${ref.r},${ref.c}`;
      if (!cellDrop.has(key)) cellDrop.set(key, new Set());
      cellDrop.get(key).add(ref.k);
    }
  }
  for (const [key, ks] of cellDrop) {
    const [b, r, c] = key.split(',').map(Number);
    const cell = doc.blocks[b].rows[r][c];
    cell.s = cell.s.split('\n').filter((t, k) => !ks.has(k)).join('\n');
  }
  const dropBlocks = [];
  for (const [bi, is] of segDrop) {
    const b = doc.blocks[bi];
    const order = [...is].sort((x, y) => y - x);
    let joins = b.joins || '';
    for (const i of order) {
      b.segs.splice(i, 1);
      // 조각 i 를 빼면 그 앞 이음(i-1)을, 첫 조각이면 바로 뒤 이음(0)을 뺀다
      const j = i > 0 ? i - 1 : 0;
      if (joins.length > j) joins = joins.slice(0, j) + joins.slice(j + 1);
    }
    b.joins = joins;
    if (!b.segs.length) dropBlocks.push(bi);
  }
  for (const bi of dropBlocks.sort((x, y) => y - x)) doc.blocks.splice(bi, 1);
}
