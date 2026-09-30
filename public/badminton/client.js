// Office Badminton — page client. Boots the 3D view, joins the room over the same WebSocket the
// football page uses (sport=badminton), sends the shared input shape and plays back the server's
// 60Hz snapshots on a smoothed clock. Everything the server says is authoritative; the client's
// only predictions are its own swing animation and charge ring.
import { createRenderer } from './render3d.js';
import { Sound } from './audio.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const TPMS = 60 / 1000;
const C = { POINTS: 7, CHARGE_FULL: 42, PERF_END: 58 };
const COLORS = ['#ff5a5f', '#57b6ff'];
const EMOTES = ['Nice!', 'Lucky!', 'Oof', 'GG', 'Rally!', '😤'];

let R = null, tier = 'high';
let ws = null, code = null, myId = null, room = null, matchInfo = null, result = null, lbList = [];
let everConnected = false, retry = 0, pingMs = null;
const token = (() => { try { let t = localStorage.getItem('obm_token'); if (!t) { t = [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join(''); localStorage.setItem('obm_token', t); } return t; } catch { return String(Math.random()).slice(2); } })();
const myName = () => { try { return (localStorage.getItem('obm_name') || '').slice(0, 16); } catch { return ''; } };
const setName = n => { try { localStorage.setItem('obm_name', n); } catch { } };

// ---------------------------------------------------------------- snapshot buffer + playback clock
const hist = [];
const pendingEvents = [];
const clock = {
  est: [], at: [], playT: null, delay: 0, rate: 1,
  reset() { this.est.length = 0; this.at.length = 0; this.playT = null; this.rate = 1; },
  onState(k, now) {
    this.est.push(k - now * TPMS); this.at.push(now);
    while (this.at.length > 2 && now - this.at[0] > 3000) { this.est.shift(); this.at.shift(); }
  },
  advance(now, dtMs) {
    if (!this.est.length) return null;
    let min = Infinity; for (const e of this.est) if (e < min) min = e;
    const target = now * TPMS + min - 2.2;
    if (this.playT === null || Math.abs(target - this.playT) > 90) { this.playT = target; this.rate = 1; }
    else {
      const err = target - this.playT;
      const want = err > 3 ? Math.min(1.7, 1 + err * 0.05) : 1 + clamp(err * 0.04, -0.08, 0.08);
      this.rate += (want - this.rate) * 0.2;
      this.playT += dtMs * TPMS * this.rate;
    }
    if (hist.length) this.delay = hist[hist.length - 1].k - this.playT;
    return this.playT;
  },
};
function onState(s) {
  const now = performance.now();
  if (hist.length && s.k <= hist[hist.length - 1].k) {
    if (hist[hist.length - 1].k - s.k > 120) { hist.length = 0; pendingEvents.length = 0; } else return;
  }
  clock.onState(s.k, now);
  s._at = now;
  hist.push(s);
  if (hist.length > 1500) hist.splice(0, hist.length - 1200);
  if (s.ev) for (const e of s.ev) { pendingEvents.push(e); noteStroke(e, s); }
}
// Strokes, as soon as a snapshot brings them: the renderer schedules each swing backwards from its
// contact tick, so seeing it a few frames early is what lets the racket arrive on time.
const strokes = [null, null];
let pointAt = null;
function noteStroke(e, s) {
  if (e.type === 'hit') strokes[e.p] = { tick: e.tick, kind: e.kind, x: e.x, y: e.y, z: e.z, pz: e.pz || 0, air: e.air };
  else if (e.type === 'swing' && s.p && s.p[e.p]) { const q = s.p[e.p]; strokes[e.p] = { tick: e.tick, kind: '', x: q[0] + q[4] * 0.7, y: q[1] + q[5] * 0.7, z: (q[14] || 0) + 1.6, pz: q[14] || 0, air: q[14] > 0.02 ? 1 : 0 }; }
  else if (e.type === 'point') pointAt = { p: e.p, tick: e.tick };
  else if (e.type === 'serve') pointAt = null;
}
function findIdx(tick) {
  let lo = 0, hi = hist.length - 1;
  if (hi < 0 || hist[0].k > tick) return -1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (hist[mid].k <= tick) lo = mid; else hi = mid - 1; }
  return lo;
}
function sampleAt(tick) {
  const i = findIdx(tick);
  if (i < 0) return hist.length ? { a: hist[0], b: hist[0], t: 0 } : null;
  if (i === hist.length - 1 && hist.length > 1 && tick > hist[i].k) {
    const a = hist[i - 1], b = hist[i], span = b.k - a.k;
    if (span > 0 && span < 6) return { a, b, t: 1 + Math.min(tick - b.k, 4) / span, s: b };
  }
  const a = hist[i], b = hist[Math.min(i + 1, hist.length - 1)];
  return { a, b, t: b.k > a.k ? clamp((tick - a.k) / (b.k - a.k), 0, 1) : 0 };
}
function interpWorld(v) {
  const { a, b, t } = v;
  if (!a.p) return null;
  if (!b.p) return { ball: a.b, players: a.p };
  const jump = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1) > 4;
  const ball = jump(a.b[0], a.b[1], b.b[0], b.b[1]) ? (t < 0.5 ? a.b : b.b)
    : [lerp(a.b[0], b.b[0], t), lerp(a.b[1], b.b[1], t), lerp(a.b[2], b.b[2], t), lerp(a.b[3], b.b[3], t), lerp(a.b[4], b.b[4], t), lerp(a.b[5], b.b[5], t)];
  const players = a.p.map((pa, k) => {
    const pb = b.p[k];
    if (jump(pa[0], pa[1], pb[0], pb[1])) return t < 0.5 ? pa : pb;
    const out = pa.slice();
    for (let i = 0; i < 6; i++) out[i] = lerp(pa[i], pb[i], t);
    if (pa.length > 15) { out[14] = Math.max(0, lerp(pa[14], pb[14], t)); out[15] = lerp(pa[15], pb[15], t); }
    return out;
  });
  return { ball, players };
}

