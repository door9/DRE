// 실행 — 고른 할 일(PDF로 변환 / 텍스트 추출 / PDF 합치기 / 형식 변환)을 목록 차례대로 처리하고 저장한다
import { store, updateItem, emit } from './store.js';
import { settings, renderOptions } from './settings.js';
import { ensurePdf, ensureText, needsEngine, textNeedsEngine } from './produce.js';
import { runJob, cancelAll } from './jobs.js';
import { prepareSave, saveOutput, textBlob } from './save.js';
import { render, formatRange } from './core/model.js';
import { engine, engineReady, launchEngine, engineCan } from './engine.js';
import { OFFICE, IMAGES, TEXTABLE, ENGINE_PDF, TO_IMAGE } from './core/detect.js';
import { openThumbDoc, renderPageImage } from './thumbs.js';
import { baseName, fmtNum, toast } from './util.js';

let abort = null;
let starting = false; // DRE.exe 켜기·폴더 권한을 기다리는 동안 두 번 눌리지 않게

// 이 할 일에 넣을 수 있는가(못 하면 까닭)
export function whyNot(it, mode) {
  if (it.kind === 'unknown') return '알 수 없는 형식입니다';
  // 목록 줄에 뜨는 글이라 짧게(휴대폰 폭에서 줄이 넘치지 않게) — 자세한 안내는 오른쪽 패널에
  if (mode === 'convert' && !TO_IMAGE.has(it.kind)) return 'PDF·한글·워드만 바꿀 수 있습니다';
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

// 형식 변환으로 만들 그림 수(고른 쪽, 안 골랐으면 전체 쪽). approx: 쪽 수를 어림한 한글·워드 문서를 전체로 넣었는가
// (DRE 가 PDF 를 만들어 쪽 그림을 보여 주면 정확해진다)
export function imageCount() {
  let n = 0, approx = false;
  for (const it of runnable('convert')) {
    n += it.range ? it.range.length : it.pages || 0;
    if (!it.range && !it.pageExact) approx = true;
  }
  return { n, approx };
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

  // DRE.exe가 필요한데 꺼져 있으면 지금 켠다(글 뽑기는 앱이 직접 못 읽는 것과, 쪽을 맞출 문서만. 형식 변환은 한글·워드 문서만)
  const wantEngine = items.some((it) => (mode === 'text' ? textNeedsEngine(it) : mode === 'convert' ? it.kind !== 'pdf' : needsEngine(it)));
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
        toast(mode === 'text' ? 'DRE를 켜지 못해 옛 한글·배포용 문서는 건너뜁니다.'
          : mode === 'convert' ? 'DRE를 켜지 못했습니다. 한글·워드 문서는 건너뜁니다.' : 'DRE를 켜지 못했습니다. 한글·워드·전자책 문서는 건너뜁니다.', { bad: true, ms: 6000 });
        import('./ui/dialogs.js').then((m) => m.openEngineDialog());
      } else toast('DRE를 켜지 못해 쪽 나눔은 문서 안 정보로 어림합니다.', { ms: 5000 });
    }
  }

  store.running = true;
  abort = new AbortController();
  emit('running');
  for (const it of store.items) updateItem(it, { state: items.includes(it) ? 'queued' : 'idle', msg: '', progress: 0 });
  let ok = 0, bad = 0, images = 0;
  const t0 = Date.now();
  const doing = { pdf: 'PDF로 바꾸는 중', text: '글 뽑는 중', convert: '그림으로 바꾸는 중' }[mode];
  try {
    if (mode === 'merge') {
      const r = await mergeAll(items, session);
      ok = r ? 1 : 0;
      bad = r ? 0 : 1;
    } else {
      for (let i = 0; i < items.length; i++) {
        if (abort.signal.aborted) break;
        const it = items[i];
        setStatus(`${i + 1}/${items.length} ${doing}…`);
        updateItem(it, { state: 'working', progress: 0, msg: '' });
        try {
          const out = mode === 'pdf' ? await convertOne(it, session) : mode === 'convert' ? await imagesOne(it, session) : await textOne(it, session);
          updateItem(it, { state: out.warn ? 'warn' : 'done', msg: out.warn || out.msg || `저장: ${out.saved.name}`, progress: 1, output: out });
          ok++;
          images += out.count || 0;
        } catch (e) {
          images += e.saved || 0;
          if (e.code === 'cancelled' || abort.signal.aborted) {
            // 그림으로 바꾸다 멈추면 그때까지 저장한 장 수를 남긴다
            updateItem(it, e.saved ? { state: 'warn', msg: `중지 — ${fmtNum(e.saved)}장은 저장했습니다` } : { state: 'idle', msg: '' });
            break;
          }
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
      const where = settings.save === 'download' ? ' (다운로드 폴더)' : '';
      if (mode === 'convert') { if (images) toast(`그림 ${fmtNum(images)}장을 저장했습니다${where}`); }
      else if (ok && mode !== 'merge') toast(`${ok}개 저장했습니다${where}`);
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
  const onState = (s) => updateItem(it, { msg: s === 'engine-wait' ? '차례 기다리는 중' : s === 'pack' ? '전자책 묶는 중'
    : s === 'engine' ? (it.kind.startsWith('hwp') ? '한글로 PDF 만드는 중' : it.kind === 'epub' ? `${engine.browserName || '엣지'}로 PDF 만드는 중` : '프로그램으로 PDF 만드는 중') : '' });
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
  const onState = (s) => updateItem(it, { msg: s === 'engine-wait' ? '차례 기다리는 중' : s === 'engine' || s === 'pack' ? '쪽 맞추려고 PDF 만드는 중' : s === 'ocr' ? '문자 인식 중' : '글 뽑는 중' });
  const doc = await ensureText(it, { range: it.range, signal, onState, onProgress: (v, note) => updateItem(it, note === 'ocr' ? { progress: v, msg: '문자 인식 중' } : { progress: v }) });
  const text = render(doc, renderOptions(), it.range ? new Set(it.range) : null);
  const blob = textBlob(text, { bom: settings.bom });
  const saved = await saveOutput(session, it, `${baseName(it.name)}.txt`, blob);
  // 많이 한꺼번에 뽑을 때는 보고 있지 않은 문서의 뽑은 글을 바로 놓아 메모리를 아낀다(다시 고르면 새로 뽑음)
  if (store.items.length > 20 && store.selected !== it.id) updateItem(it, { textDoc: null, textKey: null });
  const warn = !text.trim() ? '뽑을 글이 없습니다' + (doc.warnings && doc.warnings[0] ? ` — ${doc.warnings[0]}` : '') : null;
  return { saved, blob, warn: warn ? `${warn} (저장: ${saved.name})` : null };
}

// 형식 변환: PDF 쪽 → 그림 파일(쪽마다 하나). 한 쪽씩 그려 바로 저장한다(쪽이 많아도 메모리에 쌓이지 않게).
// 한글·워드 문서는 DRE.exe 가 이 PC 의 한글·워드로 만든 PDF 에서 그린다(쪽 그림을 볼 때 만든 PDF 가 있으면 그것을 다시 쓴다).
// 한 쪽을 못 그려도 나머지는 이어서 하고 끝에 알린다. 멈추거나 실패하면 그때까지 저장한 장 수를 오류에 붙인다(e.saved)
async function imagesOne(it, session) {
  const signal = abort.signal;
  const ext = settings.convert.to === 'jpg' ? 'jpg' : 'png';
  const dpi = settings.convert.dpi || 150;
  const cancelled = () => Object.assign(new Error('취소했습니다'), { code: 'cancelled' });
  const isPdf = it.kind === 'pdf';
  let src = it.file;
  if (!isPdf) {
    const app = it.kind.startsWith('hwp') ? '한글' : '워드';
    src = await ensurePdf(it, { signal, onState: (s) => updateItem(it, { msg: s === 'engine-wait' ? '차례 기다리는 중' : `${app}로 PDF 만드는 중` }) });
  }
  updateItem(it, { msg: 'PDF 여는 중' });
  let hd;
  try {
    hd = await openThumbDoc(src, isPdf ? it.password : null);
  } catch (e) {
    if (isPdf && e && e.name === 'PasswordException') {
      updateItem(it, { needsPassword: true, password: null });
      throw Object.assign(new Error(e.code === 2 ? '암호가 맞지 않습니다' : '열 때 암호가 필요한 PDF입니다'), { code: 'password' });
    }
    throw Object.assign(new Error(isPdf ? 'PDF를 열지 못했습니다(손상된 파일일 수 있습니다)' : 'DRE가 만든 PDF를 열지 못했습니다'), { code: 'broken' });
  }
  const names = [], failed = [];
  try {
    const total = hd.pages;
    // 한글·워드는 쪽 수를 어림했었다 — 실제 PDF 쪽 수로 바로잡는다
    if (isPdf ? !it.pages : it.pdfPages !== total) updateItem(it, isPdf ? { pages: total, pageExact: true } : { pdfPages: total, pages: total, pageExact: true });
    const want = it.range || Array.from({ length: total }, (_, i) => i + 1);
    const pages = want.filter((n) => n >= 1 && n <= total);
    // 어림한 쪽 수로 골랐다면 실제 문서에 없는 쪽이 있을 수 있다(건너뛰고 알린다)
    const missing = want.filter((n) => n > total);
    if (!pages.length) throw Object.assign(new Error(`고른 쪽이 문서에 없습니다(전체 ${total}쪽)`), { code: 'range' });
    let one = null, minDpi = dpi;
    for (const n of pages) {
      if (signal.aborted) throw cancelled();
      updateItem(it, { msg: `${fmtNum(names.length + failed.length + 1)}/${fmtNum(pages.length)}장` });
      let r;
      try {
        r = await renderPageImage(hd, n, { dpi, type: ext, signal });
      } catch (e) {
        if (e.code === 'cancelled' || signal.aborted) throw cancelled();
        console.warn(`${n}쪽 그림 실패`, e);
        failed.push(n);
        continue;
      }
      const name = total > 1 ? `${baseName(it.name)} (${n}쪽).${ext}` : `${baseName(it.name)}.${ext}`;
      names.push((await saveOutput(session, it, name, r.blob)).name);
      if (r.lowered) minDpi = Math.min(minDpi, r.dpi);
      if (pages.length === 1) one = r.blob;
      updateItem(it, { progress: (names.length + failed.length) / pages.length });
    }
    if (!names.length) throw Object.assign(new Error(`쪽을 그리지 못했습니다(${formatRange(failed)}쪽)`), { code: 'render' });
    let msg = `저장: ${names[0]}${names.length > 1 ? ` 외 ${fmtNum(names.length - 1)}장` : ''}`;
    if (minDpi < dpi) msg += ` · 큰 쪽은 약 ${Math.floor(minDpi)}dpi로 낮춤`;
    const warn = failed.length ? `${formatRange(failed)}쪽은 그리지 못했습니다 (${msg})`
      : missing.length ? `${formatRange(missing)}쪽은 문서에 없어 건너뛰었습니다(전체 ${total}쪽) (${msg})` : null;
    return { msg, warn, count: names.length, blob: one };
  } catch (e) {
    e.saved = names.length;
    throw e;
  } finally {
    hd.close();
  }
}

async function mergeAll(items, session) {
  const signal = abort.signal;
  const parts = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (signal.aborted) return null;
    updateItem(it, { state: 'working', msg: ENGINE_PDF.has(it.kind) ? '' : '준비' });
    setStatus(`${i + 1}/${items.length} 준비 중…`);
    try {
      let file = it.file, kind = it.kind;
      if (ENGINE_PDF.has(it.kind)) {
        file = await ensurePdf(it, { signal, onState: (s) => updateItem(it, { msg: s === 'engine-wait' ? '차례 기다리는 중' : s === 'pack' ? '전자책 묶는 중' : 'PDF 만드는 중' }) });
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
