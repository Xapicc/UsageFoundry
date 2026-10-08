# 00 — The problem, and what the housekeeping actually is

## 1. The question

The operator wants a **Knowledge Manager**: an agent on Claude Haiku 5.5
(`claude-haiku-5-5`) that does routine housekeeping in the knowledge vault this
app is connected to, because Haiku is cheap and fast. This survey asks which
housekeeping jobs it should do, in what form this app should run it, how its
writes are kept safe, what it costs, and how we would know Haiku 5.5 is good
enough — and tests the premise that there is a body of routine vault work a
cheap model can take off the frontier models.

All measurements are from 2026-10-08 against `1957ee87`, read-only on the
vault.

## 2. Which vault, and what kind of store it is

**The vault is `/workspace2`.** `/knowledge` finds its vault through
`resolveKnowledgeRoot` (`src/lib/knowledge.ts:241`), which looks up the
`knowledgeBaseMountId` setting among the mounts in `WORKSPACE_ROOTS` and never
adds one. The compose file maps the second mount slot to `/workspace2`
(`docker-compose.yml:229`, `docker-compose.yml:472`), `.env` names it
`KnowledgeBase` and points it at the operator's iCloud folder
`…/CloudDocs/Documents/Projects/Knowledge Vault`, and the live environment reads
`WORKSPACE_ROOTS=Github=/workspace|KnowledgeBase=/workspace2|…` (`env | grep
WORKSPACE_ROOTS`). The setting itself lives in the database under `/data`,
which a work cycle cannot read, so the binding is confirmed indirectly: the
vault skill that `prepareVaultSkill` regenerated at 10:58 today from the same
`resolveKnowledgeRoot` call (`src/lib/vaultSkill.ts:405`) names "the knowledge
vault at KnowledgeBase" and `/workspace2` as its path. **Assumed** that the
setting did not change after 10:58.

**It is not a git repository.** `git -C /workspace2 rev-parse --git-dir`
prints `fatal: not a git repository (or any parent up to mount point /)`, and
there is no `.git`. `/proc/self/mountinfo` shows it as a `fuseblk` mount of the
host's iCloud folder.

**It is big, and two of its notes do not fit under Haiku's price cliff.**
[`scripts/session-budget.py`](scripts/session-budget.py), which uses the
vault's own `vaultlib.collect()` definition of a note and its ~4 bytes/token
estimate (`/workspace2/_Meta/vaultlib.py:42`), measures:

| | estimated tokens |
|---|---:|
| all 1,670 notes | 4,226,212 |
| median note / p90 / p99 | 1,968 / 3,855 / 10,860 |
| `Questions MOC.md` (largest) | 82,823 |
| `Sources MOC.md` | 77,820 |
| `Standing Failures in This Install.md` | 42,411 |
| `Agent Error Memory.md` | 28,112 |
| `_Meta/Tag Index.md` | 23,051 |
| `CLAUDE.md` + `AGENTS.md` | 5,308 + 8,512 |
| `INDEX.md` | 948,134 |
| a note **plus every note it links to**, median / p90 | 93,696 / 116,173 |
| a note **plus the abstracts of** every note it links to, median / p99 | 2,549 / 14,624 |

The second-to-last row is the design constraint that matters most: the median
note links to something large — usually a MOC — so a session that follows a
note's links by reading whole notes is at the cliff before it has written a
word. Reading neighbours' *abstracts* instead (what `vault_search.py` and
`AGENTS.md`'s retrieval path return) keeps the p99 job at under 15k.

## 3. The housekeeping backlog, measured

`python3 _Meta/qc.py --quiet` from `/workspace2` prints
**`1670 notes checked — 7 errors, 411 warnings.`** — the same as the figure in
the brief. qc.py has no `--fix` mode; its only output is a report
(`/workspace2/_Meta/qc.py:427` for its flags). Broken down by check family
and class by [`scripts/backlog-classes.py`](scripts/backlog-classes.py), which
runs qc.py's own checks in-process and reproduces its 418 findings exactly:

