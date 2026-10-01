'use strict';
// Office Badminton — arcade (keyboard) controls harness. Move, A (hit) and B (soft): a press is a
// swipe of a fixed intensity, graded in the browser against the ring and played where the shuttle
// was seen (the swipe pipeline). Asserts the shot table (each height with A and with B, and against
// a smash), the timing grades, stick aiming (line and length), the auto jump smash, the whiff
// lockout, the auto dive, hidden stamina, no sprint, and full matches against the bot.
//   node tools/keys_test.js
let seed = 4242;
Math.random = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822507) ^ Math.imul(seed ^ (seed >>> 13), 3266489909)) >>> 0) / 4294967296;
const BM = require('../shared/badminton.js');
const C = BM.C, S = C.S, SHOTS = BM.SHOTS;
const I = o => Object.assign({ u: 0, d: 0, l: 0, r: 0, k: false, kp: 0, kc: null, dc: 0, dv: 0, sp: false, jp: 0, ax: 0, ay: 0, lob: false, sh: false, kn: 0, rb: 0, sw: 0, arc: 1, swm: 1, mg: 1 }, o);
const A = 0.92, B = 0.15; // the intensities the client sends for A and B
let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok   ' + msg); } else { fails++; console.log('  FAIL ' + msg); } };

// a live rally: player 1 has just struck `kind` to land at (tx, ty) on player 0's side
function incoming(o) {
  const s = BM.createSim(0, {});
  s.phase = 'rally'; s.pt = 0; s.serveHold = false; s.players.forEach(p => { p.init = true; });
  const p = s.players[0];
  Object.assign(p, { x: o.px != null ? o.px : -3.6 * S, y: o.py || 0, fx: 1, fy: 0 });
  Object.assign(s.players[1], { x: 3.4 * S, y: 0 });
  const from = { x: o.fx != null ? o.fx : 3 * S, y: o.fy || 0, z: o.fz || 1 }, sh = SHOTS[o.kind];
  const r = sh.ang != null ? BM._launch(from, o.tx, o.ty || 0, sh, 1) : BM._launchAngle(from, o.tx, o.ty || 0, sh.cap, -42, -6);
  Object.assign(s.ball, from, { vx: r.lv.vx, vy: r.lv.vy, vz: r.lv.vz, last: 1 });
  s.lastHitter = 1; s.lastKind = o.lastKind || o.kind; s.rally = 1; s.events.length = 0;
  if (o.place !== false) { const m = BM.meetTarget(s, p); if (m) { p.x = m.x; p.y = m.y; } }
  return s;
}
// player 0 presses (a swipe with the arcade fields) when the shuttle is best met (plus `off` ticks)
function play(s, sw = {}, o = {}) {
  const lag = o.lag != null ? o.lag : 6, off = o.off || 0, ev = [];
  let n = 0, svt = null, sendAt = null;
  for (let t = 0; t < 500; t++) {
    const me = s.players[0];
    if (svt == null && s.ball.last === 1) {
      if (o.at != null) { if (t >= o.at) { svt = s.tick; sendAt = svt + lag; } }
      else { const plan = BM.contactPlan(s.ball, me); if (plan && plan.k <= 1) { svt = s.tick + plan.k + off; sendAt = svt + lag; } }
    }
    if (sendAt != null && s.tick + 1 >= sendAt && !n) n = 1;
    const inp = n ? Object.assign({ sw: 1, sg: 0, si: A, sl: 0, sz: 0, svt }, sw) : {};
    BM.stepSim(s, [I(inp), I({ arc: 0 })]);
    for (const e of s.events) ev.push(e);
    s.events.length = 0;
    if (ev.some(e => e.p === 0 && (e.type === 'hit' || e.type === 'swing' || e.type === 'dive')) && !o.full) break;
    if (s.phase === 'point' || s.phase === 'over') break;
  }
  return { s, hit: ev.find(e => e.type === 'hit' && e.p === 0), swing: ev.find(e => e.type === 'swing' && e.p === 0), dive: ev.find(e => e.type === 'dive' && e.p === 0), ev };
}
const lift = () => incoming({ kind: 'lift', tx: -2.5 * S, ty: 0.6, px: -3.4 * S });
const drive = () => incoming({ kind: 'drive', fz: 1.3, tx: -4.2 * S, ty: 0.3, px: -3.8 * S });
const drop = () => incoming({ kind: 'drop', fz: 2.6, tx: -1.3 * S, ty: -0.5, px: -2.0 * S, py: -0.9 });
const smash = () => incoming({ kind: 'smash', fz: 2.6, tx: -4.4 * S, ty: 0.5, px: -3.6 * S, py: 0.2 });
const kindOf = r => r.hit && r.hit.kind;

