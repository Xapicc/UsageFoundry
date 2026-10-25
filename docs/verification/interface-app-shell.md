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

- **The toolbar's usage readout fits wherever it appears and changes nothing
  where it does not, 2026-10-07** (`npm run build` at the branch's tip, standalone
  bundle against a scratch `DATA_DIR`, `CLAUDE_BIN` that cannot spawn, Chromium via
  the globally installed Playwright; `/api/usage/remaining` intercepted so the
  readings could be chosen). 112 states — default and ascii skins, one and two
  providers, source list open and collapsed to the rail, seven viewport widths
  from 768 to 1440, `/` (the only route with an action) and `/runs`: the header's
  `scrollWidth` equals its `clientWidth` in all 112, the readout is never drawn
  beside a truncated title, and it always fits inside the title's row. It first
  appears at 768 (rail, one provider, a route with no action: 5h only) at the
  earliest and at 1100 (list open, two providers, `/`: 5h only) at the latest, and
  both windows are drawn in every state from 1280 up; at 768 with the list open
  on `/` it is not drawn, the title having 13.9px (default) or 0px (ascii) there
  already.
  Natural widths of the link, default skin: 98.6px (one provider, 5h only), 152.2
  (one, both windows), 193.2 (two, 5h only), 300.4 (two, both); ascii is 4-10%
  narrower. The widest route title is 98px (ascii, "What it touched"), which is
  what the 120px reserve in `SHOW`/`SHOW_WEEKLY` is measured against. Wrapping the
  title in the row the readout shares changed the title's width in none of 32
  states (both skins, list and rail, 768/820/900/1024, `/` and `/runs`), compared
  against the old structure rebuilt in place in the same page. At 390, 767 and 768
  with a provider signed in the readout is `display: none` and the header does not
  scroll. Against the real route: nothing signed in answers `{"providers":[]}` in
  4-7 ms; a Claude credential with no network answers in 13 ms with both windows
  unknown; with a Codex `auth.json` as well the first call took 5.3 s (the app
  server failing) and the second 13 ms. Caveats: one Chromium, one font stack —
  the thresholds are in rem against widths measured in this one, with the 120px
  title reserve as the slack; no real reading was fetched from either provider (no
  credential here), so the figures drawn were the intercepted ones; and the
  failed-poll branch was seen as "draws nothing on a first failure" only, the
  turn-to-dashes branch after a good answer being covered by the unit test and not
  by a browser, since the poll is 120s.

