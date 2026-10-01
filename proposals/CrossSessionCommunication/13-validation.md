# 13: Validation

How to test the recommendation before building it, how to tell after building
whether it worked, and what this survey verified and did not.

## 1. Before G1: the receiving side of the CLI channel

The send side is measured: `scripts/native-tools.sh` shows `ListAgents` and
`SendMessage` on the app's argv, and shows `CLAUDE_CODE_HARBOR_KITE=0` removing
`ListAgents`. The receive side could not be run inside a work cycle, because the
Bash sandbox refuses `AF_UNIX` (`socket(AF_UNIX)` → `[Errno 1] Operation not permitted`).

**The command.** From a shell in the container that is **not** a work cycle's
Bash, as uid `node`:

```bash
bash proposals/CrossSessionCommunication/scripts/native-pair-test.sh
bash proposals/CrossSessionCommunication/scripts/native-pair-test.sh bypassPermissions
```

Both use a scratch `CLAUDE_CONFIG_DIR`, a scratch socket directory, a dummy key
and `scripts/stub.mjs`. Nothing is billed, and nothing reaches `~/.claude` or
`/tmp/cc-socks`.

It runs four sessions:

- **A** is slow.
- **B** sends to A mid-turn.
- **D** sends while A's last request is in flight.
- **C** sends after A has exited.

**What each result means:**

| Observation | Meaning for the survey |
|---|---|
| B's text appears in A's next request, A's `stream-json` has no frame for it, and A's transcript has an `origin.kind:"peer"` record | C5 confirmed: the receiver's app log carries nothing. G1 stands as written. |
| D's send makes A emit a second `result` or take another turn | C3 confirmed: a message extends a cycle. G1 stands as written. |
| C's send fails with "No agent named …" | Nothing is queued for an ended session, as read from the binary. |
| Under `bypassPermissions`, B's send is held, then `expired` | The parity hold works as read. It does not change G1, because two `acceptEdits` runs are still a pair. |
| None of the above: A sees nothing | The binary was misread. G1 still stands on C1 and C4 alone, and [`11-recommendation.md`](11-recommendation.md) records the softer verdict. |

**Then the switch itself.** Add `CLAUDE_CODE_HARBOR_KITE=0` to the `env -i` line
in the script's `cycle()` for `ROLE_A` and re-run. Expected: A's debug log reads
`[uds-messaging] Skipped: cross-session messaging gate off`, no socket appears
for A, and B's `ListAgents` does not list A.

**After G1 lands.** On the next work cycle on this install, a run asked to call
`ListAgents` has no such tool. `ls /tmp/cc-socks/` while runs are live shows no
socket for any `sdk-cli` session. Re-run `python3 scripts/peer_usage.py` a week
later: zero new `ListAgents` calls from runs.

## 2. Before G2 and G3, and after them

**Before G2.** `python3 scripts/search_would_find.py dup-tasks.txt`, run on
`scripts/dup_tasks.py`'s output, already answers the upper bound. For all 25
near-duplicate pairs between concurrently live runs, a single word of the later
title matches the earlier. 10 match on a test name; 15 match only on a word as
generic as `dockrac` or `compile`. So G2 can reach every measured duplicate.
Whether a run searches, and on what, cannot be measured before the parameter
exists.

**After G2 and G3, over two weeks.** Run `bash scripts/run-all.sh <outdir>`,
which rebuilds every figure, and compare against the September baseline:

| Reading | Baseline (2026-09-02 to 2026-10-01) | G2 worked if | G3 earned its place if |
|---|---|---|---|
| Near-duplicate task pairs between live siblings, per 100 overlapping run pairs | 25 per 1,122 = 2.2 | below 1.0 | |
| `create_task` calls preceded, in the same cycle, by a `list_my_tasks` carrying a `query` | 0, since the parameter does not exist | above 50% | |
| Runs with a non-empty roster that ran `git log` or `git diff` on a branch the roster named | not measurable today | | at least 1 in 10. Below that for two weeks, delete G3 |
| Redos that cite a sibling's commit ("redoing the work", "already fixed on another branch") | 1 | | |

The two right-hand columns are thresholds chosen in advance, not derived. They
are written here so they cannot be chosen after the result.

