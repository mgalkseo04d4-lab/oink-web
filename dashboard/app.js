// Oink 대시보드: 브라우저가 MQTT over WebSocket으로 브로커에 직접 접속 (서버 없음)
// 구독: oink/gateway/status (retained, LWT), oink/gateway/telemetry (2초마다)
const TOPIC_STATUS = "oink/gateway/status";
const TOPIC_TELE = "oink/gateway/telemetry";
const STALE_MS = 10000;
// 시험값 배지: 펌웨어가 가짜·시험 값을 보내는 동안 true. 실측으로 바꾸면 false로.
const FAKE_B1 = true;   // #1 oink_node1_pig USE_FAKE_SENSORS 1 → CO₂·심부온도 가짜값
const FAKE_ODOR = true; // 냄새 지수 = 게이트웨이 가변저항(pot_v 0~3.3V → 0~100) 시험값
const $ = (id) => document.getElementById(id);

let client = null;
let gw = { online: false, ip: null, tele: null, lastSeen: 0, diag: null };
let linkSt = OinkLink.makeLink();
let gwSt = OinkLink.makeGw();
let chartSt = OinkChart.makeChart();
let demoSt = OinkDemo.makeDemo();

// "로그인 유지" 체크 시에만 비밀번호까지 기기에 저장한다(KEY_LOGIN). 해제면 주소·아이디만.
const KEY_LOGIN = "oink.dash.login";
const BROKER = "wss://o9f10aca.ala.asia-southeast1.emqxsl.com:8084/mqtt"; // 주소 고정(로그인 화면에 칸 없음)
const store = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가여도 동작 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};

function fmt(v, d = 1) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : null;
}

function setCard(id, value, tone = "", sub) {
  const el = $(id);
  el.className = `card stat ${tone}`;
  el.title = value === "수신 끊김" ? `보드 값이 ${OinkLink.BOARD_STALE_MS / 1000}초 넘게 안 옴` : "";
  el.querySelector(".value").textContent = value;
  if (sub !== undefined) el.querySelector(".sub").textContent = sub || "";
}

