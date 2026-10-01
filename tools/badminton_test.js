'use strict';
// Office Badminton — headless sim harness. Asserts the flight model and its court scaling, the
// shot model (every shot kind, serves, the net, contact quality), the movement kit (sprint, dive,
// jump, stamina), attack and defence (jump smash, net kill, block, counter, parry, hit-stop),
// rally rules, and that bot matches use the whole kit and finish in a sane state.
//   node tools/badminton_test.js
// Randomness is seeded, so a run is repeatable (the bots and mishit smear use Math.random).
let seed = 12345;
Math.random = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822507) ^ Math.imul(seed ^ (seed >>> 13), 3266489909)) >>> 0) / 4294967296;
const BM = require('../shared/badminton.js');
const C = BM.C, S = C.S;
const I = o => Object.assign({ u: 0, d: 0, l: 0, r: 0, k: false, kp: 0, kc: null, dc: 0, dv: 0, sp: false, jp: 0, ax: 0, ay: 0, lob: false, sh: false, kn: 0, rb: 0 }, o);
const step = (s, a, b) => BM.stepSim(s, [I(a), I(b)]);
let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok   ' + msg); } else { fails++; console.log('  FAIL ' + msg); } };
const finite = v => Number.isFinite(v);
function allFinite(s) {
  const v = [s.ball.x, s.ball.y, s.ball.z, s.ball.vx, s.ball.vy, s.ball.vz];
  for (const p of s.players) v.push(p.x, p.y, p.z, p.vx, p.vy, p.vz, p.stamina, p.diveT, p.recover, p.stun);
  return v.every(finite);
}
// a live rally with nobody holding the shuttle (inputs are synced, as the server does in prematch)
function fresh(opts) {
  const s = BM.createSim(0, opts || {});
  s.phase = 'rally'; s.pt = 0; s.ps = 0; s.serveHold = false; s.lastHitter = -1;
  s.players.forEach(p => { p.init = true; });
  s.events.length = 0;
  return s;
}
// place player 0 and the shuttle, face the net, then release a charge of `ct` ticks. The shuttle is
// pinned to its contact point while the button is held (as if it were still arriving). `inV`
// gives it that velocity at contact (an incoming shot), `lastKind` what the opponent played.
function strike(o) {
  const s = fresh();
  const p = s.players[0], b = s.ball;
  p.x = o.px != null ? o.px : -3 * S;
  p.y = o.py || 0;
  p.fx = o.fx != null ? o.fx : 1; p.fy = o.fy || 0;
  const bx = p.x + (o.dx != null ? o.dx : 0.5);
  const by = p.y + (o.dy || 0);
  const bz = o.z != null ? o.z : 0.5;
  const v = o.inV || [0, 0, 0];
  if (o.lastKind) { s.lastKind = o.lastKind; s.lastHitter = 1; }
  const pin = () => Object.assign(b, { x: bx, y: by, z: bz, vx: v[0], vy: v[1], vz: v[2], last: o.lastKind ? 1 : -1 });
  s.players[1].x = o.ox != null ? o.ox : 3.2 * S; s.players[1].y = o.oy != null ? o.oy : 1;
  const ct = o.ct != null ? o.ct : 10;
  for (let t = 0; t < ct; t++) { pin(); if (o.pz != null) { p.z = o.pz; p.vz = o.pvz || 0; } step(s, { k: true, kp: 0 }); }
  pin(); if (o.pz != null) { p.z = o.pz; p.vz = o.pvz || 0; }
  step(s, { k: false, kp: 1, kc: ct, lob: !!o.lob });
  const hit = s.events.find(e => e.type === 'hit');
  return { s, p, b, hit };
}
function lands(s, maxTicks = 900) {
  let t = 0; const ev = [];
  while (t++ < maxTicks) {
    step(s, {}, {});
    for (const e of s.events) ev.push(e);
    s.events.length = 0;
    if (s.phase === 'point' || s.phase === 'over') break;
  }
  return ev;
}
// ticks from the hit until the shuttle is down
function flightTicks(s) { let t = 0; while (t++ < 900) { step(s, {}, {}); s.events.length = 0; if (s.phase !== 'rally') break; } return t; }

