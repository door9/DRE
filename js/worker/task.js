// DRE 작업 일꾼 — 글 뽑기·PDF 만들기처럼 무거운 일을 화면과 다른 스레드에서 한다.
// 화면 쪽(js/jobs.js)과 메시지로 주고받는다: { id, type, ... } → { id, type: 'progress'|'done'|'error', ... }
// 파일은 Blob 그대로 받아 여기서 읽는다(화면 쪽 메모리에 두 번 올리지 않게).
// 일꾼이 멈추거나 메모리를 너무 쓰면 화면 쪽이 통째로 끝내고 새로 만든다(앱 전체가 멈추지 않게).
import * as pdfjs from '../../vendor/pdfjs/pdf.min.mjs';
import { extractPdfDoc, pageTexts, docFromOcrPage } from '../core/pdfextract.js';
import { buildPdf, imageToPdf, inspectPdf } from '../core/pdfops.js';
import { alignPages } from '../core/align.js';
import { detectKind, IMAGE_MIME, TEXTABLE } from '../core/detect.js';
import { isCfb } from '../core/cfb.js';
import { toGray, toPnm, rulesFromGray, pageFromOcr } from '../core/ocr.js';
import { loadDictionary } from '../core/dict.js';

// 작업 스레드용 그림판 — pdf.js 기본값은 화면(document)에 canvas 를 만들려 해서 스레드에서는 쪽을 그리지 못한다
class WorkerCanvasFactory {
  constructor({ enableHWA = false } = {}) { this.hwa = enableHWA; }
  create(w, h) {
    if (w <= 0 || h <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(w, h);
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: !this.hwa }) };
  }
  reset(cc, w, h) { if (!cc.canvas) throw new Error('Canvas is not specified'); cc.canvas.width = w; cc.canvas.height = h; }
  destroy(cc) { if (cc.canvas) { cc.canvas.width = 0; cc.canvas.height = 0; } cc.canvas = null; cc.context = null; }
}
// 색 걸러내기(SVG 필터)도 화면이 있어야 한다 — 글자를 읽는 데는 필요 없으니 하지 않는다
class WorkerFilterFactory {
  addFilter() { return 'none'; }
  addHCMFilter() { return 'none'; }
  addAlphaFilter() { return 'none'; }
  addLuminosityFilter() { return 'none'; }
  addKnockoutFilter() { return 'none'; }
  addHighlightHCMFilter() { return 'none'; }
  addSelectionHCMFilter() { return 'none'; }
  addSelectionFilter() { return 'none'; }
  createSelectionStyle() { return null; }
  destroy() {}
}

