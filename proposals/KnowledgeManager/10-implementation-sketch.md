# 10 — Implementation sketch

Option D as it would be built, with Option F beside it. A sketch: no code under
`src/` or in the vault is part of this proposal.

## 1. Build order

| Phase | What | Who | Gate |
|---|---|---|---|
| 0 | Option F's paragraph in Dreaming's prompt (§7) | an app run | none — worth doing whatever the spike says |
| 0 | U1: one work cycle on `claude-haiku-5-5` through the pinned CLI | operator | if it does not run, phase 3 waits for a CLI pin that names the model; 1a still proceeds |
| 1a | `_Meta/housekeeping.py` and its tests (§2) | one frontier vault task | none — its mechanical half is useful alone |
| 1b | The spike ([`11-validation.md`](11-validation.md)), in either order with 1a — it needs nothing built | the operator, on a copy | the sink criteria there |
| 3 | Template, workflow, schedule (§4) and the app's sentences (§5) | operator + a small app run | 1a built and 1b passed |
| 4 | Optional: `needsFrontier` that stops a Haiku run (§6) | an app run | the operator wants board tasks routed to it |

## 2. `_Meta/housekeeping.py`

Standard library only, like the rest of `_Meta/`, importing `vaultlib` for the
note set, frontmatter, abstracts and the 4 B/token estimate
(`/workspace2/_Meta/vaultlib.py:47`, `/workspace2/_Meta/vaultlib.py:88`,
`/workspace2/_Meta/vaultlib.py:229`) and qc.py's checks as functions rather than
its printed report — the way [`scripts/backlog-classes.py`](scripts/backlog-classes.py)
already calls them and reproduces qc's 418 findings. Everything it keeps lives
under `_Meta/.housekeeping/` as tarballs and JSON, never as `.md`, so no walker
reads it as a note (08 §3). Six verbs:

**`plan [--json]`.** Refuses to start while `_Meta/housekeeping/pending/`
holds a snapshot — it runs `verify` on that one first. Then: qc's findings per
file, `build_index.py --check`, and the stale-abstract candidates, mapped to
classes:

| Source | Class | Instruction emitted |
|---|---|---|
| `KW/case` | mechanical | lowercase the keyword |
| `CONF/ungraded` URL equal to a URL in an existing source note | mechanical | add `[[source note]]` under `## Sources` |
| a tag the Tag Index records as rejected in favour of another | mechanical | replace, dedupe, bump `updated:` |
| `KW/count`, `KW/overlap` | haiku | add, drop or replace one keyword |
| `BODY/related` ERROR on a non-Inbox note (no section, under 3, or an unexplained link) | haiku | write or explain links, candidates from `vault_search.py` |
| `LINK/orphan` on a non-Inbox note | haiku | add one explained inbound link from the named parent |
| stale-abstract candidate | haiku | confirm staleness, then rewrite the callout — or decline |
| a tag used by a note, unregistered and not rejected | haiku | append a one-line definition under the subtree |
| Inbox captures | operator | draft a triage proposal into the report |
| `BODY/related` WARN on a non-hub note | haiku, only with the operator's `--trim-related` | keep the eight links that best explain the note, with their explanations |
| `BODY/related` WARN on a `moc` or `area` note, `BODY/source` | none | not emitted: the vault keeps these by policy |
| `CONF/ungraded` otherwise, `CONF/ceiling`, anything in `_Meta/` | frontier | listed for filing, never done |

Stale-abstract candidates are heuristic and say so: an abstract stating a count
or a date range that the body's own headings no longer match (`c3d149b8`'s
"thirteen batches" against 23 `## The … batch` headings), and a note whose
size grew by more than half since the last changeset that recorded it.

Each job carries a **write set** (the files it may change), a **reading list**
— the target whole, and every linked note as `abstract-only` — and an
estimated token cost. Jobs are packed into the pass until five notes or an
estimated 40,000 tokens, whichever comes first — the room under the cliff after
the 47,363 floor and a 12,637 reserve for the pass's own overhead
([`08-comparison.md`](08-comparison.md) §3). A note over 20,000 estimated
tokens, half that budget, is packed alone; one over 40,000 gets its headings
and abstract as its reading list instead of its body. A note whose mtime is
under an hour old is skipped (C12).

