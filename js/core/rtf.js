// RTF(서식 있는 텍스트) 읽기 — 파일 바이트를 직접 훑어 문서 모델로(워드·DRE.exe 없이).
// 문단·표(가로·세로 합친 칸, 중첩 표)·각주/미주·목록 번호(워드가 적어 둔 \listtext·\pntext 글)·필드 결과·글상자·
// 머리말/꼬리말('hf' 문단)·쪽 나눔(\page·구역·\pagebb)을 읽는다. 숨긴 글(\v)·지운 글(\deleted)·메모는 뺀다.
// 글자: \uN(뒤따르는 대신 글자 \ucN 개는 건너뜀), \'hh(글꼴마다 \fcharset·\cpg 로 정한 코드 페이지 — 두 바이트 글자는 모아서 푼다).
import { noteMark } from './model.js';
import { finishLevels, SOFT_BREAK } from './hwp.js';
import { resolveSoftBreaks } from './joiner.js';

const fail = (code, msg) => Object.assign(new Error(msg), { code });

const MAX_DEPTH = 1024; // 묶음 깊이 상한(넘는 묶음은 바깥 묶음으로 친다)
const MAX_ITAP = 32; // 중첩 표 단계 상한
const MAX_CELLS = 2048; // 한 줄 칸 정의 상한
const MAX_SOFT = 2000; // 문단 하나의 강제 줄바꿈 중 줄 잇기 판단에 넘기는 수(넘으면 그냥 줄바꿈 — 판단이 문단 길이의 제곱으로 느려진다)

// ─── 코드 페이지 ───
// 글꼴 문자 집합(\fcharset) → 코드 페이지(0: 문서 기본 \ansicpg, -1: 기호 글꼴)
const CHARSET_CP = {
  0: 1252, 1: 0, 2: -1, 77: 10000, 78: 10001, 79: 10003, 80: 10008, 81: 10002, 128: 932, 129: 949, 130: 1361, 134: 936,
  136: 950, 161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250, 254: 437, 255: 850,
};
// 코드 페이지 → TextDecoder 이름(모르는 것은 windows-1252)
const CP_LABEL = {
  874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 866: 'ibm866',
  1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254',
  1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258',
  10000: 'macintosh', 10001: 'shift_jis', 10002: 'big5', 10003: 'euc-kr', 10007: 'x-mac-cyrillic', 10008: 'gbk',
  20866: 'koi8-r', 21866: 'koi8-u', 20932: 'euc-jp', 51932: 'euc-jp', 51949: 'euc-kr', 54936: 'gb18030', 65001: 'utf-8',
  28592: 'iso-8859-2', 28595: 'iso-8859-5', 28597: 'iso-8859-7', 28599: 'windows-1254', 28605: 'iso-8859-15',
};
// 두 바이트 글자의 첫 바이트
const LEADS = {
  shift_jis: (b) => (b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc),
  gbk: (b) => b >= 0x81 && b <= 0xfe,
  'euc-kr': (b) => b >= 0x81 && b <= 0xfe,
  big5: (b) => b >= 0x81 && b <= 0xfe,
};

// 풀이기: kind 1 한 바이트(표), 2 두 바이트(짝 기억), 3 TextDecoder 통째로, 4 기호 글꼴
const DECODERS = new Map();
function decoderOf(cp) {
  let d = DECODERS.get(cp);
  if (d) return d;
  let label = CP_LABEL[cp] || 'windows-1252';
  let td;
  try { td = new TextDecoder(label); } catch { label = 'windows-1252'; td = new TextDecoder(label); }
  if (LEADS[label]) d = { kind: 2, td, lead: LEADS[label], pairs: new Uint16Array(65536), multi: new Map(), single: [] };
  else if (label === 'utf-8' || label === 'euc-jp' || label === 'gb18030') d = { kind: 3, td };
  else {
    const all = new Uint8Array(256);
    for (let k = 0; k < 256; k++) all[k] = k;
    const t = td.decode(all);
    d = t.length === 256 ? { kind: 1, table: t } : { kind: 3, td };
  }
  DECODERS.set(cp, d);
  return d;
}
const SYM_DEC = { kind: 4, flavor: 'symbol' };
const WING_DEC = { kind: 4, flavor: 'wing' };

// 모아 둔 바이트를 글로
function decodeBytes(d, b, len) {
  if (d.kind === 1) {
    let s = '';
    for (let k = 0; k < len; k++) s += d.table[b[k]];
    return s;
  }
  if (d.kind === 3) return d.td.decode(b.subarray(0, len));
  let s = '';
  let codes = [];
  for (let k = 0; k < len; k++) {
    const x = b[k];
    if (x < 0x80) { codes.push(x); continue; }
    if (d.lead(x) && k + 1 < len) {
      const key = (x << 8) | b[k + 1];
      let c = d.pairs[key];
      if (c === 0) {
        const t = d.td.decode(b.subarray(k, k + 2));
        if (t.length === 1) c = t.charCodeAt(0);
        else { c = 1; d.multi.set(key, t); }
        d.pairs[key] = c;
      }
      if (c === 1) { s += String.fromCharCode.apply(null, codes) + d.multi.get(key); codes = []; } else codes.push(c);
      k++;
      continue;
    }
    // 홑바이트(일본어 반각 가나 등)
    let one = d.single[x];
    if (one === undefined) { one = d.td.decode(b.subarray(k, k + 1)); d.single[x] = one; }
    s += String.fromCharCode.apply(null, codes) + one;
    codes = [];
  }
  return codes.length ? s + String.fromCharCode.apply(null, codes) : s;
}

// ─── 기호 글꼴 ───
// Symbol 글꼴 0x20~0x7E, 0xA0~0xFF → 유니코드
const SYM_LO = ' !∀#∃%&∋()∗+,−./0123456789:;<=>?≅ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ[∴]⊥_‾αβχδεφγηιϕκλμνοπθρστυϖωξψζ{|}∼';
const SYM_HI = '€ϒ′≤⁄∞ƒ♣♦♥♠↔←↑→↓°±″≥×∝∂•÷≠≡≈…⏐⎯↵ℵℑℜ℘⊗⊕∅∩∪⊃⊇⊄⊂⊆∈∉∠∇®©™∏√⋅¬∧∨⇔⇐⇑⇒⇓◊〈®©™∑⎛⎜⎝⎡⎢⎣⎧⎨⎩⎪ 〉∫⌠⎮⌡⎞⎟⎠⎤⎥⎦⎫⎬⎭ ';
// Wingdings 등 — 글머리에 흔한 것만(docx.js 와 같게), 나머지는 '•'
const WING = {
  0x2d: '-', 0x4a: '☺', 0x4c: '☹', 0x6c: '●', 0x6e: '■', 0x6f: '□', 0x71: '❑', 0x72: '❒', 0x75: '◆', 0x76: '❖',
  0x9f: '•', 0xa1: '○', 0xa4: '◉', 0xa5: '◎', 0xa7: '▪', 0xa8: '◆', 0xab: '★', 0xb2: '◇',
  0xd2: '⇒', 0xd8: '➢', 0xe0: '→', 0xe8: '➔', 0xf0: '⇨', 0xfb: '✗', 0xfc: '✓', 0xfd: '☒', 0xfe: '☑',
};
function symbolChar(c, flavor) {
  if (flavor === 'symbol') {
    if (c >= 0x20 && c <= 0x7e) return SYM_LO[c - 0x20];
    if (c >= 0xa0 && c <= 0xff) return SYM_HI[c - 0xa0];
    return '';
  }
  if (c === 0x20) return ' ';
  return WING[c] || (c > 0x20 ? '•' : '');
}

