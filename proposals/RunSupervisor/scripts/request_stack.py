#!/usr/bin/env python3
"""Kind 2: request_stack calls, and the demand a stack request would have met.

What it measures (exact counts):
  * tool_use blocks named mcp__uf__request_stack (defined at
    src/app/api/mcp/route.ts:914, dispatched at :2730, handled by requestStackForRun at :4989) in
    every non-Mac session, by session class;
  * user turns that are the waiting-for-stack resume notice
    (stackResumeNotice, src/lib/stackRequests.ts:335): "The stack you asked for
    is installed" / "The operator declined the stack you asked for" / "The
    stack request this run was waiting on is no longer on record";
  * as the nearest observable stand-in for demand: Bash results in which the
    shell itself reports `<name>: command not found` for a command the run
    typed (the shell's own wording, so a doc that quotes it does not match),
    counted per run and binary.
The tool was added in e6acc317 on 2026-10-01, the first day of the run corpus,
so every run could have called it. `waiting-for-stack` itself is a DB status and
is not observable here.

Run: python3 request_stack.py
"""
import re
from collections import Counter, defaultdict

import corpus

SHELL_MISSING = re.compile(r"(?:bash|sh)(?:: line \d+)?: (?:\d+: )?([\w.+-]+): (?:command )?not found")
NOTICES = ("The stack you asked for is installed", "The operator declined the stack you asked for",
           "The stack request this run was waiting on")


def main():
    records = corpus.load()
    calls = Counter()
    notices = Counter()
    for record in records:
        for assistant in record["assistants"]:
            for tool in assistant["tools"]:
                if tool["name"].endswith("request_stack"):
                    calls[record["class"]] += 1
        for user in record["users"]:
            if user["text"].startswith(NOTICES):
                notices[record["class"]] += 1
    print(f"request_stack tool_use blocks, all {len(records)} non-Mac sessions: {sum(calls.values())} {dict(calls)}")
    print(f"stack resume notices in user turns: {sum(notices.values())} {dict(notices)}")
    grouped = corpus.runs(records)
    prompted = sum(1 for ss in grouped.values() if "call request_stack" in (ss[0]["first_prompt"] or "")
                   or "request_stack" in (ss[0]["first_prompt"] or ""))
    print(f"runs whose first prompt names request_stack: {prompted} of {len(grouped)}")
    names, runs_by = Counter(), defaultdict(set)
    for key, sessions in grouped.items():
        for session in sessions:
            for error in session["errors"]:
                if error["pattern"] != "command-not-found" or error["tool"] != "Bash":
                    continue
                match = SHELL_MISSING.search(error["excerpt"])
                if match:
                    names[match.group(1)] += 1
                    runs_by[match.group(1)].add(key)
    print("shell 'command not found' for a typed command (Bash results), by binary: hits / runs")
    for name, hits in names.most_common():
        print(f"  {name:<10} {hits:>3} / {len(runs_by[name])}")
    any_runs = set().union(*runs_by.values()) if runs_by else set()
    without_tsc = set().union(*(v for k, v in runs_by.items() if k != "tsc")) if runs_by else set()
    print(f"runs with any such hit: {len(any_runs)}; excluding `tsc` (the NODE_ENV trap, kind 5): {len(without_tsc)}")


if __name__ == "__main__":
    main()
