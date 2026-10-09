// 엑셀 97~2003(.xls) 읽기 — 복합 문서(CFB) 속 Workbook(BIFF8)·Book(BIFF5/7) 스트림의 레코드를 훑어
// 셀 값을 엑셀이 화면에 그리는 글(서식 적용)로 모아 문서 모델로. 시트 자료 모양은 XLSX(xlsx.js)와 같다.
// 숨긴 시트·행·열은 빼고, 합친 칸·글상자 글을 살린다. 망가진 파일도 들어올 수 있으니 모든 위치·길이를 확인하고, 되풀이에는 한도를 둔다.
import { readCfb, isCfb } from './cfb.js';
import { formatValue, BUILTIN } from './xlfmt.js';
import { sheetsToModel, MAX_CELLS } from './sheet.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const broken = () => fail('broken', '엑셀 문서를 읽지 못했습니다(손상된 파일일 수 있습니다)');
const tooOld = () => fail('unsupported', '엑셀 4.0 이전 형식(.xls)이라 읽을 수 없습니다');

// 레코드 번호
const BOF = 0x0809, EOF = 0x000a, CONTINUE = 0x003c, FILEPASS = 0x002f, CODEPAGE = 0x0042, DATEMODE = 0x0022;
const BOUNDSHEET = 0x0085, SST = 0x00fc, FORMAT = 0x041e, XF = 0x00e0;
const ROW = 0x0208, COLINFO = 0x007d, DEFROWHEIGHT = 0x0225, WSBOOL = 0x0081, MERGEDCELLS = 0x00e5;
const LABELSST = 0x00fd, LABEL = 0x0204, RSTRING = 0x00d6, NUMBER = 0x0203, RK = 0x027e, MULRK = 0x00bd;
const FORMULA = 0x0006, STRING = 0x0207, BOOLERR = 0x0205;
const MSODRAWING = 0x00ec, OBJ = 0x005d, TXO = 0x01b6;

// 부분 스트림 종류(BOF 의 dt)
const DT_CHART = 0x0020, DT_MACRO = 0x0040, DT_VB = 0x0100;

// 오류 값 번호 → 글
const ERRORS = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A', 0x2b: '#GETTING_DATA' };

// 글상자로 치지 않는 그림 개체: 양식 단추·확인란·목록 등(0x07, 0x0B~0x14)과 메모(0x19)
const NOT_TEXTBOX = new Set([0x07, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x19]);

// 모델로 만들 때 모아 둘 셀 수 상한(메모리·시간): sheet.js 는 시트 차례·행 차례로 보이는 칸 앞 40만 개만 쓴다.
// 보이는 칸이 VIS_CAP(넉넉히 50만)에 이르면 더는 서식을 입히지 않는다. 숨긴 행·열 칸까지 모두 쳐서는 KEEP_CELLS 까지.
const KEEP_CELLS = 1500000, VIS_CAP = MAX_CELLS + 100000;
// BIFF5·8 시트의 열은 256개(A~IV)뿐 — 그 밖의 번호는 망가진 값이다
const MAX_COL = 255;
// 합친 칸 한도: 하나가 이보다 넓으면 글이 있는 범위로 줄이고, 시트 안 넓이 합이 넘치면 나머지는 버린다
// (실제 문서는 하나 126칸·합 7천 칸 정도. 망가진 파일에서 모델 만들기의 칸마다 도는 반복이 커지지 않게)
const BIG_MERGE = 200000, MERGE_BUDGET = 500000;
// 숫자 글 기억칸 크기(XF·값 → 그린 글)
const MEMO_MAX = 300000;

// ─── 글자 풀기 ───
// 8비트 글(BIFF5 의 CODEPAGE) → TextDecoder 이름
const CP_NAMES = {
  437: 'windows-1252', 866: 'ibm866', 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 1361: 'euc-kr',
  10000: 'macintosh', 32768: 'macintosh', 32769: 'windows-1252', 20866: 'koi8-r', 21866: 'koi8-u', 20932: 'euc-jp', 51932: 'euc-jp',
  54936: 'gb18030', 65001: 'utf-8',
};
function decoderFor(cp) {
  const name = CP_NAMES[cp] || (cp >= 1250 && cp <= 1258 ? 'windows-' + cp : cp > 28590 && cp < 28606 ? 'iso-8859-' + (cp - 28590) : 'windows-1252');
  for (const n of [name, 'windows-1252']) {
    try { return new TextDecoder(n); } catch { /* 다음 이름으로 */ }
  }
  return null;
}

