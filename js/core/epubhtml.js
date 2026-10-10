// EPUB → PDF 용 HTML 한 장 — 읽는 순서대로 장들을 이어 붙인다(장마다 새 쪽, 고정 쪽 책은 쪽마다 원래 크기).
// 그림·글꼴은 파일 안에(data:) 넣고, 스크립트·이벤트·밖 연결은 뺀다(보안 정책 CSP 로 한 번 더 막는다).
// PC의 DRE 가 엣지(화면 없이)로 이 HTML 을 인쇄해 PDF 를 만든다. 결과는 조각(글·바이트) 목록 — 부르는 쪽이 Blob 으로 묶는다.
import { openZip, readEpub, drmLocked, decodeText, resolveHref, EpubError, FONT_OBFUSCATION, MAX_DOC } from './epub.js';
import { parseXml, descendants, kid } from './xml.js';

const fail = (code, message) => new EpubError(code, message);
const MAX_RES = 200 * 1024 * 1024;        // 그림·글꼴 하나
const MAX_RES_TOTAL = 600 * 1024 * 1024;  // 모두 합쳐서(HTML 이 이보다 1/3 더 커진다)

// ─── base64(바이트로 바로 — 큰 글꼴·그림을 글자열로 만들지 않게) ───
const B64 = new TextEncoder().encode('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
export function base64Bytes(u8) {
  const n = u8.length;
  const out = new Uint8Array(Math.ceil(n / 3) * 4);
  let o = 0, i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out[o++] = B64[v >> 18]; out[o++] = B64[(v >> 12) & 63]; out[o++] = B64[(v >> 6) & 63]; out[o++] = B64[v & 63];
  }
  if (i < n) {
    const a = u8[i], b = i + 1 < n ? u8[i + 1] : 0;
    const v = (a << 16) | (b << 8);
    out[o++] = B64[v >> 18]; out[o++] = B64[(v >> 12) & 63]; out[o++] = i + 1 < n ? B64[(v >> 6) & 63] : 61; out[o++] = 61;
  }
  return out;
}

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
  otf: 'font/otf', ttf: 'font/ttf', woff: 'font/woff', woff2: 'font/woff2', css: 'text/css' };
const extOf = (p) => (String(p).match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';

// 글꼴 난독화 풀기(IDPF: 고유 식별자 SHA-1 로 앞 1040바이트 XOR, Adobe: UUID 16바이트로 앞 1024바이트 XOR) — DRM 이 아니라 글꼴 재배포 막이
async function deobfuscate(bytes, alg, uid) {
  const out = new Uint8Array(bytes);
  if (alg === 'http://www.idpf.org/2008/embedding') {
    const key = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(uid.replace(/[ \u0009\u000d\u000a]/g, ''))));
    for (let i = 0; i < Math.min(1040, out.length); i++) out[i] ^= key[i % key.length];
  } else if (alg === 'http://ns.adobe.com/pdf/enc#RC') {
    const hex = uid.replace(/^urn:uuid:/i, '').replace(/-/g, '');
    if (hex.length >= 32) {
      const key = new Uint8Array(16);
      for (let i = 0; i < 16; i++) key[i] = parseInt(hex.substr(i * 2, 2), 16);
      for (let i = 0; i < Math.min(1024, out.length); i++) out[i] ^= key[i % 16];
    }
  }
  return out;
}

// ─── 글 조각 모음(문자열과 바이트를 섞어 담는다) ───
class Parts {
  constructor() { this.a = []; this.s = ''; }
  push(x) { if (typeof x === 'string') { this.s += x; if (this.s.length > 65536) this.cut(); } else { this.cut(); this.a.push(x); } }
  cut() { if (this.s) { this.a.push(this.s); this.s = ''; } }
  addAll(p) { p.cut(); this.cut(); for (const x of p.a) this.a.push(x); }
  list() { this.cut(); return this.a; }
}

