// The spike's cases, composed by the production prompt instead of prompt.md.
//
// `prompt.md` is the spike's text; what the validator sends is `buildValidationPrompt`
// in src/lib/validation.ts, whose preamble deliberately differs from it (the
// "be suspicious rather than generous" section is replaced by VERDICT_PREFERENCE).
// So the 34 of 37 in RESULT.md is a number about prompt.md, and this module is
// how score.mjs / history.mjs measure the string that ships: they hand it a case
// and get back what `startCheck` would have put in the child's argv.
//
// The case files keep one `git diff` text (and a list of the files whose bodies
// the spike dropped to fit 60 kB), not the `RunDiff` the server builds. This
// rebuilds the files from it and then lets the production `diffAsText` render
// them, so the `--- path ---` blocks and the `[TRUNCATED: …]` notice are the
// production ones. Three differences remain, and the reports say so:
//   - a dropped file's +/- counts are not recoverable from a cut case (the
//     stat gives one total per file), so its line reads `(+? −?)`;
//   - the budget is not re-applied: the case already holds what fit 60 kB, and
//     applying it again to text that now carries a header per file would drop a
//     file the earlier measurement showed;
//   - the production prompt has no sentence for a chained branch (`RunDiff` does
//     not know), so the spike's "this branch carries more than one run" note
//     is absent here, as it is in production.

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

/** The board task a case is judged against: `runs.task`, which is all the spike kept. */
export function taskOf(c, id = `spike-${c.n}`) {
  return {
    id, title: "(the run's task, as the spike recovered it)", body: c.task || "(no task text recovered)", status: "claimed",
    priority: "normal", origin: "operator", mountId: "m", folder: "/w", createdByRunId: null, claimedByRunId: "r",
    claimedByOperator: false, completedByRunId: null, parentTaskId: null, operatorOnly: false, needsFrontier: false,
    createdAt: 1, updatedAt: 2, closedAt: null,
  };
}

/** One `diff --git` chunk as the `DiffFile` the server would have built for it. */
export function fileOfPatch(patch) {
  const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(patch);
  const renamedFrom = /^rename from (.+)$/m.exec(patch);
  const body = patch.slice(Math.max(patch.search(/^@@/m), 0));
  const lines = body.split("\n");
  return {
    path: header ? header[2] : "?",
    oldPath: renamedFrom ? renamedFrom[1] : null,
    status: renamedFrom ? "renamed" : "modified",
    added: lines.filter((l) => l.startsWith("+")).length,
    deleted: lines.filter((l) => l.startsWith("-")).length,
    binary: false,
    patch: patch.endsWith("\n") ? patch.slice(0, -1) : patch,
    patchTruncated: false,
  };
}

const statTotals = (stat) => {
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(stat ?? "");
  return { filesChanged: Number(m?.[1] ?? 0), added: Number(m?.[2] ?? 0), deleted: Number(m?.[3] ?? 0) };
};

/**
 * A `RunDiff` for the part of a case's diff given, plus the text the production
 * renderer makes of it. `patches` are `diff --git` chunks in order; `omitted`
 * are the paths whose bodies were not kept; `stat` is the diffstat the totals
 * come from. Returns the pieces `buildValidationPrompt` takes.
 */
export function diffFor({ diffAsText, branch, patches, omittedPaths = [], stat, maxBytes = Number.MAX_SAFE_INTEGER, cutPatch = null }) {
  const shown = patches.map((p) => {
    const f = fileOfPatch(p);
    if (!cutPatch) return f;
    // The server cuts one file's patch at a line cap before the byte budget sees it.
    const cut = cutPatch(f.patch);
    return { ...f, patch: cut.text, patchTruncated: cut.truncated };
  });
  const dropped = omittedPaths.map((p) => ({
    path: p, oldPath: null, status: "modified", added: null, deleted: null, binary: false, patch: null, patchTruncated: false,
  }));
  const files = [...shown, ...dropped];
  const sum = (key) => shown.reduce((n, f) => n + f[key], 0);
  const totals =
    files.length === 0
      ? { filesChanged: 0, added: 0, deleted: 0 }
      : stat
        ? statTotals(stat)
        : { filesChanged: files.length, added: sum("added"), deleted: sum("deleted") };
  const diff = {
    kind: "range", reason: null, base: "base", branch: branch ?? "(unknown)", measuredFrom: null, head: "0".repeat(40),
    files, filesChanged: totals.filesChanged || files.length, added: totals.added, deleted: totals.deleted,
    omittedPatches: dropped.length, patchFailure: null, uncommitted: [], caveat: null,
  };
  const { text, truncated } = files.length === 0 ? { text: "", truncated: false } : diffAsText(diff, maxBytes);
  return { diff, diffText: text, truncated };
}

export const splitPatches = (text) => text.split(/^(?=diff --git )/m).filter(Boolean);

/** The compiled production functions. The module reaches db.ts and config.ts at load, which want a data dir. */
export function loadProduction(buildDir) {
  process.env.DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "uf-shipped-spike-"));
  process.env.CLAUDE_BIN ??= "/nonexistent";
  const require = createRequire(import.meta.url);
  const { buildValidationPrompt } = require(path.resolve(buildDir, "lib/validation.js"));
  const { diffAsText, wholeCommitDiff, truncatePatch } = require(path.resolve(buildDir, "lib/diff.js"));
  const { HISTORY_COMMITS_SHOWN } = require(path.resolve(buildDir, "lib/validationHistory.js"));
  return { buildValidationPrompt, diffAsText, wholeCommitDiff, truncatePatch, HISTORY_COMMITS_SHOWN };
}

/** `compose(caseFile)` -> the production prompt for that case, with no history. */
export function shippedComposer(buildDir) {
  const { buildValidationPrompt, diffAsText } = loadProduction(buildDir);
  return (c) => {
    const d = c.diff ?? { mode: "empty" };
    const { diff, diffText, truncated } = diffFor({
      diffAsText,
      branch: c.branch,
      patches: d.mode === "empty" ? [] : splitPatches(d.text ?? ""),
      omittedPaths: (d.omitted ?? []).map((o) => o.file),
      stat: d.stat,
    });
    return buildValidationPrompt({ task: taskOf(c), runPrompt: null, diff, diffText, truncated, history: null });
  };
}
