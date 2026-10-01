// Office Ball — footballers. The body, face, hair and animations are Quaternius' CC0 "Universal
// Base Characters" + "Universal Animation Library" (public/models, built by tools/prepare_players.py).
// On top of that: a football kit fitted to the body (shirt, shorts, socks and boots cut from the
// skin mesh and skinned to the same bones), per-player skin tone / hair / boots / name + number,
// mocap locomotion, and procedural kicks, tackles and celebrations layered over the mocap.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Shadows of the kit: its four pieces, merged into one skinned caster that only the floodlights'
// shadow cameras see (this layer), so each shadow map draws a player's kit once, not four times.
export const SHADOW_LAYER = 1;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const hex = c => '#' + c.toString(16).padStart(6, '0');
const shade = (c, k) => { const o = new THREE.Color(c); if (k < 0) o.multiplyScalar(1 + k); else o.lerp(new THREE.Color(1, 1, 1), k); return '#' + o.getHexString(); };

export const MODEL_HEIGHT = 1.81; // the source character, in metres
export const HAIR_KEYS = ['buzzed', 'buzzedfemale', 'simpleparted', 'bald'];

// ---------------------------------------------------------------- pose buffer
// Procedural poses are written per "logical" bone as model-space Euler angles relative to a
// standing, arms-down reference pose. Conventions: +x on a thigh/arm swings it back, +x on a shin
// bends the knee, -x on a forearm bends the elbow, +y on an arm twists it about its length, +x on a
// foot points the toes; +z on a left (L, +x side) limb lifts it outward.
export const BONES = ['hips', 'spine', 'chest', 'neck', 'head',
  'clavL', 'armL', 'foreL', 'handL', 'clavR', 'armR', 'foreR', 'handR',
  'thighL', 'shinL', 'footL', 'toeL', 'thighR', 'shinR', 'footR', 'toeR'];
const BI = Object.fromEntries(BONES.map((n, i) => [n, i]));
const LEG_I = BONES.map((n, i) => (/^(thigh|shin|foot|toe)/.test(n) ? i : -1)).filter(i => i >= 0);
export class Pose {
  constructor() { this.r = new Float32Array(BONES.length * 3); this.lift = 0; }
  zero() { this.r.fill(0); this.lift = 0; return this; }
  copy(o) { this.r.set(o.r); this.lift = o.lift; return this; }
  set(n, x, y = 0, z = 0) { const i = BI[n] * 3; this.r[i] = x; this.r[i + 1] = y; this.r[i + 2] = z; return this; }
  add(n, x, y = 0, z = 0) { const i = BI[n] * 3; this.r[i] += x; this.r[i + 1] += y; this.r[i + 2] += z; return this; }
  mix(o, w) { for (let i = 0; i < this.r.length; i++) this.r[i] += (o.r[i] - this.r[i]) * w; this.lift += (o.lift - this.lift) * w; return this; }
}
export const boneIndex = n => BI[n];
// logical bone -> rig bones (with their share of the rotation)
const RIG = { hips: [['pelvis', 1]], spine: [['spine_01', 1]], chest: [['spine_02', 0.5], ['spine_03', 0.5]], neck: [['neck_01', 1]], head: [['Head', 1]] };
for (const [k, s] of [['L', 'l'], ['R', 'r']]) Object.assign(RIG, {
  ['clav' + k]: [['clavicle_' + s, 1]], ['arm' + k]: [['upperarm_' + s, 1]], ['fore' + k]: [['lowerarm_' + s, 1]], ['hand' + k]: [['hand_' + s, 1]],
  ['thigh' + k]: [['thigh_' + s, 1]], ['shin' + k]: [['calf_' + s, 1]], ['foot' + k]: [['foot_' + s, 1]], ['toe' + k]: [['ball_' + s, 1]],
});
// how quickly each bone may follow its target (1/s): the torso and arms trail a little behind the
// hips, which reads as weight and follow-through; the legs stay tight so the feet don't slide
const RATE = BONES.map(n => ({ hips: 24, spine: 18, chest: 16, neck: 12, head: 11 })[n] ||
  (/^(clav|arm)/.test(n) ? 20 : /^(fore|hand)/.test(n) ? 24 : 32));
const FINGER = /^(index|middle|ring|pinky|thumb)_0[123]_[lr]$/;
// Hard joint limits, applied to the final pose every frame, measured from the standing reference.
// Knees are strict hinges; elbows are hinges that may still twist; everything else is capped by its
// total rotation. Nothing (mocap, procedural layers, blending, bad input) can leave these ranges.
const LIMIT = BONES.map(n => {
  const b = n.replace(/[LR]$/, '');
  if (b === 'shin') return { hinge: [-0.05, 2.5], strict: true };
  if (b === 'fore') return { hinge: [-2.6, 0.1], swing: 1.7 };
  // twist about the vertical axis is limited separately along the spine: a real waist turns a few
  // degrees per vertebra, and bigger differences make the skin wring like a towel
  const twist = { hips: 0.4, spine: 0.16, chest: 0.24, neck: 0.5, head: 0.8 }[b];
  return { cap: { hips: 0.9, spine: 0.55, chest: 0.8, neck: 0.9, head: 1.1, clav: 0.5, arm: 3.0, hand: 1.3, thigh: 2.1, foot: 1.1, toe: 1.0 }[b], twist };
});
const ORDER = BONES.map(n => (['hips', 'spine', 'chest', 'neck', 'head'].includes(n) ? 'YXZ' : n.startsWith('arm') ? 'XZY' : 'XYZ'));

