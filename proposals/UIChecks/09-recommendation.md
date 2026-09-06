# Recommendation

**Option A now, Option C2 as the thing that closes the row, Option E written
down either way. B, C1 and D refused by name.**

## The recommendation in order

1. **A written pass in `docs/verification.md`** — four items, bound to what this
   app has got wrong, from [06](06-option-e-a-written-checklist.md). It costs
   an editor's afternoon, contradicts nothing, and is the only thing here that
   reaches the judgements no engine makes. Do it first because it is the only
   one that needs no decision from anybody.
2. **Option C2, the smoke pass** — start the built app against a seeded
   throwaway `DATA_DIR` and a `CLAUDE_BIN` that cannot spawn, open all 19 pages
   at 390px and at a desktop width, and assert three things per page: the
   response is 200, the console produced no error, and the body does not scroll
   sideways. One file. This is what closes F5.
3. **Option A, continuously** — more `renderToStaticMarkup` files for the kit
   and the presentational components, at the rate they are convenient. It needs
   no plan and should never be a project.

## What would overturn it

**One number, and this survey could not get it: how many of the 19 pages fail
the smoke pass the first time it runs.** If the answer is zero, the floor was
already there and C2 is insurance rather than a repair — still worth its cost,
but the register's rank-1 position would be arguing from the trend rather than
from a fault. If it is more than one, the recommendation is understated and the
argument for going further into class D gets stronger immediately.

That is a cheap falsifier: it is the first run of the thing being recommended.

**The second thing that would overturn it** is a change in what the interface
gets wrong. The whole case for reaching class D at all rests on **one recorded
defect** — the `w-auto`/`w-full` ordering in `RunLand.tsx`. If the next three
interface defects are state machines rather than layout, Option B becomes the
right answer and this recommendation was aimed at the wrong class. So: **record
the class of every interface defect found from here on.** It costs a line and
it is the measurement the entire published literature is missing.

## What this must not be read as

**Not "the interface is now checked".** With all three adopted, the classes are:
B by assertion, D at a floor, E by a person, **C not at all**. That is a
deliberate hole and it is written here so a green pipeline cannot be read as
covering it.

**Not a re-opening of `proposals/OperatorInterface/`.** Contrast is settled
there, better than a scanner settles it, and nothing here proposes an
accessibility engine. That survey's refusal of `axe-core` in CI was conditional
on there being no harness; C2 would create one, and the refusal **still
stands** on the second ground it gave — the yield is unmeasurable in advance and
the criterion it is best at is already decided by arithmetic. If an engine is
ever added, it is a passenger on a harness bought for layout, and it must be
argued then.

**Not a change to what CI is, yet.** C2 needs `README.md:985` — CI "never
starts the container and never exercises a run" — rewritten deliberately, and
that sentence is a position rather than an accident. The smaller version, which
is what is recommended: **run C2 by hand, from a `package.json` script, and put
its result in `docs/verification.md`** until somebody decides the CI question on
its own merits. That keeps the floor and defers the argument.

## Refused by name

- **Option B, jsdom + `@testing-library`** — reaches class C alone while
  reading, from inside a test file, as though it covered the page. The closest
  call here; it becomes right the moment the recorded defects are state
  machines.
- **Option C1, a Playwright suite** — buys the whole measured maintenance tax
  (44.7% async-wait flakiness, 31.1% of flaky tests repaired by deletion) for a
  benefit no published study has ever measured, on a one-operator install.
- **Option D, visual diffing** — every page renders live data, so the baseline
  fails for reasons that are not defects; and no measurement exists of what it
  catches that an assertion does not.

## What this survey is least sure of

Three things, stated once.

**The case for class D is one defect.** `RunLand.tsx`'s comment is a good
account of a real failure and it is a sample of size one. Everything in
[08](08-comparison.md) that prefers C2 over B rests on it.

**No browser was opened and no harness was built.** Every claim about what
jsdom cannot do is read from its documented behaviour rather than observed
here, and the smoke pass has never been run — so "how many pages fail it" is
the falsifier at the top of this file precisely because nobody has looked.

**The evidence base is mostly about what cannot be concluded.** Five vault
notes, two at `confidence: low`, and the strongest thing in them is a seeded
question recording that the measurement everybody argues from does not exist.
That is the honest state of the field and it is why this recommendation is a
floor rather than a strategy.
