# Verification: Security and sandboxing — the Codex children's `$CODEX_HOME/config.toml`

[← Verification index](../verification.md)

Split from `security-and-sandboxing-sign-in-and-bearer.md` on 2026-11-08, when
board task `c15641cc` would have taken it past 20 KB. The scratch-`CODEX_HOME`
harness every entry here uses is the first entry's: a made-up API key or
ChatGPT `auth.json`, the spawn environment's `HTTPS_PROXY` at loopback listener
P with `NO_PROXY=127.0.0.1`, a planted file naming listener E, and a stub
issuer behind `--experimental_issuer` for the device login. The real
`/home/node/.codex` was never opened. What a cycle loads from its checkout's
`.codex/config.toml`, the guard on a `config.toml` that is not a file, and
TokenEconomizer's Codex pruning continue in
`security-and-sandboxing-codex-project-config.md`.

## Verified

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

- **`-c cli_auth_credentials_store="file"` and `-c
  forced_chatgpt_workspace_id=[]` change nothing on an unplanted `codex
  app-server` and undo the planted values there, 2026-11-08.** Board task
  `a50cb16b`, codex-cli 0.153.4, the harness above with the seven
  `APP_SERVER_CONFIG_PINS` of main on, with and without the two, in both
  sign-in modes. Unplanted, `initialize`, `account/read`,
  `account/rateLimits/read` and `model/list` answered the same either way
  (stderr timestamps aside); the ChatGPT-mode child sent 12 CONNECTs to
  `chatgpt.com` at P either way and the API-key child none. Over a planted
  `"keyring"`, `"ephemeral"` or a workspace the token lacked, the child
  without them answered `account: null` and refused the rate-limit read as
  unauthenticated; with them it answered as unplanted. `"auto"` answered as
  unplanted either way. Caveat: fake tokens, one run per cell.

- **Through the app's own spawn, the sign-in pins put the panel's answers back
  over all four planted values, 2026-11-08.** Board task `a50cb16b`. Compiled
  `codexAuth.js` and `codexAccount.js` from the branch before and after the
  change, under `env -i`; `CODEX_BIN` a `/bin/sh` wrapper that passed the
  app's argv to codex-cli 0.153.4 unchanged and appended the stub issuer to a
  device login only; a fresh scratch `CODEX_HOME` per case and P as above.
  Unplanted, `"ephemeral"`, `"keyring"`, `"auto"` and a workspace the token
  lacked, each against `readAuthStatus` and `codexUsage` plus
  `listCodexModels` over both kinds of stored login, `signOut` over a ChatGPT
  one, and `submitApiKey` and `beginLogin` from signed out. Before the change,
  `"ephemeral"` read both logins as signed out and the model list as not
  signed in, `submitApiKey` was refused quoting `Successfully logged in` with
  nothing written, the device login wrote nothing, and `signOut` answered
  success and left `auth.json` in place. `"keyring"` errored every status
  read, both logins and `signOut` on `Platform secure storage failure`, and
  `"auto"` failed `signOut` the same way, leaving the file. The workspace read
  the ChatGPT login and its models as signed out and refused the device
  login. After it, every case answered as the unplanted one, `auth.json`
  written or removed as there; unplanted, the two builds answered the same.
  Caveat: `beginLogin`'s own answer was a refusal in every case, because the
  stub issuer's link is `http://127.0.0.1` and `extractDeviceLogin` accepts
  only OpenAI's hosts, so what was read is `auth.json` and the status after
  the child exited; fake tokens, one run per cell.

