// 실행 — 고른 할 일(PDF로 변환 / 텍스트 추출 / PDF 합치기)을 목록 차례대로 처리하고 저장한다
import { store, updateItem, emit } from './store.js';
import { settings, renderOptions } from './settings.js';
import { ensurePdf, ensureText, needsEngine, textNeedsEngine } from './produce.js';
import { runJob, cancelAll } from './jobs.js';
import { prepareSave, saveOutput, textBlob } from './save.js';
import { render, formatRange } from './core/model.js';
import { engineReady, launchEngine, engineCan } from './engine.js';
import { OFFICE, IMAGES, TEXTABLE } from './core/detect.js';
import { baseName, toast } from './util.js';

let abort = null;
let starting = false; // DRE.exe 켜기·폴더 권한을 기다리는 동안 두 번 눌리지 않게

// 이 할 일에 넣을 수 있는가(못 하면 까닭)
export function whyNot(it, mode) {
  if (it.kind === 'unknown') return '알 수 없는 형식입니다';
  if (it.probeError === 'broken') return it.probeMsg || '파일이 손상된 것 같습니다';
  if (it.probeError === 'password' && it.kind !== 'pdf') return '암호가 걸린 문서입니다';
  if (it.probeError === 'distribution' && mode === 'text') return null; // 배포용 한글: DRE.exe로 PDF를 만든 뒤 뽑는다(produce.js)
  if (it.probeError === 'drm') return '보안(DRM)이 걸린 문서입니다';
  if (it.range && !it.range.length) return '고른 쪽이 없습니다';
  if (mode === 'pdf') {
    if (it.kind === 'pdf' && !it.range) return '이미 PDF(건너뜀)';
    return null;
  }
  if (mode === 'text') return null; // 그림은 문자 인식으로 읽는다
  return null;
}

export function runnable(mode) {
  return store.items.filter((it) => !whyNot(it, mode));
}

export function mergeName() {
  const v = (document.getElementById('mergeName') || {}).value;
  if (v && v.trim()) return v.trim().replace(/\.pdf$/i, '');
  const items = runnable('merge');
  if (!items.length) return '합본';
  return items.length > 1 ? `${baseName(items[0].name)} 외 ${items.length - 1}건` : baseName(items[0].name);
}

function setStatus(text) {
  const el = document.getElementById('runStatus');
  if (el) el.textContent = text || '';
}

function failMsg(e) {
  return (e && e.message) || '실패했습니다';
}

// 실행 버튼(사용자가 누른 순간 불린다 — DRE.exe 켜기·저장 폴더 권한은 이때만 물을 수 있다)
export async function runAll() {
  if (store.running || starting) return;
  const mode = store.mode;
  const items = runnable(mode);
  if (!items.length) { toast('처리할 파일이 없습니다'); return; }
  starting = true;
  try {
    await runInner(mode, items);
  } finally {
    starting = false;
  }
}

