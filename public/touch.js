// Office Ball — touch controls for phones and tablets, held sideways.
//
// Left thumb: a floating analog stick. It appears wherever the thumb lands on the left half of the
// screen (no hunting for a fixed pad), and if the thumb runs past its edge the base follows, so a
// reversal is instant. It is analog like a controller: ease off to keep the ball close, full tilt
// to sprint (the knob lights up at full tilt, where the ball starts to run away from you).
//
// Right thumb: three buttons in the arc the thumb sweeps from its resting place.
//   SHOOT   the big one, where the thumb rests. Hold and release; the ring around it fills with the
//           charge, the gold arc is the perfect window (the button turns gold inside it, and the
//           phone ticks as you enter it), grey means overcooked.
//   TACKLE  to its left. Mid-charge it fakes the shot: slide the shooting thumb onto it.
//           The dark sweep over it is the real cooldown.
//   CHIP    up and to the left: charged like a shot, lifted over the keeper.
//   BALL    solo practice only: brings the ball to your feet.
// Every control acts on touch-down (no tap delay) and keeps its finger until that finger lifts,
// wherever it slides; any number of fingers at once.
const NS = 'http://www.w3.org/2000/svg';
const CT_MAX = 60; // charge ticks the ring spans (the perfect window is inside it)

export function createTouchControls(view, C, h) {
  const root = document.createElement('div');
  root.id = 'touch';
  root.innerHTML = `
    <div class="stick idle"><div class="stick-base"><i class="sprint"></i></div><div class="stick-knob"></div><span class="stick-cap">Move</span></div>
    <button type="button" class="tbtn shoot" data-b="shoot" aria-label="Shoot (hold and release)"><svg class="ring" viewBox="0 0 100 100"></svg><span>Shoot</span></button>
    <button type="button" class="tbtn chip" data-b="chip" aria-label="Chip (hold and release)"><svg class="ring" viewBox="0 0 100 100"></svg><span>Chip</span></button>
    <button type="button" class="tbtn tackle" data-b="tackle" aria-label="Tackle"><i class="cd"></i><span>Tackle</span></button>
    <button type="button" class="tbtn ball hidden" data-b="ball" aria-label="Bring the ball to me"><span>Ball</span></button>`;
  view.appendChild(root);
  const stickEl = root.querySelector('.stick'), base = root.querySelector('.stick-base'), knob = root.querySelector('.stick-knob');
  const btn = Object.fromEntries([...root.querySelectorAll('.tbtn')].map(b => [b.dataset.b, b]));

  // charge rings: the track, the perfect window, and the charge itself
  const rings = {};
  for (const k of ['shoot', 'chip']) {
    const svg = btn[k].querySelector('.ring'), R = 46, L = 2 * Math.PI * R;
    const arc = (cls, from, to) => {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', 50); c.setAttribute('cy', 50); c.setAttribute('r', R); c.setAttribute('class', cls);
      c.style.strokeDasharray = `${(to - from) * L} ${L}`; c.style.strokeDashoffset = `${-from * L}`;
      svg.appendChild(c); return c;
    };
    arc('trk', 0, 1);
    arc('win', C.CHARGE_FULL / CT_MAX, C.PERF_END / CT_MAX);
    rings[k] = { L, fill: arc('fill', 0, 0) };
  }

  // ---------------------------------------------------------------- pointers
  const owners = new Map(); // pointerId -> { role: 'stick' | 'shoot' | 'chip' | 'tackle' | 'ball', ... }
  let shown = false, stick = null, heldBtn = null, lastWin = false;
  const radius = () => base.offsetWidth / 2 || 60;

  function setStick(dx, dy) {
    const R = radius();
    let m = Math.hypot(dx, dy) / R;
    const kx = m > 1 ? dx / m : dx, ky = m > 1 ? dy / m : dy;
    knob.style.transform = `translate(${kx.toFixed(1)}px,${ky.toFixed(1)}px)`;
    // dead zone, then linear: small movements are fine control, not drift
    const DZ = 0.12, out = m < DZ ? 0 : Math.min(1, (m - DZ) / (0.92 - DZ));
    stickEl.classList.toggle('full', out >= 0.999);
    if (!out) return h.stick(0, 0);
    const d = Math.hypot(dx, dy);
    h.stick(dx / d * out, dy / d * out);
  }
  function placeStick(x, y) {
    // keep the whole base on screen, whatever the finger's landing spot
    const R = radius(), r = root.getBoundingClientRect();
    const cx = Math.max(R + 6, Math.min(r.width / 2 - R, x)), cy = Math.max(R + 6, Math.min(r.height - R - 6, y));
    stick.cx = cx; stick.cy = cy;
    stickEl.style.left = cx + 'px'; stickEl.style.top = cy + 'px';
  }
  const capture = id => { try { root.setPointerCapture(id); } catch { } };
  const local = e => { const r = root.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const within = (el, e) => { const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2; return Math.hypot(e.clientX - cx, e.clientY - cy) <= r.width / 2 + 10; };

  root.addEventListener('pointerdown', e => {
    if (!shown) return;
    e.preventDefault();
    h.activate();
    const b = e.target.closest('.tbtn');
    const { x, y } = local(e);
    if (b && !b.classList.contains('hidden')) {
      const role = b.dataset.b;
      // one charge at a time: a second finger on the other charge button does nothing
      if ((role === 'shoot' || role === 'chip') && heldBtn) return;
      capture(e.pointerId);
      b.classList.add('down');
      if (role === 'shoot' || role === 'chip') {
        heldBtn = role; owners.set(e.pointerId, { role, faked: false });
        h.kickDown(role === 'chip' ? 'lob:touch' : 'touch');
      } else {
        owners.set(e.pointerId, { role });
        if (role === 'tackle') h.dash(); else h.ball();
      }
      buzz(8);
      return;
    }
    // the stick: the left half of the screen, one finger
    if (x < root.clientWidth / 2 && !stick) {
      capture(e.pointerId);
      stick = { id: e.pointerId, cx: x, cy: y };
      owners.set(e.pointerId, { role: 'stick' });
      stickEl.classList.remove('idle'); stickEl.classList.add('on');
      placeStick(x, y); setStick(0, 0);
    }
  });
  root.addEventListener('pointermove', e => {
    const o = owners.get(e.pointerId); if (!o) return;
    e.preventDefault();
    if (o.role === 'stick') {
      const { x, y } = local(e), R = radius();
      let dx = x - stick.cx, dy = y - stick.cy, d = Math.hypot(dx, dy);
      // past the rim, the base is dragged along behind the thumb
      if (d > R * 1.25) { const k = (d - R * 1.25) / d; stick.cx += dx * k; stick.cy += dy * k; stickEl.style.left = stick.cx + 'px'; stickEl.style.top = stick.cy + 'px'; dx = x - stick.cx; dy = y - stick.cy; }
      setStick(dx, dy);
    } else if ((o.role === 'shoot' || o.role === 'chip') && !o.faked && within(btn.tackle, e)) {
      // the one-thumb fake: slide from the charging button onto tackle
      o.faked = true; h.dash(); btn.tackle.classList.add('down'); buzz(12);
      setTimeout(() => btn.tackle.classList.remove('down'), 160);
    }
  });
  const end = e => {
    const o = owners.get(e.pointerId); if (!o) return;
    owners.delete(e.pointerId);
    if (o.role === 'stick') { stick = null; stickEl.classList.remove('on', 'full'); stickEl.classList.add('idle'); stickEl.style.left = stickEl.style.top = ''; knob.style.transform = ''; h.stick(0, 0); }
    else {
      btn[o.role].classList.remove('down');
      if (o.role === heldBtn) { heldBtn = null; h.kickUp(o.role === 'chip' ? 'lob:touch' : 'touch'); }
    }
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  root.addEventListener('lostpointercapture', end);
  for (const ev of ['contextmenu', 'selectstart', 'dragstart']) root.addEventListener(ev, e => e.preventDefault());

  // vibration only after a real tap on the page (browsers refuse it before that)
  function buzz(p) { try { if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(p); } catch { } }

  // ---------------------------------------------------------------- per frame
  // v: { ct: local charge ticks (-1 = not charging), lob, dashCd: 0..C.DASH_CD, solo }
  function update(v) {
    if (!shown) return;
    btn.ball.classList.toggle('hidden', !v.solo);
    for (const k of ['shoot', 'chip']) {
      const r = rings[k], on = heldBtn === k && v.ct >= 0;
      const f = on ? Math.min(1, v.ct / CT_MAX) : 0;
      r.fill.style.strokeDasharray = `${f * r.L} ${r.L}`;
      const win = on && v.ct >= C.CHARGE_FULL && v.ct <= C.PERF_END;
      btn[k].classList.toggle('perfect', win);
      btn[k].classList.toggle('over', on && v.ct > C.PERF_END);
      btn[k].classList.toggle('charging', on);
    }
    const inWin = btn.shoot.classList.contains('perfect') || btn.chip.classList.contains('perfect');
    if (inWin && !lastWin) buzz(14); // the moment to let go
    lastWin = inWin;
    const cd = Math.max(0, Math.min(1, (v.dashCd || 0) / C.DASH_CD));
    btn.tackle.style.setProperty('--cd', cd.toFixed(3));
    btn.tackle.classList.toggle('cooling', cd > 0);
  }

  // let go of everything (menu opened, app backgrounded, controls hidden)
  function reset() {
    for (const id of [...owners.keys()]) { try { root.releasePointerCapture(id); } catch { } end({ pointerId: id }); }
    owners.clear(); stick = null; heldBtn = null;
  }
  function show(on) {
    if (on === shown) return;
    shown = on; root.classList.toggle('on', on);
    if (!on) reset();
  }
  return { show, reset, update, get shown() { return shown; } };
}
