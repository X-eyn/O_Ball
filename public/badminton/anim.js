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

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const easeIn = t => t * t, easeOut = t => 1 - (1 - t) * (1 - t);
const bump = (u, w) => { const x = clamp(1 - Math.abs(u) / w, 0, 1); return x * x * (3 - 2 * x); };

const UPPER = ['hips', 'spine', 'chest', 'neck', 'head', 'clavR', 'armR', 'foreR', 'handR', 'clavL', 'armL', 'foreL', 'handL'];
const LEGS = ['thighL', 'shinL', 'footL', 'toeL', 'thighR', 'shinR', 'footR', 'toeR'];
const UPPER_I = UPPER.map(boneIndex), LEG_I = LEGS.map(boneIndex), ALL_I = [...UPPER_I, ...LEG_I];
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
  over: {
    fwd: 0.11, fol: 0.16,
    load: P({ hips: [0.02, -0.34, 0], spine: [-0.1, -0.14, 0], chest: [-0.22, -0.22, 0.06], neck: [-0.28, 0.2, 0], head: [-0.3, 0.1, 0],
      clavR: [-0.2, 0, -0.35], armR: [0.35, 0.9, -2.05], foreR: [-2.05, 0, 0], handR: [0.55, 0, 0.2],
      clavL: [-0.1, 0, 0.2], armL: [-1.25, 0, 1.55], foreL: [-0.25, 0, 0], handL: [0, 0, 0] }),
    contact: P({ hips: [0.04, 0, 0], spine: [0.04, 0, 0], chest: [0.04, 0.02, -0.06], neck: [-0.25, -0.1, 0], head: [-0.28, 0, 0],
      clavR: [-0.25, 0, -0.3], armR: [-0.65, 0.45, -2.5], foreR: [-0.12, 0, 0], handR: [-0.6, 0, -0.1],
      clavL: [0, 0, 0.1], armL: [-0.7, 0, 0.35], foreL: [-1.6, 0, 0], handL: [0, 0, 0] }),
    follow: P({ hips: [0.1, 0.3, 0], spine: [0.22, 0.12, 0], chest: [0.3, 0.22, -0.05], neck: [0.05, -0.2, 0], head: [0.05, 0, 0],
      clavR: [0, 0, -0.05], armR: [-1.0, 0.9, -0.55], foreR: [-0.6, 0, 0], handR: [-0.7, 0, -0.2],
      clavL: [0, 0, 0.05], armL: [0.25, 0, 0.3], foreL: [-1.2, 0, 0], handL: [0, 0, 0] }),
  },
  // the smash: the same stroke, arched harder, uncoiled harder, and folded right through
  smash: {
    fwd: 0.1, fol: 0.2,
    extend: { load: { chest: [0.08, -0.02, 0], spine: [0.04, 0, 0] }, follow: { chest: [0.18, 0.02, 0], spine: [0.12, 0, 0], armR: [0.25, 0.2, 0.2], hips: [0.06, 0, 0] } },
  },
  // the net kill: a short, sharp overhead tap with the wrist doing the work
  kill: {
    fwd: 0.06, fol: 0.1,
    load: P({ chest: [-0.05, -0.12, 0], spine: [0.05, -0.05, 0], neck: [-0.15, 0, 0], head: [-0.12, 0, 0], clavR: [-0.2, 0, -0.25],
      armR: [-0.1, -0.2, -2.3], foreR: [-1.35, 0, 0], handR: [0.7, 0, 0], armL: [-1.0, 0, 0.6], foreL: [-0.6, 0, 0] }),
    contact: P({ chest: [0.12, 0.08, 0], spine: [0.1, 0.03, 0], clavR: [-0.2, 0, -0.25], armR: [-0.55, 0.2, -2.4], foreR: [-0.2, 0, 0], handR: [-0.55, 0, 0], armL: [-0.6, 0, 0.4], foreL: [-1.3, 0, 0] }),
    follow: P({ chest: [0.26, 0.12, 0], spine: [0.16, 0.05, 0], clavR: [-0.05, 0, -0.1], armR: [-1.3, 0.4, -1.3], foreR: [-0.5, 0, 0], handR: [-0.9, 0, 0], armL: [-0.3, 0, 0.35], foreL: [-1.2, 0, 0] }),
  },
  // forehand drive: shoulder height on the racket side, racket laid back, a flat whip through
  fh: {
    fwd: 0.085, fol: 0.14,
    load: P({ hips: [0, -0.3, 0], spine: [0.05, -0.12, 0], chest: [0.02, -0.22, 0], clavR: [-0.1, 0, -0.15], armR: [0.35, -0.9, -1.3], foreR: [-1.55, 0, 0], handR: [0.6, 0, 0.25], armL: [-0.9, 0, 0.7], foreL: [-0.9, 0, 0] }),
    contact: P({ hips: [0, 0.1, 0], spine: [0.06, 0.05, 0], chest: [0.05, 0.12, 0], clavR: [-0.1, 0, -0.15], armR: [-0.85, 0.05, -1.3], foreR: [-0.2, 0, 0], handR: [-0.1, 0, 0], armL: [-0.4, 0, 0.5], foreL: [-1.2, 0, 0] }),
    follow: P({ hips: [0, 0.3, 0], spine: [0.08, 0.14, 0], chest: [0.08, 0.24, 0], clavR: [0, 0, -0.1], armR: [-1.55, 0.7, -0.75], foreR: [-1.1, 0, 0], handR: [-0.5, 0, 0], armL: [-0.1, 0, 0.35], foreL: [-1.1, 0, 0] }),
  },
  // backhand: the racket taken across the chest to the far shoulder, the back half-turned to the
  // net, then the elbow leads and the forearm snaps out
  bh: {
    fwd: 0.085, fol: 0.14,
    load: P({ hips: [0, 0.34, 0], spine: [0.08, 0.14, 0], chest: [0.06, 0.24, 0], neck: [0, -0.3, 0], head: [0, -0.3, 0], clavR: [-0.1, 0, 0.12], armR: [-1.25, 0.9, 0.45], foreR: [-1.8, 0, 0], handR: [-0.45, 0, 0.3], armL: [0.1, 0, 0.35], foreL: [-0.4, 0, 0] }),
    contact: P({ hips: [0, 0.1, 0], spine: [0.06, 0.04, 0], chest: [0.04, 0.02, 0], clavR: [-0.15, 0, -0.1], armR: [-1.35, -0.15, -0.75], foreR: [-0.2, 0, 0], handR: [0.35, 0, 0], armL: [0.2, 0, 0.35], foreL: [-0.3, 0, 0] }),
    follow: P({ hips: [0, -0.05, 0], spine: [0.04, -0.06, 0], chest: [0.02, -0.14, 0], clavR: [-0.15, 0, -0.2], armR: [-1.4, -0.6, -1.5], foreR: [-0.3, 0, 0], handR: [0.5, 0, 0], armL: [0.3, 0, 0.3], foreL: [-0.3, 0, 0] }),
  },
  // underarm (lift, clear from low, net shot): racket low behind, the body folded over the lunge
  under: {
    fwd: 0.1, fol: 0.16,
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
};
// the smash is the overhead with extra arch and fold
STROKES.smash.load = add(STROKES.over.load, STROKES.smash.extend.load);
STROKES.smash.contact = STROKES.over.contact;
STROKES.smash.follow = add(STROKES.over.follow, STROKES.smash.extend.follow);
function add(a, b) { const o = {}; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const x = a[k] || [0, 0, 0], y = b[k] || [0, 0, 0]; o[k] = [x[0] + y[0], x[1] + y[1], x[2] + y[2]]; } return o; }

