// PDF 만들기 — 쪽 뽑기·합치기(pdf.js 의 extractPages: 암호 걸린 PDF도 풀어서 담고 원본 책갈피도 옮겨 준다),
// 문서별 책갈피 묶기(pdf-lib), 그림 → PDF. 작업 스레드에서 돈다. pdf.js·pdf-lib 모듈은 부르는 쪽이 넘긴다.

export class PdfOpError extends Error {
  constructor(code, msg, index) { super(msg); this.code = code; this.index = index; }
}

// 빈 쪽 하나짜리 PDF(합치기의 바탕용)
export function blankPdf() {
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>',
  ];
  let s = '%PDF-1.7\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  s += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(s);
}

// 쪽 번호 목록(1부터) → pdf.js 범위([[처음,끝], …], 0부터)
export function toRanges(list) {
  const r = [];
  for (let i = 0; i < list.length;) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    r.push([list[i] - 1, list[j] - 1]);
    i = j + 1;
  }
  return r;
}

// PDF 를 열어 보기(쪽 수·암호 여부). 실패하면 PdfOpError
export async function inspectPdf(pdfjs, bytes, { password = null, opts = {} } = {}) {
  const task = pdfjs.getDocument({ ...opts, data: bytes.slice(), password: password || undefined, verbosity: 0 });
  try {
    const doc = await task.promise;
    let title = '';
    try { const meta = await doc.getMetadata(); title = (meta && meta.info && meta.info.Title) || ''; } catch { /* 없음 */ }
    return { pages: doc.numPages, title };
  } catch (e) {
    if (e && e.name === 'PasswordException') {
      throw new PdfOpError(e.code === 2 ? 'password_wrong' : 'password', e.code === 2 ? '암호가 맞지 않습니다' : '열 때 암호가 필요한 PDF입니다');
    }
    throw new PdfOpError('broken', 'PDF를 열지 못했습니다(손상된 파일일 수 있습니다)');
  } finally {
    await task.destroy();
  }
}

// parts: [{ bytes, password?, pages?: [1부터…] | null, title }]
// 반환: Uint8Array. outline: 문서마다 맨 위 책갈피를 만들고 원래 책갈피는 그 아래로
export async function buildPdf(pdfjs, loadPdfLib, parts, { outline = false, title = '', opts = {}, onProgress } = {}) {
  if (!parts.length) throw new PdfOpError('empty', '담을 문서가 없습니다');
  // 1) 하나씩 미리 열어 본다(망가진 파일이 섞이면 어느 것인지 알려 주려고)
  const counts = [];
  const totals = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    try {
      const info = await inspectPdf(pdfjs, p.bytes, { password: p.password, opts });
      totals.push(info.pages);
      counts.push(p.pages ? p.pages.filter((n) => n >= 1 && n <= info.pages).length : info.pages);
      if (p.pages && !counts[i]) throw new PdfOpError('range', `고른 쪽이 문서에 없습니다(전체 ${info.pages}쪽)`);
    } catch (e) {
      e.index = i;
      throw e;
    }
    if (onProgress) onProgress(((i + 1) / parts.length) * 0.3);
  }
  // 2) 빈 바탕 문서를 열고 모든 조각을 바이트로 넘긴다. 바탕을 원본 PDF로 하면 그 문서의 암호 설정이
  //    결과에 그대로 남는다(실측) — DRE 가 만드는 PDF 는 늘 암호 없이(사용자가 암호를 넣어 연 것이므로)
  const task = pdfjs.getDocument({ ...opts, data: blankPdf(), verbosity: 0 });
  let out;
  try {
    const base = await task.promise;
    const infos = parts.map((p, i) => {
      const info = { document: p.bytes.slice() };
      if (p.password) info.password = p.password;
      // 고른 쪽 중 실제로 있는 쪽만(한글 문서는 어림 쪽 수로 골랐을 수 있다)
      if (p.pages) info.includePages = toRanges(p.pages.filter((n) => n >= 1 && n <= totals[i]));
      return info;
    });
    out = await base.extractPages(infos);
  } finally {
    await task.destroy();
  }
  if (!out || !out.length) throw new PdfOpError('failed', 'PDF를 만들지 못했습니다');
  if (onProgress) onProgress(0.75);
  // 3) 문서별 책갈피·제목
  if ((outline && parts.length > 1) || title) {
    try {
      const PDFLib = await loadPdfLib();
      const groups = [];
      let start = 0;
      parts.forEach((p, i) => { groups.push({ title: p.title || `문서 ${i + 1}`, start, count: counts[i] }); start += counts[i]; });
      out = await finishPdf(PDFLib, out, { groups: outline && parts.length > 1 ? groups : null, title });
    } catch (e) {
      // 책갈피를 못 달아도 합친 PDF 는 그대로 준다
      console.warn('책갈피 달기 실패', e);
    }
  }
  if (onProgress) onProgress(1);
  return out;
}

