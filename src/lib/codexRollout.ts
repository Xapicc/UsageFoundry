import fs from "node:fs";
import path from "node:path";
import { CODEX_HOME } from "./config";

/**
 * What a Codex work cycle has used so far, read off the CLI's own session
 * file while the cycle runs.
 *
 * A Claude cycle's running spend comes from its OTLP export and its context
 * from its transcript; a Codex cycle has neither on the wire this app reads —
 * `codex exec --json` reports tokens once, on `turn.completed`. What it does
 * write as it goes is the session rollout,
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl`, and
 * every model request there is followed by an `event_msg` of type
 * `token_count`. Measured on `codex-cli 0.153.4`, 2026-10-07:
 *
 *  - `info.total_token_usage` is the running total of **this invocation** —
 *    one `codex exec` is one cycle — and starts again on a resumed one (a
 *    two-cycle thread read 45,285 at the end of its first cycle and 16,850 at
 *    the first request of its second). Its `input_tokens + output_tokens` is
 *    exactly what `turn.completed` reports for the cycle, which is what
 *    `handleCodexStreamLine` folds into `spent_tokens`.
 *  - `info.last_token_usage.input_tokens` is the one request's whole input,
 *    cached tokens included — the size of the context that request carried.
 *  - `info.model_context_window` is the window it was measured against
 *    (258,400 on every listed model of the measured account).
 *  - The same totals can be sent twice: a second `token_count` follows with
 *    only `rate_limits` moved. A request is counted when the total moves.
 *
 * **Tokens only, never money.** A ChatGPT-plan Codex run is not billed per
 * token, and a dollar figure derived here would be a fourth cost population
 * summed beside measured ones — `docs/agent/architecture.md` forbids it.
 *
 * Every reader here is bounded and never throws: a session file that cannot
 * be found or read is a cycle with no reading, which every caller renders as
 * unknown rather than zero.
 */

/** One `token_count` line, reduced to what a reading needs. */
export interface CodexTokenLine {
  /** This invocation's running total, input plus output. */
  cycleTokens: number;
  /** The latest request's whole input: the context it carried. */
  contextTokens: number;
  /** The window that request was measured against, or null when unnamed. */
  contextWindow: number | null;
  /** Epoch ms off the line's own timestamp, or null when it has none. */
  at: number | null;
}

/** What a cycle has used so far. */
export interface CodexCycleReading {
  /** Model requests seen in this cycle. Zero is "none yet", with no tokens. */
  requests: number;
  /** This cycle's running total, input plus output. */
  tokens: number;
  /** The newest request's input, or null before the first one. */
  contextTokens: number | null;
  contextWindow: number | null;
  /** When the newest request's reading was written, or null. */
  at: number | null;
}

export const EMPTY_CODEX_READING: CodexCycleReading = Object.freeze({
  requests: 0,
  tokens: 0,
  contextTokens: null,
  contextWindow: null,
  at: null,
}) as CodexCycleReading;

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Parse one rollout line, or null for any line that is not a `token_count`
 * with readable totals. Pure, and the part under test.
 *
 * A `token_count` whose `info` is null — the shape a rate-limit-only update
 * can take — is not a reading. Numbers are taken as numbers or not at all, so
 * a field gone missing is no reading rather than a zero.
 */
export function parseTokenCountLine(line: string): CodexTokenLine | null {
  if (!line.includes('"token_count"')) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const payload = o.payload as Record<string, unknown> | undefined;
  if (o.type !== "event_msg" || payload?.type !== "token_count") return null;
  const info = payload.info as Record<string, unknown> | null | undefined;
  if (!info || typeof info !== "object") return null;
  const total = info.total_token_usage as Record<string, unknown> | undefined;
  const last = info.last_token_usage as Record<string, unknown> | undefined;
  const totalIn = count(total?.input_tokens);
  const totalOut = count(total?.output_tokens);
  const lastIn = count(last?.input_tokens);
  if (totalIn === null || totalOut === null || lastIn === null) return null;
  const at = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
  return {
    cycleTokens: totalIn + totalOut,
    contextTokens: lastIn,
    contextWindow: count(info.model_context_window) || null,
    at: Number.isFinite(at) ? at : null,
  };
}

