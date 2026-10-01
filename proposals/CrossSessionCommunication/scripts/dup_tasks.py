#!/usr/bin/env python3
"""Near-duplicate create_task calls across different runs on the same repository.

A pair is two create_task calls from two different runs (runs.json keys),
same repository (the call's `folder` basename, else the run's repo), whose
titles score >= THRESHOLD on difflib's ratio or on word Jaccard. Each pair is
tagged by whether the two runs were live at the same time (filled minutes)
and whether the second call came while the first run was still live.

Usage: python3 dup_tasks.py sessions.jsonl runs.json [THRESHOLD] > dup-tasks.txt
"""
import json
import re
import sys
from difflib import SequenceMatcher
from itertools import combinations

SESSIONS, RUNS = sys.argv[1:3]
THRESHOLD = float(sys.argv[3]) if len(sys.argv) > 3 else 0.6
STOP = {"the", "a", "an", "of", "to", "in", "on", "and", "or", "for", "is", "it", "its", "that", "with", "by", "as", "at", "be", "not", "when", "from"}


def words(title):
    return {w for w in re.findall(r"[a-z0-9_./-]+", title.lower()) if w not in STOP}


runs = json.load(open(RUNS))
run_of_file = {f: r for r in runs for f in r["files"]}
calls = []
for line in open(SESSIONS):
    record = json.loads(line)
    run = run_of_file.get(record["file"])
    if not run:
        continue
    for call in record["task_calls"]:
        if not call.get("title"):
            continue
        folder = (call.get("folder") or "").rstrip("/").rsplit("/", 1)[-1].lower() or run["repo"]
        calls.append({"run": run["key"], "repo": folder, "ts": call["ts"], "title": call["title"],
                      "words": words(call["title"]), "live": set(run["filled"])})

print(f"create_task calls from runs: {len(calls)}, threshold {THRESHOLD}")
pairs = []
for a, b in combinations(sorted(calls, key=lambda c: c["ts"]), 2):
    if a["run"] == b["run"] or a["repo"] != b["repo"]:
        continue
    ratio = SequenceMatcher(None, a["title"].lower(), b["title"].lower()).ratio()
    union = a["words"] | b["words"]
    jaccard = len(a["words"] & b["words"]) / len(union) if union else 0
    if max(ratio, jaccard) < THRESHOLD:
        continue
    concurrent = bool(a["live"] & b["live"])
    pairs.append((max(ratio, jaccard), concurrent, a, b))

pairs.sort(key=lambda p: -p[0])
print(f"pairs: {len(pairs)}, between concurrently live runs: {sum(p[1] for p in pairs)}")
for score, concurrent, a, b in pairs:
    print(f"\n{score:.2f} {'CONCURRENT' if concurrent else 'sequential'} [{a['repo']}]")
    print(f"  {a['ts'][:16]} {a['run'][-30:]}: {a['title'][:150]}")
    print(f"  {b['ts'][:16]} {b['run'][-30:]}: {b['title'][:150]}")
