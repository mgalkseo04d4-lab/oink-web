// Oink 사용자용 웹앱: 브라우저가 wss로 브로커에 직접 접속(서버 없음). 판정 로직은 logic.mjs
import { play, soundOn, setSoundOn } from "./sound.js";
import { gapSegments, niceTicks, tftMood, rxLogStep, rxLive, rxLine, goodMotionOf, pigStill, fillDemoSensors, co2Face, co2AlarmStep, rate, co2Slope, decompProgress, decompStage, co2TrendText, addFeed, homeState, homeText, stateEvents, addEvents, recent,
  DEMO_SPEED, DECOMP_END_H, PEAK_H, AMP_DEFAULT, curveH, predictPpm, activity, capPoints, hotFoodStep, hotHeaterGuard, HOT_MSG_OFF, HOT_MSG_AUTO, HOT_MSG_BLOCKED, autoRange, CO2_MAX, HOLD_RESEND_MS,
  heatModeOf, heaterCmds, restoreMode, dbCo2Points, mergeCo2, pickFeedTs, dqBadge,
  DB_RAW_MS, db1mPoints, joinAggRaw, dbEvents, mergeEvents, faultWord, deviceNote, ctrlTargetOf, isTwoBoard, b1SrcLabel, srcBadge, co2CardValue, co2Warm, tempCardValue, odorCard, LOCAL_TARGET_C,
  latchResetCmd, latchResetText, LATCH_RESET_ASK, LATCH_RESET_NOACK, tempBand, co2Arrow, dbTempPoints, odorWord } from "./logic.mjs";

const T = {
  status: "oink/gateway/status",
  tele: "oink/gateway/telemetry",
  feed: "oink/app/feed_log",
  cmd: "oink/gateway/cmd",
  ack: "oink/gateway/cmd/ack", // firmware2: {"id","ok","msg"}
};
// 현재 2보드(firmware2/oink2_pig)는 가짜값 코드가 없어 #1 값은 모두 실측. true는 가짜값을 쓰는 펌웨어를 붙일 때만.
const FAKE_B1 = false;
const b1Src = () => b1SrcLabel(isTwoBoard(gw.tele, gw.status), FAKE_B1);
const setSrcBadge = (el, val) => { const s = srcBadge(val, b1Src()); el.hidden = !s; el.textContent = s; el.classList.toggle("real", s === "실측"); el.classList.toggle("test", s === "시험값"); };
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
const KEY_GOOD_MOTION = "oink.app.goodMotion";
const KEY_PREHOT = "oink.app.prehot"; // 뜨거운 음식물 감지 직전 히터 모드(복귀 때 ECO 유지용)
const KEY_HOT = "oink.app.hot";      // 뜨거운 음식물 감지 상태(앱을 다시 열어도 복귀 판단 이어짐)
const BROKER = "wss://o9f10aca.ala.asia-southeast1.emqxsl.com:8084/mqtt"; // 주소 고정(로그인 화면에 칸 없음)
// Supabase(PostgREST 직접 fetch). 공개(publishable) 키 = anon 권한: 읽기 + feed_log INSERT만(RLS). 비밀값·service_role은 앱에 두지 않는다
const SB_URL = "https://vjidekvsgernbqdhimnu.supabase.co";
const SB_KEY = "sb_publishable_Bx2zv4eXkfk5huXQVFSS0w_ZxpFOsC9";
const SB_H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const sbGet = (q) => fetch(`${SB_URL}/rest/v1/${q}`, { headers: SB_H, cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))));
const sbInsert = (table, row) => fetch(`${SB_URL}/rest/v1/${table}`, {
  method: "POST", headers: { ...SB_H, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(row),
}).then((r) => { if (!r.ok) throw new Error(r.status); });
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
let rxSt = { seq: null, lastRx: 0, rx: null, log: [] }; // #1→#3 수신 로그(메모리에만)
let lastHoldSend = 0;
let co2Base = loadJson(KEY_BASE, null);
let amp = Number(store.get(KEY_AMP)) || AMP_DEFAULT;
let demo = store.get(KEY_DEMO) === "1";
let goodMotion = goodMotionOf(store.get(KEY_GOOD_MOTION));
let hotSt = loadJson(KEY_HOT, null);
let predSpanH = 24; // 분석 화면 x축: 하루(24h) / 일주일(DECOMP_END_H)
let pendingHeat = null; // { want, ids, acks, sentAt, auto }
let pendingReset = null; // 과열 차단 해제 { id, timer }
let preHot = store.get(KEY_PREHOT) || null;
const MODE_NAME = { off: "히터 끄기", auto: "자동 모드", eco: "🌱 에코 절전" };
let toastTimer = null;
// CO₂ 알림 팝업: 지금 기준 이상인지
let co2High = false;
let lastCo2Save = 0;
let feedLog = [];
let events = [];
try { const a = JSON.parse(store.get(KEY_EV) || "[]"); if (Array.isArray(a)) events = a; } catch { /* 무시 */ }
let evSeen = Number(store.get(KEY_EV_SEEN)) || 0;
let dbEv = [];          // DB events(래치·fault·#1 끊김·재부팅) — 다른 폰과 같은 기록
let evCleared = Number(store.get("oink.app.events.cleared")) || 0; // "지우기" 이전 DB 알림은 숨김
const allEvents = () => mergeEvents(events, dbEv.filter((e) => e.ts > evCleared));
let prevState = null;
let curTab = "home";
let dbFeedTs = null;   // DB feed_log 최신 fed_at
let dbPts = [];        // DB telemetry CO₂ 점(v=null = 끊김)
let dbTemp = [];       // DB 최근 2시간 심부 온도 점(홈 통합 추이)
let dbLast = null;     // { t, flags } 최신 DB 행
let dbOk = null;       // DB 조회 성공 여부(null = 확인 전)
let dbFetchAt = 0;
const lastFeedTs = () => pickFeedTs(feedLog[feedLog.length - 1]?.ts, dbFeedTs);
// DB 실측 = 다른 폰에서 열어도 실측선이 보이게.
// 최근 2시간은 원본(2초), 그 이전은 1분 집계 뷰 telemetry_1m(supabase/migrations/20261106030000).
// shortcut: 뷰가 아직 적용 안 된 DB면 원본 최신 2000행(≈67분)만 받고 그 이전은 이 기기 localStorage 기록으로 채움
async function loadDb(force = false) {
  const now = Date.now();
  if (!force && now - dbFetchAt < 20000) return;
  dbFetchAt = now;
  try {
    const [f] = await sbGet("feed_log?select=fed_at&order=fed_at.desc&limit=1");
    dbFeedTs = f ? Date.parse(f.fed_at) : null;
    const feedTs = lastFeedTs();
    const since = new Date(Math.max(feedTs || 0, now - 7 * 24 * 3600 * 1000)).toISOString();
    const rawSince = new Date(Math.max(Date.parse(since), now - DB_RAW_MS)).toISOString();
    const rows = await sbGet(`telemetry?select=received_at,co2_ppm,co2_status,temp1_c,flags&received_at=gte.${encodeURIComponent(rawSince)}&order=received_at.desc&limit=4000`);
    let agg = [];
    if (rawSince > since) {
      try {
        agg = db1mPoints(await sbGet(`telemetry_1m?select=minute,co2_avg,flagged&minute=gte.${encodeURIComponent(since)}&minute=lt.${encodeURIComponent(rawSince)}&order=minute&limit=10080`));
      } catch { // 뷰 없음(적용 전) → 원본 최신 2000행으로 폴백
        agg = dbCo2Points(await sbGet(`telemetry?select=received_at,co2_ppm,co2_status,flags&received_at=gte.${encodeURIComponent(since)}&received_at=lt.${encodeURIComponent(rawSince)}&order=received_at.desc&limit=2000`));
      }
    }
    dbPts = joinAggRaw(agg, dbCo2Points(rows));
    dbTemp = dbTempPoints(rows);
    if (rows[0]) dbLast = { t: Date.parse(rows[0].received_at), flags: rows[0].flags };
    if (feedTs && co2Base?.feedTs !== feedTs) { // 이 기기에 기준값이 없으면 DB의 투입 직후 첫 유효값
      const first = dbPts.find((p) => p.t >= feedTs && p.v != null);
      if (first) { co2Base = { feedTs, base: first.v }; store.set(KEY_BASE, JSON.stringify(co2Base)); }
    }
    dbOk = true;
  } catch { dbOk = false; }
  loadDbEvents();
  render();
}
async function loadDbEvents() {
  try {
    dbEv = dbEvents(await sbGet("events?select=id,ts,kind,detail&kind=in.(latched,unlatched,fault,b1_lost,b1_back,reboot)&order=ts.desc&limit=50"));
  } catch { /* DB 알림 없이도 동작 */ }
}
async function pollDbStatus() {
  try {
    const [top] = await sbGet("telemetry?select=received_at,flags&order=received_at.desc&limit=1");
    dbLast = top ? { t: Date.parse(top.received_at), flags: top.flags } : null; dbOk = true;
  } catch { dbOk = false; }
  await loadDbEvents();
  render();
}
const co2All = () => mergeCo2(co2Hist, dbPts);

if ("serviceWorker" in navigator) {
  // 새 버전이 활성화되면 한 번 새로고침(캐시 우선이라 안 하면 배포 후 첫 화면이 옛 CSS·JS). 처음 설치(이전 controller 없음)엔 하지 않음.
  const hadCtrl = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadCtrl && !reloaded) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register("sw.js").then((r) => { // 폰 앱은 켜 둔 채 돌아오는 일이 많아 복귀 때도 확인
    document.addEventListener("visibilitychange", () => { if (!document.hidden) r.update().catch(() => {}); });
  }).catch(() => {});
}

