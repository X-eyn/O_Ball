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
const myLevel = () => { try { const v = localStorage.getItem('obm_level'); return ['easy', 'normal', 'hard', 'pro'].includes(v) ? v : 'normal'; } catch { return 'normal'; } };

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
    sock.send(JSON.stringify({ t: 'hello', name: myName(), token, practice: 'bot', level: myLevel() }));
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
// One control scheme at a time, the one picked in Menu > Controls. The game never changes scheme on
// its own: a nudge of the mouse, a controller on the desk or a tap on a touchscreen laptop must not
// take a player off the controls they are using mid-rally.
//   keyboard  arcade: WASD / arrows move, A (J or Space) hits, B (K) plays soft. Each press is timed
//             against the ring as a swipe is (see arcPress); the height met picks the shot, the
//             direction held aims it. Jump smash, dive and running are the sim's (p.arc)
//   mouse     the player runs to the pointer; click shot, shift+click / middle lift, right button
//             sprint (double-click it: dive), thumb button jump; the action keys work too
//   swipe     WASD / arrows move (steered onto the shuttle when heading its way); every shot is a
//             two-finger swipe on the trackpad, timed against a ring closing on the shuttle (see the
//             swipe section below and swipeShot in shared/badminton.js). Shift sprints, F jumps
//   trackpad  (retired) the game runs the legs and times the swing (see ezInput in shared/badminton.js): a
//             tap queues a shot, aimed where the pointer is on the far court (short = soft, deep =
//             power); a two-finger tap (right click) or shift+tap lifts. Space / E / F work too
//   gamepad   left stick / D-pad; A shot, Y lift, X / LB sprint (double-tap: dive), B / RB jump
//   touch     the on-screen stick and buttons
const KEYMAP = { KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r', Space: 'kick', KeyJ: 'kick', KeyE: 'lob', KeyL: 'lob', ShiftLeft: 'sprint', ShiftRight: 'sprint', KeyK: 'sprint', KeyF: 'jump', KeyI: 'jump' };
const MOVE = new Set(['u', 'd', 'l', 'r']);
// keyboard (arcade) controls: the two buttons
const ARC_KEYS = { KeyJ: 'a', Space: 'a', KeyK: 'b' };
// (only Swipe and Keyboard are offered; the other schemes' code stays until the swipe design settles)
const CTRLS = ['swipe', 'keyboard'];
const CTRL_NAME = { swipe: 'Swipe', keyboard: 'Keyboard' };
const DOUBLE_TAP = 280; // ms between two presses of sprint that make a dive
const held = new Set();
const kickSources = new Set(), sprintSources = new Set();
const inp = { kp: 0, dv: 0, jp: 0, kn: 0, kc: null, kickDownAt: null, ax: 0, ay: 0, lob: false, lobArm: false, sprintTapAt: -1e9, ezLob: false };
// trackpad controls: the spot aimed at on the far court (metres, sim coordinates); set: pointed at yet
const aim = { x: 0, y: 0, set: false };
const mouse = { x: 0, y: 0, has: false };
const touchDevice = matchMedia('(hover: none) and (pointer: coarse)').matches;
let ctrl = (() => { try { const v = localStorage.getItem('obm_ctrl'); if (CTRLS.includes(v)) return v; } catch { } return 'swipe'; })();
let lastSent = '';
function typing(e) { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'); }
function sendInput(force) {
  const kb = ctrl === 'keyboard' || ctrl === 'swipe';
  if (ctrl === 'trackpad') {
    // taps, the kind of the last one, and the aim: the sim does the rest
    const msg = { t: 'i', u: 0, d: 0, l: 0, r: 0, k: false, kp: inp.kp, kc: null, dv: inp.dv, sp: 0, jp: inp.jp, kn: inp.kn, lob: inp.ezLob, as: 0, ax: 0, ay: 0,
      ez: 1, am: aim.set ? 1 : 0, tx: Math.round(aim.x * 20) / 20, ty: Math.round(aim.y * 20) / 20 };
    const s = JSON.stringify(msg);
    lastInput = msg;
    if (force || s !== lastSent) { lastSent = s; if (ws && ws.readyState === 1) ws.send(s); }
    return;
  }
  const msg = {
    t: 'i',
    u: +(kb && (held.has('KeyW') || held.has('ArrowUp'))), d: +(kb && (held.has('KeyS') || held.has('ArrowDown'))),
    l: +(kb && (held.has('KeyA') || held.has('ArrowLeft'))), r: +(kb && (held.has('KeyD') || held.has('ArrowRight'))),
    k: inp.kickDownAt !== null, kp: inp.kp, kc: inp.kc, dv: inp.dv, sp: sprintSources.size && ctrl !== 'keyboard' ? 1 : 0, jp: inp.jp, kn: inp.kn, lob: !!inp.lob, as: assistOn ? 1 : 0,
    ax: Math.round(inp.ax * 50) / 50, ay: Math.round(inp.ay * 50) / 50,
    // magnetic steering, and the last swipe (see the swipe section)
    mg: 1, swm: ctrl === 'swipe' || ctrl === 'keyboard' ? 1 : 0, sw: swp.n, sg: swp.g, si: swp.si, sd: swp.sd ? 1 : 0, sl: swp.sl, svt: swp.vt,
    // keyboard (arcade) controls, and the length the last press asked for
    arc: ctrl === 'keyboard' ? 1 : 0, sz: swp.sz,
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
  if (ctrl !== 'keyboard' && ctrl !== 'swipe') return;
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
// sprint is held; a second press close behind the first is the dive
function sprintDown(src) {
  if (!sprintSources.size) {
    const now = performance.now();
    if (now - inp.sprintTapAt < DOUBLE_TAP) { inp.dv++; inp.sprintTapAt = -1e9; } else inp.sprintTapAt = now;
  }
  sprintSources.add(src); sendInput();
}
function sprintUp(src) { if (sprintSources.delete(src)) sendInput(); }
function jumpPress() { inp.jp++; sendInput(); }
// trackpad controls: a tap queues a shot for the next shuttle that comes your way (or replaces the
// one queued); lob picks a lift instead
let ezTapAt = 0;
function ezTap(lob) {
  inp.ezLob = !!lob; inp.kp++; ezTapAt = performance.now();
  sendInput(true);
}
function releaseAll() {
  held.clear(); keyHeldSince = null;
  for (const s of [...kickSources]) kickUp(s);
  sprintSources.clear(); padPrev = { kick: false, sprint: false, lob: false, jump: false };
  if (touchStick) { touchStick = null; $('stick').classList.remove('on'); $('knob').style.transform = ''; }
  inp.ax = inp.ay = 0; sendInput();
}
const CTRL_TOAST = {
  swipe: 'Swipe controls: WASD moves, swipe two fingers up the trackpad to hit as the ring closes (down to lift)',
  keyboard: 'Keyboard: WASD moves. J hits, K plays soft. Press when the shuttle reaches the circle (tick, tick, TOCK)',
  mouse: 'Mouse controls: run to the pointer, click shoots, hold right button to sprint (double-click it to dive). On a trackpad? Try Trackpad',
  trackpad: 'Trackpad controls: your player runs on their own. Point at the far court, tap to play a shot there; two-finger tap lifts',
  gamepad: 'Controller: left stick moves, A shoots, X sprints (double-tap to dive)',
  touch: 'Touch controls: left thumb moves, right thumb shoots, Sprint (double-tap to dive)',
};
function updateCtrlUI() {
  document.querySelectorAll('#ctrlSeg button').forEach(b => b.classList.toggle('on', b.dataset.c === ctrl));
  // (the shot guide is about holding and releasing: the trackpad help says it its own way)
  const h = $('ctrlHelp'); if (h) h.innerHTML = CTRL_HELP[ctrl] + (ctrl === 'trackpad' || ctrl === 'swipe' || ctrl === 'keyboard' ? CTRL_PAUSE : CTRL_SHOTS);
  $('view').classList.toggle('mouse-mode', ctrl === 'mouse');
  $('view').classList.toggle('trackpad-mode', ctrl === 'trackpad');
  $('touchui').classList.toggle('hidden', !(code && ctrl === 'touch'));
}
function setCtrl(mode, announce = true) {
  if (!CTRLS.includes(mode) || mode === ctrl) return;
  releaseAll();
  ctrl = mode; try { localStorage.setItem('obm_ctrl', mode); } catch { }
  updateCtrlUI();
  if (announce) toast(CTRL_TOAST[mode], 4000);
  sendInput(true);
}
// trackpad controls: the pointer's spot on the floor is the aim while it is over the far court
// (over your own half the last aim stands, so the pointer can be parked anywhere)
function aimAt() {
  const K = window.BM && window.BM.C, ms = mySlot();
  if (ctrl !== 'trackpad' || !R || !K || !mouse.has || ms < 0) return;
  const g = R.pickGround(mouse.x, mouse.y);
  if (!g) return;
  const far = ms === 0 ? 1 : -1; // player 0 lives at x < 0
  if (g.x * far < 0.3) return;
  aim.x = far * clamp(g.x * far, 0.6, K.L - 0.3); aim.y = clamp(g.y, -(K.W - 0.25), K.W - 0.25); aim.set = true;
}
function setupInput() {
  addEventListener('keydown', e => {
    if (!code || typing(e) || menuOpen()) { if (e.code === 'Escape' && code && !typing(e)) { menuOpen() ? closeMenu() : openMenu('room'); e.preventDefault(); } return; }
    if (e.code === 'Escape') { openMenu('room'); e.preventDefault(); return; }
    const act = KEYMAP[e.code];
    if (act) e.preventDefault();
    if (e.repeat) return;
    if (/^Digit[1-6]$/.test(e.code)) { send({ t: 'emote', n: +e.code.slice(5) - 1 }); return; }
    if (e.code === 'KeyM') { Sound.toggle(); if (setupMenu.muteLabel) setupMenu.muteLabel(); return; }
    // keyboard (arcade) controls: J / Space hit, K plays soft; only the move keys are held
    if (ctrl === 'keyboard' && ARC_KEYS[e.code]) { e.preventDefault(); arcPress(ARC_KEYS[e.code], e.timeStamp); return; }
    if (!act) return;
    // trackpad controls: the shot keys tap (Space a shot, E a lift), F jumps; nothing is held
    if (ctrl === 'trackpad') {
      if (act === 'kick') ezTap(false);
      else if (act === 'lob') ezTap(true);
      else if (act === 'jump') jumpPress();
      return;
    }
    // the keys play on keyboard controls; on mouse controls the action keys still work (the pointer
    // steers); on a controller or touch they do nothing
    // (on swipe controls the keys move, sprint and jump: shots are the trackpad's)
    if (!((ctrl === 'keyboard' && MOVE.has(act)) || (ctrl === 'swipe' && act !== 'kick' && act !== 'lob') || (ctrl === 'mouse' && !MOVE.has(act)))) return;
    held.add(e.code);
    if (act === 'kick') kickDown('key:' + e.code);
    if (act === 'lob') kickDown('lob:' + e.code);
    if (act === 'sprint') sprintDown('key:' + e.code);
    if (act === 'jump') jumpPress();
    if (MOVE.has(act)) keyAxes();
    sendInput();
  });
  addEventListener('keyup', e => {
    if (!held.has(e.code)) return;
    held.delete(e.code);
    const act = KEYMAP[e.code];
    if (act === 'kick') kickUp('key:' + e.code);
    if (act === 'lob') kickUp('lob:' + e.code);
    if (act === 'sprint') sprintUp('key:' + e.code);
    if (MOVE.has(act)) keyAxes();
    sendInput();
  });
  const view = $('view');
  const at = e => { const r = view.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.has = true; };
  view.addEventListener('pointermove', e => { if (e.pointerType !== 'touch') at(e); });
  view.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') mouse.has = false; });
  // mouse buttons (mousedown fires for every button, even pressed together): mouse controls only
  view.addEventListener('mousedown', e => {
    if (!code || (ctrl !== 'mouse' && ctrl !== 'trackpad') || menuOpen() || e.target.closest('button, input, a, select, .interactive')) return;
    at(e);
    if (ctrl === 'trackpad') {
      aimAt(); // (the tap's own spot, if it is on the far court)
      // a tap (or click) is a shot, shift+tap / a two-finger tap (the right button) / middle a lift;
      // nothing is held, so a tap-to-click trackpad's instant press and release is all it takes
      if (e.button === 0) ezTap(e.shiftKey);
      else if (e.button === 1 || e.button === 2) ezTap(true);
      else if (e.button === 3 || e.button === 4) jumpPress();
      else return;
      e.preventDefault();
      return;
    }
    if (e.button === 0 && e.shiftKey) kickDown('lob:mouse');
    else if (e.button === 0) kickDown('mouse');
    else if (e.button === 1) kickDown('lob:mouse');
    else if (e.button === 2) sprintDown('mouse');
    else if (e.button === 3 || e.button === 4) jumpPress(); // the thumb buttons
    else return;
    e.preventDefault();
  });
  addEventListener('mouseup', e => {
    if (e.button === 0) { kickUp('mouse'); kickUp('lob:mouse'); }
    if (e.button === 1) kickUp('lob:mouse');
    if (e.button === 2) sprintUp('mouse');
  });
  view.addEventListener('contextmenu', e => e.preventDefault());
  addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
  addEventListener('wheel', onWheelGame, { passive: false });
  document.querySelectorAll('#ctrlSeg button').forEach(b => b.onclick = e => { setCtrl(b.dataset.c); e.currentTarget.blur(); });
  setInterval(() => sendInput(true), 250);
  setupTouch();
  updateCtrlUI();
}
let padPrev = { kick: false, sprint: false, lob: false, jump: false };
function pollGamepad() {
  if (ctrl !== 'gamepad' || !code) return;
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp = null; for (const p of pads) if (p && p.connected) { gp = p; break; }
  if (!gp) { if (inp.ax || inp.ay) { inp.ax = inp.ay = 0; sendInput(); } return; }
  const b = i => !!(gp.buttons[i] && gp.buttons[i].pressed);
  let x = gp.axes[0] || 0, y = gp.axes[1] || 0;
  if (b(14)) x = -1; if (b(15)) x = 1; if (b(12)) y = -1; if (b(13)) y = 1;
  const m = Math.hypot(x, y);
  // stick is screen-relative, like WASD: push up to run at the net, right to move screen-right
  const side = mySlot() === 1 ? 1 : -1;
  if (m < 0.2 || menuOpen()) { inp.ax = inp.ay = 0; } else {
    const mm = Math.min(1, (m - 0.2) / 0.65), nx = x / m * mm, ny = y / m * mm;
    inp.ax = -ny * -side; inp.ay = nx * -side;
  }
  const open = menuOpen();
  const kick = !open && (b(0) || b(7)), lobB = !open && b(3), spr = !open && (b(2) || b(4)), jmp = !open && (b(1) || b(5));
  if (kick && !padPrev.kick) kickDown('pad');
  if (!kick && padPrev.kick) kickUp('pad');
  if (lobB && !padPrev.lob) kickDown('lob:pad');
  if (!lobB && padPrev.lob) kickUp('lob:pad');
  if (spr && !padPrev.sprint) sprintDown('pad');
  if (!spr && padPrev.sprint) sprintUp('pad');
  if (jmp && !padPrev.jump) jumpPress();
  padPrev.kick = kick; padPrev.lob = lobB; padPrev.sprint = spr; padPrev.jump = jmp;
  sendInput();
}
// touch: left half is a floating stick, right side is Shoot / Lift / Sprint / Jump
let touchStick = null;
function setupTouch() {
  const zone = $('stickZone'), stick = $('stick'), knob = $('knob');
  zone.addEventListener('pointerdown', e => {
    if (ctrl !== 'touch') return;
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
  const hold = (el, down, up) => {
    el.addEventListener('pointerdown', e => { if (ctrl === 'touch') down(); e.preventDefault(); });
    if (up) { el.addEventListener('pointerup', e => { up(); e.preventDefault(); }); el.addEventListener('pointercancel', () => up()); }
  };
  hold($('tShoot'), () => kickDown('touch'), () => kickUp('touch'));
  hold($('tLift'), () => kickDown('lob:touch'), () => kickUp('lob:touch'));
  hold($('tDash'), () => sprintDown('touch'), () => sprintUp('touch'));
  hold($('tJump'), jumpPress);
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
  } else if (s.rp === 'paused' && s.up) {
    setScreen('upaused' + menuOpen(), menuOpen() ? '' : `<div class="scrim"></div><div class="card"><div class="cap">Paused</div><h2>Match paused</h2><p>Press <b>Esc</b> to play on.</p></div>`);
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
      // (your own timed shot already showed its grade over your head on the press: name the shot only)
      else if (e.perfect && !(isMine && e.g != null)) floatText(e.x, e.y, zt, `PERFECT ${e.kind.toUpperCase()}`, '#ffd34d', 40);
      else if (e.perfect) floatText(e.x, e.y, zt, ({ net: 'NET SHOT', servel: 'SERVE', serveh: 'HIGH SERVE' }[e.kind] || e.kind.toUpperCase()), '#ffd34d', 30);
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
// the menu is the pause screen: against the bot the match holds while it is open
const botMatchMine = () => !!(matchInfo && matchInfo.bot && mySlot() >= 0);
function openMenu(pane = 'room') {
  const was = menuOpen();
  $('menu').classList.remove('hidden'); showPane(pane); releaseAll();
  if (!was && botMatchMine()) send({ t: 'pause', v: true });
}
function closeMenu() {
  if (!menuOpen()) return;
  $('menu').classList.add('hidden');
  send({ t: 'pause', v: false });
}
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
const CTRL_HELP = {
  swipe: `<span class="do">Move</span><span class="how"><b>WASD</b> or arrows. Head roughly toward the shuttle and your player locks onto the spot where it is best met.</span>
  <span class="do">Shot</span><span class="how"><b>Swipe two fingers up</b> the trackpad as the ring closes on the shuttle. Gentle: a drop or net shot. Firm: a drive or clear. Fierce: a smash on a high shuttle, a kill at the net.</span>
  <span class="do">Angle</span><span class="how">Lean the swipe left or right to send it across the court.</span>
  <span class="do">Lift</span><span class="how"><b>Swipe down</b>: high and deep, the way out of trouble.</span>
  <span class="do">Timing</span><span class="how">Swipe as the ring closes: <b>PERFECT</b>, GREAT or GOOD. Early or late is weak; way off is a miss. A perfect smash is the fastest shot in the game.</span>
  <span class="do">Their smash</span><span class="how">Swipe firmly as it arrives to counter it (perfect: parry), gently to block it, down to lift it.</span>
  <span class="do">Serve</span><span class="how">Swipe: gentle for a low serve, fierce for a high one.</span>
  <span class="do">Sprint, jump</span><span class="how"><b>Shift</b> sprints (double-tap to dive), <b>F</b> jumps.</span>
  <span class="do">Direction</span><span class="how">If swiping up lifts instead of hitting, switch <b>Swipe direction</b> in Settings.</span>`,
  keyboard: `<span class="do">Move</span><span class="how"><b>WASD</b> or arrows. Head toward the shuttle and your player locks onto the spot to hit it from.</span>
  <span class="do">A: Hit</span><span class="how"><b>J</b> (or Space). Overhead: <b>smash</b>. Over the tape: <b>kill</b>. Waist high: drive. Low: <b>clear</b>, high and deep.</span>
  <span class="do">B: Soft</span><span class="how"><b>K</b>. Overhead: drop. Low or at the net: <b>net shot</b>.</span>
  <span class="do">Timing</span><span class="how">A circle marks where you will meet the shuttle. Press as the shuttle reaches it: the closing ring lands on the circle at that moment, and you hear <b>tick, tick, TOCK</b> (press on the TOCK). <b>PERFECT</b>, GREAT or GOOD, and whether you were early or late. Way off is a whiff, and the racket needs a moment to come back.</span>
  <span class="do">Aim</span><span class="how">Hold a direction as you press: left or right angles it, forward goes deep, back goes short.</span>
  <span class="do">Big moments</span><span class="how">A <b>perfect A</b> overhead is a <b>jump smash</b>. Against a smash, A <b>counters</b> (perfect: a <b>parry</b>) and B <b>blocks</b> it dead. Press with the shuttle just out of reach and you <b>dive</b> for it.</span>
  <span class="do">Serve</span><span class="how">A serves high and deep, B short.</span>`,
  trackpad: `<span class="do">Move</span><span class="how">Automatic: your player reads each shot and runs to meet it, then back to the middle.</span>
  <span class="do">Aim</span><span class="how">Point at the far court: the ring is where your shot goes. Near the net (the ring reads <b>SOFT</b>): a drop, net shot or block. Deeper (<b>POWER</b>): a smash, clear, kill or counter.</span>
  <span class="do">Shot</span><span class="how"><b>Tap</b> (or click, or Space). Any time: once the shuttle is coming your way is fine; the swing is timed for you. Tap early against a smash to counter it.</span>
  <span class="do">Lift</span><span class="how"><b>Two-finger tap</b> (right click), shift+tap or <b>E</b>: high and deep.</span>
  <span class="do">Serve</span><span class="how">Tap. Aimed short = low serve, deep = high serve.</span>
  <span class="do">Jump</span><span class="how"><b>F</b>. Sprinting and diving happen on their own.</span>
  <span class="do">Fair play</span><span class="how">The auto legs read a touch slower than a sharp player, and a timed-for-you swing is never a perfect one. Your name shows <b>ASSIST</b> to the other player.</span>`,
  mouse: `<span class="do">Move</span><span class="how">Your player runs to the pointer. With it still, your player glides to where the shuttle is best met (Settings: Placement assist).</span>
  <span class="do">Shot</span><span class="how">Hold click, release. Shift+click or middle-click lifts it high and deep.</span>
  <span class="do">Sprint</span><span class="how">Hold the right button (or Shift).</span>
  <span class="do">Dive</span><span class="how">Double-click the right button (or double-tap Shift): a last-ditch launch at the shuttle; you are on the floor for a moment after.</span>
  <span class="do">Jump</span><span class="how">A mouse thumb button, or <b>F</b>.</span>`,
  gamepad: `<span class="do">Move</span><span class="how">Left stick or D-pad</span>
  <span class="do">Shot</span><span class="how">Hold <b>A</b> (or RT), release. <b>Y</b> lifts it high and deep.</span>
  <span class="do">Sprint</span><span class="how">Hold <b>X</b> (or LB).</span>
  <span class="do">Dive</span><span class="how">Double-tap <b>X</b>: a last-ditch launch at the shuttle; you are on the floor for a moment after.</span>
  <span class="do">Jump</span><span class="how"><b>B</b> (or RB).</span>`,
  touch: `<span class="do">Move</span><span class="how">Put your left thumb down anywhere on the left half and steer.</span>
  <span class="do">Shot</span><span class="how">Hold <b>Shoot</b>, release. <b>Lift</b> sends it high and deep.</span>
  <span class="do">Sprint</span><span class="how">Hold <b>Sprint</b>.</span>
  <span class="do">Dive</span><span class="how">Double-tap <b>Sprint</b>: a last-ditch launch at the shuttle.</span>
  <span class="do">Jump</span><span class="how"><b>Jump</b></span>`,
};
// how shots work, whatever the controls
const CTRL_SHOTS = `
  <span class="do">Which shot</span><span class="how">Where you meet it decides the shot: overhead full charge = <b>smash</b>, soft = <b>drop</b>; waist = <b>drive</b>; low full = <b>clear</b>, soft = <b>net shot</b>; full charge on a shuttle floating over the tape = <b>kill</b>. Release on gold for a perfect strike. In the air at the top of a jump, a full charge is a <b>jump smash</b>.</span>
  <span class="do">Defend a smash</span><span class="how">It is too fast to react to: read the wind-up. Hold Shot to <b>brace</b>, release as it arrives to <b>counter</b> it flat into the open court (clean and on time = <b>parry</b>). A late tap <b>blocks</b> it dead over the net; Lift sends it high.</span>
  <span class="do">Serve</span><span class="how">When you're serving, stand still and shoot: soft is a low serve, full charge is a high deep serve</span>
  <span class="do">Pause</span><span class="how"><b>Esc</b> opens the menu. Against the bot the match waits for you.</span>`;
const CTRL_PAUSE = `<span class="do">Pause</span><span class="how"><b>Esc</b> opens the menu. Against the bot the match waits for you.</span>`;
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
  const sdb = $('swDirBtn');
  if (sdb) {
    const label = () => { sdb.textContent = swDir < 0 ? 'Natural' : 'Reversed'; };
    label();
    sdb.onclick = () => { swDir = -swDir; try { localStorage.setItem('obm_swdir', swDir < 0 ? 'nat' : 'rev'); } catch { } label(); };
  }
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
  updateCtrlUI();
  const ls = $('levelSel');
  if (ls) {
    const names = { easy: 'Easy', normal: 'Normal', hard: 'Hard', pro: 'Pro' };
    const desc = {
      easy: 'Slow to read your shots, soft, and makes mistakes. Good for learning the strokes.',
      normal: 'A steady club player: gets to most shuttles and punishes a loose lift.',
      hard: 'Reads you early, smashes the high ones, counters, jumps and dives for the last-ditch saves.',
      pro: 'Hardly ever errs. Every lift gets smashed; you have to move it around.',
    };
    ls.innerHTML = Object.keys(names).map(k => `<option value="${k}">${names[k]}</option>`).join('');
    ls.value = myLevel();
    const d = () => { $('levelDesc').textContent = desc[ls.value] || ''; };
    d();
    ls.onchange = () => { try { localStorage.setItem('obm_level', ls.value); } catch { } d(); send({ t: 'level', v: ls.value }); ls.blur(); };
  }
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
  $('touchui').classList.toggle('hidden', ctrl !== 'touch');
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
    // (sprinting as the server has it, or about to: held with the breath for it)
    const sprinting = m0.sp && ctrl !== 'keyboard' && (sp[19] || sp[9] > K.SPRINT_MIN);
    const top = (sprinting ? K.SPRINT_V : ctrl === 'keyboard' ? K.ARC_TOP : K.TOP) * tired * (inp.kickDownAt !== null ? 0.6 : 1) * (sp[11] ? 0.5 : 1) * (sp[17] > 0 ? 0.35 : 1);
    // the same placement assist the server applies when nothing is held
    const simOf = () => { const b = fresh.b; return { tick: fresh.k, phase: fresh.ph, serveHold: !!fresh.hold, ball: { x: b[0], y: b[1], z: b[2], vx: b[3], vy: b[4], vz: b[5], last: fresh.lh } }; };
    if (m <= 0.05 && m0.as) {
      const a = window.BM.assistDir(simOf(), own);
      if (a) { ax = a.x; ay = a.y; m = Math.hypot(ax, ay); if (m > 0.12) { own.fx = ax / m; own.fy = ay / m; } }
    } else if (m > 0.05 && m0.mg && window.BM.magnetDir) {
      // the same magnetic steering the server applies
      const g = window.BM.magnetDir(simOf(), own, ax, ay, m);
      if (g) { ax = g.x; ay = g.y; m = Math.hypot(ax, ay); if (m > 0.12) { own.fx = ax / m; own.fy = ay / m; } }
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
  if (sp[8] || sp[20] > 0 || sp[10] || sp[14] > 0 || sp[16] > 0) {
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
    setHTML($('subbug'), matchInfo ? (matchInfo.bot ? `Practice vs bot${matchInfo.level ? ' (' + matchInfo.level[0].toUpperCase() + matchInfo.level.slice(1) + ')' : ''}` : 'Ranked 1v1') + ' · first to ' + C.POINTS : 'Office Badminton');
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
    // (stamina is hidden on keyboard controls: the sim keeps it, the player never manages it)
    if (ms >= 0 && s.p && s.p[ms] && s.rp !== 'prematch' && ctrl !== 'keyboard') {
      dashEl.classList.remove('hidden');
      const st = clamp(s.p[ms][9], 0, 100);
      $('stamFill').style.width = st + '%';
      $('stamFill').parentElement.classList.toggle('low', st < 22);
    } else dashEl.classList.add('hidden');
    const live = s.rp === 'match' && (s.ph === 'rally' || s.ph === 'serve' || s.ph === 'point' || s.ph === 'over');
    // (on trackpad controls the sim winds the swing up: the ring shows its charge)
    const mine = ms >= 0 && s.p ? s.p[ms] : null;
    const localCt = ctrl === 'trackpad' ? (mine && mine[6] >= 0 ? mine[6] : -1) : inp.kickDownAt !== null ? (now - inp.kickDownAt) * TPMS : -1;
    if (ms >= 0 && localCt >= 0 && s.ph !== 'point') {
      chargeEl.classList.remove('hidden');
      const pct = clamp(localCt / C.CHARGE_FULL, 0, 1.3);
      const ring = chargeEl.querySelector('.ring');
      ring.style.setProperty('--p', (pct * 100).toFixed(0));
      ring.classList.toggle('gold', localCt >= C.CHARGE_FULL && localCt <= C.PERF_END);
      ring.classList.toggle('over', localCt > C.PERF_END);
      const b = hist[hist.length - 1];
      const hint = b ? shotHint(b, ms, localCt, ctrl === 'trackpad' ? !!(mine && mine[22] === 2) : inp.lobArm) : '';
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
  // steering on the chosen controls: the pointer on mouse controls, the keys on keyboard controls
  // (touch and gamepad set inp themselves)
  const live = !!(s && s.rp === 'match' && s.ph !== 'point' && s.ph !== 'over' && !menuOpen());
  if (live && ms >= 0 && world) {
    if (ctrl === 'mouse' && R) {
      const me = world.players[ms];
      const g = mouse.has ? R.pickGround(mouse.x, mouse.y) : null;
      if (g) {
        const dx = g.x - me[0], dy = g.y - me[1], d = Math.hypot(dx, dy);
        // (full speed from 1.6 m out: a short flick of a trackpad is enough to run)
        if (d < 0.25) { inp.ax = 0; inp.ay = 0; } else { const mag = clamp((d - 0.25) / 1.6, 0.3, 1); inp.ax = dx / d * mag; inp.ay = dy / d * mag; }
      } else { inp.ax = 0; inp.ay = 0; }
      sendInput();
    } else if (ctrl === 'trackpad') {
      aimAt();
      sendInput();
    } else if (ctrl === 'keyboard' || ctrl === 'swipe') {
      // WASD is relative to the camera you are looking through: W always runs toward the net, D to
      // the right of the screen. The camera sits behind each player's own end, so the two ends
      // mirror the mapping (player 0 lives at x<0, player 1 at x>0).
      keyAxes();
      sendInput();
    }
  }
  // (on trackpad controls the sim moves the player, so it is drawn as the server has it)
  if (world && ms >= 0 && ctrl !== 'trackpad') world.players[ms] = predictSelf(world.players[ms], dtMs, ms, now);
  else own.on = false;
  drawAim(live, ms, fresh, now);
  const ringNow = planFrame(now, s, world, ms, live);
  lastWorld = world;
  const hype = s ? clamp(s.rc / 20, 0, 1) + (s.hs > 0 ? 0.3 : 0) : 0;
  const rv = {
    world, live, mySlot: ms, names: [slotName(0), slotName(1)], pred: lastPred,
    rally: s ? s.rc : 0, hype, tick: lastRenderTick, strokes, pointAt, hitstop: !!(s && (s.hs > 0 || s.up)),
    lh: s ? s.lh : -1, predAge: fresh && fresh._at ? (now - fresh._at) / 1000 : 0,
    // keyboard controls show one ring only, the timing ring at the contact point (drawSwipeRing)
    oneRing: ctrl === 'keyboard',
  };
  if (R) R.frame(rv, now);
  // (after the frame: projected through this frame's camera, so it sits on the scene, not a frame behind)
  drawSwipeRing(now, ringNow, live);
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
      // (your own tag steps aside while the keyboard timing ring is up: it would sit across the target)
      el.style.display = pr.ok && !(i === ms && ctrl === 'keyboard' && ringNow && ringNow.k * 1000 / 60 <= ARC.LEAD + 150) ? '' : 'none';
      el.style.transform = `translate3d(${pr.x.toFixed(1)}px,${pr.y.toFixed(1)}px,0) translate(-50%,-100%)`;
      // (a player on trackpad controls is marked, so the other side knows the legs are assisted)
      const html = esc((i === ms ? 'YOU · ' : '') + slotName(i)) + (p[21] ? '<span class="ez"> · ASSIST</span>' : '');
      if (el._html !== html) { el._html = html; el.innerHTML = html; }
      el.classList.toggle('me', i === ms);
    }
  }

  if (s) renderScreens(s);

  // footer
  let foot = '';
  if (s && s.rp === 'match' && ms >= 0 && s.ph === 'serve' && s.sv === ms) foot = ctrl === 'swipe' ? 'Your serve · swipe: gentle = low serve, fierce = high serve' : ctrl === 'keyboard' ? 'Your serve · J: high and deep · K: short' : ctrl === 'trackpad' ? 'Your serve · tap: aimed short = low serve, deep = high serve' : 'Your serve · shoot: soft = low serve, full = high serve';
  else if (s && s.rp === 'match' && ms >= 0 && s.ph === 'serve') foot = 'Receiving';
  if (s && s.rp === 'match' && ms < 0 && room) {
    const me = room.members.find(m => m.id === myId), qi = room.queue.indexOf(myId);
    foot = me && me.sitting ? 'Watching · sitting out' : qi === 0 ? "Watching · you're next" : qi > 0 ? `Watching · #${qi + 1} in line` : 'Watching';
  }
  setText($('footer'), foot);
}

// trackpad controls: the ring on the far court where the next shot goes, soft or power by depth,
// pulsing once a shot is queued (at once on the tap, then as the server has it)
function drawAim(live, ms, fresh, now) {
  const el = $('aimMark'), BM = window.BM;
  const sp = fresh && fresh.p && ms >= 0 ? fresh.p[ms] : null;
  if (ctrl !== 'trackpad' || !live || !R || !BM || !sp) { el.classList.add('hidden'); return; }
  // a server started before trackpad controls existed sends no trackpad flag (and ignores the
  // taps): say so rather than leave the player standing still
  if (sp.length < 22 && !drawAim.warned) { drawAim.warned = true; toast('Trackpad controls need the game server restarted: close the server window and start it again', 8000); }
  const K = BM.C, far = ms === 0 ? 1 : -1;
  const ax = aim.set ? far * Math.abs(aim.x) : far * K.L * 0.75, ay = aim.set ? aim.y : 0;
  const pr = R.project(ax, ay, 0);
  if (!pr.ok) { el.classList.add('hidden'); return; }
  const tapped = now - ezTapAt < 250;
  const q = tapped ? (inp.ezLob ? 2 : 1) : (sp[22] | 0);
  const soft = Math.abs(ax) < BM.EZ.SOFT_X;
  const label = q === 2 ? 'Lift ready' : (soft ? 'Soft' : 'Power') + (q ? ' · ready' : '');
  el.classList.remove('hidden');
  el.classList.toggle('soft', soft && q !== 2); el.classList.toggle('lift', q === 2); el.classList.toggle('queued', q > 0);
  const sp2 = el.querySelector('span'); if (sp2.textContent !== label) sp2.textContent = label;
  el.style.transform = `translate3d(${pr.x.toFixed(1)}px,${pr.y.toFixed(1)}px,0) translate(-50%,-50%)`;
}

// ---------------------------------------------------------------- swipe controls
// Every shot is a two-finger swipe. A trackpad sends one as a burst of scroll events; when the
// fingers lift there is one zero event, then Windows keeps scrolling on its own, fading over about a
// second with no pause before the next swipe. So: a zero event ends a swipe, the fade after it is
// ignored, and a jump in size or a turn of direction is new fingers on the pad (measured on real
// laptops in the gesture lab, /badminton/lab.html).
// A swipe is played as soon as it is past its fastest point. Its timing is judged here, against
// what was on screen: the moment the shuttle was best met from where the player stood (contactPlan,
// the sim's own), recorded each frame. The swipe's moment is its fastest point less SWP.BIAS (people
// land a swipe's peak ~40 ms after the moment they aim for). The grade, the swipe's intensity,
// direction and the tick on screen go to the server, which plays the shot where the shuttle was.
const SWP = {
  BIAS: 40,               // ms: the lab's measured lag from aiming at a moment to a swipe's peak
  LO: 3000, HI: 40000,    // swipe speeds (px/s) for intensity 0 and 1 (on a log scale between)
  MIN: 25,                // px: less is not a swipe
  GAP: 110,               // ms: a pause this long ends a swipe (and a fade)
  WIN: [25, 60, 110, 220], // ms either side: perfect, great, good, early/late (beyond: a miss)
};
const swp = { n: 0, g: 4, si: 0, sd: false, sl: 0, vt: null, sz: 0 };
// the fingers' direction is the scroll's times swDir: natural scrolling (the default) is -1
let swDir = (() => { try { return localStorage.getItem('obm_swdir') === 'rev' ? 1 : -1; } catch { return -1; } })();
const swState = { wg: null, coast: null, win: [] };
const frames = []; // per frame: { t, vt: the tick on screen, ideal: when the shuttle is best met (ms) or null }
function onWheelGame(e) {
  if (!code) return;
  if (e.ctrlKey) { e.preventDefault(); return; } // (a pinch must not zoom the game)
  if (ctrl !== 'swipe' || menuOpen()) return;
  e.preventDefault();
  const t = e.timeStamp, sc = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
  let dx = e.deltaX * sc, dy = e.deltaY * sc;
  if (e.shiftKey && !dx && dy) { dx = dy; dy = 0; } // (an older driver's sideways swipe)
  const m = Math.hypot(dx, dy), W = swState;
  if (W.wg && t - W.wg.lastT > SWP.GAP) endSwipe();
  if (W.coast && t - W.coast.t > SWP.GAP) W.coast = null;
  if (!m) { // the fingers lifted
    if (W.wg) { const w = W.wg; endSwipe(); W.coast = { t, ux: w.ux, uy: w.uy, peak: w.big, prev: 0, first: true }; }
    else if (W.coast) W.coast.t = t;
    return;
  }
  if (W.coast) { // still the fade: tiny, or the same way and only ever shrinking (its first may jump up)
    const dot = (dx * W.coast.ux + dy * W.coast.uy) / m;
    const fade = m < 3 || (dot > 0.3 && (W.coast.first ? m <= W.coast.peak * 1.3 + 4 : m <= W.coast.prev * 1.5 + 4));
    if (fade) { if (m >= 3) { W.coast.prev = m; W.coast.first = false; } W.coast.t = t; return; }
    W.coast = null;
  }
  if (W.wg && W.wg.n >= 3 && m >= 3 && (dx * W.wg.ux + dy * W.wg.uy) / m < 0) endSwipe(); // turned back: a new swipe
  if (!W.wg) { W.wg = { t0: t, lastT: t, dx: 0, dy: 0, n: 0, big: 0, ux: 0, uy: 0, peak: 0, peakT: t, fired: false }; W.win.length = 0; }
  const w = W.wg;
  w.dx += dx; w.dy += dy; w.n++; w.lastT = t; w.big = Math.max(w.big, m);
  { const l = Math.hypot(w.dx, w.dy) || 1; w.ux = w.dx / l; w.uy = w.dy / l; }
  W.win.push({ t, d: m });
  while (W.win.length > 1 && t - W.win[0].t > 32) W.win.shift();
  const rate = W.win.reduce((a, q) => a + q.d, 0) / Math.max(16, t - W.win[0].t + 16) * 1000;
  if (rate > w.peak) { w.peak = rate; w.peakT = t; }
  // past its fastest (the speed has fallen away), or on long enough to know: play it
  if (!w.fired && w.n >= 2 && (m < w.big * 0.7 || t - w.t0 > 110)) fireSwipe(w);
}
function endSwipe() { const w = swState.wg; swState.wg = null; if (w && !w.fired) fireSwipe(w); }
function fireSwipe(w) {
  w.fired = true;
  const ms = mySlot(), st = hist[hist.length - 1];
  if (Math.hypot(w.dx, w.dy) < SWP.MIN || ms < 0 || !st) return;
  const fx = w.dx * swDir, fy = w.dy * swDir;            // the fingers: +x right, +y down the pad
  const deg = Math.atan2(fx, -fy) * 180 / Math.PI;        // 0 = up the pad, away from you
  const down = Math.abs(deg) > 100;
  const lean = down ? (deg > 0 ? 180 - deg : -180 - deg) : deg; // how far it leans off straight
  const side = ms === 1 ? 1 : -1;                         // screen right is court y * -side (see keyAxes)
  // the moment it was aimed at, and what was on screen then
  const T = w.peakT - SWP.BIAS;
  let rec = null;
  for (let i = frames.length - 1; i >= 0; i--) if (frames[i].t <= T) { rec = frames[i]; break; }
  if (!rec) rec = frames[0] || { t: T, vt: lastRenderTick, ideal: null };
  const serving = st.ph === 'serve' && st.sv === ms && st.hold;
  let g = 4, off = null;
  if (serving) g = 1;
  else if (rec.ideal != null) {
    off = T - rec.ideal;
    const a = Math.abs(off);
    g = SWP.WIN.findIndex(x => a <= x); if (g < 0) g = 4;
  }
  swp.n++; swp.g = g; swp.sd = down; swp.sl = Math.round(clamp(lean / 55, -1, 1) * -side * 100) / 100;
  swp.si = Math.round(clamp(Math.log(Math.max(w.peak, 1) / SWP.LO) / Math.log(SWP.HI / SWP.LO), 0, 1) * 100) / 100;
  swp.vt = Math.round((rec.vt + (T - rec.t) * TPMS) * 10) / 10;
  sendInput(true);
  if (!serving) gradeFx(g, off, ms);
  if (window.__ob) window.__ob.lastSwipe = { g, off, si: swp.si, sd: swp.sd, sl: swp.sl, vt: swp.vt, deg: Math.round(deg) };
}
// ---------------------------------------------------------------- keyboard (arcade) controls
// A press is a swipe of a fixed intensity: A hard, B soft. Its timing is judged here against the
// ring (the same contactPlan record the swipe uses: the key's own timestamp, no swipe bias), and
// the direction held at that moment aims it: left/right is the line, forward/back the length.
// A whiff locks the racket for ARC.LOCK ms (the sim enforces it too, see C.ARC_LOCK).
const ARC = {
  WIN: [50, 90, 140, 240], // ms either side: perfect, great, good, early/late (beyond: a whiff)
  LEAD: 600,                // ms the approach ring takes to close onto the target: the same every shot
  BEATS: [500, 250, 0],     // the count-in, ms before the moment: tick, tick, TOCK
  SI: { a: 0.92, b: 0.15 }, // the swipe intensity each button stands for
  LOCK: 300,
};
let arcLockUntil = 0;
function arcPress(btn, t) {
  const ms = mySlot(), st = hist[hist.length - 1];
  if (ms < 0 || !st || t < arcLockUntil) return;
  let rec = null;
  for (let i = frames.length - 1; i >= 0; i--) if (frames[i].t <= t) { rec = frames[i]; break; }
  if (!rec) rec = frames[0] || { t, vt: lastRenderTick, ideal: null };
  const serving = st.ph === 'serve' && st.sv === ms && st.hold;
  let g = 4, off = null;
  if (serving) g = 1;
  else if (rec.ideal != null) { off = t - rec.ideal; const a = Math.abs(off); g = ARC.WIN.findIndex(x => a <= x); if (g < 0) g = 4; }
  const side = ms === 1 ? 1 : -1; // screen right is court y * -side (see keyAxes)
  const dKey = (held.has('KeyD') || held.has('ArrowRight') ? 1 : 0) - (held.has('KeyA') || held.has('ArrowLeft') ? 1 : 0);
  const wKey = (held.has('KeyW') || held.has('ArrowUp') ? 1 : 0) - (held.has('KeyS') || held.has('ArrowDown') ? 1 : 0);
  swp.n++; swp.g = g; swp.si = ARC.SI[btn]; swp.sd = false; swp.sl = dKey * 0.85 * -side; swp.sz = wKey;
  swp.vt = Math.round((rec.vt + (t - rec.t) * TPMS) * 10) / 10;
  sendInput(true);
  if (window.__ob) window.__ob.lastPress = { btn, g, off, sl: swp.sl, sz: swp.sz, vt: swp.vt };
  if (serving) return;
  // nothing to time against while the shuttle is on its way to you: the sim may dive for it
  const coming = st.ph === 'rally' && st.lh >= 0 && st.lh !== ms;
  if (g === 4 && rec.ideal == null && coming) return;
  gradeFx(g, off, ms);
  if (g === 4 && st.ph === 'rally') arcLockUntil = t + ARC.LOCK;
}
// the grade, at once, over the player's head
function gradeFx(g, off, ms) {
  const w = lastWorld, me = w && w.players[ms];
  if (!me) return;
  const side = off == null ? '' : off < 0 ? ' · EARLY' : ' · LATE'; // (which way it was off, to learn from)
  const [txt, col, size] = g === 0 ? ['PERFECT', '#ffd34d', 46] : g === 1 ? ['GREAT' + side, '#e4ff3c', 34] : g === 2 ? ['GOOD' + side, '#7fd8ff', 28]
    : g === 3 ? [off < 0 ? 'EARLY' : 'LATE', '#ff8f6b', 26] : [off == null ? 'SWING' : off < 0 ? 'TOO EARLY' : 'TOO LATE', '#8b93a4', 22];
  floatText(me[0], me[1], (me[14] || 0) + 3.3, txt, col, size); // (above the shot's callout, not on it)
  if (g === 0) flash('#ffd34d', 0.18);
}
// each frame on swipe and keyboard controls: when (and where) the incoming shuttle is met. Fixed
// once per shot from the freshest snapshot (ringPlan in shared/badminton.js: from the spot the
// player is steered to, so it shows as soon as the shot is struck and does not move or blink as
// they run), as a sim tick; the moment on screen is when the playback clock reaches that tick.
const ringLock = { k: -1, c: null };
function planFrame(now, s, world, ms, live) {
  let ideal = null, plan = null;
  const fresh = hist[hist.length - 1];
  const on = (ctrl === 'swipe' || ctrl === 'keyboard') && live && world && ms >= 0 && fresh && fresh.ph === 'rally' && fresh.lh >= 0 && fresh.lh !== ms && window.BM && window.BM.ringPlan;
  if (!on) { ringLock.c = null; ringLock.k = -1; }
  else {
    if (fresh.k !== ringLock.k) {
      ringLock.k = fresh.k;
      const b = fresh.b, me = world.players[ms];
      const sim = { tick: fresh.k, phase: fresh.ph, serveHold: !!fresh.hold, hitstop: fresh.hs || 0, ball: { x: b[0], y: b[1], z: b[2], vx: b[3], vy: b[4], vz: b[5], last: fresh.lh } };
      // (one key per shot: the hitter, the rally count and the point)
      const key = fresh.lh + ':' + fresh.rc + ':' + (fresh.sc[0] + fresh.sc[1]);
      ringLock.c = window.BM.ringPlan(sim, { i: ms, x: me[0], y: me[1], z: me[14] || 0 }, key, ringLock.c);
    }
    const c = ringLock.c;
    if (c) {
      const k = c.tick - lastRenderTick, ms2 = k / TPMS / (slowK || 1);
      if (ms2 > -ARC.WIN[3]) ideal = now + ms2;                       // (a late press is still graded)
      if (ms2 > -ARC.WIN[1]) plan = { k: ms2 * 60 / 1000, x: c.x, y: c.y, z: c.z, key: c.key }; // (drawn until just after)
    }
  }
  frames.push({ t: now, vt: lastRenderTick, ideal });
  while (frames.length > 150) frames.shift();
  return plan;
}
// the ring: closes on the point the shuttle is best met, landing on it at that moment
function drawSwipeRing(now, plan, live) {
  const cv = $('swCv'); if (!cv) return;
  const r = $('view').getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
  const x = cv.getContext('2d');
  x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, r.width, r.height);
  if (!plan || !live || (ctrl !== 'swipe' && ctrl !== 'keyboard') || !R) return;
  const dt = plan.k * 1000 / 60;
  if (ctrl === 'keyboard') { drawKeyRing(x, plan, dt); return; }
  if (dt > 1000) return;
  const pr = R.project(plan.x, plan.y, plan.z);
  if (!pr.ok) return;
  const rad = 13 + 95 * clamp(dt / 850, 0, 1), close = dt <= SWP.WIN[0];
  x.lineWidth = 2; x.strokeStyle = 'rgba(255,255,255,.55)';
  x.beginPath(); x.arc(pr.x, pr.y, 13, 0, Math.PI * 2); x.stroke();
  x.lineWidth = close ? 5 : 3.5; x.strokeStyle = close ? '#ffd34d' : '#e4ff3c'; x.globalAlpha = clamp(1.3 - dt / 1000, 0.25, 1);
  if (close) { x.shadowColor = '#ffd34d'; x.shadowBlur = 18; }
  x.beginPath(); x.arc(pr.x, pr.y, rad, 0, Math.PI * 2); x.stroke();
  x.globalAlpha = 1; x.shadowBlur = 0;
}

// The keyboard ring. A target circle sits where the shuttle will be met: the shuttle flies into
// it at the perfect moment ("hit when the shuttle reaches the circle"). An approach ring closes
// onto it at the same speed every shot (ARC.LEAD), so the two meet on the moment; both turn gold
// inside the perfect window. A count-in sounds with it: tick, tick, TOCK on the moment.
const keyRing = { key: null, beats: 0 };
function drawKeyRing(x, plan, dt) {
  if (keyRing.key !== plan.key) { keyRing.key = plan.key; keyRing.beats = 0; }
  // the count-in: each beat is scheduled on the audio clock for its exact moment, a frame ahead
  for (let i = keyRing.beats; i < ARC.BEATS.length; i++) {
    const b = ARC.BEATS[i];
    if (dt > b + 40) break;
    keyRing.beats = i + 1;
    if (dt > b - 60) Sound.fx.count(i === ARC.BEATS.length - 1, (dt - b) / 1000); // (a beat already gone is skipped)
  }
  if (dt > ARC.LEAD + 150) return;
  const pr = R.project(plan.x, plan.y, plan.z);
  if (!pr.ok) return;
  const R0 = 22, u = clamp(dt / ARC.LEAD, 0, 1), gold = Math.abs(dt) <= ARC.WIN[0];
  const fade = clamp((ARC.LEAD + 150 - dt) / 150, 0, 1) * (dt < 0 ? clamp(1 + dt / ARC.WIN[1], 0, 1) : 1);
  x.globalAlpha = fade;
  // the target
  x.lineWidth = gold ? 4 : 2.5; x.strokeStyle = gold ? '#ffd34d' : 'rgba(255,255,255,.9)';
  if (gold) { x.shadowColor = '#ffd34d'; x.shadowBlur = 20; }
  x.beginPath(); x.arc(pr.x, pr.y, R0, 0, Math.PI * 2); x.stroke();
  x.shadowBlur = 0;
  // the approach ring: from four times the target down onto it
  if (dt > 0) {
    x.lineWidth = 3.5; x.strokeStyle = gold ? '#ffd34d' : '#e4ff3c';
    x.beginPath(); x.arc(pr.x, pr.y, R0 * (1 + 3 * u), 0, Math.PI * 2); x.stroke();
  }
  x.globalAlpha = 1;
}

// read-only hooks for debugging and automated checks
window.__ob = { swipe: () => ({ ctrl, swp: Object.assign({}, swp), frames: frames.length, ideal: frames.length ? frames[frames.length - 1].ideal : null }), state: () => hist[hist.length - 1], world: () => lastWorld, slot: mySlot, delay: () => clock.delay, tier: () => tier, project: (x, y, z) => R && R.project(x, y, z), stats: () => R && Object.assign(R.stats(), { cpuMs: +cpuMs.toFixed(2) }), r3d: () => R && R._dbg && R._dbg(), R: () => R, prof: () => R && R.prof(), events: 0, hits: 0, myHits: 0, input: () => ({ k: inp.kickDownAt !== null, kp: inp.kp, kc: inp.kc, lob: inp.lob, ax: inp.ax, ay: inp.ay, ws: ws ? ws.readyState : -1 }) };

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
