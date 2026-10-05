# Verification log

[← Documentation index](README.md)

What has been exercised by hand against real transcripts, a real CLI and the
built container — and, under *Not yet verified by hand*, what has not. Each
entry is one claim: what was measured, when, against which pin, the result and
its caveat, filed in its area's file under `docs/verification/` — the table
below names it — in that file's *Verified* or *Not yet verified by hand*
section. The long-form write-ups these entries were condensed from, including
how each thing was found, are `git show df8626c:docs/verification.md`.

`npm run typecheck` plus a `docker compose up --build` smoke test is the real
verification loop. What `npm test` covers, and why each test earned its place,
is `docs/agent/testing.md`; interface defects and their classes are
[`interface-defects.md`](interface-defects.md).

Everything below typechecks and builds, and some of it is unit tested, but none
of it has been exercised the way its entry says — against a real CLI, a real
browser, a real device or a real install. This is the list to work through
before trusting this unattended. When an item gets measured, add the
measurement under *Verified* and cut the item down to what is still open.

## Where each area is filed

| Area | File | Verified | Not yet verified |
|---|---|--:|--:|
| Metering and cost | [metering-and-cost.md](verification/metering-and-cost.md) | 23 | 12 |
| Budgets and guards | [budgets-and-guards.md](verification/budgets-and-guards.md) | 7 | 4 |
| Run lifecycle | [run-lifecycle.md](verification/run-lifecycle.md) | 24 | 31 |
| Context control | [context-control-pruning.md](verification/context-control-pruning.md) — pruning, compaction and the context ceiling | 21 | 12 |
| Context control | [context-control-intake-filter.md](verification/context-control-intake-filter.md) — the intake filter and its ledger | 8 | 4 |
| Context control | [context-control-occupancy-and-composition.md](verification/context-control-occupancy-and-composition.md) — the occupancy and composition series | 8 | 5 |
| Orchestrator chat | [orchestrator-chat.md](verification/orchestrator-chat.md) | 12 | 22 |
| Taskboard | [taskboard-board-and-tools.md](verification/taskboard-board-and-tools.md) — the board, its MCP tools and validation | 12 | 6 |
| Taskboard | [taskboard-comments.md](verification/taskboard-comments.md) — task comments and threads | 7 | 2 |
| Taskboard | [taskboard-dependencies.md](verification/taskboard-dependencies.md) — task dependencies and their drawing | 5 | 4 |
| Workflows and schedules | [workflows-and-schedules-loop-sections.md](verification/workflows-and-schedules-loop-sections.md) — a loop's repeated section: frames, marking, passes and pick-ups | 18 | 4 |
| Workflows and schedules | [workflows-and-schedules-general.md](verification/workflows-and-schedules-general.md) — the canvas, instances, schedules, and a loop's region, link and board stop, review blocks | 13 | 12 |
| Concurrency and ownership | [concurrency-and-ownership.md](verification/concurrency-and-ownership.md) | 17 | 7 |
| Isolation and landing | [isolation-and-landing.md](verification/isolation-and-landing.md) | 12 | 11 |
| Git and review | [git-and-review.md](verification/git-and-review.md) | 11 | 9 |
| Agents, templates and models | [agents-templates-and-models.md](verification/agents-templates-and-models.md) | 20 | 9 |
| Other providers | [other-providers.md](verification/other-providers.md) — Codex, and the local provider | 14 | 8 |
| Knowledge and plugins | [knowledge-and-plugins.md](verification/knowledge-and-plugins.md) | 16 | 11 |
| Dreaming | [dreaming.md](verification/dreaming.md) | 2 | 1 |
| Retention | [retention.md](verification/retention.md) | 2 | 2 |
| Security and sandboxing | [security-and-sandboxing-cli-sandbox.md](verification/security-and-sandboxing-cli-sandbox.md) — the CLI's sandbox, bwrap, seccomp, mount points and the write set | 17 | 12 |
| Security and sandboxing | [security-and-sandboxing-privilege-and-auth.md](verification/security-and-sandboxing-privilege-and-auth.md) — the privilege split, credentials, auth and containment | 11 | 10 |
| Security and sandboxing | [security-and-sandboxing-stacks.md](verification/security-and-sandboxing-stacks.md) — a stack's tool grants and permissions | 12 | 4 |
| Container and environment | [container-and-environment-resources.md](verification/container-and-environment-resources.md) — memory, CPU, cgroup limits, OOM and the filter launcher | 6 | 5 |
| Container and environment | [container-and-environment-stacks.md](verification/container-and-environment-stacks.md) — the stacks carrier, its installs, receipts and invocation counts | 20 | 7 |
| Container and environment | [container-and-environment-deployment.md](verification/container-and-environment-deployment.md) — the image, network, volumes, backup and health | 9 | 13 |
| Build and release | [build-and-release.md](verification/build-and-release.md) | 4 | 0 |
| Interface | [interface-ascii-skin.md](verification/interface-ascii-skin.md) — the ascii skin | 17 | 4 |
| Interface | [interface-styles.md](verification/interface-styles.md) — buttons, contrast, colour and legacy CSS | 8 | 0 |
| Interface | [interface-app-shell.md](verification/interface-app-shell.md) — the toolbar, drawer, sheets and shared layer | 6 | 2 |
| Interface | [interface-narrow-viewports.md](verification/interface-narrow-viewports.md) — pages at 390px, layout sweeps and smoke-pages | 15 | 9 |
| Interface | [interface-canvases.md](verification/interface-canvases.md) — the graph canvases, touched map and replay | 5 | 2 |
| Interface | [interface-pages-and-api.md](verification/interface-pages-and-api.md) — pages, panels and API payloads | 20 | 12 |
| **Total** | | **402** | **256** |
