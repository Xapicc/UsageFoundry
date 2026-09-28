import fs from "node:fs";
import { git } from "./git";
import {
  describeFolder,
  getRun,
  resolveWorkspaceFolder,
  type RunRow,
} from "./orchestrator";

/**
 * What a run changed, as a diff the run page can render.
 *
 * The event log describes the *process* — every tool call, every assistant
 * turn. This describes the *outcome*, which is what a review actually needs and
 * what the handoff card previously delegated to the operator's own shell.
 *
 * Two shapes, and the difference is not cosmetic. An isolated run owns a branch
 * and a base commit, so `<base>...<branch>` is exactly its work and nothing
 * else — until the target is merged into the branch, which is what resolving a
 * conflict does, and `diffRange` moves the left side for that. A run that
 * worked directly in the operator's folder has no such range:
 * whatever is in that tree is the run's edits *and* the operator's, mixed, with
 * nothing recording where one ends. That case reports a file list and says so,
 * rather than presenting a confident diff of the wrong thing.
 *
 * Every git call here goes through `git()` — argv array, no shell, environment
 * scrubbed — and the repository path is re-proved inside its mount on every
 * request, because a folder validated when the run was created is not a folder
 * still contained an hour later.
 */

export type DiffFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "changed";

export interface DiffFile {
  path: string;
  /** Set only for a rename or copy. */
  oldPath: string | null;
  status: DiffFileStatus;
  /** Null for a binary file, where git reports no line counts. */
  added: number | null;
  deleted: number | null;
  binary: boolean;
  /** Null when this file's patch was left out, by the budget or by a read that failed. */
  patch: string | null;
  /** True when `patch` holds only the first `MAX_FILE_PATCH_LINES` lines. */
  patchTruncated: boolean;
}

export interface RunDiff {
  /**
   * `range` — an isolated run's branch against its base commit: exact.
   * `worktree` — a non-isolated run: the folder's current state, which
   *   includes anything the operator did themselves.
   * `none` — nothing to show, with `reason` saying why. Not an error.
   */
  kind: "range" | "worktree" | "none";
  reason: string | null;
  /** The commit the run branched from, `runs.worktree_base`. */
  base: string | null;
  branch: string | null;
  /**
   * Set when the diff is measured from somewhere other than `base`: the target
   * commit that `merge` brought into the branch. From `base`, everything the
   * target gained before that merge would be counted as the run's work.
   */
  measuredFrom: TargetMerge | null;
  /**
   * The commit `branch` resolved to when this diff was taken, and the one every
   * patch here was read from. Null for a run with no range and for a branch
   * that no longer resolves. `branch` is a name that moves with the next
   * commit and is deleted by a land, so anything recording *what was read* — a
   * validation's `head_sha` — takes this.
   */
  head: string | null;
  files: DiffFile[];
  filesChanged: number;
  added: number;
  deleted: number;
  /** Files listed without a patch, whether the budget or a failed read left them out. */
  omittedPatches: number;
  /**
   * Why no file has a patch, when git could not give them, as a clause with no
   * full stop so the card and the Land card can each finish the sentence. Null
   * when every omission is the budget's — and the difference is what the card
   * says: a read that failed is not a change that was too large.
   */
  patchFailure: string | null;
  /** Uncommitted paths still sitting in the run's checkout. */
  uncommitted: string[];
  /** Present when the run worked in the operator's own folder. */
  caveat: string | null;
}

/** Files given a patch. Beyond this the list is still complete; the bodies are not. */
const MAX_PATCH_FILES = 40;
/** Total patch lines across all files. A generated lockfile alone can exceed this. */
const MAX_PATCH_LINES = 4_000;
/** Patch lines kept per file. */
const MAX_FILE_PATCH_LINES = 600;
/** Hard stop on what is read from `git diff` at all. */
const MAX_DIFF_BYTES = 4_000_000;
/**
 * Bytes of patch the selected files may cost between them. Below
 * `MAX_DIFF_BYTES` because the cost leaves out context lines' markers and each
 * file's headers, and the patches are one read that fails whole at the cap, so
 * the budget has to land under it.
 */
