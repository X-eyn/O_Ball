// Office Badminton — footwork: which way a player faces, how the feet move under them, the dive and
// the get-up. The sim's facing (p[4], p[5]) is the aim, the direction the stick is held; it is not
// the body. A badminton player's body is organised round the net:
//
//   facing   square to the net in the ready position. Moving across the court the hips stay square
//            (a chassé: step, close, the feet never cross); the faster and longer the run, the more
//            the hips open toward it. Going back, the player turns side-on, the right shoulder drawn
//            back (chest to the right sideline) for the forehand and round-the-head corners, the
//            left shoulder back for a clear backhand diagonal, and chassés back side-on, never with
//            the back to the net and never in a moonwalk. Going forward the body faces the run.
//            An overhead charge turns the body side-on; the stroke's own hip and trunk rotation
//            does the rest. The turn is a damped spring on the angle from the net, so it is always
//            smooth, never faster than a real pivot, and never swings round the back.
//   feet     every foot is planted (its ball joint fixed on the floor, the foot may pivot on it) or
//            swinging to a planned foothold. Slow and sideways movement is stepped here: a foot
//            lifts when the body has left it behind, and lands where it will be under the hip,
//            ahead by half a stance (Raibert). At pace in a straight line the mocap run takes over
//            with its cadence matched to the ground speed, and each foot is locked while it is down.
//            A two-bone IK puts the legs on the footholds with the knee over the toes.
//   dive     launch low along the run off the racket leg, near-horizontal, the racket arm reaching,
//            down on the chest and forearm, a short slide, then up through one knee to the ready
//            position, all on the sim's own clock (p[8] in flight, p[20] ticks on the floor).
import * as THREE from 'three';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const V3 = THREE.Vector3, QT = THREE.Quaternion;
const UP = new V3(0, 1, 0);
const _v1 = new V3(), _v2 = new V3(), _v3 = new V3(), _v4 = new V3(), _v5 = new V3(), _v6 = new V3();
const _q1 = new QT(), _q2 = new QT(), _q3 = new QT(), _q4 = new QT();

const SIMC = (typeof self !== 'undefined' && self.BM && self.BM.C) || {};
const DIVE_T = (SIMC.DIVE_T || 20) / 60;       // seconds in the air
const DIVE_REC = SIMC.DIVE_REC || 40;          // ticks on the floor and getting up

export const FW = {
  TH_MAX: 1.92,                                // the chest never turns further than this from the net (110 deg)
  // the ready stance, in metres from the body's centre (lat: + to the right), and each foot's yaw
  // (toes a little out); the racket foot a touch forward
  STANCE: { L: { lat: -0.17, fwd: -0.04, toe: 0.26 }, R: { lat: 0.17, fwd: 0.08, toe: -0.22 } },
  MIN_GAP: 0.19,                               // a chassé never brings the feet closer (no crossing)
  // the mocap run (cadence-matched, feet locked) can take over a straight run above RUN_IN m/s;
  // off by default: its stance is too short to plant at badminton speeds, the stepped run is exact
  RUN_IN: Infinity, RUN_OUT: 4.2,
};

// Legs: which bones, which contacts.
const SIDES = [['L', 'l'], ['R', 'r']];

export class Footwork {
  constructor(h) {
    this.h = h;
    this.rest = measureRest(h);
    this.side = 0; this.theta = 0; this.thetaV = 0; this.yaw = 0;
    this.vf = 0; this.vr = 0; this.af = 0; this.ar = 0; this.backSide = 1; this.backLatch = 0;
    this.mode = 'ready'; this.gait = 'ready'; this.run = false; this.pq = 1; this.ikW = 1; this.drop = 0;
    this.feet = { L: newFoot(), R: newFoot() };
    this.lastStep = 'L'; this.clock = 0; this.inited = false; this.lastPos = null;
    this.dive = { on: false, t: 0, dir: 0, tilt: 0, tiltV: 0, roll: 0, rollV: 0, lift: 0, back: 0, backV: 0, ax: new V3(1, 0, 0), s: 0, rel: 0 };
    this.lean = { f: 0, r: 0 };
    this.stats = { forced: 0, steps: 0, unreach: 0 };
  }

  // the snapshot row with every field finite: a missing field (an older server) or a broken one
  // reads as its resting value, a broken position as the last good one
  row(src) {
    const r = this._row || (this._row = new Array(21).fill(0)), last = this._last || (this._last = [0, 0]);
    for (let i = 0; i < 21; i++) {
      const v = src ? src[i] : undefined;
      r[i] = Number.isFinite(v) ? v : i < 2 ? last[i] : i === 6 ? -1 : i === 4 ? 1 : 0;
    }
    if (Math.abs(r[0]) > 60 || Math.abs(r[1]) > 60) { r[0] = last[0]; r[1] = last[1]; }
    for (const i of [2, 3]) r[i] = clamp(r[i], -30, 30);
    r[14] = clamp(r[14], 0, 4); last[0] = r[0]; last[1] = r[1];
    return r;
  }

