// Oink 사용자용 웹앱: 브라우저가 wss로 브로커에 직접 접속(서버 없음). 판정 로직은 logic.mjs
import { co2Slope, decompProgress, decompStage, co2TrendText, addFeed, homeState, homeText, stateEvents, addEvents, recent } from "./logic.mjs";

const T = {
  status: "oink/gateway/status",
  tele: "oink/gateway/telemetry",
  feed: "oink/app/feed_log",
  cmd: "oink/gateway/cmd",
  ack: "oink/gateway/cmd/ack",
};
const ACK_TIMEOUT_MS = 5000;
const GRAPH_MS = 10 * 60 * 1000;
const $ = (id) => document.getElementById(id);
// "로그인 유지" 체크 시에만 비밀번호까지 기기에 저장한다(KEY_LOGIN). 해제면 주소·아이디만.
const KEY_LOGIN = "oink.app.login";
const KEY_EV = "oink.app.events";
const KEY_EV_SEEN = "oink.app.events.seen";
const BROKER = "wss://o9f10aca.ala.asia-southeast1.emqxsl.com:8084/mqtt"; // 주소 고정(로그인 화면에 칸 없음)
const store = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가여도 동작 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};

let client = null;
let gw = { online: false, tele: null, lastSeen: 0 };
let co2Hist = []; // shortcut: 이 화면을 연 동안만 쌓임, 앱을 닫으면 사라짐 — 장기 추세가 필요하면 서버 저장소 필요
let tempHist = [];
let feedLog = [];
let events = [];
try { const a = JSON.parse(store.get(KEY_EV) || "[]"); if (Array.isArray(a)) events = a; } catch { /* 무시 */ }
let evSeen = Number(store.get(KEY_EV_SEEN)) || 0;
let prevState = null;
let curTab = "home";
const pendingCmd = new Map();

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
  for (const b of document.querySelectorAll(".tabbar [role=tab]")) {
    const on = b.dataset.tab === name;
    b.setAttribute("aria-selected", String(on));
    $(`tab-${b.dataset.tab}`).hidden = !on;
  }
  if (name === "alert") { evSeen = events.length ? events[events.length - 1].ts : evSeen; store.set(KEY_EV_SEEN, String(evSeen)); }
  render();
  scrollTo(0, 0);
}
document.querySelector(".tabbar").addEventListener("click", (e) => {
  const b = e.target.closest("[role=tab]");
  if (b) showTab(b.dataset.tab);
});

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
  const hs = homeState({ online: gw.online, lastSeen: gw.lastSeen, now, b1 });
  const online = !!(client?.connected && gw.online && fresh);

  // 상태 전환 알림
  const cur = { ...hs, gwOnline: online };
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
  const p = decompProgress(last?.ts, now);
  const st = decompStage(last?.ts, now);
  $("progBar").style.width = p == null ? "0" : `${Math.round(p * 100)}%`;
  $("progText").textContent = p == null ? "음식물을 넣으면 보여요" : `약 ${Math.round(p * 100)}% · ${st.text}`;
  $("progTrend").textContent = p == null ? "" : co2TrendText(co2Slope(co2Hist, now));

  const hb = $("heatBadge");
  if (!b2) { hb.textContent = "연결 안 됨"; hb.className = "badge"; }
  else if (b2.reasons) { hb.textContent = "안전 OFF"; hb.className = "badge warn"; }
  else { hb.textContent = b2.heater_on ? "데우는 중" : "쉬는 중"; hb.className = `badge ${b2.heater_on ? "good" : ""}`; }

  // 알림 배지
  const unread = events.filter((e) => e.ts > evSeen).length;
  $("evBadge").hidden = !unread || curTab === "alert";
  $("evBadge").textContent = unread > 9 ? "9+" : String(unread);

  if (curTab === "log") {
    spark($("gCo2"), recent(co2Hist, now, GRAPH_MS), "ppm", "", "#e0782f", now);
    spark($("gTemp"), recent(tempHist, now, GRAPH_MS), "c", "℃", "#d9485f", now);
    $("feedList").replaceChildren(...feedLog.slice().reverse().slice(0, 8).map((f) => {
      const li = document.createElement("li");
      li.append(Object.assign(document.createElement("span"), { textContent: `${t2s(f.ts)} · ${f.size}` }),
        Object.assign(document.createElement("span"), { textContent: f.from || "" }));
      return li;
    }));
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
  for (const b of document.querySelectorAll("#feedBtns button, #offBtn, #autoToggle, #target")) b.disabled = dis;
}

