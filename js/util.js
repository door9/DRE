// 공통 도우미

export function ico(name, cls = '') {
  return `<svg class="ico ${cls}"><use href="#i-${name}"/></svg>`;
}

// 요소 만들기: h('div.cls', { attr }, 자식…)
export function h(tag, attrs = {}, ...kids) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + 'KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + 'MB';
  return (n / 1024 / 1024 / 1024).toFixed(1) + 'GB';
}

export function fmtNum(n) {
  return Number(n || 0).toLocaleString('ko-KR');
}

// 이름 비교(숫자는 크기대로: 2 < 10)
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => collator.compare(a, b);

export function baseName(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

// 윈도우 파일 이름에 못 쓰는 글자 바꾸기
export function safeFileName(name) {
  let s = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!s) s = '문서';
  return s.length > 180 ? s.slice(0, 180) : s;
}

// 같은 이름이 있으면 '이름 (1).확장자'
export function uniqueName(name, taken) {
  if (!taken.has(name.toLowerCase())) { taken.add(name.toLowerCase()); return name; }
  const b = baseName(name), e = extOf(name);
  for (let i = 1; i < 10000; i++) {
    const n = `${b} (${i})${e ? '.' + e : ''}`;
    if (!taken.has(n.toLowerCase())) { taken.add(n.toLowerCase()); return n; }
  }
  return name;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// 알림(잠깐 떴다 사라짐). action: { label, run }
export function toast(msg, { bad = false, ms = 4000, action = null } = {}) {
  const box = document.getElementById('toasts');
  const t = h('div.toast' + (bad ? '.bad' : ''), {}, h('span', { text: msg }));
  if (action) t.append(h('button', { text: action.label, onclick: () => { action.run(); t.remove(); } }));
  box.append(t);
  setTimeout(() => t.remove(), ms);
  return t;
}

// ⓘ 단추 + 접힌 설명. 누르면 펼침
export function infoToggle(html) {
  const wrap = h('span.info-wrap');
  const btn = h('button.info', { type: 'button', title: '설명', 'aria-expanded': 'false', html: ico('info') });
  wrap.append(btn);
  let box = null;
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!open));
    if (open) { box && box.remove(); box = null; return; }
    box = h('div.info-text', { html });
    const host = wrap.closest('[data-info-host]') || wrap.parentElement;
    host.after ? host.after(box) : host.append(box);
    wrap._box = box;
  });
  return wrap;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 작은 저장소(이 앱 것만 'dre.' 이름표로 — 같은 주소의 다른 앱과 섞이지 않게)
export const local = {
  get(key, fallback) {
    try { const v = localStorage.getItem('dre.' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('dre.' + key, JSON.stringify(value)); } catch { /* 저장 못 해도 동작은 한다 */ }
  },
};
