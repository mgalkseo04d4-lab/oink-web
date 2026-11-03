// node webapp/selfcheck.mjs — logic.mjs 판정 확인
import assert from "node:assert/strict";
import { co2Slope, mood, decompProgress, decompStage, co2TrendText, addFeed, odorWord, STALE_MS,
  homeState, homeText, stateEvents, addEvents, recent, TEMP_ALERT, CO2_ALERT,
  rate, PEAK_H, predictPpm, CO2_MAX, activity, capPoints, hotFoodHit, hotFoodStep, HOT_COOLDOWN_MS, HOT_MAX_MS, DEMO_SPEED, curveH, autoRange } from "./logic.mjs";

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

// 분해 진행(논문 경향 곡선: 정점 72h, 7일 누적=100%)
const H = 3600 * 1000, f0 = now;
assert.equal(decompProgress(null, now), null);
assert.ok(decompProgress(f0, f0) < 0.001);                       // 0h ≈ 0%
assert.ok(decompProgress(f0, f0 + 48 * H) < decompProgress(f0, f0 + 72 * H));
assert.ok(decompProgress(f0, f0 + 7 * 24 * H) >= 0.9);           // 7일 ≈ 90%+
assert.equal(decompProgress(f0, f0 + 10 * 24 * H), 1);
assert.ok(decompProgress(f0, f0 + 6 * 24 * H) > 0.85);            // 꼬리가 작음
for (let h = 1; h < 168; h++) assert.ok(decompProgress(f0, f0 + h * H) >= decompProgress(f0, f0 + (h - 1) * H)); // 단조
// 증가폭(=발생속도) 정점이 72h 근처
let best = 0, bestH = 0;
for (let h = 1; h <= 168; h++) { const d = decompProgress(f0, f0 + h * H) - decompProgress(f0, f0 + (h - 1) * H); if (d > best) { best = d; bestH = h; } }
assert.ok(bestH >= 68 && bestH <= 76, `peak at ${bestH}h`);
assert.equal(decompStage(f0, f0 + 10 * H).key, "start");
assert.equal(decompStage(f0, f0 + 48 * H).key, "start");
assert.equal(decompStage(f0, f0 + 72 * H).key, "peak");
assert.equal(decompStage(f0, f0 + 90 * H).key, "finish");
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
assert.equal(homeText({ state: "alert", reasons: ["hotfood", "hot"] }), "뜨거운 음식이 들어왔어요! 히터를 껐어요");
assert.equal(addEvents(Array.from({ length: 60 }, (_, i) => ({ ts: i })), [{ ts: 99 }]).length, 50);
assert.equal(recent([{ t: 0 }, { t: 900 }], 1000, 500).length, 1);

const many = Array.from({ length: 20 }, (_, i) => ({ ts: i }));
assert.equal(addFeed(many, { ts: 99 }).length, 20);
assert.equal(addFeed(null, { ts: 1 }).length, 1);
assert.equal(odorWord({ odor_index: 2.5 }), "냄새 심해요");

