// Office Ball — the 2D renderer, for machines with no WebGL at all (virtual desktops, remote
// sessions, browsers with graphics acceleration blocked). Same interface as the 3D renderer, same
// game: a floodlit broadcast view drawn with the canvas, in a tilted "2.5D" projection so height
// (a lofted ball, a player's body) reads naturally. Everything static (pitch, stands) is drawn once
// to offscreen canvases; each frame is a handful of image draws plus the players, ball and effects.
import { KITS } from './kits.js';

const C = window.OB.C;
const S = 0.02; // sim px -> metres, as in 3D
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const smooth = (x, a, b) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
const PW = (C.FR - C.FL) * S, PH = (C.FB - C.FT) * S, HW = PW / 2, HH = PH / 2;
const GW = C.GH * S, GDP = C.GD * S, GOAL_H = 1.25, BALL_R = 0.11, PLAYER_H = 1.6;
const TILT = 0.72;          // screen height of one metre of depth, relative to one metre across
const RISE = 0.7;           // screen height of one metre of height
const SKIN = ['#e9bb98', '#d9a07a', '#c08052', '#9a6440', '#6e4428', '#f0c9a9'];
const HAIR = ['#1d1510', '#3b2616', '#6b4423', '#0d0d0d', '#8a8a8a'];
const hash = s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const wx = x => (x - C.CX) * S, wz = y => (y - C.CY) * S;

function offscreen(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

// the pitch, drawn once in world metres at `ppm` pixels per metre (a margin of run-off all round)
const MARGIN = 2.2;
function drawPitch(ppm) {
  const W = PW + MARGIN * 2, H = PH + MARGIN * 2, c = offscreen(Math.round(W * ppm), Math.round(H * ppm)), g = c.getContext('2d');
  const X = x => (x + W / 2) * ppm, Y = z => (z + H / 2) * ppm;
  g.fillStyle = '#23602c'; g.fillRect(0, 0, c.width, c.height);
  const bw = PW / 12;
  for (let i = -3; i < 16; i++) { g.fillStyle = i % 2 ? '#3b8f40' : '#338437'; g.fillRect(X(-HW + i * bw), Y(-HH - MARGIN), bw * ppm + 1, c.height); }
  // fine grain
  const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 14; d[i] += n * 0.5; d[i + 1] += n; d[i + 2] += n * 0.4; }
  g.putImageData(img, 0, 0);
  // wear in the goalmouths and the centre
  const wear = (x, z, rx, rz, a) => { g.save(); g.translate(X(x), Y(z)); g.scale(rx * ppm, rz * ppm); const gr = g.createRadialGradient(0, 0, 0, 0, 0, 1); gr.addColorStop(0, `rgba(150,140,82,${a})`); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 1, 0, 7); g.fill(); g.restore(); };
  for (const s of [-1, 1]) wear(s * (HW - 0.55), 0, 0.9, 1.9, 0.2); wear(0, 0, 0.55, 0.55, 0.1);
  // run-off
  g.fillStyle = 'rgba(0,18,4,0.3)';
  g.fillRect(0, 0, c.width, Y(-HH)); g.fillRect(0, Y(HH), c.width, c.height - Y(HH)); g.fillRect(0, Y(-HH), X(-HW), PH * ppm); g.fillRect(X(HW), Y(-HH), c.width - X(HW), PH * ppm);
  // lines
  g.strokeStyle = 'rgba(240,245,240,0.9)'; g.fillStyle = 'rgba(240,245,240,0.92)'; g.lineWidth = 0.09 * ppm;
  g.strokeRect(X(-HW), Y(-HH), PW * ppm, PH * ppm);
  g.beginPath(); g.moveTo(X(0), Y(-HH)); g.lineTo(X(0), Y(HH)); g.stroke();
  g.beginPath(); g.arc(X(0), Y(0), 1.6 * ppm, 0, 7); g.stroke();
  g.beginPath(); g.arc(X(0), Y(0), 0.12 * ppm, 0, 7); g.fill();
  for (const s of [-1, 1]) {
    const gx = s * HW;
    g.strokeRect(s < 0 ? X(gx) : X(gx - 2.2), Y(-3), 2.2 * ppm, 6 * ppm);
    g.strokeRect(s < 0 ? X(gx) : X(gx - 0.8), Y(-1.8), 0.8 * ppm, 3.6 * ppm);
    g.beginPath(); g.arc(X(gx - s * 1.6), Y(0), 0.09 * ppm, 0, 7); g.fill();
    g.save(); g.beginPath(); if (s < 0) g.rect(X(gx + 2.2), 0, c.width, c.height); else g.rect(0, 0, X(gx - 2.2), c.height);
    g.clip(); g.beginPath(); g.arc(X(gx - s * 1.6), Y(0), 1.5 * ppm, 0, 7); g.stroke(); g.restore();
  }
  return { c, W, H };
}

