'use strict';
// Office Badminton — motion test. Boots the game in headless Chrome/Edge, hands the athletes to the
// motion lab (public/badminton/motionlab.js) and runs 88 scripted movement cases through the real
// rig: every direction and speed, starts, stops, reversals, zig-zags, corners, circles, rapid input
// flips and noise, charging on the move, jumps, dives and the get-up, both court sides, hit-stop,
// frame-time spikes and broken snapshot rows. Each case is judged on realism and robustness (see
// LIMITS) and a few are rendered as contact sheets into the temp dir.
//   node tools/motion_test.js [--url http://127.0.0.1:3000/badminton/r/MOVE] [--only substr] [--probe] [--noshots]
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const PORT = 9336;
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
const URL = opt('url') || 'http://127.0.0.1:3000/badminton/r/MOVE';
const OUT = path.join(os.tmpdir(), 'office-badminton-motion');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- the judgement
const D = Math.PI / 180;
const LIMITS = {
  yawRate: 12,          // rad/s, body turn (a quick pivot is ~10)
  yawRateDive: 26,      // rad/s, while diving / getting up
  backChest: 112 * D,   // moving backward, the chest never turns further from the net than this
  skate: 0.03,          // m, a planted foot's ball joint wandering while it is down
  pen: 0.005,           // m, a sole or knee point below the floor
  clear: 0.01,          // m, a body part closer to the floor than its thickness
  pelvisMin: 0.45, pelvisMax: 1.12, // m, pelvis height on the feet
  head: 32,             // deg, mean head-to-shuttle error
  pop: 0.12,            // m per frame, the pelvis leaving the sim's position
  cross: 3,             // frames, feet crossed in a chassé
  moonwalk: 8,          // frames (>2.5 m/s), travelling backward relative to the hips: no more than one
                        // pivot through the net-facing position (~0.13 s) when a run swings behind the body
};

// ---------------------------------------------------------------- the 88 cases
// dir: 0 = toward the net, 90 = the player's right (racket side), 180 = back, -90 = left.
// start: [distance from the net, right of centre]. Modes (footwork.js): ready step run sprint
// shuffle cross back lunge crouch jump land dive slide getup.
const FWD = ['step', 'run', 'sprint', 'cross'];
const ALL_GROUND = ['step', 'run', 'sprint', 'cross', 'shuffle', 'back', 'ready'];
function classOf(d) { const a = Math.abs(((d + 540) % 360) - 180); return a <= 30 ? 'fwd' : a < 62 ? 'diag' : a <= 118 ? 'lat' : a < 150 ? 'bdiag' : 'back'; }
function allowFor(d, speed) {
  const k = classOf(d);
  if (k === 'fwd') return FWD;
  if (k === 'diag') return [...FWD, 'shuffle'];
  if (k === 'lat') return speed === 'walk' ? ['shuffle'] : ['shuffle', 'cross', 'run', 'sprint'];
  return ['back'];
}
// body turn (theta, deg from the net, + to the right) a real player shows for this run
function thetaFor(d, speed) {
  const k = classOf(d), r = ((d + 540) % 360) - 180; // signed, + right
  if (k === 'back') return [40, 112];
  if (k === 'bdiag') return r > 0 ? [35, 112] : [-112, 112];
  if (k === 'lat') return speed === 'walk' ? (r > 0 ? [-5, 35] : [-35, 5]) : (r > 0 ? [0, 80] : [-80, 0]);
  if (k === 'fwd') return [-35, 35];
  return r > 0 ? [0, 70] : [-70, 0];
}
function startFor(d, len) { return [+(4.6 + len * 0.5 * Math.cos(d * D)).toFixed(2), +(-len * 0.5 * Math.sin(d * D)).toFixed(2)]; }
const cases = [];
const dirs16 = Array.from({ length: 16 }, (_, i) => i * 22.5 - 180 + 22.5).map(d => +(((d + 540) % 360) - 180).toFixed(1));
// 1-16 run in 16 directions (slot 0)
for (const d of dirs16) cases.push({ name: `run ${d}`, slot: 0, start: startFor(d, 6), dur: 1.4, seq: [{ t0: 0, t1: 0.8, dir: d, mag: 1 }],
  expect: [{ t0: 0.3, t1: 0.8, allow: allowFor(d, 'run'), frac: 0.6 }, { t0: 0.35, t1: 0.8, theta: thetaFor(d, 'run'), frac: 0.7 }, { t0: 1.25, t1: 1.4, allow: ['ready', 'step', 'shuffle', 'back', 'cross'], frac: 0.8 }] });
