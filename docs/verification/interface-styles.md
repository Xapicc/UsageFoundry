# Verification: Interface — buttons, contrast, colour and legacy CSS

[← Verification index](../verification.md)

## Verified

- **The legacy `.grid` rule's reach, 2026-09-16.** Against
  `.next/standalone/server.js`, all 23 routes `smoke-pages` knows, at 1280px and
  390px, `<details>` forced open. Deleting the `@layer legacy` `.grid` rule from
  the live CSSOM and re-reading every element's rect moved **nothing** on any of
  the 46 loads — 9 rendered elements carry the bare `grid` class and 8 state
  their own `gap-*`, and the ninth, `/knowledge`'s recessed graph card, holds
  both its children in one cell so its inherited 16px painted no track. The one
  call site that really was being spaced by it is not reachable from a page
  load: `runs/new/page.tsx`'s validation list, whose rows sat 16px apart with
  the rule and went flush without it, measured by cloning its single row to
  three. It now says `gap-4` and measures 1928/1976/2024 at 1280px and
  2574/2634/2694 at 390px — the same figures as before the rule was deleted.
  Caveat: a state reached only by pressing something other than **Start run** is
  outside this, and the static call-site list is what stands behind those.

- **The busy button's spinner ring, measured on both filled variants,
  2026-09-16.** Headless Chromium 151.0.7922.34, dpr 4; `<Button busy>`
  rendered to static markup against the built stylesheet rather than reached
  through a route, because no page holds the state long enough to navigate to.
  Track against its own fill: primary #669aeb on the capped #0056de, 2.18:1;
  danger #e76673 on #d70015 light, 1.68:1, and #ffa5a0 on #ff6961 dark,
  1.50:1 — all under the 3:1 WCAG 1.4.11 asks of a graphical object, and left
  there deliberately for the reasoning now in `BUSY_RING`'s comment. The
  full-alpha quarter is 6.20:1 on primary and 5.38:1 on danger light, so what
  carries the state clears the floor on three of the four; on danger dark it
  is 2.82:1, which is the dark `--danger` fill and not the ring, and is filed
  separately. Caveat: one engine, and its `AccentColor` is #0075ff, so the
  primary figures are that accent capped rather than a desktop's.

- **A disabled bracketed button, re-measured either side of its floor,
  2026-09-14.** Headless Chromium 151.0.7922.34, dpr 2, against
  `.next/standalone/server.js`; `/settings`' sticky footer at 1280 under
  `data-skin="ascii"`, crop backdrop taken as the modal colour and the glyph as
  the pixel furthest from it. Before: the resting `[ Save ]` drew #345c90 on
  #1e1e20, **2.44:1** dark, and #77abe5 on #f0f0f3, **2.11:1** light — both the
  variant's `--accent` at `disabled:opacity-50`, and the arithmetic agrees, a
  50% composite of #4a9bff over #1e1e20 being #345c90 exactly. After: #8a8a8f on
  #1e1e20, **4.84:1**, and #86868b on #f0f0f3, **3.19:1**. The target was 3:1
  and not 4.5:1 — WCAG 1.4.3 exempts a disabled control, and the bar taken
  instead was the graphical-object floor the skin's frame tones already sit at,
  because under this skin the brackets are the mark that says a control is
  there. A *busy* button was checked separately and does not take the floor:
  two buttons built from the live page's own class string, one `disabled` and
  one `disabled aria-busy="true"` with `disabled:opacity-50` dropped the way
  `Button` drops it, compute `--fg-faint` and `--danger` respectively, both at
  opacity 1. They had to be built rather than toggled — setting `aria-busy` on
  an element already in the page flips `matches()` and leaves the computed
  colour behind, Chromium not invalidating the cascade for an attribute that
  appears only inside a `:not()`. The app never sits in that state: React
  rewrites `className` in the same commit, which invalidates.
  **Caveats:** the light figure is `--fg-faint`'s own worst reading and
  has no margin over the floor; the glyph sample is the best pixel of an
  antialiased stroke, so the true reading is a little under both; and the
  figures filed on the task were 1.93:1 and 1.74:1, measured on
  `uf/usagefoundry-721638d11c0b-1-66a74a67` against a backdrop that is not the
  #1e1e20/#f0f0f3 this footer draws today.

