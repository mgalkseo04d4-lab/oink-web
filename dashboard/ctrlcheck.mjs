// node cloud-dashboard/ctrlcheck.mjs — ctrl.js 셀프체크
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const K = createRequire(import.meta.url)("./ctrl.js");

const T = 1000;
// 끊김: 게이트웨이 오래됨 또는 보드 null
assert.equal(K.view("b2", { board2: { mode: "on" } }, false, null, T).label, "끊김");
assert.equal(K.view("b2", { board2: null }, true, null, T).label, "끊김");
// 펌웨어 대기: 필드 없음 → 비활성
let v = K.view("b2", { board2: { temp2_c: 30, heater_on: false } }, true, null, T);
assert.equal(v.label, "펌웨어 대기"); assert.equal(v.enabled, false);
assert.equal(K.view("b1", { board1: { seq: 1 } }, true, null, T).label, "펌웨어 대기");
assert.equal(K.view("b3", { uptime_ms: 1 }, true, null, T).label, "펌웨어 대기");
// 적용됨 / 전송 중 / 응답 없음
const p = { want: "on", sentAt: T };
assert.equal(K.view("b2", { board2: { mode: "on", heater_on: true } }, true, p, T + 2000).result.text, "✅ 적용됨");
assert.equal(K.view("b2", { board2: { mode: "auto", heater_on: false } }, true, p, T + 2000).result.text, "전송 중…");
assert.equal(K.view("b2", { board2: { mode: "auto", heater_on: false } }, true, p, T + 6001).result.text, "⚠ 응답 없음");
// 안전 차단: mode on 인데 heater_on false 는 오류 아님
v = K.view("b2", { board2: { mode: "on", heater_on: false } }, true, null, T);
assert.equal(v.actual.text, "🛡 안전 차단"); assert.equal(v.enabled, true);
// LED: led_on → on/off, 최상위 led_on 은 #3
assert.equal(K.view("b1", { board1: { led_on: true } }, true, { want: "on", sentAt: T }, T).result.text, "✅ 적용됨");
assert.equal(K.view("b3", { led_on: false }, true, { want: "on", sentAt: T }, T + 7000).result.text, "⚠ 응답 없음");
// #1 LED는 10초까지 기다림
assert.equal(K.view("b1", { board1: { led_on: false } }, true, { want: "on", sentAt: T }, T + 7000).result.text, "전송 중…");
assert.equal(K.view("b1", { board1: { led_on: false } }, true, { want: "on", sentAt: T }, T + 10001).result.text, "⚠ 응답 없음");
assert.equal(K.view("b3", { led_on: true }, true, null, T).current, "on");
// 명령 형식
assert.deepEqual(K.payload("b2", "auto"), { target: "b2", heater: "auto" });
assert.deepEqual(K.payload("b3", "off"), { target: "b3", led: "off" });
console.log("ctrlcheck ok");
