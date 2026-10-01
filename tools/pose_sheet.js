'use strict';
// Office Badminton — stroke pose sheet. Boots a practice match in headless Chrome/Edge, holds one
// athlete in each stroke at a series of moments (u: seconds from contact, negative before it)
// through the render3d pose inspector, lets the springs settle, and draws every moment from the
// side and the front into one sheet per stroke: the wind-up, the swing, the contact and the
// follow-through as the stroke layer actually poses them.
//   node tools/pose_sheet.js [url] [--only over,fh]
// Sheets: <tmp>/office-badminton-poses/pose-<stroke>.png
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const PORT = 9338;
const args = process.argv.slice(2);
const URL = args.find(a => !a.startsWith('--') && a.startsWith('http')) || 'http://127.0.0.1:3000/badminton/r/POSES';
const ONLY = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1].split(',') : null; })();
const OUT = path.join(os.tmpdir(), 'office-badminton-poses');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// each stroke: where the shuttle is met (side: + racket side, fwd, rz: height over the feet) and
// the moments drawn
const SETS = {
  over: { o: { stroke: 'over', side: 0.3, fwd: 0.25, rz: 2.45 }, u: [-0.45, -0.2, -0.08, -0.03, 0, 0.06, 0.15, 0.3] },
  smash: { o: { stroke: 'smash', side: 0.3, fwd: 0.3, rz: 2.45 }, u: [-0.45, -0.2, -0.08, -0.03, 0, 0.06, 0.15, 0.3] },
  fh: { o: { stroke: 'fh', side: 0.65, fwd: 0.3, rz: 1.3 }, u: [-0.45, -0.2, -0.08, -0.03, 0, 0.06, 0.15, 0.3] },
  bh: { o: { stroke: 'bh', side: -0.6, fwd: 0.3, rz: 1.3 }, u: [-0.45, -0.2, -0.08, -0.03, 0, 0.06, 0.15, 0.3] },
  under: { o: { stroke: 'under', side: 0.5, fwd: 0.55, rz: 0.55 }, u: [-0.45, -0.2, -0.08, -0.03, 0, 0.06, 0.15, 0.3] },
  touch: { o: { stroke: 'touch', side: 0.35, fwd: 0.6, rz: 1.0 }, u: [-0.45, -0.2, -0.08, 0, 0.1, 0.25] },
  block: { o: { stroke: 'block', side: 0.3, fwd: 0.45, rz: 1.1 }, u: [-0.45, -0.2, -0.08, 0, 0.1, 0.25] },
};
const CW = 240, CH = 300; // cell size

function findBrowser() {
  const c = [process.env.CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  for (const p of c) if (p && fs.existsSync(p)) return p;
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
      this.ws = new WebSocket(this.url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      this.ws.on('open', resolve); this.ws.on('error', reject);
      this.ws.on('message', d => {
        const m = JSON.parse(d);
        if (m.id && this.pending.has(m.id)) { const [res, rej] = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); return; }
        if (m.method === 'Runtime.exceptionThrown') this.logs.push('uncaught: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
      });
    });
  }
  send(method, params) { return new Promise((resolve, reject) => { const id = ++this.id; this.pending.set(id, [resolve, reject]); this.ws.send(JSON.stringify({ id, method, params: params || {} })); }); }
  async ev(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    return r.result.value;
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = path.join(os.tmpdir(), 'obm-poses-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const proc = spawn(findBrowser(), ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=720,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let cdp = null;
  try {
    let version = null;
    for (let i = 0; i < 80 && !version; i++) { try { version = await httpJson('GET', '/json/version'); } catch { await sleep(250); } }
    if (!version) throw new Error('browser never came up');
    let target; try { target = await httpJson('PUT', '/json/new?about:blank'); } catch { target = await httpJson('GET', '/json/new?about:blank'); }
    cdp = new CDP(target.webSocketDebuggerUrl); await cdp.open();
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('obm_name','PoseSheet');}catch(e){}` });
    await cdp.send('Page.navigate', { url: URL });
    let ok = false;
    for (let i = 0; i < 160 && !ok; i++) { ok = await cdp.ev(`!!(window.__ob && window.__ob.r3d && window.__ob.r3d() && (window.__ob.state() || {}).rp === 'match')`).catch(() => false); if (!ok) await sleep(500); }
    if (!ok) throw new Error('no practice match');
    for (const [name, set] of Object.entries(SETS)) {
      if (ONLY && !ONLY.includes(name)) continue;
      await cdp.ev(`(() => { const c = document.createElement('canvas'); c.width = ${CW * set.u.length}; c.height = ${CH * 2 + 20}; const g = c.getContext('2d'); g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height); window.__sheet = c; return 1; })()`);
      for (let i = 0; i < set.u.length; i++) {
        for (const [row, cam] of [[0, 'side'], [1, 'front']]) {
          const o = Object.assign({}, set.o, { u: set.u[i], slot: 0, cam, hideOther: true });
          await cdp.ev(`window.__ob.R().debugPose(${JSON.stringify(o)}), 1`);
          await sleep(row ? 350 : 1100); // (the springs settle onto the held moment)
          await cdp.ev(`(() => { const R = window.__ob.R(); R.debugRender(); const cv = window.__ob.r3d().renderer.domElement, g = window.__sheet.getContext('2d');
            const s = Math.min(cv.width / ${CW}, cv.height / ${CH}) * 0.62, w = ${CW} * s, h = ${CH} * s;
            g.drawImage(cv, (cv.width - w) / 2, (cv.height - h) / 2, w, h, ${i * CW}, ${row * CH + 20}, ${CW}, ${CH});
            g.fillStyle = '#ffd34d'; g.font = '14px monospace'; if (!${row}) g.fillText('${name} u=' + (${set.u[i]}).toFixed(2), ${i * CW + 6}, 15); return 1; })()`);
        }
      }
      const data = await cdp.ev(`window.__sheet.toDataURL('image/png')`);
      fs.writeFileSync(path.join(OUT, `pose-${name}.png`), Buffer.from(data.split(',')[1], 'base64'));
      console.log('sheet', path.join(OUT, `pose-${name}.png`));
    }
    await cdp.ev(`window.__ob.R().debugPose(null), 1`);
    if (cdp.logs.length) for (const l of cdp.logs.slice(0, 10)) console.log('  ' + l);
  } catch (e) {
    console.error('POSE SHEET FAILED:', e.message); process.exitCode = 1;
  } finally {
    try { if (cdp) cdp.ws.close(); } catch { }
    try { proc.kill(); } catch { }
  }
})();
