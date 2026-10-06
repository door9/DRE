// 파일 받아들이기 — 파일 추가·폴더 추가·끌어다 놓기·'연결 프로그램으로 열기'(설치한 앱)
// 받은 파일은 작업 일꾼이 속을 들여다봐(probe) 형식·쪽 수를 알아낸다.
import { makeItem, addItems, updateItem, store, emit } from './store.js';
import { runJob } from './jobs.js';
import { extOf, toast } from './util.js';

export const ACCEPT_EXT = new Set(['hwp', 'hwpx', 'hwt', 'doc', 'docx', 'rtf', 'odt', 'pdf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']);
const EXT_KIND = { jpeg: 'jpg', hwt: 'hwp' };
const MAX_FILES = 500;

function guessKind(name) {
  const e = extOf(name);
  return EXT_KIND[e] || e || 'unknown';
}

// entries: [{ file, handle?, dir? }]
export function addEntries(entries) {
  const ok = [];
  let skipped = 0;
  for (const en of entries) {
    if (!en || !en.file) continue;
    if (!ACCEPT_EXT.has(extOf(en.file.name))) { skipped++; continue; }
    if (store.items.length + ok.length >= MAX_FILES) { skipped++; continue; }
    ok.push(makeItem({ file: en.file, handle: en.handle || null, dir: en.dir || null, kind: guessKind(en.file.name) }));
  }
  if (skipped) toast(`다루지 않는 형식이거나 너무 많은 파일 ${skipped}개는 뺐습니다`);
  if (!ok.length) return [];
  addItems(ok);
  for (const it of ok) probe(it);
  return ok;
}

// 형식·쪽 수 알아보기(작업 일꾼에서)
export function probe(it) {
  updateItem(it, { probed: false });
  const job = runJob('probe', { file: it.file, name: it.name }, { timeoutMs: 120000 });
  job.promise.then((r) => {
    const patch = { probed: true, kind: r.kind && r.kind !== 'unknown' ? r.kind : it.kind };
    if (r.error) {
      patch.probeError = r.error;
      patch.probeMsg = r.message || '';
      if (r.error === 'password' && patch.kind === 'pdf') patch.needsPassword = true;
      else if (r.error === 'password') patch.probeMsg = '암호가 걸린 문서입니다(한글·워드에서 암호를 풀어 저장한 뒤 넣어 주세요)';
    } else {
      patch.pages = r.pages ?? null;
      patch.pageExact = !!r.pageExact;
    }
    updateItem(it, patch);
  }).catch((e) => {
    updateItem(it, { probed: true, probeError: e.code || 'failed', probeMsg: e.message });
  });
}

// ─── 파일 고르기 ───
export async function pickFiles() {
  if (window.showOpenFilePicker) {
    try {
      const handles = await window.showOpenFilePicker({
        id: 'dre-open', multiple: true,
        types: [{ description: '문서', accept: { 'application/octet-stream': ['.hwp', '.hwpx', '.doc', '.docx', '.pdf', '.rtf', '.odt', '.xls', '.xlsx', '.ppt', '.pptx', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'] } }],
      });
      const entries = [];
      for (const h of handles) entries.push({ file: await h.getFile(), handle: h });
      addEntries(entries);
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  document.getElementById('filePicker').click();
}

export async function pickFolder() {
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker({ id: 'dre-folder', mode: 'read' });
      const entries = await walkDir(dir);
      if (!entries.length) toast('그 폴더에는 다룰 수 있는 문서가 없습니다');
      addEntries(entries);
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  document.getElementById('folderPicker').click();
}

// 폴더 안을 훑는다(하위 폴더 3단계까지)
async function walkDir(dir, depth = 0, out = []) {
  const kids = [];
  for await (const h of dir.values()) kids.push(h);
  kids.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
  for (const h of kids) {
    if (out.length >= MAX_FILES) break;
    if (h.name.startsWith('.') || h.name.startsWith('~$')) continue;
    if (h.kind === 'file') {
      if (ACCEPT_EXT.has(extOf(h.name))) out.push({ file: await h.getFile(), handle: h, dir });
    } else if (depth < 3) {
      await walkDir(h, depth + 1, out);
    }
  }
  return out;
}

// ─── 끌어다 놓기 ───
async function entriesFromDrop(dt) {
  const out = [];
  const items = [...(dt.items || [])].filter((i) => i.kind === 'file');
  // 크롬: 파일 손잡이(폴더면 안까지) 먼저
  const handles = await Promise.all(items.map((i) => (i.getAsFileSystemHandle ? i.getAsFileSystemHandle().catch(() => null) : null)));
  if (handles.some(Boolean)) {
    for (let k = 0; k < items.length; k++) {
      const h = handles[k];
      if (!h) { const f = items[k].getAsFile(); if (f) out.push({ file: f }); continue; }
      if (h.kind === 'directory') await walkDir(h, 0, out);
      else out.push({ file: await h.getFile(), handle: h });
    }
    return out;
  }
  // 그 밖: 옛 방식(폴더는 webkitGetAsEntry)
  const walkEntry = async (entry, depth) => {
    if (entry.isFile) {
      const f = await new Promise((res) => entry.file(res, () => res(null)));
      if (f) out.push({ file: f });
    } else if (entry.isDirectory && depth < 4) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res) => reader.readEntries(res, () => res([])));
        for (const e of batch) await walkEntry(e, depth + 1);
      } while (batch.length);
    }
  };
  for (const i of items) {
    const e = i.webkitGetAsEntry ? i.webkitGetAsEntry() : null;
    if (e) await walkEntry(e, 0);
    else { const f = i.getAsFile(); if (f) out.push({ file: f }); }
  }
  return out;
}

export function setupDrop() {
  const overlay = document.getElementById('dropOverlay');
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; overlay.hidden = false; });
  window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const entries = await entriesFromDrop(e.dataTransfer);
    addEntries(entries);
  });
  // 옛 방식 고르기 창
  document.getElementById('filePicker').addEventListener('change', (e) => {
    addEntries([...e.target.files].map((file) => ({ file })));
    e.target.value = '';
  });
  document.getElementById('folderPicker').addEventListener('change', (e) => {
    addEntries([...e.target.files].sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, 'ko', { numeric: true })).map((file) => ({ file })));
    e.target.value = '';
  });
  // 설치한 앱에 파일을 끌어다 '연결 프로그램'으로 연 경우
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files || !params.files.length) return;
      const entries = [];
      for (const h of params.files) { try { entries.push({ file: await h.getFile(), handle: h }); } catch { /* 못 읽음 */ } }
      addEntries(entries);
      emit('launched');
    });
  }
}
