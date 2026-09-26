# Validation

Every probe below ran on 2026-09-26 inside the running `usagefoundry` container
(CLI 2.1.280, `UF_SANDBOX=1`, as uid 1000 unless said otherwise) against
LocalModelOffload's server at `/workspace/LocalModelOffload/poc/local-reader.mjs`
and LM Studio at 192.168.0.190 with `qwen/qwen3.6-35b-a3b` loaded. Each probe ran
`claude -p` in a scratch directory under `/tmp` and stopped reading at the
`system:init` event; the rest of each session's output was discarded. The plugin directories were
deleted afterwards.

The command shape, with `$P` being the plugin directory:

```sh
docker exec -u 1000 usagefoundry sh -c 'cd /tmp/lr-probe-root && \
  claude -p "Reply with the single word OK." --output-format stream-json --verbose \
    --plugin-dir $P --max-turns 1 | node -e "…print init.mcp_servers and the matching init.tools…"'
```

## P1 — a plugin's `.mcp.json` server starts under `--plugin-dir`

The plugin was `.claude-plugin/plugin.json` (`{"name": "local-reader-probe", …}`)
plus a `.mcp.json` naming the server by its absolute path.

```
servers: [{"name":"plugin:local-reader-probe:local","status":"connected","source":"plugin"},{"name":"uf_local","status":"failed","source":"user"}]
tools: mcp__plugin_local-reader-probe_local__local_digest … __local_explore … __local_review … __local_scan … __local_summarise … __local_task
plugins: local-reader-probe cowork-plugin-management engineering agents-md telemetry
```

The server's own log recorded `{"event":"session", …, "offered":true}`. The
`uf_local` entry that failed is the operator's user-scope server from the Mac
(P4).

## P2 — the server addressed relative to the plugin

The plugin was placed at `$X/plugin`, with `$X/poc` being the server's directory
beside it. This is the layout §1 of the recommendation proposes, and the args
were `["${CLAUDE_PLUGIN_ROOT}/../poc/local-reader.mjs"]`.

```
[{"name":"plugin:local-reader:local","status":"connected","source":"plugin"}] mcp__plugin_local-reader_local__local_digest 6 tools
```

## P3 — a broken plugin server fails alone

This run used `${CLAUDE_PLUGIN_ROOT}/server/local-reader.mjs` pointing at a copy
of the server without its `lib/` directory, so the process could not start. The
session started anyway and the init event was emitted:

```
[{"name":"plugin:local-reader-probe:local","status":"failed","source":"plugin"},{"name":"uf_local","status":"failed","source":"user"}] 0 tools
```

## P4 — what a trial cycle's init records, and where `uf_local` (user) comes from

This query ran as root against the app's database for run `2d9b5f13`, which
started at 22:11 UTC on this branch:

```sh
docker exec usagefoundry sqlite3 -readonly /data/usagefoundry.db \
  "select payload from run_events where run_id like '2d9b5f13%'
   and json_extract(payload,'$.message')='system:init' limit 1"
```

In `raw.mcp_servers`, the relevant entries were:
- `{"name":"daiveloper","status":"failed","source":"user"}`
- `{"name":"uf_local","status":"connected","source":"dynamic"}`
- `{"name":"uf","status":"connected","source":"dynamic"}`

`raw.tools` held the six `mcp__uf_local__*` tools. The trial's `uf_local` from
`--mcp-config` replaced the user-scope entry of the same name. There is one
`uf_local` in the list, and it is `dynamic`.

The user-scope entries are in the host's `~/.claude/.config.json`, which the
container reads as its config directory (C5):

```sh
python3 -c "import json,os; j=json.load(open(os.path.expanduser('~/.claude/.config.json'))); \
  [print(k, v.get('command'), *v.get('args', [])) for k, v in j['mcpServers'].items()]"
```

The output was:

```
daiveloper node /Users/hendrikkuehnel/Documents/GIT/DaiVELOPER/dist/server/main.js
uf_local /Users/hendrikkuehnel/.nvm/versions/node/v24.16.0/bin/node /Users/hendrikkuehnel/Documents/GIT/LocalModelOffload/poc/local-reader.mjs
```

Both commands name Mac paths, so both fail in every container cycle.

## P5 — strict mode drops plugin servers

This was P2's plugin again, with `--strict-mcp-config` added:

```
[] 0 tools
```

Neither the plugin's server nor the user-scope ones were listed. Even if the
chat were given `--plugin-dir`, its strict flag would keep plugin servers out.

## Not verified

- **U1, whether every cycle emits its own init.** It is assumed; the query in
  `01-constraints.md` settles it.
- **U2, discovery of `/workspace/LocalModelOffload/plugin` by Settings ›
  Plugins.** Expected from the walk depth. Nothing was created in
  LocalModelOffload for this proposal.
- **The plugin under a real work cycle's argv.** The probes passed only
  `--plugin-dir`, not the rest of `buildArgs`: no `--mcp-config`, no
  `--append-system-prompt`, no `--agents`, no `--settings` overlay. Step 5 of
  the migration settles it on the first real cycle.
