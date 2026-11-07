// 화면 판정 순수 로직 (브라우저·node 공용, DOM 없음). 셀프체크: node webapp/selfcheck.mjs
export const STALE_MS = 10000;
export const SLOPE_WINDOW_MS = 5 * 60 * 1000;

// 최근 5분 CO₂ 기울기(ppm/분), 선형회귀. 점 3개 미만이거나 1분 미만이면 null.
export function co2Slope(hist, now) {
  const pts = hist.filter((p) => now - p.t <= SLOPE_WINDOW_MS && Number.isFinite(p.ppm));
  if (pts.length < 3 || pts[pts.length - 1].t - pts[0].t < 60000) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.t, 0) / n;
  const my = pts.reduce((s, p) => s + p.ppm, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.t - mx) * (p.ppm - my); den += (p.t - mx) ** 2; }
  return den ? (num / den) * 60000 : null;
}

// CO₂ 값 사용 가능: ppm이 0 이상 숫자이고 상태가 센서 오류(2)·범위 초과(3)가 아님. 상태 0(예열)도 실측값이라 쓴다(펌웨어 226127b)
export const co2Valid = (b1) => Number.isFinite(b1?.co2_ppm) && b1.co2_ppm >= 0 && b1.co2_status !== 2 && b1.co2_status !== 3;
export const co2Warm = (b1) => co2Valid(b1) && b1.co2_status === 0; // 값은 보여 주고 "예열 중" 표시만

// 캐릭터 상태: sleep | smelly | busy | calm
// 표정 전용 CO₂ 기준. 경고 판정은 CO2_ALERT(1500) 그대로
export const CO2_MOOD = 1000;
export const co2MoodBad = (b1) => co2Valid(b1) && b1.co2_ppm >= CO2_MOOD;

export function mood({ online, lastSeen, now, b1, slope }) {
  if (!online || !lastSeen || now - lastSeen > STALE_MS || !b1) return "sleep";
  if (co2MoodBad(b1)) return "smelly";
  if (typeof b1.odor_index === "number" && b1.odor_index >= 2) return "smelly";
  if (co2Valid(b1) && slope != null && slope > 0) return "busy";
  return "calm";
}

export const MOOD_TEXT = {
  sleep: "쿨쿨 자는 중… 💤",
  smelly: "냄새가 나요 😣 환기가 필요해요",
  busy: "열심히 분해 중! 💪",
  calm: "편안해요 😊",
};

// 분해 진행·CO₂ 예측 — 논문 경향 기반 추정(실측 아님, CLAUDE.md "CO₂ 해석 기준").
// Sustainability 2025, 17(17), 8041: 음식물 혼합 시 CO₂ 정점이 초기 1~3일, 3일차 무렵 → 정점 72h.
// 발생속도 r(t) ∝ t⁴·e^(−t/θ), θ=18h → 정점 4θ=72h, 7일(168h)에 정점의 약 14%.
// 진행도 = 0~t 누적 면적 / 0~7일 누적 면적. 감마(형상5) 누적 F(x)=1−e^(−x)Σ_{k<5} x^k/k!
export const PEAK_H = 72;
export const DECOMP_THETA_H = PEAK_H / 4;
export const DECOMP_END_H = 168;
export const DEMO_SPEED = (DECOMP_END_H * 60) / 5; // 시연 배속: 7일 → 5분(이스트 컵 교체 순간 투입 버튼 = t0)
const gammaCdf5 = (x) => 1 - Math.exp(-x) * (1 + x + x ** 2 / 2 + x ** 3 / 6 + x ** 4 / 24);
// 투입 후 곡선 시간(시간 단위). speed=1 실제, DEMO_SPEED 시연
export const curveH = (feedTs, t, speed = 1) => Math.max(0, ((t - feedTs) / 3600000) * speed);
// 발생속도 곡선, 정점=1
export function rate(h) {
  if (h <= 0) return 0;
  const x = h / DECOMP_THETA_H;
  return (x / 4) ** 4 * Math.exp(4 - x);
}
export function decompProgress(feedTs, now, speed = 1) {
  if (!feedTs) return null;
  const h = curveH(feedTs, now, speed);
  if (h >= DECOMP_END_H) return 1;
  return gammaCdf5(h / DECOMP_THETA_H) / gammaCdf5(DECOMP_END_H / DECOMP_THETA_H);
}
// 경과 시간 기준 단계: 0~60h 시작, 60~84h(72h±12h) 정점, 84h~7일 마무리, 7일~ 끝
export function decompStage(feedTs, now, speed = 1) {
  if (!feedTs) return null;
  const h = curveH(feedTs, now, speed);
  if (h < PEAK_H - 12) return { key: "start", text: "상승 구간(정점 약 3일차 예상)" };
  if (h < PEAK_H + 12) return { key: "peak", text: "가장 활발해요" };
  if (h < DECOMP_END_H) return { key: "finish", text: "마무리 중" };
  return { key: "done", text: "거의 끝났어요" };
}
// 예측 CO₂(ppm) = 투입 시점 기준값 + AMP × r(h)
export const AMP_DEFAULT = 500; // 임의 가정(보정 전) — 첫 투입 실측으로 보정
export const CO2_MAX = 5000; // CM1106 측정 범위 0~5000ppm
export const predictPpm = (base, amp, h) => Math.min(CO2_MAX, base + amp * rate(h));

