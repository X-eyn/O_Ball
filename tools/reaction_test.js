'use strict';
// Office Badminton — reaction rigidity test. 30 shuttle cases (heights from the ankle to a jump
// smash, forehand / backhand / body / stretch / out of reach, in front and behind, smashes,
// drives, clears dropping vertically, net tumbles, drops, cross-courts, a shuttle on the tape, one
// sailing out; both player slots). Every flight is solved with the sim's own flight model. Each case
// drives one athlete of the real renderer in headless Chrome frame by frame (a synthetic snapshot
// row, the opponent's hit, the charge, the hit record the client would have, the ball along its
// path) through the renderer's own per-frame input builder, and measures what a human would do:
//   stroke   which stroke was chosen, against the one a player would use there
//   ik       racket sweet spot to the shuttle at the contact instant
//   joints   elbow hinge / swing, shoulder, wrist within the model's anatomical ranges
//   body     racket and forearm clear of the torso and head
//   gaze     head (and so the eyes) on the shuttle before contact, within what a neck turns
//   turn     side-on for an overhead; lunge / knee bend for low wide shuttles; feet off the floor in a jump
//   timing   the racket's peak speed at contact; the follow-through toward the target; face square
//   pops     per-bone angular velocity (the whip itself excepted)
//   no-hit   out of reach / leaving it: no swing at thin air, the head follows it
// Prints a PASS/FAIL table, writes one PNG per case (two views at the contact instant) plus contact
// sheets to <tmp>/office-badminton-reaction, and exits non-zero on any failure.
//   node tools/reaction_test.js [url] [--only name,name] [--strip name]
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const BM = require('../shared/badminton.js');

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const URL = args.find(a => /^https?:/.test(a)) || 'http://127.0.0.1:3000/badminton/r/RXTEST';
const ONLY = flag('--only') ? flag('--only').split(',') : null;
const STRIP = flag('--strip');
const PORT = 9336;
const OUT = path.join(os.tmpdir(), 'office-badminton-reaction');
const sleep = ms => new Promise(r => setTimeout(r, ms));
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

