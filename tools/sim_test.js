'use strict';
// Office Ball — headless sim harness. Asserts the ball-control mechanics directly on the shared
// simulation (no browser): stride touches, first-touch quality, feet, pressure, height bands,
// shield/knock, and that a bot match stays finite and scores like football.
//   node tools/sim_test.js
const OB = require('../shared/game.js');
const C = OB.C;
const I = o => Object.assign({ u: 0, d: 0, l: 0, r: 0, k: false, kp: 0, kc: null, dc: 0, rb: 0, ax: 0, ay: 0, lob: false, sh: false, kn: 0 }, o);
const step = (s, a, b) => OB.stepSim(s, [I(a), I(b)]);
const I2 = a => I(a);
function fresh(opts) {
  const s = OB.createSim(0, opts || {});
  s.phase = 'play'; s.pt = 0; s.ps = 0; s.time = C.MATCH_TICKS;
  s.players.forEach(p => { p.touchCd = 0; p.recvT = 0; });
  return s;
}
function place(s, x, y, fx) {
  const p = s.players[0];
  p.x = x; p.y = y; p.fx = fx; p.fy = 0; p.vx = p.vy = 0;
  return p;
}
let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok   ' + msg); } else { fails++; console.log('  FAIL ' + msg); } };
const finite = v => Number.isFinite(v);
function allFinite(s) {
  const v = [s.ball.x, s.ball.y, s.ball.z, s.ball.vx, s.ball.vy, s.ball.vz];
  for (const p of s.players) v.push(p.x, p.y, p.vx, p.vy, p.bs, p.recvT);
  return v.every(finite);
}

console.log('\n1. bot match stability');
{
  let goals = 0, nan = false, ticks = 0;
  for (let m = 0; m < 3; m++) {
    const s = OB.createSim(0, {});
    for (let t = 0; t < C.MATCH_TICKS + 600; t++) {
      OB.stepSim(s, [OB.botInput(s, 0), OB.botInput(s, 1)]);
      for (const e of s.events) if (e.type === 'goal') goals++;
      s.events.length = 0;
      ticks++;
      if (t % 300 === 0 && !allFinite(s)) { nan = true; break; }
      if (s.phase === 'over') break;
    }
  }
  ok(!nan, `3 bot matches stay finite over ${ticks} ticks`);
  ok(goals >= 1 && goals <= 40, `bot goals in a sane range (${goals} in 3 matches)`);
}

console.log('\n2. stride touches');
{
  const s = fresh();
  const p = place(s, C.CX - 300, C.CY, 1);
  const b = s.ball; b.x = p.x + 34; b.y = p.y; b.vx = b.vy = 0;
  let touches = 0, maxGap = 0;
  for (let t = 0; t < 180; t++) {
    step(s, { r: 1 });
    touches += s.events.filter(e => e.type === 'touch').length;
    s.events.length = 0;
    maxGap = Math.max(maxGap, Math.hypot(b.x - p.x, b.y - p.y));
  }
  ok(touches >= 3, `running with the ball produces touches (${touches} in 3s)`);
  ok(maxGap < 130, `the ball is never left far behind at a run (${maxGap.toFixed(0)}px)`);
}
{
  // determinism: the same inputs produce the same picture, frame for frame
  const run = () => {
    const s = fresh();
    const p = place(s, C.CX - 300, C.CY, 1);
    const b = s.ball; b.x = p.x + 34; b.y = p.y; b.vx = b.vy = 0;
    for (let t = 0; t < 240; t++) { step(s, { r: 1, ax: t % 60 < 30 ? 0.6 : 1, kn: t === 120 ? 1 : 0 }); s.events.length = 0; }
    return [b.x, b.y, p.x, p.y, p.bs];
  };
  const a = run(), c = run();
  ok(a.every((v, i) => Math.abs(v - c[i]) < 1e-9), `touch play is deterministic (${a.map(v => v.toFixed(1)).join(', ')})`);
}
{
  // close dribble: at a walk the ball stays at the foot, at a jog it is a touch further ahead
  const gapAt = ax => {
    const s = fresh();
    const p = place(s, C.CX - 300, C.CY, 1);
    const b = s.ball; b.x = p.x + 34; b.y = p.y; b.vx = b.vy = 0;
    let maxGap = 0;
    for (let t = 0; t < 240 && p.x < C.FR - 80; t++) {
      step(s, { ax });
      if (t > 40) maxGap = Math.max(maxGap, Math.hypot(b.x - p.x, b.y - p.y)); // steady state, after the start
    }
    return maxGap;
  };
  const walk = gapAt(0.4), jog = gapAt(0.55), sprint = gapAt(1);
  ok(walk < 50, `walking keeps the ball at your feet (${walk.toFixed(0)}px)`);
  ok(jog < 65, `jogging is one touch ahead (${jog.toFixed(0)}px)`);
  ok(sprint > jog + 4 && sprint < 120, `sprinting runs the ball away (${sprint.toFixed(0)}px)`);
}
{
  const s = fresh();
  const p = place(s, C.CX, C.CY, 1);
  const b = s.ball; b.x = p.x + 34; b.y = p.y; b.vx = b.vy = 0;
  let touches = 0;
  for (let t = 0; t < 120; t++) { step(s, {}); touches += s.events.filter(e => e.type === 'touch').length; s.events.length = 0; }
  ok(touches === 0, `standing still: no touches (${touches})`);
  ok(Math.hypot(b.x - p.x, b.y - p.y) < 45, 'the ball rests at your feet');
}

