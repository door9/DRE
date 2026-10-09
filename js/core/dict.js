// 국어사전 낱말 목록 — 줄 잇기 판단(joiner.js)에 넣는다. 자료(dictdata.js, 약 1MB)는 처음 쓸 때 한 번 불러 푼다.
import { setDictionary } from './joiner.js';

let ready = null;

// 담긴 꼴([앞 낱말과 같은 앞부분 글자 수][나머지 글자]…)을 풀어 낱말 모음으로
export function decodeWords(data) {
  const set = new Set();
  let prev = '';
  let i = 0;
  while (i < data.length) {
    const k = data.charCodeAt(i) - 48;
    let j = i + 1;
    while (j < data.length) { const c = data.charCodeAt(j); if (c >= 48 && c <= 57) break; j++; }
    const w = prev.slice(0, k) + data.slice(i + 1, j);
    set.add(w);
    prev = w;
    i = j;
  }
  return set;
}

// 사전을 불러 줄 잇기에 넣는다(여러 번 불러도 한 번만)
export function loadDictionary() {
  if (!ready) {
    ready = import('./dictdata.js').then((m) => {
      const set = decodeWords(m.DICT_WORDS);
      setDictionary(set);
      return set;
    }).catch((e) => {
      ready = null;
      console.error('사전을 불러오지 못했습니다', e);
      return null; // 사전 없이도 줄 잇기는 된다
    });
  }
  return ready;
}
