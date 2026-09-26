# MCP servers for runs, without one line of app code per server

**How does an operator give work cycles an extra MCP server, like
LocalModelOffload's local reader, without the app naming that server in its
code, its compose file or its environment?** An option set and one
recommendation, not a plan. The trial on this branch is the counter-example:
`src/lib/localReader.ts` plus four `UF_LOCAL_READER_*` variables that exist for
one server only.

## The finding that shapes everything

**The app already has an operator-registered unit that reaches every work cycle,
and it can carry an MCP server: a Claude Code plugin.** Settings › Plugins
switches a plugin directory from a workspace mount on, and every work cycle gets
it as `--plugin-dir` from its next cycle (`src/lib/orchestrator.ts:9182`,
`src/lib/plugins.ts:129`). On the pinned CLI (2.1.280), a plugin's `.mcp.json`
server loaded that way connected and listed all six local reader tools, with the
server's path given relative to the plugin (`04-validation.md` P1–P2). The app
recognises the component already — it badges a plugin with `.mcp.json` as "mcp"
(`src/lib/plugins.ts:217`) — and has never been told it works.

What the app lacks is not delivery but **sight**: nothing reads which MCP servers
a cycle actually got. Every cycle's `system:init` event, which lists each server
with its status and every tool, is stored whole (`src/lib/orchestrator.ts:8153`)
and hidden from the feed (`src/lib/logLine.ts:726`); no code reads its
`mcp_servers` field.

## Recommendation, in one line

**Ship the local reader as a plugin in LocalModelOffload, switch it on in
Settings › Plugins, and build the one generic piece that is missing: a per-cycle
reading of which MCP servers connected and how many tools each listed, from the
`system:init` events already stored. Then revert the trial commit (`ba4ff72`).**
[`03-recommendation.md`](03-recommendation.md) has the shape, the migration, what
is refused by name and the four facts that would overturn it.

## The files

| File | What it holds |
|---|---|
| [`01-constraints.md`](01-constraints.md) | How MCP configuration reaches a cycle today, the rules any design must keep, and the open unknowns |
| [`02-options.md`](02-options.md) | Four candidates, each with its strongest case, the case against, its cost and a verdict; one refused outright |
| [`03-recommendation.md`](03-recommendation.md) | The shape to build, the migration off the trial branch, refused by name, what would overturn it, found on the way |
| [`04-validation.md`](04-validation.md) | The probes run for this proposal, each with its command and output |

## The options at a glance

| | A. Operator's `~/.claude` | **B. Plugin** | C. One JSON env var | D. Declared server files |
|---|---|---|---|---|
| App code to deliver a server | none | **none** | parser, and the config decoupled from the taskboard | mount, parser, merge, UI group, tests |
| Where a server is defined | a file shared with the operator's Mac | a plugin directory in a workspace mount | `.env` | `mcp/<name>/server.json` on the host |
| Change takes effect | next session | next cycle, from a switch | container restart | next cycle |
| Reaches | work cycles; assists assumed | work cycles only | work cycles only | whatever the merge decides |
| Can shadow `uf` | yes, by name | no: named `plugin:<plugin>:<server>` | only if not refused | only if not refused |
| Credentials | in a file the Mac also reads | no (files are agent-readable) | yes, env | yes, by name |
| Verified here | reaches runs, and **fails** in them | **P1–P3** | no | no |
| Verdict | refused as the vehicle | **recommended** | dominated by B | runner-up; the answer if a server needs a credential |
