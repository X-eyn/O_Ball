import * as THREE from 'three';
import { presentationUrl } from './presentation-assets.js';

// The tournament net as it looks, over the NetDynamics cloth (which stays the physics):
//  - netting: a real-scale tiling texture (19 mm squares of twisted two-ply twine, tied knots),
//    authored once at high resolution with its own normal and opacity, mipmapped and
//    anisotropic; drawn with alpha-to-coverage on MSAA tiers so it thins to a soft haze at
//    distance instead of breaking up
//  - a fine display mesh, smoothly (Catmull-Rom) interpolated from the coarse physics grid, so
//    bulges and ripples are smooth curves without changing the tuned cloth
//  - the 75 mm white tape as real geometry folded over the top cord, the white side bands at
//    the posts and the bottom cord, all following the cloth, in a woven fabric scan
// Everything is in the net's local plane coordinates (x along, y up, z through the net).

const CELL = 0.019;        // mesh square, metres
const TILE_CELLS = 8;      // cells per texture tile
const TAPE = 0.075 / 2;    // the tape's depth down each face
const CORD_R = 0.0035, TAPE_T = 0.0012, BAND = 0.04;

function knotTexture(px) {
  // colour+alpha and height, drawn in one pass per channel
  const cell = px / TILE_CELLS, twine = Math.max(2, cell * 0.085), knot = twine * 2.3;
  const col = document.createElement('canvas'); col.width = col.height = px;
  const hgt = document.createElement('canvas'); hgt.width = hgt.height = px;
  const g = col.getContext('2d'), h = hgt.getContext('2d');
  h.fillStyle = '#000'; h.fillRect(0, 0, px, px);
  const strand = (ctx, x0, y0, x1, y1, w, style) => { ctx.strokeStyle = style; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
  for (let pass = 0; pass < 2; pass++) {
    const ctx = pass ? h : g;
    for (let i = 0; i <= TILE_CELLS; i++) {
      const o = i * cell;
      // two plies twisted: a body and a diagonal lay of highlights along it
      strand(ctx, -cell, o, px + cell, o, twine, pass ? '#7a7a7a' : 'rgba(18,21,27,1)');
      strand(ctx, o, -cell, o, px + cell, twine, pass ? '#7a7a7a' : 'rgba(18,21,27,1)');
    }
    // the twist: short diagonal lays every ~1.1 twine widths
    const lay = twine * 1.15;
    for (let i = 0; i <= TILE_CELLS; i++) {
      const o = i * cell;
      for (let t = -cell; t < px + cell; t += lay) {
        strand(ctx, t, o - twine * 0.38, t + twine * 0.55, o + twine * 0.38, twine * 0.28, pass ? '#c8c8c8' : 'rgba(58,64,74,.85)');
        strand(ctx, o - twine * 0.38, t, o + twine * 0.38, t + twine * 0.55, twine * 0.28, pass ? '#c8c8c8' : 'rgba(58,64,74,.85)');
      }
    }
    // tied knots at every crossing: a raised lump with a wrap line across it
    for (let i = 0; i <= TILE_CELLS; i++) for (let j = 0; j <= TILE_CELLS; j++) {
      const x = i * cell, y = j * cell;
      const grd = ctx.createRadialGradient(x - knot * 0.2, y - knot * 0.2, knot * 0.1, x, y, knot * 0.62);
      if (pass) { grd.addColorStop(0, '#fff'); grd.addColorStop(1, '#808080'); } else { grd.addColorStop(0, 'rgba(70,76,88,1)'); grd.addColorStop(1, 'rgba(14,16,21,1)'); }
      ctx.fillStyle = grd; ctx.beginPath(); ctx.ellipse(x, y, knot * 0.62, knot * 0.5, 0.6, 0, Math.PI * 2); ctx.fill();
      strand(ctx, x - knot * 0.45, y + knot * 0.3, x + knot * 0.45, y - knot * 0.3, twine * 0.35, pass ? '#606060' : 'rgba(8,9,12,.9)');
    }
  }
  // normal map from the height (Sobel), strength in pixels
  const hd = h.getImageData(0, 0, px, px).data, nrm = document.createElement('canvas'); nrm.width = nrm.height = px;
  const nctx = nrm.getContext('2d'), img = nctx.createImageData(px, px), nd = img.data, k = 2.2 / 255;
  const H = (x, y) => hd[(((y + px) % px) * px + ((x + px) % px)) * 4];
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1) - H(x - 1, y - 1) - 2 * H(x - 1, y) - H(x - 1, y + 1)) * k;
    const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1) - H(x - 1, y - 1) - 2 * H(x, y - 1) - H(x + 1, y - 1)) * k;
    const l = Math.hypot(dx, dy, 1), i = (y * px + x) * 4;
    nd[i] = (-dx / l * 0.5 + 0.5) * 255; nd[i + 1] = (dy / l * 0.5 + 0.5) * 255; nd[i + 2] = (1 / l * 0.5 + 0.5) * 255; nd[i + 3] = 255;
  }
  nctx.putImageData(img, 0, 0);
  return { color: col, normal: nrm };
}

