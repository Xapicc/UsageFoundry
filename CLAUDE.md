# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Next.js 15 (App Router) app that (a) reads Claude Code's local session transcripts to show subscription usage against 5-hour / weekly windows, and (b) runs Claude Code headlessly against a mounted folder, stopping between iterations when a budget guard trips. Ships as a single Docker container.

## Commands

```bash
npm run dev          # next dev on :3000
npm run build        # produces .next/standalone (output: "standalone")
npm run typecheck    # tsc --noEmit
npm test             # node --test over src/**/*.test.ts, via tsconfig.test.json
npm start            # serve a production build
npm run smoke-pages  # after a build: every page, two skins, two widths, four assertions

docker compose up --build     # the real deployment path; binds 127.0.0.1:3000

python3 scripts/make-icons.py # re-rasterise public/icon.svg; run only after editing it
```

Three environment traps, all of which make a green tree look broken and none of which is about this repository.

- A bare `npm ci` under the image's `NODE_ENV=production` exits 0 having skipped devDependencies, and `typecheck`/`test` then fail with exit 127 — use `NODE_ENV=development npm ci --include=dev`.
- A shell inheriting `__NEXT_PRIVATE_STANDALONE_CONFIG` from a UsageFoundry container (which is what an agent this app spawns gets) makes `next build` die with `TypeError: generate is not a function`: `loadConfig` returns that JSON verbatim rather than loading `next.config.ts` and applying defaults, and a serialized config cannot carry `generateBuildId`, which is a function. `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` is the whole fix.
- Inside an agent worktree, `next build` cannot finish **on the mount**, which is why `npm run build` no longer writes to it. The worktree is on a virtiofs mount whose directory cache outlives an unlink, so the `output: "standalone"` copy dies on a spurious `ENOENT`/`ENOTDIR` against a path whose parent is right there and which `mkdir -p` then creates without complaint — a different path every run (`.next/standalone/node_modules/@swc/helpers/cjs`, `.next/standalone/.next`, `.next/diagnostics`). Measured 2026-09-08: 4 of 4 attempts failed, and 6 of 40 `rm -rf`s of a freshly written tree on that mount returned `ENOTEMPTY` against 0 of 40 under `$TMPDIR`. `scripts/redirect-dist-dir.mjs` runs ahead of `next build` and hands the copy a filesystem that does not do that, by pointing `.next` at a scratch directory under `$TMPDIR` keyed on the checkout; 7 consecutive builds green against 4 of 4 failing before it, and the standalone bundle it produces serves. It is a no-op wherever the checkout is not on that mount, the image build included, so nothing about `docker compose up --build` changes. The same mount is why `npm ci` occasionally dies with `ENOTDIR: mkdir node_modules/@img`; `rm -rf node_modules` and retry.
  - Do not reach for `distDir` here — it was measured and it is worse. Pointing it outside the project makes Next rewrite the tracked `tsconfig.json`'s `include` to climb back in through `../../..`, and the route types generated out there can then no longer resolve `next`, so the build fails at "Checking validity of types" having dirtied a file you did not edit. Symlinking `.next` without a `node_modules` link beside the scratch directory fails the same way one stage later, at page-data collection, because Node resolves the **real** path of what it requires and walks up from the scratch directory. Keeping the path spelled `.next` is what costs nothing: every consumer — `tsconfig.json`, `next start`, `smoke-pages.mjs`, the Dockerfile's `COPY --from=builder` — is handed the string it already expects. `.gitignore` says `.next` without a trailing slash for that symlink's sake, the same reason `node_modules` above it does.

There is **no linter run** (`eslint.ignoreDuringBuilds` is on), and `npm test` covers a deliberately short list of pure functions whose failure modes are silent and expensive. `npm run typecheck` plus a `docker compose up --build` smoke test is the real verification loop, and `docs/verification/` — including each file's "Not yet verified by hand" list, which must stay honest — records what was checked by hand. Each entry there is one claim in one short paragraph — what was measured, when, against which pin, the result and its caveat — under its area in that area's file in `docs/verification/`, indexed by `docs/verification.md`, plus, for an unverified item, the command that would settle it. When an unverified item gets measured, the measurement becomes a new *Verified* entry and the item shrinks to what is still open; never amend an entry in place, because that is how the file reached 7,600 lines. Before adding a test, read `docs/agent/testing.md`: it names every existing one and the grounds each earned, and that is the bar, not a general convention to follow.

