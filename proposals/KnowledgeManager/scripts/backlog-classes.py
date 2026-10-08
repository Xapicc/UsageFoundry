#!/usr/bin/env python3
"""qc.py's findings, split into the classes 00-problem.md §3 uses: what a
script could fix, what is Haiku-sized, what the vault keeps by policy, what is
the operator's (Inbox triage), and what is research for a frontier model.

Read-only over the vault. It imports qc.py itself — so a finding, a note and an
"ungraded" URL mean exactly what qc means by them — with bytecode writing
switched off first, so the import leaves nothing in `_Meta/__pycache__`.

    python3 proposals/KnowledgeManager/scripts/backlog-classes.py [vault]

Two judgements are this survey's, not qc's, and are printed as such:
- a `BODY/related` WARN on a `moc` or `area` note is a hub the vault keeps over
  eight links on purpose (`_Meta/Vault Quality Control.md`, "Why some of these
  are WARN"); on any other note it is a trim the rulebook's 3–8 range asks for
  and the vault calls a judgement call — Haiku-sized, on the operator's say-so;
- a `CONF/ungraded` note is mechanical only when every one of its ungraded URLs
  already appears in some source note, so that adding wikilinks clears it.
"""
import re
import sys
from collections import Counter
from pathlib import Path

sys.dont_write_bytecode = True
VAULT = Path(sys.argv[1] if len(sys.argv) > 1 else "/workspace2")
sys.path.insert(0, str(VAULT / "_Meta"))
import qc  # noqa: E402

URL = re.compile(r"https?://[^\s)\"'\]>]+")
HUB_TYPES = {"moc", "area"}


def norm(url: str) -> str:
    return url.rstrip("/.,")


notes = qc.collect()
by_rel = {n.rel: n for n in notes}
registered = qc.registered_tags()
report = qc.Report()
for n in notes:
    qc.check_frontmatter(n, report)
    qc.check_tags(n, report, registered)
    qc.check_structure(n, report)
    qc.check_keywords(n, report)
    qc.check_seed(n, report)
    qc.check_layout(n, report)
qc.check_links(notes, report)
qc.check_confidence_ceiling(notes, report)

# Which CONF/ungraded notes a wikilink alone would clear.
by_key = {}
for n in notes:
    for key in {n.stem, n.get("title", n.stem), *n.listy("aliases")}:
        if key:
            by_key.setdefault(key.lower(), n)
held = {norm(u) for s in notes if s.get("type") == "source" for u in URL.findall(s.text)}
urls = linkable = 0
clearable = set()
for n in notes:
    if n.get("type") == "source":
        continue
    cited = [by_key.get(m.group(1).strip().lower())
             for m in qc.WIKILINK_RE.finditer(qc.strip_code(n.text))]
    graded = {norm(u) for c in cited if c is not None and c.get("type") == "source"
              for u in URL.findall(c.text)}
    ungraded = [u for u in n.listy("sources") if u.startswith("http") and norm(u) not in graded]
    if not ungraded:
        continue
    urls += len(ungraded)
    here = sum(1 for u in ungraded if norm(u) in held)
    linkable += here
    if here == len(ungraded):
        clearable.add(n.rel)


def classify(level: str, family: str, rel: str) -> str:
    if "/Questions/Inbox/" in rel:
        return "operator: Inbox triage"
    if family == "KW/case":
        return "mechanical"
    if family == "CONF/ungraded":
        return "mechanical" if rel in clearable else "frontier: research debt"
    if family in ("KW/count", "KW/overlap"):
        return "haiku"
    if family == "BODY/related" and level == "WARN":
        kind = by_rel[rel].get("type") if rel in by_rel else "?"
        return "kept by policy" if kind in HUB_TYPES else "haiku, on the operator's say-so"
    if family == "BODY/source":
        return "kept by policy"
    if family == "CONF/ceiling":
        return "frontier: research debt"
    return f"unclassified: {family}"


rows = report.rows
families = Counter((row[1], row[0]) for row in rows)
classes = Counter(classify(row[0], row[1], row[2]) for row in rows)
errors = sum(1 for row in rows if row[0] == "ERROR")
print(f"{len(notes)} notes; {errors} errors, {len(rows) - errors} warnings, {len(rows)} findings")
print("\nby family (family, level, count):")
for (family, level), count in sorted(families.items()):
    print(f"  {family:<15} {level:<6} {count:>4}")
print(f"\nCONF/ungraded: {urls} URLs, {linkable} already held by a source note; "
      f"{len(clearable)} notes would clear with wikilinks alone")
print("\nby class:")
for name, count in classes.most_common():
    print(f"  {count:>4}  {name}")
