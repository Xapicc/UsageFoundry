# Option D — scripts for the deterministic part, Haiku only for the remainder

## What it is in this app

The deterministic part moves out of any prompt and into one vault-side script,
`_Meta/housekeeping.py`, beside the `qc.py` it builds on and importing the same
`vaultlib` — so "a note" and "wrong" keep the vault's one definition
(`/workspace2/_Meta/vaultlib.py:229`). It is written once, by a frontier run, as
a vault task with tests in `_Meta/tests/`, and has five verbs:

| Verb | Does | Model |
|---|---|---|
| `plan --json` | runs qc's checks in-process, `build_index.py --check`, and the stale-abstract heuristics of 00 §5; emits one job per note with its class (mechanical, haiku, frontier, operator), its **write set**, its **reading list** — the note, plus the *abstracts* of its links — and an estimated token cost; skips any note whose mtime is under an hour old (C12) | none |
| `snapshot` | `tar czf` of every `.md` into `_Meta/housekeeping/pending/<pass>.tgz` — 0.5 s and 6.66 MB measured | none |
| `fix --mechanical` | applies class-(a) jobs: lowercase a keyword, apply a recorded Tag Index replacement, link a URL to its existing source note, bump `updated:` | none |
| `verify <pass>` | compares every note against the snapshot; each changed file must be in the pass's write set, at most the cap (C3) of them, and qc on it must report no more findings than before; writes the pre-images of changed files and a manifest to `_Meta/housekeeping/changesets/<pass>/` and drops the tarball; exits non-zero on any breach | none |
| `revert <pass> [path]` | restores pre-images where the live file still hashes to the post-image — never over a later human edit | none |

The Haiku half is Option A's template with a short, fixed prompt naming exact
commands: `plan` → `snapshot` → `fix --mechanical` → for each haiku job, read
its reading list and make the edit → `verify` → on failure `revert` → if
anything changed, `python3 _Meta/build_index.py` → a five-line report. `plan`
refuses to start while a pending snapshot exists, and verifies that one first —
so a session that dies or skips `verify` is caught by the next.

## Its strongest case

- **The model is paid only for judgement.** Of today's 418 findings, `plan`
  hands Haiku six and fixes about 23 itself (00 §3); a week with nothing to do
  costs one cheap session that reads a short JSON list and stops.
- **The envelope is code with tests, not sentences.** The snapshot is taken
  before the model writes anything; `verify` checks write set, cap and qc
  delta deterministically; `revert` is a command, not a hope. Only *calling*
  them is prompt-borne, and `plan`'s pending-snapshot refusal makes skipping
  them visible on the next pass.
- **The cliff is respected by construction.** A job's reading list is the note
  and its neighbours' abstracts — p99 14.6k tokens, against 116k at p90 for
  whole neighbours (00 §2) — and `plan` refuses to put a 42k-token hub in a
  session with anything else.
- **It respects C10.** The vault's code runs inside a run's sandbox, the app
  writes nothing, and the vault keeps owning its definition of wrong.
- **Everyone can use it.** Dreaming and research runs can call `verify` on
  their own passes; the operator can call `revert` from a terminal; the
  mechanical fixer is useful even if Haiku fails the spike.

## The case against, in this install

- **Calling the envelope is still the model's job.** A Haiku session could
  edit without `snapshot`; the pending-snapshot rule only catches a skipped
  `verify`, not a skipped `snapshot`. The spike measures whether it happens
  ([`11-validation.md`](11-validation.md)), and Option C's app-side changeset
  is the fix if it does.
- **It costs a frontier run up front.** Five verbs and their tests, in a vault
  whose tooling sessions cost $4.48–$15.96 at list price, median $12.16
  ([`scripts/vault-cost.mjs`](scripts/vault-cost.mjs)) — **assumed** one or two
  such runs.
- **The vault grows a working folder.** `_Meta/housekeeping/` must join
  `vaultlib.SKIP_DIRS` (`/workspace2/_Meta/vaultlib.py:26`) or qc and the index
  will read changesets as notes, and its pre-images sync to iCloud — small, but
  the operator's quota.

## What it costs

One or two frontier runs for the script (**assumed** $12–32, the measured median and maximum of the vault's tooling sessions). Per pass the same as A:
about $0.01 idle, $0.07–0.15 working (08 §4).

## Verdict

**The recommended shape**, delivered through Option A's template and schedule,
with [Option F](07-option-f-no-debt-at-source.md) alongside it.
