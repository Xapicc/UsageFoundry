import fs from "node:fs";

import { db } from "./db";
import { BYTES_PER_TOKEN } from "./fileCostNotice";
import { opsLog, recordOpsEvent } from "./ops";
import type {
  ContextCheckDTO,
  ContextOccupancyDTO,
  ContextSampleBasisDTO,
} from "./apiTypes";

/**
 * Context occupancy — how much a live run's conversation is carrying, sampled
 * off its own transcript and kept as a series for the run page's chart.
 *
 * It measures and records; nothing here acts on what it reads. A cycle's
 * context is bounded only by the CLI's own auto-compaction against the model's
 * window, so the series is evidence for an operator rather than an input to a
 * guard.
 */

/**
 * The API-visible size of a transcript, in tokens, estimated from its content.
 *
 * Only `message` is counted. A transcript record carries the message the CLI
 * sent alongside envelope fields it did not — `toolUseResult` most of all — so
 * counting the file would report context that was never in anybody's prompt.
 *
 * Estimated through `BYTES_PER_TOKEN` rather than counted exactly, for the
 * reason `fileCostNotice.ts` states: a tokeniser here would be a second
 * dependency and a per-cycle cost. It is the fallback measure, used only where
 * a transcript has no `usage` frame to read the real figure off.
 *
 * Returns 0 for a file it cannot read, never throws: every caller is on the run
 * loop's path and none of them should end a cycle over a stat.
 */
export function contextTokens(transcriptPath: string): number {
  let text: string;
  try {
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return 0;
  }
  return contextTokensOf(text);
}

/**
 * The measurement above, over text the caller has already read.
 *
 * `readContext` reaches its fallbacks holding the whole file in a string, and
 * calling `contextTokens` from there read those same bytes off disk a second
 * time within the one call — 7.6 ms of the 31.9 ms that call costs on the
 * largest transcript this store holds. Measuring the string in hand also makes
 * the two halves of the answer describe one snapshot rather than two reads taken
 * milliseconds apart on a file being appended to.
 */
function contextTokensOf(text: string): number {
  let bytes = 0;
  // The whole walk stays inside a catch, not just the per-line parse: the
  // measurement above promises never to throw, its callers are all on the run
  // loop, and splitting the read out of that promise must not quietly narrow
  // it. `miss` reaches this directly, so the guarantee has to live here.
  try {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        // A torn trailing line is normal on a transcript being appended to.
        continue;
      }
      const message = (record as { message?: unknown } | null)?.message;
      if (message === undefined || message === null) continue;
      bytes += JSON.stringify(message).length;
    }
  } catch {
    return 0;
  }
  return Math.round(bytes / BYTES_PER_TOKEN);
}

/**
 * The context the **API actually saw**, read off the transcript's own `usage`.
 *
 * ## Why this is not `contextTokens`, and why both have to exist
 *
 * `contextTokens` sums the transcript's message envelopes and divides by
 * `BYTES_PER_TOKEN`, and the transcript is not what the API receives: the
 * prompt also carries a system prompt, tool list and project instructions no
 * transcript holds, and `bytes / 4` runs high on structured tool output. The
 * `usage` frame is the API's own count of what it was sent.
 *
 * ## What it returns
 *
 * The prompt the last completed request carried, plus that turn's output, which
 * together are what the *next* request will carry before it adds anything new.
 * `input + cache_creation + cache_read` is the whole prompt however it was
 * billed — a cached token is still a token the model reads.
 *
 * It lags by one turn by construction, because it reports a request that has
 * finished.
 *
 * Falls back to `contextTokens` rather than to zero when no usage frame exists —
 * a fresh session, or one whose only assistant turns are `<synthetic>`. Zero
 * would read as "this run is empty", which a chart of a live run must not say.
 */
export function apiContextTokens(transcriptPath: string): number {
  return readContext(transcriptPath, null, false).tokens;
}