const BASE = new URL('../../vendor/pdfjs/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';
const PDF_OPTS = {
  cMapUrl: BASE + 'cmaps/', cMapPacked: true, standardFontDataUrl: BASE + 'standard_fonts/', wasmUrl: BASE + 'wasm/',
  iccUrl: BASE + 'iccs/', disableFontFace: true, isEvalSupported: false, useSystemFonts: false,
  // 작업 스레드에는 화면(document)이 없다. 이 값을 직접 주지 않으면 pdf.js 가 document.baseURI 를 찾다 멈춘다
  useWorkerFetch: true,
  CanvasFactory: WorkerCanvasFactory, FilterFactory: WorkerFilterFactory,
};

// ─── 문자 인식(OCR) ───
// 인식기(tesseract)는 처음 쓸 때 띄우고, 이 일꾼이 살아 있는 동안 다시 쓴다(일꾼을 끝내면 함께 끝난다)
const OCR_BASE = new URL('../../vendor/tesseract/', import.meta.url).href;
const OCR_DPI = 200;
let tess = null;
let ocrProgress = null; // 지금 읽는 쪽의 진행(0~1)을 받을 곳
function tesseract() {
  if (!tess) {
    tess = (async () => {
      const T = (await import('../../vendor/tesseract/tesseract.esm.min.js')).default;
      return T.createWorker('kor+eng', 1, {
        workerPath: OCR_BASE + 'worker.min.js', corePath: OCR_BASE + 'tesseract-core-simd-lstm.js', langPath: OCR_BASE + 'lang',
        workerBlobURL: false, cacheMethod: 'none', gzip: true,
        logger: (m) => { if (ocrProgress && m && m.status === 'recognizing text') ocrProgress(m.progress || 0); },
      });
    })().catch((e) => {
      tess = null;
      console.error('문자 인식기 오류', e);
      throw fail('ocr', '이 브라우저에서 문자 인식기를 띄우지 못했습니다');
    });
  }
  return tess;
}

// 회색조 그림 한 장을 읽어 쪽 자료로(width·height: 쪽 크기, scale: 그림 픽셀 / 쪽 단위)
async function ocrGray(gray, W, H, { width, height, scale }, onProgress) {
  const rules = rulesFromGray(gray, W, H, scale);
  const t = await tesseract();
  ocrProgress = onProgress || null;
  try {
    const r = await t.recognize(toPnm(gray, W, H), {}, { blocks: true, text: false });
    return pageFromOcr(r.data.blocks, { width, height, scale, rules, image: { gray, w: W, h: H } });
  } finally {
    ocrProgress = null;
  }
}

// PDF 쪽을 그림으로 그려 읽는다(200dpi, 아주 큰 쪽은 긴 변 4500픽셀까지)
async function ocrPdfPage(page, { onProgress } = {}) {
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(OCR_DPI / 72, 4500 / Math.max(vp1.width, vp1.height));
  const vp = page.getViewport({ scale });
  const W = Math.max(1, Math.ceil(vp.width)), H = Math.max(1, Math.ceil(vp.height));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  await page.render({ canvas, viewport: vp, intent: 'print' }).promise;
  const gray = toGray(ctx.getImageData(0, 0, W, H).data, W, H);
  canvas.width = canvas.height = 0;
  return ocrGray(gray, W, H, { width: vp1.width, height: vp1.height, scale }, onProgress);
}

// 그림 파일을 읽는다 — 작은 그림은 키우고(인식기는 글자 높이 20~30픽셀에서 잘 읽는다) 아주 큰 그림은 줄인다
async function ocrImage(bytes, mime, onProgress) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }), { imageOrientation: 'from-image' });
  const long = Math.max(bmp.width, bmp.height);
  const k = Math.max(0.25, Math.min(3, (long < 2000 ? 2000 : Math.min(long, 4500)) / long));
  const W = Math.max(1, Math.round(bmp.width * k)), H = Math.max(1, Math.round(bmp.height * k));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, W, H);
  bmp.close();
  const gray = toGray(ctx.getImageData(0, 0, W, H).data, W, H);
  canvas.width = canvas.height = 0;
  // 쪽 크기는 A4 너비(595pt)에 맞춘 단위로(배치 분석의 기준 값들이 PDF 와 비슷한 크기가 되게)
  const scale = W / 595;
  return ocrGray(gray, W, H, { width: 595, height: H / scale, scale }, onProgress);
}
const loadPdfLib = () => import('../../vendor/pdf-lib.mjs');

const cancelled = new Set();
const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const bytesOf = async (m) => (m.bytes ? m.bytes : new Uint8Array(await m.file.arrayBuffer()));
const fail = (code, message) => Object.assign(new Error(message), { code });