// ---------------------------------------------------------------- networking
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function connect() {
  if (!code) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(code)}&sport=badminton`);
  const sock = ws;
  sock.onopen = () => {
    if (ws !== sock) return;
    retry = 0; everConnected = true;
    sock.send(JSON.stringify({ t: 'hello', name: myName(), token, practice: 'bot' }));
    $('conn').classList.add('hidden');
    lastSent = ''; sendInput();
  };
  sock.onmessage = e => { if (ws !== sock) return; let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
  sock.onclose = () => {
    if (ws !== sock) return;
    if (everConnected) $('conn').classList.remove('hidden');
    clock.reset();
    setTimeout(connect, Math.min(3000, 250 * ++retry));
  };
}
function handle(m) {
  switch (m.t) {
    case 's': onState(m); break;
    case 'welcome': myId = m.id; break;
    case 'room': {
      const prev = room ? room.members.filter(x => x.connected).length : 0;
      room = m; renderMembers();
      if (room.members.filter(x => x.connected).length > prev && prev > 0) Sound.fx.join();
      break;
    }
    case 'match': matchInfo = m; result = null; lastCountdown = -1; break;
    case 'result': result = m; resultAt = performance.now(); resultFx = false; break;
    case 'emote': showEmote(m.id, m.n); break;
    case 'toast': toast(m.text); break;
    case 'lb': lbList = m.list; if (menuOpen()) $('lbTable').innerHTML = lbHtml(lbList); break;
    case 'pong': pingMs = performance.now() - m.c; $('netInfo').textContent = `Connection ${pingMs.toFixed(0)} ms · smoothing ${Math.max(0, clock.delay * 16.7).toFixed(0)} ms · graphics ${tier}`; break;
  }
}
function mySlot() { return room && myId != null ? room.slots.indexOf(myId) : -1; }
function memberName(id) { if (id === 'bot') return 'BOT'; if (id === 'none') return 'PRACTICE'; const m = room && room.members.find(x => x.id === id); return m ? m.name : '?'; }
function slotName(i) { const id = room ? room.slots[i] : null; return id == null ? (i ? 'BLUE' : 'RED') : memberName(id); }

// ---------------------------------------------------------------- input
const KEYMAP = { KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r', Space: 'kick', KeyJ: 'kick', KeyE: 'lob', KeyL: 'lob', ShiftLeft: 'dash', ShiftRight: 'dash', KeyK: 'dash', KeyF: 'jump', KeyI: 'jump' };
const MOVE = new Set(['u', 'd', 'l', 'r']);
const held = new Set();
const kickSources = new Set();
const inp = { kp: 0, dc: 0, jp: 0, kn: 0, kc: null, kickDownAt: null, ax: 0, ay: 0, lob: false, lobArm: false };
const mouse = { x: 0, y: 0, has: false, at: 0 };
let touchMode = matchMedia('(hover: none) and (pointer: coarse)').matches;
let lastSent = '';
function typing(e) { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'); }
function sendInput(force) {
  const msg = {
    t: 'i',
    u: +(held.has('KeyW') || held.has('ArrowUp')), d: +(held.has('KeyS') || held.has('ArrowDown')),
    l: +(held.has('KeyA') || held.has('ArrowLeft')), r: +(held.has('KeyD') || held.has('ArrowRight')),
    k: inp.kickDownAt !== null, kp: inp.kp, kc: inp.kc, dc: inp.dc, jp: inp.jp, kn: inp.kn, lob: !!inp.lob, as: assistOn ? 1 : 0,
    ax: Math.round(inp.ax * 50) / 50, ay: Math.round(inp.ay * 50) / 50,
  };
  const s = JSON.stringify(msg);
  lastInput = msg;
  if (force || s !== lastSent) { lastSent = s; if (ws && ws.readyState === 1) ws.send(s); }
}
// WASD is relative to the camera you are looking through: W always runs toward the net, D to the
// right of the screen. The camera sits behind each player's own end, so the two ends mirror the
// mapping (player 0 lives at x<0, player 1 at x>0). Called on every key event as well as per frame,
// so a key reaches the server with its direction at once, not on the next drawn frame.
function keyAxes() {
  if (touchMode || padSeen) return;
  const side = mySlot() === 1 ? 1 : -1;
  const fwd = -side, rightY = -side;
  const wKey = (held.has('KeyW') || held.has('ArrowUp') ? 1 : 0) - (held.has('KeyS') || held.has('ArrowDown') ? 1 : 0);
  const dKey = (held.has('KeyD') || held.has('ArrowRight') ? 1 : 0) - (held.has('KeyA') || held.has('ArrowLeft') ? 1 : 0);
  const ax = fwd * wKey, ay = rightY * dKey, m = Math.hypot(ax, ay);
  // keys are all-or-nothing, so give them a stick's feel: a press starts at a light push and
  // ramps to full over KEY_RAMP ms. A quick tap is a small step (fine placement); a hold runs.
  const now = performance.now();
  if (!m) keyHeldSince = null; else if (keyHeldSince === null) keyHeldSince = now;
  const r = m ? 0.45 + 0.55 * Math.min(1, (now - keyHeldSince) / KEY_RAMP) : 0;
  inp.ax = m ? ax / m * r : 0; inp.ay = m ? ay / m * r : 0;
}
const KEY_RAMP = 140;
let keyHeldSince = null;
// placement assist (Settings): with no direction held, glide to where the shuttle is best met
let assistOn = (() => { try { return localStorage.getItem('obm_assist') !== '0'; } catch { return true; } })();
function kickDown(src) {
  if (!kickSources.size) { inp.kickDownAt = performance.now(); inp.kp++; inp.lobArm = false; }
  if (src.startsWith('lob:')) inp.lobArm = true;
  kickSources.add(src); sendInput();
}
function kickUp(src) {
  if (!kickSources.delete(src)) return;
  if (!kickSources.size) {
    inp.lob = !!inp.lobArm; inp.lobArm = false;
    inp.kc = Math.round((performance.now() - inp.kickDownAt) * TPMS);
    inp.kickDownAt = null;
  }
  sendInput();
}
function dashPress() { inp.dc++; sendInput(); }
function jumpPress() { inp.jp++; sendInput(); }
function releaseAll() { held.clear(); for (const s of [...kickSources]) kickUp(s); inp.ax = inp.ay = 0; sendInput(); }
function setupInput() {
  addEventListener('keydown', e => {
    if (!code || typing(e) || menuOpen()) { if (e.code === 'Escape' && code && !typing(e)) { menuOpen() ? closeMenu() : openMenu('room'); e.preventDefault(); } return; }
    if (e.code === 'Escape') { openMenu('room'); e.preventDefault(); return; }
    const act = KEYMAP[e.code];
    if (act) e.preventDefault();
    if (e.repeat) return;
    if (/^Digit[1-6]$/.test(e.code)) { send({ t: 'emote', n: +e.code.slice(5) - 1 }); return; }
    if (e.code === 'KeyM') { Sound.toggle(); if (setupMenu.muteLabel) setupMenu.muteLabel(); return; }
    if (!act) return;
    held.add(e.code);
    if (act === 'kick') kickDown('key:' + e.code);
    if (act === 'lob') kickDown('lob:' + e.code);
    if (act === 'dash') dashPress();
    if (act === 'jump') jumpPress();
    if (MOVE.has(act) && !(mouse.has && performance.now() - mouse.at < 2000)) keyAxes();
    sendInput();
  });
  addEventListener('keyup', e => {
    if (!held.has(e.code)) return;
    held.delete(e.code);
    if (KEYMAP[e.code] === 'kick') kickUp('key:' + e.code);
    if (KEYMAP[e.code] === 'lob') kickUp('lob:' + e.code);
    if (MOVE.has(KEYMAP[e.code]) && !(mouse.has && performance.now() - mouse.at < 2000)) keyAxes();
    sendInput();
  });
  const view = $('view');
  view.addEventListener('pointermove', e => {
    const r = view.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.has = true; mouse.at = performance.now();
  });
  view.addEventListener('pointerdown', e => {
    if (!code || e.target.closest('button, input, a, .interactive')) return;
    const r = view.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.has = true; mouse.at = performance.now();
    if (e.pointerType === 'touch') { touchMode = true; return; }
    if (e.button === 0 && e.shiftKey) { kickDown('lob:mouse'); e.preventDefault(); }
    else if (e.button === 0) { kickDown('mouse'); e.preventDefault(); }
    else if (e.button === 1) { kickDown('lob:mouse'); e.preventDefault(); }
    else if (e.button === 2) { dashPress(); e.preventDefault(); }
    else if (e.button === 3 || e.button === 4) { jumpPress(); e.preventDefault(); } // the thumb buttons
  });
  addEventListener('pointerup', e => {
    if (e.button === 0) { kickUp('mouse'); kickUp('lob:mouse'); }
    if (e.button === 1) kickUp('lob:mouse');
  });
  view.addEventListener('contextmenu', e => e.preventDefault());
  addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
  addEventListener('gamepadconnected', () => toast('Controller detected. Move the stick to use it', 3000));
  setInterval(() => sendInput(true), 250);
  setupTouch();
}
let padPrev = { kick: false, dash: false, lob: false, jump: false }, padSeen = false;
function pollGamepad() {
  if (touchMode) return;
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp = null; for (const p of pads) if (p && p.connected) { gp = p; break; }
  if (!gp) return;
  const b = i => !!(gp.buttons[i] && gp.buttons[i].pressed);
  let x = gp.axes[0] || 0, y = gp.axes[1] || 0;
  if (b(14)) x = -1; if (b(15)) x = 1; if (b(12)) y = -1; if (b(13)) y = 1;
  const m = Math.hypot(x, y);
  if (m > 0.25 || b(0) || b(2) || b(3)) padSeen = true;
  if (!padSeen) return;
  // stick is screen-relative, like WASD: push up to run at the net, right to move screen-right
  const side = mySlot() === 1 ? 1 : -1;
  if (m < 0.2) { inp.ax = inp.ay = 0; } else {
    const mm = Math.min(1, (m - 0.2) / 0.65), nx = x / m * mm, ny = y / m * mm;
    inp.ax = -ny * -side; inp.ay = nx * -side;
  }
  const kick = b(0) || b(7), lobB = b(3), dsh = b(2) || b(4), jmp = b(1) || b(5);
  if (kick && !padPrev.kick) kickDown('pad');
  if (!kick && padPrev.kick) kickUp('pad');
  if (lobB && !padPrev.lob) kickDown('lob:pad');
  if (!lobB && padPrev.lob) kickUp('lob:pad');
  if (dsh && !padPrev.dash) dashPress();
  if (jmp && !padPrev.jump) jumpPress();
  padPrev.kick = kick; padPrev.lob = lobB; padPrev.dash = dsh; padPrev.jump = jmp;
  sendInput();
}
// touch: left half is a floating stick, right side is Shoot / Lift / Dash
let touchStick = null;
function setupTouch() {
  const zone = $('stickZone'), stick = $('stick'), knob = $('knob');
  const pos = (el, e) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  zone.addEventListener('pointerdown', e => {
    if (!touchMode) touchMode = true;
    $('touchui').classList.remove('hidden');
    const r = zone.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    touchStick = { id: e.pointerId, x, y };
    stick.style.left = x + 'px'; stick.style.top = y + 'px'; stick.classList.add('on');
    e.preventDefault();
  });
  zone.addEventListener('pointermove', e => {
    if (!touchStick || e.pointerId !== touchStick.id) return;
    const r = zone.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let dx = x - touchStick.x, dy = y - touchStick.y;
    const d = Math.hypot(dx, dy), max = 55;
    if (d > max) { dx *= max / d; dy *= max / d; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const mag = Math.min(1, d / max);
    // screen-relative, like WASD: up runs at the net, right moves screen-right
    const side = mySlot() === 1 ? 1 : -1;
    if (mag < 0.15) { inp.ax = inp.ay = 0; } else {
      const nx = dx / Math.max(1, d) * mag, ny = dy / Math.max(1, d) * mag;
      inp.ax = -ny * -side; inp.ay = nx * -side;
    }
    sendInput();
  });
  const end = e => { if (touchStick && e.pointerId === touchStick.id) { touchStick = null; stick.classList.remove('on'); knob.style.transform = ''; inp.ax = inp.ay = 0; sendInput(); } };
  zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end);
  const tShoot = $('tShoot');
  tShoot.addEventListener('pointerdown', e => { touchMode = true; kickDown('touch'); e.preventDefault(); });
  tShoot.addEventListener('pointerup', e => { kickUp('touch'); e.preventDefault(); });
  tShoot.addEventListener('pointercancel', () => kickUp('touch'));
  const tLift = $('tLift');
  tLift.addEventListener('pointerdown', e => { kickDown('lob:touch'); e.preventDefault(); });
  tLift.addEventListener('pointerup', e => { kickUp('lob:touch'); e.preventDefault(); });
  tLift.addEventListener('pointercancel', () => kickUp('lob:touch'));
  $('tDash').addEventListener('pointerdown', e => { dashPress(); e.preventDefault(); });
  $('tJump').addEventListener('pointerdown', e => { jumpPress(); e.preventDefault(); });
}

// ---------------------------------------------------------------- HUD + screens
function toast(text, ms = 3000) {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 350); }, ms);
}
// a full-screen flash of colour for the biggest contacts (a parry, a perfect jump smash)
function flash(color, a) {
  const el = $('flash'); if (!el) return;
  el.style.background = `radial-gradient(ellipse at center, ${color}00 30%, ${color} 100%)`;
  el.style.transition = 'none'; el.style.opacity = a; void el.offsetWidth;
  el.style.transition = 'opacity .45s cubic-bezier(.2,.8,.2,1)'; el.style.opacity = 0;
}
// slow motion: the playback clock runs at k for `ms`, then catches back up on its own
let slowK = 1, slowUntil = 0;
function slowmo(k, ms) { slowK = k; slowUntil = performance.now() + ms; }
function banner(text, sub, color) {
  const b = $('banner'), band = b.querySelector('.bn-band');
  band.style.setProperty('--c', color || '#e4ff3c');
  $('bnText').textContent = text; $('bnSub').textContent = sub || '';
  b.classList.remove('on'); void b.offsetWidth; b.classList.add('on');
}
function bigText(text, color = '#fff', hold = false) {
  const el = $('bigText');
  el.textContent = text; el.style.color = color;
  el.classList.remove('show', 'hold'); void el.offsetWidth;
  el.classList.add(hold ? 'hold' : 'show');
}
function floatText(x, y, z, text, color, size = 34) {
  if (!R) return;
  const p = R.project(x, y, z);
  const el = document.createElement('div'); el.className = 'float';
  el.textContent = text; el.style.color = color; el.style.fontSize = size + 'px';
  el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
  $('labels').appendChild(el); setTimeout(() => el.remove(), 1150);
}
function lbHtml(list) {
  if (!list || !list.length) return '<div class="lb-empty">No ranked matches yet. Win one and the table starts.</div>';
  const me = myName().toLowerCase();
  return list.map((p, i) => `<div class="lb-row${p.name.toLowerCase() === me ? ' me' : ''}"><span class="rk">${i + 1}</span><span class="nm">${esc(p.name)}</span><span class="wl">${p.w}-${p.l}</span><span class="rt">${p.rating}</span></div>`).join('');
}
function showEmote(id, n) {
  const slot = room ? room.slots.indexOf(id) : -1;
  const who = memberName(id);
  toast(`${who}: ${EMOTES[n] || '?'}`, 2200);
  const s = hist[hist.length - 1];
  if (slot >= 0 && s && s.p && s.p[slot]) floatText(s.p[slot][0], s.p[slot][1], 2.6, EMOTES[n] || '?', '#e4ff3c', 26);
}
function renderMembers() {
  if (!room) return;
  const rows = [];
  const row = (id, name, bar, status, rating, off) => rows.push(
    `<li class="${off ? 'off' : ''}"><span class="bar ${bar}"></span><span class="nm">${esc(name)}${id === myId ? '<span class="you">You</span>' : ''}${room.streak && room.streak.id === id && room.streak.n >= 2 ? `<span class="you">W${room.streak.n}</span>` : ''}</span><span class="st">${status}</span><span class="rt">${rating != null ? rating : ''}</span></li>`);
  room.slots.forEach((id, i) => {
    if (id === 'none') return;
    if (id === 'bot') row('bot', 'Bot', i ? 'blue' : 'red', 'Practice', null);
    else if (id != null) { const m = room.members.find(x => x.id === id); if (m) row(m.id, m.name, i ? 'blue' : 'red', m.connected ? 'Playing' : 'Reconnecting', m.rating, !m.connected); }
  });
  room.queue.forEach((id, qi) => { const m = room.members.find(x => x.id === id); if (m) row(m.id, m.name, 'q', qi === 0 ? 'Next up' : `#${qi + 1} in line`, m.rating); });
  room.members.filter(m => !room.slots.includes(m.id) && !room.queue.includes(m.id)).forEach(m =>
    row(m.id, m.name, '', m.connected ? 'Sitting out' : 'Offline', m.rating, !m.connected));
  $('memberList').innerHTML = rows.join('');
  const me = room.members.find(m => m.id === myId);
  $('sitBtn').textContent = me && me.sitting ? 'Join the line' : 'Sit out';
}
let screenKey = '', lastCountdown = -1, resultAt = 0, resultFx = false, lastBig = '', lastRc = 0;
function setScreen(key, html) { if (key === screenKey) return; screenKey = key; $('screen').innerHTML = html; }
const inviteBox = () => `<div class="invite interactive"><input readonly value="${esc(shareUrl)}" onclick="this.select()"><button class="btn primary" data-act="copy">Copy link</button></div>`;
function renderScreens(s) {
  const ms = mySlot();
  const me = room && room.members.find(m => m.id === myId);
  if (!myName()) {
    setScreen('name', `<div class="scrim"></div><div class="card"><div class="cap">Before you play</div><h2>Your name</h2>
      <input id="nmi" maxlength="16" placeholder="Name" autocomplete="off" spellcheck="false" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f2f4f7;padding:10px 12px;border-radius:4px;font-size:15px;width:100%">
      <button id="nmgo" class="btn primary" style="margin-top:12px">Continue</button></div>`);
    const i = $('nmi'), b = $('nmgo');
    if (i && b) {
      i.focus();
      b.onclick = () => { const n = i.value.trim().slice(0, 16); if (!n) return; setName(n); send({ t: 'name', name: n }); screenKey = ''; };
      i.onkeydown = e => { if (e.key === 'Enter') b.click(); };
    }
    return;
  }
  if (!s || s.rp === 'waiting') {
    setScreen('wait' + (me && me.sitting), me && me.sitting
      ? `<div class="scrim"></div><div class="card"><div class="cap">Room ${esc(code)}</div><h2>Sitting out</h2><p>Open the menu (Esc) and pick Room, then Join the line, to play.</p></div>`
      : `<div class="scrim"></div><div class="card"><div class="cap">Room ${esc(code)}</div><h2>Waiting for players</h2><p>Send this link to a teammate. The match starts when they open it.</p>${inviteBox()}</div>`);
  } else if (s.rp === 'prematch' && matchInfo) {
    const mi = matchInfo, secs = Math.max(1, Math.ceil((s.rt || 0) / 60));
    if (secs !== lastCountdown) { if (lastCountdown !== -1) Sound.fx.beep(false); lastCountdown = secs; }
    if (mi.bot) setScreen('pre-practice', '');
    else setScreen('pre-' + mi.names.join('|'), `<div class="vs">
      <div class="vs-side red"><div class="vs-kicker">Red${ms === 0 ? ' · You' : ''}</div><div class="vs-name">${esc(mi.names[0])}</div><div class="vs-rating">${mi.ratings[0] != null ? mi.ratings[0] : ''}</div></div>
      <div class="vs-mid"><div class="vs-vs">VS</div><div class="vs-count" id="cnt"></div></div>
      <div class="vs-side blue"><div class="vs-kicker">${ms === 1 ? 'You · ' : ''}Blue</div><div class="vs-name">${esc(mi.names[1])}</div><div class="vs-rating">${mi.ratings[1] != null ? mi.ratings[1] : ''}</div></div>
      <div class="vs-info">${mi.h2h ? `Head to head ${mi.h2h[0]} – ${mi.h2h[1]}` : 'First meeting'} · first to ${C.POINTS}</div>
      <div class="vs-you">${ms >= 0 ? 'You defend the ' + (ms === 0 ? 'left' : 'right') + ' court' : 'Watching'}</div></div>`);
    const cn = $('cnt'); if (cn) cn.textContent = secs;
  } else if (s.rp === 'paused') {
    const gone = room ? room.slots.map(id => room.members.find(m => m.id === id)).find(m => m && !m.connected) : null;
    setScreen('paused', `<div class="scrim"></div><div class="card"><div class="cap">Paused</div><h2>${esc(gone ? gone.name : 'Opponent')} dropped</h2><p>Waiting <b id="pz"></b>s for them to come back.</p></div>`);
    const p = $('pz'); if (p) p.textContent = Math.ceil((s.rt || 0) / 60);
  } else if (s.rp === 'over' && result) {
    const r = result, w = r.winner;
    const title = ms === w ? 'Victory' : ms >= 0 ? 'Defeat' : `${esc(r.names[w])} wins`;
    const cls = ms >= 0 && ms !== w ? 'lose' : 'win';
    let elo = '';
    if (r.elo) {
      const d = v => `<span class="${v > 0 ? 'up' : 'down'}">${v > 0 ? '+' : ''}${v}</span>`;
      elo = `<div class="ft-elo"><span>${esc(r.names[0])}<b>${r.ratings[0]}</b>${d(r.elo[0])}</span><span>${d(r.elo[1])}<b>${r.ratings[1]}</b>${esc(r.names[1])}</span></div>`;
    }
    const notes = [];
    if (r.forfeit) notes.push('<div class="ft-note">Won by forfeit</div>');
    if (r.h2h) notes.push(`<div class="ft-note">Head to head: ${esc(r.names[0])} ${r.h2h[0]} – ${r.h2h[1]} ${esc(r.names[1])}</div>`);
    if (r.streak) notes.push(`<div class="ft-note hl">${esc(r.streak.name)}: ${r.streak.n} wins in a row</div>`);
    const loserId = room ? room.slots[1 - w] : null;
    const ch = room && room.queue.find(id => id !== loserId);
    const next = r.bot ? (room && room.queue.length ? 'Real match next' : 'Rematch vs bot') : ch != null ? `Next: ${esc(r.names[w])} v ${esc(memberName(ch))}` : 'Rematch';
    // the server sends each player's stats as a named object (sim p.st); older builds sent arrays
    const st = i => r.stats && r.stats[i] || {};
    const row = (label, fn, suf = '') => {
      const a = fn(st(0)) | 0, b = fn(st(1)) | 0, m = Math.max(1, a, b);
      return `<div class="stat"><span class="v">${a}${suf}</span><span class="bar lb0"><i style="width:${a / m * 100}%"></i></span><span class="l">${label}</span><span class="bar lb1"><i style="width:${b / m * 100}%"></i></span><span class="v">${b}${suf}</span></div>`;
    };
    const stats = [row('Hits', x => x.hits), row('Smashes', x => x.smashes), row('Perfect', x => x.perfects), row('Points won', x => x.winners), row('Aces', x => x.aces), row('Dives', x => x.dives), row('Longest rally', x => x.maxRally)].join('');
    setScreen('over' + r.score.join() + r.names.join(), `<div class="scrim"></div><div class="ft">
      <div class="ft-head"><span>Full time</span><span class="accent">${r.bot ? 'Practice' : r.rated ? 'Ranked' : 'Friendly'}</span></div>
      <div class="ft-title ${cls}">${title}</div>
      <div class="ft-score"><span class="nm l">${esc(r.names[0])}</span><span class="num l">${r.score[0]}</span><span class="dash">–</span><span class="num r">${r.score[1]}</span><span class="nm">${esc(r.names[1])}</span></div>
      <div class="ft-stats">${stats}</div>
      <div class="ft-foot">${elo}${notes.join('')}
        <div class="ft-next"><span>${next} in <span id="nx"></span>s</span><span class="ft-ready" id="rdy"></span></div>
      </div></div>`);
    const nx = $('nx'); if (nx) nx.textContent = Math.max(0, Math.ceil((s.rt || 0) / 60));
    const rdy = $('rdy');
    if (rdy) {
      if (ms >= 0) { const ok = s.rd && s.rd[ms]; rdy.textContent = ok ? 'Ready' : 'Shoot to ready up'; rdy.className = 'ft-ready' + (ok ? ' ok' : ''); }
      else { const qi = room ? room.queue.indexOf(myId) : -1; rdy.textContent = qi === 0 ? "You're next" : ''; }
    }
    if (!resultFx && performance.now() - resultAt > 700) {
      resultFx = true;
      if (ms >= 0) Sound.fx.game(ms === w);
    }
  } else setScreen('', '');
}

