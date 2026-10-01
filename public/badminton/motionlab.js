// Office Badminton — motion lab. Drives one athlete with scripted input through a faithful copy of
// the sim's player physics (shared/badminton.js stepPlayer: run / turn / brake, sprint, jump, dive
// and the floor time after it), builds the snapshot row the renderer would get, and measures what
// the body does with it, frame by frame:
//   facing   body yaw and chest direction against the net and the travel, turn rate
//   feet     skating of a planted foot, sole/knee penetration, feet crossing in a chassé
//   body     NaNs, pelvis height, the knee bending the right way, clearance over the floor in a
//            dive, head on the shuttle, pops (the pelvis leaving the sim position)
//   gait     the mode the footwork chose, against what the case expects
// Driven by tools/motion_test.js through __ob.R().motionLab({ op, cases, shots }).
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const D2R = Math.PI / 180;

// ---------------------------------------------------------------- the sim's player physics
function simC() {
  const C = (self.BM && self.BM.C) || {};
  return Object.assign({ TOP: 8.2, SPRINT_V: 10.2, A_RUN: 34, A_TURN: 60, A_BRAKE: 72, TAPER: 1.4, AIR_ACCEL: 0.035, DIVE_V: 13.5, DIVE_T: 20, DIVE_REC: 40,
    PG: 14, JUMP_V: 4.6, JUMP_SQUAT: 4, LAND_T: 6, LEAP_V: 9.4, L: 9.045, W: 3.4965 }, C);
}
function runStep(C, p, ax, ay, m, top) {
  const wx = m > 0.05 ? ax * top : 0, wy = m > 0.05 ? ay * top : 0;
  const dx = wx - p.vx, dy = wy - p.vy, dv = Math.hypot(dx, dy);
  if (dv < 1e-5) { p.vx = wx; p.vy = wy; return; }
  const sp = Math.hypot(p.vx, p.vy), wsp = Math.hypot(wx, wy);
  let a;
  if (wsp < 0.05 || wsp < sp - 0.3) a = C.A_BRAKE;
  else if (sp > 0.5 && (p.vx * wx + p.vy * wy) / (sp * wsp) < 0.5) a = C.A_TURN;
  else a = C.A_RUN;
  let step = Math.min(dv, a / 60);
  if (dv < C.TAPER) step = Math.min(step, Math.max(dv * 0.4, 0.02));
  if (step >= dv) { p.vx = wx; p.vy = wy; return; }
  p.vx += dx / dv * step; p.vy += dy / dv * step;
}
function tick(C, p, inp) {
  const air = p.z > 0 || p.vz > 0;
  p.sprint = !!inp.sp && !air && p.diveT === 0 && p.floorT === 0 && p.squat === 0;
  let ax = inp.ax || 0, ay = inp.ay || 0, m = Math.hypot(ax, ay);
  if (m > 1) { ax /= m; ay /= m; m = 1; }
  if (m > 0.12 && p.diveT <= 0 && p.floorT <= 0) { p.fx = ax / m; p.fy = ay / m; }
  if (inp.jump && !air && p.squat === 0 && p.diveT === 0 && p.floorT === 0 && p.landT <= 2) p.squat = C.JUMP_SQUAT;
  if (inp.dive && !air && p.diveT === 0 && p.floorT === 0 && p.squat === 0) {
    let dx = m > 0.12 ? ax / m : p.fx, dy = m > 0.12 ? ay / m : p.fy; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    p.vx = dx * C.DIVE_V; p.vy = dy * C.DIVE_V; p.fx = dx; p.fy = dy; p.diveT = C.DIVE_T; p.sprint = false;
  }
  if (inp.charge && p.diveT === 0 && p.floorT === 0) p.ch = p.ch < 0 ? 1 : p.ch + 1; else p.ch = -1;
  if (p.recover > 0) p.recover--;
  if (p.diveT > 0) { p.diveT--; p.vx *= 0.9; p.vy *= 0.9; if (p.diveT === 0) { p.floorT = C.DIVE_REC; p.vx *= 0.3; p.vy *= 0.3; } }
  else if (p.floorT > 0) { p.floorT--; p.vx *= 0.8; p.vy *= 0.8; if (p.floorT === 0) p.recover = 8; }
  else if (p.squat > 0) { p.vx *= 0.86; p.vy *= 0.86; }
  else if (air) { if (m > 0.05) { p.vx += (ax * C.TOP - p.vx) * C.AIR_ACCEL; p.vy += (ay * C.TOP - p.vy) * C.AIR_ACCEL; } }
  else {
    const top = (p.sprint ? C.SPRINT_V : C.TOP) * (p.ch >= 0 ? 0.6 : 1) * (p.recover > 0 ? 0.5 : 1) * (p.landT > 0 ? 0.35 : 1);
    runStep(C, p, ax, ay, m, top);
  }
  if (p.landT > 0) p.landT--;
  if (p.squat > 0 && --p.squat === 0) {
    p.vz = C.JUMP_V; p.z = 0.001;
    const h = Math.hypot(p.vx, p.vy), cap = p.sprint ? C.LEAP_V : C.TOP;
    if (h > cap) { p.vx *= cap / h; p.vy *= cap / h; }
  }
  if (p.z > 0 || p.vz > 0) {
    const vz0 = p.vz; p.vz -= C.PG / 60; p.z += (vz0 + p.vz) / 120;
    if (p.z <= 0) { p.z = 0; p.vz = 0; p.landT = C.LAND_T; p.vx *= 0.55; p.vy *= 0.55; }
  }
  p.x += p.vx / 60; p.y += p.vy / 60;
  const d = p.x < 0 ? -1 : 1, back = C.L + 1.4, sideM = C.W + 1.6;
  if (d < 0) { if (p.x > -0.35) { p.x = -0.35; p.vx = Math.min(p.vx, 0); } if (p.x < -back) { p.x = -back; p.vx = Math.max(p.vx, 0); } }
  else { if (p.x < 0.35) { p.x = 0.35; p.vx = Math.max(p.vx, 0); } if (p.x > back) { p.x = back; p.vx = Math.min(p.vx, 0); } }
  if (p.y > sideM) { p.y = sideM; p.vy = Math.min(p.vy, 0); }
  if (p.y < -sideM) { p.y = -sideM; p.vy = Math.max(p.vy, 0); }
}
const rowOf = p => [p.x, p.y, p.vx, p.vy, p.fx, p.fy, p.ch, 0, p.diveT > 0 ? 1 : 0, 100, 0, p.recover, 0, 0, p.z, p.vz, p.squat, p.landT, 0, p.sprint && Math.hypot(p.vx, p.vy) > 0.5 ? 1 : 0, p.floorT];

