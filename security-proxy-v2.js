import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import pg from "pg";
import { analyzeRisk, getTopFive, getUsage, pool, TRIAL_LIMIT } from "./risk-engine.js";

const { Pool } = pg;
const PUBLIC_PORT = Number(process.env.PORT || 3000);
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT || 3001);
const DATABASE_URL = process.env.DATABASE_URL;
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || "http://localhost:5173").split(",").map(v => v.trim()).filter(Boolean);
const CLERK_ISSUER = (process.env.CLERK_ISSUER || "").replace(/\/$/, "");
const CLERK_JWKS_URL = process.env.CLERK_JWKS_URL || "";
const CLERK_AUTHORIZED_PARTIES = (process.env.CLERK_AUTHORIZED_PARTIES || "").split(",").map(v => v.trim()).filter(Boolean);
const WINDOW_MS = 60_000;
const IP_LIMIT = 60;
const USER_LIMIT = 120;
const MAX_BUCKETS = 10_000;
const MAX_JWT_LENGTH = 16_384;
const BODY_LIMIT = 16 * 1024;
const JWKS_CACHE_MS = 10 * 60_000;
const JWKS_TIMEOUT_MS = 5_000;
const ipBuckets = new Map();
const userBuckets = new Map();
let backendReady = false;
let jwksCache = { expiresAt: 0, keys: new Map() };
let jwksRefreshPromise = null;

const usagePool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 }) : null;

function json(res, status, data, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "strict-origin-when-cross-origin", "Permissions-Policy": "camera=(), microphone=(), geolocation=()", ...headers });
  res.end(JSON.stringify(data));
}
function clientIp(req) { const x = req.headers["x-forwarded-for"]; return typeof x === "string" && x ? x.split(",")[0].trim() : req.socket.remoteAddress || "unknown"; }
function limited(store, key, limit) {
  const now = Date.now(), current = store.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) { if (store.size >= MAX_BUCKETS) store.delete(store.keys().next().value); store.set(key, { startedAt: now, count: 1 }); return false; }
  current.count += 1; return current.count > limit;
}
setInterval(() => { const cutoff = Date.now() - WINDOW_MS; for (const store of [ipBuckets, userBuckets]) for (const [key, value] of store) if (value.startedAt < cutoff) store.delete(key); }, WINDOW_MS).unref();