// 분해 활성도: 최근 5분 실측 평균 증가분 / 같은 시점 예측 증가분. pts: [{t, v}]
export const ACT_WINDOW_MS = 5 * 60 * 1000;
export const ACT_MIN_PRED = 20; // 예측 증가분이 이보다 작으면 판단 대기(ppm)
export function activity({ pts, now, feedTs, base, amp, speed = 1 }) {
  if (!feedTs || !Number.isFinite(base)) return null;
  const win = pts.filter((p) => p.t >= feedTs && now - p.t <= ACT_WINDOW_MS && Number.isFinite(p.v));
  if (!win.length) return null;
  const real = win.reduce((s, p) => s + p.v, 0) / win.length - base;
  const pred = win.reduce((s, p) => s + amp * rate(curveH(feedTs, p.t, speed)), 0) / win.length;
  if (pred < ACT_MIN_PRED) return { pct: null, key: "wait", text: "판단 대기 — 예측 변화가 아직 작아요" };
  const pct = Math.round((real / pred) * 100);
  if (pct < 80) return { pct, key: "low", text: "미생물 활동이 약해요" };
  if (pct > 120) return { pct, key: "high", text: "아주 활발해요" };
  return { pct, key: "ok", text: "예상대로 잘 분해 중" };
}

// 실측 기록 다운샘플: 최대 max점, 넘으면 오래된 절반을 하나 건너 하나로
export function capPoints(pts, max = 2000) {
  if (pts.length <= max) return pts;
  const half = Math.floor(pts.length / 2);
  return [...pts.slice(0, half).filter((_, i) => i % 2 === 0), ...pts.slice(half)];
}

