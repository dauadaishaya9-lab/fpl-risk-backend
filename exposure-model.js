// Distribution-aware exposure model adapted from FPL Risk Calculator 2.
// The mean exposure is retained for the existing swing calculation, but the
// full 0/1/2/3 exposure distribution is preserved so distinct distributions
// are not treated as identical merely because their means match.

export const DECISION_EXPOSURE = Object.freeze({
  dont_own: 0,
  own: 1,
  captain: 2,
  triple_captain: 3,
});

export function decisionExposure({ owns, captain, tripleCaptain }) {
  if (typeof owns !== "boolean" || typeof captain !== "boolean" || typeof tripleCaptain !== "boolean") {
    throw new Error("Decision fields must be boolean");
  }
  if (!owns && (captain || tripleCaptain)) throw new Error("Captain and triple captain require ownership");
  if (tripleCaptain && !captain) throw new Error("Triple captain requires captain selection");
  if (!owns) return 0;
  if (tripleCaptain) return 3;
  if (captain) return 2;
  return 1;
}

export function exposureDistribution(rows, playerId) {
  const counts = [0, 0, 0, 0];
  for (const row of rows) {
    const picks = Array.isArray(row.picks) ? row.picks : [];
    const pick = picks.find(p => Number(p.element) === Number(playerId));
    const multiplier = pick ? Number(pick.multiplier) : 0;
    const exposure = Number.isFinite(multiplier) ? Math.max(0, Math.min(3, multiplier)) : 0;
    counts[exposure] += 1;
  }
  const sampleSize = rows.length;
  if (!sampleSize) return { counts, percentages: [0, 0, 0, 0], mean: 0, variance: 0, standardDeviation: 0 };
  const percentages = counts.map(c => Number((c / sampleSize * 100).toFixed(2)));
  const mean = counts.reduce((sum, count, exposure) => sum + count * exposure, 0) / sampleSize;
  const variance = counts.reduce((sum, count, exposure) => sum + count * (exposure - mean) ** 2, 0) / sampleSize;
  return { counts, percentages, mean: Number(mean.toFixed(4)), variance: Number(variance.toFixed(6)), standardDeviation: Number(Math.sqrt(variance).toFixed(4)) };
}

export function exposurePercentile(distribution, userExposure) {
  const counts = distribution?.counts || [0, 0, 0, 0];
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const exposure = Math.max(0, Math.min(3, Math.round(Number(userExposure))));
  const atOrBelow = counts.slice(0, exposure + 1).reduce((a, b) => a + b, 0);
  return Number((atOrBelow / total * 100).toFixed(1));
}

export function relativeExpectedSwing(userExposure, tierMeanExposure, expectedPoints) {
  return Number(((userExposure - tierMeanExposure) * expectedPoints).toFixed(2));
}
