// Supabase(PostgREST) 읽기 전용 DB 섹션. 순수 함수는 node(dbcheck.mjs)에서도 쓴다.
// 기준: 1106본대회/DB/팀원전달_올인원.md, data_quality.md. 쓰기 없음. 공개(publishable) 키만 — 비밀값·service_role 금지.
(function (g) {
  const URL = "https://vjidekvsgernbqdhimnu.supabase.co/rest/v1";
  const KEY = "sb_publishable_Bx2zv4eXkfk5huXQVFSS0w_ZxpFOsC9";
  const C = { EXPECT_PER_MIN: 30, OK_MIN: 20, STALE_S: 10, POLL_MS: 10000 };

  // 수집 상태: n = 최근 1분 행 수, ageS = 최신 행 경과 초(null = 행 없음)
  function ingestState(n, ageS) {
    if (ageS == null) return { tone: "bad", text: "DB에 telemetry 없음 — EMQX→DB 수집 안 됨 (HTTP 싱크·규칙·x-oink-key 확인)" };
    if (n === 0 || ageS > 60) return { tone: "bad", text: `최근 1분 0행 — EMQX→DB 수집 안 됨 (마지막 ${fmtAge(ageS)} 전)` };
    if (n < C.OK_MIN || ageS > C.STALE_S) return { tone: "warn", text: `최근 1분 ${n}행 (정상 ≈${C.EXPECT_PER_MIN}) · 마지막 ${fmtAge(ageS)} 전` };
    return { tone: "ok", text: `최근 1분 ${n}행 · 마지막 ${fmtAge(ageS)} 전` };
  }
  // 최신 행 메모(98c9db5 생성 컬럼 temp2_c·ctrl_src — 20261106040000 미적용이면 컬럼 없음 → newCols=false)
  function latestNote(row, newCols) {
    if (!newCols) return "temp2_c·ctrl_src 컬럼 없음 — supabase/migrations/20261106040000 적용 필요";
    if (!row) return "";
    const src = row.ctrl_src === "local" ? "히터면 대체(#1 끊김)" : row.ctrl_src === "core" ? "#1 심부" : "—";
    return `최신 행: 제어 ${src} · 히터면 ${row.temp2_c != null ? `${Math.round(row.temp2_c * 10) / 10}℃` : "—"}`;
  }
  const fmtAge = (s) => (s < 90 ? `${Math.round(s)}초` : s < 5400 ? `${Math.round(s / 60)}분` : `${Math.round(s / 3600)}시간`);

  // flag 색 (data_quality.md 표시 규칙: 온도 급변은 시연·투입 때 정상 → 경고색 금지)
  function flagTone(metric, flag) {
    if (flag === "missing" || flag === "gap") return "grey";
    if (flag === "warming") return "sky";
    if (flag === "out_of_range" || flag === "sensor_error") return "orange";
    if (flag === "spike") return metric === "temp1_c" ? "soft" : "yellow";
    return "grey";
  }

  const hm = (ts) => { const d = new Date(ts); return isNaN(d) ? "—" : d.toLocaleTimeString("ko-KR", { hour12: false }); };
  function span(a, b) { const x = hm(a), y = hm(b); return x === y ? x : `${x} ~ ${y}`; }

  function dqRow(r) {
    return { metric: r.metric, flag: r.flag, tone: flagTone(r.metric, r.flag), reason: r.reason || "", span: span(r.first_ts, r.last_ts), n: r.n ?? 1 };
  }

  // events detail 한 줄 요약
  function eventSummary(e) {
    const d = e.detail && typeof e.detail === "object" ? e.detail : {};
    switch (e.kind) {
      case "cmd": return [d.id && `id ${d.id}`, d.cmd || (d.heater && `heater ${d.heater}`), d.target_c != null && `목표 ${d.target_c}℃`].filter(Boolean).join(" · ") || "명령";
      case "cmd_ack": return [d.id && `id ${d.id}`, d.ok === false ? "거부" : d.ok === true ? "OK" : null, d.msg].filter(Boolean).join(" · ") || "응답";
      case "status": return [d.online === false ? "오프라인(LWT)" : d.online === true ? "온라인" : null, d.reset_reason != null && `리셋 ${d.reset_reason}`].filter(Boolean).join(" · ") || "상태";
      case "latched": return `래치 · ${d.fault_text || "fault " + (d.fault ?? "?")}${d.temp1_c != null ? ` · ${d.temp1_c}℃` : ""}`;
      case "unlatched": return "래치 해제";
      case "fault": return `${d.from || "정상"} → ${d.to || "정상"}`;
      case "heater_on": case "heater_off": return [d.mode && `모드 ${d.mode}`, d.temp1_c != null && `${d.temp1_c}℃`, d.target_c != null && `목표 ${d.target_c}℃`].filter(Boolean).join(" · ");
      case "reboot": return "본체 재부팅";
      case "b1_lost": return "#1 수신 끊김";
      case "b1_back": return "#1 수신 복구";
      default: { const s = JSON.stringify(d); return s.length > 80 ? s.slice(0, 77) + "…" : s; }
    }
  }
  const eventRow = (e) => ({ ts: hm(e.ts), kind: e.kind, text: eventSummary(e) });
  const feedRow = (f) => ({ ts: new Date(f.fed_at).toLocaleString("ko-KR", { hour12: false }), amount: [f.size, f.amount_g != null && `${f.amount_g} g`].filter(Boolean).join(" · ") || "—", by: f.created_by || "—", food: f.food || "" });

  // DB telemetry 행 → 그래프 점(페이지 열 때 미리 채움). 원값 그대로, 보간 없음.
  // 결측·끊김 플래그 행은 점을 만들지 않고 다음 점에 brk(선 끊기), 해당 metric 플래그가 있으면 f(회색 속빈 원).
  const BREAK = ["stream:gap", "board1:missing"];
  function histPts(rows) {
    const out = { co2: [], t1: [], gas: [], odor: [], heat: [] };
    const brk = { co2: false, t1: false, gas: false, odor: false, heat: false };
    const sorted = (Array.isArray(rows) ? rows : []).map((r) => ({ ...r, t: Date.parse(r.received_at) }))
      .filter((r) => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
    const put = (k, t, v, fl, metric) => {
      if (v == null || (typeof v === "number" && !Number.isFinite(v))) { brk[k] = true; return; }
      const p = { t, v };
      if (brk[k]) { p.brk = true; brk[k] = false; }
      if (metric && fl.some((f) => f.startsWith(metric + ":"))) p.f = true;
      out[k].push(p);
    };
    for (const r of sorted) {
      const fl = Array.isArray(r.flags) ? r.flags : [];
      if (fl.some((f) => BREAK.includes(f))) { if (fl.includes("stream:gap")) Object.keys(brk).forEach((k) => (brk[k] = true)); }
      const b1 = !fl.includes("board1:missing");
      const co2Ok = r.co2_status === 1 && !fl.includes("co2_ppm:missing") && !fl.includes("co2_ppm:warming");
      put("co2", r.t, b1 && co2Ok ? r.co2_ppm : null, fl, "co2_ppm");
      put("t1", r.t, b1 && !fl.includes("temp1_c:sensor_error") ? r.temp1_c : null, fl, "temp1_c");
      put("gas", r.t, b1 ? r.gas_v : null, fl, "gas_v");
      put("odor", r.t, b1 ? r.odor_index : null, fl, "odor_index");
      put("heat", r.t, typeof r.heater_on === "boolean" ? r.heater_on : null, fl, null);
    }
    return out;
  }
  // DB 점을 live 배열 앞에 붙인다(live 첫 점보다 오래된 것만, 배열은 제자리 수정 — record()가 같은 배열에 쌓음)
  function prepend(live, dbp) {
    const lo = live.length ? live[0].t : Infinity;
    live.unshift(...dbp.filter((p) => p.t < lo));
    return live;
  }

  // Content-Range "0-0/123" 또는 "*/0" → 전체 개수
  const parseCount = (h) => { const m = /\/(\d+)$/.exec(h || ""); return m ? Number(m[1]) : null; };

  // ---------- 브라우저 ----------
  async function get(path, extra) {
    const r = await fetch(`${URL}/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, ...extra } });
    if (!r.ok) throw new Error(`${r.status}`);
    return r;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  async function refresh(doc) {
    const $ = (id) => doc.getElementById(id);
    try {
      const since = new Date(Date.now() - 60000).toISOString();
      const [cnt, last, dq, ev, fd] = await Promise.all([
        get(`telemetry?select=id&received_at=gte.${encodeURIComponent(since)}`, { Prefer: "count=exact", Range: "0-0" }),
        get("telemetry?select=received_at,temp2_c,ctrl_src&order=received_at.desc&limit=1").then((r) => r.json()).then((rows) => ({ rows, newCols: true }))
          .catch(() => get("telemetry?select=received_at&order=received_at.desc&limit=1").then((r) => r.json()).then((rows) => ({ rows, newCols: false }))),
        get("data_quality?select=metric,flag,reason,first_ts,last_ts,n&order=last_ts.desc&limit=30").then((r) => r.json()),
        get("events?select=ts,kind,detail&order=ts.desc&limit=30").then((r) => r.json()),
        get("feed_log?select=fed_at,size,amount_g,food,created_by&order=fed_at.desc&limit=10").then((r) => r.json()),
      ]);
      const n = parseCount(cnt.headers.get("content-range")) ?? 0;
      const ageS = last.rows[0] ? (Date.now() - new Date(last.rows[0].received_at)) / 1000 : null;
      const st = ingestState(n, ageS);
      const el = $("dbIngest"); el.textContent = st.text; el.className = `dbstate ${st.tone}`;
      const ln = $("dbLatest"); if (ln) { ln.textContent = latestNote(last.rows[0], last.newCols); ln.className = `dbstate ${last.newCols ? "" : "warn"}`; }
      $("dbDq").innerHTML = dq.length ? dq.map(dqRow).map((r) =>
        `<tr><td>${esc(r.metric)}</td><td><span class="fl ${r.tone}">${esc(r.flag)}</span></td><td>${esc(r.reason)}</td><td>${esc(r.span)}</td><td>${r.n}</td></tr>`).join("")
        : `<tr><td colspan="5" class="empty">기록 없음</td></tr>`;
      $("dbEv").innerHTML = ev.length ? ev.map(eventRow).map((r) =>
        `<tr><td>${esc(r.ts)}</td><td>${esc(r.kind)}</td><td>${esc(r.text)}</td></tr>`).join("")
        : `<tr><td colspan="3" class="empty">기록 없음</td></tr>`;
      $("dbFeed").innerHTML = fd.length ? fd.map(feedRow).map((r) =>
        `<tr><td>${esc(r.ts)}</td><td>${esc(r.amount)}</td><td>${esc(r.food)}</td><td>${esc(r.by)}</td></tr>`).join("")
        : `<tr><td colspan="4" class="empty">기록 없음</td></tr>`;
      $("dbErr").textContent = "";
      get("telemetry_1m?select=minute&limit=1")
        .then(() => { $("dbView").textContent = "1분 집계 뷰(telemetry_1m): 있음"; $("dbView").className = "dbstate ok"; })
        .catch(() => { $("dbView").textContent = "1분 집계 뷰(telemetry_1m): 없음 — supabase/migrations/20261106030000 적용 필요"; $("dbView").className = "dbstate warn"; });
    } catch (e) {
      $("dbErr").textContent = `DB 조회 실패 (${e.message}) — 네트워크 또는 Supabase 상태 확인`;
    }
  }
  let timer = null;
  function start(doc) { if (timer) return; refresh(doc); timer = setInterval(() => refresh(doc), C.POLL_MS); }
  // 시연 탭(최근 5분)·가변저항 그래프(최근 60초)를 DB 원본으로 미리 채움. 실패해도 live만으로 동작
  async function prefill(demoSt, chartSt) {
    try {
      const since = new Date(Date.now() - 5 * 60000).toISOString();
      const rows = await get(`telemetry?select=received_at,co2_ppm,co2_status,temp1_c,gas_v,odor_index,heater_on,flags&received_at=gte.${encodeURIComponent(since)}&order=received_at&limit=300`).then((r) => r.json());
      const h = histPts(rows);
      prepend(demoSt.co2, h.co2); prepend(demoSt.t1, h.t1);
      prepend(chartSt.gas, h.gas); prepend(chartSt.odor, h.odor); prepend(chartSt.heat, h.heat);
      return rows.length;
    } catch { return 0; }
  }

  const api = { C, ingestState, latestNote, flagTone, dqRow, eventSummary, eventRow, feedRow, parseCount, fmtAge, histPts, prepend, refresh, start, prefill };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else g.OinkDb = api;
})(typeof window !== "undefined" ? window : globalThis);