// ─── 제어어 ───
// 이름 → 번호. 훑을 때 이름 글자를 만들지 않도록, 바이트로 셈한 수(해시)로 찾고 바이트를 맞대 본다
const KW = new Map(); // 해시 → [{ w, code }]
let kwNo = 0;
const hashStr = (w) => { let h = 0; for (let k = 0; k < w.length; k++) h = (Math.imul(h, 31) + w.charCodeAt(k)) | 0; return h; };
const kw = (names) => {
  const c = ++kwNo;
  for (const w of names.split(' ')) {
    const h = hashStr(w);
    const e = { w, code: c };
    const l = KW.get(h);
    if (l) l.push(e); else KW.set(h, [e]);
  }
  return c;
};
function findWord(u8, a, b, h) {
  const l = KW.get(h);
  if (!l) return null;
  for (const e of l) {
    if (e.w.length !== b - a) continue;
    let k = 0;
    while (k < e.w.length && e.w.charCodeAt(k) === u8[a + k]) k++;
    if (k === e.w.length) return e;
  }
  return null;
}
const K_PAR = kw('par'), K_SECT = kw('sect'), K_LINE = kw('line column'), K_TAB = kw('tab'), K_PAGE = kw('page');
const K_CELL = kw('cell'), K_NESTCELL = kw('nestcell'), K_ROW = kw('row'), K_NESTROW = kw('nestrow');
const K_CHAR = kw('emdash endash bullet lquote rquote ldblquote rdblquote emspace enspace qmspace zwj zwnj zwbo zwnbo ltrmark rtlmark');
const K_U = kw('u'), K_UC = kw('uc'), K_BIN = kw('bin');
const K_F = kw('f'), K_PLAIN = kw('plain'), K_V = kw('v'), K_DELETED = kw('deleted');
const K_PARD = kw('pard'), K_INTBL = kw('intbl'), K_ITAP = kw('itap'), K_LI = kw('li lin'), K_FI = kw('fi');
const K_OUTLINE = kw('outlinelevel'), K_S = kw('s'), K_PAGEBB = kw('pagebb');
const K_TROWD = kw('trowd'), K_CELLX = kw('cellx'), K_TRLEFT = kw('trleft');
const K_CLVMGF = kw('clvmgf'), K_CLVMRG = kw('clvmrg'), K_CLMGF = kw('clmgf'), K_CLMRG = kw('clmrg');
const K_SECTD = kw('sectd'), K_SBKNONE = kw('sbknone sbkcol'), K_SBKPAGE = kw('sbkpage sbkodd sbkeven');
const K_ANSI = kw('ansi'), K_MAC = kw('mac'), K_PC = kw('pc'), K_PCA = kw('pca'), K_ANSICPG = kw('ansicpg'), K_DEFF = kw('deff');
const K_FCHARSET = kw('fcharset'), K_CPG = kw('cpg'), K_NOFPAGES = kw('nofpages');
const K_CS = kw('cs ds ts'), K_SBASEDON = kw('sbasedon');
const K_FONTTBL = kw('fonttbl'), K_STYLESHEET = kw('stylesheet'), K_INFO = kw('info');
const K_FIELD = kw('field'), K_FLDINST = kw('fldinst'), K_FLDRSLT = kw('fldrslt');
const K_FOOTNOTE = kw('footnote'), K_FTNALT = kw('ftnalt');
const K_HEADER = kw('header headerl headerr headerf footer footerl footerr footerf');
const K_LISTTEXT = kw('listtext pntext');
const K_SHP = kw('shp shpgrp do object'), K_SHPINST = kw('shpinst'), K_SHPTXT = kw('shptxt dptxbxtext'), K_SHPRSLT = kw('shprslt');
const K_RESULT = kw('result'), K_UPR = kw('upr'), K_UD = kw('ud'), K_NESTPROPS = kw('nesttableprops');
// 통째로 건너뛰는 목적지(글이 아닌 것)
const K_SKIP = kw('aftncn aftnsep aftnsepc annotation atnauthor atndate atnicn atnid atnparent atnref atntime atrfend atrfstart '
  + 'author background bkmkend bkmkstart blipuid buptim category colorschememapping colortbl comment company creatim '
  + 'datafield datastore defchp defpap docvar doccomm ebcend ebcstart factoidname falt fchars ffdeftext ffentrymcr ffexitmcr '
  + 'ffformat ffhelptext ffl ffname ffstattext file filetbl fldtype fname fontemb fontfile formfield ftncn ftnsep ftnsepc '
  + 'generator gridtbl hl hlfr hlinkbase hlloc hlsrc hsv htmltag keycode keywords latentstyles lchars levelnumbers leveltext '
  + 'lfolevel linkval list listlevel listname listoverride listoverridetable listpicture liststylename listtable lsdlockedexcept '
  + 'mailmerge manager mhtmltag mmath mmathPict mmathPr mmaddfieldname mmconnectstr mmconnectstrdata mmdatasource '
  + 'mmheadersource mmmailsubject mmodso mmodsofilter mmodsofldmpdata mmodsomappedname mmodsoname mmodsorecipdata '
  + 'mmodsosort mmodsosrc mmodsotable mmodsoudl mmodsoudldata mmodsouniquetag mmquery nextfile nonesttables nonshppict '
  + 'objalias objclass objdata objname objsect objtime oldcprops oldpprops oldsprops oldtprops oleclsid operator panose '
  + 'password passwordhash pgp pgptbl picprop pict pn pnseclvl pntxta pntxtb printim private propname protend protstart '
  + 'protusertbl pxe revtbl revtim rsidtbl rxe shppict sn sp staticval subject sv svb tc template themedata title txe '
  + 'userprops wgrffmtfilter windowcaption writereservation writereservhash xe xform xmlattrname xmlattrvalue xmlclose '
  + 'xmlname xmlnstbl xmlopen pgdsctbl');
// 그대로 내는 글자
const CHAR_OUT = {
  emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”',
  emspace: '\u2003', enspace: '\u2002', qmspace: '\u2005', zwj: '\u200d', zwnj: '\u200c', zwbo: '\u200b', zwnbo: '', ltrmark: '', rtlmark: '',
};

