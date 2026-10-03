'use strict';
// Headless behavior checks for authoritative momentum and presentation cloth.
// Run: node tools/presentation_test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const BM = require('../shared/badminton.js');
let randomSeed = 42;
Math.random = () => ((randomSeed = Math.imul(randomSeed, 1664525) + 1013904223) >>> 0) / 4294967296;
const input = extra => Object.assign({ kp: 0, k: false, kc: null, dv: 0, jp: 0, kn: 0, sw: 0 }, extra);
const tick = (s, a, b) => BM.stepSim(s, [input(a), input(b)]);
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
let passes = 0, failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); passes++; }
  catch (err) { console.error(`  FAIL ${name}: ${err.message}`); failures++; }
}
function live() {
  const s = BM.createSim(0);
  s.phase = 'rally'; s.serveHold = false; s.lastHitter = 1;
  s.players.forEach(p => { p.init = true; });
  s.events.length = 0;
  return s;
}
function contact({ charge = 20, kind = '', velocity = [0, 0, 0], heat = 0, quiet = false } = {}) {
  randomSeed = 42; // Identical contact fixtures receive the same shot smear.
  const s = live(), p = s.players[0];
  s.heat = [heat, 0]; s.quiet = quiet; s.lastKind = kind;
  p.x = -3.5 * BM.C.S; p.y = 0; p.fx = 1; p.fy = 0;
  p.ch = true; p.ct = charge;
  Object.assign(s.ball, { x: p.x + 0.5, y: 0, z: 0.9, vx: velocity[0], vy: velocity[1], vz: velocity[2], last: 1 });
  tick(s, { kp: 1, kc: charge });
  return s;
}
function landing(reason, heat = [50, 50]) {
  const s = live(); s.heat = heat.slice(); s.lastHitter = 0; s.ball.last = 0;
  Object.assign(s.ball, { x: reason === 'own side' ? -2 : 2, y: reason === 'out' ? BM.C.W + 1 : 0, z: 0.001, vx: 0, vy: 0, vz: -2 });
  if (reason === 'fault') { s.serveLive = 1; s.serveY = -1; }
  tick(s);
  assert.equal(s.events.find(e => e.type === 'point').reason, reason);
  return s;
}

