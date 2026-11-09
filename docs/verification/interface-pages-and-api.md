# Verification: Interface — pages, panels and API payloads

[← Verification index](../verification.md)

The runs list, the run inspector and `/runs/live` are in
[interface-run-pages.md](interface-run-pages.md).

## Verified

- **`npm run smoke-pages` draws `CodexWindows` and the live `LiveTelemetry`
  card on `/`, 2026-11-09.** A second visit to `/`, named `/ [codex + live
  telemetry]`, answers the page's `/api/usage` polls with the server's own
  response plus invented `codex` and `telemetry` keys (`page.route` on the
  pathname, `usageWithCodexAndLiveTelemetry` in the script) — a fixture rather
  than a staged credential, because `codexUsage()` needs a stub `codex
  app-server` on top of `auth.json`, and no run lives long enough under a
  `CLAUDE_BIN` that exits in milliseconds. Against the standalone bundle: 27
  visits, **108/108 clean**, exit 0, with the fixtured one clean at 390px and
  1280px in both skins. That it was *drawn*, not just clean, was read from a
  throwaway copy cut down to the two visits of `/` (not committed), which found
  the `Codex` title, two meters labelled *5-hour window used* and *Weekly window
  used*, the *1 working* badge, two run links and the "cheaper run is in the
  total above but not listed" line in all four combinations, and none of them
  on the plain visit; the 1280 standard, 390 standard and 1280 ascii screenshots
  were read (the 390 one at a 2600px viewport, since the shell scrolls inside
  its pane). The guard that the fixture was served is a harness check: with the
  route predicate broken to `/api/usagex`, all four fixtured visits failed with
  "usage fixture was never requested". **Caveat:** the figures are invented, so
  this is the page's drawing of a Codex plan and of one running run, not the
  server's reading of either; one plan (`plus`, no limit reached) and one
  working run are drawn, so the *limit reached* badge and a six-run list are
  still unseen at 390px. The text above was read by the uncommitted copy; the
  script still asserts about load and never about content.

- **`npm run smoke-pages` now opens every page file and draws `/`'s meters,
  2026-11-09.** Against the standalone bundle built in the worktree, the pass
  derived 26 pages from `src/app` and ran 104/104 loads clean at 390px and
  1280px in both skins, exit 0. A copy of the script cut down to `/` and logging
  the body text found "Session consumed" in `innerText` and `textContent` in all
  four combinations, no "Nothing to measure yet", three meters, and the headings
  *5-hour session*, *Trailing 7 days*, *What this app spent* and *This install,
  last 24 hours*; the 1280 standard screenshot read $0.14 over 3 turns for the
  session and $0.18 over 4 for the week, which is the four invented turns
  `seedTranscripts` writes (one 30 hours old, in its own session). In a scratch
  copy, a throwaway `src/app/zzprobe/[slug]/deeper/page.tsx` and
  `runs/[id]/extra/page.tsx` made the script exit 1 naming both routes before
  any build was read, and a throwaway static `aaprobe/page.tsx` raised the
  count to 27 and was requested (a 404, the build predating it). **Caveat:**
  `CodexWindows` is still not drawn — it needs a stored Codex sign-in — and no
  live-telemetry card appears in the screenshot, because no run is in flight
  (the seeded one fails in milliseconds), so that card's live state is still
  unseen by the pass. The check that `/` is not on `FirstRun` is an API
  precondition (`requireSeededUsage` reads `meta.entryCount`), not a text
  assertion, so the script still asserts about load and never about content; the
  text above was read by the cut-down copy, which is not committed.