// ---------------------------------------------------------------- page side
// runs in the page: drives one athlete through a case and measures it
function pageHelper() {
  const R = window.__ob.R();
  const A = R.debugAthletes();
  const BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'clavL', 'armL', 'foreL', 'handL', 'clavR', 'armR', 'foreR', 'handR', 'thighL', 'shinL', 'footL', 'toeL', 'thighR', 'shinR', 'footR', 'toeR'];
  const BI = Object.fromEntries(BONES.map((n, i) => [n, i]));
  const V3 = A[0].root.position.constructor, Q4 = A[0].root.quaternion.constructor;
  const v = () => new V3(), q = () => new Q4();
  const gl = R._dbg().renderer.domElement;
  const deg = r => r * 180 / Math.PI;
  // a rig bone's rotation in the model's own anatomical frame (see human.js _limit)
  function refRot(h, name) { const r = h.ref[BI[name]][0]; const D = q().copy(r.C).multiply(r.bone.quaternion).multiply(r.Li).multiply(r.Ci).normalize(); if (D.w < 0) D.set(-D.x, -D.y, -D.z, -D.w); return D; }
  function hinge(D) { const l = Math.hypot(D.x, D.w), tw = l > 1e-8 ? q().set(D.x / l, 0, 0, D.w / l) : q(); const a = 2 * Math.atan2(tw.x, tw.w); const sw = D.clone().multiply(tw.invert()); return { a, swing: 2 * Math.acos(Math.min(1, Math.abs(sw.w))) }; }
  const total = D => 2 * Math.acos(Math.min(1, Math.abs(D.w)));
  function segSeg(p1, q1, p2, q2) { // closest distance between segments
    const d1 = v().subVectors(q1, p1), d2 = v().subVectors(q2, p2), r = v().subVectors(p1, p2);
    const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r); let s, t;
    const c = d1.dot(r), b = d1.dot(d2), den = a * e - b * b;
    s = den > 1e-9 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
    t = (b * s + f) / e;
    if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    return v().copy(p1).addScaledVector(d1, s).distanceTo(v().copy(p2).addScaledVector(d2, t));
  }
  function segPt(p1, q1, pt) { const d = v().subVectors(q1, p1), t = Math.min(1, Math.max(0, v().subVectors(pt, p1).dot(d) / d.lengthSq())); return v().copy(p1).addScaledVector(d, t).distanceTo(pt); }
  const W = (x, y, z) => new V3(x, z, y);
  let headAxis = null;
  const RT = window.__RT = {
    sheet: null,
    run(cs, opts) {
      const slot = cs.slot, ath = A[slot], h = ath.h, B = h.bone;
      const live = window.__ob.world();
      const base = live && live.players ? live.players[slot].slice() : new Array(21).fill(0);
      const cams = [];
      const out = { name: cs.name, frames: [], shots: {} };
      const prevQ = h.ref.map(rs => rs.map(r => r.bone.quaternion.clone()));
      let prevSweet = null, prevBall = null;
      const stripAt = opts && opts.strip ? opts.strip : null;
      for (let fi = 0; fi < cs.frames.length; fi++) {
        const fr = cs.frames[fi], rw = fr.row;
        const p = base.slice();
        p[0] = rw.x; p[1] = rw.y; p[2] = rw.vx; p[3] = rw.vy; p[4] = rw.fx; p[5] = rw.fy; p[6] = rw.ch; p[7] = 0; p[8] = 0; p[10] = 0; p[11] = 0; p[12] = 0; p[13] = 0;
        p[14] = rw.z; p[15] = rw.vz; p[16] = rw.squat; p[17] = rw.landT; p[19] = 0; p[20] = 0;
        const tick = 1000 + fr.k;
        const strokes = [null, null];
        if (cs.rec && fr.k >= cs.kc - 9) strokes[slot] = Object.assign({}, cs.rec, { tick: 1000 + cs.kc });
        if (fr.k >= 0) strokes[1 - slot] = Object.assign({}, cs.opp, { tick: 1000 });
        const rv = { tick, strokes, pred: fr.k >= 0 ? { land: { x: cs.inLand.x, y: cs.inLand.y, t: 1 } } : null, hitstop: false, pointAt: null };
        R.debugPose({ slot, manual: true, hideOther: true, ball: fr.ball, camPos: [0, 0, 0], camLook: [0, 0, 1] });
        const f = R.debugAthleteFrame(slot, p, fr.ball, rv, 1 / 60, tick * 1000 / 60);
        ath.update(f);
        h.root.updateMatrixWorld(true);
        // ---- measure
        const S = B.upperarm_r.getWorldPosition(v()), E = B.lowerarm_r.getWorldPosition(v()), Wr = B.hand_r.getWorldPosition(v());
        const sweet = ath.sweet(v()), head = B.Head.getWorldPosition(v()), neck = B.neck_01.getWorldPosition(v()), pelvis = B.pelvis.getWorldPosition(v());
        const SL = B.upperarm_l.getWorldPosition(v());
        const ball = W(fr.ball[0], fr.ball[1], fr.ball[2]);
        const yaw = ath.yaw;
        // gaze: calibrated head forward axis
        const hq = B.Head.getWorldQuaternion(q());
        if (!headAxis) {
          // the face's forward in the head bone's own frame: the model faces +z at the reference pose
          const r = h.ref[BI.head][0], M = r.C.clone().multiply(r.L);
          headAxis = new V3(0, 0, 1).applyQuaternion(M.invert()).toArray();
        }
        const hf = new V3(...headAxis).applyQuaternion(hq);
        const eye = head.clone().add(new V3(0, 0.1, 0)).addScaledVector(hf, 0.08);
        const toBall = v().subVectors(ball, eye);
        const gaze = deg(hf.angleTo(toBall));
        // how far the neck would need to turn (relative to the chest) to look at it
        const chestQ = B.spine_03.getWorldQuaternion(q());
        const chestFwd = new V3(...headAxis).applyQuaternion(chestQ); // approx: the same axis on the chest
        // joints
        const fore = hinge(refRot(h, 'foreR')), arm = total(refRot(h, 'armR')), hand = total(refRot(h, 'handR'));
        const foreL = hinge(refRot(h, 'foreL'));
        const knees = [hinge(refRot(h, 'shinL')).a, hinge(refRot(h, 'shinR')).a];
        // collisions: a torso capsule (pelvis -> neck), the head sphere
        const shaftDir = v().subVectors(sweet, Wr).normalize();
        const tip = sweet.clone().addScaledVector(shaftDir, 0.12);
        const dFore = segSeg(E, Wr, pelvis, neck), dRacket = segSeg(Wr, tip, pelvis, neck);
        const headC = head.clone().add(new V3(0, 0.09, 0));
        const dHead = Math.min(segPt(E, Wr, headC), segPt(Wr, tip, headC));
        const dHandTorso = segPt(pelvis, neck, Wr);
        // elbow hint geometry: where the elbow sits off the shoulder-hand line
        const sw = v().subVectors(Wr, S).normalize(), es = v().subVectors(E, S);
        const off = es.clone().addScaledVector(sw, -es.dot(sw));
        const bodyFwd = new V3(Math.sin(yaw), 0, Math.cos(yaw)), bodyRight = new V3(-Math.cos(yaw), 0, Math.sin(yaw));
        // shoulder line against the net: net-facing right is +z for slot 0, -z for slot 1
        const netRight = new V3(0, 0, slot ? -1 : 1), netFwd = new V3(slot ? -1 : 1, 0, 0);
        const shl = v().subVectors(S, SL); shl.y = 0; shl.normalize();
        const sideOn = deg(Math.atan2(-shl.dot(netFwd), shl.dot(netRight))); // + : the racket shoulder drawn back
        const feetZ = Math.min(B.ball_l.getWorldPosition(v()).y, B.ball_r.getWorldPosition(v()).y, B.foot_l.getWorldPosition(v()).y, B.foot_r.getWorldPosition(v()).y);
        // racket face: the strings' normal against the outgoing direction
        const rq = ath.racket.getWorldQuaternion(q()), nrm = new V3(0, 0, 1).applyQuaternion(rq);
        // angular velocity per bone (local)
        let wMax = 0, wBone = '', wMaxW = 0, wBoneW = '';
        h.ref.forEach((rs, i) => rs.forEach((r, j) => {
          const a = 2 * Math.acos(Math.min(1, Math.abs(prevQ[i][j].dot(r.bone.quaternion)))) * 60;
          prevQ[i][j].copy(r.bone.quaternion);
          const whip = /^(clavR|armR|foreR|handR)$/.test(BONES[i]);
          if (fi > 2) { if (whip) { if (a > wMaxW) { wMaxW = a; wBoneW = BONES[i]; } } else if (a > wMax) { wMax = a; wBone = BONES[i]; } }
        }));
        const sv = prevSweet ? v().subVectors(sweet, prevSweet).multiplyScalar(60) : v();
        prevSweet = sweet.clone();
        out.frames.push({
          u: +fr.u.toFixed(4), stroke: f.stroke ? f.stroke.name : null, ck: f.chargeKind, ch: rw.ch,
          ik: f.stroke && f.stroke.contact ? +sweet.distanceTo(f.stroke.contact).toFixed(4) : null,
          diag: fr.k === cs.kc ? ath.rtDiag : undefined, raw: ath.ikRawErr != null ? +ath.ikRawErr.toFixed(3) : null, rtErr: ath.rt && ath.rt.err != null ? +ath.rt.err.toFixed(3) : null,
          sweet: sweet.toArray().map(x => +x.toFixed(3)), sv: sv.toArray().map(x => +x.toFixed(2)), sp: +sv.length().toFixed(2),
          gaze: +gaze.toFixed(1), elbow: +fore.a.toFixed(3), elbowSw: +fore.swing.toFixed(3), arm: +arm.toFixed(3), hand: +hand.toFixed(3), elbowL: +foreL.a.toFixed(3),
          dFore: +dFore.toFixed(3), dRacket: +dRacket.toFixed(3), dHead: +dHead.toFixed(3), dHand: +dHandTorso.toFixed(3),
          elbowUp: +off.y.toFixed(3), elbowOut: +off.dot(bodyRight).toFixed(3), elbowFwd: +off.dot(bodyFwd).toFixed(3),
          sideOn: +sideOn.toFixed(1), pelvisY: +pelvis.y.toFixed(3), headY: +head.y.toFixed(3), feetZ: +feetZ.toFixed(3), knees: knees.map(x => +x.toFixed(2)),
          nrm: nrm.toArray().map(x => +x.toFixed(3)), wMax: +wMax.toFixed(1), wBone, wMaxW: +wMaxW.toFixed(1), wBoneW, clr: +(ath.h._clearA || 0).toFixed(2),
          ball: ball.toArray().map(x => +x.toFixed(3)), yaw: +yaw.toFixed(3), reachHoriz: +Math.hypot(ball.x - ath.root.position.x, ball.z - ath.root.position.z).toFixed(3),
        });
        // ---- pictures: two views at the contact instant (and a film strip on request)
        const snapAt = stripAt ? stripAt.includes(fr.k - cs.kc) : fr.k === cs.kc;
        if (snapAt || (cs.miss && fr.k === cs.kc)) {
          const r0 = ath.root.position, mid = new V3((r0.x + ball.x) / 2 * 0 + r0.x, Math.max(0.85, Math.min(1.9, (1.0 + ball.y) / 2)) + (rw.z || 0) * 0.5, r0.z);
          const views = [[2.1, 3.0, 1.5], [-3.6, -0.5, 1.4]];
          const shots = [];
          const cam = R._dbg().camera;
          for (const [sd, fw, hy] of views) {
            const c = new V3(r0.x, 0, r0.z).addScaledVector(bodyRight, sd).addScaledVector(bodyFwd, fw); c.y = hy + (rw.z || 0) * 0.6;
            R.debugPose({ slot, manual: true, hideOther: true, ball: fr.ball, camPos: c.toArray(), camLook: mid.toArray() });
            R.debugRender();
            cam.updateMatrixWorld(true);
            const pj = p3 => { const n = p3.clone().project(cam); return [(n.x + 1) / 2, (1 - n.y) / 2]; };
            shots.push({ img: gl.toDataURL('image/jpeg', 0.85), ball: pj(ball), sweet: pj(sweet) });
          }
          out.shots[fr.k - cs.kc] = shots;
        }
      }
      R.debugPose({ slot, manual: true, hideOther: true, ball: cs.frames[cs.frames.length - 1].ball, camPos: [0, 30, 0], camLook: [0, 0, 0] });
      return out;
    },
    // composite: rows of [label | view A | view B]
    async compose(rows, tileW, tileH) {
      const cv = document.createElement('canvas'); cv.width = tileW * 2; cv.height = tileH * rows.length;
      const g = cv.getContext('2d'); g.fillStyle = '#111'; g.fillRect(0, 0, cv.width, cv.height);
      for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < 2; c++) {
          const sh0 = rows[r].shots[c], img = new Image(); img.src = sh0.img;
          await img.decode();
          // the middle of the frame (the athlete), at the tile's aspect
          const sw = img.width * 0.8, sh = Math.min(img.height, sw * tileH / tileW), sx = (img.width - sw) / 2, sy = (img.height - sh) / 2;
          g.drawImage(img, sx, sy, sw, sh, c * tileW, r * tileH, tileW, tileH);
          const mk = (q, col, rad) => { if (!q) return; const X = c * tileW + (q[0] * img.width - sx) / sw * tileW, Y = r * tileH + (q[1] * img.height - sy) / sh * tileH; g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); g.arc(X, Y, rad, 0, Math.PI * 2); g.stroke(); };
          mk(sh0.ball, '#ff0', 9); mk(sh0.sweet, '#0ff', 5);
        }
        g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, r * tileH, tileW * 2, 22);
        g.fillStyle = rows[r].pass ? '#9f9' : '#f88'; g.font = '16px monospace'; g.fillText(rows[r].label, 6, r * tileH + 16);
      }
      return cv.toDataURL('image/png');
    },
  };
  return true;
}

