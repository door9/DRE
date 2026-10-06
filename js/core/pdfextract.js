// PDF 글 뽑기 — 열린 pdf.js 문서에서 쪽마다 글자·선을 받아 배치 분석(pdflayout.js)으로 문서 모델을 만든다.
// 앱(작업 스레드)과 시험(Node)이 함께 쓴다. pdf.js 모듈은 부르는 쪽이 넘겨준다.
import { pageFromPdfjs, analyzePage, assemble } from './pdflayout.js';
import { resolveSoftBreaks } from './joiner.js';

const EMPTY_PAGE = () => ({ seq: [], size: 10, w: 1, h: 1, rotated: [], spaces: [] });

// pages: 뽑을 쪽 번호 집합(1부터, 없으면 전체). onProgress(0~1). isCancelled() 가 참이면 멈춤.
export async function extractPdfDoc(pdfjs, doc, { pages = null, onProgress, isCancelled } = {}) {
  const analyzed = [];
  let textPages = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    if (isCancelled && isCancelled()) throw Object.assign(new Error('취소했습니다'), { code: 'cancelled' });
    if (pages && !pages.has(i)) { analyzed.push(EMPTY_PAGE()); continue; }
    const page = await doc.getPage(i);
    try {
      const viewport = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const hasText = tc.items.some((it) => it.str && it.str.trim());
      if (hasText) textPages++;
      // 표 선을 찾으려고 그리기 명령도 받는다(글이 있는 쪽만 — 그림뿐인 쪽은 건너뛴다)
      let ops = null;
      if (hasText) {
        try { ops = await page.getOperatorList(); } catch { ops = null; }
      }
      const data = pageFromPdfjs(tc, ops, viewport, pdfjs.OPS);
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
  if (wanted && textPages === 0) out.warnings.push('글자가 없는 PDF입니다(스캔한 그림으로 된 문서일 수 있습니다). 글자를 뽑으려면 문자 인식(OCR)이 필요합니다.');
  else if (wanted && textPages < wanted) out.warnings.push(`${wanted - textPages}쪽은 글자 없이 그림만 있습니다.`);
  if (onProgress) onProgress(1);
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
