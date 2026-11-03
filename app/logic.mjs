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

// 분해 진행(가상 시나리오 기반 추정, 실측 아님 — CLAUDE.md "CO₂ 해석 기준", 근거자료/CO2_가상시나리오_일주일.png)
// CO₂ 발생속도 곡선 r(t) ∝ t²·e^(−t/θ), θ=24h → 정점 2θ=48h, 7일(168h)에 정점의 약 8%.
// 진행도 = 0~t 누적 면적 / 0~7일 누적 면적 (0~1). 감마(형상3) 누적: F(x)=1−e^(−x)(1+x+x²/2), x=t/θ
export const DECOMP_THETA_H = 24;
export const DECOMP_END_H = 168;
const gammaCdf3 = (x) => 1 - Math.exp(-x) * (1 + x + (x * x) / 2);
export function decompProgress(feedTs, now) {
  if (!feedTs) return null;
  const h = Math.max(0, (now - feedTs) / 3600000);
  if (h >= DECOMP_END_H) return 1;
  return gammaCdf3(h / DECOMP_THETA_H) / gammaCdf3(DECOMP_END_H / DECOMP_THETA_H);
}
// 경과 시간 기준 단계: 0~36h 시작, 36~60h(48h±12h) 정점, 60h~7일 마무리, 7일~ 끝
export function decompStage(feedTs, now) {
  if (!feedTs) return null;
  const h = (now - feedTs) / 3600000;
  if (h < 36) return { key: "start", text: "분해 시작 — 활동이 늘고 있어요" };
  if (h < 60) return { key: "peak", text: "가장 활발해요" };
  if (h < DECOMP_END_H) return { key: "finish", text: "마무리 중" };
  return { key: "done", text: "거의 끝났어요" };
}
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
