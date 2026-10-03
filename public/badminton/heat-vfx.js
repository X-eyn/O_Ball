import * as THREE from 'three';
import { smoothHeat, heatTier } from './heat-flow.mjs';
import { presentationUrl } from './presentation-assets.js';

// Heat reads as a stylised aura hugging the athlete, in two layers:
//  - halo: each athlete's silhouette is drawn into a small offscreen mask, blurred, and laid back
//    around the body as cel-banded flame (crisp orange -> gold -> cream bands, tongues rising).
//    Working on the silhouette keeps the outline clean on fingers, face and racket arm, where an
//    inflated mesh shell folds over itself.
//  - rim: a crisp toon rim light on the athlete's own skinned meshes, so the body itself glows.
//   WARM    a faint warm rim
//   HOT     rim + a thin halo
//   ON FIRE full halo with flame tongues licking upward, a brighter core
// Each tier-up gives one short "pop" so the change is felt, not just seen.
// The mask and blur only run while an aura is showing; nothing is allocated per frame.

const MASK_LAYER = 7;
const PARTS = new Set(['skin', 'hair', 'shirt', 'shorts', 'socks', 'boots']);
const RIM_PARTS = new Set(['skin', 'shirt', 'shorts', 'socks', 'boots']);

const MASK_VERTEX = `
  #include <common>
  #include <skinning_pars_vertex>
  varying float vZ;
  void main(){
    #include <skinbase_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
    vZ = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const MASK_FRAGMENT = `
  uniform vec2 uWho;
  varying float vZ;
  void main(){
    float d = clamp(vZ / 60.0, 0.0, 0.9999) * 255.0;
    gl_FragColor = vec4(uWho, floor(d) / 255.0, fract(d));
  }`;
const FULLSCREEN_VERTEX = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

// Separable 9-tap gaussian; each athlete's channel has its own reach (scaled to their size on screen).
const BLUR_FRAGMENT = `
  varying vec2 vUv; uniform sampler2D uMap; uniform vec2 uStepR, uStepG;
  vec2 tap(vec2 o){ return vec2(texture2D(uMap, vUv + uStepR * o.x).r, texture2D(uMap, vUv + uStepG * o.y).g); }
  void main(){
    vec2 s = texture2D(uMap, vUv).rg * 0.2270270;
    s += (tap(vec2(1.3846154)) + tap(vec2(-1.3846154))) * 0.3162162;
    s += (tap(vec2(3.2307692)) + tap(vec2(-3.2307692))) * 0.0702703;
    gl_FragColor = vec4(s, 0.0, 1.0);
  }`;

const NOISE2 = `
  float auraHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float auraNoise(vec2 p){
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(auraHash(i), auraHash(i + vec2(1, 0)), f.x), mix(auraHash(i + vec2(0, 1)), auraHash(i + vec2(1, 1)), f.x), f.y);
  }`;

// Everything is measured in each athlete's own height on screen (uScale), so the aura has the
// same proportions in the broadcast view and in a close-up. It is light, not paint: brightest
// against the body, falling off smoothly, hottest colour where it is brightest.
const HALO_FRAGMENT = `
  varying vec2 vUv;
  uniform sampler2D uMask, uBlur;
  uniform vec2 uStrength, uRise, uScale;
  uniform float uTime, uAspect, uWisp, uBands, uCover;
  uniform vec3 uCore, uMid, uOuter;
  ${NOISE2}
  float flame(vec2 p, float scale, float seed){
    vec2 q = p * scale + seed;
    return auraNoise(q * vec2(9.0, 2.6) - vec2(0.0, uTime * 1.6)) * 0.65 + auraNoise(q * vec2(20.0, 5.5) + 5.3 - vec2(0.0, uTime * 2.7)) * 0.35;
  }
  void main(){
    vec2 p = vec2(vUv.x * uAspect, vUv.y);
    vec2 inside = smoothstep(0.35, 0.75, texture2D(uMask, vUv).rg);
    // the blurred mask is ~0.5 at the silhouette: e is 1 at the body, 0 at the halo's reach
    vec2 e = clamp(texture2D(uBlur, vUv).rg * 2.0, 0.0, 1.0);
    float nr = flame(p, uScale.x, 0.0), ng = flame(p, uScale.y, 17.0);
    // wisps: the same glow sampled from below, so licks of it drift up off the shoulders and head
    vec2 w = clamp(vec2(texture2D(uBlur, vUv - vec2(0.0, uRise.x * nr)).r, texture2D(uBlur, vUv - vec2(0.0, uRise.y * ng)).g) * 2.0, 0.0, 1.0);
    vec2 n = vec2(nr, ng);
    vec2 body = max(e * (0.85 + 0.3 * n), w * (0.25 + 0.75 * n * n) * uWisp);
    vec2 glow = body * body * uStrength * (1.0 - inside);
    float G = max(glow.x, glow.y);
    if (G < 0.004) discard;
    // soft light: colour and opacity follow brightness
    vec3 softCol = mix(uOuter, uMid, smoothstep(0.15, 0.6, G));
    softCol = mix(softCol, uCore, smoothstep(0.7, 1.1, G));
    float softA = min(G, 1.2);
    // cel bands: flat orange / gold / pale steps with crisp edges
    float aa = fwidth(G) * 0.8 + 0.002;
    float o = smoothstep(0.12 - aa, 0.12 + aa, G), m = smoothstep(0.35 - aa, 0.35 + aa, G), c = smoothstep(0.75 - aa, 0.75 + aa, G);
    vec3 celCol = mix(mix(uOuter, uMid, m), uCore, c);
    float celA = o * (0.55 + 0.2 * m + 0.2 * c);
    vec3 col = mix(softCol, celCol, uBands);
    float a = mix(softA, celA, uBands);
    // uCover: 0 is pure emitted light, 1 paints over what is behind
    gl_FragColor = vec4(col * a, min(a * uCover, 0.95));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// Warm light spilling onto the court under a burning athlete: a soft additive pool, no real light
// (adding scene lights would recompile and re-cost every material in the hall).
const POOL_FRAGMENT = `
  varying vec2 vUv;
  uniform float uStrength, uTime;
  uniform vec3 uMid, uOuter;
  void main(){
    vec2 d = vUv - 0.5;
    float r = length(d) * 2.0;
    float flicker = 0.9 + 0.1 * sin(uTime * 7.0) * sin(uTime * 4.3 + 1.0);
    float a = pow(clamp(1.0 - r, 0.0, 1.0), 2.2) * uStrength * flicker;
    vec3 col = mix(uOuter, uMid, clamp(1.0 - r * 1.3, 0.0, 1.0));
    gl_FragColor = vec4(col, a); // additive: src * alpha + dst
    #include <colorspace_fragment>
  }`;

const RIM_VERTEX = `
  #include <common>
  #include <skinning_pars_vertex>
  uniform float uPush;
  varying vec3 vN, vW;
  void main(){
    #include <beginnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    vec4 world = modelMatrix * vec4(transformed, 1.0);
    vN = normalize(mat3(modelMatrix) * objectNormal);
    world.xyz += vN * uPush;
    vW = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;

// A crisp toon edge plus a soft fresnel bloom, shimmering slowly upward.
const RIM_FRAGMENT = `
  uniform vec3 uCore, uMid;
  uniform float uStrength, uTime, uSharp;
  varying vec3 vN, vW;
  void main(){
    vec3 V = normalize(cameraPosition - vW);
    float fres = 1.0 - clamp(dot(normalize(vN), V), 0.0, 1.0);
    float shimmer = 0.85 + 0.3 * sin(vW.y * 9.0 - uTime * 5.0 + vW.x * 4.0);
    float w = mix(0.32, 0.03, uSharp);
    float edge = smoothstep(0.74 - w, 0.74, fres * shimmer);
    float bloom = pow(fres, 2.5) * 0.6;
    vec3 col = mix(uMid, uCore, edge * 0.8);
    float a = (edge * 0.55 + bloom + 0.05) * uStrength;
    gl_FragColor = vec4(col * a, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// --- real fire: the Houdini flame flipbook (8x8 frames) on the athlete's bones -----------------
// Each flame is a vertical billboard anchored at a bone, playing the flipbook at its own offset,
// mirrored at random, and trailing behind the athlete's movement. The flipbook's grey smoke is
// discarded: its flame "heat" (opacity weighted by colour) is graded through the aura palette,
// so it burns orange -> gold -> white instead of washing the picture with milky haze.
const FLAME_VERTEX = `
  attribute vec3 aCenter, aLean;
  attribute vec2 aSize;
  attribute float aSeed, aAlpha;
  varying vec2 vUv;
  varying float vSeed, vAlpha, vAnchorZ;
  void main(){
    vUv = uv; vSeed = aSeed; vAlpha = aAlpha;
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 toCam = cameraPosition - aCenter;
    float dist = length(toCam); toCam /= dist;
    // the card is drawn 0.45 m nearer the camera (scaled to keep its size) so the body never cuts
    // it; whether it is hidden is decided softly in the fragment shader from the anchor's own depth
    float pull = min(0.45, dist * 0.5), keep = (dist - pull) / dist;
    float h = position.y, k = max(h, 0.0);
    vec3 shape = right * position.x * aSize.x + vec3(0.0, h * aSize.y, 0.0) + aLean * k * k * aSize.y;
    vec3 p = aCenter + toCam * pull + shape * keep;
    vAnchorZ = -(viewMatrix * vec4(aCenter + shape * vec3(1.0, 0.0, 1.0), 1.0)).z - 0.06;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }`;
const FLAME_FRAGMENT = `
  uniform sampler2D uMap, uMask;
  uniform float uTime, uGain;
  uniform vec2 uRes;
  uniform vec3 uCore, uMid, uOuter;
  varying vec2 vUv;
  varying float vSeed, vAlpha, vAnchorZ;
  vec4 frame(float f, vec2 uv){
    vec2 tile = vec2(mod(f, 8.0), 7.0 - floor(f / 8.0));
    return texture2D(uMap, (tile + clamp(uv, vec2(0.004), vec2(0.996))) / 8.0);
  }
  void main(){
    vec2 uv = vec2(vSeed > 0.5 ? 1.0 - vUv.x : vUv.x, vUv.y);
    float f = fract(uTime * (0.42 + 0.2 * vSeed) + vSeed * 7.31) * 64.0;
    float f0 = floor(f), f1 = mod(f0 + 1.0, 64.0);
    vec4 t = mix(frame(f0, uv), frame(f1, uv), f - f0);
    float hi = max(t.r, max(t.g, t.b)), lo = min(t.r, min(t.g, t.b));
    // flame, not smoke: keep what is saturated or bright, drop the grey plume
    float heat = t.a * smoothstep(0.08, 0.5, (hi - lo) * 1.4 + max(0.0, hi - 0.82) * 2.0);
    float edge = smoothstep(0.0, 0.12, vUv.x) * smoothstep(0.0, 0.12, 1.0 - vUv.x) * smoothstep(0.0, 0.08, vUv.y);
    heat *= edge * vAlpha;
    // the body stays readable: flames lick out of the silhouette and rise above it, only a trace
    // shows over the athlete
    vec4 m = texture2D(uMask, gl_FragCoord.xy / uRes);
    float body = max(m.r, m.g), bodyZ = (m.b + m.a / 255.0) * 60.0;
    // (a root clearly in front of the body, like a hand across the chest, still burns over it)
    heat *= 1.0 - body * 0.88 * smoothstep(-0.3, 0.0, vAnchorZ - bodyZ);
    vec3 col = mix(uOuter * 0.55, uOuter, smoothstep(0.0, 0.25, heat));
    col = mix(col, uMid, smoothstep(0.25, 0.6, heat));
    col = mix(col, uCore, smoothstep(0.65, 1.0, heat));
    gl_FragColor = vec4(col * heat * uGain, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
// Embers: small hot sparks shed by the flames, cooling as they rise and swirl.
const EMBER_VERTEX = `
  attribute float aLife, aSize;
  uniform float uPx;
  varying float vLife;
  void main(){
    vLife = aLife;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aLife > 0.0 ? aSize * uPx / max(0.2, -mv.z) : 0.0;
    gl_Position = projectionMatrix * mv;
  }`;
const EMBER_FRAGMENT = `
  uniform vec3 uCore, uMid, uOuter;
  uniform float uGain;
  varying float vLife;
  void main(){
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = smoothstep(1.0, 0.0, d); a *= a;
    float l = clamp(vLife, 0.0, 1.0);
    vec3 col = mix(uOuter, uMid, smoothstep(0.15, 0.55, l));
    col = mix(col, uCore, smoothstep(0.7, 1.0, l));
    gl_FragColor = vec4(col * a * smoothstep(0.0, 0.25, l) * uGain, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
// [bone, towards bone, at, flame height, shows from intensity, lift]: hands, feet and shoulders
// catch first (HOT), the whole body burns ON FIRE.
const EMITTERS = [
  ['spine_03', null, 0, 0.62, 0.05, 0.05], ['spine_02', null, 0, 0.58, 0.3, 0], ['neck_01', null, 0, 0.5, 0.25, 0.02],
  ['Head', null, 0, 0.46, 0.4, 0.12], ['pelvis', null, 0, 0.5, 0.45, 0],
  ['clavicle_l', 'upperarm_l', 0.6, 0.44, 0, 0.03], ['clavicle_r', 'upperarm_r', 0.6, 0.44, 0, 0.03],
  ['upperarm_l', 'lowerarm_l', 0.5, 0.36, 0.35, 0], ['upperarm_r', 'lowerarm_r', 0.5, 0.36, 0.35, 0],
  ['lowerarm_l', 'hand_l', 0.5, 0.32, 0.5, 0], ['lowerarm_r', 'hand_r', 0.5, 0.32, 0.5, 0],
  ['hand_l', null, 0, 0.28, 0, 0], ['hand_r', null, 0, 0.28, 0, 0],
  ['thigh_l', 'calf_l', 0.45, 0.38, 0.55, 0], ['thigh_r', 'calf_r', 0.45, 0.38, 0.55, 0],
  ['calf_l', 'foot_l', 0.5, 0.32, 0.65, 0], ['calf_r', 'foot_r', 0.5, 0.32, 0.65, 0],
  ['foot_l', null, 0, 0.28, 0.12, 0.02], ['foot_r', null, 0, 0.28, 0.12, 0.02],
];
const EMBERS = 180;

// The look, as plain numbers: the heat lab (/badminton/heat) edits these live and can copy them out.
export const HEAT_STYLE = {
  core: '#fff1c2', mid: '#ffad2b', outer: '#ff4a10',
  glow: 0.75,       // halo brightness
  thickness: 1,     // halo reach while HOT
  fireThickness: 1, // extra reach when ON FIRE
  wisps: 0.3,       // glow licks rising off the head and shoulders
  bands: 0,         // 0 soft light .. 1 flat cel bands
  cover: 0.32,      // 0 pure light .. 1 opaque paint
  rim: 1,           // body rim light
  rimSharp: 0.5,    // 0 soft fresnel .. 1 crisp toon line
  pool: 1,          // warm light on the floor
  speed: 1,         // flicker / flow speed
  breathe: 1,       // slow pulse
  flames: 1.25,     // real flipbook flames on the body
  flameSize: 1.25,  // their height
  embers: 1.5,      // sparks shed by the flames
};
export const HEAT_PRESETS = {
  'Ember glow': {},
  'Hero highlight': { core: '#ffffff', mid: '#ffd36a', outer: '#ff8a1f', glow: 1.1, thickness: 0.5, fireThickness: 0.5, wisps: 0, cover: 0.12, rim: 1.5, rimSharp: 0.85, pool: 0.5, breathe: 0.6, flames: 0.55, flameSize: 0.8, embers: 0.6 },
  'Smash aura': { core: '#fff6d8', mid: '#ffb000', outer: '#ff3d00', glow: 1.1, thickness: 0.9, wisps: 1.2, bands: 1, cover: 0.75, rim: 0.7, rimSharp: 1, speed: 1.4, flames: 0.5, embers: 1.2 },
  'Inferno': { glow: 0.9, thickness: 1.2, fireThickness: 1.5, wisps: 0.5, cover: 0.35, rim: 1.2, pool: 1.8, speed: 1.15, flames: 1.5, flameSize: 1.45, embers: 2.2 },
  'Blue flame': { core: '#eafcff', mid: '#43c6ff', outer: '#2457ff', glow: 0.85, wisps: 0.3, cover: 0.3, rim: 1.1, rimSharp: 0.6, flames: 1.1, embers: 1.2 },
  'Golden aura': { core: '#ffffff', mid: '#ffe45c', outer: '#ffb300', glow: 1.1, thickness: 1.1, wisps: 1.2, bands: 0.4, cover: 0.4, rim: 1.2, rimSharp: 0.8, speed: 1.5, flames: 0.8, flameSize: 1.2, embers: 1.6 },
};

export function createHeatVfx(scene, tier, renderer) {
  const style = { ...HEAT_STYLE };
  const lite = tier === 'lite';
  const palette = { uCore: { value: new THREE.Color(0xfff1c2) }, uMid: { value: new THREE.Color(0xffad2b) }, uOuter: { value: new THREE.Color(0xff4a10) } };
  let built = false, time = 0, flow = 0, active = false, haloOn = false;
  const levels = [0, 0], tiers = [0, 0], pulse = [0, 0];
  const auraShape = [{ reach: 0, rise: 0 }, { reach: 0, rise: 0 }]; // per athlete, in athlete heights
  const auras = [], disposables = [];

  // --- halo: offscreen mask + blur, composited by one fullscreen triangle pair -----------------
  const target = () => new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const maskRT = target(), blurA = target(), blurB = target();
  maskRT.depthBuffer = true; // the nearest body surface wins, for the flames' occlusion
  const blurMat = new THREE.ShaderMaterial({ uniforms: { uMap: { value: null }, uStepR: { value: new THREE.Vector2() }, uStepG: { value: new THREE.Vector2() } }, vertexShader: FULLSCREEN_VERTEX, fragmentShader: BLUR_FRAGMENT, depthTest: false, depthWrite: false });
  const blurScene = new THREE.Scene(), blurCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.PlaneGeometry(2, 2);
  const blurQuad = new THREE.Mesh(quad, blurMat); blurQuad.frustumCulled = false; blurScene.add(blurQuad);
  const haloU = { uMask: { value: maskRT.texture }, uBlur: { value: blurB.texture }, uStrength: { value: new THREE.Vector2() }, uRise: { value: new THREE.Vector2() }, uScale: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 }, uAspect: { value: 1 }, uWisp: { value: 1 }, uBands: { value: 0 }, uCover: { value: 0.32 }, ...palette };
  const haloMat = new THREE.ShaderMaterial({ uniforms: haloU, vertexShader: FULLSCREEN_VERTEX, fragmentShader: HALO_FRAGMENT, transparent: true, depthTest: false, depthWrite: false, premultipliedAlpha: true, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor });
  const halo = new THREE.Mesh(quad, haloMat);
  halo.frustumCulled = false; halo.renderOrder = 1000; halo.visible = false; halo.name = 'Heat aura halo';
  scene.add(halo);
  const poolGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const pools = [0, 1].map(() => {
    const u = { uStrength: { value: 0 }, uTime: { value: 0 }, uMid: palette.uMid, uOuter: palette.uOuter };
    const m = new THREE.Mesh(poolGeo, new THREE.ShaderMaterial({ uniforms: u, vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', fragmentShader: POOL_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    m.renderOrder = 2; m.visible = false; m.frustumCulled = false; scene.add(m); disposables.push(m.material);
    return { mesh: m, u };
  });
  disposables.push(poolGeo);
  // --- real flames on the bones (one instanced draw) and embers (one points draw) -------------
  let fireReady = false;
  const fireTex = new THREE.TextureLoader().load(presentationUrl('fire-flipbook.png'), () => { fireReady = true; });
  fireTex.colorSpace = THREE.SRGBColorSpace; fireTex.generateMipmaps = false;
  fireTex.minFilter = THREE.LinearFilter; fireTex.magFilter = THREE.LinearFilter;
  const NF = EMITTERS.length * 2;
  const flameBase = new THREE.PlaneGeometry(1, 1).translate(0, 0.3, 0); // the flame's root sits at the bone
  const fgeo = new THREE.InstancedBufferGeometry();
  fgeo.index = flameBase.index; fgeo.setAttribute('position', flameBase.attributes.position); fgeo.setAttribute('uv', flameBase.attributes.uv);
  const inst = (n, size) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(n * size), size); a.setUsage(THREE.DynamicDrawUsage); return a; };
  const fA = { aCenter: inst(NF, 3), aLean: inst(NF, 3), aSize: inst(NF, 2), aSeed: inst(NF, 1), aAlpha: inst(NF, 1) };
  for (const [k, a] of Object.entries(fA)) fgeo.setAttribute(k, a);
  for (let n = 0; n < NF; n++) fA.aSeed.array[n] = (n * 0.6180339 + 0.13) % 1;
  fgeo.instanceCount = NF;
  const jitter = Array.from({ length: NF }, (_, n) => [Math.sin(n * 12.9898) * 0.06, Math.sin(n * 4.1414) * 0.04, Math.cos(n * 7.233) * 0.06]);
  const flameU = { uMask: { value: maskRT.texture }, uRes: { value: new THREE.Vector2(1, 1) }, uMap: { value: fireTex }, uTime: { value: 0 }, uGain: { value: 1.6 }, uCore: palette.uCore, uMid: palette.uMid, uOuter: palette.uOuter };
  const flameMat = new THREE.ShaderMaterial({ uniforms: flameU, vertexShader: FLAME_VERTEX, fragmentShader: FLAME_FRAGMENT, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
  const flames = new THREE.Mesh(fgeo, flameMat);
  flames.frustumCulled = false; flames.renderOrder = 6; flames.visible = false; flames.name = 'Heat flames';
  flames.onBeforeRender = (r, sc, camera) => renderMask(r, sc, camera);
  scene.add(flames);
  const eGeo = new THREE.BufferGeometry();
  const eA = { position: new THREE.BufferAttribute(new Float32Array(EMBERS * 3), 3), aLife: new THREE.BufferAttribute(new Float32Array(EMBERS), 1), aSize: new THREE.BufferAttribute(new Float32Array(EMBERS), 1) };
  for (const [k, a] of Object.entries(eA)) { a.setUsage(THREE.DynamicDrawUsage); eGeo.setAttribute(k, a); }
  const eVel = new Float32Array(EMBERS * 3), eRate = new Float32Array(EMBERS), eSeed = Float32Array.from({ length: EMBERS }, (_, n) => (n * 0.7548776) % 1);
  const emberU = { uPx: { value: 500 }, uGain: { value: 2.2 }, uCore: palette.uCore, uMid: palette.uMid, uOuter: palette.uOuter };
  const embers = new THREE.Points(eGeo, new THREE.ShaderMaterial({ uniforms: emberU, vertexShader: EMBER_VERTEX, fragmentShader: EMBER_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor }));
  embers.frustumCulled = false; embers.renderOrder = 7; embers.visible = false; embers.name = 'Heat embers';
  scene.add(embers);
  let emberCursor = 0, embersAlive = 0;
  const spawnAcc = [0, 0], burst = [0, 0];
  disposables.push(fireTex, flameBase, fgeo, flameMat, eGeo, embers.material);
  const va = new THREE.Vector3(), vb = new THREE.Vector3();
  function spawnEmber(x, y, z, lean) {
    const n = emberCursor++ % EMBERS, q = n * 3, r = eSeed[n];
    eA.position.array[q] = x; eA.position.array[q + 1] = y; eA.position.array[q + 2] = z;
    const ang = Math.random() * Math.PI * 2, out = 0.25 + Math.random() * 0.45;
    eVel[q] = Math.cos(ang) * out - lean.x * 0.8; eVel[q + 1] = 0.7 + Math.random() * 1.3; eVel[q + 2] = Math.sin(ang) * out - lean.z * 0.8;
    eA.aLife.array[n] = 1; eRate[n] = 1 / (0.55 + Math.random() * 0.9); eA.aSize.array[n] = 0.012 + 0.022 * r * r;
  }

  const maskMats = [[1, 0], [0, 1]].map(who => new THREE.ShaderMaterial({ uniforms: { uWho: { value: new THREE.Vector2(...who) } }, vertexShader: MASK_VERTEX, fragmentShader: MASK_FRAGMENT, blending: THREE.NoBlending }));
  disposables.push(maskRT, blurA, blurB, blurMat, haloMat, quad, ...maskMats);

  const size = new THREE.Vector2(), clear = new THREE.Color(), foot = new THREE.Vector3(), head = new THREE.Vector3();
  const reach = [0.03, 0.03]; // glow reach per athlete, as a fraction of screen height
  // Drawn inside the main render, right before the halo itself, with the frame's own camera:
  // the mask is never a frame behind a moving camera. (Nested renders as three's Reflector does.)
  let maskDirty = false;
  function renderMask(r, sc, camera) {
    if (!r || !maskDirty) return;
    maskDirty = false;
    r.getDrawingBufferSize(size);
    flameU.uRes.value.copy(size);
    const scale = lite ? 0.35 : tier === 'high' ? 1 : 0.6; // the mask edge is the halo's inner edge: keep it sharp
    const mw = Math.max(1, Math.round(size.x * scale)), mh = Math.max(1, Math.round(size.y * scale));
    const bw = Math.max(1, mw >> 1), bh = Math.max(1, mh >> 1);
    if (maskRT.width !== mw || maskRT.height !== mh) maskRT.setSize(mw, mh);
    if (blurA.width !== bw || blurA.height !== bh) { blurA.setSize(bw, bh); blurB.setSize(bw, bh); }
    haloU.uAspect.value = size.x / Math.max(1, size.y);
    // each athlete's height on screen: the halo's thickness, tongues and grain follow it
    for (let i = 0; i < auras.length; i++) {
      auras[i].athlete.root.getWorldPosition(foot); head.copy(foot); head.y += 1.8;
      foot.project(camera); head.project(camera);
      const h = THREE.MathUtils.clamp(Math.abs(head.y - foot.y) / 2, 0.02, 1.5);
      reach[i] = h * auraShape[i].reach;
      haloU.uScale.value.setComponent(i, 1 / h);
      haloU.uRise.value.setComponent(i, h * auraShape[i].rise);
    }
    const prevTarget = r.getRenderTarget(), prevShadow = r.shadowMap.autoUpdate, prevAuto = r.info.autoReset;
    const prevAlpha = r.getClearAlpha(), prevLayers = camera.layers.mask, prevBg = sc.background;
    r.getClearColor(clear);
    r.shadowMap.autoUpdate = false; r.info.autoReset = false;
    r.setClearColor(0x000000, 0);
    const haloWas = halo.visible, flamesWere = flames.visible;
    sc.background = null; camera.layers.set(MASK_LAYER); halo.visible = flames.visible = false;
    r.setRenderTarget(maskRT); r.clear(); r.render(sc, camera);
    camera.layers.mask = prevLayers; sc.background = prevBg; halo.visible = haloWas; flames.visible = flamesWere;
    // blur H, V, H, V at half the mask's size; each channel reaches a set share of its athlete's height
    const blur = (map, out, horizontal, k) => {
      blurMat.uniforms.uMap.value = map.texture;
      for (let i = 0; i < 2; i++) {
        const px = reach[i] * bh * k; // texels for this pass
        blurMat.uniforms[i ? 'uStepG' : 'uStepR'].value.set(horizontal ? px / bw : 0, horizontal ? 0 : px / bh);
      }
      r.setRenderTarget(out); r.render(blurScene, blurCam);
    };
    blur(maskRT, blurA, true, 0.16); blur(blurA, blurB, false, 0.16);
    blur(blurB, blurA, true, 0.12); blur(blurA, blurB, false, 0.12);
    r.setClearColor(clear, prevAlpha); r.shadowMap.autoUpdate = prevShadow; r.info.autoReset = prevAuto;
    r.setRenderTarget(prevTarget);
    if (camera.viewport) r.state.viewport(camera.viewport);
  }
  halo.onBeforeRender = renderMask;

  // --- rim + mask meshes on the athletes' own skeletons ---------------------------------------
  function rimMaterial(u) {
    const m = new THREE.ShaderMaterial({ uniforms: { ...u, uCore: palette.uCore, uMid: palette.uMid }, vertexShader: RIM_VERTEX, fragmentShader: RIM_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
    disposables.push(m); return m;
  }
  function twin(src, material, layer) {
    const m = src.isSkinnedMesh ? new THREE.SkinnedMesh(src.geometry, material) : new THREE.Mesh(src.geometry, material);
    if (src.isSkinnedMesh) { m.bindMode = src.bindMode; m.bind(src.skeleton, src.bindMatrix); }
    // follow the source's own local matrix (some parts, like hair, are placed by hand, not by TRS)
    m.matrixAutoUpdate = false; m.matrix.copy(src.matrix);
    m.frustumCulled = false; m.castShadow = m.receiveShadow = false; m.visible = false; m.userData.heatAura = true; m.userData.source = src;
    if (layer !== undefined) m.layers.set(layer);
    src.parent.add(m); return m;
  }
  function build(players) {
    players.forEach((athlete, i) => {
      const part = new Map(Object.entries(athlete.h?.m || {}).map(([name, m]) => [m, name]));
      const rimU = { uPush: { value: 0.003 }, uTime: { value: 0 }, uStrength: { value: 0 }, uSharp: { value: 0.5 } };
      const rimMat = rimMaterial(rimU), rims = [], masks = [];
      const sources = [];
      athlete.root.traverse(o => { if (o.isMesh && !o.userData.heatAura && PARTS.has(part.get(o.material))) sources.push(o); });
      for (const src of sources) {
        masks.push(twin(src, maskMats[i], MASK_LAYER));
        if (src.isSkinnedMesh && RIM_PARTS.has(part.get(src.material))) { const m = twin(src, rimMat); m.renderOrder = 4; rims.push(m); }
      }
      const bone = athlete.h?.bone || {};
      const emit = EMITTERS.map(([a, b, at, height, from, lift]) => ({ A: bone[a], B: b ? bone[b] : null, at, height, from, lift, w: 0 }));
      auras.push({ athlete, rims, masks, rimU, emit, prev: athlete.root.position.clone(), vel: new THREE.Vector3(), lean: new THREE.Vector3() });
    });
    built = true;
  }

  function update(dt, heat, players, camera, visible) {
    if (!visible) { reset(); return; }
    if (!active && !(heat?.[0] > 0 || heat?.[1] > 0)) return;
    if (!built && players?.length) build(players);
    active = true;
    time += dt; flow += dt * style.speed;
    haloU.uTime.value = flow;
    haloU.uWisp.value = Math.min(style.wisps, 1.5); haloU.uBands.value = style.bands; haloU.uCover.value = style.cover;
    haloOn = false; let flamesOn = false;
    for (let i = 0; i < auras.length; i++) {
      const aura = auras[i];
      levels[i] = smoothHeat(levels[i], heat?.[i] || 0, dt);
      const before = tiers[i];
      tiers[i] = heatTier(levels[i], tiers[i]);
      if (tiers[i] > before && tiers[i] >= 1 && dt > 0) pulse[i] = 1;
      pulse[i] *= Math.exp(-dt / 0.25);
      const L = levels[i], pop = pulse[i];
      const rim = THREE.MathUtils.smoothstep(L, 25, 58);
      const glow = THREE.MathUtils.smoothstep(L, 45, 80);
      const fire = THREE.MathUtils.smoothstep(L, 82, 100);
      const breathe = 1 - 0.06 * style.breathe + 0.06 * style.breathe * Math.sin(time * 3.1 + i * 1.7);
      const shown = aura.athlete.root.visible;
      const haloStrength = shown ? (glow * (0.75 + 0.6 * fire) + pop * 0.8) * breathe * style.glow : 0;
      haloU.uStrength.value.setComponent(i, haloStrength);
      auraShape[i].reach = 0.045 * style.thickness + 0.03 * fire * style.fireThickness + 0.025 * pop;
      auraShape[i].rise = (lite ? 0.03 : 0.04 + 0.11 * fire + 0.04 * pop) * Math.max(style.wisps, 0.0001);
      aura.rimU.uTime.value = flow; aura.rimU.uSharp.value = style.rimSharp;
      aura.rimU.uStrength.value = (rim * (0.5 + 0.35 * glow + 0.3 * fire) + pop * 0.5) * breathe * style.rim;
      const pool = pools[i], pos = aura.athlete.root.position;
      pool.u.uTime.value = flow;
      pool.u.uStrength.value = shown ? (0.28 * glow + 0.4 * fire + 0.3 * pop) * breathe * style.pool : 0;
      pool.mesh.visible = pool.u.uStrength.value > 0.005;
      pool.mesh.position.set(pos.x, 0.012, pos.z); pool.mesh.scale.setScalar(1.6 + 0.4 * fire);
      const showRim = shown && aura.rimU.uStrength.value > 0.01, showMask = haloStrength > 0.01;
      // a twin shows only while its source part does (hidden kit pieces must not cast an aura)
      for (const m of aura.rims) { m.visible = showRim && m.userData.source.visible; if (m.visible) m.matrix.copy(m.userData.source.matrix); }
      haloOn ||= showMask;

      // real flames: hands, feet and shoulders catch while HOT, the whole body ON FIRE; a tier-up flares
      const at = aura.athlete.root.position;
      if (dt > 0) {
        aura.vel.lerp(va.copy(at).sub(aura.prev).divideScalar(dt), 1 - Math.exp(-dt * 8));
        aura.prev.copy(at);
        aura.lean.copy(aura.vel).multiplyScalar(-0.12); aura.lean.y = 0;
        if (aura.lean.length() > 0.55) aura.lean.setLength(0.55);
      }
      const hot = THREE.MathUtils.smoothstep(L, 58, 84);
      const I = shown ? Math.min(1, (0.38 * hot + 0.62 * fire + 0.6 * pop) * Math.min(style.flames, 1)) : 0;
      const gain = Math.max(0, style.flames);
      let burning = false;
      for (let k = 0; k < EMITTERS.length; k++) {
        const e = aura.emit[k], n = i * EMITTERS.length + k;
        if (!e.A) { fA.aAlpha.array[n] = 0; continue; }
        e.w = THREE.MathUtils.smoothstep(I, e.from, e.from + 0.3);
        e.A.getWorldPosition(va);
        if (e.B) va.lerp(e.B.getWorldPosition(vb), e.at);
        const j = jitter[n];
        fA.aCenter.setXYZ(n, va.x + j[0], va.y + j[1] + e.lift, va.z + j[2]);
        const hgt = e.height * style.flameSize * (0.55 + 0.45 * e.w) * (1 + 0.4 * pop) * breathe;
        fA.aSize.setXY(n, hgt * 0.55, hgt);
        fA.aLean.setXYZ(n, aura.lean.x, 0, aura.lean.z);
        fA.aAlpha.array[n] = e.w * gain;
        if (e.w > 0.01 && gain > 0) flamesOn = burning = true;
      }
      for (const m of aura.masks) { m.visible = (showMask || burning) && m.userData.source.visible; if (m.visible) m.matrix.copy(m.userData.source.matrix); }
      // embers: a steady shed while burning, a burst on each tier-up
      if (dt > 0 && style.embers > 0 && shown) {
        spawnAcc[i] += dt * style.embers * (6 * hot + 34 * fire);
        let count = Math.floor(spawnAcc[i]); spawnAcc[i] -= count;
        if (pop > 0.9 && !burst[i]) { burst[i] = 1; count += Math.round(40 * style.embers); }
        if (pop < 0.5) burst[i] = 0;
        const lit = aura.emit.filter(e => e.A && e.w > 0.2);
        for (let c = 0; c < count && lit.length; c++) {
          const e = lit[(Math.random() * lit.length) | 0];
          e.A.getWorldPosition(va); if (e.B) va.lerp(e.B.getWorldPosition(vb), e.at);
          spawnEmber(va.x + (Math.random() - 0.5) * 0.16, va.y + e.lift + Math.random() * e.height * 0.4, va.z + (Math.random() - 0.5) * 0.16, aura.lean);
        }
      }
    }
    halo.visible = haloOn && !!renderer;
    maskDirty = true;
    flames.visible = flamesOn && fireReady;
    flameU.uTime.value = flow;
    for (const k in fA) fA[k].needsUpdate = true;
    // ember motion: buoyant, swirling, cooling
    embersAlive = 0;
    for (let n = 0; n < EMBERS; n++) {
      if (eA.aLife.array[n] <= 0) continue;
      if (dt > 0) {
        const q = n * 3, r = eSeed[n] * 20;
        eA.aLife.array[n] -= dt * eRate[n];
        if (eA.aLife.array[n] <= 0) { eA.aLife.array[n] = 0; continue; }
        eVel[q] += Math.sin(flow * 2.3 + r) * 1.4 * dt; eVel[q + 1] += 0.6 * dt; eVel[q + 2] += Math.cos(flow * 1.9 + r * 1.3) * 1.4 * dt;
        const drag = Math.exp(-dt * 1.2);
        eVel[q] *= drag; eVel[q + 1] *= drag; eVel[q + 2] *= drag;
        eA.position.array[q] += eVel[q] * dt; eA.position.array[q + 1] += eVel[q + 1] * dt; eA.position.array[q + 2] += eVel[q + 2] * dt;
      }
      embersAlive++;
    }
    eA.position.needsUpdate = eA.aLife.needsUpdate = eA.aSize.needsUpdate = true;
    embers.visible = embersAlive > 0;
    if (camera?.isPerspectiveCamera && renderer) {
      renderer.getDrawingBufferSize(size);
      emberU.uPx.value = size.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    }
    if (levels.every(v => v < 0.05) && !(heat?.[0] > 0 || heat?.[1] > 0)) reset();
  }

  function reset() {
    if (!active) return;
    active = false; haloOn = false; levels.fill(0); tiers.fill(0); pulse.fill(0);
    halo.visible = false; flames.visible = false; embers.visible = false; eA.aLife.array.fill(0); embersAlive = 0; spawnAcc.fill(0); burst.fill(0);
    pools.forEach(p => { p.mesh.visible = false; });
    for (const aura of auras) for (const m of [...aura.rims, ...aura.masks]) m.visible = false;
  }

  function setStyle(next = {}) {
    Object.assign(style, next);
    palette.uCore.value.set(style.core); palette.uMid.value.set(style.mid); palette.uOuter.value.set(style.outer);
    return { ...style };
  }
  setStyle();

  return {
    update, reset, setStyle,
    getStyle: () => ({ ...style }),
    pop: i => { if (i in pulse) pulse[i] = 1; }, // the tier-up flash, on demand (the heat lab)
    stats: () => ({ fire: fireReady, flames: flames.visible, embers: embersAlive, ready: built, levels: levels.slice(), tiers: tiers.slice(), particles: 0, halo: halo.visible, meshes: auras.reduce((n, a) => n + a.rims.length + a.masks.length, 0) }),
    dispose() {
      scene.remove(halo); scene.remove(flames); scene.remove(embers); pools.forEach(p => scene.remove(p.mesh));
      for (const aura of auras) for (const m of [...aura.rims, ...aura.masks]) m.parent?.remove(m);
      disposables.forEach(d => d.dispose());
    },
  };
}
