// 가변저항 시험 그래프: 버퍼·갭 분할·스케일(순수 함수) + SVG 그리기. 브라우저 window.OinkChart, node require (chartcheck.mjs).
(function (g) {
  const C = { WINDOW_MS: 60000, GAP_MS: 5000, STALE_MS: 10000 };
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  function makeChart() {
    return { gas: [], odor: [], temp: [], heat: [], pot: [], last: { b1: 0, b2: 0, pot: 0 }, potSeen: false };
  }

  // 최근 WINDOW_MS만 남긴다
  function trim(pts, now, windowMs = C.WINDOW_MS) {
    while (pts.length && pts[0].t < now - windowMs) pts.shift();
    return pts;
  }

  function push(pts, t, v, now) {
    if (v !== null && v !== undefined) pts.push({ t, v });
    return trim(pts, now);
  }

  // telemetry 1건 반영. 보드가 null이면 그 보드 점은 안 쌓여서 시간상 갭이 된다.
  function record(st, tele, now) {
    const b1 = tele && tele.board1, b2 = tele && tele.board2;
    if (b1) { push(st.gas, now, num(b1.gas_v), now); push(st.odor, now, num(b1.odor_index), now); st.last.b1 = now; }
    if (b2) {
      push(st.temp, now, num(b2.temp2_c), now);
      if (typeof b2.heater_on === "boolean") push(st.heat, now, b2.heater_on, now);
      st.last.b2 = now;
    }
    if (tele && Object.prototype.hasOwnProperty.call(tele, "pot_v")) {
      st.potSeen = true;
      push(st.pot, now, num(tele.pot_v), now);
      if (num(tele.pot_v) != null) st.last.pot = now;
    }
    [st.gas, st.odor, st.temp, st.heat, st.pot].forEach((p) => trim(p, now));
    return st;
  }

  // 연속 점 간격이 GAP_MS를 넘으면 선을 끊는다 → [[점...], [점...]]
  function splitGaps(pts, gapMs = C.GAP_MS) {
    const segs = [];
    let cur = [];
    for (const p of pts) {
      if (cur.length && p.t - cur[cur.length - 1].t > gapMs) { segs.push(cur); cur = []; }
      cur.push(p);
    }
    if (cur.length) segs.push(cur);
    return segs;
  }

  // 히터 ON 구간 [{t0,t1}] — 갭이나 OFF에서 끊는다. 마지막 ON 점은 다음 점(최대 2초)까지 칠한다.
  function onRuns(pts, gapMs = C.GAP_MS) {
    const runs = [];
    for (const seg of splitGaps(pts, gapMs)) {
      let start = null;
      seg.forEach((p, i) => {
        const next = seg[i + 1];
        if (p.v && start === null) start = p.t;
        if (start !== null && (!next || !next.v)) { runs.push({ t0: start, t1: next ? next.t : p.t + 2000 }); start = null; }
      });
    }
    return runs;
  }

  const isStale = (lastT, now, staleMs = C.STALE_MS) => !lastT || now - lastT > staleMs;
  const yOf = (v, min, max, h) => h - (Math.min(Math.max(v, min), max) - min) / (max - min) * h;
  const xOf = (t, now, w, windowMs = C.WINDOW_MS) => (1 - (now - t) / windowMs) * w;

  // ---- SVG (viewBox 600×H, preserveAspectRatio none, 선 굵기는 non-scaling) ----
  const W = 600;
  function svg(el, { pts, min, max, color, now, stale, h = 120, band }) {
    let s = "";
    for (const f of [0.25, 0.5, 0.75]) s += `<line x1="0" x2="${W}" y1="${h * f}" y2="${h * f}" class="grid"/>`;
    const lineColor = stale ? "#8a919c" : color;
    for (const seg of splitGaps(pts)) {
      const d = seg.map((p, i) => `${i ? "L" : "M"}${xOf(p.t, now, W).toFixed(1)} ${yOf(p.v, min, max, h).toFixed(1)}`).join(" ");
      s += seg.length > 1
        ? `<path d="${d}" fill="none" stroke="${lineColor}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`
        : `<circle cx="${xOf(seg[0].t, now, W)}" cy="${yOf(seg[0].v, min, max, h)}" r="2.5" fill="${lineColor}"/>`;
    }
    let total = h;
    if (band) {
      total = h + 14;
      s += `<rect x="0" y="${h + 4}" width="${W}" height="8" class="bandbg"/>`;
      for (const r of onRuns(band)) {
        const x0 = Math.max(0, xOf(r.t0, now, W)), x1 = Math.min(W, xOf(r.t1, now, W));
        if (x1 > x0) s += `<rect x="${x0.toFixed(1)}" y="${h + 4}" width="${(x1 - x0).toFixed(1)}" height="8" fill="${stale ? "#8a919c" : "#d95926"}"/>`;
      }
    }
    el.setAttribute("viewBox", `0 0 ${W} ${total}`);
    el.innerHTML = s;
  }

  const api = { C, makeChart, record, trim, splitGaps, onRuns, isStale, yOf, xOf, svg };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else g.OinkChart = api;
})(typeof window !== "undefined" ? window : globalThis);
