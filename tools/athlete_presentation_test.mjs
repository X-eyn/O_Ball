import assert from 'node:assert/strict';
import { Quaternion, Vector3, BufferGeometry, Float32BufferAttribute, Uint16BufferAttribute } from 'three';
import { sampleCelebration, samplePointCelebration, setGripSpin, CELEBRATION_DURATION } from '../public/badminton/celebration.mjs';
import { prepareBadmintonKit, BadmintonApparel } from '../public/badminton/apparel.js';

const garment = (y, x) => {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([x, y, 0.11, x + 0.03, y, 0.11, x, y + 0.04, 0.11], 3));
  g.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setAttribute('uv', new Float32BufferAttribute([0.2, 0.3, 0.3, 0.3, 0.2, 0.4], 2));
  g.setAttribute('skinIndex', new Uint16BufferAttribute(new Array(12).fill(0), 4));
  g.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  g.setIndex([0, 1, 2]);
  return g;
};
const kit = { shirt: garment(0.99, 0.1), shorts: garment(0.72, 0.13), socks: garment(0.2, 0.13), boots: garment(0.05, 0.13) };
const original = Float32Array.from(kit.shirt.attributes.position.array);
const prepared = prepareBadmintonKit(kit);
assert.equal(prepareBadmintonKit(kit), prepared, 'bind-pose drape is prepared once per shared kit');
assert.notEqual(prepared.shirt, kit.shirt, 'badminton owns its shirt geometry');
assert.deepEqual(kit.shirt.attributes.position.array, original, 'football geometry is unchanged');
assert.deepEqual(prepared.shirt.attributes.skinWeight.array, kit.shirt.attributes.skinWeight.array, 'original skin weights retained');
assert.ok(prepared.shirt.attributes.position.getZ(0) > kit.shirt.attributes.position.getZ(0), 'cloth silhouette expands outward');
assert.equal(prepared.shadow.attributes.position.count, 12, 'shadow includes shirt, shorts, socks and boots');
assert.equal(prepared.shadow.attributes.clothEdge.count, 12, 'shadow uses the same bounded cloth motion');
// Real kit regressions: concave underarm and inner thigh normals disagree with radial directions.
for (const [kind, point, normal] of [
  ['shirt', [0.2163990736, 1.3717418909, -0.1084857807], [-0.6905655265, -0.7229454517, -0.0216599870]],
  ['shorts', [0.0051813312, 0.6934129596, -0.0231829453], [0.9995906949, -0.0085553881, -0.0273001753]],
]) {
  const g = garment(point[1], point[0]);
  for (let i = 0; i < g.attributes.position.count; i++) {
    g.attributes.position.setXYZ(i, point[0] + (i === 1 ? 0.001 : 0), point[1] + (i === 2 ? 0.001 : 0), point[2]);
    g.attributes.normal.setXYZ(i, ...normal);
  }
  const fixture = { ...kit, [kind]: g }, fixed = prepareBadmintonKit(fixture)[kind];
  const oldPosition = new Vector3().fromBufferAttribute(g.attributes.position, 0);
  const displacement = new Vector3().fromBufferAttribute(fixed.attributes.position, 0).sub(oldPosition);
  const sourceNormal = new Vector3(...normal).normalize();
  assert.ok(displacement.dot(sourceNormal) >= -1e-8, `${kind} drape stays outward from the source surface`);
  assert.ok(new Vector3().fromBufferAttribute(fixed.attributes.clothOut, 0).dot(sourceNormal) >= -1e-8,
    `${kind} GPU motion cannot push through the source surface`);
  if (kind === 'shorts') assert.ok(fixed.attributes.position.getX(0) > 0, 'inner-thigh cloth cannot cross the center seam');
}
// Existing garments are triangle-expanded after smooth normals have been computed. UV seam
// duplicates must keep smooth lighting while every original UV and skin-weight value survives.
const curved = new BufferGeometry();
curved.setAttribute('position', new Float32BufferAttribute([0.1, 1, 0.11, 0.14, 1, 0.12, 0.1, 1.04, 0.12, 0.14, 1.04, 0.15], 3));
curved.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
curved.setAttribute('skinIndex', new Uint16BufferAttribute(new Array(16).fill(0), 4));
curved.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
curved.setIndex([0, 1, 2, 1, 3, 2]); curved.computeVertexNormals();
const split = curved.toNonIndexed(); split.attributes.uv.setX(3, 0);
const smoothKit = { shirt: split, shorts: split, socks: split, boots: split }, smoothShirt = prepareBadmintonKit(smoothKit).shirt;
assert.ok(new Vector3().fromBufferAttribute(smoothShirt.attributes.normal, 1).distanceTo(new Vector3().fromBufferAttribute(smoothShirt.attributes.normal, 3)) < 1e-6,
  'triangle and UV-seam duplicates share smooth normals after draping');
