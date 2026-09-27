# The orchestrator chat

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing src/lib/chat.ts, src/lib/chatThread.ts,
> src/app/chat/page.tsx's question surface, src/app/api/mcp/.**

The paragraphs themselves live in `docs/agent/chat/`, one topic file per heading below. Find the rule by its lead claim and open the file its heading links to.

## [Proposals and their guards](chat/proposals-and-guards.md)

- The orchestrator chat picks what work to do; something a person wrote picks what an agent may do; a person decides whether it happens.
- An untemplated proposal's guards are frozen when it is written; a templated one's are read at the click, and the asymmetry is the point.
- A proposal may name the tasks on the board it is for, and it is the one field that is neither frozen nor a gate.

## [Prompt, agent and order: what a model may write](chat/what-a-model-may-write.md)

- Prompt text is the one half of a run a model may write, and it is written down as an exception rather than absorbed.
- Who does the work is the third half a model may write, and it is the same act as writing the task.
- Which CLI runs it is a fourth thing a model may write, and the card is what makes that allowed.
- The chat's own turn is not started as one, and the asymmetry with an orchestrator block is the whole reason.
- Order is the other half of the work a model may write, and it is a label until a person approves it.

## [Replacing and deciding proposals](chat/replacing-and-deciding-proposals.md)

- A proposal still waiting can be replaced by a corrected one in a single tool call, and a decided one can never be.
- A replaced proposal is drawn in the decided list and nowhere else, and every count on the panel excludes it by construction rather than by remembering to.
- A refused decision is drawn after the row it refused has gone.

## [Workflow and schedule proposals](chat/workflow-and-schedule-proposals.md)

- The chat can write a workflow, and approving one saves it rather than starting it.
- The chat can propose a schedule, and it is the one proposal whose approval leads to spending with nobody present.

## [The chat's MCP tools and its capability](chat/mcp-tools-and-capability.md)

- Two read tools reach past this thread, and neither can move anything.
- The chat's tools run in this process, and that is a correctness requirement rather than a convenience.
- The chat's child authenticates with a capability, never with `UF_AUTH_TOKEN`.

## [The chat child's permissions and sandbox](chat/child-permissions-and-sandbox.md)

- The chat runs with no tool allowlist that bounds anything, so the system prompt is the boundary.
- The chat's child gets the same sandbox preparation a work cycle does, and deliberately not the git half.

## [A chat turn: settling, ending, bounds and spend](chat/turns.md)

- A settle belongs to one turn, and `finishTurn` refuses to settle any other.
- Every way a turn can end writes the ending into the thread, and the row is not a record of it.
- A turn is bounded by silence and by money, and never by how long it has been going.
- A provider refusal is what the turn says went wrong, ahead of anything this app inferred from the wreckage.
- A chat turn is durable while it is happening, and it was not.
- A chat turn is spend with no `evaluateBudget` behind it.
- A resumed turn is charged its increase, never the figure the CLI printed.
- The install's ceiling is asked again while the turn runs, and that is what `chatTurnBudgetUSD` never covered.

## [Questions to the operator](chat/operator-questions.md)

- The chat can ask the operator a question, and asking is how the turn ends rather than something it waits through.
- A pending question is derived from `chat_questions` and is never a fourth `chat_sessions.status`.
- A question is drawn in the conversation and never in the panel beside it, and *where* it lands is a decision rather than an ordering.
- A settled question keeps its place, and the message beside it is not a duplicate of it however much it reads like one.
- A choice sends on one press only when it is the last question open, and the card says which of the two shapes it is in.
- The composer beside an open question is neither disabled nor pre-filled, and it says what sending does.
- A chat waiting on an answer is drawn as waiting, and it stays on the *idle* poll.
- An ordinary message supersedes every open question, and an answer supersedes the ones it did not name.

## [`GET /api/chat` and the thread poll](chat/chat-api-and-poll.md)

- `GET /api/chat` answers two different questions, and which one is decided by whether it was given a parameter at all.
- The poll asks for the messages it does not have, and that is the only half of the thread a cursor may be right about.