// woven tape: ribbed polyester (fine ribs across its width, slubs along them), a soft shade toward
// the fold over the cord, and a stitched seam near each edge; it tiles along the tape's length.
// v runs across the tape: 0 front edge, 0.5 over the cord, 1 back edge.
function tapeTexture() {
  const W = 1024, H = 512, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#eef1f4'; g.fillRect(0, 0, W, H);
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // ribs: one every 3 px along the length, each a light crest and a shaded trough
  for (let x = 0; x < W; x += 3) {
    g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(x, 0, 1, H);
    g.fillStyle = `rgba(120,132,148,${0.16 + rnd() * 0.08})`; g.fillRect(x + 2, 0, 1, H);
  }
  // weft: a faint cross-thread every 4 px
  for (let y = 0; y < H; y += 4) { g.fillStyle = 'rgba(140,150,165,.07)'; g.fillRect(0, y, W, 1); }
  // slubs: short brighter / duller runs that break the regularity
  for (let i = 0; i < 900; i++) { const x = (rnd() * W) | 0, y = (rnd() * H) | 0; g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,.35)' : 'rgba(110,120,135,.12)'; g.fillRect(x, y, 2, 6 + rnd() * 18); }
  // the fold over the cord reads a touch darker (the curve turns away from the light)
  const fold = g.createLinearGradient(0, 0, 0, H);
  fold.addColorStop(0, 'rgba(0,0,0,.06)'); fold.addColorStop(0.42, 'rgba(0,0,0,0)'); fold.addColorStop(0.5, 'rgba(70,80,95,.10)'); fold.addColorStop(0.58, 'rgba(0,0,0,0)'); fold.addColorStop(1, 'rgba(0,0,0,.06)');
  g.fillStyle = fold; g.fillRect(0, 0, W, H);
  // stitched seams: a sunk groove with the thread lying in it
  g.setLineDash([]);
  for (const y of [34, H - 34]) {
    g.strokeStyle = 'rgba(95,105,120,.35)'; g.lineWidth = 5; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    g.strokeStyle = 'rgba(250,251,252,.95)'; g.lineWidth = 3; g.setLineDash([16, 8]); g.beginPath(); g.moveTo(0, y - 1); g.lineTo(W, y - 1); g.stroke(); g.setLineDash([]);
  }
  return c;
}

const catmull = t => { const t2 = t * t, t3 = t2 * t; return [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2]; };
function sampler(n, m) { // for m+1 display points over n+1 physics points: indices and weights
  return Array.from({ length: m + 1 }, (_, i) => {
    const f = i / m * n, k = Math.min(n - 1, Math.floor(f)), w = catmull(f - k);
    return [[k - 1, k, k + 1, k + 2].map(j => Math.max(0, Math.min(n, j))), w];
  });
}

