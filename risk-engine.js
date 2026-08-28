import pg from "pg";

const { Pool } = pg;
const FPL_URL = "https://fantasy.premierleague.com/api/bootstrap-static/";
const ENTRY_URL = "https://fantasy.premierleague.com/api/entry/";

export const TRIAL_LIMIT = 3;
export const RANK_TIERS = [
  { name: "1-10000", min: 1, max: 10000 },
  { name: "10001-50000", min: 10001, max: 50000 },
  { name: "50001-100000", min: 50001, max: 100000 },
  { name: "100001-250000", min: 100001, max: 250000 },
  { name: "250001-500000", min: 250001, max: 500000 },
  { name: "500001-1000000", min: 500001, max: 1000000 },
  { name: "1000001-2000000", min: 1000001, max: 2000000 },
  { name: "2000001-3000000", min: 2000001, max: 3000000 },
  { name: "3000001-4000000", min: 3000001, max: 4000000 },
  { name: "4000001-5000000", min: 4000001, max: 5000000 },
  { name: "5000001+", min: 5000001, max: Infinity }
];

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 })
  : null;
let bootstrapCache = { data: null, expiresAt: 0 };

function currentSeasonKey(bootstrap) {
  const raw = bootstrap?.events?.find?.(event => event?.is_current)?.season;
  if (typeof raw === "string" && raw) return raw;
  const now = new Date();
  const year = now.getUTCFullYear();
  return now.getUTCMonth() + 1 >= 8
    ? `${year}/${String(year + 1).slice(-2)}`
    : `${year - 1}/${String(year).slice(-2)}`;
}

async function fetchJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "FPL-Risk/1.0" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getBootstrap() {
  if (bootstrapCache.data && bootstrapCache.expiresAt > Date.now()) return bootstrapCache.data;
  const data = await fetchJSON(FPL_URL);
  bootstrapCache = { data, expiresAt: Date.now() + 120000 };
  return data;
}

function tierForRank(rank) {
  return RANK_TIERS.find(tier => rank >= tier.min && rank <= tier.max) || null;
}

function validateUserId(userId) {
  if (!userId || typeof userId !== "string" || userId.length > 256) {
    throw Object.assign(new Error("Invalid authenticated user"), { status: 401, code: "INVALID_AUTH_USER" });
  }
}

async function verifyFplEntryLive(fplId) {
  if (!Number.isSafeInteger(fplId) || fplId <= 0) {
    throw Object.assign(new Error("Invalid FPL Team ID"), { status: 400, code: "INVALID_FPL_TEAM_ID" });
  }
  const bootstrap = await getBootstrap();
  const season = currentSeasonKey(bootstrap);
  let manager;
  try {
    manager = await fetchJSON(`${ENTRY_URL}${fplId}/`);
  } catch {
    throw Object.assign(new Error("FPL Team ID could not be verified"), { status: 404, code: "FPL_TEAM_NOT_FOUND" });
  }
  const rank = Number(manager.summary_overall_rank);
  if (Number(manager.id) !== fplId || !Number.isSafeInteger(rank) || rank < 1) {
    throw Object.assign(new Error("FPL Team ID could not be verified for the current season"), { status: 404, code: "FPL_TEAM_NOT_FOUND" });
  }
  return {
    fplId,
    season,
    rank,
    playerName: `${manager.player_first_name || ""} ${manager.player_last_name || ""}`.trim(),
    teamName: manager.name || null
  };
}

export async function verifyFplEntry(fplId) {
  return verifyFplEntryLive(fplId);
}

// One row per Clerk user. A new season overwrites the previous Team/Entry ID.
// No historical FPL Team IDs are retained.
export async function getLinkedFplId(userId) {
  validateUserId(userId);
  if (!pool) throw new Error("DATABASE_URL is required");
  const season = currentSeasonKey(await getBootstrap());
  const result = await pool.query(
    `SELECT fpl_entry_id, season, verified_at
     FROM fpl_current_account_links
     WHERE user_id=$1 AND season=$2`,
    [userId, season]
  );
  if (!result.rowCount) return null;
  return {
    fplId: Number(result.rows[0].fpl_entry_id),
    season: result.rows[0].season,
    verifiedAt: result.rows[0].verified_at
  };
}

