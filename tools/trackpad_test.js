'use strict';
// Office Badminton — trackpad controls harness. The sim runs a trackpad player's legs and swing;
// the player only taps (shot / lift) and points (where it goes, short = soft, deep = power).
// Asserts: the shot each tap makes for each kind of incoming shuttle, the aim, serves, the queue
// (an early tap waits, a stale one expires, no tap = no swing), switching controls mid-rally, the
// end-of-match ready-up, fairness (never a perfect), and full matches against every bot level.
//   node tools/trackpad_test.js
let seed = 4242;
Math.random = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822507) ^ Math.imul(seed ^ (seed >>> 13), 3266489909)) >>> 0) / 4294967296;
const BM = require('../shared/badminton.js');
const C = BM.C, S = C.S, SHOTS = BM.SHOTS;
const I = o => Object.assign({ u: 0, d: 0, l: 0, r: 0, k: false, kp: 0, kc: null, dc: 0, dv: 0, sp: false, jp: 0, ax: 0, ay: 0, lob: false, sh: false, kn: 0, rb: 0 }, o);
let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok   ' + msg); } else { fails++; console.log('  FAIL ' + msg); } };
const finite = v => Number.isFinite(v);
const allFinite = s => [s.ball.x, s.ball.y, s.ball.z, s.ball.vx, s.ball.vy, s.ball.vz, ...s.players.flatMap(p => [p.x, p.y, p.z, p.vx, p.vy, p.stamina])].every(finite);

// a trackpad player's input: taps so far, the last tap's kind, and the aimed spot (far court is x > 0
// for player 0)
const pad = (kp, o = {}) => I(Object.assign({ ez: true, am: true, kp, tx: 4.5 * S, ty: 0, lob: false }, o));

// a live rally: player 1 has just struck `kind` from (fx, fy, fz) to land at (tx, ty) on player 0's
// side; player 0 stands at (px, py) on trackpad controls with `taps` taps already made
function incoming(o) {
  const s = BM.createSim(0, {});
  s.phase = 'rally'; s.pt = 0; s.serveHold = false; s.players.forEach(p => { p.init = true; });
  const p = s.players[0], q = s.players[1];
  Object.assign(p, { x: o.px != null ? o.px : -3.6 * S, y: o.py || 0, fx: 1, fy: 0 });
  Object.assign(q, { x: o.fx != null ? o.fx + 0.4 : 3 * S, y: o.fy || 0 });
  const from = { x: o.fx != null ? o.fx : 3 * S, y: o.fy || 0, z: o.fz || 1 };
  const sh = SHOTS[o.kind];
  const r = sh.ang != null ? BM._launch(from, o.tx, o.ty || 0, sh, o.mul || 1) : BM._launchAngle(from, o.tx, o.ty || 0, sh.cap, -42, -6);
  Object.assign(s.ball, from, { vx: r.lv.vx, vy: r.lv.vy, vz: r.lv.vz, last: 1 });
  s.lastHitter = 1; s.lastKind = o.lastKind || o.kind; s.rally = 1;
  s.events.length = 0;
  return s;
}
// play it out: the trackpad player taps at tick `tapAt` (or never), the other player does nothing.
// Returns player 0's hit event, if any, and every event seen.
function play(s, o = {}) {
  let kp = 0; const ev = [];
  for (let t = 0; t < (o.ticks || 400); t++) {
    if (t === (o.tapAt != null ? o.tapAt : 1) && !o.noTap) kp++;
    BM.stepSim(s, [pad(kp, o.inp || {}), I({})]);
    for (const e of s.events) ev.push(e);
    s.events.length = 0;
    if (ev.some(e => e.type === 'hit' && e.p === 0) && !o.full) break;
    if (s.phase === 'point' || s.phase === 'over') break;
  }
  return { hit: ev.find(e => e.type === 'hit' && e.p === 0), ev };
}