// ---- 뜨거운 음식물 감지 → 히터 OFF, 안정되면 AUTO ----
// 시연계획: CO₂ 장면(이스트 컵)이 온도 장면(#2 프로브 60℃ 온수)보다 1~2분 먼저 → CO₂는 최근 5분을 본다.
// #1은 5초, #2는 2초 주기라 60초 창에 점 12~30개.
export const HOT_RISE_C = 3, HOT_RISE_MS = 60000;      // temp1_c(심부)가 60초 내 +3℃. temp2_c는 히터면 온도라 가열만으로 오르므로 쓰지 않음
export const HOT_CO2_D = 50, HOT_CO2_MS = 5 * 60000;    // 최근 5분 안 CO₂ |Δ|≥50ppm
export const HOT_COOLDOWN_MS = 10 * 60000;
export const HOT_RESTORE_C = 1, HOT_MAX_MS = 30 * 60000;
// 한 온도 계열의 60초 내 상승: 최저점 이후 마지막 값이 +3℃ 이상이면 최저값 반환
function riseFrom(temps, now) {
  const tw = (temps || []).filter((p) => now - p.t <= HOT_RISE_MS);
  if (tw.length < 2) return null;
  let lo = tw[0];
  for (const p of tw) if (p.c < lo.c) lo = p;
  const last = tw[tw.length - 1];
  return last.t > lo.t && last.c - lo.c >= HOT_RISE_C ? lo.c : null;
}
// series: { t1: [{t, c}] }, co2s: [{t, ppm}] (co2Valid인 점만)
export function hotFoodHit(series, co2s, now) {
  const cv = co2s.filter((p) => now - p.t <= HOT_CO2_MS).map((p) => p.ppm);
  if (cv.length < 2 || Math.max(...cv) - Math.min(...cv) < HOT_CO2_D) return null;
  const pre = riseFrom(series.t1, now);
  return pre != null ? { src: "t1", preTemp: pre } : null;
}
// st: { active, since, src, preTemp, lastHit }, cur: { t1 } 현재 온도 → { st, action: "off" | "auto" | null }
export function hotFoodStep(st, { series, co2s, now, cur }) {
  st = st || { active: false, since: 0, src: null, preTemp: null, lastHit: 0 };
  if (st.active) {
    const c = cur?.[st.src];
    if ((Number.isFinite(c) && c <= st.preTemp + HOT_RESTORE_C) || now - st.since >= HOT_MAX_MS)
      return { st: { ...st, active: false }, action: "auto" };
    return { st, action: null };
  }
  if (now - st.lastHit < HOT_COOLDOWN_MS) return { st, action: null };
  const hit = hotFoodHit(series, co2s, now);
  if (!hit) return { st, action: null };
  return { st: { active: true, since: now, src: hit.src, preTemp: hit.preTemp, lastHit: now }, action: "off" };
}
export const HOT_MSG_OFF = "뜨거운 온도의 음식물이 투입됨을 확인하였습니다. 히터 발열을 제어합니다.";
export const HOT_MSG_AUTO = "온도가 안정되어 히터 자동 제어로 돌아갑니다.";

// 실시간 그래프 y범위: 최소 폭 보장, 10% 여유
export function autoRange(vs, minSpan, cap = Infinity) {
  if (!vs.length) return null;
  const lo = Math.min(...vs), hi = Math.max(...vs), mid = (lo + hi) / 2, span = Math.max(hi - lo, minSpan) * 1.2;
  const max = Math.min(cap, mid + span / 2);
  return { min: Math.min(mid - span / 2, max - minSpan), max };
}
// 앱이 열려 있는 동안 OFF 유지: #2는 30초 무수신이면 auto로 돌아가므로 10초마다 재발행
export const HOLD_RESEND_MS = 10000;
// 래치 해제는 사람이 누르는 '과열 차단 해제'(latch_reset)만 한다. off는 정지 전용이라 해제와 무관하지만,
// 래치를 본 자동 흐름은 복귀(auto)를 사람에게 맡기려고 off·auto를 보내지 않는다. 사람이 누르는 '히터 끄기'는 이 판단을 거치지 않는다(정지만, 해제 아님).
// latched가 boolean이 아니면(board2 없음·구 펌웨어) "unknown" = 안전 쪽으로 보내지 않음
export const latchStatus = (b2) => (b2?.latched === true ? "latched" : b2?.latched === false ? "clear" : "unknown");
// r = hotFoodStep 결과, 방금 받은 텔레메트리의 b2로 판단(텔레메트리 수신 때만 호출되므로 오래된 값으로 보내지 않음).
// 처리 중 래치를 한 번 보면(latchSeen) 풀린 뒤에도 그 처리가 끝날 때까지 off·auto 없음: 복귀는 사람이 결정.
// 반환 cmd: "off"(첫 발행) | "auto"(종료) | "hold"(재발행) | null, blocked: 발행할 차례였는데 막음(off·auto만)
export function hotHeaterGuard(r, b2, resendDue) {
  const latch = latchStatus(b2);
  const st = r.st.active && latch === "latched" && !r.st.latchSeen ? { ...r.st, latchSeen: true } : r.st;
  const safe = latch === "clear" && !st.latchSeen;
  return { st, cmd: !safe ? null : r.action ?? (st.active && resendDue ? "hold" : null), blocked: !!r.action && !safe };
}
export const HOT_MSG_BLOCKED = "과열 차단 중이거나 상태를 확인할 수 없어 뜨거운 음식물 처리의 히터 명령을 보내지 않았어요. 기기 상태를 확인해 주세요.";
// 실측 CO₂ 추세 보조 문구(slope: ppm/분, co2Slope 결과)
export function co2TrendText(slope) {
  if (slope == null) return "";
  if (slope > 1) return "지금 CO₂가 오르는 중";
  if (slope < -1) return "지금 CO₂가 내리는 중";
  return "지금 CO₂가 잔잔해요";
}

