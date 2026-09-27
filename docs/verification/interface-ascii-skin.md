# Verification: Interface — the ascii skin

[← Verification index](../verification.md)

## Verified

- **The ascii skin's tokens and switch, 2026-09-11**: built utilities read
  tokens one `:root[data-skin=ascii]` block overrides; line tones clear
  contrast (worst 3.19:1, 4.87:1); `npm test` 2618/0, `smoke-pages` 44/44; 48
  `rounded-full` sites stay pills. A live flip zooms `/knowledge`'s graph ~5x,
  as light→dark already did.

- **The ascii skin's kit primitives, 2026-09-11**, eleven components, no call
  site changed: `npm test` 2622/0 with a test that fails without `aria-hidden`,
  sideways scroll 0 on 52 loads; `ListGroup`'s frame, painted out by its own
  box, was found and fixed.

- **The ascii skin's meters, 2026-09-11**: `ui/AsciiBar` in `Meter`, with
  `meterCells` pinned by nineteen tests (0.4% shows a cell, 99.6% leaves one
  empty, no ceiling is `null`); block glyphs measured 14px against 7px ASCII,
  hence `╳` for unknown; `npm test` 2641/0; the charts needed no change.

- **The ascii skin's app shell, 2026-09-11**: 176/176 loads clean (22 routes ×
  widths × skins × themes), default-skin geometry unchanged, `npm test` 2643/0.
  Five defects found only by looking, one of them every framed box app-wide
  inking its stroke 7px inside its edge since frames shipped; `-0.5em`
  corrected all but a pixel on bordered hosts.

- **The ascii frame's second app-wide offset, caught only by reading device
  pixels, 2026-09-11**, 1920x963 at DPR 2: bordered `Card`s inked their stroke
  1.00px inside where `ListGroup` did. `calc(-0.5em - 1px)` leaves 0.016px, and
  a test reading the selector from `globals.css` fails all four mutations.

- **The ascii table head rule is one line again, 2026-09-11**: the `3px
  double` border drew ink-gap-ink; without it, one run of ink at 390, 1280 and
  1920 in both skins, and `/runs` in the standalone server read `1px solid`.

- **The ascii meters fit their card, 2026-09-11**, standalone bundle, three
  pages at 390/1280/1920: `AsciiBar` measures its own advance and fills 96.0%
  to 99.9% of the track (23 cells at 390, up to 123 at 1920), never past it;
  a resize settles once.

- **The Context sparkline's floor line is removed, 2026-09-11**: reproduced
  from the real `ContextOccupancy` at the capture's shape, the 1px floor read
  as a section rule; it is gone in all six shape × skin cases, the prune
  marker still reads as one mark, `npm test` 2647/0.

- **The ascii skin's in-flight marks became one, 2026-09-11**: `▛ ▜ ▟ ▙`,
  since `▀`/`▐` measured 9.22px against 13.00px, drawn 6.50 × 6.50px; DPR 4
  captures on `/runs` rotate clockwise in phase; default-skin pixels
  byte-identical; `npm test` 2647/0, `smoke-pages` 44/44 standalone.

- **The ascii skin's four glyphs are answered by more than one face, and a `╳`
  bar drew 1.61x the bars beside it, 2026-09-12** (Chromium 151 via the globally
  installed Playwright 1.62.1, a scratch page carrying the app's own
  `--family-mono` at `--text-sm` = 13px, twenty cells). On the stack this
  container resolves `--family-mono` to, all four of `█ ▒ ░ ╳` draw 13.00px
  and `[ ] M 0` draw 6.50px, unchanged at every `devicePixelRatio` from 1 to 4 —
  so the defect does *not* show here on the app's own stack, and the mechanism
  does: on the same page `▀` and `▐` draw 9.21px against `█`'s 13.00px, which is
  per-glyph fallback inside one run. Ask for `'Liberation Mono', monospace` and
  the split lands on these four: `█ ▒ ░` at 7.80px with U+2573 left to another
  face at 13.00px. Drawn as plain text that is a twenty-cell bar 171.67px wide
  for every reading and 275.63px for no ceiling; with each run boxed to
  `cells x cellPx` all six cases measured 171.66-171.67px, and on the app's own
  stack all six measured 273.00px before and after, so the pin is a no-op where
  the faces already agree. `overflow-x: clip` and `overflow: clip` measured
  identical widths, and a 6x crop of the two against unpinned rows showed no
  vertical shift or shaved ink in either. Then against the component itself, on
  `/` at 1280px in the standalone bundle with the skin turned on and
  `--family-mono` overridden to that stack: the four meters drew 694.45px in a
  703px track and 975.36px in a 983px track, every bar in a track the same width
  as its neighbour, readings and no-ceiling alike. Stripping the pin off that
  same DOM — the classes and the inline widths, which is the markup as it was —
  left the reading bar at 694.34px and threw the `╳` bars to 1146.63px and
  1614.63px, 443.63px and 631.63px past the track each was fitted to. Caveat: the
  harness is not in the tree, the container has no face that puts the defect on
  the app's own stack so the skin was driven onto a second one by hand, and the
  reported half of this — a band or track wider than the fill *within* one bar —
  was not reproduced: nothing installed here answers `█ ▒ ░` at three different
  widths. The fix covers that half by construction, unmeasured.