// the crowd: rows of fans in a dark stand, lit from the pitch side
function drawStand(w, h, rows, seed) {
  const c = offscreen(w, h), g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#05070d'); gr.addColorStop(1, '#161c2b');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  let r = seed;
  const rnd = () => ((r = Math.imul(r ^ (r >>> 15), 2246822507) ^ Math.imul(r ^ (r >>> 13), 3266489909)) >>> 0) / 4294967296;
  const cols = ['#d7263d', '#1c8cf0', '#f2f2f2', '#222', '#ffd34d', '#3ddc84', '#8e44ad', '#e67e22', '#7f8c8d'];
  for (let i = 0; i < rows; i++) {
    const y = h * (0.12 + 0.84 * i / rows), lit = 0.35 + 0.65 * i / rows, s = 3 + 3 * i / rows;
    for (let x = rnd() * s; x < w; x += s * (1.4 + rnd() * 0.5)) {
      if (rnd() < 0.08) continue;
      g.globalAlpha = lit; g.fillStyle = cols[(rnd() * cols.length) | 0]; g.fillRect(x, y, s * 0.9, s * 1.2);
      g.fillStyle = SKIN[(rnd() * SKIN.length) | 0]; g.beginPath(); g.arc(x + s * 0.45, y - s * 0.3, s * 0.38, 0, 7); g.fill();
    }
  }
  g.globalAlpha = 1;
  return c;
}