$("devName").value = store.get("oink.dev") || (/Mobi|Android|iPhone/i.test(navigator.userAgent) ? "내 폰" : "내 PC");
$("devName").addEventListener("change", () => store.set("oink.dev", $("devName").value.trim()));
const devName = () => $("devName").value.trim() || "이름 없음";
const ago = (ms) => { const m = Math.floor(ms / 60000); return m < 1 ? "방금" : m < 60 ? `${m}분 전` : m < 48 * 60 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`; };
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
function showTab(name, to) {
  curTab = name;
  for (const p of document.querySelectorAll("#app > .tab")) p.hidden = p.id !== `tab-${name}`;
  document.querySelector(".topbar").hidden = name === "log"; // 분석 화면은 자체 제목(목업)
  for (const b of document.querySelectorAll(".tabbar [role=tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  if (name === "log") loadDb();
  if (name === "alert") { const ae = allEvents(); evSeen = ae.length ? Math.max(evSeen, ae[ae.length - 1].ts) : evSeen; store.set(KEY_EV_SEEN, String(evSeen)); }
  render();
  scrollTo(0, 0);
  if (to) $(to)?.scrollIntoView({ block: "start" }); // 홈 지표 카드 → 분석 화면의 해당 섹션
}
document.querySelector(".tabbar").addEventListener("click", (e) => {
  const b = e.target.closest("[role=tab]");
  if (b) showTab(b.dataset.tab);
});

const speed = () => (demo ? DEMO_SPEED : 1);
const valid = (b1) => co2CardValue(b1) != null;

// ---- 예측(점선) vs 실측(실선) CO₂, x = 투입 후 곡선 시간 0~7일, y = ppm 한 축 ----
function predGraph(svg, feedTs, now) {
  setSrcBadge($("srcPred"), null); // 실측선이 그려질 때만 표시
  const W = 320, H = 190, L = 42, R = 10, Tp = 14, B = 24;
  if (!feedTs) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="sp-empty">음식물을 넣으면 예측 곡선이 그려져요</text>`; return; }
  if (co2Base?.feedTs !== feedTs) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="sp-empty">투입 후 첫 CO₂ 값을 기다리는 중이에요</text>`; return; }
  const base = co2Base.base, sp = speed();
  const span = predSpanH;
  const real = co2All().filter((p) => p.t >= feedTs).map((p) => ({ h: curveH(feedTs, p.t, sp), v: p.v, flagged: p.flagged })).filter((p) => p.h <= span);
  const realV = real.filter((p) => p.v != null);
  let peak = 0;
  for (let h = 0; h <= span; h += span / 60) peak = Math.max(peak, rate(h));
  const r = autoRange([base, Math.min(CO2_MAX, base + amp * peak * 1.2), ...realV.map((p) => p.v)], 40, CO2_MAX);
  const x = (h) => L + (h / span) * (W - L - R);
  const y = (v) => Tp + (1 - (v - r.min) / (r.max - r.min)) * (H - Tp - B);
  let g = "";
  for (const v of [r.min, (r.min + r.max) / 2, r.max]) {
    g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="sp-grid"/><text x="${L - 5}" y="${y(v) + 4}" text-anchor="end" class="sp-ax">${Math.round(v)}</text>`;
  }
  const ticks = span === 24 ? [0, 6, 12, 18, 24] : [0, 24, 48, 72, 96, 120, 144, 168];
  for (const h of ticks) g += `<text x="${x(h)}" y="${H - 6}" text-anchor="middle" class="sp-ax">${h === 0 ? "투입" : span === 24 ? `${h}h` : `${h / 24}일`}</text>`;
  const pts = [], up = [], lo = [];
  for (let h = 0; h <= span; h += span / 84) {
    const inc = predictPpm(base, amp, h) - base; // 예측 범위 띠 = 예측 증가분의 80~120%(활성도 정상 경계)
    pts.push(`${x(h).toFixed(1)},${y(base + inc).toFixed(1)}`);
    up.push(`${x(h).toFixed(1)},${y(Math.min(CO2_MAX, base + inc * 1.2)).toFixed(1)}`);
    lo.unshift(`${x(h).toFixed(1)},${y(base + inc * 0.8).toFixed(1)}`);
  }
  g += `<polygon points="${[...up, ...lo].join(" ")}" class="sp-band"/>`;
  g += `<polyline points="${pts.join(" ")}" class="sp-pred"/>`;
  const hn = curveH(feedTs, now, sp);
  if (hn <= span) g += `<line x1="${x(hn)}" x2="${x(hn)}" y1="${Tp}" y2="${H - B}" class="sp-now"/>`;
  if (realV.length) {
    // v=null에서 선을 끊는다(결측·끊김 구간 보간 안 함). 플래그 점은 회색 속빈 원
    let seg = [];
    const flush = () => { if (seg.length) g += `<polyline points="${seg.join(" ")}" class="sp-real"/>`; seg = []; };
    for (const p of real) { if (p.v == null) flush(); else seg.push(`${x(p.h).toFixed(1)},${y(p.v).toFixed(1)}`); }
    flush();
    for (const p of realV) if (p.flagged) g += `<circle cx="${x(p.h).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3.5" class="sp-flag"/>`;
    const l = realV[realV.length - 1];
    setSrcBadge($("srcPred"), l.v);
    g += `<circle cx="${x(l.h)}" cy="${y(l.v)}" r="4" fill="var(--primary)"/>`;
    g += `<text x="${Math.min(x(l.h) + 6, W - R - 30)}" y="${y(l.v) + 16}" class="sp-lbl" fill="var(--primary)">${b1Src()} ${Math.round(l.v)}</text>`;
  }
  svg.innerHTML = g;
}