// 쉬운 말 요약
export function co2Word(b1, slope) {
  if (!b1) return "연결 안 됨";
  if (!co2Valid(b1)) return "준비 중";
  return slope != null && slope > 0 ? "활발해요" : "잔잔해요";
}
export function odorWord(b1) {
  if (!b1) return "연결 안 됨";
  const v = b1.odor_index;
  if (!Number.isFinite(v)) return "확인 중";
  return v < 1.3 ? "상쾌해요" : v < 2 ? "조금 나요" : "냄새 심해요";
}
// 냄새 지수 카드: R0/Rs 비율(깨끗한 공기 = 1). err 비트 4 = OINK_ERR_H2S_WARMUP(Oink2Proto.h, board1.err로 전달)
export const ERR_H2S_WARMUP = 1 << 2;
export function odorCard(b1) {
  if (!b1) return { text: "—", badge: "", warm: false };
  const ok = Number.isFinite(b1.odor_index), warm = !!(b1.err & ERR_H2S_WARMUP);
  // 지수가 없으면(R0 교정 전) 펌웨어가 계속 보내는 D8 전압 실측값을 보여 준다
  if (!ok && Number.isFinite(b1.gas_v)) return { text: `${b1.gas_v.toFixed(2)} V`, badge: srcBadge(b1.gas_v, "실측"), warm };
  return { text: ok ? b1.odor_index.toFixed(1) : "—", badge: ok ? "실측" : "교정 전", warm };
}
export function tempWord(t) {
  if (typeof t !== "number") return "확인 중";
  return t >= 30 ? "따뜻해요" : t >= 20 ? "미지근해요" : "차가워요";
}

// 투입 기록: 받은 최신 배열 + 새 기록 → 최근 20건
export function addFeed(log, entry) {
  return [...(Array.isArray(log) ? log : []), entry].slice(-20);
}

// ---- 홈 캐릭터(스케치 기준): calm(노랑) | alert(빨강) | sleep(회색) ----
export const TEMP_ALERT = 45;   // 심부온도 ℃ 이상이면 이상
export const CO2_ALERT = 1500;  // CO₂ ppm 이상이면 이상(co2Valid일 때, 예열 중 포함)

// 반환: { state, reasons } — reasons: "hot" | "co2"
export function homeState({ online, lastSeen, now, b1, b2 }) {
  if (!online || !lastSeen || now - lastSeen > STALE_MS) return { state: "sleep", reasons: [] };
  const local = b2?.ctrl_src === "local"; // 기기는 동작 중(#1 끊김, 대체 제어) — 잠자는 표시 금지
  if (!b1) return { state: local ? "local" : "sleep", reasons: [] };
  const reasons = [];
  if (Number.isFinite(b1.temp1_c) && b1.temp1_c >= TEMP_ALERT) reasons.push("hot");
  if (co2Valid(b1) && b1.co2_ppm >= CO2_ALERT) reasons.push("co2");
  return { state: reasons.length ? "alert" : local ? "local" : "calm", reasons };
}

