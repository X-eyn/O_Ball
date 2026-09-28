// Office Ball — the boot loader. Runs once per page, before any of the game, and does not finish
// until everything the game will ever need is on this machine and ready: every module, every font,
// every model, the stadium and both players built, every shader compiled and a first frame drawn.
// Nothing is fetched or built after the loading screen goes, not on Play, not on a match start.
//
// The progress it shows is measured, never estimated from the clock:
//   download  bytes received against the exact total in the manifest the server wrote into the page
//   stadium   build steps done against the fixed number of steps
//   players   parse / decode / fit / light steps done against their fixed number
//   shaders   GPU programs finished against the programs the scene actually needs
//   warm-up   the first full frame (shadow maps, AO, bloom) drawn
// The ring combines the stages, each weighted by how long it took on this machine last time (a
// small profile kept in localStorage), so equal steps of the ring are roughly equal time.
//
// Caching: every file has a content-addressed URL (see assets.js), so the browser keeps it for good.
// On top of that, models, fonts and the fitted kits are kept in IndexedDB under their content hash:
// a hard refresh skips the browser's HTTP cache by design, but not this, so even then the heavy
// files and the heaviest computation come from this PC. (A service worker would need HTTPS, and a
// LAN game is served over plain HTTP, where browsers don't allow one.)
const M = window.__MANIFEST;
const T0 = performance.now();
// the page's errors and warnings (shader compile errors among them), kept for diagnostics reports
window.__obLog = [];
for (const k of ['error', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { try { window.__obLog.push(k + ': ' + a.map(x => (x && x.stack) || String(x)).join(' ').slice(0, 600)); if (window.__obLog.length > 60) window.__obLog.shift(); } catch { } orig(...a); };
}
addEventListener('error', e => window.__obLog.push('uncaught: ' + e.message));

// ---------------------------------------------------------------- local store (IndexedDB)
// One key-value store, content-addressed: 'a:<hash>' holds a file's bytes, derived results use the
// keys the manifest names. Anything unavailable (private mode, blocked storage) degrades to the
// network: the store never fails a boot.
const store = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise(resolve => {
    const t = setTimeout(() => resolve(null), 2000); // blocked by another tab: don't hold the boot up
    try {
      const r = indexedDB.open('office-ball', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { clearTimeout(t); resolve(r.result); };
      r.onerror = () => { clearTimeout(t); resolve(null); };
    } catch { clearTimeout(t); resolve(null); }
  }));
  const run = (mode, fn) => open().then(db => db && new Promise(resolve => {
    try {
      const tx = db.transaction('kv', mode), out = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(out); tx.onerror = tx.onabort = () => resolve(null);
    } catch { resolve(null); }
  }));
  return {
    // key -> value for the keys present, one transaction
    async getMany(keys) {
      const got = new Map();
      await run('readonly', s => { for (const k of keys) { const r = s.get(k); r.onsuccess = () => { if (r.result !== undefined) got.set(k, r.result); }; } });
      return got;
    },
    put: (k, v) => run('readwrite', s => s.put(v, k)).then(x => !!x),
    // drop everything no longer referenced (older versions of files, kits fitted by older code)
    prune: keep => run('readwrite', s => { const r = s.getAllKeys(); r.onsuccess = () => { for (const k of r.result) if (!keep.has(k)) s.delete(k); }; }),
  };
})();

// ---------------------------------------------------------------- progress
const PROFILE_KEY = 'ob_boot_profile_v1';
const DEFAULTS = { stadium: 350, playersHit: 150, playersMiss: 900, shaders: 1500, warm: 250 }; // ms per stage
const DEFAULT_BPS = 3000; // network: bytes per ms
const readProfile = () => { try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || {}; } catch { return {}; } };
// Stages cost far less once this browser has booted this exact build before: it keeps compiled GPU
// programs (and warm code caches) of its own. So a machine's profile has two sides, per tier: the
// first boot of a build, and every boot after it.
const REPEAT = (() => { try { return localStorage.getItem('ob_boot_build') === M.build; } catch { return false; } })();
const profileFor = (P, tier) => Object.assign({}, DEFAULTS, P[tier + ':first'], REPEAT ? P[tier + ':repeat'] : null);

const el = document.getElementById('boot');
const ui = {
  bar: el.querySelector('.bar'), pct: el.querySelector('.pct'), lbl: el.querySelector('.lbl'), err: el.querySelector('.err'),
  rows: Object.fromEntries([...el.querySelectorAll('.stages li')].map(li => [li.dataset.s, { li, dt: li.querySelector('.dt'), fill: li.querySelector('.fill') }])),
};
const RING = 326.7;
const mb = b => (b / 1048576).toFixed(b < 10485760 ? 1 : 0);

