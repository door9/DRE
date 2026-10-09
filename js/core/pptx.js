// 파워포인트 PPTX(PPSX·PPTM) 읽기 — 슬라이드마다 도형의 글·표·스마트아트·차트 제목을 모아 문서 모델로.
// 자리표시자(제목·본문)의 자리와 글머리는 레이아웃·마스터에서 이어받는다. 숨긴 슬라이드는 뺀다.
import { unzipSync, strFromU8 } from '../../vendor/fflate.mjs';
import { parseXml, kids, kid, attr, descendants } from './xml.js';
import { slidesToModel, autoNumber } from './slides.js';
import { resolvePath } from './xlsx.js';
import { SOFT_BREAK } from './hwp.js';
import { symbolChar, isSymbolFont, fixSymbolText } from './symbols.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const EMU = 12700; // 1pt

function readZip(u8) {
  try {
    return unzipSync(u8, { filter: (f) => /^(ppt\/|_rels\/)/i.test(f.name) && /\.(xml|rels)$/i.test(f.name) && !/^ppt\/(notesSlides|notesMasters|handoutMasters|comments|commentAuthors|tags|customXml)\//i.test(f.name) });
  } catch {
    throw fail('broken', '파워포인트 파일의 압축을 풀지 못했습니다(손상된 파일일 수 있습니다)');
  }
}

function makeReader(files) {
  const cache = new Map();
  const xml = (name) => {
    if (!cache.has(name)) cache.set(name, files[name] ? parseXml(strFromU8(files[name])) : null);
    return cache.get(name);
  };
  const relCache = new Map();
  const rels = (part) => {
    if (relCache.has(part)) return relCache.get(part);
    const i = part.lastIndexOf('/');
    const dir = i >= 0 ? part.slice(0, i + 1) : '';
    const r = xml(dir + '_rels/' + part.slice(i + 1) + '.rels');
    const map = new Map();
    for (const x of descendants(r, 'Relationship')) {
      if (attr(x, 'TargetMode') === 'External') continue;
      map.set(attr(x, 'Id'), { target: resolvePath(dir, attr(x, 'Target') || ''), type: attr(x, 'Type') || '' });
    }
    relCache.set(part, map);
    return map;
  };
  const relOfType = (part, re) => { for (const v of rels(part).values()) if (re.test(v.type)) return v.target; return null; };
  return { xml, rels, relOfType };
}

// 기호 글꼴(Wingdings·Symbol) 글머리 → 보통 글자
function bulletChar(ch, font) {
  if (!ch) return '•';
  const c = ch.codePointAt(0);
  if ((c >= 0xf000 && c <= 0xf0ff) || (isSymbolFont(font) && c < 0x100)) return symbolChar(c, font);
  return ch;
}

const num = (v, d = 0) => (v == null || v === '' || isNaN(+v) ? d : +v);

// 도형의 자리(pt) — 묶음 변환 적용
function xfrmOf(el) {
  let x = null;
  if (el.l === 'graphicFrame') x = kid(el, 'xfrm');
  else { const pr = kid(el, 'spPr') || kid(el, 'grpSpPr'); x = pr ? kid(pr, 'xfrm') : null; }
  if (!x) return null;
  const off = kid(x, 'off'), ext = kid(x, 'ext');
  if (!off) return null;
  const r = { x: num(attr(off, 'x')), y: num(attr(off, 'y')), w: num(attr(ext, 'cx')), h: num(attr(ext, 'cy')) };
  const chOff = kid(x, 'chOff'), chExt = kid(x, 'chExt');
  if (chOff) { r.cx = num(attr(chOff, 'x')); r.cy = num(attr(chOff, 'y')); r.cw = num(attr(chExt, 'cx')); r.ch = num(attr(chExt, 'cy')); }
  return r;
}
const applyT = (t, r) => {
  if (!t || !r) return r;
  const sx = t.cw ? t.w / t.cw : 1, sy = t.ch ? t.h / t.ch : 1;
  return { x: t.x + (r.x - (t.cx || 0)) * sx, y: t.y + (r.y - (t.cy || 0)) * sy, w: r.w * sx, h: r.h * sy };
};

// 자리표시자 정보
function phOf(sp) {
  const nv = kid(sp, 'nvSpPr') || kid(sp, 'nvGraphicFramePr') || kid(sp, 'nvPicPr');
  const ph = nv ? descendants(nv, 'ph')[0] : null;
  if (!ph) return null;
  return { type: attr(ph, 'type') || 'obj', idx: attr(ph, 'idx') ?? null };
}
const roleOf = (type) => (type === 'title' || type === 'ctrTitle' ? 'title' : type === 'dt' || type === 'ftr' || type === 'sldNum' || type === 'hdr' ? 'hf' : '');

// 레이아웃·마스터에서 같은 자리표시자 찾기(번호 먼저, 없으면 종류)
function findPh(tree, ph) {
  if (!tree || !ph) return null;
  const all = descendants(tree, 'sp');
  const norm = (t) => (t === 'ctrTitle' ? 'title' : t === 'subTitle' || t === 'obj' ? 'body' : t);
  if (ph.idx != null) { const m = all.find((s) => { const p = phOf(s); return p && p.idx === ph.idx; }); if (m) return m; }
  return all.find((s) => { const p = phOf(s); return p && norm(p.type) === norm(ph.type); }) || null;
}

function lvlProps(lstStyle, lvl) {
  return lstStyle ? kid(lstStyle, `lvl${lvl + 1}pPr`) : null;
}

// 글머리 정하기: 문단 → 도형 목록 꼴 → (자리표시자면) 레이아웃 → 마스터 자리표시자 → 마스터 글 꼴
function bulletOf(pPr, chain) {
  const srcs = [pPr, ...chain];
  let font = null;
  for (const s of srcs) { const f = s && kid(s, 'buFont'); if (f) { font = attr(f, 'typeface'); break; } }
  for (const s of srcs) {
    if (!s) continue;
    if (kid(s, 'buNone')) return null;
    const ch = kid(s, 'buChar');
    if (ch) return { char: bulletChar(attr(ch, 'char'), font) };
    const an = kid(s, 'buAutoNum');
    if (an) return { auto: attr(an, 'type') || 'arabicPeriod', start: num(attr(an, 'startAt'), 1) };
    if (kid(s, 'buBlip')) return { char: '•' };
  }
  return null;
}

function paraText(p) {
  let s = '';
  for (const k of kids(p)) {
    if (k.l === 'r' || k.l === 'fld') {
      // 기호 글꼴 글자(사용자 정의 영역)는 보통 글자로
      const rPr = kid(k, 'rPr');
      const font = rPr ? attr(kid(rPr, 'sym'), 'typeface') || attr(kid(rPr, 'latin'), 'typeface') || '' : '';
      s += fixSymbolText(descendants(k, 't').map((t) => t.c.join('')).join(''), font);
    } else if (k.l === 'br') s += SOFT_BREAK;
  }
  return s;
}

// 글 상자 → 문단들
function textParas(txBody, chainFor) {
  const out = [];
  if (!txBody) return out;
  const lst = kid(txBody, 'lstStyle');
  const counters = [];
  for (const p of kids(txBody, 'p')) {
    const pPr = kid(p, 'pPr');
    const lvl = Math.max(0, Math.min(8, num(attr(pPr, 'lvl'))));
    const s = paraText(p);
    const chain = [lvlProps(lst, lvl), ...chainFor(lvl)];
    let bullet = null;
    if (s.trim()) {
      const b = bulletOf(pPr, chain);
      if (b && b.auto) {
        counters[lvl] = (counters[lvl] ?? b.start - 1) + 1;
        counters.length = lvl + 1;
        bullet = autoNumber(b.auto, counters[lvl]);
      } else {
        counters.length = lvl;
        if (b) bullet = b.char;
      }
    }
    out.push({ s, lvl, bullet });
  }
  return out;
}

function cellParas(tc) {
  const tb = kid(tc, 'txBody');
  return tb ? kids(tb, 'p').map(paraText).join('\n').replace(/\s+$/, '') : '';
}

function tableOf(tbl) {
  const rows = [];
  for (const tr of kids(tbl, 'tr')) {
    const row = [];
    for (const tc of kids(tr, 'tc')) {
      if (attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1' || attr(tc, 'hMerge') === 'true' || attr(tc, 'vMerge') === 'true') { row.push(null); continue; }
      row.push({ s: cellParas(tc), cs: Math.max(1, num(attr(tc, 'gridSpan'), 1)), rs: Math.max(1, num(attr(tc, 'rowSpan'), 1)) });
    }
    rows.push(row);
  }
  const n = Math.max(0, ...rows.map((r) => r.length));
  for (const r of rows) while (r.length < n) r.push(null);
  return rows.some((r) => r.some((c) => c && c.s.trim())) ? rows : null;
}

// 스마트아트: 자료 모델(점·연결)로 나무를 세워 차례대로
function smartArtParas(rd, slidePart, frame) {
  const ids = descendants(frame, 'relIds')[0];
  if (!ids) return [];
  const dm = rd.rels(slidePart).get(attr(ids, 'dm'));
  const data = dm && rd.xml(dm.target);
  if (!data) return [];
  const pts = new Map();
  for (const pt of descendants(data, 'pt')) {
    const type = attr(pt, 'type') || 'node';
    const t = kid(pt, 't');
    pts.set(attr(pt, 'modelId'), { type, text: t ? kids(t, 'p').map(paraText).join('\n').trim() : '' });
  }
  const children = new Map();
  for (const c of descendants(data, 'cxn')) {
    if ((attr(c, 'type') || 'parOf') !== 'parOf') continue;
    const src = attr(c, 'srcId');
    if (!children.has(src)) children.set(src, []);
    children.get(src).push({ id: attr(c, 'destId'), ord: num(attr(c, 'srcOrd')) });
  }
  const root = [...pts.entries()].find(([, v]) => v.type === 'doc');
  const out = [];
  const seen = new Set();
  const walk = (id, depth) => {
    if (seen.has(id) || depth > 20) return;
    seen.add(id);
    const p = pts.get(id);
    // 칸 안 줄바꿈(문단·강제 줄바꿈)마다 한 줄로(파워포인트도 칸 글을 줄마다 나눠 보여 준다)
    if (p && (p.type === 'node' || p.type === 'asst') && p.text) for (const line of p.text.split(/[\n\u2028]/)) if (line.trim()) out.push({ s: line, lvl: Math.max(0, depth - 1), bullet: null });
    for (const ch of (children.get(id) || []).sort((a, b) => a.ord - b.ord)) walk(ch.id, depth + 1);
  };
  if (root) walk(root[0], 0);
  else for (const [id, p] of pts) if ((p.type === 'node' || p.type === 'asst') && p.text && !seen.has(id)) out.push({ s: p.text, lvl: 0, bullet: null });
  return out;
}

function chartTitle(rd, slidePart, frame) {
  const c = descendants(frame, 'chart')[0];
  const rel = c && rd.rels(slidePart).get(attr(c, 'id'));
  const ch = rel && rd.xml(rel.target);
  const title = ch && descendants(ch, 'title')[0];
  if (!title) return [];
  const t = descendants(title, 'p').map(paraText).join(' ').trim();
  return t ? [{ s: t, lvl: 0, bullet: null }] : [];
}

function readSlide(rd, part, ctx) {
  const sld = rd.xml(part);
  const root = kid(sld, 'sld') || sld;
  const hidden = attr(root, 'show') === '0' || attr(root, 'show') === 'false';
  const layoutPart = rd.relOfType(part, /\/slideLayout$/);
  const layout = layoutPart ? rd.xml(layoutPart) : null;
  const masterPart = layoutPart ? rd.relOfType(layoutPart, /\/slideMaster$/) : null;
  const master = masterPart ? rd.xml(masterPart) : null;
  const txStyles = master ? descendants(master, 'txStyles')[0] : null;
  const shapes = [];
  const visit = (el, T) => {
    for (const k of kids(el)) {
      if (k.l === 'AlternateContent') { const ch = kid(k, 'Choice') || kid(k, 'Fallback'); if (ch) visit(ch, T); continue; }
      if (k.l === 'grpSp') { const x = xfrmOf(k); visit(k, x ? { ...applyT(T, x), cx: x.cx, cy: x.cy, cw: x.cw, ch: x.ch } : T); continue; }
      if (k.l === 'sp') {
        const ph = phOf(k);
        let x = xfrmOf(k);
        let layoutSp = null, masterSp = null;
        if (ph) { layoutSp = findPh(layout, ph); masterSp = findPh(master, ph); }
        if (!x) x = (layoutSp && xfrmOf(layoutSp)) || (masterSp && xfrmOf(masterSp));
        const pos = applyT(T, x) || { x: 0, y: 0, w: 0, h: 0 };
        const masterStyle = ph ? (roleOf(ph.type) === 'title' ? kid(txStyles, 'titleStyle') : roleOf(ph.type) === 'hf' ? kid(txStyles, 'otherStyle') : kid(txStyles, 'bodyStyle')) : null;
        const chainFor = (lvl) => ph ? [
          lvlProps(kid(kid(layoutSp, 'txBody'), 'lstStyle'), lvl),
          lvlProps(kid(kid(masterSp, 'txBody'), 'lstStyle'), lvl),
          lvlProps(masterStyle, lvl),
        ] : [lvlProps(ctx.defaultStyle, lvl)];
        const paras = textParas(kid(k, 'txBody'), chainFor);
        if (paras.some((p) => p.s.trim())) shapes.push({ ...scale(pos), role: ph ? roleOf(ph.type) : '', paras, table: null });
        continue;
      }
      if (k.l === 'graphicFrame') {
        const pos = applyT(T, xfrmOf(k)) || { x: 0, y: 0, w: 0, h: 0 };
        const gd = descendants(k, 'graphicData')[0];
        const uri = attr(gd, 'uri') || '';
        const tbl = descendants(k, 'tbl')[0];
        if (tbl) { const rows = tableOf(tbl); if (rows) shapes.push({ ...scale(pos), role: '', paras: [], table: rows }); continue; }
        let paras = [];
        if (/diagram/.test(uri)) paras = smartArtParas(rd, part, k);
        else if (/chart/.test(uri)) paras = chartTitle(rd, part, k);
        if (paras.length) shapes.push({ ...scale(pos), role: '', paras, table: null });
      }
    }
  };
  const tree = descendants(root, 'spTree')[0];
  if (tree) visit(tree, null);
  return { hidden, shapes };
}
const scale = (p) => ({ x: p.x / EMU, y: p.y / EMU, w: p.w / EMU, h: p.h / EMU });

export function parsePptx(bytes, { onProgress, slidesOnly = false } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0xd0 && u8[1] === 0xcf) throw fail('password', '암호가 걸린 파워포인트 문서입니다');
  const files = readZip(u8);
  const rd = makeReader(files);
  let presPart = 'ppt/presentation.xml';
  for (const r of rd.rels('').values()) if (/officeDocument$/.test(r.type) && files[r.target]) presPart = r.target;
  const pres = rd.xml(presPart);
  if (!pres) throw fail('broken', '파워포인트 문서 본문을 찾지 못했습니다');
  const ctx = { defaultStyle: descendants(pres, 'defaultTextStyle')[0] || null };
  const presRels = rd.rels(presPart);
  const slides = [];
  const ids = descendants(pres, 'sldId');
  ids.forEach((s, i) => {
    const rel = presRels.get(attrRid(s));
    if (!rel || !rd.xml(rel.target)) return;
    slides.push(readSlide(rd, rel.target, ctx));
    if (onProgress) onProgress((i + 1) / ids.length);
  });
  if (slidesOnly) return { slides };
  return slidesToModel('pptx', slides);
}

// sldId 의 r:id(이름이 'id' 인 속성이 둘: 번호 id 와 관계 r:id)
function attrRid(el) {
  for (const k in el.a) if (/^[\w]+:id$/.test(k)) return el.a[k];
  return el.a['r:id'];
}
