// 파일 목록 화면 — 고르기·빼기·쪽 범위 표시, 합치기에서는 끌어서 순서 바꾸기·정렬
import { store, on, emit, selectItem, removeItem, moveItem, sortItems, clearItems, getItem } from '../store.js';
import { h, ico, fmtBytes, esc } from '../util.js';
import { kindLabel, IMAGES } from '../core/detect.js';
import { formatRange } from '../core/model.js';
import { whyNot, openBlob } from '../run.js';

const listEl = () => document.getElementById('fileList');

function kindClass(kind) {
  if (kind.startsWith('hwp')) return 'k-hwp';
  if (kind === 'doc' || kind === 'docx' || kind === 'rtf' || kind === 'odt') return 'k-word';
  if (kind === 'pdf') return 'k-pdf';
  if (kind.startsWith('xl') || kind === 'ods') return 'k-xls';
  if (kind.startsWith('pp') || kind === 'odp') return 'k-ppt';
  if (IMAGES.has(kind)) return 'k-img';
  return '';
}

// 엑셀은 DRE가 PDF로 바꿔 실제 쪽 수를 알기 전까지 시트 수로 보인다
const sheetCount = (it) => it.sheetPages && !it.pdfPages;

function rangeLabel(it) {
  if (it.range && !it.range.length) return '고른 쪽 없음';
  if (it.range) return `${formatRange(it.range)}${sheetCount(it) ? '시트' : '쪽'}`;
  if (it.pages) return sheetCount(it) ? `전체 ${it.pages}시트` : `전체 ${it.pages}쪽`;
  return '전체';
}

function metaHtml(it) {
  const parts = [];
  if (it.pages) parts.push(sheetCount(it) ? `시트 ${it.pages}개` : `${it.pageExact ? '' : '약 '}${it.pages}쪽`);
  else if (!it.probed) parts.push('살펴보는 중…');
  parts.push(fmtBytes(it.size));
  let html = esc(parts.join(' · '));
  const why = whyNot(it, store.mode);
  if (it.state === 'error') html = `<span class="errmsg">${esc(it.msg)}</span>`;
  else if (it.state === 'warn') html = `<span class="warnmsg">${esc(it.msg)}</span>`;
  else if (it.msg && (it.state === 'working' || it.state === 'queued' || it.state === 'done')) html = esc(it.msg);
  else if (it.needsPassword && !it.password) html += ` · <span class="warnmsg">암호 필요</span>`;
  else if (it.probeError && it.probeError !== 'password' && it.probeError !== 'distribution') html += ` · <span class="errmsg">${esc(it.probeMsg || '열지 못함')}</span>`;
  else if (why) html += ` · <span class="warnmsg">${esc(why)}</span>`;
  return html;
}

function stateHtml(it) {
  switch (it.state) {
    case 'working': return '<span class="spin" aria-label="처리 중"></span>';
    case 'queued': return '<span class="muted small">대기</span>';
    case 'done': return ico('check');
    case 'warn': return ico('alert');
    case 'error': return ico('alert');
    default: return '';
  }
}

function rowFor(it) {
  const li = h('li.file', { 'data-id': it.id, tabindex: '0' });
  li.innerHTML = `
    <span class="grip" title="끌어서 순서 바꾸기">${ico('grip')}</span>
    <span class="badge ${kindClass(it.kind)}">${esc(kindLabel(it.kind))}</span>
    <span class="nm"><span class="name"></span><span class="meta"></span></span>
    <button class="range" type="button" title="쪽 고르기"></button>
    <span class="state"></span>
    <button class="icon-btn open" type="button" title="결과 열어 보기" hidden>${ico('external')}</button>
    <button class="icon-btn remove" type="button" title="목록에서 빼기">${ico('x')}</button>
    <span class="bar" hidden><i></i></span>`;
  fill(li, it);
  return li;
}

function fill(li, it) {
  li.classList.toggle('selected', store.selected === it.id);
  li.querySelector('.badge').className = `badge ${kindClass(it.kind)}`;
  li.querySelector('.badge').textContent = kindLabel(it.kind);
  const name = li.querySelector('.name');
  name.textContent = it.name;
  name.title = it.name;
  li.querySelector('.meta').innerHTML = metaHtml(it);
  const rb = li.querySelector('.range');
  rb.textContent = rangeLabel(it);
  rb.classList.toggle('set', !!it.range);
  rb.hidden = IMAGES.has(it.kind);
  const st = li.querySelector('.state');
  st.className = 'state' + (it.state === 'done' ? ' ok' : it.state === 'error' ? ' bad' : it.state === 'warn' ? ' warn' : '');
  st.innerHTML = stateHtml(it);
  st.title = it.state === 'error' || it.state === 'warn' || it.state === 'done' ? it.msg : '';
  const bar = li.querySelector('.bar');
  const showBar = it.state === 'working' && it.progress > 0 && it.progress < 1;
  bar.hidden = !showBar;
  if (showBar) bar.firstElementChild.style.width = `${Math.round(it.progress * 100)}%`;
  li.querySelector('.remove').disabled = store.running;
  li.querySelector('.open').hidden = !((it.state === 'done' || it.state === 'warn') && it.output && it.output.blob);
}

