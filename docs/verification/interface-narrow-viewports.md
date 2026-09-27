# Verification: Interface — pages at 390px, layout sweeps and smoke-pages

[← Verification index](../verification.md)

## Verified

- **Layout sweep, production build, twelve widths 1440–380px, both themes,
  geometry read from the DOM:** it found and fixed three defects (a 0px gap, a
  button 92px outside its card at 380px, a translucent save bar), after which
  no page scrolled sideways.

- **The workflow surface at 390x844, headless Chromium, 2026-09-10.** The
  block list replacing the canvas below `md`, 288px controls and 44px links
  measured by box; `smoke-pages` clean on all five pages at both widths; the
  list's four gestures answer Playwright's synthetic `tap()`; the 1280px table
  screenshot is byte-identical.

- **`/settings` at 390px, headless Chromium, geometry only.** The standalone
  bundle at 390x844 and 390x568, every disclosure open, every switch on, a long
  path in every field: nothing past the viewport, no sideways scroll on
  `#main`. The 44px floor was read off bounding boxes, not hit.

- **Stacked tables (`d8c711d`) typecheck, test and build.** `npm test` 1335
  pass, 0 fail at `c9d0b3c`; the build exits 0 at `a294ed2`, whose CSS holds
  `.md\:contents{display:contents}`. An unescaped `grep 'md:contents'` matches
  nothing there: grep built CSS with `-F` and escaped colons.

- **`/chat` at 390×844 has no element wider than its parent.** Headless
  Chromium, standalone bundle, seeded chat; this fixed a 584px column in a
  358px pane that `smoke-pages` cannot see. With a 336px keyboard inset set by
  script, composer and Send stay inside the pane. 1280×900 differs from
  `bf9d40b` in 0 of 1,152,000 pixels.

- **The mobile form pass (`d8c711d`, `2e68820`) passes typecheck, test and
  build, and two of its classes reach the CSS.** On the `a294ed2` build,
  `grep -cF 'max-md\:text-\[16px\]'` and `'max-md\:min-w-32'` match once each;
  `min-width:8rem` never does, since Tailwind v4 emits a `calc()`.

- **The density restructure typechecks, tests (1335 pass, 210 suites) and
  builds, and was read at a wide desktop width.** Per `ui-density-audit.md` §9,
  the completion pass opened eleven surfaces and found `CardTitle`'s `mb-0` a
  no-op at seven call sites, every table's fixed columns at a third of their
  width, and `npm test` failing on macOS for an unrelated reason.

- **`ListRow`'s wrap threshold and its wrapped line, 2026-09-13** (Chromium 151
  via the globally installed Playwright 1.62.1, against `.next/standalone/
  server.js`, at 390px and 1280px in both themes and both skins, on `/settings`'
  105 rows and `/runs/new`'s 15). Two readings, both on the live page. *When it
  wraps:* the narrowest description column on `/settings` measured **132.3px**
  in the default skin and **144px** under ascii — the row content is 294px, so a
  145.7px `SegmentedControl` beside the old 128px floor left four words to a
  line over fourteen — and against a 176px floor for any row carrying a
  `description` the same figures are **176.2px** and **210px**. The wrapped
  count went 41 → 41 and 42 → 43 on `/settings`, 10 → 10 and 10 → 11 on
  `/runs/new`: switch rows (40px control) and short-value rows (up to 78.6px)
  did not move, and the twenty-five `max-md:w-40` stacking hints on
  `src/app/settings/page.tsx` came out with the rows they were holding still
  wrapping. *What a wrapped line is worth:* on `/runs/new`'s Workspace row,
  setting `width: 100%` on the caller's own wrapper resolved to **294px** with
  `ListRow`'s children wrapper as it now ships and to **117px** (114px ascii)
  with its `grow` taken straight back off in the same frame — the shrink-to-fit
  width of its own content, which is what made `max-md:w-full` inert there and
  what `WorkflowEditor`'s `ROW_CONTROL` was carrying a 288px literal to work
  around. At 1280px all 120 rows measured identical before and after in all four
  states, which is what the `max-md:` prefix on every class touched predicts.
  `npm run smoke-pages` 46/46 against the standalone bundle, and nothing on
  either page reaches past a clipping ancestor at 390px in any of the four
  states. Caveat: measured through a headless Chromium, no touch and no other
  engine; and `WorkflowEditor`'s inspector rows were not driven in a browser,
  because reaching them needs a block selected on the canvas — the mechanism was
  measured on `/runs/new` instead, and that reading covered `WorkflowEditor`'s
  `ROW_CONTROL` only — see the entry below for the call site it missed.

