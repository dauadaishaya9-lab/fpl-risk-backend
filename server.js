import http from "node:http";
import pg from "pg";
import { deterministicRanks, standingsPageForRank } from "./sampling.js";

const { Pool } = pg;
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const FPL_URL = "https://fantasy.premierleague.com/api/bootstrap-static/";
const ENTRY_URL = "https://fantasy.premierleague.com/api/entry/";
const STANDINGS_URL = "https://fantasy.premierleague.com/api/leagues-classic/314/standings/";
const REFRESH_INTERVAL = 5 * 60 * 1000;
const LOCK_HOURS_BEFORE_DEADLINE = 1;
const FPL_CACHE_TTL = 2 * 60 * 1000;
const FIXED_BANDS = [
  { name:"1-10000", min:1, max:10000, sampleSize:10 },
  { name:"10001-50000", min:10001, max:50000, sampleSize:15 },
  { name:"50001-100000", min:50001, max:100000, sampleSize:20 },
  { name:"100001-250000", min:100001, max:250000, sampleSize:25 },
  { name:"250001-500000", min:250001, max:500000, sampleSize:30 },
  { name:"500001-1000000", min:500001, max:1000000, sampleSize:35 }
];
const MILLION_BAND_START = 1000001;
const MILLION_BAND_SIZE = 1000000;
const MILLION_BAND_SAMPLE_SIZE = 60;
const pool = DATABASE_URL ? new Pool({ connectionString:DATABASE_URL, ssl:{rejectUnauthorized:false}, max:5, idleTimeoutMillis:30000, connectionTimeoutMillis:10000 }) : null;
const runtime = { refreshing:false, lastRefreshAttempt:null, lastSuccessfulRefresh:null, lastError:null };
let fplCache = { data:null, expiresAt:0 };

function getSeasonLabel(date=new Date()) { const year=date.getUTCMonth()>=6?date.getUTCFullYear():date.getUTCFullYear()-1; return `${year}/${String(year+1).slice(-2)}`; }
function getSamplingBands(totalManagers) {
  const total = Math.max(0, Math.floor(Number(totalManagers)||0));
  const bands = FIXED_BANDS.map(b => ({...b}));
  if (total >= MILLION_BAND_START) {
    for (let min=MILLION_BAND_START; min<=total; min+=MILLION_BAND_SIZE) {
      const max=Math.min(min+MILLION_BAND_SIZE-1,total);
      bands.push({name:`${min}-${max}`,min,max,sampleSize:Math.min(MILLION_BAND_SAMPLE_SIZE,max-min+1)});
    }
  }
  return bands;
}
function sendJSON(res,status,data,extraHeaders={}) { res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...extraHeaders}); res.end(JSON.stringify(data)); }
async function fetchJSON(url,timeoutMs=15000) { const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),timeoutMs); try { const response=await fetch(url,{signal:controller.signal,headers:{"User-Agent":"FPL-Risk-Calculator/1.0"}}); if(!response.ok) throw new Error(`HTTP ${response.status}`); return await response.json(); } finally { clearTimeout(timeout); } }
async function getFPLData() { const now=Date.now(); if(fplCache.data&&now<fplCache.expiresAt)return fplCache.data; const data=await fetchJSON(FPL_URL,20000); fplCache={data,expiresAt:now+FPL_CACHE_TTL}; return data; }
function getEvent(data,gameweek){ return data.events.find(event=>event.id===gameweek)||null; }
async function getStandingsPage(page){ return fetchJSON(`${STANDINGS_URL}?page_standings=${page}`); }

async function getSampleManagersForBand(band,totalManagers,season,gameweek) {
  const maxRank=band.max===Infinity?totalManagers:Math.min(band.max,totalManagers); if(maxRank<band.min)return [];
  const ranks=deterministicRanks(`${season}+${gameweek}+${band.name}`,band.min,maxRank,band.sampleSize);
  const pages=new Map();
  for(const rank of ranks){ const page=standingsPageForRank(rank); if(pages.has(page))continue; try { const data=await getStandingsPage(page); pages.set(page,data.standings?.results||[]); } catch(error) { console.error(`Failed standings page ${page}:`,error.message); } }
  return ranks.map(requestedRank=>{ const page=standingsPageForRank(requestedRank); return pages.get(page)?.find(manager=>Number(manager.rank_sort)===requestedRank)||null; }).filter(Boolean);
}
async function getManagerPicks(managerId,gameweek){ return fetchJSON(`${ENTRY_URL}${managerId}/event/${gameweek}/picks/`,20000); }

