'use strict';
// Office Badminton — live browser check. Boots /badminton in headless Chrome/Edge, waits for the
// room and a bot match, plays a few rallies (move, charge, release, dash, lift), captures
// screenshots and reports every console error/warning the page produced.
//   node tools/badminton_check.js [url]
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const PORT = 9334;
const URL = process.argv[2] || 'http://127.0.0.1:3100/badminton/r/CHK1';
const OUT = path.join(os.tmpdir(), 'office-badminton-check');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findBrowser() {
  const candidates = [
    process.env.CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error('no Chrome/Edge found');
}
const httpJson = (method, p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 5000 }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 200))); } });
  });
  req.on('error', reject);
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.end();
});

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.logs = []; }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url, { perMessageDeflate: false });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', d => {
        const m = JSON.parse(d);
        if (m.id && this.pending.has(m.id)) {
          const [res, rej] = this.pending.get(m.id); this.pending.delete(m.id);
          if (m.error) rej(new Error(m.error.message)); else res(m.result);
          return;
        }
        if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
          this.logs.push(m.params.type + ': ' + m.params.args.map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(' '));
        } else if (m.method === 'Runtime.exceptionThrown') {
          this.logs.push('uncaught: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
        } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
          this.logs.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
        }
      });
    });
  }
  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, [resolve, reject]);
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async ev(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    return r.result.value;
  }
  key(code, vk, down) {
    return this.send('Input.dispatchKeyEvent', { type: down ? 'keyDown' : 'keyUp', code, key: code.replace(/^Key/, '').toLowerCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: down && code === 'Space' ? ' ' : undefined });
  }
  async shot(name) {
    const s = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(s.data, 'base64'));
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const exe = findBrowser();
  console.log('browser:', exe);
  const profile = path.join(os.tmpdir(), 'obm-check-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const proc = spawn(exe, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,760',
    '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });
  let cdp = null;
  try {
    let version = null;
    for (let i = 0; i < 80 && !version; i++) { try { version = await httpJson('GET', '/json/version'); } catch { await sleep(250); } }
    if (!version) throw new Error('browser never came up');
    console.log('browser:', version['Browser']);
    let target;
    try { target = await httpJson('PUT', '/json/new?about:blank'); }
    catch { target = await httpJson('GET', '/json/new?about:blank'); }
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('obm_name','CheckBot');}catch(e){}` });
    // first the plain page: it must show the home menu (not the room's connecting overlay)
    const homeUrl = URL.replace(/\/r\/[A-Za-z0-9]{1,8}\/?.*$/, '');
    console.log('navigating to', homeUrl);
    await cdp.send('Page.navigate', { url: homeUrl });
    let homeBooted = false;
    for (let i = 0; i < 160; i++) {
      homeBooted = await cdp.ev(`!!(window.__ob && document.getElementById('home') && !document.getElementById('boot'))`).catch(() => false);
      if (homeBooted) break;
      await sleep(500);
    }
    const homeState = await cdp.ev(`({
      home: !document.getElementById('home').classList.contains('hidden'),
      connecting: /CONNECTING/.test(document.getElementById('screen').textContent || ''),
      rooms: document.getElementById('roomsList').children.length,
      lb: document.getElementById('homeLb').children.length,
    })`).catch(e => ({ err: e.message }));
    console.log('home screen:', JSON.stringify(homeState));
    if (!homeBooted || !homeState.home) cdp.logs.push('assert: /badminton did not show the home menu');
    if (homeState.connecting) cdp.logs.push('assert: /badminton showed the room connecting overlay');
    await cdp.shot('home.png');

    console.log('navigating to', URL);
    await cdp.send('Page.navigate', { url: URL });

    // wait for the game to boot (the loading screen goes once the first frame is drawn)
    let booted = false;
    for (let i = 0; i < 160; i++) {
      try { booted = await cdp.ev(`!!(window.__ob && window.__ob.state && window.__ob.state())`); } catch { booted = false; }
      if (booted) break;
      await sleep(500);
    }
    console.log('booted:', booted);
    if (!booted) {
      const diag = await cdp.ev(`({
        href: location.href, ready: document.readyState, title: document.title,
        boot: !!document.getElementById('boot'), bootLbl: (document.querySelector('#boot .lbl') || {}).textContent || null,
        manifest: !!(window.__MANIFEST && window.__MANIFEST.build), build: (window.__MANIFEST || {}).build || null,
        bm: typeof window.BM, ob: !!window.__ob, log: (window.__obLog || []).slice(-10),
        err: (document.querySelector('#boot .err') || {}).textContent || null,
      })`).catch(e => ({ evalError: e.message }));
      console.log('diagnostics:', JSON.stringify(diag, null, 1));
      console.log('console so far:', JSON.stringify(cdp.logs.slice(-20), null, 1));
      throw new Error('game never finished booting');
    }
    const bootInfo = await cdp.ev(`({ tier: window.__ob.tier(), slot: window.__ob.slot(), rp: (window.__ob.state() || {}).rp })`);
    console.log('boot:', JSON.stringify(bootInfo));

    // wait for the practice match to start
    let rp = null;
    for (let i = 0; i < 60; i++) {
      rp = await cdp.ev(`(window.__ob.state() || {}).rp`);
      if (rp === 'match') break;
      await sleep(500);
    }
    console.log('room phase:', rp);
    await cdp.shot('start.png');

    // play: move about, charge and release shots, dash, lift; sample the state throughout
    const samples = [];
    const sample = async () => {
      const st = await cdp.ev(`(() => { const s = window.__ob.state(); if (!s || !s.p) return null; return { rp: s.rp, ph: s.ph, rc: s.rc, sc: s.sc, sv: s.sv, b: s.b, p: s.p, allFinite: [...s.b, ...s.p.flat()].every(Number.isFinite) }; })()`);
      if (st) samples.push(st);
      return st;
    };
    await sample();
    // camera-relative WASD: from the near end (slot 0, camera at x<0) W runs toward the net (+x)
    // and D runs to screen-right (+y). These are the directions a player actually sees.
    {
      const before = await cdp.ev(`(() => { const s = window.__ob.state(); return s && s.p ? [s.p[0][0], s.p[0][1]] : null; })()`);
      await cdp.key('KeyW', 87, true); await sleep(700); await cdp.key('KeyW', 87, false); await sleep(250);
      const afterW = await cdp.ev(`(() => { const s = window.__ob.state(); return s && s.p ? [s.p[0][0], s.p[0][1]] : null; })()`);
      await cdp.key('KeyD', 68, true); await sleep(700); await cdp.key('KeyD', 68, false); await sleep(250);
      const afterD = await cdp.ev(`(() => { const s = window.__ob.state(); return s && s.p ? [s.p[0][0], s.p[0][1]] : null; })()`);
      console.log('WASD check: W dx', (afterW[0] - before[0]).toFixed(2), '| D dy', (afterD[1] - afterW[1]).toFixed(2));
      if (!(afterW[0] > before[0] + 0.15)) cdp.logs.push(`assert: W did not run toward the net (dx ${(afterW[0] - before[0]).toFixed(2)})`);
      if (!(afterD[1] > afterW[1] + 0.15)) cdp.logs.push(`assert: D did not move screen-right (dy ${(afterD[1] - afterW[1]).toFixed(2)})`);
    }
    // input latency: how long after a key goes down the drawn player starts moving (own-player
    // prediction) versus the server's copy, and that the two agree again once the key is released
    {
      await cdp.ev(`(() => { const o = window.__lat = { t0: 0, draw: null, srv: null }; const ms = window.__ob.slot();
        const tick = now => { const w = window.__ob.world(), s = window.__ob.state(); if (o.t0 && w && s) {
          if (o.draw === null && Math.abs(w.players[ms][1] - o.w0) > 0.03) o.draw = now - o.t0;
          if (o.srv === null && Math.abs(s.p[ms][1] - o.s0) > 0.03) o.srv = now - o.t0; }
          if (!o.done) requestAnimationFrame(tick); };
        requestAnimationFrame(tick); return true; })()`);
      await sleep(300);
      await cdp.ev(`(() => { const o = window.__lat, ms = window.__ob.slot(); o.w0 = window.__ob.world().players[ms][1]; o.s0 = window.__ob.state().p[ms][1]; o.t0 = performance.now(); return true; })()`);
      await cdp.key('KeyA', 65, true); await sleep(600); await cdp.key('KeyA', 65, false); await sleep(900);
      const lat = await cdp.ev(`(() => { const o = window.__lat; o.done = true; const ms = window.__ob.slot(); const w = window.__ob.world().players[ms], s = window.__ob.state().p[ms];
        return { draw: o.draw && Math.round(o.draw), srv: o.srv && Math.round(o.srv), gap: +Math.hypot(w[0] - s[0], w[1] - s[1]).toFixed(2) }; })()`);
      console.log(`input latency: drawn player moves after ${lat.draw} ms, server after ${lat.srv} ms · settled gap ${lat.gap} m`);
      if (lat.draw == null || (lat.srv != null && lat.draw > lat.srv + 20)) cdp.logs.push(`assert: own player is not predicted (drawn ${lat.draw} ms vs server ${lat.srv} ms)`);
      if (lat.gap > 0.25) cdp.logs.push(`assert: prediction drifted ${lat.gap} m from the server`);
    }
    // the jump: F leaves the floor (the snapshot's height rises) and comes back down
    {
      await cdp.key('KeyF', 70, true); await sleep(60); await cdp.key('KeyF', 70, false);
      let top = 0;
      for (let k = 0; k < 14; k++) { await sleep(50); const z = await cdp.ev(`(() => { const s = window.__ob.state(); return s && s.p ? s.p[window.__ob.slot()][14] || 0 : 0; })()`); top = Math.max(top, z); }
      await sleep(400);
      const zEnd = await cdp.ev(`(() => { const s = window.__ob.state(); return s && s.p ? s.p[window.__ob.slot()][14] || 0 : 0; })()`);
      console.log(`jump: peak ${top.toFixed(2)} m, back down at ${zEnd.toFixed(2)} m`);
      if (!(top > 0.3)) cdp.logs.push(`assert: F did not jump (peak ${top})`);
      if (zEnd > 0.01) cdp.logs.push(`assert: the player did not land (z ${zEnd})`);
    }
    const keys = [['KeyD', 68, 900], ['KeyW', 87, 500], ['KeyA', 65, 700], ['KeyS', 83, 500], ['KeyD', 68, 600], ['KeyA', 65, 800]];
    for (const [code, vk, ms] of keys) {
      await cdp.key(code, vk, true); await sleep(ms); await cdp.key(code, vk, false); await sample();
    }
    // wait for our own serve and hit it: the human path over the network must connect
    let served = false;
    for (let i = 0; i < 40 && !served; i++) {
      const st = await cdp.ev(`(() => { const s = window.__ob.state(); return s ? { ph: s.ph, sv: s.sv, slot: window.__ob.slot() } : null; })()`);
      if (st && st.ph === 'serve' && st.sv === st.slot) {
        await cdp.key('Space', 32, true); await sleep(350);
        await cdp.shot('charge.png');
        await cdp.key('Space', 32, false);
        // software rendering can stall for seconds; the playback clock then needs a moment to catch
        // up to the tick the hit event belongs to, so poll rather than read once
        let hits = 0;
        for (let k = 0; k < 16 && hits < 1; k++) { await sleep(250); hits = await cdp.ev(`window.__ob.myHits`); }
        const diag = await cdp.ev(`(() => { const s = window.__ob.state(); return { myHits: window.__ob.myHits, hits: window.__ob.hits, events: window.__ob.events, lh: s && s.lh, ph: s && s.ph, sc: s && s.sc, delay: Math.round(window.__ob.delay()) }; })()`);
        console.log('own serve hit:', hits, JSON.stringify(diag));
        served = hits >= 1;
      }
      if (!served) await sleep(400);
    }
    if (!served) cdp.logs.push('assert: the human serve never connected');
    await sample();
    // dash and a lift shot
    await cdp.key('ShiftLeft', 16, true); await sleep(60); await cdp.key('ShiftLeft', 16, false); await sleep(500);
    await cdp.key('KeyE', 69, true); await cdp.key('Space', 32, true); await sleep(300); await cdp.key('Space', 32, false); await cdp.key('KeyE', 69, false);
    await sleep(1500);
    await sample();
    await cdp.shot('play.png');

    // let the bot serve a few times so a rally happens
    for (let i = 0; i < 14; i++) { await sleep(900); await sample(); }

    const last = samples[samples.length - 1];
    const finite = samples.every(s => s.allFinite);
    const moved = samples.some(s => s.p && s.p[0] && (Math.abs(s.p[0][0]) > 0.1 || Math.abs(s.p[0][1]) > 0.1));
    const phases = [...new Set(samples.map(s => s.ph))];
    const rallies = samples.map(s => s.rc).filter(v => typeof v === 'number');
    const maxRally = Math.max(0, ...rallies);
    const score = last && last.sc;
    console.log('phases seen:', phases.join(','), '| max rally counter:', maxRally, '| score:', JSON.stringify(score), '| finite:', finite, '| moved:', moved);
    console.log('page log:', JSON.stringify(await cdp.ev(`(window.__obLog || []).slice(-10)`)));
    console.log('renderer:', JSON.stringify(await cdp.ev(`window.__ob.stats ? window.__ob.stats() : null`)));
    console.log(cdp.logs.length ? 'CONSOLE ISSUES:' : 'console: clean');
    for (const l of cdp.logs.slice(0, 30)) console.log('  ' + l);
    if (!finite) { console.log('RESULT: FAIL (non-finite state)'); process.exitCode = 1; }
    else if (!moved) { console.log('RESULT: FAIL (player never moved)'); process.exitCode = 1; }
    else if (cdp.logs.some(l => l.startsWith('uncaught') || l.startsWith('error') || l.startsWith('assert'))) { console.log('RESULT: FAIL (errors or failed assertion)'); process.exitCode = 1; }
    else console.log('RESULT: PASS');
    console.log('screenshots in', OUT);
  } catch (e) {
    console.error('CHECK FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    try { if (cdp) cdp.ws.close(); } catch { }
    try { proc.kill(); } catch { }
  }
})();
