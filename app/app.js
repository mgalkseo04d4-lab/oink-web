// Oink 사용자용 웹앱: 브라우저가 wss로 브로커에 직접 접속(서버 없음). 판정 로직은 logic.mjs
import { co2Slope, decompProgress, decompStage, co2TrendText, addFeed, homeState, homeText, stateEvents, addEvents, recent,
  DEMO_SPEED, DECOMP_END_H, PEAK_H, AMP_DEFAULT, curveH, predictPpm, activity, capPoints, hotFoodStep, HOT_MSG_OFF, HOT_MSG_AUTO, autoRange, CO2_MAX, HOLD_RESEND_MS } from "./logic.mjs";

const T = {
  status: "oink/gateway/status",
  tele: "oink/gateway/telemetry",
  feed: "oink/app/feed_log",
  cmd: "oink/gateway/cmd",
};
// 펌웨어 #1이 아직 가짜값(USE_FAKE_SENSORS) — 실측 전환 시 false로. CO₂·심부온도 배지가 "시험값"/"실측"으로 바뀐다.
const FAKE_B1 = true;
const B1_SRC = FAKE_B1 ? "시험값" : "실측";
const HEAT_TIMEOUT_MS = 10000; // 보낸 모드가 telemetry board2.mode에 반영될 때까지
const GRAPH_MS = 10 * 60 * 1000;
const $ = (id) => document.getElementById(id);
// "로그인 유지" 체크 시에만 비밀번호까지 기기에 저장한다(KEY_LOGIN). 해제면 주소·아이디만.
const KEY_LOGIN = "oink.app.login";
const KEY_EV = "oink.app.events";
const KEY_EV_SEEN = "oink.app.events.seen";
const KEY_CO2 = "oink.app.co2log";   // 실측 CO₂ 기록(재방문 시 유지, 최대 2000점)
const KEY_BASE = "oink.app.co2base"; // { feedTs, base } 투입 직후 첫 유효 CO₂
const KEY_AMP = "oink.app.amp";
const KEY_DEMO = "oink.app.demo";
const KEY_HOT = "oink.app.hot";      // 뜨거운 음식물 감지 상태(앱을 다시 열어도 복귀 판단 이어짐)
const BROKER = "wss://o9f10aca.ala.asia-southeast1.emqxsl.com:8084/mqtt"; // 주소 고정(로그인 화면에 칸 없음)
const store = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가여도 동작 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};

let client = null;
let gw = { online: false, tele: null, lastSeen: 0 };
// shortcut: 실측 CO₂는 이 기기 localStorage에만 쌓인다(앱이 열려 있던 동안만) — 기기 간 공유·빈틈 없는 기록은 서버 저장소 필요
const loadJson = (k, d) => { try { const v = JSON.parse(store.get(k) || "null"); return v ?? d; } catch { return d; } };
let co2Hist = loadJson(KEY_CO2, []).filter((p) => Number.isFinite(p?.t) && Number.isFinite(p?.ppm));
let tempHist = [];
let temp2Hist = [];
let liveMs = 120000; // 실시간 그래프 창: 2분(#1 5초 주기 → 점 24개), 60초 전환
let lastHoldSend = 0;
let co2Base = loadJson(KEY_BASE, null);
let amp = Number(store.get(KEY_AMP)) || AMP_DEFAULT;
let demo = store.get(KEY_DEMO) === "1";
let hotSt = loadJson(KEY_HOT, null);
let liveKey = "co2", liveBase = null;
let pendingHeat = null; // { want, sentAt, auto }
let toastTimer = null;
let lastCo2Save = 0;
let feedLog = [];
let events = [];
try { const a = JSON.parse(store.get(KEY_EV) || "[]"); if (Array.isArray(a)) events = a; } catch { /* 무시 */ }
let evSeen = Number(store.get(KEY_EV_SEEN)) || 0;
let prevState = null;
let curTab = "home";

