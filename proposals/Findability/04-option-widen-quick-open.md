# 04 — Option 1: widen quick open's corpus

**Verdict: refused as a shape. Accepted only as a consumer of route-level `q=`.**

## What it is

Add agents, templates, branches, dreaming notes and chats to
`src/components/shell/QuickOpen.tsx` as further sources, so ⌘K finds them. This
is the mechanism F2 prescribes.

## What it would actually catch

An operator who knows an agent is called something like "reviewer" and wants it
without leaving the keyboard. Real, and small: `listAgents`
(`src/lib/agents.ts:821`) already returns every agent, so the same operator can
press ⌘5 and read the whole list.

It would **not** catch the case §01 measures as the large one. Branches are 141
rows whose names are 121 machine hashes; a quick-open row filtered on
`branch.name.toLowerCase().includes(needle)` — the shape workflows use at
`QuickOpen.tsx:235` — matches nothing an operator would type.

## What it costs to build

There is no source registry. `QuickItem` (`:43-51`) is a shared row shape, but
nothing iterates over sources. Adding one means editing six places:

1. a `useState` beside `:99-102`
2. an entry in the `Promise.all` at `:117-120`
3. an `.ok` guard and setter at `:126-127`
4. a mapping block in the memo at `:203-236`
5. a decision on server- versus client-side filtering
6. **two** spread positions — the no-needle return at `:239` *and* the needle
   return at `:247-251`

The `failure` expression at `:122` is already a nested ternary over two sources
and widens with each addition. At six sources it is a nested ternary over six.

Item 6 is the one that bites: the two return paths are separate lists, and a
source added to one and missed in the other is a kind that is findable only when
the box is empty, or only when it is not. That is the same class of defect
`panes.ts` already exhibits (§03) in a component that is one function longer.

## What it costs to keep correct

One remembering per new kind, in a component with no registry and two divergent
return paths, at a rate of one new page every 4–5 days (§03). §03's measurement
of how that goes is one-in-two.

## The deeper objection

Quick open is a **jump-to** surface, not a search surface. Every one of its rows
resolves to an `href` (`:213`, `:222`, `:233`) and the result of pressing one is
navigation. It is the right home for destinations and for things with a page of
their own. Of F2's five kinds, **agents, templates and schedules have no page of
their own at all** — there is no `/agents/[id]`, no `/templates/[id]`, no
`/schedules`. `src/app/api/agents/[id]/route.ts` exists; no page consumes it.
Quick open would have to invent destinations for them, or route every hit to the
same list page with a fragment, which is a worse list than the list.

## Where it stays useful

Once `/api/branches` takes a `q` (§10, item 1), quick open gets branch results
for free by adding one fetch — and, critically, it gets them **filtered on the
server against `runs.prompt`**, which is the only text that identifies a branch.
The same is true of dreaming notes. That is a legitimate and cheap extension and
this survey does not oppose it.

What it opposes is treating corpus-widening as *the answer*. F2 half-shipped by
that route already: `/api/runs?q=` was added, quick open consumed it, and the
question "what else is a corpus and why" was never asked — which is precisely the
failure `proposals/GapRegister/06-recommendation.md` names.
