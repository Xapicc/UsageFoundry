# Verification: Security and sandboxing — the sign-in limiter and the gate's bearer budget

[← Verification index](../verification.md)

## Verified

- **The gate's bearer budget holds between requests in the standalone build,
  2026-10-06.** `npm run build` on the branch carrying `bearerLimiter.ts`
  (main 3d325d3 plus four commits; Next 15.5.24; no CLI involved), then
  `.next/standalone/server.js` on a throwaway `DATA_DIR` with `UF_AUTH_TOKEN`
  set. 130 sequential wrong bearers on `/api/runs` were answered 100 × 401 and
  then 30 × 429; the right bearer was then answered 429 with `retry-after: 60`;
  a cookie from `POST /api/login` still got 200; the stdout lockout line
  printed once. What it settles is that the counter's `globalThis` state
  survives between requests in the edge sandbox the standalone server runs
  middleware in, which the unit test cannot show because it calls
  `middleware()` in plain Node. Caveat: one process, never restarted, not under
  `docker compose`, and sequential rather than concurrent requests.

- **A short `UF_AUTH_TOKEN` is said above the dashboard's meters, and only to
  a caller holding it, 2026-10-06.** `npm run build` (Next 15.5.24) on d9fae7c9
  plus the change adding the warning to `configCheck.ts`, then
  `.next/standalone/server.js` on a throwaway `DATA_DIR`, `CLAUDE_HOME` and
  workspace, driven by Playwright over a bearer. With an 18-character token,
  `/` at 1280px and at 390px showed one warn notice naming `UF_AUTH_TOKEN` and
  `openssl rand -hex 32` and no console error; stdout carried the boot block
  and one `Configuration:` line; neither named a length other than the 32
  bound. Anonymous `/login` HTML carried none of that text and anonymous
  `/api/usage` answered 401. With a 64-character token nothing was shown or
  logged. `npm run smoke-pages` on the same build: standalone, 96/96 clean.
  Caveat: not under `docker compose`, and only the bearer was driven, not a
  cookie session.

## Not yet verified by hand

- **That the bearer budget survives a dev-server reload of `middleware.ts`.**
  It is on `globalThis` for that reason, but `next dev` was not run here.
  Settle with `npm run dev` and `UF_AUTH_TOKEN` set: send 100 wrong bearers to
  `/api/runs`, touch `src/middleware.ts`, send the right bearer, and expect 429.
