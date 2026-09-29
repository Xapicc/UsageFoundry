# The nightly clock

[← dreaming index](../dreaming.md)

Read before editing `startDreaming`, `armDreaming`, `dreamingDue`, `reconcileDreamingOnBoot` or `liveDreamingRun` in `src/lib/dreamingRun.ts`.

**The clock copies three of `schedules.ts`' rules and each was learned
expensively.** The timer *stops* rather than skips when the data-directory claim
is lost, because two processes deciding one night is two agents writing into one
vault. A tick already running does not stack. And **a boot never catches up**:
`reconcileDreamingOnBoot` moves the cursor to the current night whatever it
finds, so a server coming back at noon writes nothing about an 03:04 that passed
while it was down. The cursor is a night key rather than an instant, and it is
advanced *before* the work so a night that throws is not retried every minute
until midnight.

**The cursor is an instant and never a day, and this is the fault that would
have stopped the feature dead.** `reconcileDreamingOnBoot` exists to stop a
restart replaying a window it missed — `reconcileSchedulesOnBoot`'s rule. It set
a `YYYY-MM-DD` day key, and the tick returned whenever `cursor === today`, so a
boot closed **the rest of that calendar day** along with the window it meant to
close. This server restarts on every `docker compose up --build` and on every
host reboot, so on a machine rebuilt most days the nightly pass would have fired
approximately never, with an empty Nights tab and no error anywhere.
`schedules.ts` keys on an instant for precisely this reason. `dreamingDue` is
split out from the tick so the clock can be tested without a timer, and a cursor
that has never been set does **not** fire — it arms instead, so a fresh install
or a restored backup cannot start an agent because of a window it has no record
of deciding.

**Enabling the setting arms the clock, because `startDreaming` at boot alone was
a switch with no timer behind it.** `armDreaming` sets the cursor only when
there is none: the settings page re-sends every field on every save, so
re-arming unconditionally would push the cursor past a window about to fire and
give a nightly job that silently skips any day the operator opened Settings. And
turning the switch on never fires a window that has already passed — that is a
press of Save, not a press of Run, and the pane carries an explicit button for
the case where the operator does want it now.

**A night refuses while the previous one is still running.** Nothing else
stopped two nights overlapping, and what they would overlap in is the operator's
live document store — `knowledge.ts:39`–`:44` refuses a background writer over
exactly that hazard, and two of our own agents editing one vault is the same
hazard with this app on both ends of it. `liveDreamingRun` keys on the
`dreaming:` prefix in `origin_ref`, because `origin` is `schedule` or `form` and
every other run in the app uses both. Every non-terminal status counts as in
flight, `queued` and `paused` included. The run also carries a wall-clock cap:
six cycles has no bound in time, and the thing being bounded is how long an
agent holds somebody's vault open.
