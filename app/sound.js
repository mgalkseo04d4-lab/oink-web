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

// 돼지 음절 하나: 성문 펄스(지터·진폭 떨림·잡음)를 버퍼로 만들어 콧소리 포먼트(병렬 밴드패스)로 냄. path = [[0~1, f0 배수], ...]
function voice(ac, to, t, { dur, f0, path, amp, rough = 0.32, noise = 0.05, jit = 0.04, fm = 1 }) {
  const sr = ac.sampleRate, n = Math.ceil(dur * sr);
  const buf = ac.createBuffer(1, n, sr), d = buf.getChannelData(0);
  let ph = 0, per = 1, shim = 1, odd = false, fl = Math.random(), flut = 26 + Math.random() * 14, seg = 0;
  for (let i = 0; i < n; i++) {
    const x = i / n;
    while (x > path[seg + 1][0]) seg++;
    const [x0, a0] = path[seg], [x1, a1] = path[seg + 1];
    ph += f0 * (a0 + (a1 - a0) * (x - x0) / (x1 - x0)) * per / sr;
    if (ph >= 1) { // 성문 주기마다 길이·세기를 흔들어 그르렁거림
      ph -= 1; odd = !odd;
      per = 1 + (Math.random() - 0.5) * 2 * jit;
      shim = (1 - Math.random() * rough * 0.7) * (odd ? 1 - rough * 0.4 : 1);
      flut *= 1 + (Math.random() - 0.5) * 0.06;
    }
    fl += flut / sr;
    const pulse = ph < 0.6 ? (ph / 0.6) ** 2 - 0.2 : -0.2; // 천천히 열리고 순간 닫힘(평균 0, 배음 풍부)
    const am = 1 - rough * (0.5 + 0.5 * Math.sin(2 * Math.PI * fl));
    const env = Math.min(1, i / (0.005 * sr)) * (x < 0.6 ? 1 : Math.cos((x - 0.6) / 0.4 * Math.PI / 2) ** 2);
    d[i] = env * am * (pulse * shim + noise * (Math.random() * 2 - 1));
  }
  const src = ac.createBufferSource(), out = ac.createGain();
  src.buffer = buf; out.gain.value = amp; out.connect(to);
  for (const [hz, Q, g] of [[230, 0.9, 0.22], [620 * fm, 4, 1], [1300 * fm, 6, 1.1], [2550 * fm, 8, 0.9]]) {
    const f = ac.createBiquadFilter(), fg = ac.createGain();
    f.type = "bandpass"; f.frequency.value = hz; f.Q.value = Q; fg.gain.value = g;
    src.connect(f); f.connect(fg); fg.connect(out);
  }
  src.start(t);
}
// 탭마다 고르는 변형. at = 시작 시각, f0 = 기본음, path = 빠르게 올랐다 떨어지는 피치
const KKUL = [[0, 0.82], [0.22, 1.18], [1, 0.76]];
export const GRUNTS = {
  kkul: [{ at: 0, dur: 0.19, f0: 165, path: KKUL, amp: 2.2 }],
  kkulkkul: [{ at: 0, dur: 0.15, f0: 155, path: KKUL, amp: 2.2 }, { at: 0.19, dur: 0.19, f0: 180, path: KKUL, amp: 2.2 }],
  kkuing: [{ at: 0, dur: 0.32, f0: 205, path: [[0, 0.8], [0.18, 1], [0.6, 1.38], [1, 1.02]], amp: 2.2, rough: 0.18, jit: 0.02, fm: 1.08 }],
  kungkung: [0, 0.125].map((at) => ({ at, dur: 0.085, f0: 120, path: [[0, 1.15], [1, 0.8]], amp: 1.65, rough: 0.5, noise: 0.55, fm: 0.92 })),
};
export function grunt(ac, to, t, key, pitch = 1) {
  for (const { at, f0, ...v } of GRUNTS[key]) voice(ac, to, t + at, { ...v, f0: f0 * pitch });
}
// 직전과 다른 변형을 고름
export function nextGrunt(prev) {
  const keys = Object.keys(GRUNTS).filter((k) => k !== prev);
  return keys[Math.floor(Math.random() * keys.length)];
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
    if (name === "grunt") { // 쿨다운 없음: 이전 울음은 짧게 줄이고 바로 새로 시작
      bus?.gain.setTargetAtTime(0, ac.currentTime, 0.012);
      bus = ac.createGain(); bus.connect(out);
      grunt(ac, bus, t, last = nextGrunt(last), 0.93 + Math.random() * 0.17);
      return;
    }
    const now = performance.now() / 1000;
    if (now < (until[name] || 0)) return;
    until[name] = now + LEN[name];
    SOUNDS[name](ac, out, t);
  } catch { /* 소리 실패는 무시 */ }
}