  // ------------------------------------------------------------ before the pose: where to face,
  // which gait. f: the athlete's frame; p: its (sanitised) snapshot row; dt: this frame's seconds
  pre(f, p, dt, o) {
    const x = p[0], y = p[1], vx = p[2], vy = p[3];
    const z = p[14], squat = p[16], landT = p[17], diving = p[8] > 0.5, floorT = p[20], sprint = p[19] > 0.5;
    const d = this.dive;
    // court side: slot 0 lives at x < 0 and faces +x
    if (x < -0.25) this.side = 1; else if (x > 0.25) this.side = -1; else if (!this.side) this.side = x <= 0 ? 1 : -1;
    const sd = this.side, netYaw = sd > 0 ? Math.PI / 2 : -Math.PI / 2;
    // a jump in position (a new point, a reconnect) or a long stall: no history to blend from
    const jumped = this.lastPos && Math.hypot(x - this.lastPos[0], y - this.lastPos[1]) > 1.6;
    const snap = !this.inited || jumped || dt > 0.25;
    this.lastPos = [x, y];
    const k = dt > 0 ? 1 - Math.exp(-Math.min(dt, 0.1) / 0.045) : 0;
    // velocity in the net's frame (f: toward the net, r: to the player's right), and acceleration
    const vf = vx * sd, vr = vy * sd;
    const pvf = this.vf, pvr = this.vr;
    if (snap) { this.vf = vf; this.vr = vr; this.af = this.ar = 0; }
    else if (dt > 0) {
      this.vf += (vf - this.vf) * k; this.vr += (vr - this.vr) * k;
      const ka = 1 - Math.exp(-Math.min(dt, 0.1) / 0.08);
      this.af += (clamp((this.vf - pvf) / dt, -80, 80) - this.af) * ka; this.ar += (clamp((this.vr - pvr) / dt, -80, 80) - this.ar) * ka;
    }
    const spd = Math.hypot(this.vf, this.vr);
    const a = Math.atan2(this.vr, this.vf); // travel direction from the net, + to the right
    const cA = spd > 1e-4 ? this.vf / spd : 1;
    const run = smooth(2.5, 7, spd), move = smooth(0.35, 1.5, spd);
    const air = z > 0.02;

    // ---- the dive clock
    if (diving && !d.on) {
      d.on = true; d.t = 0; d.dir = spd > 0.5 ? a : (d.dir || 0); d.rel = 0;
      // the body's heading for this dive: headfirst along it where the body can turn that far, else
      // a side dive (the body tilts toward the dive whichever way it faces, so the overhead reach and
      // the head lead it either way); the cheapest of these from where the body faces now
      let best = null;
      for (const c of [d.dir, d.dir - Math.PI / 2, d.dir + Math.PI / 2]) {
        const cc = clamp(wrap(c), -FW.TH_MAX, FW.TH_MAX);
        const cost = Math.abs(cc - this.theta) * 0.8 + Math.abs(wrap(d.dir - cc)) * 0.5;
        if (!best || cost < best.cost) best = { cc, cost };
      }
      d.theta = best.cc;
    }
    if (!diving && floorT <= 0.01) d.on = false;
    if (diving) { d.t += dt; if (spd > 2) d.dir = a; }
    // time on the floor: 0 as the flight ends, 1 when back up
    d.s = floorT > 0 ? clamp(1 - floorT / DIVE_REC, 0, 1) : 0;
    const down = diving || floorT > 0;

    // ---- where to face: theta, the angle from the net (+ = turned to the right, right shoulder back)
    let th;
    // back half: which way to turn. Default the forehand side (right shoulder back, which is also the
    // round-the-head turn); a clear diagonal to the backhand corner turns the other way. Latched
    // while going back so the body never swings from one side-on to the other mid-retreat.
    const back = smooth(0.25, 0.75, -cA) * move;
    // the side this retreat would turn to (the backhand corner, unless the shuttle is high and near
    // enough to take round the head); decided while the retreat is only starting, then held
    let bs = 1;
    if (a < -1.9 && a > -2.6) {
      const bl = f.ball;
      const high = bl && num(bl[2]) > 2.5 && Math.abs((num(bl[0]) - x) * sd) < 3.5;
      bs = high ? 1 : -1;
    }
    if (back < 0.08) { this.backLatch = 0; this.backSide = bs; }
    else if (!this.backLatch) { this.backSide = bs; if (back > 0.3) this.backLatch = 1; }
    const kLat = lerp(0.12, 0.5, run) + (sprint ? 0.12 : 0), kFwd = lerp(0.4, 0.85, run);
    if (cA >= 0) th = a * lerp(kLat, kFwd, cA * cA);
    else {
      // side-on: turned so the retreat runs across the hips and a little behind them (a chassé back),
      // never straight behind them. Forehand side: the chest to the right sideline and, into the
      // round-the-head corner, further (the right shoulder toward the baseline); backhand mirrored.
      const aP = a < 0 ? a + 2 * Math.PI : a, aN = 2 * Math.PI - aP;
      const side = this.backSide > 0 ? clamp(aP - 1.75, 1.2, FW.TH_MAX) : -clamp(aN - 1.75, 1.2, FW.TH_MAX);
      th = lerp(Math.sign(a || 1) * Math.PI / 2 * kLat, side * lerp(0.88, 1, run), smooth(0.25, 0.75, -cA));
    }
    th *= move;
    // ready: square to the net, drawn a little toward a shuttle out wide on the far side
    if (f.ball && !down) {
      const bf = (num(f.ball[0]) - x) * sd, br = (num(f.ball[1]) - y) * sd;
      if (bf > 0.8) th += (1 - move) * clamp(Math.atan2(br, bf) * 0.35, -0.3, 0.3);
    }
    // the shot being loaded: an overhead turns the body side-on, a backhand turns the right shoulder
    // to the net; after the contact the body uncoils back toward the net
    const st = f.stroke, ck = f.chargeKind;
    const charging = p[6] >= 0;
    let want = null, ww = 0;
    const owned = Number.isFinite(o.strokeYawW); // the stroke layer says what an overhead wants
    if (st && st.u < 0.5) {
      const nm = st.name;
      const pre = 1 - smooth(-0.02, 0.2, st.u);
      if (!owned && (nm === 'over' || nm === 'smash' || nm === 'kill')) { want = Math.max(th, 0.75); ww = pre * 0.85; }
      else if (/^bh/.test(nm)) { want = Math.min(th, -0.45); ww = pre * 0.6; } // bh, bhunder, bhtouch, bhblock
      else if (nm === 'fh') { want = Math.max(th, 0.3); ww = pre * 0.5; }
    } else if (charging) {
      const c = clamp(p[6] / 42, 0, 1);
      if (!owned && (ck === 'over' || ck === 'smash')) { want = Math.max(th, 0.8); ww = 0.35 + 0.5 * c; }
      else if (/^bh/.test(ck || '')) { want = Math.min(th, -0.45); ww = 0.3 + 0.3 * c; }
      else if (ck === 'fh') { want = Math.max(th, 0.3); ww = 0.3 + 0.2 * c; }
    }
    if (want !== null) th = lerp(th, want, ww);
    if (owned && o.strokeYawW > 0.01) th = lerp(th, Math.max(th, num(o.strokeYawWant, 0.75)), clamp(o.strokeYawW, 0, 1) * 0.9);
    // diving: along the dive (as far as a body can turn from the net), then back round getting up
    if (d.on) {
      const dt_ = Number.isFinite(d.theta) ? d.theta : clamp(d.dir, -FW.TH_MAX, FW.TH_MAX);
      th = d.s < 0.55 ? dt_ : lerp(dt_, 0, smooth(0.55, 1, d.s));
    }
    // the trunk's own twist into a loaded overhead counts toward the turn: the chest stays inside the limit
    const twist = owned ? clamp(num(o.strokeYawW), 0, 1) * 0.75 : (charging && (ck === 'over' || ck === 'smash') ? 0.75 : 0);
    th = clamp(th, -FW.TH_MAX, FW.TH_MAX - twist);
    this.thetaWant = th;
    // a critically damped spring on theta, its rate capped at a quick pivot
    if (snap) { this.theta = th; this.thetaV = 0; }
    else if (dt > 0) {
      // a pivot is quickest when the run has got behind the hips
      const behind = spd > 2 && Math.abs(wrap(a - this.theta)) > 2.1;
      const w = d.on ? 22 : behind ? 22 : 18, maxV = d.on ? 16 : behind ? 11.5 : 10.5, h = Math.min(dt, 0.1);
      const n = Math.max(1, Math.ceil(h / (1 / 120)));
      for (let i = 0; i < n; i++) {
        const s = h / n;
        this.thetaV += (w * w * (th - this.theta) - 2 * w * this.thetaV) * s;
        this.thetaV = clamp(this.thetaV, -maxV, maxV);
        this.theta += this.thetaV * s;
      }
      this.theta = clamp(this.theta, -FW.TH_MAX - 0.05, FW.TH_MAX + 0.05);
    }
    this.yaw = netYaw - this.theta;

    // ---- travel relative to the body, and the gait
    const beta = wrap(a - this.theta); // + = to the body's right
    const uf = spd * Math.cos(beta), ur = spd * Math.sin(beta);
    this.uf = uf; this.ur = ur; this.spd = spd; this.beta = beta; this.cA = cA; this.a = a;
    // acceleration in the body frame: lean into it (and back against a braking step)
    const cb = Math.cos(this.theta), sb = Math.sin(this.theta);
    this.abf = this.af * cb + this.ar * sb; this.abr = -this.af * sb + this.ar * cb;
    const runOK = !down && !air && squat <= 0 && landT <= 0 && !o.lunge;
    if (this.run) { if (!runOK || uf < FW.RUN_OUT || Math.abs(beta) > 0.8) this.run = false; }
    else if (runOK && uf > FW.RUN_IN && Math.abs(beta) < 0.6) { this.run = true; this.alignPhase(); }
    let mode;
    if (diving) mode = 'dive';
    else if (floorT > 0) mode = d.s < 0.4 ? 'slide' : 'getup';
    else if (air) mode = 'jump';
    else if (squat > 0) mode = 'crouch';
    else if (landT > 0) mode = 'land';
    else if (o.lunge) mode = 'lunge';
    else if (this.run) mode = sprint ? 'sprint' : 'run';
    else if (spd < 0.35) mode = 'ready';
    else if (cA < -0.5 && Math.abs(this.theta) > 0.6) mode = 'back';
    else if (Math.abs(beta) > 0.9) mode = 'shuffle';
    else if (Math.abs(Math.sin(a)) > 0.75) mode = 'cross';
    else if (spd > 4) mode = sprint ? 'sprint' : 'run';
    else mode = 'step';
    this.mode = mode; this.o = o;
    // how the feet are driven: 'plan' (stepped here), 'anim' (the pose, each foot locked while
    // down) or 'free' (no ground: in the air, diving, on the floor)
    this.feetBy = (mode === 'dive' || mode === 'slide' || mode === 'jump' || (d.on && (d.s < 0.86 || Math.abs(d.tilt) > 0.12))) ? 'free'
      : (this.run || mode === 'land' || mode === 'crouch' || mode === 'lunge') ? 'anim' : 'plan';
    // the mocap: its speed and cadence (strides matched to the ground speed) while it runs
    const gs = this.h.group.scale.y || 1;
    if (this.run) {
      const L = this.rest.clip.Sprint_Loop.L * gs;
      this.animSpeed = Math.max(uf, 5.2 * gs);
      this.cadence = clamp(uf / Math.max(L, 0.5), 0.6, 2.2);
    } else { this.animSpeed = 0; this.cadence = undefined; }
    // lean: forward into the run and into acceleration, back against a braking step, a little into
    // the direction of a sideways push
    const lf = clamp((this.run ? 0 : 0.012 * uf) + 0.0065 * this.abf, -0.14, 0.2);
    const lr = clamp(0.01 * ur + 0.005 * this.abr, -0.14, 0.14);
    const kl = dt > 0 ? 1 - Math.exp(-Math.min(dt, 0.1) * 10) : 0;
    this.lean.f += (lf - this.lean.f) * (snap ? 1 : kl); this.lean.r += (lr - this.lean.r) * (snap ? 1 : kl);
    this.snap = snap; this.inited = true;
    this.gs = gs; this.sprint = sprint;
    this.clock += dt;
    return mode;
  }

