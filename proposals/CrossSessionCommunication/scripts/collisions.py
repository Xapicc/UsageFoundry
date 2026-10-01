#!/usr/bin/env python3
"""Which sibling's landed change each conflicted merge collided with, and
whether the two runs were live at the same time.

Inputs: sessions.jsonl (index_sessions.py), runs.json (concurrency.py),
prune-audit-dump.json (runs table, 2026-08-10..08-28, naive spans only).

A conflicted merge is a commit "Merge branch '<target>' into uf/<R>" whose
message keeps git's "# Conflicts:" block: land.ts resolves in an isolated
checkout with `git merge --no-edit <target>` then `git commit --no-edit`,
which keeps that block. The colliding siblings are the landings on <target>'s
first-parent line between merge-base(R, target) and the target tip that
touched a conflicted file: "Merge branch 'uf/<Y>'" or "Squashed from uf/<Y>".

Usage: python3 collisions.py sessions.jsonl runs.json dump.json commit-map.json > collisions.json
"""
import json
import re
import subprocess
import sys
from collections import Counter, defaultdict

SESSIONS, RUNS, DUMP, COMMITS = sys.argv[1:5]
REPOS = {
    "usagefoundry": "/workspace/UsageFoundry",
    "dockrac": "/workspace/Dockrac",
    "foundrycode": "/workspace/FoundryCode",
    "investmentmanager": "/workspace/InvestmentManager",
    "visualedit": "/workspace/VisualEdit",
    "visualmerge": "/workspace/VisualMerge",
}
SLUG = re.compile(r"^uf/(.+)-[0-9a-f]{12}-\d+-[0-9a-f]{8}$")
LANDED = re.compile(r"^Merge branch '(uf/[^']+)'")
SQUASHED = re.compile(r"Squashed from (uf/\S+?)[ .(]")
INTO = re.compile(r"^Merge branch '([^']+)' into (uf/\S+)$")


def git(repo, *args):
    done = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)
    if done.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} in {repo} failed: {done.stderr.strip()}")
    return done.stdout


def resolver_sessions(records):
    out = []
    for r in records:
        if not (r["first_prompt"] or "").startswith("You are resolving a git merge conflict"):
            continue
        prompt, cost = None, 0.0
        for line in open(r["file"], "rb"):
            obj = json.loads(line)
            if prompt is None and obj.get("type") == "queue-operation" and isinstance(obj.get("content"), str):
                prompt = obj["content"]
            if obj.get("type") == "cost-state":
                cost = max(cost, obj.get("totalCostUSD") or 0)
        head = re.search(r"`([^`]+)` has just been\s+merged into `([^`]+)`", prompt)
        files = re.search(r"these files:\n\n(.*?)\n\n", prompt, re.S)
        out.append({
            "ts": r["first_ts"], "target": head.group(1), "branch": head.group(2),
            "files": [f.strip() for f in files.group(1).splitlines()], "cost": cost,
        })
    return out


def conflicted_merges(repo):
    log = git(repo, "log", "--all", "--merges", "--format=%x1e%H%x1f%ct%x1f%P%x1f%B")
    out = []
    for entry in log.split("\x1e")[1:]:
        sha, ct, parents, body = entry.split("\x1f", 3)
        subject = body.splitlines()[0]
        into = INTO.match(subject)
        if not into or "# Conflicts:" not in body:
            continue
        files = [l.strip("#\t ") for l in body.split("# Conflicts:", 1)[1].splitlines() if l.startswith("#\t")]
        p1, p2 = parents.split()[:2]
        out.append({"sha": sha, "ct": int(ct), "target": into.group(1), "branch": into.group(2),
                    "p1": p1, "p2": p2, "files": files})
    return out


