# Interface defects

[← Documentation index](README.md)

Every interface defect found, with its class. Why this list is kept and when to
add to it is in `docs/agent/conventions.md` (*When you fix an interface defect,
record its class*). The classes are the five in
`proposals/UIChecks/01-what-only-a-rendered-page-decides.md`:

- **A** — decidable from the source text (declared values in a relation, e.g.
  contrast).
- **B** — decidable from static markup (the element and classes a component
  emits for given props).
- **C** — a state machine: needs a DOM and events, not layout.
- **D** — layout: needs a real engine.
- **E** — needs a person.

Record the class of the *defect* — the cheapest instrument that could have
caught it — not of whatever happened to find it. A defect two instruments could
catch takes the cheaper letter; a genuinely arguable one says so on its line.
One short paragraph per defect: date, commit, class, what was wrong and where,
how it was found, the fix.

**Class C is covered by nothing here, deliberately.** A green `npm test` says
nothing about it.

## The list

- **2026-08-23, `434c235`, class D.** The Land card's strategy select took the
  whole row on a narrow window: Tailwind emits `.w-auto` ahead of `.w-full`, so
  the `w-auto` beside it lost silently. Found by a person at a narrow window;
  fixed by moving the width onto a wrapper (`src/components/RunLand.tsx:623-636`).
- **2026-09-09, `ea1c65c`, class E, arguably A.** `Meter` gave one reason for
  its hatched upper band ("once unpriced models are charged") at every call
  site; at three of seven — the install meter, "Spent across blocks" and the
  run page's "Spend" — the band is something else. Found by reading the
  component against its call sites; fixed by taking the sentence from the
  caller as `upperHint`. Checked by assertion on `aria-valuetext` only; no
  screen reader has been run over any meter.
- **2026-09-09, class D.** The live tool strip (`src/components/RunActivity.tsx`)
  squeezed the command to 63px at a 390px phone while `retrying, attempt 2 of 3`
  kept its 132px — a `truncate`d `flex-1` child yields to siblings that cannot
  shrink. Found by measuring the row against a scripted `CLAUDE_BIN`; fixed
  with `max-md:order-last max-md:basis-full` on the command. After: 43px rows at
  390px, 22px at 1280px, no sideways scroll at either.
- **2026-09-09, `3afd11a`, class B.** `Meter`'s head read `$12.40 - 18.9%` —
  money and a percentage presented as one range — when a caller overrode
  `value` and added a guard `upperFraction`; `aria-valuetext` spoke two
  percentages, neither on screen. Now asserted in `Meter.test.tsx`; a caller
  that overrides `value` without describing the band loses the band.
- **2026-09-10, `92e53b0` / `daf7956` / `938ee57`, then `640dbb2`, class D.**
  Four defects on the run surface at 390px, all invisible above the breakpoint:
  (i) the wide pickers on `src/app/runs/new/page.tsx` kept their 256px desktop
  width and clipped their own value; (ii) the enforcement `SegmentedControl`
  overflowed its card both ways, because `inline-flex` inside `ListRow`'s
  `shrink-0` side has no width to wrap against; (iii) the run list's task link
  (`src/app/runs/page.tsx:428`) was a 20px target; (iv) below `lg` an `auto`
  grid track would not shrink under ~362px of content in a 316px card. Found by
  measuring every box at 390px and 768px against the standalone bundle; fixed
  at the call sites, (iv) with `minmax(0,1fr)`. After: nothing past the
  viewport, no control under 44px below the breakpoint. (ii)'s real cause is
  `ListRow`'s control side, still plain `shrink-0` at
  `src/components/ui/List.tsx:164` on 2026-09-11, so the trap stays set on
  every other `ListRow`.
- **2026-09-10, class B, with a data half that is no class at all.** The
  context composition stack drew standing configuration, prefix and
  conversation at zero height from the fifth reading on (run `5b967a08`).
  Found by a person looking; decidable from static markup and now asserted in
  `ContextOccupancy.test.tsx`. The cause was the parse flooring winnow's
  residual at zero, which is tested in `contextPruning.test.ts`.
- **2026-09-11, `87259bf` then `1cd7966`, class D.** The branches table's State
  column (`src/app/branches/page.tsx`, `UncommittedNote` in
  `src/components/BranchWork.tsx`) always wrapped the note to two lines: its
  `min-w-[140px]` left 120px of content, and the `w-full` Branch column absorbs
  any slack at every width. Found via a VisualEdit handoff. The first fix,
  `text-balance`, only moved the break and was reported back as broken; the
  second raised the floor to 240px, measured on one line from 780px to 2128px.
- **2026-09-11, class D.** Under the ascii skin every badge carrying a `Mark` on
  `/branches` (61 of 61) broke over three lines: the skin makes `.uf-badge`
  `inline`, and Tailwind's preflight makes `svg` `display: block`. Reported by
  the operator with a screenshot; fixed with `.uf-badge > svg { display: inline;
  margin-inline-end: 1ch }` in `src/app/globals.css`. After: 0 of 61 over one
  line. D rather than B because the markup is identical in both skins.
- **2026-09-12, class D.** The toolbar's right-hand group overflowed a 390px
  window on `/`: `New run` sat at 378→446.2px in the default skin and
  398→491.5px under ascii, clipped away by `AppShell`'s `overflow-hidden` with
  no scrollbar, while the route title shrank to 0px and drew nothing. Both
  skins, both themes; measured 2026-09-11, fixed 2026-09-12. The cause is
  width, not the mono face — five 44px appearance segments and their gaps are
  254px of a 366px strip. Found by measuring every control's bounding box
  against the viewport in Chromium; `npm run smoke-pages` is blind to it,
  because it compares the *document's* `scrollWidth` against `clientWidth` and
  the shell clips rather than scrolls (filed separately as `adb32ab1`). Fixed
  by moving both appearance pickers behind one 44px disclosure below the
  breakpoint (`src/components/shell/Toolbar.tsx`); above it the panel is
  `display: contents` and nothing moved. After: every control inside 390px on
  all five routes measured, in both skins and both themes, panel open and
  closed, and the title draws again — in full everywhere except `/` under
  ascii, where it has 52.7px against a natural 59 and truncates visibly.
