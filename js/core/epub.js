// EPUB(전자책) → 문서 모델 — 압축을 풀어(container.xml → OPF) 읽는 순서(spine)대로 본문(XHTML)을 훑는다.
// 쪽은 어림(장마다 새 쪽 + 글자 수)이고, DRE 가 만든 PDF 가 있으면 align.js 가 실제 쪽에 맞춘다.
// 책 정보 읽기(openZip·readEpub·decodeText)는 PDF 만들기(epubhtml.js)와 함께 쓴다.
import { unzipSync } from '../../vendor/fflate.mjs';
import { parseXml, kids, kid, attr, descendants, textOf } from './xml.js';
import { noteMark } from './model.js';
import { resolveSoftBreaks } from './joiner.js';

export class EpubError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => new EpubError(code, message);

const SOFT_BREAK = '\u2028'; // 줄 잇기 판단(joiner.resolveSoftBreaks)이 띄움·붙임·줄 유지를 정한다
const MAX_TOTAL = 1536 * 1024 * 1024; // 압축을 푼 크기 상한(압축 폭탄 막이)
export const MAX_DOC = 64 * 1024 * 1024; // 본문 장 하나의 상한(실제 책은 장마다 5MB 안쪽 — 이보다 크면 건너뛴다)
// 쪽 어림: A4(PDF 만들기와 같은 판)에서 한 쪽에 드는 글자 수와, 그림 한 장이 차지하는 쪽(파일 크기로 가늠: √(크기/기준), 0.05~0.8쪽).
// 책 CSS 에 따라 실제로는 쪽당 600~2,000자로 크게 다르다 — 어림일 뿐이고, DRE 가 켜져 있으면 실제 PDF 쪽에 맞춘다(align.js).
// 값은 실제 책 13권을 엣지로 인쇄한 쪽 수에 맞춘 것(평균 오차 약 13% — tools/epub_pagefit.mjs, 시험 때만 __DRE_EPUB_TUNE 으로 바꿔 본다)
const TUNE = globalThis.__DRE_EPUB_TUNE || {};
const CPP = TUNE.cpp ?? 1850;
const IMG_REF = TUNE.imgRef ?? 700000;

// ─── 경로 ───
export function normPath(p) {
  const out = [];
  for (const s of String(p).replace(/\\/g, '/').split('/')) {
    if (s === '..') out.pop();
    else if (s && s !== '.') out.push(s);
  }
  return out.join('/');
}
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}
// 책 속 상대 주소 → 압축 속 경로(밖 주소·data: 등은 null). 조각(#…)은 frag 로
export function resolveHref(base, href) {
  const h = String(href || '').trim();
  if (!h || /^[a-z][a-z0-9+.-]*:/i.test(h)) return null;
  const hash = h.indexOf('#');
  const file = (hash < 0 ? h : h.slice(0, hash)).split('?')[0];
  const frag = hash < 0 ? '' : safeDecode(h.slice(hash + 1));
  const path = !file ? base : file.startsWith('/') ? normPath(safeDecode(file)) : normPath(dirOf(base) + safeDecode(file));
  return { path, frag };
}

// ─── 압축 ───
// 이름 목록만 먼저 읽고, 필요한 파일만 그때그때 푼다(그림·글꼴을 안 풀면 글 뽑기가 가볍다)
export function openZip(bytes) {
  const names = [];
  const sizes = new Map();
  let total = 0;
  try {
    unzipSync(bytes, { filter: (f) => { names.push(f.name); sizes.set(f.name, f.originalSize || 0); total += f.originalSize || 0; return false; } });
  } catch {
    throw fail('broken', 'EPUB 압축을 풀지 못했습니다(손상된 파일일 수 있습니다)');
  }
  if (total > MAX_TOTAL) throw fail('broken', '압축을 푼 크기가 너무 큽니다(안전 검사)');
  const lower = new Map();
  for (const n of names) if (!lower.has(n.toLowerCase())) lower.set(n.toLowerCase(), n);
  const find = (p) => (p == null ? null : sizes.has(p) ? p : lower.get(String(p).toLowerCase()) || null);
  const cache = new Map();
  const unzipSome = (want) => {
    try {
      return unzipSync(bytes, { filter: (f) => want.has(f.name) });
    } catch {
      // 하나가 망가져도 나머지는 살린다
      const out = {};
      for (const n of want) {
        try { Object.assign(out, unzipSync(bytes, { filter: (f) => f.name === n })); } catch { /* 이 파일만 못 읽음 */ }
      }
      return out;
    }
  };
  const take = (list) => {
    const want = new Set();
    for (const p of list) { const n = find(p); if (n && !cache.has(n)) want.add(n); }
    if (!want.size) return;
    const got = unzipSome(want);
    for (const n of want) cache.set(n, got[n] || null);
  };
  const get = (p) => {
    const n = find(p);
    if (!n) return null;
    if (!cache.has(n)) take([n]);
    return cache.get(n);
  };
  const drop = (p) => { const n = find(p); if (n) cache.delete(n); };
  return { names, sizes, find, get, take, drop };
}

