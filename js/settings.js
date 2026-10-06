// 설정 — 브라우저에 기억해 두는 사용자 선택(없어도 기본값으로 동작)
import { local } from './util.js';

const DEFAULTS = {
  mode: 'pdf',
  save: 'download',
  text: {
    reflow: true,          // 줄 이어 붙이기
    joinPages: true,       // 쪽을 넘는 문단 잇기
    dropHeaderFooter: true, // 머리말·꼬리말·쪽 번호 빼기
    indent: true,          // 들여쓰기 살리기
    blank: 'source',       // 문단 사이 빈 줄: source | none | all
    table: 'tab',          // 표: tab | grid | lines
    notes: 'end',          // 각주: end | none
    pageMarks: false,      // 쪽 구분 표시
  },
  eol: 'crlf',             // 줄 끝: crlf(윈도우) | lf
  bom: true,               // UTF-8 표시(BOM) — 한글·메모장 등에서 글자가 안 깨지게
  merge: { outline: true },
  theme: 'auto',
};

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

export const settings = merge(DEFAULTS, local.get('settings', {}));

export function saveSettings() {
  local.set('settings', settings);
}

export function applyTheme() {
  const t = settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// 글 그리기 옵션(model.render 에 넘길 모양)
export function renderOptions() {
  const t = settings.text;
  return {
    reflow: t.reflow, joinPages: t.joinPages, dropHeaderFooter: t.dropHeaderFooter,
    indent: t.indent ? '  ' : '', blank: t.blank, table: t.table, notes: t.notes, pageMarks: t.pageMarks,
    eol: settings.eol === 'lf' ? '\n' : '\r\n',
  };
}

// ─── 폴더 손잡이(고른 저장 폴더)는 IndexedDB 에 ───
const DB = 'dre-store';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function kvGet(key) {
  try {
    const db = await idb();
    return await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); });
  } catch { return undefined; }
}
export async function kvSet(key, value) {
  try {
    const db = await idb();
    await new Promise((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(value, key); tx.oncomplete = res; tx.onerror = res; });
  } catch { /* 무시 */ }
}
