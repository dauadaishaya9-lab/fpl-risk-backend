const ENTRY_URL = "https://fantasy.premierleague.com/api/entry/";
import { pool } from "./risk-engine.js";

let subscriptionSchemaReady = false;

async function ensureSubscriptionSchema() {
  if (!pool || subscriptionSchemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_subscriptions (
      user_id TEXT PRIMARY KEY,
      plan TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_user_subscriptions_expires_at
      ON user_subscriptions(expires_at);
  `);
  subscriptionSchemaReady = true;
}

export async function getSubscription(userId) {
  if (!pool || typeof userId !== "string" || !userId) return null;
  await ensureSubscriptionSchema();
  const result = await pool.query(
    `SELECT user_id, plan, started_at, expires_at
       FROM user_subscriptions
      WHERE user_id=$1
        AND expires_at>NOW()
      LIMIT 1`,
    [userId]
  );
  return result.rowCount ? result.rows[0] : null;
}

export async function isPaidUser(userId) {
  return !!(await getSubscription(userId));
}

export async function isRankImpactEntitled(userId, isOwner) {
  if (typeof userId !== "string") return false;
  if (isOwner(userId)) return true;
  return isPaidUser(userId);
}

export async function grantMonthlySubscription(userId) {
  if (!pool || typeof userId !== "string" || !userId) throw new Error("Invalid user ID");
  await ensureSubscriptionSchema();
  await pool.query(
    `INSERT INTO user_subscriptions(user_id,plan,started_at,expires_at,updated_at)
     VALUES($1,'premium',NOW(),NOW()+INTERVAL '1 month',NOW())
     ON CONFLICT(user_id) DO UPDATE SET
       plan='premium',
       started_at=CASE WHEN user_subscriptions.expires_at>NOW() THEN user_subscriptions.started_at ELSE NOW() END,
       expires_at=CASE WHEN user_subscriptions.expires_at>NOW()
                       THEN user_subscriptions.expires_at+INTERVAL '1 month'
                       ELSE NOW()+INTERVAL '1 month' END,
       updated_at=NOW()`,
    [userId]
  );
}

async function fetchJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "FPL-Risk-Calculator/1.0" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function interpolateRank(points, samples) {
  if (samples.length < 2) return null;
  const rows = [...samples].sort((a, b) => b.points - a.points || a.rank - b.rank);
  if (points >= rows[0].points) {
    const a = rows[0], b = rows[1];
    return a.rank + ((a.points - points) * (b.rank - a.rank)) / (a.points - b.points || 1);
  }
  const last = rows.length - 1;
  if (points <= rows[last].points) {
    const a = rows[last - 1], b = rows[last];
    return a.rank + ((a.points - points) * (b.rank - a.rank)) / (a.points - b.points || 1);
  }
  for (let i = 0; i < last; i += 1) {
    const a = rows[i], b = rows[i + 1];
    if (points <= a.points && points >= b.points) {
      return a.rank + ((a.points - points) * (b.rank - a.rank)) / (a.points - b.points || 1);
    }
  }
  return null;
}

function localSlopes(points, samples) {
  const rows = [...samples]
    .sort((a, b) => Math.abs(a.points - points) - Math.abs(b.points - points))
    .slice(0, 5)
    .sort((a, b) => b.points - a.points);
  const slopes = [];
  for (let i = 0; i < rows.length - 1; i += 1) {
    const dp = rows[i].points - rows[i + 1].points;
    if (dp === 0) continue;
    const dr = rows[i + 1].rank - rows[i].rank;
    slopes.push(Math.abs(dr / dp));
  }
  return slopes.filter(Number.isFinite).filter(v => v > 0);
}

export async function estimateRankImpact({
  fplId,
  relativeSwing,
  gameweek,
  tierName
}) {
  if (!pool) throw new Error("DATABASE_URL is required");
  if (!Number.isSafeInteger(fplId) || fplId <= 0)
    throw new Error("Invalid FPL Team ID");
  if (!Number.isFinite(relativeSwing))
    throw new Error("Invalid relative swing");
  if (!Number.isSafeInteger(gameweek) || gameweek <= 0)
    throw new Error("Invalid snapshot gameweek");
  if (typeof tierName !== "string" || !tierName)
    throw new Error("Invalid snapshot tier");

  const snapshotResult = await pool.query(
    `
      SELECT gameweek, season, deadline, picks_captured_at
      FROM fpl_gameweeks
      WHERE gameweek=$1
        AND status='complete'
      LIMIT 1
    `,
    [gameweek]
  );

  const snapshot = snapshotResult.rows[0];

  if (!snapshot)
    throw new Error("Requested risk snapshot is not complete");

  const history = await fetchJSON(`${ENTRY_URL}${fplId}/history/`);

  const historyRow = (history.current || []).find(
    row => Number(row.event) === gameweek
  );

  if (!historyRow)
    throw new Error("User snapshot history unavailable");

  const currentRank = Number(historyRow.overall_rank);
  const currentPoints = Number(historyRow.total_points);

  if (!Number.isSafeInteger(currentRank) || currentRank < 1)
    throw new Error("User snapshot rank unavailable");

  if (!Number.isFinite(currentPoints))
    throw new Error("User snapshot points unavailable");

  const result = await pool.query(
    `
      SELECT
        locked_rank,
        overall_points_at_lock
      FROM fpl_sample_managers
      WHERE gameweek=$1
        AND locked_tier=$2
        AND overall_points_at_lock IS NOT NULL
        AND locked_rank IS NOT NULL
      ORDER BY locked_rank ASC
    `,
    [gameweek, tierName]
  );

  const snapshotManagers = result.rows
    .map(row => ({
      rank: Number(row.locked_rank),
      points: Number(row.overall_points_at_lock)
    }))
    .filter(
      row =>
        Number.isSafeInteger(row.rank) &&
        row.rank >= 1 &&
        Number.isFinite(row.points)
    );

  if (snapshotManagers.length < 2)
    throw new Error(
      "Snapshot contains insufficient rank/points observations"
    );

  const rankTiers = [
    { name: "1-1000000", min: 1, max: 1000000 },
    { name: "1000001-2000000", min: 1000001, max: 2000000 },
    { name: "2000001-3000000", min: 2000001, max: 3000000 },
    { name: "3000001-4000000", min: 3000001, max: 4000000 },
    { name: "4000001-5000000", min: 4000001, max: 5000000 },
    { name: "5000001-6000000", min: 5000001, max: 6000000 },
    { name: "6000001-7000000", min: 6000001, max: 7000000 },
    { name: "7000001-8000000", min: 7000001, max: 8000000 },
    { name: "8000001-9000000", min: 8000001, max: 9000000 },
    { name: "9000001-10000000", min: 9000001, max: 10000000 }
  ];

  const boundaries = [
    {
      fromTier: "1-1000000",
      toTier: "1000001-2000000",
      boundaryRank: 1000001,
      boundaryPoints: 75
    },
    {
      fromTier: "1000001-2000000",
      toTier: "2000001-3000000",
      boundaryRank: 2000001,
      boundaryPoints: 70
    },
    {
      fromTier: "2000001-3000000",
      toTier: "3000001-4000000",
      boundaryRank: 3000001,
      boundaryPoints: 65
    },
    {
      fromTier: "3000001-4000000",
      toTier: "4000001-5000000",
      boundaryRank: 4000001,
      boundaryPoints: 60
    },
    {
      fromTier: "4000001-5000000",
      toTier: "5000001-6000000",
      boundaryRank: 5000001,
      boundaryPoints: 55
    },
    {
      fromTier: "5000001-6000000",
      toTier: "6000001-7000000",
      boundaryRank: 6000001,
      boundaryPoints: 50
    },
    {
      fromTier: "6000001-7000000",
      toTier: "7000001-8000000",
      boundaryRank: 7000001,
      boundaryPoints: 45
    },
    {
      fromTier: "7000001-8000000",
      toTier: "8000001-9000000",
      boundaryRank: 8000001,
      boundaryPoints: 40
    },
    {
      fromTier: "8000001-9000000",
      toTier: "9000001-10000000",
      boundaryRank: 9000001,
      boundaryPoints: 35
    }
  ];

  const rows = snapshotManagers
    .map(row => ({
      rank: Number(row.rank),
      points: Number(row.points)
    }))
    .filter(
      row =>
        Number.isSafeInteger(row.rank) &&
        row.rank >= 1 &&
        Number.isFinite(row.points)
    )
    .sort((a, b) => a.points - b.points);

  const tiers = rankTiers
    .filter(t => Number.isSafeInteger(t.min) && Number.isSafeInteger(t.max))
    .sort((a, b) => a.min - b.min);

  const currentTier =
    tiers.find(
      tier =>
        currentRank >= tier.min &&
        currentRank <= tier.max
    ) ||
    tiers.find(tier => tier.name === tierName);

  if (!currentTier)
    throw new Error("Could not determine current rank tier");

  function findBoundary(betterTier, worseTier) {
    return boundaries.find(
      boundary =>
        boundary.fromTier === betterTier.name &&
        boundary.toTier === worseTier.name &&
        Number.isFinite(Number(boundary.boundaryPoints))
    ) || null;
  }

  function rankAtPoints(targetPoints) {
    if (rows.length < 2) return null;

    if (targetPoints <= rows[0].points)
      return rows[0].rank;

    const last = rows[rows.length - 1];

    if (targetPoints >= last.points)
      return last.rank;

    for (let i = 1; i < rows.length; i++) {
      const lower = rows[i - 1];
      const upper = rows[i];

      if (targetPoints <= upper.points) {
        if (upper.points === lower.points) {
          return Math.round(
            (lower.rank + upper.rank) / 2
          );
        }

        const ratio =
          (targetPoints - lower.points) /
          (upper.points - lower.points);

        return Math.round(
          lower.rank +
          ratio * (upper.rank - lower.rank)
        );
      }
    }

    return last.rank;
  }

  const projectedPoints =
    Number((currentPoints + relativeSwing).toFixed(2));

  const direction =
    relativeSwing > 0
      ? "up"
      : relativeSwing < 0
        ? "down"
        : "unchanged";

  if (relativeSwing === 0) {
    return {
      currentRank,
      currentPoints,
      pointSwing: relativeSwing,
      projectedPoints,
      estimatedRank: currentRank,
      estimatedRankMovement: 0,
      direction: "unchanged",
      rankTier: currentTier.name,
      finalTier: currentTier.name,
      boundaryLowerLimit: null,
      boundaryDistance: 0,
      tiersCrossed: [],
      sampleSize: rows.length,
      gameweek: Number(snapshot.gameweek),
      season: snapshot.season
    };
  }

  let finalTier = currentTier;
  const tiersCrossed = [];

  if (direction === "up") {
    let currentIndex = tiers.findIndex(
      tier => tier.name === currentTier.name
    );

    while (currentIndex > 0) {
      const betterTier = tiers[currentIndex - 1];
      const worseTier = tiers[currentIndex];
      const boundary = findBoundary(
        betterTier,
        worseTier
      );

      if (!boundary) break;

      const boundaryPoints =
        Number(boundary.boundaryPoints);

      if (projectedPoints < boundaryPoints)
        break;

      tiersCrossed.push({
        fromTier: worseTier.name,
        toTier: betterTier.name,
        boundaryRank: Number(
          boundary.boundaryRank ?? worseTier.min
        ),
        boundaryLowerLimit:
          Number(boundaryPoints.toFixed(4)),
        boundaryDistance:
          Number(
            Math.max(
              0,
              boundaryPoints - currentPoints
            ).toFixed(4)
          )
      });

      finalTier = betterTier;
      currentIndex--;
    }
  }

  if (direction === "down") {
    let currentIndex = tiers.findIndex(
      tier => tier.name === currentTier.name
    );

    while (currentIndex < tiers.length - 1) {
      const betterTier = tiers[currentIndex];
      const worseTier = tiers[currentIndex + 1];
      const boundary = findBoundary(
        betterTier,
        worseTier
      );

      if (!boundary) break;

      const boundaryPoints =
        Number(boundary.boundaryPoints);

      if (projectedPoints > boundaryPoints)
        break;

      tiersCrossed.push({
        fromTier: betterTier.name,
        toTier: worseTier.name,
        boundaryRank: Number(
          boundary.boundaryRank ?? worseTier.min
        ),
        boundaryLowerLimit:
          Number(boundaryPoints.toFixed(4)),
        boundaryDistance:
          Number(
            Math.max(
              0,
              currentPoints - boundaryPoints
            ).toFixed(4)
          )
      });

      finalTier = worseTier;
      currentIndex++;
    }
  }

  const terminalRows = rows.filter(
    row =>
      row.rank >= finalTier.min &&
      row.rank <= finalTier.max
  );

  const rankingRows =
    terminalRows.length >= 2
      ? terminalRows
      : rows;

  const estimatedRank =
    rankAtPoints(projectedPoints) ?? currentRank;

  const estimatedRankMovement =
    currentRank - estimatedRank;

  const lastCrossing =
    tiersCrossed[tiersCrossed.length - 1] ?? null;

  return {
    currentRank,
    currentPoints,
    pointSwing: Number(relativeSwing.toFixed(2)),
    projectedPoints,
    estimatedRank,
    estimatedRankMovement,
    direction,
    rankTier: currentTier.name,
    finalTier: finalTier.name,
    boundaryLowerLimit:
      lastCrossing?.boundaryLowerLimit ?? null,
    boundaryDistance:
      lastCrossing?.boundaryDistance ?? 0,
    tiersCrossed,
    sampleSize: rankingRows.length,
    gameweek: Number(snapshot.gameweek),
    season: snapshot.season,
    snapshot: {
      deadline: snapshot.deadline,
      picksCapturedAt: snapshot.picks_captured_at
    },
    method:
      "snapshot-consistent score-to-rank interpolation with point-based tier boundaries"
  };
}

