// 워드 97~2003(.doc) 읽기 — 복합 문서(CFB) 속 WordDocument·표(1Table/0Table)·Data 스트림을 풀어 문서 모델로.
// 글 조각표(piece table)로 글자를 모으고, 문단 속성(PAPX)으로 표·들여쓰기·목록·제목을 가린다.
// 문단·표(가로·세로 합친 칸, 겹친 표는 칸 안 글로 펴서)·각주/미주·필드 결과·글상자·자동 번호·쪽 나뉨(대략)을 읽는다.
// 망가진 파일도 들어올 수 있으니 모든 위치·길이를 확인하고, 되풀이에는 한도를 둔다.
import { readCfb, isCfb } from './cfb.js';
import { noteMark } from './model.js';
import { formatNumber, applyNumberFormat } from './numfmt.js';
import { finishLevels, SOFT_BREAK } from './hwp.js';
import { resolveSoftBreaks } from './joiner.js';

export class DocError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

const MSG_PASSWORD = '암호가 걸린 워드 문서입니다';
const MSG_OLD = '워드 97 이전 형식이라 읽을 수 없습니다';
const MSG_NOT_DOC = '워드 97~2003 문서(.doc)가 아닙니다';
const MSG_BROKEN = '워드 문서를 읽지 못했습니다(손상된 파일일 수 있습니다)';
const broken = () => new DocError('broken', MSG_BROKEN);

// ─── 바이트 읽기: 범위 밖은 0(망가진 파일에서 멈추거나 오류로 죽지 않게) ───
function rd(b) {
  const n = b.length;
  return {
    b, n,
    u8: (o) => (o >= 0 && o < n ? b[o] : 0),
    u16: (o) => (o >= 0 && o + 2 <= n ? b[o] | (b[o + 1] << 8) : 0),
    i16: (o) => (o >= 0 && o + 2 <= n ? ((b[o] | (b[o + 1] << 8)) << 16) >> 16 : 0),
    u32: (o) => (o >= 0 && o + 4 <= n ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : 0),
    i32: (o) => (o >= 0 && o + 4 <= n ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24) : 0),
  };
}

// 8비트로 줄여 저장한 글자 → 유니코드(cp1252, 0x80~0x9F 는 MS-DOC 2.4.1 표대로)
const CP1252 = new Uint16Array(256);
for (let i = 0; i < 256; i++) CP1252[i] = i;
const HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6,
  0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
  0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};
for (const k in HIGH) CP1252[k] = HIGH[k];

// 번호 모양(nfc) → numfmt 이름
const NFC = ['decimal', 'upperRoman', 'lowerRoman', 'upperLetter', 'lowerLetter', 'ordinal', 'cardinalText', 'ordinalText', 'hex',
  'chicago', 'ideographDigital', 'japaneseCounting', 'aiueo', 'iroha', 'decimalFullWidth', 'decimalHalfWidth', 'japaneseLegal',
  'japaneseDigitalTenThousand', 'decimalEnclosedCircle', 'decimalFullWidth2', 'aiueoFullWidth', 'irohaFullWidth', 'decimalZero',
  'bullet', 'ganada', 'chosung', 'decimalEnclosedFullstop', 'decimalEnclosedParen', 'decimalEnclosedCircleChinese',
  'ideographEnclosedCircle', 'ideographTraditional', 'ideographZodiac', 'ideographZodiacTraditional', 'taiwaneseCounting',
  'ideographLegalTraditional', 'taiwaneseCountingThousand', 'taiwaneseDigital', 'chineseCounting', 'chineseLegalSimplified',
  'chineseCountingThousand', 'koreanDigital', 'koreanCounting', 'koreanLegal', 'koreanDigital2', 'vietnameseCounting',
  'russianLower', 'russianUpper', 'none'];
const nfcName = (n) => (n === 255 ? 'none' : NFC[n] || 'decimal');

// 기호 글꼴(Symbol·Wingdings)의 사용자 정의 영역 글자 → 보통 글자(docx.js 와 같은 표)
const SYMBOL_MAP = {
  0xf0b7: '•', 0xf0a7: '▪', 0xf0d8: '➢', 0xf0fc: '✓', 0xf076: '❖', 0xf0a8: '◆', 0xf06c: '●', 0xf06e: '■', 0xf0e0: '→',
  0xf0e8: '➔', 0xf0f0: '⇨', 0xf0b2: '◇', 0xf0a1: '○', 0xf09f: '•', 0xf02d: '-', 0xf0fb: '✗', 0xf0d2: '⇒', 0xf071: '❑',
};
function symChar(code) {
  if (code < 0x100) code += 0xf000; // 기호 글꼴 글자 번호가 0x00~0xFF 로 들어온 경우
  if (SYMBOL_MAP[code]) return SYMBOL_MAP[code];
  if (code >= 0xf020 && code <= 0xf0ff) return '•';
  return String.fromCodePoint(code);
}
function cleanBullet(s) {
  return [...(s || '')].map((ch) => { const c = ch.codePointAt(0); return c >= 0xe000 && c <= 0xf8ff ? symChar(c) : ch === 'o' && s.length === 1 ? '◦' : ch; }).join('');
}

// ─── FIB(문서 머리): 글 길이들과 표 스트림 속 구조들의 위치 ───
function readFib(wd) {
  const r = rd(wd);
  if (r.u16(0) !== 0xa5ec) throw new DocError('format', MSG_NOT_DOC);
  if (r.u16(2) < 0xc1) throw new DocError('format', MSG_OLD);
  if (wd.length < 0x200) throw broken();
  const flags = r.u16(0x0a);
  // fEncrypted(0x0100): 암호(RC4) 또는 XOR 가림(fObfuscated 0x8000 은 fEncrypted 와 함께일 때만 뜻이 있다 — MS-DOC 2.5.2)
  if (flags & 0x0100) throw new DocError('password', MSG_PASSWORD);
  // FibBase(32) 뒤: csw, FibRgW, cslw, FibRgLw, cbRgFcLcb, FibRgFcLcb 차례 — 크기가 이상하면 워드 97 고정 위치로
  const csw = r.u16(32);
  const cslw = r.u16(34 + csw * 2);
  let lwOff = 34 + csw * 2 + 2;
  let fcOff = lwOff + cslw * 4 + 2;
  let nFcLcb = r.u16(lwOff + cslw * 4);
  if (csw > 64 || cslw < 11 || cslw > 64 || nFcLcb < 34 || fcOff + nFcLcb * 8 > wd.length) { lwOff = 64; fcOff = 154; nFcLcb = 93; }
  const lw = (i) => Math.max(0, r.i32(lwOff + 4 * i));
  return {
    flags,
    tableName: flags & 0x0200 ? '1Table' : '0Table',
    ccpText: r.i32(lwOff + 12), ccpFtn: lw(4), ccpHdd: lw(5), ccpMcr: lw(6), ccpAtn: lw(7), ccpEdn: lw(8), ccpTxbx: lw(9),
    fl: (i) => (i < nFcLcb ? { fc: r.u32(fcOff + 8 * i), lcb: r.u32(fcOff + 8 * i + 4) } : { fc: 0, lcb: 0 }),
  };
}