// which stroke plays a shot: the sim's shot kind first, then where the shuttle was met
export function strokeFor(kind, side, rz) {
  if (kind === 'smash' || kind === 'jsmash') return 'smash';
  if (kind === 'kill') return 'kill';
  if (kind === 'block') return 'block';
  if (kind === 'net' || kind === 'servel') return rz > 1.25 ? (side < -0.15 ? 'bh' : 'fh') : 'touch';
  if (rz >= 1.75) return 'over';
  if (rz < 0.95) return 'under';
  return side < -0.15 ? 'bh' : 'fh';
}

// sample one stroke at time u (seconds from contact; negative before it) for one bone, with the
// charge c (0..1) deciding how far back the LOAD is drawn while waiting
function sampleStroke(st, bone, u, c, out) {
  const L = st.load[bone], K = st.contact[bone], F = st.follow[bone];
  if (!L && !K && !F) return false;
  const l = L || K || F, k = K || l, f = F || k;
  if (u <= -st.fwd) { for (let i = 0; i < 3; i++) out[i] = l[i] * c; return true; }
  if (u <= 0) { const e = easeIn(1 + u / st.fwd); for (let i = 0; i < 3; i++) out[i] = lerp(l[i] * c, k[i], e); return true; }
  if (u <= st.fol) { const e = easeOut(u / st.fol); for (let i = 0; i < 3; i++) out[i] = lerp(k[i], f[i], e); return true; }
  for (let i = 0; i < 3; i++) out[i] = f[i];
  return true;
}

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
  const F = side < 0 ? 'L' : 'R', B = side < 0 ? 'R' : 'L', s = side < 0 ? 1 : -1;
  Q.set('thigh' + F, -1.3 * w, 0, s * 0.15 * w); Q.set('shin' + F, 1.45 * w); Q.set('foot' + F, -0.25 * w); Q.set('toe' + F, 0);
  Q.set('thigh' + B, 0.55 * w, 0, -s * 0.12 * w); Q.set('shin' + B, 0.35 * w); Q.set('foot' + B, 0.55 * w); Q.set('toe' + B, -0.5 * w);
}
// jump: crouch (w 0..1), rise (0..1), air tuck, and the scissor kick of a jump smash (k: -1 legs
// loaded, the right leg back; +1 switched through contact)
function jumpLegs(Q, crouch, rise, tuck, kick) {
  for (const [s, k] of [[1, 'L'], [-1, 'R']]) {
    let th = -0.95 * crouch - 0.15 * rise - 0.55 * tuck, sh = 1.6 * crouch + 0.2 * rise + 1.0 * tuck, fo = -0.45 * crouch + 0.7 * rise + 0.45 * tuck;
    if (kick) { const right = k === 'R' ? 1 : -1, ph = kick * right; th += 0.6 * ph; sh += 0.4 * Math.abs(kick) * (ph > 0 ? 1 : 0.4); }
    Q.set('thigh' + k, th, 0, s * 0.08); Q.set('shin' + k, sh); Q.set('foot' + k, fo); Q.set('toe' + k, 0.15 * rise);
  }
  Q.set('hips', 0.35 * crouch - 0.05 * rise, 0, 0);
  Q.set('spine', 0.22 * crouch, 0, 0);
}
function landing(Q, w) {
  for (const [s, k] of [[1, 'L'], [-1, 'R']]) { Q.set('thigh' + k, -0.85 * w, 0, s * 0.12); Q.set('shin' + k, 1.45 * w); Q.set('foot' + k, -0.42 * w); Q.set('toe' + k, 0); }
  Q.set('hips', 0.3 * w, 0, 0); Q.set('spine', 0.25 * w, 0, 0);
}
function divePose(Q, w) {
  Q.set('thighL', -0.95 * w, 0, 0.18 * w); Q.set('shinL', 0.55 * w);
  Q.set('thighR', -0.45 * w, 0, -0.12 * w); Q.set('shinR', 0.35 * w);
  Q.set('hips', 0.5 * w); Q.set('spine', 0.35 * w); Q.set('chest', 0.2 * w);
  Q.set('armR', -1.55 * w, 0, -0.75 * w); Q.set('foreR', -0.2 * w); Q.set('handR', 0, 0, -0.3 * w);
  Q.set('armL', -0.7 * w, 0, 0.9 * w); Q.set('foreL', -0.4 * w);
  Q.set('neck', -0.35 * w); Q.set('head', -0.2 * w);
}