- **`AsciiEdge` now lands its stroke on its host's border box edge, and the
  sidebar's halo is gone, 2026-09-13** (Chromium 151 via the globally installed
  Playwright 1.62.1, against `.next/standalone/server.js` on a throwaway
  `DATA_DIR`, `/` at 390x900 and 1280x900, DPR 2, `localStorage["uf-skin"]` set
  before first paint, both themes and both skins). `AsciiEdge` emits
  `uf-ascii-edge-right`/`uf-ascii-edge-bottom` and `globals.css` backs the
  host's still-1px border out of each on its own axis, the directional form of
  the `.uf-unboxed > .uf-ascii-frame` rule that fixed `AsciiFrame`. At 1280 in
  light, the sidebar's `│` moved from device columns 445-446, ink-weighted
  centre css 222.99 against a border box ending at 224.00, to columns 447-448,
  centre 223.99 — a `Card` on the same page reads 1260.00 against a box edge of
  1260.00, so the two now agree — and device column 447, which was `bg-inset`
  (245) against the pane's 240, is the stroke. Dark reads 224.00 and column 447
  goes 22 to 89. The toolbar's `─` moves the same one pixel at both widths and
  in both themes, rows 102-103 to 104-105, centre 51.36 to 52.36 against a box
  bottom of 52.00. Under `default` nothing inked at either edge at either width,
  which is `.uf-ascii { display: none }` holding. Caveats: the `─` reads 0.36
  outside where the card's reads 0.03 inside, and that gap is the device grid
  and not the rule — a 13px `─` inks two rows weighted 0.22 of a device row
  below its em centre, and the toolbar's centre lands on a whole css pixel where
  the card's lands on 412.39; the sidebar is a drawer at 390 and has no edge to
  measure there; and this is one Chromium on one font stack, so the figures are
  this container's rather than a reader's.

**The ascii skin's radius override now reaches every call site that should take
it, 2026-09-14.** `rounded-full` is one of Tailwind's static utilities and bakes
in a literal `calc(infinity * 1px)`, so no selector could flatten it; the fix is
a third corner token, `--corner-pill` (9999px, 0 under the skin), mapped to
`--radius-pill` in `@theme` and spelled `rounded-pill` at the call sites that
are boxes with their ends taken off. Verified in the emitted stylesheet, which
is where an override that does not land is silent:
`.rounded-pill{border-radius:var(--corner-pill)}` against `.rounded-full{border-radius:3.40282e+38px}`.
Verified again as computed radii over ten routes at 1280 in both skins — 68
`rounded-pill` elements read 0px under ascii, and in the default skin 61 read
9999px and 7 read 0px, those seven being `Field`'s range inputs, where the class
carries a `[&::-webkit-slider-thumb]:` variant and the element's own corner was
never the target. 13 call sites moved: the two skeleton bars on `/`, one each on
`/runs` and `/branches`, `/branches`' step ring, `/chat`'s floating chip,
`/settings`' 2px section rail, `KnowledgeGraphView`'s tag dot,
`WorkflowCanvas`'s link chip and `Field`'s four slider variants. 35 stay
`rounded-full` deliberately: 27 legend swatches on `/knowledge`,
`/runs/[id]/touched` and `/runs/[id]/conflicts` stand for nodes a canvas draws
as circles and both maps read a square as a different kind of node, and the
other 8 are on components the skin already redraws or hides. Caveat: 9999px and
infinity render identically only because every box carrying the token is under
19998px in its shorter axis, which is true today and is not enforced.

