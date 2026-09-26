# Option D — a run that runs entirely on the local model

Vault step 5: "Only for offline or private work, run a whole session locally,
with the environment block in *Pointing Claude Code at a Local Model*"
(*Recommended Local and Claude Hybrid Setup*, `confidence: medium`; "The base
URL, token, model name and attribution lines were tested; the context and
output overrides were not").

## What it is in this app

A third value for `runs.provider`, or a template setting, meaning "this run's
work cycles talk to the local server". Two ways to get one, since the app
already has two providers (`RunProviderDTO`, `src/lib/apiTypes.ts:1174`;
`selectCycleAdapter`, `src/lib/orchestrator.ts:6300`):

- **D1 — Claude Code against the local server.** The Claude adapter with an
  environment block: `ANTHROPIC_BASE_URL` at the server, a dummy
  `ANTHROPIC_AUTH_TOKEN`, a model name not starting with `claude-`,
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` equal to the server's context,
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS` well under 32,000,
  `CLAUDE_CODE_ATTRIBUTION_HEADER=0`, and WebSearch denied (*Pointing Claude
  Code at a Local Model*).
- **D2 — Codex against the local server.** The Codex adapter with
  `--oss --local-provider ollama|lmstudio`, or
  `-c model_provider=local -c model_providers.local.base_url=…`, both accepted
  by the installed `codex-cli 0.153.4` — **Responses API only**, `wire_api=chat`
  refused ([`01-constraints.md`](01-constraints.md) C10). The Codex argv already
  carries `--ignore-user-config` (`src/lib/cycleInvocation.ts:1521`), so the
  provider would travel on `-c`, which that flag does not block.

## Its strongest case

- **It moves the whole run**, so the saving is the run's entire frontier cost —
  the only option here whose target is the 92% main loop rather than a slice of
  it.
- **Most of the plumbing exists.** The provider column, the door that sets it
  (`src/app/api/runs/route.ts:273`–`:283`), the adapter switch and the refusal
  that insists a money-blind run has a cycle cap or time limit
  (`providerTerminusRefusal`, `src/lib/budget.ts:477`, checked at
  `src/app/api/runs/route.ts:336`) were all built for Codex. A local run is as
  money-blind as a Codex one, so it inherits that refusal as-is.
- **It is the right answer for work that must not leave the machine**, which is
  the vault's actual use for it.

## The case against

- **It moves exactly the work the evidence says not to move.** A work cycle is
  multi-step coding with tools; the best local model passes about half as often
  as Opus 5 on fresh tasks (31.2 against 63.4, SWE-rebench, `industry-report`,
  *Local Model Quality by Agent Task*), and at a 0.5 ratio "half of all attempts
  cost review time and a redo" (*Local Offload Economics*). The vault's own
  verdict: "**Do not** move the main loop or multi-step coding sub-agents to a
  local model on current evidence."
- **D1 is Claude Code's full prompt on local prefill, every cycle.** 16.7k
  observed, 12k–70k reported, before any work; on a Max-class Mac 24–60 s per
  32k tokens of prefill, "30 seconds to two minutes on every turn" if the
  prefix is lost (*Local Decode and Prefill Speed*, `blog`). A cycle of 50
  turns is an hour or more.
- **D1 carries a credential trap.** With `ANTHROPIC_BASE_URL` alone "a saved
  claude.ai login remains the active credential" and its OAuth token goes to the
  URL (C5); the mounted `~/.claude` login is exactly that. The dummy token is
  load-bearing, and nothing in the app sets one today.
- **D1 collides with the intake filter**, which owns `ANTHROPIC_BASE_URL` when
  `WINNOW_FILTER=1` (`docker-entrypoint.sh:1192`, C11).
- **D1's meters lie in the safe direction, and D2's are blind.** Claude Code
  prices an unknown model as Claude: "`total_cost_usd` of 0.079 for a run that
  never reached Anthropic (*observed*)" (*What Breaks When Claude Code Runs on a
  Local Model*), so the guards would stop a free run on phantom money. Codex
  reports no cost at all (ProviderFallback's
  `proposals/ProviderFallback/02-the-handover-contract.md`).
- **D2 depends on an API the vault's recommended server may not speak.** Codex
  needs `/v1/responses`; whether `llama-server` serves it is unverified (U7),
  and Ollama's small-machine default of 4k "truncates silently" (*Recommended
  Local and Claude Hybrid Setup*, step 3) — the runtime the vault says to avoid
  unless `OLLAMA_CONTEXT_LENGTH` is raised.
- **One slot for the whole fleet** (C6). A local run holds the GPU for its
  entire duration; a second local run, or Option B/C calls from Claude runs,
  queue behind it.
- **Two of the pieces ProviderFallback found missing are still missing**: no
  per-cycle money ceiling and no MCP (`src/lib/orchestrator.ts:8585`). The third,
  the `pkill` denial, now exists for Codex as a rules file the app writes before
  the cycle (`src/lib/orchestrator.ts:9289`–`:9296`) rather than as the argv
  denial a Claude cycle carries.

## What it costs

D2: ~2–4 days on top of the Codex adapter (a provider value, the `-c` flags, a
settings block, a check that the server answers). D1: ~4–6 days (an adapter
variant, the environment block, a clean-credential path, the intake-filter
interaction, pricing the local model at zero). Neither is small once the
refusal, the page copy and the verification entries are counted.

## Verdict

**Not an offload option.** It is a privacy and offline option, which is how
the vault frames it, and nothing in the brief asks for that. If it is ever
wanted, D2 is the cheaper route in this app because the Codex adapter already
has the refusal and the `-c` path, and it should wait on U7.