console.log('\n3. sprint vs walk knock');
{
  const gap = input => {
    const s = fresh();
    const p = place(s, C.CX - 300, C.CY, 1);
    const b = s.ball; b.x = p.x + 34; b.y = p.y; b.vx = b.vy = 0;
    let mx = 0;
    for (let t = 0; t < 150 && p.x < C.FR - 60; t++) { step(s, input); mx = Math.max(mx, Math.hypot(b.x - p.x, b.y - p.y)); }
    return mx;
  };
  const walk = gap({ ax: 0.3 }), sprint = gap({ ax: 1 });
  ok(sprint > walk + 6, `sprint knocks travel further than walk (${sprint.toFixed(0)} vs ${walk.toFixed(0)}px)`);
}

console.log('\n4. first touch quality');
function receive(opts) {
  const s = fresh();
  const p = place(s, C.CX - 200, C.CY, 1);
  p.sf = opts.sf || 1;
  const o = s.players[1];
  if (opts.press === 'front') { o.x = p.x + 70; o.y = p.y + 52; }        // in front, but off the ball's line
  else if (opts.press === 'back') { o.x = p.x - 60; o.y = p.y; }        // behind: must not count
  else { o.x = C.CX + 600; o.y = C.CY; }
  o.vx = o.vy = 0;
  const b = s.ball, from = opts.fromFront ? 1 : -1;
  b.x = p.x + 60 * from; b.y = p.y; b.z = 0; b.vx = -12 * from; b.vy = 0;
  let q = null;
  for (let t = 0; t < 40 && q === null; t++) {
    step(s, {});
    const e = s.events.find(e => e.type === 'trap' && e.p === 0);
    if (e) q = e.q;
    s.events.length = 0;
  }
  return { q, speed: Math.hypot(b.vx - p.vx, b.vy - p.vy) };
}
{
  const front = receive({ fromFront: true });
  const back = receive({ fromFront: false });
  const pressed = receive({ fromFront: true, press: 'front' });
  const phantom = receive({ fromFront: true, press: 'back' });
  ok(front.q !== null && front.q > 0.6, `front receive is clean (q=${front.q})`);
  ok(back.q !== null && back.q < front.q, `receive from behind spills more (${back.q} < ${front.q})`);
  ok(pressed.q !== null && pressed.q < front.q, `pressure in front spoils the touch (${pressed.q} < ${front.q})`);
  ok(phantom.q === front.q, `pressure from behind does not touch the ball (${phantom.q})`);
  ok(front.speed < 4, `a clean touch kills the pace (${front.speed.toFixed(1)} px/tick left)`);
}

