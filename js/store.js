// 파일 목록 상태 — 화면 여러 곳이 같은 목록을 보고, 바뀌면 알림을 받는다
import { settings, saveSettings } from './settings.js';
import { naturalCompare } from './util.js';

const bus = new EventTarget();
export function on(type, f) { bus.addEventListener(type, (e) => f(e.detail)); }
export function emit(type, detail) { bus.dispatchEvent(new CustomEvent(type, { detail })); }

let nextId = 1;
export const store = {
  items: [],
  selected: null,       // 고른 항목 id
  mode: settings.mode,  // pdf | text | merge
  running: false,
};

export function makeItem({ file, handle = null, dir = null, kind }) {
  return {
    id: nextId++,
    file, handle, dir,
    name: file.name, size: file.size, mtime: file.lastModified || 0,
    kind,                 // 형식(파일 속을 보고 다시 정한다)
    probed: false, pages: null, pageExact: false, probeError: null, probeMsg: '',
    needsPassword: false, password: null,
    range: null,          // null = 전체, 아니면 쪽 번호 배열(1부터)
    state: 'idle', msg: '', progress: 0,
    pdf: null,            // 엔진·그림으로 만든 PDF(Blob) — 미리 보기·합치기에 다시 쓴다
    pdfPages: null,
    textDoc: null,        // 뽑아 둔 글(문서 모델)과 그때의 쪽 범위
    textKey: null,
    output: null,
  };
}

export function getItem(id) { return store.items.find((x) => x.id === id) || null; }
export function selectedItem() { return getItem(store.selected); }

export function addItems(items) {
  store.items.push(...items);
  if (!store.selected && store.items.length) store.selected = store.items[0].id;
  emit('list');
  emit('select');
}

export function removeItem(id) {
  const i = store.items.findIndex((x) => x.id === id);
  if (i < 0) return;
  store.items.splice(i, 1);
  if (store.selected === id) store.selected = (store.items[i] || store.items[i - 1] || {}).id || null;
  emit('list');
  emit('select');
}

export function clearItems() {
  store.items.length = 0;
  store.selected = null;
  emit('list');
  emit('select');
}

export function moveItem(id, to) {
  const i = store.items.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [it] = store.items.splice(i, 1);
  store.items.splice(Math.max(0, Math.min(store.items.length, to)), 0, it);
  emit('list');
}

export function sortItems(how) {
  const a = store.items;
  if (how === 'name') a.sort((x, y) => naturalCompare(x.name, y.name));
  else if (how === 'name-desc') a.sort((x, y) => naturalCompare(y.name, x.name));
  else if (how === 'date') a.sort((x, y) => x.mtime - y.mtime || naturalCompare(x.name, y.name));
  else if (how === 'added') a.sort((x, y) => x.id - y.id);
  emit('list');
}

export function selectItem(id) {
  if (store.selected === id) return;
  store.selected = id;
  emit('select');
}

export function updateItem(it, patch) {
  Object.assign(it, patch);
  emit('item', it);
}

export function setMode(mode) {
  store.mode = mode;
  settings.mode = mode;
  saveSettings();
  emit('mode');
}