class Stage {
  constructor(id, title) { Object.assign(this, { id, title, total: 0, done: 0, weight: 1, t0: null, t1: null, detail: '', skipped: false, unit: '', log: [] }); }
  get frac() { return this.t1 !== null ? 1 : this.total > 0 ? Math.min(1, this.done / this.total) : 0; }
  // total: how many units of work this stage is, known before its first unit is done
  begin(total, unit = '', detail = '') { if (this.t0 === null) this.t0 = performance.now(); this.total = total; this.unit = unit; this.detail = detail; changed(); return this; }
  step(n = 1, detail) { this.done = Math.min(this.total, this.done + n); this.log.push([Math.round(performance.now()), this.detail]); if (detail !== undefined) this.detail = detail; changed(); }
  note(detail) { this.detail = detail; changed(); }
  end(detail) { if (this.t1 === null) { this.done = this.total; this.t1 = performance.now(); if (detail !== undefined) this.detail = detail; changed(); } }
  skip() { this.skipped = true; changed(); }
}
const stages = {
  net: new Stage('net', 'Downloading'),
  stadium: new Stage('stadium', 'Building the stadium'),
  players: new Stage('players', 'Building the players'),
  shaders: new Stage('shaders', 'Compiling shaders'),
  warm: new Stage('warm', 'Drawing the first frame'),
};
const ORDER = Object.values(stages);
let planned = false, finished = false, dirty = false, lastMove = performance.now(), slowNote = false, lastPaint = 0;
function changed() { lastMove = performance.now(); slowNote = false; if (!dirty) { dirty = true; requestAnimationFrame(paint); setTimeout(paint, 100); } }
function overall() {
  let w = 0, d = 0;
  for (const s of ORDER) if (!s.skipped) { w += s.weight; d += s.weight * s.frac; }
  return planned && w > 0 ? d / w : 0;
}
// what the screen showed and when (for support and tests: window.__obBoot)
const trace = [];
window.__obBoot = { stages, trace, items: () => items };
function paint() {
  if (!dirty || finished) return; dirty = false;
  const f = overall(), p = Math.floor(f * 100);
  lastPaint = performance.now();
  trace.push([Math.round(lastPaint), +f.toFixed(4)]);
  ui.bar.style.strokeDashoffset = (RING * (1 - f)).toFixed(1);
  ui.pct.innerHTML = p + '<small>%</small>';
  el.setAttribute('aria-valuenow', p);
  // the headline is what the main thread is busy with (downloads carry on underneath it)
  const running = ORDER.filter(s => !s.skipped && s.t0 !== null && s.t1 === null);
  const now = running.length ? running[running.length - 1] : null;
  ui.lbl.textContent = now ? now.title : 'Starting';
  for (const s of ORDER) {
    const r = ui.rows[s.id]; if (!r) continue;
    r.li.className = s.skipped ? 'skip' : s.t1 !== null ? 'done' : s.t0 !== null ? 'run' : '';
    r.fill.style.transform = `scaleX(${s.frac.toFixed(4)})`;
    r.dt.textContent = s.t1 !== null && !s.detail ? 'Done' : s.detail;
  }
}
// honest about a slow network: say so when nothing has moved for a while
setInterval(() => {
  if (finished || slowNote || performance.now() - lastMove < 12000) return;
  slowNote = true; ui.lbl.textContent += ' (still working, the network is slow)';
}, 2000);

function fail(msg, retry = true) {
  if (finished) return;
  finished = true;
  el.classList.add('failed'); ui.lbl.textContent = 'Could not load';
  ui.err.innerHTML = msg + (retry ? '<br><button type="button">Reload</button>' : '');
  const b = ui.err.querySelector('button'); if (b) b.onclick = () => location.reload();
}
// Code under an old build hash 404s once the host has been updated. Reload into the new build
// (once: if the page still can't load, say so instead of looping).
async function codeFailed(what) {
  try {
    const { build } = await (await fetch('/api/build', { cache: 'no-store' })).json();
    if (build !== M.build && sessionStorage.getItem('ob_reloaded_for') !== build) {
      sessionStorage.setItem('ob_reloaded_for', build); ui.lbl.textContent = 'Game updated, reloading'; location.reload(); return;
    }
  } catch { }
  fail(`${what} could not be loaded from the host PC.<br>Check the host is still running, then reload.`);
}

