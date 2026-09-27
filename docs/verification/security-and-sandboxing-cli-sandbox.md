# Verification: Security and sandboxing — the CLI's sandbox, bwrap, seccomp, mount points and the write set

[← Verification index](../verification.md)

## Verified

- **A required sandbox that could not start ran unnoticed, 2026-08-18/19:**
  the only end-to-end reading of `UF_SANDBOX=1`. With `security_opt` commented
  out as shipped the CLI started anyway (its probe only `access(X_OK)`s
  `bwrap`); 214 `Bash` calls failed across 10 runs in 15.5 hours ($407.26),
  and UsageFoundry recorded zero `sandbox` events.

- **`uf-seccomp.json`, Docker Engine 29.7.2, kernel 6.12.76-linuxkit:** it
  lets `bwrap --unshare-user` create a namespace (rc=1 → 0, root and uid 1000)
  but not `--proc /proc`, so only the CLI's weaker `--bind /proc /proc` shape
  runs, measured on `bwrap`, not on the CLI choosing. Its regeneration command
  404s: moby publishes no `v29` tag.

- **A sandbox that starts and confines, 2026-08-19, $0.51 for three calls:**
  with the seccomp override and `enableWeakerNestedSandbox`, a sandboxed `Bash`
  ran and was refused the `.credentials.json` uid 1000 reads outside it, as a
  plain `EACCES` indistinguishable from a missing path.

- **Sandbox mount-point failures counted, the fill's git half checked,
  2026-09-04.** 255 `bwrap: Can't create file` tool failures in ten days, 252
  of 261 paths in a project tree's `.claude` list, which `claude.exe` 2.1.260
  applies to the cwd and every ancestor. After the fill a linked worktree's
  `git status --porcelain` is empty.

- **The fill worked and the failures moved to the config directory,
  2026-09-13.** Every failed tool result under `~/.claude/projects` whose body is
  nothing but bwrap mount-time lines, deduped by `tool_use_id`: 460 since the
  fill shipped at `a2194e7` on 2026-09-04. Not one of the twelve project-tree
  `.claude` names has failed since the afternoon it shipped, and 260 of the 460
  are in `$CLAUDE_CONFIG_DIR`, which the fill deliberately skipped. Named: 135
  are the ten files `SANDBOX_CONFIG_DIR_NAMES` now creates, 125 are refused with
  a reason — 77 in directories, which stopped on their own on 2026-09-07 because
  the CLI makes its own caches, and 48 in the two policy documents, last seen
  2026-09-11 — and 0 are unaccounted for by either list. Every one of the 26
  recorded on 2026-09-12 and 2026-09-13 is one of the ten. The stricter dedupe is
  why this counts fewer than the 2026-09-11 entry above does for an overlapping
  window: a body with prose around the `bwrap:` line is a transcript discussing
  the defect, not a call that died of it. Counted off transcripts, so it also
  sees this host's non-UsageFoundry sessions.

- **The same defect speaks with three messages, and only one of them is the one
  the fix removes, 2026-09-13.** Of the 135 on the ten names, 119 are `Can't
  create file at` — the create refused — and 16 are `Can't get type of source`
  (9) and `Can't find source path` (7), where the CLI saw the path when it built
  the argv and bwrap found it gone. One landed on this session: `npm run
  typecheck` died with `bwrap: Can't find source path
  /home/node/.claude/policy-limits.json.signature.json`, and the same command
  succeeded on the retry, which is the whole shape of it. **What deletes them was
  not established.** Read out of `claude.exe` 2.1.260: the sandbox's own scrub
  (`bareGitRepoScrubPaths`) takes planted bare-repo files and nothing in the
  config directory, and the managed-policy code does unlink both
  `policy-limits.json` signatures, but only on a fetch returning no signature —
  which this install, holding a 214-byte `policy-limits.json` and no signature
  beside it, may or may not be doing. Pre-creating runs immediately before every
  spawn and so narrows that window rather than closing it; whether the 16 go to
  zero is the open half of the item below.

- **Both lists are now read out of `claude.exe` 2.1.260 by `npm test`,
  2026-09-13.** `sandboxMountPoints.test.ts` extracts the sandbox construction
  from the shipped binary and asserts that `SANDBOX_TREE_ROOT_NAMES` is exactly
  what it binds at a checkout's root, and that `SANDBOX_CONFIG_DIR_NAMES` and
  `SANDBOX_CONFIG_DIR_REFUSED` together are exactly what it binds in the config
  directory, with the file/directory split taken from the CLI's own flag. Watched
  to fail both ways: dropping `remote-settings-helper-consent` fails, and adding
  a name the CLI does not bind fails. It is skipped, with a reason, where no CLI
  is installed. One real defect it caught while being written: anchoring the
  tree-root list on `.ripgreprc` alone matches a second, 38-name array of project
  configuration files that the sandbox never binds.

