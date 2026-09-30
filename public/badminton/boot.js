// Office Badminton — boot. A small measured loader: every code and model file's bytes are counted as
// they arrive (code was preloaded by the page), the fonts register, the players are built from the
// same GLB assets the football page uses, and the first frame is drawn before the screen goes.
const M = window.__MANIFEST;
const el = document.getElementById('boot');
const ui = { bar: el.querySelector('.bar'), pct: el.querySelector('.pct'), lbl: el.querySelector('.lbl'), sub: el.querySelector('.sub'), err: el.querySelector('.err') };
const RING = 326.7, mb = b => (b / 1048576).toFixed(b < 10485760 ? 1 : 0);
let finished = false, plan = null;

function fail(msg, retry = true) {
  if (finished) return;
  finished = true;
  el.classList.add('failed'); ui.lbl.textContent = 'Could not load';
  ui.err.innerHTML = msg + (retry ? '<br><button type="button">Reload</button>' : '');
  const b = ui.err.querySelector('button'); if (b) b.onclick = () => location.reload();
}
function paint(p, label, sub) {
  p = Math.max(0, Math.min(1, p));
  ui.bar.style.strokeDashoffset = (RING * (1 - p)).toFixed(1);
  ui.pct.innerHTML = Math.floor(p * 100) + '<small>%</small>';
  el.setAttribute('aria-valuenow', Math.floor(p * 100));
  if (label) ui.lbl.textContent = label;
  if (sub !== undefined) ui.sub.textContent = sub;
}

// ---------------------------------------------------------------- local store (IndexedDB)
// Same store the football loader uses, so models kept by one page are already on this PC for the
// other. Anything unavailable (private mode, blocked storage) degrades to the network.
const store = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise(resolve => {
    const t = setTimeout(() => resolve(null), 2000);
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
    get: k => run('readonly', s => s.get(k)).then(r => r instanceof ArrayBuffer || (r && typeof r === 'object') ? r : null),
    put: (k, v) => run('readwrite', s => s.put(v, k)).then(x => !!x),
  };
})();

// ---------------------------------------------------------------- downloads
const items = M.modules.map(m => ({ url: m.url, size: m.size, got: 0 }));
const assetItems = Object.entries(M.assets).map(([n, a]) => ({ name: n, url: a.url, size: a.size, got: 0 }));
const netBytes = () => items.reduce((a, x) => a + x.got, 0) + assetItems.reduce((a, x) => a + x.got, 0) + (window.BM ? M.script.size : 0);
const netTotal = items.reduce((a, x) => a + x.size, 0) + assetItems.reduce((a, x) => a + x.size, 0) + M.script.size;
const entryOf = url => performance.getEntriesByName(new URL(url, location.href).href, 'resource').pop();
function trackDownloads() {
  for (const [i, m] of M.modules.entries()) {
    const it = items[i];
    const ok = () => { if (it.got < it.size) it.got = it.size; };
    const link = document.querySelector(`link[rel=modulepreload][href="${m.url}"]`);
    if (link) link.addEventListener('load', ok);
    const e = entryOf(m.url);
    if (e && e.responseEnd > 0 && !(e.responseStatus >= 400)) ok();
  }
  setInterval(() => { if (plan) paint(progress(), 'Downloading', `${mb(netBytes())} / ${mb(netTotal)} MB`); }, 150);
}
const mem = new Map();
async function bytes(a) {
  const it = assetItems.find(x => x.url === a.url);
  if (mem.has(a.hash)) { if (it) it.got = it.size; return mem.get(a.hash); }
  const kept = await store.get('a:' + a.hash);
  if (kept instanceof ArrayBuffer && kept.byteLength === a.size) { if (it) it.got = it.size; mem.set(a.hash, kept); return kept; }
  const r = await fetch(a.url);
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  const buf = await r.arrayBuffer();
  if (it) it.got = it.size;
  mem.set(a.hash, buf);
  store.put('a:' + a.hash, buf).catch(() => { });
  return buf;
}
function progress() {
  if (!plan) return 0;
  const dl = netTotal ? netBytes() / netTotal : 1;
  return dl * 0.62 + (plan.imported ? 0.13 : 0) + (plan.players ? 0.15 : 0) + (plan.warm ? 0.10 : 0);
}