// 형식별 해석기는 쓸 때 불러온다(처음 여는 속도·메모리)
async function parseOffice(kind, bytes, onProgress) {
  let parse;
  switch (kind) {
    case 'hwp': parse = (await import('../core/hwp.js')).parseHwp; break;
    case 'hwpx': parse = (await import('../core/hwpx.js')).parseHwpx; break;
    case 'docx': parse = (await import('../core/docx.js')).parseDocx; break;
    case 'doc': parse = (await import('../core/doc.js')).parseDoc; break;
    case 'rtf': parse = (await import('../core/rtf.js')).parseRtf; break;
    case 'xlsx': parse = (await import('../core/xlsx.js')).parseXlsx; break;
    // 옛 엑셀: 복합 문서(BIFF)가 아니면 웹 페이지 표·엑셀 2003 XML 로 저장된 것
    case 'xls': parse = isCfb(bytes) ? (await import('../core/xls.js')).parseXls : (await import('../core/xlsml.js')).parseXlsMarkup; break;
    case 'pptx': parse = (await import('../core/pptx.js')).parsePptx; break;
    case 'ppt': parse = (await import('../core/ppt.js')).parsePpt; break;
    case 'odt': case 'ods': case 'odp': { const m = await import('../core/odf.js'); parse = (b, o) => m.parseOdf(b, { ...o, kind }); break; }
    case 'epub': parse = (await import('../core/epub.js')).parseEpub; break;
    default: throw fail('unsupported', '이 형식은 앱이 직접 글을 뽑을 수 없습니다');
  }
  try {
    return parse(bytes, { onProgress });
  } catch (e) {
    if (e && e.code) throw e;
    // 예상하지 못한 오류도 사용자에게는 알기 쉽게(자세한 것은 개발자 도구에)
    console.error('해석 오류', e);
    throw fail('broken', '문서를 읽지 못했습니다(손상되었거나 특이한 형식일 수 있습니다)');
  }
}

async function openPdf(bytes, password, extra = {}) {
  const task = pdfjs.getDocument({ ...PDF_OPTS, ...extra, data: bytes, password: password || undefined, verbosity: 0 });
  try {
    return { task, doc: await task.promise };
  } catch (e) {
    await task.destroy();
    if (e && e.name === 'PasswordException') throw fail(e.code === 2 ? 'password_wrong' : 'password', e.code === 2 ? '암호가 맞지 않습니다' : '열 때 암호가 필요한 PDF입니다');
    throw fail('broken', 'PDF를 열지 못했습니다(손상된 파일일 수 있습니다)');
  }
}

