// node cloud-dashboard/chartcheck.mjs — chart.js 셀프체크
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const C = createRequire(import.meta.url)("./chart.js");

const tele = (b1, b2, extra = {}) => ({ uptime_ms: 1, board1: b1, board2: b2, ...extra });

// 60초 창 자르기: 2초마다 100초 → 마지막 60초(31점)만 남음
let st = C.makeChart();
for (let t = 0; t <= 100000; t += 2000) C.record(st, tele({ gas_v: t / 100000 }, null), t);
assert.equal(st.gas.length, 31);
assert.equal(st.gas[0].t, 40000);

// 보드 null 구간 → 점이 안 쌓이고, 5초 넘는 간격에서 선이 끊김
st = C.makeChart();
C.record(st, tele({ gas_v: 1 }, null), 0);
C.record(st, tele({ gas_v: 1.1 }, null), 2000);
C.record(st, tele(null, null), 4000);
C.record(st, tele(null, null), 6000);
C.record(st, tele(null, null), 8000);
C.record(st, tele({ gas_v: 1.2 }, null), 10000);
C.record(st, tele({ gas_v: 1.3 }, null), 12000);
assert.equal(st.gas.length, 4);
const segs = C.splitGaps(st.gas);
assert.equal(segs.length, 2);
assert.deepEqual(segs.map((s) => s.length), [2, 2]);

// 값이 null(예: odor_index 미보정)이면 그 선은 비움, 보드 마지막 수신은 갱신
st = C.makeChart();
C.record(st, tele({ gas_v: 1, odor_index: null }, null), 1000);
assert.equal(st.odor.length, 0);
assert.equal(st.last.b1, 1000);

// 끊김 판정: 10초 초과
assert.equal(C.isStale(1000, 11000), false);
assert.equal(C.isStale(1000, 11001), true);
assert.equal(C.isStale(0, 5000), true);

// 히터 띠: ON 구간만, 갭에서 끊김
st = C.makeChart();
const heat = [false, true, true, false, true];
heat.forEach((h, i) => C.record(st, tele(null, { temp2_c: 40, heater_on: h }), i * 2000));
assert.deepEqual(C.onRuns(st.heat), [{ t0: 2000, t1: 6000 }, { t0: 8000, t1: 10000 }]);
const gapRuns = C.onRuns([{ t: 0, v: true }, { t: 2000, v: true }, { t: 20000, v: true }]);
assert.equal(gapRuns.length, 2);

// pot_v: 필드가 없으면 대기(potSeen=false), 있으면 기록
st = C.makeChart();
C.record(st, tele(null, null), 0);
assert.equal(st.potSeen, false);
C.record(st, tele(null, null, { pot_v: 1.65 }), 2000);
assert.equal(st.potSeen, true);
assert.equal(st.pot[0].v, 1.65);
C.record(st, tele(null, null, { pot_v: null }), 4000);
assert.equal(st.pot.length, 1);
assert.equal(st.last.pot, 2000);

// 스케일: 범위 밖은 잘라서 그림 안에 둠
assert.equal(C.yOf(3.3, 0, 3.3, 120), 0);
assert.equal(C.yOf(0, 0, 3.3, 120), 120);
assert.equal(C.yOf(99, 20, 80, 120), 0);
assert.equal(C.xOf(60000, 60000, 600), 600);
assert.equal(C.xOf(0, 60000, 600), 0);

console.log("chartcheck ok");
