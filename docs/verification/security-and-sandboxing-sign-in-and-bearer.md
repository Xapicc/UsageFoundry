# Verification: Security and sandboxing — the sign-in limiter, the gate's bearer budget and the `claude auth` children's settings

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

- **`--settings` and `--setting-sources` reach all three `claude auth`
  subcommands, and only ahead of `auth`, 2026-11-08.** CLI 2.1.310 under
  `env -i`, a scratch `CLAUDE_CONFIG_DIR` and `HOME` under `$TMPDIR`, a planted
  `settings.json` whose `env` named `HTTPS_PROXY`, `HTTP_PROXY` and
  `NODE_TLS_REJECT_UNAUTHORIZED=0` at loopback listener A, and the spawn
  environment naming listener B; each listener logged the first line of every
  connection and answered 403. Bare, A took every connection and B none:
  `auth status --json` one CONNECT (`api.anthropic.com`), `auth logout` three
  (`api.anthropic.com`, `platform.claude.com`, `api.anthropic.com`), `auth
  login` two (`platform.claude.com`, `api.anthropic.com`) once a made-up code
  was written to its stdin. With `--setting-sources ""`, or `--settings` naming
  B in `env`, ahead of `auth`, A took none and B took the same count in all
  three. After the subcommand either flag exits 1 with `error: unknown option`
  and starts nothing. The overlay `cycleEnvPins` builds (19 keys, all but the
  two proxies `""`) moved `auth status` the same way. Caveat: one run per
  cell; the CONNECT was refused, so what the child would have sent through the
  tunnel (the token-exchange body, which the 2026-10-26 hunt saw at a
  TLS-intercepting proxy) is inferred from that and not seen here; the scratch
  directory held made-up credentials and the real config directory was never
  read.

- **A planted `CLAUDE_CODE_CUSTOM_OAUTH_URL` breaks `auth login` and does not
  redirect it, and `--settings` pins do not stop that, 2026-11-08.** Same
  harness as above with the proxy variables left out of the planted file. With
  `env.CLAUDE_CODE_CUSTOM_OAUTH_URL` naming listener A, a bare `auth login`
  printed `Login failed: CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved
  endpoint.` before it printed a link and touched neither listener; with a
  `--settings` overlay of proxy pins it failed the same way; with
  `--setting-sources ""` it ran as the unplanted control did (two CONNECTs at
  B). `CLAUDE_CODE_OAUTH_CLIENT_ID`, `USE_LOCAL_OAUTH` and `USE_STAGING_OAUTH`,
  planted singly, left the login as the control. That is why login and logout
  drop every settings source rather than pin: a list of endpoint variables is
  complete only for the ones somebody measured. Caveat: what the CLI approves
  was not read, only that this value is refused; one run per variable.

- **A user-scope `ANTHROPIC_API_KEY` changes what `auth status` reports, and
  `--setting-sources ""` hides it, 2026-11-08.** Same harness, a made-up OAuth
  credential in the scratch directory and `env.ANTHROPIC_API_KEY` planted in
  its `settings.json`. Bare, and with `--settings` carrying the proxy pins,
  `auth status --json` answered `authMethod: "api_key"` and `apiKeySource:
  "ANTHROPIC_API_KEY"`; with `--setting-sources ""` it answered
  `authMethod: "claude.ai"` and `subscriptionType: "max"`. That is why status
  takes the pins and not the empty source list: the panel answers for the
  credential a work cycle gets, and a cycle loads the user scope. Caveat: that
  a cycle bills the planted key is `cycle-settings-env.md`'s reading of the
  cycle's argv and was not re-run here.

- **`auth status` reports a user-file `apiKeyHelper` as the login without
  running it, on 2.1.310, 2026-11-08.** Board task `9d7770b6`. A scratch
  `CLAUDE_CONFIG_DIR` whose `settings.json` named a helper that would write a
  marker, and `status` led by the pins-only `--settings` that `authArgv`
  builds. With no credential in the environment it answered `loggedIn: true`,
  `authMethod: "api_key_helper"`, `apiKeySource: "apiKeyHelper"`; with a fake
  `ANTHROPIC_API_KEY` it answered `api_key_helper` beside `apiKeySource:
  "ANTHROPIC_API_KEY"`; with a fake `CLAUDE_CODE_OAUTH_TOKEN`, `api_key_helper`
  again. No marker was written in any of the three. With `"apiKeyHelper": ""`
  added to the same `--settings` it answered `loggedIn: false`, `api_key` and
  `oauth_token`. Caveat: fake credentials, one run per case, and the exit code
  was 1 only for the signed-out answer; the panel's own parsing of
  `api_key_helper` was not read.

- **With `apiKeyHelper: ""` in its `--settings`, the app's own status read
  answers for the credential a cycle gets, on 2.1.319, 2026-11-08.** Board
  task `ed6a7179`. `readAuthStatus()` (no read in flight, so
  `readFreshAuthStatus`) from the compiled `claudeAuth.js` under `env -i`,
  `CLAUDE_BIN` the installed 2.1.319, a scratch `CLAUDE_CONFIG_DIR` and `HOME`
  whose `settings.json` named a helper that would write a marker, and the
  spawn environment's `HTTPS_PROXY` at a loopback listener that refused every
  CONNECT. With the pins-only argv the value handed to the Settings route was
  `loggedIn: true`, `method: "api_key_helper"` in all four cases: no
  credential, a fake `ANTHROPIC_API_KEY`, a fake `CLAUDE_CODE_OAUTH_TOKEN`, and
  a made-up stored `.credentials.json`. With the change it was `loggedIn:
  false` and `none`, then `api_key`, `oauth_token`, and `claude.ai` with plan
  `max`. No marker was written in any of the eight; every connection was a
  CONNECT to `api.anthropic.com` at the listener. Caveat: one run per case,
  fake credentials, not in a booted container as root.