// 글이 가는 곳
const D_SKIP = 0, D_TEXT = 1, D_CONT = 2, D_INST = 3, D_LABEL = 4, D_FONTTBL = 5, D_STYLESHEET = 6, D_STYLE = 7, D_INFO = 8;
const ACCEPTS = [false, true, false, true, true, true, false, true, false]; // 글을 받는 곳인가
// 묶음이 끝날 때 할 일
const E_FIELD = 1, E_NOTE = 2, E_HF = 3, E_BOX = 4, E_LABEL = 5, E_STYLE = 6, E_FONTTBL = 7, E_STYLESHEET = 8;

function cloneState(s) {
  return {
    dest: s.dest, live: s.live, story: s.story, field: s.field, shape: s.shape, nestProps: s.nestProps,
    font: s.font, dec: s.dec, uc: s.uc, v: s.v, del: s.del, hide: s.hide,
    intbl: s.intbl, itap: s.itap, li: s.li, fi: s.fi, outline: s.outline, style: s.style, pagebb: s.pagebb,
    end: 0,
  };
}

function resetPara(s) {
  s.intbl = false; s.itap = 0; s.li = 0; s.fi = 0; s.outline = -1; s.style = 0; s.pagebb = false;
}

// 표 단계: 0 이면 본문
const levelOf = (s) => (s.intbl ? Math.max(1, s.itap) : s.itap > 0 ? s.itap : 0);

const latin1 = (u8, a, b) => {
  if (b - a <= 4096) return String.fromCharCode.apply(null, u8.subarray(a, b));
  let s = '';
  for (let k = a; k < b; k += 4096) s += String.fromCharCode.apply(null, u8.subarray(k, Math.min(b, k + 4096)));
  return s;
};

// 들여쓰기 위치(twip → HWPUNIT 5배, docx.js 와 같은 기준)
const indentX = (pr, lead) => (Math.max(0, pr.li + pr.fi) + lead * 110) * 5;

// 목록 번호 글: 끝의 탭·빈칸은 빈칸 하나로(워드가 글로 저장할 때처럼)
function cleanLabel(s) {
  s = s.replace(/\u2028/g, '').replace(/^[\t \u00a0]+|[\t \u00a0]+$/g, '');
  if (!s) return '';
  if (s === 'o') s = '◦'; // 쿠리어 'o' 글머리(docx.js 와 같게)
  return s + ' ';
}

// 중첩 표·글상자 표를 글 줄로(docx.js 와 같게)
const flatRows = (rows) => rows.map((r) => r.filter(Boolean).map((c) => c.s.replace(/\n/g, ' ')).join(' | ')).filter((x) => x.trim()).join('\n');

// 칸 경계(\cellx)로 격자를 만들어 합친 칸을 모델 꼴(cs·rs·null)로
function buildRows(raw) {
  const xs = [];
  for (const r of raw) for (const c of r) xs.push(c.x0, c.x1);
  xs.sort((a, b) => a - b);
  const edges = [];
  for (const x of xs) if (!edges.length || x - edges[edges.length - 1] > 20) edges.push(x);
  const at = (x) => {
    let lo = 0, hi = edges.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (edges[m] <= x + 20) lo = m; else hi = m - 1; }
    return lo;
  };
  const origin = [];
  const rows = [];
  for (const r of raw) {
    const row = [];
    let pos = 0;
    let prev = null;
    for (const c of r) {
      const c0 = Math.max(pos, at(c.x0));
      const span = Math.max(1, at(c.x1) - c0);
      if (c.hm === 2 && prev) {
        // 옛 방식 가로 합침: 앞 칸에 붙인다
        prev.cs += span;
        if (c.s.trim()) prev.s += (prev.s ? '\n' : '') + c.s;
        for (let k = 0; k < span; k++) row[c0 + k] = null;
      } else if (c.vm === 2 && origin[c0]) {
        const o = origin[c0];
        o.rs = (o.rs || 1) + 1;
        if (c.s.trim()) o.s += (o.s ? '\n' : '') + c.s;
        for (let k = 0; k < span; k++) row[c0 + k] = null;
      } else {
        const cell = { s: c.s, cs: span, rs: 1 };
        row[c0] = cell;
        for (let k = 1; k < span; k++) row[c0 + k] = null;
        for (let k = 0; k < span; k++) origin[c0 + k] = cell;
        prev = cell;
      }
      pos = c0 + span;
    }
    rows.push(row);
  }
  let ncol = 1;
  for (const r of rows) if (r.length > ncol) ncol = r.length;
  for (const r of rows) { for (let k = 0; k < ncol; k++) if (r[k] === undefined) r[k] = null; r.length = ncol; }
  return rows;
}

// ─── 이야기: 본문·머리말·각주·글상자처럼 문단이 모이는 곳 ───
class Story {
  constructor(P, kind) {
    this.P = P;
    this.kind = kind; // 'main' | 'hf' | 'note' | 'box'
    this.parts = []; // 지금 문단의 글 조각
    this.segs = []; // 쪽 나눔으로 끊긴 앞 조각 [{ s, pg }]
    this.label = null; // 목록 번호 글
    this.extra = []; // 글상자 글(문단이 끝난 뒤에 붙인다)
    this.tables = []; // 열린 표(바깥 단계부터)
    this.defs = []; // 단계별 줄 정의 { left, cells: [{ x, vm, hm }], cur }
    this.defLevel = 1;
    this.blocks = []; // 본문: 문서 블록
    this.lines = []; // 그 밖: 글 줄
    this.pendingGap = 0;
    this.paraNo = 0;
    this.soft = 0; // 지금 문단의 강제 줄바꿈 수
  }

  // 구역 나눔(\sect)으로 미뤄 둔 쪽 넘김
  applySect() {
    const P = this.P;
    if (!P.sectPending || this.kind !== 'main') return;
    P.sectPending = false;
    if (!P.sectBreak) return;
    P.page++;
    for (const s of this.segs) s.pg++;
  }

  // 쪽 나눔(\page): 문단 가운데면 조각을 끊고 줄을 바꾼다(줄바꿈은 글에 — 쪽 맞춤(align.js)이 조각을 그냥 이어 붙인다)
  pageBreak(pr) {
    if (this.kind !== 'main') return;
    this.applySect();
    if (levelOf(pr) === 0 && (this.parts.length || this.segs.length)) {
      this.segs.push({ s: capSpaces(this.parts.join('')) + '\n', pg: this.P.page });
      this.parts = [];
    }
    this.P.page++;
  }

  takeText() {
    const last = this.parts.length ? capSpaces(this.parts.join('')) : '';
    this.parts = [];
    let segs = this.segs;
    this.segs = [];
    if (last || !segs.length) segs.push({ s: last, pg: this.P.page });
    segs = segs.filter((x, k) => x.s || k === 0);
    const label = this.label || '';
    this.label = null;
    const extra = this.extra;
    this.extra = [];
    this.paraNo++;
    return { segs, label, extra };
  }