- **The fill itself, driven end to end against a scratch config directory,
  2026-09-13.** `ensureSandboxMountPoints([])` on a directory holding every
  refused name and none of the ten created exactly the ten, left every refused
  name alone, wrote each as empty, was a no-op on a second call and did not
  truncate a `loop.md` given content between the two. With the directory at
  0555 it returned ten problems and threw nothing.

- **The chat's default cwd moved off `/workspace`, and what that is resting
  on, 2026-09-14.** `chatCwd()` no longer returns `WORKSPACE_ROOT`; under
  privilege separation it returns `/run/uf-chat`, made 0700 and `chownForChild`,
  falling back to `os.tmpdir()` on any failure and warning
  `chat.scratch_cwd_failed` when it does. What was measured is the base, not the
  turn: `/run/uf-mcp` is present on this install at mode 0711, which is
  `mcpConfigBase()`'s own `mkdirSync` + `chmodSync` pair having run as the
  server, so `/run` is writable by it and the identical pair will make
  `/run/uf-chat`. The caveat is that ownership could not be read from inside a
  work cycle at all — this session's own sandbox idmaps every uid outside its
  worktree to `nobody:nogroup`, so `stat` on `/workspace`, `/workspace2` and
  `/run/uf-mcp` alike reports an owner that is an artefact of the reader. The
  0755 and `nobody:nogroup` in the 2026-09-13 entry above stand on that entry's
  own method and not on anything re-read here. `npm run typecheck` clean and
  `npm test` green apart from one failure that predates the change
  (`deployment.test.ts`, the container memory ceiling against the server heap).
  **No live turn has run at the new cwd** — see *Not yet verified by hand*.

- **The tree-root list does fail, for the one cwd that is not a run's,
  2026-09-13.** 18 failures at `/workspace` and 8 at `/workspace2` in the 460,
  last 2026-09-11, against `SANDBOX_TREE_ROOT_NAMES` — which the docblock said
  needed no pre-creation because "the working directory is writable". True of a
  run, false of the orchestrator chat, whose cwd is `chatCwd()` →
  `WORKSPACE_ROOT` → `/workspace`, `nobody:nogroup` at 0755. Neither the agent
  uid nor the server can create there, so pre-creating is not the fix available;
  the docblock now says which case it covers and which it does not.

- **The `bwrap:` markers were pinned to a wording this install stopped
  producing, 2026-09-11.** Every failed tool result in every session transcript
  under `~/.claude/projects` carrying a `bwrap:` line: 945 of them, 223 of which
  are `No permissions to create new namespace` and all 223 fall on 2026-08-18/19
  — none since. The other 714, from 2026-08-25 to today, are mount-time and were
  matched by nothing: `Can't create file at` (670), `Can't find source path`
  (24), `Can't get type of source` (16), `Can't bind mount` (11), `Can't create
  file at … Read-only file system` (1). Read off transcripts because `DATA_DIR`
  is unreadable to an agent; the orchestrator writes one `tool_error` per failed
  tool result, so this over-counts `run_events` by whatever retention has swept
  and by the host's own non-UsageFoundry sessions. Two failed calls in the same
  corpus carry `bwrap` and are not sandbox failures — a `ps` listing and a grep
  of `docker-compose.yml` — which is why the needle added is `bwrap: Can't `
  and not `bwrap: `.

- **The settings row's failure note, end to end, 2026-09-11.** Against the
  standalone build on a throwaway `DATA_DIR` with 14 seeded `sandbox` rows:
  `/api/settings` returned the note under `env.sandbox.failureNote`, and
  `/settings` drew it under an amber `ON` badge. Seeded rows, not a real
  bubblewrap: nothing here ran a sandbox.

- **The sandbox's tree-root list binds eleven dotfiles at the cwd only,
  2026-09-09.** Each is a character device `1,3`, and `git add -A` dies on
  `.bash_profile`; 6 of 47 idle checkouts kept all eleven as `0444` files.
  `sweepSandboxTreeRoot` removed nine on a scratch tree, keeping a real
  `.gitconfig` and `.vscode`.

