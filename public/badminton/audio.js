// Indoor badminton sound: decoded local recordings, restrained synthesis, bounded voices.
import { createVoicePool, courtPan, createFootContactTracker, createTakeSelector, shoeVoice } from './audio-voices.mjs';
import { presentationUrl } from './presentation-assets.js';

const MAX_VOICES = 24;
// Court-shoe takes by kind (tools/bake_badminton_steps.py): tap, step, scuff, squeak, squeal.
export const SHOE_KINDS = { tap: 8, step: 8, scuff: 6, squeak: 8, squeal: 6 };
const shoeName = (kind, i) => `court_${kind}${i}`;
const SHOE_NAMES = Object.entries(SHOE_KINDS).flatMap(([kind, n]) => Array.from({ length: n }, (_, i) => shoeName(kind, i)));
const MAX_FOOTSTEPS = 3, MAX_SQUEAKS = 2;
const voices = createVoicePool(MAX_VOICES), contacts = createFootContactTracker();
// each athlete draws from their own shuffled takes per kind, so no take repeats back to back
const takes = [0, 1].map(() => Object.fromEntries(Object.entries(SHOE_KINDS).map(([kind, n]) => [kind, createTakeSelector(n)])));
const buffers = new Map(), noise = new Map(), errors = [], playedSamples = {};
let ctx = null, master = null, roomSend = null, movementBus = null;
let muted = false, loading = false, camera = null, active = true, lastApplause = -10, lastHit = -10;
let listenerSlot = -1, lastStep = -10, held = false;
let swellBed = null; // the crowd's rising murmur under a long rally (Sound.swell)
const lastSqueak = [-10, -10];
let totalVoices = 0, stolenVoices = 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rememberError = message => { if (errors.length < 8) errors.push(String(message)); };

function noiseBuffer(seconds) {
  if (noise.has(seconds)) return noise.get(seconds);
  const size = Math.ceil(ctx.sampleRate * seconds), buffer = ctx.createBuffer(1, size, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
  noise.set(seconds, buffer);
  return buffer;
}

async function loadSamples() {
  loading = true;
  try {
    // A single content-addressed data bundle prevents media download managers intercepting effects.
    const response = await fetch(presentationUrl('audio-bank.json'), { cache: 'force-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bank = await response.json();
    if (bank.version !== 2) throw new Error('Unsupported audio bank');
    await Promise.all(['racket', 'applause', 'rustle', ...SHOE_NAMES].map(async name => {
      try {
        const asset = bank.samples[name];
        const bytes = Uint8Array.from(atob(asset.data), char => char.charCodeAt(0));
        if (bytes.length !== asset.bytes) throw new Error('Recording byte length mismatch');
        // Secure origins verify each take; LAN HTTP still uses the server's content-addressed bank.
        if (globalThis.crypto?.subtle) {
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          const hash = [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
          if (hash !== asset.sha256) throw new Error('Recording integrity mismatch');
        }
        const buffer = await ctx.decodeAudioData(bytes.buffer);
        buffers.set(name, buffer);
      } catch (error) { rememberError(`${name}: ${error.message}`); }
    }));
  } catch (error) { rememberError(`recordings: ${error.message}`); }
  finally { loading = false; }
}

function init() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = muted ? 0 : 0.72;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -17; compressor.knee.value = 14; compressor.ratio.value = 4;
    compressor.attack.value = 0.003; compressor.release.value = 0.16;
    master.connect(compressor).connect(ctx.destination);
    // One shared movement bus controls stacked feet without pumping the racket/contact mix.
    movementBus = ctx.createDynamicsCompressor();
    movementBus.threshold.value = -30; movementBus.knee.value = 10; movementBus.ratio.value = 3;
    movementBus.attack.value = 0.005; movementBus.release.value = 0.08;
    movementBus.connect(master);
    // Two quiet early reflections, shared by court voices. No per-hit impulse creation.
    roomSend = ctx.createGain(); roomSend.gain.value = 0.1;
    for (const [seconds, level] of [[0.037, 0.55], [0.073, 0.24]]) {
      const delay = ctx.createDelay(0.1), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
      delay.delayTime.value = seconds; filter.type = 'lowpass'; filter.frequency.value = 4100;
      gain.gain.value = level; roomSend.connect(delay).connect(filter).connect(gain).connect(master);
    }
    // Noise is prepared once; all transient sources share the same reusable buffer.
    noiseBuffer(0.5);
    // Decoding never holds up the first gesture or an impact; synthesis covers loading/failure.
    void loadSamples();
  } catch (error) { rememberError(`context: ${error.message}`); }
}

function resume() {
  init();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(error => rememberError(`resume: ${error.message}`));
}
for (const event of ['pointerdown', 'keydown', 'touchstart']) addEventListener(event, resume, { passive: true });

function available(court = false) { return !!ctx && ctx.state === 'running' && !muted && (!court || active); }

// Own every transient node. Natural endings, eviction and pause use the same idempotent cleanup.
function attach(source, gain, filters = [], e = null, tag = 'effect', reflect = false) {
  const nodes = [source, ...filters, gain];
  let out = gain;
  if (e && ctx.createStereoPanner) {
    const pan = ctx.createStereoPanner(); pan.pan.value = courtPan(e, camera);
    gain.connect(pan); nodes.push(pan); out = pan;
  }
  out.connect(tag === 'footstep' || tag === 'squeak' ? movementBus : master);
  if (reflect && roomSend) out.connect(roomSend);
  if (voices.size >= MAX_VOICES) stolenVoices++;
  const voice = voices.add(() => {
    source.onended = null;
    try { source.stop(); } catch { /* already ended or not yet started */ }
    for (const node of nodes) { try { node.disconnect(); } catch { /* disconnected */ } }
  }, tag);
  source.onended = () => voice.finish();
  totalVoices++;
  return voice;
}

function envelope(gain, amp, t, duration, attack = 0.002) {
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp), t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(attack + 0.002, duration));
}

