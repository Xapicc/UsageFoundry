# Verification: Container and environment — the stacks carrier, its installs, receipts and invocation counts

[← Verification index](../verification.md)

## Verified

- **The stacks carrier, end to end against the running container, 2026-09-12**
  (`docker compose up --build` on this install, arm64). One declaration,
  `stacks/shell-lint/stack.json` — the two-publisher example from
  `proposals/CustomStacks/01g-third-party.md` §6, exercising every branch the
  `archive` verb has at once: two steps, `tar.gz` and `none`, per-architecture
  `sha256` rather than a publisher manifest, and both `{arch}` and
  `{arch_uname}` in one file. The boot log read
  `stacks: 1 declared in /etc/uf-stacks`, `stack shell-lint: installing
  (archive, archive, 2 steps) — no receipt`, `installed, 2 binaries, 1 denied`,
  `stacks: 1 ok, 0 failed`. Afterwards: `/var/lib/uf-stacks/bin` held
  `shellcheck` and `shfmt`, both `root root 0755`; `state/shell-lint` was
  `1000 1000 0775`; `PATH` began `/var/lib/uf-stacks/bin:/home/node/pytools/bin:…`;
  and `shellcheck --version` and `shfmt --version` both answered from inside the
  container. Both architecture spellings resolved correctly in the same boot —
  the receipt records `shellcheck-v0.11.0.linux.aarch64.tar.gz` beside
  `shfmt_v3.14.1_linux_arm64`. **This is the first thing in this repository to
  put a binary on an agent's `PATH` without a `Dockerfile` edit.**

- **The stacks group on Settings, in a browser against the running container,
  2026-09-12.** `/settings#tools` on this install drew the group between
  *gh extensions* and the footnote, two rows sharing the `shell-lint` name and
  differing only in their command, each `unverified` with the path it resolved
  to and *"Nothing has invoked it since this stack was installed"*. No console
  error. `npm run smoke-pages` cannot reach this state — the receipts live at
  `/var/lib/uf-stacks/receipts`, an absolute container path, and that pass runs
  on the host — so a browser against the real container is the only thing that
  settles it. It also caught the section's lede still claiming every count was
  over the retention window, which stopped being true for a stack the moment
  the install floor landed.

- **A checksum mismatch stops the stack and nothing else, 2026-09-12.** A second
  declaration was added carrying a deliberately wrong `sha256` against a real
  URL. The boot log read `stack bad-digest: failed —
  shfmt_v3.14.1_linux_arm64 does not match its checksum` and then
  `stacks: 1 ok, 1 failed`; nothing was unpacked, nothing was linked, the stack
  beside it installed, and the container came up healthy. The receipt carried
  the applier's own text verbatim — three lines of `sha256sum` output, 98 bytes,
  uncapped — and `/api/tools` drew that stack `failed` with the same sentence.
  `/api/status` read `{ declared: 4, notOk: 1 }`: counts and no names, which is
  `status.ts:23-28`'s closed rule holding across a source that carries
  operator-chosen text.

- **A second boot costs no network, 2026-09-12.** `docker compose restart` with
  the declaration unchanged printed `stack shell-lint: receipt matches,
  skipped`. That is R4a: a rebuild does not re-download, which matters because
  the failure this whole mechanism exists to end is a rebuild handing an agent
  `command not found`, and a design that re-downloads every boot reproduces it
  whenever the network is slow.

- **`reconcile` removes only what its own receipt records, against a real
  volume, 2026-09-12.** A file was created by hand at
  `/var/lib/uf-stacks/bin/hand-installed`, the declaration directory was moved
  away, and the container restarted. The log read `stack shell-lint: no longer
  declared, removed`; `bin/`, `pkg/`, `state/` and `receipts/` were emptied of
  everything that stack owned, and `hand-installed` was still there. This is the
  one rule here whose breach is unrecoverable, and it is now observed rather
  than reasoned.

- **A stack's invocation counts had to be floored at its install, and the
  defect was found by shipping it, 2026-09-12.** On the first read-back after
  the stack installed, `shellcheck` composed to `installed` on 20 `Bash` calls
  in the retained 30-day window — against a binary four minutes old. The calls
  were real and said nothing about it: a command name outlives an install of it.
  `invocationCounts` now takes a per-name floor, set from the receipt's
  `appliedAt` for stack rows and from nothing for the two `.env` lists, which
  record no such instant. Re-measured after the fix: both rows read `unverified`
  with *"Nothing has invoked it since this stack was installed"*, which is the
  window the number was actually taken over. `01f-read-back.md` §7's first rule
  — *"the only evidence that a tool works is a run that used it"* — is what this
  was violating.

