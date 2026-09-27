# Conventions and design language

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing any component in src/components/, any route handler, any CSS.**

Each rule is in one topic file under `docs/agent/conventions/`; the lines below are the rules' lead claims, under the file that holds them.

## [Route handlers, server modules and the schema](conventions/route-handlers-and-server-modules.md)

- Server-only vs client. `src/lib/apiTypes.ts` holds the DTO mirror of the server types so client components never transitively import `node:fs`.
- Route handlers that touch SQLite or the filesystem need `export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"`.
- A body a handler reads fields off goes through `readJsonObject` (`src/lib/http.ts`), not `(await req.json().catch(() => ({}))) as Record<string, unknown>`.
- Eighteen route answers go through `jsonMaybeGzipped` (`grep -rn 'jsonMaybeGzipped(' src/app/api`), and the streaming ones are excluded by name
- Module state survives dev hot reload via `globalThis` singletons: `__ufDb`, `__ufBus`, `__ufProcs`, `__ufInterrupts`, `__ufTranscriptCacheV2`.
- Schema changes go in `migrate()` in `db.ts` as idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statements, or as an `addColumn` that reads the live schema — there is no …
- `better-sqlite3` is a native addon — it must stay in `serverExternalPackages` in `next.config.ts`, and the Dockerfile's `deps` stage carries the build toolchain for it.
- Comments in this codebase explain *why* a decision was made (usually a correctness or safety trade-off), not what the code does.

## [Polling, list DTOs, filters and Settings saves](conventions/polling-dtos-and-settings-save.md)

- Pages are client components that poll their API route (dashboard 120s, run detail 3s for the row while SSE carries the log).
- A list route ships the list's own DTO, and both readers of a list move together.
- A payload may carry a position into its own answer, and it is turned back into an id at the fetch boundary.
- A control that narrows what is on screen narrows the *data*, never the way the data is drawn — and it says what it left out.
- A Save stores only what differs from `DEFAULTS`, and that is a correctness decision rather than a size one.

## [The app shell, keyboard shortcuts and the run page's split view](conventions/app-shell-and-run-page.md)