// 17-32 walk in 16 directions (slot 1: the far side, mirrored)
for (const d of dirs16) cases.push({ name: `walk ${d} s1`, slot: 1, start: startFor(d, 3), dur: 1.7, seq: [{ t0: 0, t1: 1.2, dir: d, mag: 0.3 }],
  expect: [{ t0: 0.3, t1: 1.2, allow: allowFor(d, 'walk'), frac: 0.6 }, { t0: 0.35, t1: 1.2, theta: thetaFor(d, 'walk'), frac: 0.7 }] });
// 33-40 sprint (Shift) in 8 directions
for (let i = 0; i < 8; i++) { const d = i * 45 - 135; cases.push({ name: `sprint ${d}`, slot: i % 2, start: startFor(d, 6.5), dur: 1.3, seq: [{ t0: 0, t1: 0.7, dir: d, mag: 1, sp: 1 }],
  expect: [{ t0: 0.3, t1: 0.7, allow: allowFor(d, 'sprint'), frac: 0.6 }, { t0: 0.35, t1: 0.7, theta: thetaFor(d, 'sprint'), frac: 0.6 }] }); }
// 41-48 a single tap step in 8 directions
for (let i = 0; i < 8; i++) { const d = i * 45 - 180; cases.push({ name: `tap ${d}`, slot: (i + 1) % 2, start: [4.5, 0], dur: 1.0, seq: [{ t0: 0.05, t1: 0.13, dir: d, mag: 1 }],
  expect: [{ t0: 0.75, t1: 1.0, allow: ['ready'], frac: 0.9 }] }); }
// 49 standing still (with split steps as the opponent strikes), 50 running with a noisy stick
cases.push({ name: 'stand still + split steps', slot: 0, start: [4.5, 0], dur: 2, seq: [], split: [0.8, 1.5], expect: [{ t0: 0, t1: 2, allow: ['ready'], frac: 1 }, { t0: 0, t1: 2, theta: [-18, 18], frac: 1 }] });
cases.push({ name: 'noisy stick', slot: 0, start: [4.5, -2.5], dur: 1.2, seq: [{ t0: 0, t1: 0.8, dir: 90, mag: 0.8, noise: 70, noiseMag: 0.5 }], expect: [{ t0: 0.3, t1: 0.8, allow: ['shuffle', 'cross', 'step', 'run'], frac: 0.7 }] });
// 51-54 to each corner and back to base
for (const [nm, d, st] of [['corner net-fh', 45, [5, -1.5]], ['corner net-bh', -45, [5, 1.5]], ['corner rear-fh', 135, [3.2, -1.5]], ['corner rear-bh', -135, [3.2, 1.5]]])
  cases.push({ name: nm, slot: 0, start: st, dur: 2.0, seq: [{ t0: 0, t1: 0.6, dir: d, mag: 1 }, { t0: 0.75, t1: 1.35, dir: d + 180, mag: 1 }],
    expect: [{ t0: 0.25, t1: 0.6, allow: allowFor(d, 'run'), frac: 0.6 }, { t0: 1.0, t1: 1.35, allow: allowFor(d + 180, 'run'), frac: 0.5 }] });
