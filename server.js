'use strict';
// Office Ball — LAN game server. Run: node server.js  (then open the printed link)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const { WebSocketServer } = require('ws');
const OB = require('./shared/game.js');

const PORT = +process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const TICK_MS = 1000 / 60;
const OVER_T = 60 * 8, OVER_BOT_T = 60 * 5, PAUSE_T = 60 * 12;

// ---------------- persistent stats ----------------
let db = { players: {}, h2h: {} };
try {
  db = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  db.players = db.players || {}; db.h2h = db.h2h || {};
} catch { /* first run */ }
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATS_FILE + '.tmp', JSON.stringify(db, null, 1));
      fs.renameSync(STATS_FILE + '.tmp', STATS_FILE);
    } catch (e) { console.error('Could not save stats:', e.message); }
  }, 400);
}
const nkey = n => String(n).trim().toLowerCase();
function prof(name) {
  const k = nkey(name);
  if (!db.players[k]) db.players[k] = { name, rating: 1000, w: 0, l: 0, gf: 0, ga: 0, perfect: 0, shots: 0, tackles: 0, bestStreak: 0, games: 0 };
  db.players[k].name = name;
  return db.players[k];
}
const ratingOf = name => (db.players[nkey(name)] || { rating: 1000 }).rating;
function h2hKey(a, b) { const ka = nkey(a), kb = nkey(b); return { k: ka < kb ? ka + '|' + kb : kb + '|' + ka, flip: ka > kb }; }
function h2hGet(a, b) { const { k, flip } = h2hKey(a, b); const r = db.h2h[k] || [0, 0]; return flip ? [r[1], r[0]] : [r[0], r[1]]; }
function h2hAdd(winner, loser) { const { k, flip } = h2hKey(winner, loser); const r = db.h2h[k] || (db.h2h[k] = [0, 0]); r[flip ? 1 : 0]++; }
function leaderboard() {
  return Object.values(db.players).filter(p => p.games > 0).sort((a, b) => b.rating - a.rating).slice(0, 25)
    .map(p => ({ name: p.name, rating: Math.round(p.rating), w: p.w, l: p.l, gf: p.gf, ga: p.ga, perfect: p.perfect, shots: p.shots, tackles: p.tackles, bestStreak: p.bestStreak }));
}

// ---------------- network helpers ----------------
function lanIps() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal || a.address.startsWith('169.254.')) continue;
      const virtual = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|Docker|Loopback|Tailscale|ZeroTier|VPN|TAP|Npcap/i.test(name);
      let score = virtual ? 0 : 10;
      if (/^192\.168\./.test(a.address)) score += 3; else if (/^10\./.test(a.address)) score += 2; else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score += 1;
      if (/wi-?fi|wlan|wireless|ethernet/i.test(name)) score += 2;
      out.push({ name, address: a.address, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
const clean = n => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'Player';

// ---------------- rooms ----------------
const rooms = new Map();
let nextId = 0;
const blankInput = () => ({ u: 0, d: 0, l: 0, r: 0, k: false, kp: 0, kc: null, dc: 0, rb: 0 });
// non-human slots: 'bot' (practice opponent) and 'none' (solo practice, no opponent)
const isAI = id => id === 'bot' || id === 'none';

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(c));
  return c;
}
function getRoom(code) {
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'LOBBY';
  let r = rooms.get(code);
  if (!r) { r = new Room(code); rooms.set(code, r); }
  return r;
}
function roomList() {
  return [...rooms.values()].filter(r => r.online() > 0).map(r => ({
    code: r.code, players: r.online(),
    names: [...r.members.values()].filter(m => m.connected).map(m => m.name).slice(0, 6),
    live: (r.phase === 'match' || r.phase === 'prematch') && !r.botMatch,
  }));
}
function lbChanged() { const msg = JSON.stringify({ t: 'lb', list: leaderboard() }); for (const r of rooms.values()) r.sendRaw(msg); }

