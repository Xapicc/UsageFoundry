# Verification: Codex usage windows and the Codex model list

[← Verification index](../verification.md)

## Verified

- **`codex app-server` answers both reads against a real ChatGPT sign-in,
  2026-10-07**, `codex-cli 0.153.4`, team plan, in the container as uid 1000:
  `initialize` in ~140 ms; `account/rateLimits/read` in ~700 ms with a `codex`
  bucket whose `primary` is `windowDurationMins` 300 and `secondary` 10,080,
  `usedPercent` 0 on both and `resetsAt` in **epoch seconds**; `model/list`
  with `includeHidden: true` in ~150 ms, seven models, `gpt-6-astra` marked
  `isDefault`, three `hidden` (`gpt-reserve`, `gpt-5.5`, `codex-auto-review`).
  The child exited 0 on stdin's EOF. `account/read` named the plan; the email
  it also returns is not kept anywhere.

- **`codexAccount.ts` reads both through the server's own spawn path,
  2026-10-07**, the compiled module run as root inside the live container so
  `childCredentials()` dropped the child to uid 1000: `codexUsage()` answered
  in 1,060 ms with both windows at 0 and `planType` `team`, a second call in
  0 ms from the cache, and `listCodexModels()` in 134 ms with the four visible
  models. No `codex app-server` process was left running, and no root-owned
  file appeared under `~/.codex` beyond the rules file the server writes on
  purpose.

- **A sign-in fills the Codex list, and the deployed routes answer, 2026-10-07**,
  `2507404a` in the container on a fresh `usagefoundry-codex` volume: the boot
  check recorded "Codex is not signed in"; after a ChatGPT sign-in from the
  Settings panel, the record held four models listed, four added and
  `gpt-6-astra` as the CLI default, with no `codexModelCatalogue` in the stored
  blob. `GET /api/usage` carried `codex.plan` with both windows (300 and 10,080
  minutes, 0%, plan `team`) in 915 ms; `GET /api/settings` returned the four as
  the list with none of the Codex keys reported as moved.

- **The doors and the pre-cycle guard read the Codex list and windows,
  2026-10-07**, same build: `POST /api/runs` refused a Codex run naming
  `claude-sonnet-5` and one naming `gpt-9-nope`, each with 400 and the
  sentence naming the Codex list; a Codex run with `maxSessionFraction` 0.95
  was admitted, and its pre-cycle `budget` event carried `sessionFraction` 0
  with `sessionPlanAgeMs` 130,734 — the Codex reading, not a transcript scan.

- **LocalDecider picks a Codex model per tier, 2026-10-07**, its `tiers.json`
  with the Codex families added, Tev1-4B Q8_0 on the host, handed the four
  enabled Codex ids: a README typo went to `gpt-5.6-luna` (mechanical_change,
  0.989), an endpoint with a test to `gpt-5.6-terra` (routine_engineering,
  0.995), and a race with no reproduction to `gpt-5.6-sol` (hard_engineering,
  0.998), nothing `unrecognised`; the container reached it on
  `host.docker.internal:8090`. Asked directly, not yet through a chat proposal
  or a block of the deployed app.

## Not yet verified by hand

- **The deployed pages have not been looked at (2026-10-07).** `npm run
  smoke-pages` loaded all 24 pages clean in both skins at both widths against
  this build, but with no Codex sign-in, so the dashboard's Codex section and
  the filled Codex picker were not drawn. Settles with one look at each on the
  live install, in both skins and at 390px.

- **A window that is not empty.** Every reading so far was 0%; a reading above
  0, one over 100% and a `rateLimitReachedType` have only been parsed from
  hand-edited payloads. Settles with readings taken during and after a few
  Codex work cycles, compared against the CLI's own `/status`.

- **No Codex run has been parked or stopped by a fraction guard.** The door
  and the pre-cycle guard are seen reading Codex's windows (above); a verdict
  over the line, the live ticker and `sweepPaused` resuming at Codex's reset
  are not. Settles with a Codex run under a session guard below the current
  reading, once the window reads above 0%.
