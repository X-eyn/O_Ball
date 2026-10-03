// Office Badminton — the athletes. Each player is the shared rigged character (human.js: GLB body,
// mocap locomotion, joint limits, ground contact, temporal filter) driven by a badminton layer:
//
//   stance   ready position, split-step when the opponent strikes, head and eyes on the shuttle
//   swings   a library of strokes (overhead, jump smash, forehand, backhand, underarm, block,
//            kill), each keyed LOAD -> CONTACT -> FOLLOW -> READY and played as a kinetic chain:
//            hips lead, then trunk, shoulder, elbow, wrist, so the racket arrives last and fastest
//   timing   contact lands on the server's hit tick: the snapshot buffer shows a hit a few frames
//            before it is drawn, and the stroke is scheduled backwards from it
//   reach    a two-bone IK solve on the racket arm at contact puts the strings on the shuttle
//   legs     crouch, takeoff, tuck, scissor kick on a jump smash, landing absorb, lunges on low
//            wide shots, dives; the mocap owns the legs whenever none of these does
//
// Pose conventions (human.js): +x on an arm swings it back, -x forward; on the right arm -z lifts
// it out to the side (+z on the left); -x on a forearm bends the elbow; +x on a shin bends the knee,
// -x on a thigh lifts it forward; +x on a foot points the toes; spine/chest +x bend forward, and a
// -y yaw on the trunk draws the right shoulder back.
import * as THREE from 'three';
import { Human, Pose, MODEL_HEIGHT, boneIndex } from '../human.js';
import { Footwork, diveBody, diveWeight, DIVE_TIME } from './footwork.js';
import { BadmintonApparel } from './apparel.js';
import { samplePointCelebration, setGripSpin } from './celebration.mjs';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const easeIn = t => t * t, easeOut = t => 1 - (1 - t) * (1 - t);
const bump = (u, w) => { const x = clamp(1 - Math.abs(u) / w, 0, 1); return x * x * (3 - 2 * x); };

const UPPER = ['hips', 'spine', 'chest', 'neck', 'head', 'clavR', 'armR', 'foreR', 'handR', 'clavL', 'armL', 'foreL', 'handL'];
const LEGS = ['thighL', 'shinL', 'footL', 'toeL', 'thighR', 'shinR', 'footR', 'toeR'];
const ARM_R_I = ['clavR', 'armR', 'foreR', 'handR'].map(boneIndex);
const TRUNK_I = ['hips', 'spine', 'chest'].map(boneIndex);
const UPPER_I = UPPER.map(boneIndex), LEG_I = LEGS.map(boneIndex), ALL_I = [...UPPER_I, ...LEG_I];
const CELEBRATION_I = ['chest', 'neck', 'armR', 'foreR', 'handR', 'armL', 'foreL', 'handL'].map(boneIndex);
// the kinetic chain: how far ahead of the racket each segment runs through the stroke (seconds)
const LEAD = { hips: 0.05, spine: 0.036, chest: 0.024, neck: 0.02, head: 0.02, clavR: 0.012, armR: 0.006, foreR: 0, handR: -0.012, clavL: 0.03, armL: 0.03, foreL: 0.03, handL: 0.03 };

// ---------------------------------------------------------------- the stroke library
// Each stroke: LOAD (racket drawn back, what a full charge holds), CONTACT, FOLLOW, plus timings:
// fwd = seconds from LOAD to contact (the forward swing), fol = contact to follow-through.
// Only the bones a stroke names are driven by it; the stance fills the rest.
const P = o => o;
export const STROKES = {
  // overhead forehand: side-on, elbow high, racket dropped behind the back, the free arm up at the
  // shuttle; then the trunk uncoils, the arm extends to full reach and pronates through it
  // LOAD is the trophy position: side-on, the upper arm out near shoulder height with the elbow
  // bent and the racket dropped down the back, the free arm up at the shuttle, the trunk arched a
  // little away. CONTACT at full stretch above and slightly in front. FOLLOW: the racket carried on
  // down across the body to the left hip as the hips and chest turn right through to face the net
  // and past it, the free arm tucked in.
  over: {
    fwd: 0.11, fol: 0.3,
    load: P({ hips: [0.02, -0.34, 0], spine: [-0.1, -0.14, 0], chest: [-0.22, -0.22, 0.06], neck: [-0.28, 0.2, 0], head: [-0.3, 0.1, 0],
      clavR: [-0.2, 0, -0.35], armR: [0.35, 0.9, -2.05], foreR: [-2.05, 0, 0], handR: [0.55, 0, 0.2],
      clavL: [-0.1, 0, 0.15], armL: [-2.3, 0, 0.35], foreL: [-0.2, 0, 0], handL: [0, 0, 0] }),
    contact: P({ hips: [0.04, 0, 0], spine: [0.04, 0, 0], chest: [0.04, 0.02, -0.06], neck: [-0.25, -0.1, 0], head: [-0.28, 0, 0],
      clavR: [-0.25, 0, -0.3], armR: [-0.65, 0.45, -2.5], foreR: [-0.12, 0, 0], handR: [-0.2, 0, -0.1],
      clavL: [0, 0, 0.1], armL: [-0.6, 0, 0.3], foreL: [-1.7, 0, 0], handL: [0, 0, 0] }),
    follow: P({ hips: [0.12, 0.45, 0], spine: [0.25, 0.2, 0], chest: [0.3, 0.35, -0.05], neck: [0.05, -0.3, 0], head: [0, -0.1, 0],
      clavR: [0.05, 0, 0.05], armR: [-0.75, 0.5, 0.15], foreR: [-0.5, 0, 0], handR: [-0.6, 0, -0.3],
      clavL: [0, 0, 0.05], armL: [0.35, 0, 0.35], foreL: [-1.3, 0, 0], handL: [0, 0, 0] }),
  },
  // the smash: the same stroke, arched harder, uncoiled harder, and folded right through
  smash: {
    fwd: 0.1, fol: 0.2,
    extend: { load: { chest: [0.08, -0.02, 0], spine: [0.04, 0, 0] }, follow: { chest: [0.18, 0.02, 0], spine: [0.12, 0, 0], armR: [0.25, 0.2, 0.2], hips: [0.06, 0, 0] } },
  },
  // the net kill: a short, sharp overhead tap with the wrist doing the work
  kill: {
    fwd: 0.07, fol: 0.18,
    load: P({ chest: [-0.05, -0.12, 0], spine: [0.05, -0.05, 0], neck: [-0.15, 0, 0], head: [-0.12, 0, 0], clavR: [-0.2, 0, -0.25],
      armR: [-0.1, -0.2, -2.3], foreR: [-1.35, 0, 0], handR: [0.7, 0, 0], armL: [-1.0, 0, 0.6], foreL: [-0.6, 0, 0] }),
    contact: P({ chest: [0.12, 0.08, 0], spine: [0.1, 0.03, 0], clavR: [-0.2, 0, -0.25], armR: [-0.55, 0.2, -2.4], foreR: [-0.2, 0, 0], handR: [-0.55, 0, 0], armL: [-0.6, 0, 0.4], foreL: [-1.3, 0, 0] }),
    follow: P({ chest: [0.26, 0.12, 0], spine: [0.16, 0.05, 0], clavR: [-0.05, 0, -0.1], armR: [-1.3, 0.4, -1.3], foreR: [-0.5, 0, 0], handR: [-0.9, 0, 0], armL: [-0.3, 0, 0.35], foreL: [-1.2, 0, 0] }),
  },
  // forehand drive: shoulder height on the racket side, racket laid back, a flat whip through
  fh: {
    fwd: 0.1, fol: 0.18,
    load: P({ hips: [0, -0.3, 0], spine: [0.05, -0.12, 0], chest: [0.02, -0.22, 0], clavR: [-0.1, 0, -0.17], armR: [0.45, -0.85, -1.3], foreR: [-1.6, 0, 0], handR: [0.7, 0, 0.28], armL: [-1.0, 0, 0.75], foreL: [-0.8, 0, 0] }),
    contact: P({ hips: [0.02, 0.1, 0], spine: [0.06, 0.06, 0], chest: [0.05, 0.14, 0], clavR: [-0.1, 0, -0.15], armR: [-0.85, 0.05, -1.3], foreR: [-0.2, 0, 0], handR: [-0.1, 0, 0], armL: [-0.4, 0, 0.5], foreL: [-1.2, 0, 0] }),
    follow: P({ hips: [0, 0.3, 0], spine: [0.08, 0.14, 0], chest: [0.08, 0.24, 0], clavR: [0, 0, -0.1], armR: [-1.7, 0.3, -1.2], foreR: [-0.6, 0, 0], handR: [-0.5, 0, 0], armL: [-0.1, 0, 0.35], foreL: [-1.1, 0, 0] }),
  },
  // backhand: the racket taken across the chest to the far shoulder, the back half-turned to the
  // net, then the elbow leads and the forearm snaps out
  bh: {
    fwd: 0.085, fol: 0.14,
    load: P({ hips: [0, 0.34, 0], spine: [0.08, 0.14, 0], chest: [0.06, 0.24, 0], neck: [0, -0.3, 0], head: [0, -0.3, 0], clavR: [-0.1, 0, 0.1], armR: [-0.6, 0.9, 0.6], foreR: [-1.1, 0, 0], handR: [0.7, 0, 0.4], armL: [0.1, 0, 0.35], foreL: [-0.4, 0, 0] }),
    contact: P({ hips: [0, 0.1, 0], spine: [0.06, 0.04, 0], chest: [0.04, 0.02, 0], clavR: [-0.15, 0, -0.1], armR: [-1.35, -0.15, -0.75], foreR: [-0.2, 0, 0], handR: [0.35, 0, 0], armL: [0.2, 0, 0.35], foreL: [-0.3, 0, 0] }),
    follow: P({ hips: [0, -0.05, 0], spine: [0.04, -0.06, 0], chest: [0.02, -0.14, 0], clavR: [-0.15, 0, -0.15], armR: [-1.25, -0.35, -0.95], foreR: [-0.4, 0, 0], handR: [0.35, 0, 0], armL: [0.3, 0, 0.3], foreL: [-0.3, 0, 0] }),
  },
  // underarm (lift, clear from low, net shot): racket low behind, the body folded over the lunge
  under: {
    fwd: 0.11, fol: 0.24,
    load: P({ hips: [0.12, -0.18, 0], spine: [0.28, -0.08, 0], chest: [0.18, -0.12, 0], neck: [-0.2, 0, 0], clavR: [0, 0, -0.1], armR: [0.25, -0.3, -0.55], foreR: [-1.15, 0, 0], handR: [0.75, 0, 0], armL: [0.55, 0, 0.55], foreL: [-0.5, 0, 0] }),
    contact: P({ hips: [0.12, 0.05, 0], spine: [0.28, 0.02, 0], chest: [0.16, 0.04, 0], neck: [-0.15, 0, 0], clavR: [0, 0, -0.1], armR: [-0.85, 0.1, -0.35], foreR: [-0.15, 0, 0], handR: [-0.3, 0, 0], armL: [0.6, 0, 0.6], foreL: [-0.4, 0, 0] }),
    follow: P({ hips: [0.06, 0.1, 0], spine: [0.12, 0.05, 0], chest: [0.02, 0.08, 0], neck: [-0.25, 0, 0], clavR: [-0.1, 0, -0.15], armR: [-2.1, 0.3, -0.5], foreR: [-0.5, 0, 0], handR: [-0.5, 0, 0], armL: [0.4, 0, 0.5], foreL: [-0.5, 0, 0] }),
  },
  // a soft net touch: the underarm stroke with almost no swing, the racket face held out in front
  touch: {
    fwd: 0.07, fol: 0.12,
    load: P({ spine: [0.26, -0.04, 0], chest: [0.12, -0.06, 0], neck: [-0.15, 0, 0], armR: [-0.7, -0.1, -0.45], foreR: [-0.7, 0, 0], handR: [0.25, 0, 0], armL: [0.55, 0, 0.55], foreL: [-0.5, 0, 0] }),
    contact: P({ spine: [0.26, 0, 0], chest: [0.12, 0, 0], neck: [-0.15, 0, 0], armR: [-1.0, 0.05, -0.4], foreR: [-0.3, 0, 0], handR: [-0.1, 0, 0], armL: [0.55, 0, 0.55], foreL: [-0.5, 0, 0] }),
    follow: P({ spine: [0.22, 0, 0], chest: [0.1, 0, 0], neck: [-0.2, 0, 0], armR: [-1.15, 0.05, -0.4], foreR: [-0.35, 0, 0], handR: [-0.15, 0, 0], armL: [0.5, 0, 0.5], foreL: [-0.5, 0, 0] }),
  },
  // the block: compact, firm, the racket face presented in front of the body
  block: {
    fwd: 0.05, fol: 0.1,
    load: P({ spine: [0.2, 0, 0], chest: [0.08, 0, 0], armR: [-0.9, -0.2, -0.55], foreR: [-1.25, 0, 0], handR: [0.2, 0, 0], armL: [-0.3, 0, 0.5], foreL: [-1.0, 0, 0] }),
    contact: P({ spine: [0.2, 0, 0], chest: [0.08, 0, 0], armR: [-1.05, 0, -0.5], foreR: [-0.75, 0, 0], handR: [0, 0, 0], armL: [-0.3, 0, 0.5], foreL: [-1.0, 0, 0] }),
    follow: P({ spine: [0.18, 0, 0], chest: [0.06, 0, 0], armR: [-1.1, 0.05, -0.5], foreR: [-0.7, 0, 0], handR: [-0.05, 0, 0], armL: [-0.3, 0, 0.5], foreL: [-1.0, 0, 0] }),
  },
  // backhand underarm (a lift or clear from a low shuttle on the non-racket side): the trunk turned
  // away so the racket shoulder faces the shuttle, the racket taken back across the body at hip
  // height with the wrist cocked, then the forearm and wrist flick it up and forward
  bhunder: {
    fwd: 0.1, fol: 0.16,
    load: P({ hips: [0.12, 0.3, 0], spine: [0.3, 0.12, 0], chest: [0.16, 0.2, 0], clavR: [-0.05, 0, 0.1], armR: [-0.65, 0.6, 0.4], foreR: [-1.4, 0, 0], handR: [-0.6, 0, 0.3], armL: [0.55, 0, 0.55], foreL: [-0.5, 0, 0] }),
    contact: P({ hips: [0.12, 0.2, 0], spine: [0.3, 0.1, 0], chest: [0.16, 0.12, 0], clavR: [-0.05, 0, 0.05], armR: [-0.8, 0.2, 0.3], foreR: [-0.3, 0, 0], handR: [0.15, 0, 0], armL: [0.6, 0, 0.6], foreL: [-0.4, 0, 0] }),
    follow: P({ hips: [0.06, 0.05, 0], spine: [0.14, 0.02, 0], chest: [0.04, 0, 0], clavR: [-0.1, 0, 0], armR: [-1.75, -0.2, 0.05], foreR: [-0.55, 0, 0], handR: [0.45, 0, 0], armL: [0.4, 0, 0.5], foreL: [-0.5, 0, 0] }),
  },
  // backhand net touch: the same turn, the racket face held out low on the backhand side
  bhtouch: {
    fwd: 0.07, fol: 0.12,
    load: P({ hips: [0.1, 0.22, 0], spine: [0.28, 0.08, 0], chest: [0.12, 0.14, 0], armR: [-0.75, 0.45, 0.45], foreR: [-1.2, 0, 0], handR: [-0.25, 0, 0.1], armL: [0.55, 0, 0.55], foreL: [-0.5, 0, 0] }),
    contact: P({ hips: [0.1, 0.18, 0], spine: [0.28, 0.06, 0], chest: [0.12, 0.1, 0], armR: [-0.95, 0.25, 0.35], foreR: [-0.5, 0, 0], handR: [0, 0, 0], armL: [0.55, 0, 0.55], foreL: [-0.5, 0, 0] }),
    follow: P({ hips: [0.1, 0.16, 0], spine: [0.26, 0.05, 0], chest: [0.1, 0.08, 0], armR: [-1.05, 0.25, 0.35], foreR: [-0.5, 0, 0], handR: [0.05, 0, 0], armL: [0.5, 0, 0.5], foreL: [-0.5, 0, 0] }),
  },
  // backhand block: the defensive default for a smash at the body or the backhand side, the racket
  // face presented in front and across, elbow up and forward
  bhblock: {
    fwd: 0.05, fol: 0.1,
    load: P({ spine: [0.2, 0.06, 0], chest: [0.08, 0.14, 0], armR: [-0.85, 0.55, 0.4], foreR: [-1.55, 0, 0], handR: [-0.3, 0, 0.1], armL: [-0.3, 0, 0.5], foreL: [-1.0, 0, 0] }),
    contact: P({ spine: [0.2, 0.04, 0], chest: [0.08, 0.1, 0], armR: [-1.0, 0.35, 0.3], foreR: [-1.05, 0, 0], handR: [0, 0, 0], armL: [-0.3, 0, 0.5], foreL: [-1.0, 0, 0] }),
    follow: P({ spine: [0.18, 0.04, 0], chest: [0.06, 0.1, 0], armR: [-1.05, 0.35, 0.3], foreR: [-1.0, 0, 0], handR: [0.05, 0, 0], armL: [-0.3, 0, 0.5], foreL: [-1.0, 0, 0] }),
  },
};
// the low strokes a lunge carries, and where the elbow sits (the IK's swivel hint, body frame:
// racket side, up, forward). Overheads: out and a little forward; forehand low: down and out;
// backhands: down and forward, leading the forearm
for (const n of ['under', 'touch', 'block', 'bhunder', 'bhtouch', 'bhblock']) STROKES[n].low = true;
for (const n of ['over', 'smash', 'kill']) STROKES[n].early = { foreR: 0.035, armR: 0.01 };
const ELBOW = { over: [0.9, 0.25, 0.3], smash: [0.9, 0.25, 0.3], kill: [0.9, 0.1, 0.35], fh: [0.7, -0.7, -0.1], bh: [-0.1, -0.2, 1], under: [0.35, -0.35, -1], touch: [0.35, -0.5, -0.6], block: [0.6, -1, 0.2], bhunder: [-0.2, -1, 0.6], bhtouch: [-0.2, -1, 0.5], bhblock: [0.8, -0.3, 0.4] };
// the smash is the overhead with extra arch and fold
STROKES.smash.load = add(STROKES.over.load, STROKES.smash.extend.load);
STROKES.smash.contact = STROKES.over.contact;
// (the smash keeps the tighter follow-through: the fastest stroke, its racket path through the
// contact is the most sensitive; the clear and the drop get the long turn-through)
const SMASH_FOLLOW = { hips: [0.1, 0.3, 0], spine: [0.22, 0.12, 0], chest: [0.3, 0.22, -0.05], neck: [0.05, -0.2, 0], head: [0.05, 0, 0],
  clavR: [0, 0, -0.05], armR: [-1.0, 0.9, -0.55], foreR: [-0.6, 0, 0], handR: [-0.7, 0, -0.2], clavL: [0, 0, 0.05], armL: [0.25, 0, 0.3], foreL: [-1.2, 0, 0], handL: [0, 0, 0] };
