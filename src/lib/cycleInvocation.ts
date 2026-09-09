/**
 * What one work cycle says to the CLI, and the argv that carries it.
 *
 * Lifted whole out of `orchestrator.ts`'s "Claude Code invocation" section: the
 * prompt a cycle opens with, every notice appended to it, the two endings
 * `cycleEnding` reads back out, and `buildArgs`. It is prose and argv — nothing
 * here touches the database, the process table or the event bus, which is what
 * made this the one seam in that file that could be cut without splitting a
 * concern in half.
 *
 * `orchestrator.ts` re-exports every name this module exported when it lived
 * there, so no importer of `@/lib/orchestrator` had to change. The back-import
 * of `ToolCall` is `import type` and erases at compile time, so the two modules
 * are not a cycle at run time.
 */
import { sessionAgentArgs, type AgentDefinition } from "./agents";
import { pluginDirArgs } from "./plugins";
import type { PermissionMode } from "./settings";
import { shortId } from "./format";
import type { ToolCall } from "./orchestrator";

export interface IterationResult {
  exitCode: number;
  /**
   * What this child reported spending, over every `result` event it emitted.
   *
   * Not a sum of them: `total_cost_usd` is the session's running total and one
   * child can emit two. `cycleCostAfterResult` owns that and says why. Across
   * children it *is* summed, by the `+=` in the run loop, because a restart
   * begins a fresh CLI accumulator.
   */
  costUSD: number;
  /**
   * Every token this cycle's `result` events reported, summed — `usage` is that
   * stretch's own rather than the session's, which is the half of the event
   * `costUSD` above is not.
   *
   * **Main thread only, and it is the CLI that scopes it that way.** A `Task`
   * this cycle delegated is absent from `usage` entirely, so this understates a
   * delegating cycle by whatever its sub-agents burned — 5,915,907 against
   * telemetry's 8,481,166 on run `075f7959`, where three `Explore` sub-agents
   * made 54 of the session's 110 requests. Not corrected from telemetry here:
   * that would make `runs.spent_tokens` a mixture of two sources, which is the
   * one thing the telemetry card exists to stay out of. The sub-agents' share
   * is reported beside it rather than folded into it.
   */
  tokens: number;
  /**
   * How large the conversation was when this cycle stopped talking — the
   * context the *next* cycle would inherit if it resumed.
   *
   * A different quantity from `tokens` above and the two must not be confused.
   * `tokens` is the cycle's bill summed over every turn, so it grows with
   * how much work was done; this is one turn's resident window, so it grows
   * with how much has been *said*. `startsFresh` reads this one, because the
   * question it answers is what a `--resume` would cost per turn, not what the
   * last cycle cost in total.
   *
   * **Last, not largest.** After a compaction the final turn is genuinely small
   * and resuming into it is genuinely cheap, which is exactly the case a
   * high-water mark would get backwards — it would restart a conversation the
   * CLI had just finished shrinking, paying for the re-discovery twice.
   *
   * Main thread only: a forwarded sub-agent turn carries the sub-agent's own
   * window, which nothing resumes into and which is discarded when it answers.
   * Zero when the cycle reported no usage at all, and `startsFresh` treats that
   * as "no reading" rather than as "small".
   */
  contextTokens: number;
  /**
   * The same reading taken at the **first** billed turn of the cycle instead of
   * the last, which is what a resume carried before this cycle added anything.
   *
   * It exists for one question and is not a general-purpose figure: after a
   * boundary fork, did the edit reach the wire? The transcript cannot answer it
   * — `winnow fork` removes `message.content` and leaves `toolUseResult`, so
   * bytes leave the file whether or not they leave the request — and the first
   * request the resumed session makes is the only place the answer exists.
   * `markForkResumed` writes it onto the `fork_attempts` row.
   *
   * **First, not last**, which is the opposite of `contextTokens` above and for
   * the same underlying reason: this is a reading of what the cut left, and by
   * the end of the cycle the run has said tens of thousands of tokens more.
   *
   * Main thread only and zero when nothing was billed, on `contextTokens`'
   * rules — a cycle that reported no usage has taken no reading, and 0 must
   * never be written down as a window that was carried.
   */
  firstContextTokens: number;
  sessionId: string | null;
  finalText: string;
  isError: boolean;
  /**
   * `tool_use` block id → the sub-agent that `Task` call handed work to.
   *
   * Parser state rather than a result, and it lives here because this is the
   * only thing that survives from one line of the stream to the next: the id
   * arrives on the call and the name is needed again when that sub-agent's own
   * words come back, which can be many lines later. Per cycle, because a
   * `tool_use` id is.
   */
  subagentNames: Map<string, string>;
  /**
   * `tool_use` block id → what that call was, for the result that answers it.
   *
   * Parser state for `subagentNames`' reason and with its lifetime: a
   * `tool_result` block names the id of the call and nothing else, so a failure
   * can only be reported as "Bash: git push …" by something that saw the call.
   * Bounded per entry rather than per cycle — the tool's name and one clipped
   * line, never the input itself, which for a `Write` is the whole file.
   */
  toolCalls: Map<string, ToolCall>;
  /**
   * Stream event types this build has no branch for, one entry per distinct one.
   *
   * Parser state rather than a result, with the two maps above's lifetime and
   * for a related reason: it exists so that an unrecognised event is reported
   * *once* per cycle instead of once per line. An event type this app has never
   * heard of is the shape a CLI pin moving takes, and the symptom of missing one
   * is a cycle that reports no cost, no session id and no stop reason — which
   * every page in this app renders as a cycle that had nothing to say. Both
   * parsers write to it, through the one `noteUnknownStreamEvent` that bounds
   * them; the log line it guards is per cycle, and the `ops_events` row beside
   * it is per boot, because a table capped at 500 rows cannot take a per-cycle
   * writer.
   */
  unknownEventTypes: Set<string>;
  /**
   * Whether the CLI's terminal `result` event arrived. Cost and tokens come
   * only from that event, so when it is missing — operator stop, crash, OOM —
   * this iteration contributes $0 to the run's totals despite having burned
   * real tokens. The run reports that rather than presenting the understated
   * figure as fact.
   */
  sawResult: boolean;
  /**
   * `result.subtype` verbatim, and the only machine-readable statement the CLI
   * makes about *why* a cycle ended.
   *
   * Kept because one member of it has to be told apart from a crash:
   * `error_max_budget_usd` is the cycle reaching the ceiling `buildArgs` gave
   * it, which is this run's own spending limit arriving a cycle earlier than
   * the pre-cycle guard would have said it. Everything else about that cycle
   * looks like a failure — a non-zero exit, `isError` set, and the CLI's own
   * summary latched into `apiError` — so without the subtype the run is filed
   * as `Claude Code exited with code 1`, or worse, matched as an allowance
   * refusal and parked for hours waiting for money that will not arrive.
   *
   * Not narrowed to a union. The set is the CLI's and moves with the pin, so a
   * member this build has never heard of must arrive as itself rather than as
   * a parse failure.
   */
  subtype: string | null;
  /**
   * What the provider refused with, when it refused rather than the agent
   * failing. Claude Code reports API-level errors as an assistant message
   * whose `message.model` is the literal `<synthetic>` — the same marker
   * `transcripts.ts` keys on to keep an all-zero record out of the unpriced
   * warning — so this is the only signal separating "Claude would not do it"
   * from "the agent crashed". Without it every refusal reads as
   * `Claude Code exited with code 1`, which blames the agent for a decision
   * it did not make.
   */
  apiError: string | null;
  /**
   * Tail of the child's stderr. Forwarded to `run_events` line by line as it
   * arrives, and kept here too so a refusal that only ever reaches stderr is
   * still visible to the branch that has to classify it.
   */
  stderrTail: string;
}

/** Cap on `IterationResult.stderrTail`. An agent can log for hours. */
export const STDERR_TAIL_LIMIT = 4_096;

/**
 * Cap on `runs.needs_review_reason`, applied at the write and nowhere else.
 *
 * At the write for `log()`'s reason with `MAX_LOG_CHARS`: a second bound at a
 * second place is a second number to keep in step. The size is what the wire can
 * carry rather than what a person will read — `RunDTO` is polled every three
 * seconds by the run page and is the row shape the runs list ships for *every*
 * row, so an unbounded model-authored blob multiplies by the length of the list.
 * Nothing is lost by clipping: the full text is the cycle's assistant output in
 * `run_events`, which the Report tab already renders.
 */
export const MAX_NEEDS_REVIEW_REASON = 2_000;

/** The agent's account of the wall, bounded so a clip cannot read as the whole. */
export function clipReason(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_NEEDS_REVIEW_REASON
    ? trimmed
    : `${trimmed.slice(0, MAX_NEEDS_REVIEW_REASON - 1)}…`;
}

/**
 * What the cycle about to spawn actually says.
 *
 * Pure, and separated from the loop because every branch is a billing decision
 * whose failure mode is silent. Sending `continuation` — "if it is fully
 * complete, reply with exactly DONE" — into a session that has just reported
 * DONE produces an immediate second DONE and a billed cycle that did nothing,
 * which is precisely why the pushback and the follow-up exist.
 *
 * Keyed on the session, not on the cycle counter: a cycle the live guard cut
 * short is refunded, so `iterations === 1` can name a conversation that is
 * already part-way through the task. "There is a session to resume into" is
 * what a continuation actually means, and the two agree for any run that is
 * never interrupted.
 *
 * `followUp` is the operator's own message, carried by a run they picked up by
 * hand. With no session to resume it cannot stand alone — the run is starting
 * the original task over, and a note that only makes sense as a reply would
 * read as the whole job — so it is appended rather than substituted.
 *
 * A run that opens with the task again *after* having already worked is told so.
 * That combination is a restart, not a first attempt, and the difference is
 * invisible from inside the prompt: the conversation that held what the previous
 * attempt did is gone, while its work is still on disk.
 */
