# Pricing, the model catalogue and model choice

[← testing index](../testing.md)

Read before adding or editing tests of `pricing.ts`, `modelCatalogue.ts`, `migrate()`'s model adoption, and every field that names a model (`modelFromForm`, templates, `frozenRunModel`, `assistModel`).

`modelFromForm`, in the same file as `budgetFromForm`, is where an *absent* key is the answer: `createRun` resolves a run's model as `input.model ?? settings.defaultModel`, so the form has to send nothing at all for the blank field to mean "whatever Settings says", and a form that posts the default it is only meant to be showing freezes that model onto `runs.model` where it stops following the setting it came from — a run that costs what last month's default cost, with the page, the types and the log all agreeing it was chosen deliberately. The trim is the second half: an argv entry of spaces is `--model "  "`, which is a spawn the CLI refuses, where a blank field is a run that starts.

A template's `model` is covered twice over, in `templates.test.ts` for the normalizer and the row read and in `chat.test.ts`/`workflows.test.ts` for the two functions that inherit it, and the two halves earn it differently. The normalizer's is the *absence* of a narrowing: every other value on a template is refused against a list, and this one must not be, because the list this build knows would refuse whatever ships next week — a template refused for naming a real model is a wrong answer nothing else on the page would explain. `rowToTemplate`'s is the same fact one build later: a row can outlive the build that wrote it, and degrading an unrecognised model the way an unrecognised permission mode is degraded would silently start every run from that template on something other than what the operator picked. `planProposal` and `planNode` are where the failure costs money rather than a refusal: a template that saved a model, named by a chat proposal or a workflow block, quietly running on `settings.defaultModel` instead is the right task at a different price, and nothing — not the run page, not the event log, not the cost rollups, which are correct about what was actually spent — would say the model was not the one asked for. Each of the three is asserted beside the guards that arrive by the same route, so a passing model assertion cannot be one read off the wrong record. `planProposal` then earned three more when the chat gained a model of its own, because the precedence is the thing that can be wrong: the proposal's model over the template's, the same over no template at all, and a blank one — `undefined` on a row written before the column, `""` or whitespace off a trimmed argument — reading as "named none" rather than as `--model ""`, which is a spawn the CLI refuses and a rung the fallback would never reach. Each was run against the implementation it exists to refuse: the first two fail on the template-only read they replaced, the third on a plain `??` chain.

`frozenRunModel` (`orchestrator.test.ts`, under `buildCodexArgs`) and `assistModel` (`review.test.ts`) are two halves of one rule, that no model id crosses providers, and they earn a test on the same ground: the wrong answer is a spawn that names a model the other CLI does not serve, which fails at the provider rather than at this app's door, under a model the page shows as chosen. A Codex run left blank froze `settings.defaultModel`, a Claude id, and spawned `codex exec -m claude-…` beneath a placeholder showing that id; an assist on a Codex run handed the run's Codex id to `claude --model`. The first is asserted through `buildCodexArgs`' argv rather than on the frozen value alone, because no `-m` is the whole of what Codex's own default means to that builder, and both assert the Claude side unchanged, a null provider included. Each failed against the implementation it replaced, the first on `model ?? defaultModel` and the second on `run.model` passed straight through; neither fault was reproduced at runtime. The row half is `resolutionBudget.test.ts`'s "the model a resolution's row is recorded under", on that file's fixture and its ground: `assistModel` was right while `startAssist` wrote `run.model` to `run_reviews.model` beside it, so an assist on a Codex run was recorded under the Codex id while its child ran Claude, and nothing else would say so, because cost is the CLI's own figure and never priced from that column. It reads the row and the stub's argv from one resolution and asserts they agree, for a Codex run with a Claude default, a Codex run with none, and a Claude run's own model; the two Codex cases failed against the old INSERT.

**`pricing.test.ts` pins one number and the prefix that reaches it**, and it is
the newest shape in this file: a rate that used to be a constant and is now a
property of the model. Claude Fable 5.1 and Claude Mythos 5.1 charge 0.025× of
input for a cache read where every other model charges 0.1×, and their *visible*
columns — $10 input, $50 output — are identical to Claude Fable 5's, so an entry
that fell through to the shorter prefix would be right on both figures a person
can check and 4× wrong on the one they cannot. That is the whole ground: cache
reads are ~98% of this workload's tokens and 60.7% of its bill, and the error
runs in the direction that refuses a run against a ceiling it never reached. The
four cases are the four ways it goes wrong quietly — the 5.1 key winning over the
5 key it prefixes (which holds only because `PREFIXES` is sorted longest-first,
a fact no call site restates), a million cache-read tokens costing $0.25 on the
pair and $1.00 on the models beside them, the discount surviving a dated snapshot
and a Bedrock prefix through `canonicalModelId`, and `UNKNOWN_MODEL_PRICE`
*not* inheriting it, because the unknown rate exists to be the dearest plausible
shape and 0.1× on a $10 input is dearer than 0.025× on one. What it does not
assert is the arithmetic in `contextPruning.ts` and `intakeFilter.ts` that now
takes the rate from the price it already resolved; those two are counterfactuals
with their own tests and their own grounds, and the thing that keeps them honest
is that there is one function to read the rate from rather than a constant each
of them could hold a stale copy of.

