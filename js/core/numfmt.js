// 자동 문단 번호 글자 만들기 — 한글(번호 모양 0~16)과 워드(numFmt 이름) 공용

const GANADA = '가나다라마바사아자차카타파하';
const JAMO = 'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ';
const CIRCLED_GANADA = '㉮㉯㉰㉱㉲㉳㉴㉵㉶㉷㉸㉹㉺㉻';
const CIRCLED_JAMO = '㉠㉡㉢㉣㉤㉥㉦㉧㉨㉩㉪㉫㉬㉭';
const DECAGON = '갑을병정무기경신임계';
const DECAGON_HANJA = '甲乙丙丁戊己庚辛壬癸';
const SINO_KO = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const SINO_ZH = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

function cycle(chars, n) {
  const arr = [...chars];
  return arr[(n - 1) % arr.length];
}

function roman(n) {
  if (n <= 0 || n >= 4000) return String(n);
  const t = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
}

function letters(n, base) {
  // A..Z, AA.. (워드식: 27 → AA)
  const k = Math.floor((n - 1) / 26) + 1;
  return String.fromCharCode(base + ((n - 1) % 26)).repeat(k);
}

function sino(n, digits, ten, hundred) {
  if (n <= 0 || n >= 1000) return String(n);
  let s = '';
  const h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), o = n % 10;
  if (h) s += (h > 1 ? digits[h] : '') + hundred;
  if (t) s += (t > 1 ? digits[t] : '') + ten;
  if (o) s += digits[o];
  return s;
}

function circledDigit(n) {
  if (n >= 1 && n <= 20) return String.fromCharCode(0x2460 + n - 1);
  if (n >= 21 && n <= 35) return String.fromCharCode(0x3251 + n - 21);
  if (n >= 36 && n <= 50) return String.fromCharCode(0x32b1 + n - 36);
  return `(${n})`;
}

// shape: 한글 번호 모양 번호(0~16) 또는 워드 numFmt 이름
export function formatNumber(n, shape) {
  switch (shape) {
    case 0: case 'decimal': case 'DIGIT': return String(n);
    case 1: case 'decimalEnclosedCircle': case 'CIRCLED_DIGIT': return circledDigit(n);
    case 2: case 'upperRoman': case 'ROMAN_CAPITAL': return roman(n);
    case 3: case 'lowerRoman': case 'ROMAN_SMALL': return roman(n).toLowerCase();
    case 4: case 'upperLetter': case 'LATIN_CAPITAL': return letters(n, 65);
    case 5: case 'lowerLetter': case 'LATIN_SMALL': return letters(n, 97);
    case 6: case 'CIRCLED_LATIN_CAPITAL': return n <= 26 ? String.fromCharCode(0x24b6 + n - 1) : letters(n, 65);
    case 7: case 'CIRCLED_LATIN_SMALL': return n <= 26 ? String.fromCharCode(0x24d0 + n - 1) : letters(n, 97);
    case 8: case 'ganada': case 'HANGUL_SYLLABLE': return cycle(GANADA, n);
    case 9: case 'CIRCLED_HANGUL_SYLLABLE': return cycle(CIRCLED_GANADA, n);
    case 10: case 'chosung': case 'HANGUL_JAMO': return cycle(JAMO, n);
    case 11: case 'CIRCLED_HANGUL_JAMO': return cycle(CIRCLED_JAMO, n);
    case 12: case 'koreanDigital': case 'koreanLegal': case 'HANGUL_PHONETIC': return sino(n, SINO_KO, '십', '백');
    case 13: case 'ideographTraditional': case 'chineseCounting': case 'japaneseCounting': case 'IDEOGRAPH': return sino(n, SINO_ZH, '十', '百');
    case 14: case 'CIRCLED_IDEOGRAPH': case 'ideographEnclosedCircle': return n <= 10 ? String.fromCharCode(0x3280 + n - 1) : sino(n, SINO_ZH, '十', '百');
    case 15: case 'DECAGON_CIRCLE': return cycle(DECAGON, n);
    case 16: case 'DECAGON_CIRCLE_HANJA': return cycle(DECAGON_HANJA, n);
    case 'decimalZero': return n < 10 ? '0' + n : String(n);
    case 'decimalEnclosedParen': return `(${n})`;
    case 'decimalEnclosedFullstop': return `${n}.`;
    case 'decimalFullWidth': case 'decimalFullWidth2': return String(n).replace(/\d/g, (d) => String.fromCharCode(0xff10 + +d));
    case 'koreanCounting': return n <= 10 ? ['하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열'][n - 1] : String(n);
    case 'none': return '';
    default: return String(n);
  }
}

// 번호 형식 글("^1.", "%1.%2.")의 자리표를 수준별 번호로 바꾼다. num(k): k는 0부터.
export function applyNumberFormat(fmt, num) {
  if (!fmt) return '';
  return fmt.replace(/[\^%](\d)/g, (m, d) => num(+d - 1));
}