export function nextPrompt(o: {
  sessionId: string | null;
  followUp: string | null;
  /** The previous cycle said DONE and this run is set to carry on anyway. */
  justRetriggered: boolean;
  task: string;
  /** Prepended on the first cycle of an isolated run only. */
  isolationPreamble: string | null;
  /** Work cycles this run was charged for before the one about to spawn. */
  priorCycles: number;
  /** The run's own branch, for an isolated run: where that work is. */
  worktreeBranch: string | null;
  /** The run whose branch this one took over, when it took one over. */
  continuedFrom: { runId: string; branch: string; base: string | null } | null;
  /** `settings.continuedWorkPrompt`, the editable half of that notice. */
  continuedWork: string;
  continuation: string;
  donePushback: string;
  /**
   * What a validator found missing, when a verdict bought this cycle.
   *
   * `donePushback`'s shape and its reason — a cycle whose prompt is a *reply* —
   * with one difference that decides where it sits below: that one is a
   * standing setting the operator wrote once, and this is produced at the
   * boundary immediately above about this run's own work. So it outranks both
   * the continuation and the pushback, and is the only thing that can be the
   * whole of a resumed turn besides the operator's own note.
   */
  validation: string | null;
  /**
   * Whether replying DONE can actually end this run.
   *
   * False for `maxIterations === 1`, where the cycle cap ends it either way and
   * the sentence would buy nothing but a changed `reported_done` — which is the
   * one input to `reopenPrompt`'s pushback branch, so a promise that changes
   * nothing about this run would change what a pick-up says to it. False for
   * `continueAfterDone`, where the run is set to carry on regardless and
   * `donePushbackPrompt` tells the agent so in as many words; a cycle-1 notice
   * saying the opposite is a contradiction the agent meets on every later cycle.
   */
  endsOnDone: boolean;
}): string {
  if (o.sessionId === null) {
    return [
      o.isolationPreamble,
      o.isolationPreamble ? SHARED_CHECKOUT_NOTICE : null,
      // Ahead of the prior-work notice, and both can apply: this one is about
      // the branch's whole history, that one about this run's own earlier
      // attempt at the task. Read in the other order the agent meets "carry on
      // from where you stopped" before it has been told the work is not its own.
      o.continuedFrom ? continuedWorkNotice(o.continuedFrom, o.continuedWork) : null,
      o.priorCycles > 0 ? priorWorkNotice(o.priorCycles, o.worktreeBranch) : null,
      o.task,
      o.followUp,
      // After the task and before the completion notice: a run restarting
      // without a session has to read what it was asked for before it reads
      // what a reader could not find in what it did.
      o.validation,
      // Last, so it is the most recent thing in the opening context and so it
      // reads as a statement about the task above rather than a preamble to it.
      o.endsOnDone ? COMPLETION_NOTICE : null,
      // After it, because the two are one contract and this is the branch of it:
      // an agent told how to finish and not how to stop has one ending.
      NEEDS_REVIEW_NOTICE,
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
  }
  // Not appended: this branch is the operator's own words, which `docs/runs.md`
  // promises are sent verbatim as the next turn. A run whose operator wrote a
  // note already has the person this ending exists to reach, and the contract is
  // restated on the very next cycle by the branch below.
  //
  // It also outranks the validator's pushback, which is the rarest corner here
  // and still the right way round: a person who typed a note into a run while a
  // verdict was landing is the one deciding what that run does next. What the
  // verdict said is on the run's own log and the task is still open in
  // `list_my_tasks`, so nothing is lost that the agent cannot see.
  if (o.followUp) return o.followUp;
  // Above the pushback and the continuation, because it is the most specific
  // thing this app knows about the cycle it is opening: "carry on" and "you said
  // DONE, carry on anyway" are both true and neither says what is missing.
  if (o.validation) return `${o.validation}\n\n${NEEDS_REVIEW_NOTICE}`;
  // On both, not on cycle 1 alone. `COMPLETION_NOTICE`'s own docblock names the
  // failure this avoids: an agent on cycle 5 that has been re-told about DONE
  // four times and about this once, on a turn that has scrolled out of reach,
  // has been told there is one ending.
  return `${o.justRetriggered ? o.donePushback : o.continuation}\n\n${NEEDS_REVIEW_NOTICE}`;
}

/**
 * Should the cycle about to spawn drop its `--resume` and open a new session?
 *
 * ## What it trades
 *
 * Every cycle after the first resumes, so cycle 2 opens on the whole of cycle
 * 1's context and pays for it again on every turn it takes. The arithmetic
 * behind wanting to stop that is measured on this install: runs that took two
 * work cycles averaged $19.19 against $10.05 for one, and one tool call costs
 * 12.0c at turns 1-10 against 15.7c at 101-200 and 20.4c past 200 — the same
 * call, dearer only because of what is in front of it. A cycle that started
 * fresh would be charged at the first rate.
 *
 * What it costs is **re-discovery**, and that cost is not measured at all. The
 * conversation holding what the last cycle tried, rejected and learned is gone;
 * what survives is the branch, the files and `priorWorkNotice`. An agent that
 * spends its first twenty turns working out where it had got to has spent the
 * saving and some of the next cycle's as well, and from outside that run looks
 * exactly like one that started cheap.
 *
 * **So this ships off, and `docs/verification.md` is the reason it should stay
 * off until somebody measures it.** That file's analysis of the neighbouring
 * question — compaction — is a direct warning against assuming a smaller
 * context is a cheaper one, and it also names the shape of measurement that
 * settles nothing: a within-run before/after reads the down edge of a saw-tooth
 * that a placebo reproduces. What would settle *this* is a matched pair of runs
 * on one task, one arm resuming and one arm fresh, compared on two things
 * rather than one — total spend, **and** whether the task actually finished.
 * An arm that is cheaper because it never got anywhere is the failure this
 * cannot be allowed to report as a win.
 *
 * ## Why the three refusals below are not conditions on a threshold
 *
 * Pure, and separated from the loop because every branch of it is a billing
 * decision that fails silently: a run that restarts when it should not have
 * re-reads its own work, and a run that never restarts is simply the app as it
 * was, which is what a broken threshold looks like.
 *
 * `followUp` and `justRetriggered` are refusals rather than inputs to the
 * comparison. Both name a cycle whose prompt is a *reply* — the operator's own
 * words, or the pushback telling an agent that said DONE to carry on anyway —
 * and `nextPrompt` sends neither on the no-session branch. Restarting there
 * would answer a reply into a conversation that no longer exists: the operator
 * would get the original task back instead of their note acted on, and the
 * pushback would be replaced by the task it was pushing back against.
 * `contextTokens === 0` is the third: a cycle that reported no usage measured
 * nothing, and "no reading" must not be read as "small".
 */
export function startsFresh(o: {
  /** The session this cycle would resume, or null if there is nothing to drop. */
  sessionId: string | null;
  /** The window the last cycle's final main-thread turn was billed against. */
  contextTokens: number;
  /** `settings.freshStartContextTokens`. Null is off. */
  threshold: number | null;
  /** The last cycle said DONE and this run is set to carry on anyway. */
  justRetriggered: boolean;
  /** A message the operator left for this run. */
  followUp: string | null;
}): boolean {
  if (o.threshold === null) return false;
  if (o.sessionId === null) return false;
  if (o.justRetriggered) return false;
  if (o.followUp) return false;
  if (o.contextTokens <= 0) return false;
  return o.contextTokens >= o.threshold;
}

/**
 * What an agent is told when it is handed the original task on a run that has
 * already done work.
 *
 * Everything the previous attempt left behind is on disk and nowhere else — the
 * conversation is gone, so nothing else in the prompt refers to it — and an
 * agent given a bare task does the first thing that task says, which is the work
 * it is standing on top of. Pointing it at the branch is the whole point for an
 * isolated run: its predecessor's output is committed there, which is the one
 * place a fresh session can still read it.
 */
/**
 * What an agent is told when the commits under it are another run's.
 *
 * A different case from `priorWorkNotice`, and the difference is what the agent
 * has to do about it. There, the work is this run's own and the instruction is
 * "carry on from where you stopped". Here it is someone else's: there is no
 * conversation that was ever going to be resumed, the decisions behind those
 * commits were never in any context, and the branch may well contain choices
 * this agent would not have made. So it is pointed at the range rather than
 * told to infer it — `<base>...HEAD` is the chain's whole change, the same
 * range the run page's diff and any review are measured over, which is what
 * keeps the agent, the reviewer and the merge looking at one thing.
 *
 * The range is asked for as `--stat`, never as the diff itself, because what
 * an opening turn reads it then pays for on every turn after it: the
 * conversation is re-sent whole on each request, so an opening `git diff` is
 * not read once but held for the life of the run. Five commits of this repo's
 * own history is 176KB of diff against 1.2KB of stat — tens of thousands of
 * resident tokens to say what a stat says, about work the agent may never
 * touch. The stat names every file and how far it moved, which is what decides
 * where to look; opening one of them then costs one file, and the agent can.
 *
 * The facts are generated and the guidance is `settings.continuedWorkPrompt`,
 * for the reason `PeriodSeries.limitBasis` travels beside its fraction: the
 * sentence naming the branch must not be able to drift from the branch.
 */
function continuedWorkNotice(
  from: { runId: string; branch: string; base: string | null },
  guidance: string,
): string {
  const range = from.base ?? "the branch point";
  return (
    `This branch (${from.branch}) already carries the work of run ${shortId(from.runId)}, ` +
    `which you are continuing. That was a separate agent and a separate conversation: none of ` +
    `what it decided is in your context, and the only record of it is the branch itself. ` +
    `Before doing anything, read it:\n\n` +
    `    git log --oneline ${range}..HEAD\n` +
    `    git diff --stat ${range}...HEAD\n\n` +
    guidance.trim()
  );
}

function priorWorkNotice(cycles: number, branch: string | null): string {
  const spent = `${cycles} work ${cycles === 1 ? "cycle" : "cycles"}`;
  const where = branch
    ? `committed its work to this branch (${branch})`
    : `worked in this folder`;
  const look = branch
    ? "read the recent commits on this branch and the current state of the files"
    : "check the current state of the files";
  return (
    `A previous attempt at this task already ran ${spent} and ${where}. There is ` +
    `no conversation left to resume, so the task is repeated in full below. ` +
    `Before doing anything, ${look}, and carry on from where that attempt ` +
    `stopped rather than starting it again.`
  );
}

/**
 * The only cycle that is ever told how a run ends.
 *
 * Until this existed, `DEFAULT_CONTINUATION_PROMPT` was the sole string in the
 * app naming the `DONE` token, and `nextPrompt` returns it only on the
 * `sessionId !== null` branch — so cycle 1 was judged by `reportedDone`'s
 * matcher against a protocol it had never been given. Measured over 251 runs on
 * this install: of the runs whose budget allowed a second cycle, those whose
 * *task text* happened to carry the token ended in one cycle 53% of the time
 * and those without did so twice out of 120 — both of them a crash and an
 * operator stop rather than a completion. `reported_done` was 69% in both
 * groups. The second cycle was not finding more work; it was the first turn
 * permitted to say the job was over, and 92 of them cost $162 to say one word
 * into a re-sent conversation.
 *
 * Generated here rather than added to `Settings`, and that is the load-bearing
 * half. `getSettings()` is `{...DEFAULTS, ...stored}` and the settings page PUTs
 * the whole *effective* object on Save, so every `DEFAULT_*` prompt is
 * materialised into the stored blob the first time anybody presses it — after
 * which editing the constant reaches no install that has ever saved. The same
 * split `continuedWorkNotice` makes, for the same reason: the sentence that has
 * to stay true is generated, and only guidance is editable.
 *
 * Both sentences are load-bearing. The first restates
 * `DEFAULT_CONTINUATION_PROMPT` almost verbatim on purpose — cycle 1 and cycle 2
 * disagreeing about the bar is the bug — and names the token as the *only*
 * ending, because an agent that believes stopping its turn is enough is exactly
 * the agent that produced the 92. The second exists because an instruction an
 * agent cannot satisfy produces churn rather than silence: told only to reply
 * DONE when finished, a run that is genuinely unfinished invents work to explain
 * itself. `DEFAULT_DONE_PUSHBACK_PROMPT` carries the same escape clause for the
 * same reason.
 */
const COMPLETION_NOTICE =
  "This run continues until you reply with exactly DONE on its own line: that " +
  "line is what ends it, and nothing else does — stopping your turn without it " +
  "buys another work cycle on the same task. When the task above is fully " +
  "complete and verified, reply with exactly DONE on its own line and make no " +
  "further changes. If work remains, or something could not be verified, end " +
  "with what remains and why instead of DONE, and this run will carry on.";

/**
 * The other ending, and the one an agent has to be told it may ask for.
 *
 * `COMPLETION_NOTICE` above says stopping without DONE "buys another work cycle
 * on the same task", which is true and is exactly the wrong instruction for a
 * run that has met a wall: it spends the rest of its cycle cap restating the
 * problem, or replies DONE anyway and is filed green. Neither reaches a person.
 *
 * The bar is the load-bearing half of the wording, not the token. An ending the
 * agent controls is a cheap way out of a large or tedious task, so the sentence
 * has to make reporting it *more* work than carrying on: it names what counts as
 * a wall, refuses the shapes that are not one, and asks for the three facts an
 * operator needs before they can act. `DEFAULT_DONE_PUSHBACK_PROMPT` carries the
 * same kind of clause for the same reason — an instruction an agent cannot
 * satisfy produces churn rather than silence.
 *
 * Generated rather than stored, for `COMPLETION_NOTICE`'s reason: the settings
 * page PUTs the whole effective object on Save, so a sentence added to a
 * `DEFAULT_*` prompt reaches no install whose operator has ever pressed it.
 *
 * Deliberately **not** gated on `endsOnDone`. That flag withholds a promise that
 * would be false — under `maxIterations === 1` the cap ends the run whatever the
 * agent says — and neither of its cases reaches this token, which always ends the
 * run with the reason recorded. `maxIterations` defaults to 1, so gating would
 * withhold the new ending from precisely the runs where it matters most.
 *
 * Exported, where `COMPLETION_NOTICE` is not, for one reason: this one rides on
 * *every* prompt `nextPrompt` returns bar the operator's own note, so every
 * exact-equality assertion in that function's suite composes against it. The
 * alternative was degrading each of them to a substring match, which is the
 * weaker test.
 */
export const NEEDS_REVIEW_NOTICE =
  "If you reach something you cannot get past, reply with exactly NEEDS_REVIEW " +
  "on its own line and this run ends for a person to look at. Use it only after " +
  "you have actually tried and been stopped — a credential that is not there, a " +
  "permission you do not have, a decision that is not yours to make, a " +
  "repository or service you cannot reach — and in the same reply say what you " +
  "were doing, what you tried, and exactly what stopped you. Do not use it " +
  "because the task is large, unclear or tedious: work you have not attempted is " +
  "not a wall, and a run that ends this way with nothing to act on spends a " +
  "person's time instead of a work cycle.";

/** Which of the two endings a cycle's own final text reported, if either. */
export type CycleEnding = "needs-review" | "done";

/**
 * How a work cycle's last assistant turn ends the run, or null to carry on.
 *
 * Extracted because the **precedence** is a decision rather than an expression:
 * a turn carrying both tokens is an agent contradicting itself, and
 * `needs-review` wins. `completed` is `ok`-toned, green, and the one ending
 * nobody re-reads; `needs-review` is warn-toned, reopenable, and asks for a
 * person — so the recoverable reading is the safe one to err toward, and getting
 * it backwards files a run that said it was stuck as a run that said it was
 * finished. That throws nothing and typechecks.
 *
 * Both tokens must be alone on their line, and the spellings differ on purpose:
 * the sentinel is `NEEDS_REVIEW`, the stored status is `needs-review`, so a task
 * that quotes the *status* — which is what a task about this app would do —
 * cannot trip the matcher. Measured on this install, a task whose text merely
 * carried `DONE` ended its run in a single cycle 53% of the time against 2 of
 * 120 without it, so the collision is real and these two guards are what bound
 * it. Do not tidy the spellings into agreement.
 *
 * Sub-agent text cannot reach here at all: `handleStreamLine` routes any message
 * carrying `parent_tool_use_id` to its own event kind, so it never becomes a
 * cycle's `finalText`. That protection is inherited rather than restated.
 */
export function cycleEnding(finalText: string): CycleEnding | null {
  if (/^\s*NEEDS_REVIEW\s*$/m.test(finalText)) return "needs-review";
  if (/^\s*DONE\s*$/m.test(finalText)) return "done";
  return null;
}

/**
 * What an isolated run is not told by "you are working in a dedicated worktree".
 *
 * `refs/stash` is a **common** ref, not a per-worktree one, so every isolated
 * run on a repository pops from one shared stack — reproduced on git 2.50.1:
 * worktree A stashes, worktree B stashes, and A's `git stash pop` applies B's
 * entry and drops it. Across this install's 251 runs there are 123 `git stash
 * pop` calls and **not one** names a `stash@{n}`; eight runs left assistant text
 * saying in as many words that they had popped a sibling's work. The isolation
 * preamble actively invites the belief — it says the checkout is the agent's own
 * — and the failure is silent in the worst direction: a sibling's uncommitted
 * files arrive in this run's tree looking like its own edits.
 *
 * The clean-tree case is named because it is the one that surprises: `git stash
 * -u` with nothing to stash creates no entry at all, so the `pop` that pairs
 * with it in the agent's plan takes whatever a sibling pushed instead.
 *
 * Generated beside the preamble rather than added to it for
 * `COMPLETION_NOTICE`'s reason — the preamble is settings-backed and stale on
 * any install that has pressed Save. Sent only where the preamble is, which is
 * the first cycle of an isolated run: this is a fact about the machine that run
 * is standing on, and it is true for the whole run.
 *
 * `/tmp` gets one clause rather than a mechanism. It is shared by every
 * concurrent agent and 117 paths in this corpus were used by more than one run,
 * but not one confirmed clobber was found, so what is warranted is a sentence
 * and not a per-run `TMPDIR`.
 */
const SHARED_CHECKOUT_NOTICE =
  "Two things in this container are shared with the other agents working right " +
  "now, and your worktree does not isolate either. The git stash stack is one " +
  "of them: `refs/stash` is common to every worktree of this repository, so a " +
  "bare `git stash pop` can apply and destroy a sibling run's uncommitted work " +
  "— and `git stash -u` on an already-clean tree pushes nothing, so the pop you " +
  "paired with it takes theirs. Prefer commits over stashing; if you must " +
  "stash, push with `git stash push -m <unique-label>` and pop by that label's " +
  "own `stash@{n}`, never bare. `/tmp` is the other: put scratch files under a " +
  "directory named for your branch rather than at a name a sibling would pick.";

/**
 * The two commands an isolated run is *ordered* to use, granted to it.
 *
 * `acceptEdits` auto-approves file edits and read-only shell, and holds
 * mutating git for a human — `git add` and `git commit` both come back "This
 * command requires approval", and a `-p` child has nobody to give it. So the
 * isolation preamble tells the agent to commit as it goes, and the permission
 * mode the run form defaults to makes that impossible. Measured, not reasoned:
 * one run tried seven times, in five phrasings, and was refused every time,
 * finished as `completed`, and left its whole change sitting uncommitted in a
 * worktree that `landState` then read as a branch with nothing on it.
 *
 * Granted by name rather than by moving the run to `bypassPermissions`, which
 * would also hand it the network, `rm`, and everything else the run form warns
 * about. The narrow grant is exactly the promise the preamble already makes.
 *
 * Isolated runs only. A run working in the operator's own checkout is told
 * nothing about committing, and auto-approving commits into the tree someone
 * is working in is a decision nobody asked for.
 *
 * Prefix-matched, so `git commit -am …` is covered and `git -c user.name=…
 * commit` is not — the agent above tried that form too, once, before falling
 * back to the plain one. Still not worth a second entry, but no longer because
 * the `-c` form is harmless: an agent that reaches for it also chooses what to
 * put in it, and one of them put the operator's own address there and published
 * it. What answers that is `COMMIT_IDENTITY_NOTICE`, on the system prompt,
 * because an entry here would be read only by the permission modes that consult
 * an allowlist and the run that did it was on `bypassPermissions`.
 */
const ISOLATED_GIT_TOOLS = ["Bash(git add:*)", "Bash(git commit:*)"];

/**
 * The two search tools, named so that the CLI offers them at all.
 *
 * Not a permission. `Grep` and `Glob` read; nothing about naming them widens
 * what a child may do, and the mode over them is untouched. What the name buys
 * is the tools' *existence*: the pinned CLI drops both from the tool list
 * whenever `Bash` is present — telling the model to use `grep` and `find`
 * through the shell instead — unless something on the argv opts in by naming
 * one of them.
 *
 * Measured on this install rather than reasoned about, and in both directions.
 * Zero of 469 recorded `system:init` events have ever carried `Grep`, going
 * back five days before a sandbox existed here; every one of the five `Grep`
 * and `Glob` calls an agent ever attempted came back "No such tool available".
 * And in a throwaway container on the pin, adding these two to `--allowedTools`
 * puts both back in the list and changes nothing else in it.
 *
 * The fallback the CLI points at is exactly what a broken sandbox took away:
 * for fifteen hours every `Bash` call on this install died inside bubblewrap,
 * which left agents with `Read` and a directory they could not list. One of
 * them recovered a file list by parsing `.git/index` by hand. Two independent
 * defects, and this is the half that does not need a container restart to fix.
 *
 * On every spawn, unlike `ISOLATED_GIT_TOOLS`: a read is not a decision about
 * the tree the child is standing in, so there is nothing here for isolation or
 * a permission mode to gate.
 */
export const SEARCH_TOOLS = ["Grep", "Glob"];

/**
 * Name-matched process killers, withheld from every agent.
 *
 * This server is a Next.js process and Next renames it: inside the container
 * `ps` shows `next-server (v…)`, not `node server.js`. An agent verifying a
 * change starts its own dev server, and once that has booted it carries the
 * *same* title — `next dev` hands off to a child that renames itself the same
 * way, which is why an agent that tries `pkill -f "next dev"` and finds the
 * port still held broadens the pattern rather than narrowing it. The two
 * processes are then indistinguishable by name, and the one `pkill` reaches is
 * the one that was already running.
 *
 * Measured, not reasoned: a run issued `pkill -f "next-server|next dev"` to
 * clean up a dev server it had started on 3100. tini lost its child,
 * `restart: unless-stopped` brought the container back, and `reconcileOnBoot`
 * marked fourteen runs failed 690ms later — including the one that ran it.
 *
 * Withheld by name because a name is the only thing there is to withhold it by
 * for most of what it reaches. The uid split closed one half of that and left
 * the other open, and the halves are worth keeping apart. Where the server is
 * *actually* root — the shipped container, and nothing else — children drop to
 * `UF_AGENT_UID` (`src/lib/privsep.ts:23`–`33`) and `kill(2)` checks the
 * sender's uid, so the incident above cannot recur the way it happened: the
 * pattern still matches the server, and the signal is refused. `npm run dev` on
 * a laptop, the test suite, and a container an operator has pinned back to
 * `user: "1000:1000"` all run one uid and get the original behaviour, which
 * `privsep.ts:41`–`47` states in as many words.
 *
 * What no arrangement here closes is agent-to-agent. Every child of every kind
 * takes the same uid, so one run's `pkill -f` reaches a sibling's `claude`, the
 * dev server it started and the build it is halfway through — and that run's
 * only evidence is a tool call that failed for no reason it can see. Until an
 * agent's processes are separated from a sibling's by a uid per slot or a PID
 * namespace, this deny and the notice below it are the whole of what stands
 * between two runs. The container has neither a docker socket nor a docker CLI,
 * so name-matched killing also remains the only route from an agent to a
 * restart, and it does not look like one from the agent's side.
 *
 * `kill` itself stays permitted, deliberately. A pid is a handle on a process
 * the agent actually started; a pattern is a guess about every process on the
 * machine. Denying both would leave an agent unable to stop the dev server it
 * was told to start, which is a port held for the rest of the container's life.
 *
 * Deny beats `--permission-mode`, verified against the pinned CLI: a
 * `bypassPermissions` session is still refused these.
 */
const PROCESS_KILLERS = ["Bash(pkill:*)", "Bash(killall:*)"];

/**
 * What every agent is told about the process it is running inside.
 *
 * `PROCESS_KILLERS` stops two commands; this is what stops the agent routing
 * around them, which otherwise takes it one turn — `kill $(pgrep -f
 * next-server)` is not `pkill` and is exactly as fatal.
 *
 * A recipe rather than a prohibition, and the difference is the whole point. An
 * agent told only "do not kill things by name" and left holding a dev server
 * whose pid it no longer has does the safe thing, which is nothing: the server
 * survives the cycle and holds its port for the life of the container, and the
 * next cycle finds the port taken and starts another. That is the failure this
 * would have traded the first one for. So the pattern that is actually safe is
 * spelled out — match on the port, which names one process the agent chose,
 * never on the title, which names two — along with the child-process form,
 * since `next dev` forking a child it does not kill is what sent the run that
 * caused all this looking for `pkill` in the first place.
 *
 * On the system prompt rather than in the task, because the task is only sent
 * on the first cycle of a session and this is true of every cycle. It says
 * nothing about docker on purpose: there is no docker in this image, and
 * warning about an absent command is how an agent learns to look for it. For
 * the same reason it names no tool the image does not carry: the Dockerfile
 * installs `procps` and neither `psmisc` nor `iproute2`, so `fuser` and `ss`
 * are absent and suggesting either teaches an agent to reach for a command that
 * is not there.
 *
 * **This string is on every concurrent agent's argv, so any literal in it is a
 * pattern that matches all of them.** It used to carry `kill $(pgrep -f 3100)`
 * as the worked example, and `--append-system-prompt` put those four digits on
 * the command line of every sibling `claude` process — so the one command this
 * notice recommends by name matched the whole fleet. Measured twice: at
 * 2026-08-15 23:39:42 run `b81e7c70` escalated from a narrow `pgrep -f "next dev
 * -p 3100"` through an explicit pid to a bare `pgrep -f 3100`, and `9b98ddec`
 * — a Go run in another repository, with no port-3100 process and no tool call
 * of its own mentioning 3100 — died in the same second with "exited with code
 * 143". Five dependents blocked behind it. It happened again on 2026-08-16 at
 * 14:23:38, `02c3e132` taking down `8d6b1ffc`. No work was lost, because all
 * four runs resumed the same session, but three were truncated at their cycle
 * cap and every dependent needed picking up by hand.
 *
 * So the example is a variable now, and the mechanism is stated rather than the
 * conclusion — an agent told only "do not use a bare number" reaches for a
 * different literal, where one told *why* a literal is dangerous checks first.
 * `pgrep -af` is named because looking is the habit that generalises to the next
 * pattern nobody anticipated.
 */
const SELF_HOSTING_NOTICE =
  "You are running inside a long-lived server process that is also supervising " +
  "other agents. Ending it ends every run in flight, including your own, and " +
  "nothing you have not committed survives. `pkill` and `killall` are therefore " +
  "unavailable to you. To stop a background process you started, record its pid " +
  "(`cmd & pid=$!`) and use `kill \"$pid\"`; a dev server usually forks a child, " +
  "so `kill $(pgrep -P \"$pid\") \"$pid\"` or start it under `setsid` and use " +
  "`kill -- -$pid`. If you no longer have the pid, select on something unique to " +
  "the process you started — the port you chose, held in a variable: " +
  "`port=<the one you started>; kill $(pgrep -f \"$port\")`. Always read what a " +
  "pattern matches with `pgrep -af <pattern>` before killing anything: every " +
  "agent running beside you carries these very instructions on its command line, " +
  "so any literal string that appears here matches all of them as well as you. " +
  "And never match on `next-server`, `next dev` or `node`: this server's process " +
  "title is `next-server`, which is also the title your own dev server takes, so " +
  "a match on it cannot tell the two apart.";


/**
 * Why a run should hand self-contained work to a sub-agent.
 *
 * Appended to the same flag rather than sent as a second
 * `--append-system-prompt`, which the CLI would read as a replacement the way
 * it reads a second `--allowedTools`. There are four notices on that flag now
 * and any of them arriving alone is silent — the one that would go missing is
 * whichever the last edit did not think about, and one of the three is the
 * process-safety one.
 *
 * The numbers are here because they are the whole argument for spending tokens
 * on the instruction, and they are **re-measured** rather than carried forward:
 * 1,194 transcripts, 49,038 deduped assistant turns, $6,522 over 12.3 days,
 * priced through `pricing.ts`, split on the transcripts' own `isSidechain` the
 * way `transcripts.ts` splits it. A tool call inside a sub-agent costs **5.0
 * cents against 13.6** on a main thread, and most of the gap is cache re-read —
 * **3.0 cents against 8.2**. The mechanism is that nothing shrinks a main
 * thread's context while the agent is in it, so every file read there is
 * re-read at every later turn of the same work cycle: the same tool call costs
 * 8.4 cents over turns 11-25, 15.7 over turns 101-200 and 20.4 past turn 200.
 * The previous reading, over 1,011 transcripts, was 6.5 against 13.9 with 2.7
 * against 8.3 — the same claim, and the sub-agent side has if anything got
 * cheaper.
 *
 * **Why the text says "while you are in it" rather than "once it has grown".**
 * Winnow is bundled now and does shrink the conversation — `verification.md`
 * measures 28% and 38.4% of API-visible content on two real transcripts at
 * `standard`, and 29.1-52.8% across four real prunes at `aggressive`. What it
 * cannot shrink is the conversation the agent is reading: orchestrator-safe
 * mode refuses a mutating prune while a Claude process is live, so the prune
 * lands at the cycle boundary, after the gradient above has been climbed in
 * full. That is also why pruning composes with this argument rather than
 * replacing it — it stops those bytes costing anything in the NEXT cycle and
 * refunds nothing from this one, where delegation avoids the cost from the
 * first turn.
 *
 * It does mean the 5.0-against-13.6 split wants re-reading at some point: it
 * spans the period when `--autocompact` bounded a cycle and winnow now does,
 * and the main-thread side is the one that could have moved.
 *
 * **One thing the split does not separate, and the claim is weaker for it.**
 * Sub-agents are handed the self-contained errands — find where this lives, read
 * across three modules and answer one question — precisely because those are the
 * ones worth delegating. Easier work costs less per tool call whatever context
 * it runs in, so an unknown share of the 5.0-against-13.6 gap is the task rather
 * than the context. What is *not* confounded is the within-thread gradient, 8.4
 * to 20.4 across turn position on the same threads doing the same kind of work,
 * and that gradient alone is the reason to delegate.
 *
 * Count tool calls from every assistant record, not from the deduped ones:
 * Claude Code writes one line per content block, all carrying the same message
 * id and the same usage block, so the dedupe that makes the cost right drops
 * every `tool_use` after the first and triples the apparent price per call.
 *
 * The floor is in the text because delegation is not free in the other
 * direction. A sub-agent's opening turn averages 10.6 cents of its own, and
 * grouped by `agentId` the invocations under five turns measured *worse* per
 * tool call than every longer band — 6.7 cents against 4.1 at 11-25 — so a run
 * that delegated every errand would spend more than one that delegated none.
 * That floor has moved down: it was ten turns and is now about five, which is
 * why the text below still reads "more than a handful of steps" unchanged.
 */
const DELEGATION_NOTICE =
  "Prefer to hand self-contained investigation to a sub-agent rather than " +
  "doing it on this thread: anything where you want the conclusion and not the " +
  "files it was read out of — finding where something is implemented, reading " +
  "across several modules to answer one question, checking whether a pattern " +
  "holds everywhere. Nothing shrinks this conversation while you are in it, so " +
  "every file you read here is read again on every later turn of this work " +
  "cycle, while a sub-agent's context is discarded when it answers. Delegate " +
  "work you expect to take more than a handful of steps; below that a " +
  "sub-agent's own start-up costs more than the thread saves, so do short " +
  "lookups yourself.";

/**
 * That a browser is already here, so the run does not go looking for one.
 *
 * The gap this closes is not that rendering is unavailable — the image ships
 * Playwright and a Chromium, on the argument in `docs/agent/environment.md` —
 * but that nothing told the agents, and the command they reach for from memory
 * is `playwright install`. That command is the one thing about the arrangement
 * that does *not* work: `/opt/playwright/browsers` is writable by nobody at
 * runtime under the sandbox, where bubblewrap binds it read-only, and its
 * failure text is "Failed to install browsers", which reads as *there is no
 * Playwright here* and sends the run off to fetch a second Chromium into a path
 * it can write, or to give up on looking at the page it just changed. Both were
 * measured; `docs/verification.md` carries the two error strings.
 *
 * So the notice says two things and the second is the load-bearing one: how to
 * take a screenshot, and that a refusal from `playwright install` is not
 * evidence about whether rendering works.
 *
 * It names a command, which `fileCostNotice.ts` deliberately does not, and the
 * rule it inherits from `SELF_HOSTING_NOTICE` is the reason to say why that is
 * safe here rather than to assume it. `playwright` is now a literal on every
 * sibling's argv, so it would match the whole fleet if it were offered as a
 * *selection pattern*. It is not: the only verb near it is "run", the command
 * is synchronous and leaves no process behind to clean up, and nothing here
 * suggests finding a process by name. That is the same property the file price
 * list rests on. The same rule is why this notice carries **no viewport size**,
 * which is the natural thing to put in a worked screenshot command: the digits
 * test in `orchestrator.test.ts` refused `--viewport-size=1280,800` on the
 * argument that killed two siblings — `1280` reads as a port, and the recipe
 * three paragraphs above it says to select a process by the port it chose.
 *
 * Adding it cost every run in flight one cold prefix on its next cycle, once,
 * at the deploy — the appended prompt is part of the cached prefix. That is
 * paid and done; do not reword this for style, because every edit charges it
 * again across the whole fleet.
 */
const RENDERING_NOTICE =
  "Playwright and a Chromium build are already installed in this container and " +
  "on your PATH, so you can look at a page you have changed rather than " +
  "reasoning about its source: `playwright screenshot <url> shot.png` renders " +
  "it in one tool call, and the PNG is an image you can then read back " +
  "directly. There is no browser to install and you should not " +
  "try — `playwright install` is refused here because the directory holding the " +
  "browser is not writable by you, and that refusal says nothing about whether " +
  "you can render. Take a screenshot to find out.";

/**
 * Never sign a commit with the address you were given to recognise the operator
 * by.
 *
 * The CLI puts the signed-in account's email in every agent's own system prompt,
 * worded as "use it only to identify the user, such as for authorship,
 * attribution" — and an agent this app has just told to commit reads that as
 * permission. Two commits on this repository's `main` were authored
 * `UsageFoundry Agent <the operator's address>` by an isolated run that reached
 * for `git -c user.name=… -c user.email=… commit` on its own, having never been
 * asked to. GitHub maps a commit to an account by author email, so both were
 * attributed to the operator's other GitHub identity and it appeared in the
 * repository's contributor list. Nothing failed: the image's system-wide
 * identity was correct and still is, the commits landed, and the attribution
 * was only found weeks later by someone reading the contributors panel.
 *
 * `ISOLATED_GIT_TOOLS` cannot hold this. Its entries are prefix-matched, so the
 * `-c` form is outside them by construction, and the run that did this was on
 * `bypassPermissions`, where an allowlist decides nothing at all. The system
 * prompt is the only thing that reaches every run whatever its mode, which is
 * why the rule is stated here rather than enforced on the argv.
 *
 * It says *why* rather than only "do not", for `SELF_HOSTING_NOTICE`'s reason:
 * an agent told only that a flag is forbidden reaches for `git config` or
 * `GIT_AUTHOR_EMAIL` instead, where one told what an author email *is* to a
 * forge stops looking for a way to spell it. All four spellings are named
 * because the agent tried the first two in one session.
 *
 * The literal rule this inherits is satisfied the way the price list satisfies
 * it: the strings it puts on every sibling's argv are git configuration keys,
 * the only verb near them is "commit", and nothing here selects a process or
 * suggests finding one. It carries no digits at all.
 *
 * Adding it costs every run in flight one cold prefix on its next cycle, once,
 * at the deploy. Do not reword it for style — every edit charges that again
 * across the whole fleet.
 */
const COMMIT_IDENTITY_NOTICE =
  "Commit with the git identity this container already configures. Never " +
  "override it — not with `-c user.email` or `-c user.name`, not with `git " +
  "config`, not with `GIT_AUTHOR_EMAIL` or `GIT_COMMITTER_EMAIL`. The " +
  "operator's address is given to you so you can recognise their work, not so " +
  "you can sign yours with it: a forge maps a commit to an account by author " +
  "email, so a commit carrying it is published under their name, and that " +
  "attribution outlives both the run and the branch. If git ever refuses to " +
  "commit for want of an identity, report that and stop rather than inventing " +
  "one.";

/**
 * What a run is told about the operator's board, and only when it has one.
 *
 * **Behavioural rather than descriptive**, which is the whole of why it is worth
 * the prefix it costs. The tool list already says what the three tools *are*; a
 * model reading only that closes the task it was given and stops there, or —
 * worse — finds a second defect and fixes it, because nothing told it there was
 * anywhere else to put one. The two sentences that matter are "complete only
 * what you hold" and "file what you find rather than fixing it", and both are
 * about when to reach for a tool rather than what it does.
 *
 * It satisfies `docs/agent/security.md`'s rule about literals the way the file
 * price list and the git-identity notice do. The three tool names are shared
 * across every board-enabled run on the box, so they *are* the kind of literal
 * that made `pgrep -f 3100` fatal; what keeps them safe is that nothing near
 * them offers a pattern — no verb here selects a process, no command is named at
 * all, and the notice carries no digits. They are named rather than alluded to
 * because a model told "there is a board" without the names writes prose about
 * filing a task instead of filing one.
 *
 * It rides the flag only when the tools do, and that pairing is the invariant:
 * a run told about a board it cannot reach spends cycles trying, and a run with
 * the tools and no notice never opens them. `taskboard` is the single thing both
 * are keyed on, so the two cannot drift apart.
 *
 * Switching the setting under a run in flight costs that run one cold prefix on
 * its next cycle, once — the same charge `COMMIT_IDENTITY_NOTICE` names for a
 * reword. That is the price of the toggle being live rather than frozen at
 * creation, and it is the right way round: an operator switching this off has
 * decided an unattended agent should not be writing to their database, and
 * waiting for every run in flight to end is not a way to honour that.
 */
const TASKBOARD_NOTICE =
  "This app keeps a taskboard — the operator's own backlog — and you can reach " +
  "it. Call list_my_tasks to see the task this run was started for and what " +
  "else is open in the folder you are working in. When the work you were given " +
  "is done, call complete_task on it: you can complete only a task already " +
  "recorded against this run, and nothing you have can close anybody else's or " +
  "start any work. When you notice something that needs fixing and is not what " +
  "you were asked to do, call create_task to write it down and carry on with " +
  "your own change — a brief somebody can pick up later is worth more than a " +
  "fix nobody asked for, and widening your own work is how a diff a reviewer " +
  "could read stops being one. Say in your reply what you filed.";

export function buildArgs(opts: {
  prompt: string;
  model: string | null;
  permissionMode: PermissionMode;
  resumeSessionId: string | null;
  /** A run with its own checkout and branch, which is told to commit to it. */
  isolated: boolean;
  /**
   * This run's own spending limit, and what it has already spent against it.
   *
   * Together they become `--max-budget-usd`, which is the only thing that
   * bounds what *one work cycle* may spend. Everything else about
   * `maxRunCostUSD` is read between cycles, so a run at $34.99 of a $35 limit
   * used to be authorised for one more cycle of any size at all — the guard
   * bounded the number of cycles that may start past the threshold and nothing
   * bounded the amount the one crossing it spent. Concurrency multiplies that:
   * twenty-five runs whose settings page reads $875 had no upper bound this
   * app enforced.
   *
   * The arithmetic is here rather than at the call site because both ways of
   * getting it wrong are silent. `spentGuardUSD` is the *guard* figure — the
   * same `spentUSD + spentGuardEstUSD` the pre-cycle check compares, never
   * `runs.spent_usd` alone, which is a floor of what the CLI itself measured
   * and excludes a killed cycle's reconciled estimate. Handing over a ceiling
   * derived from the floor would give the child more room than the guard
   * believes the run has left, which is the display-versus-guard split
   * inverted at the one door where it costs money.
   *
   * `Math.max(0, …)` cannot be reached today — the pre-cycle guard blocks at
   * `>=`, so the remainder is strictly positive by the time anything is
   * spawned — and it stays because a negative would be a *widening*: the CLI
   * would take it as no ceiling at all, or reject the argv, and both fail
   * towards spending.
   */
  maxRunCostUSD: number | null;
  spentGuardUSD: number;
  /**
   * The agent this run **is**, or null for an ordinary run.
   *
   * This used to be a list, offered to the run's own main thread as specialists
   * it might delegate to (`--agents` alone). It is now the session's own agent:
   * `sessionAgentArgs` emits the definition *and* selects it by name, so the
   * saved prompt is what this run opens with rather than a role it may hand a
   * subtask to.
   *
   * **It bounds nothing, and the two measurements that make that true are worth
   * having in front of anyone editing this function.** The permission mode, the
   * isolation grant and the deny list below are unchanged by it, and the
   * appended system prompt still arrives — verified on the pin, because the
   * failure if it did not would be silent and expensive in both directions: an
   * isolated run whose preamble stopped arriving finishes `completed` on a
   * branch with no commits, and a run that never saw `SELF_HOSTING_NOTICE` is
   * one that has not been told why `pkill` is denied or what to do instead.
   * `--agent` also survives `--resume`, which is what makes it true of every
   * cycle rather than only the first.
   */
  agent?: AgentDefinition | null;
  /**
   * Forward what a delegated turn says into this run's own stream.
   *
   * Gated by the CLI on `--print` and `--output-format=stream-json`, which the
   * first line below supplies unconditionally, so this flag is never carried
   * into a spawn that would ignore it. What it changes is the *shape* of the
   * stream rather than what the run may do — see `settings.forwardSubAgentText`
   * for why that is worth a switch, and `handleStreamLine` for the one property
   * that makes the new shape safe.
   */
  forwardSubAgentText?: boolean;
  /**
   * Claude Code plugin directories to load, already proved inside a mount.
   *
   * Passed per cycle rather than once, and that is the property to preserve:
   * `--plugin-dir` is **not** restored by `--resume`, so a version of this that
   * only sent it on the opening cycle would leave every later cycle of the same
   * run without the plugins — silently, since a session missing a hook behaves
   * exactly like one that never had it. `buildArgs` already rebuilds the argv
   * per cycle, so the correct shape is the default one; the test beside it
   * asserts the flag survives a `resumeSessionId`.
   *
   * Optional so that the many call sites in the tests need not thread it, and
   * absent means no plugins rather than a default set — this is the list that
   * decides what code twenty-five unattended agents load, and it is not
   * something to acquire by omission.
   */
  pluginDirs?: readonly string[];
  /**
   * The generated vault-lookup skill, when the operator has switched it on.
   *
   * It arrives as a plugin directory for the reason `plugins.ts` gives — the
   * shared `~/.claude` mount makes installing one a way to silently break the
   * host's — and it rides `--plugin-dir` with the enabled plugins rather than a
   * mechanism of its own, so `--resume` drops it and re-passing it per cycle
   * covers it in exactly the same breath.
   *
   * `vaultPath` is separate from the directory because it becomes `--add-dir`.
   * The vault is not the run's workspace, and an isolated run's checkout is the
   * only directory it gets by default, so without this the skill would name a
   * path the run may not read — a skill that reads as available and fails on
   * use, which is the failure this whole feature is built to avoid. Note what
   * measurement showed the flag actually does: `--add-dir` lands the directory
   * in the session's sandbox **write** set, not a read-only one, so it is the
   * skill's own text that has to forbid writing into the vault.
   */
  vaultSkill?: { pluginDir: string; vaultPath: string } | null;
  /**
   * The generated read-guard plugin, when the operator has switched it on.
   *
   * A third entry in the **same** `--plugin-dir` list rather than a flag of its
   * own, which is the property to preserve: the CLI takes one directory per
   * flag and repeats the flag, so anything that invented a second mechanism
   * here would have to re-earn the "not restored by `--resume`, therefore on
   * every cycle's argv" rule that this list already has. It ships hooks and no
   * skill, so unlike the vault skill it puts nothing into the window and needs
   * no `--add-dir`: the directories it guards are the ones the run already has.
   *
   * `readGuard.ts` carries what it does and why it is off by default. Optional
   * for `pluginDirs`' reason — the call sites in the tests need not thread it,
   * and absent means no guard rather than a default one.
   */
  readGuardDir?: string | null;
  /**
   * The run's own frozen file price list, or nothing.
   *
   * Read from `runs.file_cost_notice` and **never** rebuilt here. It is the one
   * value on this argv whose recomputation would be silently expensive rather
   * than silently wrong: it joins the appended system prompt, the appended
   * system prompt is part of the cached prefix, and a prefix that changes
   * between two cycles of one run is a full-price re-read of a context that
   * averages 190,000 tokens. That is why it arrives as a stored string instead
   * of a folder this function could walk — the shape makes the mistake hard to
   * make. `fileCostNotice.ts` carries the measurement behind the feature.
   *
   * Optional, and absent means an argv byte-identical to the one this app
   * emitted before the notice existed — which is what every run created before
   * the column gets, and what a run whose folder could not be walked gets.
   */
  fileCostNotice?: string | null;
  /**
   * Directories this cycle may write to beyond its own working one, or null.
   *
   * Null is "nothing confines this cycle" — an install with no managed sandbox,
   * or a run whose paths resolved to a set this app could not spell — and it is
   * *not* the same as an empty list, which would be a confinement that permits
   * no writes at all. `sandboxWritableRoots` in `orchestrator.ts` owns which
   * readings produce which, and its doc carries why an install without a
   * sandbox must keep an argv byte-identical to the one it had before.
   *
   * It arrives here rather than being appended to the finished argv by the run
   * loop, which is where it used to be, because the flag that carries it is not
   * the same flag for every provider: Claude Code takes a `--settings` overlay
   * naming `sandbox.filesystem.allowWrite`, Codex takes a repeated `--add-dir`.
   * Appended outside the adapter, a Codex cycle would have been handed a
   * Claude-only flag — which `codex exec` rejects, so every such run would have
   * failed at the spawn with an argv error and no write set at all.
   */
  writableRoots?: readonly string[] | null;
  /**
   * Where the CLI should write this cycle's last message, for a CLI that offers
   * it. Ignored by `buildArgs`; `buildCodexArgs` turns it into
   * `--output-last-message`, and `runIteration` reads the file back off the
   * argv. See `buildCodexArgs` for why the file outranks the stream.
   */
  lastMessageFile?: string | null;
  /**
   * The directory the cycle is spawned in, for a CLI that resolves its
   * workspace from a flag rather than from `cwd`.
   *
   * Ignored by `buildArgs`, which needs no flag for it: `runIteration` passes
   * the same path to `spawn` and Claude Code takes its workspace from there.
   * `buildCodexArgs` emits it as `-C`, and the reason it must is that `-C` is
   * also what `workspace-write` grants — a Codex cycle that stated no working
   * root would take one from wherever the process happened to start, and the
   * directory the run loop re-proved contained a moment earlier would not be
   * the directory the sandbox opened.
   */
  workDir?: string | null;
  /**
   * The taskboard tool surface, when the operator has switched it on.
   *
   * `mcpConfigPath` is a file `chat.ts`'s `writeMcpConfig` wrote for this cycle,
   * holding a capability token minted for this run. It becomes `--mcp-config`,
   * and it is passed per cycle for `pluginDirs`' reason, which applies with
   * exactly the same force: **`--resume` does not restore it**, so a version of
   * this that sent it only on the opening cycle would leave every later cycle of
   * the same run without the board — silently, since a session with no tools
   * looks exactly like a model that chose not to call one. The path itself is
   * per cycle even though the token is per run, so a config left behind by a
   * killed cycle is one file rather than a credential outliving the run.
   *
   * **`--strict-mcp-config` is deliberately absent**, which is the one thing on
   * this argv not to copy from `chat.ts`. The chat child passes it because its
   * tool surface is closed by design — an orchestrator turn is meant to reach
   * this app and nothing else. A work cycle's is not: the operator's own MCP
   * servers, configured in the `~/.claude` this app mounts, are part of what
   * their agents work with. Strict here would silently strip every one of them
   * from every run the moment this setting was switched on, which is a
   * regression an operator would read as their servers having broken.
   *
   * Optional, and absent means an argv byte-identical to the one this app
   * emitted before the board existed — which is what every run gets while the
   * setting is off.
   */
  taskboard?: { mcpConfigPath: string } | null;
}): string[] {
  const args = ["-p", opts.prompt, "--output-format", "stream-json", "--verbose"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
  if (opts.forwardSubAgentText) args.push("--forward-subagent-text");
  // One encoder for every spawn site, because every way of getting the shape
  // wrong is silent when a member is merely offered and fails the spawn outright
  // when it is selected — see `agentsFlagValue` and `sessionAgentArgs`. This
  // sits above `--allowedTools` and `--append-system-prompt` rather than below
  // for no reason but reading order; the CLI takes the flags in any order.
  args.push(...sessionAgentArgs(opts.agent));
  // Additive: `--allowedTools` names what skips the prompt, and everything else
  // still follows the mode. It is not the allowlist `chat.ts` runs under, where
  // `manual` mode is what makes the same flag exhaustive.
  //
  // One flag rather than two, and the git grant stays in front of the search
  // one: a second `--allowedTools` is a variadic option the CLI would read as a
  // replacement rather than an addition, and the order is what the assertions
  // beside this read. `SEARCH_TOOLS` is last because it is the entry that is
  // always there.
  args.push(
    "--allowedTools",
    ...(opts.isolated ? ISOLATED_GIT_TOOLS : []),
    ...SEARCH_TOOLS,
  );
  // Unconditional, and deliberately not paired with the isolation flag above:
  // a run in the operator's own checkout is inside the same process as one in a
  // worktree, and the kill does not care which.
  args.push("--disallowedTools", ...PROCESS_KILLERS);
  // One flag carrying every notice, for the reason `--allowedTools` carries both
  // its lists: a second `--append-system-prompt` is a replacement, not an
  // addition, and losing one of them would be silent. The last two are per-run
  // and may be absent, so they are filtered rather than interpolated — an argv
  // with neither must be exactly the string it was before either feature
  // existed, trailing blank lines included, or every run without them pays a
  // cold prefix on its next cycle for a notice it did not get.
  args.push(
    "--append-system-prompt",
    [
      SELF_HOSTING_NOTICE,
      DELEGATION_NOTICE,
      RENDERING_NOTICE,
      COMMIT_IDENTITY_NOTICE,
      opts.taskboard ? TASKBOARD_NOTICE : null,
      opts.fileCostNotice?.trim(),
    ]
      .filter((notice): notice is string => Boolean(notice))
      .join("\n\n"),
  );
  // Above `--resume` only for reading order. What matters is that it is here at
  // all on a resumed cycle: see `pluginDirs`.
  args.push(
    ...pluginDirArgs([
      ...(opts.pluginDirs ?? []),
      ...(opts.vaultSkill ? [opts.vaultSkill.pluginDir] : []),
      ...(opts.readGuardDir ? [opts.readGuardDir] : []),
    ]),
  );
  // Beside `--plugin-dir` because it shares that flag's one property: not
  // restored by `--resume`, therefore on every cycle's argv rather than only the
  // first. No `--strict-mcp-config` beside it — see `taskboard`.
  if (opts.taskboard) args.push("--mcp-config", opts.taskboard.mcpConfigPath);
  // The run's cwd is its workspace and needs no flag; this is the one
  // directory it is told about that is not its own. `--add-dir` is variadic,
  // which is worth knowing when moving it — measured against the pinned CLI, a
  // flag immediately after it parses as a flag rather than being eaten as
  // another directory, so it is safe here in the middle of the argv.
  if (opts.vaultSkill) args.push("--add-dir", opts.vaultSkill.vaultPath);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  // **`--autocompact` used to be emitted here and deliberately is not any
  // more.** `contextPruning.ts` is what bounds a cycle's context now: it prunes
  // the transcript at each cycle boundary and ends a cycle early once its
  // context passes `CYCLE_CONTEXT_CEILING_TOKENS`. That constant *was* the same
  // 167,000 the flag fired at, which is what made the swap comparable; it is
  // 200,000 since 2026-08-25, and `contextPruning.ts` carries why — including
  // why it is not the 300,000 it briefly stood at on that same day.
  //
  // What that swap gave up is on the record rather than in a commit message,
  // because it is the strongest measurement this repository has and a later
  // reading must be able to tell a decision from a regression. The flag created
  // the only compaction threshold there was — the pinned bundle refuses to
  // auto-compact a window resolving to `source:"auto"` at or above 1e6, and this
  // install's model resolves exactly that, so before it 604 container sessions,
  // 246 of them past 167,000 tokens and one request reaching 752,172, produced
  // zero `compact_boundary` records. With it, a natural experiment over 1,147
  // transcripts split at the commit that added it put turns past the cap at
  // 0.45× per turn and 0.50× per 1,000 output tokens.
  //
  // The two are not the same operation and that is the case for the swap:
  // compaction replaces the conversation with a summary and the detail is gone,
  // where a prune removes tool output and keeps the conversation. It is also no
  // longer true that nothing resets a prefix — a boundary prune does, at the one
  // moment it is free. `docs/verification.md` carries both halves.
  // A hard stop inside the CLI, the same mechanism a chat turn and an
  // orchestrator block already carry — and the only one that can bound the
  // cycle that crosses the threshold rather than the one after it. Per
  // invocation, so a resumed session is bounded by what is left *now* rather
  // than by what the conversation has cost since it opened.
  if (opts.maxRunCostUSD !== null) {
    const remaining = Math.max(0, opts.maxRunCostUSD - opts.spentGuardUSD);
    args.push("--max-budget-usd", String(remaining));
  }
  // Last, and that position is asserted rather than incidental: this used to be
  // appended by the run loop after `buildArgs` returned, so an install with a
  // managed sandbox has an argv on record ending in these two entries and a
  // stock install has one that never contained them. Both stay byte-identical.
  if (opts.writableRoots && opts.writableRoots.length > 0) {
    args.push(
      "--settings",
      JSON.stringify({ sandbox: { filesystem: { allowWrite: opts.writableRoots } } }),
    );
  }
  return args;
}

/* ------------------------------------------------------------------ */
/* Codex                                                               */
/* ------------------------------------------------------------------ */

/**
 * A permission mode as a Codex sandbox and approval pair.
 *
 * The two axes are separate flags and both have to be named, because the
 * defaults are not the narrow reading: `codex exec` with neither flag takes its
 * sandbox and its approval policy from `$CODEX_HOME/config.toml`, which is a
 * file this app does not write and an operator may have widened. `buildCodexArgs`
 * also passes `--ignore-user-config` for that reason, so what is here is what
 * the cycle runs under and nothing else can raise it.
 *
 * **The rule this table exists to keep is that no row may widen.** A run whose
 * Claude equivalent cannot write files must not become one that can, and the
 * safe direction when the two CLIs do not line up exactly is *narrower*, which
 * is what two of the four rows take. Reading each:
 *
 * - **`plan`** → `read-only`. Claude's plan mode reads and proposes and writes
 *   nothing; `read-only` is the same statement in Codex's vocabulary, and it is
 *   the only pair that makes the prohibition the sandbox's rather than the
 *   model's to honour.
 *
 * - **`default`** → `read-only`, and this is the row to read before editing.
 *   `default` is the mode that *asks a person*, and no work cycle has one: it
 *   runs unattended, with no terminal and no approval channel. There are two
 *   readings of what that should become and only one of them is safe. If
 *   Claude's `default` denies unattended edits, `read-only` is the exact
 *   translation; if it permits them, `read-only` is a narrowing — and a
 *   narrowing is allowed where a widening is not. `workspace-write` would only
 *   be correct under the second reading, which has not been measured here, so
 *   it is not what this emits. The cost is real and is disclosed rather than
 *   hidden: a `default` Codex run cannot edit files, and an operator who wants
 *   one that can picks `acceptEdits`, which is what the run form already
 *   defaults to.
 *
 * - **`acceptEdits`** → `workspace-write`. The one exact correspondence in the
 *   table: edits inside the workspace proceed without asking, everything
 *   outside it does not. `--add-dir` extends that write set, which is why the
 *   vault and the confinement roots are emitted as `--add-dir` below rather
 *   than as anything of this app's own devising.
 *
 * - **`bypassPermissions`** → `--dangerously-bypass-approvals-and-sandbox`, and
 *   no `-s` beside it. It is the mode whose whole content is "no sandbox, no
 *   approvals", so the flag is the translation rather than an escalation. The
 *   `-s` is withheld because the two were measured to be accepted together and
 *   *nothing says which wins* — an argv whose write set depends on an
 *   undocumented precedence is one nobody can read.
 *
 * `approval_policy` is `never` on every row that has one, and that is the narrow
 * choice rather than the permissive-sounding one. It means the model may not
 * escalate out of its sandbox: a command the sandbox refuses fails, instead of
 * raising a request that — with no operator anywhere near it — would hang the
 * cycle until its silence deadline or be granted by something that is not a
 * person. **`--approve-for-me` is deliberately never emitted for exactly that
 * reason**: it routes approvals "through automatic review", which is a second
 * model deciding to widen a run past the mode its operator chose.
 */
export const CODEX_PERMISSIONS: Readonly<
  Record<PermissionMode, readonly string[]>
> = Object.freeze({
  plan: Object.freeze(["-s", "read-only", "-c", 'approval_policy="never"']),
  default: Object.freeze(["-s", "read-only", "-c", 'approval_policy="never"']),
  acceptEdits: Object.freeze([
    "-s",
    "workspace-write",
    "-c",
    'approval_policy="never"',
  ]),
  bypassPermissions: Object.freeze(["--dangerously-bypass-approvals-and-sandbox"]),
});

/**
 * The notices that ride the prompt because Codex has no system prompt to append.
 *
 * `buildArgs` puts four of these on `--append-system-prompt`, where they are out
 * of the conversation and repeated on every cycle including a resumed one.
 * `codex exec` has no equivalent, and the search for one is on the record so it
 * is not repeated: there is no `--append-system-prompt`, no `--system-prompt`,
 * `-p/--profile` cannot reach a resumed or forked session at all, and
 * `experimental_instructions_file` — the config key such a thing would use —
 * **does not exist in this build**, with zero occurrences in the binary. The
 * remaining mechanism is `AGENTS.md` discovery, which means writing a file into
 * the operator's own working root, and this app does not write into a repository
 * it was pointed at.
 *
 * So they go in-band, at the head of the prompt, and that is weaker in two ways
 * an editor should not have to rediscover. In-band text is *conversation*: the
 * model may weigh it against later instructions, and a long turn may push it out
 * of attention in a way a system prompt is not pushed. And it is repeated into
 * the transcript on every cycle rather than sitting outside it.
 *
 * Two of the four notices are carried and two are not, which is a judgement
 * rather than an oversight. `SELF_HOSTING_NOTICE` is the recipe that stops an
 * agent routing around the `pkill` denial, and `codexRules.ts` makes that denial
 * weaker here than it is for Claude, so it matters *more* on this provider, not
 * less. `COMMIT_IDENTITY_NOTICE` is about a git identity, which is the same git.
 * The delegation and rendering notices are dropped: both name a mechanism by
 * which Claude Code in particular does something — a sub-agent's own context
 * window, and reading a rendered PNG back as an image — and neither is known to
 * be true of `codex exec`. Telling an agent to use a capability it may not have
 * is how it learns to reach for an absent tool, which is the argument
 * `SELF_HOSTING_NOTICE` already makes about naming `docker`, `fuser` and `ss`.
 */
export function codexPromptPreamble(fileCostNotice?: string | null): string {
  return [SELF_HOSTING_NOTICE, COMMIT_IDENTITY_NOTICE, fileCostNotice?.trim()]
    .filter((notice): notice is string => Boolean(notice))
    .join("\n\n");
}

/**
 * The argv for one Codex work cycle.
 *
 * Takes the same options object as `buildArgs` — spelled as its parameter type
 * rather than as a second interface, so that a field added for one provider is
 * a field the other has to decide about rather than one it never sees. Several
 * are deliberately unused here and each absence is a real difference an operator
 * can be shown, not a gap to fill later:
 *
 * - **`maxRunCostUSD` reaches nothing.** `codex exec --help` has no counterpart
 *   to `--max-budget-usd`, so nothing bounds what a single Codex cycle spends.
 *   That is the whole reason `providerTerminusRefusal` exists in `budget.ts`:
 *   such a run is refused at the door unless a work-cycle or time limit bounds
 *   it, because its spending limit reaches no cycle.
 * - **`agent`, `pluginDirs`, `forwardSubAgentText`.** Claude Code mechanisms
 *   with no Codex equivalent on this CLI surface. A run started as an agent and
 *   spawned as Codex opens on its prompt through the ordinary prompt path and
 *   gets none of the rest, which is why the run form discloses it.
 * - **`isolated`.** `ISOLATED_GIT_TOOLS` is an `--allowedTools` entry, and
 *   Codex's tool permissions are the sandbox rather than a list. An isolated
 *   Codex run under `acceptEdits` can commit because `workspace-write` covers
 *   its checkout, not because anything here granted it.
 * - **`taskboard`.** `--mcp-config` is a Claude Code flag; Codex configures MCP
 *   servers through `config.toml`, which `--ignore-user-config` above
 *   deliberately keeps out of the cycle. A Codex run therefore reaches no board,
 *   and it is told about none for the same reason it is told nothing else this
 *   function does not emit: `TASKBOARD_NOTICE` is `buildArgs`' string and there
 *   is no `--append-system-prompt` here at all. The run loop does not prepare
 *   the config for a Codex cycle either, so no capability token is minted for a
 *   run that could never spend it.
 *
 * What it does emit, and why each is load-bearing:
 *
 * `--json` is the stream `handleCodexStreamLine` reads, and stdout under it was
 * measured to be pure JSONL — every warning and trace line goes to stderr, so
 * an unparseable stdout line means the format changed rather than that a log
 * line got mixed in.
 *
 * `-C` pins the working root explicitly even though the child is already
 * spawned with that `cwd`. Codex resolves its workspace from the flag when one
 * is given, and stating it is what makes the write set `workspace-write` grants
 * the same directory the run loop re-proved contained a moment earlier.
 *
 * `--skip-git-repo-check` is required rather than chosen: Codex refuses to run
 * outside a git repository, and this app's runs are pointed at arbitrary mounted
 * folders. Its purpose there is to make a model's changes recoverable, and what
 * replaces it here is the isolation the run already has — a worktree run has its
 * own branch, and a non-isolated run is in the operator's own checkout either
 * way, which is exactly the case Claude Code has never guarded against.
 *
 * `--ignore-user-config` keeps `$CODEX_HOME/config.toml` out of the cycle. It is
 * the file the *operator* edits, it can raise `sandbox_mode`, `approval_policy`
 * and network access, and a run whose permissions came half from this argv and
 * half from a file nobody diffed is one whose mode means nothing. It does not
 * touch authentication (`--help`: "auth still uses `CODEX_HOME`") and it does
 * not touch `.rules` — only `--ignore-rules` does that, and this never emits it,
 * because those rules are the `pkill` denial.
 */
export function buildCodexArgs(opts: Parameters<typeof buildArgs>[0]): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
  ];
  if (opts.model) args.push("-m", opts.model);
  if (opts.workDir) args.push("-C", opts.workDir);
  args.push(...CODEX_PERMISSIONS[opts.permissionMode]);
  // Every directory beyond the working root, in one list rather than two
  // mechanisms: the vault this run was granted and whatever the install's
  // sandbox confines it to are the same kind of fact here, where for Claude Code
  // they are `--add-dir` and a `--settings` overlay respectively. `--add-dir` is
  // repeatable and takes one directory each time.
  for (const dir of [
    ...(opts.vaultSkill ? [opts.vaultSkill.vaultPath] : []),
    ...(opts.writableRoots ?? []),
  ]) {
    args.push("--add-dir", dir);
  }
  if (opts.lastMessageFile) {
    args.push("--output-last-message", opts.lastMessageFile);
  }
  // Resume last, because it is a *subcommand* and not a flag: `codex exec resume
  // <id>` takes the prompt after the id, so everything above has to precede it.
  //
  // That ordering is the whole of why this works, and it was measured rather
  // than assumed. `resume` itself accepts none of `-s`, `-C`, `--add-dir` or
  // `--approve-for-me`, which reads at first like a second cycle silently losing
  // its sandbox. It does not: placed *before* the subcommand they are the parent
  // command's flags and they take effect on the resumed session. Read back out
  // of `$CODEX_HOME/sessions/…/rollout-*.jsonl`, one session opened under
  // `-s workspace-write --add-dir X` records `{"sandbox_policy":
  // {"type":"workspace-write","writable_roots":["X"],"network_access":false}}`,
  // and the same session resumed under `-s read-only` records a second
  // `sandbox_policy` of `read-only`. A version of this that put the flags after
  // the id would be rejected outright, which is the good failure; a version that
  // dropped them would confine nothing, which is not.
  if (opts.resumeSessionId) {
    args.push("resume", opts.resumeSessionId);
  }
  // The prompt is the positional argument, and the notices are in front of it
  // because there is nowhere else for them to go. Last on the argv so that
  // nothing after it can be read as a flag.
  args.push(`${codexPromptPreamble(opts.fileCostNotice)}\n\n${opts.prompt}`);
  return args;
}

