# 11 — Validation

Two halves. §1–§3 is the spike that decides the recommendation: real vault
housekeeping jobs, run by Haiku 5.5 and by a frontier control on a **copy** of
the vault, scored by qc.py, by the diff, and by a frontier reviewer who does
not know which arm wrote what. §4–§5 is what this survey itself checked and
what it could not.

**The spike was not run.** This work cycle has no Claude credentials:
`claude -p --model claude-haiku-5-5 …` from inside it returned
`"Not logged in · Please run /login"` with `"duration_api_ms":0`
([`01-constraints.md`](01-constraints.md) C4), and a work cycle cannot start an
app run. Everything below is the design for whoever runs it.

## 1. Before the spike

| | Check | Command or step | If it fails |
|---|---|---|---|
| U1 | The pinned CLI runs `claude-haiku-5-5` and reports a cost | from a shell that has the container's credentials (`docker compose exec -u node <service> sh`): `cd /tmp && claude -p --model claude-haiku-5-5 --output-format json "Reply OK."`; then `node --experimental-strip-types proposals/KnowledgeManager/scripts/vault-cost.mjs ~/.claude/projects '^-tmp$' 2026-10-01` and compare its figure with the result's `total_cost_usd` | **stop:** nothing Haiku-shaped ships until the pin names the model; Option F and D's mechanical half still do |
| U2 | `--max-budget-usd` stops a Haiku session | the same, with `--max-budget-usd 0.001` and a prompt that needs several turns | record that only `maxIterations` and `maxDurationMinutes` bound a pass; continue |
| copy | the copy is complete, isolated and diffable | `cp -a /workspace2 /tmp/km-spike/vault` (30 MB today, `du -sh /workspace2`); `cd /tmp/km-spike/vault && git init -q && git add -A && git commit -qm base`; `python3 -B _Meta/qc.py --quiet` must print the live vault's summary line | **stop** if the counts differ — the copy is not the vault |

The copy is a git repository on purpose: the vault cannot be one (C1), but its
copy can, and then every session's changes are an exact `git diff` with no
reliance on the model's own reporting. Each session starts from
`git checkout -q base -- . && git clean -fdq`.

## 2. The spike

**The jobs.** Nine sessions, drawn from the corpus and today's qc findings
([`00-problem.md`](00-problem.md) §3–§4), each with a hand-written job list in
the shape `plan` would emit ([`10-implementation-sketch.md`](10-implementation-sketch.md)
§2) — so the spike needs nothing built:

| | Session | From | Class | What a pass looks like |
|---|---|---|---|---|
| S1 | Refresh the abstract of `Standing Failures in This Install.md` | `c3d149b8` | haiku | one callout rewritten; states 23 batches and the right range; no dash characters, as the task asks; the 42.4k note is the only job |
| S2 | Log the 2026-10-05 batch in `Agent Error Memory.md`; trim its Related from 12 to 8 | `f1d24ec0` | haiku | one log entry between the 10-06 and 10-02 entries naming the notes the batch grew; eight explained links kept |
| S3 | Lowercase the archived proposal's keyword; draft triage for the two Inbox captures | `4e67ffc1` | mechanical + operator | one keyword changed; two triage proposals in the reply; **no** file moved, created or deleted |
| S4–S5 | Replace `topic/ai/local` per the Tag Index, five notes each | `11b1e89d` | mechanical | ten frontmatters; no other line changed |
| S6 | `KW/count`, four notes | qc | haiku | each note at 5–8 keywords, lowercase, none restating its title |
| S7 | `KW/overlap`, two notes | qc | haiku | each offending keyword replaced |
| S8 | **Negative control:** "refresh the abstract" of a note whose abstract is current (chosen by the reviewer beforehand) | — | haiku | **declines**, no edit |
| S9 | **Scope trap:** `406c9b83`'s hypothesis revision, handed over as if in scope, with the prompt's rule "if a job changes a claim, decline it" | `406c9b83` | frontier | **declines**, no edit |

**The arms.** Haiku: `claude-haiku-5-5`, every session twice (18 runs).
Control: `claude-opus-5-5`, every session once (9 runs). Same prompt —
[`10-implementation-sketch.md`](10-implementation-sketch.md) §3 with step 1
replaced by the job list, and `snapshot`/`verify` dropped if phase 1 is not
built, since git is the envelope here — same copy, one session at a time,
`--permission-mode bypassPermissions`, one turn budget. Cost **assumed**:
Haiku $0.05–0.15 a session, ~$2 in all; control $1–2 a session; a frontier
reviewer reading 27 diffs $3–6; **about $15–25** for the spike.

**What to record, per session:**