const MAX_PATCH_BYTES = 3_000_000;
/**
 * Files whose blob sizes are read for the byte budget. Past this a file goes
 * unsized and so without a patch; reaching it needs 160 files left out before
 * 40 are picked, and sizing every file of a change with thousands would put
 * thousands of pathspecs on one argv.
 */
const MAX_SIZED_FILES = 200;
/**
 * First-parent merges `targetMergeOn` walks looking for the target's. Each
 * costs one git child on every diff read, and the page, every review and every
 * validation read one. A run's branch merges a handful of times; past this many
 * the diff stays measured from `base`, and the card then says nothing, which is
 * true.
 */
const MAX_MERGES_WALKED = 20;

const PATCH_LIMITS = {
  maxFiles: MAX_PATCH_FILES,
  maxLines: MAX_PATCH_LINES,
  maxFileLines: MAX_FILE_PATCH_LINES,
  maxBytes: MAX_PATCH_BYTES,
};

/* ------------------------------------------------------------------ */
/* Parsing — pure, and tested                                          */
/* ------------------------------------------------------------------ */

export interface NumstatEntry {
  path: string;
  oldPath: string | null;
  added: number | null;
  deleted: number | null;
}

export interface SizedEntry extends NumstatEntry {
  /**
   * Both sides' blob sizes added together, which bounds the patch's content,
   * or null when it was not sized. A bound rather than a measurement: a
   * one-line edit to a large file is charged the whole file.
   */
  bytes: number | null;
}

/**
 * Parse `git diff --numstat -z -M`.
 *
 * `-z` because the alternative is quoted, escaped paths: git renders anything
 * non-ASCII as `"src/caf\303\251.ts"` in the default format, and a file list
 * that silently mangles a name is one a review then reasons about wrongly.
 *
 * Records are `added \t deleted \t path NUL`, except a rename or copy, which is
 * `added \t deleted \t NUL oldPath NUL newPath NUL` — the third tab-field is
 * empty and the two paths follow as separate NUL-terminated fields. `-` in
 * place of a count means binary.
 */
export function parseNumstat(raw: string): NumstatEntry[] {
  const out: NumstatEntry[] = [];
  const fields = raw.split("\0");
  const num = (s: string) => (s === "-" ? null : Number(s));

  for (let i = 0; i < fields.length; i++) {
    const head = fields[i];
    if (!head) continue;

    // Only the first two tabs are separators. A filename may contain one — the
    // whole reason this format is NUL-separated — and splitting on every tab
    // would truncate that name to its first segment.
    const firstTab = head.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : head.indexOf("\t", firstTab + 1);
    if (secondTab === -1) continue;

    const addedRaw = head.slice(0, firstTab);
    const deletedRaw = head.slice(firstTab + 1, secondTab);
    const tail = head.slice(secondTab + 1);

    if (tail === "") {
      // Rename or copy: the two paths are the next two fields.
      const oldPath = fields[i + 1];
      const newPath = fields[i + 2];
      // A record cut short — a killed git, a truncated read — must end the
      // parse rather than produce a file with an empty name.
      if (!oldPath || !newPath) break;
      i += 2;
      out.push({
        path: newPath,
        oldPath,
        added: num(addedRaw),
        deleted: num(deletedRaw),
      });
      continue;
    }

    out.push({
      path: tail,
      oldPath: null,
      added: num(addedRaw),
      deleted: num(deletedRaw),
    });
  }
  return out;
}

const STATUS_LETTER: Record<string, DiffFileStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "changed",
};

/**
 * Parse `git diff --name-status -z -M` into `newPath -> status`.
 *
 * Same record shape as numstat: a plain change is `STATUS NUL path NUL`, a
 * rename is `R100 NUL oldPath NUL newPath NUL`.
 */