- **`unverified` drawn against a real install, 2026-09-12.** The two rows above.
  It was on the *Not yet verified* list from the day phase 1 shipped, because
  the one declared tool on this install had 996 calls behind it.

- **`uv-tool` and `npm-global` install and run, in the shipped image,
  2026-09-12.** The phase 3 applier was run inside the running container against
  a scratch declarations directory and a scratch root, so the live install's own
  toolbox was untouched: `uv-tool ruff==0.14.1` and `npm-global cowsay@1.6.0`,
  two stacks, `2 ok, 0 failed` in 2.1 seconds wall clock for both — against a
  per-step ceiling of 45s and a whole-run budget of 120s, so the budget that was
  sized for `archive` has room for these. Both binaries then ran under
  `setpriv --reuid=1000 --regid=1000 --clear-groups` with only the toolbox's
  `bin/` on `PATH`: `ruff --version` printed `ruff 0.14.1` and `cowsay` drew its
  cow. Everything under `pkg/` was `root:root`, which is the uid split holding
  for a verb that executes the package's own install hooks as the agent.

- **`UV_TOOL_DIR` had to be redirected as well as `UV_TOOL_BIN_DIR`,
  2026-09-12.** `01b-` §2.1 names only the bin directory. Measured in the same
  run: with both redirected, `bin/ruff` resolves to
  `pkg/py-lint/tools/ruff/bin/ruff` and `/home/node/pytools/tools` does not
  exist. `Dockerfile:282` sets `UV_TOOL_DIR=/home/node/pytools/tools` and the
  applier inherits it, so redirecting one of the two would have put the tool's
  environment in the volume the *agents* own and write, under a launcher on the
  **server's** `PATH` — the arrangement `01a-` §2.2 refuses — and left it behind
  on removal, where no receipt records it and `reconcile` may not touch it.

- **An npm bin is a symlink into its package tree, and copying it breaks the
  command, 2026-09-12.** `npm install -g --prefix` wrote
  `pkg/node-cli/bin/cowsay` as a link to
  `pkg/node-cli/lib/node_modules/cowsay/cli.js`. `install -m 0755` follows a
  symlink, and the copy made that way threw
  `node:internal/modules/cjs/loader` on its first relative `require` — the
  entry file alone in a directory with none of its siblings. So the link step is
  keyed on the verb: `archive` copies a self-contained executable and the two
  package verbs symlink. A `uv` console script survives being copied — its
  shebang is absolute — and is linked the same way anyway, because two link
  rules with an exception is one rule nobody would find.

- **Both new failure paths write a receipt an operator can act on, 2026-09-12.**
  A `uv-tool` step naming a command the package does not ship wrote
  `failed` with *"ruff==0.14.1 installed but left no command called \"rufff\""*
  — the branch that exists because both tools exit 0 having installed a package
  whose console script is named something else. An `npm-global` step naming an
  unpublished package wrote `failed` carrying npm's own `E404` text verbatim.
  Neither linked anything, and the stack beside each was unaffected.

- **`uv-tool` at boot, through the entrypoint, 2026-09-12.** A `py-lint` stack
  declaring `uv-tool ruff==0.14.1` was put in `./stacks` and
  `docker compose up --build` run against this install. The boot log read
  `stacks: 2 declared`, `stack py-lint: installing (uv-tool, 1 step) — no
  receipt`, `stack py-lint: installed, 1 binary, 1 denied`, `stack shell-lint:
  receipt matches, skipped`, `stacks: 2 ok, 0 failed`. **763 ms** between the
  first line and the last, with the server ready 1.2s after that and the
  container `(healthy)` — against `Dockerfile`'s 180-second `--start-period`,
  which is what the applier's budgets were sized for. The agent uid then
  resolved `ruff` to `/var/lib/uf-stacks/bin/ruff` and `ruff --version` printed
  `ruff 0.14.1`.

- **A `uv-tool` stack removed is removed whole, 2026-09-12.** The declaration
  directory was deleted and the container restarted: `stack py-lint: no longer
  declared, removed`, and `bin/` and `receipts/` were left holding `shell-lint`'s
  three files and nothing else. `reconcile` has now been observed removing a
  `uv` virtual environment, not only an unpacked archive — the second is a
  directory tree the applier wrote, and the first is one `uv` wrote inside it.