  // ------------------------------------------------------------ the dive: the body's tilt, set on
  // the rig before the pose is solved (the ground contact then sees it)
  diveRig(dt) {
    const d = this.dive, h = this.h, g = h.group;
    // targets: tilt (from vertical, toward the dive), roll (onto the left side), back (shift of the
    // body behind the root so the hips stay over the sim's position), lift (the flight's arc)
    let tilt = 0, roll = 0, back = 0;
    if (d.on) {
      const s = d.s;
      if (this.mode === 'dive') {
        const u = clamp(d.t / DIVE_T, 0, 1);
        tilt = 1.42 * smooth(0, 0.6, u);
        roll = 0.25 * smooth(0.5, 1, u);
      } else {
        // on the floor: flat (slide), up onto the hands and a knee, then standing
        tilt = s < 0.38 ? 1.5 : s < 0.66 ? lerp(1.5, 0.55, smooth(0.38, 0.66, s)) : lerp(0.55, 0, smooth(0.66, 0.82, s));
        roll = s < 0.38 ? 0.32 : lerp(0.32, 0, smooth(0.38, 0.6, s));
      }
      back = Math.sin(Math.min(tilt, 1.5)) * 0.55;
    }
    const w = 20, n = dt > 0 ? Math.max(1, Math.ceil(Math.min(dt, 0.1) * 120)) : 0;
    for (let i = 0; i < n; i++) {
      const s = Math.min(dt, 0.1) / n;
      d.tiltV += (w * w * (tilt - d.tilt) - 2 * w * d.tiltV) * s; d.tilt += d.tiltV * s;
      d.rollV += (w * w * (roll - d.roll) - 2 * w * d.rollV) * s; d.roll += d.rollV * s;
      d.backV += (w * w * (back - d.back) - 2 * w * d.backV) * s; d.back += d.backV * s;
    }
    if (this.snap) { d.tilt = tilt; d.roll = roll; d.back = back; d.tiltV = d.rollV = d.backV = 0; }
    if (Math.abs(d.tilt) < 1e-4 && Math.abs(d.roll) < 1e-4 && Math.abs(d.back) < 1e-4) { g.quaternion.identity(); g.position.set(0, d.lift || 0, 0); return; }
    // the tilt axis: in the body's own frame (model: +z forward, +x to the left), across the dive
    const bd = wrap(d.dir - this.theta); // dive direction relative to the body, + to the right
    const dx = -Math.sin(bd), dz = Math.cos(bd);
    d.ax.set(dz, 0, -dx).normalize();
    _q1.setFromAxisAngle(d.ax, d.tilt);
    _q2.setFromAxisAngle(UP, d.roll);
    g.quaternion.copy(_q1).multiply(_q2);
    g.position.set(-dx * d.back * (this.gs || 1), d.lift || 0, -dz * d.back * (this.gs || 1));
  }

