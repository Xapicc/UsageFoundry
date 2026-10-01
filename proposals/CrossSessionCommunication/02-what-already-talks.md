# 02: What already carries information between runs

Every channel below was verified in code or measured on this install. The
question asked of each is the same: what it carries, who writes and who reads
it, **when** the reader sees it, whether it survives a restart, what the
operator can see, and whether it can start, wake or extend a run. §1 comes
first because it changes the question.

## 1. Claude Code's own peer messaging: live, unlogged, and not scoped to a project

**Every work cycle on this install can list and message every other live Claude
Code session in the container, and nothing in this app knows.**

| Claim | Evidence |
|---|---|
| A headless `-p` cycle of the pinned CLI is offered `ListAgents` and `SendMessage` | `bash scripts/native-tools.sh app --permission-mode acceptEdits --allowedTools Grep Glob --disallowedTools 'Bash(pkill:*)' 'Bash(killall:*)'`, the app's argv shape, against `scripts/stub.mjs` with a dummy key: `exit=0`, `init tools (23)`, both names present, and the same 23 in the request the stub received. Re-run 2026-10-01. |
| The pin is the one in the image | `Dockerfile:445` `ARG CLAUDE_CLI_VERSION=2.1.280`; `claude --version` → `2.1.280 (Claude Code)` |
| A UsageFoundry work cycle is a `-p` session and opens an inbox | This survey's own cycle: its transcript records `entrypoint:"sdk-cli"`, `version:"2.1.280"`, and its registry record `~/.claude/sessions/755547.json` reads `"entrypoint":"sdk-cli"`, `"name":"usagefoundry-721638d11c0b-1-0c"`, `"messagingSocketPath":"/tmp/cc-socks/755547.sock"`; `ls -la /tmp/cc-socks/` shows `srw------- node node … 755547.sock` |
| Nothing on the argv denies it | `--disallowedTools` carries `PROCESS_KILLERS` and a stack's denials only (`src/lib/cycleInvocation.ts:1275`, `src/lib/cycleInvocation.ts:724`); `grep -rn "ListAgents\|SendMessage\|HARBOR" src/ Dockerfile docker-compose.yml` → nothing |
| **Two runs on one repository have seen each other** | `python3 scripts/peer_usage.py`: of 39 `ListAgents` calls made by runs, **23 listed another live session**. On 2026-09-13 20:17 the run in `usagefoundry-…-1` listed `usagefoundry-721638d11c0b-4-e2`, `-3-10`, `-2-af` and `-5-de`, four live UsageFoundry siblings. On 2026-09-21 a Dockrac run listed three Dockrac siblings. |
| **And runs on other repositories, and sessions that are not runs** | The same scan: a UsageFoundry run on 2026-09-26 listed three Dockrac runs; a `gh-layer10` run on 2026-09-08 listed an InvestmentManager run, a VisualEdit run and `workspace2-ce`, a session in the operator's vault folder |
| No run has yet sent or received a peer message | The same scan: all 21 `SendMessage` calls were addressed to the run's own in-process sub-agents (ids of `a` + 16 hex), 0 to a peer; 0 received cross-session messages |

**How it works**, read from the binary's string table, with names minified;
`scripts/` holds the probes:

- **Discovery.** Each session writes `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`
  and listens on a unix socket at `${XDG_RUNTIME_DIR || tmpdir}/cc-socks/<pid>.sock`.
  `ListAgents` reads every record and lists each one whose socket connects
  within 250 ms. The scope is "same config directory and same `/tmp`, same
  uid": every run, every assist and any interactive session in the container.
  The registry is the mounted `~/.claude`, so it also holds the operator's Mac
  sessions (`ls ~/.claude/sessions/` shows `entrypoint:"cli"` records with Mac
  paths). Their sockets do not exist here, so they are never listed.
- **The switch.** `ListAgents.isEnabled` is `isCrossSessionMessagingEnabled`.
  The env var `CLAUDE_CODE_HARBOR_KITE` overrides it; otherwise the feature flag
  `tengu_harbor_kite` decides, and it defaults to on. It depends neither on `-p`
  nor on the auth type: the probes used an API key.
- **Turning it off.** With `EXTRA_ENV=CLAUDE_CODE_HARBOR_KITE=0`, the same probe
  gives `init tools (22)` with `ListAgents` absent, and the debug log reads
  `[uds-messaging] Skipped: cross-session messaging gate off`.
  - `SendMessage` stays, because it is also how a run talks to its own
    sub-agents (all 21 measured uses). With the gate off it refuses peer
    addresses: "Cross-session messaging is not available in this session."
  - `--disallowedTools SendMessage ListAgents` removes both tools, and with them
    sub-agent messaging, and **still opens the inbox**: the debug log shows the
    bind attempt. A cycle that cannot send can still receive.
- **Delivery.** A received frame becomes a queued prompt with
  `origin:{kind:"peer"}` and `isMeta:true`. The tool's own description says it
  drains "at the receiver's next tool round".
  - The print-mode loop checks the queue when a turn ends and goes round
    `"again"` if anything is in it. **A message that arrives before a cycle exits
    makes that cycle take another turn.**
  - It cannot wake a cycle that has exited. A send to a name that is not listed
    returns `No agent named '…' is reachable`, and nothing is queued on disk.
