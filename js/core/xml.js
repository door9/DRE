// 아주 작은 XML 해석기 — HWPX·DOCX 속 XML 을 가벼운 나무 모양으로 읽는다(작업 스레드에서도 동작, DOM 불필요).
// 요소: { n: 이름(접두어 포함), l: 접두어 뺀 이름, a: 속성, c: 자식(요소 또는 글자) }

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return ''; }
    }
    return ENT[e] !== undefined ? ENT[e] : m;
  });
}

function localName(n) {
  const i = n.indexOf(':');
  return i < 0 ? n : n.slice(i + 1);
}

const ATTR = /([^\s=\/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

export function parseXml(src) {
  const root = { n: '#doc', l: '#doc', a: {}, c: [] };
  const stack = [root];
  let i = 0;
  const len = src.length;
  while (i < len) {
    const lt = src.indexOf('<', i);
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
      const name = src.slice(lt + 2, e).trim();
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
    const selfClose = body.endsWith('/');
    if (selfClose) body = body.slice(0, -1);
    const sp = body.search(/\s/);
    const name = sp < 0 ? body : body.slice(0, sp);
    const el = { n: name, l: localName(name), a: {}, c: [] };
    if (sp >= 0) {
      const rest = body.slice(sp);
      ATTR.lastIndex = 0;
      let m;
      while ((m = ATTR.exec(rest))) el.a[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
    }
    stack[stack.length - 1].c.push(el);
    if (!selfClose) stack.push(el);
    i = j + 1;
  }
  return root;
}

function pushText(el, raw) {
  // 요소 사이 공백뿐인 글은 버린다(글자 요소 안의 공백은 남는다: 아래 txt 는 <w:t>, <hp:t> 안에서만 쓰임)
  if (/^[\s]*$/.test(raw) && !isTextHolder(el)) return;
  el.c.push(decodeEntities(raw));
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
