// 줄 잇기 판단 — 한 문장이 두 줄로 나뉘었을 때 이어 붙이며 띄울지(S) 붙일지(N), 아예 잇지 말지(H) 정한다.
// 예) '드디어 때가 되었' + '습니다' → 붙임(N),  '경찰은' + '수사를' → 띄움(S),  '…밝혔다.' + '□ 다음' → 줄 유지(H)
// 판단 근거: ① 문서 안 낱말 통계(같은 낱말이 붙어서 쓰인 적이 있나) ② 다음 줄이 조사·어미로 시작하나
//            ③ 줄 배치 단서(PDF: 줄 끝이 오른쪽 끝까지 찼나, 낱말 사이가 늘어났나) ④ 문서 전체의 경향

import { SPACING } from './spacingdata.js';

export let SPACING_WEIGHT = 1.0;
export function setSpacingWeight(w) { SPACING_WEIGHT = w; } // 시험용 조절

// 국어사전 명사 목록(dict.js 가 채운다 — 없으면 사전 근거 없이 판단)
let DICT = null;
export function setDictionary(d) { DICT = d; }

// 글머리표·번호로 시작하는 줄(새 항목 → 앞 줄과 잇지 않는다)
// (▲·△는 보도자료에서 '▲가 ▲나'처럼 문장 안에서 늘어놓을 때가 많아 넣지 않는다)
const BULLET_CHARS = '□■◆◇○●◦•▪▫▶▷►▸▹➢➤➣※★☆✓✔❍❏❑⦁◈▣◎◉⊙⇒⇨→☞◐◑';
const LIST_START = new RegExp(
  '^(?:' + [
    `[${BULLET_CHARS}]`,
    '[-–—·∙*+>ㅇ]\\s', // 하이픈·가운뎃점 등은 뒤에 빈칸이 있을 때만
    '(?:\\d{1,2}|[A-Za-z]|[ivxIVX]{1,4}|[ⅰ-ⅹⅠ-Ⅻ])[.)]\\s',
    '(?:\\d{1,2}|[가나다라마바사아자차카타파하])\\)',
    '\\((?:\\d{1,2}|[가-하]|[a-zA-Z])\\)',
    '[①-⑳㉠-㉭㉮-㉻❶-❿➀-➓⓵-⓾ⓐ-ⓩⒶ-Ⓩ]',
    '제\\s?\\d+\\s?(?:조|항|호|장|절|편)(?:의\\d+)?(?:\\(|\\s|$)',
    '[<【〈《\\[]\\s?(?:참고|붙임|별첨|첨부|예시|사례|표|그림)',
  ].join('|') + ')',
);
// 한글 차례 글자 '가. 나. 다.' — 신문에서는 '…했' + '다. 다음 문장'처럼 문장 끝 '다.'가 줄 첫머리에 자주 온다.
// enums(문서의 줄 첫머리에 나온 차례 글자 모음)를 주면 앞 차례 글자(다 → 나)가 문서에 있을 때만 목록으로 본다.
const HANGUL_ENUM = /^([가나다라마바사아자차카타파하])[.)]\s/;
const ENUM_ORDER = '가나다라마바사아자차카타파하';
export function hangulEnum(s) {
  const m = HANGUL_ENUM.exec(s.replace(/^[\s\u3000]+/, ''));
  return m ? m[1] : null;
}
export function isListStart(s, enums) {
  const t = s.replace(/^[\s\u3000]+/, '');
  if (LIST_START.test(t)) return true;
  const e = hangulEnum(t);
  if (!e) return false;
  if (!enums) return true;
  const i = ENUM_ORDER.indexOf(e);
  return i === 0 ? enums.has('나') : enums.has(ENUM_ORDER[i - 1]);
}

const HANGUL = /[가-힣]/;
const HAN = /[㐀-鿿豈-﫿]/;
const KANA = /[぀-ヿ]/;