// ---------------------------------------------------------------- downloads
// Every file the boot needs is an item with its exact size from the manifest. An item is done when
// all its bytes are here, from wherever they came: the network, the browser's cache, or this PC's
// store. 'from' records which, for the detail line and for measuring the network speed.
const items = [];
const net = stages.net;
function item(url, size, from = null) { const it = { url, size, got: 0, from }; items.push(it); return it; }
function got(it, n, from) { it.got = n; if (from) it.from = from; net.done = items.reduce((a, x) => a + x.got, 0); netDetail(); }
function netDetail() {
  const all = items.length, done = items.filter(x => x.got >= x.size).length;
  const local = items.filter(x => x.got >= x.size && x.from !== 'net').reduce((a, x) => a + x.size, 0);
  net.note(`${mb(net.done)} / ${mb(net.total)} MB · ${done} of ${all} files${local ? ` · ${mb(local)} MB already on this PC` : ''}`);
  if (net.total && done === all) net.end();
}
const entryOf = url => performance.getEntriesByName(new URL(url, location.href).href, 'resource').pop();
const cameFrom = e => (e && e.transferSize > 0 ? 'net' : 'cache');

// modules: the page's <link rel=modulepreload> tags started them all while it was parsed; count
// each as it lands (or had already landed before this script ran). Whether the code as a whole
// loaded is decided by import() of the entry, which settles only once the entire graph has.
function trackModules() {
  const list = M.modules.map(m => {
    const it = item(m.url, m.size), link = document.querySelector(`link[rel=modulepreload][href="${m.url}"]`);
    const ok = () => { if (it.got < it.size) got(it, it.size, cameFrom(entryOf(m.url))); };
    if (link) link.addEventListener('load', ok);
    const e = entryOf(m.url);
    if (e && e.responseEnd > 0 && !(e.responseStatus >= 400)) ok();
    return { it, ok };
  });
  return { all: () => list.forEach(x => x.ok()) }; // after import() resolved: every module is here
}
// the rules (shared/game.js) ran as a deferred classic script just before this one
function trackScript() {
  const it = item(M.script.url, M.script.size);
  if (!window.OB) return Promise.reject(new Error(M.script.url));
  got(it, it.size, cameFrom(entryOf(M.script.url)));
  return Promise.resolve();
}
// a file's bytes: from this PC's store if it has them, else downloaded (streamed, so the count moves
// with every chunk) and then kept. Retried with backoff; the exact size is checked.
const kept = [];
function bytes(file, local) {
  const it = item(file.url, file.size);
  const have = local.get('a:' + file.hash);
  if (have instanceof ArrayBuffer && have.byteLength === file.size) { got(it, it.size, 'store'); return Promise.resolve(have); }
  return (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(file.url);
        if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
        const buf = new Uint8Array(file.size), rd = r.body.getReader(); let o = 0;
        for (;;) {
          const { done, value } = await rd.read(); if (done) break;
          if (o + value.length > file.size) throw new Error('size mismatch');
          buf.set(value, o); o += value.length; got(it, o, 'net');
        }
        if (o !== file.size) throw new Error('size mismatch');
        got(it, o, cameFrom(entryOf(file.url)));
        kept.push(store.put('a:' + file.hash, buf.buffer.slice(0))); // a copy: consumers may take the original
        return buf.buffer;
      } catch (e) {
        if (e.status === 404 || attempt >= 4) throw e;
        got(it, 0); // the bytes of a failed attempt don't count: they are fetched again
        net.note(`A download failed. Retrying (${attempt} of 3)`);
        await new Promise(r => setTimeout(r, 800 * attempt));
      }
    }
  })();
}
// fonts: the Latin subset of each face is loaded now, from bytes, and registered; every other subset
// is registered by URL only (the browser fetches it if a name ever needs those characters)
async function loadFonts(local) {
  const faces = [];
  for (const f of M.fonts) {
    const desc = { weight: f.weight, style: f.style, unicodeRange: f.range, display: 'swap' };
    if (!f.eager) { document.fonts.add(new FontFace(f.family, `url(${f.url}) format('woff2')`, desc)); continue; }
    faces.push(bytes(f, local).then(async b => { const ff = new FontFace(f.family, b, desc); await ff.load(); document.fonts.add(ff); }));
  }
  await Promise.all(faces);
}

