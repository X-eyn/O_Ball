'use strict';
// Office Badminton — live browser check. Boots /badminton in headless Chrome/Edge, waits for the
// room and a bot match, plays a few rallies on keyboard (arcade) controls (move; J hits and K plays
// soft, timed against the ring), then switches to swipe controls and plays on with two-finger swipes timed against the
// ring (one through Chrome's real input pipeline, the rest timed in the page), captures
// screenshots and reports every console error/warning the page produced.
//   node tools/badminton_check.js [url]
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const PORT = 9334;
const URL = process.argv[2] || 'http://127.0.0.1:3000/badminton/r/CHK1';
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
  // a real mouse press and release (a trackpad's tap-to-click is exactly this: no time held)
  async tap(x, y, button = 'left') {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
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
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('obm_name','CheckBot');localStorage.setItem('obm_ctrl','keyboard');}catch(e){}` });
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
    // keyboard (arcade) controls have no jump key: F must leave the player on the floor
    {
      await cdp.key('KeyF', 70, true); await sleep(60); await cdp.key('KeyF', 70, false);
      let top = 0;
      for (let k = 0; k < 14; k++) { await sleep(50); const z = await cdp.ev(`(() => { const s = window.__ob.state(); return s && s.p ? s.p[window.__ob.slot()][14] || 0 : 0; })()`); top = Math.max(top, z); }
      await sleep(400);
      const zEnd = await cdp.ev(`(() => { const s = window.__ob.state(); return s && s.p ? s.p[window.__ob.slot()][14] || 0 : 0; })()`);
      console.log(`F on keyboard controls: peak ${top.toFixed(2)} m (no jump key)`);
      if (top > 0.05) cdp.logs.push(`assert: F jumped on keyboard controls (peak ${top})`);
      void zEnd;
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
        await cdp.key('KeyJ', 74, true); await sleep(60);
        await cdp.key('KeyJ', 74, false);
        await cdp.shot('serve.png');
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
    // the arcade player, in the page: steers toward the contact spot (the magnet does the rest) and
    // presses J or K as the ring closes, with a human's scatter. Presses must be graded, reach the
    // server and become hits; a whiff must lock the racket.
    {
      const hits0 = await cdp.ev(`window.__ob.myHits`);
      await cdp.ev(`(() => {
        const T = window.__kbt = { n: 0, grades: [0, 0, 0, 0, 0], lastKey: '', keys: new Set(), ring: {} };
        const press = (code, down) => dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));
        T.timer = setInterval(() => {
          const s = window.__ob.state(), sw = window.__ob.swipe(), ms = window.__ob.slot();
          if (!s || ms < 0 || !s.p) return;
          const me = s.p[ms], b = s.b, want = new Set();
          const tg = window.BM.meetTarget({ tick: s.k, phase: s.ph, serveHold: !!s.hold, ball: { x: b[0], y: b[1], z: b[2], vx: b[3], vy: b[4], vz: b[5], last: s.lh } }, { i: ms, x: me[0], y: me[1] });
          if (tg) {
            const dx = tg.x - me[0], dy = tg.y - me[1], d = Math.hypot(dx, dy), side = ms === 1 ? 1 : -1;
            const fwd = dx * -side, right = dy * -side;
            if (d > 0.3) { if (fwd > 0.38 * d) want.add('KeyW'); if (fwd < -0.38 * d) want.add('KeyS'); if (right > 0.38 * d) want.add('KeyD'); if (right < -0.38 * d) want.add('KeyA'); }
          }
          for (const k of T.keys) if (!want.has(k)) { press(k, false); T.keys.delete(k); }
          for (const k of want) if (!T.keys.has(k)) { press(k, true); T.keys.add(k); }
          // the ring, per incoming shot: did it show, and did it ever blink off and back on before contact
          if (s.ph === 'rally' && s.lh >= 0 && s.lh !== ms) {
            const sk = s.lh + ':' + s.rc + ':' + s.sc.join('');
            const R = T.ring[sk] || (T.ring[sk] = { on: false, blinks: 0, prev: null });
            const has = sw.ideal != null && sw.ideal - performance.now() > 0;
            if (has) R.on = true;
            if (R.prev === false && has && R.on) R.blinks++;
            R.prev = has ? true : (R.on ? false : null);
          }
          const key = s.lh + ':' + s.rc + ':' + s.ph + ':' + s.sc.join('');
          if (key === T.lastKey) return;
          const serving = s.ph === 'serve' && s.sv === ms && s.hold;
          const tap = code => { press(code, true); press(code, false); const lp = window.__ob.lastPress; if (lp && !serving) T.grades[lp.g]++; };
          if (serving) { T.lastKey = key; setTimeout(() => tap(Math.random() < 0.5 ? 'KeyJ' : 'KeyK'), 300); return; }
          if (sw.ideal == null || s.lh === ms) return;
          const lead = sw.ideal - performance.now();
          if (lead > 120 || lead < -40) return;
          T.lastKey = key; T.n++;
          setTimeout(() => tap(Math.random() < 0.6 ? 'KeyJ' : 'KeyK'), Math.max(0, lead + (Math.random() * 2 - 1) * 40));
        }, 8);
        return true; })()`);
      const t0 = Date.now();
      let shot = false;
      let midShot = false, hitShot = false;
      while (Date.now() - t0 < 30000) {
        await sleep(midShot && hitShot ? 500 : 15);
        if (!shot && (await cdp.ev(`window.__kbt.n`)) >= 3) { await cdp.shot('play.png'); shot = true; }
        // the timing ring, mid-approach and on the moment
        if (!midShot || !hitShot) {
          const lead = await cdp.ev(`(() => { const i = window.__ob.swipe().ideal; return i == null ? null : i - performance.now(); })()`);
          if (lead != null && !midShot && lead > 200 && lead < 400) { await cdp.shot('ring_mid.png'); midShot = true; }
          else if (lead != null && !hitShot && lead > -40 && lead < 40) { await cdp.shot('ring_hit.png'); hitShot = true; }
        }
      }
      const T = await cdp.ev(`(() => { const T = window.__kbt; clearInterval(T.timer); for (const k of T.keys) dispatchEvent(new KeyboardEvent('keyup', { code: k, bubbles: true })); const rs = Object.values(T.ring); return { n: T.n, grades: T.grades, shots: rs.length, shown: rs.filter(r => r.on).length, blinky: rs.filter(r => r.blinks > 0).length }; })()`);
      const hits = (await cdp.ev(`window.__ob.myHits`)) - hits0;
      console.log(`keyboard: ${T.n} timed presses · grades perfect ${T.grades[0]}, great ${T.grades[1]}, good ${T.grades[2]}, early/late ${T.grades[3]}, miss ${T.grades[4]} -> ${hits} own hits`);
      console.log(`keyboard ring: ${T.shown}/${T.shots} incoming shots showed it · ${T.blinky} blinked`);
      if (T.blinky > 0) cdp.logs.push(`assert: the timing ring blinked on ${T.blinky} shots`);
      if (!(T.n >= 3 && hits >= 3)) cdp.logs.push(`assert: timed key presses did not become hits (${T.n} presses, ${hits} hits)`);
      if (T.grades[0] + T.grades[1] + T.grades[2] < Math.ceil(T.n * 0.5)) cdp.logs.push(`assert: well-timed presses were not graded well (${JSON.stringify(T.grades)})`);
      await sample();
    }

    // swipe controls: picked in the menu. First a serve swiped through Chrome's real input pipeline
    // (scroll events as a trackpad sends them); then a player in the page who swipes as the ring
    // closes (its fastest moment on the ring, with a human's scatter), at a mix of strengths, now
    // and then a downward lift. The swipes must be graded, reach the server, and become hits.
    {
      // (a fresh room, so the keyboard match's state does not carry over)
      await cdp.ev(`(() => { localStorage.setItem('obm_ctrl', 'swipe'); return true; })()`);
      const swUrl = URL.replace(/\/r\/[A-Za-z0-9]{1,8}/, '/r/SW' + String(Date.now() % 100000));
      await cdp.send('Page.navigate', { url: swUrl });
      for (let i = 0; i < 120; i++) { await sleep(500); const ok = await cdp.ev(`!!(window.__ob && window.__ob.state && window.__ob.state() && window.__ob.state().rp === 'match' && window.__ob.slot() >= 0)`).catch(() => false); if (ok) break; }
      await cdp.ev(`(() => { document.getElementById('menuBtn').click(); document.querySelector('#ctrlSeg button[data-c="swipe"]').click(); document.querySelector('.menu-nav button[data-pane="resume"]').click(); return true; })()`);
      await sleep(800);
      console.log('swipe room:', swUrl, JSON.stringify(await cdp.ev(`window.__ob.swipe()`)));
      const hits0 = await cdp.ev(`window.__ob.myHits`);
      // a real swipe on our serve
      let realOk = false;
      for (let i = 0; i < 60 && !realOk; i++) {
        const st = await cdp.ev(`(() => { const s = window.__ob.state(); return s ? { ph: s.ph, sv: s.sv, hold: s.hold, ms: window.__ob.slot() } : null; })()`);
        if (st && st.ph === 'serve' && st.sv === st.ms && st.hold) {
          const n0 = await cdp.ev(`window.__ob.swipe().swp.n`);
          for (const d of [60, 180, 260, 180, 60, 0]) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 380, deltaX: 0, deltaY: d }); await sleep(16); }
          await sleep(400);
          const sw = await cdp.ev(`window.__ob.swipe().swp`);
          let served = false;
          for (let k = 0; k < 12 && !served; k++) { await sleep(250); served = (await cdp.ev(`window.__ob.myHits`)) > hits0; }
          realOk = sw.n > n0 && served;
          console.log(`swipe (real input): recognised ${sw.n > n0} (intensity ${sw.si}, ${sw.sd ? 'down' : 'up'}) · served ${served}`);
        } else await sleep(400);
      }
      if (!realOk) cdp.logs.push('assert: a real trackpad swipe did not serve');
      // the swiping player, in the page
      await cdp.ev(`(() => {
        const T = window.__swt = { n: 0, grades: [0, 0, 0, 0, 0], kinds: {}, lastKey: '' };
        const fire = (vals, down) => vals.forEach((v, i) => setTimeout(() => dispatchEvent(new WheelEvent('wheel', { deltaY: down ? -v : v, deltaMode: 0, cancelable: true })), i * 16));
        T.keys = new Set();
        const press = (code, down) => dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));
        T.timer = setInterval(() => {
          const s = window.__ob.state(), sw = window.__ob.swipe(), ms = window.__ob.slot();
          if (!s || ms < 0 || !s.p) return;
          // the legs: hold the keys toward where the shuttle is best met (roughly: the magnet does the rest)
          const me = s.p[ms], b = s.b, want = new Set();
          const tg = window.BM.meetTarget({ tick: s.k, phase: s.ph, serveHold: !!s.hold, ball: { x: b[0], y: b[1], z: b[2], vx: b[3], vy: b[4], vz: b[5], last: s.lh } }, { i: ms, x: me[0], y: me[1] });
          if (tg) {
            const dx = tg.x - me[0], dy = tg.y - me[1], d = Math.hypot(dx, dy), side = ms === 1 ? 1 : -1;
            const fwd = dx * -side, right = dy * -side;
            if (d > 0.3) { if (fwd > 0.38 * d) want.add('KeyW'); if (fwd < -0.38 * d) want.add('KeyS'); if (right > 0.38 * d) want.add('KeyD'); if (right < -0.38 * d) want.add('KeyA'); }
          }
          T.d = T.d || { ticks: 0, tg: 0, keys: 0, ideal: 0, minLead: 1e9, dist: [] };
          T.d.ticks++; if (tg) T.d.tg++; if (want.size) T.d.keys++; if (sw.ideal != null) { T.d.ideal++; T.d.minLead = Math.min(T.d.minLead, Math.abs(sw.ideal - performance.now())); }
          for (const k of T.keys) if (!want.has(k)) { press(k, false); T.keys.delete(k); }
          for (const k of want) if (!T.keys.has(k)) { press(k, true); T.keys.add(k); }
          const key = s.lh + ':' + s.rc + ':' + s.ph + ':' + s.sc.join('');
          if (key === T.lastKey) return;
          const serving = s.ph === 'serve' && s.sv === ms && s.hold;
          if (serving) { T.lastKey = key; setTimeout(() => fire([60, 200, 300, 200, 60, 0], false), 300); return; }
          if (sw.ideal == null || s.lh === ms) return;
          const lead = sw.ideal - performance.now();
          if (lead > 160 || lead < -40) return; // (headless software rendering is slow: a late read still swipes, graded late)
          T.lastKey = key; T.n++;
          const r = Math.random(), down = Math.random() < 0.15;
          const big = r < 0.3 ? 40 : r < 0.6 ? 160 : 520;      // gentle, firm, fierce
          // the third event is the fastest: land it on the ring (plus the 40 ms people run late, and a scatter)
          const at = lead + 40 + (Math.random() * 2 - 1) * 30 - 32;
          setTimeout(() => fire([big * 0.3, big * 0.8, big, big * 0.55, big * 0.2, 0], down), Math.max(0, at));
        }, 8);
        return true; })()`);
      const t0 = Date.now();
      let shot = false, line = [];
      while (Date.now() - t0 < 35000) {
        await sleep(500);
        const tl = await cdp.ev(`(() => { const s = window.__ob.state(); return s ? s.ph[0] + s.sc.join('') + '/' + window.__swt.n : '-'; })()`);
        if (line[line.length - 1] !== tl) line.push(tl);
        if (!shot && (await cdp.ev(`window.__swt.n`)) >= 3) { await cdp.shot('swipe.png'); shot = true; }
        const ls = await cdp.ev(`window.__ob.lastSwipe || null`);
        if (ls) await cdp.ev(`(() => { const T = window.__swt, ls = window.__ob.lastSwipe; if (ls && ls !== T.seen) { T.seen = ls; T.grades[ls.g]++; } return true; })()`);
      }
      const T = await cdp.ev(`(() => { clearInterval(window.__swt.timer); for (const k of window.__swt.keys) dispatchEvent(new KeyboardEvent('keyup', { code: k })); return { n: window.__swt.n, grades: window.__swt.grades, d: window.__swt.d }; })()`);
      console.log('swipe player diagnostics:', JSON.stringify(T.d));
      console.log('swipe timeline (phase, score / swipes):', line.join(' '));
      await sample();
      let hits = 0;
      for (let k = 0; k < 10; k++) { hits = (await cdp.ev(`window.__ob.myHits`)) - hits0; if (hits >= 3) break; await sleep(300); }
      console.log(`swipe: ${T.n} timed swipes · grades perfect ${T.grades[0]}, great ${T.grades[1]}, good ${T.grades[2]}, early/late ${T.grades[3]}, miss ${T.grades[4]} -> ${hits} own hits`);
      if (!(T.n >= 3 && hits >= 3)) cdp.logs.push(`assert: timed swipes did not become hits (${T.n} swipes, ${hits} hits)`);
      if (T.grades.reduce((a, b) => a + b, 0) < T.n) cdp.logs.push(`assert: not every swipe was graded (${JSON.stringify(T.grades)} of ${T.n})`);
      if (T.grades[0] + T.grades[1] + T.grades[2] < Math.ceil(T.n * 0.5)) cdp.logs.push(`assert: well-timed swipes were not graded well (${JSON.stringify(T.grades)})`);
    }

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