async function runInner(mode, items) {

  // DRE.exe가 필요한데 꺼져 있으면 지금 켠다(글 뽑기는 앱이 직접 못 읽는 것과, 쪽을 맞출 문서만)
  const wantEngine = items.some((it) => (mode === 'text' ? textNeedsEngine(it) : needsEngine(it)));
  let enginePromise = null;
  if (wantEngine && !engineReady()) enginePromise = launchEngine();

  let session;
  try {
    session = await prepareSave(settings.save, items);
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    toast(failMsg(e), { bad: true });
    return;
  }
  if (enginePromise) {
    setStatus('DRE를 켜는 중…');
    if (!(await enginePromise)) {
      setStatus('');
      // 글 뽑기에서 DRE가 꼭 있어야 하는 것은 옛 한글·배포용 한글뿐(나머지는 쪽을 어림해 직접 뽑는다)
      const hard = mode !== 'text' || items.some((it) => (OFFICE.has(it.kind) && !TEXTABLE.has(it.kind)) || it.probeError === 'distribution');
      if (hard) {
        toast(mode === 'text' ? 'DRE를 켜지 못해 옛 한글·배포용 문서는 건너뜁니다.' : 'DRE를 켜지 못했습니다. 한글·워드 문서는 건너뜁니다.', { bad: true, ms: 6000 });
        import('./ui/dialogs.js').then((m) => m.openEngineDialog());
      } else toast('DRE를 켜지 못해 쪽 나눔은 문서 안 정보로 어림합니다.', { ms: 5000 });
    }
  }

  store.running = true;
  abort = new AbortController();
  emit('running');
  for (const it of store.items) updateItem(it, { state: items.includes(it) ? 'queued' : 'idle', msg: '', progress: 0 });
  let ok = 0, bad = 0;
  const t0 = Date.now();
  try {
    if (mode === 'merge') {
      const r = await mergeAll(items, session);
      ok = r ? 1 : 0;
      bad = r ? 0 : 1;
    } else {
      for (let i = 0; i < items.length; i++) {
        if (abort.signal.aborted) break;
        const it = items[i];
        setStatus(`${i + 1}/${items.length} ${mode === 'pdf' ? 'PDF로 바꾸는 중' : '글 뽑는 중'}…`);
        updateItem(it, { state: 'working', progress: 0, msg: '' });
        try {
          const out = mode === 'pdf' ? await convertOne(it, session) : await textOne(it, session);
          updateItem(it, { state: out.warn ? 'warn' : 'done', msg: out.warn || `저장: ${out.saved.name}`, progress: 1, output: out });
          ok++;
        } catch (e) {
          if (e.code === 'cancelled' || abort.signal.aborted) { updateItem(it, { state: 'idle', msg: '' }); break; }
          updateItem(it, { state: 'error', msg: failMsg(e) });
          bad++;
        }
      }
    }
  } finally {
    store.running = false;
    for (const it of store.items) if (it.state === 'queued' || it.state === 'working') updateItem(it, { state: 'idle', msg: '' });
    emit('running');
    const secs = Math.round((Date.now() - t0) / 1000);
    setStatus(abort.signal.aborted ? '중지했습니다' : `끝 · 성공 ${ok}${bad ? ` · 실패 ${bad}` : ''} · ${secs}초`);
    if (!abort.signal.aborted) {
      const where = settings.save === 'download' ? '다운로드 폴더' : '';
      if (ok && mode !== 'merge') toast(`${ok}개 저장했습니다${where ? ' (' + where + ')' : ''}`);
      for (const n of session.notes) toast(n);
    }
    abort = null;
  }
}

// 결과를 새 창에서 보기(PDF는 브라우저 PDF 보기, TXT는 글로)
export function openBlob(blob) {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
}

export function stopAll() {
  if (abort) abort.abort();
  cancelAll();
}

async function convertOne(it, session) {
  const signal = abort.signal;
  const onState = (s) => updateItem(it, { msg: s === 'engine-wait' ? '차례 기다리는 중' : s === 'engine' ? (it.kind.startsWith('hwp') ? '한글로 PDF 만드는 중' : '프로그램으로 PDF 만드는 중') : '' });
  let pdf = await ensurePdf(it, { signal, onState });
  let name = `${baseName(it.name)}.pdf`;
  if (it.range) {
    updateItem(it, { msg: '쪽 뽑는 중' });
    const job = runJob('build', { parts: [{ file: pdf, kind: 'pdf', pages: it.range, password: it.password, title: baseName(it.name) }], outline: false }, { onProgress: (v) => updateItem(it, { progress: v }) });
    signal.addEventListener('abort', () => job.cancel(), { once: true });
    pdf = (await job.promise).blob;
    if (it.kind === 'pdf') name = `${baseName(it.name)} (${formatRange(it.range)}쪽).pdf`;
  }
  const saved = await saveOutput(session, it, name, pdf);
  return { saved, blob: pdf };
}

