# QoL hunt 5/5: usage and dashboard, settings, knowledge and dreaming, the app shell

At `fee5efb`. I read `CLAUDE.md`, `docs/agent/metering.md`, `retention.md` and `conventions.md` in full, `dreaming.md` by its paragraph heads, and the index in `proposals/README.md`. `KnowledgeSection` and `Dreaming` are no longer in the tree (`36a0416` moved them out as implemented), so they were read from `36a0416^`.

The territory was split four ways, one read-only hunt each: metering and the dashboard; Settings, account, storage, stacks and plugins; Knowledge and Dreaming; the shell, the UI kit and health/status. Each bug they reported was checked against the source here before it was filed. Where a finding says **executed**, a scratch `node --test` was compiled with `tsc -p tsconfig.test.json` into `$TMPDIR` and run, and then deleted. Some knowledge figures are from a read-only index of the operator's vault at `/workspace2`.

`npm run typecheck` is clean and `npm test` passes 3067 of 3067 at `fee5efb`. Nothing was built and no page was rendered, so every UI claim is read from source.

Not reached:
- `transcripts.ts` past `parseLine` and the dedupe; the OTLP ingest route; `LiveTelemetry` and `RecentBlocksCard`; DST days whose change falls at midnight.
- `vaultSkill.ts` past enable/prepare; the Settings field search in a real DOM; the stacks detail and account pages as rendered.
- `canvasView.ts`, the force layout and its gestures.
- `AsciiArt`/`AsciiFrame`/`Icon`, and whether every `SegmentedControl` caller clamps its value.

Fourteen items, twelve bugs filed, nineteen more listed unfiled.

## Items

### U-1 Project exhaustion from Anthropic's own reading on a stock install
- **Friction**: a stock install has no typed ceiling, because `DEFAULTS` carries none (`docs/agent/metering.md`, "Unknown must not render as zero"). On such an install the dashboard's *Projected exhaustion* row says "Needs a configured ceiling" (`src/app/page.tsx:1027-1028`). It says so directly under two meters that already show the provider's percentage, so an operator deciding whether to start work gets the reading but not the "when do I run out" that goes with it. The row is gated on `noConfiguredCeilings` (`src/app/page.tsx:559-566`). The comment there gives the reason: the projection "extrapolates dollars and tokens per hour", so it "stays unavailable on a provider reading alone".
- **Change**: that reason no longer holds, because the dollar rate a provider percentage implies is already computed. `planFractionCarriedForward` converts spend since the fetch at `$ at fetch / percent` (`src/lib/windows.ts:~814-828`).
  - Give `etaFor` (`src/lib/windows.ts:1152-1183`) one candidate per window whose figure is the provider's: remaining = (1 − guardFraction) × ($ at fetch / planFraction), at `burnCostPerHour` (`:1129-1133`).
  - Keep the existing horizon drop (`:1159-1164`); on the page, only the gate changes.
  - This is the stock-install half of bug `8b47ae9a`, where the projection uses the typed ceiling when both exist. One run can do both.
- **Size**: M.
- **Touches**: `metering.md`.
  - The percentage never reaches `costUSD`.
  - No candidate when `planFraction <= 0` or when spend at fetch is 0.
  - Model-scoped walls are excluded: an Opus-only percentage against all-model spend is the mixed-denominator error the carry-forward already refuses.
  - A candidate past its window's reset is dropped, not clamped.
  - It errs early, because the provider's percentage also counts Desktop and web use that is not on this disk. That is the safe direction.
- **Value**: high. It answers "when do I run out", and every stock install currently has no answer.
- **Not worth it if**: the implied rate swings too much between five-minute readings to extrapolate. Not measured.

