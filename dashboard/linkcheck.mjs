// node cloud-dashboard/linkcheck.mjs — link.js 셀프체크
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const L = createRequire(import.meta.url)("./link.js");

const tele = (up, b1, b2, l1, l2, seq1 = 1, seq2 = 1) => ({
  uptime_ms: up, rx: { all: b1 + b2, bad: 0, b1, b2 },
  board1: { seq: seq1, lost: l1 }, board2: l2 == null ? null : { seq: seq2, lost: l2 },
});

// 60초에 12개, 손실 0 → 12개/분, 0%
let st = L.makeLink();
L.addSample(st, tele(0, 0, 0, 0, 0), 0);
L.addSample(st, tele(60000, 12, 9, 0, 3), 60000);
let s = L.linkStats(st, 0);
assert.equal(Math.round(s.perMin), 12);
assert.equal(s.lossPct, 0);
assert.equal(L.rateTone(s.perMin), "ok");
// #2: 9개 받고 3개 빠짐 → 손실률 25%
s = L.linkStats(st, 1);
assert.equal(Math.round(s.perMin), 9);
assert.equal(s.lossPct, 25);
assert.equal(L.lossTone(s.lossPct), "bad");

// 보드가 null이면 lost는 직전 값 유지
L.addSample(st, tele(62000, 12, 9, 0, null), 62000);
assert.equal(st.samples.at(-1).lost[1], 3);

// 게이트웨이 재부팅(uptime 감소) → 창 초기화, 통계 없음
L.addSample(st, tele(1000, 0, 0, 0, 0), 63000);
assert.equal(st.samples.length, 1);
assert.deepEqual(L.linkStats(st, 0), { perMin: null, lossPct: null });

// 창이 너무 짧으면 계산 안 함
L.addSample(st, tele(5000, 1, 1, 0, 0), 67000);
assert.equal(L.linkStats(st, 0).perMin, null);

// seq가 바뀔 때만 마지막 수신 시각 갱신
st = L.makeLink();
L.addSample(st, tele(0, 0, 0, 0, 0, 5, 5), 1000);
L.addSample(st, tele(2000, 0, 0, 0, 0, 5, 6), 3000);
assert.deepEqual(st.lastRxAt, [1000, 3000]);

// 60초 창 유지(오래된 샘플 버림)
st = L.makeLink();
for (let t = 0; t <= 180000; t += 2000) L.addSample(st, tele(t, t / 5000, t / 5000, 0, 0), t);
assert.ok(st.samples.at(-1).up - st.samples[0].up <= 62000);
assert.equal(Math.round(L.linkStats(st, 0).perMin), 12);

// 색 기준
assert.equal(L.ageTone(5000), "ok");
assert.equal(L.ageTone(12000), "warn");
assert.equal(L.ageTone(20000), "bad");
assert.equal(L.rssiTone(-75), "bad");
assert.equal(L.rssiTone(-60), "ok");
// 게이트웨이 재부팅 감지
let g = L.makeGw();
L.gwSample(g, { uptime_ms: 100000, free_heap: 200000 }, 0);
L.gwSample(g, { uptime_ms: 102000, free_heap: 200000 }, 2000);
assert.equal(g.reboots, 0);
L.gwSample(g, { uptime_ms: 1500, free_heap: 210000 }, 4000);
assert.equal(g.reboots, 1);
assert.equal(g.lastRebootAt, 4000);
assert.equal(g.heap.length, 1); // 재부팅 시 메모리 기록 초기화

// 메모리: 10분 넘게 단조 감소 + 10% 이상 → 누수 의심
g = L.makeGw();
for (let t = 0; t <= 620000; t += 2000) L.gwSample(g, { uptime_ms: t + 1000, free_heap: 200000 - t / 20 }, t);
assert.equal(L.heapLeak(g), true);
// 중간에 한 번이라도 늘면 아님
g = L.makeGw();
for (let t = 0; t <= 620000; t += 2000)
  L.gwSample(g, { uptime_ms: t + 1000, free_heap: 200000 - t / 20 + (t === 300000 ? 50000 : 0) }, t);
assert.equal(L.heapLeak(g), false);
// 줄긴 했지만 10% 미만이면 아님
g = L.makeGw();
for (let t = 0; t <= 620000; t += 2000) L.gwSample(g, { uptime_ms: t + 1000, free_heap: 200000 - t / 1000 }, t);
assert.equal(L.heapLeak(g), false);
// 10분이 안 됐으면 판단 안 함
g = L.makeGw();
for (let t = 0; t <= 300000; t += 2000) L.gwSample(g, { uptime_ms: t + 1000, free_heap: 200000 - t / 5 }, t);
assert.equal(L.heapLeak(g), false);

assert.equal(L.fmtUptime(125 * 60000), "2시간 5분");
assert.equal(L.fmtUptime(42 * 60000), "42분");
assert.equal(L.gwAgeTone(4000), "ok");
assert.equal(L.gwAgeTone(10000), "warn");
assert.equal(L.gwAgeTone(16000), "bad");
console.log("linkcheck ok");