/**
 * Fold rollout lines into a cycle's reading. Pure.
 *
 * Every line passed belongs to the cycle — the tracker below reads only what
 * was appended after the cycle began — so the newest total *is* the cycle's.
 * A request is counted only when the total grows, which is what keeps a
 * repeated `token_count` from reading as a second request.
 */
export function foldTokenLines(
  prev: CodexCycleReading,
  lines: readonly string[],
): CodexCycleReading {
  let next = prev;
  for (const line of lines) {
    const parsed = parseTokenCountLine(line);
    if (!parsed) continue;
    if (parsed.cycleTokens <= next.tokens && next.requests > 0) continue;
    next = {
      requests: next.requests + 1,
      tokens: parsed.cycleTokens,
      contextTokens: parsed.contextTokens,
      contextWindow: parsed.contextWindow ?? next.contextWindow,
      at: parsed.at ?? next.at,
    };
  }
  return next;
}

/**
 * The `sessions/YYYY/MM/DD` directories a thread's rollout may be in. Pure.
 *
 * A thread id is a UUIDv7, whose first 48 bits are its creation instant in
 * milliseconds — measured, `01a117e7-bf8e-…` decodes to 19:47:06.254Z against
 * a rollout named 19-47-06. The CLI names the directory in its own local time,
 * so the day either side is asked too; an id that is not a v7 falls back to the
 * three days around `now`.
 */
export function rolloutDayDirs(threadId: string, now: number): string[] {
  const v7 = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-/i.exec(threadId);
  const created = v7 ? parseInt(`${v7[1]}${v7[2]}`, 16) : now;
  const day = 24 * 60 * 60 * 1000;
  return [created - day, created, created + day].map((t) => {
    const d = new Date(t);
    const pad = (n: number) => String(n).padStart(2, "0");
    return path.join(String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()));
  });
}

/** The rollout file of a thread, or null. Never throws. */
export function findCodexRollout(
  threadId: string,
  codexHome: string = CODEX_HOME,
  now = Date.now(),
): string | null {
  // The id becomes part of a file name match and nothing else; one that is not
  // shaped like an id is not searched for.
  if (!/^[0-9a-z-]{8,64}$/i.test(threadId)) return null;
  const suffix = `-${threadId}.jsonl`;
  for (const dir of rolloutDayDirs(threadId, now)) {
    const full = path.join(codexHome, "sessions", dir);
    let names: string[];
    try {
      names = fs.readdirSync(full);
    } catch {
      continue;
    }
    const name = names.find((n) => n.startsWith("rollout-") && n.endsWith(suffix));
    if (name) return path.join(full, name);
  }
  return null;
}

/** At most this much of a rollout is read per call; the rest is next time. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
/** And at most this much when a cycle ends and the reading must be final. */
const FINAL_READ_BYTES = 64 * 1024 * 1024;
/** A line longer than this is a tool output, never a `token_count`; dropped. */
const MAX_CARRY_CHARS = 1024 * 1024;

interface CycleTrack {
  threadId: string | null;
  path: string | null;
  /** Where this cycle's part of the file starts, and how far it has been read. */
  offset: number;
  /** A partial last line, kept for the next read. */
  carry: string;
  reading: CodexCycleReading;
  /** How many of this cycle's requests a context sample has already counted. */
  sampledRequests: number;
  /** Whether the thread is new this cycle, so the file holds nothing older. */
  freshThread: boolean;
}

// A key of its own: nothing else has ever stored this shape.
const tracks = ((globalThis as unknown as {
  __ufCodexCycleTracks?: Map<string, CycleTrack>;
}).__ufCodexCycleTracks ??= new Map<string, CycleTrack>());

/**
 * Start reading a Codex cycle. `threadId` is the session being resumed, or
 * null for a cycle that opens a new thread.
 *
 * A resumed thread's file already holds every earlier cycle, so this cycle's
 * part starts at the size it has *now* — before the spawn — and nothing an
 * earlier cycle wrote is counted again. A new thread's file does not exist
 * yet, and all of it will be this cycle's.
 */