// 단어 첫머리에 올 수 없는 조사·어미(다음 줄이 이걸로 시작하면 앞 낱말에 붙는다)
const DEPENDENT = /^(?:습니다|읍니다|ㅂ니다|니다|었다|았다|였다|었습니다|았습니다|였습니다|겠다|겠습니다|었으며|았으며|였으며|었고|았고|였고|었는데|었던|았던|였던|으며|으면|으니|으나|으로써|으로서|으로부터|으로|에서는|에서도|에서|에게서|에게|께서는|께서|께|부터|까지|처럼|보다는|보다|마저|조차|밖에|이라고|라고|이라는|라는|이라며|라며|이라|이며|이고|이나|이든|이든지|이었다|이었던|였다|이다|입니다|이지만|지만|는데|는지|는가|던데|던|도록|므로|으므로|면서|으면서|려고|으려고|려면|게끔|기에|기로|기도|기는|기를|기가|기의|에는|에도|에의|와는|과는|와의|과의|와도|과도|로는|로도|로서|로써|로부터|만큼|만을|만이|만의|들이|들은|들을|들의|들에|들과|들도|들로|들이다)/;
// 한 글자 조사(뒤에 문장부호나 끝이 와야 확실)
const SINGLE_PARTICLE = /^[은는이가을를의에와과도로만다요며고서](?=$|[\s,.·)\]」』”’!?;:])/;
// '하다·되다' 붙임꼴(명사 + 하다): 한·할 등은 관형사와 헷갈리므로 뺀다
const HADA = /^(?:했|하였|하여|하고|하는|하며|하면|하지|해서|해야|해|함|합니다|하였다|하였고|됐|되었|되어|되는|되고|되며|된다|된|될|됨|됩니다|시킨|시켜|시키|받은|받아|받는|받았|당한|당했)/;
// 인용 뒤에 붙는 말: “…”라며 / 라고 / 라는 / 고 / 며, 괄호 뒤 조사
const QUOTE_TAIL = /^(?:이라며|이라고|이라는|이라|라며|라고|라는|라|하며|하고|하는|고|며|와|과|을|를|이|가|의|에|은|는|도|로|으로|에서|에게|란|이란)(?=$|[\s,.·)\]」』”’!?;:]|[가-힣])/;

// 숫자 뒤에 붙는 단위
const UNIT = /^(?:명|개|건|원|억|만|천|백|조|년|월|일|시|분|초|회|차|위|배|세|곳|대|층|호|권|장|쪽|면|점|가지|주|개월|시간|퍼센트|%|번째|번|여|kg|g|km|m|cm|mm|t|톤|평|㎡|㎢|㎞|㎏|달러|엔|위안|유로|명의|건의|원의)/;
// 낱말 끝에 흔한 말(앞 줄이 이걸로 끝나면 낱말이 끝났을 가능성)
const WORD_END = /(?:다|요|까|고|며|서|면|지|게|도|는|은|을|를|의|에|와|과|로|만|및|등|해|여|며|니|데|든|나|인|한|된|할|될|적|간|중|후|전|시|상|하)$/;

