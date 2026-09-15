import pg from "pg";
import { deterministicRanks, standingsPageForRank, samplingBands, tierForRank } from "./sampling.js";
import { fetchJSON } from "./fpl-fetch.js";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const FPL_URL = "https://fantasy.premierleague.com/api/bootstrap-static/";
const ENTRY_URL = "https://fantasy.premierleague.com/api/entry/";
const STANDINGS_URL = "https://fantasy.premierleague.com/api/leagues-classic/314/standings/";
const LOCK_HOURS_BEFORE_DEADLINE = 1;
const FPL_CACHE_TTL = 2 * 60 * 1000;
const pool = DATABASE_URL ? new Pool({ connectionString:DATABASE_URL, ssl:{rejectUnauthorized:false}, max:5, idleTimeoutMillis:30000, connectionTimeoutMillis:10000 }) : null;
const runtime = { refreshing:false, lastRefreshAttempt:null, lastSuccessfulRefresh:null, lastError:null, nextScheduledRun:null };
let fplCache = { data:null, expiresAt:0 };
let schedulerStarted = false;
let schedulerTimer = null;

function getSeasonLabel(date=new Date()) { const year=date.getUTCMonth()>=6?date.getUTCFullYear():date.getUTCFullYear()-1; return `${year}/${String(year+1).slice(-2)}`; }
async function getFPLData() { const now=Date.now(); if(fplCache.data&&now<fplCache.expiresAt)return fplCache.data; const data=await fetchJSON(FPL_URL,20000,{label:"bootstrap-static"}); fplCache={data,expiresAt:now+FPL_CACHE_TTL}; return data; }
function getEvent(data,gameweek){ return data.events.find(event=>event.id===gameweek)||null; }
const STANDINGS_RETRY_DELAYS_MS = [60_000, 120_000, 180_000, 240_000, 300_000];

async function getStandingsPage(page){
  const maxAttempts=STANDINGS_RETRY_DELAYS_MS.length+1;
  let lastError=null;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{
      return await fetchJSON(`${STANDINGS_URL}?page_standings=${page}`,20000,{label:`standings page ${page}`});
    }catch(error){
      lastError=error;
      console.error(`Failed standings page ${page} attempt ${attempt}/${maxAttempts}:`,error.message);
      const delay=STANDINGS_RETRY_DELAYS_MS[attempt-1];
      if(delay!==undefined){
        console.log(`Waiting ${delay/1000}s before retrying standings page ${page}...`);
        await new Promise(resolve=>setTimeout(resolve,delay));
      }
    }
  }
  throw lastError;
}

async function getSampleManagersForBand(band,totalManagers,season,gameweek) {
  const maxRank=band.max===Infinity?totalManagers:Math.min(band.max,totalManagers); if(maxRank<band.min)return [];
  const ranks=deterministicRanks(`${season}+${gameweek}+${band.name}`,band.min,maxRank,band.sampleSize);
  const pages=new Map();
  for(const rank of ranks){ const page=standingsPageForRank(rank); if(pages.has(page))continue; try { const data=await getStandingsPage(page); pages.set(page,data.standings?.results||[]); } catch(error) { console.error(`Failed standings page ${page}:`,error.message); } }
  return ranks.map(requestedRank=>{ const page=standingsPageForRank(requestedRank); return pages.get(page)?.find(manager=>Number(manager.rank_sort)===requestedRank)||null; }).filter(Boolean);
}
async function getManagerPicks(managerId,gameweek){ return fetchJSON(`${ENTRY_URL}${managerId}/event/${gameweek}/picks/`,20000,{label:`manager ${managerId} GW ${gameweek} picks`}); }

