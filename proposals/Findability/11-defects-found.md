# 11 — Defects found while measuring

Recorded, not fixed: this run changes no product code. None of these is in the
gap register and nothing here edits it.

## D1 — `/runs/[id]/conflicts` is missing from both hand-written lists

`src/components/shell/panes.ts:98-110`. `toolbarTitle` has an explicit case for
`/runs/[id]/touched` and none for its sibling `/runs/[id]/conflicts`, so the
conflicts screen falls through to `if (pathname.startsWith("/runs/")) return
"Run"` and its toolbar reads "Run". The comment at `:100-102` describes precisely
this failure — "a toolbar saying 'Run' over a screen that is not the run page is
the one breadcrumb an operator has" — five lines above the code that causes it.

```
$ grep -rn 'conflicts' src/components/shell/
(no matches)
```

`touched` arrived `cdba0d3` on 2026-08-27 and was registered; `conflicts` arrived
`834f383` on 2026-08-28 and was not. The page is also absent from `PANES`, so it
is unreachable from quick open.

This is item 2's worked example (§10) and the empirical basis for §03's argument
against hand-maintained registries. Whether to fix it as a one-line case or to
close the class by deriving the list is exactly the choice §08 puts.

## D2 — dead `haystack` on quick open's run items

`src/components/shell/QuickOpen.tsx:227` computes
`haystack: \`${run.id} ${run.status} ${run.folder}\`.toLowerCase()` for every run
item. Nothing reads it: with no needle nothing is filtered (`:238-240`), and with
a needle run items bypass the client filter at `:249` because the server already
matched (`:241-246`).

It is also inconsistent with the server it stands in for — the SQL matches
`prompt`, `folder` and `id` (`orchestrator.ts:1044-1049`) and not `status`, while
this string matches `status` and not `prompt`. Harmless today; a trap for whoever
next changes the filter shape and assumes the field is live.

## D3 — the request log is written and never read

`recentRequests(limit = 50)` at `src/lib/requestLog.ts:139` has no caller outside
its own module:

```
$ grep -rn "recentRequests" src/ | grep -v "requestLog.ts"
(no output)
```

`auditMutation` writes to `request_log` (`src/lib/db.ts:1293`) and wraps mutating
handlers across the API — `plugins/route.ts:62`, `templates/route.ts:61`,
`workflows/route.ts:70` and others — but no route and no page reads the table
back. The audit trail exists and is
unreachable from the app.

This is a findability defect of a different kind from the survey's subject: not
"hard to search" but "no surface at all". It is not folded into §10 because
building an audit view is a feature decision, not a search mechanism, and it
should be argued on its own terms. `recentOpsEvents` (`src/lib/ops.ts:183`) is
nearly the same case — its only caller is `recentOpsEvents(1, "boot.reconciled")`
at `src/app/api/runs/route.ts:148`, so 19 of its 20 default rows are never asked
for.

## Not a defect: the register disagreeing with itself about G2

`proposals/GapRegister/03-growth.md:103` describes G2 as open at `66fdbab`;
`05-register.md:56` records it closed by `7d7e3f3`. That is the survey-snapshot
versus live-register split the register's own reconciliation pass owns. Noted so
the next reader does not chase it.