// 홈 심부 온도 배지: 정상 30~40℃, 주의 40~45℃, 과열 45℃ 이상(TEMP_ALERT). 30℃ 미만은 경고 아님(낮음)
export function tempBand(t) {
  if (!Number.isFinite(t)) return null;
  if (t >= TEMP_ALERT) return { key: "hot", text: "과열" };
  if (t > 40) return { key: "warn", text: "주의" };
  return t >= 30 ? { key: "ok", text: "정상" } : { key: "low", text: "낮음" };
}
// 홈 CO₂ 추세 화살표(slope = co2Slope, ppm/분). 10ppm/분 = 5분 창에서 50ppm(CM1106 정확도 ±50ppm급) — 그보다 작으면 잡음으로 보고 →
export const CO2_TREND_MIN = 10;
export const co2Arrow = (slope) => (slope == null ? "" : slope >= CO2_TREND_MIN ? "↑" : slope <= -CO2_TREND_MIN ? "↓" : "→");
// DB telemetry 행 → 심부 온도 점(홈 통합 추이). 결측·센서 오류·범위 밖·#1 끊김 행은 뺀다(급변 spike는 정상 사용)
const TEMP_BAD = ["temp1_c:missing", "temp1_c:sensor_error", "temp1_c:out_of_range", "board1:missing"];
export const dbTempPoints = (rows) => (Array.isArray(rows) ? rows : [])
  .map((r) => ({ t: Date.parse(r.received_at), v: r.temp1_c, bad: Array.isArray(r.flags) && r.flags.some((f) => TEMP_BAD.includes(f)) }))
  .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && !p.bad).map(({ t, v }) => ({ t, v })).sort((a, b) => a.t - b.t);

export function homeText({ state, reasons }) {
  if (state === "sleep") return "쿨쿨 자는 중… 💤";
  if (state === "local") return LOCAL_CTRL_TEXT;
  if (state === "calm") return "편안해요 😊";
  if (reasons.includes("hotfood")) return "뜨거운 음식이 들어왔어요! 히터를 껐어요";
  if (reasons.includes("hot") && reasons.includes("co2")) return "너무 덥고 숨이 막혀요!";
  return reasons.includes("hot") ? "너무 더워요!" : "숨이 막혀요!";
}

// 이전 상태 → 지금 상태로 바뀔 때 생기는 알림. prev/cur: { state, reasons, gwOnline }
export function stateEvents(prev, cur, now) {
  const ev = [];
  if (!prev) return ev;
  if (prev.gwOnline && !cur.gwOnline) ev.push({ ts: now, kind: "gw_off", text: "Oink 연결이 끊겼어요" });
  if (!prev.gwOnline && cur.gwOnline) ev.push({ ts: now, kind: "gw_on", text: "Oink가 다시 연결됐어요" });
  if (prev.state !== "alert" && cur.state === "alert") ev.push({ ts: now, kind: "alert_on", text: `이상: ${homeText(cur)}` });
  if (prev.state === "alert" && (cur.state === "calm" || cur.state === "local")) ev.push({ ts: now, kind: "alert_off", text: "다시 편안해졌어요" });
  return ev;
}

export const EVENT_MAX = 50;
export function addEvents(list, evs) {
  return [...(Array.isArray(list) ? list : []), ...evs].slice(-EVENT_MAX);
}

// 최근 windowMs 안의 점만
export function recent(hist, now, windowMs) {
  return hist.filter((p) => now - p.t <= windowMs);
}

