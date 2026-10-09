// 시트 → 문서 모델 — 엑셀(XLSX·XLS)·ODS 공용.
// 해석기는 시트마다 { name, hidden, cells, merges, hiddenRows, hiddenCols, extras } 를 넘긴다.
//   cells: Map(행 번호 → Map(열 번호 → 화면 글))  (번호는 0부터)
//   merges: [{ r0, c0, r1, c1 }] (끝 포함), hiddenRows·hiddenCols: Set, extras: 글상자 글 [문자열]
// 숨긴 시트·행·열은 뺀다(엑셀이 인쇄·PDF로 내보낼 때처럼). 시트 하나가 한 '쪽'이다(쪽 고르기는 시트 단위).

export const MAX_CELLS = 400000; // 이보다 크면 앞부분만(메모리)
const MAX_WIDTH = 1000;          // 처음~끝 열이 이보다 넓으면 빈 열은 뺀다(먼 열의 칸 하나가 모든 행을 넓히지 않게)

export function sheetsToModel(format, sheets) {
  const blocks = [];
  const warnings = [];
  let hidden = 0, pg = 0, total = 0, cut = false;
  const shown = sheets.filter((s) => {
    if (s.hidden) { if (hasContent(s)) hidden++; return false; }
    return hasContent(s);
  });
  for (const sh of shown) {
    pg++;
    if (shown.length > 1) blocks.push({ t: 'p', segs: [{ s: sh.name, pg }], joins: '', lvl: 0, kind: 'h', gap: blocks.length ? 1 : 0 });
    const rows = denseRows(sh, MAX_CELLS - total);
    total += rows.count;
    if (rows.cut) cut = true;
    if (rows.rows.length) blocks.push({ t: 'tbl', rows: rows.rows, pg, gap: 1 });
    let first = true;
    for (const t of sh.extras || []) {
      for (const line of String(t).split(/\r\n|[\r\n\u000b]/)) {
        if (!line.trim()) continue;
        blocks.push({ t: 'p', segs: [{ s: line.trim(), pg }], joins: '', lvl: 0, kind: '', gap: first ? 1 : 0 });
        first = false;
      }
    }
    if (cut) break;
  }
  if (hidden) warnings.push(`숨긴 시트 ${hidden}개는 뺐습니다.`);
  if (cut) warnings.push(`표가 너무 커서 앞부분(${total.toLocaleString('ko-KR')}칸)만 뽑았습니다.`);
  return { format, pages: Math.max(1, pg), pageExact: false, sheetPages: true, blocks, notes: [], warnings };
}

function hasContent(s) {
  if (s.extras && s.extras.some((t) => String(t).trim())) return true;
  for (const row of s.cells.values()) for (const v of row.values()) if (v != null && String(v).trim() !== '') return true;
  return false;
}

// 정렬된 배열에서 lo 이상인 첫 자리
function lowerBound(arr, lo) {
  let a = 0, b = arr.length;
  while (a < b) { const m = (a + b) >> 1; if (arr[m] < lo) a = m + 1; else b = m; }
  return a;
}

// 보이는 칸만 모아 빽빽한 표로: 빈 줄은 빼고, 열은 처음~끝 사이를 그대로 둔다(엑셀에 다시 붙여 넣어도 칸이 맞게)
function denseRows(sh, budget) {
  const hr = sh.hiddenRows || new Set(), hc = sh.hiddenCols || new Set();
  let minC = Infinity, maxC = -Infinity;
  const rowNos = [];
  const usedCols = new Set();
  for (const [r, row] of sh.cells) {
    if (hr.has(r)) continue;
    let any = false;
    for (const [c, v] of row) {
      if (hc.has(c) || v == null || String(v).trim() === '') continue;
      any = true;
      usedCols.add(c);
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
    if (any) rowNos.push(r);
  }
  if (!rowNos.length) return { rows: [], count: 0, cut: false };
  rowNos.sort((a, b) => a - b);
  // 열: 처음~끝(숨긴 열 뺌). 너무 넓으면 글이 있는 열만
  let visCols;
  if (maxC - minC + 1 <= MAX_WIDTH) {
    visCols = [];
    for (let c = minC; c <= maxC; c++) if (!hc.has(c)) visCols.push(c);
  } else {
    visCols = [...usedCols].sort((a, b) => a - b);
  }
  const colPos = new Map(visCols.map((c, i) => [c, i]));
  const rowSet = new Set(rowNos);
  // 합친 칸: 왼쪽 위 칸이 보이는 행·열에 있으면 그 칸이 덮는 보이는 행·열 수만큼 넓힌다(보이는 행·열만 돈다)
  const mergeAt = new Map(); // "r,c" → { rs, cs }
  const covered = new Set();
  for (const m of sh.merges || []) {
    if (m.r1 < rowNos[0] || m.r0 > rowNos[rowNos.length - 1] || m.c1 < visCols[0] || m.c0 > visCols[visCols.length - 1]) continue;
    const rs0 = lowerBound(rowNos, m.r0), rs1 = lowerBound(rowNos, m.r1 + 1);
    const cs0 = lowerBound(visCols, m.c0), cs1 = lowerBound(visCols, m.c1 + 1);
    const rs = rs1 - rs0, cs = cs1 - cs0;
    if (rs <= 0 || cs <= 0) continue;
    const r0 = rowNos[rs0], c0 = visCols[cs0];
    if (cs > 1 || rs > 1) mergeAt.set(r0 + ',' + c0, { cs, rs });
    // 덮인 칸(보이는 것만). 아주 큰 합침이라도 보이는 칸 수만큼만 돈다
    if (rs * cs > 1) {
      for (let i = rs0; i < rs1; i++) for (let j = cs0; j < cs1; j++) {
        if (i === rs0 && j === cs0) continue;
        covered.add(rowNos[i] + ',' + visCols[j]);
        if (covered.size > 2 * MAX_CELLS) break;
      }
    }
  }
  const rows = [];
  let count = 0, cut = false;
  for (const r of rowNos) {
    const src = sh.cells.get(r);
    const row = new Array(visCols.length).fill(null);
    visCols.forEach((c, i) => {
      if (covered.has(r + ',' + c)) return;
      const v = src.get(c);
      const s = v == null ? '' : String(v);
      const m = mergeAt.get(r + ',' + c);
      if (!s && !m) return;
      row[i] = m ? { s, cs: m.cs, rs: m.rs } : { s, cs: 1, rs: 1 };
      if (s) count++;
    });
    rows.push(row);
    if (count >= budget) { cut = true; break; }
  }
  return { rows, count, cut };
}

// 'A1' 꼴 칸 이름 → { r, c }(0부터)
export function cellRef(ref) {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref || '');
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: +m[2] - 1, c: c - 1 };
}

// 'A1:C3' → { r0, c0, r1, c1 }
export function rangeRef(ref) {
  const [a, b] = String(ref || '').split(':');
  const p = cellRef(a), q = b ? cellRef(b) : p;
  if (!p || !q) return null;
  return { r0: Math.min(p.r, q.r), c0: Math.min(p.c, q.c), r1: Math.max(p.r, q.r), c1: Math.max(p.c, q.c) };
}