// ---------------------------------------------------------------- events
function fireEvent(e) {
  const mine = () => mySlot();
  const isMine = e.p === mySlot();
  if (window.__ob) { window.__ob.events++; if (e.type === 'hit') { window.__ob.hits++; if (isMine) window.__ob.myHits++; } }
  switch (e.type) {
    case 'serve': Sound.fx.serve(); break;
    case 'swing': Sound.fx.swing(); break;
    case 'hit': {
      Sound.fx.hit(e.kind, e.kmh, e.perfect, e);
      if (R) R.fx.hit(e);
      const zt = Math.max(1.2, e.z + 0.5);
      // the callout: the big moments get their name in lights, the rest a quiet label for you
      if (e.parry) { floatText(e.x, e.y, zt, 'PARRY!', '#ffd34d', 46); flash('#ffd34d', 0.35); }
      else if (e.kind === 'jsmash') { floatText(e.x, e.y, zt, `JUMP SMASH ${e.kmh} KM/H`, e.perfect ? '#ffd34d' : '#ff8f6b', e.perfect ? 44 : 38); if (e.perfect) flash('#ff8f6b', 0.28); }
      else if (e.kind === 'counter') floatText(e.x, e.y, zt, 'COUNTER', '#7fd8ff', 34);
      else if (e.kind === 'kill') floatText(e.x, e.y, zt, 'KILL', '#ff5a5f', 38);
      else if (e.kind === 'block' && e.p === mine() ) floatText(e.x, e.y, zt, 'BLOCK', '#b8f0ff', 26);
      else if (e.perfect) floatText(e.x, e.y, zt, `PERFECT ${e.kind.toUpperCase()}`, '#ffd34d', 40);
      else if (e.kind === 'smash' && e.kmh >= 170) floatText(e.x, e.y, zt, `${e.kmh} KM/H`, '#ff8f6b', 34);
      else if (mine()  === e.p) {
        const label = { smash: 'SMASH', clear: 'CLEAR', drive: 'DRIVE', drop: 'DROP', net: 'NET SHOT', lift: 'LIFT', servel: 'SERVE', serveh: 'HIGH SERVE' }[e.kind] || '';
        if (label && e.kind !== 'smash') floatText(e.x, e.y, Math.max(1.0, e.z + 0.4), label, '#b8f0ff', 24);
      }
      if (e.err && e.p === mine()) floatText(e.x, e.y, zt + 0.4, e.err === 'net' ? 'FRAMED IT' : 'MISHIT', '#ff9b9b', 24);
      if (e.perfect && (e.kind === 'smash' || e.kind === 'jsmash')) Sound.fx.rally(20);
      break;
    }
    case 'jump': Sound.fx.jump(e.leap); if (R) R.fx.dust(e.x, e.y, 0.6); break;
    case 'land': Sound.fx.land(e.hard, e.v); if (R) { R.fx.dust(e.x, e.y, e.hard ? 1.3 : 0.8); if (e.hard) R.fx.shake(0.05); } break;
    case 'whiff': if (isMine) Sound.fx.swing(); break;
    case 'net': Sound.fx.net(); if (R) R.fx.net(e.x, e.y, e.z); break;
    case 'dash': break;
    case 'dive': Sound.fx.dive(); break;
    case 'point': {
      Sound.fx.point(e.p === mySlot(), e.score[e.p] >= C.POINTS);
      const how = { jsmash: 'JUMP SMASH!', smash: 'SMASH!', kill: 'PUT AWAY!', counter: 'COUNTERED!', block: 'BLOCKED!' }[e.kind];
      const reason = (e.reason === 'winner' && how) || { ace: 'ACE!', winner: 'WINNER!', out: 'OUT!', fault: 'FAULT', 'own side': 'IN THE NET' }[e.reason] || 'POINT';
      banner(reason, `${e.score[0]} – ${e.score[1]} · rally of ${e.rally}`, COLORS[e.p]);
      const sb = $('s' + e.p); if (sb) { sb.classList.remove('bump'); void sb.offsetWidth; sb.classList.add('bump'); }
      // a smash that kills comes down on the floor: crater, dust, the hall shakes; the winning
      // point of a match is played back slow for a moment
      if (e.slam && R) { R.fx.slam(e.x, e.y, e.kmh); Sound.fx.slam(e.kmh); if (e.score[e.p] >= C.POINTS) slowmo(0.35, 900); }
      if (R && R.fx.point) R.fx.point(e.p);
      break;
    }
    case 'end': break;
    case 'whistle': Sound.fx.whistle(); break;
  }
}