// the shot, aim and serve checks measure the mechanics, so the legs read every shot exactly here;
// the full matches at the end play with the deliberate misreads back on
const MISREAD = BM.EZ.MISREAD;
BM.EZ.MISREAD = 0;
console.log('\nshots: what a tap makes');
{
  // a high lift coming down mid-court: overhead, close enough to smash
  const mid = () => incoming({ kind: 'lift', tx: -2.5 * S, ty: 0.6, px: -3.4 * S });
  let r = play(mid());
  ok(r.hit && r.hit.kind === 'smash', `power aim on a mid-court lift: smash (${r.hit && r.hit.kind})`);
  ok(r.hit && !r.hit.perfect, 'never inside the perfect window');
  // a deep clear coming down at the back: overhead, too deep for a smash to get down over the net
  const deep = () => incoming({ kind: 'clear', tx: -5.4 * S, ty: 0.6, px: -3.4 * S });
  r = play(deep());
  ok(r.hit && r.hit.kind === 'clear', `power aim on a deep clear: clear, not a soft drop (${r.hit && r.hit.kind})`);
  r = play(deep(), { inp: { tx: 1.2 * S } });
  ok(r.hit && r.hit.kind === 'drop', `short aim on a high clear: drop (${r.hit && r.hit.kind})`);
  r = play(deep(), { inp: { lob: true } });
  ok(r.hit && r.hit.kind === 'clear', `lift on a high clear: clear (${r.hit && r.hit.kind})`);
  // a drop falling short in front: low
  const short = () => incoming({ kind: 'drop', fz: 2.6, tx: -1.3 * S, ty: -0.5, px: -3.2 * S });
  r = play(short(), { inp: { tx: 1.0 * S } });
  ok(r.hit && r.hit.kind === 'net', `short aim on a drop: net shot (${r.hit && r.hit.kind})`);
  r = play(short(), { inp: { lob: true } });
  ok(r.hit && r.hit.kind === 'lift', `lift on a drop: lift (${r.hit && r.hit.kind})`);
  r = play(short());
  ok(r.hit && (r.hit.kind === 'clear' || r.hit.kind === 'drive'), `power aim on a drop: clear / drive (${r.hit && r.hit.kind})`);
  // a smash: tapped early (a brace), power = counter, short = block, lift = lift
  // (struck to come past the body at waist height: one into the feet is a lost point for anyone)
  const smash = () => incoming({ kind: 'smash', fz: 2.6, tx: -4.4 * S, ty: 0.5, px: -3.6 * S, py: 0.2 });
  r = play(smash());
  ok(r.hit && (r.hit.kind === 'counter' || r.hit.kind === 'block'), `power aim on a smash: counter (${r.hit && r.hit.kind})`);
  ok(r.hit && r.hit.kind === 'counter', 'tapped in time it is a counter, not a block');
  r = play(smash(), { inp: { tx: 1.0 * S } });
  ok(r.hit && r.hit.kind === 'block', `short aim on a smash: block (${r.hit && r.hit.kind})`);
  r = play(smash(), { inp: { lob: true } });
  ok(r.hit && r.hit.kind === 'lift', `lift on a smash: lift (${r.hit && r.hit.kind})`);
}

console.log('\nlegs: it runs there on its own');
{
  // a clear to the far corner, the player standing at the other side of the court
  const s = incoming({ kind: 'clear', tx: -5.6 * S, ty: -2.2 * S, px: -2.6 * S, py: 1.8 * S });
  const r = play(s);
  ok(!!r.hit, `reaches a clear to the far corner (${r.hit ? 'hit ' + r.hit.kind : 'missed'})`);
  ok(r.hit && r.hit.q > 0.55, `and meets it cleanly (q ${r.hit && r.hit.q})`);
  // after the shot it goes back to base
  const s2 = incoming({ kind: 'clear', tx: -5.4 * S, ty: 0.6, px: -3.4 * S });
  play(s2);
  for (let t = 0; t < 70; t++) { BM.stepSim(s2, [pad(1), I({})]); s2.events.length = 0; }
  ok(Math.abs(s2.players[0].x - -3.1 * S) < 1.0, `recovers to base after the shot (x ${s2.players[0].x.toFixed(2)} vs ${(-3.1 * S).toFixed(2)})`);
  // no tap: it runs there but never swings
  const s3 = incoming({ kind: 'clear', tx: -5.4 * S, ty: 0.6, px: -3.4 * S });
  const r3 = play(s3, { noTap: true, full: true });
  ok(!r3.hit && !r3.ev.some(e => e.type === 'swing' && e.p === 0), 'no tap, no swing');
  ok(r3.ev.some(e => e.type === 'point' && e.p === 1), 'and the point is lost');
}

console.log('\naim: the shuttle goes where you point');
{
  const errs = [], sides = [];
  for (const ty of [-2.6, -1.4, 0, 1.4, 2.6]) for (let n = 0; n < 4; n++) {
    const s = incoming({ kind: 'clear', tx: -5.3 * S, ty: 0.3, px: -3.4 * S });
    const r = play(s, { inp: { lob: true, ty }, full: true });
    const land = r.ev.find(e => e.type === 'point');
    if (!r.hit || !land) { errs.push(9); continue; }
    if (r.hit.q > 0.8) errs.push(Math.abs(land.y - ty));
    sides.push(Math.sign(land.y) === Math.sign(ty) || ty === 0);
  }
  const mean = errs.reduce((a, b) => a + b, 0) / Math.max(1, errs.length);
  ok(errs.length >= 12 && mean < 0.9, `clean clears land near the aimed line (mean error ${mean.toFixed(2)} m over ${errs.length})`);
  ok(sides.filter(Boolean).length >= sides.length - 1, `on the aimed side (${sides.filter(Boolean).length}/${sides.length})`);
  // a power aim deep in the far corner off a clear stays in more often than not
  let ins = 0, tot = 0;
  for (let n = 0; n < 12; n++) {
    const s = incoming({ kind: 'clear', tx: -5.3 * S, ty: 0.3, px: -3.4 * S });
    const r = play(s, { inp: { lob: true, tx: 5.6 * S, ty: 2.4 }, full: true });
    const pt = r.ev.find(e => e.type === 'point');
    if (pt) { tot++; if (pt.p === 0) ins++; }
  }
  ok(tot >= 10 && ins >= tot * 0.75, `aimed clears into the corner stay in (${ins}/${tot})`);
}

