// 시연 탭: CO₂·심부온도 기록(순수 함수) + 추세 그래프 SVG. 브라우저 window.OinkDemo, node require (democheck.mjs).
// shortcut: 기록은 페이지 메모리에만 쌓인다(최근 5분, 새로고침하면 사라짐) — 길게 남기려면 서버/retained 저장이 필요.
(function (g) {
  const C = { KEEP_MS: 5 * 60000, WINDOW_MS: 60000, WIDE_MS: 120000, GAP_MS: 6000, STALE_MS: 10000 };
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  const makeDemo = () => ({ co2: [], t1: [], last: 0, base: null });

  function trim(pts, now, ms = C.KEEP_MS) {
    while (pts.length && pts[0].t < now - ms) pts.shift();
    return pts;
  }

  // telemetry 1건 반영. CO₂는 상태 1(정상)일 때만, 보드 null이면 아무것도 안 쌓여서 갭이 된다.
  function record(st, tele, now) {
    const b1 = tele && tele.board1;
    if (b1) {
      st.last = now;
      const co2 = b1.co2_status === 1 ? num(b1.co2_ppm) : null;
      if (co2 !== null) st.co2.push({ t: now, v: co2 });
      const t1 = num(b1.temp1_c);
      if (t1 !== null) st.t1.push({ t: now, v: t1 });
    }
    trim(st.co2, now); trim(st.t1, now);
    return st;
  }

  const inWindow = (pts, now, ms) => pts.filter((p) => p.t >= now - ms);
  const isStale = (st, tele, now) => !tele || !tele.board1 || !st.last || now - st.last > C.STALE_MS;

  // 연속 점 간격이 gapMs를 넘으면 끊는다
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

  // 보이는 데이터 범위에 맞춘 y축. 최소 폭(minSpan) 보장, 위아래 10% 여유, 눈금에 맞춰 반올림.
  function autoRange(pts, minSpan) {
    if (!pts.length) return null;
    let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
    const mid = (lo + hi) / 2, span = Math.max(hi - lo, minSpan) * 1.2;
    lo = mid - span / 2; hi = mid + span / 2;
    const step = niceStep(span / 4);
    return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, step };
  }

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  function ticks(r) {
    const out = [];
    for (let v = r.min; v <= r.max + r.step / 1000; v += r.step) out.push(Math.round(v / r.step) * r.step);
    return out;
  }

  // 변화량: 기준점이 있으면 기준점 이후 첫 값, 없으면 보이는 구간 첫 값 대비 마지막 값
  function delta(pts, now, ms, base) {
    const win = inWindow(pts, now, ms);
    if (!win.length) return null;
    let ref = null;
    if (base != null) ref = pts.find((p) => p.t >= base) || null;
    else ref = win[0];
    if (!ref) return null;
    const cur = win[win.length - 1];
    return { from: ref.v, to: cur.v, d: cur.v - ref.v, byBase: base != null };
  }

  // ---- SVG (실제 픽셀 크기로 그려 글자가 찌그러지지 않게) ----
  const PAD = { l: 52, r: 12, t: 16, b: 24 };
  function svg(el, { pts, now, ms, minSpan, color, unit, d, base, stale }) {
    const W = Math.max(280, el.clientWidth || 600), H = Math.max(160, el.clientHeight || 220);
    const win = inWindow(pts, now, ms);
    const r = autoRange(win, minSpan) || { min: 0, max: 1, step: 0.25 };
    const x = (t) => PAD.l + (1 - (now - t) / ms) * (W - PAD.l - PAD.r);
    const y = (v) => PAD.t + (1 - (v - r.min) / (r.max - r.min)) * (H - PAD.t - PAD.b);
    let s = "";
    for (const v of ticks(r)) {
      s += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/>`;
      s += `<text x="${PAD.l - 6}" y="${y(v) + 4}" text-anchor="end" class="tick">${v.toFixed(d)}</text>`;
    }
    const secs = ms / 1000;
    for (const k of [0, 0.5, 1]) {
      const label = k === 1 ? "지금" : `-${Math.round(secs * (1 - k))}초`;
      s += `<text x="${PAD.l + k * (W - PAD.l - PAD.r)}" y="${H - 6}" text-anchor="${k === 0 ? "start" : k === 1 ? "end" : "middle"}" class="tick">${label}</text>`;
    }
    const col = stale ? "#8a919c" : color;
    // 원값 그대로(평균 없음 — 실시간 지연 방지): 선 + 점, 최신 점은 크게
    for (const seg of splitGaps(win)) {
      if (seg.length > 1) s += `<path d="${seg.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ")}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      for (const p of seg) s += `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3" fill="${col}"/>`;
    }
    if (win.length) {
      const p = win[win.length - 1];
      s += `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="7" fill="${col}" stroke="#fff" stroke-width="2"/>`;
    }
    if (base != null && base >= now - ms) {
      const bx = x(base).toFixed(1);
      s += `<line x1="${bx}" x2="${bx}" y1="${PAD.t}" y2="${H - PAD.b}" class="base"/>`;
      s += `<text x="${+bx + 4}" y="${PAD.t + 12}" class="tick basel">기준점</text>`;
    }
    s += `<line class="cross" x1="0" x2="0" y1="${PAD.t}" y2="${H - PAD.b}" visibility="hidden"/>`;
    el.setAttribute("viewBox", `0 0 ${W} ${H}`);
    el.innerHTML = s;
    return { x, y, W, H, PAD, win };
  }

  const api = { C, makeDemo, record, trim, inWindow, isStale, splitGaps, autoRange, niceStep, ticks, delta, svg };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else g.OinkDemo = api;
})(typeof window !== "undefined" ? window : globalThis);