// PLC(위치 목록 + 자료): cps 는 n+1 개, dataAt(i) 는 i 번째 자료의 위치
function plc(r, { fc, lcb }, cbData) {
  if (!lcb || lcb < 4 || fc + lcb > r.n) return null;
  const n = Math.floor((lcb - 4) / (4 + cbData));
  if (n < 0 || (cbData && n === 0)) return null;
  const cps = new Array(n + 1);
  for (let i = 0; i <= n; i++) cps[i] = r.u32(fc + 4 * i);
  return { n, cps, dataAt: (i) => fc + 4 * (n + 1) + cbData * i };
}

// ─── 조각표(Clx): 글 위치(CP) → WordDocument 속 바이트 위치 ───
function readPieces(D) {
  const { tr, wd } = D;
  const { fc, lcb } = D.fib.fl(33);
  if (!lcb || fc + lcb > tr.n) throw broken();
  let o = fc;
  const end = fc + lcb;
  for (let guard = 0; o < end && guard < 100000; guard++) {
    const t = tr.u8(o);
    if (t === 1) { o += 3 + tr.u16(o + 1); continue; } // Prc(조각 속성) — 건너뜀
    if (t !== 2) break;
    const lcbPcd = tr.u32(o + 1);
    const p = o + 5;
    if (lcbPcd < 16 || p + lcbPcd > tr.n) throw broken();
    const n = Math.floor((lcbPcd - 4) / 12);
    const pieces = [];
    let last = 0, total = 0;
    for (let i = 0; i < n; i++) {
      const cp = tr.u32(p + 4 * i);
      let cpEnd = tr.u32(p + 4 * i + 4);
      if (cpEnd <= cp || cp < last) continue;
      const raw = tr.u32(p + 4 * (n + 1) + 8 * i + 2);
      const w = raw & 0x40000000 ? 1 : 2;
      const off = w === 1 ? (raw & 0x3fffffff) >>> 1 : raw & 0x3fffffff;
      const avail = Math.max(0, Math.floor((wd.length - off) / w));
      cpEnd = Math.min(cpEnd, cp + avail); // 스트림 밖 글자는 버린다
      last = tr.u32(p + 4 * i + 4);
      if (cpEnd <= cp) continue;
      total += cpEnd - cp;
      if (total > wd.length * 2 + 65536) throw broken(); // 같은 바이트를 몇 번이고 가리키는 조각표
      pieces.push({ cp, cpEnd, off, w });
    }
    if (!pieces.length) throw broken();
    return pieces;
  }
  throw broken();
}

// CP 범위의 글자를 하나씩 fn(글자, cp, fc, 글자 바이트 수)로
function walk(D, from, to, fn) {
  const { pieces, wd } = D;
  let lo = 0, hi = pieces.length - 1, i = pieces.length;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (pieces[m].cpEnd > from) { i = m; hi = m - 1; } else lo = m + 1; }
  for (; i < pieces.length; i++) {
    const pc = pieces[i];
    if (pc.cp >= to) break;
    const a = Math.max(from, pc.cp), b = Math.min(to, pc.cpEnd);
    if (pc.w === 1) for (let cp = a; cp < b; cp++) { const fc = pc.off + cp - pc.cp; fn(CP1252[wd[fc]], cp, fc, 1); }
    else for (let cp = a; cp < b; cp++) { const fc = pc.off + 2 * (cp - pc.cp); fn(wd[fc] | (wd[fc + 1] << 8), cp, fc, 2); }
  }
}

// ─── sprm(속성 변경 묶음) 훑기 ───
function eachSprm(r, p, end, fn) {
  for (let guard = 0; p + 2 <= end && guard < 20000; guard++) {
    const sprm = r.u16(p);
    p += 2;
    let len;
    switch (sprm >>> 13) {
      case 0: case 1: len = 1; break;
      case 2: case 4: case 5: len = 2; break;
      case 3: len = 4; break;
      case 7: len = 3; break;
      default:
        if (sprm === 0xd608) len = r.u16(p) + 1; // 표 정의: 길이가 2바이트(자신 포함 +1)
        else if (sprm === 0xc615) { // 탭 바꾸기: 길이 255 면 따로 센다
          const cb = r.u8(p);
          if (cb === 255) { const nDel = r.u8(p + 1); len = 3 + 4 * nDel + 3 * r.u8(p + 2 + 4 * nDel); } else len = cb + 1;
        } else len = r.u8(p) + 1;
    }
    if (p + len > end) break;
    fn(sprm, p, len);
    p += len;
  }
}

// 표 정의(sprmTDefTable): 칸 수, 칸 경계(rgdxaCenter), 칸마다 가로·세로 합침 표시
function readTDef(r, p, len) {
  const end = p + len;
  const n = Math.min(r.u8(p + 2), 64);
  const centers = [];
  for (let i = 0; i <= n && p + 5 + 2 * i <= end; i++) centers.push(r.i16(p + 3 + 2 * i));
  const tc = p + 3 + 2 * (n + 1);
  const hm = [], vm = [];
  for (let i = 0; i < n && tc + 20 * i + 20 <= end; i++) { const g = r.u16(tc + 20 * i); hm.push(g & 3); vm.push((g >>> 5) & 3); }
  return { n, centers, hm, vm };
}

