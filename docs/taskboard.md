# Taskboard

[← Documentation index](README.md)

A backlog. A **task** is a brief — the text somebody or something is handed with
nothing else to go on — filed against a project folder, with a priority and a
status. Writing one down costs nothing and starts nothing; turning one into work
is a separate press.

The pane sits under Runs, at ⌘4.

## What a task is not

It is not a queued run. Filing a task claims no folder, takes none of your
concurrency, spawns no process and spends nothing. Nothing on the board is on a
timer, nothing expires, and no task starts itself — the day you have fifty of
them the container is doing exactly what it was doing with none.

## Statuses

| Status | Means |
|---|---|
| `open` | Filed, nobody is doing it |
| `claimed` | A run is doing it now, and the board names which |
| `done` | The work was finished |
| `dropped` | You decided it should not happen |

`claimed` is a record and not a lock. It has no expiry: a run can be parked for
days behind a provider's weekly wall and still legitimately hold its task, so a
claim that has gone stale is yours to release — the Release button on the row —
against a run whose status you can see on the same screen.

Only you can drop a task, delete one, or re-open a closed one. A re-open clears
the record of which run had claimed and completed it, because a task that is
open while naming the run that finished it is a row contradicting itself.

## Who else can reach it

Three kinds of agent, each with a different half of the board.

**The orchestrator chat** reads the board, files tasks, and can name a task on a
run it proposes to you. It cannot close anything.

**A workflow block** reads the board and can name a task on a run it emits. It
cannot file one: a block runs unattended, and a backlog written by something
nobody is watching is one you meet already full of an agent's own idea of the
work.

**A work cycle** — the agent doing the work — is off by default. Switch on
*Let runs use the taskboard* in Settings and a run can:

- list the task it was started for and what else is open in the folder it is
  working in;
- mark **that** task complete, and only that one;
- file a new task for something it found and should not fix itself.

It cannot complete a task it was not given, start anything, approve anything,
touch another run's work, or see the rest of your board. The refusal is enforced
against the run's own credential rather than against anything the agent says, so
an agent that asks to close a task it does not hold is refused rather than
believed.

It is off by default because it is a write into this app's database from an
agent nobody is watching. While it is off, nothing on that path runs at all.

The last of those three is the useful one in practice: a run that finds a second
problem writes it down and carries on with the change you asked for, instead of
widening its own diff into something you have to review as two changes.

## Starting work from a task

Approve a proposal that names a task, or emit one from a workflow. The run
carries the link, and claims the task when it starts.

Naming a task does not close it. A run can finish having stopped on a budget,
been cancelled, or decided the work was wrong, so nothing derives "done" from a
run's status — completion is the run saying so in its own name, or your press.

Deleting a task a run was started for does not disturb the run. It goes on
saying it was started for *a task since deleted*.

## Checking the work before the task closes

*Check a task before a run closes it*, in Settings, is off by default. Switch it
on and a run marking its task complete no longer closes it outright: what that
run has committed to its own branch is read against what the task asks for, by a
separate agent that is shown the task and the diff and nothing else, and the task
closes only if that reading finds the work there.

If something the task names is missing, the task **stays open and stays that
run's**, the run is told what was not found, and it gets another work cycle to
finish it — including when it had already used up the work cycles you gave it.
That extra cycle is bounded by *Extra work cycles a check may buy*, and it is the
only limit a check can move: the time limit, the run's spending limit, both
window guards and the daily ceiling still end the run exactly as they would
have. Set the number to zero and the task is still held open and you are still
told why, but nothing is bought.

Everything else closes the task exactly as it does today: a run working in a
shared folder rather than on its own branch, no free slot to run the check in, a
check that fails or times out, and a reading that cannot tell — which is a real
answer and a common one, because plenty of tasks have deliverables a diff cannot
show. **The check can only ever delay a close the run could have made.** It never
closes a task the run does not hold, and if you take the task back, drop it or
close it yourself while a check is running, your decision stands.

Two things worth knowing before you switch it on. It costs money on its own,
once per task a run tries to close, with nobody pressing anything — *Limit per
check* is a hard stop inside the CLI and the spend counts against your daily
ceiling. And it is a second model reading a diff, not a test suite: it can say
the change is *present*, never that it works, and it is wrong in both directions.
`docs/verification.md` records what has and has not been measured about it.

## Filtering

The board draws every status group at once and filters by project in the
browser, so switching projects does not re-request. If your backlog outgrows one
page the board says so above the rows rather than quietly showing you part of it.
