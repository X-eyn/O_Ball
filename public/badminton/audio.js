// Office Badminton — sound. Everything is synthesised with WebAudio: no files to download, and the
// whole palette is shaped by the shot — a soft drop is a tick, a perfect smash is a crack.
let ctx = null, master = null, crowdGain = null, crowdSrc = null, muted = false;
const listeners = new Set();

function noiseBuffer(seconds = 0.5) {
  const n = Math.floor(ctx.sampleRate * seconds), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
function init() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain(); master.gain.value = muted ? 0 : 0.8; master.connect(ctx.destination);
  // a continuous crowd bed, gain driven by rally intensity
  const src = ctx.createBufferSource(); src.buffer = noiseBuffer(2); src.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.6;
  crowdGain = ctx.createGain(); crowdGain.gain.value = 0;
  src.connect(bp).connect(crowdGain).connect(master);
  try { src.start(); } catch { }
  crowdSrc = src;
}
function resume() { init(); if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => { }); }
for (const ev of ['pointerdown', 'keydown', 'touchstart']) addEventListener(ev, resume, { once: false });

// one impact: a filtered noise crack + a body thump, both scaled by power
function impact(power, bright, when = 0) {
  if (!ctx) return;
  const t = ctx.currentTime + when;
  const src = ctx.createBufferSource(); src.buffer = noiseBuffer(0.12);
  const hp = ctx.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = bright ? 2600 : 1500; hp.Q.value = bright ? 0.9 : 1.4;
  const g = ctx.createGain();
  const amp = 0.25 + 0.75 * power;
  g.gain.setValueAtTime(amp, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.09 + 0.05 * power);
  src.connect(hp).connect(g).connect(master); src.start(t); src.stop(t + 0.2);
  const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(bright ? 190 : 130, t);
  o.frequency.exponentialRampToValueAtTime(60, t + 0.09);
  const og = ctx.createGain(); og.gain.setValueAtTime(amp * 0.7, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  o.connect(og).connect(master); o.start(t); o.stop(t + 0.14);
}
// a burst of filtered air (swings, takeoff) and a floor thud (landings, a smash into the floor)
function swoosh(dur, freq, when = 0) {
  if (!ctx) return;
  const t = ctx.currentTime + when, src = ctx.createBufferSource(); src.buffer = noiseBuffer(dur + 0.05);
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.8;
  f.frequency.setValueAtTime(freq * 0.5, t); f.frequency.exponentialRampToValueAtTime(freq * 1.6, t + dur * 0.6); f.frequency.exponentialRampToValueAtTime(freq * 0.4, t + dur);
  const g = ctx.createGain(); g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(0.16, t + dur * 0.4); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f).connect(g).connect(master); src.start(t); src.stop(t + dur + 0.05);
}
function thud(amp) {
  if (!ctx) return;
  const t = ctx.currentTime, src = ctx.createBufferSource(); src.buffer = noiseBuffer(0.2);
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 320;
  const g = ctx.createGain(); g.gain.setValueAtTime(amp, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  src.connect(f).connect(g).connect(master); src.start(t); src.stop(t + 0.22);
  tone(95, 0.12, 'sine', amp * 0.8, 0, -45);
}
function tone(freq, dur, type = 'sine', amp = 0.2, when = 0, slide = 0) {
  if (!ctx) return;
  const t = ctx.currentTime + when, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(amp, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.05);
}

export const Sound = {
  resume,
  toggle() {
    muted = !muted;
    if (master) master.gain.value = muted ? 0 : 0.8;
    try { localStorage.setItem('obm_mute', muted ? '1' : ''); } catch { }
    return muted;
  },
  get muted() { return muted; },
  load() { try { muted = !!localStorage.getItem('obm_mute'); } catch { } if (master) master.gain.value = muted ? 0 : 0.8; },
  crowd(level) {
    if (!ctx || !crowdGain) return;
    const want = muted ? 0 : Math.max(0, Math.min(0.35, level * 0.35));
    if (Math.abs(want - (Sound._crowd || 0)) < 0.01) return; // called every frame: only move on change
    Sound._crowd = want;
    crowdGain.gain.setTargetAtTime(want, ctx.currentTime, 0.4);
  },
  fx: {
    // kind: smash, drive, clear, drop, net, servel, serveh
    hit(kind, kmh, perfect, e = {}) {
      const p = Math.min(1, (kmh || 40) / 230);
      const big = kind === 'smash' || kind === 'jsmash' || kind === 'kill';
      if (kind === 'block') { impact(0.18, false); tone(900, 0.05, 'triangle', 0.08); return; }
      impact(Math.max(0.2, p), big || kind === 'counter');
      if (perfect) { tone(1250, 0.16, 'square', 0.12, 0.01); tone(1900, 0.2, 'sine', 0.09, 0.05); }
      // the weight of a smash: a low body blow under the crack, deeper and longer for a jump smash
      if (big && p > 0.45) {
        const jump = kind === 'jsmash';
        tone(jump ? 70 : 90, jump ? 0.3 : 0.18, 'sawtooth', jump ? 0.2 : 0.14, 0, -45);
        tone(jump ? 46 : 58, jump ? 0.34 : 0.2, 'sine', jump ? 0.32 : 0.22, 0, -20);
        if (jump) swoosh(0.25, 2400, 0.004);
      }
      if (e.parry) { tone(1560, 0.22, 'square', 0.1, 0); tone(2340, 0.3, 'sine', 0.09, 0.03); tone(3120, 0.35, 'sine', 0.05, 0.06); }
      if (kind === 'counter' && !e.parry) tone(620, 0.08, 'triangle', 0.09);
    },
    jump(leap) { swoosh(leap ? 0.16 : 0.1, 900, 0); tone(160, 0.08, 'sine', 0.08, 0, 60); },
    land(hard, v) { if (!ctx) return; const a = Math.min(1, (v || 3) / 5) * (hard ? 1 : 0.6); thud(0.18 + 0.3 * a); if (hard) tone(52, 0.2, 'sine', 0.25, 0, -12); },
    slam(kmh) { if (!ctx) return; const p = Math.min(1, (kmh || 60) / 90); thud(0.35 + 0.45 * p); tone(40, 0.45, 'sine', 0.35 * (0.5 + p), 0, -10); swoosh(0.4, 700, 0.02); },
    swing() { if (!ctx) return; tone(700, 0.06, 'sine', 0.045, 0, -260); },
    serve() { tone(520, 0.1, 'triangle', 0.1); },
    net() { if (!ctx) return; tone(220, 0.12, 'triangle', 0.16, 0, -80); impact(0.15, false, 0); },
    dive() { if (!ctx) return; const s = ctx.createBufferSource(); s.buffer = noiseBuffer(0.25); const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700; const g = ctx.createGain(); g.gain.setValueAtTime(0.22, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.24); s.connect(f).connect(g).connect(master); s.start(); s.stop(ctx.currentTime + 0.3); },
    point(mine, won) {
      if (won) { tone(523, 0.16, 'triangle', 0.16); tone(659, 0.16, 'triangle', 0.16, 0.11); tone(784, 0.24, 'triangle', 0.18, 0.22); }
      else if (mine) { tone(392, 0.14, 'triangle', 0.13); tone(494, 0.18, 'triangle', 0.13, 0.1); }
      else { tone(300, 0.18, 'sine', 0.12); }
    },
    game(won) { if (won) { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, 'triangle', 0.15, i * 0.12)); } else { [392, 330, 262].forEach((f, i) => tone(f, 0.3, 'triangle', 0.13, i * 0.14)); } },
    whistle() { tone(2100, 0.12, 'square', 0.07, 0, 300); tone(2300, 0.14, 'square', 0.05, 0.08, -200); },
    beep(go) { tone(go ? 880 : 440, 0.12, 'square', 0.1); },
    // the keyboard count-in for an incoming shuttle: tick, tick, TOCK (the TOCK is the moment to
    // hit). `when`: seconds from now, so each beat lands on its moment, not on the frame
    count(last, when = 0) { tone(last ? 1175 : 587, last ? 0.09 : 0.05, 'sine', last ? 0.15 : 0.09, Math.max(0, when)); },
    rally(n) { tone(660 + Math.min(400, n * 12), 0.09, 'square', 0.08); },
    join() { tone(587, 0.1, 'triangle', 0.1); tone(880, 0.12, 'triangle', 0.1, 0.08); },
    toast() { tone(740, 0.08, 'sine', 0.08); },
  },
};
