import pg from "pg";
import { deterministicRanks, standingsPageForRank } from "./sampling.js";
import { fetchJSON } from "./fpl-fetch.js";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const FPL_URL = "https://fantasy.premierleague.com/api/bootstrap-static/";
const STANDINGS_URL = "https://fantasy.premierleague.com/api/leagues-classic/314/standings/";
const ENTRY_URL = "https://fantasy.premierleague.com/api/entry/";
const LOCK_HOURS_BEFORE_DEADLINE = 1;

const FIXED_BANDS = [
  { name:"1-10000", min:1, max:10000, sampleSize:10 },
  { name:"10001-50000", min:10001, max:50000, sampleSize:15 },
  { name:"50001-100000", min:50001, max:100000, sampleSize:20 },
  { name:"100001-250000", min:100001, max:250000, sampleSize:25 },
  { name:"250001-500000", min:250001, max:500000, sampleSize:30 },
  { name:"500001-1000000", min:500001, max:1000000, sampleSize:35 },
];
const MILLION_BAND_START=1000001;
const MILLION_BAND_SIZE=1000000;
const MILLION_BAND_SAMPLE_SIZE=60;

function getBands(totalManagers) {
  const total=Math.max(0,Math.floor(Number(totalManagers)||0));
  const bands=FIXED_BANDS.map(b=>({...b}));
  for(let min=MILLION_BAND_START;min<=total;min+=MILLION_BAND_SIZE){
    const max=Math.min(min+MILLION_BAND_SIZE-1,total);
    bands.push({name:`${min}-${max}`,min,max,sampleSize:Math.min(MILLION_BAND_SAMPLE_SIZE,max-min+1)});
  }
  return bands;
}

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 })
  : null;