// ─── 글자 풀기: BOM → XML 선언·meta charset → UTF-8(안 되면 EUC-KR) ───
export function decodeText(u8) {
  if (!u8 || !u8.length) return '';
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  if (u8[0] === 0x3c && u8[1] === 0x00) return new TextDecoder('utf-16le').decode(u8);
  if (u8[0] === 0x00 && u8[1] === 0x3c) return new TextDecoder('utf-16be').decode(u8);
  let head = '';
  for (let i = 0; i < Math.min(u8.length, 1024); i++) head += String.fromCharCode(u8[i]);
  const m = /^\s*<\?xml[^>]*?encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head) || /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
  let cs = m ? m[1].toLowerCase() : 'utf-8';
  if (/^(ks_c_5601|ksc5601|cp949|x-windows-949|windows-949|uhc|euc-?kr)/.test(cs)) cs = 'euc-kr';
  if (/^(utf-?8|us-ascii|ascii)$/.test(cs)) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { /* 아래로 */ }
    try { return new TextDecoder('euc-kr', { fatal: true }).decode(u8); } catch { return new TextDecoder('utf-8').decode(u8); }
  }
  try { return new TextDecoder(cs).decode(u8); } catch { return new TextDecoder('utf-8').decode(u8); }
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// 글꼴 난독화(배포용 글꼴 보호 — DRM 아님) 방식
export const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

// ─── 책 정보(OPF) ───
export function readEpub(zip) {
  const cont = zip.get('META-INF/container.xml');
  let opfPath = null;
  if (cont) {
    const croot = parseXml(decodeText(cont), { htmlEntities: true, maxDepth: 256 });
    const rfs = descendants(croot, 'rootfile');
    const rf = rfs.find((r) => /oebps-package/i.test(attr(r, 'media-type') || '')) || rfs[0];
    if (rf && attr(rf, 'full-path')) opfPath = zip.find(normPath(safeDecode(attr(rf, 'full-path'))));
  }
  if (!opfPath) opfPath = zip.names.find((n) => /\.opf$/i.test(n)) || null;
  if (!opfPath) throw fail('broken', '전자책 정보 파일(OPF)을 찾지 못했습니다');
  const opf = parseXml(decodeText(zip.get(opfPath)), { htmlEntities: true, maxDepth: 256 });
  const pkgEl = descendants(opf, 'package')[0] || opf;
  const meta = descendants(opf, 'metadata')[0] || null;
  const dc = (name) => descendants(meta, name).map((e) => clean(textOf(e))).filter(Boolean);
  const uidRef = attr(pkgEl, 'unique-identifier');
  const ids = descendants(meta, 'identifier');
  const uidEl = ids.find((e) => attr(e, 'id') === uidRef) || ids[0];
  let layout = 'reflowable';
  for (const m of descendants(meta, 'meta')) {
    const prop = attr(m, 'property') || '';
    if (prop === 'rendition:layout') layout = clean(textOf(m)) || layout;
    if ((attr(m, 'name') || '') === 'fixed-layout' && attr(m, 'content') === 'true') layout = 'pre-paginated';
  }
  const manifest = new Map();
  const byPath = new Map();
  for (const it of descendants(opf, 'item')) {
    const id = attr(it, 'id');
    const href = attr(it, 'href');
    if (!id || !href) continue;
    const r = resolveHref(opfPath, href);
    if (!r) continue;
    const path = zip.find(r.path) || r.path;
    const rec = { id, href, path, type: (attr(it, 'media-type') || '').toLowerCase(), props: (attr(it, 'properties') || '').split(/\s+/).filter(Boolean), fallback: attr(it, 'fallback') };
    manifest.set(id, rec);
    if (!byPath.has(path)) byPath.set(path, rec);
  }
  const spineEl = descendants(opf, 'spine')[0] || null;
  const spine = [];
  const later = [];
  for (const ref of descendants(spineEl, 'itemref')) {
    let item = manifest.get(attr(ref, 'idref'));
    // 본문이 아닌 항목은 대체 항목(fallback)으로
    for (let k = 0; item && !isContent(item) && item.fallback && k < 5; k++) item = manifest.get(item.fallback);
    if (!item || !isContent(item)) continue;
    const props = (attr(ref, 'properties') || '').split(/\s+/).filter(Boolean);
    const entry = { item, path: item.path, linear: attr(ref, 'linear') !== 'no', props };
    (entry.linear ? spine : later).push(entry);
  }
  // 따로 읽는 항목(linear="no")은 끝에 붙인다
  spine.push(...later);
  if (!spine.length) {
    // 읽는 순서가 없으면 목록에 있는 본문들을 차례대로(망가진 책)
    for (const it of manifest.values()) if (isContent(it) && !it.props.includes('nav')) spine.push({ item: it, path: it.path, linear: true, props: [] });
  }
  // 암호(encryption.xml): 글꼴 난독화는 풀 수 있고, 그 밖의 암호는 DRM
  const encrypted = new Map();
  const encBytes = zip.get('META-INF/encryption.xml');
  if (encBytes) {
    const enc = parseXml(decodeText(encBytes), { htmlEntities: true, maxDepth: 256 });
    for (const d of descendants(enc, 'EncryptedData')) {
      const alg = attr(descendants(d, 'EncryptionMethod')[0], 'Algorithm') || '';
      const uri = attr(descendants(d, 'CipherReference')[0], 'URI') || '';
      if (!uri) continue;
      const p = zip.find(normPath(safeDecode(uri))) || normPath(safeDecode(uri));
      encrypted.set(p, alg);
    }
  }
  const navItem = [...manifest.values()].find((i) => i.props.includes('nav')) || null;
  const ncxItem = (spineEl && manifest.get(attr(spineEl, 'toc'))) || [...manifest.values()].find((i) => i.type === 'application/x-dtbncx+xml') || null;
  return {
    opfPath, version: attr(pkgEl, 'version') || '', title: dc('title')[0] || '', creators: dc('creator'), lang: dc('language')[0] || '',
    uid: uidEl ? clean(textOf(uidEl)) : '', layout, ppd: attr(spineEl, 'page-progression-direction') || '',
    manifest, byPath, spine, encrypted, navItem, ncxItem,
  };
}

