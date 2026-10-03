// Office Badminton — the net tester (a tab of the heat lab, /badminton/heat). Real shuttles,
// flown by the game's own shuttle step (BM._stepBall: drag, gravity and the authoritative net
// plane), so a net hit here is exactly a net hit in a match; the hit goes to the renderer's own
// cloth (NetDynamics) the way the client passes it. Shot presets, aim and speed sliders, slow
// motion, a trail, a readout of what happened, and the cloth's character on sliders.
import { NET_TUNE } from './net-dynamics.mjs';

const KMH = v => v / 3.6; // real m/s from km/h (the sim's speeds are court-scaled: see V below)
export const NET_SHOTS = {
  'Smash into the tape': { kmh: 300, contact: 2.6, dist: 3.2, aimZ: 1.42, aimY: 0.3 },
  'Smash into the middle': { kmh: 320, contact: 2.7, dist: 2.6, aimZ: 1.05, aimY: -0.6 },
  'Flat drive': { kmh: 150, contact: 1.35, dist: 3.4, aimZ: 1.3, aimY: 0.9 },
  'Net shot clips the tape': { kmh: 26, contact: 1.35, dist: 0.55, aimZ: 1.5, aimY: -0.4 },
  'Tumbling net kill': { kmh: 210, contact: 1.9, dist: 0.9, aimZ: 1.25, aimY: 1.4 },
  'Low lift into the foot': { kmh: 70, contact: 0.35, dist: 1.3, aimZ: 0.88, aimY: 0 },
  'Kill by the post': { kmh: 260, contact: 2.2, dist: 2, aimZ: 1.35, aimY: 3.2 },
  'Skims over the tape': { kmh: 130, contact: 1.5, dist: 2.8, aimZ: 1.6, aimY: -1 },
};
const SLIDERS = [
  ['kmh', 'Speed (km/h)', 10, 420, 1], ['contact', 'Contact height (m)', 0.2, 3.2, 0.01], ['dist', 'Distance to net (m)', 0.3, 6, 0.01],
  ['aimZ', 'Aim height at net (m)', 0.6, 2.2, 0.01], ['aimY', 'Aim across (m)', -3.4, 3.4, 0.01],
];
const TUNES = [['stiffness', 'Stiffness', 0.2, 3], ['damping', 'Damping', 0.2, 3], ['tape', 'Tape tension', 0.2, 3], ['impact', 'Impact strength', 0, 4], ['cup', 'Cupping', 0, 4]];
const TRAIL = 240;