console.log('\n0. court scaling of the flight model');
{
  // the drag law scales exactly: a court-scaled launch lands S times as far in the same time as
  // the real-size one (compared by integrating both with the matching constants)
  const real = (() => { const k = 0.2185, g = 9.81; let x = 0, z = 1, vx = 38 * Math.cos(0.855), vz = 38 * Math.sin(0.855), t = 0; const dt = 1 / 600; while (z > 0) { const sp = Math.hypot(vx, vz), dec = 1 / (1 + k * sp * dt); vx *= dec; vz = vz * dec - g * dt; x += vx * dt; z += vz * dt; t += dt; } return { x, t }; })();
  const V = S * C.T;
  const scaled = BM.fly({ x: 0, y: 0, z: S }, 38 * V * Math.cos(0.855), 0, 38 * V * Math.sin(0.855), { dt: 1 / 600, maxT: 8 });
  ok(Math.abs(scaled.x / real.x - S) < 0.01 && Math.abs(scaled.t * C.T - real.t) < 0.01, `a scaled clear flies ${scaled.x.toFixed(2)} m in ${scaled.t.toFixed(2)} s; a real one ${real.x.toFixed(2)} m in ${real.t.toFixed(2)} s (x ${(scaled.x / real.x).toFixed(3)}, time ${(scaled.t / real.t).toFixed(3)} = 1/T)`);
  ok(Math.abs(Math.sqrt(C.G / C.DRAG) - 6.7 * V) < 0.05, `terminal velocity is a real shuttle's, scaled (${Math.sqrt(C.G / C.DRAG).toFixed(2)} m/s)`);
}

console.log('\n1. the shot kinds');
{
  const shots = [
    { name: 'clear (low contact, full charge)', z: 0.5, ct: 40, kind: 'clear', px: -3.6 * S, from: 3.4 * S, to: C.L },
    { name: 'net shot (low contact, soft)', z: 0.5, ct: 6, kind: 'net', px: -1.4 * S, from: 0.3, to: 2.6 * S },
    { name: 'drive (waist contact)', z: 1.2, ct: 40, kind: 'drive', px: -3.6 * S, from: 3.2 * S, to: C.L },
    { name: 'smash (overhead, full charge)', z: 2.3, ct: 44, kind: 'smash', px: -1.8 * S, from: 1.6 * S, to: 4.2 * S },
    { name: 'drop (overhead, soft)', z: 2.3, ct: 8, kind: 'drop', px: -1.4 * S, from: 0.4 * S, to: 2.6 * S },
    { name: 'lift (Lift button, mid height)', z: 1.2, ct: 12, kind: 'lift', px: -2 * S, from: 3.8 * S, to: C.L, lob: true },
  ];
  for (const sh of shots) {
    const { s, hit } = strike({ px: sh.px, z: sh.z, ct: sh.ct, lob: sh.lob });
    const kmh = hit ? hit.kmh : 0;
    const ev = lands(s);
    const pt = ev.find(e => e.type === 'point');
    const xAbs = pt ? Math.abs(pt.x) : 0;
    const inCourt = pt && xAbs > 0.1 && xAbs <= C.L && Math.abs(pt.y) <= C.W;
    ok(hit && hit.kind === sh.kind, `${sh.name}: fired as ${hit && hit.kind} (${kmh} km/h)`);
    ok(pt && pt.p === 0 && inCourt, `${sh.name}: landed in the opponent's court (x ${pt ? pt.x.toFixed(1) : '–'}, y ${pt ? pt.y.toFixed(1) : '–'})`);
    if (pt) ok(xAbs >= sh.from && xAbs <= sh.to, `${sh.name}: landed in the right depth band (${xAbs.toFixed(1)}m, wanted ${sh.from.toFixed(1)}-${sh.to.toFixed(1)})`);
  }
  // a clear from the back line reaches the far back court: the big court is playable end to end
  const deep = strike({ px: -C.L + 0.4, z: 0.9, ct: 44 });
  const pt = lands(deep.s).find(e => e.type === 'point');
  ok(pt && Math.abs(pt.x) > 4.8 * S && Math.abs(pt.x) <= C.L, `a clear from the baseline lands deep (${pt && pt.x.toFixed(1)} m of ${C.L.toFixed(1)})`);
  // shown speeds are the real-world equivalents: a smash reads as a smash
  const sm = strike({ px: -1.8 * S, z: 2.3, ct: 44 });
  ok(sm.hit && sm.hit.kmh > 150 && sm.hit.kmh < 260, `a standing smash shows ${sm.hit && sm.hit.kmh} km/h`);
}

console.log('\n2. aim follows the facing');
{
  const straight = strike({ px: -3.6 * S, ct: 40, z: 0.5 });
  const ev1 = lands(straight.s).find(e => e.type === 'point');
  const cross = strike({ px: -3.6 * S, ct: 40, z: 0.5, fx: 0.7, fy: 0.7 });
  const ev2 = lands(cross.s).find(e => e.type === 'point');
  ok(ev1 && ev2 && ev2.y > ev1.y + 0.8, `facing across the court aims there (y ${ev1 && ev1.y.toFixed(1)} -> ${ev2 && ev2.y.toFixed(1)})`);
}

