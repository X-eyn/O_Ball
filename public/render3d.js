// Office Ball — 3D stadium renderer (three.js). Pure presentation: it draws whatever
// state it is given; the authoritative game lives on the server.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Human, Pose, HAIR_KEYS, MODEL_HEIGHT, loadPlayerAssets, resetPlayerAssets, boneIndex } from './human.js';

const C = window.OB.C;
export const S = 0.02; // sim px -> world units
export const wx = x => (x - C.CX) * S;
export const wz = y => (y - C.CY) * S;
const PW = (C.FR - C.FL) * S, PH = (C.FB - C.FT) * S, HW = PW / 2, HH = PH / 2;
const GW = C.GH * S, GDP = C.GD * S, GOAL_H = 1.25, PR = C.PR * S;
// drawn ball radius. The sim's ball is larger (C.BR) for forgiving touches; drawn at that size it
// dwarfs the players, so the model is sized to real proportions (~0.14 of player height).
const BALL_R = 0.11;
const PLAYER_H = 1.6;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));

export const KITS = [
  { shirt: 0xe0283c, shorts: 0xf2f2f2, socks: 0xe0283c, css: '#ff4d5e', light: 0xff8a96 },
  { shirt: 0x1c8cf0, shorts: 0x0c1f3d, socks: 0x1c8cf0, css: '#3fa7ff', light: 0x7cc4ff },
];
const SKIN = [0xe9bb98, 0xd9a07a, 0xc08052, 0x9a6440, 0x6e4428, 0xf0c9a9];
const HAIR = [0x1d1510, 0x3b2616, 0x6b4423, 0xb07b3e, 0x0d0d0d, 0x8a8a8a, 0xd8b36a];
const hash = s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

function canvasTex(w, h, draw, { srgb = true, repeat = false } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// ---------------------------------------------------------------- textures
function pitchTexture() {
  const M = 1.7, W = PW + 2 * M, H = PH + 2 * M;
  const cw = 2048, ch = Math.round(cw * H / W), ppu = cw / W;
  const X = x => (x + W / 2) * ppu, Y = z => (z + H / 2) * ppu;
  const tex = canvasTex(cw, ch, g => {
    const bw = PW / 12;
    for (let i = -3; i < 16; i++) { g.fillStyle = ((i % 2) + 2) % 2 ? '#3c8c3f' : '#337c36'; g.fillRect(X(-HW + i * bw), 0, bw * ppu + 1, ch); }
    const img = g.getImageData(0, 0, cw, ch), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 22; d[i] += n * 0.55; d[i + 1] += n; d[i + 2] += n * 0.45; }
    g.putImageData(img, 0, 0);
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * cw, y = Math.random() * ch, r = rand(50, 240), light = Math.random() < 0.5;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, light ? 'rgba(170,230,120,0.07)' : 'rgba(5,35,8,0.09)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    // darker run-off outside the lines
    g.fillStyle = 'rgba(0,20,0,0.18)';
    g.fillRect(0, 0, cw, Y(-HH)); g.fillRect(0, Y(HH), cw, ch - Y(HH)); g.fillRect(0, Y(-HH), X(-HW), PH * ppu); g.fillRect(X(HW), Y(-HH), cw - X(HW), PH * ppu);
    g.strokeStyle = 'rgba(236,242,236,0.82)'; g.fillStyle = 'rgba(236,242,236,0.85)'; g.lineWidth = 0.085 * ppu;
    const line = (x1, z1, x2, z2) => { g.beginPath(); g.moveTo(X(x1), Y(z1)); g.lineTo(X(x2), Y(z2)); g.stroke(); };
    const spot = (x, z, r = 0.09) => { g.beginPath(); g.arc(X(x), Y(z), r * ppu, 0, Math.PI * 2); g.fill(); };
    g.strokeRect(X(-HW), Y(-HH), PW * ppu, PH * ppu);
    line(0, -HH, 0, HH);
    g.beginPath(); g.arc(X(0), Y(0), 1.6 * ppu, 0, Math.PI * 2); g.stroke(); spot(0, 0, 0.12);
    for (const sg of [-1, 1]) {
      const gx = sg * HW;
      g.strokeRect(sg < 0 ? X(gx) : X(gx - 2.2), Y(-3), 2.2 * ppu, 6 * ppu);
      g.strokeRect(sg < 0 ? X(gx) : X(gx - 0.8), Y(-1.8), 0.8 * ppu, 3.6 * ppu);
      spot(gx - sg * 1.6, 0);
      g.save(); g.beginPath();
      if (sg < 0) g.rect(X(gx + 2.2), 0, cw, ch); else g.rect(0, 0, X(gx - 2.2), ch);
      g.clip(); g.beginPath(); g.arc(X(gx - sg * 1.6), Y(0), 1.5 * ppu, 0, Math.PI * 2); g.stroke(); g.restore();
    }
    for (const [cx, cz, a0] of [[-HW, -HH, 0], [HW, -HH, Math.PI / 2], [HW, HH, Math.PI], [-HW, HH, Math.PI * 1.5]]) {
      g.beginPath(); g.arc(X(cx), Y(cz), 0.4 * ppu, a0, a0 + Math.PI / 2); g.stroke();
    }
  });
  return { tex, W, H };
}

