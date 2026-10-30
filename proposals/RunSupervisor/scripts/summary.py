#!/usr/bin/env python3
"""One table of the hand classifications, read from labels/*.tsv.

What it prints: for each kind of traffic, how many labelled instances fall in each
class (rules.txt), and what the labelled set is (all instances, or a seeded
sample of N out of M keyword matches). The kind-5 rows are computed by
known_errors.py from turn counts, not hand labels, and are printed by it.
Counts of labelled instances are exact; they are NOT population estimates when
the labelled set is a sample.

Run: python3 summary.py
"""
from collections import Counter

import labels

ROWS = [
    ("1  NEEDS_REVIEW endings", "needs_review", "all 7 endings"),
    ("1b release_task calls", "release_task", "all 13 calls"),
    ("4  final reports with a keyword match", "final_reports", "seeded sample of 25 of 84 matching runs"),
    ("6  'already done' / 'brief wrong' reports", "already_done", "all 34 report-level keyword matches"),
    ("7  stopped before a destructive step", "destructive_stops", "all 8 specific-pattern runs + sample of 25 of 60 'declined' runs"),
    ("8  chat ask_operator calls", "ask_operator", "all 3 calls"),
]


def main():
    header = f"{'kind':<46}{'n':>4}  " + "  ".join(f"{c[:14]:>14}" for c in labels.CLASSES)
    print(header)
    for title, kind, note in ROWS:
        counts = Counter(v["class"] for v in labels.load(kind).values())
        print(f"{title:<46}{sum(counts.values()):>4}  " + "  ".join(f"{counts.get(c, 0):>14}" for c in labels.CLASSES) + f"   [{note}]")
    print("2  request_stack calls: 0 (nothing to classify)    3  operator pick-up notes: 0 (nothing to classify)")
    print("5  known errors: see known_errors.py's classification block (mechanical, from turn counts)")


if __name__ == "__main__":
    main()
