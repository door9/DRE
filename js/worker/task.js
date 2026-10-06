// DRE 작업 일꾼 — 글 뽑기·PDF 만들기처럼 무거운 일을 화면과 다른 스레드에서 한다.
// 화면 쪽(js/jobs.js)과 메시지로 주고받는다: { id, type, ... } → { id, type: 'progress'|'done'|'error', ... }
// 파일은 Blob 그대로 받아 여기서 읽는다(화면 쪽 메모리에 두 번 올리지 않게).
// 일꾼이 멈추거나 메모리를 너무 쓰면 화면 쪽이 통째로 끝내고 새로 만든다(앱 전체가 멈추지 않게).
import * as pdfjs from '../../vendor/pdfjs/pdf.min.mjs';
import { extractPdfDoc, pageTexts } from '../core/pdfextract.js';
import { buildPdf, imageToPdf, inspectPdf } from '../core/pdfops.js';
import { alignPages } from '../core/align.js';
import { detectKind, IMAGE_MIME } from '../core/detect.js';

const BASE = new URL('../../vendor/pdfjs/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';
const PDF_OPTS = {
  cMapUrl: BASE + 'cmaps/', cMapPacked: true, standardFontDataUrl: BASE + 'standard_fonts/', wasmUrl: BASE + 'wasm/',
  iccUrl: BASE + 'iccs/', disableFontFace: true, isEvalSupported: false, useSystemFonts: false,
  // 작업 스레드에는 화면(document)이 없다. 이 값을 직접 주지 않으면 pdf.js 가 document.baseURI 를 찾다 멈춘다
  useWorkerFetch: true,
};
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

async function openPdf(bytes, password) {
  const task = pdfjs.getDocument({ ...PDF_OPTS, data: bytes, password: password || undefined, verbosity: 0 });
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
    if (kind === 'hwp' || kind === 'hwpx' || kind === 'docx' || kind === 'doc') {
      try {
        const d = await parseOffice(kind, bytes);
        return { kind, pages: d.pages, pageExact: false };
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
    const onProgress = (v) => post({ id, type: 'progress', value: v });
    if (kind === 'pdf') {
      const { task, doc } = await openPdf(bytes, password);
      try {
        return await extractPdfDoc(pdfjs, doc, { pages: pages ? new Set(pages) : null, onProgress, isCancelled });
      } finally {
        await task.destroy();
      }
    }
    const model = await parseOffice(kind, bytes, (v) => onProgress(v * (alignPdf ? 0.5 : 1)));
    if (alignPdf) {
      // 엔진이 만든 PDF 로 쪽 번호를 정확히 맞춘다
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
