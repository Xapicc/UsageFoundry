#!/usr/bin/env python3
"""Same-repository run concurrency from the runs table in prune-audit-dump.json.

The dump (gitignored, /workspace/UsageFoundry/prune-audit-dump.json, written
2026-08-28) carries the runs table but not run_events, so the only interval it
gives is started_at..finished_at: the naive span, parked time included.
Repository = repo_root, else folder. Runs that never started are skipped.

Usage: python3 dump_concurrency.py /workspace/UsageFoundry/prune-audit-dump.json
"""
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from itertools import combinations

dump = json.load(open(sys.argv[1]))
runs = [r for r in dump["runs"] if r.get("started_at")]
horizon = max(max(r.get("finished_at") or 0, r["started_at"]) for r in runs)
by_repo = defaultdict(list)
for r in runs:
    start, end = r["started_at"] // 60000, (r.get("finished_at") or horizon) // 60000
    by_repo[r.get("repo_root") or r["folder"]].append((r["id"], start, max(end, start)))

iso = lambda m: datetime.fromtimestamp(m * 60, timezone.utc).isoformat()[:16]
print("runs started:", len(runs), "range", iso(min(r[1] for v in by_repo.values() for r in v)),
      "to", iso(max(r[2] for v in by_repo.values() for r in v)))
print("repo | runs | share with live sibling | overlapping pairs | pair-overlap h | wall-clock h with 2+ | max simultaneous @")
total = defaultdict(float)
for repo, group in sorted(by_repo.items(), key=lambda kv: -len(kv[1])):
    pairs = pair_minutes = 0
    sibling = set()
    for (ia, sa, ea), (ib, sb, eb) in combinations(group, 2):
        shared = min(ea, eb) - max(sa, sb) + 1
        if shared > 0:
            pairs += 1
            pair_minutes += shared
            sibling.update((ia, ib))
    events = sorted([(s, 1) for _, s, _ in group] + [(e + 1, -1) for _, _, e in group])
    live = peak = 0
    peak_at = None
    wall2 = 0
    previous = None
    for minute, delta in events:
        if previous is not None and live >= 2:
            wall2 += minute - previous
        live += delta
        previous = minute
        if live > peak:
            peak, peak_at = live, minute
    print(f"{repo} | {len(group)} | {len(sibling) / len(group):.3f} ({len(sibling)}) | {pairs} | "
          f"{pair_minutes / 60:.1f} | {wall2 / 60:.1f} | {peak} @ {iso(peak_at)}")
    if repo != "/workspace2":
        total["runs"] += len(group)
        total["sibling"] += len(sibling)
        total["pairs"] += pairs
        total["pair_h"] += pair_minutes / 60
        total["wall2_h"] += wall2 / 60
print("all repositories except the /workspace2 vault:",
      {k: round(v, 1) for k, v in total.items()}, "share", round(total["sibling"] / total["runs"], 3))
