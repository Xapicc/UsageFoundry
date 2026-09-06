# Backend logic

Five gaps. This is the best-defended part of the app — `docs/agent/` documents
the guard ordering, the folder claim, the display-versus-guard split and the
`emit()` ordering, and the code holds them. Two of the five candidates that
looked strongest going in turned out to be documented decisions and are in
[00-method.md](00-method.md#refuted-or-already-decided) instead.

What is left is not carelessness. It is **scope**: a guard that covers one door
of five, a setting with one reader that is not the path it sounds like, and a
budget check whose granularity is a whole chat turn.

> **Re-checked against `main` at `66fdbab`.** Every line reference in this file
> is that tree; where a line moved without its code changing, the number was
> rewritten rather than struck, and the section says so. One of the five shipped in half ([B2](#b2-nothing-builds-or-tests-a-branch-before-it-is-merged-and-the-setting-that-looks-like-it-does-has-one-reader)); one got wider
> ([B1](#b1-the-landing-guard-covers-landrun-and-none-of-the-other-four-doors), which now has a sixth door); one had half of its claim
> refuted ([B4](#b4-the-install-ceiling-is-checked-once-per-chat-turn-before-it-and-a-turn-has-no-cap) — a chat turn *is* capped, and was when this was
> written). [B3](#b3-a-chat-turn-exists-nowhere-durable-until-the-child-exits) and [B5](#b5-the-chat-can-identify-only-the-first-25-repositories-always-the-same-25) are untouched. Each section
> carries the finding at its head.

---

## B1 — The landing guard covers `landRun` and none of the other four doors

> **Open at `66fdbab`, and wider than surveyed: there are now five other doors,
> not four.** `deliverRun` (`src/lib/land.ts:2901`) arrived with PR #214 and
> takes neither check. It resolves its folder the same way `landRun` does —
> `const folder = state.checkout?.path` at `:2914`, against `landRun`'s
> `const folder = state.checkout!.path` at `:962` — so it operates on the
> **same** directory the `landing` set exists to serialise, and then runs
> `git push --set-upstream` in it (`:2958-2962`), which writes that checkout's
> `.git/config`. It is also the only door that reaches outside the machine.
> Nothing else on this row moved: `landing` is still a `globalThis` set at
> `:228`, still read or written at exactly `:979`, `:982` and `:1079`, all three
> inside `landRun` (`:951-1081`), and `resolveCheckout`'s repository-wide
> `git worktree prune` is still at `:1205` under a comment that reasons only
> about the slot. `MAX_MERGE_WORKERS` is still 4
> (`src/lib/mergeQueue.ts:613`).
>
> **Still no collision reproduced**, for the survey's own reason: Docker is
> unavailable in this container. The confidence stays medium and the row rises
> on scope alone.

`landRun` is carefully guarded, and reading it is what makes the gap visible.
`src/lib/land.ts:970-982` takes two independent checks before it merges:

```ts
const key = conflictKey(folder);
const busy = activeRuns().find((r) => overlaps(key, conflictKey(workDirOf(r))));
if (busy) { /* refuse: "Landing while it writes would merge into a moving tree." */ }

if (landing.has(folder)) {
  return { ok: false, reason: "Another branch is being landed into this folder." };
}
landing.add(folder);
```

The first reuses the folder claim's own comparison, so "the same folder" means
the same thing here as in `createRun`. The second is the `landing` set at
`:228`, on `globalThis.__ufLanding` — correct, because `serverLock` makes one
process the only writer, so a `globalThis` set is a real mutex here and not a
per-request illusion.

**`landing` is read or written at exactly three lines: `:979`, `:982` and
`:1079`. All three are inside `landRun`, which spans `:951-1081`.**

The other exported doors into the same repository take neither check:

| Function | Line at `175ba57` | Line at `66fdbab` | Operates on | Takes `landing`? | Takes the `activeRuns()` overlap check? |
|---|---|---|---|---|---|
| `landRun` | `:947` | `:951` | the operator's checkout | yes | yes |
| `resolveConflicts` | `:1182` | `:1254` | the run's worktree, or an aux slot | no | no |
| `commitPending` | `:1642` | `:1810` | the run's checkout | no | a *different* one — a worktree-holder test |
| `deleteBranch` | `:1748` | `:1916` | `repoPathFor(run.repo_root)` | no | no |
| `purgeBranch` | `:1936` | `:2104` | `repoPathFor(run.repo_root)` | no | no |
| `deliverRun` | — | `:2901` | the operator's checkout, and `origin` | no | no |

**The concrete overlap this survey can point at** is repository-wide worktree
administration from unsynchronised callers. `resolveCheckout` at
`src/lib/land.ts:1176` runs, at `:1205`,

```ts
await git(repoRoot, ["worktree", "prune"], NO_CLOCK);
```

which is repository-wide, not slot-scoped — while the comment two lines above
reasons only about the slot: *"this path is ours alone and nothing else ever
adopts it."* True of the slot; not true of `prune`. `purgeBranch` removes
worktrees in the same repository, and `orchestrator.ts` adds them for every
isolated run.

**The exposure grew and the guard did not.** `MAX_MERGE_WORKERS` is 4
(`src/lib/mergeQueue.ts:613`). Issue #67 was filed when the merge queue was
serial; the fix widened it to four concurrent workers, which multiplies every
unguarded overlap above by four without any of them changing.

**Blast radius.** A repository's git state — refs, worktree admin, the
operator's index. `docs/agent/isolation-and-landing.md` is emphatic that
*nothing on the landing path has a clock on it*, which is right and which also
means a wedged git call is a wedged git call for as long as it takes.

**Cost of leaving it.** Low frequency, high consequence, and hard to diagnose
after the fact because nothing logs which door was open.

**Confidence: medium, and deliberately not higher.** The scope table is read
straight from the file and is high confidence. Whether the overlap *harms* is
not established: git locks refs itself, `prune` only reaps entries whose
directories are already gone, and **no collision was reproduced** — reproducing
one needs a running container, which this survey did not have. This row earns
its rank on blast radius, not on a demonstrated failure, and it should be
surveyed before it is fixed.

**Owned by:** #68, as a suspicion, alongside two findings this survey refuted
(see [00-method.md](00-method.md#refuted-or-already-decided)). The issue's third
concern is live; its first two are not.

---

## B2 — Nothing builds or tests a branch before it is merged, and the setting that looks like it does has one reader

> **Shipped in half. Re-checked at `66fdbab` and unchanged since `d1d3119`.**
> The first half of this row is closed: `landVerifyCommand`
> (`src/lib/settings.ts:391`, default `""` at `:891`) gates `landRun`
> (`src/lib/land.ts:999-1006`) and `deliverRun` (`:2941-2947`), running in the
> run's own worktree slot through `verifyTree` (`:1736`) and its pure half
> `verifyTreeVerdict` (`:1703`), and
> the check itself is `src/lib/landGate.ts`. The full account, including the
> correction it needed after the merge, is at
> [M4](04-missing-features.md#m4-nothing-verifies-a-branch-before-it-is-merged).
>
> **The second half stands exactly as surveyed.** `resolveVerifyTools` still has
> exactly one reader — `src/lib/land.ts:1362`, inside `resolveConflicts` — so the
> setting whose name suggests a verify gate still is not one. The other three
> hits `grep -arn resolveVerifyTools src/` returns outside the settings plumbing
> are prose: `src/lib/land.ts:1684`, `src/lib/orchestrator.ts:5284` and
> `src/lib/review.ts:639`. Nothing was renamed, deprecated or documented against
> the other.
>
> **And the pair is now genuinely harder to read, in the one place an operator
> looks.** `resolveVerifyTools` has a Settings field
> (`src/app/settings/page.tsx:3221-3243`) and `landVerifyCommand` has none —
> `grep -an "landVerifyCommand" src/app/settings/page.tsx` returns nothing. So
> the page offers the setting that is *not* a verify gate and withholds the one
> that is, which is the opposite of the reading an operator needs.

`settings.resolveVerifyTools` exists (`src/lib/settings.ts:376`) and ships empty
(`:890`, `resolveVerifyTools: []`). It reads like the install-wide answer to
"what should be run before code lands". It is not. It has exactly one reader in
the entire tree:

```ts
// src/lib/land.ts:1362
const verifyTools = checkout.temporary ? [] : getSettings().resolveVerifyTools;
```

That is inside `resolveConflicts` — the assist that resolves a merge conflict —
and it is passed on at `:1372` as the assist's `allowedTools` and named in its
prompt at `:1373`. So the setting governs *what the conflict-resolving agent is
allowed to run*, and `docs/agent/git-and-review.md` records exactly that: the
resolver may run a check only on `resolveCheckout`'s reuse branch, and only what
`resolveVerifyTools` names.

`landRun` (`:951-1081`) reads it nowhere. It merges, and since `d1d3119` it
takes `landVerifyCommand` — a different setting — first.

Two compounding facts:

1. **The default is `[]`**, so on a stock install even the one place a check
   could run runs nothing.
2. **The `checkout.temporary` ternary** means that even when the setting is
   populated, the check is skipped whenever `resolveCheckout` had to create an
   aux worktree rather than reuse the run's own — see `:1176-1214`. So it is off
   by default and conditionally off when on.

Nothing here is a bug. `docs/agent/git-and-review.md` describes this behaviour
accurately and the reviewer deliberately gets no tools. The gap is that **the
app's own CI is the only thing that has ever run this repository's tests before
a merge, and the app cannot do for its operator what its operator does for it**
— `.github/workflows/ci.yml` gates every push to `Xapicc/UsageFoundry` on
typecheck, test and build across two platforms, and a UsageFoundry install
landing a branch runs none of the three.

**Blast radius.** Every landed branch, on every repository. This is the one row
in the register where the failure lands in the operator's *product*, not in
UsageFoundry.

**Cost of leaving it.** The whole value of an unattended agent fleet is work you
did not watch. A merge with no gate means every landing is a merge you have to
watch, which returns the cost the fleet was bought to remove.

**Confidence: high.** Every claim is a `grep` for `resolveVerifyTools` over
`src/`, which returns four lines, three of them in the same function.

**Owned by:** nothing. Its capability framing is [M4](04-missing-features.md#m4-nothing-verifies-a-branch-before-it-is-merged).

---

## B3 — A chat turn exists nowhere durable until the child exits

> **Open at `66fdbab`. Every line below moved and every claim survived**, which
> is the only reason the numbers were rewritten rather than struck. `chat.ts`
> went from 2,397 lines to 3,065 in the window and none of the growth is
> durability.

`src/lib/chat.ts:2358`:

```ts
child.stdout.on("data", (c: string) => (stdout += c));
```

One string, in one process's memory, for the whole turn. The assistant message
reaches `chat_messages` once, after exit, via the `INSERT` at `:428`. The
turn's cost reaches `chat_turn_spend` at `:2628`, also after — and the comment
at `:2623` says so: *"Written after the latch above."*

If the process dies mid-turn — a restart, an OOM, a deploy — three things are
lost together:

- the assistant's text, entirely, however far it had got;
- the row in `chat_turn_spend`, so the install ceiling never learns the money
  was spent;
- the thread's running total, which `docs/agent/chat.md` keeps beside the
  per-turn window precisely because the two answer different questions.

**Compare the run path, which solved this.** `docs/agent/architecture.md` states
the invariant: `emit()` persists to `run_events` **then** publishes, and *that
order is what makes reconnect lossless*. The chat path has neither half — it
does not persist incrementally and it does not publish at all. The
[F3](01-frontend.md#f3-a-chat-turn-renders-nothing-until-it-finishes-the-run-path-streams) symptom (nothing renders until the end) and this one are
the same missing mechanism seen from two sides.

**Blast radius.** Orchestrator chat, which `docs/agent/chat.md` describes as the
surface where a model may write half of a run. A lost turn is lost operator
intent, not just lost text.

**Cost of leaving it.** Rare and total. Nothing degrades; a turn either lands
whole or vanishes whole, and the money is spent either way.

**Confidence: high** on the mechanism and the ordering. **Assumed:** that no
recovery path exists elsewhere — none was found in `chat.ts`, and no crash was
staged.

**Owned by:** nothing.

---

## B4 — The install ceiling is checked once per chat turn, before it, and a turn has no cap

> **Open in its first half at `66fdbab`. Its second half — "a turn has no cap" —
> is wrong, and was wrong when this was surveyed.** A chat turn is bounded:
> `runOrchestratorChild` passes `--max-budget-usd` to the CLI whenever
> `maxBudgetUSD` is not null (`src/lib/chat.ts:2327-2332`), `runTurn` passes
> `settings.chatTurnBudgetUSD` (`:2443`), and that ships at **2**
> (`src/lib/settings.ts:903`). The same argv is at `175ba57`'s
> `src/lib/chat.ts:1704`, so this is a survey error rather than drift, and the
> title above is left as written so the correction is legible.
>
> **What survives is the sentence the row is actually about**, and it is
> untouched: the *install's* rolling 24-hour ceiling is read once, at admission,
> and never again inside the turn. The overshoot is therefore bounded rather than
> unbounded — by `chatTurnBudgetUSD` per admitted turn — which is a materially
> smaller cost than the row was ranked on, and is why it moves down the register.
> `installBudget.ts:126` says the same thing from the other side: a turn "is
> bounded only by `chatTurnBudgetUSD` and the clock".

`src/lib/chat.ts:2071`:

```ts
const refusal = (await assistRefusal()) ?? installBudgetRefusal();
```

That is the only budget check on the chat path that reads the install ceiling.
`grep -an "installBudgetRefusal\|evaluateInstanceBudget" src/lib/chat.ts`
returns the import at `:26`, this call site, and `transientRefusal` at `:1385`,
which is the pre-flight for *approving a proposal* rather than for a turn. A
turn is admitted whole or refused whole, and once admitted the install ceiling
is not consulted again.

For runs this is a named, chosen mode. `docs/agent/budgets-and-guards.md`
documents the check order and the enforcement modes, and `live-resume` exists
precisely so that a run can be stopped *during* a cycle rather than only between
them. **Chat has the `between-cycles` behaviour and no equivalent of
`live-resume`**, and its unit is larger: a work cycle is bounded by a task, a
chat turn is bounded by whatever the model decides to do with the tools it has —
and per `docs/agent/security.md`, `UF_GITHUB_TOKEN` reaches the orchestrator
chat turn through `chatEnv`, under `bypassPermissions` with write access to
every mount.

Combined with [B3](#b3-a-chat-turn-exists-nowhere-durable-until-the-child-exits), the accounting can move the wrong way twice in one
incident: a turn overshoots the ceiling because nothing checks mid-flight, and
then dies before `chat_turn_spend` records the overshoot at all. That is still
true at `66fdbab`, and the overshoot is at most one `chatTurnBudgetUSD`.

**Blast radius.** The install's 24-hour ceiling — the control
`docs/agent/budgets-and-guards.md` describes as bounding a chat per **turn**
through `chat_turn_spend`. It bounds the turn's *admission*, not its size.

**Cost of leaving it.** Bounded by how expensive one turn can get, which nobody
here has measured because `DATA_DIR` is unreadable. That unmeasured number is
exactly what a survey of this would have to establish first.

> **Corrected at `66fdbab`:** it is bounded by `chatTurnBudgetUSD`, which is a
> configured number rather than an unmeasured one, and ships at 2
> (`src/lib/settings.ts:903`). What is unmeasured is how many turns an operator
> runs inside one 24-hour window, since nothing re-reads the install ceiling
> between them.

**Confidence: high** on the call-site count. **Medium** on severity, for the
reason above.

**Owned by:** nothing. #87 is open and adjacent on the budget surface — read it
first.

---

## B5 — The chat can identify only the first 25 repositories, always the same 25

> **Open at `66fdbab`, unchanged, and at the same lines.** `MAX_REMOTES_READ` is
> still 25 at `src/lib/workspace.ts:168`, the slice is still at `:188` and
> `notRead` still comes back at `:208`. No parameter was added anywhere on this
> path.

`src/lib/workspace.ts:186-188`:

```ts
): Promise<{ repos: Record<string, string>; notRead: number }> {
  const candidates = folders.filter((f) => f.isGitRepo);
  const read = candidates.slice(0, MAX_REMOTES_READ);
```

`MAX_REMOTES_READ = 25` at `:168`. `notRead` is returned at `:208` and the chat
is told the count, which is the good half — the docstring at `:170-183` is
explicit that a wrong `owner/name` is *"a `gh` call against somebody else's
project"*, so refusing to guess is right.

The gap is that the truncation is **positional and permanent**. `candidates` is
`folders` in scan order, so the same twenty-five win every time. On an install
with thirty repositories mounted, five of them can never be named to the chat,
and no parameter anywhere asks for the rest — there is no `offset`, no filter,
no way to say "this one".

The chat's own consequence is not "it guesses wrong" but "it says it cannot
identify the repository", every time, for those five, for ever. An operator who
does not know the cap reads that as a broken repository.

**Blast radius.** Installs with more than 25 git repositories in the workspace
mounts. **Assumed** that such installs exist; no live workspace was readable.

**Cost of leaving it.** Small on a small install, absolute on a large one, and
the boundary is invisible from the UI.

**Confidence: high** on the mechanism, **low** on how many installs cross 25.

**Owned by:** #78, suspicion 2. This survey confirms it against the current
tree.

---

## What this axis got right, recorded because a register that lists only failures misreads the codebase

All four re-checked at `66fdbab`; all four still hold, at the lines given.

- `landRun`'s two-check door reuses `conflictKey`/`overlaps` from the folder
  claim rather than inventing a second notion of "the same folder"
  (`src/lib/land.ts:970-971`).
- `checkoutStateOf` treats an unreadable `git status` as **dirty**
  (`src/lib/land.ts:425-429`), with the reason on the line: a status that failed
  on a stray `index.lock` returns empty stdout, which would read as clean at
  exactly the moment a merge is least safe. That is the shape of defensive
  reasoning this register is asking for elsewhere.
- `advanceInstances` is floating on purpose, with a `.catch()` and eight lines of
  reason (`src/lib/orchestrator.ts:4510-4521`), because awaiting it would let a
  workflow advance interleave with a folder claim.
- OTLP telemetry cannot move spend onto a run: the ingest token is per-run
  (`src/lib/otlp.ts:81-93`), the route takes the run id from the token rather
  than from the payload (`:38-46`, `:112`), and a payload-supplied `uf.run_id`
  is only ever read as the child's own resource attribute (`:261`). That was
  #89's item C and it is closed.
