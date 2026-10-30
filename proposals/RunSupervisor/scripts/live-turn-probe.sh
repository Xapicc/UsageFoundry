#!/bin/bash
# Measures what the pinned Claude Code CLI (2.1.310) does when a second user
# message is written to stdin of `claude -p --input-format stream-json` while the
# first turn is still running. Real CLI, loopback stub API, nothing billed.
#
#   live-turn-probe.sh <case> [label]
#     case: base | replay | single | eofduring | midstream | sequential |
#           sequentialnr | maxturns2 | maxturnsseq | budget | budgetseq |
#           posprompt | slowread   (what each does: the table in live-driver.mjs)
#   env:  RESUME_SESSION=<id>  add --resume <id> to the CLI's argv. The resumed
#         run must reuse the first run's label (same config dir and cwd):
#           live-turn-probe.sh single r1
#           RESUME_SESSION=<session_id from r1> live-turn-probe.sh replay r1
#         BUDGET=<usd>         the --max-budget-usd of the `budget` case
#         OUTROOT=<dir>        default $TMPDIR/runsupervisor-27
#
# Run it as one Bash call (the stub and the CLI share the call's network
# namespace). Prints, and writes to $OUTROOT/<label>/summary.txt: the timeline,
# every stdout frame (type/subtype), each `result` event's cost and usage, and
# what user-role text each /v1/messages request carried.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
CASE=$1; LABEL=${2:-live-$CASE}
OUTROOT=${OUTROOT:-${TMPDIR:-/tmp}/runsupervisor-27}
OUT=$OUTROOT/$LABEL
timeout -s KILL 200 node "$HERE/live-driver.mjs" "$OUT" "$CASE"
{
  echo "== case=$CASE ${RESUME_SESSION:+resume=$RESUME_SESSION }(label $LABEL)"
  echo "-- timeline:"; cat "$OUT/timeline.txt"
  echo "-- stdout frames:"
  node -e '
    const fs=require("fs");
    for (const l of fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean)) {
      const i=l.indexOf(" "); const ts=l.slice(0,i); const j=JSON.parse(l.slice(i+1));
      let extra="";
      if (j.type==="user") extra=" "+JSON.stringify(j.message?.content).slice(0,160)+(j.isReplay?" isReplay":"")+(j.synthetic?" synthetic":"");
      if (j.type==="assistant") extra=" "+JSON.stringify(j.message?.content).slice(0,100);
      if (j.type==="result") { const {type,subtype,is_error,num_turns,total_cost_usd,usage,result,stop_reason,terminal_reason,duration_ms,session_id}=j; extra=" "+JSON.stringify({is_error,num_turns,total_cost_usd,usage:usage&&{in:usage.input_tokens,out:usage.output_tokens},result:(result||"").slice(0,80),stop_reason,terminal_reason,session_id}); }
      if (j.type==="system"&&j.subtype==="init") extra=" session_id="+j.session_id;
      console.log(ts, j.type+"/"+(j.subtype||""), extra);
    }' "$OUT/stdout.stamped"
  echo "-- /v1/messages main-loop requests and the user-role text each carried:"
  node -e '
    const fs=require("fs");
    for (const l of fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean)) {
      const j=JSON.parse(l); if (!j.isMain) continue;
      console.log(j.t, "step", j.step, "->", j.answer);
      for (const b of j.userBlocks) if (!b.startsWith("<system-reminder>")) console.log("      user:", b.slice(0,160).replace(/\n/g," "));
    }' "$OUT/api/requests.jsonl"
  echo "-- stderr:"; head -c 600 "$OUT/stderr.txt" 2>/dev/null
} | tee "$OUT/summary.txt"