  // ------------------------------------------------------------ after the pose: floor clearance
  // (in a dive, get-up or anything else nothing may go through the floor), then the feet
  post(f, p, dt, hop) {
    const h = this.h, b = h.bone;
    h.group.updateMatrixWorld(true);
    this.feet_(f, p, dt, hop);
    // clearance: the whole body above the floor, by each part's thickness
    if (this.feetBy === 'free' || this.dive.on || this.dive.lift > 0) {
      // (the feet are the IK's while it owns them: they stand on the floor, they do not hold the body up)
      let need = -Infinity; const own = this.feetBy !== 'free' && this.ikW > 0.5;
      for (const [n, r] of CLEAR) { const bn = b[n]; if (!bn || (own && /^(foot|ball)_/.test(n))) continue; const yy = bn.getWorldPosition(_v1).y; if (r * (this.gs || 1) - yy > need) { need = r * (this.gs || 1) - yy; this.liftBy = n; } }
      if (!own) for (const c of h.contacts) { const yy = _v1.copy(c.p).applyMatrix4(c.bone.matrixWorld).y; need = Math.max(need, -yy); }
      if (!Number.isFinite(need)) need = 0;
      const cur = this.dive.lift || 0;
      // up at once, down gently (a body settles onto the floor, it does not drop through it)
      this.dive.lift = need > 0 ? cur + need : Math.max(0, cur + need * (1 - Math.exp(-28 * Math.min(dt, 0.1))));
      if (this.snap) this.dive.lift = Math.max(0, cur + need);
      h.group.position.y = this.dive.lift; h.group.updateMatrixWorld(true);
    } else { this.dive.lift = 0; if (h.group.position.y) { h.group.position.y = 0; h.group.updateMatrixWorld(true); } }
  }

  // ------------------------------------------------------------ the feet
  feet_(f, p, dt, hop) {
    const h = this.h, b = h.bone, gs = this.gs || 1, R = this.rest;
    const x = p[0], y = p[1];
    const yaw = this.yaw, fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -Math.cos(yaw), rz = Math.sin(yaw);
    const vx = num(p[2]), vy = num(p[3]), spd = Math.hypot(vx, vy);
    const by = this.feetBy;
    // IK weight: on the ground the feet are ours; in the air, diving or on the floor, the pose's
    const ikT = by === 'free' ? 0 : 1;
    const kk = dt > 0 ? 1 - Math.exp(-Math.min(dt, 0.1) * (ikT > this.ikW ? 90 : 30)) : 0;
    this.ikW = this.snap || ikT > this.ikW ? ikT : this.ikW + (ikT - this.ikW) * kk; // on at once (the targets start where the feet are), off smoothly
    // flat foot orientation blend: planned feet are flat on the floor; locked / free feet keep the pose's
    const pqT = by === 'plan' ? 1 : 0;
    this.pq = this.snap ? pqT : this.pq + (pqT - this.pq) * (dt > 0 ? 1 - Math.exp(-Math.min(dt, 0.1) * 12) : 0);
    // what the pose did with each foot (world), before the IK touches it
    const A = {};
    for (const [k, s] of SIDES) {
      const ft = b['foot_' + s], toe = b['ball_' + s];
      const ball = toe.getWorldPosition(new V3());
      let lo = Infinity; for (const c of R.cont[k]) lo = Math.min(lo, _v1.copy(c.p).applyMatrix4(c.bone.matrixWorld).y);
      A[k] = { ball, lo, qf: ft.getWorldQuaternion(new QT()), qt: toe.getWorldQuaternion(new QT()), yaw: footYaw(ft, R.leg[k]) };
    }
    const anchor = (k, px, py, yw) => {
      const S = FW.STANCE[k], sf = Math.sin(yw), cf = Math.cos(yw);
      return [px + sf * S.fwd * gs - cf * S.lat * gs, py + cf * S.fwd * gs + sf * S.lat * gs];
    };
    const F = this.feet;
    // a lunge steps the front foot out: it is not held down while the lunge reaches
    F.L.noLock = F.R.noLock = false;
    // (and the trail foot slides back on its toes as the lunge stretches: held, it folds the knee)
    if (this.mode === 'lunge' && this.o && this.o.lungeRising) { F[this.o.lungeSide < 0 ? 'L' : 'R'].noLock = true; F[this.o.lungeSide < 0 ? 'R' : 'L'].noLock = true; }
    // (re)start: both feet planted where they are, or under the hips when there is no history
    if (this.snap || !this.fInit) {
      for (const [k] of SIDES) {
        const ft = F[k], an = anchor(k, x, y, yaw);
        Object.assign(ft, { st: 'plant', x: an[0], z: an[1], yaw: yaw + FW.STANCE[k].toe, lift: 0, pitch: 0, lock: false, ox: 0, oz: 0, oy: 0 });
        if (by !== 'plan') { ft.x = A[k].ball.x; ft.z = A[k].ball.z; }
      }
      this.fInit = true;
    }
    const prevBy = this.prevBy || by;
    // ---- handovers between the ways the feet are driven
    if (by !== prevBy) {
      for (const [k] of SIDES) {
        const ft = F[k];
        if (by === 'plan') {
          // from the pose: a foot that is down is planted where it is; one that is up finishes its step
          const down = prevBy === 'anim' ? ft.lock || A[k].lo < 0.03 : A[k].lo < 0.03;
          const cx = ft.x, cz = ft.z;
          if (down) Object.assign(ft, { st: 'plant', x: cx, z: cz, yaw: A[k].yaw, lift: 0, pitch: 0 });
          else Object.assign(ft, { st: 'swing', fx: cx, fz: cz, fy: Math.max(0, A[k].ball.y - R.leg[k].hB * gs), fyaw: A[k].yaw, t0: this.clock, dur: 0.14, x: cx, z: cz, yaw: A[k].yaw, lift: Math.max(0, A[k].ball.y - R.leg[k].hB * gs), tx: cx, tz: cz, tyaw: yaw + FW.STANCE[k].toe, h: 0.06 * gs, pitch: 0 });
        } else if (by === 'anim') {
          // into the pose: a planted foot stays locked until the pose lifts it; a swinging one eases in
          if (ft.st === 'plant' && A[k].lo < 0.05) { ft.lock = true; ft.ox = ft.oz = 0; }
          else { ft.lock = false; ft.ox = ft.x - A[k].ball.x; ft.oz = ft.z - A[k].ball.z; }
        }
      }
    }
    this.prevBy = by;
    const T = {}; // per foot: ball joint target (world), foot and toe orientation, knee pole
    if (by === 'plan') this.plan(F, A, anchor, x, y, yaw, vx, vy, spd, dt, gs);
    for (const [k, s] of SIDES) {
      const ft = F[k], L = R.leg[k];
      if (by === 'plan') {
        // planted: flat (heel up a little: on the balls of the feet), pivoting on the ball joint
        const flat = qFlat(_q1, ft.yaw, L.qF0), flatT = qFlat(_q2, ft.yaw, L.qT0);
        const qf = new QT().copy(flat), qt = new QT().copy(flatT);
        if (ft.pitch) { _q3.setFromAxisAngle(_v1.set(Math.cos(ft.yaw), 0, -Math.sin(ft.yaw)), ft.pitch); qf.premultiply(_q3); if (ft.st === 'swing') { _q3.setFromAxisAngle(_v1, ft.pitch * 0.4); qt.premultiply(_q3); } }
        const qfm = A[k].qf.clone().slerp(qf, this.pq), qtm = A[k].qt.clone().slerp(qt, this.pq);
        T[k] = { ball: new V3(ft.x, L.hB * gs + ft.lift + hop, ft.z), qf: qfm, qt: qtm, pole: _v2.set(Math.sin(ft.yaw) * 0.9 + fx * 0.4, 0, Math.cos(ft.yaw) * 0.9 + fz * 0.4).normalize().clone() };
      } else {
        const an = A[k];
        if (by === 'anim') {
          // locked while down: the ball joint stays where it landed
          if (!ft.lock && an.lo < 0.018 && !ft.noLock) { ft.lock = true; ft.lx = an.ball.x + ft.ox; ft.lz = an.ball.z + ft.oz; ft.ox = ft.oz = 0; }
          if (ft.lock && (an.lo > 0.035 || Math.hypot(an.ball.x - ft.lx, an.ball.z - ft.lz) > (this.mode === 'crouch' ? 0.7 : 0.24) * gs || ft.noLock)) { ft.lock = false; ft.ox = ft.lx - an.ball.x; ft.oz = ft.lz - an.ball.z; }
        } else { ft.lock = false; }
        const dk = dt > 0 ? Math.exp(-Math.min(dt, 0.1) / 0.07) : 1;
        if (!ft.lock) { ft.ox *= dk; ft.oz *= dk; }
        const bx = ft.lock ? ft.lx : an.ball.x + ft.ox, bz = ft.lock ? ft.lz : an.ball.z + ft.oz;
        ft.x = bx; ft.z = bz; ft.yaw = an.yaw; ft.st = ft.lock ? 'plant' : 'swing';
        // (the planted feet were flat: leaving the plan they ease into the pose's orientation at the
        // pq rate rather than snapping to it in one frame)
        const qfa = this.pq > 0.01 ? an.qf.clone().slerp(qFlat(_q1, ft.yaw, L.qF0), this.pq) : an.qf;
        const qta = this.pq > 0.01 ? an.qt.clone().slerp(qFlat(_q2, ft.yaw, L.qT0), this.pq) : an.qt;
        T[k] = { ball: new V3(bx, an.ball.y, bz), qf: qfa, qt: qta, pole: null };
      }
    }
    // ---- the hips come down when the planted feet are spread wider than the legs reach
    if (this.ikW > 0.01) {
      let dropT = by === 'plan' ? 0.035 * smooth(2, 7, spd) * gs : 0;
      for (const [k, s] of SIDES) {
        const ft = F[k]; if (ft.st !== 'plant' && !(by === 'anim' && ft.lock)) continue;
        const L = R.leg[k], hip = b['thigh_' + s].getWorldPosition(_v1);
        const len = (L.l1 + L.l2) * gs * 0.965;
        const ank = ankleFor(_v3, T[k].ball, T[k].qf, L, gs);
        const hz = Math.hypot(ank.x - hip.x, ank.z - hip.z);
        const vReach = Math.sqrt(Math.max(0, len * len - hz * hz));
        dropT = Math.max(dropT, (hip.y - ank.y) - vReach);
      }
      dropT = clamp(dropT, 0, 0.32 * gs) * this.ikW;
      const kd = dt > 0 ? 1 - Math.exp(-Math.min(dt, 0.1) * (dropT > this.drop ? 30 : 7)) : 1;
      this.drop = this.snap ? dropT : this.drop + (dropT - this.drop) * kd;
      if (this.drop > 1e-4) {
        const pv = b.pelvis, upL = _v4.copy(UP).applyQuaternion(pv.parent.getWorldQuaternion(_q4).invert());
        const ps = pv.parent.getWorldScale(_v5).y;
        pv.position.addScaledVector(upL, -this.drop / ps);
        pv.updateMatrixWorld(true);
      }
    } else this.drop = 0;
    // ---- leg IK
    if (this.ikW > 0.001) for (const [k, s] of SIDES) {
      const L = R.leg[k], tg = T[k];
      const th = b['thigh_' + s], sh = b['calf_' + s], ft = b['foot_' + s], toe = b['ball_' + s];
      const q0 = [th.quaternion.clone(), sh.quaternion.clone(), ft.quaternion.clone(), toe.quaternion.clone()];
      for (let it = 0; it < 4; it++) {
        const ank = ankleFor(_v3, tg.ball, tg.qf, L, gs);
        solveLeg(th, sh, ft, ank, tg.pole, L);
        setWorldQuat(ft, tg.qf); setWorldQuat(toe, tg.qt);
        // no sole point below the floor
        let lo = Infinity; for (const c of R.cont[k]) lo = Math.min(lo, _v1.copy(c.p).applyMatrix4(c.bone.matrixWorld).y);
        if (lo >= -0.001) break;
        tg.ball.y -= lo;
      }
      if (this.ikW < 0.999) {
        [th, sh, ft, toe].forEach((bn, i) => { const tq = bn.quaternion.clone(); bn.quaternion.copy(q0[i]).slerp(tq, this.ikW); });
        th.updateMatrixWorld(true);
      }
      // whatever went in, nothing broken comes out
      if (![th, sh, ft, toe].every(bn => Number.isFinite(bn.quaternion.x + bn.quaternion.y + bn.quaternion.z + bn.quaternion.w))) {
        [th, sh, ft, toe].forEach((bn, i) => bn.quaternion.copy(q0[i])); th.updateMatrixWorld(true);
        this.fInit = false; this.stats.broken = (this.stats.broken || 0) + 1;
      }
    }
  }

