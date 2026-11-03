// 화면 판정 순수 로직 (브라우저·node 공용, DOM 없음). 셀프체크: node webapp/selfcheck.mjs
export const STALE_MS = 10000;
export const SLOPE_WINDOW_MS = 5 * 60 * 1000;
export const DECOMP_FULL_MS = 48 * 3600 * 1000; // 시간 기준 "다 됨" 가정값(미검증)

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

// 분해 진행 추정(0~1): max(경과시간/48h, (투입 후 CO₂ 피크−현재)/(피크−투입 전 기준)). 둘 다 없으면 null.
export function decompProgress(feedTs, now, hist) {
  if (!feedTs) return null;
  const timeP = Math.min(1, Math.max(0, (now - feedTs) / DECOMP_FULL_MS));
  const before = hist.filter((p) => p.t < feedTs && Number.isFinite(p.ppm));
  const after = hist.filter((p) => p.t >= feedTs && Number.isFinite(p.ppm));
  let co2P = 0;
  if (before.length && after.length) {
    const base = before[before.length - 1].ppm;
    const peak = Math.max(...after.map((p) => p.ppm));
    const cur = after[after.length - 1].ppm;
    if (peak - base > 20) co2P = Math.min(1, Math.max(0, (peak - cur) / (peak - base)));
  }
  return Math.max(timeP, co2P);
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