async function ensureSchema() {
  if (!pool) return;
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
      pick_attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(gameweek,manager_id)
    );
    ALTER TABLE fpl_sample_managers ADD COLUMN IF NOT EXISTS pick_attempts INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_sample_managers_gameweek_tier ON fpl_sample_managers(gameweek,locked_tier);
    CREATE INDEX IF NOT EXISTS idx_gameweeks_status_deadline ON fpl_gameweeks(status,deadline);
  `);
}

function seasonLabel() {
  const now = new Date();
  const year = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return `${year}/${String(year + 1).slice(-2)}`;
}

function tierForRank(rank,totalManagers){
  return getBands(totalManagers).find(b => rank >= b.min && rank <= b.max)?.name || null;
}

function recoverySearchRange(band,totalManagers){
  return { min: band.min === 1 ? 1 : Math.max(1,Math.floor(band.min * 0.75)), max: Math.min(totalManagers,Math.ceil(band.max * 1.25)) };
}

async function recoverBand({band,season,gameweek,totalManagers}) {
  const range=recoverySearchRange(band,totalManagers);
  const candidateCount=Math.min(Math.max(band.sampleSize * 3,band.sampleSize + 10),240);
  const targetRanks=deterministicRanks(`${season}+${gameweek}+${band.name}+recovery`,range.min,range.max,candidateCount);
  const pages=new Map();

  for(const rank of targetRanks){
    const page=standingsPageForRank(rank);
    if(pages.has(page))continue;
    try {
      const data=await fetchJSON(`${STANDINGS_URL}?page_standings=${page}`,20000,{label:`GW ${gameweek} recovery ${band.name} standings page ${page}`});
      pages.set(page,data.standings?.results||[]);
    } catch(error) {
      console.error(`GW ${gameweek} recovery standings page ${page} failed after retries:`,error.message);
    }
  }

  const candidates=[];
  const seen=new Set();
  for(const rows of pages.values()){
    for(const manager of rows){
      const id=Number(manager.entry);
      const historicalRank=Number(manager.last_rank);
      if(!Number.isSafeInteger(id)||!Number.isSafeInteger(historicalRank))continue;
      if(tierForRank(historicalRank,totalManagers)!==band.name||seen.has(id))continue;
      seen.add(id);
      candidates.push(manager);
    }
  }

  candidates.sort((a,b)=>Number(a.last_rank)-Number(b.last_rank)||Number(a.entry)-Number(b.entry));
  const selected=candidates.slice(0,band.sampleSize);
  if(selected.length<band.sampleSize){
    console.log(`GW ${gameweek} recovery ${band.name}: insufficient managers ${selected.length}/${band.sampleSize}; ignoring this tier and all later tiers.`);
    return [];
  }

  const recovered=[];
  for(let index=0;index<selected.length;index++){
    const manager=selected[index];
    const managerId=Number(manager.entry);
    console.log(`GW ${gameweek} recovery ${band.name}: fetching manager ${index + 1}/${selected.length} picks (ID ${managerId}).`);
    const picksData=await fetchJSON(`${ENTRY_URL}${managerId}/event/${gameweek}/picks/`,20000,{label:`GW ${gameweek} recovery ${band.name} manager ${index + 1}/${selected.length} picks (ID ${managerId})`});
    const picks=Array.isArray(picksData.picks)?picksData.picks:[];
    if(picks.length!==15)throw new Error(`Manager ${managerId} has ${picks.length} picks for GW ${gameweek}`);
    const captain=picks.find(p=>p.is_captain===true);
    const triple=picks.find(p=>p.is_captain===true&&Number(p.multiplier)===3);
    recovered.push({managerId,lockedRank:Number(manager.last_rank),lockedTier:tierForRank(Number(manager.last_rank),totalManagers),managerName:manager.player_name||null,teamName:manager.entry_name||null,overallPointsAtLock:Number(manager.total),picks,activeChip:picksData.active_chip??null,captain:captain?Number(captain.element):null,tripleCaptain:triple?Number(triple.element):null});
    console.log(`GW ${gameweek} recovery ${band.name}: manager ${index + 1}/${selected.length} picks verified.`);
  }
  return recovered;
}

export async function recoverMissedSnapshot(){
  if(!pool)return;

  await ensureSchema();

  console.log("RECOVERY: checking for a finished gameweek without an immutable cohort.");

  const bootstrap=await fetchJSON(FPL_URL);
  const events=Array.isArray(bootstrap?.events)?bootstrap.events:[];

  const current=events.find(event=>event.is_current);
  if(!current){
    console.log("RECOVERY: no current gameweek found; nothing to recover.");
    return;
  }

  const finished=events
    .filter(event=>event.finished&&event.data_checked)
    .sort((a,b)=>Number(b.id)-Number(a.id));

  if(!finished.length){
    console.log("RECOVERY: no finished/data-checked gameweek available.");
    return;
  }

  const target=finished[0];
  const gameweek=Number(target.id);
  const deadline=new Date(target.deadline_time);

  if(!Number.isFinite(gameweek)||Number.isNaN(deadline.getTime())){
    console.log("RECOVERY: target gameweek/deadline is invalid.");
    return;
  }

  if(Date.now()<deadline.getTime()){
    console.log(`RECOVERY: GW ${gameweek} deadline has not passed; nothing to recover.`);
    return;
  }

  /*
   * DATABASE IS THE SOURCE OF TRUTH.
   * If any immutable manager rows already exist for this GW,
   * recovery does not create another cohort.
   */
  const existing=await pool.query(
    `SELECT COUNT(*)::int AS manager_count
     FROM fpl_sample_managers
     WHERE gameweek=$1`,
    [gameweek]
  );

  if(Number(existing.rows[0]?.manager_count||0)>0){
    console.log(
      `RECOVERY: GW ${gameweek} immutable cohort already exists; server.js owns future refreshes.`
    );
    return;
  }

  const season=seasonLabel();
  const totalManagers=Number(bootstrap.total_players)||0;

  if(totalManagers<=0){
    console.log("RECOVERY: total manager count unavailable.");
    return;
  }

  console.log(
    `RECOVERY: GW ${gameweek} deadline passed and no immutable cohort exists; creating cohort.`
  );

  const bands=getBands(totalManagers);
  const recovered=[];

  try{
    /*
     * Existing deterministic recovery/sampling logic remains unchanged.
     * Recovery only creates the cohort when the database has none.
     */
    for(const band of bands){
      const rows=await recoverBand({
        band,
        season,
        gameweek,
        totalManagers
      });

      if(!Array.isArray(rows)||rows.length<band.sampleSize){
        console.log(
          `RECOVERY: stopping at tier ${band.label||band.tier||"unknown"}; recovered ${rows?.length||0}/${band.sampleSize}.`
        );
        break;
      }

      recovered.push(...rows);
    }

    if(!recovered.length){
      throw new Error(`No managers were recovered for GW ${gameweek}.`);
    }

    const ids=recovered.map(row=>Number(row.managerId));

    if(ids.some(id=>!Number.isFinite(id)||id<=0)){
      throw new Error("Recovered cohort contains an invalid manager ID.");
    }

    if(new Set(ids).size!==ids.length){
      throw new Error("Recovered cohort contains duplicate manager IDs.");
    }

    const invalid=recovered.find(row=>
      !Number.isFinite(Number(row.lockedRank))||
      Number(row.lockedRank)<=0||
      !row.lockedTier||
      !Number.isFinite(Number(row.overallPointsAtLock))
    );

    if(invalid){
      throw new Error(
        `Recovered cohort contains invalid immutable data for manager ${invalid.managerId}.`
      );
    }

    const client=await pool.connect();

    try{
      await client.query("BEGIN");

      /*
       * IMPORTANT:
       * Recovery hands the cohort to server.js as LOCKED.
       * server.js therefore uses these exact stored manager IDs.
       */
      await client.query(
        `INSERT INTO fpl_gameweeks
          (gameweek,season,deadline,lock_time,total_managers,status,locked_at,picks_captured_at)
         VALUES
          ($1,$2,$3,$4,$5,'locked',NOW(),NOW())
         ON CONFLICT(gameweek) DO UPDATE SET
           season=EXCLUDED.season,
           deadline=EXCLUDED.deadline,
           lock_time=EXCLUDED.lock_time,
           total_managers=EXCLUDED.total_managers,
           status='locked',
           locked_at=COALESCE(fpl_gameweeks.locked_at,NOW()),
           picks_captured_at=NOW()`,
        [
          gameweek,
          season,
          deadline,
          new Date(
            deadline.getTime()-
            LOCK_HOURS_BEFORE_DEADLINE*60*60*1000
          ),
          totalManagers
        ]
      );

      for(const row of recovered){
        await client.query(
          `INSERT INTO fpl_sample_managers
            (
              gameweek,
              manager_id,
              locked_rank,
              locked_tier,
              manager_name,
              team_name,
              overall_points_at_lock,
              picks,
              active_chip,
              captain,
              triple_captain,
              picks_captured_at
            )
           VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
           ON CONFLICT(gameweek,manager_id) DO NOTHING`,
          [
            gameweek,
            Number(row.managerId),
            Number(row.lockedRank),
            row.lockedTier,
            row.managerName||null,
            row.teamName||null,
            Number(row.overallPointsAtLock),
            JSON.stringify(row.picks||[]),
            row.activeChip||null,
            row.captain||null,
            row.tripleCaptain||null
          ]
        );
      }

      /*
       * Verify the complete immutable cohort and initial picks
       * before committing the transaction.
       */
      const verify=await client.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(DISTINCT manager_id)::int AS distinct_managers,
           COUNT(*) FILTER (
             WHERE locked_rank IS NULL
                OR locked_tier IS NULL
                OR overall_points_at_lock IS NULL
           )::int AS missing_immutable,
           COUNT(*) FILTER (
             WHERE picks IS NOT NULL
               AND jsonb_array_length(picks::jsonb)=15
           )::int AS picks_ready
         FROM fpl_sample_managers
         WHERE gameweek=$1`,
        [gameweek]
      );

      const v=verify.rows[0];
      const total=Number(v.total||0);
      const distinct=Number(v.distinct_managers||0);
      const missing=Number(v.missing_immutable||0);
      const picksReady=Number(v.picks_ready||0);

      if(
        total!==recovered.length||
        distinct!==recovered.length||
        missing!==0||
        picksReady!==recovered.length
      ){
        throw new Error(
          `Cohort verification failed: expected ${recovered.length}, got ${total}; distinct=${distinct}; missingImmutable=${missing}; picksReady=${picksReady}.`
        );
      }

      await client.query("COMMIT");

      console.log(
        `RECOVERY: GW ${gameweek} immutable cohort committed successfully: ${recovered.length} managers.`
      );
    }catch(error){
      try{ await client.query("ROLLBACK"); }catch{}
      throw error;
    }finally{
      client.release();
    }

    /*
     * Only retire older cohorts AFTER the new cohort has been
     * successfully created and verified.
     */
    try{
      await pool.query(
        `DELETE FROM fpl_sample_managers WHERE gameweek < $1`,
        [gameweek]
      );

      console.log(
        `RECOVERY: retired cohorts older than GW ${gameweek}.`
      );
    }catch(cleanupError){
      console.error(
        "RECOVERY CLEANUP WARNING:",
        cleanupError.message
      );
    }

    console.log(
      `RECOVERY: GW ${gameweek} is locked and handed off to server.js for future snapshot refreshes.`
    );
  }catch(error){
    console.error(
      `RECOVERY FAILED for GW ${gameweek}:`,
      error.message
    );
  }
}