export async function linkFplAccount(userId, fplId) {
  validateUserId(userId);
  const verified = await verifyFplEntryLive(fplId);
  if (!pool) throw new Error("DATABASE_URL is required");

  try {
    await pool.query(
      `INSERT INTO fpl_current_account_links (user_id, season, fpl_entry_id, verified_at, updated_at)
       VALUES ($1,$2,$3,NOW(),NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET season=EXCLUDED.season,
                     fpl_entry_id=EXCLUDED.fpl_entry_id,
                     verified_at=NOW(),
                     updated_at=NOW()`,
      [userId, verified.season, verified.fplId]
    );
  } catch (error) {
    if (error?.code === "23505") {
      throw Object.assign(new Error("That FPL Team ID is already linked to another user."), {
        status: 409,
        code: "FPL_TEAM_ALREADY_LINKED"
      });
    }
    throw error;
  }

  return verified;
}

async function resolveUserFplId(userId) {
  const linked = await getLinkedFplId(userId);
  if (!linked) {
    throw Object.assign(new Error("Enter your FPL Team ID for the current season before using the calculator"), {
      status: 409,
      code: "FPL_TEAM_ID_REQUIRED"
    });
  }
  return linked.fplId;
}

export async function getManagerContext(fplId) {
  const verified = await verifyFplEntryLive(fplId);
  const tier = tierForRank(verified.rank);
  if (!tier) throw new Error("FPL manager rank is unavailable or outside configured tiers");
  return {
    managerId: verified.fplId,
    playerName: verified.playerName,
    teamName: verified.teamName,
    rank: verified.rank,
    tier,
    season: verified.season
  };
}

async function latestCompletedGameweek() {
  if (!pool) throw new Error("DATABASE_URL is required");
  const result = await pool.query(
    `SELECT gameweek, season, deadline, picks_captured_at
     FROM fpl_gameweeks
     WHERE status='complete'
     ORDER BY gameweek DESC LIMIT 1`
  );
  return result.rows[0] || null;
}

async function exposureRows(gameweek, tierName) {
  const result = await pool.query(
    `SELECT manager_id, locked_rank, picks
     FROM fpl_sample_managers
     WHERE gameweek=$1 AND locked_tier=$2 AND picks IS NOT NULL
     ORDER BY locked_rank ASC`,
    [gameweek, tierName]
  );
  return result.rows;
}

function buildExposure(rows) {
  const ownership = new Map();
  const captaincy = new Map();
  const tripleCaptaincy = new Map();
  for (const row of rows) {
    for (const pick of row.picks || []) {
      const id = Number(pick.element);
      ownership.set(id, (ownership.get(id) || 0) + 1);
    }
    const captain = (row.picks || []).find(pick => pick.is_captain === true);
    if (captain) {
      const id = Number(captain.element);
      captaincy.set(id, (captaincy.get(id) || 0) + 1);
      if (Number(captain.multiplier) === 3) tripleCaptaincy.set(id, (tripleCaptaincy.get(id) || 0) + 1);
    }
  }
  return { ownership, captaincy, tripleCaptaincy };
}

export async function getTopFive(fplId) {
  const context = await getManagerContext(fplId);
  const snapshot = await latestCompletedGameweek();
  if (!snapshot) throw new Error("No completed risk snapshot is ready yet");
  const rows = await exposureRows(snapshot.gameweek, context.tier.name);
  const sampleSize = rows.length;
  if (!sampleSize) throw new Error(`No completed sample is ready for rank tier ${context.tier.name}`);
  const { ownership, captaincy, tripleCaptaincy } = buildExposure(rows);
  const bootstrap = await getBootstrap();
  const players = new Map((bootstrap.elements || []).map(player => [Number(player.id), player]));
  const topFive = [...ownership.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([playerId, ownerCount], index) => {
      const player = players.get(playerId);
      const captainCount = captaincy.get(playerId) || 0;
      const tcCount = tripleCaptaincy.get(playerId) || 0;
      return {
        rank: index + 1,
        playerId,
        name: player?.web_name || `Player ${playerId}`,
        teamId: player?.team ?? null,
        position: player?.element_type ?? null,
        ownershipPct: Number((ownerCount / sampleSize * 100).toFixed(1)),
        captainPct: Number((captainCount / sampleSize * 100).toFixed(1)),
        tripleCaptainPct: Number((tcCount / sampleSize * 100).toFixed(1)),
        sampleSize,
        ownerCount,
        captainCount,
        tripleCaptainCount: tcCount
      };
    });
  return {
    manager: { id: context.managerId, name: context.playerName, teamName: context.teamName, rank: context.rank },
    tier: { name: context.tier.name, min: context.tier.min, max: Number.isFinite(context.tier.max) ? context.tier.max : null },
    gameweek: snapshot.gameweek,
    season: snapshot.season,
    snapshot: { deadline: snapshot.deadline, picksCapturedAt: snapshot.picks_captured_at },
    sampleSize,
    players: topFive
  };
}

