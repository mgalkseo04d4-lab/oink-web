// node cloud-dashboard/dbcheck.mjs — db.js 순수 함수 셀프체크
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const D = createRequire(import.meta.url)("./db.js");

// 수집 상태
assert.equal(D.ingestState(0, null).tone, "bad");
assert.equal(D.ingestState(0, 120).tone, "bad");
assert.equal(D.ingestState(29, 2).tone, "ok");
assert.equal(D.ingestState(12, 2).tone, "warn");       // 행 부족
assert.equal(D.ingestState(30, 25).tone, "warn");      // 최신 행이 늦음
assert.match(D.ingestState(0, null).text, /수집 안 됨/);

// flag 색: 온도 급변은 경고색 아님
assert.equal(D.flagTone("temp1_c", "spike"), "soft");
assert.equal(D.flagTone("co2_ppm", "spike"), "yellow");
assert.equal(D.flagTone("co2_ppm", "warming"), "sky");
assert.equal(D.flagTone("stream", "gap"), "grey");
assert.equal(D.flagTone("board1", "missing"), "grey");
assert.equal(D.flagTone("gas_v", "out_of_range"), "orange");

// 행 변환
const r = D.dqRow({ metric: "temp1_c", flag: "spike", reason: "직전 대비 3℃", first_ts: "2026-11-06T04:00:00Z", last_ts: "2026-11-06T04:00:20Z", n: 3 });
assert.equal(r.tone, "soft"); assert.equal(r.n, 3); assert.match(r.span, /~/);
assert.equal(D.dqRow({ metric: "stream", flag: "gap", first_ts: "2026-11-06T04:00:00Z", last_ts: "2026-11-06T04:00:00Z" }).span.includes("~"), false);

// 이벤트 요약
assert.equal(D.eventSummary({ kind: "cmd_ack", detail: { id: "a1", ok: false, msg: "latched" } }), "id a1 · 거부 · latched");
assert.equal(D.eventSummary({ kind: "cmd", detail: { id: "a2", cmd: "set_target", target_c: 30 } }), "id a2 · set_target · 목표 30℃");
assert.equal(D.eventSummary({ kind: "cmd", detail: { target: "b2", heater: "off" } }), "heater off");
assert.equal(D.eventSummary({ kind: "status", detail: { online: false } }), "오프라인(LWT)");
assert.match(D.eventSummary({ kind: "latched", detail: { fault_text: "overheat", temp1_c: 51 } }), /overheat · 51℃/);
assert.equal(D.eventSummary({ kind: "b1_lost", detail: {} }), "#1 수신 끊김");
assert.ok(D.eventSummary({ kind: "mqtt", detail: { x: "y".repeat(200) } }).length <= 80);
assert.equal(D.eventSummary({ kind: "status", detail: null }), "상태");

// 투입 기록
assert.equal(D.feedRow({ fed_at: "2026-11-06T04:00:00Z", size: "중", amount_g: null }).amount, "중");
assert.equal(D.feedRow({ fed_at: "2026-11-06T04:00:00Z", size: null, amount_g: 120 }).amount, "120 g");

// Content-Range
assert.equal(D.parseCount("0-0/31"), 31);
assert.equal(D.parseCount("*/0"), 0);
assert.equal(D.parseCount(null), null);
console.log("dbcheck ok");
