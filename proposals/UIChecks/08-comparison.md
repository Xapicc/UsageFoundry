# What each one buys, and what it fails for other than a defect

The pyramid note's real contribution is the second question, so both are here.
A test that fails for a reason unrelated to the code is a test that gets
deleted — measured at **31.1%** for flaky UI tests.

| | Reaches | New deps | Runs in CI today | Fails spuriously for | Recurring cost |
|---|---|---|---|---|---|
| **A** extend `renderToStaticMarkup` | B | none | yes | nothing — no clock, no network, no layout | ~0 |
| **B** jsdom + `@testing-library` | C | 3 | yes | a fake timer, an unawaited effect | low |
| **C1** Playwright suite | C, D | 1 + Chromium | **no** — contradicts `README.md:985` | app races, the runner's fonts, timing | **high** |
| **C2** Playwright *smoke pass* | most of D | 1 + Chromium | no, same | a page that is slow to boot | low–moderate |
| **D** visual diffing | D, unwritten | 1 + Chromium | no | live data, fonts, DPR, theme, the clock | high and rising |
| **E** written checklist | E, and any other by hand | none | n/a | nothing; it does not run | one person's afternoon per pass |

## The three that answer questions nobody asked

**D is refused.** Every page in this app renders live data — run ids, costs,
elapsed clocks, relative timestamps, a spinner — so a baseline fails on the next
run for reasons that are not defects, and the mask list becomes the coverage
nobody is measuring. It also has no measured benefit over an assertion.

**C1 is refused in that form.** Not because a browser is wrong — it is the only
instrument that reaches the class this project's one recorded defect belongs to
— but because a *suite* buys the whole measured maintenance tax for a benefit
nobody anywhere has measured, on a project with one operator. The 31.1% figure
is what a suite that outruns its owner looks like.

**B is refused as the headline**, and this is the closest call in the survey. It
would be the right answer if this interface's failures were state machines. Its
disqualifying property is not what it misses but that **it looks like it does
not**: a green `@testing-library` run over `/settings` reads as *the settings
page is checked*, and the one defect that page's family has actually had is
structurally outside it. An option whose coverage is systematically
over-read is worse, on a one-operator project, than a smaller one that is not.

## The two that survive, and they answer different questions

**A** is what makes the eleven existing render tests a pattern instead of an
exception, costs nothing, flakes for nothing, and can be extended forever
without reopening any decision. It does not close the register's row.

**C2**, the smoke pass, is what closes it: start the app, open all 19 pages at
two widths, assert no console error, no non-200, no horizontal body scroll.
That is the narrowest instrument that reaches class D at all, and it is aimed at
what class D has actually cost this project rather than at what a browser
*could* be asked.

## Why C2 rather than nothing

The register ranks F5 first for one reason and it is a measurement rather than a
prediction: **page code has grown 26% since the survey was written and the
number of page components rendered by a test has stayed at zero.** The cost of
this row is the only one on the register that grows with the codebase.

A smoke pass does not need the argument about defect detection that nobody can
make. It needs a much smaller one: *there are 19 pages, and nothing anywhere
establishes that any of them renders at all.* That is not a claim about coverage
percentages, it is a claim about a floor, and this project does not have one.

## What C2 must not become

Named here because this is where these things go wrong: it must not grow
assertions about application behaviour. The moment it seeds a run to press
Deliver, it acquires the app's own races, the auto-waiting argument stops
protecting it, and it is C1 with a smaller name. Behaviour belongs in the
2,289 assertions that already exist and do not need a browser.