- **The Settings `Tools` section, in a browser against the production bundle,
  2026-09-12.** A throwaway install seeded with
  `UF_PY_TOOLS="ruff==0.5.0|/workspace/winnow|cozempic>=1.8,<2"` and
  `UF_GH_EXTENSIONS="dlvhdr/gh-dash github/gh-copilot@v1.1.0"`, with a fake
  `ruff` on `PATH` outside the tool directory, drew all five readings the data
  could produce — `shadowed`, `unknown`, `broken` and two `failed` — each with
  its tone, the server's own sentence and the command underneath. The section
  carries `aria-labelledby="tools-heading"`, the page logged nothing at all to
  the console across two loads, and the document did not scroll sideways.

- **`npm run smoke-pages`, 44/44 clean with the Tools section populated,
  2026-09-12.** Playwright was installed and the pass run against
  `.next/standalone/server.js` — the artifact the container ships — over all 22
  pages at 390px and 1280px: a 200, no console error and no sideways scroll on
  every one. `serverEnv` now stages `UF_PY_TOOLS` and `UF_GH_EXTENSIONS`, for
  `seed`'s reason, so `/settings` draws three tool rows across two groups at
  both widths rather than one `Empty` line. Two fixes were needed to get there
  and both are in `scripts/smoke-pages.mjs`: the staging above, and
  `fs.realpathSync` around the sandbox root — on macOS `/var` is a symlink to
  `private/var`, so `POST /api/runs` refused the seed with *"Folder is outside
  the \"workspace\" mount"* and the pass died before a browser opened.
  **What it still does not cover:** `failing`, which needs a database carrying
  `run_events` rows of the right shape, the stacks group — whose receipts live
  at an absolute container path this pass has no way to populate — and any
  assertion about interaction, this pass being about load by decision.
  (`unverified` was drawn against the running container instead, on the day
  stacks shipped; see *Container and environment*.)

- **`installed`, composed against a real install's own history, 2026-09-12.**
  The one tool declared here, `Xapicc/gh-layer10`, resolves at
  `…/extensions/gh-layer10/gh-layer10` with the manifest's `tag: v0.1.0`, and
  the observed layer counts **996 calls and 4 failures over 30 days**. That is
  what caught the composition being wrong: keyed on `failures > 0` the row drew
  `failing`, a warn badge on a working tool, and with `failing` narrowed to
  `failures >= calls` the same numbers compose to `installed`. Measured by
  running the shipped matcher against `/data/usagefoundry.db` in the container,
  not by reading the page — **the running install is still serving the build
  before that fix.**

- **API payloads before the 2026-08-23 wire pass.** `GET /api/runs` 696,197
  bytes for 100 rows, 75.1% prompt text; `/api/runs/[id]` 591,574, of which
  582,469 an unread events array; `/api/knowledge/graph` 9,864,990;
  `/api/storage` 5.3–7.4 s warm for 585 bytes, 5,981 ms of it one serial
  `lstat` walk. An idle runs page pulled 10.5 MB a minute, uncompressed.

- **No app-router `/api` response was compressed, Next 15.5.23.** Handler
  headers are stored as arrays and `compression`'s `compressible()` rejects a
  non-string, reproduced with `DEBUG=compression`. Bodies under ~250 bytes
  grow under gzip; `gzipSync` blocks the loop 30.6 ms on the 8.8 MB graph, so
  the async form is used. Graph 8.8 MB → 488 KB on that morning's capture.

- **The orchestrator page fits the pane at `lg`, 2026-08-27.** `next dev`,
  seeded chat, Playwright's Chromium: pane overflow 0 at 1440×1080, 1440×700
  and 1024×700 (parent commit 3,180–5,024px); below `lg` identical to the
  parent. A 700px window with the read-only banner, disclosure and two error
  banners all open still runs 71px short.

- **`/knowledge`'s smoke failure was the harness fixture, 2026-09-08**: with
  no vault configured its API answered 409; `seedVault` (`66e71c0`) fixed it.
  One build at `3e59699`, 2026-09-09: 44/44 clean with it, 42/44 and exit 1
  with its call site removed; no host state reaches the pass.