const CH = new Uint16Array(4096);
// 2바이트 글자(UTF-16LE) n 개 — 짝 안 맞는 대리 글자도 그대로(조각 경계에서 잘린 짝이 이어 붙으면 살아나게)
function utf16(b, o, n) {
  let s = '';
  while (n > 0) {
    const m = Math.min(n, 4096);
    for (let k = 0; k < m; k++, o += 2) CH[k] = b[o] | (b[o + 1] << 8);
    s += String.fromCharCode.apply(null, m === 4096 ? CH : CH.subarray(0, m));
    n -= m;
  }
  return s;
}
// 1바이트로 줄인 글자(BIFF8 압축 글 — 윗바이트가 0 인 UTF-16, 곧 Latin-1) n 개
function latin1(b, o, n) {
  let s = '';
  for (let i = 0; i < n; i += 4096) s += String.fromCharCode.apply(null, b.subarray(o + i, o + Math.min(n, i + 4096)));
  return s;
}

// RK(줄인 숫자): 정수 30비트 또는 실수의 윗 30비트, 맨 아래 비트가 서면 100 으로 나눈다
const RKV = new DataView(new ArrayBuffer(8));
function rkValue(v) {
  let x;
  if (v & 2) x = v >> 2;
  else { RKV.setUint32(0, 0, true); RKV.setUint32(4, v & 0xfffffffc, true); x = RKV.getFloat64(0, true); }
  return v & 1 ? x / 100 : x;
}

// ─── 레코드 읽기 ───
// 레코드 하나와 뒤따르는 CONTINUE 들의 자료 범위: [시작, 끝, 시작, 끝, …]
function gather(s, o) {
  const n = s.length, parts = [];
  for (let guard = 0; guard < 65536; guard++) {
    const len = s[o + 2] | (s[o + 3] << 8), d = o + 4;
    parts.push(Math.min(d, n), Math.min(d + len, n));
    o = d + len;
    if (o + 4 > n || (s[o] | (s[o + 1] << 8)) !== CONTINUE) break;
  }
  return parts;
}

// 조각(CONTINUE)으로 나뉜 자료 읽개. 글자가 조각 경계를 넘으면 새 조각의 첫 바이트가 다시 압축 표지(fHighByte)다.
function joined(s, parts) {
  let pi = 0, p = parts[0], end = parts[1];
  const next = () => {
    if (pi + 2 >= parts.length) { p = end; return false; }
    pi += 2;
    p = parts[pi];
    end = parts[pi + 1];
    return true;
  };
  const byte = () => {
    while (p >= end) if (!next()) return -1;
    return s[p++];
  };
  return {
    byte,
    u16: () => { const a = byte(), b = byte(); return b < 0 ? -1 : a | (b << 8); },
    i32: () => { let v = 0; for (let k = 0; k < 4; k++) { const b = byte(); if (b < 0) return 0; v |= b << (8 * k); } return v; },
    skip(n) {
      while (n > 0) {
        if (p >= end && !next()) return;
        const k = Math.min(n, end - p);
        p += k;
        n -= k;
      }
    },
    // 글자 cch 개(hi: 2바이트 글자인가)
    chars(cch, hi) {
      let out = '';
      while (cch > 0) {
        if (p >= end) {
          if (!next()) break;
          if (p < end) hi = s[p++] & 1;
          continue;
        }
        const k = Math.min(cch, hi ? (end - p) >> 1 : end - p);
        if (k <= 0) { p = end; continue; }
        out += hi ? utf16(s, p, k) : latin1(s, p, k);
        p += hi ? 2 * k : k;
        cch -= k;
      }
      return out;
    },
    // 날 바이트 n 개(BIFF5 8비트 글)
    raw(n) {
      const out = [];
      while (n > 0) {
        if (p >= end && !next()) break;
        const k = Math.min(n, end - p);
        out.push(s.subarray(p, p + k));
        p += k;
        n -= k;
      }
      if (out.length === 1) return out[0];
      const all = new Uint8Array(out.reduce((a, x) => a + x.length, 0));
      let at = 0;
      for (const x of out) { all.set(x, at); at += x.length; }
      return all;
    },
  };
}

