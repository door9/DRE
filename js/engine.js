// PC의 DRE 부르기 — 이 PC에 설치된 작은 프로그램(DRE.exe)이 한글·워드·엑셀·파워포인트로(전자책은 엣지로) PDF를 만든다.
// DRE.exe는 127.0.0.1(이 PC 안)에서만 듣는다. 꺼져 있으면 'dre://' 주소로 켤 수 있다(크롬이 한 번 물어봄).
import { local, sleep } from './util.js';

const PORTS = [41730, 41731, 41732];
// 앱이 DRE.exe가 내보낸 PC 안 주소(127.0.0.1:41730)에서 열렸나 — 그러면 같은 주소로 바로 이야기한다
export const SERVED_BY_ENGINE = ['127.0.0.1', 'localhost'].includes(location.hostname) && PORTS.includes(+location.port);
const hostFor = (port) => (SERVED_BY_ENGINE && +location.port === port ? location.origin : `http://127.0.0.1:${port}`);
const listeners = new Set();
export const engine = { status: 'checking', port: null, apps: {}, browserName: '', version: null, busy: false };

function set(patch) {
  Object.assign(engine, patch);
  for (const f of listeners) f(engine);
}
export function onEngine(f) { listeners.add(f); f(engine); return () => listeners.delete(f); }