// ---------------------------------------------------------------- kit textures
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
const FONT = '"Teko", "Barlow Condensed", "Arial Black", Impact, sans-serif';
// shirt: torso fills v 0.3..1 (hem -> collar), u goes round the body: 0 = right flank, 0.25 = chest,
// 0.5 = left flank, 0.75 = back. Sleeves use the bottom band (v 0..0.25, cuff at 0).
function drawShirt(c, kit, look) {
  const g = c.getContext('2d'), W = c.width, base = hex(kit.shirt), dark = shade(kit.shirt, -0.38), trim = '#f5f5f5', TOR = 358;
  g.fillStyle = base; g.fillRect(0, 0, W, W);
  g.save(); g.globalAlpha = 0.08; g.strokeStyle = dark; g.lineWidth = 9;
  for (let x = -520; x < 1040; x += 30) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + TOR, TOR); g.stroke(); }
  g.restore();
  // side panels, from the armpit down (u = 0 / 0.5 run over the shoulders above that)
  for (const x of [0, 256, 512]) { g.fillStyle = dark; g.fillRect(x - 14, 150, 28, TOR - 150); g.fillStyle = trim; g.fillRect(x - 17, 150, 3, TOR - 150); g.fillRect(x + 14, 150, 3, TOR - 150); }
  g.fillStyle = dark; g.fillRect(0, 0, W, 10); g.fillStyle = trim; g.fillRect(0, 10, W, 3);
  g.fillStyle = dark; g.beginPath(); g.moveTo(104, 10); g.lineTo(128, 40); g.lineTo(152, 10); g.fill();
  g.strokeStyle = trim; g.lineWidth = 3; g.beginPath(); g.moveTo(102, 12); g.lineTo(128, 44); g.lineTo(154, 12); g.stroke();
  // crest on the player's left chest
  g.save(); g.translate(172, 96); g.scale(0.62, 0.8);
  g.fillStyle = trim; g.beginPath(); g.moveTo(-18, -20); g.lineTo(18, -20); g.lineTo(18, 4); g.quadraticCurveTo(18, 18, 0, 26); g.quadraticCurveTo(-18, 18, -18, 4); g.closePath(); g.fill();
  g.fillStyle = dark; g.beginPath(); g.moveTo(-12, -14); g.lineTo(12, -14); g.lineTo(12, 3); g.quadraticCurveTo(12, 13, 0, 19); g.quadraticCurveTo(-12, 13, -12, 3); g.closePath(); g.fill();
  g.fillStyle = '#ffd34d'; g.beginPath(); g.arc(0, 0, 6, 0, Math.PI * 2); g.fill();
  g.restore();
  g.fillStyle = dark; g.globalAlpha = 0.45; g.fillRect(0, 150, W, 5); g.globalAlpha = 1;
  // name + number on the back
  g.save(); g.translate(384, 0); g.scale(0.62, 1); g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  const name = (look.name || '').toUpperCase().slice(0, 12);
  if (name) { g.font = `600 40px ${FONT}`; g.fillStyle = trim; g.fillText(name, 0, 70, 280); }
  g.font = `700 150px ${FONT}`; g.lineWidth = 10; g.strokeStyle = dark; g.strokeText(String(look.number), 0, 212); g.fillStyle = trim; g.fillText(String(look.number), 0, 212);
  g.restore();
  g.fillStyle = base; g.fillRect(0, TOR, W, W - TOR);
  g.fillStyle = dark; g.fillRect(0, 486, W, 26); g.fillStyle = trim; g.fillRect(0, 480, W, 4);
}
// shorts: v 0 = hem, 1 = waistband; u as the shirt (flanks at 0 and 0.5)
function drawShorts(c, kit) {
  const g = c.getContext('2d'), W = c.width, base = hex(kit.shorts), stripe = hex(kit.shirt), band = shade(kit.shorts, -0.25);
  g.fillStyle = base; g.fillRect(0, 0, W, W);
  g.fillStyle = band; g.fillRect(0, 0, W, 14);
  for (const x of [0, 128, 256]) { g.fillStyle = stripe; g.fillRect(x - 6, 0, 12, W); }
  g.fillStyle = stripe; g.fillRect(0, W - 12, W, 12);
}
// socks: v 0 = ankle, 1 = top band
function drawSocks(c, kit) {
  const g = c.getContext('2d'), W = c.width, H = c.height;
  g.fillStyle = hex(kit.socks); g.fillRect(0, 0, W, H);
  g.fillStyle = shade(kit.socks, -0.4); g.fillRect(0, 0, W, 9);
  g.fillStyle = '#f5f5f5'; g.fillRect(0, 13, W, 4); g.fillRect(0, 21, W, 4);
  g.globalAlpha = 0.12; g.fillStyle = '#000'; for (let x = 0; x < W; x += 4) g.fillRect(x, 26, 1, H); g.globalAlpha = 1;
}
export const BOOTS = [
  { base: '#121212', sole: '#f2f2f2', stripe: '#ff3b30' }, { base: '#f4f4f4', sole: '#1c1c1c', stripe: '#1c8cf0' },
  { base: '#1a1a1a', sole: '#c8ff2e', stripe: '#c8ff2e' }, { base: '#ff6b1a', sole: '#121212', stripe: '#121212' },
  { base: '#1f35ff', sole: '#f4f4f4', stripe: '#f4f4f4' }, { base: '#ffd34d', sole: '#121212', stripe: '#121212' },
];
// boots: v heel -> toe, u round the foot: 0 / 0.5 = flanks, 0.25 = top, 0.75 = sole
function drawBoots(c, b) {
  const g = c.getContext('2d'), W = c.width, H = c.height;
  g.fillStyle = b.base; g.fillRect(0, 0, W, H);
  g.fillStyle = b.sole; g.fillRect(W * 0.6, 0, W * 0.3, H);
  g.fillStyle = b.stripe;
  for (const x0 of [0, W * 0.5, W]) { g.beginPath(); g.moveTo(x0 - 10, H * 0.28); g.lineTo(x0 + 10, H * 0.38); g.lineTo(x0 + 8, H * 0.7); g.lineTo(x0 - 8, H * 0.62); g.closePath(); g.fill(); }
  g.fillStyle = 'rgba(255,255,255,.55)'; for (let i = 0; i < 5; i++) g.fillRect(W * 0.25 - 6, H * (0.4 + i * 0.05), 12, 2);
}
// fine knit for the fabric normal map (tiles)
function knitNormal() {
  const N = 64, c = canvas(N, N), g = c.getContext('2d'), img = g.createImageData(N, N);
  const h = (x, y) => Math.sin(x / N * Math.PI * 16) * 0.5 + Math.sin((y + Math.sin(x / N * Math.PI * 16) * 1.5) / N * Math.PI * 24) * 0.5;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = h(x + 1, y) - h(x - 1, y), dy = h(x, y + 1) - h(x, y - 1), l = Math.hypot(dx, dy, 2), k = (y * N + x) * 4;
    img.data[k] = (-dx / l * 0.5 + 0.5) * 255; img.data[k + 1] = (dy / l * 0.5 + 0.5) * 255; img.data[k + 2] = (2 / l * 0.5 + 0.5) * 255; img.data[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(28, 28);
  return t;
}

// ---------------------------------------------------------------- kit meshes (built once from the body)
// Each garment is a signed field over the character's bind pose (T-pose, metres, facing +z,
// left = +x): > 0 inside the garment. Skin triangles are clipped along the field's zero line, so
// hems, cuffs and the collar are clean curves rather than triangle stair-steps.
const neckHole = (x, y, z) => {
  const ring = y > 1.4 ? Math.hypot(x, (z + 0.025) * 1.1) - 0.094 : 1; // round neck
  const v = z > 0 ? 1.43 + Math.abs(x) * 2 - y : 1;                     // shallow V at the front
  return Math.min(ring, v);
};
const F = {
  shirt: (x, y, z) => Math.min(y - 0.97, 0.37 - Math.abs(x), 1.56 - y, neckHole(x, y, z)),
  shorts: (x, y) => Math.min(y - 0.7, 1.06 - y, 0.33 - Math.abs(x)),
  socks: (x, y) => Math.min(y - 0.07, 0.47 - y),
  boots: (x, y) => 0.135 - y,
};
const TAU = Math.PI * 2, around = (a, b) => ((Math.atan2(a, b) / TAU) % 1 + 1) % 1;

// Drape: cloth hangs from the widest part of the body above it and bridges every hollow below
// (the small of the back, the waist under the lats, the fold under the glutes) instead of clinging
// into it. Per region (torso, pelvis, each leg), the garment is looked at in rings round a vertical
// axis: scanning top-down, the fabric's radius in each direction may shrink by at most `taper`
// per metre of drop, and every vertex is pushed out to that envelope. The envelope is smoothed
// around the ring so the fabric reads as one soft surface rather than facets.
function hang(pos, base, n, { region, taper }) {
  const NA = 72, DY = 0.01, regs = new Map(), at = new Int32Array(n).fill(-1), ang = new Float32Array(n), rad = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const g = region(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]); if (!g) continue;
    let R = regs.get(g.id); if (!R) regs.set(g.id, R = { g, cells: new Map(), top: -1e9, bot: 1e9, list: [] });
    const dx = pos[i * 3] - g.cx, dz = pos[i * 3 + 2] - g.cz, yb = Math.round(pos[i * 3 + 1] / DY);
    ang[i] = ((Math.atan2(dx, dz) / TAU) % 1 + 1) % 1 * NA; rad[i] = Math.hypot(dx, dz); at[i] = yb;
    const a = Math.floor(ang[i]) % NA, row = R.cells.get(yb) || new Float32Array(NA);
    row[a] = Math.max(row[a], rad[i]); R.cells.set(yb, row);
    R.top = Math.max(R.top, yb); R.bot = Math.min(R.bot, yb); R.list.push(i);
  }
  for (const R of regs.values()) {
    const env = new Map(); let prev = null;
    for (let yb = R.top; yb >= R.bot; yb--) {
      const row = R.cells.get(yb), e = new Float32Array(NA);
      for (let a = 0; a < NA; a++) e[a] = Math.max(row ? row[a] : 0, prev ? prev[a] - taper * DY : 0);
      // soften around the ring (circular 1-2-1, three passes)
      for (let p = 0; p < 3; p++) { const c = Float32Array.from(e); for (let a = 0; a < NA; a++) e[a] = Math.max(row ? row[a] : 0, (c[(a + NA - 1) % NA] + 2 * c[a] + c[(a + 1) % NA]) / 4); }
      env.set(yb, e); prev = e;
    }
    for (const i of R.list) {
      const e = env.get(at[i]), a0 = Math.floor(ang[i]) % NA, t = ang[i] - Math.floor(ang[i]);
      const want = e[a0] * (1 - t) + e[(a0 + 1) % NA] * t;
      if (want <= rad[i] || rad[i] < 1e-5) continue;
      const k = want / rad[i], g = R.g;
      pos[i * 3] = g.cx + (pos[i * 3] - g.cx) * k; pos[i * 3 + 2] = g.cz + (pos[i * 3 + 2] - g.cz) * k;
    }
  }
}