function tokenFrom(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string") { const match = authorization.match(/^Bearer\s+(.+)$/i); if (match) return match[1].trim(); }
  const match = String(req.headers.cookie || "").match(/(?:^|;\s*)__session=([^;]+)/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}
function b64json(value) { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
function b64(value) { return Buffer.from(value, "base64url"); }
function configError() {
  if (!DATABASE_URL) return "DATABASE_URL is required.";
  if (!CLERK_ISSUER || !CLERK_JWKS_URL || !CLERK_AUTHORIZED_PARTIES.length) return "Clerk authentication is not configured.";
  try { if (new URL(CLERK_ISSUER).protocol !== "https:" || new URL(CLERK_JWKS_URL).protocol !== "https:") return "Clerk URLs must use HTTPS."; } catch { return "Invalid Clerk URL configuration."; }
  return null;
}
async function jwks(force = false) {
  if (!force && jwksCache.expiresAt > Date.now() && jwksCache.keys.size) return jwksCache.keys;
  if (jwksRefreshPromise) return jwksRefreshPromise;
  jwksRefreshPromise = (async () => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), JWKS_TIMEOUT_MS);
    try {
      const response = await fetch(CLERK_JWKS_URL, { signal: controller.signal, headers: { Accept: "application/json" }, redirect: "error" });
      if (!response.ok) throw new Error(`JWKS ${response.status}`);
      const document = await response.json(), keys = new Map();
      for (const key of document.keys || []) if (key?.kid && key.kty === "RSA" && key.alg === "RS256" && key.use === "sig") keys.set(key.kid, crypto.createPublicKey({ key, format: "jwk" }));
      if (!keys.size) throw new Error("No usable signing keys");
      jwksCache = { expiresAt: Date.now() + JWKS_CACHE_MS, keys }; return keys;
    } finally { clearTimeout(timer); jwksRefreshPromise = null; }
  })();
  return jwksRefreshPromise;
}
async function authenticate(req) {
  const token = tokenFrom(req);
  if (!token || token.length > MAX_JWT_LENGTH) return { ok: false, status: 401, error: "Authentication required." };
  try {
    const parts = token.split("."), header = b64json(parts[0]), payload = b64json(parts[1]);
    if (parts.length !== 3 || header.alg !== "RS256" || header.typ !== "JWT" || !header.kid) throw new Error("Invalid JWT");
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Missing subject");
    if (payload.iss?.replace(/\/$/, "") !== CLERK_ISSUER || !CLERK_AUTHORIZED_PARTIES.includes(payload.azp)) throw new Error("Invalid claims");
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(payload.exp) || payload.exp <= now) throw new Error("Expired");
    if (payload.nbf !== undefined && Number(payload.nbf) > now + 5) throw new Error("Not active");
    let keys = await jwks(false), key = keys.get(header.kid);
    if (!key) { keys = await jwks(true); key = keys.get(header.kid); }
    if (!key || !crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, b64(parts[2]))) throw new Error("Invalid signature");
    return { ok: true, userId: payload.sub };
  } catch (error) { console.error("AUTH FAILED:", error.message); return { ok: false, status: 401, error: "Invalid authentication token." }; }
}
function cors(origin) { if (!origin || !FRONTEND_ORIGINS.includes(origin)) return {}; return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Authorization,Content-Type", Vary: "Origin" }; }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on("data", chunk => { size += chunk.length; if (size > BODY_LIMIT) { reject(Object.assign(new Error("Request body too large"), { status: 413 })); req.destroy(); return; } chunks.push(chunk); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); } });
    req.on("error", reject);
  });
}
async function consumeTrial(userId) {
  const upcoming = await usagePool.query(`SELECT gameweek, deadline FROM fpl_gameweeks WHERE deadline > NOW() ORDER BY deadline ASC LIMIT 1`);
  if (!upcoming.rowCount) throw new Error("No upcoming FPL deadline is available.");
  const gameweek = Number(upcoming.rows[0].gameweek), deadline = new Date(upcoming.rows[0].deadline);
  const result = await usagePool.query(`
    INSERT INTO user_deadline_usage (user_id, gameweek, deadline_at, calculation_count)
    VALUES ($1,$2,$3,1)
    ON CONFLICT (user_id,gameweek) DO UPDATE SET calculation_count=user_deadline_usage.calculation_count+1, deadline_at=EXCLUDED.deadline_at, updated_at=NOW()
    WHERE user_deadline_usage.calculation_count < $4 RETURNING calculation_count
  `, [userId, gameweek, deadline.toISOString(), TRIAL_LIMIT]);
  if (!result.rowCount) {
    const current = await usagePool.query(`SELECT calculation_count FROM user_deadline_usage WHERE user_id=$1 AND gameweek=$2`, [userId, gameweek]);
    return { allowed: false, used: Number(current.rows[0]?.calculation_count || TRIAL_LIMIT), remaining: 0, gameweek, deadline };
  }
  const used = Number(result.rows[0].calculation_count);
  return { allowed: true, used, remaining: TRIAL_LIMIT - used, gameweek, deadline };
}
async function refundTrial(userId, gameweek) { await usagePool.query(`UPDATE user_deadline_usage SET calculation_count=GREATEST(calculation_count-1,0),updated_at=NOW() WHERE user_id=$1 AND gameweek=$2`, [userId, gameweek]); }
async function proxyToBackend(req, res, userId) {
  const target = `http://127.0.0.1:${INTERNAL_PORT}${req.url}`;
  const headers = { ...req.headers, host: `127.0.0.1:${INTERNAL_PORT}`, "x-authenticated-user-id": userId };
  delete headers["x-forwarded-for"]; delete headers["x-forwarded-host"]; delete headers["x-forwarded-proto"];
  const upstream = await fetch(target, { method: req.method, headers, redirect: "manual" });
  res.statusCode = upstream.status;
  for (const [key, value] of upstream.headers) if (!["connection","keep-alive","transfer-encoding","upgrade","host","set-cookie"].includes(key.toLowerCase())) res.setHeader(key, value);
  Object.entries(cors(req.headers.origin)).forEach(([key,value]) => res.setHeader(key,value));
  res.end(Buffer.from(await upstream.arrayBuffer()));
  return upstream.status;
}