// ---------------------------------------------------------------- one case
// c: { name, slot, start: [distance from the net, right], dur, seq: [{ t0, t1, dir, mag, sp, charge,
// flip, noise, spin }], ev: [{ t, jump | dive }], split: [t...], spikes: [[t, dt]], frozen: [[t0, t1]],
// corrupt: [{ t, i, v: 'nan' | 'undef' | 'inf' | 'short' | 'bigpos' }], ball: [dist, right, z] | 'dive' }
function inputAt(c, t, sd, rnd) {
  let o = { ax: 0, ay: 0, sp: 0, charge: 0 };
  for (const s of c.seq || []) {
    if (t < s.t0 || t >= s.t1) continue;
    let dir = s.dir || 0, mag = s.mag == null ? 1 : s.mag;
    if (s.flip) { const n = Math.floor((t - s.t0) * 60 / s.flip); dir += (n % 2) * 180; }
    if (s.spin) dir += (t - s.t0) * s.spin;
    if (s.rand) { const n = Math.floor((t - s.t0) * 60 / s.rand); dir = ((Math.sin(n * 12.9898 + 78.233) * 43758.5453) % 1) * 360; }
    if (s.noise) { dir += (rnd() - 0.5) * s.noise; mag = clamp(mag + (rnd() - 0.5) * (s.noiseMag || 0), 0, 1); }
    o = { ax: sd * Math.cos(dir * D2R) * mag, ay: sd * Math.sin(dir * D2R) * mag, sp: s.sp ? 1 : 0, charge: s.charge ? 1 : 0 };
  }
  return o;
}

