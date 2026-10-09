// 작업 일꾼(js/worker/task.js) 부르기
// - 한 번에 하나씩 처리한다(PC 자원을 한꺼번에 쓰지 않게).
// - 일꾼이 죽거나 너무 오래 걸리면 통째로 끝내고 다음 일은 새 일꾼이 맡는다(앱은 멈추지 않는다).
// - 45초 동안 일이 없으면 일꾼을 내려 메모리를 돌려준다.

const IDLE_MS = 45000;
let worker = null;
let seq = 0;
let idleTimer = null;
const queue = [];
let active = null;

function makeWorker() {
  const w = new Worker(new URL('./worker/task.js', import.meta.url), { type: 'module', name: 'dre-task' });
  w.onmessage = (e) => {
    const m = e.data;
    if (!active || m.id !== active.id) return;
    if (m.type === 'progress') {
      // 진행이 있으면 시간 제한을 다시 잰다(문자 인식처럼 오래 걸려도 멈춘 것이 아니면 끊지 않게)
      clearTimeout(active.timer);
      const job = active;
      job.timer = setTimeout(() => { if (active === job) crash(Object.assign(new Error('너무 오래 걸려 멈췄습니다'), { code: 'timeout' })); }, job.timeoutMs);
      active.onProgress && active.onProgress(m.value, m.note);
      return;
    }
    const job = active;
    finish();
    if (m.type === 'done') job.resolve(m.result);
    else job.reject(Object.assign(new Error(m.message || '실패'), { code: m.code, index: m.index }));
  };
  w.onerror = (e) => {
    e.preventDefault && e.preventDefault();
    crash(Object.assign(new Error('작업 일꾼에 문제가 생겼습니다(메모리가 모자라거나 파일이 비정상일 수 있습니다)'), { code: 'crash' }));
  };
  w.onmessageerror = () => crash(Object.assign(new Error('작업 결과를 받지 못했습니다'), { code: 'crash' }));
  return w;
}

function kill() {
  if (worker) { try { worker.terminate(); } catch { /* 이미 끝남 */ } }
  worker = null;
}

function crash(err) {
  const job = active;
  kill();
  if (job) { finish(); job.reject(err); }
}

function finish() {
  if (active && active.timer) clearTimeout(active.timer);
  active = null;
  pump();
}

function pump() {
  clearTimeout(idleTimer);
  if (active) return;
  const job = queue.shift();
  if (!job) {
    idleTimer = setTimeout(kill, IDLE_MS);
    return;
  }
  if (job.cancelled) { job.reject(Object.assign(new Error('취소했습니다'), { code: 'cancelled' })); pump(); return; }
  active = job;
  if (!worker) worker = makeWorker();
  job.timer = setTimeout(() => { if (active === job) crash(Object.assign(new Error('너무 오래 걸려 멈췄습니다'), { code: 'timeout' })); }, job.timeoutMs);
  try {
    worker.postMessage({ id: job.id, type: job.type, ...job.payload }, job.transfer);
  } catch (e) {
    crash(Object.assign(new Error('작업을 넘기지 못했습니다: ' + e.message), { code: 'failed' }));
  }
}

// type: 'probe' | 'extract' | 'build' | 'image'. transfer 로 넘긴 버퍼는 이쪽에서 더 못 쓴다.
export function runJob(type, payload, { transfer = [], onProgress, timeoutMs = 15 * 60 * 1000, front = false } = {}) {
  const job = { id: ++seq, type, payload, transfer, onProgress, timeoutMs };
  const promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
  if (front) queue.unshift(job); else queue.push(job);
  pump();
  return { id: job.id, promise, cancel: () => cancelJob(job) };
}

function cancelJob(job) {
  if (active === job) {
    // 하던 일은 끊는다(일꾼을 새로 만든다)
    crash(Object.assign(new Error('취소했습니다'), { code: 'cancelled' }));
  } else {
    const i = queue.indexOf(job);
    if (i >= 0) queue.splice(i, 1);
    job.reject(Object.assign(new Error('취소했습니다'), { code: 'cancelled' }));
  }
}

// 기다리는 일 모두 취소
export function cancelAll() {
  for (const j of queue) j.cancelled = true;
  if (active) crash(Object.assign(new Error('취소했습니다'), { code: 'cancelled' }));
}
