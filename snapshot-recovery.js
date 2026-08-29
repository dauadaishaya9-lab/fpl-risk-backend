import pg from "pg";
import { deterministicRanks, standingsPageForRank } from "./sampling.js";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const FPL_URL = "https://fantasy.premierleague.com/api/bootstrap-static/";
const STANDINGS_URL = "https://fantasy.premierleague.com/api/leagues-classic/314/standings/";
const ENTRY_URL = "https://fantasy.premierleague.com/api/entry/";
const LOCK_HOURS_BEFORE_DEADLINE = 1;

const BANDS = [
  { name:"1-10000", min:1, max:10000, sampleSize:10 },
  { name:"10001-50000", min:10001, max:50000, sampleSize:15 },
  { name:"50001-100000", min:50001, max:100000, sampleSize:20 },
  { name:"100001-250000", min:100001, max:250000, sampleSize:25 },
  { name:"250001-500000", min:250001, max:500000, sampleSize:30 },
  { name:"500001-1000000", min:500001, max:1000000, sampleSize:35 },
  { name:"1000001-2000000", min:1000001, max:2000000, sampleSize:40 },
  { name:"2000001-3000000", min:2000001, max:3000000, sampleSize:45 },
  { name:"3000001-4000000", min:3000001, max:4000000, sampleSize:50 },
  { name:"4000001-5000000", min:4000001, max:5000000, sampleSize:55 },
  { name:"5000001+", min:5000001, max:Infinity, sampleSize:60 },
];

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 })
  : null;

async function fetchJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "FPL-Risk-Calculator/1.0" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function seasonLabel() {
  const now = new Date();
  const year = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return `${year}/${String(year + 1).slice(-2)}`;
}

function tierForRank(rank) {
  return BANDS.find(b => rank >= b.min && rank <= b.max)?.name || null;
}

function recoverySearchRange(band, totalManagers) {
  if (band.max === Infinity) {
    return { min: Math.max(band.min, Math.floor(totalManagers * 0.75)), max: totalManagers };
  }
  const min = band.min === 1 ? 1 : Math.max(1, Math.floor(band.min * 0.75));
  const max = Math.min(totalManagers, Math.ceil(band.max * 1.25));
  return { min, max };
}

async function recoverBand({ band, season, gameweek, totalManagers }) {
  const range = recoverySearchRange(band, totalManagers);
  const candidateCount = Math.min(Math.max(band.sampleSize * 3, band.sampleSize + 10), 240);
  const targetRanks = deterministicRanks(`${season}+${gameweek}+${band.name}+recovery`, range.min, range.max, candidateCount);
  const pages = new Map();

  for (const rank of targetRanks) {
    const page = standingsPageForRank(rank);
    if (pages.has(page)) continue;
    try {
      const data = await fetchJSON(`${STANDINGS_URL}?page_standings=${page}`);
      pages.set(page, data.standings?.results || []);
    } catch (error) {
      console.error(`GW ${gameweek} recovery standings page ${page} failed:`, error.message);
    }
  }

  const candidates = [];
  const seen = new Set();
  for (const rows of pages.values()) {
    for (const manager of rows) {
      const id = Number(manager.entry);
      const historicalRank = Number(manager.last_rank);
      if (!Number.isSafeInteger(id) || !Number.isSafeInteger(historicalRank)) continue;
      if (tierForRank(historicalRank) !== band.name || seen.has(id)) continue;
      seen.add(id);
      candidates.push(manager);
    }
  }

  candidates.sort((a, b) => Number(a.last_rank) - Number(b.last_rank) || Number(a.entry) - Number(b.entry));
  const selected = candidates.slice(0, band.sampleSize);
  if (selected.length < band.sampleSize) {
    throw new Error(`Recovery could only find ${selected.length}/${band.sampleSize} GW ${gameweek} managers for ${band.name}`);
  }

  const recovered = [];
  for (const manager of selected) {
    const managerId = Number(manager.entry);
    const history = await fetchJSON(`${ENTRY_URL}${managerId}/history/`);
    const historyRow = (history.current || []).find(row => Number(row.event) === gameweek);
    if (!historyRow || Number(historyRow.overall_rank) !== Number(manager.last_rank)) {
      throw new Error(`Historical rank verification failed for manager ${managerId} in GW ${gameweek}`);
    }
    const picksData = await fetchJSON(`${ENTRY_URL}${managerId}/event/${gameweek}/picks/`);
    const picks = Array.isArray(picksData.picks) ? picksData.picks : [];
    if (picks.length !== 15) throw new Error(`Manager ${managerId} has ${picks.length} picks for GW ${gameweek}`);
    const captain = picks.find(p => p.is_captain === true);
    const triple = picks.find(p => p.is_captain === true && Number(p.multiplier) === 3);
    recovered.push({
      managerId,
      lockedRank: Number(historyRow.overall_rank),
      lockedTier: tierForRank(Number(historyRow.overall_rank)),
      managerName: manager.player_name || null,
      teamName: manager.entry_name || null,
      overallPointsAtLock: Number(historyRow.total_points) || 0,
      picks,
      activeChip: picksData.active_chip ?? null,
      captain: captain ? Number(captain.element) : null,
      tripleCaptain: triple ? Number(triple.element) : null,
    });
  }

  return recovered;
}

