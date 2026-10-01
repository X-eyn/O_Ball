// Office Badminton — the animation lab's cases, shared by the animation player (animplayer.js,
// /badminton/anim) and the headless checks (tools/motion_test.js, tools/reaction_test.js), so every
// case can be played back, scrubbed and inspected exactly as the checks run it.
//   MOTION_CASES   88 scripted movement cases (run by motionlab.js: the sim's player physics)
//   MOTION_SHOTS   the moments motion_test.js draws into contact sheets
//   strokeCases(BM) -> { CASES, build, POWER }: 30 shuttle cases (stroke, reach, defence, misses)
//                  and the builder that flies each one with the sim's own flight model
const D = Math.PI / 180;

// ---------------------------------------------------------------- the 88 cases
// dir: 0 = toward the net, 90 = the player's right (racket side), 180 = back, -90 = left.
// start: [distance from the net, right of centre]. Modes (footwork.js): ready step run sprint
// shuffle cross back lunge crouch jump land dive slide getup.
const FWD = ['step', 'run', 'sprint', 'cross'];
const ALL_GROUND = ['step', 'run', 'sprint', 'cross', 'shuffle', 'back', 'ready'];
function classOf(d) { const a = Math.abs(((d + 540) % 360) - 180); return a <= 30 ? 'fwd' : a < 62 ? 'diag' : a <= 118 ? 'lat' : a < 150 ? 'bdiag' : 'back'; }
function allowFor(d, speed) {
  const k = classOf(d);
  if (k === 'fwd') return FWD;
  if (k === 'diag') return [...FWD, 'shuffle'];
  if (k === 'lat') return speed === 'walk' ? ['shuffle'] : ['shuffle', 'cross', 'run', 'sprint'];
  return ['back'];
}
// body turn (theta, deg from the net, + to the right) a real player shows for this run
function thetaFor(d, speed) {
  const k = classOf(d), r = ((d + 540) % 360) - 180; // signed, + right
  if (k === 'back') return [40, 112];
  if (k === 'bdiag') return r > 0 ? [35, 112] : [-112, 112];
  if (k === 'lat') return speed === 'walk' ? (r > 0 ? [-5, 35] : [-35, 5]) : (r > 0 ? [0, 80] : [-80, 0]);
  if (k === 'fwd') return [-35, 35];
  return r > 0 ? [0, 70] : [-70, 0];
}
function startFor(d, len) { return [+(4.6 + len * 0.5 * Math.cos(d * D)).toFixed(2), +(-len * 0.5 * Math.sin(d * D)).toFixed(2)]; }
export const MOTION_CASES = [];
const dirs16 = Array.from({ length: 16 }, (_, i) => i * 22.5 - 180 + 22.5).map(d => +(((d + 540) % 360) - 180).toFixed(1));
// 1-16 run in 16 directions (slot 0)
for (const d of dirs16) MOTION_CASES.push({ name: `run ${d}`, slot: 0, start: startFor(d, 6), dur: 1.4, seq: [{ t0: 0, t1: 0.8, dir: d, mag: 1 }],
  expect: [{ t0: 0.3, t1: 0.8, allow: allowFor(d, 'run'), frac: 0.6 }, { t0: 0.35, t1: 0.8, theta: thetaFor(d, 'run'), frac: 0.7 }, { t0: 1.25, t1: 1.4, allow: ['ready', 'step', 'shuffle', 'back', 'cross'], frac: 0.8 }] });
// 17-32 walk in 16 directions (slot 1: the far side, mirrored)
for (const d of dirs16) MOTION_CASES.push({ name: `walk ${d} s1`, slot: 1, start: startFor(d, 3), dur: 1.7, seq: [{ t0: 0, t1: 1.2, dir: d, mag: 0.3 }],
  expect: [{ t0: 0.3, t1: 1.2, allow: allowFor(d, 'walk'), frac: 0.6 }, { t0: 0.35, t1: 1.2, theta: thetaFor(d, 'walk'), frac: 0.7 }] });
// 33-40 sprint (Shift) in 8 directions
for (let i = 0; i < 8; i++) { const d = i * 45 - 135; MOTION_CASES.push({ name: `sprint ${d}`, slot: i % 2, start: startFor(d, 6.5), dur: 1.3, seq: [{ t0: 0, t1: 0.7, dir: d, mag: 1, sp: 1 }],
  expect: [{ t0: 0.3, t1: 0.7, allow: allowFor(d, 'sprint'), frac: 0.6 }, { t0: 0.35, t1: 0.7, theta: thetaFor(d, 'sprint'), frac: 0.6 }] }); }
