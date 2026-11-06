> **구현 메모(11/06, 사용자 결정 반영):** 실제 구현은 이 사양과 다르다 — ECO = auto + **목표 30℃**(firmware2 `set_target` 허용 범위 30~40, 26℃·eco 모드 없음), 자동 = 목표 37℃, 안전 규칙 45℃ 차단·50℃ 래치. 전력 측정이 없어 "65% 절감" 문구는 쓰지 않는다. 4절 앱 단 대체안은 firmware2에서 `temp2_c`가 항상 null이라 미구현. 홈에 모드 칩·절전 토글 카드 추가.

# 📱 [인수인계서] Oink 절전(ECO) 모드 웹앱 UI/UX 개발 사양

> **수신:** 프론트엔드 / 웹앱 개발 담당자 (`webapp/` 폴더 담당)  
> **발신:** 시스템/기획 파트  
> **기준 코드:** `webapp/index.html`, `webapp/app.js`, `webapp/style.css`, `webapp/logic.mjs`  
> **관련 문서:** `DESIGN_GUIDE.md`, `oink-comms.md`

---

## 1. 개요 및 목적

* **목적:** 장기 외출, 야간, 음식물 미투입 상태에서 불필요한 전력 소비를 줄이기 위해 **"🌱 에코 절전(ECO) 모드"**를 앱 UI/UX 및 제어 로직에 추가합니다.
* **사용자 경험:** 사용자가 한 번의 터치로 절전 모드를 켜면, 귀여운 아기돼지가 잠을 자며 에너지를 아끼는 인터랙션과 함께 최적의 에너지 절감 경험을 제공합니다.

---

## 2. UI/UX 디자인 변경 명세

### ① `내 정보` 탭 (`tab-me`) — 히터 조절 카드 변경
기존 2개 버튼(`자동`, `히터 끄기`) 구조에서 **3개 버튼 구조**로 변경합니다.

* **버튼 구성:**
  1. `[자동으로 돌리기]` (`#autoBtn`) — 평상시 최적 분해(40~45℃)
  2. `[🌱 에코 절전]` (`#ecoBtn`, **신규 추가**) — 최저 생존 유지(25~28℃) & 전력 65% 절감
  3. `[히터 끄기]` (`#offBtn`, `.danger`) — 완전 정지 및 청소/점검용
* **상태 뱃지 (`#heatBadge`):**
  * `b2.mode === "eco"`일 때 ➔ 초록/민트 뱃지 `🌱 절전 중(ECO)` 표시
* **안내 배너 및 설명:**
  * 모드가 ECO일 때 안내문구: *"🌱 에코 절전 모드 작동 중 — 26℃ 최저 생존 온도를 유지하여 전력 소비를 약 65% 절감합니다."*

### ② 홈 화면 캐릭터 인터랙션 연동
* 절전 모드가 활성화되었을 때 홈 화면 캐릭터 말풍선 텍스트:
  * *"에너지 아끼며 새근새근 낮잠 자는 중… zZ 🐽"*

---

## 3. 세부 코드 수정 가이드

### 1) `webapp/index.html` 수정 예시
`tab-me` 내의 히터 조절 카드 영역에 에코 버튼과 설명 문구를 추가합니다.

```html
<!-- 내 정보 탭 히터 조절 카드 -->
<article class="card">
  <div class="card-head">
    <p class="kicker">히터 조절</p>
    <span id="heatBadge" class="badge">—</span>
  </div>
  <p class="muted">지금 모드: <strong id="heatMode">—</strong></p>
  <div class="row">
    <button type="button" id="autoBtn">자동으로 돌리기</button>
    <button type="button" id="ecoBtn" class="btn-eco">🌱 에코 절전</button>
    <button type="button" id="offBtn" class="danger">히터 끄기</button>
  </div>
  <p id="cmdMsg" class="muted">명령은 기기가 안전을 먼저 확인한 뒤 적용해요.</p>
  <p id="ecoNote" class="banner eco" hidden>🌱 에코 절전 모드 가동 중 (26℃ 최저 생존 온도로 전력을 아끼고 있어요)</p>
  <p id="holdNote" class="banner warn" hidden>뜨거운 음식물 감지 — 앱이 열려 있는 동안 OFF 유지 중</p>
  <p class="muted tiny">
    * <strong>자동 모드:</strong> 40℃로 활발하게 분해해요.<br>
    * <strong>에코 절전:</strong> 장기 외출이나 밤중에 26℃로 미생물만 살려두며 전력을 절약해요.<br>
    * 기기 안전 규칙(50℃ 상한)이 항상 최우선으로 작동해요.
  </p>
</article>
```

