# Option E: the session that spawned the run answers

There are two spawners that are models: the chat conversation that proposed the
run, reached through `origin_ref`, and the workflow orchestrator block that
emitted it.

## 1. Its strongest case

It is the operator's own picture, "an agent can talk to the session that spawned
it". The chat conversation holds what no brief does: **the operator's own words**
about the task before it was condensed into a proposal. When a run asks "did the
operator mean the page or the API?", the conversation where they said it is the
best evidence there is short of asking them. And it is reachable.

- A chat run's `origin_ref` is the proposal id (`src/lib/chat.ts:2067`-`:2068`).
- `chat_proposals.chat_id` → `chat_sessions.session_id`.
- Every chat turn already `--resume`s that id (`src/lib/chat.ts:3289`).
- Chat transcripts are kept for as long as the chat exists
  (`src/lib/retention.ts:764`-`:768`).

## 2. Meeting C8 of CrossSessionCommunication head on

That survey excluded the chat for three reasons. Here they are, and what this
option does with each ([`01-constraints.md`](01-constraints.md) C9).

1. **"Its child is the most privileged agent in the app."** True of the child, and
   it is a property of the argv: `bypassPermissions`, every mount as `--add-dir`,
   the install-wide GitHub token, `propose_run` (`src/lib/chat.ts:3212`-`:3236`,
   `:4742`-`:4773`). The conversation is a session id, and a session can be
   resumed under a different argv. **E-fork** answers with
   `claude -p --resume <chat session> --fork-session --no-session-persistence --tools "" --strict-mcp-config --setting-sources ""`,
   with the run's question as the prompt.
   - It reads the whole conversation.
   - It has no tools and no MCP, so it cannot propose, write, or reach GitHub.
   - It writes nothing back into the chat's session.

   The flags exist on 2.1.310 (`claude --help`). That a resume under `--tools ""`
   behaves as described is assumed (U4 in [`01-constraints.md`](01-constraints.md)).
2. **"It already has every read it would get from a channel."** This stands, and
   in a stronger form: **the fork's only value is what the operator said in that
   conversation.** The chat's reads of the repository, the board and other runs
   are the same reads a tool-less supervisor can be handed, or the run can make
   itself.
3. **"A chat turn is attended."** A fork is not attended, and it is not the
   chat's turn either. It is a fifth kind of agent child
   (`docs/agent/architecture/run-loop-and-child-processes.md:7`), and it has to
   be argued as one.

**What E-fork does not meet:** the run's question still enters a context built
from the operator's conversation with the most privileged model in the app, and
the answer still comes back with the authority of "the conversation that
proposed you". The fork has no tools, so a payload can only make it *say*
something (C6 rule 2). That is the whole of the defence. Prompt Infection's
finding is that saying is how the infection travels.

## 3. The workflow block cannot be the other end

A block is one headless turn that has **ended before its runs exist**: specs
become runs in `settleBlock`, after the turn's status UPDATE
(`src/lib/workflows.ts:8648`-`:8695`). Nothing resumes its session
(`src/lib/workflows.ts:8666`). Its transcript is not in retention's keep set and
ages out (`src/lib/retention.ts:748`-`:805`). And it is refused `ask_operator`
because "there is nobody watching this workflow to answer"
(`src/app/api/mcp/route.ts:2110`-`:2115`). Forking a block's session would give
a run the block's brief, which is the run's own brief one level up. **This half of
E is dropped.**

## 4. The forks

| Fork | Where E-fork stands |
|---|---|
| **Who** | A tool-less fork of the proposing chat. Only for `origin: chat` runs; the other four origins have no conversation |
| **Transport** | A blocking tool call, or at the park. Either needs [`02-what-already-asks.md`](02-what-already-asks.md) §7's bounds |
| **Claim, duration, cycles, restart** | As [D](06-option-d-tiered-supervisor.md): inside a live call, worked minutes accrue, nothing is refunded, and a restart loses the call |
| **Authority** | C2's line, enforced by the server before the fork is spawned |
| **Spend** | A resume of the whole chat. How much it reads uncached on a 100k-token conversation is U4, unmeasured |
| **Injection** | Tool-less and stateless: each fork starts from the frozen chat transcript, and nothing it says is written back. No hub |
| **Operator sees** | The question and the answer on the run page, and the chat thread untouched |
| **Providers** | The fork is a Claude child whatever the asking run's provider. A Codex run's question is answered by Claude reading a Claude conversation |
| **Too much, too little** | As D |

## 5. What the measurement says

**Zero** task questions in the window needed the operator's earlier words
([`00-problem.md`](00-problem.md) §2 (c)). The three OPERATOR-ONLY task cases
were a Mac check, a disagreement between the brief and the board's close check,
and a choice the run left to the operator, which is a decision rather than an
intent. The briefs the chat writes are long and specific: the median was 4,946
characters, and 96.9% named a file (*UsageFoundry Orchestrator Chat Quality
Proposal*, vault, `confidence: medium`, `status: archived`). The proposal
already carries the conversation's intent into the run.

## Verdict

**Rejected.** The chat-fork half rests on a value, the operator's words, that the
brief already condenses and that no measured question needed. The block half has
nothing to reach. **The fork mechanism is kept as a part:** if
[D](06-option-d-tiered-supervisor.md) is ever built, the operator's turns from the
originating conversation are what to hand it. The server reads them from the chat
messages table, with no resume and no fork, which removes the privileged context
altogether.
