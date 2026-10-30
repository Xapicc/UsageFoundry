#!/bin/sh
# Reproduce every RunSupervisor figure, read-only, from the session transcripts under
# /home/node/.claude/projects (override with RS_PROJECTS) and the source tree.
#
# Usage: sh measure-all.sh [OUT_DIR]       default OUT_DIR=/tmp/claude-1000/runsupervisor-27/measure
# Each script's output is written to OUT_DIR/<name>.txt and then printed. Read the
# files rather than the console where a harness strips Bash output (see the vault's
# note on winnow rule C3).
#
# Deterministic: the transcripts are read up to the CUTOFF in corpus.py (sessions that
# began on or after 2026-10-30 are ignored) and samples are seeded (sampling.py).
# Order: corpus cache, source markers, then kinds 1-8 of the brief.
set -eu
export PYTHONDONTWRITEBYTECODE=1
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:-/tmp/claude-1000/runsupervisor-27/measure}
mkdir -p "$OUT"
export RS_OUT="$OUT/cache"

run() {
  name=$1; shift
  echo "=================== $name"
  python3 "$HERE/$@" > "$OUT/$name.txt" 2>&1 || { cat "$OUT/$name.txt"; echo "FAILED: $name" >&2; exit 1; }
  cat "$OUT/$name.txt"
}

echo "=================== classification rules"
cat "$HERE/rules.txt"
run corpus-build corpus.py build "$OUT/cache"
run corpus-summary corpus.py summary "$OUT/cache"
run markers markers.py
run 1-needs-review needs_review.py
run 2-request-stack request_stack.py
run 3-follow-ups follow_ups.py
run 4-final-reports final_reports.py
run 5-known-errors known_errors.py --runs
run 6-already-done already_done.py
run 7-destructive-stops destructive_stops.py
run 8-chat-ask-operator chat_ask_operator.py
run summary summary.py