`npm run smoke-pages` is the one check that opens a browser: it starts the built app against a throwaway `DATA_DIR` and a `CLAUDE_BIN` that cannot spawn, opens every `src/app/**/page.tsx` in both skins at 390px and 1280px, and asserts a 200, no console error, no sideways scroll, and no box wider than a parent that is not a scroll container — that fourth one because `AppShell` clips rather than scrolls, so the app's worst narrow-viewport failure leaves the document's `scrollWidth` equal to its `clientWidth`. It is deliberately **not** in `npm test` and **not** in CI — it needs a Chromium and a build, and `README.md`'s position that CI "never starts the container and never exercises a run" is a decision rather than an accident. It asserts about *load* and never about interaction; the reasoning for that line, and for the accessibility engine it does not carry, is in `scripts/smoke-pages.mjs`'s header and in `proposals/UIChecks/`. It exits 2 rather than 0 when it could not run.

It serves `.next/standalone/server.js` when the build produced one, because that is the artifact the container ships; when `.next/BUILD_ID` exists but the standalone bundle does not, it falls back to `next start` against `.next/` and says so in its first line of output. Read that line before trusting a green run: the fallback checks every page for real, but nothing in it exercises the standalone bundle or the `node_modules` tracing copied into it, so a defect confined to those is invisible in that mode. An agent worktree used to be in that mode always; since the redirect above it is not, and a worktree build does exercise the shipped artifact. With no build at all it still exits 2.

Note that `npm run dev` on the host reads the host's **real** `~/.claude` transcripts and can spawn **real, billed** `claude` processes. Runs default to `acceptEdits`, so an agent started from the UI writes files.

## Before you edit

This app's invariants encode the product's reasoning, not style preferences, and nearly every one of them fails **silently** — nothing throws, nothing fails to typecheck, and the page looks right. Every one of them is written out in `docs/agent/`, one doc per area; where an area has been split, that doc is an index over the topic files beside it.

What follows is routing and nothing else: **if you are about to touch anything named on a line, open that line's doc before you edit.** A doc with a directory of the same name beside it is an index that lists every rule in the area by its lead claim, under a heading that links to the topic file holding it: find the claim that bears on your change and open that file. The clause after the dash only names the kind of decision the doc settles, so that the index stays the one place a rule is listed.