// 41-48 a single tap step in 8 directions
for (let i = 0; i < 8; i++) { const d = i * 45 - 180; MOTION_CASES.push({ name: `tap ${d}`, slot: (i + 1) % 2, start: [4.5, 0], dur: 1.0, seq: [{ t0: 0.05, t1: 0.13, dir: d, mag: 1 }],
  expect: [{ t0: 0.75, t1: 1.0, allow: ['ready'], frac: 0.9 }] }); }
// 49 standing still (with split steps as the opponent strikes), 50 running with a noisy stick
MOTION_CASES.push({ name: 'stand still + split steps', slot: 0, start: [4.5, 0], dur: 2, seq: [], split: [0.8, 1.5], expect: [{ t0: 0, t1: 2, allow: ['ready'], frac: 1 }, { t0: 0, t1: 2, theta: [-18, 18], frac: 1 }] });
MOTION_CASES.push({ name: 'noisy stick', slot: 0, start: [4.5, -2.5], dur: 1.2, seq: [{ t0: 0, t1: 0.8, dir: 90, mag: 0.8, noise: 70, noiseMag: 0.5 }], expect: [{ t0: 0.3, t1: 0.8, allow: ['shuffle', 'cross', 'step', 'run'], frac: 0.7 }] });
// 51-54 to each corner and back to base
for (const [nm, d, st] of [['corner net-fh', 45, [5, -1.5]], ['corner net-bh', -45, [5, 1.5]], ['corner rear-fh', 135, [3.2, -1.5]], ['corner rear-bh', -135, [3.2, 1.5]]])
  MOTION_CASES.push({ name: nm, slot: 0, start: st, dur: 2.0, seq: [{ t0: 0, t1: 0.6, dir: d, mag: 1 }, { t0: 0.75, t1: 1.35, dir: d + 180, mag: 1 }],
    expect: [{ t0: 0.25, t1: 0.6, allow: allowFor(d, 'run'), frac: 0.6 }, { t0: 1.0, t1: 1.35, allow: allowFor(d + 180, 'run'), frac: 0.5 }] });
