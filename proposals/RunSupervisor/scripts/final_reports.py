#!/usr/bin/env python3
"""Kind 4: final reports that list judgement calls, assumptions or ambiguity.

Population: the last assistant message that has text, in the last session of
each run (494 runs). That is the report the operator reads. The brief that
nearly every board run is started with already says "Nobody will answer a
question, so make each judgement call yourself and write it down in your final
message" (e.g. proposals' run prompt, quoted in the first prompt of 925e5b4e),
so a match on "judgement call" is partly the prompt echoed back; the script
counts that separately by checking the run's own first prompt.

Keyword families (case-insensitive), counted per run (exact match counts; the
meaning of a match is a sample-based judgement, see labels/final_reports.tsv):
  judgement   judge?ment call(s)
  assumed     assum(e|ed|es|ption|ptions)  and "I assumed"
  decided     I decided / I chose / I picked / I opted / I went with
  unclear     unclear / ambiguous / ambiguity
  silent      brief|task|spec ... does not/doesn't say|specify|state; not specified;
              underspecified; silent on
Also counted, in every text block of every run: phrases in which a run says it wanted
to ask ("would have asked", "cannot ask", "ask the operator", ...).
Sample: 25 runs drawn with sampling.pick from the runs with any match, each
shown with the first match of each family and read by hand.

Run: python3 final_reports.py [--sample]    (--sample prints the excerpts to label)
"""
import re
import sys
from collections import Counter

import corpus
import labels
import sampling

FAMILIES = {
    "judgement": re.compile(r"\bjudge?ments?(?: calls?)?\b", re.I),
    "assumed": re.compile(r"\bassum(?:e|ed|es|ption|ptions)\b", re.I),
    "decided": re.compile(r"\bI (?:decided|chose|picked|opted|went with)\b", re.I),
    "unclear": re.compile(r"\bunclear\b|\bambigu(?:ous|ity)\b", re.I),
    "silent": re.compile(r"\b(?:brief|task|spec|description|ticket)\b[^.\n]{0,40}\b(?:does not|doesn't|did not|didn't) (?:say|specify|state|name|define|mention)\b|\bnot specified\b|\bunderspecified\b|\bsilent on\b", re.I),
}
# The run saying, in its own words, that it wanted to ask somebody. Searched in every
# assistant text block, not only the final report.
WANTED_TO_ASK = re.compile(
    r"\b(?:would have asked|would ask|had I (?:been able to )?ask|could(?:n't| not) ask|nobody (?:to|can|will) (?:ask|answer)"
    r"|no one (?:to ask|to answer|can answer)|can't ask|cannot ask|(?:should|to|and|I'll|I will|will|can) ask (?:the operator|you|someone|a person|the user)"
    r"|ask the operator|ask you|if I could ask|question for (?:you|the operator))\b", re.I)
PROMPTED = re.compile(r"judge?ment call|make each (?:judge?ment )?call yourself|say what you (?:decided|chose)", re.I)


def final_report(sessions):
    for session in reversed(sessions):
        for assistant in reversed(session["assistants"]):
            text = corpus.final_text(assistant)
            if text:
                return session, assistant, text
    return None, None, ""


def question_outside_code(text):
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    text = re.sub(r"`[^`]*`", "", text)
    return re.search(r"[^.\n]{15,200}\?(?=\s|$)", text) is not None


def run_id(session, assistant):
    return f"{session['file'].split('/')[-1][:8]}@{assistant['ts'][:19]}"


def main():
    records = corpus.load()
    grouped = corpus.runs(records)
    per_family = Counter()
    per_family_prompted = Counter()
    any_match, no_report = [], 0
    ends_question = 0
    prompted_runs = 0
    for key, sessions in grouped.items():
        session, assistant, text = final_report(sessions)
        if not text:
            no_report += 1
            continue
        prompted = bool(PROMPTED.search(sessions[0]["first_prompt"] or ""))
        prompted_runs += prompted
        if question_outside_code(text):
            ends_question += 1
        hits = {name: regex.search(text) for name, regex in FAMILIES.items()}
        hit_names = [n for n, m in hits.items() if m]
        for name in hit_names:
            per_family[name] += 1
            per_family_prompted[name] += prompted
        if hit_names:
            any_match.append({"id": run_id(session, assistant), "key": key, "text": text, "hits": hits,
                              "prompted": prompted, "repo": corpus.repo_of(key, sessions)})
    print(f"runs: {len(grouped)}; with a final report: {len(grouped) - no_report}; "
          f"runs whose own brief tells them to write judgement calls down: {prompted_runs}")
    nobody = sum(1 for ss in grouped.values() if re.search(r"nobody will answer|no one will answer|unattended", ss[0]["first_prompt"] or "", re.I))
    print(f"runs whose first prompt says nobody will answer a question (or that it runs unattended): {nobody}")
    print(f"final reports with a sentence ending in '?' outside code spans and fences: {ends_question} "
          f"(by hand: the one hit, fadd2a95@2026-10-05T16:02:30, is a table header 'Binds?')")
    for name in FAMILIES:
        print(f"  {name:<10} {per_family[name]:>4} runs   ({per_family_prompted[name]} of them under a brief that asks for judgement calls)")
    print(f"runs with any family: {len(any_match)} ({len(any_match) / (len(grouped) - no_report):.1%} of final reports)")
    unprompted = [m for m in any_match if not m["prompted"]]
    print(f"  ...of which under a brief that does not ask for them: {len(unprompted)}")
    only_judgement = [m for m in any_match if [n for n, h in m['hits'].items() if h] == ["judgement"]]
    print(f"  ...matching ONLY the judgement family: {len(only_judgement)}")
    wanted = []
    for key, sessions in grouped.items():
        for session in sessions:
            for assistant in session["assistants"]:
                for block in assistant["texts"]:
                    match = WANTED_TO_ASK.search(block)
                    if match:
                        wanted.append((key, run_id(session, assistant), sampling.excerpt(block, match, 100)))
    print(f"runs with an 'I would have asked / ask the operator / cannot ask' phrase in ANY text block: {len({w[0] for w in wanted})}")
    for key, ident, excerpt in wanted:
        print(f"    {ident} {excerpt}")
    print("    (by hand: both are false positives -- 'runs still can't ask for a stack' is the tool's gate described in a doc change;"
          " 'a rule cannot ask which bridge' is nftables)")
    sample = sampling.pick(any_match)
    if "--sample" in sys.argv:
        for item in sample:
            print(f"\n### {item['id']} {item['repo']} prompted={item['prompted']} {item['key'][-26:]}")
            for name, match in item["hits"].items():
                if match:
                    print(f"  [{name}] {sampling.excerpt(item['text'], match)}")
    ids = [m["id"] for m in sample]
    if labels.load("final_reports"):
        counts = labels.tally("final_reports", ids, f"sample of {len(sample)} final reports with a match")
        lab = labels.load("final_reports")
        for i in ids:
            print(f"    {i}  {lab[i]['class']:<16} {lab[i]['reason']}")


if __name__ == "__main__":
    main()
