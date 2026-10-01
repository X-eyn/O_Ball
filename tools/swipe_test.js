'use strict';
// Office Badminton — swipe controls harness. A shot is a two-finger swipe: the browser grades its
// timing against contactPlan and sends the grade, intensity, direction and the tick the player
// was looking at; the sim rewinds to that tick, strikes, and flies the shot forward to now.
// Asserts: the shot each swipe makes, timing grades (perfect is perfect, a miss is a miss), that a
// swipe arriving late (as over a network) plays where it was seen, smash defence, serves, swipes
// in a hit-stop, the ready-up, magnetic steering, and full matches against the bot.
//   node tools/swipe_test.js
let seed = 777;
Math.random = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822507) ^ Math.imul(seed ^ (seed >>> 13), 3266489909)) >>> 0) / 4294967296;
const BM = require('../shared/badminton.js');
const C = BM.C, S = C.S, SHOTS = BM.SHOTS;
const I = o => Object.assign({ u: 0, d: 0, l: 0, r: 0, k: false, kp: 0, kc: null, dc: 0, dv: 0, sp: false, jp: 0, ax: 0, ay: 0, lob: false, sh: false, kn: 0, rb: 0, sw: 0 }, o);
let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok   ' + msg); } else { fails++; console.log('  FAIL ' + msg); } };
const finite = s => [s.ball.x, s.ball.y, s.ball.z, s.ball.vx, s.ball.vy, s.ball.vz, ...s.players.flatMap(p => [p.x, p.y, p.z, p.vx, p.vy, p.stamina])].every(Number.isFinite);

// a live rally: player 1 has just struck `kind` to land at (tx, ty) on player 0's side
function incoming(o) {
  const s = BM.createSim(0, {});
  s.phase = 'rally'; s.pt = 0; s.serveHold = false; s.players.forEach(p => { p.init = true; });
  const p = s.players[0];
  Object.assign(p, { x: o.px != null ? o.px : -3.6 * S, y: o.py || 0, fx: 1, fy: 0 });
  Object.assign(s.players[1], { x: 3.4 * S, y: 0 });
  const from = { x: 3 * S, y: o.fy || 0, z: o.fz || 1 }, sh = SHOTS[o.kind];
  const r = sh.ang != null ? BM._launch(from, o.tx, o.ty || 0, sh, 1) : BM._launchAngle(from, o.tx, o.ty || 0, sh.cap, -42, -6);
  Object.assign(s.ball, from, { vx: r.lv.vx, vy: r.lv.vy, vz: r.lv.vz, last: 1 });
  s.lastHitter = 1; s.lastKind = o.lastKind || o.kind; s.rally = 1; s.events.length = 0;
  // stand where the steering would take the player (unless the test says where)
  if (o.place !== false) { const m = BM.meetTarget(s, p); if (m) { p.x = m.x; p.y = m.y; } }
  return s;
}
// play it: player 0 swipes when the shuttle is best met (plus `off` ticks), the swipe reaching the
// sim `lag` ticks later, as it would over a network. Returns player 0's hit (or swing) and events.
function play(s, sw = {}, o = {}) {
  const lag = o.lag != null ? o.lag : 8, off = o.off || 0, ev = [];
  let n = 0, svt = null, sendAt = null;
  for (let t = 0; t < 500; t++) {
    const me = s.players[0];
    if (svt == null && s.ball.last === 1) {
      const plan = BM.contactPlan(s.ball, me);
      if (plan && plan.k <= 1) { svt = s.tick + plan.k + off; sendAt = svt + lag; }
    }
    if (sendAt != null && s.tick + 1 >= sendAt && !n) n = 1;
    const inp = Object.assign({ swm: 1 }, n ? Object.assign({ sw: 1, sg: 0, si: 0.9, sd: false, sl: 0, svt }, sw) : {});
    BM.stepSim(s, [I(inp), I({})]);
    for (const e of s.events) ev.push(e);
    s.events.length = 0;
    if (ev.some(e => e.p === 0 && (e.type === 'hit' || e.type === 'swing')) && !o.full) break;
    if (s.phase === 'point' || s.phase === 'over') break;
  }
  return { hit: ev.find(e => e.type === 'hit' && e.p === 0), swing: ev.find(e => e.type === 'swing' && e.p === 0), ev, svt };
}
const lift = () => incoming({ kind: 'lift', tx: -2.5 * S, ty: 0.6, px: -3.4 * S });
const drop = () => incoming({ kind: 'drop', fz: 2.6, tx: -1.3 * S, ty: -0.5, px: -2.0 * S, py: -0.9 });
const clear = () => incoming({ kind: 'clear', tx: -5.4 * S, ty: 0.6, px: -6.5 * S, py: 1.0 });

