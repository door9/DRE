// 복합 문서(CFB/OLE2) 읽기 — 옛 한글(.hwp)·워드(.doc)·엑셀(.xls)이 쓰는 '파일 속 파일' 구조.
// readCfb(bytes) → { paths(): [이름…], read(이름): Uint8Array|null, has(이름) }

export const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function isCfb(u8) {
  if (u8.length < 512) return false;
  for (let i = 0; i < 8; i++) if (u8[i] !== CFB_MAGIC[i]) return false;
  return true;
}

const FREE = 0xffffffff, END = 0xfffffffe, FATSECT = 0xfffffffd, DIFSECT = 0xfffffffc;

export function readCfb(u8) {
  if (!isCfb(u8)) throw new Error('복합 문서 형식이 아닙니다');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = (o) => dv.getUint16(o, true);
  const u32 = (o) => dv.getUint32(o, true);
  const sectorShift = u16(0x1e);
  const miniShift = u16(0x20);
  if (sectorShift !== 9 && sectorShift !== 12) throw new Error('복합 문서 머리가 이상합니다');
  const ssz = 1 << sectorShift;
  const mssz = 1 << miniShift;
  const nFat = u32(0x2c);
  const firstDir = u32(0x30);
  const miniCutoff = u32(0x38) || 4096;
  const firstMiniFat = u32(0x3c);
  const nMiniFat = u32(0x40);
  let difat = u32(0x44);
  const nDifat = u32(0x48);
  const maxSect = Math.floor((u8.length - ssz) / ssz) + 1;
  const off = (sid) => (sid + 1) * ssz;

  // FAT 섹터 목록(DIFAT)
  const fatSects = [];
  for (let i = 0; i < 109 && fatSects.length < nFat; i++) {
    const s = u32(0x4c + i * 4);
    if (s === FREE || s === END) break;
    fatSects.push(s);
  }
  const perDifat = ssz / 4 - 1;
  for (let k = 0; k < nDifat && difat !== END && difat !== FREE && difat < maxSect; k++) {
    const base = off(difat);
    for (let i = 0; i < perDifat && fatSects.length < nFat; i++) {
      const s = u32(base + i * 4);
      if (s !== FREE) fatSects.push(s);
    }
    difat = u32(base + perDifat * 4);
  }
  const fat = new Uint32Array(fatSects.length * (ssz / 4));
  fatSects.forEach((s, i) => {
    const base = off(s);
    for (let k = 0; k < ssz / 4; k++) fat[i * (ssz / 4) + k] = base + k * 4 + 4 <= u8.length ? u32(base + k * 4) : FREE;
  });

  // 사슬 따라 읽기(고리·범위 밖 보호)
  function chain(start, table, limit) {
    const out = [];
    const seen = new Set();
    let s = start;
    while (s !== END && s !== FREE && s < table.length && !seen.has(s)) {
      if (s === FATSECT || s === DIFSECT) break;
      seen.add(s);
      out.push(s);
      if (out.length > limit) break;
      s = table[s];
    }
    return out;
  }

  function readBig(start, size) {
    const sects = chain(start, fat, maxSect + 1);
    const total = size != null ? size : sects.length * ssz;
    const out = new Uint8Array(Math.min(total, sects.length * ssz));
    let pos = 0;
    for (const s of sects) {
      if (pos >= out.length) break;
      const o = off(s);
      const n = Math.min(ssz, out.length - pos, Math.max(0, u8.length - o));
      out.set(u8.subarray(o, o + n), pos);
      pos += n;
    }
    return out;
  }

  // 디렉터리
  const dirBytes = readBig(firstDir, null);
  const entries = [];
  for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
    const nameLen = dirBytes[o + 64] | (dirBytes[o + 65] << 8);
    let name = '';
    const nb = Math.min(nameLen, 64) - 2; // 끝의 빈 글자(2바이트) 제외
    for (let k = 0; k + 2 <= nb; k += 2) name += String.fromCharCode(dirBytes[o + k] | (dirBytes[o + k + 1] << 8));
    const ddv = new DataView(dirBytes.buffer, dirBytes.byteOffset + o, 128);
    entries.push({
      name,
      type: dirBytes[o + 66],
      left: ddv.getUint32(68, true),
      right: ddv.getUint32(72, true),
      child: ddv.getUint32(76, true),
      start: ddv.getUint32(116, true),
      size: ddv.getUint32(120, true) + (sectorShift === 12 ? ddv.getUint32(124, true) * 0x100000000 : 0),
    });
  }
  if (!entries.length || entries[0].type !== 5) throw new Error('복합 문서 목록을 읽지 못했습니다');
  const root = entries[0];

  // 작은 조각(미니 스트림)
  let miniFat = null;
  let miniStream = null;
  function ensureMini() {
    if (miniFat) return;
    const mf = nMiniFat ? readBig(firstMiniFat, nMiniFat * ssz) : new Uint8Array(0);
    const mdv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength);
    miniFat = new Uint32Array(mf.length / 4);
    for (let i = 0; i < miniFat.length; i++) miniFat[i] = mdv.getUint32(i * 4, true);
    miniStream = readBig(root.start, root.size);
  }

  // 이름 붙이기(나무를 따라 '저장소/스트림' 경로로)
  const byPath = new Map();
  function walk(idx, prefix, depth) {
    const stack = [idx];
    const seen = new Set();
    while (stack.length) {
      const i = stack.pop();
      if (i === FREE || i >= entries.length || seen.has(i)) continue;
      seen.add(i);
      const e = entries[i];
      stack.push(e.left, e.right);
      const p = prefix ? prefix + '/' + e.name : e.name;
      if (e.type === 2) byPath.set(p, e);
      else if (e.type === 1 && depth < 16) walk(e.child, p, depth + 1);
    }
  }
  walk(root.child, '', 0);

  function read(p) {
    const e = byPath.get(p);
    if (!e) return null;
    if (e.size < miniCutoff) {
      ensureMini();
      const sects = chain(e.start, miniFat, Math.ceil(e.size / mssz) + 2);
      const out = new Uint8Array(e.size);
      let pos = 0;
      for (const s of sects) {
        if (pos >= out.length) break;
        const o = s * mssz;
        const n = Math.min(mssz, out.length - pos, Math.max(0, miniStream.length - o));
        out.set(miniStream.subarray(o, o + n), pos);
        pos += n;
      }
      return out;
    }
    return readBig(e.start, e.size);
  }

  return {
    paths: () => [...byPath.keys()],
    has: (p) => byPath.has(p),
    read,
  };
}
