// 엑셀 셀 서식 — 셀에 든 값(숫자·날짜 일련번호·글)을 엑셀이 화면에 그리는 글로 바꾼다.
// 서식 글('#,##0', 'yyyy-mm-dd', '0.0%', '_-* #,##0_-;-* #,##0_-;_-* "-"_-;_-@_-' …)을 해석한다. XLSX·XLS 공용.
// 이 PC(한국어 Windows)의 엑셀이 그리는 모양을 기준으로 한다: 짧은 날짜(서식 14) = yyyy-mm-dd, AM/PM = 오전/오후.

// 정해진 서식 번호(파일에 따로 적지 않는 것) — 한국어 엑셀 기준
export const BUILTIN = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
  5: '"₩"#,##0;\\-"₩"#,##0', 6: '"₩"#,##0;[Red]\\-"₩"#,##0', 7: '"₩"#,##0.00;\\-"₩"#,##0.00', 8: '"₩"#,##0.00;[Red]\\-"₩"#,##0.00',
  9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'yyyy-mm-dd', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'yyyy-mm-dd h:mm',
  27: 'yyyy"년" mm"월" dd"일"', 28: 'mm-dd', 29: 'mm-dd', 30: 'mm-dd-yy', 31: 'yyyy"년" mm"월" dd"일"', 32: 'h"시" mm"분"', 33: 'h"시" mm"분" ss"초"',
  34: 'yyyy-mm-dd', 35: 'yyyy-mm-dd', 36: 'yyyy"년" mm"월" dd"일"',
  37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
  41: '_-* #,##0_-;-* #,##0_-;_-* "-"_-;_-@_-', 42: '_-"₩"* #,##0_-;-"₩"* #,##0_-;_-"₩"* "-"_-;_-@_-',
  43: '_-* #,##0.00_-;-* #,##0.00_-;_-* "-"??_-;_-@_-', 44: '_-"₩"* #,##0.00_-;-"₩"* #,##0.00_-;_-"₩"* "-"??_-;_-@_-',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 48: '##0.0E+0', 49: '@',
  50: 'yyyy"년" mm"월" dd"일"', 51: 'mm-dd', 52: 'yyyy-mm-dd', 53: 'yyyy-mm-dd', 54: 'mm-dd', 55: 'yyyy-mm-dd', 56: 'yyyy-mm-dd',
  57: 'yyyy"년" mm"월" dd"일"', 58: 'mm-dd',
};

const GENERAL = /^(?:general|g\/표준)$/i;
const pad = (n, w) => String(n).padStart(w, '0');

