// 파워포인트 97~2003(.ppt·.pps) 읽기 — 복합 문서 속 'PowerPoint Document' 스트림의 레코드를 따라가 슬라이드마다 도형 글·표를 모은다.
// Current User → 마지막 편집(UserEditAtom) → 편집 사슬의 persist 목록(새 편집이 이김) → 문서 → 슬라이드 목록 → 슬라이드 그림판(OfficeArt) 도형.
// 자리표시자 글은 슬라이드 목록 쪽에 있을 수 있다(OutlineTextRefAtom). 글머리는 문단 속성 → 마스터 글 꼴(TextMasterStyleAtom) 차례로,
// 자동 번호는 ___PPT9 꼬리표(StyleTextProp9Atom)에서 정한다. 표는 칸마다 도형인 묶음이라 칸 자리로 행·열을 세운다.
// 파워포인트 2007 이후가 저장한 파일은 도형마다 OOXML 사본(metroBlob)을 덧붙이는데, 이진 쪽이 그림으로 대신 저장된 도형(효과 넣은 글상자·
// 스마트아트 등)은 글이 그 사본에만 있어 거기서 꺼낸다. 메모(노트)·마스터의 글은 넣지 않는다.
// 망가진 파일도 들어올 수 있으니 모든 위치·길이를 확인하고, 되풀이에는 한도를 둔다.
import { unzipSync, strFromU8 } from '../../vendor/fflate.mjs';
import { readCfb, isCfb } from './cfb.js';
import { parseXml, kids, kid, attr, descendants } from './xml.js';
import { slidesToModel, autoNumber } from './slides.js';
import { symbolChar, isSymbolFont, fixSymbolText } from './symbols.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const MSG_BROKEN = '파워포인트 문서를 읽지 못했습니다(손상된 파일일 수 있습니다)';
const MSG_PASSWORD = '암호가 걸린 파워포인트 문서입니다';
const MSG_OLD = '파워포인트 95 이전 형식이라 읽을 수 없습니다';
const broken = () => fail('broken', MSG_BROKEN);
const SOFT_BREAK = '\u2028'; // 문단 안 줄바꿈

// 레코드 종류
const RT = {
  Document: 0x03e8, DocumentAtom: 0x03e9, Slide: 0x03ee, SlideAtom: 0x03ef, Environment: 0x03f2, SlidePersist: 0x03f3,
  MainMaster: 0x03f8, SlideShowInfo: 0x03f9, Drawing: 0x040c, List: 0x07d0, FontCollection: 0x07d5, FontEntity: 0x0fb7,
  Placeholder: 0x0bc3, HFPlaceholder12: 0x0420, OutlineTextRef: 0x0f9e, TextHeader: 0x0f9f, TextChars: 0x0fa0, StyleTextProp: 0x0fa1,
  MasterStyle: 0x0fa3, CFDefaults: 0x0fa4, PFDefaults: 0x0fa5, TextBytes: 0x0fa8, StyleTextProp9: 0x0fac, OutlineTextProps9: 0x0fae,
  OutlineTextPropsHeader9: 0x0faf, CString: 0x0fba, SlideNumberMC: 0x0fd8, HeadersFooters: 0x0fd9, HFAtom: 0x0fda, SlideList: 0x0ff0,
  UserEdit: 0x0ff5, DateTimeMC: 0x0ff7, GenericDateMC: 0x0ff8, HeaderMC: 0x0ff9, FooterMC: 0x0ffa, RtfDateTimeMC: 0x1015,
  ProgTags: 0x1388, ProgBinaryTag: 0x138a, BinaryTagData: 0x138b, PersistDir: 0x1772, CryptSession: 0x2f14,
  // OfficeArt(그림판)
  DgContainer: 0xf002, SpgrContainer: 0xf003, SpContainer: 0xf004, FSPGR: 0xf009, FSP: 0xf00a, FOPT: 0xf00b,
  ClientTextbox: 0xf00d, ChildAnchor: 0xf00f, ClientAnchor: 0xf010, ClientData: 0xf011, SecFOPT: 0xf121, TerFOPT: 0xf122,
};

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

// 레코드 머리(8바이트): 판(ver)·종류 번호(inst)·종류(type)·길이 — 범위를 벗어나면 null
function hdr(D, o, end = D.n) {
  if (!(o >= 0) || o + 8 > end) return null;
  const vi = D.r.u16(o), len = D.r.u32(o + 4);
  return { o, ver: vi & 15, inst: vi >> 4, type: D.r.u16(o + 2), len, body: o + 8, end: Math.min(end, o + 8 + len) };
}

// 컨테이너 속 레코드들(일 한도를 넘으면 망가진 파일로 본다)
function kidsOf(D, h) {
  const out = [];
  if (!h) return out;
  for (let o = h.body; o + 8 <= h.end;) {
    const c = hdr(D, o, h.end);
    if (++D.work > D.budget) throw broken();
    out.push(c);
    o = c.body + c.len;
  }
  return out;
}
const kidOf = (D, h, type) => kidsOf(D, h).find((c) => c.type === type) || null;

// 글자 꺼내기
let u16dec = null;
function utf16(D, h) {
  const n = Math.max(0, h.end - h.body) & ~1;
  if (!u16dec) u16dec = new TextDecoder('utf-16le');
  return u16dec.decode(D.r.b.subarray(h.body, h.body + n));
}
// TextBytesAtom: 유니코드(UTF-16)의 아래 바이트만 적은 것
function bytes8(D, h) {
  let s = '';
  const b = D.r.b;
  for (let i = h.body; i < h.end; i += 4096) s += String.fromCharCode.apply(null, b.subarray(i, Math.min(h.end, i + 4096)));
  return s;
}

// ─── 열기: Current User → 마지막 편집 → persist 목록 ───
function openPpt(u8) {
  let cfb;
  try { cfb = readCfb(u8); } catch { throw broken(); }
  // 95·97 겸용 저장이면 안쪽(97 판)을 읽는다
  const pre = cfb.has('PP97_DUALSTORAGE/PowerPoint Document') ? 'PP97_DUALSTORAGE/' : '';
  const doc = cfb.read(pre + 'PowerPoint Document');
  if (!doc || doc.length < 8) {
    if (cfb.paths().some((p) => /(^|\/)PP40$/.test(p))) throw fail('unsupported', MSG_OLD);
    throw broken();
  }
  if (cfb.has(pre + 'EncryptedSummary')) throw fail('password', MSG_PASSWORD);
  const D = {
    r: rd(doc), n: doc.length, work: 0, budget: 2e6 + doc.length,
    fonts: [], envStyles: new Map(), masters: new Map(), masterList: [], slideList: [], outline9: new Map(), firstNum: 1, slideHF: null, missing: 0,
  };
  const cu = cfb.read(pre + 'Current User');
  let editOff = -1, old = false;
  if (cu && cu.length >= 28) {
    const c = rd(cu);
    if (c.u32(12) === 0xf3d1c4df) throw fail('password', MSG_PASSWORD); // 암호 걸린 문서 표시
    editOff = c.u32(16);
    if (c.u8(24) && c.u8(24) < 3) old = true;
  } else if (cu && cu.length >= 4 && rd(cu).u32(0) + 4 === cu.length) old = true; // 파워포인트 95: 길이(4바이트) + 자료
  let ue = userEditAt(D, editOff);
  if (!ue) {
    // Current User 가 틀렸으면 맨 위 레코드를 훑어 마지막 편집을 찾는다
    for (const h of topRecords(D)) if (h.type === RT.UserEdit && h.len >= 28) ue = h;
  }
  if (!ue) throw old ? fail('unsupported', MSG_OLD) : broken();
  readPersist(D, ue);
  return D;
}

