'use strict';
// Office Badminton — racket grip check. Boots a practice match in headless Chrome/Edge, holds each
// athlete in a series of stances and strokes (the render3d pose inspector) and measures, on the
// actual skinned hand mesh against the actual racket handle, how the hand grips it:
//   palm / every finger phalanx -> handle surface gap (mm), penetration of the hand into the handle
//   or the butt cap, where the butt cap sits against the heel of the hand, the strings' plane
//   against the palm, that the grip is the one anim.js asks for (not the mocap's), and that the
//   free hand is relaxed (neither flat nor a fist). Exits non-zero when anything is out of tolerance.
//   node tools/grip_check.js [url] [--shots]
// --shots also saves close-ups of the racket hand from several sides for every pose.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const PORT = 9336;
const args = process.argv.slice(2);
const URL = args.find(a => !a.startsWith('--')) || 'http://127.0.0.1:3000/badminton/r/GRIPCHK';
const SHOTS = args.includes('--shots');
const OUT = path.join(os.tmpdir(), 'office-badminton-grip');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// tolerances (mm, degrees)
const TOL = {
  pen: 0.5,        // no hand surface more than this inside the handle or the butt cap
  palm: 1.5,       // the palm rests on the handle
  link: 3.5,       // every phalanx touches the handle within this
  indexTip: 6,     // the trigger finger's tip may stand a little off
  capLo: 0, capHi: 6, // butt cap top to the first hand contact along the handle
  face: 10,        // strings' normal vs the palm's normal
  drift: 0.5,      // finger bones vs the grip pose anim.js sets
  relaxLo: 20, relaxHi: 120, // free hand: each finger's curl (MCP->tip vs the hand's axis)
};
const POSES = [
  ['ready', {}],
  ['over-load', { stroke: 'over', u: -0.3 }],
  ['over-contact', { stroke: 'over', u: 0 }],
  ['over-follow', { stroke: 'over', u: 0.14 }],
  ['smash-contact', { stroke: 'smash', u: 0 }],
  ['fh-contact', { stroke: 'fh', u: 0, rz: 1.3, side: 0.6 }],
  ['bh-contact', { stroke: 'bh', u: 0, rz: 1.3, side: -0.6 }],
  ['under-contact', { stroke: 'under', u: 0, rz: 0.6 }],
  ['block-contact', { stroke: 'block', u: 0, rz: 1.1 }],
];
const VIEWS = [['back', [1, 0, 0]], ['palm', [-1, 0, 0]], ['thumb', [0, 0, 1]], ['pinky', [0, 0, -1]], ['thumbpalm', [-0.6, 0.2, 0.8]], ['tips', [0.3, 1, 0.3]]];

