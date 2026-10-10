// 아주 작은 XML 해석기 — HWPX·DOCX 속 XML 을 가벼운 나무 모양으로 읽는다(작업 스레드에서도 동작, DOM 불필요).
// 요소: { n: 이름(접두어 포함), l: 접두어 뺀 이름, a: 속성, c: 자식(요소 또는 글자) }
import { HTML_ENT } from './htmlent.js';

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s, table = ENT) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return ''; }
    }
    return table[e] !== undefined ? table[e] : m;
  });
}
const decodeHtmlEntities = (s) => decodeEntities(s, HTML_ENT);

// HTML 모드에서 닫는 태그가 없는 요소, 속이 날 글자인 요소
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'basefont', 'frame', 'keygen']);
const RAW = new Set(['script', 'style']);
// HTML 의 '저절로 닫힘': 이 요소가 열리면, 열려 있는 앞 형제(값의 이름들)를 닫는다 — 단, 경계(scope) 요소를 넘지는 않는다.
// 잘 닫힌 XHTML 에서는 앞 형제가 이미 닫혀 있어 아무 일도 없다(<TD>가<TD>나 같은 느슨한 HTML 만 바로잡힌다)
const IMPLIED = {
  td: [['td', 'th'], ['tr', 'table']], th: [['td', 'th'], ['tr', 'table']],
  tr: [['tr', 'td', 'th'], ['table', 'thead', 'tbody', 'tfoot']],
  thead: [['tr', 'td', 'th', 'thead', 'tbody', 'tfoot'], ['table']], tbody: [['tr', 'td', 'th', 'thead', 'tbody', 'tfoot'], ['table']], tfoot: [['tr', 'td', 'th', 'thead', 'tbody', 'tfoot'], ['table']],
  li: [['li'], ['ul', 'ol', 'menu', 'dir']], dt: [['dt', 'dd'], ['dl']], dd: [['dt', 'dd'], ['dl']], option: [['option'], ['select', 'datalist']],
};
// 문단(p)은 블록이 열리면 닫힌다(바로 위가 p 일 때만)
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul', 'figure', 'main', 'details']);
const HTML_ATTR = /([^\s=\/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function localName(n) {
  const i = n.indexOf(':');
  return i < 0 ? n : n.slice(i + 1);
}

const ATTR = /([^\s=\/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

// keepSpace: 요소 사이의 공백뿐인 글도 남긴다(ODF 처럼 글 조각 사이 빈칸이 뜻을 갖는 형식)
// html: 전자책 XHTML·웹 문서에 너그럽게 — 이름은 소문자로, <br>·<img> 처럼 닫지 않는 요소, 따옴표 없는 속성, <style>·<script> 속 날 글자,
//       글 속 홀로 선 '<', HTML 이름 붙은 글자(&nbsp; 등). htmlEntities: 이름 붙은 글자만(OPF·NCX 처럼 XML 이지만 &nbsp; 를 쓰는 것)
// maxDepth: 이보다 깊어지면 더 들어가지 않는다(HTML 은 256 — 실제 책은 30겹 안쪽. 일부러 수천 겹 겹친 파일이 훑는 함수를 넘치게 하지 않게)
export function parseXml(src, { keepSpace = false, html = false, htmlEntities = false, maxDepth = html ? 256 : Infinity } = {}) {
  const root = { n: '#doc', l: '#doc', a: {}, c: [] };
  const dec = html || htmlEntities ? decodeHtmlEntities : decodeEntities;
  const pushText = keepSpace ? (el, raw) => { el.c.push(dec(raw)); } : (el, raw) => pushTextTrim(el, raw, dec);
  const stack = [root];
  let i = 0;
  const len = src.length;
  while (i < len) {
    let lt = src.indexOf('<', i);
    // HTML: 글자·'/'·'!'·'?' 가 뒤따르지 않는 '<' 는 태그가 아니라 글자다(a < b)
    while (html && lt >= 0 && !/[A-Za-z\/!?]/.test(src[lt + 1] || '')) lt = src.indexOf('<', lt + 1);
    if (lt < 0) {
      const t = src.slice(i);
      if (t) pushText(stack[stack.length - 1], t);
      break;
    }
    if (lt > i) pushText(stack[stack.length - 1], src.slice(i, lt));
    const c1 = src.charCodeAt(lt + 1);
    if (c1 === 33 /* ! */) {
      if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? len : e + 3; continue; }
      if (src.startsWith('<![CDATA[', lt)) {
        const e = src.indexOf(']]>', lt + 9);
        const t = src.slice(lt + 9, e < 0 ? len : e);
        stack[stack.length - 1].c.push(t);
        i = e < 0 ? len : e + 3;
        continue;
      }
      // DOCTYPE 등
      const e = src.indexOf('>', lt);
      i = e < 0 ? len : e + 1;
      continue;
    }
    if (c1 === 63 /* ? */) { const e = src.indexOf('?>', lt); i = e < 0 ? len : e + 2; continue; }
    if (c1 === 47 /* / */) {
      const e = src.indexOf('>', lt);
      let name = src.slice(lt + 2, e < 0 ? len : e).trim();
      if (html) name = name.toLowerCase();
      // 짝이 맞는 곳까지 닫는다(망가진 XML 에 너그럽게)
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].n === name) { stack.length = k; break; }
      }
      i = e < 0 ? len : e + 1;
      continue;
    }
    // 여는 태그: 속성 값 안의 '>' 를 건너뛰며 끝을 찾는다
    let j = lt + 1;
    let q = 0;
    while (j < len) {
      const ch = src.charCodeAt(j);
      if (q) { if (ch === q) q = 0; }
      else if (ch === 34 || ch === 39) q = ch;
      else if (ch === 62) break;
      j++;
    }
    let body = src.slice(lt + 1, j);
    let selfClose = body.endsWith('/');
    if (selfClose) body = body.slice(0, -1);
    const sp = body.search(/\s/);
    let name = sp < 0 ? body : body.slice(0, sp);
    if (html) name = name.toLowerCase();
    const el = { n: name, l: localName(name), a: {}, c: [] };
    if (html && stack.length > 1) {
      const imp = IMPLIED[el.l];
      if (imp) {
        for (let k = stack.length - 1; k > 0; k--) {
          const l = stack[k].l;
          if (imp[1].includes(l)) break;
          if (imp[0].includes(l)) { stack.length = k; break; }
        }
      } else if (CLOSES_P.has(el.l) && stack[stack.length - 1].l === 'p') stack.length -= 1;
    }
    if (sp >= 0) {
      const rest = body.slice(sp);
      if (html) {
        HTML_ATTR.lastIndex = 0;
        let m;
        while ((m = HTML_ATTR.exec(rest))) {
          const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
          if (!(m[1] in el.a)) el.a[m[1]] = dec(v);
        }
      } else {
        ATTR.lastIndex = 0;
        let m;
        while ((m = ATTR.exec(rest))) el.a[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
      }
    }
    stack[stack.length - 1].c.push(el);
    if (html && VOID.has(el.l)) selfClose = true;
    i = j + 1;
    if (html && !selfClose && RAW.has(el.l)) {
      // <style>·<script> 속은 태그로 보지 않고 닫는 태그까지 통째로(XHTML 의 CDATA·&gt; 도 풀어 둔다)
      const closeRe = el.l === 'style' ? /<\/style\s*>/gi : /<\/script\s*>/gi;
      closeRe.lastIndex = i;
      const cm = closeRe.exec(src);
      let raw = src.slice(i, cm ? cm.index : len).replace(/<!\[CDATA\[|\]\]>/g, '');
      if (raw.indexOf('&') >= 0) raw = dec(raw);
      if (raw) el.c.push(raw);
      i = cm ? cm.index + cm[0].length : len;
      continue;
    }
    if (!selfClose && stack.length <= maxDepth) stack.push(el);
  }
  return root;
}

function pushTextTrim(el, raw, dec = decodeEntities) {
  // 요소 사이 공백뿐인 글은 버린다(글자 요소 안의 공백은 남는다: 아래 txt 는 <w:t>, <hp:t> 안에서만 쓰임)
  if (/^[\s]*$/.test(raw) && !isTextHolder(el)) return;
  el.c.push(dec(raw));
}

function isTextHolder(el) {
  return el.l === 't' || el.l === 'instrText' || el.l === 'delText' || el.l === 'script';
}

// ─── 찾기 도우미 ───
export function kids(el, l) {
  const out = [];
  if (!el) return out;
  for (const c of el.c) if (typeof c !== 'string' && (!l || c.l === l)) out.push(c);
  return out;
}

export function kid(el, l) {
  if (!el) return null;
  for (const c of el.c) if (typeof c !== 'string' && c.l === l) return c;
  return null;
}

// 경로로 찾기: path(el, 'body', 'p')
export function path(el, ...names) {
  let cur = el;
  for (const n of names) { cur = kid(cur, n); if (!cur) return null; }
  return cur;
}

// 접두어를 무시하고 속성 찾기
export function attr(el, l) {
  if (!el) return undefined;
  if (el.a[l] !== undefined) return el.a[l];
  for (const k in el.a) if (localName(k) === l) return el.a[k];
  return undefined;
}

// 자손 중 이름이 맞는 것 모두(깊이 우선, 문서 순서)
export function descendants(el, l, out = []) {
  if (!el) return out;
  for (const c of el.c) {
    if (typeof c === 'string') continue;
    if (c.l === l) out.push(c);
    descendants(c, l, out);
  }
  return out;
}

export function firstDescendant(el, l) {
  if (!el) return null;
  for (const c of el.c) {
    if (typeof c === 'string') continue;
    if (c.l === l) return c;
    const d = firstDescendant(c, l);
    if (d) return d;
  }
  return null;
}

// 글자 모두(요소 무시)
export function textOf(el) {
  if (!el) return '';
  let s = '';
  for (const c of el.c) s += typeof c === 'string' ? c : textOf(c);
  return s;
}
