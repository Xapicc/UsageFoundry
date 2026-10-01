#!/usr/bin/env python3
"""Same-repository run concurrency, from the session index index_sessions.py writes.

Run key:
  isolated run      the uf/<slug>-<N>-<hash> branch its sessions sat on
                    (prompt opens "You are working in a dedicated git worktree")
  non-isolated run  one session file in /workspace/<Repo>, minus the
                    "Start runs for Tasks on the Taskboard" dispatchers and
                    one-line probes
Validator, reviewer, resolver, chat, vault and Mac sessions are not runs.

"Live" = minutes in which any of the run's sessions wrote a line. Reported
three ways: raw minutes, minutes with gaps under GAP minutes filled, and the
naive first-to-last span.

Usage: python3 concurrency.py sessions.jsonl [GAP] > runs.json (summary on stderr)
"""
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from itertools import combinations

INDEX = sys.argv[1]
GAP = int(sys.argv[2]) if len(sys.argv) > 2 else 10

ISOLATED = "You are working in a dedicated git worktree"
DISPATCHER = "Start runs for Tasks on the Taskboard"
PROBES = ("Read package.json in this directory", "Reply with the single word OK")
BRANCH = re.compile(r"^uf/(.+)-([0-9a-f]{12})-(\d+)-([0-9a-f]{8})$")


def repo_of_slug(slug):
    return slug.lower()


def fill(minutes, gap):
    out = set()
    ordered = sorted(minutes)
    for a, b in zip(ordered, ordered[1:]):
        out.add(a)
        if b - a < gap:
            out.update(range(a, b))
    if ordered:
        out.add(ordered[-1])
    return out


def build_runs(records):
    runs = {}
    for r in records:
        prompt = r["first_prompt"] or ""
        if prompt.startswith(ISOLATED):
            branches = {b: n for b, n in r["branches"].items() if b.startswith("uf/")}
            key = max(branches, key=branches.get)
            match = BRANCH.match(key)
            if not match:
                raise ValueError(f"unexpected branch shape {key!r} in {r['file']}")
            repo, kind = repo_of_slug(match.group(1)), "isolated"
        elif r["dir"].startswith("-workspace-") and not r["dir"].startswith("-workspace--"):
            if prompt.startswith(DISPATCHER):
                kind = "dispatcher"
            elif prompt.startswith(PROBES):
                continue
            else:
                kind = "non-isolated"
            key, repo = r["file"], repo_of_slug(r["dir"][len("-workspace-"):])
        else:
            continue
        run = runs.setdefault(key, {"key": key, "repo": repo, "kind": kind, "minutes": set(), "files": []})
        run["minutes"].update(r["minutes"])
        run["files"].append(r["file"])
    for run in runs.values():
        run["first"], run["last"] = min(run["minutes"]), max(run["minutes"])
        run["filled"] = fill(run["minutes"], GAP)
        run["span"] = set(range(run["first"], run["last"] + 1))
    return runs


def stats(group, measure):
    by_minute = defaultdict(int)
    for run in group:
        for m in run[measure]:
            by_minute[m] += 1
    pairs = pair_minutes = 0
    with_sibling = set()
    for a, b in combinations(group, 2):
        shared = len(a[measure] & b[measure])
        if shared:
            pairs += 1
            pair_minutes += shared
            with_sibling.update((a["key"], b["key"]))
    peak = max(by_minute.values()) if by_minute else 0
    peak_at = min((m for m, n in by_minute.items() if n == peak), default=None)
    return {
        "runs": len(group),
        "with_live_sibling": len(with_sibling),
        "share": round(len(with_sibling) / len(group), 3) if group else 0,
        "overlapping_pairs": pairs,
        "pair_overlap_hours": round(pair_minutes / 60, 1),
        "wallclock_hours_2plus": round(sum(1 for n in by_minute.values() if n >= 2) / 60, 1),
        "live_hours": round(sum(len(r[measure]) for r in group) / 60, 1),
        "max_simultaneous": peak,
        "peak_at": datetime.fromtimestamp(peak_at * 60, timezone.utc).isoformat()[:16] if peak_at else None,
    }


def main():
    records = [json.loads(line) for line in open(INDEX)]
    runs = build_runs(records)
    code = [r for r in runs.values() if r["kind"] != "dispatcher"]
    by_repo = defaultdict(list)
    for run in code:
        by_repo[run["repo"]].append(run)
    summary = {"gap_minutes": GAP, "repos": {}, "all": {}}
    for measure in ("minutes", "filled", "span"):
        totals = {"runs": 0, "with_live_sibling": 0, "overlapping_pairs": 0, "pair_overlap_hours": 0.0,
                  "wallclock_hours_2plus": 0.0, "live_hours": 0.0}
        for repo, group in sorted(by_repo.items(), key=lambda kv: -len(kv[1])):
            s = stats(group, measure)
            summary["repos"].setdefault(repo, {})[measure] = s
            for k in totals:
                totals[k] += s[k]
        totals["share"] = round(totals["with_live_sibling"] / totals["runs"], 3)
        summary["all"][measure] = {k: round(v, 1) if isinstance(v, float) else v for k, v in totals.items()}
    kinds = defaultdict(int)
    for run in runs.values():
        kinds[run["kind"]] += 1
    summary["kinds"] = dict(kinds)
    first = min(r["first"] for r in runs.values())
    last = max(r["last"] for r in runs.values())
    summary["range"] = [datetime.fromtimestamp(t * 60, timezone.utc).isoformat()[:16] for t in (first, last)]
    json.dump(summary, sys.stderr, indent=1)
    sys.stderr.write("\n")
    out = [
        {k: (sorted(v) if isinstance(v, set) else v) for k, v in run.items() if k not in ("span",)}
        for run in runs.values()
    ]
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