async function recoverMissedSnapshot() {
  if (!pool) return;

  const bootstrap = await fetchJSON(FPL_URL);
  const events = Array.isArray(bootstrap.events) ? bootstrap.events : [];
  const current = events.find(event => event.is_current === true);
  if (!current) return;

  const previous = events
    .filter(event => Number(event.id) < Number(current.id) && event.finished === true && event.data_checked === true)
    .sort((a, b) => Number(b.id) - Number(a.id))[0];
  if (!previous) return;

  const season = seasonLabel();
  const complete = await pool.query(`SELECT 1 FROM fpl_gameweeks WHERE season=$1 AND status='complete' LIMIT 1`, [season]);
  if (complete.rowCount) return;

  const existing = await pool.query(`SELECT gameweek,status FROM fpl_gameweeks WHERE season=$1 AND status IN ('locking','locked','complete') ORDER BY gameweek DESC`, [season]);
  if (existing.rowCount) return;

  const sampleRows = await pool.query(`SELECT 1 FROM fpl_sample_managers WHERE gameweek=$1 LIMIT 1`, [Number(previous.id)]);
  if (sampleRows.rowCount) return;

  const deadline = new Date(previous.deadline_time);
  if (!Number.isFinite(deadline.getTime()) || deadline.getTime() > Date.now()) return;

  console.log(`GW ${previous.id} recovery: missed pre-deadline lock detected; rebuilding exactly one previous snapshot.`);

  const recovered = [];
  try {
    for (const band of BANDS) {
      const rows = await recoverBand({ band, season, gameweek: Number(previous.id), totalManagers: Number(bootstrap.total_players) || 0 });
      recovered.push(...rows);
      console.log(`GW ${previous.id} recovery ${band.name}: ${rows.length}/${band.sampleSize} managers verified.`);
    }

    await pool.query(`
      INSERT INTO fpl_gameweeks(gameweek,season,deadline,lock_time,total_managers,status,locked_at,picks_captured_at)
      VALUES($1,$2,$3,$4,$5,'complete',NOW(),NOW())
      ON CONFLICT(gameweek) DO UPDATE SET
        season=EXCLUDED.season,
        deadline=EXCLUDED.deadline,
        lock_time=EXCLUDED.lock_time,
        total_managers=EXCLUDED.total_managers,
        status='complete',
        locked_at=COALESCE(fpl_gameweeks.locked_at,NOW()),
        picks_captured_at=COALESCE(fpl_gameweeks.picks_captured_at,NOW())
    `, [Number(previous.id), season, deadline, new Date(deadline.getTime() - LOCK_HOURS_BEFORE_DEADLINE * 60 * 60 * 1000), Number(bootstrap.total_players) || 0]);

    for (const row of recovered) {
      await pool.query(`
        INSERT INTO fpl_sample_managers(gameweek,manager_id,locked_rank,locked_tier,manager_name,team_name,overall_points_at_lock,picks,active_chip,captain,triple_captain,picks_captured_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
        ON CONFLICT(gameweek,manager_id) DO UPDATE SET
          locked_rank=EXCLUDED.locked_rank,
          locked_tier=EXCLUDED.locked_tier,
          manager_name=EXCLUDED.manager_name,
          team_name=EXCLUDED.team_name,
          overall_points_at_lock=EXCLUDED.overall_points_at_lock,
          picks=EXCLUDED.picks,
          active_chip=EXCLUDED.active_chip,
          captain=EXCLUDED.captain,
          triple_captain=EXCLUDED.triple_captain,
          picks_captured_at=NOW()
      `, [Number(previous.id), row.managerId, row.lockedRank, row.lockedTier, row.managerName, row.teamName, row.overallPointsAtLock, JSON.stringify(row.picks), row.activeChip, row.captain, row.tripleCaptain]);
    }

    await pool.query(`DELETE FROM fpl_sample_managers WHERE gameweek < $1`, [Number(previous.id)]);
    console.log(`GW ${previous.id} RECOVERY COMPLETE: one completed risk snapshot created.`);
  } catch (error) {
    await pool.query(`DELETE FROM fpl_sample_managers WHERE gameweek=$1`, [Number(previous.id)]);
    await pool.query(`DELETE FROM fpl_gameweeks WHERE gameweek=$1 AND status='complete' AND picks_captured_at IS NOT NULL`, [Number(previous.id)]);
    console.error(`GW ${previous.id} recovery aborted; no snapshot published:`, error.message);
  }
}

await recoverMissedSnapshot();
