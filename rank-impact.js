const ENTRY_URL = "https://fantasy.premierleague.com/api/entry/";
import { pool } from "./risk-engine.js";

const PAID_USER_IDS = new Set(
  (process.env.RANK_IMPACT_PAID_USER_IDS || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean)
);

export function isRankImpactEntitled(userId, isOwner) {
  return typeof userId === "string" && (isOwner(userId) || PAID_USER_IDS.has(userId));
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

export async function estimateRankImpact({ fplId, currentRank, relativeSwing, gameweek, tierName }) {
  if (!pool) throw new Error("DATABASE_URL is required");
  if (!Number.isSafeInteger(fplId) || fplId <= 0) throw new Error("Invalid FPL Team ID");
  if (!Number.isFinite(currentRank) || currentRank < 1) throw new Error("Invalid current rank");
  if (!Number.isFinite(relativeSwing)) throw new Error("Invalid relative swing");

  const manager = await fetchJSON(`${ENTRY_URL}${fplId}/`);
  const currentPoints = Number(manager.summary_overall_points);
  if (!Number.isFinite(currentPoints)) throw new Error("Current FPL points unavailable");

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

  if (samples.length < 3) {
    throw new Error("Not enough sampled score data for rank-impact estimation");
  }

  const before = interpolateRank(currentPoints, samples);
  const after = interpolateRank(currentPoints + relativeSwing, samples);
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    throw new Error("Unable to estimate rank impact from sampled score data");
  }

  const places = before - after;
  const slopes = localSlopes(currentPoints, samples);
  const typicalSlope = slopes.length ? slopes.reduce((a, b) => a + b, 0) / slopes.length : Math.abs(places / (relativeSwing || 1));
  const lowSlope = slopes.length ? Math.min(...slopes) : typicalSlope;
  const highSlope = slopes.length ? Math.max(...slopes) : typicalSlope;
  const magnitude = Math.abs(relativeSwing);
  const low = Math.round(magnitude * lowSlope);
  const high = Math.round(magnitude * highSlope);

  return {
    currentRank,
    currentPoints,
    relativeSwing: Number(relativeSwing.toFixed(2)),
    estimatedPlaces: Math.round(places),
    estimatedRank: Math.max(1, Math.round(currentRank - places)),
    range: { low: Math.min(low, high), high: Math.max(low, high) },
    sampleSize: samples.length,
    method: "local score-to-rank interpolation from sampled managers",
  };
}
