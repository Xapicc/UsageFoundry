# Option B: jsdom and `@testing-library`

The industry default for "test your components", and the option whose coverage
is easiest to overstate — which is the reason it gets its own file rather than
a line in a table.

## What it is

`jsdom` plus `@testing-library/react` plus `@testing-library/user-event`, run
under `node --test` with an environment flag, or under a runner that sets one.
Three dependencies and a test environment; no browser download, no server, no
CI service.

It renders into a DOM, runs effects, dispatches events, and lets a test drive a
component the way a person would: type into the field, press the button, assert
what is on screen afterwards.

## What it buys

Class C in [01](01-what-only-a-rendered-page-decides.md), and there is genuinely
material for it in this app:

- **The settings page's dirty guard.** `beforeunload` is registered only while
  `dirty`, and the whole value of the control is that it fires when it should
  and not otherwise.
- **The chat page's search-versus-poll split.** The results are held apart from
  the polled list *specifically* so a poll cannot wipe a result set mid-read.
  That is a state machine, its failure is a list that empties under the reader,
  and nothing throws.
- **The queue-priority input's `draft === null` rule.** The same shape: a poll
  arriving while the operator is half-way through typing must not overwrite the
  draft, and the failure is a number that jumps back.
- **The land card's `canDeliver`**, which is four conditions and a null check
  over a polled DTO, and whose failure is a button offered when it should not
  be.

Each of those is a real invariant, each fails silently, and each is decidable
without a single pixel.

## What it cannot buy, and why this is the trap

**jsdom implements no layout.** There is no box model, `getBoundingClientRect`
returns zeros, and `getComputedStyle` gives declared values rather than
cascaded-and-resolved ones. It does not run Tailwind's emitted stylesheet at
all unless something loads it, and even loaded, nothing resolves a cascade
order into a used value.

So every one of these is invisible to it, and all of them are things this app
actually reasons about:

- the `w-auto`/`w-full` ordering defect that shipped;
- all 222 viewport-conditional classes, because there is no viewport;
- `light-dark()` inside `color-mix()`, which a non-rendering engine returns
  `incomplete` for — the exact point
  `proposals/OperatorInterface/` makes when it settles contrast with arithmetic
  instead;
- whether a canvas sized itself, whether a sticky footer clears a keyboard,
  whether a 390px pane scrolls sideways.

**The failure mode is not "it misses things". It is that the suite looks like
it covers the interface.** A green `@testing-library` run over the settings page
reads, to anybody who has not read this file, as *the settings page is checked*
— and the one class of defect that page has actually had is structurally
outside it.

## The condition that would make it right

If the answer to *"what has gone wrong on this interface?"* were mostly state
machines, this would be the best option on the list by a distance: it is far
cheaper than a browser, it does not flake, and it runs in CI today. The
evidence here is that the one recorded defect was layout — a sample of one,
which is worth saying plainly rather than dressing up.

## Cost

Three dependencies, a test-environment split in `tsconfig.test.json` or a
runner change, and per-test authoring cost roughly that of a service test.
Recurring cost is low: no browser to download, no server to start, and the
flakiness literature's 44.7%-of-cases async-wait race is largely absent because
there is no real network and no real clock.