STROKES.smash.follow = add(SMASH_FOLLOW, STROKES.smash.extend.follow);
function add(a, b) { const o = {}; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const x = a[k] || [0, 0, 0], y = b[k] || [0, 0, 0]; o[k] = [x[0] + y[0], x[1] + y[1], x[2] + y[2]]; } return o; }

// which stroke plays a shot: the sim's shot kind first, then where the shuttle was met (side: + on
// the racket side, metres; rz: height above the player's own feet). Overhead only above the head;
// backhand for anything met on the non-racket side, and in defence for the body too (a smash at the
// chest or the right hip is blocked backhand: the forehand cannot get the racket in front in time)
export function strokeFor(kind, side, rz) {
  if (kind === 'smash' || kind === 'jsmash') return 'smash';
  if (kind === 'kill') return 'kill';
  if (kind === 'block') return side < 0.12 ? 'bhblock' : 'block';
  if (kind === 'net' || kind === 'servel') return rz > 1.25 ? (side < -0.15 ? 'bh' : 'fh') : side < -0.1 ? 'bhtouch' : 'touch';
  if (rz >= 1.75) return 'over';
  if (rz < 0.95) return side < -0.1 ? 'bhunder' : 'under';
  if (kind === 'counter') return side < 0.12 ? 'bh' : 'fh';
  return side < -0.15 ? 'bh' : 'fh';
}

// sample one stroke at time u (seconds from contact; negative before it) for one bone, with the
// charge c (0..1) deciding how far back the LOAD is drawn while waiting
function sampleStroke(st, bone, u, c, out) {
  const L = st.load[bone], K = st.contact[bone], F = st.follow[bone];
  if (!L && !K && !F) return false;
  const l = L || K || F, k = K || l, f = F || k;
  // a bone that finishes early (st.early, seconds): the elbow of an overhead is straight a moment
  // before the contact, so the last of the swing is the shoulder and the wrist throwing the racket
  // forward through the shuttle, not the forearm still unfolding it up and back
  if (st.early && st.early[bone] && u <= 0) u = Math.min(0, u + st.early[bone] * clamp((u + st.fwd) / st.fwd * 3, 0, 1));
  if (u <= -st.fwd) { for (let i = 0; i < 3; i++) out[i] = l[i] * c; return true; }
  // cubic in and out: the forward swing accelerates all the way into the contact (a whip, fastest at
  // the shuttle) and the follow-through leaves it at that speed, decelerating after
  if (u <= 0) { const x = 1 + u / st.fwd, e = x * x * x; for (let i = 0; i < 3; i++) out[i] = lerp(l[i] * c, k[i], e); return true; }
  // (a long follow-through - an overhead's, 0.3 s - leaves the contact as fast as a short one would,
  // with a long slow tail: quintic rather than cubic, so the racket meets the shuttle at full speed)
  if (u <= st.fol) { const x = 1 - u / st.fol, e = 1 - Math.pow(x, st.fol > 0.2 ? 5 : 3); for (let i = 0; i < 3; i++) out[i] = lerp(k[i], f[i], e); return true; }
  for (let i = 0; i < 3; i++) out[i] = f[i];
  return true;
}

// The racket arm through a retargeted stroke, in rotations rather than angles: each of armR, foreR
// and handR turns from its LOAD rotation to the contact rotation solved onto this shuttle along the
// shortest way round (slerp), on the same clock as sampleStroke (cubic into the contact, so every
// joint is at its fastest there, whatever the wind-up), then on to the follow-through. q: the
// rotation in the model's anatomical frame (human.js: what a pose Euler stands for). Writes the
// pose Euler for it into out.
const _sqA = new THREE.Quaternion(), _sqE = new THREE.Euler();
const ARM_W = 60; // rad/s: the fastest a racket-arm joint turns on the way into or out of a contact
function sampleArmQ(st, Q, bone, u, out) {
  const L = Q.load[bone], K = Q.contact[bone], F = Q.follow[bone];
  if (!L || !K || !F) return false;
  // (a big turn - a large correction onto a shuttle far from the authored contact - starts earlier
  // rather than spinning faster: the joint's swing lasts long enough never to pass ARM_W rad/s,
  // and still arrives at the contact on time; the same for the follow-through)
  const fwd = Math.max(st.fwd, 3 * L.angleTo(K) / ARM_W), pf = st.fol > 0.2 ? 5 : 3, fol = Math.max(st.fol, pf * K.angleTo(F) / ARM_W);
  if (st.early && st.early[bone] && u <= 0) u = Math.min(0, u + st.early[bone] * clamp((u + fwd) / fwd * 3, 0, 1));
  if (u <= -fwd) _sqA.copy(L);
  else if (u <= 0) { const x = 1 + u / fwd; _sqA.copy(L).slerp(K, x * x * x); }
  else if (u <= fol) { const x = 1 - u / fol; _sqA.copy(K).slerp(F, 1 - Math.pow(x, pf)); }
  else _sqA.copy(F);
  // A rotation has two Euler triples (for the arm's XZY order: x+pi, y+pi, pi-z), and the layers
  // blend Euler values, so the one written must be the one nearest the authored angles for this
  // moment (else a blend between two descriptions of one rotation jolts the arm): ref is the
  // authored stroke sampled at u
  const ord = orderOf(bone);
  _sqE.setFromQuaternion(_sqA, ord);
  const a = [_sqE.x, _sqE.y, _sqE.z], alt = ord === 'XZY' ? [a[0] + Math.PI, a[1] + Math.PI, Math.PI - a[2]] : ord === 'YXZ' ? [a[0] + Math.PI, Math.PI - a[1], a[2] + Math.PI] : [a[0] + Math.PI, Math.PI - a[1], a[2] + Math.PI];
  const ref = _sqR; if (!sampleStroke(st, bone, u, 1, ref)) { ref[0] = a[0]; ref[1] = a[1]; ref[2] = a[2]; }
  const wrapTo = (v, r) => r + Math.atan2(Math.sin(v - r), Math.cos(v - r));
  const A1 = a.map((v, i) => wrapTo(v, ref[i])), A2 = alt.map((v, i) => wrapTo(v, ref[i]));
  const d = A => Math.abs(A[0] - ref[0]) + Math.abs(A[1] - ref[1]) + Math.abs(A[2] - ref[2]);
  const B = d(A1) <= d(A2) ? A1 : A2;
  out[0] = B[0]; out[1] = B[1]; out[2] = B[2];
  return true;
}
const _sqR = [0, 0, 0];
const qOfKey = (k, bone) => new THREE.Quaternion().setFromEuler(new THREE.Euler(k[0], k[1], k[2], orderOf(bone)));

