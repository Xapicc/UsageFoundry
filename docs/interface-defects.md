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
- **2026-09-12, `dd66cfb`, class A.** `/settings`' section strip drew a third
  chip treatment of its own — a `--tint` fill with `text-tint-fg` on the current
  chip, `text-ink-muted` on `bg-bezel` on the other nine — and two of its three
  tone pairs were below 4.5:1 as rendered: `--fg-muted` on `--bezel` at 3.54:1
  in dark, which is the app's own tokens and fails unconditionally, and
  `--tint-fg` on `--tint` at 4.21:1 in every theme, which is **not** — that pair
  resolved to `AccentColorText`/`AccentColor` through the `@supports` block at
  globals.css:330, and Chromium's default accent is `#0075ff`. On the declared
  fallback the same pair is 5.22:1 light and 5.06:1 dark, so the current chip
  failed only where the browser hands the app an accent that does. That is not
  this strip's to fix and is filed separately; the strip stops depending on the
  pair either way. Found by two reviewers under
  the ascii skin, where the mono face made the dark one obvious; sampled from
  rendered pixels, both skins measured the same figure to two decimals, so the
  skin was not the cause — nothing under `:root[data-skin="ascii"]` reaches
  these anchors' colours, only their corners. Fixed by drawing the strip in
  `SegmentedControl`'s exported `SEGMENT` and adding `uf-segment`, which is also
  what gets it bracketed under the skin; it stays a `<nav>` of anchors rather
  than becoming a radiogroup. Before: 44 of 80 readings below 4.5:1 (10 chips ×
  390/1280 × light/dark × ascii/default). After: 0 of 80, worst 4.87:1. A rather
  than B because both pairs are declared values in a relation the source states.
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
- **2026-09-12, class D.** The board's dependency line named two neighbours a
  side, which in the Task cell (`src/app/tasks/page.tsx`, `DepLine`) rendered as
  six wrapped lines under a two-line title: that cell is whatever six `min-w`
  columns leave, about 150px at 1280px, and a task title is already two lines in
  it. Found by screenshotting a seeded board at 1280px — the shape reads fine in
  the source, where the line is one `<span>`. Cut to one named neighbour a side,
  in `depNames`, at both widths rather than more when stacked, so the fallback to
  a count means the same thing on a phone and on a laptop. D rather than B
  because nothing about the markup is wrong; the cell is just that narrow.
- **2026-09-12, class D.** Under the ascii skin a meter with no ceiling drew
  longer than every meter beside it: `AsciiBar` mixed U+2588/2591/2592 with
  U+2573 and took one advance for all four, and the reader's face answers a
  fallback **per glyph** — on the stack that resolves to `Liberation Mono` here,
  `█ ▒ ░` draw 7.80px at 13px and U+2573 draws 13.00px, which is a twenty-cell
  `╳` bar at 275.63px against 171.67px. `useFittedCells` doubled it: `cellPx` was
  the drawn run divided by its cells, an average over whatever composition was on
  screen, so the `╳` bar also fitted a different *count* from its neighbours.
  Reported by the operator, who also described the band and track drawing wider
  than the fill inside one bar — that half was not reproduced, because no face
  installed here answers the three block glyphs at three widths. Fixed by boxing
  each run to `cells × cellPx` with `overflow-x: clip` and measuring `cellPx`
  off a transient `█` probe inside the bar, so the column is the block's own
  advance and no glyph decides a width; `docs/verification.md` carries the
  readings. D and not B because the markup was already correct — the same
  character counts, from the ranges the file's own test pins — and only a real
  engine with a real font stack says what they draw.
