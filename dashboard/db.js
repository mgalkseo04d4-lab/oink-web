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
        get("telemetry?select=received_at&order=received_at.desc&limit=1").then((r) => r.json()),
        get("data_quality?select=metric,flag,reason,first_ts,last_ts,n&order=last_ts.desc&limit=30").then((r) => r.json()),
        get("events?select=ts,kind,detail&order=ts.desc&limit=30").then((r) => r.json()),
        get("feed_log?select=fed_at,size,amount_g,food,created_by&order=fed_at.desc&limit=10").then((r) => r.json()),
      ]);
      const n = parseCount(cnt.headers.get("content-range")) ?? 0;
      const ageS = last[0] ? (Date.now() - new Date(last[0].received_at)) / 1000 : null;
      const st = ingestState(n, ageS);
      const el = $("dbIngest"); el.textContent = st.text; el.className = `dbstate ${st.tone}`;
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
    } catch (e) {
      $("dbErr").textContent = `DB 조회 실패 (${e.message}) — 네트워크 또는 Supabase 상태 확인`;
    }
  }
  let timer = null;
  function start(doc) { if (timer) return; refresh(doc); timer = setInterval(() => refresh(doc), C.POLL_MS); }

  const api = { C, ingestState, flagTone, dqRow, eventSummary, eventRow, feedRow, parseCount, fmtAge, refresh, start };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else g.OinkDb = api;
})(typeof window !== "undefined" ? window : globalThis);
