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
const BM = require('./shared/badminton.js');
const assets = require('./assets.js');

const PORT = +process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const BADMINTON_FILE = path.join(DATA_DIR, 'badminton.json');
const LOG_FILE = path.join(DATA_DIR, 'server.log');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { }
const fmt = x => { try { if (x && x.stack) return x.stack; if (typeof x === 'object') return JSON.stringify(x); return String(x); } catch { return String(x); } };
for (const k of ['log', 'warn', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { orig(...a); try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${k}] ${a.map(fmt).join(' ')}\n`); } catch { } };
}
function fatal(what, e) { console.error(`${what}:`, e); process.exit(1); }
process.on('uncaughtException', e => fatal('Uncaught exception', e));
process.on('unhandledRejection', e => fatal('Unhandled rejection', e));
const TICK_MS = 1000 / 60;
const OVER_T = 60 * 8, OVER_BOT_T = 60 * 5, PAUSE_T = 60 * 12;

// ---------------- persistent stats ----------------
// One table per sport: football keeps its own file and ELO, badminton has its own, so the two
// ladders never mix.
const FILES = { football: STATS_FILE, badminton: BADMINTON_FILE };
const DBS = {};
function loadDb(file) {
  const d = { players: {}, h2h: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    d.players = raw.players || {}; d.h2h = raw.h2h || {};
  } catch { /* first run */ }
  return d;
}
for (const s of Object.keys(FILES)) DBS[s] = loadDb(FILES[s]);
const saveTimers = {};
function saveDb(sport = 'football') {
  clearTimeout(saveTimers[sport]);
  saveTimers[sport] = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILES[sport] + '.tmp', JSON.stringify(DBS[sport], null, 1));
      fs.renameSync(FILES[sport] + '.tmp', FILES[sport]);
    } catch (e) { console.error('Could not save stats:', e.message); }
  }, 400);
}
const nkey = n => String(n).trim().toLowerCase();
function prof(sport, name) {
  const db = DBS[sport] || DBS.football, k = nkey(name);
  if (!db.players[k]) db.players[k] = { name, rating: 1000, w: 0, l: 0, gf: 0, ga: 0, perfect: 0, shots: 0, tackles: 0, bestStreak: 0, games: 0 };
  db.players[k].name = name;
  return db.players[k];
}
const ratingOf = (sport, name) => ((DBS[sport] || DBS.football).players[nkey(name)] || { rating: 1000 }).rating;
function h2hKey(a, b) { const ka = nkey(a), kb = nkey(b); return { k: ka < kb ? ka + '|' + kb : kb + '|' + ka, flip: ka > kb }; }
function h2hGet(sport, a, b) { const { k, flip } = h2hKey(a, b); const r = (DBS[sport] || DBS.football).h2h[k] || [0, 0]; return flip ? [r[1], r[0]] : [r[0], r[1]]; }
function h2hAdd(sport, winner, loser) { const db = DBS[sport] || DBS.football, { k, flip } = h2hKey(winner, loser); const r = db.h2h[k] || (db.h2h[k] = [0, 0]); r[flip ? 1 : 0]++; }
function leaderboard(sport = 'football') {
  return Object.values((DBS[sport] || DBS.football).players).filter(p => p.games > 0).sort((a, b) => b.rating - a.rating).slice(0, 25)
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
const blankInput = () => ({ u: 0, d: 0, l: 0, r: 0, k: false, kp: 0, kc: null, dc: 0, dv: 0, sp: false, jp: 0, rb: 0, sh: false, kn: 0, ax: 0, ay: 0, lob: false });
// non-human slots: 'bot' (practice opponent) and 'none' (solo practice, no opponent)
const isAI = id => id === 'bot' || id === 'none';
const sportOf = v => (v === 'badminton' ? 'badminton' : 'football');
// badminton practice-bot difficulty, chosen by each player (Settings)
const LEVEL_NAMES = { easy: 'Easy', normal: 'Normal', hard: 'Hard', pro: 'Pro' };
const levelOf = v => (Object.prototype.hasOwnProperty.call(LEVEL_NAMES, v) ? v : 'normal');

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while ([...rooms.keys()].some(k => k.endsWith(':' + c)));
  return c;
}
function getRoom(code, sport = 'football') {
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'LOBBY';
  const key = sportOf(sport) + ':' + code;
  let r = rooms.get(key);
  if (!r) { r = sportOf(sport) === 'badminton' ? new BadmintonRoom(code) : new Room(code); rooms.set(key, r); }
  return r;
}
function roomList(sport = 'football') {
  return [...rooms.values()].filter(r => r.sport === sport && r.online() > 0).map(r => ({
    code: r.code, players: r.online(),
    names: [...r.members.values()].filter(m => m.connected).map(m => m.name).slice(0, 6),
    live: (r.phase === 'match' || r.phase === 'prematch') && !r.botMatch,
  }));
}
function lbChanged(sport = 'football') { const msg = JSON.stringify({ t: 'lb', list: leaderboard(sport) }); for (const r of rooms.values()) if (r.sport === sport) r.sendRaw(msg); }

class Room {
  constructor(code, sport = 'football') {
    Object.assign(this, {
      code, sport, members: new Map(), slots: [null, null], queue: [], phase: 'waiting', phaseT: 0,
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
      Object.assign(m, { ws, connected: true, goneT: 0, name, needSync: true, practice: hello.practice === 'solo' ? 'solo' : 'bot', level: levelOf(hello.level) });
      this.toast(`${m.name} is back`);
    } else {
      m = { id: ++nextId, token: String(hello.token || crypto.randomUUID()).slice(0, 64), name, ws, connected: true, sitting: false, input: blankInput(), goneT: 0, emoteAt: 0, practice: hello.practice === 'solo' ? 'solo' : 'bot', level: levelOf(hello.level) };
      this.members.set(m.id, m);
      this.toast(`${m.name} joined`);
    }
    ws.member = m; ws.room = this;
    ws.send(JSON.stringify({ t: 'welcome', id: m.id, code: this.code }));
    ws.send(JSON.stringify({ t: 'lb', list: leaderboard(this.sport) }));
    if (this.matchInfo) ws.send(JSON.stringify(this.matchInfo));
    if (this.result) ws.send(JSON.stringify(this.result));
    this.dirty = true;
  }

  leave(m) {
    if (!m.connected) return;
    m.connected = false; m.ws = null; m.goneT = 0;
    m.input = Object.assign(blankInput(), { kp: m.input.kp, dc: m.input.dc, dv: m.input.dv, jp: m.input.jp, sw: m.input.sw });
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
        const m2 = v => (Number.isFinite(v) ? Math.max(-20, Math.min(20, v)) : 0);
        m.input = { u: !!msg.u, d: !!msg.d, l: !!msg.l, r: !!msg.r, k: !!msg.k, kp: n(msg.kp), kc: Number.isFinite(msg.kc) ? msg.kc | 0 : null, dc: n(msg.dc), dv: n(msg.dv), sp: !!msg.sp, jp: n(msg.jp), as: !!msg.as, ax: f(msg.ax), ay: f(msg.ay), rb: n(msg.rb), lob: !!msg.lob, sh: !!msg.sh, kn: n(msg.kn),
          // badminton trackpad controls: the sim runs the legs and the swing; tx/ty is the aimed spot
          ez: !!msg.ez, am: !!msg.am, tx: m2(msg.tx), ty: m2(msg.ty),
          // badminton swipe controls: a swipe counter, its grade, intensity, lift, line and the tick seen; magnetic steering
          sw: n(msg.sw), sg: n(msg.sg), si: f(msg.si), sd: !!msg.sd, sl: f(msg.sl), svt: Number.isFinite(msg.svt) ? +msg.svt : null, swm: !!msg.swm, mg: !!msg.mg,
          // badminton arcade (keyboard) controls: on them, and the length a press asked for (stick back..forward)
          arc: !!msg.arc, sz: f(msg.sz) };
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
      case 'level': {
        if (this.sport !== 'badminton') break;
        // the practice bot's difficulty: kept per player, and applied to a bot match in play at once
        m.level = levelOf(msg.v);
        if (this.botMatch && this.slots.includes(m.id) && this.sim) { this.applyLevel(m.level); this.toast(`Bot difficulty: ${LEVEL_NAMES[m.level]}`); }
        break;
      }
      case 'pause': {
        // Esc in a bot match: the whole match holds (nobody else is waiting on it). A real match is
        // never paused by one side.
        if (this.sport !== 'badminton' || !this.botMatch || !this.slots.includes(m.id) || !this.sim) break;
        if (msg.v && !this.userPause && (this.phase === 'match' || this.phase === 'prematch')) {
          this.userPause = { from: this.phase, t: this.phaseT }; this.phase = 'paused'; this.dirty = true;
        } else if (!msg.v && this.userPause) this.resumeUser();
        break;
      }
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

  // badminton only: the difficulty the human in a bot match asked for, Esc pausing a bot match
  humanLevel() { const id = this.slots.find(x => x !== null && !isAI(x)); return levelOf((this.members.get(id) || {}).level); }
  applyLevel(level) {
    this.sim.skill = BM.BOT_LEVELS[levelOf(level)];
    if (this.matchInfo) { this.matchInfo.level = levelOf(level); this.send(this.matchInfo); }
  }
  // back from an Esc pause: where it was, with a beat to get the hands back on the keys
  resumeUser() {
    const u = this.userPause; if (!u) return;
    this.userPause = null; this.phase = u.from; this.phaseT = u.t; this.dirty = true;
  }
  // an Esc pause holds until it is lifted, unless the bot match itself has to end
  heldByUser() {
    if (!this.userPause) return false;
    if (this.humansAvailable() >= 2) { this.userPause = null; this.abort('A challenger appeared. Real match!'); }
    else if (!this.available(this.slots.find(id => !isAI(id)))) { this.userPause = null; this.abort(); }
    return true;
  }

  tryStart() {
    for (let i = 0; i < 2; i++) if (!this.available(this.slots[i])) this.slots[i] = null;
    this.refreshQueue();
    for (let i = 0; i < 2; i++) if (this.slots[i] === null && this.queue.length) this.slots[i] = this.queue.shift();
    const n = this.slots.filter(x => x !== null).length;
    this.dirty = true;
    if (n === 0) { this.sim = null; this.matchInfo = null; this.phase = 'waiting'; return; }
    if (n === 1) {
      const hid = this.slots.find(x => x !== null);
      const solo = this.sport === 'football' && (this.members.get(hid) || {}).practice === 'solo';
      if (solo) this.slots = [hid, 'none']; // solo practice: the human is always slot 0
      else this.slots[this.slots.indexOf(null)] = 'bot';
      this.startMatch(true, solo);
    } else this.startMatch(false, false);
  }

  startMatch(bot, solo) {
    const names = this.slots.map(id => this.nameOf(id));
    this.sim = OB.createSim(this.tick, { solo, feet: names.map(OB.strongFoot) });
    this.botMatch = bot; this.solo = solo; this.result = null;
    this.phase = 'prematch'; this.phaseT = solo ? 50 : bot ? 90 : 60 * 4;
    const sameName = nkey(names[0]) === nkey(names[1]);
    this.matchInfo = {
      t: 'match', bot, solo, slots: this.slots.slice(), names,
      ratings: this.slots.map((id, i) => isAI(id) ? null : Math.round(ratingOf(this.sport, names[i]))),
      h2h: bot || sameName ? null : h2hGet(this.sport, names[0], names[1]),
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
      const pr = names.map(n => prof(this.sport, n));
      const W = pr[w], L = pr[1 - w];
      const expected = 1 / (1 + Math.pow(10, (L.rating - W.rating) / 400));
      const d = Math.max(1, Math.round(32 * (1 - expected)));
      W.rating += d; L.rating -= d; W.w++; L.l++;
      pr.forEach((p, i) => {
        const st = s.players[i].st;
        p.games++; p.gf += s.score[i]; p.ga += s.score[1 - i];
        p.perfect += st.perfect; p.shots += st.shots; p.tackles += st.tackles;
      });
      h2hAdd(this.sport, names[w], names[1 - w]);
      h2h = h2hGet(this.sport, names[0], names[1]);
      const wid = this.slots[w];
      this.streak = this.streak.id === wid ? { id: wid, n: this.streak.n + 1 } : { id: wid, n: 1 };
      W.bestStreak = Math.max(W.bestStreak || 0, this.streak.n);
      elo = [w === 0 ? d : -d, w === 1 ? d : -d];
      ratings = pr.map(p => Math.round(p.rating));
      if (this.streak.n >= 2) streak = { name: names[w], n: this.streak.n };
      saveDb(this.sport); lbChanged(this.sport);
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
    this.sim = null; this.result = null; this.matchInfo = null; this.userPause = null;
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
        members: [...this.members.values()].map(m => ({ id: m.id, name: m.name, connected: m.connected, sitting: m.sitting, rating: Math.round(ratingOf(this.sport, m.name)) })),
      });
    }
    if (!this.sim) { if (this.tick % 6 === 0) this.send({ t: 's', k: this.tick, rp: this.phase }); return; }
    const st = OB.netState(this.sim);
    st.t = 's'; st.k = this.tick; st.rp = this.phase; st.rt = this.phaseT;
    if (this.sim.events.length) { st.ev = this.sim.events; this.sim.events = []; }
    this.sendRaw(JSON.stringify(st));
  }
}

// ---------------- badminton room ----------------
// Same room machinery (members, queue, winner stays on), a different game underneath: the shuttle
// sim in shared/badminton.js, its own phases, its own stats table.
class BadmintonRoom extends Room {
  constructor(code) { super(code, 'badminton'); }

  inputs() { return this.slots.map((id, i) => id === 'bot' ? BM.botInput(this.sim, i) : id === 'none' ? blankInput() : ((this.members.get(id) || {}).input || blankInput())); }

  startMatch(bot) {
    const names = this.slots.map(id => this.nameOf(id));
    this.sim = BM.createSim(this.tick, { botSkill: BM.BOT_LEVELS[this.humanLevel()], ai: this.slots.map(id => isAI(id)) });
    this.botMatch = bot; this.solo = false; this.result = null; this.userPause = null;
    this.phase = 'prematch'; this.phaseT = BM.C.PRE_T; // the sim's own countdown: ready, then serve
    const sameName = nkey(names[0]) === nkey(names[1]);
    this.matchInfo = {
      t: 'match', bot, solo: false, slots: this.slots.slice(), names,
      level: bot ? this.humanLevel() : null,
      ratings: this.slots.map((id, i) => isAI(id) ? null : Math.round(ratingOf('badminton', names[i]))),
      h2h: bot || sameName ? null : h2hGet('badminton', names[0], names[1]),
      streak: this.slots.includes(this.streak.id) && this.streak.n >= 1 ? { slot: this.slots.indexOf(this.streak.id), n: this.streak.n } : null,
    };
    this.send(this.matchInfo);
  }

  finish(w, forfeit) {
    const s = this.sim;
    this.phase = 'over'; this.phaseT = this.botMatch ? 60 * 5 : BM.C.OVER_T;
    if (s.phase !== 'over') { s.winner = w; BM.setPhase(s, 'over'); }
    const names = this.slots.map(id => this.nameOf(id));
    let elo = null, ratings = null, h2h = null, streak = null;
    const rated = !this.botMatch && nkey(names[0]) !== nkey(names[1]) && !forfeit;
    if (rated) {
      const pr = names.map(n => prof('badminton', n));
      const W = pr[w], L = pr[1 - w];
      const expected = 1 / (1 + Math.pow(10, (L.rating - W.rating) / 400));
      const d = Math.max(1, Math.round(32 * (1 - expected)));
      W.rating += d; L.rating -= d; W.w++; L.l++;
      pr.forEach((p, i) => {
        const st = s.players[i].st;
        p.games++; p.gf += s.score[i]; p.ga += s.score[1 - i];
        p.perfect += st.perfects; p.shots += st.smashes; p.tackles += st.dives;
      });
      h2hAdd('badminton', names[w], names[1 - w]);
      h2h = h2hGet('badminton', names[0], names[1]);
      const wid = this.slots[w];
      this.streak = this.streak.id === wid ? { id: wid, n: this.streak.n + 1 } : { id: wid, n: 1 };
      W.bestStreak = Math.max(W.bestStreak || 0, this.streak.n);
      elo = [w === 0 ? d : -d, w === 1 ? d : -d];
      ratings = pr.map(p => Math.round(p.rating));
      if (this.streak.n >= 2) streak = { name: names[w], n: this.streak.n };
      saveDb('badminton'); lbChanged('badminton');
      if (this.streak.n >= 3) this.toast(`🏸 ${names[w]} is on a ${this.streak.n}-win streak. Someone stop them!`);
    }
    this.result = {
      t: 'result', winner: w, forfeit, score: s.score.slice(), names, bot: this.botMatch, rated,
      stats: s.players.map(p => Object.assign({}, p.st)), elo, ratings, h2h, streak,
    };
    this.send(this.result);
    this.dirty = true;
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
        BM.stepSim(this.sim, this.inputs());
        if (--this.phaseT <= 0) this.phase = 'match';
        break;
      case 'match':
        if (this.botMatch && (this.humansAvailable() >= 2 || !this.available(this.slots.find(id => !isAI(id))))) {
          this.abort(this.humansAvailable() >= 2 ? 'A challenger appeared. Real match!' : null); break;
        }
        BM.stepSim(this.sim, this.inputs());
        if (this.sim.phase === 'over') this.finish(this.sim.winner, false);
        break;
      case 'paused':
        if (this.heldByUser()) break;
        if (humanSlotsOk()) { this.phase = 'match'; this.toast('Resuming…'); break; }
        if (--this.phaseT <= 0) {
          const i = this.slots.findIndex(id => (this.members.get(id) || {}).connected);
          if (i >= 0) { this.toast(`${this.nameOf(this.slots[1 - i])} didn't come back. Win by forfeit.`); this.finish(i, true); }
          else this.abort();
        }
        break;
      case 'over': {
        BM.stepSim(this.sim, this.inputs());
        this.phaseT--;
        if (this.botMatch && this.humansAvailable() >= 2) { this.rotate(); break; }
        const humans = [0, 1].filter(i => !isAI(this.slots[i]) && (this.members.get(this.slots[i]) || {}).connected);
        const allReady = humans.length > 0 && humans.every(i => this.sim.ready[i]);
        if (this.phaseT <= 0 || (allReady && this.phaseT < (this.botMatch ? 60 * 5 : BM.C.OVER_T) - 90)) this.rotate();
        break;
      }
    }
  }

  broadcast() {
    if (this.dirty) {
      this.dirty = false;
      this.send({
        t: 'room', code: this.code, phase: this.phase, slots: this.slots, queue: this.queue, streak: this.streak,
        members: [...this.members.values()].map(m => ({ id: m.id, name: m.name, connected: m.connected, sitting: m.sitting, rating: Math.round(ratingOf(this.sport, m.name)) })),
      });
    }
    if (!this.sim) { if (this.tick % 6 === 0) this.send({ t: 's', k: this.tick, rp: this.phase }); return; }
    const st = BM.netState(this.sim);
    st.t = 's'; st.k = this.tick; st.rp = this.phase; st.rt = this.phaseT;
    if (this.userPause) st.up = 1;
    if (this.sim.events.length) { st.ev = this.sim.events; this.sim.events = []; }
    this.sendRaw(JSON.stringify(st));
  }
}

