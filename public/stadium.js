// Office Ball — the stadium: a floodlit bowl built to be looked at. Raked seating decks under
// cantilevered roofs, the roof fronts carrying a continuous ring of floodlights (the signature of a
// modern ground at night), LED ribbons along every stand, a crowd that reads as people (seated,
// standing, scarves up, phones and camera flashes twinkling), lit haze hanging under the roofs, and
// on a goal the ring and ribbons run the scorer's colour.
// Everything here is cheap per frame (a few instanced draws and uniforms), so every tier gets it.
import * as THREE from 'three';
import { mergeStatic, bakeUV } from './merge.js';

const rnd = (() => { let s = 1234567; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)) >>> 0) / 4294967296; })();
const pick = a => a[(rnd() * a.length) | 0];

// ---------------------------------------------------------------- the crowd
// A sprite sheet of fans drawn once: R = shade, G = shirt mask, B = hair mask, A = cut-out. The
// shader paints each fan's own shirt, skin and hair through the masks, so ~3000 people are one draw.
const COLS = 8, ROWS = 3, CW = 64, CH = 96;
const RING_I = 5; // roof-ring lamp brightness (HDR): a glittering chain with a halo, not a fog of bloom // rows: 0 seated, 1 standing, 2 arms up / scarf held high
function crowdAtlas() {
  const c = document.createElement('canvas'); c.width = COLS * CW; c.height = ROWS * CH;
  const g = c.getContext('2d');
  const skin = v => `rgb(${v},0,0)`, shirt = v => `rgb(${v},255,0)`, hair = v => `rgb(${v},0,255)`;
  for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) {
    g.save(); g.translate(col * CW + CW / 2, row * CH);
    const wide = 0.85 + (col % 4) * 0.08, tall = 1 - (col % 3) * 0.05, hs = col % 5;
    const headY = (row === 0 ? 34 : 22) + (1 - tall) * 20, headR = 8.5;
    const sh = 17 * wide, hip = row === 0 ? 86 : 72;
    // torso (shirt), lit from above: brighter shoulders, darker waist
    const gr = g.createLinearGradient(0, headY + headR, 0, hip); gr.addColorStop(0, 'rgb(235,255,0)'); gr.addColorStop(1, 'rgb(150,255,0)');
    g.fillStyle = gr; g.beginPath();
    g.moveTo(-sh, headY + headR + 6); g.quadraticCurveTo(-sh - 2, headY + headR + 2, -sh + 6, headY + headR + 1);
    g.lineTo(sh - 6, headY + headR + 1); g.quadraticCurveTo(sh + 2, headY + headR + 2, sh, headY + headR + 6);
    g.lineTo(sh * 0.86, hip); g.lineTo(-sh * 0.86, hip); g.closePath(); g.fill();
    if (row === 2) {
      // arms up, and on some a scarf stretched above the head (shirt-coloured: team colours)
      g.strokeStyle = skin(200); g.lineWidth = 6; g.lineCap = 'round';
      g.beginPath(); g.moveTo(-sh + 3, headY + headR + 5); g.lineTo(-sh - 7, headY - 6); g.lineTo(-sh - 4, headY - 18); g.stroke();
      g.beginPath(); g.moveTo(sh - 3, headY + headR + 5); g.lineTo(sh + 7, headY - 6); g.lineTo(sh + 4, headY - 18); g.stroke();
      if (col % 2 === 0) { g.fillStyle = shirt(220); g.fillRect(-sh - 6, headY - 24, sh * 2 + 12, 7); g.fillStyle = shirt(120); for (let k = -sh; k < sh; k += 8) g.fillRect(k, headY - 24, 3, 7); }
    } else {
      // arms at the sides, sleeves in shirt colour
      g.fillStyle = shirt(170); g.fillRect(-sh - 4, headY + headR + 3, 6, 18); g.fillRect(sh - 2, headY + headR + 3, 6, 18);
      g.fillStyle = skin(170); g.fillRect(-sh - 4, headY + headR + 20, 6, row === 0 ? 10 : 22); g.fillRect(sh - 2, headY + headR + 20, 6, row === 0 ? 10 : 22);
    }
    if (row === 1) { g.fillStyle = 'rgb(60,0,0)'; g.fillRect(-sh * 0.8, hip, sh * 0.72, 22); g.fillRect(sh * 0.08, hip, sh * 0.72, 22); } // legs (dark trousers)
    // head and neck
    g.fillStyle = skin(190); g.fillRect(-3.5, headY + headR - 2, 7, 6);
    const hg = g.createRadialGradient(-2, headY - 3, 1, 0, headY, headR); hg.addColorStop(0, skin(245)); hg.addColorStop(1, skin(165));
    g.fillStyle = hg; g.beginPath(); g.arc(0, headY, headR, 0, Math.PI * 2); g.fill();
    // hair: a few styles (short, long, cap, bald)
    if (hs !== 3) {
      g.fillStyle = hair(hs === 4 ? 230 : 150); g.beginPath();
      if (hs === 4) { g.arc(0, headY - 2, headR + 0.5, Math.PI, 0); g.fillRect(-headR - 1, headY - 3, headR * 2 + 7, 3); } // cap with a peak
      else if (hs === 2) { g.arc(0, headY - 1, headR + 1.5, Math.PI * 0.9, Math.PI * 2.1); g.fillRect(-headR - 1.5, headY - 1, 4, 12); g.fillRect(headR - 2.5, headY - 1, 4, 12); }
      else g.arc(0, headY - 1.5, headR + 0.8, Math.PI * 1.05, Math.PI * 1.95);
      g.fill();
    }
    g.restore();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.premultiplyAlpha = false;
  return t;
}

