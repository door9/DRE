// PDF 글 뽑기 — 열린 pdf.js 문서에서 쪽마다 글자·선을 받아 배치 분석(pdflayout.js)으로 문서 모델을 만든다.
// 앱(작업 스레드)과 시험(Node)이 함께 쓴다. pdf.js 모듈은 부르는 쪽이 넘겨준다.
import { pageFromPdfjs, analyzePage, assemble } from './pdflayout.js';
import { resolveSoftBreaks } from './joiner.js';

const EMPTY_PAGE = () => ({ seq: [], size: 10, w: 1, h: 1, rotated: [], spaces: [] });

// 글자가 이보다 적은 쪽 가운데 스캔·그림으로 된 쪽(wantOcr)은 문자 인식으로 읽는다
export const OCR_MIN_CHARS = 20;

// pages: 뽑을 쪽 번호 집합(1부터, 없으면 전체). onProgress(0~1). isCancelled() 가 참이면 멈춤.
// ocr: 문자 인식기(있으면 글자가 거의 없는 쪽을 읽는다) — { page(pdfPage, { onProgress }) → 쪽 자료(ocr.js pageFromOcr) }
export async function extractPdfDoc(pdfjs, doc, { pages = null, onProgress, isCancelled, ocr = null } = {}) {
  const analyzed = [];
  let textPages = 0, ocrPages = 0, ocrError = null;
  for (let i = 1; i <= doc.numPages; i++) {
    if (isCancelled && isCancelled()) throw Object.assign(new Error('취소했습니다'), { code: 'cancelled' });
    if (pages && !pages.has(i)) { analyzed.push(EMPTY_PAGE()); continue; }
    const page = await doc.getPage(i);
    try {
      const viewport = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      let chars = 0;
      for (const it of tc.items) if (it.str) chars += it.str.replace(/\s+/g, '').length;
      let data = null;
      // 문자 인식할 거리가 있는 쪽만(빈 쪽·제목 몇 글자뿐인 표지는 건너뛴다)
      let inked = true;
      if (ocr && !ocrError && chars < OCR_MIN_CHARS) {
        try { inked = wantOcr(await page.getOperatorList(), pdfjs.OPS, chars, viewport.width * viewport.height); } catch { inked = true; }
      }
      if (ocr && !ocrError && chars < OCR_MIN_CHARS && inked) {
        try {
          if (onProgress) onProgress(((i - 1) / doc.numPages) * 0.9, 'ocr');
          data = await ocr.page(page, { onProgress: (v) => { if (onProgress) onProgress(((i - 1 + v) / doc.numPages) * 0.9, 'ocr'); } });
        } catch (e) {
          if (e && e.code === 'cancelled') throw e;
          ocrError = e; // 인식기를 못 쓰면 다음 쪽부터는 시도하지 않는다
          data = null;
        }
        if (data && data.items.length) { ocrPages++; textPages++; }
      }
      if (!data || (!data.items.length && chars > 0)) {
        if (chars > 0) textPages++;
        // 표 선을 찾으려고 그리기 명령도 받는다(글이 있는 쪽만 — 그림뿐인 쪽은 건너뛴다)
        let ops = null;
        if (chars > 0) {
          try { ops = await page.getOperatorList(); } catch { ops = null; }
        }
        data = pageFromPdfjs(tc, ops, viewport, pdfjs.OPS, fontNamesOf(page, tc, ops));
      }
      const a = analyzePage(data);
      a.spaces = data.spaces;
      analyzed.push(a);
    } finally {
      page.cleanup();
    }
    if (onProgress) onProgress(i / doc.numPages * 0.9);
  }
  const { blocks } = assemble(analyzed);
  const out = { format: 'pdf', pages: doc.numPages, pageExact: true, blocks, notes: [], warnings: [] };
  resolveSoftBreaks(out);
  const wanted = pages ? pages.size : doc.numPages;
  if (ocrPages) out.warnings.push(`${ocrPages === wanted ? '모든 쪽' : ocrPages + '쪽'}의 글자가 그림으로 되어 있어 문자 인식으로 읽었습니다. 틀린 글자가 있을 수 있습니다.`);
  if (ocrError) out.warnings.push(`문자 인식을 하지 못했습니다(${ocrError.message || ocrError}).`);
  if (wanted && textPages === 0) out.warnings.push(ocr && !ocrError ? '글자를 찾지 못했습니다(그림에 글이 없거나 너무 흐립니다).' : '글자가 없는 PDF입니다(스캔한 그림으로 된 문서일 수 있습니다). 글자를 뽑으려면 문자 인식(OCR)이 필요합니다.');
  else if (wanted && textPages < wanted) out.warnings.push(`${wanted - textPages}쪽은 글자 없이 그림만 있습니다.`);
  if (onProgress) onProgress(1);
  return out;
}

