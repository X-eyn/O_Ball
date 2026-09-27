// Office Ball — shared game simulation.
// Runs authoritatively on the server; the browser loads it for constants only.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OB = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const C = {
    W: 1100, H: 680, FL: 70, FR: 1030, FT: 92, FB: 652,
    GH: 170, GD: 42, POST_R: 6, PR: 18, BR: 10,
    ACC: 0.5, FRIC: 0.89, BFRIC: 0.988, WALL_E: 0.75,
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

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // after halftime the teams switch ends: red attacks left, blue attacks right
  const attacksRight = (s, i) => (i === 0) !== !!s.swapped;
  const r1 = v => Math.round(v * 10) / 10;
  const r2 = v => Math.round(v * 100) / 100;

  function mkPlayer(i) {
    return {
      i, x: 0, y: 0, vx: 0, vy: 0, fx: i ? -1 : 1, fy: 0,
      ch: false, ct: 0, dashT: 0, dashCd: 0, dashHit: false, recover: 0, stun: 0,
      init: false, lastKp: 0, lastDc: 0, nc: 0, pk: null,
      st: { goals: 0, shots: 0, perfect: 0, tackles: 0, poss: 0 },
    };
  }

  // opts.solo: free practice for one player. No opponent, no clock, goals in either net count.
  function createSim(tick, opts = {}) {
    const s = {
      tick, players: [mkPlayer(0), mkPlayer(1)],
      ball: { x: C.CX, y: C.CY, vx: 0, vy: 0, spin: 0, hot: 0, last: -1 },
      score: [0, 0], time: C.MATCH_TICKS, sd: false, half: 1, swapped: false, solo: !!opts.solo,
      phase: 'kickoff', pt: 0, ps: tick, rf: 0, goalTick: -1,
      hitstop: 0, freeze: 0, winner: -1, events: [], ready: [false, false],
      bot: [{ hold: 0, dc: 0, aim: 0, aimT: 0 }, { hold: 0, dc: 0, aim: 0, aimT: 0 }],
    };
    resetKickoff(s);
    return s;
  }

  function setPhase(s, ph) { s.phase = ph; s.pt = 0; s.ps = s.tick; }
  function ev(s, type, o) { s.events.push(Object.assign({ type, tick: s.tick }, o)); }

  function resetKickoff(s) {
    s.players.forEach((p, i) => {
      const right = attacksRight(s, i);
      Object.assign(p, { vx: 0, vy: 0, ch: false, ct: 0, stun: 0, dashT: 0, recover: 0, fy: 0, x: right ? C.FL + 190 : C.FR - 190, y: C.CY, fx: right ? 1 : -1 });
    });
    if (s.solo) Object.assign(s.players[1], { x: -5000, y: -5000, off: true });
    Object.assign(s.ball, { x: C.CX, y: C.CY, vx: 0, vy: 0, spin: 0, hot: 0, last: -1 });
    setPhase(s, 'kickoff');
  }

  function syncInputs(s, inputs) {
    s.players.forEach((p, i) => {
      const inp = inputs[i];
      p.lastKp = inp.kp; p.lastDc = inp.dc; p.init = true;
      if (s.phase !== 'play' && s.phase !== 'goal') { p.ch = false; p.ct = 0; }
    });
  }

  // ---------- kicking ----------
  const inReach = (s, p) => Math.hypot(s.ball.x - p.x, s.ball.y - p.y) <= C.REACH;

  function kick(s, p, ct) {
    const b = s.ball;
    let tx = b.x - p.x, ty = b.y - p.y; const d = Math.hypot(tx, ty) || 1; tx /= d; ty /= d;
    let power, perfect = false;
    if (ct >= C.CHARGE_FULL && ct <= C.PERF_END) { power = 1.3; perfect = true; }
    else if (ct > C.PERF_END) power = 0.85;
    else power = 0.3 + 0.7 * Math.max(0, ct) / C.CHARGE_FULL;
    // aim where the player is facing/pointing (unless the ball is behind them)
    let nx, ny;
    if (tx * p.fx + ty * p.fy > -0.2) { nx = p.fx * 0.85 + tx * 0.15; ny = p.fy * 0.85 + ty * 0.15; } else { nx = tx; ny = ty; }
    let l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    // gentle aim assist on shots that are already roughly on target
    if (power > 0.6) {
      let gx = (attacksRight(s, p.i) ? C.FR : C.FL) - b.x, gy = C.CY - b.y; const gl = Math.hypot(gx, gy) || 1; gx /= gl; gy /= gl;
      if (nx * gx + ny * gy > 0.92) { nx = nx * 0.75 + gx * 0.25; ny = ny * 0.75 + gy * 0.25; l = Math.hypot(nx, ny); nx /= l; ny /= l; }
    }
    const sp = 5 + 12 * power;
    b.vx = nx * sp; b.vy = ny * sp;
    const lat = p.vx * -ny + p.vy * nx; // running one way while aiming another => curve
    b.spin = clamp(lat * 0.0034, -0.017, 0.017) * (power > 0.6 ? 1 : 0.5);
    b.hot = perfect ? 80 : 0; b.last = p.i;
    p.vx -= nx * 1.2; p.vy -= ny * 1.2; p.nc = 14;
    if (power > 0.6) p.st.shots++;
    if (perfect) { p.st.perfect++; s.hitstop = 5; }
    ev(s, 'kick', { p: p.i, x: r1(b.x), y: r1(b.y), perfect, power: r2(power), curve: Math.abs(b.spin) > 0.01 });
  }

  // ---------- physics ----------
  function stepPlayer(s, p, inp) {
    if (!p.init) { p.lastKp = inp.kp; p.lastDc = inp.dc; p.init = true; }
    if (p.dashCd > 0) p.dashCd--;
    if (p.recover > 0) p.recover--;
    if (p.nc > 0) p.nc--;

    // movement: analog (mouse / gamepad) or digital (keyboard)
    let ax, ay;
    if (inp.ax || inp.ay) { ax = inp.ax || 0; ay = inp.ay || 0; }
    else { ax = (inp.r ? 1 : 0) - (inp.l ? 1 : 0); ay = (inp.d ? 1 : 0) - (inp.u ? 1 : 0); }
    let m = Math.hypot(ax, ay);
    if (m > 1) { ax /= m; ay /= m; m = 1; }
    if (m > 0.12 && p.stun <= 0) { p.fx = ax / m; p.fy = ay / m; }

    const pressedNew = inp.kp !== p.lastKp;
    const tapped = pressedNew && !inp.k && !p.ch;
    p.lastKp = inp.kp;
    if (p.stun > 0) { p.ch = false; p.ct = 0; p.pk = null; }
    else {
      // buffered kick: released a moment early, fire as soon as the ball is in reach
      if (p.pk) {
        if (pressedNew) p.pk = null;
        else if (inReach(s, p)) { kick(s, p, p.pk.ct); p.pk = null; }
        else if (--p.pk.t <= 0) { if (p.pk.ct > 14) ev(s, 'whiff', { p: p.i, x: r1(p.x), y: r1(p.y) }); p.pk = null; }
      }
      if (inp.k) { if (!p.ch) { p.ch = true; p.ct = 0; } p.ct++; }
      else if (p.ch || tapped) {
        // client reports how long it actually held the key; trust it within a small tolerance
        const ct = typeof inp.kc === 'number' ? clamp(inp.kc, p.ct - 10, p.ct + 10) : p.ct;
        p.ch = false; p.ct = 0;
        if (inReach(s, p)) kick(s, p, ct); else p.pk = { ct, t: 22 };
      }
    }
    if (p.stun > 0) { p.stun--; ax = ay = 0; m = 0; }

    if (inp.dc !== p.lastDc) {
      p.lastDc = inp.dc;
      if (p.dashCd === 0 && p.stun === 0) {
        const dx = m > 0.12 ? ax / m : p.fx, dy = m > 0.12 ? ay / m : p.fy;
        p.vx = dx * C.DASH_SPEED; p.vy = dy * C.DASH_SPEED;
        p.dashT = C.DASH_T; p.dashCd = C.DASH_CD; p.dashHit = false;
        ev(s, 'dash', { p: p.i, x: r1(p.x), y: r1(p.y) });
      }
    }
    if (p.dashT > 0) {
      p.dashT--; p.vx *= 0.97; p.vy *= 0.97;
      if (p.dashT === 0 && !p.dashHit) { p.recover = 30; ev(s, 'dashmiss', { p: p.i, x: r1(p.x), y: r1(p.y) }); }
    } else {
      const a = C.ACC * (p.ch ? 0.62 : 1) * (p.recover > 0 ? 0.35 : 1);
      p.vx = (p.vx + ax * a) * C.FRIC; p.vy = (p.vy + ay * a) * C.FRIC;
    }
    p.x += p.vx; p.y += p.vy;
    if (p.x < C.FL + C.PR) { p.x = C.FL + C.PR; p.vx = 0; }
    if (p.x > C.FR - C.PR) { p.x = C.FR - C.PR; p.vx = 0; }
    if (p.y < C.FT + C.PR) { p.y = C.FT + C.PR; p.vy = 0; }
    if (p.y > C.FB - C.PR) { p.y = C.FB - C.PR; p.vy = 0; }
  }

  // ball control: a slow ball in front of a player sticks to their feet (dribbling / trapping).
  // Only the player best placed gets control; tackles and kicks break it.
  function control(s) {
    const b = s.ball;
    if (b.x < C.FL || b.x > C.FR) return;
    let best = null, bestD = 1e9;
    for (const p of s.players) {
      if (p.off || p.stun > 0 || p.dashT > 0 || p.nc > 0) continue;
      const dx = b.x - p.x, dy = b.y - p.y, d = Math.hypot(dx, dy) || 1;
      if (d > C.PR + C.BR + 12 || (dx * p.fx + dy * p.fy) / d < -0.45) continue;
      if (Math.hypot(b.vx - p.vx, b.vy - p.vy) > 8.5) continue;
      const fx = p.x + p.fx * (C.PR + C.BR + 2), fy = p.y + p.fy * (C.PR + C.BR + 2);
      const fd = Math.hypot(b.x - fx, b.y - fy);
      if (fd < bestD) { bestD = fd; best = { p, fx, fy }; }
    }
    if (!best) return;
    const { p, fx, fy } = best, k = p.ch ? 0.3 : 0.2;
    b.vx += (p.vx - b.vx) * k + (fx - b.x) * 0.09;
    b.vy += (p.vy - b.vy) * k + (fy - b.y) * 0.09;
    b.spin *= 0.8; b.last = p.i;
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
      atk.dashHit = true; vic.stun = 50; vic.ch = false; vic.ct = 0;
      vic.vx = nx * sg * 8; vic.vy = ny * sg * 8; atk.vx *= 0.3; atk.vy *= 0.3;
      atk.st.tackles++; s.hitstop = Math.max(s.hitstop, 3);
      ev(s, 'tackle', { p: atk.i, v: vic.i, x: r1(vic.x), y: r1(vic.y) });
      return;
    }
    const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (rel < 0) { const j = -1.3 * rel / 2; a.vx -= j * nx; a.vy -= j * ny; b.vx += j * nx; b.vy += j * ny; }
  }

  function collideBall(s, p) {
    const b = s.ball, dx = b.x - p.x, dy = b.y - p.y, d = Math.hypot(dx, dy), min = C.PR + C.BR;
    if (d >= min || d === 0) return;
    const nx = dx / d, ny = dy / d, ov = min - d;
    b.x += nx * ov * 0.85; b.y += ny * ov * 0.85; p.x -= nx * ov * 0.15; p.y -= ny * ov * 0.15;
    const rel = (b.vx - p.vx) * nx + (b.vy - p.vy) * ny;
    if (rel < 0) {
      const mb = 0.5, mp = 1, j = -1.3 * rel / (1 / mb + 1 / mp);
      b.vx += j / mb * nx; b.vy += j / mb * ny; p.vx -= j / mp * nx; p.vy -= j / mp * ny;
      b.spin *= 0.5; b.last = p.i;
    }
    if (p.dashT > 0 && !p.dashHit) p.dashHit = true; // poking the ball counts as a successful dash
  }

  function stepBall(s) {
    const b = s.ball;
    if (b.spin) {
      const c = Math.cos(b.spin), sn = Math.sin(b.spin), vx = b.vx * c - b.vy * sn;
      b.vy = b.vx * sn + b.vy * c; b.vx = vx; b.spin *= 0.985;
      if (Math.abs(b.spin) < 0.0005) b.spin = 0;
    }
    b.x += b.vx; b.y += b.vy; b.vx *= C.BFRIC; b.vy *= C.BFRIC;
    if (b.hot > 0) b.hot--;
    if (b.x < C.FL || b.x > C.FR) { // inside a goal net
      if (b.y < C.GY1 + C.BR) { b.y = C.GY1 + C.BR; b.vy = Math.abs(b.vy) * 0.3; }
      if (b.y > C.GY2 - C.BR) { b.y = C.GY2 - C.BR; b.vy = -Math.abs(b.vy) * 0.3; }
      if (b.x < C.FL - C.GD + C.BR) { b.x = C.FL - C.GD + C.BR; b.vx = Math.abs(b.vx) * 0.2; }
      if (b.x > C.FR + C.GD - C.BR) { b.x = C.FR + C.GD - C.BR; b.vx = -Math.abs(b.vx) * 0.2; }
      b.vx *= 0.95; b.vy *= 0.95; b.spin = 0;
    } else {
      const sp = Math.hypot(b.vx, b.vy);
      let hit = false;
      if (b.y < C.FT + C.BR) { b.y = C.FT + C.BR; b.vy = Math.abs(b.vy) * C.WALL_E; b.spin *= 0.3; hit = true; }
      if (b.y > C.FB - C.BR) { b.y = C.FB - C.BR; b.vy = -Math.abs(b.vy) * C.WALL_E; b.spin *= 0.3; hit = true; }
      if (!(b.y > C.GY1 && b.y < C.GY2)) {
        if (b.x < C.FL + C.BR) { b.x = C.FL + C.BR; b.vx = Math.abs(b.vx) * C.WALL_E; b.spin *= 0.3; hit = true; }
        if (b.x > C.FR - C.BR) { b.x = C.FR - C.BR; b.vx = -Math.abs(b.vx) * C.WALL_E; b.spin *= 0.3; hit = true; }
      }
      if (hit && sp > 8) ev(s, 'wall', { x: r1(b.x), y: r1(b.y), sp: r1(sp) });
    }
    for (const [px, py] of C.POSTS) {
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
    control(s);
    stepBall(s);
    if (s.phase === 'play') {
      const b = s.ball, [a, c] = s.players;
      const d0 = Math.hypot(b.x - a.x, b.y - a.y), d1 = Math.hypot(b.x - c.x, b.y - c.y);
      if (Math.min(d0, d1) < 70) s.players[d0 < d1 ? 0 : 1].st.poss++;
    }
  }

  // practice: R puts the ball at your feet
  function resetBallRequest(s, inp) {
    const rb = inp.rb | 0, p = s.players[0];
    if (s.lastRb === undefined) { s.lastRb = rb; return; }
    if (rb === s.lastRb) return;
    s.lastRb = rb;
    Object.assign(s.ball, { x: clamp(p.x + p.fx * 34, C.FL + C.BR + 2, C.FR - C.BR - 2), y: clamp(p.y + p.fy * 34, C.FT + C.BR + 2, C.FB - C.BR - 2), vx: 0, vy: 0, spin: 0, hot: 0 });
    ev(s, 'reset', { x: r1(s.ball.x), y: r1(s.ball.y) });
  }

  function scoreGoal(s, scorer) {
    if (s.solo) scorer = 0; // practice: both nets are yours
    s.score[scorer]++;
    const own = s.ball.last !== -1 && s.ball.last !== scorer;
    if (!own) s.players[scorer].st.goals++;
    s.goalTick = s.tick; s.hitstop = 6;
    if (!s.solo && (s.score[scorer] >= C.WIN_GOALS || s.sd)) s.winner = scorer;
    ev(s, 'goal', { scorer, own, x: r1(s.ball.x), y: r1(s.ball.y), score: s.score.slice(), final: s.winner >= 0 });
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
          if (b.x < C.FL - C.BR) scoreGoal(s, s.swapped ? 0 : 1);
          else if (b.x > C.FR + C.BR) scoreGoal(s, s.swapped ? 1 : 0);
          else if (s.solo) { /* no clock in practice */ }
          else if (!s.sd && s.half === 1 && --s.time <= C.MATCH_TICKS / 2) {
            s.half = 2; setPhase(s, 'half'); ev(s, 'half', { score: s.score.slice() });
          } else if (!s.sd && s.half === 2 && --s.time <= 0) {
            s.time = 0;
            if (s.score[0] !== s.score[1]) endMatch(s, s.score[0] > s.score[1] ? 0 : 1);
            else { s.sd = true; ev(s, 'sd'); }
          }
        } else if (++s.pt >= C.GOAL_T) {
          if (s.solo) resetKickoff(s); // no replays in practice, straight back to it
          else { setPhase(s, 'replay'); s.rf = s.goalTick - C.REPLAY_BEFORE; }
        }
        break;
      case 'half':
        syncInputs(s, inputs);
        if (++s.pt >= C.HALF_T) { s.swapped = true; resetKickoff(s); ev(s, 'secondhalf'); }
        break;
      case 'replay':
        syncInputs(s, inputs);
        s.pt++;
        if (s.pt >= C.REPLAY_T || (s.pt > 45 && kickPressed.some(Boolean))) {
          if (s.winner >= 0) endMatch(s, s.winner); else resetKickoff(s);
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
    if (--B.aimT <= 0) { B.aim = (Math.random() * 2 - 1) * 60; B.aimT = 90; }
    const gx = dir > 0 ? C.FR + 8 : C.FL - 8, gy = C.CY + B.aim, ownX = dir > 0 ? C.FL : C.FR;
    let ux = gx - ball.x, uy = gy - ball.y; const ug = Math.hypot(ux, uy) || 1; ux /= ug; uy /= ug;
    const bd = Math.hypot(ball.x - p.x, ball.y - p.y), od = Math.hypot(ball.x - o.x, ball.y - o.y);
    const side = (p.x - ball.x) * -ux + (p.y - ball.y) * -uy; // >0 => behind the ball
    let tx, ty;
    if (od < bd - 30 && (ball.x - C.CX) * dir < 150) {
      tx = ball.x + (ownX - ball.x) * 0.45; ty = ball.y + (C.CY - ball.y) * 0.45;
    } else if (side < C.PR) {
      const px = -uy, py = ux, sg = ((p.x - ball.x) * px + (p.y - ball.y) * py) > 0 ? 1 : -1;
      tx = ball.x - ux * 40 + px * sg * 48; ty = ball.y - uy * 40 + py * sg * 48;
    } else { tx = ball.x - ux * (C.PR + C.BR - 2); ty = ball.y - uy * (C.PR + C.BR - 2); }
    const mx = tx - p.x, my = ty - p.y;
    if (mx > 5) inp.r = 1; if (mx < -5) inp.l = 1; if (my > 5) inp.d = 1; if (my < -5) inp.u = 1;
    const aligned = side > 0 && ((ball.x - p.x) * ux + (ball.y - p.y) * uy) / Math.max(bd, 1) > 0.8;
    if (B.hold > 0) { inp.k = true; B.hold--; if (bd > C.REACH + 40) B.hold = 0; }
    else if (aligned && bd < C.REACH + 20 && Math.random() < 0.12) {
      const dg = Math.hypot(gx - ball.x, gy - ball.y);
      B.hold = dg < 420 ? C.CHARGE_FULL + ((Math.random() * 18) | 0) : 6 + ((Math.random() * 18) | 0);
      inp.k = true;
    }
    const pd = Math.hypot(o.x - p.x, o.y - p.y);
    if (od < C.REACH + 6 && pd < 110 && p.dashCd === 0 && Math.random() < 0.04) {
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
      b: [r1(b.x), r1(b.y), b.hot > 0 ? 1 : 0],
      p: s.players.map(p => [r1(p.x), r1(p.y), r2(p.fx), r2(p.fy), p.ch ? p.ct : -1,
        p.stun > 0 ? 1 : 0, p.dashT > 0 ? 1 : 0, p.dashCd, p.recover > 0 ? 1 : 0]),
    };
  }

  return { C, createSim, stepSim, syncInputs, setPhase, botInput, netState };
});