// ─── 서식 글 쪼개기 ───
// 칸(;)으로 나눈다 — 따옴표 글·\x·_x·*x·[…] 안의 ; 는 칸 나눔이 아니다
function splitSections(code) {
  const out = [];
  let cur = '';
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"') { const e = code.indexOf('"', i + 1); const j = e < 0 ? code.length - 1 : e; cur += code.slice(i, j + 1); i = j; continue; }
    if (c === '\\' || c === '_' || c === '*') { cur += c + (code[i + 1] || ''); i++; continue; }
    if (c === '[') { const e = code.indexOf(']', i); if (e > 0) { cur += code.slice(i, e + 1); i = e; continue; } }
    if (c === ';') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// 서식 한 칸을 낱말로:
//   { t:'lit', s }   그대로 나오는 글     { t:'num', c }  숫자 자리표·기호(0 # ? . , % E + - / 숫자)
//   { t:'date', s }  날짜·시각 자리       { t:'text' }    글 자리(@)
//   { t:'gen' }      '일반'               (칸 채우기 *x 는 x 한 글자로)
function tokenize(sec) {
  const toks = [];
  const lit = (s) => { if (toks.length && toks[toks.length - 1].t === 'lit') toks[toks.length - 1].s += s; else toks.push({ t: 'lit', s }); };
  let cond = null, color = false;
  let i = 0;
  while (i < sec.length) {
    const c = sec[i];
    const rest = sec.slice(i);
    if (c === '"') { const e = sec.indexOf('"', i + 1); lit(sec.slice(i + 1, e < 0 ? sec.length : e)); i = e < 0 ? sec.length : e + 1; continue; }
    if (c === '\\') { lit(sec[i + 1] || ''); i += 2; continue; }
    if (c === '_') { lit(' '); i += 2; continue; }
    // 칸 채우기(*x): 엑셀은 열 너비만큼 x 를 되풀이한다. 너비를 모르는 글에서는 한 번(엑셀이 열 너비를 맞췄을 때의 모양: '₩ 250,000')
    if (c === '*') { lit(sec[i + 1] || ' '); i += 2; continue; }
    if (c === '[') {
      const e = sec.indexOf(']', i);
      const inner = sec.slice(i + 1, e < 0 ? sec.length : e);
      i = e < 0 ? sec.length : e + 1;
      let m;
      if (/^(?:h+|m+|s+)$/i.test(inner)) { toks.push({ t: 'date', s: '[' + inner.toLowerCase() + ']' }); continue; }
      if ((m = /^\$([^-]*)(?:-[0-9A-Fa-f]+)?$/.exec(inner))) { if (m[1]) lit(m[1]); continue; } // [$₩-412] → ₩
      if ((m = /^(<=|>=|<>|<|>|=)\s*(-?\d+(?:\.\d+)?(?:E[+-]?\d+)?)$/i.exec(inner))) { cond = { op: m[1], v: +m[2] }; continue; }
      color = true; // [Red] [Color10] [DBNum1] 등 — 글에는 영향 없음
      continue;
    }
    if (c === '@') { toks.push({ t: 'text' }); i++; continue; }
    let m;
    if ((m = /^general/i.exec(rest)) || (m = /^G\/표준/.exec(rest))) { toks.push({ t: 'gen' }); i += m[0].length; continue; }
    if ((m = /^(?:AM\/PM|A\/P|오전\/오후)/i.exec(rest))) { toks.push({ t: 'date', s: 'ampm', short: /^A\/P$/i.test(m[0]) }); i += m[0].length; continue; }
    if (/^[eE][+-]/.test(rest)) { toks.push({ t: 'num', c: 'E' }, { t: 'num', c: rest[1] }); i += 2; continue; }
    if ((m = /^(?:y+|m+|d+|h+|s+|a{3,4}|e|g+)/i.exec(rest))) {
      const s = m[0].toLowerCase();
      i += m[0].length;
      if (s === 'e') toks.push({ t: 'date', s: 'yyyy' });
      else if (s[0] === 'g') { /* 연호 — 뺀다 */ } else if (s[0] === 'a' && s.length < 3) lit(m[0]);
      else toks.push({ t: 'date', s });
      if (s[0] === 's' && sec[i] === '.' && sec[i + 1] === '0') { let k = i + 1; while (sec[k] === '0') k++; toks.push({ t: 'date', s: 'frac', n: k - i - 1 }); i = k; }
      continue;
    }
    if ('0#?.,%/'.includes(c) || (c >= '1' && c <= '9')) { toks.push({ t: 'num', c }); i++; continue; }
    lit(c);
    i++;
  }
  return { toks, cond, color };
}

const isDigitSlot = (c) => c === '0' || c === '#' || c === '?';

function analyse(raw) {
  const { toks, cond } = tokenize(raw);
  const hasDate = toks.some((t) => t.t === 'date');
  const hasNum = toks.some((t) => t.t === 'num' && isDigitSlot(t.c));
  return { raw, toks, cond, date: hasDate && !hasNum, gen: toks.some((t) => t.t === 'gen'), text: toks.some((t) => t.t === 'text'), num: hasNum };
}

const cache = new Map();
function parsed(code) {
  let p = cache.get(code);
  if (!p) {
    p = splitSections(code).map(analyse);
    if (cache.size > 4000) cache.clear();
    cache.set(code, p);
  }
  return p;
}

// 날짜로 그리는 서식인가
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
export function isDateFormat(code, id) {
  if (id != null && DATE_IDS.has(+id)) return true;
  if (!code || GENERAL.test(code.trim())) return false;
  return parsed(code)[0].date;
}

// ─── 날짜 ───
// 엑셀 일련번호 → 날짜. 1900 체계: 1 = 1900-01-01, 60 = 있지도 않은 1900-02-29(로터스와 맞추려고 남긴 오류)
export function serialToDate(days, date1904 = false) {
  if (!date1904 && days === 60) return { y: 1900, m: 2, d: 29, dow: 3 };
  if (!date1904 && days === 0) return { y: 1900, m: 1, d: 0, dow: 6 };
  const e = date1904 ? days - 24107 : days - 25569 + (days < 60 ? 1 : 0);
  const dt = new Date(e * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay() };
}

const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];