console.log('\n3. contact quality');
{
  const sweet = strike({ dx: 0.5, z: 2.25, ct: 40 });
  const stretched = strike({ dx: 1.35, z: 0.6, ct: 40 });
  const behind = strike({ dx: -0.9, z: 0.6, ct: 40, fx: 1 });
  ok(sweet.hit && stretched.hit && behind.hit, 'all three contacts connect');
  if (sweet.hit && stretched.hit) ok(sweet.hit.q > stretched.hit.q, `stretched contact is looser (q ${sweet.hit.q} vs ${stretched.hit.q})`);
  if (sweet.hit && behind.hit) ok(sweet.hit.q > behind.hit.q, `hitting behind the shoulder is looser (q ${sweet.hit.q} vs ${behind.hit.q})`);
  const diveQ = (() => {
    const s = fresh();
    const p = s.players[0];
    p.x = -3 * S; p.y = 0; p.diveT = 10; p.diveCd = 40; p.fx = 1;
    const b = s.ball;
    const pin = () => Object.assign(b, { x: p.x - 0.4, y: 0, z: 0.5, vx: 0, vy: 0, vz: 0, last: -1 });
    for (let t = 0; t < 8; t++) { pin(); step(s, { k: true }); }
    pin();
    step(s, { k: false, kp: 1, kc: 8 });
    const hit = s.events.find(e => e.type === 'hit');
    return hit && hit.q;
  })();
  ok(diveQ != null && diveQ < 0.5, `a diving save is a desperation contact (q ${diveQ})`);
}

console.log('\n4. overcharge and mishits');
{
  const over = strike({ px: -3.6 * S, ct: 80, z: 0.5 });
  const clean = strike({ px: -3.6 * S, ct: 40, z: 0.5 });
  ok(over.hit && over.hit.over === 1, 'holding past the gold window flags an overcharge');
  if (over.hit && clean.hit) ok(over.hit.q < clean.hit.q, `an overcooked shot is looser (q ${over.hit.q} vs ${clean.hit.q})`);
}

console.log('\n5. the net');
{
  const s = fresh();
  const b = s.ball;
  Object.assign(b, { x: -1.0, y: 0, z: 0.9, vx: 9, vy: 0, vz: 0, last: 0 });
  s.lastHitter = 0;
  const ev = lands(s);
  const net = ev.find(e => e.type === 'net');
  const pt = ev.find(e => e.type === 'point');
  ok(!!net, 'the shuttle meets the net cord');
  ok(pt && pt.p === 1, `and the point goes to the other side (${pt && pt.reason})`);
  ok(Math.abs(b.x) < 0.2, `the shuttle is left dead at the net (x ${b.x.toFixed(2)})`);
}
{
  const { s } = strike({ px: -5 * S, z: 0.5, ct: 40 });
  let crossed = false;
  for (let t = 0; t < 240 && !crossed; t++) { step(s, {}, {}); if (s.ball.x > 0.2) crossed = true; }
  ok(crossed, 'a full clear crosses the net');
}

console.log('\n6. serve rules');
{
  const s = BM.createSim(0, {});
  const ev = [];
  for (let t = 0; t < C.PRE_T + 400; t++) {
    step(s, BM.botInput(s, 0), {});
    for (const e of s.events) ev.push(e);
    s.events.length = 0;
    if (ev.some(e => e.type === 'point')) break;
  }
  const pt = ev.find(e => e.type === 'point');
  ok(pt && pt.p === 0 && pt.reason === 'ace', `an unreturned serve lands in the box and is an ace (${pt && pt.reason})`);
}
{
  const s = BM.createSim(0, {});
  let faults = 0, aces = 0;
  for (let t = 0; t < 6000; t++) {
    step(s, BM.botInput(s, 0), {});
    for (const e of s.events) if (e.type === 'point') { if (e.reason === 'fault') faults++; if (e.reason === 'ace') aces++; }
    s.events.length = 0;
    if (s.phase === 'over') break;
  }
  ok(faults === 0 && aces >= 3, `bot serves into the service box (${aces} aces, ${faults} faults)`);
}

