# Recommendation

## In one line

**An extra MCP server reaches work cycles as a Claude Code plugin the operator
switches on in Settings › Plugins; the app builds only the reading of what each
cycle actually got.**

## The case

Delivery is solved already: plugins are discovered, validated, contained,
switched and audited, and reach exactly the children LocalModelOffload wanted
(C6, C4), and on the pinned CLI a plugin's MCP server starts and lists its tools
(`04-validation.md` P1–P2). Going through the plugin removes the trial's three
faults without writing a fix for them: the server no longer depends on the
taskboard switch (C1), cannot take `uf` down with it (C2) and cannot shadow it
(C3). It adds no `UF_` variable (C10), no table (C9) and no field on an agent
(C7). What the app cannot do for any option is say whether a cycle got the
server, and that reading is generic, small, and built from data already stored
(C11). It is the only app code this recommendation asks for.

## The shape to build

### 1. In LocalModelOffload: the local reader as a plugin

```
plugin/.claude-plugin/plugin.json   {"name": "local-reader", "version": "0.4.0", "description": "…"}
plugin/.mcp.json.example            committed
plugin/.mcp.json                    the operator's copy, gitignored
```

```json
{"mcpServers": {"local": {
  "command": "node",
  "args": ["${CLAUDE_PLUGIN_ROOT}/../poc/local-reader.mjs"],
  "env": {
    "LOCAL_READER_BASE_URL": "http://<host>:1234/v1",
    "LOCAL_READER_MODEL": "<model id as LM Studio lists it>",
    "LOCAL_READER_LOG": "<optional: where the trial log goes>"
  }
}}}
```