// ---------------------------------------------------------------- menu + home
function menuOpen() { return !$('menu').classList.contains('hidden'); }
function openMenu(pane = 'room') { $('menu').classList.remove('hidden'); showPane(pane); releaseAll(); }
function closeMenu() { $('menu').classList.add('hidden'); }
function showPane(pane) {
  document.querySelectorAll('.menu-nav button').forEach(b => b.classList.toggle('on', b.dataset.pane === pane));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.dataset.pane === pane));
  if (pane === 'invite') updateShareLink();
  if (pane === 'table') $('lbTable').innerHTML = lbHtml(lbList);
}
let shareUrl = '';
function updateShareLink() { shareUrl = `${location.protocol}//${location.host}/badminton/r/${code}`; $('shareLink').value = shareUrl; }
function copyText(v, btn) {
  const done = () => { if (btn) { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy link'; }, 1200); } };
  if (navigator.clipboard) navigator.clipboard.writeText(v).then(done).catch(() => { });
  else { const i = $('shareLink'); i.select(); document.execCommand('copy'); done(); }
}
const CTRL_HELP = `<span class="do">Move</span><span class="how">WASD / arrows, or the pointer (your player runs to it). Left stick on a pad. A quick tap is a small step; hold to run. With no direction held, your player glides the last metre or two to where the shuttle is best met (Settings: Placement assist).</span>
  <span class="do">Shot</span><span class="how">Hold <b>Space</b> / click / <b>A</b>, release. Where you meet it decides the shot: overhead full charge = <b>smash</b>, soft = <b>drop</b>; waist = <b>drive</b>; low full = <b>clear</b>, soft = <b>net shot</b>; full charge on a shuttle floating over the tape = <b>kill</b>. Release on gold for a perfect strike.</span>
  <span class="do">Jump</span><span class="how"><b>F</b> / <b>B</b> / mouse thumb button. Crouch, then up: meet a high shuttle at the top of the jump with a full charge for a <b>jump smash</b> (faster, steeper, a heavier landing). Out of a dash it is a long leap.</span>
  <span class="do">Defend a smash</span><span class="how">It is too fast to react to: read the wind-up. Hold Shot to <b>brace</b>, release as it arrives to <b>counter</b> it flat into the open court (clean and on time = <b>parry</b>). A late tap <b>blocks</b> it dead over the net; <b>Lift</b> sends it high.</span>
  <span class="do">Lift</span><span class="how">Hold <b>E</b> / <b>Y</b> while shooting to send it high and deep</span>
  <span class="do">Dash / dive</span><span class="how"><b>Shift</b> / <b>X</b> bursts toward the shuttle; beside a dying shuttle it becomes a diving save. Costs stamina.</span>
  <span class="do">Serve</span><span class="how">When you're serving, stand still and shoot: soft is a low serve, full charge is a high deep serve</span>`;
function setupMenu() {
  document.querySelectorAll('.menu-nav button').forEach(b => b.onclick = () => {
    if (b.dataset.pane === 'leave') { leaveRoom(); closeMenu(); navigate('/badminton'); return; }
    if (b.dataset.pane === 'resume') { closeMenu(); return; }
    showPane(b.dataset.pane);
  });
  $('menuBtn').onclick = () => menuOpen() ? closeMenu() : openMenu('room');
  $('inviteBtn').onclick = () => { updateShareLink(); openMenu('invite'); };
  $('copyBtn').onclick = e => copyText(shareUrl, e.currentTarget);
  $('sitBtn').onclick = () => { const me = room && room.members.find(m => m.id === myId); send({ t: 'sit', v: !(me && me.sitting) }); };
  $('renameBtn').onclick = () => { const n = prompt('Your name', myName()); if (n && n.trim()) { setName(n.trim().slice(0, 16)); send({ t: 'name', name: n.trim().slice(0, 16) }); } };
  const ab = $('assistBtn');
  if (ab) {
    const label = () => { ab.textContent = assistOn ? 'On' : 'Off'; };
    label();
    ab.onclick = () => { assistOn = !assistOn; try { localStorage.setItem('obm_assist', assistOn ? '1' : '0'); } catch { } label(); sendInput(true); };
  }
  const mb = $('muteBtn');
  setupMenu.muteLabel = () => { mb.textContent = Sound.muted ? 'Off' : 'On'; };
  setupMenu.muteLabel();
  mb.onclick = () => { Sound.toggle(); setupMenu.muteLabel(); };
  const q = $('qualitySel');
  const tiers = ['auto', 'high', 'medium', 'lite'];
  const names = { auto: 'Auto', high: 'High', medium: 'Medium', lite: 'Low' };
  q.innerHTML = tiers.map(t => `<option value="${t}">${names[t]}</option>`).join('');
  let pref = 'auto'; try { pref = localStorage.getItem('obm_graphics') || 'auto'; } catch { }
  q.value = tiers.includes(pref) ? pref : 'auto';
  q.onchange = () => { try { localStorage.setItem('obm_graphics', q.value); } catch { } location.reload(); };
  $('fsBtn').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); };
  $('emoteBtn').onclick = () => send({ t: 'emote', n: (Math.random() * 6) | 0 });
  $('ctrlHelp').innerHTML = CTRL_HELP;
}
function navigate(path) { if (location.pathname !== path) history.pushState(null, '', path); route(); }
function setupHome() {
  const nameInput = $('nameInput');
  nameInput.value = myName();
  const ensureName = () => { const n = nameInput.value.trim().slice(0, 16); if (!n) { nameInput.focus(); toast('Type a name first'); return null; } setName(n); return n; };
  $('createBtn').onclick = async () => { if (!ensureName()) return; try { const r = await (await fetch('/api/new', { cache: 'no-store' })).json(); navigate('/badminton/r/' + r.code); } catch { toast('Could not reach the host'); } };
  $('practiceBtn').onclick = async () => { if (!ensureName()) return; try { const r = await (await fetch('/api/new', { cache: 'no-store' })).json(); navigate('/badminton/r/' + r.code); toast('Practice starts as soon as you are alone in the room'); } catch { toast('Could not reach the host'); } };
  const join = () => { const c = $('codeInput').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); if (!c) { $('codeInput').focus(); return; } if (!ensureName()) return; navigate('/badminton/r/' + c); };
  $('joinBtn').onclick = join;
  $('codeInput').onkeydown = e => { if (e.key === 'Enter') join(); };
  nameInput.onkeydown = e => { if (e.key === 'Enter') $('createBtn').click(); };
}
async function refreshHome() {
  if (code) return;
  try {
    const [rooms, lb] = await Promise.all([
      (await fetch('/api/rooms?sport=badminton', { cache: 'no-store' })).json(),
      (await fetch('/api/leaderboard?sport=badminton', { cache: 'no-store' })).json(),
    ]);
    $('homeLb').innerHTML = lbHtml(lb);
    $('roomsList').innerHTML = rooms.length ? rooms.map(r =>
      `<div class="room-row interactive" data-code="${esc(r.code)}"><span class="rc">${esc(r.code)}</span><span class="rn">${esc(r.names.join(', '))}</span>${r.live ? '<span class="live">LIVE</span>' : `<span class="cap">${r.players} in</span>`}</div>`).join('') : '';
    document.querySelectorAll('.room-row').forEach(el => el.onclick = () => {
      const n = $('nameInput').value.trim().slice(0, 16);
      if (!n) { $('nameInput').focus(); toast('Type a name first'); return; }
      setName(n); navigate('/badminton/r/' + el.dataset.code);
    });
  } catch { }
}
function enterRoom(c) {
  $('home').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('roomCode').textContent = c; $('roomCode2').textContent = c;
  $('touchui').classList.toggle('hidden', !touchMode);
  hist.length = 0; pendingEvents.length = 0; clock.reset();
  connect();
}
function leaveRoom() {
  code = null; myId = null; room = null; matchInfo = null; result = null;
  hist.length = 0; pendingEvents.length = 0; clock.reset();
  if (ws) { const s = ws; ws = null; try { s.close(); } catch { } }
  $('conn').classList.add('hidden');
  $('hud').classList.add('hidden');
  screenKey = '';
}
function route() {
  const m = location.pathname.match(/^\/badminton\/r\/([A-Za-z0-9]{1,8})\/?$/i);
  const c = m ? m[1].toUpperCase() : null;
  if (c === code) {
    if (!c) { showHome(); refreshHome(); } // already home: make sure the menu is the thing on screen
    return;
  }
  if (code) leaveRoom();
  code = c;
  if (code) enterRoom(code);
  else showHome();
}
function showHome() {
  $('home').classList.remove('hidden');
  $('hud').classList.add('hidden');
  $('screen').innerHTML = ''; screenKey = '';
  $('conn').classList.add('hidden');
  refreshHome();
}

