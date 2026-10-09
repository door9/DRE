// 슬라이드 → 문서 모델 — 파워포인트(PPTX·PPT)·ODP 공용.
// 해석기는 슬라이드마다 { hidden, shapes } 를 넘긴다.
//   shape: { x, y, w, h, role, paras, table }
//     role: 'title' | 'hf'(바닥글·날짜·쪽 번호) | ''      paras: [{ s, lvl, bullet }]   table: [[{ s, cs, rs } | null]] | null
// 숨긴 슬라이드는 뺀다(파워포인트가 PDF로 내보낼 때처럼). 슬라이드 하나가 한 쪽이다.
// 읽는 순서: 제목 → 위에서 아래로, 같은 높이(줄)면 왼쪽에서 오른쪽으로 → 바닥글.

export function slidesToModel(format, slides) {
  const blocks = [];
  const warnings = [];
  let pg = 0, hidden = 0;
  for (const sl of slides) {
    if (sl.hidden) { hidden++; continue; }
    pg++;
    const shapes = (sl.shapes || []).filter((s) => (s.paras && s.paras.some((p) => p.s.trim())) || (s.table && s.table.length));
    let firstOfSlide = true;
    for (const sh of readingOrder(shapes)) {
      let first = true;
      if (sh.table) {
        blocks.push({ t: 'tbl', rows: sh.table, pg, gap: 1 });
        firstOfSlide = false;
        continue;
      }
      let gapNext = 0;
      for (const p of sh.paras) {
        const s = p.s.replace(/[ \t]+$/, '');
        if (!s.trim()) { if (!first) gapNext = 1; continue; }
        const label = p.bullet ? p.bullet + ' ' : '';
        blocks.push({
          t: 'p', segs: [{ s: label + s.replace(/^[ \t]+/, ''), pg }], joins: '',
          lvl: Math.max(0, Math.min(8, p.lvl || 0)),
          kind: sh.role === 'hf' ? 'hf' : sh.role === 'title' ? 'h' : label ? 'li' : '',
          gap: first || gapNext ? 1 : 0,
        });
        first = false;
        gapNext = 0;
        firstOfSlide = false;
      }
    }
  }
  if (hidden) warnings.push(`숨긴 슬라이드 ${hidden}장은 뺐습니다.`);
  return { format, pages: Math.max(1, pg), pageExact: true, blocks, notes: [], warnings };
}

// 도형 읽는 순서
export function readingOrder(shapes) {
  const titles = shapes.filter((s) => s.role === 'title');
  const hf = shapes.filter((s) => s.role === 'hf');
  const rest = shapes.filter((s) => s.role !== 'title' && s.role !== 'hf');
  const byPos = (arr) => {
    const a = arr.map((s, i) => ({ s, i, x: num(s.x), y: num(s.y), h: Math.max(1, num(s.h)) }));
    a.sort((p, q) => p.y - q.y || p.x - q.x || p.i - q.i);
    // 같은 줄: 윗변 차이가 작으면(10pt 또는 낮은 쪽 높이의 30%) 한 줄로 보고 왼쪽부터
    const rows = [];
    for (const e of a) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(e.y - row[0].y) <= Math.max(10, 0.3 * Math.min(e.h, row[0].h))) row.push(e);
      else rows.push([e]);
    }
    return rows.flatMap((r) => r.sort((p, q) => p.x - q.x || p.i - q.i)).map((e) => e.s);
  };
  return [...byPos(titles), ...byPos(rest), ...byPos(hf)];
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

// 자동 번호 글머리(파워포인트 buAutoNum·ODP 번호 목록 공용): 종류 이름과 번호 → 글
export function autoNumber(type, n) {
  const roman = (k) => { const t = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]; let s = ''; for (const [v, r] of t) while (k >= v) { s += r; k -= v; } return s; };
  const alpha = (k) => String.fromCharCode(65 + ((k - 1) % 26)).repeat(Math.floor((k - 1) / 26) + 1);
  const t = String(type || 'arabicPeriod');
  let core;
  if (/^alphaLc/.test(t)) core = alpha(n).toLowerCase();
  else if (/^alphaUc/.test(t)) core = alpha(n);
  else if (/^romanLc/.test(t)) core = roman(n).toLowerCase();
  else if (/^romanUc/.test(t)) core = roman(n);
  else if (/^circleNum/.test(t)) return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `(${n})`;
  else if (/^ea1|^hebrew|^arabicDb/.test(t)) core = String(n);
  else core = String(n);
  if (/ParenBoth$/.test(t)) return `(${core})`;
  if (/ParenR$/.test(t)) return `${core})`;
  if (/Period$/.test(t)) return `${core}.`;
  if (/Minus$/.test(t)) return `- ${core} -`;
  return core;
}