// 예측 곡선: 정점 72h에서 1, 7일에 정점의 10~20%
assert.ok(Math.abs(rate(PEAK_H) - 1) < 1e-9);
for (let h = 1; h <= 168; h++) assert.ok(rate(h) <= 1 + 1e-9);
assert.ok(rate(168) > 0.1 && rate(168) < 0.2, `7d ${rate(168)}`);
assert.equal(rate(0), 0);
assert.equal(predictPpm(600, 500, PEAK_H), 1100);
assert.equal(predictPpm(4800, 500, PEAK_H), CO2_MAX); // 측정 범위 상한
// 시연 배속: 5분 → 168h
assert.ok(Math.abs(curveH(f0, f0 + 5 * 60000, DEMO_SPEED) - 168) < 1e-6);
assert.equal(decompStage(f0, f0 + 1.5 * 60000, DEMO_SPEED).key, "start"); // 1.5분 ≈ 50h
assert.equal(decompStage(f0, f0 + 2.15 * 60000, DEMO_SPEED).key, "peak"); // 2.15분 ≈ 72h
assert.equal(decompStage(f0, f0 + 30 * H).text, "상승 구간(정점 약 3일차 예상)"); // 행사 1박2일 ≈ 30h
// 활성도: 72h 근처, 예측 +500
const at = f0 + 72 * H, mk = (inc) => [0, 1, 2, 3].map((m) => ({ t: at - m * 60000, v: 600 + inc }));
assert.equal(activity({ pts: mk(500), now: at, feedTs: f0, base: 600, amp: 500 }).key, "ok");
assert.equal(activity({ pts: mk(300), now: at, feedTs: f0, base: 600, amp: 500 }).key, "low");
assert.equal(activity({ pts: mk(700), now: at, feedTs: f0, base: 600, amp: 500 }).key, "high");
assert.equal(activity({ pts: mk(400), now: at, feedTs: f0, base: 600, amp: 500 }).key, "ok");   // 80% 경계
assert.equal(activity({ pts: mk(390), now: at, feedTs: f0, base: 600, amp: 500 }).key, "low");
// 투입 직후엔 예측 증가분 작아 판단 대기
const early = f0 + 2 * H;
assert.equal(activity({ pts: [{ t: early, v: 600 }], now: early, feedTs: f0, base: 600, amp: 500 }).key, "wait");
assert.equal(activity({ pts: [], now: at, feedTs: f0, base: 600, amp: 500 }), null);
assert.equal(activity({ pts: mk(500), now: at, feedTs: f0, base: NaN, amp: 500 }), null);
assert.equal(capPoints(Array.from({ length: 2001 }, (_, i) => i)).length, 1501);
// 뜨거운 음식물 감지
const tRise = [{ t: now - 50000, c: 30 }, { t: now - 20000, c: 31 }, { t: now, c: 33.5 }];
const tFlat = [{ t: now - 50000, c: 30 }, { t: now, c: 31 }];
const cJump = [{ t: now - 100000, ppm: 700 }, { t: now, ppm: 760 }];
const cFlat = [{ t: now - 100000, ppm: 700 }, { t: now, ppm: 720 }];
const tFall = [{ t: now - 50000, c: 34 }, { t: now, c: 30 }];
const S = (t1, t2 = []) => ({ t1, t2 });
assert.deepEqual(hotFoodHit(S(tRise), cJump, now), { src: "t1", preTemp: 30 });
assert.deepEqual(hotFoodHit(S(tFlat, tRise), cJump, now), { src: "t2", preTemp: 30 }); // #2 프로브 온수
assert.equal(hotFoodHit(S(tRise), cFlat, now), null);   // CO₂ 변화 부족
assert.equal(hotFoodHit(S(tFlat, tFlat), cJump, now), null);   // 온도 급상승 아님
assert.equal(hotFoodHit(S(tFall), cJump, now), null);   // 하강은 아님
assert.equal(hotFoodHit(S([{ t: now - 90000, c: 30 }, { t: now, c: 34 }]), cJump, now), null); // 60초 밖
const cEarly = [{ t: now - 280000, ppm: 700 }, { t: now - 200000, ppm: 780 }, { t: now, ppm: 790 }]; // CO₂가 3~4분 먼저 변함
assert.equal(hotFoodHit(S(tRise), cEarly, now).src, "t1");
assert.equal(hotFoodHit(S(tRise), [{ t: now - 400000, ppm: 700 }, { t: now, ppm: 790 }].slice(1), now), null); // 5분 밖
let r1 = hotFoodStep(null, { series: S(tRise), co2s: cJump, now, cur: { t1: 33.5 } });
assert.equal(r1.action, "off");
assert.equal(hotFoodStep(r1.st, { series: S(tRise), co2s: cJump, now: now + 1000, cur: { t1: 33 } }).action, null);     // 유지
assert.equal(hotFoodStep(r1.st, { series: S([]), co2s: [], now: now + 60000, cur: { t1: 31 } }).action, "auto");        // 직전+1℃ 이하 복귀
assert.equal(hotFoodStep(r1.st, { series: S([]), co2s: [], now: now + 60000, cur: { t2: 25, t1: 33 } }).action, null);  // 감지한 센서 기준
assert.equal(hotFoodStep(r1.st, { series: S([]), co2s: [], now: now + HOT_MAX_MS, cur: { t1: 40 } }).action, "auto");   // 30분
const back = hotFoodStep(r1.st, { series: S([]), co2s: [], now: now + 60000, cur: { t1: 31 } }).st;
const sh = (a, d) => a.map((p) => ({ ...p, t: p.t + d }));
assert.equal(hotFoodStep(back, { series: S(sh(tRise, 120000)), co2s: sh(cJump, 120000), now: now + 120000, cur: { t1: 33.5 } }).action, null); // 쿨다운
assert.equal(hotFoodStep(back, { series: S(sh(tRise, HOT_COOLDOWN_MS)), co2s: sh(cJump, HOT_COOLDOWN_MS), now: now + HOT_COOLDOWN_MS, cur: { t1: 33.5 } }).action, "off");
assert.ok(autoRange([700, 701], 20).max - autoRange([700, 701], 20).min >= 20);
assert.equal(autoRange([4990, 5000], 40, CO2_MAX).max, CO2_MAX);
console.log("selfcheck ok");
