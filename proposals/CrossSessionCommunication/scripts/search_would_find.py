#!/usr/bin/env python3
"""Pre-build check for Option G2: would a one-word title search have found the
earlier task?

Reads dup_tasks.py's output. For every pair of near-duplicate create_task
titles filed by two runs that were live at the same time, it takes the later
title's distinctive tokens (identifier-like, 6+ characters, not a stop word)
and asks whether any one of them, as a case-folded substring, matches the
earlier title. That is the most a `query` on `list_my_tasks` could have done if
the later run searched on a word from what it was about to file. Whether a run
would search that way is not measured here; that is 13-validation.md §2.

Usage: python3 search_would_find.py dup-tasks.txt
"""
import re
import sys

STOP = {"fails", "failing", "should", "because", "missing", "doesnt", "cannot", "without", "between"}
TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9_.\-/]{5,}")

text = open(sys.argv[1]).read()
blocks = [b for b in text.split("\n\n") if "CONCURRENT" in b]
found = 0
rows = []
for b in blocks:
    lines = [l for l in b.splitlines() if l.startswith("  20")]
    if len(lines) < 2:
        continue
    (t1, title1), (t2, title2) = sorted(
        (l.split()[0], l.split(": ", 1)[1]) for l in lines[:2]
    )
    tokens = [t for t in TOKEN.findall(title2) if t.lower() not in STOP]
    hit = next((t for t in tokens if t.lower() in title1.lower()), None)
    found += hit is not None
    rows.append((t2[:16], hit or "-", title2[:90]))
for r in rows:
    print(*r, sep="  ")
print(f"concurrent pairs: {len(rows)}; a single token of the later title matches the earlier: {found}")
