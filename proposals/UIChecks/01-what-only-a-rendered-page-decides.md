# The criterion: what can only a rendered page decide?

[06-recommendation.md](../GapRegister/06-recommendation.md#survey-3-what-should-check-the-ui-and-what-would-it-actually-catch)
sets this survey one instruction and it is the one that does the sorting:

> Whatever this survey chooses, it should be chosen for what only a rendered
> page can decide.

That is not a slogan. It is a partition, and once the app's own claims are put
through it most of the argument settles itself. There are five classes and each
has a different cheapest sufficient instrument.

## The five classes

### A — decidable from the source text, no DOM at all

Colour contrast is the case, and it is settled: `proposals/OperatorInterface/`
computed four failures from the declared tokens with arithmetic, no dependency
and no browser, and its Option D is a parse-and-assert floor over
`globals.css`. Anything of the form *"these declared values stand in this
relation"* belongs here.

**A rendered engine is actively worse for this class.** `light-dark()` inside
`color-mix()` is exactly what a non-rendering engine returns `incomplete` for,
and a real browser gives you one theme at a time on one machine's colour
profile, where the arithmetic gives you all 98 pairings in both schemes.

### B — decidable from static markup

What element and what classes a component emits for given props. The eleven
existing `renderToStaticMarkup` files are this class and it is the cheapest
real check in the repository: no dependency, runs in `node --test`, no clock,
no flake surface. `Markdown`'s 63 renders are the shape — it is a parser, its
output is markup, and the assertions are about the output.

Its ceiling is exact: **it renders one pass with no state, no events, and no
CSS**. `useState` gives the initial value, `useEffect` never runs, a `disabled`
that depends on a fetch is always the pre-fetch value, and a class string is a
string rather than a computed style.

### C — needs a DOM and events, but not layout

A click toggles a disclosure, a form submits, focus lands where it should, a
`beforeunload` handler is registered, an input's draft survives a poll. jsdom
plus `@testing-library` is the instrument, and there is real material here: the
settings page's dirty guard, the chat page's search-versus-poll split, the
queue-priority input's `draft === null` rule — all three are state machines
whose failure is a wrong value on screen rather than an exception.

### D — needs layout, or CSS resolution, or a real engine

Only a browser. The `w-auto`/`w-full` defect in
[00-what-is-there-now.md](00-what-is-there-now.md); every one of the 222
viewport-conditional classes; whether a `sticky` footer clears a software
keyboard; whether a `<canvas>` sized itself; whether a 390px pane scrolls
sideways. **jsdom does not do layout at all** — it has no box model, every
`getBoundingClientRect` is zeros, and `getComputedStyle` returns declared
values rather than cascaded-and-resolved ones. A test written in jsdom about
any of these would pass while the page was broken, which is worse than no test.

### E — needs a person

Whether the copy is right. Whether the reading order makes sense. Whether the
focus ring at 75% alpha reads as loud to the operator who looks at it all day —
`proposals/OperatorInterface/` names exactly that as the one reading that would
overturn its recommendation, and it is a judgement rather than a measurement.

This is not a residual to be minimised. The strongest transferable finding in
the evidence ([07-what-the-evidence-says.md](07-what-the-evidence-says.md)) is
about precisely this boundary: **automation decides whether a mechanism is
present and never whether its content is adequate.**

## What that partition does to the five options

| Class | Cheapest sufficient instrument | Already have it? |
|---|---|---|
| A | arithmetic over the source | yes, and it is recommended elsewhere |
| B | `renderToStaticMarkup` in `node --test` | **yes** — 11 files, 124 renders |
| C | jsdom + `@testing-library` | no |
| D | a real browser | no |
| E | a person and a written list | partly — `docs/verification.md` |

Two things follow immediately and neither is a matter of taste.

**Option A (extend the existing render tests) cannot reach class D**, so
proposing it as the answer to "nothing that renders is checked" answers a
different question from the one the register asked. It is still the cheapest
thing on the list and it still buys something real; it just does not buy the
class the defect that actually shipped belongs to.

**Option B (jsdom) is the one whose coverage is easiest to overstate.** It
reaches class C and nothing in class D, and the two are hard to tell apart from
inside a test file — which is the specific way this option goes wrong: a suite
that looks like it checks the interface and structurally cannot see the failure
mode the interface has already had.
