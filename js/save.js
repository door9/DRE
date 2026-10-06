// 결과 저장 — 다운로드 폴더 / 고른 폴더 / 원본과 같은 폴더(폴더로 추가한 파일만)
// 같은 이름이 있으면 덮어쓰지 않고 '이름 (1).pdf' 처럼 새 이름으로 저장한다.
import { kvGet, kvSet } from './settings.js';
import { safeFileName, uniqueName, sleep, baseName, extOf } from './util.js';

let folder = null;

export async function loadSavedFolder() {
  folder = (await kvGet('saveFolder')) || null;
  return folder;
}
export function savedFolderName() { return folder ? folder.name : ''; }
export const canPickFolder = () => 'showDirectoryPicker' in window;

export async function chooseFolder() {
  const d = await window.showDirectoryPicker({ id: 'dre-save', mode: 'readwrite', startIn: 'downloads' });
  folder = d;
  await kvSet('saveFolder', d);
  return d;
}

async function ensureWrite(dir) {
  try {
    if ((await dir.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return (await dir.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

// 실행 버튼을 누른 순간 불러 권한을 받아 둔다(브라우저 규칙: 사용자가 누른 직후에만 물어볼 수 있음)
export async function prepareSave(mode, items) {
  const s = { mode, taken: new Map(), notes: new Set() };
  if (mode === 'folder') {
    if (!folder) folder = await chooseFolder();
    if (!(await ensureWrite(folder))) throw Object.assign(new Error('저장 폴더에 쓸 권한을 받지 못했습니다'), { code: 'permission' });
  } else if (mode === 'source') {
    const dirs = new Set(items.map((it) => it.dir).filter(Boolean));
    for (const d of dirs) if (!(await ensureWrite(d))) s.denied = true;
    if (items.some((it) => !it.dir)) s.notes.add('폴더로 추가하지 않은 파일은 다운로드 폴더에 저장했습니다');
  }
  return s;
}

async function exists(dir, name) {
  try { await dir.getFileHandle(name); return true; } catch { return false; }
}

async function writeToDir(dir, s, name, blob) {
  let taken = s.taken.get(dir);
  if (!taken) { taken = new Set(); s.taken.set(dir, taken); }
  let n = uniqueName(name, taken);
  for (let i = 1; await exists(dir, n) && i < 1000; i++) n = `${baseName(name)} (${i})${extOf(name) ? '.' + extOf(name) : ''}`;
  taken.add(n.toLowerCase());
  const fh = await dir.getFileHandle(n, { create: true });
  const w = await fh.createWritable();
  try { await w.write(blob); await w.close(); } catch (e) { try { await w.abort(); } catch { /* 무시 */ } throw e; }
  return n;
}

let lastDownload = 0;
async function download(s, name, blob) {
  let taken = s.taken.get('dl');
  if (!taken) { taken = new Set(); s.taken.set('dl', taken); }
  const n = uniqueName(name, taken);
  // 여러 파일을 너무 빨리 내려받으면 브라우저가 막으므로 사이를 둔다
  const wait = 350 - (Date.now() - lastDownload);
  if (wait > 0) await sleep(wait);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = n;
  document.body.append(a);
  a.click();
  a.remove();
  lastDownload = Date.now();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return n;
}

// 저장하고 실제 이름과 자리를 돌려준다
export async function saveOutput(s, item, name, blob) {
  name = safeFileName(name);
  // 개발 시험용: 결과를 내려받지 않고 모아 둔다(개발 서버에서 시험 코드가 켰을 때만)
  if (Array.isArray(globalThis.__dreCapture)) { globalThis.__dreCapture.push({ name, blob }); return { name, where: '시험' }; }
  if (s.mode === 'folder' && folder) return { name: await writeToDir(folder, s, name, blob), where: folder.name };
  if (s.mode === 'source' && item && item.dir && !s.denied) {
    try { return { name: await writeToDir(item.dir, s, name, blob), where: item.dir.name }; } catch { /* 아래로 */ }
  }
  return { name: await download(s, name, blob), where: '다운로드' };
}

// 글(TXT) 바이트: UTF-8, 필요하면 앞에 BOM
export function textBlob(text, { bom = true } = {}) {
  const enc = new TextEncoder().encode(text);
  return new Blob(bom ? [new Uint8Array([0xef, 0xbb, 0xbf]), enc] : [enc], { type: 'text/plain;charset=utf-8' });
}