// 55-56 circles
MOTION_CASES.push({ name: 'circle cw', slot: 0, start: [4.8, -1.6], dur: 2.6, seq: [{ t0: 0, t1: 2.4, dir: 0, mag: 0.6, spin: 150 }] });
MOTION_CASES.push({ name: 'circle ccw s1', slot: 1, start: [4.8, 1.6], dur: 2.6, seq: [{ t0: 0, t1: 2.4, dir: 0, mag: 0.6, spin: -150 }] });
// 57-58 zig-zags
MOTION_CASES.push({ name: 'zigzag lateral', slot: 0, start: [4.5, 0], dur: 2.2, seq: [{ t0: 0, t1: 2.0, dir: 90, mag: 1, flip: 21 }] });
MOTION_CASES.push({ name: 'zigzag diagonal', slot: 0, start: [7.5, 0], dur: 2.0, seq: [0, 1, 2, 3, 4, 5].map(i => ({ t0: i * 0.28, t1: (i + 1) * 0.28, dir: i % 2 ? -40 : 40, mag: 1 })) });
// 59-60 rapid direction flips (edge cases)
MOTION_CASES.push({ name: 'flip every 3 frames', slot: 0, start: [4.5, 0], dur: 1.6, seq: [{ t0: 0, t1: 1.4, dir: 90, mag: 1, flip: 3 }] });
MOTION_CASES.push({ name: 'random dir every frame', slot: 1, start: [4.5, 0], dur: 1.6, seq: [{ t0: 0, t1: 1.4, dir: 0, mag: 1, rand: 1 }] });
// 61-64 reversals, 65 start-stop
MOTION_CASES.push({ name: 'reverse fwd->back', slot: 0, start: [6.5, 0], dur: 1.8, seq: [{ t0: 0, t1: 0.5, dir: 0, mag: 1 }, { t0: 0.5, t1: 1.3, dir: 180, mag: 1 }], expect: [{ t0: 0.85, t1: 1.3, allow: ['back'], frac: 0.6 }] });
MOTION_CASES.push({ name: 'reverse back->fwd', slot: 1, start: [2.5, 0], dur: 1.8, seq: [{ t0: 0, t1: 0.6, dir: 180, mag: 1 }, { t0: 0.6, t1: 1.2, dir: 0, mag: 1 }], expect: [{ t0: 0.3, t1: 0.6, allow: ['back'], frac: 0.6 }] });
MOTION_CASES.push({ name: 'reverse left->right', slot: 0, start: [4.5, 1.5], dur: 1.8, seq: [{ t0: 0, t1: 0.45, dir: -90, mag: 1 }, { t0: 0.45, t1: 1.2, dir: 90, mag: 1 }] });
MOTION_CASES.push({ name: 'reverse diag rear-fh->net-bh', slot: 0, start: [4.0, 0], dur: 1.8, seq: [{ t0: 0, t1: 0.5, dir: 135, mag: 1 }, { t0: 0.5, t1: 1.1, dir: -45, mag: 1 }] });
MOTION_CASES.push({ name: 'start-stop x4', slot: 1, start: [4.5, -2.5], dur: 2.2, seq: [0, 1, 2, 3].map(i => ({ t0: i * 0.5, t1: i * 0.5 + 0.22, dir: 90, mag: 1 })) });
// 66-67 moving while charging a shot
MOTION_CASES.push({ name: 'charge fh on the move', slot: 0, start: [4.5, -2], dur: 1.4, chargeKind: 'fh', seq: [{ t0: 0, t1: 1.0, dir: 90, mag: 1, charge: 1 }] });
MOTION_CASES.push({ name: 'charge overhead going back', slot: 0, start: [2.8, 0], dur: 1.4, chargeKind: 'over', seq: [{ t0: 0, t1: 1.0, dir: 170, mag: 1, charge: 1 }], expect: [{ t0: 0.4, t1: 1.0, allow: ['back'], frac: 0.6 }] });
// 68-70 jumps
MOTION_CASES.push({ name: 'jump in place', slot: 0, start: [4.5, 0], dur: 1.5, ev: [{ t: 0.2, jump: 1 }], expect: [{ t0: 0.35, t1: 0.8, allow: ['jump'], frac: 0.8 }, { t0: 1.3, t1: 1.5, allow: ['ready'], frac: 0.9 }] });
MOTION_CASES.push({ name: 'jump moving back', slot: 1, start: [2.5, 0], dur: 1.8, seq: [{ t0: 0, t1: 1.3, dir: 180, mag: 1 }], ev: [{ t: 0.45, jump: 1 }] });
MOTION_CASES.push({ name: 'jump moving lateral', slot: 0, start: [4.5, -2.5], dur: 1.8, seq: [{ t0: 0, t1: 1.2, dir: 90, mag: 1 }], ev: [{ t: 0.35, jump: 1 }] });
// 71-78 dives in 8 directions and the get-up
for (let i = 0; i < 8; i++) {
  const d = i * 45 - 180;
  MOTION_CASES.push({ name: `dive ${d}`, slot: i % 2, start: startFor(d, 4.5), dur: 1.9, ball: 'near', seq: [{ t0: 0, t1: 0.3, dir: d, mag: 1 }], ev: [{ t: 0.28, dive: 1 }],
    expect: [{ t0: 0.32, t1: 0.55, allow: ['dive'], frac: 0.9 }, { t0: 0.7, t1: 0.85, allow: ['slide', 'getup'], frac: 0.9 }, { t0: 1.75, t1: 1.9, allow: ALL_GROUND, frac: 0.9 }] });
}
// 79-80 sprint then dive
MOTION_CASES.push({ name: 'sprint->dive fwd', slot: 0, start: [8, 0], dur: 2.0, ball: 'near', seq: [{ t0: 0, t1: 0.45, dir: 0, mag: 1, sp: 1 }], ev: [{ t: 0.42, dive: 1 }], expect: [{ t0: 0.46, t1: 0.7, allow: ['dive'], frac: 0.9 }] });
MOTION_CASES.push({ name: 'sprint->dive lateral', slot: 1, start: [4.5, -3.5], dur: 2.0, ball: 'near', seq: [{ t0: 0, t1: 0.45, dir: 90, mag: 1, sp: 1 }], ev: [{ t: 0.42, dive: 1 }], expect: [{ t0: 0.46, t1: 0.7, allow: ['dive'], frac: 0.9 }] });
// 81-82 dives into the boundary
MOTION_CASES.push({ name: 'dive at sideline', slot: 0, start: [4.5, 4.4], dur: 1.8, ball: 'near', seq: [{ t0: 0, t1: 0.2, dir: 90, mag: 1 }], ev: [{ t: 0.15, dive: 1 }] });
MOTION_CASES.push({ name: 'dive at back line', slot: 1, start: [9.6, 0], dur: 1.8, ball: 'near', seq: [{ t0: 0, t1: 0.2, dir: 180, mag: 1 }], ev: [{ t: 0.15, dive: 1 }] });
// 83-85 the far side (slot 1) mirrors
MOTION_CASES.push({ name: 'rear-fh run s1', slot: 1, start: [2.8, -1.5], dur: 1.4, seq: [{ t0: 0, t1: 0.7, dir: 135, mag: 1 }], expect: [{ t0: 0.3, t1: 0.7, allow: ['back'], frac: 0.6 }, { t0: 0.35, t1: 0.7, theta: [35, 112], frac: 0.7 }] });
MOTION_CASES.push({ name: 'shuffle left s1', slot: 1, start: [4.5, 2.2], dur: 1.4, seq: [{ t0: 0, t1: 0.9, dir: -90, mag: 0.45 }], expect: [{ t0: 0.3, t1: 0.9, allow: ['shuffle'], frac: 0.6 }] });
MOTION_CASES.push({ name: 'dive fwd-right s1', slot: 1, start: [5.5, -1], dur: 1.9, ball: 'near', seq: [{ t0: 0, t1: 0.3, dir: 45, mag: 1 }], ev: [{ t: 0.28, dive: 1 }] });
// 86-88 hit-stop, frame-time spikes, broken rows
MOTION_CASES.push({ name: 'hit-stop frozen frames', slot: 0, start: [4.5, -2], dur: 1.4, seq: [{ t0: 0, t1: 1.0, dir: 90, mag: 1 }], frozen: [[0.35, 0.5], [0.7, 0.72]] });
MOTION_CASES.push({ name: 'dt spikes', slot: 1, start: [4.8, -1.6], dur: 2.0, seq: [{ t0: 0, t1: 1.8, dir: 0, mag: 0.8, spin: 170 }], spikes: [[0.3, 0.5], [0.9, 1.2], [1.3, 0.25], [1.5, 0.0]] });
MOTION_CASES.push({ name: 'broken rows', slot: 0, start: [4.5, 0], dur: 1.6, seq: [{ t0: 0, t1: 1.2, dir: 120, mag: 0.8 }],
  corrupt: [{ t: 0, len: 1.6, v: 'short', n: 19 }, { t: 0.3, i: 2, v: 'nan' }, { t: 0.5, i: 0, v: 'undef' }, { t: 0.7, i: 14, v: 'inf' }, { t: 0.9, v: 'null' }, { t: 1.0, i: 20, v: 'nan', len: 0.2 }, { t: 1.1, i: 8, v: 'nan' }] });

