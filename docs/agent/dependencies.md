# Run dependencies

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing releasableRuns/admitDependencies/releaseDependents in orchestrator.ts.**

This file is an index. Each line below is the lead claim of one paragraph, and the paragraph itself is in the topic file its heading links to.

## [What a waiting run holds, and what admission refuses](dependencies/waiting-and-admission.md)

- A run can be told to start after other runs, and while it waits it holds nothing.
- A loop is refused at admission, because nothing downstream of it would ever be woken or ended.

## [What satisfies an edge: `edgeSatisfied` and its three conditions](dependencies/edges-and-conditions.md)

- A dependency succeeds by reaching `completed`, and a run that never ran a work cycle satisfies nothing.
- "Ran a work cycle" is `ranWorkCycle`, which is `iterations > 0` or a refunded cycle, because the refunds put `iterations` back to zero on a run that worked and paid.
- `needs-review` is terminal and is not a success, and both halves are carried by one constant.
- `on-failure` starts a run only behind a failure that did work, and a run on the branch it did not take is `not-needed` — never `blocked`.

## [Releasing, blocking and waking a dependent](dependencies/release-and-blocking.md)

- A dependent that can never start is terminated with a sentence naming what stopped it, and so is everything behind it.
- Every terminal transition wakes the dependents, and a boot deliberately does not.
- A run a restart closed out satisfies no edge until it is picked up, and nothing new is chained onto it meanwhile.

## [What an isolated run may do with git, and what is reported when it is refused](dependencies/git-permissions-and-denials.md)

- An isolated run is granted the two git commands it is ordered to use.
- A refused tool call is reported, because the alternative is a run that looks like it chose not to.
