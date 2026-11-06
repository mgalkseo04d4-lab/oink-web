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

// DB 행 → 그래프 점(미리 채우기): 보간 없음, 결측·끊김 뒤 brk, metric 플래그면 f
{
  const t0 = Date.parse("2026-11-06T05:00:00Z"), iso = (s) => new Date(t0 + s * 1000).toISOString();
  const h = D.histPts([
    { received_at: iso(0), co2_ppm: 600, co2_status: 1, temp1_c: 30, gas_v: 0.5, odor_index: null, heater_on: true, flags: [] },
    { received_at: iso(2), co2_ppm: null, co2_status: 0, temp1_c: 30.2, gas_v: 0.5, odor_index: null, heater_on: true, flags: ["co2_ppm:warming"] },
    { received_at: iso(4), co2_ppm: 640, co2_status: 1, temp1_c: 33, gas_v: 0.5, odor_index: null, heater_on: false, flags: ["temp1_c:spike"] },
    { received_at: iso(20), co2_ppm: null, co2_status: null, temp1_c: null, gas_v: null, odor_index: null, heater_on: false, flags: ["stream:gap", "board1:missing"] },
    { received_at: iso(22), co2_ppm: 650, co2_status: 1, temp1_c: 33.1, gas_v: 0.6, odor_index: null, heater_on: false, flags: [] },
  ]);
  assert.deepEqual(h.co2.map((p) => p.v), [600, 640, 650]);   // 예열·끊김 행은 점 없음(값 지어내지 않음)
  assert.equal(h.co2[1].brk, true);                             // 예열 뒤 첫 점에서 선 끊김
  assert.equal(h.co2[2].brk, true);                             // gap 뒤
  assert.equal(h.t1[2].f, true);                                // 온도 spike 점 = 회색 속빈 원
  assert.equal(h.t1[3].brk, true);
  assert.equal(h.odor.length, 0);                               // odor null(R0 보정 전)
  assert.deepEqual(h.heat.map((p) => p.v), [true, true, false, false, false]); // 히터는 #2 값이라 #1 끊김과 무관
  const live = [{ t: t0 + 21000, v: 1 }];
  D.prepend(live, h.co2);
  assert.deepEqual(live.map((p) => p.v), [600, 640, 1]);        // live 첫 점보다 오래된 DB 점만 앞에
  assert.deepEqual(D.histPts(null).co2, []);
}
// 98c9db5 생성 컬럼 메모
assert.match(D.latestNote(null, false), /20261106040000 적용 필요/);
assert.equal(D.latestNote(null, true), "");
assert.equal(D.latestNote({ ctrl_src: "local", temp2_c: 39.94 }, true), "최신 행: 제어 히터면 대체(#1 끊김) · 히터면 39.9℃");
assert.equal(D.latestNote({ ctrl_src: "core", temp2_c: null }, true), "최신 행: 제어 #1 심부 · 히터면 —");
console.log("dbcheck: 미리 채우기 OK");