| Family | ERR | WARN | What fixing it takes | Class |
|---|---:|---:|---|---|
| `CONF/ungraded` | 0 | 160 | 317 cited URLs with no source note. **22 of them** (in 21 notes) already have a source note the citing note does not link, and adding the wikilinks clears **8** notes outright; the rest need source notes written — fetch, read, grade | 8: (a) · 152: (c) |
| `BODY/source` | 0 | 146 | a source note with no `> [!quote]` — needs the source re-read. The vault reports these and deliberately does not correct them (`/workspace2/_Meta/Vault Quality Control.md:82`) | (c), left by policy |
| `BODY/related` | 2 | 94 | Related lists over 8 links. **9** are on `moc` or `area` notes — hubs, which the vault keeps over 8 on purpose: "Trimming real connections to satisfy a range would damage the graph" (`/workspace2/_Meta/Vault Quality Control.md:83`). The other **85** are on ordinary notes (57 concept, 13 question, 7 reference, 7 source, 1 project), where the rulebook's range is 3–8 (`/workspace2/CLAUDE.md:96`) and the vault calls a WARN "a judgement call: a human should look" (`/workspace2/_Meta/Vault Quality Control.md:34`) — `f1d24ec0` asks for one such trim. The 2 ERRORs are Inbox captures | 9: left by policy · 85: (b), on the operator's say-so · ERR: Inbox |
| `KW/count` | 0 | 4 | add or drop a keyword; one of the six keyword findings is on an Inbox capture | (b) |
| `SEED/parent` | 0 | 4 | all four are Inbox captures, which carry `captured_from`, not `seeded_by` | Inbox |
| `KW/overlap` | 0 | 2 | replace a keyword that restates the title | (b) |
| `LINK/orphan` | 2 | 0 | both are Inbox captures | Inbox |
| `LINK/sparse` | 2 | 0 | both are Inbox captures | Inbox |
| `CONF/ceiling` | 0 | 1 | a `confidence` above what its sources license — changing a grade | (c) |
| `KW/case` | 1 | 0 | lowercase one keyword in an archived proposal summary | (a) |

(a) mechanical — a script with no model; (b) Haiku-suitable judgement;
(c) needs a frontier model; "Inbox" is triage, below. Every other family —
`FM/*`, `TAG/*`, `LINK/broken`, `MOC/*`, `SEED/conf|why|grow`, `PATH/*` —
returns zero.

**Six of the seven ERRORs are two Inbox captures dated 2026-09-26.** The
Inbox's capture template has no `## Related` and no links by design, so every
untriaged capture is three ERRORs and qc.py exits 1 until somebody triages it.
Triage is defined by the vault as promote (which **moves** the file),
fold in (which **deletes** the capture) or delete
(`/workspace2/3 Resources/Questions/Inbox/Questions Inbox.md:32`–`:34`), and
moving or renaming "needs confirmation because it breaks links"
(`/workspace2/CLAUDE.md:271`). So every Inbox outcome is a move or a delete,
and a manager may prepare it but not do it.

