"""Do larger run batches land worse? A measurement over git metadata.

It changes no ref and no file; `merge-tree` leaves unreferenced objects, which gc
collects, exactly as land.ts's own conflict check does.

Sources, all under the main checkout's .git plus ~/.claude/projects:
  - every non-run branch's reflog: each "merge uf/X" entry is a landing (time,
    target, ff or merge); "commit (merge): Merge branch 'uf/X'" is a landing
    finished by hand.
  - each surviving run branch's reflog: "branch: Created from <sha>" is its
    start time and base.
  - run transcripts: the first line carrying gitBranch is the run's start, for
    branches whose ref is gone.
  - every "Merge branch '<target>' into uf/X" commit: a back-merge, whose
    conflicts are recomputed with `git merge-tree --write-tree` so the count
    never depends on the message.

Usage: python3 scripts/batch-landing-conflicts.py [gap_minutes]   (default 45)
"""
import bisect
import collections
import datetime
import glob
import json
import os
import re
import subprocess
import sys

# The main checkout's .git, so the script reads every branch's reflog from a worktree too.
REPO = os.path.dirname(os.path.abspath(subprocess.run(["git", "rev-parse", "--git-common-dir"], capture_output=True, text=True, check=True).stdout.strip()))
LOGS = os.path.join(REPO, ".git/logs/refs/heads")
PROJECTS = os.path.expanduser("~/.claude/projects")
GAP = int(sys.argv[1]) * 60 if len(sys.argv) > 1 else 45 * 60
PREFIX = "uf/usagefoundry-"


def git(*args):
    return subprocess.run(["git", "-C", REPO, *args], capture_output=True, text=True).stdout.strip()


def merge_conflicts(ours, theirs):
    res = subprocess.run(["git", "-C", REPO, "merge-tree", "--write-tree", "--name-only", "--no-messages", ours, theirs],
                         capture_output=True, text=True)
    if res.returncode not in (0, 1):
        raise RuntimeError(f"merge-tree {ours} {theirs}: {res.stderr}")
    return res.stdout.strip().split("\n")[1:] if res.returncode == 1 else []


def reflog(path):
    for line in open(path, encoding="utf-8", errors="replace"):
        head, _, msg = line.rstrip("\n").partition("\t")
        parts = head.split(" ")
        yield parts[0], parts[1], int(parts[-2]), msg


def ts_iso(s):
    return int(datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())


runs = collections.defaultdict(lambda: {"landings": [], "backMerges": [], "transcriptStarts": []})
target_heads = {}  # target -> (times, shas)

# Landings, into whichever branch the operator's checkout was on.
for path in glob.glob(os.path.join(LOGS, "**"), recursive=True):
    name = os.path.relpath(path, LOGS)
    if not os.path.isfile(path) or name.startswith("uf/"):
        continue
    times, shas = [], []
    for old, new, ts, msg in reflog(path):
        times.append(ts)
        shas.append(new)
        m = re.match(r"merge (uf/[^:]+): (.*)", msg)
        if m:
            runs[m.group(1)]["landings"].append({"target": name, "ts": ts, "old": old, "new": new,
                                                 "kind": "ff" if "Fast-forward" in m.group(2) else "merge"})
        m = re.match(r"commit \(merge\): Merge branch '(uf/[^']+)'$", msg)
        if m:
            p = git("rev-list", "--parents", "-n1", new).split()[1:]
            runs[m.group(1)]["landings"].append({"target": name, "ts": ts, "old": old, "new": new, "kind": "by-hand",
                                                 "handConflicts": merge_conflicts(p[0], p[1])})
    target_heads[name] = (times, shas)


def head_at(target, ts):
    times, shas = target_heads[target]
    i = bisect.bisect_right(times, ts) - 1
    return shas[i] if i >= 0 else None


# Creation, from each surviving run branch's reflog.
for path in glob.glob(os.path.join(LOGS, "uf", "**"), recursive=True):
    if not os.path.isfile(path):
        continue
    old, new, ts, msg = next(reflog(path))
    if msg.startswith("branch: Created from"):
        r = runs[os.path.relpath(path, LOGS)]
        r["created"], r["reflogBase"] = ts, new

