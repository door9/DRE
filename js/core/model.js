// 문서 모델 — 모든 추출기(PDF·한글·워드)가 내놓는 공통 모양과, 그것을 옵션에 따라 글(txt)로 그려 내는 부분.
//
// doc = {
//   format: 'pdf'|'hwp'|'hwpx'|'docx'|'doc',
//   pages: 쪽 수(모르면 null), pageExact: 쪽 정보가 정확한가(PDF) 추정인가(한글·워드),
//   blocks: [...], notes: [{ id, s }], warnings: [문장], title
// }
// 블록:
//   문단  { t:'p', segs:[{ s:글, pg:쪽 }], joins:'SNHG…'(segs 사이 이음, 길이=segs-1), lvl:들여쓰기 단계, kind:''|'h'|'li'|'hf'|'cap', gap:앞 빈 줄 수, cont:앞 쪽 문단에 이어지는가 }
//   표    { t:'tbl', rows:[[{ s, cs, rs } | null]], pg, gap }
// 이음 기호: S=띄어 잇기, N=붙여 잇기(이 둘은 '줄 이어 붙이기'를 끄면 줄바꿈), H=원래 줄바꿈, G=무조건 붙임(쪽 경계 등)

export const NOTE_OPEN = '\ue000';
export const NOTE_CLOSE = '\ue001';
export const noteMark = (id) => NOTE_OPEN + id + NOTE_CLOSE;

export const DEFAULT_OPTIONS = {
  reflow: true,        // 줄 이어 붙이기(PDF)
  joinPages: true,     // 쪽을 넘어가는 문단 잇기
  dropHeaderFooter: true, // 머리말·꼬리말·쪽 번호 빼기
  indent: '  ',        // 단계마다 들여쓰기 글자('' 이면 없음)
  blank: 'source',     // 문단 사이 빈 줄: source(원본 간격대로) | none | all
  table: 'tab',        // 표: tab(칸을 탭으로) | grid(선으로 그린 표) | lines(칸마다 한 줄)
  notes: 'end',        // 각주: end(끝에 모음) | none
  pageMarks: false,    // 쪽 구분 표시
  eol: '\r\n',         // 줄 끝
};

// 쪽 범위: null 이면 전체. 아니면 Set 또는 { has(n) }
function inRange(range, pg) {
  return !range || pg == null || range.has(pg);
}

// 눈에 보이는 폭(한글·한자 등은 2칸)
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
export function dispWidth(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 32) continue;
    w += (c >= 0x20000 || WIDE.test(ch)) ? 2 : 1;
  }
  return w;
}

function joinWith(code, opts) {
  switch (code) {
    case 'S': return opts.reflow ? ' ' : '\n';
    case 'N': return opts.reflow ? '' : '\n';
    case 'H': return '\n';
    case 'G': return '';
    default: return ' ';
  }
}

// 문단 하나를 글로(범위 밖 조각은 뺀다). 남는 것이 없으면 null.
function paraText(b, range, opts) {
  let out = '';
  let prevKept = -1;
  for (let i = 0; i < b.segs.length; i++) {
    const seg = b.segs[i];
    if (!inRange(range, seg.pg)) continue;
    if (prevKept >= 0) {
      // 바로 앞 조각과 이어지면 그 이음을, 중간이 빠졌으면 띄어 잇는다
      out += prevKept === i - 1 ? joinWith(b.joins[i - 1], opts) : ' ';
    }
    out += seg.s;
    prevKept = i;
  }
  return prevKept < 0 ? null : out;
}

// 강제 줄바꿈 판단 결과(\ue010 띄워 잇기, \ue011 붙여 잇기)와 남은 줄 구분 글자를 옵션대로
function softText(s, opts) {
  if (!/[\ue010\ue011\u2028]/.test(s)) return s;
  if (!opts.reflow) return s.replace(/[\ue010\ue011\u2028]/g, '\n');
  return s.replace(/\ue010/g, ' ').replace(/\ue011/g, '').replace(/\u2028/g, '\n');
}

function cleanNotes(s, opts) {
  if (s.indexOf('\u200b') >= 0) s = s.replace(/\u200b/g, ''); // 폭 없는 빈칸(추출기가 자리만 지켜 둔 것)
  if (s.indexOf(NOTE_OPEN) < 0) return s;
  return s.replace(/\ue000([^\ue001]*)\ue001/g, (m, id) => (opts.notes === 'none' ? '' : `[${id}]`));
}

function firstPage(b) {
  if (b.t === 'tbl') return b.pg;
  for (const s of b.segs) if (s.pg != null) return s.pg;
  return null;
}

function blockInRange(b, range) {
  if (b.t === 'tbl') return inRange(range, b.pg);
  return b.segs.some((s) => inRange(range, s.pg));
}

// ─── 표 그리기 ───
function cellText(c) {
  return c ? c.s.replace(/\r/g, '') : '';
}