- The shell is a window, not a page. `src/components/shell/` holds all of it — `AppShell` (the frame, and the app's one keyboard listener), `Sidebar`, `Toolbar`, `QuickOpen`, `panes.ts`, `shortcuts.ts` …
- The collapse is a document state, and it is settled before the first paint.
- The shell is installable, and the toolbar knows it.
- ⌘ and nothing beside it, and never over a text field.
- A run's page is a split view, and the pane shows one thing at a time.

## [Pane overflow, tables and character art](conventions/pane-overflow-and-tables.md)

- A control that cannot wrap is a control that pushes the pane sideways.
- Character art is sized by the widest glyph in it, which is not the monospace advance, and getting that wrong widens a card rather than overflowing it.
- A box inside the pane is never sized in viewport units, because the pane is not the viewport.
- A table must not be the reason the pane scrolls sideways.
- `Table`'s `stack` is the narrow-window answer, and the label on each `Td` is the other half of it.
- A capped scroll region is released below the breakpoint, not kept.

## [The mobile breakpoint, the drawer and the window's edges](conventions/mobile-breakpoint-and-window-edges.md)

- The mobile boundary is `md` (768px), the sidebar is a drawer below it, the touch target is 44px, and every mobile rule is additive.
- `md`, 48rem, and the same line everywhere. At or above it the source list is a docked column; below it, a drawer.
- The drawer is a native `<dialog>` and obeys `Sheet`'s three rules.
- A surface's own padding is a share of the window, and only the widest one gives any of it back.
- A `fixed` bar is outside `AppShell`'s box, so it owes both edges itself.
- A software keyboard is not a viewport unit, and `--keyboard-inset` is the whole of what this app does about it.
- A `Sheet` is in the top layer, so it owes the window's edges itself
- Every mobile change is additive behind a breakpoint prefix.

## [Touch targets, text fields and wrapping controls below the breakpoint](conventions/touch-targets-and-narrow-controls.md)

- 44px is the hit target below the breakpoint, against `--control-h`'s 32px above it, and it is `max-md:min-h-11` rather than a change to the token — `--control-h` is the pointer's floor and the whole …
- 16px is the floor for a control that takes text, and it is a platform rule rather than a type decision.
- A `ListRow` wraps below the breakpoint; the label's min-width decides *when*, and the control wrapper's `max-md:grow` decides what the wrapped line is worth.
- The workflow canvas is *read* on a phone and *arranged* on a screen, and it says so rather than half-answering a finger.

## [Styling, tokens, colour and variants](conventions/styling-tokens-and-variants.md)

- The palette and the type scale are AppKit's, not the web's.
- There is one accent, and two different things are measured against it.
- `--danger` is split the same way, and for the same arithmetic.
- One focus treatment, stated in one place. `@layer base` draws `outline: 2px solid var(--ring)` at 2px offset on everything focusable, and the legacy sheet no longer sets `outline: none` on …
- Tokens. Colour and type as above, plus: `--motion-fast|base|slow` (120/180/240ms — a control answering the pointer, something arriving or leaving, something travelling a distance) and …
- Motion is explanation. `ui-transition` is the one transition an interactive surface wears; it deliberately omits `transform` and `width`, because a control must not move or resize between its states.
- Numbers behave. Every figure `tabular-nums` (`Stat`, `Th`/`Td` with `num`, `Meter`, `mono`) so it cannot jitter as the page polls, units attached, and an unknown reading says so — the hatched …
- Styling is Tailwind v4, CSS-first — no `tailwind.config.js`, no CSS modules, no third-party component library.
- The `@layer theme, base, legacy, components, utilities` statement.
- `@import "tailwindcss" source(none)` plus an explicit `@source`.
- Tokens keep their existing semantic names (`--bg-raised`, `--fg-muted`, `--warn`) and `@theme inline` maps them to utilities.
- Variants are typed props with `Record<Union, string>` lookup maps, never `data-[…]` Tailwind variants.
- The `@layer legacy { … }` block is the migration's remaining surface and shrinks as pages move onto the kit.

## [Design language: emphasis, grouping and wording](conventions/design-language-and-grouping.md)

- Design language. What the kit already decided, so a page does not decide it again differently.
- One thing leads on every screen, and elevation says which.
- Grouping has a closed vocabulary, and it is seven things.
- `ceiling`, `guard` and `limit` are three different words for three different things, and the app says which.
- The chat's transcript says who is speaking with structure, never with colour.

## [The component kit, its spacing and interface defects](conventions/component-kit.md)

- `SegmentedControl` is how a short, fixed set of choices is offered, and `Icon` is the app's only glyph set.
- `Sheet` is a native `<dialog>`, and that is a correctness decision.
- What a new component owes. Five interaction states — rest, hover, active, focus-visible, disabled — with no layout shift between them, and a hit target of at least `--control-h`.
- `Field` is finished; do not fork it. Label, `hint`, `error`, `unit`, `prefix`, `disabled` and the mode-picker-plus-value row (`LimitField`) are all props.
- `Slider` and `ColorSwatch` are `Field`'s two newest members, and a slider always shows its figure.
- `ListGroup`/`ListRow` is the grouped inset list, and `Switch` is the control that usually sits in one.
- A `Select` whose value can name something its options do not has an option for that value.
- When you fix an interface defect, record its class.

## [Canvases and charts](conventions/canvas-and-charts.md)

- A `<canvas>` settles three things the DOM already answered, and every one of this app's canvases answers them the same way — by importing the answer from `src/lib/canvasView.ts` rather than deciding again.
- A chart small enough to read at a glance is inline SVG, and it takes its colours as classes rather than as probed values.
- A chart whose marks are *identities* takes the six band tokens, in a fixed order, and never a status colour.