// ---- measured in the page (world units = metres)
const MEASURE = `(slot) => {
  const R = window.__ob.r3d(), A = R.players[slot], h = A.h, hand = h.bone.hand_r, body = h.body;
  const V = hand.position.constructor, Q = hand.quaternion.constructor;
  h.root.updateMatrixWorld(true);
  const sk = body.skeleton, g = body.geometry;
  if (!A.__grip) {
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight, sub = new Set();
    hand.traverse(o => { if (o.isBone) sub.add(sk.bones.indexOf(o)); });
    const verts = [], loc = new Map();
    for (let i = 0; i < g.attributes.position.count; i++) {
      let w = 0, best = -1, bw = 0;
      for (let k = 0; k < 4; k++) { const b = si.getComponent(i, k), ww = sw.getComponent(i, k); if (sub.has(b)) w += ww; if (ww > bw) { bw = ww; best = b; } }
      if (w > 0.25) { loc.set(i, verts.length); verts.push({ i, bone: sk.bones[best].name }); }
    }
    const tris = [], idx = g.index.array;
    for (let t = 0; t < idx.length; t += 3) {
      const c = [idx[t], idx[t + 1], idx[t + 2]].map(i => loc.get(i)); if (c.some(k => k === undefined)) continue;
      const cnt = {}; for (const k of c) cnt[verts[k].bone] = (cnt[verts[k].bone] || 0) + 1;
      let lab = Object.entries(cnt).sort((x, y) => y[1] - x[1])[0][0];
      lab = lab.replace('_04_leaf_r', '_03_r');
      tris.push([c[0], c[1], c[2], lab]);
    }
    A.__grip = { verts, tris };
  }
  const { verts, tris } = A.__grip;
  const P = verts.map(v => body.localToWorld(body.getVertexPosition(v.i, new V())));
  // the handle as the racket really is: its axis in the world, radius at the racket's world scale
  const G = A.racket.userData.grip, sc = A.racket.getWorldScale(new V()).x;
  const a = A.racket.localToWorld(new V(0, G.y0, 0)), b = A.racket.localToWorld(new V(0, G.y1, 0)), d = b.clone().sub(a), L = d.length(); d.normalize();
  const r = G.r * sc, capR = G.capR * sc, capL = (G.y0 - G.capY0) * sc;
  const out = { links: {}, pen: 0, capPen: 0, smin: Infinity };
  const q = new V(), N = 5;
  for (const [i0, i1, i2, lab] of tris) {
    const A0 = P[i0], B0 = P[i1], C0 = P[i2];
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N - i; j++) {
      const u = i / N, v = j / N, w = 1 - u - v;
      q.set(A0.x * u + B0.x * v + C0.x * w, A0.y * u + B0.y * v + C0.y * w, A0.z * u + B0.z * v + C0.z * w);
      const rx = q.x - a.x, ry = q.y - a.y, rz = q.z - a.z, s = rx * d.x + ry * d.y + rz * d.z;
      const radial = Math.hypot(rx - s * d.x, ry - s * d.y, rz - s * d.z);
      if (s >= -capL && s < 0) out.capPen = Math.max(out.capPen, capR - radial);
      if (s < 0 || s > L) continue;
      const sd = radial - r;
      out.pen = Math.max(out.pen, -sd);
      if (sd < 0.004) out.smin = Math.min(out.smin, s);
      const key = /^(hand_r|lowerarm_r|thumb_01_r)$/.test(lab) ? (lab === 'thumb_01_r' ? 'thenar' : 'palm') : lab.replace('_r', '');
      if (!(key in out.links) || sd < out.links[key]) out.links[key] = sd;
    }
  }
  // strings' normal (racket z) vs the palm's normal (hand x)
  const wq = A.racket.getWorldQuaternion(new Q()), hq = hand.getWorldQuaternion(new Q());
  const face = Math.acos(Math.min(1, Math.abs(new V(0, 0, 1).applyQuaternion(wq).dot(new V(1, 0, 0).applyQuaternion(hq))))) * 180 / Math.PI;
  // the finger bones hold the grip anim.js set (nothing after it re-poses them)
  let drift = 0; for (const [bone, want] of h.fingerPose || []) drift = Math.max(drift, bone.quaternion.angleTo(want) * 180 / Math.PI);
  // the free hand: each finger's curl, MCP->tip against the hand's own long axis
  const hl = h.bone.hand_l, ya = new V(0, 1, 0).applyQuaternion(hl.getWorldQuaternion(new Q())), relax = {};
  for (const f of ['index', 'middle', 'ring', 'pinky']) {
    const m = h.bone[f + '_01_l'].getWorldPosition(new V()), t = h.bone[f + '_04_leaf_l'].getWorldPosition(new V());
    relax[f] = Math.acos(Math.max(-1, Math.min(1, t.sub(m).normalize().dot(ya)))) * 180 / Math.PI;
  }
  const mm = x => +(x * 1000).toFixed(2);
  const links = {}; for (const k of Object.keys(out.links).sort()) links[k] = mm(out.links[k]);
  return { links, pen: mm(out.pen), capPen: mm(Math.max(0, out.capPen)), capToHand: mm(out.smin), face: +face.toFixed(1), drift: +drift.toFixed(3),
    relax: Object.fromEntries(Object.entries(relax).map(([k, v]) => [k, +v.toFixed(0)])), parent: A.racket.parent === hand, diameter: mm(2 * r) };
}`;

