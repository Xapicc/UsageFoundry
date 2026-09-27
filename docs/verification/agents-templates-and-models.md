# Verification: Agents, templates and models

[← Verification index](../verification.md)

## Verified

- **Run templates, live dev server:** CRUD works and each refusal is a 400 with
  the form's sentence; a stored `bypassEverything` mode with a corrupt budget
  reads back as `plan` and one work cycle. Plus 20 `npm test` assertions.

- **Claude Opus 5.5 and Claude Sonnet 5 read off Anthropic's own pricing page,
  2026-09-24** (`platform.claude.com/docs/en/about-claude/pricing`, fetched).
  Opus 5.5: $4/MTok input, $20 output, 5m write $5, 1h write $8, cache hits
  **$0.20/MTok**, with the page's own footnote "Cache hits and refreshes on
  Claude Opus 5.5 are priced at 0.05x the base input price" — so the write
  multipliers are the unchanged 1.25x/2.0x and only the read departs. Opus 5
  stays $5/$25 and is still listed, not retired. Sonnet 5 is $2/$10 with a
  footnote that the $2/$10 "announced at launch as introductory pricing through
  August 31, 2026, is now the standard price. The previously scheduled increase
  to $3/$15 … on September 1, 2026 will not occur." Fast mode is $8/$40 for Opus
  5.5 against $10/$50 for Opus 5 / 4.8, and the page states that "prompt caching
  multipliers apply on top of fast mode pricing" — which is what puts
  `cacheReadMultiplier: 0.05` on the fast-mode row too, at $0.40/MTok. Caveat:
  read through `WebFetch`'s markdown conversion of the docs page rather than
  from an invoice, so it is Anthropic's published list price and not a measured
  charge; no request has been billed on Opus 5.5 from this install.

- **The `[1m]` model ids on the pinned 2.1.280 binary, 2026-09-24.** `npm pack
  @anthropic-ai/claude-code-linux-arm64@2.1.280` and `grep -a -o -E
  '[a-zA-Z0-9._@-]+\[1m\]'` over the unpacked 233 MB `claude`: sixteen distinct
  strings, of which **nine** are `claude-…` model ids and seven are the CLI's
  own short aliases (`opus[1m]`, `opusplan[1m]`, `fable[1m]`, `sonnet[1m]`,
  `sonnet-5[1m]`, `sonnet-4-6[1m]`, `sonnet-4-5-20250929[1m]`), which
  `ONE_MEGA_VARIANTS` does not carry and never did. Against the eight that list
  held, `claude-opus-5-5[1m]` is the single addition and every other entry is
  unchanged, the dated `claude-sonnet-4-5-20250929[1m]` included. `claude-opus-5-5`
  appears 41 times undecorated in the same binary, no snapshot suffix. Caveat:
  this is the **arm64** package, matching the container it was read in
  (`uname -m` → `aarch64`); the amd64 build of the same version was not read,
  and the pin in `Dockerfile` is the version rather than the arch.

- **The sandbox's config-directory binds re-read on the pinned 2.1.280,
  2026-09-27, and the bound set is not identical: one name was added.**
  `sandboxMountPoints.test.ts` threw at "the config-directory bind loop" against
  the installed `claude.exe` (`claude --version` → 2.1.280). The loop is still
  there in the same shape; the test hard-coded two minified names (`tl`, `SN`)
  and 2.1.280 renamed all five the loop uses. `Gy`/`jy`/`tf`/`zy`, which the
  board task suspected, are not the sandbox. They are byte-identical in 2.1.260
  and belong to the Bash script-path classifier, where `zy` marks a dotfile,
  `tf` a dot-directory other than `.claude*/` or `.config/` (`private_dotdir`)
  and `jy` a path under one of `Gy`'s five data directories. None of them binds
  anything. With every identifier now discovered, the extraction run over
  `npm pack @anthropic-ai/claude-code-linux-arm64@2.1.260` and over 2.1.280
  differs by one name, `policy-limits.json.stamp.json`. It is a file, named by a
  third sidecar function (`${e}.stamp.json`) spread into the list. Every name
  2.1.260 bound is unchanged, file or directory. The stamp went onto
  `SANDBOX_CONFIG_DIR_REFUSED`, because 2.1.280 reads an empty stamp as
  `unusable` rather than `absent` and marks the policy cache's HIPAA history
  incomplete. The test was watched to fail four ways: against 2.1.260, with the
  stamp dropped from the list, against a copy of 2.1.280 with the loop's bytes
  altered, and against a copy naming an undefined sidecar function. Caveat: this
  is arm64 only. The twelve project-`.claude` names are still outside the
  test's extraction, so the claim that they are unchanged rests on reading both
  binaries by eye.