// 문단 속성 sprm → out 에 모은다
function papxSprms(D, r, p, end, out, depth) {
  eachSprm(r, p, end, (sprm, o, len) => {
    switch (sprm) {
      case 0x2416: out.inTable = r.u8(o) !== 0; break; // 표 안 문단
      case 0x2417: out.ttp = r.u8(o) !== 0; break; // 줄 끝 표시
      case 0x6649: out.itap = r.i32(o); break; // 표 겹침 깊이
      case 0x664a: out.itap = (out.itap ?? 1) + r.i32(o); break;
      case 0x244b: out.innerCell = r.u8(o) !== 0; break; // 안쪽 표의 칸 끝
      case 0x244c: out.innerTtp = r.u8(o) !== 0; break; // 안쪽 표의 줄 끝
      case 0x2407: out.pbb = r.u8(o) !== 0; break; // 앞에서 쪽 나눔
      case 0x840f: case 0x845e: out.left = r.i16(o); break; // 왼쪽 여백
      case 0x8411: case 0x8460: out.left1 = r.i16(o); break; // 첫 줄(음수면 내어쓰기)
      case 0x460b: out.ilfo = r.i16(o); break; // 목록 번호
      case 0x260a: out.ilvl = r.u8(o); break; // 목록 단계
      case 0x2640: out.outline = r.u8(o); break; // 개요 수준
      case 0xd608: out.tdef = readTDef(r, o, len); break;
      case 0xd62b: if (len >= 3) (out.vmOps ||= []).push([r.u8(o + 1), r.u8(o + 2)]); break; // 세로 합침(칸 하나)
      case 0x9601: if (out.tdef && out.tdef.centers.length) { const d = r.i16(o) - out.tdef.centers[0]; out.tdef.centers = out.tdef.centers.map((x) => x + d); } break;
      case 0x6645: case 0x6646: // 너무 큰 속성은 Data 스트림에
        if (depth === 0 && D.dr) {
          const at = r.u32(o);
          const cb = D.dr.u16(at);
          if (at + 2 + cb <= D.dr.n) papxSprms(D, D.dr, at + 2, at + 2 + cb, out, 1);
        }
        break;
      default: break;
    }
  });
  return out;
}

// ─── 문단 속성 FKP: FC 구간마다 { istd, 속성 } ───
function readPapx(D) {
  const { tr, wr } = D;
  const bte = plc(tr, D.fib.fl(13), 4);
  const starts = [], ends = [], props = [];
  if (!bte) return { starts, ends, props };
  const cache = new Map();
  const seen = new Set(); // 같은 쪽을 여러 번 가리키는 망가진 목록 막기
  for (let i = 0; i < bte.n && i < 200000; i++) {
    const page = (tr.u32(bte.dataAt(i)) & 0x3fffff) * 512;
    if (page + 512 > wr.n || seen.has(page)) continue;
    seen.add(page);
    const crun = wr.u8(page + 511);
    if (!crun || 4 * (crun + 1) + 13 * crun > 511) continue;
    for (let k = 0; k < crun; k++) {
      const s = wr.u32(page + 4 * k), e = wr.u32(page + 4 * k + 4);
      if (e <= s) continue;
      const bOff = wr.u8(page + 4 * (crun + 1) + 13 * k) * 2;
      const key = bOff ? page + bOff : -1;
      let pr = cache.get(key);
      if (!pr) {
        pr = { istd: 0, p: {} };
        if (bOff) {
          const cb = wr.u8(key);
          const st = cb ? key + 1 : key + 2;
          const end = Math.min(st + (cb ? 2 * cb - 1 : 2 * wr.u8(key + 1)), page + 511);
          if (end >= st + 2) { pr.istd = wr.u16(st); papxSprms(D, wr, st + 2, end, pr.p, 0); }
        }
        cache.set(key, pr);
      }
      starts.push(s); ends.push(e); props.push(pr);
    }
  }
  // 대개 이미 차례대로지만, 아니면 정렬한다
  let sorted = true;
  for (let i = 1; i < starts.length; i++) if (starts[i] < starts[i - 1]) { sorted = false; break; }
  if (!sorted) {
    const idx = starts.map((_, i) => i).sort((a, b) => starts[a] - starts[b]);
    return { starts: idx.map((i) => starts[i]), ends: idx.map((i) => ends[i]), props: idx.map((i) => props[i]) };
  }
  return { starts, ends, props };
}

// FC 가 든 구간 번호(없으면 -1)
function findRun(runs, fc) {
  const s = runs.starts;
  let lo = 0, hi = s.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m] <= fc) { k = m; lo = m + 1; } else hi = m - 1; }
  return k >= 0 && fc < runs.ends[k] ? k : -1;
}

// ─── 글자 속성 FKP: 지운 글(고친 흔적)과 기호 글자만 모은다 ───
function readChpx(D) {
  const { tr, wr } = D;
  const bte = plc(tr, D.fib.fl(12), 4);
  const starts = [], ends = [], del = [], sym = [];
  if (!bte) return null;
  const cache = new Map();
  const seen = new Set(); // 같은 쪽을 여러 번 가리키는 망가진 목록 막기
  for (let i = 0; i < bte.n && i < 200000; i++) {
    const page = (tr.u32(bte.dataAt(i)) & 0x3fffff) * 512;
    if (page + 512 > wr.n || seen.has(page)) continue;
    seen.add(page);
    const crun = wr.u8(page + 511);
    if (!crun || 5 * crun + 4 > 511) continue;
    for (let k = 0; k < crun; k++) {
      const s = wr.u32(page + 4 * k), e = wr.u32(page + 4 * k + 4);
      const off = wr.u8(page + 4 * (crun + 1) + k) * 2;
      if (e <= s || !off) continue;
      let pr = cache.get(off + page);
      if (!pr) {
        pr = { del: false, sym: 0 };
        const at = page + off;
        const end = Math.min(at + 1 + wr.u8(at), page + 511);
        eachSprm(wr, at + 1, end, (sprm, o) => {
          if (sprm === 0x0800) pr.del = (wr.u8(o) & 1) === 1; // 지운 글(고친 흔적)
          else if (sprm === 0x6a09) pr.sym = wr.u16(o + 2); // 기호 넣기: 글꼴 번호 + 글자
        });
        cache.set(off + page, pr);
      }
      if (pr.del || pr.sym) { starts.push(s); ends.push(e); del.push(pr.del); sym.push(pr.sym); }
    }
  }
  if (!starts.length) return null;
  const idx = starts.map((_, i) => i).sort((a, b) => starts[a] - starts[b]);
  return { starts: idx.map((i) => starts[i]), ends: idx.map((i) => ends[i]), del: idx.map((i) => del[i]), sym: idx.map((i) => sym[i]) };
}