function kitGeometry(src, f, offset, uvOf, iters, drape = null) {
  const P = src.attributes.position, N = src.attributes.normal, SI = src.attributes.skinIndex, SW = src.attributes.skinWeight, idx = src.index.array;
  // weld the skin's UV-seam duplicates so the garment is one connected sheet
  const canon = new Int32Array(P.count), seen = new Map();
  for (let i = 0; i < P.count; i++) {
    const k = P.getX(i).toFixed(5) + ',' + P.getY(i).toFixed(5) + ',' + P.getZ(i).toFixed(5);
    if (!seen.has(k)) seen.set(k, i);
    canon[i] = seen.get(k);
  }
  const fv = new Float32Array(P.count);
  for (let i = 0; i < P.count; i++) fv[i] = f(P.getX(i), P.getY(i), P.getZ(i));
  const base = [], nor = [], skin = [], tris = [], map = new Map();
  const vert = i => {
    const c = canon[i]; if (map.has(c)) return map.get(c);
    const n = base.length / 3; map.set(c, n);
    base.push(P.getX(c), P.getY(c), P.getZ(c)); nor.push(N.getX(c), N.getY(c), N.getZ(c));
    skin.push([SI.getX(c), SI.getY(c), SI.getZ(c), SI.getW(c), SW.getX(c), SW.getY(c), SW.getZ(c), SW.getW(c)]);
    return n;
  };
  const edge = (a, b) => { // new vertex where the field crosses zero on edge a-b (a is inside)
    const ca = canon[a], cb = canon[b], k = ca < cb ? ca + '_' + cb : cb + '_' + ca;
    if (map.has(k)) return map.get(k);
    const ia = vert(a), t = fv[a] / (fv[a] - fv[b]), n = base.length / 3; map.set(k, n);
    for (let c = 0; c < 3; c++) {
      base.push(P.array[a * 3 + c] + (P.array[b * 3 + c] - P.array[a * 3 + c]) * t);
      nor.push(N.array[a * 3 + c] + (N.array[b * 3 + c] - N.array[a * 3 + c]) * t);
    }
    skin.push(skin[ia]);
    return n;
  };
  for (let t = 0; t < idx.length; t += 3) {
    const v = [idx[t], idx[t + 1], idx[t + 2]], inside = v.map(i => fv[i] >= 0), nIn = inside.filter(Boolean).length;
    if (!nIn) continue;
    if (nIn === 3) { tris.push(vert(v[0]), vert(v[1]), vert(v[2])); continue; }
    const poly = []; // clip the triangle to the inside of the field (keeps the winding)
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      if (inside[k]) poly.push(vert(a));
      if (inside[k] !== inside[(k + 1) % 3]) poly.push(inside[k] ? edge(a, b) : edge(b, a));
    }
    for (let k = 1; k + 1 < poly.length; k++) tris.push(poly[0], poly[k], poly[k + 1]);
  }
  const n = base.length / 3, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2]) || 1;
    for (let c = 0; c < 3; c++) nor[i * 3 + c] /= l;
    const o = offset(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]);
    for (let c = 0; c < 3; c++) pos[i * 3 + c] = base[i * 3 + c] + nor[i * 3 + c] * o;
  }
  // relax the sheet so it drapes over muscle detail instead of shrink-wrapping it; open edges stay
  // put and nothing may sink back inside its offset from the body
  const nb = Array.from({ length: n }, () => new Set()), edges = new Map();
  for (let t = 0; t < tris.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = tris[t + k], b = tris[t + (k + 1) % 3]; nb[a].add(b); nb[b].add(a);
    const key = a < b ? a + '_' + b : b + '_' + a; edges.set(key, (edges.get(key) || 0) + 1);
  }
  const border = new Uint8Array(n);
  for (const [key, c] of edges) if (c === 1) { const [a, b] = key.split('_'); border[+a] = border[+b] = 1; }
  const tmp = new Float32Array(n * 3);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      if (border[i] || !nb[i].size) { for (let c = 0; c < 3; c++) tmp[i * 3 + c] = pos[i * 3 + c]; continue; }
      let x = 0, y = 0, z = 0;
      for (const j of nb[i]) { x += pos[j * 3]; y += pos[j * 3 + 1]; z += pos[j * 3 + 2]; }
      const m = nb[i].size;
      tmp[i * 3] = pos[i * 3] * 0.4 + x / m * 0.6; tmp[i * 3 + 1] = pos[i * 3 + 1] * 0.4 + y / m * 0.6; tmp[i * 3 + 2] = pos[i * 3 + 2] * 0.4 + z / m * 0.6;
    }
    for (let i = 0; i < n; i++) {
      const o = offset(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]) * 0.85;
      let d = 0; for (let c = 0; c < 3; c++) d += (tmp[i * 3 + c] - base[i * 3 + c]) * nor[i * 3 + c];
      if (d < o) for (let c = 0; c < 3; c++) tmp[i * 3 + c] += nor[i * 3 + c] * (o - d);
    }
    pos.set(tmp);
  }
  if (drape) hang(pos, base, n, drape);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(tris); g.computeVertexNormals();
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) { si[i * 4 + c] = skin[i][c]; sw[i * 4 + c] = skin[i][4 + c]; }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  g.setAttribute('base', new THREE.BufferAttribute(new Float32Array(base), 3));
  // texture coordinates come from the bind-pose body position; triangles crossing the u seam get
  // their own vertices so they can sit on one side of it (the textures repeat in u)
  const out = g.toNonIndexed(), bp = out.attributes.base, uv = new Float32Array(bp.count * 2);
  for (let t = 0; t < bp.count; t += 3) {
    const q = [0, 1, 2].map(k => uvOf(bp.getX(t + k), bp.getY(t + k), bp.getZ(t + k)));
    if (Math.max(q[0][0], q[1][0], q[2][0]) - Math.min(q[0][0], q[1][0], q[2][0]) > 0.5) q.forEach(e => { if (e[0] < 0.5) e[0] += 1; });
    q.forEach((e, k) => { uv[(t + k) * 2] = e[0]; uv[(t + k) * 2 + 1] = e[1]; });
  }
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); out.deleteAttribute('base');
  out.computeBoundingSphere(); g.dispose();
  return out;
}