**`abstract <path>`** prints one note's abstract callout and nothing else — the
cheap read the reading list points at.

**`snapshot`** writes `pending/<pass>.tgz` — every `.md` (0.5 s, 6.66 MB),
every file under `_Meta/` and `.obsidian/` — and `pending/<pass>.qc.json` (qc's
findings per file, before).

**`fix --mechanical`** applies the mechanical jobs and records them in the
pending manifest.

**`verify`** compares everything the snapshot holds with the live vault and
fails — reverting the whole pass itself, hash-guarded — on any of:

- a created or deleted file outside `_Meta/.housekeeping/` and the generated
  index (`INDEX.md`, `_Meta/index/`);
- any change under `_Meta/` or `.obsidian/` other than that generated index;
- a changed file outside the union of the pass's write sets, or more changed
  notes than the cap;
- a change to a never-list frontmatter field: `confidence`, `status`,
  `evidence`, `peer_reviewed`, `type`, `title`, `created`, `sources`;
- a change to the body **outside** the abstract callout, `## Related` and a
  hub's log section — computed by masking those regions and comparing the
  rest, so prose a claim lives in cannot change unseen;
- a qc finding on a changed file that was not there before.

On success it writes `changesets/<pass>.tgz` — the pre-images of changed files
— and `changesets/<pass>.json`, the manifest (path, before and after SHA-256,
job, one-line reason), and deletes the pending tarball. It cannot protect
itself: it runs inside the session it judges, so a session that rewrote
`housekeeping.py` or `qc.py` first could pass; the never-list forbids that, and
only Option C's out-of-session hash would catch it.

**`revert <pass> [path]`** puts a pre-image back only where the live file
still hashes to the manifest's after-hash; anything else is reported as edited
since. `plan` prunes its own changesets after twelve weeks.

No walker needs a change: qc.py skips only the directories it names
(`/workspace2/_Meta/qc.py:30`) and would read a `.md` anywhere else, which is why
nothing under `_Meta/.housekeeping/` is one. `_Meta/Vault Quality Control.md`
gains a section saying what the folder is.

## 3. The template's prompt

Short, and every step an exact command — ContinuousImprovement measured that
compliance tracks the cost of complying, and a notice naming one exact command
was copied 21 times more often than its control
(`proposals/ContinuousImprovement/README.md:43`–`:63`):

```text
You are the vault's housekeeping pass. CLAUDE.md is already in your context;
follow it, and do not open it again.
1. python3 _Meta/housekeeping.py plan --json
   If it lists no jobs, reply with its summary line and stop.
2. python3 _Meta/housekeeping.py snapshot
3. python3 _Meta/housekeeping.py fix --mechanical
4. For each job of class "haiku", in order: read only its "read" list
   (abstract-only entries with: python3 _Meta/housekeeping.py abstract "<path>"),
   make the one edit its "instruction" names with Edit, inside its "write" list,
   and bump updated:. If the job's premise is wrong, skip it and say why.
5. python3 _Meta/housekeeping.py verify
6. If verify changed anything: python3 _Meta/build_index.py
7. Reply with verify's summary and the changeset path.
Never create, move, rename or delete a file. Never change a sentence outside
the abstract callout, ## Related or a hub's log. Never open INDEX.md or a MOC
whole. Never edit anything under _Meta/ except through these commands.
```

## 4. What the operator creates

| Object | Values |
|---|---|
| Catalogue | `claude-haiku-5-5` switched on, after U1 |
| Template "Knowledge Manager" | mount `knowledgebase`, folder `""`, *This folder*, `bypassPermissions`, model `claude-haiku-5-5`, `maxRunCostUSD` 0.50, `maxIterations` 1, `maxDurationMinutes` 20, the prompt of §3 — with `--trim-related` on its `plan` line only if the operator wants non-hub Related lists trimmed |
| Workflow "Vault housekeeping" | one run block on the template; `maxInstanceCostUSD` 1 |
| Schedule | weekly, two hours after `dreamingMinutes` in `dreamingTimeZone`; every 24 hours while a trim stock remains |
| `taskboardForRuns` | on, only if the pass should file its one task (C9) |

No new app setting. The guards are the template's, enforced between cycles and
inside the CLI through `--max-budget-usd` (`src/lib/cycleInvocation.ts:1478`)
— the dollar one only once U1–U2 say the CLI prices the model.

