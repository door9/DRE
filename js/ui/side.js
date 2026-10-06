// 오른쪽 패널 — 고른 파일의 쪽 고르기(쪽 그림), 글 미리 보기(텍스트 추출), 합칠 이름·책갈피(합치기)
import { store, on, selectedItem, updateItem, emit } from '../store.js';
import { settings, saveSettings, renderOptions } from '../settings.js';
import { h, ico, esc, fmtNum, infoToggle, toast, debounce, baseName } from '../util.js';
import { parseRange, formatRange, render } from '../core/model.js';
import { IMAGES, OFFICE, kindLabel } from '../core/detect.js';
import { ensurePdf, ensureText } from '../produce.js';
import { openThumbDoc, renderThumb } from '../thumbs.js';
import { engine, engineReady, launchEngine, onEngine } from '../engine.js';
import { mergeName, runnable } from '../run.js';
import { prepareSave, saveOutput, textBlob } from '../save.js';

const side = () => document.getElementById('side');
let current = null;        // 지금 패널에 그린 항목
let thumbState = null;     // { item, h(PDF 손잡이), observer, renders }
let textAbort = null;

function closeThumbs() {
  if (!thumbState) return;
  thumbState.observer && thumbState.observer.disconnect();
  for (const r of thumbState.renders.values()) r.cancel();
  thumbState.h && thumbState.h.close();
  thumbState = null;
}