console.log('\n7. rally rules');
{
  const { s, hit } = strike({ px: -3 * S, z: 0.5, ct: 40 });
  ok(hit, 'first contact registered');
  let second = null;
  for (let t = 0; t < 10; t++) {
    step(s, { k: false, kp: 2, kc: 20 }, {});
    if (s.events.some(e => e.type === 'hit' && e.p === 0 && e.tick > hit.tick)) second = t;
    s.events.length = 0;
  }
  ok(second === null, 'a player cannot hit twice in a row');
}
{
  const s = fresh();
  const b = s.ball;
  b.x = 4.5 * S; b.y = C.W + 1.4; b.z = 0.5; b.vx = 0; b.vy = 0; b.vz = -1; b.last = 0;
  s.lastHitter = 0;
  const pt = lands(s).find(e => e.type === 'point');
  ok(pt && pt.p === 1 && pt.reason === 'out', `a wide landing gives the point away (${pt && pt.reason})`);
}
{
  const s = fresh();
  const b = s.ball;
  b.x = -3 * S; b.y = 0; b.z = 0.4; b.vx = 0; b.vy = 0; b.vz = -1; b.last = 0;
  s.lastHitter = 0;
  const pt = lands(s).find(e => e.type === 'point');
  ok(pt && pt.p === 1 && pt.reason === 'own side', `a shuttle dead on your own floor gives the point away (${pt && pt.reason})`);
}

console.log('\n8. movement kit');
{
  // holding sprint: a faster top speed, paid for in stamina; it stops when the breath runs out
  const s = fresh();
  const p = s.players[0];
  p.x = -6 * S; p.y = -2;
  for (let t = 0; t < 40; t++) step(s, { ay: 1, sp: true });
  const v = Math.hypot(p.vx, p.vy);
  ok(p.sprint && v > C.TOP * 1.15, `sprint is faster than a run (${v.toFixed(1)} vs ${C.TOP} m/s)`);
  ok(p.stamina < C.ST_MAX - 10, `sprinting spends stamina (${Math.round(p.stamina)})`);
  p.stamina = 1; p.y = -2;
  for (let t = 0; t < 10; t++) step(s, { ay: 1, sp: true });
  ok(!p.sprint, 'an empty tank ends the sprint');
}
{
  // a double tap of sprint is a dive, along the direction held
  const s = fresh();
  const p = s.players[0];
  p.x = -3 * S; p.y = 0; p.fx = 1;
  step(s, { ay: 1, dv: 1 });
  ok(p.diveT > 0 && p.diveCd > 0, 'a double tap is a dive');
  ok(p.vy > C.TOP, `the dive launches along the stick (vy ${p.vy.toFixed(1)})`);
  ok(s.events.some(e => e.type === 'dive'), 'the dive is announced for the renderer');
  const y0 = p.y;
  let t = 0; while (p.diveT > 0 && t++ < 60) step(s, { ay: 1, dv: 1 });
  ok(p.floorT > 0, 'the dive ends on the floor');
  ok(p.y - y0 > 1.5 && p.y - y0 < 2.6, `a dive covers a measured ~2 m (${(p.y - y0).toFixed(2)} m)`);
  const yF = p.y;
  for (let k = 0; k < 10; k++) step(s, { ay: 1, dv: 1, k: true });
  ok(p.y - yF < 0.4 && !p.ch, 'on the floor you can neither run nor wind up');
  t = 0; while (p.floorT > 0 && t++ < 90) step(s, { ay: 1, dv: 1 });
  ok(t >= C.DIVE_REC - 12 && p.floorT === 0, `getting up takes ~${(C.DIVE_REC / 60).toFixed(2)} s`);
  step(s, { ay: 1, dv: 2 });
  ok(p.diveT === 0, 'no second dive until the cooldown is over');
}
{
  // the dive bends toward a shuttle coming down just off the line, and strikes it on the way
  const s = fresh();
  const p = s.players[0];
  p.x = -3 * S; p.y = 0;
  const b = s.ball; Object.assign(b, { x: p.x + 0.6, y: 2.4, z: 0.9, vx: 0, vy: 0, vz: -1, last: 1 }); s.lastHitter = 1;
  step(s, { ay: 1, dv: 1 });
  ok(p.diveT > 0 && p.vx > 0.5, `the dive leans toward the shuttle (vx ${p.vx.toFixed(2)})`);
  let hit = null;
  for (let t = 0; t < 20 && !hit; t++) { step(s, { ay: 1, dv: 1 }); hit = s.events.find(e => e.type === 'hit'); }
  ok(hit && hit.q < 0.5, `a diving retrieve reaches it, soft (${hit ? hit.kind + ' q ' + hit.q : 'no hit'})`);
}
{
  // difficulty levels span a real range
  const L = BM.BOT_LEVELS;
  ok(L && L.easy < L.normal && L.normal < L.hard && L.hard < L.pro && L.pro <= 1, 'bot levels run easy < normal < hard < pro');
}
{
  const s = fresh();
  const p = s.players[0];
  p.stamina = 10;
  const before = p.stamina;
  for (let t = 0; t < 60; t++) step(s, {});
  ok(p.stamina > before + 10, `stamina comes back (${Math.round(p.stamina)})`);
}
{
  const s = fresh();
  for (let i = 0; i < 8; i++) { for (let t = 0; t < 20; t++) step(s, { ax: i % 2 ? -1 : 1, sp: true }); for (let t = 0; t < 30; t++) step(s, {}); }
  ok(s.players[0].stamina > 20, `stamina survives a sprint-heavy rally (${Math.round(s.players[0].stamina)})`);
}