const handlers = {
  // 파일 살펴보기: 형식·쪽 수(PDF 는 정확, 한글·워드는 추정)
  async probe(m) {
    const bytes = await bytesOf(m);
    const kind = detectKind(bytes, m.name);
    if (kind === 'pdf') {
      try {
        const info = await inspectPdf(pdfjs, bytes, { opts: PDF_OPTS });
        return { kind, pages: info.pages, pageExact: true, title: info.title };
      } catch (e) {
        return { kind, error: e.code || 'broken', message: e.message };
      }
    }
    if (TEXTABLE.has(kind)) {
      try {
        const d = await parseOffice(kind, bytes);
        return { kind, pages: d.pages, pageExact: !!d.pageExact, sheetPages: !!d.sheetPages };
      } catch (e) {
        return { kind, error: e.code || 'broken', message: e.message };
      }
    }
    if (IMAGE_MIME[kind]) return { kind, pages: 1, pageExact: true };
    return { kind };
  },

  // 글 뽑기 → 문서 모델
  async extract(m) {
    const { id, kind, pages, password, alignPdf } = m;
    const bytes = await bytesOf(m);
    const isCancelled = () => cancelled.has(id);
    const onProgress = (v, note) => post({ id, type: 'progress', value: v, note });
    await loadDictionary(); // 줄 잇기 판단에 쓰는 국어사전(처음 한 번)
    if (kind === 'pdf') {
      // 글꼴 진짜 이름을 알아야 글자표가 잘못 적힌 글꼴(신문 조판 글꼴 등)을 바로잡을 수 있다
      const { task, doc } = await openPdf(bytes, password, { fontExtraProperties: true });
      try {
        // 글자가 거의 없는 쪽(스캔·그림)은 문자 인식으로 읽는다
        return await extractPdfDoc(pdfjs, doc, { pages: pages ? new Set(pages) : null, onProgress, isCancelled, ocr: { page: ocrPdfPage } });
      } finally {
        await task.destroy();
      }
    }
    if (IMAGE_MIME[kind]) {
      const data = await ocrImage(bytes, IMAGE_MIME[kind], (v) => onProgress(v, 'ocr'));
      return docFromOcrPage(data);
    }
    const model = await parseOffice(kind, bytes, (v) => onProgress(v * (alignPdf ? 0.5 : 1)));
    if (alignPdf) {
      // DRE.exe가 만든 PDF 로 쪽 번호를 정확히 맞춘다
      const { task, doc } = await openPdf(new Uint8Array(await alignPdf.arrayBuffer()));
      try {
        const texts = await pageTexts(doc, { isCancelled });
        alignPages(model, texts);
      } finally {
        await task.destroy();
      }
    }
    return model;
  },

  // PDF 만들기(쪽 뽑기·합치기). parts: [{ file|bytes, kind, password, pages, title }]
  async build(m) {
    const { id, outline, title } = m;
    const parts = [];
    for (const p of m.parts) {
      let bytes = await bytesOf(p);
      if (IMAGE_MIME[p.kind]) bytes = await imageToPdf(await loadPdfLib(), bytes, IMAGE_MIME[p.kind], { title: p.title });
      parts.push({ bytes, password: p.password || null, pages: p.pages || null, title: p.title });
    }
    const out = await buildPdf(pdfjs, loadPdfLib, parts, { outline, title, opts: PDF_OPTS, onProgress: (v) => post({ id, type: 'progress', value: v }) });
    return { blob: new Blob([out], { type: 'application/pdf' }) };
  },

  // 전자책(EPUB) → PDF 로 인쇄할 HTML 한 장(DRE 가 엣지로 인쇄한다)
  async epubhtml(m) {
    const { buildEpubHtml } = await import('../core/epubhtml.js');
    let r;
    try {
      r = await buildEpubHtml(await bytesOf(m), { onProgress: (v) => post({ id: m.id, type: 'progress', value: v }) });
    } catch (e) {
      if (e && e.code) throw e;
      console.error('전자책 묶기 오류', e);
      throw fail('broken', '전자책을 읽지 못했습니다(손상되었거나 특이한 형식일 수 있습니다)');
    }
    return { blob: new Blob(r.parts, { type: 'text/html' }), title: r.title };
  },

  // 엣지가 만든 PDF 의 글자 대응표 바로잡기(빈칸·한자) — 고칠 것이 없으면 받은 그대로
  async pdffix(m) {
    const { fixToUnicode } = await import('../core/pdftounicode.js');
    const bytes = await bytesOf(m);
    let r;
    try { r = fixToUnicode(bytes); } catch (e) { console.error('PDF 글자 대응표 바로잡기 오류', e); r = { bytes, fixed: 0 }; }
    return { blob: r.fixed ? new Blob([r.bytes], { type: 'application/pdf' }) : m.file, fixed: r.fixed };
  },

  // 그림 → PDF 한 쪽
  async image(m) {
    const out = await imageToPdf(await loadPdfLib(), await bytesOf(m), IMAGE_MIME[m.kind] || m.mime, { title: m.title });
    return { blob: new Blob([out], { type: 'application/pdf' }) };
  },
};

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'cancel') { cancelled.add(m.id); return; }
  const h = handlers[m.type];
  if (!h) { post({ id: m.id, type: 'error', code: 'unknown', message: '모르는 작업' }); return; }
  try {
    const result = await h(m);
    post({ id: m.id, type: 'done', result });
  } catch (err) {
    post({ id: m.id, type: 'error', code: (err && err.code) || 'failed', message: (err && err.message) || String(err), index: err && err.index });
  } finally {
    cancelled.delete(m.id);
  }
};