// pdf-lib 으로 책갈피(문서별 묶음)와 제목 넣기
async function finishPdf(PDFLib, bytes, { groups, title }) {
  const { PDFDocument, PDFName, PDFHexString, PDFArray, PDFDict, PDFNumber, PDFRef } = PDFLib;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  if (groups && groups.length) {
    const pageRefs = doc.getPages().map((p) => p.ref);
    const refIndex = new Map(pageRefs.map((r, i) => [r.toString(), i]));
    const cat = doc.catalog;
    // 이미 있는 맨 위 책갈피들
    const oldTop = [];
    const outlines = cat.lookup(PDFName.of('Outlines'));
    if (outlines instanceof PDFDict) {
      let cur = outlines.get(PDFName.of('First'));
      const seen = new Set();
      while (cur instanceof PDFRef && !seen.has(cur.toString()) && oldTop.length < 20000) {
        seen.add(cur.toString());
        const d = ctx.lookup(cur);
        if (!(d instanceof PDFDict)) break;
        oldTop.push({ ref: cur, dict: d });
        cur = d.get(PDFName.of('Next'));
      }
    }
    const pageOf = (d) => {
      let dest = d.get(PDFName.of('Dest'));
      if (!dest) { const a = d.lookup(PDFName.of('A')); if (a instanceof PDFDict) dest = a.get(PDFName.of('D')); }
      if (dest instanceof PDFRef) dest = ctx.lookup(dest);
      if (dest instanceof PDFArray && dest.size() > 0) {
        const p = dest.get(0);
        if (p instanceof PDFRef) { const k = refIndex.get(p.toString()); return k == null ? null : k; }
      }
      return null;
    };
    const rootRef = ctx.nextRef();
    const items = groups.filter((g) => g.count > 0).map((g) => ({ g, ref: ctx.nextRef(), kids: [] }));
    let last = 0;
    for (const o of oldTop) {
      const pg = pageOf(o.dict);
      let gi = last;
      if (pg != null) { const k = items.findIndex((it) => pg >= it.g.start && pg < it.g.start + it.g.count); if (k >= 0) gi = k; }
      items[gi].kids.push(o);
      last = gi;
    }
    items.forEach((it, i) => {
      const d = ctx.obj({ Title: PDFHexString.fromText(it.g.title), Parent: rootRef, Dest: [pageRefs[it.g.start], 'Fit'] });
      if (i > 0) d.set(PDFName.of('Prev'), items[i - 1].ref);
      if (i < items.length - 1) d.set(PDFName.of('Next'), items[i + 1].ref);
      if (it.kids.length) {
        d.set(PDFName.of('First'), it.kids[0].ref);
        d.set(PDFName.of('Last'), it.kids[it.kids.length - 1].ref);
        d.set(PDFName.of('Count'), PDFNumber.of(-it.kids.length)); // 접힌 채로
        it.kids.forEach((k, j) => {
          k.dict.set(PDFName.of('Parent'), it.ref);
          if (j > 0) k.dict.set(PDFName.of('Prev'), it.kids[j - 1].ref); else k.dict.delete(PDFName.of('Prev'));
          if (j < it.kids.length - 1) k.dict.set(PDFName.of('Next'), it.kids[j + 1].ref); else k.dict.delete(PDFName.of('Next'));
        });
      }
      ctx.assign(it.ref, d);
    });
    if (items.length) {
      ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: items[0].ref, Last: items[items.length - 1].ref, Count: items.length }));
      cat.set(PDFName.of('Outlines'), rootRef);
      cat.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
    }
  }
  if (title) doc.setTitle(title);
  doc.setProducer('DRE');
  return doc.save({ useObjectStreams: true });
}

// ─── 그림 → PDF(A4 한 쪽에 맞춰 가운데) ───
function jpegOrientation(u8) {
  // EXIF 방향(1이면 그대로). 사진을 돌려 찍었으면 다시 그려야 한다
  if (u8[0] !== 0xff || u8[1] !== 0xd8) return 1;
  let o = 2;
  while (o + 4 < u8.length) {
    if (u8[o] !== 0xff) return 1;
    const marker = u8[o + 1];
    const len = (u8[o + 2] << 8) | u8[o + 3];
    if (marker === 0xe1 && u8[o + 4] === 0x45 && u8[o + 5] === 0x78) {
      const t = o + 10;
      const le = u8[t] === 0x49;
      const r16 = (p) => (le ? u8[p] | (u8[p + 1] << 8) : (u8[p] << 8) | u8[p + 1]);
      const r32 = (p) => (le ? (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0 : ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0);
      const ifd = t + r32(t + 4);
      const n = r16(ifd);
      for (let k = 0; k < n && ifd + 2 + k * 12 + 12 <= u8.length; k++) {
        const e = ifd + 2 + k * 12;
        if (r16(e) === 0x0112) return r16(e + 8) || 1;
      }
      return 1;
    }
    if (marker === 0xda) return 1;
    o += 2 + len;
  }
  return 1;
}

async function redraw(bytes, mime) {
  // 브라우저가 그림을 풀어(EXIF 방향 반영) PNG/JPEG 로 다시 만든다(작업 스레드의 OffscreenCanvas)
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }), { imageOrientation: 'from-image' });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, bmp.width, bmp.height);
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const jpg = mime === 'image/jpeg';
  const blob = await canvas.convertToBlob({ type: jpg ? 'image/jpeg' : 'image/png', quality: 0.92 });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), jpg };
}

export async function imageToPdf(PDFLib, bytes, mime, { title = '' } = {}) {
  const doc = await PDFLib.PDFDocument.create();
  let img;
  if (mime === 'image/jpeg' && jpegOrientation(bytes) === 1) img = await doc.embedJpg(bytes);
  else if (mime === 'image/png') img = await doc.embedPng(bytes);
  else {
    const r = await redraw(bytes, mime);
    img = r.jpg ? await doc.embedJpg(r.bytes) : await doc.embedPng(r.bytes);
  }
  const landscape = img.width > img.height;
  const W = landscape ? 841.89 : 595.28, H = landscape ? 595.28 : 841.89;
  const s = Math.min(W / img.width, H / img.height);
  const w = img.width * s, h = img.height * s;
  const page = doc.addPage([W, H]);
  page.drawImage(img, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
  if (title) doc.setTitle(title);
  doc.setProducer('DRE');
  return doc.save();
}
