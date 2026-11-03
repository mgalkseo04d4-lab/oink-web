// node cloud-dashboard/democheck.mjs — demo.js(시연 탭) 셀프체크
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const D = createRequire(import.meta.url)("./demo.js");

const tele = (b1) => ({ uptime_ms: 1, board1: b1, board2: null });

// 기록: CO₂는 상태 1일 때만, 보드 null이면 안 쌓임
let st = D.makeDemo();
D.record(st, tele({ co2_ppm: 900, co2_status: 0, temp1_c: 35 }), 0);
assert.equal(st.co2.length, 0);
assert.equal(st.t1.length, 1);
D.record(st, tele({ co2_ppm: 910, co2_status: 1, temp1_c: 35.2 }), 2000);
assert.equal(st.co2.length, 1);
D.record(st, null, 4000);
D.record(st, tele(null) , 6000);
assert.equal(st.t1.length, 2);

// 끊김: board1 null, 또는 10초 넘게 갱신 없음
assert.equal(D.isStale(st, tele(null), 6000), true);
assert.equal(D.isStale(st, tele({}), 9000), false);
assert.equal(D.isStale(st, tele({}), 13000), true);

// 보관 5분 자르기 + 60초 창
st = D.makeDemo();
for (let t = 0; t <= 400000; t += 2000) D.record(st, tele({ co2_ppm: 800 + t / 1000, co2_status: 1, temp1_c: 30 }), t);
assert.ok(st.co2[0].t >= 400000 - D.C.KEEP_MS);
assert.equal(D.inWindow(st.co2, 400000, D.C.WINDOW_MS).length, 31);

// 갭 분할: 6초 넘으면 끊김
const segs = D.splitGaps([{ t: 0, v: 1 }, { t: 2000, v: 1 }, { t: 10000, v: 1 }, { t: 12000, v: 1 }]);
assert.equal(segs.length, 2);

// 자동 범위: 최소 폭 보장(CO₂ 20, 온도 0.5), 데이터 포함, 눈금 표시
let r = D.autoRange([{ t: 0, v: 940 }, { t: 1, v: 942 }], 20);
assert.ok(r.max - r.min >= 20 && r.min <= 940 && r.max >= 942);
r = D.autoRange([{ t: 0, v: 35.0 }, { t: 1, v: 35.1 }], 0.5);
assert.ok(r.max - r.min >= 0.5 && r.min <= 35 && r.max >= 35.1);
assert.ok(D.ticks(r).length >= 3);
assert.equal(D.autoRange([], 20), null);

// 변화량: 기준점 있으면 그 뒤 첫 값 대비, 없으면 보이는 구간 첫 값 대비
const pts = [{ t: 0, v: 900 }, { t: 30000, v: 950 }, { t: 60000, v: 1000 }];
assert.deepEqual(D.delta(pts, 60000, 60000, null).d, 100);
assert.equal(D.delta(pts, 60000, 60000, 20000).d, 50);
assert.equal(D.delta(pts, 60000, 60000, 20000).byBase, true);
assert.equal(D.delta([], 60000, 60000, null), null);

console.log("democheck ok");