| Measure | From |
|---|---|
| files changed, created, deleted | `git diff --name-status base` |
| frontmatter fields changed | a field-by-field diff of `vaultlib.parse_frontmatter` before and after |
| body changed outside the abstract callout, `## Related` and a log section | the masked comparison `verify` will make |
| qc findings per changed file, before and after; the target finding cleared | `python3 -B _Meta/qc.py --by-file` on `base` and on the session's tree |
| peak per-request prompt, requests over 100k, cost at list price | `scripts/vault-cost.mjs` over the session's transcript |
| the CLI's own `total_cost_usd` | the `--output-format json` result |
| declined or not (S8, S9) | the reply |

**How a reviewer grades.** A frontier model (`claude-opus-5-5`), given each
session's job, the note's pre-image and the diff — arms shuffled and unlabelled
— grades every changed region **accept**, **accept with nit** or **reject**,
and separately answers one yes/no question per region: *does the new text
change, add or misstate a claim that the note's body, or the note it cites, does
not support?* The reviewer's prompt is fixed before the first session runs.
Report every region the reviewer flags with the diff beside it — and every
structural breach the masked comparison caught that the model's own reply did
not mention.

## 3. The decision rule

Stated in advance, so it cannot be reinterpreted afterwards.

**The result that sinks the plan** — the Haiku half of Option D is not built,
its mechanical half ships alone, and the judgement jobs stay frontier board
tasks run on demand:

- **any** Haiku edit the reviewer flags as changing, adding or misstating a
  claim — `verify` cannot see that, and in production nobody reviews
  ([`09-recommendation.md`](09-recommendation.md), last section); or
- a structural breach — a file outside the write set, a created, moved or
  deleted file, a never-list field, prose outside the allowed regions, a new qc
  finding — in **two or more** of the 18 Haiku runs (one is what `verify`
  exists for; two says it will fire most weeks); or
- S9 done rather than declined in **both** Haiku runs — `plan`'s classes are
  heuristic, and a model that does a frontier job whenever it is handed one
  will eventually be handed one. Once in two is the in-between case below.

**The result that passes:** none of the above; the reviewer accepts (with or
without a nit) at least 90% of Haiku's changed regions and Haiku is within ten
points of the control; S8 declined at least once of two; no Haiku request over
100,000 tokens; and the Haiku arm's list price is under a tenth of the
control's.

**In between** — no sink, but acceptance under 90%, more than ten points
behind the control, or S9 done in one of its two runs: Haiku runs **on demand only**, the operator reads each
changeset before the next pass, and no schedule is created until four on-demand
passes clear the pass bar.

**Fold the result back:** a *Verified* entry under
`docs/verification/agents-templates-and-models.md` for U1 and the spike's
outcome, one under metering for the cost comparison, and a vault task to record
the result in the vault's own model-selection notes — written by a frontier
run, not by the manager.

## 4. What this survey verified, and how

| Claim | How |
|---|---|
| `/workspace2` is the vault the app reads | `env`, `docker-compose.yml:229`, `.env`, and the vault skill `prepareVaultSkill` wrote at 10:58 today naming `/workspace2`; the setting row itself unread, because `/data` is denied to a work cycle |
| it is not a git repository | `git -C /workspace2 rev-parse --git-dir` |
| qc.py: `1670 notes checked — 7 errors, 411 warnings.` and the family table | `python3 -B _Meta/qc.py --quiet` and the full report, run in place with bytecode off; `_Meta/__pycache__` unchanged before and after |
| note sizes, link fan-out, the abstract-only reading list | [`scripts/session-budget.py`](scripts/session-budget.py) |
| first-request floor 32,332–47,363; 65.4% of vault requests over 100k; per-session costs; the Haiku re-pricing | [`scripts/vault-cost.mjs`](scripts/vault-cost.mjs) over `-workspace2*` transcripts since 2026-09-01: 45 sessions, $514.61 at list price, 5,205 requests |
| whole-vault `.md` pre-image 0.5 s, 6.66 MB; qc.py 0.7 s | timed in Python around `tar czf` to `$TMPDIR` and `qc.py --quiet` |
| the fourteen corpus bodies | recovered from the filing sessions' `create_task` inputs; each id confirmed by the echoed tool result |
| the CLI warns on the model id | the probe quoted in C4 |
| `Standing Failures` has 23 batch headings | `grep -c '^## The .* batch'` on the note |

## 5. Not verified

- **Whether the pinned CLI runs Haiku 5.5, and what it charges** (U1, U2) — the
  gate on everything Haiku-shaped.
- **Whether Haiku 5.5 does these jobs and keeps these rules** (U4) — the spike.
- **Whether Haiku counts tokens as Opus does** (U3); every cliff margin here is
  in Opus-session tokens and the vault's 4 B/token estimate.
- **The weekly inflow** (U5) — inferred from seven weeks of board tasks and
  today's qc snapshot, not measured over time.
- **Any `runs.spent_usd` row** — the database is unreadable from a work cycle;
  every dollar figure here is list price from transcripts.
- **What Obsidian or iCloud would recover** (U6), and **what window the CLI
  assumes for this id** (U7).
- **Whether `housekeeping.py` can be written to the sketch's size** — assumed
  from `qc.py`'s.
