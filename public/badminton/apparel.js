// Badminton kit preparation is independent of Human's football assets. One bind-pose geometry
// per asset kit is shared by all athletes; only small shader uniforms move each athlete's cloth.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const VERSION = 'badminton-drape-3';
const prepared = new WeakMap();
const clamp = x => Math.max(0, Math.min(1, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

function smoothDrapedNormals(geo, source) {
  const position = geo.attributes.position, original = source.attributes.position, normals = source.attributes.normal;
  const sums = [], groups = new Int32Array(position.count), shared = new Map();
  // The football kit expands smooth indexed geometry into UV-seamed triangles. Restore only
  // its original smoothing groups; never weld UVs, vertex records, skin indices, or weights.
  for (let i = 0; i < position.count; i++) {
    const key = [original.getX(i), original.getY(i), original.getZ(i)].map(v => v.toFixed(6)).join(',') + '|' +
      [normals.getX(i), normals.getY(i), normals.getZ(i)].map(v => v.toFixed(5)).join(',');
    let group = shared.get(key);
    if (group === undefined) { group = sums.length; shared.set(key, group); sums.push(new THREE.Vector3()); }
    groups[i] = group;
  }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), face = new THREE.Vector3();
  const count = geo.index ? geo.index.count : position.count;
  for (let t = 0; t < count; t += 3) {
    const ia = geo.index ? geo.index.getX(t) : t, ib = geo.index ? geo.index.getX(t + 1) : t + 1, ic = geo.index ? geo.index.getX(t + 2) : t + 2;
    a.fromBufferAttribute(position, ia); b.fromBufferAttribute(position, ib); c.fromBufferAttribute(position, ic);
    face.crossVectors(b.sub(a), c.sub(a)); // area-weighted, shared across the original smooth sheet
    sums[groups[ia]].add(face); sums[groups[ib]].add(face); sums[groups[ic]].add(face);
  }
  for (const sum of sums) sum.normalize();
  const output = geo.attributes.normal;
  for (let i = 0; i < position.count; i++) {
    const sum = sums[groups[i]];
    if (sum.lengthSq() > 0) output.setXYZ(i, sum.x, sum.y, sum.z);
    else output.setXYZ(i, normals.getX(i), normals.getY(i), normals.getZ(i));
  }
}

function drape(source, kind) {
  const geo = source.clone(), p = geo.attributes.position;
  const edge = new Float32Array(p.count), phase = new Float32Array(p.count), out = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    let dx = 0, dy = 0, dz = 0, loose = 0, edgeW = 0, freedom = 1;
    if (kind === 'shirt') {
      const sleeve = smooth(0.205, 0.255, Math.abs(x));
      // Sleeve cloth expands perpendicular to the arm axis. Torso drape expands about the
      // body's vertical center, bridging the waist instead of hugging the abdomen.
      const r = Math.hypot(x, z + 0.02) || 1, sr = Math.hypot(y - 1.455, z + 0.065) || 1;
      dx = x / r * (1 - sleeve);
      dy = (y - 1.455) / sr * sleeve;
      dz = (z + 0.02) / r * (1 - sleeve) + (z + 0.065) / sr * sleeve;
      edgeW = Math.max((1 - smooth(0.98, 1.16, y)) * (1 - sleeve), smooth(0.26, 0.37, Math.abs(x)) * sleeve);
      loose = (0.006 + 0.011 * (1 - smooth(1.02, 1.42, y))) * (1 - sleeve) + (0.008 + 0.011 * edgeW) * sleeve;
      // Keep the neckline and yoke seated while releasing the hem and sleeve openings.
      loose *= 1 - smooth(1.43, 1.56, y) * (1 - sleeve);
    } else if (kind === 'shorts') {
      // Preserve the fitted gusset: a discontinuous sign(x) center pulled adjacent center-seam
      // triangles onto opposite legs. Blend the leg axes and release cloth outside the gusset.
      const cx = Math.tanh(x / 0.035) * 0.114, r = Math.hypot(x - cx, z + 0.025) || 1;
      dx = (x - cx) / r; dz = (z + 0.025) / r;
      freedom = smooth(0.009, 0.07, Math.abs(x));
      edgeW = (1 - smooth(0.7, 0.86, y)) * freedom;
      loose = 0.005 + 0.016 * (1 - smooth(0.72, 1.055, y));
    }
    let len = Math.hypot(dx, dy, dz) || 1; dx /= len; dy /= len; dz /= len;
    if (kind) {
      // Radial release alone points INTO skin at concave armpits and inner thighs. Keep the
      // tangent direction, but require a positive source-normal component for baked and GPU
      // offsets. The small margin also avoids float rounding turning a tangent move inward.
      const normal = source.attributes.normal, nlen = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)) || 1;
      const nx = normal.getX(i) / nlen, ny = normal.getY(i) / nlen, nz = normal.getZ(i) / nlen;
      const projection = dx * nx + dy * ny + dz * nz, correction = Math.max(0, 0.2 - projection);
      dx += nx * correction; dy += ny * correction; dz += nz * correction;
      len = Math.hypot(dx, dy, dz) || 1; dx /= len; dy /= len; dz /= len;
    }
    // Baked soft folds are always outside the original garment surface. No skinning weights
    // change, no per-frame CPU geometry writes, and the tiny moving amplitude is outward too.
    const wave = Math.sin(x * 64 + y * 32) * Math.sin(z * 53 + y * 20);
    const fold = kind ? (0.002 + wave * 0.0018) * (0.25 + 0.75 * edgeW) : 0;
    p.setXYZ(i, x + dx * (loose + fold) * freedom, y + dy * (loose + fold) * freedom, z + dz * (loose + fold) * freedom);
    out.set([dx, dy, dz], i * 3); edge[i] = edgeW; phase[i] = x * 27 + y * 19 + z * 41;
  }
  geo.setAttribute('clothOut', new THREE.BufferAttribute(out, 3));
  geo.setAttribute('clothEdge', new THREE.BufferAttribute(edge, 1));
  geo.setAttribute('clothPhase', new THREE.BufferAttribute(phase, 1));
  if (kind) smoothDrapedNormals(geo, source);
  geo.computeBoundingSphere();
  return geo;
}