async function initDatabase(){
  if(!pool)throw new Error("DATABASE_URL is not configured.");
  await pool.query(`CREATE TABLE IF NOT EXISTS fpl_gameweeks (gameweek INTEGER PRIMARY KEY, season TEXT NOT NULL, deadline TIMESTAMPTZ NOT NULL, lock_time TIMESTAMPTZ NOT NULL, total_managers INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', locked_at TIMESTAMPTZ, picks_captured_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()); CREATE TABLE IF NOT EXISTS fpl_sample_managers (gameweek INTEGER NOT NULL REFERENCES fpl_gameweeks(gameweek) ON DELETE CASCADE, manager_id INTEGER NOT NULL, locked_rank INTEGER NOT NULL, locked_tier TEXT NOT NULL, manager_name TEXT, team_name TEXT, overall_points_at_lock INTEGER, picks JSONB, active_chip TEXT, captain INTEGER, triple_captain INTEGER, picks_captured_at TIMESTAMPTZ, pick_attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(gameweek,manager_id)); ALTER TABLE fpl_sample_managers ADD COLUMN IF NOT EXISTS pick_attempts INTEGER NOT NULL DEFAULT 0; CREATE INDEX IF NOT EXISTS idx_sample_managers_gameweek_tier ON fpl_sample_managers(gameweek,locked_tier); CREATE INDEX IF NOT EXISTS idx_gameweeks_status_deadline ON fpl_gameweeks(status,deadline);`);
}
async function saveGameweekSchedule(fplData){ const season=getSeasonLabel(); for(const event of fplData.events){ if(!event.deadline_time)continue; const deadline=new Date(event.deadline_time); const lockTime=new Date(deadline.getTime()-LOCK_HOURS_BEFORE_DEADLINE*60*60*1000); await pool.query(`INSERT INTO fpl_gameweeks(gameweek,season,deadline,lock_time,total_managers) VALUES($1,$2,$3,$4,$5) ON CONFLICT(gameweek) DO UPDATE SET season=EXCLUDED.season,deadline=EXCLUDED.deadline,lock_time=EXCLUDED.lock_time,total_managers=EXCLUDED.total_managers`,[event.id,season,deadline,lockTime,Number(fplData.total_players)||0]); } }
function getRankTier(rank,totalManagers){ return getSamplingBands(totalManagers).find(b=>rank>=b.min&&rank<=b.max)?.name||null; }

