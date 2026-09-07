# Taskboard

**What this is:** one file, [`mockup.html`](mockup.html) — a picture to argue
with about **shape**. Open it with a double-click. No build, no server, no
network, nothing imported from `src/`.

**State:** the operator has decided to build the Taskboard. This directory
therefore contains **no options, no recommendation, and no case for or against
it existing** — unlike every other directory under `proposals/`, which surveys a
question. Four other proposals build the real thing; this one draws it. The
mockup says so in its own banner, so a reader who arrives at the file without
this README is told the same thing.

**The data is fake.** Every task, folder, workspace, run id, count and timestamp
in it is invented by the seeded generator at the foot of the file. Nothing reads
the database, a transcript or `run_events`, and there is no task table in this
repository. Each drawn frame carries its own *FABRICATED DATA* chip so a
screenshot cropped to one frame still says so.

## What it shows

Ten sections, numbered in the file.

1. **The pane in situ** — the whole app shell with a Taskboard row inserted
   directly after Runs, plus the shortcut ledger that insertion produces.
   `src/components/shell/panes.ts:12-18` numbers by position and nine is the
   ceiling, so **six digits move and API account loses ⌘9**. That cost is drawn,
   not argued.
2. **The board** — cross-project by default, grouped open / claimed / done,
   priority-ordered inside each group, Done collapsed rather than absent. Every
   row carries its workspace and folder, an origin badge, and links to the runs
   that filed, claimed and completed it.
3. **The filter**, off and on, side by side.
4. **390px** — the board and the drawer, beside the 1280px frames rather than
   behind a window resize.
5. **Forty-four tasks across eleven folders**, generated, so "does the grouping
   still read at that size" can be looked at.
6. **The three kinds of nothing** — empty, filter matched none, fetch failed —
   drawn as three deliberately unalike pictures, which is what
   `docs/agent/dreaming.md:166` already asks of this app.
7. **A claim held by a run that crashed.** A claim is a record with no clock on
   it; nothing expires it.
8. **The four origins on adjacent rows**, including one a run filed at 03:07.
9. **Light and dark drawn at the same time**, each frame forcing its own
   `color-scheme`, so the dark side is not left to the toggle.
10. What it does not decide.

## What it deliberately does not decide

- **Whether the pane belongs after Runs.** The brief put it there; the mockup
  draws what that costs and does not argue the placement, and does not argue
  that API account should be the pane that loses its digit.
- **Any schema, route, DTO, poll or write path.** No `/api/tasks`, no table, no
  statement about who may write what.
- **Nesting versus a backlink** when a child task's status differs from its
  parent's. §2 draws one of the two, names the other, and shows the two counts
  that disagree either way.
- **What a priority is** or who sets it. P1/P2/P3 stand in for an ordering.
- **Whether Done is terminal.**
- **The icon.** The sidebar glyph is fabricated for the drawing;
  `src/components/ui/Icon.tsx` is untouched and has no `taskboard` name.
- **The answer to §5.** A per-folder sub-heading, a second sort control and a
  density toggle are all named there and none is drawn.

## Conventions

Design tokens are **copied by hand** out of `src/app/globals.css` at commit
`2d07f09` and recorded in the file's header comment; they drift silently the
moment that file is edited, and where the two disagree the app is right. The
same conventions as
[`proposals/implemented - SessionFlow/mockup.html`](<../implemented - SessionFlow/mockup.html>)
and
[`proposals/ExternalValidator/external-validator-mockup.html`](../ExternalValidator/external-validator-mockup.html).

## Verified

Driven in the container's Chromium (Playwright), at 1440×900 and 390×844, in
both `light` and `dark`: **no console errors, no page errors, no failed
requests, and no sideways scroll** — neither on the document nor inside any of
the five 390px frames. Every section was screenshotted in both themes and
looked at. The mockup is a static file, so `npm run smoke-pages` does not and
should not cover it; it is written for `src/app/**/page.tsx`.