// ---------------- HTTP ----------------
// Game files are content-addressed (see assets.js): each URL names exactly one version of a file,
// so it is sent once and kept by the browser for good. The page itself is always revalidated
// (a cheap 304 when nothing changed), because it carries the manifest that points at the files.
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.webmanifest': 'application/manifest+json' };
const IMMUTABLE = 'public, max-age=31536000, immutable', REVALIDATE = 'no-cache';
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }); res.end(body);
}
// one file version: ETag = its hash; compressed when the browser accepts it and it pays
async function sendFile(req, res, f, cacheControl) {
  const type = MIME[path.extname(f.abs)] || 'application/octet-stream';
  const accept = String(req.headers['accept-encoding'] || '');
  const enc = !assets.COMPRESSIBLE.has(path.extname(f.abs)) ? null : /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
  const body = enc ? await assets.encoded(f, enc) : null;
  const etag = `"${f.hash}${body ? '-' + enc : ''}"`;
  const head = { 'Content-Type': type, 'Cache-Control': cacheControl, ETag: etag, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); return res.end(); }
  if (body) head['Content-Encoding'] = enc;
  const out = body || f.buf;
  head['Content-Length'] = out.length;
  res.writeHead(200, head);
  res.end(req.method === 'HEAD' ? undefined : out);
}
// index.html with this build's manifest, import map, stylesheet and loader written into it
const esc = s => JSON.stringify(s).replace(/</g, '\\u003c');
function page(req, res, kind = 'football') {
  const g = assets.GAMES[kind] || assets.GAMES.football;
  const m = assets.manifest(kind), tpl = assets.file(g.page);
  const { importmap, ...client } = m;
  const head = [
    `<link rel="stylesheet" href="${m.style}">`,
    `<script type="importmap">${esc(importmap)}</script>`,
    `<script>window.__MANIFEST = ${esc(client)};</script>`,
    // the whole module graph starts downloading as the page is parsed, in parallel
    ...m.modules.map(x => `<link rel="modulepreload" href="${x.url}">`),
    `<script defer src="${m.script.url}"></script>`,
    `<script type="module" src="${m.loader}"></script>`,
  ].join('\n');
  const html = Buffer.from(tpl.buf.toString('utf8').replace('<!--BOOT-->', head));
  const f = { abs: tpl.abs, buf: html, size: html.length, hash: crypto.createHash('sha256').update(html).digest('hex').slice(0, 16), enc: {} };
  return sendFile(req, res, f, REVALIDATE);
}