/**
 * Everything the run loop knows about the agent CLI it spawns.
 *
 * Three things and no more: which executable a cycle is, what argv it is given,
 * and how one line of its stdout is read back. They are named together rather
 * than reached for separately because they are only correct as a set — an argv
 * built for one CLI and parsed as another's produces a cycle with no cost, no
 * session id and no stop reason, which is not an error anywhere: the run page,
 * the log and the exit code are those of a cycle that finished with nothing to
 * say. Selecting the three in one place is what makes that combination
 * impossible to reach by forgetting one.
 *
 * `bin` is a field rather than a call so that it is fixed at the same moment
 * the other two are. Reading it at the spawn instead would let a cycle's argv
 * and its executable be chosen by different code at different times, which is
 * the same failure one step further down.
 *
 * **There is exactly one implementation and adding a second is a separate
 * change.** `proposals/ProviderFallback/05-option-c-provider-at-spawn.md` sets
 * out what a second one owes — a column, a form field, an admission refusal for
 * a policy whose only limits this app cannot enforce — and none of it is here.
 */
export interface CycleAdapter {
  /** The executable a work cycle spawns. */
  readonly bin: string;
  /** This cycle's argv, rebuilt per cycle because `--resume` restores little. */
  readonly buildArgs: typeof buildArgs;
  /** One line of its `stream-json` stdout, folded into the cycle's totals. */
  readonly parseLine: (
    runId: string,
    line: string,
    acc: IterationResult,
    onSession: (sessionId: string) => void,
  ) => void;
}