// ─── 쪽 고르기 ───
function rangeSection(it, { open = true } = {}) {
  const total = it.pdfPages || (it.kind === 'pdf' ? it.pages : null) || it.pages;
  const wrap = h('div.range-sec', { 'data-info-host': '' });
  const input = h('input.range-input', { type: 'text', placeholder: '예: 1-3, 5, 8-', 'aria-label': '쪽 범위', value: it.range ? formatRange(it.range) : '' });
  const status = h('span.stat');
  const head = h('div.row',
    h('strong', { text: '쪽 고르기' }),
    input,
    h('button.btn.tiny', { type: 'button', text: '전체', onclick: () => commit(null) }),
    h('button.btn.tiny', { type: 'button', text: '홀수', onclick: () => commitFn((n) => n % 2 === 1) }),
    h('button.btn.tiny', { type: 'button', text: '짝수', onclick: () => commitFn((n) => n % 2 === 0) }),
    status,
    infoToggle('<p>쪽 그림을 누르면 고르거나 뺍니다. <b>Shift</b>를 누른 채 누르면 사이의 쪽을 한꺼번에 고릅니다.</p><p>칸에 직접 적어도 됩니다: <code>1-3, 5, 8-</code>(8쪽부터 끝까지).</p><p>한글·워드 문서의 쪽 그림은 DRE 엔진이 PDF로 바꿔 보여 줍니다.</p>'),
  );
  wrap.append(head);
  const grid = h('div.thumbs');
  const note = h('div.side-note.small');
  wrap.append(note, grid);

  const pagesTotal = () => it.pdfPages || (it.kind === 'pdf' ? it.pages : null) || it.pages || 0;
  const showStatus = () => {
    const t = pagesTotal();
    const n = it.range ? it.range.length : t;
    status.textContent = t ? `${fmtNum(t)}쪽 중 ${fmtNum(n)}쪽` : '';
    input.classList.remove('bad');
  };
  function commit(list) {
    const t = pagesTotal();
    let v = list && list.length ? [...new Set(list)].sort((a, b) => a - b) : null;
    if (v && t && v.length === t) v = null;
    if (list && !list.length) v = [];
    updateItem(it, { range: v, textDoc: it.kind === 'pdf' && (it.pages || 0) > 80 ? null : it.textDoc });
    input.value = v ? formatRange(v) : '';
    showStatus();
    paintSel();
    emit('range', it);
  }
  function commitFn(pred) {
    const t = pagesTotal();
    if (!t) return;
    commit(Array.from({ length: t }, (_, i) => i + 1).filter(pred));
  }
  input.addEventListener('change', () => {
    const r = parseRange(input.value, pagesTotal() || null);
    if (r.error) { input.classList.add('bad'); status.textContent = r.error; return; }
    commit(r.set ? r.list : null);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.dispatchEvent(new Event('change')); });

  let lastClick = null;
  function paintSel() {
    const sel = it.range ? new Set(it.range) : null;
    for (const el of grid.children) {
      const n = +el.dataset.page;
      const on = !sel || sel.has(n);
      el.classList.toggle('on', !!sel && on);
      el.classList.toggle('off', !!sel && !on);
    }
  }
  grid.addEventListener('click', (e) => {
    const el = e.target.closest('.thumb');
    if (!el) return;
    const n = +el.dataset.page;
    const t = pagesTotal();
    const all = Array.from({ length: t }, (_, i) => i + 1);
    let sel = new Set(it.range || all);
    if (!it.range) sel = new Set(); // 처음 누르면 '이 쪽만'부터 시작
    if (e.shiftKey && lastClick) {
      const [a, b] = [Math.min(lastClick, n), Math.max(lastClick, n)];
      for (let k = a; k <= b; k++) sel.add(k);
    } else if (sel.has(n)) sel.delete(n);
    else sel.add(n);
    lastClick = n;
    commit([...sel]);
  });

  async function loadThumbs() {
    closeThumbs();
    if (IMAGES.has(it.kind)) { note.textContent = '그림 한 장이 한 쪽이 됩니다'; return; }
    let src = null;
    if (it.kind === 'pdf') src = it.file;
    else if (it.pdf) src = it.pdf;
    else if (OFFICE.has(it.kind)) {
      if (!engineReady()) {
        note.innerHTML = '';
        note.append(
          h('div', { text: `${kindLabel(it.kind)} 문서의 쪽 그림을 보려면 DRE 엔진이 켜져 있어야 합니다.` }),
          h('div', { text: it.pages ? `(문서 안 정보로 어림한 쪽 수: 약 ${it.pages}쪽 — 칸에 직접 적어 고를 수 있습니다)` : '' }),
          h('button.btn', { type: 'button', style: 'margin-top:8px', html: `${ico('plug')}엔진 켜기`, onclick: () => launchEngine() }),
        );
        return;
      }
      note.innerHTML = '<span class="spin" style="display:inline-block;vertical-align:middle"></span> 쪽 그림을 만드는 중…';
      try {
        src = await ensurePdf(it);
      } catch (e) {
        if (current !== it) return;
        note.textContent = e.message;
        return;
      }
      if (current !== it) return;
    }
    if (!src) return;
    note.textContent = '';
    let hd;
    try {
      hd = await openThumbDoc(src, it.password);
    } catch (e) {
      if (e && e.name === 'PasswordException') {
        note.textContent = '';
        updateItem(it, { needsPassword: true, password: null });
        askPassword(it, () => loadThumbs(), e.code === 2);
        return;
      }
      note.textContent = 'PDF를 열지 못했습니다(손상된 파일일 수 있습니다)';
      return;
    }
    if (current !== it) { hd.close(); return; }
    if (it.kind !== 'pdf' && it.pdfPages !== hd.pages) updateItem(it, { pdfPages: hd.pages, pages: hd.pages, pageExact: true });
    showStatus();
    thumbState = { item: it, h: hd, renders: new Map(), observer: null };
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let p = 1; p <= hd.pages; p++) {
      frag.append(h('div.thumb', { 'data-page': p, title: `${p}쪽` }, h('div.ph'), h('span.pn', { text: p }), h('span.tick', { html: ico('check') })));
    }
    grid.append(frag);
    paintSel();
    const st = thumbState;
    st.observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const el = en.target;
        const p = +el.dataset.page;
        if (en.isIntersecting && !el.dataset.done) {
          const c = document.createElement('canvas');
          el.dataset.done = '1';
          // 다 그린 뒤에 자리표를 바꿔 끼운다(그리는 동안 칸 모양이 흔들리지 않게)
          st.renders.set(p, renderThumb(hd, p, c, 130, (cv) => { const ph = el.querySelector('.ph'); if (ph) ph.replaceWith(cv); }));
        }
      }
    }, { root: side(), rootMargin: '300px' });
    for (const el of grid.children) st.observer.observe(el);
  }

  showStatus();
  if (open) loadThumbs();
  wrap.reloadThumbs = loadThumbs;
  return wrap;
}

