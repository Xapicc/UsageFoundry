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
- The agent is spawned with an argument array and `stdio: ["ignore", "pipe", "pipe"]`, **never a shell**, so prompt metacharacters are inert. (was line 14)
- `gitArgs` also passes `safe.directory=*`, and the image sets it system-wide for the agent's own git. (was line 15)
- `permissionMode` is narrowed against the four literals in `POST /api/runs` before it reaches `--permission-mode`. (was line 17)
- `bypassPermissions` is offered in the new-run form with a warning; the default stays `acceptEdits`. (was line 35)
- A named agent is not a capability surface, and the absence of two columns is what enforces that — more so now that the run *is* the agent. (was line 19)
- Reading an agent definition off disk is scoped, and only the scope that needs no path is on the wire. (was line 20)

## [Process signals, the appended system prompt and commit identity](security/process-signals-and-appended-prompt.md)

- An agent cannot select processes by name to signal them. (was line 21)
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

## [Middleware, login, sessions and the audit trail](security/middleware-login-and-sessions.md)

- A monitor must not be handed the credential that starts agents. (was line 27)
- `src/middleware.ts` runs in the **edge runtime**: it reads `process.env.UF_AUTH_TOKEN` directly and must not import `lib/config` (which pulls in `node:os`/`node:path`). (was line 28)
- The audit trail is two tables, and which one a line belongs in is decided by what evicts it. (was line 29)
- `/api/login` is the one unauthenticated write surface here, so it is the one route with a rate limit. (was line 30)
- The session cookie is a handle, and the master token is what it is deliberately not. (was line 31)

## [Stacks](security/stacks.md)

- A stack is software the operator chose to install, and what this mechanism buys is that the choice is reviewable and revocable rather than safe. (was lines 25 and 36)
- A run may ask for a stack, and asking is all it can do: `request_stack` records text a person reads and never anything the app applies.
