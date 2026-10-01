#!/usr/bin/env python3
"""Sensitivity check: does counting sub-agent minutes as the parent run's live
time change the concurrency figures? A run's main transcript is quiet while a
sub-agent works, so the headline (main transcript only) is a floor.

Adds the minutes of <session>/subagents/*.jsonl to the owning run, then
re-applies concurrency.py's fill and stats.

Usage: python3 subagent_sensitivity.py runs.json [GAP]
"""
import glob
import json
import os
import sys
from collections import defaultdict
from datetime import datetime

RUNS = sys.argv[1]
GAP = int(sys.argv[2]) if len(sys.argv) > 2 else 10

# concurrency.py reads its own argv at import time.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.argv = [sys.argv[0], "unused", str(GAP)]
from concurrency import fill, stats  # noqa: E402

runs = json.load(open(RUNS))
added = 0
for run in runs:
    minutes = set(run["minutes"])
    for path in run["files"]:
        for sub in glob.glob(os.path.join(path[: -len(".jsonl")], "subagents", "*.jsonl")):
            for raw in open(sub, "rb"):
                try:
                    ts = json.loads(raw).get("timestamp")
                except ValueError:
                    continue
                if ts:
                    minutes.add(int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() // 60))
    added += len(minutes) - len(run["minutes"])
    run["minutes"], run["filled"] = minutes, fill(minutes, GAP)

by_repo = defaultdict(list)
for run in runs:
    if run["kind"] != "dispatcher":
        by_repo[run["repo"]].append(run)
print(f"sub-agent minutes added: {added}")
for repo in ("usagefoundry", "dockrac", "foundrycode"):
    print(repo, stats(by_repo[repo], "filled"))