**There is no bare `rounded`, `rounded-b` or `rounded-t` call site in src/, and
the count of 26 was a grep artefact, 2026-09-14.** The measurement that produced
it was `grep -rnoE "\brounded(-[a-z0-9]+)?(-\[[^]]*\])?" src/`, whose single
optional segment matches `rounded-b-lg` as `rounded-b` and `rounded-t-lg` as
`rounded-t`, and whose bare alternative matches the English word "rounded" in a
comment. Re-derived with `grep -rnoP ".{0,45}\brounded(?![-a-z])"` over
`*.tsx`/`*.ts`: 20 hits, every one of them prose, 0 class names; plus 4
`rounded-b-lg` and 2 `rounded-t-lg`, which resolve through `--radius-lg` and
which the skin already flattens. 20 + 4 + 2 = 26. Caveat: Tailwind's scanner
reads that prose too, so `.rounded{border-radius:.25rem}` is still emitted into
the stylesheet — it is an unused 40 bytes, not a call site.

**The four arbitrary-value corners the skin could reach have moved onto tokens;
the two that are left are flattened by hand, 2026-09-14.** `rounded-[6px]` on
`Sidebar`'s row and `QuickOpen`'s option became `rounded-sm`, which is exactly
6px in the default skin: measured on `/runs` at 1280, both read 6px in the
default skin and 0px under ascii, against 6px in both before. `rounded-[3px]` on
`Field`'s colour swatch became `rounded-[calc(var(--corner-sm)*0.5)]`, which is
exactly 3px in the default skin; `getComputedStyle` on `::-webkit-color-swatch`
reports the originating element's style rather than the pseudo's, so this one was
measured in pixels instead — a `deviceScaleFactor: 4` clip of the control on
`/knowledge` in light, sampled 3 CSS px in from its top-left corner, reads
rgb(245,245,247) in the default skin, the input's own `bg-inset` showing through
a rounded corner, and rgb(224,87,106) under ascii, the swatch colour reaching a
square one. The two `rounded-[4px]`, on `.uf-segment` and `.uf-kbd`, keep their
hand-written `border-radius: 0` — 4px is not a value on this scale and a token
for two call sites costs more than the two declarations.