export function parseNameStatus(raw: string): Map<string, DiffFileStatus> {
  const out = new Map<string, DiffFileStatus>();
  const fields = raw.split("\0");

  for (let i = 0; i < fields.length; i++) {
    const code = fields[i];
    if (!code) continue;
    const status = STATUS_LETTER[code[0]];
    if (!status) continue;

    if (code[0] === "R" || code[0] === "C") {
      const newPath = fields[i + 2];
      i += 2;
      if (newPath) out.set(newPath, status);
      continue;
    }
    const p = fields[i + 1];
    i += 1;
    if (p) out.set(p, status);
  }
  return out;
}

/**
 * Split a multi-file `git diff` into one string per file, in emission order.
 *
 * Split rather than a per-file `git diff` call each: one spawn instead of
 * forty. The seam is a line starting exactly `diff --git ` at column zero,
 * which cannot occur inside a hunk — every line of a unified diff body is
 * prefixed by a space, `+`, `-` or `\`, so a *file* that itself contains a diff
 * still cannot forge a header.
 *
 * Chunks are matched to files by position, not by parsing the header path:
 * `--numstat` and the patch come off the same diff queue in the same order, and
 * the header is the one part of git's output that re-quotes odd filenames.
 *
 * The one place the two lists part is a type change — a file that became a
 * symlink, or the reverse — which numstat counts once and the patch writes as
 * a deletion followed by an addition under the same header. So a chunk whose
 * header repeats the one before it is folded into it: no two files share a
 * header, and a count thrown off by one would cost every file its patch.
 */
export function splitPatches(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  const chunks: string[][] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current?.[0] === line) {
        current.push(line);
        continue;
      }
      current = [line];
      chunks.push(current);
      continue;
    }
    current?.push(line);
  }
  return chunks.map((chunk) => chunk.join("\n"));
}

/** A merge of the run's target into its branch. */
export interface TargetMerge {
  /** The merge commit, on the branch's first-parent line. */
  merge: string;
  /** Its second parent: the target as it stood when it was merged in. */
  commit: string;
  /** The branch it was merged from. */
  target: string;
}

/**
 * Read every merge off `git rev-list --first-parent --merges --parents`, which
 * prints `<merge> <first parent> <second parent>…` per line, newest first.
 *
 * The second parent and never the first: the first is the branch before the
 * merge, and measured from there the run's own commits vanish from its diff.
 */
export function parseMerges(revList: string): Pick<TargetMerge, "merge" | "commit">[] {
  return revList
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([merge, , commit]) => merge && commit)
    .map(([merge, , commit]) => ({ merge, commit }));
}

/**
 * The range an isolated run's diff is measured over.
 *
 * From `base` unless the target was merged into the branch, which a conflict
 * resolution does and an agent may do itself. Then `base...head` holds every
 * commit the target gained before that merge — other people's files in "What
 * changed", in the review a person pays for, and in the Files tab as changes
 * no tool call named. The merged-in commit is the target as the branch now
 * contains it, so from there the diff is the run's work and its resolution
 * and nothing that arrived with the target.
 */
export function diffRange(
  base: string,
  head: string,
  targetMerge: TargetMerge | null,
): { from: string; range: string } {
  const from = targetMerge?.commit ?? base;
  return { from, range: `${from}...${head}` };
}

/** Keep the head of a patch, and say when the tail was dropped. */
export function truncatePatch(
  patch: string,
  maxLines = MAX_FILE_PATCH_LINES,
): { text: string; truncated: boolean } {
  const lines = patch.split("\n");
  if (lines.length <= maxLines) return { text: patch, truncated: false };
  const dropped = lines.length - maxLines;
  return {
    text:
      lines.slice(0, maxLines).join("\n") +
      `\n… ${dropped} more line${dropped === 1 ? "" : "s"} not shown`,
    truncated: true,
  };
}

/**
 * Which files get a patch body.
 *
 * The file *list* is always complete — it is cheap and it is what tells the
 * operator the shape of the change. Bodies are budgeted, and what the budget
 * leaves out is counted rather than quietly dropped: a diff view that shows
 * twelve of forty files without saying so reads as a run that touched twelve.
 *
 * Budgeted in bytes as well as lines, because the lines are what is shown and
 * the bytes are what is read. A minified bundle is one line of megabytes: it
 * fits any line budget, and the one read every selected file shares fails
 * whole at `MAX_DIFF_BYTES` — so without this, that one file takes every other
 * file's patch with it.
 */