// 공유 글 목록(SST): 글마다 cch(2) 표지(1) [런 수(2)] [읽는 법 길이(4)] 글자 [런] [읽는 법]
function readSst(s, parts) {
  const rd = joined(s, parts);
  rd.skip(8); // 전체 수·고유 수 — 수는 믿지 않고 자료가 다할 때까지 읽는다
  let total = 0;
  for (let i = 0; i < parts.length; i += 2) total += parts[i + 1] - parts[i];
  const out = [];
  for (let guard = Math.floor(total / 3) + 1; guard > 0; guard--) {
    const cch = rd.u16();
    const fl = rd.byte();
    if (cch < 0 || fl < 0) break;
    const runs = fl & 0x08 ? rd.u16() : 0;
    const ext = fl & 0x04 ? rd.i32() : 0;
    out.push(rd.chars(cch, fl & 1));
    if (runs > 0) rd.skip(runs * 4);
    if (ext > 0) rd.skip(ext);
  }
  return out;
}

// ─── 스트림 찾기 ───
// 웹 페이지(HTML)·XML 로 저장하고 이름만 .xls 인 파일
function isMarkup(u8) {
  let i = 0;
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) i = 3;
  else if ((u8[0] === 0xff && u8[1] === 0xfe) || (u8[0] === 0xfe && u8[1] === 0xff)) i = 2;
  for (const lim = Math.min(u8.length, 4096); i < lim; i++) {
    const c = u8[i];
    if (c === 0 || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    return c === 0x3c; // '<'
  }
  return false;
}

function workbookStream(u8) {
  if (!isCfb(u8)) {
    const t = u8.length >= 4 ? u8[0] | (u8[1] << 8) : -1;
    if (t === 0x0009 || t === 0x0209 || t === 0x0409) throw tooOld();
    if (t === BOF && u8.length >= 8) return { s: u8, book: (u8[4] | (u8[5] << 8)) === 0x0500 }; // 복합 문서 없이 스트림만 있는 파일
    if (isMarkup(u8)) throw fail('unsupported', '웹 페이지(HTML)·XML 꼴로 저장된 엑셀 파일이라 직접 읽을 수 없습니다');
    throw fail('broken', '엑셀 97~2003 문서(.xls)가 아닙니다');
  }
  let c;
  try {
    c = readCfb(u8);
  } catch {
    throw broken();
  }
  const paths = c.paths();
  const wb = paths.find((p) => p.toLowerCase() === 'workbook');
  const bk = paths.find((p) => p.toLowerCase() === 'book');
  if (!wb && !bk) {
    if (c.has('EncryptedPackage')) throw fail('password', '암호가 걸린 엑셀 문서입니다');
    throw fail('broken', '엑셀 문서의 본문(Workbook)을 찾지 못했습니다');
  }
  let s;
  try {
    s = c.read(wb || bk);
  } catch {
    throw broken();
  }
  if (!s || s.length < 8) throw broken();
  return { s, book: !wb };
}

