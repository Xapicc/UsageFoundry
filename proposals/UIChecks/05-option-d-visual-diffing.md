# Option D: visual diffing

Screenshot a page, store it, compare the next one against it.

## Why it is attractive here

It is the only technique that needs nobody to *write* the assertion. This app
has 222 viewport-conditional classes and a design system nobody has enumerated;
an oracle that catches "this looks different from yesterday" without anybody
listing what to check is precisely what a codebase with 40,000 lines of
interface and zero rendered checks would want.

And the one defect that shipped would have been caught by it trivially: a
full-width dropdown pushing a button onto its own row is a large pixel diff.

## Why it is refused

**It replaces a written assertion with an oracle nobody wrote, and the oracle
is a property of the machine that produced it.** A baseline encodes a *state*,
including every accident in it — the font stack the runner happened to have,
its subpixel rendering, its device pixel ratio, the second the clock read.

Three consequences, and each is specific to this app rather than general:

1. **Every page here renders live data.** Run ids, costs, elapsed clocks,
   relative timestamps ("3 min ago"), token counts, a spinner. A baseline over
   any of them is a baseline that fails on the next run for reasons that are
   not defects, and masking each one is a growing list of masks that is itself
   the coverage nobody is measuring.
2. **The app is theme-aware by construction**, so every baseline doubles, and
   `light-dark()` inside `color-mix()` resolves per machine.
3. **No published measurement shows what it catches that an assertion-based
   test does not.** That is the vault's own summary of the area, at
   `confidence: low`, and it is the same hole as the browser-test one: the
   technique is argued and never measured.

The failure mode is the one that ends these suites: a diff that fires on
nothing, is dismissed, and is then dismissed on the day it fires on something.

## The condition that would flip it

A page in this app that is genuinely static, visually load-bearing, and whose
rendering nobody would otherwise check — a printed report, an exported
artefact. There is none today.