  // 문단 하나가 끝났다(\par·\sect)
  endPara(pr) {
    const level = Math.min(MAX_ITAP, levelOf(pr));
    this.applySect();
    if (level === 0 && pr.pagebb && this.kind === 'main' && this.blocks.length) {
      this.P.page++;
      for (const s of this.segs) s.pg++;
    }
    const t = this.takeText();
    this.closeDeeper(level);
    if (level > 0) { this.table(level).cell.push(cellPara(t)); return; }
    this.soft = 0; // 칸 안 문단은 칸이 끝날 때 센다(칸 글이 통째로 판단된다)
    if (this.kind !== 'main') {
      this.lines.push(t.label + t.segs.map((x) => x.s).join(''));
      for (const e of t.extra) this.lines.push(e);
      return;
    }
    const P = this.P;
    const text = t.segs.map((x) => x.s).join('');
    const out = [];
    if (text.replace(/[\s\ue000\ue001]/g, '') || t.label.trim()) {
      const s0 = t.segs[0].s;
      const lead = s0.match(/^[ \u3000]*/)[0];
      t.segs[0].s = t.label + s0.slice(lead.length);
      const x = indentX(pr, lead.length);
      P.xs.push(x);
      const heading = P.isHeading(pr);
      out.push({ t: 'p', segs: t.segs, joins: 'G'.repeat(t.segs.length - 1), lvl: 0, kind: heading ? 'h' : t.label ? 'li' : '', gap: heading && this.blocks.length ? 1 : 0, _x: x });
    } else if (!t.extra.length) {
      this.pendingGap = 1;
    }
    for (const e of t.extra) for (const line of e.split('\n')) if (line.trim()) out.push({ t: 'p', segs: [{ s: line.trim(), pg: P.page }], joins: '', lvl: 0, kind: '', gap: 0 });
    this.push(out);
  }

  // 칸 하나가 끝났다(\cell·\nestcell)
  endCell(level) {
    level = Math.min(MAX_ITAP, Math.max(1, level));
    this.applySect();
    const t = this.takeText();
    this.closeDeeper(level);
    const tb = this.table(level);
    tb.cell.push(cellPara(t));
    tb.cells.push(tb.cell.join('\n').trimEnd());
    tb.cell = [];
    this.soft = 0;
  }

  // 줄 하나가 끝났다(\row·\nestrow)
  endRow(level) {
    level = Math.min(MAX_ITAP, Math.max(1, level));
    this.applySect();
    // 마지막 칸 뒤에 남은 글(드묾)은 칸 하나로
    if (this.parts.length || this.segs.length || this.extra.length) {
      const t = this.takeText();
      const s = cellPara(t);
      if (s.trim()) { this.closeDeeper(level); this.table(level).cell.push(s); }
    }
    this.closeDeeper(level);
    if (this.tables.length < level) return;
    const tb = this.tables[level - 1];
    if (tb.cell.length) { tb.cells.push(tb.cell.join('\n').trimEnd()); tb.cell = []; }
    if (!tb.cells.length) return;
    const def = this.defs[level];
    const dc = def ? def.cells : [];
    let x = def ? def.left : 0;
    const row = tb.cells.map((s, k) => {
      const d = dc[k];
      const x1 = d && d.x > x ? d.x : x + 1440;
      const c = { s, x0: x, x1, vm: d ? d.vm : 0, hm: d ? d.hm : 0 };
      x = x1;
      return c;
    });
    tb.raw.push(row);
    tb.cells = [];
  }

  // 그 단계의 표(없으면 연다)
  table(level) {
    while (this.tables.length < level) this.tables.push({ raw: [], cells: [], cell: [], pg: this.P.page });
    return this.tables[level - 1];
  }

  // 그 단계보다 깊은 표를 닫는다
  closeDeeper(level) {
    while (this.tables.length > level) {
      const level0 = this.tables.length;
      const tb = this.tables[level0 - 1];
      if (tb.cell.length || tb.cells.length) this.endRow(level0);
      this.tables.pop();
      if (!tb.raw.length) continue;
      const rows = buildRows(tb.raw);
      if (this.tables.length) {
        const flat = flatRows(rows);
        if (flat) this.tables[this.tables.length - 1].cell.push(flat);
      } else this.addTable(rows, tb.pg);
    }
  }

  addTable(rows, pg) {
    if (this.kind !== 'main') {
      const flat = flatRows(rows);
      if (flat) this.lines.push(flat);
      return;
    }
    // 칸 하나짜리 표(설명 상자)는 문단으로(docx.js 와 같게)
    const filled = rows.flat().filter((c) => c && c.s.trim());
    if (filled.length <= 1 && rows.length * rows[0].length <= 2) {
      const out = [];
      if (filled[0]) for (const line of filled[0].s.split('\n')) if (line.trim()) out.push({ t: 'p', segs: [{ s: line.trim(), pg }], joins: '', lvl: 0, kind: '', gap: 0 });
      if (out.length) out[0].gap = 1;
      this.push(out);
      return;
    }
    this.push([{ t: 'tbl', rows, pg, gap: 1 }]);
  }

  push(blocks) {
    for (const b of blocks) {
      if (this.pendingGap) { b.gap = Math.max(b.gap || 0, 1); this.pendingGap = 0; }
      this.blocks.push(b);
    }
  }

  newDef(level) {
    this.defLevel = Math.min(MAX_ITAP, Math.max(1, level));
    this.defs[this.defLevel] = { left: 0, cells: [], cur: { vm: 0, hm: 0 } };
  }

  def() {
    return this.defs[this.defLevel] || (this.defs[this.defLevel] = { left: 0, cells: [], cur: { vm: 0, hm: 0 } });
  }

  // 끝: 남은 글·열린 표를 마저 낸다
  finish(pr) {
    if (this.parts.length || this.segs.length || this.label || this.extra.length) this.endPara(pr);
    this.closeDeeper(0);
  }

  // 머리말·각주·글상자의 글 줄(강제 줄바꿈은 줄로)
  textLines() {
    const out = [];
    for (const l of this.lines) for (const x of l.replace(/\u2028/g, '\n').split('\n')) out.push(x.trimEnd());
    return out;
  }
}

// 아주 긴 빈칸·탭 줄(망가진 파일)은 1024 자로 줄인다 — 그리기(model.render)의 /\s+$/ 가 빈칸 길이의 제곱으로 느려진다
const MAX_SPACES = 1024;
function capSpaces(s) {
  if (s.length <= MAX_SPACES) return s;
  let parts = null, from = 0, run = 0, k = 0;
  const n = s.length;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9) { run = 0; k++; continue; }
    if (++run <= MAX_SPACES) { k++; continue; }
    let e = k;
    while (e < n && (s.charCodeAt(e) === 32 || s.charCodeAt(e) === 9)) e++;
    (parts || (parts = [])).push(s.slice(from, k));
    from = k = e;
    run = 0;
  }
  if (!parts) return s;
  parts.push(s.slice(from));
  return parts.join('');
}

// 칸 안 문단 하나의 글(번호·글상자 포함)
function cellPara(t) {
  let s = t.label + t.segs.map((x) => x.s).join('');
  if (t.extra.length) s += '\n' + t.extra.join('\n');
  return s.trimEnd(); // 정규식 /\s+$/ 는 긴 빈칸 줄에서 느리다
}

