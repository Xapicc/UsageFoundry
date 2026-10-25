# Verification: Interface — the graph canvases, touched map and replay

[← Verification index](../verification.md)

## Verified

- **Touched map (`/runs/[id]/touched`) rendered 2026-09-02, on a seeded run
  only.** 399 tool events over 48 distinct files, none real: it renders, settles
  and stops, and clusters by directory legibly at 1440×1000 in both themes.
  Headless layout (nothing on colour or labels) settles at 250 frames against a
  2,000 cap and separates clusters 3.6× on a reconstruction of the measured run.

- **Touch replay scrubber driven 2026-09-02, on the same seeded run only.** 399
  touches over 48 distinct files; the sequence route answers 50 KB beside the
  collapsed scan's 47 KB. Playwright at 1440×1000: space played 121→170 in 2.5 s
  (the `TARGET_SECONDS` rate), pause held, Reset cleared, the wash read in both
  themes. `touchReplay.test.ts` covers the fold cases.

- **`/knowledge` keeps its framing across a live skin flip and a live theme
  flip, 2026-09-12** (`npm run build` then the standalone bundle, seeded
  `DATA_DIR`, a four-note scratch vault, Playwright 1.62.1 over Chromium at
  1280; no container). Measured as node-disc ink by pixel count — every pixel
  whose whole 5x5 neighbourhood is opaque, which drops hairline links and
  11px labels — plus the 2D context's own transform read back after the frame.
  Untouched, the graph settles at k=5.874 and both flips leave it at 5.874,
  bbox 642x919 either side and the same after a reload. A deliberate pan
  (k=5.884 at 429,474) and a deliberate wheel zoom (k=8.000 at 301,393)
  survive both flips unchanged, and a node held through the opening cooling
  freezes the framing at the grab. Before the fix the same run read k=1.000
  for the first 4.3 seconds and then 5.874 in one frame — the skin was never
  the trigger: with no interaction at all the jump lands at t=4.31s, and a
  flip at t=2s does not bring it forward. The caveat is that this is one
  four-node vault on one machine: the cooling curve is `ALPHA_DECAY`'s ~250
  frames whatever the vault, but how far the framing travels over them is not.

- **Both graph canvases now keep their framing across a live skin flip, a live
  theme flip and a window resize, 2026-09-13/14** (`a5694e4`; `npm run build` then
  the standalone bundle, seeded `DATA_DIR`, a scratch vault and a run whose tool
  events were written straight into `run_events`, Playwright over Chromium at
  1280x900, dpr 1; no container). The same instrument as the entry above — disc
  ink as a 5x5 erosion of the opaque mask, plus the 2D context's transform read
  back after the frame — against a **reload in the target state** rather than
  against the pre-flip view, which is the comparison that caught the box change
  the earlier one could not see. `PathMapCanvas` carried the pre-fix shape: on a
  five-file map it held k=1.000 from load to t=4.0s and then 1.771 at t=4.6s, one
  frame, disc ink 94 to 911; it now opens at k=2.111 at t=300ms and falls
  monotonically to the same settled 1.771 by t=4.0s, with no step anywhere on the
  curve. On `/knowledge` a skin flip takes the graph card 662x974 to 662x1008,
  because the panel beside it is laid out from type — before, the flipped view
  kept k=4.898 where a load in ascii frames at 5.085 (0.963, and 18px off centre)
  and the other direction, which is the one that loses a band rather than gaining
  it, kept 5.085 in the shorter box and ran the graph to y=973 of a 974px canvas —
  pinned to the edge, against a reload ending at 967 with 7px to spare, which is
  the "a node is simply absent until reload" half of the report. After, each flip
  lands on the reload's k exactly, its disc ink to the pixel (4671 and 4273) and
  its bbox to the pixel. A window resize to 900 wide is the same defect on the
  other canvas: both kept k (1.434 and 1.771) in boxes that had gone 662x1055 to
  602x452 and 622x576 to 594x480, and the drawn graph ran off both; they now refit
  to 1.286 and 1.416 with nothing clipped. `touchedRef` still holds the line —
  widening 1100 to 1280, an untouched canvas re-frames (0.990 to 1.434, 1.218 to
  1.771) and one the pointer has panned keeps 0.990 and 1.218 through the same
  resize. So does the companion guard `PathMapCanvas` was missing, which only
  matters once the fit runs during the cooling: a node grabbed at t=600ms and
  dragged 270px took the camera from k=2.227 to 1.964 under the hand, and now
  holds 1.872 through the grab, the drag and the release. Caveats: one machine at
  dpr 1, three-note and five-file graphs, and a theme flip changes no box here, so
  what that axis proves is that nothing *else* moves the framing.