### U-2 Say "no window open" instead of a 5-hour countdown that moves with the clock
- **Friction**: with no block open, `buildSnapshot` reports the window the next turn would open, starting at `now` (`src/lib/windows.ts:985-994`). That is deliberate: "anything earlier would claim a window is already part-spent". The card still leads with "Resets in 5h 0m" and a clock time (`src/app/page.tsx:708-722`), recomputed on every poll. The best possible answer to "is now a good time to start?" — nothing open, the full allowance available — reads as a clock that never gets closer.
- **Change**: when `s.session.startsAt === s.now` and no current provider session reading exists, lead with "No window open — the next turn starts one", and keep the hypothetical end on the sub-line. Presentation only; the snapshot is untouched.
- **Size**: S.
- **Touches**: `metering.md`, "A block opens at its first turn": no rounding and no new idle-gap rule. It must make no "empty" claim while the provider's session reading is current, because that reading counts other surfaces.
- **Value**: medium. It is the first line of the first card, read every time the operator decides whether to start.
- **Not worth it if**: operators plan by the hypothetical end time. It stays on the sub-line, so that still works.

### U-3 Show each per-model weekly wall's own reset
- **Friction**: the per-model line prints a label and a percentage and nothing else (`src/app/page.tsx:852-861`). An operator stopped by an Opus wall cannot see when Opus comes back without going to claude.ai.
- **Change**: `PlanWindowDTO.resetsAt` already carries the instant (`src/lib/apiTypes.ts:62-65`), and `parsePlanUsage` fills it for `limits[]` entries (`src/lib/planUsage.ts:173`). Render it beside each wall with `fmtRelative`/`fmtDateTime`, as the card already does for its own reset.
- **Size**: S.
- **Touches**: render only walls the snapshot still counts as current. That depends on bug `9202c8f2`; fix it first or in the same run. No tooltip may carry the reset (`conventions.md`).
- **Value**: medium, on accounts that meet a model wall — the accounts the weekly wall handling was written for.
- **Not worth it if**: real payloads leave `resets_at` empty on `limits[]` entries. I assumed they fill it and did not check a live reading.

### U-4 Refetch the provider reading once an instant it named has passed
- **Friction**: `planUsage()` decides freshness by age alone (`src/lib/planUsage.ts:235`, `REFRESH_MS` 5 min). For up to five minutes after every rollover, `buildSnapshot` drops the stale reading (`src/lib/windows.ts:1034-1054`). The session meter then falls back to the derived figure or to the hatched no-ceiling bar, which is exactly when the operator is deciding whether to start the next batch.
- **Change**: treat the cached value as not fresh when any `resetsAt` it carries is ≤ `now`. Keep `ERROR_BACKOFF_MS` and the shared `inflight` promise as they are, so the cost is at most one extra request per rollover.
- **Size**: S.
- **Touches**: `metering.md`'s rate-limit clause. The endpoint answers 429 after a handful of requests a minute, and the back-off is what stops a transient 429 becoming a lasting one. The token is never refreshed from here.
- **Value**: medium. It removes a five-minute degraded reading at every boundary.
- **Not worth it if**: the provider answers the post-reset request with the old window. Measure across one rollover before building.