// ---------------------------------------------------------------- evaluation
function evaluate(cs, m) {
  const F = m.frames, at = u => F.reduce((b, f) => Math.abs(f.u - u) < Math.abs(b.u - u) ? f : b, F[0]);
  const c = at(0), fails = [], info = {};
  const win = F.filter(f => f.u >= -0.6 && f.u <= 0.5);
  // pops: outside the whip window every bone; inside it the racket arm may whip
  // (the legs and feet belong to the footwork layer, footwork.js: reported, not failed here)
  const LEGB = /^(thigh|shin|foot|toe)/;
  const legMax = Math.max(0, ...win.filter(f => LEGB.test(f.wBone)).map(f => f.wMax)), legF = win.find(f => LEGB.test(f.wBone) && f.wMax === legMax);
  info.legPop = legF ? `${legMax.toFixed(0)} ${legF.wBone}@${legF.u.toFixed(2)}` : '-';
  const upW = win.filter(f => !LEGB.test(f.wBone));
  const popMax = Math.max(0, ...upW.map(f => f.wMax)), popF = upW.find(f => f.wMax === popMax);
  const whipMax = Math.max(...win.filter(f => Math.abs(f.u) > 0.12).map(f => f.wMaxW)), whipAll = Math.max(...win.map(f => f.wMaxW));
  info.pop = `${popMax.toFixed(0)}${popF ? ' ' + popF.wBone + '@' + popF.u.toFixed(2) : ''}`;
  info.whip = whipAll.toFixed(0);
  if (popMax > 30) fails.push(`pop ${info.pop} rad/s`);
  if (whipMax > 40) { const f = win.find(f => Math.abs(f.u) > 0.12 && f.wMaxW === whipMax); fails.push(`arm pop ${whipMax.toFixed(0)} ${f.wBoneW}@${f.u.toFixed(2)}`); }
  if (whipAll > 90) fails.push(`arm whip ${whipAll.toFixed(0)} rad/s`);
  // joints over the whole stroke
  const elbowMax = Math.max(...win.map(f => f.elbow)), elbowMin = Math.min(...win.map(f => f.elbow));
  const swMax = Math.max(...win.map(f => f.elbowSw)), armMax = Math.max(...win.map(f => f.arm));
  info.elbow = `${elbowMin.toFixed(2)}..${elbowMax.toFixed(2)}`;
  if (elbowMax > 0.12 || elbowMin < -2.62) fails.push(`elbow hinge ${info.elbow}`);
  if (swMax > 1.72) fails.push(`elbow swing ${swMax.toFixed(2)}`);
  if (armMax > 3.02) fails.push(`shoulder ${armMax.toFixed(2)}`);
  // body: forearm / racket through the torso or the head
  const dF = Math.min(...win.map(f => f.dFore)), dR = Math.min(...win.map(f => f.dRacket)), dH = Math.min(...win.map(f => f.dHead));
  info.clear = `${dF.toFixed(2)}/${dR.toFixed(2)}/${dH.toFixed(2)}`;
  if (dF < 0.1) fails.push(`forearm in torso ${dF.toFixed(2)}@${win.find(f => f.dFore === dF).u.toFixed(2)}`);
  if (dR < 0.08) fails.push(`racket in torso ${dR.toFixed(2)}@${win.find(f => f.dRacket === dR).u.toFixed(2)}`);
  if (dH < 0.1) fails.push(`racket/forearm in head ${dH.toFixed(2)}@${win.find(f => f.dHead === dH).u.toFixed(2)}`);
  if (cs.miss) {
    // no fake swing; the head follows the shuttle past
    const spMax = Math.max(...F.filter(f => f.u > -0.8).map(f => f.sp));
    info.stroke = F.some(f => f.stroke) ? 'SWUNG' : '-';
    info.sp = spMax.toFixed(1);
    if (F.some(f => f.stroke)) fails.push('stroke played at an unreachable shuttle');
    if (spMax > 6) fails.push(`racket swung ${spMax.toFixed(1)} m/s`);
    const g = at(-0.25).gaze, g0 = c.gaze;
    info.gaze = `${g.toFixed(0)}/${g0.toFixed(0)}`;
    if (g > 40) fails.push(`not watching it (${g.toFixed(0)} deg at -0.25 s)`);
    return { fails, info };
  }
  info.stroke = c.stroke;
  info.kind = cs.kind;
  if (!cs.expect.includes(c.stroke)) fails.push(`stroke ${c.stroke} (want ${cs.expect.join('/')})`);
  info.ik = c.ik != null ? (c.ik * 100).toFixed(1) : '-';
  if (!(c.ik < 0.05)) fails.push(`ik ${info.ik} cm`);
  // gaze before contact
  const g1 = at(-0.3).gaze, g2 = at(-0.12).gaze;
  info.gaze = `${g1.toFixed(0)}/${g2.toFixed(0)}`;
  if (g1 > 40 || g2 > 40) fails.push(`gaze ${info.gaze} deg`); // (the eyes cover the last 20-30 deg past the neck)
  // timing: the racket's peak speed at contact
  const sw = F.filter(f => f.u >= -0.2 && f.u <= 0.15), pk = sw.reduce((b, f) => f.sp > b.sp ? f : b, sw[0]);
  const cNext = at(1 / 60);
  const cSpeed = Math.max(c.sp, cNext.sp);
  info.peak = `${pk.sp.toFixed(0)}@${(pk.u * 1000).toFixed(0)}`;
  info.cSp = cSpeed.toFixed(1);
  const power = POWER.has(c.stroke);
  if (power && (cSpeed < 0.55 * pk.sp || (Math.abs(pk.u) > 0.05 && cSpeed < 0.8 * pk.sp))) fails.push(`peak ${info.peak}ms, at contact ${cSpeed.toFixed(1)}`);
  // follow-through: the racket head moving along the shot through the contact (its velocity from the
  // frame before to two after, against the shuttle's outgoing direction: forward-down for a smash,
  // forward-up for a lift)
  const f2 = at(2 / 60), f0 = at(-1 / 60);
  const mv = [f2.sweet[0] - f0.sweet[0], f2.sweet[1] - f0.sweet[1], f2.sweet[2] - f0.sweet[2]], mvl = Math.hypot(...mv) || 1;
  // (an overhead is always coming down after the top of its arc: judged by its forward travel)
  const od = cs.outDir, ovh = /^(over|smash|kill)$/.test(c.stroke);
  const fdot = ovh ? (mv[0] * od[0] + mv[2] * od[2]) / (Math.hypot(mv[0], mv[2]) || 1) / (Math.hypot(od[0], od[2]) || 1) : (mv[0] * od[0] + mv[1] * od[1] + mv[2] * od[2]) / mvl;
  info.follow = fdot.toFixed(2);
  if (power && fdot < 0.25) fails.push(`follow-through off the shot line (${fdot.toFixed(2)})`);
  // the racket face at contact against the outgoing line (either face)
  // (+z of the racket is the back of the hand: a forehand shows the palm's face, a backhand the other)
  const out = cs.outDir, sg = /^bh/.test(c.stroke) ? 1 : -1, nd = sg * (c.nrm[0] * out[0] + c.nrm[1] * out[1] + c.nrm[2] * out[2]);
  info.face = nd.toFixed(2);
  if (nd < 0.45) fails.push(`racket face ${nd.toFixed(2)} off the shot line`);
  // body turn: side-on for an overhead at the load
  if (c.stroke === 'over' || c.stroke === 'smash') {
    const load = Math.max(...F.filter(f => f.u >= -0.3 && f.u <= -0.08).map(f => f.sideOn));
    info.sideOn = load.toFixed(0);
    if (load < 30) fails.push(`not side-on at the load (${load.toFixed(0)} deg)`);
  }
  // low and wide: lunge / knees; jump: off the floor
  const reach = Math.hypot(cs.at[0], cs.at[1]);
  // (the bottom of the lunge around the contact: a player keeps sinking through the stroke)
  const stand = F[0].pelvisY, low = Math.min(...F.filter(f => f.u >= -0.05 && f.u <= 0.1).map(f => f.pelvisY)), dropM = stand - low;
  info.drop = dropM.toFixed(2);
  // (how far down the hips go matters less than that the racket gets there, checked by the IK error:
  // a low wide shuttle must still see a real lunge, and an ankle-high one the body folded down to it)
  if (cs.at[2] < 0.7 && reach > 0.85 && dropM < 0.1) fails.push(`no lunge (pelvis down ${dropM.toFixed(2)} m)`);
  if (cs.at[2] < 0.4 && dropM < 0.12) fails.push(`not down to an ankle-high shuttle (${dropM.toFixed(2)} m)`);
  if (cs.jump) { info.feet = c.feetZ.toFixed(2); if (c.feetZ < 0.3) fails.push(`feet ${c.feetZ.toFixed(2)} m: no jump`); }
  // elbow: never above the shoulder-hand line on a low underarm stroke
  // (a forehand one: on a backhand underarm the elbow properly leads, up and forward)
  // (reaching down and out from a lunge the elbow sits a little proud of the line; a chicken wing is more)
  if (/^(under|touch)$/.test(c.stroke) && c.elbowUp > 0.15) fails.push(`elbow up ${c.elbowUp} on an underarm`);
  return { fails, info };
}