export function createNetLook({ renderer, dynamics, tier }) {
  const lite = tier === 'lite', hi = tier === 'high';
  const msaa = !!renderer.getContext().getContextAttributes?.().antialias;
  const W = dynamics.width, Hn = dynamics.height;
  const up = lite ? 1 : hi ? 4 : 3, upR = lite ? 1 : hi ? 3 : 2;
  const DC = dynamics.cols * up, DR = dynamics.rows * upR;
  const aniso = Math.min(hi ? 16 : 8, renderer.capabilities.getMaxAnisotropy());

  // --- netting ---------------------------------------------------------------------------------
  const tex = knotTexture(lite ? 512 : hi ? 2048 : 1024);
  const repeat = new THREE.Vector2(W / (CELL * TILE_CELLS), Hn / (CELL * TILE_CELLS));
  const mk = (canvas, srgb) => {
    const t = new THREE.CanvasTexture(canvas); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.copy(repeat);
    t.anisotropy = aniso; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; return t;
  };
  const map = mk(tex.color, true), normalMap = mk(tex.normal, false);
  const nettingMat = new THREE.MeshStandardMaterial({
    map, normalMap, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.82, metalness: 0, side: THREE.DoubleSide,
    // MSAA tiers: coverage from the mipmapped alpha, so far netting is a soft see-through haze
    ...(msaa ? { alphaToCoverage: true, transparent: false } : { transparent: true, depthWrite: false }),
  });
  // Distance detail: when a real 19 mm square is too small to resolve (the broadcast camera sees
  // it at ~1.5 px), mipmapping would average the netting into a flat grey band. There the net is
  // drawn as an anti-aliased grid of whole multiples of the real squares (2x, 4x, ...), chosen
  // so a square is always ~4 px, cross-fading between levels so nothing pops; close up it is the
  // knotted twine texture. Lines are thin, faint and gently swaying, so the net reads as soft netting at any range.
  nettingMat.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      {
        vec2 cell = vMapUv * ${TILE_CELLS.toFixed(1)};
        vec2 fw = fwidth(cell);
        float cellPx = 1.0 / max(max(fw.x, fw.y), 1e-5);
        float far = smoothstep(4.2, 2.2, cellPx);
        if (far > 0.0) {
          // real twine is never ruler-straight: a slow sway in both directions, a fraction of a square
          vec2 sway = 0.07 * vec2(sin(cell.y * 0.37 + sin(cell.x * 0.11) * 2.0), sin(cell.x * 0.29 + sin(cell.y * 0.13) * 2.0));
          vec2 wc = cell + sway;
          float l = max(0.0, log2(4.0 / cellPx)), k = floor(l), t = fract(l);
          vec2 c0 = wc / exp2(k), c1 = wc / exp2(k + 1.0);
          vec2 d0 = abs(fract(c0 - 0.5) - 0.5) / max(fwidth(c0), vec2(1e-5));
          vec2 d1 = abs(fract(c1 - 0.5) - 0.5) / max(fwidth(c1), vec2(1e-5));
          float line = mix(1.0 - smoothstep(0.1, 0.85, min(d0.x, d0.y)), 1.0 - smoothstep(0.1, 0.85, min(d1.x, d1.y)), t);
          // strands catch the light unevenly: a soft, slow variation in strength
          float vary = 0.82 + 0.18 * sin(cell.x * 0.21 + cell.y * 0.17);
          float a = max(line * 0.55 * vary, 0.09);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.018, 0.02, 0.026), far);
          diffuseColor.a = mix(diffuseColor.a, a, far);
        }
      }`);
  };
  nettingMat.customProgramCacheKey = () => 'net-distance-detail-2';
  const geo = new THREE.PlaneGeometry(W, Hn, DC, DR);
  geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
  const mesh = new THREE.Mesh(geo, nettingMat);
  mesh.name = 'Dynamic tensioned net'; mesh.frustumCulled = false;
  const sc = sampler(dynamics.cols, DC), sr = sampler(dynamics.rows, DR);

  // --- tape, side bands, bottom cord: swept profiles following the cloth ---------------------
  const fabricMats = [];
  const tapeMat = new THREE.MeshPhysicalMaterial({ map: (() => { const t = new THREE.CanvasTexture(tapeTexture()); t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso; t.repeat.set(W / 0.15, 1); return t; })(), roughness: 0.74, sheen: 0.5, sheenRoughness: 0.7, sheenColor: new THREE.Color(0xdde3ea), side: THREE.DoubleSide });
  fabricMats.push(tapeMat);
  const bandMat = tapeMat.clone(); bandMat.map = tapeMat.map.clone(); bandMat.map.repeat.set(Hn / 0.15, 1); bandMat.map.needsUpdate = true; fabricMats.push(bandMat);
  new THREE.TextureLoader().load(presentationUrl('fabric-normal.jpg'), n => {
    n.wrapS = n.wrapT = THREE.RepeatWrapping; n.anisotropy = aniso;
    tapeMat.normalMap = n.clone(); tapeMat.normalMap.repeat.set(W / 0.06, 1.3); tapeMat.normalMap.needsUpdate = true; tapeMat.normalScale.set(1.1, 1.1); tapeMat.needsUpdate = true;
    bandMat.normalMap = n.clone(); bandMat.normalMap.repeat.set(Hn / 0.06, 0.7); bandMat.normalMap.needsUpdate = true; bandMat.normalScale.set(1.1, 1.1); bandMat.needsUpdate = true;
  }, undefined, () => {});
  const cordMat = new THREE.MeshStandardMaterial({ color: 0x14171d, roughness: 0.7 });

  // the tape's cross-section: down the front face, over the cord, down the back
  const arc = 8, tapeProfile = [[-TAPE, CORD_R + TAPE_T]];
  for (let i = 0; i <= arc; i++) { const t = Math.PI * i / arc; tapeProfile.push([Math.sin(t) * (CORD_R + TAPE_T), Math.cos(t) * (CORD_R + TAPE_T)]); }
  tapeProfile.push([-TAPE, -(CORD_R + TAPE_T)]);
  const bandProfile = [[BAND, CORD_R + TAPE_T]];
  for (let i = 0; i <= arc; i++) bandProfile.push([-Math.sin(Math.PI * i / arc) * (CORD_R + TAPE_T), Math.cos(Math.PI * i / arc) * (CORD_R + TAPE_T)]);
  bandProfile.push([BAND, -(CORD_R + TAPE_T)]);
  const cordProfile = Array.from({ length: 9 }, (_, i) => { const a = i / 8 * Math.PI * 2; return [Math.cos(a) * CORD_R * 0.8, Math.sin(a) * CORD_R * 0.8]; });

  // a ribbon swept along n path points: profile (a, b) on axes (A, B) of the net plane
  function sweep(n, profile, mat, lenScale) {
    const pc = profile.length, g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * pc * 3), uv = new Float32Array(n * pc * 2), idx = [];
    let L = 0; const pl = [0]; for (let k = 1; k < pc; k++) { L += Math.hypot(profile[k][0] - profile[k - 1][0], profile[k][1] - profile[k - 1][1]); pl.push(L); }
    for (let i = 0; i < n; i++) for (let k = 0; k < pc; k++) { uv[(i * pc + k) * 2] = i / (n - 1) * lenScale; uv[(i * pc + k) * 2 + 1] = pl[k] / L; }
    for (let i = 0; i < n - 1; i++) for (let k = 0; k < pc - 1; k++) { const a = i * pc + k, b = a + pc; idx.push(a, b, a + 1, b, b + 1, a + 1); }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
    const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.castShadow = hi; m.receiveShadow = true;
    return { mesh: m, pos, pc, profile, n };
  }
  const tape = sweep(DC + 1, tapeProfile, tapeMat, 1);
  const bands = [sweep(DR + 1, bandProfile, bandMat, 1), sweep(DR + 1, bandProfile.map(([a, b]) => [-a, b]), bandMat, 1)];
  const cord = sweep(DC + 1, cordProfile, cordMat, 1);
  mesh.add(tape.mesh, bands[0].mesh, bands[1].mesh, cord.mesh);

  // --- per frame: the display mesh and its trims from the physics grid -------------------------
  // Separable Catmull-Rom: first along each physics row to the display columns, then down each
  // display column to the display rows. Normals straight from the grid's tangents.
  const P = dynamics.positions, stride = dynamics.cols + 1, SR = dynamics.rows + 1, NC = DC + 1;
  const flat = list => ({ i: Int32Array.from(list.flatMap(([ix]) => ix)), w: Float32Array.from(list.flatMap(([, w]) => w)) });
  const cS = flat(sc), rS = flat(sr);
  const mid = new Float32Array(SR * NC * 3);
  const dpos = geo.attributes.position.array, dnrm = geo.attributes.normal.array;
  function interpolate() {
    for (let r = 0; r < SR; r++) for (let c = 0; c < NC; c++) {
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < 4; k++) { const w = cS.w[c * 4 + k], i = (r * stride + cS.i[c * 4 + k]) * 3; x += P[i] * w; y += P[i + 1] * w; z += P[i + 2] * w; }
      const o = (r * NC + c) * 3; mid[o] = x; mid[o + 1] = y; mid[o + 2] = z;
    }
    for (let r = 0; r <= DR; r++) for (let c = 0; c < NC; c++) {
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < 4; k++) { const w = rS.w[r * 4 + k], i = (rS.i[r * 4 + k] * NC + c) * 3; x += mid[i] * w; y += mid[i + 1] * w; z += mid[i + 2] * w; }
      const o = (r * NC + c) * 3; dpos[o] = x; dpos[o + 1] = y; dpos[o + 2] = z;
    }
    for (let r = 0; r <= DR; r++) for (let c = 0; c < NC; c++) {
      const o = (r * NC + c) * 3;
      const l = (r * NC + Math.max(0, c - 1)) * 3, rr = (r * NC + Math.min(DC, c + 1)) * 3;
      const u = (Math.max(0, r - 1) * NC + c) * 3, d = (Math.min(DR, r + 1) * NC + c) * 3;
      const ax = dpos[rr] - dpos[l], ay = dpos[rr + 1] - dpos[l + 1], az = dpos[rr + 2] - dpos[l + 2];
      const bx = dpos[u] - dpos[d], by = dpos[u + 1] - dpos[d + 1], bz = dpos[u + 2] - dpos[d + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const n = Math.hypot(nx, ny, nz) || 1; dnrm[o] = nx / n; dnrm[o + 1] = ny / n; dnrm[o + 2] = nz / n;
    }
    geo.attributes.position.needsUpdate = true; geo.attributes.normal.needsUpdate = true;
  }
  // a trim follows display vertices first + i * step, its profile laid on axis 1 (y) or 0 (x)
  function place(s, first, step, alongX) {
    const pos = s.pos, prof = s.profile, pc = s.pc;
    for (let i = 0; i < s.n; i++) {
      const v = (first + i * step) * 3, x = dpos[v], y = dpos[v + 1], z = dpos[v + 2];
      for (let k = 0; k < pc; k++) {
        const o = (i * pc + k) * 3, a = prof[k][0];
        pos[o] = alongX ? x + a : x; pos[o + 1] = alongX ? y : y + a; pos[o + 2] = z + prof[k][1];
      }
    }
    s.mesh.geometry.attributes.position.needsUpdate = true;
  }
  let trimNormals = false;
  function sync() {
    interpolate();
    // the tape rides the top edge, the cord the bottom, the bands the two ends
    place(tape, 0, 1, false);
    place(cord, DR * NC, 1, false);
    place(bands[0], 0, NC, true);
    place(bands[1], DC, NC, true);
    // the trims' shading barely turns with a bulge: their normals are worked out once
    if (!trimNormals) { trimNormals = true; for (const s of [tape, cord, ...bands]) s.mesh.geometry.computeVertexNormals(); }
  }
  sync();
  return { mesh, sync, stats: () => ({ display: [DC, DR], physics: [dynamics.cols, dynamics.rows], texture: tex.color.width, msaa }) };
}
