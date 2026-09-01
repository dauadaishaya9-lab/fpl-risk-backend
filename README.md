# FPL Risk backend

This Render web service is the authenticated API for the FPL Risk calculator. It reads FPL's public API, persists a deadline-locked comparison sample in PostgreSQL, and returns risk analysis based on the signed-in user's linked FPL team.

## Why the browser showed “Failed to fetch”

The calculator API requires a Clerk JWT. A browser reports a generic network/CORS `Failed to fetch` when a permitted frontend origin is not configured, because it cannot read the API's error response. The gateway now returns CORS headers on permitted-origin error responses, includes the deployed frontend in its safe local default, and exposes a documented player-list route. The frontend should still display the returned error body and must send its Clerk session token as `Authorization: Bearer <token>`.

A real request to analyse risk is:

```http
POST /api/calculator/analyze
Authorization: Bearer <Clerk session JWT>
Content-Type: application/json

{"playerId":123,"owns":true,"captain":false,"tripleCaptain":false,"expectedPoints":6.5}
```

Before analysing, link the account with `POST /api/account/fpl` and `{ "fplId": 123456 }`. Useful authenticated routes are `GET /api/account/fpl`, `GET /api/calculator/players`, `GET /api/calculator/templates`, and `GET /api/calculator/usage`.

## Rank-estimator integration

`rank-impact.js` is already integrated into the analysis route. For the owner and active premium subscribers, the response adds `rankImpact`, estimated from the saved gameweek snapshot and the user's FPL history. The frontend should render this object when it is non-null; the normal risk analysis remains available if a historical rank estimate cannot be calculated.

Premium users and the configured owner have unlimited analyses. Free users retain the three-analysis-per-gameweek limit.

## Deploy on Render

1. Create a **PostgreSQL** instance and a **Web Service** from this repository. Render can read [`render.yaml`](render.yaml) to create the web service.
2. Use build command `npm install`, start command `npm start`, and health-check path `/health`. Render supplies `PORT`; do not set it manually.
3. Set `DATABASE_URL` to the Render Postgres internal connection string.
4. In Clerk, create a production JWT template/session configuration for the frontend. Set `CLERK_ISSUER`, `CLERK_JWKS_URL`, and `CLERK_AUTHORIZED_PARTIES`. The authorised parties value must include the exact frontend origin, for example `https://fpl-risk-frontend.onrender.com`.
5. Set `FRONTEND_ORIGINS` to exact, comma-separated browser origins, for example `https://fpl-risk-frontend.onrender.com,http://localhost:5173`. Origins must have no path and must match protocol and hostname exactly.
6. Optional: set `OWNER_CLERK_USER_ID` to the Clerk user ID that should receive unlimited access.
7. Deploy, then open `/health`. It must return HTTP 200 and `{ "status": "ok" }` before testing the frontend. In Render logs, resolve any `FATAL STARTUP ERROR` before proceeding.

Do not put `DATABASE_URL`, Clerk private keys, or other secrets in the frontend repository. The browser only needs the backend base URL and the Clerk publishable key.
