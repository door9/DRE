// 문자 인식(OCR) 결과 → PDF 배치 분석(pdflayout.js) 입력.
// 스캔한 쪽·그림은 글자가 없으니, 그림을 회색조로 바꿔 인식기(tesseract)에 넘기고, 돌려받은 낱말(자리·확신도·기준선)을
// PDF 글 조각과 같은 꼴로 바꾼다. 그림에서 긴 가로·세로 선을 찾아 표 선으로 넘겨 스캔한 표도 칸을 살린다.
// 작업 스레드와 Node(시험) 공용 순수 계산.

import { spaceProb } from './joiner.js';

// RGBA → 회색조(0~255)
export function toGray(rgba, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) {
    const a = rgba[i + 3];
    // 투명한 곳은 흰 바탕으로
    const k = a === 255 ? 1 : a / 255;
    g[j] = Math.round((rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) * k + 255 * (1 - k));
  }
  return g;
}

// 회색조 → PNM(P5) 바이트 — 인식기가 압축 풀기 없이 바로 읽는다
export function toPnm(gray, w, h) {
  const head = new TextEncoder().encode(`P5\n${w} ${h}\n255\n`);
  const out = new Uint8Array(head.length + gray.length);
  out.set(head, 0);
  out.set(gray, head.length);
  return out;
}

// PNM(P5) 바이트 → { gray, w, h } (시험용)
export function fromPnm(u8) {
  let pos = 0;
  const tok = () => {
    while (pos < u8.length) {
      const c = u8[pos];
      if (c === 35) { while (pos < u8.length && u8[pos] !== 10) pos++; continue; } // # 주석
      if (c === 32 || c === 9 || c === 10 || c === 13) { pos++; continue; }
      break;
    }
    let s = '';
    while (pos < u8.length && u8[pos] > 32) s += String.fromCharCode(u8[pos++]);
    return s;
  };
  if (tok() !== 'P5') throw new Error('P5 PNM 이 아닙니다');
  const w = +tok(), h = +tok(), max = +tok();
  pos++;
  if (max !== 255) throw new Error('8비트 PNM 만 됩니다');
  return { gray: u8.subarray(pos, pos + w * h), w, h };
}

// 오츠 문턱값(글자와 바탕을 가르는 밝기)
function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i += 3) hist[gray[i]]++;
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
  let sumB = 0, wB = 0, best = 0, th = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; th = i; }
  }
  return Math.min(200, Math.max(60, th));
}

// 그림에서 긴 가로·세로 선(표 테두리) 찾기 → pdflayout 의 선 꼴({ h, y|x, a, b }, 쪽 단위)
// scale: 그림 픽셀 / 쪽 단위. 짧은 획(글자)은 길이 문턱으로 거른다. 두꺼운 띠(칠한 상자)는 선이 아니다.
// 스캔한 종이는 조금씩 기울어 가로선이 계단처럼 여러 픽셀 줄에 나뉘어 찍힌다 → 이웃한 줄의 토막이 끝끼리 닿으면 한 선으로 잇는다.
export function rulesFromGray(gray, w, h, scale) {
  // 표 테두리는 연한 회색으로 찍힌 것이 많다(글자 문턱으로는 안 잡힘) → 종이 바탕보다 조금만 어두워도 선 후보로
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 5) hist[gray[i]]++;
  let bg = 255;
  for (let v = 255, best = -1; v >= 0; v--) if (hist[v] > best) { best = hist[v]; bg = v; }
  const th = Math.max(otsu(gray), Math.min(220, bg - 30));
  const out = [];
  out.shapes = [];
  out.glyphs = [];
  const minH = Math.max(w * 0.03, 30 * scale);  // 가로선: 30pt 이상
  const minV = Math.max(h * 0.012, 16 * scale); // 세로선: 16pt 이상(표 한 줄 높이)
  const maxThick = Math.max(3, 3.5 * scale);    // 3.5pt 보다 두꺼우면 선이 아니라 칠한 상자
  const gapOk = Math.max(1, Math.round(0.6 * scale)); // 선 중간의 작은 끊김은 이어 본다
  const seg = Math.max(6, Math.round(4 * scale));     // 줄마다 모을 가장 짧은 토막(약 4pt — 글자 획 대부분은 빠진다)
  const dark = (i) => gray[i] < th;
  // 가로: 행마다 토막
  const hsegs = [];
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    while (x < w) {
      if (!dark(row + x)) { x++; continue; }
      let x1 = x, miss = 0, k = x;
      while (k < w) {
        if (dark(row + k)) { x1 = k; miss = 0; } else if (++miss > gapOk) break;
        k++;
      }
      if (x1 - x + 1 >= seg) hsegs.push({ y, a: x, b: x1 });
      x = k + 1;
      if (hsegs.length > 400000) break;
    }
  }
  for (const s of joinSegments(hsegs, maxThick, minH)) out.push({ h: true, y: s.c / scale, a: s.a / scale, b: s.b / scale });
  // 세로: 열마다
  const vsegs = [];
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!dark(y * w + x)) { y++; continue; }
      let y1 = y, miss = 0, k = y;
      while (k < h) {
        if (dark(k * w + x)) { y1 = k; miss = 0; } else if (++miss > gapOk) break;
        k++;
      }
      if (y1 - y + 1 >= seg) vsegs.push({ y: x, a: y, b: y1 });
      y = k + 1;
      if (vsegs.length > 400000) break;
    }
  }
  for (const s of joinSegments(vsegs, maxThick, minV)) out.push({ h: false, x: s.c / scale, a: s.a / scale, b: s.b / scale });
  return out;
}