// ─── 스타일(STSH): 번호 → { sti, 이름, 바탕 스타일, 문단 속성 } ───
function readStyles(D) {
  const { tr } = D;
  const { fc, lcb } = D.fib.fl(1);
  const list = [];
  if (!lcb || fc + lcb > tr.n) return list;
  const end = fc + lcb;
  const cbStshi = tr.u16(fc);
  const cstd = tr.u16(fc + 2);
  const cbBase = tr.u16(fc + 4) || 10;
  let p = fc + 2 + cbStshi;
  for (let i = 0; i < cstd && i < 4096 && p + 2 <= end; i++) {
    const cb = tr.u16(p);
    p += 2;
    if (cb && p + cb <= end) {
      const s = p, e = p + cb;
      const sti = tr.u16(s) & 0x0fff;
      const stk = tr.u16(s + 2) & 0x0f;
      const base = tr.u16(s + 2) >>> 4;
      const cupx = tr.u16(s + 4) & 0x0f;
      const no = s + cbBase;
      const cch = Math.min(tr.u16(no), 255);
      let name = '';
      for (let k = 0; k < cch && no + 4 + 2 * k <= e; k++) name += String.fromCharCode(tr.u16(no + 2 + 2 * k));
      const props = {};
      let q = no + 2 + (cch + 1) * 2;
      if (stk === 1 && cupx >= 1 && q + 2 <= e) {
        const cbUpx = tr.u16(q);
        if (cbUpx >= 2 && q + 2 + cbUpx <= e) papxSprms(D, tr, q + 4, q + 2 + cbUpx, props, 0);
      }
      list[i] = { sti, name: name.toLowerCase(), base: base === 0x0fff ? -1 : base, props };
    }
    p += cb;
  }
  return list;
}

// 스타일 사슬(바탕 → 자기)을 합친 문단 속성
function styleProps(D, istd) {
  let got = D.styleCache.get(istd);
  if (got) return got;
  const chain = [];
  const seen = new Set();
  let i = istd;
  while (i >= 0 && D.styles[i] && !seen.has(i) && chain.length < 20) { seen.add(i); chain.push(D.styles[i]); i = D.styles[i].base; }
  got = {};
  for (let k = chain.length - 1; k >= 0; k--) Object.assign(got, chain[k].props);
  const own = D.styles[istd];
  got.sti = own ? own.sti : 0;
  got.sname = own ? own.name : '';
  D.styleCache.set(istd, got);
  return got;
}

// ─── 목록(PlfLst·PlfLfo) ───
function readLvl(tr, o) {
  if (o + 28 > tr.n) return null;
  const nfc = tr.u8(o + 4);
  const legal = !!(tr.u8(o + 5) & 4);
  const cbChpx = tr.u8(o + 24), cbPapx = tr.u8(o + 25);
  const ind = {};
  papxSprms({ dr: null }, tr, o + 28, Math.min(o + 28 + cbPapx, tr.n), ind, 1);
  const q = o + 28 + cbPapx + cbChpx;
  const cch = Math.min(tr.u16(q), 255);
  let text = '';
  for (let k = 0; k < cch && q + 4 + 2 * k <= tr.n; k++) text += String.fromCharCode(tr.u16(q + 2 + 2 * k));
  let start = tr.i32(o);
  if (start < 0 || start > 100000) start = 1;
  return { lvl: { start, nfc, legal, text, ind: ind.left != null || ind.left1 != null ? ind : null }, next: q + 2 + cch * 2 };
}

function readLists(D) {
  const { tr } = D;
  const lists = new Map();
  const lfos = [];
  const { fc, lcb } = D.fib.fl(73);
  if (lcb >= 2 && fc + lcb <= tr.n) {
    const c = tr.i16(fc);
    const lstf = [];
    for (let i = 0; i < c && i < 4096 && fc + 2 + 28 * i + 28 <= tr.n; i++) {
      const o = fc + 2 + 28 * i;
      lstf.push({ lsid: tr.i32(o), simple: !!(tr.u8(o + 26) & 1) });
    }
    let p = fc + lcb; // 목록 단계(LVL)들은 PlfLst 바로 뒤에 붙는다
    for (const l of lstf) {
      const levels = [];
      for (let k = 0; k < (l.simple ? 1 : 9); k++) {
        const got = readLvl(tr, p);
        if (!got) break;
        levels.push(got.lvl);
        p = got.next;
      }
      lists.set(l.lsid, levels);
    }
  }
  const f = D.fib.fl(74);
  if (f.lcb >= 4 && f.fc + f.lcb <= tr.n) {
    const n = Math.min(tr.i32(f.fc), Math.floor((f.lcb - 4) / 16), 32767);
    for (let i = 0; i < n; i++) {
      const o = f.fc + 4 + 16 * i;
      lfos.push({ lsid: tr.i32(o), clfolvl: tr.u8(o + 12), over: [] });
    }
    // 목록 재정의(시작 번호·단계 바꿈)
    let p = f.fc + 4 + 16 * Math.max(0, n);
    for (const lfo of lfos) {
      if (p + 4 > f.fc + f.lcb) break;
      p += 4;
      for (let k = 0; k < lfo.clfolvl && k < 9; k++) {
        const start = tr.i32(p);
        const fl = tr.u32(p + 4);
        p += 8;
        const ov = { ilvl: fl & 0x0f, startAt: fl & 0x10 ? start : null, lvl: null };
        if (fl & 0x20) { const got = readLvl(tr, p); if (!got) break; ov.lvl = got.lvl; p = got.next; }
        lfo.over[ov.ilvl] = ov;
      }
    }
  }
  return { lists, lfos };
}

