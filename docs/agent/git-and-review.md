# Reviews, GitHub credentials and diffs

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing src/lib/review.ts, git.ts, diff.ts, patch.ts.**

Each paragraph now lives in the topic file its heading links to: find the rule by its claim below and open that one file. A line number cited elsewhere as `docs/agent/git-and-review.md:N` counts lines of this file before it was split on 2026-09-29; each entry ends with the line its paragraph started on at the split, and a citation older than that may be off by a few lines.

## [Reviews, resolutions and validations: the assist child](git-and-review/reviews-and-assists.md)

- Reviewing a diff is not a work cycle and is never automatic. (was line 8)
- A conflict resolution may check its own merge only where a toolchain can exist, and only where an operator named the command. (was line 10)
- `AssistKind` has a third member and it is the one that is not a person's press. (was line 26)
- An assist streams, and every tool call it makes is on the run's log wearing its own name. (was line 28)
- That field is also a filter, and two readers had to grow it in the same change. (was line 30)
- `parseReviewOutput` reads the `result` event and refuses anything else, including the last line that happens to parse. (was line 32)

## [GitHub credentials for a work cycle](git-and-review/github-credentials.md)

- GitHub credentials reach a work cycle and nothing else. (was line 12)
- …and *which* credential a work cycle gets is the repository's, not the install's. (was line 14)

## [Diff flags, budgets and ranges](git-and-review/diffs.md)

- Diffing runs repository-controlled code unless it is told not to. (was line 16)
- A diff that was shortened says so. (was line 18)
- An isolated run's diff is measured from the target as the branch contains it, not always from its base. (was line 20)

## [What a run touched against what it changed](git-and-review/touched-versus-changed.md)

- What a run *touched* is a different fact from what it changed, and the three ways of having none of it are three different sentences. (was line 22)
- The map at `/runs/[id]/touched` draws the same rows and is allowed to claim less than the table, never more. (was line 24)