export function beginCodexCycle(
  runId: string,
  threadId: string | null,
  codexHome: string = CODEX_HOME,
): void {
  let file: string | null = null;
  let offset = 0;
  if (threadId) {
    file = findCodexRollout(threadId, codexHome);
    if (file) {
      try {
        offset = fs.statSync(file).size;
      } catch {
        file = null;
      }
    }
  }
  tracks.set(runId, {
    threadId,
    path: file,
    offset,
    carry: "",
    reading: EMPTY_CODEX_READING,
    sampledRequests: 0,
    freshThread: threadId === null,
  });
}

/** The thread a new cycle opened, once the stream names it. */
export function noteCodexThread(runId: string, threadId: string): void {
  const track = tracks.get(runId);
  if (!track || track.threadId) return;
  track.threadId = threadId;
}

function advance(track: CycleTrack, codexHome: string, budget: number): void {
  if (!track.path) {
    if (!track.threadId) return;
    track.path = findCodexRollout(track.threadId, codexHome);
    if (!track.path) return;
    // A resumed thread's file found only now holds earlier cycles ahead of
    // this one, and where they end is no longer known. Starting at its present
    // end drops whatever this cycle wrote before the file was found, which
    // makes the reading a floor — never a figure counting a past cycle twice.
    if (!track.freshThread) {
      try {
        track.offset = fs.statSync(track.path).size;
      } catch {
        track.path = null;
        return;
      }
    }
  }
  let fd: number | null = null;
  try {
    fd = fs.openSync(track.path, "r");
    let left = budget;
    while (left > 0) {
      const size = fs.fstatSync(fd).size;
      if (size <= track.offset) break;
      const length = Math.min(size - track.offset, READ_CHUNK_BYTES, left);
      const buf = Buffer.alloc(length);
      const got = fs.readSync(fd, buf, 0, length, track.offset);
      if (got <= 0) break;
      track.offset += got;
      left -= got;
      const text = track.carry + buf.subarray(0, got).toString("utf8");
      const cut = text.lastIndexOf("\n");
      const complete = cut === -1 ? "" : text.slice(0, cut);
      track.carry = cut === -1 ? text : text.slice(cut + 1);
      if (track.carry.length > MAX_CARRY_CHARS) track.carry = "";
      if (complete) track.reading = foldTokenLines(track.reading, complete.split("\n"));
    }
  } catch {
    // Unreadable this time; the next call tries again from the same offset.
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing to do about a close that failed.
      }
    }
  }
}

/**
 * The cycle's reading so far, reading whatever has been appended. Null when
 * no Codex cycle of this run is being read. Never throws.
 */
export function readCodexCycle(
  runId: string,
  codexHome: string = CODEX_HOME,
): CodexCycleReading | null {
  const track = tracks.get(runId);
  if (!track) return null;
  advance(track, codexHome, READ_CHUNK_BYTES);
  return track.reading;
}

/**
 * Requests this cycle has made since the last context sample, and whether the
 * count from the start of the thread is complete. Marks them as sampled.
 */
export function takeCodexSampleAdvance(runId: string): {
  advanced: number;
  freshThread: boolean;
} | null {
  const track = tracks.get(runId);
  if (!track) return null;
  const advanced = track.reading.requests - track.sampledRequests;
  track.sampledRequests = track.reading.requests;
  return { advanced, freshThread: track.freshThread };
}

/** Whether a Codex cycle of this run is being read. */
export function codexCycleTracked(runId: string): boolean {
  return tracks.has(runId);
}

/**
 * The cycle's final reading and the requests no sample has counted yet, and
 * stop reading it. Read to the end, within a bound, because a cycle shorter
 * than the tick that samples it would otherwise leave no reading at all.
 * Never throws.
 */
export function endCodexCycle(
  runId: string,
  codexHome: string = CODEX_HOME,
): { reading: CodexCycleReading; advanced: number; freshThread: boolean } | null {
  const track = tracks.get(runId);
  if (!track) return null;
  advance(track, codexHome, FINAL_READ_BYTES);
  tracks.delete(runId);
  return {
    reading: track.reading,
    advanced: track.reading.requests - track.sampledRequests,
    freshThread: track.freshThread,
  };
}