// a device's graphics report (client.js report()): shown in this window and kept in data/diag.log
function diag(req, res) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 64 * 1024) req.destroy(); });
  req.on('end', () => {
    send(res, 204, '');
    let d; try { d = JSON.parse(body); } catch { return; }
    const who = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const t = d.data || {};
    if (d.kind === 'gesturelab') { const c = t.counts || {}; console.log(`  [gesture lab] ${who}: finger ${t.fingerHz || '?'} Hz, two-finger ${t.twoFingerHz || '?'} Hz, ${Object.entries(c).map(([k, v]) => k + ' ' + v).join(', ')}`); }
    else if (d.kind === 'perf') console.log(`  [perf] ${who} ${d.tier} "${d.gpu}": ${t.fps} fps (target ${t.target} ms), p95 ${t.p95} ms, missed ${t.missed}%, js ${t.js} ms (players ${t.players}, ball ${t.ball}, world ${t.world}, gl ${t.submit}), gpu ${t.gpu} ms, ${t.size} @ ${t.pr}x, scale ${t.scale}, level ${t.level}, ${t.calls} calls`);
    else console.log(`  [diag] ${who} ${d.kind}: tier ${d.tier}, gpu "${d.gpu}", pitch green ${t.base ? t.base.green : '?'}${t.noShadow ? `, without shadows ${t.noShadow.green}` : ''} , textures ${t.srgb ? t.srgb.mode + " (" + t.srgb.native + "/" + t.srgb.nomip + "/" + t.srgb.shader + ")" : "?"} -> ${t.fix || 'ok'}`);
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(path.join(DATA_DIR, 'diag.log'), JSON.stringify({ at: new Date().toISOString(), from: who, ...d }) + '\n'); } catch { }
  });
}