// ─── 구역 나눔 종류(이어서·새 쪽): 구역 끝 CP → 다음 구역의 나눔 종류 ───
function readSections(D) {
  const out = new Map();
  const sed = plc(D.tr, D.fib.fl(6), 12);
  if (!sed) return out;
  for (let i = 0; i + 1 < sed.n && i < 10000; i++) {
    const fcSepx = D.tr.u32(sed.dataAt(i + 1) + 2);
    let bkc = 2;
    if (fcSepx !== 0xffffffff && fcSepx + 2 <= D.wr.n) {
      const cb = D.wr.i16(fcSepx);
      if (cb > 0) eachSprm(D.wr, fcSepx + 2, Math.min(fcSepx + 2 + cb, D.wr.n), (sprm, o) => { if (sprm === 0x3009) bkc = D.wr.u8(o); });
    }
    out.set(sed.cps[i + 1] - 1, bkc);
  }
  return out;
}

// 요약 정보(\u0005SummaryInformation)의 쪽 수
function summaryPages(cfb) {
  try {
    const s = cfb.read('\u0005SummaryInformation');
    if (!s || s.length < 48) return 0;
    const r = rd(s);
    const off = r.u32(44);
    const cnt = Math.min(r.u32(off + 4), 256);
    for (let i = 0; i < cnt; i++) {
      if (r.u32(off + 8 + 8 * i) !== 14) continue;
      const at = off + r.u32(off + 12 + 8 * i);
      const v = r.u32(at) === 3 ? r.i32(at + 4) : 0;
      return v > 0 && v < 100000 ? v : 0;
    }
  } catch { /* 없어도 그만 */ }
  return 0;
}

// ─── 각주·미주·글상자 같은 딸린 글(구조 없이 문단만) ───
function storyText(D, from, to, soft) {
  // 망가진 목록이 같은 긴 범위를 몇 번이고 가리켜도 멈추지 않게, 딸린 글 전체에 글자 수 한도
  const n = Math.max(0, to - from);
  if (n > D.budget) return '';
  D.budget -= n;
  const lines = [];
  let cur = [];
  const fields = [];
  let code = 0, over = 0;
  const flush = () => { lines.push(String.fromCharCode.apply(null, cur).replace(/\s+$/, '')); cur = []; };
  walk(D, from, to, (c, cp, fc) => {
    switch (c) {
      case 0x0d: case 0x07: case 0x0c: flush(); return;
      case 0x13: if (fields.length < 64) { fields.push(true); code++; } else over++; return;
      case 0x14: if (fields.length && fields[fields.length - 1]) { fields[fields.length - 1] = false; code--; } return;
      case 0x15: if (over) over--; else if (fields.length && fields.pop()) code--; return;
      default: break;
    }
    if (code) return;
    if (D.chpx) { const k = findRun(D.chpx, fc); if (k >= 0) { if (D.chpx.del[k]) return; if (c === 0x28 && D.chpx.sym[k]) { for (const ch of symChar(D.chpx.sym[k])) cur.push(ch.charCodeAt(0)); return; } } }
    if (c < 0x20) {
      if (c === 0x09) cur.push(9);
      else if (c === 0x0b) cur.push(soft ? SOFT_BREAK.charCodeAt(0) : 10);
      else if (c === 0x1e) cur.push(0x2d);
      return;
    }
    cur.push(c === 0xa0 ? 0x20 : c);
    if (cur.length > 8192) { lines.push(String.fromCharCode.apply(null, cur)); cur = []; }
  });
  if (cur.length) flush();
  return lines.join('\n').replace(/\s+$/, '');
}

// ─── 표 만들기 ───
// 줄마다 칸 경계(rgdxaCenter)를 모아 열 격자를 만들고, 칸이 몇 열을 덮는지(가로 합침)·세로 합침을 정한다
function buildRows(raw) {
  const xs = [];
  for (const r of raw) if (r.tdef && r.tdef.centers.length >= 2) for (const x of r.tdef.centers) xs.push(x);
  xs.sort((a, b) => a - b);
  let grid = [];
  for (const x of xs) if (!grid.length || x - grid[grid.length - 1] > 15) grid.push(x);
  if (grid.length > 256) grid = [];
  const colOf = (x) => { // 가장 가까운 경계(이분 탐색)
    let lo = 0, hi = grid.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (grid[m] < x) lo = m + 1; else hi = m; }
    return lo > 0 && x - grid[lo - 1] < grid[lo] - x ? lo - 1 : lo;
  };
  const rows = [];
  const origin = []; // 세로 합침: 열 → 위쪽 시작 칸
  for (const r of raw) {
    const td = grid.length >= 2 && r.tdef && r.tdef.centers.length >= 2 ? r.tdef : null;
    const vms = td ? td.vm.slice() : [];
    if (td && r.vmOps) for (const [itc, v] of r.vmOps) if (itc < 64) vms[itc] = v;
    const row = [];
    let col = 0;
    let prev = null;
    for (let i = 0; i < r.cells.length; i++) {
      const s = r.cells[i];
      let c0 = col, cs = 1;
      if (td && i + 1 < td.centers.length) {
        c0 = Math.max(col, colOf(td.centers[i]));
        cs = Math.max(1, colOf(td.centers[i + 1]) - c0);
      }
      const hm = td ? td.hm[i] || 0 : 0;
      const vm = vms[i] || 0;
      if (hm >= 2 && prev) { // 앞 칸에 가로로 합쳐진 칸(옛 방식)
        if (s.trim()) prev.s += (prev.s ? '\n' : '') + s;
        prev.cs += cs;
        for (let k = 0; k < cs; k++) row[c0 + k] = null;
        col = c0 + cs;
        continue;
      }
      if (vm === 1 && origin[c0]) {
        origin[c0].rs = (origin[c0].rs || 1) + 1;
        if (s.trim()) origin[c0].s += (origin[c0].s ? '\n' : '') + s;
        row[c0] = null;
      } else {
        const cell = { s, cs, rs: 1 };
        row[c0] = cell;
        for (let k = 0; k < cs; k++) origin[c0 + k] = cell;
        prev = cell;
      }
      for (let k = 1; k < cs; k++) row[c0 + k] = null;
      col = c0 + cs;
    }
    rows.push(row);
  }
  let ncol = Math.max(0, grid.length - 1);
  for (const r of rows) ncol = Math.max(ncol, r.length);
  for (const r of rows) { for (let i = 0; i < ncol; i++) if (r[i] === undefined) r[i] = null; r.length = ncol; }
  return rows;
}