function isContent(item) {
  return /xhtml|html|svg\+xml|dtbook/.test(item.type) || (!item.type && /\.(x?html?|xht)$/i.test(item.path)) || /\.(x?html?|xht)$/i.test(item.path) && !/image|font|css/.test(item.type);
}

// 본문이 DRM 으로 잠겼나(글꼴 난독화만 있으면 아님)
export function drmLocked(book, zip) {
  for (const [p, alg] of book.encrypted) {
    if (FONT_OBFUSCATION.has(alg)) continue;
    if (book.spine.some((s) => s.path === p) || /\.(x?html?|xht|css|opf|ncx)$/i.test(p)) return true;
  }
  // 애플(FairPlay)·어도비 권리 파일이 있고 본문이 XML 같지 않으면 잠긴 것
  if (zip.find('META-INF/sinf.xml') || zip.find('META-INF/rights.xml')) {
    const first = book.spine[0] && zip.get(book.spine[0].path);
    if (first && !/^\s*(?:\ufeff)?\s*</.test(decodeText(first.subarray(0, 256)))) return true;
  }
  return false;
}

const HIDE_DECL = /(?:^|[;{])\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0*)?\s*(?:;|!|$))/i;

// ─── 책 CSS 에서 몇 가지만: 감춤(display:none 등)·글머리표 없음 ───
// 단순 선택자(태그·.이름·태그.이름·#아이디)만 본다. 감춤은 조상 선택자가 없는 규칙만(잘못 감추면 글이 사라진다)
export function cssHints(cssText, hints = newHints()) {
  const src = String(cssText || '').replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0, start = 0, sel = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      if (depth === 0) sel = src.slice(start, i).trim();
      depth++;
      if (depth === 1) start = i + 1;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        if (sel && sel[0] !== '@') addRule(hints, sel, src.slice(start, i));
        start = i + 1;
      }
      if (depth < 0) { depth = 0; start = i + 1; }
    }
  }
  return hints;
}
function newHints() {
  return { hide: new Set(), noBullet: new Set(), sup: new Set() };
}
function addRule(hints, selText, decls) {
  // 감춤: 안 보이게(display:none), 자리만 차지(visibility:hidden), 투명(opacity:0 — 줄 맞춤용 보이지 않는 글)
  const hide = HIDE_DECL.test(decls);
  const noBullet = /(?:^|;)\s*list-style(?:-type)?\s*:\s*none\b/i.test(decls);
  // 위로 올린 글자(vertical-align: super·top 이나 양수 길이) — <sup> 처럼 다룬다(각주 번호 '1)' 등)
  const sup = /(?:^|;)\s*vertical-align\s*:\s*(?:super|top|text-top|\+?(?:0*[1-9]\d*(?:\.\d+)?|0*\.\d*[1-9]\d*)(?:em|ex|px|pt|%))/i.test(decls);
  if (!hide && !noBullet && !sup) return;
  for (let s of selText.split(',')) {
    s = s.trim();
    if (!s || /:/.test(s)) continue; // :hover·::before 같은 것은 건너뛴다
    const parts = s.split(/\s*[\s>+~]\s*/).filter(Boolean);
    const last = parts[parts.length - 1];
    if (!/^[a-z0-9_-]*(?:[.#][\w-]+)*$/i.test(last)) continue;
    if (hide && parts.length === 1) hints.hide.add(last.toLowerCase());
    if (noBullet) hints.noBullet.add(last.toLowerCase());
    if (sup && /[.#]/.test(last)) hints.sup.add(last.toLowerCase()); // 태그 이름만으로는 안 건다
  }
}
function matchSimple(el, set) {
  if (!set || !set.size) return false;
  const tag = el.l;
  const id = el.a.id;
  const cls = (el.a.class || '').split(/\s+/).filter(Boolean).map((c) => c.toLowerCase());
  if (set.has(tag)) return true;
  if (id && (set.has('#' + id.toLowerCase()) || set.has(tag + '#' + id.toLowerCase()))) return true;
  for (const c of cls) if (set.has('.' + c) || set.has(tag + '.' + c)) return true;
  if (cls.length > 1) {
    for (const s of set) {
      const m = /^([a-z0-9_-]*)((?:\.[\w-]+){2,})$/i.exec(s);
      if (m && (!m[1] || m[1] === tag) && m[2].slice(1).split('.').every((c) => cls.includes(c))) return true;
    }
  }
  return false;
}

// ─── 본문 훑기 ───
const BLOCK = new Set(['p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'figure', 'address', 'center', 'details', 'summary',
  'dialog', 'hgroup', 'fieldset', 'legend', 'form', 'body', 'noscript', 'search']);
const SKIP = new Set(['head', 'script', 'style', 'template', 'title', 'meta', 'link', 'base', 'object', 'embed', 'iframe', 'frame', 'frameset', 'applet',
  'audio', 'video', 'canvas', 'map', 'area', 'input', 'select', 'textarea', 'option', 'datalist', 'source', 'track', 'param', 'col', 'colgroup', 'wbr', 'rt', 'rp']);
const NOTE_TYPE = /(?:^|\s)(?:footnote|endnote|rearnote|note)(?:\s|$)/;
const NOTE_ROLE = /(?:^|\s)doc-(?:footnote|endnote)(?:\s|$)/;
const REF_TYPE = /(?:^|\s)noteref(?:\s|$)/;
const BACKLINK = /(?:^|\s)(?:doc-)?backlink(?:\s|$)/;
// 방점·강조 점으로 쓴 루비 글자(이것만 있으면 루비 글을 버린다)
const EMPHASIS = /^[•·・‧∙⋅˙゜﹅﹆●○◦．･.,'`]$/;
const HANJA_HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣㐀-䶿一-鿿豈-﫿]/;
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎', n: 'ₙ' };

const epubType = (el) => el.a['epub:type'] || el.a['ops:type'] || '';
const isNoteEl = (el) => NOTE_TYPE.test(epubType(el)) || NOTE_ROLE.test(el.a.role || '');
const isNoteRef = (el) => REF_TYPE.test(epubType(el)) || /(?:^|\s)doc-noteref(?:\s|$)/.test(el.a.role || '');
const isBacklink = (el) => BACKLINK.test(epubType(el)) || BACKLINK.test(el.a.role || '');

function roman(n) {
  if (n <= 0 || n >= 4000) return String(n);
  const t = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
}
function alpha(n) {
  if (n <= 0) return String(n);
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}
function listNumber(n, type) {
  switch (type) {
    case 'a': return alpha(n);
    case 'A': return alpha(n).toUpperCase();
    case 'i': return roman(n);
    case 'I': return roman(n).toUpperCase();
    default: return String(n);
  }
}
const toScript = (s, map) => [...s].map((c) => map[c] || c).join('');

// 책 전체가 함께 쓰는 것: 각주, 쪽 세기, 문서별 CSS 단서
class Book {
  constructor() {
    this.notes = [];
    this.noteIds = new Map(); // 각주 요소 → 번호
    this.noteEls = new Map(); // '경로#id' → 각주 요소(가리키는 곳이 각주 안이면 그 각주)
    this.referenced = new Set(); // noteref 가 가리키는 각주 요소(본문 흐름에서는 뺀다)
    this.page = 1;
    this.chars = 0;
  }
  advance(n) {
    this.chars += n;
    while (this.chars > CPP) { this.page++; this.chars -= CPP; }
  }
  newPage() {
    if (this.chars > 0) { this.page++; this.chars = 0; }
  }
}

class Walker {
  constructor(book, { hints, path, noteMode = false, count = true } = {}) {
    this.book = book;
    this.count = count; // 쪽 어림에 글자 수를 더하나(표 칸·각주 글을 모을 때는 안 더한다)
    this.hints = hints || newHints();
    this.path = path || '';
    this.noteMode = noteMode; // 각주 글 모으기(되돌아가기 연결은 뺀다)
    this.blocks = [];
    this.cur = null;
    this.lvl = 0;
    this.lists = [];
    this.pre = 0;
    this.carry = null; // 비어 있던 목록 줄의 글머리표(다음 문단에 붙인다)
    this.pendingGap = 0;
  }

  open(kind = '', lvl = this.lvl + this.lists.length) {
    this.cur = { t: '', kind, lvl, label: '', pre: this.pre > 0 };
    if (this.carry) { Object.assign(this.cur, this.carry); this.carry = null; }
  }

  text(s) {
    if (!s) return;
    if (!this.cur) {
      if (!this.pre && !/[^ \t\n\r\f]/.test(s)) return; // 블록 사이 공백
      this.open();
    }
    if (this.pre) { this.cur.t += s.replace(/\r\n?/g, '\n'); return; }
    let t = s.replace(/[ \t\n\r\f]+/g, ' ');
    if (t[0] === ' ') {
      const c = this.cur.t;
      if (!c || c.endsWith(' ') || c.endsWith(SOFT_BREAK) || c.endsWith('\n')) t = t.slice(1);
    }
    this.cur.t += t;
  }

  // 문단 마감. 글이 있으면 블록으로 내고 true
  flush() {
    const c = this.cur;
    this.cur = null;
    if (!c) return false;
    let t = c.t;
    if (c.pre) t = t.replace(/^\n+|\s+$/g, '');
    else t = t.replace(/ *\u2028 */g, SOFT_BREAK).replace(/^[ \u2028]+|[ \u2028]+$/g, '');
    t = t.replace(/\u00a0/g, ' ').replace(/\u00ad/g, '');
    if (!c.pre) t = t.replace(/^ +| +$/g, '');
    if (!t.replace(/[\s\u200b\u2028\u3000]/g, '')) {
      if (c.label && !this.carry) this.carry = { kind: c.kind, lvl: c.lvl, label: c.label };
      return false;
    }
    const gap = this.pendingGap || (c.kind === 'h' && this.blocks.length) ? 1 : 0;
    this.pendingGap = 0;
    this.blocks.push({ t: 'p', segs: [{ s: (c.label || '') + t, pg: this.book.page }], joins: '', lvl: c.lvl, kind: c.kind, gap });
    if (this.count) this.book.advance(t.length + 40);
    return true;
  }

  walk(el) {
    for (const c of el.c) {
      if (typeof c === 'string') this.text(c);
      else this.element(c);
    }
  }

  hidden(el) {
    if ('hidden' in el.a) return true;
    const st = el.a.style;
    if (st && HIDE_DECL.test(st)) return true;
    return matchSimple(el, this.hints.hide);
  }

  element(el) {
    const tag = el.l;
    if (SKIP.has(tag)) return;
    if (this.hidden(el)) return;
    if (tag === 'img' || tag === 'image') { if (this.count) this.book.advance(this.imageCost(el)); return; }
    if (this.book.referenced.has(el) && !this.noteMode) return; // 각주 글은 끝 [각주] 로
    if (tag !== 'sup' && tag !== 'sub' && this.hints.sup.size && matchSimple(el, this.hints.sup)) return this.supSub(el, true);
    switch (tag) {
      case 'br': return this.br();
      case 'hr': this.flush(); this.pendingGap = 1; return;
      case 'svg': return this.svg(el);
      case 'math': return this.text(el.a.alttext || textOf(el));
      case 'ruby': return this.ruby(el);
      case 'sup': case 'sub': return this.supSub(el);
      case 'a': return this.anchor(el);
      case 'q': this.text('“'); this.walk(el); this.text('”'); return;
      case 'switch': { const d = kid(el, 'default'); if (d) this.walk(d); return; } // epub:switch → 기본 내용
      case 'table': return this.table(el);
      case 'ul': case 'ol': case 'menu': case 'dir': return this.list(el);
      case 'li': return this.listItem(el);
      case 'dl': this.flush(); this.walk(el); this.flush(); return;
      case 'dt': return this.blockOf(el, '');
      case 'dd': this.flush(); this.lvl++; this.blockOf(el, ''); this.lvl--; return;
      case 'blockquote': this.flush(); this.lvl++; this.walk(el); this.flush(); this.lvl--; return;
      case 'pre': case 'listing': case 'xmp': case 'plaintext': this.flush(); this.pre++; this.blockOf(el, ''); this.pre--; return;
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return this.blockOf(el, 'h');
      case 'caption': case 'figcaption': return this.blockOf(el, 'cap');
      case 'p': {
        // 빈 문단(<p><br/></p>, <p>&nbsp;</p>)은 빈 줄
        this.flush();
        const n = this.blocks.length;
        this.open();
        this.walk(el);
        const pushed = this.flush();
        if (!pushed && this.blocks.length === n && !this.carry) this.pendingGap = 1;
        return;
      }
      default:
        if (BLOCK.has(tag)) { this.flush(); this.walk(el); this.flush(); return; }
        this.walk(el); // span·b·i·em·strong·small·font·label… 글 안 요소
    }
  }

  blockOf(el, kind) {
    this.flush();
    this.open(kind);
    this.walk(el);
    this.flush();
  }

  br() {
    if (this.pre) { this.text('\n'); return; }
    if (!this.cur || !this.cur.t.replace(/[ \u00a0]/g, '')) return; // 문단 첫머리 줄바꿈
    if (this.cur.t.endsWith(SOFT_BREAK)) {
      // 줄바꿈 두 번 = 문단 나눔
      this.cur.t = this.cur.t.slice(0, -1);
      const { kind, lvl } = this.cur;
      this.flush();
      this.pendingGap = 1;
      this.open(kind === 'li' ? '' : kind, lvl);
      return;
    }
    this.cur.t = this.cur.t.replace(/ +$/, '') + SOFT_BREAK;
  }

  // 그림이 차지하는 쪽(글자 수로) — 파일이 클수록 크게 그려진다고 본다
  imageCost(el) {
    const r = resolveHref(this.path, el.a.src || el.a['xlink:href'] || el.a.href || '');
    const size = r && this.book.sizeOf ? this.book.sizeOf(r.path) : 0;
    const pages = size ? Math.min(0.8, Math.max(0.05, Math.sqrt(size / IMG_REF))) : 0.3;
    return pages * CPP;
  }

  svg(el) {
    // 그림 속 글(<text>)만 문단으로
    const texts = descendants(el, 'text');
    if (!texts.length) {
      const img = descendants(el, 'image')[0];
      if (this.count) this.book.advance(img ? this.imageCost(img) : 0.3 * CPP);
      return;
    }
    this.flush();
    for (const t of texts) { this.open(); this.text(textOf(t)); this.flush(); }
  }

  // 글 안 요소의 글(감춘 것은 빼고, 위로 올린 숫자는 첨자 글자로) — 루비처럼 문단을 만들지 않고 글만 모을 때
  inlineText(el) {
    let s = '';
    for (const c of el.c) {
      if (typeof c === 'string') { s += c; continue; }
      if (SKIP.has(c.l) || this.hidden(c)) continue;
      const t = this.inlineText(c);
      const raised = c.l === 'sup' || (this.hints.sup.size && matchSimple(c, this.hints.sup));
      s += raised && t.trim().length <= 6 && /^[0-9+\-−=()n]+$/.test(t.trim()) ? toScript(t.trim(), SUP)
        : c.l === 'sub' && t.trim().length <= 6 && /^[0-9+\-−=()n]+$/.test(t.trim()) ? toScript(t.trim(), SUB) : t;
    }
    return s;
  }

  ruby(el) {
    // 바탕 글과 루비 글(rt) 짝. 루비 글이 모두 방점(•)이면 버리고, 한자·읽기면 바탕 글 뒤 괄호에
    const pairs = [];
    let base = '';
    for (const c of el.c) {
      if (typeof c === 'string') { base += c; continue; }
      if (c.l === 'rt' || c.l === 'rtc') { pairs.push({ base, rt: clean(this.inlineText(c)) }); base = ''; continue; }
      if (c.l === 'rp') continue;
      if (!this.hidden(c)) base += this.inlineText(c);
    }
    if (base) pairs.push({ base, rt: '' });
    const marks = pairs.every((p) => !p.rt || EMPHASIS.test(p.rt));
    for (const p of pairs) {
      this.text(p.base);
      if (!marks && p.rt) this.text('(' + p.rt + ')');
    }
  }

  supSub(el, raised = false) {
    const sup = raised || el.l === 'sup';
    const raw = clean(this.inlineText(el));
    if (!raw) return;
    const links = descendants(el, 'a').filter((a) => a.a.href);
    // 각주 번호(위첨자 안 책 속 연결 하나)
    if (sup && links.length === 1 && resolveHref(this.path, links[0].a.href) && raw.length <= 8) {
      if (isNoteRef(links[0]) && this.noteRef(links[0])) return;
      this.text(bracket(raw));
      return;
    }
    // 숫자·기호만: 위·아래 첨자 글자로(m², H₂O, 10⁻³)
    if (raw.length <= 6 && /^[0-9+\-−=()n]+$/.test(raw)) { this.text(toScript(raw, sup ? SUP : SUB)); return; }
    // 한글·한자 바로 뒤에 붙은 원어(전쟁 기계<sup>war machine</sup>) → 괄호로
    const prev = this.cur ? this.cur.t.slice(-1) : '';
    if (prev && HANJA_HANGUL.test(prev) && /^[A-Za-zÀ-ɏ]/.test(raw)) { this.text('(' + raw + ')'); return; }
    this.walk(el);
  }

  anchor(el) {
    if (this.noteMode && isBacklink(el)) return;
    if (isNoteRef(el) && this.noteRef(el)) return;
    // 위첨자 하나만 품은 책 속 연결(<a href="#n1"><sup>1</sup></a>) = 각주 번호
    const kidsEl = kids(el);
    const only = kidsEl.length === 1 && kidsEl[0].l === 'sup' && !el.c.some((c) => typeof c === 'string' && c.trim());
    const raw = clean(textOf(el));
    if (only && raw && raw.length <= 8 && resolveHref(this.path, el.a.href || '')) { this.text(bracket(raw)); return; }
    this.walk(el);
  }

  // 의미 표시가 있는 각주(EPUB3): 끝 [각주] 로 모으고 그 자리엔 표시만. 못 찾으면 false
  noteRef(a) {
    const r = resolveHref(this.path, a.a.href || '');
    if (!r || !r.frag) return false;
    const target = this.book.noteEls.get(r.path + '#' + r.frag);
    if (!target) return false;
    let id = this.book.noteIds.get(target);
    if (id == null) {
      id = this.book.notes.length + 1;
      this.book.noteIds.set(target, id);
      const w = new Walker(this.book, { hints: this.hints, path: target._path || this.path, noteMode: true, count: false });
      w.walk(target);
      w.flush();
      let s = blocksText(w.blocks);
      // 각주 첫머리의 번호(본문 표시와 같은 것)는 뺀다
      const label = clean(textOf(a)).replace(/^[[(]|[\])]$/g, '');
      if (label) s = s.replace(new RegExp('^[\\[(]?' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\])]?[.):]?\\s*'), '');
      this.book.notes.push({ id, s: s.replace(/\u2028/g, ' ') });
    }
    this.text(noteMark(id));
    return true;
  }

  list(el) {
    this.flush();
    const ordered = el.l === 'ol';
    const reversed = 'reversed' in el.a;
    const items = kids(el).filter((k) => k.l === 'li').length;
    const start = parseInt(el.a.start, 10);
    const first = Number.isFinite(start) ? start : reversed ? items : 1;
    const noBullet = matchSimple(el, this.hints.noBullet) || /list-style(?:-type)?\s*:\s*none/i.test(el.a.style || '');
    this.lists.push({ ordered, type: (el.a.type || '1').trim(), n: first - (reversed ? -1 : 1), step: reversed ? -1 : 1, noBullet });
    this.walk(el);
    this.flush();
    this.lists.pop();
    this.carry = null;
  }

  listItem(el) {
    this.flush();
    this.carry = null;
    const L = this.lists[this.lists.length - 1];
    let label = '';
    if (L) {
      const v = parseInt(el.a.value, 10);
      L.n = Number.isFinite(v) ? v : L.n + L.step;
      const none = L.noBullet || matchSimple(el, this.hints.noBullet) || /list-style(?:-type)?\s*:\s*none/i.test(el.a.style || '');
      if (!none) label = L.ordered ? `${listNumber(L.n, L.type)}. ` : '• ';
    }
    this.open('li', this.lvl + Math.max(1, this.lists.length) - 1);
    this.cur.label = label;
    this.walk(el);
    this.flush();
    this.carry = null;
  }

  table(el) {
    this.flush();
    const rowsEl = [];
    let caption = null;
    const take = (parent) => {
      for (const c of kids(parent)) {
        if (this.hidden(c)) continue;
        if (c.l === 'tr') rowsEl.push(c);
        else if (c.l === 'thead' || c.l === 'tbody' || c.l === 'tfoot') take(c);
        else if (c.l === 'caption') caption = c;
      }
    };
    // 머리(thead) → 몸(tbody·tr) → 발(tfoot) 차례로
    const head = kids(el).filter((c) => c.l === 'thead');
    const foot = kids(el).filter((c) => c.l === 'tfoot');
    for (const h of head) take(h);
    for (const c of kids(el)) {
      if (c.l === 'thead' || c.l === 'tfoot') continue;
      if (c.l === 'caption') { caption = c; continue; }
      if (c.l === 'tr') { if (!this.hidden(c)) rowsEl.push(c); } else if (c.l === 'tbody') take(c);
    }
    for (const f of foot) take(f);
    if (caption) this.blockOf(caption, 'cap');
    if (!rowsEl.length) { this.walk({ c: kids(el).filter((c) => !['thead', 'tbody', 'tfoot', 'tr', 'caption'].includes(c.l)) }); return; }
    const rows = [];
    const covered = [];
    let ncol = 0;
    const cellsOf = (tr) => kids(tr).filter((k) => (k.l === 'td' || k.l === 'th') && !this.hidden(k));
    rowsEl.forEach((tr, r) => {
      rows[r] = rows[r] || [];
      covered[r] = covered[r] || [];
      let c = 0;
      for (const td of cellsOf(tr)) {
        while (covered[r][c]) c++;
        const cs = Math.max(1, Math.min(200, parseInt(td.a.colspan, 10) || 1));
        let rs = parseInt(td.a.rowspan, 10);
        rs = rs === 0 ? rowsEl.length - r : Math.max(1, Math.min(rowsEl.length - r, rs || 1));
        rows[r][c] = { s: this.cellText(td), cs, rs };
        for (let i = 0; i < rs; i++) {
          for (let j = 0; j < cs; j++) {
            if (!i && !j) continue;
            (covered[r + i] = covered[r + i] || [])[c + j] = true;
            (rows[r + i] = rows[r + i] || [])[c + j] = null;
          }
        }
        c += cs;
        if (c > ncol) ncol = c;
      }
    });
    for (const row of rows) { for (let i = 0; i < ncol; i++) if (row[i] === undefined) row[i] = null; row.length = ncol; }
    // 한 칸짜리 표(글 상자)는 표가 아니라 속 문단으로
    if (ncol <= 1 && rows.length === 1) {
      const td = cellsOf(rowsEl[0])[0];
      if (td) { this.flush(); this.walk(td); this.flush(); }
      return;
    }
    if (!rows.some((row) => row.some((x) => x && x.s.trim()))) return;
    const gap = 1;
    this.pendingGap = 0;
    this.blocks.push({ t: 'tbl', rows, pg: this.book.page, gap });
    let n = 0;
    for (const row of rows) for (const x of row) if (x) n += x.s.length + 4;
    if (this.count) this.book.advance(n + 40 * rows.length);
  }

  cellText(td) {
    const w = new Walker(this.book, { hints: this.hints, path: this.path, noteMode: this.noteMode, count: false });
    w.walk(td);
    w.flush();
    return blocksText(w.blocks);
  }
}

// 블록들을 줄글로(표 칸 글·각주 글을 모을 때) — 속에 든 표는 행마다 한 줄, 칸은 빈칸으로
function blocksText(blocks) {
  const lines = [];
  for (const b of blocks) {
    if (b.t === 'p') lines.push(b.segs.map((x) => x.s).join(''));
    else if (b.t === 'tbl') for (const row of b.rows) lines.push(row.filter(Boolean).map((x) => x.s.replace(/\n/g, ' ')).join(' '));
  }
  return lines.join('\n');
}

function bracket(s) {
  return /^[[(［（].*[\])］）]$/.test(s) ? s : `[${s}]`;
}

// ─── 각주 지도(EPUB3 의미 표시가 있는 책만) ───
function indexNotes(book, path, root) {
  const walkTree = (el, noteAnc) => {
    for (const c of el.c) {
      if (typeof c === 'string') continue;
      const anc = isNoteEl(c) ? c : noteAnc;
      if (anc && c.a.id) book.noteEls.set(path + '#' + c.a.id, anc);
      if (anc) anc._path = path;
      walkTree(c, anc);
    }
  };
  walkTree(root, null);
}
function collectRefs(book, path, root) {
  for (const a of descendants(root, 'a')) {
    if (!isNoteRef(a)) continue;
    const r = resolveHref(path, a.a.href || '');
    if (!r || !r.frag) continue;
    const t = book.noteEls.get(r.path + '#' + r.frag);
    if (t) book.referenced.add(t);
  }
}

// ─── 바깥에서 부르는 것 ───
// bytes → 문서 모델
export function parseEpub(bytes, { onProgress } = {}) {
  const zip = openZip(bytes);
  if (!zip.find('META-INF/container.xml') && !zip.names.some((n) => /\.opf$/i.test(n))) throw fail('broken', '전자책(EPUB) 구조가 아닙니다');
  const book = readEpub(zip);
  if (drmLocked(book, zip)) throw fail('drm', '복제 방지(DRM)가 걸린 전자책이라 글을 뽑을 수 없습니다');
  // 본문·CSS 를 한꺼번에 푼다(그림·글꼴은 풀지 않는다)
  const cssPaths = [...book.manifest.values()].filter((i) => i.type === 'text/css' || /\.css$/i.test(i.path)).map((i) => i.path);
  const tooBig = (p) => (zip.sizes.get(zip.find(p)) || 0) > MAX_DOC;
  const skipped = book.spine.filter((s) => tooBig(s.path)).length;
  book.spine = book.spine.filter((s) => !tooBig(s.path));
  zip.take([...book.spine.map((s) => s.path), ...cssPaths.filter((p) => !tooBig(p))]);
  const hintsByCss = new Map();
  const hintsFor = (path, root) => {
    // 이 문서가 부르는 CSS(link)·<style> 에서 감춤·글머리표 단서
    const sheets = [];
    for (const l of descendants(root, 'link')) {
      if (!/stylesheet/i.test(l.a.rel || '') && !/css/i.test(l.a.type || '')) continue;
      const r = resolveHref(path, l.a.href || '');
      if (r) sheets.push(r.path);
    }
    const key = sheets.join('|');
    let base = hintsByCss.get(key);
    if (!base) {
      base = newHints();
      for (const p of sheets) if (!tooBig(p)) cssHints(decodeText(zip.get(p)), base);
      hintsByCss.set(key, base);
    }
    const inline = descendants(root, 'style');
    if (!inline.length) return base;
    const h = { hide: new Set(base.hide), noBullet: new Set(base.noBullet), sup: new Set(base.sup) };
    for (const s of inline) cssHints(textOf(s), h);
    return h;
  };
  const docs = [];
  const parsed = new Map();
  const hasRefs = [];
  for (const s of book.spine) {
    const u8 = zip.get(s.path);
    const src = u8 ? decodeText(u8) : '';
    hasRefs.push(/noteref/.test(src));
    docs.push({ path: s.path, src });
  }
  const B = new Book();
  B.sizeOf = (p) => zip.sizes.get(zip.find(p)) || 0; // 그림 파일 크기(쪽 어림용 — 그림을 풀지는 않는다)
  // EPUB3 각주가 있으면 먼저 책 전체의 각주 자리를 모은다
  if (hasRefs.some(Boolean)) {
    for (const d of docs) { const root = parseXml(d.src, { keepSpace: true, html: true }); parsed.set(d.path, root); indexNotes(B, d.path, root); }
    for (const d of docs) collectRefs(B, d.path, parsed.get(d.path));
  }
  const blocks = [];
  let textChars = 0;
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const root = parsed.get(d.path) || parseXml(d.src, { keepSpace: true, html: true });
    parsed.delete(d.path);
    d.src = null;
    const body = descendants(root, 'body')[0] || root;
    if (blocks.length) B.newPage();
    const w = new Walker(B, { hints: hintsFor(d.path, root), path: d.path });
    w.walk(body);
    w.flush();
    if (w.blocks.length) {
      if (blocks.length) w.blocks[0].gap = Math.max(w.blocks[0].gap || 0, 1);
      for (const b of w.blocks) { blocks.push(b); if (b.t === 'p') textChars += b.segs[0].s.length; }
    }
    if (onProgress && i % 8 === 0) onProgress((i + 1) / docs.length);
  }
  const out = { format: 'epub', pages: Math.max(1, B.page), pageExact: false, blocks, notes: B.notes, warnings: [], title: book.title };
  if (!textChars && !blocks.length) out.warnings.push('글자가 없는 전자책입니다(그림으로만 된 책일 수 있습니다).');
  if (skipped) out.warnings.push(`너무 큰 장 ${skipped}개는 건너뛰었습니다.`);
  resolveSoftBreaks(out);
  if (onProgress) onProgress(1);
  return out;
}
