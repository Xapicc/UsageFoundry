# Verification: Interface — pages, panels and API payloads

[← Verification index](../verification.md)

## Verified

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

- **The run inspector's polish pass, 2026-09-27**, standalone server, Chromium
  at **1920x963 DPR 2 and 390x844 DPR 2**, both skins, both themes, 48 page loads
  per build. Six run rows (completed with a board task and a checkout, running,
  paused, queued, `needs-review` with a 42-character Bedrock model id, and a
  failed, set-aside Codex run) were served by intercepting `GET /api/runs/<id>`
  over one run seeded through the API, so both builds read identical rows;
  before is `35b8164`, after `da450be`. Before, under the ascii skin at 1920:
  the card was its own scroll container and its frame box (1559.5 to 1906.5)
  lay round a padding box of 1567 to 1899, so no edge of the frame drew; the
  3px state edge was transparent; and the long id ran to x=1887 against a
  content edge of 1883, over its own label. In both skins every region led by
  a `Section` drew two hairlines round its heading, and the headline sat 12px
  above its detail against 4px between every other header line. After: the
  scroll box is exactly the card's padding box (332x877), the frame box is
  unchanged and does not move when the box is scrolled to its end, the left
  edge's six device columns read the tone at every column (the frame's stroke
  used to grey two of them), and every state's scroll height is 58px shorter,
  which is the 8px headline gap and 25px from each of the two regions and
  nothing else. No console error in any of the 96 loads, and no content past
  the card's edge in any of the after build's 48. Gate on `da450be`: `npm run typecheck` exit 0; `npm test`
  **3033 tests, 3033 pass**, exit 0, beside the `sandboxMountPoints` suite
  that throws during construction against CLI 2.1.280 (already on the board);
  `npm run smoke-pages` against `.next/standalone/server.js`, **92/92**. Shots
  and both probes' readings are in `scratch/run-inspector-polish/`. Caveat: one
  engine, and the run rows are crafted rather than written by the
  orchestrator, so a field combination no real run reaches may be among them.

- **The run inspector's cap against the window, 2026-09-27**, standalone
  server, Chromium at **1920x963 and 1280x800, DPR 2**, both skins, two seeded
  runs (a 30-line prompt and a one-line one; both inspectors outgrow any cap
  here), each on the log tab and with a 2400px block appended to the pane
  column to stand in for a long tab. `getBoundingClientRect()` read after load
  without scrolling, then with the pane scrolled to where the card sticks,
  then at the foot. Before is `887670b`, after `3a50d6a`. Before, standard skin:
  card 161 to 1040 at 1920x963 and 161 to 877 at 1280x800, so **77px** below
  the window at both; the log tab scrolled 125px for nothing but that; at the
  foot of every scroll the card's top was at y=36 against a pane edge at 52.
  Before, ascii: computed `position` **relative, not sticky**, the card 16px
  below its own split (177 on a split at 161), so **93px** below the window
  and the frame 99.5px, and on a long tab it scrolled off with the page. After,
  both skins alike, `--split-top` 109px: card 161 to 915 at 1920x963 and 161 to
  752 at 1280x800, ascii frame bottom 921.5 and 758.5; the log tab scrolls
  0px; on a long tab the card sticks at 68 and stays there to the foot of the
  scroll. What it cost: stuck on a long tab the card keeps its load height,
  754px where it had 879 (591 where it had 716), so 141px stand empty below
  it. Gate on `3a50d6a`: `npm run typecheck` exit 0; `npm test` **3033 pass,
  0 fail**; `npm run smoke-pages` against `.next/standalone/server.js`,
  **92/92**. A lede lengthened in the DOM and then rewrapped to three lines by
  a resize to 1100px (ascii) re-measured to 128.5px, and the card still ended
  at 915 with the log tab at 0px of scroll. Caveat: one engine; below `lg`
  nothing was measured before and after, and is claimed unchanged only because
  both edits apply above it; a notice appearing above the split was reasoned
  about and not seen.

