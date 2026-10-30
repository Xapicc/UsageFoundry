#!/usr/bin/env python3
"""Kind 7: runs that stopped before a destructive or irreversible step to check.

Population: every assistant text block of the 494 runs. Families (case-insensitive;
counts are exact for the pattern, meaning is the hand label):
  before-destroy   "before (I) delete|remove|drop|overwrite|wipe|purge|reset|rewrite|force..."
  irreversible     irreversible / cannot|can't|can not be undone / destructive / not reversible
  force-push       force-push / force push / push --force / --force-with-lease
  confirm          "confirm first", "before confirming", "needs your (confirmation|approval|go-ahead)",
                   "want me to", "would you like", "should I (delete|remove|push|force|drop|reset)",
                   "do you want", "your call", "left (it )?for you to"
  declined         "rather than / instead of (delet|remov|overwrit|reset|forc)...", "did not|didn't|won't|will not
                   (delete|remove|overwrite|reset|force|wipe|drop)", "left ... alone", "refus(ed|ing) to (delete|overwrite|force)"
  not-pushed       "did not / didn't push", "not pushed", "nothing (was )?pushed", "I did not merge"
                   -- counted, NOT sampled: every board brief says "Do not push" (see the quoted
                   brief in labels/rules), so this family measures compliance. A 4-excerpt check
                   is printed with --compliance to show that.
Labelling: every run with a hit in the four specific families, plus 25 drawn with
sampling.pick from the runs hit only by `declined` (one instance per run: its
first hit), in labels/destructive_stops.tsv.

Run: python3 destructive_stops.py [--sample] [--compliance]
"""
import re
import sys
from collections import Counter

import corpus
import labels
import sampling

FAMILIES = {
    "before-destroy": re.compile(r"\bbefore (?:I |we |it )?(?:delet|remov|drop|overwrit|wip|purg|reset|rewrit|forc|destroy|clobber)\w*", re.I),
    "irreversible": re.compile(r"\birreversible\b|\b(?:can(?:'|no)?t|cannot|can not) be (?:undone|reversed|recovered)\b|\bnot reversible\b|\bdestructive\b", re.I),
    "force-push": re.compile(r"\bforce[- ]push|push --force|--force-with-lease\b", re.I),
    "declined": re.compile(r"\b(?:rather than|instead of) (?:delet|remov|overwrit|reset|forc|wip|dropp)\w*|\b(?:did not|didn't|won't|will not|did NOT) (?:delete|remove|overwrite|reset|force|wipe|drop)\b|\brefus(?:ed|ing) to (?:delete|overwrite|force|remove)\b|\bleft (?:it|them|that|this|those|the \w+) alone\b", re.I),
    "confirm": re.compile(r"\bconfirm first\b|\bbefore confirming\b|\bneeds? (?:your|the operator's) (?:confirmation|approval|go-ahead)\b|\bwant me to\b|\bwould you like\b|\bshould I (?:delete|remove|push|force|drop|reset)\b|\bdo you want\b|\byour call\b|\bleft (?:it )?for you to\b", re.I),
}
COMPLIANCE = re.compile(r"\b(?:did not|didn't|have not|haven't|not) push(?:ed)?\b|\bnothing (?:was |is )?pushed\b|\bI did not merge\b", re.I)
SAMPLED = ("before-destroy", "irreversible", "force-push", "confirm", "declined")


def main():
    records = corpus.load()
    grouped = corpus.runs(records)
    runs_by = {name: set() for name in list(FAMILIES) + ["not-pushed"]}
    first_hit, first_declined = {}, {}
    compliance = []
    for key, sessions in grouped.items():
        for session in sessions:
            for assistant in session["assistants"]:
                for text in assistant["texts"]:
                    for name, regex in FAMILIES.items():
                        match = regex.search(text)
                        if match:
                            runs_by[name].add(key)
                            bucket = first_declined if name == "declined" else first_hit
                            bucket.setdefault(key, {"id": f"{session['file'].split('/')[-1][:8]}@{assistant['ts'][:19]}",
                                                       "key": key, "family": name, "text": text, "match": match,
                                                       "repo": corpus.repo_of(key, sessions)})
                    match = COMPLIANCE.search(text)
                    if match:
                        runs_by["not-pushed"].add(key)
                        compliance.append((key, sampling.excerpt(text, match, 90)))
    print(f"runs: {len(grouped)}")
    for name, keys in runs_by.items():
        print(f"  {name:<16} {len(keys):>4} runs")
    stops = set().union(*(runs_by[n] for n in SAMPLED))
    print(f"runs with a hit in {SAMPLED}: {len(stops)}")
    briefs = sum(1 for ss in grouped.values() if re.search(r"do not push|don't push|Do not push", ss[0]["first_prompt"] or "", re.I))
    print(f"runs whose own first prompt says do not push: {briefs}")
    # The four specific families are few enough to label in full; the broad
    # "declined" family is sampled from the runs that are not already in them.
    strict = sorted(first_hit.values(), key=lambda item: item["id"])
    broad = [item for key, item in first_declined.items() if key not in first_hit]
    sample = strict + sampling.pick(broad)
    print(f"specific-family runs, all labelled: {len(strict)}; 'declined' runs outside them: {len(broad)}, sample: {min(len(broad), sampling.SAMPLE_SIZE)}")
    if "--compliance" in sys.argv:
        for key, e in compliance[:6]:
            print("  compliance excerpt:", key[-22:], e)
    if "--sample" in sys.argv:
        for item in sample:
            print(f"\n### {item['id']} {item['repo']} [{item['family']}] {item['key'][-26:]}")
            print("  " + sampling.excerpt(item["text"], item["match"], 260))
    if labels.load("destructive_stops"):
        ids = [i["id"] for i in sample]
        labels.tally("destructive_stops", ids, f"sample of {len(sample)} runs with a hit")
        lab = labels.load("destructive_stops")
        for i in ids:
            print(f"    {i}  {lab[i]['class']:<16} {lab[i]['reason']}")


if __name__ == "__main__":
    main()
