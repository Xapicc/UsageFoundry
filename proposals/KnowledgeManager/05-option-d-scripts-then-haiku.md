# Option D — scripts for the deterministic part, Haiku only for the remainder

## What it is in this app

The deterministic part moves out of any prompt and into one vault-side script,
`_Meta/housekeeping.py`, beside the `qc.py` it builds on — importing qc's own
checks, so "a note" and "wrong" keep the vault's one definition
(`/workspace2/_Meta/qc.py:119`, `/workspace2/_Meta/vaultlib.py:229`). It is
written once, by a frontier run, as a vault task with tests in `_Meta/tests/`,
and has six verbs ([`10-implementation-sketch.md`](10-implementation-sketch.md)
§2 has each in full):

| Verb | Does | Model |
|---|---|---|
| `plan --json` | qc's findings, `build_index.py --check`, and the stale-abstract heuristics of 00 §5; one job per note with its class (mechanical, haiku, frontier, operator), its **write set**, its **reading list** — the note, plus the *abstracts* of its links — and an estimated token cost; skips any note whose mtime is under an hour old (C12) | none |
| `abstract <path>` | prints one note's abstract callout — the cheap read a reading list points at | none |
| `snapshot` | a tarball of every `.md`, every file under `_Meta/` and `.obsidian/`, and qc's findings before — 0.5 s and 6.66 MB for the notes, measured | none |
| `fix --mechanical` | lowercase a keyword, apply a recorded Tag Index replacement, link a URL to its existing source note, bump `updated:` | none |
| `verify` | compares everything against the snapshot; fails on a file outside the pass's write sets, over the cap (C3), any change under `_Meta/` or `.obsidian/` but the index `build_index.py` writes, a never-list field, prose outside the abstract, `## Related` and a log section, or a qc finding on a changed file that was not there before — and **reverts the pass itself** when it fails; otherwise keeps the pre-images of changed files and a manifest as the pass's changeset | none |
| `revert <pass> [path]` | restores pre-images where the live file still hashes to the post-image — never over a later human edit | none |

Everything it keeps lives in `_Meta/.housekeeping/` as tarballs and JSON, never
as `.md` files — so qc.py's own walk, which skips only the directories it names
(`/workspace2/_Meta/qc.py:30`), vaultlib's, and the app's index, which skips
dot-directories (`src/lib/knowledge.ts:826`), never see a pre-image as a note.
Obsidian is **assumed** to ignore a dot-directory as well.

The Haiku half is Option A's template with a short, fixed prompt naming exact
commands: `plan` → `snapshot` → `fix --mechanical` → for each haiku job, read
its reading list and make the edit → `verify` → if anything changed,
`python3 _Meta/build_index.py` → a five-line report. `plan` refuses to start
while a pending snapshot exists, and verifies that one first — so a session
that dies or skips `verify` is caught by the next.

## Its strongest case

- **The model is paid only for judgement.** Of today's 418 findings, `plan`
  hands Haiku five — ninety if the operator wants non-hub Related lists trimmed —
  and fixes nine itself (00 §3); a week with nothing to do costs one cheap
  session that reads a short JSON list and stops.
- **The envelope is code with tests, not sentences.** The snapshot is taken
  before the model writes anything; `verify` checks write set, cap, frontmatter,
  prose regions and qc deterministically, and reverts on its own; `revert` is a
  command, not a hope. Only *calling* them is prompt-borne, and `plan`'s
  pending-snapshot refusal makes a skipped `verify` visible on the next pass.
- **The cliff is respected by construction.** A job's reading list is the note
  and its neighbours' abstracts — p99 14.6k tokens, against 116k at p90 for
  whole neighbours (00 §2) — and `plan` packs a session to a budget that leaves
  room for the pass's own overhead (08 §3).
- **It respects C10.** The vault's code runs inside a run's sandbox, the app
  writes nothing, and the vault keeps owning its definition of wrong.
- **Everyone can use it.** Dreaming and research runs can call `verify` on
  their own passes; the operator can call `revert` from a terminal; the
  mechanical fixer is useful even if Haiku fails the spike.

## The case against, in this install

- **Calling the envelope is still the model's job.** A Haiku session could
  edit without `snapshot`; the pending-snapshot rule only catches a skipped
  `verify`, not a skipped `snapshot`.
- **The judge runs inside the session it judges.** `verify` imports qc.py and
  is itself `housekeeping.py`; a session that edited either could pass its own
  pass, and nothing in the session can stop that — the never-list forbids it,
  and only an out-of-session hash, Option C's, would catch it. The spike counts
  any such edit, and one means Option C's check comes before any unattended
  pass ([`09-recommendation.md`](09-recommendation.md); [`11-validation.md`](11-validation.md) §3).
- **It costs a frontier run up front.** Six verbs and their tests, in a vault
  whose tooling sessions cost $4.48–$15.96 at list price, median $12.16
  ([`scripts/vault-cost.mjs`](scripts/vault-cost.mjs)) — **assumed** one or two
  such runs.
- **Its pre-images sync to iCloud** — a pending tarball of ~7 MB for the
  length of a pass and small changesets after it, on the operator's quota.

## What it costs

One or two frontier runs for the script (**assumed** $12–32, the measured
median and maximum of the vault's tooling sessions). Per pass the same as A:
about $0.01 idle, $0.07–0.35 working (08 §4).

## Verdict

**The recommended shape**, delivered through Option A's template and schedule,
with [Option F](07-option-f-no-debt-at-source.md) alongside it.