function ballTexture() {
  const ico = new THREE.IcosahedronGeometry(1, 0), pos = ico.attributes.position;
  const pent = [], hex = [];
  const key = v => v.toArray().map(n => n.toFixed(3)).join();
  const seen = new Set();
  for (let i = 0; i < pos.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(pos, i).normalize(); if (!seen.has(key(v))) { seen.add(key(v)); pent.push(v); } }
  for (let i = 0; i < pos.count; i += 3) hex.push(new THREE.Vector3().fromBufferAttribute(pos, i).add(new THREE.Vector3().fromBufferAttribute(pos, i + 1)).add(new THREE.Vector3().fromBufferAttribute(pos, i + 2)).normalize());
  const centers = pent.map(v => [v, 1]).concat(hex.map(v => [v, 0]));
  return canvasTex(512, 256, (g, w, h) => {
    const img = g.createImageData(w, h), d = img.data;
    for (let j = 0; j < h; j++) {
      const th = (j + 0.5) / h * Math.PI, st = Math.sin(th), ct = Math.cos(th);
      for (let i = 0; i < w; i++) {
        const ph = (i + 0.5) / w * Math.PI * 2;
        const x = -Math.cos(ph) * st, y = ct, z = Math.sin(ph) * st;
        let b1 = -2, b2 = -2, t1 = 0;
        for (const [v, t] of centers) {
          const dt = v.x * x + v.y * y + v.z * z + (t ? 0.035 : 0);
          if (dt > b1) { b2 = b1; b1 = dt; t1 = t; } else if (dt > b2) b2 = dt;
        }
        let c = t1 ? 28 : 246;
        if (b1 - b2 < 0.012) c = t1 ? 60 : 120;
        const k = (j * w + i) * 4; d[k] = c; d[k + 1] = c; d[k + 2] = c + (t1 ? 6 : 0); d[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  });
}

function boardTexture() {
  return canvasTex(1024, 64, (g, w, h) => {
    g.fillStyle = '#040a16'; g.fillRect(0, 0, w, h);
    const items = [['OFFICE BALL', '#ffd34d'], ['WINNER STAYS ON', '#ffffff'], ['PERFECT KICK', '#3fa7ff'], ['ONE MORE GAME', '#ff4d5e']];
    let x = 10;
    g.textBaseline = 'middle';
    for (const [t, col] of items) {
      g.font = '900 38px "Arial Black", Impact, sans-serif'; g.fillStyle = col; g.fillText(t, x, h / 2 + 2);
      x += g.measureText(t).width + 26;
      g.fillStyle = 'rgba(255,255,255,.5)'; g.beginPath(); g.arc(x - 13, h / 2, 4, 0, 7); g.fill();
    }
    g.fillStyle = 'rgba(0,0,0,.35)'; // LED grid
    for (let i = 0; i < w; i += 3) g.fillRect(i, 0, 1, h);
    for (let j = 0; j < h; j += 3) g.fillRect(0, j, w, 1);
  }, { repeat: true });
}

function netTexture() {
  return canvasTex(64, 64, (g, w, h) => {
    g.clearRect(0, 0, w, h); g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 3;
    g.strokeRect(0, 0, w, h);
  }, { repeat: true });
}

function glowTexture() {
  return canvasTex(128, 128, (g, w) => {
    const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(255,245,220,.6)'); gr.addColorStop(1, 'rgba(255,240,200,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, w);
  });
}

function skyTexture() {
  return canvasTex(4, 512, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#03060f'); gr.addColorStop(0.55, '#0a1430'); gr.addColorStop(1, '#1b2b55');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
}

// ---------------------------------------------------------------- shaders
const arcVert = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const arcFrag = `uniform float progress; uniform vec3 color; uniform float opacity; uniform float inner; varying vec2 vUv;
void main(){
  vec2 p = vUv*2.0-1.0; float r = length(p);
  if (r > 1.0 || r < inner) discard;
  float a = atan(p.x, p.y); if (a < 0.0) a += 6.2831853;
  if (a / 6.2831853 > progress) discard;
  float e = smoothstep(1.0, 0.9, r) * smoothstep(inner, inner + 0.08, r);
  gl_FragColor = vec4(color, opacity * e);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
function arcMaterial(color, inner, opacity = 1) {
  return new THREE.ShaderMaterial({
    uniforms: { progress: { value: 1 }, color: { value: new THREE.Color(color) }, opacity: { value: opacity }, inner: { value: inner } },
    vertexShader: arcVert, fragmentShader: arcFrag, transparent: true, depthWrite: false,
  });
}

const partVert = `attribute float aSize; attribute float aAlpha; attribute vec3 aColor; uniform float uScale;
varying float vAlpha; varying vec3 vColor;
void main(){ vAlpha = aAlpha; vColor = aColor; vec4 mv = modelViewMatrix * vec4(position,1.0);
  gl_PointSize = aSize * uScale / -mv.z; gl_Position = projectionMatrix * mv; }`;
const partFrag = `varying float vAlpha; varying vec3 vColor;
void main(){ if (vAlpha < 0.01) discard; vec2 c = gl_PointCoord - 0.5; float d = length(c); if (d > 0.5) discard;
  gl_FragColor = vec4(vColor, smoothstep(0.5, 0.25, d) * vAlpha);
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------- particles
class Particles {
  constructor(scene, max = 2400) {
    this.max = max; this.n = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max); this.alpha = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.max_life = new Float32Array(max);
    this.grav = new Float32Array(max); this.drag = new Float32Array(max); this.sway = new Float32Array(max);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({ uniforms: { uScale: { value: 800 } }, vertexShader: partVert, fragmentShader: partFrag, transparent: true, depthWrite: false });
    this.points = new THREE.Points(g, this.mat); this.points.frustumCulled = false; this.points.renderOrder = 5;
    scene.add(this.points); this.geo = g; this.cursor = 0; this.tmp = new THREE.Color();
  }
  emit(x, y, z, vx, vy, vz, color, size, life, grav = 9, drag = 1.5, sway = 0) {
    this.idle = false;
    const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
    this.pos.set([x, y, z], i * 3); this.vel.set([vx, vy, vz], i * 3);
    this.tmp.set(color); this.col.set([this.tmp.r, this.tmp.g, this.tmp.b], i * 3);
    this.size[i] = size; this.life[i] = life; this.max_life[i] = life; this.alpha[i] = 1;
    this.grav[i] = grav; this.drag[i] = drag; this.sway[i] = sway;
  }
  burst(x, y, z, n, { color = 0xffffff, colors = null, speed = 3, up = 2, size = 0.12, life = 0.8, grav = 9, drag = 1.5, sway = 0 } = {}) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, s = Math.random() * speed;
      this.emit(x, y, z, Math.cos(a) * s, Math.random() * up, Math.sin(a) * s, colors ? colors[k % colors.length] : color, size * rand(0.6, 1.3), life * rand(0.6, 1.2), grav, drag, sway);
    }
  }
  update(dt, t) {
    if (this.idle) return;
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      alive++;
      this.life[i] -= dt;
      const k = i * 3, dr = Math.exp(-this.drag[i] * dt);
      this.vel[k] *= dr; this.vel[k + 2] *= dr; this.vel[k + 1] = this.vel[k + 1] * dr - this.grav[i] * dt;
      this.pos[k] += (this.vel[k] + Math.sin(t * 5 + i) * this.sway[i]) * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      if (this.pos[k + 1] < 0.02) { this.pos[k + 1] = 0.02; this.vel[k + 1] *= -0.3; this.vel[k] *= 0.6; this.vel[k + 2] *= 0.6; }
      this.alpha[i] = Math.min(1, this.life[i] / (this.max_life[i] * 0.4));
    }
    for (const a of ['position', 'aColor', 'aSize', 'aAlpha']) this.geo.attributes[a].needsUpdate = true;
    if (!alive) this.idle = true; // one last upload with everything faded out, then sleep
  }
}

// ---------------------------------------------------------------- player model
let PG = null;
function playerGeoms() {
  if (PG) return PG;
  PG = {
    star: new THREE.OctahedronGeometry(0.06),
    arrow: new THREE.ConeGeometry(0.13, 0.24, 4).rotateX(Math.PI),
    baseRing: new THREE.RingGeometry(PR + 0.06, PR + 0.14, 48).rotateX(-Math.PI / 2),
    reachRing: new THREE.RingGeometry(C.REACH * S - 0.025, C.REACH * S, 64).rotateX(-Math.PI / 2),
    disc: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  };
  return PG;
}

const EYES = [0x4a2f1b, 0x2b1a10, 0x3d6b8f, 0x5b7a3a, 0x6b4a2a, 0x1e120a];
// everything about a player's appearance comes from their name, so a person always looks the same
function lookFor(name, slot) {
  const h = hash(name || String(slot)), r = k => (hash(h + ':' + k) % 1000) / 1000;
  return {
    name, number: name === 'BOT' ? 0 : 1 + (h >>> 8) % 99,
    skin: SKIN[h % SKIN.length], hairColor: HAIR[(h >>> 4) % HAIR.length], eyes: EYES[(h >>> 3) % EYES.length],
    hair: HAIR_KEYS[Math.floor(r('hair') * HAIR_KEYS.length)], beard: r('beard') < 0.3,
    scale: PLAYER_H / MODEL_HEIGHT * (0.96 + r('h') * 0.09), boots: Math.floor(r('boots') * 6),
    foot: r('foot') < 0.8 ? 'R' : 'L', seed: r('seed') * 100,
  };
}

// ---- procedural animation: each function writes bone rotations (radians) into a Pose.
// Conventions: +x on a thigh/arm swings it back, +x on a shin bends the knee, -x on a forearm bends
// the elbow, +y on an arm twists it about its own length, +x on a foot points the toes; +z on the left (L, +x side) limb lifts it outward.
const SIDES = [[1, 'L'], [-1, 'R']];
function runPose(P, ph, A, t, seed) {
  const idle = 1 - Math.min(1, A * 2.5), br = Math.sin(t * 1.9 + seed);
  P.zero();
  for (const [s, k] of SIDES) {
    const psi = ph + (s > 0 ? 0 : Math.PI), sp = Math.sin(psi);
    const th = A * (-0.62 * sp - 0.1) - 0.08 * idle;
    const kn = A * (0.22 + 1.25 * Math.max(0, Math.cos(psi - 0.6)) ** 2) + 0.17 * idle;
    P.set('thigh' + k, th, 0, s * 0.045 * idle + s * 0.015);
    P.set('shin' + k, kn);
    P.set('foot' + k, -(th + kn) * 0.75 + A * 0.4 * Math.max(0, -sp) - 0.06 * idle, 0, -s * 0.04 * idle);
    P.set('toe' + k, -A * 0.45 * Math.max(0, -sp));
    P.set('clav' + k, 0, 0, s * br * 0.018 * idle);
    P.set('arm' + k, A * 0.8 * sp + 0.04, 0, s * (0.13 + A * 0.05 + Math.sin(t * 1.3 + s + seed) * 0.02 * idle));
    P.set('fore' + k, -(0.28 + A * 1.05) + A * 0.3 * sp);
    P.set('hand' + k, 0, 0, s * 0.1);
  }
  const tw = Math.sin(ph);
  P.set('hips', A * 0.06, -A * 0.17 * tw, Math.sin(t * 0.8 + seed) * 0.035 * idle);
  P.set('spine', 0.03 + A * 0.09, A * 0.06 * tw, -Math.sin(t * 0.8 + seed) * 0.02 * idle);
  P.set('chest', 0.02 + br * 0.016 * idle, A * 0.24 * tw);
  P.set('neck', -A * 0.1, -A * 0.08 * tw);
  P.set('head', 0.04 * idle, -A * 0.04 * tw);
  P.lift = A * 0.025 * Math.max(0, -Math.cos(ph * 2));
}
// kick leg K: windup (w, 0..1), swing progress (u, 0..1, or -1), follow-through (ft, 1 -> 0)
function kickPose(Q, K, w, u, ft) {
  const S = K === 'L' ? 'R' : 'L', sk = K === 'L' ? 1 : -1, ss = -sk;
  let th, kn, fo = 0.55, tw;
  if (u >= 0) {
    const e = u * u * (3 - 2 * u);
    th = 0.9 - 2.25 * e;
    kn = u < 0.55 ? 1.75 - 0.35 * u / 0.55 : 1.4 * Math.pow(1 - (u - 0.55) / 0.45, 1.6) + 0.08;
    tw = sk * (0.3 - 0.7 * e);
  } else if (ft > 0) { th = -1.35; kn = 0.12 + 0.3 * (1 - ft); tw = -sk * 0.4; }
  else { th = 0.9; kn = 1.75; tw = sk * 0.3; }
  Q.set('thigh' + K, th, 0, sk * 0.06); Q.set('shin' + K, kn); Q.set('foot' + K, fo); Q.set('toe' + K, 0.1);
  Q.set('thigh' + S, -0.28, 0, ss * 0.06); Q.set('shin' + S, 0.45); Q.set('foot' + S, -0.12); Q.set('toe' + S, 0);
  Q.set('hips', 0.06, tw, 0); Q.set('spine', -0.06, tw * 0.3); Q.set('chest', -0.06, tw * 0.6);
  Q.set('arm' + S, -0.35, 0, ss * 1.1); Q.set('fore' + S, -0.45);
  Q.set('arm' + K, 0.55, 0, sk * 0.4); Q.set('fore' + K, -0.7);
  Q.set('neck', 0.22); Q.set('head', 0.28);
  Q.lift = 0;
}
// tackle: lunge / slide with the lead leg out, trailing knee down, arms wide for balance
function dashPose(Q, K) {
  const S = K === 'L' ? 'R' : 'L', sk = K === 'L' ? 1 : -1;
  Q.zero();
  Q.set('thigh' + K, -1.15, 0, sk * 0.12); Q.set('shin' + K, 0.12); Q.set('foot' + K, -0.35);
  Q.set('thigh' + S, 0.4, 0, -sk * 0.05); Q.set('shin' + S, 1.5); Q.set('foot' + S, 0.35);
  for (const [s, k] of SIDES) { Q.set('arm' + k, -0.35, 0, s * 1.15); Q.set('fore' + k, -0.55); }
  Q.set('spine', 0.18); Q.set('chest', 0.1); Q.set('neck', -0.25); Q.set('head', -0.05);
}
const CELEBRATIONS = ['jump', 'kneel', 'plane', 'dance'];
function celebratePose(Q, style, c, t, K) {
  Q.zero();
  if (style === 'jump') {
    const j = Math.abs(Math.sin(c * 5.5));
    for (const [s, k] of SIDES) {
      Q.set('arm' + k, -0.2, 0, s * (2.5 + 0.3 * j)); Q.set('fore' + k, -0.3 - 0.5 * (1 - j)); Q.set('clav' + k, 0, 0, s * 0.2);
      Q.set('thigh' + k, -0.1 - 0.4 * j); Q.set('shin' + k, 0.45 + 0.5 * j); Q.set('foot' + k, 0.3 * j - 0.2);
    }
    Q.set('spine', -0.12); Q.set('chest', -0.06); Q.set('neck', -0.25); Q.set('head', -0.1);
    Q.lift = j * 0.36;
  } else if (style === 'kneel') {
    const F = K === 'L' ? 'R' : 'L', pump = Math.sin(c * 9) * 0.15;
    Q.set('thigh' + F, -1.45, 0, 0); Q.set('shin' + F, 1.45); Q.set('foot' + F, 0.02);
    Q.set('thigh' + K, 0.12); Q.set('shin' + K, 1.6); Q.set('foot' + K, 0.7); Q.set('toe' + K, -0.6);
    for (const [s, k] of SIDES) { Q.set('arm' + k, -0.9 + pump, 0, s * 0.55); Q.set('fore' + k, -1.7 - pump); Q.set('hand' + k, 0.3); }
    Q.set('spine', -0.28); Q.set('chest', -0.12); Q.set('neck', -0.3); Q.set('head', -0.15);
  } else {
    runPose(Q, c * 12, 0.55, t, 0);
    for (const [s, k] of SIDES) { Q.set('arm' + k, -0.08 + Math.sin(c * 2.4) * 0.1 * s, 0, s * 1.45); Q.set('fore' + k, -0.12); Q.set('hand' + k, 0, 0, 0); }
    Q.set('neck', -0.2); Q.set('head', -0.1);
  }
}
const SADS = ['head', 'slump'];
function sadPose(Q, style, t) {
  Q.zero();
  for (const [s, k] of SIDES) { Q.set('thigh' + k, -0.05, 0, s * 0.05); Q.set('shin' + k, 0.12); Q.set('foot' + k, -0.07); }
  if (style === 'head') {
    for (const [s, k] of SIDES) { Q.set('arm' + k, -0.35, s * 1.57, s * 2.2); Q.set('fore' + k, -2.1); Q.set('hand' + k, 0.3); }
    Q.set('spine', -0.05); Q.set('neck', -0.1); Q.set('head', -0.15 + Math.sin(t * 0.9) * 0.05);
  } else {
    for (const [s, k] of SIDES) { Q.set('arm' + k, 0.08, 0, s * 0.07); Q.set('fore' + k, -0.12); Q.set('clav' + k, 0, 0, -s * 0.08); }
    Q.set('spine', 0.26); Q.set('chest', 0.1); Q.set('neck', 0.35); Q.set('head', 0.3 + Math.sin(t * 0.7) * 0.05);
  }
}

class Player {
  constructor(scene, slot) {
    const G = playerGeoms(), kit = KITS[slot];
    this.slot = slot;
    this.root = new THREE.Group(); scene.add(this.root);
    this.lean = new THREE.Group(); this.root.add(this.lean);  // whole-body lean pivots at the feet
    this.h = new Human(kit); this.lean.add(this.h.group);
    this.P = new Pose(); this.Q = new Pose(); this.AD = new Pose(); this.W = new Float32Array(this.P.r.length / 3);
    // stars when stunned
    this.stars = new THREE.Group(); this.stars.position.y = 1.8; this.root.add(this.stars);
    const mStar = new THREE.MeshBasicMaterial({ color: 0xffd34d });
    for (let k = 0; k < 3; k++) { const s = new THREE.Mesh(G.star, mStar); this.stars.add(s); }
    // ground decals
    this.baseRing = new THREE.Mesh(G.baseRing, new THREE.MeshBasicMaterial({ color: kit.css, transparent: true, opacity: 0.35, depthWrite: false }));
    this.baseRing.position.y = 0.012; this.root.add(this.baseRing);
    this.reach = new THREE.Mesh(G.reachRing, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false }));
    this.reach.position.y = 0.014; this.root.add(this.reach);
    this.charge = new THREE.Mesh(G.disc, arcMaterial(0xffffff, 0.8)); this.charge.scale.setScalar((PR + 0.32) * 2); this.charge.position.y = 0.02; this.root.add(this.charge);
    this.cool = new THREE.Mesh(G.disc, arcMaterial(0xffffff, 0.86, 0.45)); this.cool.scale.setScalar((PR + 0.17) * 2); this.cool.position.y = 0.016; this.root.add(this.cool);
    this.arrow = new THREE.Mesh(G.arrow, new THREE.MeshBasicMaterial({ color: kit.light })); this.arrow.position.y = 1.95; this.root.add(this.arrow);
    for (const o of [this.baseRing, this.reach, this.charge, this.cool]) o.renderOrder = 2;
    Object.assign(this, {
      phase: 0, yaw: slot ? -Math.PI / 2 : Math.PI / 2, lastX: null, lastZ: null, speed: 0, kickT: 0, windup: 0, identity: null,
      celebrate: 0, swingT: 0, swingDur: 0.1, vx: 0, vz: 0, ax: 0, az: 0, roll: 0, pitch: 0,
      dashW: 0, celW: 0, sadW: 0, stunW: 0, lookY: 0, lookX: 0, celStyle: 'jump', sadStyle: 'head', wasCel: false, wasSad: false,
    });
    this.setIdentity('');
    this.root.visible = false;
  }
  setIdentity(name) {
    if (name === this.identity) return;
    this.identity = name;
    this.look = lookFor(name, this.slot);
    this.h.setLook(this.look);
  }
  update(p, dt, t, o) {
    // p: sim player array [x,y,fx,fy,ct,stun,dash,dashCd,recover]
    this.root.visible = true;
    const x = wx(p[0]), z = wz(p[1]);
    if (this.lastX === null || Math.hypot(x - this.lastX, z - this.lastZ) > 1.5) { this.lastX = x; this.lastZ = z; this.vx = this.vz = 0; }
    const ivx = dt > 0 ? (x - this.lastX) / dt : 0, ivz = dt > 0 ? (z - this.lastZ) / dt : 0;
    const pvx = this.vx, pvz = this.vz;
    this.vx = damp(this.vx, ivx, 14, dt); this.vz = damp(this.vz, ivz, 14, dt);
    if (dt > 0) { this.ax = damp(this.ax, (this.vx - pvx) / dt, 8, dt); this.az = damp(this.az, (this.vz - pvz) / dt, 8, dt); }
    const sp = Math.hypot(this.vx, this.vz);
    this.speed = damp(this.speed, sp, 12, dt); this.lastX = x; this.lastZ = z;
    // body weight: lean into turns (lateral acceleration) and forward/back with speed changes
    const hx = sp > 0.3 ? this.vx / sp : 0, hz = sp > 0.3 ? this.vz / sp : 0;
    const lat = hx * this.az - hz * this.ax, fwd = hx * this.ax + hz * this.az;
    this.roll = damp(this.roll, clamp(lat * 0.035, -0.38, 0.38), 10, dt);
    this.pitch = damp(this.pitch, clamp(fwd * 0.022, -0.3, 0.25), 10, dt);
    this.root.position.set(x, 0, z);
    const stun = !!p[5], dash = !!p[6], ct = o.ct;
    const tgtYaw = Math.atan2(p[2], p[3]);
    let dy = tgtYaw - this.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * (1 - Math.exp(-(stun ? 2 : 16) * dt));
    this.root.rotation.y = this.yaw;
    const amp = clamp(this.speed / 4.5, 0, 1.25), A = Math.min(amp, 1.1);
    this.phase += dt * (6 + this.speed * 2.2) * (amp > 0.05 ? 1 : 0);
    this.kickT = Math.max(0, this.kickT - dt * 4.5);
    this.swingT = Math.max(0, this.swingT - dt);
    const charging = ct >= 0;
    this.windup = damp(this.windup, charging ? Math.min(ct / C.CHARGE_FULL, 1) : 0, 14, dt);

    // ---- animation: mocap locomotion underneath (in Human), procedural layers over it.
    // Each layer is a target pose plus a per-bone weight; later layers composite over earlier ones.
    const P = this.P, Q = this.Q, W = this.W, AD = this.AD, L = this.look, K = L.foot, S2 = K === 'L' ? 'R' : 'L';
    P.zero(); W.fill(0); AD.zero();
    const layer = wOf => {
      for (let i = 0; i < W.length; i++) {
        const wl = wOf(i); if (wl <= 0.001) continue;
        const nw = W[i] + wl * (1 - W[i]), k = wl / nw;
        for (let c = i * 3; c < i * 3 + 3; c++) P.r[c] += (Q.r[c] - P.r[c]) * k;
        W[i] = nw;
      }
    };
    const swinging = this.swingT > 0;
    const kw = Math.max(this.windup, swinging ? 1 : 0, this.kickT);
    if (kw > 0.001) {
      // while only winding up, the standing leg keeps running on the mocap
      runPose(Q, this.phase, A, t, L.seed); kickPose(Q, K, this.windup, swinging ? 1 - this.swingT / this.swingDur : -1, this.kickT);
      const support = new Set(['thigh', 'shin', 'foot', 'toe'].map(n => boneIndex(n + S2)));
      const full = swinging || this.kickT > 0;
      layer(i => (support.has(i) && !full ? kw * 0.25 : kw));
    }
    this.dashW = damp(this.dashW, dash ? 1 : 0, dash ? 20 : 7, dt);
    if (this.dashW > 0.001) { dashPose(Q, K); layer(() => this.dashW); }
    if (o.celebrate && !this.wasCel) this.celStyle = CELEBRATIONS[(Math.random() * CELEBRATIONS.length) | 0];
    if (o.sad && !this.wasSad) this.sadStyle = SADS[(Math.random() * SADS.length) | 0];
    this.wasCel = !!o.celebrate; this.wasSad = !!o.sad;
    this.celebrate = o.celebrate ? this.celebrate + dt : 0;
    this.celW = damp(this.celW, o.celebrate ? 1 : 0, 7, dt);
    this.sadW = damp(this.sadW, o.sad ? 1 : 0, 4, dt);
    const clips = {};
    let lift = 0;
    if (this.celW > 0.001) {
      if (this.celStyle === 'dance') clips.Dance_Loop = this.celW;
      else { celebratePose(Q, this.celStyle, this.celebrate, t, K); layer(() => this.celW); lift = Q.lift * this.celW; }
    }
    if (this.sadW > 0.001) { sadPose(Q, this.sadStyle, t); layer(() => this.sadW); }
    this.stunW = damp(this.stunW, stun ? 1 : 0, 8, dt);
    if (this.stunW > 0.001) {
      const w = this.stunW;
      for (const [s, k] of SIDES) { AD.add('arm' + k, 0.2 * w * Math.sin(t * 7 + s), 0, s * 0.15 * w); AD.add('shin' + k, 0.25 * w); AD.add('thigh' + k, -0.1 * w); }
      AD.add('neck', 0.2 * w, 0, Math.sin(t * 5) * 0.2 * w); AD.add('head', 0.1 * w, Math.sin(t * 3.3) * 0.25 * w, Math.sin(t * 5 + 1) * 0.2 * w);
    }
    // eyes on the ball: the head turns toward it and tips down when it is close
    const free = 1 - Math.max(this.celW, this.sadW);
    if (o.ball) {
      const bx = o.ball[0] - x, bz = o.ball[1] - z;
      let a = Math.atan2(bx, bz) - this.yaw; a = Math.atan2(Math.sin(a), Math.cos(a));
      this.lookY = damp(this.lookY, clamp(a, -1.15, 1.15) * free, 7, dt);
      this.lookX = damp(this.lookX, clamp(0.5 - Math.hypot(bx, bz) * 0.12, 0, 0.4) * free, 4, dt);
    } else { this.lookY = damp(this.lookY, 0, 4, dt); this.lookX = damp(this.lookX, 0, 4, dt); }
    AD.add('neck', this.lookX * 0.4, this.lookY * 0.4); AD.add('head', this.lookX * 0.6, this.lookY * 0.55);
    AD.add('chest', 0, this.lookY * 0.12);

    // whole-body lean from the feet (the mocap already leans with speed)
    let lean = this.pitch + this.dashW * 0.12 + (swinging ? -0.05 : 0);
    let roll = this.roll;
    lean *= free; roll *= free;
    if (this.celStyle === 'plane') roll += Math.sin(this.celebrate * 2.2) * 0.28 * this.celW;
    roll += Math.sin(t * 9) * 0.22 * this.stunW;
    this.lean.rotation.set(lean, 0, roll);
    AD.add('neck', -lean * 0.5);
    this.h.animate(dt, t, this.speed, P, W, { pose: AD, lift, clips });

    // stun stars
    this.stars.visible = stun;
    if (stun) this.stars.children.forEach((s, k) => { const a = t * 5 + k * 2.09; s.position.set(Math.cos(a) * 0.3, Math.sin(t * 7 + k) * 0.04, Math.sin(a) * 0.3); s.rotation.y = t * 6; });
    // decals
    const mine = o.mine;
    this.baseRing.material.opacity = mine ? 0.75 : 0.35;
    this.arrow.visible = mine && o.live;
    this.arrow.position.y = 2.0 + Math.sin(t * 5) * 0.06; this.arrow.rotation.y = t * 2;
    this.reach.visible = charging && o.live;
    this.charge.visible = charging && o.live;
    if (charging) {
      const perfect = ct >= C.CHARGE_FULL && ct <= C.PERF_END, over = ct > C.PERF_END;
      const u = this.charge.material.uniforms;
      u.progress.value = Math.min(ct / C.CHARGE_FULL, 1);
      u.color.value.setHex(perfect ? 0xffd34d : over ? 0x6f7588 : 0xffffff);
      u.opacity.value = perfect ? 1 : 0.85;
      this.charge.scale.setScalar((PR + 0.32) * 2 * (perfect ? 1 + Math.sin(t * 30) * 0.04 : 1));
    }
    this.cool.visible = o.live && p[7] > 0;
    if (this.cool.visible) this.cool.material.uniforms.progress.value = 1 - p[7] / C.DASH_CD;
  }
  hide() { this.root.visible = false; this.lastX = null; }
  startSwing(sec) { this.swingT = this.swingDur = Math.max(0.03, sec); this.kickT = 0; }
}