// ---- 홈 통합 추이: 최근 2시간 CO₂(왼쪽 축) + 심부 온도(오른쪽 축). 값은 실시간 이력 + DB ----
function trendGraph(svg, co2, temp, now) {
  const W = 320, H = 150, L = 38, R = 34, Tp = 10, B = 20;
  co2 = co2.filter((p) => now - p.t <= DB_RAW_MS); temp = temp.filter((p) => now - p.t <= DB_RAW_MS);
  const cv = co2.filter((p) => p.v != null).map((p) => p.v), tv = temp.map((p) => p.v);
  if (!cv.length && !tv.length) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="sp-empty">최근 2시간 기록이 아직 없어요</text>`; return; }
  const x = (t) => L + (1 - (now - t) / DB_RAW_MS) * (W - L - R);
  const yr = (r) => (v) => Tp + (1 - (v - r.min) / (r.max - r.min)) * (H - Tp - B);
  let g = "";
  const line = (pts, y, cls) => { // v=null 또는 60초 넘는 빈틈에서 선을 끊는다(보간 안 함)
    let seg = [], prev = null;
    const flush = () => { if (seg.length) g += `<polyline points="${seg.join(" ")}" class="${cls}"/>`; seg = []; };
    for (const p of pts) { if (p.v == null || (prev && p.t - prev.t > 60000)) flush(); if (p.v != null) seg.push(`${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`); prev = p; }
    flush();
  };
  const rc = cv.length ? autoRange(cv, 40, CO2_MAX) : null, rt = tv.length ? autoRange(tv, 2) : null;
  for (const k of [0, 0.5, 1]) {
    const yy = Tp + k * (H - Tp - B);
    g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="sp-grid"/>`;
    if (rc) g += `<text x="${L - 4}" y="${yy + 4}" text-anchor="end" class="sp-ax co2">${Math.round(rc.max - k * (rc.max - rc.min))}</text>`;
    if (rt) g += `<text x="${W - R + 4}" y="${yy + 4}" class="sp-ax temp">${(rt.max - k * (rt.max - rt.min)).toFixed(1)}</text>`;
  }
  g += `<text x="${L}" y="${H - 4}" class="sp-ax">2시간 전</text><text x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle" class="sp-ax">1시간 전</text><text x="${W - R}" y="${H - 4}" text-anchor="end" class="sp-ax">지금</text>`;
  if (rc) line(co2, yr(rc), "sp-real");
  if (rt) line(temp, yr(rt), "sp-temp");
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
  const b1 = fresh && gw.online ? gw.tele?.board1 : null;
  const b2 = fresh && gw.online ? gw.tele?.board2 : null;
  const hs0 = homeState({ online: gw.online, lastSeen: gw.lastSeen, now, b1, b2 });
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

  const hm = heatModeOf(b2);
  const ecoHome = hs.state === "calm" && hm === "eco" && !b2?.latched; // 이상·끊김·래치가 ECO보다 우선
  const latchHome = !!b2?.latched && hs.state === "calm"; // 래치 중엔 웃는 얼굴·꽃 대신 기본 표정
  $("hero").className = `hero card ${hs.state}${ecoHome ? " eco" : ""}${latchHome ? " latch" : ""}`;
  // 표정 이미지(logic co2Face): CO₂ 기준 미만=웃음, 이상=화남, 무효·끊김=기본(끊김은 회색)
  const linked = !!(client?.connected && gw.online);
  const face = co2Face(hs.state, b1);
  const pigCls = `pig ${hs.state}${hs.state === "sleep" && !linked ? " off" : ""}${pigStill(goodMotion, hs.state, face) ? " still" : ""}`;
  const tft = tftMood(b1), tftEl = $("tftPig");
  if (tftEl.dataset.mood !== tft) {
    tftEl.dataset.mood = tft; tftEl.className = `tft ${tft}`;
    tftEl.setAttribute("aria-label", `TFT 돼지 애니메이션: ${tft === "sleep" ? "자는 얼굴" : tft === "smelly" ? "화난 얼굴" : "웃는 얼굴"}`);
  }
  const rxOn = rxLive(rxSt, now);
  $("rxBadge").textContent = rxOn ? "수신 중" : "수신 끊김";
  $("rxBadge").className = `badge ${rxOn ? "" : "warn"}`;
  const rxC = rxSt.rx;
  $("rxTotal").textContent = rxC ? `#3 누적 수신 ${rxC.all ?? "?"} · 오류 ${rxC.bad ?? "?"} · 다른 보드 ${rxC.wrong_src ?? "?"}` : "";
  $("rxEmpty").hidden = rxSt.log.length > 0;
  const pig = $("pig");
  if (pig.dataset.face !== face) {
    pig.dataset.face = face; pig.src = `img/pig_${face}.webp`;
    pig.classList.remove("pop"); void pig.offsetWidth; pig.classList.add("pop"); // 전환 시 squash-bounce
  }
  pig.className = `${pigCls}${pig.classList.contains("pop") ? " pop" : ""}`;
  const latched = !!b2?.latched; // firmware2 과열 래치: 해제 = 식은 뒤 '과열 차단 해제'(latch_reset), 끄기(off)로는 안 풀림
  const note = deviceNote(b2); // fault·대체 제어
  const txt = latched && hs.state !== "sleep" && hs.state !== "alert" ? faultWord(b2) || "과열 차단 중이에요 — 충분히 식은 뒤 '과열 차단 해제'를 눌러 주세요"
    : linked && note && hs.state !== "alert" ? note
    : ecoHome ? "에너지 아끼며 새근새근 낮잠 자는 중… zZ 🐽" : homeText(hs);
  $("moodText").textContent = txt;
  pig.alt = `Oink: ${txt}`;

  $("conn").className = `pill ${online ? "on" : ""}`;
  $("connText").textContent = !client?.connected ? "재연결 중" : online ? "Oink 연결됨" : "Oink 꺼져 있음";

  const localCtrl = b2?.ctrl_src === "local"; // 펌웨어가 목표 40℃ 고정, 설정한 목표는 #1 복귀 후 적용
  const showTgt = ctrlTargetOf(b2);
  const co2v = co2CardValue(b1), co2ok = co2v != null;
  setSrcBadge($("srcCo2"), co2v);
  $("vCo2").textContent = co2ok ? Math.round(co2v) : "—";
  $("nCo2").textContent = !b1 ? (localCtrl ? "#1 끊김" : "연결 안 됨") : !co2ok ? "센서 준비 중" : hs.reasons.includes("co2") ? "높아요!" : "좋아요";
  $("cCo2").classList.toggle("hot", hs.reasons.includes("co2"));
  $("arCo2").textContent = co2ok ? co2Arrow(co2Slope(co2Hist, now)) : "";
  const t = tempCardValue(b1);
  setSrcBadge($("srcTemp"), t);
  const demoVals = gw.tele?._demo || [];
  if (t != null && demoVals.includes("temp1")) { $("srcTemp").textContent = "시연값"; $("srcTemp").className = "src test"; }
  $("vTemp").textContent = t != null ? t.toFixed(1) : "—";
  const band = tempBand(t);
  $("lvTemp").hidden = !band; $("lvTemp").textContent = band?.text || ""; $("lvTemp").className = `lvl ${band?.key || ""}`;
  $("nTemp").textContent = hs.reasons.includes("hot") ? "너무 뜨거워요!" : Number.isFinite(showTgt) ? `목표 ${+showTgt.toFixed(1)}℃` : !b1 ? "연결 안 됨" : "적당해요";
  $("cTemp").classList.toggle("hot", hs.reasons.includes("hot"));
  const odor = odorCard(b1);
  if (b1 && demoVals.includes("odor")) odor.badge = "시연값";
  const odorCls = `src ${odor.badge === "실측" ? "real" : odor.badge === "시연값" ? "test" : "dq"}`;
  $("vOdor").textContent = odor.text;
  $("srcOdor").hidden = !odor.badge; $("srcOdor").textContent = odor.badge; $("srcOdor").className = odorCls;
  $("odorWarm").hidden = !odor.warm;
  $("vOdorH").textContent = odor.text;
  $("srcOdorH").hidden = !odor.badge; $("srcOdorH").textContent = odor.badge; $("srcOdorH").className = odorCls;
  $("odorWarmH").hidden = !odor.warm;
  const hasOdorIdx = Number.isFinite(b1?.odor_index);
  const odorNote = !hasOdorIdx && Number.isFinite(b1?.gas_v) ? "가스 센서 전압" : "깨끗한 공기 = 1";
  $("nOdor").textContent = odorNote;
  $("nOdorH").textContent = hasOdorIdx ? `${odorWord(b1)} · ${odorNote}` : odorNote;
  // 진짜 끊김(게이트웨이·브로커)만 카드 딤. #1만 끊긴 대체 제어는 online이라 딤 안 함
  $("homeCards").classList.toggle("dim", !online); $("statusCards").classList.toggle("dim", !online); $("offMsg").hidden = online;

  const feedTs = lastFeedTs();
  const p = decompProgress(feedTs, now, speed());
  const st = decompStage(feedTs, now, speed());
  $("progBar").style.width = p == null ? "0" : `${Math.round(p * 100)}%`;
  $("progText").textContent = p == null ? "음식물을 넣으면 보여요" : `약 ${Math.round(p * 100)}% · ${st.text}`;
  $("progTrend").textContent = p == null ? "" : co2TrendText(co2Slope(co2Hist, now));
  const act = feedTs && co2Base?.feedTs === feedTs
    ? activity({ pts: co2All().filter((q) => q.v != null), now, feedTs, base: co2Base.base, amp, speed: speed() }) : null;
  const actLine = !feedTs ? "" : !act ? "분해 활성도: 측정 대기" : act.pct == null ? `분해 활성도: ${act.text}` : `분해 활성도 ${act.pct}% · ${act.text}`;
  $("progAct").textContent = actLine;
  $("vAct").textContent = act?.pct != null ? `${act.pct}%` : "—";
  $("nAct").textContent = !feedTs ? "음식물을 넣으면 보여요" : !act ? "측정 대기" : act.text;
  $("nAct").className = `num act ${act?.key || ""}`;
  $("qFeedSub").textContent = feedTs ? `최근 투입 ${ago(now - feedTs)} · ${t2s(feedTs)}` : "기록 없음";
  $("progAct").className = `num act ${act?.key || ""}`;
  for (const b of document.querySelectorAll(".badge.demo")) b.hidden = !demo;
  $("holdNote").hidden = !hotSt?.active;
  $("ampBadge").textContent = amp === AMP_DEFAULT ? "기본 가정" : `실측 반영 +${amp}ppm`;

  const hb = $("heatBadge");
  if (!b2) { hb.textContent = "연결 안 됨"; hb.className = "badge"; }
  else if (b2.reasons) { hb.textContent = "안전 OFF"; hb.className = "badge warn"; }
  else if (localCtrl) { hb.textContent = b2.heater_on ? "대체 제어 · 데우는 중" : "대체 제어 · 쉬는 중"; hb.className = "badge warn"; }
  else if (hm === "eco") { hb.textContent = b2.heater_on ? "🌱 절전 가열 중" : "🌱 절전 대기 중"; hb.className = "badge eco"; }
  else { hb.textContent = b2.heater_on ? "데우는 중" : "쉬는 중"; hb.className = `badge ${b2.heater_on ? "good" : ""}`; }
  $("heatMode").textContent = !b2 ? "연결 안 됨" : hm === "auto" ? "자동" : hm === "eco" ? "🌱 에코 절전" : hm === "off" ? "꺼짐(OFF)" : "펌웨어 대기";
  $("ecoNote").hidden = hm !== "eco" || localCtrl;
  for (const el of document.querySelectorAll(".latchNote")) {
    el.hidden = !latched;
    el.textContent = `🔒 ${b2?.fault_text === "no_rise" ? faultWord(b2) : "안전 과열 차단 — 충분히 식은 뒤 '과열 차단 해제'를 눌러요. 풀린 뒤엔 꺼진 상태라 '자동'을 눌러야 다시 데워요"}`;
  }
  $("latchBar").hidden = !latched;
  for (const el of document.querySelectorAll(".latchBtn")) { // 사용자가 직접 눌렀을 때만 발행
    el.hidden = !latched;
    el.disabled = !client?.connected || !!pendingReset;
    el.textContent = pendingReset ? "과열 차단 해제 확인 중…" : "과열 차단 해제";
  }
  $("devNote").hidden = !note || latched; $("devNote").textContent = localCtrl && !faultWord(b2) ? `${note} — 지금 목표는 ${LOCAL_TARGET_C}℃ 고정, 모드 설정은 #1 연결이 돌아오면 적용돼요` : note;
  // 홈 모드 칩 + 절전 토글(실제 상태는 telemetry 기준 → 실패하면 자연히 원래 상태로 돌아감)
  // 상태 배너 모드 줄 + 히터 퀵 액션 서브 텍스트(에코 절전이 홈에서 보이게)
  const modeName = !hm ? "" : localCtrl && hm !== "off" ? `대체 제어 ${LOCAL_TARGET_C}℃` : hm === "eco" ? "🌱 에코 절전" : hm === "off" ? "꺼짐" : hm === "auto" ? "자동" : hm;
  $("heroMode").textContent = !hm ? "작동 모드: 연결 안 됨" : `${Number.isFinite(showTgt) ? `목표 온도 ${+showTgt.toFixed(1)}℃ | ` : ""}작동 모드: ${modeName}`;
  $("qHeatSub").textContent = !hm ? "연결 안 됨" : pendingHeat && !pendingHeat.auto ? "기기에 보내는 중…" : `지금: ${modeName}`;
  const ct = b2?.ctrl_temp_c ?? b1?.temp1_c;
  $("heatTemps").textContent = !b2 ? "" : [Number.isFinite(ct) ? `${ct.toFixed(1)}℃` + (Number.isFinite(b2.target_c) ? ` → ${ctrlTargetOf(b2)}℃` : "") : "",
    b2.heater_on ? "히터 켜짐" : "히터 꺼짐"].filter(Boolean).join(" · ");
  if (pendingHeat) {
    const who = pendingHeat.auto ? "앱 자동 제어 · " : "";
    const name = MODE_NAME[pendingHeat.want];
    if (hm === pendingHeat.want) { $("cmdMsg").textContent = `✅ ${who}${name} 적용됨`; pendingHeat = null; }
    else if (now - pendingHeat.sentAt > HEAT_TIMEOUT_MS) {
      $("cmdMsg").textContent = pendingHeat.acks ? `⚠️ ${who}기기는 받았지만 아직 반영되지 않았어요` : `⚠️ ${who}기기 응답 없음 — 명령이 반영되지 않았어요`;
      pendingHeat = null;
    } else $("cmdMsg").textContent = pendingHeat.acks ? `📨 ${who}기기가 받았어요 · 반영 중…` : `📤 ${who}${name} 보내는 중…`;
  }
  $("sheetCmdMsg").textContent = $("cmdMsg").textContent;
  for (const el of document.querySelectorAll(".mode[data-mode]")) { // 표시만: 현재 모드·대기 중(설정 화면 + 홈 시트)
    const m = el.dataset.mode;
    el.classList.toggle("cur", hm === m);
    el.setAttribute("aria-checked", String(hm === m));
    el.classList.toggle("wait", pendingHeat?.want === m);
  }

  // DB 품질 배지(최신 DB 행 flags, 2분 이내일 때만) + 저장 상태
  const dq = dbLast && now - dbLast.t < 120000 ? dqBadge(dbLast.flags) : "";
  const dqC = dq || (co2Warm(b1) ? "예열 중" : ""); // 상태 0이면 값과 함께 예열 표시
  $("dqCo2").hidden = !dqC; $("dqCo2").textContent = dqC;
  const dqT = dq === "수신 끊김" ? dq : ""; // 예열은 CO₂만 해당
  $("dqTemp").hidden = !dqT; $("dqTemp").textContent = dqT;
  $("dbStat").textContent = dbOk == null ? "데이터 저장: 확인 중…" : !dbOk ? "데이터 저장: DB 연결 안 됨"
    : !dbLast ? "데이터 저장: DB 연결됨 (저장된 기록 없음)" : `데이터 저장: DB 연결됨 (마지막 저장 ${now - dbLast.t < 120000 ? `${Math.max(0, Math.round((now - dbLast.t) / 1000))}초 전` : ago(now - dbLast.t)})`;

  // 알림 배지
  const evAll = allEvents();
  const unread = evAll.filter((e) => e.ts > evSeen).length;
  $("evBadge").hidden = !unread || curTab === "alert";
  $("evBadge").textContent = unread > 9 ? "9+" : String(unread);

  if (curTab === "log") {
    predGraph($("gPred"), feedTs, now);
    $("actText").textContent = !feedTs ? "음식물을 넣으면 예측 곡선이 그려져요" : actLine;
    $("actText").className = `act-line ${act?.key || ""}`;
    $("bigAct").textContent = act?.pct != null ? `${act.pct}%` : "—";
    $("spanDay").setAttribute("aria-pressed", String(predSpanH === 24));
    $("spanWeek").setAttribute("aria-pressed", String(predSpanH !== 24));
    spark($("gCo2"), recent(co2Hist, now, GRAPH_MS), "ppm", "", "#E0557A", now);
    spark($("gTemp"), recent(tempHist, now, GRAPH_MS), "c", "℃", "#d9485f", now);
    $("feedList").replaceChildren(...feedLog.slice().reverse().slice(0, 8).map((f) => {
      const li = document.createElement("li");
      li.append(Object.assign(document.createElement("span"), { textContent: `${t2s(f.ts)} · ${f.size}` }),
        Object.assign(document.createElement("span"), { textContent: f.from || "" }));
      return li;
    }));
  }
  if (curTab === "status") trendGraph($("gTrend"), co2All(), mergeCo2(tempHist.map((q) => ({ t: q.t, ppm: q.c })), dbTemp), now);
  if (curTab === "alert") {
    $("evEmpty").hidden = evAll.length > 0;
    $("evList").replaceChildren(...evAll.slice().reverse().map((e) => {
      const li = document.createElement("li");
      li.className = `ev ${e.kind}`;
      li.append(Object.assign(document.createElement("span"), { textContent: e.text }),
        Object.assign(document.createElement("span"), { textContent: t2s(e.ts), className: "t" }));
      return li;
    }));
  }
  const dis = !client?.connected;
  for (const b of document.querySelectorAll("#feedBtns button, #homeFeed button, .mode[data-mode]")) b.disabled = dis;
}