console.log('\nthe shot table: A hits, B is soft, the height decides the rest');
{
  let r = play(lift(), { si: A, sg: 1 });
  ok(kindOf(r) === 'smash', `A overhead: smash (${kindOf(r)})`);
  r = play(lift(), { si: B, sg: 1 });
  ok(kindOf(r) === 'drop', `B overhead: drop (${kindOf(r)})`);
  r = play(drop(), { si: A, sg: 1 });
  ok(kindOf(r) === 'clear', `A low: clear, high and deep (${kindOf(r)})`);
  r = play(drop(), { si: B, sg: 1 });
  ok(kindOf(r) === 'net', `B low: net shot (${kindOf(r)})`);
  r = play(drive(), { si: A, sg: 1 });
  ok(['drive', 'smash'].includes(kindOf(r)), `A at waist height: drive (${kindOf(r)}, met at ${r.hit && r.hit.z} m)`);
  r = play(drive(), { si: B, sg: 1 });
  ok(['drop', 'net'].includes(kindOf(r)), `B at waist height: soft, a drop (${kindOf(r)})`);
  r = play(smash(), { si: A, sg: 1 });
  ok(kindOf(r) === 'counter', `A against a smash: counter (${kindOf(r)})`);
  r = play(smash(), { si: A, sg: 0 });
  ok(kindOf(r) === 'counter' && r.hit.parry === 1, `a perfect A against a smash: parry (${kindOf(r)}, parry ${r.hit && r.hit.parry})`);
  r = play(smash(), { si: B, sg: 1 });
  ok(kindOf(r) === 'block', `B against a smash: block (${kindOf(r)})`);
}

console.log('\nthe jump smash: a perfect A overhead');
{
  const r = play(lift(), { si: A, sg: 0 });
  ok(kindOf(r) === 'jsmash' && r.hit.perfect === 1, `perfect A overhead: jump smash (${kindOf(r)})`);
  ok(r.s.players[0].vz > 0 || r.s.players[0].z > 0, 'and the player leaps into it');
  const g = play(lift(), { si: A, sg: 1 });
  ok(r.hit.v > g.hit.v, `faster than a great smash (${r.hit.kmh} vs ${g.hit.kmh} km/h)`);
  // it lands heavy
  const s = r.s; let land = null;
  for (let t = 0; t < 90 && !land; t++) { BM.stepSim(s, [I({ sw: 1 }), I({ arc: 0 })]); land = s.events.find(e => e.type === 'land' && e.p === 0); s.events.length = 0; }
  ok(land && land.hard === 1, 'and lands heavy');
}

console.log('\ntiming');
{
  const g = grade => play(lift(), { si: A, sg: grade }).hit;
  const p1 = g(1), p2 = g(2), p3 = g(3);
  ok(p1 && p2 && p3, 'great, good and early/late connect');
  ok(p1.q > p2.q && p2.q > p3.q, `contact falls with the grade (q ${[p1, p2, p3].map(h => h.q).join(' > ')})`);
  ok(p3.kind !== 'smash', `an early/late A overhead is too weak to smash (${p3.kind})`);
}

console.log('\naiming with the stick');
{
  const where = sw => { const r = play(lift(), Object.assign({ si: B, sg: 1 }, sw), { full: true }); return r.s.ball; };
  const left = where({ sl: -1 }), right = where({ sl: 1 }), mid = where({ sl: 0 });
  ok(left.y < mid.y - 1 && right.y > mid.y + 1, `left and right send it across (y ${left.y.toFixed(1)} / ${mid.y.toFixed(1)} / ${right.y.toFixed(1)})`);
  const deep = where({ si: A, sg: 1, sz: 1 }), short = where({ si: A, sg: 1, sz: -1 });
  ok(Math.abs(deep.x) > Math.abs(short.x) + 0.5, `forward is deeper than back (x ${deep.x.toFixed(1)} vs ${short.x.toFixed(1)})`);
}

console.log('\nthe whiff lockout');
{
  const s = lift();
  let r = play(s, { si: A, sg: 4 });
  ok(r.swing && r.swing.whiff === 1 && !r.hit, 'a miss is a whiff');
  ok(s.players[0].lock > 0, `and locks the racket (${s.players[0].lock} ticks)`);
  // a second press inside the lock does nothing, even a perfect one
  const lockT = s.players[0].lock;
  BM.stepSim(s, [I({ sw: 2, sg: 0, si: A, svt: s.tick }), I({ arc: 0 })]);
  ok(!s.events.some(e => e.type === 'hit' && e.p === 0), 'a press during the lock is ignored');
  ok(lockT <= C.ARC_LOCK, 'the lock is short');
}