class Room {
  constructor(code) {
    Object.assign(this, {
      code, members: new Map(), slots: [null, null], queue: [], phase: 'waiting', phaseT: 0,
      sim: null, botMatch: false, streak: { id: null, n: 0 }, result: null, matchInfo: null,
      tick: 0, dirty: true, emptyT: 0, lastQueueKey: '',
    });
  }
  online() { let n = 0; for (const m of this.members.values()) if (m.connected) n++; return n; }
  sendRaw(s) { for (const m of this.members.values()) if (m.connected && m.ws && m.ws.readyState === 1 && m.ws.bufferedAmount < 512 * 1024) m.ws.send(s); }
  send(o) { this.sendRaw(JSON.stringify(o)); }
  toast(text) { this.send({ t: 'toast', text }); }
  available(id) { if (id === null || isAI(id)) return false; const m = this.members.get(id); return !!(m && m.connected && !m.sitting); }
  humansAvailable() { let n = 0; for (const m of this.members.values()) if (m.connected && !m.sitting) n++; return n; }
  nameOf(id) { return id === 'bot' ? 'BOT' : id === 'none' ? 'PRACTICE' : (this.members.get(id) || { name: '?' }).name; }

  join(ws, hello) {
    let m = [...this.members.values()].find(x => x.token === hello.token);
    const name = clean(hello.name);
    if (m) {
      if (m.ws && m.ws !== ws) { try { m.ws.close(4000, 'replaced'); } catch { } }
      Object.assign(m, { ws, connected: true, goneT: 0, name, needSync: true, practice: hello.practice === 'solo' ? 'solo' : 'bot' });
      this.toast(`${m.name} is back`);
    } else {
      m = { id: ++nextId, token: String(hello.token || crypto.randomUUID()).slice(0, 64), name, ws, connected: true, sitting: false, input: blankInput(), goneT: 0, emoteAt: 0, practice: hello.practice === 'solo' ? 'solo' : 'bot' };
      this.members.set(m.id, m);
      this.toast(`${m.name} joined`);
    }
    ws.member = m; ws.room = this;
    ws.send(JSON.stringify({ t: 'welcome', id: m.id, code: this.code }));
    ws.send(JSON.stringify({ t: 'lb', list: leaderboard() }));
    if (this.matchInfo) ws.send(JSON.stringify(this.matchInfo));
    if (this.result) ws.send(JSON.stringify(this.result));
    this.dirty = true;
  }

  leave(m) {
    if (!m.connected) return;
    m.connected = false; m.ws = null; m.goneT = 0;
    m.input = Object.assign(blankInput(), { kp: m.input.kp, dc: m.input.dc });
    this.dirty = true;
    const si = this.slots.indexOf(m.id);
    if (si >= 0 && !this.botMatch && this.phase === 'match') {
      this.phase = 'paused'; this.phaseT = PAUSE_T;
      this.toast(`${m.name} dropped — waiting for them to reconnect`);
    } else this.toast(`${m.name} left`);
  }

  onMessage(m, msg) {
    switch (msg.t) {
      case 'i': {
        const n = v => (Number.isFinite(v) ? v | 0 : 0);
        if (m.needSync) { m.needSync = false; const si = this.slots.indexOf(m.id); if (si >= 0 && this.sim) this.sim.players[si].init = false; }
        const f = v => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
        m.input = { u: !!msg.u, d: !!msg.d, l: !!msg.l, r: !!msg.r, k: !!msg.k, kp: n(msg.kp), kc: Number.isFinite(msg.kc) ? msg.kc | 0 : null, dc: n(msg.dc), ax: f(msg.ax), ay: f(msg.ay), rb: n(msg.rb), lob: !!msg.lob };
        break;
      }
      case 'emote': {
        const now = Date.now();
        if (now - m.emoteAt < 700) return;
        m.emoteAt = now;
        this.send({ t: 'emote', id: m.id, n: Math.max(0, Math.min(5, msg.n | 0)) });
        break;
      }
      case 'sit':
        m.sitting = !!msg.v; this.dirty = true;
        this.toast(m.sitting ? `${m.name} is sitting out` : `${m.name} joined the line`);
        break;
      case 'practice': {
        m.practice = msg.v === 'solo' ? 'solo' : 'bot';
        // switching while alone: restart the practice session in the new mode right away
        if (this.botMatch && this.slots.includes(m.id) && this.solo !== (m.practice === 'solo')) this.abort();
        break;
      }
      case 'name': {
        const n = clean(msg.name);
        if (n !== m.name) { this.toast(`${m.name} is now ${n}`); m.name = n; this.dirty = true; }
        break;
      }
      case 'ping':
        if (m.ws) m.ws.send(JSON.stringify({ t: 'pong', c: msg.c }));
        break;
    }
  }

