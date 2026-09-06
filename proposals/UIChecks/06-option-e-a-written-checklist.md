# Option E: a written manual checklist

The cheapest thing on the list, the one the repository is already half doing,
and the only one that reaches class E.

## What it is

`docs/verification.md` already holds **33 entries** on its *"Not yet verified by
hand"* list, several of them narrow-viewport claims, and its own header calls
that list the thing that "must stay honest". This option turns the list from a
backlog into a **procedure**: a numbered pass somebody performs before a
release, page by page, at two widths, with what to look at written down.

## What it buys

It is the only option that reaches the judgements no engine makes: whether the
copy is right, whether the reading order makes sense, whether the ring reads as
loud. The evidence is unusually clear that this residual is not small and does
not shrink with better tools — the boundary every source agrees on is that
**automation decides whether a mechanism is present and never whether its
content is adequate**, and that boundary is where most of this interface's
value lives.

It also costs nothing to adopt, contradicts nothing, and composes with every
other option on this list.

## What it cannot buy

**It does not run.** A checklist is performed when somebody remembers, at the
rate a person can perform it, and 19 pages at two widths is not a five-minute
pass. Its coverage is exactly the discipline of whoever holds it, which on a
one-operator install is a real and honest answer and on a bad week is zero.

It also cannot catch a regression *between* passes, which is the thing a check
is for. The `w-auto` defect was found by a person; the question is how long it
was there first.

## The form that is worth having regardless of what else is chosen

Not a general "check the UI" instruction. A list bound to what this app has
actually got wrong and to what it argues about:

1. Every page at 390px: nothing scrolls the body sideways, no control is
   clipped, every `stack`ed table names its fields.
2. Every page in both themes.
3. Keyboard: tab through each page's primary flow; the focus ring is visible on
   every stop.
4. The controls that need state to exist at all, named individually, because
   they are the ones no automated option reaches without seeding: a queued run's
   priority input, the Deliver button, the Backups row's unreadable state, the
   chat turn's live view.

That list is short, specific, and its four entries are the ones that would
otherwise be verified by nothing.
