# Option E — a gateway that sends sub-agents or a model tier to the local server

Vault step 6, which it marks **"Not now"**: "It is documented piecewise and
unsupported by Anthropic, its effect on the subscription is disputed between
the docs and one report, relaying the token is an open terms question, and
each local sub-agent would receive a Claude-sized prompt and pass multi-step
work about half as often" (*Recommended Local and Claude Hybrid Setup*,
`confidence: medium`).

## What it is in this app

LiteLLM or claude-code-router in front of every child: `ANTHROPIC_BASE_URL` at
the gateway; Claude names forwarded to Anthropic with the subscription's
`Authorization` and `anthropic-beta` headers intact; one local name — a
sub-agent's `model:`, or `ANTHROPIC_DEFAULT_HAIKU_MODEL` for the background
tier — routed to the local server (*Hybrid Claude and Local Model Setups*,
`confidence: medium`, `documentation`). Claude Code offers no per-agent
endpoint of its own: the configuration "is **session-wide**" (claude-code
#38698, `anecdote`).

## Its strongest case

- **It is the only option that moves Claude Code's own delegation without a new
  tool.** The main loop keeps delegating the way it does; the gateway changes
  where the delegate runs.
- **This install already runs a request-rewriting proxy at
  `ANTHROPIC_BASE_URL`** when `WINNOW_FILTER=1` (`docker-entrypoint.sh:1192`;
  `src/lib/intakeFilter.ts:16`–`:20`). The architectural step — a local process
  between every agent and Anthropic — has already been taken once, so the
  "an unsupported proxy" objection is weaker here than for a fresh setup.
- **Claude Code names what a gateway needs**: a sub-agent's `model:` field, the
  Haiku tier, and since 2.1.273 an opt-in `x-claude-code-request-class` header
  with `main`, `subagent`, `workflow`, `compaction`, `auxiliary`
  (*Hybrid Claude and Local Model Setups*, `documentation`).

## The case against, in this install

- **The target is 8.0% of run weight**, and routing by name cannot pick the
  read-only 2.0% from the rest: a `general-purpose` sub-agent that runs Bash and
  one that only reads carry the same name ([`00-problem.md`](00-problem.md) §1).
  The request-class header says *sub-agent*, not *read-only*.
- **Every routed sub-agent is Claude-shaped and too big.** It receives Claude
  Code's sub-agent prompt and tool definitions, and the median read-only
  sub-agent here peaked at 75,672 tokens — over the 64K window — which is the
  failure the vault's catalogue lists first: "Ollama: the model forgets the task
  … with no error. `llama-server`: `API Error: 400 … exceeds the available
  context size`" (*What Breaks When Claude Code Runs on a Local Model*).
- **The Explore agent does not follow the tier.** `CLAUDE_CODE_SUBAGENT_MODEL`
  "does not move the built-in Explore and Plan sub-agents" (*Hybrid Claude and
  Local Model Setups*), and Explore "inherits the main conversation's model"
  (*Local Offload Economics*, quoting the CLI's changelog) — so the tier-routing
  variant misses
  2.9 of the 8 points.
- **It chains with, or replaces, winnow's proxy.** Two proxies in series is a
  new failure point on every request every run makes — the Claude ones
  included — for a slice of 8%.
- **The terms question is open**, not answered by winnow's precedent: "A
  person's own proxy on their own machine is neither clearly inside nor clearly
  outside that sentence" (*Hybrid Claude and Local Model Setups*,
  `confidence: medium`), seeded as *Is Relaying a Claude Subscription Through a
  Local Gateway Permitted* (`status: seed`, `confidence: low`). And whether a
  subscription login goes through a gateway at all is disputed between
  Anthropic's docs and claude-code #91746 (*Hybrid Claude and Local Model
  Setups*, `meta/contradiction`).
- **Option A dominates it.** Same target, same cache-neutrality, no hardware, no
  proxy, a pass-rate ratio of 0.90 rather than 0.5 (*Local Offload Economics*).

## What it costs

A gateway container or process, its configuration, the chaining with winnow,
a routing rule per agent name, and a failure path when the local server is
down that does not take the Claude traffic with it. ~5–8 days, most of it in
the failure paths, plus a terms question no amount of code answers.

## Verdict

**No**, for the vault's reasons and one of this install's own: the delegated
block it would move is 8%, not a third. ModelRouter's survey reached the same
place from the other side — the delegated turn is "displacement, not a gap"
(`git show 0232554:"proposals/notRecomended - ModelRouter/11-option-route-the-delegated-turn.md"`)
— and nothing here is new evidence against it. Revisit only if the vault's
local-sub-agent seed is answered favourably, as the vault itself says.