// 이웃한 줄(y, y+1)의 토막이 겹치거나 끝끼리 닿으면(2픽셀 안) 한 덩어리로 묶는다(합집합 찾기).
// 덩어리가 길고(minLen 이상) 평균 두께가 얇으면(maxThick 이하) 선 하나. 기울기는 2°까지 받아 준다.
function joinSegments(segs, maxThick, minLen) {
  const n = segs.length;
  if (!n) return [];
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (i, j) => { const a = find(i), b = find(j); if (a !== b) parent[a] = b; };
  // segs 는 줄(y) 차례·줄 안에서 a 차례로 들어온다
  let prevStart = 0, prevEnd = 0, curStart = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0 || segs[i].y !== segs[i - 1].y) {
      // 새 줄: 바로 앞 줄이 직전 줄일 때만 이웃
      if (i > 0 && segs[i].y === segs[i - 1].y + 1) { prevStart = curStart; prevEnd = i; } else { prevStart = prevEnd = i; }
      curStart = i;
    }
    const s = segs[i];
    for (let k = prevStart; k < prevEnd; k++) {
      const p = segs[k];
      if (p.a > s.b + 2) break;
      if (p.b + 2 >= s.a) union(i, k);
    }
  }
  const comp = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i), s = segs[i];
    let c = comp.get(r);
    if (!c) { c = { a: s.a, b: s.b, y0: s.y, y1: s.y, ink: 0, wy: 0 }; comp.set(r, c); }
    if (s.a < c.a) c.a = s.a;
    if (s.b > c.b) c.b = s.b;
    if (s.y < c.y0) c.y0 = s.y;
    if (s.y > c.y1) c.y1 = s.y;
    const len = s.b - s.a + 1;
    c.ink += len;
    c.wy += s.y * len;
  }
  const out = [];
  for (const c of comp.values()) {
    const len = c.b - c.a + 1;
    if (len < minLen) continue;
    if (c.ink / len > maxThick) continue;                          // 평균 두께
    if (c.y1 - c.y0 + 1 > maxThick + len * 0.035 + 2) continue;    // 2°보다 더 기울었거나 여러 선이 엉킨 것
    out.push({ c: c.wy / c.ink, a: c.a, b: c.b });
    if (out.length > 5000) break;
  }
  return out;
}