export function renderList() {
  const ul = listEl();
  const have = new Map([...ul.children].map((li) => [+li.dataset.id, li]));
  const frag = document.createDocumentFragment();
  for (const it of store.items) {
    let li = have.get(it.id);
    if (li) { fill(li, it); have.delete(it.id); } else li = rowFor(it);
    frag.append(li);
  }
  for (const li of have.values()) li.remove();
  ul.append(frag);
  document.getElementById('emptyState').hidden = store.items.length > 0;
  document.getElementById('listCount').textContent = store.items.length ? `${store.items.length}개` : '';
  document.getElementById('btnClear').disabled = !store.items.length || store.running;
}

function updateRow(it) {
  const li = listEl().querySelector(`li[data-id="${it.id}"]`);
  if (li) fill(li, it);
}

// ─── 끌어서 순서 바꾸기(마우스·손가락 모두) ───
function setupDrag() {
  const ul = listEl();
  let drag = null;
  ul.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.grip');
    if (!grip || store.mode !== 'merge' || store.running) return;
    const li = grip.closest('li');
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    drag = { li, id: +li.dataset.id, grip, target: null, after: false };
    li.classList.add('dragging');
  });
  ul.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const li = over && over.closest && over.closest('li.file');
    ul.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    // 목록 끝 가까이에서는 저절로 넘긴다
    const r = ul.getBoundingClientRect();
    if (e.clientY < r.top + 30) ul.scrollTop -= 12;
    else if (e.clientY > r.bottom - 30) ul.scrollTop += 12;
    if (!li || li === drag.li) { drag.target = null; return; }
    const box = li.getBoundingClientRect();
    drag.after = e.clientY > box.top + box.height / 2;
    drag.target = +li.dataset.id;
    li.classList.add(drag.after ? 'drop-after' : 'drop-before');
  });
  const end = () => {
    if (!drag) return;
    ul.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    drag.li.classList.remove('dragging');
    if (drag.target != null) {
      const from = store.items.findIndex((x) => x.id === drag.id);
      let to = store.items.findIndex((x) => x.id === drag.target) + (drag.after ? 1 : 0);
      if (from < to) to--;
      moveItem(drag.id, to);
    }
    drag = null;
  };
  ul.addEventListener('pointerup', end);
  ul.addEventListener('pointercancel', end);
}

function setupSortMenu() {
  const btn = document.getElementById('btnSort');
  let menu = null;
  const close = () => { if (menu) { menu.remove(); menu = null; } };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu) { close(); return; }
    menu = h('div.menu', { role: 'menu' });
    for (const [k, label] of [['name', '이름순'], ['name-desc', '이름 거꾸로'], ['date', '고친 날짜순'], ['added', '넣은 순서']]) {
      menu.append(h('button', { role: 'menuitem', text: label, onclick: () => { sortItems(k); close(); } }));
    }
    btn.parentElement.append(menu);
  });
  document.addEventListener('click', close);
}

export function setupList() {
  const ul = listEl();
  ul.addEventListener('click', (e) => {
    const li = e.target.closest('li.file');
    if (!li) return;
    const id = +li.dataset.id;
    if (e.target.closest('.remove')) { if (!store.running) removeItem(id); return; }
    if (e.target.closest('.open')) { const it = store.items.find((x) => x.id === id); if (it && it.output && it.output.blob) openBlob(it.output.blob); return; }
    selectItem(id);
    if (e.target.closest('.range')) emit('focus-range');
  });
  ul.addEventListener('keydown', (e) => {
    const li = e.target.closest('li.file');
    if (!li) return;
    const id = +li.dataset.id;
    const i = store.items.findIndex((x) => x.id === id);
    if (e.key === 'Delete' && !store.running) { removeItem(id); e.preventDefault(); }
    else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && store.mode === 'merge' && !store.running) {
      moveItem(id, i + (e.key === 'ArrowUp' ? -1 : 1));
      requestAnimationFrame(() => ul.querySelector(`li[data-id="${id}"]`)?.focus());
      e.preventDefault();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const next = store.items[i + (e.key === 'ArrowUp' ? -1 : 1)];
      if (next) { selectItem(next.id); ul.querySelector(`li[data-id="${next.id}"]`)?.focus(); }
      e.preventDefault();
    } else if (e.key === 'Enter' || e.key === ' ') {
      selectItem(id);
      e.preventDefault();
    }
  });
  document.getElementById('btnClear').addEventListener('click', () => { if (!store.running) clearItems(); });
  setupDrag();
  setupSortMenu();
  on('list', renderList);
  on('select', renderList);
  on('mode', renderList);
  on('running', renderList);
  on('item', updateRow);
  renderList();
}

export { getItem };