// ─── 통합 문서 머리(전역 부분): 시트 목록·공유 글·서식·날짜 체계 ───
function readGlobals(s, book) {
  const n = s.length;
  const u16 = (o) => s[o] | (s[o + 1] << 8);
  const u32 = (o) => (s[o] | (s[o + 1] << 8) | (s[o + 2] << 16) | (s[o + 3] << 24)) >>> 0;
  const t0 = u16(0);
  if (t0 === 0x0009 || t0 === 0x0209 || t0 === 0x0409) throw tooOld();
  if (t0 !== BOF || u16(2) < 4) throw broken();
  const vers = u16(4);
  if (vers === 0x0200 || vers === 0x0300 || vers === 0x0400) throw tooOld();
  // 판: 0x0600 = BIFF8, 0x0500 = BIFF5/7. 판 번호가 엉뚱하면 스트림 이름(Workbook/Book)으로
  const biff8 = vers === 0x0600 || (vers !== 0x0500 && !book);
  let cp = biff8 ? 1200 : 1252, date1904 = false, sst = [], dec = null;
  const fmts = new Map(), xfs = [], bound = [];
  const pending = []; // BIFF5 8비트 글은 CODEPAGE 를 안 뒤에 푼다
  let o = 4 + u16(2);
  for (; o + 4 <= n; ) {
    const t = u16(o), len = u16(o + 2), d = o + 4;
    if (d + len > n) { o = n; break; }
    if (t === EOF) { o = d + len; break; }
    if (t === BOF) break; // 전역 부분 끝(EOF 빠짐) — 여기서부터 시트
    switch (t) {
      case FILEPASS:
        throw fail('password', '암호가 걸린 엑셀 문서입니다');
      case CODEPAGE:
        if (len >= 2) cp = u16(d);
        break;
      case DATEMODE:
        if (len >= 2) date1904 = u16(d) !== 0;
        break;
      case BOUNDSHEET: {
        if (len < 7) break;
        const b = { pos: u32(d), hs: s[d + 4] & 3, dt: s[d + 5], name: '' };
        const cch = s[d + 6];
        if (biff8) { if (len >= 8) b.name = joined(s, [d + 8, d + len]).chars(cch, s[d + 7] & 1); } else pending.push([b, 'name', s.subarray(d + 7, Math.min(d + 7 + cch, d + len))]);
        bound.push(b);
        break;
      }
      case FORMAT: {
        if (len < 3) break;
        const id = u16(d);
        if (biff8) {
          if (len < 5) break;
          fmts.set(id, joined(s, [d + 5, d + len]).chars(u16(d + 2), s[d + 4] & 1));
        } else {
          const f = { id };
          pending.push([f, 'code', s.subarray(d + 3, Math.min(d + 3 + s[d + 2], d + len))]);
          fmts.set(id, f);
        }
        break;
      }
      case XF:
        // 셀·스타일 XF 가 섞여 레코드 순서대로 번호가 붙는다. 셀 XF 는 '서식 씀' 표지(fAtrNum)가 꺼져 있어도
        // 자기 서식 번호를 쓴다(부모 스타일 것을 쓰지 않는다 — 정답 708칸으로 확인)
        if (len >= 4) xfs.push(u16(d + 2));
        break;
      case SST:
        if (biff8) sst = readSst(s, gather(s, o));
        break;
      default:
    }
    o = d + len;
  }
  if (!biff8) {
    dec = decoderFor(cp);
    const d8 = (b) => (dec ? dec.decode(b) : latin1(b, 0, b.length));
    for (const [obj, key, b] of pending) obj[key] = d8(b);
    for (const [id, f] of fmts) fmts.set(id, f.code);
  }
  // XF 번호 → 서식 글
  const codes = xfs.map((f) => fmts.get(f) ?? BUILTIN[f] ?? 'General');
  return { biff8, end: o, sst, codes, date1904, dec, bound };
}

// 그림 판(OfficeArt) 레코드에서 놓인 자리(ClientAnchor: 행·열) 찾기 — 글상자 순서용
function anchorIn(s, from, to, prev) {
  let found = prev;
  for (let p = from, guard = 0; p + 8 <= to && guard < 4096; guard++) {
    const vi = s[p] | (s[p + 1] << 8), type = s[p + 2] | (s[p + 3] << 8);
    const len = (s[p + 4] | (s[p + 5] << 8) | (s[p + 6] << 16) | (s[p + 7] << 24)) >>> 0;
    if ((vi & 0x0f) === 0x0f) { p += 8; continue; } // 그릇: 안으로
    if (type === 0xf010 && len >= 18 && p + 26 <= to) found = { r: s[p + 14] | (s[p + 15] << 8), c: s[p + 10] | (s[p + 11] << 8) };
    p += 8 + len;
  }
  return found;
}