// ---------------------------------------------------------------- boot
async function boot() {
  const modules = trackModules(), scriptIn = trackScript();
  // what this machine will draw with decides what it needs (no models for the 2D renderer)
  const [gfx, local] = await Promise.all([
    import('./graphics.js'),
    store.getMany([...M.fonts.filter(f => f.eager).map(f => 'a:' + f.hash), ...Object.values(M.assets).map(a => 'a:' + a.hash), ...Object.values(M.derived)]),
  ]);
  const { tier, probe, pref } = gfx.resolveTier();
  const is3D = tier !== '2d';

  // a font that fails is not a failed boot: that text draws in its fallback face
  const fontsIn = loadFonts(local).catch(e => console.warn('fonts', e));
  const assets = {};
  if (is3D) for (const [name, a] of Object.entries(M.assets)) assets[name] = bytes(a, local);
  net.begin(items.reduce((a, x) => a + x.size, 0), 'bytes'); net.t0 = T0; netDetail();

  // weights: expected milliseconds per stage on this machine, frozen now so the ring never runs backwards
  const P = readProfile(), tp = profileFor(P, tier), bps = P.bps || DEFAULT_BPS;
  const kitCached = local.has(M.derived.kit);
  net.weight = Math.max(1, items.reduce((a, x) => a + (x.size - x.got), 0) / bps);
  stages.stadium.weight = tp.stadium;
  stages.players.weight = kitCached ? tp.playersHit : tp.playersMiss;
  stages.shaders.weight = tp.shaders;
  stages.warm.weight = tp.warm;
  if (!is3D) for (const s of [stages.stadium, stages.players, stages.shaders, stages.warm]) s.skip();
  planned = true; changed();

  const api = {
    tier, probe, pref,
    stage: id => stages[id],
    asset: name => assets[name] || Promise.reject(new Error('not in the manifest: ' + name)),
    derived: M.derived,
    // Let the loading screen show the latest step before the next piece of work starts. A task
    // boundary alone doesn't make the browser render, so this waits for the next frame when one is
    // due, but never more than 100 ms (a hidden tab gets no frames at all).
    yield: () => new Promise(r => {
      if (document.hidden || performance.now() - lastPaint < 12) return setTimeout(r, 0);
      let fired = false; const go = () => { if (!fired) { fired = true; setTimeout(r, 0); } };
      requestAnimationFrame(go); setTimeout(go, 100);
    }),
    cache: { get: k => local.get(k), put: (k, v) => { local.set(k, v); kept.push(store.put(k, v)); } },
    // everything is built: wait for anything still arriving, then hand the screen over
    async ready() {
      await Promise.all([fontsIn, ...Object.values(assets)]);
      for (const s of ORDER) if (!s.skipped) s.end();
      dirty = true; paint(); finished = true;
      remember(tier, kitCached);
      el.classList.add('out'); setTimeout(() => el.remove(), 500);
      // tidy the store once the new copies are safely in: drop versions nothing points at any more
      Promise.all(kept).then(() => store.prune(new Set([...Object.values(M.assets).map(a => 'a:' + a.hash), ...M.fonts.map(f => 'a:' + f.hash), ...Object.values(M.derived)])));
    },
    fail,
  };

  // the game starts once its code, rules and fonts are all here (models are awaited by the build)
  let app;
  try { await scriptIn; app = await import(M.entry); } catch (e) { console.error(e); return codeFailed('The game code'); }
  modules.all();
  await fontsIn;
  try { await app.start(api); } catch (e) {
    console.error(e);
    if (e && e.status === 404) return codeFailed('A game file');
    fail('Something went wrong while starting the game.<br>' + String(e && e.message || e).replace(/[<>&]/g, ''));
  }
}

// what each stage actually cost here, blended into the profile the next boot weights its ring with
function remember(tier, kitCached) {
  try {
    const P = readProfile(), tp = profileFor(P, tier), mix = (old, v) => Math.round(old * 0.5 + v * 0.5);
    const dur = s => s.t0 !== null && s.t1 !== null ? s.t1 - s.t0 : null;
    for (const [s, k] of [[stages.stadium, 'stadium'], [stages.shaders, 'shaders'], [stages.warm, 'warm'], [stages.players, kitCached ? 'playersHit' : 'playersMiss']]) {
      const d = dur(s); if (d !== null && !s.skipped) tp[k] = mix(tp[k], d);
    }
    for (const k of Object.keys(P)) if (!/:(first|repeat)$/.test(k) && k !== 'bps') delete P[k]; // older layout
    P[tier + (REPEAT ? ':repeat' : ':first')] = tp;
    localStorage.setItem('ob_boot_build', M.build);
    // network speed: bytes that really crossed the network, over the span they took (decoded sizes,
    // the same units the ring counts in); too little traffic says nothing about the network
    const fromNet = items.filter(x => x.from === 'net'), es = fromNet.map(x => entryOf(x.url)).filter(Boolean);
    const bytesIn = fromNet.reduce((a, x) => a + x.size, 0);
    if (es.length && bytesIn > 256 * 1024) {
      const span = Math.max(...es.map(e => e.responseEnd)) - Math.min(...es.map(e => e.startTime));
      if (span > 50) P.bps = Math.round((P.bps || DEFAULT_BPS) * 0.5 + bytesIn / span * 0.5);
    }
    localStorage.setItem(PROFILE_KEY, JSON.stringify(P));
  } catch { }
}

boot().catch(e => { console.error(e); fail(String(e && e.message || e)); });