function userEditAt(D, o) {
  const h = hdr(D, o);
  return h && h.type === RT.UserEdit && h.len >= 28 && h.body + 28 <= D.n ? h : null;
}

// 스트림 맨 위 레코드들(차례대로)
function topRecords(D) {
  const out = [];
  for (let o = 0; o + 8 <= D.n;) {
    const h = hdr(D, o);
    if (++D.work > D.budget) throw broken();
    out.push(h);
    o = h.body + h.len;
  }
  return out;
}

// 편집 사슬을 거슬러 가며 persist 번호 → 위치(새 편집이 먼저 적은 것이 이김)
function readPersist(D, ue) {
  const r = D.r;
  const map = new Map();
  const seenEdit = new Set(), seenDir = new Set();
  D.docRef = r.u32(ue.body + 16);
  const encRef = ue.len >= 32 ? r.u32(ue.body + 28) : 0;
  for (let h = ue, k = 0; h && k < 10000 && !seenEdit.has(h.o); k++) {
    seenEdit.add(h.o);
    const dirOff = r.u32(h.body + 12);
    const pd = seenDir.has(dirOff) ? null : hdr(D, dirOff);
    seenDir.add(dirOff);
    if (pd && pd.type === RT.PersistDir) {
      for (let p = pd.body; p + 4 <= pd.end;) {
        const x = r.u32(p);
        const id = x & 0xfffff, cnt = x >>> 20;
        p += 4;
        for (let i = 0; i < cnt && p + 4 <= pd.end; i++, p += 4) {
          if (++D.work > D.budget) throw broken();
          if (!map.has(id + i)) map.set(id + i, r.u32(p));
        }
      }
    }
    const last = r.u32(h.body + 8);
    h = last ? userEditAt(D, last) : null;
  }
  D.persist = map;
  // 암호: 편집 기록이 암호 세션(CryptSession10Container)을 가리킨다
  if (encRef && map.has(encRef)) { const c = hdr(D, map.get(encRef)); if (c && c.type === RT.CryptSession) throw fail('password', MSG_PASSWORD); }
}

const atPersist = (D, id, types) => {
  if (!D.persist.has(id)) return null;
  const h = hdr(D, D.persist.get(id));
  return h && types.includes(h.type) ? h : null;
};

// ─── 문서(DocumentContainer) ───
function readDocument(D) {
  let doc = atPersist(D, D.docRef, [RT.Document]);
  if (!doc) for (const h of topRecords(D)) if (h.type === RT.Document) doc = h; // persist 목록이 틀렸을 때
  if (!doc) throw broken();
  const r = D.r;
  for (const c of kidsOf(D, doc)) {
    if (c.type === RT.DocumentAtom) D.firstNum = r.u16(c.body + 32) || 1;
    else if (c.type === RT.Environment) readEnvironment(D, c);
    else if (c.type === RT.SlideList && c.inst === 0) D.slideList = slideList(D, c);
    else if (c.type === RT.SlideList && c.inst === 1) D.masterList = slideList(D, c);
    else if (c.type === RT.HeadersFooters && c.inst === 3) D.slideHF = readHF(D, c);
    else if (c.type === RT.List) {
      // 문서 꼬리표 ___PPT9: 슬라이드 목록 쪽 글(자리표시자)의 자동 번호
      const tag = binaryTag(D, kidOf(D, c, RT.ProgTags), '___PPT9');
      const otp = tag && kidOf(D, tag, RT.OutlineTextProps9);
      let key = null;
      for (const k of kidsOf(D, otp)) {
        if (k.type === RT.OutlineTextPropsHeader9) key = r.u32(k.body) + ':' + r.u32(k.body + 4);
        else if (k.type === RT.StyleTextProp9 && key) { D.outline9.set(key, readStyle9(D, k)); key = null; }
      }
    }
  }
}

function readEnvironment(D, h) {
  for (const c of kidsOf(D, h)) {
    if (c.type === RT.FontCollection) {
      for (const f of kidsOf(D, c)) if (f.type === RT.FontEntity) D.fonts[f.inst] = faceName(D, f);
    } else if (c.type === RT.MasterStyle) D.envStyles.set(c.inst, readMasterStyle(D, c));
    else if (c.type === RT.PFDefaults) D.defPF = readPF(D.r, c.body + 2, c.end);
    else if (c.type === RT.CFDefaults) D.defCF = readCF(D.r, c.body, c.end);
  }
}

function faceName(D, h) {
  const s = utf16(D, { body: h.body, end: Math.min(h.end, h.body + 64) });
  const z = s.indexOf('\0');
  return z >= 0 ? s.slice(0, z) : s;
}

// 슬라이드 목록(SlideListWithText): 슬라이드마다 persist 번호·슬라이드 번호와 바깥 글(자리표시자 글) 묶음
function slideList(D, h) {
  const out = [];
  let cur = null, txt = null;
  for (const c of kidsOf(D, h)) {
    if (c.type === RT.SlidePersist) {
      cur = { persist: D.r.u32(c.body), id: D.r.u32(c.body + 12), texts: [] };
      out.push(cur);
      txt = null;
    } else if (!cur) continue;
    else if (c.type === RT.TextHeader) { txt = [c]; cur.texts.push(txt); }
    else if (txt) txt.push(c);
  }
  return out;
}

// 머리글·바닥글 설정(HeadersFootersContainer)
function readHF(D, h) {
  const hf = { flags: 0, userDate: '', header: '', footer: '' };
  for (const c of kidsOf(D, h)) {
    if (c.type === RT.HFAtom) hf.flags = D.r.u16(c.body + 2);
    else if (c.type === RT.CString) {
      const s = utf16(D, c);
      if (c.inst === 0) hf.userDate = s;
      else if (c.inst === 1) hf.header = s;
      else if (c.inst === 2) hf.footer = s;
    }
  }
  return hf;
}