console.log('\nthe contact plan');
{
  const s = lift(), me = s.players[0];
  const plan = BM.contactPlan(s.ball, me);
  ok(plan && plan.k > 20 && plan.q > 0.7, `a lift to where the player stands has a contact ahead (in ${plan && plan.k} ticks, quality ${plan && plan.q.toFixed(2)})`);
  const far = incoming({ kind: 'lift', tx: -2.5 * S, ty: 0.6, px: -6.5 * S, py: 3, place: false });
  ok(!BM.contactPlan(far.ball, far.players[0]), 'none when the shuttle never comes within reach');
}

console.log('\nwhat a swipe makes');
{
  let r = play(lift(), { si: 0.95 });
  ok(r.hit && r.hit.kind === 'smash', `a fierce swipe on a high shuttle: smash (${r.hit && r.hit.kind})`);
  ok(r.hit && r.hit.perfect === 1 && r.hit.g === 0, 'a perfect swipe is a perfect strike');
  r = play(lift(), { si: 0.1 });
  ok(r.hit && r.hit.kind === 'drop', `a gentle swipe on a high shuttle: drop (${r.hit && r.hit.kind})`);
  r = play(lift(), { si: 0.55 });
  ok(r.hit && r.hit.kind === 'drive', `a medium swipe on a high shuttle: drive (${r.hit && r.hit.kind})`);
  r = play(lift(), { si: 0.6, sd: true });
  ok(r.hit && r.hit.kind === 'clear', `a downward swipe: clear (${r.hit && r.hit.kind})`);
  r = play(drop(), { si: 0.1 });
  ok(r.hit && r.hit.kind === 'net', `a gentle swipe on a low drop: net shot (${r.hit && r.hit.kind})`);
  r = play(drop(), { si: 0.6, sd: true });
  ok(r.hit && r.hit.kind === 'lift', `a downward swipe on a low drop: lift (${r.hit && r.hit.kind})`);
}

console.log('\ntiming');
{
  const g = grade => play(lift(), { si: 0.95, sg: grade }).hit;
  const p0 = g(0), p1 = g(1), p2 = g(2), p3 = g(3);
  ok(p0 && p1 && p2 && p3, 'perfect, great, good and early/late all connect');
  ok(p0.perfect && !p1.perfect && !p2.perfect && !p3.perfect, 'only perfect is perfect');
  ok(p0.q > p1.q && p1.q > p2.q && p2.q > p3.q, `contact falls with the grade (q ${[p0, p1, p2, p3].map(h => h.q).join(' > ')})`);
  ok(p0.v > p2.v, `a perfect smash is faster than a good one (${p0.kmh} vs ${p2.kmh} km/h)`);
  const miss = play(lift(), { sg: 4 });
  ok(!miss.hit && miss.swing, 'a miss is a swing at air');
}

console.log('\nrewind: a swipe plays where the player saw the shuttle');
{
  const outs = [];
  for (const lag of [0, 4, 10, 18]) {
    const s = lift(), r = play(s, { si: 0.95 }, { lag, full: true });
    const pt = r.ev.find(e => e.type === 'point');
    outs.push({ lag, hit: r.hit, land: pt });
  }
  ok(outs.every(o => o.hit && o.hit.kind === 'smash'), `struck alike whether the swipe arrives at once or 18 ticks late (${outs.map(o => o.hit && o.hit.kind).join(', ')})`);
  const xs = outs.map(o => o.hit.x), ys = outs.map(o => o.hit.y);
  ok(Math.max(...xs) - Math.min(...xs) < 0.05 && Math.max(...ys) - Math.min(...ys) < 0.05, 'met at the same point every time');
  ok(outs.every(o => o.land && o.land.p === 0), `and the smashes win the point (${outs.map(o => o.land && o.land.reason).join(', ')})`);
  // too late even for the rewind (the shuttle long gone): nothing
  const s = lift(); const r = play(s, { si: 0.95 }, { lag: BM.SWIPE.REWIND + 12 });
  ok(!r.hit, 'a swipe older than the rewind window cannot reach back');
  // a swipe timed for a moment the shuttle is nowhere near: a swing at air
  const s2 = lift(); const r2 = play(s2, { si: 0.95 }, { off: -40, lag: 2 });
  ok(!r2.hit && r2.swing, 'a swipe far too early is a swing at air');
}