export function selectForPatch(
  entries: readonly SizedEntry[],
  limits = PATCH_LIMITS,
): { selected: SizedEntry[]; omitted: SizedEntry[] } {
  const selected: SizedEntry[] = [];
  const omitted: SizedEntry[] = [];
  let lines = 0;
  let bytes = 0;

  for (const e of entries) {
    // A binary file costs nothing: git emits one "Binary files … differ" line
    // for it rather than a patch, so it never eats the line budget a text file
    // would, nor the byte budget however large its blobs are.
    const binary = e.added === null && e.deleted === null;
    const lineCost = Math.min((e.added ?? 0) + (e.deleted ?? 0), limits.maxFileLines);
    // The content plus one marker per changed line, which is what doubles a
    // file of short lines. Not truncated like the line cost: `truncatePatch`
    // cuts after the read, and the read is what the byte budget protects.
    const byteCost = binary
      ? 0
      : e.bytes === null
        ? null
        : e.bytes + (e.added ?? 0) + (e.deleted ?? 0);
    if (
      byteCost === null ||
      selected.length >= limits.maxFiles ||
      lines + lineCost > limits.maxLines ||
      bytes + byteCost > limits.maxBytes
    ) {
      omitted.push(e);
      continue;
    }
    selected.push(e);
    lines += lineCost;
    bytes += byteCost;
  }
  return { selected, omitted };
}

/**
 * Parse `git ls-tree -l -z` into `path -> size`.
 *
 * Records are `mode SP type SP object SP+ size TAB path NUL`, the size padded
 * on the left. Only the first tab separates, for `parseNumstat`'s reason. A
 * submodule or a directory has `-` for a size and costs nothing here: a
 * submodule's patch is one line, and a directory's files are entries of their
 * own.
 */
export function parseLsTreeSizes(raw: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const record of raw.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const size = record.slice(0, tab).trim().split(/\s+/).at(-1);
    const bytes = Number(size);
    out.set(record.slice(tab + 1), Number.isFinite(bytes) ? bytes : 0);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Building the diff                                                   */
/* ------------------------------------------------------------------ */

/**
 * Re-prove a stored repository path inside its mount.
 *
 * Same pair of checks the run loop makes before every spawn, and for the same
 * reason: a path that was contained when the run was created can be a symlink
 * out of the workspace by the time someone opens the run page. Returns null
 * rather than throwing — a repository that has since moved is an empty state,
 * not a server error.
 */
function repoPathFor(dir: string): string | null {
  try {
    const resolved = resolveWorkspaceFolder(dir, describeFolder(dir).mountId);
    return resolved === dir ? resolved : null;
  } catch {
    return null;
  }
}

const EMPTY: Omit<RunDiff, "kind" | "reason"> = {
  base: null,
  branch: null,
  measuredFrom: null,
  head: null,
  files: [],
  filesChanged: 0,
  added: 0,
  deleted: 0,
  omittedPatches: 0,
  patchFailure: null,
  uncommitted: [],
  caveat: null,
};

const nothing = (reason: string): RunDiff => ({
  ...EMPTY,
  kind: "none",
  reason,
});

/**
 * Diff arguments shared by every call here.
 *
 * `--no-ext-diff` and `--no-textconv` are the load-bearing ones: both
 * `diff.external` and a `diff.<driver>.textconv` reached through `.gitattributes`
 * are *commands git runs*, configured by the repository being diffed. That is
 * the same class of repository-controlled execution `core.fsmonitor` is cleared
 * for, and rendering someone's branch is not a reason to run their code.
 */
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "-M"];

export async function runDiff(runId: string): Promise<RunDiff> {
  const run = getRun(runId);
  if (!run) return nothing("No such run.");

  if (run.isolation === "worktree" && run.worktree_branch && run.repo_root) {
    return rangeDiff(run);
  }
  return worktreeDiff(run);
}