- **Every `workspace-write` or bypass Codex cycle writes `config.toml`, and so
  do the CLI's config editors; no child of the server does, 2026-11-08.**
  Board task `c15641cc`, codex-cli 0.153.4, a scratch `CODEX_HOME` per command
  with a made-up API key. The cycle's own argv (`exec --json
  --skip-git-repo-check --ignore-user-config -s workspace-write -c
  approval_policy="never"`) created the file at 0600 holding
  `[projects."<cwd>"] trust_level = "trusted"`, at +0.1 s, and so did
  `--dangerously-bypass-approvals-and-sandbox`, `-s workspace-write` alone and
  the same without `--ignore-user-config`. `-s read-only` (the plan and default
  modes) and a bare `exec` wrote nothing, and `-c
  projects."<cwd>".trust_level` set to `"trusted"` or `"untrusted"` did not
  stop the write. `codex mcp add`, `features enable`, `plugin marketplace add`
  and `plugin add` (TokenEconomizer's documented Codex install) wrote it too.
  `login status`, `login --with-api-key`, `logout`, the device login and
  `app-server`'s four reads wrote nothing. The write is a `.tmpXXXXXX` in
  `CODEX_HOME` renamed over the file: over a seeded file the inode changed,
  and a 0444 seed came back a 0600 file, so a mode on the agents' own file
  protects nothing. In this container `config.toml` is `node:node 0600`, 579
  bytes (`stat` only), which fits that writer; which command wrote it was not
  read. Caveat: no cycle reached a model; three earlier 25 s runs wrote
  nothing at all and were discarded, cause not found.

- **With that write failing, a cycle loads its repository's `.codex/config.toml`,
  and none does while it succeeds, 2026-11-08.** Same harness; the working
  directory held a `.codex/config.toml` naming an MCP server that appended a
  timestamp to a marker when started. While the trust write succeeded the
  server never started: 0 of 14 runs, three of them with the entry already in
  the file. With a directory at `config.toml`, which a cycle under
  `--ignore-user-config` never reads, it started 0.1–0.2 s into 15 of 15 runs;
  with `CODEX_HOME` made 0555 around a readable 0644 file, 2 of 2. Every run
  whose output was kept reached `turn.started` and said nothing about the
  failed write. Neither `-c projects."<cwd>".trust_level="untrusted"`, `--ephemeral`
  nor `-c project_root_markers=[]` kept it from starting. With the write
  failing, `mcp add` and `features enable` exited 1 with `failed to persist
  config … Permission denied … at path …/.tmpXXXXXX` and left the file as it
  was. A directory at the name also made `login status` answer `Error loading
  configuration: … is not a file`. That is why a root-owned `config.toml`
  (option 1 of board task `c15641cc`) was not built: every such cycle would
  start loading the repository's file. Caveat: neither failure is the one root's
  file makes, where the temporary file is created and the rename onto it is
  refused by the sticky bit; that the CLI takes the same branch then is
  inferred. Only an MCP server was observed; that the file's other keys apply
  too is inferred.

- **A second `CODEX_HOME` that shares `auth.json` by a link loses sign-outs and
  device sign-ins, 2026-11-08.** Option 3 of board task `c15641cc`. Scratch
  home S whose `auth.json` was a symbolic link to home A's. `login status` read
  A's key through it, and `login --with-api-key` rewrote A's file in place.
  `logout` removed only S's link and answered `Successfully logged out`,
  leaving A's credential. The device login through the stub issuer replaced the
  link with a file of its own in S and left A's key, so a cycle reading A never
  sees the new sign-in. With S not writable by the child, the API-key login
  still wrote A through the link and `logout` failed with `Permission denied`.
  Caveat: a token refresh through the link was not driven; one run per case.

## Not yet verified by hand

- **That the app-server pins hold against a real sign-in in a booted
  container.** Every measurement above used made-up tokens and refused
  CONNECTs. Settle as root in a container signed in to Codex: as the agent uid,
  put `chatgpt_base_url = "http://127.0.0.1:9/backend-api/"` and `openai_base_url
  = "http://127.0.0.1:9/v1"` in `$CODEX_HOME/config.toml`, keep a listener on
  port 9, load `/` and Settings → Codex, and expect the Codex windows and model
  list to read while the listener takes nothing; then remove the two lines.

- **Whether root's `config.toml` makes a cycle load its repository's file in
  a booted container.** The entry above emulated a failed trust write two ways
  and saw the repository's `.codex/config.toml` load both times; root's file
  fails the rename instead. Settle as root in a booted container: move the
  agents' `/home/node/.codex/config.toml` aside, `touch` it again, `chown 0:0`
  and `chmod 0644` it, then as the agent uid `mkdir -p /tmp/p/.codex && printf '[mcp_servers.probe]\ncommand = "sh"\nargs = ["-c", "id > /tmp/p/marker"]\n' > /tmp/p/.codex/config.toml && cd /tmp/p && codex exec --json --skip-git-repo-check --ignore-user-config -s workspace-write -c approval_policy=\"never\" "reply ok" < /dev/null`.
  A `/tmp/p/marker` means option 1 widens every such cycle, as emulated;
  none, with the cycle answering, means it does not and option 1 is open
  again. Then `ls -a /home/node/.codex | grep '^\.tmp'` to see whether the
  refused write leaves its temporary file behind.

- **What `/etc/codex/requirements.toml` and `/etc/codex/managed_config.toml`
  constrain.** Option 2 of board task `c15641cc`. The binary names both paths
  and `/etc/codex/config.toml`, and no environment variable that moves them,
  so a scratch copy cannot stand in; writing them needs root. Settle as root:
  plant `forced_login_method = "api"` and a `[marketplaces.x]` git source at a
  loopback listener in a scratch `CODEX_HOME/config.toml`, then write
  `/etc/codex/managed_config.toml` with `forced_login_method = "chatgpt"` and
  re-run `codex login status` and `app-server`'s four reads as the agent uid
  over a stored ChatGPT login; then the same with `/etc/codex/requirements.toml`
  naming `allowed_login_methods` and a marketplace allowlist (the field names
  are in the binary's strings, `ConfigRequirementsToml` and
  `MarketplaceRequirementsToml`). Record which file outranks the user file,
  whether either empties a planted table, and what a cycle under
  `--ignore-user-config` still reads from them.
