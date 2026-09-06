# What checks the interface today, measured

Every figure here was taken from the tree on 2026-09-06, at the commit that
closed thirteen gap-register rows. Commands are given so each can be re-run
rather than believed.

## The two sides of the ratio

| | Count | How |
|---|---|---|
| Pages | 19 | `find src/app -name page.tsx \| wc -l` |
| Lines of page code | **20,765** | `find src/app -name page.tsx \| xargs wc -l` |
| Component files | 63 | `find src/components -name '*.tsx' \| wc -l` |
| Lines of component code | **19,807** | same, over `src/components` |
| Tests | **2,289** in 356 suites | `npm test` |
| Test files that render anything | **11** | `grep -rln renderToStaticMarkup src/` |
| `renderToStaticMarkup` call sites in them | 124 | `grep -c` per file |
| **Page components rendered by any test** | **0** | there is no import of a `page.tsx` in any test file |
| jsdom, `@testing-library`, Playwright, Puppeteer, Cypress, vitest | **none** | `package.json` |

The eleven that do render are components rather than pages, and they are a
deliberate list rather than a sample: `Markdown` (63 renders — it is a parser
with an output format), `Meter`, `Table`, `Disclosure`, `ListView`,
`LimitField`, `ContextOccupancy`, `LiveTelemetry`, `RecentBlocksCard`,
`RunHandoff`, `UsagePeriods`. Each earns its place on `docs/agent/testing.md`'s
own bar and none of them is a page.

**The trend is the finding rather than the level.** At `175ba57` the register
recorded 16,529 lines of page code and 1,578 assertions. At `66fdbab`, 20,447
and 2,259. Now 20,765 and 2,289. Page code has grown **26%** since the survey
was written and the number of page components rendered by a test has been zero
throughout.

## What CI does

`.github/workflows/ci.yml` runs four things: `npm run typecheck`, `npm test`,
`npm run build`, and an `npm audit` job. `README.md:985` states the boundary in
its own words — CI **"never starts the container and never exercises a run"** —
and that sentence is a decision rather than an omission: the build step's own
comment explains that it exists because the deployment artefact was previously
the one thing nothing verified.

So there is a place to put a check, and there is a documented position about
what that place is for.

## What stands in for it now

`docs/verification.md`, which is 5,782 lines and holds **33 entries** on its
*"Not yet verified by hand"* list. It is the honest record and it is also the
measurement of the gap: a prose list that long is a backlog of things somebody
intended to look at.

Six controls were added on the day this survey was written and **none of them
has been rendered in a browser** — the `landVerifyCommand` field, the Backups
row and its unreadable state, the sign-out sentence, the queue-priority input,
the Deliver button, and the chat turn's live view. The last is the one whose
whole point is what it looks like while it moves.

## The surface that only a rendered page can decide

`grep -rohE '(max-)?(sm|md|lg|xl):[A-Za-z0-9:_.\[\]/%-]+' --include='*.tsx' src`
returns **222 occurrences of 93 distinct viewport-conditional classes across 39
files**. Every one of them is a claim about layout at a width, and
`docs/agent/conventions.md` argues several of them at length — `Table`'s `stack`
below `md`, `SegmentedControl`'s `max-md:flex-wrap` against "about 330px of
segments in the ~358px a 390px phone has", `ListRow`'s `min-w-32` deciding when
a row breaks, the branches page's fixed bar stepping around a sidebar that is
not there below the breakpoint, the canvas refusing to be *arranged* at one
column.

Each of those is a measured argument about a rendered box. **None of them is
checked by anything**, and the arithmetic in them is the kind that goes wrong
silently: a class added later that changes a flex basis does not fail a
typecheck.

## One defect of that class has already shipped and been found by hand

`src/components/RunLand.tsx` carries the account in a comment, and it is the
best single argument in this repository for what a rendered check would buy:

> The width is on the wrapper and never on the control. `Select` composes
> `CONTROL`, which already states `w-full`, and two width utilities on one
> element resolve by their order in the emitted stylesheet rather than by the
> class attribute — Tailwind emits `.w-auto` ahead of `.w-full`, so the
> `w-auto` that used to sit here lost silently: the select filled the flex line
> and `flex-wrap` put `Land into …`, the most consequential button in the app,
> on a row of its own beneath a full-width dropdown.

Read what it takes to decide that. The class attribute is right. The markup is
right. The component is right. The defect is in **the order two rules are
emitted into a stylesheet and what a flex container then does with the
result** — so no assertion over a class string sees it, and no engine that does
not do layout sees it either. It took a person looking at the page.
