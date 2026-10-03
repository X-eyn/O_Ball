const thresholds = [30, 60, 85];
export const HEAT_LABELS = ['HEAT', 'WARM', 'HOT', 'ON FIRE'];
export function heatTier(value, previous = 0) {
  const heat = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  let tier = Math.max(0, Math.min(3, previous | 0));
  while (tier < 3 && heat >= thresholds[tier]) tier++;
  while (tier > 0 && heat < thresholds[tier - 1] - 4) tier--;
  return tier;
}
export function smoothHeat(current, target, dt) {
  const want = Number.isFinite(target) ? Math.max(0, Math.min(100, target)) : 0;
  const from = Number.isFinite(current) ? current : 0;
  return from + (want - from) * (1 - Math.exp(-6 * Math.max(0, dt)));
}
