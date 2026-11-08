# How repeatable the shipped preamble's 32/37 is

`RESULT.md` ends its shipped-preamble section with "Each case was judged once", and
the control it ran covered three cases. This is the repeat over all 40, to put a
spread on `32/37`. Board task `b53195d0`; 2026-11-08.

**Result: 38 of 40 cases got the same verdict in all three samples; two cases (7 and
17) did not. The held-out score across the three samples was 32, 31 and 32 of 37.**

## What was run

- **Requests.** The 40 shipped-preamble requests were regenerated with
  `node scripts/validator-spike/score.mjs --emit --shipped --build-dir .test-build/spike --io-dir <dir>`
  (build: `npx tsc -p tsconfig.test.json --outDir .test-build/spike` at the head of
  this branch). They are not committed, as `io-shipped/`'s are not. Their median is
  36,353 characters, the same median `score-report-shipped.md` records for the original
  run. `validation.ts` and `validationHistory.ts` changed between `4fd7c103` (the
  original run's source) and now, but only in the history evidence, which `history:
  null` leaves out; `diff.ts` did not change. Byte equality with the original requests
  was **not** checked, because those files were not kept.
- **Judges.** 80 Agent-tool subagents, `model: "sonnet"`; all 337 assistant messages in
  their transcripts report `claude-sonnet-5-5`. Two samples per case, called `r1` and
  `r2`, one judge per sample. Each was told to `Read` its one request file, open
  nothing else, `Write` its reply to a named file and read it back. Their transcripts
  hold 198 `Read` and 102 `Write` calls and nothing else, all on the judge directory,
  so no judge looked at the repository. That is the transcripts' account; the tools
  were not restricted.
- **Replies.** `io-shipped-repeat/r1/` and `r2/`, 40 files each. `score.mjs --collect
  --shipped` parses 40 of 40 in both, and its tallies are `score-report-shipped-r1.md`
  and `-r2.md`.
- **Compared with** `io-shipped/`, the original shipped-preamble run in `RESULT.md`.

## The score, three times

| sample | held-out agreement | all 40 | false-finished (held-out) | false-not-finished (held-out) |
|---|---|---|---|---|
| original (`io-shipped/`) | 32/37 | 33/40 | 0 of 1 | 0 of 29 |
| repeat `r1` | 31/37 | 32/40 | 0 of 1 | 0 of 29 |
| repeat `r2` | 32/37 | 33/40 | 0 of 1 | 0 of 29 |

The labelled-`unjudgeable` row is 5 of 7 in all three. Neither repeat produced a
false-finished. The `r1` dip is case 17 (`finished` → `unjudgeable`), which is also
the whole difference between `r1` and `r2` apart from case 7 moving the other way.

## Per-case flips

`flips` is how many of the two repeats gave a verdict different from the original's.
`shortened` shows how many files' patch bodies were dropped to fit 60 kB (— for a
whole diff); "diff B" is the whole branch diff before shortening. F/N/U are
`finished`, `not-finished`, `unjudgeable`.

| case | label | diff B | shortened | original | r1 | r2 | flips |
|---|---|---:|---|---|---|---|---:|
| 1 | unjudgeable | 0 | — | U | U | U | 0 |
| 2 | not-done | 0 | — | N | N | N | 0 |
| 3 | finished | 3,035 | — | F | F | F | 0 |
| 4 | finished | 26,384 | — | F | F | F | 0 |
| 5 | finished | 16,443 | — | F | F | F | 0 |
| 6 | unjudgeable | 0 | — | U | U | U | 0 |
| 7 | finished | 90,221 | 1 | U | U | F | 1 |
| 8 | unjudgeable | 87,272 | 2 | N | N | N | 0 |
| 9 | finished | 62,170 | 1 | F | F | F | 0 |
| 10 | unjudgeable | 0 | — | U | U | U | 0 |
| 11 | finished | 4,636 | — | F | F | F | 0 |
| 12 | finished | 59,320 | — | F | F | F | 0 |
| 13 | finished | 11,710 | — | F | F | F | 0 |
| 14 | finished | 123,375 | 1 | F | F | F | 0 |
| 15 | unjudgeable | 0 | — | U | U | U | 0 |
| 16 | finished | 54,551 | — | F | F | F | 0 |
| 17 | finished | 101,273 | 1 | F | U | U | 2 |
| 18 | finished | 82,324 | 1 | N | N | N | 0 |
| 19 | finished | 108,961 | 1 | U | U | U | 0 |
| 20 | finished | 169,258 | 8 | U | U | U | 0 |
| 21 | finished | 109,072 | 1 | F | F | F | 0 |
| 22 | finished | 36,540 | — | F | F | F | 0 |
| 23 | finished | 136,567 | 4 | F | F | F | 0 |
| 24 | finished | 0 | — | N | N | N | 0 |
| 25 | finished | 150,155 | 10 | F | F | F | 0 |
| 26 | finished | 128,275 | 4 | F | F | F | 0 |
| 27 | finished | 274,202 | 21 | F | F | F | 0 |
| 28 | finished | 2,144 | — | F | F | F | 0 |
| 29 | finished | 115,775 | 2 | F | F | F | 0 |
| 30 | finished | 14,462 | — | F | F | F | 0 |
| 31 | unjudgeable | 0 | — | U | U | U | 0 |
| 32 | finished | 40,910 | — | F | F | F | 0 |
| 33 | finished | 76,804 | 1 | F | F | F | 0 |
| 34 | not-done | 0 | — | N | N | N | 0 |
| 35 | finished | 18,965 | — | F | F | F | 0 |
| 36 | unjudgeable | 131,502 | 3 | F | F | F | 0 |
| 37 | finished | 14,425 | — | F | F | F | 0 |
| 38 | finished | 67,448 | 1 | F | F | F | 0 |
| 39 | finished | 87,308 | 1 | F | F | F | 0 |
| 40 | finished | 73,059 | 1 | F | F | F | 0 |

Totals: 38 cases unanimous, 2 not. Against the original, `r1` differs on 1 case
(17), `r2` on 2 (7, 17), and `r1` against `r2` on 2 (7, 17). Neither flip involves
`not-finished`: both are `finished` ↔ `unjudgeable`.

Cases the earlier control already sampled (`RESULT.md`): case 20 was `finished` once
in a second shipped-preamble sample; across four shipped-preamble samples it is now
`unjudgeable` three times and `finished` once, and both repeats here say
`unjudgeable`. Case 7 is `unjudgeable` in three of four. Case 8 is `not-finished` in
all four shipped-preamble samples (original, control, `r1`, `r2`).

## What the two flips are

- **Case 7** (U, U, F). The dropped file is `src/app/settings/page.tsx`, 76,865 B, which
  holds most of the task. The two `unjudgeable` replies say the settings patch was cut
  and the guard-first and save-state work cannot be checked. The `finished` reply says
  the same ("settings patch was cut") and calls the diffstat's large rewrite enough.
  This is a judge splitting on how much an unseen central file may be taken on trust.
- **Case 17** (F, U, U). The dropped file is `CLAUDE.md`, 43,260 B, a document and not
  the deliverable. Both `unjudgeable` replies give a different reason: issue `#92`'s
  acceptance criteria are not in the evidence. That is the preamble's "specification is
  somewhere you cannot read it" shape, which applies to a whole diff equally, so this
  flip is not shown to come from the shortening.

## Do the flips cluster on shortened patches?

On the face of it, yes: both flips are on a shortened case. 19 of the 40 cases are
shortened, and 0 of the other 21 (63 verdicts) moved. That is the pattern the earlier
run showed, and it meets the task's condition as written.

It is weak evidence. Two flips are two flips: the chance that both fall on the 19
shortened cases if flips were spread at random over the 40 is 171/780, **0.22**. The
rate for cases over all 40 is 2/40 = 5%, with a 95% interval of roughly 1% to 17%
(Wilson). Only one of the two, case 7, names the cut as its reason. And the verdicts
that move are `finished` ↔ `unjudgeable`, which production treats the same:
`closeAfterVerdict` closes the task on either, so neither flip changes what the
validator does. A `not-finished`, the only verdict that starts a cycle, did not
move on any of 120 verdicts.

A second pattern points the same way. Leave the eight empty-diff cases aside (the five
labelled `unjudgeable` get `unjudgeable` every time, and that is the right answer). Of
the 13 cases with a whole, non-empty diff, none got an `unjudgeable` in any of its 39
verdicts; of the 19 shortened cases, four did (7, 17, 19, 20: 10 of 57 verdicts). The
chance that all four fall among the 19 of those 32 cases is about 0.11. Shortened
cases are also the big ones, so size, and the long specifications that come with it,
is mixed in with the cut. The stated reasons differ: 7 and 20 name the dropped bodies
(20 also the issue criteria); 17 and 19 name unreadable issue bodies and filings off
the repository, which a whole diff would not fix.

### The decision

**The constant was not changed.** `VALIDATION_DIFF_BYTES` stays 60,000 and
`diffAsText` keeps its `[TRUNCATED]` form. Because every flip is on a shortened case, the
task's rule says to file the budget question for the operator rather than settle it
here, so it is filed as an operator-decision task (linked from the task note). What
follows is the input to it. This report's reading is that the numbers are too
thin to justify a change by themselves: the flips are two cases, only one of which
names the cut, and neither moves an outcome. They are where to look first if the
operator wants to spend on it.

What is known about moving the budget, all of it modelled from this set and not run:

- The cap is an **argv** bound ("Bounded by argv, not by context", `review.ts:79`). A
  single argument is capped near 128 KiB on Linux, so the budget cannot simply be
  raised past roughly that without sending the prompt another way.
- Of the 19 shortened cases, 8 would be whole at 100 kB (7, 8, 9, 18, 33, 38, 39, 40;
  case 7 is 90,221 B), 16 at 150 kB, and 18 at 200 kB. Case 17 is 101,273 B, so it would
  stay shortened at 100 kB.
- Extra input at 100 kB is about 31 kB per shortened case, about $0.03 at the $3/Mtok
  and 3.4 characters per token `RESULT.md` uses, or $0.013 averaged over all 40.
  At 150 kB it is about $0.04 per shortened case, $0.02 averaged. A higher
  budget makes each verdict slower as well as dearer.
- Not measured: whether sending more of a dropped file turns a `finished` ↔
  `unjudgeable` coin into a stable answer, or catches a `not-finished` the cut hid.
  That needs the same 40 judged at a larger budget; this set has one case where it
  matters (7) and the repeat cannot say which way a larger patch would push it.

## What this does and does not show

- **Sample size.** 40 cases, three samples each (the original and two repeats), one
  judge model, one preamble. The repeat bounds sampling noise for this judge. It says
  nothing about another judge model, about `spawnAssist`'s child under `plan` mode, or
  about a case that was not among these 40.
- **The three samples are not identically instructed.** The original judge's wording was
  not recorded. The first three repeat judges (r1 cases 7, 8, 20) were given a version
  of the instructions without "your chat reply is discarded unread" and without "Do not
  answer in chat instead"; the other 77 had both. The replies' form is the same.
- **Chat replies.** 45 of the 80 judges first answered in chat instead of writing the
  file (the last run: 23 of 73), so "tell it to Write" did not fix this on its own. Each
  of the 45 was resumed with `SendMessage` and asked to write the reply it had given.
  The 45 are listed in `io-shipped-repeat/RE_ASKED.txt` with their chat verdict, and the
  written verdict equals the chat verdict in 45 of 45. That is a re-ask of the same judge,
  not a fresh judge, so no sample was discarded or redrawn. Case 8's two replies were
  both chat replies, kept as `r1` (the first judge) and `r2` (the second).
- **Cost.** Measured: the run's budget meter moved from about $1.4 to about $15.4 across
  the judging, $14.0 including this conversation's own turns and the 45 resumes. The
  80 transcripts total 3.58M cache-creation, 12.8M cache-read and 0.19M output tokens;
  priced at Sonnet list with a 1.25x cache write and 0.1x cache read that is about
  $20, which disagrees with the meter and which I did not reconcile. Either is above
  the $9–12 the task expected, because 45 judges ran twice.
- **Labels.** Agreement is scored against the spike's labels as written. Cases 8 and
  36 are mislabelled (see `RESULT.md`), so `32/37`-style figures are about the labels
  and not about the work.

## How to re-run

```
npx tsc -p tsconfig.test.json --outDir .test-build/spike
node scripts/validator-spike/score.mjs --emit --shipped --build-dir .test-build/spike --io-dir <dir>
# judge each <dir>/NN-*.request.md, writing <dir>/rK/NN-*.response.md
node scripts/validator-spike/score.mjs --collect --shipped --build-dir .test-build/spike --io-dir <dir>/rK
```