function flatTable(rows) {
  return rows.map((r) => r.filter(Boolean).map((c) => c.s.replace(/\n/g, ' ')).join(' | ')).filter((x) => x.trim()).join('\n');
}

const cellJoin = (parts) => parts.join('\n').replace(/\s+$/, '');

// ─── 들여쓰기·제목·번호 ───
function indentX(ind, lead) {
  if (!ind) return lead * 110 * 5;
  return (Math.max(0, (ind.left || 0) + (ind.left1 || 0)) + lead * 110) * 5; // twip → HWPUNIT(5배), 한글과 같은 기준
}

function isHeading(pr) {
  return (pr.outline != null && pr.outline < 9) || (pr.sti >= 1 && pr.sti <= 9) || pr.sti === 62
    || /^(heading|제목)\s*\d/.test(pr.sname) || pr.sname === 'title';
}

const NO_LABEL = { label: '', ind: null };

function numberLabel(D, st, pr) {
  const ilfo = pr.ilfo;
  if (!ilfo || ilfo < 1 || ilfo > D.lfos.length) return NO_LABEL;
  const lfo = D.lfos[ilfo - 1];
  const levels = D.lists.get(lfo.lsid);
  if (!levels || !levels.length) return NO_LABEL;
  const ilvl = Math.max(0, Math.min(levels.length - 1, pr.ilvl || 0));
  const ov = lfo.over[ilvl];
  const lv = (ov && ov.lvl) || levels[ilvl];
  if (!lv) return NO_LABEL;
  let cnt = st.counters.get(lfo.lsid);
  if (!cnt) { cnt = levels.map((l) => (l ? l.start - 1 : 0)); st.counters.set(lfo.lsid, cnt); }
  if (!st.started.has(ilfo)) {
    st.started.add(ilfo);
    for (const o of lfo.over) if (o && o.startAt != null && o.ilvl < cnt.length) cnt[o.ilvl] = o.startAt - 1;
  }
  cnt[ilvl] = (cnt[ilvl] ?? 0) + 1;
  for (let k = ilvl + 1; k < cnt.length; k++) cnt[k] = levels[k] ? levels[k].start - 1 : 0;
  let label = '';
  if (lv.nfc === 23) label = cleanBullet(lv.text);
  else {
    for (const ch of lv.text) {
      const c = ch.charCodeAt(0);
      if (c < 9) {
        if (lv.nfc === 255 || lv.nfc === 47) continue;
        const k = c;
        const lk = (lfo.over[k] && lfo.over[k].lvl) || levels[k];
        const fmt = lv.legal || !lk ? 'decimal' : nfcName(lk.nfc);
        label += fmt === 'bullet' ? '' : formatNumber(Math.max(cnt[k] ?? 1, 1), fmt);
      } else label += ch;
    }
  }
  return { label: label ? label + (/\s$/.test(label) ? '' : ' ') : '', ind: lv.ind };
}