- **Who accepts from whom.** Sessions are classed `"bypass"` or `"prompting"`
  (every other mode), and a message across classes is held. In a headless host
  "every parity hold ends this way": `expired`.
  - **`plan` and `acceptEdits` are the same class**, so a read-only run can ask
    a writing run to write.
  - `crossSessionInbound` (`accept` / `hold` / `refuse`) can be set from
    `--settings`.
- **What the app would see.** The sender's call is an ordinary `tool_use` in
  `stream-json`, so `run_events` keeps its input, clipped
  (`src/lib/orchestrator.ts:8357`-`:8370`). The receiver's stream carries the
  replayed user turn only under `--replay-user-messages`, which the app does not
  pass. So **the receiving run's log most likely shows no frame for the message
  at all**, only what the model did next. This is assumed: the Bash sandbox
  refuses `AF_UNIX` sockets (`socket(AF_UNIX)` → `EPERM`), so the receive side
  could not be run here. `bash scripts/native-pair-test.sh`, run from an
  unsandboxed shell as uid `node`, settles it
  ([`13-validation.md`](13-validation.md) §1).
- **Beyond the machine.** Cloud and Remote Control peers need the cloud flag
  (`tengu_harbor_kite_cloud`, cached `false` here), a claude.ai login and a live
  bridge. That `-p` cycles have no bridge is assumed.

**What this breaks, against [`01-constraints.md`](01-constraints.md):**

- C1: its scope is the container, not the project.
- C3: a message extends a live cycle by a turn.
- C4: a `plan` run can have an `acceptEdits` sibling write for it.
- C5: the receiver's log most likely carries no record.
- C8: it is free text, peer to peer, forwardable, across repositories.

All of that holds while nobody has used it. Its whole measured use is incidental
listing: runs call `ListAgents` to see their own sub-agents (13 results listed
sub-agents only) and get their siblings as well.

## 2. The taskboard over the app's MCP endpoint

This is behind `taskboardForRuns`, default `false` (`src/lib/settings.ts:1063`),
and on for this install. A run gets seven tools (`RUN_TOOLS`,
`src/app/api/mcp/route.ts:536`) and none of `SHARED_TOOLS`.

| | |
|---|---|
| Carries | Task titles and bodies (`create_task`), notes (`comment_on_task`, defined at `src/app/api/mcp/route.ts:685`, handled at `src/app/api/mcp/route.ts:1824` and `src/app/api/mcp/route.ts:2354`), dependency edges |
| Written by | A run, the chat or the operator. Authorship comes from the token, never from an argument (`src/app/api/mcp/route.ts:2369`-`:2383`) |
| Read by a sibling | Through a tool call only. Notes on a task a run **holds** come back whole on its next `list_my_tasks`, the last ten of them (`src/lib/taskComments.ts:130`). Open tasks in the run's folder come back as `openInFolder`, without notes and **clipped to 20** (`MAX_RUN_TASKS`, `src/lib/tasks.ts:1473`). `get_my_task` returns a thread on a held or open-in-folder task (`src/lib/tasks.ts:1560`-`:1579`) |
| Read when | When the agent asks, at any tool round. Never via the appended prompt, by rule (`docs/agent/taskboard/comments.md:63`-`:69`) |
| Durable | Yes. `tasks` and comments are never swept (`docs/agent/retention.md:24`) |
| Operator sees | Every note on the task page. The run's call is a `tool` event |
| Starts, wakes, extends | No. "It starts nothing" (`src/app/api/mcp/route.ts:631`). The one indirect effect: a workflow loop's board condition counts open tasks before each pass, bounded by `maxPasses` (`docs/agent/taskboard/operator-only-and-release.md:70`-`:75`) |

**This is already an addressed channel between concurrent runs.** Run A writes
on a task run B holds, and B reads it whole at its next `list_my_tasks`. Two
limits keep it narrow. A cannot list what B holds. And the write is checked for
existence only (`src/lib/taskComments.ts:270`), so A can reach B's task only if
it has learned the id somewhere. It is also already a channel for model-written
free text, which C8 applies to.

**The clip is where the measured duplicates came from.** Nine Dockrac runs filed
one task because each `list_my_tasks` showed 20 of 69-99 open tasks
([`00-problem.md`](00-problem.md) §3).

## 3. `dependsOn` and `continueBranch`

Sequential, not concurrent. A dependent is released by `releaseDependents`
(`src/lib/orchestrator.ts:5058`-`:5076`) into the queue rather than started
(`docs/agent/dependencies.md:18`), once `edgeSatisfied`
(`src/lib/orchestrator.ts:4674`-`:4681`) holds. With `continueBranch` it adopts
the predecessor's branch and base (`src/lib/orchestrator.ts:2427`-`:2437`) and
receives `continuedWorkNotice` on cycle 1 (`src/lib/cycleInvocation.ts:431`-`:445`).
That notice names the branch and two git commands, and 84.8% of told runs ran
the exact command (`proposals/ContinuousImprovement/README.md:47`-`:50`).

