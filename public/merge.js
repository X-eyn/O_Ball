// Office Ball — static geometry, drawn in as few calls as possible.
//
// Every separate mesh costs a draw call in every pass that draws it (the main pass, each floodlight's
// shadow map, the AO pass), and on a phone the CPU time spent issuing those calls, not the GPU, is
// what caps the frame rate. The stadium, the ad boards and the LED ribbons never move, so after they
// are built their meshes are merged: one mesh per material, positions baked in world space. The
// picture is identical; the draw calls drop from dozens to a handful.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// a multi-material mesh (a box with a different material per face) as one piece per material
function pieces(mesh) {
  const g = mesh.geometry, mats = Array.isArray(mesh.material) ? mesh.material : null;
  if (!mats) return [{ geometry: g, material: mesh.material }];
  const byMat = new Map();
  for (const grp of g.groups) {
    const m = mats[grp.materialIndex]; if (!m) continue;
    if (!byMat.has(m)) byMat.set(m, []);
    byMat.get(m).push(grp);
  }
  return [...byMat].map(([material, groups]) => {
    const out = new THREE.BufferGeometry();
    for (const [k, a] of Object.entries(g.attributes)) out.setAttribute(k, a);
    const src = g.index.array, idx = [];
    for (const grp of groups) for (let i = grp.start; i < grp.start + grp.count; i++) idx.push(src[i]);
    out.setIndex(idx);
    return { geometry: out, material };
  });
}

// Merge `meshes` (already placed in the scene) into one mesh per material and shadow setup; the
// originals are removed. Returns the merged meshes.
export function mergeStatic(scene, meshes) {
  scene.updateMatrixWorld(true);
  const groups = new Map();
  for (const mesh of meshes) {
    for (const p of pieces(mesh)) {
      const key = [p.material.uuid, mesh.castShadow, mesh.receiveShadow, mesh.renderOrder].join('|');
      if (!groups.has(key)) groups.set(key, { material: p.material, mesh, geos: [] });
      const geo = (p.geometry.index ? p.geometry.toNonIndexed() : p.geometry.clone()).applyMatrix4(mesh.matrixWorld);
      groups.get(key).geos.push(geo);
    }
    mesh.removeFromParent();
  }
  const out = [];
  for (const { material, mesh, geos } of groups.values()) {
    // only the attributes every piece has (a plane and an extrusion both have position, normal, uv)
    const names = Object.keys(geos[0].attributes).filter(n => geos.every(g => g.attributes[n]));
    for (const g of geos) for (const n of Object.keys(g.attributes)) if (!names.includes(n)) g.deleteAttribute(n);
    for (const g of geos) g.clearGroups();
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    const m = new THREE.Mesh(merged, material);
    m.castShadow = mesh.castShadow; m.receiveShadow = mesh.receiveShadow; m.renderOrder = mesh.renderOrder;
    m.userData.merged = geos.length;
    scene.add(m); out.push(m);
  }
  return out;
}

// bake a texture's repeat and offset (along u) into a geometry's own coordinates, so meshes that
// used separate copies of one texture can share a single one
export function bakeUV(geometry, repeatU, offsetU) {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * repeatU + offsetU);
  uv.needsUpdate = true;
  return geometry;
}
