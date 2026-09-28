'use strict';
// Office Ball — the asset pipeline (server side).
//
// Every file the game loads is served under a URL that names its exact content: app code under the
// hash of the whole code set, models by their own content hash, three.js and the fonts by their
// package version. So a browser can keep every one of them forever without asking again
// ("immutable"), and a changed file simply gets a new URL; nothing is ever stale and nothing is
// re-downloaded that hasn't changed.
//
// Each page load also gets a manifest: every file the game needs, with its exact size and hash.
// That is what lets the loading screen count real bytes against a real total, and lets the client
// keep its own content-addressed copies (IndexedDB) that survive even a hard refresh.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const SHARED = path.join(ROOT, 'shared');
const NM = path.join(ROOT, 'node_modules');
const THREE_DIR = path.join(NM, 'three');
const MODELS = path.join(PUB, 'models');
const version = pkg => JSON.parse(fs.readFileSync(path.join(NM, pkg, 'package.json'), 'utf8')).version;
const THREE_V = version('three');

// The font faces the game draws with (style.css, the HUD, the kit numbers and the jumbotron). The
// Latin subset of each is part of the boot download; every other subset is registered too, but the
// browser fetches it only if some text actually needs it (a name in Cyrillic, say).
const FONTS = [
  { pkg: 'barlow-condensed', normal: [500, 600, 700, 800, 900], italic: [800, 900] },
  { pkg: 'barlow', normal: [400, 500, 600], italic: [] },
  { pkg: 'teko', normal: [600, 700], italic: [] },
];

// ---------------------------------------------------------------- file cache
// Contents, hash and compressed forms per file, recomputed only when the file changes on disk
// (checked by size + mtime on every manifest build, so editing a file never needs a restart).
const cache = new Map();
function file(abs) {
  const st = fs.statSync(abs);
  let f = cache.get(abs);
  if (!f || f.mtimeMs !== st.mtimeMs || f.size !== st.size) {
    const buf = fs.readFileSync(abs);
    f = { abs, mtimeMs: st.mtimeMs, size: buf.length, buf, hash: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16), enc: {}, imports: null };
    cache.set(abs, f);
  }
  return f;
}
const COMPRESSIBLE = new Set(['.js', '.css', '.json', '.glb', '.html', '.svg']);
// gzip / brotli, computed off the main thread once per file version; kept only when it pays
function encoded(f, enc) {
  if (!f.enc[enc]) {
    f.enc[enc] = new Promise(resolve => {
      const done = (e, out) => resolve(!e && out.length < f.size * 0.9 ? out : null);
      if (enc === 'br') zlib.brotliCompress(f.buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: f.size } }, done);
      else zlib.gzip(f.buf, { level: 9 }, done);
    });
  }
  return f.enc[enc];
}

