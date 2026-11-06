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
// #2 fault 문구 (게이트웨이 fault_text)
assert.equal(L.faultText({ fault: 1, fault_text: "sensor", err: 257 }), "센서 오류 (온도 읽기 실패)");
assert.equal(L.faultText({ fault: 2, fault_text: "overheat" }), "과열 55℃ 래치");
assert.equal(L.faultText({ fault: 3, fault_text: "timeout" }), "연속 가열 상한(30분) — 10분 휴지");
assert.equal(L.faultText({ fault: 4, fault_text: "rate" }), "상승률 이상 (가열 5분에 +1℃ 미만)");
assert.equal(L.faultText({ fault: 0, fault_text: "ok" }), "");
assert.equal(L.faultText({ fault: 6, fault_text: null }), "fault 코드 6");
assert.equal(L.faultText({ fault: 7, fault_text: "weird" }), "weird (코드 7)");
assert.equal(L.faultText({ reasons: 257 }), "오류: 온도 센서"); // fault 필드 없는 옛 펌웨어: 하위 비트
assert.equal(L.errText(0b10011), "오류: 온도 센서, CO₂ 센서, 과열");
assert.equal(L.resetText(6), "태스크 WDT(loop 60초 멈춤) (6)");
assert.equal(L.resetText(undefined), "—");
assert.equal(L.wifiReasonText(201), "AP 못 찾음 (201)");
assert.equal(L.wifiReasonText(0), "없음");
// 보드 15초 수신 끊김
assert.equal(L.boardStale({ seq: 1 }, 1000, 16000), false);
assert.equal(L.boardStale({ seq: 1 }, 1000, 16001), true);
assert.equal(L.boardStale(null, 1000, 2000), true);
assert.equal(L.boardStale({ seq: 1 }, 0, 2000), true);
// 2보드(firmware2) 판별·fault 표 (heater_core.h faultText)
const fw2 = { board_ok: true, rx: { all: 30, bad: 0, wrong_src: 0 }, board2: { temp2_c: null, ctrl_temp_c: 31.2, target_c: 37, latched: false, fault: 0, fault_text: "ok", mode: "auto" } };
assert.equal(L.isTwoBoard(fw2, null), true);
assert.equal(L.isTwoBoard({ board2: { temp2_c: 30, mode: "auto" } }, null), false);
assert.equal(L.isTwoBoard({}, { boards: 2 }), true);
assert.equal(L.isTwoBoard(null, null), false);
assert.equal(L.faultText({ target_c: 37, fault: 2, fault_text: "overheat" }), "과열 50℃ 래치"); // 3보드 55℃와 구분
assert.equal(L.faultText({ target_c: 37, fault: 1, fault_text: "no_data" }), "#1 데이터 없음·끊김 → 히터 OFF");
assert.equal(L.faultText({ target_c: 37, fault: 5 }), "심부 45℃ 이상 → OFF");
assert.equal(L.faultText({ target_c: 37, fault: 0, fault_text: "ok" }), "");
assert.equal(L.faultText({ target_c: 37, fault: 9, fault_text: "?" }), "? (코드 9)");
// firmware2 rx.all → #1 수신 수
const st2 = L.makeLink();
L.addSample(st2, { ...fw2, uptime_ms: 1000, board1: { seq: 1, lost: 0 } }, 1000);
assert.equal(st2.samples.at(-1).rx[0], 30);
console.log("linkcheck ok");
