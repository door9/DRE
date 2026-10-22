// 그림 파일에 해상도(dpi) 적기 — 한글·워드에 넣을 때 원래 종이 크기로 들어가게.
// 브라우저가 만든 PNG 에는 해상도 정보가 없어 한글·워드가 96dpi 로 보고 크게 넣는다(300dpi 그림이면 3배).
// JPG 는 '단위 없음 1:1' 로 적힌다. 그래서 PNG 는 IHDR 바로 뒤에 pHYs 덩어리(1미터당 화소 수)를 넣고,
// JPG 는 JFIF 머리(APP0)의 단위를 인치로·밀도를 dpi 로 고쳐 쓴다(머리가 없으면 새로 넣는다). 순수 계산이라 Node 에서도 돈다.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8, from, to) {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (u8) => u8.length > 8 && PNG_SIG.every((b, i) => u8[i] === b);
const isJpeg = (u8) => u8.length > 3 && u8[0] === 0xff && u8[1] === 0xd8;
// JFIF 머리가 SOI 바로 뒤에 있는가(FF E0 · 길이 16 이상 · 'JFIF\0')
const hasJfif = (u8) => u8.length > 20 && u8[2] === 0xff && u8[3] === 0xe0 && ((u8[4] << 8) | u8[5]) >= 16 &&
  u8[6] === 0x4a && u8[7] === 0x46 && u8[8] === 0x49 && u8[9] === 0x46 && u8[10] === 0;

// PNG 덩어리 훑기: [{ type, at(덩어리 처음), end(다음 덩어리 처음), data(자료 처음) }] — IDAT 를 만나면 멈춘다
function pngChunks(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = [];
  for (let p = 8; p + 12 <= u8.length;) {
    const len = dv.getUint32(p);
    const end = p + 12 + len;
    if (end > u8.length) break;
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    out.push({ type, at: p, end, data: p + 8 });
    if (type === 'IDAT' || type === 'IEND') break;
    p = end;
  }
  return out;
}

export function setPngDpi(u8, dpi) {
  if (!isPng(u8)) return u8;
  const ppm = Math.max(1, Math.round(dpi / 0.0254));
  const chunk = new Uint8Array(21); // 길이(4) + 'pHYs'(4) + 자료(9) + CRC(4)
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4);
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // 단위: 미터
  dv.setUint32(17, crc32(chunk, 4, 17));
  const chunks = pngChunks(u8);
  const old = chunks.find((c) => c.type === 'pHYs');
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) return u8;
  // 이미 있으면 그 자리를 바꾸고, 없으면 IHDR 바로 뒤에(IDAT 앞이어야 한다)
  const from = old ? old.at : ihdr.end, to = old ? old.end : ihdr.end;
  const out = new Uint8Array(u8.length - (to - from) + chunk.length);
  out.set(u8.subarray(0, from));
  out.set(chunk, from);
  out.set(u8.subarray(to), from + chunk.length);
  return out;
}

export function setJpegDpi(u8, dpi) {
  if (!isJpeg(u8)) return u8;
  const d = Math.max(1, Math.min(65535, Math.round(dpi)));
  if (hasJfif(u8)) {
    const out = u8.slice();
    out[13] = 1; // 단위: 인치
    out[14] = d >> 8; out[15] = d & 0xff;
    out[16] = d >> 8; out[17] = d & 0xff;
    return out;
  }
  // JFIF 머리가 없으면 SOI 바로 뒤에 새로 넣는다(판 1.1, 작은 그림 없음)
  const app0 = new Uint8Array([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, d >> 8, d & 0xff, d >> 8, d & 0xff, 0, 0]);
  const out = new Uint8Array(u8.length + app0.length);
  out.set(u8.subarray(0, 2));
  out.set(app0, 2);
  out.set(u8.subarray(2), 2 + app0.length);
  return out;
}

// PNG·JPG 를 가려 해상도를 적는다(다른 형식은 그대로)
export function setImageDpi(u8, dpi) {
  if (isPng(u8)) return setPngDpi(u8, dpi);
  if (isJpeg(u8)) return setJpegDpi(u8, dpi);
  return u8;
}

// 적힌 해상도 읽기(시험·확인용). 없으면 null
export function readImageDpi(u8) {
  if (isPng(u8)) {
    const c = pngChunks(u8).find((x) => x.type === 'pHYs');
    if (!c || u8[c.data + 8] !== 1) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return { x: dv.getUint32(c.data) * 0.0254, y: dv.getUint32(c.data + 4) * 0.0254 };
  }
  if (isJpeg(u8) && hasJfif(u8)) {
    if (u8[13] !== 1) return null;
    return { x: (u8[14] << 8) | u8[15], y: (u8[16] << 8) | u8[17] };
  }
  return null;
}