- **The sandbox wiring builds, boots and wraps `Bash` (2026-08-18/19).**
  `bubblewrap` and `socat` ship executable; `UF_SANDBOX=1` writes the managed
  policy; Docker applies `uf-seccomp.json` (v28.5.2's default, six syscalls
  ungated). `sandboxRefusal` is unit-tested; its three `bwrap:` markers were
  read off `run_events`.

- **The per-run write set is unit-tested and was watched to fail first.**
  `sandboxSettings`/`sandboxArgs` in `orchestrator.test.ts`: own checkout
  writable, a sibling run's not, `CLAUDE_CONFIG_DIR` writable, plus glob-path
  and empty-set cases.

- **The CLI's own sandbox has been executed three narrow ways (2026-08-18/19
  onward).** `bwrap` with and without the seccomp profile, in both argv
  shapes; a 15-hour `UF_SANDBOX=1` install whose sandbox never started (Q2);
  three hand-run `claude -p` calls against one that did: one ran a shell
  command, one was refused the credentials file its own uid owns.

## Not yet verified by hand

- **The 2026-08-19 probes did not exercise** the per-run `--settings` overlay,
  `denyRead` paths, the network allowlist, the write set, or real work.

- **Whether the CLI's `filesystem.allowWrite` replaces its defaults is
  unmeasured, 2026-08-25.** Adding `/opt/playwright/browsers` reopens the
  install, but a replacement would drop the cwd and `/tmp` and leave agents
  unable to write their worktrees. Do not add it on reasoning alone.

- **No sandboxed cycle has run with the mount-point fill, 2026-09-04.** Bwrap
  binding over the placeholders is unseen. What that item also asked — whether
  the count falls to zero for project trees — was measured on 2026-09-13 and is
  in *Verified* above: it did, the same afternoon. What is still open is the
  other direction, that a placeholder is bound rather than merely tolerated.

- **No chat turn has been watched constructing its sandbox at the new cwd, and
  the failure count has not been re-measured, 2026-09-14.** `chatCwd()` now
  returns `/run/uf-chat` rather than `/workspace`, which is *Verified* above as
  far as the base goes, and the mechanism it is aimed at is the 18 + 8 failures
  in the 2026-09-13 entry. Neither half of the demonstration is available from
  inside a work cycle, for the reasons the 2026-09-13 item above sets out in
  full: a nested `bwrap` dies at `open /proc/<pid>/ns/ns`, a mount point the
  outer sandbox holds cannot be removed to stage the failure, and re-running the
  transcript count today measures the corpus from *before* the change and so
  answers nothing. Settle it the same way that item is settled — from outside a
  sandboxed session, against a running container carrying this commit: open an
  orchestrator chat with no folder selected so the turn falls through to
  `chatCwd()`, ask it for a `Bash` tool call, and read the result for a `bwrap:
  Can't create file at` line; then re-run the 2026-09-13 count over transcripts
  dated after the deploy and expect zero at `/workspace` and `/workspace2`.
  Worth also reading whether the eleven placeholders arrive in `/run/uf-chat`
  and are swept, which is the half `sweepSandboxTreeRoot` is there for.

- **No tool call has been watched dying of a config-directory mount point and
  then running, 2026-09-13.** The fix is measured against a scratch directory
  and the corpus is accounted for name by name, both in *Verified* above, but
  the two have not been joined on a live sandbox, and not for want of trying:
  every route is closed from inside this container, because a work cycle is
  already inside the sandbox whose construction it would have to watch. A nested
  `bwrap` dies at `open /proc/<pid>/ns/ns` before it mounts anything, on every
  option set tried including a minimal root. A mount point the outer sandbox
  holds cannot be removed to stage the failure — `rm` on one returns `EBUSY`.
  And the config directory's true state is masked: five of the ten read as
  character devices because this session's own sandbox bound `/dev/null` over
  them, so an `O_CREAT|O_EXCL` against one returns `EEXIST` from the overmount
  and writes nothing to the disk underneath. Settle it from outside a sandboxed
  session — a `docker compose up --build` with `UF_SANDBOX=1`, a run started
  from the UI, and the config directory's ten names watched across two cycles:
  before the fix five oscillate between absent and `/dev/null`-bound, and after
  it they should stay regular empty files and the `bwrap: Can't create file`
  count should reach zero. Read the other two messages separately: if `Can't find
  source path` and `Can't get type of source` survive on these names, something
  is still deleting them and the entry above says what has been ruled out.

- **The post-cycle `sweepSandboxTreeRoot` call is unseen, 2026-09-09.** No
  sandboxed cycle since; its log line, the `EBUSY` branch and the interplay
  with `land.ts`'s `trackedDirt` workaround are reasoned only.