console.log('\nthe dive: a press with the shuttle out of reach');
{
  // a drop landing well wide of where the player stands
  const s = incoming({ kind: 'drop', fz: 2.4, tx: -1.6 * S, ty: -1.9 * S, px: -2.2 * S, py: 0.4, place: false });
  // wait until it is nearly down, then press
  let r = null;
  for (let t = 0; t < 200; t++) {
    s.events.length = 0;
    const pr = BM.predict(s);
    if (pr.land && pr.land.t * 60 < C.ARC_DIVE_T - 8) { r = play(s, { si: A, sg: 4, svt: s.tick }, { at: 0, lag: 0 }); break; }
    BM.stepSim(s, [I({}), I({ arc: 0 })]);
  }
  ok(r && r.dive, 'it dives');
  ok(r && !(r.swing && r.swing.whiff), 'rather than whiffing');
  const far = incoming({ kind: 'clear', tx: -5.6 * S, ty: 1.5 * S, px: -1.5 * S, py: -1.5 * S, place: false });
  const r2 = play(far, { si: A, sg: 4 }, { at: 2, lag: 0 });
  ok(!r2.dive && r2.swing && r2.swing.whiff, 'but not at a shuttle far off and still climbing: that is a whiff');
}

console.log('\nno sprint, one running speed, hidden stamina');
{
  const s = BM.createSim(0, {}); s.phase = 'rally'; s.players.forEach(p => { p.init = true; });
  const p = s.players[0]; Object.assign(p, { x: -6 * S, y: -2 * S });
  for (let t = 0; t < 30; t++) BM.stepSim(s, [I({ ay: 1, sp: true }), I({ arc: 0 })]);
  ok(!p.sprint, 'Shift does not sprint');
  ok(Math.abs(Math.hypot(p.vx, p.vy) - C.ARC_TOP) < 0.3, `runs at the arcade speed (${Math.hypot(p.vx, p.vy).toFixed(1)} m/s)`);
  const t = lift(); t.players[0].stamina = 0;
  const r = play(t, { si: A, sg: 1 });
  ok(kindOf(r) === 'smash', `out of breath, a smash is still a smash (${kindOf(r)})`);
  const f = lift(); const r2 = play(f, { si: A, sg: 1 });
  ok(r.hit.v < r2.hit.v, `just a little slower (${r.hit.kmh} vs ${r2.hit.kmh} km/h)`);
}

console.log('\nserves');
{
  const s = BM.createSim(0, {}); s.players.forEach(p => { p.init = true; }); s.phase = 'serve';
  BM.stepSim(s, [I({ sw: 1, sg: 1, si: B }), I({ arc: 0 })]);
  let h = s.events.find(e => e.type === 'hit');
  ok(h && h.kind === 'servel', `B serves low (${h && h.kind})`);
  const s2 = BM.createSim(0, {}); s2.players.forEach(p => { p.init = true; }); s2.phase = 'serve';
  BM.stepSim(s2, [I({ sw: 1, sg: 1, si: A }), I({ arc: 0 })]);
  h = s2.events.find(e => e.type === 'hit');
  ok(h && h.kind === 'serveh', `A serves high (${h && h.kind})`);
}