// contact sheets: which cases, at which times
export const MOTION_SHOTS = {
  'run -180': [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95, 1.2],
  'run 90': [0.05, 0.2, 0.35, 0.5, 0.65, 0.8],
  'run -135': [0.05, 0.2, 0.35, 0.5, 0.65, 0.8],
  'run 22.5': [0.05, 0.2, 0.35, 0.5, 0.65, 0.8],
  'walk 90 s1': [0.1, 0.25, 0.4, 0.55, 0.7, 0.85],
  'walk -180 s1': [0.1, 0.3, 0.5, 0.7, 0.9, 1.1],
  'sprint 45': [0.05, 0.2, 0.35, 0.5, 0.65, 0.9],
  'dive 0': [0.28, 0.34, 0.42, 0.52, 0.62, 0.75, 0.95, 1.15, 1.3, 1.45, 1.6, 1.8],
  'dive 90': [0.28, 0.36, 0.46, 0.6, 0.8, 1.05, 1.3, 1.5, 1.7, 1.85],
  'dive -135': [0.28, 0.36, 0.46, 0.6, 0.8, 1.05, 1.3, 1.5, 1.7, 1.85],
  'corner rear-bh': [0.1, 0.3, 0.5, 0.8, 1.0, 1.2],
  'jump moving back': [0.3, 0.45, 0.55, 0.7, 0.85, 1.0],
};