$("clearEv").addEventListener("click", () => { events = []; store.set(KEY_EV, "[]"); render(); });

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
    if (b1?.co2_status === 1 && Number.isFinite(b1.co2_ppm)) co2Hist = keep([...co2Hist, { t: gw.lastSeen, ppm: b1.co2_ppm }]);
    if (Number.isFinite(b1?.temp1_c)) tempHist = keep([...tempHist, { t: gw.lastSeen, c: b1.temp1_c }]);
  } else if (topic === T.ack) {
    const p = pendingCmd.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer); pendingCmd.delete(msg.id);
    $("cmdMsg").textContent = msg.ok ? `✅ 기기가 적용함${msg.msg ? ` — ${msg.msg}` : ""}` : `⚠️ 기기가 거절함${msg.msg ? ` — ${msg.msg}` : ""}`;
  }
  render();
}

function sendCmd(cmd, extra = {}) {
  if (!client?.connected) return;
  const id = Math.random().toString(36).slice(2, 10);
  client.publish(T.cmd, JSON.stringify({ id, cmd, ...extra, from: devName(), ts: Date.now() }), { qos: 1 });
  $("cmdMsg").textContent = "📤 보내는 중…";
  const timer = setTimeout(() => {
    pendingCmd.delete(id);
    $("cmdMsg").textContent = "📤 전송됨 · 기기 응답 없음(게이트웨이 펌웨어 미지원일 수 있음)";
  }, ACK_TIMEOUT_MS);
  pendingCmd.set(id, { timer });
}

// shortcut: 두 기기가 거의 동시에 기록하면 늦게 도착한 쪽이 앞 기록을 덮을 수 있음 — 시연 규모에선 허용, 필요하면 서버 저장소로
$("feedBtns").addEventListener("click", (e) => {
  const size = e.target.closest("button")?.dataset.size;
  if (!size || !client?.connected) return;
  feedLog = addFeed(feedLog, { ts: Date.now(), size, from: devName() });
  client.publish(T.feed, JSON.stringify(feedLog), { qos: 1, retain: true });
  $("feedMsg").textContent = `기록했어요 (${size})`;
  render();
});

let armTimer = null;
$("offBtn").addEventListener("click", () => {
  const b = $("offBtn");
  if (!b.classList.contains("armed")) { // 두 번 눌러야 실행
    b.classList.add("armed"); b.textContent = "한 번 더 누르면 히터를 꺼요";
    armTimer = setTimeout(() => { b.classList.remove("armed"); b.textContent = "히터 강제로 끄기"; }, 3000);
    return;
  }
  clearTimeout(armTimer); b.classList.remove("armed"); b.textContent = "히터 강제로 끄기";
  setAuto(false);
  sendCmd("heater_off");
});
function setAuto(on) {
  const t = $("autoToggle");
  t.classList.toggle("on", on); t.setAttribute("aria-pressed", String(on));
}
$("autoToggle").addEventListener("click", () => {
  const on = !$("autoToggle").classList.contains("on");
  setAuto(on);
  sendCmd(on ? "heater_auto" : "heater_off");
});
$("target").addEventListener("input", () => { $("targetVal").textContent = `${$("target").value}℃`; });
$("target").addEventListener("change", () => sendCmd("set_target", { target_c: Number($("target").value) }));

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
    c.subscribe([T.status, T.tele, T.feed, T.ack], { qos: 1 });
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
