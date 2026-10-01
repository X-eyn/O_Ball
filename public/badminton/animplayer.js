// Office Badminton — the animation player (/badminton/anim). Every movement case (motion lab) and
// every shuttle case (stroke lab) from labcases.js, played on the real renderer and the real
// athlete, frame by frame: play / pause, step, scrub, slow motion, loop, an orbit camera with
// presets, and a live readout of what the body layers decided this frame. A case is a fixed list of
// frame inputs, so any frame is exact: scrubbing back resets the athlete and replays from frame 0.
// The page reloads itself when the code changes (the server's build id moves) and comes back to the
// same case, frame, speed and camera.
//   keys: Space play/pause · Left/Right a frame (Shift: 10) · Home/End · [ ] speed · L loop
//         1 side · 2 front · 3 back · 4 top · 5 behind (the game camera) · F follow · / search
import { MOTION_CASES, strokeCases } from './labcases.js';
import { motionFrames, resetAthlete } from './motionlab.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const SPEEDS = [0.05, 0.1, 0.25, 0.5, 1, 2];
const DT = 1 / 60;
const fmt = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : '-');

export function startPlayer(R, opts = {}) {
  const ctx = R.labCtx(true);
  const { THREE, players, feet, scene, camera, renderer, shuttle } = ctx;
  const BM = window.BM;
  const SC = strokeCases(BM);
  const built = new Map(); // stroke case -> its built frames (the flight solve takes a moment)

  // ---------------------------------------------------------------- the cases
  const cases = [
    ...MOTION_CASES.map(c => ({ group: 'Movement', name: c.name, kind: 'motion', def: c })),
    ...SC.CASES.map(c => ({ group: 'Strokes', name: c.name, kind: 'stroke', def: c })),
  ];
  const byName = new Map(cases.map(c => [c.kind + ':' + c.name, c]));

  // ---------------------------------------------------------------- state
  const S = { cur: null, frames: [], i: -1, playing: false, speed: 1, loop: true, follow: true, acc: 0, view: 'side', building: false };

  // ---------------------------------------------------------------- overlays in the scene
  const ovl = new THREE.Group(); scene.add(ovl);
  const disc = (r, col, op = 0.9) => { const m = new THREE.Mesh(new THREE.CircleGeometry(r, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: op, depthWrite: false })); m.renderOrder = 5; ovl.add(m); return m; };
  const footMk = { L: disc(0.07, 0x37d67a), R: disc(0.07, 0x37d67a) };
  const simMk = disc(0.12, 0x4aa8ff, 0.55);
  const contactMk = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffd34d })); ovl.add(contactMk);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.52, 0.56, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false })); ovl.add(ring);

  // ---------------------------------------------------------------- the camera
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.15; controls.target.set(0, 1, 0);
  controls.minDistance = 0.8; controls.maxDistance = 30;
  let lastFollow = null;
  const athlete = () => (S.cur ? players[S.cur.def.slot || 0] : players[0]);
  const focus = () => { const r = athlete().root.position; return new THREE.Vector3(r.x, 1.15 + Math.max(0, r.y) * 0.8, r.z); };
  function setView(v) {
    S.view = v;
    const A = athlete(), t = focus(), yaw = A.yaw || 0;
    const fx = Math.sin(yaw), fz = Math.cos(yaw); // facing
    const rx = -Math.cos(yaw), rz = Math.sin(yaw);  // the body's right
    const off = { side: [rx * 4.8, 0.3, rz * 4.8], front: [fx * 5, 0.35, fz * 5], back: [-fx * 5, 0.5, -fz * 5], top: [0.01, 6.5, 0.01], behind: [-fx * 5.5, 2.4, -fz * 5.5] }[v] || [4.8, 0.3, 0];
    controls.target.copy(t); camera.position.set(t.x + off[0], t.y + off[1], t.z + off[2]);
    camera.fov = 40; camera.updateProjectionMatrix(); controls.update(); lastFollow = t.clone();
  }

  // ---------------------------------------------------------------- loading a case
  function build(c) {
    if (c.kind === 'motion') return motionFrames(c.def).map(fr => ({ t: fr.t, label: `t ${fmt(fr.t)} s`, ball: fr.ball, sim: fr.p, row: fr.row, f: fr.f, motion: true }));
    if (!built.has(c.name)) built.set(c.name, SC.build(c.def));
    const cs = built.get(c.name), slot = cs.slot;
    return cs.frames.map(fr => {
      const rw = fr.row, p = new Array(21).fill(0);
      p[0] = rw.x; p[1] = rw.y; p[2] = rw.vx; p[3] = rw.vy; p[4] = rw.fx; p[5] = rw.fy; p[6] = rw.ch; p[9] = 100;
      p[14] = rw.z; p[15] = rw.vz; p[16] = rw.squat; p[17] = rw.landT;
      const tick = 1000 + fr.k, strokes = [null, null];
      if (cs.rec && fr.k >= cs.kc - 9) strokes[slot] = Object.assign({}, cs.rec, { tick: 1000 + cs.kc });
      if (fr.k >= 0) strokes[1 - slot] = Object.assign({}, cs.opp, { tick: 1000 });
      const rv = { tick, strokes, pred: fr.k >= 0 ? { land: { x: cs.inLand.x, y: cs.inLand.y, t: 1 } } : null, hitstop: false, pointAt: null };
      return { t: fr.u, label: `u ${fr.u >= 0 ? '+' : ''}${fmt(fr.u)} s${fr.k === cs.kc ? '  CONTACT' : ''}`, ball: fr.ball, sim: { x: rw.x, y: rw.y, z: rw.z }, p, rv, now: tick * 1000 / 60, contact: cs.rec, kc: cs.kc, k: fr.k, slot };
    });
  }
  function load(c, frame = 0) {
    S.cur = c; S.building = true; drawList(); readout();
    // (a stroke case's flight is solved on first use: let the "building" note paint first)
    setTimeout(() => {
      try { S.frames = build(c); } catch (e) { S.frames = []; note('could not build: ' + e.message); }
      S.building = false;
      const slot = c.def.slot || 0;
      players.forEach((A, i) => { A.root.visible = i === slot; if (feet && feet[i]) feet[i].visible = i === slot; });
      players[slot].setIdentity('LAB', slot);
      S.i = -1; resetAthlete(players[slot]);
      seek(Math.min(frame, S.frames.length - 1));
      bar.max = Math.max(0, S.frames.length - 1);
      if (!S.camInit) setView(S.view);
      S.camInit = false;
      drawList(); saveHash();
    }, 0);
  }
  // one frame of the athlete
  function apply(fr) {
    const A = athlete();
    if (fr.motion) A.update(fr.f);
    else A.update(R.debugAthleteFrame(fr.slot, fr.p, fr.ball, fr.rv, DT, fr.now));
  }
  function seek(i) {
    if (!S.frames.length) return;
    i = Math.max(0, Math.min(S.frames.length - 1, i));
    if (i < S.i) { S.i = -1; resetAthlete(athlete()); } // backwards: replay from the start
    while (S.i < i) apply(S.frames[++S.i]);
    athlete().h.root.updateMatrixWorld(true);
    placeOverlays(); readout();
    bar.value = S.i;
  }

  // ---------------------------------------------------------------- overlays and readout
  function placeOverlays() {
    const fr = S.frames[S.i]; if (!fr) return;
    const A = athlete();
    const b = fr.ball;
    if (b && shuttle) { shuttle.position.set(b[0], b[2], b[1]); shuttle.visible = true; }
    if (fr.sim) simMk.position.set(fr.sim.x, 0.012, fr.sim.y);
    ring.position.set(A.root.position.x, 0.011, A.root.position.z);
    if (feet) { const sl = S.cur.def.slot || 0; feet[sl].position.set(A.root.position.x, 0.008, A.root.position.z); }
    const F = A.fw && A.fw.feet;
    for (const k of ['L', 'R']) {
      const m = footMk[k], ft = F && F[k];
      m.visible = !!ft;
      if (ft) { m.position.set(ft.x, 0.014, ft.z); m.material.color.setHex(ft.st === 'plant' ? 0x37d67a : 0xff9d3c); }
    }
    contactMk.visible = !!(fr.contact);
    if (fr.contact) contactMk.position.set(fr.contact.x, fr.contact.z, fr.contact.y);
  }
  function readout() {
    const fr = S.frames[S.i], A = athlete(), fw = A.fw;
    const rows = [];
    if (S.cur) rows.push(['case', `${S.cur.group} · ${S.cur.name}${S.cur.def.slot ? ' (far side)' : ''}`]);
    if (S.building) rows.push(['', 'building the case…']);
    if (fr) {
      rows.push(['frame', `${S.i} / ${S.frames.length - 1}`], ['time', fr.label]);
      const row = fr.motion ? fr.row : fr.p;
      if (row) rows.push(['speed', `${fmt(Math.hypot(row[2] || 0, row[3] || 0))} m/s`], ['height', `${fmt(row[14] || 0)} m`]);
      if (fw) {
        rows.push(['gait', `${A.gait || '-'} · feet by ${fw.feetBy}`]);
        rows.push(['turn', `${fmt((fw.theta || 0) * 180 / Math.PI, 0)}° from the net`]);
        if (fw.feet) rows.push(['feet', ['L', 'R'].map(k => `${k} ${fw.feet[k].st}${fw.feet[k].st === 'swing' ? ' ' + fmt(fw.feet[k].su || 0) : ''}`).join(' · ')]);
        rows.push(['rhythm', fw.gOn ? `phase ${fmt(fw.gph)} · ${fmt(fw.cadenceHz, 1)} steps/s · duty ${fmt(fw.duty)}` : 'standing']);
        rows.push(['hips', `drop ${fmt(fw.drop)} m · bob ${fmt(fw.bob || 0, 3)} m`]);
      }
      const pel = A.h.bone.pelvis.getWorldPosition(new THREE.Vector3());
      rows.push(['pelvis', `${fmt(pel.y)} m`]);
      const st = A.rt ? A.rt.name : null;
      rows.push(['layers', `lunge ${fmt(A.lungeW || 0)} · jump ${fmt(A.jumpW || 0)} · dive ${fmt(A.diveW || 0)} · swing ${fmt(A.swingW || 0)}`]);
      if (!fr.motion) {
        rows.push(['stroke', st ? `${st}${A.rt.err != null ? ` · retarget miss ${fmt(A.rt.err * 100, 1)} cm` : ''}` : '-']);
        if (fr.contact) rows.push(['racket→shuttle', `${fmt(A.sweet(new THREE.Vector3()).distanceTo(new THREE.Vector3(fr.contact.x, fr.contact.z, fr.contact.y)) * 100, 1)} cm`]);
      }
    }
    info.innerHTML = rows.map(([k, v]) => `<div><b>${k}</b><span>${v}</span></div>`).join('');
    transport.querySelector('.t').textContent = fr ? fr.label : '';
    transport.querySelector('.sp').textContent = `${S.speed}×`;
    transport.querySelector('.pp').textContent = S.playing ? '❚❚' : '▶';
    transport.querySelector('.lp').classList.toggle('on', S.loop);
    transport.querySelector('.fo').classList.toggle('on', S.follow);
    for (const b of transport.querySelectorAll('[data-v]')) b.classList.toggle('on', b.dataset.v === S.view);
  }

  // ---------------------------------------------------------------- the panel
  const css = document.createElement('style');
  css.textContent = `
  #home,#hud,#labels,#screen,#menu,#conn,#touchui,#charge,#powerTip,#dash,#swCv{display:none!important}
  #ap{position:fixed;inset:0;pointer-events:none;font:13px/1.35 Barlow, system-ui, sans-serif;color:#e8ecf2;z-index:50}
  #ap .list{pointer-events:auto;position:absolute;left:10px;top:10px;bottom:72px;width:250px;background:rgba(10,13,20,.88);border:1px solid #232a38;border-radius:6px;display:flex;flex-direction:column}
  #ap .list input{margin:8px;padding:6px 8px;border-radius:4px;border:1px solid #2c3546;background:#0d1119;color:#fff}
  #ap .list .items{overflow:auto;flex:1;padding:0 4px 8px}
  #ap .grp{margin:8px 6px 2px;color:#e4ff3c;font-weight:700;letter-spacing:.06em;font-size:11px;text-transform:uppercase}
  #ap .it{padding:3px 8px;border-radius:3px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #ap .it:hover{background:#1b2230}#ap .it.on{background:#e4ff3c;color:#10141c;font-weight:700}
  #ap .info{position:absolute;right:10px;top:10px;width:330px;background:rgba(10,13,20,.88);border:1px solid #232a38;border-radius:6px;padding:8px 10px}
  #ap .info div{display:flex;gap:8px;padding:1px 0}#ap .info b{width:96px;flex:none;color:#8b93a4;font-weight:600}
  #ap .tr{pointer-events:auto;position:absolute;left:10px;right:10px;bottom:10px;height:52px;background:rgba(10,13,20,.92);border:1px solid #232a38;border-radius:6px;display:flex;align-items:center;gap:6px;padding:0 10px}
  #ap .tr button{background:#1b2230;color:#e8ecf2;border:1px solid #2c3546;border-radius:4px;padding:4px 9px;cursor:pointer;font:inherit;min-width:32px}
  #ap .tr button.on{background:#e4ff3c;color:#10141c;border-color:#e4ff3c}
  #ap .tr input[type=range]{flex:1;accent-color:#e4ff3c}
  #ap .tr .t{width:150px;text-align:right;font-variant-numeric:tabular-nums}
  #ap .tr .sp{width:44px;text-align:center}
  #ap .note{position:absolute;left:50%;top:14px;transform:translateX(-50%);background:#e4ff3c;color:#10141c;padding:4px 10px;border-radius:4px;font-weight:700;display:none}
  #ap .help{position:absolute;right:10px;bottom:72px;width:330px;color:#8b93a4;font-size:12px;background:rgba(10,13,20,.7);border-radius:6px;padding:6px 10px}
  #ap .legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin:0 4px 0 8px;vertical-align:-1px}`;
  document.head.appendChild(css);
  const root = document.createElement('div'); root.id = 'ap';
  root.innerHTML = `<div class="list"><input placeholder="Search cases ( / )" spellcheck="false"><div class="items"></div></div>
    <div class="info"></div>
    <div class="help">Space play · ←/→ frame (Shift ×10) · [ ] speed · L loop · 1–5 camera · F follow · drag to orbit, wheel to zoom<div class="legend"><i style="background:#37d67a"></i>foot planted<i style="background:#ff9d3c"></i>foot swinging<i style="background:#4aa8ff"></i>sim position<i style="background:#ffd34d"></i>contact point</div></div>
    <div class="note"></div>
    <div class="tr">
      <button class="b0" title="first frame (Home)">⏮</button><button class="bm" title="back a frame (←)">◀</button><button class="pp" title="play / pause (Space)">▶</button><button class="bp" title="forward a frame (→)">▶|</button>
      <input type="range" min="0" max="0" value="0" step="1">
      <span class="t"></span>
      <button class="sd" title="slower ([)">−</button><span class="sp"></span><button class="su" title="faster (])">+</button>
      <button class="lp" title="loop (L)">loop</button>
      <button data-v="side">side</button><button data-v="front">front</button><button data-v="back">back</button><button data-v="top">top</button><button data-v="behind">behind</button>
      <button class="fo" title="follow the athlete (F)">follow</button>
    </div>`;
  document.body.appendChild(root);
  const search = root.querySelector('.list input'), items = root.querySelector('.items'), info = root.querySelector('.info');
  const transport = root.querySelector('.tr'), bar = transport.querySelector('input[type=range]'), noteEl = root.querySelector('.note');
  const note = (t, ms = 1600) => { noteEl.textContent = t; noteEl.style.display = 'block'; clearTimeout(note.h); note.h = setTimeout(() => { noteEl.style.display = 'none'; }, ms); };
  function drawList() {
    const q = search.value.trim().toLowerCase();
    let html = '', grp = '';
    for (const c of cases) {
      if (q && !c.name.toLowerCase().includes(q)) continue;
      if (c.group !== grp) { grp = c.group; html += `<div class="grp">${grp}</div>`; }
      html += `<div class="it${S.cur === c ? ' on' : ''}" data-k="${c.kind}:${c.name.replace(/"/g, '&quot;')}">${c.name}</div>`;
    }
    items.innerHTML = html;
  }
  search.oninput = drawList;
  items.onclick = e => { const it = e.target.closest('.it'); if (!it) return; const c = byName.get(it.dataset.k); if (c) { S.playing = false; load(c); } };
  const step = n => { S.playing = false; seek(S.i + n); saveHash(); };
  transport.querySelector('.b0').onclick = () => step(-1e9);
  transport.querySelector('.bm').onclick = () => step(-1);
  transport.querySelector('.bp').onclick = () => step(1);
  transport.querySelector('.pp').onclick = () => togglePlay();
  transport.querySelector('.sd').onclick = () => speed(-1);
  transport.querySelector('.su').onclick = () => speed(1);
  transport.querySelector('.lp').onclick = () => { S.loop = !S.loop; readout(); saveHash(); };
  transport.querySelector('.fo').onclick = () => { S.follow = !S.follow; readout(); saveHash(); };
  for (const b of transport.querySelectorAll('[data-v]')) b.onclick = () => { setView(b.dataset.v); readout(); saveHash(); };
  bar.oninput = () => { S.playing = false; seek(+bar.value); };
  bar.onchange = saveHash;
  function togglePlay() { if (!S.frames.length) return; if (!S.playing && S.i >= S.frames.length - 1) seek(0); S.playing = !S.playing; S.acc = 0; readout(); saveHash(); }
  function speed(d) { const k = Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(S.speed) + d)); S.speed = SPEEDS[k]; readout(); saveHash(); }
  addEventListener('keydown', e => {
    if (e.target === search) { if (e.key === 'Escape') search.blur(); return; }
    const k = e.key;
    if (k === ' ') { togglePlay(); e.preventDefault(); }
    else if (k === 'ArrowRight') { step(e.shiftKey ? 10 : 1); e.preventDefault(); }
    else if (k === 'ArrowLeft') { step(e.shiftKey ? -10 : -1); e.preventDefault(); }
    else if (k === 'Home') step(-1e9);
    else if (k === 'End') step(1e9);
    else if (k === '[') speed(-1);
    else if (k === ']') speed(1);
    else if (k === 'l' || k === 'L') { S.loop = !S.loop; readout(); }
    else if (k === 'f' || k === 'F') { S.follow = !S.follow; readout(); }
    else if (k >= '1' && k <= '5') { setView(['side', 'front', 'back', 'top', 'behind'][+k - 1]); readout(); saveHash(); }
    else if (k === '/') { search.focus(); e.preventDefault(); }
  }, true);

  // ---------------------------------------------------------------- the loop
  let lastT = performance.now();
  (function loop(now) {
    const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
    if (S.playing && S.frames.length) {
      S.acc += dt * S.speed;
      let n = 0;
      while (S.acc >= DT && n < 8) {
        S.acc -= DT; n++;
        if (S.i >= S.frames.length - 1) { if (S.loop) { S.i = -1; resetAthlete(athlete()); } else { S.playing = false; break; } }
        apply(S.frames[++S.i]);
      }
      if (n) { athlete().h.root.updateMatrixWorld(true); placeOverlays(); readout(); bar.value = S.i; }
    }
    // follow: the camera keeps its offset from the athlete
    if (S.follow && S.cur && !S.building) {
      const t = focus();
      if (lastFollow) { const d = t.clone().sub(lastFollow); camera.position.add(d); controls.target.add(d); }
      lastFollow = t;
    }
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  })(lastT);

  // ---------------------------------------------------------------- keep the place across reloads
  function saveHash() {
    if (!S.cur) return;
    const o = { c: S.cur.kind + ':' + S.cur.name, f: S.i, s: S.speed, p: S.playing ? 1 : 0, l: S.loop ? 1 : 0, w: S.follow ? 1 : 0, v: S.view,
      cam: [...camera.position.toArray(), ...controls.target.toArray()].map(v => +v.toFixed(3)) };
    history.replaceState(null, '', '#' + encodeURIComponent(JSON.stringify(o)));
  }
  addEventListener('pointerup', () => setTimeout(saveHash, 50));
  addEventListener('wheel', () => { clearTimeout(saveHash.h); saveHash.h = setTimeout(saveHash, 200); }, { passive: true });
  // live reload: when the code changes the server's build id moves; come back to the same place
  const build0 = (window.__MANIFEST && window.__MANIFEST.build) || null;
  setInterval(async () => {
    try {
      const r = await fetch('/api/build', { cache: 'no-store' }); const j = await r.json();
      if (build0 && j.build && j.build !== build0) { saveHash(); note('code changed: reloading', 3000); setTimeout(() => location.reload(), 150); }
    } catch { /* the server restarting: try again */ }
  }, 1000);

  // ---------------------------------------------------------------- start
  drawList();
  let o = null; try { o = JSON.parse(decodeURIComponent(location.hash.slice(1))); } catch { }
  const start = (o && byName.get(o.c)) || cases[0];
  if (o) {
    S.speed = SPEEDS.includes(o.s) ? o.s : 1; S.loop = o.l !== 0; S.follow = o.w !== 0; S.view = o.v || 'side';
    if (Array.isArray(o.cam) && o.cam.length === 6) { camera.position.fromArray(o.cam.slice(0, 3)); controls.target.fromArray(o.cam.slice(3)); camera.fov = 40; camera.updateProjectionMatrix(); S.camInit = true; lastFollow = null; }
  }
  load(start, o && Number.isFinite(o.f) ? o.f : 0);
  if (o && o.p) setTimeout(() => { S.playing = true; readout(); }, 50);
  return { load, seek, S };
}