// ─── 본문 읽기: 글자를 받아 문단·표로 엮는다 ───
function readBody(D, onProgress) {
  const st = {
    blocks: [], xs: [], notes: [], noteNo: 0, page: 1, pendingGap: 0,
    counters: new Map(), started: new Set(),
    tables: [], // 열린 표(겹친 깊이마다 하나)
  };
  let buf = new Uint16Array(4096), len = 0;
  const push = (c) => {
    if (len === buf.length) { const nb = new Uint16Array(buf.length * 2); nb.set(buf); buf = nb; }
    buf[len++] = c;
  };
  const pushStr = (s) => { for (let i = 0; i < s.length; i++) push(s.charCodeAt(i)); };
  const take = () => {
    let s = '';
    for (let i = 0; i < len; i += 8192) s += String.fromCharCode.apply(null, buf.subarray(i, Math.min(len, i + 8192)));
    len = 0;
    return s;
  };
  const fields = [];
  let code = 0, over = 0;
  let extras = [];
  let contPart = false; // 문단 중간의 쪽 나눔 뒤(번호를 다시 붙이지 않는다)

  const pushBlocks = (blocks) => {
    for (const b of blocks) {
      if (st.pendingGap) { b.gap = Math.max(b.gap || 0, 1); st.pendingGap = 0; }
      st.blocks.push(b);
    }
  };

  const paraProps = (fc) => {
    const k = findRun(D.papx, fc);
    const direct = k >= 0 ? D.papx.props[k] : { istd: 0, p: {} };
    const pr = Object.assign({}, styleProps(D, direct.istd), direct.p);
    pr.hasInd = pr.left != null || pr.left1 != null;
    pr.runEnd = k >= 0 ? D.papx.ends[k] : -1;
    return pr;
  };

  // 표 닫기: 겹친 표는 바깥 칸의 글로 펴고, 맨 바깥 표는 블록으로
  const newTable = () => ({ rows: [], cells: [], cell: [], pg: st.page });
  const finishRow = (t, pr) => {
    if (t.cell.length) { t.cells.push(cellJoin(t.cell)); t.cell = []; }
    if (t.cells.length || pr) t.rows.push({ cells: t.cells, tdef: pr ? pr.tdef : null, vmOps: pr ? pr.vmOps : null });
    t.cells = [];
  };
  const popInner = () => {
    const t = st.tables.pop();
    finishRow(t, null);
    const flat = flatTable(buildRows(t.rows));
    if (flat) st.tables[st.tables.length - 1].cell.push(flat);
  };
  const closeTables = () => {
    while (st.tables.length > 1) popInner();
    if (!st.tables.length) return;
    const t = st.tables.pop();
    finishRow(t, null);
    const rows = buildRows(t.rows.filter((r) => r.cells.length));
    if (!rows.length) return;
    const filled = rows.flat().filter((c) => c && c.s.trim());
    if (filled.length <= 1 && rows.length * rows[0].length <= 2) { // 칸 하나짜리 표 → 문단
      const out = [];
      if (filled[0]) for (const line of filled[0].s.split('\n')) if (line.trim()) out.push({ t: 'p', segs: [{ s: line.trim(), pg: t.pg }], joins: '', lvl: 0, kind: '', gap: 0 });
      if (out.length) out[0].gap = 1;
      pushBlocks(out);
      return;
    }
    pushBlocks([{ t: 'tbl', rows, pg: t.pg, gap: 1 }]);
  };

  const tablePara = (depth, c, text, pr, ex) => {
    while (st.tables.length > depth) popInner();
    while (st.tables.length < depth) st.tables.push(newTable());
    const t = st.tables[depth - 1];
    const rowEnd = depth === 1 ? pr.ttp : pr.innerTtp;
    if (rowEnd) { finishRow(t, pr); return; }
    const { label } = numberLabel(D, st, pr);
    let s = (label + text).replace(/\s+$/, '');
    if (ex.length) s = (s + '\n' + ex.join('\n')).replace(/\s+$/, '');
    t.cell.push(s);
    const cellEnd = depth === 1 ? c === 0x07 : pr.innerCell || c === 0x07;
    if (cellEnd) { t.cells.push(cellJoin(t.cell)); t.cell = []; }
  };

  const plainPara = (text, pr, ex, cont) => {
    closeTables();
    if (pr.pbb && !cont && st.blocks.length) st.page++;
    const { label, ind } = cont ? NO_LABEL : numberLabel(D, st, pr);
    const out = [];
    if (text.replace(/[\s\ue000-\ue001]/g, '') || label.trim()) {
      const lead = text.match(/^[ \u3000]*/)[0];
      const s = label + text.slice(lead.length);
      const x = indentX(pr.hasInd ? pr : ind, lead.length);
      st.xs.push(x);
      const heading = !cont && isHeading(pr);
      out.push({ t: 'p', segs: [{ s, pg: st.page }], joins: '', lvl: 0, kind: heading ? 'h' : label ? 'li' : '', gap: heading && st.blocks.length ? 1 : 0, _x: x });
    } else if (!ex.length) {
      st.pendingGap = 1;
    }
    for (const t of ex) for (const line of t.split('\n')) if (line.trim()) out.push({ t: 'p', segs: [{ s: line.trim(), pg: st.page }], joins: '', lvl: 0, kind: '', gap: 0 });
    pushBlocks(out);
  };

  // 문단 끝(0x0D), 칸·줄 끝(0x07), 쪽·구역 나눔(0x0C)
  const endPara = (c, fc, w) => {
    const pr = paraProps(fc);
    const depth = pr.inTable ? Math.max(1, Math.min(pr.itap || 1, 64)) : 0;
    if (c === 0x0c && pr.runEnd !== fc + w && !depth) {
      // 문단 중간의 쪽 나눔: 앞부분만 내보내고 나머지는 같은 문단으로 잇는다
      if (len === 0 && !extras.length) return;
      const text = take();
      if (!text.replace(/[\s\ue000-\ue001]/g, '') && !extras.length) return;
      const ex = extras; extras = [];
      plainPara(text, pr, ex, contPart);
      contPart = true;
      return;
    }
    const text = take();
    const ex = extras; extras = [];
    const cont = contPart;
    contPart = false;
    if (depth) tablePara(depth, c, text, pr, ex);
    else plainPara(text, pr, ex, cont);
  };

  // 각주·미주 참조와 글상자 자리(CP 순서대로)
  const specials = D.specials;
  let si = 0;
  let nextSp = specials.length ? specials[0].cp : Infinity;

  const onChar = (c, cp, fc, w) => {
    if (cp >= nextSp) {
      while (si < specials.length && specials[si].cp < cp) si++;
      let isRef = false;
      while (si < specials.length && specials[si].cp === cp) {
        const sp = specials[si++];
        if (sp.kind === 'box') { const t = D.boxText(sp.idx); if (t) extras.push(t); continue; }
        st.noteNo++;
        st.notes.push({ id: st.noteNo, s: D.noteText(sp.kind, sp.idx) });
        if (!code) pushStr(noteMark(st.noteNo));
        isRef = true;
      }
      nextSp = si < specials.length ? specials[si].cp : Infinity;
      if (isRef && c === 0x02) return;
    }
    switch (c) {
      case 0x0d: case 0x07: endPara(c, fc, w); return;
      case 0x0c: {
        endPara(c, fc, w);
        const bkc = D.sections.get(cp);
        if (bkc === undefined || bkc !== 0) st.page++;
        return;
      }
      case 0x13: if (fields.length < 64) { fields.push(true); code++; } else over++; return; // 필드 시작
      case 0x14: if (fields.length && fields[fields.length - 1]) { fields[fields.length - 1] = false; code--; } return; // 결과 시작
      case 0x15: if (over) over--; else if (fields.length && fields.pop()) code--; return; // 필드 끝
      default: break;
    }
    if (code) return; // 필드 코드는 버리고 결과만
    if (D.chpx) {
      const k = findRun(D.chpx, fc);
      if (k >= 0) {
        if (D.chpx.del[k]) return; // 고친 흔적으로 지운 글
        if (c === 0x28 && D.chpx.sym[k]) { pushStr(symChar(D.chpx.sym[k])); return; }
      }
    }
    if (c < 0x20) {
      if (c === 0x09) push(9);
      else if (c === 0x0b) push(SOFT_BREAK.charCodeAt(0)); // 강제 줄바꿈
      else if (c === 0x1e) push(0x2d); // 줄 안 나뉘는 붙임표
      return; // 0x1F(선택 하이픈)·그림(0x01, 0x08)·주석(0x05) 등은 버린다
    }
    push(c === 0xa0 ? 0x20 : c);
  };

  const last = D.pieces[D.pieces.length - 1].cpEnd;
  const to = Math.min(D.fib.ccpText, last);
  const STEP = 1 << 16;
  for (let a = 0; a < to; a += STEP) {
    walk(D, a, Math.min(to, a + STEP), onChar);
    if (onProgress) onProgress(Math.min(1, (a + STEP) / to) * 0.95);
  }
  // 끝 표시 없이 끝난 글
  if (len || extras.length) { const ex = extras; extras = []; plainPara(take(), { hasInd: false }, ex, contPart); }
  closeTables();
  // 자리를 못 찾은 글상자는 끝에
  for (const t of D.unplacedBoxes()) for (const line of t.split('\n')) if (line.trim()) pushBlocks([{ t: 'p', segs: [{ s: line.trim(), pg: st.page }], joins: '', lvl: 0, kind: '', gap: 0 }]);
  return st;
}

