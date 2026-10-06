// 한글 5.x(.hwp) 읽기 — 복합 문서 속 본문 레코드를 풀어 문서 모델로.
// 문단·표(합친 칸 포함)·글상자·각주/미주·자동 문단 번호·쪽 나뉨(줄 배치 정보의 '쪽 첫 줄' 표시)을 읽는다.
import { inflateSync } from '../../vendor/fflate.mjs';
import { readCfb } from './cfb.js';
import { noteMark, levelize } from './model.js';
import { formatNumber, applyNumberFormat } from './numfmt.js';
import { resolveSoftBreaks } from './joiner.js';
import { PageTracker } from './pagetrack.js';

// 글 속 특수 표시: 강제 줄바꿈(Shift+Enter)은 줄 구분 글자로 두었다가 줄 잇기 판단기가 정한다(joiner.resolveSoftBreaks)
export const SOFT_BREAK = '\u2028';
export const ZERO_SPACE = '\u200b'; // 폭 없는 빈칸 — 글로 그릴 때 지운다

const T = {
  CHAR_SHAPE: 21, NUMBERING: 23, BULLET: 24, PARA_SHAPE: 25,
  PARA_HEADER: 66, PARA_TEXT: 67, PARA_LINE_SEG: 69, CTRL_HEADER: 71, LIST_HEADER: 72, PAGE_DEF: 73, TABLE: 77,
};

export class HwpError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

// 레코드들을 수준(level)에 따라 나무로 엮는다
export function parseRecords(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const root = { tag: -1, level: -1, kids: [] };
  const stack = [root];
  let o = 0;
  while (o + 4 <= u8.length) {
    const h = dv.getUint32(o, true);
    o += 4;
    const tag = h & 0x3ff;
    const level = (h >>> 10) & 0x3ff;
    let size = (h >>> 20) & 0xfff;
    if (size === 0xfff) {
      if (o + 4 > u8.length) break;
      size = dv.getUint32(o, true);
      o += 4;
    }
    if (o + size > u8.length) size = u8.length - o;
    const rec = { tag, level, data: u8.subarray(o, o + size), kids: [] };
    o += size;
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    stack[stack.length - 1].kids.push(rec);
    stack.push(rec);
  }
  return root.kids;
}

function dvOf(rec) {
  return new DataView(rec.data.buffer, rec.data.byteOffset, rec.data.byteLength);
}