// ---- 히터 모드(firmware2: mode auto|off + target_c, eco 모드 없음 → ECO = auto + 목표 30℃) ----
export const AUTO_TARGET = 37; // firmware2 TARGET_C_DEFAULT
export const ECO_TARGET = 30;  // firmware2 TARGET_C_MIN (set_target 30~40만 받음)
// 반환: "off" | "eco" | "auto" | 그 밖의 mode 문자열 | null. target_c가 없는 구 3보드 펌웨어는 ECO 판정 안 함
export function heatModeOf(b2) {
  if (!b2) return null;
  if (b2.mode === "off") return "off";
  if (b2.mode === "auto") return Number.isFinite(b2.target_c) && b2.target_c <= ECO_TARGET + 0.5 ? "eco" : "auto";
  return b2.mode ?? null;
}
// 보낼 명령 목록(순서대로). firmware2는 문자열 검색 파서라 한 메시지에 한 명령만 넣는다.
// heater:"off|auto"는 구 게이트웨이도 받는 형식, set_target은 firmware2만(구 게이트웨이는 무시).
export function heaterCmds(want, mkId) {
  if (want === "off") return [{ id: mkId(), target: "b2", heater: "off" }];
  if (want !== "auto" && want !== "eco") return [];
  return [{ id: mkId(), cmd: "set_target", target_c: want === "eco" ? ECO_TARGET : AUTO_TARGET },
    { id: mkId(), target: "b2", heater: "auto" }];
}
// 뜨거운 음식물 OFF 유지가 끝난 뒤 돌아갈 모드: 감지 직전이 ECO였으면 ECO, 아니면 자동
export function restoreMode(pre) { return pre === "eco" ? "eco" : "auto"; }

