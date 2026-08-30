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

export async function estimateRankImpact({ fplId, relativeSwing, gameweek, tierName }) {
  if (!pool) throw new Error("DATABASE_URL is required");
  if (!Number.isSafeInteger(fplId) || fplId <= 0) throw new Error("Invalid FPL Team ID");
  if (!Number.isFinite(relativeSwing)) throw new Error("Invalid relative swing");
  if (!Number.isSafeInteger(gameweek) || gameweek <= 0) throw new Error("Invalid snapshot gameweek");
  if (typeof tierName !== "string" || !tierName) throw new Error("Invalid snapshot tier");

  const snapshotResult = await pool.query(
    `SELECT gameweek, season, deadline, picks_captured_at
       FROM fpl_gameweeks
      WHERE gameweek=$1 AND status='complete'
      LIMIT 1`,
    [gameweek]
  );
  const snapshot = snapshotResult.rows[0];
  if (!snapshot) throw new Error("Requested risk snapshot is not complete");

  const history = await fetchJSON(`${ENTRY_URL}${fplId}/history/`);
  const historyRow = (history.current || []).find(row => Number(row.event) === gameweek);
  if (!historyRow) throw new Error("User snapshot history unavailable");

  const snapshotRank = Number(historyRow.overall_rank);
  const snapshotPoints = Number(historyRow.total_points);
  if (!Number.isSafeInteger(snapshotRank) || snapshotRank < 1) throw new Error("User snapshot rank unavailable");
  if (!Number.isFinite(snapshotPoints)) throw new Error("User snapshot points unavailable");

  const result = await pool.query(
    `SELECT locked_rank, overall_points_at_lock
       FROM fpl_sample_managers
      WHERE gameweek=$1
        AND locked_tier=$2
        AND overall_points_at_lock IS NOT NULL
        AND locked_rank IS NOT NULL
      ORDER BY locked_rank ASC`,
    [gameweek, tierName]
  );
  const samples = result.rows
    .map(row => ({ rank: Number(row.locked_rank), points: Number(row.overall_points_at_lock) }))
    .filter(row => Number.isSafeInteger(row.rank) && Number.isFinite(row.points));
  if (samples.length < 3) throw new Error("Not enough sampled score data for rank-impact estimation");

  const before = interpolateRank(snapshotPoints, samples);
  const after = interpolateRank(snapshotPoints + relativeSwing, samples);
  if (!Number.isFinite(before) || !Number.isFinite(after)) throw new Error("Unable to estimate rank impact from sampled score data");

  const places = before - after;
  const slopes = localSlopes(snapshotPoints, samples);
  const typicalSlope = slopes.length ? slopes.reduce((a, b) => a + b, 0) / slopes.length : Math.abs(places / (relativeSwing || 1));
  const lowSlope = slopes.length ? Math.min(...slopes) : typicalSlope;
  const highSlope = slopes.length ? Math.max(...slopes) : typicalSlope;
  const magnitude = Math.abs(relativeSwing);
  const low = Math.round(magnitude * lowSlope);
  const high = Math.round(magnitude * highSlope);

  return {
    currentRank: snapshotRank,
    currentPoints: snapshotPoints,
    snapshotRank,
    snapshotPoints,
    relativeSwing: Number(relativeSwing.toFixed(2)),
    estimatedPlaces: Math.round(places),
    estimatedRank: Math.max(1, Math.round(snapshotRank - places)),
    range: { low: Math.min(low, high), high: Math.max(low, high) },
    sampleSize: samples.length,
    gameweek: Number(snapshot.gameweek),
    season: snapshot.season,
    snapshot: { deadline: snapshot.deadline, picksCapturedAt: snapshot.picks_captured_at },
    method: "snapshot-consistent local score-to-rank interpolation from sampled managers",
  };
}
