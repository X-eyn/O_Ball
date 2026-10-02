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
  // the legs under the body (deg from the hip; pump: m, the hips' bounce within a stride). Steady
  // running and walking, and the moments around a hard start, stop or turn (a braking leg goes out
  // further, a driving one further back, and the knees give a little)
  legs: {
    steady: { behind: -35, ahead: 33, leg: 37, swing: 40, pump: 0.03 },
    trans: { behind: -45, ahead: 40, leg: 48, swing: 46, pump: 0.09 },
  },
  // (cases that break the clock or the data on purpose: the legs cannot follow a teleport)
  legsExempt: /^(dt spikes|broken rows|hit-stop frozen frames)$/,
};

// (the 88 cases and the contact-sheet moments: public/badminton/labcases.js)
let cases, SHOTS;
// the shared cases (an ES module: imported, its 'module type' warning silenced)
async function loadLab() {
  const ew = process.emitWarning;
  process.emitWarning = (w, ...a) => (String(w).includes('Module type') || (a[0] && a[0].code === 'MODULE_TYPELESS_PACKAGE_JSON') ? undefined : ew.call(process, w, ...a));
  try { return await import(require('url').pathToFileURL(path.join(__dirname, '..', 'public', 'badminton', 'labcases.js')).href); } finally { process.emitWarning = ew; }
}

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
  if (m.legs && !LIMITS.legsExempt.test(m.name)) for (const k of ['steady', 'trans']) {
    const g = m.legs[k], L = LIMITS.legs[k]; if (!g) continue;
    const out = [];
    if (g.behind < L.behind) out.push(`behind ${g.behind}`);
    for (const x of ['ahead', 'leg', 'swing', 'pump']) if (g[x] > L[x]) out.push(`${x} ${g[x]}`);
    if (out.length) bad.push(`legs ${k}: ${out.join(', ')}`);
  }
  for (const w of m.windows || []) if (w.frac < w.need) bad.push(`${w.allow ? 'mode ' + w.allow.join('|') : 'theta ' + w.theta.join('..')} ${w.t0}-${w.t1}s ${(w.frac * 100).toFixed(0)}%<${(w.need * 100).toFixed(0)}%`);
  return bad;
}

(async () => {
  ({ MOTION_CASES: cases, MOTION_SHOTS: SHOTS } = await loadLab());
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
    const lw = (k, x, f) => rows.reduce((w, m) => (m.legs && m.legs[k] && !LIMITS.legsExempt.test(m.name) ? f(w, m.legs[k][x]) : w), 0);
    console.log(`legs, worst steady: behind ${lw('steady', 'behind', Math.min)} ahead ${lw('steady', 'ahead', Math.max)} leg ${lw('steady', 'leg', Math.max)} swing ${lw('steady', 'swing', Math.max)} deg, pump ${(lw('steady', 'pump', Math.max) * 100).toFixed(1)} cm · around starts/stops: behind ${lw('trans', 'behind', Math.min)} ahead ${lw('trans', 'ahead', Math.max)} leg ${lw('trans', 'leg', Math.max)} swing ${lw('trans', 'swing', Math.max)} deg, pump ${(lw('trans', 'pump', Math.max) * 100).toFixed(1)} cm`);
    console.log(`\n${rows.length - fails}/${rows.length} PASS in ${((Date.now() - t0) / 1000).toFixed(0)} s · worst: yaw rate ${worst('maxYawRate').toFixed(1)} rad/s, skate ${(worst('skate') * 100).toFixed(1)} cm, penetration ${(worst('pen') * 1000).toFixed(1)} mm, back-chest ${(worst('backChest') / D).toFixed(0)} deg, head ${worst('headErr').toFixed(0)} deg`);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(rows, null, opt('trace') ? 0 : 1));
    if (shots.length) console.log('contact sheets:\n  ' + shots.join('\n  '));
    const errs = cdp.logs.filter(l => /uncaught|error/.test(l));
    if (errs.length) { console.log('page errors:'); errs.slice(0, 10).forEach(l => console.log('  ' + l)); }
    process.exitCode = fails || errs.length ? 1 : 0;
  } catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
  finally { try { cdp && cdp.ws.close(); } catch { } try { proc.kill(); } catch { } }
})();
