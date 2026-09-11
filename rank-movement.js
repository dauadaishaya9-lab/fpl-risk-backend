function normaliseRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(row => ({
      rank: Number(row.rank),
      points: Number(row.points)
    }))
    .filter(row =>
      Number.isSafeInteger(row.rank) &&
      row.rank > 0 &&
      Number.isFinite(row.points)
    )
    .sort((a, b) => a.rank - b.rank);
}

function interpolate(points, rows) {
  if (rows.length < 2) return null;

  const ordered = [...rows].sort(
    (a, b) => b.points - a.points || a.rank - b.rank
  );

  if (points >= ordered[0].points) {
    return ordered[0].rank;
  }

  const last = ordered.length - 1;

  if (points <= ordered[last].points) {
    return ordered[last].rank;
  }

  for (let i = 0; i < last; i += 1) {
    const better = ordered[i];
    const worse = ordered[i + 1];

    if (points <= better.points && points >= worse.points) {
      const pointRange = better.points - worse.points;

      if (pointRange === 0) {
        return Math.round((better.rank + worse.rank) / 2);
      }

      const ratio =
        (better.points - points) / pointRange;

      return Math.round(
        better.rank +
        ratio * (worse.rank - better.rank)
      );
    }
  }

  return null;
}

export function deriveTierBoundaries(rows, tiers) {
  const observations = normaliseRows(rows);

  return tiers
    .slice(1)
    .map(tier => {
      const betterTier = tiers.find(
        candidate => candidate.max === tier.min - 1
      );

      if (!betterTier) return null;

      const candidates = observations.filter(
        row => row.rank >= betterTier.min && row.rank <= tier.max
      );

      if (candidates.length < 2) return null;

      const better = candidates
        .filter(row => row.rank <= betterTier.max)
        .sort((a, b) => b.rank - a.rank)[0];

      const worse = candidates
        .filter(row => row.rank >= tier.min)
        .sort((a, b) => a.rank - b.rank)[0];

      if (!better || !worse) return null;

      return {
        fromTier: betterTier.name,
        toTier: tier.name,
        boundaryRank: tier.min,
        boundaryPoints: Number(
          ((better.points + worse.points) / 2).toFixed(4)
        )
      };
    })
    .filter(Boolean);
}

export function estimateRankMovement({
  currentRank,
  currentPoints,
  pointSwing,
  rows,
  tiers
}) {
  if (!Number.isSafeInteger(currentRank) || currentRank < 1) {
    throw new Error("Invalid current rank");
  }

  if (!Number.isFinite(currentPoints)) {
    throw new Error("Invalid current points");
  }

  if (!Number.isFinite(pointSwing)) {
    throw new Error("Invalid point swing");
  }

  const observations = normaliseRows(rows);

  if (observations.length < 2) {
    throw new Error("Insufficient rank/points observations");
  }

  const projectedPoints = Number(
    (currentPoints + pointSwing).toFixed(2)
  );

  const orderedTiers = [...tiers].sort(
    (a, b) => a.min - b.min
  );

  let currentTier = orderedTiers.find(
    tier =>
      currentRank >= tier.min &&
      currentRank <= tier.max
  );

  if (!currentTier) {
    throw new Error("Current rank is outside configured tiers");
  }

  const boundaries = deriveTierBoundaries(
    observations,
    orderedTiers
  );

  if (pointSwing === 0) {
    return {
      currentRank,
      currentPoints,
      projectedPoints,
      pointSwing: 0,
      estimatedRank: currentRank,
      estimatedRankMovement: 0,
      direction: "unchanged",
      rankTier: currentTier.name,
      finalTier: currentTier.name,
      tiersCrossed: [],
      boundaries
    };
  }

  const tiersCrossed = [];
  let finalTier = currentTier;
  let index = orderedTiers.indexOf(currentTier);

  if (projectedPoints > currentPoints) {
    while (index > 0) {
      const betterTier = orderedTiers[index - 1];
      const boundary = boundaries.find(
        item =>
          item.fromTier === betterTier.name &&
          item.toTier === finalTier.name
      );

      if (!boundary || projectedPoints < boundary.boundaryPoints) {
        break;
      }

      tiersCrossed.push({
        fromTier: finalTier.name,
        toTier: betterTier.name,
        boundaryRank: boundary.boundaryRank,
        boundaryLowerLimit: boundary.boundaryPoints,
        boundaryDistance: Number(
          Math.max(0, boundary.boundaryPoints - currentPoints).toFixed(4)
        )
      });

      finalTier = betterTier;
      index -= 1;
    }
  }

  if (projectedPoints < currentPoints) {
    while (index < orderedTiers.length - 1) {
      const betterTier = orderedTiers[index];
      const worseTier = orderedTiers[index + 1];

      const boundary = boundaries.find(
        item =>
          item.fromTier === betterTier.name &&
          item.toTier === worseTier.name
      );

      if (!boundary || projectedPoints > boundary.boundaryPoints) {
        break;
      }

      tiersCrossed.push({
        fromTier: finalTier.name,
        toTier: worseTier.name,
        boundaryRank: boundary.boundaryRank,
        boundaryLowerLimit: boundary.boundaryPoints,
        boundaryDistance: Number(
          Math.max(0, currentPoints - boundary.boundaryPoints).toFixed(4)
        )
      });

      finalTier = worseTier;
      index += 1;
    }
  }

  const terminalRows = observations.filter(
    row =>
      row.rank >= finalTier.min &&
      row.rank <= finalTier.max
  );

  const rankingRows =
    terminalRows.length >= 2
      ? terminalRows
      : observations;

  const estimatedRank =
    interpolate(projectedPoints, rankingRows) ?? currentRank;

  return {
    currentRank,
    currentPoints,
    projectedPoints,
    pointSwing: Number(pointSwing.toFixed(2)),
    estimatedRank,
    estimatedRankMovement: currentRank - estimatedRank,
    direction:
      pointSwing > 0
        ? "up"
        : pointSwing < 0
          ? "down"
          : "unchanged",
    rankTier: currentTier.name,
    finalTier: finalTier.name,
    tiersCrossed,
    boundaries
  };
}
