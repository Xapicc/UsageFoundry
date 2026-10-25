# Workflows

[← Documentation index](README.md)

A **workflow** is a saved graph of run blocks. Pressing *Run* on one creates
every block as a run, in one pass, with the dependencies between them already
wired: the first ones queue immediately, the rest sit `waiting` until the blocks
they follow have settled. It is the answer to "the same four steps, in the same
order, every time" — the thing templates cannot do, because a template is one
run and this is the shape of several.

There are other kinds. An **orchestrator block** decides what to run instead
of being told, and its runs start without an approval — a real trade, with [its
own section](#a-block-that-decides-what-to-run) below. A **merge block** lands
the branches the blocks in front of it left behind, optionally paying Claude to
reconcile a conflict; it too has [a section](#a-block-that-lands-the-work). Its
sibling, a **deliver block**, [pushes those branches and opens a pull
request for each](#a-block-that-delivers-the-work) instead of touching your
checkout. A **gate** [stops the run until you press
Continue](#a-block-that-waits-for-you), at a point you choose. A **review block**
[judges each branch before it goes on](#a-block-that-reviews-the-work). A **loop
block** is not like the others: it [repeats a section](#a-region-that-repeats) of
the graph and starts no run of its own.

## What a block holds, and what it does not

A block holds the **work**: a name, a workspace and folder, a task, and
optionally a prompt that replaces its template's own for this block. That is the
whole list, and the omission is the point.

A block does **not** hold a budget, a permission mode, an isolation choice or a
model. It **names a template**, and every guard comes from that template; a block
naming no template runs under the untemplated guard set in Settings → *Default
guard set*, exactly as an untemplated chat proposal does. This is the same rule
the orchestrator chat follows and it is worth stating in full, because it is the
reason a workflow can be edited freely without anyone re-reading it for safety:

> The graph picks **what work to do**. Something a person wrote picks **what an
> agent may do**.

`--permission-mode` already has three narrowings and exactly two routes to it —
the run form and a saved template — and a workflow node was not going to become
a third. So a block that names a template which has since been deleted is
**refused by name** when you press Run, rather than quietly falling back to the
Settings guards: you saved a graph that said "under these guards", and a run
started under different ones is what the refusal exists to prevent. The detail
page marks such a block in red before you press anything.

## One workflow, several folders

A workflow can be saved against **more than one folder**, so one graph serves
several projects instead of being saved once per project. In the editor, add
each folder under *Folders to choose from at Run*, and switch on *Work in the
folder chosen at Run* on each run or orchestrator block that should move with
the choice. When you press Run on a workflow with more than one saved folder,
the detail page asks which one; a workflow with one saved folder uses it.

What moves, and what does not:

- **Only the blocks you switched on follow the choice.** A block with its own
  workspace and folder keeps them, whatever is chosen. Merge, review, deliver
  and gate blocks name no folder and work with the branches in front of them,
  so they follow along through those runs. A loop's *stop when the board has*
  condition keeps the project it names unless you switch on *Count the folder
  chosen at Run* on that loop; then it counts the board of the folder you
  chose, so a loop shared across projects stops on its own project's backlog
  rather than the saved project's. Switching it on needs at least one saved
  folder, and the figure the editor shows beside it is the first saved
  folder's.
- **Run only ever chooses among the folders you saved.** Nothing typed at Run
  can point a block anywhere else: the server accepts exactly an entry on the
  saved list and refuses everything else with a sentence. Every saved folder is
  checked when you save, the way a block's own folder is.
- **A schedule uses the first saved folder.** Nobody is there to ask, and the
  schedule holds no folder of its own; *Move up* in the editor decides which
  folder is first. The detail page says, under the schedule card, which one
  it will use.
- **Each press of Run keeps its choice.** The instance records the folder it
  was started against and shows it on its page; every later pass of a loop,
  every block created later and every run an orchestrator block starts uses
  that choice, even if you edit the workflow meanwhile.
- **An orchestrator block is told which folder was chosen.** Its bounds already
  name the folder it works in, and a block that follows the choice is also told
  that this folder is the project its brief is about — so one brief, written as
  "the project in your folder", serves every saved folder.
- **Two folders can run at the same time.** A press against one saved folder
  starts while a press against another is still going, as long as the two
  share no folder. A second press into a folder a press is still working in is
  refused, and Run is off for that folder with the reason beside it and a link
  to the press in the way; pick another folder and it comes back on. "Share"
  includes a folder inside another and two workspaces that are one directory.
- **A block with its own folder keeps it one at a time.** Every press of the
  workflow works in that block's folder whichever folder is chosen, so while
  one press is going every other press is refused. Switch the block to follow
  the choice, or move it to a workflow of its own, if the folders should run
  side by side.

A workflow saved before this, or one whose blocks each name their own folder,
asks nothing at Run and behaves exactly as it always did — including running
one press at a time. One limit of this first version: the chat cannot propose
a workflow with a folder list (add the list in the editor after approving).

## A block that decides what to run

The blocks above are fixed: you write the task, and that task is what runs. An
**orchestrator block** is the other kind. It holds a *brief* rather than a task,
and when the workflow reaches it the server spawns one short agent turn —
Claude Code, headless, stopped only after fifteen minutes of producing
nothing, the same child the orchestrator chat uses — which looks at the folder and decides which runs should happen next. What
it emits **starts**. No proposal, no card, nothing to click.

That is the one place in this tool where an agent's answer becomes a billed
process with nobody looking at it, so it is worth being exact about what you are
agreeing to when you save one:

| You fix, when you save the graph | It decides, when the workflow reaches it |
|---|---|
| The workspace and folder it may start runs in | Which folders under that one, and what each run is asked to do |
| The template every run it starts runs under — budget, work-cycle limit, permission mode, isolation | Nothing about any of these |
| The most runs it may ever start | How many, up to that |
| How many times a failed deciding turn is started again (0 to 2, default 0) | Nothing — a retry is the same turn run over, not a new decision |
| The standing prompt every run it starts begins with | The task appended under it |

The fan-out cap is **required**. A graph with an orchestrator block and no cap
cannot be saved, for the same reason a run with no work-cycle limit and no time
limit cannot be started: the number is the whole of what you agreed to, and
without one you agreed to an unbounded number of agents.

Its emit tool carries four fields per run — a title, the task, a folder, and
which of its siblings that run should start after — and there is no fifth. There
is no argument on it that names a template, a budget, a permission mode or an
isolation choice, so the sentence above holds by construction rather than by the
model's cooperation. A folder outside the block's own workspace is refused by
name; so is a set of runs that would wait for each other in a loop.

**A block that emits nothing stops what is behind it.** "There is nothing worth
doing" is a real answer and the block is allowed to give it. But a block set to
start after it is there to review, land or follow up on work that did not
happen — started anyway, it spends a work cycle finding that out — so it is
`blocked` instead, with a reason naming the block that decided there was nothing
to do. The same is true if the turn fails, and if it decided on runs of which
none could be started — a folder removed in between, say — in which case the
reason says that, and why, rather than blaming the decision.

**So the instance page says what it decided and why.** A block that starts
nothing ends that whole branch of the graph, and until you know which of the
several ways it did that, a workflow that ran, billed and stopped is
indistinguishable from one that never had anything to do. The row carries three
separate things. Its **reply** — the turn is asked to say what it emitted and
what it deliberately left out, and that answer is rendered under the block.
What **this tool** did to it, in its own line: an `emit_runs` call refused
because a folder was outside the block's workspace or the fan-out was over the
cap, a tool call the CLI declined on its own, a workflow limit that could not be
read at that moment, a run it decided on that could not then be started. And the **status line**, which separates the endings that
otherwise read alike — *decided there was nothing to start* means it called the
emit tool and named nothing, *ended without emitting anything* means it never
called it at all, and those are different problems.

**A turn that failed can be started again, up to a limit you set.** An agent turn
can die for reasons that have nothing to do with the brief — a dropped
connection, an overloaded upstream, a process killed. By default that ends the
block as failed and everything behind it is written off. Set *Retries after a
failed turn* on the block, 0 to 2, and a turn that failed **having decided
nothing** is started again before the block gives up. Each retry is another
billed turn, so the count is a spending limit you agree to when you save the
graph, and it is stated beside the fan-out cap on the block and on the page you
press Run from. A retry is not a new press of Run: blocks already finished are
not repeated, and the instance's workflow-wide limit is asked before each
attempt exactly as it is before the first, so a graph that has spent its limit
stops instead of retrying. What is **not** started again: a turn you stopped, a
workflow halted by *Stop* or by its own limit, a turn that decided on runs
(those are carried out), and a turn whose `emit_runs` this tool refused — that
last one is the model's decision being turned away, not the turn failing. The
instance page notes each failed attempt (*Attempt 1 of 2 failed: …*) and the
block's spend is the sum of every attempt. A retry creates no run, so it is not
counted in a loop's run limit, though its cost is counted in the loop's spending
cap and the workflow's limit. A block that failed anyway can still be decided
again by hand from the instance page, and that gives it a fresh allowance.

**Its own spend is its own.** A deciding turn's cost is bounded by Settings →
*Orchestrator chat limit*, exactly as a chat turn's is; it lands on the block, never on
a run's spend and never on the dashboard meters. It **is** counted against the
workflow's own limit below, because it is money that press of Run spent.

Everything it starts belongs to the instance: the workflow-wide limits below
cover those runs, *Stop all* takes them down, and they appear on the instance
page saying which block started them.

## A block that lands the work

An isolated run works on a branch, which is what lets several of them share a
repository — and it means a graph that builds something finishes with the work
sitting on N branches and nothing on `main`. A **merge block** is the step that
ends that. It holds no task and starts no agent: when the workflow reaches it, it
takes every branch its predecessors left and puts each one onto the target that
branch's own run recorded when it cut it.

**The target is never named here.** A run records where it branched from, and
that is where it goes back to — so a graph that runs against three repositories
lands each branch in its own, with nothing in the block saying anything about
`main`. It is the same rule the *Land* button on a run page follows.

It goes through the **merge queue** — the same one the Branches page uses when
you tick several branches and press *Queue* — so it inherits every protection
that queue already has and adds none of its own:

- **One merge at a time**, for the whole process. Each landing changes the base
  for the one behind it, so nothing is decided in advance: each branch is
  re-previewed against git at *its* turn.
- **A conflict costs your checkout nothing.** It is reconciled on the run's own
  branch in a throwaway checkout, and a failed merge is aborted before the queue
  moves on.
- **Your own checkout must be clean and on the target branch.** This is the
  honest cost of an unattended merge and it is not weakened for a workflow:
  landing onto the wrong branch is the one mistake here with no undo. A dirty
  tree, or a HEAD on the wrong branch, refuses every branch in that repository
  and the block reports it. Leave the repositories a workflow merges into alone
  while it runs, or it will tell you it could not.

Every branch it queues gets a row on the Branches page with git's own answer for
it, and the block's own line says how many of them landed.

**Letting Claude resolve a conflict is a switch on the block**, off by default.
Saving the graph with it on *is* the authorisation — the same reason ticking the
box when you queue branches by hand is, and the reason it is not a setting:
configuration that can change under a graph already running is not authorisation.
With it off, a conflicting branch is reported and left exactly as it was. With it
on, a conflict is reconciled on the run's branch by an agent that may edit files
and may not run git, and the merge is only committed after the app has checked
that no conflict marker survived. That spend lands on the block, counts against
the workflow's own limit below, and never against a run or a dashboard meter.

**A branch with nothing to land is not a failure.** A run that completed and
committed nothing, and a branch already on its target, both leave you with
exactly what you asked for, so the block succeeds and says which branches it
skipped. What *does* fail it is a predecessor that should have had a branch and
has none — isolation having degraded at run time, which is the case where saying
nothing would leave you believing work landed.

What follows a merge block follows it on its condition, as everywhere else:
*only if it completes* waits for every branch to land, *once it finishes* runs
either way. A merge block that never ran satisfies neither.

Two things it is not. It has no checkout of its own, so it cannot be at either
end of a branch hand-over. And it needs at least one block in front of it that
runs something whose guards isolate — both refused when you save the graph, not
discovered an hour in.

## A block that delivers the work

A merge block puts a branch into your own checkout. A **deliver block** is the
other way out: it takes every branch its predecessors left, pushes each one to
its repository's remote and opens a pull request for it. That is the push and
the pull request the *Open pull request* button on a run's Land card makes, one
branch after another, with nothing asking first. It holds no task, starts no
agent and spends nothing on a model.

**Your checkout does not need to be clean.** A merge block refuses a repository
whose checkout has uncommitted changes or is on the wrong branch, because it
writes into it. A deliver block does not look: pushing reads the remote and
writes the repository's `.git/config`, and leaves your working tree exactly as it
was. What it does refuse is a run still working *in that folder*, and a land or
a delivery already holding it. Those arrive as one failed branch, with the
reason.

Everything delivery already checks, it checks per branch, and adds nothing of
its own:

- the repository needs a **GitHub token** (`UF_GITHUB_TOKEN`, or an entry for
  that repository in `UF_GITHUB_TOKENS`), and a remote that is GitHub;
- the **verify command** in Settings, if there is one, runs in the run's own
  tree and has to pass;
- a branch whose history carries a file that seeding copied in, a `.env`
  usually, is refused;
- a local model's branch waits for the frontier review that Land waits for, so
  put a review block in front of it;
- nothing is ever force-pushed.

**One pull request per branch.** A branch that already has one is skipped, and
so is a branch with nothing on it or one already on its target; none of those
is a failure, and the block's line says which it skipped. What fails the block
is a predecessor that should have left a branch and left none, and any refusal
above. A branch that fails does not stop the ones after it. The block's note on
the instance page names every pull request it opened.

What follows it follows it on its condition: *only if it completes* waits until
every branch is delivered or had nothing to deliver, *once it finishes* runs
either way. A deliver block that failed is listed under *What is holding this
up* on the instance page, with **Retry delivery**. It pushes the branches that
have no pull request yet and skips the rest, so pressing it never opens one
twice, and it is offered only while nothing behind the block has started.

It does not wait for a folder that a land or a run is holding. That branch
fails with the reason, and Retry delivery is the way back in once the folder is
free.

It has the merge block's two limits. It has no checkout of its own, so it
cannot be at either end of a branch hand-over, and it needs at least one block
in front of it that runs something whose guards isolate. A merge block, a loop
or another deliver block in front of it does not count, because none of them
hands on a branch: after a merge the work is on its target, and a pull request
from it would have no commits to show. Both are refused when you save the graph.

**Because nothing asks, three places are closed to it.** A loop's section may
not hold one, since every pass would push and open pull requests, up to the pass
cap, and a pass already lands its own work through the section's merge block (or, working in the folder, has none to publish). A
workflow that holds one cannot be put on a schedule, however well its limits
bound the spend: a schedule presses Run with nobody there to look at what is
being published. And the chat cannot draft one; add it in the editor, where its
effect is stated beside it.

## A block that waits for you

Approval happens once, when you save the graph. After that the only lever is
*Stop all*, and by then there is nothing to look at: the branch exists only once
the run that cuts it has finished, and the next block has already begun. A
**gate** is a place in the graph where the run stops and asks again. Put one in
front of a merge block to read what is about to land, or at the start of a loop's
section to look between two passes.

When the run reaches a gate it waits. Nothing is started, nothing is spent, and
nothing behind the gate begins; the instance page leads with a **Waiting for
you** card naming the gate, with two buttons:

- **Continue** lets the run through. Every block that was waiting on the gate
  starts, on the condition its link says.
- **Stop all** halts the whole press of Run, the same way it does anywhere else.
  The gate and everything behind it is closed out as `blocked`, with a reason
  saying nobody let it through.

If a webhook is configured, the gate also sends one: the event is
`workflow.gate_held`, `run_id` is empty because there is no run, and `url` opens
the instance. The body is still the six fields and nothing else; the gate's
name is not in it.

**It holds nothing of its own.** A gate has no task, template, agent, workspace
or folder, and saving a graph that gives it one is refused by name rather than
quietly ignored. It needs at least one link out of it, since a gate with nothing
behind it would stop the run and release nothing.

**It hands on no branches.** Like a merge block it resolves to no runs, so
`run → gate → merge` saves nowhere: the merge would have nothing to land, and the
refusal says so. To hold a merge, link the run to the merge as well as to the
gate:

```text
build ──► gate ──► merge
  └───────────────────▲
```

The merge then waits for both, and lands the run once you continue. The same is
true in front of a deliver block or a review block.

**Inside a loop's section it holds every pass.** Each pass is the section
instantiated afresh, so each pass reaches its own gate and waits there; pressing
Continue on pass 1 does nothing for pass 2. A gate as the first block of a
section looks between two passes. While one is held the loop takes no further
pass, and *Stop after this pass* is read when that pass settles.

**Nothing ends one but you.** There is no timeout. The run reads as *started*
for as long as the gate is held, so pressing Run again is refused with the usual
sentence, and a restart of the app does not close the wait out: a held gate is
still held, and Continue still works, afterwards. A gate the run had not yet
reached is closed out by a restart like any other waiting block.

The chat can draft a graph that contains a gate. A gate starts and spends
nothing and can only make a run wait, so nothing about it needs the editor.
Nothing the chat can call presses Continue.

## A block that reviews the work

A **review block** sits between the work and the merge. It takes every branch
its predecessors left, decides which are good enough to go on, and hands only
those to what follows; the rest are **set aside** — not merged, named on the
instance page with the reason, and not a failure of the block. Under **Verdict
from** it decides one of three ways:

- **A frontier review** has a frontier model read each branch and approve or
  reject it, and can send a rejected branch back for a fix up to the block's
  fix rounds. Each review and each fix round is billed.
- **How each run ended** approves a run that completed and sets aside every
  other ending, with no model and nothing billed. Its links in have to be
  *once it finishes*, or the first run that did not complete would block it.
- **A verify command** runs a command you write, such as `npm test`, in each
  branch's own checkout, one branch after another. Exit 0 approves; anything
  else sets the branch aside, and so does a command that runs past 15 minutes
  or could not run at all — the checkout was taken over by a later run, or
  holds uncommitted edits. The instance page shows how it ended and the last of
  what it printed under the branch's row. It runs no model and bills nothing.
  A workflow that starts more runs in one repository than run at once lets a
  later run reuse an earlier one's checkout, and that earlier branch is then
  set aside without being checked.

The verify command is the one on the block, not the one in Settings, so each
workflow can check its own repository its own way. It is argv and never a shell
line, and Save refuses one that is not: for `npm test && npm run build`, put
the two in a script and name the script. It runs as the agents' user, but what
it runs — the `test` script of a `package.json`, say — comes from the branch an
agent just wrote, so it is a program you are letting that branch choose. **Only
you can set it.** The chat cannot propose a review block with a verify command,
and approving a workflow the chat proposed will not save one; add it in the
editor. A branch it approved still meets Settings' **Check that must pass before
Land merges** at the merge, if that is set.

Neither a status nor a command verdict takes fix rounds: a branch either goes
on or is set aside. Neither marks the tasks of a branch it set aside, since no
model judged the work. Inside a loop, a branch set aside with work on it keeps
the loop going to its next pass.

**Setting everything aside is not a failure.** The block is satisfied with
nothing to hand on, so a merge block behind it reports that there was no branch
to land and a loop carries on. What does fail it is a review that never
finished, such as a restart in the middle of one, and that blocks what follows,
because nothing it was given has been judged.

**A frontier review spends, and the spend is the block's.** Each review is billed
separately from any run's own spend, as the *Review* button's is
([review and land](review-and-land.md)), and lands on the block rather than on a
run. It counts against the workflow's own limit, which is checked when the block
starts. A fix run continues the same branch, briefed with the review, under the
guards of the run it continues and never wider ones; it is an ordinary run of the
instance, so *Stop all* takes it down and the workflow-wide limits cover it. In a
loop's section the review's worst case is its fix rounds for every branch a pass
can cut, which the 60-run bound below counts.

Like a merge block it needs at least one block in front of it that runs
something, and each of those has to work in a checkout of its own, since a review
is judged against the branch tip it was shown.

## A region that repeats

Some work does not fit in one run. "Work through the failing tests until they
pass" is a real task and an agent given one work cycle for it stops half way,
`completed`, with the job undone. A **loop block** is not a block that does
work: it is a **frame round a section of the workflow that repeats**. Put a frame round some blocks and every one of them runs again on
every **pass**.

> A pass is not a work cycle. A work cycle is one invocation of Claude Code
> inside a run; a pass is a whole section, each block of it a run with its own
> work cycles, its own guards and its own spend. The interface never uses one
> word for the other, and neither should you when reading a bill.

**A loop is told nothing.** It holds no task, no workspace, no folder, no
template, no agent and no standing instructions — a merge block holds none of
those either, and for the same reason: neither of them starts a run. Send one
anyway and the graph is refused by the field's name, rather than saved with the
choice quietly dropped. What a loop does hold is the pass cap, the optional
spending limit across passes, and the optional board condition; each of those
bounds the *repetition* rather than describing a run.

A loop with nothing inside it is refused too. There is no such thing as a loop
that repeats its own work, because it has none. On the canvas an empty frame is
still drawn — it is the ordinary state of one whose last member was just deleted
— so there is always something to put a block into, or to delete.

**It unrolls; it does not loop.** The obvious implementation is an edge pointing
backwards — pass 2 depends on the loop block, which depends on pass 1 — and that
edge is refused by this tool at admission, deliberately. A run whose
dependencies form a loop is never released and never terminated: it sits
`waiting` for ever, holding a prompt you believe is queued. So every pass is a
set of *fresh runs*, the run graph stays acyclic, and every rule written against
it — folder claims, releasing, landing, *Stop all* — applies to a pass with
nothing new bolted on.

**It stops on six things, and the first is what the agents said.**

| It stops when | Because |
|---|---|
| Every run of the last pass replied `DONE` | The work is finished, which is the ending you want. Every one of them, because a section can run blocks side by side and one of them finishing is not the section finishing. Read from what the agents actually said, never from a run's status — `completed` is also what a run that merely used up its work-cycle limit is written as, and that limit defaults to 1, so a loop keyed on the status would stop after every first pass |
| A block of the pass did not complete | A loop is not a retry mechanism. Connection blips and provider refusals are already retried and waited out *inside* one run, so a fault that got past those is one the next pass would meet too |
| The pass did not land everything it produced | The next pass starts fresh from the folder, so whatever was left behind is invisible to it — it would do that work again, billed, and nothing would say so. The reason names what did not land |
| The pass cap is reached | The number you agreed to when you saved the graph |
| The spending limit across passes is reached | Optional; blank means the pass cap is the only bound |
| A project's task board has fallen to one of its numbers | Optional. Repeat until this project has at most N open tasks left, or at most N of one priority — the ending for "work the backlog", which none of the four above can state. Several numbers are an **or**: the first one met stops it |

A pass that somehow started nothing at all stops it too, with a reason —
because the next one would be created the same way and fail the same way, one
billed attempt at a time.

**Repeat until a project's board is clear.** "Work through this backlog" is a
real instruction and none of the four conditions above can end it: `DONE` is one
agent's opinion of one pass, and the two caps are the loop running out rather
than finishing. So a loop may name a **project** on the [task board](taskboard.md),
a set of task states, and one or more numbers: it repeats until that project has
at most that many tasks left in those states. Zero is the usual number and means
"until the board is clear".

The project is **one choice, not two.** It is picked from the same list the
board's own project filter offers and wears the same name there — a workspace
and a folder in it are a pair, because two workspaces may hold the same relative
path and a name built from the path alone would be two projects under one
heading. Beside the picker is what that project holds *today*, counted the way
the loop will count it, so a number typed into the rows below is typed against
something real rather than against a memory of last week.

A project is **one folder**, which is how the board groups one: tasks filed
against `…/terraServe` and against `…/terraServe/docs` are two projects on that
page. A switch widens the count to the folder and everything under it, and it is
off by default — a loop that quietly merged them would be working a backlog
nobody was shown.

**Up to five numbers, and any one of them ends the loop.** "Under 10 tasks left
for this project, or under 5 normal-priority ones" is one condition with two
numbers in it, and the loop stops the first time either comes true. That is an
*or* rather than an *and* on purpose: a loop is billing a whole run per pass, so
the condition that ends it earlier is the safe one — an all-of reading would keep
a loop going on a board nobody thought was full. Each number may name a priority
or count the project whole, no priority twice, and the stop reason names the one
that was met with its priority and both figures — "at most 5 normal-priority open
task(s) left. It has 4." A loop that only said "the board is clear enough" would
be unreadable the next day.

A loop saved before there was more than one number still reads exactly as it
did: its single figure is one number over the project whole, and nothing about
it changes.

It counts **open** tasks by default, and can be told to count claimed ones too.
Counting claimed is offered because a task another run is holding is genuinely
not done, but it is not the default and the reason matters: a claim on this
board is a record of which run took a task, never a lease, and nothing expires
one. A single task left claimed by a run that died therefore holds the loop open
for every pass it is allowed, one billed run at a time, until the pass cap
catches it. Closed states cannot be counted at all — `done` and `dropped` only
ever grow, so "at most N" against one is true the first time it is asked and the
loop would stop before it started. A graph that asks for one is refused at save
with that sentence.

**The count is taken before every pass, including the first.** A loop pointed at
a project that is already clear starts no run at all, which is most of what the
condition is worth having for — the two caps can only ever be read after a pass
has settled, so without it the cheapest way to discover there was no work was to
pay for a whole run. If the project cannot be counted — a workspace that is not
mounted right now, a folder that has gone — the loop ends and says so, rather
than reading the failure as an empty backlog; zero is the one answer that stops
it, and a project this app cannot find is not a finished one.

There is deliberately **no shell predicate** — no "repeat until `npm test`
exits 0". Running one would be a fifth kind of child process in a tool that has
exactly four and treats adding one as a decision rather than a detail. Ask the
agent to reply `DONE` when the tests pass; that is the same test, run by
something that is already there.

**The pass cap is required**, for the reason a run needs either a work-cycle
limit or a time limit: a loop decides for itself whether to start another billed
run, and without a number that only goes up there is nothing that has to end. A
graph with a loop block and no cap cannot be saved.

**Neither cap is a guard.** Every block of every pass takes its budget,
permission mode, work-cycle limit and isolation from its own template — or from
the untemplated guard set in Settings — exactly as every other kind of block
does. The loop names no template, because it starts nothing. The two numbers on
it bound how many times the section *repeats*; they can only ever end it
earlier, they can never raise what a pass may spend, and the workflow-wide
limits below still apply on top of them.

**Each pass lands its own work, or has nothing to land.** A section is one of
two kinds, decided by its blocks. If any block works in a checkout of its own —
a run or orchestrator block whose guards isolate, or a review block — the
section **lands**: it ends in a merge block (or, below, in a tail that works
in the folder), that block lands what the pass produced, and the next pass
starts from the landed branch. There is no ref
handed from one pass to the next and no *Land* button waiting at the end of the
loop: by the time a loop hands on, everything it did is already on the target.

That is why a landing section's exit has to be a merge block rather than merely
being allowed to be one. A section that does not land leaves the next pass
working from a branch that cannot see what the last pass did — nothing fails,
nothing is refused at run time, and the agent simply starts again on work it
already did, one billed pass at a time until the cap catches it.

If **every** block works directly in the folder, there are no branches: each
pass's work is already in the folder, so the next pass sees it with nothing to
land, and the section may end at any block. The canvas marks that exit **ends
the pass** instead of *lands the pass*. A merge block in such a section has
nothing to land and is refused with that reason.

A landing section may also **end in the folder**. After its last merge block it
can hold blocks that work directly in the folder — a run or orchestrator on a
template that does not isolate, or a gate — and the last of them is then the
exit and *ends the pass*; the merge before it *lands the branches*. This is the
one place the two kinds meet, and it is safe because those blocks start only
once every merge in front of them has finished landing, and the next pass
starts only once they have finished too. Everything before the merge still has
to isolate and still has to be handed to a merge.

The next pass is created only once the previous one has settled, which means
that between two passes there is briefly nothing running. That is intended: four
of the five exit conditions are facts about the pass that just ended, and a pass
created before them would have to be withdrawn. The board condition is the
exception — it is a fact about the board at that moment, which is what lets it
be read before the first pass as well as between them.

## What a section may be

**What is inside the frame is what repeats.** The section is the block each pass
starts at and everything linked after it; whatever comes after the loop is
linked from the frame itself. That is the whole mechanism — the frame is read
off the links rather than stored as a rectangle, so there is nothing else to
tick and no second list to keep in step. Move a member across the canvas and the
frame follows it; drag one right out from between the others and the frame
stretches to hold it, because it is still linked into the section whatever it
looks like.

"Plan the next slice, do it, write down what changed, land it" is four different
jobs and four different prompts, and a single block asked to do all four every
pass is one agent losing the plan in its own context.

That is also why there is no task to write on the frame: every run of a pass is
a member's and each member carries its own, so there is nothing left for the
frame itself to say. A task sent on a loop anyway is refused by the field's name
when you save, along with the workspace, folder, template, agent and standing
instructions — the same list as above, for the same reason.

**Drawing it: a loop is a frame, and you make one by framing blocks.** There is
no Loop in the palette, because a loop with nothing inside it is a graph that
cannot be saved — making one *is* framing something. Click a block, shift-click
any others you want in from the start, and press **Repeat**. A frame appears
round them.

What the frame then holds is not the list you clicked: it is the block you
marked first **and everything linked after it**. So marking the head of a chain
and marking the whole chain do the same thing, which is also the gesture on a
phone, where there is no modifier to hold — tap one block, press Repeat, and the
chain it starts is framed.

**Putting a block in and taking one out are gestures on the frame.** Press
**Put in** on the frame's own strip and then a block, the way **Link** works: by
dragging onto it, or by pressing the handle and then the block. A block already
inside comes out again the same way, and the handle stays armed so a section is
assembled in one go rather than one round trip per block. Taking a block out of
the middle of a section **splices** — the blocks after it stay in the frame,
linked on to what came before it — because this app has no undo and losing four
blocks to a gesture aimed at one is not recoverable.

Deleting the frame unmakes the loop and leaves every block that was inside it
exactly where it was.

**The frame is the whole of how a loop is drawn.** It has no card of its own:
what a loop *is* is a boundary round a section, and a card beside its members
would draw it as a seventh block in a graph of six. Its strip carries the name,
how many blocks are in the pass, the pass cap and what ends it, plus its two
handles — **Put in**, and **Link** for what runs before and after the whole
loop. Each member is marked with where it sits in the pass: *starts a pass*, *2
of 3*, *lands the pass* (*ends the pass* in a section that works in the folder). So "what runs first" and "where the work lands" are
answerable by looking.

There is **no arrow for containment**. The frame says it. An arrow from the loop
to the block its pass starts at would read as "the section runs after the loop",
which is exactly what a loop is not.

The loop's own panel reads the section back in pass order; it is a statement,
not a control, because the canvas is where it is said. Nothing on the page
decides whether the section is *legal*: the sentence under the canvas is the
server's answer and it names the block at fault.

**The link into the frame is refused as you draw it.** A block outside cannot
start a block inside — see below — and the canvas says so at the moment you let
go, naming the frame to link to instead. Waiting for Save would mean drawing an
arrow, watching it appear, and then reading a sentence about one of its two
ends.

**One way in and one way out.** The way in is the frame's **entry**, the block
each pass starts at. The way out is its **exit**, the single block the section
ends at. In a landing section it must be a merge block, or the last block of
its in-folder tail; in a section that works in the folder throughout it may be
any block. Both are marked on the frame.
Between those two ends the shape is free: the section may fork, and two branches
that fork may meet again at the merge that lands them both.

Three things are refused, each naming the block to fix:

- A section that **ends in more than one place**. The second ending is a block
  whose work nothing lands, which is the same defect as a member with no path to
  the exit — link it on towards the block that lands.
- A landing section whose **last block is not a merge block**. Add one at the
  end and link the last block to it, or give every block of the section guards
  that work in the folder, so there is nothing to land. If the last block
  should work in the folder, keep it after every merge block and give it a
  template that does not isolate. When it is on the default guards the
  sentence says so, because those isolate whenever Settings do.
- A **link from a merge block into that tail set to start either way**. A merge
  that failed has still finished, and it can leave the folder part-way through
  the merge; set the link to start only if the merge completes.
- A **link across the boundary**. A block outside the frame cannot link to a
  block inside it: link it to the frame instead, and the loop hands on to it
  after the last pass. Otherwise "when does this block start" has two answers —
  once, or once per pass — and only one of them is what anybody meant. The canvas
  says this one as you draw it rather than waiting for Save.

**A section holds run blocks, orchestrator blocks, review blocks and merge blocks.** A loop
inside a loop is left out, and it is refused by name: one pass cap multiplying
another is a number nobody can work out from the two they typed. Repeat one
section, not a section that repeats. A deliver block is left out too, for a
different reason: it publishes, and a section would publish once per pass.

**A section is not mixed, except at its end.** In a landing section every run
or orchestrator block needs guards that isolate, because it has to leave a
branch for the section's merge block to land. One whose guards work in the
folder is refused there, naming the block that makes the section a landing one
and where that block's checkout comes from (its template, or the default guards
in Settings). Three ways out: give it guards that isolate, make every block of
the section work in the folder, or move it after the section's last merge block.
Landing a branch into a checkout that the same pass is also editing in place is
not a state this tool supports, so a block that works in the folder before a
merge, beside a block that isolates, or followed by one is refused rather than
half handled. A merge block has no guards, so it is never asked. The switch
**Work in the folder chosen at Run** only picks *which* folder; whether a block
gets a checkout of its own comes from its template, and the block's inspector
says which it is.

**Count the runs before you press Run.** A section multiplies, and an
orchestrator block in one multiplies twice over — its fan-out cap is what it may
start *each time it is reached*, and a section reaches it once a pass. So one
pass is:

> one run for each run block, **plus** for each orchestrator block the deciding
> turn and every run its fan-out cap allows.

A merge block is neither: it lands branches and starts no run, and a section
that works in the folder is counted the same way. Three run blocks
and a merge over 10 passes is 30 runs; swap one of those for an orchestrator
capped at 5 and the same 10 passes is 80. A loop whose worst case is more than
**60 runs** is refused when you save it, with the arithmetic spelled out and
every factor named. The spending limit across passes is the other bound and is
worth setting here more than anywhere else in this tool.

A block set to start after a loop starts after its **last** pass, from whatever
that pass landed. The count shown on the block is **passes**, not runs: a
three-pass loop over a two-block section says three.

## Limits for the whole workflow

A block's guards bound one block. Ten blocks under a $5 block limit is a $50
workflow, and until you set one of these nothing stands between you and that
number. Three limits sit on the workflow itself, all of them optional:

| | |
|---|---|
| **Spending limit** | Everything every block of one press of Run spends, together |
| **Stop at 5-hour usage** | Stop the whole workflow once the 5-hour subscription window passes this share |
| **Stop at weekly usage** | The same for the weekly window |

They mean exactly what the identically-named per-run guards mean, and they are
decided by the same function and the same vocabulary — a fraction guard with no
ceiling behind it is **refused, not ignored**, and every comparison is made
against the guard reading rather than the displayed one, so a model with no known
price cannot make a workflow look cheaper than it is.

These are the one thing on a workflow that is a guard rather than work, and they
live in the workflow's own form. There is no field for them on the wire when you
press Run, no override anywhere, and no route that edits a running instance's
copy — which is what stops an orchestrator block from raising its own workflow's
budget. Editing the workflow while an instance is running does not move the
guard that instance is measured against either: the limits are copied onto the
instance when Run is pressed, exactly as the graph is.

**When they are checked, and by how much a workflow can overshoot.** Before a
block starts a work cycle, and again as each block finishes — never during one,
which is the analogue of the per-run *between cycles* mode and the only
accounting here that is exact. Blocks are usually one cycle each, so in practice
that is between one block and the next. The cost is stated rather than hidden:
**a block already working carries on until it or another block reaches one of
those boundaries**, so the total can overshoot by up to one work cycle for each
block running at the time, and blocks running at once multiply that. There is
deliberately no live mode: killing every block mid-cycle would turn each one's
measured cost into a reconciled estimate, in exchange for a bound that is already
one cycle in the ordinary case.

The second boundary is why a block finishing is checked at all. A graph of blocks
that all start at once, each running a single work cycle, has no boundary
*before* any of them — every block is already working before any has spent
anything, so a check made only before a cycle starts had nothing to compare and
the workflow-wide limit could not fire. The first block to finish is the boundary
that case needs. **Settings → Runs at the same time** still narrows the
overshoot: with a cap of one, a five-block graph is checked before and after each
block rather than five times against zero.

When one trips, the workflow is halted through the same door *Stop all* uses, and
the instance records that its **budget guard** stopped it rather than you.

The one verdict that does **not** halt a running workflow is "no ceiling
configured". That is refused when you press Run, where refusing costs nothing.
Acting on it afterwards would mean the reading going away stops a graph
mid-flight — and on a stock install that reading is the account's own percentage
from Anthropic, which is discarded after an hour without a fresh answer, so an
unreachable host would kill every workflow carrying a fraction guard and every
in-flight cycle with it. It is not ignored: the block whose check found it writes
a line into its log saying the guard had nothing to read.

**What the figure is made of.** `spent_usd` moves only when a block's CLI emits
its `result` event, so a cycle in flight contributes nothing to it for its whole
duration — that figure is a floor and the instance page labels it as one. The
guard adds two readings on top: a reconciled estimate for cycles killed before
they could report, and Claude Code's own per-request telemetry for the cycles in
flight. Neither ever reaches `spent_usd`, the dashboard meters or any of the
three cost sources. It is the same measured-versus-guarded split the window
meters already make, drawn the same way: solid fill for what was measured, a
hatched band past it for what the guard acts on.

There is deliberately **no cycle or time limit** for a workflow, and it needs
none. A run loop needs a monotone terminus because the loop manufactures its own
next unit of work; an instance manufactures nothing. It is a finite graph created
in one pass, and every block in it already carries a terminus of its own, so a
workflow with all three limits switched off still ends — when its last block
does.

## Links between blocks

A link says "start this block after that one", and carries two things:

| | |
|---|---|
| **Condition** | *Only if it completes* (`on-success`) or *once it finishes, either way* (`on-finish`). Never defaulted: `on-success` would end a chain the operator meant to run regardless, `on-finish` would start a run on top of a dependency that crashed, and both mistakes are silent. |
| **Carry on its branch** | The successor extends the predecessor's branch instead of cutting a new one from the target. At most one link into a block may set it, and at most one block may take over any given branch. |

A block with no incoming link starts as soon as its folder is free. **Several
such blocks is the parallel case** — there is no separate "parallel" concept to
configure, and none in the interface. A block with two incoming links is a
fan-in; it starts when both have settled.

## Drawing one

The editor is a canvas. Drag a block off the palette onto it, or press Enter on
the palette to place one; drag from a block's *Link* handle onto another block
to make the second start after the first, or press Enter on the handle and then
Enter on the target. The link's own control on the canvas is where its condition
is set, and it reads *needs a condition* until it has one — a drawn link is
never quietly given a default. Delete or Backspace on that control removes the
link. Everything a block holds is edited in the panel beside the canvas, which
follows whatever is selected.

Each of those three — add a block, link two, remove a link — has a keyboard
route as well as a pointer one. Arrow keys move a selected block, Escape gets
out of linking, and nothing on the canvas is reachable only by dragging.

**A block's position is not part of the workflow.** It lives in this browser,
keyed by workflow id, and the graph is untouched by a drag: moving a block two
inches is not a change to what runs, and it does not bump the workflow's
`updated_at` or show up in what an instance records. Where nobody has dragged
anything the arrangement is derived from the edges themselves — layered left to
right, everything that starts immediately in the first column — so a graph saved
before the canvas existed opens readable, with no migration in front of it and
therefore nothing that could lose a link on the way in. The cost is the obvious
one: an arrangement you made by hand does not follow you to another browser, and
that browser draws the derived one instead.

While you draw, the editor asks the server the same question *Save* will:
`normalizeWorkflowInput`, over `/api/workflows/validate`, with the answer shown
in its own words rather than a generic "invalid graph". Nothing in the browser
decides what a workflow may be — a second copy of those rules would be a second
set to keep in step. *Save* stays pressable even while that check is refusing:
the check is advisory and can itself be unreachable, and a check that could not
run says so rather than reading as approval.

## What is refused, and when

A workflow that can be saved but never started fails weeks away from the form
that caused it, so both moments check the same things: a name, at least one
block, a task on every block that runs one — every block but a merge block, a
deliver block, a gate, a review block and a loop that repeats a section, none of
which is sent one — a
template that
exists, a workspace that is
mounted and a folder that resolves inside it, a condition on every link, no
block waiting for itself, no loop, no branch hand-over between blocks whose
guards do not isolate — nor one touching an orchestrator, merge or deliver block,
none of which has a checkout and so none of which has a branch — a fan-out cap on
every orchestrator block, and, on every merge block, a strategy and at least one
predecessor that runs something whose guards leave a branch; a deliver block
needs that predecessor too, and is refused inside a loop's section. A gate is
refused when it carries a task, template, agent, workspace or folder, when it has
no link out of it, and when it is the only thing in front of a merge, deliver or
review block. Every refusal names the block it is about.

The workflow-wide limits are the one exception, and only in one direction: a
fraction guard with no ceiling behind it saves fine and is refused at Run. A
ceiling is a Settings value that can be typed at any moment, so such a graph is
not unstartable — only unstartable today. The editor warns beside the field; Run
refuses with a snapshot in hand.

## Pressing Run

One press creates every run in a single synchronous pass, in topological order,
so each block's dependencies already exist as rows by the time it is admitted.
That pass has no `await` in it, and that is a correctness requirement rather
than a style: the folder claim that keeps two agents out of one directory is
only atomic within one event-loop turn.

A graph with an orchestrator, merge or deliver block in it is created in stages
instead, for the obvious reason: the blocks behind one cannot name runs that a
model has not decided on yet, or that a merge or deliver block will never create
at all. Those blocks
are created when the block in front of them finishes, and until then they hold
nothing at all — no folder, no checkout, no place in the queue — so they cost
exactly as much as a `waiting` run does, which is nothing. The instance page
lists them the whole time, so a block that is pending and a block that quietly
vanished never look alike.

It is **all or nothing**. Everything checkable is checked before anything is
created, so a failure part-way through should be unreachable; if one happens
anyway, the runs already created are stopped and the instance is recorded as
`not started` with the reason. Half a graph is not a smaller workflow — its
successors were never created, so what would be left running is a prefix nobody
asked for.

On a workflow saved against more than one folder, the folder picker beside Run
decides which one the blocks that follow the choice work in — see *One
workflow, several folders* above.

Starting a workflow whose previous press still has unfinished runs is
**refused**, with a count and a sentence. The second instance would point the
same blocks at the same folders, and a block set to carry on a branch would be
refused mid-pass because the first instance's run already continues it.

## Watching one

Every press of Run gets its own page, listing each block with its run's live
status, what it waited for, its cycles and its spend, and a link through to the
run itself. The runs also appear on the *Runs* page like any others — a chain
reads there as `blocked`-then-`queued` as it advances, since a `waiting` run
holds no folder, no checkout and no place in the queue until the runs ahead of
it settle.

The workflow's own page lists every press of Run with what became of it.
**working** means something in it is still going, and the count beside it says
how much; **finished** means the graph reached its end — which is a fact about
the graph and not about the work, so a block that failed is still on its own row
to be read; **blocked** means part of it never ran at all, because a block in
front of it ended in a way its link could not accept, and the count is how many
blocks that was. The last of those is the one to open: nothing is coming, and
the block that decided it says so on the instance page.

**A loop's passes get a card of their own**, one per loop, under the tables of
runs. A pass is several blocks of several kinds, so it is drawn as a group: its
members in pass order with their own statuses and spend, the runs an
orchestrator member decided on underneath that member, and what the pass
**landed** — which is the fact that decides whether the next pass could see this
one's work. A pass that landed nothing leaves the next one starting where this
one did. The loop's own row in the table above still reads in passes rather than
runs: a three-pass loop over a two-block section says three.

The instance keeps its own copy of the graph and of the workflow's name, so
editing or renaming the workflow afterwards cannot rewrite what it says
happened — including the order the pass ran its blocks in. Deleting a workflow takes those records with it and **no run**: the
runs carry their own prompt, guards and history. It is refused while runs it
started are still going, because those records are the only thing saying where
those runs came from.

## Stopping one

*Stop all* on an instance page halts the whole press of Run, whatever state each
block happens to be in. There is one of it, and only the recorded reason differs
between an operator pressing it and an instance budget guard tripping — a second
implementation of "which blocks does this take down" is a second chance to miss
one, and a missed block goes on spending under a workflow the page says is
stopped.

What each kind of block becomes:

| Block was | Becomes | How |
|---|---|---|
| working now | `stopped` | The same kill ladder the *Stop* button on a run uses — `SIGINT` first, so a cycle that can still report its own cost does |
| queued or parked | `stopped` | Closed out before it can spawn |
| still `waiting` | `blocked` | Nothing ran and nothing was spent, which is what that status says. Everything behind it gets its own reason naming the block in front of it |
| held at a gate | `blocked` | The same, with a reason saying nobody let it through. Continue is refused from then on |
| deciding now | `failed` | Its child gets the same ladder. `failed` rather than `blocked` because that turn was billed, and the row carries what it cost |
| waiting to decide | `blocked` | Nothing was spawned and nothing spent |
| already finished | untouched | Rewriting a completed block as stopped would destroy the record of work that landed |

**The door is closed before anything is signalled.** The instance is marked
*stopping* first, in the same event-loop turn that then walks the blocks, so
nothing can join it behind the stop — and the blocks still `waiting` are closed
out *before* the working ones are signalled, because stopping a run releases
whatever was waiting on it and a block released a moment too early would start
*because* the workflow was stopped. Blocks that decide go first of all, for a
sharper version of the same reason: one left deciding while the walk ran could
start runs into a workflow that is being taken down, and every one of them would
be a block the halt had already walked past. Pressing Stop twice does nothing
the second time.

**What survives it.** Anything an agent committed is on its branch, untouched.
Anything it had not committed is still in its checkout, on that run's own branch,
and the run page's *Commit* is how it gets onto the branch — the halt never
commits, never removes a checkout and never touches a branch. Spend is accounted
for the same way a single *Stop* accounts for it: a cycle killed before Claude
Code reports its cost is estimated from the transcript into `spent_usd_est` and
never into `spent_usd`. A merge already in flight is left to finish; queued
merges for those branches are cancelled.

The instance records that it was stopped, by what, and when. A block's own
reason says which of the three it was — halted with its workflow, halted by that
workflow's budget guard, or stopped on its own run page — because ten rows
reading "Stopped by operator" say nothing about whether someone stopped ten runs
or one thing stopped all of them.

Stopping is terminal. There is no pause-and-resume for an instance: a stopped
one cannot be un-stopped, and starting the workflow again is a fresh press of
Run with fresh runs. That holds one block at a time too — the run page of a
halted block offers no *Try again* or *Resume*, and asking for one anyway is
refused with the workflow's name. Picking one block back up would have it
working, and spending, under an instance the page reads as stopped, where the
workflow's own budget guard can no longer reach it; and reopening the *stopped*
block in front of a chain would have woken the blocked ones behind it too.

## On a schedule

A workflow can press its own Run. **This is the only thing in the app that
starts a billed agent with nobody present** — the run form, the chat's approval
gate and the Run button all have somebody there at the moment the spend begins —
so it is worth being clear about what does and does not change.

What does not change: **guards**. A schedule calls exactly the same
`startWorkflow` the button does, so every block still runs under the template it
names or under the untemplated guards in Settings, the workflow's own limits
still bound the whole graph, and *Stop all* still halts it. There is no field on
the schedule form, no argument on the API and no column in the database that
could set a permission mode, a budget or an isolation choice. The schedule
decides *when*; a person already decided *what* and *how much*. On a workflow
saved against more than one folder, that includes *where*: a schedule always
starts in the first saved folder.

**A workflow with no limits of its own cannot be scheduled.** If *Limits for the
whole workflow* is empty — no spending limit, no 5-hour guard, no weekly
guard — the schedule form refuses with a sentence, and so does every fire if you
clear those limits afterwards. This is deliberately a refusal rather than a
warning: a warning is read once, when the schedule is created, and the spend it
is about happens every night for the next month. Any one of the three is enough.
The two window guards are the ones that bound *repetition* rather than one press,
since a graph that would start into an already-spent window is refused at the
door.

**A workflow with a deliver block cannot be scheduled either,** whatever its
limits. They bound what a press of Run *spends*, and what a deliver block does
is publish: it pushes branches to a remote and opens pull requests, which is not
spend and is not undone by a limit. A schedule presses Run with nobody there to
look at what is being published, so the schedule form refuses it with a
sentence, and so does every fire if the block is added afterwards. Run it by
hand.

**A workflow with a gate can be scheduled, and the run will stop at it with
nobody there.** A gate spends nothing, so no limit above has anything to say
about it. What it does to a schedule is hold the instance open: a window that
arrives while the previous instance is waiting at a gate is skipped, not queued,
like any other overlap, and is not made up afterwards. Nothing starts again until
someone presses Continue or *Stop all*. The schedule card says so while you set
the schedule up, and again for as long as the workflow has a gate. If a webhook
is configured, reaching the gate sends the notification above.

**How often.** Three choices, and no cron expression:

| | Reads as | DST |
|---|---|---|
| Every day at a time | `Every day at 09:00 (Europe/Berlin)` | follows the clocks |
| Every week on a day | `Every Monday at 07:30 (Europe/Berlin)` | follows the clocks |
| Every N hours | `Every 6 hours`, counted from when you saved it | fixed interval — unaffected |

The card states the **next fire time as an absolute instant**, not "in about an
hour". A schedule you cannot verify at a glance is one you will not leave an
unattended agent behind.

**Timezones.** The container runs in UTC and you do not, so the zone is stored
with the schedule and shown beside the time. The form fills it in from your
browser. A zone name the server's ICU does not recognise is **refused** rather
than quietly replaced with the server's — elsewhere in this app an unknown zone
falls back, because a calendar chart cut an hour out is a mistake you can see,
where a schedule an hour out is an hour out for months. On the spring-forward day
a time inside the gap (02:30 where the clocks go 02:00 → 03:00) fires an hour
later that day rather than not at all; on the fall-back day a time that comes
round twice fires once.

**A missed window is not made up.** If the container was down at the fire time,
the restart records it as missed and starts nothing — the same rule a queued run
and a queued merge already follow, that a server coming back up must not start
unattended work because of something that should have happened hours ago. The
card says what was missed and when.

**An overlap is skipped, not queued.** A workflow that is still running when its
next occurrence comes round is skipped with a reason, and the occurrence after
that is the next chance. Only a press that shares a folder with the one the
schedule would start counts: a press you started by hand against another saved
folder does not cost the schedule its window. Repeated skips read as one state with a count —
`skipped ×14 since 03:00` — rather than fourteen rows saying the same thing.

**Pause and remove.** *Pause* stops it firing and keeps everything else; the card
still says when it would fire if resumed, and the paused stretch records no
missed windows. *Remove* deletes the schedule and touches neither the workflow
nor anything it has already started.
