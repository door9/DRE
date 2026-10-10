// 쪽 맞춤 — 한글·워드 문서를 직접 읽은 모델(구조가 정확)의 쪽 번호를, DRE.exe가 만든 PDF(쪽이 정확)의 쪽마다 글과 대조해 맞춘다.
// 문단 글의 앞부분을 PDF 글 흐름에서 앞으로만 찾아 나가고, 쪽 경계를 넘는 문단은 그 자리에서 나눈다.

// 견줄 때 빼는 글자: 공백·보이지 않는 글자, 그리고 괄호·대괄호·글머리표(•) — 뽑은 글에는 '(원어)'·'[1]' 처럼 붙인 것이 있고
// PDF 에는 없을 수 있다(전자책 원어 위첨자·각주 번호). 양쪽 다 같이 빼므로 맞춤에는 해가 없다
const SQUASH = /[\s\u3000\u200b\u2028\ue000-\uf8ff\u00ad()[\]\uff08\uff09\uff3b\uff3d\u2022]/;
// 첨자 숫자(², ₂)는 보통 숫자로 — PDF 에는 보통 숫자로 찍힌다
const SCRIPT_DIGIT = '0123456789'.split('').reduce((m, d, i) => { m[String.fromCharCode([0x2070, 0xb9, 0xb2, 0xb3, 0x2074, 0x2075, 0x2076, 0x2077, 0x2078, 0x2079][i])] = d; m[String.fromCharCode(0x2080 + i)] = d; return m; }, {});

// 공백·보이지 않는 글자를 뺀 글과, 그 글자마다 원래 위치
function squashMap(s) {
  let out = '';
  const idx = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (SQUASH.test(ch)) continue;
    out += SCRIPT_DIGIT[ch] || ch;
    idx.push(i);
  }
  return { sq: out, idx };
}

export function alignPages(doc, texts) {
  if (!texts || !texts.length) return { matched: 0, total: 0 };
  const starts = [];
  let stream = '';
  for (const t of texts) { starts.push(stream.length); stream += squashMap(t).sq; }
  const pageAt = (pos) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= pos) lo = m; else hi = m - 1; }
    return lo + 1;
  };
  let ptr = 0;
  let matched = 0, total = 0;
  // 문단 첫머리를 PDF 글 흐름에서 앞으로 찾는다. 짧은 조각일수록 가까운 곳에서만 받아들인다 — 짧은 조각이 한참 뒤 엉뚱한 곳에 걸리면
  // 자리가 거기로 뛰어 그 뒤 문단을 하나도 못 찾는다(큰 문서에서 실측: 한글 027번 1%, 전자책 4%).
  // 긴 조각은 조금 앞질렀을 때를 위해 자리보다 조금 앞에서부터도 찾는다
  const WINDOW = { 16: 60000, 8: 6000, 5: 1500 };
  const find = (sq) => {
    for (const n of [16, 8, 5]) {
      if (sq.length < Math.min(n, 3)) continue;
      const key = sq.slice(0, Math.min(n, sq.length));
      const win = key.length >= 12 ? WINDOW[16] : key.length >= 7 ? WINDOW[8] : WINDOW[5];
      const pos = stream.indexOf(key, ptr);
      if (pos >= 0 && pos - ptr < win) return pos;
      if (key.length >= 12) {
        const back = stream.indexOf(key, Math.max(0, ptr - 5000));
        if (back >= 0 && back < ptr) return back;
      }
    }
    return -1;
  };

  const out = [];
  for (const b of doc.blocks) {
    if (b.t === 'tbl') {
      // 줄마다 쪽을 찾고, 쪽이 바뀌면 표를 나눈다
      let cur = null;
      for (const row of b.rows) {
        const rowText = row.filter(Boolean).map((c) => c.s).join('');
        const { sq } = squashMap(rowText);
        let pg = cur ? cur.pg : pageAt(ptr);
        if (sq.length >= 2) {
          total++;
          const pos = find(sq);
          if (pos >= 0) { matched++; pg = pageAt(pos); ptr = pos + Math.min(sq.length, 4); }
        }
        if (!cur || cur.pg !== pg) { cur = { t: 'tbl', rows: [], pg, gap: cur ? 0 : b.gap, cont: !!cur }; out.push(cur); }
        cur.rows.push(row);
      }
      continue;
    }
    if (b.t !== 'p') { out.push(b); continue; }
    const full = b.segs.map((s) => s.s).join('');
    const { sq, idx } = squashMap(full);
    if (sq.length < 2) { out.push({ ...b, segs: [{ s: full, pg: pageAt(ptr) }], joins: '' }); continue; }
    total++;
    const pos = find(sq);
    if (pos < 0) { out.push({ ...b, segs: [{ s: full, pg: pageAt(ptr) }], joins: '' }); continue; }
    matched++;
    // 쪽 경계에서 나눌 자리
    const cuts = [];
    for (const st of starts) if (st > pos && st < pos + sq.length) cuts.push(st - pos);
    const segs = [];
    let prev = 0;
    for (const c of cuts) {
      const at = idx[c];
      segs.push({ s: full.slice(prev, at), pg: pageAt(pos + (segs.length ? cuts[segs.length - 1] : 0)) });
      prev = at;
    }
    segs.push({ s: full.slice(prev), pg: pageAt(pos + (cuts.length ? cuts[cuts.length - 1] : 0)) });
    out.push({ ...b, segs: segs.filter((s) => s.s), joins: 'G'.repeat(Math.max(0, segs.filter((s) => s.s).length - 1)) });
    // 다음 찾기는 이 문단 끝 조금 앞에서(뽑은 글과 PDF 글의 길이가 조금 다를 수 있다 — 쪽 번호·자동 번호·각주 표시)
    ptr = Math.max(ptr, pos + Math.max(1, Math.floor(sq.length * 0.85)));
  }
  doc.blocks = out;
  doc.pages = texts.length;
  doc.pageExact = total ? matched / total >= 0.8 : true;
  return { matched, total };
}
