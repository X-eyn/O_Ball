// Office Badminton — the 3D view: a floodlit tournament hall (buildHall) around the court. The players are the same rigged Quaternius characters the football
// page uses (human.js: GLB body + mocap locomotion), with a racket fitted to the hand and procedural
// badminton layers (ready stance, wind-up, swing, dive) composited over the mocap. Sim coordinates
// are metres: x runs the length (net at 0), y across, z up. In three.js the court lies on the XZ
// plane, so world = (x, z, y).
import * as THREE from 'three';
import { NetDynamics } from './net-dynamics.mjs';
import { createHeatVfx } from './heat-vfx.js';
import { presentationUrl } from './presentation-assets.js';
import { createNetLook } from './net-look.js';
import { createShuttleFx } from './shuttle-fx.js';
import { createSmashFx } from './smash-fx.js';
import { HAIR_KEYS, MODEL_HEIGHT, loadPlayerAssets } from '../human.js';
import { Athlete, strokeFor, STROKES } from './anim.js';
import { KITS } from '../kits.js';
import { mergeStatic } from '../merge.js';

const BM = () => window.BM;
const W2 = (x, y, z) => [x, z, y];
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const rnd = (a, b) => a + Math.random() * (b - a);
const easeOutC = t => 1 - Math.pow(1 - t, 3);
const hash = s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

// the same appearance-from-name rule the football page uses, so a person looks the same on both pages
const PLAYER_H = 1.82;
const SKIN = [0xf1c7a5, 0xe0a878, 0xc98a5a, 0x9c6540, 0x6f452b, 0x50301d];
const HAIR = [0x1b1410, 0x2f2013, 0x4a2f1b, 0x6b4a2a, 0x8a6a3d, 0xc9a76a, 0x2b2b2b, 0x6e6e6e];
const EYES = [0x4a2f1b, 0x2b1a10, 0x3d6b8f, 0x5b7a3a, 0x6b4a2a, 0x1e120a];
function lookFor(name, slot) {
  const h = hash(name || String(slot)), r = k => (hash(h + ':' + k) % 1000) / 1000;
  return {
    name, number: name === 'BOT' ? 0 : 1 + (h >>> 8) % 99,
    skin: SKIN[h % SKIN.length], hairColor: HAIR[(h >>> 4) % HAIR.length], eyes: EYES[(h >>> 3) % EYES.length],
    hair: HAIR_KEYS[Math.floor(r('hair') * HAIR_KEYS.length)], beard: r('beard') < 0.3,
    scale: PLAYER_H / MODEL_HEIGHT * (0.97 + r('h') * 0.07), boots: Math.floor(r('boots') * 6),
    foot: r('foot') < 0.8 ? 'R' : 'L', seed: r('seed') * 100,
  };
}

// ---------------------------------------------------------------- court + hall textures
// The field of play is a tournament mat: a green court laid on a deep blue surround, both with a
// fine vinyl grain, the event name printed behind each baseline (each reads the right way up from
// the camera at the other end).
// field of play half-extents (sim metres): the surround runs out to the boards. Set from the sim's
// court (BM.C) when the renderer is created, like every other court dimension here.
let FOP_X = 12, FOP_Y = 6, CT = null;
const FONT = "'Barlow Condensed','Arial Narrow',sans-serif";
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function grain(g, W, H, amt, seed = 7) {
  const img = g.getImageData(0, 0, W, H), d = img.data;
  let s = seed;
  for (let i = 0; i < d.length; i += 4) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const n = ((s >>> 24) / 255 - 0.5) * amt;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}