export function parseRtf(bytes, opts = {}) {
  try {
    return parse(bytes, opts);
  } catch (e) {
    if (e && e.code) throw e;
    // 예상하지 못한 오류도 code 를 붙여서(원래 오류는 cause 에)
    throw Object.assign(new Error('RTF 문서를 읽지 못했습니다(손상되었거나 특이한 형식일 수 있습니다)'), { code: 'broken', cause: e });
  }
}

function parse(bytes, { onProgress } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const n = u8.length;
  let i = 0;
  while (i < n && i < 16 && (u8[i] <= 0x20 || u8[i] === 0xef || u8[i] === 0xbb || u8[i] === 0xbf)) i++;
  if (!(u8[i] === 0x7b && u8[i + 1] === 0x5c && u8[i + 2] === 0x72 && u8[i + 3] === 0x74 && u8[i + 4] === 0x66)) {
    throw fail('format', 'RTF 문서가 아닙니다');
  }

  // 문서 전체
  const fonts = new Map(); // 번호 → { cs, cpg, name, done }
  const fontDecs = new Map();
  const styles = new Map(); // 번호 → { name, outline, based, heading }
  let ansiCp = 1252;
  let deff = 0;
  let curFont = null, curStyle = null;
  let labelBuf = '';
  let nofpages = 0;
  const notes = [];
  let noteNo = 0;
  const P = {
    page: 1, xs: [], sectPending: false, sectBreak: 1,
    isHeading: (pr) => {
      if (pr.outline >= 0 && pr.outline < 9) return true;
      const s = styles.get(pr.style);
      return !!(s && s.heading);
    },
  };
  const main = new Story(P, 'main');

  const fontDec = (id) => {
    let d = fontDecs.get(id);
    if (d) return d;
    const f = fonts.get(id);
    if (!f) d = decoderOf(ansiCp);
    else if (f.sym) d = f.sym;
    else if (f.cpg) d = decoderOf(f.cpg);
    else if (f.cs >= 0 && CHARSET_CP[f.cs] !== undefined && CHARSET_CP[f.cs] > 0) d = decoderOf(CHARSET_CP[f.cs]);
    else d = decoderOf(ansiCp);
    fontDecs.set(id, d);
    return d;
  };

  // 묶음 상태
  let st = {
    dest: D_TEXT, live: 0, story: main, field: null, shape: null, nestProps: false,
    font: 0, dec: null, uc: 1, v: false, del: false, hide: false,
    intbl: false, itap: 0, li: 0, fi: 0, outline: -1, style: 0, pagebb: false, end: 0,
  };
  const stack = [];
  let phantom = 0; // 깊이 상한을 넘어 세기만 하는 묶음
  let star = false; // \* 뒤
  let ucSkip = 0; // \uN 뒤에 건너뛸 대신 글자 수
  let ucOne = false; // 그때 \uc 가 1 이었나

  // 바이트 모으기(두 바이트 글자는 한꺼번에 푼다)
  let pend = new Uint8Array(256);
  let pendLen = 0, pendDec = null, pendTrail = false;

  const emit = (s) => {
    switch (st.dest) {
      case D_TEXT: if (!st.hide) st.story.parts.push(s); break;
      case D_INST: if (st.field && st.field.inst.length < 400) st.field.inst += s; break;
      case D_LABEL: if (labelBuf.length < 200) labelBuf += s; break;
      case D_FONTTBL:
        if (curFont && !curFont.done) {
          curFont.name += s;
          const k = curFont.name.indexOf(';');
          if (k >= 0) { curFont.name = curFont.name.slice(0, k); curFont.done = true; }
          if (curFont.name.length > 200) curFont.done = true;
        }
        break;
      case D_STYLE:
        if (curStyle && !curStyle.done) {
          curStyle.name += s;
          const k = curStyle.name.indexOf(';');
          if (k >= 0) { curStyle.name = curStyle.name.slice(0, k); curStyle.done = true; }
          if (curStyle.name.length > 200) curStyle.done = true;
        }
        break;
      default: break;
    }
  };
  const flushBytes = () => {
    const len = pendLen;
    pendLen = 0;
    pendTrail = false;
    emit(decodeBytes(pendDec, pend, len));
  };
  const put = (s) => {
    if (pendLen) flushBytes();
    emit(s);
  };
  const curDec = () => st.dec || (st.dec = st.dest === D_FONTTBL || st.dest === D_STYLE ? decoderOf(ansiCp) : fontDec(st.font));
  const symbolic = () => st.dest === D_TEXT || st.dest === D_LABEL;
  const pushByte = (b) => {
    if (b < 0x20) { if (b === 9) put('\t'); return; }
    const d = curDec();
    if (d.kind === 4) {
      if (symbolic()) { put(symbolChar(b, d.flavor)); return; }
      return pushPlain(b, decoderOf(ansiCp));
    }
    pushPlain(b, d);
  };
  const pushPlain = (b, d) => {
    if (pendLen && pendDec !== d) flushBytes();
    if (pendLen >= pend.length) { const g = new Uint8Array(pend.length * 2); g.set(pend); pend = g; }
    pend[pendLen++] = b;
    pendDec = d;
    pendTrail = d.kind === 2 ? (pendTrail ? false : d.lead(b)) : false;
  };
  const putAscii = (a, b) => {
    const d = curDec();
    if (d.kind === 4 && symbolic()) {
      let s = '';
      for (let k = a; k < b; k++) s += symbolChar(u8[k], d.flavor);
      put(s);
      return;
    }
    put(latin1(u8, a, b));
  };
  // 강제 줄바꿈(\line): 줄 잇기 판단에 넘길 표시. 한 문단에 너무 많으면 그냥 줄바꿈
  const softBreak = () => put(st.dest === D_TEXT && ++st.story.soft > MAX_SOFT ? '\n' : SOFT_BREAK);
  // \uN 글자
  const putUnicode = (code) => {
    if (code < 0x20) { if (code === 9) put('\t'); else if (code === 10 || code === 11 || code === 13) softBreak(); return; }
    if (code >= 0xe000 && code <= 0xe01f) return; // 모델이 표시로 쓰는 자리(각주·줄 잇기)
    if (code >= 0xf020 && code <= 0xf0ff && symbolic()) {
      const d = curDec();
      if (d.kind === 4) { put(symbolChar(code - 0xf000, d.flavor)); return; }
    }
    put(String.fromCharCode(code));
  };

  // 글 조각 [a, b): 줄바꿈 바이트·제어 글자는 버리고, 8비트 바이트는 코드 페이지로
  const textRun = (a, b) => {
    while (ucSkip > 0 && a < b) { const x = u8[a++]; if (x !== 13 && x !== 10) ucSkip--; }
    if (a >= b || !ACCEPTS[st.dest]) return;
    // 두 바이트 글자의 뒷바이트가 맨 글자로 온 경우
    if (pendTrail && u8[a] >= 0x40 && u8[a] <= 0x7e) { pushPlain(u8[a], pendDec); a++; }
    let s = a;
    for (let k = a; k < b; k++) {
      const x = u8[k];
      if (x >= 0x20 && x < 0x7f) continue;
      if (k > s) putAscii(s, k);
      if (x >= 0x80) {
        pushByte(x);
        if (pendTrail && k + 1 < b && u8[k + 1] >= 0x40 && u8[k + 1] <= 0x7e) { pushPlain(u8[k + 1], pendDec); k++; }
      } else if (x === 9) put('\t');
      s = k + 1;
    }
    if (b > s) putAscii(s, b);
  };

  // 새 이야기(각주·머리말·글상자)로 들어간다: 문단 속성은 새로
  const enterStory = (story, end) => {
    st.story = story;
    st.dest = D_TEXT;
    st.live = 0;
    st.end = end;
    st.field = null;
    resetPara(st);
  };

  // 컨테이너(도형·필드·개체 등): 제 글은 버리고, 안쪽 글 목적지만 살린다
  const enterCont = () => {
    st.live = st.dest === D_TEXT || st.dest === D_LABEL ? st.dest : st.dest === D_CONT ? st.live : 0;
    st.dest = st.live ? D_CONT : D_SKIP;
  };

  // 묶음이 끝날 때
  const endGroup = (g) => {
    switch (g.end) {
      case E_FIELD: {
        // 결과가 비어 있는 SYMBOL 필드는 기호를 넣는다(워드가 결과를 비워 저장한다)
        const f = g.field;
        if (!f || !f.live || !/^\s*SYMBOL\b/i.test(f.inst)) break;
        const now = f.live === D_LABEL ? labelBuf.length : f.story.parts.length;
        if (f.mark >= 0 && !(f.story.paraNo === f.paraNo && now === f.mark)) break;
        const ch = symbolField(f.inst, ansiCp);
        if (ch && st.dest === f.live) put(ch);
        break;
      }
      case E_NOTE: {
        const s = g.story;
        s.finish(g);
        s.note.s = s.textLines().join('\n').trim();
        break;
      }
      case E_HF: {
        const s = g.story;
        s.finish(g);
        for (const line of s.textLines()) if (line.trim()) main.blocks.push({ t: 'p', segs: [{ s: line.trim(), pg: P.page }], joins: '', lvl: 0, kind: 'hf', gap: 0 });
        break;
      }
      case E_BOX: {
        const s = g.story;
        s.finish(g);
        const lines = s.textLines().map((x) => x.trim()).filter(Boolean);
        if (lines.length && st.story) st.story.extra.push(lines.join('\n'));
        break;
      }
      case E_LABEL:
        if (st.story && st.story.label == null) st.story.label = cleanLabel(labelBuf);
        labelBuf = '';
        break;
      case E_STYLE:
        if (curStyle && curStyle.para) styles.set(curStyle.id, curStyle);
        curStyle = null;
        break;
      case E_FONTTBL:
        for (const f of fonts.values()) {
          const name = f.name.trim();
          f.name = name;
          if (/^symbol$/i.test(name)) f.sym = SYM_DEC;
          else if (f.cs === 2 || /^(wingdings( [23])?|webdings)$/i.test(name)) f.sym = /symbol/i.test(name) ? SYM_DEC : WING_DEC;
        }
        fontDecs.clear();
        curFont = null;
        st.dec = null;
        break;
      case E_STYLESHEET: {
        // 바탕 꼴(\sbasedon)을 따라 개요 수준을 찾는다
        for (const s of styles.values()) {
          let o = s.outline, b = s.based, k = 0;
          while (o < 0 && b != null && styles.has(b) && k++ < 20) { const p = styles.get(b); o = p.outline; b = p.based; }
          const name = s.name.trim().toLowerCase();
          s.heading = (o >= 0 && o < 9) || /^(heading|제목)\s*\d/.test(name) || name === 'title';
        }
        break;
      }
      default: break;
    }
  };

  // 제어어 하나
  const word = (code, w, p, hasP) => {
    switch (code) {
      case K_PAR: if (st.dest === D_TEXT) st.story.endPara(st); return;
      case K_SECT:
        if (st.dest !== D_TEXT) return;
        st.story.endPara(st);
        if (st.story.kind === 'main') P.sectPending = true;
        return;
      case K_LINE: softBreak(); return;
      case K_TAB: put('\t'); return;
      case K_PAGE: if (st.dest === D_TEXT) { if (pendLen) flushBytes(); st.story.pageBreak(st); } return;
      case K_CELL: if (st.dest === D_TEXT) { if (pendLen) flushBytes(); st.story.endCell(1); } return;
      case K_NESTCELL: if (st.dest === D_TEXT) { if (pendLen) flushBytes(); st.story.endCell(Math.max(1, st.itap)); } return;
      case K_ROW: if (st.dest === D_TEXT || st.dest === D_CONT) st.story.endRow(1); return;
      case K_NESTROW: if (st.dest === D_TEXT || st.dest === D_CONT) st.story.endRow(Math.max(1, st.itap)); return;
      case K_CHAR: put(CHAR_OUT[w] || ''); return;
      case K_U: {
        let c = hasP ? p : 0;
        if (c < 0) c += 65536;
        if (c >= 0 && c <= 0xffff && ACCEPTS[st.dest]) putUnicode(c);
        ucSkip = st.uc;
        ucOne = st.uc === 1;
        return;
      }
      case K_UC: st.uc = hasP ? Math.max(0, Math.min(p, 16)) : 1; return;
      case K_F:
        if (!hasP) return;
        if (st.dest === D_FONTTBL) {
          curFont = { id: p, cs: -1, cpg: 0, name: '', done: false, sym: null };
          fonts.set(p, curFont);
          st.dec = decoderOf(ansiCp);
        } else if (st.dest !== D_STYLE) {
          st.font = p;
          st.dec = null;
        }
        return;
      case K_FCHARSET:
        if (st.dest === D_FONTTBL && curFont && hasP) {
          curFont.cs = p;
          const cp = CHARSET_CP[p];
          st.dec = decoderOf(cp > 0 ? cp : ansiCp);
        }
        return;
      case K_CPG: if (st.dest === D_FONTTBL && curFont && hasP && p > 0) { curFont.cpg = p; st.dec = decoderOf(p); } return;
      case K_PLAIN: st.font = deff; st.dec = null; st.v = false; st.del = false; st.hide = false; return;
      case K_V: st.v = !hasP || p !== 0; st.hide = st.v || st.del; return;
      case K_DELETED: st.del = !hasP || p !== 0; st.hide = st.v || st.del; return;
      case K_PARD: resetPara(st); return;
      case K_INTBL: st.intbl = !hasP || p !== 0; return;
      case K_ITAP: st.itap = hasP ? Math.max(0, Math.min(p, MAX_ITAP)) : 0; return;
      case K_LI: if (hasP) st.li = p; return;
      case K_FI: if (hasP) st.fi = p; return;
      case K_OUTLINE:
        if (st.dest === D_STYLE) { if (curStyle) curStyle.outline = hasP ? p : -1; } else st.outline = hasP ? p : -1;
        return;
      case K_S:
        if (st.dest === D_STYLE) { if (curStyle) { curStyle.id = hasP ? p : 0; } } else st.style = hasP ? p : 0;
        return;
      case K_CS: if (st.dest === D_STYLE && curStyle) curStyle.para = false; return;
      case K_SBASEDON: if (st.dest === D_STYLE && curStyle && hasP) curStyle.based = p; return;
      case K_PAGEBB: st.pagebb = !hasP || p !== 0; return;
      case K_TROWD: if (st.dest === D_TEXT || st.dest === D_CONT) st.story.newDef(st.nestProps ? Math.max(2, st.itap) : 1); return;
      case K_TRLEFT: if ((st.dest === D_TEXT || st.dest === D_CONT) && hasP) st.story.def().left = p; return;
      case K_CELLX:
        if ((st.dest === D_TEXT || st.dest === D_CONT) && hasP) {
          const d = st.story.def();
          if (d.cells.length < MAX_CELLS) d.cells.push({ x: p, vm: d.cur.vm, hm: d.cur.hm });
          d.cur = { vm: 0, hm: 0 };
        }
        return;
      case K_CLVMGF: if (st.dest === D_TEXT || st.dest === D_CONT) st.story.def().cur.vm = 1; return;
      case K_CLVMRG: if (st.dest === D_TEXT || st.dest === D_CONT) st.story.def().cur.vm = 2; return;
      case K_CLMGF: if (st.dest === D_TEXT || st.dest === D_CONT) st.story.def().cur.hm = 1; return;
      case K_CLMRG: if (st.dest === D_TEXT || st.dest === D_CONT) st.story.def().cur.hm = 2; return;
      case K_SECTD: P.sectBreak = 1; return;
      case K_SBKNONE: P.sectBreak = 0; return;
      case K_SBKPAGE: P.sectBreak = 1; return;
      case K_ANSI: ansiCp = 1252; fontDecs.clear(); return;
      case K_MAC: ansiCp = 10000; fontDecs.clear(); return;
      case K_PC: ansiCp = 437; fontDecs.clear(); return;
      case K_PCA: ansiCp = 850; fontDecs.clear(); return;
      case K_ANSICPG: if (hasP && p > 0) { ansiCp = p; fontDecs.clear(); st.dec = null; } return;
      case K_DEFF: if (hasP) { deff = p; st.font = p; st.dec = null; } return;
      case K_NOFPAGES: if (hasP && p > 0 && p < 1e6) nofpages = p; return;
      // ─── 목적지 ───
      case K_FONTTBL: st.dest = D_FONTTBL; st.end = E_FONTTBL; return;
      case K_STYLESHEET: st.dest = D_STYLESHEET; st.end = E_STYLESHEET; return;
      case K_INFO: st.dest = D_INFO; return;
      case K_FIELD: {
        const live = st.dest === D_TEXT || st.dest === D_LABEL ? st.dest : 0;
        st.field = { inst: '', live, story: st.story, mark: -1, paraNo: -1 };
        st.dest = live ? D_CONT : D_SKIP;
        st.live = 0;
        st.end = E_FIELD;
        return;
      }
      case K_FLDINST: st.dest = st.field && st.field.live ? D_INST : D_SKIP; return;
      case K_FLDRSLT:
        if (st.field && st.field.live) {
          st.dest = st.field.live;
          st.field.mark = st.field.live === D_LABEL ? labelBuf.length : st.story.parts.length;
          st.field.paraNo = st.story.paraNo;
        } else if (!(st.dest === D_TEXT && !st.field)) st.dest = D_SKIP;
        return;
      case K_FOOTNOTE: {
        if (st.dest !== D_TEXT || st.story.kind === 'note') { st.dest = D_SKIP; return; }
        const note = { id: ++noteNo, s: '' };
        notes.push(note);
        put(noteMark(note.id));
        const s = new Story(P, 'note');
        s.note = note;
        enterStory(s, E_NOTE);
        return;
      }
      case K_FTNALT: if (st.story.note) st.story.note.end = true; return;
      case K_HEADER:
        if (st.dest !== D_TEXT || st.story !== main) { st.dest = D_SKIP; return; }
        if (pendLen) flushBytes();
        enterStory(new Story(P, 'hf'), E_HF);
        return;
      case K_LISTTEXT:
        if (st.dest !== D_TEXT) { st.dest = D_SKIP; return; }
        st.dest = D_LABEL;
        labelBuf = '';
        st.end = E_LABEL;
        return;
      case K_SHP:
        enterCont();
        st.shape = { had: false };
        return;
      case K_SHPINST: if (st.dest === D_TEXT) { st.live = D_TEXT; st.dest = D_CONT; } else if (st.dest !== D_CONT) st.dest = D_SKIP; return;
      case K_SHPTXT: {
        const live = st.dest === D_CONT ? st.live : st.dest === D_TEXT ? D_TEXT : 0;
        if (live !== D_TEXT) { st.dest = D_SKIP; return; }
        if (st.shape) st.shape.had = true;
        enterStory(new Story(P, 'box'), E_BOX);
        return;
      }
      case K_SHPRSLT:
        // 도형 글을 이미 읽었으면 대신 그림(같은 글)은 버린다
        if (st.shape && st.shape.had) st.dest = D_SKIP;
        else enterCont();
        return;
      case K_RESULT: if (st.dest === D_CONT && st.live) st.dest = st.live; else if (st.dest !== D_TEXT) st.dest = D_SKIP; return;
      case K_UPR:
        // 글꼴표·꼴 목록 안에서는 앞쪽(ANSI) 항목을 그대로 읽고 \ud 쪽은 버린다
        if (st.dest !== D_FONTTBL && st.dest !== D_STYLE) enterCont();
        return;
      case K_UD: if (st.dest === D_CONT && st.live) st.dest = st.live; else if (st.dest !== D_TEXT) st.dest = D_SKIP; return;
      case K_NESTPROPS: st.nestProps = true; st.dest = st.dest === D_TEXT || st.dest === D_CONT ? D_CONT : D_SKIP; return;
      case K_SKIP: st.dest = D_SKIP; return;
      default: break;
    }
  };

  // ─── 훑기 ───
  const step = Math.max(1 << 20, Math.floor(n / 50));
  let nextProg = step;
  let ended = false;
  let finalSt = null; // 끝날 때의 묶음 상태(남은 문단의 속성)
  while (i < n) {
    const c = u8[i];
    if (c === 0x7b) { // {
      if (pendLen) flushBytes();
      ucSkip = 0;
      if (stack.length >= MAX_DEPTH) phantom++;
      else {
        stack.push(st);
        const parent = st;
        st = cloneState(parent);
        // 글꼴표·꼴 목록 안의 작은 묶음은 항목 하나
        if (parent.dest === D_STYLESHEET) {
          st.dest = D_STYLE;
          curStyle = { id: 0, name: '', outline: -1, based: null, para: true, done: false, heading: false };
          st.end = E_STYLE;
          st.dec = null;
        }
      }
      star = false;
      i++;
      if (i >= nextProg) { nextProg += step; if (onProgress) onProgress(i / n); }
      continue;
    }
    if (c === 0x7d) { // }
      if (pendLen) flushBytes();
      ucSkip = 0;
      star = false;
      i++;
      if (phantom) { phantom--; continue; }
      if (!stack.length) { ended = true; break; }
      const g = st;
      st = stack.pop();
      if (g.end) endGroup(g);
      if (!stack.length) { ended = true; finalSt = g; break; } // 맨 바깥 묶음이 닫혔다
      continue;
    }
    if (c === 0x5c) { // 역빗금
      const c2 = i + 1 < n ? u8[i + 1] : 0;
      if ((c2 >= 0x61 && c2 <= 0x7a) || (c2 >= 0x41 && c2 <= 0x5a)) {
        // 제어어: 글자 32개까지, 숫자 매개변수(부호 포함), 뒤의 빈칸 하나는 구분자
        let j = i + 1, h = 0;
        while (j < n && j - i <= 32) {
          const x = u8[j];
          if ((x >= 0x61 && x <= 0x7a) || (x >= 0x41 && x <= 0x5a)) { h = (Math.imul(h, 31) + x) | 0; j++; } else break;
        }
        const wEnd = j;
        let p = 0, hasP = false;
        if (j < n && (u8[j] === 0x2d || (u8[j] >= 0x30 && u8[j] <= 0x39))) {
          const neg = u8[j] === 0x2d;
          let k = neg ? j + 1 : j, v = 0, digits = 0;
          while (k < n && u8[k] >= 0x30 && u8[k] <= 0x39) { if (digits < 10) v = v * 10 + (u8[k] - 0x30); digits++; k++; }
          if (digits) { p = neg ? -v : v; hasP = true; j = k; }
        }
        if (j < n && u8[j] === 0x20) j++;
        // 건너뛰는 곳: \bin 만 본다
        if (st.dest === D_SKIP) {
          if (wEnd - i === 4 && u8[i + 1] === 0x62 && u8[i + 2] === 0x69 && u8[i + 3] === 0x6e && hasP && p > 0) j = Math.min(n, j + p);
          i = j;
          star = false;
          continue;
        }
        const e = findWord(u8, i + 1, wEnd, h);
        i = j;
        if (pendLen) flushBytes();
        if (e && e.code === K_BIN) { if (hasP && p > 0) i = Math.min(n, i + p); star = false; continue; }
        if (ucSkip > 0) { ucSkip--; star = false; continue; } // 대신 글자로 쓴 제어어
        if (star) {
          star = false;
          if (!e) { st.dest = D_SKIP; continue; }
        }
        if (e) word(e.code, e.w, p, hasP);
        continue;
      }
      // 제어 기호
      if (c2 === 0x27) { // \'hh
        const h1 = hexVal(i + 2 < n ? u8[i + 2] : 0), h2 = hexVal(i + 3 < n ? u8[i + 3] : 0);
        if (h1 < 0) { i += 2; continue; }
        const byte = h2 < 0 ? h1 : h1 * 16 + h2;
        i += h2 < 0 ? 3 : 4;
        star = false;
        if (st.dest === D_SKIP) continue;
        if (ucSkip > 0) {
          // \uc1 이라 해 놓고 대신 글자를 두 바이트로 쓴 경우: 첫 바이트 뒤의 \'hh 하나도 건너뛴다
          if (--ucSkip === 0 && ucOne && ACCEPTS[st.dest] && u8[i] === 0x5c && u8[i + 1] === 0x27) {
            const d = curDec();
            if (d.kind === 2 && d.lead(byte)) i += 4;
          }
          continue;
        }
        if (ACCEPTS[st.dest]) pushByte(byte);
        continue;
      }
      i += 2;
      if (st.dest === D_SKIP) { star = false; continue; }
      if (c2 === 0x2a) { star = true; continue; } // \*
      if (ucSkip > 0) { ucSkip--; continue; }
      switch (c2) {
        case 0x5c: put('\\'); break;
        case 0x7b: put('{'); break;
        case 0x7d: put('}'); break;
        case 0x7e: put(' '); break; // \~ 묶음 빈칸
        case 0x5f: put('-'); break; // \_ 묶음 하이픈
        case 0x0d: case 0x0a: if (st.dest === D_TEXT) { if (pendLen) flushBytes(); st.story.endPara(st); } break; // 역빗금+줄바꿈 = \par
        case 0x09: put('\t'); break;
        default: break; // \- 선택 하이픈, \: 색인, \| 수식 등
      }
      continue;
    }
    // 맨 글
    let j = i + 1;
    while (j < n) { const x = u8[j]; if (x === 0x5c || x === 0x7b || x === 0x7d) break; j++; }
    if (st.dest !== D_SKIP) textRun(i, j);
    i = j;
  }
  if (pendLen) flushBytes();
  const warnings = [];
  // 잘린 파일: 열린 묶음을 차례로 닫는다
  if (!ended) {
    finalSt = st;
    if (stack.length > 1) warnings.push('파일 끝이 잘려 있어 일부만 읽었을 수 있습니다');
    while (stack.length) {
      const g = st;
      st = stack.pop();
      if (g.end) endGroup(g);
    }
  }
  main.finish(finalSt || st);
  finishLevels(main.blocks, P.xs);
  if (onProgress) onProgress(1);

  const doc = {
    format: 'rtf',
    pages: Math.max(P.page, nofpages),
    pageExact: false,
    blocks: main.blocks,
    notes,
    warnings,
  };
  resolveSoftBreaks(doc);
  return doc;
}

