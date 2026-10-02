// How the keyboard (arcade) movement plays for a human. A scripted player on WASD: 8 directions
// only, a reaction delay, a misjudged target (noise per shot), keys re-chosen only every few ticks,
// let go when they think they are there, and the press scattered around the ring. Reports how often
// presses connect, how far off the spot the player stood, dives, and how the player moved (overshoot,
// snapping turns). Run: node tools/feel_test.js [--quiet]
let seed = 11;
Math.random = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822507) ^ Math.imul(seed ^ (seed >>> 13), 3266489909)) >>> 0) / 4294967296;
const BM = require('../shared/badminton.js');
const I = o => Object.assign({ u: 0, d: 0, l: 0, r: 0, k: false, kp: 0, kc: null, dv: 0, sp: false, jp: 0, ax: 0, ay: 0, lob: false, kn: 0, sw: 0, arc: 1, swm: 1, mg: 1, as: 1 }, o);
const gauss = () => Math.sqrt(-2 * Math.log(Math.random() + 1e-9)) * Math.cos(2 * Math.PI * Math.random());

function play({ matches = 8, aimErr = 0.4, pressErr = 200, skill = 0.8 } = {}) {
  const R = { presses: 0, hits: 0, whiffs: 0, dives: 0, q: [], off: [], perfHit: 0, perfPress: 0, turns: [], snaps: 0, ticks: 0 };
  for (let m = 0; m < matches; m++) {
    const s = BM.createSim(0, { ai: [false, true], botSkill: skill });
    let n = 0, react = 0, lastLh = -1, plan = null, pressAt = null, offMs = 0, noise = null, keys = { u: 0, d: 0, l: 0, r: 0 }, think = 0, pv = null;
    for (let t = 0; t < 60 * 60 * 5 && s.phase !== 'over'; t++) {
      const me = s.players[0], b = s.ball;
      let inp = {};
      if (s.lastHitter !== lastLh) { lastLh = s.lastHitter; react = 10 + Math.floor(Math.random() * 8); plan = null; pressAt = null; noise = { x: gauss() * aimErr, y: gauss() * aimErr }; }
      if (s.phase === 'serve' && s.server === 0 && s.serveHold && s.tick - s.ps > 30) { n++; inp = { sw: n, sg: 1, si: 0.92 }; }
      else if (s.phase === 'rally' && b.last === 1) {
        if (react > 0) { react--; keys = { u: 0, d: 0, l: 0, r: 0 }; }
        else if (--think <= 0) {
          think = 4 + Math.floor(Math.random() * 4); // keys change only this often
          const mt = BM.meetTarget(s, me);
          keys = { u: 0, d: 0, l: 0, r: 0 };
          if (mt) {
            const dx = mt.x + noise.x - me.x, dy = mt.y + noise.y - me.y, d = Math.hypot(dx, dy);
            if (d > 0.3) { // the 8-way key nearest the wanted direction
              const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, cx = Math.round(Math.cos(a)), cy = Math.round(Math.sin(a));
              keys = { r: +(cx > 0), l: +(cx < 0), d: +(cy > 0), u: +(cy < 0) };
            }
          }
        }
        inp = Object.assign({}, keys);
        plan = BM.ringPlan(s, { i: 0, x: me.x, y: me.y, z: me.z }, s.lastHitter + ':' + s.rally + ':' + (s.score[0] + s.score[1]), plan);
        if (plan && pressAt == null) { offMs = gauss() * pressErr * 0.6; pressAt = plan.tick + Math.round(offMs * 0.06); }
        if (pressAt != null && pressAt >= 0 && s.tick === pressAt) {
          const a = Math.abs(offMs), g = a <= 50 ? 0 : a <= 90 ? 1 : a <= 140 ? 2 : a <= 240 ? 3 : 4;
          n++; R.presses++; if (g === 0) R.perfPress++;
          Object.assign(inp, { sw: n, sg: g, si: 0.92, svt: s.tick });
          pressAt = -1;
          R._pend = { g, off: Math.round(offMs), sx: plan.sx, sy: plan.sy, until: s.tick + 30 };
        }
      } else { pressAt = null; keys = { u: 0, d: 0, l: 0, r: 0 }; }
      BM.stepSim(s, [I(inp), BM.botInput(s, 1)]);
      // movement smoothness: the change of heading per tick while running
      const v = Math.hypot(me.vx, me.vy);
      if (pv && v > 2 && pv.v > 2) { const da = Math.abs(Math.atan2(me.vx * pv.vy - me.vy * pv.vx, me.vx * pv.vx + me.vy * pv.vy)); R.turns.push(da); if (da > 0.35) R.snaps++; }
      pv = { vx: me.vx, vy: me.vy, v };
      R.ticks++;
      for (const e of s.events) {
        if (e.p !== 0 || !R._pend) continue;
        if (e.type === 'hit') { R.hits++; R.q.push(e.q); R.off.push(Math.hypot(me.x - R._pend.sx, me.y - R._pend.sy)); if (R._pend.g === 0) R.perfHit++; R._pend = null; }
        else if (e.type === 'dive' || (e.type === 'swing' && e.whiff)) {
          if (e.type === 'dive') R.dives++; else R.whiffs++;
          (R.missOff = R.missOff || []).push(+Math.hypot(me.x - R._pend.sx, me.y - R._pend.sy).toFixed(1));
          if (process.env.DBG) console.log(e.type, JSON.stringify(R._pend), 'now', s.tick, 'ball', [b.x, b.y, b.z, b.vz].map(v => +v.toFixed(2)), 'me', [me.x, me.y].map(v => +v.toFixed(2)), s.lastKind);
          R._pend = null;
        }
      }
      if (R._pend && s.tick > R._pend.until) R._pend = null;
      s.events.length = 0;
    }
  }
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  return {
    presses: R.presses, hitRate: +(R.hits / R.presses).toFixed(3), whiffs: R.whiffs, dives: R.dives,
    perfectConnect: +(R.perfHit / Math.max(1, R.perfPress)).toFixed(3), q: +avg(R.q).toFixed(3), offSpot: +avg(R.off).toFixed(2),
    missOffSpot: (R.missOff || []).sort((a, b) => a - b).join(" "),
    snapTurnsPerMin: +(R.snaps / (R.ticks / 3600)).toFixed(1),
  };
}
module.exports = { play };
if (require.main === module) {
  const out = { careful: play({ aimErr: 0.25, pressErr: 120 }), casual: play({ aimErr: 0.5, pressErr: 220 }), sloppy: play({ aimErr: 0.8, pressErr: 300 }) };
  if (!process.argv.includes('--quiet')) console.log(JSON.stringify(out, null, 1));
  // the bar: a careful player connects nearly every press, a casual one most; dives stay rare
  const bad = [];
  if (out.careful.hitRate < 0.8) bad.push(`careful hit rate ${out.careful.hitRate} < 0.8`);
  if (out.casual.hitRate < 0.7) bad.push(`casual hit rate ${out.casual.hitRate} < 0.7`);
  for (const k in out) if (out[k].dives > out[k].presses * 0.04) bad.push(`${k}: ${out[k].dives} dives in ${out[k].presses} presses`);
  for (const k in out) if (out[k].perfectConnect < 0.8) bad.push(`${k}: perfect presses connect ${out[k].perfectConnect}`);
  console.log(bad.length ? 'FAIL\n  ' + bad.join('\n  ') : 'PASS');
  process.exit(bad.length ? 1 : 0);
}
