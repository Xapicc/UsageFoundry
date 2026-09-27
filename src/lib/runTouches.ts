import type { RunDiffDTO, RunTouchDTO } from "./apiTypes";

/**
 * What a run touched, reconciled against what its branch changed.
 *
 * **This module reaches nothing.** No database, no filesystem, no `git` — it is
 * imported by `RunTouches.tsx`, which is a `"use client"` file, and the reason
 * `apiTypes.ts` states for declaring wire shapes rather than importing them
 * holds here too: one `import` of a server module and `node:fs` follows it into
 * the browser bundle. The scan that produces its input lives beside it in
 * `runTouchScan.ts`, which is server-only for exactly that reason.
 *
 * The reconciliation is client-side by design rather than by accident: the diff
 * half of it is the numstat the Changes tab has already fetched, and doing it on
 * the server would mean a second `runDiff` — several more git processes per tab
 * open, for a file list the page is already holding.
 */

/** One file, with every call that named it collapsed onto it. */
export interface TouchedFile {
  /** Relative to the checkout, or absolute when `outside`. */
  path: string;
  /** Calls that read it. Also the fallback for a tool this build cannot place. */
  reads: number;
  /** Calls that wrote it. */
  writes: number;
  /** Listed by the branch diff. */
  inDiff: boolean;
  /**
   * Left uncommitted in the run's own checkout, so changed but not on the
   * branch. False wherever the changed set is unknown.
   */
  uncommitted: boolean;
  /** Matched neither `runs.work_dir` nor `runs.folder`. */
  outside: boolean;
  /**
   * Who made the calls — `main`, a sub-agent's own name, or `delegated`.
   *
   * A list because one file is routinely read by the main thread and edited by a
   * sub-agent, and picking one of the two to display would make the other
   * disappear. Sorted, so two runs that did the same work render the same way.
   */
  by: string[];
  /**
   * Which tools named it, distinct and sorted.
   *
   * Carried on the file rather than left as a shape of its own, because that is
   * the *only* form tool identity is allowed to take on the map at
   * `/runs/[id]/touched`: tool → file is a star with a dozen hubs and nearly
   * every file hanging off `Read`, which draws one fact an operator already
   * knows. As an attribute it costs a set per file and answers "what was done to
   * this file" without giving `Read` a node of its own.
   *
   * The table above this does not read it. It is here rather than in a second
   * pass over the same rows because the pass that fills `by` is already open,
   * and a second derivation of the same scan is the thing this module exists to
   * stop.
   */
  tools: string[];
}

/**
 * The five groups, in the order they are read.
 *
 * `changedNotTouched` leads because it is the group with no surface anywhere
 * else: a file in the diff that no tool call named was written by a `Bash` —
 * `sed -i`, a formatter, a codegen step — or by an event that has aged out.
 */
export interface TouchReport {
  /** In the diff, named by no tool call. Rows carry no counts. */
  changedNotTouched: TouchedFile[];
  touchedAndChanged: TouchedFile[];
  /**
   * Not in the diff, but left uncommitted in the run's checkout.
   *
   * A group of its own rather than a part of `touchedAndChanged`, because that
   * one's files are on the branch and these are exactly the ones a land leaves
   * behind. And never `touchedNotChanged`: the checkout differs from the branch
   * at every one of these paths, so "not changed" over them is false.
   */
  touchedUncommitted: TouchedFile[];
  /** Read and never written, or edited and reverted. */
  touchedNotChanged: TouchedFile[];
  /** Outside the checkout entirely, so the diff can say nothing about it. */
  outsideCheckout: TouchedFile[];
  /**
   * Distinct files the run's tool events named — the three touched groups, not
   * the first.
   *
   * Reported rather than left to be counted off the groups because it is one of
   * the two numbers the slice exists to produce: it is what decides whether a
   * file × work-cycle grid has an axis short enough to draw.
   */
  distinctTouched: number;
}

/**
 * Tools that write the file they name. Everything else counts as a read.
 *
 * A tool-name table is exactly what `HEADLINE_FIELDS` refuses to be, and for a
 * good reason — the CLI's tool set moves. It is unavoidable here because no
 * field on a call says whether it wrote, and the fallback is chosen so that
 * being wrong is cheap: an unknown writer is counted as a read, which understates
 * one column and leaves the group the file lands in — the load-bearing part —
 * untouched, because a write this list has never heard of still puts the file in
 * the diff and therefore in `touchedAndChanged`.
 */
