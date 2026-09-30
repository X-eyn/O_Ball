'use strict';
// Office Ball — scenario matrix. ~75 scripted situations run against the real shared simulation,
// each asserting that the ball is CONTAINED at the feet (distance to the foot point, bearing in
// front of the stance, finite state). This is the harness that catches "the ball trails off
// diagonally", "the bot moves one way and the ball another", "shooting while running whiffs" and
// friends, deterministically and frame by frame.
//   node tools/scenarios_test.js
const OB = require('../shared/game.js');
const C = OB.C;
const TAU = Math.PI * 2;
const I = o => Object.assign({ u: 0, d: 0, l: 0, r: 0, k: false, kp: 0, kc: null, dc: 0, rb: 0, ax: 0, ay: 0, lob: false, sh: false, kn: 0 }, o);
const step = (s, a, b) => OB.stepSim(s, [I(a), I(b)]);
function fresh(opts) {
  const s = OB.createSim(0, opts || {});
  s.phase = 'play'; s.pt = 0; s.ps = 0; s.time = C.MATCH_TICKS;
  s.players.forEach(p => { p.touchCd = 0; p.recvT = 0; });
  return s;
}
const far = s => { const o = s.players[1]; o.x = C.FL + 30; o.y = C.FT + 30; o.vx = o.vy = 0; };
const at = (s, x, y, fx = 1, fy = 0) => { const p = s.players[0]; Object.assign(p, { x, y, fx, fy, cfx: fx, cfy: fy, vx: 0, vy: 0 }); return p; };
const ball = (s, x, y, vx = 0, vy = 0, z = 0, vz = 0) => Object.assign(s.ball, { x, y, vx, vy, z, vz, spin: 0, net: 0 });
// keeps the player in a box around the centre: the requested direction, except it turns back toward
// the middle when it strays too far (so scenarios test the ball, not the end boards)
const bounded = (fx, fy, spd = 1) => (t, sim) => {
  const p = sim.players[0];
  const m = Math.hypot(fx, fy) || 1;
  const outX = Math.abs(p.x - C.CX) > 250, outY = Math.abs(p.y - C.CY) > 190;
  const dx = outX ? Math.sign(C.CX - p.x) : fx / m, dy = outY ? Math.sign(C.CY - p.y) : fy / m;
  return { ax: dx * spd, ay: dy * spd };
};
function footOf(p) {
  const fwd = C.FOOT_BASE + C.FOOT_SWING * Math.max(0, Math.sin(p.ph));
  return { x: p.x + p.cfx * fwd - p.cfy * p.sf * C.FOOT_SIDE, y: p.y + p.cfy * fwd + p.cfx * p.sf * C.FOOT_SIDE };
}
function bearingDeg(s, p) {
  let a = Math.atan2(s.ball.x - p.x, s.ball.y - p.y) - Math.atan2(p.cfx, p.cfy);
  a = Math.atan2(Math.sin(a), Math.cos(a));
  return Math.abs(a) * 180 / Math.PI;
}
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)))]; };