/** An isolated run: `<base>...<branch>`, which is exactly its own work. */
async function rangeDiff(run: RunRow): Promise<RunDiff> {
  const repoRoot = repoPathFor(run.repo_root!);
  if (!repoRoot) {
    return nothing("This run's repository is no longer inside a workspace mount.");
  }

  const branch = run.worktree_branch!;
  const base = run.worktree_base;
  if (!base) return nothing("This run never recorded the commit it branched from.");

  const resolved = await git(repoRoot, ["rev-parse", "--verify", `${branch}^{commit}`]);
  if (!resolved.ok) {
    return {
      ...EMPTY,
      kind: "none",
      base,
      branch,
      reason: `Branch ${branch} is gone — it was deleted after this run finished.`,
    };
  }

  // The range names the commit, not the branch: a run still working commits
  // between the calls below, and a diff whose numstat, statuses and patches
  // were read from three different tips is one no recorded sha describes.
  const head = resolved.stdout;
  const measuredFrom = await targetMergeOn(repoRoot, run.worktree_base_branch, base, head);
  const { from, range } = diffRange(base, head, measuredFrom);
  const numstat = await git(repoRoot, ["diff", ...DIFF_FLAGS, "--numstat", "-z", range], {
    maxBytes: MAX_DIFF_BYTES,
  });
  if (!numstat.ok) {
    return {
      ...EMPTY,
      kind: "none",
      base,
      branch,
      measuredFrom,
      head,
      reason: numstat.overflowed
        ? "This change is too large to summarise."
        : `git could not diff ${range}: ${numstat.stderr || "unknown error"}`,
    };
  }

  const entries = parseNumstat(numstat.stdout);
  if (entries.length === 0) {
    return {
      ...EMPTY,
      kind: "range",
      base,
      branch,
      measuredFrom,
      head,
      reason: measuredFrom
        ? `Nothing on this branch differs from ${measuredFrom.target} as it was merged in.`
        : "The agent committed nothing to this branch.",
      uncommitted: await uncommittedIn(run),
    };
  }

  // The side a three-dot range compares against, which is what the patch's
  // deletions come from and so what the byte budget has to size.
  const [nameStatus, mergeBase] = await Promise.all([
    git(repoRoot, ["diff", ...DIFF_FLAGS, "--name-status", "-z", range]),
    git(repoRoot, ["merge-base", from, head]),
  ]);
  const statuses = parseNameStatus(nameStatus.stdout);
  const contents = mergeBase.ok
    ? await filesWithPatches(repoRoot, range, { from: mergeBase.stdout, to: head }, entries, statuses)
    : unreadContents(entries, statuses, `git found no common commit for ${range}: ${mergeBase.stderr || "unknown error"}`);

  return {
    kind: "range",
    reason: null,
    base,
    branch,
    measuredFrom,
    head,
    ...contents,
    filesChanged: entries.length,
    added: entries.reduce((n, e) => n + (e.added ?? 0), 0),
    deleted: entries.reduce((n, e) => n + (e.deleted ?? 0), 0),
    uncommitted: await uncommittedIn(run),
    caveat: null,
  };
}

/**
 * The newest merge of `target` into the branch between `base` and `head`.
 *
 * The newest, and only along the first-parent line: that is the branch's own
 * history, and a later merge of the target carries everything an earlier one
 * did. Its second parent must be on the target: another branch's tip can stand
 * where the target never was, and a diff from there is not what landing this
 * branch would bring. So a merge of some other branch on top is walked past,
 * not taken as the end of the search: stopping there measured the branch from
 * `base` and counted everything the target gained as the run's work. Anything
 * git cannot answer here leaves the diff measured from `base`, which is what
 * the card then says it is.
 */
