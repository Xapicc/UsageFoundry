# Frontend

Six gaps. The first two are one mechanism seen twice, and together they are the
worst thing on this axis: **the app cannot find a run it has already done.**

`docs/agent/conventions.md` is unusually strict and the components obey it —
typed variant props with `Record<Union, string>` lookup maps, seven grouping
affordances each capped, `light-dark()` canvas probing, `jsonMaybeGzipped` on
eighteen route handlers. None of these six is a convention violation. They are
things the conventions never had an opinion about.

> **Four of the six were implemented, on branch
> `uf/usagefoundry-721638d11c0b-1-41e5e190`, by two runs that read this file and
> took the implementation rather than the survey the recommendation asked for.**
> F1, F4 and F6 shipped; F2 shipped in half. F3 and F5 are untouched and remain
> open — F3 because [06-recommendation.md](06-recommendation.md) bundles it with
> [B3](02-backend-logic.md#b3-a-chat-turn-exists-nowhere-durable-until-the-child-exits) and [B4](02-backend-logic.md#b4-the-install-ceiling-is-checked-once-per-chat-turn-before-it-and-a-turn-has-no-cap) as one issue about the chat surface, and F5
> because it is a survey rather than a change. Each section below carries a
> status line saying what shipped and where the reasoning went.
>
> **Every status block below was re-checked against `main` at `66fdbab` and
> every line reference inside one is the tree as it stands.** F5's counts were
> re-taken there and all of them moved again. Nothing else on this axis shipped
> in between.
>
> **The argument in this file is deliberately unedited**, and its line
> references are therefore `175ba57`'s. A future reader needs the gap as it was
> stated to judge whether the fix closed it, and three of the four fixes closed
> something narrower than the row described. Where a fix moved the line the
> argument quotes, the status block above it says so and the status block is the
> current reading.

---

## F1 — Run history stops at 100 rows and cannot be paged, filtered or searched

> **Shipped.** Branch `uf/usagefoundry-721638d11c0b-1-41e5e190`, commits
> `7405720` (route, helpers, tests), `d77638d` (the page), `adecd55` (the
> announcement), `a95985e` (the invariants). **The fix was the missing
> parameters, carried across from `/api/branches` exactly as this row argued.**
> `GET /api/runs` now reads `offset`, `limit`, `status`, `q` and `settledBefore`
> (`src/app/api/runs/route.ts:77-97`) and answers a `RunListDTO` carrying
> `total`/`offset`/`limit` beside the rows (`src/lib/apiTypes.ts:1387`);
> `listRunsPage` is the query and `normalizeRunListQuery`/`clampRunOffset` are
> split out pure beside it (`src/lib/orchestrator.ts:1027, :965, :999`). An
> unknown `status` is a 400 rather than a silent fallback to "all"
> (`route.ts:82-89`) — which is this row's own point, since the fallback is the
> miss that reads as an absence. On the page, `SERVER_LIMIT` and the sentence
> admitting the route "does not page beyond that yet" are both gone (`grep -rn
> "SERVER_LIMIT" src/` returns nothing), the status segments moved into the
> **Older runs** fold and are now a `status` on the wire
> (`src/app/runs/page.tsx:676`), and the fold carries a search box and
> Previous/Next over every matching row (`:993-1099`).
>
> **Where the reasoning now lives:** `docs/agent/conventions.md` (a list route
> reads its own parameters and ships `total`/`offset`/`limit`; the 24-hour bucket
> boundary is a third clock shared by both sides), `docs/agent/testing.md` (what
> the three pure functions' tests earned), `docs/runs.md` (the operator's half)
> and `docs/verification.md` (the SQLite figures, and the six things only a
> browser can confirm).
>
> **What is still true of this row.** The four-second poll
> (`src/app/runs/page.tsx:642`) still asks `/api/runs` with no parameters
> (`:612`) and so still takes the route's default page — deliberately, because
> the two sections above the fold are "what is happening now". The whole history
> is reachable through the fold, not through the top of the page.

`src/app/api/runs/route.ts:49` is the whole of it:

```ts
const rows = listRuns(100);
```

No `searchParams` is read. There is no `offset`, no `limit`, no `repo`, no
`status`, no text query. The page knows, and says so —
`src/app/runs/page.tsx:82` sets `const SERVER_LIMIT = 100;` and `:840-844`
renders the admission:

```tsx
{runs.length >= SERVER_LIMIT && (
  <p className="mt-3 text-xs text-ink-muted">
    Showing the {SERVER_LIMIT} most recent runs — the list route does
    not page beyond that yet.
  </p>
)}
```

The status filter at `:495` and `:608` is client-side, over the hundred rows
that already arrived. Filtering to `failed` shows the failed runs *among the
hundred newest*, which is a different question from "show me the failed runs"
and looks identical.

**The contrast is in this repository, one directory over.** When issue #72 was
fixed, `/api/branches` got exactly the missing parameters, and its docstring at
`src/app/api/branches/route.ts:19-23` states the principle the runs route does
not follow:

> `repo` and `offset` are what make the whole set reachable rather than only its
> newest page.

So this is not an unconsidered design. It is a design that was reasoned through
for branches and never carried across to runs. That is the strongest case for
calling it a gap rather than a preference: the house already decided which side
it is on.

**Blast radius.** Every retrospective question. "What did the nightly schedule
do last week", "which runs on this repository ended `needs-review`", "how much
did that workflow cost". A fleet at `maxConcurrentRuns` with a schedule behind
it produces a hundred runs in hours, and everything before them is reachable
only by URL if the operator kept the id.

**Cost of leaving it.** The app accumulates a history it cannot show. Worse, it
accumulates one it cannot show *silently* for the first ninety-nine runs, so the
limit is discovered at the moment it starts mattering.

**Confidence: high.** Read directly from three files; no inference.

**Owned by:** nothing. #122 and #147 are open and neither is this.

---

## F2 — Quick open, the app's only search surface, inherits that cap

> **Shipped in half, and the half that shipped is the cap.** Branch
> `uf/usagefoundry-721638d11c0b-1-41e5e190`, commit `f7617fb`. Typed text now
> asks the route rather than filtering the cached page: `/api/runs?q=`
> `SEARCH_SETTLE_MS` = 250ms after the last keystroke
> (`src/components/shell/QuickOpen.tsx:22, :135, :157-158`), which matches the
> whole task text, the folder and the id across every row in the table. The rows
> it draws back are deliberately not matched again in the client, because the
> prompt on the wire is clipped to `MAX_LIST_PROMPT` and a second pass would find
> a match further into a long task and then drop it (`:241-248`). A search
> failure gets its own message rather than writing over the list load's
> (`:108, :163-167, :331-333`).
>
> **The other half of this row did not ship, and the sentence it turns on is
> still true at `66fdbab`.** The corpus is still panes, runs and workflows
> (`QuickOpen.tsx:118-119, :204, :221, :229`, and the input's own label at
> `:315` says so: "Search panes, runs and workflows"): it cannot find a *chat*, a
> *branch*, an *agent*, a *template* or a *schedule*. Only the run half of
> "indexes two lists" was parameterised — `/api/workflows` still ships its whole
> list and is still filtered in the client, which is sound while that list is
> small and whole, and is not a search. The claim below that "nothing indexes the
> app's own objects" is now wrong about runs and right about everything else.
>
> **And the corpus fell further behind between `175ba57` and `66fdbab`.** Three
> pages were added in that window — `/dreaming` (`src/app/dreaming/page.tsx`),
> `/runs/[id]/touched` and `/runs/[id]/conflicts` — and `PANES` grew to ten
> entries (`src/components/shell/panes.ts:43-70`), so `⌘K` reaches the *pane*
> `/dreaming` and nothing it holds. A dreaming note, a touched-file record and a
> conflict map are three more object kinds nothing indexes.
>
> **F6's shipped fix is *not* the search this row suggested twice.** The settings
> field search is page-local and reads `/settings`' own rendered DOM
> (`src/app/settings/page.tsx:200-222`); nothing reaches a settings field from
> `⌘K`. Two searches, not one.
>
> **Where the reasoning now lives:** `docs/agent/conventions.md` (quick open's
> typed text is a third read, not a filter over the first; and it reads the list
> DTOs through an unchecked `jsonRequest` cast), `docs/runs.md` and
> `docs/verification.md`.

`src/components/shell/QuickOpen.tsx:82-83`:

```ts
jsonRequest<{ runs: RunListItemDTO[] }>("/api/runs"),
jsonRequest<{ workflows: WorkflowListItemDTO[] }>("/api/workflows"),
```

Then a client-side filter. Its corpus is those two lists, so it cannot find a
*chat*, a *branch*, an *agent*, a *template*, a *schedule*, or a run past the
hundredth. `⌘K` presents itself as "find anything here" and is in fact "filter
the two newest lists".

A sweep for every place in `src/app` and `src/components` that matches typed
text against a collection finds two others, and neither is a search: the chat
composer's agent picker filters agent names at
`src/app/chat/page.tsx:459`, and `/api/knowledge/search` searches the
operator's **vault**. Nothing indexes the app's own objects.

The failure mode is the bad one: a miss is indistinguishable from an absence.
Typing a run's task text and getting nothing back reads as "that run does not
exist", not as "that run is on page two of a route that has no page two".

**Blast radius.** Every navigation that is not a click through a list.

**Cost of leaving it.** [F1](#f1-run-history-stops-at-100-rows-and-cannot-be-paged-filtered-or-searched) makes history unreachable by browsing; this
makes it unreachable by searching. Fixing either alone leaves the other route
closed, which is why the register treats them as one item with two heads rather
than two independent ranks.

**Confidence: high.**

**Owned by:** nothing.

---

## F3 — A chat turn renders nothing until it finishes; the run path streams

> **Did not ship. Open, unchanged at `66fdbab`.** The line moved and the code on
> it did not: `src/lib/chat.ts:2358` is still
> `child.stdout.on("data", (c: string) => (stdout += c))`, the assistant message
> still reaches `chat_messages` once through the `INSERT` at `:428`, and nothing
> on the chat path streams. The page still polls
> (`src/app/chat/page.tsx:462`) and still shows `Thinking…` until the turn ends
> (`:1596`). `chat.ts` went from 2,397 lines to 3,065 and `src/app/chat/page.tsx`
> took 1,600 changed lines over the same window (`git diff --stat
> 175ba57..HEAD -- src/lib/chat.ts src/app/chat/page.tsx`), and none of it is
> this. This row's recommendation was never that it be built alone:
> [06-recommendation.md](06-recommendation.md) files it with
> [B3](02-backend-logic.md#b3-a-chat-turn-exists-nowhere-durable-until-the-child-exits) and [B4](02-backend-logic.md#b4-the-install-ceiling-is-checked-once-per-chat-turn-before-it-and-a-turn-has-no-cap) as one issue about the chat surface,
> because the durability half is the part that costs money and the two share a
> mechanism.

Two children of the same kind, two experiences.

The run path streams. `src/app/api/runs/[id]/stream/route.ts` is an SSE route,
consumed at `src/app/runs/[id]/page.tsx:552`, and `emit()` persists to
`run_events` *then* publishes — the ordering `docs/agent/architecture.md` calls
out as what makes reconnect lossless. An operator watching a run sees each tool
call as it happens.

The chat path does not. `src/lib/chat.ts:1731`:

```ts
child.stdout.on("data", (c: string) => (stdout += c));
```

The entire turn accumulates in one string. The assistant's message is inserted
into `chat_messages` once, after the child exits, through the statement at
`:330`. The page polls — `src/app/chat/page.tsx:362`,
`const t = setInterval(() => void load(chatId), period);` — and until the turn
ends there is nothing to poll for, so it shows `Thinking…` at `:765`.

Two consequences, and the second is not a UI problem at all:

1. A turn that takes four minutes shows four minutes of a spinner. There is no
   signal that it is working rather than wedged, and no way to tell an expensive
   turn from a stuck one before paying for it.
2. **A turn is not durable until it exits.** If the process is killed, the
   container restarts, or the operator closes the browser and the child dies,
   the text is gone — it lived only in that string. The cost is gone too:
   `chat_turn_spend` is written at `src/lib/chat.ts:1978`, after the latch, so a
   turn that dies mid-flight spent money the install ceiling never sees. This
   half is [B3](02-backend-logic.md#b3-a-chat-turn-exists-nowhere-durable-until-the-child-exits) and is ranked there.

**Blast radius.** Every orchestrator chat turn — which is the surface
`docs/agent/chat.md` describes as the one where a model may write half of a run.

**Cost of leaving it.** The chat is the newest operator surface and it feels the
least alive. The mechanism it lacks is not novel: it is in the repository, one
route away, already reasoned about.

**Confidence: high** on the mechanism. **Assumed:** that the four-minute figure
is representative — no live chat was observed, and turn durations would come
from the unreadable `DATA_DIR`.

**Owned by:** nothing. #114 is open and is not this.

---

## F4 — A run's log cannot be searched or filtered

> **Shipped.** Branch `uf/usagefoundry-721638d11c0b-1-41e5e190`, commits
> `e250524` (the grouping and its tests), `e16fd7f` (the controls and the
> truncation count), `89afdc0` (the announcement), `a34e56b` (the alignment),
> `42ef208` (what the test earned). **The fix was a text box and a kind picker
> over the array already in client state, exactly the shape this row called the
> cheapest thing here to close** — no route, no query, nothing fetched
> (`src/app/runs/[id]/page.tsx:511-512, :650-660, :1814-1826`).
>
> One thing about it was not obvious from this row and is the part that fails
> silently: the filter takes the **event's kind** beside the rendered line
> (`matchesLogFilter` at `src/lib/logLine.ts:730`), because `describeEvent` sets
> `tool_error` and `sandbox` as *system* rows — the tool voice is what a call that
> worked looks like. Grouped on the rendered voice, "show me the tool calls" would
> answer with every call except the ones that failed. `EVENT_GROUP`
> (`src/lib/logLine.ts:691`) is a `Record` over the whole kind union rather
> than a switch with a default, so a kind added to `RunEventDTO` is a compile
> error instead of an event that belongs to no group.
>
> This row's compounding half was answered rather than left standing. The stream
> route now sends the dropped-event count as a number beside the sentence it
> already sent (`src/app/api/runs/[id]/stream/route.ts:135-141`), and with a
> filter on the field carries a warning hint naming it
> (`src/app/runs/[id]/page.tsx:1804-1805`) — because a filter that finds nothing
> in a knowingly incomplete log otherwise reads as proof of absence.
>
> **Re-checked at `66fdbab`: still whole.** `logFilterActive`
> (`src/lib/logLine.ts:716`) and `matchesLogFilter` both survive, and the page
> still reads the event's kind rather than the rendered voice.
>
> **Where the reasoning now lives:** `docs/agent/conventions.md` (the filter reads
> the event, never the rendered voice), `docs/agent/testing.md` (what
> `matchesLogFilter`/`logFilterActive` earned), `docs/runs.md` and
> `docs/verification.md`.

Neither `src/components/ui/Log.tsx` nor `src/components/RunOutput.tsx` contains
a filter input, a search box or a level selector. The log is scroll-only.

This compounds with how events arrive: `runEvents` pages by id and reports a
`dropped` count (`src/lib/orchestrator.ts:640-665`), so a long run's log is both
long and knowingly incomplete, and the operator's only tool for finding the tool
call that mattered is the browser's own `⌘F` over whatever is currently in the
DOM.

**Blast radius.** Post-mortem on any run of more than a few dozen events, which
after several work cycles is most of them.

**Cost of leaving it.** Diagnosing a failed run means reading it. This is the
smallest item on this axis and the cheapest to close — a filter box over an
array that is already in client state.

**Confidence: high** that no filter exists. **Medium** on the severity: no run
history was readable, so "most runs are long" is inference from the work-cycle
model, not a measurement.

**Owned by:** nothing.

---

## F5 — Nothing that renders is checked by anything

> **Did not ship. Open, and every count in it has now moved the wrong way
> twice.** No page test, no jsdom, no browser was added on branch
> `uf/usagefoundry-721638d11c0b-1-41e5e190` — `package.json` and the lockfile are
> untouched by it, and the only test files it changed are
> `src/lib/orchestrator.test.ts` and `src/lib/logLine.test.ts`, both pure. The
> four fixes above added roughly 900 lines of page code (`+286` on
> `src/app/runs/page.tsx`, `+243` on `src/app/settings/page.tsx`, `+185` on
> `src/app/runs/[id]/page.tsx`, `+130` on `src/components/shell/QuickOpen.tsx`,
> from `git diff main...HEAD --stat`), all of it interactive, and **page
> components rendered by a test is still 0**. `npm test` on this branch is
> 1,660 tests / 245 suites / 0 failures, against the 1,578 / 230 this survey
> recorded — 82 more assertions, none of them about anything that renders. That is
> this row's whole claim, which is that the cost of leaving it rises with the
> code: it just did.
>
> **And again by `66fdbab`.** The table below is re-taken there and every figure
> in it is worse than the one it replaces. `src/app/**/page.tsx` went from 16,529
> lines to **20,447** — three new pages among them (`/dreaming`,
> `/runs/[id]/touched`, `/runs/[id]/conflicts`) — the suite went from 1,578 tests
> to **2,259**, and **page components rendered by a test is still 0**. The gap
> between the two numbers is the row: 681 more assertions and 3,918 more lines of
> page code, and the second number is checked by nothing. `grep -nE
> "jsdom|testing-library|playwright|puppeteer" package.json` still returns
> nothing.

The suite is real and it stops at the door of the UI. **The figures below are
`66fdbab`'s; the survey's own are in the status block above.**

| | |
|---|---|
| Test files in `src/` | 128 (was 88) |
| Tests, suites, failures | 2,259 / 351 / 0 (`npm test`, 16.4 s) — was 1,578 / 230 / 0 |
| Tests under `src/app` | 10 — seven route handlers, one DTO builder (`api/chat/dto.test.ts`), two pure helpers (`runs/new/budgetPayload.test.ts`, `runs/new/formProblems.test.ts`) |
| Page components rendered by a test | **0** |
| Lines of `src/app/**/page.tsx` | **20,447** (was 16,529) |
| Component tests | 11: `Meter`, `Markdown`, `LiveTelemetry`, `UsagePeriods`, `ContextOccupancy`, `RecentBlocksCard`, `RunHandoff`, `ui/Disclosure`, `ui/LimitField`, `ui/ListView`, `ui/Table` |
| Their mechanism | `renderToStaticMarkup` — server markup, asserted on class strings |
| jsdom, `@testing-library`, Playwright, Puppeteer in `package.json` | **none** |
| Browser driven in CI | none; `.github/workflows/ci.yml` runs typecheck, test, build, and an `npm audit` job (`:102-163`) |

`README.md:983` states the position plainly: CI **"never starts the
container and never exercises a run."**

The eight component tests are not a token effort — each one is documented as
earning its place because a styling invariant fails silently in both directions,
which is exactly the bar `docs/agent/testing.md` sets. They are also the
complete list. Sixteen and a half thousand lines of page code, all the state
machinery, every fetch boundary, every poll gate, is checked by a human opening
a browser or not at all.

**And often not at all.** `docs/verification.md:1865` — "## Not yet verified by
hand" — is **91 entries** at `66fdbab`, **ten** of which name a narrow viewport,
including the stacked tables at 390px (`:3040`) and the mobile form pass
(`:3104`), with the note at `:3253` that *the browser refused to resize*. That
list was four narrow-viewport entries when this row was written.
`docs/agent/conventions.md` makes stacking a hard invariant:
a table stacks below `md` only with `Table stack` **and** a `label` on every
`Td`, and one without the other is a column of unnamed figures. That invariant
has a test (`ui/Table.test.tsx`) and has never been seen.

**What the vault says, including where it says less than you would want.**
`3 Resources/Testing and Correctness/The Test Pyramid.md` (confidence: low) is
careful: the *cost* claim is supported — a defect caught at a lower level is
cheaper — while the familiar ratios were never measured and the note declines to
endorse them. So it argues for having *something* below the browser layer, not
for a target number. And
`3 Resources/Web Design/Automated Accessibility Testing Coverage.md` (medium,
updated 2026-08-23) argues against over-reading whatever gets built: automated
coverage lands between 13% and 57.38% of real issues depending on the
denominator. A rendering test suite would be a real improvement and would not be
a guarantee, and this survey declines to imply otherwise.

**Blast radius.** Every visual and interactive regression, on a codebase whose
own documentation says its invariants fail *silently*.

**Cost of leaving it.** Rising. This is the axis where the cost of the gap grows
with the code rather than staying flat, because each new page adds surface that
nothing watches.

**Confidence: high** on every count above; all of them are `find`, `grep`,
`wc -l` or `npm test` output.

**Owned by:** #155 is open and is adjacent — read it before opening this. The
scope here is broader than any one issue.

---

## F6 — Settings is nine sections in a 3,502-line page with no way to find a field

> **Shipped, and so did the thing this row filed as an issue rather than a row.**
> Branch `uf/usagefoundry-721638d11c0b-1-41e5e190`, commits `a8f2984` (the field
> search) and `bdbdf08` (the unsaved-edit prompt). **The fix was a route to a
> field and nothing more** — the sections are not collapsed, reordered or
> re-nested, which is the restructure `proposals/OperatorInterface` refuses by
> name. **Find a setting** sits above the chips
> (`src/app/settings/page.tsx:2357-2392`, chips at `:2426`), capped at eight
> results with the count it dropped stated beside them (`MAX_FIELD_HITS` at
> `:191`, read at `:2387-2392`), and pressing one scrolls the field in, focuses
> its control and fills its section's chip.
>
> The load-bearing decision is the corpus: `findFields` walks the **rendered
> page** for `[data-setting-name]` marks (`:200-222`), not a declared index of
> every field. An index would duplicate sixty labels and their help text with
> nothing keeping the two in step, and a search that names a field the page no
> longer has is worse than no search — it sends the reader after a control that
> is not there and looks exactly like a search that works. It is rebuilt on every
> keystroke and on every edit, because several descriptions interpolate the value
> beside them and some rows exist only while the switch above them is on.
>
> `grep -rn "beforeunload" src/` no longer returns zero: the listener is at
> `src/app/settings/page.tsx:2031-2032`, registered **only while `dirty`**
> (`:2000-2005`) and torn down the moment it is not, because a listener that
> outlives the dirty state prompts on a page with nothing on it and teaches the
> operator to dismiss the dialog without reading it. `preventDefault` and
> `returnValue` both, since either alone is a silent no-op in a browser somebody
> uses. It does not cover a client-side navigation and cannot without the shell
> holding this page's state; that is the known gap, and the per-field rails and
> the bar's unsaved count are what stand in for it.
>
> The page was 3,776 lines when the fix landed, against the 3,502 this row
> surveyed. Which is the honest reading of that fix: it made the page findable,
> not smaller.
>
> **At `66fdbab` it is 4,298 lines and ten `SECTIONS`, not nine** (`:105-116`) —
> "Dreaming" was added between the two, at `:3923`. The search still reaches
> every field in it, because `findFields` loops over `SECTIONS` and reads the
> rendered page rather than a declared index somebody has to remember to extend
> (`:200-222`), which is the decision above earning its keep: a tenth section
> arrived and nothing had to be told about it.
>
> **Where the reasoning now lives:** `docs/agent/conventions.md` (the corpus is
> the rendered page; the prompt is gated on `dirty`), `docs/install.md` (the
> operator's half) and `docs/verification.md`.

`src/app/settings/page.tsx` is 3,502 lines and declares nine `SECTIONS` at
`:100-111`, navigated by chips at `:1857`. There is no search input on the page.

The page is not careless — the opposite. It tracks a saved baseline (`savedS`,
`:1349`), derives `dirty` (`:1576`), marks individual changed fields
(`:676-678`) and binds `⌘S` (`:1698-1703`). `docs/agent/conventions.md`'s
`saveSettings` invariant — store only what differs from `DEFAULTS`, because
writing the whole object kills every future default on that install — is
honoured. The gap is narrower and duller than "settings is a mess": an operator
who knows a setting exists and does not remember which of nine sections holds it
has no route to it except opening sections.

One thing worth noting rather than fixing: **`grep -rn "beforeunload" src/`
returns zero hits**, so navigating away with unsaved edits loses them
without a prompt. The per-field dirty marks make the state visible while you are
on the page, which is most of the protection, and this survey rates the missing
prompt as an issue somebody should file rather than as a register row.

**Blast radius.** Configuration, on the install's single most consequential
page — the guards, the enforcement mode, the model, the plugin set.

**Cost of leaving it.** Small and constant. It is on the register because it is
cheap and because [F2](#f2-quick-open-the-apps-only-search-surface-inherits-that-cap) suggests the fix twice: a search that reached
settings fields would close both.

**Confidence: high** on the structure. **Medium** on the severity — nine
sections is not obviously too many, and no operator was observed failing to find
anything.

**Owned by:** nothing.