/**
 * The same reading, plus where in the conversation it came from.
 *
 * A sibling of `apiContextTokens` rather than a widening of it, because the two
 * callers want different amounts of work out of one scan. `apiContextTokens`
 * wants the number and nothing else, and its scan stops at the first `usage`
 * frame — a handful of lines from the end of the file. The occupancy series
 * also wants a turn count, and
 * a count means walking back **past** that frame, so it is asked for explicitly
 * and only by the caller that needs it.
 *
 * `sinceFrameId` is what keeps that walk cheap in the steady state: given the
 * frame the previous sample came from, the scan stops there, so it parses only
 * the turns that have happened since. A run's *first* sample has nothing to stop
 * at and pays for the whole window once.
 *
 * Never throws, `apiContextTokens`' rule and for its reason: every caller is on
 * the run loop's path.
 */
export function apiContextSample(
  transcriptPath: string,
  sinceFrameId: string | null,
): ContextReading {
  return readContext(transcriptPath, sinceFrameId, true);
}

/**
 * Which measure produced a reading. Never mixed in one arithmetic.
 *
 * The two stored values are the DTO's, so a consumer and this module cannot
 * drift apart on what a series is measured in; `unreadable` is this side only,
 * because nothing that failed to read is ever written down.
 */
export type ContextBasis = ContextSampleBasisDTO | "unreadable";

/** One reading of a live transcript's tail. */
export interface ContextReading {
  /** What `apiContextTokens` answers; 0 under `unreadable`. */
  tokens: number;
  basis: ContextBasis;
  /**
   * `message.id` of the frame the number came from, or null — under the
   * `transcript` basis there is no frame, and a frame is not obliged to carry
   * an id. Null is what pushes deduplication down onto the number itself.
   */
  frameId: string | null;
  /**
   * Main-thread assistant turns between `sinceFrameId` and this reading, or —
   * when nothing was passed to stop at — every one the scan could see.
   */
  turnsAdvanced: number;
  /** Whether `sinceFrameId` was located, so the advance is a measurement. */
  sinceFound: boolean;
  /** Whether the scan reached the start of the file rather than of a window. */
  wholeFile: boolean;
}

function readContext(
  transcriptPath: string,
  sinceFrameId: string | null,
  countTurns: boolean,
): ContextReading {
  // `text` is the whole file where the caller already holds it, which every
  // path that reaches a `transcript` basis does — the fallback below has just
  // read it, and a tail that came back `whole` *is* it. Re-reading those bytes
  // was a second multi-megabyte read inside the one call.
  const miss = (
    basis: ContextBasis,
    wholeFile: boolean,
    text?: string,
  ): ContextReading => ({
    tokens:
      basis === "unreadable"
        ? 0
        : text !== undefined
          ? contextTokensOf(text)
          : contextTokens(transcriptPath),
    basis,
    frameId: null,
    turnsAdvanced: 0,
    sinceFound: false,
    wholeFile,
  });

  let tail: { text: string; whole: boolean };
  try {
    tail = readTail(transcriptPath, TAIL_SCAN_BYTES);
  } catch {
    return miss("unreadable", false);
  }
  const fromTail = scanTail(tail.text, sinceFrameId, countTurns);
  if (fromTail) return { ...fromTail, basis: "api", wholeFile: tail.whole };
  if (!tail.whole) {
    // Nothing usable in the last megabyte, which is possible rather than
    // theoretical: the largest transcript on this install is 9.1 MB over 789
    // lines, so one tool result can be bigger than the window. Pay for the whole
    // file rather than report a conversation as empty.
    let whole: string;
    try {
      whole = fs.readFileSync(transcriptPath, "utf8");
      const fromWhole = scanTail(whole, sinceFrameId, countTurns);
      if (fromWhole) return { ...fromWhole, basis: "api", wholeFile: true };
    } catch {
      // The read *or* the scan: both were inside this catch before the text was
      // hoisted out of it, and a scan that threw answered `unreadable`.
      return miss("unreadable", false);
    }
    return miss("transcript", true, whole);
  }
  // `tail.whole` is true here, so `readTail` returned the file entire and it is
  // exactly what `contextTokens` would have gone back to disk for.
  return miss("transcript", tail.whole, tail.text);
}