export function prepareBadmintonKit(kit) {
  if (prepared.has(kit)) return prepared.get(kit);
  const shirt = drape(kit.shirt, 'shirt'), shorts = drape(kit.shorts, 'shorts');
  const pieces = [shirt, shorts, drape(kit.socks, null), drape(kit.boots, null)];
  // A single shadow caster follows precisely the same drape and edge motion as the visible kit.
  const shadows = pieces.map(piece => {
    const g = new THREE.BufferGeometry();
    for (const key of ['position', 'normal', 'skinIndex', 'skinWeight', 'clothOut', 'clothEdge', 'clothPhase']) g.setAttribute(key, piece.attributes[key]);
    g.setIndex(piece.index); return g;
  });
  const kitPrepared = { shirt, shorts, shadow: mergeGeometries(shadows), version: VERSION };
  // Temporary non-garment clones are used only to build the combined shadow geometry.
  pieces[2].dispose(); pieces[3].dispose();
  prepared.set(kit, kitPrepared); return kitPrepared;
}

function animateMaterial(material, uniforms) {
  material.onBeforeCompile = shader => {
    shader.uniforms.clothTime = uniforms.time;
    shader.uniforms.clothMotion = uniforms.motion;
    shader.vertexShader = `attribute vec3 clothOut;\nattribute float clothEdge;\nattribute float clothPhase;\nuniform float clothTime;\nuniform float clothMotion;\n` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      if (clothMotion > 0.001) {
        float clothWave = 0.5 + 0.5 * sin(clothTime * 8.5 + clothPhase);
        transformed += clothOut * clothEdge * clothMotion * (0.0008 + 0.0032 * clothWave);
      }`);
  };
  material.customProgramCacheKey = () => VERSION;
  material.needsUpdate = true;
}

let fabricMaps = null;
function loadFabricMaps() {
  if (fabricMaps) return fabricMaps;
  const loader = new THREE.TextureLoader();
  const load = path => new Promise(resolve => loader.load(path, t => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(22, 22); t.anisotropy = 4;
    resolve(t);
  }, undefined, () => resolve(null)));
  fabricMaps = Promise.all([load('/badminton/assets/fabric-normal.jpg'), load('/badminton/assets/fabric-roughness.jpg')]);
  return fabricMaps;
}

function paintShirt(canvas, kit, look) {
  const g = canvas.getContext('2d'), W = canvas.width, torso = W * 0.7;
  const base = '#' + new THREE.Color(kit.shirt).getHexString();
  const panel = '#' + new THREE.Color(kit.shirt).multiplyScalar(0.24).lerp(new THREE.Color(0x111a29), 0.35).getHexString();
  const trim = '#e8efef';
  g.fillStyle = base; g.fillRect(0, 0, W, W);
  // Dark breathing panels, seam piping, and a tailored shoulder yoke; UVs stay entirely on cloth.
  g.fillStyle = panel; g.fillRect(0, 0, W, 34);
  for (const u of [0, 0.5, 1]) {
    const x = u * W;
    g.fillStyle = panel; g.beginPath(); g.moveTo(x - 16, 90); g.lineTo(x + 16, 90);
    g.lineTo(x + 29, torso); g.lineTo(x - 29, torso); g.fill();
    g.strokeStyle = trim; g.globalAlpha = 0.55; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x - 17, 98); g.lineTo(x - 30, torso); g.moveTo(x + 17, 98); g.lineTo(x + 30, torso); g.stroke(); g.globalAlpha = 1;
  }
  // Collar binding follows the existing round/V neck; fine twin stitches frame each opening.
  g.fillStyle = panel; g.fillRect(0, 0, W, 8);
  g.strokeStyle = trim; g.lineWidth = 1.5; g.beginPath(); g.moveTo(W * 0.205, 8); g.lineTo(W * 0.25, 39); g.lineTo(W * 0.295, 8); g.stroke();
  g.fillStyle = panel; g.fillRect(0, torso - 9, W, 9);
  g.fillStyle = base; g.fillRect(0, torso, W, W - torso);
  g.fillStyle = panel; g.fillRect(0, W - 17, W, 17);
  g.strokeStyle = trim; g.globalAlpha = 0.35; g.setLineDash([2, 3]);
  for (const y of [torso - 12, torso - 15, W - 20, W - 23]) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  g.setLineDash([]); g.globalAlpha = 1;
  // Restrained chest emblem and player name, sized for a badminton team jersey.
  g.fillStyle = trim; g.beginPath(); g.moveTo(W * 0.328, 70); g.lineTo(W * 0.347, 70); g.lineTo(W * 0.3375, 79); g.fill();
  const name = (look?.name || '').toUpperCase().slice(0, 14);
  g.font = '600 21px "Barlow Condensed", sans-serif'; g.textAlign = 'center'; g.fillText(name, W * 0.75, 83, W * 0.26);
}

function paintShorts(canvas, kit) {
  const g = canvas.getContext('2d'), W = canvas.width;
  g.fillStyle = '#' + new THREE.Color(kit.shorts).multiplyScalar(0.68).getHexString(); g.fillRect(0, 0, W, W);
  g.fillStyle = '#151c26'; g.fillRect(0, 0, W, 18);
  g.fillStyle = '#' + new THREE.Color(kit.shirt).getHexString();
  for (const x of [0, W / 2, W]) { g.fillRect(x - 9, 18, 18, W - 27); }
  g.strokeStyle = 'rgba(225,235,239,.45)'; g.lineWidth = 1; g.setLineDash([2, 2]);
  for (const y of [7, 12, W - 7, W - 11]) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  g.setLineDash([]);
}

export class BadmintonApparel {
  constructor(h, assets) {
    this.uniforms = { time: { value: 0 }, motion: { value: 0 } };
    this.speed = 0; this.response = 0; this.time = 0;
    const kit = prepareBadmintonKit(assets.kit);
    h.root.traverse(o => {
      if (!o.isSkinnedMesh) return;
      const type = o.material === h.m.shirt ? 'shirt' : o.material === h.m.shorts ? 'shorts' : null;
      if (type) { o.geometry = kit[type]; animateMaterial(o.material, this.uniforms); }
      else if (o.geometry === assets.kitShadow) {
        o.geometry = kit.shadow;
        o.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
        o.customDistanceMaterial = new THREE.MeshDistanceMaterial({ side: THREE.DoubleSide });
        animateMaterial(o.customDepthMaterial, this.uniforms); animateMaterial(o.customDistanceMaterial, this.uniforms);
      }
    });
    for (const m of [h.m.shirt, h.m.shorts]) {
      m.roughness = 0.88; m.normalScale?.set(0.2, 0.2);
      if (m.isMeshPhysicalMaterial) { m.sheen = 0.48; m.sheenRoughness = 0.82; m.sheenColor.setHex(0x707780); }
    }
    if (!assets.lite) loadFabricMaps().then(([normal, roughness]) => {
      for (const m of [h.m.shirt, h.m.shorts]) {
        if (normal) m.normalMap = normal;
        if (roughness) m.roughnessMap = roughness;
        m.needsUpdate = true;
      }
    });
    const originalPaint = h.paint.bind(h);
    h.paint = () => {
      originalPaint(); // preserves the sport-independent socks and shoes customization
      paintShirt(h.cv.shirt, h.kit, h.look); paintShorts(h.cv.shorts, h.kit);
      h.tx.shirt.needsUpdate = h.tx.shorts.needsUpdate = true;
    };
  }
  reset() { this.speed = this.response = this.time = 0; this.uniforms.time.value = this.uniforms.motion.value = 0; }
  update(dt, speed, strokeWeight) {
    if (!(dt > 0)) return;
    const step = Math.min(dt, 0.1), acceleration = Math.min(1, Math.abs(speed - this.speed) / (step * 32));
    const target = clamp(speed / 8.5 * 0.72 + acceleration * 0.22 + strokeWeight * 0.22);
    // At rest the baked drape is the complete surface. Keep uniforms stable across all passes.
    if (target === 0 && this.response < 0.001) {
      this.speed = speed; this.response = 0; this.uniforms.motion.value = 0; return;
    }
    this.response += (target - this.response) * (1 - Math.exp(-12 * step));
    this.speed = speed; this.time += step;
    this.uniforms.time.value = this.time; this.uniforms.motion.value = this.response;
  }
}