// 문자 인식할 거리가 있나
// - 뽑힌 글자가 하나도 없는 쪽: 그림·도형·글자 그리기가 하나라도 있으면(스캔, 글자표 없는 글꼴, 선으로 그린 글자)
// - 글자가 조금 있는 쪽(20자 미만): 쪽의 40% 이상을 덮는 큰 그림(스캔한 쪽 + 찍어 넣은 쪽 번호 등)이나 도형 300개 이상(선으로 그린 글자)이 있을 때만.
//   제목 몇 글자 + 로고뿐인 표지는 원래 글자를 그대로 쓴다(인식 글이 원래 글을 덮지 않게)
function wantOcr(ops, OPS, chars, pageArea) {
  const IMG = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintInlineImageXObjectGroup,
    OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat, OPS.paintImageMaskXObjectGroup].filter((x) => x != null));
  const TEXT = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText].filter((x) => x != null));
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let ink = false, paths = 0, bigImage = false;
  const { fnArray, argsArray } = ops;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args && args[0] && args[0].length === 6) ctm = mul(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (IMG.has(fn)) {
      ink = true;
      // 그림은 단위 정사각형을 현재 변환으로 늘려 그린다 → 넓이 = |행렬식|
      if (Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) >= pageArea * 0.4) bigImage = true;
    } else if (fn === OPS.constructPath) { ink = true; paths++; }
    else if (fn === OPS.shadingFill || fn === OPS.paintSolidColorImageMask) ink = true;
    else if (TEXT.has(fn)) { if (!chars) ink = true; }
  }
  return chars ? bigImage || paths >= 300 : ink;
}

// 그림 한 장(문자 인식으로 만든 쪽 자료) → 문서 모델
export function docFromOcrPage(data) {
  const a = analyzePage(data);
  a.spaces = data.spaces;
  const { blocks } = assemble([a]);
  const out = { format: 'image', pages: 1, pageExact: true, blocks, notes: [], warnings: [] };
  resolveSoftBreaks(out);
  out.warnings.push(data.items.length ? '그림의 글을 문자 인식으로 읽었습니다. 틀린 글자가 있을 수 있습니다.' : '그림에서 글자를 찾지 못했습니다.');
  return out;
}

// 글꼴 진짜 이름(문서를 열 때 fontExtraProperties: true 여야 알 수 있다) — 글꼴별 글자 바로잡기에 쓴다
function fontNamesOf(page, tc, ops) {
  const out = {};
  if (!ops) return out;
  for (const k of Object.keys(tc.styles || {})) {
    try {
      if (!page.commonObjs.has(k)) continue;
      const f = page.commonObjs.get(k);
      if (f && f.name) out[k] = String(f.name);
    } catch { /* 없으면 그만 */ }
  }
  return out;
}

// 쪽마다 글(공백 없앤 것) — 한글·워드 문서의 문단을 실제 PDF 쪽에 맞출 때 쓴다(align.js)
export async function pageTexts(doc, { isCancelled } = {}) {
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    if (isCancelled && isCancelled()) throw Object.assign(new Error('취소했습니다'), { code: 'cancelled' });
    const page = await doc.getPage(i);
    try {
      const tc = await page.getTextContent();
      out.push(tc.items.map((it) => it.str || '').join(''));
    } finally {
      page.cleanup();
    }
  }
  return out;
}