let pass = 0, fail = 0;
function report(name, r, tr) {
  if (r.ok) { pass++; console.log('  ok   ' + name.padEnd(46) + ' ' + r.note); }
  else { fail++; console.log('  FAIL ' + name.padEnd(46) + ' ' + r.note); }
}
// one scenario: set up, run, and collect foot-distance / bearing / event traces
function scenario(name, { setup, input, ticks = 240, warm = 60, check }) {
  const s = fresh();
  setup(s);
  const p = s.players[0];
  const tr = { footD: [], bear: [], near: [], nan: false, ev: {}, last: null, byType: {}, maxAdvance: 0, minAdvance: 1e9 };
  for (let t = 0; t < ticks; t++) {
    const inp = (input ? input(t, s) : {}) || {};
    step(s, inp, inp.o || {});
    for (const e of s.events) {
      tr.ev[e.type] = (tr.ev[e.type] || 0) + 1;
      const info = { type: e.type, x: s.ball.x, y: s.ball.y, z: s.ball.z, vx: s.ball.vx, vy: s.ball.vy, vz: s.ball.vz, f: e.f };
      tr.last = info;
      tr.byType = tr.byType || {};
      tr.byType[e.type] = info;
    }
    s.events.length = 0;
    const vals = [s.ball.x, s.ball.y, s.ball.z, s.ball.vx, s.ball.vy, p.x, p.y, p.vx, p.vy, p.cfx, p.cfy, p.ph];
    if (!vals.every(Number.isFinite)) tr.nan = true;
    if (t >= warm) {
      const f = footOf(p);
      tr.footD.push(Math.hypot(s.ball.x - f.x, s.ball.y - f.y));
      tr.bear.push(bearingDeg(s, p));
    }
  }
  report(name, check(s, tr, p), tr);
}
// the containment assertion used by most cases. `tail` judges only the settled window (the last N
// samples); without it, the whole run (steady containment must hold every frame).
const contained = (s, tr, opts = {}) => {
  const o = Object.assign({ p95: 18, max: 30, bear: 85, end: 16, tail: 0 }, opts);
  if (tr.nan) return { ok: false, note: 'nan in state' };
  if (!tr.footD.length) return { ok: false, note: 'no samples' };
  const D = o.tail ? tr.footD.slice(-o.tail) : tr.footD, B = o.tail ? tr.bear.slice(-o.tail) : tr.bear;
  const d95 = pct(D, 0.9), dmax = Math.max(...D), bmax = Math.max(...B), last = D[D.length - 1];
  return {
    ok: d95 <= o.p95 && dmax <= o.max && bmax <= o.bear && last <= o.end,
    note: `foot p90 ${d95.toFixed(0)} max ${dmax.toFixed(0)} · bear ${bmax.toFixed(0)}° · end ${last.toFixed(0)}${o.tail ? ' (settled)' : ''}`,
  };
};

console.log('\nA. containment: 8 directions x 3 paces (24)');
{
  const speeds = [['walk', 0.45], ['jog', 0.7], ['sprint', 1.0]];
  for (let k = 0; k < 8; k++) {
    const a = k * TAU / 8, dx = Math.cos(a), dy = Math.sin(a);
    for (const [label, spd] of speeds) {
      scenario(`run ${label} @ ${k * 45}°`, {
        setup: s => { far(s); const p = at(s, C.CX - 200, C.CY, dx, dy); ball(s, p.x + 22 * dx, p.y + 22 * dy); },
        input: bounded(dx, dy, spd),
        check: (s, tr) => contained(s, tr, label === 'sprint'
          ? { p95: 26, max: 40, bear: 90, end: 20 }
          : { p95: 18, max: 30, bear: 85, end: 14 }),
      });
    }
  }
}

console.log('\nB. turning with the ball (8)');
{
  const turns = [
    ['reverse 180°', (t, s) => bounded(t < 60 ? 1 : -1, 0)(t, s)],
    ['90° left', (t, s) => bounded(t < 60 ? 1 : 0, t < 60 ? 0 : -1)(t, s)],
    ['90° right', (t, s) => bounded(t < 60 ? 1 : 0, t < 60 ? 0 : 1)(t, s)],
    ['circle right', (t, s) => { const a = t * 0.05; return bounded(Math.cos(a), Math.sin(a), 0.85)(t, s); }],
    ['circle left', (t, s) => { const a = -t * 0.05; return bounded(Math.cos(a), Math.sin(a), 0.85)(t, s); }],
    ['zigzag', (t, s) => bounded(1, (t % 40 < 20 ? 1 : -1) * 0.7)(t, s)],
    ['sprint then reverse', (t, s) => bounded(t < 60 ? 1 : -1, 0)(t, s)],
    ['turn then stop', (t, s) => t < 60 ? bounded(1, 0)(t, s) : t < 100 ? bounded(0, -1)(t, s) : {}],
  ];
  for (const [name, input] of turns) {
    scenario(name, {
      setup: s => { far(s); const p = at(s, C.CX - 300, C.CY, 1, 0); ball(s, p.x + 22, p.y); },
      input,
      ticks: 300, warm: 130,
      check: (s, tr) => contained(s, tr, { p95: 22, max: 40, bear: 95, end: 18, tail: 80 }),
    });
  }
}