// ─── 시트 한 장(부분 스트림) ───
// at: 시트 BOF 위치. G: 전역 정보, ctx: 셀 수·진행·일 한도
function readSheet(s, at, G, ctx, hiddenSheet) {
  const n = s.length;
  const u16 = (o) => s[o] | (s[o + 1] << 8);
  const u32 = (o) => (s[o] | (s[o + 1] << 8) | (s[o + 2] << 16) | (s[o + 3] << 24)) >>> 0;
  const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  const { biff8, sst, codes } = G;
  const fo = { date1904: G.date1904 };
  const d8 = (b) => (G.dec ? G.dec.decode(b) : latin1(b, 0, b.length));
  const cells = new Map(), hiddenRows = new Set(), hiddenCols = new Set(), merges = [], boxes = [];
  const rowSeen = new Set();
  const kind = u16(at + 2) >= 4 ? u16(at + 6) : 0x0010;
  let defHidden = false, dialog = false, hasText = false;

  const show = (v, ix) => {
    const code = ix < codes.length ? codes[ix] : 'General';
    // 숫자는 같은 XF·같은 값이 자주 되풀이된다(큰 표에서 25~97%) — 그린 글을 기억해 둔다
    const memo = typeof v === 'number' ? ctx.memo[ix] || (ctx.memo[ix] = new Map()) : null;
    if (memo) { const hit = memo.get(v); if (hit !== undefined) return hit; }
    let text;
    try {
      text = formatValue(v, code, fo);
    } catch {
      text = typeof v === 'object' && v ? v.error || '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
    }
    if (memo && ctx.memoN < MEMO_MAX) { memo.set(v, text); ctx.memoN++; }
    return text;
  };
  let lastR = -1, lastRow = null;
  const put = (r, c, ix, v) => {
    if (c > MAX_COL) return;
    // 모델로 만들 때: 숨긴 시트는 '내용 있음'(빈칸 아닌 글 하나)만 알면 되고, 보이는 칸은 모델이 쓰는 만큼만 서식을 입힌다
    if (ctx.limit && (hiddenSheet ? hasText : ctx.vis >= VIS_CAP || ctx.cells >= ctx.limit)) return;
    const text = show(v, ix);
    if (text === '') return;
    if (r !== lastR) {
      lastRow = cells.get(r);
      if (!lastRow) { lastRow = new Map(); cells.set(r, lastRow); }
      lastR = r;
    }
    if (!lastRow.has(c)) {
      ctx.cells++;
      if (ctx.limit && /\S/.test(text)) {
        hasText = true;
        if (!hiddenRows.has(r) && !hiddenCols.has(c)) ctx.vis++;
      }
    }
    lastRow.set(c, text);
  };
  // 셀에 든 글(LABEL·RSTRING·STRING): BIFF8 은 cch(2)+표지(1)+글자, BIFF5 는 cch(2)+8비트 바이트
  const cellText = (parts) => {
    const rd = joined(s, parts);
    const cch = rd.u16();
    if (cch < 0) return '';
    if (!biff8) return d8(rd.raw(cch));
    const fl = rd.byte();
    return fl < 0 ? '' : rd.chars(cch, fl & 1);
  };

  let o = at + 4 + u16(at + 2);
  let depth = 0, lastOt = -1, anchor = null, pend = null;
  while (o + 4 <= n) {
    const t = u16(o), len = u16(o + 2), d = o + 4;
    if (d + len > n) break; // 잘린 레코드
    ctx.work += 4 + len;
    if (ctx.work > ctx.maxWork) break;
    if ((++ctx.recs & 0x3fff) === 0 && ctx.progress) ctx.progress(o / n);
    if (t === BOF) {
      // 시트 안에 끼운 차트는 건너뛴다. 차트가 아닌 BOF 는 다음 시트(EOF 가 빠진 경우)
      if (depth === 0 && !(len >= 4 && u16(d + 2) === DT_CHART)) break;
      depth++;
    } else if (t === EOF) {
      if (depth === 0) { o = d + len; break; }
      depth--;
    } else if (depth === 0) {
      switch (t) {
        case LABELSST:
          if (len >= 10) { const v = sst[u32(d + 6)]; if (v) put(u16(d), u16(d + 2), u16(d + 4), v); }
          break;
        case NUMBER:
          if (len >= 14) put(u16(d), u16(d + 2), u16(d + 4), dv.getFloat64(d + 6, true));
          break;
        case RK:
          if (len >= 10) put(u16(d), u16(d + 2), u16(d + 4), rkValue(u32(d + 6)));
          break;
        case MULRK: {
          if (len < 12) break;
          const r = u16(d);
          let c = u16(d + 2);
          for (let p = d + 4; p + 6 <= d + len - 2; p += 6, c++) put(r, c, u16(p), rkValue(u32(p + 2)));
          break;
        }
        case FORMULA: {
          if (len < 16) break;
          const r = u16(d), c = u16(d + 2), ix = u16(d + 4);
          pend = null;
          if (u16(d + 12) === 0xffff) {
            const k = s[d + 6];
            if (k === 0) pend = { r, c, ix }; // 글 결과는 뒤따르는 STRING 레코드에
            else if (k === 1) put(r, c, ix, s[d + 8] !== 0);
            else if (k === 2) put(r, c, ix, { error: ERRORS[s[d + 8]] || '#N/A' });
            // 3: 빈 글
          } else put(r, c, ix, dv.getFloat64(d + 6, true));
          break;
        }
        case STRING:
          if (pend) { const v = cellText(gather(s, o)); if (v) put(pend.r, pend.c, pend.ix, v); pend = null; }
          break;
        case BOOLERR:
          if (len >= 8) put(u16(d), u16(d + 2), u16(d + 4), s[d + 7] ? { error: ERRORS[s[d + 6]] || '#N/A' } : s[d + 6] !== 0);
          break;
        case LABEL:
        case RSTRING:
          if (len >= 8) { const v = cellText([d + 6, d + len]); if (v) put(u16(d), u16(d + 2), u16(d + 4), v); }
          break;
        case ROW:
          if (len >= 14) {
            const r = u16(d);
            rowSeen.add(r);
            if (u16(d + 12) & 0x20) hiddenRows.add(r); // fDyZero: 숨김(높이 0)
          }
          break;
        case COLINFO:
          if (len >= 10 && u16(d + 8) & 1) {
            const c0 = u16(d), c1 = Math.min(u16(d + 2), MAX_COL);
            for (let c = c0; c <= c1; c++) hiddenCols.add(c);
          }
          break;
        case DEFROWHEIGHT:
          if (len >= 2) defHidden = (u16(d) & 2) !== 0; // 행 기록이 없는 줄은 숨김
          break;
        case WSBOOL:
          if (len >= 1 && s[d] & 0x10) dialog = true; // 옛 대화 상자 시트
          break;
        case MERGEDCELLS: {
          if (len < 2) break;
          const k = u16(d);
          for (let i = 0, p = d + 2; i < k && p + 8 <= d + len; i++, p += 8) {
            const r0 = u16(p), r1 = u16(p + 2), c0 = u16(p + 4), c1 = Math.min(u16(p + 6), MAX_COL);
            if (r1 >= r0 && c1 >= c0) merges.push({ r0, c0, r1, c1 });
          }
          break;
        }
        case MSODRAWING:
          anchor = anchorIn(s, d, d + len, anchor);
          break;
        case OBJ:
          // BIFF8: ftCmo(ft 2, cb 2) 다음 종류, BIFF5: 개체 수(4) 다음 종류 — 둘 다 4번째 바이트부터
          lastOt = len >= 6 ? u16(d + 4) : -1;
          break;
        case TXO: {
          // 글상자 글(BIFF8 만 — BIFF5 는 글을 OBJ 안에 두는데 그 꼴은 다루지 않는다)
          if (len < 14 || !biff8) break;
          let need = u16(d + 10), txt = '';
          // 글은 뒤따르는 CONTINUE 에, 조각마다 첫 바이트가 압축 표지
          for (let q = d + len, guard = 0; need > 0 && q + 4 <= n && u16(q) === CONTINUE && guard < 1024; guard++) {
            const cl = u16(q + 2), cd = q + 4, ce = Math.min(cd + cl, n);
            if (ce > cd) {
              const hi = s[cd] & 1;
              const k = Math.min(need, hi ? (ce - cd - 1) >> 1 : ce - cd - 1);
              if (k > 0) { txt += hi ? utf16(s, cd + 1, k) : latin1(s, cd + 1, k); need -= k; }
            }
            q = cd + cl;
          }
          if (txt.trim() && !NOT_TEXTBOX.has(lastOt)) boxes.push({ r: anchor ? anchor.r : 0, c: anchor ? anchor.c : 0, i: boxes.length, t: txt });
          lastOt = -1;
          break;
        }
        default:
      }
    }
    o = d + len;
  }
  if (defHidden) for (const r of cells.keys()) if (!rowSeen.has(r)) hiddenRows.add(r);
  boxes.sort((a, b) => a.r - b.r || a.c - b.c || a.i - b.i);
  return { next: o, kind, dialog, data: { cells, merges: tidyMerges(merges, cells), hiddenRows, hiddenCols, extras: boxes.map((b) => b.t) } };
}