A fifth case joined them with `settings.modelCatalogue`: **a `[1m]` id prices at
its base model's rate**. `[1m]` is Claude Code's name for the 1M-context
deployment of a model, the suffix falls after the table's key, so
`claude-opus-5[1m]` already prefix-matches `claude-opus-5` — and that is the
right rate rather than a near-miss, because the current models carry a 1M window
natively and Anthropic charges no long-context premium for it. It is pinned
because both ways of "fixing" it are silent. Strip the suffix in
`canonicalModelId` and every figure stays right while a normalisation of a
CLI-shaped id sits one refactor from the path to `--model`, where the brackets
have to survive; add a `[1m]` key to `PRICES` *after* its base and
longest-prefix-first never reaches it. The case also runs `claude-fable-5[1m]`
through the 5.1-versus-5 trap above, where the wrong answer is again 4× on the
invisible column.

**Claude Opus 5.5 added four more, and it is the 5.1 pair's trap one tier down
with a second edge on it.** `claude-opus-5-5` is $4/$20 against Claude Opus 5's
$5/$25 *and* halves the cache read to 0.05×, so a fall-through to the shorter key
is 25% wrong on the two columns a person can check — at least visible — and 2×
wrong on the one they cannot, in the direction that refuses a run against a
ceiling it never reached. The resolution case pins both entries whole and pins
that the collision does not run backwards. The cache-read case is deliberately
written against a shape this workload produces rather than a single token — 5M
reads, 250k one-hour writes, and the input and output of a real cycle — and
asserts the same shape's read term at $1.00 beside the $2.00 an inherited default
would charge, so the 2× is a number in the file rather than a claim about one.
The third runs `[1m]`, a dated snapshot and both provider decorations onto the
one entry. The fourth pins fast mode at $8/$40 with the two older fast rows
untouched beside it, and carries the subtler half: `FAST_MODE_PRICES` *replaces*
the base entry rather than overlaying it, so the 0.05× has to be repeated there
and its absence is silent in the usual way — every published figure right and the
invisible one at 4× its base where the two visible ones are 2×. Anthropic's page
settles which it should be ("prompt caching multipliers apply on top of fast mode
pricing", and the multiplier is the model's own), so the case pins $0.40/MTok and
pins the invariant behind it: every fast column is exactly twice its base column,
the cache read included. The Opus 5 and 4.8 rows are asserted to keep the default
in the same case, because their base rows use it too and so already double.

**Claude Sonnet 5's $2/$10 earned its own block by being a rate that stopped
moving.** It shipped as introductory pricing with a rise to $3/$15 scheduled for
2026-09-01, this table carried the dated ramp, and Anthropic then cancelled the
rise and made the introductory figure the list price. The ramp is *deleted*
rather than expired, and what the cases pin is that it stays deleted: the rate is
asserted at three fixed instants — inside the old introductory window, on the day
the increase was scheduled for, and months past it — plus the no-`at` call every
guard site actually makes, which under the ramp could disagree with the shown
figure by a day. Restoring it from memory would price every Sonnet 5 run 50% high
on a figure `evaluateBudget` acts on, with nothing on any page saying a rate
expired. Two tests went with the mechanism, deliberately and not by weakening
them: `windows.test.ts`'s *prices each turn at the rate in force on the day it
ran*, which pinned the counterfactual's per-day memo key against the ramp's UTC
midnight, and `contextPruning.test.ts`'s *prices at the receipt's own date*,
which pinned `netReceipt` reading its own `ts` rather than `Date.now()`. Both
observed time-dependence through the only entry that had any, and with the table
flat there is nothing either can assert that is not a restatement of the code.
The rule they protected is not gone — `resolvePrice`'s note and `metering.md`
both say a new dated rate goes in that shape and turns over at a UTC midnight —
and a case for each comes back with the next one.

**`modelCatalogue.test.ts` covers the list every model field is now validated
against**, and each of its cases is a wrong answer that renders as a plausible
page rather than an error. The seed is walked against `knownModelIds()` in both
directions, because `pricing.ts` is the one answer to which models exist and a
seed that drifted either way is silent — a missing entry is a picker one option
short for no stated reason, an invented one is an id nothing can price showing
as $0.00 rather than as a mistake. **The label half of that agreement was implied
and is now asserted**, which Claude Opus 5.5 is what exposed: `seedCatalogue`
falls back to `MODEL_LABELS[id] ?? id`, so a model added to `PRICES` and
forgotten in `MODEL_LABELS` seeds perfectly well and wears its own raw id on a
picker beside entries that read "Claude Opus 5" — and the label check that only
asked for a non-blank string passed it, which made this file's claim to be the
loud channel for a half-added model not quite true. Every priced entry is now
required to have a label that is *not* its id. Opus 5.5 is pinned by name
alongside it, on all three of the tables it has to appear in across two files
with nothing joining them, and the quiet one is `ONE_MEGA_VARIANTS`: a missing
`[1m]` row is no error anywhere, just an option that is not on the list, and an
operator who types the id by hand gets a refusal from a validator working exactly
as written. The same case pins Claude Opus 5 still enabled beside it, because
5.5 is an addition and not a replacement — Opus 5 is listed legacy and still
served, so a transcript naming it must still price and a run may still start on
it. **`mergeSeededModels` earned its own block, and it is the case the seed
assertions above could not reach.** Everything they pin is about
`SEEDED_MODEL_CATALOGUE`, which is `DEFAULTS.modelCatalogue` — and an install
that has *stored* a list is no longer reading it. `saveSettings` pins the key the
moment it differs from the default, one model switched off is enough, and from
then on every future seed addition was dead there: a picker one option short,
with nothing anywhere saying a model had shipped. The settings page promised
otherwise in as many words (a seeded row has no Remove button because "the seed
comes back on the next release") and nothing kept it. The cases pin what reaches
such a list and what must not be touched on the way: a newly seeded model arrives
where the *seed* declares it rather than appended to the end, because declaration
order is display order and the newest model is the one being looked for; every
stored `enabled` survives, including a seeded model switched off, which is the
one thing re-running adoption would have undone; the operator's own entries keep
their relative order and stay last; and a stored label still equal to its raw id
gets the name the seed now knows, which is the `addModel` case — an operator who
typed `claude-opus-5-5` in before upgrading would otherwise keep that string on a
picker under "Claude Opus 5" — while a label they actually chose is left alone.
Idempotence is asserted directly, because it is what makes running on every boot
safe where `adoptModelIds` beside it must run once. `modelAdoption.test.ts` then
drives the same thing through a real boot rather than asserting about it, that
file's standing rule: the pure function was correct and *unreachable* until
`migrate()` called it, and nothing in a unit test of it would have said so. Its
fixture is derived from what the install actually stores rather than written
down, so it keeps meaning "a list from before the newest model" once the newest
model is no longer this one, and it ends by booting twice to pin that the second
boot writes nothing. `modelRefusal` is pinned on the four values
that must **not** refuse (null, undefined, `""`, whitespace: every way of naming
none, and a refusal on any of them takes away all three fallback rungs from the
ordinary run), on an empty catalogue meaning *no catalogue* rather than *no
model allowed*, on matching exactly rather than by prefix or provider decoration
— the question is "may this string reach `--model`", not "which model is this",
which is `pricing.ts`' question and has its own canonicalisation — and on saying
*switched off* rather than *unknown* for a disabled entry, because one fix is a
switch and the other is typing an id. `normalizeModelCatalogue` is pinned on
refusing a list with nothing enabled, which would refuse every run on the
install. `adoptModelIds` is pinned on being idempotent, which is the only thing
that makes it safe to run from `migrate()` on every boot, and on adding rather
than replacing — an operator running on a model this build never heard of keeps
it, and dropping one would reset a working configuration under a feature whose
whole claim is that it protects one.

`modelAdoption.test.ts` is what `migrate()` does to an install that was already naming models before `settings.modelCatalogue` existed, driven through a real boot rather than asserted about it: `adoptModelIds` already has its own cases in `modelCatalogue.test.ts`, and calling it directly here would pin this file's own argument rather than what a boot actually writes. Both of its failures are silent and neither is recoverable by the operator — adopting too little leaves an install running on a model this build's seed never heard of with every door refusing it, the settings default, the run form and the chat, as a working configuration reset by an upgrade nobody asked anything of; adopting too often brings back a model the operator deliberately switched off, and brings it back *enabled*, the moment a template still names it. Nothing throws either way, both pages look right, and the second failure only shows up as a run that started on a model somebody had retired.
