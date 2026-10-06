# Verification: Security and sandboxing — a stack's tool grants and permissions

[← Verification index](../verification.md)

## Verified

- **`acceptEdits` refuses a binary the CLI has never seen, and `--allowedTools`
  is sufficient to unrefuse it. 2026-09-12, CLI 2.1.260.**
  `proposals/CustomStacks/01c-` §4's probe, run verbatim against this install: a
  `probetool` shell script was put on a directory on `PATH`, confirmed runnable
  by the agent uid directly (`probetool 9.9.9`), and asked for through two
  headless `claude -p` turns as uid 1000 differing only in the last flag.
  **Without a grant it is refused** — one `Bash` call, then a `system` event
  `subtype: permission_denied`, `decision_reason_type: "other"`,
  `decision_reason: "This command requires approval"`, and a `tool_result` with
  `is_error: true`; the turn ended `success` having run nothing, and the model's
  own closing words named the fix (*"pre-allow it (e.g. a `Bash(probetool)`
  entry"*). **With `--allowedTools 'Bash(probetool:*)'` it runs**, first call,
  `is_error: false`, `probetool 9.9.9`. $0.25 and $0.11.

  That is row 2 of `01c-` §4's table: the grant is **necessary and sufficient**,
  and the assumption the design was built on — *"a binary the CLI has no model
  of is not obviously in [the read-only shell] class, so the working assumption
  here is that it is refused"* — was right. **Phase 4 exists**, and a stack that
  installs perfectly and grants nothing is the quiet failure `01a-` §8 names,
  now observed rather than predicted. Caveat: this isolates the one variable and
  is not a work cycle. It carries the managed settings at
  `/etc/claude-code/managed-settings.json`, as a real cycle does, but not the
  `--settings` file `cycleInvocation.ts:1300` writes, the appended system
  prompt, the plugin directory or the taskboard MCP config — the confirming
  measurement in `07-option-make-it-runnable.md` §10 is still owed.

- **The projected grant runs a stack's tool, and the projected denial stops the
  one command the stack forbids. 2026-09-12, CLI 2.1.260.** Phase 4's own
  output, taken off this install's real receipt — `shell-lint` links
  `shellcheck` and `shfmt` and denies `shfmt -w`, so the projection is
  `--allowedTools Bash(shellcheck:*) Bash(shfmt:*)` and `--disallowedTools
  Bash(pkill:*) Bash(killall:*) Bash(shfmt -w:*)`. One headless turn as uid 1000
  carrying exactly those flags was asked for three commands in order.
  `shellcheck --version` ran first call and printed `0.11.0`; `shfmt --version`
  ran and printed `v3.14.1` — so the grant is what makes a stack's binary usable,
  against the same mode that refused `probetool` an hour earlier. `shfmt -w
  /tmp/probe.sh` was **refused**, `permission_denied` with *"Permission to use
  Bash with command shfmt -w /tmp/probe.sh has been denied."*, and the file was
  read back afterwards still holding its unformatted `;then`. $0.34, four turns.

  **This is the deny-list doing the thing `23-` §9 chose it for**: the binary is
  granted whole and one command of it is not, and the denial beat the grant
  rather than the other way round. Caveat, and it is the same one the probe
  carries: this is a bare `claude -p` with the flags spread by hand, not a work
  cycle. It proves the two lists behave as projected; it does not prove the run
  loop hands them over, which the three argv assertions in
  `orchestrator.test.ts` pin instead, nor that the rest of the spawn path leaves
  them alone. `07-option-make-it-runnable.md` §10 is still owed and is now
  runnable.

- **Phase 5's four readings, against the running container, 2026-09-12.**
  *Unclaimed:* a file was created by hand at `/var/lib/uf-stacks/bin/hand-rolled`
  and `/api/tools` drew it under `unclaimed` with no `problems` entry — the
  population that was invisible until this phase, since the two `.env` lists'
  toolboxes were walked and this one was not. *`ops_events`:* a deliberately
  unpublished npm package was declared, and the boot wrote exactly one row,
  `warn stacks.not_ok`, `{"stack":"bad-pkg","status":"failed","reason":"npm-global
  could not install @usagefoundry/definitely-not-published@9.9.9"}` — one row per
  stack and not per step, and the reason clipped to the applier's own first line
  rather than the 4 KB the receipt holds. 44 rows in the table against a 500 cap.
  *State size:* `/api/stacks/shell-lint` answered `declaredAt`
  `/etc/uf-stacks/shell-lint`, `stateDir` `/var/lib/uf-stacks/state/shell-lint`
  and `stateBytes` **0** — correct and deliberately not `null`: that stack
  declares no `state`, so the directory exists and holds nothing, which is a
  different fact from nothing having walked it. *The page:* the `Removing it`
  card draws the two paths, `0 B`, and the host-path hedge naming
  `./stacks/shell-lint` and `UF_STACKS_DIR`. No console error.

  Caveat on the size: no stack measured here has ever had a non-empty `state`,
  so the walk has only ever summed zero files. What it would do with a real
  provider cache — and in particular the symlink it declines to follow — is
  reasoned from the code.

- **A language toolchain as a stack, and the three format defects it exposed,
  2026-09-12.** Swift 6.3.3 for Debian 12 was declared as an `archive` stack and
  installed at boot: **1,053,793,547 bytes downloaded, checksummed and unpacked
  in 45 seconds** (19:44:28 → 19:45:13 in the boot log), 3.3 GB on disk, server
  ready 1.2s later, container healthy throughout. `swift --version` and
  `swiftc --version` both answer `6.3.3` as uid 1000 off
  `/var/lib/uf-stacks/bin`, and `swiftc main.swift -o hello && ./hello` printed
  `swift works: 2`. The stack is on this install only — `stacks/*` is
  gitignored and this repository deliberately ships no example.

  It found three things the format had wrong, each of which had been invisible
  because both worked examples were symmetric single-file publishers:

  1. **`url` could not name both architectures.** Swift serves
     `debian12-aarch64/…-debian12-aarch64.tar.gz` and
     `debian12/…-debian12.tar.gz`; `…/debian12-x86_64/…` is a **404**, measured.
     No expansion of `{arch}` or `{arch_uname}` produces a segment that is
     *absent* on one architecture. `url` and a `bin` entry's `from` now take the
     same per-architecture object `sha256` has taken since `01g-` §5.2, so this
     is the format's existing vocabulary rather than a fifth token.
  2. **`install -m 0755` cannot carry a toolchain.** Swift's driver resolves its
     resource directory from `/proc/self/exe`, so a `swift` copied out of
     `usr/bin/` looks for `../lib/swift` beside its new home and finds nothing.
     Every verb now links rather than copies — which is also the louder failure,
     since a failed reinstall used to leave the *previous* binary in `bin/`,
     working, claimed by no receipt and drawn as `unclaimed`.
  3. **The budgets were sized for a linter.** 45s per step and 120s per run
     could not have fetched this on any link. They are now 20 and 30 minutes,
     and the real guard moved from wall clock to progress — `curl --speed-limit
     1024 --speed-time 30`, so an unreachable host still fails in about thirty
     seconds rather than holding the boot for twenty minutes on every restart.
     `HEALTHCHECK --start-period` went 180s → 600s with them.

- **A stack cannot install a shared library, and the failure is total,
  2026-09-12.** With Swift installed perfectly — receipt `ok`, both binaries
  linked, digest verified — every invocation died with `swift: error while
  loading shared libraries: libncurses.so.6: cannot open shared object file`.
  `ldd` over the toolchain's front-ends named exactly one missing system
  library. `apt-get` is refused as a verb (`01d-` §3) and nothing else in the
  format reaches a system package, so the fix is one word in the `Dockerfile`'s
  existing `apt-get install` line. This is the boundary of what a stack is for,
  found by crossing it: a stack installs *software*, and a platform dependency
  is the image's.

- **A stack's `env` reached the server for the first time, 2026-09-12.** It had
  only ever been written as `{}`. The Swift stack declares
  `"SWIFTPM_CACHE_DIR": "{state}/swiftpm"`, the applier wrote
  `/var/lib/uf-stacks/env.json` holding
  `{"SWIFTPM_CACHE_DIR":"/var/lib/uf-stacks/state/swift/swiftpm"}` with `{state}`
  expanded, and the boot logged *"stacks export SWIFTPM_CACHE_DIR to every
  agent."* — which `instrumentation.ts` prints only for keys it actually set on
  `process.env`. **The last link is still unobserved**: that an agent child sees
  it rests on `childEnv` copying `process.env` and stripping nothing that
  matches, which is unit-tested but has not been watched happening with a
  stack's own variable. `docker compose exec` cannot show it — that is a
  different process tree, and `process.env` mutations never appear in
  `/proc/<pid>/environ`.

- **An empty declaration directory fails loudly and alone, 2026-09-12.** A
  `stacks/playwright/` directory with no `stack.json` sat beside the other two
  throughout: `stack playwright: failed — stack.json could not be read (ENOENT)`,
  `stacks: 2 ok, 1 failed`, and neither of the other two was affected. Not
  contrived — it was already on this install, which is the better test.

- **Go left the image for a stack, 2026-09-12.** The `ARG GO_VERSION` block and
  `/usr/local/go/bin` came off the `Dockerfile` and `stacks/go/stack.json` took
  their place — the same `dl.google.com/go/` release against the same published
  digest, `{arch}` expanding to Go's own `amd64`/`arm64` spelling, so unlike
  Swift this one needed no per-architecture form at all. After the rebuild:
  `/usr/local/go` does not exist, `PATH` no longer names it, and as uid 1000
  `go` resolves to `/var/lib/uf-stacks/bin/go`, reports `go1.26.6 linux/arm64`,
  and `go build` produced a binary that printed `go works: 2`.

  **`GOROOT` resolved to `/var/lib/uf-stacks/pkg/go/go`**, which is the symlink
  question answered for a third toolchain: Go finds its root from
  `os.Executable()`, which resolves the link, so the copy this applier used to
  make would have left it looking for a root beside `bin/`. Swift, npm and Go
  all need the link for the same reason and by three different mechanisms.

  **The cache deliberately did not move.** `GOPATH` and `GOCACHE` are still the
  image's and still point at `/home/node/go`, where compose mounts
  `usagefoundry-gocache` — measured after the change: `node:node`, 436 MB, the
  same modules as before. Moving them into the stack's `{state}` would have
  orphaned every module an operator had already downloaded to no purpose, and
  `BUILD_CACHE_DIRS` still reads `$GOPATH`. The stack's own `state/` is empty.

- **Root's tools by path, and where the image puts them, 2026-10-04.** Board
  task `1bc44141`. `command -v` inside a running container of this image (the
  one with `/usr/local/bin/uf-entrypoint` and `/app/server.js`) gave
  `/usr/bin/` for `git`, `chmod`, `chown`, `cp`, `curl`, `dpkg`, `python3`,
  `setpriv`, `sha256sum` and `tar`, and `/usr/local/bin/` for `node`, `npm` and
  `uv`. Those are the paths `TOOLS` in `scripts/apply-stacks.mjs`, `GIT_BIN`'s
  default and the `HEALTHCHECK` now name. The applier and `gitSync` were each
  run under a `PATH` with planted copies first. Before the change the applier
  ran the planted `dpkg` and `curl`, and `gitSync` ran the planted `git`. After
  it, nothing planted ran. Caveat: the applier test fails at `curl` against a
  closed port, as non-root, so it never reaches `sha256sum`, `tar`, `chown`,
  `chmod` or `setpriv` (see below).

## Not yet verified by hand

- **No real work cycle has invoked a stack's binary.** Three things around it
  are measured and are in *Verified* above: that an ungranted binary is refused,
  that the projected grant runs `shellcheck` and the projected denial stops
  `shfmt -w`, and — in `orchestrator.test.ts` — that the run loop puts each list
  on the right flag, on a resumed cycle as well as a first. What is **not**
  measured is the two meeting: every one of those turns was a bare `claude -p`
  with flags spread by hand, carrying the managed settings and none of what else
  a cycle's spawn path adds. The `--settings` overlay `cycleInvocation.ts:1300`
  writes, the appended system prompt, the plugin directory and the taskboard MCP
  config have never been in play while a stack's tool was asked for, and any of
  them could refuse what these permitted. Settle with
  `07-option-make-it-runnable.md` §10: a run at `acceptEdits` against a folder
  holding a shell script, asked to `shellcheck` it and then to `shfmt -w` it,
  read for whether the first `Bash` call succeeded and the second was refused.
  Phase 4 has shipped, so this is now runnable.

- **No boot of an image carrying `TOOLS` has been watched.** The paths were
  measured, and the applier's spawn of them was measured up to `curl` (see
  *Verified*), but no build of this change has installed a stack. That leaves
  the `setpriv` hand-off of an absolute program path under `UF_AGENT_UID`,
  `sha256sum`, `tar` and the root `chown`, as well as a `HEALTHCHECK` reading
  `/usr/bin/curl`, unmeasured. Settle: `docker compose up --build` with the
  operator's `./stacks`, then `ls /var/lib/uf-stacks/receipts` and read each
  receipt's `status` (expect every one `ok`, as before), and
  `docker inspect --format '{{.State.Health.Status}}'` after the start period
  (expect `healthy`).