// ---------------------------------------------------------------- stance, legs, reactions
const READY = { thigh: -0.3, shin: 0.62, foot: -0.26 };
function stance(Q, t, seed, crouch) {
  // athletic ready position: feet wide, knees and hips flexed, weight on the balls of the feet,
  // racket up in front; a slow breath through the chest
  const br = Math.sin(t * 1.9 + seed) * 0.5 + 0.5;
  for (const [s, k] of [[1, 'L'], [-1, 'R']]) {
    Q.set('thigh' + k, READY.thigh * crouch, 0, s * 0.1);
    Q.set('shin' + k, READY.shin * crouch);
    Q.set('foot' + k, READY.foot * crouch);
    Q.set('toe' + k, -0.05 * crouch);
  }
  Q.set('hips', 0.1 * crouch, 0, 0); Q.set('spine', 0.14 * crouch, 0, 0); Q.set('chest', 0.04 + br * 0.03, 0, 0);
  Q.set('neck', -0.08, 0, 0); Q.set('head', -0.06, 0, 0);
  Q.set('clavR', -0.08, 0, -0.1); Q.set('armR', -0.75, -0.15, -0.5); Q.set('foreR', -1.05 - br * 0.04, 0, 0); Q.set('handR', 0.15, 0, -0.1);
  Q.set('clavL', -0.05, 0, 0.1); Q.set('armL', -0.55, 0, 0.55 + br * 0.03); Q.set('foreL', -0.95, 0, 0); Q.set('handL', 0.1, 0, 0);
}
// a lunge: the racket-side leg driven long toward the shuttle, the trail leg extended behind
function lunge(Q, w, side) {
  // a right-hander lunges on the racket leg to either corner: the right foot driven out toward the
  // shuttle (splayed out to the forehand, across to the backhand), knee over the foot, thigh near
  // level; the trail leg long and nearly straight behind on the ball of the foot, so the hips drop
  // to ~0.6 m (reach) instead of the trail leg holding them up
  const s = side < 0 ? -1 : 1;
  Q.set('thighR', -1.45 * w, 0, (s > 0 ? -0.22 : 0.12) * w); Q.set('shinR', 1.6 * w); Q.set('footR', -0.25 * w); Q.set('toeR', 0);
  Q.set('thighL', 1.1 * w, 0, 0.1 * w); Q.set('shinL', 0.3 * w); Q.set('footL', 0.6 * w); Q.set('toeL', -0.6 * w);
}
// jump: crouch (w 0..1), the push-off (ext: legs driving straight through take-off, the ankles
// pointed), the tuck in flight (knees drawn up, the left a little higher, as a jumper's are), the
// reach for the floor before landing (legs coming down under the body, knees soft), and the scissor
// kick of a jump smash (k: -1 legs loaded, the right leg back; +1 switched through contact). The
// free arm swings with it: back in the crouch, thrown up through the push-off, out for balance.
function jumpLegs(Q, crouch, ext, tuck, reach, kick) {
  for (const [s, k] of [[1, 'L'], [-1, 'R']]) {
    const lead = k === 'L' ? 1 : 0.75;
    let th = -0.62 * crouch - 0.08 * ext - 0.8 * tuck * lead - 0.38 * reach, sh = 1.08 * crouch + 0.1 * ext + 1.35 * tuck * lead + 0.42 * reach;
    const fo = -0.32 * crouch + 0.8 * ext + 0.4 * tuck + 0.1 * reach;
    if (kick) { const right = k === 'R' ? 1 : -1, ph = kick * right; th += 0.6 * ph; sh += 0.4 * Math.abs(kick) * (ph > 0 ? 1 : 0.4); }
    Q.set('thigh' + k, th, 0, s * (0.08 + 0.06 * tuck)); Q.set('shin' + k, sh); Q.set('foot' + k, fo); Q.set('toe' + k, 0.2 * ext);
  }
  Q.set('hips', 0.24 * crouch - 0.05 * ext + 0.14 * tuck, 0, 0);
  Q.set('spine', 0.16 * crouch + 0.06 * tuck, 0, 0);
  Q.set('armL', 0.55 * crouch - 1.5 * ext - 0.75 * tuck - 0.5 * reach, 0, 0.3 + 0.25 * tuck + 0.35 * reach);
  Q.set('foreL', -0.5 - 0.3 * tuck);
}
function landing(Q, w) {
  for (const [s, k] of [[1, 'L'], [-1, 'R']]) { Q.set('thigh' + k, -0.85 * w, 0, s * 0.12); Q.set('shin' + k, 1.45 * w); Q.set('foot' + k, -0.42 * w); Q.set('toe' + k, 0); }
  Q.set('hips', 0.3 * w, 0, 0); Q.set('spine', 0.25 * w, 0, 0);
}
// (the dive, the slide and the get-up are in footwork.js: diveBody / diveWeight)

// ---------------------------------------------------------------- the grip
// A forehand (handshake) grip, solved against the character's own skinned hand (tools/grip_check.js
// measures it): the handle lies diagonally across the palm from the base of the index finger to the
// hypothenar, the butt cap just clear of the little finger at the heel of the hand, the strings
// parallel to the palm (lay the palm on the strings, slide down to the handle, shake hands).
// All in the hand_r bone's own frame: +x back of the hand, -x palm, +y toward the fingers, +z the
// thumb side. The racket is parented to that bone, so the grip holds rigidly through every stroke.
const GRIP_R = 0.0133;                           // handle radius incl. overgrip (27 mm across at the rig's scale)
const GRIP_CAP = [-0.0416, 0.08209, -0.03852];   // the handle's axis where it meets the top of the butt cap
const GRIP_DIR = [0.07991, 0.49598, 0.86465];    // the handle's axis, butt -> head
// Finger rotations from the rig's rest pose, as Euler 'ZYX' [flex, twist, spread] in each bone's
// frame (+flex curls toward the palm on both hands). Right: every finger closed onto the handle
// joint by joint until each phalanx met its surface (the DIP following the PIP, as the tendon does);
// the index spread a little up the handle, trigger-style; the thumb round the far side, its pad on
// the handle. Left: the free hand, a relaxed natural curl (a cascade, more toward the little finger).
const FINGERS = {
  index_01_r: [0.015, 0, -0.2], index_02_r: [1.029, 0, 0], index_03_r: [1.004, 0, 0],
  middle_01_r: [0.57, 0, -0.03], middle_02_r: [1.328, 0, 0], middle_03_r: [0.998, 0, 0],
  ring_01_r: [1.022, 0, 0.05], ring_02_r: [1.138, 0, 0], ring_03_r: [0.867, 0, 0],
  pinky_01_r: [0.904, 0, 0.12], pinky_02_r: [1.018, 0, 0], pinky_03_r: [0.805, 0, 0],
  thumb_01_r: [0.4, -0.106, 0], thumb_02_r: [0.275, 0, 0.053], thumb_03_r: [-0.4, 0, 0],
  index_01_l: [0.3, 0, 0.05], index_02_l: [0.5, 0, 0], index_03_l: [0.3, 0, 0],
  middle_01_l: [0.4, 0, 0], middle_02_l: [0.6, 0, 0], middle_03_l: [0.35, 0, 0],
  ring_01_l: [0.5, 0, -0.04], ring_02_l: [0.65, 0, 0], ring_03_l: [0.4, 0, 0],
  pinky_01_l: [0.6, 0, -0.1], pinky_02_l: [0.65, 0, 0], pinky_03_l: [0.4, 0, 0],
  thumb_01_l: [0.15, 0, 0], thumb_02_l: [0.2, 0, 0], thumb_03_l: [0.2, 0, 0],
};
// the hand pose Human writes over the mocap every frame (human.js fingerPose)
function fingerPose(h) {
  const e = new THREE.Euler(), out = [];
  for (const [bone, open] of h.fingers) {
    const a = FINGERS[bone.name];
    out.push([bone, a ? open.clone().multiply(new THREE.Quaternion().setFromEuler(e.set(a[0], a[1], a[2], 'ZYX'))) : open.clone()]);
  }
  return out;
}

// ---------------------------------------------------------------- the racket
// Racket space: +y up the handle (the top of the butt cap at y = -0.04, the grip up to 0.16), the
// head in the xy plane, strings facing +-z.
function makeRacket() {
  const g = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x1b1f27, roughness: 0.35, metalness: 0.4 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xe4ff3c, roughness: 0.45 });
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(GRIP_R, GRIP_R, 0.2, 24), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.85 }));
  grip.position.y = 0.06; g.add(grip);
  // the butt cap, flared a millimetre proud of the grip so the hand has something to sit on
  const butt = new THREE.Mesh(new THREE.CylinderGeometry(GRIP_R + 0.0009, GRIP_R + 0.0019, 0.014, 24), frameMat); butt.position.y = -0.047; g.add(butt);
  // the ferrule: the grip tapering into the shaft
  const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(0.0062, GRIP_R, 0.022, 16), frameMat); ferrule.position.y = 0.171; g.add(ferrule);
  g.userData.grip = { r: GRIP_R, y0: -0.04, y1: 0.16, capR: GRIP_R + 0.0019, capY0: -0.054 }; // for tools/grip_check.js
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.006, 0.26, 8), frameMat); shaft.position.y = 0.29; g.add(shaft);
  const tJoint = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.05, 8), accent); tJoint.position.y = 0.43; g.add(tJoint);
  // an isometric head: a squared-off oval, 230 x 200 mm, built as a tube round its outline
  const pts = [];
  for (let i = 0; i < 48; i++) { const a = i / 48 * Math.PI * 2, c = Math.cos(a), s = Math.sin(a); pts.push(new THREE.Vector3(Math.sign(c) * Math.pow(Math.abs(c), 0.8) * 0.1, 0.565 + Math.sign(s) * Math.pow(Math.abs(s), 0.85) * 0.115, 0)); }
  const curve = new THREE.CatmullRomCurve3(pts, true);
  const head = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, 0.0065, 6, true), frameMat); g.add(head);
  const stringsTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'); x.strokeStyle = 'rgba(240,244,248,.85)'; x.lineWidth = 1.1; for (let i = 4; i < 128; i += 6) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 128); x.stroke(); x.beginPath(); x.moveTo(0, i); x.lineTo(128, i); x.stroke(); } const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const shape = new THREE.Shape(); curve.getPoints(48).forEach((p, i) => (i ? shape.lineTo(p.x, p.y) : shape.moveTo(p.x, p.y)));
  const sg = new THREE.ShapeGeometry(shape); { const uv = sg.attributes.uv, pos = sg.attributes.position; for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / 0.2 + 0.5, (pos.getY(i) - 0.565) / 0.23 + 0.5); }
  const strings = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ map: stringsTex, transparent: true, side: THREE.DoubleSide, depthWrite: false, alphaTest: 0.2 }));
  g.add(strings);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  g.userData.sweet = new THREE.Vector3(0, 0.565, 0);
  return g;
}

