// node webapp/selfcheck.mjs — logic.mjs 판정 확인
import assert from "node:assert/strict";
import { co2Slope, mood, decompProgress, decompStage, co2TrendText, addFeed, odorWord, STALE_MS,
  homeState, homeText, stateEvents, addEvents, recent, TEMP_ALERT, CO2_ALERT } from "./logic.mjs";

const now = 1_000_000_000;
const rising = [0, 1, 2, 3, 4].map((m) => ({ t: now - (4 - m) * 60000, ppm: 600 + m * 20 }));
const falling = rising.map((p, i) => ({ t: p.t, ppm: 700 - i * 20 }));
assert.ok(co2Slope(rising, now) > 19 && co2Slope(rising, now) < 21);
assert.ok(co2Slope(falling, now) < 0);
assert.equal(co2Slope(rising.slice(0, 2), now), null);

const live = { online: true, lastSeen: now - 1000, now };
assert.equal(mood({ ...live, online: false, b1: { co2_status: 1 }, slope: 5 }), "sleep");
assert.equal(mood({ ...live, lastSeen: now - STALE_MS - 1, b1: { co2_status: 1 }, slope: 5 }), "sleep");
assert.equal(mood({ ...live, b1: null, slope: 5 }), "sleep");
assert.equal(mood({ ...live, b1: { co2_status: 1, odor_index: 2.3 }, slope: 5 }), "smelly");
assert.equal(mood({ ...live, b1: { co2_status: 1, odor_index: 1.1 }, slope: 5 }), "busy");
assert.equal(mood({ ...live, b1: { co2_status: 0, odor_index: 1.1 }, slope: 5 }), "calm");
assert.equal(mood({ ...live, b1: { co2_status: 1, odor_index: 1.1 }, slope: -3 }), "calm");

// 분해 진행(가상 곡선: 정점 48h, 7일 누적=100%)
const H = 3600 * 1000, f0 = now;
assert.equal(decompProgress(null, now), null);
assert.ok(decompProgress(f0, f0) < 0.001);                       // 0h ≈ 0%
assert.ok(decompProgress(f0, f0 + 24 * H) < decompProgress(f0, f0 + 48 * H));
assert.ok(decompProgress(f0, f0 + 7 * 24 * H) >= 0.9);           // 7일 ≈ 90%+
assert.equal(decompProgress(f0, f0 + 10 * 24 * H), 1);
assert.ok(decompProgress(f0, f0 + 6 * 24 * H) > 0.9);             // 꼬리가 작음
for (let h = 1; h < 168; h++) assert.ok(decompProgress(f0, f0 + h * H) >= decompProgress(f0, f0 + (h - 1) * H)); // 단조
// 증가폭(=발생속도) 정점이 48h 근처
let best = 0, bestH = 0;
for (let h = 1; h <= 168; h++) { const d = decompProgress(f0, f0 + h * H) - decompProgress(f0, f0 + (h - 1) * H); if (d > best) { best = d; bestH = h; } }
assert.ok(bestH >= 44 && bestH <= 52, `peak at ${bestH}h`);
assert.equal(decompStage(f0, f0 + 10 * H).key, "start");
assert.equal(decompStage(f0, f0 + 48 * H).key, "peak");
assert.equal(decompStage(f0, f0 + 4 * 24 * H).key, "finish");
assert.equal(decompStage(f0, f0 + 8 * 24 * H).key, "done");
assert.equal(co2TrendText(5), "지금 CO₂가 오르는 중");
assert.equal(co2TrendText(-5), "지금 CO₂가 내리는 중");
assert.equal(co2TrendText(null), "");

// 홈 캐릭터
const L = { online: true, lastSeen: now - 1000, now };
assert.equal(homeState({ ...L, b1: null }).state, "sleep");
assert.equal(homeState({ ...L, online: false, b1: { temp1_c: 30 } }).state, "sleep");
assert.equal(homeState({ ...L, b1: { temp1_c: 32, co2_status: 1, co2_ppm: 400 } }).state, "calm");
assert.deepEqual(homeState({ ...L, b1: { temp1_c: TEMP_ALERT, co2_status: 1, co2_ppm: 400 } }).reasons, ["hot"]);
assert.deepEqual(homeState({ ...L, b1: { temp1_c: 30, co2_status: 1, co2_ppm: CO2_ALERT } }).reasons, ["co2"]);
assert.equal(homeState({ ...L, b1: { temp1_c: 30, co2_status: 0, co2_ppm: 1600 } }).state, "calm"); // 예열 중 CO₂는 무시
assert.equal(homeText(homeState({ ...L, b1: { temp1_c: 45, co2_status: 1, co2_ppm: 1600 } })), "너무 덥고 숨이 막혀요!");
const calm = { state: "calm", reasons: [], gwOnline: true }, alert = { state: "alert", reasons: ["hot"], gwOnline: true };
assert.equal(stateEvents(null, calm, 1).length, 0);
assert.equal(stateEvents(calm, alert, 1)[0].kind, "alert_on");
assert.equal(stateEvents(alert, calm, 1)[0].kind, "alert_off");
assert.equal(stateEvents(calm, { ...calm, gwOnline: false }, 1)[0].kind, "gw_off");
assert.equal(addEvents(Array.from({ length: 60 }, (_, i) => ({ ts: i })), [{ ts: 99 }]).length, 50);
assert.equal(recent([{ t: 0 }, { t: 900 }], 1000, 500).length, 1);

const many = Array.from({ length: 20 }, (_, i) => ({ ts: i }));
assert.equal(addFeed(many, { ts: 99 }).length, 20);
assert.equal(addFeed(null, { ts: 1 }).length, 1);
assert.equal(odorWord({ odor_index: 2.5 }), "냄새 심해요");
console.log("selfcheck ok");
