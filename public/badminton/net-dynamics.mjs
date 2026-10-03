// Damped cloth in a Three.PlaneGeometry's local coordinates. The renderer rotates this plane
// +PI/2 around Y: local +z is sim/world +x and local +x is sim/world -y. Row zero is the tape.
// Shuttle collisions remain authoritative at the unchanged server net plane.
const FIXED_DT = 1 / 120, MAX_STEPS = 8;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = (v, fallback = 0) => Number.isFinite(v) ? v : fallback;

// Multipliers on the cloth's character (all 1 = the shipped net). The heat lab's net tester edits them.
export const NET_TUNE = { stiffness: 1, damping: 1, tape: 1, impact: 1, cup: 1 };

export class NetDynamics {
  constructor(width, height, cols = 40, rows = 10) {
    this.tune = { ...NET_TUNE };
    if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) throw new RangeError('Net dimensions must be positive and finite');
    this.width = width; this.height = height;
    this.cols = clamp(Math.floor(finite(cols, 40)), 2, 80);
    this.rows = clamp(Math.floor(finite(rows, 10)), 2, 30);
    // The existing court's posts are 1.55 m above the floor. Mesh center is top - height/2.
    this.topHeight = 1.55;
    const count = (this.cols + 1) * (this.rows + 1) * 3;
    this.base = new Float32Array(count);
    this.positions = new Float32Array(count);
    this._velocity = new Float32Array(count);
    this._force = new Float32Array(count);
    this._weights = new Float32Array(count / 3);
    this._accumulator = 0;
    for (let row = 0; row <= this.rows; row++) for (let col = 0; col <= this.cols; col++) {
      const u = col / this.cols, i = (row * (this.cols + 1) + col) * 3;
      this.base[i] = (u - 0.5) * width;
      this.base[i + 1] = height * (0.5 - row / this.rows) - 0.026 * 4 * u * (1 - u);
    }
    this.positions.set(this.base);
  }

  impact(event) {
    if (!event) return;
    const vx = clamp(finite(event.vx), -100, 100);
    const vy = clamp(finite(event.vy), -80, 80), vz = clamp(finite(event.vz), -80, 80);
    const localX = clamp(-finite(event.y), -this.width / 2, this.width / 2);
    const localY = clamp(finite(event.z, this.topHeight - this.height / 2) - this.topHeight + this.height / 2, -this.height / 2, this.height / 2);
    // A shuttle weighs ~5.2 g. Spread its momentum over a finite contact patch rather than
    // injecting a point force into one grid vertex. Tangential momentum is mostly slip.
    const radiusX = Math.max(0.42, this.width / this.cols * 2);
    const radiusY = Math.max(0.16, this.height / this.rows * 2);
    const p = this.positions, b = this.base, velocity = this._velocity, weights = this._weights;
    let total = 0;
    for (let row = 0; row <= this.rows; row++) for (let col = 0; col <= this.cols; col++) {
      const vertex = row * (this.cols + 1) + col, i = vertex * 3;
      const distance = ((b[i] - localX) / radiusX) ** 2 + ((b[i + 1] - localY) / radiusY) ** 2;
      const weight = col === 0 || col === this.cols || distance > 4 ? 0 : Math.exp(-distance * 2);
      weights[vertex] = weight; total += weight;
    }
    if (total < 1e-6) return;
    const nodeMass = 0.0018, momentum = 0.0052 / nodeMass * this.tune.impact;
    for (let vertex = 0; vertex < weights.length; vertex++) {
      if (!weights[vertex]) continue;
      const i = vertex * 3, w = weights[vertex] / total;
      const row = Math.floor(vertex / (this.cols + 1));
      const freedom = row === 0 ? 0.3 : 1;
      velocity[i] = clamp(velocity[i] - vy * momentum * w * 0.12, -8, 8);
      velocity[i + 1] = clamp(velocity[i + 1] + vz * momentum * w * 0.12, -8, 8);
      velocity[i + 2] = clamp(velocity[i + 2] + vx * momentum * w * freedom, -12, 12);
      // Local cupping follows the incoming direction and is restored by the same springs.
      p[i + 2] = b[i + 2] + clamp(p[i + 2] - b[i + 2] + vx * 0.00045 * this.tune.cup * weights[vertex] * freedom, -0.36, 0.36);
    }
  }

  step(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    // Discard excess elapsed time after suspension; never build an integration backlog.
    this._accumulator = Math.min(this._accumulator + dt, FIXED_DT * MAX_STEPS);
    let steps = 0;
    while (this._accumulator + 1e-10 >= FIXED_DT && steps < MAX_STEPS) {
      this._integrate(FIXED_DT); this._accumulator -= FIXED_DT; steps++;
    }
    this._accumulator = Math.max(0, this._accumulator);
  }

  _integrate(dt) {
    const p = this.positions, b = this.base, v = this._velocity, force = this._force;
    const stride = this.cols + 1, t = this.tune;
    // Integrate all forces from the same preceding state so waves are symmetric and independent
    // of traversal order. Springs couple displacements relative to the sagged rest geometry.
    for (let row = 0; row <= this.rows; row++) for (let col = 1; col < this.cols; col++) {
      const vertex = row * stride + col, i = vertex * 3;
      const restoring = (row === 0 ? 190 * t.tape : 38) * t.stiffness, damping = (row === 0 ? 10 : 6.5) * t.damping;
      for (let axis = 0; axis < 3; axis++) {
        const offset = i + axis, displacement = p[offset] - b[offset];
        let horizontal = (p[offset - 3] - b[offset - 3]) + (p[offset + 3] - b[offset + 3]) - 2 * displacement;
        let vertical = 0;
        if (row > 0) vertical += p[offset - stride * 3] - b[offset - stride * 3] - displacement;
        if (row < this.rows) vertical += p[offset + stride * 3] - b[offset + stride * 3] - displacement;
        const horizontalK = (axis === 2 ? (row === 0 ? 580 * t.tape : 350) : 120) * t.stiffness;
        const verticalK = (axis === 2 ? 240 : 80) * t.stiffness;
        force[offset] = horizontal * horizontalK + vertical * verticalK - restoring * displacement - damping * v[offset];
      }
    }
    for (let row = 0; row <= this.rows; row++) for (let col = 1; col < this.cols; col++) {
      const i = (row * stride + col) * 3;
      for (let axis = 0; axis < 3; axis++) {
        const offset = i + axis, limit = axis === 2 ? (row === 0 ? 0.06 : 0.36) : 0.09;
        v[offset] += force[offset] * dt;
        const next = p[offset] - b[offset] + v[offset] * dt;
        p[offset] = b[offset] + clamp(next, -limit, limit);
        if (Math.abs(next) > limit) v[offset] *= 0.2;
        if (Math.abs(p[offset] - b[offset]) < 1e-7 && Math.abs(v[offset]) < 1e-6) { p[offset] = b[offset]; v[offset] = 0; }
      }
    }
  }

  reset() {
    this.positions.set(this.base); this._velocity.fill(0); this._force.fill(0); this._weights.fill(0); this._accumulator = 0;
  }
}
