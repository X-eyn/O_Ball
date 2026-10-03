'use strict';
// Headless checks for the hype system (shared/badminton.js, C.HYPE): the rally tempo, the rally pot,
// the Fire Shot (fired, survived, burned) and the heat steal; and that HYPE false turns all of it off.
// Run: node tools/hype_test.js
const assert = require('node:assert/strict');
const BM = require('../shared/badminton.js');
let randomSeed = 42;
Math.random = () => ((randomSeed = Math.imul(randomSeed, 1664525) + 1013904223) >>> 0) / 4294967296;
const input = extra => Object.assign({ kp: 0, k: false, kc: null, dv: 0, jp: 0, kn: 0, sw: 0 }, extra);
const tick = (s, a, b) => BM.stepSim(s, [input(a), input(b)]);
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const C = BM.C;
let passes = 0, failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); passes++; }
  catch (err) { console.error(`  FAIL ${name}: ${err.message}`); failures++; }
}
function live() {
  const s = BM.createSim(0);
  s.phase = 'rally'; s.serveHold = false; s.lastHitter = 1;
  s.players.forEach(p => { p.init = true; });
  s.events.length = 0;
  return s;
}
// player 0 meets a shuttle at waist height (a drive with A, a lift with lob)
function contact({ charge = 20, heat = 0, lob = false, fireBy = null, rally = 0 } = {}) {
  randomSeed = 42;
  const s = live(), p = s.players[0];
  s.heat = [heat, 0]; s.rally = rally; if (fireBy != null) s.fire = { by: fireBy };
  p.x = -3.5 * C.S; p.y = 0; p.fx = 1; p.fy = 0;
  p.ch = true; p.ct = charge;
  Object.assign(s.ball, { x: p.x + 0.5, y: 0, z: 0.9, vx: 0, vy: 0, vz: 0, last: 1 });
  tick(s, { kp: 1, kc: charge, lob });
  const hit = s.events.find(e => e.type === 'hit');
  assert.ok(hit, 'the contact made a hit');
  return { s, hit, v: Math.hypot(s.ball.vx, s.ball.vy, s.ball.vz) * (s.ball.w || 1) }; // (real speed: on the shuttle's clock)
}
function landing(heat, rally = 0) {
  const s = live(); s.heat = heat.slice(); s.lastHitter = 0; s.ball.last = 0; s.rally = rally;
  Object.assign(s.ball, { x: 2, y: 0, z: 0.001, vx: 0, vy: 0, vz: -2 });
  tick(s);
  const pt = s.events.find(e => e.type === 'point');
  assert.equal(pt.reason, 'winner');
  return { s, pt };
}
const cool = 2 / 60; // a rally tick of cooling