- **The merged tree's suite has not been run for the chat child's fill and
  sweep plus `core.excludesFile`.** Its 2,597 and 2,590 passes were measured on
  separate branches; that `runIteration` does all three and
  `runOrchestratorChild` the first two is read from code, not run.

- **No sandbox has confined a tool call from this app; no `sandbox` event has
  fired.** Every `bwrap` it caused exited 1 unexecuted; the 15-hour run logged
  484 `tool_error` and 0 `sandbox` rows. Unseen: any CLI-written marker (six
  read by `strings`), the credential deny from a run, the boot line past `none`,
  `enableWeakerNestedSandbox` read by any `claude`, seccomp past `bwrap`. What
  the probe below was for on the `bwrap:` side has since been answered off this
  host's transcripts instead (2026-09-11, above), so what is still open here is
  the CLI's own six and everything after the wrap: run it for those.
  ```sh
  uid=$(docker compose exec -T usagefoundry printenv UF_AGENT_UID)

  # A command the policy refuses, read off the wire rather than off a page.
  docker compose exec --user "$uid" usagefoundry sh -c '
    claude -p "run: touch /etc/uf-probe" --output-format stream-json --verbose' \
    | jq -r 'select(.type=="user") | .message.content[]?
             | select(.is_error == true) | .content'
  # Then compare what it prints against MARKERS in src/lib/sandbox.ts
  # and add what is missing.
  ```

- **No sandbox has ever honoured the per-run write set.** Unrun: run A writing
  into a concurrent run B's `.uf-worktrees/<slot>` via `Bash` and `Write`, and
  `--settings` merging with the managed file. The set left out `/tmp`,
  `$HOME/.npm` and `$GOPATH` until 2026-08-19; that it now suffices is argued,
  not measured. Open dependency: a stock `settings.json` lets a run widen it.

- **No work cycle has run in a started sandbox, the network allowlist never
  ran, and `scripts/sandbox-probe/` has never met a container.** CLI 2.1.226's
  sandbox and the policy choices built on it are readings of the binary.
  `probe.test.sh`'s 37 stub assertions test the harness only; `probe.sh`'s Q2
  cannot reach the failure production showed. Results (Q3, Q8d decide shape):

  | Question | Answer | Recorded |
  |---|---|---|
  | Q0 — are `bubblewrap` and `socat` installable in this image? | **Yes** — both ship in the image and are executable | 2026-08-19, this install; inferred from the CLI's own `access(X_OK)` probe passing |
  | Q1 — does bubblewrap start under the relaxed profile? | **BWRAP-BLOCKED** without `security_opt`, at both uids; **BWRAP-OK** with `uf-seccomp.json`. `--proc /proc` fails either way | 2026-08-19, Engine 29.7.2 / kernel 6.12.76-linuxkit |
  | Q2 — does the CLI refuse to start when it cannot sandbox? | **Neither refused nor unsandboxed** — it starts, reports nothing, and every `Bash` call dies inside `bwrap`; `failIfUnavailable` never fires | 2026-08-18/19, production, 170 failed calls across 8 runs |
  | Q3 — is the sandbox around the session or only around Bash? | *(unmeasured — narrowed on one side: `Bash` is wrapped, `Edit`/`Write` unknown)* | |
  | Q4 — does a credentials deny entry stop a shell reading the token? | *(unmeasured)* | |
  | Q5 — does a user-settings write widen a managed policy? | *(unmeasured)* | |
  | Q6 — what does one sandboxed command cost in tasks? | *(unmeasured)* | |
  | Q7 — does the CLI's sandbox unshare PID? | *(unmeasured)* | |
  | Q8a — which bubblewrap, and does it carry `--tmp-overlay`? | *(unmeasured)* | |
  | Q8b — does `--unshare-pid` plus `--tmp-overlay` work here? | *(unmeasured — narrowed: `--unshare-pid` alone exits 0 under the profile; `--tmp-overlay` has never been tried)* | |
  | Q8c — does one bubblewrap start inside another? | *(unmeasured)* | |
  | Q8d — does the CLI's own bubblewrap start inside one we started? | *(unmeasured)* | |

- **`enableWeakerNestedSandbox: true` has never been read by a `claude`, and
  its price applies once one does.** Written unconditionally since 2026-08-19
  because the other argv shape cannot mount a procfs here; a sandboxed command
  then sees the container's `/proc`, so a sibling agent's processes are
  visible to it.
