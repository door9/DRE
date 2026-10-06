// 한글 문서의 쪽 세기 — 줄 배치 정보(줄마다 '쪽 안 세로 위치')로 쪽이 바뀌는 곳을 찾는다.
// 새 쪽(또는 새 단)에서는 세로 위치가 다시 위로 돌아간다. 쪽보다 긴 표는 높이로 몇 쪽을 넘는지 셈한다.
// 한글이 마지막으로 저장할 때의 배치이므로 '추정'이다(정확한 쪽은 PDF로 바꾼 뒤 맞춘다).
export class PageTracker {
  constructor() {
    this.page = 1;
    this.col = 0;
    this.cols = 1;
    this.bodyH = 0;      // 본문 높이(HWPUNIT). 모르면 0
    this.last = null;    // 마지막 줄의 세로 위치
    this.lastEnd = 0;
  }

  setBody(height) { if (height > 1000) this.bodyH = height; }
  setColumns(n) { this.cols = Math.max(1, Math.min(10, n || 1)); }

  // 강제 쪽 나눔
  forceBreak() {
    if (this.last == null) return;
    this.page++;
    this.col = 0;
    this.last = null;
  }

  // 줄 하나: 그 줄이 시작하는 쪽을 돌려준다
  line(vpos, height) {
    if (this.last != null && vpos + 30 < this.last) {
      this.col++;
      if (this.col >= this.cols) { this.page++; this.col = 0; }
    }
    const pg = this.page;
    const end = vpos + Math.max(0, height);
    if (this.bodyH && end > this.bodyH * 1.04 && this.cols === 1) {
      // 쪽보다 긴 개체(큰 표): 넘어간 쪽 수만큼 더하고, 마지막 쪽에서 끝난 위치를 기억한다
      const extra = Math.floor(end / this.bodyH);
      this.page += extra;
      this.last = Math.max(0, end - extra * this.bodyH - 200);
    } else {
      this.last = vpos;
    }
    this.lastEnd = end;
    return pg;
  }
}