console.log('\nC. ball starting states, standing or walking (10)');
{
  const cases = [
    ['ball 30 ahead', s => { const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x + 30, p.y); }, {}],
    ['ball 30 behind', s => { const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x - 30, p.y); }, {}],
    ['ball 25 left', s => { const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x, p.y - 25); }, {}],
    ['ball 25 right', s => { const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x, p.y + 25); }, {}],
    ['ball ahead-left', s => { const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x + 26, p.y - 26); }, {}],
    ['ball ahead-right', s => { const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x + 26, p.y + 26); }, {}],
    ['ball rolling in 3', s => { const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x + 50, p.y, -3, 0); }, {}],
    ['ball rolling in 5', s => { const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x + 50, p.y, -5, 0); }, {}],
    ['ball rolling away 2', s => { const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x + 24, p.y, 2, 0); }, {}],
    ['ball bouncing (drop)', s => { const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x + 20, p.y, 0, 0, 14, -2); }, {}],
  ];
  for (const [name, setup, input] of cases) {
    scenario(name, { setup: s => { far(s); setup(s); }, input: () => ({}), ticks: 220, warm: 150, check: (s, tr) => contained(s, tr, { p95: 16, max: 28, bear: 70, end: 12 }) });
  }
}
{
  const cases = [
    ['walk to a ball 30 behind', s => { const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x - 30, p.y); }, (t, s) => bounded(0.5, 0)(t, s)],
    ['jog to a ball 40 ahead-left', s => { const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x + 40, p.y - 25); }, (t, s) => bounded(0.7, 0)(t, s)],
    ['collect while turning', s => { const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x + 36, p.y + 20); }, (t, s) => bounded(0.8, t < 60 ? 0.4 : -0.4)(t, s)],
  ];
  for (const [name, setup, input] of cases) {
    scenario(name, { setup: s => { far(s); setup(s); }, input, ticks: 260, warm: 140, check: (s, tr) => contained(s, tr, { p95: 20, max: 34, bear: 90, end: 16, tail: 70 }) });
  }
}