function hexVal(x) {
  if (x >= 0x30 && x <= 0x39) return x - 0x30;
  if (x >= 0x61 && x <= 0x66) return x - 0x57;
  if (x >= 0x41 && x <= 0x46) return x - 0x37;
  return -1;
}

// SYMBOL 필드 → 글자: SYMBOL 183 \f "Symbol" \s 11, SYMBOL 0xF0B7 \u
function symbolField(inst, ansiCp) {
  const m = inst.match(/SYMBOL\s+(0x[0-9a-f]+|\d+)/i);
  if (!m) return '';
  const code = m[1].toLowerCase().startsWith('0x') ? parseInt(m[1], 16) : parseInt(m[1], 10);
  if (!(code > 0 && code <= 0xffff)) return '';
  const fm = inst.match(/\\f\s+"([^"]*)"|\\f\s+([^\s\\]+)/i);
  const font = fm ? (fm[1] ?? fm[2] ?? '').trim() : '';
  const low = code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code;
  if (/^symbol$/i.test(font)) return low < 256 ? symbolChar(low, 'symbol') : String.fromCharCode(code);
  if (/^(wingdings( [23])?|webdings)$/i.test(font)) return low < 256 ? symbolChar(low, 'wing') : String.fromCharCode(code);
  if (/\\u\b/i.test(inst) || code >= 256) return String.fromCharCode(code);
  if (code < 0x80) return String.fromCharCode(code);
  return decodeBytes(decoderOf(ansiCp), Uint8Array.of(code), 1);
}
