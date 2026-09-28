// Office Ball — stadium lighting. A night match under LED floodlights, built the way a broadcast
// venue is lit: the ring of lamps along the roof fronts (and the TV gantry) is the light, each part of
// it a real spotlight where it hangs, so every player stands in a soft fan of shadows; image-based lighting from a model of the bowl itself, so kits,
// paint and the ball reflect the actual floodlights; a night sky glowing with the stadium's own
// scatter; and a broadcast camera's post chain (HDR, ambient
// occlusion, bloom, anamorphic streaks from the lamps, filmic tone mapping, a restrained grade).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// 5700 K LED: a clean, very slightly cool white
export const FLOOD_COLOR = new THREE.Color(0xf3f6ff);
const tex = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; };

// ---------------------------------------------------------------- sky
const skyVert = `varying vec3 vDir; void main(){ vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
const skyFrag = `
varying vec3 vDir; uniform float uTime;
float h21(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
void main(){
  vec3 d = normalize(vDir); float y = d.y;
  // night sky: deep navy overhead, lifting toward the horizon where the city's light pollution
  // warms it; above the bowl the floodlights' own scatter makes a soft cool glow
  vec3 zenith = vec3(0.004, 0.007, 0.018), mid = vec3(0.012, 0.02, 0.05), hor = vec3(0.05, 0.05, 0.075);
  vec3 c = mix(hor, mid, smoothstep(0.0, 0.25, y)); c = mix(c, zenith, smoothstep(0.25, 0.9, y));
  c += vec3(0.09, 0.06, 0.045) * exp(-max(y, 0.0) * 14.0) * 0.6;             // warm horizon band
  c += vec3(0.05, 0.065, 0.09) * exp(-max(y, 0.0) * 3.5) * 0.55;             // stadium scatter haze
  // faint high cloud catching the light
  float n = h21(floor(d.xz / max(y, 0.08) * 3.0)) * 0.5 + h21(floor(d.xz / max(y, 0.08) * 7.0)) * 0.5;
  c += vec3(0.015, 0.018, 0.025) * smoothstep(0.55, 1.0, n) * smoothstep(0.05, 0.4, y) * (1.0 - smoothstep(0.5, 0.9, y));
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------- image-based lighting
// A small model of the bowl as the players see it (dark sky, lit stands ringing the pitch, four
// blazing banks of floodlights, the bright grass below), prefiltered for PBR reflections.
function buildEnvironment(renderer, dims, size = 256) {
  const env = new THREE.Scene();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(90, 32, 16), new THREE.ShaderMaterial({ vertexShader: skyVert, fragmentShader: skyFrag, uniforms: { uTime: { value: 0 } }, side: THREE.BackSide, depthWrite: false }));
  env.add(sky);
  // stands: a ring of dim, speckled colour (the crowd under spill light)
  const standTex = tex(1024, 128, (g, w, h) => {
    g.fillStyle = '#10141d'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 3500; i++) { g.fillStyle = `hsl(${Math.random() * 360},${30 + Math.random() * 40}%,${18 + Math.random() * 35}%)`; g.fillRect(Math.random() * w, 20 + Math.random() * (h - 40), 2, 3); }
    g.fillStyle = '#9fb7ff'; g.fillRect(0, 14, w, 2); // roof-edge light strip
  });
  standTex.wrapS = THREE.RepeatWrapping;
  const stands = new THREE.Mesh(new THREE.CylinderGeometry(26, 20, 12, 64, 1, true), new THREE.MeshBasicMaterial({ map: standTex, side: THREE.BackSide, color: new THREE.Color(0.55, 0.55, 0.6) }));
  stands.position.y = 5; env.add(stands);
  // the pitch: lit grass, brighter than anything but the lamps
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(dims.PW + 8, dims.PH + 8).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 0.26, 0.09).multiplyScalar(1.3) }));
  env.add(grass);
  const around = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.012, 0.016, 0.02) }));
  around.position.y = -0.05; env.add(around);
  // the lights: the ring along the roof fronts and the gantry behind the cameras, the brightest
  // things in the sky and what gives every highlight its shape (a ring of light across a kit or ball)
  const ringMat = new THREE.MeshBasicMaterial({ color: FLOOD_COLOR.clone().multiplyScalar(22), side: THREE.DoubleSide });
  const far = new THREE.Mesh(new THREE.PlaneGeometry(dims.PW + 11, 0.5), ringMat); far.position.set(0, 10.7, -(dims.HH + 3.7)); env.add(far);
  for (const s of [-1, 1]) { const e = new THREE.Mesh(new THREE.PlaneGeometry(dims.PH + 10, 0.5), ringMat); e.rotation.y = Math.PI / 2; e.position.set(s * (dims.HW + 3.9), 9.5, 0); env.add(e); }
  const gantry = new THREE.Mesh(new THREE.PlaneGeometry(16, 0.8), ringMat); gantry.position.set(0, 17, dims.HH + 12); env.add(gantry);
  // LED advertising boards: a bright band at pitch level
  const boardMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 0.9, 1.0).multiplyScalar(1.4) });
  for (const s of [-1, 1]) {
    const b1 = new THREE.Mesh(new THREE.PlaneGeometry(dims.PW, 0.26), boardMat); b1.position.set(0, 0.13, s * (dims.HH + 0.05)); b1.lookAt(0, 0.13, 0); env.add(b1);
  }
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(env, 0, 0.1, 200, { size, position: new THREE.Vector3(0, 1.2, 0) });
  pm.dispose();
  env.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  standTex.dispose();
  return rt.texture;
}

