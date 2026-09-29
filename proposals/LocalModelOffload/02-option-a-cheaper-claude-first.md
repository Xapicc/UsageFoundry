# Option A — no local model; move sub-agents to a cheaper Claude first

Vault step 1: "Set `model: haiku` or `model: sonnet` in sub-agent frontmatter,
or `CLAUDE_CODE_SUBAGENT_MODEL`, which since 2.1.251 sets a default rather than
overriding everything and does not move the built-in Explore and Plan agents"
(*Recommended Local and Claude Hybrid Setup*, `confidence: medium`; the variable's
behaviour is `documentation`, untested here).

## What it is in this app

Nothing to build. The app sets no sub-agent model anywhere — no
`CLAUDE_CODE_SUBAGENT_MODEL`, `ANTHROPIC_MODEL` or similar in `src/`, the
Dockerfile, compose or the entrypoint — and `childEnv` passes the server's
environment through to every child (`src/lib/orchestrator.ts:5857`). So one
line in compose's `environment:` block would reach every work cycle. It is not
made here: compose files are outside this survey's remit, and compose has no
`env_file`, so the line has to be written explicitly.

The other half of step 1 is sub-agent frontmatter. The app reads an agent's
name and description from the operator's `~/.claude/agents` and a repository's
`.claude/agents`, never its model (`src/lib/agents.ts:617`–`:647`), so a `model:`
line there is also the operator's to write, and the app will not see it.

## Its strongest case

- **Cache-neutral and hardware-free.** A sub-agent has its own context, so
  moving it leaves the main loop's cache alone (*Local Offload Economics*).
- **The quality trade is the good one.** Sonnet 5 against Opus 5 is a pass-rate
  ratio of about 0.90 on SWE-rebench for a price ratio of 2.5 (2.0 against
  Opus 5.5); a local model trades about 0.5 for an unbounded price ratio
  (*Local Offload Economics*, `industry-report` scores). "The window saving is
  about the same, and the local route carries five times the rework and a
  hardware purchase."
- **It is reversible in one restart**, and nothing in the app has to learn it
  exists.
- **The ModelRouter survey already cleared the ground.** It recommended "build
  no router" and found the CLI already routes delegated turns on its own —
  "1,231 `general-purpose` turns on Sonnet and 948 on Opus in one week, inside
  sessions whose main thread was Opus"
  (`git show 0232554:"proposals/notRecomended - ModelRouter/11-option-route-the-delegated-turn.md"`),
  calling the delegated
  turn "displacement, not a gap". This option adds nothing to what it settled;
  it names the one lever that survey did not examine (the environment
  variable, which it never mentions) and leaves the per-run model field it
  recommended where it is.

## The case against, in this install

**The prize is small, because the target is small.** Sub-agents are 8.0% of run
weight ([`00-problem.md`](00-problem.md) §1). By type: `general-purpose` 4.4%,
Explore 2.9%, named agents 0.8%. The variable does not move Explore (vault, above).
At Sonnet 5's list price against Opus 5's (`src/lib/pricing.ts:95`, `:80`), moving
all of `general-purpose` frees at most 4.4% × (1 − 2/5) ≈ **2.6% of run weight**,
about $150 over the measured month, before any extra turns Sonnet spends — and
ModelRouter's warning applies: every such figure is "a fixed-token-count
counterfactual … the honest prior is that it would emit more".

Only 0.7% of this install's run weight is already on Sonnet 5, so the CLI's
own routing that ModelRouter observed on the Mac is not happening in these runs
(U8 in [`01-constraints.md`](01-constraints.md) settles why).

## What it costs

Zero code. One compose line, one restart, and a week of `scripts/window-share.mjs`
before and after.

## Verdict

**Do it first, and expect little.** It is the only option with no build, no
new failure mode and no reach question, and it is the vault's first step for
the same reason. In this install it is worth a few percent of run weight, not
a third, because the runs do not delegate much. That smallness is also the
strongest fact against every option that follows: they all compete for the
same 8%, or for the main loop's reading, which none of them can take without
the frontier model losing sight of code it then has to edit.