function render() {
  const fresh = gw.lastSeen && Date.now() - gw.lastSeen < STALE_MS;
  const now = Date.now();
  // 게이트웨이 자체가 끊기면 "끊김"(빨강), 게이트웨이는 살아 있는데 보드만 15초 넘게 안 오면 "수신 끊김"(회색)
  const two = OinkLink.isTwoBoard(gw.tele, gw.diag); // firmware2: 본체(#2)가 게이트웨이 겸함, #3 없음
  const s1 = fresh && OinkLink.boardStale(gw.tele?.board1, linkSt.lastRxAt[0], now);
  // 2보드: board2 = 게이트웨이 자신이라 seq가 없음 → telemetry가 오면 살아 있음
  const s2 = fresh && !two && OinkLink.boardStale(gw.tele?.board2, linkSt.lastRxAt[1], now);
  const b1 = fresh && !s1 ? gw.tele.board1 : null;
  const b2 = fresh && !s2 ? gw.tele.board2 : null;
  const off1 = s1 ? "수신 끊김" : "끊김", off2 = s2 ? "수신 끊김" : "끊김";
  const t1 = s1 ? "stale" : "bad", t2 = s2 ? "stale" : "bad";

  setCard("c-co2", !b1 ? off1 : b1.co2_status !== 1 ? "예열 중" : `${fmt(b1.co2_ppm, 0) ?? "—"} ppm`, b1 ? "" : t1,
    b1 ? `co2_status ${b1.co2_status ?? "—"}${b1.err ? ` · ${OinkLink.errText(b1.err)}` : ""}` : "");
  // 시험 중 odor_index 0~100이라 냄새 경고는 띄우지 않음
  setCard("c-odor", !b1 ? off1 : b1.odor_index == null ? "센서 안정화 중" : `${fmt(b1.odor_index, 1)}`, !b1 ? t1 : "",
    typeof gw.tele?.pot_v === "number" ? `pot_v ${gw.tele.pot_v.toFixed(2)} V · 시험 범위 0~100` : "시험 범위 0~100");
  setCard("c-t1", !b1 ? off1 : fmt(b1.temp1_c) != null ? `${fmt(b1.temp1_c)} ℃` : "센서 오류", b1 ? "" : t1);
  const ctrlT = two && b2 && b2.temp2_c == null && "ctrl_temp_c" in b2; // 패드 센서 없음 → 제어 온도(#1 심부)
  $("t2-label").textContent = ctrlT ? "제어 온도 (#1 심부, 무선)" : "패드 온도";
  $("t2-label").title = ctrlT ? "board2.ctrl_temp_c · target_c" : "board2.temp2_c";
  const tgt = fmt(b2?.target_c);
  if (ctrlT) setCard("c-t2", fmt(b2.ctrl_temp_c) != null ? `${fmt(b2.ctrl_temp_c)} ℃` : "#1 데이터 없음", fmt(b2.ctrl_temp_c) != null ? "" : "bad",
    tgt != null ? `목표 ${tgt}℃` : "");
  else setCard("c-t2", !b2 ? off2 : fmt(b2.temp2_c) != null ? `${fmt(b2.temp2_c)} ℃` : "센서 오류", b2 ? "" : t2, "");
  const ft = OinkLink.faultText(b2);
  setCard("c-heat", !b2 ? off2 : b2.heater_on ? "ON" : ft ? "안전 OFF" : "OFF",
    !b2 ? t2 : b2.heater_on ? "warn" : ft ? "bad" : "",
    b2 ? `${ft || "정상"} · mode ${b2.mode ?? "—"}${tgt != null ? ` · 목표 ${tgt}℃` : ""}${b2.fault != null ? ` · fault ${b2.fault}` : ""} · err ${b2.err ?? b2.reasons ?? "—"}` : "");
  $("bd-eco").hidden = !OinkCtrl.isEco(b2);
  $("bd-latch").hidden = $("heat-latch").hidden = !(b2 && b2.latched === true);
  // firmware2에는 가짜값 모드가 없음(README) → 2보드면 시험값 배지 해제
  for (const [id, on] of [["bd-co2", FAKE_B1], ["bd-t1", FAKE_B1], ["bd-odor", FAKE_ODOR], ["bd-dco2", FAKE_B1], ["bd-dt1", FAKE_B1]]) $(id).hidden = two || !on;
  if (two && !potFolded && typeof gw.tele?.pot_v !== "number") { potFolded = true; $("potSec").open = false; $("potNote").textContent = "· 펌웨어2: 시험 모드 없음"; }

  const online = gw.online && fresh;
  let s = `게이트웨이 ${online ? "온라인" : "오프라인"}`;
  if (gw.lastSeen) s += ` · 마지막 수신 ${new Date(gw.lastSeen).toLocaleTimeString("ko-KR")}`;
  if (online && gw.tele?.rssi != null) s += ` · Wi-Fi ${gw.tele.rssi} dBm`;
  if (client && !client.connected) s += " · 브로커 재연결 중";
  $("gwStatus").textContent = s;
  $("gwStatus").className = `status ${online ? "on" : "off"}`;
  renderDemo();
  renderEsp();
  renderCtrl();
  renderCharts();
}

// ---- 보드 제어: oink/gateway/cmd 발행, telemetry로 적용 여부 판정 ----
const TOPIC_CMD = "oink/gateway/cmd";
const ctrlPending = {}; // target -> { want, sentAt }

function renderCtrl() {
  const fresh = !!(gw.lastSeen && Date.now() - gw.lastSeen < STALE_MS);
  const connected = !!(client && client.connected);
  for (const card of document.querySelectorAll(".ctrl")) {
    const target = card.dataset.target;
    const two = OinkLink.isTwoBoard(gw.tele, gw.diag);
    const v = OinkCtrl.view(target, gw.tele, fresh, ctrlPending[target], Date.now(), two);
    card.classList.toggle("na", !!v.na);
    for (const b of card.querySelectorAll("button[data-val]")) {
      const noOn = two && target === "b2" && b.dataset.val === "on"; // firmware2: 강제 ON 명령 없음(무시됨)
      b.disabled = !(v.enabled && connected) || noOn;
      b.title = noOn ? "펌웨어에 강제 ON 없음" : "";
      b.classList.toggle("sel", v.current === b.dataset.val);
    }
    if (target === "b2") {
      $("tgtRow").hidden = !two;
      $("tgtApply").disabled = $("tgtEco").disabled = !(v.enabled && connected);
      $("b2note").textContent = two
        ? "보드 안전 규칙이 우선합니다. #1 데이터가 없거나 심부 45℃ 이상이면 꺼지고, 50℃면 래치됩니다. 목표 30~40℃(절전 = 30℃)."
        : "보드 안전 규칙이 우선합니다. 온도를 읽지 못하거나 50℃를 넘으면 ON을 눌러도 꺼집니다.";
    }
    setText(card.querySelector(".state"), v.label, `state ${v.tone}`);
    setText(card.querySelector(".actual"), v.actual?.text || "", `actual ${v.actual?.tone || ""}`);
    setText(card.querySelector(".result"), v.result?.text || "", `result ${v.result?.tone || ""}`);
  }
}