// 55-56 circles
cases.push({ name: 'circle cw', slot: 0, start: [4.8, -1.6], dur: 2.6, seq: [{ t0: 0, t1: 2.4, dir: 0, mag: 0.6, spin: 150 }] });
cases.push({ name: 'circle ccw s1', slot: 1, start: [4.8, 1.6], dur: 2.6, seq: [{ t0: 0, t1: 2.4, dir: 0, mag: 0.6, spin: -150 }] });
// 57-58 zig-zags
cases.push({ name: 'zigzag lateral', slot: 0, start: [4.5, 0], dur: 2.2, seq: [{ t0: 0, t1: 2.0, dir: 90, mag: 1, flip: 21 }] });
cases.push({ name: 'zigzag diagonal', slot: 0, start: [7.5, 0], dur: 2.0, seq: [0, 1, 2, 3, 4, 5].map(i => ({ t0: i * 0.28, t1: (i + 1) * 0.28, dir: i % 2 ? -40 : 40, mag: 1 })) });
// 59-60 rapid direction flips (edge cases)
cases.push({ name: 'flip every 3 frames', slot: 0, start: [4.5, 0], dur: 1.6, seq: [{ t0: 0, t1: 1.4, dir: 90, mag: 1, flip: 3 }] });
cases.push({ name: 'random dir every frame', slot: 1, start: [4.5, 0], dur: 1.6, seq: [{ t0: 0, t1: 1.4, dir: 0, mag: 1, rand: 1 }] });
// 61-64 reversals, 65 start-stop
cases.push({ name: 'reverse fwd->back', slot: 0, start: [6.5, 0], dur: 1.8, seq: [{ t0: 0, t1: 0.5, dir: 0, mag: 1 }, { t0: 0.5, t1: 1.3, dir: 180, mag: 1 }], expect: [{ t0: 0.85, t1: 1.3, allow: ['back'], frac: 0.6 }] });
cases.push({ name: 'reverse back->fwd', slot: 1, start: [2.5, 0], dur: 1.8, seq: [{ t0: 0, t1: 0.6, dir: 180, mag: 1 }, { t0: 0.6, t1: 1.2, dir: 0, mag: 1 }], expect: [{ t0: 0.3, t1: 0.6, allow: ['back'], frac: 0.6 }] });
cases.push({ name: 'reverse left->right', slot: 0, start: [4.5, 1.5], dur: 1.8, seq: [{ t0: 0, t1: 0.45, dir: -90, mag: 1 }, { t0: 0.45, t1: 1.2, dir: 90, mag: 1 }] });
cases.push({ name: 'reverse diag rear-fh->net-bh', slot: 0, start: [4.0, 0], dur: 1.8, seq: [{ t0: 0, t1: 0.5, dir: 135, mag: 1 }, { t0: 0.5, t1: 1.1, dir: -45, mag: 1 }] });
cases.push({ name: 'start-stop x4', slot: 1, start: [4.5, -2.5], dur: 2.2, seq: [0, 1, 2, 3].map(i => ({ t0: i * 0.5, t1: i * 0.5 + 0.22, dir: 90, mag: 1 })) });
// 66-67 moving while charging a shot
cases.push({ name: 'charge fh on the move', slot: 0, start: [4.5, -2], dur: 1.4, chargeKind: 'fh', seq: [{ t0: 0, t1: 1.0, dir: 90, mag: 1, charge: 1 }] });
cases.push({ name: 'charge overhead going back', slot: 0, start: [2.8, 0], dur: 1.4, chargeKind: 'over', seq: [{ t0: 0, t1: 1.0, dir: 170, mag: 1, charge: 1 }], expect: [{ t0: 0.4, t1: 1.0, allow: ['back'], frac: 0.6 }] });
// 68-70 jumps
cases.push({ name: 'jump in place', slot: 0, start: [4.5, 0], dur: 1.5, ev: [{ t: 0.2, jump: 1 }], expect: [{ t0: 0.35, t1: 0.8, allow: ['jump'], frac: 0.8 }, { t0: 1.3, t1: 1.5, allow: ['ready'], frac: 0.9 }] });
cases.push({ name: 'jump moving back', slot: 1, start: [2.5, 0], dur: 1.8, seq: [{ t0: 0, t1: 1.3, dir: 180, mag: 1 }], ev: [{ t: 0.45, jump: 1 }] });
cases.push({ name: 'jump moving lateral', slot: 0, start: [4.5, -2.5], dur: 1.8, seq: [{ t0: 0, t1: 1.2, dir: 90, mag: 1 }], ev: [{ t: 0.35, jump: 1 }] });
// 71-78 dives in 8 directions and the get-up
for (let i = 0; i < 8; i++) {
  const d = i * 45 - 180;
  cases.push({ name: `dive ${d}`, slot: i % 2, start: startFor(d, 4.5), dur: 1.9, ball: 'near', seq: [{ t0: 0, t1: 0.3, dir: d, mag: 1 }], ev: [{ t: 0.28, dive: 1 }],
    expect: [{ t0: 0.32, t1: 0.55, allow: ['dive'], frac: 0.9 }, { t0: 0.7, t1: 0.85, allow: ['slide', 'getup'], frac: 0.9 }, { t0: 1.75, t1: 1.9, allow: ALL_GROUND, frac: 0.9 }] });
}
// 79-80 sprint then dive
cases.push({ name: 'sprint->dive fwd', slot: 0, start: [8, 0], dur: 2.0, ball: 'near', seq: [{ t0: 0, t1: 0.45, dir: 0, mag: 1, sp: 1 }], ev: [{ t: 0.42, dive: 1 }], expect: [{ t0: 0.46, t1: 0.7, allow: ['dive'], frac: 0.9 }] });
cases.push({ name: 'sprint->dive lateral', slot: 1, start: [4.5, -3.5], dur: 2.0, ball: 'near', seq: [{ t0: 0, t1: 0.45, dir: 90, mag: 1, sp: 1 }], ev: [{ t: 0.42, dive: 1 }], expect: [{ t0: 0.46, t1: 0.7, allow: ['dive'], frac: 0.9 }] });
// 81-82 dives into the boundary
cases.push({ name: 'dive at sideline', slot: 0, start: [4.5, 4.4], dur: 1.8, ball: 'near', seq: [{ t0: 0, t1: 0.2, dir: 90, mag: 1 }], ev: [{ t: 0.15, dive: 1 }] });
cases.push({ name: 'dive at back line', slot: 1, start: [9.6, 0], dur: 1.8, ball: 'near', seq: [{ t0: 0, t1: 0.2, dir: 180, mag: 1 }], ev: [{ t: 0.15, dive: 1 }] });
// 83-85 the far side (slot 1) mirrors
cases.push({ name: 'rear-fh run s1', slot: 1, start: [2.8, -1.5], dur: 1.4, seq: [{ t0: 0, t1: 0.7, dir: 135, mag: 1 }], expect: [{ t0: 0.3, t1: 0.7, allow: ['back'], frac: 0.6 }, { t0: 0.35, t1: 0.7, theta: [35, 112], frac: 0.7 }] });
cases.push({ name: 'shuffle left s1', slot: 1, start: [4.5, 2.2], dur: 1.4, seq: [{ t0: 0, t1: 0.9, dir: -90, mag: 0.45 }], expect: [{ t0: 0.3, t1: 0.9, allow: ['shuffle'], frac: 0.6 }] });
cases.push({ name: 'dive fwd-right s1', slot: 1, start: [5.5, -1], dur: 1.9, ball: 'near', seq: [{ t0: 0, t1: 0.3, dir: 45, mag: 1 }], ev: [{ t: 0.28, dive: 1 }] });
// 86-88 hit-stop, frame-time spikes, broken rows
cases.push({ name: 'hit-stop frozen frames', slot: 0, start: [4.5, -2], dur: 1.4, seq: [{ t0: 0, t1: 1.0, dir: 90, mag: 1 }], frozen: [[0.35, 0.5], [0.7, 0.72]] });
cases.push({ name: 'dt spikes', slot: 1, start: [4.8, -1.6], dur: 2.0, seq: [{ t0: 0, t1: 1.8, dir: 0, mag: 0.8, spin: 170 }], spikes: [[0.3, 0.5], [0.9, 1.2], [1.3, 0.25], [1.5, 0.0]] });
cases.push({ name: 'broken rows', slot: 0, start: [4.5, 0], dur: 1.6, seq: [{ t0: 0, t1: 1.2, dir: 120, mag: 0.8 }],
  corrupt: [{ t: 0, len: 1.6, v: 'short', n: 19 }, { t: 0.3, i: 2, v: 'nan' }, { t: 0.5, i: 0, v: 'undef' }, { t: 0.7, i: 14, v: 'inf' }, { t: 0.9, v: 'null' }, { t: 1.0, i: 20, v: 'nan', len: 0.2 }, { t: 1.1, i: 8, v: 'nan' }] });