console.log('\nD. action states (12)');
{
  scenario('charging draws the ball in', {
    setup: s => { far(s); const p = at(s, C.CX - 200, C.CY, 1, 0); ball(s, p.x + 40, p.y); },
    input: t => ({ ax: t < 60 ? 1 : 0, k: t >= 60, kp: t >= 60 ? 1 : 0 }),
    check: (s, tr) => contained(s, tr, { p95: 16, max: 28, bear: 60, end: 12, tail: 80 }),
  });
  scenario('charge + release while running strikes', {
    setup: s => { far(s); const p = at(s, C.CX - 300, C.CY, 1, 0); ball(s, p.x + 22, p.y); },
    input: t => ({ ax: 1, k: t >= 60 && t < 100, kp: t === 60 || t === 100 ? 1 : 0 }),
    check: (s, tr) => ({ ok: !tr.nan && (tr.ev.kick || 0) >= 1, note: `kicks ${tr.ev.kick || 0}, p95 ${pct(tr.footD, 0.95).toFixed(0)}` }),
  });
  scenario('shielding holds the ball', {
    setup: s => { far(s); const p = at(s, C.CX - 200, C.CY, 1, 0); ball(s, p.x + 22, p.y); },
    input: () => ({ ax: 1, sh: true }),
    check: (s, tr) => contained(s, tr, { p95: 18, max: 30, bear: 70, end: 14 }),
  });
  scenario('shield while static', {
    setup: s => { far(s); const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x + 24, p.y); },
    input: () => ({ sh: true }),
    check: (s, tr) => contained(s, tr, { p95: 18, max: 30, bear: 70, end: 14 }),
  });
  scenario('pressed from the front (still contained)', {
    setup: s => { const p = at(s, C.CX - 200, C.CY, 1, 0); const o = s.players[1]; o.x = p.x + 60; o.y = p.y; o.vx = -1; o.vy = 0; ball(s, p.x + 22, p.y); },
    input: () => ({ ax: 0.7 }),
    check: (s, tr) => contained(s, tr, { p95: 22, max: 44, bear: 120, end: 18, tail: 90 }),
  });
  scenario('pressed from behind (no phantom loss)', {
    setup: s => { const p = at(s, C.CX - 200, C.CY, 1, 0); const o = s.players[1]; o.x = p.x - 60; o.y = p.y; o.vx = 1; o.vy = 0; ball(s, p.x + 22, p.y); },
    input: () => ({ ax: 0.7 }),
    check: (s, tr) => contained(s, tr, { p95: 18, max: 30, bear: 85, end: 16, tail: 90 }),
  });
  scenario('stunned: containment off', {
    setup: s => { far(s); const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x + 22, p.y); p.stun = 50; },
    input: () => ({}),
    check: (s, tr) => ({ ok: !tr.nan && s.players[0].stun === 0, note: `stun ran out, ball ${Math.hypot(s.ball.x - s.players[0].x, s.ball.y - s.players[0].y).toFixed(0)}px` }),
  });
  scenario('kick: the ball escapes and is not re-grabbed', {
    setup: s => { far(s); const p = at(s, C.CX - 200, C.CY, 1, 0); ball(s, p.x + 22, p.y); },
    input: t => ({ k: t >= 40 && t < 80, kp: t === 40 || t === 80 ? 1 : 0 }),
    ticks: 200,
    check: (s, tr) => ({ ok: !tr.nan && (tr.ev.kick || 0) === 1 && Math.hypot(s.ball.x - s.players[0].x, s.ball.y - s.players[0].y) > 60, note: `kicks ${tr.ev.kick || 0}, ball ${Math.hypot(s.ball.x - s.players[0].x, s.ball.y - s.players[0].y).toFixed(0)}px away` }),
  });
  scenario('knock-on then recollect', {
    setup: s => { far(s); const p = at(s, C.CX - 300, C.CY, 1, 0); ball(s, p.x + 22, p.y); },
    input: (t, s) => Object.assign(bounded(1, 0)(t, s), { kn: t === 40 ? 1 : 0 }),
    ticks: 320, warm: 140,
    check: (s, tr) => contained(s, tr, { p95: 24, max: 46, bear: 110, end: 18, tail: 70 }),
  });
  scenario('dash poke: ball squirts, then contained', {
    setup: s => { far(s); const p = at(s, C.CX - 300, C.CY, 1, 0); ball(s, p.x + 24, p.y); },
    input: (t, s) => Object.assign(bounded(1, 0)(t, s), { dc: t === 40 ? 1 : 0 }),
    ticks: 340, warm: 150,
    check: (s, tr) => contained(s, tr, { p95: 30, max: 60, bear: 140, end: 22, tail: 100 }),
  });
  scenario('receive a clean pass at speed', {
    setup: s => { far(s); const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x + 60, p.y, -12, 0); },
    input: () => ({}),
    ticks: 220, warm: 150,
    check: (s, tr) => contained(s, tr, { p95: 16, max: 28, bear: 70, end: 12 }),
  });
  scenario('sprint onto a rolling ball', {
    setup: s => { far(s); const p = at(s, C.CX - 250, C.CY, 1, 0); ball(s, p.x + 90, p.y, 2.5, 0); },
    input: (t, s) => bounded(1, 0)(t, s),
    ticks: 300, warm: 160,
    check: (s, tr) => contained(s, tr, { p95: 24, max: 40, bear: 95, end: 18, tail: 80 }),
  });
}