console.log('\nthe timing ring (ringPlan): one per shot, fixed, shown from the strike');
{
  // a human-ish player (late to react, 8-way keys) against the bot: for every bot shot that comes to
  // player 0's side, the ring must exist from the strike on, never move, and a press on it connect
  // whenever the player made it to the spot
  let shots = 0, missing = 0, moved = 0, pressedNear = 0, hitNear = 0, stale = 0;
  for (let m = 0; m < 3; m++) {
    const s = BM.createSim(0, { ai: [false, true], botSkill: 0.84 });
    let n = 0, react = 0, lastLh = -1, lock = null, first = null, pressed = false, cur = null;
    for (let t = 0; t < 60 * 60 * 4 && s.phase !== 'over'; t++) {
      const me = s.players[0], b = s.ball;
      let inp = {};
      if (s.lastHitter !== lastLh) {
        lastLh = s.lastHitter; react = 12; pressed = false; first = null;
        cur = s.lastHitter === 1 && s.phase === 'rally' ? { mine: false } : null;
      }
      if (s.phase === 'serve' && s.server === 0 && s.serveHold && s.tick - s.ps > 30) { n++; inp = { sw: n, sg: 1, si: A }; }
      else if (s.phase === 'rally' && b.last === 1) {
        if (react > 0) react--;
        else { const mt = BM.meetTarget(s, me); if (mt) { const dx = mt.x - me.x, dy = mt.y - me.y, d = Math.hypot(dx, dy); if (d > 0.3) inp = { ax: Math.abs(dx) > 0.38 * d ? Math.sign(dx) : 0, ay: Math.abs(dy) > 0.38 * d ? Math.sign(dy) : 0 }; } }
        const key = s.lastHitter + ':' + s.rally + ':' + (s.score[0] + s.score[1]);
        lock = BM.ringPlan(s, { i: 0, x: me.x, y: me.y, z: me.z }, key, lock);
        const pr = BM.predict(s);
        if (cur && !cur.counted && pr.land && pr.land.x < 0) { cur.counted = true; shots++; if (!lock) missing++; }
        if (lock && lock.key !== key) stale++;
        if (lock && first && (first.x !== lock.x || first.tick !== lock.tick)) moved++;
        if (lock && !first) first = lock;
        if (lock && !pressed && s.tick >= lock.tick) {
          pressed = true; n++; inp = Object.assign(inp, { sw: n, sg: 1, si: A, svt: s.tick });
          if (Math.hypot(me.x - lock.sx, me.y - lock.sy) < 0.6) { pressedNear++; cur && (cur.near = true); }
        }
      }
      BM.stepSim(s, [I(inp), BM.botInput(s, 1)]);
      for (const e of s.events) if (e.type === 'hit' && e.p === 0 && cur && cur.near) { hitNear++; cur.near = false; }
      s.events.length = 0;
    }
  }
  ok(shots > 40 && missing === 0, `a ring for every shot coming to you, from the strike (${shots - missing}/${shots})`);
  ok(moved === 0, `it never moves within a shot (${moved} moves)`);
  ok(stale === 0, `no ring left over from an earlier shot or point (${stale})`);
  ok(pressedNear > 20 && hitNear >= pressedNear * 0.95, `pressed on the ring from the spot, it connects (${hitNear}/${pressedNear})`);
}

console.log('\nfull matches against the bot');
{
  // a scripted arcade player: runs with the magnet toward the shuttle, presses on the contact plan
  // with a grade drawn at random, A or B by height
  let done = 0, rallies = 0, hits = 0, bad = 0;
  for (let m = 0; m < 3; m++) {
    const s = BM.createSim(0, { ai: [false, true], botSkill: 0.62 });
    let n = 0, pressAt = null, g = 0, si = A;
    for (let t = 0; t < 60 * 60 * 6 && s.phase !== 'over'; t++) {
      const me = s.players[0], b = s.ball;
      let inp = {};
      if (s.phase === 'serve' && s.server === 0 && s.serveHold && s.tick - s.ps > 30) { n++; inp = { sw: n, sg: 1, si: Math.random() < 0.5 ? A : B }; }
      else if (s.phase === 'rally' && b.last === 1) {
        const mt = BM.meetTarget(s, me);
        if (mt) { const dx = mt.x - me.x, dy = mt.y - me.y, d = Math.hypot(dx, dy); if (d > 0.15) inp = { ax: dx / d, ay: dy / d }; }
        const plan = BM.contactPlan(b, me);
        if (plan && pressAt == null) { pressAt = s.tick + plan.k; g = [0, 1, 1, 2, 2, 3][Math.floor(Math.random() * 6)]; si = plan.z - me.z > 1.75 ? A : Math.random() < 0.5 ? A : B; }
        if (pressAt != null && s.tick >= pressAt) { n++; inp = Object.assign(inp, { sw: n, sg: g, si, sl: Math.random() * 2 - 1, sz: Math.random() * 2 - 1, svt: s.tick }); pressAt = null; hits++; }
      } else pressAt = null;
      BM.stepSim(s, [I(inp), BM.botInput(s, 1)]);
      if (s.events.some(e => e.type === 'point')) rallies++;
      s.events.length = 0;
      if (![s.ball.x, s.ball.y, s.ball.z, ...s.players.flatMap(p => [p.x, p.y, p.z])].every(Number.isFinite)) bad++;
    }
    if (s.phase === 'over') done++;
  }
  ok(done === 3, `three matches finish (${done})`);
  ok(bad === 0, 'every number stays finite');
  ok(hits > rallies, `the arcade player keeps rallies going (${hits} presses over ${rallies} points)`);
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
