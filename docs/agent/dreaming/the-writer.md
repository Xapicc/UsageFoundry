# The writer: a run, its spend limit and its prompt

[← dreaming index](../dreaming.md)

Read before editing `runDreamingNight`, `dreamingRefusal` or `buildDreamingPrompt` in `src/lib/dreamingRun.ts`, or how `dreamingMaxCostUSD` is validated.

**The writer is a run, never an assist.** A run lands in `runs.spent_usd`, which
is where `installSpend`'s rolling 24 hours looks, and appears on `/runs` with a
log, a cost, a status and an origin. A third `AssistKind` would inherit the
review's ten-minute clock (`review.ts:78`), log itself as a review
(`logLine.ts:561`) and spend where the install ceiling cannot see it
(`installBudget.ts:79`) — three defects that reproduce at HEAD and that this
feature sidesteps by not being an assist. It is also never isolated: an isolated
run works in a copy and lands a branch, the vault is not a repository, and a note
written into a worktree that is later discarded is a note nobody ever sees.

**`dreamingMaxCostUSD` has no way to express "no ceiling",** on
`scheduleRefusal`'s reasoning quoted word for word: every other press of Run is
bounded by a person being there to see what it cost and decide whether to press
it again, and a clock removes the person and keeps the press. The settings door
refuses zero and below rather than storing it.

**Everything the licence rests on lives in `buildDreamingPrompt`, which is why it
is pure and tested.** The vault's `AGENTS.md` forbids notes from a session that
has not read its `CLAUDE.md`; the only reason this run may write at all is that
it is pointed at the vault as its folder and told to read the conventions first.
**Nothing enforces that it does.** The managed sandbox policy carries no
path-based write restriction (`docker-entrypoint.sh:431`–`:433`), a skill is
persuasion, and a `PreToolUse` deny-on-`Write` hook — the one mechanism that
would enforce it — does not exist. So the prompt is the enforcement, and five
things it must always say are asserted in `dreaming.test.ts`: read `CLAUDE.md`
first; transcription is the claim and diagnosis is a hypothesis; a signature is a
string rather than a cause; grow an existing note rather than writing a second
one beside it; and report the paths back, which is what makes a note
retractable. The run is spawned under **`bypassPermissions`** rather than
`acceptEdits` for the same reason the prompt is the enforcement: a run a timer
started has nobody to answer a permission prompt, `acceptEdits` auto-accepts
file edits and still prompts for everything else, and a stalled unattended run
writes no note before its duration cap ends it — the mode was never what bounded
where this run may write.