- **The `remote-settings.json` "Unable to find … in mount table" failure is not
  a missing mount point, read 2026-09-27.** The transcripts under
  `~/.claude/projects` hold two real events, both solo `Bash` calls in a dockrac
  worktree: 2026-09-20T18:06Z on 2.1.260 and 2026-09-26T17:02Z on 2.1.280. In
  both the bind source is `/oldroot/home/node/.claude/remote-settings.json`, the
  file itself, so the CLI found it present and emitted the self-mount form, and
  bwrap failed after the bind rather than on a create. The code that binds it is
  the same in both versions. So it does not follow from 2.1.280, and
  pre-creating in `sandboxMountPoints.ts` cannot touch it. The same wording also
  appears on tree-root dotfiles (`/workspace2/.zprofile`) and on
  `config.worktree`. Caveat: the cause was not established. A rewrite of the
  file between bwrap's bind and its mount-table lookup fits the message but was
  not measured, and the file's current mtime (2026-09-26 22:27Z) postdates the
  failure, so the question cannot be settled from what is on disk now.

- **That failure is a delete-and-recreate race, not a rename, measured
  2026-09-27 against bwrap 0.8.0 and CLI 2.1.280.** bwrap looks its bind target
  up in `/proc/self/mountinfo` right after binding it. The message means the
  path's directory entry was replaced in between, which detaches the bind. A
  nested `bwrap --ro-bind f f` reproduced it word for word: 462 of 1,000 starts
  against a rename-over loop, 155 of 400 on the `~/.claude` virtiofs share, and
  357 of 1,000 against unlink-then-recreate. It failed 0 times in 1,400 against
  in-place writes, 0 in 1,000 each against sibling churn and a `stat` loop on
  the share, and 0 in 300 with no writer. Only unlink-then-recreate also gives
  "Can't get type of source: No such file". This install's transcripts show
  that wording on the file twice (2026-09-20, 09-26), alongside the three
  mount-table-family events and "Can't create file" as late as 09-25, so the
  file keeps vanishing. Neither 2.1.260 nor 2.1.280 renames it: both write it
  in place (`open(…, "w")`). It is deleted by the auth-change cache clear and
  by the sandbox's placeholder cleanup, which unlinks any zero-byte file at a
  path its process covered with `/dev/null`. It is recreated by bwrap's
  placeholder create or by the CLI's first write. `~/.claude` is listed twice
  in a sandbox's mount table, but so is `/workspace2`, so that is the
  read-only root bind with the write allowlist's bind on top, not the share.
  The race also fails on overlay, where nothing is stacked. Nothing in this app
  can prevent it. Pre-creating the file is refused in
  `SANDBOX_CONFIG_DIR_REFUSED`, and an empty file there is exactly what that
  cleanup deletes. The cost is one tool call, and the file has been stable
  since it regained content (inode and mtime unchanged 07:57 to 08:17Z). Caveat:
  which deleter fired at each event is inferred. Logging
  `stat -c '%i %s %Y' ~/.claude/remote-settings.json` through the next spell
  when it is missing would settle that.

- **A replacement also strips the read-only bind from sandboxes already
  running, measured 2026-09-27 on bwrap 0.8.0.** A nested sandbox binding a
  file read-only under a read-write bind of its directory could not write the
  file until something outside renamed over it. After that the bind was gone
  from its mount table and the write succeeded. It happened live at 08:08:44Z:
  this session's own Bash sandbox lost its bind on `~/.claude/.config.json`,
  whose mtime is that same second. Caveat: the writer was not identified, the
  deny list is the CLI's and not this app's, and nothing here was changed for
  it.

- **Which deny-listed `~/.claude` files the CLI replaces by rename, and whether
  that widens anything, read off CLI 2.1.280 on 2026-09-27.** By rename, so the
  bind strips: the global config (`.config.json` at its legacy path, else
  `.claude.json`) and `settings.json` through `vv` (temp file beside the target,
  or in `.cc-writes` for `settings.json`), and `.credentials.json` and
  `policy-limits.json.stamp.json` through `cQ` (byte 190881839). In place, so the
  bind holds: `remote-settings.json` (`open(..., "w")`, byte ~203301020),
  `policy-limits.json` (`writeFile`, byte ~203076400) and the `.signature.json`
  sidecars; both halves of the earlier reading stand. Live: a scratch home's
  `.config.json` changed inode (53037914 to 53037957) across its first
  `claude -p`, with nine "written atomically" debug lines, and a nested
  `bwrap --ro-bind` on it refused a write until that rename and allowed it after;
  a second run rewrote nothing. Only `settings.json` would widen a later cycle,
  being the honoured source for `sandbox.filesystem.allowWrite` and permissions
  (`orchestrator.ts:5497-5507`), and neither run rewrote it: its inode held
  across both. The global config does get rewritten, but the eleven
  permission-rule sources (byte 193336360) do not include it, so the legacy
  `projects[cwd].allowedTools` it still parses (byte 192721656) grants nothing;
  what its lapse opens is an `mcpServers` entry a later work cycle would load,
  since that argv carries no `--strict-mcp-config` (`cycleInvocation.ts:1188`).
  `.credentials.json`'s lapse exposes a read, not a widening. Against the open
  "No sandbox has ever honoured the per-run write set": with
  `UF_LOCK_CLAUDE_HOME` unset `settings.json` is agent-writable anyway, so the
  lapse adds no route; with it set the directory is root-owned 0750
  (`docker-entrypoint.sh:705-707`), no rename into it can succeed from the
  agent's uid, and `vv` falls back to writing in place, which keeps the bind.
  Caveat: both runs were unauthenticated and stopped at "Not logged in", so an
  authenticated cycle's writes were not watched, and the locked half is read
  from the writer rather than run, like the lock itself.
  `docs/agent/security.md` states no guarantee that these binds hold.

