# 01 — Constraints

Line numbers are pinned against `1957ee87` on 2026-10-08. Part 1 is what holds;
Part 2 is what is unknown and the command that settles each.

## Part 1 — what holds

### C1. The vault has no undo, and a run in it gets none of the app's.

`/workspace2` is not a repository (`git -C /workspace2 rev-parse --git-dir` →
`fatal: not a git repository`). A run there gets isolation mode `none` with the
reason "Not a git repository — runs here are serialised"
(`src/lib/orchestrator.ts:2993`–`:2994`, returned through `probeIsolation` at
`src/lib/orchestrator.ts:2891`–`:2893`), and `git init` would not help, because
a repository that is the mount root has "no place to put a checkout inside it"
(`src/lib/orchestrator.ts:2947`–`:2952`). Everything downstream of a branch is
then absent:

| Step | For a run in the vault |
|---|---|
| Diff | "nothing to diff" (`src/lib/diff.ts:686`–`:689`) |
| Review | `nothingToReview` (`src/lib/review.ts:328`–`:336`) |
| Land | `landState` returns null (`src/lib/land.ts:563`–`:566`) |
| Completion validation | skipped for a run in a shared folder (`src/lib/validation.ts:516`–`:522`) |
| Undo | "no history, no author field … a store with no undo" (`docs/agent/dreaming/the-ledger.md:8`–`:15`) |

The vault adds none of its own: no `.trash/`, no backup or git plugin (only
`dataview` and `templater-obsidian` in `.obsidian/community-plugins.json`), and
no snapshot convention in `CLAUDE.md`, `AGENTS.md` or `_Meta/`. Obsidian's core
File Recovery plugin is enabled (`.obsidian/core-plugins.json`), but its
snapshots live in Obsidian's application data on the Mac, and whether it
captures an edit made outside Obsidian is **assumed** not (U6).

### C2. Nothing but the prompt bounds where a vault run writes.

Dreaming's own design records this: "the prompt is the enforcement", there is
no path-based write restriction, and a `PreToolUse` deny hook "is the only
mechanism that would" and does not exist (`docs/agent/dreaming/the-writer.md:23`–`:35`;
`src/lib/settings.ts:901`–`:903`). The record of what a run touched is the
touch scan over its tool calls (`src/lib/runTouchScan.ts:61`–`:83`), which
needs no git — but a touch is an attempt with no content and no success mark,
and an edit made through Bash (`sed -i`, a Python script) is not named at all
(`docs/agent/git-and-review/touched-versus-changed.md:7`). Run events are swept
after 30 days (`src/lib/settings.ts:1149`).

### C3. Haiku 5.5 pays five times per token on any request whose prompt passes 100,000.

`claude-haiku-5-5` is $0.10 input / $0.50 output per million tokens, and
$0.50 / $2.50 above a 100,000-token prompt (`src/lib/pricing.ts:167`–`:171`).
Cache reads and writes scale off the tier's input rate (0.1×, 1.25×, 2×;
`src/lib/pricing.ts:35`–`:37`), so a cache read is $0.01 or $0.05. The prompt is
`input + cache read + cache creation` (`src/lib/pricing.ts:470`–`:472`); the
tier is chosen per request and the boundary is strict
(`src/lib/pricing.ts:507`–`:519`); over it, **every** token class in that
request pays the higher rate, output included. No other Claude model in the
table has a step (`src/lib/pricing.ts:259`–`:263`).

