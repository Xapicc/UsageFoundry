/**
 * A unified diff as rows, with the line numbers git states only once per hunk.
 *
 * The gutter beside a patch is not decoration: the operator reading it is about
 * to open the file, and the number is what tells them where. git writes it in
 * the `@@ -a,b +c,d @@` header and nowhere else, so every line's number is
 * *derived* — from the header, and from how many lines since it belong to each
 * side. That derivation is the whole of this module, and both ways of getting
 * it wrong are silent: a deletion that advances the new-side counter, or a
 * second hunk numbered on from the first instead of from its own header, print
 * plausible numbers that name the wrong lines for the rest of the file.
 *
 * Pure and client-safe — no node builtins — for the reason `cycles.ts` is: it
 * runs in the browser over a patch the API already sent, and `src/lib` is what
 * `tsconfig.test.json` compiles.
 */

export type PatchRowKind =
  /** A file header — everything before the first hunk of a file. */
  | "meta"
  /** The `@@` line itself. */
  | "hunk"
  | "add"
  | "del"
  | "context"
  /**
   * git's `\ No newline at end of file`, or the marker `truncatePatch` ends a
   * shortened patch with: neither belongs to a side of the file.
   */
  | "note";

export interface PatchRow {
  kind: PatchRowKind;
  /** Line number on the pre-image side, or null where the row has none. */
  oldLine: number | null;
  /** Line number on the post-image side, or null where the row has none. */
  newLine: number | null;
  /** The line exactly as git wrote it, marker and all. */
  text: string;
}

/**
 * Only the two starts matter: the counts are what git *would* write, and the
 * rows themselves are what this counts. A combined diff's `@@@` is deliberately
 * not matched — nothing here renders one, because `resolutionChange` diffs
 * against the first parent precisely to avoid a `--cc` view.
 */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * What `truncatePatch` appends in place of the lines it dropped. Written here
 * beside `TRUNCATION_MARKER`, which reads it back, so the two cannot drift: the
 * marker has no `+`, `-` or `\` prefix, and a copy of its wording that fell out
 * of step would be numbered as a line of the file.
 */
export function patchTruncationMarker(dropped: number): string {
  return `… ${dropped} more line${dropped === 1 ? "" : "s"} not shown`;
}

/**
 * Only the last line is ever looked at. A line of the file that reads like this
 * one reaches `patchRows` with git's leading space on it, so it does not match.
 */
const TRUNCATION_MARKER = /^… \d+ more lines? not shown$/;

export function patchRows(text: string): PatchRow[] {
  const lines = text.split("\n");
  // A patch ends with a newline, so the split leaves one empty tail element.
  // Counted as a context line it would advance both sides by one and put every
  // later file's numbering out by one.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  // Taken off before the loop: inside a hunk a line with no prefix is context,
  // which would hand the marker the next line number.
  const marker = TRUNCATION_MARKER.test(lines[lines.length - 1] ?? "") ? lines.pop() : undefined;

  const rows: PatchRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  // Which side of the first `@@` we are on. Before it, `--- a/x` and `+++ b/x`
  // are the file header; after it, a line starting with `-` is a deletion
  // whatever it says — including one whose content is itself `--- x`. Testing
  // the prefix without this is how a diff of a diff renders as nonsense.
  let inHunk = false;

  for (const line of lines) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", oldLine: null, newLine: null, text: line });
      continue;
    }

    if (!inHunk || line.startsWith("diff --git ")) {
      // A new file's header closes the previous file's last hunk.
      inHunk = false;
      rows.push({ kind: "meta", oldLine: null, newLine: null, text: line });
      continue;
    }

    if (line.startsWith("\\")) {
      rows.push({ kind: "note", oldLine: null, newLine: null, text: line });
      continue;
    }

    if (line.startsWith("+")) {
      rows.push({ kind: "add", oldLine: null, newLine: newLine++, text: line });
      continue;
    }

    if (line.startsWith("-")) {
      rows.push({ kind: "del", oldLine: oldLine++, newLine: null, text: line });
      continue;
    }

    // A context line, whether or not its leading space survived: git writes
    // one, and several tools that touch a patch on the way here strip trailing
    // whitespace, which turns an empty context line into an empty string.
    rows.push({
      kind: "context",
      oldLine: oldLine++,
      newLine: newLine++,
      text: line,
    });
  }

  if (marker !== undefined) {
    rows.push({ kind: "note", oldLine: null, newLine: null, text: marker });
  }
  return rows;
}

/**
 * How many digits the gutter has to hold. Zero when the patch carries no
 * numbers at all, which is what a header-only or binary patch is.
 */
export function gutterDigits(rows: readonly PatchRow[]): number {
  let widest = 0;
  for (const row of rows) {
    widest = Math.max(widest, row.oldLine ?? 0, row.newLine ?? 0);
  }
  return widest === 0 ? 0 : String(widest).length;
}