// ─── 글 미리 보기(텍스트 추출) ───
function textOptionsBar(onChange) {
  const t = settings.text;
  const chk = (key, label) => h('label.check', {}, h('input', { type: 'checkbox', checked: t[key] || null, onchange: (e) => { t[key] = e.target.checked; saveSettings(); onChange(); } }), label);
  const seg = (key, opts) => {
    const box = h('span.seg');
    for (const [v, label] of opts) {
      box.append(h('button', { type: 'button', 'aria-pressed': String(t[key] === v), text: label, onclick: () => { t[key] = v; saveSettings(); for (const b of box.children) b.setAttribute('aria-pressed', String(b.textContent === label)); onChange(); } }));
    }
    return box;
  };
  const bar = h('div.textbar', { 'data-info-host': '' },
    chk('reflow', '줄 이어 붙이기'),
    chk('dropHeaderFooter', '머리말·쪽 번호 빼기'),
    chk('indent', '들여쓰기'),
    h('span.field', {}, h('span', { text: '표' }), seg('table', [['tab', '탭'], ['grid', '선'], ['lines', '줄글']])),
    h('span.field', {}, h('span', { text: '빈 줄' }), seg('blank', [['source', '원본대로'], ['none', '없이'], ['all', '문단마다']])),
    chk('pageMarks', '쪽 표시'),
    infoToggle(`<p><b>줄 이어 붙이기</b>: PDF처럼 줄이 중간에 끊긴 글을 문장으로 다시 잇습니다('되었' + '습니다' → '되었습니다'). 끄면 원래 줄대로 둡니다.</p>
      <p><b>머리말·쪽 번호 빼기</b>: 쪽마다 되풀이되는 머리말·꼬리말과 쪽 번호를 뺍니다(PDF).</p>
      <p><b>표</b>: 탭 = 칸 사이를 탭으로(엑셀·한글 표에 붙여 넣기 좋음), 선 = 선으로 그린 표(고정폭 글꼴용), 줄글 = 칸마다 한 줄.</p>
      <p><b>쪽 표시</b>: 쪽이 바뀌는 곳에 '── 3쪽 ──'을 넣습니다.</p>`),
  );
  return bar;
}

