# Option C: Playwright against a running app

The only option that reaches class D, and the only one that changes what CI
*is*.

## What it is

Playwright, a Chromium download, and a running UsageFoundry — which means a
built app, a `DATA_DIR`, a seeded database, and a `CLAUDE_BIN` that cannot
spawn anything billed. Tests drive a real browser against real pages.

## What it buys, and it is the only thing that buys it

Everything in class D:

- the `w-auto`/`w-full` defect, and every future one of its shape;
- the 222 viewport-conditional classes, at whatever widths the harness is
  pointed at — which is what would put `docs/verification.md`'s narrow-viewport
  entries onto a machine instead of a list;
- a page that 500s on load, which today nothing anywhere would catch;
- and, if wanted, an accessibility engine over a *rendered* page, which is the
  form `proposals/OperatorInterface/`'s Option E refused **conditionally**: it
  refused "axe plus jsdom or axe plus Playwright plus a running app" on the
  ground that neither existed, and named this survey's question as the larger
  problem it would not solve in passing.

It is also the only option that can check the six controls added the day this
survey was written, three of which need application state to exist at all — a
queued run, an isolated run with a branch, a directory the server cannot read.

## What it costs, stated with the numbers rather than as a worry

**It contradicts a documented position.** `README.md:985` says CI "never starts
the container and never exercises a run", and the build step's own comment
explains what CI is *for*. Adopting this means rewriting that sentence
deliberately, not routing around it.

**Its maintenance cost is the best-measured thing in this whole area, and it is
not small.** From the vault, all peer-reviewed:

- **44.7%** of UI test flakiness is the async-wait race — the check-then-act
  window between "the element is ready" and "act on it". Playwright's
  auto-waiting eliminates *that* race by construction, which is the strongest
  single reason to prefer it to older harnesses.
- What auto-waiting cannot touch is a race **inside the application**, and the
  same retry machinery that removes the first will retry the second into a
  green build. This app has real ones: a three-second poll, a live guard tick,
  a sweeper, an SSE stream.
- **31.1% of flaky UI tests are repaired by deleting the test.** That is a
  revealed preference about perceived value, measured, and it is the number to
  hold this option to: a suite a third of which gets deleted under pressure was
  worth less than its authors thought.

**And the benefit has never been measured by anybody.** Two papers by the same
group, a decade apart, price browser testing on development and evolution cost
and never on defects found; no study anywhere reports defects-detected-per-layer
for any suite. So this option's case cannot be made from the literature. It has
to be made from *this* repository's own recorded defect, which is a sample of
one — and that is the honest statement of it.

## The narrow form worth considering separately

Not a suite. **A smoke pass**: start the app, open all 19 pages at two widths,
assert no console error, no page 500, no horizontal scroll on the body, and —
because the app already owns the arithmetic — no contrast regression on the
rendered result. That is one file, a handful of assertions, no application
state to seed, and almost no flake surface, because it asserts about load
rather than about interaction.

It reaches most of what class D has actually cost this project and it buys
almost none of what the flakiness literature charges for. It is a different
option from "Playwright in CI" and it is the one that survives
[08-comparison.md](08-comparison.md).
