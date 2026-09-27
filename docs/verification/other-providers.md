# Verification: Other providers

[← Verification index](../verification.md)

## Verified

- **The Codex sign-in panel, end to end, 2026-09-05**, `codex-cli 0.153.4`,
  scratch `CODEX_HOME`, routes and Playwright: `login status` exits 1 both
  signed out and on a bad credential file; a device flow deletes the stored
  credential on start; `--with-api-key` exits 0 on empty stdin. The key
  reached no log, only `$CODEX_HOME/auth.json` (0600).

- **`runs.provider` and its admission refusals, 2026-09-05**, `npm start`:
  `provider TEXT`, nullable, cid 47, with `createRun`'s `INSERT` run for
  `'codex'` and `null`; four refused `POST /api/runs` each got their own 400
  sentence; both run-page labels rendered for seeded rows.

- **Codex device sign-in was driven against the real CLI up to approval.**
  `Logged in using ChatGPT` was read from a hand-written `auth.json` (unsigned
  JWT), not a real credential; the Settings row's poll arms and stands down
  around a cancelled flow, never a successful one.

- **The Codex CLI installs and runs on this image's base, measured on arm64
  only, 2026-09-05.** In `node:22-bookworm-slim`, `npm install -g
  @openai/codex@0.153.4` then `codex --version` prints `codex-cli 0.153.4`;
  279 MiB on disk. The binary arrives via `optionalDependencies` gated on
  `os`/`cpu`, so the Dockerfile block ends in a version check.

- **The Codex adapter's argv and spend handling, 2026-09-05.** Every flag it
  emits is in `codex-cli 0.153.4`'s `codex exec --help`; `codex execpolicy
  check` forbids `pkill node` under the app's `prefix_rule` spelling
  (`rule(...)` and `define_program(...)` do not parse); a seeded Codex run
  renders `148.2k` tokens against a dash, not `$0.00`, in the built app.

- **`CODEX_ACCESS_TOKEN` outranks a stored Codex credential, 2026-09-26**,
  `codex-cli 0.153.4`, scratch `CODEX_HOME` holding a key stored by
  `--with-api-key`: `login status` says `Logged in using an API key` (exit 0)
  without it and `Error checking login status: invalid agent identity JWT
  format` (exit 1) with it set to a non-JWT; blank is ignored. `OPENAI_API_KEY`
  and `CODEX_API_KEY` each left an empty home at `Not logged in`. No valid token
  was tried (no OpenAI account), so what a parsing one reports is unmeasured.

## Not yet verified by hand

- **No Codex device sign-in has been completed** (no OpenAI account): the
  exit-0 `auth.json` write, `loginError` on any failure and the poll
  converging are unmeasured; an unnoticed success reads `waiting for approval`.
  `CODEX_HOME` (unmounted `~/.codex` by default) lives in the container's
  writable layer, lost on a rebuild.

- **The image has not been rebuilt with Codex (2026-09-05)**: the amd64
  figures (~335 MB unpacked, 123 MB download) are registry metadata, no work
  cycle has run `codex`, signed-out is reasoned from `childEnv`'s strip, and
  `codex` under `UF_SANDBOX=1`, whose read-only binds may break `$HOME/.codex`,
  is untried.

- **No Codex work cycle has ever been spawned (2026-09-05)**; `codex login
  status` says "Not logged in". Unverified: argv acceptance, event names,
  `resume` taking the session id, `--output-last-message`, sandbox binding,
  notices as prompt text, a Codex wall, and above all a real cycle loading the
  rules file (a wrong dialect loads as zero rules): ask one to `pkill -f`.
