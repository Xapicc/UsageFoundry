#!/usr/bin/env python3
"""Find, in the source tree, the exact text each measurement's greps rest on.

What it does: for each marker below, searches the named file for the regex and
prints `path:line  matched text`, exiting non-zero if any marker is missing, so
a refactor that moves or renames one is noticed before the figures are trusted.
The repository root is two directories above proposals/RunSupervisor/.

Run: python3 markers.py
"""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
MARKERS = [
    ("NEEDS_REVIEW prompt notice (rides on every prompt but an operator note)", "src/lib/cycleInvocation.ts", r"^export const NEEDS_REVIEW_NOTICE ="),
    ("reason cap", "src/lib/cycleInvocation.ts", r"^export const MAX_NEEDS_REVIEW_REASON = "),
    ("reason clip", "src/lib/cycleInvocation.ts", r"^export function clipReason"),
    ("ending test: NEEDS_REVIEW alone on a line", "src/lib/cycleInvocation.ts", r"\^\\s\*NEEDS_REVIEW\\s\*\$/m"),
    ("ending test: DONE alone on a line", "src/lib/cycleInvocation.ts", r"\^\\s\*DONE\\s\*\$/m"),
    ("orchestrator detects the ending in finalText", "src/lib/orchestrator.ts", r"const ending = cycleEnding\(res\.finalText\)"),
    ("orchestrator stores the reason (the whole final text, clipped)", "src/lib/orchestrator.ts", r"needsReviewReason = clipReason\(res\.finalText\)"),
    ("operator note returned unwrapped (reopenPrompt)", "src/lib/orchestrator.ts", r"if \(o\.note\) return o\.note;"),
    ("operator note returned unwrapped (nextPrompt, with a session)", "src/lib/cycleInvocation.ts", r"if \(o\.followUp\) return o\.followUp;"),
    ("pick-up of a needs-review run, no note", "src/lib/orchestrator.ts", r"^const NEEDS_REVIEW_PICKUP_NOTICE ="),
    ("restart-killed notice", "src/lib/orchestrator.ts", r"^const RESTART_KILLED_NOTICE ="),
    ("continuation prompt", "src/lib/settings.ts", r"^export const DEFAULT_CONTINUATION_PROMPT ="),
    ("done pushback", "src/lib/settings.ts", r"^export const DEFAULT_DONE_PUSHBACK_PROMPT ="),
    ("stopped-tasks notice", "src/lib/backgroundWork.ts", r"^export function stoppedTasksNotice"),
    ("stack resume notice", "src/lib/stackRequests.ts", r"^export function stackResumeNotice"),
    ("request_stack tool definition", "src/app/api/mcp/route.ts", r'name: "request_stack"'),
    ("request_stack handler", "src/app/api/mcp/route.ts", r"^async function requestStackForRun"),
    ("list_recurring_failures tool definition (SHARED_TOOLS)", "src/app/api/mcp/route.ts", r'name: "list_recurring_failures"'),
    ("list_recurring_failures handler", "src/app/api/mcp/route.ts", r"^async function recurringFailuresTool"),
    ("a work cycle gets RUN_TOOLS and not SHARED_TOOLS", "src/app/api/mcp/route.ts", r"A work cycle gets `RUN_TOOLS` and \*\*not\*\* `SHARED_TOOLS`"),
    ("chat/block tool lists include SHARED_TOOLS", "src/app/api/mcp/route.ts", r"\? \[\.\.\.SHARED_TOOLS, \.\.\.CHAT_TOOLS\]"),
    ("ask_operator tool definition", "src/app/api/mcp/route.ts", r'name: "ask_operator"'),
    ("release_task is how a run hands a task back", "src/app/api/mcp/route.ts", r"`release_task` is the sixth"),
]


def main():
    missing = 0
    for label, relative, pattern in MARKERS:
        path = os.path.join(ROOT, relative)
        regex = re.compile(pattern)
        found = None
        with open(path, errors="replace") as handle:
            for number, line in enumerate(handle, 1):
                if regex.search(line):
                    found = (number, line.strip())
                    break
        if found is None:
            missing += 1
            print(f"MISSING  {relative}  /{pattern}/   ({label})")
        else:
            print(f"{relative}:{found[0]}  {found[1][:110]}   <- {label}")
    sys.exit(1 if missing else 0)


if __name__ == "__main__":
    main()
