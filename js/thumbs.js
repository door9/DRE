// 쪽 그림(썸네일) — 화면에 보이는 쪽만 하나씩 작게 그린다. 1분 쓰지 않으면 PDF 해석기를 내린다.
// 형식 변환(PDF 쪽 → PNG·JPG)도 여기서 그린다: 작업 스레드에는 화면이 없어 색 거르기(SVG 필터 — 투명 가리개의 전달 함수)와
// PC 글꼴(PDF 에 안 박힌 글꼴)을 못 써서, 쪽 그림과 똑같은 모양을 내려면 화면 쪽에서 그려야 한다.
import { setImageDpi } from './core/imgmeta.js';

let mod = null;
let pdfWorker = null;
let idle = null;

async function lib() {
  if (!mod) {
    mod = await import('../vendor/pdfjs/pdf.min.mjs');
    mod.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  if (!pdfWorker) pdfWorker = new mod.PDFWorker({ name: 'dre-thumbs' });
  clearTimeout(idle);
  return mod;
}

function scheduleIdle() {
  clearTimeout(idle);
  idle = setTimeout(() => { if (pdfWorker && !openDocs.size) { pdfWorker.destroy(); pdfWorker = null; } }, 60000);
}

const openDocs = new Set();
const BASE = new URL('../vendor/pdfjs/', import.meta.url).href;

export async function openThumbDoc(blob, password = null) {
  const pdfjs = await lib();
  const data = new Uint8Array(await blob.arrayBuffer());
  const task = pdfjs.getDocument({
    data, password: password || undefined, worker: pdfWorker, verbosity: 0,
    cMapUrl: BASE + 'cmaps/', cMapPacked: true, standardFontDataUrl: BASE + 'standard_fonts/', wasmUrl: BASE + 'wasm/', iccUrl: BASE + 'iccs/',
    isEvalSupported: false,
  });
  const doc = await task.promise;
  const h = {
    doc,
    pages: doc.numPages,
    async close() { openDocs.delete(h); try { await task.destroy(); } catch { /* 무시 */ } scheduleIdle(); },
  };
  openDocs.add(h);
  return h;
}

// 한 번에 하나씩 그리는 줄
const queue = [];
let busy = false;
async function pump() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  try {
    if (!job.cancelled) await job.run();
  } catch { /* 그리기 실패는 빈 칸으로 */ }
  busy = false;
  pump();
}

// 쪽 하나를 canvas 에(가로 width 픽셀)
export function renderThumb(h, pageNo, canvas, width = 110, onDone = null) {
  const job = {
    cancelled: false,
    async run() {
      const page = await h.doc.getPage(pageNo);
      try {
        const vp1 = page.getViewport({ scale: 1 });
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const scale = (width * dpr) / vp1.width;
        const vp = page.getViewport({ scale });
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        // 'print' 방식: 화면 갱신 신호(requestAnimationFrame)를 기다리지 않아 창이 가려져도 끝까지 그린다
        const task = page.render({ canvas, viewport: vp, intent: 'print' });
        job.task = task;
        await task.promise;
        if (onDone && !job.cancelled) onDone(canvas);
      } finally {
        page.cleanup();
      }
    },
  };
  queue.push(job);
  pump();
  return { cancel() { job.cancelled = true; if (job.task) try { job.task.cancel(); } catch { /* 무시 */ } } };
}

// ─── 쪽 → 그림 파일(형식 변환) ───
// 그림판 한 장의 상한: 4천만 화소(약 160MB), 긴 변 16000화소. 넘는 쪽(큰 지면을 600dpi 로 등)은 해상도를 낮춘다
export const IMAGE_MAX_PIXELS = 40e6;
export const IMAGE_MAX_SIDE = 16000;

// 쪽 크기(pt, 1/72인치)와 dpi → 그림 크기. lowered: 상한에 걸려 줄였는가, dpi: 실제로 쓴 해상도
export function imageSize(widthPt, heightPt, dpi) {
  let scale = dpi / 72;
  const w = widthPt * scale, h = heightPt * scale;
  const k = Math.min(1, IMAGE_MAX_SIDE / Math.max(w, h), Math.sqrt(IMAGE_MAX_PIXELS / (w * h)));
  scale *= k;
  return { width: Math.max(1, Math.round(widthPt * scale)), height: Math.max(1, Math.round(heightPt * scale)), dpi: scale * 72, lowered: k < 1 };
}

const cancelledError = () => Object.assign(new Error('취소했습니다'), { code: 'cancelled' });

// 쪽 하나를 그림 파일로. type: 'png' | 'jpg'. 돌려주는 것: { blob, width, height, dpi, lowered }
export async function renderPageImage(h, pageNo, { dpi = 150, type = 'png', quality = 0.92, signal = null } = {}) {
  const pdfjs = await lib();
  if (signal && signal.aborted) throw cancelledError();
  const page = await h.doc.getPage(pageNo);
  const canvas = document.createElement('canvas');
  try {
    // 쪽 회전·자르기 상자를 반영한 크기
    const vp1 = page.getViewport({ scale: 1 });
    const size = imageSize(vp1.width, vp1.height, dpi);
    const vp = page.getViewport({ scale: size.dpi / 72 });
    canvas.width = size.width;
    canvas.height = size.height;
    // 그림판은 pdf.js 가 불투명하게 만들고 흰 바탕부터 칠한다(JPG 가 검게 나오지 않게). 화소를 정수로 맞춘 만큼 살짝 늘여 꼭 채운다.
    // 'print': 화면 갱신 신호를 기다리지 않아 창이 가려져도 멈추지 않는다. ENABLE: 양식 칸에 적힌 글까지 그림에 그린다
    const task = page.render({
      canvas, viewport: vp, intent: 'print', annotationMode: pdfjs.AnnotationMode.ENABLE,
      transform: [size.width / vp.width, 0, 0, size.height / vp.height, 0, 0],
    });
    const stop = () => task.cancel();
    if (signal) signal.addEventListener('abort', stop, { once: true });
    try {
      await task.promise;
    } catch (e) {
      if ((signal && signal.aborted) || (e && e.name === 'RenderingCancelledException')) throw cancelledError();
      throw Object.assign(new Error('쪽을 그리지 못했습니다'), { code: 'render' });
    } finally {
      if (signal) signal.removeEventListener('abort', stop);
    }
    const mime = type === 'jpg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise((res) => canvas.toBlob(res, mime, quality));
    if (!blob) throw Object.assign(new Error('그림을 만들지 못했습니다(쪽이 너무 크거나 메모리가 모자랍니다)'), { code: 'encode' });
    const bytes = setImageDpi(new Uint8Array(await blob.arrayBuffer()), size.dpi);
    return { blob: new Blob([bytes], { type: mime }), width: size.width, height: size.height, dpi: size.dpi, lowered: size.lowered };
  } finally {
    canvas.width = canvas.height = 0;
    page.cleanup();
  }
}