// ---------------------------------------------------------------- two-bone IK
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion();
// rotate `bone` in world space by R (about its own joint), keeping everything else put
function worldRotate(bone, R) {
  bone.getWorldQuaternion(_q1);
  bone.parent.getWorldQuaternion(_q2);
  bone.quaternion.copy(_q2.invert().multiply(R).multiply(_q1));
  bone.updateMatrixWorld(true);
}
// Shoulder S, elbow E, and an effector P rigid in the forearm's frame (the racket's sweet spot).
//  1. the elbow bends about its own anatomical hinge axis (the model's forearm x, human.js) so that
//     |P - S| = |T - S|, and never past straight or past full flexion (no hyperextension);
//  2. the upper arm swings so P lands on T;
//  3. the arm swivels about the shoulder-target line toward `pole` (world direction the elbow
//     should point: out and down on a low forehand, out and up on an overhead), which keeps P on T.
// Weight w blends from the pose as it was. Reach is clamped: an impossible target is reached for.
const _h = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _X = new THREE.Vector3(1, 0, 0);
const RT_CHAIN = ['hips', 'spine', 'chest', 'clavR', 'armR', 'foreR', 'handR'];
const orderOf = n => (/^(hips|spine|chest|neck|head)$/.test(n) ? 'YXZ' : /^arm/.test(n) ? 'XZY' : 'XYZ'); // human.js ORDER
const _rtT = new THREE.Vector3(), _rtP = new THREE.Vector3(), _rtQ = new THREE.Quaternion(), _rtE = new THREE.Euler();
const _ikO = new THREE.Vector3(), _ikV = new THREE.Vector3();
const _ikS = new THREE.Vector3(), _ikR = new THREE.Vector3(), _ikP = new THREE.Vector3(), _ikA = new THREE.Vector3(), _ikT = new THREE.Vector3();
const ELBOW_MIN = -2.45, ELBOW_MAX = -0.06; // hinge range used by the IK (human.js allows -2.6..0.1)
function elbowHinge(h) {
  const r = h.ref[boneIndex('foreR')][0];
  const D = _q1.copy(r.C).multiply(r.bone.quaternion).multiply(r.Li).multiply(r.Ci).normalize();
  if (D.w < 0) D.set(-D.x, -D.y, -D.z, -D.w);
  return 2 * Math.atan2(D.x, D.w);
}
const S0 = b => b.getWorldPosition(_e);
// the shoulder's range (human.js caps the upper arm's total turn from the arms-down reference at
// 3.0 rad; the IK runs after that limit, so it keeps to it itself)
function capArm(h, max) {
  const r = h.ref[boneIndex('armR')][0], D = _q1.copy(r.C).multiply(r.bone.quaternion).multiply(r.Li).multiply(r.Ci).normalize();
  if (D.w < 0) D.set(-D.x, -D.y, -D.z, -D.w);
  const a = 2 * Math.acos(Math.min(1, D.w));
  if (a <= max) return;
  D.slerp(_q2.identity(), 1 - max / a); // (slerp from D toward identity: the same axis, the angle cut to max)
  r.bone.quaternion.copy(r.Ci).multiply(D).multiply(r.C).multiply(r.L);
  r.bone.updateMatrixWorld(true);
}
// No arm through the body: the forearm and racket kept clear of the trunk (a capsule down the spine)
// and the head. If the solved arm cuts through, it swivels about the shoulder-target line (the
// racket stays on the shuttle) to the nearest angle that clears, or failing that the clearest one.
const _cA = new THREE.Vector3(), _cB = new THREE.Vector3(), _cC = new THREE.Vector3(), _cD = new THREE.Vector3(), _cE = new THREE.Vector3(), _cQ = new THREE.Quaternion();
function segSeg(p1, q1, p2, q2) {
  const d1 = _cC.subVectors(q1, p1), d2 = _cD.subVectors(q2, p2), r = _cE.subVectors(p1, p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r), c = d1.dot(r), b = d1.dot(d2), den = a * e - b * b;
  let sN = den > 1e-9 ? clamp((b * f - c * e) / den, 0, 1) : 0, tN = e > 1e-9 ? (b * sN + f) / e : 0;
  if (tN < 0) { tN = 0; sN = a > 1e-9 ? clamp(-c / a, 0, 1) : 0; } else if (tN > 1) { tN = 1; sN = a > 1e-9 ? clamp((b - c) / a, 0, 1) : 0; }
  const x = p1.x + d1.x * sN - p2.x - d2.x * tN, y = p1.y + d1.y * sN - p2.y - d2.y * tN, z = p1.z + d1.z * sN - p2.z - d2.z * tN;
  return Math.hypot(x, y, z);
}
function clearance(h, effector) {
  const B = h.bone, E = B.lowerarm_r.getWorldPosition(new THREE.Vector3()), Wr = B.hand_r.getWorldPosition(new THREE.Vector3()), P = effector(new THREE.Vector3());
  const pel = B.pelvis.getWorldPosition(new THREE.Vector3()), nk = B.neck_01.getWorldPosition(new THREE.Vector3());
  const hd = B.Head.getWorldPosition(new THREE.Vector3()); hd.y += 0.09;
  const tip = P.clone().addScaledVector(P.clone().sub(Wr).normalize(), 0.12);
  return Math.min(segSeg(E, Wr, pel, nk) - 0.14, segSeg(Wr, tip, pel, nk) - 0.11, segSeg(E, tip, hd, hd) - 0.13);
}
function clearBody(h, effector, target) {
  const upper = h.bone.upperarm_r;
  const S = upper.getWorldPosition(_cA), ax = effector(_cB).sub(S).normalize(), q0 = upper.quaternion.clone(); // (about the line to the racket as it is: it stays put)
  const at = a => { upper.quaternion.copy(q0); upper.updateMatrixWorld(true); if (a) worldRotate(upper, _cQ.setFromAxisAngle(ax, a)); return clearance(h, effector); };
  let a = h._clearA || 0;
  const c0 = at(0);
  let want = 0; // (the pose is clear of its own accord: ease the swivel back out)
  if (c0 < 0.02) {
    // the nearest clearing angle to the last frame's (continuity: it cannot flip side to side);
    // failing one, the angle that gives the most room
    want = null;
    let best = { a: 0, c: c0 };
    for (let i = 0; i <= 16; i++) {
      const aa = -1.2 + i * 0.15, c = at(aa);
      if (c >= 0.02 && (want == null || Math.abs(aa - a) < Math.abs(want - a))) want = aa;
      if (c > best.c) best = { a: aa, c };
    }
    if (want == null) want = best.a;
  }
  a = clamp(a + clamp(want - a, -0.45, 0.45), -1.3, 1.3); // a servo: at most a step a frame
  at(a);
  h._clearA = a;
}
function solveArm(h, effector, target, w, pole, swivel, maxStep, maxElb) {
  if (w <= 0.001) return;
  const upper = h.bone.upperarm_r, fore = h.bone.lowerarm_r, r = h.ref[boneIndex('foreR')][0];
  const hand0 = h.bone.hand_r.quaternion.clone();
  const u0 = upper.quaternion.clone(), f0 = fore.quaternion.clone();
  // 1. elbow: rotate the effector about the hinge axis h (through E) by theta: with a = E - S,
  // v = P - E, |P' - S|^2 = |a|^2 + |v|^2 + 2 a.R(theta)v, so A cos + B sin = M
  const dist = _d.copy(target).sub(S0(upper)).length();
  const elbow = () => {
    const S = upper.getWorldPosition(_a), E = fore.getWorldPosition(_b), Pw = effector(_c);
    const hx = _h.copy(_X).applyQuaternion(_q2.copy(fore.parent.getWorldQuaternion(_q3)).multiply(r.Ci)).normalize();
    const av = _v1.copy(E).sub(S), vv = _v2.copy(Pw).sub(E);
    const vPar = hx.clone().multiplyScalar(vv.dot(hx)), vPerp = vv.clone().sub(vPar), hxv = _v3.crossVectors(hx, vv);
    const A = av.dot(vPerp), B = av.dot(hxv), Rr = Math.hypot(A, B);
    const cur = elbowHinge(h);
    if (Rr <= 1e-6) return cur;
    const at = th => Math.sqrt(Math.max(0, av.lengthSq() + vv.lengthSq() + 2 * (av.dot(vPar) + Math.cos(th) * A + Math.sin(th) * B)));
    const K = (dist * dist - av.lengthSq() - vv.lengthSq()) / 2 - av.dot(vPar);
    const phi = Math.atan2(B, A), c0 = Math.acos(clamp(K / Rr, -1, 1));
    // both roots and the ends of the range: the roots that reach the target (within a centimetre or
    // so), then of those the one nearest last frame's angle, so the elbow cannot flip between
    // configurations; a weight, not a rule: a root that plainly cannot reach still loses
    const roots = [];
    for (const th of [phi + c0, phi - c0, ELBOW_MIN - cur, ELBOW_MAX - cur]) {
      let t = Math.atan2(Math.sin(th), Math.cos(th));
      t = clamp(cur + t, ELBOW_MIN, ELBOW_MAX) - cur; // stay inside the hinge range
      roots.push({ t, de: Math.abs(at(t) - dist), ang: cur + t });
    }
    const minDE = Math.min(...roots.map(r => r.de));
    const prevE = h._elbAb != null ? h._elbAb : cur;
    let best = null;
    for (const r of roots.filter(r => r.de <= minDE + 0.015)) {
      if (!best || Math.abs(r.ang - prevE) < Math.abs(best.ang - prevE)) best = r;
    }
    // the elbow is not the whip: it cannot snap from a folded configuration to an extended one in
    // a frame even when that root suddenly reaches further (it unfolds over the swing instead).
    // The cap opens right at the contact for fine-tuning, but a switch between roots - the chosen
    // angle half a radian or more from last frame's - stays slow wherever it happens.
    const cap0 = maxElb == null ? (maxStep == null ? Infinity : maxStep) : maxElb;
    const cap = best && Math.abs(best.ang - prevE) > 0.5 ? Math.min(cap0, 0.35) : cap0;
    const t = best ? clamp(best.t, prevE - cur - cap, prevE - cur + cap) : 0;
    if (Math.abs(t) > 1e-5) worldRotate(fore, _q4.setFromAxisAngle(hx, t));
    h._elbAb = cur + t;
    return h._elbAb;
  };
  const eA = elbow();
  // jammed (the shuttle close to the shoulder): the wrist lays the racket back rather than the
  // elbow folding shut, as a player does taking a drive off the body
  if (eA < -1.7 && dist < 0.85) { // (truly close: not a bad first root on a long reach)
    const hand = h.bone.hand_r, rh = h.ref[boneIndex('handR')][0], E = fore.getWorldPosition(_b);
    const ax = _e.copy(_X).applyQuaternion(_q2.copy(hand.parent.getWorldQuaternion(_q3)).multiply(rh.Ci)).normalize();
    const d0 = effector(_c).distanceTo(E), amt = clamp((-1.7 - eA) * 0.9, 0, 0.8);
    const hq = hand.quaternion.clone();
    worldRotate(hand, _q4.setFromAxisAngle(ax, amt));
    if (effector(_c).distanceTo(E) > d0) { hand.quaternion.copy(hq); hand.updateMatrixWorld(true); worldRotate(hand, _q4.setFromAxisAngle(ax, -amt)); }
    elbow();
  }
  // 2. shoulder: point the arm so the effector lies on the target (at most `maxStep` a frame, so
  // a solve that has fallen behind catches up over the swing instead of swinging round in one)
  const P2 = effector(_c), S2 = upper.getWorldPosition(_a);
  const from = P2.sub(S2).normalize(), to = _d.copy(target).sub(S2).normalize();
  const ang = Math.acos(clamp(from.dot(to), -1, 1)), axis = _v1.crossVectors(from, to);
  const cap = maxStep == null ? Infinity : maxStep;
  if (ang > cap && axis.lengthSq() > 1e-10) worldRotate(upper, _q4.setFromAxisAngle(axis.normalize(), cap));
  else worldRotate(upper, _q4.setFromUnitVectors(from, to));
  // 3. swivel toward the elbow hint
  if (pole && swivel > 0) {
    const El = fore.getWorldPosition(_b), ax = to; // the shoulder-target axis (unit)
    const e = _v1.copy(El).sub(S2); e.addScaledVector(ax, -e.dot(ax));
    const pp = _v2.copy(pole).addScaledVector(ax, -pole.dot(ax));
    if (e.lengthSq() > 1e-6 && pp.lengthSq() > 1e-6) {
      e.normalize(); pp.normalize();
      const ang = Math.atan2(_v3.crossVectors(e, pp).dot(ax), e.dot(pp));
      worldRotate(upper, _q4.setFromAxisAngle(ax, ang * swivel));
    }
  }
  if (w < 0.999) { upper.quaternion.copy(u0.slerp(upper.quaternion, w)); fore.quaternion.copy(f0.slerp(fore.quaternion, w)); h.bone.hand_r.quaternion.copy(hand0.slerp(h.bone.hand_r.quaternion, w)); upper.updateMatrixWorld(true); }
  capArm(h, 2.97);
}

// Present the racket face: turn the forearm about the elbow -> sweet-spot line (which keeps the
// sweet spot where the IK put it) so the strings' normal lines up with `want` (either face: a
// backhand shows the other side), by at most 1.2 rad, at weight w.
const _fa = new THREE.Vector3(), _fn = new THREE.Vector3(), _fw = new THREE.Vector3(), _fq = new THREE.Quaternion(), _Z = new THREE.Vector3(0, 0, 1);
function faceTo(h, racket, effector, want, w, side, prev) {
  if (w <= 0.001) return null;
  const fore = h.bone.lowerarm_r, E = fore.getWorldPosition(_a), P = effector(_c);
  const ax = _fa.copy(P).sub(E).normalize();
  // which face: the racket's +z is the back of the hand (grip, see makeRacket), so a forehand hits
  // with the palm's face (-z) and a backhand with the other (+z): side -1 / +1
  const n = _fn.copy(_Z).multiplyScalar(side).applyQuaternion(racket.getWorldQuaternion(_fq)); n.addScaledVector(ax, -n.dot(ax));
  const t = _fw.copy(want).addScaledVector(ax, -want.dot(ax));
  if (n.lengthSq() < 1e-6 || t.lengthSq() < 1e-6) return null;
  n.normalize(); t.normalize();
  // continuous from frame to frame: near a half turn the two ways round are equal, and choosing
  // afresh each frame would flip the forearm back and forth
  let a0 = Math.atan2(_d.crossVectors(n, t).dot(ax), n.dot(t));
  if (prev != null) { while (a0 - prev > Math.PI) a0 -= 2 * Math.PI; while (a0 - prev < -Math.PI) a0 += 2 * Math.PI; }
  const ang = clamp(a0, -1.6, 1.6);
  worldRotate(fore, _q4.setFromAxisAngle(ax, ang * w));
  return ang;
}
// how the face is presented, per stroke: the shot's rise (+) or fall (-) against the level aim
// the follow-through of the strokes played in front: where the racket head goes from the contact
// (metres: along the aim, to the body's right (+) or left (-), up)
const FOLLOW = { kill: [0.4, 0, -0.35], fh: [0.75, -0.25, 0.12], bh: [0.55, 0.35, 0.12], under: [0.45, 0.2, 0.6], bhunder: [0.58, 0.0, 0.78], touch: [0.12, 0, 0.1], bhtouch: [0.12, 0, 0.1] };
const FACE_UP = { smash: -0.3, kill: -0.5, over: 0.45, fh: 0.08, bh: 0.08, under: 0.9, bhunder: 0.9, touch: 0.45, bhtouch: 0.45, block: 0.3, bhblock: 0.3 };