$("clearEv").addEventListener("click", () => { events = []; store.set(KEY_EV, "[]"); evCleared = Date.now(); store.set("oink.app.events.cleared", String(evCleared)); render(); });
function tapCard(el, fn) {
  el.addEventListener("click", fn);
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } });
}
for (const el of document.querySelectorAll("#app .tap[data-go]")) tapCard(el, () => showTab("log", el.dataset.go));
$("trendMore").addEventListener("click", () => showTab("log"));
// 퀵 액션 시트(<dialog>): 바깥(배경)·닫기 누르면 닫힘. 투입 기록은 기존 onFeed, 히터는 기존 sendHeater 그대로
for (const d of document.querySelectorAll("dialog.sheet")) d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
$("qFeed").addEventListener("click", () => $("sheetFeed").showModal());
$("qHeat").addEventListener("click", () => $("sheetHeat").showModal());
for (const el of document.querySelectorAll("#sheetHeat .mode[data-mode]")) el.addEventListener("click", () => sendHeater(el.dataset.mode));
$("logBack").addEventListener("click", () => showTab("home"));
$("spanDay").addEventListener("click", () => { predSpanH = 24; render(); });
$("spanWeek").addEventListener("click", () => { predSpanH = DECOMP_END_H; render(); });

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
function showGoodMotion() {
  $("motionHappy").setAttribute("aria-pressed", String(goodMotion === "happy"));
  $("motionCalm").setAttribute("aria-pressed", String(goodMotion === "calm"));
}
function setGoodMotion(v) {
  goodMotion = goodMotionOf(v); store.set(KEY_GOOD_MOTION, goodMotion); showGoodMotion(); render();
  if (client) client.publish(T.cmd, JSON.stringify({ good_motion: goodMotion }), { qos: 1 });
}
showGoodMotion();
$("motionHappy").addEventListener("click", () => setGoodMotion("happy"));
$("motionCalm").addEventListener("click", () => setGoodMotion("calm"));
// 효과음: 사용자 탭에만 반응(데이터 수신·경고에는 소리 없음). 투입 버튼은 기록 성공 때 짤랑만
function showSound() { $("soundToggle").classList.toggle("on", soundOn()); $("soundToggle").setAttribute("aria-pressed", String(soundOn())); }
showSound();
$("soundToggle").addEventListener("click", () => { setSoundOn(!soundOn()); showSound(); });
// 흔들리는 돼지에서 손가락이 살짝 벗어나도 click이 놓치지 않게 감싸는 칸에 건다. 길게 눌러도 이미지 메뉴 안 뜸
const pigBox = $("pig").closest(".pigwrap"), pigSquish = $("pigSquish");
// 눌림: 진행 중이면 처음부터 다시. 끝나면 클래스를 빼서 탭을 오갈 때 다시 재생되지 않게(img에서 올라온 이벤트는 제외)
const squishDone = (e) => { if (e.target === pigSquish) pigSquish.classList.remove("squish"); };
pigSquish.addEventListener("animationend", squishDone);
pigSquish.addEventListener("animationcancel", squishDone);
pigBox.addEventListener("click", () => {
  play("boing");
  const running = pigSquish.getAnimations()[0];
  if (running) running.currentTime = 0; else pigSquish.classList.add("squish");
});
pigBox.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("click", (e) => { if (e.target.closest("button:not([data-size]), [role=button]")) play("pong"); });
// 시스템 알림은 권한이 이미 허용된 경우에만 덤으로(권한 요청 안 함). 핵심은 앱 안 토스트 + 알림 탭.
const canNotify = () => typeof Notification !== "undefined";

