import http from "node:http";
import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;

// Security gateway. The existing server runs privately behind this proxy.
// Clerk session tokens are verified locally with CLERK_JWT_KEY.
const PUBLIC_PORT = Number(process.env.PORT || 3000);
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT || 3001);
const DATABASE_URL = process.env.DATABASE_URL;
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || "http://localhost:5173")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);
const CLERK_JWT_KEY = process.env.CLERK_JWT_KEY;
const CLERK_ISSUER = process.env.CLERK_ISSUER;
const CLERK_AUTHORIZED_PARTIES = (process.env.CLERK_AUTHORIZED_PARTIES || FRONTEND_ORIGINS.join(","))
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);

const WINDOW_MS = 60_000;
const IP_LIMIT = 60;
const USER_LIMIT = 120;
const TRIAL_LIMIT = 3;
const ipBuckets = new Map();
const userBuckets = new Map();

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    })
  : null;

function json(res, status, data, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    ...headers
  });
  res.end(JSON.stringify(data));
}

function clientIp(req) {
  // Only trust X-Forwarded-For when your hosting platform is the trusted proxy.
  const forwarded = req.headers["x-forwarded-for"];
  return typeof forwarded === "string" && forwarded
    ? forwarded.split(",")[0].trim()
    : req.socket.remoteAddress || "unknown";
}

function bucketLimited(store, key, limit) {
  const now = Date.now();
  const current = store.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    store.set(key, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > limit;
}

setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const store of [ipBuckets, userBuckets]) {
    for (const [key, value] of store) {
      if (value.startedAt < cutoff) store.delete(key);
    }
  }
}, WINDOW_MS).unref();

function base64urlJson(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function base64urlBytes(value) {
  return Buffer.from(value, "base64url");
}

function getToken(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }

  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)__session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function verifyClerkToken(req) {
  if (!CLERK_JWT_KEY || !CLERK_ISSUER || CLERK_AUTHORIZED_PARTIES.length === 0) {
    return { ok: false, status: 503, error: "Authentication is not configured." };
  }

  const token = getToken(req);
  if (!token) return { ok: false, status: 401, error: "Authentication required." };

  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Malformed JWT");

    const header = base64urlJson(parts[0]);
    const payload = base64urlJson(parts[1]);
    if (header.alg !== "RS256") throw new Error("Unexpected JWT algorithm");
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Missing subject");
    if (typeof payload.iss !== "string" || payload.iss !== CLERK_ISSUER) throw new Error("Invalid issuer");
    if (!CLERK_AUTHORIZED_PARTIES.includes(payload.azp)) throw new Error("Invalid authorized party");

    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(payload.exp) || payload.exp <= now) throw new Error("Expired token");
    if (payload.nbf !== undefined && Number(payload.nbf) > now + 5) throw new Error("Token not active");
    if (payload.iat !== undefined && Number(payload.iat) > now + 60) throw new Error("Invalid issued-at time");

    const signingInput = `${parts[0]}.${parts[1]}`;
    const valid = crypto.verify(
      "RSA-SHA256",
      Buffer.from(signingInput),
      CLERK_JWT_KEY,
      base64urlBytes(parts[2])
    );
    if (!valid) throw new Error("Invalid signature");

    return { ok: true, userId: payload.sub, sessionId: payload.sid || null, claims: payload };
  } catch {
    return { ok: false, status: 401, error: "Invalid authentication token." };
  }
}