function formatDate(v, toks, date1904) {
  if (v < 0 || v > 2958465.99999) return null; // 엑셀은 #### 로 그린다
  const fracTok = toks.find((t) => t.t === 'date' && t.s === 'frac');
  const unit = fracTok ? Math.pow(10, -fracTok.n) : 1;
  let whole = Math.floor(v);
  let secs = Math.round(((v - whole) * 86400) / unit) * unit;
  if (secs >= 86400 - 1e-9) { secs = 0; whole += 1; }
  const D = serialToDate(whole, date1904);
  const ampm = toks.some((t) => t.t === 'date' && t.s === 'ampm');
  const H = Math.floor(secs / 3600), M = Math.floor((secs % 3600) / 60), S = Math.floor(secs % 60);
  const sub = secs - Math.floor(secs);
  const total = whole * 86400 + secs; // 지난 시간([h] 등)
  // m 이 '분'인지 '월'인지: 바로 앞 날짜 자리가 시(h)이거나 바로 뒤가 초(s)면 분
  const dIdx = toks.map((t, i) => (t.t === 'date' && t.s !== 'frac' && t.s !== 'ampm' ? i : -1)).filter((i) => i >= 0);
  const minuteAt = new Set();
  dIdx.forEach((ti, k) => {
    const s = toks[ti].s;
    if (s[0] !== 'm' || s.length > 2) return;
    const prev = k > 0 ? toks[dIdx[k - 1]].s : '';
    const next = k + 1 < dIdx.length ? toks[dIdx[k + 1]].s : '';
    if (prev[0] === 'h' || prev.startsWith('[h') || next[0] === 's' || next.startsWith('[s')) minuteAt.add(ti);
  });
  let out = '';
  toks.forEach((t, i) => {
    if (t.t === 'lit') { out += t.s; return; }
    if (t.t === 'num') { if (!(t.c === '.' && toks[i + 1] && toks[i + 1].s === 'frac')) out += t.c; return; }
    if (t.t !== 'date') return;
    const s = t.s;
    if (s === 'frac') { out += '.' + pad(Math.min(Math.round(sub / unit), Math.pow(10, t.n) - 1), t.n); return; }
    if (s === 'ampm') { out += t.short ? (H < 12 ? 'A' : 'P') : (H < 12 ? '오전' : '오후'); return; }
    if (s.startsWith('[h')) { out += pad(Math.floor(total / 3600 + 1e-9), s.length - 2); return; }
    if (s.startsWith('[m')) { out += pad(Math.floor(total / 60 + 1e-9), s.length - 2); return; }
    if (s.startsWith('[s')) { out += pad(Math.round(total), s.length - 2); return; }
    switch (s[0]) {
      case 'y': out += s.length <= 2 ? pad(D.y % 100, 2) : String(D.y); return;
      case 'm':
        if (minuteAt.has(i)) { out += s.length === 2 ? pad(M, 2) : String(M); return; }
        out += s.length === 1 ? String(D.m) : s.length === 2 ? pad(D.m, 2) : s.length === 3 ? MON[D.m - 1].slice(0, 3) : s.length === 5 ? MON[D.m - 1][0] : MON[D.m - 1];
        return;
      case 'd': out += s.length === 1 ? String(D.d) : s.length === 2 ? pad(D.d, 2) : s.length === 3 ? DOW[D.dow].slice(0, 3) : DOW[D.dow]; return;
      case 'a': out += s.length === 3 ? DOW_KO[D.dow] : DOW_KO[D.dow] + '요일'; return;
      case 'h': { let h = H; if (ampm) { h = H % 12; if (h === 0) h = 12; } out += s.length >= 2 ? pad(h, 2) : String(h); return; }
      case 's': out += s.length >= 2 ? pad(S, 2) : String(S); return;
      default:
    }
  });
  return out;
}

