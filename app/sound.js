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

// 뽀잉: 사인파(옥타브 위 소량)가 훅 올랐다 살짝 내려오고, 정점 뒤 약한 비브라토. 낮은 음·잡음 없음. p = 피치 배수
export const BOING = { start: 328, peak: 864, end: 720, rise: 0.07, dur: 0.26 };
// 탭마다 고르는 피치. 낮을수록 살짝 길게(0.22~0.28초)
export const BOING_PITCHES = [0.92, 0.98, 1.04, 1.1, 1.16];
export function boing(ac, to, t, p = 1) {
  const { start, peak, end, rise } = BOING, stop = t + BOING.dur / p;
  const g = ac.createGain(), vib = ac.createOscillator(), depth = ac.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(1, t + 0.018);
  g.gain.linearRampToValueAtTime(0.8, t + 0.1);
  g.gain.exponentialRampToValueAtTime(0.003, stop - 0.004);
  g.gain.linearRampToValueAtTime(0, stop);
  vib.frequency.value = 17;
  depth.gain.setValueAtTime(0, t + rise);
  depth.gain.linearRampToValueAtTime(35, t + rise + 0.05); // 센트
  vib.connect(depth);
  for (const [mul, amp] of [[1, 0.43], [2, 0.07]]) { // 합이 최대 진폭 0.5
    const o = ac.createOscillator(), a = ac.createGain();
    a.gain.value = amp;
    o.frequency.setValueAtTime(start * p * mul, t);
    o.frequency.exponentialRampToValueAtTime(peak * p * mul, t + rise);
    o.frequency.exponentialRampToValueAtTime(end * p * mul, stop);
    depth.connect(o.detune);
    o.connect(a); a.connect(g);
    o.start(t); o.stop(stop);
  }
  g.connect(to);
  vib.start(t); vib.stop(stop);
}
// 직전과 다른 피치를 고름
export function nextPitch(prev) {
  const ps = BOING_PITCHES.filter((p) => p !== prev);
  return ps[Math.floor(Math.random() * ps.length)];
}
// 퐁: 부드러운 사인파 1음
export const pong = (ac, to, t) => note(ac, to, "sine", t, 0.1, 0.12, [[0, 560], [0.09, 820]]);
// 짤랑: 맑은 3음이 살짝 겹침
export function chime(ac, to, t) {
  [1319, 1661, 1976].forEach((hz, i) => note(ac, to, "sine", t + i * 0.08, 0.22, 0.09, [[0, hz], [0.22, hz]]));
}
const SOUNDS = { pong, chime };
// 모든 소리의 출구: 0.6까지는 그대로, 그 위는 0.75 아래로 눌러 겹쳐도 클리핑 없음(컴프레서는 켠 직후 첫 소리가 작아져서 안 씀)
export function master(ac) {
  const pre = ac.createGain(), lim = ac.createWaveShaper(), n = 2049;
  pre.gain.value = 0.25; // 곡선 입력 ±1 = 실제 ±4
  lim.curve = Float32Array.from({ length: n }, (_, i) => {
    const y = Math.abs(i / (n - 1) * 8 - 4);
    return Math.sign(i - (n - 1) / 2) * (y < 0.6 ? y : 0.6 + 0.15 * Math.tanh((y - 0.6) / 0.15));
  });
  pre.connect(lim); lim.connect(ac.destination);
  return pre;
}

let ac = null, out = null, bus = null, last = null;
const until = {}; // 퐁·짤랑은 연타해도 겹쳐서 커지지 않게
const LEN = { pong: 0.1, chime: 0.38 };
// 첫 사용자 입력 전에는 재생하지 않음. iOS는 제스처 안에서 resume해야 하고 전화 등으로 끊기면 "interrupted"가 됨
let armed = false;
const wake = () => { if (ac && ac.state !== "running") ac.resume().catch(() => {}); };
const arm = () => { armed = true; wake(); };
for (const ev of ["pointerdown", "touchend", "keydown"]) globalThis.addEventListener?.(ev, arm, { capture: true, passive: true });

export function play(name) {
  if (!on || !armed) return;
  try {
    ac ||= new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    out ||= master(ac);
    wake();
    const t = ac.currentTime + 0.005;
    if (name === "boing") { // 쿨다운 없음: 이전 소리는 짧게 줄이고 바로 새로 시작
      bus?.gain.setTargetAtTime(0, ac.currentTime, 0.012);
      bus = ac.createGain(); bus.connect(out);
      boing(ac, bus, t, last = nextPitch(last));
      return;
    }
    const now = performance.now() / 1000;
    if (now < (until[name] || 0)) return;
    until[name] = now + LEN[name];
    SOUNDS[name](ac, out, t);
  } catch { /* 소리 실패는 무시 */ }
}