async function lockGameweekSamples(gameweek,fplData){
  const event=getEvent(fplData,gameweek); if(!event||!event.deadline_time)return false; const deadline=new Date(event.deadline_time); const lockTime=new Date(deadline.getTime()-LOCK_HOURS_BEFORE_DEADLINE*60*60*1000); if(Date.now()<lockTime.getTime()||Date.now()>=deadline.getTime())return false;
  const existing=await pool.query(`SELECT status FROM fpl_gameweeks WHERE gameweek=$1`,[gameweek]); if(!existing.rowCount||existing.rows[0].status!=="pending")return false;
  const totalManagers=Number(fplData.total_players); if(!Number.isFinite(totalManagers)||totalManagers<=0)throw new Error("FPL total manager count is unavailable.");
  const bands=getSamplingBands(totalManagers); const season=getSeasonLabel(); await pool.query(`UPDATE fpl_gameweeks SET status='locking',locked_at=NOW() WHERE gameweek=$1`,[gameweek]);
  try {
    for(const band of bands){ const managers=await getSampleManagersForBand(band,totalManagers,season,gameweek); for(const manager of managers){ const lockedRank=Number(manager.rank); const lockedTier=getRankTier(lockedRank,totalManagers); if(!lockedTier)continue; await pool.query(`INSERT INTO fpl_sample_managers(gameweek,manager_id,locked_rank,locked_tier,manager_name,team_name,overall_points_at_lock) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(gameweek,manager_id) DO NOTHING`,[gameweek,Number(manager.entry),lockedRank,lockedTier,manager.player_name||null,manager.entry_name||null,Number(manager.total)||0]); } console.log(`GW ${gameweek} band ${band.name}: locked ${managers.length}/${band.sampleSize} managers`); }
    const counts=await pool.query(`SELECT locked_tier,COUNT(*)::int AS count FROM fpl_sample_managers WHERE gameweek=$1 GROUP BY locked_tier`,[gameweek]); const countMap=new Map(counts.rows.map(r=>[r.locked_tier,r.count])); const missing=bands.filter(b=>(countMap.get(b.name)||0)<b.sampleSize); if(missing.length)throw new Error(`Could not lock the full requested sample for: ${missing.map(b=>b.name).join(", ")}`);
    await pool.query(`UPDATE fpl_gameweeks SET status='locked' WHERE gameweek=$1`,[gameweek]); console.log(`GW ${gameweek} SAMPLE LOCK COMPLETE`); return true;
  } catch(error){ await pool.query(`DELETE FROM fpl_sample_managers WHERE gameweek=$1`,[gameweek]); await pool.query(`UPDATE fpl_gameweeks SET status='pending',locked_at=NULL WHERE gameweek=$1`,[gameweek]); throw error; }
}

async function captureGameweekPicks(gameweek){
  const row=await pool.query(`SELECT status,deadline FROM fpl_gameweeks WHERE gameweek=$1`,[gameweek]); if(!row.rowCount||row.rows[0].status!=="locked")return false; if(Date.now()<new Date(row.rows[0].deadline).getTime())return false;
  const managers=await pool.query(`SELECT manager_id FROM fpl_sample_managers WHERE gameweek=$1 AND picks IS NULL AND pick_attempts<6 ORDER BY locked_rank ASC`,[gameweek]);
  if(!managers.rowCount){ const remaining=await pool.query(`SELECT COUNT(*)::int AS count FROM fpl_sample_managers WHERE gameweek=$1 AND picks IS NULL`,[gameweek]); if(remaining.rows[0].count===0){ await completeGameweekAndRetireOld(gameweek); return true; } const quality=await pool.query(`SELECT locked_tier,COUNT(*) FILTER(WHERE picks IS NOT NULL)::int AS successful FROM fpl_sample_managers WHERE gameweek=$1 GROUP BY locked_tier`,[gameweek]); const totalRow=await pool.query(`SELECT total_managers FROM fpl_gameweeks WHERE gameweek=$1`,[gameweek]); const bands=getSamplingBands(totalRow.rows[0]?.total_managers); const qualityMap=new Map(quality.rows.map(r=>[r.locked_tier,r.successful])); const acceptable=bands.every(b=>(qualityMap.get(b.name)||0)>=Math.ceil(b.sampleSize*0.8)); if(acceptable){ await completeGameweekAndRetireOld(gameweek); console.log(`GW ${gameweek} PICKS CAPTURE COMPLETE WITH PARTIAL SAMPLE`); return true; } return false; }
  for(const manager of managers.rows){ await pool.query(`UPDATE fpl_sample_managers SET pick_attempts=pick_attempts+1 WHERE gameweek=$1 AND manager_id=$2`,[gameweek,manager.manager_id]); try{ const data=await getManagerPicks(manager.manager_id,gameweek); const picks=Array.isArray(data.picks)?data.picks:[]; const captain=picks.find(p=>p.is_captain===true); const triple=picks.find(p=>p.is_captain===true&&Number(p.multiplier)===3); if(picks.length!==15)throw new Error(`Expected 15 picks, received ${picks.length}`); await pool.query(`UPDATE fpl_sample_managers SET picks=$1,active_chip=$2,captain=$3,triple_captain=$4,picks_captured_at=NOW() WHERE gameweek=$5 AND manager_id=$6`,[JSON.stringify(picks),data.active_chip??null,captain?Number(captain.element):null,triple?Number(triple.element):null,gameweek,manager.manager_id]); }catch(error){ console.error(`GW ${gameweek} manager ${manager.manager_id} picks failed:`,error.message); } }
  const remaining=await pool.query(`SELECT COUNT(*)::int AS count FROM fpl_sample_managers WHERE gameweek=$1 AND picks IS NULL`,[gameweek]); if(remaining.rows[0].count===0)await completeGameweekAndRetireOld(gameweek); return true;
}
async function completeGameweekAndRetireOld(gameweek){
  await pool.query(`UPDATE fpl_gameweeks SET status='complete',picks_captured_at=COALESCE(picks_captured_at,NOW()) WHERE gameweek=$1`,[gameweek]);
  await pool.query(`DELETE FROM fpl_sample_managers WHERE gameweek < $1`,[gameweek]);
}