const WRITING_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/**
 * Who made a call.
 *
 * `delegated` rather than nothing for a call with a parent and no name: the
 * `Task` that opened the sub-agent may have arrived before this page did or
 * before the event horizon, and "some sub-agent" is the true statement where
 * "the main thread" is not. Same reasoning, and the same fallback, as the log's
 * own attribution in `logLine.ts`.
 */
export function touchActor(row: Pick<RunTouchDTO, "subagent" | "parentToolUseId">): string {
  if (row.subagent) return row.subagent;
  return row.parentToolUseId ? "delegated" : "main";
}

/**
 * What a run's diff can say about what it changed.
 *
 * Only a `range` can say anything. `none` has no diff at all, and `worktree` —
 * the answer for every run that was not isolated — is the operator's folder as
 * it stands now, with `files` empty by construction and the operator's own
 * edits mixed into its uncommitted lines. Reading it as a known changed set
 * filed every edit such a run made under "named, and not changed", which is the
 * reconciliation asserting the thing it exists to check. Both surfaces decide
 * this here rather than each testing `kind` for itself, because two copies of
 * that test are how both of them got `worktree` wrong the same way.
 */
export type ChangedSet =
  | {
      known: true;
      /** What the branch diff lists. */
      changed: string[];
      /** `uncommittedPaths` over the checkout's status lines. */
      uncommitted: string[];
    }
  | {
      known: false;
      /** Why, for the notice; null leaves the notice its own sentence. */
      reason: string | null;
    };

/**
 * Why a run that worked in the operator's folder has no changed set.
 *
 * Its own sentence rather than the diff route's `reason`, which for this kind
 * says whether the folder is clean — true, and no answer to why nothing here
 * can be reconciled.
 */
const WORKED_IN_CHECKOUT =
  "This run worked directly in your checkout, so there is no branch diff " +
  "separating its changes from yours.";

export function changedSetOf(diff: RunDiffDTO | null): ChangedSet {
  if (diff?.kind === "range") {
    return {
      known: true,
      // `path` alone, not `oldPath`: a rename's old name is a path no tool call
      // would have named, and listing it would put a file in "changed, never
      // named" that was never there under that name.
      changed: diff.files.map((f) => f.path),
      uncommitted: uncommittedPaths(diff.uncommitted),
    };
  }
  if (diff?.kind === "worktree") return { known: false, reason: WORKED_IN_CHECKOUT };
  return { known: false, reason: diff?.reason ?? null };
}

/**
 * The paths a `git status --porcelain` listing names, spelled the way a tool
 * call would have named them.
 *
 * The diff route passes these lines on as git printed them, because the
 * Changes tab renders them verbatim, and two things about that format decide
 * whether a file matches at all — both failing by leaving it under "not
 * changed". A path holding a space or a non-ASCII byte is printed as a quoted C
 * string with octal escapes (`"\303\274.txt"` for `ü.txt`), so a quoted field is
 * decoded. An untracked directory is printed once as `dir/` rather than file by
 * file, so the trailing `/` is kept and means everything under it.
 *
 * Both sides of a rename are returned, unlike the diff's `oldPath`: these are
 * only ever matched against paths a tool call did name, and a checkout that
 * renamed a file away differs from the branch at the old path too.
 */
export function uncommittedPaths(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    // `XY ` and at least one character of path — `parseStatusZ`'s own guard.
    if (line.length < 4 || line[2] !== " ") return [];
    const first = readStatusField(line.slice(3));
    if (!first) return [];
    if (!first.rest.startsWith(" -> ")) return [first.path];
    const second = readStatusField(first.rest.slice(" -> ".length));
    if (!second) return [];
    // A copy's source is untouched; only a rename's is gone from the checkout.
    return line.slice(0, 2).includes("R") ? [first.path, second.path] : [second.path];
  });
}

/**
 * One path field of a porcelain line, and what follows it.
 *
 * An unquoted field runs to the first space, which is sound only because git
 * quotes every path holding one in this format.
 */
function readStatusField(text: string): { path: string; rest: string } | null {
  if (!text.startsWith('"')) {
    const end = text.indexOf(" ");
    return end < 0
      ? { path: text, rest: "" }
      : { path: text.slice(0, end), rest: text.slice(end) };
  }
  const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(text);
  return quoted ? { path: unquoteC(quoted[1]), rest: text.slice(quoted[0].length) } : null;
}

/** The single-character escapes git's `quote_c_style` writes. */
const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  "\\": 0x5c,
};

/**
 * Decode a C-quoted body into the string it spells.
 *
 * Through bytes rather than character by character, because an octal escape is
 * one byte of UTF-8 and `ü` is two of them: decoding each on its own gives two
 * replacement characters and a path no tool call named.
 */