- **The schedule editor's two open-ended rows, 2026-09-13** (same tooling as the
  `ListRow` entry above, with the editor opened by its own `Add schedule`
  button). The entry above counted `WorkflowEditor`'s `ROW_CONTROL` as the only
  holder of a 288px literal standing in for a percentage, and that was wrong:
  `WorkflowSchedule.tsx` held two more, on `How often` and on the `Timezone`
  field that has to show an IANA name like `America/Argentina/Buenos_Aires`.
  Converted to `max-md:w-full`, both rows wrap at 390px in all four states and
  their control goes **288px → 294px**, the full column. `Time` stays flat at
  **128px** — the comment there argues a bounded two-digit value should not be
  widened to the card, and it still holds. At 1280px all three rows are
  unchanged at 208px/208px/128px, none wrapped, and nothing on the page is
  clipped in any of the four states. Method caveat worth more than the numbers:
  the editor is behind a click, and a probe that reads the DOM *before* pressing
  the button comes back with the budget card's three rows — a clean-looking
  answer about the wrong rows, not an error.

- **The replay row on `/runs/[id]/touched` at 390px, 2026-09-13** (Chromium 151
  via the globally installed Playwright 1.62.1, against `.next/standalone/
  server.js`, both themes and both skins, with `/api/runs/*/touched` and its
  `sequence` answered from a fixture of 24 files and 60 calls so the map and the
  scrubber both draw). The column is **324px** inside the card. The row's
  min-content measured **361.5px** in the default skin and **468.2px** under
  ascii, where a compact button draws twice as wide — 52.3px against 26.3px for
  `‹`. It fitted anyway because the scrubber carried `min-w-0`: under ascii the
  four buttons and four gaps took 291.1px and left it **32.8px**, of which its
  own `w-10` value readout is 40, so the track was zero pixels wide and the
  figure overhung its box by **15.2px** onto Reset. With the `min-w-0` off and
  `flex-wrap` on the row, min-content is **177px** in both skins — the readout
  plus what a range input needs to still be one — the scrubber measures
  **202.5px** (default) and **235.5px** (ascii), and nothing on the page reaches
  past its parent that did not before. At 1280px the row is one line in both
  skins with the same arithmetic it had. The map itself does **not** overflow:
  its container measured 324px against a 324px column, and the `minmax(0,1fr)`
  on the grid track that the page's own comment records is what already holds
  that. Caveats: headless Chromium only; the map's *canvas* draws node labels
  past its own edge at this width and is clipped there, which is the force
  layout's own doing and is filed separately; and the fixture is not a real
  run's touch history, so only the row's geometry was measured, never the
  replay's behaviour.

- **The Model picker on `/runs/new` at 390px, 2026-09-13** (Chromium 151 via the
  globally installed Playwright 1.62.1, against `.next/standalone/server.js`,
  both themes and both skins). Asked for its intrinsic width with
  `width: max-content` and the option text substituted in place, the control
  needs **322px under ascii** for `Inherit — Claude Code's own default` against
  the **288px** its wrapper gives it — 34px over, and 300px/12px over in the
  default skin; `measureText` in the element's own computed font puts the string
  at **280px** of a 266px content box before the chevron takes any of it. The
  same measurement says `Inherit — Claude Code's default` still needs 290px, so
  the shorter sentence would not have been enough either. What the control now
  shows where Settings names no default is `Inherit`, and the floor is then the
  **catalogue's own widest option**: 282px under ascii and 267px in the default
  skin, 6px and 21px inside the box. The named case takes the catalogue's label
  rather than the id, which is what holds it to that same floor — a raw
  `claude-haiku-4-5-20251001` behind `Inherit — ` is the 35 characters again.
  Every other select on the page fits at 390px and 1280px in all four states,
  the widest being Folder's `workspace — the whole workspace` at 18px inside its
  box under ascii, and nothing on the page reaches past a clipping ancestor.
  Caveat: headless Chromium only, so the chevron's own width is inferred from
  the intrinsic-width reading rather than measured directly; and the ascii
  headroom on this page is now 6px, which the seven `max-md:w-72` literals on
  it would widen to 12px — filed rather than done here.