// ─── 숫자 ───
// 엑셀 '일반' 서식: 11자 안에서 되도록 많은 자리, 넘치면 지수 꼴(1.23457E+11)
export function formatGeneral(v) {
  if (!isFinite(v)) return '#NUM!';
  if (v === 0) return '0';
  const neg = v < 0;
  const a = Math.abs(v);
  const room = 11; // 빼기 부호는 11자에 넣지 않는다(엑셀 실측: -3.343801958)
  const ex = Math.floor(Math.log10(a));
  let s;
  if (ex >= 11 || ex < -9) s = sci(a, room);
  else {
    const intLen = ex >= 0 ? ex + 1 : 1;
    const dec = Math.max(0, Math.min(room - intLen - 1, 15 - Math.max(ex + 1, 1) + (ex < 0 ? -ex - 1 : 0)));
    s = trimZeros(a.toFixed(Math.min(20, dec)));
    // 아주 작은 수는 고정 꼴로 유효 숫자가 너무 적어지면 지수 꼴로
    if (ex < -4) { const sc = sci(a, room); if (sig(s) < sig(sc.replace(/E.*/, ''))) s = sc; }
    if (s === '0') s = sci(a, room);
  }
  return (neg ? '-' : '') + s;
}
const trimZeros = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
const sig = (s) => s.replace('.', '').replace(/^0+/, '').length;
function sci(a, room) {
  let e = Math.floor(Math.log10(a));
  const es = (n) => (n < 0 ? '-' : '+') + pad(Math.abs(n), 2);
  const digits = Math.max(0, room - 2 - es(e).length - 1);
  let m = (a / Math.pow(10, e)).toFixed(digits);
  if (+m >= 10) { e += 1; m = (a / Math.pow(10, e)).toFixed(digits); }
  return trimZeros(m) + 'E' + es(e);
}

// 소수 n 자리로 반올림한 글(0.5 는 올림 — 엑셀처럼). 엑셀은 15자리 십진수로 셈하므로
// 이진 소수 오차(1.005 → 1.00499…)에 휘둘리지 않게 15자리 십진 숫자열에서 반올림한다.
function roundFixed(v, n) {
  const x = Math.abs(v);
  if (x === 0) return n ? '0.' + '0'.repeat(n) : '0';
  const [m, e] = x.toExponential(14).split('e');
  const digits = m.replace('.', '').split('').map(Number); // 15자리
  const exp = +e; // 첫 자리의 자리값 10^exp
  // 남길 자리 수: 정수 exp+1 자리 + 소수 n 자리
  const keep = exp + 1 + n;
  if (keep < 0) return n ? '0.' + '0'.repeat(n) : '0';
  let ds = digits.slice(0, Math.max(0, keep));
  let lead = exp;
  if (keep < digits.length && digits[keep] >= 5) {
    let i = ds.length - 1;
    while (i >= 0 && ds[i] === 9) { ds[i] = 0; i--; }
    if (i >= 0) ds[i]++;
    else { ds.unshift(1); lead++; }
  }
  while (ds.length < lead + 1 + n) ds.push(0);
  // 숫자열 → 글
  let ip, fp;
  if (lead >= 0) { ip = ds.slice(0, lead + 1).join(''); fp = ds.slice(lead + 1, lead + 1 + n).join(''); }
  else { ip = '0'; fp = ('0'.repeat(-lead - 1) + ds.join('')).slice(0, n).padEnd(n, '0'); }
  ip = ip.replace(/^0+(?=\d)/, '');
  return n ? ip + '.' + fp : ip;
}