console.log('\nserve');
{
  const serveWith = inp => {
    const s = BM.createSim(0, {});
    s.server = 0; s.phase = 'prematch';
    for (let t = 0; t <= C.PRE_T; t++) BM.stepSim(s, [pad(0, inp), I({})]);
    let kp = 0, hit = null, pt = null;
    for (let t = 0; t < 400 && !pt; t++) {
      if (t === 10) kp++;
      BM.stepSim(s, [pad(kp, inp), I({})]);
      for (const e of s.events) { if (e.type === 'hit' && e.p === 0) hit = e; if (e.type === 'point') pt = e; }
      s.events.length = 0;
    }
    return { hit, pt };
  };
  let r = serveWith({});
  ok(r.hit && r.hit.kind === 'serveh', `a deep aim serves high (${r.hit && r.hit.kind})`);
  ok(r.pt && r.pt.reason === 'ace', `and in (${r.pt && r.pt.reason})`);
  r = serveWith({ tx: 0.9 * S });
  ok(r.hit && r.hit.kind === 'servel', `a short aim serves low (${r.hit && r.hit.kind})`);
  ok(r.pt && r.pt.reason === 'ace', `and in (${r.pt && r.pt.reason})`);
  // no tap: no serve
  const s = BM.createSim(0, {}); s.server = 0;
  for (let t = 0; t <= C.PRE_T + 300; t++) BM.stepSim(s, [pad(0), I({})]);
  ok(s.phase === 'serve' && s.serveHold, 'no tap, no serve');
}

console.log('\nthe queue');
{
  // tapped as player 0's own shot leaves: it waits for the return
  const s = incoming({ kind: 'clear', tx: -5.4 * S, ty: 0.6, px: -3.4 * S });
  let kp = 0, hits = 0;
  for (let t = 0; t < 600 && hits < 2; t++) {
    if (t === 1) kp++;
    BM.stepSim(s, [pad(kp), I({})]);
    for (const e of s.events) if (e.type === 'hit' && e.p === 0) {
      hits++;
      if (hits === 1) { kp++; // tap again at once, then send the shuttle straight back to player 0
        const from = { x: 3 * S, y: 0, z: 1.2 }, r = BM._launch(from, -5.2 * S, -0.5, SHOTS.clear, 1);
        s.pending = { from, lv: r.lv };
      }
    }
    s.events.length = 0;
    if (s.pending && s.ball.x > 1) { Object.assign(s.ball, s.pending.from, { vx: s.pending.lv.vx, vy: s.pending.lv.vy, vz: s.pending.lv.vz, last: 1 }); s.lastHitter = 1; s.lastKind = 'clear'; s.pending = null; }
    if (s.phase !== 'rally') break;
  }
  ok(hits === 2, `an early tap waits for the shuttle to come back (${hits} hits)`);
  // a tap with nothing coming for longer than EZ.HOLD is dropped
  const s2 = incoming({ kind: 'clear', tx: -5.4 * S, ty: 0.6, px: -3.4 * S });
  s2.ball.last = 0; s2.lastHitter = 0; Object.assign(s2.ball, { x: 2, y: 0, z: 30, vx: 0, vy: 0, vz: 0 }); // up and away on their side
  BM.stepSim(s2, [pad(0), I({})]);
  BM.stepSim(s2, [pad(1), I({})]);
  ok(s2.ez[0].q, 'a tap is queued');
  for (let t = 0; t < BM.EZ.HOLD + 2; t++) { BM.stepSim(s2, [pad(1), I({})]); if (s2.phase !== 'rally') break; }
  ok(!s2.ez[0].q, 'and dropped once it has waited too long');
}