  // The stepping planner: which foot lifts, where it lands, how it travels.
  plan(F, A, anchor, x, y, yaw, vx, vy, spd, dt, gs) {
    const now = this.clock;
    const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -Math.cos(yaw), rz = Math.sin(yaw);
    const moving = spd > 0.3;
    // a step: quicker and relatively lower the faster the player goes
    // running (travelling along the body): long swings, the heel kicked up behind, flight phases;
    // stepping and chasséing (across the body, or slow): short, quick, low steps
    const cb = spd > 0.1 ? (vx * fx + vy * fz) / spd : 0;
    const runW = smooth(3, 6, spd) * smooth(0.55, 0.85, cb);
    this.runW = runW;
    const Tsw = lerp(clamp(0.25 - 0.014 * spd, 0.13, 0.25), clamp(0.2 + 0.014 * spd, 0.24, 0.34), runW);
    const lift = gs * (moving ? lerp(0.06 + 0.012 * Math.min(spd, 8), 0.08 + 0.028 * Math.min(spd, 10), runW) : 0.05);
    const reach = gs * lerp(0.56, 0.6, runW); // a planted foot this far from under its hip must be picked up
    const target = (k, tl) => {
      const px = x + vx * tl, py = y + vy * tl;
      const an = anchor(k, px, py, yaw);
      // land ahead of the hip by half a stance: as far ahead as it will end up behind
      const sp = Math.max(spd, 1e-6), lead = Math.min(spd * 0.065, 0.4 * gs);
      let tx = an[0] + vx / sp * lead, tz = an[1] + vy / sp * lead;
      // a chassé never crosses: the left foot stays left of the right one (in the body's frame)
      const o = F[k === 'L' ? 'R' : 'L'];
      const lat = (tx - x) * rx + (tz - y) * rz, olat = (o.x - x) * rx + (o.z - y) * rz;
      if (this.mode !== 'cross' && this.mode !== 'step') {
        if (k === 'L' && lat > olat - FW.MIN_GAP * gs) { const dl = olat - FW.MIN_GAP * gs - lat; tx += rx * dl; tz += rz * dl; }
        if (k === 'R' && lat < olat + FW.MIN_GAP * gs) { const dl = olat + FW.MIN_GAP * gs - lat; tx += rx * dl; tz += rz * dl; }
      }
      return [tx, tz];
    };
    // the error of each planted foot: how far it is from where it would stand under the body now
    const err = {};
    for (const k of ['L', 'R']) { const ft = F[k], an = anchor(k, x, y, yaw); err[k] = Math.hypot(ft.x - an[0], ft.z - an[1]); }
    const start = k => {
      const ft = F[k], tg = target(k, Tsw);
      let tx = tg[0], tz = tg[1];
      // a single step is never longer than a stride
      const sx = tx - ft.x, sz = tz - ft.z, sl = Math.hypot(sx, sz), maxS = gs * (0.55 + 0.11 * spd);
      if (sl > maxS) { tx = ft.x + sx / sl * maxS; tz = ft.z + sz / sl * maxS; }
      Object.assign(ft, { st: 'swing', fx: ft.x, fz: ft.z, fy: ft.lift, fyaw: ft.yaw, p0: ft.pitch || 0, t0: now, dur: Tsw * (moving ? 1 : 1.2), tx, tz, tyaw: yaw + FW.STANCE[k].toe, h: lift });
      this.lastStep = k; this.stats.steps++;
    };
    // forced: a planted foot the body has left too far behind is picked up, whatever the other
    // foot is doing (at pace that makes a flight phase, as in any run)
    for (const k of ['L', 'R']) if (F[k].st === 'plant' && err[k] > reach) { start(k); this.stats.forced++; }
    let sw = F.L.st === 'swing' ? 'L' : F.R.st === 'swing' ? 'R' : null;
    if (sw && F.L.st === 'swing' && F.R.st === 'swing') sw = 'both';
    const since = now - (this.landAt || 0);
    const free = !sw || (sw !== 'both' && spd > 4.5 && (now - F[sw].t0) / F[sw].dur > 0.55);
    if (free) {
      const cands = ['L', 'R'].filter(k => F[k].st === 'plant');
      let c = cands[0];
      if (cands.length === 2) {
        if (Math.abs(err.L - err.R) < 0.03 * gs) {
          // from a standstill lead with the foot on the side of travel (the racket foot going
          // forward); in a run of steps, alternate
          const lr = vx * rx + vy * rz, lf = vx * fx + vy * fz;
          c = since > 0.35 ? (Math.abs(lr) > Math.abs(lf) * 0.8 ? (lr > 0 ? 'R' : 'L') : 'R') : (this.lastStep === 'L' ? 'R' : 'L');
        } else c = err.L > err.R ? 'L' : 'R';
      }
      const thr = gs * (moving ? 0.045 : 0.07);
      if (c && err[c] > thr && since > (moving ? 0.015 : 0.1)) start(c);
    }
    // swings: along a low arc, retargeted while there is time to change the step
    for (const k of ['L', 'R']) {
      const ft = F[k];
      if (ft.st === 'plant') {
        // pivot on the ball of the foot toward the body's heading; the heel lifts as the body
        // leaves the foot behind (the push)
        const want = yaw + FW.STANCE[k].toe, dy = wrap(want - ft.yaw);
        if (Math.abs(dy) > 0.45) ft.yaw += clamp(dy - Math.sign(dy) * 0.45, -7 * dt, 7 * dt);
        const an = anchor(k, x, y, yaw);
        const behind = -((ft.x - an[0]) * vx + (ft.z - an[1]) * vy) / Math.max(spd, 0.3);
        const pT = 0.08 + clamp(behind / (0.5 * gs), 0, 1) * 0.5 * smooth(0.3, 2, spd);
        ft.pitch += (pT - ft.pitch) * (dt > 0 ? 1 - Math.exp(-Math.min(dt, 0.1) * 12) : 0);
        ft.lift = 0;
        continue;
      }
      const u = clamp((now - ft.t0) / ft.dur, 0, 1);
      if (u < 0.7) {
        const tg = target(k, ft.dur * (1 - u));
        let tx = tg[0], tz = tg[1];
        const sx = tx - ft.fx, sz = tz - ft.fz, sl = Math.hypot(sx, sz), maxS = gs * (0.55 + 0.11 * spd);
        if (sl > maxS) { tx = ft.fx + sx / sl * maxS; tz = ft.fz + sz / sl * maxS; }
        const kr = dt > 0 ? 1 - Math.exp(-Math.min(dt, 0.1) * 25) : 0;
        ft.tx += (tx - ft.tx) * kr; ft.tz += (tz - ft.tz) * kr;
        ft.tyaw = yaw + FW.STANCE[k].toe;
      }
      // the foot comes up before it goes anywhere, and is down before it stops
      const e = smooth(0.15, 0.85, u);
      ft.x = lerp(ft.fx, ft.tx, e); ft.z = lerp(ft.fz, ft.tz, e);
      ft.yaw = ft.fyaw + wrap(ft.tyaw - ft.fyaw) * e;
      ft.lift = lerp(ft.fy, 0, e) + ft.h * Math.sin(Math.PI * u);
      // toe-off (heel up, pushing off the ball of the foot), then the toes come up to clear the floor
      // and the foot lands flat on the ball of the foot
      ft.pitch = ft.p0 * (1 - smooth(0, 0.3, u)) + (0.15 + 0.35 * (this.runW || 0)) * smooth(0, 0.2, u) * (1 - smooth(0.25, 0.8, u));
      if (u >= 1) { ft.st = 'plant'; ft.x = ft.tx; ft.z = ft.tz; ft.lift = 0; ft.yaw = ft.tyaw; this.landAt = now; }
    }
  }