The shape is the one P2 ran. The operator's copy holds a LAN address, a model
id and a log path. It is install-specific, which is why it is gitignored, and it
holds no credential, which is why a workspace mount is an acceptable place for
it (option B's first limit). The tools become
`mcp__plugin_local-reader_local__local_scan` and so on. The server's
instructions name the tools without the prefix, as they did under `uf_local`.

### 2. In the app: what each cycle got

- **A pure parser, `src/lib/mcpStatus.ts`.** It reads a stored `system:init`
  payload and returns `{name, status, source, tools}` for each entry in
  `mcp_servers`. `tools` counts the entries of the init `tools` list that start
  with `mcp__<name with every character outside [A-Za-z0-9_-] replaced by _>__`.
  That is the mapping P2 shows: `plugin:local-reader:local` gives
  `mcp__plugin_local-reader_local__`.

  The unit tests cover that mapping, a `failed` server, and a connected server
  that lists zero tools. The last case is the local reader when its model is
  not loaded, which the trial counts as not offered. A wrong count here would
  pass silently, which is the case the testing rule for pure functions is for
  (`docs/agent/testing/the-bar.md`, "Every one earns it on the same grounds —
  pure functions whose failure modes are silent and expensive").
- **Two read sites, both derived when read.** Nothing is stored twice, which is
  stacks' reason for keeping no table (`src/lib/stacks.ts:26`).
  - The run page shows one line per cycle, for example `MCP: uf 5 ·
    plugin:local-reader:local 6 · daiveloper failed`.
  - Settings › Plugins shows, beside each plugin with the "mcp" badge, what its
    servers did in the most recent cycle that had it on.

  Events are kept for 30 days (`src/lib/settings.ts:1036`), and a status older
  than that says so rather than going blank.
- **No argv change and no config change.** The line above is the whole of the
  app's part.

For the trial, the reader replaces the PoC's own session log as the record of
what each cycle was offered: a cycle with the server connected and more than
zero tools is "offered". LocalModelOffload's `uf-report.mjs` can then read it
from the database it already queries.

### 3. Leaving the trial branch

The order matters, because a cycle holding both `uf_local` and the plugin would
list every tool twice (U3).

1. Wait until no cycle is in flight. A rebuild stops them, and the interrupted
   cycles' spend is recovered while their work is lost.
2. Write `plugin/.mcp.json` from the example, with the values now in the trial
   worktree's `.env.trial`.
3. Redeploy from the operator's checkout on `main`. `UF_LOCAL_READER_*` and
   `uf_local` disappear from every cycle.
4. Switch "local-reader" on in Settings › Plugins. It no longer needs
   `taskboardForRuns`.
5. Check the first cycle with the query in `04-validation.md` P4:
   `plugin:local-reader:local` should be `connected` with six tools. U2 is
   settled if the plugin was listed at all.
6. In LocalModelOffload, the trial scripts that match `mcp__uf_local__`
   (`poc/realworld/lib.mjs`, `run.mjs`) match the `local_*` tools under either
   prefix.

This proposal was written on `local-offload-trial`. It belongs on `main` with or
without the revert.

The Mac is optional and the operator's call. Its user-scope `uf_local` entry
fails in every container cycle (C5). Replacing it with
`claude --plugin-dir ~/Documents/GIT/LocalModelOffload/plugin` would leave one
definition that works in both places.

## Refused by name

- **A second `--mcp-config` flag per server.** It would replace the taskboard's
  file rather than join it (C1).
- **A `UF_` variable per server.** This is the trial's shape. Each one costs
  C10's four files and a test, and the app ends up naming the server.
- **The operator's `~/.claude` as the vehicle.** Its paths are the Mac's
  (option A).
- **A form-backed registry, and per-agent or per-run server lists.** These fail
  C9, C8 and C7 respectively.
- **Extra servers or plugins for the chat.** The chat's tool surface is closed on
  purpose (C4), and strict mode drops plugin servers anyway (P5).

## What would overturn this

Each item is a fact that can be observed, not an opinion.

1. **A CLI release in which `--plugin-dir` stops starting a plugin's `.mcp.json`
   server under `-p` or under the sandbox.** The reader in §2 shows it: the
   `plugin:…` entry is absent or `failed` in every cycle after the upgrade,
   while the same server starts when run by hand. Then use D.
2. **A server that needs a credential.** A plugin file is readable by agents, and
   environment expansion costs a compose line per variable. Then use D, with
   secrets by name.
3. **A server wanted on some repositories only.** Plugins are install-wide
   (`src/app/settings/page.tsx:4387`). Then use D with a per-repository map.
4. **A server that must know which run is calling, write to the run's own log,
   or share one queue across runs.** These are the things LocalModelOffload
   found the operator's own config cannot do
   (`proposals/LocalModelOffload/04-option-c-local-agent-mcp.md:197`). That
   calls for a tool in the app's own `/api/mcp`, not an extra server at all.

## If overruled

If D is chosen anyway, build §2 first. D needs it just as much: it is the only
way to see whether a declared server started.

## Found on the way, filed rather than fixed

- `docs/install.md:81`–`docs/install.md:83` says user-scope MCP servers do not
  reach the container. On CLI 2.1.280 they do, and they fail there (C5, P4).
- The plugin toggle's audit row records `POST /api/plugins` and its status, but
  not which plugin was switched or in which direction. The route has no path
  parameter for `subjectFromParams` to find
  (`src/lib/requestLog.ts:282`–`src/lib/requestLog.ts:293`).
- An enabled plugin whose directory has gone cannot be switched off.
  `setPluginEnabled` refuses a path that is no longer a plugin even when the
  request is to disable it (`src/lib/plugins.ts:338`–`src/lib/plugins.ts:348`),
  and the page shows such an entry only under problems, without a switch.
- A malformed manifest at a mount root is skipped with no problem reported
  (`src/lib/plugins.ts:301`), unlike one further down.
- The compaction notice labels any `--mcp-config` as "the definitions of the
  taskboard tools" (`src/lib/orchestrator.ts:5325`). That is wrong on this
  branch, where the file also holds `uf_local`.
- `docs/security.md:149` says a run's capability is three tools. `RUN_TOOLS`
  has five (`src/app/api/mcp/route.ts:498`).