console.log('\ndefending a smash');
{
  const smash = () => incoming({ kind: 'smash', fz: 2.6, tx: -4.4 * S, ty: 0.5, px: -3.6 * S, py: 0.2 });
  let r = play(smash(), { si: 0.8, sg: 1 });
  ok(r.hit && r.hit.kind === 'counter', `a firm swipe against a smash: counter (${r.hit && r.hit.kind})`);
  r = play(smash(), { si: 0.8, sg: 0 });
  ok(r.hit && r.hit.parry === 1, `a perfect one: parry (${r.hit && (r.hit.parry ? 'parry' : r.hit.kind)})`);
  r = play(smash(), { si: 0.1, sg: 1 });
  ok(r.hit && r.hit.kind === 'block', `a gentle one: block (${r.hit && r.hit.kind})`);
  r = play(smash(), { si: 0.6, sd: true, sg: 1 });
  ok(r.hit && r.hit.kind === 'lift', `a downward one: lift (${r.hit && r.hit.kind})`);
}

console.log('\naim');
{
  const sides = [];
  for (const sl of [-1, 1]) for (let n = 0; n < 5; n++) {
    const r = play(clear(), { si: 0.6, sd: true, sl, sg: 0 }, { full: true });
    const pt = r.ev.find(e => e.type === 'point');
    if (pt && r.hit) sides.push(Math.sign(pt.y) === Math.sign(sl));
  }
  ok(sides.length >= 8 && sides.filter(Boolean).length >= sides.length - 1, `angling the swipe angles the shot (${sides.filter(Boolean).length}/${sides.length} on the side swiped)`);
}

console.log('\nserve');
{
  const serve = si => {
    const s = BM.createSim(0, {});
    for (let t = 0; t <= C.PRE_T + 5; t++) BM.stepSim(s, [I({}), I({})]);
    let hit = null;
    for (let t = 0; t < 30 && !hit; t++) { BM.stepSim(s, [I(t > 10 ? { sw: 1, si, sg: 4 } : {}), I({})]); hit = s.events.find(e => e.type === 'hit'); s.events.length = 0; }
    return hit;
  };
  ok((serve(0.2) || {}).kind === 'servel', 'a gentle swipe serves low');
  ok((serve(0.9) || {}).kind === 'serveh', 'a fierce swipe serves high');
}

console.log('\nhit-stop, ready-up');
{
  const s = lift();
  s.hitstop = 6; // a big contact froze the game just as the player swiped
  const r = play(s, { si: 0.95 }, { lag: 2 });
  ok(r.hit, 'a swipe made during a hit-stop is played once it ends');
  const o = BM.createSim(0, {}); BM.setPhase(o, 'over'); o.players.forEach(p => { p.init = true; });
  BM.stepSim(o, [I({ sw: 0 }), I({})]); BM.stepSim(o, [I({ sw: 1 }), I({})]);
  ok(o.ready[0], 'a swipe readies up after a match');
}

console.log('\nmagnetic steering');
{
  // a clear going deep to the far corner; the player holds a direction 40 degrees off it, or 100 off
  const run = deg => {
    const s = incoming({ kind: 'clear', tx: -5.6 * S, ty: -2.3 * S, px: -3.0 * S, py: 0.5, place: false });
    const p = s.players[0], t0 = BM.meetTarget(s, p);
    const a = Math.atan2(t0.y - p.y, t0.x - p.x) + deg * Math.PI / 180;
    let best = 1e9;
    for (let t = 0; t < 70; t++) {
      BM.stepSim(s, [I({ ax: Math.cos(a), ay: Math.sin(a), mg: true }), I({})]);
      const tg = BM.meetTarget(s, p); if (tg) best = Math.min(best, Math.hypot(tg.x - p.x, tg.y - p.y));
    }
    return best;
  };
  const near = run(40), off = run(100);
  ok(near < 0.25, `held 40 degrees off, it runs onto the spot (closest ${near.toFixed(2)} m)`);
  ok(off > 1.0, `held 100 degrees off, it goes where held (closest ${off.toFixed(2)} m)`);
  // without the magnet the same 40 degrees misses
  const s = incoming({ kind: 'clear', tx: -5.6 * S, ty: -2.3 * S, px: -3.0 * S, py: 0.5, place: false });
  const p = s.players[0], t0 = BM.meetTarget(s, p), a = Math.atan2(t0.y - p.y, t0.x - p.x) + 40 * Math.PI / 180;
  let best = 1e9;
  for (let t = 0; t < 70; t++) { BM.stepSim(s, [I({ ax: Math.cos(a), ay: Math.sin(a) }), I({})]); const tg = BM.meetTarget(s, p); if (tg) best = Math.min(best, Math.hypot(tg.x - p.x, tg.y - p.y)); }
  ok(best > 0.5, `(without it the same direction misses by ${best.toFixed(2)} m)`);
}