console.log('\nE. height bands and receiving (8)');
{
  scenario('clean front receive is clean', {
    setup: s => { far(s); const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x + 60, p.y, -12, 0); },
    input: () => ({}),
    check: (s, tr) => ({ ok: !tr.nan && tr.ev.trap === 1, note: `traps ${tr.ev.trap}` }),
  });
  scenario('receive from behind spills', {
    setup: s => { far(s); const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x - 60, p.y, 12, 0); },
    input: () => ({}),
    check: (s, tr) => ({ ok: !tr.nan && tr.ev.trap === 1, note: `traps ${tr.ev.trap}` }),
  });
  scenario('chest control drops the ball', {
    setup: s => { far(s); const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x + 10, p.y, 0, 0, 20, -1); },
    input: () => ({}),
    check: (s, tr) => ({ ok: !tr.nan && s.ball.z < 3, note: `z ${s.ball.z.toFixed(1)}` }),
  });
  scenario('header from a high drop', {
    setup: s => { far(s); const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x + 8, p.y, -3, 0, 40, -2); },
    input: () => ({}),
    check: (s, tr) => {
      const h = tr.byType.header || null;
      return { ok: !tr.nan && (tr.ev.header || 0) === 1 && h && Math.hypot(h.vx, h.vy) > 1.5, note: `headers ${tr.ev.header || 0}, v ${h ? Math.hypot(h.vx, h.vy).toFixed(1) : '-'}` };
    },
  });
  scenario('ball above head passes over', {
    setup: s => { far(s); const p = at(s, C.CX, C.CY, 1, 0); ball(s, p.x - 80, p.y, 10, 0, 60, 3); },
    input: () => ({}),
    check: (s, tr) => ({ ok: !tr.nan && (tr.ev.trap || 0) === 0 && (tr.ev.header || 0) === 0, note: 'no contact' }),
  });
  scenario('volley a dropping ball', {
    setup: s => { far(s); const p = at(s, C.CX - 200, C.CY, 1, 0); ball(s, p.x + 24, p.y, 0, 0, 12, -1); },
    input: t => ({ k: t >= 30 && t < 70, kp: t === 30 || t === 70 ? 1 : 0 }),
    check: (s, tr) => ({ ok: !tr.nan && (tr.ev.kick || 0) === 1, note: `kicks ${tr.ev.kick || 0}` }),
  });
  scenario('receive while walking', {
    setup: s => { far(s); const p = at(s, C.CX - 200, C.CY, 1, 0); ball(s, p.x + 60, p.y, -10, 0); },
    input: () => ({ ax: 0.4 }),
    ticks: 220, warm: 120,
    check: (s, tr) => contained(s, tr, { p95: 26, max: 40, bear: 95, end: 20 }),
  });
  scenario('trap then kept at the feet', {
    setup: s => { far(s); const p = at(s, C.CX - 200, C.CY, 1, 0); ball(s, p.x + 70, p.y, -11, 0); },
    input: () => ({ ax: 0.3 }),
    ticks: 260, warm: 150,
    check: (s, tr) => {
      const c = contained(s, tr, { p95: 18, max: 30, bear: 80, end: 14 });
      return { ok: !tr.nan && (tr.ev.trap || 0) >= 1 && c.ok, note: `traps ${tr.ev.trap || 0}, ${c.note}` };
    },
  });
}

console.log('\nF. kicks, knocks, chipping (8)');
{
  const kickCase = (name, { charge, run, weak, expect }) => scenario(name, {
    setup: s => { far(s); const p = at(s, C.CX - 300, C.CY, 1, 0); if (weak) p.sf = -1; ball(s, p.x + 24, p.y + (weak ? -18 : 18)); },
    input: t => ({ ax: run ? 1 : 0, k: t >= 40 && t < 40 + charge, kp: t === 40 || t === 40 + charge ? 1 : 0 }),
    check: (s, tr) => ({ ok: !tr.nan && (tr.ev.kick || 0) === expect, note: `kicks ${tr.ev.kick || 0}/${expect}, ball ${Math.hypot(s.ball.x - s.players[0].x, s.ball.y - s.players[0].y).toFixed(0)}px` }),
  });
  kickCase('stationary perfect charge strikes', { charge: 42, run: false, weak: false, expect: 1 });
  kickCase('running full charge strikes', { charge: 42, run: true, weak: false, expect: 1 });
  kickCase('running quick tap strikes', { charge: 6, run: true, weak: false, expect: 1 });
  kickCase('strong foot short charge', { charge: 6, run: false, weak: false, expect: 1 });
  kickCase('weak foot short charge', { charge: 6, run: false, weak: true, expect: 1 });
  scenario('chip over the top', {
    setup: s => { far(s); const p = at(s, C.CX - 300, C.CY, 1, 0); ball(s, p.x + 24, p.y); },
    input: t => ({ k: t >= 40 && t < 80, lob: t >= 40 && t < 80, kp: t === 40 || t === 80 ? 1 : 0 }),
    check: (s, tr) => {
      const k = tr.byType.kick || null;
      return { ok: !tr.nan && (tr.ev.kick || 0) === 1 && k && k.vz > 2, note: `kick vz ${k ? k.vz.toFixed(1) : '-'}` };
    },
  });
  scenario('kick then recollect the parry', {
    setup: s => { far(s); const p = at(s, C.CX - 120, C.CY, 1, 0); ball(s, p.x + 24, p.y); },
    input: t => ({ ax: 1, k: t >= 30 && t < 60, kp: t === 30 || t === 60 ? 1 : 0 }),
    ticks: 320, warm: 200,
    check: (s, tr) => ({ ok: !tr.nan && (tr.ev.kick || 0) >= 1 && tr.footD[tr.footD.length - 1] < 60, note: `kicks ${tr.ev.kick || 0}, end foot ${tr.footD.length ? tr.footD[tr.footD.length - 1].toFixed(0) : '-'}` }),
  });
  scenario('two touches while dribbling', {
    setup: s => { far(s); const p = at(s, C.CX - 300, C.CY, 1, 0); ball(s, p.x + 22, p.y); },
    input: () => ({ ax: 0.6 }),
    ticks: 300, warm: 120,
    check: (s, tr) => contained(s, tr, { p95: 20, max: 34, bear: 80, end: 16 }),
  });
}