// ---------------------------------------------------------------- post: anamorphic streaks
// The long horizontal flare a broadcast lens throws off a floodlight: the brightest parts of the
// frame, blurred far along x (three passes of growing reach), tinted cool and added back.
class StreakPass extends Pass {
  constructor() {
    super();
    const rt = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.a = rt(); this.b = rt(); this.strength = 0.22; this.threshold = 3.0;
    this.bright = new THREE.ShaderMaterial({ uniforms: { tDiffuse: { value: null }, uTh: { value: 3 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D tDiffuse; uniform float uTh; varying vec2 vUv; void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb; float l = max(max(c.r, c.g), c.b); gl_FragColor = vec4(c * max(0.0, l - uTh) / max(l, 1e-4), 1.0); }' });
    this.blur = new THREE.ShaderMaterial({ uniforms: { tDiffuse: { value: null }, uStep: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse; uniform float uStep; varying vec2 vUv;
        void main(){ vec3 s = vec3(0.0); float wt = 0.0;
          for (int i = -6; i <= 6; i++) { float f = float(i); float w = exp(-f * f / 18.0); s += texture2D(tDiffuse, vUv + vec2(f * uStep, 0.0)).rgb * w; wt += w; }
          gl_FragColor = vec4(s / wt, 1.0); }` });
    this.q = new FullScreenQuad(null);
    this.needsSwap = false; // it only fills its own small targets; the finish pass adds the result
  }
  get texture() { return this.out ? this.out.texture : null; }
  setSize(w, h) { const W = Math.max(1, Math.round(w / 4)), H = Math.max(1, Math.round(h / 4)); this.a.setSize(W, H); this.b.setSize(W, H); this.px = 1 / W; }
  render(renderer, writeBuffer, readBuffer) {
    this.bright.uniforms.tDiffuse.value = readBuffer.texture; this.bright.uniforms.uTh.value = this.threshold;
    this.q.material = this.bright; renderer.setRenderTarget(this.a); this.q.render(renderer);
    let src = this.a, dst = this.b;
    for (const reach of [1, 5, 22]) {
      this.blur.uniforms.tDiffuse.value = src.texture; this.blur.uniforms.uStep.value = this.px * reach;
      this.q.material = this.blur; renderer.setRenderTarget(dst); this.q.render(renderer); [src, dst] = [dst, src];
    }
    this.out = src;
  }
  dispose() { this.a.dispose(); this.b.dispose(); this.q.dispose(); }
}

// ---------------------------------------------------------------- post: bloom
// three's bloom, minus its last step: instead of a full-resolution pass blending the glow onto the
// frame, the glow (its half-resolution composite) is added in the finish pass below. Same image,
// one full-screen pass fewer. (Mirrors UnrealBloomPass.render of the pinned three version.)
class BloomPass extends UnrealBloomPass {
  get texture() { return this.renderTargetsHorizontal[0].texture; }
  render(renderer, writeBuffer, readBuffer) {
    renderer.getClearColor(this._oldClearColor); this._oldClearAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear; renderer.autoClear = false; renderer.setClearColor(this.clearColor, 0);
    this.highPassUniforms.tDiffuse.value = readBuffer.texture; this.highPassUniforms.luminosityThreshold.value = this.threshold;
    this._fsQuad.material = this.materialHighPassFilter; renderer.setRenderTarget(this.renderTargetBright); renderer.clear(); this._fsQuad.render(renderer);
    let input = this.renderTargetBright;
    for (let i = 0; i < this.nMips; i++) {
      const m = this.separableBlurMaterials[i]; this._fsQuad.material = m;
      m.uniforms.colorTexture.value = input.texture; m.uniforms.direction.value = UnrealBloomPass.BlurDirectionX;
      renderer.setRenderTarget(this.renderTargetsHorizontal[i]); renderer.clear(); this._fsQuad.render(renderer);
      m.uniforms.colorTexture.value = this.renderTargetsHorizontal[i].texture; m.uniforms.direction.value = UnrealBloomPass.BlurDirectionY;
      renderer.setRenderTarget(this.renderTargetsVertical[i]); renderer.clear(); this._fsQuad.render(renderer);
      input = this.renderTargetsVertical[i];
    }
    const c = this.compositeMaterial; this._fsQuad.material = c;
    c.uniforms.bloomStrength.value = this.strength; c.uniforms.bloomRadius.value = this.radius; c.uniforms.bloomTintColors.value = this.bloomTintColors;
    renderer.setRenderTarget(this.renderTargetsHorizontal[0]); renderer.clear(); this._fsQuad.render(renderer);
    renderer.setClearColor(this._oldClearColor, this._oldClearAlpha); renderer.autoClear = oldAutoClear;
  }
}

// ---------------------------------------------------------------- post: finish (tone map + broadcast grade)
// The grade is display-referred, after tone mapping: a gentle S-curve, a touch more colour, cool shadows and
// warm highlights (the classic floodlit-night split), lens fringing and falloff toward the frame's
// edges, and a fine, moving grain so gradients never band.
// The finish pass: everything after the scene's own passes, in one full-screen pass straight to the
// canvas: HDR frame + bloom + lamp streaks -> ACES tone mapping -> sRGB -> the grade described above. This used
// to be four full-resolution passes (bloom blend, streak composite, tone map, grade); the maths is
// the same, so the picture is the same, and a phone's GPU has three fewer screens of pixels to move
// through memory every frame. (The fringing samples the frame three times, as the grade did.)
class FinishPass extends Pass {
  constructor(bloom, streak) {
    super();
    this.bloom = bloom; this.streak = streak;
    this.uniforms = {
      tDiffuse: { value: null }, tBloom: { value: null }, tStreak: { value: null }, uBloom: { value: 1 }, uStreak: { value: 0.22 },
      uTint: { value: new THREE.Color(0.55, 0.72, 1.0) }, toneMappingExposure: { value: 1 },
      uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uContrast: { value: 0.16 }, uSat: { value: 1.1 }, uVig: { value: 0.3 }, uGrain: { value: 0.022 }, uCA: { value: 0.0007 },
    };
    this.material = new THREE.RawShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `precision highp float; attribute vec3 position; attribute vec2 uv; varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
        precision highp float;
        uniform sampler2D tDiffuse, tBloom, tStreak; uniform float uBloom, uStreak; uniform vec3 uTint;
        uniform float uTime, uContrast, uSat, uVig, uGrain, uCA; uniform vec2 uRes; varying vec2 vUv;
        #include <tonemapping_pars_fragment>
        #include <colorspace_pars_fragment>
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        vec3 display(vec2 uv){
          vec3 c = texture2D(tDiffuse, uv).rgb + texture2D(tBloom, uv).rgb * uBloom + texture2D(tStreak, uv).rgb * uTint * uStreak;
          return sRGBTransferOETF(vec4(ACESFilmicToneMapping(c), 1.0)).rgb;
        }
        void main(){
          vec2 d = vUv - 0.5; float r2 = dot(d, d);
          vec2 o = d * uCA * (1.0 + 6.0 * r2);
          vec3 c = uCA > 0.0 ? vec3(display(vUv + o).r, display(vUv).g, display(vUv - o).b) : display(vUv);
          c = clamp(c, 0.0, 1.0);
          c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c = mix(vec3(l), c, uSat);
          c += vec3(-0.012, 0.004, 0.022) * (1.0 - smoothstep(0.0, 0.45, l));   // cool shadows
          c += vec3(0.018, 0.008, -0.014) * smoothstep(0.55, 1.0, l);            // warm highlights
          c *= 1.0 - uVig * smoothstep(0.12, 0.62, r2 * (uRes.x / uRes.y) * 0.9);
          c += (h(vUv * uRes + fract(uTime * 7.31) * 91.7) - 0.5) * uGrain;
          gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.q = new FullScreenQuad(this.material);
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); this.black.needsUpdate = true;
  }
  render(renderer, writeBuffer, readBuffer) {
    const u = this.uniforms;
    u.tDiffuse.value = readBuffer.texture; u.toneMappingExposure.value = renderer.toneMappingExposure;
    const b = this.bloom && this.bloom.enabled ? this.bloom.texture : null, s = this.streak && this.streak.enabled ? this.streak.texture : null;
    u.tBloom.value = b || this.black; u.uBloom.value = b ? 1 : 0;
    u.tStreak.value = s || this.black; u.uStreak.value = s ? this.streak.strength : 0;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer); this.q.render(renderer);
  }
}


// ---------------------------------------------------------------- the rig
// dims: { HW, HH, PW, PH }; tier: 'high' | 'medium' | 'lite' (see graphics.js). Every tier is the same
// stadium under the same lights; lower tiers just spend less on it:
//   high    4 shadow-casting floodlights, IBL, HDR + MSAA, AO, bloom, lamp streaks, grade
//   medium  shadows from 2 of the 4 (opposite corners, so the X of shadows survives), no AO
//   lite    software rendering: no shadow maps (the renderer draws baked shadows), a small IBL,
//           no post chain at all; tone mapping happens in the materials
export function createLighting(renderer, scene, camera, dims, tier = 'high', shadowRes = 0) {
  const { HW, HH } = dims, hi = tier === 'high', lite = tier === 'lite';
  // ACES: a filmic shoulder for the lamps and bright kits, with the saturated, contrasty look of a
  // floodlit broadcast (AgX reads flatter and greyer on a night pitch)
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.52;
  renderer.shadowMap.enabled = !lite; renderer.shadowMap.type = THREE.PCFShadowMap;

  // sky and night air
  const sky = new THREE.Mesh(new THREE.SphereGeometry(160, lite ? 24 : 48, lite ? 12 : 24), new THREE.ShaderMaterial({ vertexShader: skyVert, fragmentShader: skyFrag, uniforms: { uTime: { value: 0 } }, side: THREE.BackSide, depthWrite: false, fog: false }));
  sky.renderOrder = -10; sky.frustumCulled = false; scene.add(sky);
  scene.background = null;
  scene.fog = new THREE.Fog(0x080d1c, 48, 135);

  // The floodlights are the lamps you can see: the ring along the roof fronts. Each bank of it is one
  // spotlight at its real position, aimed where it throws: two along the main stand's roof and two on
  // the TV gantry behind the cameras (as at a real ground, where the camera side is lit from its own
  // roof). Every bank casts its shadow, so a player stands in a fan of four soft grey shadows, each
  // filled in by the other three. No unshadowed fill lights: they would wash every shadow out.
  // Medium runs the two diagonal banks at double strength (same light, a clean two-way shadow).
  const mainZ = -(HH + 3.7);
  const rig = [
    { p: [-5.5, 10.7, mainZ], a: [-4.8, 0, -0.8], I: 560, shadow: 'hi' },   // main stand roof: the far half
    { p: [5.5, 10.7, mainZ], a: [4.8, 0, -0.8], I: 560, shadow: 'all' },
    { p: [-6.5, 17, HH + 12], a: [-5, 0, 0.8], I: 1600, shadow: 'all' },  // TV gantry (behind camera): the near half
    { p: [6.5, 17, HH + 12], a: [5, 0, 0.8], I: 1600, shadow: 'hi' },
  ].filter(L => hi || lite || L.shadow === 'all');
  const spots = rig.map(L => {
    const s = new THREE.SpotLight(FLOOD_COLOR, L.I * (tier === 'medium' ? 2 : 1), 0, 0.8, 0.7, 2); // candela, physically decaying
    s.position.set(...L.p); s.target.position.set(...L.a);
    s.castShadow = !lite && (L.shadow === 'all' || (hi && L.shadow === 'hi'));
    const res = shadowRes || (hi ? 2048 : 1024);
    s.shadow.mapSize.set(res, res);
    s.shadow.camera.near = 4; s.shadow.camera.far = 50; s.shadow.bias = -0.00015; s.shadow.normalBias = 0.03; s.shadow.radius = 5;
    // full-strength per lamp: with four banks lighting each spot, a shadow from one of them is a
    // soft grey (the other three fill it in), never black and never washed away
    s.shadow.intensity = 1;
    s.shadow.camera.layers.enable(1); // the players' kit shadow casters live there (human.js SHADOW_LAYER)
    if (!lite) scene.add(s, s.target);
    return s;
  });
  if (lite) {
    // software rendering: one broad key from the main roof, one from the gantry (same directions, a
    // fraction of the per-pixel cost)
    for (const [y, z, I] of [[11, mainZ, 1.8], [17, HH + 12, 2.2]]) { const d = new THREE.DirectionalLight(FLOOD_COLOR, I); d.position.set(0, y, z); scene.add(d); }
  }
  // what little the night sky gives, and grass bounce from below
  const hemi = new THREE.HemisphereLight(0x3a4d7a, 0x14220f, lite ? 0.55 : 0.22); scene.add(hemi);
  const liteKeys = []; scene.traverse(o => { if (o.isDirectionalLight) liteKeys.push(o); });
  // image-based lighting from the bowl itself
  const env = buildEnvironment(renderer, dims, lite ? 64 : 256);
  scene.environment = env; scene.environmentIntensity = 0.35;

  let composer = null, gtao = null, bloom = null, streak = null, grade = null;
  if (!lite) {
    // post chain: HDR with MSAA -> ambient occlusion -> bloom -> lamp streaks -> tone map -> grade
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: Math.min(4, renderer.capabilities.maxSamples || 0) });
    composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));
    if (hi) {
      gtao = new GTAOPass(scene, camera, 1, 1);
      gtao.output = GTAOPass.OUTPUT.Default; gtao.blendIntensity = 0.85;
      gtao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.6, thickness: 1.2, scale: 1.1, samples: 12, distanceFallOff: 1, screenSpaceRadius: false });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 8 });
      // AO is for solid surfaces only: three's pass hides points and lines, but sprites, decals,
      // light shafts, spill and the sky dome would otherwise be drawn into its depth/normal pass
      // and outline themselves against whatever is behind them; custom-shaded geometry (the crowd's
      // instanced cards) is flagged noAO, since the pass's own material would draw it un-instanced
      gtao._overrideVisibility = function () {
        const cache = this._visibilityCache;
        this.scene.traverse(o => {
          if (!o.visible) return;
          const m = o.material;
          if (o.isPoints || o.isLine || o.isLine2 || o.isSprite || o.userData.noAO || (m && (m.transparent || m.depthWrite === false))) { o.visible = false; cache.push(o); }
        });
      };
      composer.addPass(gtao);
    }
    bloom = new BloomPass(new THREE.Vector2(256, 256), 0.42, 0.55, 2.2);
    composer.addPass(bloom);
    streak = new StreakPass(); composer.addPass(streak);
    grade = new FinishPass(bloom, streak); composer.addPass(grade);
  }

  // level: how much of the post chain runs (dropped live if a machine can't hold its frame rate)
  let level = 2;
  function setLevel(l) {
    level = l;
    if (gtao) gtao.enabled = l >= 2;
    if (streak) streak.enabled = l >= 1;
    if (bloom) bloom.enabled = l >= 1;
    if (grade) { grade.uniforms.uGrain.value = l >= 1 ? 0.022 : 0.0; grade.uniforms.uCA.value = l >= 1 ? 0.0007 : 0; }
  }
  setLevel(2);
  function setSize(w, h, pr) {
    if (!composer) return;
    composer.setPixelRatio(pr); composer.setSize(w, h);
    bloom.resolution.set(w * pr / 2, h * pr / 2);
    grade.uniforms.uRes.value.set(w * pr, h * pr);
  }
  function update(dt, t) {
    sky.material.uniforms.uTime.value = t; sky.position.copy(camera.position);
    if (grade) grade.uniforms.uTime.value = t;
  }
  const render = composer ? () => composer.render() : () => renderer.render(scene, camera);
  // the kick-off power-up drives the floodlights (1 = normal)
  const baseSpot = spots.map(s => s.intensity), baseKey = liteKeys.map(d => d.intensity), baseHemi = hemi.intensity;
  // f: overall level; per (optional): a level for each tower, for the kick-off power-up
  function setFlood(f, per) {
    spots.forEach((s, i) => { s.intensity = baseSpot[i] * f * (per ? per[i] : 1); });
    liteKeys.forEach((d, i) => { d.intensity = baseKey[i] * f; });
    hemi.intensity = baseHemi * (0.5 + 0.5 * f);
  }
  return { render, setSize, setLevel, update, setFlood, env, tier };
}