for (const card of document.querySelectorAll(".ctrl")) {
  card.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-val]");
    if (!b || !client || !client.connected) return;
    const target = card.dataset.target;
    const id = target === "b2" ? ackWait(`히터 ${b.dataset.val.toUpperCase()}`) : undefined;
    client.publish(TOPIC_CMD, JSON.stringify(OinkCtrl.payload(target, b.dataset.val, id)), { qos: 1, retain: false });
    ctrlPending[target] = { want: b.dataset.val, sentAt: Date.now() };
    renderCtrl();
    setTimeout(renderCtrl, OinkCtrl.C.TIMEOUT_MS[target] + 100); // telemetry가 안 와도 '응답 없음'으로 바뀌게
  });
}

// ---- firmware2 명령 응답(ack): {"id","ok","msg"} on oink/gateway/cmd/ack ----
const TOPIC_CMD_ACK = "oink/gateway/cmd/ack";
const ACK_TIMEOUT_MS = 10000;
const ackPending = new Map(); // id -> { what, timer }
let potFolded = false;
function ackWait(what) {
  const id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const timer = setTimeout(() => {
    if (ackPending.delete(id)) setText($("tgtRes"), `⚠ ${what}: 기기 응답(ack) 없음 10초`, "result bad");
  }, ACK_TIMEOUT_MS);
  ackPending.set(id, { what, timer });
  setText($("tgtRes"), `${what} 전송 중…`, "result");
  return id;
}
function onCmdAck(msg) {
  const p = ackPending.get(String(msg.id ?? ""));
  if (!p) return; // 다른 기기(웹앱 등)가 보낸 명령의 ack
  clearTimeout(p.timer);
  ackPending.delete(String(msg.id));
  setText($("tgtRes"), `${msg.ok ? "✅" : "❌"} ${p.what}: ${String(msg.msg ?? (msg.ok ? "ok" : "거부"))}`, `result ${msg.ok ? "ok" : "bad"}`);
  if (!msg.ok) { delete ctrlPending.b2; renderCtrl(); } // 거부된 명령은 '전송 중'으로 남기지 않음
}
function sendTarget(c) {
  if (!client || !client.connected) return;
  if (!OinkCtrl.validTarget(c)) { setText($("tgtRes"), `목표는 ${OinkCtrl.T_MIN}~${OinkCtrl.T_MAX}℃`, "result bad"); return; }
  const id = ackWait(`목표 ${c}℃`);
  client.publish(TOPIC_CMD, JSON.stringify(OinkCtrl.targetPayload(c, id)), { qos: 1, retain: false });
}
$("tgtApply").addEventListener("click", () => sendTarget(Number($("tgt").value)));
$("tgtEco").addEventListener("click", () => { $("tgt").value = OinkCtrl.ECO_C; sendTarget(OinkCtrl.ECO_C); });

// ---- 가변저항 시험 그래프 ----
const lastV = (pts) => (pts.length ? pts[pts.length - 1].v : null);
const CHARTS = {
  "s-gas": { key: "gas", min: 0, max: 3.3, color: "#3987e5", unit: "V", d: 2, stale: "b1" },
  "s-odor": { key: "odor", min: 0, max: 100, color: "#d95926", unit: "", d: 1, stale: "b1", h: 70 },
  "s-temp": { key: "temp", min: 20, max: 80, color: "#3987e5", unit: "℃", d: 1, stale: "b2", band: "heat" },
  "s-pot": { key: "pot", min: 0, max: 3.3, color: "#3987e5", unit: "V", d: 2, stale: "pot" },
};