const crowdVert = `
attribute vec3 iPos; attribute vec2 iSize; attribute vec3 iShirt; attribute vec3 iSkin; attribute vec3 iHair;
attribute float iFrame; attribute float iSeed; attribute float iTeam; attribute float iLit;
uniform float uTime, uHype, uHypeA, uHypeB, uShow; uniform vec3 uShowCol;
varying vec2 vUv; varying vec3 vShirt; varying vec3 vSkin; varying vec3 vHair; varying float vLit; varying float vFlash; varying vec3 vTint;
#include <common>
#include <fog_pars_vertex>
float hsh(float n){ return fract(sin(n * 12.9898) * 43758.5453); }
void main(){
  float hype = uHype + (iTeam > 0.5 && iTeam < 1.5 ? uHypeA : 0.0) + (iTeam > 1.5 ? uHypeB : 0.0);
  // who is on their feet: everyone rises with the moment, the scoring end first and highest
  float up = step(hsh(iSeed * 3.1), clamp(hype * 1.1 - 0.15, 0.0, 1.0));
  float cheer = step(hsh(iSeed * 7.7), clamp(hype - 0.45, 0.0, 1.0) * 1.6);
  float row = up > 0.5 ? (cheer > 0.5 ? 2.0 : 1.0) : 0.0;
  float col = mod(iFrame, ${COLS}.0);
  vUv = vec2((col + uv.x) / ${COLS}.0, 1.0 - (row + 1.0 - uv.y) / ${ROWS}.0);
  float bounce = abs(sin(uTime * (2.4 + fract(iSeed * 1.37) * 2.2) + iSeed * 40.0)) * (0.015 + 0.2 * clamp(hype, 0.0, 1.3)) * (0.4 + 0.6 * up);
  // a cylindrical billboard: the card turns about its own upright to face the camera
  vec3 toCam = cameraPosition - iPos; toCam.y = 0.0; vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x));
  vec3 p = iPos + right * (position.x * iSize.x) + vec3(0.0, position.y * iSize.y + bounce, 0.0);
  // phones and cameras: now and then a fan's screen or flash lights up; far more often in a big moment
  float slot = floor(uTime * 1.6 + iSeed * 97.0), f = fract(uTime * 1.6 + iSeed * 97.0);
  vFlash = step(hsh(slot * 1.3 + iSeed), 0.004 + 0.07 * clamp(hype - 0.3, 0.0, 1.0)) * pow(1.0 - f, 6.0);
  vShirt = iShirt; vSkin = iSkin; vHair = iHair; vLit = iLit;
  vTint = uShowCol * uShow * (0.5 + 0.5 * sin(uTime * 9.0 + iPos.x * 0.35 + iPos.z * 0.35));
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const crowdFrag = `
uniform sampler2D uAtlas; uniform float uLight;
varying vec2 vUv; varying vec3 vShirt; varying vec3 vSkin; varying vec3 vHair; varying float vLit; varying float vFlash; varying vec3 vTint;
#include <common>
#include <fog_pars_fragment>
void main(){
  vec4 a = texture2D(uAtlas, vUv);
  if (a.a < 0.5) discard;
  vec3 base = mix(mix(vSkin, vShirt, a.g), vHair, a.b);
  // a phone or camera going off: a hot point held up by the head, and the fan lit by it
  vec2 cell = fract(vUv * vec2(${COLS}.0, ${ROWS}.0));
  float dotA = 1.0 - smoothstep(0.0, 0.09, length((cell - vec2(0.68, 0.62)) * vec2(1.0, 1.5)));
  vec3 c = base * a.r * vLit * uLight * (1.0 + vFlash * 0.8) + base * vTint * 0.35;
  c += vec3(1.0, 0.97, 0.92) * vFlash * dotA * 14.0;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// ---------------------------------------------------------------- lit haze under the roofs
const hazeVert = `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const hazeFrag = `varying vec2 vUv; varying vec3 vW; uniform vec3 uColor; uniform float uStrength, uTime; uniform vec3 uFace;
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
void main(){
  vec3 V = normalize(cameraPosition - vW);
  float toward = pow(clamp(dot(-V, uFace) * 0.5 + 0.5, 0.0, 1.0), 3.0);      // brighter looking into the lamps
  float vert = pow(vUv.y, 1.8);                                                // densest just under the roof
  float side = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x);
  float drift = 0.6 + 0.4 * n2(vec2(vW.x * 0.25 + uTime * 0.04, vW.y * 0.4 - uTime * 0.02));
  float a = vert * side * drift * uStrength * mix(0.25, 1.0, toward);
  gl_FragColor = vec4(uColor * a, 1.0);
}`;

// ---------------------------------------------------------------- building blocks
// the light on a seat in row r of a stand: under a roof, the front rows catch the ring's spill and
// the pitch's glow and the back sinks into shade; an open stand is lit evenly from the gantry above
function standLight(r, rows, roofed) {
  const u = r / Math.max(1, rows - 1);
  return roofed ? 0.95 - 0.62 * u * u * (3 - 2 * u) : 0.8 - 0.2 * u;
}
function stepped(rows, depth, rise, len, base, roofed) {
  // a seating deck along x (length len), rows stepping back along -z and up along y, with the stand's
  // lighting baked into its vertex colours (treads lit from above, risers a step darker)
  const pos = [], col = [], idx = [];
  const seat = [new THREE.Color(0x2a3350), new THREE.Color(0x323c5c)], c = new THREE.Color();
  const quad = (a, b, cc, d, lit) => { const o = pos.length / 3; for (const p of [a, b, cc, d]) { pos.push(...p); col.push(lit[0], lit[1], lit[2]); } idx.push(o, o + 1, o + 2, o, o + 2, o + 3); };
  for (let r = 0; r < rows; r++) {
    const z0 = -r * depth, z1 = -(r + 1) * depth, y = base + r * rise, L = standLight(r, rows, roofed) * 0.5;
    c.copy(seat[r % 2]).multiplyScalar(L * 0.62); const riser = [c.r, c.g, c.b];
    c.copy(seat[r % 2]).multiplyScalar(L); const tread = [c.r, c.g, c.b];
    quad([-len / 2, y, z0], [len / 2, y, z0], [len / 2, y + rise, z0], [-len / 2, y + rise, z0], riser);
    quad([-len / 2, y + rise, z0], [len / 2, y + rise, z0], [len / 2, y + rise, z1], [-len / 2, y + rise, z1], tread);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); return g;
}

// dims: { HW, HH, GDP }, tier, boardTex (the LED board texture, reused for the ribbons)
export function buildStadium(scene, dims, tier, boardTex) {
  const { HW, HH, GDP } = dims, lite = tier === 'lite';
  const concrete = new THREE.MeshStandardMaterial({ color: 0x1a2030, roughness: 0.92 });
  const deckMat = new THREE.MeshBasicMaterial({ vertexColors: true }); // lighting baked (see stepped)
  const steel = new THREE.MeshStandardMaterial({ color: 0x1e2533, roughness: 0.5, metalness: 0.7 });
  const underside = new THREE.MeshStandardMaterial({ color: 0x0e121c, roughness: 0.8, metalness: 0.2 });
  const ribbons = [], rings = [], hazes = [], people = [];
  // everything that never moves, merged into one mesh per material once the bowl is built
  const statics = [];
  // the LED ribbons: one texture and one material for all of them (each stand's repeat and start
  // offset is baked into its own geometry), so they merge into a single draw
  const ribbonTex = boardTex.clone(); ribbonTex.needsUpdate = true;
  const ribbonMat = new THREE.MeshBasicMaterial({ map: ribbonTex, color: new THREE.Color(1.4, 1.4, 1.4) });
  ribbons.push({ mat: ribbonMat, tex: ribbonTex });
  const RISE = 0.44, DEPTH = 0.78, WALL = 1.2;

  // A stand: origin at the middle of its front wall, facing +z locally, rotated into place.
  // spec: { len, rows, roof: { y, overhang } | null, team: 0 neutral | 1 home | 2 away }
  const stand = (spec, x, z, rotY) => {
    const grp = new THREE.Group(); grp.position.set(x, 0, z); grp.rotation.y = rotY; scene.add(grp);
    const deck = new THREE.Mesh(stepped(spec.rows, DEPTH, RISE, spec.len, WALL, !!spec.roof), deckMat); grp.add(deck); statics.push(deck);
    const backZ = -spec.rows * DEPTH, topY = WALL + spec.rows * RISE;
    const front = new THREE.Mesh(new THREE.BoxGeometry(spec.len, WALL, 0.3), concrete); front.position.set(0, WALL / 2, 0.15); front.receiveShadow = true; grp.add(front); statics.push(front);
    const back = new THREE.Mesh(new THREE.BoxGeometry(spec.len, topY + 2, 0.4), concrete); back.position.set(0, (topY + 2) / 2, backZ - 0.2); grp.add(back); statics.push(back);
    for (const s of [-1, 1]) { // end walls (vomitory-grey), stepping with the rake
      const shp = new THREE.Shape(); shp.moveTo(0, 0); shp.lineTo(0, WALL + 0.3); shp.lineTo(-backZ, topY + 0.6); shp.lineTo(-backZ, 0); shp.closePath();
      const w = new THREE.Mesh(new THREE.ExtrudeGeometry(shp, { depth: 0.3, bevelEnabled: false }), concrete);
      w.rotation.y = Math.PI / 2; w.position.set(s * spec.len / 2 + (s < 0 ? -0.3 : 0), 0, 0.3); grp.add(w); statics.push(w);
    }
    // LED ribbon along the top of the front wall
    const ribbon = new THREE.Mesh(bakeUV(new THREE.PlaneGeometry(spec.len, 0.34), spec.len / 6, rnd()), ribbonMat); ribbon.position.set(0, WALL - 0.2, 0.31); grp.add(ribbon); statics.push(ribbon);
    if (spec.roof) {
      const R = spec.roof, depth = -backZ + 1.2 - R.overhang, thick = 0.5;
      const roof = new THREE.Mesh(new THREE.BoxGeometry(spec.len + 1.6, thick, -backZ + 1.2 + R.overhang), steel);
      roof.position.set(0, R.y, (backZ - 1.2 + R.overhang) / 2); roof.rotation.x = -0.035; roof.castShadow = false; grp.add(roof); statics.push(roof);
      const under = new THREE.Mesh(new THREE.PlaneGeometry(spec.len + 1.6, -backZ + 1.2 + R.overhang), underside);
      under.rotation.x = Math.PI / 2 - 0.035; under.position.set(0, R.y - thick / 2 - 0.01, roof.position.z); grp.add(under); statics.push(under);
      // roof trusses along the top: structure you can read from the broadcast camera above
      for (let k = -spec.len / 2; k <= spec.len / 2 + 0.01; k += 4.2) {
        const tr = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.7, -backZ + 1.2 + R.overhang), steel); tr.position.set(k, R.y + 0.55, roof.position.z); tr.rotation.x = -0.035; grp.add(tr); statics.push(tr);
      }
      // rear columns carrying the cantilever
      for (let k = -spec.len / 2 + 1; k <= spec.len / 2 - 0.99; k += 6) { const c = new THREE.Mesh(new THREE.BoxGeometry(0.35, R.y, 0.35), steel); c.position.set(k, R.y / 2, backZ - 0.8); grp.add(c); statics.push(c); }
      // the fascia, and the ring of floodlights along its lower edge
      const fz = R.overhang;
      const fascia = new THREE.Mesh(new THREE.BoxGeometry(spec.len + 1.6, 1.1, 0.25), steel); fascia.position.set(0, R.y - 0.1, fz); grp.add(fascia); statics.push(fascia);
      const n = Math.floor((spec.len + 1.2) / 0.55), lamp = new THREE.PlaneGeometry(0.34, 0.2);
      const ring = new THREE.InstancedMesh(lamp, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true, fog: false }), n);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.55, 0, 0)), sc = new THREE.Vector3(1, 1, 1), p3 = new THREE.Vector3();
      for (let i = 0; i < n; i++) { p3.set(-(spec.len + 1.2) / 2 + (i + 0.5) * 0.55, R.y - 0.72, fz + 0.14); m4.compose(p3, q, sc); ring.setMatrixAt(i, m4); ring.setColorAt(i, new THREE.Color(1, 1, 1)); }
      ring.frustumCulled = false; grp.add(ring);
      rings.push({ ring, n, grp, len: spec.len, y: R.y - 0.72, z: fz + 0.14 });
      if (!lite) { // the air under the roof, lit by its own lamps
        const hz = new THREE.Mesh(new THREE.PlaneGeometry(spec.len + 1, R.y - 1.2), new THREE.ShaderMaterial({ vertexShader: hazeVert, fragmentShader: hazeFrag,
          uniforms: { uColor: { value: new THREE.Color(0.62, 0.72, 1) }, uStrength: { value: 0.022 }, uTime: { value: 0 }, uFace: { value: new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY).multiplyScalar(-1) } },
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
        hz.position.set(0, 1.2 + (R.y - 1.2) / 2, fz - 0.6); hz.renderOrder = 6; grp.add(hz); hazes.push(hz.material);
      }
    }
    // the crowd for this stand: one card per seat, most seats taken
    for (let r = 0; r < spec.rows; r++) for (let k = -spec.len / 2 + 0.3; k < spec.len / 2 - 0.2; k += 0.46) {
      if (rnd() < (lite ? 0.5 : 0.1)) continue;
      const lp = new THREE.Vector3(k + (rnd() - 0.5) * 0.08, WALL + r * RISE + RISE, -r * DEPTH - DEPTH * 0.55);
      const wp = lp.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY).add(grp.position);
      people.push({ p: wp, team: spec.team === 0 ? (rnd() < 0.5 ? 1 : 2) * (rnd() < 0.75 ? 1 : 0) : spec.team, lit: standLight(r, spec.rows, !!spec.roof) * (0.9 + rnd() * 0.2) });
    }
    return grp;
  };
  const endX = HW + GDP + 1.7, farZ = HH + 2.1, nearZ = HH + 2.3;
  stand({ len: 2 * (HW + 5.8), rows: 16, roof: { y: 11.4, overhang: -1.6 }, team: 0 }, 0, -farZ, 0);             // main stand
  stand({ len: 2 * (HW + 5.8), rows: 7, roof: null, team: 0 }, 0, nearZ, Math.PI);                              // near side (under the cameras)
  stand({ len: 2 * (HH + 5.2), rows: 13, roof: { y: 10.2, overhang: -1.4 }, team: 1 }, -endX, 0, Math.PI / 2);   // home end
  stand({ len: 2 * (HH + 5.2), rows: 13, roof: { y: 10.2, overhang: -1.4 }, team: 2 }, endX, 0, -Math.PI / 2);   // away end

  mergeStatic(scene, statics);

  // crowd, all of it one instanced draw
  const N = people.length, geo = new THREE.InstancedBufferGeometry();
  const base = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  geo.index = base.index; geo.setAttribute('position', base.attributes.position); geo.setAttribute('uv', base.attributes.uv);
  const f32 = k => new Float32Array(N * k);
  const A = { iPos: f32(3), iSize: f32(2), iShirt: f32(3), iSkin: f32(3), iHair: f32(3), iFrame: f32(1), iSeed: f32(1), iTeam: f32(1), iLit: f32(1) };
  const HOME = [[0.84, 0.1, 0.16], [0.72, 0.06, 0.12], [0.95, 0.95, 0.95], [0.84, 0.1, 0.16]], AWAY = [[0.1, 0.52, 0.94], [0.05, 0.3, 0.7], [0.95, 0.95, 0.95], [0.1, 0.52, 0.94]];
  const NEUTRAL = [[0.2, 0.22, 0.28], [0.85, 0.85, 0.85], [0.1, 0.1, 0.12], [0.55, 0.45, 0.3], [0.25, 0.4, 0.3], [0.5, 0.2, 0.4], [0.9, 0.75, 0.2]];
  const SKINS = [[0.93, 0.74, 0.6], [0.85, 0.63, 0.48], [0.75, 0.5, 0.32], [0.6, 0.39, 0.25], [0.43, 0.27, 0.16]];
  const HAIRS = [[0.1, 0.08, 0.06], [0.23, 0.15, 0.09], [0.42, 0.27, 0.14], [0.05, 0.05, 0.05], [0.55, 0.55, 0.55], [0.8, 0.8, 0.82]];
  people.forEach((q, i) => {
    A.iPos.set([q.p.x, q.p.y, q.p.z], i * 3);
    A.iSize.set([0.5 + rnd() * 0.06, 0.78 + rnd() * 0.08], i * 2);
    A.iShirt.set(q.team === 1 ? pick(HOME) : q.team === 2 ? pick(AWAY) : pick(NEUTRAL), i * 3);
    A.iSkin.set(pick(SKINS), i * 3); A.iHair.set(pick(HAIRS), i * 3);
    A.iFrame[i] = (rnd() * COLS) | 0; A.iSeed[i] = rnd() * 100; A.iTeam[i] = q.team; A.iLit[i] = q.lit;
  });
  const sizes = { iPos: 3, iSize: 2, iShirt: 3, iSkin: 3, iHair: 3, iFrame: 1, iSeed: 1, iTeam: 1, iLit: 1 };
  for (const k in A) geo.setAttribute(k, new THREE.InstancedBufferAttribute(A[k], sizes[k]));
  geo.instanceCount = N;
  const crowdU = { uAtlas: { value: crowdAtlas() }, uTime: { value: 0 }, uHype: { value: 0 }, uHypeA: { value: 0 }, uHypeB: { value: 0 }, uShow: { value: 0 }, uShowCol: { value: new THREE.Color() }, uLight: { value: 1 } };
  const crowdMat = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]), vertexShader: crowdVert, fragmentShader: crowdFrag, fog: true });
  Object.assign(crowdMat.uniforms, crowdU);
  const crowd = new THREE.Mesh(geo, crowdMat); crowd.frustumCulled = false; crowd.userData.noAO = true; scene.add(crowd);

  // ---- the show. ring colours, ribbon tint, crowd tint, and how bright the floodlights are
  const show = { t: -1, col: new THREE.Color(), dur: 4.2 };
  const white = new THREE.Color(1, 1, 1), tmp = new THREE.Color();
  function goal(color) { show.t = 0; show.col.set(color); }
  // returns the floodlight level (1 = normal) for the lighting rig
  // power (0..1): the kick-off power-up; the roof ring is the last thing to come on
  function update(dt, t, hype, hypeA, hypeB, power = 1) {
    crowdU.uTime.value = t; crowdU.uHype.value = hype; crowdU.uHypeA.value = hypeA; crowdU.uHypeB.value = hypeB;
    for (const h of hazes) h.uniforms.uTime.value = t;
    for (const r of ribbons) r.tex.offset.x = (r.tex.offset.x + dt * 0.03) % 1;
    // a goal: the LED ribbons and the roof ring run the scorer's colour for a few seconds (the
    // floodlights themselves stay steady; the pitch is always lit)
    let flood = 1, ringMode = 0, k = 0;
    if (show.t >= 0) {
      show.t += dt;
      if (show.t > show.dur) show.t = -1;
      else { ringMode = show.t < 3.4 ? 1 : 0; k = show.t < 3.4 ? 1 : Math.max(0, 1 - (show.t - 3.4) / 0.8); }
    }
    crowdU.uShow.value = k * (show.t >= 0 ? 1 : 0); crowdU.uShowCol.value.copy(show.col);
    crowdU.uLight.value = 0.35 + 0.65 * Math.min(1, flood + 0.25);
    for (const r of ribbons) r.mat.color.copy(ringMode ? tmp.copy(show.col).multiplyScalar(1.6 + Math.sin(t * 14) * 0.5) : white).multiplyScalar(ringMode ? 1 : 1.4);
    for (const R of rings) {
      for (let i = 0; i < R.n; i++) {
        if (ringMode) { const chase = 0.5 + 0.5 * Math.sin(i * 0.45 - show.t * 18); tmp.copy(show.col).multiplyScalar(1 + chase * 5); }
        else tmp.setRGB(1, 0.98, 0.95).multiplyScalar(RING_I * (0.3 + 0.7 * flood) * Math.min(1, Math.max(0, (power - 0.7) / 0.12) + (i % 7 === 0 && power > 0.6 ? 0.5 : 0)));
        R.ring.setColorAt(i, tmp);
      }
      R.ring.instanceColor.needsUpdate = true;
    }
    return flood;
  }
  return { update, goal, rings, crowd, people: N };
}