// ---------------------------------------------------------------- goals / nets
class Goal {
  constructor(scene, side, netTex) {
    this.side = side; const gx = side * HW; this.gx = gx;
    const g = new THREE.Group(); scene.add(g); this.g = g; this.shakeT = 0;
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.1 });
    const post = new THREE.CylinderGeometry(0.075, 0.075, GOAL_H, 16);
    for (const s of [-1, 1]) { const m = new THREE.Mesh(post, white); m.position.set(gx, GOAL_H / 2, s * GW / 2); m.castShadow = true; g.add(m); }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, GW + 0.15, 16), white);
    bar.rotation.x = Math.PI / 2; bar.position.set(gx, GOAL_H, 0); bar.castShadow = true; g.add(bar);
    const backH = GOAL_H * 0.72, bx = gx + side * GDP;
    const thin = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.5 });
    for (const s of [-1, 1]) { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, backH, 8), thin); m.position.set(bx, backH / 2, s * GW / 2); g.add(m); }
    const netMat = (rx, ry) => { const t = netTex.clone(); t.needsUpdate = true; t.repeat.set(rx, ry); return new THREE.MeshBasicMaterial({ map: t, transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.85 }); };
    // back net (rippling)
    const back = new THREE.PlaneGeometry(GW, backH, 24, 10);
    this.backBase = back.attributes.position.array.slice();
    this.back = new THREE.Mesh(back, netMat(GW / 0.14, backH / 0.14));
    this.back.rotation.y = side * Math.PI / 2; this.back.position.set(bx, backH / 2, 0); g.add(this.back);
    // roof
    const slant = Math.hypot(GDP, GOAL_H - backH);
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(GW, slant), netMat(GW / 0.14, slant / 0.14));
    roof.position.set(gx + side * GDP / 2, (GOAL_H + backH) / 2, 0);
    roof.rotation.order = 'YXZ'; roof.rotation.y = side * Math.PI / 2; roof.rotation.x = -Math.PI / 2 + Math.atan2(GOAL_H - backH, GDP) * 1;
    g.add(roof);
    // sides
    for (const s of [-1, 1]) {
      const sg = new THREE.PlaneGeometry(GDP, GOAL_H, 4, 8), pa = sg.attributes.position;
      for (let i = 0; i < pa.count; i++) {
        const u = (pa.getX(i) + GDP / 2) / GDP, y = pa.getY(i) + GOAL_H / 2;
        pa.setY(i, y * (1 - 0.28 * u)); pa.setX(i, u * GDP * side);
      }
      const m = new THREE.Mesh(sg, netMat(GDP / 0.14, GOAL_H / 0.14)); m.position.set(gx, 0, s * GW / 2); g.add(m);
    }
    this.ripple = null;
  }
  hit(zWorld, strength = 1) { this.ripple = { lx: -this.side * zWorld, t: 0, s: strength }; }
  update(dt) {
    if (this.shakeT > 0) { this.shakeT = Math.max(0, this.shakeT - dt); const a = this.shakeT * 0.06; this.g.position.set(Math.sin(this.shakeT * 90) * a, 0, Math.cos(this.shakeT * 77) * a * 0.5); }
    if (!this.ripple) return;
    const r = this.ripple; r.t += dt;
    const pa = this.back.geometry.attributes.position, base = this.backBase;
    const decay = Math.exp(-r.t * 2.2) * r.s;
    for (let i = 0; i < pa.count; i++) {
      const x = base[i * 3], y = base[i * 3 + 1];
      const d2 = (x - r.lx) ** 2 + (y + 0.1) ** 2;
      pa.setZ(i, 0.38 * decay * Math.exp(-d2 / 0.7) * Math.cos(r.t * 16 - Math.sqrt(d2) * 5));
    }
    pa.needsUpdate = true;
    if (decay < 0.01) { this.ripple = null; for (let i = 0; i < pa.count; i++) pa.setZ(i, 0); pa.needsUpdate = true; }
  }
}