const gateway = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`), origin = req.headers.origin;
    if (origin && !FRONTEND_ORIGINS.includes(origin)) return json(res,403,{error:"Origin not allowed."});
    if (req.method === "OPTIONS") { res.writeHead(204,cors(origin)); return res.end(); }
    if (limited(ipBuckets,clientIp(req),IP_LIMIT)) return json(res,429,{error:"Too many requests."},{"Retry-After":"60"});
    if (url.pathname === "/health" || url.pathname === "/") return json(res, backendReady && !configError() ? 200 : 503, { status: backendReady && !configError() ? "ok" : "starting", securityGateway: true, backendReady, authentication: !configError() });
    if (!url.pathname.startsWith("/api/")) return json(res,404,{error:"Not found"});
    if (!backendReady) return json(res,503,{error:"Backend is starting."},{"Retry-After":"3"});
    const auth = await authenticate(req);
    if (!auth.ok) return json(res,auth.status,{error:auth.error});
    if (limited(userBuckets,auth.userId,USER_LIMIT)) return json(res,429,{error:"User request limit exceeded."},{"Retry-After":"60"});

    if (url.pathname === "/api/calculator/templates") {
      if (req.method !== "GET") return json(res,405,{error:"Method not allowed"},{Allow:"GET"});
      const fplId = Number(url.searchParams.get("fplId"));
      if (!Number.isSafeInteger(fplId) || fplId <= 0) return json(res,400,{error:"Valid fplId is required."});
      return json(res,200,await getTopFive(fplId),cors(origin));
    }
    if (url.pathname === "/api/calculator/usage") {
      if (req.method !== "GET") return json(res,405,{error:"Method not allowed"},{Allow:"GET"});
      return json(res,200,await getUsage(auth.userId),cors(origin));
    }
    if (url.pathname === "/api/calculator/analyze") {
      if (req.method !== "POST") return json(res,405,{error:"Method not allowed"},{Allow:"POST,OPTIONS"});
      let trial;
      try { trial = await consumeTrial(auth.userId); } catch (error) { console.error("TRIAL ENFORCEMENT FAILED:",error.message); return json(res,503,{error:"Usage enforcement is temporarily unavailable."}); }
      if (!trial.allowed) return json(res,429,{error:"Free analysis limit reached for this gameweek.",code:"GAMEWEEK_TRIAL_LIMIT",used:trial.used,remaining:0,limit:TRIAL_LIMIT,gameweek:trial.gameweek,resetsAt:trial.deadline.toISOString()},{"Retry-After":String(Math.max(1,Math.ceil((trial.deadline.getTime()-Date.now())/1000)))});
      try {
        const body = await readBody(req);
        const fplId = Number(body.fplId), playerId = Number(body.playerId);
        const result = await analyzeRisk({ fplId, playerId, owns: body.owns, captain: body.captain, tripleCaptain: body.tripleCaptain, expectedPoints: Number(body.expectedPoints) });
        const usage = await getUsage(auth.userId);
        return json(res,200,{ ...result, usage },cors(origin));
      } catch (error) {
        await refundTrial(auth.userId,trial.gameweek);
        const status = error.status || 400;
        return json(res,status,{error:error.message});
      }
    }

    if (req.method !== "GET") return json(res,405,{error:"Method not allowed"},{Allow:"GET,OPTIONS"});
    if (url.pathname === "/api/cache") return json(res,404,{error:"Not found"});
    if (url.pathname === "/api/calculator/context") url.pathname = "/api/sample-tiers", req.url = `${url.pathname}${url.search}`;
    return await proxyToBackend(req,res,auth.userId);
  } catch (error) { console.error("GATEWAY ERROR:",error.message); if (!res.headersSent) return json(res,500,{error:"Internal server error."}); res.end(); }
});

async function initSecurityDatabase() {
  if (!usagePool) throw new Error("DATABASE_URL is required.");
  await usagePool.query(`CREATE TABLE IF NOT EXISTS user_deadline_usage (user_id TEXT NOT NULL, gameweek INTEGER NOT NULL, deadline_at TIMESTAMPTZ NOT NULL, calculation_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id,gameweek), CONSTRAINT user_deadline_usage_count_nonnegative CHECK(calculation_count>=0)); CREATE INDEX IF NOT EXISTS idx_user_deadline_usage_deadline ON user_deadline_usage(deadline_at);`);
}
function waitForBackend(timeoutMs=60000) { const started=Date.now(); return new Promise((resolve,reject)=>{ const attempt=()=>{ const socket=net.createConnection({host:"127.0.0.1",port:INTERNAL_PORT}); let done=false; const finish=error=>{if(done)return;done=true;socket.destroy();if(!error)return resolve();if(Date.now()-started>=timeoutMs)return reject(error);setTimeout(attempt,250);};socket.once("connect",()=>finish());socket.once("error",finish);socket.setTimeout(1000,()=>finish(new Error("Internal backend timeout")));};attempt(); }); }
async function start() {
  const error=configError(); if(error){console.error(`SECURITY STARTUP FAILED: ${error}`);process.exit(1);}
  await initSecurityDatabase(); process.env.PORT=String(INTERNAL_PORT); await import("./server.js"); await waitForBackend(); backendReady=true;
  gateway.listen(PUBLIC_PORT,"0.0.0.0",()=>console.log(`Secure FPL gateway listening on ${PUBLIC_PORT}; free analyses: ${TRIAL_LIMIT}`));
}
start().catch(error=>{console.error("SECURITY GATEWAY FAILED:",error.message);process.exit(1);});
