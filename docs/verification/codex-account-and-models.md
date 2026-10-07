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

## Not yet verified by hand

- **The deployed pages (2026-10-07).** The Codex section of the dashboard's
  window card, the Codex fold and default under Settings → Runs, and the Codex
  picker on the run form are typechecked and unit tested, not yet seen in a
  browser against this build. Settles with a rebuild and one look at each, in
  both skins and at 390px — `npm run smoke-pages` covers the load half.

- **A window that is not empty.** Every reading so far was 0%; a reading above
  0, one over 100% and a `rateLimitReachedType` have only been parsed from
  hand-edited payloads. Settles with readings taken during and after a few
  Codex work cycles, compared against the CLI's own `/status`.

- **A Codex run parked or stopped by a fraction guard.** `codexGuardSnapshot`
  feeds Codex's windows to every guard site, and that is unit tested only
  through its parts. Settles with a Codex run under a session guard below the
  current reading: refused at the door if unreadable, stopped or parked with
  Codex's reset as the resume instant otherwise.
