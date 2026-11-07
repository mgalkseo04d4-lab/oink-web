// node webapp/selfcheck.mjs — logic.mjs 판정 확인
import assert from "node:assert/strict";
import { co2Slope, mood, decompProgress, decompStage, co2TrendText, addFeed, odorWord, STALE_MS,
  co2MoodBad, co2Face, co2AlarmStep, CO2_MOOD, homeState, homeText, stateEvents, addEvents, recent, TEMP_ALERT, CO2_ALERT,
  rate, PEAK_H, predictPpm, CO2_MAX, activity, capPoints, hotFoodHit, hotFoodStep, HOT_COOLDOWN_MS, HOT_MAX_MS, DEMO_SPEED, curveH, autoRange,
  heatModeOf, heaterCmds, restoreMode, ECO_TARGET, AUTO_TARGET, dbCo2Points, mergeCo2, pickFeedTs, dqBadge,
  db1mPoints, joinAggRaw, dbEvents, dbEventText, mergeEvents, EVENT_MAX, faultWord, deviceNote, ctrlTargetOf, LOCAL_CTRL_TEXT, isTwoBoard, b1SrcLabel, srcBadge, co2CardValue, co2Warm, co2Valid, tempCardValue, odorCard, hotHeaterGuard, latchStatus,
  latchResetCmd, latchResetText, FAULT_WORD, LATCH_RESET_ASK, tempBand, co2Arrow, CO2_TREND_MIN, dbTempPoints } from "./logic.mjs";

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
assert.equal(mood({ ...live, b1: { co2_status: 1, co2_ppm: 600, odor_index: 1.1 }, slope: 5 }), "busy");
assert.equal(mood({ ...live, b1: { co2_status: 0, odor_index: 1.1 }, slope: 5 }), "calm");
assert.equal(mood({ ...live, b1: { co2_status: 1, co2_ppm: 600, odor_index: 1.1 }, slope: -3 }), "calm");
assert.equal(mood({ ...live, b1: { co2_status: 1, co2_ppm: 699 } }), "calm");
assert.equal(mood({ ...live, b1: { co2_status: 1, co2_ppm: 700 } }), "smelly");
assert.equal(mood({ ...live, online: false, b1: { co2_status: 1, co2_ppm: 1000 } }), "sleep"); // 끊김 우선

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
assert.deepEqual(homeState({ ...L, b1: { temp1_c: 30, co2_status: 0, co2_ppm: 1600 } }).reasons, ["co2"]); // 예열(0)도 실측값
assert.equal(homeState({ ...L, b1: { temp1_c: 30, co2_status: 2, co2_ppm: 1600 } }).state, "calm"); // 센서 오류(2)는 무시
assert.equal(CO2_MOOD, 700);
assert.equal(co2MoodBad({ co2_status: 1, co2_ppm: 699 }), false); // 표정 기준 경계
assert.equal(co2MoodBad({ co2_status: 1, co2_ppm: 700 }), true);
// 표정: CO₂만으로. 온도 이상이나 대체 제어와 무관
const c1 = (co2_ppm, co2_status = 1) => ({ co2_ppm, co2_status });
assert.equal(co2Face("calm", c1(699)), "happy");
assert.equal(co2Face("calm", c1(700)), "angry");
assert.equal(co2Face("local", c1(699)), "happy");
assert.equal(co2Face("local", c1(700)), "angry");
assert.equal(co2Face("alert", { ...c1(600), temp1_c: 50 }), "happy");
assert.equal(co2Face("sleep", c1(900)), "base");
assert.equal(co2Face("calm", c1(900, 2)), "base");
assert.equal(co2Face("calm", c1(900, 3)), "base");
assert.equal(co2Face("calm", c1(-1)), "base");
assert.equal(co2Face("calm", null), "base");
// 팝업: 넘을 때 1번, 유지 중 없음, 내려갔다 다시 넘으면 또, 무효값은 상태 유지
let al = co2AlarmStep(false, c1(600)); assert.deepEqual(al, { high: false, show: false });
al = co2AlarmStep(al.high, c1(800)); assert.deepEqual(al, { high: true, show: true });
al = co2AlarmStep(al.high, c1(800)); assert.deepEqual(al, { high: true, show: false });
al = co2AlarmStep(al.high, c1(900, 2)); assert.deepEqual(al, { high: true, show: false });
al = co2AlarmStep(al.high, c1(750)); assert.deepEqual(al, { high: true, show: false });
al = co2AlarmStep(al.high, c1(600)); assert.deepEqual(al, { high: false, show: false });
al = co2AlarmStep(al.high, c1(900, 3)); assert.deepEqual(al, { high: false, show: false });
al = co2AlarmStep(al.high, c1(700)); assert.deepEqual(al, { high: true, show: true });
assert.deepEqual(co2AlarmStep(false, c1(800)), { high: true, show: true }); // 첫 유효값이 이미 기준 이상
assert.deepEqual(co2AlarmStep(false, null), { high: false, show: false });
assert.equal(co2MoodBad({ co2_status: 2, co2_ppm: 1600 }), false);
assert.equal(co2MoodBad({ co2_status: 3, co2_ppm: 1600 }), false);
assert.equal(co2MoodBad(null), false);
assert.equal(homeState({ ...L, b1: { temp1_c: 30, co2_status: 1, co2_ppm: 1000 } }).state, "calm"); // 경고는 1500 그대로
assert.equal(homeState({ ...L, b1: { temp1_c: 30, co2_status: 1, co2_ppm: CO2_ALERT - 1 } }).state, "calm"); // 경계 바로 아래
assert.equal(homeState({ ...L, b1: { temp1_c: 30, co2_status: 3, co2_ppm: 1600 } }).state, "calm"); // 범위 초과(3)는 무시
assert.equal(homeState({ ...L, online: false, b1: { temp1_c: 30, co2_status: 1, co2_ppm: 1600 } }).state, "sleep"); // 끊김이 CO₂ 경보보다 우선
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
// 대체 제어 중엔 잠자는 표시 금지, 진짜 끊김만 sleep, 이상이 우선
assert.equal(homeState({ ...L, b1: null, b2: { ctrl_src: "local" } }).state, "local");
assert.equal(homeState({ ...L, b1: { temp1_c: 30 }, b2: { ctrl_src: "local" } }).state, "local");
assert.equal(homeState({ ...L, b1: { temp1_c: TEMP_ALERT }, b2: { ctrl_src: "local" } }).state, "alert");
assert.equal(homeState({ ...L, online: false, b1: null, b2: { ctrl_src: "local" } }).state, "sleep");
assert.equal(homeState({ ...L, b1: null, b2: { ctrl_src: "core" } }).state, "sleep");
assert.equal(homeText({ state: "local", reasons: [] }), LOCAL_CTRL_TEXT);
assert.equal(stateEvents({ state: "alert", gwOnline: true }, { state: "local", reasons: [], gwOnline: true }, 1)[0].kind, "alert_off");
// 2보드 판별·출처 배지
assert.equal(isTwoBoard({ board_ok: true }), true);
assert.equal(isTwoBoard({ board2: { target_c: 37 } }), true);
assert.equal(isTwoBoard(null, { boards: 2 }), true);
assert.equal(isTwoBoard({ board2: { mode: "auto" } }), false);
assert.equal(b1SrcLabel(true, true), "실측");
assert.equal(b1SrcLabel(false, true), "시험값");
assert.equal(b1SrcLabel(false, false), "실측");
// 값 없는 카드엔 출처 배지 없음: #1 끊김(대체 제어) = board1 null, 목표 문구는 유지
assert.equal(srcBadge(co2CardValue(null), "실측"), "");
assert.equal(srcBadge(tempCardValue(null), "실측"), "");
assert.equal(ctrlTargetOf({ ctrl_src: "local", target_c: 30 }), 40);
// CO₂ 센서 준비 중·온도 결측도 같은 규칙, 값이 있으면 표시(0도 값)
assert.equal(srcBadge(co2CardValue({ co2_status: 0, co2_ppm: 640 }), "실측"), "실측"); // 예열(0)도 값 표시
// CO₂ 상태 0 + ppm 800 → 값 표시 + 예열 표시, 2·3·null·음수는 무효
assert.equal(co2CardValue({ co2_status: 0, co2_ppm: 800 }), 800);
assert.equal(co2Warm({ co2_status: 0, co2_ppm: 800 }), true);
assert.equal(co2Warm({ co2_status: 1, co2_ppm: 800 }), false);
assert.equal(co2CardValue({ co2_status: 0x40, co2_ppm: 800 }), 800);
assert.equal(co2CardValue({ co2_status: 2, co2_ppm: 800 }), null);
assert.equal(co2CardValue({ co2_status: 3, co2_ppm: 800 }), null);
assert.equal(co2CardValue({ co2_status: 0, co2_ppm: null }), null);
assert.equal(co2Valid({ co2_status: 1, co2_ppm: -1 }), false);
assert.deepEqual(dbCo2Points([{ received_at: new Date(now).toISOString(), co2_ppm: 800, co2_status: 0, flags: [] }]).map((p) => p.v), [800]);
assert.equal(srcBadge(tempCardValue({ temp1_c: null }), "실측"), "");
assert.equal(srcBadge(co2CardValue({ co2_status: 1, co2_ppm: 640 }), "실측"), "실측");
assert.equal(srcBadge(tempCardValue({ temp1_c: 0 }), "시험값"), "시험값");
// 래치 중 off·auto 미발행(뜨거운 음식물 자동 흐름)
const CLR = { latched: false }, LAT = { latched: true };
const hotA = { active: true, since: 1, src: "t1", preTemp: 30, lastHit: 1 };
const hotEnd = { ...hotA, active: false };
assert.equal(latchStatus(LAT), "latched"); assert.equal(latchStatus(CLR), "clear");
assert.equal(latchStatus(null), "unknown"); assert.equal(latchStatus({ mode: "auto" }), "unknown");
// 평상시: 첫 off·재발행·종료 auto 그대로
assert.equal(hotHeaterGuard({ st: hotA, action: "off" }, CLR, true).cmd, "off");
assert.equal(hotHeaterGuard({ st: hotA, action: null }, CLR, true).cmd, "hold");
assert.equal(hotHeaterGuard({ st: hotA, action: null }, CLR, false).cmd, null);
assert.equal(hotHeaterGuard({ st: hotEnd, action: "auto" }, CLR, true).cmd, "auto");
// 래치 중: 첫 off·재발행·종료 auto 모두 없음
let hg = hotHeaterGuard({ st: hotA, action: "off" }, LAT, true);
assert.equal(hg.cmd, null); assert.equal(hg.blocked, true); assert.equal(hg.st.latchSeen, true);
hg = hotHeaterGuard({ st: hotA, action: null }, LAT, true);
assert.equal(hg.cmd, null); assert.equal(hg.blocked, false); assert.equal(hg.st.latchSeen, true);
hg = hotHeaterGuard({ st: hotEnd, action: "auto" }, LAT, true);
assert.equal(hg.cmd, null); assert.equal(hg.blocked, true);
// 처리 중 래치를 본 뒤엔 풀려도(clear) 재발행·auto 없음
const hotSeen = { ...hotA, latchSeen: true };
assert.equal(hotHeaterGuard({ st: hotSeen, action: null }, CLR, true).cmd, null);
assert.equal(hotHeaterGuard({ st: { ...hotSeen, active: false }, action: "auto" }, CLR, true).cmd, null);
// 상태 모름(board2 없음·latched 없음): 보내지 않음, 다음에 clear면 재발행 재개
assert.equal(hotHeaterGuard({ st: hotA, action: "off" }, null, true).cmd, null);
assert.equal(hotHeaterGuard({ st: hotEnd, action: "auto" }, { mode: "auto" }, true).cmd, null);
assert.equal(hotHeaterGuard({ st: hotA, action: null }, null, true).st.latchSeen, undefined);
// hotFoodStep과 연결: 종료 시 latchSeen 유지
assert.equal(hotFoodStep(hotSeen, { series: { t1: [] }, co2s: [], now: 2, cur: { t1: 30 } }).st.latchSeen, true);
// 과열 차단 해제(latch_reset): 명령 형식, ack 문구. '히터 끄기'는 해제 수단이 아님
assert.deepEqual(latchResetCmd(() => "r1"), { id: "r1", cmd: "latch_reset" });
assert.match(latchResetText({ ok: true }), /풀었어요.*'자동'/);
assert.equal(latchResetText({ ok: false, msg: "too hot: heater 45.2C (need <38C)" }), "아직 뜨거워요 (지금 45.2℃) — 충분히 식힌 뒤 다시 눌러 주세요");
assert.match(latchResetText({ ok: false, msg: "too hot: core 39.0C (need <38C)" }), /아직 뜨거워요 \(지금 39\.0℃\)/);
assert.match(latchResetText({ ok: false, msg: "not latched" }), /이미/);
assert.match(latchResetText({ ok: false, msg: "sensor error: heater surface temp unknown" }), /확인할 수 없어/);
assert.match(latchResetText({ ok: false, msg: "wait: core readings not stable yet" }), /잠시 뒤/);
assert.match(latchResetText({ ok: false }), /풀지 못했어요/);
for (const k of ["overheat", "no_rise"]) { assert.match(FAULT_WORD[k], /과열 차단 해제/); assert.doesNotMatch(FAULT_WORD[k], /히터 끄기/); }
assert.match(LATCH_RESET_ASK, /'자동'/);
// 냄새 지수 카드: 비율 소수 1자리, null = 교정 전, 연결 없음 = 표시 없음, 예열 비트
assert.deepEqual(odorCard(null), { text: "—", badge: "", warm: false });
assert.deepEqual(odorCard({ odor_index: null, err: 0 }), { text: "—", badge: "교정 전", warm: false });
assert.deepEqual(odorCard({ odor_index: null, err: 4 }), { text: "—", badge: "교정 전", warm: true });
assert.deepEqual(odorCard({ odor_index: 1.27, err: 1 }), { text: "1.3", badge: "실측", warm: false });
// 지수 없으면 gas_v 전압 + 실측, 지수가 있으면 지수 우선, gas_v도 없으면 기존 빈 표시
assert.deepEqual(odorCard({ odor_index: null, gas_v: 3.14, err: 0 }), { text: "3.14 V", badge: "실측", warm: false });
assert.deepEqual(odorCard({ gas_v: 0, err: 4 }), { text: "0.00 V", badge: "실측", warm: true });
assert.deepEqual(odorCard({ odor_index: 1.27, gas_v: 3.14, err: 0 }), { text: "1.3", badge: "실측", warm: false });
assert.deepEqual(odorCard({ odor_index: null, gas_v: null, err: 0 }), { text: "—", badge: "교정 전", warm: false });
for (const v of [null, undefined, NaN, "1.1"]) assert.equal(odorWord({ odor_index: v }), "확인 중");
// 효과음: 첫 입력 전·끄기 상태에는 AudioContext를 만들지 않고, 소리 실패가 밖으로 새지 않음
let acMade = 0, arm;
globalThis.addEventListener = (ev, f) => { arm = f; };
globalThis.AudioContext = class { constructor() { acMade++; throw new Error("no audio"); } };
const snd = await import("./sound.js");
snd.play("pong"); assert.equal(acMade, 0);
arm(); snd.setSoundOn(false); snd.play("boing"); assert.equal(acMade, 0);
snd.setSoundOn(true); snd.play("boing"); assert.equal(acMade, 1);
// 돼지 탭 뽀잉: 변형이 3종 이상이고 연속으로 같은 피치가 없으며, 어떤 피치든 음역·길이가 뽀잉 범위 안
assert.ok(snd.BOING_PITCHES.length >= 3);
for (const p of snd.BOING_PITCHES) {
  assert.ok(snd.BOING.start * p >= 280 && snd.BOING.start * p <= 400);
  assert.ok(snd.BOING.peak * p >= 750 && snd.BOING.peak * p <= 1050);
  assert.ok(snd.BOING.end * p < snd.BOING.peak * p);
  assert.ok(snd.BOING.dur / p >= 0.2 && snd.BOING.dur / p <= 0.3);
}
for (let i = 0, p = null; i < 200; i++) { const k = snd.nextPitch(p); assert.ok(snd.BOING_PITCHES.includes(k)); assert.notEqual(k, p); p = k; }
// 홈 온도 배지 구간: 30~40 정상, 40 초과~45 미만 주의, 45 이상 과열(TEMP_ALERT와 같은 경계), 값 없음 = 배지 없음
assert.equal(tempBand(null), null); assert.equal(tempBand(NaN), null);
assert.equal(tempBand(29.9).key, "low"); assert.equal(tempBand(30).key, "ok"); assert.equal(tempBand(36.5).key, "ok"); assert.equal(tempBand(40).key, "ok");
assert.equal(tempBand(40.1).key, "warn"); assert.equal(tempBand(44.9).key, "warn"); assert.equal(tempBand(TEMP_ALERT).key, "hot"); assert.equal(tempBand(52).text, "과열");
// 홈 CO₂ 추세 화살표: 잡음 수준 기울기는 →, 이력 부족(null)은 표시 없음
assert.equal(co2Arrow(null), ""); assert.equal(co2Arrow(0), "→"); assert.equal(co2Arrow(CO2_TREND_MIN - 0.1), "→"); assert.equal(co2Arrow(-(CO2_TREND_MIN - 0.1)), "→");
assert.equal(co2Arrow(co2Slope(rising, now)), "↑"); assert.equal(co2Arrow(co2Slope(falling, now)), "↓");
const noisy = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ t: now - (9 - i) * 30000, ppm: 600 + (i % 2 ? 25 : -25) })); // ±25ppm 흔들림
assert.equal(co2Arrow(co2Slope(noisy, now)), "→");
// DB 심부 온도 점: 시간순, 결측·오류·#1 끊김 행 제외, spike는 유지
assert.deepEqual(dbTempPoints([
  { received_at: "2026-11-06T00:00:04Z", temp1_c: 36.1, flags: ["temp1_c:spike"] },
  { received_at: "2026-11-06T00:00:00Z", temp1_c: 35.9, flags: [] },
  { received_at: "2026-11-06T00:00:02Z", temp1_c: 85, flags: ["temp1_c:sensor_error"] },
  { received_at: "2026-11-06T00:00:06Z", temp1_c: null, flags: ["board1:missing"] },
]), [{ t: Date.parse("2026-11-06T00:00:00Z"), v: 35.9 }, { t: Date.parse("2026-11-06T00:00:04Z"), v: 36.1 }]);
assert.deepEqual(dbTempPoints(null), []);
console.log("selfcheck ok");
