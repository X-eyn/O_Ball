'use strict';
// Office Ball — live browser check. Boots the real game in headless Chrome/Edge, waits for the
// loading screen to finish, plays a few seconds of a bot match (move, shoot, shield, knock-on),
// captures screenshots and reports every console error/warning the page produced.
//   node tools/browser_check.js [url]
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const PORT = 9333;
const URL = process.argv[2] || 'http://127.0.0.1:3000/r/CHK1?perf=1';
const OUT = path.join(os.tmpdir(), 'office-ball-check');
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
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const exe = findBrowser();
  console.log('browser:', exe);
  const profile = path.join(os.tmpdir(), 'ob-check-profile');
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
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('ob_name','CheckBot');localStorage.setItem('ob_graphics','lite');}catch(e){}` });
    console.log('navigating to', URL);
    await cdp.send('Page.navigate', { url: URL });

    // wait for the whole boot: the loading screen goes away only after the first frame is drawn
    let ok = false;
    for (let i = 0; i < 150; i++) {
      try {
        ok = await cdp.ev(`!!(window.__ob && window.__ob.state && window.__ob.state())`);
      } catch { ok = false; }
      if (ok) break;
      await sleep(500);
    }
    const boot = await cdp.ev(`window.__obBoot ? { trace: window.__obBoot.trace.length, stages: Object.fromEntries(Object.entries(window.__obBoot.stages).map(([k,s]) => [k, { done: s.done, total: s.total, ms: s.t0 !== null && s.t1 !== null ? Math.round(s.t1 - s.t0) : null, skipped: !!s.skipped }])) } : null`).catch(() => null);
    console.log('booted:', ok, JSON.stringify(boot));
    if (!ok) {
      const diag = await cdp.ev(`({
        href: location.href, ready: document.readyState, title: document.title,
        bootEl: !!document.getElementById('boot'), bootLbl: (document.querySelector('#boot .lbl') || {}).textContent || null,
        root: (document.getElementById('boot') || {}).className || null,
        manifest: !!(window.__MANIFEST && window.__MANIFEST.build), build: (window.__MANIFEST || {}).build || null,
        ob: typeof window.OB, log: (window.__obLog || []).slice(-15), obBoot: !!window.__obBoot,
        scripts: [...document.scripts].map(s => s.src || 'inline').slice(0, 8),
        styles: [...document.querySelectorAll('link[rel=stylesheet]')].filter(l => !l.href.startsWith('data:')).map(l => l.href),
      })`).catch(e => ({ evalError: e.message }));
      console.log('diagnostics:', JSON.stringify(diag, null, 1));
      throw new Error('game never finished booting');
    }

    // play: run right, charge a shot (screenshot), shield (assert + screenshot), knock on
    const slot = await cdp.ev(`window.__ob.slot()`);
    const shieldFlag = () => cdp.ev(`(() => { const s = window.__ob.state(); return s && s.p[${slot}] ? s.p[${slot}][11] : null; })()`);
    const recvFlag = () => cdp.ev(`(() => { const s = window.__ob.state(); return s && s.p[${slot}] ? [s.p[${slot}][12], s.p[${slot}][13]] : null; })()`);
    await cdp.key('KeyD', 68, true); await sleep(1400); await cdp.key('KeyD', 68, false);
    await sleep(300);
    await cdp.key('Space', 32, true); await sleep(500);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'charge.png'), Buffer.from(shot.data, 'base64'));
    await sleep(200); await cdp.key('Space', 32, false);
    await sleep(700);
    await cdp.key('KeyC', 67, true);
    await sleep(2200);
    const on1 = await shieldFlag();
    const shieldShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'shield.png'), Buffer.from(shieldShot.data, 'base64'));
    await sleep(2200);
    const on2 = await shieldFlag(); // software rendering can span a press inside one long frame; sample twice
    await cdp.key('KeyC', 67, false); await sleep(1200);
    const off = await shieldFlag();
    console.log('shield flag held/held/off:', on1, on2, off, ' recv sample:', JSON.stringify(await recvFlag()));
    if (on1 !== 1 && on2 !== 1) cdp.logs.push('assert: shield flag never followed the input (' + on1 + '/' + on2 + ')');
    if (off !== 0) cdp.logs.push('assert: shield flag stuck on after release (' + off + ')');
    await cdp.key('KeyV', 86, true); await sleep(60); await cdp.key('KeyV', 86, false);
    await sleep(800);
    await cdp.key('KeyA', 65, true); await sleep(700); await cdp.key('KeyA', 65, false);
    await sleep(1200);

    const state = await cdp.ev(`(() => { const s = window.__ob.state(); if (!s) return null; const p = s.p || []; return { rp: s.rp, ph: s.ph, ball: s.b, players: p.map(a => a.slice(0, 14)), allFinite: [...s.b, ...p.flat()].every(Number.isFinite), events: p.length }; })()`);
    const perf = await cdp.ev(`window.__ob.perf()`).catch(() => null);
    console.log('state:', JSON.stringify(state));
    console.log('perf:', JSON.stringify(perf));
    console.log('page log:', JSON.stringify(await cdp.ev(`(window.__obLog || []).slice(-12)`)));
    const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'play.png'), Buffer.from(shot1.data, 'base64'));
    console.log('screenshot:', path.join(OUT, 'play.png'));

    console.log(cdp.logs.length ? 'CONSOLE ISSUES:' : 'console: clean');
    for (const l of cdp.logs.slice(0, 30)) console.log('  ' + l);
    if (!state || !state.allFinite) { console.log('RESULT: FAIL (bad state)'); process.exitCode = 1; }
    else if (cdp.logs.some(l => l.startsWith('uncaught') || l.startsWith('assert') || l.startsWith('error'))) { console.log('RESULT: FAIL (errors or failed assertion)'); process.exitCode = 1; }
    else console.log('RESULT: PASS');
  } catch (e) {
    console.error('CHECK FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    try { if (cdp) cdp.ws.close(); } catch { }
    try { proc.kill(); } catch { }
  }
})();