// 꼬리표 묶음(ProgTags)에서 이름이 맞는 이진 꼬리표의 자료(BinaryTagDataBlob)
function binaryTag(D, tags, name) {
  for (const t of kidsOf(D, tags)) {
    if (t.type !== RT.ProgBinaryTag) continue;
    const ks = kidsOf(D, t);
    const nm = ks.find((k) => k.type === RT.CString);
    if (nm && utf16(D, nm) === name) return ks.find((k) => k.type === RT.BinaryTagData) || null;
  }
  return null;
}

// ─── 마스터: 글 종류별 단계마다 문단·글자 속성 ───
function masterOf(D, id) {
  if (D.masters.has(id)) return D.masters.get(id);
  D.masters.set(id, null); // 고리 막기
  const ent = D.masterList.find((e) => e.id === id);
  const h = ent && atPersist(D, ent.persist, [RT.MainMaster, RT.Slide]);
  if (!h) return null;
  const m = { styles: new Map(), parent: null, memo: new Map() };
  let parentId = 0;
  for (const c of kidsOf(D, h)) {
    if (c.type === RT.MasterStyle) m.styles.set(c.inst, readMasterStyle(D, c));
    else if (c.type === RT.SlideAtom && h.type === RT.Slide) parentId = D.r.u32(c.body + 12); // 제목 마스터 → 본 마스터
  }
  if (parentId && parentId !== id) m.parent = masterOf(D, parentId);
  D.masters.set(id, m);
  return m;
}

function readMasterStyle(D, h) {
  const r = D.r;
  const n = Math.min(5, r.u16(h.body));
  const lv = [];
  let o = h.body + 2;
  for (let i = 0; i < n; i++) {
    let level = i;
    if (h.inst >= 5) { level = r.u16(o); o += 2; } // 가운데 본문·제목 등은 단계 번호가 앞에 붙는다
    const pf = readPF(r, o, h.end);
    if (!pf) break;
    const cf = readCF(r, pf.next, h.end);
    if (!cf) break;
    o = cf.next;
    if (level < 5 && !lv[level]) lv[level] = { pf, cf };
  }
  return lv;
}

// 문단 속성(TextPFException) — 글머리 값만 꺼내고 나머지는 길이만큼 건너뛴다
function readPF(r, o, end) {
  if (o + 4 > end) return null;
  const m = r.u32(o);
  o += 4;
  const pf = { m, flags: 0, ch: 0, font: 0, next: 0 };
  if (m & 0x000f) { pf.flags = r.u16(o); o += 2; }
  if (m & 0x0080) { pf.ch = r.u16(o); o += 2; }
  if (m & 0x0010) { pf.font = r.u16(o); o += 2; }
  if (m & 0x0040) o += 2; // 글머리 크기
  if (m & 0x0020) o += 4; // 글머리 색
  if (m & 0x0800) o += 2; // 맞춤
  if (m & 0x1000) o += 2; // 줄 간격
  if (m & 0x2000) o += 2; // 문단 앞
  if (m & 0x4000) o += 2; // 문단 뒤
  if (m & 0x0100) o += 2; // 왼쪽 여백
  if (m & 0x0400) o += 2; // 들여쓰기
  if (m & 0x8000) o += 2; // 기본 탭
  if (m & 0x100000) o += 2 + 4 * r.u16(o); // 탭 위치들
  if (m & 0x10000) o += 2; // 글꼴 맞춤
  if (m & 0xe0000) o += 2; // 줄 바꿈 방식
  if (m & 0x200000) o += 2; // 글 방향
  if (o > end) return null;
  pf.next = o;
  return pf;
}

// 글자 속성(TextCFException) — 글꼴 번호와 꼴 값(자동 번호 묶음 번호 pp9rt 가 들어 있다)만 꺼낸다
function readCF(r, o, end) {
  if (o + 4 > end) return null;
  const m = r.u32(o);
  o += 4;
  const cf = { m, style: 0, font: -1, sym: -1, next: 0 };
  if (m & 0xffff) { cf.style = r.u16(o); o += 2; }
  if (m & 0x10000) { cf.font = r.u16(o); o += 2; }
  if (m & 0x200000) o += 2; // 옛 동아시아 글꼴
  if (m & 0x400000) o += 2; // ANSI 글꼴
  if (m & 0x800000) { cf.sym = r.u16(o); o += 2; }
  if (m & 0x20000) o += 2; // 크기
  if (m & 0x40000) o += 4; // 색
  if (m & 0x80000) o += 2; // 위·아래 첨자
  if (o > end) return null;
  cf.next = o;
  return cf;
}

// StyleTextProp9Atom: [문단(PF9)·글자(CF9)·언어(SI)] 묶음들 — 자동 번호(bulletAutoNumberScheme)만 꺼낸다
function readStyle9(D, h) {
  const r = D.r;
  const out = [];
  for (let o = h.body; o + 12 <= h.end && out.length < 4096;) {
    const m = r.u32(o);
    o += 4;
    const e = { auto: false, scheme: 3, start: 1 };
    if (m & 0x800000) o += 2; // 그림 글머리
    if (m & 0x2000000) { e.auto = r.u16(o) !== 0; o += 2; }
    if (m & 0x1000000) { e.scheme = r.u16(o); e.start = r.i16(o + 2) || 1; o += 4; }
    const cm = r.u32(o);
    o += 4;
    if (cm & 0x100000) o += 4; // pp10runid
    const sm = r.u32(o);
    o += 4;
    if (sm & 0x1) o += 2; // 맞춤법
    if (sm & 0x2) o += 2; // 언어
    if (sm & 0x4) o += 2; // 다른 언어
    if (sm & 0x40) o += 2; // 양방향
    if (sm & 0x20) o += 4; // pp10 확장
    if (sm & 0x200) o += 4 + 4 * Math.min(r.u32(o), 1e6); // 스마트 태그
    if (o > h.end) break;
    out.push(e);
  }
  return out;
}

// 자동 번호 종류(TextAutoNumberSchemeEnum) → slides.js 의 autoNumber 이름
const ANM = ['alphaLcPeriod', 'alphaUcPeriod', 'arabicParenR', 'arabicPeriod', 'romanLcParenBoth', 'romanLcParenR', 'romanLcPeriod', 'romanUcPeriod',
  'alphaLcParenBoth', 'alphaLcParenR', 'alphaUcParenBoth', 'alphaUcParenR', 'arabicParenBoth', 'arabicPlain', 'romanUcParenBoth', 'romanUcParenR',
  'ea1ChsPlain', 'ea1ChsPeriod', 'circleNumDbPlain', 'circleNumWdWhitePlain', 'circleNumWdBlackPlain', 'ea1ChtPlain', 'ea1ChtPeriod',
  'arabic1Minus', 'arabic2Minus', 'hebrew2Minus', 'ea1JpnKorPlain', 'ea1JpnKorPeriod', 'arabicDbPlain', 'arabicDbPeriod',
  'thaiAlphaPeriod', 'thaiAlphaParenR', 'thaiAlphaParenBoth', 'thaiNumPeriod', 'thaiNumParenR', 'thaiNumParenBoth',
  'hindiAlphaPeriod', 'hindiNumPeriod', 'ea1JpnChsDbPeriod', 'hindiNumParenR', 'hindiAlpha1Period'];