// ---------------------------------------------------------------- CDP
function findBrowser() {
  for (const c of [process.env.CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) if (c && fs.existsSync(c)) return c;
  throw new Error('no Chrome/Edge found');
}
const httpJson = (method, p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 5000 }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 200))); } }); });
  req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end();
});
class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.logs = []; }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
      this.ws.on('open', resolve); this.ws.on('error', reject);
      this.ws.on('message', d => {
        const m = JSON.parse(d);
        if (m.id && this.pending.has(m.id)) { const [res, rej] = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); return; }
        if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) this.logs.push(m.params.type + ': ' + m.params.args.map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(' '));
        else if (m.method === 'Runtime.exceptionThrown') this.logs.push('uncaught: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
      });
    });
  }
  send(method, params) { return new Promise((resolve, reject) => { const id = ++this.id; this.pending.set(id, [resolve, reject]); this.ws.send(JSON.stringify({ id, method, params: params || {} })); }); }
  async ev(expression) {
    const r = await Promise.race([this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), sleep(60000).then(() => { throw new Error('page evaluate timed out: ' + expression.slice(0, 60)); })]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    return r.result.value;
  }
}
const saveData = (file, url) => fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // build the cases (node side: the sim's flight model)
  const t0 = Date.now();
  // the flights are solved once per case definition (and cached: the grid search takes a while)
  const cacheF = path.join(OUT, 'cases-cache.json');
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(cacheF, 'utf8')); } catch { }
  const key = c => JSON.stringify(c) + '|' + JSON.stringify(C) + build.toString().length;
  let cases = CASES.filter(c => !ONLY || ONLY.includes(c.name) || (STRIP && c.name === STRIP)).map(c => cache[key(c)] || (cache[key(c)] = build(c)));
  try { fs.writeFileSync(cacheF, JSON.stringify(cache)); } catch { }
  if (STRIP) cases = cases.filter(c => c.name === STRIP);
  for (const c of cases) {
    if (!c.miss) { const f = c.frames.find(f => f.k === c.kc + 3), g = c.frames.find(f => f.k === c.kc); const d = [f.ball[0] - g.ball[0], f.ball[2] - g.ball[2], f.ball[1] - g.ball[1]], l = Math.hypot(...d) || 1; c.outDir = d.map(x => x / l); }
  }
  console.log(`built ${cases.length} cases in ${Date.now() - t0} ms`);
  if (args.includes('--dry')) { for (const c of cases) console.log(c.name.padEnd(20), 'kind', c.kind, 'fit', c.fitErr, 'kc', c.kc, 'rec', JSON.stringify(c.rec), 'first', c.frames[c.frames.length - 1].ball.slice(0, 3)); return; }
  const exe = findBrowser();
  const profile = path.join(os.tmpdir(), 'obm-reaction-profile-' + process.pid);
  const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,760', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let cdp = null, failed = 0;
  try {
    let version = null;
    for (let i = 0; i < 80 && !version; i++) { try { version = await httpJson('GET', '/json/version'); } catch { await sleep(250); } }
    if (!version) throw new Error('browser never came up');
    let target; try { target = await httpJson('PUT', '/json/new?about:blank'); } catch { target = await httpJson('GET', '/json/new?about:blank'); }
    cdp = new CDP(target.webSocketDebuggerUrl); await cdp.open();
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('obm_name','ReactBot');}catch(e){}` });
    await cdp.send('Page.navigate', { url: URL });
    let ok = false;
    console.log('booting', URL);
    for (let i = 0; i < 200 && !ok; i++) {
      if (i % 20 === 19) console.log('  still booting', i / 2, 's', JSON.stringify(cdp.logs.slice(-3))); ok = await cdp.ev(`!!(window.__ob && window.__ob.R && window.__ob.R() && window.__ob.R().debugAthletes && window.__ob.world() && window.__ob.R().debugAthletes()[0].h.ready)`).catch(() => false); if (!ok) await sleep(500); }
    if (!ok) throw new Error('game never booted (or render3d lacks the debug hooks)');
    await sleep(1500);
    await cdp.ev(`(${pageHelper.toString()})()`);
    console.log('booted; running cases');
    if (flag('--eval')) console.log('eval:', JSON.stringify(await cdp.ev(flag('--eval'))));
    const rows = [];
    for (const cs of cases) {
      process.stdout.write(`  .. ${cs.name}