**The five unskinned controls on `/workflows` are bracketed, and the sixth was
the Link at 390px, 2026-09-14.** `WorkflowCanvas`'s four block-type buttons and
both Link controls — the card's, drawn on the canvas above the breakpoint, and
the narrow list's, which is the only one that renders at 390 — take `uf-button`,
the kit's hook class, which is inert in the default skin. Screenshotted at 390
and 1280 in ascii × {light, dark} and in default × {light, dark}: `[ Runs a task ]`,
`[ Decides what to run ]`, `[ Lands the branches ]`, `[ Repeats a task ]` and
`[ Link ]` under the skin, unchanged rounded boxes without it. The card's Link
cost one restructure: its 44px hit target was a `max-md:after:` overlay on the
button, and `.uf-button::after` is the skin's closing bracket in an unlayered
block, so one element could not be both — the overlay moved to a `<span>` around
the label, whose absolutely positioned `::after` resolves against the same
containing block. Measured: at 390 the span's `::after` is `content: ""`,
`position: absolute`, inset -6px/-3px in both skins, the button's own is `" ]"`
under ascii and `none` without it, and the narrow list's Link is 74×44 under
ascii against 47×44 in the default skin. Caveat: the card's Link is `visible:
false` at 390 in both skins, because the canvas is not laid out below the
breakpoint at all, so its `max-md:` overlay is inert in practice and the
measurement above is of the recipe rather than of a target a finger can reach.

**The `/knowledge` control at y≈883 was the selected segment, and it was
invisible in light, 2026-09-14.** Enumerated every filled or bordered control on
the page under ascii at 390×2600: the only one whose fill said nothing was
`SegmentedControl`'s chosen segment, `rgb(255,255,255)` in light — the card it
sits on — and `rgb(72,72,76)` in dark, at y=884, both figures matching the task's
own. `.uf-segment` now takes `background: none` and the chosen segment says so in
the accent and in weight. Measured on this page: 5.22:1 against the card in light
and 5.06:1 in dark for the chosen segment, 5.54:1 and 5.56:1 for the unchosen,
worst reading anywhere on the page 4.59:1 where a segment sits on `--bg` rather
than a card — all above the 4.5:1 floor. Weight is there because the accent alone
is a channel greyscale loses: 5.22 against 5.54 is very nearly the same
luminance. Bold costs no width in this face — flipping `aria-checked` on the
live element leaves `[Whole vault]` at 94.5px and `[Title]` at 55.5px — so
nothing moves when the selection does, which is what the brackets on both states
were sized for. `aria-checked` is untouched. The two hover and press washes are
restated for `.uf-button`'s reason: `background: none` is unlayered and would
otherwise beat the component's own hover utility. Caveat: contrast is computed
from the two declared colours rather than sampled off the glyphs, so it is the
best case for an antialiased mono face at this size.

- **`smoke-pages` drives the ascii skin, and the axis is otherwise clean,
  2026-09-14** (same run). A second browser context per skin, with
  `addInitScript` writing the key read out of `SkinToggle.tsx` — not a third
  spelling of `"uf-skin"` — so `layout.tsx`'s pre-paint script sets `data-skin`
  before the first frame exactly as it does for a person. Each page load then
  asserts the attribute arrived, because an axis that silently failed to apply
  would report 92/92 clean rather than an error. All 23 routes passed at ascii
  390 and ascii 1280 on all four assertions but for the segmented control above,
  which is the first defect the skin axis has caught and which neither the skin
  axis nor the clipped-overflow check finds alone. Cost: 44 page loads became 92,
  which `CLAUDE.md`'s position that this pass is deliberately outside CI is what
  makes affordable. Caveat: light theme only — the skin and the theme are
  separate attributes and this adds the skin axis, not a theme one.

## Not yet verified by hand

- **The ascii skin (2026-09-11) has been looked at narrowly.** Of 22 routes,
  eight were looked at for the tokens and four for the kit primitives, the
  rest load-asserted; only the dashboard at 1920 — the shell's own chrome has
  since been measured on four routes at 390 and 1280 in both themes, see the
  three 2026-09-13 entries above, but that is the toolbar and the source list
  and nothing a route draws under them; the live flip (task `d8e5f614`) was
  never driven. `smoke-pages` is no longer default-skin only — see the
  2026-09-14 entry above — but what it adds is four load assertions per route,
  not a look. No second browser (where `█` measures 0.602em), touch, zoom or
  screen reader.

- **Open under the ascii skin, 2026-09-11.** Findings stay on the board —
  `New run` clipped off at 390px is no longer among them, see the 2026-09-12
  measurement above; `ListView`'s real borders still mismatch at 1920, where
  dark was not re-measured. The
  in-flight marks were seen in Chromium, dark, 1280px only; the charts ran on
  intercepted responses, `RunConflictMap` only empty; the meter fit was
  exercised at one glyph advance.

- **The ascii head-rule and sparkline fixes were checked on scratch pages**:
  `/account`'s table did not render (no transcript data) and run `d02b9e40`
  was never loaded, so neither reviewer's own page has been seen fixed.

- **The reported half of the ascii bar defect — a band or track drawing wider
  per character than the fill *inside* one bar — was never reproduced.** The `╳`
  half was (see the Verified entry of 2026-09-12), and the pin that fixes it
  covers both by construction, but no face installed in this container answers
  `█`, `▒` and `░` at three different widths, so nothing here has drawn the bar
  the operator described. What would settle it is the operator's own browser,
  or a face that splits the shade blocks from the full one; the reading itself
  is one page:
  ```bash
  node -e '(async()=>{const{chromium}=require("/usr/local/lib/node_modules/playwright");
  const b=await chromium.launch(),p=await b.newPage();
  await p.setContent(`<span id=s style="font:13px/1 var(--family-mono,ui-monospace,monospace);white-space:pre"></span>`);
  for(const g of ["\u2588","\u2592","\u2591","\u2573","["])
    console.log(g, await p.evaluate(x=>{const e=document.getElementById("s");
      e.textContent=x.repeat(16);return e.getBoundingClientRect().width/16},g));
  await b.close()})()'
  ```
  Three different numbers across the first three is the unreproduced half.
