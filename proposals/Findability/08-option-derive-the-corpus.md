# 08 — Option 5: derive the corpus instead of registering it

**Verdict: accepted for destinations. Rejected for content — and the reason it
splits is the most useful thing in this survey.**

## What it is

Stop hand-writing the list of things that can be found, and compute it from
something the app already maintains. Two candidate sources:

- **the route tree** — Next.js already knows every `page.tsx`;
- **`sqlite_master`** — SQLite already knows every table and column.

A derived corpus cannot drift, by construction. §03 measures why that matters.

## This app has already made this choice once, and written down why

The settings field search is a derived corpus in the tree today. `findFields`
(`src/app/settings/page.tsx:201-222`) walks the rendered page for
`[data-setting-name]` marks rather than consulting a list of fields. Its
docstring, `:194-200`:

> **Reads the rendered page rather than a declared index**, for the reason
> `SettingName` records. Nine sections are anchors on one long page, so all of
> them are in the DOM at once and a walk over it is the whole corpus.

And the reason, at `docs/agent/conventions.md:16`:

> Not a declared index: that would duplicate sixty labels and their help text
> with nothing keeping the two in step, and **a search naming a field the page no
> longer has is worse than no search** — it sends the reader after a control that
> is not there and looks exactly like a search that works.

That is this option's whole argument, already decided, at the app's largest
single page — sixty fields against nineteen pages — with the drift hazard named
in the same words §03 measures on `panes.ts`. The only question this survey adds
is why the same reasoning was not applied to the app's list of *destinations*,
which is the smaller and more consequential list.

Note the direction of the analogy and its limit: `findFields` derives from the
DOM because settings is one page whose whole corpus is rendered at once. Nothing
here proposes searching the DOM for panes — the app's destinations are not all
mounted at once. The transferable part is the *principle*, and the source for
destinations is the route tree.

## Derived from the route tree — accepted

`PANES` (`src/components/shell/panes.ts:42-71`) is ten hand-written rows
describing nineteen pages. §03 shows it has already lost one:
`/runs/[id]/conflicts` is absent from `PANES` *and* from `toolbarTitle`, so it is
unreachable from quick open and its toolbar says "Run".

The pages exist on disk. `find src/app -name page.tsx` is the corpus, and it is
correct the moment a page lands, with nobody remembering anything.

What is genuinely hand-written and *should* stay so is not the list — it is the
per-pane **metadata**: label, icon, and shortcut digit. `panes.ts:52-70` spends
ninety words on why the digits are ordered as they are and what may never be done
to them; that is a product decision and no derivation will produce it. The
sentence at `:32-38` — "the digit after ⌘, or absent past the ninth row" — is the
same. Those belong in a hand-maintained file.

So the shape is: **derive the set, hand-write the presentation, and let a page
present in the tree but absent from the metadata still be findable under its path
rather than invisible.** Today the two are one list, and absence from the list
means absence from the app's navigation. That is what turned one forgotten line
into an unreachable page.

Cost to keep correct: **zero remembering.** A page added tomorrow is findable
tomorrow. A page that wants a sidebar row and a ⌘ digit still asks for them by
hand — which is correct, because a digit is scarce and a route is not.

Cost to build: modest, and the awkward part is honest — Next.js's route manifest
is not a stable public API to read at runtime, so the practical implementation is
a build-time glob rather than a runtime one. That is a real constraint and it
does not change the conclusion: a generated list is still generated.

## Derived from `sqlite_master` — rejected

The same trick over content is a schema-derived index: enumerate every `TEXT`
column and search them all. New table, searchable free, no registration.

It fails for §05's Refusal 3, and this is where the two derivations part company.
Deriving a set of **destinations** is safe because a route is public by
construction — it is an address the app already serves. Deriving a set of
**columns** is not, because a column carries no signal about whether its contents
are for the operator.

`run_events.payload` (`src/lib/db.ts:167`) is `TEXT NOT NULL` and holds raw agent
stdout. `chat_messages.text` (`db.ts:612`) holds model output. `auth_sessions.id`
(`db.ts:581`) is `TEXT` — not itself a bearer token, since the cookie is an HMAC
over it plus the expiry (`src/lib/sessionToken.ts:12`), but not a search result
either. Roughly half the tables listed in §01 are written-only telemetry that no
route reads today.

A schema-derived search would surface all of it. Correcting that needs a per-table
decision, and a per-table decision is a registration — which is the thing this
option was chosen to avoid. It also fails in the unsafe direction: forgetting to
exclude leaks, forgetting to include merely fails to find.

## The general rule this yields

> Derive what the framework already knows and the operator may already reach.
> Register what a human must judge.

Routes are the first. Columns are the second. That rule survives the next page
and the next table without amendment, which is the property §03 says to optimise
for.