// 합친 칸 한도 지키기(BIG_MERGE·MERGE_BUDGET) — 글이 있는 범위 밖은 모델에 아무 영향이 없으므로 줄여도 결과는 같다
function tidyMerges(merges, cells) {
  const area = (m) => (m.r1 - m.r0 + 1) * (m.c1 - m.c0 + 1);
  let box = null;
  const out = [];
  let sum = 0;
  for (let m of merges) {
    if (area(m) > BIG_MERGE) {
      if (!box) {
        box = { r0: Infinity, r1: -1, c0: Infinity, c1: -1 };
        for (const [r, row] of cells) {
          if (r < box.r0) box.r0 = r;
          if (r > box.r1) box.r1 = r;
          for (const c of row.keys()) { if (c < box.c0) box.c0 = c; if (c > box.c1) box.c1 = c; }
        }
      }
      m = { r0: Math.max(m.r0, box.r0), c0: Math.max(m.c0, box.c0), r1: Math.min(m.r1, box.r1), c1: Math.min(m.c1, box.c1) };
      if (m.r1 < m.r0 || m.c1 < m.c0) continue;
    }
    sum += area(m);
    if (sum > MERGE_BUDGET) break;
    out.push(m);
  }
  return out;
}

// 부분 스트림 하나 건너뛰기(안에 낀 BOF~EOF 짝 포함) → 다음 위치
function skipSub(s, at, ctx) {
  const n = s.length;
  let o = at + 4 + (s[at + 2] | (s[at + 3] << 8)), depth = 0;
  while (o + 4 <= n) {
    const t = s[o] | (s[o + 1] << 8), len = s[o + 2] | (s[o + 3] << 8);
    ctx.work += 4 + len;
    if (ctx.work > ctx.maxWork) return n;
    if (t === BOF) {
      if (depth === 0 && !(len >= 4 && (s[o + 6] | (s[o + 7] << 8)) === DT_CHART)) return o;
      depth++;
    } else if (t === EOF) {
      if (depth === 0) return o + 4 + len;
      depth--;
    }
    o += 4 + len;
  }
  return n;
}

