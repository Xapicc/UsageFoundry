# Constraints: how an MCP server reaches a cycle today

Read against branch `local-offload-trial` at `ba4ff72`, which is `main` plus the
local reader trial.

## Part 1 — facts

**C1. A cycle gets one app-written MCP config file, and only while the taskboard
is on.** `prepareRunTaskboard` runs once per cycle
(`src/lib/orchestrator.ts:9237`) and writes `{"mcpServers": {"uf": …,
...extraServers}}` to a 0600 file (`src/lib/chat.ts:4168`–`src/lib/chat.ts:4177`),
removed in the cycle's `finally` (`src/lib/orchestrator.ts:9465`). With
`taskboardForRuns` off there is no file and no `--mcp-config`. A second
`--mcp-config` flag would replace the first rather than add to it, which a test
states as its premise (`src/lib/orchestrator.test.ts:2681`); so any app-written
server has to be merged into this one file.

**C2. The trial's server rides that file, and can take `uf` down with it.**
`writeMcpConfig(mintRunCapability(runId), null, configuredLocalReader())`
(`src/lib/orchestrator.ts:8594`) evaluates `configuredLocalReader()` before the
file is written, and it throws when the trial is half-configured
(`src/lib/localReader.ts:36`). The catch turns that into the `unavailable` row
(`src/lib/orchestrator.ts:8596`–`src/lib/orchestrator.ts:8600`): the cycle then
runs without the taskboard as well, "cannot complete or file a task"
(`src/lib/orchestrator.ts:9241`). A design where one extra server's fault costs
the cycle its own tools is the first thing to not repeat.

**C3. An extra entry can shadow `uf`.** `extraServers` is spread after `uf`
(`src/lib/chat.ts:4175`), so an entry named `uf` would replace the app's own
server. Nothing refuses the name.

**C4. Work cycles are deliberately not strict; the chat deliberately is.** "The
operator's own MCP servers, configured in the `~/.claude` this app mounts, are
part of what their agents work with" (`src/lib/cycleInvocation.ts:1190`–`src/lib/cycleInvocation.ts:1193`),
pinned by `src/lib/orchestrator.test.ts:2686`. The chat passes
`--strict-mcp-config` because otherwise "an MCP server configured in the mounted
~/.claude joins this child — a tool surface the operator never granted this
feature" (`src/lib/chat.ts:2973`–`src/lib/chat.ts:2975`). LocalModelOffload's
own analysis already concluded "the chat should not get it"
(`proposals/LocalModelOffload/04-option-c-local-agent-mcp.md:203`).

**C5. The mounted `~/.claude` is shared with the operator's Mac, paths
included.** The host directory is bound at `/home/node/.claude`
(`docker-compose.yml:453`) and is the CLI's config directory
(`docker-compose.yml:253`). The pinned CLI keeps user-scope MCP servers in
`.config.json` inside it, so every server the operator adds on the Mac reaches
every work cycle with its Mac paths — and fails there (`04-validation.md` P4).
`docs/install.md:81`–`docs/install.md:83`, which says user-scope servers do not
reach the container, is wrong for this CLI.