function textSection(it) {
  const wrap = h('div.text-sec');
  const out = h('textarea.preview', { readonly: true, spellcheck: 'false', 'aria-label': '뽑은 글' });
  const stat = h('span.stat');
  const warnBox = h('div.warnbox', { hidden: true });
  const copyBtn = h('button.btn.tiny', { type: 'button', html: `${ico('copy')}복사`, disabled: true });
  const saveBtn = h('button.btn.tiny', { type: 'button', html: `${ico('save')}이 파일만 저장`, disabled: true });
  let doc = null;
  const draw = () => {
    if (!doc) return;
    const opts = renderOptions();
    const text = render(doc, { ...opts, eol: '\n' }, it.range ? new Set(it.range) : null);
    out.value = text;
    out.classList.toggle('mono', settings.text.table === 'grid');
    const lines = text ? text.split('\n').length : 0;
    stat.textContent = `${fmtNum(text.replace(/\s/g, '').length)}자 · ${fmtNum(lines)}줄`;
    copyBtn.disabled = saveBtn.disabled = !text;
    const warns = doc.warnings || [];
    warnBox.hidden = !warns.length;
    warnBox.textContent = warns.join(' ');
  };
  const bar = textOptionsBar(draw);
  const actions = h('div.row', { style: 'padding:6px 14px;border-bottom:1px solid var(--line)' }, copyBtn, saveBtn, h('div.grow'), stat);
  wrap.append(bar, actions, warnBox, out);

  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(out.value); toast('글을 복사했습니다'); } catch { out.select(); document.execCommand('copy'); toast('글을 복사했습니다'); }
  });
  saveBtn.addEventListener('click', async () => {
    try {
      const s = await prepareSave(settings.save, [it]);
      const text = render(doc, renderOptions(), it.range ? new Set(it.range) : null);
      const r = await saveOutput(s, it, `${baseName(it.name)}.txt`, textBlob(text, { bom: settings.bom }));
      toast(`저장했습니다: ${r.name}`);
    } catch (e) {
      if (e && e.name !== 'AbortError') toast(e.message || '저장하지 못했습니다', { bad: true });
    }
  });

  async function load() {
    if (textAbort) textAbort.abort();
    const ac = new AbortController();
    textAbort = ac;
    if (IMAGES.has(it.kind)) { out.value = ''; stat.textContent = ''; warnBox.hidden = false; warnBox.textContent = '그림에서는 글을 뽑을 수 없습니다(문자 인식이 필요).'; return; }
    if (it.needsPassword && !it.password) { askPassword(it, () => load()); return; }
    out.value = '';
    stat.innerHTML = '<span class="spin" style="display:inline-block;vertical-align:middle"></span> 글 뽑는 중…';
    try {
      doc = await ensureText(it, {
        range: it.range, signal: ac.signal,
        onProgress: (v) => { if (textAbort === ac) stat.textContent = `글 뽑는 중… ${Math.round(v * 100)}%`; },
        onState: (s) => { if (textAbort === ac) stat.textContent = s === 'engine' ? '쪽을 맞추려고 PDF 만드는 중…' : s === 'engine-wait' ? '엔진 대기 중…' : '글 뽑는 중…'; },
      });
      if (textAbort !== ac || current !== it) return;
      draw();
    } catch (e) {
      if (e.code === 'cancelled' || textAbort !== ac) return;
      if (e.code === 'password' || e.code === 'password_wrong') { updateItem(it, { needsPassword: true, password: null }); askPassword(it, () => load(), e.code === 'password_wrong'); return; }
      stat.textContent = '';
      warnBox.hidden = false;
      warnBox.textContent = e.message || '글을 뽑지 못했습니다';
    }
  }
  wrap.load = load;
  wrap.redraw = draw;
  load();
  return wrap;
}

// 암호 묻기(PDF)
function askPassword(it, then, wrong = false) {
  const body = side().querySelector('.side-body') || side();
  const box = h('div.warnbox', {},
    h('div', { text: wrong ? '암호가 맞지 않습니다. 다시 넣어 주세요.' : '열 때 암호가 필요한 PDF입니다.' }),
  );
  const input = h('input', { type: 'password', placeholder: '암호', style: 'margin-top:6px;height:28px' });
  const ok = h('button.btn.tiny', { type: 'button', text: '열기', style: 'margin-left:6px' });
  const go = () => { if (!input.value) return; updateItem(it, { password: input.value, needsPassword: false, textDoc: null }); box.remove(); then(); };
  ok.addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  box.append(h('div', {}, input, ok));
  body.prepend(box);
  input.focus();
}

// ─── 합치기 ───
function mergeSection() {
  const items = runnable('merge');
  const name = h('input', { id: 'mergeName', type: 'text', placeholder: mergeName(), style: 'width:min(360px,100%)' });
  const outline = h('label.check', {}, h('input', { type: 'checkbox', checked: settings.merge.outline || null, onchange: (e) => { settings.merge.outline = e.target.checked; saveSettings(); } }), '문서마다 책갈피');
  const pages = items.reduce((a, it) => a + (it.range ? it.range.length : it.pdfPages || it.pages || 0), 0);
  return h('div.side-body', { 'data-info-host': '' },
    h('div.row', {}, h('span.field', {}, h('span', { text: '합친 파일 이름' }), name), h('span.muted.small', { text: '.pdf' })),
    h('div.row', {}, outline, infoToggle('<p>합친 PDF의 책갈피(목차)에 원래 문서마다 항목을 만들고, 원래 있던 책갈피는 그 아래로 넣습니다.</p><p>목록 왼쪽 손잡이를 끌거나 <b>Alt + ↑↓</b>로 순서를 바꿉니다. 문서마다 쪽 범위를 따로 고를 수 있습니다.</p>')),
    h('div.row.muted.small', { text: items.length ? `${items.length}개 문서 · 약 ${fmtNum(pages)}쪽` : '합칠 문서를 목록에 넣으세요' }),
  );
}