// Fitting the kit is the one expensive computation in the boot (most of a second), and its result
// depends only on the body model and this code. So it is done once per machine and kept (see
// packKit); `step` is called after each garment, so the loading screen shows it happening.
const KIT_PARTS = ['shirt', 'shorts', 'socks', 'boots', 'skin'];
async function buildKit(body, step) {
  const sleeve = x => Math.max(0, Math.abs(x) - 0.21);
  // the jersey hangs from the chest and shoulder blades (below the yoke) down to the hem
  const shirt = kitGeometry(body, F.shirt,
    (x, y) => 0.014 + (Math.abs(x) < 0.21 ? 0.01 * smooth(1.2, 0.98, y) : 0.008 + sleeve(x) * 0.09),
    (x, y, z) => Math.abs(x) > 0.21
      ? [around(z + 0.065, (y - 1.455) * Math.sign(x)), 0.25 * (1 - sleeve(x) / 0.16)]
      : [around(z, -x), 0.3 + 0.7 * clamp((y - 0.97) / 0.55, 0, 1)], 10,
    { region: (x, y) => (Math.abs(x) < 0.2 && y < 1.44 ? { id: 0, cx: 0, cz: -0.02 } : null), taper: 0.12 });
  await step('shirt');
  // the shorts hang from the seat (the widest point of the glutes) and fall straight past the fold
  // beneath it; each leg is draped round its own axis so no web forms between the thighs
  const shorts = kitGeometry(body, F.shorts,
    (x, y) => 0.02 + 0.01 * smooth(0.88, 0.7, y),
    // round the pelvis above the crotch, round each thigh below it; both put u = 0 / 0.5 on the flanks
    (x, y, z) => [y > 0.93 ? around(z, -x) : around(z + 0.03, -(x - Math.sign(x) * 0.1)), clamp((y - 0.7) / 0.36, 0, 1)], 10,
    { region: (x, y) => (y > 0.97 ? { id: 0, cx: 0, cz: -0.02 } : { id: Math.sign(x) || 1, cx: (Math.sign(x) || 1) * 0.1, cz: -0.015 }), taper: 0.04 });
  await step('shorts');
  const socks = kitGeometry(body, F.socks, () => 0.005,
    (x, y, z) => [around(z + 0.04, -(x - Math.sign(x) * 0.114)), clamp((y - 0.07) / 0.4, 0, 1)], 2);
  await step('socks');
  const boots = kitGeometry(body, F.boots, (x, y) => 0.009 + 0.004 * smooth(0.03, 0, y),
    (x, y, z) => [around(y - 0.05, (x - Math.sign(x) * 0.114) * Math.sign(x)), clamp((z + 0.16) / 0.31, 0, 1)], 3);
  await step('boots');
  // the skin mesh, minus what the kit fully covers (a margin in from every edge)
  const P = body.attributes.position, idx = body.index.array, kept = [];
  const covered = i => { const x = P.getX(i), y = P.getY(i), z = P.getZ(i); return F.shirt(x, y, z) > 0.03 || F.shorts(x, y) > 0.03 || F.socks(x, y) > 0.03 || F.boots(x, y) > 0.025; };
  for (let t = 0; t < idx.length; t += 3) if (!(covered(idx[t]) && covered(idx[t + 1]) && covered(idx[t + 2]))) kept.push(idx[t], idx[t + 1], idx[t + 2]);
  const skin = body.clone(); skin.setIndex(kept);
  await step('skin');
  return { shirt, shorts, socks, boots, skin };
}
// A fitted kit as plain typed arrays (what IndexedDB stores), and back. The skin is the body's own
// geometry with fewer triangles, so only its index is kept.
function packKit(kit) {
  const geo = g => ({ index: g.index ? g.index.array : null, attrs: Object.fromEntries(Object.entries(g.attributes).map(([k, a]) => [k, { array: a.array, size: a.itemSize, norm: a.normalized }])) });
  const out = { v: 1, skin: kit.skin.index.array };
  for (const k of KIT_PARTS) if (k !== 'skin') out[k] = geo(kit[k]);
  return out;
}
function unpackKit(p, body) {
  if (!p || p.v !== 1 || !ArrayBuffer.isView(p.skin)) return null;
  const kit = {};
  for (const k of KIT_PARTS) {
    if (k === 'skin') continue;
    const d = p[k]; if (!d || !d.attrs || !d.attrs.position || !d.attrs.skinIndex || !d.attrs.skinWeight) return null;
    const g = new THREE.BufferGeometry();
    for (const [n, a] of Object.entries(d.attrs)) g.setAttribute(n, new THREE.BufferAttribute(a.array, a.size, a.norm));
    if (d.index) g.setIndex(new THREE.BufferAttribute(d.index, 1));
    g.computeBoundingSphere();
    kit[k] = g;
  }
  kit.skin = body.clone(); kit.skin.setIndex(new THREE.BufferAttribute(p.skin, 1));
  return kit;
}