export async function run(ctx, o) {
  const { THREE, players, feet, scene, camera, renderer, shuttle } = ctx;
  const C = simC();
  if (o.op === 'probe') {
    const A = players[0];
    return { rest: A.fw ? { clip: A.fw.rest.clip, legs: Object.fromEntries(Object.entries(A.fw.rest.leg).map(([k, L]) => [k, { hB: L.hB, l1: L.l1, l2: L.l2, yaw0: L.yaw0, ballOff: L.ballOff.toArray() }])) } : null, gait: A.gait };
  }
  const results = [], sheets = {};
  const cam0 = { p: camera.position.clone(), q: camera.quaternion.clone(), fov: camera.fov, aspect: camera.aspect };
  for (const c of o.cases || []) {
    const r = runCase(ctx, C, c, o.shots && o.shots[c.name]);
    results.push(r.m);
    if (r.sheet) sheets[c.name] = r.sheet;
  }
  camera.position.copy(cam0.p); camera.quaternion.copy(cam0.q); camera.fov = cam0.fov; camera.aspect = cam0.aspect; camera.updateProjectionMatrix();
  for (const A of players) A.root.visible = true;
  return { results, sheets };
}

function resetAthlete(A) {
  A.fw = null; A.speed = 0; A.land = 0; A.lungeW = 0; A.diveW = 0; A.jumpW = 0; A.legW = 1; A.track = 0; A.prepW = 0; A.strokeRamp = 0; A.hop = 0;
  const h = A.h; h.filt = null; if (h.env) h.env.length = 0; h.groundY = 0; h.phase = 0;
  h.group.quaternion.identity(); h.group.position.set(0, 0, 0);
}

