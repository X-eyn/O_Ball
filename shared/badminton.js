// Office Badminton — shared game simulation.
// Runs authoritatively on the server; the browser loads it for constants and prediction.
//
// Design: arcade first, physics honest. The court is a real one scaled up by S in plan (more room
// to move, more space to hit into); the shuttle's flight is scaled with it exactly (see C.G and
// C.DRAG), so every trajectory keeps its real shape and timing. Every shot is solved backwards
// from a target, so flights are predictable and the skill lives in positioning, timing and
// contact. Players run, dash, dive and jump; the shot you get follows from where and how you meet
// the shuttle (height, charge, whether you are airborne, and what it was when it came to you).
// Inputs are the same shape football uses (see shared/game.js), so the room/netcode layer is shared.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The scale of the court against a real one (13.40 x 5.18 m singles). Heights are real: the net,
  // the players and their reach are life-size; only the floor is bigger.
  const S = 1.35;
  // The shuttle's clock against a real one: every flight plays at T of real speed (the same shapes,
  // a little more time to read them). With T < 1 a smash that arrives in 0.40 s arrives in 0.47.
  const T = 0.85, V = S * T; // V: how court-scaled speeds relate to real ones
  const C = {
    S, T,
    // court in metres: x runs the length (net at x = 0), y across it. Player 0 lives at x < 0.
    L: 6.7 * S, W: 2.59 * S, NET_H: 1.55, NET_C: 1.524, SHORT: 1.98 * S,
    DW: 3.05 * S, LONG: 5.94 * S,  // doubles sideline and long service line: painted, not played
    // The shuttle. Quadratic drag dv/dt = -k|v|v - g: scaling lengths by S and slowing time by T
    // (t' = t/T, v' = S·T·v) maps it exactly onto k' = k/S, g' = g·S·T². So every flight keeps its
    // real shape, covers S times the ground and takes 1/T as long (terminal velocity 6.7·S·T m/s).
    G: 9.81 * S * T * T, DRAG: 0.2185 / S,
    // players: fast and arcade-y, with a burst dash, a desperation dive, a jump and light stamina
    TOP: 8.2, AIR_ACCEL: 0.035,
    // running (m/s²): speeding up along your line, cutting or reversing (the planted foot pushes
    // harder), and braking when you let go. The last TAPER m/s of any change eases in rather than
    // stopping dead, so a stop is crisp (about 0.4 m from full speed) but never a snap.
    A_RUN: 34, A_TURN: 60, A_BRAKE: 72, TAPER: 1.4,
    // placement assist: with no direction held, a player glides the last ASSIST_R metres to the
    // spot where the incoming shuttle is best met (any direction input takes over at once)
    ASSIST_R: 2.4, ASSIST_V: 0.8,
    REACH: 1.45, SWEET: 0.55, SWEET_Z: 2.25, MAX_Z: 2.9, HIGH_Z: 1.75, MID_Z: 0.85,
    DASH_V: 12.5, DASH_T: 10, DASH_CD: 46, LUNGE_V: 6.8,
    DIVE_V: 13.5, DIVE_T: 20, DIVE_CD: 80, DIVE_R: 2.9, DIVE_REACH: 1.45,
    // jumping: a 4-tick crouch, then takeoff. Player gravity is a touch stronger than real (snappier
    // hang): apex JUMP_V²/2PG = 0.76 m after 0.33 s, 0.66 s in the air
    PG: 14, JUMP_V: 4.6, JUMP_SQUAT: 4, JUMP_COST: 10, LAND_T: 6, LAND_SMASH_T: 13, LEAP_V: 9.4,
    ST_MAX: 100, ST_REGEN: 0.245, DASH_COST: 18, DIVE_COST: 30, SMASH_COST: 12, JSMASH_COST: 8, PERF_REGEN: 9, TIRED: 22,
    CHARGE_FULL: 42, PERF_END: 58, COUNTER_CT: 14,
    REC_SMASH: 20, REC_CLEAR: 15, REC_SHOT: 10, SWING_T: 5,
    HOLD_Z: 0.95,
    POINTS: 7, PRE_T: 210, POINT_T: 110, OVER_T: 60 * 8, PAUSE_T: 60 * 12,
  };
  // Shot table. min/max: metres past the net the shot is aimed to land (court-scaled); ang: the
  // lowest launch elevation the solver tries; cap: the most racket speed the shot may use (m/s).
  // Speeds are court- and clock-scaled too (V = S·T): 55·V m/s here is a real 55 m/s (198 km/h) smash.
  const SHOTS = {
    smash: { min: 2.2 * S, max: 3.7 * S, cap: 55 * V, rec: C.REC_SMASH, hs: 3 },
    jsmash: { min: 1.8 * S, max: 3.4 * S, cap: 64 * V, rec: C.REC_SMASH, hs: 5 },
    kill: { min: 0.9 * S, max: 2.6 * S, cap: 50 * V, rec: C.REC_SHOT, hs: 4 },
    drive: { min: 3.6 * S, max: 5.4 * S, ang: 8, cap: 42 * V, rec: C.REC_SHOT },
    clear: { min: 5.0 * S, max: 6.3 * S, ang: 49, cap: 46 * V, rec: C.REC_CLEAR },
    lift: { min: 5.2 * S, max: 6.4 * S, ang: 55, cap: 46 * V, rec: C.REC_SHOT },
    drop: { min: 1.1 * S, max: 2.3 * S, ang: 8, cap: 18 * V, rec: C.REC_SHOT },
    net: { min: 0.55 * S, max: 1.3 * S, ang: 10, cap: 14 * V, rec: C.REC_SHOT },
    block: { min: 0.35 * S, max: 1.0 * S, ang: 4, cap: 12 * V, rec: 6 },
    counter: { min: 3.8 * S, max: 5.8 * S, ang: -4, cap: 48 * V, rec: C.REC_SHOT, hs: 3 },
    servel: { min: 0.3 * S, max: 0.9 * S, ang: 18, cap: 18 * V, rec: 8 },
    serveh: { min: 2.8 * S, max: 4.4 * S, ang: 45, cap: 38 * V, rec: 8 },
  };
  // what counts as a shot to be defended (block / counter), and how fast it must still be moving.
  // Drag bleeds a smash fast (74 m/s off the racket is ~13 by the time it arrives), so the bar is
  // just above a falling shuttle's own terminal speed (6.7·V = 7.7 m/s): still driven, not dropping.
  const FAST = { smash: 1, jsmash: 1, kill: 1 };
  const FAST_V = 8 * V;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r1 = v => Math.round(v * 10) / 10;
  const r2 = v => Math.round(v * 100) / 100;
  const netAt = y => C.NET_C + (C.NET_H - C.NET_C) * clamp(Math.abs(y) / C.W, 0, 1);
  // a player's side of the net: -1 when they live at x < 0, +1 at x > 0
  const sideOf = p => (p.i === 0 ? -1 : 1);
  const opp = i => (i === 0 ? 1 : 0);
  // real-world equivalent speed for display: a court-scaled m/s shown as the km/h it stands for
  const kmhOf = v => Math.round(v / V * 3.6);

  function mkPlayer(i) {
    return {
      i, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, fx: i ? -1 : 1, fy: 0,
      ch: false, ct: 0, pk: null, anim: 0, swing: '',
      dashT: 0, dashCd: 0, diveT: 0, diveCd: 0, stun: 0, recover: 0,
      squat: 0, landT: 0, airSmash: false,
      stamina: C.ST_MAX, hitCd: 0, lastKp: 0, lastDc: 0, lastKn: 0, lastJp: 0, init: false, ai: false,
      st: { hits: 0, smashes: 0, perfects: 0, winners: 0, aces: 0, dives: 0, maxRally: 0, errors: 0, jumps: 0, counters: 0, kills: 0 },
    };
  }

  // opts.botSkill: 0..1 (practice opponent).
  function createSim(tick, opts = {}) {
    const s = {
      tick, players: [mkPlayer(0), mkPlayer(1)],
      ball: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, last: -1, stuck: 0, over: 0 },
      score: [0, 0], server: 0, serveY: 1, serveLive: 0, serveHold: false,
      phase: 'prematch', pt: 0, ps: tick, rally: 0, lastHitter: -1, lastKind: '',
      hitstop: 0, winner: -1, events: [], ready: [false, false],
      skill: opts.botSkill != null ? opts.botSkill : 0.62,
      bot: [0, 1].map(() => ({ ch: 0, want: 0, ct: 0, kp: 0, dc: 0, kn: 0, jp: 0, t: 0, pred: null, predT: -99, plan: '', jumpAt: -1 })),
    };
    if (opts.ai) s.players.forEach(p => { p.ai = Array.isArray(opts.ai) ? !!opts.ai[p.i] : !!opts.ai; });
    setupServe(s);
    s.phase = 'prematch'; s.pt = 0;
    return s;
  }

  function setPhase(s, ph) { s.phase = ph; s.pt = 0; s.ps = s.tick; }
  function ev(s, type, o) { if (!s.quiet) s.events.push(Object.assign({ type, tick: s.tick }, o)); }

  // ---------- serve ----------
  function setupServe(s) {
    const sv = s.server, d = sv === 0 ? -1 : 1;      // the server's side of the net
    const even = s.score[sv] % 2 === 0;
    const sy = (even ? 1 : -1) * 1.05 * S;           // right service court on even points
    const ry = -sy;                                  // the receiver stands diagonally opposite
    const sa = s.players[sv], ra = s.players[opp(sv)];
    const reset = { vx: 0, vy: 0, z: 0, vz: 0, ch: false, ct: 0, pk: null, anim: 0, stun: 0, dashT: 0, diveT: 0, recover: 0, hitCd: 0, squat: 0, landT: 0, airSmash: false };
    Object.assign(sa, reset, { x: d * 2.45 * S, y: sy, fx: -d, fy: 0 });
    Object.assign(ra, reset, { x: -d * 2.55 * S, y: ry, fx: d, fy: 0 });
    for (const p of s.players) p.stamina = Math.max(p.stamina, 62);
    s.serveY = ry; s.serveLive = 0; s.serveHold = true; s.lastHitter = -1; s.lastKind = '';
    Object.assign(s.ball, { x: sa.x - d * 0.5, y: sy, z: C.HOLD_Z, vx: 0, vy: 0, vz: 0, last: -1, stuck: 0, over: 0 });
    setPhase(s, 'serve');
    ev(s, 'serve', { p: sv, y: r2(ry) });
  }

  function syncInputs(s, inputs) {
    s.players.forEach((p, i) => {
      const inp = inputs[i];
      p.lastKp = inp.kp; p.lastDc = inp.dc; p.lastKn = inp.kn; p.lastJp = inp.jp | 0; p.init = true;
      if (s.phase !== 'serve' && s.phase !== 'rally') { p.ch = false; p.ct = 0; p.pk = null; }
    });
  }

  // ---------- shuttle flight ----------
  // The one true flight model: the sim, the shot solver and the bot's prediction all use it.
  // Integrates a snapshot forward and reports where it meets the net cord, or where it lands.
  function fly(o, vx, vy, vz, opts = {}) {
    const dt = opts.dt || 1 / 60, maxT = opts.maxT || 5, stopZ = opts.stopZ != null ? opts.stopZ : 0;
    let x = o.x, y = o.y, z = o.z, t = 0;
    while (t < maxT) {
      const sp = Math.hypot(vx, vy, vz), dec = 1 / (1 + C.DRAG * sp * dt); // exact for a = -k·v²
      vx *= dec; vy *= dec; vz = vz * dec - C.G * dt;
      const nx = x + vx * dt, ny = y + vy * dt, nz = z + vz * dt;
      if ((x < 0) !== (nx < 0)) {
        const u = (0 - x) / (nx - x), yc = y + (ny - y) * u, zc = z + (nz - z) * u;
        if (zc < netAt(yc)) return { net: 1, t, x: 0, y: yc, z: zc, vx, vy, vz };
      }
      x = nx; y = ny; z = nz; t += dt;
      if (z <= stopZ) return { t, x, y, z, net: 0, vx, vy, vz };
      if (!Number.isFinite(x + y + z)) break;
    }
    return { t, x, y, z: Math.max(0, z), net: 0, vx, vy, vz, over: 1 };
  }
  // an attack shot: the racket speed is fixed (that is the shot), the angle is picked so it lands
  // on the target. Among clean lines the steepest wins: it is the fastest to the floor.
  function launchAngle(from, tx, ty, speed, lo, hi) {
    const az = Math.atan2(ty - from.y, tx - from.x);
    const dist = Math.hypot(tx - from.x, ty - from.y);
    let best = null;
    for (let ang = lo; ang <= hi; ang += 1.5) {
      const rad = ang * Math.PI / 180;
      const lv = { vx: Math.cos(rad) * Math.cos(az) * speed, vy: Math.cos(rad) * Math.sin(az) * speed, vz: Math.sin(rad) * speed };
      const res = fly(from, lv.vx, lv.vy, lv.vz, { dt: 1 / 60, maxT: 5 });
      if (res.net) continue;
      const err = Math.abs(Math.hypot(res.x - from.x, res.y - from.y) - dist);
      if (!best || err < best.err - 0.05) best = { err, lv, res, ang };
    }
    return best && best.err < 1.2 * S ? best : null;
  }
  // a lifted shot: search angle and racket speed together for the launch that lands on the target.
  // A plain bisection on speed gets trapped at the net tape (clearing it is a jump in range), so the
  // whole space is sampled coarsely and the best landing wins.
  function launch(from, tx, ty, shot, speedMul) {
    const az = Math.atan2(ty - from.y, tx - from.x);
    const dist = Math.hypot(tx - from.x, ty - from.y);
    const cap = shot.cap * speedMul;
    let best = null;
    for (let ang = shot.ang; ang <= 80; ang += 6) {
      const rad = ang * Math.PI / 180, hx = Math.cos(rad), vz0 = Math.sin(rad);
      for (let i = 0; i <= 36; i++) {
        const v = 1 + (cap - 1) * (i / 36);
        const lv = { vx: hx * Math.cos(az) * v, vy: hx * Math.sin(az) * v, vz: vz0 * v };
        const res = fly(from, lv.vx, lv.vy, lv.vz, { dt: 1 / 30, maxT: 4 });
        if (res.net) continue;
        const err = Math.abs(Math.hypot(res.x - from.x, res.y - from.y) - dist);
        if (!best || err < best.err) best = { err, lv, ang, v };
        if (err < 0.08) break;
      }
      if (best && best.err < 0.12) break;
    }
    if (!best) { // nowhere to put it: straight up off the racket and hope
      const rad = 80 * Math.PI / 180;
      const lv = { vx: Math.cos(rad) * Math.cos(az) * cap, vy: Math.cos(rad) * Math.sin(az) * cap, vz: Math.sin(rad) * cap };
      return { lv, res: fly(from, lv.vx, lv.vy, lv.vz, { dt: 1 / 60, maxT: 5 }), v: cap, ang: 80 };
    }
    const res = fly(from, best.lv.vx, best.lv.vy, best.lv.vz, { dt: 1 / 60, maxT: 5 });
    return { res, lv: best.lv, v: best.v, ang: best.ang };
  }

  // ---------- shots ----------
  const powerOf = ct => (ct >= C.CHARGE_FULL && ct <= C.PERF_END) ? 1.25 : ct > C.PERF_END ? 0.8 : 0.3 + 0.7 * Math.max(0, ct) / C.CHARGE_FULL;
  const isOvercharge = ct => ct > C.PERF_END;
  const pctOf = ct => clamp(ct / C.CHARGE_FULL, 0, 1.3);
  const airborne = p => p.z > 0.02 || p.vz > 0;

  // contact quality: 1 = met at the sweet spot, lower = reached for, late, off-balance, diving, or
  // struck in the air away from the top of the jump
  function quality(s, p, lateMul) {
    const b = s.ball;
    const d = Math.hypot(b.x - p.x, b.y - p.y) || 1;
    const qr = clamp(1 - (d - C.SWEET) / (C.REACH - C.SWEET), 0, 1);
    // the ideal strike zone is overhead (measured from the player's own feet, so a jump lifts it)
    const rz = b.z - p.z;
    const qh = rz >= C.MID_Z ? 1 - clamp(Math.abs(rz - C.SWEET_Z) / 1.6, 0, 1) * 0.4 : 0.8;
    const spd = Math.hypot(p.vx, p.vy);
    const toX = (b.x - p.x) / d, toY = (b.y - p.y) / d;
    const facing = clamp(p.fx * toX + p.fy * toY, -1, 1);
    let q = (0.16 + 0.84 * qr) * (0.66 + 0.34 * qh) * (1 - 0.16 * clamp(spd / C.TOP, 0, 1)) * (facing < 0.25 ? 0.7 : 1);
    if (airborne(p)) q *= 1 - 0.3 * clamp(Math.abs(p.vz) / C.JUMP_V, 0, 1); // the apex is the moment
    if (p.diveT > 0) q *= 0.42;
    if (p.landT > 0) q *= 0.8;
    if (lateMul < 1) q *= lateMul;
    return clamp(q, 0.05, 1);
  }

  function tryHit(s, p, ct, lob, lateMul) {
    const b = s.ball;
    // only what is on your side of the net (a hair over the tape is allowed, as in a net kill)
    if (p.i === 0 ? b.x > 0.18 : b.x < -0.18) return false;
    if (s.phase === 'serve') {
      if (p.i === s.server) { if (s.lastHitter !== -1) return false; }
      else if (s.lastHitter !== s.server) return false; // nobody may hit before the serve
    } else if (p.i === s.lastHitter) return false;       // no double hits
    const d = Math.hypot(b.x - p.x, b.y - p.y);
    const reach = p.diveT > 0 ? C.REACH * C.DIVE_REACH : airborne(p) ? C.REACH * 0.9 : C.REACH;
    if (d > reach || b.z > p.z + C.MAX_Z || b.z < Math.max(0.02, p.z - 0.15)) return false;
    let q = quality(s, p, lateMul);
    if (isOvercharge(ct)) q *= 0.78;              // overcooked: the racket is past the sweet window
    if (s.phase === 'serve') q = Math.max(q, 0.82); // serves are a free throw: the skill is what follows
    if (p.ai) q = Math.max(q, 0.35 + 0.45 * s.skill); // the practice partner never shanks it completely...
    if (p.ai && s.phase !== 'serve' && Math.random() < 0.1 * (1.6 - s.skill)) q *= 0.3; // ...but it does make errors
    shoot(s, p, ct, lob, q, lateMul >= 1);
    return true;
  }

  // Which shot a contact makes. Height is measured from the player's own feet (a jump turns a
  // mid-height shuttle into an overhead one); the charge picks within the height band; a shuttle
  // that came in as a smash is defended rather than attacked.
  function shotKind(s, p, ct, lob) {
    const b = s.ball;
    if (s.phase === 'serve' && s.lastHitter === -1) return pctOf(ct) >= 0.7 ? 'serveh' : 'servel';
    const pct = pctOf(ct), rz = b.z - p.z, air = airborne(p);
    const incoming = Math.hypot(b.vx, b.vy, b.vz);
    if (FAST[s.lastKind] && incoming > FAST_V && !air) {
      if (lob) return 'lift';
      return ct < C.COUNTER_CT ? 'block' : 'counter';
    }
    // near the net with the shuttle floating above the tape: put it away
    const atTape = Math.abs(b.x) < 1.1 * S && Math.abs(p.x) < 1.8 * S;
    if (!lob && atTape && b.z > netAt(b.y) + 0.25 && pct >= 0.8) return 'kill';
    if (rz >= C.HIGH_Z) return lob ? 'clear' : pct >= 0.8 ? (air ? 'jsmash' : 'smash') : pct >= 0.35 ? 'drive' : 'drop';
    if (rz >= C.MID_Z) return lob ? 'lift' : 'drive';
    return lob ? 'lift' : pct >= 0.75 ? 'clear' : 'net';
  }

  function shoot(s, p, ct, lob, q, onTime) {
    const b = s.ball;
    const serving = s.phase === 'serve' && s.lastHitter === -1;
    const pct = pctOf(ct), power = powerOf(ct), over = isOvercharge(ct);
    const incoming = Math.hypot(b.vx, b.vy, b.vz);
    let kind = shotKind(s, p, ct, lob);
    // no legs, no smash; a scuffed counter pops up instead
    if ((kind === 'smash' || kind === 'jsmash') && (q < 0.55 || p.stamina < C.SMASH_COST)) kind = 'drop';
    if (kind === 'counter' && q < 0.5) kind = 'lift';
    // a parry: a counter met cleanly the instant the button came up (not a buffered late swing)
    const parry = kind === 'counter' && onTime && q >= 0.8;
    let perfect = power >= 1.25 && kind !== 'block' && kind !== 'counter' || parry;
    const dir = sideOf(p), oppSign = -dir;
    // aim: facing decides the line; overcharge and bad contact smear it
    const f = { x: p.fx, y: p.fy };
    if (over) f.y += (Math.random() * 2 - 1) * 0.22;
    const smear = (1 - q) * 1.0 + (over ? 0.35 : 0) + (p.ai ? (1 - s.skill) * 0.5 : 0);
    if (smear > 0.01) {
      const a = (Math.random() * 2 - 1) * smear;
      const c = Math.cos(a), sn = Math.sin(a);
      const fx = f.x * c - f.y * sn; f.y = f.x * sn + f.y * c; f.x = fx;
    }
    const o = s.players[opp(p.i)];
    const plan = k => {
      const sh = SHOTS[k];
      let depth = sh.min + (sh.max - sh.min) * clamp(q * 0.5 + pct * 0.5, 0, 1);
      if (k === 'smash' || k === 'jsmash' || k === 'kill') depth = sh.min + (sh.max - sh.min) * clamp(pct, 0, 1);
      if (q < 0.6 && (k === 'clear' || k === 'drive' || k === 'lift')) depth *= 0.58 + 0.42 * q; // mishits fall short
      if (k === 'net' || k === 'drop') depth = Math.max(depth, (Math.abs(p.x) - 0.35) * 0.5); // from deep, a soft shot lands mid-court at best
      if (serving) depth = sh.min + (sh.max - sh.min) * clamp(pct, 0, 1);
      const tx = oppSign * (k === 'servel' || k === 'serveh' ? C.SHORT + depth : depth);
      let ty;
      if (serving) ty = clamp(s.serveY * (k === 'serveh' ? 1.6 : 1.3) + f.y * 0.5 * S, s.serveY > 0 ? 0.4 : -2.25 * S, s.serveY > 0 ? 2.25 * S : -0.4);
      // a counter goes where the smasher is not: the open side, as far as the aim allows
      else if (k === 'counter') ty = clamp((o.y > 0 ? -1 : 1) * 1.9 * S + f.y * 0.8 * S, -2.5 * S, 2.5 * S);
      else ty = clamp(f.y * 2.75 * S + (Math.random() * 2 - 1) * Math.max(0, 0.55 - q * 0.45) * 1.4 * S, -2.6 * S, 2.6 * S);
      return { tx, ty };
    };
    // racket speed: contact quality, a perfect release, and for a jump smash how high it was met
    const lift = clamp((b.z - 2.6) / 0.9, 0, 1);
    let speedMul = (0.82 + 0.18 * q) * (perfect ? 1.07 : 1) * (over ? 0.92 : 1);
    if (kind === 'jsmash') speedMul *= 1 + 0.12 * lift;
    if (kind === 'counter') speedMul *= clamp(0.55 + incoming / (SHOTS.jsmash.cap * 1.6), 0.7, 1) * (parry ? 1.15 : 1); // it borrows the smash's pace
    let { tx, ty } = plan(kind);
    let lv = null, res = null;
    const from = { x: b.x, y: b.y, z: b.z };
    // attack shots are a racket speed, not a placement: the steepest clean line for the aim
    // (a counter is placed like a drive, on the flattest line the solver finds: the fastest one)
    const steep = { smash: [-42, -10], jsmash: [-55, -12], kill: [-62, -14] }[kind];
    if (steep) {
      const a = launchAngle(from, tx, ty, SHOTS[kind].cap * speedMul, steep[0], steep[1]);
      if (a) { lv = a.lv; res = a.res; }
      else kind = 'drop'; // no clean line from here: it comes off soft
    }
    // a really bad contact (stretched, late, diving, overcooked) can simply go wrong: into the
    // tape, long, or wide. The worse the contact, the likelier.
    let error = '';
    if (!serving && q < 0.3 && Math.random() < (0.3 - q) / 0.3 * 0.75) {
      const r = Math.random();
      error = r < 0.4 ? 'net' : r < 0.7 ? 'long' : 'wide';
      if (error === 'net') { // off the frame, flat into the tape
        const az = Math.atan2(clamp(f.y, -0.5, 0.5) * 2 - b.y * 0.2, -b.x), sp = 6 + 4 * Math.random();
        lv = { vx: Math.cos(az) * sp, vy: Math.sin(az) * sp, vz: 0.5 };
      } else {
        kind = kind === 'drop' || kind === 'net' || kind === 'block' ? 'drive' : kind;
        tx = oppSign * (error === 'long' ? C.L + 0.5 + Math.random() * 1.2 : 3 * S + Math.random() * 2 * S);
        ty = error === 'wide' ? Math.sign(f.y || (Math.random() - 0.5)) * (C.W + 0.5 + Math.random() * 1.0) : ty;
        ({ lv, res } = launch(from, tx, ty, SHOTS.clear, 1.1));
      }
    }
    if (!lv) {
      ({ tx, ty } = plan(kind));
      ({ lv, res } = launch(from, tx, ty, SHOTS[kind], kind === 'block' ? 1 : speedMul));
    }
    const sp = Math.hypot(lv.vx, lv.vy, lv.vz);
    const shot = SHOTS[kind];
    b.vx = lv.vx; b.vy = lv.vy; b.vz = lv.vz;
    b.last = p.i; b.stuck = 0;
    s.serveHold = false;
    if (s.phase === 'serve') s.phase = 'rally';
    s.serveLive = serving ? 1 : 0; // once the receiver returns it, it is just a rally
    p.anim = 8; p.hitCd = 3; p.recover = shot.rec; p.ch = false; p.ct = 0; p.pk = null; p.swing = kind;
    if (kind === 'smash' || kind === 'jsmash') {
      p.stamina = Math.max(0, p.stamina - (kind === 'jsmash' ? C.JSMASH_COST : C.SMASH_COST));
      p.st.smashes++;
      if (kind === 'jsmash') p.airSmash = true; // a heavier landing
    }
    if (kind === 'counter') p.st.counters++;
    if (kind === 'kill') p.st.kills++;
    // hit-stop: the whole sim holds for a beat on a big contact, so it lands with weight
    const hs = (shot.hs || 0) + (perfect && shot.hs ? (kind === 'jsmash' ? 3 : 2) : 0) + (parry ? 3 : 0);
    if (hs) s.hitstop = Math.max(s.hitstop, hs);
    if (perfect) { p.stamina = Math.min(C.ST_MAX, p.stamina + C.PERF_REGEN); p.st.perfects++; }
    s.rally++;
    p.st.maxRally = Math.max(p.st.maxRally, s.rally);
    p.st.hits++;
    s.lastHitter = p.i; s.lastKind = kind;
    ev(s, 'hit', {
      p: p.i, kind, q: r2(q), perfect: perfect ? 1 : 0, parry: parry ? 1 : 0, air: airborne(p) ? 1 : 0, err: error,
      kmh: kmhOf(sp), in: kmhOf(incoming),
      x: r2(b.x), y: r2(b.y), z: r2(b.z), pz: r2(p.z), v: Math.round(sp), rally: s.rally, over: over ? 1 : 0, hs,
    });
  }

  // ---------- running ----------
  // One tick of grounded running: the velocity steers toward the wanted one (stick x top speed)
  // with bounded acceleration: A_RUN along the line you are already moving, A_TURN to cut or
  // reverse, A_BRAKE to slow or stop. The final TAPER m/s of a change closes proportionally, so
  // arrivals ease in. Shared with the client, which runs the same step to predict its own player.
  function run(p, ax, ay, m, top) {
    const wx = m > 0.05 ? ax * top : 0, wy = m > 0.05 ? ay * top : 0;
    const dx = wx - p.vx, dy = wy - p.vy, dv = Math.hypot(dx, dy);
    if (dv < 1e-5) { p.vx = wx; p.vy = wy; return; }
    const sp = Math.hypot(p.vx, p.vy), wsp = Math.hypot(wx, wy);
    let a;
    if (wsp < 0.05 || wsp < sp - 0.3) a = C.A_BRAKE;                                  // letting go / slowing
    else if (sp > 0.5 && (p.vx * wx + p.vy * wy) / (sp * wsp) < 0.5) a = C.A_TURN;   // cutting or reversing
    else a = C.A_RUN;
    let step = Math.min(dv, a / 60);
    if (dv < C.TAPER) step = Math.min(step, Math.max(dv * 0.4, 0.02)); // ease the end of the change
    if (step >= dv) { p.vx = wx; p.vy = wy; return; }
    p.vx += dx / dv * step; p.vy += dy / dv * step;
  }
  // Placement assist: where to stand for the incoming shuttle — beside and a little behind the
  // point it will be met (overhead while it is high, else where it comes down), with the shuttle
  // on the racket side. Returns a steering vector (magnitude <= ASSIST_V) or null when there is
  // nothing to do: not coming to you, too far away to be "placement", or already there.
  function assistDir(s, p) {
    const b = s.ball;
    if ((s.phase !== 'rally' && s.phase !== 'serve') || s.serveHold || b.last < 0 || b.last === p.i) return null;
    const d = sideOf(p);
    if (!s._pred || s._predT !== s.tick) { s._pred = predict(s); s._predT = s.tick; }
    const pr = s._pred;
    if (!pr.land || Math.sign(pr.land.x || 1) !== d) return null;
    const meet = pr.high && Math.sign(pr.high.x || 1) === d && pr.high.t < pr.land.t ? pr.high : pr.land;
    if (meet.t < 0.08) return null;
    // facing the net, the racket side (right hand) is (-f.y, f.x)
    const fx = -d, fy = 0, rx = -fy, ry = fx;
    const tx = meet.x - rx * 0.4 - fx * 0.35, ty = meet.y - ry * 0.4 - fy * 0.35;
    const ex = tx - p.x, ey = ty - p.y, dist = Math.hypot(ex, ey);
    if (dist < 0.1 || dist > C.ASSIST_R) return null;
    const k = Math.min(C.ASSIST_V, dist / 1.2) / dist;
    return { x: ex * k, y: ey * k };
  }

  // ---------- player step ----------
  function stepPlayer(s, p, inp) {
    if (!p.init) { p.lastKp = inp.kp; p.lastDc = inp.dc; p.lastKn = inp.kn; p.lastJp = inp.jp | 0; p.init = true; }
    if (p.dashCd > 0) p.dashCd--;
    if (p.diveCd > 0) p.diveCd--;
    if (p.hitCd > 0) p.hitCd--;
    if (p.anim > 0) p.anim--;
    if (p.recover > 0) p.recover--;
    p.stamina = Math.min(C.ST_MAX, p.stamina + C.ST_REGEN);
    const air = airborne(p);

    let ax = 0, ay = 0, m = 0;
    if (inp.ax || inp.ay) { ax = inp.ax || 0; ay = inp.ay || 0; }
    else { ax = (inp.r ? 1 : 0) - (inp.l ? 1 : 0); ay = (inp.d ? 1 : 0) - (inp.u ? 1 : 0); }
    m = Math.hypot(ax, ay);
    if (m > 1) { ax /= m; ay /= m; m = 1; }
    if (m > 0.12 && p.stun <= 0 && p.diveT <= 0) { p.fx = ax / m; p.fy = ay / m; }

    // jump: a short crouch, then takeoff (see below). Not from a dive, a stun or mid-air.
    const jp = inp.jp | 0;
    if (jp !== p.lastJp) {
      p.lastJp = jp;
      if (!air && p.squat === 0 && p.stun === 0 && p.diveT === 0 && p.landT <= 2 && p.stamina >= C.JUMP_COST) {
        p.squat = C.JUMP_SQUAT; p.stamina -= C.JUMP_COST; p.st.jumps++;
        ev(s, 'jump', { p: p.i, x: r2(p.x), y: r2(p.y), leap: p.dashT > 0 ? 1 : 0 });
      }
    }

    // dash / dive: one button. Close to a dying shuttle it becomes a diving save instead
    if (inp.dc !== p.lastDc) {
      p.lastDc = inp.dc;
      if (p.stun === 0 && p.diveT === 0 && !air && p.squat === 0) {
        const bd = Math.hypot(s.ball.x - p.x, s.ball.y - p.y);
        if (s.ball.z < 1.4 && bd < C.DIVE_R && p.diveCd === 0 && p.stamina >= C.DIVE_COST && s.ball.last !== p.i) {
          const dx = (s.ball.x - p.x) / (bd || 1), dy = (s.ball.y - p.y) / (bd || 1);
          p.vx = dx * C.DIVE_V; p.vy = dy * C.DIVE_V;
          p.diveT = C.DIVE_T; p.diveCd = C.DIVE_CD; p.stamina -= C.DIVE_COST;
          p.st.dives++;
          ev(s, 'dive', { p: p.i, x: r2(p.x), y: r2(p.y), dx: r2(dx), dy: r2(dy) });
        } else if (p.dashCd === 0 && m > 0.12) {
          const sp = p.stamina >= C.DASH_COST ? C.DASH_V : C.LUNGE_V;
          p.vx = ax * sp; p.vy = ay * sp;
          p.dashT = C.DASH_T; p.dashCd = C.DASH_CD;
          if (p.stamina >= C.DASH_COST) p.stamina -= C.DASH_COST; else p.stun = Math.max(p.stun, 10);
          ev(s, 'dash', { p: p.i, x: r2(p.x), y: r2(p.y) });
        }
      }
    }

    // swing: the release fires on the spot when the shuttle is in reach. Otherwise it is a buffered
    // miss for a few ticks — and an early release, a read the opponent's animation shows.
    const pressedNew = inp.kp !== p.lastKp;
    const tapped = pressedNew && !inp.k && !p.ch;
    p.lastKp = inp.kp;
    if (p.stun > 0) { p.ch = false; p.ct = 0; p.pk = null; }
    else if (p.pk) {
      if (pressedNew) p.pk = null;
      else if (tryHit(s, p, p.pk.ct, p.pk.lob, p.pk.late)) p.pk = null;
      else if (--p.pk.t <= 0) { if (p.pk.ct > 12) ev(s, 'whiff', { p: p.i, x: r2(p.x), y: r2(p.y) }); p.pk = null; }
    }
    if (p.stun === 0 && !p.pk) {
      if (inp.k) { if (!p.ch) { p.ch = true; p.ct = 0; } p.ct++; }
      else if (p.ch || tapped) {
        // the client reports how long the button was actually held; trust it within a tolerance
        const ct = typeof inp.kc === 'number' ? clamp(inp.kc, p.ct - 10, p.ct + 12) : p.ct;
        p.ch = false; p.ct = 0; p.anim = 8;
        if (!tryHit(s, p, ct, !!inp.lob, 1)) {
          p.pk = { ct, lob: !!inp.lob, t: 9, late: 0.72 };
          ev(s, 'swing', { p: p.i });
        }
      }
    }

    if (p.stun > 0) { p.stun--; ax = ay = 0; m = 0; }
    const tired = (p.stamina < C.TIRED ? 0.86 : 1) * (p.ai ? 0.78 + 0.2 * s.skill : 1);
    if (p.dashT > 0) { p.dashT--; p.vx *= 0.94; p.vy *= 0.94; if (p.dashT === 0 && !air) p.recover = Math.max(p.recover, 6); }
    else if (p.diveT > 0) {
      p.diveT--; p.vx *= 0.9; p.vy *= 0.9;
      if (p.diveT === 0) p.stun = 26;
    } else if (p.squat > 0) {
      p.vx *= 0.86; p.vy *= 0.86; // loading the legs: the feet plant
    } else if (air) {
      // in the air the body carries its takeoff momentum; a little steering is all the legs give
      const top = C.TOP * tired;
      if (m > 0.05) { p.vx += (ax * top - p.vx) * C.AIR_ACCEL; p.vy += (ay * top - p.vy) * C.AIR_ACCEL; }
    } else {
      const top = C.TOP * tired * (p.ch ? 0.6 : 1) * (p.recover > 0 ? 0.5 : 1) * (p.landT > 0 ? 0.35 : 1);
      // nothing held: the placement assist may steer the last metre or two (see assistDir)
      if (m <= 0.05 && inp.as && !p.ai) { const a = assistDir(s, p); if (a) { ax = a.x; ay = a.y; m = Math.hypot(ax, ay); if (m > 0.12) { p.fx = ax / m; p.fy = ay / m; } } }
      run(p, ax, ay, m, top);
    }
    if (p.landT > 0) p.landT--;
    // vertical: the crouch ends in takeoff (out of a dash it is a long leap: the run carries on)
    if (p.squat > 0 && --p.squat === 0) {
      p.vz = C.JUMP_V; p.z = 0.001;
      const h = Math.hypot(p.vx, p.vy), cap = p.dashT > 0 ? C.LEAP_V : C.TOP;
      if (h > cap) { p.vx *= cap / h; p.vy *= cap / h; }
      p.dashT = 0;
    }
    if (p.z > 0 || p.vz > 0) {
      const vz0 = p.vz;
      p.vz -= C.PG / 60; p.z += (vz0 + p.vz) / 120; // trapezoid: the arc is exact for constant g
      if (p.z <= 0) {
        const hard = p.airSmash;
        ev(s, 'land', { p: p.i, x: r2(p.x), y: r2(p.y), v: r2(-p.vz), hard: hard ? 1 : 0 });
        p.z = 0; p.vz = 0; p.airSmash = false;
        p.landT = hard ? C.LAND_SMASH_T : C.LAND_T;
        p.vx *= 0.55; p.vy *= 0.55;
      }
    }
    p.x += p.vx / 60; p.y += p.vy / 60;
    bound(p);
  }
  // stay on your own half; a little behind the back line and beside the sidelines is the limit.
  // Shared with the client's prediction, so both agree exactly where the walls are.
  function bound(p) {
    const d = sideOf(p), back = C.L + 1.4, sideM = C.W + 1.6;
    if (d < 0) { if (p.x > -0.35) { p.x = -0.35; p.vx = Math.min(p.vx, 0); } if (p.x < -back) { p.x = -back; p.vx = Math.max(p.vx, 0); } }
    else { if (p.x < 0.35) { p.x = 0.35; p.vx = Math.max(p.vx, 0); } if (p.x > back) { p.x = back; p.vx = Math.min(p.vx, 0); } }
    if (p.y > sideM) { p.y = sideM; p.vy = Math.min(p.vy, 0); }
    if (p.y < -sideM) { p.y = -sideM; p.vy = Math.max(p.vy, 0); }
  }

  // ---------- shuttle step ----------
  function stepBall(s) {
    const b = s.ball;
    const px = b.x, py = b.y, pz = b.z;
    const dt = 1 / 60;
    const sp = Math.hypot(b.vx, b.vy, b.vz), dec = 1 / (1 + C.DRAG * sp * dt);
    b.vx *= dec; b.vy *= dec; b.vz = b.vz * dec - C.G * dt;
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    // the net plane: below the tape the shuttle stops dead and drops where it hit
    if ((px < 0) !== (b.x < 0)) {
      const u = (0 - px) / (b.x - px), yc = py + (b.y - py) * u, zc = pz + (b.z - pz) * u;
      const nh = netAt(yc);
      if (zc < nh) {
        b.x = -0.01 * Math.sign(b.vx || 1); b.y = yc; b.z = Math.max(0.02, zc); // dropped on the striker's side of the tape
        b.vx *= -0.06; b.vy *= 0.25; b.vz = Math.min(b.vz, -0.4);
        b.over = 0;
        ev(s, 'net', { x: 0, y: r2(yc), z: r2(zc) });
      }
    }
    if (b.z <= 0) { b.z = 0; return true; }
    return false;
  }

  // ---------- rally rules ----------
  function point(s, p, reason) {
    const rally = s.rally, b = s.ball;
    s.score[p]++;
    s.server = p;
    s.players[p].st.winners++;
    if (reason === 'out' || reason === 'own side') s.players[opp(p)].st.errors++;
    // a winner that came down hard: the floor takes the hit (the client shakes and dusts it)
    const slam = reason === 'winner' && FAST[s.lastKind] ? 1 : 0;
    ev(s, 'point', { p, reason, rally, score: s.score.slice(), x: r2(b.x), y: r2(b.y), kind: s.lastKind, slam, kmh: kmhOf(Math.hypot(b.vx, b.vy, b.vz)) });
    s.rally = 0; s.serveLive = 0; s.serveHold = false; s.lastHitter = -1;
    s.players.forEach(q => { q.ch = false; q.ct = 0; q.pk = null; });
    if (s.score[p] >= C.POINTS) { s.winner = p; ev(s, 'end', { winner: p, score: s.score.slice() }); setPhase(s, 'over'); }
    else setPhase(s, 'point');
  }

  const sideSign = i => (i === 0 ? -1 : 1);
  function resolveLanding(s) {
    const b = s.ball, hitter = s.lastHitter;
    if (hitter < 0) return;
    const receiver = opp(hitter);
    if (s.serveLive) {
      // the serve must land in the diagonal service court
      const legal = Math.sign(b.x) === sideSign(receiver)
        && Math.abs(b.x) >= C.SHORT - 0.05 && Math.abs(b.x) <= C.L + 0.05
        && Math.abs(b.y) <= C.W + 0.02
        && (s.serveY > 0 ? b.y >= 0 : b.y <= 0);
      if (legal) { s.players[hitter].st.aces++; point(s, hitter, 'ace'); }
      else point(s, receiver, 'fault');
      return;
    }
    const side = b.x < 0 ? 0 : 1;
    const inSingles = Math.abs(b.x) <= C.L && Math.abs(b.y) <= C.W;
    if (side === hitter) point(s, receiver, 'own side');
    else if (inSingles) point(s, hitter, 'winner');
    else point(s, receiver, 'out');
  }

  // ---------- main loop ----------
  function physics(s, inputs) {
    s.players.forEach((p, i) => stepPlayer(s, p, inputs[i]));
    if (s.serveHold) {
      const sv = s.players[s.server], d = sideOf(sv);
      Object.assign(s.ball, { x: sv.x - d * 0.5, y: sv.y, z: C.HOLD_Z, vx: 0, vy: 0, vz: 0 });
      return;
    }
    if (stepBall(s)) { resolveLanding(s); return; }
    // a shuttle balanced on the tape is resolved after half a second
    const b = s.ball;
    if (Math.abs(b.x) < 0.06 && b.z > 0 && b.z < netAt(b.y)) {
      if (++b.over > 30) resolveLanding(s);
    } else b.over = 0;
  }

  function stepSim(s, inputs) {
    s.tick++;
    const kickPressed = s.players.map((p, i) => p.init && inputs[i].kp !== p.lastKp);
    switch (s.phase) {
      case 'prematch':
        syncInputs(s, inputs);
        s.players.forEach((p, i) => stepPlayer(s, p, inputs[i]));
        if (++s.pt >= C.PRE_T) { ev(s, 'whistle'); setupServe(s); }
        break;
      case 'serve':
      case 'rally':
        if (s.hitstop > 0) { s.hitstop--; syncInputs(s, inputs); break; }
        physics(s, inputs);
        break;
      case 'point':
        syncInputs(s, inputs);
        s.players.forEach((p, i) => stepPlayer(s, p, inputs[i]));
        if (++s.pt >= C.POINT_T) setupServe(s);
        break;
      case 'over':
        kickPressed.forEach((v, i) => { if (v) s.ready[i] = true; });
        syncInputs(s, inputs);
        s.players.forEach((p, i) => stepPlayer(s, p, inputs[i]));
        s.pt++;
        break;
    }
  }

  // ---------- bot ----------
  // Predicts the shuttle (the same flight model), picks where to meet it — overhead while it is
  // high, in the air when it is higher still, otherwise at its landing spot — runs there, and
  // chooses the shot by contact height, the incoming shot and the rally.
  function predict(s) {
    const b = s.ball;
    let x = b.x, y = b.y, z = b.z, vx = b.vx, vy = b.vy, vz = b.vz;
    const dt = 1 / 30;
    let high = null, land = null, air = null;
    for (let t = 0; t < 5; t += dt) {
      const sp = Math.hypot(vx, vy, vz), dec = 1 / (1 + C.DRAG * sp * dt);
      vx *= dec; vy *= dec; vz = vz * dec - C.G * dt;
      const nx = x + vx * dt, ny = y + vy * dt, nz = z + vz * dt;
      if ((x < 0) !== (nx < 0)) { // crossing the net plane: below the tape it stops, above it flies on
        const u = (0 - x) / (nx - x), yc = y + (ny - y) * u, zc = z + (nz - z) * u;
        if (zc < netAt(yc)) { x = 0; y = yc; z = Math.max(zc, 0.05); vx = 0; vy *= 0.2; vz = Math.min(vz, -0.4); }
        else { x = nx; y = ny; z = nz; }
      } else { x = nx; y = ny; z = nz; }
      if (!air && vz < 0 && z < 3.4 && z > 2.85) air = { x, y, t, z };
      if (!high && vz < 0 && z < 2.25 && z > 1.55) high = { x, y, t, z };
      if (z <= 0.03) { land = { x, y, t }; break; }
    }
    return { high, land, air, at: s.tick };
  }

  // The bot's shot for an incoming shuttle: { want: charge ticks, lob }. `eta` is the ticks until
  // it can be met; nothing is planned that cannot be wound up in that time.
  function planShot(s, p, o, i, eta, k) {
    const r = Math.random(), R = n => (Math.random() * n) | 0, full = C.CHARGE_FULL;
    const canFull = eta >= full + 3;
    const netty = s.lastKind === 'net' || s.lastKind === 'drop' || s.lastKind === 'block';
    if (k.fast) { // a smash is coming: block, counter or lift, decided as it was struck
      const B = s.bot[i];
      if (B.defend === 'counter') return { want: C.COUNTER_CT + 1 + R(4), lob: false };
      if (B.defend === 'block') return { want: 3 + R(5), lob: false };
      return { want: 8 + R(6), lob: true };
    }
    if (k.inAir && canFull) return { want: full + 2 + R(6), lob: false };
    if (k.overhead) {
      if (canFull && r < 0.5 + 0.25 * s.skill && p.stamina > C.SMASH_COST + 4) return { want: full + 2 + R(8), lob: false };
      if (r < 0.75) return { want: Math.min(8 + R(8), Math.max(4, eta - 2)), lob: false }; // drop
      return { want: 10 + R(8), lob: true };                                              // clear
    }
    const nearNet = Math.abs(k.tx) < 2.2 * S;
    if (nearNet) {
      // break the net ping-pong: lift it and reset the rally (more so the longer it has gone on)
      if (r < 0.4 + (netty && s.rally > 2 ? 0.25 : 0)) return { want: 8 + R(8), lob: true };
      return { want: Math.min(5 + R(6), Math.max(3, eta - 2)), lob: false };
    }
    if (s.rally > 10 && canFull) return { want: full + 3 + R(6), lob: false }; // long rally: commit
    if (p.recover > 4 || p.stamina < 30) return { want: 10 + R(6), lob: true };
    // mid-court and deep: mostly lift it long (it gives the smash back), else drive or net it
    if (r < 0.5) return { want: 8 + R(8), lob: true };
    if (r < 0.8) return { want: Math.min(20 + R(12), Math.max(6, eta - 2)), lob: false };
    return { want: Math.min(5 + R(6), Math.max(3, eta - 2)), lob: false };
  }

  function botInput(s, i) {
    const p = s.players[i], o = s.players[1 - i], b = s.ball, B = s.bot[i];
    const inp = { u: 0, d: 0, l: 0, r: 0, k: false, kp: B.kp, kc: null, dc: B.dc, jp: B.jp, ax: 0, ay: 0, lob: false, sh: false, kn: B.kn, rb: 0 };
    if (s.phase !== 'rally' && s.phase !== 'serve') { B.ch = 0; B.jumpAt = -1; return inp; }
    const d = sideOf(p);
    if (s.phase === 'serve' && i !== s.server) return inp;

    if (s.phase === 'serve') {
      B.t++;
      if (B.t < 45) return inp;
      if (!B.ch) { B.ch = 1; B.ct = 0; B.want = Math.abs(o.x) > 2.6 * S || Math.random() < 0.4 ? 30 + ((Math.random() * 10) | 0) : 8 + ((Math.random() * 6) | 0); }
      else {
        B.ct++; inp.k = true;
        const dy = s.serveY * 1.2 - p.y;
        if (Math.abs(dy) > 0.1) { inp.ax = 0; inp.ay = Math.sign(dy); }
        if (B.ct >= B.want) { inp.k = false; inp.kp = ++B.kp; B.ch = 0; B.t = 0; }
      }
      return inp;
    }

    if (s.tick - B.predT > 4) {
      B.pred = predict(s); B.predT = s.tick;
      B.errX = (Math.random() * 2 - 1) * (1 - s.skill) * 0.7;
      B.errY = (Math.random() * 2 - 1) * (1 - s.skill) * 0.7;
    }
    // reaction: a new shot is not read instantly, and a lesser player is slower to commit
    if (b.last !== B.lastSeen) {
      B.lastSeen = b.last; B.seeAt = s.tick;
      // a new shot to answer: decide once whether to go up and meet it in the air
      B.goAir = Math.random() < 0.25 + 0.5 * s.skill;
      B.defend = FAST[s.lastKind] ? (Math.random() < 0.35 + 0.4 * s.skill ? 'counter' : Math.random() < 0.6 ? 'block' : 'lift') : '';
    }
    const fast = FAST[s.lastKind] && b.last !== i;
    // (a smash is read no faster than a person reads one: about a fifth of a second)
    const blind = s.tick - B.seeAt < (1 - s.skill) * (fast ? 30 : 55);
    const pred = B.pred;
    const mine = Math.sign(b.x || 1) === d;
    let tx = d * 3.1 * S, ty = clamp(-o.y * 0.45, -1.6 * S, 1.6 * S), urgent = 0, eta = 999, overhead = false, inAir = false;
    if (blind) { /* still reading it: hold the base position */ }
    else if (pred && pred.land && Math.sign(pred.land.x || 1) === d) {
      // it is coming to this side: run to where it can be met, from the moment it is struck
      inAir = !!(B.goAir && pred.air && Math.sign(pred.air.x || 1) === d && pred.air.t > 0.45 && p.stamina > 40 && !fast);
      overhead = !inAir && !!(pred.high && pred.high.z > 1.5 && pred.high.t < pred.land.t - 0.02 && Math.sign(pred.high.x || 1) === d);
      const meet = inAir ? pred.air : overhead ? pred.high : pred.land;
      // a lesser player does not read it perfectly: the meeting point drifts off
      tx = meet.x + (B.errX || 0); ty = meet.y + (B.errY || 0);
      eta = Math.max(0, meet.t * 60 - (s.tick - B.predT)); // ticks until the shuttle is meetable
      urgent = Math.max(0, 55 - eta);
      // takeoff so the top of the jump meets it: crouch + rise = JUMP_SQUAT + JUMP_V/PG seconds
      if (inAir && !airborne(p) && p.squat === 0) {
        const rise = C.JUMP_SQUAT + Math.round(C.JUMP_V / C.PG * 60);
        if (eta <= rise + 1 && eta >= rise - 3 && Math.hypot(tx - p.x, ty - p.y) < 1.1) inp.jp = ++B.jp;
      }
    } else if (pred && pred.land) {
      tx = d * 3.1 * S; ty = clamp(pred.land.y * 0.4, -1.7 * S, 1.7 * S); // cover the likely return line
    } else if (b.last === i) {
      tx = d * 3.1 * S; ty = 0;
    }
    const mx = tx - p.x, my = ty - p.y, md = Math.hypot(mx, my);
    if (md > 0.12) { inp.ax = clamp(mx / md, -1, 1); inp.ay = clamp(my / md, -1, 1); }
    if (urgent > 30 && md > 1.1 && p.dashCd === 0 && p.stamina > C.DASH_COST + 6 && !airborne(p)) inp.dc = ++B.dc;

    const bd = Math.hypot(b.x - p.x, b.y - p.y);
    // bracing: a smash is too quick to react to, so it is read from the wind-up. When the opponent
    // is loading an overhead with the shuttle high on their side, a good defender loads too, and
    // releases as it arrives (a counter); otherwise it is blocked late
    if (!B.ch && !mine && b.last === i && o.ch && o.ct > 22 && b.z > C.HIGH_Z && p.hitCd === 0 && s.phase === 'rally') {
      if (B.braceFor !== B.seeAt) { B.braceFor = B.seeAt; B.brace = Math.random() < 0.3 + 0.45 * s.skill; }
      if (B.brace) { B.ch = 1; B.ct = 0; B.want = 0; B.lob = false; B.lastBd = bd; B.bracing = true; }
    }
    // choose the shot while the shuttle is on its way, so the wind-up lands on it: the charge
    // length is the plan, and the swing is timed by the prediction
    // (from as high as it flies: a clear hangs for two seconds, and a smash needs 0.7 of them)
    // (a counter is loaded the moment a smash is struck: anticipation, not reaction)
    const preload = fast && B.defend === 'counter';
    if (!B.ch && p.hitCd === 0 && mine && b.last !== i && b.z > 0.05 && (!blind || preload) && eta < 400) {
      // the plan is made once per incoming shot, from the time there is to wind up: a smash needs
      // a full charge (0.7 s), so it is only on when the shuttle hangs long enough for one
      if (B.planFor !== B.seeAt) { B.planFor = B.seeAt; B.plan = planShot(s, p, o, i, eta, { fast, inAir, overhead, tx }); }
      const { want, lob } = B.plan;
      // start the wind-up on the prediction's clock: the swing is ready when the shuttle arrives
      if (eta <= want + 2 || preload) { B.ch = 1; B.ct = 0; B.want = want; B.lob = lob; B.lastBd = bd; }
    }
    // a brace is held until their shot comes; a wrong read (they dropped instead) is an overcooked
    // swing when it arrives, which is the price of guessing
    if (B.ch && B.bracing && b.last !== i) B.bracing = false;
    if (B.ch) {
      B.ct++; inp.k = true; inp.lob = !!B.lob;
      // swing once the planned charge is in and the shuttle is in reach — or at once if it is
      // about to leave reach (dropping below the planned contact height, or passing out of range)
      const inReach = bd < C.REACH * 0.95 && b.z <= p.z + C.MAX_Z - 0.05 && b.z >= p.z + 0.08;
      const lowest = B.want >= C.CHARGE_FULL && b.z > C.HIGH_Z ? p.z + C.HIGH_Z + 0.05 : p.z + 0.25;
      const nb = { x: b.x + b.vx * 3 / 60, y: b.y + b.vy * 3 / 60, z: b.z + b.vz * 3 / 60 };
      const leaving = nb.z < lowest || Math.hypot(nb.x - p.x, nb.y - p.y) > C.REACH * 0.95 || (s.tick - B.predT > 0 && eta <= 0 && B.ct > B.want + 8);
      B.lastBd = bd;
      if (inReach && (B.ct >= B.want || leaving)) {
        // release: stop, and face the open court so the aim does the work
        inp.k = false; inp.kp = ++B.kp; B.ch = 0;
        inp.ax = 0; inp.ay = 0;
        const aimY = o.y > 0.2 ? -2.1 * S : o.y < -0.2 ? 2.1 * S : (Math.random() < 0.5 ? -1 : 1) * 1.6 * S;
        const ax2 = -d * 4 * S, ay2 = aimY - p.y, al = Math.hypot(ax2, ay2) || 1;
        p.fx = ax2 / al; p.fy = ay2 / al;
      } else if (md > 0.05) { // keep moving to the meeting point while winding up
        inp.ax = clamp(mx / md, -1, 1); inp.ay = clamp(my / md, -1, 1);
      }
    }
    return inp;
  }

  // ---------- network snapshot ----------
  const KIND_CODE = ['', 'smash', 'jsmash', 'kill', 'drive', 'clear', 'lift', 'drop', 'net', 'block', 'counter', 'servel', 'serveh'];
  function netState(s) {
    const b = s.ball;
    return {
      ph: s.phase, pt: s.pt, ps: s.ps, rc: s.rally, lh: s.lastHitter, lk: s.lastKind,
      sc: s.score, sv: s.server, sy: s.serveY, sl: s.serveLive, hold: s.serveHold ? 1 : 0,
      rd: s.ready.map(Number), hs: s.hitstop, w: s.winner,
      b: [r2(b.x), r2(b.y), r2(b.z), r2(b.vx), r2(b.vy), r2(b.vz)],
      // 0 x, 1 y, 2 vx, 3 vy, 4 fx, 5 fy, 6 charge (-1 idle), 7 dashing, 8 diving, 9 stamina,
      // 10 stunned, 11 recovering, 12 swing timer, 13 hit cooldown, 14 z, 15 vz, 16 crouching to
      // jump (ticks left), 17 landing (ticks left), 18 last shot kind (KIND_CODE index)
      p: s.players.map(p => [r2(p.x), r2(p.y), r2(p.vx), r2(p.vy), r2(p.fx), r2(p.fy),
        p.ch ? Math.min(p.ct, 90) : -1, p.dashT > 0 ? 1 : 0, p.diveT > 0 ? 1 : 0, Math.round(p.stamina),
        p.stun > 0 ? 1 : 0, p.recover > 0 ? 1 : 0, p.anim, p.hitCd > 0 ? 1 : 0,
        r2(p.z), r2(p.vz), p.squat, p.landT, Math.max(0, KIND_CODE.indexOf(p.swing))]),
      st: s.players.map(p => [p.st.hits, p.st.smashes, p.st.perfects, p.st.winners, p.st.aces, p.st.dives, p.st.maxRally]),
    };
  }

  return { C, SHOTS, KIND_CODE, run, bound, assistDir, createSim, stepSim, syncInputs, setPhase, botInput, netState, predict, fly, netAt, kmhOf, shotKind, _launch: launch, _launchAngle: launchAngle, _quality: quality };
});