function courtTexture() {
  const MX = FOP_X, MY = FOP_Y, W = 2048, H = Math.round(W * MY / MX);
  return canvasTex(W, H, (g) => {
    const px = x => (x + MX) / (2 * MX) * W, py = y => (y + MY) / (2 * MY) * H, mw = v => v / (2 * MX) * W;
    // surround: deep tournament blue, a touch lighter toward the court
    const sg = g.createRadialGradient(W / 2, H / 2, mw(2), W / 2, H / 2, mw(10));
    sg.addColorStop(0, '#16427a'); sg.addColorStop(1, '#0c2748');
    g.fillStyle = sg; g.fillRect(0, 0, W, H);
    // a thin keyline where the mat meets the boards
    g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = mw(0.04);
    g.strokeRect(mw(0.12), mw(0.12), W - mw(0.24), H - mw(0.24));
    // the court mat: the doubles box plus a margin, in court green
    const { L, W: SW, DW, SHORT, LONG } = CT;
    const cg = g.createLinearGradient(0, py(-DW), 0, py(DW));
    cg.addColorStop(0, '#0e5849'); cg.addColorStop(0.5, '#126453'); cg.addColorStop(1, '#0e5849');
    g.fillStyle = cg;
    g.fillRect(px(-L) - mw(0.8), py(-DW) - mw(0.8), mw(2 * L + 1.6), mw(2 * DW + 1.6));
    // event name behind each baseline, turned to face the far camera
    const word = (x, rot) => {
      g.save(); g.translate(px(x), py(0)); g.rotate(rot);
      g.font = `italic 800 ${mw(0.78)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.textAlign = 'left';
      const a = g.measureText('OFFICE ').width, b = g.measureText('BADMINTON').width, x0 = -(a + b) / 2;
      g.fillStyle = 'rgba(255,255,255,.9)'; g.fillText('OFFICE ', x0, 0);
      g.fillStyle = '#ffc83d'; g.fillText('BADMINTON', x0 + a, 0);
      g.restore();
    };
    word(L + 1.55, Math.PI / 2); word(-L - 1.55, -Math.PI / 2);
    // sideline stripes on the surround
    g.fillStyle = 'rgba(255,200,61,.5)';
    g.fillRect(px(-L), py(-DW) - mw(1.35), mw(2 * L), mw(0.05));
    g.fillRect(px(-L), py(DW) + mw(1.3), mw(2 * L), mw(0.05));
    grain(g, W, H, 9);
    // Fine joined rolls and shoe scuffs are baked once; physical micrograin comes from the maps.
    g.strokeStyle = 'rgba(6,28,21,.13)'; g.lineWidth = mw(0.012);
    for (let y = -DW + 1.3; y < DW; y += 1.3) { g.beginPath(); g.moveTo(px(-L)-mw(0.8),py(y)); g.lineTo(px(L)+mw(0.8),py(y)); g.stroke(); }
    let seed = 813; const rand = () => { seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296; };
    for (let i=0;i<85;i++) {
      const x=px((rand()*2-1)*L), y=py((rand()*2-1)*DW);
      g.save(); g.translate(x,y); g.rotate(rand()*6.28); g.strokeStyle='rgba(5,21,17,.07)'; g.lineWidth=mw(0.012);
      g.beginPath();g.ellipse(0,0,mw(0.08+rand()*0.16),mw(0.025),0,0,Math.PI*1.1);g.stroke();g.restore();
    }
    // Pigmented brush paint: irregular edges, translucent bristle streaks, and small worn pores.
    // The rule geometry stays exact and the pigment never interrupts a line across its width.
    const line = (x1,y1,x2,y2) => {
      const ax=px(x1),ay=py(y1),bx=px(x2),by=py(y2),len=Math.hypot(bx-ax,by-ay), nx=-(by-ay)/len,ny=(bx-ax)/len,hw=mw(0.021);
      const steps=Math.max(4,Math.ceil(len/6)); g.fillStyle='#f4f3e7';g.beginPath();
      for(let side=0;side<2;side++)for(let j=0;j<=steps;j++){
        const t=side?1-j/steps:j/steps,k=(side?-1:1)*(hw+(rand()-.5)*.38),x=ax+(bx-ax)*t+nx*k,y=ay+(by-ay)*t+ny*k;
        if(!side&&!j)g.moveTo(x,y);else g.lineTo(x,y);
      }g.closePath();g.fill();
      g.strokeStyle='rgba(126,143,129,.17)';g.lineWidth=.35;
      for(let j=0;j<3;j++){const k=(rand()-.5)*hw*1.2;g.beginPath();g.moveTo(ax+nx*k,ay+ny*k);g.lineTo(bx+nx*k,by+ny*k);g.stroke();}
      g.fillStyle='rgba(28,78,53,.22)';for(let j=0;j<len*.3;j++){const t=rand(),k=(rand()-.5)*hw*1.4;g.fillRect(ax+(bx-ax)*t+nx*k,ay+(by-ay)*t+ny*k,.6,.6);}
    };
    for (const y of [-DW, -SW, SW, DW]) line(-L, y, L, y);
    for (const x of [-L, -LONG, -SHORT, SHORT, LONG, L]) line(x, -DW, x, DW);
    line(-L, 0, -SHORT, 0); line(SHORT, 0, L, 0);
    // the lamps' pool, baked: brightest over the court, falling away toward the boards
    const pool = g.createRadialGradient(W / 2, H / 2, mw(3), W / 2, H / 2, mw(10.5));
    pool.addColorStop(0, 'rgba(0,0,0,0)'); pool.addColorStop(0.55, 'rgba(0,0,0,.12)'); pool.addColorStop(1, 'rgba(0,0,0,.45)');
    g.fillStyle = pool; g.fillRect(0, 0, W, H);
  });
}
// LED boards: a dark panel with the event name, scrolled by moving the texture offset
function boardTexture(message = 'OFFICE BADMINTON  ·  THE OFFICE OPEN') {
  const t = canvasTex(4096, 128, (g, W, H) => {
    const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#0d2a52'); bg.addColorStop(1, '#071a36');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const campaigns = [['APEX COURT','FIND YOUR NEXT LEVEL','#e4ff3c'],['FEATHER LAB','PRECISION IN EVERY STRIKE','#88d8ff'],['THE OFFICE OPEN',message,'#f4f5ef']];
    campaigns.forEach(([title, sub, color], i) => {
      const x=i*W/3;g.fillStyle=color;
      // Authored graphic mark, repeated with its campaign across the perimeter.
      g.beginPath();g.moveTo(x+22,96);g.lineTo(x+65,25);g.lineTo(x+108,96);g.lineTo(x+82,96);g.lineTo(x+65,65);g.lineTo(x+48,96);g.closePath();g.fill();
      g.textBaseline='middle';g.font=`italic 800 59px ${FONT}`;g.fillText(title,x+140,46);
      g.font=`600 29px ${FONT}`;g.fillStyle='#d1dbe7';g.fillText(sub,x+142,93,W/3-172);
      g.fillStyle='rgba(151,182,213,.35)';g.fillRect(x+W/3-15,23,2,82);
    });
    // LED pitch: a faint pixel grid
    g.fillStyle = 'rgba(0,0,0,.28)';
    for (let x = 0; x < W; x += 4) g.fillRect(x, 0, 1, H);
    for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
  });
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
// soft round gradient: contact shadows, lamp glows, the shuttle's halo
function blobTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  return canvasTex(128, 128, (g, W) => {
    const gr = g.createRadialGradient(W / 2, W / 2, 0, W / 2, W / 2, W / 2);
    gr.addColorStop(0, inner); gr.addColorStop(1, outer);
    g.fillStyle = gr; g.fillRect(0, 0, W, W);
  });
}
// The baked crowd: CROWD_STRIPS rows of seated fans, each strip covering CROWD_SPAN metres of seats
// and one card's height. Painted once per state (calm / cheering) with the same seed, so a swap
// shows the same people jumping up. Strips wrap horizontally, so a row of any length samples one.
const CROWD_STRIPS = 8, CROWD_SPAN = 24, CROWD_PAD = 3 / 1024, CROWD_PER_STRIP = Math.round(CROWD_SPAN / 0.53 * 0.88);
function crowdAtlas(cheer) {
  const W = 2048, H = 1024, SH = H / CROWD_STRIPS, sx = W / CROWD_SPAN, sy = (SH - 6) / 0.95;
  const t = canvasTex(W, H, (g) => {
    let seed = 424242;
    const rnd = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822507) ^ Math.imul(seed ^ (seed >>> 13), 3266489909)) >>> 0) / 4294967296;
    const pick = a => a[(rnd() * a.length) | 0];
    const SKIN = ['#f0c8a8', '#dba27a', '#c0845a', '#99653f', '#6e4428', '#4f301c'];
    const HAIR = ['#1a130e', '#2f2013', '#4a2f1b', '#0e0e0e', '#8a8a8a', '#c9a76a', '#6b4a2a'];
    const NEUTRAL = ['#2c3340', '#d8dadf', '#1b1d22', '#8a7358', '#3f6650', '#6b3a5e', '#d9b53a', '#4a5a78'];
    const HOME = ['#dc2530', '#b3121c', '#f2f2f2'], AWAY = ['#1f7ff0', '#0f4fae', '#f2f2f2'];
    for (let st = 0; st < CROWD_STRIPS; st++) {
      const top = st * SH + 3, base = top + 0.95 * sy;
      const Y = m => base - m * sy, X = m => m * sx;
      for (let x = 0.3; x < CROWD_SPAN - 0.2; x += 0.5 + rnd() * 0.07) {
        const r0 = rnd(), skin = pick(SKIN), hair = pick(HAIR), shirt = r0 < 0.25 ? pick(HOME) : r0 < 0.5 ? pick(AWAY) : pick(NEUTRAL);
        const empty = rnd() < 0.12, up = rnd() < 0.7, scarf = rnd() < 0.3, hs = rnd(), w = 0.36 + rnd() * 0.08, h = rnd() * 0.06;
        if (empty) continue;
        const stand = cheer && up, lift = stand ? 0.2 : 0, cx = X(x);
        // torso, lit from above
        const tg = g.createLinearGradient(0, Y(0.62 + lift + h), 0, Y(0));
        tg.addColorStop(0, shirt); tg.addColorStop(1, '#000');
        g.fillStyle = tg;
        g.beginPath();
        g.moveTo(cx - X(w / 2), Y(0)); g.lineTo(cx - X(w / 2), Y(0.5 + lift + h));
        g.quadraticCurveTo(cx - X(w / 2), Y(0.6 + lift + h), cx - X(w / 2 - 0.08), Y(0.6 + lift + h));
        g.lineTo(cx + X(w / 2 - 0.08), Y(0.6 + lift + h));
        g.quadraticCurveTo(cx + X(w / 2), Y(0.6 + lift + h), cx + X(w / 2), Y(0.5 + lift + h));
        g.lineTo(cx + X(w / 2), Y(0)); g.closePath(); g.fill();
        // arms: raised when cheering, a scarf held high by some
        if (stand) {
          g.strokeStyle = skin; g.lineWidth = X(0.07); g.lineCap = 'round';
          const sh = Y(0.55 + lift + h), hy = Y(0.95);
          g.beginPath(); g.moveTo(cx - X(w / 2 - 0.04), sh); g.lineTo(cx - X(w / 2 + 0.06), Y(0.8)); g.lineTo(cx - X(w / 2 - 0.02), hy); g.stroke();
          g.beginPath(); g.moveTo(cx + X(w / 2 - 0.04), sh); g.lineTo(cx + X(w / 2 + 0.06), Y(0.8)); g.lineTo(cx + X(w / 2 - 0.02), hy); g.stroke();
          if (scarf) { g.fillStyle = shirt; g.fillRect(cx - X(w / 2 + 0.04), hy - 1, X(w + 0.08), Y(0.9) - hy + 2); }
        }
        // head and hair
        const hy = Y(0.72 + lift + h), hr = X(0.095);
        g.save(); g.translate(cx, hy); g.scale(1, sy / sx); // round in metres on the anisotropic strip
        g.fillStyle = skin; g.beginPath(); g.ellipse(0, 0, hr, hr, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(0,0,0,.25)'; g.beginPath(); g.ellipse(hr * 0.3, hr * 0.2, hr * 0.7, hr * 0.7, 0, 0, Math.PI * 2); g.fill();
        if (hs < 0.85) {
          g.fillStyle = hair; g.beginPath();
          if (hs < 0.15) { g.ellipse(0, -hr * 0.3, hr * 1.05, hr * 0.75, 0, Math.PI, 0); g.fillRect(-hr * 1.05, -hr * 0.35, hr * 2.6, hr * 0.3); } // cap
          else if (hs < 0.4) { g.ellipse(0, -hr * 0.1, hr * 1.1, hr * 1.05, 0, Math.PI * 0.95, Math.PI * 2.05); g.fillRect(-hr * 1.1, -hr * 0.1, hr * 0.45, hr * 1.4); g.fillRect(hr * 0.65, -hr * 0.1, hr * 0.45, hr * 1.4); } // long
          else g.ellipse(0, -hr * 0.2, hr * 1.02, hr * 0.85, 0, Math.PI * 1.02, Math.PI * 1.98);
          g.fill();
        }
        g.restore();
      }
    }
  });
  t.wrapS = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
}
// a shuttle's skirt: sixteen feathers over a thread band
function skirtTexture() {
  return canvasTex(256, 64, (g, W, H) => {
    g.clearRect(0, 0, W, H);
    for (let i = 0; i < 16; i++) {
      const x0 = i * W / 16, x1 = x0 + W / 16;
      const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#dfe3e8');
      g.fillStyle = gr; g.beginPath();
      g.moveTo(x0 + 2, H); g.lineTo(x0 + 1, 10); g.quadraticCurveTo((x0 + x1) / 2, 0, x1 - 1, 10); g.lineTo(x1 - 2, H); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(150,160,170,.7)'; g.lineWidth = 1; g.beginPath(); g.moveTo((x0 + x1) / 2, H); g.lineTo((x0 + x1) / 2, 6); g.stroke();
    }
    g.fillStyle = '#22262c'; g.fillRect(0, H - 22, W, 3); g.fillRect(0, H - 34, W, 2); // thread bands
  });
}

// ---------------------------------------------------------------- the hall
// A tournament hall at night: the house lights down, the court under a rig of lamps, LED boards
// round the field of play and a full crowd in raked seating on all four sides. Built once; per
// frame it costs a scrolling texture offset and a few uniforms.
const beamVert = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const beamFrag = `varying vec2 vUv; uniform float uStrength; uniform vec3 uColor;
void main(){
  float along = pow(clamp(vUv.y, 0.0, 1.0), 1.6);                       // brightest at the lamp, gone before the floor
  float edge = max(0.0, sin(vUv.x * 3.14159265));                // soft sides as the cone turns away
  gl_FragColor = vec4(uColor * along * edge * edge * uStrength, 1.0);
}`;

function buildHall(scene, tier) {
  const hi = tier === 'high', lite = tier === 'lite';
  const statics = [];
  const add = (m, list = statics) => { scene.add(m); list.push(m); return m; };
  // hall floor beyond the field of play
  const hallFloor = new THREE.Mesh(new THREE.PlaneGeometry(90, 90).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x0b0f16 }));
  hallFloor.position.y = -0.01; hallFloor.receiveShadow = hi; scene.add(hallFloor);

  // LED boards round the field of play, leaning back a little as real ones do
  const bTex = boardTexture();
  const boardMats = [];
  let boardCursor = 0, boardTime = 0, messageKey = '';
  const back = new THREE.MeshLambertMaterial({ color: 0x0a0d13 });
  const BH = 0.82;
  const glowTex = canvasTex(4, 64, (g, w, h) => { const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h); });
  const glowMat = new THREE.MeshBasicMaterial({ map: glowTex, color: 0x4f8fff, transparent: true, opacity: lite ? 0.18 : 0.26, blending: THREE.AdditiveBlending, depthWrite: false });
  const board = (len, x, z, rotY) => {
    const t = bTex.clone(); t.needsUpdate = true; t.repeat.set(len / 30, 1); t.offset.x = boardCursor / 30;
    const face = new THREE.MeshBasicMaterial({ map: t, color: 0xe8ecff });
    boardMats.push({ tex: t, start: boardCursor }); boardCursor += len;
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rotY; scene.add(g);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(len, BH), face);
    panel.position.set(0, BH / 2 + 0.02, 0); panel.rotation.x = -0.12; g.add(panel);
    const box = new THREE.Mesh(new THREE.BoxGeometry(len, BH, 0.22), back);
    box.position.set(0, BH / 2 + 0.02, -0.16); box.rotation.x = -0.12; g.add(box);
    // the boards' light spilling onto the mat in front of them
    const sp = new THREE.Mesh(new THREE.PlaneGeometry(len, 1.6).rotateX(-Math.PI / 2), glowMat);
    sp.position.set(0, 0.006, 0.8); sp.rotation.y = Math.PI; g.add(sp);
  };
  const BX = FOP_X + 0.1, BZ = FOP_Y + 0.1;
  board(2 * BX, 0, -BZ, 0);                 // sides (face the court)
  board(2 * BZ - 0.6, BX, 0, -Math.PI / 2);
  board(2 * BX, 0, BZ, Math.PI);
  board(2 * BZ - 0.6, -BX, 0, Math.PI / 2); // ends

  // raked seating on all four sides. The crowd is baked: every row of fans is painted once into a
  // strip of a texture (crowdAtlas) and stands on its step as a single upright card, so the whole
  // audience is one static draw with nothing simulated per frame. A point swaps in the cheering
  // sheet for a moment.
  const seatMat = new THREE.MeshLambertMaterial({ color: 0x151b26 });
  const riserMat = new THREE.MeshLambertMaterial({ color: 0x0e131c });
  const ROWS = lite ? 8 : 12, DEPTH = 0.86, RISE = 0.44, GAP = 1.3, ROW_H = 0.95;
  const cards = { pos: [], uv: [], col: [], idx: [] };
  let row = 0;
  const card = (a, b, y, shade) => { // a, b: the card's bottom corners (world), y: their height
    const n = cards.pos.length / 3, strip = row++ % CROWD_STRIPS, len = a.distanceTo(b);
    const v0 = 1 - (strip + 1) / CROWD_STRIPS + CROWD_PAD, v1 = 1 - strip / CROWD_STRIPS - CROWD_PAD, u0 = (row * 0.37) % 1, u1 = u0 + len / CROWD_SPAN;
    cards.pos.push(a.x, y, a.z, b.x, y, b.z, b.x, y + ROW_H, b.z, a.x, y + ROW_H, a.z);
    cards.uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    for (let k = 0; k < 4; k++) cards.col.push(shade, shade, shade * 1.05);
    cards.idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
  };
  const stand = (len, dist, rotY) => {
    const grp = new THREE.Group(); grp.rotation.y = rotY; scene.add(grp);
    // front wall under the first row
    const wall = new THREE.Mesh(new THREE.BoxGeometry(len, 1.1, 0.2), riserMat); wall.position.set(0, 0.55, -dist); grp.add(wall);
    const Y = new THREE.Vector3(0, 1, 0);
    for (let r = 0; r < ROWS; r++) {
      const d = dist + GAP + r * DEPTH, y = 1.1 + r * RISE, L = len + r * 1.1;
      const step = new THREE.Mesh(new THREE.BoxGeometry(L, y, DEPTH), r % 2 ? seatMat : riserMat);
      step.position.set(0, y / 2, -d); grp.add(step);
      const u = r / (ROWS - 1);
      card(new THREE.Vector3(-L / 2 + 0.2, 0, -d + 0.1).applyAxisAngle(Y, rotY), new THREE.Vector3(L / 2 - 0.2, 0, -d + 0.1).applyAxisAngle(Y, rotY), y - 0.05, 0.62 - 0.32 * u);
    }
    grp.updateMatrixWorld(true);
    grp.traverse(o => { if (o.isMesh) statics.push(o); });
  };
  stand(2 * BX + 2, BZ + 0.25, 0);
  stand(2 * BX + 2, BZ + 0.25, Math.PI);
  stand(2 * BZ + 1, BX + 0.25, Math.PI / 2);
  stand(2 * BZ + 1, BX + 0.25, -Math.PI / 2);
  const crowdGeo = new THREE.BufferGeometry();
  crowdGeo.setAttribute('position', new THREE.Float32BufferAttribute(cards.pos, 3));
  crowdGeo.setAttribute('uv', new THREE.Float32BufferAttribute(cards.uv, 2));
  crowdGeo.setAttribute('color', new THREE.Float32BufferAttribute(cards.col, 3));
  crowdGeo.setIndex(cards.idx);
  const sheets = [crowdAtlas(false), crowdAtlas(true)];
  const crowdMat = new THREE.MeshBasicMaterial({ map: sheets[0], vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide });
  const crowd = new THREE.Mesh(crowdGeo, crowdMat); scene.add(crowd);

  // the roof: a dark lid, two lighting trusses over the court and their lamps
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(90, 90).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x05070b }));
  roof.position.y = 16; scene.add(roof);
  const trussMat = new THREE.MeshLambertMaterial({ color: 0x1b212b });
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.98, 0.94), toneMapped: false });
  const haloMat = new THREE.SpriteMaterial({ map: blobTexture('rgba(255,248,235,.85)', 'rgba(255,248,235,0)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const beamMat = !hi ? null : new THREE.ShaderMaterial({ vertexShader: beamVert, fragmentShader: beamFrag, uniforms: { uStrength: { value: 0.035 }, uColor: { value: new THREE.Color(0.95, 0.96, 1.0) } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const TY = 11.5;
  for (const tz of [-(CT.W + 0.4), CT.W + 0.4]) {
    const truss = new THREE.Mesh(new THREE.BoxGeometry(2 * CT.L + 2, 0.45, 0.45), trussMat); truss.position.set(0, TY + 0.4, tz); add(truss);
    for (let i = 0; i < 6; i++) {
      const lx = (i / 5 - 0.5) * 2 * (CT.L - 1);
      const head = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, 0.34, 16), trussMat); head.position.set(lx, TY, tz); add(head);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.3, 20).rotateX(Math.PI / 2), lampMat); lens.position.set(lx, TY - 0.18, tz); add(lens);
      const halo = new THREE.Sprite(haloMat); halo.scale.setScalar(1.3); halo.position.set(lx, TY - 0.3, tz); scene.add(halo);
      if (beamMat) { // faint shafts of light through the haze, lamp to floor
        const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 2.4, TY - 0.2, 20, 1, true), beamMat);
        cone.position.set(lx, (TY - 0.2) / 2, tz * 0.85); cone.rotation.x = tz > 0 ? -0.06 : 0.06; cone.renderOrder = 5; scene.add(cone);
      }
    }
  }
  // house lights: small warm points dotted over the dark roof above the stands
  const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.85, 0.6), toneMapped: false }), 80);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < 80; i++) { const a = Math.random() * Math.PI * 2, r = 14 + Math.random() * 10; m4.makeTranslation(Math.cos(a) * r, 14.5 + Math.random(), Math.sin(a) * r); dots.setMatrixAt(i, m4); }
  scene.add(dots);

  // the umpire's chair at the net, on the side away from the benches
  const chairMat = new THREE.MeshLambertMaterial({ color: 0x2a3140 });
  const chair = new THREE.Group(); chair.position.set(0, 0, -(CT.DW + 1.1)); scene.add(chair);
  for (const [dx, dz] of [[-0.35, -0.3], [0.35, -0.3], [-0.35, 0.3], [0.35, 0.3]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 1.9, 8), chairMat); leg.position.set(dx, 0.95, dz); chair.add(leg);
  }
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.06, 0.75), chairMat); deck.position.y = 1.9; chair.add(deck);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.06, 0.42), new THREE.MeshLambertMaterial({ color: 0x1d5fa8 })); seat.position.set(0, 2.35, -0.12); chair.add(seat);
  const seatBack = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.5, 0.05), seat.material); seatBack.position.set(0, 2.62, -0.33); chair.add(seatBack);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.42, 8), chairMat); stem.position.set(0, 2.12, -0.12); chair.add(stem);
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.04, 0.04), chairMat); rail.position.set(0, 2.35, 0.36); chair.add(rail);
  for (const dx of [-0.4, 0.4]) { const r = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.45, 6), chairMat); r.position.set(dx, 2.13, 0.36); chair.add(r); }
  const desk = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.25), chairMat); desk.position.set(0, 2.55, 0.25); chair.add(desk);

  // every static mesh above (stands, trusses, lamp heads, the chair) collapses to one draw per material
  chair.updateMatrixWorld(true);
  chair.traverse(o => { if (o.isMesh) statics.push(o); });
  mergeStatic(scene, statics);

  let cheer = 0;
  return {
    update(dt, rv) {
      boardTime += dt;
      for (const b of boardMats) b.tex.offset.x = (b.start / 30 + boardTime * 0.6 / 30) % 1;
      const score = rv?.score || [0,0], names = rv?.names || ['RED','BLUE'];
      const text = rv?.match ? `${names[0].slice(0,18)}  ${score[0]} : ${score[1]}  ${names[1].slice(0,18)}${Math.max(...score) === CT.POINTS-1 ? '  /  MATCH POINT' : '  /  WINNER STAYS ON'}` : 'OFFICE BADMINTON  /  THE OFFICE OPEN';
      if (messageKey !== text) {
        messageKey = text; const next = boardTexture(text.toUpperCase());
        for(const b of boardMats){b.tex.image=next.image;b.tex.needsUpdate=true;} next.dispose();
      }
      if (cheer > 0 && (cheer -= dt) <= 0) crowdMat.map = sheets[0];
    },
    point() { cheer = 2.2; crowdMat.map = sheets[1]; },
    people: CROWD_PER_STRIP * row, crowd,
  };
}

// ---------------------------------------------------------------- renderer
export async function createRenderer(canvas, { tier = 'high', boot } = {}) {
  CT = window.BM.C; FOP_X = CT.L + 2.9; FOP_Y = CT.DW + 1.9;
  const hi = tier === 'high', mid = tier === 'medium', lite = !hi && !mid;
  // MSAA on the canvas itself (no post chain: a full-screen HDR pass cost more than the whole scene)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: hi || mid, powerPreference: 'high-performance', alpha: false, stencil: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = hi; // medium and lite ground the players with contact shadows instead
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070b);
  scene.fog = new THREE.Fog(0x05070b, 22, 48);

  // the rig: a strong, slightly warm top light over the court (it casts the shadows), a spot that
  // pools light on the field of play so the stands fall away into the dark, and a cool fill from
  // the camera ends so faces and kits read
  scene.add(new THREE.HemisphereLight(0xb8ccff, 0x10141c, 0.7));
  const key = new THREE.DirectionalLight(0xfff4e6, 2.3);
  key.position.set(1.5, 14, 3);
  if (hi) {
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const s = CT.L + 2;
    Object.assign(key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 4, far: 26 });
    key.shadow.bias = -0.0008; key.shadow.normalBias = 0.02; key.shadow.radius = 3;
  }
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xc8dcff, 0.6); fill.position.set(-12, 6, 2); scene.add(fill);

  // Fine vinyl micrograin and roughness are tiled in world scale independently of the court paint.
  const courtTex = courtTexture(); courtTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const surfaceMaps = await Promise.all(['mat-normal.jpg','mat-roughness.jpg'].map(async name => {
    try { const t=await new THREE.TextureLoader().loadAsync(presentationUrl(name));t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(2*FOP_X/1.2,2*FOP_Y/1.2);t.anisotropy=Math.min(4,renderer.capabilities.getMaxAnisotropy());return t; } catch { return null; }
  }));
  const floorMat = hi
    ? new THREE.MeshStandardMaterial({map:courtTex,normalMap:surfaceMaps[0],normalScale:new THREE.Vector2(0.18,0.18),roughnessMap:surfaceMaps[1],roughness:0.96,metalness:0,envMapIntensity:0.15})
    : new THREE.MeshPhongMaterial({map:courtTex,normalMap:lite?null:surfaceMaps[0],normalScale:new THREE.Vector2(0.13,0.13),specular:0x141917,shininess:9});
  if (hi) {
    // Vinyl sports flooring stays matte even where the source roughness map is smoother.
    floorMat.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor = max(0.82, roughnessFactor);');};
    floorMat.customProgramCacheKey=()=> 'badminton-matte-vinyl-v1';
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2 * FOP_X, 2 * FOP_Y), floorMat);
  floor.name='Indoor sports mat';
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = hi;
  scene.add(floor);
  const hall = buildHall(scene, tier);

  // net: posts on weighted feet, the mesh hanging from 1.55 m at the posts to 1.524 m mid-court
  const postMat = new THREE.MeshStandardMaterial({ color: 0x1c2330, roughness: 0.4, metalness: 0.6 });
  const footMat = new THREE.MeshStandardMaterial({ color: 0x0f141c, roughness: 0.6, metalness: 0.3 });
  const PZ = CT.DW + 0.05; // the posts stand on the doubles sidelines
  for (const z of [-PZ, PZ]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 1.58, 14), postMat);
    post.position.set(0, 0.79, z); post.castShadow = hi; scene.add(post);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.1, 20), footMat);
    foot.position.set(0, 0.05, z + Math.sign(z) * 0.08); scene.add(foot);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.038, 12, 8), new THREE.MeshStandardMaterial({ color: 0xe4ff3c, roughness: 0.5 }));
    cap.position.set(0, 1.585, z); scene.add(cap);
  }
  const NET_D = 0.76;
  const netDynamics = new NetDynamics(2 * PZ, NET_D, lite ? 24 : 40, lite ? 6 : 10);
  // the look (net-look.js): real-scale knotted netting on a smooth display mesh, the folded tape,
  // side bands and cord as geometry, all following the cloth
  const netLook = createNetLook({ renderer, dynamics: netDynamics, tier });
  const net = netLook.mesh;
  net.position.set(0, 1.55 - NET_D / 2, 0); net.rotation.y = Math.PI / 2; scene.add(net);
  let netActive = 0;

  // players: the real rigged characters, loaded from the same assets as football
  const A = await loadPlayerAssets(renderer, boot, { extraSteps: 2, lite: tier === 'lite' });
  scene.environment = A.env;
  if ('environmentIntensity' in scene) scene.environmentIntensity = 0.45;
  const players = [0, 1].map(i => new Athlete(scene, KITS[i], A, lookFor));
  const heatVfx = createHeatVfx(scene, tier, renderer);
  if (boot.playersReady) boot.playersReady();
  const portrait = createPortrait();
  // contact shadows: a soft dark pool under each player, which grounds them on every tier
  const blob = blobTexture('rgba(0,0,0,.75)', 'rgba(0,0,0,0)');
  const feet = players.map(() => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: blob, transparent: true, depthWrite: false, opacity: hi ? 0.55 : 0.8 }));
    m.position.y = 0.008; m.renderOrder = 1; scene.add(m); return m;
  });

  // shuttle: cork nose leading (local -y is the flight direction), feather skirt flaring behind
  const shuttle = new THREE.Group();
  const cork = new THREE.Mesh(new THREE.SphereGeometry(0.0135, 16, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xfbf7ef, roughness: 0.5 }));
  shuttle.add(cork);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.0138, 0.0138, 0.01, 16), new THREE.MeshStandardMaterial({ color: 0xe4ff3c, roughness: 0.6 }));
  band.position.y = 0.005; shuttle.add(band);
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.013, 0.068, 16, 1, true), new THREE.MeshStandardMaterial({ map: skirtTexture(), transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.8 }));
  skirt.position.y = 0.01 + 0.034; shuttle.add(skirt);
  // an ink outline, Nintendo-style: slightly larger dark hulls of the cork and the skirt, drawn
  // from their back faces only, so they show just as a rim round the silhouette. It keeps the
  // shuttle readable against the court, the lines and the crowd without making it glow.
  const ink = new THREE.MeshBasicMaterial({ color: 0x0d1838, side: THREE.BackSide, fog: false });
  const corkInk = new THREE.Mesh(new THREE.SphereGeometry(0.0135 * 1.32, 16, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), ink);
  const skirtInk = new THREE.Mesh(new THREE.CylinderGeometry(0.033 * 1.16, 0.013 * 1.3, 0.068 * 1.08, 16, 1, false), ink);
  skirtInk.position.y = skirt.position.y; shuttle.add(corkInk, skirtInk);
  shuttle.traverse(o => { if (o.isMesh) o.castShadow = false; });
  const SH_SCALE = 2.4; // larger than life, and never smaller on screen than SH_PX (see the frame)
  const SH_PX = 16;
  scene.add(shuttle);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: blobTexture('rgba(255,255,255,.9)', 'rgba(255,255,255,0)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  halo.scale.setScalar(0.35); scene.add(halo);
  // the beacon: a glow and a crisp ring round the shuttle, drawn over everything (bodies, the net),
  // held at a constant size on screen. It is how the eye finds the shuttle when a player is in the
  // way. Lime when it is coming at you, pale blue when it is going away.
  const ringTex = canvasTex(128, 128, (g, W) => { g.strokeStyle = '#fff'; g.lineWidth = 10; g.beginPath(); g.arc(W / 2, W / 2, W / 2 - 10, 0, Math.PI * 2); g.stroke(); });
  const beaconGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo.material.map, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false }));
  const beaconRing = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, transparent: true, depthWrite: false, depthTest: false, fog: false }));
  beaconGlow.renderOrder = 20; beaconRing.renderOrder = 21; scene.add(beaconGlow, beaconRing);
  // (superseded by shuttle-fx.js: the crafted beacon, trail and glint; the sprites stay for the
  // halo's texture, which the sparks and dust share)
  beaconGlow.visible = beaconRing.visible = halo.visible = false;
  const shuttleFx = createShuttleFx(scene);
  // smashes: contact flash and shockwave, cracked court and debris on a winner, the screen
  // shattering on the hardest (smash-fx.js)
  const smashFx = createSmashFx({ scene, renderer, tier });
  let lastSmash = 0; // the power (0..1) of the latest smash contact, for the slam it ends in
  const shotVel = new THREE.Vector3(); // the shuttle's world velocity: which way contact glass is thrown
  // the drop line: shuttle straight down to its shadow, so its height reads at a glance
  const dropGeo = new THREE.BufferGeometry(); dropGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const dropLine = new THREE.Line(dropGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false }));
  dropLine.frustumCulled = false; dropLine.renderOrder = 4; scene.add(dropLine);
  // the countdown: a ring round the landing spot that closes in as the shuttle comes down
  const countRing = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.5, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xe4ff3c, transparent: true, opacity: 0, depthWrite: false }));
  countRing.renderOrder = 2; scene.add(countRing);
  // your reach: a faint ring round your feet at racket's length, gold when the shuttle is hittable
  const reachRing = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
  reachRing.renderOrder = 2; scene.add(reachRing);
  // the tell: a red pulse under an opponent winding up an overhead (brace for the smash)
  const tellRing = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.72, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff4a3a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  tellRing.renderOrder = 2; scene.add(tellRing);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: blob, transparent: true, opacity: 0.35, depthWrite: false }));
  shadow.position.y = 0.012; shadow.renderOrder = 2; scene.add(shadow);
  // landing marker: a thin ring with a dot, in the HUD's lime
  const markTex = canvasTex(128, 128, (g, W) => { g.strokeStyle = '#fff'; g.lineWidth = 7; g.beginPath(); g.arc(W / 2, W / 2, W / 2 - 8, 0, Math.PI * 2); g.stroke(); g.fillStyle = '#fff'; g.beginPath(); g.arc(W / 2, W / 2, 9, 0, Math.PI * 2); g.fill(); });
  const marker = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: markTex, color: 0xe4ff3c, transparent: true, opacity: 0.55, depthWrite: false }));
  marker.position.y = 0.014; marker.renderOrder = 2; scene.add(marker);

  // trail: a camera-facing ribbon that tapers to nothing, coloured by the last shot
  const TRAIL = 22;
  const trailPts = Array.from({ length: TRAIL }, () => new THREE.Vector3());
  const ribPos = new Float32Array(TRAIL * 2 * 3), ribA = new Float32Array(TRAIL * 2);
  const ribGeo = new THREE.BufferGeometry();
  ribGeo.setAttribute('position', new THREE.BufferAttribute(ribPos, 3));
  ribGeo.setAttribute('alpha', new THREE.BufferAttribute(ribA, 1));
  const ribIdx = []; for (let i = 0; i < TRAIL - 1; i++) { const a = i * 2; ribIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  ribGeo.setIndex(ribIdx);
  const trailMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0xe4ff3c) }, uOpacity: { value: 0.8 } },
    vertexShader: `attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying float vA; void main(){ gl_FragColor = vec4(uColor * (1.0 + 2.0 * vA), vA * uOpacity); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const trail = new THREE.Mesh(ribGeo, trailMat); trail.frustumCulled = false; trail.renderOrder = 3; scene.add(trail);
  let trailN = 0, trailAcc = 0, trailFade = 0;

  // impact: an expanding ring, a flash and (on smashes) a spray of sparks
  const rings = [];
  for (let i = 0; i < 4; i++) {
    const r = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.2, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    r.visible = false; scene.add(r);
    const f = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo.material.map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    f.visible = false; scene.add(f);
    rings.push({ mesh: r, flash: f, t: 0, life: 0, scale: 1 });
  }
  const SPARKS = 48;
  const sparkPos = new Float32Array(SPARKS * 3), sparkVel = new Float32Array(SPARKS * 3), sparkLife = new Float32Array(SPARKS);
  const sparkGeo = new THREE.BufferGeometry(); sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  const sparkMat = new THREE.PointsMaterial({ color: 0xffd34d, size: 0.06, map: halo.material.map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const sparks = new THREE.Points(sparkGeo, sparkMat); sparks.frustumCulled = false; scene.add(sparks);
  let sparkHead = 0;
  for (let i = 0; i < SPARKS; i++) sparkPos[i * 3 + 1] = -10;

  // dust: soft puffs kicked up off the mat by takeoffs, landings and slams
  const DUST = 96;
  const dustPos = new Float32Array(DUST * 3), dustVel = new Float32Array(DUST * 3), dustLife = new Float32Array(DUST), dustSize = new Float32Array(DUST);
  const dustGeo = new THREE.BufferGeometry(); dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3)); dustGeo.setAttribute('size', new THREE.BufferAttribute(dustSize, 1));
  const dustMat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: halo.material.map }, uScale: { value: 400 } },
    vertexShader: `attribute float size; varying float vA; void main(){ vA = clamp(size, 0.0, 1.0); vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = (0.1 + (1.0 - vA) * 0.5) * 400.0 / -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform sampler2D uMap; varying float vA; void main(){ vec4 t = texture2D(uMap, gl_PointCoord); gl_FragColor = vec4(vec3(0.78, 0.8, 0.84), t.a * vA * 0.35); }`,
    transparent: true, depthWrite: false,
  });
  const dustPts = new THREE.Points(dustGeo, dustMat); dustPts.frustumCulled = false; scene.add(dustPts);
  let dustHead = 0;
  for (let i = 0; i < DUST; i++) dustPos[i * 3 + 1] = -10;
  function dust(x, y, amount) {
    const n = Math.round(10 * amount);
    for (let k = 0; k < n; k++) {
      const i = dustHead; dustHead = (dustHead + 1) % DUST;
      const a = Math.random() * Math.PI * 2, v = (0.6 + Math.random()) * amount;
      dustPos.set([x + Math.cos(a) * 0.15, 0.04, y + Math.sin(a) * 0.15], i * 3);
      dustVel.set([Math.cos(a) * v, 0.25 + Math.random() * 0.5 * amount, Math.sin(a) * v], i * 3);
      dustLife[i] = 0.5 + Math.random() * 0.4; dustSize[i] = 1;
    }
  }
  const slams = [0, 1].map(() => {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff8a3c, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    m.visible = false; m.renderOrder = 2; scene.add(m); return { mesh: m, t: 1, life: 0, k: 1 };
  });
  // the racket's swoosh: a ribbon along the head's last few positions, visible only at speed
  const SW = 10;
  const swooshes = [0, 1].map(() => {
    const pos = new Float32Array(SW * 2 * 3), al = new Float32Array(SW * 2);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('alpha', new THREE.BufferAttribute(al, 1));
    const idx = []; for (let i = 0; i < SW - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color(0xeaf6ff) }, uOpacity: { value: 0 } },
      vertexShader: `attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying float vA; void main(){ gl_FragColor = vec4(uColor, vA * uOpacity); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    m.frustumCulled = false; m.renderOrder = 3; scene.add(m);
    return { m, pos, al, g };
  });
  function updateSwoosh(i) {
    const A = players[i], S = swooshes[i], pts = A.whoosh;
    const sp = A.swingSpeed || 0, o = clamp((sp - 9) / 14, 0, 1) * (players[i].root.visible ? 1 : 0);
    S.m.material.uniforms.uOpacity.value = o * 0.35;
    S.m.visible = o > 0.01 && pts.length > 2;
    if (!S.m.visible) return;
    for (let k = 0; k < SW; k++) {
      const q = pts[Math.min(k, pts.length - 1)].p, nxt = pts[Math.min(k + 1, pts.length - 1)].p;
      tmp.subVectors(q, nxt); if (tmp.lengthSq() < 1e-8) tmp.set(0, 1, 0);
      side3.subVectors(camera.position, q).cross(tmp).normalize();
      const f = 1 - k / (SW - 1), w = 0.05 * f;
      S.pos.set([q.x + side3.x * w, q.y + side3.y * w, q.z + side3.z * w, q.x - side3.x * w, q.y - side3.y * w, q.z - side3.z * w], k * 6);
      S.al[k * 2] = S.al[k * 2 + 1] = f * f;
    }
    S.g.attributes.position.needsUpdate = true; S.g.attributes.alpha.needsUpdate = true;
  }
  const aimGroup = new THREE.Group(); scene.add(aimGroup);
  const aimTex = canvasTex(32, 256, (g, w, h) => { const gr = g.createLinearGradient(0, h, 0, 0); gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.beginPath(); g.moveTo(w * 0.3, h); g.lineTo(w * 0.7, h); g.lineTo(w * 0.5, 0); g.fill(); });
  const aimLine = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: aimTex, color: 0xe4ff3c, transparent: true, opacity: 0.0, depthWrite: false }));
  aimLine.geometry.translate(0, 0, -0.5); aimLine.rotation.y = Math.PI;
  aimLine.position.set(0, 0.016, 0.35); aimGroup.add(aimLine);

  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 160);
  // High and behind, aimed into your own half. Solved (not eyeballed) so the near baseline sits at
  // ~90% of the screen height, the far baseline stays well on screen, and a clear 7 m above your
  // back court is still in frame: you look over your own player at the court, not through them.
  const CAM_D = CT.L + 6, CAM_H = 8.5, CAM_AIM = 2;
  // ---- the camera rig: broadcast framing behind your own end.
  // Every frame it works out what matters (you, the shuttle with its height, where it is coming
  // down, and the opponent, whose wind-up you need to read), aims at a weighted focus of them, and
  // solves for the closest distance, along a fixed 32-degree broadcast elevation, that keeps
  // every one of them inside a safe margin of the screen. Focus and distance then follow on
  // critically damped springs: smooth, no overshoot; quick to widen when the shuttle climbs,
  // slow to tighten again, so the view breathes with the rally instead of lurching.
  const EL = 32 * Math.PI / 180, D_MIN = 11.5, D_MAX = 21, MARGIN_X = 0.07, MARGIN_TOP = 0.07, MARGIN_BOT = 0.1;
  const probe = new THREE.PerspectiveCamera();
  const rig = { f: null, fv: [0, 0, 0], d: CAM_D + 2, dv: [0], side: -1, sv: [0] };
  const pts = Array.from({ length: 8 }, () => new THREE.Vector3());
  // Unity-style SmoothDamp: a critically damped spring toward target, stable at any frame rate
  function damp(cur, target, vel, i, T, dt) {
    const om = 2 / T, x = om * dt, ex = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const ch = cur - target, tmpv = (vel[i] + om * ch) * dt;
    vel[i] = (vel[i] - om * tmpv) * ex;
    return target + (ch + tmpv) * ex;
  }
  function placeCamera(cam, f, d, side) {
    cam.position.set(f.x + side * Math.cos(EL) * d, f.y + Math.sin(EL) * d + safeBottom * 2.4, f.z);
    cam.lookAt(f.x, f.y, f.z);
    cam.updateMatrixWorld(); cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  }
  function fits(f, d, side, n) {
    probe.fov = camera.fov; probe.aspect = camera.aspect; probe.near = camera.near; probe.far = camera.far; probe.updateProjectionMatrix();
    placeCamera(probe, f, d, side);
    for (let i = 0; i < n; i++) {
      const v = tmp.copy(pts[i]).project(probe);
      if (v.z > 1) return false;
      const sx = v.x * 0.5 + 0.5, sy = 0.5 - v.y * 0.5;
      if (sx < MARGIN_X || sx > 1 - MARGIN_X || sy < MARGIN_TOP || sy > 1 - MARGIN_BOT) return false;
    }
    return true;
  }
  function rigCamera(world, b, my, rv, dt) {
    const side = my === 1 ? 1 : -1;
    rig.side = damp(rig.side, side, rig.sv, 0, 0.6, dt); // (only moves when you change ends)
    const me = world.players[my >= 0 ? my : 0], op = world.players[my >= 0 ? 1 - my : 1];
    const land = rv.pred && rv.pred.land;
    // what must be in shot (world coordinates: x, height, y)
    let n = 0;
    const put = (x, h, y) => pts[n++].set(x, h, y);
    put(me[0], 0, me[1]); put(me[0], 2.1 + (me[14] || 0), me[1]);          // you, feet to racket
    put(b[0], Math.max(0.2, b[2]), b[1]);                                   // the shuttle, at its height
    if (land) put(land.x, 0, land.y);                                       // where it is coming down
    put(op[0], 0, op[1]); put(op[0], 2.0, op[1]);                          // the opponent: their wind-up is a tell
    // the focus: you, the shuttle and where it is going, weighted; height follows the shuttle a little
    const lx = land ? land.x : b[0], ly = land ? land.y : b[1];
    const fx = me[0] * 0.42 + b[0] * 0.3 + lx * 0.28, fy = me[1] * 0.42 + b[1] * 0.3 + ly * 0.28;
    const fh = clamp(0.35 + b[2] * 0.12, 0.35, 1.4);
    const want = { x: fx, y: fh, z: fy };
    if (!rig.f) rig.f = { ...want };
    const f = rig.f;
    f.x = damp(f.x, want.x, rig.fv, 0, 0.32, dt);
    f.y = damp(f.y, want.y, rig.fv, 1, 0.45, dt);
    f.z = damp(f.z, want.z, rig.fv, 2, 0.4, dt);
    // the closest distance that frames everything, by bisection (monotone: further always fits more)
    let lo = D_MIN, hi = D_MAX;
    if (fits(f, lo, rig.side, n)) hi = lo;
    else for (let k = 0; k < 9; k++) { const mid = (lo + hi) / 2; if (fits(f, mid, rig.side, n)) hi = mid; else lo = mid; }
    const needD = hi + 0.4;
    // widen fast (never lose the shuttle), tighten slowly (never lurch)
    rig.d = damp(rig.d, needD, rig.dv, 0, needD > rig.d ? 0.22 : 0.9, dt);
    placeCamera(camera, f, Math.max(D_MIN * 0.9, rig.d - zoomBoost - swellZoom), rig.side);
    camTarget.set(f.x, f.y, f.z);
  }
  camera.position.set(-CAM_D, CAM_H, 0);
  const camTarget = new THREE.Vector3(-2, 0, 0);
  let camSide = -1, shake = 0, safeBottom = 0, zoomBoost = 0, swellZoom = 0; // (swellZoom: the camera leaning in on a long rally)
  let w = 1, h = 1, lastT = performance.now();

  // adaptive resolution: the frame interval is watched, and the render scale steps down when the
  // machine can't hold its cadence (and back up once it has headroom). Changes are rare, so a
  // resize never lands as a hitch in the middle of a rally.
  const basePR = Math.min(devicePixelRatio || 1, hi ? 1.5 : mid ? 1.25 : 1);
  let scale = 1, slowT = 0, fastT = 0, lastScaleAt = 0, avgMs = 16.7;
  function applySize() {
    renderer.setPixelRatio(basePR * scale);
    renderer.setSize(w, h, false);
  }
  function resize(wd, ht) {
    w = Math.max(2, wd); h = Math.max(2, ht);
    applySize();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  function adapt(dtMs, now) {
    if (dtMs <= 0 || dtMs > 250) return;          // a tab switch or a stall, not a trend
    avgMs += (dtMs - avgMs) * 0.05;
    if (avgMs > 20) { slowT += dtMs; fastT = 0; } else if (avgMs < 14.5) { fastT += dtMs; slowT = 0; } else { slowT = fastT = 0; }
    if (now - lastScaleAt < 2000) return;
    if (slowT > 1200 && scale > 0.55) { scale = Math.max(0.55, scale - 0.15); applySize(); lastScaleAt = now; slowT = 0; }
    else if (fastT > 5000 && scale < 1) { scale = Math.min(1, scale + 0.1); applySize(); lastScaleAt = now; fastT = 0; }
  }

  function impactRing(x, y, z, color, scale, flash) {
    const r = rings.find(r => r.t >= r.life) || rings[0];
    r.t = 0; r.life = 0.35; r.scale = scale; r.flashA = flash;
    r.mesh.visible = true; r.flash.visible = flash > 0;
    r.mesh.position.set(...W2(x, y, z)); r.flash.position.copy(r.mesh.position);
    r.mesh.material.color.setHex(color); r.flash.material.color.setHex(color);
    r.mesh.scale.setScalar(0.4);
    r.mesh.material.opacity = 0.9;
    r.mesh.quaternion.copy(camera.quaternion);
  }
  function burst(x, y, z, n, speed, color) {
    sparkMat.color.setHex(color);
    const [px, py, pz] = W2(x, y, z);
    for (let k = 0; k < n; k++) {
      const i = sparkHead; sparkHead = (sparkHead + 1) % SPARKS;
      sparkPos.set([px, py, pz], i * 3);
      const a = Math.random() * Math.PI * 2, e = Math.random() * 2 - 1, s = speed * (0.4 + Math.random() * 0.6);
      sparkVel.set([Math.cos(a) * Math.sqrt(1 - e * e) * s, e * s + 1, Math.sin(a) * Math.sqrt(1 - e * e) * s], i * 3);
      sparkLife[i] = 0.35 + Math.random() * 0.25;
    }
  }
  const TRAIL_COLORS = { smash: 0xff5a3c, jsmash: 0xff3b1f, kill: 0xff4a6a, drop: 0x6fe0ff, clear: 0xffffff, lift: 0xe8f4ff, drive: 0xffd34d, counter: 0x57d6ff, block: 0x9fe8c0, net: 0x9fe8c0, servel: 0xbfd4ff, serveh: 0xbfd4ff };
  function fxHit(e) {
    const c = e.fire ? 0xff5a1a : e.parry || e.fireHeld ? 0xffd34d : TRAIL_COLORS[e.kind] || 0xffffff;
    const z = Math.max(0.3, e.z);
    const big = e.kind === 'smash' || e.kind === 'jsmash' || e.kind === 'kill';
    // a smash's power: its speed, a timed (perfect) contact, a jump
    const power = big ? clamp((e.kmh - 140) / 180, 0, 1) * 0.75 + (e.perfect ? 0.2 : 0) + (e.kind === 'jsmash' ? 0.15 : 0) : 0;
    lastSmash = big ? clamp(power, 0, 1) : 0;
    shuttleFx.hit(c, big ? 0.6 + power : e.perfect || e.parry ? 0.5 : 0.15);
    if (big) smashFx.contact(new THREE.Vector3(...W2(e.x, e.y, z)), clamp(power, 0, 1), c);
    impactRing(e.x, e.y, z, c, e.kind === 'jsmash' ? 2.1 : big ? 1.6 : e.parry ? 1.8 : 1, big || e.perfect || e.parry ? 1 : 0.5);
    // the weight of the contact, scaled to the shot: a jump smash kicks the whole view
    if (e.fire) { shake = Math.max(shake, 0.3); zoomBoost = 0.7; burst(e.x, e.y, z, 44, 7, c); shuttleFx.hit(c, 1.8); }
    else if (e.fireHeld) { shake = Math.max(shake, 0.18); zoomBoost = 0.45; burst(e.x, e.y, z, 30, 5.5, c); }
    else if (e.kind === 'jsmash') { shake = Math.max(shake, e.perfect ? 0.22 : 0.15); zoomBoost = 0.55; burst(e.x, e.y, z, e.perfect ? 32 : 22, 6, c); }
    else if (big) { shake = Math.max(shake, e.perfect ? 0.16 : 0.1); zoomBoost = 0.3; burst(e.x, e.y, z, e.perfect ? 24 : 14, 4.5, c); }
    else if (e.parry) { shake = Math.max(shake, 0.12); zoomBoost = 0.35; burst(e.x, e.y, z, 26, 5, 0xffd34d); }
    else if (e.perfect) { shake = Math.max(shake, 0.05); burst(e.x, e.y, z, 12, 3, 0xffd34d); }
  }
  function fxNet(x, y, z, event) { impactRing(x, y, z, 0xaab8c4, 0.7, 0); netDynamics.impact(event || {y,z,vx:0,vy:0,vz:0});netActive=3; }
  function fxDust(x, y, amount) { dust(x, y, amount); }
  // a smash into the floor: a hot shockwave ring spreading across the mat, a spray of dust and
  // sparks, and the whole view kicks
  function fxSlam(x, y, kmh) {
    const k = clamp((kmh || 60) / 80, 0.5, 1.4);
    // the court cracks under it, scaled by the smash that sent it
    const power = Math.max(lastSmash, clamp(((kmh || 60) - 50) / 120, 0, 1) * 0.6);
    smashFx.slam(x, y, power);
    dust(x, y, 1.6 * k);
    burst(x, y, 0.05, Math.round(18 * k), 5, 0xffb347);
    shake = Math.max(shake, 0.12 + 0.12 * k); zoomBoost = Math.max(zoomBoost, 0.4);
  }
  function fxShake(a) { shake = Math.max(shake, a); }

  const prof = { players: 0, render: 0, n: 0 };
  const shQ = new THREE.Quaternion();
  // ---- pose inspection (support and development): __ob.R().debugPose({ stroke: 'smash', u: -0.05 })
  // holds one athlete at a stroke phase / charge / jump state and puts the camera beside them
  let dbg = null;
  function debugFrame(f, o) {
    const p = f.p.slice(), A = players[o.slot];
    p[2] = p[3] = 0; p[6] = o.charge != null ? o.charge * 42 : -1; p[7] = p[8] = p[10] = p[11] = 0;
    p[14] = o.z || 0; p[15] = o.vz || 0; p[16] = o.squat || 0; p[17] = o.landT || 0; p[8] = o.dive ? 1 : 0;
    f.p = p; f.chargeKind = o.chargeKind || o.stroke || 'over'; f.splitAgo = null; f.won = f.lost = null; f.frozen = false;
    if (o.stroke) {
      const cs = Math.cos(A.yaw), sn = Math.sin(A.yaw), side = o.side != null ? o.side : 0.35, fwd = o.fwd != null ? o.fwd : 0.35, rz = o.rz != null ? o.rz : 2.4;
      // local (side = racket side +, fwd) back to sim x, y
      const wx = p[0] + (-side * cs + fwd * sn), wy = p[1] + (side * sn + fwd * cs);
      f.stroke = { name: o.stroke, u: o.u || 0, side, reach: Math.hypot(side, fwd), air: !!o.air, charge: 1, contact: o.ik === false ? null : new THREE.Vector3(wx, rz + (o.z || 0), wy) };
      f.ball = [wx, wy, rz + (o.z || 0), 0, 0, 0];
    } else f.stroke = null;
  }
  // The incoming shuttle stepped forward with the sim's own flight model (1/60 s, up to 1.6 s) to
  // the first point where player i could meet it (in reach, at a hittable height, on their side),
  // from where they stand now. null when it is not coming to them or never comes into reach.
  function intercept(i, p, b) {
    if (!CT) return null;
    const dir = i ? 1 : -1; // player i's half is x * dir > 0
    if (!(b[3] * dir > 0.3)) return null; // only a shuttle travelling toward this player's half
    let x = b[0], y = b[1], z = b[2], vx = b[3], vy = b[4], vz = b[5];
    const pz = p[14] || 0, reach = CT.REACH * 1.02, k = CT.DRAG, g = CT.G, h = 1 / 60;
    // of the stretch of flight inside reach, the point at the most natural reach (~0.75 m out):
    // a shuttle crossing in front is played in front, not where it first came into reach
    let best = null, inside = false;
    for (let t = 0; t < 1.6; t += h) {
      if (x * dir > -0.2) {
        const d = Math.hypot(x - p[0], y - p[1]), rz = z - pz;
        if (d < reach && rz < CT.MAX_Z && rz > 0.05) {
          const sc = Math.abs(d - 0.75);
          if (!best || sc < best.sc - 0.02) best = { sc, t, x, y, z, vx, vy, vz, out: false };
          // (one that comes into reach high is taken high, overhead, as soon as it can be)
          if (!inside && rz >= 1.75) { inside = true; break; }
          inside = true;
        } else if (inside) break;
      }
      const sp = Math.hypot(vx, vy, vz), dec = 1 / (1 + k * sp * h);
      vx *= dec; vy *= dec; vz = vz * dec - g * h;
      x += vx * h; y += vy * h; z += vz * h;
      if (z <= 0) break;
    }
    if (!best) return null;
    // and where it would land if left: a player leaves one going clearly out
    ({ x, y, z, vx, vy, vz } = best);
    for (let s = 0; s < 240 && z > 0; s++) { const sp = Math.hypot(vx, vy, vz), dec = 1 / (1 + k * sp * h); vx *= dec; vy *= dec; vz = vz * dec - g * h; x += vx * h; y += vy * h; z += vz * h; }
    best.out = Math.abs(x) > CT.L + 0.3 || Math.abs(y) > CT.W + 0.3;
    return best;
  }
  // One athlete's frame: the stroke it is in (timed from the server's hit tick), what a charge is
  // loading, the split-step cue and the end-of-point reaction.
  function athleteFrame(i, p, b, rv, dt, now) {
    const A = players[i], tick = rv.tick || 0;
    const rec = !rv.pointAt && rv.strokes && rv.strokes[i];
    let stroke = null;
    if (rec) {
      const u = (tick - rec.tick) / 60;
      if (u > -0.6 && u < 0.7) {
        // (forehand / backhand side measured square to the net, not to the body's momentary turn:
        // the body turns into a backhand, and the side it is judged by must not turn with it)
        const ny = i ? -Math.PI / 2 : Math.PI / 2, dx = rec.x - p[0], dy = rec.y - p[1], cs = Math.cos(ny), sn = Math.sin(ny);
        const side = -(dx * cs - dy * sn), fwd = dx * sn + dy * cs, rz = rec.z - (rec.pz || 0);
        const name = strokeFor(rec.kind, side, rz);
        stroke = { name, u, side, fwd, rz, reach: Math.hypot(dx, dy), air: !!rec.air, charge: rec.kind === 'smash' || rec.kind === 'jsmash' || rec.kind === 'clear' || rec.kind === 'lift' ? 1 : 0.7,
          contact: rec.kind ? new THREE.Vector3(rec.x, rec.z, rec.y) : null };
      }
    }
    const other = rv.strokes && rv.strokes[1 - i];
    // where the incoming shuttle will be met (the sim's flight stepped forward to the first point in
    // reach), and the stroke a player readies for it: the charge loads that stroke, and before the
    // charge the player already turns and lifts the racket toward it (prep, by time to contact)
    let chargeKind = 'over', prep = null;
    const icp = rv.pointAt ? null : intercept(i, p, b);
    if (icp) {
      const ny = i ? -Math.PI / 2 : Math.PI / 2, cs = Math.cos(ny), sn = Math.sin(ny), dx = icp.x - p[0], dy = icp.y - p[1];
      const side = -(dx * cs - dy * sn), fwd = dx * sn + dy * cs, rz = icp.z - (p[14] || 0);
      let kind = rz >= 1.75 ? 'clear' : rz >= 0.85 ? 'drive' : 'lift';
      try {
        const BMs = BM();
        const s = { phase: 'rally', lastHitter: 1 - i, lastKind: other && other.kind || '', ball: { x: icp.x, y: icp.y, z: icp.z, vx: icp.vx, vy: icp.vy, vz: icp.vz }, players: [], score: [0, 0] };
        kind = BMs.shotKind(s, { i, x: p[0], y: p[1], z: p[14] || 0, vz: p[15] || 0, vx: p[2], vy: p[3], fx: p[4], fy: p[5] }, p[6] >= 0 ? p[6] : 20, false) || kind;
      } catch (e) { /* the sim's shot table is advisory here */ }
      let name = strokeFor(kind, side, rz);
      // a player commits: the readied stroke changes only once the new call has held for 0.1 s
      if (A._prepName && name !== A._prepName) { A._prepHold = (A._prepHold || 0) + 1; if (A._prepHold < 6) name = A._prepName; else A._prepHold = 0; } else A._prepHold = 0;
      A._prepName = name;
      chargeKind = name;
      if (!icp.out || p[6] >= 0) prep = { name, eta: icp.t, side, fwd, rz, contact: new THREE.Vector3(icp.x, icp.z, icp.y) };
    } else A._prepName = null;
    if (!icp && p[6] >= 0) {
      // nothing coming into reach: a brace if the opponent has it high, else the ready forehand
      chargeKind = Math.sign(b[0] || 1) !== (i ? 1 : -1) && b[2] > 2 ? 'block' : 'fh';
    }
    const splitAgo = other && other.kind ? (tick - other.tick) / 60 : null;
    const pt = rv.pointAt;
    const ago = pt ? (tick - pt.tick) / 60 : null;
    return {
      p, ball: b, dt, t: now / 1000, frozen: !!rv.hitstop, stroke, chargeKind, prep, splitAgo,
      celebration: pt?.variant || 0,
      won: pt && pt.p === i ? ago : null, lost: pt && pt.p !== i ? ago : null,
    };
  }
  const up = new THREE.Vector3(), tmp = new THREE.Vector3(), side3 = new THREE.Vector3();
  const shakeOff = new THREE.Vector3(), want = new THREE.Vector3();
  let frameDt = 1 / 60;
  // a per-frame smoothing factor tuned at 60 fps, converted so it settles at the same rate at any fps
  const ease = k => 1 - Math.pow(1 - k, frameDt * 60);
  let lab = null; // the motion lab (motionlab.js, tools/motion_test.js) owns the athletes while it runs
  let wasMatch = false;
  function frame(rv, now) {
    swellZoom += ((rv.swell || 0) * 0.9 - swellZoom) * 0.05; // eased: never a lurch
    if (lab) { lastT = now; return; }
    const dtMs = now - lastT, dt = clamp(dtMs / 1000, 0, 0.1); lastT = now; frameDt = dt;
    adapt(dtMs, now);
    const world = rv.world, live = rv.live, my = rv.mySlot;
    if (rv.names) players.forEach((p, i) => p.setIdentity(rv.names[i], i));
    const effectDt = rv.paused ? 0 : dt;
    hall.update(effectDt, rv);
    if(!rv.match) {
      heatVfx.reset();
      if(wasMatch) {
        players.forEach(p=>p.reset());netDynamics.reset();netActive=0;
        netLook.sync();
      }
    }
    wasMatch=!!rv.match;
    if(netActive>0&&effectDt>0){netDynamics.step(effectDt);netActive=Math.max(0,netActive-effectDt);if(!netActive)netDynamics.reset();netLook.sync();}
    if (world) {
      // dbg.manual: a test harness drives that athlete itself (debugAthletes / debugAthleteFrame)
      // and may hold the shuttle where its case puts it (dbg.ball) or hide the other player
      const b = dbg && dbg.ball ? dbg.ball : world.ball;
      for (let i = 0; i < 2; i++) {
        const p = world.players[i];
        if (dbg && dbg.manual) {
          if (i === dbg.slot) { feet[i].position.set(players[i].root.position.x, 0.008, players[i].root.position.z); continue; }
          if (dbg.hideOther) { players[i].root.visible = false; feet[i].visible = false; continue; }
        }
        if (rv.hide && rv.hide[i]) { players[i].root.visible = false; feet[i].visible = false; continue; }
        players[i].root.visible = true; feet[i].visible = true;
        const tp = performance.now();
        const af = athleteFrame(i, p, b, rv, dt, now);
        if (dbg && dbg.slot === i) debugFrame(af, dbg);
        players[i].update(af);
        prof.players += performance.now() - tp;
        feet[i].position.set(p[0], 0.008, p[1]);
        // the contact shadow shrinks and fades as the player leaves the floor
        const pz = p[14] || 0;
        feet[i].scale.setScalar(1 / (1 + pz * 0.9)); feet[i].material.opacity = (hi ? 0.55 : 0.8) / (1 + pz * 1.5);
      }
      heatVfx.update(effectDt, rv.heat, players, camera, !!rv.match);
      shuttle.position.set(...W2(b[0], b[1], b[2]));
      const sp = Math.hypot(b[3], b[4], b[5]);
      shotVel.set(...W2(b[3], b[4], b[5]));
      // the shuttle turns over: after a hit it leaves skirt-first and flips to fly cork-first, so
      // its orientation chases the velocity at a finite rate rather than snapping to it
      if (sp > 0.5) {
        shQ.setFromUnitVectors(tmp.set(0, -1, 0), up.set(b[3], b[5], b[4]).normalize());
        shuttle.quaternion.slerp(shQ, clamp(dt * (6 + sp * 0.9), 0, 1));
      }
      // on-screen size: never fewer than SH_PX pixels across, however far away it is
      const dist = camera.position.distanceTo(shuttle.position);
      const pxPerM = h / (2 * dist * Math.tan(camera.fov * Math.PI / 360));
      shuttle.scale.setScalar(Math.max(SH_SCALE, SH_PX / pxPerM / 0.075));
      const coming = rv.lh != null && rv.lh !== my && my >= 0;
      const bpx = m => m / pxPerM; // metres for this many pixels at the shuttle's distance
      const dp = dropGeo.attributes.position;
      dp.setXYZ(0, b[0], b[2], b[1]); dp.setXYZ(1, b[0], 0.02, b[1]); dp.needsUpdate = true;
      dropLine.visible = live && b[2] > 0.35;
      shadow.position.set(b[0], 0.012, b[1]);
      shadow.scale.setScalar(clamp(1.4 + b[2] * 0.2, 1.4, 2.6));
      shadow.material.opacity = clamp(0.7 - b[2] * 0.05, 0.35, 0.7);
      trail.visible = false; // (the trail is shuttle-fx.js's now)
      // (keyboard controls: one ring only, the timing ring at the contact point, drawn by the client)
      if (live && rv.pred && rv.pred.land && b[2] > 0.15 && !rv.oneRing) {
        const toMe = my >= 0 && Math.sign(rv.pred.land.x || 1) === (my ? 1 : -1);
        marker.visible = true;
        marker.position.set(rv.pred.land.x, 0.014, rv.pred.land.y);
        marker.scale.setScalar((toMe ? 1.5 : 1) * (1 + Math.sin(now * 0.006) * 0.06));
        marker.material.opacity = (toMe ? 0.55 : 0.3) + 0.3 * (1 - clamp(b[2] / 4, 0, 1));
        // the countdown ring closes from 3x to the marker as it comes down (over its last 1.2 s)
        const tl = Math.max(0, rv.pred.land.t - (rv.predAge || 0));
        countRing.visible = toMe;
        countRing.position.set(rv.pred.land.x, 0.016, rv.pred.land.y);
        countRing.scale.setScalar(0.75 + 2.4 * clamp(tl / 1.2, 0, 1));
        countRing.material.opacity = toMe ? 0.25 + 0.5 * (1 - clamp(tl / 1.2, 0, 1)) : 0;
      } else { marker.visible = false; countRing.visible = false; }
      // reach ring and the smash tell
      const mp = my >= 0 ? world.players[my] : null;
      let beaconHit = false;
      if (mp && live) {
        const K = CT, me = mp, pz = me[14] || 0, d = Math.hypot(b[0] - me[0], b[1] - me[1]);
        const hittable = coming && d < K.REACH && b[2] >= pz && b[2] <= pz + K.MAX_Z && Math.sign(b[0] || 1) === (my ? 1 : -1);
        beaconHit = hittable;
        reachRing.visible = !rv.oneRing;
        reachRing.position.set(me[0], 0.018, me[1]);
        reachRing.scale.setScalar(K.REACH);
        const near = coming ? clamp(1 - (d - K.REACH) / 2.5, 0, 1) : 0;
        reachRing.material.color.setHex(hittable ? 0xffd34d : 0xffffff);
        reachRing.material.opacity = hittable ? 0.75 : 0.06 + 0.16 * near;
        const opp = world.players[1 - my], od = Math.hypot(b[0] - opp[0], b[1] - opp[1]);
        const tell = opp[6] > 18 && b[2] > 1.7 && od < 2.6 && rv.lh === my;
        tellRing.visible = tell;
        if (tell) { tellRing.position.set(opp[0], 0.02, opp[1]); tellRing.scale.setScalar(1 + 0.25 * Math.sin(now * 0.02)); tellRing.material.opacity = 0.5 + 0.35 * clamp((opp[6] - 18) / 24, 0, 1); }
      } else { reachRing.visible = false; tellRing.visible = false; }
      // the beacon, trail and glint (keyboard controls: the timing ring is the only ring)
      shuttleFx.update({ dt, camera, pos: shuttle.position, speed: sp, pxPerM, live, coming, hittable: beaconHit, ring: !rv.oneRing, host: renderer.domElement.parentElement });
      const me = my >= 0 ? world.players[my] : null;
      if (me && me[6] >= 0 && live) {
        const ch = clamp(me[6] / 42, 0, 1.2);
        aimGroup.visible = true;
        aimGroup.position.set(me[0], 0.016, me[1]);
        aimGroup.rotation.y = Math.atan2(me[4], me[5]);
        aimLine.scale.set(1, 1, 1.4 + ch * 1.4);
        aimLine.material.opacity = 0.35 + ch * 0.4;
      } else aimGroup.visible = false;
      camera.position.sub(shakeOff); shakeOff.set(0, 0, 0);
      rigCamera(world, b, my, rv, dt);
      if (dbg && dbg.camPos) { camera.position.set(...dbg.camPos); camera.lookAt(...dbg.camLook); }
      else if (dbg && dbg.cam === 'hand') {
        // close-up on a hand (the grip): view = direction to the camera in the hand bone's own frame
        // (+x back of the hand, -x palm, +y toward the fingers, +z thumb side), at = aim point there
        const hb = players[dbg.slot].h.bone[dbg.left ? 'hand_l' : 'hand_r'], c = hb.localToWorld(new THREE.Vector3(...(dbg.at || [-0.02, 0.07, 0.01])));
        const v = new THREE.Vector3(...(dbg.view || [1, 0, 0])).normalize().applyQuaternion(hb.getWorldQuaternion(new THREE.Quaternion()));
        camera.position.copy(c).addScaledVector(v, dbg.dist || 0.3); camera.lookAt(c);
      }
      else if (dbg && dbg.cam) {
        const A = players[dbg.slot], r = A.root.position, yw = A.yaw;
        const off = { side: [-3.2, 0], front: [0, 3.4], back: [0, -3.4], right: [3.2, 0], diag: [-2.4, 2.4] }[dbg.cam] || [-3.2, 0];
        // local offset (x: the player's left, z: ahead) turned into the world
        const ox = off[0] * Math.cos(yw) + off[1] * Math.sin(yw), oz = -off[0] * Math.sin(yw) + off[1] * Math.cos(yw);
        camera.position.set(r.x + ox, 1.35 + (dbg.camH || 0), r.z + oz);
        camera.lookAt(r.x, 1.05 + (dbg.z || 0), r.z);
      }
      zoomBoost = Math.max(0, zoomBoost - 0.6 * dt);
    }
    for (const r of rings) {
      if (r.t >= r.life) { r.mesh.visible = false; r.flash.visible = false; continue; }
      r.t += dt;
      const f = clamp(r.t / r.life, 0, 1);
      r.mesh.scale.setScalar((0.4 + f * 2) * (r.scale || 1));
      r.mesh.material.opacity = 0.9 * (1 - f);
      if (r.flash.visible) { r.flash.scale.setScalar((0.5 + f * 0.9) * (r.scale || 1)); r.flash.material.opacity = r.flashA * (1 - f) * (1 - f); }
    }
    for (let i = 0; i < SPARKS; i++) {
      if (sparkLife[i] <= 0) { sparkPos[i * 3 + 1] = -10; continue; }
      sparkLife[i] -= dt;
      sparkVel[i * 3 + 1] -= 9.8 * dt;
      for (let c = 0; c < 3; c++) sparkPos[i * 3 + c] += sparkVel[i * 3 + c] * dt;
    }
    sparkGeo.attributes.position.needsUpdate = true;
    for (let i = 0; i < DUST; i++) {
      if (dustLife[i] <= 0) { dustPos[i * 3 + 1] = -10; continue; }
      dustLife[i] -= dt; dustSize[i] = clamp(dustLife[i] / 0.6, 0, 1);
      const drag = Math.exp(-4 * dt);
      dustVel[i * 3] *= drag; dustVel[i * 3 + 2] *= drag; dustVel[i * 3 + 1] = dustVel[i * 3 + 1] * drag - 0.4 * dt;
      for (let c = 0; c < 3; c++) dustPos[i * 3 + c] += dustVel[i * 3 + c] * dt;
      if (dustPos[i * 3 + 1] < 0.02) dustPos[i * 3 + 1] = 0.02;
    }
    dustGeo.attributes.position.needsUpdate = true; dustGeo.attributes.size.needsUpdate = true;
    for (const r of slams) {
      if (r.t >= r.life) { r.mesh.visible = false; continue; }
      r.t += dt; const f = clamp(r.t / r.life, 0, 1);
      r.mesh.scale.setScalar((0.4 + easeOutC(f) * 4.5) * r.k);
      r.mesh.material.opacity = 0.85 * (1 - f) * (1 - f);
    }
    for (let i = 0; i < 2; i++) updateSwoosh(i);
    // shake: an offset for this frame only (the follow above never sees it), decaying in time
    if (shake > 0.001) {
      shakeOff.set(rnd(-shake, shake), rnd(-shake, shake) * 0.6, 0);
      camera.position.add(shakeOff);
      shake *= Math.pow(0.86, dt * 60);
    } else shakeOff.set(0, 0, 0);
    smashFx.update(dt, camera);
    const tr = performance.now();
    portrait.work(!!rv.calm); // (the portrait's recording, only while play is calm: painted over by the render below)
    renderer.render(scene, camera);
    smashFx.afterRender(camera, shotVel); // contact glass breaks the frame just drawn
    prof.render += performance.now() - tr; prof.n++;
  }

  // ---- the player card's portrait, pre-rendered (client: R.portraitPrepare(name), R.portraitFrames(slot)).
  // A second athlete in the player's kit and look, posed in a small studio scene of its own (warm key,
  // cool fill, a rim in the team colour, a deep backdrop), recorded ONCE into a few short clips: a
  // breathing idle loop, a fist pump and a racket flourish, at twice the card's resolution; afterwards
  // the card only plays the frames back. Recording borrows a corner of the canvas the main render then
  // paints over, and lifting each frame off it stalls the GPU, so it runs ONE frame per render frame
  // and only while nothing is being played: on the home screen (prepared there for your name in both
  // kits, before you start a match) and between points. Never during a rally.
  function createPortrait() {
    const W = 224, H = 262, FPS = 20; // (about 130 frames a kit, ~30 MB)
    const CLIPS = [{ name: 'idle', len: 2.0, cel: null }, { name: 'pump', len: 2.3, cel: 1 }, { name: 'flourish', len: 2.3, cel: 0 }];
    const ps = new THREE.Scene();
    ps.environment = A.env;
    const cam = new THREE.PerspectiveCamera(21, W / H, 0.05, 20); ps.add(cam);
    ps.add(new THREE.HemisphereLight(0xdfe8ff, 0x10141f, 0.35));
    const key = new THREE.DirectionalLight(0xffe9d2, 3.0), fill = new THREE.DirectionalLight(0x9fb8ff, 0.45), rim = new THREE.DirectionalLight(0xff6b73, 4.2), top = new THREE.DirectionalLight(0xffffff, 0.8);
    for (const l of [key, fill, rim, top]) { ps.add(l); ps.add(l.target); }
    const plate = hex => canvasTex(256, 320, (g, w, h) => {
      const c = new THREE.Color(hex);
      const lin = g.createLinearGradient(0, 0, 0, h); lin.addColorStop(0, '#070b1c'); lin.addColorStop(1, '#0f1631');
      g.fillStyle = lin; g.fillRect(0, 0, w, h);
      const glow = g.createRadialGradient(w * 0.3, h * 1.05, 10, w * 0.3, h * 1.05, h);
      glow.addColorStop(0, `rgba(${c.r * 255 | 0},${c.g * 255 | 0},${c.b * 255 | 0},.75)`); glow.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = glow; g.fillRect(0, 0, w, h);
      const halo = g.createRadialGradient(w * 0.55, h * 0.32, 4, w * 0.55, h * 0.32, h * 0.5);
      halo.addColorStop(0, 'rgba(160,185,255,.16)'); halo.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = halo; g.fillRect(0, 0, w, h);
    });
    const bgMat = new THREE.MeshBasicMaterial({ fog: false, toneMapped: false });
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bgMat); bg.position.z = -5; cam.add(bg);
    { const bh = 2 * 5 * Math.tan(cam.fov * Math.PI / 360); bg.scale.set(bh * cam.aspect * 1.05, bh * 1.05, 1); }
    const p = new Array(21).fill(0); p[0] = -4; p[1] = 0; p[4] = 1; p[6] = -1; p[9] = 100;
    const head = new THREE.Vector3(), size = new THREE.Vector2();
    const athletes = [null, null], done = new Map(), queue = [];
    let ath = null, job = null;
    function frame(f) { ath.update({ p, ball: null, dt: 1 / FPS, t: f.t, frozen: false, stroke: null, chargeKind: null, prep: null, splitAgo: null, won: f.won, lost: null, celebration: f.v }); }
    function shoot(t) {
      ath.h.root.updateMatrixWorld(true);
      const hb = ath.h.bone && (ath.h.bone.head || ath.h.bone.Head);
      if (hb) hb.getWorldPosition(head); else head.set(-4, 1.6, 0);
      // a three-quarter view, head and shoulders, the camera drifting a little through the clip
      const drift = Math.sin(t * 0.9) * 0.05;
      cam.position.set(head.x + 1.32, head.y + 0.05, head.z + 0.58 + drift);
      cam.lookAt(head.x, head.y - 0.03, head.z); // (head room above the hair)
      key.position.set(head.x + 1.6, head.y + 1.4, head.z + 1.6); key.target.position.copy(head);
      fill.position.set(head.x + 1.2, head.y - 0.2, head.z - 1.9); fill.target.position.copy(head);
      rim.position.set(head.x - 1.7, head.y + 1.1, head.z - 1.0); rim.target.position.copy(head);
      top.position.set(head.x, head.y + 3, head.z); top.target.position.copy(head);
      cam.updateMatrixWorld(true);
      // render into the canvas's bottom-left corner and lift the pixels straight off it
      renderer.getSize(size);
      const pr = renderer.getPixelRatio(), cw = W / pr, ch = H / pr;
      renderer.setScissorTest(true); renderer.setScissor(0, 0, cw, ch); renderer.setViewport(0, 0, cw, ch);
      const su = renderer.shadowMap.autoUpdate; renderer.shadowMap.autoUpdate = false;
      renderer.render(ps, cam);
      renderer.shadowMap.autoUpdate = su;
      renderer.setScissorTest(false); renderer.setViewport(0, 0, size.x, size.y);
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const gl = renderer.domElement;
      c.getContext('2d').drawImage(gl, 0, gl.height - H, W, H, 0, 0, W, H);
      return c;
    }
    return {
      // a slot's clips for whoever plays it now (their name sets the look), or null while they are not
      // recorded yet (then they are queued, first in line)
      frames(slot) {
        const live = players[slot], id = live && live.identity != null ? live.identity : '';
        const key = slot + ':' + id, got = done.get(key);
        if (got) return got;
        if (id && !(job && job.key === key) && !queue.some(q => q.key === key)) queue.unshift({ slot, id, key });
        return null;
      },
      // the home screen: record your look in both kits ahead of any match
      prepare(name) {
        if (!name) return;
        for (const slot of [0, 1]) {
          const key = slot + ':' + name;
          if (!done.has(key) && !(job && job.key === key) && !queue.some(q => q.key === key)) queue.push({ slot, id: name, key });
        }
      },
      debug: () => ({ job: job && { key: job.key, clip: job.clip, k: job.k }, queued: queue.map(q => q.key), done: [...done.keys()] }),
      // before the main render, and only when the client says play is calm: one more recorded frame
      work(calm) {
        if (!calm) return;
        if (!job) {
          const next = queue.shift(); if (!next) return;
          if (done.has(next.key)) return;
          if (!athletes[next.slot]) { athletes[next.slot] = new Athlete(ps, KITS[next.slot], A, lookFor); return; } // (made one frame, used the next)
          ath = athletes[next.slot];
          for (const a of athletes) if (a) a.root.visible = a === ath;
          ath.setIdentity(next.id, next.slot);
          bgMat.map && bgMat.map.dispose(); bgMat.map = plate(next.slot ? 0x3d80f0 : 0xf0525c); bgMat.needsUpdate = true;
          rim.color.setHex(next.slot ? 0x6aa0ff : 0xff6b73);
          job = { key: next.key, clip: 0, k: -1, t: 0, out: {} };
        }
        const C = CLIPS[job.clip], total = Math.round(C.len * FPS);
        if (job.k < 0) { // a clip begins: back to rest, settled for half a second, unrecorded
          if (ath.reset) ath.reset();
          for (let i = 0; i < 12; i++) { job.t += 1 / FPS; frame({ t: 100 + job.t, won: null, v: 0 }); }
          job.out[C.name] = []; job.k = 0;
          return;
        }
        job.t += 1 / FPS;
        frame({ t: 100 + job.t, won: C.cel == null ? null : job.k / FPS, v: C.cel == null ? 0 : C.cel });
        job.out[C.name].push(shoot(job.k / FPS));
        if (++job.k >= total) { job.k = -1; if (++job.clip >= CLIPS.length) { done.set(job.key, { fps: FPS, w: W, h: H, clips: job.out }); job = null; } }
      },
    };
  }

  function project(x, y, z) {
    const v = new THREE.Vector3(...W2(x, y, z)).project(camera);
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, ok: v.z < 1 };
  }
  const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function pickGround(sx, sy) {
    const nx = (sx / w) * 2 - 1, ny = -(sy / h) * 2 + 1;
    ray.setFromCamera({ x: nx, y: ny }, camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return { x: clamp(hit.x, -CT.L - 1.5, CT.L + 1.5), y: clamp(hit.z, -CT.W - 2, CT.W + 2) };
  }

  return {
    frame, resize, project, pickGround, _dbg: () => ({ renderer, scene, camera, rig, pts, players, scale: () => scale, avgMs: () => avgMs }),
    fx: { hit: fxHit, net: fxNet, shake: fxShake, dust: fxDust, slam: fxSlam, point: slot => hall.point(slot) },
    debugPose: o => { dbg = o ? Object.assign({ slot: 0 }, o) : null; },
    // scripted motion tests: __ob.R().motionLab({ cases, shots }) (see motionlab.js)
    motionLab: async o => {
      const m = await import('./motionlab.js');
      lab = true;
      try { return await m.run({ THREE, players, feet, scene, camera, renderer, shuttle }, o || {}); } finally { if (!(o && o.hold)) lab = null; }
    },
    // the animation player (animplayer.js, /badminton/anim): it owns the athletes, the camera and the
    // drawing while held (the game's own frame stands aside, as for the motion lab)
    labCtx: on => { lab = on ? true : null; return { THREE, players, feet, scene, camera, renderer, shuttle, strokeFor }; },
    // the reaction test harness (tools/reaction_test.js): the athletes, the real per-frame input
    // builder, and a synchronous render of the current scene
    debugAthletes: () => players,
    debugAthleteFrame: (i, p, b, rv, dt, now) => athleteFrame(i, p, b, rv, dt, now),
    debugRender: () => { if (dbg && dbg.camPos) { camera.position.set(...dbg.camPos); camera.lookAt(...dbg.camLook); } if (dbg && dbg.ball) { shuttle.position.set(...W2(dbg.ball[0], dbg.ball[1], dbg.ball[2])); shuttle.scale.setScalar(SH_SCALE); } const hid = [halo, beaconGlow, beaconRing, shuttleFx.beacon, shuttleFx.glint, shuttleFx.trail, dropLine, marker, countRing].map(o => [o, o.visible]); if (dbg && dbg.ball) hid.forEach(([o]) => { o.visible = false; }); renderer.render(scene, camera); hid.forEach(([o, v]) => { o.visible = v; }); },
    strokes: STROKES,
    setSafeBottom: v => { safeBottom = v; },
    debugCam: () => ({ pos: camera.position.toArray(), target: camTarget.toArray() }),
    debugScene: () => ({ children: scene.children.length, calls: renderer.info.render.calls, tris: renderer.info.render.triangles, crowd: hall.people, heat: heatVfx.stats() }),
    // the player card's portrait: slot -1 or no rect turns it off; rect in CSS px from the canvas's top left
    // the player card's portrait: the slot's pre-rendered clips ({ fps, w, h, clips: { idle, pump,
    // flourish } }, canvases), or null while they are still being recorded
    portraitFrames: slot => (slot >= 0 ? portrait.frames(slot) : null),
    portraitDebug: () => portrait.debug(),
    portraitPrepare: name => portrait.prepare(name),
    portraitWork: n => { for (let i = 0; i < n; i++) portrait.work(true); return portrait.debug(); }, // (support: run the recording without waiting for frames)
    debugPresentation: () => ({netDynamics,net,netLook,heatVfx,floor,shuttleFx,smashFx,W2,lastSmash:()=>lastSmash}),
    prof: () => { const n = prof.n || 1, o = { players: +(prof.players / n).toFixed(2), render: +(prof.render / n).toFixed(2), n: prof.n }; prof.players = prof.render = prof.n = 0; return o; },
    stats: () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles, pr: renderer.getPixelRatio(), scale, fps: Math.round(1000 / avgMs) }),
  };
}
