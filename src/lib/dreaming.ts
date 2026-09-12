import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { PROJECTS_DIR } from "./config";
import { listTranscriptFiles } from "./transcripts";

/**
 * What recurred, counted rather than diagnosed.
 *
 * This module reads one slice of the transcript corpus — `tool_result` blocks
 * carrying `is_error` — and answers two questions about it: which failures have
 * happened on more than one day, and which of those have not been written down
 * yet. `dreamingRun.ts` is what turns the second answer into a run; nothing
 * here writes anything anywhere.
 *
 * ## Why this slice and not the day
 *
 * `proposals/Dreaming` measured the alternatives. The whole tool corpus is
 * 5,521k tokens a night and overflows a 1,000k window on 21 of 23 days, so a
 * reader over it is chunking every night and is not doing the cross-session
 * synthesis that was the point. Worse, 99.8% of it carries no deduplication
 * key: an error result has a message a signature can be taken from, a
 * successful one has nothing to match on but a model's own judgement. The error
 * slice is 0.90 MiB over 23 days — 11k tokens a night — and is the part that
 * can be deduplicated by a set membership test rather than by a nightly
 * retrieval pass over somebody's vault.
 *
 * ## Why a signature is not a lesson, said here rather than in a proposal
 *
 * Normalisation collapses numbers, hex runs and path interiors, so two failures
 * with one cause routinely produce two signatures — the four `bwrap` denials at
 * four different files are one denial — and one signature routinely carries
 * many causes, of which `Exit code N` is the worst. **Every count in this file
 * is a count of strings.** The pane says so, the write prompt says so, and no
 * caller may present a signature count as a count of problems.
 *
 * ## The scan is incremental and holds its own cache
 *
 * It deliberately does not ride `scanUsage`'s walk. That one is on the hot path
 * of `/api/usage` and is already the cold-start cost the dashboard pays; adding
 * a second parse of every file to it would put this feature's latency on a page
 * that has nothing to do with it. So this keeps a per-file memo keyed on size
 * and mtime, and a cold scan reads every file once while a warm one reads only
 * what changed.
 */

/** How much of an error body decides its signature. */
const SIGNATURE_BYTES = 400;

/** How much is kept verbatim to show an operator. Longer than the signature. */
const SAMPLE_BYTES = 600;

/** Transcript files read at once — `SCAN_CONCURRENCY`'s reasoning, one file smaller. */
const READ_CONCURRENCY = 12;

/** Sessions listed per signature. A link list, not an audit. */
const MAX_SESSIONS_PER_SIGNATURE = 12;

/**
 * One error result, reduced to what a rollup needs.
 *
 * `sample` is the machine's own words, clipped and otherwise untouched. It is
 * the only string in this module that reaches an operator, and it is quoted
 * rather than described precisely because the diagnosis half is what the
 * evidence says not to build.
 */
export interface ErrorObservation {
  signature: string;
  sample: string;
  /** `YYYY-MM-DD` in the configured zone. See `dayKey`. */
  day: string;
  sessionId: string;
  /**
   * What makes two records the same observation: the `tool_use_id` the result
   * answers, falling back to the record's own uuid where there is none.
   *
   * A resumed session copies earlier records forward, so the same failure is
   * written again in the new transcript and a naive count reports it twice.
   * `transcripts.ts` already dedupes its own scan across files for this reason;
   * this is the same discipline for this module's corpus. Measured on the real
   * corpus: 2,567 error blocks carrying 2,435 distinct ids — **132 surplus,
   * 5.1%** — and the first note Dreaming ever wrote caught it by re-deriving
   * the counts rather than trusting them.
   *
   * It moves the counts and **not** the policy: no copied-forward record was
   * found on a different day from its original, so the same 78 signatures span
   * two or more days either way. The figure this corrects is the one an
   * operator reads, not the one that decides whether a note is written.
   */
  key: string;
}

/** A signature, everywhere it appeared. */
export interface SignatureRollup {
  signature: string;
  sample: string;
  /** Distinct days, ascending. Its length is what the write policy reads. */
  days: string[];
  /** Total occurrences across those days. */
  instances: number;
  sessions: string[];
}