- **Paged `/api/runs` query checked in SQLite, not a browser.** Seven planted
  rows check paging, the offset clamp, the `created_at`/`id` tiebreak and
  literal `%`/`_` in `q`; 13 unit cases. At 50,000 rows the poll's unfiltered
  first page takes 0.23ms and a `status` page at offset 20,000 7.8ms, with no
  new index.

- **The Context panel's band picker was operated in the built app,
  2026-09-04** (`npm start`, seeded `DATA_DIR`, Chromium over `/runs/<id>`; no
  container, no real winnow): 24 assertions pass, a legend row is 44px under
  `md`, and polling left an open region's rows byte-identical. `npm run dev`
  500s there on a Tailwind `EvalError`; use `npm run build && npm start`.

- **The dashboard's three-column top row was measured in headless Chromium**
  against the built stylesheet and a stand-in shell: from 1280 to 1920 the
  window card is 50.0% of the row and the tile 256px; at 1180 and 1024 it is
  two columns, as half of a 760px row leaves the middle track 85px.

- **The collapsed live-telemetry card fits its 533px cell, 2026-09-04**:
  rendered alone via `renderToStaticMarkup` in headless Chromium with six runs
  and the widest plausible figures, all five columns fit unwrapped; at 390px
  `Table stack` turns each run into a labelled block.

- **The model list's unsaved-edit rail on Settings, in a browser against the
  production bundle, 2026-10-01**, at `5b83423`: a scratch Playwright script
  over `.next/standalone/server.js` with a throwaway `DATA_DIR`, 1280px,
  default skin. Flipping one model switch lit the `EditedRail` on the "Models
  this install may use" summary, at the summary's own top and height and 12px
  into the gutter, with the fold open and shut; the summary carried the
  `sr-only` suffix, the save bar read "1 unsaved change, marked in the margin"
  and Check for models was disabled. Discard cleared all of it and restored the
  switch; a second flip then Save cleared it too, and after a reload the rail
  stayed off and `GET /api/settings` held the model disabled. The fold holds
  one `[data-setting-name]`, and searching that model's id read "1 field
  match". **Caveat:** only the switch was driven, not adding or removing a
  model, and 390px and the ascii skin rest on `npm run smoke-pages` (96/96),
  which asserts load and nothing about interaction.

