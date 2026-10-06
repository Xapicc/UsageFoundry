# Environment gotchas

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing docker-compose.yml, .env, Dockerfile, src/lib/config.ts.**

Each paragraph now lives in the topic file its heading links to: find the rule by its claim below and open that one file. A line number cited elsewhere as `docs/agent/environment.md:N` counts lines of this file before it was split on 2026-09-27; each entry ends with the line its paragraph started on at the split, and a citation older than that may be off by a few lines.

## [Workspace mounts, bind mounts and the agent uid](environment/workspace-and-bind-mounts.md)

- The app reads `WORKSPACE_ROOTS` (multiple mounts, `Label=/path` entries joined by `|`) and falls back to the single `WORKSPACE_ROOT` when it is unset. (was line 10)
- An entry in `WORKSPACE_ROOTS` with an *explicitly empty* label (`=/workspace2`) is **skipped**, while a bare path (`/workspace2`) is labelled from its basename. (was line 11)
- `UF_WORKSPACE` and `HOME` use compose's `${VAR:?message}` form, so a missing one aborts `docker compose up` instead of substituting. (was line 26)
- `CLAUDE_HOME` (default `~/.claude`) determines which transcripts are parsed; `DATA_DIR` (default `./.data`) holds the SQLite file. (was line 12)
- `UF_BACKUP_DIR` (default `./backups`) is bind-mounted at `/backups`, and being a bind mount rather than the named volume is the whole of it: a snapshot kept inside `usagefoundry-data` is destroyed by… (was line 13)
- `UF_STACKS_DIR` (default `./stacks`) is bind-mounted **read-only** at `/etc/uf-stacks`, and like `UF_BACKUP_DIR` above it is compose's variable and reaches the entrypoint never — so `C8`'s four-files… (was line 14)
- `UF_AGENT_UID`/`UF_AGENT_GID` in compose exist because the container writes to both bind mounts, and they carry `${UF_UID:-1000}`/`${UF_GID:-1000}` — the same numbers `user:` used to carry for the… (was line 30)

## [Boot checks, auth and credential variables](environment/boot-checks-and-credentials.md)

- All process-level config is centralised in `src/lib/config.ts` and fixed at boot. (was line 17)
- The configuration is checked before the server serves, and exactly one check refuses. (was line 24)
- `UF_AUTH_TOKEN` blank disables auth entirely, and the app now **refuses to boot** in that state unless `UF_ALLOW_NO_AUTH=1` says the operator meant it — `authBootSignal` in `authGuard.ts` is that… (was line 15)
- `UF_BIND_ADDRESS` (default `127.0.0.1`) is compose-only — the app never reads it, so it is outside everything `configCheck.ts` can say. (was line 25)
- `UF_TRUSTED_PROXY_HOPS` (default 0) has to describe what is actually in front, and nothing here can check it.
- `UF_GITHUB_TOKEN` blank means runs cannot use GitHub at all, and the Settings header says so — the failure otherwise arrives mid-run, inside a tool call nothing here reads. (was line 16)
- Rotating any of these is a container restart, and *which* of them a restart is the only answer for is the part worth knowing. (was lines 18–23)

## [Memory, heap and process limits](environment/memory-and-process-limits.md)

- `mem_limit` / `memswap_limit` / `pids_limit` / `cpus` in compose exist because memory here is linear in `maxConcurrentRuns` and `maxConcurrentAssists`: every work cycle is a full Claude Code process… (was line 27)
- `NODE_OPTIONS` states the server's heap ceiling so the term of that arithmetic belonging to this process is a number rather than a property of the host — V8 derives it from the machine's RAM… (was line 28)
- `MALLOC_MMAP_THRESHOLD_` / `MALLOC_TRIM_THRESHOLD_` sit beside `NODE_OPTIONS` and are the counter-example to it: they are **not** stripped from any child environment, deliberately. (was line 29)

## [The CLI sandbox and the locked Claude home](environment/sandbox-and-claude-home.md)

- `UF_SANDBOX`, `UF_SANDBOX_ENFORCEMENT` and `UF_SANDBOX_ALLOWED_DOMAINS` are the CLI's own Linux sandbox, and all three are consumed **entirely by `docker-entrypoint.sh`** — nothing in `config.ts`… (was line 34)
- `UF_LOCK_CLAUDE_HOME` is the other half of that sandbox and a **separate switch on purpose**, also read only by `docker-entrypoint.sh`. (was line 35)

## [What the image carries: the Claude CLI, gh, Playwright and Codex](environment/image-binaries.md)

- The image carries `gh` (`ARG GH_CLI_VERSION`, checksum-verified release tarball rather than an apt source) for the same reason it carries a compiler: an agent asked to open a pull request finds out… (was line 31)
- The image pins `@anthropic-ai/claude-code` (`ARG CLAUDE_CLI_VERSION`) and sets a system-wide git identity. (was line 33)
- Playwright and one Chromium are in the image, and nothing configures them. (was line 41)
- The Codex CLI is in the image, and this app spawns it as `CODEX_BIN`. (was line 43)

## [Tools installed at boot or build: Go, gh extensions, winnow and Python tools](environment/boot-installed-tools.md)

- The image no longer carries Go — it moved to `stacks/go/stack.json` on 2026-09-12, an `archive` step fetching the same `dl.google.com/go/` release against the same published digest, linked into the… (was line 32)
- `UF_GH_EXTENSIONS` names the `gh` extensions an install wants, and `docker-entrypoint.sh` installs them at boot into `usagefoundry-gh`, the **third named volume** — mounted at… (was line 36)
- `WINNOW_REF` and `WINNOW_REPO` are **build arguments, not environment variables**, and that is the whole difference between them and `UF_PY_TOOLS` beside them. (was line 37)
- `UF_PY_TOOLS` is that mechanism a second time, for Python, and the reason it exists is a *plugin* rather than an agent. (was line 39)

## [The Discord relay's variables](environment/discord-relay.md)

- `DISCORD_WEBHOOK_URL` is the one variable in this file that is deliberately absent from the process it configures. (was line 45)
- `RELAY_PORT` and `RELAY_BIND` are the relay's own two, and they are forwarded for the reason nothing about them is interesting: the relay is a second process started by the entrypoint with no… (was line 47)
- The adjacent temptation, refused: the entrypoint does **not** fill in `UF_WEBHOOK_URL` when `DISCORD_WEBHOOK_URL` is set and it is blank. (was line 49)