// ---------------------------------------------------------------- shared assets
// The files arrive through the boot loader (loader.js: downloaded with exact progress, or read back
// from this PC's store), then are parsed from memory here: glTF from its buffer, images through
// createImageBitmap (decoded off the main thread), clips from JSON. Each step is reported to the
// loading screen's "players" stage.
const HAIRS = ['buzzed', 'buzzedfemale', 'simpleparted', 'beard'];
const GLBS = ['body.glb', ...HAIRS.map(h => `hair_${h}.glb`)];
const TEXTURES = ['body_albedo.jpg', 'body_normal.jpg', 'body_rough.jpg', 'eye.png', 'hair_albedo.jpg', 'hair_normal.jpg'];
const FILES = [...GLBS, 'anims.json', ...TEXTURES];
const LINEAR = new Set(['body_albedo.jpg', 'body_normal.jpg', 'body_rough.jpg', 'hair_normal.jpg']); // data, not colour
// boot: the loader's API. extraSteps: steps the caller will report on the same stage afterwards
export async function loadPlayerAssets(renderer, boot, { extraSteps = 0, lite = false } = {}) {
  const nextTask = boot.yield; // lets the loading screen paint between steps
  const B = Object.fromEntries(await Promise.all(FILES.map(async f => [f, await boot.asset(f)])));
  const kitKey = boot.derived.kit, packed = boot.cache.get(kitKey);
  const S = boot.stage('players');
  // models + animations + each texture + the kit (one step when it is kept, a step per part when it
  // is fitted now) + the lighting, then the caller's own steps
  S.begin(2 + TEXTURES.length + (packed ? 1 : KIT_PARTS.length) + 1 + extraSteps, 'steps', 'Reading the models');
  const gl = new GLTFLoader();
  const [body, ...hairs] = await Promise.all(GLBS.map(f => gl.parseAsync(B[f], '')));
  S.step(1, 'Reading the animations');
  await nextTask();
  const anims = JSON.parse(new TextDecoder().decode(B['anims.json']));
  // parse() leaves uuid unset here, and the mixer caches actions by clip uuid
  const clips = anims.map(c => { const k = THREE.AnimationClip.parse(c); k.uuid = THREE.MathUtils.generateUUID(); return k; });
  S.step(1, 'Decoding textures');
  const texture = async f => {
    const bmp = await createImageBitmap(new Blob([B[f]], { type: f.endsWith('.png') ? 'image/png' : 'image/jpeg' }),
      { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: LINEAR.has(f) ? 'none' : 'default' });
    const t = new THREE.Texture(bmp); t.flipY = false; t.anisotropy = 4; t.needsUpdate = true;
    t.colorSpace = LINEAR.has(f) ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    S.step(1);
    return t;
  };
  const [bAlb, bNor, bRough, eye, hA, hN] = await Promise.all(TEXTURES.map(texture));
  let skinned = null;
  body.scene.traverse(o => { if (o.isSkinnedMesh && o.name === 'SuperHero_Male') skinned = o; });
  const hairGeo = {};
  hairs.forEach((g, i) => {
    g.scene.updateMatrixWorld(true);
    g.scene.traverse(o => { if (o.isMesh && !hairGeo[HAIRS[i]]) hairGeo[HAIRS[i]] = o.geometry.clone().applyMatrix4(o.matrixWorld); });
  });
  // the kit: kept from an earlier visit if this exact body and fitting code made it, else fitted now
  let kit = packed ? unpackKit(packed, skinned.geometry) : null;
  if (kit) S.step(1, 'Kits (fitted on an earlier visit)');
  else {
    if (packed) S.total += KIT_PARTS.length - 1; // a kept kit that doesn't read back: fit it after all
    S.note('Fitting the kits');
    await nextTask();
    let n = 0;
    kit = await buildKit(skinned.geometry, async part => { S.step(1, `Fitting the kits · ${part} (${++n} of ${KIT_PARTS.length})`); await nextTask(); });
    boot.cache.put(kitKey, packKit(kit));
  }
  S.note('Lighting the players');
  await nextTask();
  let env = null;
  if (renderer) { const pm = new THREE.PMREMGenerator(renderer); env = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose(); }
  S.step(1);
  // the kit's shadow caster: shirt, shorts, socks and boots as one geometry (only what a depth pass
  // reads: positions and skin binding)
  const kitShadow = mergeGeometries(['shirt', 'shorts', 'socks', 'boots'].map(k => {
    const g = new THREE.BufferGeometry(), a = kit[k].attributes;
    g.setAttribute('position', a.position); g.setAttribute('skinIndex', a.skinIndex); g.setAttribute('skinWeight', a.skinWeight);
    return g;
  }));
  return { scene: body.scene, kit, kitShadow, hairGeo, env, knit: lite ? null : knitNormal(), clips, lite, tex: { bAlb, bNor, bRough, eye, hair: [hA, hN] } };
}