  refreshQueue() {
    this.queue = this.queue.filter(id => this.available(id) && !this.slots.includes(id));
    for (const m of this.members.values()) if (this.available(m.id) && !this.slots.includes(m.id) && !this.queue.includes(m.id)) this.queue.push(m.id);
    const key = this.queue.join(',');
    if (key !== this.lastQueueKey) { this.lastQueueKey = key; this.dirty = true; }
  }

  inputs() { return this.slots.map((id, i) => id === 'bot' ? OB.botInput(this.sim, i) : id === 'none' ? blankInput() : ((this.members.get(id) || {}).input || blankInput())); }

  tryStart() {
    for (let i = 0; i < 2; i++) if (!this.available(this.slots[i])) this.slots[i] = null;
    this.refreshQueue();
    for (let i = 0; i < 2; i++) if (this.slots[i] === null && this.queue.length) this.slots[i] = this.queue.shift();
    const n = this.slots.filter(x => x !== null).length;
    this.dirty = true;
    if (n === 0) { this.sim = null; this.matchInfo = null; this.phase = 'waiting'; return; }
    if (n === 1) {
      const hid = this.slots.find(x => x !== null);
      const solo = (this.members.get(hid) || {}).practice === 'solo';
      if (solo) this.slots = [hid, 'none']; // solo practice: the human is always slot 0
      else this.slots[this.slots.indexOf(null)] = 'bot';
      this.startMatch(true, solo);
    } else this.startMatch(false, false);
  }

  startMatch(bot, solo) {
    this.sim = OB.createSim(this.tick, { solo });
    this.botMatch = bot; this.solo = solo; this.result = null;
    this.phase = 'prematch'; this.phaseT = solo ? 50 : bot ? 90 : 60 * 4;
    const names = this.slots.map(id => this.nameOf(id));
    const sameName = nkey(names[0]) === nkey(names[1]);
    this.matchInfo = {
      t: 'match', bot, solo, slots: this.slots.slice(), names,
      ratings: this.slots.map((id, i) => isAI(id) ? null : Math.round(ratingOf(names[i]))),
      h2h: bot || sameName ? null : h2hGet(names[0], names[1]),
      streak: this.slots.includes(this.streak.id) && this.streak.n >= 1 ? { slot: this.slots.indexOf(this.streak.id), n: this.streak.n } : null,
    };
    this.send(this.matchInfo);
  }

  finish(w, forfeit) {
    const s = this.sim;
    this.phase = 'over'; this.phaseT = this.botMatch ? OVER_BOT_T : OVER_T;
    if (s.phase !== 'over') { s.winner = w; OB.setPhase(s, 'over'); }
    const names = this.slots.map(id => this.nameOf(id));
    let elo = null, ratings = null, h2h = null, streak = null;
    // a forfeit within the first 20s of play is not rated (stops join-and-leave rating swings)
    const played = OB.C.MATCH_TICKS - s.time;
    const rated = !this.botMatch && nkey(names[0]) !== nkey(names[1]) && !(forfeit && played < 20 * 60 && !s.sd);
    if (rated) {
      const pr = names.map(prof);
      const W = pr[w], L = pr[1 - w];
      const expected = 1 / (1 + Math.pow(10, (L.rating - W.rating) / 400));
      const d = Math.max(1, Math.round(32 * (1 - expected)));
      W.rating += d; L.rating -= d; W.w++; L.l++;
      pr.forEach((p, i) => {
        const st = s.players[i].st;
        p.games++; p.gf += s.score[i]; p.ga += s.score[1 - i];
        p.perfect += st.perfect; p.shots += st.shots; p.tackles += st.tackles;
      });
      h2hAdd(names[w], names[1 - w]);
      h2h = h2hGet(names[0], names[1]);
      const wid = this.slots[w];
      this.streak = this.streak.id === wid ? { id: wid, n: this.streak.n + 1 } : { id: wid, n: 1 };
      W.bestStreak = Math.max(W.bestStreak || 0, this.streak.n);
      elo = [w === 0 ? d : -d, w === 1 ? d : -d];
      ratings = pr.map(p => Math.round(p.rating));
      if (this.streak.n >= 2) streak = { name: names[w], n: this.streak.n };
      saveDb(); lbChanged();
      if (this.streak.n >= 3) this.toast(`👑 ${names[w]} is on a ${this.streak.n}-win streak. Someone stop them!`);
    }
    this.result = {
      t: 'result', winner: w, forfeit, score: s.score.slice(), names, bot: this.botMatch, rated,
      stats: s.players.map(p => Object.assign({}, p.st)), elo, ratings, h2h, streak,
    };
    this.send(this.result);
    this.dirty = true;
  }