What passes is the branch. No report, reply or stop reason crosses.
`reconcileOnBoot` blocks dependents rather than releasing them (C6). The edges
exist only between runs created with them, so a sibling already in flight can
never gain one.

## 4. Report, stop reason, conflict and touched maps

Operator-facing only. `conflictMap.ts` is imported only by
`src/app/runs/[id]/conflicts/page.tsx` and its component; `runTouches.ts` only by
components and `touchedMap.ts`. A run reads none of them: the `RUN_TOOLS`
docblock says nothing there "reads another run's work"
(`src/app/api/mcp/route.ts:494`). The chat and orchestrator blocks can read a
run's stop reason and log tail through `get_run`
(`src/app/api/mcp/route.ts:2440`-`:2505`), and a block can turn that into a new
run's prompt through `emit_runs`. That is a model relay, and only into runs that
do not exist yet.

## 5. Git itself

Every `uf/*` branch and object is visible from every worktree, so a sibling's
commits can be read as soon as they exist. Runs do this unprompted: "Already
done by the run ahead: branch …-4-cf43b586, commit 624a7e8 … I wrote nothing"
(FoundryCode, 2026-09-13, from `scripts/keyword_hunt.py`'s output). This is
state, not a message: the app authored none of it and no run addressed it to
anyone. `refs/stash` and `/tmp` are also shared, as hazards rather than as
channels (`src/lib/cycleInvocation.ts:607`).

## 6. Claude Code's auto-memory

This is a cross-time channel outside this survey's scope, recorded because it is
live and the app does not see it.

- Worktrees of one repository share one memory directory: this cycle, running in
  a worktree, was handed `~/.claude/projects/-workspace-UsageFoundry/memory/MEMORY.md`.
- `ls -d ~/.claude/projects/*/memory | grep -c uf-worktrees` → `0`, so no
  worktree has its own.
- The directory holds 23 files, and **49** worktree run transcripts contain a
  write into it
  (`grep -la '"file_path":"/home/node/.claude/projects/-workspace-UsageFoundry/memory/' ~/.claude/projects/-workspace--uf-worktrees-usagefoundry-*/*.jsonl | wc -l`).
- A sibling reads it at its next session start, and since cycles `--resume`
  that is cycle 1. Whether a resumed cycle re-reads a changed `MEMORY.md` is not
  verified.

The app never names this directory (`grep -rn "memory/" src/lib/*.ts`, no such
path), and a run's write there is visible only as an ordinary `Write` tool
event. It is the one existing channel where a run writes standing instructions
that later runs load into their system context. That is
ContinuousImprovement's §7 concern, "the write side and the read side must not
have the same author" (`proposals/ContinuousImprovement/01-constraints.md:107`-`:118`),
already realised.

## 7. Each other's transcripts and argv

Same uid, mounted `~/.claude`: every run can read every sibling's live
transcript, and `/proc/<pid>/cmdline` is world-readable
(`src/lib/chat.ts:4341`-`:4344`). The argv holds the sibling's `-p` prompt, its
appended system prompt and its `--mcp-config` path, which C9 covers. Runs have
used the transcripts this way: the `RUN_TOOLS` docblock records that "runs were
digging the rest out of transcripts on disk" (`src/app/api/mcp/route.ts:529`-`:531`).

## 8. Smaller channels

- **The file price list.** `fileCostNotice` counts other runs' `Read` calls in
  the same folder over 30 days (`src/lib/fileCostNotice.ts:122`). It is frozen at
  `createRun` (`src/lib/orchestrator.ts:4096`) and carried on every cycle's
  appended prompt. It holds aggregate counts only, from earlier runs.
- **The vault skill and dreaming.** Both are off by default
  (`src/lib/vaultSkill.ts:127`-`:128`). Notes written nightly are read by later
  runs on request.
- **Plugins.** These are operator-enabled directories passed every cycle
  (`src/lib/plugins.ts:467`). A run that edited one would change a sibling's
  next cycle. That is inferred, not observed.

## Summary

| Channel | Concurrent? | Read when | Free text from a run? | App logs it? | Starts / extends? |
|---|---|---|---|---|---|
| **CLI peer messaging** | **yes, container-wide** | next tool round, pushed | **yes** | sender clipped; receiver likely not | **extends a live cycle** |
| Taskboard notes | yes, if the id is known | on request | yes | yes, permanent | no |
| Taskboard `openInFolder` | yes | on request, 20 rows | titles | yes | no |
| `dependsOn` / `continueBranch` | no, sequential | cycle 1 | no, branch only | yes | releases into the queue |
| Maps, report, stop reason | no | operator, chat | no | yes | no |
| Git branches | yes | on request | commit messages | git | no |
| Auto-memory | at next session | session start, in context | **yes** | as a `Write` only | no |
| Transcripts, `/proc` | yes | on request | yes | no | no |

Two rows already put one run's free text in front of another without the app
deciding it should. One of them can also make a cycle last longer. Those two rows
are the ones this survey's recommendation has to answer for.