function sample(name, { amp = 0.15, rate = 1, duration, e = null, tag = 'effect', reflect = true, attack = 0.002, delay = 0, lowpass = 0 } = {}) {
  if (!available(true) || !buffers.has(name)) return false;
  const source = ctx.createBufferSource(), gain = ctx.createGain();
  source.buffer = buffers.get(name); source.playbackRate.value = rate;
  const length = Math.min(duration || source.buffer.duration / rate, source.buffer.duration / rate);
  const t = ctx.currentTime + Math.max(0, delay);
  // Keep the recording's attack/body intact; only soften its edges and an early cut.
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(amp, t + Math.min(attack, length / 4));
  const fade = Math.min(length / 3, name === 'applause' ? 0.45 : 0.025);
  gain.gain.setValueAtTime(amp, t + length - fade);
  gain.gain.linearRampToValueAtTime(0, t + length);
  // distance: the far athlete's shoes lose their top end across the court
  const filters = [];
  if (lowpass) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lowpass; f.Q.value = 0.5; filters.push(f); source.connect(f).connect(gain); }
  else source.connect(gain);
  const voice = attach(source, gain, filters, e, tag, reflect);
  try { source.start(t); source.stop(t + length); playedSamples[name] = (playedSamples[name] || 0) + 1; }
  catch { voice.finish(); return false; }
  return true;
}

function tone(freq, duration, type = 'sine', amp = 0.06, when = 0, slide = 0, e = null, court = false) {
  if (!available(court)) return;
  const t = ctx.currentTime + Math.max(0, when), source = ctx.createOscillator(), gain = ctx.createGain();
  source.type = type; source.frequency.setValueAtTime(freq, t);
  if (slide) source.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + duration);
  envelope(gain, amp, t, duration, 0.006);
  source.connect(gain);
  const voice = attach(source, gain, [], e, 'effect', court);
  try { source.start(t); source.stop(t + duration + 0.01); } catch { voice.finish(); }
}

function air(duration, freq, amp, { e = null, when = 0, sweep = false, tag = 'effect', low = false } = {}) {
  if (!available(true)) return;
  const t = ctx.currentTime + Math.max(0, when), source = ctx.createBufferSource();
  source.buffer = noise.get(0.5);
  const filter = ctx.createBiquadFilter(), gain = ctx.createGain();
  filter.type = low ? 'lowpass' : 'bandpass'; filter.Q.value = 0.7;
  filter.frequency.setValueAtTime(freq, t);
  if (sweep) {
    filter.frequency.exponentialRampToValueAtTime(freq * 1.5, t + duration * 0.45);
    filter.frequency.exponentialRampToValueAtTime(freq * 0.5, t + duration);
  }
  envelope(gain, amp, t, duration, sweep ? duration * 0.25 : 0.002);
  source.connect(filter).connect(gain);
  const voice = attach(source, gain, [filter], e, tag, true);
  try { source.start(t); source.stop(t + duration + 0.008); } catch { voice.finish(); }
}