check('tempo: level for the first hits, then rising smoothly to its cap', () => {
  near(BM.tempoOf(0), 1); near(BM.tempoOf(C.TEMPO_FROM), 1);
  near(BM.tempoOf(C.TEMPO_FULL), 1 + C.TEMPO_MAX); near(BM.tempoOf(60), 1 + C.TEMPO_MAX);
  for (let r = 1; r < 40; r++) assert.ok(BM.tempoOf(r) >= BM.tempoOf(r - 1));
});
check('pot: nothing for a short rally, more per hit as it grows', () => {
  assert.equal(BM.potOf(3), 0); assert.equal(BM.potOf(4), 2);
  assert.equal(BM.potOf(12), 6 * 2 + 3 * 3); assert.equal(BM.potOf(20), 6 * 2 + 10 * 3 + 4);
});
check('a long rally flies faster than a fresh one', () => {
  const fresh = contact(), late = contact({ rally: 30 });
  assert.ok(late.v > fresh.v * 1.05, `${late.v} vs ${fresh.v}`);
  assert.ok(late.hit.tempo > 1.25); assert.ok(late.s.ball.w > 1.25);
});
check('below the fire mark an attacking hit is an ordinary one', () => {
  const { s, hit } = contact({ heat: C.FIRE_AT - 10 });
  assert.equal(hit.fire, 0); assert.equal(s.fire, undefined);
  near(s.heat[0], C.FIRE_AT - 10 + 4 - cool);
});
check('at the fire mark an attacking hit is a Fire Shot: faster, and it spends the heat', () => {
  const plain = contact(), { s, hit, v } = contact({ heat: C.FIRE_AT + 5 });
  assert.equal(hit.kind, 'drive'); assert.equal(hit.fire, 1);
  assert.deepEqual(s.fire, { by: 0 });
  near(s.heat[0], 0);
  assert.ok(v > plain.v * 1.15, `${v} vs ${plain.v}`);
});
check('a soft or lifted hit keeps the Fire Shot for later', () => {
  const { s, hit } = contact({ heat: C.FIRE_AT + 5, lob: true });
  assert.equal(hit.kind, 'lift'); assert.equal(hit.fire, 0); assert.ok(!s.fire);
  assert.ok(s.heat[0] >= C.FIRE_AT);
});
check('crossing the fire mark tells the client', () => {
  const { s } = contact({ heat: C.FIRE_AT - 2 });
  assert.ok(s.events.some(e => e.type === 'armed' && e.p === 0));
});
check('a Fire Shot met without perfect timing is overpowered into the tape', () => {
  const { s, hit } = contact({ fireBy: 1 });
  assert.equal(hit.burned, 1); assert.equal(hit.err, 'net'); assert.ok(!s.fire);
  near(s.heat[0], 0); // an error earns nothing
});
check('a Fire Shot met perfectly is survived, and the heat it carried comes over', () => {
  const { s, hit } = contact({ fireBy: 1, charge: C.CHARGE_FULL + 4 });
  assert.equal(hit.fireHeld, 1); assert.equal(hit.burned, 0); assert.equal(hit.err, '');
  near(s.heat[0], 4 + 6 + C.FIRE_PARRY); // (cooling ran first, on zero)
});
check('the point winner takes the rally pot as heat', () => {
  const { s, pt } = landing([10, 10], 12);
  assert.equal(pt.pot, BM.potOf(12));
  near(s.heat[0], 10 + 12 + BM.potOf(12) - cool); // (cooled at the rally rate, then awarded)
});
check('winning off a hot player steals some of their heat', () => {
  const { s, pt } = landing([10, 70]);
  assert.equal(pt.steal, C.STEAL);
  near(s.heat[0], 10 + 12 + C.STEAL - cool); near(s.heat[1], 70 - C.STEAL - cool);
});
check('a cool loser keeps their heat', () => {
  const { pt } = landing([10, C.STEAL_AT - 1]);
  assert.equal(pt.steal, 0);
});
check('a point ends any Fire Shot in the air', () => {
  const s = live(); s.fire = { by: 0 }; s.lastHitter = 0; s.ball.last = 0;
  Object.assign(s.ball, { x: 2, y: 0, z: 0.001, vx: 0, vy: 0, vz: -2 });
  tick(s); assert.ok(!s.fire);
});
check('a sped-up flight is predicted exactly: landing time, and the timing ring contact tick', () => {
  for (const w of [1, 1.3, 1.3 * C.FIRE_SPEED]) {
    const s = live();
    Object.assign(s.ball, { x: 4, y: 0.5, z: 2.4, vx: -14, vy: -0.4, vz: 3, w, last: 1 });
    const pred = BM.predict(s).land;
    const b = Object.assign({}, s.ball), p = { i: 0, x: -4.6, y: 0.3, z: 0 };
    const plan = BM.contactPlan(b, p);
    let k = 0, at = null;
    while (!BM._stepBall(s) && k < 600) { k++; if (plan && k === plan.k) at = { x: s.ball.x, y: s.ball.y, z: s.ball.z }; }
    assert.ok(Math.abs(pred.t * 60 - k) <= 2.5, `w ${w}: predicted ${pred.t * 60} ticks, landed after ${k}`);
    if (plan) assert.ok(at && Math.hypot(at.x - plan.x, at.y - plan.y, at.z - plan.z) < 0.02, `w ${w}: contact point off`);
  }
  // and it really is quicker
  const t = w => { const s = live(); Object.assign(s.ball, { x: 4, y: 0.5, z: 2.4, vx: -14, vy: -0.4, vz: 3, w, last: 1 }); return BM.predict(s).land.t; };
  assert.ok(t(1.3) < t(1) * 0.8);
});
check('a Fire Shot in hand does not cool away; below the mark heat cools as before', () => {
  for (const phase of ['rally', 'point', 'serve']) {
    const s = BM.createSim(0); s.phase = phase; s.serveHold = true; s.heat = [C.FIRE_AT + 3, C.FIRE_AT - 3];
    for (let i = 0; i < 120; i++) tick(s);
    near(s.heat[0], C.FIRE_AT + 3); assert.ok(s.heat[1] < C.FIRE_AT - 3);
  }
});
check('HYPE false: no tempo, no pot, no Fire Shot, no steal', () => {
  C.HYPE = false;
  try {
    near(BM.tempoOf(30), 1); assert.equal(BM.potOf(30), 0);
    const plain = contact(), late = contact({ rally: 30 });
    near(late.v, plain.v, 1e-9);
    const { s, hit } = contact({ heat: 95 });
    assert.equal(hit.fire, 0); assert.ok(!s.fire); near(s.heat[0], 99 - cool);
    const burn = contact({ fireBy: 1 }); assert.equal(burn.hit.burned, 0);
    const { s: s2 } = landing([10, 70], 12); near(s2.heat[1], 70 - cool); near(s2.heat[0], 10 + 12 - cool);
  } finally { C.HYPE = true; }
});

console.log(`\nHype: ${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
