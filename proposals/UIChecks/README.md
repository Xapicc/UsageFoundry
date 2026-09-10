# What should check the interface, and what would it actually catch?

**The question:** 40,572 lines of page and component code are rendered by
**zero** tests. What should check them, and — the half that is easy to skip —
what would each candidate actually catch?

**The state:** open. Nothing here is a decision and no product code changed.
Five options, two recommended, three refused by name, one falsifier that is the
first run of the thing recommended.

This is *Survey 3* in
[`../GapRegister/06-recommendation.md`](../GapRegister/06-recommendation.md#survey-3-what-should-check-the-ui-and-what-would-it-actually-catch),
which ranks its row **first overall** and asks for a survey rather than a patch
— explicitly because "add Playwright" is the answer to be suspicious of.

## The recommendation

**A written pass, then a smoke pass, then more render tests — in that order.**
[09-recommendation.md](09-recommendation.md).

Start the built app against a throwaway `DATA_DIR`, open all 19 pages at two
widths, and assert three things each: 200, no console error, no horizontal body
scroll. One file. That is the narrowest instrument that reaches the class of
defect this project has actually had, and it is aimed at a **floor** rather than
at coverage: nothing anywhere currently establishes that any page renders at
all.

**What would overturn it:** how many of the 19 fail that pass the first time it
runs. This survey could not get that number, and it is the first run of the
recommendation.

**Refused by name:** a jsdom + `@testing-library` suite (reaches state machines
alone while reading as though it covered the page), a full Playwright suite
(the whole measured maintenance tax for a benefit nobody has measured), and
visual diffing (every page here renders live data).

## The measurements

| | |
|---|---|
| Lines of `src/app/**/page.tsx` | **20,765** across 19 pages |
| Lines of `src/components/**/*.tsx` | **19,807** across 63 files |
| Tests | **2,289** in 356 suites |
| Test files that render anything | **11**, 124 `renderToStaticMarkup` calls |
| **Page components rendered by a test** | **0** |
| jsdom / `@testing-library` / Playwright / Puppeteer | **none in `package.json`** |
| Viewport-conditional classes | **222 occurrences, 93 distinct, 39 files** |
| Entries on `docs/verification.md`'s *not yet verified* list | **33** |
| Interface defects this repository has recorded | **1**, and it is a layout defect |
| Browsers opened by this survey | **0** |

Page code has grown **26%** since the register's row was written; page
components rendered by a test have been **0** throughout. That is the row's own
argument arriving as a measurement.

## Read in this order

| File | What it settles |
|---|---|
| [00-what-is-there-now.md](00-what-is-there-now.md) | The measurements above, the commands behind them, and the one defect of this class that has already shipped |
| [01-what-only-a-rendered-page-decides.md](01-what-only-a-rendered-page-decides.md) | The partition that does most of the sorting: five classes of claim, and the cheapest instrument that decides each |
| [02-option-a-extend-the-render-tests.md](02-option-a-extend-the-render-tests.md) | **Recommended.** More `renderToStaticMarkup`, and the exact ceiling it cannot pass |
| [03-option-b-jsdom.md](03-option-b-jsdom.md) | **Refused**, and the closest call here |
| [04-option-c-playwright.md](04-option-c-playwright.md) | The suite (**refused**) and the smoke pass (**recommended**), which are different options |
| [05-option-d-visual-diffing.md](05-option-d-visual-diffing.md) | **Refused** |
| [06-option-e-a-written-checklist.md](06-option-e-a-written-checklist.md) | **Recommended.** The four items worth writing down |
| [07-what-the-evidence-says.md](07-what-the-evidence-says.md) | Five vault notes with their grades — and what none of them can tell anybody |
| [08-comparison.md](08-comparison.md) | What each buys, and what each fails for *other than a defect* |
| [09-recommendation.md](09-recommendation.md) | The order, the falsifier, and the three things this survey is least sure of |

[10-the-graph-at-390px.md](10-the-graph-at-390px.md) is not part of the
survey and does not answer its question. It is filed here because it is the
one decision this repository has taken that the survey's instruments cannot
check and a person would have to: a measured finding that the workflow canvas
cannot be made useful at 390px, and the linear fallback that replaced it
there.

## What it deliberately does not re-open

**`proposals/OperatorInterface/`.** Contrast is settled there — four measured
failures closed with arithmetic on declared tokens, no DOM, no dependency — and
that is a *better* instrument for the criterion than any scanner, since
`light-dark()` inside `color-mix()` is exactly what a non-rendering engine
returns `incomplete` for. Its conditional refusal of `axe-core` in CI named this
survey's question as the larger problem; [09](09-recommendation.md) resolves the
condition and leaves the refusal standing on its second ground.

## The uncomfortable finding

**Nobody has ever measured what a browser test detects that a unit test does
not.** Two papers by the same research group, a decade apart, price browser
testing on development and maintenance cost and never on defects found; no study
anywhere reports defects-detected-per-layer for any suite. So no honest survey
can tell you what a harness would find here — and one that quotes a coverage
percentage at you is quoting a figure whose denominator it has not named.

What is left is to reason from what this repository has actually got wrong. That
is one defect, it is a layout defect, and everything recommended here follows
from it being a sample of one.