function impact(power, bright, e) {
  air(0.07 + 0.04 * power, bright ? 2300 : 1400, 0.08 + 0.16 * power, { e });
  tone(bright ? 165 : 125, 0.075, 'triangle', 0.03 + power * 0.04, 0, -60, e, true);
}
function thud(amp, e) {
  air(0.14, 360, amp, { low: true, e });
  tone(88, 0.11, 'sine', amp * 0.4, 0, -35, e, true);
}
function applause(big = false) {
  if (!available(true) || ctx.currentTime - lastApplause < 1.6) return;
  if (sample('applause', { amp: big ? 0.052 : 0.033, duration: big ? 3.8 : 2.4, reflect: false })) lastApplause = ctx.currentTime;
}

// One foot contact, voiced by what the movement was:
//   tap    slow footwork and split-steps: a soft rubber touch
//   step   running: a sole planting on the sprung mat
//   cut    a sharp change of direction: a scuff, often with a short squeak as the sole bites
//   lunge  the lunge plant or a hard stop: a heavy step and, usually, the long rubber squeal
//   land   a jump landing: the heaviest steps, pitched down
// Squeaks are accents (each athlete waits between them); the far athlete is quieter and duller.
function footstep(e, speed, slot, ownSlot, hard = false, move = null) {
  if (!available(true) || voices.count('footstep') >= MAX_FOOTSTEPS) return;
  const now = ctx.currentTime, voice = shoeVoice({ hard, speed, turn: move?.turn || 0, lunge: move?.lunge || 0, brake: move?.brake || 0 });
  // both athletes share one movement layer: ordinary steps never stack; accents always speak
  if (voice === 'tap' || voice === 'step') { if (now - lastStep < 0.13) return; }
  lastStep = now;
  const i = slot === 1 ? 1 : 0, pick = kind => shoeName(kind, takes[i][kind]());
  const far = ownSlot >= 0 && slot !== ownSlot;
  const perspective = far ? 0.45 : 1, lowpass = far ? 4200 : 0;
  const duck = now - lastHit < 0.12 ? 0.5 : 1;
  const pace = clamp(speed / 7, 0, 1), vary = () => 0.92 + Math.random() * 0.16;
  const level = perspective * duck;
  const base = { e, tag: 'footstep', lowpass, attack: 0.002 };
  const squeak = (kind, chance, amp, delay) => {
    if (now - lastSqueak[i] < (kind === 'squeal' ? 1.1 : 1.4) || Math.random() > chance || voices.count('squeak') >= MAX_SQUEAKS) return;
    lastSqueak[i] = now;
    sample(pick(kind), { ...base, tag: 'squeak', amp: amp * level * vary(), rate: 0.94 + Math.random() * 0.12, delay, reflect: true });
  };
  // Real, cached takes only: no synthetic hiss or hard-floor fallback while loading.
  if (voice === 'tap') sample(pick('tap'), { ...base, amp: 0.2 * level * vary(), rate: 0.96 + Math.random() * 0.08, reflect: false });
  else if (voice === 'step') sample(pick('step'), { ...base, amp: (0.13 + 0.07 * pace) * level * vary(), rate: 0.95 + 0.04 * pace + Math.random() * 0.04, reflect: false });
  else if (voice === 'cut') {
    sample(pick('scuff'), { ...base, amp: (0.16 + 0.05 * pace) * level * vary(), rate: 0.95 + Math.random() * 0.08, reflect: true });
    squeak('squeak', 0.6, 0.13, 0.015 + Math.random() * 0.03);
  } else if (voice === 'lunge') {
    sample(pick('step'), { ...base, amp: 0.21 * level * vary(), rate: 0.9 + Math.random() * 0.04, reflect: true });
    squeak('squeal', 0.8, 0.14, 0.02 + Math.random() * 0.04);
  } else {
    sample(pick('step'), { ...base, amp: 0.26 * level * vary(), rate: 0.8 + Math.random() * 0.05, reflect: true });
    sample(pick('tap'), { ...base, amp: 0.12 * level, rate: 0.85, delay: 0.012, reflect: false });
    squeak('squeak', 0.3, 0.1, 0.04);
  }
}
const onFootContact = (e, speed, slot, side, move) => footstep(e, speed, slot, listenerSlot, false, move);

