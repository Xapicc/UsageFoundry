# Option E — a local model instead of Haiku

## What it is in this app

The same jobs as Option D's Haiku half, run by the app's `local` provider
against a model on the operator's Mac — the provider LocalModelOffload refused
as offload (`proposals/LocalModelOffload/09-recommendation.md:67`) and that was
built the next day (`docs/agent/local-provider.md`).

## Its strongest case

- **The rubric says most of these jobs are the local tier's best class.**
  LocalModelOffload's task-class line falls "between transforming given content
  and deciding under feedback": summarising and schema extraction are near
  parity with Claude (`proposals/LocalModelOffload/00-problem.md:154`–`:172`). A
  stale abstract is a summary of the note's own body; a keyword fix is
  extraction; orphan linking is search.
- **It costs no subscription at all**, and the provider, its sign-in and its
  concurrency cap already exist.

## The case against, in this install

- **The saving is cents.** A Haiku pass is $0.07–0.35 (08 §4). There is
  nothing left on the table for a local model to take.
- **The jobs are edits, and that is the class the local tier is behind on**:
  single-file edits are eight or more points behind Claude on the vault's own
  evidence (`proposals/LocalModelOffload/00-problem.md:154`–`:172`).
- **The safety net built for weaker models does not reach the vault.** A local
  branch does not land until a frontier review approves its tip, keyed on
  `repo_root` and `worktree_branch` (`docs/agent/local-provider.md:31`). The vault
  has neither (C1), so a local run's vault edits would have *less* review than
  a local run's code — and LocalModelOffload refused a write-capable weaker
  local agent outright (`proposals/LocalModelOffload/09-recommendation.md:55`–`:59`).
- **The Mac has to be on, serving, and free.** One local run works at a time by
  default (`docs/agent/local-provider.md:13`), and a weekly pass at a fixed
  time competes with whatever the operator is doing on the machine.

## What it costs

No build beyond D. No model spend; the operator's machine time.

## Verdict

**No.** It trades a few cents for a weaker editor, an availability dependency
and the loss of the one review gate weaker models get. Revisit only if a local
runner gains a frontier-reviewed gate that works without git.