  // entering the mocap run: start its cycle with the planted foot in its stance
  alignPhase() {
    const F = this.feet, c = this.rest.clip.Sprint_Loop, down = F.L.st === 'plant' && F.R.st !== 'plant' ? 'L' : F.R.st === 'plant' && F.L.st !== 'plant' ? 'R' : (this.lastStep === 'L' ? 'L' : 'R');
    this.h.phase = ((down === 'L' ? c.mid : c.mid + 0.5) - 0.05 + 1) % 1;
  }
}

function newFoot() { return { st: 'plant', x: 0, z: 0, yaw: 0, lift: 0, pitch: 0, lock: false, ox: 0, oz: 0, lx: 0, lz: 0 }; }

// body parts and how thick they are (m): their joints may never be closer to the floor than this
const CLEAR = [['pelvis', 0.11], ['spine_01', 0.11], ['spine_02', 0.12], ['spine_03', 0.12], ['neck_01', 0.07], ['Head', 0.1],
  ['upperarm_l', 0.06], ['upperarm_r', 0.06], ['lowerarm_l', 0.045], ['lowerarm_r', 0.045], ['hand_l', 0.035], ['hand_r', 0.035],
  ['thigh_l', 0.09], ['thigh_r', 0.09], ['calf_l', 0.055], ['calf_r', 0.055], ['foot_l', 0.05], ['foot_r', 0.05], ['ball_l', 0.03], ['ball_r', 0.03]];

