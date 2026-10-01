# 10: Comparison

## 1. The facts, side by side

Columns are the options as shaped in their files. The B, C and F columns are
their defensible variants: B pull-only, C split into its two forms, F split into
its two relays.

| | A nothing | B board | C-new | C-board | D native | E git notes | F-operator | F-chat | **G see** |
|---|---|---|---|---|---|---|---|---|---|
| C3: starts, wakes or extends a run | **CLI extends a cycle** | no | no | no | **extends a cycle** | no | no | no | no; **removes the extension** |
| C4: widens what a run may do | **plan → acceptEdits** | narrows peers | request to write | framed as a task note | **plan → acceptEdits** | no | no | no | no; **removes the widening** |
| C1: scope | **container** | repository | repository | repository | **container** | repository + remote | any | any | repository |
| C5: operator can read every message after | board yes, **CLI no** | new page | new view | task page | only if logged | shell only | yes | yes + thread | nothing new is said |
| C6: survives restart | board yes | yes | yes | yes | no | yes, forever | yes | turn lost | n/a |
| C8: topology | **peer, forwardable** | **broadcast** | addressed | addressed | **peer, forwardable** | broadcast, mutable | hub, human | hub, model | **no new text** |
| C8: authorship | token / none | token | token | token | session name | **none** | operator | chat | n/a |
| Free text from a run reaching another | yes, two ways | yes | yes | yes | yes | yes | after a person reads | after a model reads | titles only, already shown |
| Measured cases it addresses (9 + 3 + 4 duplicate filings, 1 redo) | 0 | some, if read and found | redo, which the run already knew | redo, likewise | 0 | redo, likewise | late | late | **filings: up to all 25 pairs by search; redo: no** |
| Standing cost a week | 0 | ~$8 | ~$8 | ~0 | 0 | 0 | 0 | per turn | ~0 |
| Build | 0 | 1-2 d | 2-3 d | ~1 d after G3 | ~1 d, unscopable | hours | 0 | 0 | **~1.5 d** |
| Needs a person present | no | no | no | no | no | no | **yes** | **yes** | no |

The "measured cases" row comes from `python3 scripts/search_would_find.py`. For
all 25 near-duplicate title pairs filed by concurrently live runs, one word of
the later run's own title, searched as a case-folded substring, matches the
earlier task. That is an upper bound:

- 10 of the 25 match on a test name (`TestEveryHelpPageListsEveryFlagItsCommandDefines`).
- The other 15 match on a word as generic as `dockrac` or `compile`, which would
  also return unrelated tasks.

Whether a run would search, and on which word, is measured only after G2 ships
([`13-validation.md`](13-validation.md) §2).

## 2. Why there is no weighted score

C3, C4 and C8 are vetoes, not weights. The brief says a message "must never
start, wake or extend a run", and that nothing may "set or widen" what a run may
do. An option that does either is out whatever it scores elsewhere. A weighted
sum would let build cost or reach buy back a failure the brief does not allow.
ContinuousImprovement weighted ten criteria
(`proposals/ContinuousImprovement/15-comparison.md:53`-`:70`), but none of its
criteria was a "never".

The vetoes remove three columns. **A** (its CLI half), **D**, and **E**, which
fails C5 and C8 rule 2 with no author and no horizon. What remains is ranked on
two questions: how much new free text between runs does it create, and how much
of the measured need does it address?

## 3. What dominates what

- **G dominates B.** B adds a broadcast free-text store next to the board. G
  makes the board's existing contents findable. Every measured duplicate was
  already on the board when the duplicate was filed, so B's extra reach is reach
  into a need nobody measured.
- **C-board dominates C-new.** Same addressed shape, same pull, same token
  authorship. C-board needs no tool, no table and no new page, and lands its
  note where the receiver already reads them. C-new's only extra is that a
  message can reach a run holding no task.
- **G is a prefix of C-board.** C-board is G3 plus one field, the held task id.
  So the choice between them is not a fork. It is whether to take one more step,
  and that step can wait for evidence.
- **F-operator is not displaced by anything.** It is the operator's own pen and
  no option removes it. It cannot be the recommendation, because the
  measurement is of runs overlapping by hours while nobody watches.

## 4. One finding outside the question

`tasksForRun`'s own docblock predicted the nine Dockrac filings: "a run shown
twenty of sixty open tasks and told nothing files the duplicate"
(`src/lib/tasks.ts:1500`-`:1503`). It shipped the count as the cure, and the
count was there each of the nine times (69, 85, 99). Telling a run how much it
cannot see does not help it see. G2 exists because of that sentence, and it is
also a board defect independent of this survey, filed as such
([`README.md`](README.md), "Found on the way").