// contact sheets: which cases, at which times
const SHOTS = {
  'run -180': [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95, 1.2],
  'run 90': [0.05, 0.2, 0.35, 0.5, 0.65, 0.8],
  'run -135': [0.05, 0.2, 0.35, 0.5, 0.65, 0.8],
  'run 22.5': [0.05, 0.2, 0.35, 0.5, 0.65, 0.8],
  'walk 90 s1': [0.1, 0.25, 0.4, 0.55, 0.7, 0.85],
  'walk -180 s1': [0.1, 0.3, 0.5, 0.7, 0.9, 1.1],
  'sprint 45': [0.05, 0.2, 0.35, 0.5, 0.65, 0.9],
  'dive 0': [0.28, 0.34, 0.42, 0.52, 0.62, 0.75, 0.95, 1.15, 1.3, 1.45, 1.6, 1.8],
  'dive 90': [0.28, 0.36, 0.46, 0.6, 0.8, 1.05, 1.3, 1.5, 1.7, 1.85],
  'dive -135': [0.28, 0.36, 0.46, 0.6, 0.8, 1.05, 1.3, 1.5, 1.7, 1.85],
  'corner rear-bh': [0.1, 0.3, 0.5, 0.8, 1.0, 1.2],
  'jump moving back': [0.3, 0.45, 0.55, 0.7, 0.85, 1.0],
};