### U-5 Settings: send only what changed
- **Friction**: Save PUTs the whole effective object (`src/app/settings/page.tsx:2423-2427`; `conventions.md` records it as the page's behaviour). Three costs follow:
  - A second tab opened earlier overwrites whatever the first tab saved.
  - Every Save re-sends `planUsageFromApi`, which triggers bug `c42481ca`.
  - A stale reference in a field the operator did not touch refuses every unrelated edit: a deleted default agent, an unmounted knowledge vault, a disabled default model (`docs/agent/metering.md`, "one Save commits every field, so a default whose agent has been deleted refuses **any** settings edit").
- **Change**: build the PUT body from the fields the page already tracks as changed (`src/app/settings/page.tsx:~2309-2316`). The route already takes partial bodies: its tests send one key at a time (`src/app/api/settings/route.test.ts`).
  - `modelCatalogue` has to join `EDITABLE_PATHS` first; it is the one key missing (listed below as an unfiled bug).
  - `chatDefaultGuards` still goes whole, and `defaultModel` and `modelCatalogue` go together.
- **Size**: M.
- **Touches**: this bends the decision in `metering.md`'s default-agent paragraph, and it has to take on that decision's reasoning directly. The decision's reason is "refusing where the person is, with the control in front of them", and its fear is a stale default that no page mentions. A partial PUT keeps both, provided the stale reference is drawn as the field's own error **on load**. The GET would say so; `defaultAgentId`'s option already reads "Agent no longer in the registry". The alternative is surfacing it only by refusing an unrelated Save. `conventions.md`'s "A Save stores only what differs from DEFAULTS" is unaffected: `saveSettings` still diffs.
- **Value**: high. It removes a cross-tab data loss and a whole class of "why won't my prompt edit save".
- **Not worth it if**: the operator wants a stale value re-checked on every Save as a feature. The docs call it a cost, not a feature.

### U-6 Settings: name the shipped value on a field that has moved, and offer it back
- **Friction**: `GET /api/settings` already returns `nonDefaultKeys` (`src/app/api/settings/route.ts:96-118`, `:758`). The page uses them only to count moved fields per fold (`src/app/settings/page.tsx:2140-2141`, `:2440`). A row never says what the shipped value was. The four prompts cannot get back to their shipped text at all, because a blank prompt keeps the stored one (`src/app/settings/page.tsx:~4878`).
- **Change**: return the default for each moved key beside `nonDefaultKeys`. A moved row then says "Shipped: X" in its `description`, next to a "Use shipped value" button. Pressing it removes the key from the blob on the next Save, which is what `saveSettings`'s diff does anyway.
- **Size**: M.
- **Touches**: `settings.ts` cannot be imported client-side, so the defaults travel on the GET. Nothing goes in a tooltip (`conventions.md`). It must not write the whole blob back (`conventions.md`, the `8651bcd` incident).
- **Value**: medium-high. `conventions.md` explains why an install silently diverges from shipped defaults; this makes the divergence visible and one press to undo.
- **Not worth it if**: the prompt texts are too long to show in a description. For those four, show the first line.

### U-7 Settings: take the operator to the field a Save was refused over
- **Friction**: a 400 from `PUT /api/settings` is printed as a sentence at the foot of the page (`src/app/settings/page.tsx:~2431-2433`). It does not say where the control is. Examples are the knowledge mount (`src/app/api/settings/route.ts:~262-268`) and an unknown time zone. On a page of about 5,000 lines, the operator hunts for the field the sentence names.
- **Change**: the route returns `field` beside `error` on each refusal it can attribute. The page's notice gains a "Go to field" button that calls the existing `goToField` (`src/app/settings/page.tsx:2386`), the same one the field search uses.
- **Size**: S.
- **Touches**: nothing about what is refused changes. `conventions.md` records that the field search's corpus is the rendered page, so `goToField` over `[data-setting-name]` is the path.
- **Value**: medium. Every refused Save ends in a search today.
- **Not worth it if**: refusals turn out to be rare in practice. There is no count; assumed occasional.

### U-8 Storage card: "Sweep now", and when the next sweep is due
- **Friction**: the retention sweeper runs every six hours (`src/lib/retention.ts:73`, `SWEEP_MS`; armed at `:1241`). An operator who lowers a horizon to free disk waits up to six hours with nothing on the card saying when. The Storage card has no action (`src/app/settings/page.tsx:~946-1069`).
- **Change**: a POST that runs one sweep through `tick()`'s own gates (`mayWriteDataDir`, `timer.running`; `src/lib/retention.ts:~1258-1293`) under `auditMutation`. The card shows the last sweep, which it already stores under `retention.lastSweep`, and the next one due.
- **Size**: S-M.
- **Touches**: `retention.md`, in full. The sweep deletes files, so the button opens a `Sheet` naming what the horizons will remove (`conventions.md`: a destructive action is a Sheet). "Nothing in flight is touched" and the per-tick ownership question stay exactly as they are.
- **Value**: medium. It is the one action the card exists to prompt.
- **Not worth it if**: a sweep takes long enough to block the guards' event loop. The checkout half shells out to git and the transcript half walks `~/.claude/projects`. Not measured here.

### U-9 Dreaming: open a written note from the pane
- **Friction**: on `/dreaming` a written note's path is plain `<code>` (`src/app/dreaming/page.tsx:~387-398`), and the Recurring tab's "written" badge links nowhere (`:~317-321`). To read what dreaming wrote, the operator copies a path and hunts for it in Knowledge.
- **Change**: link the path to `/knowledge?note=<path>` with the reader's existing `noteHref` (`src/app/knowledge/page.tsx:~81-91`). The dreaming run writes into the same root the reader indexes (`resolveKnowledgeRoot`, `src/lib/dreamingRun.ts:~304`, `:~371`).
- **Size**: S.
- **Touches**: `dreaming.md`. Link only a row whose file is present, and render a claimed-but-pathless row as it is now ("attempted, no file recorded"). The pane stays read-only and does not poll.
- **Value**: high. The pane is where the operator decides whether a note should be retracted, and that needs the note.
- **Not worth it if**: runs report absolute or non-canonical paths. Strip a leading `./`; anything else stays unlinked.
- **Overlap**: Findability `04-option-widen-quick-open.md` would put dreaming rows in quick open. That finds the row, not the note.

### U-10 Dreaming: show how each night's run actually ended
- **Friction**: every selected night is badged "wrote" (`src/app/dreaming/page.tsx:~461`), whatever the run then did. A pathless row says "the run may have decided it was not worth a note" (`:~400-402`) even when the run failed, was cancelled or tripped a guard.
- **Change**: join each night's run status in `listNights` (`src/app/api/dreaming/route.ts:~85`; `getRun` is already used at `src/lib/dreamingRun.ts:615`). Badge the night with the settled status, and pick the pathless sentence by it.
- **Size**: S.
- **Touches**: `dreaming.md`, "`recordNight`'s `selected` is sticky". This is a display field beside it, not a change to it. It finishes `18-the-dreaming-pane.md` §6 of the moved Dreaming proposal ("Ran and failed … errored, was cancelled, tripped a budget guard"), which today is honoured only for a tick that threw.
- **Value**: medium. A failed night currently reads as a quiet success.
- **Not worth it if**: nothing; it is a join.

### U-11 Dreaming: mark which recurring signatures tonight's pass will hand the run
- **Friction**: the Recurring tab marks every qualifying row "not written", and does not show which of them the next night will pick. By default it picks five (`src/lib/dreamingRun.ts:~345-349`). An operator cannot tell "will be written tonight" from "qualifies but is below the cut".
- **Change**: compute the pick on the server with the same `selectWritable` and slice the run uses, return it on `/api/dreaming`, and badge those rows.
- **Size**: S.
- **Touches**: one copy of the selection rule, on the server; the page decides nothing. No Run button is added: `dreaming.md` keeps the writer a run started by the clock or by the pane's own existing control.
- **Value**: medium. It is the preview the write-on-second-sighting policy lacks.
- **Not worth it if**: the pick changes between the page load and the night. Say "as of now".

### U-12 Knowledge: make frontmatter wikilinks clickable in the reader
- **Friction**: the reader prints frontmatter values as plain text (`src/app/knowledge/page.tsx:~484-490`). On the operator's vault, 1,665 of 1,711 notes carry 9,113 frontmatter wikilinks between them, measured read-only. `parseNote` already makes them edges (`src/lib/knowledge.ts:724-742`), so the graph follows them and the reader does not.
- **Change**: linkify only the `[[…]]` tokens inside each value, using the page's existing `resolveWikilink` (`src/app/knowledge/page.tsx:~347-358`), and leave every other character as written.
- **Size**: S.
- **Touches**: the page's stated rule that frontmatter is "shown as it was written" (`src/app/knowledge/page.tsx:~112`). This keeps the text byte-for-byte and adds anchors, which is why it bends the rule rather than breaking it. "Links out" already lists these edges, which is the case against this item.
- **Value**: medium. On this vault, `sources:` and `related:` are where most of the links are.
- **Not worth it if**: the operator reads frontmatter as metadata and navigates by "Links out" alone.

### U-13 Quick open: let a result open in a new tab
- **Friction**: each result is a `<div role="option" onClick>` (`src/components/shell/QuickOpen.tsx:375-377`), so ⌘-click and middle-click do nothing. Comparing two runs side by side means opening one, going back, and opening the other.
- **Change**: render each row as an `<a href>` with `role="option"` and `tabIndex={-1}`, so focus stays in the field. A plain click keeps `preventDefault` and `go()`; a modified or non-primary click is left to the browser. This follows `ButtonLink`'s reasoning (`conventions.md`, "What a new component owes") and the modified-click rule in `src/lib/unsavedWork.ts:~100-108`.
- **Size**: S.
- **Touches**: `conventions.md`, "Quick open navigates and does nothing else". This only navigates. A plain click still passes the leave guard.
- **Value**: medium.
- **Not worth it if**: a screen reader announces a link-as-option badly. Check VoiceOver before landing.

### U-14 Quick open: reach taskboard tasks
- **Friction**: the placeholder offers "task" (`src/components/shell/QuickOpen.tsx:327`), but that means a run's prompt. Taskboard tasks have their own page (`/tasks/[id]`) and never appear, and `GET /api/tasks` reads no `q=` (`src/app/api/tasks/route.ts:57`).
- **Change**: add `q=` to `GET /api/tasks`, matched in the query with the escaped `LIKE` `normalizeRunListQuery` already uses. Quick open reads it 250 ms after the last keystroke as a fourth source, as it already does for runs. Reword the placeholder.
- **Size**: M.
- **Touches**:
  - `conventions.md`: narrow in the query and never over a capped page; `MAX_TASK_PAGE` is the cap here.
  - `taskboard.md`: a task row only navigates, never offering claim or Start.
- **Value**: medium. Tasks are a ⌘-digit pane now, and the one object here an operator names by its words.
- **Not worth it if**: Findability's objection to widening quick open holds. This is the shape `Findability/10-recommendation.md` accepts, a consumer of a route-level `q=`, for a kind that survey never covered: the board landed after it.

## Too big for this list
- None found that could be grounded.
- The sidebar count badges are held as a question for a person in `docs/agent/ui-density-audit.md`, so they are not proposed here.

## Bugs filed
- Exhaustion projection uses the typed ceiling while the meter shows Anthropic's percentage, so a 92% window reads "Not projected to run out" — high — `8b47ae9a-0cc5-4bbf-ae65-2bdec1753bd6`
- Dashboard window card reads the raw provider reading: stale per-model walls, false "reported by Anthropic" reset, false "all-model" bar — normal — `9202c8f2-7ae2-4a9c-9f58-f1aa8145f6e5`
- Calibrate's "Measured" ceiling divides new-window spend by a rolled-over or aged provider percentage — normal — `2f735b96-3c7d-4db7-b49b-fc0a6e500bf3`
- Knowledge resolver reports a wikilink as broken when the note's name contains a dot — normal — `d0e67076-e557-477f-81db-dc7d063d7b70`
- Knowledge note view's Backlinks list names and links the open note itself instead of the notes linking to it — normal — `785ab790-a603-464d-bace-e59cf8b073d5`
- Dreaming scan keeps the old time zone's day keys after dreamingTimeZone changes, and can write a note for a one-day failure — normal — `668dd86e-085a-4d36-b421-0fb086edd98d`
- Dreaming reconciler attaches a note path to the wrong signature once forgetNote has removed an earlier row of the same run — normal — `c56f4f92-7964-4323-a254-850c6409338f`
- ReadOnlyNotice shows "Failed to fetch" as the read-only banner on any dropped poll, and stays silent when SQLite cannot write — normal — `6a33052a-bbe2-4284-a487-c1cbc5c20d7a`
- RestartClosed never shows why runs were refused, and a failed pick-up removes its only button until reload — normal — `63ba6de7-3233-4a8d-9964-32524b040ebf`
- Typing 0, a negative or a non-number into a Settings cap stores "no limit" instead of the promised floor or a refusal — high — `d4a1d4af-582b-4147-9be0-b6335ff56383`
- Every Settings Save drops the cached provider usage reading, so a Save during a 429 spell leaves the window guards with nothing to read — high — `c42481ca-dbf7-4607-884a-6ec6b06a2e2b`
- An enabled plugin whose manifest breaks or whose folder disappears cannot be switched off — normal — `37cd4945-3fe0-4680-b1cd-05d91cd0e465`

## Bugs not filed
These were found after the twelve-task cap, and each ranked below the twelve filed. Each line gives where the fault is, at `fee5efb`, and how it was established.

### Normal
- **Checkout reclaim stalls for good once 40 kept checkouts sit ahead of reclaimable ones.**
  - Where: `MAX_RECLAIM_PROBES` = 40 (`src/lib/retention.ts:379`) is spent on the newest past-horizon candidates, which are then kept for unlanded commits (`:501-504`), and the candidate query is `LIMIT 500` (`:427-438`).
  - Executed against real temporary worktrees: 40 unlanded plus 1 settled removed 0 over two sweeps; 39 plus 1 removed the settled one; a slot behind 520 newer runs removed 0.
  - The comment at `:457-459` ("by nothing after two") is false. The disk fills in the safe direction.
- **Knowledge links report line numbers counted from the end of the frontmatter, so the Health tab's Line column is wrong on almost every note.**
  - Where: `extractLinks(body)` runs on the body alone (`src/lib/knowledge.ts:719`); frontmatter links go through `lineCounter(front)`, which is off by one (`:724`, `:738`).
  - Executed: a file-line-7 link reported 2. On the vault, 700 of 705 broken wikilinks name a line that does not hold the target.
  - `:135` promises "1-based line in the note".
- **`/api/account` passes the Admin API's own 401 through, and the page shows "Signed out" for a revoked admin key.**
  - Where: `src/app/api/account/route.ts:63`; `src/app/account/page.tsx:100` tests 401 before the "Admin API refused" branch at `:166-184`.
  - Read from source, not executed.
- **ThemeToggle and SkinToggle read `localStorage` with no try/catch, so a browser that blocks site data throws on every page.**
  - Where: `src/components/ThemeToggle.tsx:42-45`, `src/components/SkinToggle.tsx:48-50`; `src/app` has no `error.tsx`.
  - Read from source. The `SecurityError` behaviour is from platform knowledge, not executed.
  - The pre-paint script and `writeCollapsed` (`src/components/shell/Sidebar.tsx:37-44`) already guard this.
- **The "This note" graph at depth ≥ 2 walks through hidden tags and draws unrelated notes as unlinked dots.**
  - Where: `localGraph` runs before `filterGraph` (`src/components/KnowledgeGraphView.tsx:286-292`), with `showOrphans` on by default (`src/lib/knowledgeGraph.ts:391`).
  - Executed on a fixture. On the vault: 1,353 nodes against 38.
- **Quick open's arrow keys move the highlight below the 320px list with nothing scrolling it into view.**
  - Where: `src/components/shell/QuickOpen.tsx:301-311`; list cap at `:355-360`.
  - Read from source. It is a class C defect; the chat page does the same thing right at `src/app/chat/page.tsx:1006`.
- **Quick open takes Enter and the arrows from an IME mid-composition.**
  - Where: `src/components/shell/QuickOpen.tsx:301-311`, which has no `isComposing` test; the chat composer has one at `src/app/chat/page.tsx:1428-1432`.
  - Read from source.

### Low
- **The mobile drawer stays open behind the workflow editor's leave prompt, and over the next page.**
  - Where: the capture-phase `stopPropagation` at `src/components/WorkflowEditor.tsx:899-917` runs before `Sidebar`'s bubble-phase `onClick` at `src/components/shell/Sidebar.tsx:200`.
  - Read from source.
- **`Sheet`'s `autoFocus` only works on a server-rendered sheet.**
  - Where: `src/components/ui/Sheet.tsx:166`, `:175`. React focuses at commit, while the dialog is closed, and a client-mounted sheet then opens on its first focusable element.
  - Read from react-dom source.
- **`/api/health` reports run counts as zeros when the database cannot be read.**
  - Where: `src/lib/health.ts:116-122`; its own comment at `:91-92` says unknown must be distinguishable.
  - Executed.
- **The toolbar reads "Taskboard" over `/tasks/new` and `/tasks/[id]`**, where `/runs/new` reads "New run".
  - Where: `src/components/shell/panes.ts:109-128`.
  - Executed.
- **The window meters' screen-reader hint says every hatched band is "once unpriced models are charged".**
  - Where: `src/app/page.tsx:730`, `:819`. The band can also be the provider carry-forward, a model wall, or unattributed cache writes.
  - Executed: `guardFraction` 0.75 over `fraction` 0.5, with no unpriced model.
- **Week labels for provider-aligned buckets read as eight days and share a date with the next row.**
  - Where: `endsAt - 1` in `src/lib/format.ts:514`, over buckets cut on the provider's instant (`src/lib/windows.ts:1427-1433`).
  - Executed: `Sep 17 – 24`, `Sep 10 – 17`.
- **The knowledge index does not notice an added or removed attachment until some note changes.**
  - Where: `src/lib/knowledge.ts:1174-1196`.
  - Executed.
- **The Dreaming pane counts claimed-but-unwritten rows as "notes written into the vault", and its "N signatures on {minDays}+ days" always counts two or more days.**
  - Where: `src/app/dreaming/page.tsx:236-237`, `:220-223`; the hard-coded `>= 2` is at `src/lib/dreaming.ts:462`.
  - Read from source.
- **The graph never says its answer was cut at the server's 4,000-node cap.**
  - Where: the client asks for 5,000 (`src/components/KnowledgeGraphView.tsx:99`); the server clamps (`src/lib/knowledge.ts:109`, `:1250`).
  - Read from source. It does not trigger on the operator's vault (1,898 nodes).
- **`/api/knowledge/graph?kinds=` silently ignores an unknown value**, against `conventions.md`'s refuse-a-filter-that-decides-rows rule.
  - Where: `src/app/api/knowledge/graph/route.ts:31-34`.
  - Read from source.
- **`modelCatalogue` is missing from the Settings page's `EDITABLE_PATHS`**, so its edits are unsaved but never marked, while the bar says "marked in the margin".
  - Where: `src/app/settings/page.tsx:333-394`, `:3573`, `:5002`.
  - Checked with `comm` against `DEFAULTS`.
- **A non-object JSON body to `PUT /api/settings` is a 500 rather than a 400.**
  - Where: the parsed body is cast to a record without a type check (`src/app/api/settings/route.ts:156`), so the first `"…" in body` test throws on `null` or a string.
  - Executed.
- **Two smaller Settings defects:**
  - The Storage card calls every `.jsonl` a "session" and leaves `tool-results` out of the transcript bytes (`src/lib/retention.ts:686`, `:1186-1195`).
  - Reserved headroom redraws rounded, e.g. 2.5 shows "3" (`src/app/settings/page.tsx:2988-3000`).
  - Measured with `find` / arithmetic, not rendered.

## Seen outside my territory
- `docs/agent/metering.md:60` contradicts `:32` and the code (`src/lib/windows.ts:323-342`). It says weekly buckets follow `weeklyAnchor` "or the local Monday", where `effectiveWeeklyReset` puts the provider's reset first. This is documentation drift.
- `src/components/TaskEditor.tsx` registers no leave guard and no `beforeunload`; `grep -n 'registerLeaveGuard\|beforeunload'` finds neither. A brief typed at `/tasks/new` is lost on ⌘1…⌘9, quick open or a reload, against the pattern `src/lib/unsavedWork.ts:12-15` sets.
- `src/app/api/mcp/route.ts:2868`: `list_recurring_failures` reads the same dreaming scan, so it inherits bug `668dd86e`. That task names it.
- `docs/agent/testing/components-meter-markdown-and-kit.md`, "`Markdown.test.tsx`'s wikilink cases are the same bar reached from the knowledge page" ("183 dangling links"), and `docs/agent/testing/knowledge-vault-and-graph.md`, "The broken-link cases are there because the tempting implementation drops what it cannot resolve" ("212"), were probably inflated by bug `d0e67076`. Assumed; not re-measured.
