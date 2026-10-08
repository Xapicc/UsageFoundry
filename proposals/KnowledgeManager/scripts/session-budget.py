#!/usr/bin/env python3
"""What one Knowledge Manager session would have to hold, per note, against
Haiku 5.5's 100,000-token prompt cliff (src/lib/pricing.ts, commit 8bf8b80c).

Read-only over the vault. It imports the vault's own `vaultlib` so that "a
note" and "a token" mean exactly what qc.py and build_index.py mean by them —
`collect()` is the vault's one definition of a note, and every token figure is
its ~4 bytes/token ESTIMATE, never a tokeniser count. Bytecode writing is
switched off before the import, because importing a module from `_Meta/`
would otherwise drop a `.pyc` into the vault.

    python3 proposals/KnowledgeManager/scripts/session-budget.py [vault] [baseline]

`baseline` is the CLI's own prompt before the first tool result: system
prompt, tool schemas and the auto-loaded CLAUDE.md. Default 30000, an
assumption the README states and 11-validation.md says how to measure.
"""
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True
VAULT = Path(sys.argv[1] if len(sys.argv) > 1 else "/workspace2")
BASELINE = int(sys.argv[2]) if len(sys.argv) > 2 else 30000
CLIFF = 100_000
sys.path.insert(0, str(VAULT / "_Meta"))
import vaultlib  # noqa: E402

WIKILINK = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")


def pct(values, p):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(round(p / 100 * (len(ordered) - 1))))]


def describe(label, values):
    print(f"{label:<44} n={len(values):>5}  p50={pct(values, 50):>7,}  p90={pct(values, 90):>7,}"
          f"  p99={pct(values, 99):>7,}  max={max(values):>8,}")


notes = vaultlib.collect(VAULT, with_body=True)
by_key = {}
for n in notes:
    for key in [n.title, Path(n.path).stem, *n.aliases]:
        by_key.setdefault(vaultlib._fold(key).strip(), n)

tokens = {n.path: n.nbytes // 4 for n in notes}
outgoing, inbound = {}, {n.path: 0 for n in notes}
for n in notes:
    targets = set()
    for m in WIKILINK.finditer(n.body):
        target = by_key.get(vaultlib._fold(m.group(1)).strip())
        if target and target.path != n.path:
            targets.add(target.path)
    outgoing[n.path] = targets
    for t in targets:
        inbound[t] += 1

fixed = {name: (VAULT / name).stat().st_size // 4
         for name in ["CLAUDE.md", "AGENTS.md", "_Meta/Tag Index.md", "INDEX.md"]}
print(f"vault {VAULT}: {len(notes)} notes by vaultlib.collect(), "
      f"{sum(tokens.values()):,} estimated tokens in all of them")
for name, t in fixed.items():
    print(f"  {name:<22} {t:>9,} estimated tokens")
print(f"assumed CLI baseline before any tool result: {BASELINE:,} (includes CLAUDE.md)\n")

own = list(tokens.values())
hop = [tokens[p] + sum(tokens[t] for t in outgoing[p]) for p in tokens]
describe("one note", own)
describe("one note + every note it links to", hop)
# The alternative a session can take: read the neighbours' abstracts, which is
# what AGENTS.md's retrieval path and vault_search.py return, not their bodies.
abstract_tokens = {n.path: len(n.abstract.encode("utf-8")) // 4 for n in notes}
hop_abstracts = [tokens[p] + sum(abstract_tokens[t] for t in outgoing[p]) for p in tokens]
describe("one note + the abstracts of its links", hop_abstracts)
describe("outgoing links per note", [len(outgoing[p]) for p in tokens])
describe("inbound links per note", list(inbound.values()))
print(f"orphans (no inbound wikilink from another note): "
      f"{sum(1 for v in inbound.values() if v == 0)}")

print("\nnotes whose job would cross the cliff on its own, at this baseline:")
room = CLIFF - BASELINE
print(f"  room under the cliff after baseline: {room:,}")
print(f"  reading the note alone:           {sum(1 for t in own if t > room)}")
print(f"  reading it and all its links:     {sum(1 for t in hop if t > room)}")
print(f"  reading it and its links' abstracts: {sum(1 for t in hop_abstracts if t > room)}")
print(f"  reading it and the Tag Index:     "
      f"{sum(1 for t in own if t + fixed['_Meta/Tag Index.md'] > room)}")

# A session that edits notes one after another keeps every read and every
# edit in its context, so the cliff caps how many notes one session may touch.
# Each note is costed as read once plus written back once (an Edit echoes the
# changed region, a rewrite the whole note; the whole note is the bound).
median = pct(own, 50)
per_note = 2 * median
print(f"\nmedian note {median:,} tokens; a session holding read+write of each "
      f"fits {room // per_note} median notes before the cliff")
p90 = pct(own, 90)
print(f"p90 note {p90:,} tokens; {room // (2 * p90)} such notes per session")

largest = sorted(tokens.items(), key=lambda kv: -kv[1])[:8]
print("\nlargest notes:")
for path, t in largest:
    print(f"  {t:>7,}  {path}")
