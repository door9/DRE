// 항목마다 필요한 것 만들기 — PDF(DRE.exe·그림), 뽑은 글(문서 모델). 한 번 만든 것은 다시 쓴다.
import { runJob } from './jobs.js';
import { engine, engineConvert, engineReady, engineCan, checkEngine } from './engine.js';
import { updateItem } from './store.js';
import { OFFICE, IMAGES, TEXTABLE, SHEETS, SLIDES, ENGINE_PDF, engineExt } from './core/detect.js';
import { baseName, extOf } from './util.js';

const fail = (code, message) => Object.assign(new Error(message), { code });

// DRE.exe일은 한 줄로(DRE.exe도 하나씩 처리하지만, 기다리는 동안 화면에 '대기'로 보이게)
let engineChain = Promise.resolve();
function engineTask(fn) {
  const p = engineChain.then(fn, fn);
  engineChain = p.catch(() => {});
  return p;
}

// PDF로 바꿀 때 DRE.exe가 필요한가(오피스 문서·전자책)
export function needsEngine(it) {
  return ENGINE_PDF.has(it.kind);
}

// 글을 뽑을 때 DRE.exe를 쓰는가: 앱이 직접 못 읽는 것(옛 한글·배포용 한글), 그리고 쪽을 고른 문서(실제 쪽에 맞추려고 — 없으면 어림)
export function textNeedsEngine(it) {
  if (IMAGES.has(it.kind) || it.kind === 'pdf') return false;
  if (!TEXTABLE.has(it.kind) || it.probeError === 'distribution') return OFFICE.has(it.kind);
  return !!it.range && !SLIDES.has(it.kind);
}

// 매크로 문서·쇼 파일은 확장자가 바뀌면 엑셀·파워포인트가 열지 않으므로 원래 이름 그대로 넘긴다
const KEEP_EXT = new Set(['xlsm', 'pptm', 'pps', 'ppsx', 'docm']);
function engineName(it) {
  const e = extOf(it.name);
  return `${baseName(it.name)}.${KEEP_EXT.has(e) ? e : engineExt(it.kind)}`;
}

// 항목의 PDF(Blob)
export async function ensurePdf(it, { signal, onState } = {}) {
  if (it.kind === 'pdf') return it.file;
  if (it.pdf) return it.pdf;
  if (IMAGES.has(it.kind)) {
    const job = runJob('image', { file: it.file, kind: it.kind, title: baseName(it.name) });
    if (signal) signal.addEventListener('abort', () => job.cancel(), { once: true });
    const r = await job.promise;
    updateItem(it, { pdf: r.blob, pdfPages: 1 });
    return r.blob;
  }
  if (!ENGINE_PDF.has(it.kind)) throw fail('unsupported', '이 형식은 PDF로 바꿀 수 없습니다');
  const ebook = it.kind === 'epub';
  if (!engineReady()) await checkEngine({ quiet: true });
  if (!engineReady()) throw fail('engine_off', ebook ? '전자책을 PDF로 바꾸려면 DRE가 켜져 있어야 합니다' : '한글·워드 문서를 PDF로 바꾸려면 DRE가 켜져 있어야 합니다');
  // 전자책 인쇄는 새 판 DRE 부터(옛 판은 상태에 browser 가 없다)
  if (ebook && !('browser' in (engine.apps || {}))) throw fail('engine_old', '설치된 DRE가 옛 판이라 전자책을 PDF로 바꿀 수 없습니다. DRE를 새로 내려받아 설치해 주세요');
  if (!engineCan(it.kind)) throw fail('no_app', ebook ? '이 PC에 엣지·크롬이 없어 전자책을 PDF로 바꿀 수 없습니다' : '이 PC에 이 문서를 열 프로그램이 없습니다');
  if (onState) onState('engine-wait');
  return engineTask(async () => {
    if (signal && signal.aborted) throw fail('cancelled', '취소했습니다');
    if (it.pdf) return it.pdf;
    let src = it.file;
    if (ebook) {
      // 전자책: 장들을 HTML 한 장으로 묶는다(그림·글꼴은 안에, 스크립트·밖 연결은 빼고 — 작업 일꾼)
      if (onState) onState('pack');
      src = (await runWorker('epubhtml', { file: it.file }, signal)).blob;
    }
    if (onState) onState('engine');
    let pdf = await engineConvert(src, engineName(it), 'pdf', { signal });
    // 엣지가 만든 PDF 의 글자 대응표 바로잡기(일부 글꼴의 빈칸이 제어 문자로, 한자가 강희 부수로 적히는 것)
    if (ebook) pdf = (await runWorker('pdffix', { file: pdf }, signal)).blob;
    updateItem(it, { pdf });
    return pdf;
  });
}

// DRE.exe로 PDF를 만들어 그 PDF에서 뽑을 수 있나
const engineAvailable = (it) => !!it.pdf || (engineReady() && engineCan(it.kind));