async function textOne(it, session) {
  const signal = abort.signal;
  const onState = (s) => updateItem(it, { msg: s === 'engine-wait' ? '차례 기다리는 중' : s === 'engine' ? '쪽 맞추려고 PDF 만드는 중' : s === 'ocr' ? '문자 인식 중' : '글 뽑는 중' });
  const doc = await ensureText(it, { range: it.range, signal, onState, onProgress: (v, note) => updateItem(it, note === 'ocr' ? { progress: v, msg: '문자 인식 중' } : { progress: v }) });
  const text = render(doc, renderOptions(), it.range ? new Set(it.range) : null);
  const blob = textBlob(text, { bom: settings.bom });
  const saved = await saveOutput(session, it, `${baseName(it.name)}.txt`, blob);
  // 많이 한꺼번에 뽑을 때는 보고 있지 않은 문서의 뽑은 글을 바로 놓아 메모리를 아낀다(다시 고르면 새로 뽑음)
  if (store.items.length > 20 && store.selected !== it.id) updateItem(it, { textDoc: null, textKey: null });
  const warn = !text.trim() ? '뽑을 글이 없습니다' + (doc.warnings && doc.warnings[0] ? ` — ${doc.warnings[0]}` : '') : null;
  return { saved, blob, warn: warn ? `${warn} (저장: ${saved.name})` : null };
}

async function mergeAll(items, session) {
  const signal = abort.signal;
  const parts = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (signal.aborted) return null;
    updateItem(it, { state: 'working', msg: OFFICE.has(it.kind) ? '' : '준비' });
    setStatus(`${i + 1}/${items.length} 준비 중…`);
    try {
      let file = it.file, kind = it.kind;
      if (OFFICE.has(it.kind)) {
        file = await ensurePdf(it, { signal, onState: (s) => updateItem(it, { msg: s === 'engine-wait' ? '차례 기다리는 중' : 'PDF 만드는 중' }) });
        kind = 'pdf';
      } else if (!IMAGES.has(it.kind) && it.kind !== 'pdf') {
        throw Object.assign(new Error('합칠 수 없는 형식입니다'), { code: 'unsupported' });
      }
      parts.push({ file, kind, pages: it.range, password: it.password, title: baseName(it.name) });
      updateItem(it, { state: 'queued', msg: '준비됨' });
    } catch (e) {
      if (e.code === 'cancelled' || signal.aborted) return null;
      updateItem(it, { state: 'error', msg: failMsg(e) });
      toast(`'${it.name}'을(를) 준비하지 못해 합치지 않았습니다: ${failMsg(e)}`, { bad: true, ms: 7000 });
      return null;
    }
  }
  setStatus('합치는 중…');
  for (const it of items) updateItem(it, { state: 'working', msg: '합치는 중' });
  const name = mergeName();
  const job = runJob('build', { parts, outline: settings.merge.outline, title: name }, { onProgress: (v) => { for (const it of items) updateItem(it, { progress: v }); } });
  signal.addEventListener('abort', () => job.cancel(), { once: true });
  let blob;
  try {
    blob = (await job.promise).blob;
  } catch (e) {
    if (e.code === 'cancelled' || signal.aborted) return null;
    const bad = e.index != null ? items[e.index] : null;
    if (bad) updateItem(bad, { state: 'error', msg: failMsg(e) });
    for (const it of items) if (it !== bad) updateItem(it, { state: 'idle', msg: '' });
    toast(`합치지 못했습니다${bad ? ` ('${bad.name}')` : ''}: ${failMsg(e)}`, { bad: true, ms: 7000 });
    return null;
  }
  const saved = await saveOutput(session, items[0], `${name}.pdf`, blob);
  for (const it of items) updateItem(it, { state: 'done', msg: '', progress: 1 });
  toast(`합친 PDF를 저장했습니다: ${saved.name}`, { ms: 8000, action: { label: '열기', run: () => openBlob(blob) } });
  return saved;
}
