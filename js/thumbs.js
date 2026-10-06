// 쪽 그림(썸네일) — 화면에 보이는 쪽만 하나씩 작게 그린다. 1분 쓰지 않으면 PDF 해석기를 내린다.
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
