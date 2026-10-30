#!/bin/bash
# Measures the pinned Codex CLI's (0.153.4) MCP tool-call timeout, the Codex
# analogue of mcp-wait-probe.sh: `codex exec` against codex-stub-responses.mjs
# (the model) and mcp-stub.mjs (the tool), both on loopback, nothing billed.
# A scratch CODEX_HOME is used, so the operator's ~/.codex is never read.
#
#   codex-mcp-timeout-probe.sh <label> <mode> <delaySec> [tool_timeout_sec]
#     mode: json | sse | sse-keepalive | sse-progress   (see mcp-stub.mjs)
#     tool_timeout_sec: passed as -c mcp_servers.sup.tool_timeout_sec=<n>; omit
#                       to measure the default
#   env:  OUTROOT=<dir>  default $TMPDIR/runsupervisor-27
#
# Run it as one Bash call (stubs and CLI share the call's network namespace).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LABEL=$1; MODE=$2; DELAY=$3; TOOLTO=${4:-}
OUTROOT=${OUTROOT:-${TMPDIR:-/tmp}/runsupervisor-27}
OUT=$OUTROOT/$LABEL; rm -rf "$OUT"; mkdir -p "$OUT/codex-home" "$OUT/cwd" "$OUT/api" "$OUT/mcp"
node "$HERE/codex-stub-responses.mjs" "$OUT/api" > "$OUT/api.port" 2>&1 &
API_PID=$!
node "$HERE/mcp-stub.mjs" "$OUT/mcp" "$MODE" "$DELAY" 30 > "$OUT/mcp.port" 2>&1 &
MCP_PID=$!
trap 'kill $API_PID $MCP_PID 2>/dev/null' EXIT   # a pending call keeps the MCP stub alive past the CLI
for _ in $(seq 100); do grep -q PORT "$OUT/api.port" && grep -q PORT "$OUT/mcp.port" && break; sleep 0.1; done
API_PORT=$(awk '/PORT/{print $2}' "$OUT/api.port"); MCP_PORT=$(awk '/PORT/{print $2}' "$OUT/mcp.port")
cat > "$OUT/codex-home/config.toml" <<TOML
model = "stub-model"
model_provider = "stub"
[model_providers.stub]
name = "stub"
base_url = "http://127.0.0.1:$API_PORT/v1"
env_key = "STUB_KEY"
wire_api = "responses"
[mcp_servers.sup]
url = "http://127.0.0.1:$MCP_PORT/api/mcp"
TOML
# approval_policy="never" and default_tools_approval_mode="approve" are what
# cycleInvocation.ts passes a Codex cycle (codexTaskboardArgs, the sandbox
# table); without them the MCP call is refused before it is made.
EXTRA=(-c 'approval_policy="never"' -c 'mcp_servers.sup.default_tools_approval_mode="approve"')
[ -n "$TOOLTO" ] && EXTRA+=(-c "mcp_servers.sup.tool_timeout_sec=$TOOLTO")
cd "$OUT/cwd"
START=$(date +%s)
env -i HOME="$OUT/codex-home" PATH="$PATH" CODEX_HOME="$OUT/codex-home" STUB_KEY=fake \
  timeout -s KILL $((DELAY + 180)) codex exec --json --skip-git-repo-check -s read-only "${EXTRA[@]}" "ROLE probe: call the supervisor tool" \
  </dev/null 2> "$OUT/stderr.txt" | node "$HERE/stamp.mjs" > "$OUT/stdout.stamped"
EXIT=${PIPESTATUS[0]}
{
  echo "== $LABEL mode=$MODE delay=${DELAY}s tool_timeout_sec='${TOOLTO}' exit=$EXIT elapsed=$(( $(date +%s) - START ))s"
  echo "-- stdout (timestamp, first 230 chars):"; cut -c1-260 "$OUT/stdout.stamped"
  echo "-- model requests:"; cut -c1-500 "$OUT/api/requests.jsonl"
  echo "-- mcp stub events:"; cut -c1-260 "$OUT/mcp/mcp.jsonl"
  echo "-- stderr:"; head -c 600 "$OUT/stderr.txt"
} | tee "$OUT/summary.txt"