export async function targetMergeOn(
  repoRoot: string,
  target: string | null,
  base: string,
  head: string,
): Promise<TargetMerge | null> {
  if (!target) return null;
  const merges = await git(repoRoot, [
    "rev-list",
    "--first-parent",
    "--merges",
    "--parents",
    `-n${MAX_MERGES_WALKED}`,
    `${base}..${head}`,
  ]);
  if (!merges.ok) return null;

  // One at a time and newest first: the first merge on the target is the
  // answer, and asking about the older ones as well would spend their
  // children for nothing.
  for (const merge of parseMerges(merges.stdout)) {
    const onTarget = await git(repoRoot, ["merge-base", "--is-ancestor", merge.commit, target]);
    if (onTarget.ok) return { ...merge, target };
  }
  return null;
}

/**
 * What one commit did to a given set of paths.
 *
 * Against the commit's **first** parent, which is what makes it meaningful for
 * the merge commit a conflict resolution produces: parent one is the run's
 * branch as it stood, so the diff reads as "what arrived, and how it was
 * reconciled" rather than as a merge's usual empty-looking self.
 *
 * Returns null when git could not produce it. An empty file list is a real
 * answer — the commit changed none of those paths — and is not the same thing.
 */
export async function commitDiff(
  repoRoot: string,
  commit: string,
  paths: readonly string[],
): Promise<FileContents | null> {
  const range = `${commit}^1..${commit}`;
  // Pinned for the same reason `patchesFor` pins them: these came out of git
  // and go back in as pathspecs, where `*` in a filename is a glob.
  const pathspecs = paths.map((p) => `:(top,literal)${p}`);

  const numstat = await git(
    repoRoot,
    ["diff", ...DIFF_FLAGS, "--numstat", "-z", range, "--", ...pathspecs],
    { maxBytes: MAX_DIFF_BYTES },
  );
  if (!numstat.ok) return null;

  const entries = parseNumstat(numstat.stdout);
  if (entries.length === 0) return { files: [], omittedPatches: 0, patchFailure: null };

  const statuses = parseNameStatus(
    (
      await git(repoRoot, [
        "diff",
        ...DIFF_FLAGS,
        "--name-status",
        "-z",
        range,
        "--",
        ...pathspecs,
      ])
    ).stdout,
  );

  return filesWithPatches(repoRoot, range, { from: `${commit}^1`, to: commit }, entries, statuses);
}

/**
 * A run that worked in the operator's own folder.
 *
 * There is no range to take: the run committed into their branch, or left
 * uncommitted edits in their tree, alongside whatever they were doing
 * themselves — and nothing on either side records which is which. So this
 * reports the tree's current state as a file list, with the caveat attached,
 * and no patch bodies. Showing a patch here would look exactly like the range
 * case while meaning something else entirely.
 */
async function worktreeDiff(run: RunRow): Promise<RunDiff> {
  const folder = repoPathFor(run.folder);
  if (!folder) {
    return nothing("This run's folder is no longer inside a workspace mount.");
  }

  const inside = await git(folder, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout !== "true") {
    return nothing("This run did not work in a git repository, so there is nothing to diff.");
  }

  // `trim: false` because these lines are rendered verbatim: the porcelain
  // format puts the status in the first two columns, so an unstaged edit reads
  // `" M path"` and trimming the stream eats that space off the *first* record
  // only — which both flips its meaning to staged and leaves it a column left
  // of every row under it, in a list where alignment is the only thing
  // separating the status from the path. The trailing newline it keeps is what
  // `filter(Boolean)` is for.
  const status = await git(folder, ["status", "--porcelain"], {
    maxBytes: MAX_DIFF_BYTES,
    trim: false,
  });
  if (!status.ok) {
    return nothing("Could not read the folder's git status.");
  }

  const lines = status.stdout.split("\n").filter(Boolean);
  return {
    ...EMPTY,
    kind: "worktree",
    reason: lines.length === 0 ? "Nothing is uncommitted in this folder." : null,
    uncommitted: lines,
    caveat:
      "This run worked directly in your checkout, so this is the folder's " +
      "current state — your own edits included. There is no way to tell them " +
      "apart from the run's.",
  };
}

