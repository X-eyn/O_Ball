// Office Badminton — the FX tester (a tab of the heat lab, /badminton/heat). Its main job: replay
// the athlete's smash (the real stroke, from the stroke lab's case) and fire the contact glass,
// flash and shockwave at the exact contact frame, then the court crack where it lands. Press R (or
// F) to replay; slow-mo and loop for a close look. Also: the shuttle's beacon, trail and glint on
// bare flights (BM._stepBall). The effects are the renderer's own.
import { strokeCases } from './labcases.js';
import { resetAthlete } from './motionlab.js';

const SHOTS = {
  smash: { color: 0xff5a3c, from: [3.2, 0.6, 2.9], land: [-3.6, -0.9] },
  clear: { color: 0xffffff, from: [3.6, -0.4, 1.2], land: [-4.6, 0.6], kmh: 230, high: true },
  drive: { color: 0xffd34d, from: [2.6, 0.9, 1.4], land: [-4.6, -1.2], kmh: 150 },
};

const SWINGS = { smash: 'clear-fh-smash', jump: 'jump-smash' };
const VIEWS = ['front', 'side', 'behind', 'broadcast'];

export function createFxTester({ THREE, R, BM, scene, camera, controls, shuttle, renderer, athlete: A, foot, saved = {} }) {
  const { shuttleFx, smashFx, W2 } = R.debugPresentation();
  const C = BM.C, V = 1.35 * 0.85;
  const S = { power: saved.power ?? 0.9, glass: saved.glass ?? 'always', view: VIEWS.includes(saved.view) ? saved.view : 'front', auto: saved.auto ?? false, slow: saved.slow ?? 1, swing: SWINGS[saved.swing] ? saved.swing : 'smash' };
  const sim = BM.createSim(0);
  let flying = false, kind = 'smash', acc = 0, landedAt = 0, kick = 0, on = false, lastShot = null;
  const kickOff = new THREE.Vector3();

  // the launch that lands the shot at its target: bisection on the pitch (drag + gravity)
  function launch(shot, kmh) {
    const [x0, y0, z0] = shot.from, [lx, ly] = shot.land, sp = kmh / 3.6 * V;
    const dx = lx - x0, dy = ly - y0, d = Math.hypot(dx, dy), ux = dx / d, uy = dy / d;
    const landAt = pitch => {
      let x = x0, y = y0, z = z0, vx = ux * sp * Math.cos(pitch), vy = uy * sp * Math.cos(pitch), vz = sp * Math.sin(pitch);
      for (let i = 0; i < 900; i++) {
        const v = Math.hypot(vx, vy, vz), dec = 1 / (1 + C.DRAG * v / 60);
        vx *= dec; vy *= dec; vz = vz * dec - C.G / 60; x += vx / 60; y += vy / 60; z += vz / 60;
        if (z <= 0) return Math.hypot(x - x0, y - y0);
      }
      return 1e9;
    };
    // a smash comes down steeply; a clear goes up and over: search the right branch
    let lo = shot.high ? 0.25 : -1.2, hi = shot.high ? 0.85 : 0.6; // (a clear: the lower of the two arcs that reach)
    const grows = landAt(hi) > landAt(lo);
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if ((landAt(m) < d) === grows) lo = m; else hi = m; }
    const p = (lo + hi) / 2;
    return { x: x0, y: y0, z: z0, vx: ux * sp * Math.cos(p), vy: uy * sp * Math.cos(p), vz: sp * Math.sin(p), over: 0 };
  }

  function fire(k = kind) {
    kind = k; rp = null;
    const shot = SHOTS[k], power = S.power;
    const kmh = k === 'smash' ? 170 + 210 * power : shot.kmh;
    sim.events = []; sim.tick = 0; sim.ball = launch(shot, kmh);
    flying = true; acc = 0; shuttle.visible = true; shuttleFx.reset();
    const at = new THREE.Vector3(...W2(shot.from[0], shot.from[1], shot.from[2]));
    shuttleFx.hit(shot.color, k === 'smash' ? 0.6 + power : 0.15);
    const glass = S.glass === 'always' || (S.glass === 'auto' && power >= 0.7);
    if (k === 'smash') { smashFx.contact(at, power, shot.color, glass); kick = Math.max(kick, 0.06 + 0.16 * power); }
    lastShot = { kind: k, kmh, power };
    draw();
  }
  function land() {
    flying = false; landedAt = performance.now();
    const b = sim.ball;
    if (kind === 'smash') {
      smashFx.slam(b.x, b.y, S.power);
      kick = Math.max(kick, 0.12 + 0.14 * S.power);
    }
  }
  function tick() {
    if (!flying) return;
    const landed = BM._stepBall(sim);
    sim.events.length = 0;
    if (landed) land();
  }

  // ---------------------------------------------------------------- the smash replay
  // The stroke lab's case, frame by frame on the real athlete (as the animation player does); at
  // the contact frame the renderer's smash effects fire, and the crack when the shuttle lands.
  const SC = strokeCases(BM), cases = {};
  const DT = 1 / 60;
  let rp = null; // { frames, i, kc, rec, slot, hit, landed }
  function swingFrames(name) {
    if (cases[name]) return cases[name];
    const cs = SC.build(SC.CASES.find(c => c.name === name)), slot = cs.slot;
    const frames = cs.frames.map(fr => {
      const rw = fr.row, p = new Array(21).fill(0);
      p[0] = rw.x; p[1] = rw.y; p[2] = rw.vx; p[3] = rw.vy; p[4] = rw.fx; p[5] = rw.fy; p[6] = rw.ch; p[9] = 100;
      p[14] = rw.z; p[15] = rw.vz; p[16] = rw.squat; p[17] = rw.landT;
      const tick = 1000 + fr.k, strokes = [null, null];
      if (cs.rec && fr.k >= cs.kc - 9) strokes[slot] = Object.assign({}, cs.rec, { tick: 1000 + cs.kc });
      if (fr.k >= 0) strokes[1 - slot] = Object.assign({}, cs.opp, { tick: 1000 });
      const rv = { tick, strokes, pred: fr.k >= 0 ? { land: { x: cs.inLand.x, y: cs.inLand.y, t: 1 } } : null, hitstop: false, pointAt: null };
      return { k: fr.k, ball: fr.ball, p, rv, now: tick * 1000 / 60 };
    });
    return (cases[name] = { frames, kc: cs.kc, rec: cs.rec, slot });
  }
  const poseAt = (fr, slot) => A.update(R.debugAthleteFrame(slot, fr.p, fr.ball, fr.rv, DT, fr.now));
  function replay() {
    if (!A) return;
    flying = false; smashFx.reset(); shuttleFx.reset();
    const sw = swingFrames(SWINGS[S.swing]);
    rp = { ...sw, i: -1, hit: false, landed: false };
    resetAthlete(A); A.root.visible = true; if (foot) foot.visible = true;
    // the idle lead-in and the early charge in one go: the replay starts just before the swing
    const start = Math.max(0, sw.frames.findIndex(f => f.k === sw.kc) - 50);
    while (rp.i < start) poseAt(rp.frames[++rp.i], sw.slot);
    shuttle.visible = true;
    lastShot = { kind: S.swing === 'jump' ? 'jump smash' : 'smash', kmh: 170 + 210 * S.power, power: S.power };
    acc = 0; draw();
  }
  function replayTick() {
    if (!rp || rp.landed) return;
    if (rp.i >= rp.frames.length - 1) { rp.landed = true; landedAt = performance.now(); return; }
    const fr = rp.frames[++rp.i];
    poseAt(fr, rp.slot);
    const b = fr.ball;
    sim.ball = { x: b[0], y: b[1], z: b[2], vx: b[3], vy: b[4], vz: b[5] };
    if (fr.k === rp.kc && !rp.hit) {
      rp.hit = true;
      const at = new THREE.Vector3(...W2(rp.rec.x, rp.rec.y, rp.rec.z));
      const glass = S.glass === 'always' || (S.glass === 'auto' && S.power >= 0.7);
      shuttleFx.hit(SHOTS.smash.color, 0.6 + S.power);
      smashFx.contact(at, S.power, SHOTS.smash.color, glass);
      kick = Math.max(kick, 0.06 + 0.16 * S.power);
    } else if (rp.hit && (b[2] <= 0.03 || rp.i === rp.frames.length - 1)) {
      rp.landed = true; landedAt = performance.now();
      sim.ball.z = 0; sim.ball.vx = sim.ball.vy = sim.ball.vz = 0;
      smashFx.slam(b[0], b[1], S.power);
      kick = Math.max(kick, 0.12 + 0.14 * S.power);
    }
  }

  function setView(v) {
    S.view = VIEWS.includes(v) ? v : 'front';
    // framed on the smasher (back of the near court, x about -7, contact about 2.5 m up)
    const set = (t, p, fov = 40) => { controls.target.set(...t); camera.position.set(...p); camera.fov = fov; };
    if (S.view === 'broadcast') set([-2.2, 0.6, 0], [-13.1, 6.77, 1.42], 38);
    else if (S.view === 'front') set([-6.9, 1.55, 0.8], [-1.6, 2.0, -0.7]);
    else if (S.view === 'side') set([-6.9, 1.7, 0.8], [-6.4, 1.9, 5.2]);
    else set([-5.5, 1.8, 0.6], [-11.8, 3.0, 1.6]);
    camera.updateProjectionMatrix(); controls.update();
  }

  // ---------------------------------------------------------------- panel
  const html = `
    <button class="freplay" style="width:100%;padding:12px;font-size:15px;font-weight:800;background:#e4ff3c;color:#10141c;border-color:#e4ff3c">▶ Replay smash (R)</button>
    <h3>Swing</h3><div class="btns fsw"><button data-sw="smash">Smash</button><button data-sw="jump">Jump smash</button></div>
    <label class="row"><span>Power</span><input type="range" class="fpow" min="0" max="1" step="0.01"><output class="fpowo"></output></label>
    <div class="btns"><button class="fslow">Slow-mo (S)</button><button class="fauto">Loop (A)</button></div>
    <h3>Contact glass</h3><div class="btns fglass"></div>
    <h3>Camera (1-4)</h3><div class="btns fv"></div>
    <h3>Last</h3><div class="fr" style="line-height:1.6;font-variant-numeric:tabular-nums"></div>
    <h3>Bare shuttle flights</h3>
    <div class="btns"><button data-fs="clear">Clear</button><button data-fs="drive">Drive</button><button data-fs="smash">Smash</button></div>
    <div class="help">Replay plays the athlete's real smash; the glass, flash and shockwave fire on the contact frame and the court cracks where it lands. Power drives all of it. Contact glass "auto" only cracks from power 0.7 up, "always" on every replay.</div>`;
  let root = null, saveFn = () => {};
  function mount(el) {
    root = el; el.innerHTML = html;
    el.querySelector('.fglass').innerHTML = ['auto', 'always', 'never'].map(g => `<button data-fg="${g}">${g}</button>`).join('');
    el.querySelector('.fv').innerHTML = VIEWS.map(v => `<button data-fv="${v}">${v}</button>`).join('');
    el.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.classList.contains('freplay')) replay();
      if (b.dataset.sw) { S.swing = b.dataset.sw; replay(); }
      if (b.classList.contains('fauto')) S.auto = !S.auto;
      if (b.classList.contains('fslow')) S.slow = S.slow < 1 ? 1 : 0.2;
      if (b.dataset.fg) S.glass = b.dataset.fg;
      if (b.dataset.fs) fire(b.dataset.fs);
      if (b.dataset.fv) setView(b.dataset.fv);
      draw(); saveFn();
    });
    el.querySelector('.fpow').oninput = e => { S.power = +e.target.value; draw(); saveFn(); };
    draw();
  }
  function draw() {
    if (!root) return;
    root.querySelector('.fpow').value = S.power; root.querySelector('.fpowo').textContent = S.power.toFixed(2);
    for (const b of root.querySelectorAll('[data-fg]')) b.classList.toggle('on', b.dataset.fg === S.glass);
    for (const b of root.querySelectorAll('[data-fv]')) b.classList.toggle('on', b.dataset.fv === S.view);
    for (const b of root.querySelectorAll('[data-sw]')) b.classList.toggle('on', b.dataset.sw === S.swing);
    root.querySelector('.fauto').classList.toggle('on', S.auto); root.querySelector('.fslow').classList.toggle('on', S.slow < 1);
    root.querySelector('.fr').innerHTML = lastShot ? `${lastShot.kind} at ${Math.round(lastShot.kmh)} km/h${lastShot.kind.includes('smash') ? `, power ${lastShot.power.toFixed(2)}` : ''}` : '—';
  }

  // ---------------------------------------------------------------- per frame
  function update(dt) {
    if (!on) return;
    const d = dt * S.slow;
    acc += d; let n = 0;
    while (acc >= 1 / 60 && n < 8) { acc -= 1 / 60; n++; if (rp) replayTick(); else tick(); }
    if (rp && n) { A.h.root.updateMatrixWorld(true); if (foot) { const r = A.root.position; foot.position.set(r.x, 0.008, r.z); } }
    const b = sim.ball || { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    shuttle.position.set(...W2(b.x, b.y, b.z));
    const sp = Math.hypot(b.vx, b.vy, b.vz);
    if (sp > 0.5) shuttle.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(...W2(b.vx, b.vy, b.vz)).normalize());
    const h = renderer.domElement.clientHeight || 900, dist = camera.position.distanceTo(shuttle.position);
    const pxPerM = h / (2 * dist * Math.tan(camera.fov * Math.PI / 360));
    // yours to hit: on your side, in reach height, still in the air
    const live = flying || !!(rp && !rp.landed);
    const hittable = flying && b.x < -1 && b.x > -6.2 && b.z > 0.4 && b.z < 2.6;
    shuttleFx.update({ dt: d, camera, pos: shuttle.position, speed: sp, pxPerM, live, coming: b.vx < 0, hittable, host: renderer.domElement.parentElement });
    smashFx.update(d, camera);
    if (S.auto && !flying && (!rp || rp.landed) && performance.now() - landedAt > 1400) { if (A) replay(); else fire(kind); }
    kick *= Math.pow(0.86, dt * 60);
  }
  // the camera punch, around the render only (the orbit controls never see it)
  function beforeRender() { if (on && kick > 0.002) { kickOff.set((Math.random() - 0.5) * kick * 2, (Math.random() - 0.5) * kick * 1.2, 0); camera.position.add(kickOff); } else kickOff.set(0, 0, 0); }
  function afterRender() { camera.position.sub(kickOff); kickOff.set(0, 0, 0); if (on) { const b = sim.ball; smashFx.afterRender(camera, b ? new THREE.Vector3(...W2(b.vx, b.vy, b.vz)) : null); } }
  function activate(v) {
    on = v;
    if (v) { setView(S.view); shuttle.visible = true; if (A) replay(); }
    else { flying = false; rp = null; smashFx.reset(); shuttleFx.reset(); shuttleFx.beacon.visible = shuttleFx.glint.visible = false; }
  }
  addEventListener('keydown', e => {
    if (!on || (e.target.tagName === 'INPUT' && e.target.type !== 'range')) return;
    if (e.key === 'r' || e.key === 'R' || e.key === 'f' || e.key === 'F') { if (A) replay(); else fire('smash'); }
    else if (e.key >= '1' && e.key <= '4') { setView(VIEWS[+e.key - 1]); draw(); saveFn(); }
    else if (e.key === 'a' || e.key === 'A') { S.auto = !S.auto; draw(); saveFn(); }
    else if (e.key === 's' || e.key === 'S') { S.slow = S.slow < 1 ? 1 : 0.2; draw(); saveFn(); }
  }, true);

  return { S, mount, update, beforeRender, afterRender, activate, fire, replay, setView, onSave(fn) { saveFn = fn; }, state: () => ({ ...S }), debug: () => ({ flying, replay: rp && { i: rp.i, k: rp.frames[rp.i]?.k, kc: rp.kc, hit: rp.hit, landed: rp.landed }, lastShot, ball: { ...sim.ball }, stats: smashFx.stats() }) };
}