// 숫자 서식 한 칸(v ≥ 0, 부호는 부르는 쪽이 붙인다)
function formatNumber(v, toks) {
  const first = toks.findIndex((t) => t.t === 'num');
  let last = -1;
  toks.forEach((t, i) => { if (t.t === 'num') last = i; });
  const litOf = (arr) => arr.map((t) => (t.t === 'lit' ? t.s : '')).join('');
  const pre = litOf(toks.slice(0, first)), post = litOf(toks.slice(last + 1));
  // 자리표 열: 글자 하나씩, 사이에 낀 글도 그 자리에
  const pat = [];
  for (const t of toks.slice(first, last + 1)) {
    if (t.t === 'num') pat.push({ c: t.c });
    else if (t.t === 'lit') for (const ch of t.s) pat.push({ lit: ch });
  }
  const pct = pat.filter((p) => p.c === '%').length + ((pre + post).match(/%/g) || []).length;
  v *= Math.pow(100, pct);
  const eAt = pat.findIndex((p) => p.c === 'E');
  if (eAt >= 0) return pre + sciFormat(v, pat.slice(0, eAt), pat.slice(eAt + 2), pat[eAt + 1] && pat[eAt + 1].c === '+') + post;
  const slash = pat.findIndex((p) => p.c === '/');
  if (slash >= 0) return pre + fracFormat(v, pat, slash) + post;
  const dot = pat.findIndex((p) => p.c === '.');
  let intPat = dot >= 0 ? pat.slice(0, dot) : pat;
  const decPat = dot >= 0 ? pat.slice(dot + 1) : [];
  // 마지막 자리표 바로 뒤 쉼표(소수점 앞이나 서식 끝)는 천으로 나누기
  let k = intPat.length - 1;
  while (k >= 0 && (intPat[k].c === ',' || (intPat[k].c === '%'))) { if (intPat[k].c === ',') v /= 1000; k--; }
  for (let j = decPat.length - 1; j >= 0 && (decPat[j].c === ',' || decPat[j].c === '%'); j--) if (decPat[j].c === ',') v /= 1000;
  const lastSlot = (() => { for (let j = intPat.length - 1; j >= 0; j--) if (isDigitSlot(intPat[j].c)) return j; return -1; })();
  const thousands = intPat.some((p, i) => p.c === ',' && i < lastSlot && intPat.slice(0, i).some((q) => isDigitSlot(q.c)));
  const decSlots = decPat.filter((p) => isDigitSlot(p.c));
  const s = roundFixed(v, decSlots.length);
  let [ip, dp = ''] = s.split('.');
  if (/^0+$/.test(ip)) ip = '';
  // 정수 자리: 오른쪽부터 채우고 남은 앞자리는 맨 앞 자리표에
  const slotIdx = [];
  intPat.forEach((p, i) => { if (isDigitSlot(p.c)) slotIdx.push(i); });
  const fill = new Map();
  let di = ip.length - 1;
  for (let j = slotIdx.length - 1; j >= 0; j--) {
    const c = intPat[slotIdx[j]].c;
    fill.set(slotIdx[j], di >= 0 ? ip[di--] : c === '0' ? '0' : c === '?' ? ' ' : '');
  }
  if (di >= 0) {
    const lead = ip.slice(0, di + 1);
    if (slotIdx.length) fill.set(slotIdx[0], lead + fill.get(slotIdx[0]));
    else fill.set(-1, lead);
  }
  let intStr = fill.get(-1) || '';
  intPat.forEach((p, i) => {
    if (p.lit != null) intStr += p.lit;
    else if (isDigitSlot(p.c)) intStr += fill.get(i);
    else if (p.c === ',') { /* 천 단위·나누기 기호 */ } else intStr += p.c;
  });
  if (thousands) intStr = intStr.replace(/\d{4,}/, (d) => d.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  let decStr = '';
  if (dot >= 0) {
    const dd = dp.padEnd(decSlots.length, '0').split('');
    for (let j = decSlots.length - 1; j >= 0 && decSlots[j].c !== '0' && dd[j] === '0'; j--) dd[j] = decSlots[j].c === '?' ? ' ' : '';
    let q = 0;
    for (const p of decPat) {
      if (p.lit != null) decStr += p.lit;
      else if (isDigitSlot(p.c)) decStr += dd[q++];
      else if (p.c !== ',') decStr += p.c;
    }
    decStr = '.' + decStr;
  }
  return pre + intStr + decStr + post;
}

function sciFormat(v, mantPat, expPat, plus) {
  const dot = mantPat.findIndex((p) => p.c === '.');
  const intSlots = Math.max(1, (dot >= 0 ? mantPat.slice(0, dot) : mantPat).filter((p) => isDigitSlot(p.c)).length);
  const decSlots = dot >= 0 ? mantPat.slice(dot + 1).filter((p) => isDigitSlot(p.c)).length : 0;
  const ed = Math.max(1, expPat.filter((p) => isDigitSlot(p.c)).length);
  if (v === 0) return '0' + (decSlots ? '.' + '0'.repeat(decSlots) : '') + 'E' + (plus ? '+' : '') + '0'.repeat(ed);
  let e = Math.floor(Math.log10(v));
  if (intSlots > 1) e = Math.floor(e / intSlots) * intSlots; // 공학식(##0.0E+0)
  let ms = (v / Math.pow(10, e)).toFixed(decSlots);
  if (+ms >= Math.pow(10, intSlots)) { e += intSlots > 1 ? intSlots : 1; ms = (v / Math.pow(10, e)).toFixed(decSlots); }
  return ms + 'E' + (e < 0 ? '-' : plus ? '+' : '') + pad(Math.abs(e), ed);
}

// 분모가 maxDen 이하인 가장 가까운 분수(연분수 — 분모를 하나씩 다 돌아보지 않아 큰 자리 수에서도 빠르다)
function bestFraction(x, maxDen) {
  if (x <= 0) return [0, 1];
  let h0 = 0, h1 = 1, k0 = 1, k1 = 0, f = x;
  for (let i = 0; i < 64; i++) {
    const a = Math.floor(f);
    const h2 = a * h1 + h0, k2 = a * k1 + k0;
    if (k2 > maxDen) {
      // 마지막 근사와 반쯤 가는 근사(semiconvergent) 중 가까운 쪽
      const t = Math.floor((maxDen - k0) / k1);
      const hs = t * h1 + h0, ks = t * k1 + k0;
      if (ks > 0 && Math.abs(x - hs / ks) < Math.abs(x - h1 / k1)) return [hs, ks];
      break;
    }
    h0 = h1; h1 = h2; k0 = k1; k1 = k2;
    if (Math.abs(f - a) < 1e-12) break;
    f = 1 / (f - a);
  }
  return k1 ? [h1, k1] : [0, 1];
}

function fracFormat(v, pat, slash) {
  const denPat = pat.slice(slash + 1).filter((p) => p.c && (isDigitSlot(p.c) || /\d/.test(p.c)));
  const fixed = denPat.length && denPat.every((p) => /\d/.test(p.c)) ? +denPat.map((p) => p.c).join('') : 0;
  const maxDen = fixed || Math.pow(10, Math.max(1, denPat.length)) - 1;
  const hasInt = pat.slice(0, slash).some((p) => p.lit === ' ');
  let ip = hasInt ? Math.floor(v) : 0;
  const f = v - ip;
  let best = [0, 1];
  if (fixed) best = [Math.round(f * fixed), fixed];
  else best = bestFraction(f, maxDen);
  if (hasInt && best[0] === best[1]) { ip += 1; best = [0, best[1]]; }
  if (!hasInt) return `${best[0]}/${best[1]}`;
  if (best[0] === 0) return String(ip);
  return (ip ? ip + ' ' : '') + `${best[0]}/${best[1]}`;
}

function testCond(c, v) {
  switch (c.op) {
    case '<': return v < c.v; case '>': return v > c.v; case '<=': return v <= c.v; case '>=': return v >= c.v;
    case '=': return v === c.v; case '<>': return v !== c.v; default: return false;
  }
}

const litJoin = (toks, text) => toks.map((t) => (t.t === 'lit' ? t.s : t.t === 'text' ? text : '')).join('');

// 값 하나를 서식대로 글로. value: number | string | boolean | { error }
export function formatValue(value, code, { date1904 = false } = {}) {
  if (value == null) return '';
  if (typeof value === 'object') return value.error || '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const isGen = !code || GENERAL.test(code.trim());
  if (typeof value === 'string') {
    if (isGen) return value;
    const secs = parsed(code);
    const sec = secs.length >= 4 ? secs[3] : secs.find((s) => s.text);
    return sec ? litJoin(sec.toks, value) : value;
  }
  if (!isFinite(value)) return '#NUM!';
  if (isGen) return formatGeneral(value);
  const secs = parsed(code);
  let sec, v = value, sign = '';
  if (secs[0].cond || (secs[1] && secs[1].cond)) {
    // 조건 칸: [>=100]…;[<0]…;나머지
    if (secs[0].cond && testCond(secs[0].cond, v)) sec = secs[0];
    else if (secs[1] && secs[1].cond && testCond(secs[1].cond, v)) sec = secs[1];
    else sec = secs[secs[1] && secs[1].cond ? 2 : 1] || secs[secs.length - 1];
    if (v < 0) { v = -v; if (!(sec.cond && sec.cond.v <= 0 && /</.test(sec.cond.op))) sign = '-'; }
  } else if (v > 0 || secs.length === 1 || (v === 0 && secs.length === 2)) {
    sec = secs[0];
    if (v < 0) { v = -v; sign = '-'; }
  } else if (v < 0) {
    sec = secs[1];
    v = -v;
  } else {
    sec = secs[2];
  }
  if (!sec.toks.length) return '';
  if (sec.date) {
    if (value < 0) return '#'.repeat(10);
    const d = formatDate(value, sec.toks, date1904);
    return d == null ? '#'.repeat(10) : d;
  }
  let s;
  if (sec.num) s = formatNumber(v, sec.toks);
  else if (sec.gen || (sec.text && !sec.num)) s = sec.toks.map((t) => (t.t === 'lit' ? t.s : t.t === 'gen' || t.t === 'text' ? formatGeneral(v) : '')).join('');
  else s = sec.toks.map((t) => (t.t === 'lit' ? t.s : t.t === 'num' ? t.c : '')).join('');
  // 반올림해서 0 이 된 음수에는 부호를 붙이지 않는다
  return sign && /[1-9]/.test(s) ? sign + s : s;
}
