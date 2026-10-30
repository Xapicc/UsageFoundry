#!/usr/bin/env python3
"""Hand-label files for the RunSupervisor measurements.

What it does: nothing on its own. `load(kind)` reads labels/<kind>.tsv, one
line per classified instance:  id <TAB> class <TAB> reason <TAB> evidence
where class is one of CLASSES. The scripts that find the instances call
`tally()` to join their candidates to these labels and print the counts, and
they refuse to report a sample whose members are not all labelled, so a label
file can not drift from the candidates it describes.

The classification rules are in rules.txt; measure-all.sh prints them first.
"""
import os
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
CLASSES = ("MODEL-ANSWERABLE", "OPERATOR-ONLY", "NOT A QUESTION", "FALSE POSITIVE")


def load(kind):
    path = os.path.join(HERE, "labels", kind + ".tsv")
    out = {}
    if not os.path.exists(path):
        return out
    with open(path) as handle:
        for number, line in enumerate(handle, 1):
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 3 or parts[1] not in CLASSES:
                raise ValueError(f"{path}:{number}: need id<TAB>class<TAB>reason[<TAB>evidence], got {line[:80]!r}")
            out[parts[0]] = {"class": parts[1], "reason": parts[2], "evidence": parts[3] if len(parts) > 3 else ""}
    return out


def tally(kind, ids, title):
    """Print the class counts for `ids` and return them; fail on an unlabelled id."""
    labels = load(kind)
    missing = [i for i in ids if i not in labels]
    if missing:
        raise SystemExit(f"{title}: {len(missing)} of {len(ids)} instances have no label in labels/{kind}.tsv: {missing[:5]}")
    counts = Counter(labels[i]["class"] for i in ids)
    print(f"{title}: n={len(ids)}  " + "  ".join(f"{c}={counts.get(c, 0)}" for c in CLASSES))
    return counts
