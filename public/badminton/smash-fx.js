import * as THREE from 'three';

// Smashes, scaled by power (0..1, from speed and timing):
//  contact  a white-hot flash with an anamorphic streak, a shockwave ring bursting out of the
//           racket, the camera punched (the caller owns shake/zoom), speed lines on the big ones.
//           Nothing here covers the shuttle for long: the rally is still live.
//  slam     a smash that wins the point comes down on the court: the mat cracks around the spot
//           (glowing hot, then cooling to dark fissures), chips of it fly and bounce, a shockwave
//           runs across the floor.
//  glass    the hardest smashes (power 0.7+) crack the air at the racket: a small disc of the view
//           round the contact (~35-75 px, the HUD's contact ring with it) splinters into a few
//           see-through shards that fly out sideways, off the shot's line, and are gone in about a
//           third of a second. Kept small, faint and quick so the shuttle always stays readable.

const QUAD_VERTEX = `
  varying vec2 vUv;
  void main(){
    vUv = uv * 2.0 - 1.0;
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec2 sc = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
    mv.xy += position.xy * sc;
    gl_Position = projectionMatrix * mv;
  }`;
const FLASH_FRAGMENT = `
  varying vec2 vUv;
  uniform vec3 uColor;
  uniform float uT, uPow;
  void main(){
    vec2 p = vUv; float r = length(p);
    float life = 1.0 - uT;
    float core = exp(-r * r * (90.0 + 120.0 * uT)) * life * 1.3;
    float streak = exp(-abs(p.y) * 90.0) * exp(-abs(p.x) * (2.4 + 5.0 * uT)) * life * (0.45 + 0.8 * uPow);
    float star = (exp(-abs(p.x) * 70.0) * exp(-abs(p.y) * 7.0) + exp(-abs(p.x + p.y) * 50.0) * exp(-abs(p.x - p.y) * 9.0) * 0.5) * life;
    // the shockwave: a sharp bright front with a soft wake, racing outward
    float front = 0.15 + 0.85 * uT;
    float wave = exp(-pow((r - front) * 26.0, 2.0)) * (1.0 - uT) * (0.5 + 0.6 * uPow) + exp(-pow((r - front * 0.92) * 8.0, 2.0)) * (1.0 - uT) * 0.12;
    vec3 col = mix(uColor, vec3(1.0), 0.6) * (streak + star * 0.7 + wave) + vec3(1.0) * core;
    gl_FragColor = vec4(col, 0.0);
  }`;
const FLOOR_RING_FRAGMENT = `
  varying vec2 vUv;
  uniform vec3 uColor;
  uniform float uT;
  void main(){
    float r = length(vUv);
    float front = 0.1 + 0.9 * sqrt(uT);
    float wave = exp(-pow((r - front) * 14.0, 2.0)) + exp(-pow((r - front * 0.85) * 5.0, 2.0)) * 0.35;
    float a = wave * (1.0 - uT) * smoothstep(1.0, 0.9, r);
    gl_FragColor = vec4(uColor * a, 0.0);
  }`;
// The crack decal: dark fissures from a canvas, their edges glowing hot at first, then cooling.
const CRACK_FRAGMENT = `
  varying vec2 vUv2;
  uniform sampler2D uMap;
  uniform float uHeat, uFade;
  void main(){
    vec4 t = texture2D(uMap, vUv2);
    // r: the fissure (dark), g: its hot rim, b: chipped, scuffed mat around it
    vec3 hot = mix(vec3(1.0, 0.35, 0.05), vec3(1.0, 0.85, 0.5), t.g * uHeat);
    vec3 col = mix(vec3(0.03, 0.04, 0.035), hot * 2.2, t.g * uHeat);
    float a = max(t.r, t.b * 0.35) * uFade;
    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
  }`;

