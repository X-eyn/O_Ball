// Office Ball — frame pacing and the performance monitor.
//
// Smoothness is evenness, not a big number: 60 frames spaced exactly one refresh apart feel fluid,
// 70-90 frames at uneven spacing feel choppy. So the game draws on a fixed cadence locked to the
// display: every refresh on 60/75/90 Hz screens, every second refresh on 120 Hz and faster ones
// (an even 60, and the phone runs cooler for longer). The renderer is then given that cadence as
// its time budget per frame and fits its work inside it (render3d.js, adapt).
//
// The display's refresh interval isn't exposed to pages, so it is learned from animation-frame
// timestamps: the shortest interval that keeps recurring is one refresh. Remembered per device.
const get = k => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch { } };

export function createPacer() {
  let vsync = +get('ob_vsync') || 1000 / 60, half = false, maxFps = 0;
  const deltas = [];
  let last = 0, lastDraw = 0, n = 0;
  // over 100 Hz: every second refresh. Half-rate aims at a steady 30/s (a ragged 50 is what
  // stutters); maxFps caps the cadence (touch devices hold 60 at most)
  const divisor = () => {
    let n = vsync < 10 ? 2 : 1;
    if (maxFps > 0) n = Math.max(n, Math.ceil(1000 / maxFps / vsync - 0.01));
    if (half) n = Math.max(n, Math.round(33.34 / vsync - 0.2));
    return n;
  };
  // the recurring shortest interval: the 10th percentile of recent intervals, confirmed by enough
  // intervals sitting within 12% of it (a single fast outlier is not a refresh rate)
  function learn() {
    const s = deltas.slice().sort((a, b) => a - b), p10 = s[Math.floor(s.length * 0.1)];
    const near = s.filter(d => Math.abs(d - p10) < p10 * 0.12);
    if (near.length < s.length * 0.15) return;
    const v = near[near.length >> 1];
    if (Math.abs(v - vsync) > vsync * 0.06) { vsync = v; set('ob_vsync', v.toFixed(3)); }
  }
  return {
    // called on every animation frame: true when this one should be drawn
    tick(now) {
      const d = now - last; last = now;
      if (d > 3 && d < 70) { deltas.push(d); if (deltas.length > 180) deltas.shift(); if (++n % 90 === 0 && deltas.length >= 90) learn(); }
      // draw once at least (divisor - 0.5) refreshes have passed: late frames never wait longer
      if (now - lastDraw < vsync * (divisor() - 0.5)) return false;
      lastDraw = now;
      return true;
    },
    get vsync() { return vsync; },
    get target() { return vsync * divisor(); }, // ms per drawn frame
    get half() { return half; },
    setHalf(on) { half = !!on; },
    setMaxFps(f) { maxFps = +f || 0; },
  };
}

// Frame-by-frame measurements, summarised on demand: what the player actually got (delivered frame
// intervals, how many missed the cadence) and where the time went (main-thread work per section,
// GPU time where the browser can measure it).
export function createMonitor() {
  const N = 600, rows = [];
  let lastAt = 0;
  return {
    record(now, js, r) {
      const dt = lastAt ? now - lastAt : 0; lastAt = now;
      if (dt <= 0 || dt > 250) return; // a hidden tab or a stall between views: not a frame interval
      rows.push({ dt, js, r: r ? { ...r } : null });
      if (rows.length > N) rows.shift();
    },
    reset() { rows.length = 0; lastAt = 0; },
    summary(target) {
      if (rows.length < 30) return null;
      const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
      const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
      const dts = rows.map(x => x.dt), js = rows.map(x => x.js), rs = rows.map(x => x.r).filter(Boolean), last = rs[rs.length - 1] || {};
      const sec = k => +avg(rs.map(r => r[k] || 0)).toFixed(2);
      const g = rs.map(r => r.gpu).filter(v => v !== null && v !== undefined);
      return {
        fps: +(1000 / avg(dts)).toFixed(1), p50: +q(dts, 0.5).toFixed(1), p95: +q(dts, 0.95).toFixed(1),
        missed: +(dts.filter(d => d > target * 1.5).length / dts.length * 100).toFixed(1), // % of frames that skipped a beat
        js: +avg(js).toFixed(2), js95: +q(js, 0.95).toFixed(2),
        players: sec('players'), ball: sec('ball'), world: sec('world'), submit: sec('submit'),
        gpu: g.length ? +avg(g).toFixed(2) : null, calls: last.calls, tris: last.tris,
        size: last.w ? `${last.w}x${last.h}` : null, pr: last.pr ? +last.pr.toFixed(2) : null, scale: last.scale ? +last.scale.toFixed(2) : null, level: last.level, tier: last.tier,
        target: +target.toFixed(2), frames: rows.length,
      };
    },
  };
}