// world orientation of a flat foot pointing along yaw (q0: the flat foot facing +z, group frame)
function qFlat(out, yaw, q0) { return out.setFromAxisAngle(UP, yaw).multiply(q0); }
// the ankle position that puts the ball joint at `ball` with the foot at orientation qf
function ankleFor(out, ball, qf, L, gs) { return out.copy(L.ballOff).multiplyScalar(gs).applyQuaternion(qf).negate().add(ball); }
// the yaw of a foot (its heel to ball direction)
function footYaw(ft, L) { const q = ft.getWorldQuaternion(_q4); const d = _v6.copy(L.ballOff).applyQuaternion(q); return Math.atan2(d.x, d.z); }
function setWorldQuat(bone, q) { bone.parent.getWorldQuaternion(_q4); bone.quaternion.copy(_q4.invert().multiply(q)); bone.updateMatrixWorld(true); }
function worldRotate(bone, R) {
  bone.getWorldQuaternion(_q3); bone.parent.getWorldQuaternion(_q4);
  bone.quaternion.copy(_q4.invert().multiply(R).multiply(_q3)); bone.updateMatrixWorld(true);
}
// Two-bone leg IK: bend the knee about its own hinge to the length the target needs, swing the
// thigh onto the target, then turn the leg about the hip-ankle line so the knee points at the pole.
function solveLeg(th, sh, ft, T, pole, L) {
  const H = th.getWorldPosition(_v1), K = sh.getWorldPosition(_v2), Aw = ft.getWorldPosition(new V3());
  const l1 = H.distanceTo(K), l2 = K.distanceTo(Aw);
  const d = clamp(T.distanceTo(H), Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.9995);
  const a = _v4.copy(H).sub(K).normalize(), c = _v5.copy(Aw).sub(K).normalize();
  const cur = Math.acos(clamp(a.dot(c), -1, 1));
  const want = Math.acos(clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
  // the knee's hinge axis in the world (the thigh carries it)
  const hinge = _v6.copy(L.hinge).applyQuaternion(th.getWorldQuaternion(_q1)).normalize();
  worldRotate(sh, _q2.setFromAxisAngle(hinge, cur - want));
  // swing the thigh so the ankle lands on the target line
  const A2 = ft.getWorldPosition(new V3()), H2 = th.getWorldPosition(new V3());
  const from = A2.sub(H2).normalize(), to = new V3().copy(T).sub(H2).normalize();
  worldRotate(th, _q2.setFromUnitVectors(from, to));
  if (pole) {
    const axis = to, Kn = sh.getWorldPosition(new V3()).sub(H2);
    const kp = Kn.sub(axis.clone().multiplyScalar(Kn.dot(axis)));
    const pp = pole.clone().sub(axis.clone().multiplyScalar(pole.dot(axis)));
    if (kp.lengthSq() > 1e-8 && pp.lengthSq() > 1e-8) {
      kp.normalize(); pp.normalize();
      let ang = Math.atan2(new V3().crossVectors(kp, pp).dot(axis), kp.dot(pp));
      ang = clamp(ang, -0.9, 0.9);
      worldRotate(th, _q2.setFromAxisAngle(axis, ang));
    }
  }
}

// The rest geometry, measured once on the bind pose: for each foot the flat orientation facing +z,
// the ball joint's offset from the ankle and its height over the sole; the knee hinge axis; and each
// mocap loop's stride (the ground covered per cycle when the planted foot is still) and the phase
// of the left foot's mid-stance.
function measureRest(h) {
  const b = h.bone, g = h.group;
  // back to the reference pose (human.js leaves the rig in a sampled clip after init)
  for (const rs of h.ref) for (const r of rs) r.bone.quaternion.copy(r.L);
  b.pelvis.position.set(0, 0.043, 0.9491);
  g.updateWorldMatrix(true, true);
  const gq = g.getWorldQuaternion(new QT()), gqi = gq.clone().invert(), gs = g.getWorldScale(new V3()).y, gp = g.getWorldPosition(new V3());
  const loc = v => v.sub(gp).applyQuaternion(gqi).multiplyScalar(1 / gs);
  const out = { leg: {}, cont: {}, clip: {} };
  for (const [k, s] of SIDES) {
    const th = b['thigh_' + s], sh = b['calf_' + s], ft = b['foot_' + s], toe = b['ball_' + s];
    const cs = h.contacts.filter(c => c.bone === ft || c.bone === toe);
    out.cont[k] = cs;
    const P = cs.map(c => loc(c.p.clone().applyMatrix4(c.bone.matrixWorld)));
    const heel = P[0].clone().add(P[1]).add(P[2]).multiplyScalar(1 / 3), pad = P[3].clone().add(P[4]).multiplyScalar(0.5);
    const dv = pad.clone().sub(heel), yaw0 = Math.atan2(dv.x, dv.z), pitchErr = Math.atan2(dv.y, Math.hypot(dv.x, dv.z));
    const qf = gqi.clone().multiply(ft.getWorldQuaternion(new QT())), qt = gqi.clone().multiply(toe.getWorldQuaternion(new QT()));
    const fix = new QT().setFromAxisAngle(new V3(Math.cos(yaw0), 0, -Math.sin(yaw0)), pitchErr);
    const unyaw = new QT().setFromAxisAngle(UP, -yaw0);
    const qF0 = unyaw.clone().multiply(fix).multiply(qf), qT0 = unyaw.clone().multiply(fix).multiply(qt);
    // measure the flat foot: put it there, read the sole, put it back
    const sf = ft.quaternion.clone(), st = toe.quaternion.clone();
    setWorldQuat(ft, gq.clone().multiply(qF0)); setWorldQuat(toe, gq.clone().multiply(qT0));
    const ank = loc(ft.getWorldPosition(new V3())), ball = loc(toe.getWorldPosition(new V3()));
    let lo = Infinity; for (const c of cs) lo = Math.min(lo, loc(c.p.clone().applyMatrix4(c.bone.matrixWorld)).y);
    const hB = ball.y - lo;
    // ballOff: ankle -> ball joint, in the flat foot's own frame (so any orientation can use it)
    ft.quaternion.copy(sf); toe.quaternion.copy(st); ft.updateMatrixWorld(true);
    // knee hinge: the model's x axis as the thigh carries it at the reference pose
    const qth = gqi.clone().multiply(th.getWorldQuaternion(new QT()));
    const hinge = new V3(1, 0, 0).applyQuaternion(qth.clone().invert());
    const l1 = th.getWorldPosition(new V3()).distanceTo(sh.getWorldPosition(new V3())) / gs, l2 = sh.getWorldPosition(new V3()).distanceTo(ft.getWorldPosition(new V3())) / gs;
    // qF0 maps the flat foot in the group frame; the world frame adds the root's yaw (and the group's
    // tilt, which is identity whenever the feet are planned)
    // ballOff: ankle -> ball joint in the foot bone's own frame (world offset = its world rotation * ballOff * scale)
    out.leg[k] = { qF0, qT0, hB, ballOff: ball.clone().sub(ank).applyQuaternion(qF0.clone().invert()), hinge, l1, l2, yaw0 };
  }
  // strides
  const acts = Object.values(h.act || {});
  for (const n of ['Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop']) {
    const act = h.act && h.act[n];
    if (!act) { out.clip[n] = { L: 6, mid: 0.1 }; continue; }
    const clip = act.getClip(), N = 60, ys = [], zs = [];
    for (let i = 0; i < N; i++) {
      for (const a of acts) a.setEffectiveWeight(a === act ? 1 : 0);
      act.time = i / N * clip.duration; h.mixer.update(0); h.root.updateMatrixWorld(true);
      const p = loc(b.ball_l.getWorldPosition(new V3())); ys.push(p.y); zs.push(p.z);
    }
    for (const a of acts) a.setEffectiveWeight(0);
    const lo = Math.min(...ys), sl = [], ph = [];
    for (let i = 0; i < N; i++) { const j = (i + 1) % N; if (ys[i] < lo + 0.015 && ys[j] < lo + 0.015) { sl.push((zs[i] - zs[j]) * N); ph.push(i / N); } }
    sl.sort((p, q) => p - q);
    let sx = 0, sy = 0; for (const u of ph) { sx += Math.cos(u * 2 * Math.PI); sy += Math.sin(u * 2 * Math.PI); }
    out.clip[n] = { L: sl.length ? sl[sl.length >> 1] : 6, mid: ((Math.atan2(sy, sx) / (2 * Math.PI)) + 1) % 1 };
  }
  return out;
}

// ---------------------------------------------------------------- dive, slide and get-up poses
// (model-space Euler, human.js conventions; the rig itself is tilted by Footwork.diveRig)
const DP = {
  // off the racket leg: the right leg drives, the left knee comes through, arms thrown forward
  launch: { hips: [0.05, 0, 0], spine: [0.05, 0, 0], chest: [0, 0, 0], neck: [-0.35, 0, 0], head: [-0.2, 0, 0],
    thighR: [0.25, 0, -0.05], shinR: [0.15, 0, 0], footR: [0.55, 0, 0], toeR: [0, 0, 0],
    thighL: [-0.75, 0, 0.1], shinL: [1.1, 0, 0], footL: [0.3, 0, 0], toeL: [0, 0, 0],
    clavR: [-0.2, 0, -0.2], armR: [-2.2, 0, -0.2], foreR: [-0.3, 0, 0], handR: [-0.1, 0, 0],
    clavL: [-0.1, 0, 0.1], armL: [-1.3, 0, 0.35], foreL: [-0.5, 0, 0], handL: [0, 0, 0] },
  // full stretch: near horizontal, racket arm reaching along the dive, legs trailing
  flight: { hips: [-0.08, 0, 0], spine: [-0.1, 0, 0], chest: [-0.08, 0, 0], neck: [-0.6, 0, 0], head: [-0.3, 0, 0],
    thighR: [0.28, 0, -0.08], shinR: [0.2, 0, 0], footR: [0.6, 0, 0], toeR: [0, 0, 0],
    thighL: [0.12, 0, 0.12], shinL: [0.55, 0, 0], footL: [0.55, 0, 0], toeL: [0, 0, 0],
    clavR: [-0.3, 0, -0.25], armR: [-2.75, 0, -0.15], foreR: [-0.1, 0, 0], handR: [-0.15, 0, 0],
    clavL: [-0.1, 0, 0.1], armL: [-1.45, 0, 0.45], foreL: [-0.45, 0, 0], handL: [0.1, 0, 0] },
  // down and sliding: on the chest and the left forearm, racket arm still out
  slide: { hips: [-0.05, 0, 0], spine: [-0.08, 0, 0], chest: [-0.12, 0, 0], neck: [-0.62, 0, 0], head: [-0.3, 0, 0],
    thighR: [0.12, 0, -0.12], shinR: [0.35, 0, 0], footR: [0.5, 0, 0], toeR: [0, 0, 0],
    thighL: [0.05, 0, 0.14], shinL: [0.7, 0, 0], footL: [0.5, 0, 0], toeL: [0, 0, 0],
    clavR: [-0.3, 0, -0.25], armR: [-2.7, 0, -0.2], foreR: [-0.15, 0, 0], handR: [-0.1, 0, 0],
    clavL: [-0.05, 0, 0.1], armL: [-1.2, 0, 0.7], foreL: [-1.5, 0, 0], handL: [0.2, 0, 0] },
  // pushing up: hands on the floor, the right foot brought through, the left knee down
  kneel: { hips: [0.15, 0, 0], spine: [0.2, 0, 0], chest: [0.1, 0, 0], neck: [-0.35, 0, 0], head: [-0.15, 0, 0],
    thighR: [-1.45, 0, -0.1], shinR: [1.7, 0, 0], footR: [-0.2, 0, 0], toeR: [0, 0, 0],
    thighL: [-0.45, 0, 0.12], shinL: [1.95, 0, 0], footL: [0.6, 0, 0], toeL: [-0.4, 0, 0],
    clavR: [-0.1, 0, -0.1], armR: [-1.05, 0, -0.3], foreR: [-0.35, 0, 0], handR: [0.2, 0, 0],
    clavL: [-0.05, 0, 0.1], armL: [-1.1, 0, 0.35], foreL: [-0.25, 0, 0], handL: [0.3, 0, 0] },
};
function mixPose(Q, A, B, w) {
  for (const k of Object.keys(A)) { const a = A[k], b = B[k] || a; Q.set(k, lerp(a[0], b[0], w), lerp(a[1], b[1], w), lerp(a[2], b[2], w)); }
}
// the pose for this moment of the dive: u, the flight (0..1); s, the floor time (0..1)
export function diveBody(Q, mode, u, s) {
  if (mode === 'dive') {
    if (u < 0.45) mixPose(Q, DP.launch, DP.flight, smooth(0.05, 0.45, u));
    else mixPose(Q, DP.flight, DP.slide, smooth(0.7, 1, u));
  } else mixPose(Q, DP.slide, DP.kneel, smooth(0.36, 0.66, s));
}
// how much of the body the dive owns: all of it until the get-up hands back to the stance
export function diveWeight(mode, s) { return mode === 'dive' || mode === 'slide' ? 1 : mode === 'getup' ? 1 - smooth(0.7, 0.97, s) : 0; }
export const DIVE_TIME = DIVE_T;
