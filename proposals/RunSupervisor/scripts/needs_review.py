#!/usr/bin/env python3
"""Kind 1: NEEDS_REVIEW endings, plus the two other ways a run hands a task back.

What it measures (exact counts, from run transcripts only):
  * cycles whose last assistant message has NEEDS_REVIEW alone on a line (the
    test src/lib/cycleInvocation.ts:691 `cycleEnding` applies to `finalText`),
    and the runs they belong to; the denominator is every prompt cycle of every
    run. The reason the app stores is that same text, clipped to
    MAX_NEEDS_REVIEW_REASON = 2000 characters (cycleInvocation.ts:211).
  * release_task calls (a run giving a board task back to the operator) and
    create_task calls carrying operatorOnly, which are the board's own
    equivalent of "I need a person for this".
  The hand classification is in labels/needs_review.tsv and labels/release_task.tsv.

Not measurable from transcripts: whether the app accepted the ending. A cycle
that names the token and exits non-zero is stored `failed`, and a run that asked
for a stack parks instead (orchestrator.ts:13657-13676); the DB is unreadable.

Run: python3 needs_review.py [--list]
"""
import re
import sys
from collections import Counter

import corpus
import labels

NEEDS_REVIEW = re.compile(r"^\s*NEEDS_REVIEW\s*$", re.M)
DONE = re.compile(r"^\s*DONE\s*$", re.M)


def instance_id(session, assistant):
    return f"{session['file'].split('/')[-1][:8]}@{assistant['ts'][:19]}"


