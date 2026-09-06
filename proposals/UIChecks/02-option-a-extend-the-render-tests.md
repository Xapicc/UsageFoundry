# Option A: extend `renderToStaticMarkup` to what has none

The smallest possible step, and the only one on this list that adds no
dependency, no runtime, and no new way for a build to fail.

## What it is

Eleven test files already render components with
`react-dom/server`'s `renderToStaticMarkup` and assert over the markup, inside
the `node --test` suite that runs today. This option writes more of them, for
the components and invariants that have none.

There is real material. `docs/agent/conventions.md` states a dozen rules that
are markup facts: which colours a chart's marks may take and that a status tone
is not among them; that a `Td` under `stack` carries the `label` naming its own
field, and that the explicit ARIA roles come with it because `display: block`
strips a table element's implicit role; that a caller's class must not cancel a
component's spacing. Each of those is decidable from one render.

## What it buys

Class B in [01](01-what-only-a-rendered-page-decides.md), and it buys it at the
lowest cost of anything here: no install, no browser download, no CI step, no
flake surface, and it runs in the same second as the other 2,289 assertions.

It also buys something the other options do not: **it is the only one that
makes the existing eleven files a pattern rather than an exception.** A twelfth
looks like the eleventh and needs no argument from anybody.

## What it cannot buy, stated exactly

`renderToStaticMarkup` is one pass with no state, no effects and no CSS.

- `useState` returns its initial value; nothing sets it.
- `useEffect` never runs, so anything gated on a fetch renders in its
  pre-fetch state for ever. The chat page's partial view, the settings page's
  whole body, the run page's tabs — none of them has a second state to render.
- **There is no layout and no cascade.** The one interface defect this
  repository has recorded — the `w-auto` that lost to `w-full` because of the
  order two rules were emitted into a stylesheet — is invisible to it. The
  class attribute the assertion would read is *correct* in the broken version.
- Nothing in the 222 viewport-conditional classes can be evaluated, because
  there is no viewport.

## The honest form of this option

Not "extend it to the pages" — the pages cannot be rendered this way in any
useful state. It is: **extend it to the kit and to the pure presentational
components, and stop there deliberately**, with the ceiling written down so the
next person does not read a green suite as coverage of the page.

## Cost

An afternoon per batch, forever available, zero recurring. No decision has to
be reopened to do it later, which is the property that makes it a bad thing to
argue about and a good thing to have already done.