// ---------------------------------------------------------------- the stroke cases
export function strokeCases(BM) {
  const C = BM.C, DT = 1 / 60;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // ---------------------------------------------------------------- flights (the sim's own model)
  function step(s) {
    const sp = Math.hypot(s.vx, s.vy, s.vz), dec = 1 / (1 + C.DRAG * sp * DT);
    s.vx *= dec; s.vy *= dec; s.vz = s.vz * dec - C.G * DT;
    const nx = s.x + s.vx * DT, ny = s.y + s.vy * DT, nz = s.z + s.vz * DT;
    let net = false;
    if ((s.x < 0) !== (nx < 0)) { const u = -s.x / (nx - s.x); if (s.z + (nz - s.z) * u < BM.netAt(s.y + (ny - s.y) * u)) net = true; }
    s.x = nx; s.y = ny; s.z = nz;
    return net;
  }
  // fly from `o` toward the ground point (tx, ty) at speed v, elevation a (deg): samples every frame
  // until the horizontal distance reaches D (or it lands / hits the net)
  function flight(o, tx, ty, v, a, D, maxT = 4) {
    const az = Math.atan2(ty - o.y, tx - o.x), r = a * Math.PI / 180;
    const s = { x: o.x, y: o.y, z: o.z, vx: Math.cos(r) * Math.cos(az) * v, vy: Math.cos(r) * Math.sin(az) * v, vz: Math.sin(r) * v };
    const pts = [[s.x, s.y, s.z, s.vx, s.vy, s.vz]];
    for (let t = 0; t < maxT; t += DT) {
      const net = step(s);
      pts.push([s.x, s.y, s.z, s.vx, s.vy, s.vz]);
      if (net) return { pts, net: true };
      if (D != null && Math.hypot(s.x - o.x, s.y - o.y) >= D) return { pts, reached: true };
      if (s.z <= 0) return { pts, landed: true };
    }
    return { pts };
  }
  // a flight from `o` through the point c (x, y, z) arriving at descent angle `desc` (deg below the
  // horizontal): a grid over launch speed and elevation, scored on height at c and arrival angle
  function solveThrough(o, c, desc, vmax) {
    const D = Math.hypot(c[0] - o.x, c[1] - o.y);
    let best = null;
    for (let v = 3; v <= vmax; v += 0.5) for (let a = -35; a <= 86; a += 0.5) {
      const f = flight(o, c[0], c[1], v, a, D);
      if (!f.reached) continue;
      const e = f.pts[f.pts.length - 1];
      const ang = Math.atan2(-e[5], Math.hypot(e[3], e[4])) * 180 / Math.PI;
      const err = Math.abs(e[2] - c[2]) * 100 + Math.abs(ang - desc) / 6;
      if (!best || err < best.err) best = { err, v, a, f };
    }
    return best;
  }
  // an outgoing shot from c landing at (tx, ty): bisect the speed at a fixed elevation
  function solveLanding(c, tx, ty, a0) {
    const o = { x: c[0], y: c[1], z: c[2] }, D = Math.hypot(tx - o.x, ty - o.y);
    for (let a = a0; a < 80; a += 2) {
      let lo = 2, hi = 90;
      for (let k = 0; k < 40; k++) {
        const m = (lo + hi) / 2, f = flight(o, tx, ty, m, a, null, 5), e = f.pts[f.pts.length - 1];
        if (f.net || Math.hypot(e[0] - o.x, e[1] - o.y) < D) lo = m; else hi = m;
      }
      const f = flight(o, tx, ty, hi, a, null, 5), e = f.pts[f.pts.length - 1];
      if (!f.net && Math.abs(Math.hypot(e[0] - o.x, e[1] - o.y) - D) < 0.3) return f.pts;
    }
    return flight(o, tx, ty, 30, 45, null, 5).pts;
  }

  // ---------------------------------------------------------------- the 30 cases
  // Frame: slot 0's side (x < 0, facing +x); a slot-1 case is mirrored (x, y -> -x, -y). `pos`: the
  // player. `at`: where the shuttle is met relative to the player facing the net — side (+ = racket
  // side), fwd (+ = toward the net), up (from the floor). `from`: the opponent's contact point,
  // `desc`: the incoming descent angle at contact, `in`: the incoming shot kind. `to`: the target on
  // the far court. ct / lob: the charge (ticks) and lift button the sim decides the shot kind with.
  // expect: strokes a player would use. miss: out of reach (no stroke).
  const H = C.W; // half court width
  const CASES = [
    { name: 'clear-fh-smash', pos: [-7.2, 0.6], at: [0.32, 0.25, 2.55], from: [3.2, -0.5, 1.2], desc: 72, in: 'clear', ct: 46, to: [4.5, -1], expect: ['smash'] },
    { name: 'clear-fh-clear', pos: [-7.4, -0.8], at: [0.3, 0.3, 2.45], from: [3.0, 1.5, 0.9], desc: 75, in: 'lift', ct: 30, lob: 1, to: [8, 1.5], expect: ['over'] },
    { name: 'clear-drop', pos: [-6.8, 1.2], at: [0.3, 0.2, 2.4], from: [6, 1, 1.0], desc: 65, in: 'clear', ct: 8, to: [2, 1.5], expect: ['over'] },
    { name: 'jump-smash', pos: [-6.0, 0.3], at: [0.3, 0.25, 3.15], from: [5.5, 0, 0.8], desc: 60, in: 'lift', ct: 46, jump: 1, to: [4, -2], expect: ['smash'] },
    { name: 'round-the-head', pos: [-7.0, -1.8], at: [-0.42, 0.1, 2.45], from: [3.2, 1.6, 1.0], desc: 70, in: 'clear', ct: 46, to: [4.5, 1.5], expect: ['smash', 'over'] },
    { name: 'bh-high-deep', pos: [-7.4, -2.2], at: [-0.75, -0.25, 2.05], from: [4.5, 1.2, 1.0], desc: 55, in: 'lift', ct: 30, lob: 1, to: [7.5, 2], expect: ['bhover', 'over'] },
    { name: 'overhead-behind', pos: [-6.8, 0.5], at: [0.25, -0.45, 2.45], from: [3.2, 0.5, 1.0], desc: 68, in: 'clear', ct: 30, lob: 1, to: [8, 0], expect: ['over'] },
    { name: 'fh-drive', pos: [-4.5, 0.9], at: [0.75, 0.2, 1.35], from: [4.5, -0.5, 1.4], desc: 6, in: 'drive', ct: 20, to: [6, -2], expect: ['fh'] },
    { name: 'bh-drive', pos: [-4.5, 0.4], at: [-0.72, 0.2, 1.3], from: [4.5, 0.5, 1.4], desc: 6, in: 'drive', ct: 20, to: [6, 2], expect: ['bh'] },
    { name: 'body-smash-chest', pos: [-5.0, 0.2], at: [0.05, 0.35, 1.2], from: [5.0, 0.3, 2.9], desc: 14, in: 'smash', ct: 6, to: [1.2, 0], expect: ['bhblock', 'bh', 'block'] },
    { name: 'body-smash-hip', pos: [-5.0, -0.4], at: [0.3, 0.3, 0.9], from: [5.2, -0.6, 2.9], desc: 16, in: 'smash', ct: 6, to: [1.2, 1], expect: ['block'] },
    { name: 'smash-bh-wide', pos: [-4.8, 0.3], at: [-1.15, 0.3, 0.6], from: [5.0, 1.2, 2.9], desc: 16, in: 'smash', ct: 6, to: [1.5, 1.5], expect: ['bhblock'] },
    { name: 'smash-fh-wide-lift', pos: [-4.8, -0.3], at: [1.2, 0.3, 0.55], from: [5.0, -1.5, 2.9], desc: 16, in: 'smash', ct: 20, lob: 1, to: [7.5, 0], expect: ['under'] },
    { name: 'net-fh-tumble', pos: [-1.6, 0.4], at: [0.5, 0.85, 0.35], from: [0.3, -0.1, 1.64], desc: 55, in: 'net', ct: 4, to: [0.9, 1], expect: ['touch'] },
    { name: 'net-bh-tumble', pos: [-1.6, 0.2], at: [-0.6, 0.85, 0.38], from: [0.3, 0.3, 1.64], desc: 55, in: 'net', ct: 4, to: [0.9, -1], expect: ['bhtouch'] },
    { name: 'drop-fh-lift', pos: [-3.2, 0.4], at: [0.8, 0.7, 0.5], from: [6.5, 0.8, 2.5], desc: 45, in: 'drop', ct: 25, lob: 1, to: [7.8, -1.5], expect: ['under'] },
    { name: 'drop-bh-lift', pos: [-3.2, -0.2], at: [-0.8, 0.7, 0.45], from: [6.5, -1.2, 2.5], desc: 45, in: 'drop', ct: 25, lob: 1, to: [7.8, 1.5], expect: ['bhunder'] },
    { name: 'ankle-fh', pos: [-3.8, 0.1], at: [0.9, 0.6, 0.15], from: [6.0, 0.5, 2.4], desc: 40, in: 'drop', ct: 25, lob: 1, to: [7.8, 0], expect: ['under'] },
    { name: 'ankle-bh', pos: [-3.8, 0.4], at: [-0.9, 0.6, 0.15], from: [6.0, -0.5, 2.4], desc: 40, in: 'drop', ct: 25, lob: 1, to: [7.8, 0], expect: ['bhunder'] },
    { name: 'stretch-fh-low', pos: [-4.2, -0.8], at: [1.3, 0.5, 0.8], from: [5.5, -2.5, 1.6], desc: 20, in: 'drive', ct: 25, lob: 1, to: [7.5, 1], expect: ['under'] },
    { name: 'stretch-bh-mid', pos: [-4.4, 0.8], at: [-1.35, 0.3, 1.2], from: [5.0, 2.4, 1.5], desc: 8, in: 'drive', ct: 20, to: [6, 0], expect: ['bh'] },
    { name: 'out-of-reach-fh', pos: [-4.5, -1.2], at: [2.3, 0.2, 1.0], from: [4.5, -2.8, 1.4], desc: 6, in: 'drive', miss: 1 },
    { name: 'over-the-top', pos: [-5.5, 0.2], at: [0.2, 0.0, 3.6], from: [5.5, 0.4, 1.0], desc: 35, in: 'lift', miss: 1 },
    { name: 'landing-out', pos: [-8.0, 1.0], at: [0.4, 0.2, 3.3], from: [5.0, 0.5, 0.9], desc: 50, in: 'lift', miss: 1 },
    { name: 'net-tape', pos: [-1.1, 0.3], at: [0.2, 0.9, 1.6], from: [1.2, 0.1, 1.2], desc: 30, in: 'net', ct: 6, to: [1.2, -1.5], expect: ['fh', 'touch'] },
    { name: 'net-kill', pos: [-1.0, -0.3], at: [0.35, 0.65, 2.05], from: [2.2, 0.2, 0.7], desc: 20, in: 'net', ct: 46, to: [2.5, 1.5], expect: ['kill'] },
    { name: 'cross-bh-drive', pos: [-4.6, -1.4], at: [-0.6, 0.3, 1.1], from: [5.0, 2.8, 1.3], desc: 6, in: 'drive', ct: 20, to: [6, -2.5], expect: ['bh'] },
    { name: 's1-clear-smash', slot: 1, pos: [-7.2, 0.6], at: [0.32, 0.25, 2.55], from: [3.2, -0.5, 1.2], desc: 72, in: 'clear', ct: 46, to: [4.5, -1], expect: ['smash'] },
    { name: 's1-drop-bh-lift', slot: 1, pos: [-3.2, -0.2], at: [-0.8, 0.7, 0.45], from: [6.5, -1.2, 2.5], desc: 45, in: 'drop', ct: 25, lob: 1, to: [7.8, 1.5], expect: ['bhunder'] },
    { name: 's1-fh-drive-run', slot: 1, pos: [-4.5, 0.9], at: [0.8, 0.25, 1.25], from: [4.5, -0.6, 1.35], desc: 6, in: 'drive', ct: 18, run: [0, 3.2], to: [6, 2], expect: ['fh'] },
  ];

  const OUT_ELEV = { smash: -12, jsmash: -14, kill: -25, drive: 4, clear: 40, lift: 50, drop: 12, net: 25, block: 20, counter: 2, servel: 20, serveh: 40 };
  const POWER = new Set(['over', 'smash', 'kill', 'fh', 'bh', 'under', 'bhunder', 'bhover']);

  function build(cs) {
    const slot = cs.slot || 0, m = slot ? -1 : 1; // mirror for slot 1 (a half turn: handedness kept)
    const W = (x, y) => [x * m, y * m];
    const [px0, py0] = cs.pos;
    // met relative to facing the net: side + is the racket side (+y for slot 0), fwd + toward the net (+x)
    const cx = px0 + cs.at[1], cy = py0 + cs.at[0], cz = cs.at[2];
    const o = { x: cs.from[0], y: cs.from[1], z: cs.from[2] };
    const sol = solveThrough(o, [cx, cy, cz], cs.desc, 60);
    if (!sol) throw new Error('no flight for ' + cs.name);
    let pts = sol.f.pts;
    const c = pts[pts.length - 1];
    // the player stands so the shuttle is exactly where the case says, relative to them
    const px = c[0] - cs.at[1], py = c[1] - cs.at[0];
    const kc = pts.length - 1; // the contact sample
    let post;
    if (cs.miss) post = flight({ x: c[0], y: c[1], z: c[2] }, c[0] + c[3], c[1] + c[4], Math.hypot(c[3], c[4], c[5]), Math.atan2(c[5], Math.hypot(c[3], c[4])) * 180 / Math.PI, null, 3).pts.slice(1);
    const pre = 72, tail = 40; // a long idle lead-in: nothing carries over from the case before
    // the player, the charge, the jump and the hit
    const ct = cs.ct != null ? cs.ct : -1;
    const jumpT0 = cs.jump ? kc - 20 : null; // takeoff 20 frames before contact: met near the apex
    const rowAt = k => {
      let x = px, y = py, vx = 0, vy = 0;
      if (cs.run) { const tt = Math.min(0, (k - kc + 6) * DT); x = px + cs.run[0] * tt; y = py + cs.run[1] * tt; if (k < kc - 6) { vx = cs.run[0]; vy = cs.run[1]; } }
      let z = 0, vz = 0, squat = 0, landT = 0;
      if (cs.jump) {
        const tau = (k - jumpT0) * DT;
        if (k >= jumpT0 - 4 && k < jumpT0) squat = jumpT0 - k;
        else if (k >= jumpT0) { z = C.JUMP_V * tau - C.PG * tau * tau / 2; vz = C.JUMP_V - C.PG * tau; if (z < 0) { const tl = 2 * C.JUMP_V / C.PG; landT = Math.max(0, C.LAND_SMASH_T - Math.round((tau - tl) * 60)); z = 0; vz = 0; } }
      }
      const aim = cs.to ? [cs.to[0] - x, cs.to[1] - y] : [1, 0], al = Math.hypot(...aim);
      const charging = !cs.miss && ct >= 0 && k < kc && k >= kc - ct;
      return { x, y, vx, vy, fx: aim[0] / al, fy: aim[1] / al, ch: charging ? k - (kc - ct) : -1, z: +z.toFixed(3), vz: +vz.toFixed(3), squat, landT };
    };
    const pz = cs.jump ? rowAt(kc).z : 0;
    let kind = null;
    if (!cs.miss) {
      const r = rowAt(kc);
      const s = { phase: 'rally', lastHitter: 1, lastKind: cs.in, ball: { x: c[0], y: c[1], z: c[2], vx: c[3], vy: c[4], vz: c[5] }, players: [] };
      kind = BM.shotKind(s, { i: 0, x: r.x, y: r.y, z: pz, vz: r.vz }, ct < 0 ? 10 : ct, !!cs.lob);
      const outs = solveLanding([c[0], c[1], c[2]], cs.to[0], cs.to[1], OUT_ELEV[kind] != null ? OUT_ELEV[kind] : 10);
      post = outs.slice(1);
    }
    const frames = [];
    const launchTick = 0;
    for (let k = -pre; k <= kc + tail; k++) {
      const b = k < 0 ? [o.x, o.y, o.z, 0, 0, 0] : k <= kc ? pts[k] : post[Math.min(post.length - 1, k - kc - 1)] || pts[kc];
      const r = rowAt(k);
      const X = (bx, by) => W(bx, by);
      const [bx, by] = X(b[0], b[1]), [bvx, bvy] = X(b[3], b[4]);
      const [rx, ry] = X(r.x, r.y), [rvx, rvy] = X(r.vx, r.vy), [rfx, rfy] = X(r.fx, r.fy);
      frames.push({ k, u: (k - kc) * DT, ball: [bx, by, b[2], bvx, bvy, b[5]].map(v => +v.toFixed(4)),
        row: { x: rx, y: ry, vx: rvx, vy: rvy, fx: rfx, fy: rfy, ch: r.ch, z: r.z, vz: r.vz, squat: r.squat, landT: r.landT } });
    }
    const [ccx, ccy] = W(c[0], c[1]), [ox, oy] = W(o.x, o.y), [tx, ty] = cs.to ? W(cs.to[0], cs.to[1]) : [0, 0];
    const cz2 = c[2]; // at[2] is the height above the floor (a jumper meets it that much nearer the feet)
    return {
      name: cs.name, slot, frames, kc, kind, miss: !!cs.miss, jump: !!cs.jump, expect: cs.expect || [],
      rec: cs.miss ? null : { tick: kc, kind, x: +ccx.toFixed(4), y: +ccy.toFixed(4), z: +cz2.toFixed(4), pz, air: pz > 0.02 ? 1 : 0 },
      opp: { tick: launchTick, kind: cs.in, x: ox, y: oy, z: o.z, pz: 0, air: 0 },
      target: [tx, ty], at: cs.at, fitErr: +sol.err.toFixed(3), land: post ? { x: post[post.length - 1][0] * m, y: post[post.length - 1][1] * m } : null,
      inLand: (() => { const f = flight({ x: c[0], y: c[1], z: c[2] }, c[0] + c[3], c[1] + c[4], Math.hypot(c[3], c[4], c[5]), Math.atan2(c[5], Math.hypot(c[3], c[4])) * 180 / Math.PI, null, 3).pts; const e = f[f.length - 1]; const [lx, ly] = W(e[0], e[1]); return { x: lx, y: ly, t: (kc + f.length) * DT }; })(),
    };
  }
  return { CASES, build, POWER };
}