  rotate() {
    if (this.result && !this.botMatch) {
      const loser = this.slots[1 - this.result.winner];
      this.slots[1 - this.result.winner] = null;
      this.queue = this.queue.filter(id => id !== loser);
      this.queue.push(loser); // loser goes to the back of the line — winner stays on
    }
    this.slots = this.slots.map(id => isAI(id) ? null : id);
    this.sim = null; this.result = null; this.phase = 'waiting';
    this.tryStart();
  }

  abort(msg) {
    this.sim = null; this.result = null; this.matchInfo = null;
    this.slots = this.slots.map(id => isAI(id) ? null : id);
    this.phase = 'waiting';
    if (msg) this.toast(msg);
    this.tryStart();
  }

  step() {
    this.tick++;
    for (const [id, m] of this.members) {
      if (!m.connected && ++m.goneT > 60 * 60 && !this.slots.includes(id)) { this.members.delete(id); this.dirty = true; }
    }
    this.refreshQueue();
    if (this.sim) this.sim.tick = this.tick;
    const humanSlotsOk = () => this.slots.every(id => isAI(id) || (this.members.get(id) || {}).connected);

    switch (this.phase) {
      case 'waiting':
        if (this.humansAvailable() > 0) this.tryStart();
        break;
      case 'prematch':
        if (this.botMatch && this.humansAvailable() >= 2) { this.abort('A challenger appeared. Real match!'); break; }
        if (!humanSlotsOk() || (this.botMatch && !this.available(this.slots.find(id => !isAI(id))))) { this.abort(); break; }
        OB.syncInputs(this.sim, this.inputs());
        if (--this.phaseT <= 0) this.phase = 'match';
        break;
      case 'match':
        if (this.botMatch && (this.humansAvailable() >= 2 || !this.available(this.slots.find(id => !isAI(id))))) {
          this.abort(this.humansAvailable() >= 2 ? 'A challenger appeared. Real match!' : null); break;
        }
        OB.stepSim(this.sim, this.inputs());
        if (this.sim.phase === 'over') this.finish(this.sim.winner, false);
        break;
      case 'paused':
        if (humanSlotsOk()) { this.phase = 'match'; this.sim.freeze = 180; this.toast('Resuming in 3…'); break; }
        if (--this.phaseT <= 0) {
          const i = this.slots.findIndex(id => (this.members.get(id) || {}).connected);
          if (i >= 0) { this.toast(`${this.nameOf(this.slots[1 - i])} didn't come back. Win by forfeit.`); this.finish(i, true); }
          else this.abort();
        }
        break;
      case 'over': {
        OB.stepSim(this.sim, this.inputs());
        this.phaseT--;
        if (this.botMatch && this.humansAvailable() >= 2) { this.rotate(); break; }
        const humans = [0, 1].filter(i => !isAI(this.slots[i]) && (this.members.get(this.slots[i]) || {}).connected);
        const allReady = humans.length > 0 && humans.every(i => this.sim.ready[i]);
        if (this.phaseT <= 0 || (allReady && this.phaseT < (this.botMatch ? OVER_BOT_T : OVER_T) - 90)) this.rotate();
        break;
      }
    }
  }

  broadcast() {
    if (this.dirty) {
      this.dirty = false;
      this.send({
        t: 'room', code: this.code, phase: this.phase, slots: this.slots, queue: this.queue, streak: this.streak,
        members: [...this.members.values()].map(m => ({ id: m.id, name: m.name, connected: m.connected, sitting: m.sitting, rating: Math.round(ratingOf(m.name)) })),
      });
    }
    if (!this.sim) { if (this.tick % 6 === 0) this.send({ t: 's', k: this.tick, rp: this.phase }); return; }
    const st = OB.netState(this.sim);
    st.t = 's'; st.k = this.tick; st.rp = this.phase; st.rt = this.phaseT;
    if (this.sim.events.length) { st.ev = this.sim.events; this.sim.events = []; }
    this.sendRaw(JSON.stringify(st));
  }
}