function runCase(ctx, C, c, shotTimes) {
  const { THREE, players, feet, scene, camera, renderer, shuttle } = ctx;
  const slot = c.slot || 0, sd = slot === 0 ? 1 : -1;
  const A = players[slot], other = players[1 - slot], h = A.h, B = h.bone;
  other.root.visible = false; A.root.visible = true;
  if (feet) { feet[1 - slot].visible = false; feet[slot].visible = true; }
  resetAthlete(A);
  let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const st = c.start || [4.2, 0];
  const p = { x: -sd * st[0], y: sd * st[1], vx: 0, vy: 0, fx: sd, fy: 0, z: 0, vz: 0, squat: 0, landT: 0, diveT: 0, floorT: 0, ch: -1, sprint: false, recover: 0 };
  const netYaw = sd > 0 ? Math.PI / 2 : -Math.PI / 2;
  const ballAt = () => {
    if (Array.isArray(c.ball)) return [-sd * c.ball[0], sd * c.ball[1], c.ball[2], 0, 0, 0];
    if (c.ball === 'near') return [p.x + sd * 0.6, p.y + sd * 0.5, 2.6, 0, 0, 0];
    return [sd * 3.5, 0, 2.8, 0, 0, 0]; // high over the opponent's half
  };
  // the head's forward axis in its own frame, from the reference pose (the model faces +z)
  const hr = h.ref[boneIndexOf(h, 'Head')][0];
  const headLocalFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(hr.C.clone().multiply(hr.L).invert());
  const V = () => new THREE.Vector3();
  const v1 = V(), v2 = V(), v3 = V(), v4 = V(), q = new THREE.Quaternion();
  const footC = { L: h.contacts.filter(k => k.bone === B.foot_l || k.bone === B.ball_l), R: h.contacts.filter(k => k.bone === B.foot_r || k.bone === B.ball_r) };
  const CLEAR = [['pelvis', 0.1], ['spine_01', 0.1], ['spine_02', 0.11], ['spine_03', 0.11], ['neck_01', 0.06], ['Head', 0.09], ['upperarm_l', 0.05], ['upperarm_r', 0.05],
    ['lowerarm_l', 0.04], ['lowerarm_r', 0.04], ['hand_l', 0.03], ['hand_r', 0.03], ['calf_l', 0.05], ['calf_r', 0.05]];
  const m = { name: c.name, slot, frames: 0, modes: {}, nan: 0, maxYawRate: 0, maxYawRateDive: 0, backChest: 0, backPelvis: 0, maxChest: 0, skate: 0, skateAt: null, pen: 0, penAt: null,
    pelvisMin: 9, pelvisMax: 0, kneeBad: 0, kneeMax: 0, cross: 0, clear: 0, headErr: 0, headN: 0, headMax: 0, pop: 0, windows: [], travelBody: [], diveMinY: 9, thetaMax: 0, thetaMin: 0 };
  const stance = { L: null, R: null };
  const shots = []; let nextShot = 0;
  const sheet = shotTimes ? { tiles: [] } : null;
  const warm = 0.6;
  let t = -warm, prevYaw = null, prevPelvis = null, frame = 0, simT = 0;
  const dur = c.dur || 2;
  const DT = 1 / 60;
  const expect = (c.expect || []).map(e => ({ ...e, n: 0, ok: 0 }));
  let lastInp = { ax: 0, ay: 0 };
  while (t < dur) {
    // this frame's dt
    let dt = DT, frozen = false;
    for (const s of c.spikes || []) if (Math.abs(t - s[0]) < DT / 2) dt = s[1];
    for (const fz of c.frozen || []) if (t >= fz[0] && t < fz[1]) frozen = true;
    const inpT = t >= 0 ? inputAt(c, t, sd, rnd) : { ax: 0, ay: 0 };
    const evs = t >= 0 ? (c.ev || []).filter(e => e.t >= t && e.t < t + Math.max(dt, DT)) : [];
    // advance the sim by dt (in whole ticks; a frozen frame holds it)
    if (!frozen) {
      const n = Math.max(1, Math.round(dt * 60));
      for (let i = 0; i < n; i++) tick(C, p, { ...inpT, jump: i === 0 && evs.some(e => e.jump), dive: i === 0 && evs.some(e => e.dive) });
    }
    simT += frozen ? 0 : dt;
    let row = rowOf(p);
    for (const cr of c.corrupt || []) if (t >= cr.t && t < cr.t + (cr.len || DT)) {
      if (cr.v === 'short') row = row.slice(0, cr.n || 17);
      else if (cr.v === 'nan') row[cr.i] = NaN;
      else if (cr.v === 'undef') row[cr.i] = undefined;
      else if (cr.v === 'inf') row[cr.i] = Infinity;
      else if (cr.v === 'null') row = null;
    }
    const split = (c.split || []).map(s => t - s).filter(u => u >= 0 && u < 0.4);
    const ball = ballAt();
    const f = { p: row || [], ball, dt: frozen ? dt : dt, t: 100 + t, frozen, stroke: null, chargeKind: c.chargeKind || (p.ch >= 0 ? 'over' : null), prep: null, splitAgo: split.length ? split[0] : null, won: null, lost: null };
    let threw = null;
    try { A.update(f); } catch (e) { threw = e; }
    if (threw) { m.error = String(threw && threw.stack || threw).slice(0, 400); break; }
    frame++;
    if (t < 0) { t += DT; continue; }
    // ---------------- measurements
    m.frames++;
    const mode = A.gait || '?';
    m.modes[mode] = (m.modes[mode] || 0) + 1;
    h.root.updateMatrixWorld(true);
    let finite = Number.isFinite(A.yaw);
    for (const n in B) { const bn = B[n]; const qq = bn.quaternion; if (!Number.isFinite(qq.x + qq.y + qq.z + qq.w)) finite = false; }
    const pw = B.pelvis.getWorldPosition(v1);
    if (!Number.isFinite(pw.x + pw.y + pw.z)) finite = false;
    if (!finite) {
      m.nan++;
      if (!m.nanAt) { const bad = []; for (const n in B) { const qq = B[n].quaternion; if (!Number.isFinite(qq.x + qq.y + qq.z + qq.w)) bad.push(n); }
        m.nanAt = { t: +t.toFixed(3), mode, yaw: A.yaw, bad: bad.slice(0, 6), pel: B.pelvis.position.toArray(), row: (row || []).map(v => typeof v === 'number' ? +v.toFixed(3) : String(v)), fw: A.fw && { th: A.fw.theta, drop: A.fw.drop, ikW: A.fw.ikW, lift: A.fw.dive.lift, tilt: A.fw.dive.tilt, gpos: h.group.position.toArray() } }; }
      t += DT; continue;
    }
    const floorMode = mode === 'dive' || mode === 'slide' || mode === 'getup';
    const onGround = !floorMode && mode !== 'jump' && p.z < 0.02;
    // yaw rate
    if (prevYaw !== null && dt > 0 && !frozen && dt < 0.2) {
      const r = Math.abs(wrap(A.yaw - prevYaw)) / dt;
      if (floorMode) m.maxYawRateDive = Math.max(m.maxYawRateDive, r); else m.maxYawRate = Math.max(m.maxYawRate, r);
    }
    prevYaw = A.yaw;
    const th = A.fw ? A.fw.theta : 0; m.thetaMax = Math.max(m.thetaMax, th); m.thetaMin = Math.min(m.thetaMin, th);
    // chest and pelvis direction from the shoulders and hips
    const sl = B.upperarm_l.getWorldPosition(v2), sr = B.upperarm_r.getWorldPosition(v3);
    const cx = -(sl.z - sr.z), cz = sl.x - sr.x, chestOff = Math.abs(wrap(Math.atan2(cx, cz) - netYaw));
    const hl = B.thigh_l.getWorldPosition(v2), hrr = B.thigh_r.getWorldPosition(v3);
    const px = -(hl.z - hrr.z), pz = hl.x - hrr.x, pelOff = Math.abs(wrap(Math.atan2(px, pz) - netYaw));
    const spd = Math.hypot(p.vx, p.vy), trav = Math.atan2(p.vy * sd, p.vx * sd);
    if (!floorMode) m.maxChest = Math.max(m.maxChest, chestOff);
    if (spd > 1 && Math.cos(trav) < -0.3 && !floorMode) { m.backChest = Math.max(m.backChest, chestOff); m.backPelvis = Math.max(m.backPelvis, pelOff); }
    // a moonwalk: travelling backward relative to the hips
    if (spd > 2.5 && !floorMode && onGround && Math.abs(wrap(Math.atan2(p.vx, p.vy) - Math.atan2(px, pz))) > 150 * D2R) m.moonwalk = (m.moonwalk || 0) + 1;
    // travel relative to the pelvis, sampled for the report
    if (spd > 1 && !floorMode && m.frames % 6 === 0) m.travelBody.push(Math.round(wrap(Math.atan2(p.vx, p.vy) - Math.atan2(px, pz)) / D2R));
    // pelvis over the sim position (no pops) and its height
    const ph = pw.y - p.z;
    if (onGround && !floorMode) { if (ph < m.pelvisMin) m.pelvisMinAt = [+t.toFixed(2), mode]; if (ph > m.pelvisMax) m.pelvisMaxAt = [+t.toFixed(2), mode]; m.pelvisMin = Math.min(m.pelvisMin, ph); m.pelvisMax = Math.max(m.pelvisMax, ph); }
    if (prevPelvis && dt > 0 && dt < 0.2 && !frozen) {
      const jump = Math.hypot(pw.x - prevPelvis.x - (p.x - prevPelvis.sx), pw.z - prevPelvis.z - (p.y - prevPelvis.sy));
      if (!floorMode) m.pop = Math.max(m.pop, jump);
    }
    prevPelvis = { x: pw.x, z: pw.z, sx: p.x, sy: p.y };
    // feet: penetration, skating while planted, crossing in a chassé
    const lat = {};
    for (const [k, s] of [['L', 'l'], ['R', 'r']]) {
      let lo = Infinity; for (const cc of footC[k]) lo = Math.min(lo, v4.copy(cc.p).applyMatrix4(cc.bone.matrixWorld).y);
      if (-lo > m.pen) { m.pen = -lo; m.penAt = [+t.toFixed(2), mode, k]; }
      const ball = B['ball_' + s].getWorldPosition(V());
      lat[k] = (ball.x - p.x) * (-Math.cos(A.yaw)) + (ball.z - p.y) * Math.sin(A.yaw);
      const down = lo < 0.012 && onGround && !(dt > 0.2);
      if (down && !frozen) {
        if (!stance[k]) stance[k] = { x: ball.x, z: ball.z, n: 0 };
        else {
          stance[k].n++;
          const sk = Math.hypot(ball.x - stance[k].x, ball.z - stance[k].z);
          if (sk > m.skate) { m.skate = sk; m.skateAt = [+t.toFixed(2), mode, k]; }
        }
      } else if (!down) stance[k] = null;
    }
    // knee sense of the knee (never bent backwards)
    for (const s of ['l', 'r']) {
      const H = B['thigh_' + s].getWorldPosition(V()), K = B['calf_' + s].getWorldPosition(V()), Ak = B['foot_' + s].getWorldPosition(V());
      const u = K.clone().sub(H).normalize(), w = Ak.clone().sub(K).normalize();
      const flex = Math.acos(clamp(u.dot(w), -1, 1));
      const L = A.fw && A.fw.rest.leg[s === 'l' ? 'L' : 'R'];
      if (L) {
        const hinge = L.hinge.clone().applyQuaternion(B['thigh_' + s].getWorldQuaternion(q));
        const sgn = new THREE.Vector3().crossVectors(u, w).dot(hinge);
        if (flex > 0.12 && sgn < 0) m.kneeBad++;
      }
      m.kneeMax = Math.max(m.kneeMax, flex);
    }
    if ((mode === 'shuffle' || mode === 'back') && lat.L > lat.R - 0.02) m.cross++;
    if (c.trace) {
      const fr = { t: +t.toFixed(3), mode, by: A.fw && A.fw.feetBy, th: +(th).toFixed(3), sp: +spd.toFixed(2), drop: A.fw && +A.fw.drop.toFixed(3), lift: A.fw && +A.fw.dive.lift.toFixed(3), by2: A.fw && A.fw.liftBy, tilt: A.fw && +A.fw.dive.tilt.toFixed(2) };
      for (const [k, s2] of [['L', 'l'], ['R', 'r']]) {
        let lo = Infinity; for (const cc of footC[k]) lo = Math.min(lo, v4.copy(cc.p).applyMatrix4(cc.bone.matrixWorld).y);
        const bw = B['ball_' + s2].getWorldPosition(V()), F = A.fw && A.fw.feet[k];
        fr[k] = { lo: +lo.toFixed(4), x: +bw.x.toFixed(3), z: +bw.z.toFixed(3), y: +bw.y.toFixed(3), st: F && F.st, lock: F && F.lock, tx: F && +F.x.toFixed(3), tz: F && +F.z.toFixed(3), lift: F && +(F.lift || 0).toFixed(3), pitch: F && +(F.pitch || 0).toFixed(2) };
      }
      (m.trace || (m.trace = [])).push(fr);
    }
    // the whole body over the floor (the dive)
    let clearMin = Infinity;
    for (const [n, rr] of CLEAR) { const y = B[n].getWorldPosition(v2).y - rr * h.group.scale.y; clearMin = Math.min(clearMin, y); }
    if (-clearMin > m.clear) m.clear = -clearMin;
    if (floorMode) m.diveMinY = Math.min(m.diveMinY, clearMin);
    // head on the shuttle (when it is somewhere a head can turn to)
    {
      const eye = B.Head.getWorldPosition(v2); eye.y += 0.1;
      const toB = v3.set(ball[0], ball[2], ball[1]).sub(eye).normalize();
      const hf = headLocalFwd.clone().applyQuaternion(B.Head.getWorldQuaternion(q)).normalize();
      const chestF = new THREE.Vector3(cx, 0, cz).normalize();
      if (!floorMode && toB.x * chestF.x + toB.z * chestF.z > -0.2) {
        const e = Math.acos(clamp(hf.dot(toB), -1, 1)) / D2R;
        m.headErr += e; m.headN++; m.headMax = Math.max(m.headMax, e);
      }
    }
    for (const e of expect) if (t >= e.t0 && t < e.t1) {
      e.n++;
      if (e.allow ? e.allow.includes(mode) : (th / D2R >= e.theta[0] && th / D2R <= e.theta[1])) e.ok++;
    }
    // contact sheet
    if (sheet && shotTimes && nextShot < shotTimes.length && t >= shotTimes[nextShot] - 1e-6) {
      sheet.tiles.push(snap(ctx, A, p, sd, ball, `${t.toFixed(2)}s ${mode} th${Math.round(th / D2R)}`));
      nextShot++;
    }
    lastInp = inpT;
    t += DT;
  }
  m.headErr = m.headN ? m.headErr / m.headN : 0;
  m.windows = expect.map(e => ({ t0: e.t0, t1: e.t1, allow: e.allow, theta: e.theta, frac: e.n ? e.ok / e.n : 1, need: e.frac || 0.6 }));
  m.stats = A.fw ? A.fw.stats : null;
  m.travelBody = m.travelBody.slice(0, 24);
  if (sheet) sheet.png = compose(sheet.tiles, c.name);
  return { m, sheet: sheet ? sheet.png : null };
}
function boneIndexOf(h, name) { for (let i = 0; i < h.ref.length; i++) if (h.ref[i][0].bone.name === name) return i; return 4; }

