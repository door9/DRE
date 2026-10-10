// PDF 글자 대응표(ToUnicode) 바로잡기 — 엣지(크롬)가 만든 PDF 에서 일부 글꼴의 빈칸이 제어 문자(U+0001 등)로, 한자가 강희 부수(⼈ 등)로 적히는 것을 바로.
// 글꼴이 여러 글자 번호를 한 모양에 이어 두면, 크롬은 그 모양의 글자로 가장 낮은 번호를 적는다(화면은 멀쩡하고 글 복사·찾기만 망가짐).
// 나눔고딕·Noto Sans CJK(빈칸), 한문 원문이 많은 고전 번역서 글꼴(한자)을 품은 전자책에서 실측. 고친 대응표만 파일 끝에 덧붙인다(증분 갱신 — 나머지는 한 바이트도 안 바뀐다).
// 고칠 것이 없거나 구조가 낯설면(상호 참조 스트림 등) 원래 바이트를 그대로 돌려준다.
import { unzlibSync } from '../../vendor/fflate.mjs';

const enc = new TextEncoder();
const ascii = (u8, a, b) => { let s = ''; for (let i = a; i < b; i++) s += String.fromCharCode(u8[i]); return s; };

// 바이트 속 글자열 찾기(앞에서부터)
function indexOfBytes(u8, pat, from = 0) {
  const p = enc.encode(pat);
  const n = u8.length - p.length;
  const p0 = p[0];
  outer: for (let i = Math.max(0, from); i <= n; i++) {
    if (u8[i] !== p0) continue;
    for (let k = 1; k < p.length; k++) if (u8[i + k] !== p[k]) continue outer;
    return i;
  }
  return -1;
}
function lastIndexOfBytes(u8, pat, from = u8.length - 1) {
  const p = enc.encode(pat);
  for (let i = Math.min(from, u8.length - p.length); i >= 0; i--) {
    let ok = true;
    for (let k = 0; k < p.length; k++) if (u8[i + k] !== p[k]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

// 마지막 상호 참조표(xref)와 트레일러 읽기. 고전 표가 아니면 null
function readXref(u8) {
  const sx = lastIndexOfBytes(u8, 'startxref', u8.length - 1);
  if (sx < 0) return null;
  const tail = ascii(u8, sx, Math.min(u8.length, sx + 64));
  const m = /startxref\s+(\d+)/.exec(tail);
  if (!m) return null;
  const xo = +m[1];
  if (ascii(u8, xo, xo + 4) !== 'xref') return null;
  const tr = indexOfBytes(u8, 'trailer', xo);
  if (tr < 0) return null;
  const table = ascii(u8, xo + 4, tr);
  const offsets = new Map();
  const lines = table.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  let num = 0, left = 0;
  for (const l of lines) {
    const parts = l.split(/\s+/);
    if (left === 0 && parts.length === 2) { num = +parts[0]; left = +parts[1]; continue; }
    if (parts.length >= 3 && left > 0) {
      if (parts[2] === 'n') offsets.set(num, { off: +parts[0], gen: +parts[1] });
      num++; left--;
    }
  }
  const dictEnd = indexOfBytes(u8, 'startxref', tr);
  const trailer = ascii(u8, tr + 7, dictEnd < 0 ? Math.min(u8.length, tr + 4096) : dictEnd);
  // 트레일러에 /Prev 가 있으면(이미 고친 파일 등) 손대지 않는다 — 앞 표의 개체를 놓칠 수 있어서
  if (/\/Prev\s/.test(trailer)) return null;
  return { xrefOffset: xo, offsets, trailer };
}

// 개체 하나의 스트림(사전 + 날 바이트). 길이가 간접 참조여도 읽는다
function readStream(u8, xr, num) {
  const at = xr.offsets.get(num);
  if (!at) return null;
  const head = ascii(u8, at.off, Math.min(u8.length, at.off + 2048));
  const m = /^\s*(\d+)\s+(\d+)\s+obj\s*<<([\s\S]*?)>>\s*stream(\r\n|\n|\r)/.exec(head);
  if (!m || +m[1] !== num) return null;
  const dict = m[3];
  let len = null;
  const dl = /\/Length\s+(\d+)(\s+(\d+)\s+R)?/.exec(dict);
  if (dl && !dl[2]) len = +dl[1];
  else if (dl) {
    const ref = xr.offsets.get(+dl[1]);
    const t = ref ? ascii(u8, ref.off, Math.min(u8.length, ref.off + 64)) : '';
    const v = /obj\s+(\d+)/.exec(t);
    if (v) len = +v[1];
  }
  if (len == null) return null;
  const start = at.off + m[0].length;
  return { gen: at.gen, dict, data: u8.subarray(start, start + len), flate: /\/FlateDecode/.test(dict) && !/\/DecodeParms/.test(dict) };
}

// 도착 글자 바로잡기(UTF-16 한 단위만): 제어 문자 → 빈칸, 강희 부수·한중일 부수 보충(⼈ U+2F08 등) → 보통 한자(人 U+4EBA, 유니코드 NFKC 대응).
// 부수 쪽이 번호가 낮아, 글꼴이 둘을 같은 모양에 이어 두면 크롬이 부수를 적는다(보기엔 같지만 '人' 으로 찾으면 안 나온다 — 고전 번역서 PDF 실측).
// 고칠 것이 아니면 null
function fixDst(hex) {
  if (hex.length !== 4) return null;
  const c = parseInt(hex, 16);
  if (c < 0x20) return 0x20;
  if ((c >= 0x2f00 && c <= 0x2fd5) || (c >= 0x2e80 && c <= 0x2ef3)) {
    const n = String.fromCharCode(c).normalize('NFKC');
    if (n.length === 1 && n.charCodeAt(0) !== c) return n.charCodeAt(0);
  }
  return null;
}
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');

// CMap 글에서 도착 글자를 바로잡는다(위 fixDst). 바뀐 게 없으면 null
export function fixCmapText(cm) {
  let changed = false;
  let extra = []; // bfrange 를 쪼개서 생긴 낱개 대응
  let out = cm.replace(/beginbfchar([\s\S]*?)endbfchar/g, (all, body) => {
    const nb = body.replace(/(<[0-9A-Fa-f]+>)(\s*)<([0-9A-Fa-f]+)>/g, (m, src, sp, dst) => {
      const f = fixDst(dst);
      if (f == null) return m;
      changed = true;
      return `${src}${sp}<${hex4(f)}>`;
    });
    return 'beginbfchar' + nb + 'endbfchar';
  });
  out = out.replace(/(\d+)\s+beginbfrange([\s\S]*?)endbfrange/g, (all, cnt, body) => {
    const keep = [];
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
    let m, dropped = 0;
    while ((m = re.exec(body))) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), w = m[1].length;
      if (m[4] !== undefined) {
        const d0 = parseInt(m[4], 16);
        // 한 글자(UTF-16 한 단위) 범위 안에 고칠 글자가 있으면 낱개로 쪼갠다
        let need = false;
        if (m[4].length === 4 && hi >= lo && hi - lo < 4096) for (let c = lo; c <= hi && !need; c++) need = fixDst(hex4(d0 + (c - lo))) != null;
        if (need) {
          changed = true; dropped++;
          for (let c = lo; c <= hi; c++) {
            const d = d0 + (c - lo);
            const f = fixDst(hex4(d));
            extra.push(`<${c.toString(16).toUpperCase().padStart(w, '0')}> <${hex4(f == null ? d : f)}>`);
          }
          continue;
        }
        keep.push(m[0]);
      } else {
        const arr = m[5].replace(/<([0-9A-Fa-f]+)>/g, (x, h) => { const f = fixDst(h); if (f != null) { changed = true; return `<${hex4(f)}>`; } return x; });
        keep.push(`<${m[1]}> <${m[2]}> [${arr}]`);
      }
    }
    if (!dropped && keep.join('') === (body.match(re) || []).join('')) return all;
    return keep.length ? `${keep.length} beginbfrange\n${keep.join('\n')}\nendbfrange` : '';
  });
  if (!changed) return null;
  if (extra.length) {
    const blocks = [];
    for (let i = 0; i < extra.length; i += 100) {
      const part = extra.slice(i, i + 100);
      blocks.push(`${part.length} beginbfchar\n${part.join('\n')}\nendbfchar\n`);
    }
    out = out.replace(/endcmap/, blocks.join('') + 'endcmap');
  }
  return out;
}

// bytes(Uint8Array) → 고친 bytes(같은 것일 수 있음)와 고친 대응표 수
export function fixToUnicode(u8) {
  const none = { bytes: u8, fixed: 0 };
  if (indexOfBytes(u8, '/ToUnicode') < 0) return none;
  const xr = readXref(u8);
  if (!xr) return none;
  // 대응표 개체 번호 모으기
  const nums = new Set();
  let i = 0;
  while ((i = indexOfBytes(u8, '/ToUnicode', i)) >= 0) {
    const m = /^\/ToUnicode\s+(\d+)\s+(\d+)\s+R/.exec(ascii(u8, i, Math.min(u8.length, i + 40)));
    if (m) nums.add(+m[1]);
    i += 10;
  }
  const fixedObjs = [];
  for (const num of nums) {
    const st = readStream(u8, xr, num);
    if (!st) continue;
    let raw;
    try { raw = st.flate ? unzlibSync(st.data) : st.data; } catch { continue; }
    const text = ascii(raw, 0, raw.length);
    const fixed = fixCmapText(text);
    if (fixed) fixedObjs.push({ num, gen: st.gen, text: fixed });
  }
  if (!fixedObjs.length) return none;
  // 덧붙이기: 고친 개체(압축 없이) → 새 상호 참조표 → 트레일러(/Prev 로 앞 표를 잇는다)
  const chunks = [];
  let pos = u8.length;
  const lead = u8[u8.length - 1] === 0x0a ? '' : '\n';
  const add = (s) => { const b = enc.encode(s); chunks.push(b); pos += b.length; };
  add(lead);
  const offs = [];
  for (const o of fixedObjs.sort((a, b) => a.num - b.num)) {
    offs.push({ num: o.num, gen: o.gen, off: pos });
    const body = enc.encode(o.text);
    add(`${o.num} ${o.gen} obj\n<< /Length ${body.length} >>\nstream\n`);
    chunks.push(body); pos += body.length;
    add('\nendstream\nendobj\n');
  }
  const xo = pos;
  let x = 'xref\n';
  for (const o of offs) x += `${o.num} 1\n${String(o.off).padStart(10, '0')} ${String(o.gen).padStart(5, '0')} n\r\n`;
  const keep = (key) => { const m = new RegExp('/' + key + '\\s+(\\d+\\s+\\d+\\s+R|\\[[^\\]]*\\]|\\d+)').exec(xr.trailer); return m ? ` /${key} ${m[1]}` : ''; };
  x += `trailer\n<<${keep('Size')}${keep('Root')}${keep('Info')}${keep('ID')} /Prev ${xr.xrefOffset} >>\nstartxref\n${xo}\n%%EOF\n`;
  add(x);
  const out = new Uint8Array(pos);
  out.set(u8, 0);
  let p = u8.length;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return { bytes: out, fixed: fixedObjs.length };
}