- **`credential_expires_at` is on a 2.1.319 `stream-json` `result` only for a
  stored claude.ai sign-in with a refresh-token expiry, 2026-11-08.**
  `scripts/cli-capture/` plan e3: a stub API and made-up credentials in a
  scratch `CLAUDE_CONFIG_DIR`. A stored `.credentials.json` whose
  `claudeAiOauth` carried `refreshTokenExpiresAt` 20 days ahead produced
  `credential_expires_at: "2026-11-28T20:12:44.631Z"`, that instant, on both a
  plain cycle's `result` and a compacting cycle's. It was absent under
  `ANTHROPIC_API_KEY`, under `CLAUDE_CODE_OAUTH_TOKEN`, and under a stored
  sign-in without `refreshTokenExpiresAt`. The binary reads the same way:
  `q6n()` answers null unless the provider is first-party, the session is a
  claude.ai login, and the stored token has a refresh token with a valid
  `refreshTokenExpiresAt`. The schema carries the field on success and error
  results alike. Nothing in this app reads it yet. Caveat: whether a real
  sign-in's file carries `refreshTokenExpiresAt` was not seen.

- **`claude auth status --json` dates only a stored claude.ai login, and the
  app reads, shows and warns on that date, on 2.1.319, 2026-11-08.** `claude
  --version` 2.1.319 under `env -i`, a scratch `CLAUDE_CONFIG_DIR` and `HOME`
  under `$TMPDIR`, `HTTPS_PROXY` at a closed loopback port, made-up credentials
  throughout. `loginExpiresAt` is in every answer, signed out included, as an
  ISO-8601 UTC string with milliseconds or `null`. A stored
  `claudeAiOauth` with a `refreshToken` and `refreshTokenExpiresAt` at +30 d,
  +5 d and -2 d reported that instant each time, so a lapsed login is dated and
  not nulled; with no `refreshTokenExpiresAt`, with no `refreshToken`, or at
  +4000 d (the binary rejects one more than ten years out) it was `null`. Bare,
  a fake `ANTHROPIC_API_KEY`, a user-file `apiKeyHelper` and a fake
  `CLAUDE_CODE_OAUTH_TOKEN` each answered `null`, alone and with a stored login
  at +5 d behind them (`authMethod` `api_key`, `api_key_helper`, `oauth_token`),
  as did a signed-out container. The app's own read (`readAuthStatus()` from the
  compiled `claudeAuth.js`, which adds the pins and `apiKeyHelper: ""`) answered
  `loginExpiresAt` for the stored login at +30 d, +5 d and -2 d, `null` under
  the key, the OAuth variable and no credential, and, because the pins drop a
  user-file helper, the stored login's date under that helper too. With
  `CLAUDE_BIN` at a stub answering `status`, the standalone build's
  `/api/claude-auth` carried it, `/api/usage` carried one `Claude account`
  entry in `meta.configProblems` at +5 d, and `/settings` at 1280px and `/` at
  390px showed the badge and the notice. Caveat: one run per case and fake
  credentials, so what a real sign-in stores in `refreshTokenExpiresAt`, and how
  long before it requests actually fail, is not measured; the "up to 3 days
  sooner" window is read from the shipped binary's code (`earliest` is the date
  less three days), not observed; the `claude -p` field `credential_expires_at`
  and its stderr warning were not run; the build was not under `docker compose`
  and ran with auth off.

## Not yet verified by hand

- **That the bearer budget survives a dev-server reload of `middleware.ts`.**
  It is on `globalThis` for that reason, but `next dev` was not run here.
  Settle with `npm run dev` and `UF_AUTH_TOKEN` set: send 100 wrong bearers to
  `/api/runs`, touch `src/middleware.ts`, send the right bearer, and expect 429.

- **What a real claude.ai sign-in stores in `refreshTokenExpiresAt`, and how
  long before `loginExpiresAt` requests really stop authenticating.** Every
  date above came from a credential file written by hand. Settle in a signed-in
  container: read `claudeAiOauth.refreshTokenExpiresAt` from
  `$CLAUDE_CONFIG_DIR/.credentials.json`, compare it with `claude auth status
  --json`'s `loginExpiresAt`, and note both against the first
  `Not logged in` after that date.

- **A real sign-in, sign-out and status read through the Settings page with
  the flags on.** Every measurement above stopped at a refused CONNECT or a
  made-up code, because no account was used. Settle in a booted container as
  root with `UF_LOCK_CLAUDE_HOME` off: write `{"env":{"HTTPS_PROXY":"http://127.0.0.1:9"}}`
  to `$CLAUDE_CONFIG_DIR/settings.json` as an agent, press Sign in on
  `/settings`, complete it, and expect the page to show signed in,
  `.credentials.json` owned by `UF_AGENT_UID`, and the proxy's port never
  dialled (`ss -tn` or a listener on it); then Sign out and expect signed out.