// ---------------------------------------------------------------- own-player prediction
// Your own player is not drawn from the delayed playback: it is stepped here, at 60 Hz, with the
// same movement rules as the sim (stepPlayer in shared/badminton.js), so it answers the keys on the
// frame you press them. Each new snapshot is compared with where this prediction stood when the
// server was applying the same inputs (one round trip earlier); the difference is folded back in
// gently, or snapped when the server moved the player itself (a serve reset, a dash or a dive).
const own = { on: false, slot: -1, x: 0, y: 0, vx: 0, vy: 0, fx: 1, fy: 0, acc: 0, k: -1, hist: [] };
let lastInput = null;
function selfReset(sp, ms) {
  Object.assign(own, { on: true, slot: ms, i: ms, x: sp[0], y: sp[1], vx: sp[2], vy: sp[3], fx: sp[4], fy: sp[5], acc: 0 });
  own.hist.length = 0;
}
function selfStep(K, fresh, sp) {
  const m0 = lastInput || {};
  let ax = 0, ay = 0;
  if (m0.ax || m0.ay) { ax = m0.ax || 0; ay = m0.ay || 0; } else { ax = (m0.r ? 1 : 0) - (m0.l ? 1 : 0); ay = (m0.d ? 1 : 0) - (m0.u ? 1 : 0); }
  let m = Math.hypot(ax, ay);
  if (m > 1) { ax /= m; ay /= m; m = 1; }
  if (m > 0.12) { own.fx = ax / m; own.fy = ay / m; }
  if (!fresh.hs) {
    const tired = sp[9] < K.TIRED ? 0.86 : 1;
    const top = K.TOP * tired * (inp.kickDownAt !== null ? 0.6 : 1) * (sp[11] ? 0.5 : 1) * (sp[17] > 0 ? 0.35 : 1);
    // the same placement assist the server applies when nothing is held
    if (m <= 0.05 && m0.as) {
      const b = fresh.b, sim = { tick: fresh.k, phase: fresh.ph, serveHold: !!fresh.hold, ball: { x: b[0], y: b[1], z: b[2], vx: b[3], vy: b[4], vz: b[5], last: fresh.lh } };
      const a = window.BM.assistDir(sim, own);
      if (a) { ax = a.x; ay = a.y; m = Math.hypot(ax, ay); if (m > 0.12) { own.fx = ax / m; own.fy = ay / m; } }
    }
    window.BM.run(own, ax, ay, m, top); // the sim's own running step: prediction and server agree
    own.x += own.vx / 60; own.y += own.vy / 60;
  }
  window.BM.bound(own);
}
function predictSelf(p, dtMs, ms, now) {
  const K = window.BM && window.BM.C, fresh = hist[hist.length - 1], sp = fresh && fresh.p && fresh.p[ms];
  if (!K || !sp) { own.on = false; return p; }
  // the server is moving the player itself: follow it (dash, dive, stun)
  // (drawn from the freshest snapshot, carried forward the same round trip the prediction runs ahead)
  if (sp[7] || sp[8] || sp[10] || sp[14] > 0 || sp[16] > 0) {
    selfReset(sp, ms); own.on = false;
    const lead = Math.min(0.15, (now - fresh._at + (pingMs != null ? pingMs : 30)) / 1000);
    const out = p.slice();
    out[0] = sp[0] + sp[2] * lead; out[1] = sp[1] + sp[3] * lead; out[2] = sp[2]; out[3] = sp[3]; out[4] = sp[4]; out[5] = sp[5];
    return out;
  }
  if (!own.on || own.slot !== ms) selfReset(sp, ms);
  // reconcile once per new snapshot, against where the prediction stood a round trip earlier
  if (fresh.k !== own.k) {
    own.k = fresh.k;
    const back = fresh._at - ((pingMs != null ? pingMs : 30) + 12);
    let h = null;
    for (let i = own.hist.length - 1; i >= 0; i--) if (own.hist[i].t <= back) { h = own.hist[i]; break; }
    if (h) {
      const ex = sp[0] - h.x, ey = sp[1] - h.y, e = Math.hypot(ex, ey);
      if (e > 1.0) selfReset(sp, ms);
      else if (e > 0.02) {
        const g = 0.25;
        own.x += ex * g; own.y += ey * g;
        for (const q of own.hist) { q.x += ex * g; q.y += ey * g; }
      }
    }
  }
  own.acc = Math.min(own.acc + dtMs, 100);
  while (own.acc >= 1000 / 60) { own.acc -= 1000 / 60; selfStep(K, fresh, sp); }
  own.hist.push({ t: now, x: own.x, y: own.y });
  while (own.hist.length && now - own.hist[0].t > 1000) own.hist.shift();
  const out = p.slice();
  // drawn carried forward by the time since the last 60 Hz step, so a 120/144 Hz screen gets a new
  // position every frame rather than the same one twice
  const ahead = own.acc / 1000;
  out[0] = own.x + own.vx * ahead; out[1] = own.y + own.vy * ahead; out[2] = own.vx; out[3] = own.vy; out[4] = own.fx; out[5] = own.fy;
  return out;
}