function buildBandFromRows(band,rows){
  const ownership={},captaincy={},tripleCaptaincy={},managers=[]; for(const row of rows){ if(!Array.isArray(row.picks))continue; const picks=row.picks; const captain=picks.find(p=>p.is_captain===true); const triple=picks.find(p=>p.is_captain===true&&Number(p.multiplier)===3); for(const pick of picks){const id=String(pick.element); ownership[id]=(ownership[id]||0)+1;} if(captain){const id=String(captain.element);captaincy[id]=(captaincy[id]||0)+1;} if(triple){const id=String(triple.element);tripleCaptaincy[id]=(tripleCaptaincy[id]||0)+1;} managers.push({rank:row.locked_rank,managerId:row.manager_id,managerName:row.manager_name,teamName:row.team_name,overallPoints:row.overall_points_at_lock,lockedTier:band.name,activeChip:row.active_chip,captain:row.captain,tripleCaptain:row.triple_captain,picks}); }
  const n=managers.length; const pct=counts=>Object.fromEntries(Object.entries(counts).map(([id,c])=>[id,n?Number((c/n*100).toFixed(1)):0])); return {band:band.name,rankRange:{min:band.min,max:band.max},requestedSampleSize:band.sampleSize,successfulSampleSize:n,managers,ownership,ownershipPercent:pct(ownership),captaincy,captaincyPercent:pct(captaincy),tripleCaptaincy,tripleCaptainPercent:pct(tripleCaptaincy)};
}
async function getCompletedRiskData(){ const r=await pool.query(`SELECT gameweek,season,total_managers,created_at FROM fpl_gameweeks WHERE status='complete' ORDER BY gameweek DESC LIMIT 1`); if(!r.rowCount)return null; const gw=r.rows[0]; const bands=getSamplingBands(gw.total_managers); const rows=await pool.query(`SELECT gameweek,manager_id,locked_rank,locked_tier,manager_name,team_name,overall_points_at_lock,picks,active_chip,captain,triple_captain FROM fpl_sample_managers WHERE gameweek=$1 AND picks IS NOT NULL ORDER BY locked_rank ASC`,[gw.gameweek]); return {season:gw.season,gameweek:gw.gameweek,totalManagers:gw.total_managers,bands:bands.map(b=>buildBandFromRows(b,rows.rows.filter(r=>r.locked_rank>=b.min&&r.locked_rank<=b.max))),createdAt:gw.created_at,samplingPolicy:{lockHoursBeforeDeadline:LOCK_HOURS_BEFORE_DEADLINE,rankSource:"overall standings at lock time",picksSource:"manager GW picks after deadline",sampling:"deterministic random rank positions; 60 managers per million-rank band from 1,000,001 onward; final band ends at current FPL total managers"}}; }
async function refreshScheduler(){ if(runtime.refreshing||!pool)return; runtime.refreshing=true; runtime.lastRefreshAttempt=new Date().toISOString(); try{ const fplData=await getFPLData(); await saveGameweekSchedule(fplData); for(const event of fplData.events){ if(!event.deadline_time)continue; const deadline=new Date(event.deadline_time); const lockTime=new Date(deadline.getTime()-LOCK_HOURS_BEFORE_DEADLINE*60*60*1000); if(Date.now()>=lockTime.getTime()&&Date.now()<deadline.getTime()){try{await lockGameweekSamples(event.id,fplData);}catch(error){console.error(`GW ${event.id} LOCK FAILED:`,error.message);}} } const locked=await pool.query(`SELECT gameweek FROM fpl_gameweeks WHERE status='locked' AND deadline<=NOW() ORDER BY gameweek ASC`); for(const row of locked.rows){try{await captureGameweekPicks(row.gameweek);}catch(error){console.error(`GW ${row.gameweek} PICK CAPTURE FAILED:`,error.message);}} runtime.lastSuccessfulRefresh=new Date().toISOString();runtime.lastError=null; }catch(error){runtime.lastError=error.message;console.error("SCHEDULER FAILED:",error.message);}finally{runtime.refreshing=false;} }
const server=http.createServer(async(req,res)=>{ const url=new URL(req.url,`http://${req.headers.host||"localhost"}`); if(req.method!=="GET"){sendJSON(res,405,{error:"Method not allowed"},{Allow:"GET"});return;} if(url.pathname==="/"){let databaseReady=false;try{if(pool){await pool.query("SELECT 1");databaseReady=true;}}catch{} sendJSON(res,200,{status:"ok",databaseConfigured:Boolean(pool),databaseReady,refreshing:runtime.refreshing,lastRefreshAttempt:runtime.lastRefreshAttempt,lastSuccessfulRefresh:runtime.lastSuccessfulRefresh,lastError:runtime.lastError,lockHoursBeforeDeadline:LOCK_HOURS_BEFORE_DEADLINE});return;} if(url.pathname==="/api/sample-tiers"){try{const result=await getCompletedRiskData();if(!result){sendJSON(res,503,{error:"No completed locked sample is ready yet."});return;}sendJSON(res,200,result);}catch(error){sendJSON(res,500,{error:"Could not load risk data.",details:error.message});}return;} if(url.pathname==="/api/cache"){if(!pool){sendJSON(res,503,{error:"PostgreSQL is not configured."});return;}try{const result=await pool.query(`SELECT gameweek,season,status,deadline,lock_time,locked_at,picks_captured_at,total_managers FROM fpl_gameweeks ORDER BY gameweek DESC`);sendJSON(res,200,{lockHoursBeforeDeadline:LOCK_HOURS_BEFORE_DEADLINE,gameweeks:result.rows,scheduler:runtime});}catch(error){sendJSON(res,500,{error:error.message});}return;} if(url.pathname.startsWith("/api/entry/")){const entryId=url.pathname.split("/api/entry/")[1];if(!entryId||!/^[0-9]+$/.test(entryId)){sendJSON(res,400,{error:"Invalid FPL ID"});return;}try{const data=await fetchJSON(`${ENTRY_URL}${entryId}/`);sendJSON(res,200,{id:data.id,playerName:`${data.player_first_name} ${data.player_last_name}`,teamName:data.name,overallRank:data.summary_overall_rank,overallPoints:data.summary_overall_points});}catch(error){sendJSON(res,502,{error:"Could not fetch FPL entry",details:error.message});}return;} if(url.pathname==="/api/fpl"){try{sendJSON(res,200,await getFPLData(),{"Cache-Control":"public, max-age=60"});}catch(error){sendJSON(res,502,{error:error.message});}return;} sendJSON(res,404,{error:"Not found"}); });
async function start(){
  server.listen(PORT,"127.0.0.1",()=>{console.log(`Internal backend listening on loopback port ${PORT}; scheduler will initialize in background.`);console.log(`Sample lock policy: ${LOCK_HOURS_BEFORE_DEADLINE} hour before deadline.`);console.log(`FPL bootstrap cache TTL: ${FPL_CACHE_TTL/1000}s.`);});
  if(pool){try{await initDatabase();console.log("PostgreSQL connected and schema ready.");refreshScheduler().catch(error=>console.error("BACKGROUND SCHEDULER FAILED:",error.message));setInterval(()=>refreshScheduler().catch(error=>console.error("BACKGROUND SCHEDULER FAILED:",error.message)),REFRESH_INTERVAL);}catch(error){runtime.lastError=error.message;console.error("DATABASE STARTUP FAILED:",error.message);}}else console.error("DATABASE_URL is missing. PostgreSQL persistence is disabled.");
}
start();