function exposureForDecision({ owns, captain, tripleCaptain }) {
  if (!owns) return 0;
  if (tripleCaptain) return 3;
  if (captain) return 2;
  return 1;
}

export async function analyzeRisk({ fplId, playerId, owns, captain, tripleCaptain, expectedPoints }) {
  if (!Number.isSafeInteger(playerId) || playerId <= 0) throw new Error("Invalid player ID");
  if (!Number.isFinite(expectedPoints) || expectedPoints < 0 || expectedPoints > 100) throw new Error("Expected points must be between 0 and 100");
  if (typeof owns !== "boolean" || typeof captain !== "boolean" || typeof tripleCaptain !== "boolean") throw new Error("Decision fields must be boolean");
  if (!owns && (captain || tripleCaptain)) throw new Error("Captain and triple captain require ownership");
  if (tripleCaptain && !captain) throw new Error("Triple captain requires captain selection");
  const context = await getManagerContext(fplId);
  const snapshot = await latestCompletedGameweek();
  if (!snapshot) throw new Error("No completed risk snapshot is ready yet");
  const rows = await exposureRows(snapshot.gameweek, context.tier.name);
  if (!rows.length) throw new Error(`No completed sample is ready for rank tier ${context.tier.name}`);
  const exposure = buildExposure(rows);
  const sampleSize = rows.length;
  const ownerPct = (exposure.ownership.get(playerId) || 0) / sampleSize;
  const captainPct = (exposure.captaincy.get(playerId) || 0) / sampleSize;
  const tripleCaptainPct = (exposure.tripleCaptaincy.get(playerId) || 0) / sampleSize;
  const tierExposure = ownerPct + captainPct + 2 * tripleCaptainPct;
  const userExposure = exposureForDecision({ owns, captain, tripleCaptain });
  const relativeSwing = (userExposure - tierExposure) * expectedPoints;
  const bootstrap = await getBootstrap();
  const player = (bootstrap.elements || []).find(item => Number(item.id) === playerId);
  if (!player) throw new Error("Player not found");
  return {
    player: { id: playerId, name: player.web_name, teamId: player.team, position: player.element_type },
    decision: { owns, captain, tripleCaptain, expectedPoints },
    tier: { name: context.tier.name, min: context.tier.min, max: Number.isFinite(context.tier.max) ? context.tier.max : null },
    rank: context.rank,
    sampleSize,
    ownershipPct: Number((ownerPct * 100).toFixed(1)),
    captainPct: Number((captainPct * 100).toFixed(1)),
    tripleCaptainPct: Number((tripleCaptainPct * 100).toFixed(1)),
    userExposure,
    tierExposure: Number(tierExposure.toFixed(4)),
    relativeSwing: Number(relativeSwing.toFixed(2)),
    gameweek: snapshot.gameweek,
    season: snapshot.season
  };
}

export async function getTopFiveForUser(userId) {
  return getTopFive(await resolveUserFplId(userId));
}

export async function analyzeRiskForUser(userId, input) {
  return analyzeRisk({ fplId: await resolveUserFplId(userId), ...input });
}

export async function getUsage(userId) {
  validateUserId(userId);
  if (!pool) throw new Error("DATABASE_URL is required");
  const upcoming = await pool.query(`SELECT gameweek, deadline FROM fpl_gameweeks WHERE deadline>NOW() ORDER BY deadline ASC LIMIT 1`);
  if (!upcoming.rowCount) return { used: 0, remaining: TRIAL_LIMIT, limit: TRIAL_LIMIT, gameweek: null, resetsAt: null };
  const gameweek = Number(upcoming.rows[0].gameweek);
  const deadline = upcoming.rows[0].deadline;
  const result = await pool.query(`SELECT calculation_count FROM user_deadline_usage WHERE user_id=$1 AND gameweek=$2`, [userId, gameweek]);
  const used = Number(result.rows[0]?.calculation_count || 0);
  return { used, remaining: Math.max(0, TRIAL_LIMIT - used), limit: TRIAL_LIMIT, gameweek, resetsAt: deadline };
}

export { pool };