// ---------------------------------------------------------------- frame
let cpuMs = 0, lastFrameAt = null, lastRenderTick = 0, lastWorld = null, lastPred = null;
const setText = (el, v) => { v = String(v); if (el.textContent !== v) el.textContent = v; };
const setHTML = (el, v) => { if (el._html !== v) { el._html = v; el.innerHTML = v; } };
function shotHint(f, ms, ct, lob) {
  const K = window.BM && window.BM.C, b = f.b, me = f.p && f.p[ms];
  if (!K || !me) return '';
  const pct = ct / K.CHARGE_FULL, pz = me[14] || 0, air = pz > 0.02, rz = b[2] - pz;
  const fast = (f.lk === 'smash' || f.lk === 'jsmash' || f.lk === 'kill') && f.lh !== ms;
  if (fast) return lob ? 'LIFT' : ct < K.COUNTER_CT ? 'BLOCK' : 'COUNTER';
  // still on their side, and they are winding up overhead: holding now is a brace for the counter
  const opp = f.p[1 - ms];
  if (f.lh !== ms ? false : opp && opp[6] > 20 && b[2] > K.HIGH_Z) return ct < K.COUNTER_CT ? 'BRACE' : 'BRACED · COUNTER';
  if (!lob && pct >= 0.8 && Math.abs(b[0]) < 1.1 * K.S && Math.abs(me[0]) < 1.8 * K.S && b[2] > window.BM.netAt(b[1]) + 0.25) return 'KILL';
  if (rz >= K.HIGH_Z) return lob ? 'CLEAR' : pct >= 0.8 ? (air ? 'JUMP SMASH' : 'SMASH') : pct >= 0.35 ? 'DRIVE' : 'DROP';
  if (rz >= K.MID_Z) return lob ? 'LIFT' : 'DRIVE';
  return lob ? 'LIFT' : pct >= 0.75 ? 'CLEAR' : 'NET SHOT';
}
function frame(now) {
  const dtMs = lastFrameAt === null ? 16.7 : Math.min(100, now - lastFrameAt); lastFrameAt = now;
  let s = null, view = null;
  if (slowK < 1 && now > slowUntil) slowK = 1;
  const pt = clock.advance(now, dtMs * slowK);
  if (hist.length && pt !== null) {
    let rt = pt;
    if (rt < lastRenderTick && lastRenderTick - rt < 30) rt = lastRenderTick;
    lastRenderTick = rt;
    view = sampleAt(rt); s = view && (view.s || view.a);
  }
  pollGamepad();
  while (pendingEvents.length && pendingEvents[0].tick <= lastRenderTick) {
    const e = pendingEvents.shift();
    if (lastRenderTick - e.tick < 120) fireEvent(e);
  }
  const ms = mySlot();
  if (s) {
    // HUD
    setText($('n0'), slotName(0)); setText($('n1'), slotName(1));
    const sc = s.sc || [0, 0];
    setText($('s0'), sc[0]); setText($('s1'), sc[1]);
    const si = $('serveIcon');
    si.className = 'sb-serve ' + (s.sv === 0 ? 'l0' : 'l1');
    setText($('rallyBadge'), s.rc >= 4 && s.rp !== 'over' ? `Rally ${s.rc}` : '');
    setHTML($('subbug'), matchInfo ? (matchInfo.bot ? 'Practice vs bot' : 'Ranked 1v1') + ' · first to ' + C.POINTS : 'Office Badminton');
    $('subbug').className = matchInfo && matchInfo.bot ? 'bot' : '';
    const q = room ? room.queue.length : 0;
    setHTML($('hudRight'), q ? `<b>${q}</b> in line` : '');
    // rally escalation
    if (s.rc > lastRc) {
      if (s.rc === 6 || s.rc === 11 || s.rc === 20) { Sound.fx.rally(s.rc); if (s.rc === 20) banner('RALLY!', `${s.rc} hits`, '#ffd34d'); }
      lastRc = s.rc;
    } else if (s.rc < lastRc) lastRc = s.rc;
    // stamina + charge (own player)
    const dashEl = $('dash'), chargeEl = $('charge');
    if (ms >= 0 && s.p && s.p[ms] && s.rp !== 'prematch') {
      dashEl.classList.remove('hidden');
      const st = clamp(s.p[ms][9], 0, 100);
      $('stamFill').style.width = st + '%';
      $('stamFill').parentElement.classList.toggle('low', st < 22);
    } else dashEl.classList.add('hidden');
    const live = s.rp === 'match' && (s.ph === 'rally' || s.ph === 'serve' || s.ph === 'point' || s.ph === 'over');
    const localCt = inp.kickDownAt !== null ? (now - inp.kickDownAt) * TPMS : -1;
    if (ms >= 0 && localCt >= 0 && s.ph !== 'point') {
      chargeEl.classList.remove('hidden');
      const pct = clamp(localCt / C.CHARGE_FULL, 0, 1.3);
      const ring = chargeEl.querySelector('.ring');
      ring.style.setProperty('--p', (pct * 100).toFixed(0));
      ring.classList.toggle('gold', localCt >= C.CHARGE_FULL && localCt <= C.PERF_END);
      ring.classList.toggle('over', localCt > C.PERF_END);
      const b = hist[hist.length - 1];
      const hint = b ? shotHint(b, ms, localCt, inp.lobArm) : '';
      $('powerTip').classList.remove('hidden');
      $('powerTip').innerHTML = `<b>${hint}</b>${localCt > C.PERF_END ? ' · overcooked' : ''}`;
      $('tShoot') && $('tShoot').classList.toggle('charging', true);
    } else {
      chargeEl.classList.add('hidden');
      $('powerTip').classList.add('hidden');
      $('tShoot') && $('tShoot').classList.toggle('charging', false);
    }
    // countdown text
    let big = '';
    if (s.rp === 'prematch') big = s.rt <= 45 ? 'go' : 'ready';
    if (big !== lastBig) {
      lastBig = big;
      if (big === 'ready') bigText('READY', '#ffffff', true);
      else if (big === 'go') { bigText('GO!', '#ffd34d'); Sound.fx.beep(true); }
      else if (!big) $('bigText').classList.remove('hold');
    }
  } else if (code) {
    setScreen('conn', `<div class="scrim"></div><div class="card"><h2>${ws && ws.readyState === 1 ? 'LOADING' : 'CONNECTING'}…</h2></div>`);
  } else setScreen('', '');

  // world + camera
  let world = null;
  if (s && s.p) world = interpWorld(view);
  lastWorld = world;
  // prediction for the landing mark: from the freshest snapshot
  const fresh = hist[hist.length - 1];
  lastPred = fresh && fresh.b && window.BM ? window.BM.predict({ ball: { x: fresh.b[0], y: fresh.b[1], z: fresh.b[2], vx: fresh.b[3], vy: fresh.b[4], vz: fresh.b[5] }, tick: 0 }) : null;
  // steering: pointer if it moved recently, else keys (touch and gamepad set inp themselves)
  const live = !!(s && s.rp === 'match' && s.ph !== 'point' && s.ph !== 'over' && !menuOpen());
  const mouseActive = !touchMode && mouse.has && now - mouse.at < 2000;
  if (live && ms >= 0 && world) {
    if (mouseActive && R) {
      const me = world.players[ms];
      const g = R.pickGround(mouse.x, mouse.y);
      if (g) {
        const dx = g.x - me[0], dy = g.y - me[1], d = Math.hypot(dx, dy);
        if (d < 0.25) { inp.ax = 0; inp.ay = 0; } else { const mag = clamp((d - 0.25) / 3, 0.3, 1); inp.ax = dx / d * mag; inp.ay = dy / d * mag; }
      } else { inp.ax = 0; inp.ay = 0; }
      sendInput();
    } else if (!touchMode && !padSeen) {
      // WASD is relative to the camera you are looking through: W always runs toward the net, D to
      // the right of the screen. The camera sits behind each player's own end, so the two ends
      // mirror the mapping (player 0 lives at x<0, player 1 at x>0).
      keyAxes();
      sendInput();
    }
  }
  if (world && ms >= 0) world.players[ms] = predictSelf(world.players[ms], dtMs, ms, now);
  else own.on = false;
  lastWorld = world;
  const hype = s ? clamp(s.rc / 20, 0, 1) + (s.hs > 0 ? 0.3 : 0) : 0;
  const rv = {
    world, live, mySlot: ms, names: [slotName(0), slotName(1)], pred: lastPred,
    rally: s ? s.rc : 0, hype, tick: lastRenderTick, strokes, pointAt, hitstop: !!(s && s.hs > 0),
    lh: s ? s.lh : -1, predAge: fresh && fresh._at ? (now - fresh._at) / 1000 : 0,
  };
  if (R) R.frame(rv, now);
  Sound.crowd(hype);

  // name tags
  if (world && R && s && s.rp !== 'prematch' && ms >= 0) {
    const tags = $('labels').querySelectorAll('.ptag');
    if (tags.length !== 2) {
      $('labels').innerHTML = '<div class="ptag"></div><div class="ptag"></div>';
    }
    const els = $('labels').querySelectorAll('.ptag');
    for (let i = 0; i < 2; i++) {
      const p = world.players[i], pr = R.project(p[0], p[1], 2.05);
      const el = els[i];
      el.style.display = pr.ok ? '' : 'none';
      el.style.transform = `translate3d(${pr.x.toFixed(1)}px,${pr.y.toFixed(1)}px,0) translate(-50%,-100%)`;
      const txt = (i === ms ? 'YOU · ' : '') + slotName(i);
      if (el.textContent !== txt) el.textContent = txt;
      el.classList.toggle('me', i === ms);
    }
  }

  if (s) renderScreens(s);

  // footer
  let foot = '';
  if (s && s.rp === 'match' && ms >= 0 && s.ph === 'serve' && s.sv === ms) foot = 'Your serve · shoot: soft = low serve, full = high serve';
  else if (s && s.rp === 'match' && ms >= 0 && s.ph === 'serve') foot = 'Receiving';
  if (s && s.rp === 'match' && ms < 0 && room) {
    const me = room.members.find(m => m.id === myId), qi = room.queue.indexOf(myId);
    foot = me && me.sitting ? 'Watching · sitting out' : qi === 0 ? "Watching · you're next" : qi > 0 ? `Watching · #${qi + 1} in line` : 'Watching';
  }
  setText($('footer'), foot);
}