async function initSecurityDatabase() {
  if (!pool) throw new Error("DATABASE_URL is not configured.");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_weekly_usage (
      user_id TEXT NOT NULL,
      week_start DATE NOT NULL,
      calculation_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, week_start),
      CONSTRAINT user_weekly_usage_count_nonnegative CHECK (calculation_count >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_user_weekly_usage_week
      ON user_weekly_usage(week_start);
  `);
}

async function consumeTrial(userId) {
  if (!pool) throw new Error("Database is required for usage enforcement.");

  const result = await pool.query(`
    INSERT INTO user_weekly_usage (user_id, week_start, calculation_count)
    VALUES ($1, date_trunc('week', CURRENT_DATE)::date, 1)
    ON CONFLICT (user_id, week_start)
    DO UPDATE SET
      calculation_count = user_weekly_usage.calculation_count + 1,
      updated_at = NOW()
    WHERE user_weekly_usage.calculation_count < $2
    RETURNING calculation_count
  `, [userId, TRIAL_LIMIT]);

  if (!result.rowCount) {
    const current = await pool.query(`
      SELECT calculation_count
      FROM user_weekly_usage
      WHERE user_id = $1 AND week_start = date_trunc('week', CURRENT_DATE)::date
    `, [userId]);
    return {
      allowed: false,
      used: Number(current.rows[0]?.calculation_count || TRIAL_LIMIT),
      remaining: 0
    };
  }

  const used = Number(result.rows[0].calculation_count);
  return { allowed: true, used, remaining: Math.max(0, TRIAL_LIMIT - used) };
}

async function refundTrial(userId) {
  if (!pool) return;
  await pool.query(`
    UPDATE user_weekly_usage
    SET calculation_count = GREATEST(calculation_count - 1, 0), updated_at = NOW()
    WHERE user_id = $1 AND week_start = date_trunc('week', CURRENT_DATE)::date
  `, [userId]);
}

function originAllowed(origin) {
  return !origin || FRONTEND_ORIGINS.includes(origin);
}

function corsHeaders(origin) {
  if (!origin || !FRONTEND_ORIGINS.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Vary": "Origin"
  };
}

function copySafeHeaders(source, target) {
  const blocked = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host"]);
  for (const [key, value] of source) {
    if (!blocked.has(key.toLowerCase())) target.setHeader(key, value);
  }
}

async function proxy(req, res, userId) {
  const target = `http://127.0.0.1:${INTERNAL_PORT}${req.url}`;
  const headers = { ...req.headers, host: `127.0.0.1:${INTERNAL_PORT}` };
  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-proto"];

  if (userId) headers["x-authenticated-user-id"] = userId;

  const upstream = await fetch(target, {
    method: req.method,
    headers,
    redirect: "manual"
  });

  res.statusCode = upstream.status;
  copySafeHeaders(upstream.headers, res);
  const origin = req.headers.origin;
  Object.entries(corsHeaders(origin)).forEach(([key, value]) => res.setHeader(key, value));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  const body = Buffer.from(await upstream.arrayBuffer());
  res.end(body);
  return upstream.status;
}

const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const origin = req.headers.origin;

  if (!originAllowed(origin)) {
    json(res, 403, { error: "Origin not allowed." });
    return;
  }

  if (req.method === "OPTIONS") {
    if (!origin) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  if (bucketLimited(ipBuckets, clientIp(req), IP_LIMIT)) {
    json(res, 429, { error: "Too many requests. Please try again shortly." }, { "Retry-After": "60" });
    return;
  }

  if (url.pathname === "/health" || url.pathname === "/") {
    json(res, 200, { status: "ok", securityGateway: true, authentication: Boolean(CLERK_JWT_KEY && CLERK_ISSUER) });
    return;
  }

  if (!url.pathname.startsWith("/api/")) {
    json(res, 404, { error: "Not found" });
    return;
  }

  const auth = verifyClerkToken(req);
  if (!auth.ok) {
    json(res, auth.status, { error: auth.error });
    return;
  }

  if (bucketLimited(userBuckets, auth.userId, USER_LIMIT)) {
    json(res, 429, { error: "User request limit exceeded. Please try again shortly." }, { "Retry-After": "60" });
    return;
  }

  // Every request to the calculator data endpoint consumes one of the 3 weekly trials.
  // This is enforced by user ID in PostgreSQL, not by the frontend or localStorage.
  const isCalculation = url.pathname === "/api/sample-tiers" || url.pathname === "/api/calculator/context";
  let trial = null;

  if (isCalculation) {
    if (!pool) {
      json(res, 503, { error: "Usage enforcement is unavailable." });
      return;
    }
    try {
      trial = await consumeTrial(auth.userId);
      if (!trial.allowed) {
        json(res, 429, {
          error: "Weekly trial limit reached.",
          code: "WEEKLY_TRIAL_LIMIT",
          used: trial.used,
          remaining: 0,
          limit: TRIAL_LIMIT
        }, { "Retry-After": "604800" });
        return;
      }
    } catch (error) {
      console.error("TRIAL ENFORCEMENT FAILED:", error.message);
      json(res, 503, { error: "Usage enforcement is temporarily unavailable." });
      return;
    }
  }

  try {
    // Keep the legacy endpoint intact; expose the future-proof calculator route as an alias.
    if (url.pathname === "/api/calculator/context") {
      url.pathname = "/api/sample-tiers";
      req.url = `${url.pathname}${url.search}`;
    }

    const status = await proxy(req, res, auth.userId);
    if (isCalculation && status >= 500) await refundTrial(auth.userId);
  } catch (error) {
    if (isCalculation && trial?.allowed) await refundTrial(auth.userId);
    console.error("UPSTREAM PROXY ERROR:", error.message);
    if (!res.headersSent) json(res, 502, { error: "Backend service unavailable." });
    else res.end();
  }
});

async function start() {
  if (!DATABASE_URL) {
    console.error("SECURITY STARTUP FAILED: DATABASE_URL is required for trial enforcement.");
    process.exit(1);
  }

  if (!CLERK_JWT_KEY || !CLERK_ISSUER || CLERK_AUTHORIZED_PARTIES.length === 0) {
    console.error("SECURITY STARTUP FAILED: CLERK_JWT_KEY, CLERK_ISSUER and CLERK_AUTHORIZED_PARTIES are required.");
    process.exit(1);
  }

  await initSecurityDatabase();

  // Start the existing application server on an unreachable loopback port.
  process.env.PORT = String(INTERNAL_PORT);
  await import("./server.js");

  gateway.listen(PUBLIC_PORT, "0.0.0.0", () => {
    console.log(`Security gateway listening on port ${PUBLIC_PORT}`);
    console.log(`Legacy backend isolated on loopback port ${INTERNAL_PORT}`);
    console.log(`Free quota: ${TRIAL_LIMIT} calculator uses per UTC week.`);
  });
}

start().catch(error => {
  console.error("SECURITY GATEWAY FAILED:", error.message);
  process.exit(1);
});