function ctrlId(rec) {
  if (rec.data.length < 4) return '';
  const v = dvOf(rec).getUint32(0, true);
  return String.fromCharCode((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

function readWStr(dv, o) {
  if (o + 2 > dv.byteLength) return { s: '', next: o };
  const n = dv.getUint16(o, true);
  let s = '';
  for (let i = 0; i < n && o + 2 + i * 2 + 2 <= dv.byteLength; i++) s += String.fromCharCode(dv.getUint16(o + 2 + i * 2, true));
  return { s, next: o + 2 + n * 2 };
}

// ─── 문서 정보(DocInfo): 문단 모양·번호·글머리표 ───
function parseDocInfo(tree) {
  const info = { paraShapes: [], numberings: [], bullets: [], charSizes: [] };
  // 문서 정보 레코드는 ID_MAPPINGS 아래 한 단계 들어가 있다 — 펴서 차례대로 읽는다
  const recs = [];
  const flat = (rs) => { for (const r of rs) { recs.push(r); flat(r.kids); } };
  flat(tree);
  for (const r of recs) {
    const dv = dvOf(r);
    if (r.tag === T.PARA_SHAPE && r.data.length >= 32) {
      const p1 = dv.getUint32(0, true);
      info.paraShapes.push({
        align: (p1 >>> 2) & 7,
        headType: (p1 >>> 23) & 3, // 0 없음, 1 개요, 2 번호, 3 글머리표
        headLevel: (p1 >>> 25) & 7,
        left: dv.getInt32(4, true),
        indent: dv.getInt32(12, true),
        numId: dv.getUint16(30, true),
      });
    } else if (r.tag === T.NUMBERING) {
      const levels = [];
      let o = 0;
      for (let lv = 0; lv < 7; lv++) {
        if (o + 12 > r.data.length) break;
        const prop = dv.getUint32(o, true);
        o += 12;
        const fs = readWStr(dv, o);
        o = fs.next;
        levels.push({ shape: (prop >>> 5) & 0xf, fmt: fs.s, start: 1 });
      }
      let start = 1;
      if (o + 2 <= r.data.length) { start = dv.getUint16(o, true) || 1; o += 2; }
      for (let lv = 0; lv < levels.length; lv++) {
        levels[lv].start = start;
        if (o + 4 <= r.data.length) { const v = dv.getUint32(o, true); if (v > 0 && v < 100000) levels[lv].start = v; o += 4; }
      }
      info.numberings.push(levels);
    } else if (r.tag === T.BULLET) {
      info.bullets.push(r.data.length >= 14 ? String.fromCharCode(dv.getUint16(12, true)) : '•');
    } else if (r.tag === T.CHAR_SHAPE) {
      info.charSizes.push(r.data.length >= 46 ? dv.getInt32(42, true) : 1000);
    }
  }
  return info;
}

// ─── 본문 ───
export function parseHwp(bytes, { onProgress } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const cfb = readCfb(u8);
  const fh = cfb.read('FileHeader');
  if (!fh || fh.length < 40 || String.fromCharCode(...fh.subarray(0, 17)) !== 'HWP Document File') {
    throw new HwpError('format', '한글 5.0 이상 문서가 아닙니다(한글 97 이하 문서일 수 있습니다)');
  }
  const flags = new DataView(fh.buffer, fh.byteOffset, fh.byteLength).getUint32(36, true);
  if (flags & 2) throw new HwpError('password', '암호가 걸린 한글 문서입니다');
  if (flags & 16) throw new HwpError('drm', '보안(DRM)이 걸린 한글 문서입니다');
  if (flags & 4) throw new HwpError('distribution', '배포용 한글 문서입니다');
  const compressed = !!(flags & 1);
  const unpack = (d) => {
    if (!d) return null;
    if (!compressed) return d;
    try { return inflateSync(d); } catch { throw new HwpError('broken', '한글 문서의 압축을 풀지 못했습니다(손상된 파일일 수 있습니다)'); }
  };

  const docInfo = parseDocInfo(parseRecords(unpack(cfb.read('DocInfo')) || new Uint8Array(0)));
  const sections = cfb.paths().filter((p) => /^BodyText\/Section\d+$/.test(p)).sort((a, b) => +a.match(/\d+$/)[0] - +b.match(/\d+$/)[0]);
  if (!sections.length) throw new HwpError('broken', '한글 문서에 본문이 없습니다');

  const st = {
    info: docInfo,
    pt: new PageTracker(),
    blocks: [],
    notes: [],
    endNotes: [],
    noteNo: 0,
    counters: new Map(), // 번호 문단: numId → [수준별 값]
    outlineNumId: 0,
    pendingGap: 0,
    xs: [], // 들여쓰기 위치(단계 계산용)
  };

  sections.forEach((name, si) => {
    const recs = parseRecords(unpack(cfb.read(name)));
    for (const r of recs) if (r.tag === T.PARA_HEADER) topParagraph(st, r);
    if (onProgress) onProgress((si + 1) / sections.length);
  });

  finishLevels(st.blocks, st.xs);
  const doc = {
    format: 'hwp',
    pages: st.pt.page,
    pageExact: false,
    blocks: st.blocks,
    notes: st.notes.concat(st.endNotes),
    warnings: [],
  };
  resolveSoftBreaks(doc);
  return doc;
}

// 들여쓰기 위치(HWPUNIT)를 단계로 — 가장 얕은 위치가 0단계
export function finishLevels(blocks, xs) {
  const toLevel = levelize(xs, 350);
  for (const b of blocks) if (b.t === 'p' && b._x != null) { b.lvl = toLevel(b._x); delete b._x; }
}

// 문단 하나의 글자를 풀어낸다. 표·각주 같은 제어는 글 속 위치(at)와 함께 따로 모은다.
// 돌려주는 것: text(제어 자리는 비움), ctrls[{ at:글 위치, id, ch }], w2o(WCHAR 위치 → 글 위치)
function decodeParaText(rec) {
  const ctrls = [];
  const ws = []; // 각 단위의 WCHAR 시작 위치
  const os = []; // 그때의 글 위치
  let text = '';
  if (!rec) return { text, ctrls, w2o: () => 0 };
  const dv = dvOf(rec);
  const n = rec.data.length >> 1;
  for (let i = 0; i < n;) {
    ws.push(i); os.push(text.length);
    const c = dv.getUint16(i * 2, true);
    if (c >= 32) { text += String.fromCharCode(c); i++; continue; }
    switch (c) {
      case 10: text += SOFT_BREAK; i++; continue;    // 강제 줄바꿈(문단 안)
      case 13: i++; continue;                         // 문단 끝
      case 24: text += '-'; i++; continue;            // 하이픈
      case 30: text += ' '; i++; continue;            // 묶음 빈칸
      case 31: text += ZERO_SPACE; i++; continue;    // 고정폭 빈칸 — 자간 띄우기용(경 찰 청). 한글도 글로 뽑을 때 버린다
      case 0: case 25: case 26: case 27: case 28: case 29: i++; continue;
      case 9: text += '\t'; i += 8; continue;         // 탭
      case 4: case 5: case 6: case 7: case 8: case 19: case 20: i += 8; continue; // 필드 끝 등(글자 아님)
      default: {
        // 확장 제어(표·그림·각주…): 뒤 4바이트가 제어 이름
        let id = '';
        if ((i + 3) * 2 <= rec.data.length) {
          const v = dv.getUint32((i + 1) * 2, true);
          id = String.fromCharCode((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
        }
        ctrls.push({ at: text.length, id, ch: c });
        i += 8;
      }
    }
  }
  const w2o = (w) => {
    let lo = 0, hi = ws.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ws[m] < w) lo = m + 1; else hi = m; }
    return lo < os.length ? os[lo] : text.length;
  };
  return { text, ctrls, w2o };
}

function paraHead(rec) {
  const dv = dvOf(rec);
  return {
    shapeId: rec.data.length >= 10 ? dv.getUint16(8, true) : 0,
    breakType: rec.data.length >= 12 ? rec.data[11] : 0,
  };
}

function lineSegs(rec) {
  if (!rec) return [];
  const dv = dvOf(rec);
  const out = [];
  for (let o = 0; o + 36 <= rec.data.length; o += 36) out.push({ start: dv.getUint32(o, true), vpos: dv.getInt32(o + 4, true), height: dv.getInt32(o + 8, true), tag: dv.getUint32(o + 32, true) });
  return out;
}

function kidsOf(rec, tag) {
  return rec.kids.filter((k) => k.tag === tag);
}

// 자동 번호·글머리표 글자
function headingLabel(st, shape) {
  if (!shape || !shape.headType) return '';
  const level = shape.headLevel; // 0부터
  if (shape.headType === 3) {
    const b = st.info.bullets[(shape.numId || 1) - 1];
    return b && b.trim() ? b + ' ' : '';
  }
  const numId = shape.headType === 1 ? st.outlineNumId : shape.numId;
  const levels = st.info.numberings[(numId || 1) - 1];
  if (!levels || !levels[level]) return '';
  let cnt = st.counters.get(numId);
  if (!cnt) { cnt = levels.map((l) => (l.start || 1) - 1); st.counters.set(numId, cnt); }
  cnt[level] += 1;
  for (let k = level + 1; k < cnt.length; k++) cnt[k] = (levels[k] ? levels[k].start || 1 : 1) - 1;
  const label = applyNumberFormat(levels[level].fmt, (k) => formatNumber(Math.max(cnt[k] ?? 1, 1), levels[k] ? levels[k].shape : 0));
  return label ? label + ' ' : '';
}

// 개체 제어 문자(표·그림·각주 등 뒤에 제어 레코드가 따라오는 것)
const OBJ_CTRL_CHARS = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]);

// 본문 문단: 글은 쪽 경계마다 조각(seg)으로 나누고, 표·글상자는 그 자리에서 따로 블록으로 내보낸다
function topParagraph(st, rec) {
  const head = paraHead(rec);
  const shape = st.info.paraShapes[head.shapeId];
  const textRec = rec.kids.find((k) => k.tag === T.PARA_TEXT);
  const ctrlRecs = kidsOf(rec, T.CTRL_HEADER);
  const lines = lineSegs(rec.kids.find((k) => k.tag === T.PARA_LINE_SEG));

  // 구역 정의에서 개요 번호 모양을 읽어 둔다
  for (const c of ctrlRecs) {
    const id = ctrlId(c);
    if (id === 'secd') {
      if (c.data.length >= 20) st.outlineNumId = dvOf(c).getUint16(18, true);
      // 용지 설정: 폭, 높이, 왼·오른·위·아래 여백, 머리말, 꼬리말, 제본(각 4바이트), 속성(가로 방향 비트)
      const pd = c.kids.find((k) => k.tag === T.PAGE_DEF);
      if (pd && pd.data.length >= 40) {
        const v = dvOf(pd);
        const w = v.getUint32(0, true), h = v.getUint32(4, true);
        const landscape = v.getUint32(36, true) & 1;
        const paperH = landscape ? w : h;
        st.pt.setBody(paperH - v.getUint32(16, true) - v.getUint32(20, true) - v.getUint32(24, true) - v.getUint32(28, true));
      }
    } else if (id === 'cold' && c.data.length >= 6) {
      st.pt.setColumns((dvOf(c).getUint16(4, true) >>> 2) & 0xff);
    }
  }
  // 강제 쪽 나눔
  if (head.breakType & 4) st.pt.forceBreak();

  const { text, ctrls, w2o } = decodeParaText(textRec);
  // 줄 배치 정보로 쪽이 바뀌는 글 위치
  const cuts = []; // [글 위치, 쪽]
  for (const l of lines) cuts.push([w2o(l.start), st.pt.line(l.vpos, l.height)]);
  if (!cuts.length) cuts.push([0, st.pt.page]);
  const pageAt = (o) => { let pg = cuts[0][1]; for (const [p, g] of cuts) { if (p <= o) pg = g; else break; } return pg; };

  const out = [];
  let segs = [];
  let joins = '';
  const addText = (a, b) => {
    // [a,b) 글을 쪽 경계에서 나눠 조각으로
    let pos = a;
    while (pos < b) {
      const pg = pageAt(pos);
      let next = b;
      for (const [p] of cuts) if (p > pos && p < next) { next = p; break; }
      const s = text.slice(pos, next);
      if (s) {
        const last = segs[segs.length - 1];
        if (last && last.pg === pg) last.s += s;
        else { if (segs.length) joins += 'G'; segs.push({ s, pg }); }
      }
      pos = next;
    }
  };
  const flush = () => {
    if (segs.some((x) => x.s.trim())) out.push({ t: 'p', segs, joins, lvl: 0, kind: '', gap: 0 });
    segs = []; joins = '';
  };
  const used = new Set();
  const take = (id) => { for (const c of ctrlRecs) if (!used.has(c) && ctrlId(c) === id) { used.add(c); return c; } return null; };

  let pos = 0;
  for (const c of ctrls) {
    if (!OBJ_CTRL_CHARS.has(c.ch)) continue;
    const r = take(c.id);
    if (!r) continue;
    if (c.id === 'tbl ') {
      addText(pos, c.at); pos = c.at;
      flush();
      out.push(...tableBlock(st, r, pageAt(c.at)));
    } else if (c.id === 'gso ') {
      const inner = shapeText(st, r, pageAt(c.at));
      if (inner.length) { addText(pos, c.at); pos = c.at; flush(); out.push(...inner); }
    } else if (c.id === 'fn  ' || c.id === 'en  ') {
      addText(pos, c.at); pos = c.at;
      st.noteNo++;
      (c.id === 'fn  ' ? st.notes : st.endNotes).push({ id: st.noteNo, s: listTexts(st, r).join('\n') });
      const mark = noteMark(st.noteNo);
      const last = segs[segs.length - 1];
      if (last) last.s += mark; else segs.push({ s: mark, pg: pageAt(c.at) });
    }
    // 머리말·꼬리말·숨은 설명·자동 번호·책갈피 등은 글에 넣지 않는다
  }
  addText(pos, text.length);
  flush();

  // 첫 문단에 자동 번호를 붙이고 들여쓰기 위치를 잰다
  const label = headingLabel(st, shape);
  const first = out.find((b) => b.t === 'p');
  if (first) {
    const s0 = first.segs[0].s;
    const lead = s0.match(/^[ \u3000]*/)[0];
    const leadW = [...lead].reduce((a, ch) => a + (ch === '\u3000' ? 1000 : 500), 0);
    first.segs[0].s = label + s0.slice(lead.length);
    if (shape) {
      const x = shape.left / 2 + Math.max(0, shape.indent / 2) + leadW;
      st.xs.push(x);
      for (const b of out) if (b.t === 'p') b._x = x;
    }
  }
  if (!out.length) {
    if (!text.trim()) st.pendingGap = 1; // 빈 문단 → 다음 블록 앞 빈 줄
    return;
  }
  for (const b of out) {
    if (st.pendingGap) { b.gap = 1; st.pendingGap = 0; }
    st.blocks.push(b);
  }
}

// 목록(LIST_HEADER 와 그 뒤 형제 PARA_HEADER 들)
function listGroups(rec) {
  const groups = [];
  let cur = null;
  for (const k of rec.kids) {
    if (k.tag === T.LIST_HEADER) { cur = { head: k, paras: [] }; groups.push(cur); }
    else if (k.tag === T.PARA_HEADER && cur) cur.paras.push(k);
  }
  return groups;
}

// 안쪽 문단(표 칸·글상자·각주)의 글 — 표 안의 표는 줄글로 펴서
function innerParaText(st, p) {
  const { text, ctrls } = decodeParaText(p.kids.find((k) => k.tag === T.PARA_TEXT));
  const shape = st.info.paraShapes[paraHead(p).shapeId];
  const ctrlRecs = kidsOf(p, T.CTRL_HEADER);
  const used = new Set();
  let s = headingLabel(st, shape);
  let pos = 0;
  for (const c of ctrls) {
    if (!OBJ_CTRL_CHARS.has(c.ch)) continue;
    const r = ctrlRecs.find((x) => !used.has(x) && ctrlId(x) === c.id);
    if (!r) continue;
    used.add(r);
    if (c.id !== 'tbl ' && c.id !== 'gso ' && c.id !== 'fn  ' && c.id !== 'en  ') continue;
    s += text.slice(pos, c.at); pos = c.at;
    if (c.id === 'tbl ') {
      const rows = tableRows(st, r);
      const flat = rows.map((row) => row.filter(Boolean).map((cell) => cell.s.replace(/\n/g, ' ')).join(' | ')).filter((x) => x.trim()).join('\n');
      if (flat) s += (s && !s.endsWith('\n') ? '\n' : '') + flat + '\n';
    } else if (c.id === 'gso ') {
      const t = listTexts(st, r).join('\n');
      if (t) s += (s && !s.endsWith('\n') ? '\n' : '') + t;
    } else {
      st.noteNo++;
      (c.id === 'fn  ' ? st.notes : st.endNotes).push({ id: st.noteNo, s: listTexts(st, r).join('\n') });
      s += noteMark(st.noteNo);
    }
  }
  s += text.slice(pos);
  return s.replace(/\s+$/, '');
}

// 개체(글상자·묶음 개체)의 모든 목록 글을 문서 순서대로
function listTexts(st, rec) {
  const out = [];
  const walk = (r) => {
    for (const g of listGroups(r)) for (const p of g.paras) out.push(innerParaText(st, p));
    for (const k of r.kids) if (k.tag !== T.PARA_HEADER && k.tag !== T.LIST_HEADER) walk(k);
  };
  walk(rec);
  return out;
}

function shapeText(st, rec, pg) {
  const texts = listTexts(st, rec).map((s) => s.trim()).filter(Boolean);
  return texts.map((s) => ({ t: 'p', segs: [{ s, pg }], joins: '', lvl: 0, kind: '', gap: 0 }));
}

// 표 → 칸 격자
function tableRows(st, rec) {
  const tbl = rec.kids.find((k) => k.tag === T.TABLE);
  let nRows = 0, nCols = 0;
  if (tbl && tbl.data.length >= 8) { const dv = dvOf(tbl); nRows = dv.getUint16(4, true); nCols = dv.getUint16(6, true); }
  const cells = [];
  let afterTable = false;
  let cur = null;
  for (const k of rec.kids) {
    if (k.tag === T.TABLE) { afterTable = true; continue; }
    if (!afterTable) continue;
    if (k.tag === T.LIST_HEADER) {
      const dv = dvOf(k);
      const ok = k.data.length >= 16;
      cur = {
        col: ok ? dv.getUint16(8, true) : 0,
        row: ok ? dv.getUint16(10, true) : 0,
        cs: ok ? Math.max(1, dv.getUint16(12, true)) : 1,
        rs: ok ? Math.max(1, dv.getUint16(14, true)) : 1,
        paras: [],
      };
      cells.push(cur);
    } else if (k.tag === T.PARA_HEADER && cur) cur.paras.push(k);
  }
  for (const c of cells) { nRows = Math.max(nRows, c.row + c.rs); nCols = Math.max(nCols, c.col + c.cs); }
  if (nRows > 5000 || nCols > 500) return [];
  const rows = Array.from({ length: nRows }, () => new Array(nCols).fill(null));
  for (const c of cells) {
    if (c.row >= nRows || c.col >= nCols) continue;
    const s = c.paras.map((p) => innerParaText(st, p)).join('\n').replace(/\s+$/, '');
    rows[c.row][c.col] = { s, cs: c.cs, rs: c.rs };
  }
  return rows;
}

function tableBlock(st, rec, pg) {
  const out = [];
  // 표 제목(캡션)은 표 레코드 앞의 목록. 방향(목록 머리 8바이트 뒤 속성의 낮은 2비트): 0 왼쪽, 1 오른쪽, 2 위, 3 아래
  let cap = '';
  let capBelow = false;
  const capGroups = [];
  let cur = null;
  for (const k of rec.kids) {
    if (k.tag === T.TABLE) break;
    if (k.tag === T.LIST_HEADER) { cur = { head: k, paras: [] }; capGroups.push(cur); }
    else if (k.tag === T.PARA_HEADER && cur) cur.paras.push(k);
  }
  for (const g of capGroups) {
    const t = g.paras.map((p) => innerParaText(st, p)).join(' ').trim();
    if (t) cap += (cap ? ' ' : '') + t;
    if (g.head.data.length >= 12 && (dvOf(g.head).getUint32(8, true) & 3) === 3) capBelow = true;
  }
  const withCaption = (blocks) => {
    if (!cap) return blocks;
    const cb = { t: 'p', segs: [{ s: cap, pg }], joins: '', lvl: 0, kind: 'cap', gap: capBelow ? 0 : 1 };
    return capBelow ? blocks.concat(cb) : [cb].concat(blocks);
  };
  const rows = tableRows(st, rec);
  if (!rows.length) return withCaption(out);
  // 칸이 하나뿐인 표(글상자처럼 쓴 것)는 문단으로 푼다
  const filled = rows.flat().filter((c) => c && c.s.trim());
  if (filled.length <= 1 && rows.length * (rows[0] ? rows[0].length : 0) <= 2) {
    if (filled[0]) for (const line of filled[0].s.split('\n')) if (line.trim()) out.push({ t: 'p', segs: [{ s: line.replace(/^[ \u3000]+/, ''), pg }], joins: '', lvl: 0, kind: '', gap: 0 });
    if (out.length) out[0].gap = 1;
    return withCaption(out);
  }
  out.push({ t: 'tbl', rows, pg, gap: 1 });
  return withCaption(out);
}
