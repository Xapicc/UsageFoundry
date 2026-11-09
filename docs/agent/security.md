# Security-critical paths

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing anything touching auth, path containment, spawn argv, or a credential.**

Each paragraph now lives in the topic file its heading links to: find the rule by its claim below and open that one file. A line number cited elsewhere as `docs/agent/security.md:N` counts lines of this file before it was split on 2026-09-27; each entry ends with the line its paragraph started on at the split, and a citation older than that may be off by a few lines.

## [Path containment, spawn argv and permission modes](security/path-containment-and-spawn-argv.md)

- `resolveInMount()` (`orchestrator.ts`) checks containment on the lexically resolved path **before** touching the filesystem, then **again** after `realpathSync` — a symlink inside the root can still… (was line 11)
- Containment stays **per mount**, while collision detection is deliberately **cross-mount**: `conflictKey`/`overlaps` see two mounts onto one directory as one folder. (was line 12)
- Worktrees live at `<mountRoot>/.uf-worktrees/<repo>-<slot>` so the unmodified `resolveInMount` validates the agent's cwd. (was line 13)
- A repository at the mount root is isolated only while its own ignore rules keep the store out, and this app's git never climbs out of a slot.
- A repository nested below a mount root that is itself a repository is isolated only while the outer repository's own ignore rules keep the store out.
- The agent is spawned with an argument array and `stdio: ["ignore", "pipe", "pipe"]`, **never a shell**, so prompt metacharacters are inert. (was line 14)
- A review block's verify command is argv and never a shell, and only a person saves one.
- `gitArgs` also passes `safe.directory=*`, and the image sets it system-wide for the agent's own git. (was line 15)
- `permissionMode` is narrowed against the four literals in `POST /api/runs` before it reaches `--permission-mode`. (was line 17)
- `bypassPermissions` is offered in the new-run form with a warning; the default stays `acceptEdits`. (was line 35)

## [What this app's own git runs from a repository a work cycle wrote](security/server-git.md)

- `gitArgs` pins the signing programs and neutralises the repository's filter drivers, for the same reason it clears `core.hooksPath`.
- A conditional include is probed where the child git reads it.
- A submodule is probed where its own child git reads it, and none the probe has not read is recursed into.
- The probe and the call still read configuration separately; a fingerprint narrows the window between them and does not close it.
- A hook defined in config is switched off by name on every call that can fire one, because `core.hooksPath=/dev/null` does not reach it and git has no switch that does.

## [Agent definitions](security/agent-definitions.md)

- A named agent is not a capability surface, and the absence of two columns is what enforces that — more so now that the run *is* the agent. (was line 19)
- Reading an agent definition off disk is scoped, and only the scope that needs no path is on the wire. (was line 20)

## [Process signals, the appended system prompt and commit identity](security/process-signals-and-appended-prompt.md)

- An agent cannot select processes by name to signal them. (was line 21)
- The Codex half of that denial is a file, and it holds only while root alone can change the directory Codex reads it from.
- The name `CODEX_HOME` is reached by holds only while it is a mount point or its parent is root's alone.
- …and the notice must contain no literal an agent could match on, because the notice is itself on every sibling's command line. (was line 22)
- An agent must not sign a commit with the address it was given to recognise the operator by. (was line 23)
- Nothing on a run's appended system prompt may carry a literal an agent could `pgrep -f` (was line 34)

## [Child uid, child environment and credentials](security/child-uid-and-credentials.md)

- The server is root and every child it spawns is not, and that one difference is what makes three separate defences mean anything. (was line 10)
- The child environment is a denylist, and a denylist fails open — so a credential shape gets closed before this app has a use for it, not after. (was line 18)
- No Claude Code child this app spawns may list or message another session, and one variable is what enforces it.
- `UF_GITHUB_TOKEN` is scoped by host and by child, and there are three kinds of child rather than one. (was line 16)
- A work cycle can now write to this app's database, and what bounds that is the tool list rather than a file mode. (was line 33)
- The chat's capability token is compared constant-time against every live token in `subjectForCapability`, rather than looked up by key: a `Map.get` on a secret leaks its prefix through timing. (was line 32)

## [TokenEconomizer: what its hooks can reach and what nobody meters](security/token-economizer.md)

- The code is root-owned and the state is not, and both facts are deliberate.
- Environment pins stop config overrides and stop nothing else.
- Tool pruning writes into a checkout.
- Its side calls are invisible to every meter.
- Codex and local runs get nothing.

## [What a dropped child runs by name](security/child-path-lookups.md)

- What a dropped child is spawned as is decided on root's `PATH`, never on its own.
- The boot's own dropped helpers keep the same rule.
- What the chat and block child runs by name once started is decided on root's `PATH` too.

## [What the chat child loads from files a work cycle writes](security/chat-child-config-files.md)

- The chat child's `HOME` is its own, because the agents' is every work cycle's to write.
- Every variable naming a path in the agents' `HOME` leaves with it, except the Claude config directory.
- A repository's `.git` may not run a command in the chat's git, as far as git lets that be said.
- The chat reads the user's settings and nobody's cwd, and runs no hooks.
- What is still open, and what would settle it.