- **`/runs/live` in a browser over seeded rows, 2026-10-01**, the standalone
  bundle built from `92d07a1`, headless Chromium at 390x900 and 1280x900,
  standard skin, a scratch `DATA_DIR`. Empty: the strip read 0 running, 0
  queued, 0 paused over "Nothing is running. Back to runs". Then three running
  runs (events in `run_events`, context samples on two, two `otlp_requests` rows
  on one), one queued and one paused were written into the table after boot,
  and the page reloaded: three tiles, and every load at both widths requested
  exactly one `/stream` URL, `/api/runs/live/stream`, and no
  `/api/runs/[id]/stream`. No console error; `scrollWidth - clientWidth` 0 on
  the document and on `main` at both widths. The run with telemetry read $0.78
  beside $1.84 spent and the two without read "— none reported this cycle"; the
  run with two granted cycles read "work cycle 3 of 7 (2 granted)"; a tile's
  context figure matched that run's own page (41.2k, same derivation). With no
  reload, one running run was set `completed` and the queued one `running` by
  another process writing the table, and the tiles went from 1111/2222/3333 to
  1111/3333/4444 inside 17 seconds, which is the stream's 15-second reconcile.
  Caveat: events another process writes never reach this server's bus, so live
  forwarding and the join a `status` event triggers were exercised only in
  `src/app/api/runs/live/stream/route.test.ts`, never in a browser.

- **`npm run smoke-pages` 96/96 with `/runs/live` in the list, 2026-10-01**,
  against `.next/standalone/server.js` built from the same tree: 24 pages, two
  skins, 390 and 1280. `npm run typecheck` exit 0; `npm test` 3612 tests, the
  one failure the rendering-test count in `docs/agent/testing.md`, which the
  docs change that followed corrected.

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

- **The runs list and ⌘K search have never been driven in a browser.** Open:
  paging without repeats, Failed over the whole history, debounced search, the
  24-hour boundary (one fold request a minute), old runs in ⌘K.
  `/api/runs?status=nope` should answer `Unknown run status: nope`.

- **The run log's filter has never been rendered, and the settings field
  search only for the one query the model-list rail entry above names.** They
  rest on six unit cases (`matchesLogFilter`, `logFilterActive`) and the build;
  the settings search has no unit test, as it reads `textContent`. Open: counts
  and truncation hint, Jump to live, results opening closed Prompts folds, the
  unsaved dialog, 390×844.

- **The run log's background-task panel (`RunTasks.tsx`) has never been
  rendered.** Only its reducer is tested (18 cases in `runTasks.test.ts`). Open
  it on run `eadfe9f2-ac96-4c44-b59a-fbb3c9341871`, which has real
  `system:task_*` events; the empty, cut-replay, stopped-task and 390×844 states
  are unchecked.

- **The band picker has not run under `docker compose up --build` or drawn a
  real winnow tree (2026-09-04).** Labels and repeats were seeded, the shortfall
  sentence has not met a dropped tail, `aria-live` is unheard, and no new
  reading has arrived under an open region. Settle: hold a region open on a
  growing pruning run until a reading lands; rows swap, region and age hold.

- **The dashboard's top row has not been seen as the real page**, with
  transcripts behind it: its composition, the ragged bottom edge under
  `items-start` at 1920 and the `lg`-to-`xl` band with content are unlooked-at.
  Open `/` at 1920 and about 1100 with a run in flight.

- **The live-telemetry card has not been seen in the real row (2026-09-04)**:
  its bottom edge beside the 16rem tile, and the phone case with a six-run list
  between the meters and everything below. Open `/` at 1920 and about 390 with
  a run in flight.

- **The composition stack's hatched overflow strip has not been drawn at
  390px.** It sits in the same `viewBox` as the bands, which is an argument,
  not a measurement.

- **`/runs/live` has never watched a real run.** Open: a line arriving on a
  tile as the agent writes it, a run's tile appearing within a second of it
  starting rather than at the next 15-second reconcile, `RunActivity`'s open
  calls on a tile, and the tail staying put while the reader is scrolled up.
  Settles it: `docker compose up --build`, start two runs, open `/runs/live`.

- **`/runs/live`'s reconnect has never been seen in a browser.** The fold that
  replaces each tail on a reconnect is unit-tested (`liveTiles.test.ts`); a
  real `EventSource` retrying through a server restart, a proxy's idle cut or
  an HTTP/2 terminator has not been watched. Settles it: open the page over two
  running runs and `docker compose restart`, then count each tile's lines.

