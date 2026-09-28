// Office Ball — 3D stadium renderer (three.js). Pure presentation: it draws whatever
// state it is given; the authoritative game lives on the server.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createLighting } from './lighting.js';
import { KITS } from './kits.js';
import { buildStadium } from './stadium.js';
import { Human, Pose, HAIR_KEYS, MODEL_HEIGHT, loadPlayerAssets, boneIndex } from './human.js';
import { probeSRGB, applySRGBMode } from './texcompat.js';
import { mergeStatic, bakeUV } from './merge.js';

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
const smoothstep = (x, a, b) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));

export { KITS };
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
    // the mowing bands are mostly a lighting effect (see the pitch material); only a little is baked
    for (let i = -3; i < 16; i++) { g.fillStyle = ((i % 2) + 2) % 2 ? '#357a3a' : '#317236'; g.fillRect(X(-HW + i * bw), 0, bw * ppu + 1, ch); }
    const img = g.getImageData(0, 0, cw, ch), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 22; d[i] += n * 0.55; d[i + 1] += n; d[i + 2] += n * 0.45; }
    g.putImageData(img, 0, 0);
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * cw, y = Math.random() * ch, r = rand(50, 240), light = Math.random() < 0.5;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, light ? 'rgba(170,230,120,0.07)' : 'rgba(5,35,8,0.09)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    // wear: the goalmouths and the centre spot are played on hardest; thinner, drier, paler turf
    const wear = (x, z, rx, rz, a) => {
      g.save(); g.translate(X(x), Y(z)); g.scale(rx * ppu, rz * ppu);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      gr.addColorStop(0, `rgba(150,140,82,${a})`); gr.addColorStop(0.55, `rgba(120,130,70,${a * 0.5})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 1, 0, Math.PI * 2); g.fill(); g.restore();
      for (let i = 0; i < 260; i++) { // scuffs and divots
        const r = Math.sqrt(Math.random()), t = Math.random() * Math.PI * 2;
        g.fillStyle = `rgba(${95 + Math.random() * 40},${85 + Math.random() * 30},${50 + Math.random() * 20},${0.12 + Math.random() * 0.2})`;
        g.fillRect(X(x + Math.cos(t) * r * rx), Y(z + Math.sin(t) * r * rz), 1 + Math.random() * 3, 1 + Math.random() * 3);
      }
    };
    for (const sg of [-1, 1]) { wear(sg * (HW - 0.55), 0, 0.9, 1.9, 0.22); wear(sg * (HW - 1.6), 0, 0.45, 0.45, 0.14); }
    wear(0, 0, 0.55, 0.55, 0.12);
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

// grass micro-relief: a dense field of short blade strokes, turned into a tangent-space normal map
function grassNormalTexture() {
  const N = 256, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, N, N);
  for (let i = 0; i < 5200; i++) {
    const x = Math.random() * N, y = Math.random() * N, a = -Math.PI / 2 + (Math.random() - 0.5) * 1.2, l = 2 + Math.random() * 5, v = 110 + Math.random() * 145;
    g.strokeStyle = `rgb(${v},${v},${v})`; g.lineWidth = 0.6 + Math.random() * 0.8;
    for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) { g.beginPath(); g.moveTo(x + ox, y + oy); g.lineTo(x + ox + Math.cos(a) * l, y + oy + Math.sin(a) * l); g.stroke(); }
  }
  const src = g.getImageData(0, 0, N, N).data, out = g.createImageData(N, N), H = (x, y) => src[(((y + N) % N) * N + ((x + N) % N)) * 4] / 255;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * 2.2, dy = (H(x, y + 1) - H(x, y - 1)) * 2.2, l = Math.hypot(dx, dy, 1), k = (y * N + x) * 4;
    out.data[k] = (-dx / l * 0.5 + 0.5) * 255; out.data[k + 1] = (dy / l * 0.5 + 0.5) * 255; out.data[k + 2] = (1 / l * 0.5 + 0.5) * 255; out.data[k + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace;
  return t;
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


// ---------------------------------------------------------------- shaders

const partVert = `attribute float aSize; attribute float aAlpha; attribute vec3 aColor; uniform float uScale;
varying float vAlpha; varying vec3 vColor;
void main(){ vAlpha = aAlpha; vColor = aColor; vec4 mv = modelViewMatrix * vec4(position,1.0);
  gl_PointSize = aSize * uScale / -mv.z; gl_Position = projectionMatrix * mv; }`;
const partFrag = `varying float vAlpha; varying vec3 vColor; uniform float uGain;
void main(){ if (vAlpha < 0.01) discard; vec2 c = gl_PointCoord - 0.5; float d = length(c); if (d > 0.5) discard;
  gl_FragColor = vec4(vColor * uGain, smoothstep(0.5, 0.25, d) * vAlpha);
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
    this.mat = new THREE.ShaderMaterial({ uniforms: { uScale: { value: 800 }, uGain: { value: 1 } }, vertexShader: partVert, fragmentShader: partFrag, transparent: true, depthWrite: false });
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
    plate: new THREE.PlaneGeometry(2 * PLATE_R, 2 * PLATE_R).rotateX(-Math.PI / 2),
  };
  return PG;
}

// ---------------------------------------------------------------- player HUD decals
// One ground decal per player, drawn analytically in a shader so every edge is anti-aliased at any
// zoom: a thin team ring with a facing notch, the kick charge meter (with the PERFECT window marked in
// gold on its track) and the dash cooldown. Distances are in world units.
const PLATE_R = 1.0, RING_R = 0.46, CHARGE_R = 0.6, COOL_R = 0.39, REACH_R = C.REACH * S;
const decalVert = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const plateFrag = `
uniform vec3 uTeam; uniform float uMine, uCharge, uPerf, uCool, uTime, uR, uLive;
varying vec2 vUv;
float band(float d, float w){ float aa = fwidth(d) * 1.2; return 1.0 - smoothstep(w * 0.5 - aa, w * 0.5 + aa, abs(d)); }
void main(){
  vec2 p = (vUv - 0.5) * 2.0 * uR;
  float r = length(p);
  float a = fract(atan(p.x, -p.y) / 6.2831853 + 1.0);          // 0 at the facing direction, clockwise
  float ad = min(a, 1.0 - a);                                     // angular distance from the front (0..0.5)
  vec4 acc = vec4(0.0);
  #define ADD(c, al) { float _a = clamp(al, 0.0, 1.0); acc.rgb = acc.rgb * (1.0 - _a) + (c) * _a; acc.a = acc.a + _a * (1.0 - acc.a); }
  // soft contact shade + team ring
  ADD(vec3(0.0), (1.0 - smoothstep(0.0, ${RING_R.toFixed(3)}, r)) * 0.18);
  float ringA = band(r - ${RING_R.toFixed(3)}, mix(0.026, 0.042, uMine)) * mix(0.6, 1.0, uMine);
  ADD(uTeam, ringA);
  // facing notch: a small solid chevron just outside the ring
  float nr = r - ${(RING_R + 0.05).toFixed(3)};
  float notch = step(abs(nr), 0.045) * (1.0 - smoothstep(0.0, 0.004 + fwidth(ad), ad * 6.2831853 * r - (0.045 - nr) * 0.9));
  ADD(uTeam, notch * mix(0.5, 0.95, uMine));
  if (uLive > 0.5 && uCharge >= 0.0) {
    // kick reach, dashed
    float dash = step(0.5, fract(a * 48.0));
    ADD(vec3(1.0), band(r - ${REACH_R.toFixed(3)}, 0.012) * dash * 0.28);
    // charge track, gold PERFECT window, fill
    float trk = band(r - ${CHARGE_R.toFixed(3)}, 0.065);
    ADD(vec3(1.0), trk * 0.16);
    float inPerfZone = step(uPerf, a);
    ADD(vec3(1.0, 0.83, 0.3), trk * inPerfZone * 0.45);
    float over = step(1.0, uCharge), fill = min(uCharge, 1.0);
    float perfect = step(uPerf, uCharge) * (1.0 - over);
    vec3 fc = over > 0.5 ? vec3(0.45, 0.47, 0.53) : perfect > 0.5 ? vec3(1.0, 0.86, 0.35) : vec3(1.0);
    float fillA = trk * step(a, fill) * (0.95 - 0.1 * over);
    ADD(fc, fillA);
    // leading edge tick + glow while in the window
    ADD(fc, band(r - ${CHARGE_R.toFixed(3)}, 0.09) * (1.0 - smoothstep(0.0, 0.012, abs(a - fill))) * (1.0 - over));
    ADD(vec3(1.0, 0.85, 0.4), perfect * (1.0 - smoothstep(0.0, 0.09, abs(r - ${CHARGE_R.toFixed(3)}))) * (0.25 + 0.15 * sin(uTime * 22.0)));
  }
  if (uLive > 0.5 && uCool > 0.0) {
    // dash recharging: a thin arc that closes as the dash comes back
    ADD(vec3(1.0), band(r - ${COOL_R.toFixed(3)}, 0.014) * step(a, 1.0 - uCool) * 0.5);
  }
  if (acc.a < 0.003) discard;
  gl_FragColor = vec4(acc.rgb, acc.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
function plateMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { uTeam: { value: new THREE.Color(color) }, uMine: { value: 0 }, uCharge: { value: -1 }, uPerf: { value: C.CHARGE_FULL / C.PERF_END }, uCool: { value: 0 }, uTime: { value: 0 }, uR: { value: PLATE_R }, uLive: { value: 0 } },
    vertexShader: decalVert, fragmentShader: plateFrag, transparent: true, depthWrite: false, toneMapped: false,
  });
}
// aim beam: tapered strip with chevrons flowing outward; x along the beam (0 at the player), y across
const beamFrag = `
uniform vec3 uColor; uniform float uTime, uLen; varying vec2 vUv;
void main(){
  float x = vUv.x, y = abs(vUv.y - 0.5) * 2.0;
  float taper = 1.0 - x * 0.55;
  float edge = 1.0 - smoothstep(taper - 0.12 - fwidth(y), taper, y);
  float c = fract(x * uLen * 2.4 + y * 0.55 * taper - uTime * 2.2); // tips lead: > > >
  float chev = smoothstep(0.0, 0.1, c) * (1.0 - smoothstep(0.42, 0.55, c));
  float spine = 1.0 - smoothstep(0.0, 0.14 + fwidth(y), y);
  float fadeIn = smoothstep(0.0, 0.18, x), fadeOut = 1.0 - smoothstep(0.7, 1.0, x);
  float a = (chev * 0.9 + spine * 0.4) * edge * fadeIn * fadeOut;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
// target marker for mouse steering: thin ring and a dot, anti-aliased
const markFrag = `
uniform float uTime; varying vec2 vUv;
float band(float d, float w){ float aa = fwidth(d) * 1.2; return 1.0 - smoothstep(w * 0.5 - aa, w * 0.5 + aa, abs(d)); }
void main(){
  float r = length(vUv - 0.5) * 2.0;
  float ringR = 0.72 + 0.04 * sin(uTime * 5.0);
  float a = band(r - ringR, 0.07) * 0.75 + (1.0 - smoothstep(0.1, 0.1 + fwidth(r) * 1.5, r)) * 0.85;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vec3(1.0), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
// the "you" marker over your own player: a soft-edged chevron sprite
function chevronTexture(color) {
  return canvasTex(128, 128, g => {
    g.clearRect(0, 0, 128, 128);
    const path = () => { g.beginPath(); g.moveTo(24, 36); g.lineTo(64, 84); g.lineTo(104, 36); g.lineTo(88, 30); g.lineTo(64, 58); g.lineTo(40, 30); g.closePath(); };
    g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 10; g.shadowOffsetY = 3;
    g.fillStyle = color; path(); g.fill();
    g.shadowColor = 'transparent'; g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineJoin = 'round'; path(); g.stroke();
  });
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
const LEG_BONES = new Set(['thigh', 'shin', 'foot', 'toe'].flatMap(n => [boneIndex(n + 'L'), boneIndex(n + 'R')]));
const KICK_LEG = Object.fromEntries(['L', 'R'].map(k => [k, new Set(['thigh', 'shin', 'foot', 'toe'].map(n => boneIndex(n + k)))]));
// every number that carries animation state from frame to frame; reset if one ever goes non-finite
const STATE_KEYS = ['hipTurn', 'lead', 'speed', 'vx', 'vz', 'svx', 'svz', 'ax', 'az', 'roll', 'pitch', 'yaw', 'yawVel', 'phase', 'windup', 'kickT', 'swingT', 'dashW', 'celW', 'sadW', 'stunW', 'lookY', 'lookX', 'brace', 'cut', 'celebrate', 'cock', 'commit', 'commitYaw', 'shufW', 'shufPh', 'shufDir', 'touchT', 'recvT', 'headerT', 'shieldW'];
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
// standing: an athletic ready stance (feet under the hips, soft knees, arms loose) that breathes and
// shifts its weight, instead of the pack's lean-back idle. The model's rest pose has a strong
// anterior pelvic tilt (hollow lower back, seat pushed out), so the pelvis is tucked to neutral
// (TUCK) and the thighs take the tuck back, keeping the legs and feet where they were; the spine
// then stacks the chest straight over the hips rather than pitching it forward.
const TUCK = 0.13;
function readyPose(Q, t, seed) {
  Q.zero();
  const br = Math.sin(t * 1.7 + seed), sway = Math.sin(t * 0.55 + seed * 2);
  for (const [s, k] of SIDES) {
    const load = 1 + s * sway * 0.25;
    Q.set('thigh' + k, TUCK - 0.16 * load, s * 0.06, s * 0.05);
    Q.set('shin' + k, 0.3 * load);
    Q.set('foot' + k, -0.14 * load, -s * 0.06, -s * 0.05);
    Q.set('clav' + k, 0, 0, s * br * 0.015);
    Q.set('arm' + k, 0.05 + br * 0.02, s * 0.1, s * (0.16 + Math.sin(t * 1.1 + s + seed) * 0.02));
    Q.set('fore' + k, -0.42 - br * 0.03, 0, 0);
    Q.set('hand' + k, 0.1, 0, s * 0.12);
  }
  Q.set('hips', -TUCK, 0, sway * 0.04);
  Q.set('spine', 0.09, 0, -sway * 0.025);
  Q.set('chest', 0.04 + br * 0.012);
  Q.set('neck', -0.01);
  Q.set('head', -0.01);
}
// side-shuffle (jockeying, feinting): a low athletic stance, chest up and over the knees, stepping
// sideways along the body's left/right axis. dir in [-1, 1] is the direction of travel (+1 = to the
// body's left); the lead leg steps out on the first half of each cycle and the trail leg closes on the
// second, and the pelvis shifts its weight over whichever foot is planted. amp 0 = just the stance.
function shufflePose(Q, ph, amp, dir, t, seed) {
  Q.zero();
  const br = Math.sin(t * 1.9 + seed), step = Math.sin(ph), open = Math.max(0, step), close = Math.max(0, -step);
  const hips = -TUCK + 0.12;
  for (const [s, k] of SIDES) {
    const lead = 0.5 + 0.5 * dir * s, lift = amp * (lead * open + (1 - lead) * close);
    const thighW = -0.42 - 0.26 * lift, shin = 0.82 + 0.45 * lift;
    Q.set('thigh' + k, thighW - hips, s * 0.05, s * (0.08 + amp * (lead * 0.17 * open - (1 - lead) * 0.06 * close)));
    Q.set('shin' + k, shin);
    Q.set('foot' + k, -(thighW + shin) + 0.12 * lift, -s * 0.05, -s * 0.06);
    Q.set('toe' + k, -0.1 * lift);
    Q.set('clav' + k, 0, 0, s * br * 0.012);
    Q.set('arm' + k, -0.08, s * 0.08, s * (0.3 + 0.06 * amp));
    Q.set('fore' + k, -0.75);
    Q.set('hand' + k, 0.05, 0, s * 0.12);
  }
  const shift = amp * step * dir;
  Q.set('hips', hips, 0, -shift * 0.06);
  Q.set('spine', 0.13, 0, shift * 0.035);
  Q.set('chest', 0.05, 0, shift * 0.02);
  Q.set('neck', -0.08);
  Q.set('head', -0.06);
}
// kick leg K: windup (w, 0..1), swing progress (u, 0..1, or -1), follow-through (ft, 1 -> 0)
function kickPose(Q, K, w, u, ft) {
  const S = K === 'L' ? 'R' : 'L', sk = K === 'L' ? 1 : -1, ss = -sk;
  let th, kn, fo = 0.55, tw;
  if (u >= 0) {
    const e = u * u * (3 - 2 * u);
    th = 0.6 - 1.95 * e;
    kn = u < 0.55 ? 1.35 - 0.2 * u / 0.55 : 1.15 * Math.pow(1 - (u - 0.55) / 0.45, 1.6) + 0.08;
    tw = sk * (0.3 - 0.7 * e);
  } else if (ft > 0) { th = -1.35; kn = 0.12 + 0.3 * (1 - ft); tw = -sk * 0.4; }
  else { th = 0.6; kn = 1.35; tw = sk * 0.25; }
  Q.set('thigh' + K, th, 0, sk * 0.06); Q.set('shin' + K, kn); Q.set('foot' + K, fo); Q.set('toe' + K, 0.1);
  Q.set('thigh' + S, -0.28, 0, ss * 0.06); Q.set('shin' + S, 0.45); Q.set('foot' + S, -0.12); Q.set('toe' + S, 0);
  Q.set('hips', 0.06, tw * 0.7, 0); Q.set('spine', -0.06, tw * 0.15); Q.set('chest', -0.06, tw * 0.3);
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

// a touch: a quick stab of the striking foot at the ball; a knock-on or dash poke is a longer lunge
function tapPose(Q, K, kind) {
  const S = K === 'L' ? 'R' : 'L', sk = K === 'L' ? 1 : -1;
  Q.zero();
  if (kind === 'knock' || kind === 'poke') {
    Q.set('thigh' + K, -0.95, 0, sk * 0.06); Q.set('shin' + K, 1.0); Q.set('foot' + K, 0.35); Q.set('toe' + K, -0.2);
    Q.set('thigh' + S, 0.22, 0, -sk * 0.04); Q.set('shin' + S, 0.3);
    Q.set('spine', 0.16); Q.set('chest', 0.08); Q.set('neck', -0.1);
    Q.set('arm' + S, -0.3, 0, sk * 0.6); Q.set('fore' + S, -0.5);
    Q.set('arm' + K, 0.2, 0, sk * 0.35);
  } else {
    Q.set('thigh' + K, -0.5, 0, sk * 0.05); Q.set('shin' + K, 0.85); Q.set('foot' + K, -0.05); Q.set('toe' + K, 0.15);
    Q.set('spine', 0.06);
  }
}
// receiving: a foot cushion, a chest that absorbs, or the head
function receivePose(Q, part) {
  Q.zero();
  if (part === 'chest') {
    for (const [s, k] of SIDES) { Q.set('arm' + k, -0.3, 0, s * 0.85); Q.set('fore' + k, -1.0); Q.set('thigh' + k, -0.06, 0, s * 0.05); Q.set('shin' + k, 0.2); }
    Q.set('spine', -0.12); Q.set('chest', -0.05); Q.set('neck', 0.12); Q.set('head', 0.08);
  } else if (part === 'head') {
    for (const [s, k] of SIDES) { Q.set('arm' + k, -0.15, 0, s * 0.45); Q.set('fore' + k, -0.5); }
    Q.set('spine', -0.06); Q.set('neck', 0.3); Q.set('head', 0.22);
  } else {
    for (const [s, k] of SIDES) { Q.set('thigh' + k, -0.16, 0, s * 0.04); Q.set('shin' + k, 0.3); Q.set('foot' + k, -0.08); }
    Q.set('spine', 0.08); Q.set('chest', 0.04); Q.set('neck', 0.04);
  }
}
// header: up off the ground, chest open, head through the ball
function headerPose(Q, w) {
  Q.zero();
  for (const [s, k] of SIDES) {
    Q.set('arm' + k, -0.5, 0, s * 0.85); Q.set('fore' + k, -0.55); Q.set('clav' + k, 0, 0, s * 0.12);
    Q.set('thigh' + k, -0.24); Q.set('shin' + k, 0.5); Q.set('foot' + k, -0.2);
  }
  Q.set('spine', -0.2); Q.set('chest', -0.08); Q.set('neck', 0.5 * w); Q.set('head', 0.32 * w);
  Q.lift = 0.26 * w;
}
// shield: low, turned so the ball side is away from the challenge, arm barring it off
function shieldPose(Q, side) {
  Q.zero();
  const K = side > 0 ? 'R' : 'L', sk = side > 0 ? 1 : -1;
  for (const [s, k] of SIDES) {
    Q.set('thigh' + k, TUCK - 0.3, s * 0.06, s * 0.06); Q.set('shin' + k, 0.6); Q.set('foot' + k, -0.3);
    Q.set('arm' + k, -0.4, 0, s * 0.8); Q.set('fore' + k, -0.95);
  }
  Q.set('arm' + K, -0.2, 0, sk * 1.25); Q.set('fore' + K, -1.15);
  Q.set('hips', -TUCK + 0.1); Q.set('spine', 0.16, 0, sk * 0.05); Q.set('chest', 0.07, 0, sk * 0.04);
  Q.set('neck', -0.12); Q.set('head', -0.08);
}

// Lite tier (software rendering, no shadow maps): each player stands in a baked picture of what
// the floodlight banks would throw: a soft shadow away from each bank (two from the main-stand roof
// toward the cameras, two from the TV gantry away from them), each as long as that bank's height
// and distance make it, for a player standing mid-pitch
const BANKS = [[-5.5, 10.7, -(HH + 3.7)], [5.5, 10.7, -(HH + 3.7)], [-6.5, 17, HH + 12], [6.5, 17, HH + 12]];
let TIER = 'high', fakeShadowTex = null;
function floodShadowTexture() {
  if (fakeShadowTex) return fakeShadowTex;
  const N = 256, M = 4.6; // texture spans M metres
  fakeShadowTex = canvasTex(N, N, g => {
    g.clearRect(0, 0, N, N); const ppm = N / M;
    for (const [bx, by, bz] of BANKS) {
      const len = Math.min(2.1, PLAYER_H * Math.hypot(bx, bz) / by);
      // canvas y runs along world +z (the plane is laid flat with its top edge toward -z)
      g.save(); g.translate(N / 2, N / 2); g.rotate(Math.atan2(-bz, -bx));
      const gr = g.createLinearGradient(0, 0, len * ppm, 0); gr.addColorStop(0, 'rgba(0,0,0,0.32)'); gr.addColorStop(0.75, 'rgba(0,0,0,0.12)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.filter = 'blur(3px)'; g.beginPath(); g.ellipse(len * ppm / 2, 0, len * ppm / 2, 0.16 * ppm, 0, 0, Math.PI * 2); g.fill(); g.restore();
    }
    const c = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, 0.35 * ppm); c.addColorStop(0, 'rgba(0,0,0,0.45)'); c.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = c; g.fillRect(0, 0, N, N);
  });
  fakeShadowTex.size = M;
  return fakeShadowTex;
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
    this.plate = new THREE.Mesh(G.plate, plateMaterial(kit.css)); this.plate.position.y = 0.015; this.plate.renderOrder = 2; this.root.add(this.plate);
    if (TIER === 'lite') {
      const t = floodShadowTexture();
      this.fakeShadow = new THREE.Mesh(new THREE.PlaneGeometry(t.size, t.size).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
      this.fakeShadow.position.y = 0.012; this.fakeShadow.renderOrder = 1; this.fakeShadow.visible = false; scene.add(this.fakeShadow);
    }
    this.arrow = new THREE.Sprite(new THREE.SpriteMaterial({ map: chevronTexture(kit.css), depthTest: false, transparent: true }));
    this.arrow.scale.setScalar(0.3); this.arrow.renderOrder = 6; this.root.add(this.arrow);
    Object.assign(this, {
      phase: 0, yaw: slot ? -Math.PI / 2 : Math.PI / 2, lastX: null, lastZ: null, speed: 0, kickT: 0, windup: 0, identity: null,
      celebrate: 0, swingT: 0, swingDur: 0.1, vx: 0, vz: 0, svx: 0, svz: 0, ax: 0, az: 0, roll: 0, pitch: 0,
      dashW: 0, celW: 0, sadW: 0, stunW: 0, lookY: 0, lookX: 0, yawVel: 0, brace: 0, cut: 0, cock: 0, commit: 0, commitYaw: 0, flipAxis: 0, flips: [], shufW: 0, shufPh: 0, shufDir: 1, feet: { l: 1, r: 1 }, celStyle: 'jump', sadStyle: 'head', wasCel: false, wasSad: false,
      touchT: 0, touchDur: 0.2, touchFoot: 'R', touchKind: 'step', recvT: 0, recvPart: 'foot', headerT: 0, shieldW: 0, kickFoot: null,
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
    if (!(dt >= 0 && dt < 1)) dt = 0;
    for (const k of STATE_KEYS) if (!Number.isFinite(this[k])) { this[k] = 0; this.lastX = null; }
    this.touchT = Math.max(0, this.touchT - dt);
    this.recvT = Math.max(0, this.recvT - dt);
    this.headerT = Math.max(0, this.headerT - dt);
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
    const x = wx(p[0]), z = wz(p[1]);
    if (this.lastX === null || Math.hypot(x - this.lastX, z - this.lastZ) > 1.5) { this.lastX = x; this.lastZ = z; this.vx = this.vz = this.svx = this.svz = 0; }
    const ivx = dt > 0 ? (x - this.lastX) / dt : 0, ivz = dt > 0 ? (z - this.lastZ) / dt : 0;
    this.vx = damp(this.vx, ivx, 14, dt); this.vz = damp(this.vz, ivz, 14, dt);
    // Acceleration is the slope of a second, slower low-pass of the velocity: for s' = K (v - s) that
    // slope is exact and as smooth as s itself. Differencing velocity frame to frame instead turns
    // every uneven frame or packet into a spike, and the whole-body lean below amplified those into
    // a shaking head.
    const AK = 6;
    this.svx = damp(this.svx, this.vx, AK, dt); this.svz = damp(this.svz, this.vz, AK, dt);
    this.ax = (this.vx - this.svx) * AK; this.az = (this.vz - this.svz) * AK;
    const sp = Math.hypot(this.vx, this.vz);
    this.speed = damp(this.speed, sp, 12, dt); this.lastX = x; this.lastZ = z;
    this.root.position.set(x, 0, z);
    if (this.fakeShadow) { this.fakeShadow.position.x = x; this.fakeShadow.position.z = z; this.fakeShadow.visible = true; }
    const stun = !!p[5], dash = !!p[6], ct = o.ct;
    // ---- heading. The sim's facing is the stick direction, so it flips 180 degrees on every
    // left/right reversal. A real player feinting side to side doesn't spin round each time: they
    // settle on one heading, square to the line they are shuffling along and facing the play, and
    // side-step. Reversals are counted over a short window; two or more commit the body to such a
    // heading (released smoothly once they stop). Winding up a shot always squares the body to it.
    const face = Math.atan2(p[2], p[3]), ang = a => Math.atan2(Math.sin(a), Math.cos(a));
    if (this.lastFace !== undefined && Math.abs(ang(face - this.lastFace)) > 1.9) { this.flips.push(t); this.flipAxis = face; }
    this.lastFace = face;
    while (this.flips.length && t - this.flips[0] > 0.9) this.flips.shift();
    const striking = ct >= 0 || this.swingT > 0 || this.kickT > 0.3 || dash;
    const spam = striking || stun ? 0 : smoothstep(this.flips.length, 1, 2.5);
    if (spam > 0.5 && this.commit < 0.05) {
      // pick the side of the shuffle line that faces the opponent, else the ball, else the camera
      const rx = o.other ? o.other[0] - x : o.ball ? o.ball[0] - x : 0, rz = o.other ? o.other[1] - z : o.ball ? o.ball[1] - z : 1;
      const perp = this.flipAxis + Math.PI / 2, s = Math.sin(perp) * rx + Math.cos(perp) * rz >= 0 ? 1 : -1;
      this.commitYaw = s > 0 ? perp : perp + Math.PI;
    }
    this.commit = damp(this.commit, spam, spam > this.commit ? 14 : striking ? 20 : 2.2, dt);
    const tgtYaw = this.commit > 0.001 ? face + ang(this.commitYaw - face) * this.commit : face;
    let dy = ang(tgtYaw - this.yaw);
    // ---- body weight, from acceleration in the body's own frame (the velocity's direction flips on
    // every reversal, and leaning against it rocked the body back and forth). Leaning into a turn at
    // pace (centripetal) is kept from the velocity frame; a shuffle only shifts its weight.
    const hx = sp > 0.3 ? this.vx / sp : 0, hz = sp > 0.3 ? this.vz / sp : 0;
    const bfx = Math.sin(this.yaw), bfz = Math.cos(this.yaw);
    const latV = hx * this.az - hz * this.ax, fwdV = hx * this.ax + hz * this.az;
    const latB = bfx * this.az - bfz * this.ax, fwdB = bfx * this.ax + bfz * this.az;
    const cm = this.commit, lat = latV + (latB - latV) * cm, fwd = fwdV + (fwdB - fwdV) * cm;
    const rMax = 0.38 - 0.28 * cm, pMax = 0.25 - 0.17 * cm;
    this.roll = damp(this.roll, clamp(lat * (0.035 - 0.02 * cm), -rMax, rMax), 10, dt);
    this.pitch = damp(this.pitch, clamp(fwd * (0.022 - 0.012 * cm), -pMax, pMax), 10, dt);
    // turn on a critically damped spring: the body swings round with momentum instead of snapping;
    // a committed shuffle only drifts its heading
    const om = stun ? 4 : 15 - 7 * cm;
    if (dt > 0) { this.yawVel = clamp(this.yawVel + (om * om * dy - 2 * om * this.yawVel) * dt, -16, 16); this.yaw += this.yawVel * dt; }
    this.root.rotation.y = this.yaw;
    const amp = clamp(this.speed / 4.5, 0, 1.25), A = Math.min(amp, 1.1);
    this.phase += dt * (6 + this.speed * 2.2) * (amp > 0.05 ? 1 : 0);
    this.kickT = Math.max(0, this.kickT - dt * 4.5);
    this.swingT = Math.max(0, this.swingT - dt);
    const charging = ct >= 0;
    this.windup = damp(this.windup, charging ? Math.min(ct / C.CHARGE_FULL, 1) : 0, 14, dt);

    // ---- animation: mocap locomotion underneath (in Human), procedural layers over it.
    // Each layer is a target pose plus a per-bone weight; later layers composite over earlier ones.
    if (this.swingT <= 0 && this.kickT <= 0) this.kickFoot = null;
    const P = this.P, Q = this.Q, W = this.W, AD = this.AD, L = this.look, K = this.kickFoot || L.foot, S2 = K === 'L' ? 'R' : 'L';
    P.zero(); W.fill(0); AD.zero();
    const layer = wOf => {
      for (let i = 0; i < W.length; i++) {
        const wl = wOf(i); if (wl <= 0.001) continue;
        const nw = W[i] + wl * (1 - W[i]), k = wl / nw;
        for (let c = i * 3; c < i * 3 + 3; c++) P.r[c] += (Q.r[c] - P.r[c]) * k;
        W[i] = nw;
      }
    };
    const idleW = 1 - smoothstep(this.speed, 0.3, 1.4);
    if (idleW > 0.001) { readyPose(Q, t, L.seed); layer(() => idleW); }
    // committed to a heading (see above): side-shuffle along the body's left/right axis, in time with
    // how fast the body is actually moving sideways
    {
      const vL = this.vx * Math.cos(this.yaw) - this.vz * Math.sin(this.yaw), aL = Math.abs(vL);
      const amp = smoothstep(aL, 0.1, 1.2);
      this.shufW = damp(this.shufW, this.commit * (1 - smoothstep(this.speed, 3, 4)), 9, dt);
      if (aL > 0.08) this.shufDir = damp(this.shufDir, Math.sign(vL), 10, dt);
      if (amp > 0.03) this.shufPh += dt * Math.PI * 2 * (1.5 + 1.3 * aL);
      if (this.shufW > 0.001) { shufflePose(Q, this.shufPh, amp, this.shufDir, t, L.seed); layer(() => this.shufW); }
    }
    const swinging = this.swingT > 0;
    const kw = Math.max(this.windup, swinging ? 1 : 0, this.kickT);
    // Charging on the move is a loaded run: the kicking leg is drawn back into the backswing and
    // held there, while the standing leg keeps running but shortens toward the plant (the skip step
    // a real player takes into a strike). The leg is never snapped backwards out of its forward
    // swing; once loaded it stays loaded.
    const moving = clamp((this.speed - 0.8) / 1.7, 0, 1);
    // picked up while behind the body or sweeping back under it (the push-off), never mid forward swing
    const lf = this.h.legFwd[K] || 0, behind = lf < 0.12 || lf < (this.lastLf ?? lf) - 0.004; this.lastLf = lf;
    const cockT = this.windup > 0.08 ? smoothstep(this.windup, 0.08, 0.5) : 0;
    if (cockT > this.cock) { if (behind || this.cock > 0.35 || moving < 0.2) this.cock = damp(this.cock, cockT, 16, dt); }
    else this.cock = damp(this.cock, cockT, 10, dt);
    if (kw > 0.001) {
      runPose(Q, this.phase, A, t, L.seed); kickPose(Q, K, this.windup, swinging ? 1 - this.swingT / this.swingDur : -1, this.kickT);
      const full = swinging || this.kickT > 0;
      const kickLeg = full ? kw : Math.max(this.windup * (1 - moving), this.cock * 0.92);
      const plantLeg = full ? kw : this.windup * (1 - moving) + this.windup * moving * 0.35;
      const bodyW = full ? kw : this.windup * (1 - 0.6 * moving);
      layer(i => (KICK_LEG[K].has(i) ? kickLeg : LEG_BONES.has(i) ? plantLeg : bodyW));
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
    // touches, receives, headers and the shield are read straight off the game events: the foot
    // that struck the ball is the foot the animation moves
    if (this.touchT > 0) {
      const w = Math.sin(Math.PI * (1 - this.touchT / this.touchDur));
      tapPose(Q, this.touchFoot, this.touchKind); layer(i => (KICK_LEG[this.touchFoot].has(i) ? w : 0));
    }
    if (this.recvT > 0) {
      const w = Math.sin(Math.PI * (1 - this.recvT / 0.34));
      receivePose(Q, this.recvPart); layer(() => w * 0.8);
    }
    if (this.headerT > 0) {
      const w = Math.sin(Math.PI * (1 - this.headerT / 0.45));
      headerPose(Q, w); layer(() => w); lift = Math.max(lift, Q.lift);
    }
    this.shieldW = damp(this.shieldW, p[11] ? 1 : 0, 10, dt);
    if (this.shieldW > 0.001) {
      const bs = o.ball ? Math.sign(p[2] * (o.ball[1] - z) - p[3] * (o.ball[0] - x)) : 0;
      shieldPose(Q, bs); layer(() => this.shieldW);
    }
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
    // Only the neck and head turn. A ball at the feet is watched by looking down, not by turning (its
    // bearing jumps about as it is dribbled), and a ball behind the player is let go rather than
    // whipping the head across when it passes directly behind.
    let lyT = 0, lxT = 0;
    if (o.ball) {
      const bx = o.ball[0] - x, bz = o.ball[1] - z, d = Math.hypot(bx, bz);
      let a = Math.atan2(bx, bz) - this.yaw; a = Math.atan2(Math.sin(a), Math.cos(a));
      if (Math.abs(a) < 1.5) lyT = clamp(a, -0.9, 0.9) * smoothstep(d, 0.9, 2.2);
      lxT = clamp(0.45 - d * 0.1, 0, 0.35);
    }
    this.lookY = damp(this.lookY, lyT * free, 4, dt); this.lookX = damp(this.lookX, lxT * free, 4, dt);
    AD.add('neck', this.lookX * 0.4, this.lookY * 0.4); AD.add('head', this.lookX * 0.6, this.lookY * 0.6);

    // weight: the chest leads a turn, hard braking sinks the hips, a sharp cut flares the arms and loads
    // the outside leg. These read as mass without touching the (server-side) physics.
    // A turn runs up the body: the eyes and head go first, the shoulders follow, the hips come last
    // (rather than the whole body turning as one rigid block)
    this.lead = damp(this.lead || 0, clamp(dy, -0.9, 0.9) * free, 10, dt);
    AD.add('hips', 0, -this.lead * 0.06); AD.add('chest', 0, this.lead * 0.16);
    AD.add('neck', 0, this.lead * 0.2); AD.add('head', 0, this.lead * 0.26);
    this.brace = damp(this.brace, clamp(-fwd / 14, 0, 1) * clamp(this.speed / 2, 0, 1) * free, 9, dt);
    this.cut = damp(this.cut, clamp(Math.abs(lat) / 13, 0, 1) * free, 9, dt);
    const load = Math.max(this.brace, this.cut * 0.7), side = lat > 0 ? 1 : -1;
    for (const [s, k] of SIDES) {
      const outside = s === side ? 1 : 0.5;
      AD.add('thigh' + k, -0.3 * load * outside, 0, s * 0.08 * this.cut);
      AD.add('shin' + k, 0.55 * load * outside);
      AD.add('foot' + k, -0.2 * load * outside);
      AD.add('arm' + k, -0.15 * this.brace, 0, s * (0.45 * this.cut * (1 - 0.7 * this.commit) + 0.25 * this.brace));
      AD.add('fore' + k, -0.25 * this.cut);
    }
    AD.add('spine', -0.12 * this.brace); AD.add('head', 0.06 * this.brace);
    // a little hop off the standing foot as the kick follows through
    if (this.kickT > 0) lift += 0.05 * Math.sin(Math.PI * (1 - this.kickT)) * this.kickT;

    // whole-body lean from the feet (the mocap already leans with speed)
    let lean = this.pitch + this.dashW * 0.12 + (swinging ? -0.05 : 0);
    let roll = this.roll;
    lean *= free; roll *= free;
    if (this.celStyle === 'plane') roll += Math.sin(this.celebrate * 2.2) * 0.28 * this.celW;
    roll += Math.sin(t * 9) * 0.22 * this.stunW;
    this.lean.rotation.set(clamp(lean, -0.4, 0.45), 0, clamp(roll, -0.5, 0.5));
    AD.add('neck', -lean * 0.5);
    let fast = null;
    if (swinging || this.kickT > 0.5 || this.dashW > 0.5) { fast = this.fast || (this.fast = new Float32Array(W.length)); fast.fill(1); for (const n of ['thigh', 'shin', 'foot', 'toe']) for (const k of ['L', 'R']) fast[boneIndex(n + k)] = 2.5; }
    // moving across or against the way the body faces (turning, charging a shot while drifting):
    // the hips and legs turn toward the direction of travel and the chest stays on the aim;
    // going backwards plays the stride in reverse
    let travelDir = 1;
    if (this.speed > 1 && free > 0.5) {
      let rel = Math.atan2(this.vx, this.vz) - this.yaw; rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      const back = Math.abs(rel) > 2.0;
      if (back) travelDir = -1;
      const side = back ? Math.atan2(Math.sin(rel - Math.PI), Math.cos(rel - Math.PI)) : rel;
      this.hipTurn = damp(this.hipTurn || 0, clamp(side, -0.4, 0.4) * (1 - this.shufW), 8, dt);
    } else this.hipTurn = damp(this.hipTurn || 0, 0, 8, dt);
    AD.add('hips', 0, this.hipTurn); AD.add('chest', 0, -this.hipTurn * 0.6);
    this.h.animate(dt, t, this.speed, P, W, { pose: AD, lift, clips, fast, dir: travelDir * (this.speed > 0.5 ? 1 : 0) || 1 });
    // footfalls: when a foot comes down at pace, kick up a little turf
    if (this.h.ready && o.step && this.speed > 2.2 && !this.celW) {
      const sc = this.h.group.scale.y;
      for (const k of ['l', 'r']) {
        const f = this.h.foot(k, this._fv || (this._fv = new THREE.Vector3())), air = f.y > 0.045 * sc;
        if (!air && this.feet[k]) o.step(f.x, f.z, clamp((this.speed - 2.2) / 3, 0, 1));
        this.feet[k] = air;
      }
    }

    // stun stars
    this.stars.visible = stun;
    if (stun) this.stars.children.forEach((s, k) => { const a = t * 5 + k * 2.09; s.position.set(Math.cos(a) * 0.3, Math.sin(t * 7 + k) * 0.04, Math.sin(a) * 0.3); s.rotation.y = t * 6; });
    // decals
    const mine = o.mine, u = this.plate.material.uniforms;
    u.uMine.value = mine ? 1 : 0; u.uLive.value = o.live ? 1 : 0; u.uTime.value = t;
    u.uCharge.value = charging ? ct / C.PERF_END : -1;
    u.uCool.value = p[7] > 0 ? p[7] / C.DASH_CD : 0;
    this.arrow.visible = mine && o.live;
    this.arrow.position.y = 2.02 + Math.sin(t * 3.2) * 0.035;
  }
  hide() { this.root.visible = false; this.lastX = null; if (this.fakeShadow) this.fakeShadow.visible = false; }
  startSwing(sec, foot) { this.swingT = this.swingDur = Math.max(0.03, sec); this.kickT = 0; if (foot) this.kickFoot = foot; }
  startTouch(foot, kind) {
    this.touchDur = kind === 'knock' || kind === 'poke' ? 0.26 : 0.2;
    this.touchT = this.touchDur; this.touchFoot = foot === 'L' ? 'L' : 'R'; this.touchKind = kind || 'step';
  }
  startReceive(part) { this.recvT = 0.34; this.recvPart = part || 'foot'; }
  startHeader() { this.headerT = 0.45; }
}

// ---------------------------------------------------------------- goals / nets
// The net is real netting: knots on a 10 cm mesh joined by cords. Every cord is a rope (an XPBD
// distance constraint that resists stretching with a little give and goes slack under compression),
// the knots have mass and hang under gravity, and every edge is laced to the frame: posts, bar, roof
// stays, back bar, uprights and ground frame. Once the ball is over the line, the drawn ball becomes a
// body in the same solve: it stretches the cords it presses into, the net's tension slows and holds
// it, and it drops into the bag. Drawn as round cords along every row and column of knots, rebuilt
// only while the net moves; the whole net sleeps once it is still.
const MESH = 0.1, CORD_R = 0.0065;
const KNOT_W = 1 / 0.004, BALL_W = 1 / 0.43; // inverse masses: a 4 g knot, the 430 g ball
const CORD_COMPLIANCE = 2e-5;                // m/N per 10 cm cord (braided PE, EA ~ 5 kN): taut, with a little give
const NET_DRAG = 2.2, NET_GRAV = 9.81, NET_GRIP = 5; // 1/s: energy the net takes from a ball it holds
const MU_S = 0.9, MU_K = 0.6;                // cord-on-leather friction, static / kinetic
class Net {
  // panels: [{ a, b, c, d, slack }], corners a (u0 v0), b (u1 v0), c (u0 v1), d (u1 v1)
  constructor(parent, panels, mat, mesh = MESH) {
    const pos = [], w = [], links = [], lines = [];
    for (const pn of panels) {
      const nu = Math.max(2, Math.round(pn.a.distanceTo(pn.b) / mesh)), nv = Math.max(2, Math.round(pn.a.distanceTo(pn.c) / mesh));
      const base = pos.length / 3, id = (i, j) => base + j * (nu + 1) + i, P = new THREE.Vector3();
      for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
        const u = i / nu, v = j / nv;
        P.set(0, 0, 0).addScaledVector(pn.a, (1 - u) * (1 - v)).addScaledVector(pn.b, u * (1 - v)).addScaledVector(pn.c, (1 - u) * v).addScaledVector(pn.d, u * v);
        pos.push(P.x, P.y, P.z); w.push(i === 0 || j === 0 || i === nu || j === nv ? 0 : KNOT_W);
      }
      // outward-ish reference normal for the cords' cross-sections
      const N = new THREE.Vector3().subVectors(pn.b, pn.a).cross(new THREE.Vector3().subVectors(pn.c, pn.a)).normalize();
      const addLine = L => {
        lines.push({ k: L, N });
        for (let q = 0; q + 1 < L.length; q++) {
          const a = L[q], b = L[q + 1];
          if (!w[a] && !w[b]) continue; // a cord lying along the frame never moves
          links.push(a, b, Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]) * (1 + pn.slack));
        }
      };
      for (let j = 0; j <= nv; j++) { const L = []; for (let i = 0; i <= nu; i++) L.push(id(i, j)); addLine(L); }
      for (let i = 0; i <= nu; i++) { const L = []; for (let j = 0; j <= nv; j++) L.push(id(i, j)); addLine(L); }
    }
    const n = w.length;
    this.n = n; this.x = Float32Array.from(pos); this.v = new Float32Array(n * 3); this.p = new Float32Array(n * 3);
    this.w = Float32Array.from(w); this.links = Float32Array.from(links); this.lines = lines; this.cf = new Uint8Array(n); this.off = new Float32Array(n * 3); this.near = new Int32Array(n);
    this.ball = null; // { x, y, z, vx, vy, vz, r } in goal-group space while the ball is in the net
    // cords: a round (triangular-section, smooth-shaded) tube along every line of knots
    let nv = 0; for (const L of lines) nv += L.k.length * 3;
    const geo = new THREE.BufferGeometry(), idx = [];
    this.gp = new Float32Array(nv * 3); this.gn = new Float32Array(nv * 3);
    let o = 0;
    for (const L of lines) {
      for (let q = 0; q + 1 < L.k.length; q++) for (let s = 0; s < 3; s++) {
        const a = o + q * 3 + s, b = o + q * 3 + (s + 1) % 3, c = a + 3, d = b + 3;
        idx.push(a, c, b, b, c, d);
      }
      o += L.k.length * 3;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.gp, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.gn, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(idx);
    this.geo = geo; this.mesh = new THREE.Mesh(geo, mat); this.mesh.frustumCulled = false; this.mesh.receiveShadow = true;
    parent.add(this.mesh);
    // settle into its natural hang before the first frame, then sleep
    for (let i = 0; i < 360; i++) this.step(1 / 240);
    this.v.fill(0);
    // warm the ball-in-the-net path (a throwaway shot, then the hang is restored) so the first real
    // goal doesn't stall a frame while the engine compiles it
    const x0 = Float32Array.from(this.x), c = panels[0];
    this.ball = { x: (c.a.x + c.d.x) / 2, y: 0.5, z: 0, vx: Math.sign(c.a.x) * 8, vy: 0, vz: 0, r: 0.11 };
    for (let i = 0; i < 40; i++) this.step(1 / 480);
    this.ball = null; this.x.set(x0); this.v.fill(0);
    this.build(); this.still = 1;
  }
  wake() { this.still = 0; }
  // the frame rattles the net (post / bar hits)
  shake(amount) {
    const v = this.v, w = this.w;
    for (let k = 0; k < this.n; k++) if (w[k]) { v[k * 3] += (Math.random() - 0.5) * amount; v[k * 3 + 1] += (Math.random() - 0.5) * amount; v[k * 3 + 2] += (Math.random() - 0.5) * amount; }
    this.wake();
  }
  // one substep of length h (predict, project cords / ball / ground, then derive velocities)
  step(h) {
    const x = this.x, v = this.v, p = this.p, w = this.w, n = this.n, L = this.links, B = this.ball;
    const drag = Math.exp(-NET_DRAG * h), g = NET_GRAV * h;
    for (let k = 0; k < n; k++) {
      const i = k * 3;
      if (!w[k]) { p[i] = x[i]; p[i + 1] = x[i + 1]; p[i + 2] = x[i + 2]; continue; }
      v[i] *= drag; v[i + 1] = v[i + 1] * drag - g; v[i + 2] *= drag;
      p[i] = x[i] + v[i] * h; p[i + 1] = x[i + 1] + v[i + 1] * h; p[i + 2] = x[i + 2] + v[i + 2] * h;
    }
    let bx = 0, by = 0, bz = 0, vyIn = 0;
    if (B) { B.vy -= g; vyIn = B.vy; bx = B.x + B.vx * h; by = B.y + B.vy * h; bz = B.z + B.vz * h; }
    const at = CORD_COMPLIANCE / (h * h), R = B ? B.r + CORD_R : 0, cf = this.cf, off = this.off, near = this.near;
    // knots close enough to touch the ball this substep (the only ones the contact pass looks at)
    let nn = 0;
    if (B) {
      cf.fill(0);
      const reach = R + Math.hypot(B.vx, B.vy, B.vz) * h + 0.05;
      for (let k = 0; k < n; k++) {
        const i = k * 3;
        if (Math.abs(p[i] - bx) < reach && Math.abs(p[i + 1] - by) < reach && Math.abs(p[i + 2] - bz) < reach) near[nn++] = k;
      }
    }
    // Knots pressed by the ball ride on its surface: they are held as offsets from its centre, so the
    // cords pulling on them pull the ball (it carries their tension, at its own mass) and every knot
    // on it moves with it. That is what makes the net's tension, not its knots' few grams, stop a shot.
    const contacts = () => {
      for (let q = 0; q < nn; q++) {
        const k = near[q], i = k * 3;
        if (cf[k]) { p[i] = bx + off[i]; p[i + 1] = by + off[i + 1]; p[i + 2] = bz + off[i + 2]; }
        const dx = p[i] - bx, dy = p[i + 1] - by, dz = p[i + 2] - bz, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= R * R || d2 < 1e-12) { if (cf[k] && d2 > R * R * 1.02) cf[k] = 0; continue; }
        const d = Math.sqrt(d2), f = (R - d) / d;
        if (!w[k]) { bx -= dx * f; by -= dy * f; bz -= dz * f; continue; } // a laced edge: the frame's cord
        p[i] += dx * f; p[i + 1] += dy * f; p[i + 2] += dz * f;
        if (!cf[k]) {
          // Coulomb friction as it first touches: rough cord grips a ball driving into it (a
          // frictionless net slips over the ball), but a ball only resting on the net slides down it
          const nx = dx / d, ny = dy / d, nz = dz / d, dn = R - d;
          let rx = p[i] - x[i] - (bx - B.x), ry = p[i + 1] - x[i + 1] - (by - B.y), rz = p[i + 2] - x[i + 2] - (bz - B.z);
          const rn = rx * nx + ry * ny + rz * nz; rx -= nx * rn; ry -= ny * rn; rz -= nz * rn;
          const rt = Math.hypot(rx, ry, rz), fk = rt <= MU_S * dn ? 1 : Math.min(1, MU_K * dn / (rt || 1));
          p[i] -= rx * fk; p[i + 1] -= ry * fk; p[i + 2] -= rz * fk;
          cf[k] = 1;
        }
        off[i] = p[i] - bx; off[i + 1] = p[i + 1] - by; off[i + 2] = p[i + 2] - bz;
      }
    };
    for (let it = 0, its = B ? 4 : 2; it < its; it++) {
      if (B) contacts();
      for (let s = 0; s < L.length; s += 3) {
        const a = L[s], b = L[s + 1], ia = a * 3, ib = b * 3, ca = B && cf[a], cb = B && cf[b];
        const ax = ca ? bx + off[ia] : p[ia], ay = ca ? by + off[ia + 1] : p[ia + 1], az = ca ? bz + off[ia + 2] : p[ia + 2];
        const qx = cb ? bx + off[ib] : p[ib], qy = cb ? by + off[ib + 1] : p[ib + 1], qz = cb ? bz + off[ib + 2] : p[ib + 2];
        const dx = qx - ax, dy = qy - ay, dz = qz - az, d = Math.hypot(dx, dy, dz);
        const C = d - L[s + 2];
        if (C <= 0 || d < 1e-9 || (ca && cb)) continue; // a cord only pulls; one lying on the ball is slack
        const wa = ca ? BALL_W : w[a], wb = cb ? BALL_W : w[b];
        if (wa + wb === 0) continue;
        const lam = C / (wa + wb + at) / d, ka = lam * wa, kb = lam * wb;
        if (ca) { bx += dx * ka; by += dy * ka; bz += dz * ka; } else { p[ia] += dx * ka; p[ia + 1] += dy * ka; p[ia + 2] += dz * ka; }
        if (cb) { bx -= dx * kb; by -= dy * kb; bz -= dz * kb; } else { p[ib] -= dx * kb; p[ib + 1] -= dy * kb; p[ib + 2] -= dz * kb; }
      }
      for (let k = 0; k < n; k++) if (w[k] && p[k * 3 + 1] < 0.004) p[k * 3 + 1] = 0.004; // the grass
      if (B) {
        if (by < B.r) by = B.r;
        const m = this.mouth; // a ball that is in stays in: the mouth plane holds it
        if (m && m.s * (bx - m.x) < B.r) bx = m.x + m.s * B.r;
      }
    }
    if (B) { contacts(); for (let q = 0; q < nn; q++) { const k = near[q], i = k * 3; if (cf[k]) { p[i] = bx + off[i]; p[i + 1] = by + off[i + 1]; p[i + 2] = bz + off[i + 2]; } } }
    let mx = 0;
    for (let k = 0; k < n; k++) {
      if (!w[k]) continue;
      const i = k * 3;
      v[i] = (p[i] - x[i]) / h; v[i + 1] = (p[i + 1] - x[i + 1]) / h; v[i + 2] = (p[i + 2] - x[i + 2]) / h;
      x[i] = p[i]; x[i + 1] = p[i + 1]; x[i + 2] = p[i + 2];
      mx = Math.max(mx, Math.abs(v[i]) + Math.abs(v[i + 1]) + Math.abs(v[i + 2]));
    }
    if (B) {
      B.vx = (bx - B.x) / h; B.vy = (by - B.y) / h; B.vz = (bz - B.z) / h;
      // netting is lossy: it soaks up most of a shot instead of firing it back out
      let touching = false; for (let k = 0; k < n; k++) if (cf[k]) { touching = true; break; }
      if (touching) { const f = Math.exp(-NET_GRIP * h); B.vx *= f; B.vy *= f; B.vz *= f; }
      B.x = bx; B.y = by; B.z = bz;
      if (by <= B.r + 1e-4) { // on the grass: bounce a little, roll with some resistance
        B.vy = vyIn < -1 ? -vyIn * 0.42 : Math.max(0, B.vy);
        const f = Math.exp(-1.6 * h); B.vx *= f; B.vz *= f;
      }
    }
    return mx;
  }
  // advance by dt (substeps small enough that a fast ball can't slip between knots)
  update(dt) {
    if (this.still > 0.6 && !this.ball) return;
    const B = this.ball, sp = B ? Math.hypot(B.vx, B.vy, B.vz) : 0;
    const steps = Math.min(16, Math.max(Math.ceil(dt * 240), Math.ceil(sp * dt / 0.035)));
    let mx = 0;
    for (let s = 0; s < steps; s++) mx = Math.max(mx, this.step(dt / steps));
    this.still = mx < 0.03 && !B ? this.still + dt : 0;
    this.build();
  }
  // rewrite the cord tubes from the knot positions
  build() {
    const x = this.x, P = this.gp, Nn = this.gn;
    let o = 0;
    for (const L of this.lines) {
      const k = L.k, m = k.length, N = L.N;
      for (let q = 0; q < m; q++) {
        const a = k[Math.max(0, q - 1)] * 3, b = k[Math.min(m - 1, q + 1)] * 3, c = k[q] * 3;
        let tx = x[b] - x[a], ty = x[b + 1] - x[a + 1], tz = x[b + 2] - x[a + 2];
        const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
        // b1 = t x N, b2 = b1 x t: a frame round the cord
        let ux = ty * N.z - tz * N.y, uy = tz * N.x - tx * N.z, uz = tx * N.y - ty * N.x;
        const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
        const vx = uy * tz - uz * ty, vy = uz * tx - ux * tz, vz = ux * ty - uy * tx;
        for (let s = 0; s < 3; s++) {
          const an = s * 2.0943951, ca = Math.cos(an), sa = Math.sin(an);
          const nx = ux * ca + vx * sa, ny = uy * ca + vy * sa, nz = uz * ca + vz * sa, j = (o + q * 3 + s) * 3;
          P[j] = x[c] + nx * CORD_R; P[j + 1] = x[c + 1] + ny * CORD_R; P[j + 2] = x[c + 2] + nz * CORD_R;
          Nn[j] = nx; Nn[j + 1] = ny; Nn[j + 2] = nz;
        }
      }
      o += m * 3;
    }
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.normal.needsUpdate = true;
  }
}

// The goal frame: posts and crossbar are one extrusion of an elliptical profile (deeper than it is
// wide, like a match goal's) along the frame's path, with welded mitre joints at the top corners.
// The profile is swept, not assembled from parts, so there are no end caps, overlaps or seams: a
// single white section runs from one post foot, over the bar, down to the other.
// path: points in one plane; u: unit normal of that plane (the profile's depth axis);
// a: half-depth (along u), b: half-width (in the plane)
function mitredFrame(path, u, a, b, seg = 28) {
  const pos = [], nor = [], idx = [];
  const T = [], Nv = [];
  for (let i = 0; i + 1 < path.length; i++) { const t = path[i + 1].clone().sub(path[i]).normalize(); T.push(t); Nv.push(new THREE.Vector3().crossVectors(t, u).normalize()); }
  // miter offset at a path vertex: the in-plane normal that meets both neighbouring segments
  const miter = i => {
    if (i === 0) return Nv[0].clone(); if (i === path.length - 1) return Nv[Nv.length - 1].clone();
    const p = Nv[i - 1], q = Nv[i]; return p.clone().add(q).multiplyScalar(1 / (1 + p.dot(q)));
  };
  for (let s = 0; s < T.length; s++) {
    const n = Nv[s], ends = [[path[s], miter(s)], [path[s + 1], miter(s + 1)]];
    const base = pos.length / 3;
    for (const [p, m] of ends) for (let k = 0; k <= seg; k++) {
      const f = k / seg * Math.PI * 2, cu = Math.cos(f) * a, cv = Math.sin(f) * b;
      pos.push(p.x + u.x * cu + m.x * cv, p.y + u.y * cu + m.y * cv, p.z + u.z * cu + m.z * cv);
      const nu = Math.cos(f) / a, nv = Math.sin(f) / b, l = Math.hypot(nu, nv);
      nor.push((u.x * nu + n.x * nv) / l, (u.y * nu + n.y * nv) / l, (u.z * nu + n.z * nv) / l);
    }
    for (let k = 0; k < seg; k++) { const i0 = base + k, i1 = base + seg + 1 + k; idx.push(i0, i0 + 1, i1, i0 + 1, i1 + 1, i1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx); return g;
}
// The net's support frame: round tube along a path, with a sphere of the tube's own radius at each
// joint. A cylinder meets a sphere of its radius tangentially, so every corner is a clean rounded
// bend with no crease, gap or protruding cap.
function tubeFrame(paths, r) {
  const parts = [];
  for (const path of paths) for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], b = path[i + 1], len = a.distanceTo(b);
    const c = new THREE.CylinderGeometry(r, r, len, 14, 1, true);
    c.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())));
    c.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2); parts.push(c);
    if (i > 0) { const s = new THREE.SphereGeometry(r, 14, 10); s.translate(a.x, a.y, a.z); parts.push(s); }
  }
  return parts;
}

class Goal {
  constructor(scene, side, netMat, mesh = MESH, lite = false) {
    this.side = side; const gx = side * HW; this.gx = gx;
    const g = new THREE.Group(); scene.add(g); this.g = g; this.shakeT = 0;
    const white = lite
      ? new THREE.MeshStandardMaterial({ color: 0xd9dce2, roughness: 0.34, metalness: 0.0 })
      : new THREE.MeshPhysicalMaterial({ color: 0xd9dce2, roughness: 0.34, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.1 });
    const hw = GW / 2, backH = GOAL_H * 0.72, bx = gx + side * GDP, V = (x, y, z) => new THREE.Vector3(x, y, z);
    // posts and bar: centre line from post foot (just below the grass) over the bar to the other foot
    const PA = 0.068, PB = 0.056; // half-depth, half-width of the elliptical section
    const frame = new THREE.Mesh(mitredFrame([V(gx, -0.02, -hw), V(gx, GOAL_H, -hw), V(gx, GOAL_H, hw), V(gx, -0.02, hw)], V(1, 0, 0), PA, PB), white);
    frame.castShadow = true; frame.receiveShadow = true; g.add(frame);
    // support frame: roof stays from each top corner back to the rear bar, the rear uprights, and a
    // ground frame round the base, all one tube (it starts and ends inside the posts)
    const TR = 0.019, gy = TR;
    const thin = new THREE.MeshStandardMaterial({ color: 0xdadde2, roughness: 0.4, metalness: 0.25 });
    const into = gx + side * PA * 0.3; // the ends of the stays sit inside the post section
    const tube = tubeFrame([
      [V(into, GOAL_H - PB * 0.4, -hw), V(bx, backH, -hw), V(bx, backH, hw), V(into, GOAL_H - PB * 0.4, hw)],
      [V(bx, backH, -hw), V(bx, gy, -hw)], [V(bx, backH, hw), V(bx, gy, hw)],
      [V(into, gy, -hw), V(bx, gy, -hw), V(bx, gy, hw), V(into, gy, hw)],
    ], TR);
    const support = new THREE.Mesh(mergeGeometries(tube), thin); tube.forEach(p => p.dispose());
    support.castShadow = true; support.receiveShadow = true; g.add(support);
    // the net is laced on along the back of the posts and bar, not through their centre line; the
    // roof and back hang with a little more slack than the sides, as a real net is strung
    const nx = gx + side * PA * 0.6, ny = GOAL_H - PB * 0.55;
    this.net = new Net(g, [
      { a: V(bx, backH, -hw), b: V(bx, backH, hw), c: V(bx, 0, -hw), d: V(bx, 0, hw), slack: 0.045 },   // back
      { a: V(nx, ny, -hw), b: V(nx, ny, hw), c: V(bx, backH, -hw), d: V(bx, backH, hw), slack: 0.05 },  // roof
      { a: V(nx, ny, -hw), b: V(bx, backH, -hw), c: V(nx, 0, -hw), d: V(bx, 0, -hw), slack: 0.035 },   // sides
      { a: V(nx, ny, hw), b: V(bx, backH, hw), c: V(nx, 0, hw), d: V(bx, 0, hw), slack: 0.035 },
    ], netMat, mesh);
    this.hw = hw; this.bx = bx; this.nx = nx; this.handoff = 0; this._out = { x: 0, y: 0, z: 0 };
    this.net.mouth = { x: gx, s: side };
  }
  // a goal: the ball is already in the net's own solve (see step); just make sure it is awake
  hit() { this.net.wake(); }
  // Advance the net, and own the ball while it is in the goal. `ball` is the sim's ball as drawn
  // (world centre, velocity, drawn radius) or null. Returns where to draw the ball while this goal
  // holds it, else null. The ball is taken over as it crosses the line, with the sim's velocity, and
  // handed back when the sim puts it somewhere else (kick-off, a replay rewinding).
  step(dt, ball) {
    if (this.shakeT > 0) {
      const was = this.shakeT; this.shakeT = Math.max(0, this.shakeT - dt); const a = this.shakeT * 0.06;
      this.g.position.set(Math.sin(this.shakeT * 90) * a, 0, Math.cos(this.shakeT * 77) * a * 0.5);
      if (was > 0.45 && this.shakeT <= 0.45) this.net.shake(0.6); // the frame rattles the net
    }
    const N = this.net, s = this.side, gp = this.g.position;
    const past = b => s * (b.x - gp.x - this.gx);       // how far over the line (m)
    if (ball) {
      const inside = past(ball) > 0 && Math.abs(ball.z - gp.z) < this.hw && ball.y < GOAL_H;
      if (!N.ball && inside && this.handoff <= 0) {
        N.ball = { x: ball.x - gp.x, y: ball.y, z: ball.z - gp.z, vx: ball.vx, vy: ball.vy, vz: ball.vz, r: ball.rDraw };
        N.wake();
      } else if (N.ball) {
        const B = N.ball, far = Math.hypot(ball.x - gp.x - B.x, ball.z - gp.z - B.z) > 2.5;
        if (far || past(ball) < -1) { N.ball = null; this.handoff = far ? 0 : 0.2; this._out.x = B.x + gp.x; this._out.y = B.y; this._out.z = B.z + gp.z; }
      }
    } else if (N.ball) N.ball = null;
    N.update(dt);
    const B = N.ball;
    if (B) {
      // failsafe: the net is the only thing holding the ball; keep it inside the goal's volume
      const lo = Math.min(this.gx, this.bx) - 1, hi = Math.max(this.gx, this.bx) + 1;
      B.x = clamp(B.x, lo, hi); B.z = clamp(B.z, -this.hw - 0.8, this.hw + 0.8); B.y = Math.min(B.y, GOAL_H + 0.8);
      this._out.x = B.x + gp.x; this._out.y = B.y; this._out.z = B.z + gp.z;
      return this._out;
    }
    if (this.handoff > 0 && ball) { // ease back onto the sim's ball
      this.handoff = Math.max(0, this.handoff - dt); const u = 1 - this.handoff / 0.2, o = this._out;
      o.x += (ball.x - o.x) * u; o.y += (ball.y - o.y) * u; o.z += (ball.z - o.z) * u;
      return this.handoff > 0 ? o : null;
    }
    this.handoff = 0;
    return null;
  }
}

// ---------------------------------------------------------------- shader programs
// Wait until every program behind `list` (materials from renderer.compile(), or programs) is
// finished, counting them off on the loading screen's stage `S`. With KHR_parallel_shader_compile
// the driver compiles them all at once and each is polled without blocking; without it, finishing
// a program blocks, so they are finished one ~12 ms slice at a time and the screen still moves.
// getUniforms() runs three's first-use checks now, rather than in the first frame that uses it.
async function compilePrograms(renderer, list, S) {
  const progs = new Set();
  for (const x of list) {
    const p = x.isMaterial ? renderer.properties.get(x).currentProgram : x;
    if (p && p.isReady) progs.add(p);
  }
  const total = progs.size;
  if (S) S.begin(total, 'programs', `0 of ${total} programs`);
  let done = 0;
  while (progs.size) {
    const t0 = performance.now();
    for (const p of progs) {
      if (!p.isReady()) continue;
      p.getUniforms(); progs.delete(p); done++;
      if (performance.now() - t0 > 12) break;
    }
    if (S) { S.done = done; S.note(`${done} of ${total} programs`); }
    if (progs.size) await new Promise(r => setTimeout(r, 4));
  }
  if (S) S.end(`${total} programs`);
}

// ---------------------------------------------------------------- renderer
// opts.tier: 'high' | 'medium' | 'lite' (graphics.js picks it for the machine)
// opts.boot: the boot loader's API (loader.js). Resolves once the renderer is completely ready:
// the stadium and both players built, every GPU program compiled and a first full frame drawn, so
// nothing about the renderer is ever built, compiled or uploaded later, mid-menu or mid-match.
// opts.noShadow: this device draws floodlit surfaces black with shadow maps (found by the self-test
// below on an earlier visit), so it runs without them
export async function createRenderer(canvas, { tier = 'high', boot, noShadow = false } = {}) {
  const lite = tier === 'lite';
  // the stadium build, reported step by step (each step yields so the loading screen can paint)
  const SS = boot.stage('stadium').begin(11, 'steps', 'Floodlights and sky');
  const built = async (next) => { SS.step(1, next); await boot.yield(); };
  // high/medium antialias in their own HDR target; lite renders straight to the canvas unsmoothed
  // (on a software rasteriser multisampling costs a whole extra pass of every pixel)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.info.autoReset = false; // counted per frame (all passes), reset in frame()
  // how this GPU samples colour textures correctly (texcompat.js); applied once everything is built
  const srgb = probeSRGB(renderer);
  // ?tex=native|nomip|shader forces a path for this visit (support and testing)
  const texParam = new URLSearchParams(location.search).get('tex');
  if (['native', 'nomip', 'shader'].includes(texParam)) Object.assign(srgb, { mode: texParam, forced: true });
  const aniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 16 / 9, 0.1, 300);
  // floodlights, sky, image-based lighting and the post chain (lighting.js)
  TIER = tier;
  const integrated = !!(boot && boot.probe && boot.probe.integrated);
  const light = createLighting(renderer, scene, camera, { HW, HH, PW, PH, GDP }, tier, integrated ? 1024 : 0);
  if (noShadow) renderer.shadowMap.enabled = false;
  if (lite) { // the grade's vignette, for free
    const v = document.createElement('div'); v.style.cssText = 'position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,8,0.45) 100%)';
    if (canvas.parentElement) canvas.parentElement.appendChild(v);
  }
  await built('Pitch');

  // ground + pitch
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x10161f, roughness: 1 }));
  outer.rotation.x = -Math.PI / 2; outer.position.y = -0.02; outer.receiveShadow = true; scene.add(outer);
  const track = new THREE.Mesh(new THREE.PlaneGeometry(PW + 13, PH + 7.5), new THREE.MeshStandardMaterial({ color: 0x1a4a2a, roughness: 1 }));
  track.rotation.x = -Math.PI / 2; track.position.y = -0.01; track.receiveShadow = true; scene.add(track);
  const pt = pitchTexture(); pt.tex.anisotropy = lite ? 1 : aniso;
  await built('Grass');
  // Grass under floodlights: blades laid by the mower scatter light toward or away from the camera
  // depending on which way they lie, so the bands brighten and darken with the view (pan the camera
  // and they shift, as on TV). Plus a fine blade relief that catches the lamps as a soft sheen.
  const gn = lite ? null : grassNormalTexture();
  if (gn) { gn.repeat.set(pt.W / 0.9, pt.H / 0.9); gn.anisotropy = aniso; }
  const pitchMat = new THREE.MeshStandardMaterial({ map: pt.tex, roughness: 0.9, normalMap: gn, normalScale: new THREE.Vector2(0.45, 0.45), envMapIntensity: 0.2 });
  pitchMat.onBeforeCompile = sh => {
    sh.uniforms.uBand = { value: PW / 12 }; sh.uniforms.uHW = { value: HW };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vPitchW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPitchW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vPitchW; uniform float uBand, uHW;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        float band = floor((vPitchW.x + uHW) / uBand);
        float lay = mod(band, 2.0) < 0.5 ? 1.0 : -1.0;             // blades laid toward / away from the main stand
        vec3 Vg = normalize(cameraPosition - vPitchW);
        diffuseColor.rgb *= 1.0 + 0.26 * lay * Vg.z;`);
  };
  const pitch = new THREE.Mesh(new THREE.PlaneGeometry(pt.W, pt.H), pitchMat);
  pitch.rotation.x = -Math.PI / 2; pitch.receiveShadow = true; scene.add(pitch);
  await built('Advertising boards');

  // ad boards = the walls the ball bounces off
  const bTex = boardTexture(); bTex.anisotropy = aniso;
  // one LED material for every board: each board's repeat and start offset are baked into its own
  // coordinates, so all of them merge into a single draw (and scroll together, as before)
  const boardLed = bTex.clone(); boardLed.needsUpdate = true;
  const boardTexs = [boardLed], boardStatics = [];
  const face = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: boardLed, emissiveIntensity: 1.25, roughness: 0.4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0b0f18, roughness: 0.6 });
  const BH = 0.26, BT = 0.07;
  // the LED boards light the turf in front of them: a soft wash that falls off over a metre
  const spillTex = canvasTex(4, 128, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.18, 'rgba(255,255,255,0.5)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.14)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
  const spillMat = new THREE.MeshBasicMaterial({ map: spillTex, color: new THREE.Color(0.62, 0.7, 1.0), transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false });
  const SPILL = 1.3;
  const board = (len, x, z, alongX) => {
    const mats = alongX ? [dark, dark, dark, dark, face, face] : [face, face, dark, dark, dark, dark];
    const m = new THREE.Mesh(bakeUV(new THREE.BoxGeometry(alongX ? len : BT, BH, alongX ? BT : len), len / 5.5, Math.random()), mats);
    m.position.set(x, BH / 2, z); m.castShadow = true; scene.add(m); boardStatics.push(m);
    // bright edge (the plane's local -z) against the board, fading out onto the pitch
    const ix = alongX ? 0 : -Math.sign(x), iz = alongX ? -Math.sign(z) : 0;
    const sp = new THREE.Mesh(new THREE.PlaneGeometry(len, SPILL).rotateX(-Math.PI / 2), spillMat);
    sp.position.set(x + ix * (BT / 2 + SPILL / 2), 0.011, z + iz * (BT / 2 + SPILL / 2));
    sp.rotation.y = Math.atan2(ix, iz); sp.renderOrder = 1; scene.add(sp); boardStatics.push(sp);
  };
  board(PW + 0.2, 0, -HH - BT / 2 - 0.02, true);
  board(PW + 0.2, 0, HH + BT / 2 + 0.02, true);
  const endLen = HH - GW / 2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) board(endLen, sx * (HW + BT / 2 + 0.02), sz * (GW / 2 + endLen / 2), false);
  mergeStatic(scene, boardStatics); // six boards and their glow: three draws instead of forty-two
  await built('Goal and net (1 of 2)');

  // net cord: braided polyethylene, matte white
  const netMat = new THREE.MeshStandardMaterial({ color: 0xeef0f3, roughness: 0.78, metalness: 0 });
  const goals = [new Goal(scene, -1, netMat, lite ? 0.17 : MESH, lite)];
  await built('Goal and net (2 of 2)');
  goals.push(new Goal(scene, 1, netMat, lite ? 0.17 : MESH, lite));
  await built('Stands and crowd');

  // the bowl: stands, roofs and their ring of floodlights, the crowd, the light show (stadium.js)
  const stadium = buildStadium(scene, { HW, HH, GDP }, tier, bTex);
  await built('Big screen');

  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2c3342, roughness: 0.55, metalness: 0.7 });
  // stars in the sky
  {
    const n = 400, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, e = rand(0.15, 1.2), r = 120; pos.set([Math.cos(a) * Math.cos(e) * r, Math.sin(e) * r, Math.sin(a) * Math.cos(e) * r], i * 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xaab8ff, size: 0.35, fog: false, transparent: true, opacity: 0.7 })));
  }

  // jumbotron
  const jCanvas = document.createElement('canvas'); jCanvas.width = 768; jCanvas.height = 256;
  const jTex = new THREE.CanvasTexture(jCanvas); jTex.colorSpace = THREE.SRGBColorSpace; jTex.anisotropy = aniso;
  // the big screen stands on the home end's roof, facing down the pitch
  const jumbo = new THREE.Group(); jumbo.position.set(-(HW + GDP + 7.2), 12.9, 0); jumbo.rotation.y = Math.PI / 2; scene.add(jumbo);
  const jScreen = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 2.4), new THREE.MeshBasicMaterial({ map: jTex, toneMapped: false }));
  jumbo.add(jScreen);
  const jFrame = new THREE.Mesh(new THREE.BoxGeometry(7.6, 2.8, 0.3), poleMat); jFrame.position.z = -0.2; jumbo.add(jFrame);
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
  await built('Player 1: kit and markers');

  // players (rigged once their models are in, below), ball, trail, particles
  const players = [new Player(scene, 0)];
  await built('Player 2: kit and markers');
  players.push(new Player(scene, 1));
  await built('Ball and effects');
  const ballMat = new THREE.MeshPhysicalMaterial({ map: ballTexture(), roughness: 0.5, clearcoat: 0.8, clearcoatRoughness: 0.18, emissive: 0xffc02e, emissiveIntensity: 0 });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 32, 20), ballMat);
  ball.castShadow = true; ball.visible = false; scene.add(ball);
  const ballLight = new THREE.PointLight(0xffc34d, 0, 4, 2); scene.add(ballLight);
  const ballBlob = new THREE.Mesh(new THREE.CircleGeometry(BALL_R * 1.3, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
  ballBlob.position.y = 0.013; scene.add(ballBlob);
  let lastBall = null, simBall = null, ballHot = 0, ballSpd = 0;
  // the sim's ball as drawn: centre, velocity and drawn radius (what a goal's net takes over)
  const ballInfo = { x: 0, y: 0, z: 0, rDraw: BALL_R, vx: 0, vy: 0, vz: 0 }; let ballLive = false;

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
  const bankOn = [1, 1, 1, 1];

  // Holding the frame rate. The client paces frames to a steady rate (the display's own, or half of
  // it on 120 Hz+ screens: an even 60 beats a ragged 80) and gives the renderer its time budget per
  // frame (setBudget). Within the tier, the renderer spends to fit that budget, giving up first what
  // is least visible for what it saves:
  //   1. ambient occlusion (high only: subtle, and it draws the whole scene a second time)
  //   2. render resolution, in small steps down to a floor (a smaller buffer, never a recompile; on
  //      a dense phone screen the first steps can't be seen)
  //   3. bloom and lamp streaks, only when even the floor resolution can't keep up
  // and wins it back in reverse order when there is headroom. Headroom is measured where the
  // browser exposes GPU timing; elsewhere it is probed: step up after a stretch of on-time frames,
  // and if that costs the budget, step straight back and leave it for longer each time.
  // The setting it settles on is remembered for the device and tier, so the next visit starts there.
  // level: 2 = full post chain, 1 = no AO, 0 = tone map + grade only
  const PR_CAP = { high: 1.75, medium: 1.25, lite: 1 }[tier] || 1.5, MIN_SCALE = { high: 0.6, medium: 0.55, lite: 0.4 }[tier] || 0.6;
  const hasAO = tier === 'high', SETTLED = 'ob_adapt_' + tier;
  let quality = 'auto', level = 2, scale = lite ? 0.75 : 1;
  try { const k = JSON.parse(localStorage.getItem(SETTLED)); if (k && k.scale >= MIN_SCALE && k.scale <= 1 && [0, 1, 2].includes(k.level)) { scale = k.scale; level = k.level; } } catch { }
  let budget = 1000 / 60, ftAvg = budget, ftVar = 0, cssW = 1, cssH = 1, lastChange = 0, upBlockUntil = 0, upBlockFor = 20, lastCheck = 0, lastUp = -1, settledAt = 0;
  function setQuality(q) { quality = q; }
  function setBudget(ms) { if (Math.abs(ms - budget) > 0.5) { budget = ms; ftAvg = ms; ftVar = 0; } }
  // struggling: at the bottom of the ladder and still well over budget for seconds on end. The
  // client then steps down a tier (see client.js), only ever between matches.
  let struggleT = 0;
  const down = () => {
    if (level === 2 && hasAO) { level = 1; light.setLevel(level); return true; }
    if (scale > MIN_SCALE + 1e-3) { scale = Math.max(MIN_SCALE, scale * 0.85); resize(cssW, cssH); return true; }
    if (level > 0) { level = 0; light.setLevel(level); return true; }
    return false;
  };
  const up = () => {
    if (level === 0) { level = hasAO ? 1 : 2; light.setLevel(level); return true; }
    if (scale < 1 - 1e-3) { scale = Math.min(1, scale * 1.12); resize(cssW, cssH); return true; }
    if (level === 1 && hasAO) { level = 2; light.setLevel(level); return true; }
    return false;
  };
  function adapt(now, rawDt) {
    const ms = rawDt * 1000;
    ftAvg += (ms - ftAvg) * 0.08; ftVar += ((ms - ftAvg) ** 2 - ftVar) * 0.08;
    const bottom = scale <= MIN_SCALE + 1e-3 && level === 0;
    struggleT = bottom && ftAvg > budget * 1.5 ? struggleT + rawDt : 0;
    if (now - lastCheck < 1) return; lastCheck = now;
    const g = gpu.ms;
    const slow = ftAvg > budget * 1.2 || (g !== null && g > budget * 0.92);
    const headroom = g !== null ? g < budget * 0.62 && ftAvg < budget * 1.1 : ftAvg < budget * 0.95;
    if (slow) {
      // the last step up was one too many: back down, and wait longer before trying again
      if (lastUp > 0 && now - lastUp < 4) { upBlockUntil = now + upBlockFor; upBlockFor = Math.min(240, upBlockFor * 2); }
      if (down()) { lastChange = now; ftAvg = budget; ftVar = 0; }
      lastUp = -1; settledAt = now;
    } else if (headroom && now - lastChange > 4 && now > upBlockUntil) {
      if (up()) { lastChange = lastUp = now; ftAvg = budget; ftVar = 0; }
    }
    // remember a setting that has held for a while
    if (!slow && now - lastChange > 10 && now - settledAt > 10) {
      settledAt = now;
      try { localStorage.setItem(SETTLED, JSON.stringify({ scale: +scale.toFixed(3), level })); } catch { }
    }
  }

  // camera: a TV-broadcast framing. The full depth of the pitch is always visible; the width is
  // framed at ~80% and the camera pans with the ball so each goal comes fully into view.
  // a main-stand broadcast camera: high enough to read the whole pitch, low enough for perspective
  const EL = THREE.MathUtils.degToRad(40);
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
    // ...and above the far touchline, the front rows of the main stand and its LED ribbon, so
    // play always happens in a stadium rather than on a diagram of a pitch
    // (that point sits above and behind a far player's name tag, so it bounds both)
    const far = new THREE.Vector3(0, 3.3, -(HH + 3.2)), near = new THREE.Vector3(0, 0, HH + 0.35);
    const topLimit = 0.97, botLimit = -0.97 + safeBottom * 2;
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
  // a band along the bottom the near touchline is framed above (fraction of the view's height): the
  // on-screen thumb controls sit there on a phone
  let safeBottom = 0;
  function setSafeBottom(f) { if (f !== safeBottom) { safeBottom = f; resize(cssW, cssH); } }
  function resize(w, h) {
    cssW = w; cssH = h;
    const pr = Math.min(window.devicePixelRatio || 1, PR_CAP) * scale;
    renderer.setPixelRatio(pr); renderer.setSize(w, h, false);
    light.setSize(w, h, pr); light.setLevel(level);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    parts.mat.uniforms.uScale.value = h * pr / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    fit();
  }

  // aim arrow (own player, while charging) and mouse target marker
  const aimMat = new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color(0xffffff) }, uTime: { value: 0 }, uLen: { value: 2 } }, vertexShader: decalVert, fragmentShader: beamFrag, transparent: true, depthWrite: false, toneMapped: false });
  const aimArrow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0).rotateX(-Math.PI / 2), aimMat);
  aimArrow.renderOrder = 3; aimArrow.visible = false; scene.add(aimArrow);
  const curMat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 } }, vertexShader: decalVert, fragmentShader: markFrag, transparent: true, depthWrite: false, toneMapped: false });
  const cursor = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5).rotateX(-Math.PI / 2), curMat);
  cursor.position.y = 0.02; cursor.renderOrder = 3; cursor.visible = false; scene.add(cursor);

  // shockwave rings on hard contact
  const waves = Array.from({ length: 6 }, () => {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    m.position.y = 0.03; m.renderOrder = 4; m.visible = false; scene.add(m); return { m, t: 0, dur: 0.3, max: 2 };
  });
  let waveIdx = 0;
  SS.end('Done');
  function wave(x, z, y, color, max, dur) { const w = waves[waveIdx++ % waves.length]; w.m.position.set(x, y, z); w.m.material.color.setHex(color); w.t = 0; w.dur = dur; w.max = max; w.m.visible = true; }
  const camKick = new THREE.Vector3();
  let ballSquash = 0, fovPunch = 0;

  // effects state
  let shake = 0, hype = 0, hypeR = 0, hypeB = 0, zoom = 0, orbit = 0, jumboFlash = null, jumboFlashT = 0;
  const fx = {
    swing(slot, ticks, foot) { const P = players[slot]; if (P) P.startSwing(ticks / 60, foot); },
    kick(slot, x, y, perfect, power, dx = 0, dy = 0, lob = false, foot = null) {
      const P = players[slot]; if (P) { P.kickT = 1; P.swingT = 0; if (foot) P.kickFoot = foot; }
      const X = wx(x), Z = wz(y);
      ballSquash = Math.min(1, 0.35 + power * 0.6);
      parts.burst(X, 0.05, Z, 8 + power * 10, { colors: [0x3d8b3f, 0x5aa04f, 0x2d6e30, 0x7a5a36], speed: 2.4 + power, up: 2.5 + power * 1.5, size: 0.07, life: 0.7 });
      if (power > 0.6) { wave(X, Z, 0.05, perfect ? 0xffd34d : 0xffffff, 0.8 + power * 0.9, 0.28); camKick.x += dx * power * 0.28; camKick.z += dy * power * 0.28; }
      if (perfect) {
        parts.burst(X, 0.25, Z, 38, { colors: [0xffd34d, 0xfff1b0, 0xffa31a], speed: 6.5, up: 4, size: 0.12, life: 0.8, grav: 4 });
        wave(X, Z, 0.25, 0xffe28a, 2.6, 0.4); fovPunch = 1; shake = Math.max(shake, 0.12); ballHot = 1;
      }
    },
    touch(slot, x, y, f, foot, kind) {
      const P = players[slot]; if (P) P.startTouch(foot, kind);
      if (f > 4 || kind === 'knock') parts.burst(wx(x), 0.03, wz(y), kind === 'knock' ? 6 : 3, { colors: [0x4f9a45, 0x3d8b3f], speed: 1, up: 1.2, size: 0.05, life: 0.35 });
    },
    trap(slot, x, y, q, part) {
      const P = players[slot]; if (P) P.startReceive(part);
      parts.burst(wx(x), 0.05, wz(y), part === 'foot' ? 6 : 4, { colors: part === 'foot' ? [0x4f9a45, 0xd7e6c8] : [0xd7e6c8, 0x9bbf8a], speed: 1.4, up: 1.5, size: 0.06, life: 0.4 });
      ballSquash = 0.4;
    },
    header(slot, x, y) {
      const P = players[slot]; if (P) P.startHeader();
      parts.burst(wx(x), 1.7, wz(y), 12, { colors: [0xffffff, 0xd7e6c8, 0x9bbf8a], speed: 2.2, up: 1.5, size: 0.07, life: 0.5 });
      shake = Math.max(shake, 0.05);
    },
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
      goal.hit();
      const X = wx(x), Z = wz(y), col = KITS[scorer];
      parts.burst(X, 0.6, Z, 90, { colors: [col.shirt, 0xffffff, col.light, 0xffd34d], speed: 5, up: 8, size: 0.13, life: 2.2, grav: 3.5, drag: 1.2, sway: 0.6 });
      shake = 0.35; zoom = 1; camKick.x += (x > C.CX ? 1 : -1) * 0.5;
      if (scorer === 0) hypeR = 1.4; else hypeB = 1.4;
      hype = 1;
      jumboFlash = { text: 'GOAL!', color: col.css }; jumboFlashT = 3;
      stadium.goal(col.shirt); // the stands' LED ribbons and roof ring flash the scorer's colour
    },
    win(slot) {
      const col = KITS[slot];
      for (let i = 0; i < 160; i++) parts.emit(rand(-HW, HW), rand(5, 9), rand(-HH, HH), rand(-1, 1), 0, rand(-1, 1), [col.shirt, 0xffffff, 0xffd34d, col.light][i % 4], 0.13, rand(3, 5), 1.2, 0.8, 1);
      if (slot === 0) hypeR = 1.3; else hypeB = 1.3;
    },
    shake(a) { shake = Math.max(shake, a); },
  };

  // turf kicked up by a footfall at pace
  const stepFx = (x, z, k) => parts.burst(x, 0.02, z, 2 + Math.round(k * 3), { colors: [0x4f9a45, 0x3d8b3f, 0x6e5a3c], speed: 0.5 + k * 0.6, up: 0.6 + k * 0.8, size: 0.04 + k * 0.02, life: 0.3, grav: 6 });
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


  let lastT = null;
  function frame(view, nowMs) {
    const now = (nowMs !== undefined ? nowMs : performance.now()) / 1000;
    const rawDt = lastT === null ? 1 / 60 : Math.min(0.05, Math.max(0, now - lastT)); lastT = now;
    const dt = rawDt * (view.timeScale !== undefined ? view.timeScale : 1); // slow motion slows the world, not the UI
    const t = now;
    const live = !!view.live;

    if (rawDt > 0) adapt(now, rawDt);
    const m0 = performance.now();
    renderer.info.reset();
    gpu.poll();

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
          other: (() => { const q = W.players[1 - i]; return q && !(view.hide && view.hide[1 - i]) ? [wx(q[0]), wz(q[1])] : null; })(),
          celebrate: view.celebrate === i, sad: view.celebrate === 1 - i,
          step: live ? stepFx : null,
        });
      });
    } else players.forEach(P => P.hide());
    const m1 = performance.now();

    // aim arrow for my player while charging
    const me = W && W.players && view.mySlot >= 0 ? W.players[view.mySlot] : null;
    const ct = view.localCt;
    aimArrow.visible = !!(me && live && ct !== undefined && ct >= 0 && view.aim);
    if (aimArrow.visible) {
      const perfect = ct >= C.CHARGE_FULL && ct <= C.PERF_END, len = 1.3 + 1.1 * Math.min(ct / C.CHARGE_FULL, 1);
      const dx = view.aim[0], dz = view.aim[1];
      aimArrow.position.set(wx(me[0]) + dx * 0.42, 0.022, wz(me[1]) + dz * 0.42);
      aimArrow.rotation.y = Math.atan2(-dz, dx);
      aimArrow.scale.set(len, 1, 0.56);
      aimMat.uniforms.uLen.value = len; aimMat.uniforms.uTime.value = t;
      aimMat.uniforms.uColor.value.setHex(perfect ? 0xffd34d : ct > C.PERF_END ? 0x8a90a0 : view.localLob ? 0x7fdcff : 0xffffff);
    }
    cursor.visible = !!(view.cursor && live);
    if (cursor.visible) { cursor.position.set(wx(view.cursor[0]), 0.02, wz(view.cursor[1])); curMat.uniforms.uTime.value = t; }

    if (W && W.ball) {
      let bx = wx(W.ball[0]), bz = wz(W.ball[1]), bh = (W.ball[3] || 0) * S;
      ball.visible = true;
      const by = BALL_R + bh;
      if (simBall && Math.hypot(bx - simBall.x, bz - simBall.z) < 2 && dt > 0) {
        ballInfo.vx = damp(ballInfo.vx, (bx - simBall.x) / dt, 20, dt); ballInfo.vz = damp(ballInfo.vz, (bz - simBall.z) / dt, 20, dt); ballInfo.vy = damp(ballInfo.vy, (by - ballInfo.y) / dt, 20, dt);
      } else { ballInfo.vx = ballInfo.vy = ballInfo.vz = 0; }
      ballInfo.x = bx; ballInfo.y = by; ballInfo.z = bz; ballLive = true;
      if (!simBall) simBall = { x: bx, z: bz }; else { simBall.x = bx; simBall.z = bz; }
      // in a goal, the net's solve owns the ball (it bulges the netting and drops into the bag)
      let held = null;
      for (const g of goals) { const r = g.step(dt, ballInfo); if (r) held = r; }
      if (held) { bx = held.x; bz = held.z; bh = Math.max(0, held.y - BALL_R); }
      if (lastBall && Math.hypot(bx - lastBall.x, bz - lastBall.z) < 2) {
        const dx = bx - lastBall.x, dz = bz - lastBall.z, dist = Math.hypot(dx, dz);
        if (dt > 0) ballSpd = damp(ballSpd, dist / dt, 12, dt);
        if (dist > 1e-5) { v3.set(dz, 0, -dx).normalize(); ball.quaternion.premultiply(tmpQ.setFromAxisAngle(v3, dist / BALL_R * (bh > 0.05 ? 0.5 : 1))); }
        if (W.ball[2]) ballHot = 1;
      } else { trailPts.length = 0; ballSpd = 0; }
      if (!lastBall) lastBall = { x: bx, z: bz }; else { lastBall.x = bx; lastBall.z = bz; }
      ball.position.set(bx, BALL_R + bh, bz);
      ballSquash = Math.max(0, ballSquash - dt * 7);
      const q = ballSquash * ballSquash; ball.scale.set(1 + 0.3 * q, 1 - 0.3 * q, 1 + 0.3 * q);
      // the shadow stays on the grass and spreads/fades as the ball rises: this is what sells height
      ballBlob.position.set(bx, 0.013, bz); ballBlob.visible = true;
      const hs = 1 + bh * 0.9; ballBlob.scale.set(hs, 1, hs); ballBlob.material.opacity = 0.38 / (1 + bh * 1.6);
      if (!W.ball[2]) ballHot = Math.max(0, ballHot - dt * 3);
      ballMat.emissiveIntensity = ballHot * (3.2 + Math.sin(t * 30) * 0.6);
      ballLight.position.set(bx, 0.6 + bh, bz); ballLight.intensity = ballHot * 6;
      // trail: a short streak behind a fast ball. Driven by the ball's real speed and by how old each
      // sample is, so it shrinks away as the ball slows and is gone when the ball is still.
      if (!trailPts.length || Math.hypot(bx - trailPts[0].x, bz - trailPts[0].z) > 0.03) {
        const pt = trailPts.length >= TRAIL ? trailPts.pop() : {}; pt.x = bx; pt.z = bz; pt.h = bh; pt.t = now; trailPts.unshift(pt);
      }
      const show = clamp((ballSpd - 5) / 7, 0, 1) * (ballHot > 0.1 ? 0.85 : 0.3);
      trailMat.uniforms.color.value.setHex(ballHot > 0.1 ? 0xffc02e : 0xffffff);
      const n = trailPts.length;
      for (let i = 0; i < TRAIL; i++) {
        const a = trailPts[Math.min(i, n - 1)], b = trailPts[Math.min(i + 1, n - 1)];
        let nx = -(b.z - a.z), nz = b.x - a.x; const l = Math.hypot(nx, nz); if (l > 1e-6) { nx /= l; nz /= l; } else { nx = 0; nz = 0; }
        const f = 1 - i / TRAIL, wdt = BALL_R * 0.75 * f, o = i * 6;
        const th = BALL_R + (a.h || 0);
        trailPos[o] = a.x + nx * wdt; trailPos[o + 1] = th; trailPos[o + 2] = a.z + nz * wdt;
        trailPos[o + 3] = a.x - nx * wdt; trailPos[o + 4] = th; trailPos[o + 5] = a.z - nz * wdt;
        const age = clamp(1 - (now - a.t) / 0.22, 0, 1);
        trailA[i * 2] = trailA[i * 2 + 1] = i < n - 1 ? f * age * show : 0;
      }
      trailGeo.attributes.position.needsUpdate = true; trailGeo.attributes.aA.needsUpdate = true;
      trail.visible = !view.noTrail;
      const near = Math.max(0, 1 - (HW - Math.abs(bx)) / 5) * (Math.abs(bz) < 4 ? 1 : 0.4);
      hype = Math.max(hype * Math.exp(-dt * 0.8), near * 0.45);
    } else { ball.visible = false; ballBlob.visible = false; trail.visible = false; ballLight.intensity = 0; ballLive = false; simBall = null; for (const g of goals) g.step(dt, null); }

    const m2 = performance.now();
    hypeR *= Math.exp(-dt * 0.45); hypeB *= Math.exp(-dt * 0.45);
    // kick-off: in the pre-match intro the floodlights come on bank by bank, then the roof ring
    const power = view.mode === 'intro' ? clamp(view.introT ?? 1, 0, 1) : 1;
    for (let i = 0; i < 4; i++) bankOn[i] = power >= 1 ? 1 : clamp((power - (0.08 + i * 0.14)) / 0.05, 0, 1) * (power < 0.08 + i * 0.14 + 0.08 ? 0.6 + 0.4 * (Math.random() < 0.5 ? 1 : 0) : 1);
    light.setFlood(stadium.update(dt, t, hype * 0.6, hypeR, hypeB, power) * (0.12 + 0.88 * Math.min(1, power / 0.66)), bankOn);
    view.hype = hype;

    for (const w of waves) {
      if (!w.m.visible) continue;
      w.t += dt; const u = w.t / w.dur;
      if (u >= 1) { w.m.visible = false; continue; }
      const s3 = 0.2 + (w.max - 0.2) * (1 - (1 - u) * (1 - u)); w.m.scale.set(s3, 1, s3); w.m.material.opacity = (1 - u) * 0.8;
    }
    parts.update(dt, t);
    for (const tx of boardTexs) tx.offset.x = (tx.offset.x + dt * 0.035) % 1;
    light.update(dt, t);

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

    const m3 = performance.now();
    const q = gpu.begin();
    light.render();
    gpu.end(q);
    const m4 = performance.now();
    // where this frame's main-thread time went (ms), for the performance monitor
    Object.assign(cost, { players: m1 - m0, ball: m2 - m1, world: m3 - m2, submit: m4 - m3, total: m4 - m0, calls: renderer.info.render.calls, tris: renderer.info.render.triangles });
  }
  const cost = { players: 0, ball: 0, world: 0, submit: 0, total: 0, calls: 0, tris: 0 };
  // GPU time per frame, where the browser exposes a GPU timer (EXT_disjoint_timer_query_webgl2):
  // queries are read back frames later, never waited on
  const gpu = (() => {
    const gl = renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'), pending = [];
    let ms = null;
    if (!ext) return { begin: () => null, end() { }, poll() { }, get ms() { return null; } };
    return {
      begin() { if (pending.length > 5) return null; const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); return q; },
      end(q) { if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(q); } },
      poll() {
        while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
          const q = pending.shift(), bad = gl.getParameter(ext.GPU_DISJOINT_EXT), ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
          gl.deleteQuery(q); if (!bad) ms = ns / 1e6;
        }
      },
      get ms() { return ms; },
    };
  })();

  function snapCamera() { camPos.set(0, 0, fitZ).addScaledVector(camDir, fitD); camTgt.set(0, 0, fitZ); }

  // ---- players: their models were downloading while the stadium was built above
  const A = await loadPlayerAssets(renderer, boot, { extraSteps: players.length, lite });
  const PS = boot.stage('players');
  for (const [i, P] of players.entries()) {
    PS.note(`Rigging player ${i + 1} of ${players.length}`);
    await boot.yield();
    P.h.init(A); P.h.setEnvironment(light.env); PS.step(1);
  }
  PS.end('Done');

  applySRGBMode(scene, srgb.mode);

  // the view at its real size, so the targets compiled and drawn into below are the ones play uses
  const box = canvas.getBoundingClientRect();
  resize(Math.max(1, box.width || innerWidth), Math.max(1, box.height || innerHeight));
  snapCamera(); camera.position.copy(camPos); camera.lookAt(camTgt);

  // ---- every GPU program the game can ever use, compiled now. Everything that can be drawn is made
  // visible for this (the ball before kick-off, the hair styles nobody is wearing, both players, the
  // effects), so no program and no texture is left for the moment something first appears mid-game.
  // Lights keep their state: the number of lights is part of every program, and it never changes.
  const shown = [];
  scene.traverse(o => { if (!o.isLight) { shown.push([o, o.visible, o.frustumCulled]); o.visible = true; o.frustumCulled = false; } });
  const SH = boot.stage('shaders');
  await compilePrograms(renderer, renderer.compile(scene, camera), SH);

  // ---- one full frame of the whole scene through the whole chain: shadow maps (their depth
  // programs), ambient occlusion and bloom (their passes), and every texture uploaded to the GPU.
  // gl.finish() waits until the GPU has really done it, so it is behind us, not in the first frame.
  const WS = boot.stage('warm').begin(1, 'frame', 'Shadows, occlusion, bloom, every texture');
  await boot.yield();
  // the whole post chain, whatever level this device settled on last time: stepping back up to it
  // later must never compile anything mid-game
  light.setLevel(2);
  light.render();
  renderer.getContext().finish();
  light.setLevel(level);
  // programs created by that frame (shadow depth, post passes) are finished too
  await compilePrograms(renderer, renderer.info.programs, null);
  for (const [o, v, f] of shown) { o.visible = v; o.frustumCulled = f; }

  // ---- self-test: the pitch must come out lit. Some phone GPUs draw every floodlit surface black
  // (the pitch, the players) while self-lit things (crowd, stands) look fine: the shadow maps read
  // as "everything in shadow", or the lighting itself fails. It is measured here from real pixels
  // on the pitch, not assumed from the GPU's name, and repaired: without shadow maps if that
  // brings the light back, else the caller steps down a tier. Either way it's remembered per device.
  const gl = renderer.getContext(), DARK = 24, px = new Uint8Array(4);
  const pitchLight = () => {
    light.render(); renderer.setRenderTarget(null);
    const c = renderer.domElement, out = [];
    for (const [x, z] of [[-4, -1.5], [4, -1.5], [-4, 1.5], [4, 1.5], [0, 2.5]]) {
      v3.set(x, 0, z).project(camera);
      const sx = Math.round((v3.x + 1) / 2 * c.width), sy = Math.round((v3.y + 1) / 2 * c.height);
      if (sx < 0 || sy < 0 || sx >= c.width || sy >= c.height) continue;
      gl.readPixels(sx, sy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      out.push([px[0], px[1], px[2]]);
    }
    return { green: Math.max(0, ...out.map(p => p[1])), samples: out };
  };
  const selfTest = {
    tier, shadows: renderer.shadowMap.enabled, srgb, base: pitchLight(), fix: null,
    gl: {
      precision: renderer.capabilities.precision, maxTexture: renderer.capabilities.maxTextureSize, maxSamples: renderer.capabilities.maxSamples,
      parallelCompile: !!renderer.extensions.get('KHR_parallel_shader_compile'), floatRT: !!renderer.extensions.get('EXT_color_buffer_float'),
      programs: renderer.info.programs.length, size: [renderer.domElement.width, renderer.domElement.height],
    },
  };
  if (selfTest.base.green < DARK) {
    if (renderer.shadowMap.enabled) {
      WS.note('Checking the lighting on this device');
      renderer.shadowMap.enabled = false;
      scene.traverse(o => { const m = o.material; if (m) for (const x of Array.isArray(m) ? m : [m]) x.needsUpdate = true; });
      await compilePrograms(renderer, renderer.compile(scene, camera), null);
      selfTest.noShadow = pitchLight();
      selfTest.fix = selfTest.noShadow.green >= DARK ? 'noshadow' : 'tier';
    } else selfTest.fix = 'tier';
  }
  WS.end('Done');

  return {
    frame, resize, project, pickGround, fx, setQuality, snapCamera, setSafeBottom, setBudget, selfTest,
    get quality() { return quality; }, get level() { return level; }, get struggling() { return struggleT > 6; },
    // this frame's costs and the settings producing them (see the performance monitor in client.js)
    stats: () => ({ ...cost, gpu: gpu.ms, w: renderer.domElement.width, h: renderer.domElement.height, scale, level, tier, pr: renderer.getPixelRatio() }),
    debugScene: () => scene,
    debugCam: () => ({ perf: { tier, scale: +scale.toFixed(2), level, ft: +ftAvg.toFixed(1) }, fitD, fitDFull, camDist, visHalf, fitZ, cssW, cssH, aspect: camera.aspect, cam: camera.position.toArray().map(v => +v.toFixed(2)), tgt: camTgt.toArray().map(v => +v.toFixed(2)) }),
  };
}