- **`smoke-pages` now sees a clipped overflow, and caught three on its first
  run, 2026-09-14** (`npm run smoke-pages` against a standalone build of
  `uf/usagefoundry-721638d11c0b-2-6a9afb21`, Playwright Chromium, 23 routes ×
  2 skins × 2 widths). The fourth assertion — no box wider than a parent that is
  not a scroll container — closes the blind spot the entry "The chat surface at
  390px" names as its reason for existing: `AppShell` clips rather than scrolls,
  so a pane-wide box leaves `scrollWidth` equal to `clientWidth`. It found
  `/branches` at standard 390 (a `<label>` 333px in a 324px row, the Repository
  select's last 9px outside the card), `/knowledge` at standard 1280 (the graph's
  group query `<input>` drawn 22px inside a `min-w-0 flex-1` track that collapsed
  to 2px), and the permission-mode segmented control 338px in 322px on
  `/settings` and `/runs/new` at ascii 390 — filed as `d876bace`, `8b7aa64c` and
  `1cefeb31` rather than fixed there. Result: `88/92 page loads clean`, exit 1.
  Three exclusions were read off runs rather than guessed and are written out in
  `clippedOverflow()`: a parent whose `clientWidth` is 0, anything inside an
  `<svg>` (268 hits in the first run, all from `offsetWidth` being `undefined` on
  an `SVGElement` so that `undefined - 346` is `NaN` and passes every `<=`),
  out-of-flow elements (`.uf-ascii-frame` is `inset: calc(-0.5em - 1px)` by
  design), and the margin box rather than the border box (a `-mx-4` full-bleed
  sticky footer measured 390px in a 358px `<form>` and 1056 in 1016, both exactly
  its own margins). Caveat: headless Chromium at two widths only, and the pass
  now exits 1 on this branch until those three are fixed — a green run is not
  available to compare against.

- **Six of `/runs/new`'s seven `max-md:w-72` literals are now the wrapped line,
  worth 6px at 390px; the seventh cannot be and stays a literal
  (2026-09-14).** Same instrument and build, at 320px, 390px and 1280px in all
  four states. At 390px Workspace, Folder, Model and Provider each go from the
  288px literal to 294px of column, and the widest option's headroom inside the
  select's text box moves with it: Folder's `workspace — the whole workspace`
  from 19.9px to 25.9px in the default skin and 18px to 24px under ascii, Model
  from 42.0px to 48.0px and 26px to 32px. At 1280px every reading is identical
  to the byte, the literal being inert above the breakpoint. At 320px the
  column is 224px and the wrappers now respect it — Workspace and Provider fit
  it exactly where the literal put them 64px past it, Model narrows to 267px
  (282px under ascii) and Folder holds at 289px, both floored by the select's
  own intrinsic width rather than by a written figure. No option text is newly
  clipped at any width, no sideways scroll and no console error in any of the
  twelve loads. The seventh, the `When a limit is reached` `SegmentedControl`,
  keeps `max-md:w-72`: `ListRow`'s control side is `shrink-0`, so it is only as
  wide as its content and a percentage against it resolves to that content —
  measured 352px, the control's own max-content, which leaves the row wider
  than the card instead of wrapping it. `max-md:grow` widens that side to the
  line first only for a control *narrower* than the line, which is why the six
  above work and this one does not. Caveat: Template and Agent carry two of the
  six and were not rendered — the sandbox has no templates and no agents — so
  they are covered by the shared class and not by a reading of their own.

- **`ListRow`'s control side may now shrink below the breakpoint, and it moves
  only the controls it was for: 98 of 1,248 readings changed, none of them a
  switch or a `w-24` field and none of them at 1280px (2026-09-14).** A scratch
  Playwright probe staging the same throwaway install `scripts/smoke-pages.mjs`
  does, against a standalone build, reading every `ListRow` on `/settings`,
  `/runs/new` and `/workflows/[id]/edit` at 320px, 390px and 1280px in both
  themes and both skins, once before `max-md:shrink max-md:min-w-0` and once
  after. Of the 98 readings that changed, 64 are a `SegmentedControl` and 34 a
  wide wrapper; 0 of 516 switch readings and 0 of 24 `w-24` readings moved, and
  every reading at 1280px is identical. The mechanism is why the blast radius
  is that small: with `flex-wrap` on there is negative free space to distribute
  only when a single item is wider than the line, which a switch or a short
  number field never is. What the changed rows do is wrap — `/settings`' two
  permission-mode rows go from a 310px control side in a 294px content box to
  294px and a row 46px taller, and at 320px from 310px against 224px to 224px
  exactly. `/runs/new`'s `When a limit is reached` row takes `max-md:w-full`
  with it, retiring the seventh literal the entry above could not. Caveat: the
  themes were set through the stored key, so the OS-default state (no
  `[data-theme]`) was not one of the four measured.