function parseInner(u8, onProgress) {
  if (!isCfb(u8)) {
    // 워드 2(0xDBA5)·맥 워드 5(0x9BA5) 같은 아주 옛 형식
    if ((u8[0] === 0xdb || u8[0] === 0x9b) && u8[1] === 0xa5) throw new DocError('format', MSG_OLD);
    throw new DocError('format', MSG_NOT_DOC);
  }
  let cfb;
  try { cfb = readCfb(u8); } catch { throw broken(); }
  const wd = cfb.read('WordDocument');
  if (!wd) throw new DocError('format', MSG_NOT_DOC);
  const fib = readFib(wd);
  if (fib.ccpText < 0) throw broken();
  // 표 스트림: FIB 가 가리키는 쪽이 없으면 다른 쪽이라도(잘못 적어 둔 다른 프로그램 파일)
  const tbl = cfb.read(fib.tableName) || cfb.read(fib.tableName === '1Table' ? '0Table' : '1Table');
  if (!tbl) throw broken();
  const data = cfb.read('Data');
  const D = { cfb, wd, fib, tr: rd(tbl), wr: rd(wd), dr: data ? rd(data) : null, styleCache: new Map(), budget: wd.length * 2 + 65536 };
  D.pieces = readPieces(D);

  // 문단·글자 속성, 스타일, 목록, 구역 — 이 부분이 망가져도 글은 뽑는다
  const warnings = [];
  const safe = (f, fallback, warn) => { try { return f(); } catch { if (warn) warnings.push(warn); return fallback; } };
  D.papx = safe(() => readPapx(D), { starts: [], ends: [], props: [] }, '표·문단 정보를 읽지 못해 글만 뽑았습니다');
  D.chpx = safe(() => readChpx(D), null);
  D.styles = safe(() => readStyles(D), []);
  const L = safe(() => readLists(D), { lists: new Map(), lfos: [] });
  D.lists = L.lists;
  D.lfos = L.lfos;
  D.sections = safe(() => readSections(D), new Map());

  // 딸린 글들의 시작 위치
  const f = fib;
  const ftnStart = f.ccpText;
  const ednStart = f.ccpText + f.ccpFtn + f.ccpHdd + f.ccpMcr + f.ccpAtn;
  const txbxStart = ednStart + f.ccpEdn;
  const specials = [];
  const noteSrc = { fn: null, en: null };
  for (const [kind, refI, txtI, start, ccp] of [['fn', 2, 3, ftnStart, f.ccpFtn], ['en', 46, 47, ednStart, f.ccpEdn]]) {
    if (!ccp) continue;
    const ref = plc(D.tr, f.fl(refI), 2);
    const txt = plc(D.tr, f.fl(txtI), 0);
    if (!ref || !txt) continue;
    noteSrc[kind] = { txt, start, ccp };
    for (let i = 0; i < ref.n && i < 100000; i++) specials.push({ cp: ref.cps[i], kind, idx: i });
  }
  D.noteText = (kind, i) => {
    const n = noteSrc[kind];
    if (!n || i + 1 >= n.txt.cps.length) return '';
    const a = n.start + Math.min(n.txt.cps[i], n.ccp), b = n.start + Math.min(n.txt.cps[i + 1], n.ccp);
    return b > a ? safe(() => storyText(D, a, b, false), '') : '';
  };

  // 글상자: 모양 자리(PlcSpaMom)의 모양 번호 ↔ 글상자 글(PlcftxbxTxt)의 모양 번호
  const boxes = [];
  if (f.ccpTxbx) {
    const tx = plc(D.tr, f.fl(56), 22);
    if (tx) {
      for (let i = 0; i < tx.n && i < 10000; i++) {
        const a = txbxStart + Math.min(tx.cps[i], f.ccpTxbx), b = txbxStart + Math.min(tx.cps[i + 1], f.ccpTxbx);
        const reusable = D.tr.i16(tx.dataAt(i) + 8);
        boxes.push({ lid: D.tr.i32(tx.dataAt(i) + 14), a, b, used: !!reusable || b <= a });
      }
    }
    const spa = plc(D.tr, f.fl(40), 26);
    if (spa && boxes.length) {
      const byLid = new Map();
      boxes.forEach((bx, i) => { if (!bx.used && !byLid.has(bx.lid)) byLid.set(bx.lid, i); });
      for (let i = 0; i < spa.n && i < 100000; i++) {
        const k = byLid.get(D.tr.i32(spa.dataAt(i)));
        if (k != null) specials.push({ cp: spa.cps[i], kind: 'box', idx: k });
      }
    }
  }
  D.boxText = (i) => {
    const bx = boxes[i];
    if (!bx || bx.used) return '';
    bx.used = true;
    return safe(() => storyText(D, bx.a, bx.b, true), '').trim();
  };
  D.unplacedBoxes = () => boxes.map((bx, i) => (bx.used ? '' : D.boxText(i))).filter(Boolean);
  specials.sort((a, b) => a.cp - b.cp);
  D.specials = specials;

  const st = readBody(D, onProgress);
  finishLevels(st.blocks, st.xs);
  const pages = Math.max(st.page, summaryPages(cfb));
  const doc = { format: 'doc', pages, pageExact: false, blocks: st.blocks, notes: st.notes, warnings };
  resolveSoftBreaks(doc);
  if (onProgress) onProgress(1);
  return doc;
}

export function parseDoc(bytes, { onProgress } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    return parseInner(u8, onProgress);
  } catch (e) {
    if (e instanceof DocError) throw e;
    throw broken(); // 범위 밖 읽기·너무 큰 할당 같은 예상 못 한 오류도 '손상'으로
  }
}
