// Office Ball — what can this machine draw? Office PCs are all over the place: gaming GPUs, laptop
// integrated graphics, virtual desktops and remote sessions with no GPU at all, browsers with
// hardware acceleration switched off by policy. The game picks a renderer that runs well on each,
// rather than one that only runs on some:
//   high    a real GPU: the full floodlit stadium (shadow-casting floodlights, HDR post chain)
//   medium  integrated / low-power GPU: the same look, fewer shadow maps, lighter post
//   lite    software rendering (no GPU): the same stadium built cheap (baked shadows, no post)
//   2d      no WebGL at all: a canvas renderer; the game always plays
const SOFTWARE = /swiftshader|llvmpipe|softpipe|basic render|microsoft basic|warp|software|mesa offscreen|virgl|vmware svga|parallels|virtualbox/i;
const INTEGRATED = /intel|uhd|iris|hd graphics|mali|adreno|powervr|apple gpu|radeon\(tm\) graphics|vega \d graphics/i;
export const TIERS = ['2d', 'lite', 'medium', 'high'];

export function probeGraphics() {
  const out = { webgl2: false, software: false, integrated: false, renderer: '', floatRT: false, maxSamples: 0, tier: '2d' };
  try {
    // the browser itself says whether a context would be slow: it refuses a "fast" one on software
    const fast = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    const gl = fast || document.createElement('canvas').getContext('webgl2');
    if (!gl) return out;
    out.webgl2 = true;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    out.renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
    out.software = !fast || (SOFTWARE.test(out.renderer) && !/nvidia|geforce|radeon rx|quadro/i.test(out.renderer));
    out.integrated = INTEGRATED.test(out.renderer);
    out.floatRT = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    out.maxSamples = gl.getParameter(gl.MAX_SAMPLES) || 0;
    const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); // free it
    out.tier = out.software ? 'lite' : !out.floatRT ? 'lite' : out.integrated ? 'medium' : 'high';
  } catch (e) { out.tier = '2d'; }
  return out;
}

// the tier to run: the player's own choice if they made one, else what the probe found, capped by
// anything that has already failed on this machine (a lost graphics context steps it down for good)
export function chooseTier(probe, pref, failedAt) {
  let t = probe.tier;
  if (pref && pref !== 'auto' && TIERS.includes(pref)) t = pref;
  if (!probe.webgl2) t = '2d';
  if (failedAt && TIERS.indexOf(t) >= TIERS.indexOf(failedAt)) t = TIERS[Math.max(0, TIERS.indexOf(failedAt) - 1)];
  return t;
}
