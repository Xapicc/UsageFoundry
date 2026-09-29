# The pane, its row in the sidebar, and `list_recurring_failures`

[← dreaming index](../dreaming.md)

Read before editing `src/app/dreaming/`, `src/app/api/dreaming/`, Dreaming's row in `src/components/shell/panes.ts`, or `list_recurring_failures` in `src/app/api/mcp/route.ts`.

**The pane must keep three kinds of nothing apart**, and an empty table is the
wrong answer to all of them: never configured (a sentence and a link to
Settings), ran and wrote nothing (the **success** case for a write-on-recurrence
policy — six of the twenty-three measured days had no failure reach a second day,
and it must not read as a failure), and ran and failed (a link to the run).
`dreaming_nights` exists separately from `dreaming_notes` for exactly this: a
night that wrote nothing leaves no note rows, so a pane reading only the notes
cannot tell it from a night that never ran. **`present` is three-valued for the
same reason** — `true`, `false`, and `null` for "no path to check, or the vault
is unreachable" — because a mount that has gone must not report every note this
app ever wrote as deleted.

**The pane does not poll.** Its subject moves once a night, and a 120-second poll
against a table that changes at 03:04 is 720 requests for an answer that cannot
have changed, with nothing for the re-arm logic in `conventions.md` to key on. It
loads on mount and offers a rescan; a run in flight is watched on `/runs`, which
already does this properly. And **it offers no control that starts a run beyond
the explicit press**, on quick open's rule: a keystroke away from spending money
is what every approval gate in this app exists to prevent, and a readout is
exactly where a Run Now button looks convenient.

**Both lists on the pane say when they are cut.** `git-and-review.md`'s rule,
and it matters most here: the notes table is the record of what this app has
written into a store with no version control, so a list that silently stopped at
500 would read as complete when it is not.


**The orchestrator reads both halves through `list_recurring_failures`, and the rules above follow it there.** It is the readout joined to the ledger, and it keeps the pane's disciplines rather than inventing its own: the signature caveat is in the tool description and in the payload, not only on the page; notes and not-yet-written signatures are two lists, and an empty notes list says which kind of nothing it is — Dreaming off, on and not yet written, or a query that matched no note; a note's absolute path is handed over only when `noteStillPresent` answers `true`, because a stored path is what a run reported; and the suppression set is `writtenSignatures()` rather than the capped `listNotes()`. It writes nothing, needs no setting, and works with Dreaming off, which is the readout half's own property.

**The pane is the ninth row, directly under Knowledge, and `Pane.shortcut` is
optional because of where that leaves the digits.** It reads as a readout of what
the install did to itself, which is nearer in kind to the vault than to the two
configuration panes it used to sit below, and the operator asked for that order
knowing what it costs. The digit follows the row's position, so Dreaming is ⌘9,
and **both API account and Settings, the tenth and eleventh rows, carry no
shortcut at all** — ⌘1…⌘9 is nine digits against eleven rows. Dreaming held ⌘8
and API account held ⌘9 until Taskboard went in fourth and pushed every row
beneath it down one (`4bc98a5`): Dreaming's ⌘8 became ⌘9, and API account,
pushed past the ninth row, lost its digit outright and joined Settings in
having none. The earlier arrangement put Dreaming last and kept ⌘9 on Settings,
on the ground that Settings is where somebody goes when something is wrong;
that trade was overruled, not forgotten, and both API account and Settings
stay one press away in quick open. The one thing that may never be done is the
compromise between the two — a digit that names the ninth row and lands on the
tenth is exactly the failure `panes.ts`'s position rule exists to prevent, so
moving a pane and leaving the digits alone is not an option.

Both readers that put the digit into a string — `Sidebar.tsx`'s
`aria-keyshortcuts` and `QuickOpen.tsx`'s `detail` — were unguarded and failed
*silently*: a screen reader announcing `Meta+undefined`, a palette printing
`⌘undefined`, neither a type error nor a throw. The optional field makes that a
compile-time obligation rather than a warning in a docblock, and it is why this
reordering needed no change in either reader. The docblock in `panes.ts` that
stated the ceiling was itself once wrong about which row sat on it (it said
Knowledge, which has been eighth since it moved above the two configuration
panes and is eighth still, with Dreaming under it).
