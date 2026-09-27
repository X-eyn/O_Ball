// Office Ball — footballers. The body, face, hair and animations are Quaternius' CC0 "Universal
// Base Characters" + "Universal Animation Library" (public/models, built by tools/prepare_players.py).
// On top of that: a football kit fitted to the body (shirt, shorts, socks and boots cut from the
// skin mesh and skinned to the same bones), per-player skin tone / hair / boots / name + number,
// mocap locomotion, and procedural kicks, tackles and celebrations layered over the mocap.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

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

function kitGeometry(src, f, offset, uvOf, iters) {
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

function buildKit(body) {
  const sleeve = x => Math.max(0, Math.abs(x) - 0.21);
  const shirt = kitGeometry(body, F.shirt,
    (x, y) => 0.014 + (Math.abs(x) < 0.21 ? 0.026 * smooth(1.25, 0.98, y) : 0.008 + sleeve(x) * 0.09),
    (x, y, z) => Math.abs(x) > 0.21
      ? [around(z + 0.065, (y - 1.455) * Math.sign(x)), 0.25 * (1 - sleeve(x) / 0.16)]
      : [around(z, -x), 0.3 + 0.7 * clamp((y - 0.97) / 0.55, 0, 1)], 10);
  const shorts = kitGeometry(body, F.shorts,
    (x, y) => 0.02 + 0.035 * smooth(0.88, 0.7, y),
    // round the pelvis above the crotch, round each thigh below it; both put u = 0 / 0.5 on the flanks
    (x, y, z) => [y > 0.93 ? around(z, -x) : around(z + 0.03, -(x - Math.sign(x) * 0.1)), clamp((y - 0.7) / 0.36, 0, 1)], 10);
  const socks = kitGeometry(body, F.socks, () => 0.005,
    (x, y, z) => [around(z + 0.04, -(x - Math.sign(x) * 0.114)), clamp((y - 0.07) / 0.4, 0, 1)], 2);
  const boots = kitGeometry(body, F.boots, (x, y) => 0.009 + 0.004 * smooth(0.03, 0, y),
    (x, y, z) => [around(y - 0.05, (x - Math.sign(x) * 0.114) * Math.sign(x)), clamp((z + 0.16) / 0.31, 0, 1)], 3);
  // the skin mesh, minus what the kit fully covers (a margin in from every edge)
  const P = body.attributes.position, idx = body.index.array, kept = [];
  const covered = i => { const x = P.getX(i), y = P.getY(i), z = P.getZ(i); return F.shirt(x, y, z) > 0.03 || F.shorts(x, y) > 0.03 || F.socks(x, y) > 0.03 || F.boots(x, y) > 0.025; };
  for (let t = 0; t < idx.length; t += 3) if (!(covered(idx[t]) && covered(idx[t + 1]) && covered(idx[t + 2]))) kept.push(idx[t], idx[t + 1], idx[t + 2]);
  const skin = body.clone(); skin.setIndex(kept);
  return { shirt, shorts, socks, boots, skin };
}

// ---------------------------------------------------------------- shared assets
let ASSETS = null;
export function resetPlayerAssets() { ASSETS = null; }
export function loadPlayerAssets(renderer) {
  if (ASSETS) return ASSETS;
  const base = '/models/', gl = new GLTFLoader(), tl = new THREE.TextureLoader();
  const tex = (f, srgb = true) => new Promise((res, rej) => tl.load(base + f, t => { t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.flipY = false; t.anisotropy = 4; res(t); }, undefined, rej));
  const gltf = f => new Promise((res, rej) => gl.load(base + f, res, undefined, rej));
  ASSETS = Promise.all([
    gltf('body.glb'), Promise.all(['buzzed', 'buzzedfemale', 'simpleparted', 'beard'].map(h => gltf(`hair_${h}.glb`).then(g => [h, g]))),
    fetch(base + 'anims.json').then(r => r.json()),
    tex('body_albedo.jpg', false), tex('body_normal.jpg', false), tex('body_rough.jpg', false), tex('eye.png'),
    tex('hair_albedo.jpg'), tex('hair_normal.jpg', false),
  ]).then(([body, hairs, anims, bAlb, bNor, bRough, eye, hA, hN]) => {
    let skinned = null;
    body.scene.traverse(o => { if (o.isSkinnedMesh && o.name === 'SuperHero_Male') skinned = o; });
    const hairGeo = {};
    for (const [h, g] of hairs) {
      g.scene.updateMatrixWorld(true);
      g.scene.traverse(o => { if (o.isMesh && !hairGeo[h]) hairGeo[h] = o.geometry.clone().applyMatrix4(o.matrixWorld); });
    }
    let env = null;
    if (renderer) { const pm = new THREE.PMREMGenerator(renderer); env = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose(); }
    return {
      scene: body.scene, kit: buildKit(skinned.geometry), hairGeo, env, knit: knitNormal(),
      // parse() leaves uuid unset here, and the mixer caches actions by clip uuid
      clips: anims.map(c => { const k = THREE.AnimationClip.parse(c); k.uuid = THREE.MathUtils.generateUUID(); return k; }),
      tex: { bAlb, bNor, bRough, eye, hair: [hA, hN] },
    };
  });
  return ASSETS;
}

// ---------------------------------------------------------------- the character
const _q = new THREE.Quaternion(), _qc = new THREE.Quaternion(), _Q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3();
const LOCO = ['Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop'];
export class Human {
  constructor(kit) {
    this.kit = kit;
    this.group = new THREE.Group();   // scaled to the game's player height
    this.ready = false; this.look = null; this.hair = [];
    this.cv = { shirt: canvas(512, 512), shorts: canvas(256, 256), socks: canvas(64, 128), boots: canvas(128, 128) };
    this.tx = Object.fromEntries(Object.entries(this.cv).map(([k, c]) => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.wrapS = THREE.RepeatWrapping; return [k, t]; }));
    this.phase = 0; this.groundY = 0;
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (this.look) this.paint(); });
  }
  // called once the shared assets have loaded
  init(A) {
    this.A = A;
    const root = cloneSkinned(A.scene);
    this.root = root; this.group.add(root);
    const env = { envMap: A.env, envMapIntensity: 0.45 };
    const fabric = map => new THREE.MeshPhysicalMaterial({ map, normalMap: A.knit, normalScale: new THREE.Vector2(0.3, 0.3), roughness: 0.72, sheen: 0.5, sheenRoughness: 0.6, sheenColor: new THREE.Color(0x555555), side: THREE.DoubleSide, ...env });
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
      else { o.material = this.m.brows; o.castShadow = false; }
    });
    this.body = body;
    for (const k of ['shirt', 'shorts', 'socks', 'boots']) {
      const m = new THREE.SkinnedMesh(A.kit[k], this.m[k]);
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
      body.parent.add(m); m.bind(body.skeleton, body.bindMatrix);
    }
    this.bone = {}; root.traverse(o => { if (o.isBone) this.bone[o.name] = o; });
    this.headInv = body.skeleton.boneInverses[body.skeleton.bones.indexOf(this.bone.Head)];
    this.buildReference();
    this.mixer = new THREE.AnimationMixer(root);
    this.act = {};
    for (const c of A.clips) { const a = this.mixer.clipAction(c); a.play(); a.setEffectiveWeight(0); this.act[c.name] = a; }
    for (const n of LOCO) this.act[n].timeScale = 0; // driven by hand from one shared phase
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
      return { bone, share, L: bone.quaternion.clone(), C: rootInv.clone().multiply(bone.parent.getWorldQuaternion(new THREE.Quaternion())) };
    }));
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
    const sc = this.group.scale.y, v = speed / sc; // metres per second at the character's own scale
    // locomotion: idle / walk / jog / sprint share one normalized phase so the feet stay in step
    const wIdle = 1 - smooth(0.15, 0.9, v), wSprint = smooth(3.6, 4.8, v);
    const wJog = smooth(1.5, 2.3, v) * (1 - wSprint), wWalk = Math.max(0, 1 - wIdle - wJog - wSprint);
    this.phase = (this.phase + dt * (wWalk * 0.95 + wJog * 1.35 + wSprint * 1.5)) % 1;
    const clipW = add.clips || {}; let other = 0; for (const k in clipW) other += clipW[k];
    const lk = Math.max(0, 1 - other);
    [wIdle, wWalk, wJog, wSprint].forEach((w, i) => { const a = this.act[LOCO[i]]; a.setEffectiveWeight(w * lk); a.time = i ? this.phase * a.getClip().duration : (t * 0.9) % a.getClip().duration; });
    this.act.Dance_Loop.setEffectiveWeight(clipW.Dance_Loop || 0);
    this.mixer.update(dt);

    // procedural overlay: slerp each rig bone toward its target by the bone's weight
    let wMax = 0;
    for (let i = 0; i < BONES.length; i++) {
      const w = W[i]; if (w < 0.001) continue; wMax = Math.max(wMax, w);
      const x = over.r[i * 3], y = over.r[i * 3 + 1], z = over.r[i * 3 + 2];
      for (const r of this.ref[i]) r.bone.quaternion.slerp(_qc.copy(this._conj(r, x, y, z, ORDER[i])).multiply(r.L), w);
    }
    // additive layer (look at the ball, stun wobble) on top of whatever is there
    if (add.pose) for (let i = 0; i < BONES.length; i++) {
      const x = add.pose.r[i * 3], y = add.pose.r[i * 3 + 1], z = add.pose.r[i * 3 + 2];
      if (!x && !y && !z) continue;
      for (const r of this.ref[i]) r.bone.quaternion.premultiply(this._conj(r, x, y, z, ORDER[i]));
    }
    // feet on the grass: move the pelvis so the lowest foot / knee point sits on y = 0
    const b = this.bone;
    this.group.updateWorldMatrix(true, true);
    const baseY = this.group.getWorldPosition(_v).y;
    let m = Infinity;
    for (const k of ['l', 'r']) m = Math.min(m,
      b['foot_' + k].getWorldPosition(_v).y - 0.085 * sc, b['ball_' + k].getWorldPosition(_v).y - 0.017 * sc,
      b['ball_leaf_' + k].getWorldPosition(_v).y - 0.015 * sc, b['calf_' + k].getWorldPosition(_v).y - 0.06 * sc);
    const target = -(m - baseY) / sc;
    // mocap keeps its own flight phases (smoothed); procedural poses are pinned exactly
    this.groundY = wMax > 0.3 ? target : this.groundY + (target - this.groundY) * (1 - Math.exp(-10 * dt));
    b.pelvis.position.y += this.groundY + (add.lift || 0) / sc;
  }
}
