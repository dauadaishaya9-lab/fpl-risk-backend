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
    recovered.push({managerId,lockedRank:Number(manager.last_rank),lockedTier:tierForRank(Number(manager.last_rank),totalManagers),managerName:manager.player_name||null,teamName:manager.entry_name||null,overallPointsAtLock:null,picks,activeChip:picksData.active_chip??null,captain:captain?Number(captain.element):null,tripleCaptain:triple?Number(triple.element):null});
    console.log(`GW ${gameweek} recovery ${band.name}: manager ${index + 1}/${selected.length} picks verified.`);
  }
  return recovered;
}

export async function recoverMissedSnapshot(){
  if(!pool)return;
  await ensureSchema();

  const bootstrap=await fetchJSON(FPL_URL,20000,{label:"FPL bootstrap during snapshot recovery"});
  const events=Array.isArray(bootstrap.events)?bootstrap.events:[];
  const current=events.find(event=>event.is_current===true);
  if(!current)return;

  const finished=events.filter(event=>event.finished===true&&event.data_checked===true&&event.deadline_time).sort((a,b)=>Number(b.id)-Number(a.id));
  const target=finished[0];
  if(!target)return;

  const season=seasonLabel();
  const complete=await pool.query(`SELECT 1 FROM fpl_gameweeks WHERE season=$1 AND status='complete' LIMIT 1`,[season]);
  if(complete.rowCount)return;

  const currentState=await pool.query(`SELECT status FROM fpl_gameweeks WHERE gameweek=$1`,[Number(current.id)]);
  const currentSamples=await pool.query(`SELECT 1 FROM fpl_sample_managers WHERE gameweek=$1 LIMIT 1`,[Number(current.id)]);
  if((currentState.rowCount&&['locking','locked'].includes(currentState.rows[0].status))||currentSamples.rowCount){
    console.log(`GW ${current.id} collection is already in progress; preserving the last published snapshot.`);
    return;
  }

  const targetState=await pool.query(`SELECT status FROM fpl_gameweeks WHERE gameweek=$1`,[Number(target.id)]);
  if(targetState.rowCount&&['locking','locked','complete'].includes(targetState.rows[0].status))return;

  const sampleRows=await pool.query(`SELECT 1 FROM fpl_sample_managers WHERE gameweek=$1 LIMIT 1`,[Number(target.id)]);
  if(sampleRows.rowCount)return;

  const deadline=new Date(target.deadline_time);
  if(!Number.isFinite(deadline.getTime())||deadline.getTime()>Date.now())return;

  console.log(`GW ${target.id} recovery: no published snapshot and no active current-GW collection; rebuilding the latest finished gameweek.`);
  const recovered=[];
  try {
    const bands=getBands(Number(bootstrap.total_players)||0);
    for(const band of bands){
      const rows=await recoverBand({band,season,gameweek:Number(target.id),totalManagers:Number(bootstrap.total_players)||0});
      if(rows.length<band.sampleSize)break;
      recovered.push(...rows);
      console.log(`GW ${target.id} recovery ${band.name}: ${rows.length}/${band.sampleSize} managers verified.`);
    }
    if(!recovered.length)throw new Error("No rank tier had enough managers to start the recovered snapshot.");

    await pool.query(`INSERT INTO fpl_gameweeks(gameweek,season,deadline,lock_time,total_managers,status,locked_at,picks_captured_at) VALUES($1,$2,$3,$4,$5,'complete',NOW(),NOW()) ON CONFLICT(gameweek) DO UPDATE SET season=EXCLUDED.season,deadline=EXCLUDED.deadline,lock_time=EXCLUDED.lock_time,total_managers=EXCLUDED.total_managers,status='complete',locked_at=COALESCE(fpl_gameweeks.locked_at,NOW()),picks_captured_at=COALESCE(fpl_gameweeks.picks_captured_at,NOW())`,[Number(target.id),season,deadline,new Date(deadline.getTime()-LOCK_HOURS_BEFORE_DEADLINE*60*60*1000),Number(bootstrap.total_players)||0]);

    for(const row of recovered){
      await pool.query(`INSERT INTO fpl_sample_managers(gameweek,manager_id,locked_rank,locked_tier,manager_name,team_name,overall_points_at_lock,picks,active_chip,captain,triple_captain,picks_captured_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()) ON CONFLICT(gameweek,manager_id) DO UPDATE SET locked_rank=EXCLUDED.locked_rank,locked_tier=EXCLUDED.locked_tier,manager_name=EXCLUDED.manager_name,team_name=EXCLUDED.team_name,overall_points_at_lock=EXCLUDED.overall_points_at_lock,picks=EXCLUDED.picks,active_chip=EXCLUDED.active_chip,captain=EXCLUDED.captain,triple_captain=EXCLUDED.triple_captain,picks_captured_at=NOW()`,[Number(target.id),row.managerId,row.lockedRank,row.lockedTier,row.managerName,row.teamName,row.overallPointsAtLock,JSON.stringify(row.picks),row.activeChip,row.captain,row.tripleCaptain]);
    }

    await pool.query(`DELETE FROM fpl_sample_managers WHERE gameweek < $1`,[Number(target.id)]);
    console.log(`GW ${target.id} RECOVERY COMPLETE: latest finished gameweek published as the new risk snapshot through the last complete tier.`);
  } catch(error) {
    await pool.query(`DELETE FROM fpl_sample_managers WHERE gameweek=$1`,[Number(target.id)]);
    await pool.query(`DELETE FROM fpl_gameweeks WHERE gameweek=$1 AND status='complete' AND picks_captured_at IS NOT NULL`,[Number(target.id)]);
    console.error(`GW ${target.id} recovery aborted; no snapshot published:`,error.message);
  }
}
