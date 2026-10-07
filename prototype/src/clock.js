'use strict';
// clock.js — đồng hồ ảo cho prototype.
// Ghi chú prototype: production dùng setTimeout + bảng jobs có run_at thật (AI3 mục 8);
// prototype thay delay/timer bằng đồng hồ ảo để test nhanh và tất định (không chờ 2 ngày thật cho case 17).

class VirtualClock {
  constructor(startMs) {
    this.ms = startMs || Date.parse('2026-10-04T09:00:00.000Z');
    this.timers = []; // {at, fn, seq}
    this.seq = 0;
  }

  now() { return this.ms; }
  iso() { return new Date(this.ms).toISOString(); }

  schedule(delayMs, fn) {
    this.seq += 1;
    this.timers.push({ at: this.ms + delayMs, fn, seq: this.seq });
  }

  nextAt() {
    if (!this.timers.length) return null;
    return Math.min(...this.timers.map(t => t.at));
  }

  // Chạy mọi timer đến hạn <= toMs, đúng thứ tự thời gian.
  advance(toMs) {
    const target = Math.max(toMs, this.ms);
    for (;;) {
      const due = this.timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq);
      if (!due.length) break;
      const t = due[0];
      this.timers = this.timers.filter(x => x !== t);
      this.ms = Math.max(this.ms, t.at);
      t.fn();
    }
    this.ms = target;
  }
}

module.exports = { VirtualClock };
