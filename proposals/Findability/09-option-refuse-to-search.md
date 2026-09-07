# 09 — Option 6: decide that some of these should not be searchable

**Verdict: accepted, and it is a third of the recommendation.**

F2 lists five kinds as unfindable and treats them as one problem. §01 shows they
are not. This file states the positive decision, because a survey that only adds
mechanisms has not made one.

## The test

A kind deserves a search surface when **its size is set by the machine rather
than by the operator**. A corpus an operator personally typed is one they can
scroll; a corpus the app generated while they slept is one they cannot.

By that test:

| Kind | Size set by | Verdict |
|---|---|---|
| runs | the machine — one per started task | search (has it) |
| chat threads | the operator, but per conversation, unbounded over time | search (has it) |
| knowledge notes | outside the app entirely — 1,415 measured | search (has it) |
| **branches** | the machine — 141 measured, 143 fifteen minutes later, 121 auto-named | **search (missing)** |
| **dreaming notes** | the machine — written unattended, capped at 500 | **search (missing)** |
| agents | the operator, by hand, one at a time | **no search** |
| templates | the operator, by hand, one at a time | **no search** |
| schedules | at most one per workflow (`db.ts:520` `UNIQUE`) | **no search** |
| workflows | the operator, by hand | **no search** |

## What "no search" must mean, or the refusal is just neglect

Refusing search only holds if the list is **complete and ordered for scanning**.
Measured, it already is:

```
$ grep -n 'export function listAgents' -A3 src/lib/agents.ts
821: SELECT ${COLUMNS} FROM agents ORDER BY name COLLATE NOCASE
$ grep -n 'export function listTemplates' -A7 src/lib/templates.ts
375: SELECT ${COLUMNS} FROM run_templates ORDER BY name COLLATE NOCASE
$ grep -n 'export function listWorkflows' -A5 src/lib/workflows.ts
1490: SELECT ${WORKFLOW_COLUMNS} FROM workflows ORDER BY name COLLATE NOCASE
```

No `LIMIT` on any of the three. All three sort by name, case-insensitively, and
`templates.ts:376-377` gives the reason: "the picker is a list a person scans, and
the order they scan it in should not depend on which one they last touched."

**The refused option's goal is already met, by a cheaper property than search.**
That is the strongest form a refusal can take, and it means this third of the
recommendation costs nothing to implement — it costs a decision, written down, so
the next person does not spend a week adding search to a list of eight agents.

## The one exception, and it is B5

Folders are an operator-scale set — 15 repositories measured on this machine — and
they are the one Tier-B list that is **capped**. B5
(`proposals/GapRegister/02-backend-logic.md:321`) records the chat identifying
only the first 25 repositories, always the same 25, at
`src/lib/workspace.ts:168,186-188`. A sibling run is patching it.

That fix is exactly the right shape and it is the argument for this option in
miniature: the answer to "the chat can only name 25 repositories" is **raise or
remove the cap**, not "give repositories a search index". Nothing in this survey
should be read as widening that fix, and this survey does not touch it.

## What refusing does not mean

It does not mean these kinds should be unreachable. Every one of them has a pane
one keystroke away — `/agents` is ⌘5, `/workflows` is ⌘4
(`src/components/shell/panes.ts:46-47`). Templates and schedules have no pane and
no page of their own, which is a **navigation** gap and not a search gap, and it
is the gap §08 closes by deriving destinations.

The claim is narrow and it is this: **a list of things you wrote yourself does not
need a query interface, and building one for it is how an app ends up with five
search mechanisms and no answer to where its 141 branches went.**