/** Uncommitted work left in an isolated run's checkout, if it still exists. */
async function uncommittedIn(run: RunRow): Promise<string[]> {
  const slot = run.worktree_path;
  if (!slot || !fs.existsSync(slot)) return [];
  // `trim: false` for the reason `worktreeDiff` states: these lines reach the
  // page as they are, and the leading status column is part of what they say.
  const st = await git(slot, ["status", "--porcelain"], { trim: false });
  return st.ok ? st.stdout.split("\n").filter(Boolean) : [];
}

/** The file list with whatever patches could be read, and what could not. */
interface FileContents {
  files: DiffFile[];
  omittedPatches: number;
  patchFailure: string | null;
}

type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Size, budget and read the patches for a diff's files.
 *
 * `from` and `to` are the two commits the patch compares, which for a
 * three-dot range is the merge base and not the left-hand name.
 */
async function filesWithPatches(
  repoRoot: string,
  range: string,
  sides: { from: string; to: string },
  entries: readonly NumstatEntry[],
  statuses: Map<string, DiffFileStatus>,
): Promise<FileContents> {
  const sized = await sizeEntries(repoRoot, sides, entries);
  if (!sized.ok) return unreadContents(entries, statuses, sized.reason);

  const { selected, omitted } = selectForPatch(sized.value);
  const patches = await patchesFor(repoRoot, range, selected);
  if (!patches.ok) return unreadContents(entries, statuses, patches.reason);

  return {
    files: buildFiles(entries, statuses, selected, patches.value),
    omittedPatches: omitted.length,
    patchFailure: null,
  };
}

/**
 * Every file listed and none with contents, saying why. Counted as omitted
 * whether or not the budget picked it: the card's count is of files shown
 * without contents, and a count of zero over a list of empty rows is the
 * failure this exists to name.
 */
function unreadContents(
  entries: readonly NumstatEntry[],
  statuses: Map<string, DiffFileStatus>,
  reason: string,
): FileContents {
  return {
    files: buildFiles(entries, statuses, [], []),
    omittedPatches: entries.length,
    patchFailure: reason,
  };
}

const literalPath = (p: string) => `:(top,literal)${p}`;

/**
 * Each entry with the blob sizes of both sides, for the byte budget.
 *
 * One `ls-tree` per side rather than a `cat-file` per blob. A path absent from
 * a side — an added file's old side, a deleted file's new one — costs nothing
 * there, which is what its patch holds from that side.
 */
async function sizeEntries(
  repoRoot: string,
  sides: { from: string; to: string },
  entries: readonly NumstatEntry[],
): Promise<Read<SizedEntry[]>> {
  const sizable = entries.slice(0, MAX_SIZED_FILES);
  if (sizable.length === 0) return { ok: true, value: [] };

  const lsTree = (commit: string, paths: string[]) =>
    git(repoRoot, ["ls-tree", "-l", "-z", commit, "--", ...paths.map(literalPath)], {
      maxBytes: MAX_DIFF_BYTES,
    });
  const [before, after] = await Promise.all([
    lsTree(sides.from, sizable.map((e) => e.oldPath ?? e.path)),
    lsTree(sides.to, sizable.map((e) => e.path)),
  ]);
  const failed = [before, after].find((res) => !res.ok);
  if (failed) {
    return {
      ok: false,
      reason: `git could not read the files' sizes: ${failed.stderr || "unknown error"}`,
    };
  }

  const oldSizes = parseLsTreeSizes(before.stdout);
  const newSizes = parseLsTreeSizes(after.stdout);
  return {
    ok: true,
    value: entries.map((e, i) => ({
      ...e,
      bytes:
        i < sizable.length
          ? (oldSizes.get(e.oldPath ?? e.path) ?? 0) + (newSizes.get(e.path) ?? 0)
          : null,
    })),
  };
}

/**
 * Patch bodies for the selected files, in one call.
 *
 * Paths come back from git and go straight out again as pathspecs, so each is
 * pinned with `:(top,literal)` — without it a filename containing `*` or `[`
 * would be read as a glob and quietly pull in files the caller did not select.
 */