assert.deepEqual(smoothShirt.attributes.uv.array, split.attributes.uv.array, 'authored UV seam survives normal smoothing');
assert.deepEqual(smoothShirt.attributes.skinWeight.array, split.attributes.skinWeight.array, 'normal smoothing never changes skin weights');
const crotch = garment(0.9, 0).toNonIndexed();
crotch.attributes.position.array.set([-0.0023850594, 0.8909067512, 0.0471214280, -0.0013262840, 0.8939880133, 0.0679367632, 3.1776125e-8, 0.8977051973, 0.0804049000]);
crotch.attributes.normal.array.set([-0.3578279018, -0.9172116518, 0.1751628816, 0.0041986322, 0.9688624144, -0.2475640178, -0.0484276116, -0.8440750241, 0.5340338349]);
const crotchKit = { shirt: crotch, shorts: crotch, socks: crotch, boots: crotch }, safeCrotch = prepareBadmintonKit(crotchKit).shorts;
const face = positions => {
  const a = new Vector3().fromBufferAttribute(positions, 0), b = new Vector3().fromBufferAttribute(positions, 1), c = new Vector3().fromBufferAttribute(positions, 2);
  return b.sub(a).cross(c.sub(a)).normalize();
};
assert.ok(face(crotch.attributes.position).dot(face(safeCrotch.attributes.position)) > 0,
  'drape preserves winding at the real narrow crotch seam instead of inverting cloth faces');
const cloth = Object.create(BadmintonApparel.prototype);
cloth.uniforms = { time: { value: 0 }, motion: { value: 0 } }; cloth.reset();
for (let i = 0; i < 2000; i++) {
  cloth.update(i % 7 ? 1 / 60 : 2, i % 13 ? 0 : 50, i % 3 ? 0 : 1);
  assert.ok(cloth.uniforms.motion.value >= 0 && cloth.uniforms.motion.value <= 1, 'secondary cloth motion stays bounded under speed spikes');
}
const pausedTime = cloth.uniforms.time.value, pausedMotion = cloth.uniforms.motion.value;
cloth.update(0, 20, 1);
assert.equal(cloth.uniforms.time.value, pausedTime, 'paused cloth time freezes');
assert.equal(cloth.uniforms.motion.value, pausedMotion, 'paused cloth response freezes');
cloth.reset();
assert.equal(cloth.uniforms.motion.value, 0, 'replay reset clears cloth motion');

const base = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.73);
const q = new Quaternion(), axisPoint = new Vector3(0, 0.12, 0);
let previous = 0;
for (let i = 0; i < 120; i++) {
  const s = sampleCelebration(i * CELEBRATION_DURATION / 120, 0);
  assert.ok(s.angle >= previous - 1e-10, 'flourish progresses through the full rotation');
  previous = s.angle;
  setGripSpin(q, base, s.angle);
  assert.ok(axisPoint.clone().applyQuaternion(q).distanceTo(axisPoint.clone().applyQuaternion(base)) < 1e-10,
    'the handle stays centered on the grip axis throughout the rotation');
  assert.ok(s.weight >= 0 && s.weight <= 1);
}
assert.equal(sampleCelebration(0.9, 0).angle, 2 * Math.PI, 'rotation completes before the return to ready');
for (const variant of [0, 1, 2]) {
  assert.equal(sampleCelebration(0, variant).weight, 0, 'start matches ready pose');
  assert.equal(sampleCelebration(CELEBRATION_DURATION, variant).weight, 0, 'finish matches ready pose');
  assert.equal(sampleCelebration(null, variant).angle, 0, 'an interrupted celebration is neutral');
  assert.equal(sampleCelebration(-1, variant).weight, 0);
}
setGripSpin(q, base, sampleCelebration(null, 0).angle);
assert.ok(q.angleTo(base) < 1e-7, 'interruption restores the original grip quaternion');
assert.equal(sampleCelebration(0.6, 1).angle, 0, 'fist pump does not rotate the grip');
assert.equal(sampleCelebration(0.6, 2).angle, 0, 'salute does not rotate the grip');
// Exercise the same state driver Athlete.update uses, including interruption and readiness
// returning during the same point. A canceled spin must never resume at a mid-turn angle.
const pointState = {};
samplePointCelebration(pointState, 0, 0, true);
assert.ok(samplePointCelebration(pointState, 0.3, 0, true).angle > 0, 'point starts a real flourish');
assert.equal(samplePointCelebration(pointState, 0.35, 0, false).angle, 0, 'movement interrupts the flourish immediately');
assert.equal(samplePointCelebration(pointState, 0.5, 0, true).angle, 0, 'readiness cannot resume a canceled point mid-spin');
assert.equal(samplePointCelebration(pointState, 0.8, 0, true).weight, 0, 'cancellation persists for this point');
samplePointCelebration(pointState, null, 0, false);
samplePointCelebration(pointState, 0, 0, true);
assert.ok(samplePointCelebration(pointState, 0.6, 0, true).angle > 0, 'a new point can celebrate again');
samplePointCelebration(pointState, 0, 0, true);
assert.equal(pointState.celebrationCancelled, false, 'decreasing server point age clears prior cancellation');
const landingState = {};
samplePointCelebration(landingState, 0, 0, false);
assert.equal(samplePointCelebration(landingState, 0.3, 0, true).angle, 0, 'landing delays initial flourish without skipping anticipation');
assert.ok(samplePointCelebration(landingState, 0.6, 0, true).angle > 0, 'delayed start progresses smoothly from neutral');
console.log('Athlete presentation: drape cache/isolation, outward surface protection, smooth UV-seam normals, retained skin weights, crotch winding, matching shadow, bounded cloth, grip rotation and real interruption state transitions passed.');