**C6. Plugins are the existing operator-registered unit that reaches every work
cycle.** Discovered under each workspace mount up to three levels deep
(`src/lib/plugins.ts:67`, `src/lib/plugins.ts:250`), a plugin being a directory
with `.claude-plugin/plugin.json` whose `name` parses
(`src/lib/plugins.ts:96`–`src/lib/plugins.ts:117`). The enabled list is its own
settings row so an unrelated Save cannot clear "the list deciding what code every
agent loads" (`src/lib/plugins.ts:30`–`src/lib/plugins.ts:39`). A path is proved
inside a mount when stored and again at spawn (`src/lib/plugins.ts:337`,
`src/lib/plugins.ts:365`), and a plugin that fails the second proof is named on
the run's log (`src/lib/orchestrator.ts:9183`–`src/lib/orchestrator.ts:9191`).
Switching one on "adds it to every work cycle this app starts, from the next
cycle onward — including runs already in flight" (`src/app/settings/page.tsx:4387`).
Only work cycles get `--plugin-dir`: chat, orchestrator blocks, reviewers,
validation and conflict assists do not (`src/lib/cycleInvocation.ts:1281`–`src/lib/cycleInvocation.ts:1287`
is the only emitter; `src/lib/review.ts:734` builds the assists' argv without it).

**C7. An agent carries a role, never a capability.** A `tools` field is refused
at save (`src/lib/agents.ts:278`–`src/lib/agents.ts:280`), and the doc calls the
refusal the decision (`docs/agent/agents-and-templates.md:10`). Stacks are
"install-wide and never per run" for the same kind of reason
(`src/lib/orchestrator.ts:9326`–`src/lib/orchestrator.ts:9328`). A per-agent or
per-run list of MCP servers would reopen both.

**C8. Secrets are environment variables, and never the settings table.** The
rule and its reason are at `src/lib/config.ts:513`–`src/lib/config.ts:520`: the
settings route is reachable with `UF_AUTH_TOKEN`, so a value held there is
"repointable by anything holding the master key". CustomStacks designed a secret
as a name, never a value (`proposals/CustomStacks/23-revision-per-repo-and-login.md:216`),
and has not built it.

**C9. A unit typed into a form is not reusable.** CustomStacks' R2 is "not met
by a row typed into a form, by anything whose meaning depends on state held only
in this install's database" (`proposals/CustomStacks/01-constraints.md:54`–`proposals/CustomStacks/01-constraints.md:57`).

**C10. Every `UF_` variable is four files and a test.** `.env.example`, the
compose `environment:` block, the entrypoint if it reads it, and
`deployment.test.ts`, in one commit (`proposals/CustomStacks/01-constraints.md:333`);
a blank-is-an-answer variable also needs `BLANK_MEANINGFUL_ENV_VARS`, the README
count and the rotation bullet. The trial paid this for four variables that name
one server.

**C11. What a cycle actually got is already stored and never read.** Every
`system` event but `thinking_tokens` is stored whole as `{message:
"system:<subtype>", raw}` (`src/lib/orchestrator.ts:8153`–`src/lib/orchestrator.ts:8160`),
and the feed drops them (`src/lib/logLine.ts:726`). On the pinned CLI the
`init` event carries `mcp_servers` (name, status, source) and the full `tools`
list (`04-validation.md` P4). Calls are already on the log as kind `tool` with
the raw `mcp__<server>__<tool>` name (`src/lib/orchestrator.ts:7946`–`src/lib/orchestrator.ts:7951`).

**C12. A stdio server runs inside the run's sandbox, in the cycle's checkout.**
Settled on the trial's first cycles: the local reader reached LM Studio from
inside the sandbox, wrote its log and was rooted in the run's worktree
(`docs/verification.md:3121` records it as the open question it was). A server
started by the CLI dies with the cycle, so it is stopped with the run.

## Part 2 — unknowns

**U1. Whether every cycle, including a resumed one, emits its own `init`.**
Assumed, since each cycle is a fresh `claude -p` process. Settled by counting
`system:init` rows against `iterations` for a run with two or more cycles:
`sqlite3 -readonly /data/usagefoundry.db "select run_id, count(*) from run_events
where json_extract(payload,'$.message')='system:init' group by run_id"`.

**U2. Whether Settings › Plugins discovers a plugin two levels below a mount
root** (`/workspace/LocalModelOffload/plugin`). Expected from the walk depth
(`src/lib/plugins.ts:67`); settled by `GET /api/plugins` after the plugin exists.

**U3. How the CLI orders two servers with the same tools.** During a switch-over
a cycle could see both `uf_local` and `plugin:local-reader:local`. Not measured;
the migration avoids the overlap rather than relying on either answer.
