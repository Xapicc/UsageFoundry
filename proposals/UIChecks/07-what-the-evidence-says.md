# What the evidence says, with its grades

The register's recommendation asked this survey to say what each candidate
*buys* rather than to pick the fashionable one, and the operator's own vault has
already done the reading that stops several of the obvious answers being taken
on faith. Everything here is cited to a note in that vault with its own
confidence grade; nothing is asserted from memory.

## 1. There is no coverage figure for automated accessibility checking

`3 Resources/Web Design/Automated Accessibility Testing Coverage.md`
(`confidence: medium`) is unambiguous, and the spread is the finding rather than
a disagreement between tools:

| Figure | What is counted | Grade |
|---|---|---|
| **57.38%** of issues fully covered | issue *instances* in real audits (Deque, own audits) | vendor |
| **23–50%** coverage, **14–38%** completeness | WCAG criteria against expert audits (Vigo et al 2013) | peer-reviewed |
| best **40%**, worst **13%** (**50%** counting flagged-for-review) | 142 *seeded* barriers on one page, 13 tools (GDS 2017) | industry report |
| **13%** (7 of 55) reliably, 45% partial, 42% not at all | hand classification of WCAG 2.2 A+AA | blog |
| **38%** (21 of 55) criteria *touched* | computed from `axe-core`'s own rule tags | computable |

**They cannot be reconciled and do not need to be**: defect instances are
unevenly distributed across criteria, so weighting by volume flatters automation
and weighting by criterion flatters the auditor.

What transfers is the boundary all three methods draw in the same place:

> **Automation decides whether a mechanism is present. It never decides whether
> the content of that mechanism is adequate.** `alt` exists or it does not;
> whether it describes the image is not a DOM property.

**What this settles for this survey.** An accessibility engine is not the
justification for a browser harness — its yield is unmeasurable in advance and
its most automatable criterion, contrast, is one this project already decides
better with arithmetic and no DOM. If a harness is bought, it is bought for
layout, and an engine is a passenger on it.

## 2. The pyramid is a cost argument, not an empirical law

`3 Resources/Testing and Correctness/The Test Pyramid.md` (`confidence: low`):
the 70/20/10 split was offered as a first guess and has never been derived; over
seventy published variants of the diagram exist and none is a study.

What *is* peer-reviewed is the cost half, from Google's post-submit CI: **more
than 99% of all test runs pass or flake**, and after filtering flaky targets
only **1.23% of test targets ever caught a real breakage**. At that scale a
test's expected value is dominated by how often it fails spuriously.

**What this settles.** The correct question is not "what ratio should the suite
have" but "what does this instrument fail for, other than a defect". That
question has an answer for each option and it is in
[08-comparison.md](08-comparison.md).

## 3. Browser-test flakiness is measured, and the numbers are specific

`3 Resources/Testing and Correctness/Browser Tests and Waiting Discipline.md`
(`confidence: medium`):

- **44.7%** of UI test flakiness is the async-wait race — check-then-act between
  "ready" and "act". Playwright's auto-waiting removes that one *by
  construction*, which is a real and quantified argument for it over older
  harnesses.
- It cannot touch a race **inside the application**, and the same retry
  machinery will retry one into a green build. This app has a three-second poll,
  a sweeper, a live guard and an SSE stream.
- **31.1% of flaky UI tests are repaired by deleting the test.** A revealed
  preference, measured, and the number any browser suite here should be held to.

## 4. Visual diffing has no measured benefit

`3 Resources/Testing and Correctness/Visual Regression Testing.md`
(`confidence: low`): comparing a screenshot to a baseline "replaces a written
assertion with an oracle that nobody wrote", and **no published measurement
shows what it catches that an assertion-based test does not**.

## 5. Nobody has measured what any layer detects

`3 Resources/Questions/Does a Browser Test Detect Defects a Unit Test Cannot.md`
(`status: seed`) is the hole, and it is the most important thing on this page:

- The only quantified studies in the area — Leotta et al. 2013 and the same
  group's 2023 journal follow-up — measure **development and maintenance
  cost**, never defects found. Two papers, a decade apart, new instruments, and
  detection is still not on the panel.
- Attributing a defect to the layer that caught it needs a counterfactual
  ("would a unit test have caught this?"), which is a judgement rather than an
  observation. Mutation testing escapes it only by planting the faults the
  operator can plant — the same denominator problem that wrecks the
  accessibility figures.

**What this settles.** This survey cannot tell anybody what a browser suite
would find here, and neither can anybody else, and a survey that claimed
otherwise would be making it up. What it *can* do is the thing the literature
does not: reason from the defects **this repository has actually had**, which is
one, and it is a layout defect. That is a sample of one and is stated as one.

## What the operator's own prior work already removed from the table

`proposals/OperatorInterface/` took the most automatable criterion in the whole
standard — contrast — and settled **four measured failures** with arithmetic on
declared tokens, no DOM, no dependency, and a parse-and-assert floor to keep
them closed. It also refused `axe-core` in CI, *conditionally*, on the ground
that it would require exactly the harness this survey is about.

So the single highest-volume automatable class is already answered better than a
scanner would answer it, and the condition on that refusal is this survey's to
resolve.