console.log('\n5. strong / weak foot');
function sideReceive(side) {
  const s = fresh();
  const p = place(s, C.CX - 200, C.CY, 1);
  p.sf = 1; // right-footed
  const b = s.ball;
  b.x = p.x + 50; b.y = p.y + 40 * side; b.z = 0;
  const dd = Math.hypot(b.x - p.x, b.y - p.y);
  b.vx = -12 * (b.x - p.x) / dd; b.vy = -12 * (b.y - p.y) / dd; // straight at the player
  let q = null;
  for (let t = 0; t < 40 && q === null; t++) {
    step(s, {});
    const e = s.events.find(e => e.type === 'trap' && e.p === 0);
    if (e) q = e.q;
    s.events.length = 0;
  }
  return q;
}
{
  const strong = sideReceive(1), weak = sideReceive(-1);
  ok(strong !== null && weak !== null, 'side receives land');
  ok(weak < strong, `wrong-foot touch is looser (${weak} < ${strong})`);
}
function shot(sf, n) {
  const angles = [];
  let sp = 0;
  for (let i = 0; i < n; i++) {
    const s = fresh();
    const p = place(s, C.CX - 300, C.CY, 1);
    p.sf = sf;
    const b = s.ball; b.x = p.x + 30; b.y = p.y + 24; b.vx = b.vy = 0;
    let kp = 0;
    for (let t = 0; t < 26; t++) step(s, { k: true, kp });
    kp++;
    let evt = null;
    for (let t = 0; t < 12 && !evt; t++) {
      step(s, { kp });
      const e = s.events.find(e => e.type === 'kick');
      if (e) evt = e;
      s.events.length = 0;
    }
    if (!evt) continue;
    angles.push(Math.atan2(b.vy, b.vx));
    sp += Math.hypot(b.vx, b.vy);
  }
  const mean = angles.reduce((a, b) => a + b, 0) / angles.length;
  const sd = Math.sqrt(angles.reduce((a, b) => a + (b - mean) * (b - mean), 0) / angles.length);
  return { sd, sp: sp / angles.length, cnt: angles.length };
}
{
  const strong = shot(1, 400), weak = shot(-1, 400); // same ball position: only the foot changes
  ok(strong.cnt > 350 && weak.cnt > 350, `kick contact happened (${strong.cnt}/${weak.cnt})`);
  ok(weak.sd > strong.sd * 1.3, `weak-foot shots stray more (sd ${(strong.sd * 57.3).toFixed(2)}° vs ${(weak.sd * 57.3).toFixed(2)}°)`);
  ok(weak.sp < strong.sp - 0.2, `weak-foot shots carry less (${strong.sp.toFixed(1)} vs ${weak.sp.toFixed(1)})`);
}

console.log('\n6. height bands');
{
  const s = fresh();
  const p = place(s, C.CX, C.CY, 1);
  const b = s.ball; b.x = p.x + 10; b.y = p.y; b.z = 20; b.vz = -1; b.vx = b.vy = 0;
  let part = null;
  for (let t = 0; t < 80; t++) {
    step(s, {});
    const e = s.events.find(e => e.type === 'trap');
    if (e && !part) part = e.part;
    s.events.length = 0;
  }
  ok(part === 'chest', `a dropping ball at chest height is chested (${part})`);
  ok(b.z < 3, `and comes down (z=${b.z.toFixed(1)})`);
}
{
  const s = fresh();
  const p = place(s, C.CX, C.CY, 1);
  const b = s.ball; b.x = p.x + 8; b.y = p.y; b.z = 40; b.vz = -2; b.vx = -3; b.vy = 0;
  let evt = null;
  for (let t = 0; t < 60 && !evt; t++) {
    step(s, {});
    evt = s.events.find(e => e.type === 'header') || null;
    s.events.length = 0;
  }
  ok(!!evt, 'a dropping ball above head height is headed');
  if (evt) ok(b.vx > 2, `the header goes where the body faces (vx=${b.vx.toFixed(1)})`);
}