/** What one backwards pass over a transcript's tail found. */
interface TailScan {
  tokens: number;
  frameId: string | null;
  turnsAdvanced: number;
  sinceFound: boolean;
}

/**
 * The prompt-plus-output of the last main-thread turn in `text`, and how many
 * turns have happened since `sinceFrameId`.
 *
 * One pass, backwards, because that is where the answer is and because a
 * transcript is appended to while this runs. Neither exclusion may be relaxed:
 * a sidechain is a
 * sub-agent's own conversation rather than this one's context, and a
 * `<synthetic>` frame is the CLI's record of an API-level refusal carrying an
 * all-zero `usage` block that would read as an empty run.
 *
 * Turns are counted as **distinct `message.id`s**, not as records: the CLI
 * writes an assistant turn that both spoke and called a tool as more than one
 * line sharing one id, and counting lines would report a tool-heavy run as
 * having had several times the turns it did.
 */
function scanTail(
  text: string,
  sinceFrameId: string | null,
  countTurns: boolean,
): TailScan | null {
  const lines = text.split("\n");
  let tokens: number | null = null;
  let frameId: string | null = null;
  let turnsAdvanced = 0;
  let lastId: string | null | undefined;

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let record: {
      type?: unknown;
      isSidechain?: unknown;
      message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> };
    };
    try {
      record = JSON.parse(trimmed);
    } catch {
      // A torn trailing line is normal on a transcript being appended to.
      continue;
    }
    if (record?.type !== "assistant") continue;
    // A sub-agent's turns are not this conversation's context, and
    // `<synthetic>` frames carry an all-zero usage block that would read as an
    // empty run.
    if (record.isSidechain === true) continue;
    const message = record.message;
    if (!message || typeof message !== "object") continue;
    if (message.model === "<synthetic>") continue;

    const id = typeof message.id === "string" && message.id ? message.id : null;

    // Read the number *before* testing for the stopping frame, so a tick on
    // which nothing has happened still reports that frame's own tokens rather
    // than zero. That case is the ordinary one: the ticker is time-based and one
    // tool call routinely outlasts several ticks.
    if (tokens === null) {
      const usage = message.usage;
      if (usage && typeof usage === "object") {
        const num = (key: string): number => {
          const v = usage[key];
          return typeof v === "number" && Number.isFinite(v) ? v : 0;
        };
        const prompt =
          num("input_tokens") + num("cache_creation_input_tokens") + num("cache_read_input_tokens");
        if (prompt > 0) {
          tokens = prompt + num("output_tokens");
          frameId = id;
          // `apiContextTokens` asked for a number and nothing else, so this is
          // where its scan ends — a few lines from the end of the file.
          if (!countTurns) break;
        }
      }
    }

    if (countTurns) {
      // Everything newer than the previous sample's frame is what has happened
      // since; the frame itself was counted by the sample that named it.
      if (id !== null && id === sinceFrameId) {
        if (tokens === null) return null;
        return { tokens, frameId, turnsAdvanced, sinceFound: true };
      }
      if (id === null || id !== lastId) turnsAdvanced += 1;
      lastId = id;
    }
  }
  if (tokens === null) return null;
  return { tokens, frameId, turnsAdvanced, sinceFound: false };
}

/**
 * How much of a transcript's end is read looking for the last `usage` frame.
 *
 * It bounds the work rather than guessing at it: the sample is taken on every
 * live-guard tick per live run, and the median transcript here is 771 KB
 * against a 9.1 MB largest, where a whole-file read and split measured 23 ms.
 *
 * A megabyte because a line is a turn and a turn can be a tool result. The
 * largest file here averages 11.6 KB per line, so this covers roughly 90 turns
 * of the worst case measured; the fallback above covers the rest rather than
 * this being sized for it.
 */
const TAIL_SCAN_BYTES = 1_048_576;