- **2026-09-13, `a5694e4`, class C.** `PathMapCanvas` framed its map on the one
  frame the layout went cold, four seconds after it had visibly stopped moving —
  the shape `KnowledgeGraphCanvas` was fixed out of in `2425ab8` and left on its
  sibling. Measured on `/runs/[id]/touched` with five files: k=1.000 from load to
  t=4.0s, then 1.771 at t=4.6s in a single frame. Found by porting the sibling's
  fix and sampling `k` off the 2D context down the cooling curve, in Chromium;
  fixed by fitting on every frame of the cooling and setting `fittedRef` on the
  cold one rather than gating on it. C rather than D because nothing about it is
  layout: a DOM with a driveable clock and `requestAnimationFrame` would see the
  call land only on the last frame. Fitting during the cooling then exposed a
  second half: `onPointerDown` was not setting `fittedRef` when a node was
  grabbed, the way `KnowledgeGraphCanvas` does, so the drag's `reheat` left the
  camera framing a layout the hand was moving — k 2.227 to 1.964 on a node
  dragged 270px, and a frozen 1.872 with the guard.
- **2026-09-13, `a5694e4`, class C.** Neither graph canvas re-framed when its own
  box changed under it, so a view framed against the old box was left off-centre
  and, where height bound the fit, overhanging. On `/knowledge` the skin control
  is enough to do it — it changes the font family the panel beside the graph card
  is laid out from, taking the card 662x974 to 662x1008 — and the flipped view
  then held k=4.898 where a load in that skin frames at 5.085. `PathMapCanvas`
  had it against a window resize: 1280 to 900 wide left a 543x513 graph in a
  594x480 box. Found by comparing a flipped view against a *reload in the same
  state* rather than against the pre-flip view, which is what the 2026-09-12
  measurement compared and why it read clean. Fixed by refitting from the size
  observer, gated on `touchedRef` so a deliberate pan survives. C and not D: the
  box change needs an engine to *happen*, but the defect is that a
  `ResizeObserver` callback resizes the backing store and does not refit, which a
  DOM with a stub observer would catch.
- **2026-09-27, `133effc`, class B, arguably D.** The run inspector drew no
  ascii frame at any width that has the split. The card was both `uf-framed`
  and its own `overflow-y-auto` scroll container, and a scroll container clips
  at its padding box while `AsciiFrame` lays its stroke on the border just
  outside it: at 1920x963 the frame box ran 1559.5 to 1906.5 around a padding
  box of 1567 to 1899, and not one of the four edges survived. B because the
  two classes on one element in the emitted markup are the whole of it. Found
  in Chromium during the polish pass a VisualEdit review of that card asked
  for; fixed by keeping the cap on
  the card and scrolling an inner box stretched over its padding
  (`INSPECTOR_SCROLL` in `src/app/runs/[id]/page.tsx`).
- **2026-09-27, `79a37db`, class B.** Every inspector region whose first block
  is a `Section` opened on two hairlines with its heading between them.
  `Section`'s `first:mt-0 first:border-t-0 first:pt-0` is what drops the rule
  over a region's leading block, but `Region` rendered its own `<h2>` as the
  first child, so no block was ever `:first-child`. Visible in the static
  markup. Found in Chromium at 1920 in both skins; fixed by giving `Region`'s
  blocks a box of their own.
- **2026-09-27, `d4ad741`, class A.** The inspector's state headline stood 12px
  off its detail line while every other line of the header block stood 4px off
  the next: the headline set no bottom margin, so the legacy layer's
  `h2 { margin: 0 0 12px }` beat the detail's `mt-1`. Two declared values in the
  source. Found by measuring child offsets in Chromium; fixed by stating `mb-1`,
  as `/settings` does for its lede.
- **2026-09-27, `77b4d21`, class D.** A 42-character Bedrock model id drew 4px
  past the inspector's content edge under the ascii skin and printed over its
  own label, squeezed to one word a line. `ListRow` keeps its control side
  `shrink-0` above the breakpoint, and the id's length is not this app's. Found
  with a seeded long id in Chromium; fixed by letting the inspector's
  `GuardValue` break anywhere, right-aligned, under a `max-w-48` that
  `da450be` narrowed to `lg:` after the first cut wrapped a 390px line at
  192px with nothing else on it.