export const Sound = {
  // the crowd under a long rally: a low murmur that rises and brightens with level (0..1), and
  // settles when the rally ends (the hype system's tempo drives it)
  swell(level = 0) {
    if (!ctx || !master) return;
    if (!swellBed) {
      if (!available() || level <= 0.01) return;
      const src = ctx.createBufferSource(); src.buffer = noiseBuffer(2); src.loop = true;
      const band = ctx.createBiquadFilter(); band.type = 'bandpass'; band.frequency.value = 420; band.Q.value = 0.9;
      const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 1400;
      const gain = ctx.createGain(); gain.gain.value = 0;
      src.connect(band).connect(low).connect(gain).connect(master); src.start();
      swellBed = { gain, band };
    }
    const t = ctx.currentTime, k = clamp(level, 0, 1);
    swellBed.gain.gain.setTargetAtTime(k * k * 0.05, t, k > 0.01 ? 0.6 : 0.35);
    swellBed.band.frequency.setTargetAtTime(420 + k * 380, t, 0.6);
  },
  resume,
  toggle() {
    muted = !muted;
    if (master) { master.gain.cancelScheduledValues(ctx.currentTime); master.gain.setTargetAtTime(muted ? 0 : 0.72, ctx.currentTime, 0.015); }
    if (muted) voices.clear();
    try { localStorage.setItem('obm_mute', muted ? '1' : ''); } catch { }
    return muted;
  },
  get muted() { return muted; },
  load() {
    try { muted = !!localStorage.getItem('obm_mute'); } catch { }
    if (master) master.gain.value = muted ? 0 : 0.72;
  },
  // Read the completed pose so each take follows the actual foot planting on the mat.
  // A lab (the heat lab's sound check) can hold the movement layer: the game's own per-frame
  // call then stands aside, as the renderer does for labCtx, instead of resetting the tracker.
  hold(on) { held = !!on; },
  frame({ dt = 0, players, athletes, mySlot = -1, movement = true, camera: view, live = false, paused = false, lab = false } = {}) {
    if (held && !lab) return;
    camera = view || null;
    listenerSlot = mySlot;
    const playing = !!live && !paused;
    if (!playing && active) voices.clear();
    active = playing;
    contacts.update(players, athletes, dt, movement && playing && available(true), onFootContact);
  },
  // audition one movement sound as the near athlete would make it (the lab's sound check)
  audition(kind, speed = 4) {
    resume(); active = true;
    const move = { lunge: kind === 'lunge' ? 1 : 0, turn: kind === 'cut' ? 1.6 : 0 };
    footstep({ x: 0, y: 0, z: 0 }, kind === 'tap' ? 0.8 : speed, 0, 0, kind === 'land', move);
  },
  debugStats() {
    return { context: ctx?.state || 'uninitialized', loading, decoded: Object.fromEntries([...buffers].map(([name, b]) => [name, { duration: b.duration, channels: b.numberOfChannels, sampleRate: b.sampleRate }])), activeVoices: voices.size, activeFootsteps: voices.count('footstep'), maxFootsteps: MAX_FOOTSTEPS, maxVoices: MAX_VOICES, totalVoices, stolenVoices, noiseBuffers: noise.size, playedSamples: { ...playedSamples }, errors: [...errors], muted, active };
  },
  fx: {
    hit(kind, kmh, perfect, e = {}) {
      if (!available(true)) return;
      lastHit = ctx.currentTime;
      const power = clamp((kmh || 40) / 230, 0.12, 1);
      const big = ['smash', 'jsmash', 'kill'].includes(kind), soft = ['drop', 'net', 'block', 'servel'].includes(kind);
      const rate = (soft ? 0.91 : big ? 1.1 : 1) + (Math.random() - 0.5) * 0.07;
      const amp = soft ? 0.12 + power * 0.08 : 0.16 + power * 0.2;
      if (!sample('racket', { amp, rate, e })) impact(soft ? power * 0.65 : power, big, e);
      else if (big) air(0.065, 2500, power * 0.045, { e });
      if (big && power > 0.45) tone(kind === 'jsmash' ? 75 : 100, 0.12, 'sine', power * 0.045, 0, -25, e, true);
      if (perfect) { tone(1047, 0.1, 'sine', 0.027, 0.005, 0, e, true); tone(1568, 0.12, 'sine', 0.014, 0.04, 0, e, true); }
      if (e.parry) { tone(784, 0.1, 'sine', 0.035, 0, 0, e, true); tone(1175, 0.13, 'sine', 0.022, 0.045, 0, e, true); }
    },
    jump() { /* Takeoff has no artificial wind sweep. */ },
    land(hard, velocity, e) {
      if (!hard) return;
      footstep(e, Math.min(7, (velocity || 3) * 1.2), e?.p, listenerSlot, true);
    },
    slam(kmh, e) { const p = clamp((kmh || 60) / 90, 0, 1); thud(0.08 + p * 0.06, e); },
    swing(e) { air(0.065, 1700, 0.032, { e, sweep: true }); },
    serve() { tone(440, 0.085, 'sine', 0.04); },
    net(e = {}) {
      if (!sample('rustle', { amp: 0.13, rate: 0.97 + Math.random() * 0.06, e })) air(0.16, 1150, 0.075, { e });
      tone(180, 0.06, 'sine', 0.024, 0, -55, e, true);
    },
    dive(e) { sample('rustle', { amp: 0.022, duration: 0.18, e, reflect: false }); },
    point(mine, won) {
      applause(won);
      if (won) [523, 659, 784].forEach((f, i) => tone(f, 0.18, 'sine', 0.065, i * 0.11));
      else if (mine) { tone(392, 0.13, 'sine', 0.055); tone(494, 0.17, 'sine', 0.05, 0.1); }
      else tone(300, 0.17, 'sine', 0.04);
    },
    game(won) { applause(won); (won ? [523, 659, 784, 1047] : [392, 330, 262]).forEach((f, i) => tone(f, 0.27, 'sine', 0.065, i * 0.12)); },
    whistle() { tone(2100, 0.12, 'sine', 0.045, 0, 180); tone(2300, 0.1, 'sine', 0.025, 0.08, -150); },
    beep(go) { tone(go ? 880 : 440, 0.12, 'sine', 0.065); },
    count(last, when = 0) { tone(last ? 1175 : 587, last ? 0.085 : 0.045, 'sine', last ? 0.095 : 0.055, Math.max(0, when)); },
    rally(n) { tone(660 + Math.min(400, n * 12), 0.08, 'sine', 0.035); },
    // the hype system: a Fire Shot leaving the racket, one overpowering a defender, the moment a
    // player is armed with one, and a hot player cooled by losing a point
    fire(e) {
      if (!available(true)) return;
      air(0.42, 900, 0.11, { e, sweep: true });
      tone(62, 0.38, 'sine', 0.1, 0, -18, e, true);
      tone(1319, 0.12, 'sine', 0.03, 0.03, 0, e, true); tone(1760, 0.14, 'sine', 0.02, 0.08, 0, e, true);
    },
    burned(e) {
      if (!available(true)) return;
      tone(118, 0.24, 'sine', 0.08, 0, -50, e, true);
      air(0.14, 2100, 0.05, { e });
    },
    armed(mine) {
      if (!available()) return;
      (mine ? [523, 659, 784, 1047] : [392, 494]).forEach((f, i) => tone(f, 0.11, 'sine', mine ? 0.05 : 0.03, i * 0.07));
    },
    cooled() {
      if (!available()) return;
      tone(880, 0.12, 'sine', 0.04); tone(587, 0.18, 'sine', 0.04, 0.09);
      air(0.25, 1400, 0.03, { sweep: true });
    },
    heat(tier) {
      if (!available(true) || !(tier > 0)) return;
      const level = clamp(tier, 1, 3);
      air(0.11 + level * 0.035, 800 + level * 250, 0.02 + level * 0.007, { sweep: true });
      tone(220 + level * 55, 0.15, 'sine', 0.03, 0, level * 40, null, true);
    },
    join() { tone(587, 0.1, 'sine', 0.05); tone(880, 0.12, 'sine', 0.045, 0.08); },
    toast() { tone(740, 0.075, 'sine', 0.045); },
  },
};
