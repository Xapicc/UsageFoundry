# QoL hunt 5/5: usage and dashboard, settings, knowledge and dreaming, the app shell

At `fee5efb`. Work in progress — the paragraph on what was read, run and not reached is written last.

## Items

### U-1 Project exhaustion from Anthropic's own reading on a stock install
- **Friction**: on an install with no typed ceiling — the stock case, since `DEFAULTS` carries none (`docs/agent/metering.md`, "Unknown must not render as zero") — the dashboard's *Projected exhaustion* row says "Needs a configured ceiling" (`src/app/page.tsx:1027-1028`) directly under two meters that are already showing the provider's percentage. The operator deciding whether to start work now gets the reading but not the "when do I run out" that goes with it. The row is gated on `noConfiguredCeilings` (`src/app/page.tsx:559-566`), whose comment gives the reason: the projection "extrapolates dollars and tokens per hour", so it "stays unavailable on a provider reading alone".
- **Change**: that reasoning no longer holds. The dollar rate a provider percentage implies is already computed: `planFractionCarriedForward` converts spend since the fetch at `$ at fetch / percent` (`src/lib/windows.ts:~814-828`). Give `etaFor` (`src/lib/windows.ts:1152-1183`) a candidate per window whose figure is the provider's: remaining = (1 − guardFraction) × ($ at fetch / planFraction), at `burnCostPerHour` (`:1129-1133`), bounded by the existing horizon drop (`:1159-1164`). The page row then needs only its gate changed. This is the stock-install half of the bug filed as `8b47ae9a` (the projection uses the typed ceiling when both exist); one run can do both.
- **Size**: M.
- **Touches**: `metering.md` — the percentage must never reach `costUSD`; no candidate when `planFraction <= 0` or spend at fetch is 0; model-scoped walls excluded (an Opus-only percentage against all-model spend is the mixed-denominator error the carry-forward already refuses); a candidate past its window's reset is dropped, not clamped. It errs early rather than late, because the provider's percentage also counts Desktop and web use that is not on this disk — the safe direction.
- **Value**: high — it is the "when do I run out" answer, and every stock install currently has none.
- **Not worth it if**: the implied rate swings too much between 5-minute readings to extrapolate. Not measured; `docs/verification.md` has a derived-boundary item but no implied-rate stability reading.

### U-2 Say "no window open" instead of a 5-hour countdown that moves with the clock
- **Friction**: when no block is open, `buildSnapshot` reports the window the next turn would open, starting at `now` (`src/lib/windows.ts:985-994`, deliberately — "anything earlier would claim a window is already part-spent"). The card still leads with "Resets in 5h 0m" and a clock time (`src/app/page.tsx:708-722`), which is recomputed on every poll. The best possible answer to "is now a good time to start?" — nothing is open, the full allowance is there — reads as a running clock that never gets closer.
- **Change**: when `s.session.startsAt === s.now` and there is no current provider session reading, lead with "No window open — the next turn starts one" and keep the hypothetical end as the sub-line. Presentation only; the snapshot is unchanged.
- **Size**: S.
- **Touches**: `metering.md` "A block opens at its first turn" — no rounding, no new idle-gap rule. Must make no "empty" claim when the provider's session reading is current, because that reading counts use from other surfaces.
- **Value**: medium — it is the first line of the first card, read every time the operator decides whether to start.
- **Not worth it if**: an operator uses the hypothetical end time as a planning figure. It stays on the sub-line.

### U-3 Show each per-model weekly wall's own reset
- **Friction**: the per-model line prints only a label and a percentage (`src/app/page.tsx:852-861`), so an operator at an Opus wall cannot see when Opus comes back without going to claude.ai.
- **Change**: `PlanWindowDTO.resetsAt` already carries the instant (`src/lib/apiTypes.ts:62-65`) and `parsePlanUsage` fills it for `limits[]` entries (`src/lib/planUsage.ts:173`). Render it beside each wall with `fmtRelative`/`fmtDateTime`, as the window card does for its own reset.
- **Size**: S.
- **Touches**: render only walls the snapshot still considers current, which is the bug filed as `9202c8f2`. No tooltip carries it (`conventions.md`).
- **Value**: medium on accounts that hit a model wall, which is the account the weekly guard's wall handling was written for.
- **Not worth it if**: real payloads leave `resets_at` empty on `limits[]` entries. Assumed filled; not checked against a live reading.

### U-4 Refetch the provider reading once an instant it named has passed
- **Friction**: `planUsage()`'s freshness test is age only (`src/lib/planUsage.ts:235`, `REFRESH_MS` 5 min). For up to five minutes after every rollover, `buildSnapshot` drops the stale reading (`src/lib/windows.ts:1034-1054`), and the session meter falls back to the derived figure or the hatched no-ceiling bar. That is exactly when the operator is deciding whether to start the next batch.
- **Change**: treat the cached value as not fresh when any `resetsAt` it carries is ≤ `now`. Keep `ERROR_BACKOFF_MS` and the shared `inflight` promise unchanged, so it is at most one extra request per rollover.
- **Size**: S.
- **Touches**: `metering.md`'s rate-limit paragraph — the endpoint 429s on a handful of requests a minute, and the back-off is what stops a transient 429 becoming permanent; the token is never refreshed from here.
- **Value**: medium — it removes a five-minute degraded reading at every boundary.
- **Not worth it if**: the provider answers the post-reset request with the old window. Measure across one rollover before building.

### U-5 Keep the per-repository card in step with the page's poll
- **Friction**: `RepoSpendCard` loads on mount and on a span change only (`src/components/RepoSpendCard.tsx:78-80`), while the dashboard around it polls every 60–120 s (`src/app/page.tsx:~381`). A dashboard left open shows repository spend from whenever the page was opened. It also has no liveness guard, so a quick span toggle can land the older answer last.
- **Change**: reuse the page's `alive` pattern (`src/app/page.tsx:~347-360`) and re-load on the page's interval, or take the page's tick as a prop.
- **Size**: S.
- **Touches**: `metering.md` "What each repository cost is a fifth reading" — its own route and load, never a field on `/api/usage`; this keeps that.
- **Value**: low — the card is a report, but a stale report beside a live one reads as disagreement.
- **Not worth it if**: `/api/repo-spend` is expensive enough that the page's cadence costs a run CPU. Assumed cheap (one grouped query); not measured.

## Too big for this list

## Bugs filed
- Exhaustion projection uses the typed ceiling while the meter shows Anthropic's percentage, so a 92% window reads "Not projected to run out" — high — `8b47ae9a-0cc5-4bbf-ae65-2bdec1753bd6`
- Dashboard window card reads the raw provider reading: stale per-model walls, false "reported by Anthropic" reset, false "all-model" bar — normal — `9202c8f2-7ae2-4a9c-9f58-f1aa8145f6e5`
- Calibrate's "Measured" ceiling divides new-window spend by a rolled-over or aged provider percentage — normal — `2f735b96-3c7d-4db7-b49b-fc0a6e500bf3`

## Bugs not filed

## Seen outside my territory
- `docs/agent/metering.md:60` contradicts `:32` and the code (`src/lib/windows.ts:323-342`): it says weekly buckets follow `weeklyAnchor` "or the local Monday", where `:32` and `effectiveWeeklyReset` put the provider's reset first. Documentation drift; left to the open drift issues.
