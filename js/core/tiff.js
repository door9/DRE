// TIFF 만들기 — 브라우저가 못 만드는 형식이라 화소(RGBA)를 받아 직접 쓴다. 순수 계산이라 작업 스레드·Node 에서 돈다.
// 꼴: 리틀 엔디언, RGB 8비트, LZW 압축, 해상도(인치당 화소). 그림 프로그램·한글·워드가 두루 읽는 가장 흔한 꼴로 한다
// (예측기·Deflate 압축은 작아지지만 옛 프로그램이 못 읽을 수 있어 쓰지 않는다).
// 프로그램 이름 표(Software)는 일부러 적지 않는다 — 결과 파일에 도구 흔적을 남기지 않는다.

const CLEAR = 256, EOI = 257, FIRST = 258, FULL = 4094;
const HASH_BITS = 14, HASH_SIZE = 1 << HASH_BITS, HASH_MASK = HASH_SIZE - 1; // 낱말 4천 개에 칸 1만 6천 개(4분의 1만 참)
const STRIP_BYTES = 256 * 1024; // 행 묶음 하나의 압축 전 크기(묶음마다 낱말표를 새로 시작한다)

// LZW 한 묶음. 코드 길이를 늘리는 시점은 TIFF 6.0·libtiff 인코더와 같다:
// 9비트로 시작해 다음 코드가 511·1023·2047 을 넘으면 1비트 늘리고, 4094 에 이르면 표를 비운다.
// 읽는 쪽 표가 한 칸 늦으므로 마지막 코드를 낸 뒤에도 표에 넣은 셈 치고 길이를 판단한다.
function lzw(src, n, keys, vals) {
  // 입력 1바이트마다 코드 하나(12비트)가 최악 + 표 비우기 코드 + 시작·끝 코드
  const out = new Uint8Array(Math.ceil((n + n / 3000 + 4) * 1.5) + 2);
  let p = 0, acc = 0, bits = 0, nbits = 9, maxcode = 511, next = FIRST;
  const put = (code) => {
    acc = (acc << nbits) | code;
    bits += nbits;
    while (bits >= 8) {
      bits -= 8;
      out[p++] = (acc >>> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  };
  keys.fill(-1);
  put(CLEAR);
  let ent = src[0];
  for (let i = 1; i < n; i++) {
    const c = src[i];
    const key = (ent << 8) | c;
    let h = Math.imul(key, 0x9e3779b1) >>> (32 - HASH_BITS);
    let found = -1;
    for (;;) {
      const k = keys[h];
      if (k === key) { found = vals[h]; break; }
      if (k === -1) break;
      h = (h + 1) & HASH_MASK;
    }
    if (found >= 0) { ent = found; continue; }
    put(ent);
    keys[h] = key;
    vals[h] = next++;
    ent = c;
    if (next === FULL) {
      put(CLEAR);
      keys.fill(-1);
      next = FIRST; nbits = 9; maxcode = 511;
    } else if (next > maxcode) {
      nbits++;
      maxcode = (1 << nbits) - 1;
    }
  }
  put(ent);
  next++;
  if (next === FULL) {
    put(CLEAR);
    nbits = 9;
  } else if (next > maxcode) {
    nbits++;
  }
  put(EOI);
  if (bits > 0) out[p++] = (acc << (8 - bits)) & 0xff;
  return out.slice(0, p);
}

// rgba: 화소 RGBA(가로×세로×4 바이트, 알파는 버린다). dpi: 적을 해상도. 돌려주는 것: TIFF 파일 바이트(Uint8Array)
export function encodeTiff(rgba, width, height, dpi) {
  const rowBytes = width * 3;
  const rowsPerStrip = Math.max(1, Math.min(height, Math.floor(STRIP_BYTES / rowBytes)));
  const count = Math.ceil(height / rowsPerStrip);
  const raw = new Uint8Array(rowsPerStrip * rowBytes);
  const keys = new Int32Array(HASH_SIZE), vals = new Uint16Array(HASH_SIZE);
  const strips = [];
  let s = 0, dataBytes = 0;
  for (let k = 0; k < count; k++) {
    const rows = Math.min(rowsPerStrip, height - k * rowsPerStrip);
    let d = 0;
    for (let e = s + rows * width * 4; s < e; s += 4) {
      raw[d++] = rgba[s];
      raw[d++] = rgba[s + 1];
      raw[d++] = rgba[s + 2];
    }
    const z = lzw(raw, d, keys, vals);
    strips.push(z);
    dataBytes += z.length + (z.length & 1); // 짝수 자리에서 시작하게
  }

  const many = count > 1;
  const ENTRIES = 13;
  const ifdBytes = 2 + ENTRIES * 12 + 4;
  let at = 8 + ifdBytes;
  const bpsAt = at; at += 6;
  const xresAt = at; at += 8;
  const yresAt = at; at += 8;
  const offsetsAt = at; if (many) at += count * 4;
  const countsAt = at; if (many) at += count * 4;
  const out = new Uint8Array(at + dataBytes);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0x4949, true); // 'II' = 리틀 엔디언
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);      // 첫 IFD 자리
  dv.setUint16(8, ENTRIES, true);
  let e = 10;
  const SHORT = 3, LONG = 4, RATIONAL = 5;
  const tag = (id, type, n, value) => {
    dv.setUint16(e, id, true);
    dv.setUint16(e + 2, type, true);
    dv.setUint32(e + 4, n, true);
    if (type === SHORT && n === 1) dv.setUint16(e + 8, value, true);
    else dv.setUint32(e + 8, value, true);
    e += 12;
  };
  // 태그는 번호 차례로
  tag(256, LONG, 1, width);
  tag(257, LONG, 1, height);
  tag(258, SHORT, 3, bpsAt);                                   // 표본당 비트
  tag(259, SHORT, 1, 5);                                       // 압축: LZW
  tag(262, SHORT, 1, 2);                                       // 색: RGB
  tag(273, LONG, count, many ? offsetsAt : at);                // 묶음 자리
  tag(277, SHORT, 1, 3);                                       // 화소당 표본
  tag(278, LONG, 1, rowsPerStrip);
  tag(279, LONG, count, many ? countsAt : strips[0].length);   // 묶음 크기
  tag(282, RATIONAL, 1, xresAt);
  tag(283, RATIONAL, 1, yresAt);
  tag(284, SHORT, 1, 1);                                       // 표본을 화소마다 이어 씀
  tag(296, SHORT, 1, 2);                                       // 해상도 단위: 인치
  dv.setUint32(e, 0, true);                                    // 다음 IFD 없음
  for (let i = 0; i < 3; i++) dv.setUint16(bpsAt + i * 2, 8, true);
  const num = Math.max(1, Math.round(dpi * 100));
  for (const r of [xresAt, yresAt]) { dv.setUint32(r, num, true); dv.setUint32(r + 4, 100, true); }
  for (let k = 0; k < count; k++) {
    const z = strips[k];
    if (many) {
      dv.setUint32(offsetsAt + k * 4, at, true);
      dv.setUint32(countsAt + k * 4, z.length, true);
    }
    out.set(z, at);
    at += z.length + (z.length & 1);
  }
  return out;
}