// ─── 패널 그리기 ───
export function renderSide() {
  const box = side();
  const it = selectedItem();
  if (current !== it) { closeThumbs(); if (textAbort) textAbort.abort(); }
  current = it;
  box.innerHTML = '';
  const mode = store.mode;
  if (mode === 'merge') {
    box.append(h('div.side-head', {}, h('h2', { text: '합치기' })), mergeSection());
    if (it) {
      box.append(h('div.side-head', {}, h('h2', { text: it.name, title: it.name })));
      const body = h('div.side-body');
      body.append(rangeSection(it, { open: true }));
      box.append(body);
    }
    return;
  }
  if (!it) {
    box.append(h('div.side-note', { html: mode === 'pdf'
      ? '한글·워드·엑셀·파워포인트 문서와 그림을 PDF로 바꿉니다.<br>파일을 넣고 고르면 쪽을 골라 바꿀 수 있습니다.'
      : 'PDF·한글·워드 문서의 글을 TXT로 뽑습니다.<br>파일을 고르면 여기에 뽑은 글이 보입니다.' }));
    return;
  }
  box.append(h('div.side-head', {}, h('h2', { text: it.name, title: it.name })));
  if (mode === 'pdf') {
    const body = h('div.side-body');
    body.append(rangeSection(it, { open: true }));
    box.append(body);
  } else {
    // 텍스트: 파일이 하나면 쪽 고르기를 펼쳐 둔다
    const body = h('div');
    const single = store.items.length === 1 || !!it.range;
    const det = h('details.side-body', { open: single || null });
    det.append(h('summary', { text: it.range ? `쪽: ${formatRange(it.range)}` : '쪽 고르기(전체)' }));
    let rs = null;
    det.addEventListener('toggle', () => { if (det.open && !rs) { rs = rangeSection(it, { open: true }); det.append(rs); } });
    if (det.open) { rs = rangeSection(it, { open: true }); det.append(rs); }
    body.append(det);
    const ts = textSection(it);
    body.append(ts);
    box.append(body);
    box._text = ts;
  }
}

export function setupSide() {
  on('select', renderSide);
  on('mode', renderSide);
  on('focus-range', () => {
    const det = side().querySelector('details');
    if (det && !det.open) det.open = true;
    side().querySelector('.range-input')?.focus();
  });
  on('range', (it) => {
    if (it !== current) return;
    if (store.mode === 'text' && side()._text) {
      const det = side().querySelector('details > summary');
      if (det) det.textContent = it.range ? `쪽: ${formatRange(it.range)}` : '쪽 고르기(전체)';
      debouncedText();
    }
    if (store.mode === 'merge') {
      const head = side().querySelector('.side-body .row.muted');
      if (head) renderSide();
    }
  });
  on('list', () => { if (store.mode === 'merge' || !selectedItem() || selectedItem() !== current) renderSide(); });
  on('item', (it) => {
    // 형식·쪽 수를 알아낸 뒤 패널을 한 번 다시 그린다
    if (it === current && it.probed && !current._probedDrawn) { current._probedDrawn = true; renderSide(); }
  });
  onEngine(() => {
    // 엔진이 켜지면 쪽 그림을 다시 시도
    const it = current;
    if (it && engineReady() && OFFICE.has(it.kind) && !it.pdf && !thumbState) {
      const sec = side().querySelector('.range-sec');
      if (sec && sec.reloadThumbs) sec.reloadThumbs();
    }
  });
  renderSide();
}

const debouncedText = debounce(() => { const ts = side()._text; if (ts) ts.load(); }, 250);
