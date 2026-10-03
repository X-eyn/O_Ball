// Small resource owner shared by sample and synthesized WebAudio sources.
export function createVoicePool(limit = 24) {
  const voices = new Set();
  return {
    get size() { return voices.size; },
    add(cleanup, tag = 'effect') {
      if (voices.size >= limit) voices.values().next().value.finish();
      let done = false;
      const voice = { tag, finish() {
        if (done) return;
        done = true; voices.delete(voice); cleanup();
      } };
      voices.add(voice);
      return voice;
    },
    clear() { for (const voice of [...voices]) voice.finish(); },
    count(tag) { let n = 0; for (const v of voices) if (v.tag === tag) n++; return n; },
  };
}

// Sim coordinates are x/depth/height; the Three camera is x/height/depth.
export function courtPan(e, camera) {
  if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y) || !camera?.pos || !camera?.target) return 0;
  const dx = camera.target[0] - camera.pos[0], dz = camera.target[2] - camera.pos[2];
  const len = Math.hypot(dx, dz);
  if (!(len > 0.001)) return 0;
  const offset = (e.x - camera.target[0]) * -dz / len + (e.y - camera.target[2]) * dx / len;
  return Math.max(-0.85, Math.min(0.85, offset / 8));
}

// Observe the renderer's feet after its pose update. No independent footstep clock.
// Not every plant is voiced: tiny shuffles stay silent and each athlete gets at most one step
// per minGap, so fast footwork reads as a rhythm instead of a constant patter. A plant that
// changes the movement (a lunge, a sharp cut) always speaks, sooner, and says what it was:
// step(at, speed, slot, side, { turn, lunge, brake }) - turn in radians against the recent heading,
// brake the speed (m/s) shed in about the last half second: a hard stop at a corner.
export function createFootContactTracker({ minGap = 0.26, minStride = 0.14, accentGap = 0.12 } = {}) {
  const states = [], sides = ['L', 'R'];
  return {
    update(players, athletes, dt, active, step) {
      if (!active || !(dt > 0) || dt > 0.25 || !players) { states.length = 0; return; }
      states.length = players.length;
      for (let i = 0; i < players.length; i++) {
        const p = players[i], fw = athletes?.[i]?.fw;
        if (!p || !fw?.feet || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) { states[i] = null; continue; }
        let s = states[i];
        if (!s) s = states[i] = { x: p[0], y: p[1], feet: {}, since: 1, hx: 0, hy: 0, turn: 0, vmax: 0 };
        const distance = Math.hypot(p[0] - s.x, p[1] - s.y);
        s.x = p[0]; s.y = p[1]; s.since = Math.min(1, s.since + dt);
        const vx = p[2] || 0, vy = p[3] || 0, speed = Math.hypot(vx, vy);
        // the recent heading (about a quarter second of memory) against which a cut is measured
        const turn = speed > 0.8 && Math.hypot(s.hx, s.hy) > 0.8 ? Math.acos(Math.max(-1, Math.min(1, (vx * s.hx + vy * s.hy) / (speed * Math.hypot(s.hx, s.hy))))) : 0;
        const k = 1 - Math.exp(-dt / 0.25); s.hx += (vx - s.hx) * k; s.hy += (vy - s.hy) * k;
        // the sharpest turn since the last voiced plant (fading over ~0.4 s): the foot that plants a
        // cut lands a few frames after the heading has already swung round
        s.turn = Math.max(turn, s.turn * Math.exp(-dt / 0.4));
        s.vmax = Math.max(speed, s.vmax * Math.exp(-dt / 0.5));
        const brake = s.vmax - speed;
        const lunge = athletes?.[i]?.lungeW || 0, accent = lunge > 0.45 || brake > 3.5 || (s.turn > 0.9 && speed > 2.2);
        const suppressed = fw.snap || distance > 1.6 || p[14] > 0.02 || p[8] > 0 || p[17] > 0 || p[20] > 0 || speed < 0.35;
        for (const side of sides) {
          const f = fw.feet[side], last = s.feet[side];
          if (!f || !Number.isFinite(f.x) || !Number.isFinite(f.z)) { delete s.feet[side]; continue; }
          const moved = last ? Math.hypot(f.x - last.x, f.z - last.z) : 0;
          if (!suppressed && last?.st === 'swing' && f.st === 'plant' && moved >= minStride && s.since >= (accent ? accentGap : minGap)) {
            step({ x: f.x, y: f.z, z: 0 }, speed, i, side, { turn: s.turn, lunge, brake }); s.since = 0; s.turn = 0; s.vmax = speed;
          }
          // Keep the last plant position through the swing to reject in-place pose jitters.
          if (!last) s.feet[side] = { st: f.st, x: f.x, z: f.z };
          else {
            last.st = f.st;
            if (f.st === 'plant') { last.x = f.x; last.z = f.z; }
          }
        }
      }
    },
  };
}

export function createTakeSelector(count, random = Math.random) {
  let last = -1;
  return () => {
    const choices = count - (last >= 0 ? 1 : 0);
    let take = Math.min(choices - 1, Math.floor(Math.max(0, random()) * choices));
    if (last >= 0 && take >= last) take++;
    last = take; return take;
  };
}

// Which sound a foot contact makes (audio.js plays it):
export function shoeVoice({ hard = false, speed = 0, turn = 0, lunge = 0, brake = 0 } = {}) {
  if (hard) return 'land';
  if (lunge > 0.45 || brake > 3.5) return 'lunge';
  if (turn > 0.9 && speed > 2.2) return 'cut';
  if (speed < 1.6) return 'tap';
  return 'step';
}