Where a session starts matters as much as what it reads. Across the 44 vault
sessions with requests since 2026-09-01, the **first** request was already
32,332–47,363 tokens — system prompt, tool schemas and, **assumed**, the
`CLAUDE.md` the CLI loads from the working directory — and 42 of them crossed
100,000 somewhere between their 8th and 79th main-loop request; 3,405 of 5,205
requests (65.4%) were over it (`prompt first=` and `first at main #` in
[`scripts/vault-cost.mjs`](scripts/vault-cost.mjs)'s output). The two that
never crossed are the housekeeping sessions; the larger peaked at 84,670.

So after a 47k floor there is **~53k of room**, and the pass's own plan,
command output and replies take some of it before any note is read — the one
housekeeping session's prompt grew by ~50k over 57 requests. At the vault's p90
note (3,855 tokens) read once and written once, the full room holds six notes,
and at the median thirteen (`python3 -B scripts/session-budget.py /workspace2 47363`);
[`08-comparison.md`](08-comparison.md) §3 reserves part of it and caps a session
at five. The two MOCs (82.8k and 77.8k) cannot be read whole by any Haiku
session under the cliff, and `Standing Failures in This Install.md` (42.4k)
fits once, with almost nothing beside it.

### C4. The pinned CLI does not know `claude-haiku-5-5`, and the app's spend comes from the CLI.

`claude-haiku-5-5` is priced and labelled but **off** in the seeded model
catalogue, because the pinned 2.1.280 binary contains no `haiku-5-5` string
(`src/lib/modelCatalogue.ts:163`–`:167`, `ENABLED_ON_SEED` at
`src/lib/modelCatalogue.ts:168`). A probe from this work cycle,
`claude -p --model claude-haiku-5-5 --output-format json "Reply with the single word OK."`,
printed `[claude-code:unrecognized_model] {"model":"claude-haiku-5-5","query_source":"sdk"}`
and then `"result":"Not logged in · Please run /login"` with
`"duration_api_ms":0` — the CLI warns about the id, and this sandbox has no
credentials, so the API was never reached (U1).

That matters twice. A run's recorded spend is the CLI's own `total_cost_usd`,
"money this app did not compute" (`src/lib/orchestrator.ts:9566`,
`src/lib/orchestrator.ts:7684`), and the in-CLI cap is `--max-budget-usd`
computed from it (`src/lib/cycleInvocation.ts:1478`–`:1483`). If the CLI prices
an id it does not know at zero or at a default, both the record and the cap are
wrong (U1, U2). The cycle cap, `maxIterations`, is the only guard that does not
depend on it.

The catalogue switch does not reach a workflow. `modelRefusal` is called at
`src/app/api/runs/route.ts:351`, at `save_template` and `propose_run`
(`src/app/api/mcp/route.ts:5148`, `src/app/api/mcp/route.ts:5688`) and in
`src/lib/modelDecider.ts:123`, and not once in `workflows.ts`
(`grep -c modelRefusal src/lib/workflows.ts` → 0), so a template saved with a
disabled model runs from a workflow or schedule while the run form refuses it.

### C5. Dreaming is already the vault's writer, and owns its ledger and its clock.

Dreaming's writer is an ordinary run in the vault root, unisolated, under
`bypassPermissions`, capped at `dreamingMaxCostUSD` ($2), six cycles and 90
minutes (`src/lib/dreamingRun.ts:370`–`:397`). Its ledger is two tables,
`dreaming_notes` keyed on an **error signature** and `dreaming_nights` keyed on
a night (`src/lib/db.ts:2462`–`:2481`, `src/lib/db.ts:2501`–`:2515`); a job with
no signature has no row to write. Its overlap guard refuses while any run with
`origin_ref LIKE 'dreaming:%'` is live (`src/lib/dreamingRun.ts:264`–`:275`),
so it would not see a Knowledge Manager run. Its "Forget" deletes a ledger row,
never a file, and a recorded note that has moved shows as deleted
(`src/lib/dreamingLedger.ts:148`–`:161`, `src/lib/dreamingLedger.ts:236`–`:262`)
— a manager that moved or renamed a Dreaming note would forge a retraction.

Two sentences in the app become false the day a second writer exists: "the
only setting in this app that authorises an unattended write into a store this
app does not own" (`docs/agent/dreaming/halves-and-write-policy.md:13`–`:15`), and
the vault skill's "There is exactly one job in this app that writes here"
(`src/lib/vaultSkill.ts:316`).

### C6. Runs in the vault take turns, and one at the root holds all of it.

A plain folder has no repository to branch from, so a second run on it is
queued (`docs/runs.md:518`–`:521`), and "a run started on the whole workspace
holds every folder inside it" (`docs/runs.md:534`–`:535`). A manager run at
`/workspace2` therefore queues behind Dreaming's 03:04 run and every vault
research run, and they behind it — serialisation for free, and contention when
a research run is long. A paused run gives up its folder
(`src/lib/orchestrator.ts:4036`–`:4045`).

### C7. What the app's primitives can do today.

- **A schedule starts a workflow and nothing else**, one schedule per workflow
  (`src/lib/schedules.ts:1028`, `src/lib/db.ts:679`–`:681`), every N hours,
  daily or weekly — no cron (`src/lib/schedules.ts:53`–`:68`) — and only a
  workflow with a workflow-wide limit (`src/lib/schedules.ts:537`–`:547`). A
  missed window is not made up; an overlapping fire is skipped
  (`docs/workflows.md:742`–`:753`).
- **Five block kinds, none of which runs a command without a model**
  (`src/lib/apiTypes.ts:2172`; `docs/workflows.md:44`–`:60`). The review block
  cannot review a non-git run (`src/lib/workflows.ts:7566`–`:7575`).
- **A template pins the model**; run beats template beats `defaultModel`, and an
  agent's model only fills a gap (`src/lib/templates.ts:47`–`:50`). A block has
  no model field and takes its template's (`src/lib/workflows.ts:542`).
- **Nothing reacts to a file change or to what a run wrote**: webhooks are
  outbound only (`src/lib/notify.ts:16`), and a task link "is a record
  rather than a trigger" (`docs/agent/taskboard/runs-from-tasks.md:103`–`:117`).
  Run dependencies (`on-success`, `on-finish`) exist
  (`src/lib/orchestrator.ts:5172`).

### C8. `needsFrontier` gates local runs only, and "frontier" excludes Haiku.

The flag is set by a review block setting a branch aside, by a local run's
`release_task`, or by the operator, and only the operator clears it
(`src/lib/tasks.ts:527`–`:545`). It is read in one place that refuses anything:
`readTaskLinks`, and only when `opts.localRun` is set
(`src/lib/tasks.ts:852`–`:861`), which only a local orchestrator block sets
(`src/lib/workflows.ts:8027`–`:8031`). "It gates nothing but local-model runs …
and a Claude or Codex run may still take it on"
(`docs/agent/taskboard/operator-only-and-release.md:115`). A Haiku run is
provider `claude`, so nothing stops it — and `isFrontierReviewModel` already
says Haiku is not frontier (`src/lib/localCertification.ts:112`–`:116`). The flag
means "a local model failed this", not "too hard for a cheap model"; none of the
fourteen corpus tasks carries it.

### C9. A run's board access is narrow, and off by default.

`taskboardForRuns` ships `false` (`src/lib/settings.ts:1138`). With it on, a
work cycle gets `list_my_tasks`, `get_my_task`, `complete_task`,
`release_task`, `create_task`, `comment_on_task`, `add_task_dependency`, and no
`list_tasks` (`docs/agent/taskboard/mcp-surface.md:56`–`:61`). Only a chat's
`propose_run` and an orchestrator block's `emit_runs` can attach tasks to a
run; run blocks, templates, schedules and `POST /api/runs` cannot. A run sees
open tasks whose folder equals its own exactly (`src/lib/tasks.ts:1737`).

### C10. The app does not write the vault, and must not run the vault's code.

`knowledge.ts` is read-only "end to end" because "a background index that can
write into it is one that can lose somebody's paragraph while they are typing
it" (`src/lib/knowledge.ts:40`–`:45`); KnowledgeSection's C1 refused any write
path or Fix button in `/knowledge` (`git show
a74a1bb:"proposals/implemented - KnowledgeSection/01-constraints.md"`, lines
12–32). Every vault write so far is a run's. A second reason binds harder: the
vault's scripts are files any vault run can rewrite, so an app server that
executed `_Meta/qc.py` itself would be running run-writable code outside the
sandbox, with the server's environment. Vault tooling runs inside a run's
sandbox or not at all. And the app does not invent a schema for "somebody
else's vault" (`src/lib/knowledge.ts:1662`–`:1665`): qc.py is the vault's
definition of wrong, not the app's.

### C11. The vault's own rules bind any writer.

`updated:` changes on every edit (`/workspace2/CLAUDE.md:66`); a new tag goes
into the Tag Index in the same edit (`/workspace2/CLAUDE.md:85`); `## Related`
carries 3–8 explained links (`/workspace2/CLAUDE.md:96`); a note's confidence
may not exceed its evidence (`/workspace2/CLAUDE.md:155`); a bad seed is
archived, never deleted (`/workspace2/CLAUDE.md:198`); moving or renaming needs
confirmation (`/workspace2/CLAUDE.md:271`); every session ends by regenerating
the index (`/workspace2/CLAUDE.md:281`). A session that has not read
`CLAUDE.md` may write only an Inbox capture (`/workspace2/AGENTS.md:115`). Bulk
reads may trigger iCloud downloads (`/workspace2/AGENTS.md:26`) — though
qc.py already reads every note in 0.7 s here (`time` around
`python3 -B _Meta/qc.py --quiet`).

### C12. Somebody else is usually writing too.

The operator edits in Obsidian on the Mac and the edit arrives by iCloud;
Dreaming writes between 03:04 and about 03:20 UTC on nights with qualifying
signatures — 18 Dreaming sessions between 2026-09-09 and 10-08
([`scripts/vault-cost.mjs`](scripts/vault-cost.mjs)) — and all eight notes
modified in the last day, and 12 of the last week's 15, are in
`1 Projects/Agent Error Memory/` between those times (`find /workspace2 -name
'*.md' -mtime -1`, then `-mtime -7`); research runs write over sessions of 92
to 431 requests (the same script). Any write a manager makes is to a file that may
have changed since it read it. iCloud's conflict behaviour on a simultaneous
edit is **assumed** to keep one side and file the other as a conflict copy.

## Part 2 — unknowns

| | Unknown | Would change | Settles it |
|---|---|---|---|
| U1 | Does the pinned CLI 2.1.280 run `--model claude-haiku-5-5` against the API, and what `total_cost_usd` does it report? | everything: if it does not run, nothing here ships until the pin moves; if it reports zero, `spent_usd` and the per-run cap are blind | one work cycle from a template pinned to the model (the catalogue switch on), a one-line prompt; compare `result.total_cost_usd` with `node --experimental-strip-types scripts/vault-cost.mjs` over the same session |
| U2 | Does `--max-budget-usd` stop a Haiku session at the right dollar figure? | whether `maxRunCostUSD` bounds a pass, or only `maxIterations` does | the same run with `maxRunCostUSD` at $0.01 and a task that needs more; read where it stopped |
| U3 | Does Haiku 5.5 count the same text as the same number of tokens as Opus? | every cliff margin in C3, which are measured in Opus-session tokens and the vault's 4 B/token estimate | `POST /v1/messages/count_tokens` on three notes for both models (needs an API key, which no work cycle has) |
| U4 | Does Haiku 5.5 follow the write rules and do the jobs well? | the recommendation | the spike in [`11-validation.md`](11-validation.md) |
| U5 | How many Haiku-class jobs arrive per week? | the trigger and the cap | the planner's `--plan` output, recorded weekly for four weeks |
| U6 | Does Obsidian's File Recovery, or iCloud, keep a prior version of a file edited from outside Obsidian? | whether the design's own pre-images are the only undo | on the Mac: edit a scratch note from a shell, then look for it in Settings → File recovery and in iCloud.com's version history |
| U7 | Does the CLI treat an unknown `claude-` id as a 200,000-token window? For an id it does not know it "assumes 200,000 tokens and compacts 33,000 short of that", and `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is honoured only for ids not starting with `claude-` (`docs/agent/local-provider.md:15`) — measured for local ids, **assumed** to hold for `claude-haiku-5-5` | if it holds, compaction fires near 167k, far past the cliff, so it never keeps a Haiku session cheap and the cap in C3 is the only thing that does | the U1 run's `/context`-equivalent: drive one session past 100k on a scratch copy and read whether a compaction boundary appears in the transcript |