function findBrowser() {
  const candidates = [
    process.env.CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
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
      this.ws = new WebSocket(this.url, { perMessageDeflate: false });
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

function judge(m, slot, pose) {
  const bad = [];
  if (!m.parent) bad.push('racket is not parented to hand_r');
  if (m.pen > TOL.pen) bad.push(`hand ${m.pen} mm inside the handle`);
  if (m.capPen > TOL.pen) bad.push(`hand ${m.capPen} mm inside the butt cap`);
  if (!(m.links.palm <= TOL.palm)) bad.push(`palm ${m.links.palm} mm off the handle`);
  for (const f of ['index', 'middle', 'ring', 'pinky', 'thumb']) for (const k of ['01', '02', '03']) {
    if (f === 'thumb' && k === '01') continue; // the thumb's base is the thenar, part of the palm
    const key = f + '_' + k, g = m.links[key], tol = key === 'index_03' ? TOL.indexTip : TOL.link;
    if (!(g <= tol)) bad.push(`${key} ${g} mm off the handle (max ${tol})`);
  }
  if (!(m.capToHand >= TOL.capLo && m.capToHand <= TOL.capHi)) bad.push(`butt cap ${m.capToHand} mm from the heel of the hand`);
  if (m.face > TOL.face) bad.push(`strings ${m.face} deg off the palm's plane`);
  if (m.drift > TOL.drift) bad.push(`fingers drift ${m.drift} deg from the grip pose`);
  for (const [f, a] of Object.entries(m.relax)) if (a < TOL.relaxLo || a > TOL.relaxHi) bad.push(`free hand ${f} curl ${a} deg`);
  return bad.map(b => `slot ${slot} ${pose}: ${b}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const exe = findBrowser();
  const profile = path.join(os.tmpdir(), 'obm-grip-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=960,720', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let cdp = null, fails = [];
  try {
    let version = null;
    for (let i = 0; i < 80 && !version; i++) { try { version = await httpJson('GET', '/json/version'); } catch { await sleep(250); } }
    if (!version) throw new Error('browser never came up');
    let target; try { target = await httpJson('PUT', '/json/new?about:blank'); } catch { target = await httpJson('GET', '/json/new?about:blank'); }
    cdp = new CDP(target.webSocketDebuggerUrl); await cdp.open();
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('obm_name','GripCheck');}catch(e){}` });
    console.log('opening', URL);
    await cdp.send('Page.navigate', { url: URL });
    let ok = false;
    for (let i = 0; i < 160 && !ok; i++) { ok = await cdp.ev(`!!(window.__ob && window.__ob.r3d && window.__ob.r3d() && window.__ob.r3d().players && (window.__ob.state() || {}).rp === 'match')`).catch(() => false); if (!ok) await sleep(500); }
    if (!ok) throw new Error('no practice match (is the server up? does r3d() expose players?)');
    const rows = [];
    for (const [name, o] of POSES) {
      for (const slot of [0, 1]) {
        await cdp.ev(`window.__ob.R().debugPose(Object.assign(${JSON.stringify(o)}, { slot: ${slot} })), 1`);
        await sleep(900);
        const m = await cdp.ev(`(${MEASURE})(${slot})`);
        rows.push({ name, slot, m });
        fails.push(...judge(m, slot, name));
        if (SHOTS && slot === 0) for (const [vn, v] of VIEWS) {
          await cdp.ev(`window.__ob.R().debugPose(Object.assign(${JSON.stringify(o)}, { slot: 0, cam: 'hand', dist: 0.26, view: ${JSON.stringify(v)} })), 1`);
          await sleep(700); await cdp.shot(`${name}_${vn}.png`);
        }
      }
    }
    await cdp.ev(`window.__ob.R().debugPose(null), 1`);
    const L = ['palm', 'thenar', 'index_01', 'index_02', 'index_03', 'middle_01', 'middle_02', 'middle_03', 'ring_01', 'ring_02', 'ring_03', 'pinky_01', 'pinky_02', 'pinky_03', 'thumb_02', 'thumb_03'];
    console.log('gap from each part of the hand to the handle surface, mm (negative = inside it)');
    console.log('pose            slot ' + L.map(k => k.replace('_0', '').padStart(7)).join('') + '    pen  capPen capToHand face  drift  free-hand curl (i/m/r/p deg)');
    for (const { name, slot, m } of rows) {
      console.log(name.padEnd(16) + String(slot).padEnd(5) + L.map(k => (m.links[k] === undefined ? '-' : m.links[k].toFixed(1)).padStart(7)).join('') +
        m.pen.toFixed(2).padStart(7) + m.capPen.toFixed(2).padStart(8) + m.capToHand.toFixed(1).padStart(10) + m.face.toFixed(1).padStart(6) + m.drift.toFixed(2).padStart(7) + '  ' + Object.values(m.relax).join('/'));
    }
    console.log('handle diameter', rows[0].m.diameter, 'mm (slot 0),', rows[1].m.diameter, 'mm (slot 1)');
    if (cdp.logs.length) { console.log('console:'); for (const l of cdp.logs.slice(0, 20)) console.log('  ' + l); fails.push(...cdp.logs.filter(l => l.startsWith('uncaught'))); }
    if (SHOTS) console.log('close-ups in', OUT);
    if (fails.length) { console.log('RESULT: FAIL'); for (const f of fails) console.log('  ' + f); process.exitCode = 1; }
    else console.log('RESULT: PASS');
  } catch (e) {
    console.error('GRIP CHECK FAILED:', e.message); process.exitCode = 1;
  } finally {
    try { if (cdp) cdp.ws.close(); } catch { }
    try { proc.kill(); } catch { }
  }
})();