console.log('\nfull matches against the bot');
// a swipe player: runs at the meeting point (the magnet does the rest), swipes when the shuttle is
// best met with a human scatter (sd ~ 35 ms, graded as the browser would), at a mix of intensities,
// directions and lifts; the swipe reaches the sim 8 ticks later
function match(level) {
  const s = BM.createSim(0, { botSkill: BM.BOT_LEVELS[level], ai: [false, true] });
  let sw = 0, pend = null, ticks = 0, okNums = true, grades = [0, 0, 0, 0, 0], kinds = {}, perf = 0, hits = 0;
  const gaussian = () => { let u = 0; for (let i = 0; i < 6; i++) u += Math.random(); return (u - 3) / Math.sqrt(0.5); };
  let last = { sw: 0 }, serveWait = 0;
  while (s.phase !== 'over' && ticks < 60 * 60 * 12) {
    ticks++;
    const me = s.players[0], t = BM.meetTarget(s, me);
    let ax = 0, ay = 0;
    if (t) { const dx = t.x - me.x, dy = t.y - me.y, d = Math.hypot(dx, dy); if (d > 0.3) { ax = dx / d; ay = dy / d; } }
    // swipe: plan the moment, add the human's scatter
    if (!pend && s.phase === 'rally' && s.ball.last === 1) {
      const plan = BM.contactPlan(s.ball, me);
      if (plan && plan.k <= 1) {
        const offMs = gaussian() * 35 + 5, a = Math.abs(offMs);
        const g = a <= 25 ? 0 : a <= 60 ? 1 : a <= 110 ? 2 : a <= 220 ? 3 : 4;
        const r = Math.random();
        pend = { at: s.tick + 8, inp: { sw: ++sw, sg: g, si: r < 0.25 ? 0.15 : r < 0.55 ? 0.55 : 0.92, sd: Math.random() < 0.2, sl: Math.random() * 2 - 1, svt: s.tick + plan.k + Math.round(offMs / 16.7) } };
      }
    }
    serveWait = s.phase === 'serve' && s.server === 0 && s.serveHold ? serveWait + 1 : 0;
    if (serveWait > 40 && !pend) pend = { at: s.tick, inp: { sw: ++sw, sg: 4, si: Math.random(), sd: false, sl: 0, svt: s.tick } };
    if (pend && s.tick >= pend.at) { last = pend.inp; pend = null; }
    BM.stepSim(s, [I(Object.assign({ ax, ay, mg: true, swm: 1 }, last)), BM.botInput(s, 1)]);
    for (const e of s.events) if (e.type === 'hit' && e.p === 0) { hits++; kinds[e.kind] = (kinds[e.kind] || 0) + 1; if (e.perfect) perf++; if (e.g != null) grades[e.g]++; }
    s.events.length = 0;
    if (!finite(s)) { okNums = false; break; }
  }
  return { s, okNums, hits, kinds, perf, grades };
}
for (const level of ['easy', 'normal', 'hard']) {
  let pts = [0, 0], done = 0, fin = true, hits = 0, perf = 0; const kinds = {};
  for (let g = 0; g < 3; g++) {
    const m = match(level); fin = fin && m.okNums; if (m.s.phase === 'over') done++;
    pts[0] += m.s.score[0]; pts[1] += m.s.score[1]; hits += m.hits; perf += m.perf;
    for (const k in m.kinds) kinds[k] = (kinds[k] || 0) + m.kinds[k];
  }
  console.log(`  vs ${level.padEnd(6)} points ${pts[0]}-${pts[1]} · hits ${hits} (perfect ${perf}) · ${Object.entries(kinds).map(([k, v]) => k + ' ' + v).join(', ')}`);
  ok(fin && done === 3, `vs ${level}: 3 matches finish with every number finite`);
  ok(hits > 20, `vs ${level}: the swipe player plays real rallies (${hits} hits)`);
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