for (const el of document.querySelectorAll(".b1src")) { el.textContent = B1_SRC; el.classList.toggle("real", !FAKE_B1); el.classList.toggle("test", FAKE_B1); }
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

$("devName").value = store.get("oink.dev") || (/Mobi|Android|iPhone/i.test(navigator.userAgent) ? "내 폰" : "내 PC");
$("devName").addEventListener("change", () => store.set("oink.dev", $("devName").value.trim()));
const devName = () => $("devName").value.trim() || "이름 없음";
const t2s = (ms) => new Date(ms).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

function netCheck() {
  const ok = navigator.onLine && typeof window.mqtt !== "undefined";
  $("netWarn").hidden = ok;
  $("loginBtn").disabled = !ok;
  return ok;
}
addEventListener("online", () => location.reload());
addEventListener("offline", netCheck);

// ---- 탭 ----
function showTab(name) {
  curTab = name;
  for (const p of document.querySelectorAll("#app > .tab")) p.hidden = p.id !== `tab-${name}`;
  for (const b of document.querySelectorAll(".tabbar [role=tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === (name === "live" ? "home" : name)));
  if (name === "alert") { evSeen = events.length ? events[events.length - 1].ts : evSeen; store.set(KEY_EV_SEEN, String(evSeen)); }
  render();
  scrollTo(0, 0);
}
document.querySelector(".tabbar").addEventListener("click", (e) => {
  const b = e.target.closest("[role=tab]");
  if (b) showTab(b.dataset.tab);
});

const speed = () => (demo ? DEMO_SPEED : 1);
const valid = (b1) => b1?.co2_status === 1 && Number.isFinite(b1.co2_ppm);

// ---- 예측(점선) vs 실측(실선) CO₂, x = 투입 후 곡선 시간 0~7일, y = ppm 한 축 ----
function predGraph(svg, feedTs, now) {
  const W = 320, H = 190, L = 42, R = 10, Tp = 14, B = 24;
  if (!feedTs) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="sp-empty">음식물을 넣으면 예측 곡선이 그려져요</text>`; return; }
  if (co2Base?.feedTs !== feedTs) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="sp-empty">투입 후 첫 CO₂ 값을 기다리는 중이에요</text>`; return; }
  const base = co2Base.base, sp = speed();
  const real = co2Hist.filter((p) => p.t >= feedTs).map((p) => ({ h: curveH(feedTs, p.t, sp), v: p.ppm })).filter((p) => p.h <= DECOMP_END_H);
  const r = autoRange([base, Math.min(CO2_MAX, base + amp), ...real.map((p) => p.v)], 40, CO2_MAX);
  const x = (h) => L + (h / DECOMP_END_H) * (W - L - R);
  const y = (v) => Tp + (1 - (v - r.min) / (r.max - r.min)) * (H - Tp - B);
  let g = "";
  for (const v of [r.min, (r.min + r.max) / 2, r.max]) {
    g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="sp-grid"/><text x="${L - 5}" y="${y(v) + 4}" text-anchor="end" class="sp-ax">${Math.round(v)}</text>`;
  }
  for (let d = 0; d <= 7; d++) g += `<text x="${x(d * 24)}" y="${H - 6}" text-anchor="middle" class="sp-ax">${d === 0 ? "투입" : `${d}일`}</text>`;
  const pts = [];
  for (let h = 0; h <= DECOMP_END_H; h += 2) pts.push(`${x(h).toFixed(1)},${y(predictPpm(base, amp, h)).toFixed(1)}`);
  g += `<polyline points="${pts.join(" ")}" class="sp-pred"/>`;
  g += `<text x="${x(PEAK_H)}" y="${y(predictPpm(base, amp, PEAK_H)) - 6}" text-anchor="middle" class="sp-lbl" fill="var(--text2)">예측(모델)</text>`;
  const hn = curveH(feedTs, now, sp);
  if (hn <= DECOMP_END_H) g += `<line x1="${x(hn)}" x2="${x(hn)}" y1="${Tp}" y2="${H - B}" class="sp-now"/>`;
  if (real.length) {
    g += `<polyline points="${real.map((p) => `${x(p.h).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}" class="sp-real"/>`;
    const l = real[real.length - 1];
    g += `<circle cx="${x(l.h)}" cy="${y(l.v)}" r="4" fill="var(--primary)"/>`;
    g += `<text x="${Math.min(x(l.h) + 6, W - R - 30)}" y="${y(l.v) + 16}" class="sp-lbl" fill="var(--primary)">${B1_SRC} ${Math.round(l.v)}</text>`;
  }
  svg.innerHTML = g;
}

// ---- 실시간 그래프(최근 60초, 원값 그대로) ----
function liveGraph(svg, pts, unit, minSpan, d, now) {
  const W = 320, H = 200, L = 44, R = 10, Tp = 12, B = 22, LIVE_MS = liveMs;
  const win = pts.filter((p) => now - p.t <= LIVE_MS);
  if (win.length < 1) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="sp-empty">값이 들어오는 중이에요</text>`; return; }
  const r = autoRange(win.map((p) => p.v), minSpan);
  const x = (t) => L + (1 - (now - t) / LIVE_MS) * (W - L - R);
  const y = (v) => Tp + (1 - (v - r.min) / (r.max - r.min)) * (H - Tp - B);
  let g = "";
  for (const v of [r.min, (r.min + r.max) / 2, r.max]) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="sp-grid"/><text x="${L - 5}" y="${y(v) + 4}" text-anchor="end" class="sp-ax">${v.toFixed(d)}</text>`;
  g += `<text x="${L}" y="${H - 5}" class="sp-ax">-${LIVE_MS / 1000}초</text><text x="${W - R}" y="${H - 5}" text-anchor="end" class="sp-ax">지금</text>`;
  if (liveBase != null && now - liveBase <= LIVE_MS) g += `<line x1="${x(liveBase)}" x2="${x(liveBase)}" y1="${Tp}" y2="${H - B}" class="sp-base"/><text x="${x(liveBase) + 4}" y="${Tp + 10}" class="sp-ax">기준점</text>`;
  g += `<polyline points="${win.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}" class="sp-real"/>`;
  for (const p of win) g += `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="2.5" fill="var(--primary)"/>`;
  const l = win[win.length - 1];
  g += `<circle cx="${x(l.t)}" cy="${y(l.v)}" r="6" fill="var(--primary)" stroke="#fff" stroke-width="2"/>`;
  svg.innerHTML = g;
}

// ---- 미니 그래프(SVG polyline) ----
function spark(svg, pts, key, unit, color, now) {
  pts = pts.slice().sort((a, b) => a.t - b.t);
  const W = 320, H = 110, L = 40, R = 8, Tp = 10, B = 22;
  if (pts.length < 2) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="sp-empty">데이터가 쌓이는 중이에요</text>`;
    return;
  }
  const vs = pts.map((p) => p[key]);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  const pad = Math.max((hi - lo) * 0.15, key === "ppm" ? 20 : 0.5);
  lo -= pad; hi += pad;
  const x = (t) => L + ((t - (now - GRAPH_MS)) / GRAPH_MS) * (W - L - R);
  const y = (v) => Tp + (1 - (v - lo) / (hi - lo)) * (H - Tp - B);
  const d = pts.map((p) => `${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const fmt = (v) => (key === "ppm" ? Math.round(v) : v.toFixed(1));
  svg.innerHTML =
    `<line x1="${L}" x2="${W - R}" y1="${Tp}" y2="${Tp}" class="sp-grid"/>` +
    `<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="sp-grid"/>` +
    `<text x="${L - 6}" y="${Tp + 4}" text-anchor="end" class="sp-ax">${fmt(hi)}</text>` +
    `<text x="${L - 6}" y="${H - B + 4}" text-anchor="end" class="sp-ax">${fmt(lo)}</text>` +
    `<text x="${L}" y="${H - 6}" class="sp-ax">10분 전</text>` +
    `<text x="${W - R}" y="${H - 6}" text-anchor="end" class="sp-ax">지금</text>` +
    `<polyline points="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${x(last.t)}" cy="${y(last[key])}" r="4" fill="${color}"/>` +
    `<text x="${Math.min(x(last.t), W - R - 4)}" y="${Math.max(y(last[key]) - 8, Tp + 10)}" text-anchor="end" class="sp-val">${fmt(last[key])}${unit}</text>`;
}

function render() {
  const now = Date.now();
  const fresh = gw.lastSeen && now - gw.lastSeen < 10000;
  const b1 = fresh ? gw.tele?.board1 : null;
  const b2 = fresh ? gw.tele?.board2 : null;
  const hs0 = homeState({ online: gw.online, lastSeen: gw.lastSeen, now, b1 });
  // 감지 후 OFF 유지 동안 빨강(알림은 hot_on으로 따로 남기므로 상태 전환 알림에는 넣지 않음)
  const hs = hotSt?.active && hs0.state !== "sleep" ? { state: "alert", reasons: ["hotfood", ...hs0.reasons] } : hs0;
  const online = !!(client?.connected && gw.online && fresh);

  // 상태 전환 알림
  const cur = { ...hs0, gwOnline: online };
  if (client?.connected) {
    const ev = stateEvents(prevState, cur, now);
    if (ev.length) { events = addEvents(events, ev); store.set(KEY_EV, JSON.stringify(events)); }
    prevState = cur;
  }

  $("hero").className = `hero ${hs.state}`;
  $("pig").setAttribute("class", `pig ${hs.state}`);
  const txt = homeText(hs);
  $("moodText").textContent = txt;
  $("pig").setAttribute("aria-label", `Oink: ${txt}`);

  $("conn").className = `pill ${online ? "on" : ""}`;
  $("connText").textContent = !client?.connected ? "재연결 중" : online ? "Oink 연결됨" : "Oink 꺼져 있음";

  const co2ok = b1?.co2_status === 1 && Number.isFinite(b1.co2_ppm);
  $("vCo2").textContent = co2ok ? Math.round(b1.co2_ppm) : "—";
  $("nCo2").textContent = !b1 ? "연결 안 됨" : !co2ok ? "센서 준비 중" : hs.reasons.includes("co2") ? "높아요!" : "좋아요";
  $("cCo2").classList.toggle("hot", hs.reasons.includes("co2"));
  const t = b1?.temp1_c;
  $("vTemp").textContent = Number.isFinite(t) ? t.toFixed(1) : "—";
  $("nTemp").textContent = !b1 ? "연결 안 됨" : hs.reasons.includes("hot") ? "너무 뜨거워요!" : Number.isFinite(b2?.temp2_c) ? `바닥 ${b2.temp2_c.toFixed(1)}℃` : "적당해요";
  $("cTemp").classList.toggle("hot", hs.reasons.includes("hot"));
  $("vOdor").textContent = Number.isFinite(b1?.odor_index) ? Math.round(b1.odor_index) : "—";

  const last = feedLog[feedLog.length - 1];
  const feedTs = last?.ts;
  const p = decompProgress(feedTs, now, speed());
  const st = decompStage(feedTs, now, speed());
  $("progBar").style.width = p == null ? "0" : `${Math.round(p * 100)}%`;
  $("progText").textContent = p == null ? "음식물을 넣으면 보여요" : `약 ${Math.round(p * 100)}% · ${st.text}`;
  $("progTrend").textContent = p == null ? "" : co2TrendText(co2Slope(co2Hist, now));
  const act = feedTs && co2Base?.feedTs === feedTs
    ? activity({ pts: co2Hist.map((q) => ({ t: q.t, v: q.ppm })), now, feedTs, base: co2Base.base, amp, speed: speed() }) : null;
  const actLine = !feedTs ? "" : !act ? "분해 활성도: 측정 대기" : act.pct == null ? `분해 활성도: ${act.text}` : `분해 활성도 ${act.pct}% · ${act.text}`;
  $("progAct").textContent = actLine;
  $("progAct").className = `num act ${act?.key || ""}`;
  for (const b of document.querySelectorAll(".badge.demo")) b.hidden = !demo;
  $("holdNote").hidden = !hotSt?.active;
  $("ampBadge").textContent = amp === AMP_DEFAULT ? "보정 전" : `보정 후 +${amp}ppm`;

  const hb = $("heatBadge");
  if (!b2) { hb.textContent = "연결 안 됨"; hb.className = "badge"; }
  else if (b2.reasons) { hb.textContent = "안전 OFF"; hb.className = "badge warn"; }
  else { hb.textContent = b2.heater_on ? "데우는 중" : "쉬는 중"; hb.className = `badge ${b2.heater_on ? "good" : ""}`; }
  const mode = b2?.mode;
  $("heatMode").textContent = !b2 ? "연결 안 됨" : mode === "auto" ? "자동" : mode === "off" ? "꺼짐(OFF)" : mode === "on" ? "켜짐(ON)" : "펌웨어 대기";
  if (pendingHeat) {
    const who = pendingHeat.auto ? "앱 자동 제어 · " : "";
    if (mode === pendingHeat.want) { $("cmdMsg").textContent = `✅ ${who}${pendingHeat.want === "off" ? "히터 끄기" : "자동 모드"} 적용됨`; pendingHeat = null; }
    else if (now - pendingHeat.sentAt > HEAT_TIMEOUT_MS) { $("cmdMsg").textContent = `⚠️ ${who}기기 응답 없음 — 명령이 반영되지 않았어요`; pendingHeat = null; }
    else $("cmdMsg").textContent = `📤 ${who}보내는 중…`;
  }

  // 알림 배지
  const unread = events.filter((e) => e.ts > evSeen).length;
  $("evBadge").hidden = !unread || curTab === "alert";
  $("evBadge").textContent = unread > 9 ? "9+" : String(unread);

  if (curTab === "log") {
    predGraph($("gPred"), feedTs, now);
    $("actText").textContent = !feedTs ? "음식물을 넣으면 예측 곡선이 그려져요" : actLine;
    $("actText").className = `act-line ${act?.key || ""}`;
    spark($("gCo2"), recent(co2Hist, now, GRAPH_MS), "ppm", "", "#E0557A", now);
    spark($("gTemp"), recent(tempHist, now, GRAPH_MS), "c", "℃", "#d9485f", now);
    $("feedList").replaceChildren(...feedLog.slice().reverse().slice(0, 8).map((f) => {
      const li = document.createElement("li");
      li.append(Object.assign(document.createElement("span"), { textContent: `${t2s(f.ts)} · ${f.size}` }),
        Object.assign(document.createElement("span"), { textContent: f.from || "" }));
      return li;
    }));
  }
  if (curTab === "live") {
    const isCo2 = liveKey === "co2";
    const pts = isCo2 ? co2Hist.map((q) => ({ t: q.t, v: q.ppm })) : tempHist.map((q) => ({ t: q.t, v: q.c }));
    const d = isCo2 ? 0 : 1, unit = isCo2 ? "ppm" : "℃";
    $("liveTitle").textContent = isCo2 ? "CO₂" : "심부 온도";
    $("liveUnit").textContent = unit;
    $("liveWin").textContent = liveMs === 60000 ? "2분" : "60초";
    $("liveSpan").textContent = `최근 ${liveMs === 60000 ? "60초" : "2분"} · ${B1_SRC}`;
    const lp = pts.filter((q) => now - q.t <= 12000).pop();
    $("liveVal").textContent = lp ? lp.v.toFixed(d) : "—";
    const ref = liveBase != null ? pts.find((q) => q.t >= liveBase) : null;
    const dv = ref && lp ? lp.v - ref.v : null;
    $("liveDelta").textContent = dv == null ? "기준점을 누르면 변화량이 보여요" : `기준점 대비 ${dv >= 0 ? "+" : ""}${dv.toFixed(d)} ${unit} ${dv > 0 ? "↑" : dv < 0 ? "↓" : ""}`;
    $("liveDelta").className = `delta ${dv > 0 ? "up" : dv < 0 ? "down" : ""}`;
    liveGraph($("gLive"), pts, unit, isCo2 ? 20 : 0.5, d, now);
  }
  if (curTab === "alert") {
    $("evEmpty").hidden = events.length > 0;
    $("evList").replaceChildren(...events.slice().reverse().map((e) => {
      const li = document.createElement("li");
      li.className = `ev ${e.kind}`;
      li.append(Object.assign(document.createElement("span"), { textContent: e.text }),
        Object.assign(document.createElement("span"), { textContent: t2s(e.ts), className: "t" }));
      return li;
    }));
  }
  const dis = !client?.connected;
  for (const b of document.querySelectorAll("#feedBtns button, #homeFeed button, #offBtn, #autoBtn")) b.disabled = dis;
}

$("clearEv").addEventListener("click", () => { events = []; store.set(KEY_EV, "[]"); render(); });
function tapCard(el, fn) {
  el.addEventListener("click", fn);
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } });
}
for (const id of ["cCo2", "cTemp"]) tapCard($(id), () => { liveKey = $(id).dataset.live; liveBase = null; showTab("live"); });
tapCard($("cProg"), () => showTab("log"));
$("liveBack").addEventListener("click", () => showTab("home"));
$("liveBase").addEventListener("click", () => { liveBase = Date.now(); render(); });
$("liveBaseClr").addEventListener("click", () => { liveBase = null; render(); });
$("liveWin").addEventListener("click", () => { liveMs = liveMs === 60000 ? 120000 : 60000; render(); });

// ---- 예측 설정 ----
$("amp").value = amp;
$("amp").addEventListener("change", () => {
  const v = Math.round(Number($("amp").value));
  amp = Number.isFinite(v) && v >= 50 && v <= 5000 ? v : AMP_DEFAULT;
  $("amp").value = amp; store.set(KEY_AMP, String(amp)); render();
});
function setDemo(on) {
  demo = on; store.set(KEY_DEMO, on ? "1" : "0");
  $("demoToggle").classList.toggle("on", on); $("demoToggle").setAttribute("aria-pressed", String(on));
}
setDemo(demo);
$("demoToggle").addEventListener("click", () => { setDemo(!demo); render(); });
// 시스템 알림은 권한이 이미 허용된 경우에만 덤으로(권한 요청 안 함). 핵심은 앱 안 토스트 + 알림 탭.
const canNotify = () => typeof Notification !== "undefined";

// ---- 알림: 목록 + 상단 토스트 + 시스템 알림 ----
function notify(kind, text) {
  events = addEvents(events, [{ ts: Date.now(), kind, text }]); store.set(KEY_EV, JSON.stringify(events));
  const t = $("toast");
  t.textContent = text; t.className = `toast ${kind === "hot_off" ? "ok" : ""}`; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 15000); // 무대에서 읽을 시간
  if (canNotify() && Notification.permission === "granted") {
    const opt = { body: text, icon: "icons/icon-192.png", tag: `oink-${kind}` };
    navigator.serviceWorker?.getRegistration().then((r) => (r ? r.showNotification("Oink", opt) : new Notification("Oink", opt))).catch(() => {});
  }
}

function onMessage(topic, buf) {
  const raw = buf.toString();
  if (topic === T.feed) { // 빈 retained = 기록 없음
    try { const a = raw ? JSON.parse(raw) : []; if (Array.isArray(a)) feedLog = a; } catch { /* 무시 */ }
    render(); return;
  }
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== "object") return;
  if (topic === T.status) gw.online = !!msg.online;
  else if (topic === T.tele) {
    gw.tele = msg; gw.online = true; gw.lastSeen = Date.now();
    const b1 = msg.board1;
    const keep = (h) => h.filter((p) => gw.lastSeen - p.t < 72 * 3600 * 1000);
    const now = gw.lastSeen;
    if (valid(b1)) co2Hist = capPoints(keep([...co2Hist, { t: now, ppm: b1.co2_ppm }]));
    if (Number.isFinite(b1?.temp1_c)) tempHist = keep([...tempHist, { t: now, c: b1.temp1_c }]).filter((p) => now - p.t <= 10 * 60000);
    const b2 = msg.board2;
    if (Number.isFinite(b2?.temp2_c)) temp2Hist = [...temp2Hist, { t: now, c: b2.temp2_c }].filter((p) => now - p.t <= 5 * 60000);
    const feedTs = feedLog[feedLog.length - 1]?.ts;
    if (feedTs && co2Base?.feedTs !== feedTs) { // 투입 직후 첫 유효값을 기준으로
      const first = co2Hist.find((p) => p.t >= feedTs);
      if (first) { co2Base = { feedTs, base: first.ppm }; store.set(KEY_BASE, JSON.stringify(co2Base)); }
    }
    if (now - lastCo2Save > 30000) { lastCo2Save = now; store.set(KEY_CO2, JSON.stringify(co2Hist)); }
    if (client?.connected) {
      const r = hotFoodStep(hotSt, { series: { t1: tempHist, t2: temp2Hist }, co2s: co2Hist, now, cur: { t1: b1?.temp1_c, t2: b2?.temp2_c } });
      if (r.st !== hotSt) { hotSt = r.st; store.set(KEY_HOT, JSON.stringify(hotSt)); }
      if (r.action === "off") { notify("hot_on", HOT_MSG_OFF); sendHeater("off", true); lastHoldSend = now; }
      else if (r.action === "auto") { notify("hot_off", HOT_MSG_AUTO); sendHeater("auto", true); }
      else if (hotSt?.active && now - lastHoldSend >= HOLD_RESEND_MS) { // #2는 30초 무수신이면 auto 복귀 → OFF 재발행
        lastHoldSend = now;
        client.publish(T.cmd, JSON.stringify({ target: "b2", heater: "off" }), { qos: 1 });
      }
    }
  }
  render();
}

// 게이트웨이 형식 그대로(문자열 검색 파서라 다른 필드를 섞지 않는다): {"target":"b2","heater":"off|auto"}. 강제 ON은 보내지 않음.
function sendHeater(want, auto = false) {
  if (!client?.connected || (want !== "off" && want !== "auto")) return;
  client.publish(T.cmd, JSON.stringify({ target: "b2", heater: want }), { qos: 1 });
  pendingHeat = { want, sentAt: Date.now(), auto };
  render();
}

// shortcut: 두 기기가 거의 동시에 기록하면 늦게 도착한 쪽이 앞 기록을 덮을 수 있음 — 시연 규모에선 허용, 필요하면 서버 저장소로
$("toast").addEventListener("click", () => { $("toast").hidden = true; });
const onFeed = (e) => {
  const size = e.target.closest("button")?.dataset.size;
  if (!size || !client?.connected) return;
  feedLog = addFeed(feedLog, { ts: Date.now(), size, from: devName() });
  client.publish(T.feed, JSON.stringify(feedLog), { qos: 1, retain: true });
  $("feedMsg").textContent = $("homeFeedMsg").textContent = `기록했어요 (${size}) — 지금부터 예측 곡선 시작`;
  render();
};
// 투입 버튼 하트 콘페티(시각 효과만, 기록 로직과 무관). 움직임 줄이기 설정이면 CSS가 숨김
function hearts(e) {
  const b = e.target.closest("button[data-size]");
  if (!b || b.disabled) return;
  const r = b.getBoundingClientRect();
  for (let i = 0; i < 6; i++) {
    const s = Object.assign(document.createElement("span"), { className: "heart", textContent: i % 2 ? "💗" : "✨" });
    s.setAttribute("aria-hidden", "true");
    s.style.left = `${r.left + r.width / 2 - 9 + (i - 2.5) * 14}px`; s.style.top = `${r.top}px`;
    s.style.setProperty("--dx", `${(i - 2.5) * 10}px`); s.style.animationDelay = `${i * 40}ms`;
    document.body.append(s); setTimeout(() => s.remove(), 1300);
  }
}
$("feedBtns").addEventListener("click", hearts);
$("homeFeed").addEventListener("click", hearts);
$("feedBtns").addEventListener("click", onFeed);
$("homeFeed").addEventListener("click", onFeed);

$("offBtn").addEventListener("click", () => sendHeater("off"));
$("autoBtn").addEventListener("click", () => sendHeater("auto"));

function showLogin(err) {
  $("app").hidden = true; $("login").hidden = false;
  $("loginErr").hidden = !err; $("loginErr").textContent = err || "";
  netCheck();
}

// 테스트에서도 쓰도록 노출: oinkConnect(주소, 아이디, 비밀번호)
function oinkConnect(url, username, password, auto = false) {
  if (!netCheck()) return;
  if (client) client.end(true);
  gw = { online: false, tele: null, lastSeen: 0 };
  prevState = null;
  $("loginBtn").disabled = true; $("loginErr").hidden = true;
  let entered = false;
  const c = window.mqtt.connect(url, {
    username: username || undefined, password: password || undefined,
    clientId: `oink-app-${Math.random().toString(16).slice(2, 10)}`,
    connectTimeout: 8000, reconnectPeriod: 0, // 첫 접속 실패는 바로 알림
  });
  client = c;
  c.on("connect", () => {
    if (!entered) {
      entered = true;
      c.options.reconnectPeriod = 3000;
      store.set("oink.broker", url); store.set("oink.user", username || "");
      if (auto || $("remember").checked) store.set(KEY_LOGIN, JSON.stringify({ url, username, password }));
      else store.del(KEY_LOGIN);
      $("login").hidden = true; $("app").hidden = false; $("pass").value = DEFAULT_PASS;
    }
    c.subscribe([T.status, T.tele, T.feed], { qos: 1 });
    render();
  });
  c.on("message", onMessage);
  c.on("close", () => {
    if (!entered) { c.end(true); if (auto) store.del(KEY_LOGIN); if (client === c) showLogin(auto ? "저장된 로그인이 만료됐어요 — 다시 로그인해 주세요" : "연결 실패 — 아이디·비밀번호를 확인해 주세요"); $("loginBtn").disabled = false; }
    else render();
  });
  c.on("error", () => { if (!entered) c.end(true); });
}
window.oinkConnect = oinkConnect;
// 화면 확인용: 가짜 텔레메트리 주입(브로커 발행 없음, 이 화면에만 반영)
window.oinkInject = (msg, topic = T.tele) => onMessage(topic, JSON.stringify(msg));
window.oinkTab = showTab;

$("login").addEventListener("submit", (e) => {
  e.preventDefault();
  oinkConnect(BROKER, $("user").value.trim(), $("pass").value);
});
$("logout").addEventListener("click", () => { if (client) client.end(true); client = null; store.del(KEY_LOGIN); showLogin(); });
const DEFAULT_PASS = "oink-web"; // 공개 기본 계정(사용자 결정) — 비공개가 필요하면 EMQX 비번 변경 후 이 기본값 제거
$("user").value = store.get("oink.user") || "oink-web";
$("pass").value = DEFAULT_PASS;
netCheck();
try {
  const saved = JSON.parse(store.get(KEY_LOGIN) || "null");
  if (saved?.username) oinkConnect(BROKER, saved.username, saved.password, true);
} catch { store.del(KEY_LOGIN); }
setInterval(() => { if (!$("app").hidden) render(); }, 2000);
