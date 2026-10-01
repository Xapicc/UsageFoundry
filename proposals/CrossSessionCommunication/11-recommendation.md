# 11: Recommendation

## In one line

**Runs should see each other and not talk to each other.**

1. Close the channel the CLI already opened (G1).
2. Let `list_my_tasks` search the board (G2).
3. Give it a roster of live siblings that carries no text a run wrote beyond
   task titles it already shows (G3).

Build no message channel of any kind until the falsifier below fires.

## The case

1. **A channel exists, and it is the wrong one.** Every work cycle on this
   install has container-wide peer messaging through the pinned CLI. Runs have
   used it to see their siblings: 23 of 39 `ListAgents` calls listed another
   live session. It fails four constraints at once:
   - C3: an arriving message extends a live cycle by a turn.
   - C4: `plan` and `acceptEdits` share an acceptance class.
   - C5: the receiver's log most likely carries nothing.
   - C8: it is peer to peer, forwardable, and spans repositories.

   Nobody chose it, no run has needed it (0 peer sends in 21 `SendMessage`
   calls), and one environment variable closes it while keeping every measured
   use of `SendMessage`, which is the run's own sub-agents.
2. **The need is real, and it is a need to see.** Siblings are live together 80%
   of the time, 63 of 80 paid conflict resolutions were between live siblings,
   and siblings filed the same task up to nine times. But:
   - Every duplicate filing was a task already on the board, behind a 20-row
     clip.
   - For all 25 concurrent duplicate pairs, one word of the later title matches
     the earlier, 10 of them on a distinctive identifier.
   - The one redone fix was redone with the sibling's commit in view.

   No case needed a sibling's words.
3. **Collisions are not a messaging problem.** The top conflicted files are
   indexes both runs must append to: `CLAUDE.md`, `docs/verification.md`,
   `docs/agent/testing.md`. "I am editing `CLAUDE.md`" removes no edit.
   ContinuousImprovement's contention card is the instrument for that
   (`proposals/ContinuousImprovement/README.md:10`-`:15`).
4. **Talking is how injection spreads.** *Prompt Infection* finds multi-agent
   systems "highly susceptible, even when agents do not publicly share all
   communications", and finds tagging effective only alongside other safeguards.
   G adds no new run-written text to anything another run reads, which is the
   only position the evidence does not argue against.
5. **The literature's positive case is the property this install already has.**
   The one clear multi-agent win in *Orchestration Topologies* rests on
   "isolated per-worker workspaces". Isolation is on by default here. More
   talking agents mostly lose, at worse accuracy per dollar (*Do More Agents
   Help*).

## The order

- **G1 first, alone, now.** It closes something open. It does not depend on G2
  or G3, and nothing in this survey's evidence is a reason to wait.
- **G2 next.** It is the direct fix for the only repeated, measured waste
  between live siblings.
- **G3 last.** It is the least evidenced part. [`13-validation.md`](13-validation.md)
  §2 says what has to be seen for it to have earned its place. If the roster
  goes unread, delete it.

## Refused by name

- **The notice board (B)**, as the broadcast shape C8 ranks worst. It would be a
  second store beside the one that already held every measured answer.
- **App-built direct messages (C-new)**: one tool, one table and one page, for a
  need with no measured instance.
- **Native messaging, logged (D)**: it extends cycles and widens modes by
  construction, and its reach is the container and cannot be narrowed from
  outside the CLI.
- **Git notes or a file in the tree (E)**: no author, no horizon, mutable, and
  pushed off the machine with the repository.
- **The chat as a standing relay (F-chat)**: it moves the judging to the most
  privileged child in the app. The operator may still ask it to, while present.
- **Delivery into the appended system prompt or the app-composed `-p` slot**,
  for any option. The app composing a peer's words lends them the app's
  authority. The board's own rule refuses this for notes
  (`docs/agent/taskboard/comments.md:63`-`:69`).
- **Any message that wakes, starts or prolongs a run.** That is spend with
  nobody present.

## What would overturn this

**After G2 and G3 have run for two weeks, a duplicate or a redo between live
siblings where the first run had established the fact but had not yet recorded
it anywhere a sibling could see.** That means no task filed, no commit on its
branch, and no note on a task. That gap between knowing and recording is the
one place state cannot reach and a message can.

`scripts/dup_tasks.py` and `scripts/keyword_hunt.py`, re-run over the new
window, find candidates. Each is then read by hand to see whether the earlier
run's first record postdates the later run's start. Two such cases in the
window overturn the "do not talk" half.

Two smaller facts would change a part rather than the whole:

- If the receiving side of U1 shows the CLI channel is in fact fully logged on
  both sides and does **not** extend a cycle, G1 is still right on C4 and C8,
  but D's verdict softens from "close" to "close because of reach".
- If `CLAUDE_CODE_HARBOR_KITE` is renamed at a pin bump, G1's mechanism changes.
  Its decision does not.

## Runner-up

**Option C-board**: G3's roster plus each sibling's held task id, so a run can
leave a note on the task a sibling is working. The note reaches the sibling at
its next `list_my_tasks`, signed by the token, permanent, on the task page. It
adds no tool, no table and no new page, and it is the smallest step that lets
runs talk. It wins as soon as the falsifier above fires. It is not recommended
now, because nothing measured needs it, and it gives every run the ids of its
siblings' tasks: a small, permanent widening of who can write where.

## If overruled

If the operator wants runs to talk now, build C-board, and build it after G1,
never instead of it. Any app-built channel beside an open CLI channel is a
logged door next to an unlogged one. Keep the CLI channel closed even then:
every argument in [`06-option-d-native-messaging.md`](06-option-d-native-messaging.md)
holds whether or not the app has a channel of its own.