// ---- 알림: 목록 + 상단 토스트 + 시스템 알림 ----
function toast(text, ok = false, ic = "") {
  const t = $("toast");
  t.innerHTML = ic ? `<svg class="t-ic" aria-hidden="true"><use href="#${ic}"/></svg>` : "";
  t.append(Object.assign(document.createElement("span"), { textContent: text }));
  t.className = `toast ${ok ? "ok" : ""}`; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 15000); // 무대에서 읽을 시간
}
function notify(kind, text) {
  events = addEvents(events, [{ ts: Date.now(), kind, text }]); store.set(KEY_EV, JSON.stringify(events));
  toast(text, kind === "hot_off", kind === "hot_on" ? "i-flame" : kind === "hot_off" ? "i-check" : "");
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
  if (topic === T.ack) {
    if (pendingReset && msg.id === pendingReset.id) {
      clearTimeout(pendingReset.timer); pendingReset = null;
      toast(latchResetText(msg), msg.ok === true); render(); return;
    }
    if (pendingHeat?.ids.includes(msg.id)) {
      if (msg.ok === false) { $("cmdMsg").textContent = `⚠️ 기기가 거절했어요: ${String(msg.msg || "이유 없음")}`; pendingHeat = null; }
      else pendingHeat.acks++;
      render();
    }
    return;
  }
  if (topic === T.status) { gw.online = !!msg.online; gw.status = msg; }
  else if (topic === T.tele) {
    rxSt = rxLogStep(rxSt, msg, Date.now()); // 시연값 채우기 전 원본
    $("rxList").replaceChildren(...rxSt.log.map((e) => {
      const li = document.createElement("li");
      li.className = e.kind === "rx" ? "" : "off";
      li.append(Object.assign(document.createElement("span"), { className: "t", textContent: new Date(e.t).toTimeString().slice(0, 8) }),
        Object.assign(document.createElement("span"), { textContent: rxLine(e) }));
      return li;
    }));
    msg = fillDemoSensors(msg);
    gw.tele = msg; gw.online = true; gw.lastSeen = Date.now();
    const b1 = msg.board1;
    if (!$("splash")) { // 시작 화면 위로 뜨지 않게, 앱에 들어온 뒤부터 판정
      const a = co2AlarmStep(co2High, b1);
      co2High = a.high;
      if (a.show && !$("co2Alarm").open) $("co2Alarm").showModal();
    }
    const keep = (h) => h.filter((p) => gw.lastSeen - p.t < 72 * 3600 * 1000);
    const now = gw.lastSeen;
    if (valid(b1)) co2Hist = capPoints(keep([...co2Hist, { t: now, ppm: b1.co2_ppm }]));
    const demoTemp = !!msg._demo?.includes("temp1"); // 시연값은 그래프에만. 뜨거운 음식물 판정과 히터 명령에는 쓰지 않는다
    if (Number.isFinite(b1?.temp1_c)) tempHist = keep([...tempHist, { t: now, c: b1.temp1_c, demo: demoTemp }]).filter((p) => now - p.t <= DB_RAW_MS); // 홈 통합 추이 2시간
    const b2 = msg.board2;
    const feedTs = lastFeedTs();
    if (feedTs && co2Base?.feedTs !== feedTs) { // 투입 직후 첫 유효값을 기준으로
      const first = co2Hist.find((p) => p.t >= feedTs);
      if (first) { co2Base = { feedTs, base: first.ppm }; store.set(KEY_BASE, JSON.stringify(co2Base)); }
    }
    if (now - lastCo2Save > 30000) { lastCo2Save = now; store.set(KEY_CO2, JSON.stringify(co2Hist)); }
    if (client?.connected) {
      const r = hotFoodStep(hotSt, { series: { t1: tempHist.filter((q) => !q.demo) }, co2s: co2Hist, now, cur: { t1: demoTemp ? null : b1?.temp1_c } });
      const g = hotHeaterGuard(r, b2, now - lastHoldSend >= HOLD_RESEND_MS);
      if (g.st !== hotSt) { hotSt = g.st; store.set(KEY_HOT, JSON.stringify(hotSt)); }
      if (g.blocked) notify("hot_on", HOT_MSG_BLOCKED);
      else if (g.cmd === "off") {
        const m = heatModeOf(b2); if (m && m !== "off") { preHot = m; store.set(KEY_PREHOT, m); } // 복귀 때 ECO 유지
        notify("hot_on", HOT_MSG_OFF); sendHeater("off", true); lastHoldSend = now;
      } else if (g.cmd === "auto") { notify("hot_off", HOT_MSG_AUTO); sendHeater(restoreMode(preHot), true); }
      else if (g.cmd === "hold") { // 구 3보드 #2는 30초 무수신이면 auto 복귀 → OFF 재발행(firmware2는 off 유지, 래치 중엔 hotHeaterGuard가 막음)
        lastHoldSend = now;
        client.publish(T.cmd, JSON.stringify({ target: "b2", heater: "off" }), { qos: 1 });
      }
    }
  }
  render();
}