async function main() {
  await check('new match starts cold and entering prematch resets heat', () => {
    const s = BM.createSim(0); assert.deepEqual(s.heat, [0, 0]);
    s.heat = [70, 80]; BM.setPhase(s, 'prematch'); assert.deepEqual(s.heat, [0, 0]);
  });
  await check('clean return earns four without changing shuttle flight', () => {
    const s = contact(); assert.equal(s.events.find(e => e.type === 'hit').err, '');
    near(s.heat[0], 4); near(s.heat[1], 0);
    const hot = contact({ heat: 80 });
    assert.deepEqual(s.ball, hot.ball); assert.deepEqual(s.score, hot.score);
  });
  await check('perfect return adds six and clean parry adds eight more', () => {
    const perfect = contact({ charge: 44 });
    assert.equal(perfect.events.find(e => e.type === 'hit').perfect, 1); near(perfect.heat[0], 10);
    const parry = contact({ charge: 20, kind: 'smash', velocity: [-33.75, 0, -8] });
    assert.equal(parry.events.find(e => e.type === 'hit').parry, 1); near(parry.heat[0], 18);
  });
  await check('authoritative rewards survive quiet prediction and saturate at one hundred', () => {
    // (the rule without the hype system: with it, an attacking hit at this heat is a Fire Shot)
    const hype = BM.C.HYPE; BM.C.HYPE = false;
    try { const s = contact({ heat: 99, quiet: true }); near(s.heat[0], 100); assert.equal(s.events.length, 0); }
    finally { BM.C.HYPE = hype; }
  });
  await check('serve earns no return bonus', () => {
    const s = BM.createSim(0); BM.setPhase(s, 'serve'); s.heat = [20, 0];
    s.players.forEach(p => { p.init = true; });
    tick(s, { kp: 1, kc: 20 });
    assert.ok(s.events.some(e => e.type === 'hit')); near(s.heat[0], 20 - 8 / 60);
  });
  await check('point winner earns twelve; own side, out, and service faults cost twenty', () => {
    const winner = landing('winner'); near(winner.heat[0], 62 - 2 / 60); near(winner.heat[1], 50 - 2 / 60);
    for (const reason of ['own side', 'out', 'fault']) {
      const s = landing(reason); near(s.heat[0], 30 - 2 / 60); near(s.heat[1], 62 - 2 / 60);
    }
    const s = landing('own side', [5, 99]); near(s.heat[0], 0); near(s.heat[1], 100);
  });
  await check('cooling uses elapsed simulation ticks and freezes when the game does not step', () => {
    for (const [phase, expected] of [['rally', 58], ['point', 52], ['serve', 52], ['over', 52]]) {
      const s = BM.createSim(0); s.phase = phase; s.heat = [60, 60];
      // Hold the shuttle to isolate cooling from point awards.
      s.serveHold = true;
      for (let i = 0; i < 60; i++) tick(s);
      near(s.heat[0], expected); near(s.heat[1], expected);
      const paused = s.heat.slice(); BM.netState(s); assert.deepEqual(s.heat, paused);
    }
  });
  await check('snapshot carries independent rounded heat for both players', () => {
    const s = BM.createSim(0); s.heat = [30.49, 85.51];
    assert.deepEqual(BM.netState(s).ht, [30, 86]);
  });
  await check('net event retains both signed velocities before collision damping', () => {
    for (const direction of [-1, 1]) {
      const s = live();
      Object.assign(s.ball, { x: -direction * 0.08, y: 0.6, z: 1, vx: direction * 20, vy: 3, vz: -1 });
      tick(s);
      const net = s.events.find(e => e.type === 'net'); assert.ok(net);
      assert.equal(Math.sign(net.vx), direction); assert.ok(Math.abs(net.vx) > 18);
      assert.ok(net.vy > 2.5); assert.ok(net.vz < -1); assert.ok(net.kmh > 55);
      near(net.vx, -s.ball.vx / 0.06, 0.01);
      near(net.vy, s.ball.vy / 0.25, 0.01); near(net.vz, s.ball.vz, 0.01);
    }
  });
  const modulePath = path.resolve(__dirname, '../public/badminton/net-dynamics.mjs');
  await check('net dynamics module is available for renderer integration', () => assert.ok(fs.existsSync(modulePath), 'NetDynamics module is missing'));
  {
    const NetDynamics = fs.existsSync(modulePath) ? (await import(pathToFileURL(modulePath))).NetDynamics : undefined;
    const make = () => {
      assert.equal(typeof NetDynamics, 'function', 'NetDynamics implementation is missing');
      return new NetDynamics(8.335, 0.76, 40, 10);
    };
    const event = extra => Object.assign({ y: 0.7, z: 1.12, vx: 25, vy: 0, vz: -2 }, extra);
    const displacement = n => {
      let peak = 0; for (let i = 2; i < n.positions.length; i += 3) peak = Math.max(peak, Math.abs(n.positions[i] - n.base[i]));
      return peak;
    };
    await check('grid matches PlaneGeometry ordering and its tensioned sagged cord', () => {
      const n = make(); assert.ok(n.positions instanceof Float32Array); assert.ok(n.base instanceof Float32Array);
      assert.equal(n.positions.length, 41 * 11 * 3); assert.equal(n.cols, 40); assert.equal(n.rows, 10);
      near(n.base[0], -8.335 / 2, 1e-6); near(n.base[1], 0.38, 1e-6);
      near(n.base[20 * 3 + 1], 0.354, 1e-6); assert.ok(n.base[41 * 10 * 3 + 1] < 0);
    });
    await check('opposite incoming sides deform in opposite local depth directions', () => {
      const a = make(), b = make(); a.impact(event()); b.impact(event({ vx: -25 }));
      for (let i = 0; i < 5; i++) { a.step(1 / 120); b.step(1 / 120); }
      let signed = 0;
      for (let i = 2; i < a.positions.length; i += 3) { near(a.positions[i], -b.positions[i], 1e-5); signed += a.positions[i]; }
      assert.ok(signed > 0); assert.ok(displacement(a) > 0.01);
    });
    await check('cross-court contact maps to negative local x and glancing velocity drags the mesh', () => {
      const n = make(); n.impact(event({ y: 1.8, vy: 12, vz: -10 })); n.step(1 / 120);
      let weightedX = 0, weight = 0, dragX = 0, dragY = 0;
      for (let i = 0; i < n.positions.length; i += 3) {
        const w = Math.abs(n.positions[i + 2]); weightedX += n.base[i] * w; weight += w;
        dragX += n.positions[i] - n.base[i]; dragY += n.positions[i + 1] - n.base[i + 1];
      }
      assert.ok(weightedX / weight < -1.3); assert.ok(dragX < 0); assert.ok(dragY < 0);
    });
    await check('stronger impacts deflect further and waves reach neighboring cloth', () => {
      const soft = make(), hard = make(); soft.impact(event({ vx: 8 })); hard.impact(event({ vx: 45 }));
      for (let i = 0; i < 8; i++) { soft.step(1 / 120); hard.step(1 / 120); }
      assert.ok(displacement(hard) > displacement(soft) * 1.4);
      const n = make(); n.impact(event({ y: 0, z: 1.1 }));
      const index = (6 * 41 + 25) * 3 + 2; const initial = Math.abs(n.positions[index]);
      for (let i = 0; i < 36; i++) n.step(1 / 120);
      assert.ok(Math.abs(n.positions[index]) > initial + 0.0001);
    });
    await check('end anchors stay pinned and the top cord is less free than the bottom', () => {
      const n = make();
      for (let j = 0; j < 40; j++) { n.impact(event({ vx: 70, y: j % 2 ? 4.1 : -4.1, z: 1.5 })); n.step(1 / 60); }
      for (let row = 0; row <= n.rows; row++) for (const col of [0, n.cols]) {
        const i = (row * (n.cols + 1) + col) * 3;
        assert.deepEqual(n.positions.slice(i, i + 3), n.base.slice(i, i + 3));
      }
      const top = make(), bottom = make(); top.impact(event({ y: 0, z: 1.54 })); bottom.impact(event({ y: 0, z: 0.82 }));
      for (let i = 0; i < 18; i++) { top.step(1 / 120); bottom.step(1 / 120); }
      assert.ok(displacement(top) < displacement(bottom));
    });
    await check('repeated hits and long frames remain finite with bounded work and displacement', () => {
      const n = make();
      for (let i = 0; i < 200; i++) { n.impact(event({ vx: i % 2 ? -1000 : 1000, vy: 60, vz: -80 })); n.step(i % 3 ? 1 / 60 : 10); }
      assert.ok(Array.from(n.positions).every(Number.isFinite)); assert.ok(displacement(n) <= 0.361);
      const a = make(), b = make(); a.impact(event()); b.impact(event()); a.step(10);
      for (let i = 0; i < 8; i++) b.step(1 / 120);
      assert.deepEqual(a.positions, b.positions);
    });
    await check('cloth damps to rest, pause freezes it, and reset clears motion', () => {
      const n = make(); n.impact(event()); n.step(1 / 60);
      const paused = n.positions.slice(); n.step(0); assert.deepEqual(n.positions, paused);
      for (let i = 0; i < 900; i++) n.step(1 / 60);
      assert.ok(displacement(n) < 0.0001);
      n.impact(event()); n.step(1 / 60); n.reset(); assert.deepEqual(n.positions, n.base);
      n.step(1 / 60); assert.deepEqual(n.positions, n.base);
    });
  }
  console.log(`\nPresentation: ${passes} passed, ${failures} failed.`);
  process.exitCode = failures ? 1 : 0;
}
main().catch(err => { console.error(err); process.exitCode = 1; });