function crackTexture(seed) {
  const S = 1024, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  let s = seed >>> 0 || 1; const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'lighter';
  const C = S / 2;
  // the crater: chipped, scuffed mat in the middle (blue channel)
  const pit = g.createRadialGradient(C, C, 0, C, C, S * 0.16);
  pit.addColorStop(0, 'rgba(0,0,255,1)'); pit.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = pit; g.beginPath(); g.arc(C, C, S * 0.16, 0, Math.PI * 2); g.fill();
  // impact fracture: a few straight, angular radial fissures (kinking a little, forking rarely)
  // and broken concentric arcs between them, as a hit cracks glass or concrete. red: the crack,
  // green: its hot rim (wider), drawn widest at the centre and thinning outward
  const seg = (x0, y0, x1, y1, w) => {
    g.lineCap = 'round'; g.lineJoin = 'miter';
    g.strokeStyle = 'rgba(0,255,0,0.6)'; g.lineWidth = w * 3; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    g.strokeStyle = 'rgba(255,0,0,1)'; g.lineWidth = w; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  };
  const radial = (x, y, ang, len, w, depth) => {
    const steps = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < steps; i++) {
      ang += (rnd() - 0.5) * 0.45;                   // a kink at every joint, straight between
      const l = len / steps * (0.7 + rnd() * 0.6), nx = x + Math.cos(ang) * l, ny = y + Math.sin(ang) * l;
      const lw = Math.max(1.2, w * (1 - i / steps * 0.75));
      seg(x, y, nx, ny, lw);
      if (depth < 1 && rnd() < 0.3) radial(nx, ny, ang + (rnd() < 0.5 ? -1 : 1) * (0.45 + rnd() * 0.35), len * 0.4, lw * 0.6, depth + 1);
      x = nx; y = ny;
    }
  };
  const rays = 7 + Math.floor(rnd() * 4), angs = [];
  for (let i = 0; i < rays; i++) { const a = (i + (rnd() - 0.5) * 0.5) / rays * Math.PI * 2; angs.push(a); radial(C, C, a, S * (0.3 + rnd() * 0.16), 7 + rnd() * 5, 0); }
  // concentric breaks: chords between neighbouring rays, at two or three radii, not all closed
  for (const rr of [0.07, 0.15, 0.24]) for (let i = 0; i < rays; i++) {
    if (rnd() < 0.35) continue;
    const a0 = angs[i], a1 = angs[(i + 1) % rays] + (i === rays - 1 ? Math.PI * 2 : 0), r0 = S * rr * (0.85 + rnd() * 0.3), r1 = S * rr * (0.85 + rnd() * 0.3);
    seg(C + Math.cos(a0) * r0, C + Math.sin(a0) * r0, C + Math.cos(a1) * r1, C + Math.sin(a1) * r1, 2.5 + rnd() * 2.5);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.anisotropy = 4;
  return t;
}