const HANGUL = /[가-힣]/g;
const IS_HANGUL = /[가-힣]/;
const ONLY_PUNCT = /^[\s'"`‘’“”,.·:;!?\-–—~]+$/;

// ─── 인식 글 바로잡기 ───
// 표 테두리(세로선·밑줄)를 글자로 잘못 읽은 것: 홀로 선 | ㅣ _ 는 버리고, 낱말 끝에 붙은 것은 떼어 낸다
const BORDER_WORD = /^[|ㅣ¦‖_]+$/;
function stripBorders(s) {
  return s.replace(/^[|ㅣ¦‖]+(?=\S)/, '').replace(/(?<=\S)[|ㅣ¦‖]+$/, '');
}

// 곧은 따옴표 → 둥근 따옴표(한국어 문서는 둥근 따옴표를 쓴다): 앞이 비었거나 여는 괄호면 여는 것, 아니면 닫는 것
function smartQuotes(s, prevEndsOpen) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "'" && c !== '"' && c !== '`') { out += c; continue; }
    const before = i === 0 ? (prevEndsOpen ? ' ' : '') : s[i - 1];
    const opening = i === 0 ? prevEndsOpen : /[\s(\[{「『〈《]/.test(before);
    if (c === '"') out += opening ? '“' : '”';
    else out += opening || c === '`' ? '‘' : '’';
  }
  return out;
}

// 괄호 짝 맞추기: 「…] 「…』 처럼 여는 것과 짝이 안 맞는 닫는 괄호를 바로잡는다(인식기가 반쪽 괄호를 헷갈린다)
const PAIR = { '「': '」', '｢': '｣', '『': '』', '(': ')', '[': ']', '“': '”', '‘': '’' };
const CLOSE_CONFUSED = { '「': /[\]』｣|]/, '｢': /[\]』」|]/, '『': /[\]」｣]/, '(': /[\]}]/ };
function fixPairs(s) {
  const stack = [];
  const out = [...s];
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (PAIR[c] && c !== '“' && c !== '‘') { stack.push(c); continue; }
    const top = stack[stack.length - 1];
    if (top && c === PAIR[top]) { stack.pop(); continue; }
    if (top && CLOSE_CONFUSED[top] && CLOSE_CONFUSED[top].test(c)) { out[i] = PAIR[top]; stack.pop(); }
  }
  return out.join('');
}

export function fixOcrText(s) {
  return s.replace(/ㆍ/g, '·'); // 한글 아래아(ㆍ)로 읽힌 가운뎃점
}
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// 두 무리로 가르는 문턱(오츠) — 값들을 '좁은 틈'과 '넓은 틈'으로 나눌 때
function splitPoint(vals, lo, hi, fallback) {
  const v = vals.filter((x) => x >= 0 && x < 1.5).sort((a, b) => a - b);
  if (v.length < 8) return fallback;
  let best = -1, th = fallback;
  let sumAll = 0;
  for (const x of v) sumAll += x;
  let sumL = 0;
  for (let i = 0; i < v.length - 1; i++) {
    sumL += v[i];
    const nL = i + 1, nR = v.length - nL;
    const mL = sumL / nL, mR = (sumAll - sumL) / nR;
    const score = nL * nR * (mR - mL) * (mR - mL);
    if (score > best && v[i + 1] > v[i]) { best = score; th = (v[i] + v[i + 1]) / 2; }
  }
  return Math.min(hi, Math.max(lo, th));
}

