# 10 — Implementation sketch: the local agent MCP

Written whatever the recommendation, so the operator can see what building
[Option C](04-option-c-local-agent-mcp.md) would take. Every design choice
below is argued in that file; this one says where each piece goes. Line
numbers are `main` at `4a49627`. Nothing here has been built or run.

**Security review flag.** This design adds an authenticated tool surface
(a new MCP server entry on the existing capability token) and a new
**path-containment rule** for reads made by a root process. Both belong in
`docs/agent/security.md` before any code lands.

## 1. What the run's session sees

Two tools on a second server, `uf_local`, so their names are
`mcp__uf_local__local_summarise` and `mcp__uf_local__local_explore`.

```jsonc
// local_summarise — phase 1, Option B
{
  "path":        { "type": "string", "description": "Repo-relative path inside this run's checkout" },
  "instruction": { "type": "string", "maxLength": 1000 },
  "maxAnswerTokens": { "type": "integer", "minimum": 100, "maximum": 2000, "default": 600 }
}
// local_explore — phase 2
{
  "question": { "type": "string", "maxLength": 2000 },
  "scope":    { "type": "array", "items": { "type": "string" }, "maxItems": 20,
                "description": "Repo-relative files or directories to start from; optional" },
  "maxTurns": { "type": "integer", "minimum": 1, "maximum": 8, "default": 6 }
}
```

A success is one text block: the answer, then a fixed trailer the calling
model can act on — the files and line ranges the local model read (so a check
is a targeted `Read`, not a re-exploration), the model name, turns, queue wait
and wall clock, and tokens in and out as the local server reported them. A
refusal or failure is `isError: true` with a sentence that tells the caller to
do the work itself: busy (admission wait exceeded), unreachable, over time, or
over the context budget.

The tool descriptions, and one sentence on the appended system prompt beside
`TASKBOARD_NOTICE` (`src/lib/cycleInvocation.ts:978`), say what it is for
(reading and locating, not deciding or editing), that its answers come from a
weaker model and should be checked against the cited lines before an edit, and
that a busy refusal means "do it yourself". That sentence inherits the appended
prompt's rule: no literal an agent could match on (`docs/agent/security/process-signals-and-appended-prompt.md`'s no-literal paragraph).

## 2. Where it lives

| Piece | File | Rough size |
|---|---|---:|
| Settings block and validator | `src/lib/settings.ts` (beside `taskboardForRuns`, `:512`) | ~60 |
| OpenAI-compatible client: `complete(messages, tools, signal)`, `probe()` | new *src/lib/localModel.ts* | ~120 |
| The loop, its three reading tools, context trimming | new *src/lib/localAgent.ts* | ~300 |
| Descriptor-verified containment | in *src/lib/localAgent.ts*, beside a call to `resolveInMount` (`src/lib/orchestrator.ts:1244`) | ~60 |
| One global queue and the abort registry | new *src/lib/localQueue.ts*, on a new `globalThis` key | ~90 |
| The MCP server | `src/app/api/mcp/route.ts`, selected by `?server=local` | ~160 |
| Config file and argv | `writeMcpConfig` (`src/lib/chat.ts:4145`), `prepareRunTaskboard` (`src/lib/orchestrator.ts:8580`), `buildArgs` (`src/lib/cycleInvocation.ts:990`) | ~50 |
| Run-log rows and the run page's total | `RunEvent` (`src/lib/orchestrator.ts:435`), `src/components/RunActivity.tsx` | ~110 |
| Settings page row with a reachability probe | `src/app/settings/page.tsx` | ~60 |
| Tests | beside each new module | ~300 |
| **Total** | | **~1,300** |

Why each placement:

- **Served from `/api/mcp?server=local`, not a new path.** `src/middleware.ts`
  exempts exactly `pathname === "/api/mcp"` from the shared-secret gate, with the
  warning "keep the two together" (`src/middleware.ts:66`). A query parameter
  keeps the new server under the one exemption and the one capability check
  (`subjectForCapability`, `src/lib/chat.ts:2327`) rather than adding a second
  exemption to keep in step. A run subject may list and call the local tools
  only when the setting is on; a chat subject never sees them.
- **In-process tools, no spawn.** `read_file`, `grep` and `list_files` are
  implemented in Node over the checkout: no child, so no `childEnv`, no
  `childCredentials`, no argv, and no process for a cancellation to miss. `grep`
  walks with fixed skips (`.git`, `node_modules`) and a byte cap rather than
  shelling out, because the image's search tools would need a spawn and an
  environment.
- **A new `globalThis` key**, never a reused one, because CLAUDE.md's rule is
  that a shape change under an old key survives a dev hot reload and throws.

## 3. The settings

```ts
localModel: {
  baseUrl: string | null;      // e.g. "http://host.docker.internal:8080/v1"; null is off
  model: string | null;        // the server's name for it
  contextTokens: number;       // the server's -c; default 65536
  forRuns: boolean;            // default false
  admitWaitSeconds: number;    // default 30: refuse rather than queue longer
  maxCallSeconds: number;      // default 240: under Claude Code's 300 s HTTP idle floor
  maxTurns: number;            // default 6, hard cap 8
  maxReadBytes: number;        // per read_file, default 24_000
}
```