// ---- Supabase(DB) 기록: 판정은 DB 트리거가 한다. 앱은 flags만 읽는다(1106본대회/DB/data_quality.md) ----
const BREAK_FLAGS = ["stream:gap", "board1:missing", "co2_ppm:missing", "co2_ppm:warming"];
// DB telemetry 행 → CO₂ 점. v=null은 선 끊김(결측·끊김 구간, 보간 안 함). flagged=플래그 있는 점(회색 속빈 원)
export function dbCo2Points(rows, gapMs = 30000) { // 정상 2초 주기. 10초 초과 빈틈은 DB가 stream:gap으로 표시하고, 여기선 행이 빠진 30초 초과 빈틈도 끊는다
  const out = [];
  let prevT = null;
  const sorted = (Array.isArray(rows) ? rows : []).map((r) => ({ ...r, t: Date.parse(r.received_at) }))
    .filter((r) => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
  for (const r of sorted) {
    const fl = Array.isArray(r.flags) ? r.flags : [];
    const ok = co2Valid(r);
    if (prevT != null && r.t - prevT > gapMs && out.length && out[out.length - 1].v != null) out.push({ t: r.t - 1, v: null });
    if (!ok || fl.some((f) => BREAK_FLAGS.includes(f))) { if (out.length && out[out.length - 1].v != null) out.push({ t: r.t, v: null }); }
    else out.push({ t: r.t, v: r.co2_ppm, flagged: fl.some((f) => f.startsWith("co2_ppm:")) });
    prevT = r.t;
  }
  return out;
}
// 이 기기 기록(local {t,ppm}) + DB 점. DB가 덮는 시간 범위 안의 local 점은 버린다(DB 우선)
export function mergeCo2(local, db) {
  const d = db.filter((p) => Number.isFinite(p.t));
  if (!d.length) return local.map((p) => ({ t: p.t, v: p.ppm }));
  const lo = d[0].t, hi = d[d.length - 1].t;
  const rest = local.filter((p) => p.t < lo || p.t > hi).map((p) => ({ t: p.t, v: p.ppm }));
  return [...rest, ...d].sort((a, b) => a.t - b.t);
}
// 최근 투입 시각: MQTT retained 기록과 DB feed_log 중 더 최근
export function pickFeedTs(mqttTs, dbTs) {
  const a = Number.isFinite(mqttTs) ? mqttTs : null, b = Number.isFinite(dbTs) ? dbTs : null;
  return a == null ? b : b == null ? a : Math.max(a, b);
}
// 최신 DB 행 flags → 카드 배지. 온도 급변(spike)은 투입·시연 때 정상이라 배지 없음
export function dqBadge(flags) {
  const fl = Array.isArray(flags) ? flags : [];
  if (fl.includes("board1:missing") || fl.includes("stream:gap")) return "수신 끊김";
  if (fl.includes("co2_ppm:warming")) return "예열 중";
  return "";
}

// ---- DB 1분 집계 뷰(telemetry_1m) + DB 이벤트 ----
export const DB_RAW_MS = 2 * 3600 * 1000; // 최근 2시간은 원본(2초), 그 이전은 1분 집계
// telemetry_1m 행 → CO₂ 점. 평균이 없거나(정상 행 없음) 2분 넘게 빈 분은 선 끊기
export function db1mPoints(rows, gapMs = 120000) {
  const out = [];
  let prevT = null;
  const sorted = (Array.isArray(rows) ? rows : []).map((r) => ({ t: Date.parse(r.minute), v: r.co2_avg == null ? null : Number(r.co2_avg), flagged: r.flagged > 0 }))
    .filter((r) => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (prevT != null && r.t - prevT > gapMs && last && last.v != null) out.push({ t: r.t - 1, v: null });
    if (r.v == null || !Number.isFinite(r.v)) { if (out.length && out[out.length - 1].v != null) out.push({ t: r.t, v: null }); }
    else out.push({ t: r.t, v: Math.round(r.v), flagged: r.flagged });
    prevT = r.t;
  }
  return out;
}
// 1분 집계 점(오래된 구간) + 원본 점(최근). 원본이 덮는 시각 이후의 집계 점은 버린다
export function joinAggRaw(agg, raw) {
  const lo = raw.find((p) => Number.isFinite(p.t))?.t;
  if (lo == null) return agg.slice();
  const head = agg.filter((p) => p.t < lo);
  if (head.length && head[head.length - 1].v != null) head.push({ t: lo - 1, v: null }); // 경계는 끊어 보간처럼 보이지 않게
  return [...head, ...raw];
}
// DB events → 알림 항목. 다른 폰에서도 같은 기록이 보이게(id로 중복 제거)
// firmware2 heater_core.h faultText → 사용자 문구
export const FAULT_WORD = {
  no_data: "센서 값을 못 받아 히터를 껐어요",
  overheat: "과열 차단 중이에요 — 충분히 식은 뒤 '과열 차단 해제'를 눌러 주세요",
  ontime_rest: "오래 가열해서 10분 쉬는 중이에요",
  no_rise: "온도가 오르지 않아 히터를 멈췄어요 — 온도 탐침을 확인한 뒤 '과열 차단 해제'를 눌러 주세요",
  hard_off: "45℃가 넘어 히터를 잠시 껐어요",
  board_mismatch: "본체 보드 설정이 달라 히터가 꺼져 있어요",
  local_sensor: "히터면 온도 센서 오류로 히터를 껐어요",
};
// 과열 차단 해제: 사용자가 버튼을 직접 눌렀을 때만 발행(firmware2 latch_reset). 해제 뒤 히터는 꺼짐, '자동'을 눌러야 다시 데움.
export const latchResetCmd = (mkId) => ({ id: mkId(), cmd: "latch_reset" });
export const LATCH_RESET_ASK = "기기가 충분히 식었나요?\n과열 차단을 풀어도 히터는 꺼진 채로 있어요. 다시 데우려면 '자동'을 눌러 주세요.";
export const LATCH_RESET_NOACK = "기기 응답이 없어요 — 잠시 뒤 다시 눌러 주세요";
// ack {ok,msg} → 사용자 문구. msg는 firmware2 resetMsg(영문 코드 + 온도)
export function latchResetText(ack) {
  if (ack?.ok === true) return "과열 차단을 풀었어요. 히터는 꺼져 있어요 — 다시 데우려면 '자동'을 눌러 주세요";
  const m = String(ack?.msg ?? "");
  const t = m.match(/(-?\d+(?:\.\d+)?)C \(/);
  if (m.startsWith("not latched")) return "이미 과열 차단이 풀려 있어요";
  if (m.startsWith("too hot")) return `아직 뜨거워요${t ? ` (지금 ${t[1]}℃)` : ""} — 충분히 식힌 뒤 다시 눌러 주세요`;
  if (m.startsWith("sensor error")) return "온도를 확인할 수 없어 풀 수 없어요 — 온도 센서 연결을 확인해 주세요";
  if (m.startsWith("wait")) return "온도를 확인하는 중이에요 — 잠시 뒤 다시 눌러 주세요";
  return "과열 차단을 풀지 못했어요 — 기기 상태를 확인해 주세요";
}
export const LOCAL_CTRL_TEXT = "#1 끊김, 대체 제어 중";
export const LOCAL_TARGET_C = 40; // firmware2 config.h LOCAL_TARGET_C
// 2보드(firmware2) 판별: cloud-dashboard/link.js isTwoBoard와 같은 기준. firmware2엔 가짜값 모드가 없다.
export const isTwoBoard = (tele, status) => status?.boards === 2 || !!(tele && ("board_ok" in tele || (tele.board2 && "target_c" in tele.board2)));
export const b1SrcLabel = (two, fake) => (two || !fake ? "실측" : "시험값");
// 출처 배지: 값이 없으면("—") 주장하지 않음
export const srcBadge = (val, label) => (Number.isFinite(val) ? label : "");
// 카드에 표시하는 값(없으면 null)
export const co2CardValue = (b1) => (co2Valid(b1) ? b1.co2_ppm : null);
export const tempCardValue = (b1) => (Number.isFinite(b1?.temp1_c) ? b1.temp1_c : null);
export const faultWord = (b2) => FAULT_WORD[b2?.fault_text] ?? "";
// 기기 상태 문구: fault가 대체 제어보다 우선
export const deviceNote = (b2) => faultWord(b2) || (b2?.ctrl_src === "local" ? LOCAL_CTRL_TEXT : "");
// 지금 실제 제어 목표: 대체 제어 중엔 설정 목표 대신 히터면 40℃
export const ctrlTargetOf = (b2) => (b2?.ctrl_src === "local" ? LOCAL_TARGET_C : b2?.target_c);
const DB_EV_KINDS = ["latched", "unlatched", "fault", "b1_lost", "b1_back", "reboot"];
export function dbEventText(e) {
  const d = e?.detail || {};
  switch (e?.kind) {
    case "latched": return `안전 과열 차단 작동${d.fault_text ? ` — ${FAULT_WORD[d.fault_text] ?? d.fault_text}` : ""}`;
    case "unlatched": return "과열 차단이 풀렸어요";
    case "fault": return d.to && d.to !== "ok" ? `기기 상태: ${FAULT_WORD[d.to] ?? d.to}` : "기기 오류가 해제됐어요";
    case "b1_lost": return "돼지머리 센서 신호가 끊겼어요";
    case "b1_back": return "돼지머리 센서 신호가 다시 들어와요";
    case "reboot": return "Oink 본체가 다시 시작됐어요";
    default: return "";
  }
}
export function dbEvents(rows) {
  return (Array.isArray(rows) ? rows : []).filter((e) => DB_EV_KINDS.includes(e?.kind))
    .map((e) => ({ ts: Date.parse(e.ts), kind: `db_${e.kind}`, text: dbEventText(e), dbId: e.id }))
    .filter((e) => Number.isFinite(e.ts) && e.text);
}
// 로컬 알림 + DB 알림 시간순 병합(같은 dbId는 하나만), 최근 EVENT_MAX개
export function mergeEvents(local, db) {
  const seen = new Set();
  return [...(Array.isArray(local) ? local : []), ...(Array.isArray(db) ? db : [])]
    .filter((e) => { if (e.dbId == null) return true; if (seen.has(e.dbId)) return false; seen.add(e.dbId); return true; })
    .sort((a, b) => a.ts - b.ts).slice(-EVENT_MAX);
}
