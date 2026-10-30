#!/usr/bin/env python3
"""Kind 3: the operator's pick-up notes (runs.follow_up) in run transcripts.

How a note reaches the model (src/lib/orchestrator.ts:15998-16078 reopenRun,
src/lib/cycleInvocation.ts:264-403 nextPrompt (`if (o.followUp) return o.followUp` at :391), reopenPrompt at
orchestrator.ts:15498 (`if (o.note) return o.note` at :15512)): the operator's text is trimmed and returned UNWRAPPED
as the next cycle's whole prompt (`if (o.note) return o.note`; with a session,
`nextPrompt` returns `o.followUp` verbatim). With no session to resume it is
appended after the task text in a fresh session's opening prompt. So a note is
a user turn that is none of the texts the app itself generates. The app's own
texts that travel the same `follow_up` door, and so are NOT operator notes:
  DEFAULT_CONTINUATION_PROMPT      settings.ts:1011  "Continue working on the task."
  stopped-tasks notice             backgroundWork.ts:174
  NEEDS_REVIEW_PICKUP_NOTICE       orchestrator.ts:15588  "You ended your last work cycle by reporting"
  RESTART_KILLED_NOTICE            orchestrator.ts:15616 "Your last work cycle did not finish."
  DEFAULT_DONE_PUSHBACK_PROMPT     settings.ts:1029  "You reported the task complete"
  stackResumeNotice                stackRequests.ts:335
  validator pushback               "You asked to close the task"
What it measures (exact): every non-first, non-injected user turn of every run
session, bucketed by which of those texts it opens with; whatever is left over
is printed in full as an operator-note candidate. Self-scheduled wake-ups
(isMeta, promptSource=system) and <task-notification> turns are injected by the
CLI and are skipped by corpus.py. A later session of the same branch is
reported with how its opening prompt differs from the first session's.

Not measurable: reopens the DB records in runs.reopened_at, and whether the
operator used the web UI to answer a run in some way that sends no prompt. If
the operator picked up runs, the transcripts show it as an extra user turn.

Run: python3 follow_ups.py
"""
import difflib
from collections import Counter

import corpus

APP_TEXTS = [
    ("continuation prompt", "Continue working on the task."),
    ("stopped-tasks notice", "Background tasks from the previous work cycle were stopped"),
    ("needs-review pick-up notice", "You ended your last work cycle by reporting"),
    ("restart-killed notice", "Your last work cycle did not finish."),
    ("done pushback", "You reported the task complete"),
    ("stack resume notice", "The stack you asked for is installed"),
    ("stack resume notice", "The operator declined the stack you asked for"),
    ("stack resume notice", "The stack request this run was waiting on"),
    ("validator pushback", "You asked to close the task"),
]


def bucket(text):
    stripped = text.lstrip()
    for name, prefix in APP_TEXTS:
        if stripped.startswith(prefix):
            return name
    return None


def main():
    records = corpus.load()
    grouped = corpus.runs(records)
    counts = Counter()
    candidates = []
    later_sessions = []
    runs_with = Counter()
    for key, sessions in grouped.items():
        seen_kinds = set()
        for index, session in enumerate(sessions):
            first_turn = True
            for user in session["users"]:
                if not corpus.is_prompt_turn(user):
                    continue
                if first_turn:
                    first_turn = False
                    if index > 0:
                        later_sessions.append((key, sessions[0], session, user))
                    continue
                name = bucket(user["text"])
                if name:
                    counts[name] += 1
                    seen_kinds.add(name)
                else:
                    counts["OPERATOR-NOTE CANDIDATE"] += 1
                    candidates.append((key, session, user))
        for name in seen_kinds:
            runs_with[name] += 1
    total_turns = sum(counts.values())
    print(f"runs: {len(grouped)}; non-first prompt turns in run sessions: {total_turns}")
    for name, n in counts.most_common():
        print(f"  {name:<30} {n:>4} turns  in {runs_with.get(name, 0)} runs")
    print(f"operator pick-up note candidates: {len(candidates)}")
    for key, session, user in candidates:
        print("  ", session["file"], user["ts"], user["text"][:300].replace("\n", " "))
    print(f"later sessions of an already-seen branch: {len(later_sessions)} (opening prompt vs the branch's first session)")
    for key, first, later, user in later_sessions:
        ratio = difflib.SequenceMatcher(None, first["first_prompt"][1200:4200], later["first_prompt"][1200:4200]).quick_ratio()
        print(f"   {key[-30:]}  similarity of the 3000 chars after the preamble: {ratio:.2f}")
        head = later["first_prompt"]
        marker = head.find("## ")
        print("     first session task heading:", first["first_prompt"][first["first_prompt"].find("## "):][:90].replace("\n", " "))
        print("     later session task heading:", head[marker:][:90].replace("\n", " "))
    other = [r for r in records if r["class"] in ("other-unisolated",)]
    print(f"hand-typed sessions in -workspace-<Repo> directories not classed as runs/dispatchers: {len(other)}")


if __name__ == "__main__":
    main()