// ---------------------------------------------------------------- the athlete
export class Athlete {
  constructor(scene, kit, A, lookFor) {
    this.root = new THREE.Group(); scene.add(this.root);
    this.h = new Human(kit);
    this.root.add(this.h.group);
    this.h.init(A);
    this.apparel = new BadmintonApparel(this.h, A);
    this.lookFor = lookFor;
    this.racket = makeRacket();
    // the grip (see GRIP_*): the handle's axis on GRIP_DIR through GRIP_CAP in the hand bone's frame,
    // the strings' normal the palm's (hand x, square to the handle); the fingers wrapped round it
    const hand = this.h.bone.hand_r;
    const ay = new THREE.Vector3(...GRIP_DIR).normalize(), az = new THREE.Vector3(1, 0, 0).addScaledVector(ay, -ay.x).normalize();
    this.racket.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(ay, az), ay, az));
    this.racketBase = this.racket.quaternion.clone();
    this.racket.position.set(...GRIP_CAP).addScaledVector(ay, 0.04); // racket y = -0.04 is the top of the butt cap
    hand.add(this.racket);
    this.h.fingerPose = fingerPose(this.h);
    const fistEuler = new THREE.Euler();
    this.fist = this.h.fingers.filter(([bone]) => /_l$/.test(bone.name)).map(([bone, open]) => {
      const thumb = /^thumb/.test(bone.name), joint = Number(bone.name.match(/_(\d+)_/)[1]);
      const flex = thumb ? [0.5, 0.45, 0.2][joint - 1] : [1.02, 1.4, 0.96][joint - 1];
      return [bone, open.clone().multiply(new THREE.Quaternion().setFromEuler(fistEuler.set(flex, 0, 0, 'ZYX')))];
    });
    this.sweet = out => this.racket.localToWorld(out.copy(this.racket.userData.sweet));
    this.Q = new Pose(); this.T = new Pose(); this.AD = new Pose(); this.W = new Float32Array(this.Q.r.length / 3);
    this.fast = new Float32Array(this.W.length);
    this.yaw = 0; this.speed = 0; this.identity = null; this.look = null;
    this.hop = 0; this.land = 0; this.lungeW = 0; this.lungeSide = 1; this.diveW = 0; this.jumpW = 0;
    this.stroke = null; this.whoosh = [];
    this.celebrationDelay = null; this.wonAge = null; this.celebrationCancelled = false;
    this.tmp = [0, 0, 0];
    // what reset() returns to: the fields a fresh athlete has, and their plain values
    this._freshKeys = new Set([...Object.keys(this), '_freshKeys', '_freshVals']);
    this._freshVals = Object.fromEntries(Object.entries(this).filter(([, v]) => v === null || typeof v !== 'object'));
  }
  // Back to exactly how a fresh athlete starts (the animation player replays a case from frame 0;
  // the checks start every case clean): every per-frame memory the layers keep is dropped.
  reset() {
    for (const k of Object.keys(this)) if (!this._freshKeys.has(k)) delete this[k];
    Object.assign(this, this._freshVals);
    this.whoosh.length = 0;
    this.racket.quaternion.copy(this.racketBase);
    this.apparel.reset();
    const h = this.h;
    h.filt = null; h.spw = null; h.mixQ = null; if (h.env) h.env.length = 0; h.groundY = 0; h.phase = 0; h._elbAb = null; h._clearA = 0;
    h.group.quaternion.identity(); h.group.position.set(0, 0, 0);
  }
  _rtKey(st) { const c = st.contact; return c ? st.name + '|' + c.x.toFixed(2) + ',' + c.y.toFixed(2) + ',' + c.z.toFixed(2) : st.name; }
  // Solve the stroke's CONTACT key onto this shuttle: pose the upper body at the key (forward
  // kinematics on the rig, then put back), run the arm IK there and read the arm's solution back as
  // key angles. The swing then interpolates LOAD -> this contact, so the racket arrives on the
  // shuttle along the stroke's own path at the stroke's own speed (no last-instant correction
  // freezing it onto the shuttle); the follow-through carries the same correction on.
  _retarget(st, cs, sn, rise) {
    const h = this.h, base = STROKES[st.name], K = base.contact;
    const saved = this._rtSaved || (this._rtSaved = []);
    let n0 = 0;
    for (const n of RT_CHAIN) for (const r of h.ref[boneIndex(n)]) { (saved[n0] || (saved[n0] = new THREE.Quaternion())).copy(r.bone.quaternion); n0++; }
    // (the probe solves the contact unconstrained: neither the live elbow's continuity nor its
    // clearance servo may steer the retargeted key)
    const ea = h._elbAb; h._elbAb = null;
    // the trunk as the swing will really have it at the contact instant (each segment runs LEAD
    // ahead of the racket: the hips are already uncoiling into the follow-through), the arm at its key
    const tmp = [0, 0, 0];
    for (const n of this.diveW > 0.3 ? RT_CHAIN.slice(3) : RT_CHAIN) {
      let k = K[n];
      if (/^(hips|spine|chest|clavR)$/.test(n)) {
        if (!sampleStroke(base, n, LEAD[n] || 0, 1, tmp)) { tmp[0] = tmp[1] = tmp[2] = 0; }
        // plus the trunk's reach lean as it is now (the AD layer the pose gets it through)
        const L = this.lean; if (L) { if (n === 'hips') { tmp[0] += L[0]; tmp[1] += L[9] || 0; } if (n === 'spine') { tmp[0] += L[1]; tmp[1] += L[5]; tmp[2] += L[2]; } if (n === 'chest') { tmp[0] += L[3]; tmp[1] += L[6]; tmp[2] += L[4]; } }
        k = tmp;
      }
      if (!k) continue; for (const r of h.ref[boneIndex(n)]) r.bone.quaternion.copy(h._conj(r, k[0], k[1], k[2], orderOf(n))).multiply(r.L); }
    h.root.updateMatrixWorld(true);
    const tgt = _rtT.copy(st.contact); tgt.y -= rise;
    const e = ELBOW[st.name] || ELBOW.fh;
    solveArm(h, this.sweet, tgt, 1, _rtP.set(-cs * e[0] + sn * e[2], e[1], sn * e[0] + cs * e[2]), 0.6);
    const rtOff = tgt.clone().sub(this.sweet(_ikA)), rtErr = rtOff.length(); // what the probe could not reach
    this._rtPQ = RT_CHAIN.map(n => h.ref[boneIndex(n)].map(r => r.bone.quaternion.clone())); this._rtPS = this.sweet(new THREE.Vector3()); this._rtPR = h.root.getWorldPosition(new THREE.Vector3());
    // the solved contact as rotations (the arm's swing is built from these: see sampleArmQ)
    const qSol = {};
    for (const n of ['armR', 'foreR', 'handR']) { const r = h.ref[boneIndex(n)][0]; qSol[n] = new THREE.Quaternion().copy(r.C).multiply(r.bone.quaternion).multiply(r.Li).multiply(r.Ci).normalize(); }
    const out = {};
    for (const n of ['armR', 'foreR', 'handR']) {
      const r = h.ref[boneIndex(n)][0], k = K[n] || [0, 0, 0], ord = orderOf(n);
      const E = _rtQ.copy(r.C).multiply(r.bone.quaternion).multiply(r.Li).multiply(r.Ci);
      _rtE.setFromQuaternion(E, ord);
      // of the two Euler triples for this rotation, the one nearest the key (so the swing
      // interpolates the short way), and never more than 1.4 rad from it per axis
      const a = [_rtE.x, _rtE.y, _rtE.z], alt = ord === 'XZY' ? [a[0] + Math.PI, a[1] + Math.PI, Math.PI - a[2]] : [a[0] + Math.PI, Math.PI - a[1], a[2] + Math.PI];
      const wrap = (v, i) => k[i] + Math.atan2(Math.sin(v - k[i]), Math.cos(v - k[i]));
      const A1 = a.map(wrap), A2 = alt.map(wrap), dist = A => A.reduce((s, v, i) => s + Math.abs(v - k[i]), 0);
      out[n] = (dist(A1) <= dist(A2) ? A1 : A2).map((v, i) => clamp(v, k[i] - 2.2, k[i] + 2.2));
    }
    n0 = 0;
    for (const n of RT_CHAIN) for (const r of h.ref[boneIndex(n)]) r.bone.quaternion.copy(saved[n0++]);
    h._elbAb = ea;
    h.root.updateMatrixWorld(true);
    const contact = Object.assign({}, K, out), follow = Object.assign({}, base.follow), load = Object.assign({}, base.load);
    // a compact stroke (block, net touch) moves as a whole to where the shuttle is: its small
    // punch stays small, rather than a long swing from the key's LOAD to a far-off contact
    if (/^(block|bhblock|touch|bhtouch)$/.test(st.name)) for (const n of ['armR', 'foreR', 'handR']) { const l0 = base.load[n] || K[n] || [0, 0, 0], k = K[n] || [0, 0, 0]; load[n] = l0.map((v, i) => v + (out[n][i] - k[i])); }
    if (/^(block|bhblock)$/.test(st.name)) for (const n of ['armR', 'foreR', 'handR']) { follow[n] = out[n].slice(); load[n] = out[n].slice(); } // (a block is set, not swung: the face put there early and held)
    // a low backhand underarm: anchor its LOAD to the shuttle too - the key's load sits at chest
    // height, and swinging down from there onto an ankle-high shuttle is a chopped swing, not a
    // lift (the racket is taken back low behind it and swings up through)
    if (st.name === 'bhunder' && st.rz != null && st.rz < 0.55) for (const n of ['armR', 'foreR', 'handR']) { const l0 = base.load[n] || K[n] || [0, 0, 0], k = K[n] || [0, 0, 0]; load[n] = l0.map((v, i) => v + (out[n][i] - k[i]) * 0.3); }
    // (the arm's shift in full, the elbow and wrist's in part, and the elbow kept inside its range)
    for (const n of ['armR', 'foreR', 'handR']) { const f0 = base.follow[n] || K[n] || [0, 0, 0], k = K[n] || [0, 0, 0], g = n === 'armR' ? 0.7 : 0.5; follow[n] = f0.map((v, i) => v + (out[n][i] - k[i]) * g); }
    follow.foreR = [clamp(follow.foreR[0], -2.1, -0.1), follow.foreR[1], follow.foreR[2]];
    // the racket arm in rotations: LOAD as authored, CONTACT as solved, FOLLOW carrying the same
    // correction on (the arm's mostly, the elbow and wrist's in part); a compact stroke moves as a
    // whole to the shuttle, a block is set there, a very low backhand lift takes its LOAD down with it
    const Q = { load: {}, contact: {}, follow: {} };
    for (const n of ['armR', 'foreR', 'handR']) {
      const kq = qOfKey(K[n] || [0, 0, 0], n), lq = qOfKey(base.load[n] || K[n] || [0, 0, 0], n), fq = qOfKey(base.follow[n] || K[n] || [0, 0, 0], n);
      const delta = qSol[n].clone().multiply(kq.clone().invert()); // the correction, in the anatomical frame
      const part = g => new THREE.Quaternion().slerp(delta, g);   // (identity -> delta)
      Q.contact[n] = qSol[n];
      Q.load[n] = /^(block|bhblock)$/.test(st.name) ? qSol[n].clone() : /^(touch|bhtouch)$/.test(st.name) ? delta.clone().multiply(lq)
        : st.name === 'bhunder' && st.rz != null && st.rz < 0.55 ? part(0.3).multiply(lq) : lq;
      Q.follow[n] = /^(block|bhblock)$/.test(st.name) ? qSol[n].clone() : part(n === 'armR' ? 0.7 : 0.5).multiply(fq);
    }
    this.rt = { name: st.name, err: rtErr, off: rtOff, at: st.contact.clone(), key: this._rtKey(st), Q, S: { fwd: base.fwd, fol: base.fol, load, contact, follow, low: base.low, early: base.early } };
  }
  setIdentity(name, slot) {
    if (name === this.identity) return;
    this.identity = name;
    this.look = this.lookFor(name, slot);
    this.h.setLook(this.look);
  }
  // f: { p: snapshot row (interpolated), ball, dt, t, frozen (hit-stop), stroke: { kind, u, x, y, z,
  // air } | null, charge: 0..1.3 or -1, chargeKind, splitAgo, won, lost }
  update(f) {
    const { t } = f;
    const dt = f.frozen || !(f.dt > 0) ? 0 : Math.min(f.dt, 1);
    const Q = this.Q, W = this.W, AD = this.AD, h = this.h;
    // Always clear the flourish before stroke planning/IK, including interrupted wins and replay.
    this.racket.quaternion.copy(this.racketBase);
    // the snapshot row, every field finite (a missing or broken field reads as its resting value)
    const fw = this.fw || (this.fw = new Footwork(h));
    const p = fw.row(f.p);
    const x = p[0], y = p[1], vx = p[2], vy = p[3];
    const ch = p[6], dive = p[8], stun = p[10], recover = p[11];
    const z = p[14], vz = p[15], squat = p[16], landT = p[17];
    // facing and gait (footwork.js): the body is organised round the net, not round the stick
    // (a shot being readied or struck: the body stands up out of the running crouch into it)
    const shotOn = !!((f.stroke && f.stroke.u > -0.6 && f.stroke.u < 0.5) || (f.prep && f.prep.eta < 0.6));
    const mode = fw.pre(f, p, dt, { shot: shotOn, lunge: this.lungeW > 0.3, lungeSide: this.lungeSide, lungeRising: this.lungeRising, strokeYawWant: this.strokeYawWant, strokeYawW: this.strokeYawW });
    this.yaw = fw.yaw; this.gait = mode;
    if (fw.snap) { this.lungeW = 0; this.lungeGX = this.lungeGZ = 0; this.reachX = this.reachZ = this.reachLift = 0; this.lungeAt = null; }
    const sp = Math.hypot(vx, vy);
    // the stance's weight follows how fast the feet are really going (the stepped gaits keep the
    // racket up and the ready shape; the mocap run lets the arms swing)
    this.speed = lerp(this.speed, fw.run ? sp : z > 0.02 ? 0 : Math.min(sp, 0.5), clamp(10 * dt, 0, 1));
    // split step: a small hop as the opponent strikes, landing ready (0.25 s)
    const sa = f.splitAgo;
    this.hop = sa != null && sa >= 0 && sa < 0.25 && z < 0.02 && fw.feetBy === 'plan' ? Math.sin(Math.PI * sa / 0.25) * 0.07 : 0;
    this.root.position.set(x, z + this.hop, y);
    this.root.rotation.y = this.yaw;
    fw.diveRig(dt);

    const cs = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    // shuttle in the player's own frame: side (+ = racket side, the right), forward, height
    const toLocal = (wx, wy, wz) => { const dx = wx - x, dz = wy - y; return { side: -(dx * cs - dz * sn), fwd: dx * sn + dz * cs, up: wz - z }; };
    const bl = f.ball ? toLocal(f.ball[0], f.ball[1], f.ball[2]) : { side: 0, fwd: 1, up: 1 };

    Q.zero(); W.fill(0); this.fast.fill(1); AD.zero();
    const T = this.T;
    const blend = (src, w, bones) => {
      if (w <= 0.001) return;
      for (const i of bones) { const nw = W[i] + w * (1 - W[i]), k = w / nw; for (let c = i * 3; c < i * 3 + 3; c++) Q.r[c] += (src.r[c] - Q.r[c]) * k; W[i] = nw; }
    };
    const seed = this.look ? this.look.seed : 0;
    const air = z > 0.02 || squat > 0;
    // ---- stance: the ready position, over the mocap, whenever the player is not running
    // (the stepped gaits keep it: footwork.js moves the feet under it; the mocap run owns the legs)
    const idle = 1 - smooth(0.6, 3.2, this.speed);
    this.legW = lerp(this.legW == null ? 1 : this.legW, fw.run ? 0 : 1, clamp(12 * dt, 0, 1));
    T.zero(); stance(T, t, seed, 1);
    blend(T, air ? 0.6 : Math.max(idle * 0.9, 0.35), UPPER_I);
    blend(T, air ? 0 : this.legW, LEG_I);

    // ---- legs: jump, landing, lunge, dive
    const crouchW = squat > 0 ? 1 : 0;
    // the push-off lasts the first moment of the rise; then the tuck; coming down, the legs reach
    // for the floor over the last ~0.4 m
    const ext = z > 0.02 && vz > 0 ? smooth(0.6, 0.95, vz / 4.6) : 0;
    const reach = z > 0.02 && vz < 0 ? smooth(0.42, 0.1, z) : 0;
    const tuck = z > 0.02 ? (1 - ext) * (1 - reach) : 0;
    this.jumpW = lerp(this.jumpW, air ? 1 : 0, clamp(30 * dt, 0, 1));
    const st = f.stroke;
    const kick = st && st.air && st.name === 'smash' ? clamp(st.u / 0.12, -1, 1) : 0;
    if (this.jumpW > 0.01) { T.zero(); jumpLegs(T, crouchW, ext, tuck, reach, kick); blend(T, this.jumpW, [...LEG_I, boneIndex('hips'), boneIndex('spine'), boneIndex('armL'), boneIndex('foreL')]); }
    // landing absorb: deeper after a hard landing, easing out over the landing beat
    const landW = landT > 0 && z < 0.02 ? clamp(landT / 8, 0, 1) : 0;
    this.land = lerp(this.land, landW, clamp(20 * dt, 0, 1));
    if (this.land > 0.01) { T.zero(); landing(T, this.land); blend(T, this.land, [...LEG_I, boneIndex('hips'), boneIndex('spine')]); }
    // lunge: a low shot met wide or in front reaches out on the racket-side leg
    let lungeWant = 0;
    // (and deeper the lower the shuttle: an ankle-high one is met from the bottom of the lunge)
    if (st && !air && STROKES[st.name] && (STROKES[st.name].low || (st.rz != null && st.rz < 1.6 && st.reach > 0.95)) && st.reach > 0.55) lungeWant = bump(st.u, 0.35) * clamp(Math.max((st.reach - 0.6) / 0.5, st.rz != null && st.reach > 0.75 ? (1.0 - st.rz) / 0.6 : 0), 0, 1);
    // it starts before the hit is known: from the predicted contact (render3d prep), a real lunge
    // is under way ~0.3 s out, so the player is at the bottom of it as the shuttle arrives
    const pq = f.prep;
    if (pq && !air && STROKES[pq.name] && STROKES[pq.name].low) {
      const rch = Math.hypot(pq.side, pq.fwd);
      const amt = clamp(Math.max((rch - 0.6) / 0.5, rch > 0.75 ? (1.0 - pq.rz) / 0.6 : 0), 0, 1) * smooth(0.5, 0.12, pq.eta);
      // (the corner is taken from the shot that wants it: deeper than the lunge now, or the other
      // corner - a forehand lunge straight into a backhand one changes sides)
      const dirP = pq.side < -0.2 ? -1 : 1;
      if (amt > lungeWant) { lungeWant = amt; if (amt > this.lungeW || dirP !== this.lungeDir) { this.lungeSide = 1; this.lungeDir = dirP; this.lungeAt = [pq.side, pq.fwd]; } }
    }
    // the front foot is always the racket foot (lungeSide +1 for footwork.js); lungeDir: which corner
    if (st && lungeWant > 0.05 && (lungeWant > this.lungeW || (st.side < -0.2 ? -1 : 1) !== this.lungeDir)) { this.lungeSide = 1; this.lungeDir = st.side < -0.2 ? -1 : 1; if (st.fwd != null) this.lungeAt = [st.side, st.fwd]; }
    this.lungeRising = lungeWant > this.lungeW + 0.02 && this.lungeW < 0.75;
    this.lungeW = lerp(this.lungeW, lungeWant, clamp((lungeWant > this.lungeW ? 26 : 12) * dt, 0, 1));
    if (this.lungeW > 0.01) { T.zero(); lunge(T, 1, this.lungeDir || 1); blend(T, this.lungeW, LEG_I); }
    // the lunge carries the body out toward the shuttle: the step puts the hips over the front foot
    // (up to ~0.5 m for a shuttle at the edge of reach), the trail foot staying where it was
    {
      const la = this.lungeAt, r = la ? Math.hypot(la[0], la[1]) : 0, m = r > 1e-3 ? this.lungeW * clamp(r - 0.6, 0, 0.5) * (1 - this.diveW) : 0;
      const gx = m > 1e-4 ? -la[0] / r * m : 0, gz = m > 1e-4 ? la[1] / r * m : 0, kg = clamp(14 * dt, 0, 1); // (eased: the aim of it can change)
      this.lungeGX = lerp(this.lungeGX || 0, gx, kg); this.lungeGZ = lerp(this.lungeGZ || 0, gz, kg);
      h.group.position.x = this.lungeGX; h.group.position.z = this.lungeGZ;
    }
    // the dive, the slide and the get-up (footwork.js): the whole body, on the sim's clock
    const dvW = diveWeight(mode, fw.dive.s);
    this.diveW = fw.snap ? dvW : lerp(this.diveW, dvW, clamp((dvW > this.diveW ? 30 : 10) * dt, 0, 1));
    if (this.diveW > 0.01) { T.zero(); diveBody(T, mode === 'dive' || mode === 'slide' || mode === 'getup' ? mode : 'getup', clamp(fw.dive.t / DIVE_TIME, 0, 1), mode === 'dive' ? 0 : fw.dive.s); blend(T, this.diveW, ALL_I); }

    // ---- the racket arm and trunk: anticipation, the charge (LOAD by the charge), then the stroke.
    // Each layer blends over the one before, so a stroke that starts from a charged or prepared
    // LOAD of the same stroke (render3d picks chargeKind / prep with strokeFor) continues it.
    const charging = ch >= 0;
    const B = h.bone;
    const inStroke = !!(st && st.u > -0.6 && st.u < 0.6 && STROKES[st.name]);
    const loadOf = name => { const S = STROKES[name] || STROKES.over; T.zero(); for (const bone of UPPER) if (sampleStroke(S, bone, -1, 1, this.tmp)) T.set(bone, this.tmp[0], this.tmp[1], this.tmp[2]); };
    // anticipation: as the shuttle comes, the racket comes up and the body turns into the stroke it
    // will need (a third of the way to its LOAD a second out, two thirds just before the swing)
    const pr = f.prep && !inStroke && STROKES[f.prep.name] ? f.prep : null;
    // (let go of calmly when it will not be played: out of reach, or leaving one going out)
    // Each stroke readied keeps its own weight, so a change of mind cross-fades rather than snaps.
    const prWant = pr ? 0.65 * smooth(1.2, 0.25, pr.eta) + 0.25 * smooth(1.6, 1.0, pr.eta) : 0;
    const preps = this.preps || (this.preps = {});
    if (pr && !(pr.name in preps)) preps[pr.name] = 0;
    let overheadNow = 0;
    for (const n in preps) {
      const want = pr && n === pr.name ? prWant : 0, cur = preps[n];
      preps[n] = lerp(cur, want, clamp((want > cur ? 8 : 2.5) * dt, 0, 1));
      if (preps[n] < 0.005 && want === 0) { delete preps[n]; continue; }
      loadOf(n); blend(T, preps[n], UPPER_I);
      if (/^(over|smash|kill)$/.test(n)) overheadNow = Math.max(overheadNow, preps[n]);
    }
    if ((charging && !inStroke) || this.chargeW) {
      // the charge draws the LOAD back as it builds; a change of the stroke it is loading (the
      // shuttle coming lower, or the charge reaching kill / smash power) cross-fades like the prep,
      // and when the stroke itself takes over the charge hands over to it rather than vanishing
      const on = charging && !inStroke, c = clamp(ch / 42, 0, 1.15);
      const name = on ? (STROKES[f.chargeKind] ? f.chargeKind : 'over') : null;
      const cw = this.chargeW || (this.chargeW = {});
      if (name && !(name in cw)) cw[name] = 0;
      for (const n in cw) {
        const want = n === name ? smooth(0, 0.5, c) : 0;
        cw[n] = lerp(cw[n], want, clamp((want > cw[n] ? 14 : inStroke ? 6 : 8) * dt, 0, 1));
        if (cw[n] < 0.005 && want === 0) { delete cw[n]; continue; }
        loadOf(n); blend(T, cw[n], UPPER_I);
        if (/^(over|smash|kill)$/.test(n)) overheadNow = Math.max(overheadNow, cw[n]);
      }
      // past full charge the muscles start to shake: overcooked
      if (on && c > 1) AD.add('armR', Math.sin(t * 38) * 0.03 * (c - 1) * 6, 0, 0);
      if (!Object.keys(cw).length) this.chargeW = null;
    }
    // a stroke that appears (the hit record arrives a few frames before it is drawn) eases in over
    // 50 ms from whatever the prep and charge had
    this.strokeRamp = inStroke ? Math.min(1, (this.strokeRamp || 0) + (dt > 0 ? dt / (/^(block|bhblock)$/.test(st.name) ? 0.12 : 0.09) : 0)) : 0;
    if (inStroke) {
      // this stroke retargeted onto this shuttle (see _retarget), once it has been solved
      const rt = this.rt && this.rt.name === st.name && st.contact && this.rt.at && this.rt.at.distanceTo(st.contact) < 0.35 ? this.rt : null;
      const S = rt ? rt.S : STROKES[st.name];
      T.zero();
      for (const bone of UPPER) {
        // (the racket arm's own small leads fold to zero at the contact itself, so the arm is at
        // the retargeted contact key exactly when the shuttle is there)
        const armB = /^(armR|foreR|handR)$/.test(bone);
        const lead = (LEAD[bone] || 0) * (armB ? 1 - bump(st.u, 0.05) : 1);
        // (the racket arm swings in rotations onto the solved contact: sampleArmQ)
        if (armB && rt && rt.Q ? sampleArmQ(S, rt.Q, bone, st.u + lead, this.tmp) : sampleStroke(S, bone, st.u + lead, 1, this.tmp)) T.set(bone, this.tmp[0], this.tmp[1], this.tmp[2]);
      }
      // in and out of the stroke: it owns the upper body from the wind-up to the end of the
      // follow-through, then hands back to the stance
      const w = smooth(-0.45, -S.fwd - 0.02, st.u) * (1 - smooth(S.fol + 0.08, S.fol + 0.34, st.u));
      // from a dive the stroke is a stretched reach out of the dive pose: the dive keeps the trunk
      // and the free arm, the stroke (and the IK) only the racket arm
      const diving = this.diveW > 0.3;
      blend(T, w * this.strokeRamp, diving ? ARM_R_I : UPPER_I);
      // a stroke is fast: let the filter follow it (otherwise the whip is smoothed into a wave)
      // (near the contact the racket arm is not filtered at all in effect: the swing is already
      // continuous, and a filter lag of 10 ms at 40 rad/s would put the racket 40 cm behind the
      // shuttle, which the IK would then have to snap onto it)
      const k = 1 + 4 * bump(st.u, 0.2), ka = 1 + 40 * bump(st.u, 0.22), kt = 1 + 10 * bump(st.u, 0.22);
      for (const i of UPPER_I) this.fast[i] = k;
      for (const i of TRUNK_I) this.fast[i] = kt;
      for (const i of ARM_R_I) this.fast[i] = ka;
      if (/^(over|smash|kill)$/.test(st.name) && st.u < 0) overheadNow = Math.max(overheadNow, w);
    }
    // the trunk helps the arm reach: folds forward over a low shuttle, leans to a wide one, arches
    // back under one that got behind, leans away for a round-the-head overhead, and backs off one
    // met at the body. Aimed from the stroke (or, before it, the one being readied) and eased, so
    // the body is already going down to a low one as the swing starts, never dropping in a frame.
    {
      const src = inStroke && st.rz != null ? st : pr, L = this.lean || (this.lean = new Float32Array(10));
      const tgt = this._leanT || (this._leanT = new Float32Array(10)); tgt.fill(0);
      const diving = this.diveW > 0.3;
      if (src && !diving) {
        const k2 = inStroke ? bump(st.u, 0.4) : clamp(prWant * 1.2, 0, 1), sg = src.side < 0 ? -1 : 1, nm = src.name;
        if (/^(over|smash|kill)$/.test(nm)) {
          const behind = clamp((-src.fwd - 0.1) / 0.5, 0, 1), rth = clamp((-src.side - 0.1) / 0.5, 0, 1);
          const high = clamp((src.rz - 2.2) / 0.5, 0, 1) * (z > 0.02 ? 0 : 1); // tall through the left side, up on the toes
          tgt[1] = -0.1 * behind; tgt[2] = -(0.14 * rth + 0.08 * high); tgt[3] = -0.12 * behind; tgt[4] = -(0.14 * rth + 0.1 * high); tgt[7] = 0.3 * high; tgt[8] = 0.35 * high;
        } else {
          const low = clamp((1.15 - src.rz) / 0.9, 0, 1), wide = clamp((Math.abs(src.side) - 0.4) / 0.8, 0, 1), far = clamp((src.fwd - 0.4) / 0.6, 0, 1);
          const jam = clamp((0.62 - Math.hypot(src.side, src.fwd)) / 0.3, 0, 1) * (src.rz > 0.7 && src.rz < 1.75 ? 1 : 0), tw = src.side < 0.12 ? 1 : -0.7;
          tgt[0] = 0.2 * low; tgt[1] = 0.34 * low + 0.14 * far - 0.2 * jam; tgt[2] = sg * 0.16 * wide; tgt[3] = 0.22 * low + 0.1 * far - 0.16 * jam; tgt[4] = sg * 0.14 * wide;
          tgt[5] = 0.3 * tw * jam; tgt[6] = 0.35 * tw * jam; tgt[9] = 0.3 * tw * jam;
        }
        for (let i = 0; i < 10; i++) tgt[i] *= k2;
      }
      const kl = clamp(12 * dt, 0, 1);
      for (let i = 0; i < 10; i++) L[i] += (tgt[i] - L[i]) * kl;
      AD.add('hips', L[0], L[9]); AD.add('spine', L[1], L[5], L[2]); AD.add('chest', L[3], L[6], L[4]);
      if (L[7] > 1e-3) { AD.add('footL', L[7]); AD.add('footR', L[8]); }
    }
    // the body turn a stroke asks for (radians, + = the racket shoulder drawn away from the net):
    // side-on for an overhead. The facing logic may honour it (this.strokeYawWant, 0..1 weight).
    // (backhands: footwork.js turns the right shoulder to the net by the stroke's name itself)
    this.strokeYawWant = 0.75; this.strokeYawW = overheadNow;
    // the free arm points up at a high shuttle while an overhead loads (it aims and balances), then
    // pulls down into the chest as the racket arm comes through: set in the pose, so it is filtered
    this.track = lerp(this.track || 0, overheadNow > 0.2 && bl.up > 1.4 && bl.fwd > -0.8 && (!st || st.u < -0.04) ? 1 : 0, clamp(9 * dt, 0, 1));
    if (this.track > 0.01 && f.ball) {
      const r = h.ref[boneIndex('armL')][0];
      const d = _a.set(f.ball[0], f.ball[2], f.ball[1]).sub(B.upperarm_l.getWorldPosition(_b)).normalize();
      d.applyQuaternion(_q1.copy(B.upperarm_l.parent.getWorldQuaternion(_q2)).multiply(r.Ci).invert());
      const phi = Math.asin(clamp(d.x, -0.6, 0.9));
      let th = -Math.atan2(d.z, -d.y); if (th > 0.5) th -= Math.PI * 2; // forward -pi/2, up -pi, behind-up past it
      T.zero(); T.set('armL', clamp(th, -2.9, -0.6), 0, phi); T.set('foreL', -0.3, 0, 0); T.set('handL', 0.1, 0, 0);
      blend(T, this.track * 0.9, [boneIndex('armL'), boneIndex('foreL'), boneIndex('handL')]);
    }

    // ---- reactions
    if (stun) { AD.add('neck', 0.18, Math.sin(t * 4.1) * 0.2, 0); AD.add('head', 0.1, Math.sin(t * 5.3) * 0.25, 0); AD.add('spine', 0.12); }
    if (recover && !st) AD.add('spine', 0.06);
    const canCelebrate = !inStroke && !f.prep && !charging && !dive && !recover && z < 0.04 && sp < 0.7;
    const celebration = samplePointCelebration(this, f.won,
      Number.isInteger(f.celebration) ? ((f.celebration % 3) + 3) % 3 : 0, canCelebrate);
    if (celebration.weight > 0) {
      const k = celebration.weight, a = celebration.anticipation, beat = celebration.accent;
      // Upper body only: Footwork keeps its planted feet and hips under the athlete.
      T.zero();
      if (celebration.variant === 0) {
        T.set('armR', -0.65 + a * 0.16, 0.12, -0.64); T.set('foreR', -1.15 - a * 0.2, 0, 0);
        T.set('handR', -0.08, 0, -0.04); T.set('armL', -0.22, 0, 0.28); T.set('foreL', -1.0, 0, 0);
        T.set('chest', -0.055, 0.08, 0); T.set('neck', -0.08, 0, 0);
      } else if (celebration.variant === 1) {
        T.set('armL', -0.85 - 0.22 * beat, 0, 0.86); T.set('foreL', -1.55 - 0.24 * beat, 0, 0);
        T.set('handL', 0.06, 0, -0.12); T.set('chest', -0.07 - 0.04 * beat, 0, 0); T.set('neck', -0.12, 0, 0);
      } else {
        T.set('armR', -0.8, 0.2, -1.18); T.set('foreR', -1.12, 0, 0); T.set('handR', -0.16, 0, -0.05);
        T.set('armL', -0.12, 0, 0.32); T.set('foreL', -0.8, 0, 0); T.set('chest', -0.09, 0.07, 0); T.set('neck', -0.14, 0, 0);
      }
      blend(T, k, CELEBRATION_I);
    }
    if (f.lost != null && f.lost < 2.2) { const k = bump(f.lost - 0.9, 0.9); AD.add('spine', 0.22 * k); AD.add('neck', 0.35 * k); AD.add('head', 0.2 * k); }
    // head and eyes on the shuttle: the direction from the eyes, in the frame the neck turns in
    // (the chest as it is, so a trunk twisted into a stroke is allowed for), split between neck and
    // head within what a neck turns (~70 deg each way, 55 up, 60 down); the eyes do the rest
    if (f.ball && h.ref) {
      const r = h.ref[boneIndex('neck')][0], nk = B.neck_01;
      const eye = B.Head.getWorldPosition(_a); eye.y += 0.1;
      const d = _b.set(f.ball[0], f.ball[2], f.ball[1]).sub(eye);
      d.applyQuaternion(_q1.copy(nk.parent.getWorldQuaternion(_q2)).multiply(r.Ci).invert());
      const yawTo = clamp(Math.atan2(d.x, Math.max(0.05, d.z)), -1.25, 1.25);
      const pitchTo = clamp(Math.atan2(-d.y, Math.hypot(d.x, d.z)), -0.95, 1.0);
      // the head follows at a head's pace (a quick saccade-and-turn, ~12 rad/s at most), the eyes
      // leading: a shuttle leaving the racket at 60 m/s does not whip the head round in a frame
      const mx = 12 * dt;
      this.lookY = this.lookY == null ? yawTo : this.lookY + clamp(yawTo - this.lookY, -mx, mx);
      this.lookP = this.lookP == null ? pitchTo : this.lookP + clamp(pitchTo - this.lookP, -mx, mx);
      T.zero(); T.set('neck', this.lookP * 0.45, this.lookY * 0.45, 0); T.set('head', this.lookP * 0.55, this.lookY * 0.55, 0);
      blend(T, 0.88, [boneIndex('neck'), boneIndex('head')]);
    }
    // lean into the run and its accelerations, back against a braking step
    if (!air && fw.feetBy !== 'free') { AD.add('spine', fw.lean.f * 0.6, 0, fw.lean.r * 0.6); AD.add('chest', fw.lean.f * 0.4, 0, fw.lean.r * 0.4); }
    // the gait's rhythm through the upper body (footwork.js: one phase clock, the left foot landing
    // at 0): each arm swings against its leg, the shoulders turn against the hips, more with pace.
    // The free arm swings fully; the racket arm, carrying the racket up, a little.
    {
      const on = fw.gOn && fw.feetBy === 'plan' && !air && !inStroke ? 1 : 0;
      this.swingW = lerp(this.swingW || 0, on * smooth(0.6, 6, sp), clamp(8 * dt, 0, 1));
      if (this.swingW > 0.01) {
        const c = Math.cos(2 * Math.PI * (fw.gph || 0)) * this.swingW, run = fw.runW || 0;
        AD.add('armL', 0.62 * c, 0, 0); AD.add('foreL', -0.25 * Math.abs(c) - 0.35 * run * this.swingW, 0, 0);
        AD.add('armR', -0.22 * c, 0, 0);
        AD.add('chest', 0, 0.1 * c, 0); AD.add('hips', 0, -0.08 * c, 0);
        AD.add('head', 0, -0.05 * c, 0);
      }
    }
    if (this._liftOn) { h.group.position.y -= this._liftOn; this._liftOn = 0; } // (last frame's reaching hop: not the pose's)
    h.animate(dt, t, fw.animSpeed, Q, W, { pose: AD, lift: 0, clips: {}, serverPhase: null, dir: 1, cadence: fw.cadence, floorOnly: fw.feetBy === 'free', fast: this.fast, spring: !inStroke && !f.prep && this.lungeW < 0.05 && this.diveW < 0.05 });
    if (celebration.variant === 1 && celebration.weight > 0) {
      for (const [bone, q] of this.fist) bone.quaternion.slerp(q, celebration.weight);
    }
    // (springs - human.js _spring - only while no shot is coming: moving and waiting. From the
    // moment a shot is prepared the stroke layer drives the arm exactly as it is tuned to)
    // the feet on the floor (planned steps, locked strides, leg IK) and nothing through the floor
    // the hips over the player's position: the pose (the crouch, the trunk's lean) sets where the
    // pelvis sits in the model; the model is moved so the hips are over the point the feet are
    // planned round (and the body turns about its own hips). The offset is followed smoothly and
    // held through a shot: a stroke's hip turn must not slide the shoulders under the racket arm.
    // Not in a dive: that has its own line
    {
      const g = h.group, w = 1 - this.diveW;
      h.root.updateMatrixWorld(true);
      const hm = _a.copy(B.thigh_l.getWorldPosition(_b)).add(B.thigh_r.getWorldPosition(_b)).multiplyScalar(0.5);
      g.worldToLocal(hm); // (the model's own frame, before the group's offset and scale)
      const sc = g.scale.y || 1, c = this.cOff || (this.cOff = [0, 0]);
      // (readying a shot it eases to the stance the strokes are tuned to; through the swing it holds)
      const swinging = !!(f.stroke && f.stroke.u > -0.6 && f.stroke.u < 0.5), readying = !swinging && !!(f.prep && f.prep.eta < 0.6);
      const kc = fw.snap ? 1 : swinging || fw.dive.on ? 0 : clamp((readying ? 9 : 6) * dt, 0, 1);
      // (moving: centred; standing, the stance is as the strokes are tuned to it - the feet still
      // stand under the hips: see footwork.js anchor)
      const mv = fw.ballW || 0; // (the same blend the feet use: see footwork.js anchor)
      c[0] += (hm.x * sc * mv - c[0]) * kc; c[1] += (hm.z * sc * mv - c[1]) * kc;
      if (w > 1e-3) { g.position.x -= c[0] * w; g.position.z -= c[1] * w; }
    }
    h.root.updateMatrixWorld(true);
    fw.post(f, p, dt, this.hop);

    // ---- after the pose: the racket onto the shuttle at contact. The swing is not frozen onto the
    // shuttle: the IK retargets the swing's own path about the shoulder, so the racket sweeps
    // through the contact point at full speed. Before contact the correction is the rotation from
    // where the unsolved swing is heading (its direction from the shoulder, run on at its current
    // angular rate, allowing for the swing still accelerating) to the shuttle, exact at u = 0; after
    // contact it holds, so the follow-through carries on along the corrected line.
    // a shuttle just out of reach overhead: up off the floor to it (a small reaching hop, as a
    // player does to take a high one), by what the retarget probe could not reach upward
    {
      const want = st && inStroke && z < 0.02 && /^(over|smash|kill|fh|bh)$/.test(st.name) && this.rt && this.rt.name === st.name && this.rt.off && this.rt.off.y > 0.03
        ? Math.min(this.rt.off.y + 0.1, 0.35) * bump(st.u, 0.2) : 0;
      this.reachLift = lerp(this.reachLift || 0, want, clamp(25 * dt, 0, 1));
      if (this.reachLift > 1e-3) { h.group.position.y += this.reachLift; this._liftOn = this.reachLift; }
      // and a shuttle just out of reach sideways or ahead: the body steps / leans into it by the
      // rest of the gap (up to 0.3 m), easing in toward the contact and back out after
      const o = st && inStroke && this.rt && this.rt.name === st.name && this.rt.off ? this.rt.off : null;
      const hl = o ? Math.hypot(o.x, o.z) : 0, sc = hl > 0.03 ? Math.min(hl + 0.03, 0.35) / hl * bump(st.u, 0.22) : 0;
      const wx = o ? o.x * sc : 0, wz = o ? o.z * sc : 0, cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      let lx = wx * cy - wz * sy, lz = wx * sy + wz * cy;
      // one at the body (a smash at the chest): the body gives ground, back and away from it, to
      // make room for the racket in front (up to 0.2 m)
      if (st && inStroke && st.fwd != null && st.rz > 0.7 && st.rz < 1.75) {
        const d = Math.hypot(st.side, st.fwd), give = clamp(0.55 - d, 0, 0.2) * bump(st.u, 0.3);
        if (give > 1e-3 && d > 1e-3) { lx += st.side / d * give; lz -= st.fwd / d * give; }
      }
      this.reachX = lerp(this.reachX || 0, lx, clamp(20 * dt, 0, 1)); this.reachZ = lerp(this.reachZ || 0, lz, clamp(20 * dt, 0, 1));
      if (Math.abs(this.reachX) + Math.abs(this.reachZ) > 1e-3) { h.group.position.x += this.reachX; h.group.position.z += this.reachZ; } // (the lunge block sets x / z afresh each frame)
    }
    h.root.updateMatrixWorld(true);
    if (st && st.contact && STROKES[st.name]) {
      const S = B.upperarm_r.getWorldPosition(_ikS), raw = this.sweet(_ikR);
      const rel = raw.sub(S), len = rel.length(), dir = rel.divideScalar(len || 1);
      const fresh = this.ikU == null || st.u < this.ikU - 1e-4 || st.u > this.ikU + 0.2;
      if (fresh) { this.ikPrev = null; this.ikCorr = null; h._clearA = 0; h._elbAb = null; }
      if (st.u <= 1e-4 || !this.ikCorr) {
        _ikP.copy(dir);
        if (this.ikPrev && dt > 0 && st.u < 0) {
          const ang = this.ikPrev.angleTo(dir), axis = _ikA.crossVectors(this.ikPrev, dir);
          if (axis.lengthSq() > 1e-10 && ang > 1e-4) {
            const xN = clamp(1 + st.u / STROKES[st.name].fwd, 0.3, 1);
            _ikP.applyAxisAngle(axis.normalize(), clamp(ang * (-st.u / dt) * (1 + xN) / (2 * xN), 0, 2.2));
          }
        }
        const tgt = _ikT.copy(st.contact).sub(S), tl = tgt.length();
        this.ikCorr = (this.ikCorr || new THREE.Quaternion()).setFromUnitVectors(_ikP, tgt.divideScalar(tl || 1));
        this.ikLen = tl - len;
      }
      if (dt > 0 || fresh) { this.ikPrev = (this.ikPrev || new THREE.Vector3()).copy(dir); this.ikU = st.u; }
      this.ikRawErr = this.sweet(_ikT).distanceTo(st.contact); // before the residual solve (diagnostics)
      if (Math.abs(st.u) < 1e-4 && this._rtPQ) this.rtDiag = RT_CHAIN.map((n, i) => n + ':' + h.ref[boneIndex(n)].map((r, j) => (2 * Math.acos(Math.min(1, Math.abs(r.bone.quaternion.dot(this._rtPQ[i][j]))))).toFixed(2)).join('/')).join(' ') + ' root:' + h.root.getWorldPosition(new THREE.Vector3()).distanceTo(this._rtPR).toFixed(3) + ' sweet:' + this.sweet(new THREE.Vector3()).distanceTo(this._rtPS).toFixed(3);
      const slow = /^(block|bhblock|touch|bhtouch)$/.test(st.name);
      const arm = [B.upperarm_r, B.lowerarm_r, B.hand_r];
      if (fresh) this.ikD = null;
      if (st.u <= 1e-4 || !this.ikD) {
        // up to the contact: solve onto the (moving) target, and present the face
        const q0 = this._ikQ0 || (this._ikQ0 = arm.map(() => new THREE.Quaternion()));
        arm.forEach((b, i) => q0[i].copy(b.quaternion));
        this._rawPrevOk = !!this._rawAt0 && !fresh && dt > 0;
        if (this._rawPrevOk) (this._rawPrev || (this._rawPrev = new THREE.Vector3())).copy(this._rawAt0);
        (this._rawAt0 || (this._rawAt0 = new THREE.Vector3())).copy(this.sweet(_ikT));
        const w = smooth(slow ? -0.2 : -0.12, slow ? -0.04 : -0.02, st.u) * this.strokeRamp;
        if (w > 0.001) {
          // the retargeted swing arrives within rt.off of the shuttle (what the probe could not
          // reach, or the trunk and lean it did not model): close that gap over the last of the
          // swing by offsetting the swing's own path, and at the contact frame itself go exactly
          const rtOk = this.rt && this.rt.name === st.name && this.rt.off;
          // over the last frames the gap is measured instead: the unsolved swing run on at its
          // current velocity to the contact instant (exact as u -> 0), so the contact frame has
          // nothing left to snap
          let target;
          if (slow) target = _ikT.copy(st.contact); // (a block or touch: the face is simply put there, the racket barely moving)
          else if (rtOk && st.u < -1e-4) {
            const rawNow = this._rawAt0, off = _ikO.copy(this.rt.off);
            target = _ikT.copy(rawNow).add(off);
          } else target = _ikT.copy(dir).applyQuaternion(this.ikCorr).multiplyScalar(Math.max(0.2, len + this.ikLen)).add(S);
          const e = ELBOW[st.name] || ELBOW.fh;
          const pole = _ikA.set(-cs * e[0] + sn * e[2], e[1], sn * e[0] + cs * e[2]);
          solveArm(h, this.sweet, target, w, pole, /^(under|touch)$/.test(st.name) ? 1 : STROKES[st.name].low ? 0.85 : 0.6, 0.35 + 1.1 * bump(st.u, 0.12), 0.35 + 1.1 * bump(st.u, 0.045));
        }
        // the strings square to where the shot is going (the aim, risen or dipped per stroke): the
        // forearm turns into it through the last of the swing
        const wf = smooth(slow ? -0.25 : -0.2, slow ? -0.06 : -0.03, st.u) * this.strokeRamp;
        if (wf > 0.001) {
          const al = Math.hypot(p[4], p[5]) || 1, up = FACE_UP[st.name] != null ? FACE_UP[st.name] : 0.2;
          this.faceAng = faceTo(h, this.racket, this.sweet, _ikA.set(p[4] / al, up, p[5] / al).normalize(), wf, /^bh/.test(st.name) ? 1 : -1, fresh ? null : this.faceAng);
        }

        // what the solve did to the arm this frame (kept: after the contact it fades out from here)
        const D = this.ikD || (this.ikD = arm.map(() => new THREE.Quaternion()));
        arm.forEach((b, i) => D[i].copy(b.quaternion).multiply(_q1.copy(q0[i]).invert()));
        // and the gap the swing itself had at the contact, to carry on through the follow-through
        (this.ikOff || (this.ikOff = new THREE.Vector3())).copy(st.contact).sub(this._rawAt0 || this.sweet(_ikT));
      } else if (FOLLOW[st.name]) {
        // after the contact of a drive, lift, net shot or block: the racket head carries on from the
        // shuttle along the shot (toward the aim, across the body, rising for a lift), steered by
        // the IK on a path that starts at the contact point, then hands back to the pose
        const Fd = FOLLOW[st.name], S0 = STROKES[st.name], al = Math.hypot(p[4], p[5]) || 1;
        const ax = p[4] / al, ay = p[5] / al; // the aim, sim x / y
        const rx = -cs, rz = sn; // the body's right, world x / z
        const e3 = 1 - Math.pow(1 - clamp(st.u / S0.fol, 0, 1), 3);
        const k = 1 - smooth(S0.fol, S0.fol + 0.2, st.u);
        if (k > 0.001) {
          const target = _ikT.copy(st.contact);
          target.x += (ax * Fd[0] + rx * Fd[1]) * e3; target.y += Fd[2] * e3; target.z += (ay * Fd[0] + rz * Fd[1]) * e3;
          const e = ELBOW[st.name] || ELBOW.fh;
          solveArm(h, this.sweet, target, k, _ikA.set(-cs * e[0] + sn * e[2], e[1], sn * e[0] + cs * e[2]), 0.6);
          const kf = 1 - smooth(0.03, 0.2, st.u);
          if (kf > 0.001) { const up = FACE_UP[st.name] != null ? FACE_UP[st.name] : 0.2; this.faceAng = faceTo(h, this.racket, this.sweet, _ikA.set(ax, up, ay).normalize(), kf, /^bh/.test(st.name) ? 1 : -1, this.faceAng); }
        }
      } else {
        // after the contact: the contact's correction carried into the follow-through and eased
        // out, the same rotation each frame (no re-solve, so nothing can flip mid-follow-through)
        const k = 1 - smooth(0.04, slow ? 0.3 : 0.28, st.u);
        arm.forEach((b, i) => { b.quaternion.premultiply(_q1.identity().slerp(this.ikD[i], k)); });
        B.upperarm_r.updateMatrixWorld(true);
        capArm(h, 2.97);
      }
      // retarget the stroke's contact key onto this shuttle for the frames to come (kept up to date
      // until just before contact: a jump or a lunge moves the shoulder under it)
      // (a compact stroke is solved once: re-solving a jammed one frame by frame can flip between
      // arm configurations)
      if (inStroke && ((st.u < -0.03 && !(STROKES[st.name].low && /block|touch/.test(st.name) && this.rt && this.rt.key === this._rtKey(st))) || !this.rt || this.rt.key !== this._rtKey(st))) {
        const tl = st.u < 0 && z > 0.02 ? vz * -st.u - 7 * st.u * st.u : 0; // root rise still to come
        this._retarget(st, cs, sn, tl);
      }
      // ---- and nothing through the body: once the frame's pose is final, swim the upper arm about
      // the shoulder -> racket line (the strings stay on the shuttle) to the nearest angle that
      // keeps the forearm and racket out of the trunk and head. A servo: it moves at most a step a
      // frame and eases back when the pose is clear, so it never snaps and never flips sides.
      clearBody(h, this.sweet, st.contact);
    } else { this.ikU = null; h._clearA = 0; h._elbAb = null; }
    setGripSpin(this.racket.quaternion, this.racketBase, celebration.angle);
    this.racket.updateMatrixWorld(true);
    this.apparel.update(dt, sp, inStroke ? 1 : celebration.weight * 0.4);
    // the racket head's recent path, for the swing trail
    const head = this.sweet(new THREE.Vector3());
    this.whoosh.unshift({ p: head, t }); if (this.whoosh.length > 10) this.whoosh.pop();
    this.swingSpeed = this.whoosh.length > 1 && t > this.whoosh[1].t ? head.distanceTo(this.whoosh[1].p) / (t - this.whoosh[1].t) : 0;
  }
}