- **`GET /api/stacks/[name]` and the detail page, against real receipts,
  2026-09-12.** Unauthenticated the route is 401 and the page redirects to
  `/login`, which is the gate holding with no exemption. Authenticated, the `ok`
  receipt renders as four cards — what happened, the install steps, what it put
  on `PATH`, what a work cycle may not run — with the toolbar reading `Stack`
  and Settings still lit in the sidebar. A **failed** stack was then declared
  deliberately (an unpublished npm package) and its page drew npm's nine lines
  of `E404` verbatim in the *What the step said* card, with *Nothing is linked*
  under it. No console error on either. A name no receipt claims answers 200
  with `absence.kind = "missing"`, and `/api/stacks/%2e%2e%2f%2e%2e%2fetc%2fpasswd`
  answers the same way — the name is matched against what `readReceipts()`
  returned and is never joined onto a path.

- **The failed stack's row on Settings was carrying the whole 4 KB, 2026-09-12.**
  Found by looking at the page above: the Tools row for `bad-pkg` drew all nine
  lines of npm's error as its description, which is `01e-` §2.1's *"a row that
  can hold 4 KB of stderr has stopped being a row"* — the defect the detail
  route exists to fix. It was correct while phase 2 had nowhere else to put the
  text. `unappliedStackRow` now takes the first line, which is the applier's own
  sentence ahead of the tool's stderr, and says *"Open the stack for what the
  step said."* Re-measured: two lines and a link.

- **The server holds both tool-list variables, and uv's launcher directory is
  first on `PATH`, 2026-09-12.** Read off PID 1 of the running container:
  `UF_GH_EXTENSIONS=Xapicc/gh-layer10`, `UF_PY_TOOLS=` (blank), and
  `PATH=/home/node/pytools/bin:…`. Both were previously reasoned from
  `docker-entrypoint.sh:853` unsetting only the two `DISCORD_*` names before
  `exec "$@"` at `:1223`, and from `Dockerfile:281`; they are now observed. This
  is what makes `toolInventory.ts` reading `process.env.UF_PY_TOOLS` on the
  server legal — and it would be empty in any agent child, which `childEnv`'s
  `UF_` strip guarantees and no test yet asserts.

- **A `gh` extension is not a binary on `PATH`, and its `manifest.yml` is an
  exact join key, 2026-09-12.** In the running container,
  `/home/node/.local/share/gh/extensions/gh-layer10/` holds the executable
  `gh-layer10` and a 0600 `manifest.yml` reading `owner: Xapicc`,
  `name: gh-layer10`, `tag: v0.1.0`, `ispinned: false`. So a declared
  `owner/repo` joins to the directory by name with no derivation — the thing
  `docker-entrypoint.sh:191-194` declines to do against `gh extension list`
  output — and the manifest additionally carries the tag gh *installed*, which
  is what makes the drift `.env.example:229-232` describes (a moved `@tag` is
  deliberately not reinstalled) visible for the first time. Caveat: a manifest
  is written for a precompiled extension; a git-cloned one may have none, and
  that case has not been seen here.

- **`run_events` carries a Bash command at two different JSON paths depending on
  the kind, 2026-09-12.** Counted over the whole table on this install: of 2,249
  `tool_error` rows, 2,249 have `$.command` and **0** have `$.input.command`; of
  52,051 `tool` rows it is exactly the other way round. Payload keys are
  `["name","input"]` with `input: ["command","description"]` for `tool`, and
  `["name","command","text","toolUseId"]` for `tool_error`. A reader that treats
  them alike counts zero failures for ever. `proposals/CustomStacks/01f-` §2.4
  said failures are counted *"the same way"* as calls, which is the shape this
  corrects.

- **A leading-prefix test over those commands has 10.5% recall, 2026-09-12.**
  Run with the shipped `commandPositionNames` over the 30-day window on this
  install — 53,833 `Bash` rows of 96,206 `tool`/`tool_error` rows — **105
  commands begin `gh ` against 1,000 that invoke it at a command position**, and
  3,282 commands do not begin with a bare binary name at all. `git` is found at
  a command position 6,765 times. The matcher takes the head of the string and
  of each segment after `&&`, `||`, `|`, `;`, `&`, a bracket or a newline, steps
  over a leading `VAR=value` and reduces an absolute path to its basename. It
  still misses a wrapper script, a shell function and a quoted `sh -c`, and it
  over-counts a tool's name quoted after a `;`; neither has been sized. **An
  earlier reading of 697 and 13% is superseded** — it came from a throwaway
  regex in a shell rather than from this function, and had no `Bash` filter.