/**
 * The last `bytes` of a file, or all of it when it is smaller.
 *
 * `whole` is what tells the caller whether a miss is final. A window that
 * starts mid-line leaves a torn first line, which the scan below drops the same
 * way it drops the torn *last* line of a transcript being appended to — and a
 * window that starts mid-character leaves a replacement char in that same line.
 */
function readTail(file: string, bytes: number): { text: string; whole: boolean } {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= bytes) return { text: fs.readFileSync(fd, "utf8"), whole: true };
    const buffer = Buffer.allocUnsafe(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, size - bytes);
    return { text: buffer.subarray(0, read).toString("utf8"), whole: false };
  } finally {
    fs.closeSync(fd);
  }
}

/* ------------------------------------------------------------------ */
/* The occupancy series — what a live run's context was doing           */
/* ------------------------------------------------------------------ */

/**
 * How many samples one run may keep, oldest discarded first.
 *
 * These rows are written on the run loop's path for every live run and nothing
 * about a run bounds how many turns it takes, so an unbounded table here is a
 * defect rather than a follow-up. 2,000 is far past anything observed — the
 * series holds about one row per assistant turn once duplicates are dropped,
 * and no run on this install has come near that — so the cap is a backstop
 * against a pathological run rather than a shape the ordinary one meets.
 *
 * The **oldest** go, because the reason to look at this series is a run that is
 * either live now or was live recently, and its recent shape is what an operator
 * is reading. A run that hits the cap says so through `sampleCount`, which is
 * the stored total rather than the number returned.
 */
export const CONTEXT_SAMPLES_PER_RUN = 2_000;

/**
 * How many samples the run DTO carries, newest first.
 *
 * The run page polls that route every three seconds for as long as a tab is
 * open, and a run can be hours long, so the series is capped there as well as in
 * the table. A **tail** rather than a thinned series, deliberately: thinning
 * needs a rule about which points survive, and a series thinned by a rule the
 * consumer cannot see is a graph that lies about its own peaks — which is the
 * one thing a context meter must not do. The DTO carries the stored total beside
 * the array so a reader can see that it is holding the end of something longer.
 */
export const CONTEXT_SERIES_MAX_POINTS = 500;

/** The last sample stored for a run, as SQLite holds it. */
interface StoredSample {
  frame_id: string | null;
  basis: string;
  tokens: number;
  turn_index: number;
  turns_exact: number;
}

/**
 * Take a reading of one live run's context and store it if it is new.
 *
 * Called from the live-guard tick. It adds no tokeniser — the number is the
 * transcript's own `usage` — and returns the reading it stored.
 *
 * **Deduplicated on the frame the number came from.** The ticker is time-based
 * and a single tool call routinely outlasts several ticks, so consecutive reads
 * return the identical `usage` frame; a row per tick would make the series
 * mostly flat duplicates and a graph of it would understate how fast context is
 * actually growing. When there is no frame to name — the byte-estimate fallback,
 * or a frame carrying no id — the identity falls back to (basis, tokens), which
 * is the same statement one measure down.
 *
 * Never throws. A sample is evidence: losing one must not turn a live run into a
 * failed one.
 */