async function patchesFor(
  repoRoot: string,
  range: string,
  selected: readonly NumstatEntry[],
): Promise<Read<string[]>> {
  if (selected.length === 0) return { ok: true, value: [] };

  const pathspecs = selected.flatMap((e) =>
    e.oldPath ? [literalPath(e.oldPath), literalPath(e.path)] : [literalPath(e.path)],
  );

  const res = await git(
    repoRoot,
    ["diff", ...DIFF_FLAGS, range, "--", ...pathspecs],
    { maxBytes: MAX_DIFF_BYTES, timeoutMs: 60_000 },
  );
  if (res.overflowed) {
    return {
      ok: false,
      reason: `git's patches for these files came to more than ${MAX_DIFF_BYTES / 1_000_000} MB, the most one read takes`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: `git could not read the files' contents: ${res.stderr || "unknown error"}`,
    };
  }

  const chunks = splitPatches(res.stdout);
  // Positional matching is only sound while the counts agree. They should
  // always agree — same diff queue, same order — so a mismatch means an
  // assumption here is wrong, and the honest response is no patches at all
  // rather than hunks filed under the wrong filename.
  if (chunks.length !== selected.length) {
    return {
      ok: false,
      reason:
        `git's patch came in ${chunks.length} parts for ${selected.length} files, ` +
        "so none is shown rather than one under another file's name",
    };
  }
  return { ok: true, value: chunks };
}

function buildFiles(
  entries: readonly NumstatEntry[],
  statuses: Map<string, DiffFileStatus>,
  selected: readonly NumstatEntry[],
  patches: readonly string[],
): DiffFile[] {
  const patchByPath = new Map<string, string>();
  selected.forEach((e, i) => patchByPath.set(e.path, patches[i] ?? ""));

  return entries.map((e) => {
    const raw = patchByPath.get(e.path);
    const cut = raw === undefined ? null : truncatePatch(raw);
    return {
      path: e.path,
      oldPath: e.oldPath,
      status: statuses.get(e.path) ?? (e.oldPath ? "renamed" : "modified"),
      added: e.added,
      deleted: e.deleted,
      binary: e.added === null && e.deleted === null,
      patch: cut?.text ?? null,
      patchTruncated: cut?.truncated ?? false,
    };
  });
}

/**
 * The diff as text for a reviewer, bounded and honest about the bound.
 *
 * A large change cannot be sent whole — argv itself caps out well before a
 * model's context does — so the cut is made at a file boundary and named. A
 * reviewer that silently receives a third of a change writes a confident review
 * of the wrong thing.
 */
export function diffAsText(diff: RunDiff, maxBytes: number): {
  text: string;
  shown: number;
  truncated: boolean;
} {
  const parts: string[] = [];
  const missing: DiffFile[] = [];
  let used = 0;
  let full = true;

  for (const f of diff.files) {
    const header = `\n--- ${f.path}${f.oldPath ? ` (renamed from ${f.oldPath})` : ""} ---\n`;
    const block = f.patch === null ? null : header + f.patch + "\n";

    // Once the budget is spent every later file is missing, patch or not — and
    // a file whose patch was already withheld for size is missing too.
    if (!full || block === null || used + block.length > maxBytes) {
      if (block !== null && used + block.length > maxBytes) full = false;
      missing.push(f);
      continue;
    }
    parts.push(block);
    used += block.length;
  }

  const shown = diff.files.length - missing.length;
  if (missing.length > 0) {
    parts.push(
      `\n[TRUNCATED: ${shown} of ${diff.files.length} changed files are included above.\n` +
        `The rest are listed here and their contents were NOT shown to you — say so ` +
        `rather than reasoning about them:\n` +
        missing
          .map((f) => `  ${f.path} (+${f.added ?? "?"} −${f.deleted ?? "?"})`)
          .join("\n") +
        `\n]`,
    );
  }

  return { text: parts.join(""), shown, truncated: missing.length > 0 };
}
