// node webapp/selfcheck.mjs — logic.mjs 판정 확인
import assert from "node:assert/strict";
import { co2Slope, mood, decompProgress, decompStage, co2TrendText, addFeed, odorWord, STALE_MS,
  homeState, homeText, stateEvents, addEvents, recent, TEMP_ALERT, CO2_ALERT,
  rate, PEAK_H, predictPpm, CO2_MAX, activity, capPoints, hotFoodHit, hotFoodStep, HOT_COOLDOWN_MS, HOT_MAX_MS, DEMO_SPEED, curveH, autoRange,
  heatModeOf, heaterCmds, restoreMode, ECO_TARGET, AUTO_TARGET, dbCo2Points, mergeCo2, pickFeedTs, dqBadge,
  db1mPoints, joinAggRaw, dbEvents, dbEventText, mergeEvents, EVENT_MAX, faultWord, deviceNote, ctrlTargetOf, LOCAL_CTRL_TEXT } from "./logic.mjs";

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
const S = (t1) => ({ t1 });
assert.deepEqual(hotFoodHit(S(tRise), cJump, now), { src: "t1", preTemp: 30 });
assert.equal(hotFoodHit({ t1: tFlat, t2: tRise }, cJump, now), null); // 히터면(temp2_c) 상승은 감지 안 함
assert.equal(hotFoodHit(S(tRise), cFlat, now), null);   // CO₂ 변화 부족
assert.equal(hotFoodHit(S(tFlat), cJump, now), null);   // 온도 급상승 아님
assert.equal(hotFoodHit(S(tFall), cJump, now), null);   // 하강은 아님
assert.equal(hotFoodHit(S([{ t: now - 90000, c: 30 }, { t: now, c: 34 }]), cJump, now), null); // 60초 밖
const cEarly = [{ t: now - 280000, ppm: 700 }, { t: now - 200000, ppm: 780 }, { t: now, ppm: 790 }]; // CO₂가 3~4분 먼저 변함
assert.equal(hotFoodHit(S(tRise), cEarly, now).src, "t1");
assert.equal(hotFoodHit(S(tRise), [{ t: now - 400000, ppm: 700 }, { t: now, ppm: 790 }].slice(1), now), null); // 5분 밖
let r1 = hotFoodStep(null, { series: S(tRise), co2s: cJump, now, cur: { t1: 33.5 } });
assert.equal(r1.action, "off");
assert.equal(hotFoodStep(r1.st, { series: S(tRise), co2s: cJump, now: now + 1000, cur: { t1: 33 } }).action, null);     // 유지
assert.equal(hotFoodStep(r1.st, { series: S([]), co2s: [], now: now + 60000, cur: { t1: 31 } }).action, "auto");        // 직전+1℃ 이하 복귀
assert.equal(hotFoodStep(r1.st, { series: S([]), co2s: [], now: now + HOT_MAX_MS, cur: { t1: 40 } }).action, "auto");   // 30분
const back = hotFoodStep(r1.st, { series: S([]), co2s: [], now: now + 60000, cur: { t1: 31 } }).st;
const sh = (a, d) => a.map((p) => ({ ...p, t: p.t + d }));
assert.equal(hotFoodStep(back, { series: S(sh(tRise, 120000)), co2s: sh(cJump, 120000), now: now + 120000, cur: { t1: 33.5 } }).action, null); // 쿨다운
assert.equal(hotFoodStep(back, { series: S(sh(tRise, HOT_COOLDOWN_MS)), co2s: sh(cJump, HOT_COOLDOWN_MS), now: now + HOT_COOLDOWN_MS, cur: { t1: 33.5 } }).action, "off");
assert.ok(autoRange([700, 701], 20).max - autoRange([700, 701], 20).min >= 20);
assert.equal(autoRange([4990, 5000], 40, CO2_MAX).max, CO2_MAX);
// 히터 모드(ECO = auto + 목표 30℃)
assert.equal(heatModeOf(null), null);
assert.equal(heatModeOf({ mode: "off", target_c: 30 }), "off");
assert.equal(heatModeOf({ mode: "auto", target_c: 30 }), "eco");
assert.equal(heatModeOf({ mode: "auto", target_c: 37 }), "auto");
assert.equal(heatModeOf({ mode: "auto" }), "auto");                 // 구 3보드: target_c 없음 → ECO 판정 안 함
let n = 0; const mkId = () => `c${n++}`;
assert.deepEqual(heaterCmds("off", mkId), [{ id: "c0", target: "b2", heater: "off" }]);
const eco = heaterCmds("eco", mkId);
assert.deepEqual(eco.map((c) => c.cmd || c.heater), ["set_target", "auto"]);
assert.equal(eco[0].target_c, ECO_TARGET);
assert.equal(heaterCmds("auto", mkId)[0].target_c, AUTO_TARGET);
assert.deepEqual(heaterCmds("on", mkId), []);                          // 강제 ON 없음
assert.ok(heaterCmds("eco", mkId).every((c) => Object.keys(c).filter((k) => k === "cmd" || k === "heater").length === 1)); // 한 메시지 한 명령
assert.equal(restoreMode("eco"), "eco");
assert.equal(restoreMode("auto"), "auto");
assert.equal(restoreMode(null), "auto");
// DB 기록(flags만 사용, 보간 없음)
const iso = (ms) => new Date(ms).toISOString();
const rows = [
  { received_at: iso(now), co2_ppm: 600, co2_status: 1, flags: [] },
  { received_at: iso(now + 2000), co2_ppm: 610, co2_status: 1, flags: ["co2_ppm:spike"] },
  { received_at: iso(now + 4000), co2_ppm: null, co2_status: 0, flags: ["co2_ppm:warming"] },
  { received_at: iso(now + 6000), co2_ppm: 620, co2_status: 1, flags: [] },
  { received_at: iso(now + 30000), co2_ppm: 630, co2_status: 1, flags: ["stream:gap"] },
  { received_at: iso(now + 32000), co2_ppm: 640, co2_status: 1, flags: [] },
];
const dp = dbCo2Points(rows);
assert.deepEqual(dp.map((p) => p.v), [600, 610, null, 620, null, 640]); // 예열·gap에서 선 끊김, 값 지어내지 않음
assert.equal(dp[1].flagged, true);
assert.equal(dp[0].flagged, false);
assert.deepEqual(dbCo2Points([]), []);
assert.deepEqual(dbCo2Points([{ received_at: iso(now), co2_ppm: 600, co2_status: 1, flags: [] }, { received_at: iso(now + 60000), co2_ppm: 700, co2_status: 1, flags: [] }]).map((p) => p.v), [600, null, 700]); // 10초 넘는 빈틈
const mg = mergeCo2([{ t: now - 5000, ppm: 590 }, { t: now + 2000, ppm: 999 }], dp);
assert.equal(mg[0].v, 590);                     // DB 범위 밖 local 점 유지
assert.ok(!mg.some((p) => p.v === 999));         // DB 범위 안 local 점은 DB 우선
assert.deepEqual(mergeCo2([{ t: 1, ppm: 5 }], []), [{ t: 1, v: 5 }]);
assert.equal(pickFeedTs(100, 200), 200);
assert.equal(pickFeedTs(300, null), 300);
assert.equal(pickFeedTs(undefined, NaN), null);
assert.equal(dqBadge(["co2_ppm:warming"]), "예열 중");
assert.equal(dqBadge(["board1:missing"]), "수신 끊김");
assert.equal(dqBadge(["stream:gap", "co2_ppm:warming"]), "수신 끊김");
assert.equal(dqBadge(["temp1_c:spike"]), "");    // 온도 급변은 경고 안 함
assert.equal(dqBadge(null), "");
// DB 1분 집계 뷰
const m = (k) => new Date(now + k * 60000).toISOString();
const ap = db1mPoints([{ minute: m(0), co2_avg: 600.4, flagged: 0 }, { minute: m(1), co2_avg: null, flagged: 30 }, { minute: m(2), co2_avg: 620, flagged: 0 }, { minute: m(10), co2_avg: 650, flagged: 1 }]);
assert.deepEqual(ap.map((p) => p.v), [600, null, 620, null, 650]); // 평균 없음·2분 넘는 빈 분에서 끊김
assert.equal(ap[ap.length - 1].flagged, true);
const jr = joinAggRaw([{ t: now, v: 600 }, { t: now + 60000, v: 610 }, { t: now + 120000, v: 620 }], [{ t: now + 90000, v: 615 }]);
assert.deepEqual(jr.map((p) => p.v), [600, 610, null, 615]);       // 원본이 덮는 시각 이후 집계 버림, 경계 끊김
assert.deepEqual(joinAggRaw([{ t: 1, v: 5 }], []), [{ t: 1, v: 5 }]);
// DB 이벤트 → 알림, 중복 제거
const de = dbEvents([{ id: 7, ts: iso(now), kind: "latched", detail: { fault_text: "과열 50℃" } }, { id: 8, ts: iso(now + 1000), kind: "heater_on", detail: {} }, { id: 9, ts: iso(now + 2000), kind: "reboot", detail: {} }]);
assert.deepEqual(de.map((e) => e.dbId), [7, 9]);                    // 표시 대상 kind만
assert.match(de[0].text, /과열 50℃/);
assert.equal(dbEventText({ kind: "fault", detail: { to: null } }), "기기 오류가 해제됐어요");
const me = mergeEvents([{ ts: now + 500, kind: "alert_on", text: "x" }, de[0]], de);
assert.deepEqual(me.map((e) => e.dbId ?? "local"), [7, "local", 9]); // 시간순, 같은 dbId 하나
assert.equal(mergeEvents(Array.from({ length: 60 }, (_, i) => ({ ts: i, text: "a" })), []).length, EVENT_MAX);
// firmware2 98c9db5: 대체 제어·fault
assert.equal(deviceNote({ ctrl_src: "local", fault_text: "ok" }), LOCAL_CTRL_TEXT);
assert.equal(LOCAL_CTRL_TEXT, "#1 끊김, 대체 제어 중");
assert.equal(deviceNote({ ctrl_src: "core", fault_text: "ok" }), "");
assert.equal(deviceNote({ ctrl_src: "local", fault_text: "local_sensor" }), "히터면 온도 센서 오류로 히터를 껐어요"); // fault 우선
assert.equal(faultWord({ fault_text: "ok" }), "");
assert.equal(deviceNote(undefined), "");
assert.equal(ctrlTargetOf({ ctrl_src: "local", target_c: 30 }), 40);
assert.equal(ctrlTargetOf({ ctrl_src: "core", target_c: 30 }), 30);
assert.equal(dbEventText({ kind: "fault", detail: { to: "local_sensor" } }), "기기 상태: 히터면 온도 센서 오류로 히터를 껐어요");
assert.equal(dbEventText({ kind: "fault", detail: { to: "ok" } }), "기기 오류가 해제됐어요");
console.log("selfcheck ok");
