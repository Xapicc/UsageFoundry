# Steering agents to consult the vault

[← dreaming index](../dreaming.md)

Read before editing `renderVaultSkill` in `src/lib/vaultSkill.ts`, or a prompt that tells an agent to search the vault.

**Steering an agent to consult the vault is cheaper than letting it
investigate, and the steering belongs in the skill rather than in every prompt.**
Three runs on 2026-09-02, same question about the `bwrap` and `git add` failures
the first night had written up:

| | vault searches | cost | time | tool calls | errors |
|---|---:|---:|---:|---:|---:|
| unsteered, old skill | **0** | $1.63 | 369s | 52 | 24 |
| steered by prompt | 7 | $0.75 | 83s | 15 | 2 |
| unsteered, **widened skill** | 1 | $0.90 | 190s | 14 | 6 |

The first two differ only in one paragraph of prompt; the third differs from the
first only in `renderVaultSkill`'s text. **The skill was enabled for all three
and the first never searched it** — availability is not what makes an agent
check, the trigger is, and the old description's trigger was reactive ("when
asked what is known"). Widening it to name *investigating a failure* recovers
most of the gain with no prompt-level steering at all: 45% cheaper, 73% fewer
tool calls, 75% fewer tool errors than the same question unsteered.

The clause costs **54 tokens on every cycle of every run**, which is the honest
price of a description: about $0.03 a day at a hundred cycles, and one avoided
rediscovery pays for a month of it. It was trimmed from 76 tokens for exactly
this reason — the description is the one part of a skill that is never free.

Two findings from those runs that bear on the whole feature. The unsteered run
reached a confident conclusion from n=19 that **contradicts** the vault's n=9,269
measurement, which is the failure the store exists to prevent. And the
vault-reading run did not merely relay: it found that the note's own advice
(gitignore `.bash_profile`) was incomplete, because git stops at the first
refusal and ten more character devices sit behind it. A reader that verifies is
worth more than one that quotes, and the skill's grading table is what keeps the
difference legible.
