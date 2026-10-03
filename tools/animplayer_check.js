'use strict';
// Office Badminton — animation player smoke test. Opens /badminton/anim in headless Chrome/Edge and
// checks the player: it lists every case, loads a movement case, steps, scrubs back (an exact
// replay: the same frame twice gives the same pose), plays, loads a stroke case (its flight solved
// in the page), reaches the contact frame, and screenshots each.
//   node tools/animplayer_check.js [url]
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const PORT = 9340;
const URL = process.argv.slice(2).find(a => a.startsWith('http')) || 'http://127.0.0.1:3000/badminton/anim';
const OUT = path.join(os.tmpdir(), 'office-badminton-animplayer');
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
        else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this.logs.push('error: ' + m.params.args.map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(' '));
      });
    });
  }
  send(method, params) { return new Promise((resolve, reject) => { const id = ++this.id; this.pending.set(id, [resolve, reject]); this.ws.send(JSON.stringify({ id, method, params: params || {} })); }); }
  async ev(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    return r.result.value;
  }
  async shot(name) { const s = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(s.data, 'base64')); }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'obm-animplayer-profile-'));
  const proc = spawn(findBrowser(), ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1400,820', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let cdp = null; const fails = [];
  const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails.push(msg); };
  try {
    let version = null;
    for (let i = 0; i < 80 && !version; i++) { try { version = await httpJson('GET', '/json/version'); } catch { await sleep(250); } }
    if (!version) throw new Error('browser never came up');
    let target; try { target = await httpJson('PUT', '/json/new?about:blank'); } catch { target = await httpJson('GET', '/json/new?about:blank'); }
    cdp = new CDP(target.webSocketDebuggerUrl); await cdp.open();
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: URL });
    let ok = false;
    for (let i = 0; i < 120 && !ok; i++) { ok = await cdp.ev(`!!(window.__anim && window.__anim.S.frames.length && window.__anim.S.i >= 0)`).catch(() => false); if (!ok) await sleep(500); }
    check(ok, 'the player starts and loads its first case');
    if (!ok) throw new Error('player never started');
    const n = await cdp.ev(`document.querySelectorAll('#ap .it').length`);
    check(n === 121, `every case listed (${n} of 88 movement + 30 strokes + 3 celebrations)`);
    // a movement case: step, scrub back, compare
    const pose = `(() => { const A = window.__ob.R().debugAthletes()[window.__anim.S.cur.def.slot || 0]; return ['pelvis','thigh_l','calf_r','upperarm_r','hand_r'].map(n => A.h.bone[n].getWorldPosition(new A.root.position.constructor()).toArray().map(v => +v.toFixed(5))).flat(); })()`;
    await cdp.ev(`(() => { const a = window.__anim, c = [...document.querySelectorAll('#ap .it')].find(e => e.textContent === 'run 90'); c.click(); return 1; })()`);
    await sleep(800);
    await cdp.ev(`window.__anim.seek(60), 1`);
    const p60 = await cdp.ev(pose);
    await cdp.ev(`window.__anim.seek(90), 1`); await cdp.shot('run90_f90.png');
    await cdp.ev(`window.__anim.seek(60), 1`);
    const p60b = await cdp.ev(pose);
    const d = Math.max(...p60.map((v, i) => Math.abs(v - p60b[i])));
    check(d < 1e-4, `scrubbing back replays exactly (frame 60 twice: max difference ${d.toExponential(1)} m)`);
    // play
    const i0 = await cdp.ev(`(window.__anim.S.playing = true, window.__anim.S.i)`);
    await sleep(1500);
    const i1 = await cdp.ev(`(window.__anim.S.playing = false, window.__anim.S.i)`);
    check(i1 !== i0, `playing advances (frame ${i0} -> ${i1})`);
    const info = await cdp.ev(`document.querySelector('#ap .info').innerText`);
    check(/gait/.test(info) && /feet/.test(info), 'the readout shows the gait and the feet');
    // a stroke case: built in the page, contact frame
    await cdp.ev(`(() => { const c = [...document.querySelectorAll('#ap .it')].find(e => e.textContent === 'clear-fh-smash'); c.click(); return 1; })()`);
    let sOk = false;
    for (let i = 0; i < 60 && !sOk; i++) { sOk = await cdp.ev(`window.__anim.S.cur.name === 'clear-fh-smash' && !window.__anim.S.building && window.__anim.S.frames.length > 0`); if (!sOk) await sleep(250); }
    check(sOk, 'a stroke case builds and loads');
    const kc = await cdp.ev(`window.__anim.S.frames.findIndex(f => f.k === f.kc)`);
    await cdp.ev(`window.__anim.seek(${kc}), 1`); await sleep(300);
    const sinfo = await cdp.ev(`document.querySelector('#ap .info').innerText`);
    await cdp.shot('smash_contact.png');
    const miss = (sinfo.match(/racket→shuttle\s*([\d.]+) cm/) || [])[1];
    check(miss != null && +miss < 5, `at the contact frame the racket is on the shuttle (${miss} cm)`);
    await cdp.ev(`window.__anim.seek(${kc - 12}), 1`); await sleep(200); await cdp.shot('smash_windup.png');
    for (const name of ['Grip-axis 360 flourish','Compact fist pump','Racket salute']) {
      await cdp.ev(`([...document.querySelectorAll('#ap .it')].find(e=>e.textContent===${JSON.stringify(name)}).click(),1)`);
      await sleep(350);
      await cdp.ev(`window.__anim.seek(40),1`);
      const middle = await cdp.ev(`(() => {const A=window.__ob.R().debugAthletes()[0];return {finite:A.racket.quaternion.toArray().every(Number.isFinite),angle:2*Math.acos(Math.min(1,Math.abs(A.racket.quaternion.dot(A.racketBase)))),kind:window.__anim.S.cur.kind};})()`);
      check(middle.kind==='celebration' && middle.finite, `${name} builds and plays a finite pose`);
      if(name==='Grip-axis 360 flourish')check(middle.angle>0.3,'the flourish turns the racket during the celebration');
      await cdp.shot(name.toLowerCase().replace(/[^a-z0-9]+/g,'_')+'.png');
      await cdp.ev(`window.__anim.seek(window.__anim.S.frames.length-1),1`);
      const restored=await cdp.ev(`(() => {const A=window.__ob.R().debugAthletes()[0];return 1-Math.abs(A.racket.quaternion.dot(A.racketBase));})()`);
      check(restored<1e-7,`${name} returns to the neutral racket grip`);
    }
    // --reload: change a code file; the player must reload itself onto the same case and frame
    if (process.argv.includes('--reload')) {
      await sleep(400); // (the place is saved on the next interaction tick)
      const place = await cdp.ev(`({c:window.__anim.S.cur.name,i:window.__anim.S.i})`);
      await cdp.ev(`(window.__probe = 1, 1)`);
      const f = path.join(__dirname, '..', 'public', 'badminton', 'animplayer.js'), src = fs.readFileSync(f, 'utf8');
      try {
        fs.writeFileSync(f, src + '\n// reload probe\n');
        let back = null;
        for (let i = 0; i < 40 && !back; i++) {
          await sleep(500);
          back = await cdp.ev(`(!window.__probe && window.__anim && !window.__anim.S.building && window.__anim.S.cur) ? { c: window.__anim.S.cur.name, i: window.__anim.S.i } : null`).catch(() => null);
        }
        check(!!back && back.c === place.c && back.i === place.i, `a code change reloads the player onto the same case and frame (${back ? back.c + ' @ ' + back.i : 'no reload'})`);
      } finally { fs.writeFileSync(f, src); }
    }
    for (const l of cdp.logs) if (/uncaught/.test(l)) fails.push(l);
    if (cdp.logs.length) console.log('console:\n  ' + cdp.logs.slice(0, 8).join('\n  '));
    console.log('screenshots in', OUT);
  } catch (e) {
    fails.push(e.message); console.error('ANIMATION PLAYER CHECK FAILED:', e.message);
  } finally {
    try { if (cdp) await Promise.race([cdp.send('Browser.close'), sleep(1000)]); } catch { }
    try { if (cdp) cdp.ws.close(); } catch { }
    try { proc.kill(); } catch { }
    const abs = path.resolve(profile), temp = path.resolve(os.tmpdir()) + path.sep;
    if (abs.startsWith(temp) && path.basename(abs).startsWith('obm-animplayer-profile-')) {
      for (let i=0;i<8;i++) { try {fs.rmSync(abs,{recursive:true,force:true});break;} catch {await sleep(250);} }
    }
    console.log(fails.length ? 'RESULT: FAIL' : 'RESULT: PASS');
    process.exitCode = fails.length ? 1 : 0;
  }
})();