// ---------------------------------------------------------------- the character
const _D = new THREE.Quaternion(), _T = new THREE.Quaternion(), _S = new THREE.Quaternion(), _X = new THREE.Vector3(1, 0, 0), _Y = new THREE.Vector3(0, 1, 0);
// Joint ranges are soft: up to 80% of the limit a rotation passes untouched, beyond that it eases
// into the limit (continuous in value and slope), so motion that brushes a limit never kinks or
// flat-tops. `soft(a, max)` maps |a| in [0, inf) onto [0, max).
function soft(a, max) {
  const s = Math.sign(a), x = Math.abs(a), knee = max * 0.8;
  return x <= knee ? a : s * (knee + (max - knee) * (1 - Math.exp(-(x - knee) / (max - knee))));
}
function capAngle(q, max) { // shrink a rotation to at most `max` radians about the same axis
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  const w = Math.min(1, q.w), ang = 2 * Math.acos(w), s = Math.sqrt(1 - w * w);
  if (s < 1e-6) return;
  const a = soft(ang, max);
  if (a === ang) return;
  const k = Math.sin(a / 2) / s;
  q.set(q.x * k, q.y * k, q.z * k, Math.cos(a / 2));
}
const _q = new THREE.Quaternion(), _qc = new THREE.Quaternion(), _Q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const LOCO = ['Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop'];
const BOB = 0.07; // largest vertical pelvis bounce per stride, peak to peak, in metres of the character
// target trunk lean for each gait (radians forward of vertical; idle is owned by the ready stance)
const TRUNK = [0, 0.05, 0.12, 0.2];
// how the posture correction is shared out: pelvis tuck (undone at the thighs), then spine and chest
const POSTURE = [['hips', 0.25], ['thighL', -0.25], ['thighR', -0.25], ['spine', 0.4], ['chest', 0.35]];
export class Human {
  constructor(kit) {
    this.kit = kit;
    this.group = new THREE.Group();   // scaled to the game's player height
    this.ready = false; this.look = null; this.hair = [];
    this.cv = { shirt: canvas(512, 512), shorts: canvas(256, 256), socks: canvas(64, 128), boots: canvas(128, 128) };
    this.tx = Object.fromEntries(Object.entries(this.cv).map(([k, c]) => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.wrapS = THREE.RepeatWrapping; return [k, t]; }));
    this.phase = 0; this.groundY = 0; this.legFwd = { L: 0, R: 0 };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (this.look) this.paint(); });
  }
  // called once the shared assets have loaded
  init(A) {
    this.A = A;
    const root = cloneSkinned(A.scene);
    this.root = root; this.group.add(root);
    const env = { envMap: A.env, envMapIntensity: 0.45 };
    const fabric = map => A.lite
      ? new THREE.MeshStandardMaterial({ map, roughness: 0.78, side: THREE.DoubleSide, envMap: A.env, envMapIntensity: 0.3 })
      : new THREE.MeshPhysicalMaterial({ map, normalMap: A.knit, normalScale: new THREE.Vector2(0.3, 0.3), roughness: 0.78, sheen: 0.3, sheenRoughness: 0.7, sheenColor: new THREE.Color(0x404040), side: THREE.DoubleSide, envMap: A.env, envMapIntensity: 0.3 });
    this.m = {
      skin: new THREE.MeshStandardMaterial({ map: A.tex.bAlb, normalMap: A.tex.bNor, roughnessMap: A.tex.bRough, roughness: 1, metalness: 0, ...env }),
      eyes: new THREE.MeshStandardMaterial({ map: A.tex.eye, roughness: 0.25, ...env }),
      brows: new THREE.MeshStandardMaterial({ map: A.tex.hair[0], normalMap: A.tex.hair[1], roughness: 0.8, ...env }),
      hair: new THREE.MeshStandardMaterial({ map: A.tex.hair[0], normalMap: A.tex.hair[1], roughness: 0.75, ...env }),
      shirt: fabric(this.tx.shirt), shorts: fabric(this.tx.shorts),
      socks: new THREE.MeshStandardMaterial({ map: this.tx.socks, roughness: 0.85, ...env }),
      boots: new THREE.MeshStandardMaterial({ map: this.tx.boots, roughness: 0.3, ...env }),
    };
    let body = null;
    root.traverse(o => {
      if (!o.isSkinnedMesh) return;
      o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
      if (o.name === 'SuperHero_Male') { body = o; o.geometry = A.kit.skin; o.material = this.m.skin; }
      else if (o.name === 'Eyes') { o.material = this.m.eyes; o.castShadow = false; }
      else { o.material = this.m.brows; o.castShadow = false; o.visible = !A.lite; }
    });
    this.body = body;
    for (const k of ['shirt', 'shorts', 'socks', 'boots']) {
      const m = new THREE.SkinnedMesh(A.kit[k], this.m[k]);
      m.castShadow = false; m.receiveShadow = true; m.frustumCulled = false; // its shadow: the caster below
      body.parent.add(m); m.bind(body.skeleton, body.bindMatrix);
    }
    // the kit's shadow, drawn once per shadow map: double-sided like the fabric it stands for, and
    // on a layer only the shadow cameras render (never drawn in the view itself)
    const ks = new THREE.SkinnedMesh(A.kitShadow, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, colorWrite: false, depthWrite: false }));
    ks.castShadow = true; ks.receiveShadow = false; ks.frustumCulled = false; ks.layers.set(SHADOW_LAYER);
    body.parent.add(ks); ks.bind(body.skeleton, body.bindMatrix);
    this.bone = {}; root.traverse(o => { if (o.isBone) this.bone[o.name] = o; });
    const sk = body.skeleton, inv = n => sk.boneInverses[sk.bones.indexOf(this.bone[n])];
    this.headInv = inv('Head');
    // contact points on the boot soles (and the knee cap, for kneeling), in each bone's own space:
    // the exact places that must never go below the grass
    this.contacts = [];
    for (const [s, k] of [[1, 'l'], [-1, 'r']]) {
      const at = (bone, x, y, z) => this.contacts.push({ bone: this.bone[bone + k], p: new THREE.Vector3(s * 0.114 + x, y, z).applyMatrix4(inv(bone + k)) });
      at('foot_', 0, -0.012, -0.145); at('foot_', 0.035 * s, -0.012, -0.1); at('foot_', -0.03 * s, -0.012, -0.1);
      at('ball_', 0.045 * s, -0.012, 0.06); at('ball_', -0.04 * s, -0.012, 0.06); at('ball_', 0, -0.008, 0.16);
      at('calf_', 0, 0.54, 0.065);
    }
    // fingers: the pack's run/idle clench them into fists; hands are eased halfway back to open
    this.fingers = []; root.traverse(o => { if (o.isBone && FINGER.test(o.name)) this.fingers.push([o, o.quaternion.clone()]); });
    // opt-in hand pose (badminton: the racket grip): [bone, local quaternion] pairs written over the
    // eased mocap every frame. Football never sets it, so its hands are untouched.
    this.fingerPose = null;
    this.buildReference();
    this.mixer = new THREE.AnimationMixer(root);
    this.act = {};
    for (const c of A.clips) { const a = this.mixer.clipAction(c); a.play(); a.setEffectiveWeight(0); this.act[c.name] = a; }
    for (const n of LOCO) this.act[n].timeScale = 0; // driven by hand from one shared phase
    // each gait's pelvis bounce: the cycle's mean position (the centre the bounce is measured from)
    // and its peak-to-peak height, in the rig's own units along the rig's up axis
    const upL = new THREE.Vector3(0, 1, 0).applyQuaternion(this.bone.pelvis.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
    this.gaitBob = LOCO.map(n => {
      const tr = this.act[n].getClip().tracks.find(t => t.name === 'pelvis.position'), m = new THREE.Vector3();
      if (!tr) return null;
      const k = tr.values.length / 3; let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < k; i++) {
        const x = tr.values[i * 3], y = tr.values[i * 3 + 1], z = tr.values[i * 3 + 2], u = x * upL.x + y * upL.y + z * upL.z;
        m.x += x / k; m.y += y / k; m.z += z / k; lo = Math.min(lo, u); hi = Math.max(hi, u);
      }
      return { m, p2p: hi - lo };
    });
    this.clock = 0; this.env = []; // recent [time, required lift] samples for the stride envelope
    this.trunk = LOCO.map(n => this._trunkLean(this.act[n]));
    // every bone the layers in animate() edit in place, and what the mixer last produced for each
    this.touched = [...new Set([...this.ref.flat().map(r => r.bone), ...this.fingers.map(f => f[0])])];
    this.mixQ = null; this.mixP = new THREE.Vector3();
    this.ready = true;
    if (this.look) this.setLook(this.look);
  }
  // Reference pose = bind pose with the arms lowered to the sides. Per rig bone keep its local
  // rotation there (L) and its parent's model-space rotation (C), so procedural angles can be
  // applied in model axes whatever axes the rig's bones use.
  buildReference() {
    const b = this.bone;
    this.root.updateMatrixWorld(true);
    const rootInv = this.root.getWorldQuaternion(new THREE.Quaternion()).invert();
    for (const [s, k] of [[1, 'l'], [-1, 'r']]) {
      const ua = b['upperarm_' + k], pw = rootInv.clone().multiply(ua.parent.getWorldQuaternion(new THREE.Quaternion()));
      _q.setFromAxisAngle(_v.set(0, 0, 1), -s * Math.PI / 2);
      ua.quaternion.premultiply(pw.clone().invert().multiply(_q).multiply(pw));
    }
    this.root.updateMatrixWorld(true);
    this.ref = BONES.map(n => RIG[n].map(([bn, share]) => {
      const bone = b[bn];
      const L = bone.quaternion.clone(), C = rootInv.clone().multiply(bone.parent.getWorldQuaternion(new THREE.Quaternion()));
      return { bone, share, L, C, Li: L.clone().invert(), Ci: C.clone().invert() };
    }));
  }
  // average forward pitch of the trunk (pelvis -> base of the neck, from vertical) over a clip's cycle
  _trunkLean(act) {
    const acts = Object.values(this.act), clip = act.getClip(), a = new THREE.Vector3(), b = new THREE.Vector3();
    let sum = 0; const N = 12;
    for (let k = 0; k < N; k++) {
      for (const o of acts) o.setEffectiveWeight(o === act ? 1 : 0);
      act.time = (k + 0.5) / N * clip.duration; this.mixer.update(0);
      this.root.updateMatrixWorld(true);
      this.root.worldToLocal(this.bone.pelvis.getWorldPosition(a)); this.root.worldToLocal(this.bone.neck_01.getWorldPosition(b));
      b.sub(a); sum += Math.atan2(b.z, b.y); // the model faces +z
    }
    for (const o of acts) o.setEffectiveWeight(0);
    return sum / N;
  }
  // image-based lighting for the whole character (the renderer passes the stadium's own)
  setEnvironment(env) {
    if (!this.ready) return;
    const k = { skin: 0.55, eyes: 1, brows: 0.4, hair: 0.45, shirt: 0.4, shorts: 0.4, socks: 0.35, boots: 0.9 };
    for (const [n, m] of Object.entries(this.m)) { m.envMap = env; m.envMapIntensity = k[n] ?? 0.5; m.needsUpdate = true; }
  }
  paint() {
    drawShirt(this.cv.shirt, this.kit, this.look); drawShorts(this.cv.shorts, this.kit); drawSocks(this.cv.socks, this.kit); drawBoots(this.cv.boots, BOOTS[this.look.boots % BOOTS.length]);
    for (const t of Object.values(this.tx)) t.needsUpdate = true;
  }
  setLook(look) {
    this.look = look;
    this.group.scale.setScalar(look.scale);
    this.paint();
    if (!this.ready) return;
    this.m.skin.color.setHex(look.skin).multiplyScalar(1.85); // the albedo is a linear ratio around 0.5
    this.m.hair.color.setHex(look.hairColor);
    this.m.brows.color.setHex(look.hairColor);
    for (const h of this.hair) h.parent.remove(h);
    this.hair = [];
    const add = key => {
      const m = new THREE.Mesh(this.A.hairGeo[key], this.m.hair);
      m.matrixAutoUpdate = false; m.matrix.copy(this.headInv); m.castShadow = true;
      this.bone.Head.add(m); this.hair.push(m);
    };
    if (look.hair !== 'bald') add(look.hair);
    if (look.beard) add('beard');
  }
  // rotation E (model-space Euler, scaled by share) seen from bone r's parent at the reference pose
  _conj(r, x, y, z, order) {
    _e.set(x * r.share, y * r.share, z * r.share, order);
    return _Q.copy(r.C).invert().multiply(_q.setFromEuler(_e)).multiply(r.C);
  }
  // speed: world units/s. over + W: procedural target pose and per-bone weight (0 = pure mocap).
  // add: { pose: additive rotations, lift: extra height, clips: { name: weight } }
  animate(dt, t, speed, over, W, add) {
    if (!this.ready) return;
    if (!(dt >= 0 && dt < 1)) dt = 0;
    if (!Number.isFinite(speed) || speed < 0) speed = 0;
    for (let i = 0; i < W.length; i++) W[i] = Number.isFinite(W[i]) ? clamp(W[i], 0, 1) : 0;
    for (let i = 0; i < over.r.length; i++) if (!Number.isFinite(over.r[i])) { over.r[i] = 0; W[(i / 3) | 0] = 0; }
    if (add.pose) for (let i = 0; i < add.pose.r.length; i++) if (!Number.isFinite(add.pose.r[i])) add.pose.r[i] = 0;
    if (!Number.isFinite(add.lift)) add.lift = 0;
    if (!Number.isFinite(this.phase)) this.phase = 0;
    const sc = this.group.scale.y, v = speed / sc; // metres per second at the character's own scale
    // locomotion: idle / walk / jog / sprint share one normalized phase so the feet stay in step
    const wIdle = 1 - smooth(0.15, 0.9, v), wSprint = smooth(3.6, 4.8, v);
    const wJog = smooth(1.5, 2.3, v) * (1 - wSprint), wWalk = Math.max(0, 1 - wIdle - wJog - wSprint);
    // backpedalling plays the cycle in reverse, so the feet travel the way the body is moving
    const dir = add.dir < 0 ? -1 : 1;
    // the sim's gait phase, when it is provided, is the one true clock: the boot that strikes the
    // ball is the boot the player sees. Backpedalling keeps the local phase (the sim only walks it
    // forwards).
    if (add.serverPhase !== null && add.serverPhase !== undefined && Number.isFinite(add.serverPhase)) this.phase = ((add.serverPhase % 1) + 1) % 1;
    // opt-in (badminton): the caller sets the cadence in cycles per second, matched to its stride so
    // a planted foot stays planted; football never passes it
    else if (Number.isFinite(add.cadence)) this.phase = (((this.phase + dt * add.cadence) % 1) + 1) % 1;
    else this.phase = (((this.phase + dir * dt * (wWalk * 0.95 + wJog * 1.35 + wSprint * 1.5)) % 1) + 1) % 1;
    const clipW = add.clips || {}; let other = 0; for (const k in clipW) other += clipW[k];
    const lk = Math.max(0, 1 - other);
    [wIdle, wWalk, wJog, wSprint].forEach((w, i) => { const a = this.act[LOCO[i]]; a.setEffectiveWeight(w * lk); a.time = i ? this.phase * a.getClip().duration : (t * 0.9) % a.getClip().duration; });
    this.act.Dance_Loop.setEffectiveWeight(clipW.Dance_Loop || 0);
    // three's mixer only writes a bone when its blended value differs from the previous frame's. A
    // bone whose clip value holds still would keep every edit made below, and the next frame's
    // layers would stack on top of it: a braked sprint used to leave the lower spine bent at its
    // limit for good. So each frame starts from exactly what the mixer last produced.
    const pv = this.bone.pelvis;
    if (this.mixQ) { this.touched.forEach((bn, i) => bn.quaternion.copy(this.mixQ[i])); pv.position.copy(this.mixP); }
    this.mixer.update(dt);
    if (this.mixQ) this.touched.forEach((bn, i) => this.mixQ[i].copy(bn.quaternion)); else this.mixQ = this.touched.map(bn => bn.quaternion.clone());
    this.mixP.copy(pv.position);
    for (const [bone, open] of this.fingers) bone.quaternion.slerp(open, 0.5);
    if (this.fingerPose) for (const [bone, q] of this.fingerPose) bone.quaternion.copy(q);
    // The pack's jog and sprint bounce the pelvis (and with it the head) 15-20 cm per stride; a real
    // footballer's runs 6-8 cm. Scale the vertical bounce about the blended gait's own cycle mean
    // (exact, so it adds no lag) down to BOB peak-to-peak; gaits already inside that are untouched.
    {
      const pv = this.bone.pelvis, m = _v.set(0, 0, 0); let ws = 0, p2p = 0;
      [wIdle, wWalk, wJog, wSprint].forEach((w, i) => { const g = this.gaitBob[i]; if (g && w > 0) { m.addScaledVector(g.m, w); p2p += g.p2p * w; ws += w; } });
      if (ws > 0 && lk > 0) {
        m.multiplyScalar(1 / ws); p2p /= ws;
        const pws = pv.parent.getWorldScale(_v2).y, bobW = p2p * pws; // this gait's bounce in world units
        const keep = 1 - lk * (1 - Math.min(1, BOB * sc / Math.max(bobW, 1e-6)));
        if (keep < 0.999) {
          const up = _v2.set(0, 1, 0).applyQuaternion(pv.parent.getWorldQuaternion(_q).invert());
          const d = (pv.position.x - m.x) * up.x + (pv.position.y - m.y) * up.y + (pv.position.z - m.z) * up.z;
          pv.position.addScaledVector(up, -d * (1 - keep));
        }
      }
    }
    // arms answer the legs: measure each thigh's swing in the mocap and swing the opposite arm with
    // it (more at pace), so the arm action always matches the stride, whatever the clip does
    // (legFwd is also read by the caller: a running shot loads the kicking leg on its backswing)
    const run = smooth(1.2, 3.5, v) * lk;
    for (const [k, s] of [['l', 'L'], ['r', 'R']]) {
      const b = this.bone, hip = b['thigh_' + k].getWorldPosition(_v), knee = b['calf_' + k].getWorldPosition(_v2);
      knee.sub(hip).applyQuaternion(this.group.getWorldQuaternion(_q).invert());
      const fwd = Math.atan2(knee.z, -knee.y); // + when this leg is ahead
      this.legFwd[s] = fwd;
      if (run <= 0.01 || !add.pose) continue;
      add.pose.add('arm' + s, fwd * 0.7 * run, 0, 0);
      add.pose.add('fore' + s, -Math.abs(fwd) * 0.35 * run - 0.25 * run, 0, 0);
    }

    // procedural overlay: slerp each rig bone toward its target by the bone's weight
    let wMax = 0;
    for (let i = 0; i < BONES.length; i++) {
      const w = W[i]; if (w < 0.001) continue; wMax = Math.max(wMax, w);
      const x = over.r[i * 3], y = over.r[i * 3 + 1], z = over.r[i * 3 + 2];
      for (const r of this.ref[i]) r.bone.quaternion.slerp(_qc.copy(this._conj(r, x, y, z, ORDER[i])).multiply(r.L), w);
    }
    // Posture. The pack's gaits run hunched (trunk ~13 deg forward at a walk, ~24 at a jog, ~39 in
    // the sprint); a footballer runs tall, a few degrees forward at a walk and 10-12 flat out. The
    // blend's measured lean (see _trunkLean) is brought to that target: the pelvis tucks (the thighs
    // take it back, so the stride is untouched) and the spine and chest straighten over it. Bones a
    // procedural pose owns are left to it.
    {
      let lean = 0, want = 0, ws = 0;
      [wIdle, wWalk, wJog, wSprint].forEach((w, i) => { lean += this.trunk[i] * w; want += TRUNK[i] * w; ws += w; });
      const c = ws > 0 ? (lean - want) / ws * lk : 0;
      if (Math.abs(c) > 1e-4) for (const [n, k] of POSTURE) {
        const i = BI[n], x = -c * k * (1 - W[i]);
        for (const r of this.ref[i]) r.bone.quaternion.premultiply(this._conj(r, x, 0, 0, ORDER[i]));
      }
    }
    // additive layer (look at the ball, stun wobble) on top of whatever is there
    if (add.pose) for (let i = 0; i < BONES.length; i++) {
      const x = add.pose.r[i * 3], y = add.pose.r[i * 3 + 1], z = add.pose.r[i * 3 + 2];
      if (!x && !y && !z) continue;
      for (const r of this.ref[i]) r.bone.quaternion.premultiply(this._conj(r, x, y, z, ORDER[i]));
    }
    // temporal filter: every rig bone eases toward this frame's result at its own rate. Removes pops
    // where layers blend in and out, and lets the torso and arms lag the hips for follow-through.
    const snap = !this.filt || dt > 0.1;
    if (!this.filt) this.filt = this.ref.map(rs => rs.map(() => new THREE.Quaternion()));
    for (let i = 0; i < BONES.length; i++) {
      const k = 1 - Math.exp(-RATE[i] * (add.fast && add.fast[i] ? add.fast[i] : 1) * dt);
      this.ref[i].forEach((r, j) => {
        const f = this.filt[i][j];
        if (snap) f.copy(r.bone.quaternion); else f.slerp(r.bone.quaternion, k);
        r.bone.quaternion.copy(f);
        this._limit(r, LIMIT[i]);
        f.copy(r.bone.quaternion);
      });
    }
    // Ground contact. Hard rule: no sole point (or knee cap) is ever below the grass: if one would be,
    // the body is lifted by exactly that much, immediately.
    // Which way it may move otherwise depends on the gait. Chasing the lowest point every frame
    // pulls a runner down through each flight phase and throws them back up at every footstrike (a
    // sawtooth that shook the whole body). So the body height follows an envelope instead: the
    // largest lift any frame of the last half-stride needed. Every stance foot still lands exactly
    // on the grass, and in between the stride keeps its natural flight. Standing, kicking, sliding
    // or celebrating, the window shrinks to a few frames and the feet settle straight onto the grass.
    const b = this.bone;
    this.group.updateWorldMatrix(true, true);
    const baseY = this.group.getWorldPosition(_v).y;
    let m = Infinity;
    for (const c of this.contacts) m = Math.min(m, _v2.copy(c.p).applyMatrix4(c.bone.matrixWorld).y);
    const target = baseY - m; // world units to move the body up (negative = down) to touch the grass
    const lift = clamp(add.lift || 0, 0, 0.6);
    let legW = 0; for (const i of LEG_I) legW = Math.max(legW, W[i]);
    const rate = wWalk * 0.95 + wJog * 1.35 + wSprint * 1.5; // gait cycles per second
    const gait = lk * (1 - legW) * smooth(0.3, 1.2, v);
    const win = 0.05 + (rate > 0.2 ? gait * 0.55 / rate : 0);
    this.clock += dt;
    const env = this.env; env.push(this.clock, target);
    while (env.length > 2 && env[0] < this.clock - win) env.splice(0, 2);
    let need = -Infinity; for (let i = 1; i < env.length; i += 2) need = Math.max(need, env[i]);
    // opt-in (badminton dive): only keep the soles out of the floor, never pull the body down to it
    if (add.floorOnly) this.groundY = Math.max(0, target);
    else this.groundY = need >= this.groundY ? need : this.groundY + (need - this.groundY) * (1 - Math.exp(-14 * dt));
    this.groundY = clamp(Number.isFinite(this.groundY) ? this.groundY : 0, -0.5, 0.5);
    // the pelvis moves in its parent's space; find world "up" there (the rig's root is rotated)
    const up = _v.set(0, 1, 0).applyQuaternion(b.pelvis.parent.getWorldQuaternion(_q).invert());
    b.pelvis.position.addScaledVector(up, (this.groundY + lift) / sc);
    // last line of defence: a non-finite value anywhere puts the rig back to its reference pose
    let ok = Number.isFinite(b.pelvis.position.x + b.pelvis.position.y + b.pelvis.position.z);
    for (const rs of this.ref) for (const r of rs) { const q = r.bone.quaternion; if (!Number.isFinite(q.x + q.y + q.z + q.w)) ok = false; }
    if (!ok) {
      for (const rs of this.ref) for (const r of rs) r.bone.quaternion.copy(r.L);
      b.pelvis.position.set(0, 0.043, 0.9491); this.filt = null; this.mixQ = null; this.groundY = 0; this.phase = 0; this.env.length = 0;
    }
  }
  // clamp one rig bone to its joint limit (see LIMIT), in the reference-aligned frame of its parent
  _limit(r, lim) {
    const D = _D.copy(r.C).multiply(r.bone.quaternion).multiply(r.Li).multiply(r.Ci).normalize();
    if (D.w < 0) D.set(-D.x, -D.y, -D.z, -D.w);
    if (lim.hinge) {
      let l = Math.hypot(D.x, D.w); const tw = l > 1e-8 ? _T.set(D.x / l, 0, 0, D.w / l) : _T.identity();
      const a = clamp(2 * Math.atan2(tw.x, tw.w), lim.hinge[0] * r.share, lim.hinge[1] * r.share);
      if (lim.strict) D.setFromAxisAngle(_X, a);
      else { const sw = _S.copy(D).multiply(tw.invert()); capAngle(sw, lim.swing); D.copy(sw).multiply(_T.setFromAxisAngle(_X, a)); }
    } else {
      if (lim.twist) { // swing-twist about y: clamp the twist, keep the swing
        const l = Math.hypot(D.y, D.w), tw = l > 1e-8 ? _T.set(0, D.y / l, 0, D.w / l) : _T.identity();
        const a = soft(2 * Math.atan2(tw.y, tw.w), lim.twist * r.share);
        const sw = _S.copy(D).multiply(tw.invert());
        D.copy(sw).multiply(_T.setFromAxisAngle(_Y, a));
      }
      capAngle(D, lim.cap * r.share);
    }
    r.bone.quaternion.copy(r.Ci).multiply(D).multiply(r.C).multiply(r.L);
  }
  // world position of a foot's ball joint (k: 'l' | 'r')
  foot(k, out) { return this.bone['ball_' + k].getWorldPosition(out); }
}