## [Where a work cycle's settings may send its credential](security/cycle-settings-env.md)

- A work cycle loads its checkout's settings, and their `env` decides where its API requests go.
- The cycle's own `--settings` outranks every one of those files, so the endpoint variables are pinned there and project settings stay loaded.
- No credential is pinned, and none may be.
- An assist runs no hooks, because its checkout's hooks speak to its model.
- An assist runs no `apiKeyHelper` either, because hooks off did not stop a checkout's.
- A work cycle runs no `apiKeyHelper` either, and neither does the chat.
- A Codex work cycle does not load its checkout's `.codex/config.toml`, and that holds only while its trust write to `$CODEX_HOME/config.toml` succeeds.
- What is still open.

## [What a run left in its repository's git directory](security/run-git-dir-watch.md)

- A run's end says what changed in its repository's git directory, because nothing else does.
- The check compares a list of keys that run commands, never the whole file.
- Reading runs nothing the repository chose, and reads nothing outside a mount.
- A `core.hooksPath` the repository already had is followed to the directory git runs hooks from.
- A change is attributed only as far as this app's record goes.
- A start or end that was not read is a warning, never "unchanged".
- No credential is kept or shown.
- What it does not cover.

## [The knowledge vault's write boundary](security/vault-write-boundary.md)

- The vault is read-only to every run whose workspace is not the vault, and the harness enforces that, not the skill.
- Each deny closes only one half, so both are emitted, and dropping either one silently reopens that half.
- The vault is a working directory through the overlay's `permissions.additionalDirectories`, never `--add-dir`, because that flag loads the vault's `.claude/` into every reader.
- A reader loads no `CLAUDE.md` from inside the vault, through a `claudeMdExcludes` entry for `<vault>/**` in the same overlay, because a reader whose folder contains the vault was shown the vault's.
- `denyWrite` rides on the write set and is withheld wherever the write set is.
- A run may write the vault only when its checkout or its repository is at or below the vault — `vaultWritableBy`.
- The search writes nothing into the vault, so a read-only vault does not break it.
- A vault whose path reads as a glob pattern gets no skill rather than a writable one.
- What is still open.

## [The file tools' write boundary](security/file-tool-write-boundary.md)

- Every Claude work cycle refuses a file-tool write outside its working directories, and the CLI enforces that, not the sandbox.
- The working directories are the cwd, each `--add-dir` and each `permissions.additionalDirectories` entry, and the sandbox write set is not among them.
- The temporary directory is made a working directory through `permissions.additionalDirectories`, never `--add-dir`, because `--add-dir` loads what is in it.
- A settings file is refused even inside the checkout.
- What it does not cover.
- What is still open.

## [What a work cycle loads from directories that are not its own](security/project-config-discovery.md)

- An isolated run reads its project config from its own worktree, through `--project-config-root <workDir>`, because without the flag the CLI reads part of it from the main checkout.
- The flag changed nothing else that was measured, and it costs the operator's uncommitted config in the main checkout.
- A run on a plain folder is still offered its ancestors' `.claude/`, and that is accepted.
- A reviewer, resolver or validator in a linked worktree reads its project config from that worktree's top level, through `--project-config-root`, because without it the main checkout's untracked config reached the assists that judge a run.
- What it does not cover.

## [What a reviewer or validator may read](security/assist-read-boundary.md)

- A reviewer or validator refuses a file-tool read outside its checkout, through `permissions.blockReadsOutsideWorkingDirectories` in the assist's one `--settings`, because `plan` refuses no read.
- A sandbox `denyRead` would not have done it, and neither would a deny rule.
- What it costs is a judge's reads of anything but its own checkout, and on this install that is almost nothing.
- The resolver is left without it.
- What it does not cover.

## [Middleware, login and sessions](security/middleware-login-and-sessions.md)

- A monitor must not be handed the credential that starts agents. (was line 27)
- `src/middleware.ts` runs in the **edge runtime**: it reads `process.env.UF_AUTH_TOKEN` directly and must not import `lib/config` (which pulls in `node:os`/`node:path`). (was line 28)
- `/api/login` is the one unauthenticated write surface here, so it is where the limit on guessing the master token lives. (was line 30)
- A bearer is a guess at the same secret, and is charged like one.
- The session cookie is a handle, and the master token is what it is deliberately not. (was line 31)

## [The audit trail](security/audit-trail.md)

- The audit trail is two tables, and which one a line belongs in is decided by what evicts it. (was line 29)
- "Changed" is the mutation's own exit, never the status read after it.

## [Stacks](security/stacks.md)

- A stack is software the operator chose to install, and what this mechanism buys is that the choice is reviewable and revocable rather than safe. (was lines 25 and 36)
- A run may ask for a stack, and asking is all it can do: `request_stack` records text a person reads and never anything the app applies.
- Root's `PATH` and environment are root's own: the agents' `PATH` and a stack's `env` reach only the children dropped to the agent uid.