// ---------------------------------------------------------------- the browser
function findBrowser() {
  const c = [process.env.CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  for (const x of c) if (x && fs.existsSync(x)) return x;
  throw new Error('no Chrome/Edge found');
}
const httpJson = (method, p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 5000 }, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 200))); } });
  });
  req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end();
});
class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.logs = []; }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url, { perMessageDeflate: false, maxPayload: 1 << 30 });
      this.ws.on('open', resolve); this.ws.on('error', reject);
      this.ws.on('message', d => {
        const m = JSON.parse(d);
        if (m.id && this.pending.has(m.id)) { const [res, rej] = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); return; }
        if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) this.logs.push(m.params.type + ': ' + m.params.args.map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(' '));
        else if (m.method === 'Runtime.exceptionThrown') this.logs.push('uncaught: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
      });
    });
  }
  send(method, params) { return new Promise((resolve, reject) => { const id = ++this.id; this.pending.set(id, [resolve, reject]); this.ws.send(JSON.stringify({ id, method, params: params || {} })); }); }
  async ev(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 600000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    return r.result.value;
  }
}

function judge(m) {
  const bad = [];
  if (m.error) bad.push('threw: ' + m.error.split('\n')[0]);
  if (m.nan) bad.push(`NaN x${m.nan} ${JSON.stringify(m.nanAt)}`);
  if (m.maxYawRate > LIMITS.yawRate) bad.push(`yaw rate ${m.maxYawRate.toFixed(1)}`);
  if (m.maxYawRateDive > LIMITS.yawRateDive) bad.push(`dive yaw rate ${m.maxYawRateDive.toFixed(1)}`);
  if (m.backChest > LIMITS.backChest) bad.push(`chest ${(m.backChest / D).toFixed(0)}deg from net going back`);
  if (m.skate > LIMITS.skate) bad.push(`skate ${(m.skate * 100).toFixed(1)}cm @${JSON.stringify(m.skateAt)}`);
  if (m.pen > LIMITS.pen) bad.push(`penetration ${(m.pen * 1000).toFixed(1)}mm @${JSON.stringify(m.penAt)}`);
  if (m.clear > LIMITS.clear) bad.push(`body into floor ${(m.clear * 100).toFixed(1)}cm`);
  if (m.pelvisMin < LIMITS.pelvisMin && m.pelvisMin < 9) bad.push(`pelvis low ${m.pelvisMin.toFixed(2)} @${JSON.stringify(m.pelvisMinAt)}`);
  if (m.pelvisMax > LIMITS.pelvisMax) bad.push(`pelvis high ${m.pelvisMax.toFixed(2)} @${JSON.stringify(m.pelvisMaxAt)}`);
  if (m.kneeBad) bad.push(`knee backwards x${m.kneeBad}`);
  if (m.headErr > LIMITS.head) bad.push(`head off shuttle ${m.headErr.toFixed(0)}deg`);
  if (m.pop > LIMITS.pop) bad.push(`pop ${m.pop.toFixed(2)}m`);
  if (m.cross > LIMITS.cross) bad.push(`feet crossed in chasse x${m.cross}`);
  if ((m.moonwalk || 0) > LIMITS.moonwalk) bad.push(`moonwalk x${m.moonwalk}`);
  for (const w of m.windows || []) if (w.frac < w.need) bad.push(`${w.allow ? 'mode ' + w.allow.join('|') : 'theta ' + w.theta.join('..')} ${w.t0}-${w.t1}s ${(w.frac * 100).toFixed(0)}%<${(w.need * 100).toFixed(0)}%`);
  return bad;
}