**The falsifier, from [`11-recommendation.md`](11-recommendation.md).** For each
duplicate or redo between live siblings in the window, read the two transcripts
and ask whether the first run's first *record* came after the second run started
on the same thing. A record is a task, a commit on its branch, or a note. Two
such cases in two weeks move the build to the runner-up, C-board.

**Database cross-check, when the database can be read.** `scripts/settle-from-db.sql`
recomputes concurrency from `runs` and collisions from `run_reviews`:

```bash
docker exec -i usagefoundry sqlite3 -readonly /data/usagefoundry.db < scripts/settle-from-db.sql
```

## 3. What this survey verified, and how

Measured or read on 2026-10-01 at `336b907`:

- **The CLI's tool list on the app's argv shape.** Measured with
  `scripts/native-tools.sh` against `scripts/stub.mjs`: 23 tools including
  `ListAgents` and `SendMessage`; 22 without `ListAgents` under
  `CLAUDE_CODE_HARBOR_KITE=0`; neither under `--disallowedTools SendMessage ListAgents`.
  Re-run from the committed script.
- **That a work cycle registers and opens an inbox.** This cycle's
  `~/.claude/sessions/755547.json` and its `srw------- … 755547.sock` in
  `/tmp/cc-socks/`, and its own `ListAgents` result.
- **That runs have seen siblings.** Measured with `scripts/peer_usage.py`: 39
  `ListAgents` calls, 23 listing peers, 21 `SendMessage` calls all to sub-agents,
  0 received.
- **Concurrency, collisions, duplicates.** Measured with `scripts/run-all.sh`.
  The data pass ran it twice, with identical results apart from this session's
  own minutes. This survey re-checked the concurrency summary and the duplicate
  titles directly from its output.
- **The code claims in `01-` to `12-`.** Each was read at the cited line. The
  citation check below resolves every path and line number mechanically.
- **The vault notes.** Read for their `confidence:` and `status:` values and the
  quoted sentences. Every one cited is `confidence: medium`, `status: growing`.

## 4. Not verified

- **U1, the receiving side** of a peer message. Code-read only; §1 is the
  command.
- **That a resumed cycle re-reads a changed `MEMORY.md`**, and whether the
  auto-memory directory is keyed by git common dir or by repository root.
  Inferred from one directory and 49 writers.
- **The live window from `run_events`, collisions keyed on `run_reviews`,
  September's resolver spend** (60 of 87 resolver sessions carry no cost line),
  and runs on the local provider, which leave no Claude transcript. U4 is the
  command.
- **How many prompts already name siblings.** A first pass counted 151 of 580
  isolated runs; this survey's own scan of each run's opening prompt counted 12
  of 493, all on Dockrac. The two differ in their match and in their run key and
  are not reconciled. Nothing in the recommendation rests on either.
- **That a mid-cycle feature-flag refresh cannot re-open the inbox under
  `CLAUDE_CODE_HARBOR_KITE=0`.**
  - The startup log under the variable reads `[uds-messaging] Skipped:
    cross-session messaging gate off (will late-bind if a GrowthBook refresh
    enables it)`.
  - The binary also carries a `Late bind: gate enabled by a GrowthBook refresh
    after startup` path.
  - The gate returns the variable's value whenever the variable is set:
    `function Rs(){let e=a.CLAUDE_CODE_HARBOR_KITE;if(e!==void 0)return De(e);…}`,
    from `grep -ao` on the binary. That suggests a refresh cannot enable it.
  - That the late-bind path consults the same gate is inferred.
  - It is settled by the after-G1 socket check in §1, made during a cycle that
    outlives the flag refresh.
- **That `-p` cycles have no Remote Control bridge**, so that peers stay
  local-only. Assumed.
- **That varying the resumed `-p` text writes no prefix** (U5). No option this
  survey recommends uses that slot, so nothing rests on it.
- **That the orchestrator chat's child registers and is reachable** (U3). It runs
  `bypassPermissions`, so `acceptEdits` runs would be held by parity. Runs on
  this install have been `bypassPermissions` themselves (this cycle's transcript
  records `permissionMode:"bypassPermissions"`), and two bypass sessions are a
  pair.
- **That the duplicates would not have happened with a message.** That is the
  falsifier's job, not something a survey can settle in advance.

## 5. Citation check

`node scripts/check-citations.mjs`, copied from LocalModelOffload's, resolves
every `path:line` in this directory's markdown files against the tree. Its
result at the commit that added this file is recorded in
[`README.md`](README.md) under "Checked".