export function createSmashFx({ scene, renderer, tier }) {
  const lite = tier === 'lite';
  const quad = new THREE.PlaneGeometry(2, 2);
  const blend = { transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor };

  // ---- contact flashes (pooled)
  const flashes = [0, 1, 2].map(() => {
    const u = { uColor: { value: new THREE.Color() }, uT: { value: 1 }, uPow: { value: 0 } };
    const m = new THREE.Mesh(quad, new THREE.ShaderMaterial({ uniforms: u, vertexShader: QUAD_VERTEX, fragmentShader: FLASH_FRAGMENT, ...blend, depthTest: false }));
    m.frustumCulled = false; m.renderOrder = 30; m.visible = false; scene.add(m);
    return { m, u, t: 1, life: 0.3 };
  });

  // ---- floor: shock rings and crack decals
  const floorQuad = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  const floorRings = [0, 1].map(() => {
    const u = { uColor: { value: new THREE.Color(0xffb04a) }, uT: { value: 1 } };
    const m = new THREE.Mesh(floorQuad, new THREE.ShaderMaterial({ uniforms: u, vertexShader: 'varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', fragmentShader: FLOOR_RING_FRAGMENT, ...blend }));
    m.renderOrder = 3; m.visible = false; scene.add(m); return { m, u, t: 1, life: 0.6 };
  });
  const crackTex = [crackTexture(7), crackTexture(1919), crackTexture(424242)];
  const cracks = [0, 1].map(() => {
    const u = { uMap: { value: crackTex[0] }, uHeat: { value: 0 }, uFade: { value: 0 } };
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({ uniforms: u, vertexShader: 'varying vec2 vUv2; void main(){ vUv2 = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', fragmentShader: CRACK_FRAGMENT, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.renderOrder = 2; m.visible = false; scene.add(m); return { m, u, t: 99, life: 3.2 };
  });

  // ---- debris: chips of mat (instanced), thrown up and bouncing
  const CHIPS = lite ? 24 : 60;
  const chipMat = new THREE.MeshStandardMaterial({ color: 0x1f6b48, roughness: 0.85 });
  const chips = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.22, 0.7), chipMat, CHIPS);
  chips.instanceMatrix.setUsage(THREE.DynamicDrawUsage); chips.frustumCulled = false; chips.castShadow = !lite; chips.count = 0; scene.add(chips);
  const cp = new Float32Array(CHIPS * 3), cv = new Float32Array(CHIPS * 3), cr = new Float32Array(CHIPS * 3), cw = new Float32Array(CHIPS * 3), cs = new Float32Array(CHIPS), cl = new Float32Array(CHIPS);
  const col = new THREE.Color(), dummy = new THREE.Object3D();
  let chipHead = 0;

  // ---- the glass: a 2D overlay above the canvas, drawn only round the contact
  const glass = document.createElement('canvas');
  glass.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:40;display:none';
  document.body.appendChild(glass);
  const gctx = glass.getContext('2d');
  const shot = document.createElement('canvas'), sctx = shot.getContext('2d');
  let pending = null, burst = null;
  const tmpV = new THREE.Vector3(), tmpW = new THREE.Vector3();

  // shards of a disc of radius R round (cx, cy): radial sectors cut by jittered rings
  function breakDisc(cx, cy, R, power, dirX, dirY) {
    let s = ((cx * 73856093) ^ (cy * 19349663)) >>> 0 || 7; const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    const rays = 6 + Math.round(power * 3), radii = [0, 0.4, 1].map(k => k * R);
    const angs = Array.from({ length: rays }, (_, i) => (i + (rnd() - 0.5) * 0.95) / rays * Math.PI * 2);
    const jr = radii.map((r, k) => angs.map(() => r * (k ? 1 + (rnd() - 0.5) * (k < radii.length - 1 ? 0.45 : 0.22) : 1)));
    const shards = [];
    for (let k = 0; k < radii.length - 1; k++) for (let i = 0; i < rays; i++) {
      const i2 = (i + 1) % rays, a0 = angs[i], a1 = angs[i2] + (i2 === 0 ? Math.PI * 2 : 0);
      const pt = (a, r) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
      const poly = k === 0 ? [[cx, cy], pt(a1, jr[1][i2]), pt(a0, jr[1][i])] : [pt(a0, jr[k][i]), pt(a1, jr[k][i2]), pt(a1, jr[k + 1][i2]), pt(a0, jr[k + 1][i])];
      const mx = poly.reduce((t, q) => t + q[0], 0) / poly.length, my = poly.reduce((t, q) => t + q[1], 0) / poly.length;
      const d = Math.hypot(mx - cx, my - cy) || 1, ux = (mx - cx) / d, uy = (my - cy) / d;
      // thrown out sideways, perpendicular to the shot, so nothing crosses the shuttle's path
      const px = -dirY, py = dirX, sideSign = (ux * px + uy * py) >= 0 ? 1 : -1;
      const sp = (0.9 + rnd() * 0.8) * R * (3 + 2 * power);
      shards.push({ poly, mx, my, delay: rnd() * 0.02,
        vx: (ux * 0.45 + px * sideSign) * sp, vy: (uy * 0.45 + py * sideSign) * sp,
        spin: (rnd() - 0.5) * 10, flip: 0.4 + rnd() * 0.6 });
    }
    // cracks running on past the disc, into the live view, for an instant
    const cracks = angs.map(a => {
      const pts = [[cx + Math.cos(a) * R, cy + Math.sin(a) * R]]; let ang = a, r = R;
      const end = R * (1.08 + rnd() * 0.15);
      while (r < end) { ang += (rnd() - 0.5) * 0.22; r += R * 0.1; pts.push([cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]); }
      return pts;
    });
    return { shards, cracks };
  }

  function drawBurst(t) {
    const W = glass.width, H = glass.height, B = burst;
    gctx.clearRect(0, 0, W, H);
    if (!B || t > 0.4) { glass.style.display = 'none'; burst = null; return; }
    const dpr = B.dpr;
    // 0..0.05 s: the impact: the frozen disc, cracks racing across it and on beyond it
    const grow = Math.min(1, t / 0.05);
    for (const sh of B.shards) {
      const lt = Math.max(0, t - sh.delay);
      const g = 2600 * dpr;
      const x = sh.vx * lt, y = sh.vy * lt + 0.5 * g * lt * lt;
      const alpha = 0.6 * Math.max(0, 1 - Math.max(0, lt - 0.06) * 3.6);
      if (alpha <= 0) continue;
      gctx.save(); gctx.globalAlpha = alpha;
      gctx.translate(sh.mx + x, sh.my + y); gctx.rotate(sh.spin * lt);
      gctx.scale(1 - Math.min(0.3, lt * 0.6), 1 - Math.min(0.8, lt * 2.6) * sh.flip); // tumbling edge-on
      gctx.translate(-sh.mx, -sh.my);
      gctx.beginPath(); sh.poly.forEach(([px, py], i) => (i ? gctx.lineTo(px, py) : gctx.moveTo(px, py))); gctx.closePath();
      gctx.save(); gctx.clip();
      // the glass bends what is behind it a little, pushed out from the impact
      const ox = (sh.mx - B.cx) * 0.035, oy = (sh.my - B.cy) * 0.035;
      gctx.drawImage(shot, B.sx + ox * (0.5 + lt * 4), B.sy + oy * (0.5 + lt * 4));
      const sheen = gctx.createLinearGradient(sh.mx - B.R * 0.5, sh.my - B.R * 0.5, sh.mx + B.R * 0.5, sh.my + B.R * 0.5);
      const glint = 0.12 + 0.35 * Math.abs(Math.sin(sh.spin * lt * 2 + sh.mx));
      sheen.addColorStop(0, 'rgba(255,255,255,0)'); sheen.addColorStop(0.5, `rgba(225,242,255,${glint})`); sheen.addColorStop(1, 'rgba(255,255,255,0)');
      gctx.fillStyle = sheen; gctx.fillRect(sh.mx - B.R, sh.my - B.R, B.R * 2, B.R * 2);
      gctx.restore();
      gctx.lineJoin = 'round';
      gctx.lineWidth = 2.2 * dpr; gctx.strokeStyle = 'rgba(6,10,16,.5)'; gctx.stroke();
      gctx.lineWidth = 1.1 * dpr; gctx.strokeStyle = `rgba(240,248,255,${0.75 * grow})`; gctx.stroke();
      gctx.restore();
    }
    // the cracks beyond the disc: white-hot hairlines, gone in a fifth of a second
    const ck = 0.6 * Math.max(0, 1 - t / 0.1);
    if (ck > 0) {
      gctx.lineCap = 'round';
      for (const pts of B.cracks) {
        const n = Math.max(2, Math.ceil(pts.length * grow));
        gctx.beginPath(); for (let i = 0; i < n; i++) (i ? gctx.lineTo(...pts[i]) : gctx.moveTo(...pts[i]));
        gctx.strokeStyle = `rgba(255,${200 + 55 * ck | 0},${140 + 100 * ck | 0},${0.85 * ck})`; gctx.lineWidth = 1.6 * dpr; gctx.stroke();
      }
    }
    // the impact: a white-hot star where the racket met it
    if (t < 0.08) {
      const k = 0.6 * (1 - t / 0.08), Rr = B.R * 0.4;
      const gr = gctx.createRadialGradient(B.cx, B.cy, 0, B.cx, B.cy, Rr);
      gr.addColorStop(0, `rgba(255,255,255,${k})`); gr.addColorStop(0.35, `rgba(255,230,190,${0.5 * k})`); gr.addColorStop(1, 'rgba(255,200,150,0)');
      gctx.fillStyle = gr; gctx.beginPath(); gctx.arc(B.cx, B.cy, Rr, 0, Math.PI * 2); gctx.fill();
    }
  }

  return {
    // a smash leaves the racket. power 0..1. pos: world contact point; color: the shot's
    // glass: crack the air at the contact (by default only on the hardest, power 0.7 up)
    contact(pos, power, color = 0xff5a3c, glassToo = power >= 0.7) {
      const f = flashes.find(f => f.t >= 1) || flashes[0];
      f.t = 0; f.life = 0.22 + 0.16 * power; f.m.visible = true; f.m.position.copy(pos);
      f.u.uColor.value.setHex(color); f.u.uPow.value = power; f.size = 0.55 + 0.85 * power;
      if (glassToo) pending = { pos: pos.clone(), power };
    },
    // a winning smash hits the court at (x, z) world
    slam(x, z, power) {
      const r = floorRings.find(r => r.t >= 1) || floorRings[0];
      r.t = 0; r.life = 0.5 + 0.3 * power; r.m.visible = true; r.m.position.set(x, 0.022, z); r.size = 1.8 + 2.6 * power;
      const c = cracks.find(c => c.t >= c.life) || cracks[0];
      c.t = 0; c.life = 2.8 + 1.6 * power; c.m.visible = true; c.m.position.set(x, 0.011, z);
      c.m.rotation.y = Math.random() * Math.PI * 2; c.m.scale.setScalar(1.1 + 1.6 * power);
      c.u.uMap.value = crackTex[(Math.random() * crackTex.length) | 0];
      // chips of mat
      const n = Math.round((lite ? 10 : 18) + (lite ? 12 : 36) * power);
      for (let k = 0; k < n; k++) {
        const i = chipHead; chipHead = (chipHead + 1) % CHIPS;
        const a = Math.random() * Math.PI * 2, sp = (1.2 + Math.random() * 3.2) * (0.6 + power);
        cp.set([x + Math.cos(a) * 0.12, 0.03, z + Math.sin(a) * 0.12], i * 3);
        cv.set([Math.cos(a) * sp, 2 + Math.random() * 3.5 * (0.5 + power), Math.sin(a) * sp], i * 3);
        cr.set([Math.random() * 6, Math.random() * 6, Math.random() * 6], i * 3);
        cw.set([(Math.random() - 0.5) * 24, (Math.random() - 0.5) * 24, (Math.random() - 0.5) * 24], i * 3);
        cs[i] = 0.012 + Math.random() * 0.026 * (0.6 + power); cl[i] = 1.4 + Math.random();
        chips.setColorAt(i, col.setHex(Math.random() < 0.7 ? 0x1f6b48 : 0x0f2a1f));
      }
      if (chips.instanceColor) chips.instanceColor.needsUpdate = true;
      chips.count = CHIPS;
    },
    // call right after renderer.render: the frame to break is the one just drawn. vel: the
    // shuttle's world velocity, which way the shards are thrown
    afterRender(camera, vel = null) {
      if (!pending || !camera) return;
      const cv2 = renderer.domElement, W = cv2.width, H = cv2.height, rect = cv2.getBoundingClientRect();
      const dpr = W / Math.max(1, rect.width);
      tmpV.copy(pending.pos).project(camera);
      const cx = (tmpV.x + 1) / 2 * W, cy = (1 - tmpV.y) / 2 * H;
      let dx = 0, dy = 1;
      if (vel && vel.lengthSq() > 1) {
        tmpW.copy(pending.pos).addScaledVector(vel, 0.04).project(camera);
        dx = (tmpW.x - tmpV.x) * W; dy = (tmpV.y - tmpW.y) * H; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      }
      const R = (34 + 42 * pending.power) * dpr, pad = R * 1.1;
      // the disc as it is right now: the 3D frame and the HUD's contact ring over it
      shot.width = shot.height = Math.ceil(pad * 2);
      const sx = cx - pad, sy = cy - pad;
      sctx.clearRect(0, 0, shot.width, shot.height);
      sctx.drawImage(cv2, sx, sy, shot.width, shot.height, 0, 0, shot.width, shot.height);
      const hud = document.getElementById('swCv');
      if (hud && hud.width) { const k = hud.width / W; sctx.drawImage(hud, sx * k, sy * k, shot.width * k, shot.height * k, 0, 0, shot.width, shot.height); }
      if (glass.width !== W || glass.height !== H) { glass.width = W; glass.height = H; }
      burst = { ...breakDisc(cx, cy, R, pending.power, dx, dy), cx, cy, R, sx, sy, dpr, t: 0 };
      glass.style.display = 'block'; pending = null;
      drawBurst(0);
    },
    update(dt, camera) {
      for (const f of flashes) if (f.t < 1) {
        f.t = Math.min(1, f.t + dt / f.life); f.u.uT.value = f.t; f.m.visible = f.t < 1;
        // constant-ish screen size: scale with distance
        const d = camera.position.distanceTo(f.m.position); f.m.scale.setScalar(f.size * 0.065 * d);
      }
      for (const r of floorRings) if (r.t < 1) { r.t = Math.min(1, r.t + dt / r.life); r.u.uT.value = r.t; r.m.visible = r.t < 1; r.m.scale.setScalar(r.size * (0.3 + 0.7 * Math.sqrt(r.t))); }
      for (const c of cracks) if (c.m.visible) {
        c.t += dt; const k = c.t / c.life;
        c.u.uHeat.value = Math.max(0, 1 - c.t / 0.9);            // glowing hot, cooling in under a second
        c.u.uFade.value = k < 0.7 ? 1 : Math.max(0, 1 - (k - 0.7) / 0.3);
        if (k >= 1) c.m.visible = false;
      }
      let alive = 0;
      for (let i = 0; i < CHIPS; i++) {
        if (cl[i] <= 0) { dummy.position.set(0, -10, 0); dummy.scale.setScalar(0.0001); dummy.updateMatrix(); chips.setMatrixAt(i, dummy.matrix); continue; }
        cl[i] -= dt; alive++;
        const q = i * 3;
        cv[q + 1] -= 9.8 * dt; cp[q] += cv[q] * dt; cp[q + 1] += cv[q + 1] * dt; cp[q + 2] += cv[q + 2] * dt;
        if (cp[q + 1] < 0.01) { cp[q + 1] = 0.01; cv[q + 1] *= -0.35; cv[q] *= 0.6; cv[q + 2] *= 0.6; cw[q] *= 0.6; cw[q + 1] *= 0.6; cw[q + 2] *= 0.6; }
        cr[q] += cw[q] * dt; cr[q + 1] += cw[q + 1] * dt; cr[q + 2] += cw[q + 2] * dt;
        dummy.position.set(cp[q], cp[q + 1], cp[q + 2]); dummy.rotation.set(cr[q], cr[q + 1], cr[q + 2]);
        dummy.scale.setScalar(cs[i] * Math.min(1, cl[i] * 2)); dummy.updateMatrix(); chips.setMatrixAt(i, dummy.matrix);
      }
      chips.instanceMatrix.needsUpdate = true; chips.visible = alive > 0;
      if (burst) { burst.t += dt; drawBurst(burst.t); }
    },
    reset() { for (const f of flashes) { f.t = 1; f.m.visible = false; } for (const r of floorRings) { r.t = 1; r.m.visible = false; } for (const c of cracks) c.m.visible = false; cl.fill(0); burst = null; pending = null; glass.style.display = 'none'; },
    stats: () => ({ glass: !!burst, chips: Array.from(cl).filter(v => v > 0).length, cracks: cracks.filter(c => c.m.visible).length }),
  };
}