function unquoteC(body: string): string {
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (const [, octal, escaped, literal] of body.matchAll(/\\([0-7]{3})|\\(.)|([^\\]+)/gs)) {
    if (octal) bytes.push(parseInt(octal, 8));
    else if (escaped) bytes.push(C_ESCAPES[escaped] ?? escaped.charCodeAt(0));
    else bytes.push(...encoder.encode(literal));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Group a run's touches against the paths its branch diff lists.
 *
 * Pure, and every one of its failure modes is silent: a path that fails to merge
 * shows one file as two, a group that takes the wrong side of the set difference
 * reads as "changed without being read" — the one claim here an operator would
 * act on — and a miscount changes which of two files an eye stops at. Nothing
 * throws and nothing fails to typecheck for any of them.
 *
 * `changed` is matched literally. Both sides are already relative to the same
 * checkout: the scan relativises against `COALESCE(work_dir, folder)` then
 * `folder`, and git reports paths relative to the repository root.
 *
 * `uncommitted` has no default: a caller that left it out would put every file
 * a run edited and never committed back under "not changed". A trailing `/` on
 * one of its paths covers everything under it, which is how git lists an
 * untracked directory.
 */
export function reconcileTouches(
  touches: readonly RunTouchDTO[],
  changed: readonly string[],
  uncommitted: readonly string[],
): TouchReport {
  const changedSet = new Set(changed);
  const uncommittedFiles = new Set(uncommitted.filter((p) => !p.endsWith("/")));
  const uncommittedDirs = uncommitted.filter((p) => p.endsWith("/"));
  const isUncommitted = (path: string) =>
    uncommittedFiles.has(path) || uncommittedDirs.some((dir) => path.startsWith(dir));

  // Keyed on path alone. The same file reached once as a `work_dir` path and
  // once as a `folder` path relativises to one string, and the scan's GROUP BY
  // cannot merge them because it also groups by tool and by caller — so the
  // merge has to happen here or the row appears twice with the counts split.
  const byPath = new Map<
    string,
    TouchedFile & { actors: Set<string>; toolNames: Set<string> }
  >();

  for (const row of touches) {
    let file = byPath.get(row.path);
    if (!file) {
      file = {
        path: row.path,
        reads: 0,
        writes: 0,
        inDiff: !row.outside && changedSet.has(row.path),
        uncommitted: !row.outside && isUncommitted(row.path),
        outside: row.outside,
        by: [],
        tools: [],
        actors: new Set<string>(),
        toolNames: new Set<string>(),
      };
      byPath.set(row.path, file);
    }
    if (WRITING_TOOLS.has(row.tool)) file.writes += row.calls;
    else file.reads += row.calls;
    file.actors.add(touchActor(row));
    file.toolNames.add(row.tool);
    // One row outside the checkout and one inside for the same string cannot
    // happen — `outside` is a function of the path — but if it ever did, the
    // conservative reading is that the diff cannot speak for it.
    if (row.outside) {
      file.outside = true;
      file.inDiff = false;
      file.uncommitted = false;
    }
  }

  const files = [...byPath.values()].map(({ actors, toolNames, ...file }) => ({
    ...file,
    by: [...actors].sort(),
    tools: [...toolNames].sort(),
  }));

  const touched = files.filter((f) => !f.outside);
  const report: TouchReport = {
    changedNotTouched: [...changedSet]
      .filter((path) => !byPath.has(path))
      .map((path) => ({
        path,
        reads: 0,
        writes: 0,
        inDiff: true,
        uncommitted: isUncommitted(path),
        outside: false,
        by: [],
        tools: [],
      })),
    touchedAndChanged: touched.filter((f) => f.inDiff),
    touchedUncommitted: touched.filter((f) => !f.inDiff && f.uncommitted),
    touchedNotChanged: touched.filter((f) => !f.inDiff && !f.uncommitted),
    outsideCheckout: files.filter((f) => f.outside),
    distinctTouched: files.length,
  };

  for (const group of [
    report.changedNotTouched,
    report.touchedAndChanged,
    report.touchedUncommitted,
    report.touchedNotChanged,
    report.outsideCheckout,
  ]) {
    group.sort(byCallsThenPath);
  }

  return report;
}

/**
 * Busiest first, then alphabetical.
 *
 * The tiebreak is not cosmetic: `changedNotTouched` has no counts at all, so
 * without it that group's order would be whatever the diff happened to list —
 * which changes between two reads of the same run.
 */
function byCallsThenPath(a: TouchedFile, b: TouchedFile): number {
  const total = b.reads + b.writes - (a.reads + a.writes);
  return total !== 0 ? total : a.path.localeCompare(b.path);
}