const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// ─── CSS ───
// 주석 빼기(글자열 안은 그대로)
function stripComments(css) {
  let out = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const j = endOfString(css, i);
      out += css.slice(i, j);
      i = j - 1;
    } else if (ch === '/' && css[i + 1] === '*') {
      const e = css.indexOf('*/', i + 2);
      i = e < 0 ? css.length : e + 1;
    } else out += ch;
  }
  return out;
}
function endOfString(s, i) {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; if (s[j] === '\n') break; j++; }
  return Math.min(s.length, j + 1);
}
// css[i] 에서 시작하는 덩어리의 끝: '{' 를 만나면 짝 '}' 까지, ';' 를 먼저 만나면 거기까지
function scanStatement(css, i) {
  let depth = 0, paren = 0;
  for (let j = i; j < css.length; j++) {
    const ch = css[j];
    if (ch === '"' || ch === "'") { j = endOfString(css, j) - 1; continue; }
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (paren) continue;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth <= 0) return { end: j + 1, block: true }; }
    else if (ch === ';' && depth === 0) return { end: j + 1, block: false };
  }
  return { end: css.length, block: depth > 0 };
}
// 쉼표로 선택자 나누기(괄호·대괄호·글자열 안 쉼표는 그대로)
function splitTop(s, sep = ',') {
  const out = [];
  let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") { const j = endOfString(s, i); cur += s.slice(i, j); i = j - 1; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === sep && !depth) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
// 선택자 하나를 이 장 묶음 안으로: html·:root·body 는 묶음 상자 자신으로, 나머지는 그 안으로
export function scopeSelector(sel, scope) {
  let s = sel.trim();
  if (!s) return '';
  s = s.replace(/^(?::root|html)(?=$|[\s>+~.#[:])/i, '').trim();
  s = s.replace(/^[>+~]\s*/, '');
  if (!s) return scope;
  const m = /^body(?=$|[\s>+~.#[:])/i.exec(s);
  if (m) return scope + s.slice(4);
  return scope + ' ' + s;
}

class CssBuilder {
  constructor(ctx) { this.ctx = ctx; this.fontFaces = new Parts(); this.seenFaces = new Set(); }

  // 책 CSS 글을 묶음 안으로 가두어 Parts 로. base: 이 CSS 파일 자리(url·@import 기준)
  process(css, base, scope, depth = 0) {
    const out = new Parts();
    this.rules(stripComments(css), base, scope, out, depth);
    return out;
  }

  rules(css, base, scope, out, depth) {
    let i = 0;
    while (i < css.length) {
      while (i < css.length && /\s/.test(css[i])) i++;
      if (i >= css.length) break;
      const st = scanStatement(css, i);
      const text = css.slice(i, st.end);
      i = st.end;
      if (text[0] === '@') this.atRule(text, st.block, base, scope, out, depth);
      else if (st.block) this.rule(text, base, scope, out);
    }
  }

  atRule(text, block, base, scope, out, depth) {
    const name = (/^@([\w-]+)/.exec(text) || [])[1]?.toLowerCase() || '';
    if (!block) {
      if (name === 'import' && depth < 4) {
        const m = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?/i.exec(text);
        const r = m && resolveHref(base, m[1]);
        const data = r && this.ctx.zip.get(r.path);
        if (data) { const p = this.process(decodeText(data), r.path, scope, depth + 1); out.addAll(p); }
      }
      return; // @charset·@namespace·밖 @import 는 뺀다
    }
    const open = text.indexOf('{');
    const prelude = text.slice(0, open).trim();
    const inner = text.slice(open + 1, text.lastIndexOf('}'));
    if (name === 'font-face') {
      // 글꼴은 묶음과 상관없이 한 번만
      const body = new Parts();
      this.decls(inner, base, body, true);
      const key = prelude + '{' + body.a.map((x) => (typeof x === 'string' ? x : x.name || '')).join('') + body.s;
      if (this.seenFaces.has(key)) return;
      this.seenFaces.add(key);
      this.fontFaces.push('@font-face{');
      this.fontFaces.addAll(body);
      this.fontFaces.push('}\n');
      return;
    }
    if (name === 'page') return; // 쪽 크기·여백은 DRE 가 정한다
    if (name === 'media' || name === 'supports' || name === 'layer' || name === 'container' || name === 'document' || name === '-moz-document') {
      out.push(prelude + '{');
      this.rules(inner, base, scope, out, depth);
      out.push('}\n');
      return;
    }
    if (/keyframes$/.test(name) || name === 'counter-style' || name === 'property' || name === 'font-feature-values') { out.push(text + '\n'); return; }
    // 모르는 것은 뺀다
  }

  rule(text, base, scope, out) {
    const open = text.indexOf('{');
    const sels = splitTop(text.slice(0, open)).map((s) => scopeSelector(s, scope)).filter(Boolean);
    if (!sels.length) return;
    const inner = text.slice(open + 1, text.lastIndexOf('}'));
    out.push(sels.join(',') + '{');
    this.decls(inner, base, out, false);
    out.push('}\n');
  }

  // 선언들: url() 은 책 속 파일이면 data: 로(아니면 빈 것), position:fixed 는 쪽마다 되풀이되지 않게 absolute 로
  decls(inner, base, out, font) {
    let s = inner.replace(/position\s*:\s*fixed/gi, 'position:absolute').replace(/position\s*:\s*sticky/gi, 'position:static')
      .replace(/expression\s*\(/gi, '(').replace(/behavior\s*:/gi, 'x-behavior:').replace(/-moz-binding\s*:/gi, 'x-binding:');
    let last = 0;
    const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
    let m;
    while ((m = re.exec(s))) {
      out.push(s.slice(last, m.index));
      const href = (m[1] ?? m[2] ?? m[3] ?? '').trim();
      const res = this.ctx.resource(base, href, font);
      if (res) { out.push('url("data:' + res.mime + ';base64,'); out.push(res); out.push('")'); } else out.push('url("data:,")');
      last = re.lastIndex;
    }
    out.push(s.slice(last));
  }
}

// ─── 본문 내보내기 ───
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const DROP = new Set(['script', 'iframe', 'frame', 'frameset', 'embed', 'applet', 'base', 'meta', 'link', 'title', 'template', 'canvas', 'portal', 'slot',
  'audio', 'source', 'track', 'param', 'head']);
const UNWRAP = new Set(['noscript', 'html', 'body', 'form']);
const RAWTEXT = new Set(['style']);

class BodyWriter {
  constructor(ctx, idx, path) { this.ctx = ctx; this.idx = idx; this.path = path; this.svg = 0; }
  id(v) { return `d${this.idx}-${v}`; }

  // 책 속 연결 → 이 HTML 안 자리(#d3-frag 또는 #d3)
  link(href) {
    const h = String(href || '').trim();
    if (/^(?:https?:|mailto:)/i.test(h)) return h;
    if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return null;
    const r = resolveHref(this.path, h);
    if (!r) return null;
    const n = this.ctx.docIndex.get(r.path);
    if (n == null) return null;
    return r.frag ? `#d${n}-${r.frag}` : `#d${n}`;
  }

  children(el, out) {
    for (const c of el.c) {
      if (typeof c === 'string') out.push(escText(c));
      else this.element(c, out);
    }
  }

  element(el, out) {
    const tag = el.l;
    if (tag === 'style') { this.ctx.inlineCss.push(el.c.join('')); return; }
    if (DROP.has(tag)) return;
    if (tag === 'switch') { const d = kid(el, 'default'); if (d) this.children(d, out); return; } // epub:switch
    if (UNWRAP.has(tag)) { this.children(el, out); return; }
    if (tag === 'video') {
      // 동영상은 표지 그림(poster)만
      const poster = el.a.poster && this.ctx.resource(this.path, el.a.poster, false);
      if (poster) { out.push('<img alt="" src="data:' + poster.mime + ';base64,'); out.push(poster); out.push('">'); }
      return;
    }
    if (tag === 'object') {
      // 그림을 품은 것은 그림으로, 아니면 대체 내용
      const data = el.a.data && this.ctx.resource(this.path, el.a.data, false);
      if (data && /^image\//.test(data.mime)) { out.push('<img alt="" src="data:' + data.mime + ';base64,'); out.push(data); out.push('">'); return; }
      this.children(el, out);
      return;
    }
    const isSvg = tag === 'svg';
    if (isSvg) this.svg++;
    out.push('<' + tag);
    this.attrs(el, out);
    out.push('>');
    if (!VOID.has(tag)) {
      if (RAWTEXT.has(tag)) out.push(el.c.join(''));
      else this.children(el, out);
      out.push('</' + tag + '>');
    }
    if (isSvg) this.svg--;
  }

  attrs(el, out) {
    const tag = el.l;
    for (const [k0, v] of Object.entries(el.a)) {
      const k = k0.toLowerCase();
      if (k.startsWith('on') || k === 'srcset' || k === 'sizes' || k === 'ping' || k === 'formaction' || k === 'action' || k === 'xmlns' || k.startsWith('xmlns:') ||
        k === 'contenteditable' || k === 'autofocus' || k === 'target' || k === 'download' || k === 'http-equiv') continue;
      let name = k0;
      let val = v;
      if (k === 'xml:lang') { if ('lang' in el.a) continue; name = 'lang'; }
      if (k === 'id' || (k === 'name' && tag === 'a')) {
        if (this.svg) { out.push(` ${name}="${escAttr(val)}"`); continue; } // 그림(SVG) 안 아이디는 그대로(안에서 서로 가리킨다)
        out.push(` ${k}="${escAttr(this.id(val))}"`);
        continue;
      }
      if (k === 'style') { out.push(' style="'); const p = new Parts(); this.ctx.css.decls(val, this.path, p, false); for (const x of p.list()) out.push(typeof x === 'string' ? escAttr(x) : x); out.push('"'); continue; }
      if ((k === 'href' || k === 'xlink:href') && (tag === 'a' || tag === 'area')) {
        const to = this.link(val);
        if (to) out.push(` href="${escAttr(to)}"`);
        continue;
      }
      if (k === 'src' || k === 'poster' || k === 'background' || ((k === 'href' || k === 'xlink:href') && (tag === 'image' || tag === 'use' || tag === 'feimage'))) {
        if ((tag === 'use') && String(val).startsWith('#')) { out.push(` ${name}="${escAttr(val)}"`); continue; }
        const res = this.ctx.resource(this.path, val, false);
        if (res) { out.push(` ${name}="data:${res.mime};base64,`); out.push(res); out.push('"'); }
        continue;
      }
      if (k === 'data' || k === 'codebase' || k === 'archive' || k === 'manifest') continue;
      out.push(` ${name}="${escAttr(val)}"`);
    }
  }
}

// ─── 바깥에서 부르는 것 ───
// bytes → { parts, title, lang, fixed, docs, warnings }
export async function buildEpubHtml(bytes, { onProgress } = {}) {
  const zip = openZip(bytes);
  if (!zip.find('META-INF/container.xml') && !zip.names.some((n) => /\.opf$/i.test(n))) throw fail('broken', '전자책(EPUB) 구조가 아닙니다');
  const book = readEpub(zip);
  if (drmLocked(book, zip)) throw fail('drm', '복제 방지(DRM)가 걸린 전자책이라 PDF로 바꿀 수 없습니다');
  // 너무 큰 장은 건너뛴다(글 뽑기와 같은 상한)
  const sizeOf = (p) => zip.sizes.get(zip.find(p)) || 0;
  const skipped = book.spine.filter((s) => sizeOf(s.path) > MAX_DOC).length;
  book.spine = book.spine.filter((s) => sizeOf(s.path) <= MAX_DOC);
  const docIndex = new Map(book.spine.map((s, i) => [s.path, i]));
  const resCache = new Map();
  let resTotal = 0;
  const ctx = {
    zip, book, docIndex, inlineCss: [],
    // 책 속 파일 → { mime, b64 }(없거나 밖 주소면 null). 글꼴은 난독화를 푼다.
    // 하나가 너무 크면(200MB↑) 빼고, 모두 합쳐 600MB 를 넘으면 그만둔다(브라우저 메모리)
    resource(base, href, font) {
      const r = resolveHref(base, href);
      if (!r) return null;
      const name = zip.find(r.path);
      if (!name) return null;
      if (resCache.has(name)) return resCache.get(name);
      const size = sizeOf(name);
      if (size > MAX_RES) { resCache.set(name, null); return null; }
      resTotal += size;
      if (resTotal > MAX_RES_TOTAL) throw fail('too_big', '전자책의 그림·글꼴이 너무 커서(600MB 넘음) PDF로 바꿀 수 없습니다');
      let data = zip.get(name);
      let rec = null;
      if (data && data.length) {
        const item = book.byPath.get(name);
        const mime = (item && item.type && !/xhtml|html/.test(item.type) ? item.type : MIME[extOf(name)]) || 'application/octet-stream';
        const alg = book.encrypted.get(name);
        rec = { name, mime, b64: null, raw: data, alg }; // 본문·CSS 에는 이 기록을 자리표로 넣고, 끝에 base64 로 바꾼다
      }
      resCache.set(name, rec);
      return rec;
    },
  };
  ctx.css = new CssBuilder(ctx);
  // 장마다: 본문을 내보내고, 쓰는 CSS 묶음을 정한다
  const groups = new Map(); // CSS 열쇠 → { scope, css: Parts }
  const bodies = [];
  const fixedSizes = new Set();
  const n = book.spine.length;
  for (let i = 0; i < n; i++) {
    const s = book.spine[i];
    const src = decodeText(zip.get(s.path));
    zip.drop(s.path);
    const root = parseXml(src, { keepSpace: true, html: true });
    const htmlEl = descendants(root, 'html')[0] || root;
    const head = descendants(root, 'head')[0];
    const body = descendants(root, 'body')[0] || (descendants(root, 'svg')[0] ? { l: 'body', a: {}, c: [descendants(root, 'svg')[0]] } : root);
    // CSS: <link> 파일 + <style> 글
    const sheets = [];
    ctx.inlineCss = [];
    for (const l of [...descendants(head, 'link'), ...descendants(body, 'link')]) {
      if (!/stylesheet/i.test(l.a.rel || '') && !/css/i.test(l.a.type || '')) continue;
      if (/alternate/i.test(l.a.rel || '')) continue;
      const r = resolveHref(s.path, l.a.href || '');
      if (r && zip.find(r.path)) sheets.push(zip.find(r.path));
    }
    for (const st of descendants(head, 'style')) ctx.inlineCss.push(st.c.join(''));
    // 본문(이 사이에 <style> 이 나오면 inlineCss 에 더해진다)
    const w = new BodyWriter(ctx, i, s.path);
    const bodyOut = new Parts();
    w.children(body, bodyOut);
    const key = sheets.join('|') + '\u0000' + ctx.inlineCss.join('\u0001');
    let g = groups.get(key);
    if (!g) {
      g = { scope: `.dre-g${groups.size}`, css: new Parts() };
      for (const p of sheets) g.css.addAll(ctx.css.process(decodeText(zip.get(p)), p, g.scope));
      for (const t of ctx.inlineCss) g.css.addAll(ctx.css.process(t, s.path, g.scope));
      groups.set(key, g);
    }
    // 고정 쪽(그림책·만화): 장마다 원래 크기 한 쪽
    const fixed = (book.layout === 'pre-paginated' && !s.props.includes('rendition:layout-reflowable')) || s.props.includes('rendition:layout-pre-paginated');
    let size = null;
    if (fixed) {
      const vp = descendants(head, 'meta').find((m) => /viewport/i.test(m.a.name || ''));
      const mw = vp && /width\s*=\s*(\d+)/i.exec(vp.a.content || '');
      const mh = vp && /height\s*=\s*(\d+)/i.exec(vp.a.content || '');
      const svgRoot = !mw && descendants(body, 'svg')[0];
      const vb = svgRoot && /^\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(svgRoot.a.viewBox || svgRoot.a.viewbox || '');
      const W = mw ? +mw[1] : vb ? Math.round(+vb[1]) : 0;
      const H = mh ? +mh[1] : vb ? Math.round(+vb[2]) : 0;
      if (W > 50 && H > 50 && W < 20000 && H < 20000) { size = { W, H }; fixedSizes.add(`${W}x${H}`); }
    }
    const bodyClass = [htmlEl.a && htmlEl.a.class, body.a && body.a.class].filter(Boolean).join(' ');
    const lang = (body.a && (body.a.lang || body.a['xml:lang'])) || (htmlEl.a && (htmlEl.a.lang || htmlEl.a['xml:lang'])) || '';
    const dir = (body.a && body.a.dir) || (htmlEl.a && htmlEl.a.dir) || '';
    const st = new Parts();
    if (body.a && body.a.style) ctx.css.decls(body.a.style, s.path, st, false);
    if (size) st.push(`;width:${size.W}px;height:${size.H}px`);
    const open = new Parts();
    open.push(`<div class="dre-doc ${g.scope.slice(1)} ${size ? `dre-fixed dre-p${size.W}x${size.H}` : 'dre-flow'}${bodyClass ? ' ' + escAttr(bodyClass) : ''}" id="d${i}"`);
    if (lang) open.push(` lang="${escAttr(lang)}"`);
    if (dir) open.push(` dir="${escAttr(dir)}"`);
    const stl = st.list();
    if (stl.length) { open.push(' style="'); for (const x of stl) open.push(typeof x === 'string' ? escAttr(x) : x); open.push('"'); }
    open.push('>');
    bodies.push({ open, body: bodyOut, close: '</div>\n' });
    if (onProgress && i % 4 === 0) onProgress(((i + 1) / n) * 0.8);
  }
  // 글꼴 난독화 풀기 → base64
  for (const rec of resCache.values()) {
    if (!rec) continue;
    let raw = rec.raw;
    if (rec.alg && FONT_OBFUSCATION.has(rec.alg)) raw = await deobfuscate(raw, rec.alg, book.uid);
    rec.b64 = base64Bytes(raw);
    rec.raw = null;
  }
  // 조립: 조각 속 자리표(res 객체)를 실제 base64 로 바꾼다
  const lang = book.lang || '';
  const page = [
    '@page{size:A4;margin:18mm 17mm 20mm}',
    // 책이 글꼴을 정하지 않으면 바탕(명조). 한국어 책 조판처럼 낱말 단위 줄바꿈
    `html{font-family:Batang,'바탕',AppleMyungjo,'Noto Serif KR',serif;font-size:11pt;line-height:1.65;-webkit-print-color-adjust:exact;print-color-adjust:exact;word-break:keep-all;overflow-wrap:break-word}`,
    'body{margin:0}',
    '.dre-doc{display:block;position:relative}',
    '.dre-doc+.dre-doc{break-before:page}',
    '.dre-flow img,.dre-flow svg,.dre-flow video{max-width:100%}',
    '.dre-flow img{height:auto;break-inside:avoid}',
    '.dre-flow table{max-width:100%}',
    '.dre-flow pre{white-space:pre-wrap}',
    '.dre-fixed{overflow:hidden;margin:0;padding:0;box-sizing:border-box}',
  ];
  for (const k of fixedSizes) {
    const [W, H] = k.split('x');
    page.push(`@page dre-p${k}{size:${W}px ${H}px;margin:0}`, `.dre-p${k}{page:dre-p${k}}`);
  }
  const out = new Parts();
  out.push(`<!DOCTYPE html>\n<html${lang ? ` lang="${escAttr(lang)}"` : ''}><head><meta charset="utf-8">\n`);
  out.push(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; media-src data:">\n`);
  out.push(`<title>${escText(book.title || '')}</title>\n<style>${page.join('\n')}</style>\n<style>`);
  out.addAll(ctx.css.fontFaces);
  out.push('</style>\n');
  for (const g of groups.values()) { out.push('<style>'); out.addAll(g.css); out.push('</style>\n'); }
  out.push('</head><body>\n');
  for (const b of bodies) { out.addAll(b.open); out.addAll(b.body); out.push(b.close); }
  out.push('</body></html>\n');
  const parts = out.list().map((x) => (x && x.b64 !== undefined ? x.b64 : x));
  if (onProgress) onProgress(1);
  return { parts, title: book.title, lang, fixed: fixedSizes.size > 0, docs: n, warnings: skipped ? [`너무 큰 장 ${skipped}개는 건너뛰었습니다.`] : [] };
}