// 글 꼴 줄기: 문단(PF)·글자(CF) 띠 — 각 띠는 글자 수(count)만큼 덮는다. 문단 띠에는 단계(lvl)
function styleRuns(D, h, nChars) {
  const r = D.r;
  const pfs = [], cfs = [];
  let o = h.body, total = 0;
  while (total < nChars && o + 6 <= h.end) {
    const count = r.u32(o), lvl = r.u16(o + 4);
    const pf = readPF(r, o + 6, h.end);
    if (!pf) break;
    pfs.push({ start: total, end: total + count, lvl, pf });
    total += count;
    o = pf.next;
  }
  total = 0;
  while (total < nChars && o + 4 <= h.end) {
    const count = r.u32(o);
    const cf = readCF(r, o + 4, h.end);
    if (!cf) break;
    cfs.push({ start: total, end: total + count, cf });
    total += count;
    o = cf.next;
  }
  return { pfs, cfs };
}

// 띠 목록에서 위치 at 을 덮는 것(앞에서부터 차례로 찾으므로 손가락 k 를 넘겨받는다)
function runAt(runs, at, k) {
  while (k.i < runs.length && runs[k.i].end <= at) k.i++;
  return k.i < runs.length && runs[k.i].start <= at ? runs[k.i] : null;
}

// 마스터 글 꼴 줄기(이 글 종류·단계): 가까운 것부터 [{ pf, cf }]
// 한 글 꼴 안에서 아래 단계는 바로 위 단계와 다른 값만 적는다(단계 L → L-1 → … → 0).
// 가운데·절반·4분의 1 본문(5·7·8)과 가운데 제목(6)은 같은 단계의 본문·제목과 다른 값만 적는다.
function masterChain(D, m, type, lvl) {
  const key = type * 8 + lvl;
  if (m && m.memo.has(key)) return m.memo.get(key);
  const out = [];
  const push = (lv, t) => {
    if (t >= 5) { if (lv[lvl]) out.push(lv[lvl]); return; }
    for (let k = Math.min(lvl, lv.length - 1); k >= 0; k--) if (lv[k]) out.push(lv[k]);
  };
  const add = (t) => {
    for (let x = m, k = 0; x && k < 8; x = x.parent, k++) {
      const lv = x.styles.get(t);
      if (lv) { push(lv, t); return; }
    }
    const lv = D.envStyles.get(t);
    if (lv) push(lv, t);
  };
  add(type);
  if (type === 5 || type === 7 || type === 8) add(1); // 가운데·절반·4분의 1 본문 → 본문
  else if (type === 6) add(0); // 가운데 제목 → 제목
  if (D.defPF || D.defCF) out.push({ pf: D.defPF, cf: D.defCF });
  if (m) m.memo.set(key, out);
  return out;
}

const firstOf = (list, bit, get) => {
  for (const p of list) if (p && (p.m & bit)) return get(p);
  return undefined;
};

// 기호 글꼴(Wingdings·Symbol) 글머리 → 보통 글자
function bulletText(code, font) {
  if (!code) return '•';
  if ((code >= 0xf000 && code <= 0xf0ff) || (isSymbolFont(font) && code < 0x100)) return symbolChar(code, font);
  return String.fromCharCode(code);
}

// 글꼴 이름: 글자 속성 → 마스터 줄기. 기호 글꼴 글자 번호가 따로 있으면 그것도 본다
function fontName(D, cfs) {
  const ref = firstOf(cfs, 0x10000, (c) => c.font);
  const name = ref != null ? D.fonts[ref] || '' : '';
  if (!isSymbolFont(name)) {
    const sym = firstOf(cfs, 0x800000, (c) => c.sym);
    if (sym != null && isSymbolFont(D.fonts[sym])) return D.fonts[sym];
  }
  return name;
}

// 마스터 줄기에서 정한 글머리 글자(없으면 null)
function masterBullet(D, pfs, textFont) {
  if (!firstOf(pfs, 0x1, (p) => p.flags & 1)) return null;
  const code = firstOf(pfs, 0x80, (p) => p.ch) || 0;
  const font = firstOf(pfs, 0x2, (p) => p.flags & 2) ? D.fonts[firstOf(pfs, 0x10, (p) => p.font) ?? -1] || '' : textFont;
  return bulletText(code, font);
}

// 자동 번호 셈: 같은 단계에서 이어지면 1씩, 번호 없는 문단이 끼면 다시
function numberer() {
  const counters = [];
  return (lvl, auto) => {
    if (!auto) { counters.length = Math.min(counters.length, lvl); return null; }
    counters[lvl] = (counters[lvl] ?? auto.start - 1) + 1;
    counters.length = lvl + 1;
    return autoNumber(auto.type, counters[lvl]);
  };
}