- **`--agent` / `--agents`, seven probes on CLI 2.1.226:** `--agent` selects a
  definition passed on the same argv, exits 1 on an unregistrable one, keeps
  `--append-system-prompt`, survives `--resume`, and yields to the run's
  `--model`.

- **The `settings.json` `agent` key is real and deliberately not declared,
  CLI 2.1.226:** `--agent` outranks it, `--agents` does not, and a bad value is
  silently ignored at exit 0; it reaches every child started with no agent.
  Four probes, throwaway `CLAUDE_CONFIG_DIR`, `-p "Say hello."`:

  | settings.json | argv | answer |
  |---|---|---|
  | no `agent` key | — | `Hello! 👋 What can I help you with today?` |
  | `"agent": "uf-set-probe"` | — | `BANANA` |
  | `"agent": "uf-set-probe"` | `--agent uf-set-probe2` | `CHERRY` |
  | `"agent": "uf-set-probe"` | `--agents '{"uf-offered":{…}}'` | `BANANA` |
  | `"agent": "uf-set-typo"` | — | `Hello! 👋 …`, exit 0 |

- **The model catalogue in a browser and over HTTP, 2026-09-08**, `next
  start`, throwaway `DATA_DIR`: thirty rows render, a typed `acme-model-9[1m]`
  adds, the last enabled switch is `disabled`, both `#model` selects list
  Inherit first; `PUT /api/settings` stores `claude-opus-5[1m]` intact, and
  settings and runs refuse disabled or unknown models with a sentence.

- **A template's model (added 2026-09-04) works up to the planners.** Migration
  checked by hand on a pre-change database; dropping the inherit in
  `planProposal`/`planNode` fails 6 tests; routes (auth on) trim, null blanks,
  clear on `PUT ""`; the form (Chromium, auth off) seeds it and overrides it per
  run. `npm test` 2,136 tests / 0 failures.

- **Per-run model (added 2026-09-04) rendered on `next dev`, on planted rows.**
  `/runs/new` draws the field under *Folder* with placeholder
  `Claude Code's own default`; `/runs/[id]` reads `This run`/`Its agent` for a
  set and a NULL model. `npm test` 2,123 tests / 0 failures. `next dev` there
  needs `NODE_ENV=development` set explicitly.

- **The routes under the new-run form's template UI**, exercised directly.

## Not yet verified by hand

- **An empty agent name and a non-JSON `--agents` payload were not
  re-measured under `--agent`.**

- **No run has started on a `[1m]` id and no model has read the MCP `enum`.**
  Unread: the spawned argv for `claude-opus-5[1m]` (brackets could be
  normalised away with no test failing), whether chat picks off the enum and
  `"inherit"` lands as null. Not run for it: `docker compose up --build` (no
  Docker), `smoke-pages` (the container's mount broke `npm run build`).

- **No template's model has reached a real `--model` on a spawn**, since a run
  here starts a billed agent. `docker compose`, narrow viewports and the sign-in
  path are also unchecked.

- **A per-run model has never reached `--model` on a real spawn**, nor the CLI
  run on it. Also unchecked: the placeholder with a default set, the copied-run
  seed carrying `run.model`, `docker compose`, narrow viewports, and sign-in (it
  ran with `UF_ALLOW_NO_AUTH=1`).

- **The new-run form's template UI, in a browser**: only the client wiring
  (loading, *Start another like this*, the two banners) is unconfirmed.

- **Everything about a saved agent that is not one of the seven probes.** No
  child has been spawned with `--agent` or `--agents` from this app, no browser
  has rendered its UI, and no request has written `/api/agents`. Open under
  `--agent`: the two `--agents` drops, turns' agent name, delegation; and
  whether a member's `tools` beats the `PROCESS_KILLERS` deny.

- **The `settings.json` `agent` key: measured, and deliberately not
  declared.** Declaring it needs a read in `agents.ts`, a field on
  `GET /api/agents`, and copy probably on the Settings page rather than under
  the picker, since choosing an agent there overrides the key.