// ---------------------------------------------------------------- the racket
function makeRacket() {
  const g = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x1b1f27, roughness: 0.35, metalness: 0.4 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xe4ff3c, roughness: 0.45 });
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.0145, 0.0165, 0.2, 10), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.85 }));
  grip.position.y = 0.06; g.add(grip);
  const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.016, 0.02, 10), frameMat); butt.position.y = -0.045; g.add(butt);
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
// Shoulder S, elbow E, and an effector P rigid in the forearm's frame (the racket's sweet spot):
// bend the elbow so |P - S| = |T - S|, then swing the upper arm so P lands on T. Weight w blends
// from the pose as it was. Reach is clamped, so an impossible target is reached for, not snapped.
function solveArm(upper, fore, effector, target, w) {
  if (w <= 0.001) return;
  const u0 = upper.quaternion.clone(), f0 = fore.quaternion.clone();
  const S = upper.getWorldPosition(_a), E = fore.getWorldPosition(_b), Pw = effector(_c);
  const a = S.distanceTo(E), c = E.distanceTo(Pw);
  const d = clamp(_d.copy(target).sub(S).length(), Math.abs(a - c) + 0.02, a + c - 0.01);
  // elbow
  const eS = _e.copy(S).sub(E).normalize(), eP = Pw.clone().sub(E).normalize();
  const cur = Math.acos(clamp(eS.dot(eP), -1, 1));
  const want = Math.acos(clamp((a * a + c * c - d * d) / (2 * a * c), -1, 1));
  const n = new THREE.Vector3().crossVectors(eS, eP);
  if (n.lengthSq() > 1e-8) { n.normalize(); worldRotate(fore, _q3.setFromAxisAngle(n, want - cur)); }
  // shoulder
  const P2 = effector(_c), S2 = upper.getWorldPosition(_a);
  const from = P2.sub(S2).normalize(), to = _d.copy(target).sub(S2).normalize();
  worldRotate(upper, _q4.setFromUnitVectors(from, to));
  if (w < 0.999) { upper.quaternion.copy(u0.slerp(upper.quaternion, w)); fore.quaternion.copy(f0.slerp(fore.quaternion, w)); upper.updateMatrixWorld(true); }
}

