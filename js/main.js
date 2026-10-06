// DRE 시작 — 화면 각 부분을 잇는다
import { store, on, setMode, emit } from './store.js';
import { settings, saveSettings, applyTheme } from './settings.js';
import { setupList } from './ui/list.js';
import { setupSide } from './ui/side.js';
import { openSettings, engineChipSetup } from './ui/dialogs.js';
import { setupDrop, pickFiles, pickFolder } from './intake.js';
import { runAll, stopAll, runnable } from './run.js';
import { watchEngine } from './engine.js';
import { loadSavedFolder, savedFolderName, chooseFolder, canPickFolder } from './save.js';
import { toast } from './util.js';

const RUN_LABEL = { pdf: 'PDF로 변환', text: '텍스트 추출', merge: 'PDF로 합치기' };

function syncMode() {
  document.body.dataset.mode = store.mode;
  // 지난 실행의 완료·실패 표시는 다른 할 일에선 헷갈리므로 지운다
  for (const it of store.items) if (['done', 'error', 'warn'].includes(it.state)) { it.state = 'idle'; it.msg = ''; }
  document.getElementById('runStatus').textContent = '';
  emit('list');
  for (const b of document.querySelectorAll('.modes button')) b.setAttribute('aria-selected', String(b.dataset.mode === store.mode));
  syncRun();
}

function syncRun() {
  const btn = document.getElementById('btnRun');
  const n = runnable(store.mode).length;
  btn.textContent = RUN_LABEL[store.mode] + (n > 1 && store.mode !== 'merge' ? ` (${n})` : '');
  btn.disabled = store.running || !n || (store.mode === 'merge' && n < 1);
  btn.hidden = store.running;
  document.getElementById('btnStop').hidden = !store.running;
  document.getElementById('btnAdd').disabled = store.running;
  document.getElementById('btnAddFolder').disabled = store.running;
}

function syncSaveTarget() {
  const sel = document.getElementById('saveTarget');
  sel.value = settings.save;
  const folderOpt = sel.querySelector('option[value="folder"]');
  folderOpt.textContent = savedFolderName() ? `폴더: ${savedFolderName()}` : '폴더 고르기…';
  folderOpt.hidden = !canPickFolder();
  document.getElementById('saveFolderName').textContent = '';
}

async function main() {
  applyTheme();
  for (const b of document.querySelectorAll('.modes button')) b.addEventListener('click', () => { if (!store.running) setMode(b.dataset.mode); });
  document.getElementById('btnAdd').addEventListener('click', pickFiles);
  document.getElementById('btnAddFolder').addEventListener('click', pickFolder);
  document.getElementById('btnRun').addEventListener('click', runAll);
  document.getElementById('btnStop').addEventListener('click', stopAll);
  document.getElementById('btnSettings').addEventListener('click', openSettings);

  const sel = document.getElementById('saveTarget');
  sel.addEventListener('change', async () => {
    if (sel.value === 'folder' && !savedFolderName()) {
      try { await chooseFolder(); } catch { sel.value = settings.save; return; }
    } else if (sel.value === 'folder' && savedFolderName()) {
      // 이미 고른 폴더가 있으면 그대로(바꾸려면 설정에서)
    }
    settings.save = sel.value;
    saveSettings();
    syncSaveTarget();
  });
  on('save-target', syncSaveTarget);

  setupList();
  setupSide();
  setupDrop();
  engineChipSetup();
  on('mode', syncMode);
  on('list', syncRun);
  on('item', syncRun);
  on('running', syncRun);
  syncMode();

  // 단축키: Ctrl+O 파일 추가, Ctrl+Enter 실행
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); if (!store.running) pickFiles(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!store.running) runAll(); }
  });
  // 작업 중에 창을 닫으려 하면 한 번 묻는다
  window.addEventListener('beforeunload', (e) => { if (store.running) { e.preventDefault(); e.returnValue = ''; } });

  await loadSavedFolder();
  syncSaveTarget();
  watchEngine();

  // 오프라인용 보관(서비스워커): PC 안 주소(DRE.exe가 내보냄)·공개 주소 모두. 개발 서버(8410)만 뺀다
  if ('serviceWorker' in navigator && window.isSecureContext && location.port !== '8410') {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw && nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('새 판이 준비됐습니다', { ms: 15000, action: { label: '새로 고침', run: () => location.reload() } });
          }
        });
      });
    }).catch(() => {});
  }
}

main();

// 개발용 시험 고리(개발 서버 8410 에서만)
if (location.port === '8410') {
  import('./intake.js').then((m) => { window.__dre = { addEntries: m.addEntries, store }; });
}