async function ping(port, ms = 900) {
  const r = await fetch(`${hostFor(port)}/v1/status`, { cache: 'no-store', signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('status ' + r.status);
  const j = await r.json();
  if (j.app !== 'DRE') throw new Error('not DRE');
  return j;
}

let checking = null;
export function checkEngine({ quiet = false } = {}) {
  if (checking) return checking;
  if (!quiet && engine.status !== 'on') set({ status: 'checking' });
  checking = (async () => {
    const first = engine.port || (SERVED_BY_ENGINE ? +location.port : null);
    const order = first ? [first, ...PORTS.filter((p) => p !== first)] : PORTS;
    for (const p of order) {
      try {
        const j = await ping(p);
        local.set('engineSeen', true);
        // ai: 이 PC 에서 Claude Code 를 찾았나(옛 DRE 는 이 값이 없다 — AI 교정을 못 한다)
        set({ status: 'on', port: p, apps: j.apps || {}, browserName: j.browserName || '', version: j.version, busy: !!j.busy, ai: 'ai' in j ? !!j.ai : null });
        return true;
      } catch { /* 다음 자리 */ }
    }
    set({ status: local.get('engineSeen', false) ? 'off' : 'none', port: null });
    return false;
  })().finally(() => { checking = null; });
  return checking;
}

// DRE.exe 켜기 — 반드시 사용자가 누른 순간에 불러야 한다(브라우저 규칙)
export async function launchEngine() {
  set({ status: 'starting' });
  const a = document.createElement('a');
  a.href = 'dre://start';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  // 처음 켤 때는 크롬이 '열까요?'를 묻고 사용자가 누르는 시간이 있어 넉넉히(약 20초) 기다린다
  for (let i = 0; i < 26; i++) {
    await sleep(i < 6 ? 500 : 800);
    if (await checkEngine({ quiet: true })) return true;
  }
  set({ status: local.get('engineSeen', false) ? 'off' : 'none' });
  return false;
}

export function engineReady() { return engine.status === 'on'; }

// 이 형식을 DRE.exe가 바꿀 수 있나(프로그램이 깔려 있나)
export function engineCan(kind) {
  const a = engine.apps || {};
  if (['hwp', 'hwp3', 'hwpx'].includes(kind)) return !!a.hwp;
  if (['doc', 'docx', 'rtf'].includes(kind)) return !!a.word || !!a.hwp;
  if (kind === 'odt') return !!a.word;
  if (['xls', 'xlsx', 'ods'].includes(kind)) return !!a.excel;
  if (['ppt', 'pptx', 'odp'].includes(kind)) return !!a.powerpoint;
  if (kind === 'epub') return !!a.browser; // 전자책: 앱이 HTML 로 묶어 보내면 엣지(없으면 크롬)로 인쇄
  return false;
}

// 변환: blob → PDF(또는 to 형식) Blob. signal 로 중지하면 DRE.exe도 그 일을 버린다
export async function engineConvert(blob, name, to = 'pdf', { signal } = {}) {
  if (engine.status !== 'on') await checkEngine({ quiet: true });
  if (engine.status !== 'on') throw Object.assign(new Error('DRE가 꺼져 있습니다'), { code: 'engine_off' });
  set({ busy: true });
  let r;
  try {
    r = await fetch(`${hostFor(engine.port)}/v1/convert?to=${encodeURIComponent(to)}&name=${encodeURIComponent(name)}`, {
      method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' }, signal, cache: 'no-store',
    });
  } catch (e) {
    set({ busy: false });
    if (signal && signal.aborted) throw Object.assign(new Error('취소했습니다'), { code: 'cancelled' });
    await checkEngine({ quiet: true });
    throw Object.assign(new Error('DRE와 연결이 끊겼습니다'), { code: 'engine_off' });
  }
  set({ busy: false });
  if (!r.ok) {
    let j = {};
    try { j = await r.json(); } catch { /* 글이 아님 */ }
    throw Object.assign(new Error(j.message || `DRE 오류(${r.status})`), { code: j.error || 'engine_error' });
  }
  return r.blob();
}

// ─── AI 교정 ───
// DRE.exe 가 이 PC 의 Claude Code(사용자의 Claude 구독 로그인)를 부른다 — 따로 요금 없이 사용자의 요금제 사용량에서 나간다.
// 앱은 문자 인식한 줄과 쪽 그림만 보낸다(지시문·답 꼴은 DRE.exe 가 정함).
const aiErr = (code, message) => Object.assign(new Error(message), { code });
let aiChecked = null; // { at, r } — 잘 되면 1분 기억
let aiRecheck = false; // 로그인 창을 띄운 뒤에는 DRE.exe 가 기억한 상태 말고 새로 확인

// 쓸 수 있나 → { ok, code, message }
export async function aiStatus({ refresh = false } = {}) {
  // DRE 상태는 화면을 다시 볼 때마다 새로 확인된다(watchEngine) — 여기서 또 찾느라 문서마다 기다리지 않게, 확인 중일 때만 기다린다
  if (engine.status === 'checking' || engine.status === 'starting') await checkEngine({ quiet: true });
  // 이 브라우저에서 DRE 를 본 적이 없으면(공개 주소만 쓰는 PC 등) AI 교정은 조용히 건너뛴다
  if (engine.status === 'none') return { ok: false, code: 'engine_none', message: '이 PC에 DRE가 없습니다' };
  if (engine.status !== 'on') return { ok: false, code: 'engine_off', message: 'DRE가 꺼져 있습니다' };
  if (engine.ai == null) return { ok: false, code: 'engine_old', message: '설치된 DRE가 옛 판입니다. DRE를 새로 내려받아 설치해 주세요' };
  if (!engine.ai) return { ok: false, code: 'ai_notfound', message: '이 PC에서 Claude Code를 찾지 못했습니다' };
  if (!refresh && !aiRecheck && aiChecked && aiChecked.r.ok && Date.now() - aiChecked.at < 60000) return aiChecked.r;
  let j;
  try {
    const r = await fetch(`${hostFor(engine.port)}/v1/ai/status${refresh || aiRecheck ? '?refresh=1' : ''}`, { cache: 'no-store', signal: AbortSignal.timeout(70000) });
    j = await r.json();
  } catch {
    return { ok: false, code: 'engine_off', message: 'DRE와 연결이 끊겼습니다' };
  }
  let res = { ok: true };
  if (!j.found) res = { ok: false, code: 'ai_notfound', message: '이 PC에서 Claude Code를 찾지 못했습니다' };
  else if (!j.loggedIn) res = { ok: false, code: 'ai_login', message: '이 PC의 Claude Code에 로그인되어 있지 않습니다' };
  else if (!j.sub) res = { ok: false, code: 'ai_notsub', message: 'Claude 구독이 아닌 방식으로 로그인되어 있어 쓰지 않습니다(API 요금이 들 수 있음)' };
  aiChecked = { at: Date.now(), r: res };
  if (res.ok) aiRecheck = false;
  return res;
}

// 고치기 목록 받기. body: { text: '줄번호: 내용…', images: [{ label, type: 'image/png', data: base64 }] } → { edits, usage, ms }
export async function aiFix(body, { signal } = {}) {
  let r;
  try {
    r = await fetch(`${hostFor(engine.port)}/v1/ai?task=ocrfix`, {
      method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal, cache: 'no-store',
    });
  } catch {
    if (signal && signal.aborted) throw aiErr('cancelled', '취소했습니다');
    await checkEngine({ quiet: true });
    throw aiErr('engine_off', 'DRE와 연결이 끊겼습니다');
  }
  let j = {};
  try { j = await r.json(); } catch { /* 글이 아님 */ }
  if (!r.ok || !j.ok) {
    if (j.error === 'ai_login' || j.error === 'ai_notsub') aiChecked = null;
    throw aiErr(j.error || 'ai_failed', j.message || `AI 교정 오류(${r.status})`);
  }
  return j;
}

// Claude 로그인 창 띄우기(DRE.exe 가 'claude auth login' 을 창으로 연다 — 브라우저에서 Claude 계정으로 로그인)
export async function aiLogin() {
  aiChecked = null;
  aiRecheck = true;
  const r = await fetch(`${hostFor(engine.port)}/v1/ai/login`, { method: 'POST', cache: 'no-store' });
  let j = {};
  try { j = await r.json(); } catch { /* 글이 아님 */ }
  if (!r.ok) throw aiErr(j.error || 'ai_failed', j.message || '로그인 창을 띄우지 못했습니다');
}

// 화면을 다시 볼 때 DRE.exe 상태를 새로(너무 자주는 말고)
let lastCheck = 0;
export function watchEngine() {
  const again = () => { if (Date.now() - lastCheck > 4000) { lastCheck = Date.now(); checkEngine({ quiet: true }); } };
  window.addEventListener('focus', again);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) again(); });
  lastCheck = Date.now();
  return checkEngine();
}