// ---------------------------------------------------------------- the module graph
// Every ES module the game imports, found by following import statements from the entry. The page
// preloads the whole graph in parallel (no request waterfall) and counts each file's bytes.
function resolveSpec(spec, fromAbs) {
  if (spec === 'three') return path.join(THREE_DIR, 'build', 'three.module.js');
  if (spec.startsWith('three/addons/')) return path.join(THREE_DIR, 'examples', 'jsm', spec.slice(13));
  if (spec.startsWith('./') || spec.startsWith('../')) return path.resolve(path.dirname(fromAbs), spec);
  return null;
}
const IMPORT_RE = /\b(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
function importsOf(f) {
  if (!f.imports) {
    // comments hold example code ("import X from ..."), so they go first; line comments only where a
    // line starts with one, so a '//' inside a string is left alone
    const src = f.buf.toString('utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const out = new Set();
    for (const m of src.matchAll(IMPORT_RE)) {
      const abs = resolveSpec(m[1] || m[2], f.abs);
      if (abs && fs.existsSync(abs)) out.add(abs);
    }
    f.imports = [...out];
  }
  return f.imports;
}
function moduleGraph(entryAbs) {
  const seen = new Set([entryAbs]), order = [entryAbs];
  for (let i = 0; i < order.length; i++) for (const d of importsOf(file(order[i]))) if (!seen.has(d)) { seen.add(d); order.push(d); }
  return order;
}

// ---------------------------------------------------------------- fonts
function parseFontCss(pkg, weight, italic) {
  const dir = path.join(NM, '@fontsource', pkg), css = path.join(dir, `${weight}${italic ? '-italic' : ''}.css`);
  const out = [];
  for (const m of fs.readFileSync(css, 'utf8').matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)) {
    const body = m[2], get = k => (body.match(new RegExp(k + '\\s*:\\s*([^;]+);')) || [])[1];
    const woff2 = (body.match(/url\(\.\/files\/([^)]+\.woff2)\)/) || [])[1];
    if (!woff2) continue;
    out.push({ subset: m[1], family: get('font-family').replace(/['"]/g, '').trim(), style: get('font-style').trim(), weight: String(weight), range: get('unicode-range').trim(), abs: path.join(dir, 'files', woff2), url: `/vendor/@fontsource/${pkg}@${version('@fontsource/' + pkg)}/files/${woff2}` });
  }
  return out;
}
let fontList = null;
function fonts() {
  if (!fontList) {
    fontList = [];
    for (const F of FONTS) for (const [ws, it] of [[F.normal, false], [F.italic, true]]) for (const w of ws) {
      for (const face of parseFontCss(F.pkg, w, it)) fontList.push(Object.assign(face, { eager: /-latin-\d/.test(face.subset) }));
    }
  }
  return fontList;
}

// ---------------------------------------------------------------- manifest
const appFiles = () => fs.readdirSync(PUB).filter(n => /\.(js|css)$/.test(n)).map(n => path.join(PUB, n)).concat(path.join(SHARED, 'game.js'));
let last = null;
function manifest() {
  // one hash over all app code: the directory its URLs live under
  const code = appFiles().map(file);
  const codeHash = crypto.createHash('sha256').update(code.map(f => f.abs + f.hash).join('|')).digest('hex').slice(0, 12);
  const models = fs.readdirSync(MODELS).filter(n => !/\.txt$/i.test(n)).sort().map(n => [n, file(path.join(MODELS, n))]);
  const key = codeHash + models.map(([n, f]) => n + f.hash).join('');
  if (last && last.key === key) return last.m;

  const appUrl = abs => abs === path.join(SHARED, 'game.js') ? `/app/${codeHash}/shared/game.js` : `/app/${codeHash}/` + path.relative(PUB, abs).split(path.sep).join('/');
  const urlOf = abs => abs.startsWith(THREE_DIR + path.sep) ? `/vendor/three@${THREE_V}/` + path.relative(THREE_DIR, abs).split(path.sep).join('/') : appUrl(abs);
  const entry = path.join(PUB, 'client.js');
  const modules = moduleGraph(entry).map(abs => { const f = file(abs); return { url: urlOf(abs), size: f.size, hash: f.hash }; });
  const game = file(path.join(SHARED, 'game.js'));
  const assets = {};
  for (const [n, f] of models) assets[n] = { url: `/asset/${f.hash}/${n}`, size: f.size, hash: f.hash };
  const humanHash = file(path.join(PUB, 'human.js')).hash;
  const m = {
    build: codeHash,
    entry: urlOf(entry),
    loader: appUrl(path.join(PUB, 'loader.js')),
    style: appUrl(path.join(PUB, 'style.css')),
    script: { url: appUrl(path.join(SHARED, 'game.js')), size: game.size },
    modules,
    fonts: fonts().map(f => { const x = file(f.abs); return { family: f.family, style: f.style, weight: f.weight, range: f.range, url: f.url, size: x.size, hash: x.hash, eager: f.eager }; }),
    assets,
    // things the client computes once and keeps: named by the inputs they are computed from, so a
    // change to either input makes a new key and the old result is never used again.
    // kit: the kits fitted to the body (human.js buildKit) — from body.glb and the code that fits them
    derived: { kit: `kit:${assets['body.glb'].hash}:${humanHash}` },
    importmap: { imports: { three: `/vendor/three@${THREE_V}/build/three.module.js`, 'three/addons/': `/vendor/three@${THREE_V}/examples/jsm/` } },
  };
  last = { key, m };
  // compress everything the page is about to ask for now, in the background, so no request waits on it
  for (const u of modules) { const abs = resolveUrl(u.url); if (abs) encoded(file(abs), 'gzip'); }
  for (const [, f] of models) if (COMPRESSIBLE.has(path.extname(f.abs))) encoded(f, 'gzip');
  return m;
}

// ---------------------------------------------------------------- URL -> file
// Only URLs the current manifest could produce resolve. A request for code under an older hash
// (a page open across a server update) gets a 404: the loader then reloads into the new build
// instead of mixing old and new modules.
function resolveUrl(u) {
  let m;
  if ((m = u.match(/^\/app\/([0-9a-f]{12})\/(.+)$/))) {
    if (!last || m[1] !== last.m.build) return null;
    if (m[2] === 'shared/game.js') return path.join(SHARED, 'game.js');
    const abs = path.normalize(path.join(PUB, m[2]));
    return abs.startsWith(PUB + path.sep) && /\.(js|css)$/.test(abs) ? abs : null;
  }
  if ((m = u.match(/^\/vendor\/three@([\w.-]+)\/((?:build|examples\/jsm)\/.+)$/))) {
    if (m[1] !== THREE_V) return null;
    const abs = path.normalize(path.join(THREE_DIR, m[2]));
    return abs.startsWith(THREE_DIR + path.sep) ? abs : null;
  }
  if ((m = u.match(/^\/vendor\/@fontsource\/([a-z-]+)@([\w.-]+)\/files\/([\w.-]+\.woff2?)$/))) {
    if (!FONTS.some(F => F.pkg === m[1]) || m[2] !== version('@fontsource/' + m[1])) return null;
    return path.join(NM, '@fontsource', m[1], 'files', m[3]);
  }
  if ((m = u.match(/^\/asset\/([0-9a-f]{16})\/([\w.-]+)$/))) {
    const abs = path.join(MODELS, m[2]);
    return fs.existsSync(abs) && file(abs).hash === m[1] ? abs : null;
  }
  return null;
}

module.exports = { file, encoded, manifest, resolveUrl, COMPRESSIBLE };
