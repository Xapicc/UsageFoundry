# Option B — a one-shot local tool: summarise or extract one thing

Vault step 4: "A script or MCP server that posts a file or log to the server's
OpenAI-compatible endpoint with a fixed instruction ('extract the errors',
'summarise this diff') and prints the answer" (*Recommended Local and Claude
Hybrid Setup*, `confidence: medium`, marked *Untested*). One request, no loop,
no tool calling asked of the local model.

## What it is in this app

Two tools on an app-hosted MCP server, reached by a run exactly as the taskboard
is ([`01-constraints.md`](01-constraints.md) C12):

- `local_summarise { path, instruction }` — the app reads `path` from the run's
  own checkout, proves it contained (`resolveInMount`'s lexical-then-realpath
  pair, `src/lib/orchestrator.ts:1244`; "Both checks are load-bearing",
  `docs/agent/security/path-containment-and-spawn-argv.md`'s `resolveInMount` paragraph), sends instruction plus content to the local
  server, returns the answer.
- later, `local_extract { path, instruction, schema }` — not in the
  implementation sketch's build order — the same, with the reply
  constrained to a JSON schema, which the vault calls free locally ("schema
  *validity* is free locally through grammar-constrained decoding", *Local
  Model Quality by Agent Task*).

The main loop decides when to call it; nothing in the app decides for it. A
line in the appended prompt names the tool, as `TASKBOARD_NOTICE` does for the
board (`src/lib/cycleInvocation.ts:978`–`:988`).

It could also be done with **no app code**: the operator's own MCP servers
already reach every work cycle, because `--strict-mcp-config` is absent for runs
(`src/lib/cycleInvocation.ts:1188`). A small HTTP MCP server on the host, added to
the mounted `~/.claude` config, is a trial of this option that touches nothing
in the repository. That route's limits are the reason an in-app version would
exist at all: the run log would not see what it did (C8), it would get no
per-run token, and whether `acceptEdits` permits its tool without an allow rule
is unknown (U3).

## Its strongest case

- **It is the best-evidenced local task.** Summarising logs, diffs and docs is
  "at parity or better as a writer of summaries" — Qwen3-8B 4.8% and Gemma 4
  26B-A4B 5.2% hallucination against Haiku 4.5 9.8% and Opus 4.7 12.0% (Vectara
  leaderboard, `vendor`, via *Local Model Quality by Agent Task*). The
  controlled result behind the pattern is Minions: 97.9% of cloud accuracy for
  a 5.7-fold cut in cloud cost on documents (`peer-reviewed`, "local compute
  counted as free and latency unmeasured").
- **It aims at the biggest block.** Main-loop reading and search is 42.6% of
  this install's run weight, other Bash (builds, tests, scripts) 29.6%
  ([`00-problem.md`](00-problem.md) §1).
- **It is fast enough.** From [`scripts/latency.mjs`](scripts/latency.mjs), an
  8k-token file plus a 400-token answer: **10–18 s** on a Max- or Ultra-class Mac
  with a ~3B-active sparse model, 47–93 s with a dense 27B, 18 s on an RTX
  4090 with a dense 27B (vault figures; `blog` for the prefill rows, a
  prediction for dense decode, an `anecdote` for the dense prefill factor).
- **It needs nothing from the local model it is bad at**: no tool calling, no
  multi-step decision, no edit format, no Claude-sized prompt.
- **Nothing it does needs the calling session's permission to be widened
  beyond the call itself.** It reads one path the app has proved is inside the
  run's own checkout, and returns text.

## The case against

- **The saving is the vault's open question, and it is open for this exact
  reason.** "Moving it means the frontier model sees an extract or a brief
  instead of the file … the realistic figure is lower because the model must
  still see the code it edits" (*Local Offload Economics*). The seed that would
  measure it has not been grown (*Does a Local Tool-Output Summariser Save
  Frontier Usage in a Coding Agent*, `status: seed`, `confidence: low`; the
  hypothesis is that "the loss concentrates on edits that need exact surrounding
  code the extract dropped").
- **Most of the 42.6% is not file bytes.** It is the main loop re-reading its
  own cached prefix to decide to read (69% of the main loop's weight is cache
  reads on the Mac, *Local Offload Economics*). One `local_summarise` replaces
  one `Read`; it removes that step's appended bytes from every later turn but
  not the decision turn itself. A saving on the decision turns needs one call
  to replace *several* reads — which is Option C, not this.
- **A summary of code the model is about to edit is a liability.** An edit
  needs exact text; the vault's quality table has single-file edits trailing by
  eight points or more even when the editor *has* the file.

## What it costs

In-app: ~4–5 days — phase 1 of
[`10-implementation-sketch.md`](10-implementation-sketch.md): the MCP route's
second server, a settings block, one HTTP client with an abort signal, the
descriptor-verified containment, the queue and the run-log rows. Without the
queue and the rows it would be two or three days, and it should not ship
without them. Operator-side
trial: an afternoon, no repository change.

## Verdict

The cheapest honest experiment in this survey, and the one the vault ranks
second. Worth running **as a trial through the operator's own MCP config** and
measuring with [`11-validation.md`](11-validation.md) before any of it is built
into the app — because the one number that decides it, whether the frontier
model then does the task as well with less, does not exist anywhere yet.