// ─── 글 → 문단 ───
// recs: TextHeader·TextChars/Bytes·StyleTextProp·메타 글자 레코드들. S: 슬라이드 정보(마스터·번호·머리글 설정)
// opt.pp9: 자동 번호 묶음(StyleTextProp9), opt.mask: 대문자로 바꿔 저장한 글의 원래 소문자 자리('_')
function textParas(D, recs, S, opt = {}) {
  const r = D.r;
  let type = 4, raw = '', style = null;
  const mc = new Map();
  for (const c of recs) {
    if (c.type === RT.TextHeader) type = r.u32(c.body);
    else if (c.type === RT.TextChars) raw = utf16(D, c);
    else if (c.type === RT.TextBytes) raw = bytes8(D, c);
    else if (c.type === RT.StyleTextProp) style = c;
    else if (c.type === RT.SlideNumberMC) mc.set(r.u32(c.body), String(S.num));
    else if (c.type === RT.DateTimeMC || c.type === RT.GenericDateMC || c.type === RT.RtfDateTimeMC) mc.set(r.u32(c.body), dateText(S.hf));
    else if (c.type === RT.HeaderMC) mc.set(r.u32(c.body), (S.hf && S.hf.header) || '');
    else if (c.type === RT.FooterMC) mc.set(r.u32(c.body), (S.hf && S.hf.footer) || '');
  }
  if (type > 8) type = 4;
  if (opt.mask && opt.mask.length === raw.length) {
    // 글자 수가 바뀌면 띠·필드 자리가 어긋나므로 한 글자로 바뀌는 것만
    raw = raw.split('').map((ch, i) => { const lo = opt.mask[i] === '_' ? ch.toLowerCase() : ch; return lo.length === 1 ? lo : ch; }).join('');
  }
  const runs = style ? styleRuns(D, style, raw.length + 1) : { pfs: [], cfs: [] };
  const out = [];
  const kp = { i: 0 }, kc = { i: 0 };
  const num = numberer();
  for (let start = 0, guard = 0; guard <= raw.length; guard++) {
    let end = raw.indexOf('\r', start);
    if (end < 0) end = raw.length;
    const pr = runAt(runs.pfs, start, kp);
    const lvl = pr ? Math.min(4, pr.lvl) : 0;
    const chain = masterChain(D, S.master, type, lvl);
    const mcfs = chain.map((e) => e.cf);
    const first = runAt(runs.cfs, start, kc);
    let s = '';
    let fontRun = null, font = '';
    for (let i = start; i < end; i++) {
      const ch = raw.charCodeAt(i);
      if (mc.size && mc.has(i)) { s += mc.get(i); continue; }
      if (ch === 0x0b) s += SOFT_BREAK;
      else if (ch < 0x20 && ch !== 9) continue;
      else if (ch >= 0xf020 && ch <= 0xf0ff) {
        const cr = runAt(runs.cfs, i, kc);
        if (cr !== fontRun || !font) { fontRun = cr; font = fontName(D, [cr && cr.cf, ...mcfs]); }
        s += symbolChar(ch, font);
      } else s += raw[i];
    }
    let bullet = null;
    if (s.trim()) {
      const b = masterBullet(D, [pr && pr.pf, ...chain.map((e) => e.pf)], fontName(D, [first && first.cf, ...mcfs]));
      let auto = null;
      if (b && opt.pp9) {
        // 이 문단 첫 글자 띠의 pp9rt 번째 묶음에 자동 번호가 있으면 번호
        const cf = first && first.cf;
        const e = opt.pp9[cf && (cf.m & 0x3c00) ? (cf.style >> 10) & 15 : 0];
        if (e && e.auto) auto = { type: ANM[e.scheme] || 'arabicPeriod', start: e.start };
      }
      bullet = num(lvl, auto) || b;
    }
    out.push({ s, lvl, bullet });
    if (end >= raw.length) break;
    start = end + 1;
  }
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');
// 날짜 필드: 고정 날짜를 적었으면 그것, 아니면 오늘(파워포인트가 보여 주는 대로)
function dateText(hf) {
  if (hf && (hf.flags & 4) && hf.userDate) return hf.userDate;
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ─── metroBlob(OOXML 도형 사본) ───
function readMetro(D, blob) {
  if (!blob) return null;
  let files;
  try {
    files = unzipSync(D.r.b.subarray(blob.o, blob.o + blob.n), { filter: (f) => /^drs\/.*\.(xml|rels)$/.test(f.name) && f.originalSize < 16e6 });
  } catch { return null; }
  const cache = new Map();
  const xml = (name) => {
    if (!cache.has(name)) {
      let t = null;
      try { t = files[name] ? parseXml(strFromU8(files[name])) : null; } catch { t = null; }
      cache.set(name, t);
    }
    return cache.get(name);
  };
  return { xml };
}

// 도형 사본의 글: { paras } 또는 { table }, 자리(xfrm, pt). ph: 이진 쪽 자리표시자 종류(없으면 사본의 것으로 글 종류를 정한다)
function metroText(D, S, metro, ph) {
  if (!metro) return null;
  const sx = metro.xml('drs/shapexml.xml');
  const root = sx && kids(sx)[0];
  if (root) {
    const xph = xmlPh(root);
    const type = ph ? typeOfPh(ph) : typeOfXmlPh(xph);
    const bodies = root.l === 'sp' ? [kid(root, 'txBody')] : descendants(root, 'txBody');
    const paras = [];
    for (const tb of bodies) paras.push(...xmlParas(D, S, tb, type));
    return { paras, ph: xph, xfrm: xmlXfrm(root) };
  }
  const e2o = metro.xml('drs/e2oDoc.xml');
  const frame = e2o && kids(e2o)[0];
  if (!frame) return null;
  const xfrm = xmlXfrm(frame);
  const tbl = descendants(frame, 'tbl')[0];
  if (tbl) return { table: xmlTable(tbl), xfrm };
  // 딸린 부분(스마트아트 자료·차트)은 관계 목록으로 찾는다
  const part = (id) => {
    const rel = descendants(metro.xml('drs/_rels/e2oDoc.xml.rels'), 'Relationship').find((x) => attr(x, 'Id') === id);
    const t = rel && attr(rel, 'Target');
    return t ? metro.xml('drs/' + t.replace(/^\.\//, '').replace(/^\/?drs\//, '')) : null;
  };
  const ids = descendants(frame, 'relIds')[0];
  if (ids) return { paras: smartArtParas(part(attr(ids, 'dm'))), xfrm };
  const chart = descendants(frame, 'chart')[0];
  if (chart) {
    // 차트는 제목만(pptx.js 와 같이)
    const title = descendants(part(attr(chart, 'id')), 'title')[0];
    const t = title ? descendants(title, 'p').map((p) => xmlLine(p, ' ')).join(' ').trim() : '';
    return { paras: t ? [{ s: t, lvl: 0, bullet: null }] : [], xfrm };
  }
  return null;
}

// 도형 사본의 자리(EMU → pt): 파워포인트가 보여 주는 자리(효과·회전 전). 묶음 밖 도형에만 쓴다
function xmlXfrm(el) {
  const x = kid(el, 'xfrm') || kid(kid(el, 'spPr'), 'xfrm');
  const off = kid(x, 'off'), ext = kid(x, 'ext');
  if (!off || !ext) return null;
  const v = (e, a) => +attr(e, a) / 12700;
  const r = { x: v(off, 'x'), y: v(off, 'y'), w: v(ext, 'cx'), h: v(ext, 'cy') };
  return [r.x, r.y, r.w, r.h].every(Number.isFinite) ? r : null;
}

// 도형 사본의 글자만(대문자 바꿈 자국 맞추기용): 문단은 '\r', 줄바꿈은 '\v'
function metroMask(metro) {
  if (!metro) return null;
  const sx = metro.xml('drs/shapexml.xml');
  const tb = sx && descendants(sx, 'txBody')[0];
  if (!tb) return null;
  const s = kids(tb, 'p').map((p) => xmlLine(p, '\v')).join('\r');
  return /^[ _\r\v]*$/.test(s) && s.includes('_') ? s : null;
}

function xmlPh(el) {
  const ph = descendants(kid(el, 'nvSpPr') || el, 'ph')[0];
  return ph ? attr(ph, 'type') || 'obj' : null;
}

// OOXML 글 상자(a:p 들) → 문단. 글머리는 문단 속성 → 글 상자 목록 꼴 → (정보가 없으면) 이 파일 마스터의 같은 종류 글 꼴
function xmlParas(D, S, txBody, type) {
  const out = [];
  if (!txBody) return out;
  const lst = kid(txBody, 'lstStyle');
  const num = numberer();
  for (const p of kids(txBody, 'p')) {
    const pPr = kid(p, 'pPr');
    const lvl = Math.max(0, Math.min(8, +attr(pPr, 'lvl') || 0));
    const s = xmlLine(p, SOFT_BREAK, S.num);
    let bullet = null;
    if (s.trim()) {
      const b = xmlBullet([pPr, lst ? kid(lst, `lvl${lvl + 1}pPr`) : null]);
      if (b && b.auto) bullet = num(lvl, b.auto);
      else {
        num(lvl, null);
        if (b) bullet = b.none ? null : b.char;
        else bullet = masterBullet(D, masterChain(D, S.master, type, Math.min(4, lvl)).map((e) => e.pf), '');
      }
    }
    out.push({ s, lvl, bullet });
  }
  return out;
}

// OOXML 문단(a:p) 한 줄의 글: 글 조각·필드(슬라이드 번호는 이 슬라이드 번호로), 줄바꿈은 br 로.
// 기호 글꼴 글자(사용자 정의 영역)는 보통 글자로
function xmlLine(p, br, slideNum) {
  let s = '';
  for (const k of kids(p)) {
    if (k.l === 'fld' && attr(k, 'type') === 'slidenum' && slideNum != null) s += String(slideNum);
    else if (k.l === 'r' || k.l === 'fld') {
      const rPr = kid(k, 'rPr');
      const font = rPr ? attr(kid(rPr, 'sym'), 'typeface') || attr(kid(rPr, 'latin'), 'typeface') || '' : '';
      s += fixSymbolText(descendants(k, 't').map((x) => x.c.join('')).join(''), font);
    } else if (k.l === 'br') s += br;
  }
  return s;
}

function xmlBullet(srcs) {
  let font = null;
  for (const s of srcs) { const f = s && kid(s, 'buFont'); if (f) { font = attr(f, 'typeface'); break; } }
  for (const s of srcs) {
    if (!s) continue;
    if (kid(s, 'buNone')) return { none: true };
    const ch = kid(s, 'buChar');
    if (ch) { const c = attr(ch, 'char') || ''; return { char: c ? bulletText(c.charCodeAt(0), font) : '•' }; }
    const an = kid(s, 'buAutoNum');
    if (an) return { auto: { type: attr(an, 'type') || 'arabicPeriod', start: +attr(an, 'startAt') || 1 } };
    if (kid(s, 'buBlip')) return { char: '•' };
  }
  return null;
}

function xmlTable(tbl) {
  const rows = [];
  for (const tr of kids(tbl, 'tr')) {
    const row = [];
    for (const tc of kids(tr, 'tc')) {
      const m = (a) => attr(tc, a) === '1' || attr(tc, a) === 'true';
      if (m('hMerge') || m('vMerge')) { row.push(null); continue; }
      const tb = kid(tc, 'txBody');
      const s = tb ? kids(tb, 'p').map((p) => xmlLine(p, SOFT_BREAK)).join('\n').replace(/\s+$/, '') : '';
      row.push({ s, cs: Math.max(1, +attr(tc, 'gridSpan') || 1), rs: Math.max(1, +attr(tc, 'rowSpan') || 1) });
    }
    rows.push(row);
  }
  const n = rows.reduce((m, r) => Math.max(m, r.length), 0);
  rows.forEach((r, i) => {
    while (r.length < n) r.push(null);
    // 합친 칸 수가 표 밖으로 나가지 않게
    r.forEach((c, j) => { if (c) { c.cs = Math.min(c.cs, n - j); c.rs = Math.min(c.rs, rows.length - i); } });
  });
  return rows.some((r) => r.some((c) => c && c.s.trim())) ? rows : null;
}

// 스마트아트 자료 모델(점·연결)로 나무를 세워 차례대로(pptx.js 와 같은 방식). 칸 안 줄바꿈도 줄마다 나눈다
function smartArtParas(data) {
  if (!data) return [];
  const pts = new Map();
  for (const pt of descendants(data, 'pt')) {
    const t = kid(pt, 't');
    pts.set(attr(pt, 'modelId'), { type: attr(pt, 'type') || 'node', text: t ? kids(t, 'p').map((p) => xmlLine(p, '\n')).join('\n').trim() : '' });
  }
  const children = new Map();
  for (const c of descendants(data, 'cxn')) {
    if ((attr(c, 'type') || 'parOf') !== 'parOf') continue;
    const src = attr(c, 'srcId');
    if (!children.has(src)) children.set(src, []);
    children.get(src).push({ id: attr(c, 'destId'), ord: +attr(c, 'srcOrd') || 0 });
  }
  const root = [...pts.entries()].find(([, v]) => v.type === 'doc');
  const out = [];
  const seen = new Set();
  const walk = (id, depth) => {
    if (seen.has(id) || depth > 20) return;
    seen.add(id);
    const p = pts.get(id);
    if (p && (p.type === 'node' || p.type === 'asst') && p.text) for (const line of p.text.split('\n')) if (line.trim()) out.push({ s: line, lvl: Math.max(0, depth - 1), bullet: null });
    for (const ch of (children.get(id) || []).sort((a, b) => a.ord - b.ord)) walk(ch.id, depth + 1);
  };
  if (root) walk(root[0], 0);
  else for (const [id, p] of pts) if ((p.type === 'node' || p.type === 'asst') && p.text && !seen.has(id)) out.push({ s: p.text, lvl: 0, bullet: null });
  return out;
}

// ─── 도형 ───
const PH_TITLE = new Set([1, 3, 13, 15, 17]); // 제목·가운데 제목·세로 제목(마스터 것 포함)
const PH_HF = new Set([7, 8, 9, 10]); // 날짜·슬라이드 번호·바닥글·머리글
const roleOf = (ph) => (PH_TITLE.has(ph) ? 'title' : PH_HF.has(ph) ? 'hf' : '');
// 자리표시자 종류 → 글 종류(마스터 글 꼴을 고를 때)
const typeOfPh = (ph) => (ph === 1 || ph === 13 || ph === 17 ? 0 : ph === 3 || ph === 15 ? 6 : ph === 4 || ph === 16 ? 5 : PH_HF.has(ph) || !ph ? 4 : 1);
const typeOfXmlPh = (t) => (t == null ? 4 : t === 'title' ? 0 : t === 'ctrTitle' ? 6 : t === 'subTitle' ? 5 : /^(dt|ftr|sldNum|hdr)$/.test(t) ? 4 : 1);
const roleOfXmlPh = (t) => (t === 'title' || t === 'ctrTitle' ? 'title' : /^(dt|ftr|sldNum|hdr)$/.test(t || '') ? 'hf' : '');

// OfficeArtSpContainer 한 개의 정보
function shapeInfo(D, sp) {
  const r = D.r;
  const s = { spt: 0, flags: 0, anchor: null, child: null, grp: null, rot: 0, ph: 0, text: null, ref: -1, table: false, metro: null, gtext: null, pp9: null };
  for (const c of kidsOf(D, sp)) {
    switch (c.type) {
      case RT.FSP: s.spt = c.inst; s.flags = r.u32(c.body + 4); break;
      case RT.FSPGR: s.grp = ltrb(r, c.body); break;
      case RT.ChildAnchor: s.child = ltrb(r, c.body); break;
      case RT.ClientAnchor:
        // 위·왼쪽·오른쪽·아래 차례(2바이트 또는 4바이트)
        s.anchor = c.len >= 16
          ? box(r.i32(c.body + 4), r.i32(c.body), r.i32(c.body + 8), r.i32(c.body + 12))
          : box(r.i16(c.body + 2), r.i16(c.body), r.i16(c.body + 4), r.i16(c.body + 6));
        break;
      case RT.FOPT: case RT.SecFOPT: case RT.TerFOPT:
        if (optValue(D, c, 0x39f) & 1) s.table = true; // 표 묶음 표시
        if (c.type === RT.FOPT) s.rot = (optValue(D, c, 0x004) | 0) / 65536; // 회전(도)
        s.metro = metroBlob(D, c) || s.metro;
        s.gtext = optComplex(D, c, 0xc0) || s.gtext; // 워드아트 글(gtextUNICODE)
        break;
      case RT.ClientData:
        for (const k of kidsOf(D, c)) {
          if (k.type === RT.Placeholder) s.ph = r.u8(k.body + 4);
          else if (k.type === RT.HFPlaceholder12 && !s.ph) s.ph = r.u8(k.body);
          else if (k.type === RT.ProgTags) { const t = binaryTag(D, k, '___PPT9'); const st = t && kidOf(D, t, RT.StyleTextProp9); if (st) s.pp9 = readStyle9(D, st); }
        }
        break;
      case RT.ClientTextbox: {
        const ks = kidsOf(D, c);
        const ref = ks.find((k) => k.type === RT.OutlineTextRef);
        if (ref) s.ref = r.u32(ref.body);
        else s.text = ks;
        break;
      }
    }
  }
  return s;
}
const box = (l, t, rgt, btm) => ({ x: l, y: t, w: rgt - l, h: btm - t });
const ltrb = (r, o) => box(r.i32(o), r.i32(o + 4), r.i32(o + 8), r.i32(o + 12));

// 그림판 속성 표(FOPT)에서 단순 값 하나
function optValue(D, c, id) {
  for (let i = 0; i < c.inst; i++) {
    const o = c.body + i * 6;
    if (o + 6 > c.end) break;
    if ((D.r.u16(o) & 0x3fff) === id) return D.r.u32(o + 2);
  }
  return 0;
}

// 복합 값: 속성 표 뒤에 복합 속성 차례대로 자료가 이어 붙는다(값 = 자료 길이)
function optComplex(D, c, id) {
  let cx = c.body + c.inst * 6;
  for (let i = 0; i < c.inst; i++) {
    const o = c.body + i * 6;
    if (o + 6 > c.end) return null;
    const pid = D.r.u16(o), n = D.r.u32(o + 2);
    if (!(pid & 0x8000)) continue;
    if ((pid & 0x3fff) === id) return cx + n <= c.end ? { o: cx, n } : null;
    cx += n;
  }
  return null;
}

// metroBlob(0x3A9): ZIP 머리(PK\3\4)로 확인. 앞 복합 값 길이가 어긋난 파일도 있어 맨 끝 자리도 본다
function metroBlob(D, c) {
  const isZip = (o) => D.r.u32(o) === 0x04034b50;
  const b = optComplex(D, c, 0x3a9);
  if (b && isZip(b.o)) return b;
  for (let i = 0; i < c.inst; i++) {
    const o = c.body + i * 6;
    if ((D.r.u16(o) & 0x3fff) !== 0x3a9) continue;
    const n = D.r.u32(o + 2);
    return n <= c.end - c.body && isZip(c.end - n) ? { o: c.end - n, n } : null;
  }
  return null;
}

// 도형 자리(마스터 단위): 묶음 안이면 묶음 좌표계를 슬라이드 좌표로 바꾼다.
// 45~135도·225~315도 돌린 도형은 돌린 뒤의 둘레 상자가 적혀 있어, 가운데를 두고 너비·높이를 바꿔 원래 상자로
function rectOf(T, s) {
  const a = (T && s.child ? mapRect(T, s.child) : s.anchor || s.child) || { x: 0, y: 0, w: 0, h: 0 };
  const deg = ((s.rot % 360) + 360) % 360;
  if (!((deg >= 45 && deg < 135) || (deg >= 225 && deg < 315))) return a;
  return { x: a.x + (a.w - a.h) / 2, y: a.y + (a.h - a.w) / 2, w: a.h, h: a.w };
}
const mapRect = (T, a) => ({ x: T.x + (a.x - T.cx) * T.sx, y: T.y + (a.y - T.cy) * T.sy, w: a.w * T.sx, h: a.h * T.sy });

function groupT(T, self) {
  const f = rectOf(T, self);
  const g = self.grp;
  if (!g) return T;
  return { x: f.x, y: f.y, cx: g.x, cy: g.y, sx: g.w ? f.w / g.w : 1, sy: g.h ? f.h / g.h : 1 };
}

// 마스터 단위(1인치 576) → pt
const toPt = (p) => ({ x: p.x / 8, y: p.y / 8, w: p.w / 8, h: p.h / 8 });

function walkGroup(D, S, g, T, depth) {
  if (depth > 32) return;
  const ks = kidsOf(D, g);
  // 첫 도형은 묶음 자신(좌표계·표 표시)
  const self = ks.length && ks[0].type === RT.SpContainer ? shapeInfo(D, ks[0]) : null;
  const T2 = depth > 0 && self ? groupT(T, self) : T;
  if (self && self.table) { tableShape(D, S, ks.slice(1), T2, rectOf(T, self)); return; }
  for (let i = self ? 1 : 0; i < ks.length; i++) {
    const k = ks[i];
    if (k.type === RT.SpContainer) addShape(D, S, shapeInfo(D, k), T2);
    else if (k.type === RT.SpgrContainer) walkGroup(D, S, k, T2, depth + 1);
  }
}

// 도형의 글: 이진 글(도형 속 또는 슬라이드 목록 쪽) → 워드아트 글 → 도형 사본(metroBlob)
function shapeText(D, S, s) {
  const outline = s.ref >= 0;
  const recs = outline ? S.texts[s.ref] : s.text;
  if (recs) {
    const opt = {};
    if (outline) {
      const th = recs.find((c) => c.type === RT.TextHeader);
      opt.pp9 = D.outline9.get(S.id + ':' + (th ? D.r.u32(th.body) : 0)) || null;
    } else opt.pp9 = s.pp9;
    // 모두 대문자인 글: 도형 사본에 원래 소문자 자리가 적혀 있으면 되살린다(글꼴 '모두 대문자' 꾸밈)
    const raw = recs.find((c) => c.type === RT.TextChars || c.type === RT.TextBytes);
    if (raw && s.metro) {
      const t = raw.type === RT.TextChars ? utf16(D, raw) : bytes8(D, raw);
      if (t !== t.toLowerCase() && t === t.toUpperCase()) opt.mask = quiet(() => metroMask(readMetro(D, s.metro)));
    }
    const paras = textParas(D, recs, S, opt);
    if (paras.some((p) => p.s.trim())) return { paras };
  }
  if (s.gtext) {
    let t = utf16(D, { body: s.gtext.o, end: s.gtext.o + s.gtext.n });
    const z = t.indexOf('\0');
    if (z >= 0) t = t.slice(0, z);
    const paras = t.split(/\r\n|\r|\n/).map((x) => ({ s: x, lvl: 0, bullet: null }));
    if (paras.some((p) => p.s.trim())) return { paras };
  }
  return (s.metro && quiet(() => metroText(D, S, readMetro(D, s.metro), s.ph))) || { paras: [] };
}

// 도형 사본은 덤이라, 망가져 있으면 그 도형만 건너뛴다(파일 전체를 실패로 만들지 않게)
function quiet(fn) {
  try { return fn(); } catch { return null; }
}

function addShape(D, S, s, T) {
  if (s.flags & 0x408) return; // 지운 도형·바탕
  const t = shapeText(D, S, s);
  const pos = !T && t.xfrm ? t.xfrm : toPt(rectOf(T, s)); // 사본에서 꺼낸 글이면 사본의 자리(묶음 밖일 때)
  if (t.table) { S.shapes.push({ ...pos, role: '', paras: [], table: t.table }); return; }
  if (!t.paras || !t.paras.some((p) => p.s.trim())) return;
  const role = s.ph ? roleOf(s.ph) : roleOfXmlPh(t.ph);
  // 날짜·바닥글·슬라이드 번호 자리는 본문 글 종류로 적혀 있기도 해서 마스터 본문 글머리가 잘못 붙지 않게
  const paras = role === 'hf' ? t.paras.map((p) => ({ ...p, bullet: null })) : t.paras;
  S.shapes.push({ ...pos, role, paras, table: null });
}

// 표: 칸 도형(선이 아닌 것)들의 자리로 행·열 경계를 세운다
function tableShape(D, S, ks, T, frame) {
  const cells = [];
  for (const k of ks) {
    if (k.type !== RT.SpContainer) continue;
    const s = shapeInfo(D, k);
    if (s.spt === 20 || (s.flags & 0x408)) continue; // 테두리 선
    const p = rectOf(T, s);
    if (!(p.w > 0 && p.h > 0)) continue;
    const t = shapeText(D, S, s);
    cells.push({ ...p, s: (t.paras || []).map((q) => q.s).join('\n').replace(/\s+$/, '') });
  }
  const rows = gridOf(cells);
  if (rows) S.shapes.push({ ...toPt(frame), role: '', paras: [], table: rows });
}

function gridOf(cells) {
  if (!cells.length) return null;
  const edges = (vals) => {
    vals.sort((a, b) => a - b);
    const out = [];
    for (const v of vals) if (!out.length || v - out[out.length - 1] > 2) out.push(v);
    return out;
  };
  const xs = edges(cells.flatMap((c) => [c.x, c.x + c.w]));
  const ys = edges(cells.flatMap((c) => [c.y, c.y + c.h]));
  const near = (arr, v) => { let b = 0; for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i] - v) < Math.abs(arr[b] - v)) b = i; return b; };
  const R = ys.length - 1, C = xs.length - 1;
  if (R < 1 || C < 1 || R * C > 100000) return null;
  const rows = Array.from({ length: R }, () => new Array(C).fill(null));
  const used = Array.from({ length: R }, () => new Array(C).fill(false));
  cells.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const c of cells) {
    const c0 = near(xs, c.x), c1 = near(xs, c.x + c.w), r0 = near(ys, c.y), r1 = near(ys, c.y + c.h);
    if (c1 <= c0 || r1 <= r0 || used[r0][c0]) continue;
    rows[r0][c0] = { s: c.s, cs: c1 - c0, rs: r1 - r0 };
    for (let y = r0; y < r1; y++) for (let x = c0; x < c1; x++) used[y][x] = true;
  }
  return rows.some((row) => row.some((c) => c && c.s.trim())) ? rows : null;
}

