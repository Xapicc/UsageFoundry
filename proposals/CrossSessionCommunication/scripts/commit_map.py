#!/usr/bin/env python3
"""Map commit subjects to the uf/ branch whose run wrote them.

Reads every `git commit` Bash call in the indexed run sessions and takes the
subject from its heredoc (`-F - <<'EOF'`) or first `-m`. Used to attribute a
commit that reached a target's first-parent line by fast-forward, where no
"Merge branch 'uf/...'" names the run.

Usage: python3 commit_map.py sessions.jsonl > commit-map.json
"""
import json
import re
import sys
from collections import defaultdict

HEREDOC = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?\n(.*?)\n")
DASH_M = re.compile(r"-m\s+([\"'])(.*?)\1", re.S)

subjects = defaultdict(set)
for line in open(sys.argv[1]):
    record = json.loads(line)
    if not (record["first_prompt"] or "").startswith("You are working in a dedicated git worktree"):
        continue
    for raw in open(record["file"], "rb"):
        obj = json.loads(raw)
        if obj.get("type") != "assistant":
            continue
        branch = obj.get("gitBranch") or ""
        for block in (obj.get("message") or {}).get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "tool_use" or block.get("name") != "Bash":
                continue
            command = (block.get("input") or {}).get("command") or ""
            if "git commit" not in command:
                continue
            tail = command.split("git commit", 1)[1]
            found = HEREDOC.search(tail) or DASH_M.search(tail)
            if found and branch.startswith("uf/"):
                subject = found.group(2).splitlines()[0].strip() if found.group(2) else ""
                if subject:
                    subjects[subject].add(branch)
json.dump({s: sorted(b) for s, b in subjects.items()}, sys.stdout)
sys.stderr.write(f"{len(subjects)} subjects, {sum(len(b) > 1 for b in subjects.values())} on more than one branch\n")
