// Office Badminton — shared game simulation.
// Runs authoritatively on the server; the browser loads it for constants and prediction.
//
// Design: arcade first, physics honest. The court is a real one scaled up by S in plan (more room
// to move, more space to hit into); the shuttle's flight is scaled with it exactly (see C.G and
// C.DRAG), so every trajectory keeps its real shape and timing. Every shot is solved backwards
// from a target, so flights are predictable and the skill lives in positioning, timing and
// contact. Players run, sprint, dive and jump; the shot you get follows from where and how you meet
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
    // players: fast and arcade-y, with a sprint, a desperation dive, a jump and light stamina
    TOP: 8.2, AIR_ACCEL: 0.035,
    // running (m/s²): speeding up along your line, cutting or reversing (the planted foot pushes
    // harder), and braking when you let go. The last TAPER m/s of any change eases in rather than
    // stopping dead, so a stop is crisp (about 0.4 m from full speed) but never a snap.
    A_RUN: 34, A_TURN: 60, A_BRAKE: 72, TAPER: 1.4,
    // placement assist: with no direction held, a player glides the last ASSIST_R metres to the
    // spot where the incoming shuttle is best met (any direction input takes over at once)
    ASSIST_R: 2.4, ASSIST_V: 0.8,
    REACH: 1.45, SWEET: 0.55, SWEET_Z: 2.25, MAX_Z: 2.9, HIGH_Z: 1.75, MID_Z: 0.85,
    // sprint (hold Shift): a longer, faster stride that burns stamina while it lasts (~3 s from full)
    SPRINT_V: 10.2, SPRINT_COST: 0.55, SPRINT_MIN: 6,
    // the dive (double-tap Shift): a last-ditch launch low along the run, the racket stretched out.
    // It covers ~2 m in the air, reaches half as far again as a stand, and hits whatever it meets
    // soft; then the player is on the floor for DIVE_REC ticks getting up, out of the rally
    DIVE_V: 13.5, DIVE_T: 20, DIVE_CD: 80, DIVE_REACH: 1.45, DIVE_REC: 40, DIVE_AIM: 0.6,
    // jumping: a 4-tick crouch, then takeoff. Player gravity is a touch stronger than real (snappier
    // hang): apex JUMP_V²/2PG = 0.76 m after 0.33 s, 0.66 s in the air
    PG: 14, JUMP_V: 4.6, JUMP_SQUAT: 4, JUMP_COST: 10, LAND_T: 6, LAND_SMASH_T: 13, LEAP_V: 9.4,
    ST_MAX: 100, ST_REGEN: 0.245, DIVE_COST: 30, SMASH_COST: 12, JSMASH_COST: 8, PERF_REGEN: 9, TIRED: 22,
    CHARGE_FULL: 42, PERF_END: 58, COUNTER_CT: 14,
    REC_SMASH: 20, REC_CLEAR: 15, REC_SHOT: 10, SWING_T: 5,
    HOLD_Z: 0.95,
    // arcade controls (keyboard: move + A hit + B soft): one running speed, no sprint; a whiffed
    // press locks the racket for ARC_LOCK ticks; a press with the shuttle out of reach but coming
    // down within ARC_DIVE_R metres in ARC_DIVE_T ticks dives for it
    ARC_TOP: 9.0, ARC_LOCK: 18, ARC_DIVE_R: 4.0, ARC_DIVE_T: 22, ARC_DIVE_REC: 22,
    // the arcade forgiveness: a press reaches ARC_STRETCH further (the body stretches the rest of
    // the way, ARC_NUDGE ticks), and an early press is held ARC_BUF ticks for the shuttle to come
    ARC_STRETCH: 0.7, ARC_NUDGE: 7, ARC_BUF: 14,
    // ...and a late one is played at the last moment the shuttle was there to hit, up to ARC_LATE
    // ticks before (the landing is ruled on ARC_GRACE ticks late for it)
    ARC_LATE: 8, ARC_GRACE: 12,
    POINTS: 7, PRE_T: 210, POINT_T: 110, OVER_T: 60 * 8, PAUSE_T: 60 * 12,
    // ---- the hype system (one switch: HYPE false plays the game exactly as before it) ----
    // tempo: a long rally speeds up. From hit TEMPO_FROM to TEMPO_FULL every flight plays up to
    // TEMPO_MAX faster: the same line, the shuttle's own clock run quicker (the ball's w, which
    // every flight model here reads), so it cannot go stale.
    // pot: every hit past the first few adds to a pot the point's winner takes as heat.
    // fire: at FIRE_AT heat the next attacking hit (A: smash, kill, drive, counter) is a Fire Shot,
    // FIRE_SPEED faster; only a perfectly timed return survives it (and takes FIRE_PARRY heat),
    // anything else is overpowered into the net. Firing spends all the heat.
    // steal: winning a point off a player at STEAL_AT heat or more takes STEAL of it.
    HYPE: true, TEMPO_FROM: 4, TEMPO_FULL: 24, TEMPO_MAX: 0.3,
    FIRE_AT: 85, FIRE_SPEED: 1.25, FIRE_PARRY: 35, STEAL_AT: 60, STEAL: 25,
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
  // ---- hype: rally tempo and pot (pure functions of the rally count, so the client shows them too)
  const ATTACK = { smash: 1, jsmash: 1, kill: 1, drive: 1, counter: 1 };
  function tempoOf(rally) {
    if (!C.HYPE) return 1;
    const t = Math.min(1, Math.max(0, (rally - C.TEMPO_FROM) / (C.TEMPO_FULL - C.TEMPO_FROM)));
    return 1 + C.TEMPO_MAX * t * t * (3 - 2 * t);
  }
  function potOf(rally) {
    if (!C.HYPE) return 0;
    let pot = 0;
    for (let h = 4; h <= rally; h++) pot += h < 10 ? 2 : h < 20 ? 3 : 4;
    return pot;
  }
  // the shuttle's real speed: its velocity runs on its own clock (w: the hype tempo, 1 at rest)
  const ballSpeed = b => Math.hypot(b.vx, b.vy, b.vz) * (b.w || 1);
  // heat in or out, with an event when a player crosses into Fire Shot range
  function addHeat(s, i, amt) {
    const was = s.heat[i];
    s.heat[i] = clamp(was + amt, 0, 100);
    if (C.HYPE && was < C.FIRE_AT && s.heat[i] >= C.FIRE_AT) ev(s, 'armed', { p: i });
  }
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
      sprint: false, diveT: 0, diveCd: 0, floorT: 0, stun: 0, recover: 0,
      squat: 0, landT: 0, airSmash: false,
      stamina: C.ST_MAX, hitCd: 0, lastKp: 0, lastDv: 0, lastKn: 0, lastJp: 0, lastSw: 0, init: false, ai: false, ez: false, aim: null, swPerfect: null,
      arc: false, lock: 0, dep: null, armed: null, nudge: null, _mt: null, _mg: null,
      st: { hits: 0, smashes: 0, perfects: 0, winners: 0, aces: 0, dives: 0, maxRally: 0, errors: 0, jumps: 0, counters: 0, kills: 0 },
    };
  }

  // Practice-bot difficulty: the skill (0..1) every bot decision scales with: how fast it reads a
  // shot, how well it judges where to meet it, how cleanly it strikes, how often it errs, how fast
  // it runs, and how willing it is to smash, counter, jump and dive.
  const BOT_LEVELS = { easy: 0.3, normal: 0.62, hard: 0.84, pro: 0.97 };
  // opts.botSkill: 0..1 (practice opponent).
  function createSim(tick, opts = {}) {
    const s = {
      tick, players: [mkPlayer(0), mkPlayer(1)],
      ball: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, last: -1, stuck: 0, over: 0 },
      score: [0, 0], heat: [0, 0], server: 0, serveY: 1, serveLive: 0, serveHold: false,
      phase: 'prematch', pt: 0, ps: tick, rally: 0, lastHitter: -1, lastKind: '',
      hitstop: 0, winner: -1, events: [], ready: [false, false],
      skill: opts.botSkill != null ? opts.botSkill : 0.62,
      ez: [null, null], // trackpad-controls state per player (see ezInput)
      bh: [],            // the shuttle (and players) over the last SWIPE.REWIND ticks (see swipeShot)
      bot: [0, 1].map(() => ({ ch: 0, want: 0, ct: 0, kp: 0, dv: 0, kn: 0, jp: 0, t: 0, pred: null, predT: -99, plan: '', jumpAt: -1 })),
    };
    if (opts.ai) s.players.forEach(p => { p.ai = Array.isArray(opts.ai) ? !!opts.ai[p.i] : !!opts.ai; });
    setupServe(s);
    s.phase = 'prematch'; s.pt = 0;
    return s;
  }

  function setPhase(s, ph) {
    s.phase = ph; s.pt = 0; s.ps = s.tick;
    if (ph === 'prematch') { s.heat = [0, 0]; s.fire = null; }
  }
  function ev(s, type, o) { if (!s.quiet) s.events.push(Object.assign({ type, tick: s.tick }, o)); }

  // ---------- serve ----------
  function setupServe(s) {
    const sv = s.server, d = sv === 0 ? -1 : 1;      // the server's side of the net
    const even = s.score[sv] % 2 === 0;
    const sy = (even ? 1 : -1) * 1.05 * S;           // right service court on even points
    const ry = -sy;                                  // the receiver stands diagonally opposite
    const sa = s.players[sv], ra = s.players[opp(sv)];
    const reset = { vx: 0, vy: 0, z: 0, vz: 0, ch: false, ct: 0, pk: null, anim: 0, stun: 0, sprint: false, diveT: 0, floorT: 0, recover: 0, hitCd: 0, squat: 0, landT: 0, airSmash: false };
    Object.assign(sa, reset, { x: d * 2.45 * S, y: sy, fx: -d, fy: 0 });
    Object.assign(ra, reset, { x: -d * 2.55 * S, y: ry, fx: d, fy: 0 });
    for (const p of s.players) p.stamina = Math.max(p.stamina, 62);
    s.bh = []; s.landAt = null;
    s.serveY = ry; s.serveLive = 0; s.serveHold = true; s.lastHitter = -1; s.lastKind = '';
    Object.assign(s.ball, { x: sa.x - d * 0.5, y: sy, z: C.HOLD_Z, vx: 0, vy: 0, vz: 0, last: -1, stuck: 0, over: 0, w: 1 });
    setPhase(s, 'serve');
    ev(s, 'serve', { p: sv, y: r2(ry) });
  }

  function syncInputs(s, inputs) {
    s.players.forEach((p, i) => {
      const inp = inputs[i];
      p.lastKp = inp.kp; p.lastDv = inp.dv | 0; p.lastKn = inp.kn; p.lastJp = inp.jp | 0; p.init = true;
      if (s.phase !== 'serve' && s.phase !== 'rally') { p.ch = false; p.ct = 0; p.pk = null; p.lastSw = inp.sw | 0; }
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
    // (an arcade press: the sweet zone and the reach both stretched, a step's worth more forgiving)
    const far = p.arc && p.swQ != null ? C.ARC_STRETCH : 0, sw = C.SWEET + far * 0.7;
    const qr = clamp(1 - (d - sw) / (C.REACH + far - sw), 0, 1);
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
    const stretch = p.arc && p.swQ != null && p.diveT === 0 ? C.ARC_STRETCH : 0;
    const reach = (p.diveT > 0 ? C.REACH * C.DIVE_REACH : airborne(p) ? C.REACH * 0.9 : C.REACH) + stretch;
    if (d > reach || b.z > p.z + C.MAX_Z || b.z < Math.max(0.02, p.z - 0.15)) return false;
    if (stretch && d > C.REACH * 0.9 && !airborne(p)) { // reached for: the body goes the rest of the way
      const go = (d - C.REACH * 0.9) / C.ARC_NUDGE;
      p.nudge = { x: (b.x - p.x) / d * go, y: (b.y - p.y) / d * go, t: C.ARC_NUDGE };
    }
    let q = quality(s, p, lateMul);
    // a swipe: the timing grade sets the contact, how well placed the striker is scales it
    if (p.swQ != null) q = clamp(p.swQ * (0.55 + 0.45 * clamp(q / 0.8, 0, 1)), 0.05, 1);
    if (p.ez) ct = Math.min(ct, C.CHARGE_FULL - 2); // trackpad swings are good, never perfect
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
    const incoming = ballSpeed(b);
    if (FAST[s.lastKind] && incoming > FAST_V && !air) {
      if (lob) return 'lift';
      return ct < C.COUNTER_CT ? 'block' : 'counter';
    }
    // near the net with the shuttle floating above the tape: put it away
    const atTape = Math.abs(b.x) < 1.1 * S && Math.abs(p.x) < 1.8 * S;
    if (!lob && atTape && b.z > netAt(b.y) + 0.25 && pct >= 0.8) return 'kill';
    // arcade controls: B (soft) at the tape is a net shot, at waist height a drop; a perfect A
    // (hit) on a shuttle overhead is a jump smash, the leap played from the ground (see shoot)
    const soft = p.arc && pct < 0.35;
    if (soft && atTape) return 'net';
    if (rz >= C.HIGH_Z) return lob ? 'clear' : pct >= 0.8 ? (air || (p.arc && p.swPerfect) ? 'jsmash' : 'smash') : pct >= 0.35 ? 'drive' : 'drop';
    if (rz >= C.MID_Z) return lob ? 'lift' : soft ? 'drop' : 'drive';
    return lob ? 'lift' : pct >= 0.75 ? 'clear' : 'net';
  }

  function shoot(s, p, ct, lob, q, onTime) {
    const b = s.ball;
    const serving = s.phase === 'serve' && s.lastHitter === -1;
    const pct = pctOf(ct), power = powerOf(ct), over = isOvercharge(ct);
    const incoming = ballSpeed(b);
    let kind = shotKind(s, p, ct, lob);
    // no legs, no smash; a scuffed counter pops up instead
    // (on arcade controls stamina is hidden: it never takes a smash away, it only slows it; see below)
    if ((kind === 'smash' || kind === 'jsmash') && (q < 0.55 || (!p.arc && p.stamina < C.SMASH_COST))) kind = 'drop';
    if (kind === 'counter' && q < 0.5) kind = 'lift';
    // a parry: a counter met cleanly the instant the button came up (not a buffered late swing)
    const parry = kind === 'counter' && onTime && q >= 0.8 && !p.ez;
    let perfect = (p.swPerfect != null ? p.swPerfect && kind !== 'block' : power >= 1.25 && kind !== 'block' && kind !== 'counter') || parry;
    // hype: a Fire Shot coming in is only survived by a perfectly timed return (any shot, a block
    // too); the bot reads one some of the time. The Fire Shot is spent on this contact either way.
    const fireIn = C.HYPE && !serving && s.fire && s.fire.by !== p.i;
    const fireHeld = fireIn && ((p.swPerfect != null ? p.swPerfect : power >= 1.25) || parry || (p.ai && Math.random() < 0.2 + 0.35 * s.skill));
    if (fireIn) s.fire = null;
    // hype: at FIRE_AT heat an attacking hit goes out as a Fire Shot
    const fireOut = C.HYPE && !serving && !fireIn && ATTACK[kind] && s.heat[p.i] >= C.FIRE_AT;
    const dir = sideOf(p), oppSign = -dir;
    // aim: facing decides the line; overcharge and bad contact smear it
    const f = { x: p.fx, y: p.fy };
    if (over) f.y += (Math.random() * 2 - 1) * 0.22;
    const smear = (1 - q) * 1.0 + (over ? 0.35 : 0) + (p.ai ? (1 - s.skill) * 0.5 : 0);
    let smearA = 0;
    if (smear > 0.01) {
      const a = smearA = (Math.random() * 2 - 1) * smear;
      const c = Math.cos(a), sn = Math.sin(a);
      const fx = f.x * c - f.y * sn; f.y = f.x * sn + f.y * c; f.x = fx;
    }
    // trackpad controls aim at a spot rather than along the facing: the same smear moves it by the
    // angle it turns the line through, over the distance to the spot
    const aim = p.aim && !serving ? p.aim : null;
    const aimY = aim ? aim.y + Math.sin(smearA) * Math.hypot(aim.x - b.x, aim.y - b.y) : 0;
    const o = s.players[opp(p.i)];
    const plan = k => {
      const sh = SHOTS[k];
      let depth = sh.min + (sh.max - sh.min) * clamp(q * 0.5 + pct * 0.5, 0, 1);
      if (k === 'smash' || k === 'jsmash' || k === 'kill') depth = sh.min + (sh.max - sh.min) * clamp(pct, 0, 1);
      // arcade controls: the stick sets the length (forward deep, back short, nothing: the middle)
      if (p.dep != null && !serving && k !== 'block') depth = sh.min + (sh.max - sh.min) * clamp(0.55 + 0.45 * p.dep, 0, 1);
      if (q < 0.6 && (k === 'clear' || k === 'drive' || k === 'lift')) depth *= 0.58 + 0.42 * q; // mishits fall short
      if (k === 'net' || k === 'drop') depth = Math.max(depth, (Math.abs(p.x) - 0.35) * 0.5); // from deep, a soft shot lands mid-court at best
      if (serving) depth = sh.min + (sh.max - sh.min) * clamp(pct, 0, 1);
      const tx = oppSign * (k === 'servel' || k === 'serveh' ? C.SHORT + depth : depth);
      let ty;
      if (serving) ty = clamp(s.serveY * (k === 'serveh' ? 1.6 : 1.3) + f.y * 0.5 * S, s.serveY > 0 ? 0.4 : -2.25 * S, s.serveY > 0 ? 2.25 * S : -0.4);
      // a counter goes where the smasher is not: the open side, as far as the aim allows
      else if (k === 'counter') ty = aim ? clamp(aimY, -2.5 * S, 2.5 * S) : clamp((o.y > 0 ? -1 : 1) * 1.9 * S + f.y * 0.8 * S, -2.5 * S, 2.5 * S);
      else if (aim) ty = clamp(aimY + (Math.random() * 2 - 1) * Math.max(0, 0.55 - q * 0.45) * 1.4 * S, -2.6 * S, 2.6 * S);
      else ty = clamp(f.y * 2.75 * S + (Math.random() * 2 - 1) * Math.max(0, 0.55 - q * 0.45) * 1.4 * S, -2.6 * S, 2.6 * S);
      return { tx, ty };
    };
    // racket speed: contact quality, a perfect release, and for a jump smash how high it was met
    const lift = clamp((b.z - 2.6) / 0.9, 0, 1);
    let speedMul = (0.82 + 0.18 * q) * (perfect ? 1.07 : 1) * (over ? 0.92 : 1);
    if (kind === 'jsmash') speedMul *= 1 + 0.12 * lift;
    // hidden stamina: smash after smash, each comes off a little slower (up to 10%)
    if (p.arc && (kind === 'smash' || kind === 'jsmash')) speedMul *= 0.9 + 0.1 * clamp(p.stamina / C.ST_MAX, 0, 1);
    if (kind === 'counter') speedMul *= clamp(0.55 + incoming / (SHOTS.jsmash.cap * 1.6), 0.7, 1) * (parry ? 1.15 : 1); // it borrows the smash's pace
    // hype: the rally's tempo, and a Fire Shot's pace on top, run the new flight's clock faster
    const tempo = serving ? 1 : tempoOf(s.rally + 1);
    let { tx, ty } = plan(kind);
    let lv = null, res = null;
    // (an arcade jump smash from the ground is met at the top of the leap it makes: higher)
    if (kind === 'jsmash' && !airborne(p)) b.z += 0.35;
    const from = { x: b.x, y: b.y, z: b.z };
    // attack shots are a racket speed, not a placement: the steepest clean line for the aim
    // (a counter is placed like a drive, on the flattest line the solver finds: the fastest one)
    const STEEP = { smash: [-42, -10], jsmash: [-55, -12], kill: [-62, -14] };
    if (STEEP[kind]) {
      let a = launchAngle(from, tx, ty, SHOTS[kind].cap * speedMul, STEEP[kind][0], STEEP[kind][1]);
      // a jump smash with no line at its pace is still a smash
      if (!a && kind === 'jsmash') { kind = 'smash'; ({ tx, ty } = plan(kind)); a = launchAngle(from, tx, ty, SHOTS.smash.cap * speedMul, STEEP.smash[0], STEEP.smash[1]); }
      if (a) { lv = a.lv; res = a.res; }
      else kind = 'drop'; // no clean line from here: it comes off soft
    }
    // a really bad contact (stretched, late, diving, overcooked) can simply go wrong: into the
    // tape, long, or wide. The worse the contact, the likelier.
    let error = '';
    // hype: a Fire Shot not met perfectly overpowers the racket: flat into the tape
    const burned = fireIn && !fireHeld;
    if (burned || (!serving && q < 0.3 && Math.random() < (0.3 - q) / 0.3 * 0.75)) {
      const r = Math.random();
      error = burned ? 'net' : r < 0.4 ? 'net' : r < 0.7 ? 'long' : 'wide';
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
    const fire = fireOut && !error && ATTACK[kind];
    b.w = tempo * (fire ? C.FIRE_SPEED : 1) * (fireIn && fireHeld ? 1.1 : 1);
    const sp = Math.hypot(lv.vx, lv.vy, lv.vz) * b.w;
    const shot = SHOTS[kind];
    b.vx = lv.vx; b.vy = lv.vy; b.vz = lv.vz;
    b.last = p.i; b.stuck = 0;
    s.serveHold = false;
    if (s.phase === 'serve') s.phase = 'rally';
    s.serveLive = serving ? 1 : 0; // once the receiver returns it, it is just a rally
    p.anim = 8; p.hitCd = 3; p.recover = shot.rec; p.ch = false; p.ct = 0; p.pk = null; p.swing = kind; p.aim = null;
    if (kind === 'smash' || kind === 'jsmash') {
      p.stamina = Math.max(0, p.stamina - (kind === 'jsmash' ? C.JSMASH_COST : C.SMASH_COST));
      p.st.smashes++;
      if (kind === 'jsmash') p.airSmash = true; // a heavier landing
      // arcade controls: a perfect hit overhead from the ground leaps into it as it strikes
      if (kind === 'jsmash' && !airborne(p)) { p.vz = C.JUMP_V * 0.8; p.z = 0.001; p.squat = 0; p.st.jumps++; ev(s, 'jump', { p: p.i, x: r2(p.x), y: r2(p.y), leap: 0 }); }
    }
    if (kind === 'counter') p.st.counters++;
    if (kind === 'kill') p.st.kills++;
    // hit-stop: the whole sim holds for a beat on a big contact, so it lands with weight
    const hs = (shot.hs || 0) + (perfect && shot.hs ? (kind === 'jsmash' ? 3 : 2) : 0) + (parry ? 3 : 0);
    if (hs) s.hitstop = Math.max(s.hitstop, hs);
    if (perfect) { p.stamina = Math.min(C.ST_MAX, p.stamina + C.PERF_REGEN); p.st.perfects++; }
    // Cosmetic momentum belongs to the simulation, including quiet prediction. Serves are
    // free contacts; only a return without a generated mishit earns contact heat.
    if (fire) { s.fire = { by: p.i }; s.heat[p.i] = 0; p.st.fires = (p.st.fires || 0) + 1; }
    else if (!serving && !error) addHeat(s, p.i, 4 + (perfect ? 6 : 0) + (parry ? 8 : 0) + (fireIn && fireHeld ? C.FIRE_PARRY : 0));
    s.rally++;
    p.st.maxRally = Math.max(p.st.maxRally, s.rally);
    p.st.hits++;
    s.lastHitter = p.i; s.lastKind = kind;
    ev(s, 'hit', {
      p: p.i, kind, q: r2(q), perfect: perfect ? 1 : 0, g: p.swGrade != null ? p.swGrade : undefined, parry: parry ? 1 : 0, air: airborne(p) ? 1 : 0, err: error,
      kmh: kmhOf(sp), in: kmhOf(incoming), fire: fire ? 1 : 0, fireHeld: fireIn && fireHeld ? 1 : 0, burned: burned ? 1 : 0, tempo: r2(tempo),
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
  // Where to meet the incoming shuttle, and where to stand for it (beside and a little behind, the
  // shuttle on the racket side). The meet is a point the player can actually get to from where they
  // were when the flight was first read: overhead if they can be under it in time (away from the
  // net), else at waist height or below once it has dropped there, with a little time to spare,
  // else as late as it can be taken.
  // Fixed once per flight (kept on p._mt, tick-stamped, so the server and a client predicting the
  // same player agree on it), read again only when the flight changes (off the net cord).
  // Returns { x, y: the standing spot, t: seconds to the meet, z, bx, by: the meet } or null.
  function meetPlan(s, p, d) {
    const b = s.ball, dt = (b.w || 1) / 60, top = (p.arc ? C.ARC_TOP : C.TOP) * 0.9; // (dt: a tick on the shuttle's clock)
    let x = b.x, y = b.y, z = b.z, vx = b.vx, vy = b.vy, vz = b.vz;
    let high = null, easy = null, tight = null, late = null;
    for (let k = 1; k <= 300; k++) {
      const sp = Math.hypot(vx, vy, vz), dec = 1 / (1 + C.DRAG * sp * dt);
      vx *= dec; vy *= dec; vz = vz * dec - C.G * dt;
      const nx = x + vx * dt, ny = y + vy * dt, nz = z + vz * dt;
      if ((x < 0) !== (nx < 0)) { const u = (0 - x) / (nx - x), yc = y + (ny - y) * u, zc = z + (nz - z) * u; if (zc < netAt(yc)) break; }
      x = nx; y = ny; z = nz;
      if (z <= 0) break;
      if (Math.sign(x || 1) !== d || Math.abs(x) < 0.3 || z < 0.42 || z > 2.35) continue;
      const sx = x + d * 0.35, sy = y + d * 0.4; // (facing the net, the racket side is toward -d·y)
      const dist = Math.hypot(sx - p.x, sy - p.y), need = dist < 0.3 ? 0 : 0.12 + dist / top, t = k / 60;
      const c = { k, x: sx, y: sy, z, bx: x, by: y };
      late = c;
      if (need > t) continue;
      if (!high && z >= 1.55 && vz < 0 && Math.abs(x) > 1.6 && need <= t * 0.85) high = c;
      if (!easy && z <= 1.3 && need <= t * 0.8 - 0.03) easy = c;
      if (!tight && z <= 1.3) tight = c;
    }
    return high || easy || tight || late;
  }
  function meetTarget(s, p) {
    const b = s.ball;
    if ((s.phase !== 'rally' && s.phase !== 'serve') || s.serveHold || b.last < 0 || b.last === p.i) { p._mt = null; return null; }
    const d = sideOf(p);
    if (!s._pred || s._predT !== s.tick) { s._pred = predict(s); s._predT = s.tick; }
    const pr = s._pred;
    if (!pr.land || Math.sign(pr.land.x || 1) !== d) return null;
    let m = p._mt;
    if (!m || m.last !== b.last || Math.hypot(m.lx - pr.land.x, m.ly - pr.land.y) > 0.4 || s.tick < m.at) {
      const c = meetPlan(s, p, d);
      if (!c) return null;
      m = p._mt = { last: b.last, lx: pr.land.x, ly: pr.land.y, at: s.tick, k: s.tick + c.k, x: c.x, y: c.y, z: c.z, bx: c.bx, by: c.by };
    }
    return { x: m.x, y: m.y, t: (m.k - s.tick) / 60, z: m.z, bx: m.bx, by: m.by };
  }
  function assistDir(s, p) {
    const m = meetTarget(s, p);
    if (!m || m.t < 0.08) return null;
    const tx = m.x, ty = m.y;
    const ex = tx - p.x, ey = ty - p.y, dist = Math.hypot(ex, ey);
    if (dist < 0.1 || dist > C.ASSIST_R) return null;
    const k = Math.min(C.ASSIST_V, Math.sqrt(2 * MAG.A * dist) / C.ARC_TOP, dist / 0.35) / dist;
    return { x: ex * k, y: ey * k };
  }

  // Magnetic steering (keyboard and swipe). A direction held roughly toward the meet spot is bent
  // onto it, the more the nearer the spot and the closer the direction held (8 keys never point
  // exactly at it); and the run eases off as it arrives, so the player settles on the spot instead
  // of running through it. Held well away from the spot it is just the direction held. Everything
  // fades in smoothly (no snap of heading or speed to give it away). (ax, ay, m): the stick; top:
  // the running speed. Returns the new stick, or null to leave it.
  const MAG = { COS0: Math.cos(78 * Math.PI / 180), COS1: Math.cos(30 * Math.PI / 180), R0: 3.5, R1: 7, A: 24 };
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  function magnetDir(s, p, ax, ay, m, top) {
    const t = meetTarget(s, p);
    if (!t || m <= 0.05 || t.t < -0.15) return null;
    const ex = t.x - p.x, ey = t.y - p.y, dist = Math.hypot(ex, ey), ux = ax / m, uy = ay / m;
    if (dist < 0.04) return t.t > -0.05 ? { x: 0, y: 0 } : null; // on it: held there for the shot
    const cos = (ux * ex + uy * ey) / dist;
    // (once it has the player, it keeps them while the same direction is held: closing in at an
    // angle the spot swings off to the side, and the run is still meant for it; a new direction,
    // or one turned away from it, lets go)
    let wc = smoothstep(MAG.COS0, MAG.COS1, cos);
    const L = p._mg, id = p._mt ? p._mt.k : 0;
    if (L && L.id === id && Math.abs(L.ax - ax) < 1e-3 && Math.abs(L.ay - ay) < 1e-3 && cos > -0.25) wc = Math.max(wc, L.w);
    p._mg = { id, ax, ay, w: wc };
    const w = wc * (1 - smoothstep(MAG.R0, MAG.R1, dist));
    if (w <= 0.001) return null;
    let hx = ux + (ex / dist - ux) * w, hy = uy + (ey / dist - uy) * w;
    const hl = Math.hypot(hx, hy) || 1; hx /= hl; hy /= hl;
    // arriving: the speed that stops on the spot (v² = 2·A·d), taken the more fully the more the
    // run is aimed at it
    const arrive = Math.min(1, Math.sqrt(2 * MAG.A * Math.max(0, dist - 0.02)) / (top || C.ARC_TOP));
    const mag = m * (1 - w * (1 - arrive));
    return { x: hx * mag, y: hy * mag };
  }

  // the dive: a launch low along (dx, dy), a unit vector
  function startDive(s, p, dx, dy) {
    p.vx = dx * C.DIVE_V; p.vy = dy * C.DIVE_V; p.fx = dx; p.fy = dy;
    p.diveT = C.DIVE_T; p.diveCd = C.DIVE_CD; p.stamina = Math.max(0, p.stamina - C.DIVE_COST); p.sprint = false;
    p.st.dives++;
    ev(s, 'dive', { p: p.i, x: r2(p.x), y: r2(p.y), dx: r2(dx), dy: r2(dy) });
  }
  // Arcade controls: a press with the shuttle out of reach, but coming down near enough soon enough,
  // is a dive at it (the dive then strikes whatever it meets, soft). Returns whether it dove.
  function arcDive(s, p) {
    const b = s.ball;
    if (airborne(p) || p.stun || p.diveT || p.floorT || p.squat || p.diveCd) return false;
    if (s.phase !== 'rally' || s.serveHold || b.last < 0 || b.last === p.i) return false;
    if (!s._pred || s._predT !== s.tick) { s._pred = predict(s); s._predT = s.tick; }
    const t = s._pred.land;
    if (!t || Math.sign(t.x || 1) !== sideOf(p) || t.t * 60 > C.ARC_DIVE_T) return false;
    const dx = t.x - p.x, dy = t.y - p.y, d = Math.hypot(dx, dy);
    if (d < C.REACH + C.ARC_STRETCH * 0.8 || d > C.ARC_DIVE_R) return false; // (nearer: a stretch does it)
    // only a dive that gets there: the slide it covers before the shuttle is down
    const n = Math.min(C.DIVE_T, Math.max(0, Math.round(t.t * 60) - 1));
    if (d > C.REACH * C.DIVE_REACH + C.DIVE_V / 60 * (1 - Math.pow(0.9, n)) / 0.1) return false;
    startDive(s, p, dx / d, dy / d);
    return true;
  }

  // ---------- player step ----------
  function stepPlayer(s, p, inp) {
    if (!p.init) { p.lastKp = inp.kp; p.lastDv = inp.dv | 0; p.lastKn = inp.kn; p.lastJp = inp.jp | 0; p.lastSw = inp.sw | 0; p.init = true; }
        if (p.diveCd > 0) p.diveCd--;
    if (p.hitCd > 0) p.hitCd--;
    if (p.anim > 0) p.anim--;
    if (p.recover > 0) p.recover--;
    const air = airborne(p);
    p.swm = !!inp.swm; // on swipe controls (see SWIPE.LAND_GRACE)
    p.arc = !!inp.arc && !p.ai; // on arcade controls (move, A, B)
    if (p.lock > 0) p.lock--;
    // sprint: held, on the ground, legs free and breath left (it runs out, and picks up again once
    // there is a little stamina back). Not on arcade controls: one running speed
    p.sprint = !!inp.sp && !p.arc && !air && p.stun === 0 && p.diveT === 0 && p.floorT === 0 && p.squat === 0
      && p.stamina > (p.sprint ? 0.5 : C.SPRINT_MIN);
    const moving = Math.hypot(p.vx, p.vy) > 3;
    if (p.sprint && moving) p.stamina = Math.max(0, p.stamina - C.SPRINT_COST);
    else p.stamina = Math.min(C.ST_MAX, p.stamina + C.ST_REGEN);

    let ax = 0, ay = 0, m = 0;
    if (inp.ax || inp.ay) { ax = inp.ax || 0; ay = inp.ay || 0; }
    else { ax = (inp.r ? 1 : 0) - (inp.l ? 1 : 0); ay = (inp.d ? 1 : 0) - (inp.u ? 1 : 0); }
    m = Math.hypot(ax, ay);
    if (m > 1) { ax /= m; ay /= m; m = 1; }
    if (m > 0.12 && p.stun <= 0 && p.diveT <= 0 && p.floorT <= 0) { p.fx = ax / m; p.fy = ay / m; }

    // jump: a short crouch, then takeoff (see below). Not from a dive, a stun or mid-air.
    const jp = inp.jp | 0;
    if (jp !== p.lastJp) {
      p.lastJp = jp;
      if (!air && p.squat === 0 && p.stun === 0 && p.diveT === 0 && p.floorT === 0 && p.landT <= 2 && p.stamina >= C.JUMP_COST) {
        p.squat = C.JUMP_SQUAT; p.stamina -= C.JUMP_COST; p.st.jumps++;
        ev(s, 'jump', { p: p.i, x: r2(p.x), y: r2(p.y), leap: p.sprint ? 1 : 0 });
      }
    }

    // dive: a double tap of the sprint button. Along the direction held (or toward the shuttle when
    // nothing is), bent part of the way toward where the shuttle is coming down if that is close to
    // the line: a real player dives at the shuttle, not past it. Needs legs under you and the breath.
    const dv = inp.dv | 0;
    if (dv !== p.lastDv) {
      p.lastDv = dv;
      if (p.stun === 0 && p.diveT === 0 && p.floorT === 0 && !air && p.squat === 0 && p.diveCd === 0 && p.stamina >= C.DIVE_COST) {
        const b = s.ball;
        let dx = m > 0.12 ? ax / m : b.x - p.x, dy = m > 0.12 ? ay / m : b.y - p.y;
        let dl = Math.hypot(dx, dy); if (dl < 1e-6) { dx = p.fx; dy = p.fy; dl = Math.hypot(dx, dy) || 1; }
        dx /= dl; dy /= dl;
        const live = (s.phase === 'rally' || s.phase === 'serve') && !s.serveHold && b.last >= 0 && b.last !== p.i;
        if (live) {
          if (!s._pred || s._predT !== s.tick) { s._pred = predict(s); s._predT = s.tick; }
          const t = s._pred.land;
          if (t && Math.sign(t.x || 1) === sideOf(p)) {
            const tx = t.x - p.x, ty = t.y - p.y, td = Math.hypot(tx, ty);
            if (td > 0.3 && td < 4.5 && (tx * dx + ty * dy) / td > Math.cos(0.6)) {
              dx += (tx / td - dx) * C.DIVE_AIM; dy += (ty / td - dy) * C.DIVE_AIM;
              const l = Math.hypot(dx, dy); dx /= l; dy /= l;
            }
          }
        }
        startDive(s, p, dx, dy);
      }
    }

    // swing: the release fires on the spot when the shuttle is in reach. Otherwise it is a buffered
    // miss for a few ticks — and an early release, a read the opponent's animation shows.
    const pressedNew = inp.kp !== p.lastKp;
    const tapped = pressedNew && !inp.k && !p.ch;
    p.lastKp = inp.kp;
    if (p.stun > 0 || p.floorT > 0) { p.ch = false; p.ct = 0; p.pk = null; }
    else if (p.diveT > 0 && !p.pk) {
      // in the dive the racket is stretched out at the shuttle: whatever it meets is struck (a held
      // charge and Lift still shape it), a desperate soft retrieve
      if (tryHit(s, p, p.ch ? p.ct : 10, !!inp.lob, 1)) { p.ch = false; p.ct = 0; }
    } else if (p.pk) {
      if (pressedNew) p.pk = null;
      else if (tryHit(s, p, p.pk.ct, p.pk.lob, p.pk.late)) p.pk = null;
      else if (--p.pk.t <= 0) { if (p.pk.ct > 12) ev(s, 'whiff', { p: p.i, x: r2(p.x), y: r2(p.y) }); p.pk = null; }
    }
    if (p.stun === 0 && p.floorT === 0 && !p.pk && p.diveT === 0) {
      if (inp.k) { if (!p.ch) { p.ch = true; p.ct = 0; } p.ct++; }
      else if (p.ch || tapped) {
        // the client reports how long the button was actually held; trust it within a tolerance
        // (a trackpad player's swing is the sim's own: its planned charge stands)
        const ct = typeof inp.kc === 'number' ? (p.ez ? clamp(inp.kc, 0, p.ct) : clamp(inp.kc, p.ct - 10, p.ct + 12)) : p.ct;
        p.ch = false; p.ct = 0; p.anim = 8;
        if (!tryHit(s, p, ct, !!inp.lob, 1)) {
          p.pk = { ct, lob: !!inp.lob, t: 9, late: 0.72 };
          ev(s, 'swing', { p: p.i });
        }
      }
    }

    // a two-finger swipe (swipe controls): one per change of the counter
    const sw = inp.sw | 0;
    if (sw !== p.lastSw) { p.lastSw = sw; p.armed = null; swipeShot(s, p, inp); }
    else if (p.armed) armedShot(s, p);

    if (p.stun > 0) { p.stun--; ax = ay = 0; m = 0; }
    const tired = (p.stamina < C.TIRED ? 0.86 : 1) * (p.ai ? 0.78 + 0.2 * s.skill : p.ez ? EZ.LEGS : 1);
    if (p.diveT > 0) {
      p.diveT--; p.vx *= 0.9; p.vy *= 0.9;
      if (p.diveT === 0) { p.floorT = p.arc ? C.ARC_DIVE_REC : C.DIVE_REC; p.vx *= 0.3; p.vy *= 0.3; }
    } else if (p.floorT > 0) {
      // on the floor after a dive: a short slide out, then back up onto the feet
      p.floorT--; p.vx *= 0.8; p.vy *= 0.8;
      if (p.floorT === 0) p.recover = Math.max(p.recover, 8);
    } else if (p.squat > 0) {
      p.vx *= 0.86; p.vy *= 0.86; // loading the legs: the feet plant
    } else if (air) {
      // in the air the body carries its takeoff momentum; a little steering is all the legs give
      const top = C.TOP * tired;
      if (m > 0.05) { p.vx += (ax * top - p.vx) * C.AIR_ACCEL; p.vy += (ay * top - p.vy) * C.AIR_ACCEL; }
    } else {
      const top = (p.sprint ? C.SPRINT_V : p.arc ? C.ARC_TOP : C.TOP) * tired * (p.ch ? 0.6 : 1) * (p.recover > 0 ? 0.5 : 1) * (p.landT > 0 ? 0.35 : 1);
      // nothing held: the placement assist may steer the last metre or two (see assistDir)
      if (m <= 0.05 && inp.as && !p.ai) { const a = assistDir(s, p); if (a) { ax = a.x; ay = a.y; m = Math.hypot(ax, ay); if (m > 0.12) { p.fx = ax / m; p.fy = ay / m; } } }
      else if (m > 0.05 && inp.mg && !p.ai) { const g = magnetDir(s, p, ax, ay, m, top); if (g) { ax = g.x; ay = g.y; m = Math.hypot(ax, ay); if (m > 0.12) { p.fx = ax / m; p.fy = ay / m; } } }
      run(p, ax, ay, m, top);
    }
    if (p.landT > 0) p.landT--;
    // vertical: the crouch ends in takeoff (out of a sprint it is a long leap: the run carries on)
    if (p.squat > 0 && --p.squat === 0) {
      p.vz = C.JUMP_V; p.z = 0.001;
      const h = Math.hypot(p.vx, p.vy), cap = p.sprint ? C.LEAP_V : C.TOP;
      if (h > cap) { p.vx *= cap / h; p.vy *= cap / h; }
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
    // a stretched contact: the body carries the rest of the way to the shuttle
    if (p.nudge) { p.x += p.nudge.x; p.y += p.nudge.y; if (--p.nudge.t <= 0) p.nudge = null; }
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
    const dt = (b.w || 1) / 60; // the shuttle's own clock (the hype tempo)
    const sp = Math.hypot(b.vx, b.vy, b.vz), dec = 1 / (1 + C.DRAG * sp * dt);
    b.vx *= dec; b.vy *= dec; b.vz = b.vz * dec - C.G * dt;
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    // the net plane: below the tape the shuttle stops dead and drops where it hit
    if ((px < 0) !== (b.x < 0)) {
      const u = (0 - px) / (b.x - px), yc = py + (b.y - py) * u, zc = pz + (b.z - pz) * u;
      const nh = netAt(yc);
      if (zc < nh) {
        const incoming = { vx: r2(b.vx), vy: r2(b.vy), vz: r2(b.vz), kmh: kmhOf(ballSpeed(b)) };
        b.x = -0.01 * Math.sign(b.vx || 1); b.y = yc; b.z = Math.max(0.02, zc); // dropped on the striker's side of the tape
        b.vx *= -0.06; b.vy *= 0.25; b.vz = Math.min(b.vz, -0.4);
        b.over = 0;
        ev(s, 'net', Object.assign({ x: 0, y: r2(yc), z: r2(zc) }, incoming));
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
    // hype: winning off a hot player cools them (their heat comes over), and the rally's pot is won
    const o = opp(p);
    let steal = 0;
    if (C.HYPE && s.heat[o] >= C.STEAL_AT) { steal = Math.min(C.STEAL, s.heat[o]); s.heat[o] -= steal; }
    const pot = potOf(rally);
    addHeat(s, p, 12 + pot + steal);
    if (reason === 'out' || reason === 'own side' || reason === 'fault') s.heat[o] = clamp(s.heat[o] - 20, 0, 100);
    s.fire = null;
    if (reason === 'out' || reason === 'own side') s.players[opp(p)].st.errors++;
    // a winner that came down hard: the floor takes the hit (the client shakes and dusts it)
    const slam = reason === 'winner' && FAST[s.lastKind] ? 1 : 0;
    ev(s, 'point', { p, reason, rally, score: s.score.slice(), x: r2(b.x), y: r2(b.y), kind: s.lastKind, slam, kmh: kmhOf(ballSpeed(b)), pot, steal });
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
      Object.assign(s.ball, { x: sv.x - d * 0.5, y: sv.y, z: C.HOLD_Z, vx: 0, vy: 0, vz: 0, w: 1 });
      return;
    }
    if (s.landAt != null) { // down by a swipe player: ruled on once their swipe has had time to arrive
      const rc = s.lastHitter >= 0 ? s.players[opp(s.lastHitter)] : null;
      if (s.tick - s.landAt >= (rc && rc.arc ? C.ARC_GRACE : SWIPE.LAND_GRACE)) { s.landAt = null; resolveLanding(s); }
      return;
    }
    if (stepBall(s)) {
      const rc = s.lastHitter >= 0 ? s.players[opp(s.lastHitter)] : null;
      if (rc && rc.swm && Math.sign(s.ball.x || 1) === sideOf(rc) && s.phase === 'rally') { s.landAt = s.tick; return; }
      resolveLanding(s); return;
    }
    // a shuttle balanced on the tape is resolved after half a second
    const b = s.ball;
    if (Math.abs(b.x) < 0.06 && b.z > 0 && b.z < netAt(b.y)) {
      if (++b.over > 30) resolveLanding(s);
    } else b.over = 0;
  }

  function stepSim(s, inputs) {
    s.tick++;
    // The room freezes a pause by not stepping. Cool at the starting phase's rate so an
    // impact or point reward in this tick is not immediately reduced by the next phase.
    if (s.phase === 'prematch') s.heat[0] = s.heat[1] = 0;
    else {
      const cooling = (s.phase === 'rally' ? 2 : 8) / 60;
      // (hype: a Fire Shot in hand does not cool away; it is spent, stolen or lost to a fault)
      const hold = h => C.HYPE && h >= C.FIRE_AT;
      if (!hold(s.heat[0])) s.heat[0] = Math.max(0, s.heat[0] - cooling);
      if (!hold(s.heat[1])) s.heat[1] = Math.max(0, s.heat[1] - cooling);
    }
    inputs = easyInputs(s, inputs);
    const kickPressed = s.players.map((p, i) => p.init && (inputs[i].kp !== p.lastKp || (inputs[i].sw | 0) !== (p.lastSw | 0)));
    switch (s.phase) {
      case 'prematch':
        syncInputs(s, inputs);
        s.players.forEach((p, i) => stepPlayer(s, p, inputs[i]));
        if (++s.pt >= C.PRE_T) { ev(s, 'whistle'); setupServe(s); }
        break;
      case 'serve':
      case 'rally':
        if (s.hitstop > 0) { s.hitstop--; syncInputs(s, inputs); recordHistory(s); break; }
        physics(s, inputs);
        recordHistory(s);
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
    const step = 1 / 30, dt = step * (b.w || 1); // t counts real seconds; dt is the shuttle's clock
    let high = null, land = null, air = null;
    for (let t = 0; t < 5; t += step) {
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
    const inp = { u: 0, d: 0, l: 0, r: 0, k: false, kp: B.kp, kc: null, dc: 0, dv: B.dv, sp: false, jp: B.jp, ax: 0, ay: 0, lob: false, sh: false, kn: B.kn, rb: 0 };
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
    const blind = s.tick - B.seeAt < Math.max(fast ? 6 : 9, (1 - s.skill) * (fast ? 30 : 55));
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
    // late to it: sprint, and when even that will not get there, a better player dives for it
    if (urgent > 18 && md > 1.0 && p.stamina > 20 + 20 * (1 - s.skill)) inp.sp = true;
    // (a dive is the last resort: only when the shuttle is coming down where running will not get
    // the racket to it in time, but a launch will)
    const runReach = C.REACH + (Math.hypot(p.vx, p.vy) * 0.7 + C.TOP * 0.3) * eta / 60;
    if (!blind && eta < 14 && eta > 3 && md > runReach && md < runReach + 1.9 && !airborne(p) && p.diveCd === 0
      && p.stamina >= C.DIVE_COST && pred && pred.land && !overhead && !inAir && B.diveFor !== B.seeAt) {
      B.diveFor = B.seeAt;
      if (Math.random() < 0.08 + 0.3 * s.skill) { inp.dv = ++B.dv; inp.ax = clamp(mx / md, -1, 1); inp.ay = clamp(my / md, -1, 1); }
    }

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

  // ---------- swipe controls ----------
  // The shot is a two-finger swipe on the trackpad. The browser judges its timing against the moment
  // the shuttle was best met as the player saw it (contactPlan, run on what was on their screen), so
  // the grade is the player's own; the input carries it: sw (a counter: one swipe per change), sg the
  // grade (0 perfect, 1 great, 2 good, 3 early or late, 4 a miss), si intensity 0..1 (a gentle
  // swipe to a fierce one), sd a downward swipe (a lift), sl the line (-1..1 across the court,
  // in court y), svt the tick the player was looking at when they swiped.
  // By the time a swipe reaches the sim, the shuttle has moved on (the screen plays a few ticks
  // behind, and a swipe is only recognised once it is under way), so the shot is played where the
  // shuttle was at svt: the sim rewinds it (and the striker) that far, strikes it, and flies the
  // new shot forward to now.
  const SWIPE = {
    REWIND: 24,                       // the furthest back a swipe may be played (ticks; ~0.4 s)
    // a shuttle that comes down by a swipe player is ruled on this many ticks later, so a swipe that
    // met it on their screen before it landed is still on its way here when the floor is reached
    LAND_GRACE: 8,
    Q: [1, 0.92, 0.76, 0.45],         // contact quality by grade
    SOFT: 0.35, HARD: 0.75,           // intensity: below SOFT a touch shot, above HARD a power shot
  };
  // the charge a swipe's intensity stands for: it picks the shot as a held charge does
  // (soft: drop / net / block; medium: drive / clear; hard: smash / kill / counter)
  function swipeCt(si) {
    if (si < SWIPE.SOFT) return Math.round(4 + si / SWIPE.SOFT * 8);                                    // 4..12
    if (si < SWIPE.HARD) return Math.round(20 + (si - SWIPE.SOFT) / (SWIPE.HARD - SWIPE.SOFT) * 12);    // 20..32
    return Math.round(36 + (si - SWIPE.HARD) / (1 - SWIPE.HARD) * 5);                                   // 36..41
  }
  // the shuttle (b, as it was) is coming in to the player at (q[0], q[1]): on its way to them and not
  // yet as close as a comfortable contact
  function coming(p, b, q) {
    if (b.last < 0 || b.last === p.i) return false;
    const dx = q[0] - b.x, dy = q[1] - b.y, d = Math.hypot(dx, dy);
    if (b.z > (q[2] || 0) + C.MAX_Z - 0.1 && b.vz < 0 && d < C.REACH + C.ARC_STRETCH) return true; // (still above the racket)
    return d > C.REACH * 0.75 && dx * b.vx + dy * b.vy > 0 && b.z > 0.3;
  }
  // an armed (early) arcade press, tried once a tick: struck when the shuttle is in reach and as
  // good as it will get (close, or no longer closing, or about to drop out); a whiff when it never is
  function armedShot(s, p) {
    const a = p.armed, b = s.ball;
    if (s.phase !== 'rally' || b.last === p.i || p.stun > 0 || p.floorT > 0 || p.diveT > 0) { p.armed = null; return true; }
    const d = Math.hypot(b.x - p.x, b.y - p.y), nz = b.z + b.vz / 60;
    const high = b.z > p.z + C.MAX_Z - 0.1 && b.vz < 0; // (dropping in from above: wait for it)
    const best = !high && (d <= C.REACH * 0.75 || d >= a.pd || nz < 0.35 || a.t <= 1 || nz < p.z + C.SWEET_Z - 0.2);
    a.pd = d;
    if (best && swipeShot(s, p, Object.assign({}, a.inp, { svt: s.tick }), true)) { p.armed = null; return true; }
    if (--a.t <= 0) {
      p.armed = null;
      if (arcDive(s, p)) return true;
      ev(s, 'swing', { p: p.i, whiff: 1 });
      p.lock = C.ARC_LOCK;
      return true;
    }
    return false;
  }
  function swipeShot(s, p, inp, retry) {
    if (p.stun > 0 || p.floorT > 0 || p.diveT > 0 || p.ai) return false;
    if (p.arc && p.lock > 0) return false; // arcade controls: the racket is still coming back from a whiff
    const g = clamp(inp.sg | 0, 0, 4), si = clamp(+inp.si || 0, 0, 1), lob = !!inp.sd, sl = clamp(+inp.sl || 0, -1, 1);
    const d = sideOf(p);
    // arcade controls: a press that meets nothing dives for it if it can, else whiffs and locks
    const miss = () => {
      if (p.arc && arcDive(s, p)) return;
      ev(s, 'swing', { p: p.i, whiff: p.arc ? 1 : 0 });
      if (p.arc && s.phase === 'rally') p.lock = C.ARC_LOCK;
    };
    if (!retry) p.anim = 8;
    // the serve: no timing (the shuttle is in hand); gentle is low, fierce is high
    if (s.phase === 'serve' && s.server === p.i && s.lastHitter === -1) {
      p.swGrade = 1; p.swPerfect = false;
      if (!tryHit(s, p, si < 0.5 ? 8 : 34, false, 1)) ev(s, 'swing', { p: p.i });
      p.swGrade = null; p.swPerfect = null;
      return;
    }
    if (s.phase !== 'rally' && s.phase !== 'serve') { ev(s, 'swing', { p: p.i }); return; }
    if (g === 4) { miss(); return; }
    // the line: straight on from where the player stands, angled across the court by sl
    const aim = { x: -d * C.L * 0.75, y: clamp(p.y + sl * 2.6 * S, -(C.W - 0.25), C.W - 0.25) };
    const ct = swipeCt(si);
    const strike = () => {
      // facing the shot's line (a swipe is a turn of the shoulders too)
      const fx = aim.x - p.x, fy = aim.y - p.y, fl = Math.hypot(fx, fy) || 1;
      const ofx = p.fx, ofy = p.fy;
      p.fx = fx / fl; p.fy = fy / fl; p.aim = aim; p.swGrade = g; p.swPerfect = g === 0; p.swQ = SWIPE.Q[g];
      p.dep = p.arc ? clamp(+inp.sz || 0, -1, 1) : null;
      const ok = tryHit(s, p, ct, lob, 1);
      p.swGrade = null; p.swPerfect = null; p.swQ = null; p.aim = null; p.dep = null;
      if (!ok) { p.fx = ofx; p.fy = ofy; }
      return ok;
    };
    // played where the shuttle (and the striker) were at the tick the player saw
    const k = clamp(Number.isFinite(inp.svt) ? Math.round(inp.svt) : s.tick, s.tick - SWIPE.REWIND, s.tick);
    const h = k < s.tick ? s.bh.find(e => e.k === k) : null;
    // arcade: a press with the shuttle still on its way in (out of reach, or only just in it) waits
    // for it, up to ARC_BUF ticks, and strikes when it is best in reach (armedShot)
    if (retry) return strike();
    if (p.arc && s.phase === 'rally' && coming(p, h ? h.b : s.ball, h ? h.p[p.i] : [p.x, p.y, p.z])) {
      p.armed = { inp: { sg: g, si, sd: lob ? 1 : 0, sl, sz: inp.sz }, t: C.ARC_BUF, pd: Infinity };
      if (!armedShot(s, p)) ev(s, 'swing', { p: p.i, early: 1 });
      return true;
    }
    if ((h || p.arc) && s.phase === 'rally') {
      const now = Object.assign({}, s.ball), at = { x: p.x, y: p.y, z: p.z };
      if (!h && strike()) return; // (judged on now first, when now is the tick it was seen)
      // played at tick k; an arcade press that meets nothing there is tried a little earlier too
      for (let j = 0; j <= (p.arc ? C.ARC_LATE : 0); j++) {
        const hk = k - j, hh = hk < s.tick ? s.bh.find(e => e.k === hk) : null;
        if (!hh) { if (j === 0 && !h) continue; break; }
        Object.assign(s.ball, hh.b); p.x = hh.p[p.i][0]; p.y = hh.p[p.i][1]; p.z = hh.p[p.i][2];
        const ok = strike();
        p.x = at.x; p.y = at.y; p.z = at.z;
        if (ok) { // the new shot flies on from then to now
          s.landAt = null;
          for (let i = hk; i < s.tick; i++) if (stepBall(s)) { resolveLanding(s); break; }
          return;
        }
        Object.assign(s.ball, now);
      }
      miss(); // (nothing in reach when the player swiped: a swing at air)
      return;
    }
    if (!strike()) miss(); // (no history yet, as at a serve: judged on now)
  }
  // When the incoming shuttle is best met from where p stands: flies it forward tick by tick (the
  // sim's own flight) and scores each tick it is in reach as quality() would. Returns { k: ticks
  // from now, q, x, y, z } or null. The browser runs this on what is on screen to time a swipe.
  function contactPlan(b0, p, maxK = 240) {
    let x = b0.x, y = b0.y, z = b0.z, vx = b0.vx, vy = b0.vy, vz = b0.vz, best = null;
    const dt = (b0.w || 1) / 60, pz = p.z || 0; // (k counts sim ticks; dt is the shuttle's clock)
    for (let k = 1; k <= maxK; k++) {
      const sp = Math.hypot(vx, vy, vz), dec = 1 / (1 + C.DRAG * sp * dt);
      vx *= dec; vy *= dec; vz = vz * dec - C.G * dt;
      const nx = x + vx * dt, ny = y + vy * dt, nz = z + vz * dt;
      if ((x < 0) !== (nx < 0)) { const u = (0 - x) / (nx - x), yc = y + (ny - y) * u, zc = z + (nz - z) * u; if (zc < netAt(yc)) return best; }
      x = nx; y = ny; z = nz;
      if (z <= 0) break;
      if (p.i === 0 ? x > 0.18 : x < -0.18) continue;
      const dd = Math.hypot(x - p.x, y - p.y);
      if (dd > C.REACH || z > pz + C.MAX_Z || z < Math.max(0.02, pz - 0.15)) { if (best) break; continue; }
      const qr = clamp(1 - (dd - C.SWEET) / (C.REACH - C.SWEET), 0, 1), rz = z - pz;
      const qh = rz >= C.MID_Z ? 1 - clamp(Math.abs(rz - C.SWEET_Z) / 1.6, 0, 1) * 0.4 : 0.8;
      const q = (0.16 + 0.84 * qr) * (0.66 + 0.34 * qh) * (0.5 + 0.5 * clamp(rz / 0.5, 0, 1));
      if (!best || q > best.q + 1e-3) best = { k, q, x, y, z };
    }
    return best;
  }
  // The timing ring (keyboard and swipe controls): where, and on which sim tick, the incoming
  // shuttle is met. It is fixed once per shot (key: one per shot, e.g. last hitter + rally count)
  // from the spot the player is steered to (meetTarget), not from where they stand, so it shows
  // the moment the shot is struck, does not wait for the player to arrive, and does not move as
  // they run. It is fixed again only if the flight itself changes (off the net cord).
  // s: { tick, phase, serveHold, hitstop, ball: { x, y, z, vx, vy, vz, last } }; p: { i, x, y, z }.
  // Returns { key, tick, x, y, z, sx, sy } (sx, sy: the standing spot) or null.
  function ringPlan(s, p, key, prev) {
    const same = prev && prev.key === key;
    if (same) {
      if (s.tick >= prev.tick - 3) return prev; // (at or past the contact: nothing left to check)
      const q = contactPlan(s.ball, { i: p.i, x: prev.sx, y: prev.sy, z: 0 });
      if (!q || Math.hypot(q.x - prev.x, q.y - prev.y, q.z - prev.z) < 0.3) return prev;
    }
    const t = meetTarget(s, p);
    let spot = t ? { x: t.x, y: t.y } : null;
    let c = spot ? contactPlan(s.ball, { i: p.i, x: spot.x, y: spot.y, z: 0 }) : null;
    if (!c) { spot = { x: p.x, y: p.y }; c = contactPlan(s.ball, { i: p.i, x: p.x, y: p.y, z: p.z || 0 }); }
    if (!c) return same ? prev : null;
    return { key, tick: s.tick + (s.hitstop || 0) + c.k, x: c.x, y: c.y, z: c.z, sx: spot.x, sy: spot.y };
  }

  // the shuttle and the players as they were this tick, for swipes played a moment in the past
  function recordHistory(s) {
    const b = s.ball;
    s.bh.push({ k: s.tick, b: { x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, last: b.last, stuck: b.stuck, over: b.over, w: b.w || 1 }, p: s.players.map(q => [q.x, q.y, q.z]) });
    if (s.bh.length > SWIPE.REWIND + 2) s.bh.shift();
  }

  // ---------- trackpad controls ----------
  // For a player on a trackpad (or anyone who wants the legs and the timing done for them): the sim
  // runs their footwork and winds up their swing; the player decides the shot. A tap queues a shot
  // for the next shuttle coming their way. It goes where they point on the far court: soft (drop,
  // net shot, block) when that spot is short, power (smash, clear, counter, kill) when it is deep;
  // a lift with the second button. The swing is released with a good charge, never inside the
  // perfect window: that stays the reward for timing it yourself. A tap with nothing coming yet
  // (the shuttle still on its way out) waits for the next one, for up to EZ.HOLD ticks.
  // The client says it plays this way with inp.ez, and sends its aim as inp.tx / inp.ty (metres).
  const EZ = {
    REACT: 18,         // ticks to read a new shot before the legs commit (a quick human's read)
    LEGS: 0.86,        // the auto legs run a touch slower than a player's own can
    MISREAD: 0.5,      // and misjudge where to stand by up to this much (metres), afresh each shot
    HOLD: 150,         // how long a tap made early waits for the shuttle to come back
    POWER: 38, SOFT: 9, LIFT: 30, SERVE_HIGH: 34, SERVE_LOW: 8, // charges (all short of perfect)
    SOFT_X: 2.4 * S,   // aimed closer to the net than this is a soft shot
  };
  // (by distance from the net only: the client's aim may still be on the old end after a change of ends)
  const ezSoft = raw => !!raw.am && Number.isFinite(raw.tx) && Math.abs(raw.tx) < EZ.SOFT_X;
  // where the shot is aimed: the pointed spot on the far court (kept inside the lines), else deep middle
  function ezAim(raw, d) {
    if (!raw.am || !Number.isFinite(raw.tx) || !Number.isFinite(raw.ty)) return { x: -d * C.L * 0.75, y: 0 };
    return { x: -d * clamp(Math.abs(raw.tx), 0.6, C.L - 0.3), y: clamp(raw.ty, -(C.W - 0.25), C.W - 0.25) };
  }
  function ezInput(s, i, raw) {
    const p = s.players[i], o = s.players[opp(i)], b = s.ball, d = sideOf(p);
    let E = s.ez[i];
    if (!E) E = s.ez[i] = { on: false, rawKp: 0, q: null, ch: false, ct: 0, want: 0, lob: false, seen: -2, seeAt: -99, tx: 0, ty: 0, diveFor: -1 };
    const play = s.phase === 'serve' || s.phase === 'rally';
    if (!play) { // between points the input is the player's own (a tap still readies up after a match)
      E.on = false; E.q = null; E.ch = false; p.aim = null;
      return raw;
    }
    if (!E.on) { E.on = true; E.rawKp = raw.kp; E.q = null; E.ch = false; E.tx = p.x; E.ty = p.y; }
    const out = { u: 0, d: 0, l: 0, r: 0, k: false, kp: p.lastKp, kc: null, dv: p.lastDv, sp: false, jp: raw.jp | 0, ax: 0, ay: 0, lob: false, as: 0, kn: raw.kn };
    // a tap (or the shot key): queue a shot, or replace the one queued
    if (raw.kp !== E.rawKp) {
      E.rawKp = raw.kp;
      E.q = { lob: !!raw.lob, t: EZ.HOLD, hits: p.st.hits };
    }
    if (E.q && p.st.hits > E.q.hits) E.q = null; // played
    if (s.hitstop > 0) { out.k = E.ch; return out; }

    const serving = s.phase === 'serve' && s.server === i && s.lastHitter === -1;
    if (!s._pred || s._predT !== s.tick) { s._pred = predict(s); s._predT = s.tick; }
    const pr = s._pred;
    const toMe = !s.serveHold && b.last >= 0 && b.last !== i;
    const coming = toMe && !!pr.land && Math.sign(pr.land.x || 1) === d;
    if (b.last !== E.seen) {
      E.seen = b.last; E.seeAt = s.tick;
      E.errX = (Math.random() * 2 - 1) * EZ.MISREAD; E.errY = (Math.random() * 2 - 1) * EZ.MISREAD;
    }
    if (E.q && !coming && !serving && --E.q.t <= 0) E.q = null;

    // legs: to where the shuttle is best met (beside and a little behind it, overhead while it is
    // high, else where it comes down), or back to base once it is on its way out
    // (the swing may be wound up from the moment it is struck: a tap made early is anticipation,
    // which is how a smash is countered; only the legs wait to read it)
    let eta = 999, overhead = false;
    if (s.serveHold) { E.tx = p.x; E.ty = p.y; }
    else if (coming) {
      overhead = !!(pr.high && Math.sign(pr.high.x || 1) === d && pr.high.t < pr.land.t - 0.02 && pr.high.z > 1.5);
      const meet = overhead ? pr.high : pr.land;
      eta = Math.max(0, meet.t * 60);
      if (s.tick - E.seeAt >= EZ.REACT || E.ch) {
        const fx = -d, ry = fx; // facing the net, the racket side is (0, fx)
        E.tx = meet.x - fx * 0.35 + (E.errX || 0); E.ty = meet.y - ry * 0.4 + (E.errY || 0);
      }
    } else if (b.last === i || s.phase === 'rally') {
      E.tx = d * 3.1 * S; E.ty = clamp(-o.y * 0.35, -1.4 * S, 1.4 * S);
    }
    const mx = E.tx - p.x, my = E.ty - p.y, md = Math.hypot(mx, my);
    if (md > 0.08) { const m = clamp(md / 0.9, 0.2, 1); out.ax = mx / md * m; out.ay = my / md * m; }
    // late to it: sprint while the breath lasts
    if (coming && eta < 999 && md > 1 && p.stamina > 20 && md - C.REACH * 0.5 > C.TOP * 0.8 * eta / 60) out.sp = true;
    // a shot asked for that running will not reach in time: dive for it (once per shot)
    const runReach = C.REACH + (Math.hypot(p.vx, p.vy) * 0.7 + C.TOP * 0.3) * eta / 60;
    if (E.q && coming && !overhead && eta < 14 && eta > 3 && md > runReach && md < runReach + 1.9 && !airborne(p)
      && p.diveCd === 0 && p.stamina >= C.DIVE_COST && E.diveFor !== E.seeAt) {
      E.diveFor = E.seeAt; out.dv = p.lastDv + 1;
    }

    // the swing: wound up on the prediction's clock so it is ready when the shuttle arrives
    const soft = ezSoft(raw);
    if (!E.ch && E.q && !p.pk && p.hitCd === 0 && p.diveT === 0 && (serving || (coming && b.z > 0.05))) {
      const want = serving ? (soft ? EZ.SERVE_LOW : EZ.SERVE_HIGH) : E.q.lob ? EZ.LIFT : soft ? EZ.SOFT : EZ.POWER;
      if (serving || eta <= want + 2) { E.ch = true; E.ct = 0; E.want = want; E.lob = E.q.lob; }
    }
    if (E.ch && (!E.q || p.stun > 0 || p.floorT > 0 || p.diveT > 0 || (!serving && !coming))) E.ch = false; // nothing to swing at
    if (E.ch) {
      E.ct++; out.k = true; out.lob = E.lob;
      const bd = Math.hypot(b.x - p.x, b.y - p.y);
      const inReach = bd < C.REACH * 0.95 && b.z <= p.z + C.MAX_Z - 0.05 && b.z >= p.z + 0.08;
      // let it go before the shuttle drops out of the height the shot wants, or out of reach
      const lowest = E.want >= EZ.POWER && !E.lob && b.z > C.HIGH_Z ? p.z + C.HIGH_Z + 0.05 : p.z + 0.25;
      const nb = { x: b.x + b.vx * 3 / 60, y: b.y + b.vy * 3 / 60, z: b.z + b.vz * 3 / 60 };
      const leaving = nb.z < lowest || Math.hypot(nb.x - p.x, nb.y - p.y) > C.REACH * 0.95;
      // a soft shot asked for at waist height would be a drive: let it drop to a net shot's height
      // first, if it stays in reach that long
      const rz = b.z - p.z;
      const waitLow = !serving && !E.lob && E.want === EZ.SOFT && b.vz < 0 && rz >= C.MID_Z && rz < C.HIGH_Z && !FAST[s.lastKind];
      if (inReach && (E.ct >= E.want || leaving) && (!waitLow || leaving)) {
        out.k = false; out.kp = p.lastKp + 1; out.kc = Math.min(E.ct, E.want + 3); E.ch = false; // (the shot planned, however long it waited)
        out.ax = 0; out.ay = 0;
        // turn to the target: the aim decides the line
        const aim = ezAim(raw, d), fx = aim.x - p.x, fy = aim.y - p.y, fl = Math.hypot(fx, fy) || 1;
        p.fx = fx / fl; p.fy = fy / fl; p.aim = aim;
        // power asked for overhead where no smash gets down over the net (too deep): a clear, not
        // the soft drop the sim would turn it into
        if (!serving && !E.lob && !FAST[s.lastKind] && shotKind(s, p, E.ct, false) === 'smash') {
          const dep = SHOTS.smash.min + (SHOTS.smash.max - SHOTS.smash.min) * clamp(pctOf(E.ct), 0, 1);
          if (!launchAngle({ x: b.x, y: b.y, z: b.z }, -d * dep, aim.y, SHOTS.smash.cap * 0.95, -42, -10)) out.lob = true;
        }
      }
    }
    if (!E.ch && !p.pk && !p.ch) p.aim = null;
    return out;
  }
  // the inputs as the sim plays them: a trackpad player's taps and aim become legs and a swing
  function easyInputs(s, inputs) {
    if (!s.ez) s.ez = [null, null];
    return inputs.map((raw, i) => {
      const p = s.players[i];
      if (!raw || p.ai || !raw.ez) {
        // leaving trackpad controls: take the player's own counters from here, so the switch is
        // not read as a press or a dive
        if (raw && s.ez[i] && s.ez[i].on) { p.lastKp = raw.kp; p.lastDv = raw.dv | 0; p.lastJp = raw.jp | 0; s.ez[i].on = false; }
        if (raw && !p.ai) p.ez = false;
        p.aim = null;
        return raw;
      }
      p.ez = true;
      return ezInput(s, i, raw);
    });
  }

  function ezQueued(s, i) { const E = s.ez && s.ez[i]; return E && E.on && E.q ? (E.q.lob ? 2 : 1) : 0; }

  // ---------- network snapshot ----------
  const KIND_CODE = ['', 'smash', 'jsmash', 'kill', 'drive', 'clear', 'lift', 'drop', 'net', 'block', 'counter', 'servel', 'serveh'];
  function netState(s) {
    const b = s.ball;
    return {
      ph: s.phase, pt: s.pt, ps: s.ps, rc: s.rally, lh: s.lastHitter, lk: s.lastKind,
      sc: s.score, sv: s.server, sy: s.serveY, sl: s.serveLive, hold: s.serveHold ? 1 : 0,
      rd: s.ready.map(Number), hs: s.hitstop, w: s.winner,
      ht: s.heat.map(Math.round), fi: s.fire ? s.fire.by : -1,
      b: [r2(b.x), r2(b.y), r2(b.z), r2(b.vx), r2(b.vy), r2(b.vz), r2(b.w || 1)], // (6: the shuttle's clock, the hype tempo)
      // 0 x, 1 y, 2 vx, 3 vy, 4 fx, 5 fy (aim / intent: not the body's facing), 6 charge (-1 idle),
      // 7 (unused, was the dash), 8 diving, 9 stamina, 10 stunned, 11 recovering, 12 swing timer,
      // 13 hit cooldown, 14 z, 15 vz, 16 crouching to jump (ticks left), 17 landing (ticks left),
      // 18 last shot kind (KIND_CODE index), 19 sprinting, 20 on the floor after a dive (ticks left),
      // 21 on trackpad controls, 22 trackpad shot queued (0 none, 1 shot, 2 lift)
      p: s.players.map(p => [r2(p.x), r2(p.y), r2(p.vx), r2(p.vy), r2(p.fx), r2(p.fy),
        p.ch ? Math.min(p.ct, 90) : -1, 0, p.diveT > 0 ? 1 : 0, Math.round(p.stamina),
        p.stun > 0 ? 1 : 0, p.recover > 0 ? 1 : 0, p.anim, p.hitCd > 0 ? 1 : 0,
        r2(p.z), r2(p.vz), p.squat, p.landT, Math.max(0, KIND_CODE.indexOf(p.swing)), p.sprint ? 1 : 0, p.floorT,
        p.ez ? 1 : 0, ezQueued(s, p.i)]),
      st: s.players.map(p => [p.st.hits, p.st.smashes, p.st.perfects, p.st.winners, p.st.aces, p.st.dives, p.st.maxRally]),
    };
  }

  return { C, SHOTS, KIND_CODE, BOT_LEVELS, tempoOf, potOf, EZ, SWIPE, MAG, swipeCt, contactPlan, ringPlan, meetTarget, magnetDir, arcDive, run, bound, assistDir, createSim, stepSim, syncInputs, setPhase, botInput, netState, predict, fly, netAt, kmhOf, shotKind, _stepBall: stepBall, _launch: launch, _launchAngle: launchAngle, _quality: quality };
});