console.log('\nG. edges (7)');
{
  scenario('containment along the top wall', {
    setup: s => { far(s); const p = at(s, C.CX, C.FT + C.PR + 2, 1, 0); ball(s, p.x + 22, p.y); },
    input: (t, s) => bounded(t < 60 ? 0.6 : -0.6, -0.6)(t, s),
    ticks: 300, warm: 140,
    check: (s, tr) => contained(s, tr, { p95: 34, max: 46, bear: 130, end: 30, tail: 80 }),
  });
  scenario('containment along the bottom wall', {
    setup: s => { far(s); const p = at(s, C.CX, C.FB - C.PR - 2, 1, 0); ball(s, p.x + 22, p.y); },
    input: (t, s) => bounded(t < 60 ? 0.6 : -0.6, 0.6)(t, s),
    ticks: 300, warm: 140,
    check: (s, tr) => contained(s, tr, { p95: 34, max: 46, bear: 130, end: 30, tail: 80 }),
  });
  scenario('ball near the corner, player walks over', {
    setup: s => { far(s); s.players[1].x = C.FR - 40; s.players[1].y = C.FB - 40; const p = at(s, C.FL + 220, C.FT + 150, 1, 0); ball(s, C.FL + 80, C.FT + 70); },
    input: t => t < 90 ? { ax: -0.7, ay: -0.6 } : { ax: 0.7, ay: 0.6 }, // collect toward the corner, then walk away with it
    ticks: 300, warm: 190,
    check: (s, tr) => contained(s, tr, { p95: 24, max: 40, bear: 120, end: 20, tail: 70 }),
  });
  scenario('kickoff to play transition stays finite', {
    setup: s => { far(s); },
    input: () => ({ ax: 0.5 }),
    ticks: 200, warm: 120,
    check: (s, tr) => contained(s, tr, { p95: 40, max: 160, bear: 180, end: 60 }),
  });
  scenario('solo practice containment', {
    setup: s => { const t = fresh({ solo: true }); Object.assign(s, t); far(s); const p = at(s, C.CX - 200, C.CY, 1, 0); ball(s, p.x + 22, p.y); },
    input: (t, s) => bounded(0.8, 0)(t, s),
    ticks: 280, warm: 150,
    check: (s, tr) => contained(s, tr, { p95: 22, max: 36, bear: 85, end: 24, tail: 70 }),
  });
  scenario('ball beside the goal mouth', {
    setup: s => { far(s); const p = at(s, C.FL + 90, C.CY + 40, 1, 0); ball(s, C.FL + 40, C.CY + 40); },
    input: () => ({ ax: -0.6 }),
    ticks: 280, warm: 150,
    check: (s, tr) => contained(s, tr, { p95: 24, max: 40, bear: 110, end: 20, tail: 80 }),
  });
  scenario('determinism of a dribbling run', {
    setup: s => { far(s); const p = at(s, C.CX - 300, C.CY, 1, 0); ball(s, p.x + 22, p.y); },
    input: t => ({ ax: 0.8, ay: Math.sin(t / 30) * 0.5, kn: t === 100 ? 1 : 0 }),
    ticks: 200, warm: 0,
    check: (s, tr, p) => ({ ok: !tr.nan && true, note: `end ball ${s.ball.x.toFixed(2)},${s.ball.y.toFixed(2)}`, _end: [s.ball.x, s.ball.y, p.x, p.y] }),
  });
}

console.log(`\n${pass} passed, ${fail} failed  (${pass + fail} scenarios)\n`);
process.exit(fail ? 1 : 0);