// ─── 글머리표 모양 읽기 ───
// 인식기는 줄 첫머리의 작은 기호(□ ○ ◦ △ ▸…)를 0·O·ㅇ·ㅁ·* 따위로 읽는다. 그림의 그 자리 화소로 모양을 가린다.
// box: 글자 상자(그림 픽셀), em: 줄 글자 크기(픽셀). 돌려주는 것: 기호 하나 또는 null(모르겠음)
const BULLET_LIKE = /^[0OoQDㅇㅁ口니ㅂ*~스를△▲▵▴▷▶▸▹□■○●◦◇◆•▪▫◎⊙@ㆍ·]$/;
export function bulletShape(img, box, em, debug = null) {
  const { gray, w: W, h: H, th } = img;
  // 글자 상자를 실제 잉크에 맞춰 줄인다(상자에 여백이 있으면 가장자리 띠가 비어 보인다)
  let x0 = Math.max(0, Math.floor(box.x0)), x1 = Math.min(W - 1, Math.ceil(box.x1) - 1);
  let y0 = Math.max(0, Math.floor(box.y0)), y1 = Math.min(H - 1, Math.ceil(box.y1) - 1);
  const dark = (x, y) => gray[y * W + x] < th;
  // 가장자리 줄에 잉크가 거의 없으면(15% 미만 — 번진 점) 잘라 낸다
  const rowHas = (y) => { let d = 0; for (let x = x0; x <= x1; x++) if (dark(x, y)) d++; return d > (x1 - x0 + 1) * 0.15; };
  const colHas = (x) => { let d = 0; for (let y = y0; y <= y1; y++) if (dark(x, y)) d++; return d > (y1 - y0 + 1) * 0.15; };
  while (y0 < y1 && !rowHas(y0)) y0++;
  while (y1 > y0 && !rowHas(y1)) y1--;
  while (x0 < x1 && !colHas(x0)) x0++;
  while (x1 > x0 && !colHas(x1)) x1--;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (bw < 4 || bh < 4 || bh > em * 1.2 || bh < em * 0.3) return null; // 아주 작은 점(·)은 그대로
  const ratio = bw / bh;
  if (ratio < 0.8 || ratio > 1.3) return null; // 기호는 거의 정사각(숫자 0·글자 O 는 홀쭉하다)
  const area = (ax, ay, bx, by) => { // 어두운 칸 비율(끝 포함)
    let d = 0, n = 0;
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) { n++; if (dark(x, y)) d++; }
    return n ? d / n : 0;
  };
  // 가장자리: 바깥 띠(두께 10%) 안에서 가장 많이 찬 한 줄 — 테두리가 1픽셀만큼 가늘어도 잡히게
  const b = Math.max(1, Math.round(Math.min(bw, bh) * 0.1));
  let T = 0, B = 0, L = 0, R = 0;
  for (let k = 0; k < b; k++) {
    T = Math.max(T, area(x0, y0 + k, x1, y0 + k)); B = Math.max(B, area(x0, y1 - k, x1, y1 - k));
    L = Math.max(L, area(x0 + k, y0, x0 + k, y1)); R = Math.max(R, area(x1 - k, y0, x1 - k, y1));
  }
  const c = Math.max(1, Math.round(Math.min(bw, bh) * 0.15)); // 귀퉁이 칸
  const tl = area(x0, y0, x0 + c - 1, y0 + c - 1), tr = area(x1 - c + 1, y0, x1, y0 + c - 1);
  const bl = area(x0, y1 - c + 1, x0 + c - 1, y1), br = area(x1 - c + 1, y1 - c + 1, x1, y1);
  const I = area(x0 + b + 1, y0 + b + 1, x1 - b - 1, y1 - b - 1); // 안쪽(채움)
  if (debug) debug.push({ bw, bh, T, B, L, R, tl, tr, bl, br, I });
  const small = bh < em * 0.5;
  const filled = I > 0.5;
  const hi = 0.6, lo = 0.3;
  // 네모: 네 가장자리가 다 찼다
  if (T > hi && B > hi && L > hi && R > hi) return filled ? (small ? '▪' : '■') : '□';
  // 세모(위): 밑변만 차고 윗변은 꼭짓점뿐 / 세모(오른쪽): 왼변만 차고 오른변은 꼭짓점뿐
  if (B > hi && T < lo && bl > lo && br > lo && tl < lo && tr < lo) return small ? (filled ? '▴' : '▵') : (filled ? '▲' : '△');
  if (L > hi && R < lo && tl > lo && bl > lo && tr < lo && br < lo) return small ? (filled ? '▸' : '▹') : (filled ? '▶' : '▷');
  // 귀퉁이가 다 비었으면: 가장자리에 점으로만 닿으면 마름모, 넓게 닿으면 동그라미
  if (Math.max(tl, tr, bl, br) < lo) {
    if (Math.max(T, B, L, R) < 0.25) return filled ? '◆' : '◇';
    return filled ? (small ? '•' : '●') : (small ? '◦' : '○');
  }
  return null;
}