export function sampleContext(
  runId: string,
  iteration: number,
  transcriptPath: string,
): ContextReading {
  let last: StoredSample | undefined;
  try {
    last = db()
      .prepare(
        `SELECT frame_id, basis, tokens, turn_index, turns_exact
           FROM context_samples WHERE run_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(runId) as StoredSample | undefined;
  } catch (err) {
    // Read first so the scan can stop at the previous sample's frame. Failing
    // here costs the turn count its exactness, never the reading.
    noteBookkeepingFailure("sampleContext.read", err);
  }

  const reading = apiContextSample(transcriptPath, last?.frame_id ?? null);
  // Before every return below, because every one of them is a tick that looked.
  // The two returns that follow write no row, and they are the ordinary case
  // rather than the exception — see `noteContextCheck`.
  noteContextCheck(runId, reading);

  // A transcript that could not be read is not a run whose context fell to
  // nothing, and neither is a conversation that has not opened yet. Both would
  // draw a cliff that never happened, which is worse than a gap.
  if (reading.basis === "unreadable" || reading.tokens <= 0) return reading;
  if (last && sameReading(last, reading)) return reading;

  const turns = nextTurnIndex(
    last ? { turnIndex: last.turn_index, exact: last.turns_exact !== 0 } : null,
    reading,
  );

  try {
    db()
      .prepare(
        `INSERT INTO context_samples
           (ts, run_id, iteration, tokens, basis, frame_id, turn_index, turns_exact)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        runId,
        iteration,
        reading.tokens,
        reading.basis,
        reading.frameId,
        turns.turnIndex,
        turns.exact ? 1 : 0,
      );
    db()
      .prepare(
        `DELETE FROM context_samples
          WHERE run_id = ?
            AND id NOT IN (
              SELECT id FROM context_samples WHERE run_id = ? ORDER BY id DESC LIMIT ?
            )`,
      )
      .run(runId, runId, CONTEXT_SAMPLES_PER_RUN);
  } catch (err) {
    noteBookkeepingFailure("sampleContext", err);
  }
  return reading;
}

/**
 * Store a Codex cycle's context reading, `sampleContext`'s twin for the other
 * CLI.
 *
 * The same quantity on the same basis: `api`, the request's whole input as
 * the provider reported it — off the session rollout's `token_count`
 * (`codexRollout.ts`) where a Claude cycle's comes off its transcript's
 * `usage` frame — so the two series draw in one currency. What differs is the
 * line it is drawn against, which is why `window` is stored with it.
 *
 * Deduplicated on the reading's own instant, as `sampleContext` is on its
 * frame: the tick is time-based and a request outlasts several of them.
 * `advanced` is the requests this cycle made since the last stored sample, and
 * `wholeThread` says the count started at the thread's first request, which is
 * what makes the first sample's turn index exact. Never throws.
 */