function renderCharts() {
  const C = OinkChart, st = chartSt, now = Date.now();
  const stale = {
    b1: C.isStale(st.last.b1, now) || !gw.tele?.board1,
    b2: C.isStale(st.last.b2, now) || !gw.tele?.board2,
    pot: C.isStale(st.last.pot, now),
  };
  for (const [id, c] of Object.entries(CHARTS)) {
    C.trim(st[c.key], now);
    C.svg($(id), { pts: st[c.key], min: c.min, max: c.max, color: c.color, now, stale: stale[c.stale],
      h: c.h || 120, band: c.band ? C.trim(st[c.band], now) : null });
  }
  const val = (pts, d, unit) => { const v = lastV(pts); return v == null ? "—" : `${v.toFixed(d)} ${unit}`; };
  $("v-gas").textContent = stale.b1 ? "끊김" : val(st.gas, 2, "V");
  $("v-odor").textContent = stale.b1 ? "—" : val(st.odor, 1, "");
  $("v-temp").textContent = stale.b2 ? "끊김" : val(st.temp, 1, "℃");
  const h = lastV(st.heat);
  $("v-heat").textContent = stale.b2 || h == null ? "—" : h ? "ON" : "OFF";
  const potWait = !st.potSeen;
  $("v-pot").textContent = potWait ? "대기" : stale.pot ? "끊김" : val(st.pot, 2, "V");
  [["ch-1", "f-1", stale.b1], ["ch-2", "f-2", stale.b2], ["ch-3", "f-3", potWait || stale.pot]].forEach(([card, flag, s]) => {
    $(card).classList.toggle("stale", s);
    $(flag).hidden = !s;
  });
  $("f-3").textContent = potWait ? "대기(펌웨어 업로드 전)" : "끊김";
}

// 마우스·터치를 올리면 가장 가까운 점의 시각·값을 보여 준다
for (const [id, c] of Object.entries(CHARTS)) {
  const svgEl = $(id), tip = svgEl.parentElement.querySelector(".tip");
  const show = (clientX) => {
    const r = svgEl.getBoundingClientRect(), pts = chartSt[c.key];
    if (!pts.length || !r.width) { tip.hidden = true; return; }
    const t = Date.now() - (1 - (clientX - r.left) / r.width) * OinkChart.C.WINDOW_MS;
    const p = pts.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    tip.textContent = `${new Date(p.t).toLocaleTimeString("ko-KR")} · ${p.v.toFixed(c.d)} ${c.unit}`;
    tip.style.left = `${Math.min(Math.max(0, clientX - r.left - 60), r.width - 130)}px`;
    tip.hidden = false;
  };
  svgEl.addEventListener("pointermove", (e) => show(e.clientX));
  svgEl.addEventListener("pointerleave", () => { tip.hidden = true; });
}

// ---- 시연: 값(큰 숫자) → 숫자를 누르면 실시간 그래프(최근 60초, 기준점 대비 변화) ----
const DEMO = {
  co2: { unit: "ppm", d: 0, minSpan: 20, color: "#3987e5", label: "CO₂" },
  t1: { unit: "℃", d: 1, minSpan: 0.5, color: "#d95926", label: "심부 온도" },
};
let demoView = store.get("oink.dash.demoView") === "graph" ? "graph" : "val";
let demoWide = store.get("oink.dash.demoWide") === "1";
const demoLast = { co2: null, t1: null };
const demoMs = () => (demoWide ? OinkDemo.C.WIDE_MS : OinkDemo.C.WINDOW_MS);

function demoValue(key) {
  const now = Date.now(), b1 = gw.tele?.board1;
  if (OinkDemo.isStale(demoSt, gw.tele, now)) return { text: gw.lastSeen && now - gw.lastSeen < STALE_MS ? "수신 끊김" : "끊김", off: true };
  if (key === "co2" && b1.co2_status !== 1) return { text: "예열 중", off: true };
  const v = key === "co2" ? b1.co2_ppm : b1.temp1_c;
  return typeof v === "number" && Number.isFinite(v) ? { text: v.toFixed(DEMO[key].d), v } : { text: "센서 오류", off: true };
}