const CLOSE_START = /^[)\]}」』”’,.;:!?%·…〉》>、。，：；！？）］｝]/;
const OPEN_END = /[(\[{「『“‘〈《<（［｛]$/;
const PUNCT_EDGE = /^[\s"'“”‘’()\[\]{}「」『』〈〉《》<>.,;:!?·…~]+|[\s"'“”‘’()\[\]{}「」『』〈〉《》<>.,;:!?·…~]+$/g;

function core(tok) {
  return tok.replace(PUNCT_EDGE, '');
}

// ─── 음절 사이 띄어쓰기 통계(spacingdata.js, 한글 문서 본문으로 학습) ───
let SP = null;
function spacingTables() {
  if (SP) return SP;
  const dec = (str, keyLen) => {
    const m = new Map();
    for (let i = 0; i + keyLen < str.length; i += keyLen + 1) m.set(str.slice(i, i + keyLen), str.charCodeAt(i + keyLen) - 0x30);
    return m;
  };
  const [ue, us] = SPACING.u.split('|');
  SP = { ue: dec(ue, 1), us: dec(us, 1), b: dec(SPACING.b, 2), l: dec(SPACING.l, 3), r: dec(SPACING.r, 3) };
  return SP;
}
const logit = (p) => { const q = Math.min(0.995, Math.max(0.005, p)); return Math.log(q / (1 - q)); };
const valP = (v) => Math.floor(v / 4) / 20;
const valW = (v) => [0.5, 1, 1.6, 2.2][v % 4];

// 앞 글 끝과 뒤 글 첫머리 사이가 띄어질 확률(0~1). 한글 음절이 아니면 null
export function spaceProb(left, right) {
  const a1 = left[left.length - 1], b1 = right[0];
  if (!a1 || !b1 || !HANGUL.test(a1) || !HANGUL.test(b1)) return null;
  const a2 = left.length >= 2 && HANGUL.test(left[left.length - 2]) ? left[left.length - 2] : '';
  const b2 = right.length >= 2 && HANGUL.test(right[1]) ? right[1] : '';
  const T = spacingTables();
  const ue = T.ue.get(a1), us = T.us.get(b1);
  let lg = ((ue != null ? logit(valP(ue)) : 0) + (us != null ? logit(valP(us)) : 0)) / 1.6;
  const vb = T.b.get(a1 + b1);
  if (vb != null) lg = logit(valP(vb));
  let sum = lg, w = 1;
  const vl = a2 ? T.l.get(a2 + a1 + b1) : undefined;
  const vr = b2 ? T.r.get(a1 + b1 + b2) : undefined;
  if (vl != null) { sum += logit(valP(vl)) * valW(vl); w += valW(vl); }
  if (vr != null) { sum += logit(valP(vr)) * valW(vr); w += valW(vr); }
  return 1 / (1 + Math.exp(-sum / w));
}

// 문서 낱말 통계 — 줄 가운데 있는 낱말(줄 첫·끝 낱말은 잘린 것일 수 있어 뺀다)
export class WordStats {
  constructor() {
    this.count = new Map();
    this.prefix = new Map();
  }
  addLine(line, { edges = false } = {}) {
    const toks = line.split(/[\s\u3000]+/).filter(Boolean);
    const from = edges ? 0 : 1;
    const to = edges ? toks.length : toks.length - 1;
    for (let i = from; i < to; i++) this.addToken(toks[i]);
  }
  addToken(tok) {
    const c = core(tok);
    if (!c || c.length > 30) return;
    this.count.set(c, (this.count.get(c) || 0) + 1);
    // 낱말 앞부분(조사가 붙은 꼴도 찾게): 2~6글자
    for (let k = 2; k <= Math.min(8, c.length - 1); k++) {
      const p = c.slice(0, k);
      this.prefix.set(p, (this.prefix.get(p) || 0) + 1);
    }
  }
  has(w) { return this.count.get(w) || 0; }
  // 조사가 붙은 꼴로 쓰인 횟수(기사를·기사의 → '기사'): 그 말이 한 낱말이라는 근거
  stemCount(w) {
    if (!this._stems || this._stemsAt !== this.count.size) {
      this._stems = new Map();
      this._stemsAt = this.count.size;
      for (const [tok, n] of this.count) {
        for (const suf of STEM_TAILS) {
          if (tok.length - suf.length >= 2 && tok.endsWith(suf)) {
            const st = tok.slice(0, -suf.length);
            this._stems.set(st, (this._stems.get(st) || 0) + n);
            break;
          }
        }
      }
    }
    return this._stems.get(w) || 0;
  }
  starts(w) { return (this.count.get(w) || 0) + (this.prefix.get(w) || 0); }
}

const STEM_TAILS = ['에서', '에게', '으로', '까지', '부터', '처럼', '보다', '만큼', '에는', '에도', '와의', '과의', '이라', '이다', '은', '는', '이', '가', '을', '를', '의', '에', '와', '과', '도', '로', '만'];

// 사전 근거에 쓰는 꼴
// 하다·되다·시키다가 붙은 꼴(명사 뒤 줄 첫머리)
const HADA_FORM = /^(?:할|하는|하여|하고|하며|하면|하지|하거나|하기|하던|하도록|하려|해서|해야|해|함|합니다|하였|했|한다|한|됨|되는|되어|되고|되며|되면|된다|된|될|됐|되었|시키|시켜|시킨|받는|받아|받았|받을|받기|받게|받으|당한|당하)/;
// '한 번'·'한 명'의 '한'(하나)은 하다 꼴이 아니다
const DET_HAN = /^한\s+(?:번|명|개|가지|곳|차례|달|해|사람|건|쪽|권|장|대|살|시간|주|분|가운데)/;
// 꾸미는 꼴로 끝나는 말(구체적인·하는·있는…)
const ADNOMINAL = /(?:적인|하는|되는|있는|없는|하던|되던|이라는|라는|위한|대한|관한|따른|통한|인한|같은)$/;
// 조사를 뗀 명사(증거가 → 증거)
function stemOf(w) {
  if (!DICT) return null;
  for (const suf of STEM_TAILS) {
    if (w.length - suf.length >= 2 && w.endsWith(suf)) {
      const st = w.slice(0, -suf.length);
      if (DICT.has(st)) return st;
    }
  }
  return null;
}
// 홀로 선 한 글자 토막이 조사·어미 꼴이면(…근로자 과 | 반) 낱말일 수 없다 → 잘린 낱말
const LONE_TAIL = /^[과와을를는에로의고며]$/;

// 점수: 양수면 붙이고(N) 음수면 띄운다(S). hint: { wrap: 'word'|'char'|null, space: 끝에 빈칸 흔적 }
export function joinScore(a, b, stats, hint = {}) {
  const A0 = a.replace(/[\s\u3000]+$/, '');
  const B0 = b.replace(/^[\s\u3000]+/, '');
  if (!A0 || !B0) return { code: 'S', score: -9 };
  if (isListStart(B0, hint.enums)) return { code: 'H', score: 0 };
  // 범위 물결(28~ | 30일), 항목 표(△ | MK 사내스쿨)는 붙인다
  if (/[~∼〜]$/.test(A0) && /^[0-9]/.test(B0)) return { code: 'N', score: 6 };
  if (/[△▲▷▶○●□■◇◆]$/.test(A0)) return { code: 'N', score: 6 };
  if (hint.space) return { code: 'S', score: -9 };
  const x = A0[A0.length - 1];
  const y = B0[0];

  // 영어 줄 끝 하이픈: infor- / mation
  if (/[A-Za-z]-$/.test(A0) && /^[a-z]/.test(B0)) {
    const left = A0.split(/\s+/).pop().slice(0, -1);
    const right = core(B0.split(/\s+/)[0]);
    if (stats && stats.has(left + '-' + right) && !stats.has(left + right)) return { code: 'N', score: 9 };
    return { code: 'D', score: 9 }; // 하이픈을 지우고 붙인다
  }
  if (CLOSE_START.test(B0) && !/^[·]\s/.test(B0)) return { code: 'N', score: 9 };
  if (OPEN_END.test(A0)) return { code: 'N', score: 9 };
  // 가운뎃점으로 이은 낱말: 금융위원회· | 금융감독원
  if (/[·⋅․ㆍ・]$/.test(A0) && /[가-힣A-Za-z0-9]/.test(y)) return { code: 'N', score: 6 };
  if ((HAN.test(x) || KANA.test(x)) && (HAN.test(y) || KANA.test(y))) return { code: 'N', score: 9 };
  // 닫는 따옴표·괄호 뒤 조사·인용 어미는 붙인다: …다.”라며, (주)가
  if (/[”’」』)\]"']$/.test(A0) && QUOTE_TAIL.test(B0)) return { code: 'N', score: 6 };
  if (/[.,;:!?]$/.test(A0) || /[”’」』)]$/.test(A0)) return { code: 'S', score: -9 };

  const lastTok = A0.split(/[\s\u3000]+/).pop();
  const firstTok = B0.split(/[\s\u3000]+/)[0];
  const A = lastTok.replace(/^[\s"'“‘(\[「『〈《<]+/, '');
  const Bc = core(firstTok);

  if (/[0-9]$/.test(A0)) {
    if (UNIT.test(B0)) return { code: 'N', score: 6 };
    if (/^[0-9]/.test(B0)) return { code: 'S', score: -3 };
  }
  if (HANGUL.test(x) && /^[0-9A-Za-z]/.test(B0)) {
    return { code: 'S', score: A === '제' ? 3 : -3 };
  }
  if (/[A-Za-z0-9)\]]$/.test(A0) && HANGUL.test(y)) {
    if (DEPENDENT.test(B0) || SINGLE_PARTICLE.test(B0)) return { code: 'N', score: 6 };
    if (stats && Bc && stats.has(A + Bc)) return { code: 'N', score: 4 };
    return { code: 'S', score: -3 };
  }
  // 괄호는 앞 낱말에 붙여 쓴다: 조종거리(본체…), 창설(지방청…)
  if (y === '(' && /[가-힣A-Za-z0-9]$/.test(A0)) return { code: 'N', score: 2.5 };
  if (!(HANGUL.test(x) && HANGUL.test(y))) return { code: 'S', score: -3 };

  // ── 한글 + 한글 ──
  // 가운뎃점·빗금으로 이어진 낱말은 마지막 토막만 본다(체포조·피해자보 | 호조를 → '피해자보' + '호조를')
  const Ak = A.split(/[·・/]/).pop() || A;
  const Bk = Bc.split(/[·・/]/)[0] || Bc;
  let score = 0;
  const dep = DEPENDENT.test(B0) || SINGLE_PARTICLE.test(B0);
  if (stats) {
    const joined = stats.has(Ak + Bk);
    const aWord = stats.has(Ak);                         // 앞 토막이 홀로 쓰인 적 있나
    const aPrefix = stats.prefix.get(Ak) || 0;           // 더 긴 낱말의 앞부분으로 쓰인 적 있나
    const bWord = stats.has(Bk) + (stats.prefix.get(Bk.slice(0, 2)) || 0); // 뒤 토막이 낱말 첫머리로 쓰인 적 있나
    const joinStart = Ak.length + 1 <= 8 ? stats.prefix.get(Ak + Bk[0]) || 0 : 0; // '앞 토막+뒤 첫 글자'로 시작하는 낱말
    const aStem = Ak.length >= 2 ? stats.stemCount(Ak) : 0;  // 앞 토막이 조사 붙은 꼴로 쓰인 적 있나(그 자체로 낱말)
    if (joined) score += 3 + Math.min(3, joined);
    else if (joinStart && (Ak.length >= 2 || (joinStart >= 2 && !bWord))) score += 1.2 + Math.min(1, joinStart / 3);
    if (!aWord && !aStem && aPrefix && Ak.length >= 2) score += 1.2;   // 앞 토막은 늘 더 긴 낱말의 일부였다 → 잘린 낱말
    if (aWord && bWord && !joined && !joinStart) score -= 2 + Math.min(1.5, Math.min(aWord, bWord) / 3);
    else if ((aWord || aStem >= 2) && !joined && !joinStart) score -= 1;
    // 앞 토막이 '알려진 낱말 + 조사'(유튜브와·조직이)면 낱말이 끝난 것
    const pStem = Ak.length >= 3 && /[은는이가을를의에와과도로]$/.test(Ak) ? Ak.slice(0, -1) : null;
    if (pStem && (stats.has(pStem) || stats.stemCount(pStem) >= 2) && !joined && !joinStart) score -= 1.5;
    else if (bWord && !joined && !joinStart && !dep && Ak.length >= 2) score -= 0.6;
  }
  if (dep) score += 3;
  else if (HADA.test(B0)) score += 1.5;
  // 사전 근거(시험 묶음 3,174곳에서 하나씩 재어 도움이 된 것만: 91.08% → 91.30%)
  // 둘 다 사전 명사면 띄우기, 붙인 말이 사전에 있으면 붙이기는 효과가 없거나 나빠져 넣지 않았다 — 합성어 띄어쓰기는 쓰는 사람마다 다르다
  if (DICT) {
    const TD = globalThis.__DRE_JOIN_TUNE || {};
    const nounA = Ak.length >= 2 && DICT.has(Ak);
    const bStem = Bk.length >= 2 && DICT.has(Bk) ? Bk : stemOf(Bk);
    // 명사 + 하다·되다·시키다 꼴(지정 | 할 수 → 지정할 수): 하다는 붙여 쓰는 것이 맞춤법
    if (nounA && HADA_FORM.test(B0) && !DET_HAN.test(B0)) score += TD.hd ?? 4;
    // 꾸미는 말 끝(구체적인 | 증거가): 앞이 명사가 아니고 꾸미는 꼴로 끝나며 뒤가 명사로 시작
    if (!nounA && bStem && ADNOMINAL.test(Ak) && !dep) score -= TD.ad ?? 1.5;
    // 낱말 중간에서 잘린 줄(형제자 | 매로, 일어 | 나지): 앞 토막은 사전에 없는데 뒤 첫 글자들을 붙이면 사전 낱말이 된다
    if (!nounA && !stemOf(Ak) && Ak.length >= 2) {
      for (let j = 1; j <= Math.min(3, Bk.length); j++) if (DICT.has(Ak + Bk.slice(0, j))) { score += TD.pj ?? 3; break; }
    }
  }
  // 일반적인 한글 띄어쓰기 경향(음절 통계): 띄움 확률이 낮을수록 붙인다
  const ps = spaceProb(Ak, Bk);
  if (ps != null) score += -logit(ps) * SPACING_WEIGHT;
  if (WORD_END.test(Ak) && !dep) score -= 0.8;
  // 한 글자만 남은 앞 줄 끝은 잘린 낱말일 때가 많다(문서에서 홀로 자주 쓰인 한 글자 낱말 '더·또'는 빼고)
  if (Ak.length === 1 && core(lastTok) === Ak && LONE_TAIL.test(Ak)) score += 2;
  else if (Ak.length === 1 && !/[은는이가을를의에와과도로만및등]/.test(Ak) && !(stats && stats.has(Ak) >= 2)) score += 1;
  const ling = score; // 말(낱말·조사) 근거만의 점수 — 문서 경향을 잴 때 쓴다
  if (hint.wrap === 'word') score -= 3;
  return { code: score > 0 ? 'N' : 'S', score, ling, korean: true };
}

// 문서 전체 경향으로 다시 정한다.
// 한글 문서는 줄 나눔 기준이 '어절'(낱말 단위, 기본값)이면 줄 끝이 늘 낱말 끝이라 거의 모두 띄워 잇고,
// '글자'면 낱말 중간에서도 끊기므로 대부분 붙여 잇는다. 확실한 근거들로 어느 쪽 문서인지 먼저 가린다.
export function settleJoins(items) {
  // items: [{ score, code, ling?, korean?, set(code) }]
  let n = 0, s = 0;
  for (const it of items) {
    if (!it.korean) continue;
    const v = it.ling != null ? it.ling : it.score;
    if (v >= 3) n++;
    else if (v <= -2) s++;
  }
  const total = n + s;
  const ratio = total >= 5 ? n / total : null;
  let mode = 'mixed';
  if (ratio != null && ratio < 0.3) mode = 'word';
  else if (ratio != null && ratio > 0.6) mode = 'char';
  if (globalThis.__DRE_JOIN_DEBUG) globalThis.__DRE_JOIN_DEBUG({ n, s, ratio, mode, items });
  for (const it of items) {
    if (!it.korean || (it.code !== 'N' && it.code !== 'S')) continue;
    // 낱말 단위 문서: 아주 확실할 때만 붙인다. 그 밖: 근거대로(동점은 띄움)
    const T = globalThis.__DRE_JOIN_TUNE || {};
    if (mode === 'word' && !T.noMode) it.set(it.score >= (T.wordTh ?? 3) ? 'N' : 'S');
    else it.set(it.score > (T.th ?? 0.3) ? 'N' : 'S');
  }
  return mode;
}

// 한글·워드의 강제 줄바꿈(\u2028)을 판단해 잇기 표시로 바꾼다: \ue010 띄워 잇기, \ue011 붙여 잇기, \n 줄 유지
export const SOFT_SPACE = '\ue010';
export const SOFT_NONE = '\ue011';

export function resolveSoftBreaks(doc) {
  const texts = [];
  for (const b of doc.blocks) {
    if (b.t === 'p') for (const s of b.segs) texts.push(s.s);
    else if (b.t === 'tbl') for (const r of b.rows) for (const c of r) if (c) texts.push(c.s);
  }
  if (!texts.some((t) => t.indexOf('\u2028') >= 0)) return;
  const stats = new WordStats();
  for (const t of texts) for (const line of t.split(/[\n\u2028]/)) stats.addLine(line);
  const items = [];
  const fix = (str, assign) => {
    if (str.indexOf('\u2028') < 0) return;
    const parts = str.split('\u2028');
    const codes = [];
    for (let i = 0; i < parts.length - 1; i++) {
      const r = joinScore(parts[i], parts[i + 1], stats);
      const it = { score: r.score, ling: r.ling, korean: r.korean, code: r.code, set: (c) => { it.code = c; } };
      codes.push(it);
      items.push(it);
    }
    assign(() => {
      // \uc870\uac01\uc744 \ubaa8\uc544 \ub9c8\uc9c0\ub9c9\uc5d0 \uc787\ub294\ub2e4(\uc774\uc5b4 \ubd99\uc778 \uae00 \uc804\uccb4\ub97c \ub9e4\ubc88 \ub2e4\ub4ec\uc73c\uba74 \uc904\ubc14\uafc8\uc774 \ub9ce\uc744 \ub54c \uc81c\uacf1\uc73c\ub85c \ub290\ub824\uc9c4\ub2e4)
      const pieces = [parts[0]];
      const trimTail = () => { // \ubaa8\uc740 \uae00 \ub05d\uc758 \ube48\uce78 \uc9c0\uc6b0\uae30(\ube48\uce78\ubfd0\uc778 \uc870\uac01\uc740 \ud1b5\uc9f8\ub85c)
        while (pieces.length) {
          const t = pieces[pieces.length - 1].replace(/[ \t\u3000]+$/, '');
          if (t) { pieces[pieces.length - 1] = t; return; }
          pieces.pop();
        }
      };
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i].code;
        if (c === 'H') { pieces.push('\n', parts[i + 1]); continue; }
        trimTail();
        if (c === 'D' && pieces.length) pieces[pieces.length - 1] = pieces[pieces.length - 1].replace(/-$/, '');
        pieces.push(c === 'N' || c === 'D' ? SOFT_NONE : SOFT_SPACE, parts[i + 1].replace(/^[ \t\u3000]+/, ''));
      }
      return pieces.join('');
    });
  };
  const later = [];
  for (const b of doc.blocks) {
    if (b.t === 'p') for (const s of b.segs) fix(s.s, (f) => later.push(() => { s.s = f(); }));
    else if (b.t === 'tbl') for (const r of b.rows) for (const c of r) if (c) fix(c.s, (f) => later.push(() => { c.s = f(); }));
  }
  settleJoins(items);
  for (const f of later) f();
}