# Start time from transcripts.
for f in glob.glob(os.path.join(PROJECTS, "-workspace--uf-worktrees-*", "*.jsonl")):
    with open(f, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if (o.get("gitBranch") or "").startswith("uf/") and o.get("timestamp"):
                runs[o["gitBranch"]]["transcriptStarts"].append(ts_iso(o["timestamp"]))
                break

# Back-merges of any target into a run branch.
for rec in git("log", "--all", "--merges", "--format=%x1e%H%x1f%P%x1f%ct%x1f%s").split("\x1e")[1:]:
    sha, parents, ct, subject = rec.split("\x1f")
    m = re.match(r"Merge branch '([^']+)' into (uf/\S+)", subject.strip())
    if m:
        p = parents.split()
        runs[m.group(2)]["backMerges"].append({"source": m.group(1), "ts": int(ct), "sha": sha,
                                               "conflicts": merge_conflicts(p[0], p[1])})

uf = {k: v for k, v in runs.items() if k.startswith(PREFIX)}

# Base and start.
checks = collections.Counter()
for name, v in uf.items():
    starts = ([v["created"]] if "created" in v else []) + v["transcriptStarts"]
    v["start"] = min(starts) if starts else None
    land = v["landings"][0] if v["landings"] else None
    at_start = head_at(land["target"] if land else "main", v["start"]) if v["start"] else None
    walk = None
    if land:
        tip = land["new"] if land["kind"] == "ff" else git("rev-parse", land["new"] + "^2")
        own = git("rev-list", "--first-parent", tip, "^" + land["old"]).split()
        walk = git("rev-parse", own[-1] + "^1") if own else tip
    if "reflogBase" in v:
        if at_start:
            checks["head-at-start " + ("==" if at_start == v["reflogBase"] else "!=") + " reflog"] += 1
        if walk:
            checks["walk " + ("==" if walk == v["reflogBase"] else "!=") + " reflog"] += 1
        v["base"], v["baseSource"] = v["reflogBase"], "reflog"
    elif at_start:
        v["base"], v["baseSource"] = at_start, "head-at-start"
    elif walk:
        v["base"], v["baseSource"] = walk, "walk"


def landing_conflicts(v):
    """Files that conflicted on the way to the first landing; None if it never landed."""
    if not v["landings"]:
        return None
    land = v["landings"][0]
    files = [f for b in v["backMerges"] if b["ts"] <= land["ts"] and b["source"] == land["target"] for f in b["conflicts"]]
    return files + land.get("handConflicts", [])


def landings_between(v):
    """How many landings the target took between this run's start and its own landing."""
    land = v["landings"][0]
    times, shas = target_heads[land["target"]]
    return sum(1 for t in times if v["start"] < t < land["ts"])


# Batches: same base, split where consecutive starts are more than GAP apart.
groups = collections.defaultdict(list)
for name, v in uf.items():
    if "base" in v:
        groups[v["base"]].append(name)
batches = []
for base, names in groups.items():
    timed = sorted((n for n in names if uf[n]["start"]), key=lambda n: uf[n]["start"])
    untimed = [n for n in names if not uf[n]["start"]]
    if untimed:
        batches.append({"base": base, "names": untimed, "timed": False})
    cur = []
    for n in timed:
        if cur and uf[n]["start"] - uf[cur[-1]]["start"] > GAP:
            batches.append({"base": base, "names": cur, "timed": True})
            cur = []
        cur.append(n)
    if cur:
        batches.append({"base": base, "names": cur, "timed": True})

for b in batches:
    landed = sorted((n for n in b["names"] if uf[n]["landings"]), key=lambda n: uf[n]["landings"][0]["ts"])
    for pos, n in enumerate(landed, 1):
        uf[n]["landPos"] = pos
        uf[n]["batchSize"] = len(b["names"])
    b["landed"] = landed
    b["conflicted"] = [n for n in landed if landing_conflicts(uf[n])]


def report(title, bs):
    print(f"\n## {title}")
    print("size batches runs landed conflicted rate  conflicted-per-batch")
    by = collections.defaultdict(list)
    for b in bs:
        by[len(b["names"])].append(b)
    for size in sorted(by):
        x = by[size]
        landed = sum(len(b["landed"]) for b in x)
        c = sum(len(b["conflicted"]) for b in x)
        print(f"{size:4} {len(x):7} {size*len(x):4} {landed:6} {c:10} {c/landed if landed else 0:5.2f} {c/len(x):6.2f}")
    for lo, hi in ((1, 5), (6, 9), (10, 10), (11, 99)):
        x = [b for b in bs if lo <= len(b["names"]) <= hi]
        landed = sum(len(b["landed"]) for b in x)
        c = sum(len(b["conflicted"]) for b in x)
        print(f"  sizes {lo}-{hi}: {len(x)} batches, {landed} landed, {c} conflicted, rate {c/landed if landed else 0:.2f}")


timed = [b for b in batches if b["timed"]]
untimed = [b for b in batches if not b["timed"]]
print("gap minutes", GAP // 60)
print("base checks", dict(checks))
print("base sources", collections.Counter(v.get("baseSource", "none") for v in uf.values()))
print("runs", len(uf), "landed", sum(1 for v in uf.values() if v["landings"]),
      "landing targets", collections.Counter(v["landings"][0]["target"] for v in uf.values() if v["landings"]))
print("back-merges", sum(len(v["backMerges"]) for v in uf.values()),
      "of which conflicting", sum(1 for v in uf.values() for b in v["backMerges"] if b["conflicts"]))
starts = [v["start"] for v in uf.values() if v["start"]]
print("timed population", datetime.datetime.utcfromtimestamp(min(starts)).date(), "to", datetime.datetime.utcfromtimestamp(max(starts)).date())
report("Timed batches (start time known, split on gap)", timed)
report("Untimed batches (base only: an upper bound on batch size)", untimed)

print("\n## Timed population: conflict rate by landing position within the batch")
pos = collections.defaultdict(lambda: [0, 0])
for v in uf.values():
    if "landPos" in v and v["start"]:
        pos[v["landPos"]][0] += 1
        pos[v["landPos"]][1] += bool(landing_conflicts(v))
for k in sorted(pos):
    print(f"{k:3} {pos[k][0]:4} {pos[k][1]:4} {pos[k][1]/pos[k][0]:.2f}")

print("\n## Timed population: conflict rate by landings the target took while the run worked")
buckets = ((0, 0), (1, 1), (2, 3), (4, 6), (7, 10), (11, 15), (16, 999))
acc = collections.defaultdict(lambda: [0, 0])
for v in uf.values():
    if v["landings"] and v["start"]:
        n = landings_between(v)
        for lo, hi in buckets:
            if lo <= n <= hi:
                acc[(lo, hi)][0] += 1
                acc[(lo, hi)][1] += bool(landing_conflicts(v))
for k in buckets:
    if acc[k][0]:
        print(f"{k[0]:3}-{k[1]:<3} {acc[k][0]:4} {acc[k][1]:4} {acc[k][1]/acc[k][0]:.2f}")

print("\n## Timed population: conflicted files")
files = collections.Counter(f for v in uf.values() if v["start"] and v["landings"] for f in sorted(set(landing_conflicts(v))))
print("conflicted landings", sum(1 for v in uf.values() if v["start"] and landing_conflicts(v)))
for f, n in files.most_common(12):
    print(f"{n:4} {f}")
docs_only = sum(1 for v in uf.values() if v["start"] and landing_conflicts(v) and all(f.startswith("docs/") or f.endswith(".md") for f in landing_conflicts(v)))
print("conflicted landings touching only docs/*.md", docs_only)

print("\n## Timed batches of 7 or more")
for b in sorted(timed, key=lambda b: uf[b["names"][0]]["start"]):
    if len(b["names"]) >= 7:
        s = [uf[n]["start"] for n in b["names"]]
        print(datetime.datetime.utcfromtimestamp(min(s)).strftime("%m-%d %H:%M"), b["base"][:8], "size", len(b["names"]),
              "landed", len(b["landed"]), "conflicted", len(b["conflicted"]), "span", round((max(s) - min(s)) / 60), "min",
              "target", collections.Counter(uf[n]["landings"][0]["target"] for n in b["landed"]).most_common(1))

print("\n## Timed batches of exactly 10: conflicted files")
ten = [n for b in timed if len(b["names"]) == 10 for n in b["conflicted"]]
print("conflicted landings", len(ten), "of", sum(len(b["landed"]) for b in timed if len(b["names"]) == 10))
for f, n in collections.Counter(f for n in ten for f in sorted(set(landing_conflicts(uf[n])))).most_common(8):
    print(f"{n:4} {f}")
print("only docs/verification.md", sum(1 for n in ten if set(landing_conflicts(uf[n])) == {"docs/verification.md"}))
print("only docs/*.md", sum(1 for n in ten if all(f.startswith("docs/") and f.endswith(".md") for f in landing_conflicts(uf[n]))))