export interface DreamingReadout {
  /** Signatures spanning two or more days, by days spanned then instances. */
  recurring: SignatureRollup[];
  /** Every signature, including the one-day ones. */
  totalSignatures: number;
  totalInstances: number;
  /** Instances belonging to a signature that spans two or more days. */
  recurringInstances: number;
  /** Days with at least one error, ascending. */
  days: string[];
  /** Files walked, and how many had to be read rather than reused. */
  filesWalked: number;
  filesRead: number;
  /**
   * Records dropped as copies of one already counted.
   *
   * Reported rather than silently absorbed: it is the difference between this
   * readout and a naive count of the same corpus, and a reader comparing the
   * two deserves the reason instead of an unexplained gap.
   */
  duplicates: number;
  scannedInMs: number;
}

/**
 * Collapse a failure to the thing that is the same across two nights.
 *
 * Aggressive on purpose, and the direction of the error is stated where the
 * number is used: this over-collapses, so it is an upper bound on how well a
 * nightly writer could deduplicate. It matches
 * `proposals/Dreaming/scripts/recurrence.mjs` exactly — the script is how the
 * figures behind this feature were measured, and a normalisation that drifted
 * from it would leave the proposal describing a different feature.
 */
export function signatureOf(text: string): string {
  return text
    .slice(0, SIGNATURE_BYTES)
    .replace(/0x[0-9a-f]+/gi, "0xH")
    .replace(/\b[0-9a-f]{7,40}\b/gi, "HASH")
    .replace(/\d+/g, "N")
    .replace(/\/[^\s:]*\//g, "/PATH/")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Which day an instant belongs to, in the operator's zone.
 *
 * A day is the unit the whole feature is denominated in and UTC is the wrong
 * one: a session at 01:00 in Berlin belongs to the night the operator would
 * call it, not to the previous one. `schedules.ts` already carries a
 * `time_zone` per row for the same reason, and this takes the zone rather than
 * reading a setting so it stays pure.
 *
 * An unknown zone falls back to UTC rather than throwing. A readout on the
 * wrong day boundary is wrong by an hour; a readout that throws is a blank
 * page.
 */
export function dayKey(atMs: number, timeZone: string): string {
  try {
    // `en-CA` is ISO-shaped (YYYY-MM-DD) in every ICU build, which is why it is
    // used here rather than assembling the parts by hand.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(atMs);
  } catch {
    return new Date(atMs).toISOString().slice(0, 10);
  }
}

/**
 * Fold observations into one row per signature.
 *
 * Pure, and separated from the scan so the policy below can be tested without
 * a filesystem. Sorted by days spanned, then instances, then signature — the
 * last is there so two signatures with identical counts do not swap places
 * between two loads of the same page.
 */
export function rollUp(observations: readonly ErrorObservation[]): SignatureRollup[] {
  const bySignature = new Map<
    string,
    { sample: string; days: Set<string>; instances: number; sessions: Set<string> }
  >();

  for (const ob of observations) {
    let entry = bySignature.get(ob.signature);
    if (!entry) {
      entry = { sample: ob.sample, days: new Set(), instances: 0, sessions: new Set() };
      bySignature.set(ob.signature, entry);
    }
    entry.days.add(ob.day);
    entry.instances++;
    if (entry.sessions.size < MAX_SESSIONS_PER_SIGNATURE) entry.sessions.add(ob.sessionId);
  }

  return [...bySignature.entries()]
    .map(([signature, e]) => ({
      signature,
      sample: e.sample,
      days: [...e.days].sort(),
      instances: e.instances,
      sessions: [...e.sessions],
    }))
    .sort(
      (a, b) =>
        b.days.length - a.days.length ||
        b.instances - a.instances ||
        a.signature.localeCompare(b.signature),
    );
}

/**
 * Which signatures a night should write down.
 *
 * **The write policy is the feature.** Measured over the same 23 days
 * (`proposals/Dreaming/scripts/ledger.mjs`), writing every distinct signature
 * every night produces 1,361 notes; writing each one once, on first sight,
 * produces 1,177 — of which **1,100 (93.5%) are about something that never
 * happened again**. Writing on the night a signature reaches its *second* day
 * produces **77**, every one about something seen on two or more days.
 *
 * So the rule is: a signature is writable when it has spanned at least
 * `minDays` days and this app has not already written it. `minDays` is a
 * setting rather than a constant because 2 is a measurement on this corpus and
 * not a law, and an operator who finds 3.3 notes a night too many should be
 * able to say 3 without editing code.
 *
 * The latency this costs was measured too and is not hidden: median 3 days from
 * a signature's first sighting to the night it qualifies, mean 3.8, max 20.
 */
export function selectWritable(
  rollups: readonly SignatureRollup[],
  alreadyWritten: ReadonlySet<string>,
  minDays: number,
): SignatureRollup[] {
  const floor = Math.max(1, Math.trunc(minDays));
  return rollups.filter((r) => r.days.length >= floor && !alreadyWritten.has(r.signature));
}

/* ------------------------------------------------------------------ */
/*                             The scan                                */
/* ------------------------------------------------------------------ */

interface FileMemo {
  /** `${size}:${mtimeMs}` — what makes a re-read unnecessary. */
  stamp: string;
  observations: ErrorObservation[];
}

/**
 * Per-file observations, keyed by absolute path.
 *
 * On `globalThis` because module state does not survive a dev request
 * otherwise, and under its own key rather than beside the transcript cache:
 * the two hold different shapes with different lifetimes, and reusing a key
 * whose shape changed is the trap `orchestrator.ts:373` records.
 */
const globalMemo = globalThis as unknown as {
  __ufDreamingMemo?: Map<string, FileMemo>;
};
globalMemo.__ufDreamingMemo ??= new Map<string, FileMemo>();
const memo = globalMemo.__ufDreamingMemo;

async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

/**
 * Every `is_error` tool result in one transcript line, appended to `out`.
 *
 * Tolerant: a partially flushed or corrupt line is skipped rather than aborting
 * the file, which is `parseLine`'s rule in `transcripts.ts` and for its reason —
 * the newest file in the corpus is usually one an agent is still writing to.
 *
 * The accumulator is threaded through rather than returned because the fallback
 * key below is the observation's index *within its file*: a per-line function
 * that started its own array would hand every identifier-less record the key
 * `file:0` and collapse the lot of them into one.
 */
function parseLine(line: string, timeZone: string, file: string, out: ErrorObservation[]): void {
  if (!line.startsWith("{")) return;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }
  const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
  if (!Number.isFinite(ts)) return;
  const message = rec.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return;

  const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : "";
  const uuid = typeof rec.uuid === "string" ? rec.uuid : "";
  for (const block of content as Record<string, unknown>[]) {
    if (block?.type !== "tool_result" || !block.is_error) continue;
    const body =
      typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
    const signature = signatureOf(body);
    if (!signature) continue;
    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
    out.push({
      signature,
      sample: body.slice(0, SAMPLE_BYTES),
      day: dayKey(ts, timeZone),
      sessionId,
      // Without either identifier there is nothing to prove this is not a
      // duplicate, so fall back to a key that can only ever match itself —
      // `parseLine`'s rule in transcripts.ts, and the direction that
      // over-counts rather than dropping a real failure.
      key: toolUseId || uuid || `${file}:${out.length}`,
    });
  }
}

/**
 * One transcript, read a chunk at a time and parsed a line at a time.
 *
 * `readFile(file, "utf8")` held two copies of a whole transcript at once — the
 * decoded string and the array `split("\n")` cut it into — and with
 * `READ_CONCURRENCY` of them in flight over a corpus this size they reach old
 * and large-object space faster than V8 collects them. The pane's mount fires a
 * cold scan while the transcript cache is already resident, so the peak lands on
 * top of it rather than beside it.
 *
 * Three things this must not quietly change about what a line is:
 *
 * - **Hand-rolled rather than `node:readline`.** Readline breaks on a lone `\r`
 *   and `split("\n")` does not, so a carriage return between two records would
 *   turn one unparseable line into two parseable ones. Counts here feed a
 *   write-on-second-sighting policy, and a reader that found records the old one
 *   did not would change what gets written with nothing to say it had.
 * - **Decoded through a `StringDecoder`.** A multi-byte character straddling a
 *   chunk boundary is held until its remaining bytes arrive; `chunk.toString()`
 *   per chunk would replace both halves with U+FFFD, which is still valid JSON —
 *   so the record parses, carries a mangled prefix into `signatureOf`, and one
 *   recurring failure silently becomes two that each look like they happened
 *   once.
 * - **A rejection is the caller's to answer**, because a file really does vanish
 *   mid-scan under the retention sweep.
 */
async function readLines(file: string, timeZone: string): Promise<ErrorObservation[]> {
  const out: ErrorObservation[] = [];
  const decoder = new StringDecoder("utf8");
  let tail = "";
  for await (const chunk of createReadStream(file)) {
    tail += decoder.write(chunk as Buffer);
    // Index-walked rather than re-sliced per line: cutting the head off `tail`
    // at every newline is quadratic in the chunk, which over a corpus this size
    // would trade the memory this change saves for time it never had to spend.
    let start = 0;
    for (let nl = tail.indexOf("\n"); nl !== -1; nl = tail.indexOf("\n", start)) {
      parseLine(tail.slice(start, nl), timeZone, file, out);
      start = nl + 1;
    }
    if (start > 0) tail = tail.slice(start);
  }
  tail += decoder.end();
  // A file not ending in a newline: `split` handed that last stretch over as a
  // line, and the newest file in the corpus is one being written to right now.
  if (tail) parseLine(tail, timeZone, file, out);
  return out;
}

async function readOne(
  file: string,
  timeZone: string,
): Promise<{ observations: ErrorObservation[]; read: boolean }> {
  let stamp: string;
  try {
    const st = await fs.stat(file);
    stamp = `${st.size}:${st.mtimeMs}`;
  } catch {
    // Deleted between the walk and the read — a retention sweep runs on the
    // same corpus. Drop it rather than failing the scan.
    memo.delete(file);
    return { observations: [], read: false };
  }

  const cached = memo.get(file);
  if (cached && cached.stamp === stamp) return { observations: cached.observations, read: false };

  let observations: ErrorObservation[];
  try {
    observations = await readLines(file, timeZone);
  } catch {
    // Unreadable, or gone between the stat above and the open — the same
    // retention sweep, one step later. A partial parse is discarded rather than
    // memoised: the stamp would mark a truncated read as the whole file.
    return { observations: [], read: false };
  }
  memo.set(file, { stamp, observations });
  return { observations, read: true };
}

/**
 * Walk the corpus and roll it up.
 *
 * `sinceDays` bounds what is *reported*, not what is read: the memo is keyed on
 * the file and a window that moved would otherwise re-read the whole corpus
 * every midnight. Files outside the window still cost a `stat` and nothing
 * else.
 */
export async function scanDreaming(opts: {
  timeZone: string;
  sinceDays?: number | null;
  now?: number;
}): Promise<DreamingReadout> {
  const startedAt = Date.now();
  const now = opts.now ?? startedAt;
  const { files } = await listTranscriptFiles(PROJECTS_DIR);

  const results = await mapWithLimit(files, READ_CONCURRENCY, (f) => readOne(f, opts.timeZone));

  const horizon =
    opts.sinceDays && opts.sinceDays > 0
      ? dayKey(now - opts.sinceDays * 86_400_000, opts.timeZone)
      : null;

  // Deduplicated across files, not within one: a resumed session writes the
  // earlier records into a *new* transcript, so the copies are in a different
  // file from the original and a per-file pass cannot see them.
  const observations: ErrorObservation[] = [];
  const seen = new Set<string>();
  let filesRead = 0;
  let duplicates = 0;
  for (const r of results) {
    if (r.read) filesRead++;
    for (const ob of r.observations) {
      if (horizon && ob.day < horizon) continue;
      if (seen.has(ob.key)) {
        duplicates++;
        continue;
      }
      seen.add(ob.key);
      observations.push(ob);
    }
  }

  const rollups = rollUp(observations);
  const recurring = rollups.filter((r) => r.days.length >= 2);
  const days = [...new Set(observations.map((o) => o.day))].sort();

  return {
    recurring,
    totalSignatures: rollups.length,
    totalInstances: observations.length,
    recurringInstances: recurring.reduce((s, r) => s + r.instances, 0),
    days,
    filesWalked: files.length,
    filesRead,
    duplicates,
    scannedInMs: Date.now() - startedAt,
  };
}

/**
 * Drop memoised observations for files that no longer exist.
 *
 * The retention sweep deletes transcripts on `transcriptRetentionDays`, and a
 * memo keyed on a path holds its parse for the life of the process otherwise.
 * `transcripts.ts` exports `forgetTranscriptFiles` for the same reason; this is
 * the same call for this module's own cache.
 */
export function forgetDreamingFiles(files: readonly string[]): void {
  for (const f of files) memo.delete(f);
}

/*
 * There is deliberately no `dreamingCacheStats` and no eviction bound, which is
 * the one place this module does *not* follow `transcripts.ts`.
 *
 * That cache holds parsed turns and needs `TRANSCRIPT_CACHE_MAX_ENTRIES` to
 * stop one process holding the whole corpus. This one holds a size/mtime stamp
 * per file plus the error results, and the whole error corpus is 0.90 MiB
 * across 23 days — 2,435 observations against 1,954 files. It is bounded by the
 * retention horizon, which `forgetDreamingFiles` above enforces from the sweep,
 * and a reading nobody displays would be the dead code this file would rather
 * not carry. If this ever holds successful results it needs both.
 */
