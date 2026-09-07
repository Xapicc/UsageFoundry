# 07 — Option 4: a query language

**Verdict: REFUSED.**

## What it is

`status:running repo:usagefoundry agent:reviewer since:2d "stale cache"` — a
parsed grammar over field:value pairs, one input, every kind.

## Refusal 1 — nobody is straining against the expressiveness

Four text inputs exist in the whole app (§02), no two of them sharing a
mechanism. The measured problem is that fifteen of nineteen pages have **no**
search, and that 56 of 68 routes take no query input at all. The gap between "no search box" and "a search box" is the
entire distance; the gap between "a search box" and "a search box with a grammar"
is a refinement of a surface that does not exist yet.

`proposals/GapRegister/06-recommendation.md` makes exactly this argument against
point fixes ahead of the question. Building a grammar for a corpus nobody can
currently reach is the same error inverted.

## Refusal 2 — the structured filters it would compose barely exist

A query language is a front-end to structured filters. §02 counts every parameter
the API accepts. Outside `limit`/`offset`/`q`, the whole list is: `tag` (×2),
`tz`, `type`, `status`, `sort`, `signature`, `settledBefore`, `repo`, `path`,
`kinds`, `history`, `folder`, `days`, `after`. Most appear once, on one route.

`status:` would compile to `/api/runs?status=` and nothing else — no other route
has a status parameter. `repo:` exists on `/api/branches` and nowhere else.
`agent:` does not exist at all; `runs` has no agent filter. A grammar over that
set is a grammar with two working keywords.

## Refusal 3 — it is the largest remembering of any option

Every filterable field must be added to: the grammar, the compiler that maps it
to a route parameter, the error message for an unknown key, and the help text
that tells the operator the key exists. Four places per field, versus §03's
measured one-in-two success rate on one place.

And a query language has a failure mode the others do not: **a mistyped key must
be an error, not zero results.** `stauts:running` returning "no matches" is worse
than no search, because it is confidently wrong. Getting that right means a
closed keyword vocabulary that stays in sync with 68 routes — which is
`panes.ts`'s problem with more entries.

## Refusal 4 — the app's own copy rules make it expensive

`CLAUDE.md`: "The UI says 'work cycle', the code says 'iteration'." A query
language forces the operator to type field names. Every field name becomes
user-facing copy and falls under that rule, so `iteration:` may not be the
keyword and `maxIterations` may not appear in the help. That is a translation
table between the grammar and the schema, maintained by hand, forever.

## What would make this option win

An operator repeatedly filtering the same list on two axes at once — the concrete
observation being someone using the runs page's `status` control and its search
box together and still not narrowing enough. That is measurable and it has not
been measured. Until then this is a mechanism in search of a complaint.