export function createRenderer2D(canvas) {
  const g = canvas.getContext('2d', { alpha: false });
  if (!g) throw new Error('no 2d canvas');
  let cssW = 1, cssH = 1, pr = 1, ppm = 40, overlay = null;
  let pitch = null, standFar = null, standNear = null;
  const cam = { x: 0, z: 0, zoom: 1, shake: 0, kx: 0, kz: 0 };
  // screen transform: metres -> css px
  let sx = 1, ox = 0, oy = 0;
  const toX = x => ox + (x - cam.x) * sx, toY = (z, h = 0) => oy + (z - cam.z) * sx * TILT - h * sx * RISE;

  const parts = [];
  const emit = (x, h, z, n, o) => {
    for (let i = 0; i < n && parts.length < 600; i++) {
      const a = Math.random() * Math.PI * 2, s = Math.random() * (o.speed || 2);
      parts.push({ x, h, z, vx: Math.cos(a) * s, vh: Math.random() * (o.up || 2), vz: Math.sin(a) * s, life: (o.life || 0.6) * (0.6 + Math.random() * 0.6), max: o.life || 0.6, col: o.colors[i % o.colors.length], size: (o.size || 0.08) * (0.6 + Math.random() * 0.7), grav: o.grav ?? 9 });
    }
  };
  const players = [0, 1].map(i => ({ yaw: i ? -Math.PI / 2 : Math.PI / 2, phase: 0, speed: 0, lx: null, lz: null, kick: 0, swing: 0, tap: 0, tapFoot: 'R', recv: 0, recvPart: 'foot', head: 0, look: null, name: null }));
  const lookFor = (name, slot) => { const h = hash(name || String(slot)); return { skin: SKIN[h % SKIN.length], hair: HAIR[(h >>> 4) % HAIR.length], number: name === 'BOT' ? 0 : 1 + (h >>> 8) % 99, bald: ((h >>> 12) % 5) === 0 }; };
  let ball = { x: 0, z: 0, h: 0, spin: 0, trail: [] }, hype = 0, flash = 0, netPush = [0, 0];

  function resize(w, h) {
    cssW = w; cssH = h; pr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * pr); canvas.height = Math.round(h * pr);
    // fit the pitch (with the goals) to the width, the depth to the height
    const fitW = w / (PW + GDP * 2 + 1.6), fitH = h / ((PH + 1.2) * TILT + 3.2 * RISE);
    const base = Math.min(fitW, fitH);
    const need = Math.ceil(base * 1.35 * pr);
    if (!pitch || Math.abs(need - ppm) > 8) { ppm = clamp(need, 12, 90); pitch = drawPitch(ppm); standFar = drawStand(1600, 260, 14, 7); standNear = drawStand(1600, 120, 5, 11); }
    sx = base; ox = w / 2; oy = h / 2 + 0.3 * sx;
    // the pool of floodlight on the pitch falling away into the dark bowl, and the lens vignette
    overlay = offscreen(canvas.width, canvas.height);
    const o = overlay.getContext('2d'), W2 = overlay.width, H2 = overlay.height, R = Math.max(W2, H2) * 0.75;
    const pool = o.createRadialGradient(W2 / 2, H2 * 0.55, R * 0.12, W2 / 2, H2 * 0.55, R);
    pool.addColorStop(0, 'rgba(255,255,255,0.06)'); pool.addColorStop(0.5, 'rgba(0,0,0,0)'); pool.addColorStop(1, 'rgba(0,0,10,0.62)');
    o.fillStyle = pool; o.fillRect(0, 0, W2, H2);
  }

  // the stands and the pitch
  function drawStadium() {
    g.fillStyle = '#04060b'; g.fillRect(0, 0, cssW, cssH);
    const top = toY(-HH - 2.2, 0), bot = toY(HH + 2.2, 0);
    g.drawImage(standFar, toX(-HW - 9), top - (standFar.height / standFar.width) * (PW + 18) * sx * 0.55, (PW + 18) * sx, (standFar.height / standFar.width) * (PW + 18) * sx * 0.55);
    const pw = pitch.W, ph = pitch.H;
    g.save(); g.translate(toX(-pw / 2), toY(-ph / 2)); g.scale(sx / ppm, sx * TILT / ppm); g.drawImage(pitch.c, 0, 0); g.restore();
    // LED boards
    const board = (x0, x1, z) => { const y = toY(z, 0.26), y0 = toY(z, 0); g.fillStyle = '#0a0f1a'; g.fillRect(toX(x0), y, (x1 - x0) * sx, y0 - y); g.fillStyle = 'rgba(120,170,255,0.55)'; g.fillRect(toX(x0), y + (y0 - y) * 0.35, (x1 - x0) * sx, (y0 - y) * 0.3); };
    board(-HW, HW, -HH - 0.05);
    return bot;
  }

  // a goal: posts and bar, the net as a lattice bulging where the ball presses it
  function drawGoal(side, back) {
    const gx = side * HW, bx = gx + side * GDP, hw = GW / 2, push = netPush[side > 0 ? 1 : 0];
    g.lineWidth = 1; g.strokeStyle = 'rgba(235,240,245,0.55)';
    const N = 12, bxp = bx + side * push * 0.35;
    if (back) {
      for (let i = 0; i <= N; i++) { const z = -hw + GW * i / N; g.beginPath(); g.moveTo(toX(bxp), toY(z, 0)); g.lineTo(toX(bxp), toY(z, GOAL_H * 0.72)); g.lineTo(toX(gx), toY(z, GOAL_H)); g.stroke(); }
      for (let j = 0; j <= 6; j++) { const h = GOAL_H * 0.72 * j / 6; g.beginPath(); g.moveTo(toX(bxp), toY(-hw, h)); g.lineTo(toX(bxp), toY(hw, h)); g.stroke(); }
      for (const z of [-hw, hw]) for (let j = 0; j <= 6; j++) { const h = GOAL_H * j / 6; g.beginPath(); g.moveTo(toX(gx), toY(z, h)); g.lineTo(toX(bxp), toY(z, h * 0.72)); g.stroke(); }
    } else {
      g.lineWidth = Math.max(2, 0.12 * sx); g.strokeStyle = '#f4f6f8'; g.lineCap = 'round';
      g.beginPath(); g.moveTo(toX(gx), toY(-hw, 0)); g.lineTo(toX(gx), toY(-hw, GOAL_H)); g.lineTo(toX(gx), toY(hw, GOAL_H)); g.lineTo(toX(gx), toY(hw, 0)); g.stroke();
    }
  }

  // a footballer: four soft floodlight shadows, legs and arms swinging with the stride, kit, number
  function drawPlayer(P, i, p, view, t) {
    const x = wx(p[0]), z = wz(p[1]), kit = KITS[i], L = P.look, sc = sx * PLAYER_H / 1.8;
    const stride = Math.sin(P.phase), amp = clamp(P.speed / 4.5, 0, 1);
    const fx = Math.sin(P.yaw), fz = Math.cos(P.yaw); // facing in world
    // floodlight shadows, one toward each corner away from its tower
    for (const [dx, dz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      g.save(); g.translate(toX(x), toY(z)); g.rotate(Math.atan2(dz * TILT, dx)); g.fillStyle = 'rgba(0,0,0,0.16)';
      g.beginPath(); g.ellipse(0.45 * sc, 0, 0.55 * sc, 0.13 * sc, 0, 0, 7); g.fill(); g.restore();
    }
    g.fillStyle = 'rgba(0,0,0,0.28)'; g.beginPath(); g.ellipse(toX(x), toY(z), 0.3 * sc, 0.3 * sc * TILT, 0, 0, 7); g.fill();
    // plate: team ring, facing notch, charge meter, dash cooldown (the 3D decal's information)
    const ring = 0.46 * sx, mine = !!(view.mySlot === i);
    g.save(); g.translate(toX(x), toY(z)); g.scale(1, TILT);
    g.lineWidth = mine ? 3 : 2; g.strokeStyle = kit.css; g.globalAlpha = mine ? 1 : 0.65; g.beginPath(); g.arc(0, 0, ring, 0, 7); g.stroke();
    g.fillStyle = kit.css; g.beginPath(); const na = Math.atan2(fz, fx); g.moveTo(Math.cos(na) * (ring + 10), Math.sin(na) * (ring + 10)); g.lineTo(Math.cos(na + 0.25) * (ring + 3), Math.sin(na + 0.25) * (ring + 3)); g.lineTo(Math.cos(na - 0.25) * (ring + 3), Math.sin(na - 0.25) * (ring + 3)); g.fill();
    g.globalAlpha = 1;
    const ct = i === view.mySlot && view.localCt !== undefined ? view.localCt : p[4];
    if (view.live && ct >= 0) {
      const R2 = 0.6 * sx, perfA = C.CHARGE_FULL / C.PERF_END, u = ct / C.PERF_END, st = -Math.PI / 2;
      g.lineWidth = 6; g.strokeStyle = 'rgba(255,255,255,0.18)'; g.beginPath(); g.arc(0, 0, R2, st, st + Math.PI * 2); g.stroke();
      g.strokeStyle = 'rgba(255,212,77,0.5)'; g.beginPath(); g.arc(0, 0, R2, st + perfA * Math.PI * 2, st + Math.PI * 2); g.stroke();
      const over = ct > C.PERF_END, perfect = ct >= C.CHARGE_FULL && !over;
      g.strokeStyle = over ? '#737888' : perfect ? '#ffd84d' : '#ffffff';
      g.beginPath(); g.arc(0, 0, R2, st, st + Math.min(u, 1) * Math.PI * 2); g.stroke();
    }
    if (view.live && p[7] > 0) { g.lineWidth = 1.5; g.strokeStyle = 'rgba(255,255,255,0.5)'; g.beginPath(); g.arc(0, 0, 0.39 * sx, -Math.PI / 2, -Math.PI / 2 + (1 - p[7] / C.DASH_CD) * Math.PI * 2); g.stroke(); }
    g.restore();
    // body, drawn up from the feet; side = how much of the body's side faces the camera
    const bx0 = toX(x), by0 = toY(z), side = fx, lean = clamp(P.speed * 0.02, 0, 0.12);
    const H = h => by0 - h * sc; // screen y of a height in model metres (1.8 m model)
    const kick = P.swing > 0 ? 1 : P.kick;
    const tap = P.tap > 0 ? Math.sin(Math.PI * Math.min(1, P.tap)) : 0;
    const recv = P.recv > 0 ? Math.sin(Math.PI * Math.min(1, P.recv)) : 0;
    const headT = P.head > 0 ? Math.sin(Math.PI * Math.min(1, P.head)) : 0;
    const shield = p[11] ? 1 : 0;
    // legs
    const legs = [[stride, -1], [-stride, 1]];
    for (const [s, k] of legs) {
      const swing = s * amp * 0.5 + (k > 0 ? kick * 0.8 : 0) + (P.tapFoot === (k > 0 ? 'R' : 'L') ? tap * 0.7 : 0), hipX = bx0 + k * 0.08 * sc * (1 - Math.abs(side) * 0.7);
      const footX = hipX + side * swing * 0.45 * sc, footY = by0 - Math.max(0, -s) * amp * 0.12 * sc - (k > 0 ? kick * 0.25 * sc : 0);
      g.strokeStyle = kit.socks === undefined ? '#e0283c' : '#' + kit.socks.toString(16).padStart(6, '0'); g.lineWidth = 0.13 * sc; g.lineCap = 'round';
      g.beginPath(); g.moveTo(hipX, H(0.92)); g.lineTo((hipX + footX) / 2 + side * 0.04 * sc, H(0.48)); g.lineTo(footX, footY - 0.05 * sc); g.stroke();
      g.strokeStyle = '#111'; g.lineWidth = 0.1 * sc; g.beginPath(); g.moveTo(footX, footY - 0.03 * sc); g.lineTo(footX + side * 0.14 * sc + (1 - Math.abs(side)) * k * 0.03 * sc, footY - 0.02 * sc); g.stroke();
    }
    // shorts, shirt (a shielded player crouches a touch)
    const tx = bx0 + side * lean * sc;
    g.fillStyle = '#' + kit.shorts.toString(16).padStart(6, '0');
    g.beginPath(); g.roundRect(tx - 0.2 * sc, H(1.06 - 0.04 * shield), 0.4 * sc, 0.2 * sc, 0.05 * sc); g.fill();
    g.fillStyle = '#' + kit.shirt.toString(16).padStart(6, '0');
    g.beginPath(); g.roundRect(tx - 0.23 * sc, H(1.52 + 0.06 * shield), 0.46 * sc, 0.5 * sc - 0.06 * shield * sc, 0.09 * sc); g.fill();
    // arms swing against the legs; shielding and chest control open them out
    const out = (shield ? 0.34 : 0) + (recv > 0 && P.recvPart === 'chest' ? 0.3 * recv : 0) + 0.5 * headT;
    for (const k of [-1, 1]) {
      const a = -k * stride * amp * 0.5, shX = tx + k * 0.24 * sc * (1 - Math.abs(side) * 0.6);
      g.strokeStyle = L.skin; g.lineWidth = 0.09 * sc;
      g.beginPath(); g.moveTo(shX, H(1.45)); g.lineTo(shX + side * a * 0.25 * sc + k * (0.04 + out) * sc, H(1.18 + 0.06 * out)); g.lineTo(shX + side * a * 0.4 * sc + k * out * 0.5 * sc, H(0.98 + 0.1 * out)); g.stroke();
    }
    // number on the back (shown when facing away from the camera), crest dot on the front
    if (fz < -0.3) { g.fillStyle = 'rgba(255,255,255,0.92)'; g.font = `700 ${Math.round(0.26 * sc)}px "Barlow Condensed", Arial, sans-serif`; g.textAlign = 'center'; g.fillText(String(L.number), tx, H(1.16)); }
    // head
    g.fillStyle = L.skin; g.beginPath(); g.arc(tx + side * 0.03 * sc, H(1.66 - 0.05 * shield + 0.05 * headT), 0.13 * sc, 0, 7); g.fill();
    if (!L.bald) { g.fillStyle = L.hair; g.beginPath(); g.arc(tx + side * 0.01 * sc, H(1.7 - 0.05 * shield + 0.05 * headT), 0.13 * sc, Math.PI * 1.05, Math.PI * 1.95); g.fill(); }
    // "you" chevron
    if (mine && view.live) { const cy = H(2.05) + Math.sin(t * 3.2) * 3; g.fillStyle = kit.css; g.beginPath(); g.moveTo(tx - 8, cy - 6); g.lineTo(tx, cy + 4); g.lineTo(tx + 8, cy - 6); g.lineTo(tx + 5, cy - 8); g.lineTo(tx, cy - 2); g.lineTo(tx - 5, cy - 8); g.fill(); }
  }

  function drawBall(t) {
    const b = ball, X = toX(b.x), Y0 = toY(b.z), Y = toY(b.z, b.h + BALL_R), r = Math.max(3, BALL_R * sx * 1.25);
    // trail
    if (b.trail.length > 2 && b.spd > 6) {
      g.strokeStyle = b.hot ? 'rgba(255,192,46,0.55)' : 'rgba(255,255,255,0.3)'; g.lineWidth = r * 1.2; g.lineCap = 'round';
      g.beginPath(); b.trail.forEach((p, i) => { const px = toX(p.x), py = toY(p.z, p.h + BALL_R); if (i) g.lineTo(px, py); else g.moveTo(px, py); }); g.stroke();
    }
    g.fillStyle = `rgba(0,0,0,${0.35 / (1 + b.h * 1.5)})`; g.beginPath(); g.ellipse(X, Y0, r * (1 + b.h * 0.4), r * 0.55 * (1 + b.h * 0.4), 0, 0, 7); g.fill();
    if (b.hot) { const gl = g.createRadialGradient(X, Y, 0, X, Y, r * 4); gl.addColorStop(0, 'rgba(255,200,60,0.55)'); gl.addColorStop(1, 'rgba(255,200,60,0)'); g.fillStyle = gl; g.fillRect(X - r * 4, Y - r * 4, r * 8, r * 8); }
    g.fillStyle = '#f7f7f7'; g.beginPath(); g.arc(X, Y, r, 0, 7); g.fill();
    g.fillStyle = '#1b1b1b';
    for (let k = 0; k < 3; k++) { const a = b.spin + k * 2.094; g.beginPath(); g.arc(X + Math.cos(a) * r * 0.5, Y + Math.sin(a) * r * 0.5, r * 0.26, 0, 7); g.fill(); }
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1; g.beginPath(); g.arc(X, Y, r, 0, 7); g.stroke();
  }

  let lastT = null;
  function frame(view, nowMs) {
    const now = (nowMs ?? performance.now()) / 1000, rawDt = lastT === null ? 1 / 60 : clamp(now - lastT, 0, 0.05); lastT = now;
    const dt = rawDt * (view.timeScale ?? 1), t = now, W = view.world;
    // camera: follow the ball across (the depth always fits), a little closer in replays
    const bx = W && W.ball ? wx(W.ball[0]) : 0, bz = W && W.ball ? wz(W.ball[1]) : 0;
    const maxPan = Math.max(0, (PW + GDP * 2 + 1.6) / 2 - cssW / 2 / sx);
    const zoomT = view.mode === 'replay' || view.mode === 'celebrate' ? 1.25 : 1;
    cam.zoom = damp(cam.zoom, zoomT, 2, rawDt);
    cam.x = damp(cam.x, clamp(bx, -maxPan - (zoomT - 1) * 6, maxPan + (zoomT - 1) * 6), 2.6, rawDt); cam.z = damp(cam.z, view.mode === 'replay' ? bz * 0.4 : 0, 2, rawDt);
    cam.shake *= Math.exp(-rawDt * 7); cam.kx *= Math.exp(-rawDt * 7); cam.kz *= Math.exp(-rawDt * 7);
    const base = sx; sx = base * cam.zoom;
    const shx = (Math.random() - 0.5) * cam.shake * 40 + cam.kx * 20, shy = (Math.random() - 0.5) * cam.shake * 40 + cam.kz * 20;
    g.setTransform(pr, 0, 0, pr, shx * pr, shy * pr);
    drawStadium();
    // ball state (and how far it is pressing into a net)
    if (W && W.ball) {
      const nx = bx, nz = bz, nh = (W.ball[3] || 0) * S;
      if (ball.lx !== undefined && Math.hypot(nx - ball.lx, nz - ball.lz) < 2 && dt > 0) { const d = Math.hypot(nx - ball.lx, nz - ball.lz); ball.spd = damp(ball.spd || 0, d / dt, 12, dt); ball.spin += d / BALL_R * 0.5; } else { ball.trail.length = 0; ball.spd = 0; }
      ball.lx = nx; ball.lz = nz; ball.x = nx; ball.z = nz; ball.h = nh; ball.hot = !!W.ball[2];
      ball.trail.unshift({ x: nx, z: nz, h: nh }); if (ball.trail.length > 10) ball.trail.pop();
      for (const s of [-1, 1]) { const over = s * nx - HW; netPush[s > 0 ? 1 : 0] = damp(netPush[s > 0 ? 1 : 0], over > GDP - 0.35 && Math.abs(nz) < GW / 2 ? 0.5 : 0, 10, dt); }
      hype = Math.max(hype * Math.exp(-dt * 0.8), Math.max(0, 1 - (HW - Math.abs(bx)) / 5) * 0.45);
    }
    view.hype = hype;
    // back of both nets, then everything sorted by depth (players, ball), then the goal frames
    drawGoal(-1, true); drawGoal(1, true);
    const items = [];
    if (W && W.players) W.players.forEach((p, i) => {
      if (view.hide && view.hide[i]) return;
      const P = players[i], name = (view.names && view.names[i]) || '';
      if (P.name !== name || !P.look) { P.name = name; P.look = lookFor(name, i); }
      const x = wx(p[0]), z = wz(p[1]);
      if (P.lx === null || Math.hypot(x - P.lx, z - P.lz) > 1.5) { P.lx = x; P.lz = z; }
      const sp = dt > 0 ? Math.hypot(x - P.lx, z - P.lz) / dt : 0; P.speed = damp(P.speed, sp, 10, dt); P.lx = x; P.lz = z;
      let dy = Math.atan2(p[2], p[3]) - P.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); P.yaw += dy * (1 - Math.exp(-12 * dt));
      P.phase += dt * (6 + P.speed * 2.2) * (P.speed > 0.3 ? 1 : 0);
      P.kick = Math.max(0, P.kick - dt * 4.5); P.swing = Math.max(0, P.swing - dt);
      P.tap = Math.max(0, P.tap - dt * 3.5); P.recv = Math.max(0, P.recv - dt * 3); P.head = Math.max(0, P.head - dt * 2.4);
      items.push({ z, draw: () => drawPlayer(P, i, p, view, t) });
    });
    if (W && W.ball) items.push({ z: ball.z + 0.01, draw: () => drawBall(t) });
    items.sort((a, b) => a.z - b.z).forEach(it => it.draw());
    drawGoal(-1, false); drawGoal(1, false);
    // near stand along the bottom edge
    const nearY = toY(HH + 1.6, 0);
    g.drawImage(standNear, toX(-HW - 9), nearY, (PW + 18) * sx, (standNear.height / standNear.width) * (PW + 18) * sx * 0.5);
    // aim arrow while charging, mouse target
    const me = W && W.players && view.mySlot >= 0 ? W.players[view.mySlot] : null;
    if (me && view.live && view.aim && view.localCt >= 0) {
      const x0 = toX(wx(me[0])), y0 = toY(wz(me[1])), len = (1.3 + 1.1 * Math.min(view.localCt / C.CHARGE_FULL, 1)) * sx;
      const perfect = view.localCt >= C.CHARGE_FULL && view.localCt <= C.PERF_END;
      g.strokeStyle = perfect ? '#ffd84d' : view.localLob ? '#7fdcff' : 'rgba(255,255,255,0.85)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(x0 + view.aim[0] * 0.45 * sx, y0 + view.aim[1] * 0.45 * sx * TILT); g.lineTo(x0 + view.aim[0] * len, y0 + view.aim[1] * len * TILT); g.stroke();
    }
    if (view.cursor && view.live) { g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 2; g.beginPath(); g.ellipse(toX(wx(view.cursor[0])), toY(wz(view.cursor[1])), 0.2 * sx, 0.2 * sx * TILT, 0, 0, 7); g.stroke(); }
    // particles
    for (let i = parts.length - 1; i >= 0; i--) {
      const q = parts[i]; q.life -= dt; if (q.life <= 0) { parts.splice(i, 1); continue; }
      q.vh -= q.grav * dt; q.x += q.vx * dt; q.z += q.vz * dt; q.h = Math.max(0, q.h + q.vh * dt);
      g.globalAlpha = Math.min(1, q.life / (q.max * 0.4)); g.fillStyle = q.col;
      g.fillRect(toX(q.x) - q.size * sx / 2, toY(q.z, q.h) - q.size * sx / 2, q.size * sx, q.size * sx);
    }
    g.globalAlpha = 1;
    // goal flash; the floodlight pool and vignette (baked once per size: gradients are costly to fill)
    if (flash > 0) { flash = Math.max(0, flash - rawDt * 1.5); g.fillStyle = `rgba(255,255,255,${flash * 0.25})`; g.fillRect(0, 0, cssW, cssH); }
    g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(overlay, 0, 0);
    sx = base;
  }

  const hex = c => '#' + c.toString(16).padStart(6, '0');
  const fx = {
    swing(slot, ticks) { players[slot].swing = ticks / 60; },
    kick(slot, x, y, perfect, power, dx = 0, dy = 0) {
      players[slot].kick = 1; players[slot].swing = 0;
      emit(wx(x), 0.05, wz(y), 6 + power * 8, { colors: ['#3d8b3f', '#5aa04f', '#7a5a36'], speed: 2.4 + power, up: 2.5 + power, size: 0.07 });
      if (power > 0.6) { cam.kx += dx * power * 0.3; cam.kz += dy * power * 0.3; }
      if (perfect) { emit(wx(x), 0.25, wz(y), 30, { colors: ['#ffd34d', '#fff1b0', '#ffa31a'], speed: 6, up: 4, size: 0.1, life: 0.8, grav: 4 }); cam.shake = Math.max(cam.shake, 0.12); }
    },
    touch(slot, x, y, f, foot, kind) {
      const P = players[slot]; if (P) { P.tap = 1; P.tapFoot = foot === 'L' ? 'L' : 'R'; }
      if (f > 4 || kind === 'knock') emit(wx(x), 0.03, wz(y), kind === 'knock' ? 6 : 3, { colors: ['#4f9a45'], speed: 1, up: 1.2, size: 0.05, life: 0.35 });
    },
    trap(slot, x, y, q, part) {
      const P = players[slot]; if (P) { P.recv = 1; P.recvPart = part || 'foot'; }
      emit(wx(x), 0.05, wz(y), 5, { colors: ['#4f9a45', '#d7e6c8'], speed: 1.4, up: 1.5, size: 0.06, life: 0.4 });
    },
    header(slot, x, y) {
      const P = players[slot]; if (P) P.head = 1;
      emit(wx(x), 1.7, wz(y), 10, { colors: ['#ffffff', '#d7e6c8'], speed: 2.2, up: 1.5, size: 0.07, life: 0.5 });
      cam.shake = Math.max(cam.shake, 0.05);
    },
    skid(x, y) { emit(wx(x), 0.04, wz(y), 10, { colors: ['#6e5a3c', '#8a7350', '#4f9a45'], speed: 1.8, up: 1.4, size: 0.09, life: 0.6, grav: 4 }); },
    bounce(x, y, f) { emit(wx(x), 0.04, wz(y), 3 + f, { colors: ['#6e5a3c', '#4f9a45'], speed: 1.2, up: 1.2, size: 0.07, life: 0.45 }); },
    bump(x, y, f) { cam.shake = Math.max(cam.shake, Math.min(0.12, f * 0.02)); },
    bar(x, y) { emit(wx(x), GOAL_H, wz(y), 20, { colors: ['#ffffff', '#dfe6f2', '#ffd34d'], speed: 4, up: 3, size: 0.08 }); cam.shake = Math.max(cam.shake, 0.2); hype = Math.max(hype, 0.9); },
    dash(slot, x, y) { emit(wx(x), 0.05, wz(y), 10, { colors: ['#9bbf8a', '#d7e6c8'], speed: 1.6, up: 1.2, size: 0.1, life: 0.5, grav: 3 }); },
    tackle(x, y) { emit(wx(x), 0.6, wz(y), 18, { colors: ['#ff9f43', '#ffffff', '#ffd34d'], speed: 4, up: 3, size: 0.1 }); cam.shake = Math.max(cam.shake, 0.25); },
    post(x, y) { emit(wx(x), 0.6, wz(y), 16, { colors: ['#ffffff', '#dddddd'], speed: 4, up: 3, size: 0.08, life: 0.5 }); cam.shake = Math.max(cam.shake, 0.2); hype = Math.max(hype, 0.8); },
    wall(x, y, sp) { if (sp > 12) cam.shake = Math.max(cam.shake, 0.06); },
    goal(scorer, x, y) {
      const col = KITS[scorer];
      emit(wx(x), 0.6, wz(y), 90, { colors: [hex(col.shirt), '#ffffff', col.css, '#ffd34d'], speed: 5, up: 8, size: 0.13, life: 2.2, grav: 3.5 });
      cam.shake = 0.35; hype = 1; flash = 1;
    },
    win(slot) { const col = KITS[slot]; for (let i = 0; i < 6; i++) emit((Math.random() - 0.5) * PW, 5, (Math.random() - 0.5) * PH, 20, { colors: [hex(col.shirt), '#ffffff', '#ffd34d'], speed: 1, up: 0.5, size: 0.13, life: 4, grav: 1.2 }); },
    shake(a) { cam.shake = Math.max(cam.shake, a); },
  };
  function project(x, y, h = 0) { return { x: toX(wx(x)), y: toY(wz(y), h), ok: true }; }
  function pickGround(px, py) { const x = (px - ox) / sx + cam.x, z = (py - oy) / (sx * TILT) + cam.z; return { x: x / S + C.CX, y: z / S + C.CY }; }
  return {
    frame, resize, project, pickGround, fx, setQuality() {}, snapCamera() {}, is2D: true,
    get quality() { return 'auto'; }, get level() { return 0; },
    debugCam: () => ({ renderer: '2d', sx, cam: { ...cam } }),
  };
}
