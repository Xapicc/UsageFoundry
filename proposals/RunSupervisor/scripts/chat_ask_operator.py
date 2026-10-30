#!/usr/bin/env python3
"""Kind 8: the orchestrator chat's ask_operator, and the operator's turns.

Population: the -run-uf-chat directory (the orchestrator chat's cwd is
/run/uf-chat), top-level sessions only. Measures, exactly:
  * tool_use blocks named like ask_operator (route.ts:1269 defines it; it records
    questions and ends the turn, the operator's next message is the answer);
  * operator turns: user turns that are not tool results, not isMeta, and not
    injected text (<task-notification>, <system-reminder>, "[Request interrupted"),
    reported three ways: all user turns, minus injected, and minus the canned
    "Start runs for Tasks on the Taskboard ..." prompt the board's button sends;
  * the same counts without the 2026-10-30 cutoff (the vault note's window is
    unknown; sessions begun on the measurement day are otherwise excluded);
  * chat turns that END in a question mark in prose (a question asked without the
    tool), and list_recurring_failures calls by session class.
Each ask_operator call is shown with the operator turn it answered and the
question text, and is hand-labelled in labels/ask_operator.tsv.

The vault claim being checked: "3 calls in 152 operator turns".

Run: python3 chat_ask_operator.py
"""
import json
import re
from collections import Counter

import corpus
import labels

CANNED = "Start runs for Tasks on the Taskboard"


def counts(records):
    chat = [r for r in records if r["class"] == "chat"]
    all_user = injected = canned = 0
    asks = []
    prose_questions = []
    for record in chat:
        last_prompt = None
        for _, kind, obj in corpus.events(record):
            if kind == "user":
                all_user += 1
                if not corpus.is_prompt_turn(obj):
                    injected += 1
                else:
                    last_prompt = obj
                    if obj["text"].startswith(CANNED):
                        canned += 1
            else:
                for tool in obj["tools"]:
                    if tool["name"].endswith("ask_operator"):
                        asks.append((record, obj, tool, last_prompt))
                text = "\n".join(obj["texts"]).strip()
                if text and not obj["tools"] and re.search(r"\?\s*$", re.sub(r"```.*?```", "", text, flags=re.S)):
                    prose_questions.append((record, obj, text))
    return chat, all_user, injected, canned, asks, prose_questions


def main():
    for label, apply_cutoff in (("with the cutoff (sessions begun before 2026-10-30)", True), ("without the cutoff", False)):
        records = corpus.load(apply_cutoff=apply_cutoff)
        chat, all_user, injected, canned, asks, prose = counts(records)
        operator = all_user - injected
        print(f"[{label}] chat sessions {len(chat)} ({corpus.date_range(chat)[0]}..{corpus.date_range(chat)[1]}); "
              f"user turns {all_user}; injected {injected}; operator turns {operator}; of those canned start-runs {canned}, free-typed {operator - canned}; "
              f"ask_operator calls {len(asks)}  ->  {len(asks)}/{operator} = {len(asks) / operator:.1%} of operator turns")
        print(f"    assistant turns that end in '?' in prose with no tool call: {len(prose)}")
    records = corpus.load()
    chat, all_user, injected, canned, asks, prose = counts(records)
    print()
    for record, assistant, tool, prompt in asks:
        ident = f"{record['file'].split('/')[-1][:8]}@{assistant['ts'][:19]}"
        questions = []
        try:
            questions = [q.get("question", "")[:150] for q in json.loads(tool["input"]).get("questions", [])]
        except ValueError:
            questions = [tool["input"][:300]]
        print(f"ask_operator {ident}")
        print("   operator turn before it:", (prompt["text"][:200] if prompt else "-").replace("\n", " "))
        print("   first question:", (questions[0] if questions else "")[:200])
    labels.tally("ask_operator", [f"{r['file'].split('/')[-1][:8]}@{a['ts'][:19]}" for r, a, _, _ in asks], "ask_operator classification")
    lab = labels.load("ask_operator")
    for i, v in lab.items():
        print(f"    {i}  {v['class']:<16} {v['reason']}")
    print()
    calls = Counter()
    for record in records:
        for assistant in record["assistants"]:
            for tool in assistant["tools"]:
                if tool["name"].endswith("list_recurring_failures"):
                    calls[record["class"]] += 1
    print(f"list_recurring_failures tool_use blocks by session class: {dict(calls)}")
    print("run sessions that called it:", sum(1 for r in records if r["class"].startswith("run-") for a in r["assistants"] for t in a["tools"] if t["name"].endswith("list_recurring_failures")))


if __name__ == "__main__":
    main()