- **2026-09-27, `b02b7f0`, class A, arguably B.** Under the ascii skin the run
  inspector lost its state tone. `uf-unboxed`'s unlayered
  `border-color: transparent` outranks any layered `border-l-*` utility, so the
  3px edge went with the box and a working run and a refused one wore the same
  card. The cascade decides it from the source alone. Found in Chromium; fixed
  with a `uf-state-edge` hook that reverts the left colour to the layers, as
  `.uf-notice` keeps its bar, and a clip that takes the frame's own left column
  off that host, since its 1px inset put the stroke inside the 3px band.
- **2026-09-27, `abff136`, class A.** Under the ascii skin the run inspector was
  not sticky at all. `.uf-framed`'s unlayered `position: relative` outranked
  the card's layered `lg:sticky`, so on a long tab the card scrolled away with
  the page, and its `lg:top-4` became a 16px relative nudge that hung it past
  the foot of its own row. The cascade decides it from the source alone. Found
  by reading the card's computed `position` in Chromium while measuring its cap;
  fixed by moving that one declaration into `@layer components`, so a host
  that states a position keeps it. No other framed host states one.
- **2026-09-27, `3a50d6a`, class D.** The run inspector's cap was the pane less
  2rem, measured from the pane's top, while the card loads a heading further
  down: at 1920x963 and 1280x800 its last 77px sat below the window, it
  stretched the log with it so the log tab scrolled 125px for nothing else,
  and leaving out the pane's `pb-12` put its top 16px under the toolbar at the
  foot of every scroll. Found with `getBoundingClientRect()` read after load
  without scrolling; fixed by publishing the split's measured top as
  `--split-top` and capping at the pane less that less `3rem`.
- **2026-09-27, `dc0d21a`, class A.** `/runs/new`'s Save and Update sent a
  spending or time limit switched on with its box blank, which Start refuses,
  and the template door stored it as no limit: `saveTemplate` never read
  `runFormProblems`. Found by reading the source; fixed by refusing `""` in
  `normalizeTemplateInput` and running `limitProblems` at Save, so Start's
  sentence lands beside the box.
- **2026-09-27, `ea04225`, class A.** `/runs/new` warned under both window
  guards that the run would be refused whenever no ceiling was set, which on a
  stock install is always, while the door reads Anthropic's own percentage and
  admits it. The form asked a different question from `readWindowGuard`.
  Found by reading the source; fixed with `windowGuardUnreadable`, which asks
  the snapshot's `fraction` as the door does.
- **2026-09-27, `0b85aac`, class C.** `/runs/new`'s workspace select held a
  value with no option — a copied run or template naming a gone mount, or a
  copy whose seed fetch failed — so React showed the first mount while state
  kept `""`, and on a one-mount install choosing it fired no change and Start
  could not be satisfied. Found by reading the source and React's
  `updateOptions`; fixed with a disabled "Choose a workspace" option carrying
  the current value, and checked in Chromium for all three seeds.
- **2026-09-29, `811136f`, class A.** The workflow instance page said
  "started 1 run(s)" under an orchestrator block none of whose decided specs
  could be created: `blockSummary` read `emitted`, which for that kind counts
  the accepted specs, not the runs. Found by reading the source; fixed by
  carrying `started`, the instance's member rows whose `emitted_by` is the
  block, and saying "decided on N run(s), none could be started" when fewer
  started than were decided on.
- **2026-10-01, `c6ddfdd`, class D.** A full `/runs/live` tile stopped
  following its tail when the pointer rested on its log. Each event trims a row
  off the top, scroll anchoring moved the reader up by that height, and the
  hover's hit test laid the log out before the passive follow effect ran, so a
  scroll event reached `onScroll` one batch short of the bottom and `pinned`
  went false on the page's own update. Found by the operator; reproduced in
  Chromium with a fake stream; fixed by following in a layout effect. Turning
  anchoring off was measured and refused: it carried a reader who had scrolled
  up back to the tail within three events.
