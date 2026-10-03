// Office Badminton — the heat lab (/badminton/heat), with a footstep sound check and a net tester tab. The real renderer, the real athlete and the
// real heat aura, without a match: a heat slider, the tier-up pop on demand, looping movement,
// an orbit camera with presets, and every number of the aura's look on a slider. Presets switch
// whole looks; "Copy style" puts the current look on the clipboard as JSON (HEAT_STYLE in
// heat-vfx.js takes it as is). The lab remembers its settings and reloads when the code changes.
import { MOTION_CASES } from './labcases.js';
import { motionFrames, resetAthlete } from './motionlab.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HEAT_STYLE, HEAT_PRESETS } from './heat-vfx.js';
import { heatTier, HEAT_LABELS } from './heat-flow.mjs';
import { Sound } from './audio.js';
import { createNetTester } from './netlab.js';
import { createFxTester } from './fxlab.js';

const DT = 1 / 60;
const POSES = ['stand still + split steps', 'run 90', 'sprint 0', 'corner net-fh', 'corner rear-bh', 'circle cw'];
const SLIDERS = [
  ['flames', 'Real flames', 0, 2], ['flameSize', 'Flame size', 0.3, 2.5], ['embers', 'Embers', 0, 3],
  ['glow', 'Glow', 0, 2.5], ['thickness', 'Thickness', 0, 3], ['fireThickness', 'Fire thickness', 0, 3],
  ['wisps', 'Flame wisps', 0, 3], ['bands', 'Soft ↔ cel bands', 0, 1], ['cover', 'Light ↔ paint', 0, 1],
  ['rim', 'Body rim', 0, 3], ['rimSharp', 'Rim soft ↔ crisp', 0, 1], ['pool', 'Floor light', 0, 3],
  ['speed', 'Flicker speed', 0, 3], ['breathe', 'Pulse', 0, 3],
];
const COLORS = [['core', 'Core'], ['mid', 'Mid'], ['outer', 'Outer']];
const KEY = 'obm_heatlab';

