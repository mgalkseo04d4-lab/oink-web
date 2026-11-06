# Oink 클라우드 대시보드 (`cloud-dashboard/`, 서버 없음)

팀용 센서값 확인 화면. 배포: https://mgalkseo04d4-lab.github.io/oink-web/dashboard/ . 사용자용 앱은 `webapp/`.

브라우저가 MQTT over WebSocket(wss)으로 브로커에 직접 접속해 `oink/gateway/status`, `oink/gateway/telemetry`를 실시간 표시한다. 빌드 없음: `index.html` + `app.js` + `style.css`. 토픽·페이로드 규격은 `firmware/MQTT_PROTOCOL.md`.

## 1. 브로커: EMQX Cloud Serverless (생성 완료)
- 콘솔 cloud-intl.emqx.com → 프로젝트 oink → 배포 oink_web. 지출 한도(Spend Limit)는 0으로 두기.
- 웹앱: `wss://o9f10aca.ala.asia-southeast1.emqxsl.com:8084/mqtt`, 계정 `oink-web`
- ESP32(보드#3): 호스트 `o9f10aca.ala.asia-southeast1.emqxsl.com`, 포트 8883(TLS), 계정 `oink-esp32`
- 계정 추가·비번 변경: 배포 → Access Control → Authentication. 비밀번호는 비공개로만 공유, 저장소에 올리지 말 것.

## 2. 웹앱 열기 (셋 중 하나)
- 파일 직접 열기: `index.html` 더블클릭 (인터넷 연결 필요 — mqtt.js를 unpkg에서 받음).
- GitHub Pages(현재 배포): 공개 저장소 `mgalkseo04d4-lab/oink-web`의 `dashboard/`에 이 폴더를 복사해 푸시 → https://mgalkseo04d4-lab.github.io/oink-web/dashboard/ 에 1~2분 내 반영. (Netlify는 11/03 무료 크레딧 소진으로 중단)

## 3. 로그인
브로커 주소는 `app.js`의 `BROKER` 상수로 고정(입력칸 없음). 아이디(기본 `oink-web`)·비밀번호 입력 → 접속 성공해야 대시보드로 들어감, 실패하면 "로그인 실패". "로그인 유지"를 켜면 다음부터 자동 접속, 로그아웃하면 저장 정보 삭제.

## 테스트 (인증 없는 공개 브로커)
- `app.js`의 `BROKER`를 `wss://broker.emqx.io:8084/mqtt`로 바꿔서 로컬에서 열고, 아이디·비밀번호 비움(커밋 금지).
- **공개 브로커라 같은 토픽(oink/...)을 아무나 보고 보낼 수 있다.** 테스트 전용, 시연·운영엔 EMQX 계정 사용.

## 클라우드 연결 테스트 패널 (대시보드 아래, 다른 기기끼리)
- 방법: **PC는 Wi-Fi, 폰은 Wi-Fi 끄고 LTE로 각각 로그인 → 한쪽에서 "테스트 전송" → "✅ <반대쪽 기기 이름>이(가) 응답 — 왕복 N ms"가 뜨면 클라우드 경유 확인.** 받은 쪽에는 "📥 <보낸 기기>에서 받음"이 뜬다.
- 동작: `oink/web/test`(qos 1)에 {id, from, tag, text, sent_ms} 발행 → 다른 기기가 받으면 자동으로 `oink/web/test/ack`에 {id, by, tag} 응답. 기기 이름은 칸에서 바꿀 수 있고 이 브라우저에 기억된다.
- "클라우드 도달 확인 N ms"는 내 기기 에코(브로커까지 갔다 옴)일 뿐이다. 5초 안에 다른 기기 응답이 없으면 "다른 기기 응답 없음" — 다른 기기도 로그인돼 있는지 확인. 연결이 끊기면 버튼이 꺼진다.

## 화면
CO₂(상태≠1이면 "예열 중"), 냄새 지수(null이면 "센서 안정화 중", 2 이상 주황), 심부·패드 온도, 히터(board2.fault≠0이면 "안전 OFF" + fault_text 문구: sensor=센서 오류, overheat=과열 55℃ 래치, timeout=연속 가열 상한 30분, rate=상승률 이상), 게이트웨이 온라인·마지막 수신. 게이트웨이 10초 무수신이면 "끊김", 게이트웨이는 살아 있는데 보드(b1/b2)만 15초 넘게 안 오면 해당 카드 회색 "수신 끊김".
- "시험값" 배지: `app.js`의 `FAKE_B1`(#1 USE_FAKE_SENSORS)·`FAKE_ODOR`(냄새 지수 = 가변저항 pot_v). **실측 전환 시 false로.**
- 2보드(firmware2, 11/05) 자동 판별: status `boards:2` 또는 telemetry `board_ok`·`board2.target_c`. 이때 시험값 배지 해제, 패드 온도 → 제어 온도(`ctrl_temp_c`)+목표(`target_c`), 과열 래치(`latched`) 배지, 절전(ECO) 배지 = auto + 목표 ≤30.5℃, #2 히터 ON 비활성(강제 ON 없음), 목표 30~40℃ `{"id","cmd":"set_target","target_c"}` + `oink/gateway/cmd/ack` 결과 표시, #3 LED·#2→#3 행은 "해당 없음", 가변저항 섹션 접힘.
- 펌웨어 98c9db5(11/06): `board2.temp2_c` = 히터면 DS18B20 #2, `ctrl_src` = `core`(#1 심부)/`local`(#1 끊김 → 히터면 대체, 목표 40℃ 고정, "대체 제어" 배지), fault 7 `local_sensor` 추가. DB 컬럼 temp2_c·ctrl_src는 migration 20261106040000 적용 후 표시(미적용이면 DB 섹션에 안내).
- ESP32 상태 카드 진단: reset_reason·reconnects·wifi_disc·wifi_disc_reason·mqtt_conns(게이트웨이 status, retained)와 free_heap(telemetry).
- 기본 계정 oink-web/oink-web이 채워져 있음 — 공개 사이트라 누구나 접속 가능, 비공개가 필요하면 EMQX에서 비번 변경 후 기본값 제거.
- 로그인 유지는 기기에 비번을 저장함 — 공용 기기에서는 체크 해제. 로그아웃하면 저장된 정보가 지워진다.
- DB(Supabase) 섹션: `db.js`가 공개(publishable) 키로 PostgREST를 읽기만 한다(10초마다). 수집 상태·data_quality·events·feed_log. 셀프체크 `node cloud-dashboard/dbcheck.mjs`.