// ---------------------------------------------------------------- contact sheets
const TW = 300, TH = 220;
function snap(ctx, A, p, sd, ball, label) {
  const { THREE, camera, renderer, scene, shuttle, feet } = ctx;
  const cv = renderer.domElement;
  if (shuttle) shuttle.position.set(ball[0], ball[2], ball[1]);
  if (feet) feet.forEach((f, i) => f.position.set(p.x, 0.008, p.y));
  const out = [];
  const tgt = new THREE.Vector3(p.x, 0.8 + p.z * 0.8, p.y);
  // view 1: from behind and above (the player's own camera, broadcast-like): the net is ahead
  // view 2: from the right sideline, level (shows lean, knee bend, the dive's line)
  const views = [[-sd * 4.2, 3.0, sd * 1.6], [sd * 0.4, 1.2, sd * 4.6]];
  for (const [ox, oy, oz] of views) {
    camera.position.set(p.x + ox, oy, p.y + oz); camera.fov = 40; camera.aspect = cv.width / cv.height; camera.updateProjectionMatrix();
    camera.lookAt(tgt);
    renderer.render(scene, camera);
    const c2 = document.createElement('canvas'); c2.width = TW; c2.height = TH;
    const g = c2.getContext('2d');
    // centre crop of the render
    const sw = cv.height * TW / TH, sx = (cv.width - sw) / 2;
    g.drawImage(cv, sx, 0, sw, cv.height, 0, 0, TW, TH);
    out.push(c2);
  }
  return { views: out, label };
}
function compose(tiles, name) {
  const cols = Math.min(tiles.length, 6), rows = Math.ceil(tiles.length / cols);
  const c = document.createElement('canvas'); c.width = cols * TW; c.height = rows * (TH * 2 + 18) + 22;
  const g = c.getContext('2d'); g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#e4ff3c'; g.font = 'bold 15px sans-serif'; g.fillText(name, 6, 16);
  tiles.forEach((tl, i) => {
    const x = (i % cols) * TW, y = 22 + Math.floor(i / cols) * (TH * 2 + 18);
    g.drawImage(tl.views[0], x, y); g.drawImage(tl.views[1], x, y + TH);
    g.fillStyle = '#fff'; g.font = '12px sans-serif'; g.fillText(tl.label, x + 4, y + TH * 2 + 13);
    g.strokeStyle = '#333'; g.strokeRect(x, y, TW, TH * 2 + 18);
  });
  return c.toDataURL('image/png');
}
