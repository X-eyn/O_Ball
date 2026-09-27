import { createRenderer, KITS } from '/render3d.js';

const C = OB.C, TPMS = 60 / 1000;
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { } },
};
const sess = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { } },
};
function rid() { const a = new Uint8Array(12); crypto.getRandomValues(a); return Array.from(a, b => b.toString(16).padStart(2, '0')).join(''); }
// token is per-tab so two tabs on one PC are two different players
let token = sess.get('ob_token'); if (!token) { token = rid(); sess.set('ob_token', token); }
const myName = () => store.get('ob_name') || '';
const EMOTES = ['GG', 'Nice one!', 'Lucky…', 'Too easy 😎', 'Rematch?!', '😭'];
const COLORS = ['#ff4d5e', '#3fa7ff'];

function toast(text, ms = 3200) {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, ms);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
}

function lbHtml(list, highlight) {
  if (!list || !list.length) return '<div class="empty">No ranked matches yet. Play a real 1v1 to get on the board.</div>';
  const rows = list.map((p, i) => {
    const acc = p.shots ? Math.round(p.perfect / p.shots * 100) + '%' : '–';
    const me = highlight && p.name.toLowerCase() === highlight.toLowerCase();
    return `<tr class="${i === 0 ? 'top' : ''}${me ? ' me' : ''}"><td>${i === 0 ? '👑' : i + 1}</td><td>${esc(p.name)}</td><td><b>${p.rating}</b></td><td>${p.w}–${p.l}</td><td>${p.gf}:${p.ga}</td><td>${acc}</td><td>${p.bestStreak}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th>#</th><th>Player</th><th>Rating</th><th>W–L</th><th>Goals</th><th>Perfect</th><th>Streak</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// =====================================================================
// Sound (synthesized, no assets)
// =====================================================================
const Sound = (() => {
  let ctx = null, master = null, nb = null, muted = store.get('ob_muted') === '1', crowdGain = null, crowdHi = null;
  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = muted ? 0 : 0.5; master.connect(ctx.destination);
      nb = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
      const d = nb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      // looping crowd ambience: two filtered noise beds
      const mk = (freq, q) => {
        const s = ctx.createBufferSource(); s.buffer = nb; s.loop = true;
        const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
        const g = ctx.createGain(); g.gain.value = 0;
        s.connect(f); f.connect(g); g.connect(master); s.start();
        return g;
      };
      crowdGain = mk(420, 0.6); crowdHi = mk(1400, 0.9);
    } catch { ctx = null; }
  }
  const ok = () => ctx && !muted && ctx.state === 'running';
  function tone(f, dur, o = {}) {
    if (!ok()) return;
    const t = ctx.currentTime + (o.at || 0), osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = o.type || 'sine'; osc.frequency.setValueAtTime(f, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    if (o.lfo) { const l = ctx.createOscillator(), lg = ctx.createGain(); l.frequency.value = o.lfo; lg.gain.value = o.lfoAmt || 100; l.connect(lg); lg.connect(osc.frequency); l.start(t); l.stop(t + dur + 0.05); }
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(o.vol || 0.3, t + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(master); osc.start(t); osc.stop(t + dur + 0.05);
  }
  function noise(dur, o = {}) {
    if (!ok()) return;
    const t = ctx.currentTime + (o.at || 0), s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = nb; f.type = o.type || 'bandpass'; f.frequency.setValueAtTime(o.freq || 1000, t);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    f.Q.value = o.q || 1;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(o.vol || 0.3, t + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(master); s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }
  const fx = {
    kick(p) { tone(140, 0.14, { vol: 0.3 + 0.35 * p, to: 45 }); noise(0.05, { vol: 0.1 + 0.15 * p, freq: 2400, q: 0.8 }); },
    perfect() { tone(170, 0.22, { vol: 0.7, to: 42 }); noise(0.12, { vol: 0.35, freq: 3000 }); tone(880, 0.3, { type: 'triangle', vol: 0.16, at: 0.02 }); tone(1320, 0.4, { type: 'triangle', vol: 0.12, at: 0.07 }); },
    whiff() { noise(0.12, { vol: 0.06, freq: 1400, to: 400 }); },
    dash() { noise(0.2, { vol: 0.1, freq: 500, to: 2200, q: 2 }); },
    tackle() { tone(95, 0.22, { vol: 0.5, to: 40, type: 'square' }); noise(0.15, { vol: 0.3, freq: 700 }); },
    post() { tone(1250, 0.6, { type: 'triangle', vol: 0.22 }); tone(1870, 0.5, { vol: 0.1 }); tone(90, 0.1, { vol: 0.3 }); },
    wall(sp) { tone(110, 0.08, { vol: Math.min(0.25, sp / 45), to: 60 }); },
    goal() {
      noise(3.2, { vol: 0.42, freq: 600, q: 0.45, attack: 0.25 }); noise(2.4, { vol: 0.2, freq: 1800, q: 0.6, attack: 0.18 });
      [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.35, { type: 'square', vol: 0.05, at: i * 0.08 }));
    },
    groan() { noise(1.2, { vol: 0.2, freq: 350, to: 220, q: 0.8, attack: 0.1 }); },
    whistle(long) { tone(2900, long ? 1.0 : 0.35, { vol: 0.1, lfo: 28, lfoAmt: 160, attack: 0.02 }); if (long) tone(2900, 0.35, { vol: 0.1, lfo: 28, lfoAmt: 160, at: 1.15 }); },
    beep(hi) { tone(hi ? 1046 : 587, hi ? 0.28 : 0.12, { type: 'square', vol: 0.06 }); },
    emote() { tone(700, 0.08, { type: 'triangle', vol: 0.1 }); tone(1000, 0.1, { type: 'triangle', vol: 0.08, at: 0.06 }); },
    win() { [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.34, { type: 'triangle', vol: 0.12, at: i * 0.1 })); },
    lose() { [392, 330, 262].forEach((f, i) => tone(f, 0.4, { type: 'triangle', vol: 0.1, at: i * 0.16 })); },
    join() { tone(660, 0.1, { type: 'triangle', vol: 0.08 }); tone(990, 0.12, { type: 'triangle', vol: 0.08, at: 0.08 }); },
    whoosh() { noise(0.5, { vol: 0.12, freq: 300, to: 3000, q: 1.5, attack: 0.2 }); },
  };
  let crowdLevel = 0;
  return {
    init, fx,
    crowd(level) {
      if (!ctx || !crowdGain) return;
      crowdLevel += (level - crowdLevel) * 0.05;
      const t = ctx.currentTime;
      crowdGain.gain.setTargetAtTime(muted ? 0 : 0.05 + crowdLevel * 0.2, t, 0.1);
      crowdHi.gain.setTargetAtTime(muted ? 0 : 0.012 + crowdLevel * 0.08, t, 0.1);
    },
    get muted() { return muted; },
    toggle() { muted = !muted; store.set('ob_muted', muted ? '1' : '0'); if (master) master.gain.value = muted ? 0 : 0.5; return muted; },
  };
})();
addEventListener('pointerdown', () => Sound.init());
addEventListener('keydown', () => Sound.init());

// =====================================================================
// 3D renderer
// =====================================================================
let R = null;
try {
  R = createRenderer($('c'));
} catch (e) {
  console.error(e);
  $('fatal').innerHTML = 'Office Ball needs WebGL (3D graphics), which this browser has disabled.<br>Try Chrome or Edge with hardware acceleration turned on.';
  $('fatal').classList.remove('hidden');
}
const qualityNames = { auto: 'Auto', high: 'High', low: 'Low' };
let quality = store.get('ob_quality') || 'auto';
if (R) R.setQuality(quality);
function fitStage() { const r = $('view').getBoundingClientRect(); if (R && r.width > 0 && r.height > 0) R.resize(r.width, r.height); }
new ResizeObserver(fitStage).observe($('view'));

// =====================================================================
// Home (with a live AI match playing in the background)
// =====================================================================
function showHome() {
  $('home').classList.remove('hidden');
  const nameIn = $('nameInput'); nameIn.value = myName();
  const needName = () => {
    const n = nameIn.value.trim();
    if (!n) { nameIn.focus(); nameIn.classList.remove('shake'); void nameIn.offsetWidth; nameIn.classList.add('shake'); return null; }
    store.set('ob_name', n.slice(0, 16)); return n;
  };
  const go = code => { if (needName()) location.href = '/r/' + encodeURIComponent(code.toUpperCase()); };
  $('createBtn').onclick = async () => {
    if (!needName()) return;
    try { const r = await (await fetch('/api/new')).json(); go(r.code); } catch { toast('Server unreachable. Is it running?'); }
  };
  $('joinBtn').onclick = () => { const c = $('codeInput').value.trim().replace(/[^A-Za-z0-9]/g, ''); if (c) go(c); else $('codeInput').focus(); };
  $('codeInput').onkeydown = e => { if (e.key === 'Enter') $('joinBtn').click(); };
  nameIn.onkeydown = e => { if (e.key === 'Enter') $('createBtn').click(); };
  if (!nameIn.value) nameIn.focus();
  async function refresh() {
    try {
      const [rooms, lb] = await Promise.all([fetch('/api/rooms').then(r => r.json()), fetch('/api/leaderboard').then(r => r.json())]);
      $('roomsList').innerHTML = rooms.length ? '<div class="label" style="margin:4px 0 0">Open rooms</div>' + rooms.map(r =>
        `<button class="btn room-item" data-code="${esc(r.code)}"><span><b>${esc(r.code)}</b>&nbsp; ${esc(r.names.join(', '))}</span><span>${r.live ? '<span class="live">● LIVE</span> ' : ''}${r.players} 👤</span></button>`).join('') : '';
      $('roomsList').querySelectorAll('.room-item').forEach(b => b.onclick = () => go(b.dataset.code));
      $('homeLb').innerHTML = lbHtml(lb, myName());
    } catch { }
  }
  refresh(); setInterval(refresh, 3000);

  // attract mode: two bots play a real match locally
  let sim = OB.createSim(0), acc = 0, last = performance.now(), prevWorld = null, curWorld = null;
  const toWorld = s => ({ ball: [s.ball.x, s.ball.y, s.ball.hot > 0 ? 1 : 0], players: s.players.map(p => [p.x, p.y, p.fx, p.fy, p.ch ? p.ct : -1, p.stun > 0 ? 1 : 0, p.dashT > 0 ? 1 : 0, 0, 0]) });
  function loop(now) {
    requestAnimationFrame(loop);
    acc += Math.min(100, now - last); last = now;
    while (acc >= 1000 / 60) {
      acc -= 1000 / 60;
      sim.tick++;
      OB.stepSim(sim, [OB.botInput(sim, 0), OB.botInput(sim, 1)]);
      for (const e of sim.events) {
        if (e.type === 'kick' && R) R.fx.kick(e.p, e.x, e.y, e.perfect, e.power);
        if (e.type === 'goal' && R) R.fx.goal(e.scorer, e.x, e.y);
        if (e.type === 'tackle' && R) R.fx.tackle(e.x, e.y);
      }
      sim.events.length = 0;
      if (sim.phase === 'replay') sim.pt = C.REPLAY_T;
      if (sim.phase === 'over') sim = OB.createSim(sim.tick);
      prevWorld = curWorld; curWorld = toWorld(sim);
    }
    if (!R || !curWorld) return;
    const t = acc / (1000 / 60), W = prevWorld ? {
      ball: [lerp(prevWorld.ball[0], curWorld.ball[0], t), lerp(prevWorld.ball[1], curWorld.ball[1], t), curWorld.ball[2]],
      players: curWorld.players.map((p, i) => { const q = prevWorld.players[i]; return [lerp(q[0], p[0], t), lerp(q[1], p[1], t), p[2], p[3], p[4], p[5], p[6], 0, 0]; }),
    } : curWorld;
    R.frame({ mode: 'showcase', world: W, live: false, names: ['Home', 'Away'], mySlot: -1, noTrail: false, scoreboard: { names: ['RED', 'BLUE'], score: sim.score, mid: 'LIVE' } });
  }
  requestAnimationFrame(loop);
}

// =====================================================================
// Room / game
// =====================================================================
let ws = null, code = '', myId = null, room = null, matchInfo = null, result = null, lbList = [];
let retry = 0, everConnected = false;
let lastGoal = null; // {scorer, own, tick}

function mySlot() { return room && myId != null ? room.slots.indexOf(myId) : -1; }
function memberName(id) { if (id === 'bot') return 'BOT'; if (id === 'none') return 'PRACTICE'; const m = room && room.members.find(x => x.id === id); return m ? m.name : '?'; }
function slotName(i) {
  if (matchInfo && matchInfo.names) return matchInfo.names[i];
  return room ? memberName(room.slots[i]) : (i ? 'BLUE' : 'RED');
}

function enterRoom(c) {
  code = c;
  $('side').classList.remove('hidden'); $('hud').classList.remove('hidden');
  $('roomCode').textContent = code;
  document.title = `Office Ball · ${code}`;
  history.replaceState(null, '', '/r/' + code);
  if (store.get('ob_side') === 'hidden') document.body.classList.add('side-hidden');
  setupShare(); setupSide(); setupInput();
  if (!myName()) askName(connect); else connect();
  requestAnimationFrame(frame);
  setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping', c: performance.now() })); }, 2000);
}

function askName(then) {
  $('nameModal').classList.remove('hidden');
  const inp = $('modalName'); inp.value = myName(); inp.focus(); inp.select();
  const done = () => {
    const n = inp.value.trim(); if (!n) { inp.focus(); return; }
    store.set('ob_name', n.slice(0, 16)); $('nameModal').classList.add('hidden'); then();
  };
  $('modalGo').onclick = done;
  inp.onkeydown = e => { if (e.key === 'Enter') done(); e.stopPropagation(); };
}

async function setupShare() {
  const setLink = host => { $('shareLink').value = `${location.protocol}//${host}/r/${code}`; };
  setLink(location.host);
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(location.hostname);
  try {
    const info = await (await fetch('/api/info')).json();
    if (local && info.ips.length) {
      setLink(`${info.ips[0]}:${location.port || info.port}`);
      $('shareHint').innerHTML = 'Teammates must be on the same office network/Wi-Fi.' +
        (info.ips.length > 1 ? `<br>Not working? Try: ${info.ips.slice(1).map(ip => `<code>${esc(ip)}</code>`).join(', ')}` : '');
    } else if (local) $('shareHint').textContent = 'No network found on this PC. Connect to Wi-Fi/LAN so others can join.';
    else $('shareHint').textContent = 'Anyone on this network can open it.';
  } catch { }
  $('shareLink').onclick = () => $('shareLink').select();
  $('copyBtn').onclick = () => {
    const v = $('shareLink').value;
    const fallback = () => { const i = $('shareLink'); i.focus(); i.select(); try { document.execCommand('copy'); } catch { } };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(v).catch(fallback); else fallback();
    $('copyBtn').blur(); $('copyBtn').textContent = 'Copied!'; setTimeout(() => $('copyBtn').textContent = 'Copy', 1500);
  };
}

function toggleSide() {
  document.body.classList.toggle('side-hidden');
  store.set('ob_side', document.body.classList.contains('side-hidden') ? 'hidden' : 'shown');
}

const practicePref = () => (store.get('ob_practice') === 'solo' ? 'solo' : 'bot');
function updatePracticeUI() {
  document.querySelectorAll('#practiceSeg button').forEach(b => b.classList.toggle('on', b.dataset.p === practicePref()));
  $('practiceHint').innerHTML = practicePref() === 'solo'
    ? 'No opponent, no clock. Shoot at either goal. <kbd>R</kbd> brings the ball to your feet.'
    : 'A bot plays you until a teammate joins.';
}
function setupSide() {
  document.querySelectorAll('#practiceSeg button').forEach(b => b.onclick = e => {
    store.set('ob_practice', b.dataset.p); send({ t: 'practice', v: b.dataset.p }); updatePracticeUI(); e.currentTarget.blur();
  });
  updatePracticeUI();
  $('muteBtn').textContent = Sound.muted ? '🔇' : '🔊';
  $('muteBtn').onclick = e => { $('muteBtn').textContent = Sound.toggle() ? '🔇' : '🔊'; e.currentTarget.blur(); };
  $('sitBtn').onclick = e => { const me = room && room.members.find(m => m.id === myId); if (me) send({ t: 'sit', v: !me.sitting }); e.currentTarget.blur(); };
  $('lbBtn').onclick = e => { $('lbTable').innerHTML = lbHtml(lbList, myName()); $('lbModal').classList.remove('hidden'); e.currentTarget.blur(); };
  $('lbClose').onclick = () => $('lbModal').classList.add('hidden');
  $('lbModal').onclick = e => { if (e.target === $('lbModal')) $('lbModal').classList.add('hidden'); };
  $('homeBtn').onclick = () => { location.href = '/'; };
  $('renameBtn').onclick = e => { e.currentTarget.blur(); askName(() => send({ t: 'name', name: myName() })); };
  $('sideToggle').onclick = e => { toggleSide(); e.currentTarget.blur(); };
  const qb = $('qualityBtn');
  qb.textContent = `Graphics: ${qualityNames[quality]}`;
  qb.onclick = e => {
    quality = { auto: 'high', high: 'low', low: 'auto' }[quality];
    store.set('ob_quality', quality); if (R) R.setQuality(quality);
    qb.textContent = `Graphics: ${qualityNames[quality]}`; e.currentTarget.blur();
  };
}

function renderMembers() {
  if (!room) return;
  const rows = [];
  const pushRow = (id, name, cls, dotCls, tag, rating) => rows.push(
    `<li class="${cls}"><span class="dot ${dotCls}"></span><span class="nm">${esc(name)}${id === myId ? ' <span class="pill">you</span>' : ''}${room.streak && room.streak.id === id && room.streak.n >= 2 ? ` 👑${room.streak.n}` : ''}</span>${tag ? `<span class="pill">${tag}</span>` : ''}${rating != null ? `<span class="rt">${rating}</span>` : ''}</li>`);
  room.slots.forEach((id, i) => {
    if (id === 'none') return;
    if (id === 'bot') pushRow('bot', 'BOT', '', i ? 'blue' : 'red', 'practice', null);
    else if (id != null) { const m = room.members.find(x => x.id === id); if (m) pushRow(m.id, m.name, (m.id === myId ? 'me ' : '') + (m.connected ? '' : 'off'), i ? 'blue' : 'red', m.connected ? 'playing' : 'reconnecting', m.rating); }
  });
  room.queue.forEach((id, qi) => { const m = room.members.find(x => x.id === id); if (m) pushRow(m.id, m.name, m.id === myId ? 'me' : '', 'q', qi === 0 ? 'next up' : `#${qi + 1} in line`, m.rating); });
  room.members.filter(m => !room.slots.includes(m.id) && !room.queue.includes(m.id)).forEach(m =>
    pushRow(m.id, m.name, (m.id === myId ? 'me ' : '') + (m.connected ? '' : 'off'), '', m.connected ? 'sitting out' : 'offline', m.rating));
  $('memberList').innerHTML = rows.join('');
  const me = room.members.find(m => m.id === myId);
  $('sitBtn').textContent = me && me.sitting ? '▶ Join the line' : '⏸ Sit out';
}

// ---------------- networking ----------------
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(code)}`);
  const sock = ws;
  sock.onopen = () => {
    retry = 0; everConnected = true;
    sock.send(JSON.stringify({ t: 'hello', name: myName(), token, practice: practicePref() }));
    $('conn').classList.add('hidden');
    lastSent = ''; sendInput();
  };
  sock.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
  sock.onclose = () => {
    if (ws !== sock) return;
    if (everConnected) $('conn').classList.remove('hidden');
    clock.reset();
    setTimeout(connect, Math.min(3000, 250 * ++retry));
  };
}

let pingMs = null;
function handle(m) {
  switch (m.t) {
    case 's': onState(m); break;
    case 'welcome': myId = m.id; break;
    case 'room': {
      const prevLen = room ? room.members.filter(x => x.connected).length : 0;
      room = m; renderMembers();
      if (room.members.filter(x => x.connected).length > prevLen && prevLen > 0) Sound.fx.join();
      break;
    }
    case 'match': matchInfo = m; result = null; bubbles.clear(); lastCountdown = -1; introPlayed = false; break;
    case 'result': result = m; resultAt = performance.now(); resultFx = false; break;
    case 'emote': showEmote(m.id, m.n); break;
    case 'toast': toast(m.text); break;
    case 'lb': lbList = m.list; if (!$('lbModal').classList.contains('hidden')) $('lbTable').innerHTML = lbHtml(lbList, myName()); break;
    case 'pong': pingMs = performance.now() - m.c; $('netInfo').textContent = `Ping ${pingMs.toFixed(0)} ms · smoothing ${Math.max(0, clock.delay * 16.7).toFixed(0)} ms · ${R ? ['low', 'medium', 'high'][R.level] : ''} graphics`; break;
  }
}

// ---------------- snapshot buffer + playback clock ----------------
// The server ticks at 60Hz, but Windows timers deliver packets in uneven clumps. Instead of chasing
// every packet, playback runs on its own steady clock at real-time speed and is gently nudged (never
// jumped) toward a target just behind the latest-arriving packets of the last few seconds.
const hist = [];
const pendingEvents = [];
const clock = {
  est: [], at: [], playT: null, delay: 0,
  reset() { this.est.length = 0; this.at.length = 0; this.playT = null; },
  onState(k, now) {
    this.est.push(k - now * TPMS); this.at.push(now);
    while (this.at.length > 2 && now - this.at[0] > 3000) { this.est.shift(); this.at.shift(); }
  },
  advance(now, dtMs) {
    if (!this.est.length) return null;
    let min = Infinity; for (const e of this.est) if (e < min) min = e;
    const target = now * TPMS + min - 2.2; // ~2 ticks behind the latest-arriving packet
    if (this.playT === null || Math.abs(target - this.playT) > 20) this.playT = target;
    else this.playT += dtMs * TPMS * (1 + clamp((target - this.playT) * 0.04, -0.08, 0.08));
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
  hist.push(s);
  if (hist.length > 1500) hist.splice(0, hist.length - 1200);
  if (s.ev) for (const e of s.ev) pendingEvents.push(e);
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
    // a packet is late: keep moving along the last known velocity for up to 4 ticks
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
  const jump = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1) > 70;
  const ball = jump(a.b[0], a.b[1], b.b[0], b.b[1]) ? (t < 0.5 ? a.b : b.b) : [lerp(a.b[0], b.b[0], t), lerp(a.b[1], b.b[1], t), a.b[2]];
  const players = a.p.map((pa, k) => {
    const pb = b.p[k];
    if (jump(pa[0], pa[1], pb[0], pb[1])) return t < 0.5 ? pa : pb;
    const d = t < 1 ? pa : pb, tf = Math.min(t, 1);
    return [lerp(pa[0], pb[0], t), lerp(pa[1], pb[1], t), lerp(pa[2], pb[2], tf), lerp(pa[3], pb[3], tf), d[4], d[5], d[6], d[7], d[8]];
  });
  return { ball, players };
}

// ---------------- input: keyboard, mouse/trackpad, gamepad ----------------
const KEYMAP = {
  KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r',
  Space: 'kick', KeyJ: 'kick', ShiftLeft: 'dash', ShiftRight: 'dash', KeyK: 'dash',
};
const MOVE = new Set(['u', 'd', 'l', 'r']);
const held = new Set();
const kickSources = new Set();
const inp = { kp: 0, dc: 0, kc: null, kickDownAt: null, ax: 0, ay: 0, rb: 0 };
const mouse = { x: 0, y: 0, has: false };
let ctrl = ['keyboard', 'mouse', 'gamepad'].includes(store.get('ob_ctrl')) ? store.get('ob_ctrl') : 'keyboard';
let lastSent = '', padPrev = { kick: false, dash: false }, padSeen = false;
const CTRL_HELP = {
  keyboard: '<div><kbd>WASD</kbd> / <kbd>Arrows</kbd> move</div><div><kbd>Space</kbd> hold to charge, release to kick. Release on <b class="gold">gold</b> = PERFECT</div><div><kbd>Shift</kbd> dash-tackle</div>',
  mouse: '<div>Your player <b>runs to the pointer</b>. Keep it just ahead of you for fine control</div><div><b>Hold click</b> to charge, <b>release</b> to shoot where you point. Release on <b class="gold">gold</b> = PERFECT</div><div><b>Right-click</b> (two-finger tap) = dash-tackle. <kbd>Space</kbd> also kicks</div>',
  gamepad: '<div><b>Left stick</b> / D-pad move</div><div>Hold <b>A</b> (or RT) to charge, release to kick. Release on <b class="gold">gold</b> = PERFECT</div><div><b>X</b> / <b>B</b> / LB = dash-tackle</div>',
};
const CTRL_TOAST = {
  keyboard: '⌨ Keyboard controls',
  mouse: '🖱 Mouse controls: run to the pointer, hold click and release to shoot, right-click to tackle',
  gamepad: '🎮 Controller connected: left stick moves, A kicks, X tackles',
};
function typing(e) { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'); }
function sendInput(force) {
  const msg = {
    t: 'i',
    u: +(held.has('KeyW') || held.has('ArrowUp')), d: +(held.has('KeyS') || held.has('ArrowDown')),
    l: +(held.has('KeyA') || held.has('ArrowLeft')), r: +(held.has('KeyD') || held.has('ArrowRight')),
    k: inp.kickDownAt !== null, kp: inp.kp, kc: inp.kc, dc: inp.dc,
    ax: Math.round(inp.ax * 50) / 50, ay: Math.round(inp.ay * 50) / 50, rb: inp.rb,
  };
  const s = JSON.stringify(msg);
  if (force || s !== lastSent) { lastSent = s; if (ws && ws.readyState === 1) ws.send(s); }
}
function releaseKick(now) {
  if (inp.kickDownAt === null) return;
  inp.kc = Math.round((now - inp.kickDownAt) * TPMS); inp.kickDownAt = null;
}
function kickDown(src) { if (!kickSources.size) { inp.kickDownAt = performance.now(); inp.kp++; } kickSources.add(src); sendInput(); }
function kickUp(src) { if (!kickSources.delete(src)) return; if (!kickSources.size) releaseKick(performance.now()); sendInput(); }
function dashPress() { inp.dc++; sendInput(); }
function updateCtrlUI() {
  document.querySelectorAll('#ctrlSeg button').forEach(b => b.classList.toggle('on', b.dataset.c === ctrl));
  const h = $('ctrlHelp'); if (h) h.innerHTML = CTRL_HELP[ctrl];
  $('view').classList.toggle('mouse-mode', ctrl === 'mouse');
}
function setCtrl(mode, announce = true) {
  if (mode === ctrl) return;
  ctrl = mode; store.set('ob_ctrl', mode);
  inp.ax = inp.ay = 0;
  updateCtrlUI();
  if (announce) toast(CTRL_TOAST[mode], 4500);
  sendInput();
}
function setupInput() {
  addEventListener('keydown', e => {
    if (typing(e) || !$('nameModal').classList.contains('hidden')) return;
    const act = KEYMAP[e.code];
    if (act) e.preventDefault();
    if (e.repeat) return;
    if (/^Digit[1-6]$/.test(e.code)) { send({ t: 'emote', n: +e.code.slice(5) - 1 }); return; }
    if (e.code === 'KeyM') { $('muteBtn').textContent = Sound.toggle() ? '🔇' : '🔊'; return; }
    if (e.code === 'KeyH') { toggleSide(); return; }
    if (e.code === 'KeyR') { inp.rb++; sendInput(); return; }
    if (e.code === 'Escape') { $('lbModal').classList.add('hidden'); return; }
    if (!act) return;
    if (MOVE.has(act) && ctrl !== 'keyboard') setCtrl('keyboard');
    held.add(e.code);
    if (act === 'kick') kickDown('key:' + e.code);
    if (act === 'dash') dashPress();
    sendInput();
  });
  addEventListener('keyup', e => {
    if (!held.has(e.code)) return;
    held.delete(e.code);
    if (KEYMAP[e.code] === 'kick') kickUp('key:' + e.code);
    sendInput();
  });
  // mouse / trackpad
  const stage = $('view');
  stage.addEventListener('pointermove', e => {
    const r = stage.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.has = true;
  });
  stage.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch' || e.target.closest('button, input, a')) return;
    const r = stage.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.has = true;
    if (e.button === 0) { if (ctrl !== 'mouse') setCtrl('mouse'); kickDown('mouse'); e.preventDefault(); }
    else if (e.button === 2) { if (ctrl !== 'mouse') setCtrl('mouse'); dashPress(); e.preventDefault(); }
  });
  addEventListener('pointerup', e => { if (e.button === 0) kickUp('mouse'); });
  stage.addEventListener('contextmenu', e => e.preventDefault());
  addEventListener('gamepadconnected', () => { padSeen = true; toast('🎮 Controller detected. Move the stick to use it', 3500); });
  const clearAll = () => { held.clear(); for (const s of [...kickSources]) kickUp(s); inp.ax = inp.ay = 0; sendInput(); };
  addEventListener('blur', clearAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearAll(); });
  setInterval(() => sendInput(true), 250);
  document.querySelectorAll('#ctrlSeg button').forEach(b => b.onclick = e => { setCtrl(b.dataset.c); e.currentTarget.blur(); });
  updateCtrlUI();
}
function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp = null; for (const p of pads) if (p && p.connected) { gp = p; break; }
  if (!gp) return;
  const b = i => !!(gp.buttons[i] && gp.buttons[i].pressed);
  let x = gp.axes[0] || 0, y = gp.axes[1] || 0;
  if (b(14)) x = -1; if (b(15)) x = 1; if (b(12)) y = -1; if (b(13)) y = 1;
  const m = Math.hypot(x, y);
  const kick = b(0) || b(7) || b(5) || b(9), dsh = b(2) || b(1) || b(4) || b(6);
  if ((m > 0.4 || kick || dsh) && ctrl !== 'gamepad') setCtrl('gamepad');
  if (ctrl === 'gamepad') {
    if (m < 0.2) { inp.ax = inp.ay = 0; } else { const mm = Math.min(1, (m - 0.2) / 0.65); inp.ax = x / m * mm; inp.ay = y / m * mm; }
    if (kick && !padPrev.kick) kickDown('pad');
    if (!kick && padPrev.kick) kickUp('pad');
    if (dsh && !padPrev.dash) dashPress();
    sendInput();
  }
  padPrev.kick = kick; padPrev.dash = dsh;
}

// ---------------- HTML overlays: labels, floats, bubbles, banners ----------------
const labels = $('labels');
const tags = [0, 1].map(i => { const d = document.createElement('div'); d.className = `ptag p${i}`; labels.appendChild(d); return d; });
const bubbles = new Map(); // slot -> {el, until}
function floatText(x, y, h, text, color, size = 34) {
  if (!R) return;
  const p = R.project(x, y, h);
  const el = document.createElement('div'); el.className = 'float';
  el.textContent = text; el.style.color = color; el.style.fontSize = size + 'px';
  el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
  labels.appendChild(el); setTimeout(() => el.remove(), 1150);
}
function showEmote(id, n) {
  Sound.fx.emote();
  const slot = room ? room.slots.indexOf(id) : -1;
  if (slot >= 0) {
    const old = bubbles.get(slot); if (old) old.el.remove();
    const el = document.createElement('div'); el.className = 'bubble'; el.textContent = EMOTES[n];
    labels.appendChild(el); bubbles.set(slot, { el, until: performance.now() + 2600 });
  } else toast(`${memberName(id)}: ${EMOTES[n]}`, 2200);
}
function goalBanner(text, sub, color) {
  const gb = $('goalBanner'), band = gb.querySelector('.gb-band');
  band.style.setProperty('--c', color);
  $('gbText').textContent = text; $('gbSub').textContent = sub;
  gb.classList.remove('on'); void gb.offsetWidth; gb.classList.add('on');
}
function bigText(text, color = '#fff', hold = false) {
  const el = $('bigText');
  el.textContent = text; el.style.color = color;
  el.classList.remove('show', 'hold'); void el.offsetWidth;
  el.classList.add(hold ? 'hold' : 'show');
}

// which way a slot attacks: red attacks right in the first half, ends switch at halftime
function attackArrow(slot, swapped) { return ((slot === 0) !== !!swapped) ? '→' : '←'; }

function fireEvent(e) {
  const mine = e.p === mySlot();
  switch (e.type) {
    case 'kick':
      if (R) R.fx.kick(e.p, e.x, e.y, e.perfect, e.power);
      if (e.perfect) { Sound.fx.perfect(); floatText(e.x, e.y, 1.6, 'PERFECT!', '#ffd34d', 46); }
      else { Sound.fx.kick(e.power); if (e.curve && mine) floatText(e.x, e.y, 1.4, 'curve', '#b8f0ff', 26); }
      break;
    case 'whiff': if (mine) { Sound.fx.whiff(); floatText(e.x, e.y, 1.5, 'whiff', '#aeb8d3', 26); } break;
    case 'dash': Sound.fx.dash(); if (R) R.fx.dash(e.p, e.x, e.y); break;
    case 'dashmiss': if (mine) floatText(e.x, e.y, 1.5, 'missed', '#aeb8d3', 24); break;
    case 'tackle': Sound.fx.tackle(); if (R) R.fx.tackle(e.x, e.y); floatText(e.x, e.y, 1.7, 'TACKLED!', '#ff9f43', 40); break;
    case 'post': Sound.fx.post(); Sound.fx.groan(); if (R) R.fx.post(e.x, e.y); floatText(e.x, e.y, 1.5, 'POST!', '#ffffff', 42); break;
    case 'wall': Sound.fx.wall(e.sp); if (R) R.fx.wall(e.x, e.y, e.sp); break;
    case 'goal': {
      Sound.fx.goal();
      lastGoal = { scorer: e.scorer, own: e.own, tick: e.tick };
      if (R) R.fx.goal(e.scorer, e.x, e.y);
      const who = slotName(e.scorer);
      if (e.own) goalBanner('OWN GOAL', `${slotName(1 - e.scorer)} · ${e.score[0]}–${e.score[1]}`, COLORS[e.scorer]);
      else goalBanner(e.final ? 'WINNER!' : 'GOAL!', `${who} · ${e.score[0]}–${e.score[1]}`, COLORS[e.scorer]);
      const sb = $('s' + e.scorer); sb.classList.remove('bump'); void sb.offsetWidth; sb.classList.add('bump');
      break;
    }
    case 'whistle': Sound.fx.whistle(false); break;
    case 'sd': Sound.fx.whistle(false); goalBanner('SUDDEN DEATH', 'NEXT GOAL WINS', '#d4152b'); if (R) R.fx.shake(0.3); break;
    case 'end': Sound.fx.whistle(true); break;
    case 'half': Sound.fx.whistle(true); break;
    case 'secondhalf': {
      goalBanner('SECOND HALF', 'ENDS SWITCHED', '#24345f');
      const ms = mySlot();
      if (ms >= 0) toast(`Ends switched: you now attack ${attackArrow(ms, true)}`);
      break;
    }
  }
}

// ---------------- screens ----------------
let screenKey = '', lastCountdown = -1, introPlayed = false, resultAt = 0, resultFx = false, lastBig = '';
function setScreen(key, html) {
  if (key === screenKey) return false;
  screenKey = key; $('screen').innerHTML = html; return true;
}
function statRows(r) {
  const tot = Math.max(1, r.stats[0].poss + r.stats[1].poss);
  const rows = [['Goals', st => st.goals], ['Shots', st => st.shots], ['Perfect kicks', st => st.perfect], ['Tackles', st => st.tackles], ['Possession', st => Math.round(st.poss / tot * 100), '%']];
  return rows.map(([label, f, suf = '']) => {
    const a = f(r.stats[0]), b = f(r.stats[1]), m = Math.max(1, a, b);
    return `<div class="stat"><span class="v" style="color:#ff8a96">${a}${suf}</span><span class="bar l0"><i style="width:${a / m * 100}%"></i></span><span class="l">${label}</span><span class="bar l1"><i style="width:${b / m * 100}%"></i></span><span class="v" style="color:#7cc4ff">${b}${suf}</span></div>`;
  }).join('');
}
function renderScreens(s) {
  const ms = mySlot();
  const me = room && room.members.find(m => m.id === myId);
  if (s.rp === 'waiting') {
    setScreen('wait' + (me && me.sitting), `<div class="scrim"></div><div class="panel">${me && me.sitting
      ? '<h2>YOU\'RE SITTING OUT</h2><p>Click "Join the line" in the side panel to play.</p>'
      : '<h2>WAITING FOR PLAYERS</h2><p>Share the invite link from the side panel.</p>'}</div>`);
  } else if (s.rp === 'prematch' && matchInfo) {
    const mi = matchInfo, secs = Math.max(1, Math.ceil((s.rt || 0) / 60));
    if (secs !== lastCountdown) { if (lastCountdown !== -1) Sound.fx.beep(false); else Sound.fx.whoosh(); lastCountdown = secs; }
    if (mi.solo) {
      setScreen('pre-solo', `<div class="scrim" style="opacity:.55"></div><div class="panel"><h2 style="color:var(--gold)">SOLO PRACTICE</h2><p>No opponent, no clock. Shoot at either goal. Press <kbd>R</kbd> to bring the ball to your feet.</p><p style="font-size:14px;color:var(--dim)">Want an opponent? Pick "Practice vs Bot" in the side panel, or share the invite link.</p><div class="vs-count" id="cnt" style="margin-top:14px"></div></div>`);
    } else if (mi.bot) {
      setScreen('pre-bot', `<div class="scrim" style="opacity:.6"></div><div class="panel"><h2 style="color:var(--gold)">PRACTICE vs BOT</h2><p>A ranked match starts the moment someone else joins. Share the invite link.</p><div class="vs-count" id="cnt" style="margin-top:14px"></div></div>`);
    } else {
      const crown = i => mi.streak && mi.streak.slot === i && mi.streak.n >= 2 ? `<div class="vs-crown">👑 ${mi.streak.n}-WIN STREAK</div>` : '';
      const h2h = mi.h2h ? (mi.h2h[0] + mi.h2h[1] ? `Head to head &nbsp;<b>${mi.h2h[0]} – ${mi.h2h[1]}</b>` : 'First ever meeting') : '';
      setScreen('pre-' + mi.names.join('|'), `<div class="vs">
        <div class="vs-side red"><div class="vs-kicker">RED${ms === 0 ? ' · YOU' : ''}</div><div class="vs-name">${esc(mi.names[0])}</div><div class="vs-rating">${mi.ratings[0]} rating</div>${crown(0)}</div>
        <div class="vs-mid"><div class="vs-vs">VS</div><div class="vs-count" id="cnt"></div></div>
        <div class="vs-side blue"><div class="vs-kicker">${ms === 1 ? 'YOU · ' : ''}BLUE</div><div class="vs-name">${esc(mi.names[1])}</div><div class="vs-rating">${mi.ratings[1]} rating</div>${crown(1)}</div>
        <div class="vs-info">${h2h}</div>
        ${ms >= 0 ? `<div class="vs-you">You are ${ms ? 'BLUE, attacking ←' : 'RED, attacking →'} · Controls: ${{ keyboard: 'keyboard', mouse: 'mouse / trackpad', gamepad: 'controller' }[ctrl]} (change in side panel)</div>` : ''}
      </div>`);
    }
    const c = $('cnt'); if (c) c.textContent = secs;
  } else if (s.rp === 'match' && s.ph === 'half') {
    const sc = s.sc || [0, 0];
    setScreen('half', `<div class="scrim"></div><div class="panel"><div class="label" style="font-size:13px;letter-spacing:.3em">END OF FIRST HALF</div><h2 style="font-size:96px">HALF TIME</h2>
      <div class="res-score" style="margin:10px 0 6px"><span class="nm c0">${esc(slotName(0))}</span><span class="num c0">${sc[0]}</span><span class="num" style="color:#556">–</span><span class="num c1">${sc[1]}</span><span class="nm c1">${esc(slotName(1))}</span></div>
      <p>Switching ends. Second half in <b id="hts"></b>s${ms >= 0 ? `: you'll attack <b>${attackArrow(ms, true)}</b>` : ''}</p></div>`);
    const h = $('hts'); if (h) h.textContent = Math.max(1, Math.ceil((C.HALF_T - (s.pt || 0)) / 60));
  } else if (s.rp === 'paused') {
    const gone = room ? room.slots.map(id => room.members.find(m => m.id === id)).find(m => m && !m.connected) : null;
    setScreen('paused', `<div class="scrim"></div><div class="panel"><h2>PAUSED</h2><p>${esc(gone ? gone.name : 'Opponent')} disconnected. Waiting <b id="pz"></b>s for them to return.</p></div>`);
    const p = $('pz'); if (p) p.textContent = Math.ceil((s.rt || 0) / 60);
  } else if (s.rp === 'over' && result) {
    const r = result, w = r.winner, wName = r.names[w];
    const title = ms === w ? 'VICTORY' : ms >= 0 ? 'DEFEAT' : `${esc(wName).toUpperCase()} WINS`;
    const cls = ms >= 0 && ms !== w ? 'lose' : 'win';
    let elo = '';
    if (r.elo) {
      const f = d => `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d}</span>`;
      elo = `<div class="res-elo"><span>${esc(r.names[0])}<b>${r.ratings[0]}</b> ${f(r.elo[0])}</span><span>${esc(r.names[1])}<b>${r.ratings[1]}</b> ${f(r.elo[1])}</span></div>`;
    }
    const notes = [];
    if (r.forfeit) notes.push('<div class="res-note">Win by forfeit</div>');
    if (r.h2h) notes.push(`<div class="res-note">Head to head: ${esc(r.names[0])} ${r.h2h[0]} – ${r.h2h[1]} ${esc(r.names[1])}</div>`);
    if (r.streak) notes.push(`<div class="res-note gold">👑 ${esc(r.streak.name)}: ${r.streak.n} wins in a row</div>`);
    let next;
    if (r.bot) next = room && room.queue.length ? 'Real match next' : 'Rematch vs BOT';
    else {
      const loserId = room ? room.slots[1 - w] : null;
      const ch = room && room.queue.find(id => id !== loserId);
      next = ch != null ? `Next: ${esc(wName)} vs ${esc(memberName(ch))}` : 'Rematch';
    }
    setScreen('over' + r.score.join() + r.names.join(), `<div class="scrim"></div><div class="glass result">
      <div class="res-title ${cls}">${title}</div>
      <div class="res-score"><span class="nm c0">${esc(r.names[0])}</span><span class="num c0">${r.score[0]}</span><span class="num" style="color:#556">–</span><span class="num c1">${r.score[1]}</span><span class="nm c1">${esc(r.names[1])}</span></div>
      ${statRows(r)}${elo}${notes.join('')}
      <div class="res-next">${next} in <span id="nx"></span>s</div>
      <div class="res-ready" id="rdy"></div>
    </div>`);
    const nx = $('nx'); if (nx) nx.textContent = Math.max(0, Math.ceil((s.rt || 0) / 60));
    const rdy = $('rdy');
    if (rdy) {
      if (ms >= 0) { const ok = s.rd && s.rd[ms]; rdy.textContent = ok ? 'READY ✓ WAITING FOR OPPONENT' : 'PRESS SPACE WHEN READY'; rdy.className = 'res-ready' + (ok ? ' ok' : ''); }
      else { const qi = room ? room.queue.indexOf(myId) : -1; rdy.textContent = qi === 0 ? "YOU'RE NEXT UP. GET READY!" : ''; }
    }
    if (!resultFx && performance.now() - resultAt > 700) {
      resultFx = true;
      if (ms >= 0) (ms === w ? Sound.fx.win : Sound.fx.lose)();
      if (R) R.fx.win(w);
    }
  } else setScreen('', '');
}

// ---------------- frame ----------------
let lastRenderTick = 0, lastFrameAt = null;
const setText = (el, v) => { v = String(v); if (el.textContent !== v) el.textContent = v; };
const setHTML = (el, v) => { if (el._html !== v) { el._html = v; el.innerHTML = v; } };
const setClass = (el, v) => { if (el.className !== v) el.className = v; };
function frame(now) {
  requestAnimationFrame(frame);
  const dtMs = lastFrameAt === null ? 16.7 : Math.min(100, now - lastFrameAt); lastFrameAt = now;
  let s = null, view = null;
  const pt = clock.advance(now, dtMs);
  if (hist.length && pt !== null) {
    let rt = pt;
    if (rt < lastRenderTick && lastRenderTick - rt < 30) rt = lastRenderTick;
    lastRenderTick = rt;
    view = sampleAt(rt); s = view && (view.s || view.a);
  }
  pollGamepad();
  while (pendingEvents.length && pendingEvents[0].tick <= lastRenderTick) {
    const e = pendingEvents.shift();
    if (lastRenderTick - e.tick < 90) fireEvent(e);
  }

  const ms = mySlot();
  // HUD
  if (s) {
    setText($('n0'), slotName(0)); setText($('n1'), s.so ? 'PRACTICE' : slotName(1));
    const sc = s.sc || [0, 0];
    setText($('s0'), sc[0]); setText($('s1'), s.so ? '–' : sc[1]);
    const ck = $('clock');
    if (s.so) { setText(ck, 'FREE'); setClass(ck, 'sb-clock'); }
    else if (s.sd) { setText(ck, 'SUDDEN DEATH'); setClass(ck, 'sb-clock sd'); }
    else { setText(ck, s.tm != null ? `${(s.tm / 60) | 0}:${String(s.tm % 60).padStart(2, '0')}` : '2:00'); setClass(ck, 'sb-clock' + (s.tm != null && s.tm <= 10 ? ' low' : '')); }
    const sub = $('subbug');
    const halfTxt = s.sd ? 'sudden death' : s.ph === 'half' ? 'half time' : (s.hf === 2 ? '2nd half' : '1st half');
    setText(sub, s.so ? 'Solo practice · both goals count · R = ball to your feet' : matchInfo ? `${matchInfo.bot ? 'Practice vs bot' : 'Ranked 1v1'} · ${halfTxt} · first to 3` : 'Office Ball');
    setClass(sub, matchInfo && matchInfo.bot ? 'bot' : '');
    setHTML($('hudLeft'), `Room <b>${esc(code)}</b>`);
    const q = room ? room.queue.length : 0;
    setHTML($('hudRight'), q ? `<b>${q}</b> waiting in line` : 'Nobody in line');
  }

  // camera mode + world
  let world = null, mode = 'game', introT = 0, celebrate = -1;
  const replaying = s && s.ph === 'replay' && s.rp !== 'prematch';
  if (replaying) {
    const rtick = s.rf + (lastRenderTick - s.ps) * C.REPLAY_SPEED;
    const rv = sampleAt(rtick);
    if (rv && rv.a.p) world = interpWorld(rv);
    mode = 'replay';
  }
  if (!world && s && s.p) world = interpWorld(view);
  if (s) {
    if (s.rp === 'prematch') { mode = 'intro'; introT = 1 - (s.rt || 0) / (matchInfo && matchInfo.bot ? 90 : 240); }
    else if (s.ph === 'goal' && lastGoal && s.rp === 'match') { mode = 'celebrate'; celebrate = lastGoal.scorer; }
    else if (s.rp === 'over' && result) celebrate = result.winner;
  }
  if (replaying !== frame.wasReplay) {
    frame.wasReplay = replaying;
    $('letterbox').classList.toggle('on', !!replaying);
    $('replayBadge').classList.toggle('on', !!replaying);
    $('replaySkip').style.display = ms >= 0 ? '' : 'none';
  }

  // kickoff / resume text
  let big = '';
  if (s && s.rp === 'match' && !replaying) {
    if (s.fz > 0) big = 'fz' + Math.ceil(s.fz / 60);
    else if (s.ph === 'kickoff') big = s.pt < C.KICKOFF_T - 18 ? 'ready' : 'go';
  }
  if (big !== lastBig) {
    lastBig = big;
    if (big === 'ready') bigText('READY', '#ffffff', true);
    else if (big === 'go') { bigText('GO!', '#ffd34d'); Sound.fx.beep(true); }
    else if (big.startsWith('fz')) { bigText(big.slice(2), '#ffffff'); Sound.fx.beep(false); }
    else if (!big) $('bigText').classList.remove('hold');
  }

  const live = !!(s && s.rp === 'match' && (s.ph === 'play' || s.ph === 'goal') && !replaying);
  let localCt, aim = null, cursor = null;
  if (ms >= 0 && live) localCt = inp.kickDownAt !== null ? (performance.now() - inp.kickDownAt) * TPMS : -1;
  const me = world && ms >= 0 ? world.players[ms] : null;
  // mouse / trackpad: steer toward the pointer on the pitch
  if (ctrl === 'mouse' && me && R && mouse.has) {
    const g = live || (s && s.ph === 'kickoff') ? R.pickGround(mouse.x, mouse.y) : null;
    if (g && live) {
      const dx = g.x - me[0], dy = g.y - me[1], d = Math.hypot(dx, dy);
      if (d < 14) { inp.ax = 0; inp.ay = 0; } else { const mag = clamp((d - 14) / 70, 0.3, 1); inp.ax = dx / d * mag; inp.ay = dy / d * mag; }
      if (d > 4) aim = [dx / d, dy / d];
      cursor = [g.x, g.y];
    } else { inp.ax = 0; inp.ay = 0; }
    sendInput();
  }
  if (me && !aim) {
    let ax = inp.ax, ay = inp.ay;
    if (ctrl === 'keyboard') {
      ax = (held.has('KeyD') || held.has('ArrowRight') ? 1 : 0) - (held.has('KeyA') || held.has('ArrowLeft') ? 1 : 0);
      ay = (held.has('KeyS') || held.has('ArrowDown') ? 1 : 0) - (held.has('KeyW') || held.has('ArrowUp') ? 1 : 0);
    }
    const m = Math.hypot(ax, ay);
    aim = m > 0.12 ? [ax / m, ay / m] : [me[2], me[3]];
  }
  const names = [slotName(0), slotName(1)];
  const rv = {
    mode, introT, celebrate, world, live, mySlot: ms, localCt, names, aim, cursor, hide: s && s.so ? [false, true] : null,
    noTrail: s && s.ph === 'kickoff',
    scoreboard: s && s.p ? { names: s.so ? [names[0], 'PRACTICE'] : names, score: s.so ? [(s.sc || [0])[0], '-'] : (s.sc || [0, 0]), mid: s.so ? 'SOLO' : s.sd ? 'SUDDEN DEATH' : s.ph === 'half' ? 'HALF TIME' : (s.hf === 2 ? '2ND HALF' : '1ST HALF') } : null,
  };
  if (R) R.frame(rv, now);
  Sound.crowd(s && s.p ? clamp((rv.hype || 0) * 1.4 + (mode === 'celebrate' ? 0.8 : 0), 0, 1) : 0);

  // name tags + bubbles
  const showTags = world && R && s && s.rp !== 'prematch' && !replaying;
  tags.forEach((el, i) => {
    if (!showTags || (s.so && i === 1)) { el.style.display = 'none'; return; }
    const p = world.players[i], pr = R.project(p[0], p[1], 2.05);
    el.style.display = pr.ok ? '' : 'none';
    el.style.transform = `translate3d(${pr.x.toFixed(1)}px,${pr.y.toFixed(1)}px,0) translate(-50%,-100%)`;
    const txt = (i === ms ? 'YOU · ' : '') + names[i];
    if (el.textContent !== txt) el.textContent = txt;
    el.classList.toggle('me', i === ms);
  });
  for (const [slot, b] of bubbles) {
    if (now > b.until || !world || !R) { b.el.remove(); bubbles.delete(slot); continue; }
    const p = world.players[slot], pr = R.project(p[0], p[1], 2.6);
    b.el.style.left = pr.x + 'px'; b.el.style.top = pr.y + 'px';
  }

  if (s) renderScreens(s);
  else setScreen('conn', `<div class="scrim"></div><div class="panel"><h2>${ws && ws.readyState === 1 ? 'LOADING' : 'CONNECTING'}…</h2></div>`);

  // spectator footer
  let foot = '';
  if (s && s.rp === 'match' && ms >= 0 && s.ph === 'kickoff' && !s.so) foot = `YOU ATTACK ${attackArrow(ms, s.sw)}`;
  if (s && s.so && s.rp === 'match' && ms >= 0) foot = 'SOLO PRACTICE · R brings the ball to you';
  if (s && s.rp === 'match' && ms < 0 && room && !replaying) {
    const me = room.members.find(m => m.id === myId), qi = room.queue.indexOf(myId);
    foot = me && me.sitting ? 'Spectating (sitting out)' : qi === 0 ? "Spectating · you're NEXT: winner stays on" : qi > 0 ? `Spectating · #${qi + 1} in line` : 'Spectating';
  }
  setText($('footer'), foot);
}

// read-only hook for debugging/automated tests
window.__ob = { cam: () => R && R.debugCam(), project: (x, y, h) => R && R.project(x, y, h), state: () => hist[hist.length - 1], slot: mySlot, renderTick: () => lastRenderTick, delay: () => clock.delay, ctrl: () => ctrl };

// ---------------- start ----------------
const route = location.pathname.match(/^\/r\/([A-Za-z0-9]{1,8})/);
if (route) enterRoom(route[1].toUpperCase()); else showHome();
fitStage();