export function createNetTester({ THREE, R, BM, scene, camera, controls, shuttle, saved = {} }) {
  const { netDynamics, netLook } = R.debugPresentation();
  const C = BM.C, V = 1.35 * 0.85; // court scale S times time scale T (shared/badminton.js)
  const S = {
    shot: saved.shot && NET_SHOTS[saved.shot] ? saved.shot : 'Smash into the tape',
    aim: { ...NET_SHOTS['Smash into the tape'], ...(saved.aim || {}) },
    tune: { ...NET_TUNE, ...(saved.tune || {}) },
    auto: saved.auto ?? false, slow: saved.slow ?? 1, far: saved.far ?? false, view: saved.view || 'angled',
  };
  Object.assign(netDynamics.tune, S.tune);

  // the flight: a minimal sim the shared step understands
  const sim = BM.createSim(0);
  let flying = false, landedAt = 0, acc = 0, last = null, autoT = 0, peak = 0, settle = 0;
  const trail = new Float32Array(TRAIL * 3); let trailN = 0;
  const trailGeo = new THREE.BufferGeometry(); trailGeo.setAttribute('position', new THREE.BufferAttribute(trail, 3));
  const trailLine = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0xe4ff3c, transparent: true, opacity: 0.8, depthTest: false }));
  trailLine.frustumCulled = false; trailLine.renderOrder = 20; trailLine.visible = false; scene.add(trailLine);
  const hitMark = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.075, 32), new THREE.MeshBasicMaterial({ color: 0xff5a3c, side: THREE.DoubleSide, depthTest: false, transparent: true }));
  hitMark.rotation.y = Math.PI / 2; hitMark.renderOrder = 21; hitMark.visible = false; scene.add(hitMark);
  const aimMark = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.045, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.7 }));
  aimMark.rotation.y = Math.PI / 2; aimMark.renderOrder = 21; aimMark.visible = false; scene.add(aimMark);
  const W2 = (x, y, z) => [x, z, y]; // sim (x along, y across, z up) -> world
  const dir = new THREE.Vector3(), down = new THREE.Vector3(0, -1, 0);

  // the launch pitch that carries the shuttle through the aim point (bisection on a drag flight)
  function launch() {
    const a = S.aim, sd = S.far ? 1 : -1;
    const x0 = sd * a.dist, y0 = a.aimY, z0 = a.contact, sp = KMH(a.kmh) * V;
    const flightZ = pitch => {
      let x = x0, y = y0, z = z0, vx = -sd * sp * Math.cos(pitch), vy = 0, vz = sp * Math.sin(pitch);
      for (let i = 0; i < 600; i++) {
        const v = Math.hypot(vx, vy, vz), dec = 1 / (1 + C.DRAG * v / 60);
        vx *= dec; vy *= dec; vz = vz * dec - C.G / 60;
        const nx = x + vx / 60;
        if (Math.sign(nx) !== Math.sign(x)) return z + (vz / 60) * (x / (x - nx));
        x = nx; z += vz / 60; if (z < 0) return -1;
      }
      return -1;
    };
    let lo = -1.2, hi = 1.2;
    if (flightZ(hi) < a.aimZ) hi = 1.45; // a slow shot needs a loop
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (flightZ(m) < a.aimZ) lo = m; else hi = m; }
    const p = (lo + hi) / 2;
    return { x: x0, y: y0, z: z0, vx: -sd * sp * Math.cos(p), vy: 0, vz: sp * Math.sin(p), over: 0, pitch: p };
  }

  function fire() {
    const b = launch();
    sim.events = []; sim.tick = 0; sim.ball = { x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, over: 0 };
    flying = true; landedAt = 0; acc = 0; trailN = 0; peak = 0; settle = 0;
    last = { result: 'flying', pitch: (b.pitch * 180 / Math.PI).toFixed(1) + '°', kmh: S.aim.kmh };
    hitMark.visible = false; shuttle.visible = true; trailLine.visible = true;
    placeShuttle();
  }
  function placeShuttle() {
    const b = sim.ball;
    shuttle.position.set(...W2(b.x, b.y, b.z));
    const sp = Math.hypot(b.vx, b.vy, b.vz);
    if (sp > 0.3) { dir.set(...W2(b.vx, b.vy, b.vz)).normalize(); shuttle.quaternion.setFromUnitVectors(down, dir); }
    if (trailN < TRAIL) { trail.set(W2(b.x, b.y, b.z), trailN * 3); trailN++; trailGeo.setDrawRange(0, trailN); trailGeo.attributes.position.needsUpdate = true; }
  }
  function tick() {
    if (!flying) return;
    const landed = BM._stepBall(sim);
    for (const e of sim.events.splice(0)) if (e.type === 'net') {
      // exactly what the client hands the renderer for a 'net' event
      netDynamics.impact(e);
      hitMark.position.set(...W2(0.004, e.y, e.z)); hitMark.visible = true;
      Object.assign(last, { result: 'NET', at: `${e.z.toFixed(2)} m high, ${e.y.toFixed(2)} m across`, impactKmh: e.kmh, tapeAt: BM.netAt(e.y).toFixed(3) });
    }
    if (last.result === 'flying' && Math.sign(sim.ball.x) === (S.far ? -1 : 1)) last.result = 'OVER';
    placeShuttle();
    if (landed) { flying = false; landedAt = performance.now(); if (last.result !== 'NET') last.result = last.result === 'OVER' ? 'OVER (landed)' : 'SHORT'; }
  }
  function stepNet(dt) {
    netDynamics.step(dt);
    netLook.sync();
    // the cloth's deepest bulge right now, and the largest since the shot
    let m = 0; const p = netDynamics.positions, b = netDynamics.base;
    for (let i = 2; i < p.length; i += 3) m = Math.max(m, Math.abs(p[i] - b[i]));
    peak = Math.max(peak, m); settle = m;
  }

  // ---------------------------------------------------------------- cameras on the net
  function setView(v) {
    S.view = v;
    const t = new THREE.Vector3(0, 1.15, S.aim.aimY);
    const off = { angled: [-2.6, 0.75, 2.6], front: [-3.4, 0.25, 0.01], side: [0.9, 0.2, 5.2], top: [0.01, 4.5, 0.01], broadcast: [-13.1 - 0, 5.6, 1.4] }[v] || [-2.6, 0.75, 2.6];
    if (v === 'broadcast') t.set(0, 0.8, 0);
    controls.target.copy(t); camera.position.set(t.x + off[0], t.y + off[1], t.z + off[2]);
    camera.fov = v === 'broadcast' ? 38 : 40; camera.updateProjectionMatrix(); controls.update();
  }

  // ---------------------------------------------------------------- the panel
  const html = `
    <h3>Net tester</h3>
    <div class="btns ns"></div>
    <h3>The shot</h3><div class="na"></div>
    <div class="btns" style="margin-top:8px"><button class="nfire">Fire (F)</button><button class="nauto">Auto-fire (A)</button><button class="nslow">Slow-mo (S)</button><button class="nfar">From far side</button></div>
    <h3>Camera</h3><div class="btns nv"></div>
    <h3>Result</h3><div class="nr" style="font-variant-numeric:tabular-nums;line-height:1.6"></div>
    <h3>Net cloth</h3><div class="nt"></div>
    <div class="btns" style="margin-top:10px"><button class="ncopy">Copy net JSON</button><button class="nreset">Reset net</button></div>
    <div class="help">The shuttle flies on the game's own shuttle step: below the tape it stops dead and drops; above it flies on. The cloth is the renderer's own net, struck exactly as in a match.</div>`;
  let root = null;
  function mount(el, note) {
    root = el; el.innerHTML = html;
    const $ = q => el.querySelector(q);
    $('.ns').innerHTML = Object.keys(NET_SHOTS).map(k => `<button data-ns="${k}">${k}</button>`).join('');
    $('.na').innerHTML = SLIDERS.map(([k, l, lo, hi, st]) => `<label class="row"><span>${l}</span><input type="range" data-na="${k}" min="${lo}" max="${hi}" step="${st}"><output data-nao="${k}"></output></label>`).join('');
    $('.nt').innerHTML = TUNES.map(([k, l, lo, hi]) => `<label class="row"><span>${l}</span><input type="range" data-nt="${k}" min="${lo}" max="${hi}" step="0.01"><output data-nto="${k}"></output></label>`).join('');
    $('.nv').innerHTML = ['angled', 'front', 'side', 'top', 'broadcast'].map(v => `<button data-nv="${v}">${v}</button>`).join('');
    el.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.ns) { S.shot = b.dataset.ns; Object.assign(S.aim, NET_SHOTS[S.shot]); fire(); }
      if (b.dataset.nv) setView(b.dataset.nv);
      if (b.classList.contains('nfire')) fire();
      if (b.classList.contains('nauto')) S.auto = !S.auto;
      if (b.classList.contains('nslow')) S.slow = S.slow < 1 ? 1 : 0.2;
      if (b.classList.contains('nfar')) { S.far = !S.far; fire(); }
      if (b.classList.contains('nreset')) { Object.assign(S.tune, NET_TUNE); Object.assign(netDynamics.tune, S.tune); }
      if (b.classList.contains('ncopy')) {
        const json = JSON.stringify(S.tune, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v);
        navigator.clipboard.writeText(json).then(() => note('Net tuning copied'), () => prompt('Net JSON', json));
      }
      draw(); saveFn();
    });
    el.addEventListener('input', e => {
      const a = e.target.dataset.na, t = e.target.dataset.nt;
      if (a) { S.aim[a] = +e.target.value; S.shot = null; }
      if (t) { S.tune[t] = +e.target.value; netDynamics.tune[t] = S.tune[t]; }
      draw(); saveFn();
    });
    draw();
  }
  function draw() {
    if (!root) return;
    const $ = q => root.querySelector(q);
    for (const b of root.querySelectorAll('[data-ns]')) b.classList.toggle('on', b.dataset.ns === S.shot);
    for (const b of root.querySelectorAll('[data-nv]')) b.classList.toggle('on', b.dataset.nv === S.view);
    for (const i of root.querySelectorAll('[data-na]')) { i.value = S.aim[i.dataset.na]; root.querySelector(`[data-nao="${i.dataset.na}"]`).textContent = (+S.aim[i.dataset.na]).toFixed(i.dataset.na === 'kmh' ? 0 : 2); }
    for (const i of root.querySelectorAll('[data-nt]')) { i.value = S.tune[i.dataset.nt]; root.querySelector(`[data-nto="${i.dataset.nt}"]`).textContent = (+S.tune[i.dataset.nt]).toFixed(2); }
    $('.nauto').classList.toggle('on', S.auto); $('.nslow').classList.toggle('on', S.slow < 1); $('.nfar').classList.toggle('on', S.far);
    readout();
  }
  function readout() {
    if (!root) return;
    const L = last || { result: '—' };
    const col = L.result === 'NET' ? '#ff7a5c' : /OVER/.test(L.result) ? '#7dffa0' : '#e8ecf2';
    root.querySelector('.nr').innerHTML = `<b style="color:${col};font-size:18px">${L.result}</b><br>`
      + (L.at ? `hit the net ${L.at} (tape there ${L.tapeAt} m)<br>at ${L.impactKmh} km/h<br>` : '')
      + (L.pitch ? `launched ${L.kmh} km/h, pitch ${L.pitch}<br>` : '')
      + `net bulge now ${(settle * 100).toFixed(1)} cm · peak ${(peak * 100).toFixed(1)} cm`;
  }
  let saveFn = () => {};

  // ---------------------------------------------------------------- per frame
  let readT = 0, on = false;
  function update(dt) {
    if (!on) return;
    const d = dt * S.slow;
    acc += d;
    let n = 0;
    while (acc >= 1 / 60 && n < 8) { acc -= 1 / 60; n++; tick(); }
    stepNet(d);
    if (S.auto && !flying && performance.now() - landedAt > 900) { autoT += dt; if (autoT > 0.2) { autoT = 0; fire(); } }
    aimMark.position.set(...W2(-0.004 * (S.far ? -1 : 1), S.aim.aimY, S.aim.aimZ)); aimMark.visible = true;
    if ((readT += dt) > 0.1) { readT = 0; readout(); }
  }
  function activate(v) {
    on = v;
    trailLine.visible = v && trailN > 0; aimMark.visible = v; hitMark.visible = v && hitMark.visible;
    shuttle.visible = v && (flying || trailN > 0);
    if (v) setView(S.view); else { flying = false; netDynamics.reset(); stepNet(0.0001); }
  }
  addEventListener('keydown', e => {
    if (!on || (e.target.tagName === 'INPUT' && e.target.type !== 'range')) return;
    if (e.key === 'f' || e.key === 'F') fire();
    else if (e.key === 'a' || e.key === 'A') { S.auto = !S.auto; draw(); saveFn(); }
    else if (e.key === 's' || e.key === 'S') { S.slow = S.slow < 1 ? 1 : 0.2; draw(); saveFn(); e.stopImmediatePropagation(); }
  }, true);

  return {
    S, mount, update, activate, fire, setView,
    onSave(fn) { saveFn = fn; },
    state: () => ({ shot: S.shot, aim: S.aim, tune: S.tune, auto: S.auto, slow: S.slow, far: S.far, view: S.view }),
    debug: () => ({ last, flying, peak, settle, ball: { ...sim.ball } }),
  };
}
