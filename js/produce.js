// 항목마다 필요한 것 만들기 — PDF(엔진·그림), 뽑은 글(문서 모델). 한 번 만든 것은 다시 쓴다.
import { runJob } from './jobs.js';
import { engineConvert, engineReady, engineCan, checkEngine } from './engine.js';
import { updateItem } from './store.js';
import { OFFICE, IMAGES, engineExt } from './core/detect.js';
import { baseName } from './util.js';

const fail = (code, message) => Object.assign(new Error(message), { code });

// 엔진 일은 한 줄로(엔진도 하나씩 처리하지만, 기다리는 동안 화면에 '대기'로 보이게)
let engineChain = Promise.resolve();
function engineTask(fn) {
  const p = engineChain.then(fn, fn);
  engineChain = p.catch(() => {});
  return p;
}

export function needsEngine(it) {
  return OFFICE.has(it.kind);
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
  if (!OFFICE.has(it.kind)) throw fail('unsupported', '이 형식은 PDF로 바꿀 수 없습니다');
  if (!engineReady()) await checkEngine({ quiet: true });
  if (!engineReady()) throw fail('engine_off', '한글·워드 문서를 PDF로 바꾸려면 DRE 엔진이 켜져 있어야 합니다');
  if (!engineCan(it.kind)) throw fail('no_app', '이 PC에 이 문서를 열 프로그램이 없습니다');
  if (onState) onState('engine-wait');
  return engineTask(async () => {
    if (signal && signal.aborted) throw fail('cancelled', '취소했습니다');
    if (it.pdf) return it.pdf;
    if (onState) onState('engine');
    const name = `${baseName(it.name)}.${engineExt(it.kind)}`;
    const pdf = await engineConvert(it.file, name, 'pdf', { signal });
    updateItem(it, { pdf });
    return pdf;
  });
}

// 뽑은 글(문서 모델). range: 쪽 번호 배열 또는 null
export async function ensureText(it, { range = null, signal, onProgress, onState } = {}) {
  const direct = ['pdf', 'hwp', 'hwpx', 'docx', 'doc'].includes(it.kind);
  if (IMAGES.has(it.kind)) throw fail('unsupported', '그림에서 글을 뽑으려면 문자 인식(OCR)이 필요합니다');
  const bigPdf = it.kind === 'pdf' && (it.pages || 0) > 80;
  // 무엇을 뽑을지 정한다(이미 있으면 그대로)
  let key, payload, alignWith = null;
  if (it.kind === 'pdf') {
    key = bigPdf && range ? 'p:' + range.join(',') : 'all';
    payload = { file: it.file, kind: 'pdf', pages: bigPdf && range ? range : null, password: it.password };
  } else if (direct) {
    // 한글·워드: 문서를 직접 읽는다. 쪽 범위가 있으면 엔진 PDF와 맞춰 쪽을 정확히(한 번 맞추면 어떤 범위든 그대로 씀)
    if (it.textDoc && it.textKey === 'aligned') return it.textDoc;
    const canAlign = !!range && (it.pdf || (engineReady() && engineCan(it.kind)));
    if (it.textDoc && it.textKey === 'raw' && !canAlign) return it.textDoc;
    if (canAlign) {
      try { alignWith = await ensurePdf(it, { signal, onState }); } catch (e) { if (e.code === 'cancelled') throw e; alignWith = null; }
    }
    if (!alignWith && it.textDoc && it.textKey === 'raw') return it.textDoc;
    key = alignWith ? 'aligned' : 'raw';
    payload = { file: it.file, kind: it.kind, alignPdf: alignWith };
  } else {
    // 엑셀·파워포인트·RTF 등: 엔진으로 PDF를 만든 뒤 그 PDF에서 뽑는다
    const pdf = await ensurePdf(it, { signal, onState });
    key = 'all';
    payload = { file: pdf, kind: 'pdf', pages: null };
  }
  if (it.textDoc && it.textKey === key) return it.textDoc;
  if (onState) onState('extract');
  const job = runJob('extract', payload, { onProgress });
  if (signal) signal.addEventListener('abort', () => job.cancel(), { once: true });
  const doc = await job.promise;
  if (range && key === 'raw' && direct && it.kind !== 'pdf') {
    doc.warnings = (doc.warnings || []).concat('쪽 나눔은 문서 안 정보로 어림한 것입니다(DRE 엔진이 켜져 있으면 정확히 맞춥니다).');
  }
  updateItem(it, { textDoc: doc, textKey: key });
  return doc;
}
