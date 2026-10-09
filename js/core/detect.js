// 파일 형식 알아보기 — 확장자가 아니라 파일 속 첫머리로 가린다(이름이 틀려도 맞게)
import { unzipSync } from '../../vendor/fflate.mjs';
import { isCfb, readCfb } from './cfb.js';

const startsWith = (u8, arr, at = 0) => arr.every((b, i) => u8[at + i] === b);
const ascii = (u8, from, len) => String.fromCharCode(...u8.subarray(from, from + len));

export const IMAGE_MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };

// 돌려주는 것: 'pdf' | 'hwp' | 'hwp3' | 'hwpx' | 'doc' | 'docx' | 'rtf' | 'odt' | 'xls' | 'xlsx' | 'ods' | 'ppt' | 'pptx' | 'odp' |
//              'jpg' | 'png' | 'gif' | 'bmp' | 'webp' | 'unknown'
export function detectKind(u8, name = '') {
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
  if (!u8 || u8.length < 4) return 'unknown';
  // PDF: 앞 1KB 안에 %PDF
  const head = ascii(u8, 0, Math.min(1024, u8.length));
  if (head.indexOf('%PDF-') >= 0) return 'pdf';
  if (startsWith(u8, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(u8, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (head.startsWith('GIF8')) return 'gif';
  if (head.startsWith('BM') && (ext === 'bmp' || u8.length > 54)) return ext === 'bmp' || u8[14] === 40 || u8[14] === 108 || u8[14] === 124 ? 'bmp' : 'unknown';
  if (head.startsWith('RIFF') && ascii(u8, 8, 4) === 'WEBP') return 'webp';
  if (head.startsWith('{\\rtf')) return 'rtf';
  if (head.startsWith('HWP Document File V')) return 'hwp3';
  if (isCfb(u8)) {
    try {
      const c = readCfb(u8);
      if (c.has('FileHeader')) return 'hwp';
      if (c.has('WordDocument')) return 'doc';
      if (c.has('Workbook') || c.has('Book')) return 'xls';
      if (c.has('PowerPoint Document') || c.has('PP40')) return 'ppt'; // PP40: 파워포인트 95(해석기가 '옛 판'으로 알린다)
      // 암호 걸린 새 오피스 문서(EncryptedPackage)는 확장자로
      if (c.has('EncryptedPackage')) return ext === 'xlsx' ? 'xlsx' : ext === 'pptx' ? 'pptx' : 'docx';
    } catch { /* 아래로 */ }
    return ext === 'hwp' ? 'hwp' : ext === 'doc' ? 'doc' : 'unknown';
  }
  if (startsWith(u8, [0x50, 0x4b, 0x03, 0x04])) {
    const names = [];
    try {
      unzipSync(u8, { filter: (f) => { names.push(f.name); return f.name === 'mimetype'; } });
    } catch { /* 이름만 모았으면 됨 */ }
    const has = (n) => names.includes(n);
    if (has('Contents/content.hpf') || names.some((n) => /^Contents\/section\d+\.xml$/i.test(n))) return 'hwpx';
    if (has('word/document.xml') || names.some((n) => /^word\/document\d*\.xml$/.test(n))) return 'docx';
    if (has('xl/workbook.xml')) return 'xlsx';
    if (has('ppt/presentation.xml')) return 'pptx';
    if (has('content.xml')) return ext === 'ods' ? 'ods' : ext === 'odp' ? 'odp' : 'odt';
    return { hwpx: 'hwpx', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' }[ext] || 'unknown';
  }
  // 이름은 엑셀(.xls)인데 속은 웹 페이지 표나 엑셀 2003 XML 인 것(공공기관·거래소 내려받기에 흔하다) — 엑셀 문서로 다룬다
  if (ext === 'xls' && (/<(?:!doctype\s+html|html|table|head|body)\b/i.test(head) || /urn:schemas-microsoft-com:office:spreadsheet/.test(head))) return 'xls';
  return 'unknown';
}

// 형식 묶음
export const OFFICE = new Set(['hwp', 'hwp3', 'hwpx', 'doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp']);
// 앱이 직접 글을 뽑을 수 있는 것(그림은 문자 인식으로 따로). 옛 한글(hwp3)·배포용 한글은 DRE.exe 를 거친다
export const TEXTABLE = new Set(['pdf', 'hwp', 'hwpx', 'doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp']);
export const SHEETS = new Set(['xls', 'xlsx', 'ods']);   // 시트 하나 = 한 쪽(어림)
export const SLIDES = new Set(['ppt', 'pptx', 'odp']);   // 슬라이드 하나 = 한 쪽(정확)
export const IMAGES = new Set(['jpg', 'png', 'gif', 'bmp', 'webp']);

// DRE.exe(한글·워드…)에게 보낼 때 쓸 확장자
export function engineExt(kind) {
  return { hwp3: 'hwp' }[kind] || kind;
}

// 화면에 보일 형식 이름
export function kindLabel(kind) {
  return {
    pdf: 'PDF', hwp: '한글', hwp3: '한글', hwpx: '한글', doc: '워드', docx: '워드', rtf: 'RTF', odt: 'ODT',
    xls: '엑셀', xlsx: '엑셀', ods: 'ODS', ppt: 'PPT', pptx: 'PPT', odp: 'ODP',
    jpg: '그림', png: '그림', gif: '그림', bmp: '그림', webp: '그림', unknown: '?',
  }[kind] || '?';
}
