// Office Ball — colour textures that work on every GPU.
//
// Colour textures (the pitch, the kits, skin, the ad boards, the ball) are stored in the GPU's sRGB
// format, which decodes them to linear light as they are sampled. Some phone GPU drivers get that
// wrong and sample those textures as black (seen on an ARM Mali-G710 under Chrome for Android):
// everything textured goes dark while untextured and linear-data surfaces look fine.
//
// So it is measured, not assumed: probeSRGB() draws a small grey texture three ways and reads the
// result back from the GPU —
//   native  sRGB format with mipmaps (the normal path)
//   shader  plain RGBA8 data, decoded to linear in the shader (the same inline decode three.js
//           uses for video textures), which needs no sRGB support from the driver at all
//   nomip   sRGB format without mipmaps (for drivers whose mipmap generation breaks the format)
// and applySRGBMode() switches every colour texture in the scene to the first path that works.
import * as THREE from 'three';

// the shader path: three's own video-texture decode, also switched on by our defines
THREE.ShaderChunk.map_fragment = THREE.ShaderChunk.map_fragment.replace('#ifdef DECODE_VIDEO_TEXTURE\n', '#if defined( DECODE_VIDEO_TEXTURE ) || defined( OB_SRGB_MAP )\n');
THREE.ShaderChunk.emissivemap_fragment = THREE.ShaderChunk.emissivemap_fragment.replace('#ifdef DECODE_VIDEO_TEXTURE_EMISSIVE\n', '#if defined( DECODE_VIDEO_TEXTURE_EMISSIVE ) || defined( OB_SRGB_EMISSIVE )\n');
const PATCHED = THREE.ShaderChunk.map_fragment.includes('OB_SRGB_MAP') && THREE.ShaderChunk.emissivemap_fragment.includes('OB_SRGB_EMISSIVE');

// #bcbcbc is 0.5 in linear light: a working path reads back ~128 from a linear target
const GREY = '#bcbcbc', WANT = 128, TOL = 24;
export function probeSRGB(renderer) {
  const rt = new THREE.WebGLRenderTarget(4, 4);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), scene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); scene.add(quad);
  const px = new Uint8Array(4), prev = renderer.getRenderTarget();
  const draw = (opts, defines) => {
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const g = c.getContext('2d'); g.fillStyle = GREY; g.fillRect(0, 0, 16, 16);
    const tex = new THREE.CanvasTexture(c); Object.assign(tex, opts);
    const mat = new THREE.MeshBasicMaterial({ map: tex }); if (defines) mat.defines = defines;
    quad.material = mat;
    renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rt, 1, 1, 1, 1, px);
    tex.dispose(); mat.dispose();
    return px[1];
  };
  const out = { native: -1, nomip: -1, shader: -1, mode: 'native' };
  try {
    out.native = draw({ colorSpace: THREE.SRGBColorSpace });
    // the shader decode is preferred over dropping mipmaps: it keeps them, and without mipmaps a
    // distant texture is read at full size (slower on a phone's GPU, and it shimmers)
    if (Math.abs(out.native - WANT) > TOL) {
      if (PATCHED) {
        out.shader = draw({ colorSpace: THREE.NoColorSpace }, { OB_SRGB_MAP: '' });
        if (Math.abs(out.shader - WANT) <= TOL) out.mode = 'shader';
      }
      if (out.mode === 'native') {
        out.nomip = draw({ colorSpace: THREE.SRGBColorSpace, generateMipmaps: false, minFilter: THREE.LinearFilter });
        if (Math.abs(out.nomip - WANT) <= TOL) out.mode = 'nomip';
      }
    }
  } catch (e) { out.error = String(e && e.message || e); }
  renderer.setRenderTarget(prev); rt.dispose(); quad.geometry.dispose();
  return out;
}

// switch every sRGB colour texture in the scene to the path that works here (call before compiling)
export function applySRGBMode(scene, mode) {
  if (mode === 'native') return 0;
  const done = new Set(); let n = 0;
  scene.traverse(o => {
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of ms) for (const [slot, def] of [['map', 'OB_SRGB_MAP'], ['emissiveMap', 'OB_SRGB_EMISSIVE']]) {
      const t = m[slot];
      if (!t || (!done.has(t) && t.colorSpace !== THREE.SRGBColorSpace)) continue;
      if (!done.has(t)) {
        done.add(t); n++;
        if (mode === 'nomip') { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; }
        else t.colorSpace = THREE.NoColorSpace;
        t.needsUpdate = true;
      }
      if (mode === 'shader') m.defines = Object.assign({}, m.defines, { [def]: '' });
      m.needsUpdate = true;
    }
  });
  return n;
}
