// PC의 DRE 부르기 — 이 PC에 설치된 작은 프로그램(DRE.exe)이 한글·워드·엑셀·파워포인트로 PDF를 만든다.
// DRE.exe는 127.0.0.1(이 PC 안)에서만 듣는다. 꺼져 있으면 'dre://' 주소로 켤 수 있다(크롬이 한 번 물어봄).
import { local, sleep } from './util.js';

const PORTS = [41730, 41731, 41732];
// 앱이 DRE.exe가 내보낸 PC 안 주소(127.0.0.1:41730)에서 열렸나 — 그러면 같은 주소로 바로 이야기한다
export const SERVED_BY_ENGINE = ['127.0.0.1', 'localhost'].includes(location.hostname) && PORTS.includes(+location.port);
const hostFor = (port) => (SERVED_BY_ENGINE && +location.port === port ? location.origin : `http://127.0.0.1:${port}`);
const listeners = new Set();
export const engine = { status: 'checking', port: null, apps: {}, version: null, busy: false };

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
        set({ status: 'on', port: p, apps: j.apps || {}, version: j.version, busy: !!j.busy });
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

// 화면을 다시 볼 때 DRE.exe 상태를 새로(너무 자주는 말고)
let lastCheck = 0;
export function watchEngine() {
  const again = () => { if (Date.now() - lastCheck > 4000) { lastCheck = Date.now(); checkEngine({ quiet: true }); } };
  window.addEventListener('focus', again);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) again(); });
  lastCheck = Date.now();
  return checkEngine();
}
