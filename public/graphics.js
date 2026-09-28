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
// entry-level mobile GPUs (an Oppo A17's PowerVR GE8320, Adreno 4xx-5xx, Mali-4xx/Txxx/G31/G52...):
// these can't hold medium, whatever the player once picked in Settings, so a stored choice above lite
// is clamped — auto would have put them here anyway
const WEAK = /powervr|videocore|mali-4\d\d|mali-t\d|mali-[gt]3\d|mali-g5[12]|adreno[^0-9]*(3\d\d|4\d\d|5[0-3]\d)/i;
// any recognisable vendor; a renderer string with none (Brave reports just "Brave") is masked, and
// a masked string never earns the high tier on its own
const KNOWN = /intel|nvidia|geforce|amd|radeon|qualcomm|adreno|mali|powervr|imagination|apple|arc|vega|uhd|iris|gpu/i;
export const TIERS = ['2d', 'lite', 'medium', 'high'];

// probing creates (and throws away) WebGL contexts, so it is done once per page
let probed = null;
export function probeGraphics() { return probed || (probed = probe()); }
function probe() {
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
    if (!out.integrated && !KNOWN.test(out.renderer)) out.integrated = true;
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

// This machine's tier for this visit, and the preference behind it. ?gfx=2d|lite|medium|high in the
// URL forces one for a single visit (for support: "open it with ?gfx=2d"); the Settings choice is
// remembered; Auto follows the probe. The boot loader decides it (it downloads only what that tier
// draws with) and the game uses the same answer.
export function resolveTier() {
  const get = k => { try { return localStorage.getItem(k); } catch { return null; } };
  // v2: textures are now made to work on every GPU (texcompat.js). Step-downs recorded before that
  // blamed the wrong cause, so they are forgotten once and each device is measured again.
  try {
    if (get('ob_gfx_policy') !== '2') { localStorage.removeItem('ob_gfx_fail'); localStorage.removeItem('ob_gfx_noshadow'); localStorage.setItem('ob_gfx_policy', '2'); }
  } catch { }
  const url = new URLSearchParams(location.search).get('gfx');
  let pref = TIERS.includes(url) ? url : get('ob_graphics') || 'auto';
  const probe = probeGraphics();
  if (!TIERS.includes(url) && WEAK.test(probe.renderer) && TIERS.indexOf(pref) > 1) {
    pref = 'lite';
    try { localStorage.setItem('ob_graphics', 'lite'); } catch { }
  }
  return { tier: chooseTier(probe, pref, get('ob_gfx_fail')), pref, probe };
}
