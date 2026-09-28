// Office Ball — shared game simulation.
// Runs authoritatively on the server; the browser loads it for constants only.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OB = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const C = {
    W: 1100, H: 680, FL: 70, FR: 1030, FT: 92, FB: 652,
    GH: 140, GD: 42, POST_R: 6, PR: 18, BR: 10,
    // movement: players have mass. They accelerate into top speed, carve arcs when turning
    // at speed and skid when reversing.
    TOP: 4.3, ACCEL: 0.09, REVERSE: 0.16, STOP: 0.86,
    // ball
    GROUND_FRIC: 0.988, AIR_DRAG: 0.996, GRAV: 0.32, BOUNCE: 0.45, WALL_E: 0.55,
    ROLL: 0.028,     // rolling resistance on grass (px/tick²): a slow ball dies, a struck one carries
    WALL_GRIP: 0.8,  // the boards are padded: a ball keeps this much of its speed along them
    BAR: 62,         // crossbar height (px of height; the pitch uses 1 world unit = 50px)
    BODY_H: 55,      // a ball higher than this flies over players
    KICK_H: 30,      // a ball higher than this can't be kicked
    CHARGE_FULL: 40, PERF_END: 52,
    DASH_CD: 100, DASH_T: 11, DASH_SPEED: 12.5,
    MATCH_TICKS: 120 * 60, WIN_GOALS: 3,
    KICKOFF_T: 60, GOAL_T: 70, HALF_T: 240,
    REPLAY_BEFORE: 130, REPLAY_AFTER: 25, REPLAY_SPEED: 0.5,
  };
  C.CX = (C.FL + C.FR) / 2; C.CY = (C.FT + C.FB) / 2;
  C.GY1 = C.CY - C.GH / 2; C.GY2 = C.CY + C.GH / 2;
  C.REACH = C.PR + C.BR + 14;
  C.POSTS = [[C.FL, C.GY1], [C.FL, C.GY2], [C.FR, C.GY1], [C.FR, C.GY2]];
  C.REPLAY_T = Math.ceil((C.REPLAY_BEFORE + C.REPLAY_AFTER) / C.REPLAY_SPEED);
  C.ROOF = C.BAR * 0.72; // net roof height at the back

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // after halftime the teams switch ends: red attacks left, blue attacks right
  const attacksRight = (s, i) => (i === 0) !== !!s.swapped;
  const r1 = v => Math.round(v * 10) / 10;
  const r2 = v => Math.round(v * 100) / 100;

  function mkPlayer(i) {
    return {
      i, x: 0, y: 0, vx: 0, vy: 0, fx: i ? -1 : 1, fy: 0,
      ch: false, ct: 0, dashT: 0, dashCd: 0, dashHit: false, recover: 0, stun: 0,
      init: false, lastKp: 0, lastDc: 0, pk: null, sw: null, touchCd: 0, skidCd: 0, evCd: 0,
      st: { goals: 0, shots: 0, onTarget: 0, perfect: 0, tackles: 0, poss: 0 },
    };
  }

  // opts.solo: free practice for one player. No opponent, no clock, goals in either net count.
  function createSim(tick, opts = {}) {
    const s = {
      tick, players: [mkPlayer(0), mkPlayer(1)],
      ball: { x: C.CX, y: C.CY, z: 0, vx: 0, vy: 0, vz: 0, spin: 0, hot: 0, last: -1, net: 0 },
      score: [0, 0], time: C.MATCH_TICKS, sd: false, half: 1, swapped: false, solo: !!opts.solo,
      phase: 'kickoff', pt: 0, ps: tick, rf: 0, goalTick: -1, dramaCd: 0,
      hitstop: 0, freeze: 0, winner: -1, events: [], ready: [false, false],
      bot: [{ hold: 0, dc: 0, aim: 0, aimT: 0 }, { hold: 0, dc: 0, aim: 0, aimT: 0 }],
    };
    resetKickoff(s, -1);
    return s;
  }

  function setPhase(s, ph) { s.phase = ph; s.pt = 0; s.ps = s.tick; }
  function ev(s, type, o) { if (!s.quiet) s.events.push(Object.assign({ type, tick: s.tick }, o)); }

  // conceder: slot that just conceded; they get the first touch (ball nudged to their side)
  function resetKickoff(s, conceder) {
    s.players.forEach((p, i) => {
      const right = attacksRight(s, i);
      Object.assign(p, { vx: 0, vy: 0, ch: false, ct: 0, stun: 0, dashT: 0, recover: 0, sw: null, pk: null, fy: 0, x: right ? C.FL + 190 : C.FR - 190, y: C.CY, fx: right ? 1 : -1 });
    });
    if (s.solo) Object.assign(s.players[1], { x: -5000, y: -5000, off: true });
    let bx = C.CX;
    if (conceder >= 0 && !s.solo) bx += attacksRight(s, conceder) ? -46 : 46;
    Object.assign(s.ball, { x: bx, y: C.CY, z: 0, vx: 0, vy: 0, vz: 0, spin: 0, hot: 0, last: -1, net: 0 });
    setPhase(s, 'kickoff');
  }

  function syncInputs(s, inputs) {
    s.players.forEach((p, i) => {
      const inp = inputs[i];
      p.lastKp = inp.kp; p.lastDc = inp.dc; p.init = true;
      if (s.phase !== 'play' && s.phase !== 'goal') { p.ch = false; p.ct = 0; p.sw = null; p.pk = null; }
    });
  }

  // ---------- ball prediction (used for "on target" and the goal-line slow motion) ----------
  // Runs the ball forward on its own (no players) and reports if/when it would cross a goal line.
  function predictGoal(s, n) {
    const shadow = { ball: Object.assign({}, s.ball), events: [], quiet: true, phase: 'predict', tick: 0 };
    for (let t = 1; t <= n; t++) {
      stepBall(shadow);
      const b = shadow.ball;
      if (b.net === -1 && b.x < C.FL - C.BR) return { side: 0, t, x: b.x, y: b.y };
      if (b.net === 1 && b.x > C.FR + C.BR) return { side: 1, t, x: b.x, y: b.y };
      if (Math.hypot(b.vx, b.vy) < 1.5 && b.z <= 0) return null;
    }
    return null;
  }

  // ---------- kicking ----------
  const dist2d = (s, p) => Math.hypot(s.ball.x - p.x, s.ball.y - p.y);
  const kickable = (s, p, extra = 0) => dist2d(s, p) <= C.REACH + extra && s.ball.z < C.KICK_H;
  const powerOf = ct => (ct >= C.CHARGE_FULL && ct <= C.PERF_END) ? 1.3 : ct > C.PERF_END ? 0.85 : 0.3 + 0.7 * Math.max(0, ct) / C.CHARGE_FULL;

  // release: start the swing (the ball leaves on the contact frame, a few ticks later)
  function startSwing(s, p, ct, lob) {
    const power = powerOf(ct);
    const t = power >= 1.25 ? 6 : power > 0.6 ? 5 : 3;
    p.sw = { ct, lob, t };
    ev(s, 'swing', { p: p.i, t, lob: lob ? 1 : 0, power: r2(power) });
  }

  function kick(s, p, ct, lob) {
    const b = s.ball;
    let tx = b.x - p.x, ty = b.y - p.y; const d = Math.hypot(tx, ty) || 1; tx /= d; ty /= d;
    const power = powerOf(ct), perfect = power >= 1.25;
    // aim where the player is facing/pointing (unless the ball is behind them)
    let nx, ny;
    if (tx * p.fx + ty * p.fy > -0.2) { nx = p.fx * 0.85 + tx * 0.15; ny = p.fy * 0.85 + ty * 0.15; } else { nx = tx; ny = ty; }
    let l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    // Striking cleanly is the skill: a PERFECT charge goes exactly where you aim; a rushed or
    // overcooked one, or one struck at a flat-out sprint, strays a few degrees either way.
    const quality = perfect ? 1 : ct > C.PERF_END ? 0.35 : 0.5 + 0.5 * Math.min(1, Math.max(0, ct) / C.CHARGE_FULL);
    const sprint = clamp(Math.hypot(p.vx, p.vy) / C.TOP, 0, 1);
    const errDeg = (perfect ? 0.4 : (1 - quality) * 10 + 1) + sprint * sprint * 2.5;
    const err = (Math.random() + Math.random() - 1) * errDeg * Math.PI / 180;
    { const c = Math.cos(err), sn = Math.sin(err); const ex = nx * c - ny * sn; ny = nx * sn + ny * c; nx = ex; }
    let sp, vz;
    if (lob) { sp = 3.6 + 6 * power; vz = 6 + 3.2 * power; }   // chip: up and over
    else { sp = 5 + 12 * power; vz = power > 0.55 ? (power - 0.5) * 5.5 : 0; } // driven shots rise, then dip
    const volley = b.z > 6;
    b.vx = nx * sp; b.vy = ny * sp; b.vz = vz + (volley ? 1 : 0);
    const lat = p.vx * -ny + p.vy * nx; // running one way while aiming another => curve
    b.spin = clamp(lat * 0.0034, -0.017, 0.017) * (power > 0.6 ? 1 : 0.5) * (lob ? 0.5 : 1);
    b.hot = perfect && !lob ? 80 : 0; b.last = p.i;
    p.vx -= nx * 1.0; p.vy -= ny * 1.0; p.touchCd = 16;
    s.hitstop = Math.max(s.hitstop, perfect ? 6 : power > 0.6 ? 2 : 0);
    const pred = power > 0.55 ? predictGoal(s, 90) : null;
    const onTarget = !!pred && pred.side === (s.solo ? pred.side : (attacksRight(s, p.i) ? 1 : 0));
    if (power > 0.6) { p.st.shots++; if (onTarget) p.st.onTarget++; }
    if (perfect) p.st.perfect++;
    ev(s, 'kick', { p: p.i, x: r1(b.x), y: r1(b.y), perfect, power: r2(power), lob: lob ? 1 : 0, volley: volley ? 1 : 0, curve: Math.abs(b.spin) > 0.01, onTarget: onTarget ? 1 : 0, dx: r2(nx), dy: r2(ny) });
  }

  // ---------- physics ----------
  function stepPlayer(s, p, inp) {
    if (!p.init) { p.lastKp = inp.kp; p.lastDc = inp.dc; p.init = true; }
    if (p.dashCd > 0) p.dashCd--;
    if (p.recover > 0) p.recover--;
    if (p.touchCd > 0) p.touchCd--;
    if (p.skidCd > 0) p.skidCd--;
    if (p.evCd > 0) p.evCd--;

    // movement: analog (mouse / gamepad) or digital (keyboard)
    let ax, ay;
    if (inp.ax || inp.ay) { ax = inp.ax || 0; ay = inp.ay || 0; }
    else { ax = (inp.r ? 1 : 0) - (inp.l ? 1 : 0); ay = (inp.d ? 1 : 0) - (inp.u ? 1 : 0); }
    let m = Math.hypot(ax, ay);
    if (m > 1) { ax /= m; ay /= m; m = 1; }
    if (m > 0.12 && p.stun <= 0) { p.fx = ax / m; p.fy = ay / m; }

    // tackle button: while charging or swinging it cancels the kick (shot fake); otherwise dash
    if (inp.dc !== p.lastDc) {
      p.lastDc = inp.dc;
      if (p.stun === 0 && (p.ch || p.sw || p.pk)) {
        p.ch = false; p.ct = 0; p.sw = null; p.pk = null;
        ev(s, 'fake', { p: p.i, x: r1(p.x), y: r1(p.y) });
      } else if (p.dashCd === 0 && p.stun === 0) {
        const dx = m > 0.12 ? ax / m : p.fx, dy = m > 0.12 ? ay / m : p.fy;
        p.vx = dx * C.DASH_SPEED; p.vy = dy * C.DASH_SPEED;
        p.dashT = C.DASH_T; p.dashCd = C.DASH_CD; p.dashHit = false;
        ev(s, 'dash', { p: p.i, x: r1(p.x), y: r1(p.y) });
      }
    }

    const pressedNew = inp.kp !== p.lastKp;
    const tapped = pressedNew && !inp.k && !p.ch;
    p.lastKp = inp.kp;
    if (p.stun > 0) { p.ch = false; p.ct = 0; p.pk = null; p.sw = null; }
    else if (p.sw) {
      // mid-swing: the foot meets the ball on the last tick
      if (--p.sw.t <= 0) {
        const { ct, lob } = p.sw; p.sw = null;
        if (kickable(s, p, 10)) kick(s, p, ct, lob);
        else ev(s, 'whiff', { p: p.i, x: r1(p.x), y: r1(p.y) });
      }
    } else {
      // buffered kick: released a moment early, swing as soon as the ball is in reach
      if (p.pk) {
        if (pressedNew) p.pk = null;
        else if (kickable(s, p)) { startSwing(s, p, p.pk.ct, p.pk.lob); p.pk = null; }
        else if (--p.pk.t <= 0) { if (p.pk.ct > 14) ev(s, 'whiff', { p: p.i, x: r1(p.x), y: r1(p.y) }); p.pk = null; }
      }
      if (inp.k) { if (!p.ch) { p.ch = true; p.ct = 0; } p.ct++; }
      else if (p.ch || tapped) {
        // client reports how long it actually held the key; trust it within a small tolerance
        const ct = typeof inp.kc === 'number' ? clamp(inp.kc, p.ct - 10, p.ct + 10) : p.ct;
        p.ch = false; p.ct = 0;
        if (kickable(s, p)) startSwing(s, p, ct, !!inp.lob); else p.pk = { ct, lob: !!inp.lob, t: 22 };
      }
    }
    if (p.stun > 0) { p.stun--; ax = ay = 0; m = 0; }

    if (p.dashT > 0) {
      p.dashT--; p.vx *= 0.97; p.vy *= 0.97;
      if (p.dashT === 0 && !p.dashHit) { p.recover = 30; ev(s, 'dashmiss', { p: p.i, x: r1(p.x), y: r1(p.y) }); }
    } else {
      const top = C.TOP * (p.ch ? 0.62 : 1) * (p.recover > 0 ? 0.4 : 1) * (p.sw ? 0.45 : 1);
      const speed = Math.hypot(p.vx, p.vy);
      if (m > 0.05) {
        const reversing = p.vx * ax + p.vy * ay < -0.3 * speed * m;
        const k = reversing ? C.REVERSE : C.ACCEL;
        p.vx += (ax * top - p.vx) * k; p.vy += (ay * top - p.vy) * k;
        if (reversing && speed > 3.2 && !p.skidCd) { p.skidCd = 20; ev(s, 'skid', { p: p.i, x: r1(p.x), y: r1(p.y) }); }
      } else { p.vx *= C.STOP; p.vy *= C.STOP; }
    }
    p.x += p.vx; p.y += p.vy;
    if (p.x < C.FL + C.PR) { p.x = C.FL + C.PR; p.vx = 0; }
    if (p.x > C.FR - C.PR) { p.x = C.FR - C.PR; p.vx = 0; }
    if (p.y < C.FT + C.PR) { p.y = C.FT + C.PR; p.vy = 0; }
    if (p.y > C.FB - C.PR) { p.y = C.FB - C.PR; p.vy = 0; }
  }

  function collidePlayers(s) {
    const [a, b] = s.players;
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = C.PR * 2;
    if (d >= min || d === 0) return;
    const nx = dx / d, ny = dy / d, ov = (min - d) / 2;
    a.x -= nx * ov; a.y -= ny * ov; b.x += nx * ov; b.y += ny * ov;
    const aDash = a.dashT > 0 && !a.dashHit, bDash = b.dashT > 0 && !b.dashHit;
    if (aDash !== bDash) {
      const atk = aDash ? a : b, vic = aDash ? b : a, sg = aDash ? 1 : -1;
      atk.dashHit = true; vic.stun = 50; vic.ch = false; vic.ct = 0; vic.sw = null; vic.pk = null;
      vic.vx = nx * sg * 8; vic.vy = ny * sg * 8; atk.vx *= 0.3; atk.vy *= 0.3;
      atk.st.tackles++; s.hitstop = Math.max(s.hitstop, 4);
      ev(s, 'tackle', { p: atk.i, v: vic.i, x: r1(vic.x), y: r1(vic.y) });
      return;
    }
    const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (rel < 0) {
      const j = -1.3 * rel / 2; a.vx -= j * nx; a.vy -= j * ny; b.vx += j * nx; b.vy += j * ny;
      if (-rel > 3 && !a.evCd) { a.evCd = 12; ev(s, 'bump', { x: r1((a.x + b.x) / 2), y: r1((a.y + b.y) / 2), f: r1(-rel) }); }
    }
  }

  // player <-> ball. A slow ball in front of a player gets a controlled touch: it is pushed
  // ahead in the direction they face. Walking = small touches (tight control); sprinting = longer
  // touches (the ball runs a little ahead, and a defender can nick it). Fast balls need a trap.
  function collideBall(s, p) {
    const b = s.ball;
    if (b.z > C.BODY_H) return; // ball flies over the player
    const dx = b.x - p.x, dy = b.y - p.y, d = Math.hypot(dx, dy), min = C.PR + C.BR;
    if (d >= min || d === 0) return;
    const nx = dx / d, ny = dy / d, ov = min - d;
    b.x += nx * ov * 0.9; b.y += ny * ov * 0.9; p.x -= nx * ov * 0.1; p.y -= ny * ov * 0.1;
    const rvx = b.vx - p.vx, rvy = b.vy - p.vy, rel = rvx * nx + rvy * ny, relSpeed = Math.hypot(rvx, rvy);
    if (p.dashT > 0 && !p.dashHit) { // a dash into the ball pokes it hard
      p.dashHit = true;
      b.vx = p.vx * 1.1 + nx * 3; b.vy = p.vy * 1.1 + ny * 3; b.vz = 1.5; b.last = p.i; b.spin = 0;
      ev(s, 'touch', { p: p.i, x: r1(b.x), y: r1(b.y), f: 3 });
      return;
    }
    if (rel >= 0) return;
    const controllable = p.stun <= 0 && b.z < 14 && p.touchCd <= 0;
    if (controllable && relSpeed < 9.5) {
      const spd = Math.hypot(p.vx, p.vy), sprint = clamp(spd / C.TOP, 0, 1);
      let tx = p.fx * 0.7 + nx * 0.3, ty = p.fy * 0.7 + ny * 0.3;
      if (tx * nx + ty * ny < 0.15) { tx = nx; ty = ny; }
      const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      // a touch plays the ball about a stride ahead of you: a little quicker than you are running
      // (more at a sprint, so a defender can nick it), never a pass to nobody
      const sp = Math.max(1.1, spd * (1.06 + 0.2 * sprint * sprint)) * (p.ch ? 0.92 : 1);
      b.vx = tx * sp; b.vy = ty * sp; b.vz = 0; b.spin *= 0.3; b.last = p.i;
      p.touchCd = 5;
      if (!p.evCd) { p.evCd = 7; ev(s, 'touch', { p: p.i, x: r1(b.x), y: r1(b.y), f: r1(sp) }); }
    } else if (controllable) {
      // first touch on a fast ball: facing it = clean trap, otherwise it spills
      const facing = -(p.fx * nx + p.fy * ny); // 1 = ball arriving straight at your front
      const keep = facing > 0.4 ? 0.14 : 0.38;
      const rx = rvx - 2 * rel * nx, ry = rvy - 2 * rel * ny; // reflected relative velocity
      b.vx = p.vx + rx * keep; b.vy = p.vy + ry * keep; b.vz = Math.abs(b.vz) * 0.3; b.spin = 0; b.last = p.i;
      p.touchCd = 6;
      ev(s, 'trap', { p: p.i, x: r1(b.x), y: r1(b.y), clean: facing > 0.4 ? 1 : 0 });
    } else {
      const mb = 0.5, mp = 1, j = -1.3 * rel / (1 / mb + 1 / mp);
      b.vx += j / mb * nx; b.vy += j / mb * ny; p.vx -= j / mp * nx; p.vy -= j / mp * ny;
      b.spin *= 0.5; b.last = p.i;
    }
  }

  // close control: when walking, turning or winding up a shot, the ball is gently kept near the
  // front foot. The assist fades out as you approach full sprint, so sprinting with the ball
  // means bigger, riskier touches.
  function closeControl(s) {
    const b = s.ball;
    if (b.z > 8 || b.x < C.FL || b.x > C.FR) return;
    let best = null, bestD = 1e9;
    for (const p of s.players) {
      if (p.off || p.stun > 0 || p.dashT > 0 || p.touchCd > 8) continue;
      const dx = b.x - p.x, dy = b.y - p.y, d = Math.hypot(dx, dy) || 1;
      if (d > C.PR + C.BR + 20 || (dx * p.fx + dy * p.fy) / d < -0.3) continue;
      if (Math.hypot(b.vx - p.vx, b.vy - p.vy) > 6.5) continue;
      const sprint = clamp(Math.hypot(p.vx, p.vy) / C.TOP, 0, 1);
      const k = p.ch || p.sw ? 1 : 1 - sprint * sprint * 0.85;
      const fx = p.x + p.fx * (C.PR + C.BR + 4), fy = p.y + p.fy * (C.PR + C.BR + 4);
      const fd = Math.hypot(b.x - fx, b.y - fy);
      if (fd < bestD) { bestD = fd; best = { p, fx, fy, k }; }
    }
    if (!best) return;
    const { p, fx, fy, k } = best;
    b.vx += ((p.vx - b.vx) * 0.12 + (fx - b.x) * 0.05) * k;
    b.vy += ((p.vy - b.vy) * 0.12 + (fy - b.y) * 0.05) * k;
  }

  function stepBall(s) {
    const b = s.ball;
    if (b.spin) {
      const c = Math.cos(b.spin), sn = Math.sin(b.spin), vx = b.vx * c - b.vy * sn;
      b.vy = b.vx * sn + b.vy * c; b.vx = vx; b.spin *= 0.985;
      if (Math.abs(b.spin) < 0.0005) b.spin = 0;
    }
    const px = b.x, py = b.y; // where it was, for the swept collisions below
    b.x += b.vx; b.y += b.vy;
    // height
    if (b.z > 0 || b.vz > 0) {
      b.vz -= C.GRAV; b.z += b.vz;
      if (b.z <= 0) {
        b.z = 0;
        if (b.vz < -1.4) { const imp = -b.vz; b.vz = imp * C.BOUNCE; b.vx *= 0.9; b.vy *= 0.9; if (imp > 2.2) ev(s, 'bounce', { x: r1(b.x), y: r1(b.y), f: r1(imp) }); }
        else b.vz = 0;
      }
    }
    const air = b.z > 0.5;
    const fr = air ? C.AIR_DRAG : C.GROUND_FRIC;
    b.vx *= fr; b.vy *= fr;
    if (!air) { const v = Math.hypot(b.vx, b.vy); if (v > 0) { const k = Math.max(0, v - C.ROLL) / v; b.vx *= k; b.vy *= k; } }
    if (b.hot > 0) b.hot--;
    // Swept collisions. A struck ball can travel further in one tick than the band in front of the
    // end line is deep, and further than a post is wide, so its path is tested, not just where it
    // ends up (otherwise a hard shot wide of the goal passes the board and lands in the net). If the
    // path meets the end board (wide of the posts, or over the bar) or a post, the ball is put back
    // where it struck; the code below then plays the bounce, the bar or the post as usual.
    for (const [wall, dir] of [[C.FL + C.BR, -1], [C.FR - C.BR, 1]]) {
      if ((px - wall) * dir <= 0 && (b.x - wall) * dir > 0) { // crossed the board's plane, heading out
        const u = (wall - px) / (b.x - px), yc = py + (b.y - py) * u;
        const clean = yc > C.GY1 + C.BR * 0.5 && yc < C.GY2 - C.BR * 0.5 && b.z < C.BAR - C.BR;
        if (!clean) { b.x = wall + dir * 0.01; b.y = yc; }
      }
    }
    if (b.z < C.BAR) for (const [cx, cy] of C.POSTS) {
      const dx = b.x - px, dy = b.y - py, fx = px - cx, fy = py - cy, R = C.BR + C.POST_R;
      const A = dx * dx + dy * dy; if (A < 1e-9) continue;
      const B = 2 * (fx * dx + fy * dy), Cc = fx * fx + fy * fy - R * R, disc = B * B - 4 * A * Cc;
      if (Cc <= 0 || disc <= 0) continue; // started touching it (resolved below) or never meets it
      const t0 = (-B - Math.sqrt(disc)) / (2 * A);
      if (t0 >= 0 && t0 <= 1) { const k = Math.min(1, t0 + 0.02); b.x = px + dx * k; b.y = py + dy * k; break; }
    }
    const inMouth = b.y > C.GY1 && b.y < C.GY2;
    // A ball is only ever in a net if it went in through the mouth (between the posts, under the
    // bar). Anything else that ends up behind the line (pushed there in a scramble, poked by a dash)
    // is against the end board, and goes back in play off it: position alone never scores.
    if ((b.x < C.FL || b.x > C.FR) && !b.net) {
      const side = b.x > C.FR ? 1 : -1, line = side > 0 ? C.FR : C.FL;
      const inside = side > 0 ? px <= C.FR : px >= C.FL;
      const yc = inside && b.x !== px ? py + (b.y - py) * (line - px) / (b.x - px) : b.y;
      if (yc > C.GY1 && yc < C.GY2 && b.z < C.BAR) b.net = side;
      else {
        b.x = side > 0 ? C.FR - C.BR : C.FL + C.BR; b.vx = -side * Math.abs(b.vx) * C.WALL_E; b.vy *= C.WALL_GRIP; b.spin *= 0.3;
      }
    }
    if (b.x >= C.FL && b.x <= C.FR) b.net = 0;
    if (b.net) { // inside a goal net
      if (b.y < C.GY1 + C.BR) { b.y = C.GY1 + C.BR; b.vy = Math.abs(b.vy) * 0.3; }
      if (b.y > C.GY2 - C.BR) { b.y = C.GY2 - C.BR; b.vy = -Math.abs(b.vy) * 0.3; }
      if (b.x < C.FL - C.GD + C.BR) { b.x = C.FL - C.GD + C.BR; b.vx = Math.abs(b.vx) * 0.2; }
      if (b.x > C.FR + C.GD - C.BR) { b.x = C.FR + C.GD - C.BR; b.vx = -Math.abs(b.vx) * 0.2; }
      if (b.z > C.ROOF) { b.z = C.ROOF; b.vz = -Math.abs(b.vz) * 0.3; }
      b.vx *= 0.95; b.vy *= 0.95; b.spin = 0;
    } else {
      const sp = Math.hypot(b.vx, b.vy);
      let hit = false;
      if (b.y < C.FT + C.BR) { b.y = C.FT + C.BR; b.vy = Math.abs(b.vy) * C.WALL_E; b.vx *= C.WALL_GRIP; b.spin *= 0.3; hit = true; }
      if (b.y > C.FB - C.BR) { b.y = C.FB - C.BR; b.vy = -Math.abs(b.vy) * C.WALL_E; b.vx *= C.WALL_GRIP; b.spin *= 0.3; hit = true; }
      const atLine = b.x < C.FL + C.BR || b.x > C.FR - C.BR;
      if (atLine) {
        const left = b.x < C.FL + C.BR;
        if (!inMouth) {
          if (left) { b.x = C.FL + C.BR; b.vx = Math.abs(b.vx) * C.WALL_E; } else { b.x = C.FR - C.BR; b.vx = -Math.abs(b.vx) * C.WALL_E; }
          b.vy *= C.WALL_GRIP; b.spin *= 0.3; hit = true;
        } else if (b.z > C.BAR - C.BR) {
          // too high for the goal: the crossbar, or over it into the stand netting
          const bar = b.z < C.BAR + C.BR;
          if (left) { b.x = C.FL + C.BR; b.vx = Math.abs(b.vx) * (bar ? 0.6 : 0.3); } else { b.x = C.FR - C.BR; b.vx = -Math.abs(b.vx) * (bar ? 0.6 : 0.3); }
          if (bar) b.vz = b.z > C.BAR ? Math.abs(b.vz) * 0.5 + 1 : -Math.abs(b.vz) * 0.6 - 1;
          b.spin = 0;
          if (s.phase === 'play' && sp > 4) ev(s, bar ? 'bar' : 'over', { x: r1(b.x), y: r1(b.y), z: r1(b.z) });
        }
      }
      if (hit && sp > 8) ev(s, 'wall', { x: r1(b.x), y: r1(b.y), sp: r1(sp) });
    }
    if (b.z < C.BAR) for (const [px, py] of C.POSTS) {
      const dx = b.x - px, dy = b.y - py, d = Math.hypot(dx, dy), min = C.BR + C.POST_R;
      if (d < min && d > 0) {
        const nx = dx / d, ny = dy / d, vn = b.vx * nx + b.vy * ny;
        b.x = px + nx * min; b.y = py + ny * min;
        if (vn < 0) {
          b.vx -= (1 + C.WALL_E) * vn * nx; b.vy -= (1 + C.WALL_E) * vn * ny; b.spin = 0;
          if (-vn > 7 && s.phase === 'play') ev(s, 'post', { x: px, y: py });
        }
      }
    }
  }

  function physics(s, inputs) {
    s.players.forEach((p, i) => { if (!p.off) stepPlayer(s, p, inputs[i]); });
    if (!s.solo) collidePlayers(s);
    s.players.forEach(p => { if (!p.off) collideBall(s, p); });
    closeControl(s);
    stepBall(s);
    if (s.phase === 'play') {
      const b = s.ball, [a, c] = s.players;
      const d0 = Math.hypot(b.x - a.x, b.y - a.y), d1 = Math.hypot(b.x - c.x, b.y - c.y);
      if (Math.min(d0, d1) < 70) s.players[d0 < d1 ? 0 : 1].st.poss++;
      checkDrama(s);
    }
  }

  // goal-line drama: a fast ball that will cross the line in the next few ticks with nobody able
  // to get to it. Clients slow the picture down for that moment.
  function checkDrama(s) {
    if (s.dramaCd > 0) { s.dramaCd--; return; }
    const b = s.ball;
    if (Math.hypot(b.vx, b.vy) < 9) return;
    const pr = predictGoal(s, 12);
    if (!pr) return;
    // could a player still block it? (someone close to the ball's path)
    const shadow = { ball: Object.assign({}, b), events: [], quiet: true, phase: 'predict', tick: 0 };
    for (let t = 1; t <= pr.t; t++) {
      stepBall(shadow);
      for (const p of s.players) if (!p.off && Math.hypot(shadow.ball.x - p.x, shadow.ball.y - p.y) < C.PR + C.BR + 4 + t * 1.5 && shadow.ball.z < C.BODY_H) return;
    }
    s.dramaCd = 60;
    ev(s, 'drama', { n: pr.t, side: pr.side });
  }

  // practice: R puts the ball at your feet
  function resetBallRequest(s, inp) {
    const rb = inp.rb | 0, p = s.players[0];
    if (s.lastRb === undefined) { s.lastRb = rb; return; }
    if (rb === s.lastRb) return;
    s.lastRb = rb;
    Object.assign(s.ball, { x: clamp(p.x + p.fx * 34, C.FL + C.BR + 2, C.FR - C.BR - 2), y: clamp(p.y + p.fy * 34, C.FT + C.BR + 2, C.FB - C.BR - 2), z: 0, vx: 0, vy: 0, vz: 0, spin: 0, hot: 0, net: 0 });
    ev(s, 'reset', { x: r1(s.ball.x), y: r1(s.ball.y) });
  }

  function scoreGoal(s, scorer) {
    if (s.solo) scorer = 0; // practice: both nets are yours
    s.score[scorer]++;
    const own = s.ball.last !== -1 && s.ball.last !== scorer;
    if (!own) s.players[scorer].st.goals++;
    s.goalTick = s.tick; s.hitstop = 6; s.lastConceder = 1 - scorer;
    if (!s.solo && (s.score[scorer] >= C.WIN_GOALS || s.sd)) s.winner = scorer;
    ev(s, 'goal', { scorer, own, x: r1(s.ball.x), y: r1(s.ball.y), z: r1(s.ball.z), score: s.score.slice(), final: s.winner >= 0 });
    setPhase(s, 'goal');
  }

  function endMatch(s, winner) {
    s.winner = winner; setPhase(s, 'over'); ev(s, 'end', { winner });
  }

  function stepSim(s, inputs) {
    const kickPressed = s.players.map((p, i) => p.init && inputs[i].kp !== p.lastKp);
    if (s.freeze > 0) { s.freeze--; syncInputs(s, inputs); return; }
    switch (s.phase) {
      case 'kickoff':
        syncInputs(s, inputs);
        if (++s.pt >= C.KICKOFF_T) { setPhase(s, 'play'); ev(s, 'whistle'); }
        break;
      case 'play':
      case 'goal':
        if (s.hitstop > 0) { s.hitstop--; break; }
        if (s.solo) resetBallRequest(s, inputs[0]);
        physics(s, inputs);
        if (s.phase === 'play') {
          const b = s.ball;
          if (b.net === -1 && b.x < C.FL - C.BR) scoreGoal(s, s.swapped ? 0 : 1);
          else if (b.net === 1 && b.x > C.FR + C.BR) scoreGoal(s, s.swapped ? 1 : 0);
          else if (s.solo) { /* no clock in practice */ }
          else if (!s.sd && s.half === 1 && --s.time <= C.MATCH_TICKS / 2) {
            s.half = 2; setPhase(s, 'half'); ev(s, 'half', { score: s.score.slice() });
          } else if (!s.sd && s.half === 2 && --s.time <= 0) {
            s.time = 0;
            if (s.score[0] !== s.score[1]) endMatch(s, s.score[0] > s.score[1] ? 0 : 1);
            else { s.sd = true; ev(s, 'sd'); }
          }
        } else if (++s.pt >= C.GOAL_T) {
          if (s.solo) resetKickoff(s, -1); // no replays in practice, straight back to it
          else { setPhase(s, 'replay'); s.rf = s.goalTick - C.REPLAY_BEFORE; }
        }
        break;
      case 'half':
        syncInputs(s, inputs);
        if (++s.pt >= C.HALF_T) { s.swapped = true; resetKickoff(s, -1); ev(s, 'secondhalf'); }
        break;
      case 'replay':
        syncInputs(s, inputs);
        s.pt++;
        if (s.pt >= C.REPLAY_T || (s.pt > 45 && kickPressed.some(Boolean))) {
          if (s.winner >= 0) endMatch(s, s.winner); else resetKickoff(s, s.lastConceder);
        }
        break;
      case 'over':
        kickPressed.forEach((v, i) => { if (v) s.ready[i] = true; });
        syncInputs(s, inputs);
        s.pt++;
        break;
    }
  }

  // ---------- bot ----------
  function botInput(s, i) {
    const p = s.players[i], o = s.players[1 - i], ball = s.ball, B = s.bot[i];
    const inp = { u: 0, d: 0, l: 0, r: 0, k: false, kp: 0, kc: null, dc: B.dc };
    if (s.phase !== 'play' && s.phase !== 'goal') { B.hold = 0; return inp; }
    const dir = attacksRight(s, i) ? 1 : -1;
    if (--B.aimT <= 0) { B.aim = (Math.random() * 2 - 1) * (C.GH / 2 - 24); B.aimT = 90; }
    const gx = dir > 0 ? C.FR + 8 : C.FL - 8, gy = C.CY + B.aim, ownX = dir > 0 ? C.FL : C.FR;
    let ux = gx - ball.x, uy = gy - ball.y; const ug = Math.hypot(ux, uy) || 1; ux /= ug; uy /= ug;
    const bd = Math.hypot(ball.x - p.x, ball.y - p.y), od = Math.hypot(ball.x - o.x, ball.y - o.y);
    const side = (p.x - ball.x) * -ux + (p.y - ball.y) * -uy; // >0 => behind the ball
    let tx, ty;
    let pressing = false;
    if (od < bd - 30 && (ball.x - C.CX) * dir < 150) {
      // defend: get goal-side of the ball on the line to the middle of our goal (blocking the
      // shot), closing the gap as the attacker comes in; once goal-side and close, step in and take it
      let vx = ownX - ball.x, vy = C.CY - ball.y; const vg = Math.hypot(vx, vy) || 1; vx /= vg; vy /= vg;
      const gap = clamp(vg * 0.3, 34, 130);
      tx = ball.x + vx * gap; ty = ball.y + vy * gap;
      const goalSide = (p.x - ball.x) * vx + (p.y - ball.y) * vy > 10;
      if (goalSide && bd < 72) {
        // press from the side of the ball facing our goal, so our touch plays it back upfield
        // (straight at the ball along the goal line would steer it into our own net)
        let cx = C.CX - ball.x, cy = C.CY - ball.y; const cl = Math.hypot(cx, cy) || 1; cx /= cl; cy /= cl;
        tx = ball.x - cx * 14; ty = ball.y - cy * 14; pressing = true;
      }
    } else if (side < C.PR) {
      const px = -uy, py = ux, sg = ((p.x - ball.x) * px + (p.y - ball.y) * py) > 0 ? 1 : -1;
      tx = ball.x - ux * 40 + px * sg * 48; ty = ball.y - uy * 40 + py * sg * 48;
    } else { tx = ball.x + ux * 20; ty = ball.y + uy * 20; } // run through the ball toward goal
    const mx = tx - p.x, my = ty - p.y;
    if (mx > 5) inp.r = 1; if (mx < -5) inp.l = 1; if (my > 5) inp.d = 1; if (my < -5) inp.u = 1;
    const aligned = side > 0 && ((ball.x - p.x) * ux + (ball.y - p.y) * uy) / Math.max(bd, 1) > 0.8;
    if (B.hold > 0) { inp.k = true; B.hold--; if (bd > C.REACH + 40) B.hold = 0; }
    else if (aligned && bd < C.REACH + 20 && ball.z < C.KICK_H && Math.random() < 0.12) {
      const dg = Math.hypot(gx - ball.x, gy - ball.y);
      B.hold = dg < 420 ? C.CHARGE_FULL + ((Math.random() * 18) | 0) : 6 + ((Math.random() * 18) | 0);
      inp.k = true;
    }
    const pd = Math.hypot(o.x - p.x, o.y - p.y);
    // tackle only when it can actually arrive: a lunge from too far misses and leaves the way open
    if (od < C.REACH + 6 && pd < (pressing ? 62 : 80) && p.dashCd === 0 && !p.ch && Math.random() < (pressing ? 0.09 : 0.04)) {
      inp.l = inp.r = inp.u = inp.d = 0;
      if (o.x - p.x > 8) inp.r = 1; if (o.x - p.x < -8) inp.l = 1;
      if (o.y - p.y > 8) inp.d = 1; if (o.y - p.y < -8) inp.u = 1;
      inp.dc = ++B.dc;
    }
    return inp;
  }

  // ---------- network snapshot ----------
  function netState(s) {
    const b = s.ball;
    return {
      ph: s.phase, pt: s.pt, ps: s.ps, rf: s.rf, fz: s.freeze,
      sc: s.score, tm: Math.ceil(s.time / 60), sd: s.sd ? 1 : 0, rd: s.ready.map(Number), hf: s.half, sw: s.swapped ? 1 : 0, so: s.solo ? 1 : 0,
      b: [r1(b.x), r1(b.y), b.hot > 0 ? 1 : 0, r1(b.z)],
      p: s.players.map(p => [r1(p.x), r1(p.y), r2(p.fx), r2(p.fy), p.ch ? p.ct : -1,
        p.stun > 0 ? 1 : 0, p.dashT > 0 ? 1 : 0, p.dashCd, p.recover > 0 ? 1 : 0, r1(p.vx), r1(p.vy)]),
    };
  }

  return { C, createSim, stepSim, syncInputs, setPhase, botInput, netState };
});