- **A map label centred on a node near the canvas edge is painted outside it,
  and clamping the anchor is what puts it back (2026-09-14).** Measured against
  `.next/standalone/server.js` in headless Chromium at 390px, dpr 2, in both
  themes and both skins, by wrapping `CanvasRenderingContext2D.prototype
  .fillText` and mapping every call through the live transform into the
  canvas's own backing store — painted overflow, which no box metric and no
  sideways-scroll check can see, and which `scripts/smoke-pages.mjs` therefore
  passes. The reproducing arrangement is four files across two directories:
  few enough nodes that the fit lands at `k` 1.004, above `FILE_LABEL_FROM`, so
  file names are drawn at all, and names long enough that half of one is wider
  than the 48px `FIT_PAD` leaves. Before: `workflows-and-schedules.md` painted
  21.2px past the left edge in the default skin and 23.4px under ascii, and
  `RunTaskComments.tsx` 7.2px and 4.2px past the right. After: worst overflow
  −2.0px in all four states, which is `LABEL_EDGE_PAD` exactly, with `k`, the
  label count and the twenty-four-file control arrangement's readings all
  unmoved to the tenth of a pixel — so the clamp moves only labels that were
  outside. Caveat: horizontal only. A label hangs about 14px below its node
  against the same 48px pad, so the bottom edge has never been reachable in a
  fitted view and is not clamped; the reading says nothing about a view the
  operator has panned.

- **A section that works in the folder throughout, drawn in the built editor
  2026-10-25 (branch `uf/usagefoundry-721638d11c0b-31-7aaf7aa7`, standalone build over a
  scratch `DATA_DIR`, Chromium at 1600×900, auth off).** A loop over two blocks on
  a template with `isolate: false` saved through `POST /api/workflows` (200), and
  the same section with the second block on the default guards, which isolate,
  was refused 400 with the mixed-section sentence naming “Block a”. The edit page
  marked the entry *starts a pass* and the exit *ends the pass*, the loop's panel
  read "Every pass works in the folder itself and ends at Block b, and the next
  pass starts from what it left", and its member list marked Block b *ends the
  pass*. Seeded over HTTP, not drawn by hand: a link gesture, a template change
  on a drawn block and a switch of the settings default were not exercised in the
  browser, and no section has been run end to end by a real agent.

- **A landing section that ends in the folder, drawn in the built editor
  2026-10-25 (branch `uf/usagefoundry-721638d11c0b-32`, standalone build over a
  scratch `DATA_DIR`, Chromium at 2200×1000 and 390×900, bearer auth).** The
  operator's shape — an orchestrator (fan-out 10, a template that isolates), a
  merge block, and a run on a template that does not — saved through
  `POST /api/workflows` (200). The frame marked the entry *starts a pass · up to
  10*, the merge *lands the branches · merge* and the run *ends the pass*; the
  loop's panel read "Every pass lands its branches through Merge branches, then
  works in the folder itself and ends at Bughunt new code" and priced it "up to
  60 runs" (5 passes of 12); its member list marked the merge *lands the
  branches* and the run *ends the pass*; the run's inspector said "Works
  directly in the folder" under Guards and the orchestrator's "The runs it
  starts work in a checkout of their own"; at 390px the list marked the same
  two; no console error. The same graph over the real routes: the run on the
  default guards was refused 400 naming "it names no template, and the default
  guards in Settings isolate", on a template that isolates "its template
  “Isolated” isolates", and the merge-to-run link set to *either way* was
  refused 400 with the folder-mid-merge sentence. Seeded over HTTP, not drawn by
  hand.

