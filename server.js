import http from "node:http";
import pg from "pg";

const { Pool } = pg;

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

const FPL_URL =
  "https://fantasy.premierleague.com/api/bootstrap-static/";

const ENTRY_URL =
  "https://fantasy.premierleague.com/api/entry/";

const STANDINGS_URL =
  "https://fantasy.premierleague.com/api/leagues-classic/314/standings/";

// Check the schedule every 5 minutes.
const REFRESH_INTERVAL = 5 * 60 * 1000;

// Lock the sample six hours before the GW deadline.
const LOCK_HOURS_BEFORE_DEADLINE = 6;

const SAMPLING_BANDS = [
  { name: "1-10000", min: 1, max: 10000, sampleSize: 10 },
  { name: "10001-50000", min: 10001, max: 50000, sampleSize: 15 },
  { name: "50001-100000", min: 50001, max: 100000, sampleSize: 20 },
  { name: "100001-250000", min: 100001, max: 250000, sampleSize: 25 },
  { name: "250001-500000", min: 250001, max: 500000, sampleSize: 30 },
  { name: "500001-1000000", min: 500001, max: 1000000, sampleSize: 35 },
  { name: "1000001-2000000", min: 1000001, max: 2000000, sampleSize: 40 },
  { name: "2000001-3000000", min: 2000001, max: 3000000, sampleSize: 45 },
  { name: "3000001-4000000", min: 3000001, max: 4000000, sampleSize: 50 },
  { name: "4000001-5000000", min: 4000001, max: 5000000, sampleSize: 55 },
  { name: "5000001+", min: 5000001, max: Infinity, sampleSize: 60 }
];

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

const runtime = {
  refreshing: false,
  lastRefreshAttempt: null,
  lastSuccessfulRefresh: null,
  lastError: null
};

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(data));
}

