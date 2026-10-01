# Option E: a file or git notes in the repository itself

## 1. Its strongest case

It needs no app change at all, and it works for every provider. A Codex run gets
no board (`src/lib/orchestrator.ts:9026`), and a local-provider run leaves no
Claude transcript, but every run can read git. Git notes are particularly apt.

- `refs/notes/*` live in the repository's common directory, so a note one
  worktree writes is visible to every sibling at once. That rests on git's
  semantics: worktrees share refs.
- A note attaches to a commit, so "I fixed this in `0da625d`" lives on
  `0da625d`.
- Notes do not touch the working tree, so they do not change `gitStatus`. That
  is the part of the CLI's system block whose change ContinuousImprovement
  measured as a cache write (`proposals/ContinuousImprovement/01-constraints.md:62`-`:75`).

The file variant, say `.uf/notes.md`, is simpler and worse. It is per worktree
until landed, so siblings cannot see it, and it is one more index for
`CLAUDE.md`-style conflicts, the top source of paid resolutions
([`00-problem.md`](00-problem.md) §2).

## 2. Shape

- A sentence in `SHARED_CHECKOUT_NOTICE` (`src/lib/cycleInvocation.ts:607`)
  saying that `git notes --ref=uf-runs` carries notes between live runs on this
  repository.
- `ISOLATED_GIT_TOOLS` grants the `git notes` subcommands.

## 3. When a message is read

On request, when an agent runs `git log --notes=uf-runs` or `git notes show`.
The prompt would have to keep telling it to, since nothing else would.

## 4. Metering and guards

It starts and extends nothing, and widens nothing directly. Whether the extra
grant in `ISOLATED_GIT_TOOLS` widens a permission is a question for
`docs/agent/security.md`: `git notes` writes refs, which every run can already
do (C7).

## 5. Restart

Notes survive restarts, the run, the branch and the install. They are pushed
wherever `refs/notes/*` is pushed, and they have no horizon at all, which C5
requires the operator to be able to bound and here nothing can.

## 6. What the operator sees

Nothing in the app. `git log --notes` from a shell.

## 7. Isolation and injection

This is the worst authorship of any option.

- A note carries the committer identity the container configures, and every run
  has the same one. **Nothing records which run wrote a note.**
- Any run can rewrite or remove any note, because notes are refs and the write
  set is "this repository" (`src/lib/orchestrator.ts:5856`-`:5875`). That breaks
  C8 rule 2 and the board's append-only rule.
- It is also the only option whose payload **leaves the machine**. A note pushed
  to the forge is read by every future clone, human or agent.

## 8. Cost to build

A few hours.

## 9. What would have to be true

Runs would have to be trustworthy authors of permanent, unattributed, mutable
text that travels with the repository. That is the property ContinuousImprovement
rejected for an agent-maintained `CLAUDE.md`, on stronger grounds than here
(`proposals/ContinuousImprovement/16-recommendation.md:194`-`:202`).

## Verdict

**Rejected.** It is cheap and provider-neutral, and it fails C5 and C8 rule 2
outright: no author, no horizon, mutable, and portable off the machine. Its one
good idea, attaching what a run learned to the commit it is about, is already
what a commit message does. A sibling reads that with `git log` on the branch,
which runs do unprompted ([`02-what-already-talks.md`](02-what-already-talks.md) §5).