- **How the editor reads an in-folder loop, a tail with two ends and gate-fed
  merges, in the built editor 2026-10-25 (branch
  `uf/usagefoundry-721638d11c0b-12` at `f3ab0853`, standalone build over a
  scratch `DATA_DIR`, Chromium at 1600×1000 and 2400×1000, default skin, bearer
  auth; the 2400px frames are in `scratch/loop-section-readings/`).** Three
  graphs seeded over `POST /api/workflows`, the loop's frame pressed, no console
  error on any. *An in-folder loop* (`a -> b`, both on a template with
  `isolate: false`) saved (200); the frame's label read "starting at Block a,
  ending at Block b" and not "landing through", the loop's panel "Every pass works
  in the folder itself and ends at Block b, and the next pass starts from what it
  left", the card *ends the pass* and the member list *ends the pass*. *A tail
  with two ends* (`o -> m`, `m -> b`, `m -> c`) was refused 400 by
  `POST /api/workflows` ("repeats ends in 2 places: “Block b”, “Block c”"), so
  the editor was handed it by intercepting `GET /api/workflows/<id>` over the
  saved `o -> m -> b`: the frame's label read "The pass ends in more than one
  place" and the panel, in the danger tone, "The section ends in more than one
  place, so a pass has no single end" — where it said "No merge block" over a
  graph with one — while the merge still read *lands the branches* and the
  editor's own validation printed the server's refusal under the canvas. *Merges
  fed through gates* (`e` fans out to `o1` and `o2`, `o1 -> m1 -> g1 -> f`,
  `o2 -> m2 -> g2 -> f`) saved (200); the panel read "Every pass lands its
  branches through Merge m1, Merge m2, then works in the folder itself and ends at
  Block f" and priced it "up to 27 runs", both merge cards read *lands the
  branches · merge* and the member list marked both merges and the end. Caveat: the
  readings are of the fixed tree only — no browser was pointed at `5ba27e95` for a
  before — and the Put in gesture over a tailed or merge-ended section was not
  pressed, only asserted against the server's normalizer in
  `canvasGraph.test.ts`; 390px, the dark and the ASCII skins were not looked at.

## Not yet verified by hand

- **The tail's editor gestures are untried by hand.** Open: that drawing a link
  from the merge into a tail block, a template change on a drawn block (the
  inspector's "Works in …" line should follow it) and a change of the settings
  default all behave, and that the line reads right in the 390px inspector. The
  pure half is checked against the server's normalizer in `canvasGraph.test.ts`.
  To settle it: open the saved tail workflow in `/workflows/<id>/edit` and do
  each.

- **Nothing has run a landing section's tail under a real agent, and the failed
  merge that leaves a folder mid-merge was read from `unwind`, not produced.**
  The ordering the tail rests on is held against the real merge queue in
  `loopMergeOwnership.test.ts`; a conflict that `merge --abort` cannot undo has
  not been reproduced, which is why an `on-finish` link into the tail is refused
  rather than allowed.


- **Put in over a section that ends in a tail is untried by hand.** Open: that
  pressing Put in on a frame of `o -> m -> b` and then a block that isolates puts
  it beside the section into the merge, that a block that works in the folder
  lands after `b`, and that Save accepts both. The pure half is checked in
  `canvasGraph.test.ts` through `normalizeWorkflowInput`. To settle it: open a
  saved tailed section in `/workflows/<id>/edit` on a build over a scratch
  `DATA_DIR`, draw each, and press Save.

- **The touched map has never been looked at on a real run.** Its 300-file fold
  has never fired on real data, and none of the hand checks is done: CPU idle
  and reduced motion, the node legend, labels, gestures, one-cycle, swept and
  no-diff states, folding, theme switching, 390px.

- **Touch replay has never been scrubbed on a real run.** Open: whether the halo
  is findable in motion, whether the wash reads as progress or noise, whether
  `TARGET_SECONDS = 20` (chosen by reasoning, not watching) suits a real run's
  length, and that space neither double-toggles Play nor scrolls the page.

- **The editor's gestures over a section that works in the folder are untried by
  hand.** Open: that drawing a link out of a flat block inside the frame, Put in
  and Take out all save without the server refusing a branch, that switching a
  drawn block's template to a flat one clears its link's branch, and that the
  frame's label flips from *lands* to *ends* when the settings default changes
  (it is read once, from the settings the editor already fetches, and assumed
  isolating until they answer). The pure half is checked against the server's own
  normalizer in `canvasGraph.test.ts`. To settle it: open a saved flat section in
  `/workflows/<id>/edit` on a build over a scratch `DATA_DIR`, draw each gesture,
  and press Save.

- **No in-folder section has run under a real agent.** Two passes were driven
  through the scheduler with stub runs in `loopSection.test.ts`; whether a real
  cycle that edits the folder in place settles a pass the same way, and whether
  pass 2's agent reads what pass 1 left, has not been watched. To settle it: save
  a two-pass section of one flat block against a scratch repository with a
  throwaway budget and read the folder between passes.