// ---------------------------------------------------------------- the athlete
export class Athlete {
  constructor(scene, kit, A, lookFor) {
    this.root = new THREE.Group(); scene.add(this.root);
    this.h = new Human(kit);
    this.root.add(this.h.group);
    this.h.init(A);
    this.lookFor = lookFor;
    this.racket = makeRacket();
    // the grip: the handle runs out of the fist along the line of the forearm, face square to it
    const hand = this.h.bone.hand_r, fore = this.h.bone.lowerarm_r;
    this.h.root.updateMatrixWorld(true);
    const hp = hand.getWorldPosition(new THREE.Vector3());
    const dir = hp.clone().sub(fore.getWorldPosition(new THREE.Vector3())).normalize();
    const localDir = hand.worldToLocal(hp.clone().add(dir)).sub(hand.worldToLocal(hp.clone())).normalize();
    this.racket.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), localDir);
    hand.add(this.racket);
    this.sweet = out => this.racket.localToWorld(out.copy(this.racket.userData.sweet));
    this.Q = new Pose(); this.T = new Pose(); this.AD = new Pose(); this.W = new Float32Array(this.Q.r.length / 3);
    this.fast = new Float32Array(this.W.length);
    this.yaw = 0; this.speed = 0; this.identity = null; this.look = null;
    this.hop = 0; this.land = 0; this.lungeW = 0; this.lungeSide = 1; this.diveW = 0; this.jumpW = 0;
    this.stroke = null; this.whoosh = [];
    this.tmp = [0, 0, 0];
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
    const { p, dt: dtIn, t } = f;
    const dt = f.frozen ? 0 : dtIn;
    const Q = this.Q, W = this.W, AD = this.AD, h = this.h;
    const x = p[0], y = p[1], vx = p[2], vy = p[3], fx = p[4], fy = p[5];
    const ch = p[6], dash = p[7], dive = p[8], stun = p[10], recover = p[11];
    const z = p[14] || 0, vz = p[15] || 0, squat = p[16] || 0, landT = p[17] || 0;
    // facing: the sim's facing, eased (a dive or a stroke never snaps the body round)
    let dy = Math.atan2(fx, fy) - this.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * clamp(14 * dt, 0, 1);
    const sp = Math.hypot(vx, vy);
    this.speed = lerp(this.speed, z > 0.02 ? 0 : sp, clamp(10 * dt, 0, 1));
    // split step: a small hop as the opponent strikes, landing ready (0.25 s)
    const sa = f.splitAgo;
    this.hop = sa != null && sa >= 0 && sa < 0.25 && z < 0.02 ? Math.sin(Math.PI * sa / 0.25) * 0.07 : 0;
    this.root.position.set(x, z + this.hop, y);
    this.root.rotation.y = this.yaw;

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
    const idle = 1 - smooth(0.6, 3.2, this.speed);
    T.zero(); stance(T, t, seed, 1);
    blend(T, air ? 0.6 : Math.max(idle * 0.9, 0.35), UPPER_I);
    blend(T, air ? 0 : idle * 0.85, LEG_I);

    // ---- legs: jump, landing, lunge, dive
    const crouchW = squat > 0 ? 1 : 0;
    const rise = z > 0.02 && vz > 0 ? clamp(vz / 4.6, 0, 1) : 0;
    const tuck = z > 0.02 ? clamp(1 - Math.abs(vz) / 4.6, 0, 1) * 0.8 + (vz < 0 ? 0.2 : 0) : 0;
    this.jumpW = lerp(this.jumpW, air ? 1 : 0, clamp(30 * dt, 0, 1));
    const st = f.stroke;
    const kick = st && st.air && st.name === 'smash' ? clamp(st.u / 0.12, -1, 1) : 0;
    if (this.jumpW > 0.01) { T.zero(); jumpLegs(T, crouchW, rise, tuck, kick); blend(T, this.jumpW, [...LEG_I, boneIndex('hips'), boneIndex('spine')]); }
    // landing absorb: deeper after a hard landing, easing out over the landing beat
    const landW = landT > 0 && z < 0.02 ? clamp(landT / 8, 0, 1) : 0;
    this.land = lerp(this.land, landW, clamp(20 * dt, 0, 1));
    if (this.land > 0.01) { T.zero(); landing(T, this.land); blend(T, this.land, [...LEG_I, boneIndex('hips'), boneIndex('spine')]); }
    // lunge: a low shot met wide or in front reaches out on the racket-side leg
    let lungeWant = 0;
    if (st && !air && (st.name === 'under' || st.name === 'touch' || st.name === 'block') && st.reach > 0.7) lungeWant = bump(st.u, 0.35) * clamp((st.reach - 0.7) / 0.6, 0, 1);
    if (lungeWant > this.lungeW) this.lungeSide = st.side < -0.2 ? -1 : 1;
    this.lungeW = lerp(this.lungeW, lungeWant, clamp(18 * dt, 0, 1));
    if (this.lungeW > 0.01) { T.zero(); lunge(T, 1, this.lungeSide); blend(T, this.lungeW, LEG_I); }
    this.diveW = lerp(this.diveW, dive ? 1 : 0, clamp(14 * dt, 0, 1));
    if (this.diveW > 0.01) { T.zero(); divePose(T, 1); blend(T, this.diveW, ALL_I); }

    // ---- the racket arm and trunk: charging (LOAD by the charge), then the stroke itself
    const charging = ch >= 0;
    if (st && st.u > -0.6 && st.u < 0.6) {
      const S = STROKES[st.name];
      T.zero();
      const c = 1; // a stroke always starts from its full LOAD: it blends in from the stance below
      for (const bone of UPPER) {
        const lead = LEAD[bone] || 0;
        if (sampleStroke(S, bone, st.u + lead, c, this.tmp)) T.set(bone, this.tmp[0], this.tmp[1], this.tmp[2]);
      }
      // in and out of the stroke: it owns the upper body from the wind-up to the end of the
      // follow-through, then hands back to the stance
      const w = smooth(-0.45, -S.fwd - 0.02, st.u) * (1 - smooth(S.fol + 0.08, S.fol + 0.34, st.u));
      blend(T, w, UPPER_I);
      // a stroke is fast: let the filter follow it (otherwise the whip is smoothed into a wave)
      const k = 1 + 4 * bump(st.u, 0.2);
      for (const i of UPPER_I) this.fast[i] = k;
    } else if (charging) {
      const c = clamp(ch / 42, 0, 1.15);
      const name = f.chargeKind || 'over';
      const S = STROKES[name];
      T.zero();
      for (const bone of UPPER) if (sampleStroke(S, bone, -1, 1, this.tmp)) T.set(bone, this.tmp[0], this.tmp[1], this.tmp[2]);
      blend(T, smooth(0, 0.7, c), UPPER_I); // drawn back as the charge builds, from the ready stance
      // past full charge the muscles start to shake: overcooked
      if (c > 1) AD.add('armR', Math.sin(t * 38) * 0.03 * (c - 1) * 6, 0, 0);
    }
    // the free arm tracks a high shuttle while an overhead loads: the hallmark of a real smash
    const overheadLoad = (charging && (f.chargeKind === 'over' || f.chargeKind === 'smash')) || (st && (st.name === 'over' || st.name === 'smash') && st.u < 0);
    this.track = lerp(this.track || 0, overheadLoad && bl.up > 1.5 ? 1 : 0, clamp(8 * dt, 0, 1));

    // ---- reactions
    if (stun) { AD.add('neck', 0.18, Math.sin(t * 4.1) * 0.2, 0); AD.add('head', 0.1, Math.sin(t * 5.3) * 0.25, 0); AD.add('spine', 0.12); }
    if (recover && !st) AD.add('spine', 0.06);
    if (f.won != null && f.won < 2.2) { const k = bump(f.won - 0.6, 0.6); AD.add('armL', -1.6 * k, 0, 1.2 * k); AD.add('foreL', -1.4 * k); AD.add('chest', -0.12 * k); AD.add('neck', -0.2 * k); }
    if (f.lost != null && f.lost < 2.2) { const k = bump(f.lost - 0.9, 0.9); AD.add('spine', 0.22 * k); AD.add('neck', 0.35 * k); AD.add('head', 0.2 * k); }
    // head and eyes on the shuttle (within what a neck turns), less so mid-stroke
    if (f.ball) {
      const yawTo = clamp(Math.atan2(bl.side, Math.max(0.2, bl.fwd)), -1.1, 1.1);
      const pitchTo = clamp(-Math.atan2(bl.up - 1.62, Math.hypot(bl.side, bl.fwd)), -0.9, 0.5);
      const w = st && Math.abs(st.u) < 0.15 ? 0.4 : 0.85;
      AD.add('neck', pitchTo * 0.35 * w, -yawTo * 0.35 * w, 0); AD.add('head', pitchTo * 0.45 * w, -yawTo * 0.45 * w, 0);
    }
    h.animate(dt, t, this.speed, Q, W, { pose: AD, lift: 0, clips: {}, serverPhase: null, dir: vx * Math.sin(this.yaw) + vy * Math.cos(this.yaw) < -0.5 ? -1 : 1, fast: this.fast });

    // ---- after the pose: the tracking arm, then the racket onto the shuttle at contact
    h.root.updateMatrixWorld(true);
    if (this.track > 0.02 && f.ball) {
      const B = h.bone, sh = B.upperarm_l.getWorldPosition(_a), el = B.lowerarm_l.getWorldPosition(_b);
      const tgt = _e.set(f.ball[0], f.ball[2], f.ball[1]);
      const from = el.sub(sh).normalize(), to = tgt.sub(sh).normalize();
      _q1.setFromUnitVectors(from, to); _q2.identity().slerp(_q1, this.track * 0.85);
      worldRotate(B.upperarm_l, _q2);
    }
    if (st && st.contact) {
      const w = bump(st.u, st.name === 'block' || st.name === 'touch' ? 0.12 : 0.08) * 0.9;
      if (w > 0.01) solveArm(h.bone.upperarm_r, h.bone.lowerarm_r, this.sweet, st.contact, w);
    }
    // the racket head's recent path, for the swing trail
    const head = this.sweet(new THREE.Vector3());
    this.whoosh.unshift({ p: head, t }); if (this.whoosh.length > 10) this.whoosh.pop();
    this.swingSpeed = this.whoosh.length > 1 && t > this.whoosh[1].t ? head.distanceTo(this.whoosh[1].p) / (t - this.whoosh[1].t) : 0;
  }
}