// 뽑은 글(문서 모델). range: 쪽 번호 배열 또는 null
export async function ensureText(it, { range = null, signal, onProgress, onState } = {}) {
  const direct = TEXTABLE.has(it.kind) && it.kind !== 'pdf' && it.probeError !== 'distribution';
  const bigPdf = it.kind === 'pdf' && (it.pages || 0) > 80;
  // 무엇을 뽑을지 정한다(이미 있으면 그대로)
  let key, payload, alignWith = null;
  if (IMAGES.has(it.kind)) {
    // 그림: 문자 인식으로
    key = 'ocr';
    payload = { file: it.file, kind: it.kind };
  } else if (it.kind === 'pdf') {
    key = bigPdf && range ? 'p:' + range.join(',') : 'all';
    payload = { file: it.file, kind: 'pdf', pages: bigPdf && range ? range : null, password: it.password };
  } else if (direct && SHEETS.has(it.kind) && range && engineAvailable(it)) {
    // 엑셀에서 쪽을 골랐고 DRE가 있으면: 엑셀이 만든 PDF의 실제 쪽에서 뽑는다(시트 하나가 여러 쪽일 수 있다)
    if (it.textDoc && it.textKey === 'enginepdf') return it.textDoc;
    let pdf = null;
    try { pdf = await ensurePdf(it, { signal, onState }); } catch (e) { if (e.code === 'cancelled') throw e; }
    if (pdf) { key = 'enginepdf'; payload = { file: pdf, kind: 'pdf', pages: null }; } else { key = 'raw'; payload = { file: it.file, kind: it.kind }; }
  } else if (direct) {
    // 문서를 직접 읽는다. 문서류(한글·워드·RTF·ODT)는 쪽을 고르면 DRE.exe PDF와 맞춰 쪽을 정확히(한 번 맞추면 어떤 범위든 그대로 씀).
    // 발표 문서는 슬라이드가 곧 쪽이라 맞출 필요가 없다
    if (it.textDoc && it.textKey === 'aligned') return it.textDoc;
    const canAlign = !!range && !SLIDES.has(it.kind) && !SHEETS.has(it.kind) && engineAvailable(it);
    if (it.textDoc && it.textKey === 'raw' && !canAlign) return it.textDoc;
    if (canAlign) {
      try { alignWith = await ensurePdf(it, { signal, onState }); } catch (e) { if (e.code === 'cancelled') throw e; alignWith = null; }
    }
    if (!alignWith && it.textDoc && it.textKey === 'raw') return it.textDoc;
    key = alignWith ? 'aligned' : 'raw';
    payload = { file: it.file, kind: it.kind, alignPdf: alignWith };
  } else {
    // 옛 한글·배포용 한글 등: DRE.exe로 PDF를 만든 뒤 그 PDF에서 뽑는다
    const pdf = await ensurePdf(it, { signal, onState });
    key = 'all';
    payload = { file: pdf, kind: 'pdf', pages: null };
  }
  if (it.textDoc && it.textKey === key) return it.textDoc;
  if (onState) onState(key === 'ocr' ? 'ocr' : 'extract');
  // 같은 글을 이미 뽑는 중이면(미리 보기가 시작한 문자 인식 등) 그것을 기다린다 — 처음부터 다시 하지 않게.
  // 그쪽이 중간에 취소되면(다른 파일을 골랐을 때) 이쪽이 새로 뽑는다
  const pending = it._pending;
  if (pending && pending.key === key) {
    try {
      if (onProgress) pending.listeners.add(onProgress);
      const d = await pending.promise;
      if (it.textDoc && it.textKey === key) return it.textDoc;
      return d;
    } catch (e) {
      if (signal && signal.aborted) throw e;
    } finally {
      if (onProgress) pending.listeners.delete(onProgress);
    }
  }
  let doc;
  try {
    const listeners = new Set(onProgress ? [onProgress] : []);
    const promise = runExtract(payload, { onProgress: (v, note) => { for (const f of listeners) f(v, note); }, signal });
    const mine = { key, promise, listeners };
    it._pending = mine;
    try { doc = await promise; } finally { if (it._pending === mine) it._pending = null; }
  } catch (e) {
    // 직접 읽기가 실패했는데(특이한 파일) DRE가 있으면 예전처럼 PDF를 거쳐 뽑는다
    if (e.code === 'cancelled' || !direct || payload.kind === 'pdf' || !engineAvailable(it)) throw e;
    const pdf = await ensurePdf(it, { signal, onState });
    key = 'enginepdf';
    doc = await runExtract({ file: pdf, kind: 'pdf', pages: null }, { onProgress, signal });
  }
  if (range && key === 'raw' && direct) {
    doc.warnings = (doc.warnings || []).concat(SHEETS.has(it.kind)
      ? '엑셀 문서는 시트 하나를 한 쪽으로 셉니다(DRE가 켜져 있으면 실제 쪽에 맞춥니다).'
      : SLIDES.has(it.kind) ? [] : '쪽 나눔은 문서 안 정보로 어림한 것입니다(DRE가 켜져 있으면 정확히 맞춥니다).');
  }
  updateItem(it, { textDoc: doc, textKey: key });
  return doc;
}

function runWorker(type, payload, signal) {
  const job = runJob(type, payload);
  if (signal) signal.addEventListener('abort', () => job.cancel(), { once: true });
  return job.promise;
}

function runExtract(payload, { onProgress, signal }) {
  const job = runJob('extract', payload, { onProgress });
  if (signal) signal.addEventListener('abort', () => job.cancel(), { once: true });
  return job.promise;
}