// read-only hooks for debugging and automated checks
window.__ob = { state: () => hist[hist.length - 1], world: () => lastWorld, slot: mySlot, delay: () => clock.delay, tier: () => tier, project: (x, y, z) => R && R.project(x, y, z), stats: () => R && Object.assign(R.stats(), { cpuMs: +cpuMs.toFixed(2) }), r3d: () => R && R._dbg && R._dbg(), R: () => R, prof: () => R && R.prof(), events: 0, hits: 0, myHits: 0, input: () => ({ k: inp.kickDownAt !== null, kp: inp.kp, kc: inp.kc, lob: inp.lob, ax: inp.ax, ay: inp.ay, ws: ws ? ws.readyState : -1 }) };

// ---------------------------------------------------------------- start
export async function start(api) {
  tier = api.tier;
  Sound.load();
  const canvas = $('c');
  R = await createRenderer(canvas, { tier, boot: api });
  const fit = () => { const r = $('view').getBoundingClientRect(); if (r.width > 0) R.resize(r.width, r.height); };
  new ResizeObserver(fit).observe($('view'));
  fit();
  setupInput(); setupMenu(); setupHome();
  addEventListener('popstate', route);
  route();
  if (!myName()) { $('home').classList.remove('hidden'); }
  // cpuMs: the script time each frame takes (smoothed), for the perf readout and checks
  requestAnimationFrame(function loop(now) {
    const t0 = performance.now(); frame(now); cpuMs += (performance.now() - t0 - cpuMs) * 0.05;
    requestAnimationFrame(loop);
  });
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await api.ready();
  setInterval(refreshHome, 5000);
  setInterval(() => send({ t: 'ping', c: performance.now() }), 2000); // round trip, for prediction
}