- **The unsaved-edit rail on the six other Settings folds' summaries, in a
  browser against the production bundle, 2026-10-05**, at `d147cf1`: a scratch
  Playwright script over `.next/standalone/server.js` with a throwaway
  `DATA_DIR`, default skin, at 1280px and again at 390px. For each of the four
  prompt folds, "When a window turns over" and "Isolated runs", one edit made
  with the fold open (a textarea, the weekly-reset select, the copy-globs
  field) and the fold then shut left the rail lit on the summary — 2px wide, at
  the summary's own top and height, 12px into the gutter, 17px tall at 1280 and
  45px at 390 — with the `sr-only` suffix present, the save bar reading "1
  unsaved change, marked in the margin", and no rail or suffix before the edit.
  Discard cleared rail and suffix, restored the value and the bar's "Everything
  here is saved"; a second edit then Save cleared both, and `GET
  /api/settings` held the stored value. An open prompt fold drew its summary
  rail and its field rail in one gutter column, with the 8px between label and
  box showing as a gap; the two multi-setting summaries hold no
  `[data-setting-name]`. 138 of 138 assertions held and the console stayed
  clean. **Caveat:** Save was driven at 1280px only (390px stopped at Discard),
  one setting per fold, and the ascii skin and the field search over the new
  summaries rest on `npm run smoke-pages` (96/96) and on the mark count above,
  not on a search typed in the page.

- **`/` fits 1280×800 in the common state, 2026-11-08** (branch
  `uf/usagefoundry-721638d11c0b-1-7bda2526`, after `5d53ab75`). The built
  standalone server was run over a scratch install in headless Chromium, with
  `GET /api/usage` answered by a patched copy of its own response. The common
  state had both windows on the provider's reading, a run working, one Codex
  sign-in and no notice. `main`'s content ended 27px above its 748px viewport,
  counting the 48px bottom padding. The same layout with no run working left
  19px; with no telemetry and a trailing week, 157px. It overflowed by 18px
  with the fleet-held notice and a per-model wall line showing. Nothing ran
  sideways at 1280 or 390, and the console was clean. **Caveat:** the data was
  mocked, not read from transcripts, and only 1280 and 390 were measured.

- **`/` carries the waiting line and still fits 1280×800, 2026-11-08**
  (branch `uf/usagefoundry-721638d11c0b-1-7bda2526`, after `13abb5a4`). The
  previous entry's harness, run again over the built standalone server: with
  the line showing "Nothing is waiting on you.", five counts, three counts with
  one unknown and one floor of zero, and a 500 from `/api/waiting`, `main`
  ended 3px above its 748px viewport at 1280×800 with a run working and with
  none. The line alone overflowed it by 17px (a 20px line and 16px below it
  against the 19px the page had, derived from that overflow); the grid's foot
  margin applying only while a notice follows it, and 12px under the line,
  brought it back. Nothing ran sideways at 390 or 1280. The only console error
  was the browser's note of the injected 500. Separately, the real route over a
  scratch database seeded with two `needs-review` runs, one recent failure,
  two pending proposals, three open operator-only tasks and one branch a commit
  ahead of its target answered 2, 1, 1, 2 and 3, and the page drew all five as
  links to `/runs`, `/runs`, `/branches`, `/chat` and `/tasks`; 70 branches in
  one scratch repository answered a floor of 60, in about 50ms a call, the same
  as `/api/branches` over that repository. **Caveat:** the usage figures were
  mocked as before; only 1280 and 390 were measured; no one has looked at the
  page in their own browser; and that repository was tiny, so the 50ms says
  nothing about the install's real checkouts.

## Not yet verified by hand

- **No after-change payload from the 2026-08-23 pass has been read from a
  server.** The "after" sizes (graph 734,233 bytes, workflow list 471) are
  re-serialisations of the one baseline capture, and the readings of the
  sixteen changes, made in parallel against it, do not compose.

- **The orchestrator's `lg` layout has not been seen in a container,
  2026-08-27.** Docker was unavailable: the CSS rests on a clean `npm run
  build` and a grep of the emitted classes. The error banners were injected
  into the DOM, not produced by a failing poll.

- **The four frontend reachability fixes have never been rendered.** Paged runs
  list, quick-open search, run-log filter and settings search, ~900 lines of
  page code on `uf/usagefoundry-721638d11c0b-1-41e5e190`, rest on typecheck,
  `npm test` (1,660 tests / 245 suites / 0 failures) and the build at `a34e56b`.
  No page tests, jsdom or CI browser.

- **The dashboard's top row has not been seen over real transcripts.** Its
  composition at 1280 and 390 was measured over a mocked `/api/usage` (above).
  Still unseen: 1920 and the `lg`-to-`xl` band with real figures, and a real
  run's telemetry switching between the card and the idle line. Open `/` at
  1920 and about 1100 with a run in flight.

- **The live-telemetry card has not been seen in the real row (2026-09-04)**:
  its bottom edge beside the 16rem tile, and the phone case with a six-run list
  between the meters and everything below. Open `/` at 1920 and about 390 with
  a run in flight.

- **`GET /api/waiting`'s branch read has not been timed on this install's own
  repositories.** It is `branchInventory` without the checkout probes — one
  `rev-list` per branch up to the first 60, plus a `worktree list` and two
  `for-each-ref`s per repository — polled every 60s with a run working and 120s
  otherwise, and only a scratch repository has been measured (about 50ms).
  Settle it with `time curl -s -H "authorization: Bearer $UF_AUTH_TOKEN"
  http://127.0.0.1:3000/api/waiting` on the running container, once with the
  dashboard closed.