console.log('\n8b. running feel');
{
  // from rest to full speed, and from full speed to a stop: quick, crisp, never a snap
  const s = fresh(), p = s.players[0];
  p.x = -6 * S; p.y = 0;
  let t = 0; while (t < 60 && Math.hypot(p.vx, p.vy) < C.TOP * 0.95) { step(s, { ax: 1 }); t++; }
  ok(t >= 10 && t <= 22, `to 95% of top speed in ${t} ticks (${(t / 60).toFixed(2)} s)`);
  for (let k = 0; k < 20; k++) step(s, { ax: 1 });
  const x0 = p.x; let n = 0;
  while (n < 60 && Math.hypot(p.vx, p.vy) > 0.01) { step(s, {}); n++; }
  const slide = p.x - x0;
  ok(slide > 0.25 && slide < 0.55, `stops ${slide.toFixed(2)} m after letting go, in ${n} ticks (was a 0.7 m glide)`);
  // the last of the stop eases: the final ticks shed less speed than the braking ones
  const s2 = fresh(), q = s2.players[0]; q.x = -6 * S;
  for (let k = 0; k < 40; k++) step(s2, { ax: 1 });
  const vs = []; for (let k = 0; k < 14; k++) { step(s2, {}); vs.push(q.vx); }
  const drops = vs.slice(1).map((v, i) => vs[i] - v).filter(d => d > 1e-4);
  ok(drops.length > 2 && drops[drops.length - 1] < drops[0] * 0.6, `the stop eases in at the end (first tick sheds ${drops[0].toFixed(2)}, last ${drops[drops.length - 1].toFixed(3)} m/s)`);
  // a cut is sharper than a start
  const s3 = fresh(), r = s3.players[0]; r.x = -6 * S;
  for (let k = 0; k < 40; k++) step(s3, { ax: 1 });
  let tc = 0; while (tc < 60 && r.vx > -C.TOP * 0.9) { step(s3, { ax: -1 }); tc++; }
  ok(tc < t + 8, `a full reversal takes ${tc} ticks (a planted cut, not a slow turn)`);
}
{
  // a tap at a light stick is a small step: fine placement is possible
  const s = fresh(), p = s.players[0];
  p.x = -5 * S; p.y = 0;
  const y0 = p.y;
  for (let k = 0; k < 6; k++) step(s, { ay: 0.45 });
  for (let k = 0; k < 30; k++) step(s, {});
  const d = p.y - y0;
  ok(d > 0.1 && d < 0.5, `a short light tap moves ${d.toFixed(2)} m`);
}
{
  // placement assist: idle, the player glides to the spot beside where the shuttle will come down
  const setup = () => {
    const s = fresh(), p = s.players[0];
    p.x = -5 * S; p.y = 0.5; p.fx = 1; p.fy = 0;
    s.lastHitter = 1; s.lastKind = 'clear';
    Object.assign(s.ball, { x: 3, y: -0.8, z: 3, vx: -14, vy: -0.2, vz: 9, last: 1 });
    return { s, p };
  };
  const a = setup(); const pr = BM.predict(a.s);
  const meet = pr.high && pr.high.t < pr.land.t ? pr.high : pr.land;
  const want = { x: meet.x - 0.35, y: meet.y - 0.4 };
  const start = Math.hypot(want.x - a.p.x, want.y - a.p.y);
  let t = 0; while (t < 200 && a.s.phase === 'rally' && a.s.ball.z > 2.3) { step(a.s, { as: true }); t++; }
  const end = Math.hypot(want.x - a.p.x, want.y - a.p.y);
  ok(start > 0.4 && start < C.ASSIST_R && end < 0.25, `idle, the assist glides to the hitting spot (${start.toFixed(2)} m off -> ${end.toFixed(2)} m)`);
  const b = setup(); const bx = b.p.x, by = b.p.y;
  for (let k = 0; k < 60; k++) step(b.s, { as: false });
  ok(Math.hypot(b.p.x - bx, b.p.y - by) < 0.01, 'with the assist off, an idle player stays put');
  const c = setup();
  for (let k = 0; k < 40; k++) step(c.s, { as: true, ay: -1 });
  ok(c.p.vy < -C.TOP * 0.8, 'any direction held overrides the assist');
}