export function startHeatLab(R) {
  const ctx = R.labCtx(true);
  const { THREE, players, feet, scene, camera, renderer, shuttle } = ctx;
  const hv = R.debugPresentation().heatVfx;
  const A = players[0];
  players[1].root.visible = false; feet[1].visible = false; shuttle.visible = false;
  // the match's own markers (aim rings, landing marks, trail, glints) are driven by the game loop,
  // which stands aside here: hide them rather than leave them parked at the origin
  for (const o of scene.children) {
    const atOrigin = o.position.lengthSq() < 0.01 || (Math.abs(o.position.x) < 0.01 && Math.abs(o.position.z) < 0.01 && o.position.y < 0.05);
    if (!atOrigin) continue;
    if (o.isSprite || o.isLine || o.isPoints || o.geometry?.type === 'RingGeometry' || (o.isMesh && o.material?.isMeshBasicMaterial && o.geometry?.type === 'PlaneGeometry' && o.renderOrder === 2)) o.visible = false;
  }
  A.setIdentity('HEAT LAB', 0);

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { }
  const S = {
    heat: saved.heat ?? 100, pose: POSES.includes(saved.pose) ? saved.pose : POSES[0], playing: saved.playing ?? true,
    slow: saved.slow ?? 1, cycle: false, view: saved.view || 'close', preset: saved.preset || 'Ember glow',
    style: { ...HEAT_STYLE, ...(saved.style || {}) },
    mode: ['net', 'fx'].includes(saved.mode) ? saved.mode : 'heat',
  };
  hv.setStyle(S.style);
  let netLab = null, fxLab = null; // the net and FX tester tabs, created with the panel below
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ mode: S.mode, net: netLab?.state(), fx: fxLab?.state(), sound: S.sound, heat: S.heat, pose: S.pose, playing: S.playing, slow: S.slow, view: S.view, preset: S.preset, style: S.style })); } catch { } };

  // ---------------------------------------------------------------- movement, looped
  let frames = [], rows = [], fi = -1;
  function loadPose(name) {
    const def = MOTION_CASES.find(c => c.name === name) || MOTION_CASES[0];
    const built = motionFrames({ ...def, slot: 0 });
    frames = built.map(fr => fr.f); rows = built.map(fr => fr.row); fi = -1;
    resetAthlete(A); stepPose(); setView(S.view);
  }
  function stepPose() {
    if (!frames.length) return;
    if (++fi >= frames.length) { fi = 0; resetAthlete(A); }
    A.update(frames[fi]);
    A.h.root.updateMatrixWorld(true);
    const r = A.root.position; feet[0].position.set(r.x, 0.008, r.z);
  }

  // ---------------------------------------------------------------- camera
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.15; controls.minDistance = 0.6; controls.maxDistance = 30;
  const focus = () => { const r = A.root.position; return new THREE.Vector3(r.x, 0.95, r.z); };
  let lastFocus = null;
  function setView(v) {
    S.view = v;
    const t = focus(), yaw = A.yaw || 0, fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -Math.cos(yaw), rz = Math.sin(yaw);
    const off = {
      close: [fx * 3.1 + rx * 2.3, 0.2, fz * 3.1 + rz * 2.3], front: [fx * 3.4, 0.15, fz * 3.4], side: [rx * 3.4, 0.15, rz * 3.4],
      back: [-fx * 3, 0.5, -fz * 3], broadcast: [-9.9, 5.7, 0],
    }[v] || [2, 0.4, 2];
    controls.target.copy(t); camera.position.set(t.x + off[0], t.y + off[1], t.z + off[2]);
    camera.fov = v === 'broadcast' ? 38 : 40; camera.updateProjectionMatrix(); controls.update(); lastFocus = t.clone();
    draw(); save();
  }

  // ---------------------------------------------------------------- the panel
  const css = document.createElement('style');
  css.textContent = `
  #home,#hud,#labels,#screen,#menu,#conn,#touchui,#charge,#powerTip,#dash,#swCv{display:none!important}
  #hl{position:fixed;inset:0;pointer-events:none;font:13px/1.35 Barlow, system-ui, sans-serif;color:#e8ecf2;z-index:50}
  #hl .pn{pointer-events:auto;position:absolute;top:10px;bottom:10px;width:290px;background:rgba(10,13,20,.9);border:1px solid #232a38;border-radius:8px;padding:10px 12px;overflow:auto}
  #hl .l{left:10px}#hl .r{right:10px}
  #hl h3{margin:12px 0 6px;color:#e4ff3c;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
  #hl h3:first-child{margin-top:0}
  #hl .row{display:grid;grid-template-columns:104px 1fr 40px;align-items:center;gap:8px;margin:5px 0}
  #hl .row span{color:#9aa3b5}#hl .row output{text-align:right;font-variant-numeric:tabular-nums}
  #hl input[type=range]{width:100%;accent-color:#e4ff3c}
  #hl input[type=color]{width:100%;height:24px;border:1px solid #2c3546;border-radius:4px;background:#0d1119;padding:1px}
  #hl .btns{display:flex;flex-wrap:wrap;gap:5px}
  #hl button{background:#1b2230;color:#e8ecf2;border:1px solid #2c3546;border-radius:5px;padding:5px 9px;cursor:pointer;font:inherit}
  #hl button:hover{border-color:#556}#hl button.on{background:#e4ff3c;color:#10141c;border-color:#e4ff3c;font-weight:700}
  #hl .big{display:flex;align-items:baseline;gap:10px;margin:2px 0 4px}
  #hl .big b{font-size:30px;font-variant-numeric:tabular-nums}#hl .big i{font-style:normal;font-weight:700;letter-spacing:.06em}
  #hl .heat{width:100%;accent-color:#ff8a1f}
  #hl .tick{display:flex;justify-content:space-between;color:#6c7586;font-size:11px}
  #hl .note{position:absolute;left:50%;top:14px;transform:translateX(-50%);background:#e4ff3c;color:#10141c;padding:4px 10px;border-radius:4px;font-weight:700;display:none}
  #hl .help{color:#6c7586;font-size:12px;margin-top:12px}
  #hl .tabs{display:flex;gap:4px;margin:-2px 0 10px}#hl .tabs button{flex:1;font-weight:700}
  #hl.net .r,#hl.fx .r{display:none}#hl .mn,#hl .mf{display:none}#hl.net .mn,#hl.fx .mf{display:block}#hl.net .mh,#hl.fx .mh{display:none}`;
  document.head.appendChild(css);
  const root = document.createElement('div'); root.id = 'hl';
  root.innerHTML = `
    <div class="pn l">
      <div class="tabs"><button data-m="heat">Heat &amp; sound</button><button data-m="net">Net</button><button data-m="fx">Smash &amp; shuttle FX</button></div>
      <div class="mn"></div><div class="mf"></div>
      <div class="mh">
      <h3>Heat</h3>
      <div class="big"><b class="hv"></b><i class="tier"></i></div>
      <input class="heat" type="range" min="0" max="100" step="1">
      <div class="tick"><span>0</span><span>30 warm</span><span>60 hot</span><span>85 fire</span><span>100</span></div>
      <div class="btns" style="margin-top:8px"><button class="pop">Tier-up pop (P)</button><button class="cyc">Auto cycle (C)</button></div>
      <h3>Movement</h3><div class="btns poses"></div>
      <div class="btns" style="margin-top:6px"><button class="play">Pause (Space)</button><button class="slow">Slow-mo (S)</button></div>
      <h3>Camera</h3><div class="btns views"></div>
      <h3>Footstep sounds</h3>
      <div class="btns"><button class="snd">Live footsteps: on</button></div>
      <div class="btns sounds" style="margin-top:6px"></div>
      <div class="help">Live footsteps follow the movement above: "corner net-fh" lunges (squeal), "circle" and "corner" cut (scuff + squeak), "stand still" split-steps (taps).</div>
      <div class="help">Drag to orbit · wheel to zoom · right-drag to pan. 1–5 switch cameras.</div>
      </div>
    </div>
    <div class="pn r">
      <h3>Style presets</h3><div class="btns presets"></div>
      <h3>Look</h3><div class="sl"></div>
      <h3>Colours</h3><div class="cl"></div>
      <div class="btns" style="margin-top:12px"><button class="copy">Copy style JSON</button><button class="reset">Reset preset</button></div>
    </div>
    <div class="note"></div>`;
  document.body.appendChild(root);
  const $ = q => root.querySelector(q);
  const noteEl = $('.note');
  const note = (t, ms = 1600) => { noteEl.textContent = t; noteEl.style.display = 'block'; clearTimeout(note.h); note.h = setTimeout(() => { noteEl.style.display = 'none'; }, ms); };

  $('.sounds').innerHTML = [['tap', 'Tap'], ['step', 'Step'], ['cut', 'Cut'], ['lunge', 'Lunge'], ['land', 'Land']].map(([k, l]) => `<button data-a="${k}">${l}</button>`).join('');
  S.sound = saved.sound ?? true;
  const drawSound = () => { $('.snd').textContent = `Live footsteps: ${S.sound ? 'on' : 'off'}`; $('.snd').classList.toggle('on', S.sound); };
  $('.snd').onclick = () => { S.sound = !S.sound; drawSound(); save(); };
  if (Sound.muted) Sound.toggle(); // the lab is for listening
  Sound.hold(true); // the game loop's own sound update stands aside
  drawSound();
  $('.poses').innerHTML = POSES.map(p => `<button data-p="${p}">${p.replace(' + split steps', '')}</button>`).join('');
  $('.views').innerHTML = ['close', 'front', 'side', 'back', 'broadcast'].map(v => `<button data-v="${v}">${v}</button>`).join('');
  $('.presets').innerHTML = Object.keys(HEAT_PRESETS).map(p => `<button data-s="${p}">${p}</button>`).join('');
  $('.sl').innerHTML = SLIDERS.map(([k, label, lo, hi]) => `<label class="row"><span>${label}</span><input type="range" data-k="${k}" min="${lo}" max="${hi}" step="0.01"><output data-o="${k}"></output></label>`).join('');
  $('.cl').innerHTML = COLORS.map(([k, label]) => `<label class="row"><span>${label}</span><input type="color" data-c="${k}"><output></output></label>`).join('');

  function applyStyle(next, preset) {
    Object.assign(S.style, next); hv.setStyle(S.style);
    if (preset !== undefined) S.preset = preset;
    draw(); save();
  }
  function draw() {
    $('.hv').textContent = Math.round(S.heat);
    const t = heatTier(S.heat, 0);
    $('.tier').textContent = HEAT_LABELS[t]; $('.tier').style.color = ['#8b93a4', '#ffc46b', '#ff8a1f', '#ff4a10'][t];
    $('.heat').value = S.heat;
    for (const b of root.querySelectorAll('[data-p]')) b.classList.toggle('on', b.dataset.p === S.pose);
    for (const b of root.querySelectorAll('[data-v]')) b.classList.toggle('on', b.dataset.v === S.view);
    for (const b of root.querySelectorAll('[data-s]')) b.classList.toggle('on', b.dataset.s === S.preset);
    for (const i of root.querySelectorAll('[data-k]')) { i.value = S.style[i.dataset.k]; root.querySelector(`[data-o="${i.dataset.k}"]`).textContent = (+S.style[i.dataset.k]).toFixed(2); }
    for (const i of root.querySelectorAll('[data-c]')) i.value = S.style[i.dataset.c];
    $('.play').textContent = S.playing ? 'Pause (Space)' : 'Play (Space)';
    $('.play').classList.toggle('on', !S.playing); $('.slow').classList.toggle('on', S.slow < 1); $('.cyc').classList.toggle('on', S.cycle);
  }

  $('.heat').oninput = e => { S.heat = +e.target.value; S.cycle = false; draw(); save(); };
  $('.pop').onclick = () => hv.pop(0);
  $('.cyc').onclick = () => { S.cycle = !S.cycle; draw(); };
  $('.play').onclick = () => { S.playing = !S.playing; draw(); save(); };
  $('.slow').onclick = () => { S.slow = S.slow < 1 ? 1 : 0.25; draw(); save(); };
  // ---------------------------------------------------------------- the net tester tab
  netLab = createNetTester({ THREE, R, BM: window.BM, scene, camera, controls, shuttle, saved: saved.net || {} });
  netLab.mount($('.mn'), note); netLab.onSave(() => save());
  fxLab = createFxTester({ THREE, R, BM: window.BM, scene, camera, controls, shuttle, renderer, athlete: A, foot: feet[0], saved: saved.fx || {} });
  fxLab.mount($('.mf')); fxLab.onSave(() => save());
  function setMode(m) {
    S.mode = m; root.classList.toggle('net', m === 'net'); root.classList.toggle('fx', m === 'fx');
    for (const b of root.querySelectorAll('[data-m]')) b.classList.toggle('on', b.dataset.m === m);
    const heat = m === 'heat';
    A.root.visible = heat; feet[0].visible = heat;
    if (!heat) hv.reset();
    netLab.activate(m === 'net'); fxLab.activate(m === 'fx');
    if (heat) { shuttle.visible = false; if (frames.length) { resetAthlete(A); fi = -1; stepPose(); } setView(S.view); }
    save();
  }
  root.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.m) setMode(b.dataset.m);
    if (b.dataset.p) { S.pose = b.dataset.p; loadPose(S.pose); draw(); save(); }
    if (b.dataset.v) setView(b.dataset.v);
    if (b.dataset.a) Sound.audition(b.dataset.a);
    if (b.dataset.s) applyStyle({ ...HEAT_STYLE, ...HEAT_PRESETS[b.dataset.s] }, b.dataset.s);
  });
  root.addEventListener('input', e => {
    const k = e.target.dataset.k, c = e.target.dataset.c;
    if (k) applyStyle({ [k]: +e.target.value });
    if (c) applyStyle({ [c]: e.target.value });
  });
  $('.reset').onclick = () => applyStyle({ ...HEAT_STYLE, ...(HEAT_PRESETS[S.preset] || {}) });
  $('.copy').onclick = async () => {
    const json = JSON.stringify(S.style, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v);
    try { await navigator.clipboard.writeText(json); note('Style copied'); } catch { prompt('Style JSON', json); }
  };
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    if (S.mode !== 'heat') return; // the net and FX testers have their own keys
    const k = e.key;
    if (k === ' ') { S.playing = !S.playing; draw(); save(); e.preventDefault(); }
    else if (k === 'p' || k === 'P') hv.pop(0);
    else if (k === 'c' || k === 'C') { S.cycle = !S.cycle; draw(); }
    else if (k === 's' || k === 'S') { S.slow = S.slow < 1 ? 1 : 0.25; draw(); save(); }
    else if (k >= '1' && k <= '5') setView(['close', 'front', 'side', 'back', 'broadcast'][+k - 1]);
  }, true);

  // ---------------------------------------------------------------- the loop
  let lastT = performance.now(), lastT2 = lastT, acc = 0, cycleT = 0;
  (function loop(now) {
    const dt = Math.min(0.1, (now - lastT) / 1000) * S.slow; lastT = now;
    if (S.mode === 'net') {
      netLab.update(Math.min(0.1, (now - lastT2) / 1000)); lastT2 = now;
      controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); return;
    }
    if (S.mode === 'fx') {
      fxLab.update(Math.min(0.1, (now - lastT2) / 1000)); lastT2 = now;
      controls.update(); fxLab.beforeRender(); renderer.render(scene, camera); fxLab.afterRender(); requestAnimationFrame(loop); return;
    }
    lastT2 = now;
    if (S.cycle) { cycleT += dt; S.heat = Math.round(50 - 50 * Math.cos(cycleT * 0.6)); draw(); }
    if (S.playing) {
      acc += dt; let n = 0;
      while (acc >= DT && n < 6) {
        acc -= DT; n++; stepPose();
        // the real footstep path: the same contact tracker and voices as a match
        Sound.frame({ dt: DT, players: [rows[fi], null], athletes: [A, null], mySlot: 0, movement: S.sound, camera: R.debugCam(), live: true, paused: false, lab: true });
      }
    }
    // the camera keeps its offset from the athlete as they move
    const t = focus();
    if (lastFocus) { const d = t.clone().sub(lastFocus); camera.position.add(d); controls.target.add(d); }
    lastFocus = t;
    hv.update(dt, [S.heat, 0], players, camera, true);
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  })(lastT);

  // live reload when the code changes (the server's build id moves); the settings are kept
  const build0 = (window.__MANIFEST && window.__MANIFEST.build) || null;
  setInterval(async () => {
    try {
      const j = await (await fetch('/api/build', { cache: 'no-store' })).json();
      if (build0 && j.build && j.build !== build0) { save(); note('code changed: reloading', 3000); setTimeout(() => location.reload(), 150); }
    } catch { /* the server restarting: try again */ }
  }, 1000);

  loadPose(S.pose); draw(); setMode(S.mode);
  return { S, hv, setView, applyStyle, Sound, netLab, fxLab, setMode, get row() { return rows[fi]; } };
}