- **`src/lib/` generally, the module map, the three data sources, `plugins.ts`, `vaultSkill.ts`, the `--plugin-dir` argv, `/api/plugins`** → `docs/agent/architecture.md` — which cost source reaches what, what bounds each child process, and what the vault skill grants.
- **`windows.ts`, `transcripts.ts`, `pricing.ts`, `planUsage.ts`, `repoSpend.ts`, `otlp.ts`** → `docs/agent/metering.md` — how usage is read, priced and rolled up, and how an unknown reading renders.
- **`budget.ts`, `installBudget.ts`, every guard site in `orchestrator.ts`** → `docs/agent/budgets-and-guards.md` — what counts as off, the order guards check in, and what the install ceiling bounds.
- **`orchestrator.ts`'s run loop, `fleet.ts`, `requestLog.ts`, `notify.ts`, `contextPruning.ts`, the cycle boundary, `liveGuardTick`'s ceiling, the composition series** → `docs/agent/run-lifecycle.md` — how a run parks and ends, what every cycle's argv carries, and what pruning costs.
- **`createRun`/`promoteQueued`, `serverLock.ts`, `db.ts`, `instrumentation.ts`** → `docs/agent/concurrency-and-ownership.md` — the no-`await` window, what occupancy is never keyed on, and when writers ask the lock.
- **`retention.ts`** → `docs/agent/retention.md` — what expires, on which horizon, and what never does.
- **`releasableRuns`/`admitDependencies`/`releaseDependents`** → `docs/agent/dependencies.md` — what satisfies an edge, and what wakes a dependent.
- **`land.ts`, `mergeQueue.ts`, `conflictMap.ts`, `resolveIsolation`/`ensureWorktree`** → `docs/agent/isolation-and-landing.md` — when a run may land, which isolation it gets, and why landing has no clock.
- **`agents.ts`, `agentRegistry.ts`, `templates.ts`, `modelCatalogue.ts`, every field that names a model** → `docs/agent/agents-and-templates.md` — what an agent may carry, and which list a model id is validated against.
- **`chat.ts`, `chatThread.ts`, `src/app/chat/page.tsx`'s questions, `src/app/api/mcp/`** → `docs/agent/chat.md` — what a model may propose, what approval freezes, and how a chat turn ends.
- **`workflows.ts`, `schedules.ts`, `canvasGraph.ts`** → `docs/agent/workflows-and-schedules.md` — why instantiation is all-or-nothing, how a loop block unrolls and stops, and what is schedulable.
- **`review.ts`, `git.ts`, `diff.ts`, `patch.ts`, `runTouches.ts`, `runTouchScan.ts`** → `docs/agent/git-and-review.md` — the flags every `git diff` carries, and how touched and changed files reconcile.
- **auth, path containment, spawn argv, anything holding a credential** → `docs/agent/security.md` — why both containment checks are load-bearing, why never a shell, and which children get credentials.
- **`src/components/`, route handlers, `globals.css`** → `docs/agent/conventions.md` — the rules for variants, colours, polls and route handlers, and recording an interface defect.
- **`dreaming.ts`, `dreamingLedger.ts`, `dreamingRun.ts`, `/dreaming`, `/api/dreaming`** → `docs/agent/dreaming.md` — which half writes notes, what corpus it reads, and how a note is retracted.
- **`tasks.ts`, the `tasks` table, `/api/tasks`, `src/app/tasks/`, the board's MCP tools on all three subjects, `taskboardForRuns`, `runs.task_id`, `validation.ts` and every guard it touches** → `docs/agent/taskboard.md` — who moves a task where, what a run's token grants, and how closes are validated.
- **`docker-compose.yml`, `.env`, `Dockerfile`, `config.ts`** → `docs/agent/environment.md` — which variable refuses the boot, which defaults stay gone, and what the relay never forwards.

## Always

- **The UI says "work cycle", the code says "iteration".** User-facing copy names the unit a first-time user must reason about; `Settings`, `BudgetPolicy`, the API payloads and the `runs` table keep `iteration`/`maxIterations`. Don't rename the internals to match the copy, and don't reintroduce "iteration" into the UI.
- **Comments explain *why* a decision was made** — usually a correctness or safety trade-off — never what the code does. Match that when editing.
- **Long-lived module state goes on `globalThis`**, or it silently resets on every request in dev; `grep -rn "globalThis as" src/` finds the sixty-odd keys already there. Never reuse a key whose *shape* changed: `??=` only initialises when absent, so a pre-upgrade value survives a dev hot reload and every call on it throws — the trap `orchestrator.ts:10955-10958` records. Take a new key; the cost is one cold rebuild.
- **Schema changes** are idempotent statements in `migrate()` in `db.ts`. A destructive one is the exception and runs inside a single `db.transaction`.
- **A pure function whose failure mode is silent gets a unit test.** That is the bar the existing suite was built to; `docs/agent/testing.md` records what each one earned.

## Docs

`docs/agent/` is the agent-facing reasoning routed above. `docs/` proper is human-facing and its index is `docs/README.md` — go there rather than to a list here, because a list here is what drifted last time. The two an editor needs are `docs/architecture.md`, the `src/lib/` module map, and `docs/verification.md`, which records what has been measured against the pinned CLI and what has not. `README.md` is the landing page and says nothing about `src/lib/`.

A `docs/agent/<area>.md` with a `docs/agent/<area>/` directory beside it is an index, and the rules are in that directory's topic files; `docs/verification.md` is the same kind of index over `docs/verification/`. New material goes into the topic file it belongs to, or into a new topic file whose line in the index is added in the same change. No file under `docs/agent/` or `docs/verification/` should grow past about 20 KB, because an agent sent to one reads all of it, and the change that pushes one over splits it the same way.

`HEALTH-CHECK.md` at the repository root is neither, and is not maintained: it is one dated code audit at `267b901`, 2026-08-11, kept because `scripts/file-health-check-issues.sh` files its sections as issues by title. Its own header carries the per-finding status. Check any finding against the tree before acting on it — one of the seven was fixed in a way that contradicts its suggestion.