async function initDatabase(){
  if(!pool)throw new Error("DATABASE_URL is not configured.");
  await pool.query(`CREATE TABLE IF NOT EXISTS fpl_gameweeks (gameweek INTEGER PRIMARY KEY, season TEXT NOT NULL, deadline TIMESTAMPTZ NOT NULL, lock_time TIMESTAMPTZ NOT NULL, total_managers INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', locked_at TIMESTAMPTZ, picks_captured_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()); CREATE TABLE IF NOT EXISTS fpl_sample_managers (gameweek INTEGER NOT NULL REFERENCES fpl_gameweeks(gameweek) ON DELETE CASCADE, manager_id INTEGER NOT NULL, locked_rank INTEGER NOT NULL, locked_tier TEXT NOT NULL, manager_name TEXT, team_name TEXT, overall_points_at_lock INTEGER, picks JSONB, active_chip TEXT, captain INTEGER, triple_captain INTEGER, picks_captured_at TIMESTAMPTZ, pick_attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(gameweek,manager_id)); ALTER TABLE fpl_sample_managers ADD COLUMN IF NOT EXISTS pick_attempts INTEGER NOT NULL DEFAULT 0; CREATE INDEX IF NOT EXISTS idx_sample_managers_gameweek_tier ON fpl_sample_managers(gameweek,locked_tier); CREATE INDEX IF NOT EXISTS idx_gameweeks_status_deadline ON fpl_gameweeks(status,deadline);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fpl_season_state (id INTEGER PRIMARY KEY CHECK (id=1), season TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', last_gw1_deadline TIMESTAMPTZ, gw38_completed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}
async function saveGameweekSchedule(fplData){
  const gw1=fplData.events.find(event=>Number(event.id)===1&&event.deadline_time);
  const state=await pool.query(`SELECT season,status,last_gw1_deadline FROM fpl_season_state WHERE id=1`);
  let season=getSeasonLabel(gw1?.deadline_time?new Date(gw1.deadline_time):new Date());
  if(state.rowCount&&state.rows[0].status==='awaiting_new_season'){
    if(!gw1)return false;
    const newGw1Deadline=new Date(gw1.deadline_time);
    const lastGw1Deadline=state.rows[0].last_gw1_deadline?new Date(state.rows[0].last_gw1_deadline):null;
    if(lastGw1Deadline&&!(newGw1Deadline>lastGw1Deadline))return false;
    season=getSeasonLabel(newGw1Deadline);
    await pool.query(`UPDATE fpl_season_state SET season=$1,status='active',last_gw1_deadline=$2,updated_at=NOW() WHERE id=1`,[season,newGw1Deadline]);
    console.log(`FPL NEW SEASON DETECTED: ${season} (GW1 deadline ${newGw1Deadline.toISOString()})`);
  } else if(state.rowCount&&state.rows[0].last_gw1_deadline&&gw1){
    const incomingGw1Deadline=new Date(gw1.deadline_time);
    if(incomingGw1Deadline>new Date(state.rows[0].last_gw1_deadline)){
      season=getSeasonLabel(incomingGw1Deadline);
      await pool.query(`UPDATE fpl_season_state SET season=$1,last_gw1_deadline=$2,updated_at=NOW() WHERE id=1`,[season,incomingGw1Deadline]);
    } else {
      season=state.rows[0].season;
    }
  } else if(state.rowCount){
    season=state.rows[0].season;
  } else {
    const initialGw1Deadline=gw1?new Date(gw1.deadline_time):null;
    await pool.query(`INSERT INTO fpl_season_state(id,season,status,last_gw1_deadline) VALUES(1,$1,'active',$2) ON CONFLICT(id) DO NOTHING`,[season,initialGw1Deadline]);
  }
  for(const event of fplData.events){ if(!event.deadline_time)continue; const deadline=new Date(event.deadline_time); const lockTime=new Date(deadline.getTime()-LOCK_HOURS_BEFORE_DEADLINE*60*60*1000); await pool.query(`INSERT INTO fpl_gameweeks(gameweek,season,deadline,lock_time,total_managers) VALUES($1,$2,$3,$4,$5) ON CONFLICT(gameweek) DO UPDATE SET season=EXCLUDED.season,deadline=EXCLUDED.deadline,lock_time=EXCLUDED.lock_time,total_managers=EXCLUDED.total_managers`,[event.id,season,deadline,lockTime,Number(fplData.total_players)||0]); }
  return true;
}

async function lockGameweekSamples(gameweek,fplData){
  const event=getEvent(fplData,gameweek);
  if(!event||!event.deadline_time)return false;

  const deadline=new Date(event.deadline_time);
  const lockTime=new Date(deadline.getTime()-LOCK_HOURS_BEFORE_DEADLINE*60*60*1000);
  if(Date.now()<lockTime.getTime())return false;

  const existing=await pool.query(
    `SELECT status FROM fpl_gameweeks WHERE gameweek=$1`,
    [gameweek]
  );

  if(!existing.rowCount||existing.rows[0].status!=="pending")return false;

  const existingCohort=await pool.query(
    `SELECT COUNT(*)::int AS manager_count
     FROM fpl_sample_managers
     WHERE gameweek=$1`,
    [gameweek]
  );

  if(Number(existingCohort.rows[0]?.manager_count||0)>0){
    console.log(`GW ${gameweek}: immutable cohort already exists; reusing stored manager IDs.`);
    return false;
  }

  const totalManagers=Number(fplData.total_players);
  if(!Number.isFinite(totalManagers)||totalManagers<=0){
    throw new Error("FPL total manager count is unavailable.");
  }

  const bands=samplingBands(totalManagers);
  const season=getSeasonLabel();
  const sampledManagers=[];
  let completedBands=0;

  for(const band of bands){
    const managers=await getSampleManagersForBand(
      band,
      totalManagers,
      season,
      gameweek
    );

    if(managers.length<band.sampleSize){
      console.log(
        `GW ${gameweek} band ${band.name}: only found ${managers.length}/${band.sampleSize} managers. Skipping this band (nothing saved for it); every other successful band will still be locked, and the calculator will fall back to the nearest successful band below it.`
      );
      continue;
    }

    sampledManagers.push(...managers.map(manager=>({
      manager,
      lockedRank:Number(manager.rank_sort),
      lockedTier:tierForRank(Number(manager.rank_sort),totalManagers)?.name||null
    })).filter(row=>row.lockedTier));

    completedBands++;
    console.log(
      `GW ${gameweek} band ${band.name}: sampled ${managers.length}/${band.sampleSize} managers`
    );
  }

  if(completedBands===0){
    console.log(`GW ${gameweek}: no rank tier had enough managers; lock attempt aborted.`);
    return false;
  }

  const client=await pool.connect();

  try{
    await client.query("BEGIN");

    const current=await client.query(
      `SELECT status FROM fpl_gameweeks WHERE gameweek=$1 FOR UPDATE`,
      [gameweek]
    );

    if(!current.rowCount||current.rows[0].status!=="pending"){
      await client.query("ROLLBACK");
      return false;
    }

    for(const row of sampledManagers){
      const manager=row.manager;
      await client.query(
        `INSERT INTO fpl_sample_managers(
          gameweek,
          manager_id,
          locked_rank,
          locked_tier,
          manager_name,
          team_name,
          overall_points_at_lock
        )
        VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(gameweek,manager_id) DO NOTHING`,
        [
          gameweek,
          Number(manager.entry),
          row.lockedRank,
          row.lockedTier,
          manager.player_name||null,
          manager.entry_name||null,
          Number(manager.total)||0
        ]
      );
    }

    await client.query(
      `UPDATE fpl_gameweeks
       SET status='locked',
           locked_at=NOW()
       WHERE gameweek=$1`,
      [gameweek]
    );

    await client.query("COMMIT");

    console.log(
      `GW ${gameweek} SAMPLE LOCK COMPLETE THROUGH TIER ${completedBands}/${bands.length}; cohort=${sampledManagers.length}`
    );

    return true;
  }catch(error){
    try{
      await client.query("ROLLBACK");
    }catch(rollbackError){
      console.error(`GW ${gameweek}: rollback failed:`,rollbackError.message);
    }
    throw error;
  }finally{
    client.release();
  }
}
async function captureGameweekPicks(gameweek){
  const row=await pool.query(
    `SELECT status,deadline,picks_captured_at
     FROM fpl_gameweeks
     WHERE gameweek=$1`,
    [gameweek]
  );

  if(!row.rowCount||!["locked","complete"].includes(row.rows[0].status))return false;

  const currentStatus=row.rows[0].status;


  const isInitialCapture=currentStatus==="locked";


  const deadline=new Date(row.rows[0].deadline);


  if(Date.now()<deadline.getTime())return false;

  // Once a manager has a valid picks snapshot for this gameweek, FPL itself
  // locks their picks - there is nothing to "re-check" for them. So each
  // cycle only chases managers who are still missing a snapshot. A manager
  // who fails never affects any other manager, and never loses data they
  // already have.
  const managers=await pool.query(
    `SELECT manager_id,locked_rank
     FROM fpl_sample_managers
     WHERE gameweek=$1
       AND picks IS NULL
     ORDER BY locked_rank ASC`,
    [gameweek]
  );

  if(!managers.rowCount){
    // Everyone already has valid picks. Nothing to do, but bump the
    // timestamp so we don't check again until the next full cycle.
    await pool.query(
      `UPDATE fpl_gameweeks SET picks_captured_at=NOW() WHERE gameweek=$1`,
      [gameweek]
    );
    return false;
  }

  let successCount=0;

  for(const manager of managers.rows){
    try{
      const data=await getManagerPicks(manager.manager_id,gameweek);
      const picks=Array.isArray(data.picks)?data.picks:[];

      if(picks.length!==15){
        throw new Error(`Expected 15 picks, received ${picks.length}`);
      }

      const captain=picks.find(p=>p.is_captain===true);
      const triple=picks.find(p=>p.is_captain===true&&Number(p.multiplier)===3);

      await pool.query(
        `UPDATE fpl_sample_managers
         SET picks=$1,
             active_chip=$2,
             captain=$3,
             triple_captain=$4,
             picks_captured_at=NOW(),
             pick_attempts=0
         WHERE gameweek=$5
           AND manager_id=$6`,
        [
          JSON.stringify(picks),
          data.active_chip??null,
          captain?Number(captain.element):null,
          triple?Number(triple.element):null,
          gameweek,
          manager.manager_id
        ]
      );

      successCount++;

    }catch(error){
      console.error(
        `GW ${gameweek} manager ${manager.manager_id} picks failed:`,
        error.message
      );
      await pool.query(
        `UPDATE fpl_sample_managers
         SET pick_attempts=pick_attempts+1
         WHERE gameweek=$1
           AND manager_id=$2`,
        [gameweek,manager.manager_id]
      );
    }
  }

  if(successCount===0){
    console.log(
      `GW ${gameweek}: no new picks captured this cycle (${managers.rowCount} manager(s) still pending); will retry next cycle.`
    );
    return false;
  }

  await pool.query(
    `UPDATE fpl_gameweeks
     SET picks_captured_at=NOW(),
         status='complete'
     WHERE gameweek=$1`,
    [gameweek]
  );

  console.log(
    `GW ${gameweek}: ${isInitialCapture?"created":"refreshed"} snapshot for ${successCount} manager(s); ${managers.rowCount-successCount} still pending.`
  );

  if(isInitialCapture){
      await completeGameweekAndRetireOld(gameweek);
    }
    return true;
}

async function completeGameweekAndRetireOld(gameweek){
  await pool.query(`UPDATE fpl_gameweeks SET status='complete',picks_captured_at=COALESCE(picks_captured_at,NOW()) WHERE gameweek=$1`,[gameweek]);
  if(Number(gameweek)===38){
    const seasonRow=await pool.query(`SELECT season,deadline FROM fpl_gameweeks WHERE gameweek=38`);
    const completedSeason=seasonRow.rows[0]?.season||getSeasonLabel();
    const gw1Row=await pool.query(`SELECT deadline FROM fpl_gameweeks WHERE gameweek=1`);
    await pool.query(`DELETE FROM fpl_gameweeks`);
    await pool.query(`INSERT INTO fpl_season_state(id,season,status,last_gw1_deadline,gw38_completed_at,updated_at) VALUES(1,$1,'awaiting_new_season',$2,NOW(),NOW()) ON CONFLICT(id) DO UPDATE SET season=EXCLUDED.season,status='awaiting_new_season',last_gw1_deadline=EXCLUDED.last_gw1_deadline,gw38_completed_at=NOW(),updated_at=NOW()`,[completedSeason,gw1Row.rows[0]?.deadline||null]);
    console.log(`GW 38 COMPLETE: cleared all previous fpl_gameweeks and fpl_sample_managers; waiting for the actual next-season GW1 deadline.`);
    return;
  }
  await pool.query(`DELETE FROM fpl_sample_managers WHERE gameweek < $1`,[gameweek]);
}

function clearSchedulerTimer(){ if(schedulerTimer){clearTimeout(schedulerTimer);schedulerTimer=null;} runtime.nextScheduledRun=null; }

export function getSchedulerHealth(){
  const now=Date.now();
  const next=runtime.nextScheduledRun ? new Date(runtime.nextScheduledRun).getTime() : null;
  const lastAttempt=runtime.lastRefreshAttempt ? new Date(runtime.lastRefreshAttempt).getTime() : null;
  const lastSuccess=runtime.lastSuccessfulRefresh ? new Date(runtime.lastSuccessfulRefresh).getTime() : null;

  if(!schedulerStarted){
    return {healthy:false,reason:"scheduler_not_started",refreshing:runtime.refreshing,nextScheduledRun:runtime.nextScheduledRun,lastRefreshAttempt:runtime.lastRefreshAttempt,lastSuccessfulRefresh:runtime.lastSuccessfulRefresh,lastError:runtime.lastError};
  }

  if(runtime.refreshing){
    const refreshAge=lastAttempt===null ? Infinity : now-lastAttempt;
    const healthy=refreshAge <= 30*60*1000;
    return {healthy,reason:healthy?"refresh_in_progress":"refresh_stuck",refreshing:true,nextScheduledRun:runtime.nextScheduledRun,lastRefreshAttempt:runtime.lastRefreshAttempt,lastSuccessfulRefresh:runtime.lastSuccessfulRefresh,lastError:runtime.lastError};
  }

  if(next!==null){
    const overdue=now-next;
    const healthy=overdue <= 15*60*1000;
    return {healthy,reason:healthy?"scheduled":"schedule_overdue",refreshing:false,nextScheduledRun:runtime.nextScheduledRun,lastRefreshAttempt:runtime.lastRefreshAttempt,lastSuccessfulRefresh:runtime.lastSuccessfulRefresh,lastError:runtime.lastError};
  }

  const successAge=lastSuccess===null ? Infinity : now-lastSuccess;
  const healthy=successAge <= 30*60*1000;
  return {healthy,reason:healthy?"recently_completed":"no_active_schedule",refreshing:false,nextScheduledRun:null,lastRefreshAttempt:runtime.lastRefreshAttempt,lastSuccessfulRefresh:runtime.lastSuccessfulRefresh,lastError:runtime.lastError};
}
async function scheduleNextRun(currentGameweek){
  if(!pool||!schedulerStarted)return;
  clearSchedulerTimer();
  try{
    if(!Number.isFinite(Number(currentGameweek)))return;
    const result=await pool.query(`SELECT gameweek,status,lock_time,deadline,picks_captured_at,
CASE
  WHEN status='pending' AND deadline <= NOW() THEN NOW() + INTERVAL '15 minutes'
  WHEN status='pending' THEN lock_time
  WHEN picks_captured_at IS NULL THEN deadline
  ELSE GREATEST(
    picks_captured_at + INTERVAL '7 days',
    NOW() + INTERVAL '15 minutes'
  )
  END AS run_at
FROM fpl_gameweeks
WHERE gameweek=$1
  AND (
    (status='pending' AND deadline > NOW())
    OR
    (status='pending' AND deadline <= NOW())
    OR
    (status='locked' AND deadline <= NOW() AND picks_captured_at IS NULL)
    OR
    (status='complete' AND picks_captured_at IS NOT NULL
      AND picks_captured_at + INTERVAL '7 days' <= NOW())
  )
ORDER BY
  CASE
    WHEN status='pending' AND deadline <= NOW() THEN 0
    ELSE 1
  END,
  run_at ASC
LIMIT 1`,[Number(currentGameweek)]);
    if(!result.rowCount)return;
    const row=result.rows[0];
    const target=new Date(row.run_at).getTime();
    const now=Date.now();
    const delay=Math.max(1000,Math.min(target-now,2147483647));
    const scheduledAt=new Date(now+delay);
    runtime.nextScheduledRun=scheduledAt.toISOString();
    console.log(`SCHEDULER: next GW ${row.gameweek} ${row.status} run scheduled for ${scheduledAt.toISOString()}`);
    schedulerTimer=setTimeout(()=>{schedulerTimer=null;refreshScheduler().catch(error=>console.error("BACKGROUND SCHEDULER FAILED:",error.message));},delay);
  }catch(error){
    runtime.lastError=error.message;
    console.error("SCHEDULER NEXT-RUN CALCULATION FAILED:",error.message);
  }
}
export async function refreshScheduler(){
  if(runtime.refreshing||!pool)return;
  runtime.refreshing=true;
  runtime.lastRefreshAttempt=new Date().toISOString();
  let currentEvent=null;
  try{
    const fplData=await getFPLData();
    const scheduleReady=await saveGameweekSchedule(fplData);
    if(!scheduleReady){
      console.log("SCHEDULER: schedule persistence not ready; continuing existing snapshot processing.");
    }
    currentEvent=fplData.events.find(event=>event.is_current===true)||fplData.events.find(event=>event.deadline_time&&!event.finished)||null;
    for(const event of fplData.events){
      if(!event.deadline_time)continue;
      const deadline=new Date(event.deadline_time);
      const lockTime=new Date(deadline.getTime()-LOCK_HOURS_BEFORE_DEADLINE*60*60*1000);
      const isLateCurrentGameweek=currentEvent&&Number(currentEvent.id)===Number(event.id)&&Date.now()>=deadline.getTime();
      if((Date.now()>=lockTime.getTime()&&Date.now()<deadline.getTime())||isLateCurrentGameweek){
        try{
          await lockGameweekSamples(event.id,fplData);
        }catch(error){
          console.error(`GW ${event.id} LOCK FAILED:`,error.message);
        }
      }
    }
    const currentGameweek=Number(currentEvent?.id);
    const locked=Number.isFinite(currentGameweek)
      ? await pool.query(`SELECT gameweek,deadline,picks_captured_at
FROM fpl_gameweeks
WHERE gameweek=$1
  AND deadline <= NOW()
  AND (
    (status='locked' AND picks_captured_at IS NULL)
    OR
    (status='complete' AND picks_captured_at IS NOT NULL
      AND picks_captured_at + INTERVAL '7 days' <= NOW())
  )
ORDER BY COALESCE(picks_captured_at,deadline) ASC`,[currentGameweek])
      : {rows:[]};
    for(const row of locked.rows){
      try{await captureGameweekPicks(row.gameweek);}catch(error){console.error(`GW ${row.gameweek} PICK CAPTURE FAILED:`,error.message);}
    }
    runtime.lastSuccessfulRefresh=new Date().toISOString();
    runtime.lastError=null;
  }catch(error){
    runtime.lastError=error.message;
    console.error("SCHEDULER FAILED:",error.message);
  }finally{
    runtime.refreshing=false;
    await scheduleNextRun(currentEvent?.id);
  }
}
export function startScheduler(){ if(schedulerStarted||!pool)return; schedulerStarted=true; refreshScheduler().catch(error=>console.error("BACKGROUND SCHEDULER FAILED:",error.message)); }

async function relabelMismatchedTiers(){
  if(!pool)return;
  const gws=await pool.query(`SELECT gameweek,total_managers FROM fpl_gameweeks WHERE status IN ('locked','complete')`);
  let totalFixed=0;
  for(const gw of gws.rows){
    const totalManagers=Number(gw.total_managers);
    const managers=await pool.query(`SELECT manager_id,locked_rank,locked_tier FROM fpl_sample_managers WHERE gameweek=$1`,[gw.gameweek]);
    for(const row of managers.rows){
      const correct=tierForRank(Number(row.locked_rank),totalManagers);
      if(correct&&correct.name!==row.locked_tier){
        await pool.query(`UPDATE fpl_sample_managers SET locked_tier=$1 WHERE gameweek=$2 AND manager_id=$3`,[correct.name,gw.gameweek,row.manager_id]);
        totalFixed++;
      }
    }
  }
  if(totalFixed>0){
    console.log(`[SELF-HEAL] Relabeled ${totalFixed} manager row(s) to match the current tier rules.`);
  }else{
    console.log("[SELF-HEAL] All stored tier labels already match the current rules.");
  }
}
async function start(){
  console.log(`Background scheduler module starting (no internal HTTP server; routes are served directly by security-proxy-v4.js).`);
  console.log(`Sample lock policy: ${LOCK_HOURS_BEFORE_DEADLINE} hour before deadline.`);
  console.log(`FPL bootstrap cache TTL: ${FPL_CACHE_TTL/1000}s.`);
  if(pool){
    try{
      await initDatabase();
      console.log("PostgreSQL connected and schema ready.");
      await relabelMismatchedTiers();
      startScheduler();
    }catch(error){
      runtime.lastError=error.message;
      console.error("DATABASE STARTUP FAILED:",error.message);
      throw error;
    }
  }else{
    const error=new Error("DATABASE_URL is missing. PostgreSQL persistence is disabled.");
    runtime.lastError=error.message;
    console.error(error.message);
    throw error;
  }
}

export const readyPromise=start();
