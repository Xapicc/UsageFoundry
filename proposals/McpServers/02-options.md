# The options

Each is judged on the same five things: what it costs the app, whether a fault
in one server can cost a cycle anything else (C2, C3), whether it keeps the
chat and the agent model as they are (C4, C7), where a credential would live
(C8), and whether the app can see what a cycle got (C11).

## A. The operator's own `~/.claude`

**What it is in this app.** `claude mcp add --scope user` writes the server into
the CLI's config directory, which the container mounts (C5). Work cycles are not
strict, so it reaches all of them (C4).

**Its strongest case.** No app code at all, and the non-strict argv was kept for
exactly this: "the operator's own MCP servers … are part of what their agents
work with" (`src/lib/cycleInvocation.ts:1190`–`src/lib/cycleInvocation.ts:1193`).
LocalModelOffload's earlier trial used it for that reason
(`proposals/LocalModelOffload/04-option-c-local-agent-mcp.md:197`).

**The case against.** The file serves two machines with different paths, and it
already shows: both user-scope servers the operator has on the Mac, `uf_local`
and `daiveloper`, reach every work cycle and fail there, because their `command`
and `args` are Mac paths (`04-validation.md` P4). A definition that works in one
place is broken in the other, and every edit to it on the Mac changes what
unattended runs load. There is no switch in the app, no record of which cycles
had it, and adding one in the container means `docker exec` and a CLI command.

**What it costs.** Nothing to build; ongoing confusion.

**Verdict.** Refused as the vehicle. It stays what it is today: the operator's
own servers riding along, which the design must not break (C4).

## B. A Claude Code plugin, switched on in Settings › Plugins

**What it is in this app.** A directory with `.claude-plugin/plugin.json` and a
`.mcp.json` inside a workspace mount. Settings › Plugins lists it with an "mcp"
badge (`src/lib/plugins.ts:217`); switching it on stores its path
(`src/lib/plugins.ts:337`) and every work cycle gets `--plugin-dir` from the next
cycle on (C6). The CLI names the server `plugin:<plugin>:<server>` and its tools
`mcp__plugin_<plugin>_<server>__<tool>` (`04-validation.md` P1).

**Its strongest case.** Everything the app would have to build for a server
registry already exists for plugins, verified or reviewed: discovery, the
manifest check, containment proved twice, its own settings row, an audited
toggle (`src/app/api/plugins/route.ts:61`), a line on the run's log when an
enabled plugin cannot be loaded, and reach limited to work cycles — which is the
reach LocalModelOffload wanted (C4). The server cannot shadow `uf`, because the
CLI prefixes its name. A fault in it costs nothing else: the CLI reports it as
`failed` and starts the session anyway (P3), and the app's own config file is
not involved, so C2 cannot happen. The unit is a directory that can be
copied and shared, which is CustomStacks' R2 (C9); and the same directory works
on the Mac with `claude --plugin-dir`, so one definition can replace the
user-scope entry that fails in the container.

**The case against.** Three limits, all real.
- **No credentials.** A plugin sits in a workspace mount, which agents can read
  and write; a token in its `.mcp.json` is readable by every agent. `${VAR}`
  expansion would need the variable in the container's environment, which is a
  compose line per variable (C10). For a credential-free server such as the
  local reader this costs nothing; for a server with a key it rules B out.
- **Install-wide.** A plugin is on for every work cycle or none. There is no
  per-repository switch.
- **The app still cannot see whether it loaded.** The plugin log line covers
  "no longer a plugin directory", not "the CLI failed to start its server"
  (`src/lib/orchestrator.ts:9183`–`src/lib/orchestrator.ts:9191`). That gap is
  C11, and it is the same gap for every option.

Agents can also edit the plugin's files, since the mount is theirs; that is
already true of every enabled plugin and of the trial's server file, so B adds
nothing new there.

**What it costs.** For delivery, nothing in the app. For sight, the C11 reader
in [`03-recommendation.md`](03-recommendation.md), which every option needs.

**Verdict.** Recommended.

## C. One JSON variable, `UF_MCP_SERVERS`

**What it is in this app.** The trial's `localReaderServers` generalised: the
variable holds `{"name": {…server…}}`, parsed and validated at boot and merged
into the per-cycle config beside `uf`.

**Its strongest case.** The smallest change from this branch, and the only
candidate besides D where a credential can sit in the environment as C8 wants.

**The case against.** A JSON object inside `.env` is hard to write and harder to
review; every change is a container restart, which stops the cycles in flight.
It inherits C1's coupling — the servers exist only while `taskboardForRuns` is
on — unless the config is rewritten to be written when either is on. It needs a
name check against `uf` (C3) and per-server fault isolation (C2), neither of
which exists. And it has no place in the UI: the operator learns what is loaded
by reading `.env`.

**What it costs.** One variable through C10's four files, a parser with tests,
the decoupling, the name refusal, the fault isolation.

**Verdict.** Dominated. B does the credential-free case with no code and a
switch; D does the credential case properly.

## D. Declared server files, merged into the cycle's config

**What it is in this app.** The CustomStacks pattern applied to MCP: a host
directory `mcp/<name>/server.json`, mounted read-only like `stacks/`
(`docker-compose.yml:591` is the stacks bind), validated by a parser in the
style of `parseStack` (name rules, `uf` refused, stdio or http only, the stacks'
env refusal list), merged into the per-cycle config beside `uf`, and listed in
Settings › Tools the way stacks are. A credential is a name, never a value —
`{"fromEnv": "UF_MCP_SECRET_X"}`, resolved when the 0600 file is written — which
is CustomStacks' designed and unbuilt secret field
(`proposals/CustomStacks/23-revision-per-repo-and-login.md:216`).

**Its strongest case.** The app owns the whole path: names, validation,
credentials by reference, and a per-repository map if one is ever needed, in the
shape `isolationCopyGlobsByRepo` already has (`src/lib/settings.ts:452`). It is
the only option that could later reach the chat, if that were ever wanted.

**The case against.** For a server without a credential it rebuilds what
plugins already are — a declared directory that is discovered, validated,
switched and contained — as a second mechanism beside them. It needs the C1
decoupling and the C2 and C3 fixes that B gets from the CLI for free, a new
mount (C10, and the deployment pins), a parser with tests, and a UI group. A
credential written into the per-cycle file is readable by the agent uid, as the
taskboard token is (`docs/agent/security.md:33`); that is the existing bound,
not a new one, but it is not secrecy from the agent.

**What it costs.** Roughly stacks' phases 1 and 2 over again.

**Verdict.** Runner-up. It is the answer the moment a server needs a credential
or a per-repository switch (the overturn list in
[`03-recommendation.md`](03-recommendation.md)).

## Refused outright: a registry typed into a form

A settings-page form that saves server definitions to the database fails C9 by
definition, and any credential field on it fails C8. Per-agent or per-run server
lists fail C7. None of the three is argued further.
