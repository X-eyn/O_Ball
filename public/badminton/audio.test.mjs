import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const helpers = await import('./audio-voices.mjs').catch(() => ({}));

test('game audio bundle preserves all source recordings exactly', () => {
  const bank = JSON.parse(readFileSync(new URL('./assets/audio-bank.json', import.meta.url)));
  assert.equal(bank.version, 2);
  const SHOE_KINDS = { tap: 8, step: 8, scuff: 6, squeak: 8, squeal: 6 };
  const files = { racket: 'racket.mp3', applause: 'applause.mp3', rustle: 'rustle.mp3', ...Object.fromEntries(Object.entries(SHOE_KINDS).flatMap(([kind, n]) => Array.from({ length: n }, (_, i) => [`court_${kind}${i}`, `court-${kind}-${String(i + 1).padStart(2, '0')}.wav`]))) };
  assert.deepEqual(Object.keys(bank.samples).sort(), Object.keys(files).sort());
  for (const [name, filename] of Object.entries(files)) {
    const asset = bank.samples[name], bytes = Buffer.from(asset.data, 'base64');
    assert.equal(asset.bytes, bytes.length);
    assert.equal(asset.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(bytes, readFileSync(new URL('./assets/' + filename, import.meta.url)));
  }
});

test('audio voices evict old sounds and release every resource exactly once', () => {
  assert.equal(typeof helpers.createVoicePool, 'function', 'voice resource pool is required');
  const pool = helpers.createVoicePool(3), released = [];
  const a = pool.add(() => released.push('a'));
  const b = pool.add(() => released.push('b'));
  pool.add(() => released.push('c'));
  const d = pool.add(() => released.push('d'));
  assert.equal(pool.size, 3);
  assert.deepEqual(released, ['a']);
  a.finish(); b.finish(); b.finish();
  assert.deepEqual(released, ['a', 'b']);
  assert.equal(pool.size, 2);
  pool.clear(); d.finish();
  assert.deepEqual(released, ['a', 'b', 'c', 'd']);
  assert.equal(pool.size, 0);
});

test('court panning follows camera orientation and centers invalid positions', () => {
  assert.equal(typeof helpers.courtPan, 'function', 'court panning is required');
  const a = { pos: [0, 8, 12], target: [0, 0, 0] };
  const b = { pos: [0, 8, -12], target: [0, 0, 0] };
  assert.equal(helpers.courtPan({ x: 4, y: 0, z: 1 }, a), 0.5);
  assert.equal(helpers.courtPan({ x: 4, y: 0, z: 1 }, b), -0.5);
  assert.equal(helpers.courtPan({ x: 200, y: 0 }, a), 0.85);
  assert.equal(helpers.courtPan({}, a), 0);
  assert.equal(helpers.courtPan({ x: 4, y: 0 }, null), 0);
});

test('recorded footsteps follow actual foot plants, not body travel or idle pose resets', () => {
  assert.equal(typeof helpers.createFootContactTracker, 'function');
  const tracker = helpers.createFootContactTracker(), p = Array(21).fill(0), events = [];
  p[2] = 4;
  const fw = { feet: { L: { st: 'plant', x: 0, z: 0 }, R: { st: 'plant', x: .2, z: 0 } } };
  const update = (dt = 1 / 60, live = true) => tracker.update([p], [{fw}], dt, live, (...e) => events.push(e));
  update();
  for (let i = 0; i < 60; i++) { p[0] += .06; update(); }
  assert.equal(events.length, 0, 'body travel alone cannot produce a footstep');
  fw.feet.L.st = 'swing'; update();
  fw.feet.L.x = .4; fw.feet.L.st = 'plant'; update();
  assert.equal(events.length, 1); assert.equal(events[0][0].x, .4);
  for (let i = 0; i < 10; i++) update();
  assert.equal(events.length, 1, 'holding a planted foot never retriggers');
  for (const field of [8, 14, 17, 20]) {
    p[field] = 1; fw.feet.R.st = 'swing'; update();
    fw.feet.R.x += .4; fw.feet.R.st = 'plant'; update(); p[field] = 0; update();
  }
  fw.feet.R.st = 'swing'; update(); p[0] += 10; fw.feet.R.st = 'plant'; update();
  fw.feet.L.st = 'swing'; update(); fw.feet.L.st = 'plant'; update(1, true);
  update(0, false); fw.feet.R.st = 'swing'; update(); fw.feet.R.st = 'plant'; update(0, true);
  assert.equal(events.length, 1, 'air, land recovery, teleports, stalls and pauses cannot catch up');
});

test('fast footwork is thinned: shuffles stay silent and plants are spaced out', () => {
  const tracker = helpers.createFootContactTracker(), p = Array(21).fill(0), events = [];
  p[2] = 5;
  const fw = { feet: { L: { st: 'plant', x: 0, z: 0 }, R: { st: 'plant', x: 0, z: 0 } } };
  const update = () => tracker.update([p], [{fw}], 1 / 60, true, (...e) => events.push(e));
  update(); for (let i = 0; i < 60; i++) update();
  fw.feet.L.st = 'swing'; update(); fw.feet.L.x += .05; fw.feet.L.st = 'plant'; update();
  assert.equal(events.length, 0, 'a small shuffle is silent');
  // One second of alternating strides, a plant every 100 ms.
  for (let i = 0; i < 10; i++) {
    const f = fw.feet[i % 2 ? 'R' : 'L'];
    f.st = 'swing'; update(); f.x += .4; f.st = 'plant'; update();
    for (let k = 0; k < 4; k++) update();
  }
  assert.ok(events.length >= 3 && events.length <= 4, `ten plants in a second voice 3-4 steps, got ${events.length}`);
});

test('footstep take selection varies recordings without immediate repeats', () => {
  assert.equal(typeof helpers.createTakeSelector, 'function');
  const select = helpers.createTakeSelector(8, () => .5), takes = [];
  for (let i = 0; i < 80; i++) takes.push(select());
  assert.ok(takes.every((v, i) => v >= 0 && v < 8 && (!i || v !== takes[i - 1])));
});

test('baked shoe takes have bounded peaks, smooth edges and distinct real PCM', () => {
  const hashes = new Set();
  const LEN = { tap: .16, step: .18, scuff: .2, squeak: .26, squeal: .42 };
  const takes = Object.entries({ tap: 8, step: 8, scuff: 6, squeak: 8, squeal: 6 }).flatMap(([kind, n]) => Array.from({ length: n }, (_, i) => [`court-${kind}-${String(i + 1).padStart(2, '0')}.wav`, LEN[kind]]));
  for (const [file, seconds] of takes) {
    const wav = readFileSync(new URL(`./assets/${file}`, import.meta.url));
    assert.equal(wav.toString('ascii',0,4),'RIFF'); assert.equal(wav.toString('ascii',8,12),'WAVE');
    let samples;
    for (let at=12;at+8<=wav.length;){
      const size=wav.readUInt32LE(at+4), name=wav.toString('ascii',at,at+4), data=at+8;
      if(name==='fmt '){assert.equal(wav.readUInt16LE(data),1);assert.equal(wav.readUInt16LE(data+2),1);assert.equal(wav.readUInt32LE(data+4),48000);assert.equal(wav.readUInt16LE(data+14),16);}
      if(name==='data')samples=wav.subarray(data,data+size);
      at=data+size+(size%2);
    }
    assert.ok(samples);assert.equal(samples.length,Math.round(48000*seconds)*2);
    let peak=0,energy=0;for(let at=0;at<samples.length;at+=2){const value=samples.readInt16LE(at)/32768;peak=Math.max(peak,Math.abs(value));energy+=value*value;}
    assert.ok(peak>.1&&peak<=10**(-10.45/20),'audible natural contact, limited to -10.5 dBFS');
    const rmsDb=20*Math.log10(Math.sqrt(energy/(samples.length/2)));
    assert.ok(rmsDb>=-41&&rmsDb<=-24,'takes have a controlled body (scuffs are mostly transient, squeals sustained)');
    assert.equal(samples.readInt16LE(0),0);assert.equal(samples.readInt16LE(samples.length-2),0);
    hashes.add(createHash('sha256').update(samples).digest('hex'));
  }
  assert.equal(hashes.size,takes.length,'separate takes, rather than pitched copies of one');
});

test('each plant is voiced by the movement: taps, steps, cuts, lunges, landings', () => {
  const v = helpers.shoeVoice;
  assert.equal(v({ speed: 0.8 }), 'tap', 'split-steps and slow footwork are soft taps');
  assert.equal(v({ speed: 4 }), 'step');
  assert.equal(v({ speed: 4, turn: 1.4 }), 'cut', 'a sharp change of direction scuffs');
  assert.equal(v({ speed: 1.5, turn: 1.4 }), 'tap', 'turning on the spot is not a cut');
  assert.equal(v({ speed: 3, lunge: 0.8 }), 'lunge');
  assert.equal(v({ speed: 0.6, brake: 6 }), 'lunge', 'a hard stop at a corner bites like a lunge');
  assert.equal(v({ hard: true, speed: 5, lunge: 1 }), 'land', 'a landing wins over everything');
});

test('the contact tracker reports a cut and a lunge, and lets accents through sooner', () => {
  const tracker = helpers.createFootContactTracker(), p = Array(21).fill(0), events = [];
  const A = { lungeW: 0 };
  const fw = { feet: { L: { st: 'plant', x: 0, z: 0 }, R: { st: 'plant', x: 0, z: 0 } } };
  const update = () => tracker.update([p], [Object.assign(A, { fw })], 1 / 60, true, (...e) => events.push(e));
  p[2] = 5; for (let i = 0; i < 60; i++) update(); // running along x for a second
  const plant = side => { const f = fw.feet[side]; f.st = 'swing'; update(); f.x += .4; f.st = 'plant'; update(); };
  plant('L');
  assert.equal(events.length, 1); assert.ok(events[0][4].turn < 0.2 && events[0][4].lunge === 0, 'a straight run plant');
  p[2] = -5; plant('R'); // reversed: a hard cut, 2 frames after the last voiced plant
  for (let i = 0; i < 6; i++) update();
  plant('L');
  assert.equal(events.length, 2, 'the cut speaks before the ordinary step gap');
  assert.ok(events[1][4].turn > 2, 'reported as a sharp turn');
  // a hard stop: from running to standing within a quarter second
  p[2] = 6; for (let i = 0; i < 40; i++) update(); p[2] = 0.5; for (let i = 0; i < 8; i++) update(); plant('R');
  assert.equal(events.length, 3); assert.ok(events[2][4].brake > 3.5, 'reported as braking');
  p[2] = -5; for (let i = 0; i < 30; i++) update();
  A.lungeW = 1; for (let i = 0; i < 8; i++) update(); plant('R');
  assert.equal(events.length, 4); assert.equal(events[3][4].lunge, 1);
});