export function sampleCodexContext(
  runId: string,
  iteration: number,
  reading: { contextTokens: number | null; contextWindow: number | null; at: number | null },
  advanced: number,
  wholeThread: boolean,
): void {
  const frameId = reading.at === null ? null : `codex:${reading.at}`;
  const basis = reading.contextTokens === null ? "unreadable" : "api";
  noteContextCheck(runId, {
    tokens: reading.contextTokens ?? 0,
    basis,
    frameId,
    turnsAdvanced: 0,
    sinceFound: false,
    wholeFile: false,
  });
  if (reading.contextTokens === null || reading.contextTokens <= 0) return;
  try {
    const last = db()
      .prepare(
        `SELECT frame_id, basis, tokens, turn_index, turns_exact
           FROM context_samples WHERE run_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(runId) as StoredSample | undefined;
    // The run's first sample of a thread seen from its first request is the one
    // whose turn count is complete by itself; every later one adds to the last.
    const fromThreadStart = wholeThread && !last;
    const asReading: ContextReading = {
      tokens: reading.contextTokens,
      basis,
      frameId,
      turnsAdvanced: Math.max(0, advanced),
      sinceFound: !fromThreadStart,
      wholeFile: fromThreadStart,
    };
    if (last && sameReading(last, asReading)) return;
    const turns = nextTurnIndex(
      last ? { turnIndex: last.turn_index, exact: last.turns_exact !== 0 } : null,
      asReading,
    );
    db()
      .prepare(
        `INSERT INTO context_samples
           (ts, run_id, iteration, tokens, basis, frame_id, turn_index, turns_exact, window_tokens)
         VALUES (?, ?, ?, ?, 'api', ?, ?, ?, ?)`,
      )
      .run(
        reading.at ?? Date.now(),
        runId,
        iteration,
        reading.contextTokens,
        frameId,
        turns.turnIndex,
        turns.exact ? 1 : 0,
        reading.contextWindow,
      );
    db()
      .prepare(
        `DELETE FROM context_samples
          WHERE run_id = ?
            AND id NOT IN (
              SELECT id FROM context_samples WHERE run_id = ? ORDER BY id DESC LIMIT ?
            )`,
      )
      .run(runId, runId, CONTEXT_SAMPLES_PER_RUN);
  } catch (err) {
    noteBookkeepingFailure("sampleCodexContext", err);
  }
}

/** Whether a new reading is the one already on the row. */
function sameReading(last: StoredSample, reading: ContextReading): boolean {
  if (reading.frameId !== null) return last.frame_id === reading.frameId;
  return (
    last.frame_id === null && last.basis === reading.basis && last.tokens === reading.tokens
  );
}

/**
 * When each live run's transcript was last read, whatever came of it.
 *
 * ## Why this is not the newest sample's timestamp
 *
 * Measured on this install: a run whose main agent spawned one sub-agent at
 * 18:15:59 gained no sample for **22 minutes**, because every frame written in
 * that stretch was `isSidechain` and this measure excludes them. The tick ran twenty-two times and read the transcript twenty-two
 * times; the figure it found was the same one every time, and it was *correct* —
 * the parent's context genuinely does not grow while a sub-agent works, since
 * nothing enters it until the tool result returns. The panel nonetheless said
 * "read 22m ago", which is what an operator reads as a dead poll, and the same
 * shape occurs on any tool call that outlasts a few ticks.
 *
 * So the two facts are stored separately: `context_samples` says when the number
 * last *moved*, and this says when it was last *looked at*.
 *
 * ## Why in memory and on `globalThis`
 *
 * It is a property of this process's ticker, not of the run — a server that has
 * just restarted has read nothing, however recently the run it inherited was
 * read by the server before it, and a stored row would let it claim otherwise
 * across exactly the restart an operator is most likely to be watching. A fresh
 * key rather than a reused one, per the note on `orchestrator.ts:373`: `??=`
 * only initialises when absent, so a key whose shape changed survives a dev hot
 * reload with the old value in it.
 *
 * Bounded by `forgetContextCheck` on the run's own teardown, beside the rest of
 * its per-run state.
 */
const contextChecks = ((globalThis as unknown as {
  __ufContextChecks?: Map<string, ContextCheckDTO>;
}).__ufContextChecks ??= new Map<string, ContextCheckDTO>());

/** Write down that a tick read this run, and what measure it came back in. */
function noteContextCheck(runId: string, reading: ContextReading): void {
  contextChecks.set(runId, { ts: Date.now(), basis: reading.basis });
}

/** The last read of one run, or null where this process has taken none. */
export function lastContextCheck(runId: string): ContextCheckDTO | null {
  return contextChecks.get(runId) ?? null;
}

/** Dropped with the run's other per-run state when its loop ends. */
export function forgetContextCheck(runId: string): void {
  contextChecks.delete(runId);
}

/**
 * Where a reading lands on the run's turn counter, and whether that is a fact.
 *
 * Pure, because every way of being wrong here typechecks and produces a number
 * that looks entirely ordinary — a turn axis that quietly stops advancing, or
 * one that double-counts a conversation after a resume, reads as the run having
 * behaved differently rather than as this arithmetic being wrong.
 *
 * Three cases and they are not the same case:
 *
 *  - The scan walked to the **start of the file** without meeting the frame it
 *    was told to stop at. There is nothing before what it counted, so this is
 *    the conversation's whole length rather than an advance on anything — which
 *    is also what a `--resume` into a new transcript looks like from here.
 *  - It met that frame, so the advance is measured and inherits whatever the
 *    previous index was.
 *  - It ran out of **window**. The tail scan is bounded at a megabyte, so the
 *    frame may be real and simply further back than the scan reached; the
 *    advance is then a floor, and a floor added to anything stays one.
 */
export function nextTurnIndex(
  last: { turnIndex: number; exact: boolean } | null,
  reading: Pick<ContextReading, "turnsAdvanced" | "sinceFound" | "wholeFile">,
): { turnIndex: number; exact: boolean } {
  if (!reading.sinceFound && reading.wholeFile) {
    return { turnIndex: reading.turnsAdvanced, exact: true };
  }
  if (last === null) return { turnIndex: reading.turnsAdvanced, exact: false };
  return {
    turnIndex: last.turnIndex + reading.turnsAdvanced,
    exact: last.exact && reading.sinceFound,
  };
}

/**
 * A run's occupancy series, newest `CONTEXT_SERIES_MAX_POINTS` oldest first, or
 * undefined when nothing has been sampled.
 *
 * `windowTokens` is the Codex window its rollout reported. A Claude run gets
 * none: no table of model windows exists here, and a line at a guess would be
 * read as a limit.
 */
export function contextOccupancy(runId: string): ContextOccupancyDTO | undefined {
  try {
    const rows = db()
      .prepare(
        `SELECT ts, iteration, tokens, basis, turn_index, turns_exact, window_tokens
           FROM context_samples WHERE run_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(runId, CONTEXT_SERIES_MAX_POINTS) as Array<
      StoredSample & { ts: number; iteration: number; window_tokens: number | null }
    >;
    if (rows.length === 0) return undefined;
    return {
      windowTokens: rows.find((r) => r.window_tokens !== null)?.window_tokens ?? null,
      samples: rows.reverse().map((r) => ({
        ts: r.ts,
        iteration: r.iteration,
        tokens: r.tokens,
        basis: r.basis === "transcript" ? "transcript" : "api",
        turnIndex: r.turn_index,
        turnsExact: r.turns_exact !== 0,
      })),
      sampleCount: sampleCountFor(runId, rows.length),
      lastCheck: lastContextCheck(runId),
    };
  } catch (err) {
    noteBookkeepingFailure("contextOccupancy", err);
    return undefined;
  }
}

/**
 * The stored total, read only when the page came back full — below the cap the
 * page *is* the total, and the run page polls this every three seconds.
 */
function sampleCountFor(runId: string, returned: number): number {
  if (returned < CONTEXT_SERIES_MAX_POINTS) return returned;
  const row = db()
    .prepare("SELECT COUNT(*) AS n FROM context_samples WHERE run_id = ?")
    .get(runId) as { n: number };
  return row.n;
}

/** How many distinct faults get a durable row before the rest are stdout only. */
const MAX_REPORTED_FAULTS = 32;

const reportedFailures = new Set<string>();

/**
 * A bookkeeping read or write that failed, reported rather than swallowed.
 *
 * Every catch that calls this is right to be non-fatal: a receipt that will not
 * write must not fail the run it describes, and a panel query that throws must
 * not take the page down with it. All of them were also **silent**, and that is
 * a different property that nothing chose. `fork_attempts` shipped without the
 * `suffix_bytes` column that both its INSERT and its SELECT name; the write
 * threw at every fork and the read threw at every page load, and the whole of it
 * was indistinguishable from a fork engine that had had nothing to say. An
 * operator cannot tell "no forks happened" from "forks cannot be recorded", and
 * that is the one distinction this table exists to make.
 *
 * `ops.ts` was written for the same shape of bug on the sweep timer, and says
 * so: the catch is right, the silence is not.
 *
 * The first occurrence of each distinct fault gets a durable `ops_events` row
 * and every repeat goes to stdout alone. These sit in the cycle loop and on a
 * polled route, so a schema fault recurs at every boundary and every refresh,
 * and `ops_events` keeps 500 rows — one repeating fault would evict everything
 * else the operator might have needed to read beside it.
 */
function noteBookkeepingFailure(site: string, err: unknown): void {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  const key = `${site}:${message}`;
  const fields = { site, message };
  // Bounded, because the key carries a message and a message can carry a value
  // that varies per call. Past the cap a genuinely new fault loses its durable
  // row and keeps its stdout line, which is the right way round.
  if (reportedFailures.has(key) || reportedFailures.size >= MAX_REPORTED_FAULTS) {
    opsLog("error", "context_samples.record_failed", fields);
    return;
  }
  reportedFailures.add(key);
  recordOpsEvent("error", "context_samples.record_failed", fields);
}