def colliders(repo, merge, by_subject):
    base = git(repo, "merge-base", merge["p1"], merge["p2"]).strip()
    log = git(repo, "log", "--first-parent", "--diff-merges=first-parent", "--name-only",
              "--format=%x1e%H%x1f%B%x1f", f"{base}..{merge['p2']}", "--", *merge["files"])
    found = []
    for entry in log.split("\x1e")[1:]:
        sha, body, _names = entry.split("\x1f", 2)
        subject = body.splitlines()[0]
        landed = LANDED.match(body) or SQUASHED.search(body) or INTO.match(subject)
        if landed:
            found.append(landed.group(landed.re.groups))
        elif len(by_subject.get(subject, [])) == 1:
            # Reached the target by fast-forward: the run that typed this subject.
            found.append(by_subject[subject][0])
        else:
            found.append("direct:" + subject[:60])
    return [f for f in found if f != merge["branch"]]


def main():
    records = [json.loads(line) for line in open(SESSIONS)]
    live = {r["key"]: set(r["filled"]) for r in json.load(open(RUNS)) if r["kind"] == "isolated"}
    dump_span = {}
    for r in json.load(open(DUMP))["runs"]:
        if r.get("worktree_branch") and r.get("started_at"):
            end = r.get("finished_at") or r["started_at"]
            span = dump_span.setdefault(r["worktree_branch"], [r["started_at"] // 60000, end // 60000])
            span[0], span[1] = min(span[0], r["started_at"] // 60000), max(span[1], end // 60000)
    resolutions = resolver_sessions(records)
    by_subject = json.load(open(COMMITS))
    rows = []
    for name, repo in REPOS.items():
        for merge in conflicted_merges(repo):
            sessions = [s for s in resolutions if s["branch"] == merge["branch"] and s["target"] == merge["target"]
                        and 0 <= merge["ct"] - s["ts"] < 3 * 3600]
            row = {"repo": name, "sha": merge["sha"][:10], "ct": merge["ct"], "target": merge["target"],
                   "branch": merge["branch"], "files": merge["files"], "resolver_session": bool(sessions),
                   "resolver_cost": round(sum(s["cost"] for s in sessions[:1]), 2), "siblings": []}
            for sibling in dict.fromkeys(colliders(repo, merge, by_subject)):
                verdict = "unattributable" if sibling.startswith("direct:") else "unknown"
                if sibling in live and merge["branch"] in live:
                    verdict = "live-overlap" if live[sibling] & live[merge["branch"]] else "no-live-overlap"
                elif sibling in dump_span and merge["branch"] in dump_span:
                    a, b = dump_span[sibling], dump_span[merge["branch"]]
                    verdict = "span-overlap" if min(a[1], b[1]) >= max(a[0], b[0]) else "no-span-overlap"
                row["siblings"].append([sibling, verdict])
            rows.append(row)
    json.dump({"resolver_sessions": resolutions, "merges": rows}, sys.stdout)
    report(resolutions, rows)


def report(resolutions, rows):
    err = sys.stderr
    err.write(f"resolver sessions in transcripts: {len(resolutions)}, cost ${sum(s['cost'] for s in resolutions):.2f}\n")
    err.write(f"conflicted merges in git: {len(rows)}; with a matching resolver session: "
              f"{sum(r['resolver_session'] for r in rows)}\n")
    by_repo = Counter(r["repo"] for r in rows)
    err.write(f"per repo: {dict(by_repo)}\n")
    verdicts = Counter()
    merge_verdict = Counter()
    for r in rows:
        kinds = {v for _, v in r["siblings"]}
        for _, v in r["siblings"]:
            verdicts[v] += 1
        if "live-overlap" in kinds or "span-overlap" in kinds:
            merge_verdict["collided with >=1 concurrently live sibling"] += 1
        elif kinds & {"no-live-overlap", "no-span-overlap"}:
            merge_verdict["only with siblings not live at the same time"] += 1
        elif not r["siblings"]:
            merge_verdict["no landing on the target touched the files"] += 1
        else:
            merge_verdict["siblings unmeasurable (outside both windows or direct commits)"] += 1
    err.write(f"sibling verdicts: {dict(verdicts)}\nper merge: {dict(merge_verdict)}\n")
    files = Counter(f for r in rows for f in r["files"])
    err.write(f"most conflicted files: {files.most_common(8)}\n")


if __name__ == "__main__":
    main()