// sheetsOnly: 시험용 — 문서 모델 대신 시트 자료(셀 지도)를 돌려준다
export function parseXls(bytes, { onProgress, sheetsOnly = false } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const { s, book } = workbookStream(u8);
  const G = readGlobals(s, book);
  const n = s.length;
  const ctx = {
    cells: 0, vis: 0, limit: sheetsOnly ? 0 : KEEP_CELLS, recs: 0, work: 0, maxWork: n * 3 + (1 << 20), memo: [], memoN: 0,
    progress: onProgress ? (v) => onProgress(Math.min(0.99, Math.max(0, v))) : null,
  };
  const isBof = (p) => p >= G.end && p + 8 <= n && (s[p] | (s[p + 1] << 8)) === BOF;
  // 시트 이름표(BOUNDSHEET)의 위치가 맞으면 그곳을, 틀리면 전역 부분 뒤에 나오는 차례대로
  let list = G.bound;
  const lost = list.filter((b) => !isBof(b.pos));
  if (lost.length || !list.length) {
    const used = new Set(list.filter((b) => isBof(b.pos)).map((b) => b.pos));
    const free = [];
    for (let o = G.end; o + 4 <= n && ctx.work <= ctx.maxWork; ) {
      const len = s[o + 2] | (s[o + 3] << 8);
      if ((s[o] | (s[o + 1] << 8)) !== BOF) { ctx.work += 4 + len; o += 4 + len; continue; }
      if (!used.has(o)) free.push(o);
      o = skipSub(s, o, ctx);
    }
    ctx.work = 0;
    if (!list.length) list = free.map((pos, i) => ({ pos, hs: 0, dt: 0, name: `시트${i + 1}` }));
    else lost.forEach((b, i) => { b.pos = i < free.length ? free[i] : -1; });
  }
  const done = new Map();
  const sheets = [];
  list.forEach((b, i) => {
    if (b.dt !== 0) return; // 차트·매크로·VBA 시트
    let r = null;
    if (isBof(b.pos)) {
      r = done.get(b.pos);
      if (!r) { r = readSheet(s, b.pos, G, ctx, b.hs !== 0); done.set(b.pos, r); }
      if (r.kind === DT_CHART || r.kind === DT_MACRO || r.kind === DT_VB || r.dialog) return;
    }
    const data = r ? r.data : { cells: new Map(), merges: [], hiddenRows: new Set(), hiddenCols: new Set(), extras: [] };
    sheets.push({ name: b.name || `시트${i + 1}`, hidden: b.hs !== 0, ...data });
  });
  if (onProgress) onProgress(1);
  if (sheetsOnly) return { sheets, date1904: G.date1904 };
  return sheetsToModel('xls', sheets);
}