console.log('\nswitching controls');
{
  // mid-rally, trackpad -> keyboard: the sim's own press counter is not read as a press of the
  // player's own button (no swing), nor its dive counter as a dive
  const s = incoming({ kind: 'clear', tx: -5.4 * S, ty: 0.6, px: -3.4 * S });
  play(s, { tapAt: 1 });
  const ev = [];
  for (let t = 0; t < 30; t++) { BM.stepSim(s, [I({ kp: 1 }), I({})]); ev.push(...s.events); s.events.length = 0; }
  ok(!ev.some(e => (e.type === 'swing' || e.type === 'dive' || e.type === 'hit') && e.p === 0), 'trackpad -> keyboard: no phantom swing or dive');
  // keyboard -> trackpad mid-rally: no phantom tap
  const s2 = incoming({ kind: 'clear', tx: -5.4 * S, ty: 0.6, px: -3.4 * S });
  for (let t = 0; t < 10; t++) BM.stepSim(s2, [I({ kp: 5 }), I({})]);
  BM.stepSim(s2, [pad(5), I({})]);
  ok(!s2.ez[0].q, 'keyboard -> trackpad: no phantom tap');
}

console.log('\nend of match');
{
  const s = BM.createSim(0, {});
  BM.setPhase(s, 'over'); s.players.forEach(p => { p.init = true; });
  BM.stepSim(s, [pad(0), I({})]);
  BM.stepSim(s, [pad(1), I({})]);
  ok(s.ready[0], 'a tap readies up for the next match');
}

console.log('\nfull matches against the bot');
BM.EZ.MISREAD = MISREAD;
// a trackpad player who taps once for every shot coming at them, a moment after it is struck, and
// points somewhere on the far court (sometimes short, sometimes a lift); and one who never taps
function match(level, o = {}) {
  const s = BM.createSim(0, { botSkill: BM.BOT_LEVELS[level], ai: [false, true] });
  let kp = 0, tapAt = -1, lastSeen = -2, aim = { tx: 4.5 * S, ty: 0, lob: false };
  let ticks = 0, finiteAll = true, perfects = 0, hits = 0, kinds = {}, dives = 0;
  while (s.phase !== 'over' && ticks < 60 * 60 * 12) {
    ticks++;
    if (!o.noTap) {
      const servingMe = s.phase === 'serve' && s.server === 0 && s.serveHold;
      if (s.ball.last !== lastSeen || (servingMe && tapAt < 0)) {
        lastSeen = s.ball.last;
        if (s.ball.last === 1 || servingMe) {
          tapAt = ticks + ((Math.random() * (o.late || 25)) | 0);
          const r = Math.random();
          aim = { tx: (r < 0.25 ? 1.2 : 3.5 + Math.random() * 2.2) * S, ty: (Math.random() * 2 - 1) * 2.4 * S, lob: r > 0.8 };
        }
      }
      if (ticks === tapAt) { kp++; tapAt = -1; }
    }
    BM.stepSim(s, [pad(kp, aim), BM.botInput(s, 1)]);
    for (const e of s.events) {
      if (e.type === 'hit' && e.p === 0) { hits++; kinds[e.kind] = (kinds[e.kind] || 0) + 1; if (e.perfect) perfects++; }
      if (e.type === 'dive' && e.p === 0) dives++;
    }
    s.events.length = 0;
    if (!allFinite(s)) { finiteAll = false; break; }
    if (s.phase === 'point' && s.pt === 0) lastSeen = -2;
  }
  return { s, ticks, finiteAll, perfects, hits, kinds, dives };
}
const results = {};
for (const level of ['easy', 'normal', 'hard', 'pro']) {
  let won = 0, pts = [0, 0], hits = 0, perfects = 0, fin = true, done = 0;
  const kinds = {};
  for (let g = 0; g < 4; g++) {
    const m = match(level);
    fin = fin && m.finiteAll; if (m.s.phase === 'over') done++;
    if (m.s.winner === 0) won++;
    pts[0] += m.s.score[0]; pts[1] += m.s.score[1]; hits += m.hits; perfects += m.perfects;
    for (const k in m.kinds) kinds[k] = (kinds[k] || 0) + m.kinds[k];
  }
  results[level] = { won, pts };
  console.log(`  vs ${level.padEnd(6)} matches won ${won}/4 · points ${pts[0]}-${pts[1]} · hits ${hits} · ${Object.entries(kinds).map(([k, v]) => k + ' ' + v).join(', ')}`);
  ok(fin && done === 4, `vs ${level}: 4 matches finish with every number finite`);
  ok(perfects === 0, `vs ${level}: no perfect strikes`);
}
ok(results.easy.pts[0] > results.easy.pts[1], `beats the easy bot on points (${results.easy.pts.join('-')})`);
ok(results.normal.pts[0] >= 10, `competes with the normal bot (${results.normal.pts.join('-')} points)`);
ok(results.pro.pts[0] < results.pro.pts[1], `the pro bot is still better (${results.pro.pts.join('-')})`);
{
  const m = match('normal', { noTap: true });
  ok(m.hits === 0 && m.s.score[0] === 0, `never tapping: never hits, never wins a point (${m.s.score.join('-')})`);
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