- **`npm run smoke-pages` is 92/92 against 85/92, and the four narrow-viewport
  defects it had found are gone (2026-09-14).** Same standalone build. Before:
  `/branches`, `/knowledge`, `/runs/new` and `/settings` failed the
  clipped-overflow assertion in some skin at some width. After the row change,
  the `/knowledge` colour-group track (`grow basis-40`, so the trailing
  Up/Down/Remove cluster wraps instead of squeezing the query field to 2px) and
  the `/branches` repository label (`min-w-0` on both boxes), all four are
  clean. Two further defects surfaced in the same pass and were fixed with it,
  both one cause: `break-words` does not change an unbreakable token's
  *min-content* contribution, so an operator path sized the box it was in —
  `EnvRow`'s pair measured 433px in a 358px `dl` on `/settings` and the mount
  path 433px in a 294px row on `/runs/new`, both now `break-all`. Caveat: those
  two are only reachable with a long path. The harness's sandbox sits under
  `/private/var/folders/…`; the container's own `/data` and `/workspace` are
  short enough that neither would ever have shown there.

## Not yet verified by hand

- **The layout sweep has not been re-run since the layout below 768px
  changed** (drawer source list, seventeen tables stacking at `md`).

- **The narrow workflow surface has never been touched by a real finger**:
  thumb reach, a 44px row at the foot of a long list, and whether the list
  reads as an ordering are unjudged. On a phone: link two non-adjacent blocks
  of a six-block graph at `/workflows/[id]/edit`, watching the arming state
  while scrolling, then change a schedule at `/workflows/[id]`.

- **The Settings mobile pass has never been on a phone or tapped, and its
  stacked calibration table has never shown a real scan.** With no
  transcripts `Scan history` gives no suggestion; the table was seen only with
  `cal` seeded by a reverted local patch. No sheet here but Codex's `Use API
  key` has been opened.

- **Two widened new-run pickers, template (`runs/new/page.tsx:1388`) and agent
  (`:1547`), were never seen at 390px** (settle: save one of each, open
  `/runs/new`); they match the four measured by construction. Nothing in that
  pass was tapped. At 390px the touched and conflicts maps held two and one
  file nodes: no folded directory, `modify/delete` node or open inspector.

- **No stacked table has been opened in a browser.** Unseen at 390×844: no
  sideways scroll, and the branches bar above its arithmetic-chosen
  `max-md:h-80` spacer. `max-md:last:border-b-0` is not recorded in the CSS,
  and 1440px unchanged rests on `Table.test.tsx` alone.

- **The chat surface has met no real device and no interaction.** Unknown:
  whether 24px between Reject and Approve (chosen, not measured) keeps a thumb
  off a billed run, and whether the sticky composer holds on iOS Safari.
  Nothing pressed a choice, approved, sent a message or opened the drawer.

- **The mobile form pass was reasoned from platform docs and never watched.**
  On a real iOS device: tapping a `/runs/new` field must not zoom, and the
  composer, save bar and `Sheet` buttons must stay above the keyboard, with
  `--keyboard-inset` back to `0px` on blur. 44px targets at ≤767px are
  unmeasured, and 1440px unchanged is by argument.

- **The density restructure is unseen below about 390px and unmeasured at
  1440px.** The browser would not resize, and none of the five build runs had
  Docker. Also unseen: the `Land N branches` confirmation, the fixed-bar
  strategy picker, `Disclosure`s opening and closing, and Approve sending
  exactly the displayed ids through a real thread.

- **The four-item release pass is written down and nothing has performed
  it**, so how many of the nineteen `src/app/**/page.tsx` pages fail it is
  unknown. Each item runs across every page, at two widths:
  1. Every page at 390px: no sideways body scroll, no clipped control, every
     `stack`ed table naming its own fields — the class of `434c235`'s Land
     select, where `.w-auto` (byte 15178) lost to `.w-full` (byte 15197).
  2. Every page in both themes, and on "Match system" while the OS appearance
     changes; a `<canvas>` must re-probe its colours without a reload.
  3. Tab through each primary flow: the focus ring visible at every stop, in
     the order the page reads.
  4. The controls that need state: a queued run's priority input, the Backups
     row's `unreadable` state, the chat turn's live view. The fourth, Deliver,
     is no longer open: it opened a real pull request, on the one path where
     branch, remote and credential are all present.