// ---------------- HTTP ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary' };
const NODE_MODULES = path.join(__dirname, 'node_modules');
function send(res, code, body, type = 'application/json', cache = false) {
  // Content-Length lets the loading screen report true download progress
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': cache ? 'public, max-age=86400' : 'no-store' }); res.end(body);
}
function serveFile(res, f, cache = false) { fs.readFile(f, (e, d) => e ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, d, MIME[path.extname(f)] || 'application/octet-stream', cache)); }

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(res, 400, 'Bad request', 'text/plain'); }
  if (p === '/api/info') return send(res, 200, JSON.stringify({ port: PORT, ips: lanIps().map(i => i.address) }));
  if (p === '/api/rooms') return send(res, 200, JSON.stringify(roomList()));
  if (p === '/api/leaderboard') return send(res, 200, JSON.stringify(leaderboard()));
  if (p === '/api/new') return send(res, 200, JSON.stringify({ code: newCode() }));
  if (p === '/shared/game.js') return serveFile(res, path.join(__dirname, 'shared', 'game.js'));
  if (p === '/' || /^\/r\/[A-Za-z0-9]{1,8}\/?$/.test(p)) return serveFile(res, path.join(PUB, 'index.html'));
  if (p.startsWith('/vendor/')) { // three.js + fonts, served locally so the game works without internet
    const rel = p.slice(8);
    if (!/^(three\/(build|examples\/jsm)\/|@fontsource\/(teko|inter|barlow|barlow-condensed)\/)/.test(rel)) return send(res, 404, 'Not found', 'text/plain');
    const f = path.normalize(path.join(NODE_MODULES, rel));
    if (!f.startsWith(NODE_MODULES + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    return serveFile(res, f, true);
  }
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  serveFile(res, f);
});

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false, maxPayload: 8 * 1024 });
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  try { ws._socket.setNoDelay(true); } catch { }
  const code = new URL(req.url, 'http://x').searchParams.get('room');
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', data => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello' && !ws.member) return getRoom(code).join(ws, msg);
    if (ws.member && ws.member.ws === ws) ws.room.onMessage(ws.member, msg);
  });
  ws.on('close', () => { if (ws.member && ws.member.ws === ws) ws.room.leave(ws.member); });
  ws.on('error', () => { });
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; try { ws.ping(); } catch { }
  }
}, 4000);

// ---------------- fixed-rate game loop ----------------
// Windows timers are ~15.6ms granular, so we run on an accumulator: every wake-up
// advances however many 60Hz ticks are due, then broadcasts once. Clients interpolate by tick.
let nextTick = performance.now();
function loop() {
  const now = performance.now();
  let n = 0;
  while (now >= nextTick && n < 6) {
    for (const r of rooms.values()) r.step();
    nextTick += TICK_MS; n++;
  }
  if (now - nextTick > 250) nextTick = now; // long stall: don't try to catch up
  if (n > 0) {
    for (const [code, r] of rooms) {
      r.broadcast();
      if (r.online() === 0) { if (++r.emptyT > 10 * 60 * 60) rooms.delete(code); }
      else r.emptyT = 0;
    }
  }
  setTimeout(loop, 1);
}
loop();

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`\n  Port ${PORT} is already in use. Is Office Ball already running? Close it or set PORT=3001.\n`);
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, '0.0.0.0', () => {
  const ips = lanIps();
  const main = ips[0] ? `http://${ips[0].address}:${PORT}` : `http://localhost:${PORT}`;
  console.log('\n  ⚽  OFFICE BALL server is running\n');
  console.log(`  Share this with teammates:  ${main}`);
  ips.slice(1).forEach(i => console.log(`  (other network: ${i.name})   http://${i.address}:${PORT}`));
  console.log(`  On this PC:                 http://localhost:${PORT}\n`);
  console.log('  If Windows asks about the firewall, click "Allow" (Private networks).');
  console.log('  Keep this window open while you play. Ctrl+C to stop.\n');
  if (process.argv.includes('--open')) {
    const url = `http://localhost:${PORT}`;
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => { });
  }
});