// ─── 슬라이드 ───
function readSlide(D, ent, num) {
  const h = atPersist(D, ent.persist, [RT.Slide]);
  if (!h) { D.missing++; return { hidden: false, shapes: [] }; }
  const r = D.r;
  let hidden = false, masterId = null, drawing = null, hf = null;
  for (const c of kidsOf(D, h)) {
    if (c.type === RT.SlideAtom) masterId = r.u32(c.body + 12);
    else if (c.type === RT.SlideShowInfo) hidden = (r.u16(c.body + 10) & 4) !== 0;
    else if (c.type === RT.Drawing) drawing = c;
    else if (c.type === RT.HeadersFooters) hf = readHF(D, c);
  }
  let master = masterId != null ? masterOf(D, masterId) : null;
  if (!master) for (const e of D.masterList) if ((master = masterOf(D, e.id))) break;
  const S = { master, num, id: ent.id, texts: ent.texts, hf: hf || D.slideHF, shapes: [] };
  const dg = drawing && kidOf(D, drawing, RT.DgContainer);
  const top = dg && kidOf(D, dg, RT.SpgrContainer);
  if (top) walkGroup(D, S, top, null, 0);
  return { hidden, shapes: S.shapes };
}

export function parsePpt(bytes, { onProgress, slidesOnly = false } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isCfb(u8)) throw broken();
  let slides, missing;
  try {
    const D = openPpt(u8);
    readDocument(D);
    slides = [];
    const list = D.slideList;
    list.forEach((ent, i) => {
      slides.push(readSlide(D, ent, D.firstNum + i));
      if (onProgress) onProgress((i + 1) / list.length);
    });
    missing = D.missing;
  } catch (e) {
    if (e && e.code) throw e;
    throw Object.assign(broken(), { cause: e });
  }
  // 슬라이드를 하나도 찾지 못했으면 손상된 파일. 일부만 못 찾았으면 알린다
  if (missing && missing === slides.length) throw broken();
  if (slidesOnly) return { slides };
  const model = slidesToModel('ppt', slides);
  if (missing) model.warnings.push(`슬라이드 ${missing}장을 읽지 못했습니다(손상된 부분이 있을 수 있습니다).`);
  return model;
}
