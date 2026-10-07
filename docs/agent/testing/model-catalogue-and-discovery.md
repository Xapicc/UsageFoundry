# The model catalogue and model discovery

[← testing index](../testing.md)

Read before adding or editing tests of `modelCatalogue.ts`, `migrate()`'s model adoption and `modelDiscovery.ts`.

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

`mergeSeededModels([])` returning `[]` is pinned in `modelCatalogue.test.ts`, and the same claim is driven through a restart in `src/app/api/settings/route.test.ts`, which `PUT`s `[]`, closes `globalThis.__ufDb` so the next `db()` reopens and runs `migrate()`, and asserts the list is still empty. Both, because the unit case alone would stay green if `migrate()` stopped calling the function that holds the rule, and the route case alone would not say which half broke. The defect was silent in the way that matters: the `PUT` stored `[]` and answered 200, and the boot after it wrote all 32 seed entries back, so every model the operator had relied on the empty list to allow was refused at `POST /api/runs`, the chat and the template doors with nothing connecting it to a restart. A control case beside it pins that a stored non-empty list still gains what this release seeded, so the guard cannot be widened into "never merge". The idempotence case starts from a one-entry list rather than `[]`, since `[]` is now the one input the merge leaves alone.

`modelAdoption.test.ts` is what `migrate()` does to an install that was already naming models before `settings.modelCatalogue` existed, driven through a real boot rather than asserted about it: `adoptModelIds` already has its own cases in `modelCatalogue.test.ts`, and calling it directly here would pin this file's own argument rather than what a boot actually writes. Both of its failures are silent and neither is recoverable by the operator — adopting too little leaves an install running on a model this build's seed never heard of with every door refusing it, the settings default, the run form and the chat, as a working configuration reset by an upgrade nobody asked anything of; adopting too often brings back a model the operator deliberately switched off, and brings it back *enabled*, the moment a template still names it. Nothing throws either way, both pages look right, and the second failure only shows up as a run that started on a model somebody had retired.

**`mergeDiscoveredModels` earned its own block in `modelCatalogue.test.ts`:** each of its cases is the operator's configuration changing because a fetch ran, with nothing on any page saying so — which is the one outcome model discovery cannot have. A label or switch the API disagreed with being rewritten, or a row moved; a `[1m]` id or a hand-added one dropped for not being listed, when no listing will ever carry the first; a removed model coming back, enabled, at the next daily check, which is the case for the *offered* record and is asserted both for an id discovery added and for one the operator had typed in before discovery listed it; an empty list — no catalogue at all — filled, which turns refusal back on behind the operator's back. Two more are about what reaches `--model`: ids that are not shaped like one (a flag, a bracketed id, whitespace, upper case, another vendor's name, a bare `claude-`, an overlong string) are refused and reported rather than added, and a dated snapshot is its own entry rather than being folded into the undated id `pricing.ts` prices it as. The display name is asserted cleaned, and the result is asserted to pass `normalizeModelCatalogue` unchanged. Beside them, `discoveredEntriesOf` is pinned on re-validating the stored record it reads, since that row is JSON on disk on the way to argv, and `defaultCatalogueWith` on returning the seed itself when nothing was added and the seed then the additions otherwise. The shape is also run over the seed, so a pattern too strict to admit the ids Anthropic has actually published fails here rather than refusing next week's model.

`modelDiscovery.test.ts` is the network half and the wiring, not a restatement of the merge. Against a stubbed `fetch`: every page is walked from the last one's `last_id`, because a page never asked for is a model never offered; the API key goes as `x-api-key` and the sign-in as a bearer token with the OAuth beta, never both; a 401 is reported as status, endpoint and credential with the provider's text and the credential itself redacted out of it, which is the case for "never log or return the token"; five bodies this build cannot read — not JSON, no `data`, an item with no id, `has_more` with no `last_id`, no `has_more` — and a good first page followed by a bad second are each refused whole, since merging part of a listing uses up the ids on the pages that loaded; a listing that keeps answering the same page is stopped, and an unreachable provider is a sentence. Through a real `DATA_DIR`, in order, `modelAdoption.test.ts`'s rule that the wiring is what can be wrong: no credential and a refusal each leave the catalogue and the stored blob exactly as they were and say why; callers arriving together share one request; additions on an install that never edited its list reach `getSettings()` while the stored blob still carries no catalogue, and stay unstored through a Save of an unrelated key — the case for comparing against `settingsDefaults()`, which fails when `saveSettings` compares against `DEFAULTS`; a template naming one discovered model does not, at the next boot, pin a list without the others — which fails when `adoptModelsInUse` adopts onto the bare seed; a stored list gets the additions written into it with the operator's switch and label intact; a removed discovered model is not brought back; and an empty list stays empty. The two "fails when" claims were each watched by editing the compiled module back to the code they replaced.

`codexAccount.test.ts` is the two parsers over `codex app-server`'s answers, against the payloads measured on 2026-10-07, because both go wrong quietly. For the rate limits: the `codex` bucket is preferred over the single-bucket view and the single-bucket view is the fallback; `resetsAt` is epoch **seconds** and must come out in milliseconds, or every reset instant is a thousand times too early and every park on a full window resumes at once; a window with no number is null and never 0%, a window over 100% is kept rather than capped, a missing reset instant leaves the reading with no instant, and a payload naming no window is no reading rather than an account at 0%. For the model list: the slug `-m` takes is preferred over the picker id, a hidden model is dropped — on the measured account that was `codex-auto-review`, the CLI's own approval reviewer, which would otherwise be on every Codex picker — the cursor is carried, and a body with no list is refused rather than read as no models. `modelCatalogue.test.ts` has a block for the two options the Codex list adds to the shared merge: `isCodexModelId` admits the measured slugs and refuses a flag, upper case, whitespace and an overlong id; `fillEmpty` fills an empty list and nothing else does; a Codex slug is refused under the Claude rule, so the lists cannot cross; the stored record is re-validated with the Codex rule; and `modelRefusal(…, "codex")` names the Codex list, since a sentence sending the operator to the Claude list is one they cannot act on.

`codexModelDiscovery.test.ts` is the wiring through a real `DATA_DIR`, on `modelDiscovery.test.ts`' rule. In order: a signed-out CLI leaves the list empty and says why; the first listing fills the empty default and the stored blob still carries no list, through a Save of an unrelated key as well — the case for `fillEmpty`, which fails with every Codex picker left on free text beside "Listed 3 models" when the option is dropped; an id not shaped like a slug is refused and reported; a stored list gets a later listing's additions with a removed model left removed and a switched-off one left off; and a stored empty list stays empty.

`codexInstructions.test.ts` is the operator's `~/.claude` rules reaching a Codex cycle, and each case is a run that would read as a model ignoring them. A `paths:` scope, block-list or inline, survives as a sentence and the rest of the frontmatter does not reach the model; sections keep the order they were given; sources with nothing to say compose to nothing. Through real directories: the file is written world-readable from the `.md` rules alone, a file a cycle planted — with or without the header — is overwritten, and with no sources left the file is removed, since a file left standing is one every later Codex run reads. `orchestrator.test.ts` pins the `project_doc_fallback_filenames` pair on every Codex argv ahead of `resume`, and the stock-argv and mode-mapping cases moved to account for it on purpose.

