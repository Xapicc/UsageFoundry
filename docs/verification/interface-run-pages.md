# Verification: Interface — the runs list, the run inspector and `/runs/live`

[← Verification index](../verification.md)

The runs list and its Fleet card, the run page (its inspector, its Agent work,
granted cycles and the reopen form) and `/runs/live`. Every other page, the
panels and the API payloads are in
[interface-pages-and-api.md](interface-pages-and-api.md).

## Verified

- **The Fleet card follows `/api/fleet` without a reload, 2026-10-17**, the
  standalone bundle built from `ea41bda8`, a throwaway `DATA_DIR`, a
  `CLAUDE_BIN` that cannot spawn, headless Chromium at 1280. `/runs` on an
  empty install read "Nothing is in flight." with Stop everything disabled and
  no badge. A second client then posted `{"action":"pause"}`, and "new work
  held" appeared 4,015 ms later. A `queued` row inserted into SQLite was in
  `/api/fleet`'s counts at once (held, so nothing promoted it), and the card read
  "1 queued." with Stop everything enabled 4,043 ms later, after three
  `GET /api/fleet`s. A second bundle from the same tree with
  `FleetControls.tsx` at `773c89a9`, before the poll, failed both waits at
  12 s: one read at mount, and still "Nothing is in flight." No console error
  on either. Caveat: the run was inserted, not started, so no run that went
  `running` through the loop was watched. That a poll answer landing after a
  press's own is discarded was read from source, not raced.

- **The pick-up sheet pressed in a browser, 2026-10-17**, the bundle above
  rebuilt at the same commit, with two `stopped` rows (limit 5, `iterations` 1
  and 2, `spent_usd` 1.00) under the hold. The sheet opened with "More work
  cycles" at 1. With a spending limit of 0.5 typed, the press was refused
  whole, and the card read "None of those 2 runs could be picked up.
  aaaaaaaa: This run has already spent $1.00. … bbbbbbbb: …", naming both runs.
  Pressed again with the spending field cleared, it read "Picked up 2 runs."
  Both rows were `queued`, with stored caps of 2 and 3. The one console error was
  that refused press's 400. `npm run smoke-pages` 100/100 against this bundle.
  Caveat: neither row had a granted cycle; that arithmetic is
  `fleet.test.ts`'s.

- **An untouched pick-up sheet keeps each run's spending limit, and its inputs are named, 2026-10-25**,
  the standalone bundle built from `1fd87a73`, a throwaway `DATA_DIR`, a
  `CLAUDE_BIN` that cannot spawn, new work held, headless Chromium at 1280, two
  `stopped` rows (one stored with `maxRunCostUSD` 5, one with none). In the open
  dialog `getByLabel(/More work cycles/)`, `getByLabel(/Spending limit/)` and
  `getByLabel(/Remove each run's spending limit/)` each resolved to one control
  (the first holding `1`, the third `role="switch"` with `aria-checked` false),
  and a click on the first label focused its input. Pressed with nothing
  touched, `POST /api/fleet` carried `"budget":{"moreIterations":1}` and the
  limited row's stored `maxRunCostUSD` was still 5. With 8 typed and the switch
  turned on, the spending field was disabled, the body carried
  `"maxRunCostUSD":null` and both rows read `null`. Switched on, then Cancel,
  then reopened: the switch read off. `npm run smoke-pages` 100/100 against this
  bundle. Caveat: the typed-number press (a limit of 8 set on every run) was
  asserted by `fleet.test.ts`, not driven in the browser.

- **A local run's Agent work section is a sentence, 2026-10-17**, the first
  bundle and install. A `completed` local run, with a `session_id` and
  `spent_tokens` 4321, was inserted into SQLite. `GET
  /api/runs/<id>/agent-cost` answered `{"spend":null,"reason":"A local run's
  turns are written under its own config directory, which this reading does
  not look in."}`. `/runs/<id>` drew "Not split for a local run: … It has used
  4.3k tokens over its finished work cycles.", and "No turns were recorded"
  appeared nowhere. Caveat: no local transcript existed in that install, so the
  page was not seen for a real local session.

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

- **A full `/runs/live` tile stays on its tail with the pointer on its log,
  and holds a reader who scrolled up, 2026-10-01**, against
  `.next/standalone/server.js` at `c6ddfdd` and at its parent, in Chromium at
  1280px. An init script replaced the page's `EventSource` and fed four tiles a
  50-event join, then 60 batches of 1-3 events 100-700ms apart. Before, with
  the pointer resting on the log, the tile ended 1,699px behind the tail at 1x
  and 4x, and 27 of about 30 scroll events read a gap of 40px or more. After,
  0 of about 1,600 sampled frames were off the tail at 1x and 4x CPU throttle,
  with and without the pointer. Wheeled up 160px, a row mid-log held within 1px over 8 batches
  in both builds and wheeling down resumed the follow; with `overflow-anchor:
  none` injected the same row slid 811px and the gap hit 0 within three
  batches. Caveat: the stream was fake, so real network timing and the 390px
  tile were not exercised.

- **Granted cycles on the runs list, the instance page and the in-flight line,
  2026-10-01**, the standalone bundle built from `46c424e` plus this change,
  headless Chromium at 390 and 1280. `/api/runs`, `/api/runs/[id]` and the
  instance route were answered by the real server over a seeded run and a
  one-block workflow, edited per case with `route.fulfill`, and read with
  `innerText`. A running run capped at 1 with one grant and `active_iteration`
  2 read `1/2` over "includes 1 granted" and "cycle 2 of 2 in flight" on
  `/runs` and on the instance page, and on its own page sat beside "includes 1
  granted by the check on its task"; a completed one that used both read `2/2`
  over "includes 1 granted". With no grant, `0/2` with "cycle 1 of 2 in
  flight", and `2/2` with no second line. No console error and no sideways
  scroll at either width; `npm run smoke-pages` 96/96 against the same bundle.
  Caveat: every grant was injected — the unedited answers carried the column,
  as 0, in all three payloads — so no run a check actually sent back was drawn.

- **The reopen form's work-cycle hint with a grant, 2026-10-01**, the same
  bundle and method. A completed run with `iterations` 2 and
  `validation_cycles` 1, after "Ask for more", read "Includes 1 of the 2 it has
  had; the 1 its task's check granted is added on top; blank means no cycle
  limit, which needs a time limit", over a field prefilled with its limit of
  1; with no grant, exactly "Includes the 2 it has had; blank means no cycle
  limit, which needs a time limit". Caveat: the hint was read and the form not
  submitted, so that typing 2 there buys one cycle is `reopenRun`'s arithmetic
  read from source rather than a pick-up driven in a browser.

## Not yet verified by hand

- **The Fleet card has not been watched under `docker compose up --build`.**
  Open: the card's count following a run that a schedule fires or the queue
  promotes into `running`, on the shipped image. The command that settles it:
  bring the image up, open `/runs` on an idle install, start a run from a
  second tab, and watch the card for 10 s without a reload.

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