function renderDemo() {
  $("pane-val").hidden = demoView !== "val";
  $("pane-graph").hidden = demoView !== "graph";
  $("winWide").textContent = demoWide ? "60초 보기" : "2분 보기";
  const now = Date.now(), stale = OinkDemo.isStale(demoSt, gw.tele, now), ms = demoMs();
  for (const key of ["co2", "t1"]) {
    const c = DEMO[key], v = demoValue(key);
    const box = $(`dv-${key}`);
    box.querySelector(".dn").textContent = v.text;
    box.classList.toggle("off", !!v.off);
    if (v.v != null && demoLast[key] != null && v.v !== demoLast[key]) { // 값이 바뀌면 짧게 하이라이트
      box.classList.add("pulse");
      setTimeout(() => box.classList.remove("pulse"), 700);
    }
    demoLast[key] = v.v ?? demoLast[key];
    if (demoView !== "graph") continue;
    OinkDemo.svg($(`dsv-${key}`), { pts: demoSt[key], now, ms, minSpan: c.minSpan, color: c.color, unit: c.unit, d: c.d, base: demoSt.base, stale });
    const g = $(`dg-${key}`);
    g.classList.toggle("off", !!v.off);
    g.querySelector(".dnow").textContent = v.off ? v.text : `${v.text} ${c.unit}`;
    const dl = OinkDemo.delta(demoSt[key], now, ms, demoSt.base);
    const step = Math.pow(10, -c.d);
    g.querySelector(".ddelta").textContent = !dl ? "—"
      : `${dl.d >= 0 ? "+" : "−"}${Math.abs(dl.d).toFixed(c.d)} ${c.unit} ${Math.abs(dl.d) < step / 2 ? "→" : dl.d > 0 ? "↑" : "↓"}`;
    g.querySelector(".dref").textContent = demoSt.base != null
      ? `기준점(${new Date(demoSt.base).toLocaleTimeString("ko-KR")}) 대비` : `보이는 구간 처음 대비`;
  }
}

function setDemoView(v) {
  demoView = v;
  store.set("oink.dash.demoView", v);
  renderDemo();
}
for (const key of ["co2", "t1"]) $(`dv-${key}`).addEventListener("click", () => setDemoView("graph"));
$("backVal").addEventListener("click", () => setDemoView("val"));
$("winWide").addEventListener("click", () => { demoWide = !demoWide; store.set("oink.dash.demoWide", demoWide ? "1" : "0"); renderDemo(); });
$("baseSet").addEventListener("click", () => { demoSt.base = Date.now(); renderDemo(); });
$("baseClr").addEventListener("click", () => { demoSt.base = null; renderDemo(); });
window.addEventListener("resize", () => { if (demoView === "graph") renderDemo(); });

