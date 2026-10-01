# Option B: a per-project notice board

## 1. Its strongest case

The duplicates in [`00-problem.md`](00-problem.md) §3 share one pattern. A run
finds something at the scale of the repository ("`make check` fails on main",
"`EraseReported.swift` does not compile on Linux"), and every sibling then finds
it again. A board scoped to the repository, where the first finder posts "main is
red because of X, I am on it", reaches every sibling whether or not they hold a
task. The taskboard cannot do that: a note goes on a task, and the siblings who
need it hold other tasks.

It is also what the vault calls the alternative to message passing: "a shared
filesystem or blackboard: agents keep lightweight identifiers … and load just in
time" (*Sub-Agent Architectures*, `confidence: medium`, `status: growing`).

## 2. Shape

- **Store.** A `project_notices` table: `id`, `folder` (the `runs.folder` key,
  `src/app/api/mcp/route.ts:3800`-`:3803`), `author_run_id` from the token,
  `body`, `created_at`. It is append-only, on `task_comments`' rules
  (`docs/agent/taskboard/comments.md:7`-`:18`).
- **Write.** `post_notice` on `RUN_TOOLS`.
- **Read.** The brief's form is "shown to a run at the start of each cycle". The
  variant this survey can defend is pull-only: notices come back in
  `list_my_tasks` beside `openInFolder`, newest ten, so no tool definition is
  added for reading.

## 3. When a message is read

**Shown at the start of each cycle**, a notice goes into the `-p` text the app
composes (C2b). The appended prompt is excluded by rule. So a sibling's words
arrive in the slot the app uses for the validator's verdict, with the app's
authority. C8 rule 3 refuses exactly that, and the board's own rule for notes
refuses it for the same reason (`docs/agent/taskboard/comments.md:63`-`:69`).

**Pull-only**, a notice arrives when the agent next calls `list_my_tasks`,
framed as a list of notes, each signed by a run.

## 4. Metering and guards

A notice starts nothing and cannot extend a cycle: it is a row, read on request.
It must never be a `countBoardCondition` input, or a notice would steer a
workflow loop (`docs/agent/taskboard/operator-only-and-release.md:70`-`:75`).

**C4 is where it is weakest.** "Everyone stop editing `CLAUDE.md`, I am
restructuring it" is a notice. Siblings that obey have had their scope narrowed
by a peer, and nobody approved that. Narrowing is not widening, but it is still
a run setting another run's terms.

## 5. Restart

It survives, as rows. Nothing about a notice may cause work at boot (C6).

## 6. What the operator sees

A new page or panel listing notices per repository, with each notice's author
run linked. This is new UI, because the run page shows only that run's events.

## 7. Isolation and injection

This is the option C8 was written against. A notice board is a **broadcast**
topology: one post reaches every sibling on the repository, and every later run
until it is read past.

- *Prompt Infection* finds systems "highly susceptible, even when agents do not
  publicly share all communications". A board shares all of them.
- A run that read a poisoned file can post the payload. Every sibling reads it
  as a peer's finding, and any of them can post it again.
- Forwarding (C8 rule 1) cannot be prevented by schema when the body is free
  text. It can only be made visible.

Tagging each notice with its author is LLM Tagging, which the paper found works
only "when combined with existing safeguards".

## 8. Cost to build

- One table and one tool.
- The read folded into `list_my_tasks`.
- An operator page.

That is about 1-2 days. The standing cost is one tool definition,
$8.14-$8.26 a week (C10), paid whether or not anyone posts.

## 9. What would have to be true

- Repository-scale findings are a large share of what siblings re-derive.
  Measured: one case of nine filings, one of three.
- Siblings would read the board before acting. Its only analogue,
  `list_my_tasks`, was read by every one of the nine filers, so the read is
  plausible.
- They would find the notice in it. The same nine show that a read list is not a
  searched list.

The measured duplicates were in fact solved by data the board already had: the
first filer's task. The board needed searching, not a second store.

## Verdict

**Rejected.** It answers the measured need with a second store next to the one
that already held the answer, and it does so in the broadcast shape C8 ranks
worst. Its one real advantage is reach beyond task holders. A board search
(Option G2) gets most of that, because a repository-scale finding is already
filed as a task by whoever found it first.