---

### 2) `webapp/app.js` 로직 수정 예시

#### A. 버튼 이벤트 리스너 추가
```javascript
// 기존 autoBtn, offBtn 옆에 ecoBtn 추가
$("autoBtn").addEventListener("click", () => sendHeater("auto"));
$("ecoBtn").addEventListener("click", () => sendHeater("eco"));
$("offBtn").addEventListener("click", () => sendHeater("off"));
```

#### B. 텔레메트리 수신 및 화면 갱신 (`renderTelemetry`)
```javascript
const mode = b2?.mode;
$("heatMode").textContent = !b2 
  ? "연결 안 됨" 
  : mode === "auto" ? "자동" 
  : mode === "eco" ? "🌱 에코 절전" 
  : mode === "off" ? "꺼짐(OFF)" 
  : mode === "on" ? "켜짐(ON)" 
  : "펌웨어 대기";

// 뱃지 상태 처리
if (mode === "eco") {
  hb.textContent = b2.heater_on ? "절전 가열 중" : "절전 대기 중";
  hb.className = "badge eco";
  $("ecoNote").hidden = false;
} else {
  $("ecoNote").hidden = true;
  // 기존 auto / off 뱃지 처리 로직...
}

// 명령 적용 완료 메시지 매칭
if (pendingHeat && mode === pendingHeat.want) {
  const modeName = pendingHeat.want === "eco" ? "에코 절전 모드" 
                 : pendingHeat.want === "off" ? "히터 끄기" : "자동 모드";
  $("cmdMsg").textContent = `✅ ${who}${modeName} 적용됨`;
  pendingHeat = null;
}
```

#### C. MQTT 명령 전송 함수 (`sendHeater`)
기존 함수를 그대로 사용하면 됩니다 (`want` 인자로 `"eco"`를 전달):
```javascript
function sendHeater(want, auto = false) {
  if (!client || !client.connected) {
    $("cmdMsg").textContent = "❌ 클라우드 연결 안 됨";
    return;
  }
  pendingHeat = { want, at: Date.now(), byUser: !auto };
  // 통신 계약: {"target":"b2","heater":"eco|auto|off"}
  client.publish(T.cmd, JSON.stringify({ target: "b2", heater: want }), { qos: 1 });
  $("cmdMsg").textContent = `⏳ ${want === "eco" ? "에코 절전 모드" : want === "off" ? "히터 끄기" : "자동 모드"} 요청 보냄…`;
}
```

---

### 3) `webapp/style.css` 스타일 추가 예시
친환경적이고 귀여운 느낌의 파스텔 민트/에코 컬러를 적용합니다.

```css
/* 에코 절전 버튼 스타일 */
.btn-eco {
  background-color: #e8f8f5;
  color: #1abc9c;
  border: 1.5px solid #a3e4d7;
  font-weight: 600;
  border-radius: 9999px;
  transition: all 0.2s ease;
}
.btn-eco:hover {
  background-color: #d1f2eb;
}

/* 에코 뱃지 스타일 */
.badge.eco {
  background-color: #e8f8f5;
  color: #16a085;
  border: 1px solid #a3e4d7;
}

/* 에코 모드 안내 배너 */
.banner.eco {
  background-color: #e8f8f5;
  color: #117a65;
  border-left: 4px solid #1abc9c;
  padding: 10px 14px;
  border-radius: 8px;
  margin: 8px 0;
  font-size: 0.85rem;
}
```

---

## 4. 💡 펌웨어 배포 전 '앱 단 가상 절전(Fallback)' 옵션 (참고용)

만약 하드웨어/통신 팀의 펌웨어 반영에 시간이 걸릴 경우, 앱 단에서 먼저 소프트웨어적으로 절전 기능을 시연할 수 있습니다:
* 사용자가 앱에서 `에코 모드`를 켜면:
  * 웹앱이 `board2.temp2_c`(심부 온도)를 실시간 감시
  * 심부 온도가 **28℃ 이상이면 `heater: "off"` 유지**
  * 심부 온도가 **24℃ 이하로 내려가면 잠시 `heater: "auto"` 가동**
* ➔ 펌웨어 수정 없이도 앱 단에서 완벽한 에코 절전 시연이 가능합니다.
