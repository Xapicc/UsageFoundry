#!/bin/bash
# Measures whether an MCP tool call that answers only after DELAY seconds
# survives the pinned Claude Code CLI (2.1.310) over the app's transport
# (streamable "http", bearer header, as chat.ts writeMcpConfig writes it), and
# what the CLI prints to stdout meanwhile. Nothing is billed: the Anthropic API
# is stub-api.mjs and the MCP server is mcp-stub.mjs, both on loopback.
#
#   mcp-wait-probe.sh <label> <mode> <delaySec> [tickSec]
#     mode: json | sse | sse-keepalive | sse-progress   (see mcp-stub.mjs)
#   env:  EXTRA_ENV="MCP_TOOL_TIMEOUT=900000 ..."  extra variables for the CLI
#         SERVER_TIMEOUT_MS=<ms>  adds "timeout": <ms> to the server's entry in the
#                  --mcp-config file (the per-server tool-call timeout the CLI documents)
#         WALL=<sec>  kill the CLI after this long (default delay + 120)
#         OUTROOT=<dir>  where results go (default $TMPDIR/runsupervisor-27)
#
# Start the stubs and the CLI in ONE Bash call (each Bash call has its own
# network namespace). Output: $OUTROOT/<label>/{stdout.stamped,summary.txt,...};
# the same text is printed. Read summary.txt with the Read tool if a hook
# strips the Bash result.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LABEL=$1; MODE=$2; DELAY=$3; TICK=${4:-30}
OUTROOT=${OUTROOT:-${TMPDIR:-/tmp}/runsupervisor-27}
OUT=$OUTROOT/$LABEL; rm -rf "$OUT"; mkdir -p "$OUT/cfg" "$OUT/home" "$OUT/cwd" "$OUT/tmp" "$OUT/api" "$OUT/mcp"
WALL=${WALL:-$((DELAY + 120))}

node "$HERE/stub-api.mjs" "$OUT/api" mcp-ask > "$OUT/api.port" 2>&1 &
API_PID=$!
node "$HERE/mcp-stub.mjs" "$OUT/mcp" "$MODE" "$DELAY" "$TICK" > "$OUT/mcp.port" 2>&1 &
MCP_PID=$!
trap 'kill $API_PID $MCP_PID 2>/dev/null' EXIT   # a pending call keeps the MCP stub alive past the CLI
for _ in $(seq 100); do grep -q PORT "$OUT/api.port" && grep -q PORT "$OUT/mcp.port" && break; sleep 0.1; done
API_PORT=$(awk '/PORT/{print $2}' "$OUT/api.port"); MCP_PORT=$(awk '/PORT/{print $2}' "$OUT/mcp.port")
TIMEOUT_FIELD=""
[ -n "${SERVER_TIMEOUT_MS:-}" ] && TIMEOUT_FIELD=",\"timeout\":$SERVER_TIMEOUT_MS"
cat > "$OUT/mcp-config.json" <<JSON
{"mcpServers":{"sup":{"type":"http","url":"http://127.0.0.1:$MCP_PORT/api/mcp","headers":{"Authorization":"Bearer probe-token"}$TIMEOUT_FIELD}}}
JSON

cd "$OUT/cwd"
START=$(date +%s)
# The argv is the app's shape (src/lib/cycleInvocation.ts buildArgs), minus the
# flags that do not bear on MCP: -p, stream-json + --verbose + hook events,
# --allowedTools, --mcp-config, then the prompt after "--".
env -i HOME="$OUT/home" PATH="$PATH" TERM=dumb TMPDIR="$OUT/tmp" CLAUDE_CONFIG_DIR="$OUT/cfg" \
  ANTHROPIC_BASE_URL="http://127.0.0.1:$API_PORT" ANTHROPIC_API_KEY=sk-ant-fake \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_HARBOR_KITE=0 ${EXTRA_ENV:-} \
  timeout -s KILL "$WALL" claude -p --output-format stream-json --verbose --include-hook-events \
    --allowedTools mcp__sup__ask_supervisor \
    --mcp-config "$OUT/mcp-config.json" -- "ROLE probe: call the supervisor tool" \
  </dev/null 2> "$OUT/stderr.txt" | node "$HERE/stamp.mjs" > "$OUT/stdout.stamped"
EXIT=${PIPESTATUS[0]}
END=$(date +%s)

{
  echo "== $LABEL mode=$MODE delay=${DELAY}s tick=${TICK}s extra_env='${EXTRA_ENV:-}' server_timeout_ms='${SERVER_TIMEOUT_MS:-}' exit=$EXIT elapsed=$((END - START))s"
  echo "-- stdout lines (timestamp, type/subtype, first 110 chars):"
  node -e '
    const fs=require("fs");
    for (const l of fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean)) {
      const i=l.indexOf(" "); const ts=l.slice(0,i); let j; try{j=JSON.parse(l.slice(i+1));}catch{j={type:"?"};}
      console.log(ts, (j.type||"")+"/"+(j.subtype||""), l.slice(i+1).slice(0,110).replace(/\n/g," "));
    }' "$OUT/stdout.stamped"
  echo "-- anthropic stub requests (main loop only):"
  grep '"isMain":true\|response-finished' "$OUT/api/requests.jsonl" | cut -c1-400
  echo "-- mcp stub events:"
  cat "$OUT/mcp/mcp.jsonl" | cut -c1-300
  echo "-- stderr:"; head -c 800 "$OUT/stderr.txt"
} | tee "$OUT/summary.txt"