`);
      const m = await cdp.ev(`window.__RT.run(${JSON.stringify(cs)}, ${JSON.stringify(STRIP ? { strip: flag('--at') ? flag('--at').split(',').map(Number) : [-24, -15, -9, -5, -2, 0, 3, 8, 16] } : {})})`);
      if (STRIP) {
        const keys = Object.keys(m.shots).map(Number).sort((a, b) => a - b);
        const sheet = await cdp.ev(`window.__RT.compose(${JSON.stringify(keys.map(k => ({ label: `${cs.name} u=${(k / 60).toFixed(3)}`, shots: m.shots[k], pass: true })))}, 560, 330)`);
        saveData(path.join(OUT, `strip-${cs.name}.png`), sheet);
        fs.writeFileSync(path.join(OUT, `strip-${cs.name}.json`), JSON.stringify(m.frames, null, 0));
        console.log('strip written', path.join(OUT, `strip-${cs.name}.png`));
        continue;
      }
      const ev = evaluate(cs, m);
      const pass = ev.fails.length === 0;
      if (!pass) failed++;
      const shots = m.shots[0];
      rows.push({ cs, ev, pass, shots });
      fs.writeFileSync(path.join(OUT, `${cs.name}.json`), JSON.stringify(m.frames));
      if (shots) {
        const one = await cdp.ev(`window.__RT.compose(${JSON.stringify([{ label: cs.name, shots, pass }])}, 640, 380)`);
        saveData(path.join(OUT, `${cs.name}.png`), one);
      }
      const i = ev.info;
      console.log(`${pass ? 'PASS' : 'FAIL'} ${cs.name.padEnd(20)} ${String(i.stroke).padEnd(8)} kind ${String(i.kind || '-').padEnd(7)} ik ${String(i.ik || '-').padStart(5)}cm gaze ${String(i.gaze).padEnd(7)} peak ${String(i.peak || i.sp || '-').padEnd(8)} fol ${String(i.follow || '-').padEnd(5)} face ${String(i.face || '-').padEnd(4)} side ${String(i.sideOn || '-').padEnd(3)} drop ${String(i.drop || '-').padEnd(5)} elbow ${i.elbow} clr ${i.clear} pop ${i.pop} whip ${i.whip} legs ${i.legPop}${ev.fails.length ? '\n       -> ' + ev.fails.join('; ') : ''}`);
    }
    if (!STRIP) {
      for (let s = 0; s < rows.length; s += 5) {
        const part = rows.slice(s, s + 5).filter(r => r.shots);
        const sheet = await cdp.ev(`window.__RT.compose(${JSON.stringify(part.map(r => ({ label: `${r.cs.name}  ${r.ev.info.stroke}  ${r.pass ? 'PASS' : 'FAIL'}`, shots: r.shots, pass: r.pass })))}, 480, 285)`);
        saveData(path.join(OUT, `sheet-${s / 5 + 1}.png`), sheet);
      }
      console.log(`\n${rows.length - failed}/${rows.length} passed · pictures in ${OUT}`);
    }
    const errs = cdp.logs.filter(l => /uncaught|error/.test(l));
    if (errs.length) { console.log('PAGE ERRORS:'); errs.slice(0, 10).forEach(l => console.log('  ' + l)); failed++; }
  } catch (e) {
    console.error('REACTION TEST FAILED:', e.message); failed++;
  } finally {
    try { if (cdp) cdp.ws.close(); } catch { }
    try { proc.kill(); } catch { }
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } }, 1500);
  }
  process.exitCode = failed ? 1 : 0;
})();