- **A `Sheet` takes its wrapping from itself and not from the element it is
  written inside, 2026-10-25** (`npm run build` at `9460b274`, standalone
  bundle against a scratch `DATA_DIR`, `CLAUDE_BIN` and `CODEX_BIN` that cannot
  spawn, Chromium 151.0.7922.34 via Playwright 1.62.1, skin in `localStorage`
  before first paint; `/api/claude-auth` and `/api/codex-auth` intercepted so the
  sheets could be opened signed out, signed in and mid-flow). Before: the seven
  sheets `/settings` writes inside an `EnvRow` had a `<dialog>` whose computed
  `word-break` was `break-all`, inherited from the row's `<dd class="break-all">`
  through the top layer; `overflow-wrap` read `normal` and `hyphens` `manual`.
  The other 21 dialogs on those eight pages (`/`, `/runs`, `/agents`,
  `/branches`, `/projects`, `/tasks`, `/workflows`, `/settings`) all read
  `normal`. "Sign in to Claude" wrapped "…The link works f" / "rom any device."
  at 1280 default and "…The li" / "nk works…" at 1280 ascii; at 390 that paragraph
  broke on a space only because the width happens to end a line there, while the
  sign-out sheet broke twice and the error line broke "paste its c" / "ode." in
  both skins.

  After: `word-break: normal` and `overflow-wrap: anywhere` on the dialog, and all
  28 dialogs read that. 0 mid-word breaks outside the two `break-all` URL lines in
  32 readings (six sheets: Claude sign-in with its error line, Claude sign-out,
  Codex sign-in, Codex API key with its error line, and both `FleetControls`
  sheets; both skins; 1280 and 390), against 14 of those 32 before. The panel's
  `scrollWidth` and `clientWidth` are the same before and after in every state
  (542/542 and 388/388 default, 549/542 and 395/388 ascii, the frame's own 7px).
  `npm run smoke-pages`: 100/100 page loads clean, standalone bundle. Caveats: the
  `FleetControls` sheets were opened by calling `showModal()` on the
  always-rendered `<dialog>` with no stopped run behind it, so they read "Pick up
  0 runs" over the real text; the local model's two sheets, `/projects`,
  `/agents`, `/branches`, the workflow pages, `RunLand`, `RestartClosed` and
  `TaskEditor` were not opened, only their dialog's computed `word-break` read.
  One Chromium, one font stack.

- **`EnvRow`'s value cell wraps prose at spaces and still holds a long path
  inside its column, 2026-10-25** (`npm run build` at `94ec70ff` with and
  without the change, standalone bundle against a scratch `DATA_DIR`,
  `CLAUDE_HOME` and workspace root each a 70-character hyphen-free directory
  name, a `CLAUDE_BIN` and a `CODEX_BIN` that cannot spawn, `/api/local-provider`
  intercepted so the Local model row drew signed in; Chromium 151.0.7922.34 via
  Playwright 1.62.1, skin in `localStorage` before first paint; `/settings`
  read with the sign-in token set and with it blank). Mid-word was counted per
  character: a line break between two letters or digits in a word of 24
  characters or fewer outside a `mono` span, read off each character's range
  rect, so a break after a hyphen or slash is not counted. Before: the `<dd>`
  read `word-break: break-all` and `overflow-wrap: normal`, and all 8 readings
  (both skins, 390 and 1280, token on and off) had a prose word broken, 25 in
  all, across the Admin key, GitHub token, Sandbox, Sign-in, Claude account and
  Codex account rows ("sandbox", "CLI", "stays", "spawn"). After:
  `word-break: normal` and `overflow-wrap: anywhere`, 0 prose words broken in
  all 8. The `dl` is 358px at 390 and its `scrollWidth` equals its
  `clientWidth` in every reading, the document's the same, no `<dd>` is wider
  than its row and none scrolls, both before and after (748px at 1280 default,
  624px ascii). What still breaks inside a token after the change is a token
  longer than its line: the two paths, the 75-character mount label, and the
  Local model row's `window`, which is the row's own `mono break-all` span and
  was left as it was. `npm run smoke-pages`: 100/100 page loads clean on the
  standalone bundle, run on the changed tree only. Caveats: the Claude and Codex
  rows were read in their "unreadable" state and Local model signed in by
  intercept, so the signed-in and signed-out lines of the two account rows, the
  GitHub token's "configured" line and the failed-sign-ins row were not drawn;
  the sheets are `Sheet`'s and were not re-read. One Chromium, one font stack.

- **The Local model row's signed-in line wraps at spaces and still holds a long
  URL inside its column, 2026-10-25** (`npm run build` at `5ba27e95` with and
  without the change, standalone bundle against a scratch `DATA_DIR`,
  `CLAUDE_HOME` and workspace root, a `CLAUDE_BIN` and a `CODEX_BIN` that cannot
  spawn, `/api/local-provider` intercepted to signed in with model
  `qwen2.5-coder` and a 32,768-token window; Chromium 151.0.7922.34 via
  Playwright 1.62.1, skin in `localStorage` before first paint; `/settings` at
  390 and 1280, both skins, with the base URL `http://127.0.0.1:11434/v1` and
  with `http://` plus a 70-character hyphen-free host and `:11434/v1`, 86
  characters in all). Mid-word was counted as in the `EnvRow` entry above: a
  line break between two letters or digits in a word of 24 characters or fewer
  outside the URL, read off each character's range rect. Before: the
  `mono break-all` span read `word-break: break-all`, and 5 of the 8 readings
  broke a prose word, "window" in all four at 390 ("…32,768-token win" / "dow ·
  token set") and "token" at 1280 ascii over the long URL. After:
  `word-break: normal` and `overflow-wrap: anywhere` on the span, 0 of 8, every
  break outside the URL falling at a space or at the hyphen in "32,768-token".
  The long host still breaks inside itself, once or twice, because it cannot
  fit a line of its own.
  The `dl` is 358px at 390 and 748px (default) or 624px (ascii) at 1280, and in
  all 16 readings, before and after, `dl`, `dd` and the document have
  `scrollWidth` equal to `clientWidth` and the span's right edge is inside the
  `dd`'s. `npm run smoke-pages`: 100/100 page loads clean on the standalone
  bundle, run on the changed tree only. Caveats: the signed-in state was an
  intercept and not a real sign-in; the signed-out line, the sign-in sheet, and a
  sign-in with no window figure or no token were not drawn. One Chromium, one
  font stack.

## Not yet verified by hand

- **The shared layer's 390px pass (2026-09-10) was never on a real phone or
  with a keyboard up**; the long-label `Meter` case was a fixture only.

- **Few sheets have been seen at 390px, and none on a real phone or with a
  software keyboard up**, the case `--keyboard-inset` and the `100dvh` cap are
  for. Opened so far: Codex's `Use API key`, `Sign in to Codex`, the two Claude
  account sheets and `FleetControls`' two (the last by `showModal()` over a count
  of zero), and quick open. The workflow pass did not trigger `WorkflowEditor`'s
  or `WorkflowSchedule`'s confirmations, and the local model's two, `RunLand`,
  `RestartClosed`, `TaskEditor` and the `/projects`, `/agents`, `/branches` and
  workflow-page sheets have not been opened.
