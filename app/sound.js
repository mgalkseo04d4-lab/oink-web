// 효과음: 오디오 파일 없이 Web Audio로 합성. 사용자 입력 뒤에만 재생하고, 실패해도 앱 동작에는 영향 없음.
const KEY = "oink.app.sound";
let on = true;
try { on = localStorage.getItem(KEY) !== "0"; } catch { /* 저장 불가면 기본 켜짐 */ }
export const soundOn = () => on;
export function setSoundOn(v) {
  on = v;
  try { localStorage.setItem(KEY, v ? "1" : "0"); } catch { /* 저장 불가여도 이번 실행에는 적용 */ }
}

// 음 하나: 주파수 경로 [[초, Hz], ...]를 따라가고 짧게 올렸다 지수 감쇠. to = 연결할 노드
function note(ac, to, type, t, dur, peak, path) {
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(path[0][1], t);
  for (const [at, hz] of path.slice(1)) o.frequency.exponentialRampToValueAtTime(hz, t + at);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(to);
  o.start(t); o.stop(t + dur);
}

// 꿀꿀: 낮은 톱니파를 저역 필터로 둥글리고(콧소리) 음절마다 피치를 올렸다 내림
function grunt(ac, t) {
  const f = ac.createBiquadFilter();
  f.type = "lowpass"; f.frequency.value = 1000; f.Q.value = 5;
  f.connect(ac.destination);
  note(ac, f, "sawtooth", t, 0.16, 0.13, [[0, 170], [0.05, 240], [0.16, 150]]);
  note(ac, f, "sawtooth", t + 0.19, 0.19, 0.13, [[0, 200], [0.06, 285], [0.19, 170]]);
}
// 퐁: 부드러운 사인파 1음
const pong = (ac, t) => note(ac, ac.destination, "sine", t, 0.1, 0.12, [[0, 560], [0.09, 820]]);
// 짤랑: 맑은 3음이 살짝 겹침
function chime(ac, t) {
  [1319, 1661, 1976].forEach((hz, i) => note(ac, ac.destination, "sine", t + i * 0.08, 0.22, 0.09, [[0, hz], [0.22, hz]]));
}
export const SOUNDS = { grunt, pong, chime };

// 첫 사용자 입력 전에는 재생하지 않음
let armed = false;
const arm = () => { armed = true; };
for (const ev of ["pointerdown", "keydown"]) globalThis.addEventListener?.(ev, arm, { capture: true, passive: true });

let ac = null;
const until = {}; // 같은 소리를 연타해도 겹쳐서 커지지 않게
const LEN = { grunt: 0.38, pong: 0.1, chime: 0.38 };
export function play(name) {
  if (!on || !armed) return;
  try {
    ac ||= new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    if (ac.state === "suspended") ac.resume().catch(() => {});
    const now = performance.now() / 1000;
    if (now < (until[name] || 0)) return;
    until[name] = now + LEN[name];
    SOUNDS[name](ac, ac.currentTime + 0.005);
  } catch { /* 소리 실패는 무시 */ }
}
