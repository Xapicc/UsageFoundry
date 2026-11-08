# Verification: Security and sandboxing — the sign-in limiter, the gate's bearer budget, the `claude auth` children's settings and the Codex children's `config.toml`

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

- **A planted `$CODEX_HOME/config.toml` steers `codex app-server`'s bearer and
  none of the sign-in children, 2026-11-08.** codex-cli 0.153.4, a scratch
  `CODEX_HOME` under `$TMPDIR` holding a made-up API key or a made-up ChatGPT
  `auth.json` (unsigned JWTs), the spawn environment's `HTTPS_PROXY` at
  loopback listener P with `NO_PROXY=127.0.0.1`, and a planted file naming
  listener E; each logged every connection and answered 403. Unplanted, P took
  everything: `login status` nothing, `logout` and `login --device-auth` one
  CONNECT each to `auth.openai.com`, and `app-server` through `initialize`,
  `account/read`, `account/rateLimits/read` and `model/list` 18 to
  `chatgpt.com`. Planted `chatgpt_base_url` sent `app-server`'s `wham/usage`,
  `wham/rate-limit-reset-credits` and six plugin listings to E, each with the
  stored access token as `Authorization: Bearer` and `chatgpt-account-id`;
  `openai_base_url`, or `model_provider` naming a planted
  `[model_providers.*]`, sent `/v1/models` there with the same bearer; an
  `[otel]` exporter sent logs and traces. None of the four moved a connection
  of `login status`, `logout` or `login --with-api-key`, nor of `login
  --device-auth` driven to `Successfully logged in` through a stub issuer
  (`--experimental_issuer`), which took the user-code, token and `oauth/token`
  requests while E took nothing. A planted `[model_providers.openai]`,
  `[mcp_servers.*]` `url`, `experimental_thread_store_endpoint` or legacy
  `profile` left `app-server` as unplanted. In this container `CODEX_HOME` is
  1770, group `node`, with an owner the sandbox does not map (root, by the
  Dockerfile's `chown root:node`), and its `config.toml` is `node:node 0600`
  (`stat` only; the real home was never opened). Caveat: one run per cell; the CONNECTs were refused, so what the
  tunnels would have carried is not seen; only the keys named were tried.

- **`-c` pins after `app-server` put all of it back, and no Codex subcommand
  this app runs takes `--ignore-user-config`, 2026-11-08.** Same harness, a
  file planting `chatgpt_base_url`, `openai_base_url`, `model_provider` with
  its table and all three `[otel]` exporters at E. With `-c
  chatgpt_base_url="https://chatgpt.com/backend-api/"`, `-c
  openai_base_url=""`, `-c model_provider="openai"` and `-c` setting
  `otel.exporter`, `otel.trace_exporter` and `otel.metrics_exporter` to
  `"none"`, the ChatGPT-mode child sent 18 CONNECTs to `chatgpt.com` at P and
  none to E, with the same four answers; without `openai_base_url=""`,
  `/v1/models` still reached E. `""` reads as unset: with no planted file the
  pins changed neither the connections nor the answers, in ChatGPT mode or with
  an API key. `--ignore-user-config` before or after `app-server`, `login`, `login
  status` or `logout` exits with `unexpected argument`. Caveat: no real
  sign-in, so a token refresh under the pins was not seen; not in a booted
  container as root.

- **A planted `[marketplaces.*]` git source makes `codex app-server` start
  `git` against the host it names, and only `features.plugins=false` stops it,
  2026-11-08.** Board task `de468a72`, codex-cli 0.153.4, the harness above
  with the six endpoint pins on. Unplanted, the API-key child already ran
  `git` (user agent `git/2.39.5`) to `github.com` and the ChatGPT-mode child
  did not. A planted `source_type = "git"` marketplace whose `source` was an
  `http://` URL at listener E got `GET
  /evil/repo.git/info/refs?service=git-upload-pack` from `git` in both modes,
  with no `Authorization`. `-c marketplaces={}` left that fetch in place,
  since `-c` merges with the file. With `-c features.plugins=false` E took
  nothing, the API-key child made no connection at all and the ChatGPT one 12
  CONNECTs to `chatgpt.com` rather than 18. Through the app's own spawn
  (`codexUsage` and `listCodexModels` from the compiled `codexAccount.js`, two
  children per case), the build without the pin gave E two fetches per case.
  The build with it gave none, and its answers were byte-identical to the old
  build's, unplanted and planted, in both modes. Caveat: fake credentials, so
  the rate-limit read failed in every case; E refused, so what a served
  repository would go on to do is not seen.

- **No planted command runs during `codex app-server`'s four reads,
  2026-11-08.** Same harness and pins, each case lingering 8 s after
  `model/list` before stdin's EOF, in both sign-in modes. Each command
  appended to a marker file: `[mcp_servers.*]` `command` with `args`, an HTTP
  server's `http_headers_helper`, `notify`, `[[hooks.<event>]]` command hooks
  in `config.toml` for `SessionStart`, `SessionEnd`, `Interrupt` and
  `PreCompact`, the same and `UserPromptSubmit` and `Stop` in
  `$CODEX_HOME/hooks.json`, and a local-marketplace plugin installed with
  `codex plugin add` and enabled, whose `plugin.json` and `.mcp.json` named
  MCP servers. No marker was written, and the connections went to the
  unplanted child's hosts in its numbers. Caveat: a turn or thread was never
  started, which is where these are meant to run; one run per case.

- **`cli_auth_credentials_store`, `forced_login_method` and
  `forced_chatgpt_workspace_id` deny or lose a Codex sign-in and name no host,
  2026-11-08.** Same harness against `login --with-api-key`, `login status`,
  `logout`, `login --device-auth` driven through the stub issuer, and
  `app-server`. `"keyring"` (no secret service here) failed both logins, the
  device one after its token exchange; status and logout errored with
  `auth.json` left in place. `"ephemeral"` answered `Successfully logged in`
  to both and wrote no `auth.json`, and status answered `Not logged in` over
  one that existed. `"auto"` saved to the file, but its logout failed on the
  keyring. `forced_login_method` refused the other kind of login, and a
  `forced_chatgpt_workspace_id` the token lacked refused the device login.
  Over a stored login of the other kind or account, both made status say `Not
  logged in` and `account/read` answer `account: null`, which `"keyring"` and
  `"ephemeral"` answered over every stored login. Such a child then ran the
  API-key child's `git` sync to `github.com`, which the plugins pin now stops;
  no read deleted `auth.json`. On the login children `-c
  cli_auth_credentials_store="file"` and `-c forced_chatgpt_workspace_id=[]`
  (or `""`) undid theirs; `-c forced_login_method=""` failed with `unknown
  variant`, and both of its values restrict. Caveat: fake tokens, a stub
  issuer, one run per cell.

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

## Not yet verified by hand

- **That the bearer budget survives a dev-server reload of `middleware.ts`.**
  It is on `globalThis` for that reason, but `next dev` was not run here.
  Settle with `npm run dev` and `UF_AUTH_TOKEN` set: send 100 wrong bearers to
  `/api/runs`, touch `src/middleware.ts`, send the right bearer, and expect 429.

- **A real sign-in, sign-out and status read through the Settings page with
  the flags on.** Every measurement above stopped at a refused CONNECT or a
  made-up code, because no account was used. Settle in a booted container as
  root with `UF_LOCK_CLAUDE_HOME` off: write `{"env":{"HTTPS_PROXY":"http://127.0.0.1:9"}}`
  to `$CLAUDE_CONFIG_DIR/settings.json` as an agent, press Sign in on
  `/settings`, complete it, and expect the page to show signed in,
  `.credentials.json` owned by `UF_AGENT_UID`, and the proxy's port never
  dialled (`ss -tn` or a listener on it); then Sign out and expect signed out.

- **That the app-server pins hold against a real sign-in in a booted
  container.** Every measurement above used made-up tokens and refused
  CONNECTs. Settle as root in a container signed in to Codex: as the agent uid,
  put `chatgpt_base_url = "http://127.0.0.1:9/backend-api/"` and `openai_base_url
  = "http://127.0.0.1:9/v1"` in `$CODEX_HOME/config.toml`, keep a listener on
  port 9, load `/` and Settings → Codex, and expect the Codex windows and model
  list to read while the listener takes nothing; then remove the two lines.