- **The observed query's cost, and why it is not SQL, 2026-09-12.** On the
  204 MB database: the bare scan extracting the command is 95 ms; each name
  matched in SQL adds about 130 ms (1 name 226 ms, 5 names 742 ms, 10 names
  1,444 ms), while one `.iterate()` pass matching all ten in JS is 308 ms and
  flat in the number of names. `better-sqlite3` is synchronous, so the SQL shape
  is over a second of blocked event loop on the server that also admits runs.
  `iterate` rather than `all` also keeps peak memory at one row against the
  18.5 MB of command text the window holds. `run_events` has no index that helps
  — `idx_run_events_run` is `(run_id, id)` and `idx_run_events_sandbox` is
  partial on `kind = 'sandbox'` — which is the trade `01f-` §4 argued for and
  this is the measurement behind it.

## Not yet verified by hand

- **Only `archive` has ever run.** `uv-tool` and `npm-global` are in the format
  and refused by name at parse in this build, so the two verbs that execute a
  package's install hooks have never been exercised — which is deliberate:
  `archive` executes nothing at install time, and shipping the other two in the
  same commit as the carrier would have meant the first thing this mechanism
  ever did was run a stranger's code.

- **A stack's `env` has reached the server but not yet an agent.** The write and
  the merge are measured — see *Container and environment* — and what is left is
  the last hop: `childEnv` copying it into a child. It strips nothing that
  matches `SWIFTPM_CACHE_DIR` and is unit-tested for `PATH`, so this is reasoned
  rather than observed. `docker compose exec` cannot settle it, being a
  different process tree; it needs a real agent child and something that reports
  its environment.

- **Two stacks claiming one binary name has never happened outside a unit
  test.** `reconcile` marks both `conflicted` and links neither, which is
  asserted over the function; no boot has produced it. The same is true of the
  applier's whole-run time budget: no install here has come close to 120
  seconds, so the *not attempted* receipt that budget writes has never been
  written by a real boot.

- **`/var/lib/uf-stacks/bin` has no `unclaimed` reading.** A binary in the
  stacks toolbox that no receipt claims is invisible on the page — the
  *claimed by no entry* list walks uv's launcher directory and the gh extensions
  volume and not this one. Measured on 2026-09-12 by creating
  `bin/hand-installed` by hand: it survived the removal that took the stack
  beside it, correctly, and appeared nowhere in `/api/tools`. That list is the
  last phase of `proposals/CustomStacks/21-implementation-sketch.md`.

- **No Python tool has been installed while the Tools section could read it.**
  `UF_PY_TOOLS` is blank on this install and `/home/node/pytools/bin` is empty,
  so the row a declared Python tool draws has never been seen, and neither has
  the one case `toolInventory.ts` is known to over-report: a package whose
  console script is named something other than the package lands in the
  *claimed by no entry* list, because a declaration carries only the package
  name and `docker-entrypoint.sh:280-281` parses it *"only to ask whether it is
  already installed"*. Settle with a throwaway container:
  `UF_PY_TOOLS="rich-cli httpie"`, then `ls /home/node/pytools/bin` and compare
  the listing against the two declared names.

- **Only a precompiled `gh` extension has been seen, never a script one.** The
  one extension here is a binary release carrying a full `manifest.yml`, and
  `toolInventory.ts` now prefers that manifest's own `path:` over
  `<dir>/<dir-name>`. Whether `gh extension install` of a **script** extension
  writes a manifest at all, and where it puts the executable, is unmeasured —
  and if there is no executable at either path, every script extension reads
  `failed`. Settle with
  `gh extension install vilmibm/gh-screensaver` in a throwaway container, then
  `ls -la /home/node/.local/share/gh/extensions/gh-screensaver/`.

- **`docker compose up -d` against a running container has never been seen to
  apply a stack.** Every boot recorded above was `docker compose up --build` or
  `docker compose restart`, and `docs/install.md`, `01b-stack-format.md` §5 and
  `StackRequestDetail.tsx`'s card say `restart` for that reason. The applier
  runs only from `docker-entrypoint.sh`, and a file added under the
  bind-mounted `./stacks` changes nothing compose compares, so `up -d` is
  expected to leave the container `Running` and apply nothing — reasoned, not
  observed. Settle on a running install: add `stacks/<name>/stack.json`, run
  `docker compose up -d`, and check `docker compose logs usagefoundry` for a
  `stack <name>:` line and `/var/lib/uf-stacks/receipts/<name>.json` for a
  receipt; then the same with `docker compose restart`.