console.log('\n7. shield and knock-on');
{
  const s = fresh();
  const p = place(s, C.CX - 300, C.CY, 1);
  const b = s.ball; b.x = p.x + 34; b.y = p.y; b.vx = b.vy = 0;
  let gap = 0;
  for (let t = 0; t < 90; t++) { step(s, { ax: 1, sh: true }); gap = Math.max(gap, Math.hypot(b.x - p.x, b.y - p.y)); }
  ok(Math.hypot(p.vx, p.vy) < C.TOP * 0.6, `shielding slows the carrier (${Math.hypot(p.vx, p.vy).toFixed(2)} px/tick)`);
  ok(gap < 70, `the ball stays close while shielding (${gap.toFixed(0)}px)`);
}
{
  const s = fresh();
  const p = place(s, C.CX - 300, C.CY, 1);
  const b = s.ball; b.x = p.x + 34; b.y = p.y; b.vx = b.vy = 0;
  step(s, {}); // sync the input baseline the way a real first message would
  step(s, { kn: 1 });
  ok(Math.hypot(b.vx, b.vy) > 7, `knock-on sends the ball into space (${Math.hypot(b.vx, b.vy).toFixed(1)} px/tick)`);
  ok(s.events.some(e => e.type === 'touch' && e.type === 'touch' && e.q !== undefined), 'knock-on emits a touch event');
}

console.log('\n8. random-input stress');
{
  const s = OB.createSim(0, { feet: [1, -1] });
  let nan = false, badEvent = null, ticks = 0;
  const rnd = () => Math.random();
  for (let t = 0; t < 6000; t++) {
    const mk = () => I({
      u: rnd() < 0.3, d: rnd() < 0.3, l: rnd() < 0.3, r: rnd() < 0.3,
      k: rnd() < 0.5, kp: rnd() < 0.2 ? Math.floor(t / 3) : 0, dc: rnd() < 0.1 ? t : 0,
      sh: rnd() < 0.2, kn: rnd() < 0.05 ? t : 0, ax: rnd() < 0.4 ? rnd() * 2 - 1 : 0, ay: rnd() < 0.4 ? rnd() * 2 - 1 : 0,
    });
    OB.stepSim(s, [mk(), mk()]);
    for (const e of s.events) {
      if (e.type === 'kick' || e.type === 'touch' || e.type === 'trap' || e.type === 'header') {
        for (const v of Object.values(e)) if (typeof v === 'number' && !Number.isFinite(v)) badEvent = e;
      }
      if (e.type === 'goal') { /* fine */ }
    }
    s.events.length = 0;
    ticks++;
    if (t % 250 === 0 && !allFinite(s)) { nan = true; break; }
  }
  ok(!nan, `random inputs stay finite over ${ticks} ticks`);
  ok(!badEvent, `events carry finite numbers${badEvent ? ' (' + JSON.stringify(badEvent) + ')' : ''}`);
}
{
  const s = OB.createSim(0, { solo: true });
  let nan = false;
  for (let t = 0; t < 3000; t++) {
    OB.stepSim(s, [I({ r: 1, k: t % 40 < 25, kp: t % 40 === 25 ? 1 : 0, kn: t % 90 === 0 ? 1 : 0, rb: t % 300 === 0 ? 1 : 0 }), I({})]);
    s.events.length = 0;
    if (t % 250 === 0 && !allFinite(s)) { nan = true; break; }
  }
  ok(!nan, 'solo practice stays finite with all the new mechanics in play');
}

console.log('\n9. snapshot shape');
{
  const s = fresh();
  const st = OB.netState(s);
  ok(st.p.every(a => a.length >= 14 && a.every(finite)), 'player entries carry shield/receive fields, all finite');
  ok(finite(st.b[0]) && finite(st.b[3]), 'ball entries finite');
  JSON.stringify(st);
  const bi = OB.botInput(s, 0);
  ok('sh' in bi && 'kn' in bi, 'bot inputs carry the new fields');
}

console.log(`\n${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