console.log('\n9. the jump');
{
  const s = fresh();
  const p = s.players[0];
  p.x = -3 * S; p.y = 0;
  step(s, { jp: 1 });
  ok(p.stamina < C.ST_MAX - C.JUMP_COST + 1, `a jump spends stamina (${p.stamina.toFixed(1)})`);
  ok(p.squat === C.JUMP_SQUAT - 1 && p.z === 0, `a press starts the crouch, feet still down (squat ${p.squat})`);
  let takeoff = -1, apex = 0, apexT = 0, landT = -1, t = 0;
  for (; t < 120; t++) {
    step(s, { jp: 1 });
    if (takeoff < 0 && p.z > 0) takeoff = t;
    if (p.z > apex) { apex = p.z; apexT = t; }
    if (takeoff >= 0 && p.z === 0 && landT < 0) { landT = t; break; }
  }
  const wantApex = C.JUMP_V * C.JUMP_V / (2 * C.PG), wantAir = 2 * C.JUMP_V / C.PG * 60;
  // the press tick is the crouch's first; takeoff is on its last
  ok(takeoff + 2 === C.JUMP_SQUAT, `takeoff on the ${C.JUMP_SQUAT}th tick of the crouch (tick ${takeoff + 2})`);
  ok(Math.abs(apex - wantApex) < 0.02, `apex ${apex.toFixed(3)} m, ballistic ${wantApex.toFixed(3)} m`);
  ok(Math.abs((landT - takeoff) - wantAir) <= 1.5, `airtime ${landT - takeoff} ticks, ballistic ${wantAir.toFixed(1)}`);
  ok(p.landT > 0, `landing costs a beat (${p.landT} ticks of heavy legs)`);
}
{
  // no air control to speak of: a jump commits you to its line
  const s = fresh();
  const p = s.players[0];
  p.x = -4 * S; p.y = 0;
  for (let t = 0; t < 30; t++) step(s, { ax: 1 });
  const vIn = p.vx;
  step(s, { ax: 1, jp: 1 });
  for (let t = 0; t < C.JUMP_SQUAT + 6; t++) step(s, { ay: 1, jp: 1 });
  ok(p.z > 0 && Math.abs(p.vy) < C.TOP * 0.35, `mid-air steering is small (vy ${p.vy.toFixed(2)} after reversing the stick; ran in at ${vIn.toFixed(1)})`);
}
{
  // out of a sprint it is a long leap
  const s = fresh();
  const p = s.players[0];
  p.x = -5 * S; p.y = -2.6 * S;
  for (let t = 0; t < 30; t++) step(s, { ay: 1, sp: true });
  step(s, { ay: 1, sp: true, jp: 1 });
  const x0 = p.y;
  let t = 0; while (t++ < 90 && !(p.z === 0 && t > 8)) step(s, { ay: 1, sp: true, jp: 1 });
  ok(p.y - x0 > 4, `a sprint-leap covers ground (${(p.y - x0).toFixed(1)} m)`);
}
{
  // cannot jump mid-dive, mid-air or without legs
  const s = fresh();
  const p = s.players[0];
  p.stamina = 3; step(s, { jp: 1 }); ok(p.squat === 0, 'no jump without the stamina for it');
}

