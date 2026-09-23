const ENTRY_URL = "https://fantasy.premierleague.com/api/entry/";

import { pool } from "./risk-engine.js";
import { samplingBands } from "./sampling.js";
import { estimateRankMovement } from "./rank-movement.js";
import { fetchJSON } from "./fpl-fetch.js";

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
  if (!pool || typeof userId !== "string" || !userId) {
    return null;
  }

  await ensureSubscriptionSchema();

  const result = await pool.query(
    `
      SELECT user_id, plan, started_at, expires_at
      FROM user_subscriptions
      WHERE user_id = $1
        AND expires_at > NOW()
      LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] || null;
}

export async function isPaidUser(userId) {
  return !!(await getSubscription(userId));
}

export async function grantMonthlySubscription(userId) {
  if (!pool || typeof userId !== "string" || !userId) {
    throw new Error("Invalid user ID");
  }

  await ensureSubscriptionSchema();

  const result = await pool.query(
    `
      INSERT INTO user_subscriptions (
        user_id,
        plan,
        started_at,
        expires_at
      )
      VALUES (
        $1,
        'monthly',
        NOW(),
        NOW() + INTERVAL '1 month'
      )
      ON CONFLICT (user_id)
      DO UPDATE SET
        plan = EXCLUDED.plan,
        started_at = EXCLUDED.started_at,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
      RETURNING user_id, plan, started_at, expires_at
    `,
    [userId]
  );

  return result.rows[0];
}

export async function estimateRankImpact({
  fplId,
  relativeSwing,
  gameweek,
  tierName
}) {
  if (!pool) {
    throw new Error("DATABASE_URL is required");
  }

  if (!Number.isSafeInteger(fplId) || fplId <= 0) {
    throw new Error("Invalid FPL Team ID");
  }

  if (!Number.isFinite(relativeSwing)) {
    throw new Error("Invalid relative swing");
  }

  if (!Number.isSafeInteger(gameweek) || gameweek <= 0) {
    throw new Error("Invalid snapshot gameweek");
  }

  if (typeof tierName !== "string" || !tierName) {
    throw new Error("Invalid snapshot tier");
  }

  const snapshotResult = await pool.query(
    `
      SELECT
        gameweek,
        season,
        deadline,
        picks_captured_at,
        total_managers
      FROM fpl_gameweeks
      WHERE gameweek = $1
        AND status = 'complete'
      LIMIT 1
    `,
    [gameweek]
  );

  const snapshot = snapshotResult.rows[0];

  if (!snapshot) {
    throw new Error("Requested risk snapshot is not complete");
  }

  const totalManagers = Number(snapshot.total_managers);

  if (!Number.isSafeInteger(totalManagers) || totalManagers < 1) {
    throw new Error("Snapshot total manager count unavailable");
  }

  const tiers = samplingBands(totalManagers);

  if (!tiers.length) {
    throw new Error("Snapshot rank tiers unavailable");
  }

  if (!tiers.some(tier => tier.name === tierName)) {
    throw new Error("Snapshot tier is not in current sampling bands");
  }

  if (gameweek <= 1) {
    throw new Error(
      "Rank impact is not available before Gameweek 2 (there is no prior gameweek to compare against)."
    );
  }

  const referenceGameweek = gameweek - 1;

  const history = await fetchJSON(`${ENTRY_URL}${fplId}/history/`);

  const historyRow = (history.current || []).find(
    row => Number(row.event) === referenceGameweek
  );

  if (!historyRow) {
    throw new Error("User snapshot history unavailable");
  }

  const currentRank = Number(historyRow.overall_rank);
  const currentPoints = Number(historyRow.total_points);

  if (!Number.isSafeInteger(currentRank) || currentRank < 1) {
    throw new Error("User snapshot rank unavailable");
  }

  if (!Number.isFinite(currentPoints)) {
    throw new Error("User snapshot points unavailable");
  }

  /*
   * IMPORTANT:
   * This reads from fpl_rank_sample_managers, a separate, denser,
   * standings-only sample used ONLY for rank estimation (never
   * used for ownership/exposure, which stays on fpl_sample_managers).
   * We intentionally read ALL successfully captured managers from
   * the snapshot instead of restricting observations to the user's
   * tier, so rank-movement.js can derive observed boundaries between
   * the current production sampling tiers.
   */
  const result = await pool.query(
    `
      SELECT
        locked_rank,
        overall_points_at_lock
      FROM fpl_rank_sample_managers
      WHERE gameweek = $1
        AND overall_points_at_lock IS NOT NULL
        AND locked_rank IS NOT NULL
      ORDER BY locked_rank ASC
    `,
    [gameweek]
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

  if (snapshotManagers.length < 2) {
    throw new Error(
      "Snapshot contains insufficient rank/points observations"
    );
  }

  const movement = estimateRankMovement({
    currentRank,
    currentPoints,
    pointSwing: relativeSwing,
    rows: snapshotManagers,
    tiers
  });

  const [finalMin, finalMax] =
    movement.finalTier.split("-").map(Number);

  const rankingRows = snapshotManagers.filter(
    row =>
      row.rank >= finalMin &&
      row.rank <= finalMax
  );

  const lastCrossing =
    movement.tiersCrossed[movement.tiersCrossed.length - 1] ?? null;

  return {
    currentRank: movement.currentRank,
    currentPoints: movement.currentPoints,
    pointSwing: movement.pointSwing,
    projectedPoints: movement.projectedPoints,
    estimatedRank: movement.estimatedRank,
    estimatedRankMovement: movement.estimatedRankMovement,
    direction: movement.direction,
    rankTier: movement.rankTier,
    finalTier: movement.finalTier,

    boundaryLowerLimit:
      lastCrossing?.boundaryLowerLimit ?? null,

    boundaryDistance:
      lastCrossing?.boundaryDistance ?? 0,

    tiersCrossed: movement.tiersCrossed,

    sampleSize: rankingRows.length,

    gameweek: Number(snapshot.gameweek),
    season: snapshot.season,

    snapshot: {
      deadline: snapshot.deadline,
      picksCapturedAt: snapshot.picks_captured_at
    },

    method:
      "snapshot-observed score-to-rank interpolation with observed tier boundaries",

    debugNearby: movement.debugNearby
  };
}