// 칸을 탭으로 — 글이 든 칸이 하나뿐인 줄(설명 상자처럼 쓴 표)은 칸 안의 줄바꿈·들여쓰기를 살린다
function tableTab(rows) {
  const out = [];
  for (const r of rows) {
    const full = r.filter((c) => c && cellText(c).trim() !== '');
    if (full.length === 1) {
      for (const l of cellText(full[0]).split('\n')) if (l.trim()) out.push(l.replace(/\s+$/, ''));
      continue;
    }
    const line = r.map((c) => cellText(c).trim().replace(/\s*\n\s*/g, ' ').replace(/\t/g, ' ')).join('\t').replace(/\t+$/, '');
    if (line.trim()) out.push(line);
  }
  return out;
}

function tableLines(rows) {
  const out = [];
  for (const r of rows) {
    const cells = r.filter((c) => c && cellText(c).trim() !== '').map((c) => cellText(c).trim());
    if (!cells.length) continue;
    if (out.length) out.push('');
    out.push(...cells.join('\n').split('\n'));
  }
  return out;
}

// 긴 칸은 폭에 맞춰 접는다(낱말을 되도록 지킨다)
function wrapDisplay(s, width) {
  const out = [];
  for (const para of s.split('\n')) {
    let line = '';
    let lw = 0;
    const words = para.split(/(\s+)/);
    for (const w of words) {
      if (!w) continue;
      const ww = dispWidth(w);
      if (lw + ww <= width) { line += w; lw += ww; continue; }
      if (/^\s+$/.test(w)) { out.push(line); line = ''; lw = 0; continue; }
      if (line.trim()) { out.push(line.replace(/\s+$/, '')); line = ''; lw = 0; }
      // 낱말 하나가 폭보다 길면 글자 단위로 자른다
      for (const ch of w) {
        const cw = dispWidth(ch);
        if (lw + cw > width && line) { out.push(line); line = ''; lw = 0; }
        line += ch; lw += cw;
      }
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

function padDisplay(s, width) {
  return s + ' '.repeat(Math.max(0, width - dispWidth(s)));
}

function tableGrid(rows) {
  const ncol = Math.max(0, ...rows.map((r) => r.length));
  if (!ncol) return [];
  const MAXW = 36;
  const widths = new Array(ncol).fill(2);
  for (const r of rows) {
    r.forEach((c, j) => {
      if (!c || (c.cs || 1) > 1) return;
      for (const line of cellText(c).split('\n')) widths[j] = Math.max(widths[j], Math.min(MAXW, dispWidth(line.trim())));
    });
  }
  // 합쳐진 칸이 좁으면 마지막 열을 넓힌다
  for (const r of rows) {
    r.forEach((c, j) => {
      const cs = c ? c.cs || 1 : 1;
      if (!c || cs <= 1) return;
      const need = Math.min(MAXW * cs, Math.max(...cellText(c).split('\n').map((l) => dispWidth(l.trim()))));
      let have = 0;
      for (let k = j; k < Math.min(ncol, j + cs); k++) have += widths[k];
      have += 3 * (cs - 1);
      if (need > have) widths[Math.min(ncol, j + cs) - 1] += need - have;
    });
  }
  const line = (l, m, r) => l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const out = [line('┌', '┬', '┐')];
  rows.forEach((r, ri) => {
    // 칸마다 접은 줄들
    const cols = [];
    for (let j = 0; j < ncol;) {
      const c = r[j];
      const cs = c ? Math.max(1, Math.min(c.cs || 1, ncol - j)) : 1;
      let w = 0;
      for (let k = j; k < j + cs; k++) w += widths[k];
      w += 3 * (cs - 1);
      cols.push({ w, lines: wrapDisplay(cellText(c).trim(), w) });
      j += cs;
    }
    const h = Math.max(1, ...cols.map((c) => c.lines.length));
    for (let k = 0; k < h; k++) out.push('│ ' + cols.map((c) => padDisplay(c.lines[k] || '', c.w)).join(' │ ') + ' │');
    out.push(ri === rows.length - 1 ? line('└', '┴', '┘') : line('├', '┼', '┤'));
  });
  return out;
}

export function renderTable(b, opts) {
  const rows = b.rows.map((r) => r.map((c) => (c ? { ...c, s: softText(c.s, opts) } : c)));
  if (opts.table === 'grid') return tableGrid(rows);
  if (opts.table === 'lines') return tableLines(rows);
  return tableTab(rows);
}

// 문서 모델 → 글
export function render(doc, options = {}, range = null) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const lines = [];
  let lastPage = null;
  let started = false;
  const pushBlank = () => { if (started && lines.length && lines[lines.length - 1] !== '') lines.push(''); };

  // 쪽을 넘어 이어지는 문단은 앞 문단에 붙인다(머리말·꼬리말을 뺄 때만)
  const blocks = [];
  for (const b of doc.blocks) {
    if (b.t === 'p' && b.kind === 'hf' && opts.dropHeaderFooter) continue;
    if (!blockInRange(b, range)) continue;
    if (b.t === 'p' && b.cont && opts.joinPages && opts.dropHeaderFooter) {
      const prev = blocks[blocks.length - 1];
      if (prev && prev.t === 'p' && prev.kind !== 'hf') {
        blocks[blocks.length - 1] = { ...prev, segs: prev.segs.concat(b.segs), joins: prev.joins + (b.contJoin || 'S') + b.joins };
        continue;
      }
    }
    blocks.push(b);
  }

  for (const b of blocks) {
    const pg = firstPage(b);
    if (opts.pageMarks && pg != null && pg !== lastPage) {
      pushBlank();
      lines.push(`──────── ${pg}쪽 ────────`);
      lines.push('');
    } else if (started) {
      const gap = opts.blank === 'none' ? 0 : opts.blank === 'all' ? 1 : Math.min(1, b.gap || 0);
      if (gap) pushBlank();
    }
    if (pg != null) lastPage = pg;
    if (b.t === 'tbl') {
      const tl = renderTable(b, opts).map((l) => cleanNotes(l, opts));
      if (!tl.length) continue;
      if (opts.blank !== 'none') pushBlank();
      lines.push(...tl);
      if (opts.blank !== 'none') lines.push('');
      started = true;
      continue;
    }
    let text = paraText(b, range, opts);
    if (text == null) continue;
    text = cleanNotes(softText(text, opts), opts);
    const pad = opts.indent && b.lvl > 0 ? opts.indent.repeat(Math.min(8, b.lvl)) : '';
    for (const l of text.split('\n')) lines.push(pad + l.replace(/\s+$/, ''));
    started = true;
  }

  if (opts.notes === 'end' && doc.notes && doc.notes.length) {
    const used = doc.notes.filter((n) => n.s && n.s.trim());
    if (used.length) {
      pushBlank();
      lines.push('[각주]');
      for (const n of used) lines.push(`[${n.id}] ${n.s.trim().replace(/\s*\n\s*/g, ' ')}`);
    }
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  while (lines.length && lines[0] === '') lines.shift();
  // 빈 줄이 여러 개 이어지지 않게
  const out = [];
  for (const l of lines) if (!(l === '' && out.length && out[out.length - 1] === '')) out.push(l);
  return out.join(opts.eol) + (out.length ? opts.eol : '');
}

// ─── 추출기들이 쓰는 도우미 ───
export function para(text, pg, extra = {}) {
  return { t: 'p', segs: [{ s: text, pg }], joins: '', lvl: 0, kind: '', gap: 0, ...extra };
}

// 들여쓰기 위치(숫자)들을 단계(0,1,2…)로 바꾼다: 가까운 값은 같은 단계로 묶는다
export function levelize(values, tolerance) {
  const uniq = [...new Set(values.filter((v) => v != null && isFinite(v)).map((v) => Math.round(v)))].sort((a, b) => a - b);
  const groups = [];
  for (const v of uniq) {
    if (groups.length && v - groups[groups.length - 1].max <= tolerance) groups[groups.length - 1].max = v;
    else groups.push({ min: v, max: v });
  }
  return (v) => {
    if (v == null || !isFinite(v)) return 0;
    const r = Math.round(v);
    const i = groups.findIndex((g) => r >= g.min - tolerance && r <= g.max + tolerance);
    return Math.max(0, i);
  };
}

// 쪽 범위 글("1-3, 5, 8-")을 쪽 번호 집합으로. 잘못되면 { error }
export function parseRange(text, total) {
  const s = String(text || '').replace(/\s+/g, '').replace(/[~∼〜–—]/g, '-').replace(/[쪽p]/gi, '');
  if (!s || s === '전체' || s === 'all') return { set: null, list: total ? Array.from({ length: total }, (_, i) => i + 1) : [] };
  const set = new Set();
  for (const part of s.split(/[,，、;]/)) {
    if (!part) continue;
    const m = part.match(/^(\d*)(-?)(\d*|끝)$/);
    if (!m || (!m[1] && !m[3])) return { error: `'${part}'을(를) 알아볼 수 없습니다` };
    let a = m[1] ? +m[1] : 1;
    let b = m[2] ? (m[3] && m[3] !== '끝' ? +m[3] : total || a) : a;
    if (a > b) [a, b] = [b, a];
    if (a < 1) return { error: '쪽 번호는 1부터입니다' };
    if (total && a > total) return { error: `전체가 ${total}쪽입니다` };
    if (total) b = Math.min(b, total);
    if (b - a > 100000) return { error: '범위가 너무 큽니다' };
    for (let i = a; i <= b; i++) set.add(i);
  }
  if (!set.size) return { error: '쪽을 하나 이상 고르세요' };
  const list = [...set].sort((x, y) => x - y);
  return { set, list };
}

// 쪽 번호 목록을 짧은 글로: [1,2,3,5,8,9] → "1-3, 5, 8-9"
export function formatRange(list) {
  const out = [];
  for (let i = 0; i < list.length;) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    out.push(i === j ? `${list[i]}` : `${list[i]}-${list[j]}`);
    i = j + 1;
  }
  return out.join(', ');
}
