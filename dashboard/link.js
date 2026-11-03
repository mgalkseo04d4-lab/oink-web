// ESP-NOW 링크 상태 계산 (순수 함수). 브라우저에선 window.OinkLink, node에선 require (linkcheck.mjs).
(function (g) {
  const C = {
    GREEN_AGE_MS: 7000,   // 노드 송신 주기 5초(oink_node*: SEND_PERIOD_MS) + 여유
    YELLOW_AGE_MS: 15000, // 게이트웨이 STALE_MS와 같음
    EXPECTED_PER_MIN: 12, // 5초 주기 = 분당 12개
    WINDOW_MS: 60000,
    MIN_SPAN_MS: 10000,   // 이보다 짧은 창은 수신율·손실률 계산 안 함
    RSSI_BAD: -70,
  };
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  function makeLink() {
    return { samples: [], lastSeq: [null, null], lastRxAt: [0, 0] };
  }

  // telemetry 1건 반영. 누적 카운터(rx.b1·b2, boardN.lost)를 uptime 기준으로 쌓는다.
  function addSample(st, tele, now) {
    const up = num(tele && tele.uptime_ms);
    if (up == null) return st;
    const last = st.samples[st.samples.length - 1];
    if (last && up < last.up) st.samples = []; // 게이트웨이 재부팅 → 누적값 리셋
    const prev = st.samples[st.samples.length - 1];
    const rx = [num(tele.rx && tele.rx.b1), num(tele.rx && tele.rx.b2)];
    const lost = [tele.board1, tele.board2].map((b, i) => {
      const l = num(b && b.lost);
      return l != null ? l : prev ? prev.lost[i] : null; // 보드가 null이면 직전 값 유지
    });
    st.samples.push({ up, rx, lost });
    while (st.samples.length > 2 && up - st.samples[1].up >= C.WINDOW_MS) st.samples.shift();
    [tele.board1, tele.board2].forEach((b, i) => {
      const seq = num(b && b.seq);
      if (seq != null && seq !== st.lastSeq[i]) { st.lastSeq[i] = seq; st.lastRxAt[i] = now; }
    });
    return st;
  }

  // i: 0=#1, 1=#2. perMin(개/분), lossPct(%) — 데이터 부족하면 null
  function linkStats(st, i) {
    const s = st.samples;
    if (s.length < 2) return { perMin: null, lossPct: null };
    const a = s[0], b = s[s.length - 1];
    const dt = b.up - a.up;
    if (dt < C.MIN_SPAN_MS || a.rx[i] == null || b.rx[i] == null) return { perMin: null, lossPct: null };
    const drx = b.rx[i] - a.rx[i];
    if (drx < 0) return { perMin: null, lossPct: null };
    const perMin = (drx / dt) * 60000;
    let lossPct = null;
    if (a.lost[i] != null && b.lost[i] != null) {
      const dl = b.lost[i] - a.lost[i];
      if (dl >= 0 && drx + dl > 0) lossPct = (dl / (drx + dl)) * 100;
    }
    return { perMin, lossPct };
  }

  const ageTone = (ms) => (ms == null ? "bad" : ms <= C.GREEN_AGE_MS ? "ok" : ms <= C.YELLOW_AGE_MS ? "warn" : "bad");
  const rateTone = (p) => (p == null ? "" : p >= 0.8 * C.EXPECTED_PER_MIN ? "ok" : p >= 0.5 * C.EXPECTED_PER_MIN ? "warn" : "bad");
  const lossTone = (p) => (p == null ? "" : p < 5 ? "ok" : p < 15 ? "warn" : "bad");
  const rssiTone = (r) => (r == null ? "" : r < C.RSSI_BAD ? "bad" : "ok");

  // ---- 게이트웨이(#3) STA·MQTT: 재부팅 감지, 메모리 누수 의심 ----
  const G = { GREEN_AGE_MS: 5000, YELLOW_AGE_MS: 15000, HEAP_WINDOW_MS: 600000, HEAP_DROP: 0.1 };

  function makeGw() {
    return { lastUp: null, reboots: 0, lastRebootAt: null, heap: [] };
  }

  function gwSample(g, tele, now) {
    const up = num(tele && tele.uptime_ms);
    if (up == null) return g;
    if (g.lastUp != null && up < g.lastUp) { g.reboots++; g.lastRebootAt = now; g.heap = []; }
    g.lastUp = up;
    const h = num(tele.free_heap);
    if (h != null) g.heap.push({ t: now, v: h });
    while (g.heap.length > 2 && now - g.heap[1].t >= G.HEAP_WINDOW_MS) g.heap.shift();
    return g;
  }

  // 최근 10분 동안 재부팅 없이 한 번도 늘지 않고, 처음 대비 10% 이상 줄었으면 true
  function heapLeak(g) {
    const h = g.heap;
    if (h.length < 2 || h[h.length - 1].t - h[0].t < G.HEAP_WINDOW_MS * 0.95) return false;
    for (let i = 1; i < h.length; i++) if (h[i].v > h[i - 1].v) return false;
    return h[h.length - 1].v <= h[0].v * (1 - G.HEAP_DROP);
  }

  const gwAgeTone = (ms) => (ms == null ? "bad" : ms <= G.GREEN_AGE_MS ? "ok" : ms <= G.YELLOW_AGE_MS ? "warn" : "bad");
  function fmtUptime(ms) {
    const m = Math.floor((num(ms) || 0) / 60000);
    return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`;
  }

  // ---- #2 fault·err 비트·게이트웨이 진단 문구 (펌웨어 1101작업폴더/firmware: oink_node2_case FT_*, OinkProto OINK_ERR_*) ----
  const FAULT = { // fault_text(게이트웨이 FT[]) → 문구. 숫자는 fault(err>>8 & 7)
    ok: "", sensor: "센서 오류 (온도 읽기 실패)", overheat: "과열 55℃ 래치", timeout: "연속 가열 상한(30분) — 10분 휴지",
    rate: "상승률 이상 (가열 5분에 +1℃ 미만)",
  };
  const FAULT_BY_NUM = ["ok", "sensor", "overheat", "timeout", "rate"];
  const ERR_BITS = [[0, "온도 센서"], [1, "CO₂ 센서"], [2, "H₂S 예열 중"], [4, "과열"], [5, "공회전"]];
  function faultText(b) {
    if (!b) return "";
    const f = num(b.fault), t = typeof b.fault_text === "string" ? b.fault_text : f != null ? FAULT_BY_NUM[f] : null;
    if (t != null) return t in FAULT ? FAULT[t] : `${t} (코드 ${f ?? "?"})`; // 모르는 코드는 원문
    if (f != null) return f ? `fault 코드 ${f}` : "";
    return errText(b.err ?? b.reasons); // fault 필드 없는 옛 펌웨어
  }
  function errText(err) {
    const e = num(err);
    if (!e) return "";
    const names = ERR_BITS.filter(([bit]) => e & (1 << bit)).map(([, n]) => n);
    return names.length ? `오류: ${names.join(", ")}` : "";
  }
  // ESP-IDF esp_reset_reason_t
  const RESET = ["알 수 없음", "전원 켜짐", "외부 리셋 핀", "소프트웨어 재시작(OTA 등)", "패닉(크래시)", "인터럽트 WDT", "태스크 WDT(loop 60초 멈춤)",
    "기타 WDT", "딥슬립 복귀", "전압 저하(brownout)", "SDIO", "USB", "JTAG", "eFuse 오류", "전원 글리치", "CPU 잠김"];
  const resetText = (r) => (num(r) == null ? "—" : `${RESET[r] ?? "알 수 없음"} (${r})`);
  // ESP-IDF wifi_err_reason_t 중 자주 나오는 것
  const WIFI_REASON = { 2: "인증 만료", 3: "AP가 연결 해제", 4: "연결 만료", 8: "연결 종료", 15: "4-way 핸드셰이크 시간 초과",
    200: "비콘 끊김(신호 약함·AP 꺼짐)", 201: "AP 못 찾음", 202: "인증 실패(비번)", 203: "연결 실패", 204: "핸드셰이크 시간 초과", 205: "연결 실패" };
  const wifiReasonText = (r) => (num(r) == null ? "—" : r === 0 ? "없음" : `${WIFI_REASON[r] ?? "기타"} (${r})`);

  // 보드 수신 끊김: 게이트웨이는 연결돼 있는데 해당 보드 값이 null이거나 마지막 수신이 15초 넘음
  const BOARD_STALE_MS = 15000;
  const boardStale = (b, lastRxAt, now) => !b || !lastRxAt || now - lastRxAt > BOARD_STALE_MS;

  const api = { C, G, makeLink, addSample, linkStats, ageTone, rateTone, lossTone, rssiTone,
    makeGw, gwSample, heapLeak, gwAgeTone, fmtUptime,
    faultText, errText, resetText, wifiReasonText, boardStale, BOARD_STALE_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else g.OinkLink = api;
})(typeof window !== "undefined" ? window : globalThis);