def main():
    records = corpus.load()
    grouped = corpus.runs(records)
    cycles = 0
    endings = Counter()
    found = []
    for key, sessions in grouped.items():
        for session in sessions:
            for user, assistants in corpus.cycles(session):
                if not corpus.is_prompt_turn(user):
                    continue
                cycles += 1
                last = assistants[-1] if assistants else None
                text = corpus.final_text(last) if last else ""
                if NEEDS_REVIEW.search(text):
                    endings["needs-review"] += 1
                    found.append((key, session, last, text))
                elif DONE.search(text):
                    endings["done"] += 1
                else:
                    endings["neither"] += 1
    sessions_all = [s for ss in grouped.values() for s in ss]
    print(f"population: {len(grouped)} runs ({sum(1 for k in grouped if k.startswith('uf/'))} isolated by branch, "
          f"{sum(1 for k in grouped if not k.startswith('uf/'))} unisolated), {len(sessions_all)} run sessions, "
          f"{cycles} prompt cycles, {corpus.date_range(sessions_all)[0]}..{corpus.date_range(sessions_all)[1]}")
    print(f"cycle endings: {dict(endings)}")
    runs_hit = {f[0] for f in found}
    print(f"NEEDS_REVIEW endings: {len(found)} cycles in {len(runs_hit)} runs "
          f"({len(runs_hit) / len(grouped):.1%} of runs, {len(found) / cycles:.1%} of cycles)")
    for key, session, last, text in found:
        repo = corpus.repo_of(key, grouped[key])
        print(f"  {instance_id(session, last)} {repo:<14} {key[-30:]}  reason: {len(text)} chars")
        print(f"      {text.splitlines()[0][:160]}")
    ids = [instance_id(s, a) for _, s, a, _ in found]
    labels.tally("needs_review", ids, "NEEDS_REVIEW classification")
    for i in ids:
        lab = labels.load("needs_review")[i]
        print(f"    {i}  {lab['class']:<16} {lab['reason']}")

    print()
    print("-- release_task: a run handing a board task back to the operator --")
    releases = []
    creates = 0
    operator_only = []
    for key, sessions in grouped.items():
        for session in sessions:
            for assistant in session["assistants"]:
                for tool in assistant["tools"]:
                    if tool["name"].endswith("release_task"):
                        releases.append((key, session, assistant, tool))
                    if tool["name"].endswith("create_task"):
                        creates += 1
                        if tool.get("operatorOnly"):
                            operator_only.append((key, session, assistant, tool))
    print(f"release_task calls: {len(releases)} in {len({r[0] for r in releases})} runs; "
          f"of the runs with a NEEDS_REVIEW ending, {len(runs_hit & {r[0] for r in releases})} also released a task")
    print(f"create_task calls: {creates}; carrying operatorOnly: {len(operator_only)} calls in "
          f"{len({r[0] for r in operator_only})} runs")
    # Every operatorOnly task was read by hand (58 titles); the rule below reproduces
    # that reading, and anything it cannot place is printed rather than guessed.
    physical = re.compile(r"\bMac\b|host shell|Chromium build|install's database|Docker", re.I)
    decision = re.compile(r"answer (operator )?decisions|Answer D10", re.I)
    split = Counter()
    for key, session, assistant, tool in operator_only:
        label = (tool.get("title", "") + " " + tool.get("text", ""))
        if decision.search(tool.get("title", "")):
            split["OPERATOR-ONLY (decision)"] += 1
        elif physical.search(label):
            split["OPERATOR-ONLY (physical: Mac, host shell, host DB or browser build)"] += 1
        else:
            split["UNPLACED"] += 1
            print("  unplaced operatorOnly task:", instance_id(session, assistant), tool.get("title", "")[:100])
    print("operatorOnly create_task calls by what they ask for:", dict(split))
    # create_task calls that put a decision to the operator in words, without the flag.
    decision_words = re.compile(r"\boperator(?:'s)? (?:decision|call|choice|say|to decide)\b|\bneeds? (?:a |the )?operator\b|\basks? the operator\b|"
                                r"\bdecision for the operator\b|\bquestion for the operator\b|\boperator (?:decides|must decide|should decide|chooses)\b", re.I)
    decision_tasks = []
    for key, sessions in grouped.items():
        for session in sessions:
            for assistant in session["assistants"]:
                for tool in assistant["tools"]:
                    if tool["name"].endswith("create_task") and not tool.get("operatorOnly"):
                        if decision_words.search(tool.get("title", "") + " " + tool.get("text", "")):
                            decision_tasks.append((key, session, assistant, tool))
    print(f"create_task calls without the flag whose text hands a decision to the operator (keyword): {len(decision_tasks)} "
          f"in {len({d[0] for d in decision_tasks})} runs; all read by hand: each defers a decision or a post-deploy check to the operator")
    for key, session, assistant, tool in decision_tasks:
        print(f"      {instance_id(session, assistant)} {tool.get('title', '')[:100]}")
    handed = (runs_hit | {r[0] for r in releases} | {o[0] for o in operator_only} | {d[0] for d in decision_tasks})
    print(f"runs that handed something to the operator by any of: NEEDS_REVIEW ending, release_task, operatorOnly task, decision task: "
          f"{len(handed)} of {len(grouped)} ({len(handed) / len(grouped):.1%})")
    # What each of those runs handed over: physical (a Mac, a host shell, a root measurement, a browser build)
    # or a decision. Read from the hand labels' reasons and the operatorOnly rule above.
    kinds_by_run = {}
    nr_labels, rel_labels = labels.load("needs_review"), labels.load("release_task")
    for key, session, assistant, tool in operator_only:
        text_ = tool.get("title", "") + " " + tool.get("text", "")
        kinds_by_run.setdefault(key, set()).add("decision" if decision.search(tool.get("title", "")) else "physical")
    for key, session, assistant, tool in releases:
        lab = rel_labels.get(instance_id(session, assistant))
        if lab:
            kinds_by_run.setdefault(key, set()).add("physical" if "physical" in lab["reason"] or "as root" in lab["reason"] else "decision")
    for key, session, assistant, text in found:
        lab = nr_labels.get(instance_id(session, assistant))
        if lab and lab["class"] == "OPERATOR-ONLY":
            kinds_by_run.setdefault(key, set()).add("physical" if "physical" in lab["reason"] else "decision")
    for key, *_ in decision_tasks:
        kinds_by_run.setdefault(key, set()).add("decision")
    mix = Counter("+".join(sorted(v)) for v in kinds_by_run.values())
    print(f"  what those runs handed over (hand-read): {dict(mix)}; runs in the union with no hand-read kind: "
          f"{len(handed - set(kinds_by_run))}")
    rids = [instance_id(s, a) for _, s, a, _ in releases]
    if "--list" in sys.argv:
        for key, session, assistant, tool in releases:
            print(f"  {instance_id(session, assistant)} {key[-28:]} operatorOnly={tool.get('operatorOnly')}")
            print("     ", tool.get("text", "")[:420].replace("\n", " "))
    if labels.load("release_task"):
        labels.tally("release_task", rids, "release_task classification")
        lab = labels.load("release_task")
        for i in rids:
            print(f"    {i}  {lab[i]['class']:<16} {lab[i]['reason']}")


if __name__ == "__main__":
    main()
