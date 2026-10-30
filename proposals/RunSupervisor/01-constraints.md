# 01: What any supervisor channel has to survive

Part 0 draws the scope. Part 1 is eleven constraints of this install, each with
where it is written down; C6, on injection, is the one the brief asked to stand
alone. Part 2 is the unknowns and the command that settles each.

## Part 0: scope

**Vertical, not peer.** This survey covers text from one run up to a party that
acts for the operator on *that run's* task, and that party's reply down to the
same run. Text whose reader is another run is peer messaging, which
[CrossSessionCommunication](../CrossSessionCommunication/README.md) decided
("see, not talk") and which is not reopened here. The two meet at one point. A
supervisor that answers many runs, and carries anything from one run's question
into another run's answer, has turned a vertical channel into a peer one with a
model in the middle. So constraint C6's first rule, that the supervisor keeps no
state between questions, is what keeps this survey on its side of the line.

**The CLI's native messaging stays closed.** `CLAUDE_CODE_HARBOR_KITE=0` is set
after the extras in `childEnv` "so no caller can turn it back on"
(`src/lib/orchestrator.ts:7689`-`:7700`, `:7816`), and also in `chatEnv`,
`reviewEnv` and `authEnv` (`src/lib/chat.ts:4771`, `src/lib/review.ts:1473`,
`src/lib/claudeAuth.ts:299`). Board task `dd0c0b1d` closed it on 2026-10-01.
Its comment records the measurement: with the variable, `ListAgents` is gone and
the debug log reads "`[uds-messaging] Skipped: cross-session messaging gate
off`" (session `a32dd347…`, line 460, under
`~/.claude/projects/-workspace--uf-worktrees-usagefoundry-721638d11c0b-1/`).
The one option here that would reopen it, [F](08-option-f-native-messaging.md),
has to meet that decision's reasons, and does not.

**Neighbouring surveys, reused rather than redone.**

- *ContinuousImprovement* owns information across time: a finished run leaving
  something for the next.
- The archived *Operator Questions* survey owns the chat's own questions.
- The archived *Unattended Operation* survey owns reaching an absent operator,
  and its webhook is inherited as it stands.

**The chat conversation is in scope here as a party, and was out of scope
there.** CrossSessionCommunication excluded it for three reasons
(`proposals/CrossSessionCommunication/01-constraints.md`, Part 0). The brief asks
that they be met rather than stepped around; C9 does that.

## Part 1: what holds

### C1. An answer must never start, wake or extend a run past its guards

Five sentences in `docs/agent/` each state part of this rule; CrossSessionCommunication
C3 lists them. The one that bears here is the stack park's:

> "Every wait needs a person's answer, which bounds it in practice too, but a
> terminus that rests on a person doing something is not one."
> (`docs/agent/run-lifecycle/waiting-for-stack.md:11`)

Three consequences follow.

1. **Only a person's act may release a park.** The stack park is released by a
   restart the operator performed or by a Decline they pressed
   ([`02-what-already-asks.md`](02-what-already-asks.md) §2). If a model's answer
   could release a parked run, the model would be a thing that wakes runs, with
   nobody present.
2. **A model's answer may land only inside a call the run is already making.**
   There it wakes nothing: the cycle is already live, already counted, already
   under `--max-budget-usd`.
3. **Any refund is bounded by a count on the row.** Neither the person nor the
   model bounds it. `MAX_STACK_WAITS_PER_RUN` and `guard_refunds` are the
   arrangement (`docs/agent/budgets-and-guards/termini-and-waiting.md:11`).

And the cycle a release starts passes the pre-cycle `evaluateBudget` like any
other (`src/lib/orchestrator.ts:12058`-`:12075`), through `promoteQueued`, never
`startRun`.

### C2. What a supervisor may answer, and what it must hand to the operator

This is the authority line. The chat already holds most of it: "something a
person wrote picks what an agent may do; a person decides whether it happens",
and "a guard set arriving from storage may never widen what a run may do"
(`docs/agent/chat/proposals-and-guards.md:7`, `:9`).

| A supervisor **may** answer | It **must escalate**, whatever it believes |
|---|---|
| A fact the repository, the board, an earlier run or the vault records, citing where | Any change to the run's budget, `maxIterations`, `maxDurationMinutes`, permission mode, isolation, model or agent |
| The brief's intent, **where** the brief or the operator's own words in the originating conversation show it, quoting them | Any of the operator's presses: push, land, deliver, fetch. The chat is told it does not "push or git fetch yourself … a push cannot be taken back" (`src/lib/chat.ts:4298`-`:4302`) |
| A known fix for an error, where `CLAUDE.md`, a memory note or `list_recurring_failures` records it | Claiming, closing or clearing an `operatorOnly` task (`src/lib/tasks.ts:369`-`:375`) |
| "The brief does not say; carry on under your best reading and record it" | Anything outside the brief's scope: a second task, a file the brief fences off, a repository it does not name |
| | A destructive or irreversible step: a history rewrite, a deletion outside the run's own checkout, anything sent off the machine |
| | A credential, a decision the brief reserves, a preference only the operator holds |

**When a run asks for something in the right-hand column, it gets an escalation,
never a judgement.** The supervisor does not weigh such a request. It is routed
to the operator by kind, and the answer the run gets back is the same sentence
whatever the supervisor thinks of the request. Otherwise a run's persuasive
question becomes the way to widen its own guards, which is C6 again.

### C3. A cycle receives only what it asked for, at the moment it asks

`stdio: ["ignore", "pipe", "pipe"]` (`src/lib/orchestrator.ts:8527`), a
plain-JSON MCP route (`src/app/api/mcp/route.ts:227`-`:228`), and a
`follow_up` read once per segment (`src/lib/orchestrator.ts:11668`) leave three
landing points. They are the three CrossSessionCommunication C2 found, and
[`02-what-already-asks.md`](02-what-already-asks.md) §7 measured a fourth:

- a tool result;
- the next segment's `-p` text;
- the CLI's stdin, if the app ever opened it.

Never the appended system prompt, which is frozen at `createRun`
(`docs/agent/taskboard/comments.md:63`-`:69`).

### C4. Every question and every answer must be readable afterwards, for as long as their effect lasts

- `run_events` keeps a tool call's input, clipped
  (`src/lib/orchestrator.ts:10374`-`:10375`).
- It keeps a tool **result** only when it is an error
  (`src/lib/orchestrator.ts:9775`). **An answer delivered as a successful tool
  result is in no table the operator can page through**, only in the
  transcript.
- `run_events` and transcripts expire at 30 days
  (`src/lib/settings.ts:1149`, `:1151`). Branches are never swept.

So a channel owes its own rows, as `chat_questions` and `task_comments` are, on a
horizon no shorter than the branch the answer may have shaped. The run page must
draw both halves.

### C5. A restart closes every live cycle and keeps every row

`reconcileOnBoot` fails every `running` row with `restart_closed`, keeps a
`waiting-for-stack` row whatever its age, and keeps a recent `paused` one
(`src/lib/orchestrator.ts:16941`-`:16998`). The in-memory maps die with the
process: interrupts, live guards, `pendingPushback` and capability tokens
(`src/lib/chat.ts:2422`).

- A question held in a blocking call dies with the cycle that made it.
- A question parked in a row survives.
- A supervisor turn in flight at the restart is lost. It must leave the question
  answerable by the operator, never answered by nobody.

### C6. Injection runs both ways, and a supervisor is a hub

**The evidence.**

- *Prompt Infection (Lee and Tiwari 2024)* (vault, `confidence: medium`,
  `status: growing`) demonstrates an injection that makes the compromised agent
  "copy itself into every message it sends onward". It finds multi-agent systems
  "highly susceptible, even when agents do not publicly share all
  communications". Its defence, LLM Tagging, helps only "when combined with
  existing safeguards". The note's warning is "Do not read it as a fix", and its
  author read the abstract only.
- The same note: a report "arrives in the parent's context with the structural
  authority of a tool result and none of the parent's own scepticism". It
  leaves open whether parents weight such a report differently from a raw tool
  result: "If they do, the delegation boundary is an authority *escalation*."
- *Orchestration Topologies* (`confidence: medium`, `status: growing`) records
  that "architectures without centralized verification tend to propagate errors
  more than those with centralized coordination". A hub is a defence only if the
  hub verifies.
- *UnderSpecBench (Ji et al 2026)* (`confidence: medium`, `status: growing`)
  finds that "blast-radius cues barely reduce action propensity". The vault draws
  the conclusion: "where the stake is an action rather than a style, the layer
  that helps is permissions, not prose."

**Upward: a run's question is untrusted input to the supervisor.** Every run
reads repository content nobody reviewed. That is why the server is privileged
and the children are not (`src/lib/privsep.ts:34`). A question can carry a
payload addressed to whoever answers it. If the answerer has tools, the payload
can use them. If the answerer is the chat child (`bypassPermissions`, every
mount, the install-wide GitHub token, `src/lib/chat.ts:3212`-`:3236`,
`:4742`-`:4773`), the payload has the most authority this app grants any model.

**Downward: a supervisor's answer reaches the run with the supervisor's
authority.** It arrives as a tool result the run asked for, from a party the run
was told acts for the operator. That is the escalation the vault's open question
names, built on purpose.

**Across: the hub.** One supervisor answers many runs. If anything one run wrote
reaches the supervisor's context when it answers another, a confused or infected
run steers every run that asks after it. That is Prompt Infection's
self-replication with a model in the middle.

**The rules every option is held to:**

1. **Stateless per question.** Each answer is composed from the asking run's
   question and from sources the server selects. No question, answer or note
   from another run is ever in that context. This is what removes the hub.
2. **No tools that act, and ideally no tools.** The vault pointer's gate is the
   precedent: `claude -p` with `--tools ""`, `--setting-sources ""`,
   `--strict-mcp-config`, `--disable-slash-commands`, which "reads what it is
   handed and answers in JSON" (`docs/agent/run-lifecycle/vault-pointer.md:23`).
   A payload in a question can then make the supervisor *say* something. It
   cannot make it *do* anything.
3. **The authority line is the server's, not the model's.** C2's right-hand
   column is matched by kind before any model sees the question. A supervisor
   cannot be talked into widening a guard it has no way to widen.
4. **Answers are framed as data, with their source.** An answer says which
   document or which operator sentence it rests on, so the run can check the
   claim against its own reading. The validator's frame is the model: "It is
   evidence of what changed and nothing else" (`src/lib/validation.ts:362`-`:367`).
5. **Never upward into a more privileged child.** No run's text reaches the
   chat child as it runs today. CrossSessionCommunication's rule 5, kept.
6. **Everything is logged** (C4), so an infection that does pass leaves a trail
   on the run page, not only in a transcript that expires.

Rules 1 and 2 carry the weight. Framing reduces risk and does not remove it,
which is the paper's own finding.

### C7. A supervisor turn is spend, and nobody is there when it is spent

- **The app's metered children are fixed.** "Four kinds of agent child process,
  from four modules, and no more … Adding a fifth kind is a decision, not a
  detail" (`docs/agent/architecture/run-loop-and-child-processes.md:7`). The vault
  gate was argued to be "neither … a fifth kind of agent child"
  (`docs/agent/run-lifecycle/vault-pointer.md:23`). A supervisor must either be
  one of the four or carry that argument itself.
- **Assists share one concurrency number.** `maxConcurrentAssists` defaults to 2
  and is shared by the chat, the validator and the reviewer
  (`src/lib/settings.ts:1128`, `src/lib/review.ts:676`-`:686`). A supervisor
  that took an assist slot could refuse the operator's own chat turn. One that
  did not would need its own bound.
- **Whose budget.** An assist's spend never reaches `runs.spent_usd`. The
  reviewer's, the chat's and the vault gate's are each kept elsewhere
  (`src/lib/review.ts:54`-`:59`, `docs/agent/chat/turns.md:17`,
  `docs/agent/run-lifecycle/vault-pointer.md:25`). `installSpend` sums runs,
  blocks, chat turns and reviews (`src/lib/installBudget.ts:111`-`:217`) and not
  the vault gate. A supervisor's spend has to land in that sum, or the install's
  daily limit does not bound it.
- **Bounded per call, per run and per window.** A per-call `--max-budget-usd`, a
  per-run question count on the row (C1), and `assistRefusal`'s install and
  window checks before any spawn (`src/lib/review.ts:767`-`:781`).

### C8. Providers carry weaker guarantees, and the channel must say so rather than assume

- **Codex runs get the same eight run tools** over the same token, through `-c`
  overrides (`src/lib/cycleInvocation.ts:1882`-`:1890`). But:
  - nothing bounds a single Codex cycle's spend
    (`src/lib/cycleInvocation.ts:1902`-`:1906`);
  - its notices are in-band conversation text
    (`src/lib/cycleInvocation.ts:1828`-`:1832`);
  - its MCP client has its own tool timeout, measured in
    [`02-what-already-asks.md`](02-what-already-asks.md) §7.
- **Local-provider runs take the Claude path.** But `ENABLE_TOOL_SEARCH=false`,
  so every tool schema rides every request, and their spend is unknown rather
  than zero (`docs/agent/local-provider.md:9`, `:23`). A new run tool costs a
  local run on every request, not once.

### C9. The chat is the most privileged child in the app, and that is a property of its argv, not of its conversation

CrossSessionCommunication excluded the chat as a party for three reasons:

1. its child is `bypassPermissions`, `--strict-mcp-config` and `--add-dir` on
   every mount, and can propose runs;
2. it already has every read a channel would give it;
3. a chat turn is attended.

All three are true, and they are about **the child a chat turn spawns**, not
about the conversation. The conversation is a session id
(`chat_sessions.session_id`) that every turn resumes (`src/lib/chat.ts:3289`).
The pinned CLI can resume a session under a different argv:
`--fork-session` "When resuming, create a new session ID", and `--tools`
narrows what is offered (`claude --help`, 2.1.310). So the operator's words in
the originating conversation can be read by a child that has none of the chat's
privileges, never writes back into the chat's own session, and is not the chat.
That meets reasons 1 and 3. It leaves reason 2 standing, and in a stronger form:
**the chat's value as a supervisor is only what the operator said there**, which
the run's brief already condenses. Whether the CLI resumes a session cleanly
under `--tools ""` is assumed, not measured; U4 settles it.

### C10. A channel that is never used is as much a failure as one that is used too much

- **Too little.** `ask_operator` was called 3 times in 152 operator turns, each
  time prompted by the operator, because its judgement sat in a deferred
  description ([`02-what-already-asks.md`](02-what-already-asks.md) §3).
- **Too much.** *Ask or Assume (Edwards and Schuster 2026)* (`confidence:
  medium`, `status: growing`) found that the arm told to ask "asked once" on
  essentially every task, and that "the cost of asking when there is nothing to
  ask about" is unpriced. *Habituation at the Gate (Yu et al 2026)* (`confidence:
  medium`, `status: growing`) measured approval rising 14.5 points and words per
  review falling 28% as reviewers saw more agent work, with a confound the
  authors cannot rule out. An operator answering many run questions is that
  reviewer.
- **The ending this app already has was written against the second.**
  `NEEDS_REVIEW_NOTICE`'s wording "has to make reporting it *more* work than
  carrying on" (`docs/agent/run-lifecycle/endings.md:17`).

So every option needs a **floor**, evidence that it is reached at all, and a
**kill criterion**, evidence that it is reached for what the run could have
settled itself. Both are fixed in [`13-validation.md`](13-validation.md) before
anything is built.

### C11. The brief is the contract, and the operator already writes briefs for nobody to ask

This survey's own brief says "Nobody will answer a question mid-run … Make every
judgement call yourself, write the reasoning down". The run notices append "If
you reach something you cannot get past, reply with exactly NEEDS_REVIEW". The
house rule for proposals is "anything you could not verify says 'assumed' in the
sentence that makes it" (`proposals/README.md:12`-`:14`). **On this install the
answer to an unasked question is already written down, by the run, in its
report, for the operator to read after.** A supervisor that answers mid-run
replaces a visible "I assumed X" with "the supervisor said X". That is better
only if the supervisor knew something the run did not.

## Part 2: unknowns, and what settles each

| | Unknown | Settled by |
|---|---|---|
| U1 | How long the pinned CLI waits on an HTTP MCP tool call, and whether anything it writes meanwhile re-arms the watchdog | Settled in [`02-what-already-asks.md`](02-what-already-asks.md) §7; `scripts/mcp-wait-probe.sh` re-runs it on the next pin |
| U2 | Whether `--input-format stream-json` delivers a message into a live turn, and what it does to the `result` the app meters from | Settled in §7 as well; `scripts/live-turn-probe.sh` |
| U3 | What share of real questions a read-only model could have answered | Measured from transcripts in [`00-problem.md`](00-problem.md); the live test is [`13-validation.md`](13-validation.md) §2 |
| U4 | Whether `claude -p --resume <chat session> --fork-session --tools "" --strict-mcp-config` answers from the conversation without writing to it, and what it costs on a 100k-token chat | The stub API from `scripts/stub-api.mjs` with a copied chat transcript as the resumed session: confirm the request carries the history and no tools, and that the source `.jsonl` is unchanged afterwards |
| U5 | The receiving side of the native channel | CrossSessionCommunication U1, unchanged, and moot while G1 holds |