// ---------------------------------------------------------------- fonts
async function loadFonts() {
  const faces = [];
  for (const f of M.fonts) {
    if (!f.eager) { try { document.fonts.add(new FontFace(f.family, `url(${f.url}) format('woff2')`, { weight: f.weight, style: f.style, unicodeRange: f.range, display: 'swap' })); } catch { } continue; }
    faces.push(fetch(f.url).then(r => r.arrayBuffer()).then(async b => { const ff = new FontFace(f.family, b, { weight: f.weight, style: f.style, unicodeRange: f.range, display: 'swap' }); await ff.load(); document.fonts.add(ff); }).catch(() => { }));
  }
  await Promise.all(faces);
}

// ---------------------------------------------------------------- stages
const stages = {};
function stage(id) {
  if (stages[id]) return stages[id];
  const s = {
    total: 0, done: 0, detail: '',
    begin(total, unit, detail) { this.total = total; this.done = 0; this.note(detail); return this; },
    step(n = 1, detail) { this.done = Math.min(this.total, this.done + n); this.note(detail); },
    note(detail) { if (detail !== undefined) this.detail = detail; paint(progress(), detail || ui.lbl.textContent, `${this.done}/${this.total} ${this.detail}`); },
    end(detail) { this.done = this.total; this.note(detail); },
  };
  return (stages[id] = s);
}

// ---------------------------------------------------------------- boot
async function boot() {
  plan = { imported: false, players: false, warm: false };
  trackDownloads();
  paint(0, 'Starting');
  const gfx = await import('../graphics.js').catch(() => null);
  const tierInfo = gfx ? gfx.resolveTier() : { tier: 'high', pref: 'auto', probe: {} };
  paint(progress(), 'Downloading', `${mb(netBytes())} / ${mb(netTotal)} MB`);
  const fontsIn = loadFonts();

  for (let i = 0; i < 200 && !window.BM; i++) await new Promise(r => setTimeout(r, 25));
  if (!window.BM) return fail('The game rules could not be loaded from the host PC.<br>Check the host is still running, then reload.');
  // things computed on an earlier visit (the fitted kit) are read back before the game asks for them
  for (const k of Object.values(M.derived || {})) { const v = await store.get(k); if (v) mem.set(k, v); }

  let app;
  try { app = await import(M.entry); } catch (e) { console.error(e); return fail('The game code could not be loaded.<br>' + String(e && e.message || e)); }
  plan.imported = true; paint(progress(), 'Building the court');

  const api = {
    tier: tierInfo.tier, pref: tierInfo.pref, probe: tierInfo.probe, manifest: M,
    derived: M.derived,
    asset: name => {
      const a = M.assets[name];
      return a ? bytes(a) : Promise.reject(new Error('not in the manifest: ' + name));
    },
    cache: { get: k => mem.get(k) || null, put: (k, v) => { mem.set(k, v); store.put(k, v).catch(() => { }); } },
    stage,
    note: t => paint(progress(), t),
    yield: () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))),
    playersReady: () => { plan.players = true; paint(progress(), 'Warming up'); },
    async ready() {
      if (finished) return;
      await fontsIn;
      plan.warm = true; paint(1, 'Ready');
      finished = true;
      el.classList.add('out'); setTimeout(() => el.remove(), 450);
    },
    fail,
  };
  try { await app.start(api); } catch (e) {
    console.error(e);
    if (e && e.status === 404) return fail('A game file is missing (the host has been updated). Reload to get the new build.');
    fail('Something went wrong while starting the game.<br>' + String(e && e.message || e).replace(/[<>&]/g, ''));
  }
}
boot().catch(e => { console.error(e); fail(String(e && e.message || e)); });
