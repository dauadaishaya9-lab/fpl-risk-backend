// Current-season-only FPL Entry ID storage.
// The ID is intentionally ephemeral: no historical Entry IDs are retained.
import pg from "pg";

const { Pool } = pg;
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 }) : null;

export function currentSeasonKey() {
  // FPL seasons run roughly Aug-May. The season key is based on the calendar
  // year in which the season starts. This avoids retaining prior season IDs.
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const startYear = month >= 8 ? year : year - 1;
  return `${startYear}/${String(startYear + 1).slice(-2)}`;
}

async function ensureSchema() {
  if (!pool) throw new Error("DATABASE_URL is required");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS current_fpl_entries (
      user_id TEXT PRIMARY KEY,
      season TEXT NOT NULL,
      entry_id INTEGER NOT NULL CHECK (entry_id > 0),
      verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function getCurrentEntryId(userId) {
  await ensureSchema();
  const season = currentSeasonKey();
  const result = await pool.query(`SELECT entry_id FROM current_fpl_entries WHERE user_id=$1 AND season=$2`, [userId, season]);
  return result.rows[0]?.entry_id ? Number(result.rows[0].entry_id) : null;
}

export async function setCurrentEntryId(userId, entryId) {
  await ensureSchema();
  const season = currentSeasonKey();
  await pool.query(`
    INSERT INTO current_fpl_entries (user_id, season, entry_id, verified_at, updated_at)
    VALUES ($1,$2,$3,NOW(),NOW())
    ON CONFLICT (user_id) DO UPDATE SET season=EXCLUDED.season, entry_id=EXCLUDED.entry_id, verified_at=NOW(), updated_at=NOW()
  `, [userId, entryId]);
  return { season, entryId };
}

export async function deleteCurrentEntryId(userId) {
  await ensureSchema();
  await pool.query(`DELETE FROM current_fpl_entries WHERE user_id=$1`, [userId]);
}

export { pool as seasonEntryPool };