## 5. App changes

Small, and none of them a new surface:

- `src/lib/vaultSkill.ts:316`–`:320` — "There is exactly one job in this app
  that writes here" names both writers, each told so in its own prompt.
- `docs/agent/dreaming/halves-and-write-policy.md:13`–`:15` — the "only
  setting … that authorises an unattended write" sentence says that a schedule
  whose template points at the vault is a second authorisation, made by the
  operator.
- `docs/verification/` — U1, U2 and the spike's result as *Verified* entries
  under models and metering.

No migration, no route, no page, no `globalThis` key, no clock.

## 6. The taskboard

- **Claiming: none.** A template, a run block and a schedule cannot attach a
  task (C9), and the pass's job list comes from `plan`, not the board.
- **Running a Haiku-class board task:** the operator, or the chat, proposes a
  run with the template and the task's id through `propose_run`. Completion
  validation is skipped for a run in a shared folder
  (`src/lib/validation.ts:516`–`:522`), so such a task closes on the run's own
  word; the changeset is the only evidence, and the operator should read it.
- **Filing:** at most one `create_task` per pass, for frontier or operator
  findings that are new since the last plan, after a `list_my_tasks` `query`
  for the same title. `create_task` has no `needsFrontier` field, so the pass
  cannot set it.
- **`needsFrontier` as a guard, optional.** Today it refuses a task only to a
  local run (`src/lib/tasks.ts:852`–`:861`). To make it stop a Haiku run too:
  replace `opts.localRun` with a below-frontier test —
  `provider === "local" || !isFrontierReviewModel(model)`
  (`src/lib/localCertification.ts:112`) — computed where runs are emitted
  (`src/lib/workflows.ts:8027`–`:8031`, with the model known as
  `template?.model ?? spec.decidedModel`, `src/lib/workflows.ts:642`–`:647`) and
  in `propose_run` (`src/app/api/mcp/route.ts:5720`–`:5724`, which today passes
  no option at all — a defect listed in the [README](README.md)); offer the flag
  in `release_task`'s schema to such runs (`src/app/api/mcp/route.ts:1882`–`:1902`);
  and rewrite `docs/agent/taskboard/operator-only-and-release.md:115`. Then
  "frontier" means one thing across the app.

## 7. Option F's change

`buildDreamingPrompt` (`src/lib/dreamingRun.ts:135`) gains, under "What to
write" (`src/lib/dreamingRun.ts:163`): when an item adds a batch to a hub, add
the batch's entry to that hub's log and update its abstract's count and range
in the same edit, and bump `updated:`. `src/lib/dreaming.test.ts:172`–`:185`
already pins the prompt's load-bearing sentences by regex; one more assertion
pins this one.

## 8. Tests

**Vault side** — `_Meta/tests/test_housekeeping.py`, `unittest` like its
neighbours (`/workspace2/_Meta/tests/test_retrieval.py:6`), over a fixture vault
built in a temporary directory:

- `plan` classifies one note per family as the table in §2 says, emits nothing
  for a hub's `BODY/related` WARN, and emits a non-hub one only with
  `--trim-related`;
- packing stops at five notes and at 40,000 estimated tokens, puts a note over
  20,000 alone, and gives one over 40,000 a headings-only reading list;
- `plan` refuses, and verifies first, while a pending snapshot exists;
- snapshot → edit → `verify` → `revert` restores byte-identical files;
- `verify` fails and reverts on each breach in §2, one test per breach;
- `revert` leaves a file alone when it was edited after the pass;
- `verify` fails on a changed `_Meta/*.py` and on a changed `.obsidian/` file;
- nothing `snapshot`, `verify` or `plan` writes is a `.md` file.

**App side** — the one `dreaming.test.ts` assertion (§7). If §6 is built, a
`tasks.test.ts` case per side of the below-frontier refusal: a silent failure
there is a Haiku run closing a task a local model was already refused, which is
the bar `docs/agent/testing.md` sets.

## 9. Size

`housekeeping.py` ~500–700 lines and its tests ~300 (**assumed**, by
comparison with `qc.py`'s 19,639 bytes); one or two frontier vault runs. App
side: about thirty lines of prompt, docs and one assertion; §6 another ~60 lines
and two tests.
