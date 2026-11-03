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

// 캐릭터 상태: sleep | smelly | busy | calm
export function mood({ online, lastSeen, now, b1, slope }) {
  if (!online || !lastSeen || now - lastSeen > STALE_MS || !b1) return "sleep";
  if (typeof b1.odor_index === "number" && b1.odor_index >= 2) return "smelly";
  if (b1.co2_status === 1 && slope != null && slope > 0) return "busy";
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
export const HOT_RISE_C = 3, HOT_RISE_MS = 60000;      // temp1_c 또는 temp2_c가 60초 내 +3℃
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
// series: { t1: [{t, c}], t2: [{t, c}] }, co2s: [{t, ppm}] (co2_status==1인 점만)
export function hotFoodHit(series, co2s, now) {
  const cv = co2s.filter((p) => now - p.t <= HOT_CO2_MS).map((p) => p.ppm);
  if (cv.length < 2 || Math.max(...cv) - Math.min(...cv) < HOT_CO2_D) return null;
  for (const src of ["t1", "t2"]) {
    const pre = riseFrom(series[src], now);
    if (pre != null) return { src, preTemp: pre };
  }
  return null;
}
// st: { active, since, src, preTemp, lastHit }, cur: { t1, t2 } 현재 온도 → { st, action: "off" | "auto" | null }
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
  if (b1.co2_status !== 1) return "준비 중";
  return slope != null && slope > 0 ? "활발해요" : "잔잔해요";
}
export function odorWord(b1) {
  if (!b1) return "연결 안 됨";
  const v = b1.odor_index;
  if (typeof v !== "number") return "확인 중";
  return v < 1.3 ? "상쾌해요" : v < 2 ? "조금 나요" : "냄새 심해요";
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
export const CO2_ALERT = 1500;  // CO₂ ppm 이상이면 이상(co2_status==1일 때만)

// 반환: { state, reasons } — reasons: "hot" | "co2"
export function homeState({ online, lastSeen, now, b1 }) {
  if (!online || !lastSeen || now - lastSeen > STALE_MS || !b1) return { state: "sleep", reasons: [] };
  const reasons = [];
  if (Number.isFinite(b1.temp1_c) && b1.temp1_c >= TEMP_ALERT) reasons.push("hot");
  if (b1.co2_status === 1 && Number.isFinite(b1.co2_ppm) && b1.co2_ppm >= CO2_ALERT) reasons.push("co2");
  return { state: reasons.length ? "alert" : "calm", reasons };
}

export function homeText({ state, reasons }) {
  if (state === "sleep") return "쿨쿨 자는 중… 💤";
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
  if (prev.state === "alert" && cur.state === "calm") ev.push({ ts: now, kind: "alert_off", text: "다시 편안해졌어요" });
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
