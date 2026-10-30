#!/usr/bin/env python3
"""Kind 6: runs that say the task was already done, or that the brief was wrong.

Population: every assistant text block of the 494 runs, scanned at two levels:
  report   the run's final report (as in final_reports.py)
  any      any text block in the run (so a run that says so early and then
           works on is counted too)
Families (case-insensitive; a match is a candidate, not a finding):
  done     the task/work/fix/bug/issue "... already ... done|fixed|implemented|
           landed|merged|resolved|addressed|in place|on main|in main", or "already
           (fixed|implemented|landed|merged|resolved|addressed) (on|in|by|at)", or
           "nothing (left) to do|change|fix", "no (code) change(s) (is|are|were)
           needed|necessary|required"
  wrong    the brief/task/description/ticket/spec ... is|was wrong|stale|out of
           date|outdated|mistaken|incorrect|inaccurate|misleading|ambiguous|"no
           longer true|accurate"; or "the brief's (claim|premise|reading|figure)"
           with "wrong|not quite right|does not hold"
Counts are exact for the patterns; what a hit means is the sample's judgement
(labels/already_done.tsv; every report-level hit is labelled because there are
fewer than 40 of them).

Run: python3 already_done.py [--sample] [--all-any]
"""
import re
import sys
from collections import Counter

import corpus
import labels
import sampling
from final_reports import final_report

NOUN = r"(?:task|work|fix|change|bug|issue|feature|brief|request|item|finding|bullet|part|point|ask|requirement|behaviou?r|test|doc|check)s?"
FAMILIES = {
    "done": re.compile(
        r"\b(?:this|the|that|these|those|both|all)\b[^.\n]{0,60}\b" + NOUN + r"\b[^.\n]{0,60}\balready\b[^.\n]{0,40}"
        r"\b(?:done|fixed|implemented|landed|merged|resolved|addressed|in place|on main|in main|present|handled)\b"
        r"|\balready (?:fixed|implemented|landed|merged|resolved|addressed|done) (?:on|in|by|at|upstream)\b"
        r"|\b(?:was|is|were|are|been) already (?:fixed|implemented|landed|merged|resolved|addressed|done|on main|in main|in place)\b"
        r"|\bnothing (?:left |more |else )?to (?:do|change|fix)\b"
        r"|\bno (?:code |further )?changes? (?:is |are |were |was )?(?:needed|necessary|required)\b"
        r"|\bthere is nothing (?:for me )?to (?:do|change)\b",
        re.I),
    "wrong": re.compile(
        r"\b(?:brief|task|description|ticket|spec|task text|premise)\b[^.\n]{0,60}\b(?:is|was|are|has become|had become) "
        r"(?:wrong|stale|out of date|outdated|mistaken|incorrect|inaccurate|misleading|ambiguous|no longer (?:true|accurate|correct|holds))\b"
        r"|\bthe (?:brief|task|ticket)'s (?:claim|premise|reading|figure|description|number|diagnosis)\b[^.\n]{0,60}\b(?:wrong|not quite right|does not hold|doesn't hold|incorrect|outdated|stale)\b"
        r"|\bno longer (?:true|accurate|holds) (?:on|in) main\b",
        re.I),
}


def candidates(sessions, key, level):
    out = []
    if level == "report":
        session, assistant, text = final_report(sessions)
        blocks = [(session, assistant, text)] if text else []
    else:
        blocks = [(s, a, t) for s in sessions for a in s["assistants"] for t in a["texts"]]
    for session, assistant, text in blocks:
        for name, regex in FAMILIES.items():
            match = regex.search(text)
            if match:
                out.append({"id": f"{session['file'].split('/')[-1][:8]}@{assistant['ts'][:19]}", "key": key, "family": name,
                            "text": text, "match": match, "repo": corpus.repo_of(key, sessions)})
    return out


def main():
    records = corpus.load()
    grouped = corpus.runs(records)
    report_hits, any_hits = [], []
    for key, sessions in grouped.items():
        report_hits += candidates(sessions, key, "report")
        any_hits += candidates(sessions, key, "any")
    for level, hits in (("report", report_hits), ("any text block", any_hits)):
        runs_by = {name: len({h["key"] for h in hits if h["family"] == name}) for name in FAMILIES}
        print(f"{level}: runs with a hit: {len({h['key'] for h in hits})} of {len(grouped)}  by family {runs_by}")
    # One instance per run, the earliest report-level hit, so the sample is of runs.
    per_run = {}
    for hit in report_hits:
        per_run.setdefault(hit["key"], hit)
    instances = list(per_run.values())
    sample = sampling.pick(instances, 40)
    print(f"sampling frame: {len(instances)} runs with a report-level hit; sample drawn: {len(sample)}")
    if "--sample" in sys.argv:
        for item in sample:
            print(f"\n### {item['id']} {item['repo']} [{item['family']}] {item['key'][-26:]}")
            print("  " + sampling.excerpt(item["text"], item["match"], 260))
    if labels.load("already_done"):
        ids = [i["id"] for i in sample]
        labels.tally("already_done", ids, f"sample of {len(sample)} report-level hits")
        lab = labels.load("already_done")
        for i in ids:
            print(f"    {i}  {lab[i]['class']:<16} {lab[i]['reason']}")
    if "--all-any" in sys.argv:
        seen = set()
        for hit in any_hits:
            if hit["key"] in seen:
                continue
            seen.add(hit["key"])
            print(f"\n### any {hit['id']} {hit['repo']} [{hit['family']}]\n  " + sampling.excerpt(hit["text"], hit["match"], 160))


if __name__ == "__main__":
    main()