// 인식 결과(블록 → 문단 → 줄 → 낱말) → pdflayout 쪽 자료
// width·height: 쪽 크기(쪽 단위), scale: 그림 픽셀 / 쪽 단위, rules: 그림에서 찾은 선, image: { gray, w, h }(글머리표 모양 읽기용)
// 걸러 내기: 확신도가 아주 낮은 줄(사진·무늬를 글로 잘못 본 것)은 버린다
// 띄어쓰기: 한국어 인식기는 한 낱말을 음절마다 떼어 '경 찰 청'처럼 내놓곤 한다 → 쪽 안 한글 사이 틈을 '낱말 안'과 '띄어쓰기'
//   두 무리로 갈라(오츠), 좁은 틈의 한글 조각은 한 낱말로 붙인다
export function pageFromOcr(blocks, { width, height, scale = 1, rules = null, image = null, minLine = 45, minWord = 25 } = {}) {
  let words = 0;
  const img = image ? { ...image, th: image.th || otsu(image.gray) } : null;
  const lines = [];
  for (const b of blocks || []) {
    if (b.blocktype && /IMAGE|LINE|NOISE/.test(b.blocktype)) continue;
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        const raw = (l.words || []).filter((w) => w.text && w.text.trim() && w.bbox);
        words += raw.length;
        if (!raw.length) continue;
        const text = raw.map((w) => w.text.trim()).join('');
        const conf = raw.reduce((s, w) => s + w.confidence * [...w.text.trim()].length, 0) / Math.max(1, [...text].length);
        if (conf < minLine) continue;
        // 한두 글자뿐인 줄은 확신도가 아주 높을 때만(그림·무늬 조각을 'S'·'ㅁ'으로 읽은 것). 숫자뿐인 줄(쪽 번호)은 둔다
        const bare = text.replace(/[\s.,·:;'"`‘’“”()\-–—~|_]/g, '');
        if ([...bare].length <= 2 && !/^\d+$/.test(bare) && conf < 85) continue;
        // 표 테두리 찌꺼기를 떼고, 줄 안의 확신도 낮은 짧은 잡티는 버린다
        const ws = [];
        for (const w of raw) {
          const t0 = w.text.trim();
          if (BORDER_WORD.test(t0)) continue;
          if (w.confidence < minWord && [...t0].length <= 2) continue;
          const t = fixOcrText(stripBorders(t0));
          if (!t) continue;
          ws.push({ text: t, bbox: w.bbox, symbols: t === t0 ? w.symbols : null });
        }
        if (!ws.length) continue;
        // 줄 글자 크기: 낱말 높이의 가운뎃값(한글은 높이 ≈ 0.92em, 로마자·숫자는 ≈ 0.72em)
        const hangul = (text.match(HANGUL) || []).length / Math.max(1, [...text].length);
        const hpx = median(ws.map((w) => w.bbox.y1 - w.bbox.y0));
        const sizePx = Math.max(4, hpx / (hangul >= 0.3 ? 0.92 : 0.72));
        const bl = l.baseline && l.baseline.x1 > l.baseline.x0 ? l.baseline : null;
        ws.sort((a, c) => a.bbox.x0 - c.bbox.x0);
        // 줄 첫머리 글머리표: 홀로 선 첫 글자(또는 낱말 첫 글자 뒤가 띄어진 것)의 모양을 화소로 가린다
        if (img && ws.length >= 2) {
          const w0 = ws[0];
          const sym0 = w0.symbols && w0.symbols[0];
          const box = [...w0.text].length === 1 ? w0.bbox : sym0 && w0.symbols[1] && (w0.symbols[1].bbox.x0 - sym0.bbox.x1) > sizePx * 0.25 ? sym0.bbox : null;
          const ch = [...w0.text][0];
          if (box && BULLET_LIKE.test(ch)) {
            const shape = bulletShape(img, box, sizePx);
            if (shape) {
              if ([...w0.text].length === 1) w0.text = shape;
              else ws.splice(0, 1, { text: shape, bbox: { ...box } }, { text: w0.text.slice(ch.length), bbox: { ...w0.bbox, x0: w0.symbols[1].bbox.x0 } });
            }
          }
        }
        lines.push({ ws, sizePx, bl, punct: ONLY_PUNCT.test(ws.map((w) => w.text).join('')), bbox: l.bbox });
      }
    }
  }
  // 쪽 안 한글↔한글 틈(글자 크기 배수)으로 '낱말 안 틈' 문턱
  const gaps = [];
  for (const L of lines) for (let i = 1; i < L.ws.length; i++) {
    const a = L.ws[i - 1], c = L.ws[i];
    if (IS_HANGUL.test(a.text.slice(-1)) && IS_HANGUL.test(c.text[0])) gaps.push((c.bbox.x0 - a.bbox.x1) / L.sizePx);
  }
  const join = splitPoint(gaps, 0.15, 0.6, 0.3);
  // 한글 사이 틈을 띄어 쓸까: 아주 좁으면 붙이고 아주 넓으면 띄운다. 그 사이(자간이 넓은 문서에서 둘이 섞이는 구간)는
  // 틈 크기와 한국어 띄어쓰기 통계(음절 짝마다 띄어 쓴 비율)를 함께 본다
  const logit = (p) => { const q = Math.min(0.98, Math.max(0.02, p)); return Math.log(q / (1 - q)); };
  const TU = globalThis.__DRE_OCR_TUNE || {};
  const LW = TU.lw ?? 0.5, GW = TU.gw ?? 16, MG = TU.m ?? 0.25; // 가짜 스캔 56쪽(깨끗한·거친 판)에서 고른 값
  const spaced = (left, right, z) => {
    if (z <= 0.1) return false;
    if (z >= join + MG) return true;
    const p = spaceProb(left, right);
    const lang = p == null ? 0 : logit(p) * LW;
    return lang + (z - join) * GW > 0;
  };
  const items = [];
  const baseAt = (L, w) => {
    let cx = (w.bbox.x0 + w.bbox.x1) / 2;
    let by = w.bbox.y1;
    // 기준선은 줄 안에서만 쓴다(줄 밖으로 늘리면 기울기 때문에 엉뚱한 높이가 된다)
    if (L.bl) { cx = Math.min(L.bl.x1, Math.max(L.bl.x0, cx)); by = L.bl.y0 + ((L.bl.y1 - L.bl.y0) * (cx - L.bl.x0)) / (L.bl.x1 - L.bl.x0); }
    if (by < w.bbox.y0 || by > w.bbox.y1 + L.sizePx * 0.3) by = w.bbox.y1; // 기준선이 낱말 상자에서 크게 벗어나면 상자 아래로
    return by;
  };
  for (const L of lines) {
    // 따옴표·쉼표만 있는 줄(작은 문장부호를 따로 한 줄로 본 것)은 가장 가까운 글 줄로 옮긴다
    let host = L;
    if (L.punct) {
      let best = null, bd = Infinity;
      for (const M of lines) {
        if (M === L || M.punct) continue;
        const dy = Math.max(0, M.bbox.y0 - L.bbox.y1, L.bbox.y0 - M.bbox.y1);
        const dx = Math.max(0, M.bbox.x0 - L.bbox.x1, L.bbox.x0 - M.bbox.x1);
        if (dy > M.sizePx * 0.8 || dx > M.sizePx * 3) continue;
        if (dy + dx * 0.2 < bd) { bd = dy + dx * 0.2; best = M; }
      }
      if (!best) continue;
      host = best;
    }
    // 좁은 틈의 한글 조각 붙이기
    const merged = [];
    for (const w of L.ws) {
      const prev = merged[merged.length - 1];
      if (prev && IS_HANGUL.test(prev.text.slice(-1)) && IS_HANGUL.test(w.text[0]) && !spaced(prev.text, w.text, (w.bbox.x0 - prev.bbox.x1) / host.sizePx)) {
        prev.text += w.text;
        prev.bbox = { x0: prev.bbox.x0, y0: Math.min(prev.bbox.y0, w.bbox.y0), x1: w.bbox.x1, y1: Math.max(prev.bbox.y1, w.bbox.y1) };
        continue;
      }
      merged.push({ text: w.text, bbox: { ...w.bbox } });
    }
    // 따옴표 방향: 홀로 선 따옴표는 더 가까운 쪽 낱말에 붙는 것으로 본다
    merged.forEach((w, i) => {
      if (!/['"`]/.test(w.text)) return;
      let open = true;
      if (/^['"`]$/.test(w.text)) {
        const gp = i > 0 ? w.bbox.x0 - merged[i - 1].bbox.x1 : Infinity;
        const gn = i + 1 < merged.length ? merged[i + 1].bbox.x0 - w.bbox.x1 : Infinity;
        open = gn < gp;
      }
      w.text = smartQuotes(w.text, open);
    });
    // 괄호 짝(줄 안에서)
    const fixed = fixPairs(merged.map((w) => w.text).join('\u0000')).split('\u0000');
    merged.forEach((w, i) => { w.text = fixed[i] ?? w.text; });
    for (const w of merged) {
      const y = L === host ? baseAt(L, w) : baseAt(host, { bbox: { x0: w.bbox.x0, x1: w.bbox.x1, y0: host.bbox.y0, y1: host.bbox.y1 } });
      items.push({ s: w.text, x0: w.bbox.x0 / scale, x1: w.bbox.x1 / scale, y: y / scale, size: host.sizePx / scale, font: 'ocr', fixed: false, ocr: true });
    }
  }
  const r = rules || Object.assign([], { shapes: [], glyphs: [] });
  return { w: width, h: height, items, spaces: [], rotated: [], rules: r, shapes: r.shapes || [], ocr: { words, kept: items.length, join } };
}