The validator refuses a `baseUrl` that is not `http(s)`, that carries userinfo,
or whose host is `api.anthropic.com` or `api.openai.com`; there is **no API-key
field**, and the client sends no `Authorization` header. Off means inert: no
tool listed, no config entry, no argv change, no notice — the same rule as
`taskboardForRuns` (`src/lib/settings.ts:506`–`:507`).

## 4. Containment: the rule that is new

The server is root (`docs/agent/security/child-uid-and-credentials.md`); the files it reads are in a
checkout the calling agent can write. So:

1. Resolve the requested path against **the run's checkout** (its worktree, or
   its folder when not isolated) with `resolveInMount`'s lexical-then-realpath
   pair. Refuse anything outside.
2. Open with `O_RDONLY | O_NOFOLLOW`.
3. `fstat` the descriptor: a regular file, under `maxReadBytes` (read a window
   otherwise).
4. Resolve `/proc/self/fd/<fd>` and repeat the containment check on **that**
   path. A symlink swapped in between steps 1 and 2 fails here.
5. Read from the descriptor, never from the name.

`list_files` and `grep` apply the same check to each directory they enter and
never follow symlinks. Tests: `..` escapes, absolute paths, a symlink to
`/data`, a symlink swapped after the lexical check, a directory symlink, a
file over the cap.

## 5. The loop

Pure where it can be, so the silent failures are unit-testable (the bar in
`docs/agent/testing.md`):

- `nextRequest(state)` builds the chat-completions body: a system prompt under
  ~1,500 tokens, the brief, the three tool schemas plus `answer`, and the
  transcript so far, **trimmed** — oldest tool results replaced by a one-line
  stub whenever the estimate exceeds `contextTokens` minus the answer budget.
- `applyReply(state, reply)` returns one of: run these tool calls, final answer,
  malformed (tool call as text, one of the silent failures in *What Breaks
  When Claude Code Runs on a Local Model*), or
  budget exceeded. Malformed twice ends the call with an error rather than a
  guess.
- The executor runs the tool calls itself and appends results. `maxTurns` is a
  hard stop; on the last turn only `answer` is offered.

## 6. Queue, clock and cancellation

- `localQueue.admit(runId, signal)` resolves when the one slot is free, or
  rejects after `admitWaitSeconds` → the busy refusal. FIFO; one slot, matching
  `-np 1` ([`01-constraints.md`](01-constraints.md) C6).
- The whole call, queue included, is bounded by `maxCallSeconds` through one
  `AbortSignal` passed to every `fetch`.
- `abortLocalCalls(runId)` is called beside `revokeRunCapabilities(id)` in
  `startRun`'s `finally` (`src/lib/orchestrator.ts:10166`) and from
  `interruptRun` (`:10347`); a queued entry whose run is no longer `running` is
  dropped when it reaches the head.
- The config entry carries `"timeout": (maxCallSeconds + 30) * 1000`, so Claude
  Code's own limit (C7) never fires before the app's.

## 7. Delivery

`prepareRunTaskboard` becomes `prepareRunMcp`: one config file, written when
`taskboardForRuns` **or** `localModel.forRuns` is on, holding `uf`, `uf_local`
or both, on the one per-run token. The file's life and the token's are
unchanged (written per cycle at `src/lib/orchestrator.ts:9233`, removed at
`:9461`, revoked at `:10166`). `buildArgs` adds `--allowedTools` entries for the
two tools — unless U3 shows `acceptEdits` permits MCP tools under `-p` without
them. Codex runs stay off (`src/lib/orchestrator.ts:8585`): reaching them means
`-c mcp_servers.uf_local.*` with a bearer token by environment variable, which
is a credential-handling design of its own. The chat is not given it.

## 8. Visibility

`kind: "local"` run events, persisted then published through `emit()`
(`src/lib/orchestrator.ts:699`): `admitted` (queue wait), `read` (path, byte
range), `answered` (turns, tokens in and out, wall clock, answer clipped),
`refused` or `aborted` (why). `RunActivity` renders them under the tool call
they belong to; the run page shows a per-run total — calls, wall clock, local
tokens — **beside** the cost figures and never summed into them, because none
of the three cost sources may count it (`docs/agent/architecture.md` is where
which cost source may reach what is settled).

## 9. Build order

| Phase | What | Size | Ship condition |
|---|---|---|---|
| 0 | The operator-side trial: a host HTTP MCP server in the operator's own `~/.claude` config; [`11-validation.md`](11-validation.md) | no app code | — |
| 1 | Option B in-app: settings, client, containment, queue, `local_summarise`, config and argv, run events | ~4–5 days | phase 0 cleared the bar |
| 2 | `local_explore`: the loop, `grep`, `list_files`, trimming | ~3–4 days | phase 1's own measurement shows the frontier using local output well |
| 3 | Run-page total, settings probe row, `docs/agent/` and `docs/verification.md` entries for U1–U5 | ~2 days | with phase 2 |

Docs that change with it: `docs/agent/architecture.md` (the app now makes an
outbound model call from the server — the inventory's "never over HTTP" stops
being true — and it is not a cost source), `docs/agent/security.md` (§4's
rule; the new server entry), `docs/agent/taskboard.md` (the config file is no
longer the taskboard's alone), and `docs/verification.md` (U1–U5 as they are
measured).
