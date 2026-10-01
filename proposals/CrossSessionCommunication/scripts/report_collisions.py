#!/usr/bin/env python3
"""Break collisions.json down by the window each merge falls in.

transcripts window: merge committed on/after 2026-08-31 (live = filled minutes)
dump window:        merge committed before 2026-08-29 (live = naive started..finished span)

Usage: python3 report_collisions.py collisions.json
"""
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

data = json.load(open(sys.argv[1]))
CUT_DUMP = datetime(2026, 8, 29, tzinfo=timezone.utc).timestamp()
CUT_TRANSCRIPTS = datetime(2026, 8, 31, tzinfo=timezone.utc).timestamp()


def window(ct):
    if ct >= CUT_TRANSCRIPTS:
        return "transcripts (2026-08-31..10-01)"
    if ct < CUT_DUMP:
        return "dump (..2026-08-28)"
    return "gap (08-29..08-30)"


groups = defaultdict(list)
for merge in data["merges"]:
    groups[window(merge["ct"])].append(merge)

for name, merges in sorted(groups.items()):
    dates = sorted(datetime.fromtimestamp(m["ct"], timezone.utc).date().isoformat() for m in merges)
    print(f"== {name}: {len(merges)} conflicted merges, {dates[0]}..{dates[-1]}, "
          f"resolver session matched: {sum(m['resolver_session'] for m in merges)}")
    print("   per repo:", dict(Counter(m["repo"] for m in merges)))
    outcome = Counter()
    for m in merges:
        kinds = [v for _, v in m["siblings"]]
        if any(k in ("live-overlap", "span-overlap") for k in kinds):
            outcome["with >=1 sibling live at the same time"] += 1
        elif any(k in ("no-live-overlap", "no-span-overlap") for k in kinds):
            outcome["every measurable sibling was NOT live at the same time"] += 1
        elif not kinds:
            outcome["no sibling landing touched the files (operator/other)"] += 1
        else:
            outcome["no measurable sibling (attribution failed or run outside window)"] += 1
    for k, v in outcome.most_common():
        print(f"   {v:4d}  {k}")
    print("   sibling verdicts:", dict(Counter(v for m in merges for _, v in m["siblings"])))
    print("   top files:", Counter(f for m in merges for f in m["files"]).most_common(5))