**Totals by class, of 418 findings** ([`scripts/backlog-classes.py`](scripts/backlog-classes.py)'s last block):
**9 mechanical** (one `KW/case`, eight `CONF/ungraded` notes a wikilink
clears), **5 Haiku-suitable** (keyword fixes), **85 Haiku-sized trims that only
the operator can ask for**, 11 Inbox findings on four captures (Haiku can draft
the triage; the move or delete is the operator's), 155 kept by the vault's own
policy, and 153 findings of research debt (source notes not yet written, one
confidence grade).

**What qc.py cannot see.** Stale abstracts and `updated:` dates, a hub whose
log is a batch behind, and drift in the rulebooks themselves. The vault
investigation found the last kind in the files every agent reads first:
`/workspace2/CLAUDE.md:256` puts `INDEX.md` at ~130k estimated tokens and
`_Meta/index/README.md` tells its readers ~110k — a figure hard-coded at
`/workspace2/_Meta/build_index.py:211` — while `INDEX.md`'s own header says
~950k; `AGENTS.md` says 1,083 notes and 21 domains against 1,670 and 24. Those are listed under
"Found on the way" in the [README](README.md); fixing a rulebook is not
housekeeping a manager should do (§5).

## 4. The board's vault tasks, classified

Fourteen open tasks filed against `/workspace2` by earlier runs are the real
examples of the work. A work cycle cannot read them with `get_my_task` (it
reads only the run's own folder), so their full bodies were recovered from the
`create_task` calls in the filing sessions' transcripts under
`/home/node/.claude/projects/-workspace2/`, each confirmed by the tool result
echoing the task id. None was worked, claimed or commented on. Every one was
filed with `priority` only — none carries `needsFrontier` or `operatorOnly`.

| Task | Filed by | Class | Reason |
|---|---|---|---|
| `4e67ffc1` Clear the seven qc.py ERRORs in Questions/Inbox and one archived proposal | Dreaming, 10-08 | **(b)** | `KW/case` is (a); promoting the two captures — explained Related links, an inbound link, `seeded_by` — is Haiku-sized, but the move is the operator's, and the alternative route (exempt the Inbox in qc.py) is a convention change, (c) |
| `11b1e89d` Resolve `topic/ai/local`: rejected in Tag Index, used on ten notes | research run, 09-26 | **(a)** | the Tag Index already records the decision — rejected in favour of `topic/ai/serving` — so applying it is a replace in frontmatter plus `updated:`; *reversing* it would be (c). The brief says ten notes; twelve carry the tag today, two of them Inbox captures, which stay the operator's (`grep -rlE 'topic/ai/local([^/a-z-]\|$)' --include='*.md'` over the vault, outside `_Meta/`) |
| `c3d149b8` Refresh the stale abstract of Standing Failures in This Install | Dreaming, 09-30 | **(b)** | summarise the note's own body into one callout; the batch count (the brief says nineteen, the note now has 23 `## The … batch` headings) is a grep. The note is 42.4k tokens, so it must be the only job in its session |
| `f1d24ec0` Log the 2026-10-05 batch in Agent Error Memory and trim its Related | Dreaming, 10-06 | **(b)** | transcribe a batch already in the vault into one log entry, and pick 8 of 12 Related links; no claim changes |
| `c4e57ba2` Record the no-extension-capable-browser limit in Standing Failures | research run, 09-19 | **(c)** | adds a new section of operational claims to the install's failure inventory, and the brief asks for a re-check in the sandbox |
| `1c68d363` Reprice vault cost arithmetic for Claude Opus 5.5 | research run, 09-25 | **(c)** | changes cost figures across four to six notes and requires re-reading the live pricing page |
| `406c9b83` Revise the sandbox mount-race seed | Dreaming, 09-22 | **(c)** | narrows a hypothesis — a claim change |
| `a3bfd638` Fold the LocalModelOffload tool-uptake trial into the offload notes | research run, 09-26 | **(c)** | weakens a recommendation with outside evidence and grows a seed (its path for `Local Offload Economics.md` is also wrong) |
| `3b785e45` Revise LocalModelOffload C6 against the vault's concurrency note | research run, 09-26 | **(c)** | edits a design document in another repository, not the vault |
| `01660a3e` qc.py false `CONF/ungraded` warning for DOIs with parentheses | research run, 09-19 | **(c)** | a code change to qc.py — the manager's own judge, which it must never edit (§5) |
| `e0f52414` pdftext.py and Form XObjects | research run, 09-19 | **(c)** | parser code, needs a network fetch to accept |
| `b93706a7` pdftext.py drops digits without `/ToUnicode` | research run, 09-19 | **(c)** | parser code |
| `f0f7215a` Decide whether the installed Interface Copy rule should change | research run, 09-19 | **(d)** | a policy decision on a rule copied into `~/.claude/rules/`; its own filing calls it the operator's call |
| `c84aec9c` Re-run Dockrac's Milestone 1 reclaim measurement | research run, 09-19 | **(d)** | needs a quiet physical Mac and operator consent for the pressure arm |

**One mechanical, three Haiku, eight frontier, two operator.** The three
Haiku-class tasks were all filed by Dreaming nights, and two of them
(`c3d149b8`, `f1d24ec0`) are upkeep of the hub notes Dreaming itself grows
every night — the batch it just wrote, not yet logged; the abstract its batches
outgrew. Dreaming already edits those hubs on its nightly pass (`git show
a74a1bb:"proposals/implemented - Dreaming/10-the-write-path.md"`, and the
transcripts the Dreaming investigation read), so the cheapest fix for that kind
is in Dreaming's own prompt (`src/lib/dreamingRun.ts:163`–`:205`), not in a
second writer — see [Option F](07-option-f-no-debt-at-source.md).

Two pairs collide if worked in parallel: `c3d149b8` and `c4e57ba2` both edit
`Standing Failures in This Install.md`; `11b1e89d` and `a3bfd638` both touch
`Local Offload Economics.md`.

## 5. The scope this survey settles

Grounded in §3 and §4, the work splits three ways, plus a list that belongs to
nobody but the operator.

**Deterministic — no model.**
- Regenerate the index when `python3 _Meta/build_index.py --check` says it is
  stale (it printed `Index is current — 30 artefacts, 1670 notes.` today).
- `KW/case`: lowercase a keyword.
- Apply a decision the Tag Index already records (`11b1e89d`): replace a
  rejected tag with its named replacement, dedupe, bump `updated:`.
- Link a cited URL to the source note that already holds it (22 URLs today,
  clearing eight notes' WARN): the match is URL equality; the link goes in
  `## Sources`.
- Bump `updated:` on every file any job touched (`/workspace2/CLAUDE.md:66`).
- Produce the job list itself: qc.py's findings, `build_index.py --check`, the
  app's own orphan and broken-link counts (`src/lib/knowledge.ts:1667`), and
  stale-abstract candidates by heuristic (an abstract that states a count
  the body no longer matches, a note grown by more than a set fraction since
  its `updated:`).
- Report, never act on: what sits in `_to_delete/` (two `.tgz` files and one
  8-byte note, untouched since August, `ls -la /workspace2/_to_delete`) and the
  non-vault clutter at the root (`uf-c3-base/`, `throughput.pid`). Deleting from
  the mount is a person's job: "an app that deleted from a mount it does not own
  would be doing something heavier than anything else in this codebase"
  (`docs/agent/dreaming/the-ledger.md:14`–`:15`).

**Haiku-suitable judgement — in-place edits to existing notes only.**
- Refresh a stale `> [!abstract]` and bump `updated:` (`c3d149b8`).
- `## Related` upkeep on non-hub notes: explain an unexplained link, add
  explained links to a sparse note from `vault_search.py` candidates, and trim a
  list over eight — but only once the operator has said trims are wanted
  (`f1d24ec0` asks for one; 85 qualify today). Hubs over 8 are left, by the
  vault's policy.
- Keyword fixes: `KW/count`, `KW/overlap`.
- Orphan linking: add one explained inbound link from the obvious parent.
- Log a batch the vault already records into the hub's log (`f1d24ec0`).
- **Draft** Inbox triage — which route, and the Related links a promotion would
  carry — as a proposal the operator approves; never the move.
- Register a new tag under an existing subtree with a one-line definition, when
  a note already uses it and the Tag Index has not rejected it.

**Frontier-only.** Anything that changes a claim, a `confidence`, a seed's
status or a hypothesis; merging or splitting notes; writing a source note
(`CONF/ungraded`'s 295 URLs and `BODY/source`'s quotes — reading and grading a
source is research, and "grading a source on its venue is not the same as
appraising it", `/workspace2/_Meta/Vault Quality Control.md:73`); reversing a
recorded Tag Index decision; any change to `_Meta/*.py`.

**The operator's, always.** Moves, renames and deletes (`/workspace2/CLAUDE.md:271`);
Inbox outcomes; conventions such as whether qc.py exempts the Inbox; the
rulebooks (`CLAUDE.md`, `AGENTS.md`, and `2 Areas/Engineering Standards/`, whose
notes are installed into `~/.claude/rules/` and load in every session,
`/workspace2/AGENTS.md:102`).

## 6. What this does to the premise

**The premise holds for the price, and for the volume only on one operator
decision.** Haiku 5.5 is cheap enough that cost is not the question: the one
past housekeeping session that fixed eleven qc ERRORs cost $3.54 on Opus 5 and
would have cost $0.07 on Haiku 5.5 with the same tokens
([`08-comparison.md`](08-comparison.md) §4). But the Haiku-class work the vault
already treats as wrong is small: 5 qc findings, four Inbox captures to draft
since 2026-08-16, three board tasks filed between 2026-09-30 and 10-08 — two of
them upkeep Dreaming leaves on its own hubs — and an unmeasured trickle of stale
abstracts. The one large Haiku-sized stock is the **85 non-hub Related lists
over eight links**, which the vault reports as a judgement call rather than an
error; that count rose from 9 at the 2026-08-11 pass over 265 notes
(`/workspace2/_Meta/Vault Quality Control.md:83`) to 94 over 1,670 today, which
is about ten a week — though as much from the vault's growth as from neglect.
Whether those are trimmed is the operator's call, and it decides whether the
manager has a few jobs a week or a couple of sessions' worth. The rest of the
backlog is research debt that needs a frontier model reading sources, and WARNs
the vault keeps on purpose.

So the question this survey answers is not "how do we run a nightly Haiku
manager over a large backlog" but **"what is the least machinery that gets a
few to a dozen jobs a week done safely by a cheap model, in a store with no
undo"** — and whether the answer is a manager at all.
