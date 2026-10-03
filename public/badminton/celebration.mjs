// Point celebrations are sampled from server-relative elapsed time, so replaying or scrubbing
// never accumulates an extra racket turn. A full rotation finishes before the body settles.
export const CELEBRATION_DURATION = 1.25;
const clamp = x => Math.max(0, Math.min(1, x));
const ease = x => { const t = clamp(x); return t * t * t * (10 + t * (-15 + t * 6)); };
export function sampleCelebration(elapsed, variant = 0) {
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= CELEBRATION_DURATION) {
    return { weight: 0, angle: 0, anticipation: 0, accent: 0, variant };
  }
  const weight = ease(elapsed / 0.24) * (1 - ease((elapsed - 0.88) / 0.37));
  const anticipation = ease(elapsed / 0.14) * (1 - ease((elapsed - 0.16) / 0.16));
  const accent = ease((elapsed - 0.25) / 0.18) * (1 - ease((elapsed - 0.65) / 0.24));
  return { weight, anticipation, accent, variant,
    angle: variant === 0 ? Math.PI * 2 * ease((elapsed - 0.2) / 0.62) : 0 };
}

// Shared by the real athlete and transition regression checks. Await braking/landing before
// starting, then cancel for the remainder of this point if gameplay interrupts the gesture.
export function samplePointCelebration(state, elapsed, variant, eligible) {
  const pointOn = Number.isFinite(elapsed) && elapsed >= 0;
  if (!pointOn || (state.wonAge != null && elapsed < state.wonAge)) {
    state.celebrationDelay = null; state.celebrationCancelled = false;
  }
  if (pointOn && state.celebrationDelay != null && !eligible) state.celebrationCancelled = true;
  if (pointOn && eligible && state.celebrationDelay == null && !state.celebrationCancelled) state.celebrationDelay = elapsed;
  state.wonAge = pointOn ? elapsed : null;
  return sampleCelebration(pointOn && eligible && !state.celebrationCancelled ? elapsed - state.celebrationDelay : null, variant);
}

// base * rotation(local Y). The racket's +Y is exactly its longitudinal handle axis;
// its attachment position and every point on that axis remain fixed in the fingers.
export function setGripSpin(out, base, angle) {
  const s = Math.sin(angle * 0.5), c = Math.cos(angle * 0.5);
  return out.set(base.x * c - base.z * s, base.y * c + base.w * s,
    base.z * c + base.x * s, base.w * c - base.y * s);
}