console.log('\n10. jump smash');
{
  const stand = strike({ px: -2 * S, z: 2.3, ct: 44 });
  // the same shot met in the air at the top of a jump, from higher up
  const air = strike({ px: -2 * S, z: 3.3, ct: 44, pz: 0.74, pvz: 0.05 });
  ok(air.hit && air.hit.kind === 'jsmash' && air.hit.air === 1, `airborne full charge overhead is a jump smash (${air.hit && air.hit.kind})`);
  if (air.hit && stand.hit) ok(air.hit.kmh > stand.hit.kmh + 15, `and it is faster (${air.hit.kmh} vs ${stand.hit.kmh} km/h)`);
  const steep = r => Math.atan2(-r.s.ball.vz, Math.hypot(r.s.ball.vx, r.s.ball.vy)) * 180 / Math.PI;
  const aA = steep(air), aS = steep(stand);
  ok(aA > aS + 4, `and steeper: harder to get under (${aA.toFixed(0)} vs ${aS.toFixed(0)} degrees down)`);
  ok(air.hit && air.hit.hs >= 5, `a jump smash holds the game for ${air.hit && air.hit.hs} ticks of hit-stop`);
  // the smash left the smasher in the air: a hard landing
  const s = air.s, p = s.players[0];
  const land = (() => { for (let t = 0; t < 90; t++) { step(s, {}, {}); const e = s.events.find(e => e.type === 'land'); s.events.length = 0; if (e) return e; } return null; })();
  ok(land && land.hard === 1 && p.landT >= C.LAND_SMASH_T - 1, `a jump smash lands heavy (${land && land.hard ? 'hard' : 'soft'}, ${p.landT} ticks)`);
  // met on the way up rather than at the top is looser
  const early = strike({ px: -2 * S, z: 3.0, ct: 44, pz: 0.4, pvz: 3.6 });
  if (early.hit && air.hit) ok(early.hit.q < air.hit.q, `timing the apex matters (q ${early.hit.q} rising vs ${air.hit.q} at the top)`);
}

console.log('\n11. defending a smash');
{
  // an incoming smash (a fast shuttle heading for player 0), defended three ways
  const inV = [-50 * S * 0.5, 0, -8];
  const block = strike({ px: -3.5 * S, z: 0.9, ct: 5, inV, lastKind: 'smash' });
  ok(block.hit && block.hit.kind === 'block', `a quick tap blocks it (${block.hit && block.hit.kind})`);
  const bpt = lands(block.s).find(e => e.type === 'point');
  ok(bpt && bpt.p === 0 && Math.abs(bpt.x) < 1.3 * S, `the block dies just over the net (${bpt && bpt.x.toFixed(2)} m)`);
  const counter = strike({ px: -3.5 * S, z: 0.9, ct: 20, inV, lastKind: 'smash', oy: 2 });
  ok(counter.hit && counter.hit.kind === 'counter', `a charged release counters it (${counter.hit && counter.hit.kind}, ${counter.hit && counter.hit.kmh} km/h)`);
  const cpt = lands(counter.s).find(e => e.type === 'point');
  ok(cpt && cpt.p === 0 && cpt.y < 0, `the counter goes away from the smasher (lands y ${cpt && cpt.y.toFixed(1)}, smasher at y 2)`);
  ok(counter.hit && counter.hit.parry === 1, `met cleanly on the release it is a parry (q ${counter.hit && counter.hit.q})`);
  const lift = strike({ px: -3.5 * S, z: 0.9, ct: 8, inV, lastKind: 'smash', lob: true });
  ok(lift.hit && lift.hit.kind === 'lift', `Lift sends it high and deep (${lift.hit && lift.hit.kind})`);
  const scuffed = strike({ px: -3.5 * S, z: 0.9, ct: 20, inV, lastKind: 'smash', dx: 1.4, fx: -1 });
  ok(scuffed.hit && scuffed.hit.kind !== 'counter', `a scrambled contact cannot counter (${scuffed.hit && scuffed.hit.kind}, q ${scuffed.hit && scuffed.hit.q})`);
}

console.log('\n12. net kill');
{
  const k = strike({ px: -0.9 * S, z: 2.1, ct: 44, dx: 0.4 });
  ok(k.hit && k.hit.kind === 'kill', `a full charge on a shuttle floating over the tape is a kill (${k.hit && k.hit.kind})`);
  const t = flightTicks(k.s);
  ok(t < 30, `and it is on the floor in ${t} ticks`);
  const soft = strike({ px: -0.9 * S, z: 2.1, ct: 8, dx: 0.4 });
  ok(soft.hit && soft.hit.kind !== 'kill', `a soft touch at the tape is not (${soft.hit && soft.hit.kind})`);
}

console.log('\n13. weight');
{
  const sm = strike({ px: -1.8 * S, z: 2.3, ct: 44 });
  ok(sm.hit && sm.hit.hs >= 3 && sm.s.hitstop > 0, `a smash freezes the sim for a beat (${sm.hit && sm.hit.hs} ticks)`);
  const ball0 = { ...sm.s.ball };
  step(sm.s, {}, {});
  ok(sm.s.ball.x === ball0.x && sm.s.ball.z === ball0.z, 'during hit-stop nothing moves');
  const dr = strike({ px: -3.6 * S, z: 1.2, ct: 40 });
  ok(dr.hit && !dr.hit.hs, 'a drive has no hit-stop (it is saved for the big ones)');
  const pt = lands(sm.s).find(e => e.type === 'point');
  ok(pt && pt.slam === 1, `a smash winner comes down as a slam (${pt && pt.kmh} km/h at the floor)`);
}