const server = http.createServer((req, res) => {
  let p, url;
  try { url = new URL(req.url, 'http://x'); p = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request', 'text/plain'); }
  const qSport = sportOf(url.searchParams.get('sport'));
  if (p === '/api/info') return send(res, 200, JSON.stringify({ port: PORT, ips: lanIps().map(i => i.address) }));
  if (p === '/api/rooms') return send(res, 200, JSON.stringify(roomList(qSport)));
  if (p === '/api/leaderboard') return send(res, 200, JSON.stringify(leaderboard(qSport)));
  if (p === '/api/new') return send(res, 200, JSON.stringify({ code: newCode() }));
  if (p === '/api/build') return send(res, 200, JSON.stringify({ build: assets.manifest().build }));
  if (p === '/api/diag' && req.method === 'POST') return diag(req, res);
  if (p === '/' || /^\/r\/[A-Za-z0-9]{1,8}\/?$/.test(p)) return page(req, res, 'football').catch(e => { console.error(e); send(res, 500, 'Server error', 'text/plain'); });
  // (/badminton/anim: the animation player, the same page)
  if (p === '/badminton' || p === '/badminton/anim' || /^\/badminton\/r\/[A-Za-z0-9]{1,8}\/?$/.test(p)) return page(req, res, 'badminton').catch(e => { console.error(e); send(res, 500, 'Server error', 'text/plain'); });
  const abs = assets.resolveUrl(p);
  if (abs) return sendFile(req, res, assets.file(abs), IMMUTABLE).catch(() => send(res, 404, 'Not found', 'text/plain'));
  if (/^\/(app|asset|vendor)\//.test(p)) return send(res, 404, 'Not found (the game has been updated: reload)', 'text/plain');
  // anything else under public/ (demo.html, the raw model files): plain, revalidated each time
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  let file; try { file = assets.file(f); } catch { return send(res, 404, 'Not found', 'text/plain'); }
  sendFile(req, res, file, REVALIDATE).catch(() => send(res, 404, 'Not found', 'text/plain'));
});

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false, maxPayload: 8 * 1024 });
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  try { ws._socket.setNoDelay(true); } catch { }
  const q = new URL(req.url, 'http://x').searchParams;
  const code = q.get('room'), sport = sportOf(q.get('sport'));
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', data => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello' && !ws.member) return getRoom(code, sport).join(ws, msg);
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
  assets.manifest('football'); assets.manifest('badminton'); // hash and compress now, not on the first visitor's time
  const ips = lanIps();
  const main = ips[0] ? `http://${ips[0].address}:${PORT}` : `http://localhost:${PORT}`;
  console.log('\n  ⚽  OFFICE BALL server is running\n');
  console.log(`  Share this with teammates:  ${main}`);
  ips.slice(1).forEach(i => console.log(`  (other network: ${i.name})   http://${i.address}:${PORT}`));
  console.log(`  On this PC:                 http://localhost:${PORT}`);
  console.log(`  Badminton:                  ${main}/badminton\n`);
  console.log('  If Windows asks about the firewall, click "Allow" (Private networks).');
  console.log('  Keep this window open while you play. Ctrl+C to stop.\n');
  if (process.argv.includes('--open')) {
    const url = `http://localhost:${PORT}`;
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => { });
  }
});