async function fetchJSON(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function getFPLData() {
  return await fetchJSON(FPL_URL);
}

function getEvent(data, gameweek) {
  return data.events.find(event => event.id === gameweek) || null;
}

function getLatestCompletedGameweek(data) {
  const completed = data.events.filter(event => event.finished === true);
  return completed.length ? completed[completed.length - 1].id : null;
}

function getNextGameweek(data) {
  return data.events.find(event => event.is_next === true) || null;
}

function getStandingsPageForRank(rank) {
  return Math.ceil(rank / 50);
}

async function getStandingsPage(page) {
  return await fetchJSON(`${STANDINGS_URL}?page_standings=${page}`);
}

function randomInteger(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function getSampleManagersForBand(band, totalManagers) {
  const managersById = new Map();
  const maxRank = band.max === Infinity ? totalManagers : Math.min(band.max, totalManagers);
  const attemptedPages = new Set();

  while (managersById.size < band.sampleSize && attemptedPages.size < 20) {
    const randomRank = randomInteger(band.min, maxRank);
    const page = getStandingsPageForRank(randomRank);

    if (attemptedPages.has(page)) continue;
    attemptedPages.add(page);

    try {
      const data = await getStandingsPage(page);
      const managers = data.standings?.results || [];

      for (const manager of managers) {
        if (manager.rank >= band.min && manager.rank <= maxRank) {
          managersById.set(manager.entry, manager);
        }
      }
    } catch (error) {
      console.error(`Failed standings page ${page}:`, error.message);
    }
  }

  return [...managersById.values()].slice(0, band.sampleSize);
}

async function getManagerPicks(managerId, gameweek) {
  const url = `${ENTRY_URL}${managerId}/event/${gameweek}/picks/`;
  return await fetchJSON(url, 20000);
}

// ==================================================
// POSTGRESQL SCHEMA
// ==================================================

async function initDatabase() {
  if (!pool) {
    throw new Error("DATABASE_URL is not configured.");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fpl_gameweeks (
      gameweek INTEGER PRIMARY KEY,
      season TEXT NOT NULL,
      deadline TIMESTAMPTZ NOT NULL,
      lock_time TIMESTAMPTZ NOT NULL,
      total_managers INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      locked_at TIMESTAMPTZ,
      picks_captured_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS fpl_sample_managers (
      gameweek INTEGER NOT NULL REFERENCES fpl_gameweeks(gameweek) ON DELETE CASCADE,
      manager_id INTEGER NOT NULL,
      locked_rank INTEGER NOT NULL,
      locked_tier TEXT NOT NULL,
      manager_name TEXT,
      team_name TEXT,
      overall_points_at_lock INTEGER,
      picks JSONB,
      active_chip TEXT,
      captain INTEGER,
      triple_captain INTEGER,
      picks_captured_at TIMESTAMPTZ,
      PRIMARY KEY (gameweek, manager_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sample_managers_gameweek_tier
      ON fpl_sample_managers(gameweek, locked_tier);
  `);
}

async function saveGameweekSchedule(fplData) {
  for (const event of fplData.events) {
    if (!event.deadline_time) continue;

    const deadline = new Date(event.deadline_time);
    const lockTime = new Date(
      deadline.getTime() - LOCK_HOURS_BEFORE_DEADLINE * 60 * 60 * 1000
    );

    await pool.query(`
      INSERT INTO fpl_gameweeks
        (gameweek, season, deadline, lock_time, total_managers)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (gameweek) DO UPDATE SET
        season = EXCLUDED.season,
        deadline = EXCLUDED.deadline,
        lock_time = EXCLUDED.lock_time,
        total_managers = EXCLUDED.total_managers
    `, [
      event.id,
      "2026/27",
      deadline,
      lockTime,
      Number(fplData.total_players) || 0
    ]);
  }
}

function getRankTier(rank) {
  for (const band of SAMPLING_BANDS) {
    if (rank >= band.min && rank <= band.max) return band.name;
  }
  return null;
}

async function lockGameweekSamples(gameweek, fplData) {
  const event = getEvent(fplData, gameweek);
  if (!event || !event.deadline_time) return false;

  const deadline = new Date(event.deadline_time);
  const lockTime = new Date(
    deadline.getTime() - LOCK_HOURS_BEFORE_DEADLINE * 60 * 60 * 1000
  );

  if (Date.now() < lockTime.getTime()) return false;

  const existing = await pool.query(
    `SELECT status FROM fpl_gameweeks WHERE gameweek = $1`,
    [gameweek]
  );

  if (!existing.rowCount) return false;
  if (existing.rows[0].status !== "pending") return false;

  const totalManagers = Number(fplData.total_players);
  console.log(`LOCKING GW ${gameweek} samples at ${new Date().toISOString()}`);

  await pool.query(
    `UPDATE fpl_gameweeks SET status = 'locking', locked_at = NOW() WHERE gameweek = $1`,
    [gameweek]
  );

  try {
    for (const band of SAMPLING_BANDS) {
      const managers = await getSampleManagersForBand(band, totalManagers);

      for (const manager of managers) {
        const lockedRank = Number(manager.rank);
        const lockedTier = getRankTier(lockedRank);
        if (!lockedTier) continue;

        await pool.query(`
          INSERT INTO fpl_sample_managers
            (gameweek, manager_id, locked_rank, locked_tier, manager_name, team_name, overall_points_at_lock)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (gameweek, manager_id) DO NOTHING
        `, [
          gameweek,
          Number(manager.entry),
          lockedRank,
          lockedTier,
          manager.player_name || null,
          manager.entry_name || null,
          Number(manager.total) || 0
        ]);
      }

      console.log(`GW ${gameweek} band ${band.name}: locked ${managers.length} managers`);
    }

    await pool.query(
      `UPDATE fpl_gameweeks SET status = 'locked' WHERE gameweek = $1`,
      [gameweek]
    );

    console.log(`GW ${gameweek} SAMPLE LOCK COMPLETE`);
    return true;
  } catch (error) {
    await pool.query(
      `UPDATE fpl_gameweeks SET status = 'pending' WHERE gameweek = $1`,
      [gameweek]
    );
    throw error;
  }
}

async function captureGameweekPicks(gameweek) {
  const row = await pool.query(
    `SELECT status, deadline FROM fpl_gameweeks WHERE gameweek = $1`,
    [gameweek]
  );

  if (!row.rowCount || row.rows[0].status !== "locked") return false;

  const deadline = new Date(row.rows[0].deadline);
  if (Date.now() < deadline.getTime()) return false;

  const managers = await pool.query(
    `SELECT manager_id FROM fpl_sample_managers WHERE gameweek = $1 AND picks IS NULL`,
    [gameweek]
  );

  if (!managers.rowCount) {
    await pool.query(
      `UPDATE fpl_gameweeks SET status = 'complete', picks_captured_at = COALESCE(picks_captured_at, NOW()) WHERE gameweek = $1`,
      [gameweek]
    );
    return true;
  }

  console.log(`CAPTURING GW ${gameweek} PICKS FOR ${managers.rowCount} LOCKED MANAGERS`);

  for (const manager of managers.rows) {
    try {
      const picksData = await getManagerPicks(manager.manager_id, gameweek);
      const picks = picksData.picks || [];
      const captain = picks.find(pick => pick.is_captain === true);
      const tripleCaptain = picks.find(
        pick => pick.is_captain === true && Number(pick.multiplier) === 3
      );

      await pool.query(`
        UPDATE fpl_sample_managers
        SET picks = $1,
            active_chip = $2,
            captain = $3,
            triple_captain = $4,
            picks_captured_at = NOW()
        WHERE gameweek = $5 AND manager_id = $6
      `, [
        JSON.stringify(picks),
        picksData.active_chip ?? null,
        captain ? Number(captain.element) : null,
        tripleCaptain ? Number(tripleCaptain.element) : null,
        gameweek,
        manager.manager_id
      ]);
    } catch (error) {
      console.error(`GW ${gameweek} manager ${manager.manager_id} picks failed:`, error.message);
    }
  }

  const remaining = await pool.query(
    `SELECT COUNT(*)::int AS count FROM fpl_sample_managers WHERE gameweek = $1 AND picks IS NULL`,
    [gameweek]
  );

  if (remaining.rows[0].count === 0) {
    await pool.query(
      `UPDATE fpl_gameweeks SET status = 'complete', picks_captured_at = NOW() WHERE gameweek = $1`,
      [gameweek]
    );
    console.log(`GW ${gameweek} PICKS CAPTURE COMPLETE`);
  }

  return true;
}

function buildBandFromRows(band, rows) {
  const ownership = {};
  const captaincy = {};
  const tripleCaptaincy = {};
  const managers = [];

  for (const row of rows) {
    if (!Array.isArray(row.picks)) continue;

    const picks = row.picks;
    const captain = picks.find(pick => pick.is_captain === true);
    const tripleCaptain = picks.find(
      pick => pick.is_captain === true && Number(pick.multiplier) === 3
    );

    for (const pick of picks) {
      const id = String(pick.element);
      ownership[id] = (ownership[id] || 0) + 1;
    }

    if (captain) {
      const id = String(captain.element);
      captaincy[id] = (captaincy[id] || 0) + 1;
    }

    if (tripleCaptain) {
      const id = String(tripleCaptain.element);
      tripleCaptaincy[id] = (tripleCaptaincy[id] || 0) + 1;
    }

    managers.push({
      rank: row.locked_rank,
      managerId: row.manager_id,
      managerName: row.manager_name,
      teamName: row.team_name,
      overallPoints: row.overall_points_at_lock,
      lockedTier: row.locked_tier,
      activeChip: row.active_chip,
      captain: row.captain,
      tripleCaptain: row.triple_captain,
      picks
    });
  }

  const successfulSampleSize = managers.length;
  const toPercent = counts => Object.fromEntries(
    Object.entries(counts).map(([id, count]) => [
      id,
      Number((count / successfulSampleSize * 100).toFixed(1))
    ])
  );

  return {
    band: band.name,
    rankRange: {
      min: band.min,
      max: band.max === Infinity ? null : band.max
    },
    requestedSampleSize: band.sampleSize,
    successfulSampleSize,
    managers,
    ownership,
    ownershipPercent: successfulSampleSize ? toPercent(ownership) : {},
    captaincy,
    captaincyPercent: successfulSampleSize ? toPercent(captaincy) : {},
    tripleCaptaincy,
    tripleCaptainPercent: successfulSampleSize ? toPercent(tripleCaptaincy) : {}
  };
}

async function getCompletedRiskData() {
  const gameweekResult = await pool.query(`
    SELECT gameweek, season, total_managers, created_at
    FROM fpl_gameweeks
    WHERE status = 'complete'
    ORDER BY gameweek DESC
    LIMIT 1
  `);

  if (!gameweekResult.rowCount) return null;

  const gw = gameweekResult.rows[0];
  const rows = await pool.query(`
    SELECT gameweek, manager_id, locked_rank, locked_tier,
           manager_name, team_name, overall_points_at_lock,
           picks, active_chip, captain, triple_captain
    FROM fpl_sample_managers
    WHERE gameweek = $1 AND picks IS NOT NULL
    ORDER BY locked_rank ASC
  `, [gw.gameweek]);

  const bands = SAMPLING_BANDS.map(band =>
    buildBandFromRows(
      band,
      rows.rows.filter(row => row.locked_tier === band.name)
    )
  );

  return {
    season: gw.season,
    gameweek: gw.gameweek,
    totalManagers: gw.total_managers,
    bands,
    createdAt: gw.created_at,
    samplingPolicy: {
      lockHoursBeforeDeadline: LOCK_HOURS_BEFORE_DEADLINE,
      rankSource: "overall standings at lock time",
      picksSource: "manager GW picks after deadline"
    }
  };
}

async function refreshScheduler() {
  if (runtime.refreshing || !pool) return;
  runtime.refreshing = true;
  runtime.lastRefreshAttempt = new Date().toISOString();

  try {
    const fplData = await getFPLData();
    await saveGameweekSchedule(fplData);

    const next = getNextGameweek(fplData);
    if (next) {
      await lockGameweekSamples(next.id, fplData);
    }

    for (const event of fplData.events) {
      if (event.finished !== true) continue;
      await captureGameweekPicks(event.id);
    }

    runtime.lastSuccessfulRefresh = new Date().toISOString();
    runtime.lastError = null;
  } catch (error) {
    runtime.lastError = error.message;
    console.error("SCHEDULER FAILED:", error.message);
  } finally {
    runtime.refreshing = false;
  }
}

// ==================================================
// HTTP SERVER
// ==================================================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    let databaseReady = false;
    try {
      if (pool) {
        await pool.query("SELECT 1");
        databaseReady = true;
      }
    } catch {}

    sendJSON(res, 200, {
      status: "ok",
      databaseConfigured: Boolean(pool),
      databaseReady,
      refreshing: runtime.refreshing,
      lastRefreshAttempt: runtime.lastRefreshAttempt,
      lastSuccessfulRefresh: runtime.lastSuccessfulRefresh,
      lastError: runtime.lastError
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/sample-tiers") {
    try {
      const result = await getCompletedRiskData();
      if (!result) {
        sendJSON(res, 503, { error: "No completed locked sample is ready yet." });
        return;
      }
      sendJSON(res, 200, result);
    } catch (error) {
      sendJSON(res, 500, { error: "Could not load risk data.", details: error.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cache") {
    try {
      const result = await pool.query(`
        SELECT gameweek, status, deadline, lock_time, locked_at, picks_captured_at
        FROM fpl_gameweeks
        ORDER BY gameweek DESC
      `);
      sendJSON(res, 200, {
        lockHoursBeforeDeadline: LOCK_HOURS_BEFORE_DEADLINE,
        gameweeks: result.rows,
        scheduler: runtime
      });
    } catch (error) {
      sendJSON(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/entry/")) {
    const entryId = url.pathname.split("/api/entry/")[1];
    if (!entryId || !/^\d+$/.test(entryId)) {
      sendJSON(res, 400, { error: "Invalid FPL ID" });
      return;
    }

    try {
      const data = await fetchJSON(`${ENTRY_URL}${entryId}/`);
      sendJSON(res, 200, {
        id: data.id,
        playerName: `${data.player_first_name} ${data.player_last_name}`,
        teamName: data.name,
        overallRank: data.summary_overall_rank,
        overallPoints: data.summary_overall_points
      });
    } catch (error) {
      sendJSON(res, 502, {
        error: "Could not fetch FPL entry",
        details: error.message
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/fpl") {
    try {
      sendJSON(res, 200, await getFPLData());
    } catch (error) {
      sendJSON(res, 502, { error: error.message });
    }
    return;
  }

  sendJSON(res, 404, { error: "Not found" });
});

async function start() {
  if (pool) {
    try {
      await initDatabase();
      console.log("PostgreSQL connected and schema ready.");
      await refreshScheduler();
      setInterval(refreshScheduler, REFRESH_INTERVAL);
    } catch (error) {
      console.error("DATABASE STARTUP FAILED:", error.message);
    }
  } else {
    console.error("DATABASE_URL is missing. PostgreSQL persistence is disabled.");
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Sample lock policy: ${LOCK_HOURS_BEFORE_DEADLINE} hours before deadline.`);
  });
}

start();
