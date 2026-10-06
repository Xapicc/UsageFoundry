# The folder claim, the slot walk and the server lock

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing createRun/promoteQueued in orchestrator.ts, serverLock.ts, db.ts, instrumentation.ts.**

This file is an index. Each line below is the lead claim of one paragraph, and the paragraph itself is in the topic file its heading links to. The shutdown paragraph is one ordered procedure, long enough that its bolded steps are listed beneath it. A line number cited elsewhere as `docs/agent/concurrency-and-ownership.md:N` counts lines of this file before it was split on 2026-09-29; each entry ends with the line its paragraph started on at the split.

## [The folder claim, the slot walk and the worktree registry](concurrency-and-ownership/folder-claim-and-slot-walk.md)

- One writing run per folder subtree, unless the run is isolated. (was line 8)
- The folder claim is a synchronous check-then-insert. (was line 10)
- …so what that one turn is allowed to contain is bounded by a constant, not by a repository's history. (was line 12)
- A repository's worktree registry is a third claim, and it is the one that waits. (was line 24)

## [Data-dir ownership, the server lock and schema faults](concurrency-and-ownership/server-lock.md)

- …and exactly one process may write, which is enforced rather than assumed. (was line 14)
- The owner asks every beat whether the directory is still its own. (was line 18)
- What `migrate()` finds wrong with the file it opened is a row, not just a line. (was line 22)

## [What a shutdown accounts for, and what a restart closes out](concurrency-and-ownership/shutdown-and-restart.md)

- A shutdown accounts for the cycles it kills, and it is the only reason the process lingers. (was line 16)
  - Nothing new starts
  - Every `running` row is interrupted rather than merely signalled
  - Interrupting a row does not decide its ending, so the flag is the loop's to write
  - The children that are not work cycles get the same ladder
  - The loops are given a bounded grace
  - A land in flight at the signal is waited for in that same grace, and nothing signals it
  - Sharing the grace is not a clock on the merge
  - Then whatever they did not finish is mopped up
  - The handler's one line counts the cycles recovered by either path
  - None of it runs while Next's own handler is on
  - And all of it is the owner's to do
  - `deliverRun` is gated and waited on as `landRun` is
- A restart must close out its own runs, except a recent pause. (was line 20)
  - Before it decides anything it reconciles the cycles a hard stop left open