- **Bracketed buttons back on the column, 2026-09-14.** Same engine and bundle;
  `/runs`' `[ New run ]` at 390 and 1280 in both themes, the button's border-box
  edge read from `getBoundingClientRect` and the bracket's edge as the first
  column of ink in a viewport frame. Before, identical in all four states: box
  left 16, ink left 32.5, so **16.5px** — `px-3.5` plus the 1px border is 15px
  of box and the `[` glyph's own side bearing is the rest; the right-aligned
  case the same, gutter 1260 against ink at 1243.5. After: **1.5px** on both
  sides in all four states, which is the side bearing alone, with
  `padding-inline` and `border-inline-width` both reading 0. The label spacing
  inside the brackets is untouched, being `::before`/`::after` content.
  **Caveat:** the accompanying page walk — 23 routes at 390 and 1280 in both
  themes under the skin, 92 loads — asserted only two things, that nothing
  scrolls sideways and that no `.uf-button` has `scrollWidth` past its
  `clientWidth`, and it is a one-off pass rather than a check in the tree;
  `smoke-pages` still has no skin axis, so it was green before and after
  without seeing any of this.

- **The OS accent pair bounded, and what the bound costs, 2026-09-14.** Same
  engine and bundle. Before, `AccentColor` resolved to #0075ff and
  `AccentColorText` to white, **4.21:1**, and that one reading is what every
  `bg-tint text-tint-fg` call site drew at 390 and 1280 in both themes: the
  primary `Button`/`ButtonLink`, the sidebar's active row and its label span,
  and the quick-open highlight. After, with `--tint` taken as
  `oklch(from AccentColor min(l, 0.5) c h)` and `--tint-fg` back to white, the
  fill paints #0056de and all of them measure **6.20:1**; `QuickOpen`'s detail
  line, raised from `text-tint-fg/75` to `/85`, measures **4.92:1** against
  **4.16:1** — read off the app's own emitted classes rendered in the live page,
  the panel's own keystrokes not being reachable from this context. The cap is
  0.5 rather than 0.52 because **this engine clips out-of-gamut channels instead
  of reducing chroma the way CSS Color 4 §13 asks**: painted,
  `oklch(from #00ff00 min(l, 0.5) c h)` is #008400 and carries white at 4.88:1,
  where the same expression at 0.52 is #008b00 and 4.47:1. **What it costs, and
  it is not free:** a darker fill stands off a dark page less well, and the
  primary button's fill against the toolbar goes 3.95:1 → **2.68:1** in dark
  while light goes 3.70:1 → 5.45:1. That trade is forced — white needs the fill
  under Y 0.183 and a 3:1 stand-off from this app's near-black needs it over
  Y 0.139, a band narrower than one OKLCH lightness spans across the hue circle
  — and the label was taken over the fill. **Caveat:** the only accent seen is
  the #0075ff this headless engine reports; on a real desktop it is the
  operator's, so the floor is the sweep's argument rather than a reading, and
  nothing here was run in a second engine.