// ---------------------------------------------------------------- stadium
function crowdMaterial(uniforms) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: false });
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPhase; attribute float aSide; uniform float uTime; uniform float uHype; uniform float uHypeR; uniform float uHypeB;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float hype = uHype + (aSide > 0.5 && aSide < 1.5 ? uHypeR : 0.0) + (aSide > 1.5 ? uHypeB : 0.0);
        float bob = abs(sin(uTime * (2.5 + aPhase * 3.0) + aPhase * 40.0));
        transformed.y += bob * (0.025 + 0.42 * clamp(hype, 0.0, 1.3));`);
  };
  return m;
}

function buildStadium(scene, uniforms) {
  const concrete = new THREE.MeshStandardMaterial({ color: 0x232a3a, roughness: 0.92 });
  const seatA = new THREE.MeshStandardMaterial({ color: 0x1a2340, roughness: 0.8 });
  const people = [];
  const reds = [0xd7263d, 0xb81d2e, 0xf2f2f2, 0xe0283c, 0x8e1020];
  const blues = [0x1c8cf0, 0x0c5bb0, 0xf2f2f2, 0x0c1f3d, 0x49a6ff];
  const mixed = [0xd7263d, 0x1c8cf0, 0xf2f2f2, 0x222222, 0xffd34d, 0x3ddc84, 0x8e44ad, 0xe67e22, 0x7f8c8d];
  const sections = [
    { axis: 'x', a0: -HW - 6.5, a1: HW + 6.5, base: -(HH + 2.4), dir: -1, rows: 13, side: 0, pal: mixed },
    { axis: 'x', a0: -HW - 6.5, a1: HW + 6.5, base: HH + 3.4, dir: 1, rows: 5, side: 0, pal: mixed },
    { axis: 'z', a0: -HH - 1.6, a1: HH + 1.6, base: -(HW + 3.2), dir: -1, rows: 10, side: 1, pal: reds },
    { axis: 'z', a0: -HH - 1.6, a1: HH + 1.6, base: HW + 3.2, dir: 1, rows: 10, side: 2, pal: blues },
  ];
  const STEP = 0.7, RISE = 0.42;
  for (const sec of sections) {
    const L = sec.a1 - sec.a0, mid = (sec.a0 + sec.a1) / 2;
    for (let r = 0; r < sec.rows; r++) {
      const off = sec.base + sec.dir * (r * STEP + STEP / 2), h = 0.55 + r * RISE;
      const box = new THREE.Mesh(new THREE.BoxGeometry(sec.axis === 'x' ? L : STEP, h, sec.axis === 'x' ? STEP : L), r % 2 ? concrete : seatA);
      if (sec.axis === 'x') box.position.set(mid, h / 2, off); else box.position.set(off, h / 2, mid);
      box.receiveShadow = true; scene.add(box);
      for (let a = sec.a0 + 0.25; a < sec.a1 - 0.2; a += 0.34) {
        if (Math.random() < 0.1) continue;
        const aa = a + rand(-0.05, 0.05), oo = off + rand(-0.08, 0.08);
        people.push({ x: sec.axis === 'x' ? aa : oo, z: sec.axis === 'x' ? oo : aa, y: h, side: sec.side, color: sec.pal[(Math.random() * sec.pal.length) | 0] });
      }
    }
    // back wall
    const topH = 0.55 + sec.rows * RISE + 1.4, backOff = sec.base + sec.dir * (sec.rows * STEP + 0.2);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(sec.axis === 'x' ? L : 0.4, topH, sec.axis === 'x' ? 0.4 : L), concrete);
    if (sec.axis === 'x') wall.position.set(mid, topH / 2, backOff); else wall.position.set(backOff, topH / 2, mid);
    scene.add(wall);
    // light strip on top of wall
    const strip = new THREE.Mesh(new THREE.BoxGeometry(sec.axis === 'x' ? L : 0.1, 0.08, sec.axis === 'x' ? 0.1 : L), new THREE.MeshBasicMaterial({ color: 0xbfd6ff }));
    if (sec.axis === 'x') strip.position.set(mid, topH, backOff - sec.dir * 0.21); else strip.position.set(backOff - sec.dir * 0.21, topH, mid);
    scene.add(strip);
  }
  // crowd (instanced; animated in the vertex shader)
  const n = people.length;
  const bodyG = new THREE.BoxGeometry(0.22, 0.36, 0.16), headG = new THREE.SphereGeometry(0.08, 8, 6);
  const phase = new Float32Array(n), side = new Float32Array(n);
  people.forEach((p, i) => { phase[i] = Math.random(); side[i] = p.side; });
  for (const g of [bodyG, headG]) { g.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1)); g.setAttribute('aSide', new THREE.InstancedBufferAttribute(side, 1)); }
  const mat = crowdMaterial(uniforms);
  const bodies = new THREE.InstancedMesh(bodyG, mat, n), heads = new THREE.InstancedMesh(headG, mat, n);
  const m4 = new THREE.Matrix4(), col = new THREE.Color();
  people.forEach((p, i) => {
    m4.makeTranslation(p.x, p.y + 0.2, p.z); bodies.setMatrixAt(i, m4); bodies.setColorAt(i, col.setHex(p.color));
    m4.makeTranslation(p.x, p.y + 0.47, p.z); heads.setMatrixAt(i, m4); heads.setColorAt(i, col.setHex(SKIN[(Math.random() * SKIN.length) | 0]));
  });
  bodies.frustumCulled = heads.frustumCulled = false;
  scene.add(bodies, heads);
  return people.length;
}

// ---------------------------------------------------------------- renderer
export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const aniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  scene.background = skyTexture();
  scene.fog = new THREE.Fog(0x0e1a3a, 45, 95);
  const camera = new THREE.PerspectiveCamera(32, 16 / 9, 0.1, 300);

  // lights
  scene.add(new THREE.HemisphereLight(0xc4d4ff, 0x1d3b1d, 1.1));
  const key = new THREE.DirectionalLight(0xfff3dd, 2.6);
  key.position.set(-9, 24, 14); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -15, right: 15, top: 11, bottom: -11, near: 5, far: 60 });
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.9); fill.position.set(10, 18, -12); scene.add(fill);

  // ground + pitch
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x10161f, roughness: 1 }));
  outer.rotation.x = -Math.PI / 2; outer.position.y = -0.02; outer.receiveShadow = true; scene.add(outer);
  const track = new THREE.Mesh(new THREE.PlaneGeometry(PW + 13, PH + 7.5), new THREE.MeshStandardMaterial({ color: 0x1a4a2a, roughness: 1 }));
  track.rotation.x = -Math.PI / 2; track.position.y = -0.01; track.receiveShadow = true; scene.add(track);
  const pt = pitchTexture(); pt.tex.anisotropy = aniso;
  const pitch = new THREE.Mesh(new THREE.PlaneGeometry(pt.W, pt.H), new THREE.MeshStandardMaterial({ map: pt.tex, roughness: 0.95 }));
  pitch.rotation.x = -Math.PI / 2; pitch.receiveShadow = true; scene.add(pitch);

  // ad boards = the walls the ball bounces off
  const bTex = boardTexture(); bTex.anisotropy = aniso;
  const boardTexs = [];
  const boardMatFor = len => {
    const t = bTex.clone(); t.needsUpdate = true; t.repeat.set(len / 5.5, 1); t.offset.x = Math.random(); boardTexs.push(t);
    return new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 1.25, roughness: 0.4 });
  };
  const dark = new THREE.MeshStandardMaterial({ color: 0x0b0f18, roughness: 0.6 });
  const BH = 0.26, BT = 0.07;
  const board = (len, x, z, alongX) => {
    const face = boardMatFor(len);
    const mats = alongX ? [dark, dark, dark, dark, face, face] : [face, face, dark, dark, dark, dark];
    const m = new THREE.Mesh(new THREE.BoxGeometry(alongX ? len : BT, BH, alongX ? BT : len), mats);
    m.position.set(x, BH / 2, z); m.castShadow = true; scene.add(m);
  };
  board(PW + 0.2, 0, -HH - BT / 2 - 0.02, true);
  board(PW + 0.2, 0, HH + BT / 2 + 0.02, true);
  const endLen = HH - GW / 2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) board(endLen, sx * (HW + BT / 2 + 0.02), sz * (GW / 2 + endLen / 2), false);

  const netTex = netTexture();
  const goals = [new Goal(scene, -1, netTex), new Goal(scene, 1, netTex)];

  const crowdU = { uTime: { value: 0 }, uHype: { value: 0 }, uHypeR: { value: 0 }, uHypeB: { value: 0 } };
  buildStadium(scene, crowdU);

  // floodlights
  const glowTex = glowTexture();
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff8e8 });
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a4152, roughness: 0.6, metalness: 0.4 });
  const lamps = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (HW + 8.5), z = sz * (HH + 7.8), h = 17;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.26, h, 10), poleMat); pole.position.set(x, h / 2, z); scene.add(pole);
    const head = new THREE.Group(); head.position.set(x, h + 0.6, z); head.lookAt(0, 0, 0); scene.add(head);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.4, 0.2), poleMat); head.add(panel);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) { const l = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.55), lampMat); l.position.set(-0.85 + i * 0.85, -0.32 + j * 0.64, 0.11); head.add(l); }
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xfff1d6, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85 }));
    glow.scale.setScalar(9); glow.position.copy(head.position); scene.add(glow); lamps.push(glow);
  }
  // stars in the sky
  {
    const n = 400, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, e = rand(0.15, 1.2), r = 120; pos.set([Math.cos(a) * Math.cos(e) * r, Math.sin(e) * r, Math.sin(a) * Math.cos(e) * r], i * 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xaab8ff, size: 0.35, fog: false, transparent: true, opacity: 0.7 })));
  }
  // camera flashes in the crowd
  const flashes = [];
  for (let i = 0; i < 18; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
    s.scale.setScalar(0.9); scene.add(s); flashes.push({ s, t: 0 });
  }
  const placeFlash = f => {
    const side = Math.random();
    if (side < 0.5) f.s.position.set(rand(-HW - 5, HW + 5), rand(1, 5.5), -(HH + 2.4 + rand(0.5, 8)));
    else f.s.position.set((Math.random() < 0.5 ? -1 : 1) * (HW + 3.2 + rand(0.5, 6)), rand(1, 4.5), rand(-HH, HH));
  };

  // jumbotron
  const jCanvas = document.createElement('canvas'); jCanvas.width = 768; jCanvas.height = 256;
  const jTex = new THREE.CanvasTexture(jCanvas); jTex.colorSpace = THREE.SRGBColorSpace; jTex.anisotropy = aniso;
  const jumbo = new THREE.Group(); jumbo.position.set(0, 9.4, -(HH + 2.4 + 13 * 0.7 + 0.6)); scene.add(jumbo);
  const jScreen = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 2.4), new THREE.MeshBasicMaterial({ map: jTex, toneMapped: false }));
  jumbo.add(jScreen);
  const jFrame = new THREE.Mesh(new THREE.BoxGeometry(7.6, 2.8, 0.3), poleMat); jFrame.position.z = -0.2; jumbo.add(jFrame);
  const jLegs = new THREE.Mesh(new THREE.BoxGeometry(0.3, 9.4, 0.3), poleMat); jLegs.position.set(0, -4.7, -0.25); jumbo.add(jLegs);
  let jKey = '';
  function drawJumbo(info, flash) {
    const k = JSON.stringify(info) + (flash || '');
    if (k === jKey) return; jKey = k;
    const g = jCanvas.getContext('2d'), w = jCanvas.width, h = jCanvas.height;
    g.fillStyle = '#050b18'; g.fillRect(0, 0, w, h);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (flash) {
      g.fillStyle = flash.color; g.fillRect(0, 0, w, h);
      g.fillStyle = '#ffffff'; g.font = '900 150px Teko, "Arial Black", sans-serif'; g.fillText(flash.text, w / 2, h / 2 + 12);
    } else if (info) {
      g.fillStyle = KITS[0].css; g.fillRect(0, 0, 14, h); g.fillStyle = KITS[1].css; g.fillRect(w - 14, 0, 14, h);
      g.font = '600 56px Teko, "Arial Black", sans-serif';
      g.fillStyle = '#ffffff';
      g.fillText((info.names[0] || '').toUpperCase().slice(0, 10), w * 0.22, 78);
      g.fillText((info.names[1] || '').toUpperCase().slice(0, 10), w * 0.78, 78);
      g.font = '700 150px Teko, "Arial Black", sans-serif';
      g.fillStyle = KITS[0].css; g.fillText(info.score[0], w * 0.22, 178);
      g.fillStyle = KITS[1].css; g.fillText(info.score[1], w * 0.78, 178);
      g.fillStyle = '#ffd34d'; g.font = '600 60px Teko, "Arial Black", sans-serif'; g.fillText(info.mid || 'VS', w / 2, 128);
    } else {
      g.fillStyle = '#ffd34d'; g.font = '700 120px Teko, "Arial Black", sans-serif'; g.fillText('OFFICE BALL', w / 2, h / 2 + 10);
    }
    g.fillStyle = 'rgba(0,0,0,.28)'; for (let i = 0; i < w; i += 4) g.fillRect(i, 0, 1, h); for (let j = 0; j < h; j += 4) g.fillRect(0, j, w, 1);
    jTex.needsUpdate = true;
  }
  drawJumbo(null);

  // players, ball, trail, particles
  const players = [new Player(scene, 0), new Player(scene, 1)];
  // player models load in the background; retry a few times so a hiccup never leaves invisible players
  const loadPlayers = (tries = 0) => loadPlayerAssets(renderer).then(A => {
    players.forEach(P => P.h.init(A));
    try { renderer.compile(scene, camera); } catch { }
  }).catch(e => {
    console.error('player models failed to load', e);
    resetPlayerAssets();
    if (tries < 5) setTimeout(() => loadPlayers(tries + 1), 1500 * (tries + 1));
  });
  loadPlayers();
  const ballMat = new THREE.MeshStandardMaterial({ map: ballTexture(), roughness: 0.45, emissive: 0xffc02e, emissiveIntensity: 0 });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 32, 20), ballMat);
  ball.castShadow = true; ball.visible = false; scene.add(ball);
  const ballLight = new THREE.PointLight(0xffc34d, 0, 4, 2); scene.add(ballLight);
  const ballBlob = new THREE.Mesh(new THREE.CircleGeometry(BALL_R * 1.3, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
  ballBlob.position.y = 0.013; scene.add(ballBlob);
  let lastBall = null, ballHot = 0;

  const TRAIL = 26;
  const trailPts = [];
  const trailGeo = new THREE.BufferGeometry();
  const trailPos = new Float32Array(TRAIL * 2 * 3), trailA = new Float32Array(TRAIL * 2);
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3).setUsage(THREE.DynamicDrawUsage));
  trailGeo.setAttribute('aA', new THREE.BufferAttribute(trailA, 1).setUsage(THREE.DynamicDrawUsage));
  const idx = []; for (let i = 0; i < TRAIL - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  trailGeo.setIndex(idx);
  const trailMat = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(0xffffff) } },
    vertexShader: 'attribute float aA; varying float vA; void main(){ vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 color; varying float vA; void main(){ gl_FragColor = vec4(color * vA, vA); }',
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const trail = new THREE.Mesh(trailGeo, trailMat); trail.frustumCulled = false; scene.add(trail);

  const parts = new Particles(scene);

  // post-processing
  let composer = null, bloom = null;
  function buildComposer() {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.45, 0.93);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }
  buildComposer();

  // quality. Changing level never recompiles shaders (that would freeze a frame); it only toggles
  // bloom and render resolution, and auto-changes are deferred until play is paused.
  let quality = 'auto', level = 2; // 2 = bloom + hi-res, 1 = no bloom, 0 = no bloom + 1x resolution
  let ftAvg = 16, ftFrames = 0, cssW = 1, cssH = 1, pendingLevel = null;
  function setQuality(q) {
    quality = q; level = q === 'low' ? 0 : 2; ftFrames = 0; ftAvg = 16; pendingLevel = null;
    resize(cssW, cssH);
  }

  // camera: a TV-broadcast framing. The full depth of the pitch is always visible; the width is
  // framed at ~80% and the camera pans with the ball so each goal comes fully into view.
  const EL = THREE.MathUtils.degToRad(46);
  const camDir = new THREE.Vector3(0, Math.sin(EL), Math.cos(EL));
  let fitD = 22, fitZ = 0.4, maxPan = 0, visHalf = 8, fitDFull = 28, camDist = 22;
  const camPos = new THREE.Vector3(0, 20, 18), camTgt = new THREE.Vector3();
  const v3 = new THREE.Vector3(), tgt = new THREE.Vector3(), pos = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), introDir = new THREE.Vector3();
  const _ray = new THREE.Raycaster(), _ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), _hit = new THREE.Vector3(), _ndc = new THREE.Vector2();
  // how far outside the safe frame a set of points is, for a camera panned to px at distance d (>1 = too tight)
  const probe = new THREE.PerspectiveCamera(32, 16 / 9, 0.1, 300);
  function framing(pts, px, d, out) {
    probe.fov = camera.fov; probe.aspect = camera.aspect; probe.updateProjectionMatrix();
    probe.position.set(px, 0, fitZ).addScaledVector(camDir, d); probe.lookAt(px, 0, fitZ); probe.updateMatrixWorld();
    let m = 0, lo = 9, hi = -9;
    for (const p of pts) {
      v3.copy(p).project(probe);
      m = Math.max(m, Math.abs(v3.x) / 0.94, v3.y / 0.96, -v3.y / 0.96);
      lo = Math.min(lo, v3.x); hi = Math.max(hi, v3.x);
    }
    if (out) { out.lo = lo; out.hi = hi; }
    return m;
  }
  const framePts = Array.from({ length: 5 }, () => new THREE.Vector3()), fr = { lo: 0, hi: 0 };
  function fit() {
    const hx = HW * 0.8;
    const horiz = [new THREE.Vector3(-hx, 0, 0), new THREE.Vector3(hx, 0, 0)];
    // vertical framing: the top of a player (plus name tag) standing on the far boundary and the
    // near boundary must both be on screen. The scoreboard lives in its own bar, not over the view.
    const far = new THREE.Vector3(0, 2.45, -HH + PR), near = new THREE.Vector3(0, 0, HH + 0.35);
    const topLimit = 0.97, botLimit = -0.97;
    let d = 22, tz = 0.5;
    for (let it = 0; it < 14; it++) {
      camera.position.set(0, 0, tz).addScaledVector(camDir, d); camera.lookAt(0, 0, tz); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
      let mx = 0; for (const p of horiz) mx = Math.max(mx, Math.abs(v3.copy(p).project(camera).x));
      const top = v3.copy(far).project(camera).y, bot = v3.copy(near).project(camera).y;
      d *= Math.max(mx, (top - bot) / (topLimit - botLimit));
      tz -= ((top + bot) / 2 - (topLimit + botLimit) / 2) * d * 0.15;
    }
    fitD = d; fitZ = tz;
    camera.position.set(0, 0, tz).addScaledVector(camDir, d); camera.lookAt(0, 0, tz); camera.updateMatrixWorld();
    _ray.setFromCamera(_ndc.set(1, 0), camera);
    visHalf = _ray.ray.intersectPlane(_ground, _hit) ? _hit.x : HW;
    maxPan = Math.max(0, HW + GDP + 0.35 - visHalf);
    // distance at which the whole pitch (goals and near corners included) fits, measured exactly
    const corners = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) corners.push(new THREE.Vector3(sx * (HW + GDP + 0.3), 0, sz * (HH + 0.3)));
    corners.push(new THREE.Vector3(0, 2.45, -HH + PR));
    let dd = fitD;
    for (let it = 0; it < 6; it++) { const m = framing(corners, 0, dd); if (Math.abs(m - 1) < 0.005) break; dd *= m; }
    fitDFull = Math.max(fitD, dd);
    camDist = fitD;
    camera.position.copy(camPos); camera.lookAt(camTgt);
  }
  function resize(w, h) {
    cssW = w; cssH = h;
    const pr = Math.min(window.devicePixelRatio || 1, level === 0 ? 1 : level === 1 ? 1.5 : 1.75);
    renderer.setPixelRatio(pr); renderer.setSize(w, h, false);
    composer.setPixelRatio(pr); composer.setSize(w, h);
    bloom.resolution.set(w * pr / 2, h * pr / 2);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    parts.mat.uniforms.uScale.value = h * pr / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    fit();
  }

  // aim arrow (own player, while charging) and mouse target marker
  const arrowShape = new THREE.Shape();
  arrowShape.moveTo(0.5, -0.05); arrowShape.lineTo(1.25, -0.05); arrowShape.lineTo(1.25, -0.16); arrowShape.lineTo(1.6, 0);
  arrowShape.lineTo(1.25, 0.16); arrowShape.lineTo(1.25, 0.05); arrowShape.lineTo(0.5, 0.05); arrowShape.closePath();
  const aimMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false });
  const aimArrow = new THREE.Mesh(new THREE.ShapeGeometry(arrowShape).rotateX(-Math.PI / 2), aimMat);
  aimArrow.position.y = 0.025; aimArrow.renderOrder = 3; aimArrow.visible = false; scene.add(aimArrow);
  const cursor = new THREE.Group(); cursor.visible = false; scene.add(cursor);
  const curMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false });
  cursor.add(new THREE.Mesh(new THREE.RingGeometry(0.2, 0.26, 32).rotateX(-Math.PI / 2), curMat));
  cursor.add(new THREE.Mesh(new THREE.CircleGeometry(0.05, 16).rotateX(-Math.PI / 2), curMat));
  cursor.children.forEach(m => { m.position.y = 0.02; m.renderOrder = 3; });

  // shockwave rings on hard contact
  const waves = Array.from({ length: 6 }, () => {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    m.position.y = 0.03; m.renderOrder = 4; m.visible = false; scene.add(m); return { m, t: 0, dur: 0.3, max: 2 };
  });
  let waveIdx = 0;
  function wave(x, z, y, color, max, dur) { const w = waves[waveIdx++ % waves.length]; w.m.position.set(x, y, z); w.m.material.color.setHex(color); w.t = 0; w.dur = dur; w.max = max; w.m.visible = true; }
  const camKick = new THREE.Vector3();
  let ballSquash = 0, fovPunch = 0;

  // effects state
  let shake = 0, hype = 0, hypeR = 0, hypeB = 0, zoom = 0, orbit = 0, jumboFlash = null, jumboFlashT = 0;
  const fx = {
    swing(slot, ticks) { const P = players[slot]; if (P) P.startSwing(ticks / 60); },
    kick(slot, x, y, perfect, power, dx = 0, dy = 0, lob = false) {
      const P = players[slot]; if (P) { P.kickT = 1; P.swingT = 0; }
      const X = wx(x), Z = wz(y);
      ballSquash = Math.min(1, 0.35 + power * 0.6);
      parts.burst(X, 0.05, Z, 8 + power * 10, { colors: [0x3d8b3f, 0x5aa04f, 0x2d6e30, 0x7a5a36], speed: 2.4 + power, up: 2.5 + power * 1.5, size: 0.07, life: 0.7 });
      if (power > 0.6) { wave(X, Z, 0.05, perfect ? 0xffd34d : 0xffffff, 0.8 + power * 0.9, 0.28); camKick.x += dx * power * 0.28; camKick.z += dy * power * 0.28; }
      if (perfect) {
        parts.burst(X, 0.25, Z, 38, { colors: [0xffd34d, 0xfff1b0, 0xffa31a], speed: 6.5, up: 4, size: 0.12, life: 0.8, grav: 4 });
        wave(X, Z, 0.25, 0xffe28a, 2.6, 0.4); fovPunch = 1; shake = Math.max(shake, 0.12); ballHot = 1;
      }
    },
    touch(x, y, f) { if (f > 4) parts.burst(wx(x), 0.03, wz(y), 3, { colors: [0x4f9a45, 0x3d8b3f], speed: 1, up: 1.2, size: 0.05, life: 0.35 }); },
    trap(x, y) { parts.burst(wx(x), 0.05, wz(y), 6, { colors: [0x4f9a45, 0xd7e6c8], speed: 1.4, up: 1.5, size: 0.06, life: 0.4 }); ballSquash = 0.4; },
    skid(x, y) { parts.burst(wx(x), 0.04, wz(y), 14, { colors: [0x6e5a3c, 0x8a7350, 0x4f9a45], speed: 1.8, up: 1.4, size: 0.09, life: 0.6, grav: 4, drag: 3 }); },
    bounce(x, y, f) { parts.burst(wx(x), 0.04, wz(y), 4 + f, { colors: [0x6e5a3c, 0x4f9a45], speed: 1.2, up: 1.2, size: 0.07, life: 0.45 }); ballSquash = Math.min(1, f * 0.12); },
    bump(x, y, f) { shake = Math.max(shake, Math.min(0.12, f * 0.02)); },
    bar(x, y, z) {
      const g = goals[x > C.CX ? 1 : 0]; g.shakeT = 0.6;
      parts.burst(wx(x), GOAL_H, wz(y), 26, { colors: [0xffffff, 0xdfe6f2, 0xffd34d], speed: 4, up: 3, size: 0.08, life: 0.6 });
      shake = Math.max(shake, 0.2); hype = Math.max(hype, 0.9);
    },
    dash(slot, x, y) { parts.burst(wx(x), 0.05, wz(y), 12, { colors: [0x9bbf8a, 0xd7e6c8], speed: 1.6, up: 1.2, size: 0.1, life: 0.5, grav: 3 }); },
    tackle(x, y) { parts.burst(wx(x), 0.6, wz(y), 22, { colors: [0xff9f43, 0xffffff, 0xffd34d], speed: 4, up: 3, size: 0.1, life: 0.6 }); shake = Math.max(shake, 0.25); },
    post(x, y) { goals[x > C.CX ? 1 : 0].shakeT = 0.5; parts.burst(wx(x), 0.6, wz(y), 20, { colors: [0xffffff, 0xdddddd], speed: 4, up: 3, size: 0.08, life: 0.5 }); shake = Math.max(shake, 0.2); hype = Math.max(hype, 0.8); },
    wall(x, y, sp) { if (sp > 12) shake = Math.max(shake, 0.06); },
    goal(scorer, x, y) {
      const goal = goals[x > C.CX ? 1 : 0];
      goal.hit(wz(y), 1);
      const X = wx(x), Z = wz(y), col = KITS[scorer];
      parts.burst(X, 0.6, Z, 90, { colors: [col.shirt, 0xffffff, col.light, 0xffd34d], speed: 5, up: 8, size: 0.13, life: 2.2, grav: 3.5, drag: 1.2, sway: 0.6 });
      shake = 0.35; zoom = 1; camKick.x += (x > C.CX ? 1 : -1) * 0.5;
      if (scorer === 0) hypeR = 1.4; else hypeB = 1.4;
      hype = 1;
      jumboFlash = { text: 'GOAL!', color: col.css }; jumboFlashT = 3;
      for (const f of flashes) { placeFlash(f); f.t = rand(0, 0.8); }
    },
    win(slot) {
      const col = KITS[slot];
      for (let i = 0; i < 160; i++) parts.emit(rand(-HW, HW), rand(5, 9), rand(-HH, HH), rand(-1, 1), 0, rand(-1, 1), [col.shirt, 0xffffff, 0xffd34d, col.light][i % 4], 0.13, rand(3, 5), 1.2, 0.8, 1);
      if (slot === 0) hypeR = 1.3; else hypeB = 1.3;
    },
    shake(a) { shake = Math.max(shake, a); },
  };

  const _proj = new THREE.Vector3();
  function project(x, y, h = 0) {
    _proj.set(wx(x), h, wz(y)).project(camera);
    return { x: (_proj.x + 1) / 2 * cssW, y: (1 - _proj.y) / 2 * cssH, ok: _proj.z < 1 };
  }
  // screen point (CSS px in the canvas) -> point on the pitch in sim units
  function pickGround(px, py) {
    _ray.setFromCamera(_ndc.set(px / cssW * 2 - 1, -(py / cssH) * 2 + 1), camera);
    if (!_ray.ray.intersectPlane(_ground, _hit)) return null;
    return { x: _hit.x / S + C.CX, y: _hit.z / S + C.CY };
  }

  // compile every shader now so nothing stalls the first time it appears mid-game
  try { renderer.compile(scene, camera); } catch { }

  let lastT = null;
  function frame(view, nowMs) {
    const now = (nowMs !== undefined ? nowMs : performance.now()) / 1000;
    const rawDt = lastT === null ? 1 / 60 : Math.min(0.05, Math.max(0, now - lastT)); lastT = now;
    const dt = rawDt * (view.timeScale !== undefined ? view.timeScale : 1); // slow motion slows the world, not the UI
    const t = now;
    crowdU.uTime.value = t;
    const live = !!view.live;

    // auto quality: measure continuously, but only switch while play is paused
    if (quality === 'auto') {
      ftAvg = ftAvg * 0.97 + rawDt * 1000 * 0.03;
      if (++ftFrames > 240 && ftAvg > 22 && level > 0 && pendingLevel === null) pendingLevel = level - 1;
      if (pendingLevel !== null && !live) { level = pendingLevel; pendingLevel = null; ftFrames = 0; ftAvg = 16; resize(cssW, cssH); }
    }

    // entities
    const W = view.world;
    if (W && W.players) {
      W.players.forEach((p, i) => {
        const P = players[i];
        if (view.hide && view.hide[i]) { P.hide(); return; }
        P.setIdentity((view.names && view.names[i]) || '');
        P.update(p, dt, t, {
          ct: i === view.mySlot && view.localCt !== undefined ? view.localCt : p[4],
          mine: i === view.mySlot, live, ball: W.ball ? [wx(W.ball[0]), wz(W.ball[1])] : null,
          celebrate: view.celebrate === i, sad: view.celebrate === 1 - i,
        });
      });
    } else players.forEach(P => P.hide());

    // aim arrow for my player while charging
    const me = W && W.players && view.mySlot >= 0 ? W.players[view.mySlot] : null;
    const ct = view.localCt;
    aimArrow.visible = !!(me && live && ct !== undefined && ct >= 0 && view.aim);
    if (aimArrow.visible) {
      const perfect = ct >= C.CHARGE_FULL && ct <= C.PERF_END;
      aimArrow.position.set(wx(me[0]), 0.025, wz(me[1]));
      aimArrow.rotation.y = Math.atan2(-view.aim[1], view.aim[0]);
      const k = 0.75 + 0.45 * Math.min(ct / C.CHARGE_FULL, 1);
      aimArrow.scale.set(k, 1, 1);
      aimMat.color.setHex(perfect ? 0xffd34d : ct > C.PERF_END ? 0x8a90a0 : view.localLob ? 0x7fdcff : 0xffffff);
    }
    cursor.visible = !!(view.cursor && live);
    if (cursor.visible) { cursor.position.set(wx(view.cursor[0]), 0, wz(view.cursor[1])); const s2 = 1 + Math.sin(t * 6) * 0.08; cursor.scale.set(s2, 1, s2); }

    if (W && W.ball) {
      const bx = wx(W.ball[0]), bz = wz(W.ball[1]), bh = (W.ball[3] || 0) * S;
      ball.visible = true;
      if (lastBall && Math.hypot(bx - lastBall.x, bz - lastBall.z) < 2) {
        const dx = bx - lastBall.x, dz = bz - lastBall.z, dist = Math.hypot(dx, dz);
        if (dist > 1e-5) { v3.set(dz, 0, -dx).normalize(); ball.quaternion.premultiply(tmpQ.setFromAxisAngle(v3, dist / BALL_R * (bh > 0.05 ? 0.5 : 1))); }
        if (W.ball[2]) ballHot = 1;
      } else trailPts.length = 0;
      if (!lastBall) lastBall = { x: bx, z: bz }; else { lastBall.x = bx; lastBall.z = bz; }
      ball.position.set(bx, BALL_R + bh, bz);
      ballSquash = Math.max(0, ballSquash - dt * 7);
      const q = ballSquash * ballSquash; ball.scale.set(1 + 0.3 * q, 1 - 0.3 * q, 1 + 0.3 * q);
      // the shadow stays on the grass and spreads/fades as the ball rises: this is what sells height
      ballBlob.position.set(bx, 0.013, bz); ballBlob.visible = true;
      const hs = 1 + bh * 0.9; ballBlob.scale.set(hs, 1, hs); ballBlob.material.opacity = 0.38 / (1 + bh * 1.6);
      if (!W.ball[2]) ballHot = Math.max(0, ballHot - dt * 3);
      ballMat.emissiveIntensity = ballHot * (1.4 + Math.sin(t * 30) * 0.3);
      ballLight.position.set(bx, 0.6 + bh, bz); ballLight.intensity = ballHot * 6;
      // trail
      if (!trailPts.length || Math.hypot(bx - trailPts[0].x, bz - trailPts[0].z) > 0.04) {
        const pt = trailPts.length >= TRAIL ? trailPts.pop() : {}; pt.x = bx; pt.z = bz; pt.h = bh; trailPts.unshift(pt);
      }
      const speedish = trailPts.length > 3 ? Math.hypot(trailPts[0].x - trailPts[3].x, trailPts[0].z - trailPts[3].z) : 0;
      trailMat.uniforms.color.value.setHex(ballHot > 0.1 ? 0xffc02e : 0xffffff);
      const n = trailPts.length;
      for (let i = 0; i < TRAIL; i++) {
        const a = trailPts[Math.min(i, n - 1)], b = trailPts[Math.min(i + 1, n - 1)];
        let nx = -(b.z - a.z), nz = b.x - a.x; const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
        const f = 1 - i / TRAIL, wdt = BALL_R * 0.8 * f, o = i * 6;
        const th = BALL_R + (a.h || 0);
        trailPos[o] = a.x + nx * wdt; trailPos[o + 1] = th; trailPos[o + 2] = a.z + nz * wdt;
        trailPos[o + 3] = a.x - nx * wdt; trailPos[o + 4] = th; trailPos[o + 5] = a.z - nz * wdt;
        trailA[i * 2] = trailA[i * 2 + 1] = i < n ? f * clamp(speedish * 2.2 - 0.2, 0, 1) * (ballHot > 0.1 ? 0.9 : 0.35) : 0;
      }
      trailGeo.attributes.position.needsUpdate = true; trailGeo.attributes.aA.needsUpdate = true;
      trail.visible = !view.noTrail;
      const near = Math.max(0, 1 - (HW - Math.abs(bx)) / 5) * (Math.abs(bz) < 4 ? 1 : 0.4);
      hype = Math.max(hype * Math.exp(-dt * 0.8), near * 0.45);
    } else { ball.visible = false; ballBlob.visible = false; trail.visible = false; ballLight.intensity = 0; }

    hypeR *= Math.exp(-dt * 0.45); hypeB *= Math.exp(-dt * 0.45);
    crowdU.uHype.value = hype * 0.6; crowdU.uHypeR.value = hypeR; crowdU.uHypeB.value = hypeB;
    view.hype = hype;

    goals.forEach(g => g.update(dt));
    for (const w of waves) {
      if (!w.m.visible) continue;
      w.t += dt; const u = w.t / w.dur;
      if (u >= 1) { w.m.visible = false; continue; }
      const s3 = 0.2 + (w.max - 0.2) * (1 - (1 - u) * (1 - u)); w.m.scale.set(s3, 1, s3); w.m.material.opacity = (1 - u) * 0.8;
    }
    parts.update(dt, t);
    for (const tx of boardTexs) tx.offset.x = (tx.offset.x + dt * 0.035) % 1;
    for (const f of flashes) {
      f.t -= dt;
      if (f.t <= 0) { if (Math.random() < dt * (hype > 0.6 ? 6 : 0.25)) { placeFlash(f); f.t = 0.12; } f.s.material.opacity = 0; }
      else f.s.material.opacity = Math.min(1, f.t * 10);
    }
    for (let i = 0; i < lamps.length; i++) lamps[i].material.opacity = 0.8 + Math.sin(t * 1.3 + i) * 0.05;

    // jumbotron (redraws only when its content changes)
    if (jumboFlashT > 0) { jumboFlashT -= dt; drawJumbo(null, (t * 4 | 0) % 2 ? jumboFlash : { text: jumboFlash.text, color: '#050b18' }); }
    else drawJumbo(view.scoreboard || null);

    // camera
    let k = 3.5;
    const bx = W && W.ball ? wx(W.ball[0]) : 0, bz = W && W.ball ? wz(W.ball[1]) : 0;
    zoom = Math.max(0, zoom - dt * 0.45);
    tgt.set(0, 0, fitZ);
    if (view.mode === 'showcase') {
      orbit += dt * 0.06;
      tgt.set(bx * 0.3, 0, bz * 0.3);
      const d = fitD * 1.35, e = THREE.MathUtils.degToRad(28);
      pos.set(Math.sin(orbit) * Math.cos(e) * d, Math.sin(e) * d + 2, Math.cos(orbit) * Math.cos(e) * d).add(tgt);
      k = 2;
    } else if (view.mode === 'replay') {
      tgt.set(bx, 0.3, bz);
      pos.set(bx * 0.8, 5.2, bz + 8.6);
      k = 3;
    } else if (view.mode === 'intro') {
      const a = (1 - clamp(view.introT, 0, 1)) ** 2;
      introDir.set(Math.sin(a * 1.2) * Math.cos(EL), Math.sin(EL) * (1 + a * 0.3), Math.cos(a * 1.2) * Math.cos(EL));
      pos.copy(tgt).addScaledVector(introDir, fitD * (1 + a * 0.35));
      k = 5;
    } else if (view.mode === 'celebrate' && W && W.players && view.celebrate >= 0) {
      const p = W.players[view.celebrate];
      tgt.set(wx(p[0]), 0.7, wz(p[1]));
      pos.copy(tgt); pos.y += 5.5; pos.z += 7.5;
      k = 2.2;
    } else {
      // broadcast view: keep the ball AND every player in frame. Pan with the ball while everything
      // fits in the close framing; pull back smoothly (up to the full pitch) when players spread out.
      // points that must stay on screen: the ball, and each player's feet and name-tag top
      let n = 0;
      framePts[n++].set(bx, BALL_R, bz);
      if (W && W.players) W.players.forEach((p, i) => {
        if (view.hide && view.hide[i]) return;
        const x = wx(p[0]), z = wz(p[1]);
        framePts[n++].set(x + (x < bx ? -0.45 : 0.45), 0, z + 0.35);
        framePts[n++].set(x, 2.45, z);
      });
      const pts = framePts.slice(0, n);
      // 1) centre on everything that must be visible and pull back until it all fits
      let minX = Infinity, maxX = -Infinity;
      for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); }
      const panLimit = dist => Math.max(0, HW + GDP + 0.35 - visHalf * dist / fitD);
      const pc = (minX + maxX) / 2;
      let d = fitD;
      for (let it = 0; it < 6; it++) {
        const m = framing(pts, clamp(pc, -panLimit(d), panLimit(d)), d);
        if (m <= 1.0001 || d >= fitDFull) break;
        d = Math.min(fitDFull, d * m * 1.01);
      }
      // 2) with that distance, lean toward the ball as far as possible without losing anyone
      const mp = panLimit(d), from = clamp(pc, -mp, mp), to = clamp(bx, -mp, mp);
      let px = from;
      if (framing(pts, to, d) <= 1.0001) px = to;
      else { let lo = from, hi = to; for (let i = 0; i < 7; i++) { const mid = (lo + hi) / 2; if (framing(pts, mid, d) <= 1.0001) lo = mid; else hi = mid; } px = lo; }
      camDist = damp(camDist, d, d > camDist ? 3.5 : 1.2, dt); // widen quickly, tighten gently
      tgt.set(px, 0, fitZ + clamp(bz * 0.06, -0.3, 0.3));
      pos.copy(tgt).addScaledVector(camDir, camDist * (1 - zoom * 0.06));
      k = 2.6;
    }
    camPos.x = damp(camPos.x, pos.x, k, dt); camPos.y = damp(camPos.y, pos.y, k, dt); camPos.z = damp(camPos.z, pos.z, k, dt);
    camTgt.x = damp(camTgt.x, tgt.x, k, dt); camTgt.y = damp(camTgt.y, tgt.y, k, dt); camTgt.z = damp(camTgt.z, tgt.z, k, dt);
    shake *= Math.exp(-dt * 7);
    // impacts push the camera along the shot line (a directional kick, not random wobble)
    camKick.multiplyScalar(Math.exp(-rawDt * 7));
    fovPunch = Math.max(0, fovPunch - rawDt * 2.2);
    const fov = 32 - fovPunch * fovPunch * 2.2;
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
    camera.position.set(camPos.x + camKick.x + (Math.random() - 0.5) * shake, camPos.y + (Math.random() - 0.5) * shake, camPos.z + camKick.z + (Math.random() - 0.5) * shake);
    v3.copy(camTgt).addScaledVector(camKick, 0.6);
    camera.lookAt(v3);

    if (level >= 2) composer.render(); else renderer.render(scene, camera);
  }

  function snapCamera() { camPos.set(0, 0, fitZ).addScaledVector(camDir, fitD); camTgt.set(0, 0, fitZ); }

  return {
    frame, resize, project, pickGround, fx, setQuality, snapCamera,
    get quality() { return quality; }, get level() { return level; },
    debugCam: () => ({ fitD, fitDFull, camDist, visHalf, fitZ, cssW, cssH, aspect: camera.aspect, cam: camera.position.toArray().map(v => +v.toFixed(2)), tgt: camTgt.toArray().map(v => +v.toFixed(2)) }),
  };
}