console.log('\n14. bot vs bot');
{
  let ends = 0, max = 0, nan = false, faults = 0, tickTotal = 0;
  const kinds = {}; let jumps = 0;
  for (let m = 0; m < 4; m++) {
    const s = BM.createSim(0, { botSkill: 0.62, ai: true });
    let t = 0;
    for (; t < 60000; t++) {
      BM.stepSim(s, [BM.botInput(s, 0), BM.botInput(s, 1)]);
      for (const e of s.events) {
        if (e.type === 'point' && e.reason === 'fault') faults++;
        if (e.type === 'hit') kinds[e.kind] = (kinds[e.kind] || 0) + 1;
        if (e.type === 'jump') jumps++;
      }
      s.events.length = 0;
      if (t % 300 === 0 && !allFinite(s)) { nan = true; break; }
      if (s.phase === 'over') break;
    }
    tickTotal += t;
    if (s.phase === 'over') { ends++; max = Math.max(max, s.players[0].st.maxRally, s.players[1].st.maxRally); }
  }
  console.log('       shots played:', JSON.stringify(kinds), '· jumps', jumps);
  ok(!nan, `bot matches stay finite over ${tickTotal} ticks`);
  ok(ends === 4, `all four bot matches finish (${ends}/4)`);
  ok(max >= 4, `bot rallies happen (longest ${max} hits)`);
  const avgS = tickTotal / 4 / 60;
  // (flights take 1/T as long as real ones by design, so the bound scales with them)
  ok(avgS < 180 / C.T, `matches are arcade-sized (avg ${avgS.toFixed(0)} s of play, bound ${(180 / C.T).toFixed(0)})`);
  ok(faults <= 3, `almost no serve faults (${faults})`);
  ok(jumps > 0 && kinds.jsmash > 0, `the bot jumps and jump-smashes (${jumps} jumps, ${kinds.jsmash || 0} jump smashes)`);
  ok((kinds.block || 0) + (kinds.counter || 0) + (kinds.lift || 0) > 0, `the bot defends smashes (${kinds.block || 0} blocks, ${kinds.counter || 0} counters, ${kinds.lift || 0} lifts)`);
}

console.log('\n15. random-input stress');
{
  const s = BM.createSim(0, {});
  let nan = false, badEvent = null;
  const rnd = Math.random;
  for (let t = 0; t < 20000; t++) {
    const mk = () => I({
      u: rnd() < 0.25, d: rnd() < 0.25, l: rnd() < 0.25, r: rnd() < 0.25,
      k: rnd() < 0.5, kp: rnd() < 0.2 ? ((t / 3) | 0) : 0, kc: rnd() < 0.2 ? (rnd() * 90) | 0 : null,
      dv: rnd() < 0.03 ? t : 0, sp: rnd() < 0.3, jp: rnd() < 0.05 ? t : 0, kn: rnd() < 0.05 ? t : 0, lob: rnd() < 0.3,
      ax: rnd() < 0.4 ? rnd() * 2 - 1 : 0, ay: rnd() < 0.4 ? rnd() * 2 - 1 : 0,
    });
    BM.stepSim(s, [mk(), mk()]);
    for (const e of s.events) for (const v of Object.values(e)) if (typeof v === 'number' && !Number.isFinite(v)) badEvent = e;
    s.events.length = 0;
    if (t % 250 === 0 && (!allFinite(s) || s.players.some(p => p.z < 0))) { nan = true; break; }
  }
  ok(!nan, 'random play stays finite (and on or above the floor) over 20k ticks');
  ok(!badEvent, `events carry finite numbers${badEvent ? ' (' + JSON.stringify(badEvent) + ')' : ''}`);
}

console.log('\n16. snapshot shape');
{
  const s = BM.createSim(0, {});
  const st = BM.netState(s);
  ok(st.p.every(a => a.length === 21 && a.every(finite)), 'player entries are complete and finite');
  ok(st.b.every(finite) && st.b.length === 6, 'shuttle entry is position + velocity');
  JSON.stringify(st);
  const bi = BM.botInput(s, 0);
  ok('dv' in bi && 'sp' in bi && 'jp' in bi && 'kn' in bi && 'lob' in bi, 'bot inputs carry the shared input shape');
}

console.log(`\n${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
