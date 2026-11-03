// 보드 제어 판정 (순수 함수). 브라우저 window.OinkCtrl, node require (ctrlcheck.mjs).
(function (root) {
  const C = { TIMEOUT_MS: { b1: 10000, b2: 6000, b3: 6000 } }; // #1은 ESP-NOW 재전송 경로가 길어 10초

  // 대상별: 상태를 읽을 객체, 현재값 필드
  const SRC = {
    b2: { obj: (t) => t?.board2, field: "mode" },
    b1: { obj: (t) => t?.board1, field: "led_on" },
    b3: { obj: (t) => t, field: "led_on" },
  };

  // 현재값을 버튼 값("on"/"off"/"auto")으로
  const cur = (target, o) => {
    const v = o[SRC[target].field];
    return target === "b2" ? v : v ? "on" : "off";
  };

  // tele: 최신 telemetry, fresh: 게이트웨이 최근 수신 여부, pending: {want, sentAt} | null
  function view(target, tele, fresh, pending, now) {
    const o = fresh ? SRC[target].obj(tele) : null;
    if (!o) return { enabled: false, label: "끊김", tone: "bad", current: null, actual: null, result: null };
    if (!(SRC[target].field in o)) return { enabled: false, label: "펌웨어 대기", tone: "", current: null, actual: null, result: null };
    const c = cur(target, o);
    let actual;
    if (target === "b2") {
      actual = o.heater_on ? { text: "히터 켜짐", tone: "warn" }
        : c === "on" ? { text: "🛡 안전 차단", tone: "warn" } : { text: "히터 꺼짐", tone: "" };
    } else actual = { text: o.led_on ? "LED 켜짐" : "LED 꺼짐", tone: o.led_on ? "ok" : "" };
    return { enabled: true, label: `모드 ${c.toUpperCase()}`, tone: "", current: c, actual, result: judge(pending, c, now, C.TIMEOUT_MS[target]) };
  }

  // 보낸 값이 반영됐는지
  function judge(pending, current, now, timeoutMs = C.TIMEOUT_MS.b2) {
    if (!pending) return null;
    if (current === pending.want) return { text: "✅ 적용됨", tone: "ok" };
    if (now - pending.sentAt > timeoutMs) return { text: "⚠ 응답 없음", tone: "bad" };
    return { text: "전송 중…", tone: "" };
  }

  const payload = (target, val) => (target === "b2" ? { target, heater: val } : { target, led: val });

  const api = { C, view, judge, payload };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OinkCtrl = api;
})(typeof window !== "undefined" ? window : globalThis);