// 그래프 위에 커서·손가락을 올리면 가장 가까운 점의 시각·값
for (const key of ["co2", "t1"]) {
  const el = $(`dsv-${key}`), tip = el.parentElement.querySelector(".tip"), c = DEMO[key];
  const show = (clientX) => {
    const r = el.getBoundingClientRect(), ms = demoMs(), now = Date.now();
    const pts = OinkDemo.inWindow(demoSt[key], now, ms);
    const vb = el.viewBox.baseVal;
    if (!pts.length || !r.width || !vb) { tip.hidden = true; return; }
    const px = (clientX - r.left) * (vb.width / r.width);
    const t = now - (1 - (px - 52) / (vb.width - 64)) * ms;
    const p = pts.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    tip.textContent = `${new Date(p.t).toLocaleTimeString("ko-KR")} · ${p.v.toFixed(c.d)} ${c.unit}`;
    tip.style.left = `${Math.min(Math.max(0, clientX - r.left - 60), r.width - 140)}px`;
    tip.hidden = false;
    const cross = el.querySelector(".cross");
    if (cross) { const cx = 52 + (1 - (now - p.t) / ms) * (vb.width - 64); cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible"); }
  };
  el.addEventListener("pointermove", (e) => show(e.clientX));
  el.addEventListener("pointerleave", () => { tip.hidden = true; });
}

// ---- ESP32 상태: 게이트웨이(#3) STA·MQTT 카드 + ESP-NOW 링크 카드 ----
function setText(el, text, tone = "") { el.textContent = text; el.className = tone; }

function renderEsp() {
  const L = OinkLink, now = Date.now(), t = gw.tele, two = L.isTwoBoard(t, gw.diag);
  $("g-label").textContent = two ? "게이트웨이(#2 본체) STA·MQTT" : "게이트웨이(#3) STA·MQTT";
  $("l-label").textContent = two ? "ESP-NOW 링크 (#1 → #2 본체)" : "ESP-NOW 링크 (#1·#2 → #3)";
  $("l-0h").textContent = two ? "#1 돼지머리 → #2" : "#1 돼지머리 → #3";
  $("l-1").classList.toggle("na", two);
  const age = gw.lastSeen ? now - gw.lastSeen : null;
  setText($("g-conn"), `${gw.online ? "온라인" : "오프라인"} · ${age == null ? "수신 없음" : `마지막 수신 ${Math.round(age / 1000)}초 전`}`,
    gw.online ? L.gwAgeTone(age) : "bad");
  const reboot = gwSt.reboots ? ` · 재부팅 ${gwSt.reboots}회(마지막 ${new Date(gwSt.lastRebootAt).toLocaleTimeString("ko-KR")})` : " · 재부팅 0회";
  setText($("g-up"), t ? `${L.fmtUptime(t.uptime_ms)}${reboot}` : "—", gwSt.reboots ? "warn" : "");
  const rssi = fmt(t?.rssi, 0);
  setText($("g-wifi"), rssi == null ? "—" : `${rssi} dBm${t.rssi < L.C.RSSI_BAD ? " (약함)" : ""} · 채널 ${t.ch ?? "—"}`,
    L.rssiTone(rssi == null ? null : t.rssi));
  const d = { ...(gw.diag || {}), ...(t || {}) }; // 진단: status(retained, 접속 때) + telemetry에 있으면 그걸 우선
  const rr = d.reset_reason;
  setText($("g-reset"), L.resetText(rr), rr === 4 || (rr >= 5 && rr <= 7) || rr === 9 ? "bad" : "");
  setText($("g-recon"), d.reconnects == null ? "—" : `Wi-Fi 재연결 ${d.reconnects}회 · 끊김 ${d.wifi_disc ?? "—"}회 · MQTT 접속 ${d.mqtt_conns ?? "—"}회`,
    d.reconnects > 0 || d.wifi_disc > 0 ? "warn" : "");
  setText($("g-disc"), L.wifiReasonText(d.wifi_disc_reason), d.wifi_disc_reason ? "warn" : "");
  const leak = L.heapLeak(gwSt);
  setText($("g-heap"), t?.free_heap == null ? "—" : `${Math.round(t.free_heap / 1024)} KB 여유 (free_heap ${t.free_heap} B)${leak ? " · 메모리 누수 의심" : ""}`,
    leak ? "bad" : "");

  for (const i of [0, 1]) {
    const b = t?.[`board${i + 1}`];
    const cells = $(`l-${i}`).querySelectorAll("td");
    if (two && i === 1) { setText(cells[0], "2보드 구성 — 해당 없음"); for (const c of [1, 2, 3]) setText(cells[c], ""); continue; }
    const a = typeof b?.age_ms === "number" ? b.age_ms + (age ?? 0)
      : linkSt.lastRxAt[i] ? now - linkSt.lastRxAt[i] : null;
    setText(cells[0], a == null ? "수신 없음" : `${Math.round(a / 1000)}초 전`, L.ageTone(a));
    const s = L.linkStats(linkSt, i);
    setText(cells[1], s.perMin == null ? "—" : `${s.perMin.toFixed(1)}/분`, L.rateTone(s.perMin));
    setText(cells[2], s.lossPct == null ? "—" : `${s.lossPct.toFixed(1)}%`, L.lossTone(s.lossPct));
    const r = typeof b?.rssi === "number" ? b.rssi : null;
    setText(cells[3], r == null ? "—(펌웨어 대기)" : `${r} dBm${r < L.C.RSSI_BAD ? " 안테나·거리 확인" : ""}`, L.rssiTone(r));
  }
  const bad = t?.rx?.bad, ws = t?.rx?.wrong_src;
  setText($("l-bad"), (typeof bad !== "number" ? "오류 패킷 —"
    : bad > 0 ? `펌웨어 버전 불일치(형식이 다른 패킷 ${bad}개)` : "오류 패킷 0")
    + (typeof ws === "number" ? ` · 다른 MAC 패킷 ${ws}개` : "") + (two && t?.board_ok === false ? " · 보드 MAC 불일치(히터 OFF)" : ""),
    typeof bad === "number" ? (bad > 0 || ws > 0 || t?.board_ok === false ? "sub bad" : "sub ok") : "sub");
}

// ---- 클라우드 연결 테스트: 다른 기기(다른 네트워크)가 브로커를 거쳐 받고 ack를 돌려주는지 본다 ----
const TOPIC_TEST = "oink/web/test";
const TOPIC_ACK = "oink/web/test/ack";
const TEST_TIMEOUT_MS = 5000;
const pending = new Map(); // id -> { text, sent, timer, acked }
const rid = (n) => Math.random().toString(36).slice(2, 2 + n);
const tag = store.get("oink.tag") || rid(8); // 기기 고유값: 자기 메시지와 남의 메시지 구분
store.set("oink.tag", tag);
$("devName").value = store.get("oink.dev") ||
  (/Mobi|Android|iPhone/i.test(navigator.userAgent) ? "폰" : `PC${Math.floor(Math.random() * 90 + 10)}`);
$("devName").addEventListener("change", () => store.set("oink.dev", devName()));
store.set("oink.dev", $("devName").value);
const devName = () => $("devName").value.trim() || "이름없음";

function testLog(line) {
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString("ko-KR")} · ${line}`;
  $("testLog").prepend(li);
  while ($("testLog").children.length > 5) $("testLog").lastChild.remove();
}

function testResult(text) { $("testResult").textContent = text; }

function renderTestBtn() {
  const ok = !!(client && client.connected);
  $("testBtn").disabled = !ok;
  if (!ok) testResult("연결 안 됨");
}

function sendTest() {
  if (!client || !client.connected) { renderTestBtn(); return; }
  const text = $("testText").value.trim() || "ping";
  const id = `${Date.now().toString(36)}-${rid(6)}`;
  const timer = setTimeout(() => {
    const p = pending.get(id);
    pending.delete(id);
    if (p && !p.acked) {
      testResult("❌ 다른 기기 응답 없음(5초) — 다른 기기에서도 로그인돼 있는지 확인");
      testLog(`보냄 "${text}" → ❌ 다른 기기 응답 없음`);
    }
  }, TEST_TIMEOUT_MS);
  pending.set(id, { text, sent: performance.now(), timer, acked: false });
  testResult("전송 중… 다른 기기의 응답을 기다리는 중");
  $("testEcho").textContent = "";
  client.publish(TOPIC_TEST, JSON.stringify({ id, from: devName(), tag, text, sent_ms: Date.now() }), { qos: 1 });
}

function onTestMessage(msg) {
  if (msg.tag === tag) { // 내가 보낸 게 브로커를 거쳐 돌아옴 = 클라우드 도달
    const p = pending.get(msg.id);
    if (p) $("testEcho").textContent = `클라우드 도달 확인 ${Math.round(performance.now() - p.sent)} ms (내 기기 에코)`;
    return;
  }
  testLog(`📥 ${String(msg.from ?? "?")}에서 받음: ${String(msg.text ?? "")}`);
  if (client && client.connected)
    client.publish(TOPIC_ACK, JSON.stringify({ id: msg.id, by: devName(), tag }), { qos: 1 });
}

function onAck(msg) {
  if (msg.tag === tag) return; // 내가 남에게 보낸 ack
  const p = pending.get(msg.id);
  if (!p) return;
  p.acked = true;
  const ms = Math.round(performance.now() - p.sent);
  const line = `✅ ${String(msg.by ?? "?")}이(가) 응답 — 왕복 ${ms} ms`;
  testResult(line);
  testLog(`보냄 "${p.text}" → ${line}`);
}

function onMessage(topic, buf) {
  let msg;
  try { msg = JSON.parse(buf.toString()); } catch { return; }
  if (!msg || typeof msg !== "object") return;
  if (topic === TOPIC_TEST) { onTestMessage(msg); return; }
  if (topic === TOPIC_ACK) { onAck(msg); return; }
  if (topic === TOPIC_CMD_ACK) { onCmdAck(msg); return; }
  if (topic === TOPIC_STATUS) {
    gw.online = !!msg.online;
    gw.ip = msg.ip || gw.ip;
    gw.diag = msg; // reset_reason·wifi_disc·wifi_disc_reason·reconnects·mqtt_conns (게이트웨이 diagJson)
  } else if (topic === TOPIC_TELE) {
    const now = Date.now();
    gw.tele = msg;
    gw.online = true;
    gw.lastSeen = now;
    OinkLink.addSample(linkSt, msg, now);
    OinkLink.gwSample(gwSt, msg, now);
    OinkChart.record(chartSt, msg, now);
    OinkDemo.record(demoSt, msg, now);
  }
  render();
}

function showLogin(err) {
  $("dash").hidden = true;
  $("login").hidden = false;
  $("loginBtn").disabled = false;
  $("loginErr").hidden = !err;
  $("loginErr").textContent = err || "";
}

// 테스트용으로도 쓰도록 노출: oinkConnect(주소, 아이디, 비밀번호)
function oinkConnect(url, username, password, auto = false) {
  if (client) client.end(true);
  gw = { online: false, ip: null, tele: null, lastSeen: 0, diag: null };
  linkSt = OinkLink.makeLink();
  gwSt = OinkLink.makeGw();
  chartSt = OinkChart.makeChart();
  demoSt = OinkDemo.makeDemo();
  $("loginBtn").disabled = true;
  $("loginErr").hidden = true;

  let entered = false;
  const c = mqtt.connect(url, {
    username: username || undefined,
    password: password || undefined,
    clientId: `oink-web-${Math.random().toString(16).slice(2, 10)}`,
    connectTimeout: 8000,
    reconnectPeriod: 0, // 첫 접속 실패는 바로 "로그인 실패"로
  });
  client = c;

  c.on("connect", () => {
    if (!entered) {
      entered = true;
      c.options.reconnectPeriod = 3000; // 로그인 뒤엔 끊기면 자동 재연결
      store.set("oink.broker", url);
      store.set("oink.user", username || "");
      if (auto || $("remember").checked) store.set(KEY_LOGIN, JSON.stringify({ url, username, password }));
      else store.del(KEY_LOGIN);
      $("login").hidden = true;
      $("dash").hidden = false;
      if (window.OinkDb) { OinkDb.start(document); OinkDb.prefill(demoSt, chartSt).then((n) => { if (n) { renderDemo(); renderCharts(); } }); }
      $("pass").value = DEFAULT_PASS;
    }
    c.subscribe([TOPIC_STATUS, TOPIC_TELE]);
    c.subscribe([TOPIC_TEST, TOPIC_ACK, TOPIC_CMD_ACK], { qos: 1 });
    testResult("");
    renderTestBtn();
    render();
  });
  c.on("message", onMessage);
  c.on("close", () => {
    if (!entered) {
      c.end(true);
      if (auto) store.del(KEY_LOGIN);
      if (client === c) showLogin(auto ? "저장된 로그인이 만료됐어요 — 다시 로그인하세요" : "로그인 실패 — 아이디·비밀번호를 확인하세요");
    } else { render(); renderTestBtn(); }
  });
  c.on("error", () => { if (!entered) c.end(true); });
}
window.oinkConnect = oinkConnect;

$("login").addEventListener("submit", (e) => {
  e.preventDefault();
  oinkConnect(BROKER, $("user").value.trim(), $("pass").value);
});
$("test").addEventListener("submit", (e) => { e.preventDefault(); sendTest(); });
window.oinkSendTest = sendTest;
$("logout").addEventListener("click", () => {
  if (client) client.end(true);
  client = null;
  store.del(KEY_LOGIN);
  showLogin();
});

const DEFAULT_PASS = "oink-web"; // 공개 기본 계정(사용자 결정) — 비공개가 필요하면 EMQX 비번 변경 후 이 기본값 제거
$("user").value = store.get("oink.user") || "oink-web";
$("pass").value = DEFAULT_PASS;
try {
  const saved = JSON.parse(store.get(KEY_LOGIN) || "null");
  if (saved?.username) oinkConnect(BROKER, saved.username, saved.password, true);
} catch { store.del(KEY_LOGIN); }
setInterval(() => { if (!$("dash").hidden) render(); }, 2000);