// off·auto는 구 게이트웨이도 받는 {"target":"b2","heater":..}, 목표온도는 firmware2 set_target(30~40). ECO = 목표 30℃ + auto.
// 명령마다 id → firmware2가 oink/gateway/cmd/ack로 답한다. 강제 ON은 보내지 않음.
let cmdSeq = 0;
const mkId = () => `app-${Date.now().toString(36)}-${cmdSeq++}`;
function sendHeater(want, auto = false) {
  if (!client?.connected) return;
  const cmds = heaterCmds(want, mkId);
  if (!cmds.length) return;
  for (const c of cmds) client.publish(T.cmd, JSON.stringify(c), { qos: 1 });
  pendingHeat = { want, ids: cmds.map((c) => c.id), acks: 0, sentAt: Date.now(), auto };
  if (!auto && want !== "off") { preHot = want; store.set(KEY_PREHOT, want); }
  render();
}

// shortcut: 두 기기가 거의 동시에 기록하면 늦게 도착한 쪽이 앞 기록을 덮을 수 있음 — 시연 규모에선 허용, 필요하면 서버 저장소로

// 지난 측정 기록: 번들한 과거 로그만 그린다. 실시간 값·예측·알림·표정과 섞지 않는다.
const REC_COLORS = ["#2563EB", "#E8590C"]; // 2계열 색약 검증 통과(dataviz validate_palette)
const REC_GAP = 30; // 초. 이보다 비면 선을 잇지 않는다
let recData = null, recCat = 0, recHit = [];
const recTime = (t, sec) => new Date(t * 1000).toLocaleTimeString("sv-SE", { timeZone: "Asia/Seoul", hour12: false }).slice(0, sec ? 8 : 5);
const recDay = (t) => new Date(t * 1000).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
function recCounts(id) {
  const rs = recData.rows.filter((r) => r.chart === id);
  const valid = rs.reduce((a, r) => a + r.valid, 0), raw = rs.reduce((a, r) => a + r.raw, 0);
  return { valid, ex: raw - valid };
}
function recDraw() {
  const cat = recData.cats[recCat], svg = $("gRec");
  const W = Math.max(280, svg.parentElement.clientWidth), H = Math.round(Math.min(300, Math.max(210, innerHeight * 0.27)));
  const L = 50, R = 12, Tp = 28, B = 50;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const all = cat.series.map((s) => s.pts.map(([d, v]) => [s.t0 + d, v]));
  const ts = all.flat().map((p) => p[0]), vs = all.flat().map((p) => p[1]);
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  const yt = niceTicks(Math.min(...vs), Math.max(...vs), 5), lo = yt[0], hi = yt.at(-1);
  const x = (t) => L + ((t - t0) / Math.max(t1 - t0, 1)) * (W - L - R), y = (v) => Tp + (1 - (v - lo) / (hi - lo)) * (H - Tp - B);
  const step = [30, 60, 120, 300, 600, 900, 1800, 3600].find((s) => (t1 - t0) / s <= (W < 420 ? 4 : 6)) || 7200;
  const off = 9 * 3600; // 눈금을 KST 정각에 맞춘다
  let g = "";
  for (const v of yt) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="sp-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="rc-ax">${v}</text>`;
  for (let t = Math.ceil((t0 + off) / step) * step - off; t <= t1; t += step) g += `<line x1="${x(t)}" x2="${x(t)}" y1="${H - B}" y2="${H - B + 5}" stroke="var(--muted)"/><text x="${x(t)}" y="${H - B + 18}" text-anchor="middle" class="rc-ax">${recTime(t, step < 60)}</text>`;
  g += `<text x="0" y="15" class="rc-title">${cat.y}</text>`;
  const span = recDay(t0) === recDay(t1) ? `${recDay(t0)} ${recTime(t0)}~${recTime(t1)}` : `${recDay(t0)} ${recTime(t0)} ~ ${recDay(t1)} ${recTime(t1)}`;
  g += `<text x="${(L + W - R) / 2}" y="${H - 8}" text-anchor="middle" class="rc-title">시각 (${span})</text>`;
  all.forEach((pts, i) => {
    for (const seg of gapSegments(pts, REC_GAP)) {
      if (seg.length === 1) g += `<circle cx="${x(seg[0][0]).toFixed(1)}" cy="${y(seg[0][1]).toFixed(1)}" r="3" fill="${REC_COLORS[i]}"/>`;
      else g += `<polyline points="${seg.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ")}" fill="none" stroke="${REC_COLORS[i]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
  });
  svg.innerHTML = g + `<g id="recCross"></g>`;
  const c = recCounts(cat.id);
  svg.setAttribute("aria-label", `${cat.label} ${cat.y} 그래프. ${span}. 유효 ${c.valid}건.`);
  recHit = all.flatMap((pts, i) => pts.map((p) => ({ t: p[0], v: p[1], i, file: cat.series[i].file })));
  recHit.geom = { x, y, Tp, B, H };
  $("recRead").textContent = "그래프를 누르면 그 시각의 값이 나와요";
  $("recLegend").innerHTML = cat.series.map((s, i) => `<span><i style="background:${REC_COLORS[i]}"></i>${s.name} · ${s.file} · ${s.date} · ${s.n}건</span>`).join("");
  $("recCount").textContent = `유효 ${c.valid}건 / 제외 ${c.ex}건 (기준: ${cat.crit})`;
  $("recNote").textContent = cat.id === "co2b" ? `550ppm ${recData.co2.n550}건은 고정값일 수 있어 신뢰 미확정이에요. 30초 넘게 빈 구간은 선을 잇지 않았어요.` : "30초 넘게 빈 구간은 선을 잇지 않았어요. 원본 값을 그대로 그렸어요.";
  for (const b of $("recCats").children) b.setAttribute("aria-pressed", String(+b.dataset.i === recCat));
}
function recPoint(e) {
  if (!recHit.length) return;
  const svg = $("gRec"), r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal, px = ((e.clientX - r.left) / r.width) * vb.width;
  let best = recHit[0], bd = Infinity;
  for (const h of recHit) { const d = Math.abs(recHit.geom.x(h.t) - px); if (d < bd) { bd = d; best = h; } }
  const { x, y, Tp, B, H } = recHit.geom, cat = recData.cats[recCat];
  $("recCross").innerHTML = `<line x1="${x(best.t)}" x2="${x(best.t)}" y1="${Tp}" y2="${H - B}" class="rc-cross"/><circle cx="${x(best.t)}" cy="${y(best.v)}" r="4" fill="${REC_COLORS[best.i]}" stroke="#fff" stroke-width="2"/>`;
  $("recRead").textContent = `${recDay(best.t)} ${recTime(best.t, true)} · ${best.v} ${cat.unit} · ${best.file}`;
}
function recRules() {
  const fmt = (o) => Object.entries(o).map(([k, n]) => `${k}: ${n}건`).join(", ") || "0";
  const rg = (a, u) => (a ? (a[0] === a[1] ? `${a[0]}${u}` : `${a[0]}~${a[1]}${u}`) : "없음");
  const line = (r) => {
    const u = r.metric === "CO₂" ? "ppm" : "℃";
    return `<tr><td>${r.file}${r.part ? ` (${r.part})` : ""}${r.extra ? `<br><small>${r.extra}</small>` : ""}</td><td>${r.metric}</td><td>${r.raw}</td><td>${fmt(r.missing)}</td><td>${fmt(r.error)}</td><td>${r.below + r.above}${r.below ? ` (${r.lim[0]} 미만)` : ""}${r.above ? ` (${r.lim[1]} 초과)` : ""}</td><td>${r.valid}</td><td>${rg(r.numRange, u)} → ${rg(r.validRange, u)}</td></tr>`;
  };
  const sum = (m) => {
    const rs = recData.rows.filter((r) => r.metric === m), s = (k) => rs.reduce((a, r) => a + k(r), 0);
    return `<tr class="sum"><td>합계</td><td>${m}</td><td>${s((r) => r.raw)}</td><td>${s((r) => Object.values(r.missing).reduce((a, b) => a + b, 0))}</td><td>${s((r) => Object.values(r.error).reduce((a, b) => a + b, 0))}</td><td>${s((r) => r.below + r.above)}</td><td>${s((r) => r.valid)}</td><td></td></tr>`;
  };
  const by = (m) => recData.rows.filter((r) => r.metric === m).map(line).join("") + sum(m);
  $("recRows").innerHTML = by("CO₂") + by("온도");
  const shown = recData.rows.reduce((a, r) => a + r.valid, 0), { mq, co2 } = recData, st1 = co2.status["1"] || 0, df = Object.entries(co2.df3).map(([k, n]) => `${k}(${n}건)`).join(", ");
  $("recText").innerHTML = `
    <h3>처리 방식</h3><ul>
      <li>결측과 이상값은 <b>제외만</b> 했어요. 보간, 평균 대체, 값 수정은 하지 않았어요.</li>
      <li>건수를 줄이지 않았어요. 유효 ${shown}건을 전부 그렸어요(줄이기 전후 ${shown}건 동일).</li>
      <li>30초 넘게 비는 구간은 선으로 잇지 않았어요.</li>
      <li>건수는 생성기(webapp/img_src/records_gen.py)가 원본 로그에서 계산하고, 항목 합이 원본 건수와 같은지 검사해요.</li></ul>
    <h3>선별 기준과 근거</h3><ul>
      <li>범위는 DB 트리거(supabase/migrations/20261106000000_init.sql)와 같아요. CO₂ 350~4999ppm, 온도 0~70℃, 온도 오류코드 -127·85.</li>
      <li>트리거의 급변(spike) 판정은 쓰지 않았어요. 범위 안이면 급하게 변해도 포함했어요.</li>
      <li>550ppm ${co2.n550}건은 고정값일 수 있지만 범위 안이라 포함했고, 신뢰는 미확정이에요.</li>
      <li>상태값으로는 선별할 수 없었어요. live_1107은 상태 ${st1}건이 전부 1인데 원본 프레임 상태 바이트(DF3)는 ${df}이에요. 유효 프레임을 1로 고정한 커밋 a1b7ee8(11/07 07:20)과 일치해요. view1_1107에는 상태 항목이 없어요(${co2.viewNoStatus}건).</li>
      <li>MQ ${mq.n}건은 전부 raw ${mq.raw}(${mq.min}~${mq.max}V) 포화라 그래프에서 뺐어요.</li></ul>
    <h3>미확인</h3><ul>
      <li>a1b7ee8을 #1에 올린 시각은 기록을 찾지 못했어요.</li>
      <li>CO₂ 값의 정확도(교정 여부)는 확인하지 못했어요. 범위 안이라고 정확하다는 뜻은 아니에요.</li>
      <li>날짜가 없는 로그(live, view1, main)의 날짜는 파일 이름으로 정했어요. 시각은 기록한 PC 시각이에요.</li>
      <li>heat 로그가 #2 쪽이라는 건 센서기록_현황.md 기준이에요. main_20261106_233624에는 센서 이름이 없어요.</li></ul>`;
}
function recSetView(rules) {
  $("recGraph").hidden = rules; $("recRules").hidden = !rules;
  $("recVGraph").setAttribute("aria-pressed", String(!rules)); $("recVRules").setAttribute("aria-pressed", String(rules));
  if (!rules) recDraw();
}
$("recOpen").addEventListener("click", async () => {
  $("recDlg").showModal();
  if (recData) return recSetView(false);
  try {
    recData = await (await fetch("records.json")).json();
    $("recCats").innerHTML = recData.cats.map((c, i) => `<button type="button" data-i="${i}" aria-pressed="false">${c.label}</button>`).join("");
    recRules(); recSetView(false);
  } catch { $("recRead").textContent = "기록 파일을 불러오지 못했어요"; }
});
$("recCats").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { recCat = +b.dataset.i; recDraw(); } });
$("recVGraph").addEventListener("click", () => recSetView(false));
$("recVRules").addEventListener("click", () => recSetView(true));
$("gRec").addEventListener("pointerdown", recPoint);
$("gRec").addEventListener("pointermove", recPoint);
for (const id of ["recX", "recClose"]) $(id).addEventListener("click", () => $("recDlg").close());
$("recDlg").addEventListener("click", (e) => { if (e.target === $("recDlg")) $("recDlg").close(); });
addEventListener("resize", () => { if ($("recDlg").open && recData && !$("recGraph").hidden) recDraw(); });
$("toast").addEventListener("click", () => { $("toast").hidden = true; });
$("co2AlarmClose").addEventListener("click", () => $("co2Alarm").close());
$("co2AlarmOk").addEventListener("click", () => {
  $("co2Alarm").close();
  $("manual").showModal();
});
for (const id of ["manualX", "manualClose"]) $(id).addEventListener("click", () => $("manual").close());
$("manual").addEventListener("click", (e) => { if (e.target === $("manual")) $("manual").close(); }); // 카드 밖(배경) 탭
const onFeed = (e) => {
  const size = e.target.closest("button")?.dataset.size;
  if (!size || !client?.connected) return;
  feedLog = addFeed(feedLog, { ts: Date.now(), size, from: devName() });
  client.publish(T.feed, JSON.stringify(feedLog), { qos: 1, retain: true });
  // DB에도 저장(실패해도 앱 기록은 유지 — 알림 탭에만 한 줄)
  sbInsert("feed_log", { size, created_by: devName().slice(0, 50) }).catch(() => {
    events = addEvents(events, [{ ts: Date.now(), kind: "db_fail", text: "DB 저장 실패 — 투입 기록은 앱에 남았어요" }]);
    store.set(KEY_EV, JSON.stringify(events)); render();
  });
  $("feedMsg").textContent = $("homeFeedMsg").textContent = `기록했어요 (${size}) — 지금부터 예측 곡선 시작`;
  play("chime");
  $("sheetFeed").close();
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
// 과열 차단 해제: 직접 누름 + 확인 대화상자 → latch_reset 1회. 판단(온도)은 기기가 하고 ack로 결과를 알려 줌.
function sendLatchReset() {
  if (!client?.connected || pendingReset || gw.tele?.board2?.latched !== true) return;
  if (!window.confirm(LATCH_RESET_ASK)) return;
  const c = latchResetCmd(mkId);
  client.publish(T.cmd, JSON.stringify(c), { qos: 1 });
  pendingReset = { id: c.id, timer: setTimeout(() => { pendingReset = null; toast(LATCH_RESET_NOACK); render(); }, HEAT_TIMEOUT_MS) };
  render();
}
for (const el of document.querySelectorAll(".latchBtn")) el.addEventListener("click", sendLatchReset);
$("autoBtn").addEventListener("click", () => sendHeater("auto"));
$("ecoBtn").addEventListener("click", () => sendHeater("eco"));

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
loadDb(true);
setInterval(pollDbStatus, 60000);
// 시작 화면(시연용, 로그인 유지여도 매번): 탭 → 2번 화면 → 탭 → 앱. 자동 넘김 없음
{
  const sp = $("splash");
  const next = () => { if (sp.classList.contains("two")) sp.remove(); else sp.classList.add("two"); };
  sp.addEventListener("click", next);
  sp.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); next(); } });
  sp.focus();
}