(async () => {
  if (opt('list')) { cases.forEach((c, i) => console.log(i + 1, c.name)); return; }
  fs.mkdirSync(OUT, { recursive: true });
  const profile = path.join(os.tmpdir(), 'obm-motion-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const proc = spawn(findBrowser(), ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,760', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let cdp = null;
  try {
    let version = null;
    for (let i = 0; i < 80 && !version; i++) { try { version = await httpJson('GET', '/json/version'); } catch { await sleep(250); } }
    let target; try { target = await httpJson('PUT', '/json/new?about:blank'); } catch { target = await httpJson('GET', '/json/new?about:blank'); }
    cdp = new CDP(target.webSocketDebuggerUrl); await cdp.open();
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('obm_name','MotionLab');}catch(e){}` });
    await cdp.send('Page.navigate', { url: URL });
    let ok = false;
    for (let i = 0; i < 240 && !ok; i++) { ok = await cdp.ev(`!!(window.__ob && window.__ob.R && window.__ob.R() && window.__ob.R().motionLab)`).catch(() => false); if (!ok) await sleep(500); }
    if (!ok) throw new Error('page never booted (or has no motion lab)');
    if (opt('probe')) {
      const r = await cdp.ev(`window.__ob.R().motionLab({ op: 'probe' })`);
      console.log(JSON.stringify(r, null, 1));
      return;
    }
    if (opt('live')) {
      // the real game: a practice match against the bot, driven with the keyboard (camera-relative
      // WASD from the near end, Shift to sprint, a double tap of Shift to dive); both athletes sampled
      const key = (code, vk, down) => cdp.send('Input.dispatchKeyEvent', { type: down ? 'keyDown' : 'keyUp', code, key: code.startsWith('Key') ? code.slice(3).toLowerCase() : code === 'ShiftLeft' ? 'Shift' : code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      for (let i = 0; i < 60; i++) { if (await cdp.ev(`(window.__ob.state() || {}).rp`) === 'match') break; await sleep(500); }
      const seen = [{}, {}]; let bad = 0, n = 0;
      const sampleRaw = () => cdp.ev(`window.__obAth()`).catch(() => null);
      let floorSeen = 0;
      const sample = async () => { const r = await sampleRaw(); if (!r) return null; r.forEach((fr, i) => fr.forEach(x => { seen[i][x.g] = (seen[i][x.g] || 0) + 1; if (!x.ok) bad++; if (x.p20 > 0) floorSeen++; })); return null; };
      // a per-frame recorder in the page (the CDP round trip is slower than a frame under software GL)
      await cdp.ev(`(() => { const rec = window.__obRec = [[], []]; const R = window.__ob.R();
        const tick = () => { const A = R.debugAthletes(), w = window.__ob.world(); A.forEach((a, i) => rec[i].push({ g: a.gait, ok: Number.isFinite(a.yaw), p20: w && w.players[i] ? w.players[i][20] : null })); requestAnimationFrame(tick); };
        requestAnimationFrame(tick); window.__obAth = () => { const out = rec.map(r => r.splice(0)); return out; }; return true; })()`);
      const plan = [['KeyS', 83, 700], ['KeyD', 68, 600], ['KeyA', 65, 900], ['KeyW', 87, 600], ['KeyS', 83, 400, 'KeyD', 68], ['KeyA', 65, 600, 'KeyW', 87]];
      let shot = 0;
      for (const [c1, v1, ms, c2, v2] of plan) {
        await key(c1, v1, true); if (c2) await key(c2, v2, true);
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const a = await sample(); if (a) a.forEach((x, i) => { seen[i][x.gait] = (seen[i][x.gait] || 0) + 1; if (!x.ok) bad++; }); n++; await sleep(60); }
        await cdp.send('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFileSync(path.join(OUT, `live_${shot++}.png`), Buffer.from(r.data, 'base64')));
        await key(c1, v1, false); if (c2) await key(c2, v2, false);
      }
      // sprint, then a dive (double tap of Shift) along the run
      await key('KeyD', 68, true); await key('ShiftLeft', 16, true); await sleep(500);
      await key('ShiftLeft', 16, false); await sleep(80); for (let i = 0; i < 2; i++) { await key('ShiftLeft', 16, true); await sleep(50); await key('ShiftLeft', 16, false); await sleep(50); }
      for (let i = 0; i < 12; i++) { const a = await sample(); if (a) a.forEach((x, j) => { seen[j][x.gait] = (seen[j][x.gait] || 0) + 1; if (!x.ok) bad++; }); if (i === 2 || i === 5 || i === 9) await cdp.send('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFileSync(path.join(OUT, `live_${shot++}.png`), Buffer.from(r.data, 'base64'))); await sleep(80); }
      await key('KeyD', 68, false);
      for (let i = 0; i < 40; i++) { const a = await sample(); if (a) a.forEach((x, j) => { seen[j][x.gait] = (seen[j][x.gait] || 0) + 1; if (!x.ok) bad++; }); await sleep(100); }
      console.log('live gaits seen, you:', JSON.stringify(seen[0]), '| bot:', JSON.stringify(seen[1]), '| non-finite yaw frames:', bad, '| frames with floor ticks (p[20]):', floorSeen, '| screenshots', OUT + path.sep + 'live_*.png');
      const errs = cdp.logs.filter(l => /uncaught|error/.test(l)); errs.slice(0, 10).forEach(l => console.log('  ' + l));
      process.exitCode = bad || errs.length ? 1 : 0;
      return;
    }
    const only = opt('only');
    const list = cases.filter(c => !only || only.split(',').some(o => c.name.includes(o)));
    if (opt('trace')) list.forEach(c => { c.trace = true; });
    console.log(`motion lab: ${list.length} of ${cases.length} cases`);
    const rows = [], shots = [];
    const t0 = Date.now();
    for (let i = 0; i < list.length; i += 6) {
      const chunk = list.slice(i, i + 6);
      const sh = opt('noshots') ? {} : Object.fromEntries(chunk.filter(c => SHOTS[c.name]).map(c => [c.name, SHOTS[c.name]]));
      const r = await cdp.ev(`window.__ob.R().motionLab(${JSON.stringify({ op: 'cases', cases: chunk, shots: sh, hold: true })})`);
      for (const m of r.results) rows.push(m);
      for (const [n, png] of Object.entries(r.sheets || {})) {
        const f = path.join(OUT, 'sheet_' + n.replace(/[^a-z0-9-]+/gi, '_') + '.png');
        fs.writeFileSync(f, Buffer.from(png.split(',')[1], 'base64')); shots.push(f);
      }
    }
    // the table
    const pad = (s, n) => String(s).padEnd(n).slice(0, n);
    console.log(pad('#', 3) + pad('case', 30) + pad('modes', 34) + pad('yawR', 6) + pad('back', 5) + pad('skate', 6) + pad('pen', 5) + pad('head', 5) + pad('pelv', 10) + 'result');
    let fails = 0;
    rows.forEach((m, i) => {
      const bad = judge(m); if (bad.length) fails++;
      const modes = Object.entries(m.modes).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}${Math.round(v / m.frames * 100)}`).join(' ');
      console.log(pad(i + 1, 3) + pad(m.name, 30) + pad(modes, 34) + pad(m.maxYawRate.toFixed(1), 6) + pad(m.backChest ? Math.round(m.backChest / D) : '-', 5) + pad((m.skate * 100).toFixed(1), 6)
        + pad((m.pen * 1000).toFixed(1), 5) + pad(m.headErr.toFixed(0), 5) + pad(m.pelvisMin < 9 ? m.pelvisMin.toFixed(2) + '-' + m.pelvisMax.toFixed(2) : '-', 10) + (bad.length ? 'FAIL ' + bad.join('; ') : 'PASS'));
    });
    const worst = k => Math.max(...rows.map(m => m[k] || 0));
    console.log(`\n${rows.length - fails}/${rows.length} PASS in ${((Date.now() - t0) / 1000).toFixed(0)} s · worst: yaw rate ${worst('maxYawRate').toFixed(1)} rad/s, skate ${(worst('skate') * 100).toFixed(1)} cm, penetration ${(worst('pen') * 1000).toFixed(1)} mm, back-chest ${(worst('backChest') / D).toFixed(0)} deg, head ${worst('headErr').toFixed(0)} deg`);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(rows, null, opt('trace') ? 0 : 1));
    if (shots.length) console.log('contact sheets:\n  ' + shots.join('\n  '));
    const errs = cdp.logs.filter(l => /uncaught|error/.test(l));
    if (errs.length) { console.log('page errors:'); errs.slice(0, 10).forEach(l => console.log('  ' + l)); }
    process.exitCode = fails || errs.length ? 1 : 0;
  } catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
  finally { try { cdp && cdp.ws.close(); } catch { } try { proc.kill(); } catch { } }
})();
