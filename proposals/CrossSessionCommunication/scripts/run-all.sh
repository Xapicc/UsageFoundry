#!/bin/sh
# Reproduce every figure in the cross-session evidence, read-only.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:-${TMPDIR:-/tmp}/uf-cross-session/data}; mkdir -p "$OUT"
DUMP=/workspace/UsageFoundry/prune-audit-dump.json

python3 "$HERE/index_sessions.py" > "$OUT/sessions.jsonl"
python3 "$HERE/concurrency.py" "$OUT/sessions.jsonl" 10 > "$OUT/runs.json" 2> "$OUT/concurrency-summary.json"
python3 "$HERE/subagent_sensitivity.py" "$OUT/runs.json" 10
python3 "$HERE/dump_concurrency.py" "$DUMP" > "$OUT/dump-concurrency.txt"
python3 "$HERE/commit_map.py" "$OUT/sessions.jsonl" > "$OUT/commit-map.json"
python3 "$HERE/collisions.py" "$OUT/sessions.jsonl" "$OUT/runs.json" "$DUMP" "$OUT/commit-map.json" > "$OUT/collisions.json"
python3 "$HERE/report_collisions.py" "$OUT/collisions.json" > "$OUT/collisions-report.txt"
python3 "$HERE/dup_tasks.py" "$OUT/sessions.jsonl" "$OUT/runs.json" 0.6 > "$OUT/dup-tasks.txt"
python3 "$HERE/keyword_hunt.py" "$OUT/runs.json" > "$OUT/keyword-hits.txt"
python3 "$HERE/peer_usage.py" > "$OUT/peer-usage.txt"
