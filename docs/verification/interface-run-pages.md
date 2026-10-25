# Verification: Interface — the runs list's Fleet card and the run page's Agent work

[← Verification index](../verification.md)

A file of its own because `interface-pages-and-api.md`, where these would
otherwise go, is already past the 20 KB line.

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

## Not yet verified by hand

- **The Fleet card has not been watched under `docker compose up --build`.**
  Open: the card's count following a run that a schedule fires or the queue
  promotes into `running`, on the shipped image. The command that settles it:
  bring the image up, open `/runs` on an idle install, start a run from a
  second tab, and watch the card for 10 s without a reload.