- **`/settings`' section strip clears 4.5:1 in all eighty readings,
  2026-09-12** (`dd66cfb`): the built standalone bundle served against a
  throwaway `DATA_DIR` and a `CLAUDE_BIN` that cannot spawn, Chromium at dpr 2,
  the strip scrolled to centre and every chip cropped from one viewport frame
  per combination — 10 chips x {390, 1280} x {light, dark} x {ascii, default}.
  Backdrop is each crop's modal colour, glyph the pixel furthest from it in
  luminance, so the figure is the *best* pixel of an antialiased stroke and the
  real reading is worse. Before the fix, 44 of 80 were below 4.5:1:
  `--fg-muted` on `--bezel` 3.54:1 in dark, and `--tint-fg` on `--tint` 4.21:1
  everywhere. The second figure is the environment's rather than the app's —
  under the `@supports` block at globals.css:330 that pair resolves to
  `AccentColorText`/`AccentColor`, which headless Chromium answers `#0075ff` on
  white; the declared fallback is 5.22:1 light and 5.06:1 dark. After the fix,
  0 of 80, worst 4.87:1, and the strip no longer reads that pair at all. Both
  skins measured identically on both sides, so the ascii skin neither caused
  the defect nor was needed to fix it. Caveat: the measurement harness was
  scratch and is not in the tree, so this is a one-time reading rather than
  something a later change re-runs.

**The legacy `.meter*` block had no call sites and is gone; `.grid` does,
2026-09-14.** `.meter`, `.meter-head`, `.meter-value`, `.meter-upper`,
`.meter-track`, `.meter-fill` and its four `[data-sev]`/`[data-unknown]`
selectors: `grep` over `src/**/*.{ts,tsx}` finds no literal for any of the six
and no `` `meter-${…}` `` assembling one. The hatch survives the deletion —
`@utility hatched` is the same 45° repeat off `--border-strong`, `Meter.tsx`
draws the unknown band with it and `Meter.test.tsx` asserts it. Of the four
neighbours the task asked to check while here, `.grid-2` and `.table-wrap` have
0 call sites and `.lede` has 0 as a class, but `.grid` is **not** dead and was
left alone: `@layer legacy` is declared before `utilities`, so Tailwind's `grid`
utility wins the `display`, and `.grid`'s `gap: 16px` then applies to any
element carrying the bare utility that states no `gap-*` of its own. Measured
over twelve routes at 1280: 5 elements carry bare `grid`, 1 of them states no
gap, and it computes `gap: 16px` — the recessed graph card on `/knowledge`.
Deleting the rule would move that card's contents, so it is filed rather than
fixed.

- **The dark-skin danger button's label goes 2.82:1 → 5.38:1, and the busy
  ring's arc with it, by splitting `--danger-solid`/`--danger-fg` off
  `--danger` (2026-09-18).** Measured from painted pixels, headless Chromium
  151.0.7922.34, dpr 4, against the standalone build's own
  `.next/static/css/*.css`: `<Button variant="danger">` and
  `<Button variant="danger" busy>` rendered with `renderToStaticMarkup` onto
  each of the four surface tokens in both `[data-theme]` states, sampling the
  modal colour of a strip inside the button and the glyph pixel furthest from
  it in luminance. Before: fill `#ff6961`, label 2.82:1 at rest and 2.64:1
  under the `brightness-110` hover, the full-opacity busy arc 2.82:1 with it.
  After: fill `#d70015` in both schemes, label 5.38:1 and 4.55:1, arc 5.38:1,
  the `/40` track `#e76673` at 1.68:1 — the same three figures the light skin
  already measured, which is the point of the value being one literal rather
  than a `light-dark()` pair. The light skin is unchanged at every reading.
  What the deeper fill cost, measured in the same frames: the fill's own
  contrast against the dark page went 5.90/5.07/6.41/4.53:1 on
  `--bg`/`--bg-raised`/`--bg-inset`/`--bg-grouped` to 3.09/2.66/3.36/2.37:1,
  so two of the four now sit under 1.4.11's 3:1 — against the dark primary
  button, measured beside it in the same frames at 2.68/2.31/2.91/2.06:1.
  `npm run typecheck`, `npm test` (2827 pass) and `npm run smoke-pages` (92/92,
  serving `.next/standalone/server.js`) are clean on the change. Caveat: the
  glyph reading is the *best* pixel of an antialiased 14px stroke and the fill
  is flat, so the label figure is the pair's endpoint rather than what most of
  the stroke measures; and the static shell carries no `next/font`, so the
  glyphs were painted in the fallback face rather than in SF.

## Not yet verified by hand

None yet.
