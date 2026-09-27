# Verification: Interface — the toolbar, drawer, sheets and shared layer

[← Verification index](../verification.md)

## Verified

- **The shared layer at 390×844, 2026-09-10**: `Sheet`, `Card`, `Meter`,
  `RunAgentCost` in Chromium, mostly the standalone bundle: no sideways scroll
  on five pages, nothing in the kit under 44px, `ContextOccupancy` at 1280
  byte-identical before and after.

- **The quick-open sheet at 390px, 2026-09-10**, standalone bundle: it spans
  the window, nothing scrolls sideways, footer buttons are 44px, focus lands in
  the field, Esc and Cancel close it (a tap below does not, by design: `Sheet`
  has no backdrop dismiss). Not on a real phone.

- **Every toolbar control was measured against a 390px viewport, 2026-09-12**
  (`npm run build` then the standalone bundle, seeded `DATA_DIR`, a `CLAUDE_BIN`
  that cannot spawn, Chromium 151 via the globally installed Playwright 1.62.1):
  each control's bounding box compared against the viewport on `/`, `/chat`,
  `/runs`, `/knowledge` and `/settings`, in both skins and both themes, with the
  appearance panel open and closed. Before: `New run` at 378→446.2px (default)
  and 398→491.5px (ascii), the route title 0px wide. After: nothing past 378px
  anywhere, and the title draws in full except on `/` under ascii, where it has
  52.7px against a natural 59. Also measured unchanged at 768px and 1280px. Not
  a real phone, no touch, no zoom and no screen reader; dismissal was driven
  with synthetic Esc and mouse events, not a finger.

- **The toolbar's appearance panel is framed below the breakpoint and carries no
  frame above it, 2026-09-13** (same rig as the entry above: Chromium
  151.0.7922.34 via Playwright 1.62.1, `.next/standalone/server.js`, `/`, DPR 2,
  skin and theme in `localStorage` before first paint). `AsciiFrame` gained a
  `widths` prop whose `narrow` value emits `uf-ascii-frame-narrow`, which
  `globals.css` takes to `display: none` inside `@media (width >= 48rem)`. At
  390 in ascii the opened panel's CSS border is `rgba(0, 0, 0, 0)` in both
  themes — it was `rgb(227, 227, 230)` light and `rgb(58, 58, 61)` dark — and the
  character frame inks on the panel's own border box edges: left `│` centre css
  217.97 light and 218.00 dark against an edge at 218.00, right 378.00 and
  377.98 against 378.00, which is the reading a `Card` on the same page gives
  (374.00 against 374.00). The frame's own rect is x 211.5 w 173 against a panel
  box of x 218 w 160, so `.uf-unboxed > .uf-ascii-frame` is backing the panel's
  1px out as well. Under `default` the frame is in the DOM at `display: none`,
  and the panel keeps its CSS border.

  The failure this exists to avoid was checked in the state that reaches it
  rather than in a fresh one: with the panel open at 390, `setViewportSize` to
  1280 without a reload — a phone turned to landscape. The header holds one
  `.uf-ascii-frame`, `display: none`, 0x0, and the window's top and right edges
  have no ink on them in either theme (`rotated-light-ascii.png`,
  `rotated-dark-ascii.png`). Caveats: the panel takes `uf-unboxed` *without*
  `uf-framed`, which is the only place in the app the pair comes apart —
  `uf-framed` is unlayered `position: relative` and would outrank the panel's
  own `max-md:absolute`, dropping it into the strip under the ascii skin only;
  the panel is already positioned wherever it has a box, which is what that
  class would have been for. And this is one Chromium: a `display: contents`
  element generating no containing block is specified behaviour, but only this
  engine was measured.

- **The toolbar's drawer button holds its natural width, and the strip overflows
  visibly instead, 2026-09-13** (same rig: Chromium 151.0.7922.34 via Playwright
  1.62.1, `.next/standalone/server.js`, DPR 2, skin in `localStorage` before
  first paint; `/`, `/runs` and `/workflows` at 320, 390 and 1280). The button
  gained `shrink-0`. At 390 in ascii on `/` — the only route carrying a New run,
  so the tightest on the strip — it goes from 59.83px to 64.00px, and 64.00 is
  what the same button measures on `/runs` and `/workflows` at the same width,
  where the row has slack. At 320 on `/` it goes from 44.00px, which is its
  `max-md:min-w-11` hit-target floor, to 64.00px, and the header's `scrollWidth`
  goes from 320 to 330 against a `clientWidth` of 320: the overflow is now
  visible rather than absorbed. In the `default` skin the button reads 44.00px
  at every width before and after, because 44 is both its natural width and its
  floor there — which is why this was invisible.

  Two things this cost, both recorded beside the code. The route title is now
  the only item that gives way and takes the whole deficit: 52.67px to 48.50px
  at 390 in ascii on `/`, `Dashbo…` to `Dashb…` against a natural 58.5. And the
  59.8px figure written into `Toolbar.tsx`'s own arithmetic was never the
  button's width — it was read off the over-budget strip — so the sum there is
  523.5px rather than 519.3px. Caveats: 320 is below the 390 the interface
  claims, and is measured here only because it is where the over-budget case is
  reachable; `npm run smoke-pages` sees none of this, since the strip does not
  scroll the document at either width it opens.

- **The toolbar's route title is gone below the breakpoint, and every page has
  the <h1> that makes that safe, 2026-09-13** (same rig: Chromium
  151.0.7922.34 via Playwright 1.62.1, `.next/standalone/server.js`, DPR 2, skin
  in `localStorage` before first paint; 320, 390 and 1280, both themes, both
  skins). The title div took `max-md:hidden`. The check the decision rests on
  was run rather than assumed: all 23 pages `scripts/smoke-pages.mjs` opens
  render an `<h1>`, and on seven of them it is the more specific of the two —
  `/` is "Claude Code usage" against a toolbar title of "Dashboard",
  `/runs/[id]/conflicts` is "Where the conflicts are" against "Run",
  `/tasks/new` is "New task" against "Taskboard". The div carries no role, no id
  and nothing points at it, which is why `max-md:hidden` rather than
  `max-md:sr-only`.

  At 390 in ascii on `/` — the tightest route, the only one with a New run — the
  row went from filling its 390px exactly, with this drawing "Dashb…" at 48.5px
  of a natural 58.5, to 333.5px with nothing on it squeezed. At 1280 the title
  is untouched in both skins: 58.50px ascii, 61.53px default, `flex-shrink: 1`.
  Caveats: the premise the task was filed on had already moved — with both
  appearance pickers still on the row this drew one character, and moving them
  into the disclosure had taken it back to a six-character truncation, so what
  was decided here is the duplication and the headroom rather than the original
  symptom. And 320 is measured only because it is where the over-budget case is
  reachable; the interface claims 390.

## Not yet verified by hand

- **The shared layer's 390px pass (2026-09-10) was never on a real phone or
  with a keyboard up**; the long-label `Meter` case was a fixture only.

- **No other sheet has been seen at 390px, and none on a real phone or with a
  software keyboard up**, the case `--keyboard-inset` and the `100dvh` cap are
  for. Of the eleven other files that open one, only Codex's `Use API key` has
  been opened, width unrecorded; the workflow pass did not trigger
  `WorkflowEditor`'s or `WorkflowSchedule`'s confirmations.
