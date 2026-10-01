#!/usr/bin/env python3
"""Find what runs *said* about sibling work, in their own assistant text.

Only assistant `text` blocks of run sessions (runs.json) are read: never the
prompt, tool inputs or tool results, which quote docs and briefs that use the
same words as vocabulary. Sessions whose cwd is the worktree this brief was
written in (usagefoundry-721638d11c0b-1) on 2026-10-01 are skipped, because
the brief itself contains the search terms.

Usage: python3 keyword_hunt.py runs.json > keyword-hits.txt  (counts on stderr)
"""
import json
import re
import sys
from collections import Counter, defaultdict

PATTERNS = {
    "another/other run(s) + did": r"\b(another|other|a parallel|a concurrent|a sibling|a different) (run|agent|session|worktree)s?\b[^.]{0,80}\b(landed|changed|fixed|committed|merged|added|removed|already|is working|was working|touched|edited|filed|beat)",
    "sibling": r"\bsibling (run|branch|worktree|agent)s?\b",
    "someone else": r"\bsomeone else\b|\bsomebody else\b",
    "already changed/fixed by": r"\balready (changed|fixed|done|landed|merged|implemented|addressed|filed) (by|on main|upstream|in main)\b",
    "main moved / landed while": r"\b(main|the base|the target) (has )?(moved|advanced)\b|\blanded (on main )?(while|since) (I|this run)\b|\bsince (I|this run) branched\b",
    "duplicate of": r"\bduplicat(e|es|ed) (of|an existing|the existing|what)\b",
}
COMPILED = {k: re.compile(v, re.I) for k, v in PATTERNS.items()}
EXCLUDED_CWD = "/workspace/.uf-worktrees/usagefoundry-721638d11c0b-1"

counts = defaultdict(Counter)
sessions_hit = defaultdict(set)
for run in json.load(open(sys.argv[1])):
    if run["kind"] == "dispatcher":
        continue
    for path in run["files"]:
        for raw in open(path, "rb"):
            obj = json.loads(raw)
            if obj.get("type") != "assistant":
                continue
            if obj.get("cwd") == EXCLUDED_CWD and str(obj.get("timestamp", "")).startswith("2026-10-01"):
                continue
            for block in (obj.get("message") or {}).get("content") or []:
                if not isinstance(block, dict) or block.get("type") != "text":
                    continue
                text = block.get("text") or ""
                for name, pattern in COMPILED.items():
                    for match in pattern.finditer(text):
                        counts[run["repo"]][name] += 1
                        sessions_hit[name].add(run["key"])
                        start, end = max(0, match.start() - 200), min(len(text), match.end() + 200)
                        snippet = text[start:end].replace("\n", " ")
                        print(f"[{name}] {run['repo']} {obj.get('timestamp', '')[:16]} {run['key'][-34:]}\n    {snippet}\n")
for repo, c in sorted(counts.items(), key=lambda kv: -sum(kv[1].values())):
    sys.stderr.write(f"{repo}: {dict(c)}\n")
sys.stderr.write("runs with a hit, per pattern: " + str({k: len(v) for k, v in sessions_hit.items()}) + "\n")
