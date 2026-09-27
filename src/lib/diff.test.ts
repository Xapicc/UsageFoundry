import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  diffAsText,
  diffRange,
  parseLsTreeSizes,
  parseNameStatus,
  parseNewestMerge,
  parseNumstat,
  selectForPatch,
  splitPatches,
  truncatePatch,
  type RunDiff,
} from "./diff";

/**
 * Covers the parsing and the budgeting, and only those.
 *
 * Every one of them fails silently and expensively. A mis-parsed record shifts
 * every following file by one, so a rename in the middle of a change renames
 * the file list from there on — and a reviewer then writes a confident report
 * about work that happened somewhere else. The budget is the no-silent-caps
 * rule made executable: a diff that quietly shows twelve of forty files reads
 * as a run that touched twelve.
 */

/* ------------------------------------------------------------------ */
/* Parsing git's NUL-separated records                                 */
/* ------------------------------------------------------------------ */

describe("parseNumstat", () => {
  it("reads plain, renamed and binary records in one stream", () => {
    // Captured from `git diff --numstat -z -M`: a rename spends three fields
    // (empty tail, old path, new path) where a plain change spends one.
    const raw =
      "1\t0\tadded.txt\0" +
      "1\t1\tf.txt\0" +
      "0\t0\t\0keep.txt\0kept.txt\0" +
      "-\t-\tlogo.png\0";

    assert.deepEqual(parseNumstat(raw), [
      { path: "added.txt", oldPath: null, added: 1, deleted: 0 },
      { path: "f.txt", oldPath: null, added: 1, deleted: 1 },
      { path: "kept.txt", oldPath: "keep.txt", added: 0, deleted: 0 },
      // `-` is binary, not zero: a binary file has no line counts at all, and
      // reporting it as +0 −0 would say it did not change.
      { path: "logo.png", oldPath: null, added: null, deleted: null },
    ]);
  });

  it("keeps a path containing a tab intact", () => {
    // The reason -z exists. Splitting the record on every tab would truncate
    // this to "odd" and quietly diff a file that does not exist.
    const parsed = parseNumstat("2\t3\todd\tname.txt\0");
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].path, "odd\tname.txt");
  });

  it("stops rather than inventing a path when a rename record is cut short", () => {
    assert.deepEqual(parseNumstat("0\t0\t\0keep.txt\0"), []);
  });
});

describe("parseNameStatus", () => {
  it("keys renames by their new path", () => {
    const map = parseNameStatus("A\0added.txt\0M\0f.txt\0R100\0keep.txt\0kept.txt\0");
    assert.equal(map.get("added.txt"), "added");
    assert.equal(map.get("f.txt"), "modified");
    assert.equal(map.get("kept.txt"), "renamed");
    // The old path is not a changed file in its own right.
    assert.equal(map.get("keep.txt"), undefined);
  });
});

/* ------------------------------------------------------------------ */
/* Splitting one diff into per-file patches                            */
/* ------------------------------------------------------------------ */

describe("splitPatches", () => {
  const patch = [
    "diff --git a/one.txt b/one.txt",
    "index 111..222 100644",
    "--- a/one.txt",
    "+++ b/one.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/two.txt b/two.txt",
    "index 333..444 100644",
    "--- a/two.txt",
    "+++ b/two.txt",
    "@@ -0,0 +1 @@",
    "+hello",
  ].join("\n");

  it("splits on file headers, in emission order", () => {
    const chunks = splitPatches(patch);
    assert.equal(chunks.length, 2);
    assert.ok(chunks[0].startsWith("diff --git a/one.txt"));
    assert.ok(chunks[1].startsWith("diff --git a/two.txt"));
  });

  it("does not split on a header inside a hunk", () => {
    // A file that itself contains a diff. Every body line carries a prefix, so
    // the forged header arrives as "+diff --git …" and is not a seam. Splitting
    // here would file the rest of this file's hunk under a filename taken from
    // its own contents.
    const nested = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -0,0 +2 @@",
      "+diff --git a/evil.txt b/evil.txt",
      "+@@ -1 +1 @@",
    ].join("\n");
    assert.equal(splitPatches(nested).length, 1);
  });

  it("returns nothing for an empty diff", () => {
    assert.deepEqual(splitPatches(""), []);
  });

  it("keeps a file that became a symlink as one chunk, as numstat counts it", () => {
    // git 2.39.5's own output for `rm f; ln -s g f; echo y >> g`: numstat
    // lists `f` and `g`, the patch writes `f` twice under one header. Split
    // three ways, the count disagrees and every file loses its patch.
    const typeChange = [
      "diff --git a/f b/f",
      "deleted file mode 100644",
      "index 7898192..0000000",
      "--- a/f",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-a",
      "diff --git a/f b/f",
      "new file mode 120000",
      "index 0000000..7937c68",
      "--- /dev/null",
      "+++ b/f",
      "@@ -0,0 +1 @@",
      "+g",
      "\\ No newline at end of file",
      "diff --git a/g b/g",
      "index 01058d8..b21bd8b 100644",
      "--- a/g",
      "+++ b/g",
      "@@ -1 +1,2 @@",
      " g",
      "+y",
    ].join("\n");
    const chunks = splitPatches(typeChange);
    assert.equal(chunks.length, 2);
    assert.match(chunks[0], /^diff --git a\/f b\/f\ndeleted file mode/);
    assert.match(chunks[0], /\nnew file mode 120000\n/);
    assert.ok(chunks[1].startsWith("diff --git a/g b/g"));
  });
});

/* ------------------------------------------------------------------ */
/* Where a run's diff is measured from                                 */
/* ------------------------------------------------------------------ */

describe("diffRange", () => {
  const base = "b".repeat(40);
  const head = "h".repeat(40);
  // `git rev-list --first-parent --merges --parents -n1 base..head` after
  // `git merge main` on the run's branch, on git 2.39.5: the merge, then the
  // branch before it, then main as it was merged in.
  const revList =
    "8e9bedec455d8e3f153a17d9c401177a12efec7a " +
    "88a8db805816d2306dcff41679d70c25d2a3ec2c " +
    "bd820da6100d630ec3a530cdd61d7595c7dda54d\n";

  it("measures from what a merge of the target brought in, not from the base", () => {
    // From the base, every commit the target gained before the merge is in
    // the range: measured on that repository, `base...head` listed main's two
    // files as the run's and doubled its count on the file both touched.
    const merge = parseNewestMerge(revList);
    assert.ok(merge);
    assert.deepEqual(diffRange(base, head, { ...merge, target: "main" }), {
      from: "bd820da6100d630ec3a530cdd61d7595c7dda54d",
      range: `bd820da6100d630ec3a530cdd61d7595c7dda54d...${head}`,
    });
  });

  it("reads the merged-in side as the second parent, never the first", () => {
    // The first parent is the branch before the merge; measured from there
    // the run's own commits disappear from its diff.
    assert.deepEqual(parseNewestMerge(revList), {
      merge: "8e9bedec455d8e3f153a17d9c401177a12efec7a",
      commit: "bd820da6100d630ec3a530cdd61d7595c7dda54d",
    });
  });

  it("measures from the base when the branch has no merge", () => {
    assert.equal(parseNewestMerge(""), null);
    assert.deepEqual(diffRange(base, head, null), {
      from: base,
      range: `${base}...${head}`,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Budgeting                                                           */
/* ------------------------------------------------------------------ */

describe("selectForPatch", () => {
  const file = (path: string, added: number, deleted = 0, bytes: number | null = 100) => ({
    path,
    oldPath: null,
    added,
    deleted,
    bytes,
  });
  const limits = { maxFiles: 10, maxLines: 100, maxFileLines: 600, maxBytes: 1_000_000 };

  it("stops at the line budget and reports what it left out", () => {
    const { selected, omitted } = selectForPatch(
      [file("a", 40), file("b", 40), file("c", 40)],
      limits,
    );
    assert.deepEqual(
      selected.map((e) => e.path),
      ["a", "b"],
    );
    // Not dropped, not silently shortened — named, so the caller can say so.
    assert.deepEqual(
      omitted.map((e) => e.path),
      ["c"],
    );
  });

  it("charges a huge file only what its patch will actually cost", () => {
    // A 100k-line lockfile is truncated to maxFileLines before it is rendered,
    // so charging the budget its full size would push every later file out for
    // lines that are never shown.
    const { selected } = selectForPatch([file("lock", 100_000), file("src", 10)], {
      ...limits,
      maxFileLines: 50,
    });
    assert.deepEqual(
      selected.map((e) => e.path),
      ["lock", "src"],
    );
  });

  it("lets a binary file through without spending the budget", () => {
    // Its blobs can be any size: git writes one "Binary files … differ" line
    // for it, and that is all the read carries.
    const { selected, omitted } = selectForPatch(
      [{ path: "logo.png", oldPath: null, added: null, deleted: null, bytes: 5_000_000 }],
      { ...limits, maxLines: 0, maxBytes: 0 },
    );
    assert.equal(selected.length, 1);
    assert.equal(omitted.length, 0);
  });

  it("leaves out a one-line file of megabytes and keeps the small change beside it", () => {
    // A minified bundle: one line, so no line budget notices it, and more
    // bytes than the one read all the selected patches share. Selected, it
    // failed that read and took `small.ts`'s patch with it.
    const { selected, omitted } = selectForPatch(
      [file("dist.min.js", 1, 0, 4_200_000), file("small.ts", 1, 0, 120)],
      { ...limits, maxBytes: 3_000_000 },
    );
    assert.deepEqual(
      selected.map((e) => e.path),
      ["small.ts"],
    );
    assert.deepEqual(
      omitted.map((e) => e.path),
      ["dist.min.js"],
    );
  });

  it("charges the byte budget across files, not per file", () => {
    const { selected, omitted } = selectForPatch(
      [file("a", 1, 0, 599), file("b", 1, 0, 599), file("c", 1, 0, 299)],
      { ...limits, maxBytes: 1_000 },
    );
    assert.deepEqual(
      selected.map((e) => e.path),
      ["a", "c"],
    );
    assert.deepEqual(
      omitted.map((e) => e.path),
      ["b"],
    );
  });

  it("charges a marker for every changed line on top of the content", () => {
    // Two million blank lines are two megabytes of file and four of patch,
    // since each line gains a "+". Charged the file alone it fits and then
    // overflows the read.
    // A line budget this file fits, so only the byte charge can leave it out.
    const { omitted } = selectForPatch([file("blank.txt", 2_000_000, 0, 2_000_000)], {
      ...limits,
      maxLines: 4_000,
      maxBytes: 3_000_000,
    });
    assert.deepEqual(
      omitted.map((e) => e.path),
      ["blank.txt"],
    );
  });

  it("gives no patch to a text file whose size was never read", () => {
    // Its cost is unknown, and the read it would join fails whole.
    const { selected, omitted } = selectForPatch([file("a", 1, 0, null)], limits);
    assert.equal(selected.length, 0);
    assert.deepEqual(
      omitted.map((e) => e.path),
      ["a"],
    );
  });
});

describe("parseLsTreeSizes", () => {
  it("reads padded sizes, keeps a path with a tab whole, and charges a submodule nothing", () => {
    const raw = [
      "100644 blob 1b4b06b233fd658b13575dad591777215d83326e       5\td/sub/we*ird.txt",
      "120000 blob 7937c68fbcf7c484f2d5ce7801944416eedf0d2c       1\tf",
      "100644 blob b21bd8ba4bd872f25b29543ac0db785a0442b8e8 4200000\ttab\there.js",
      "160000 commit 8e9bedec455d8e3f153a17d9c401177a12efec7a       -\tvendor/lib",
      "",
    ].join("\0");
    assert.deepEqual(
      [...parseLsTreeSizes(raw)],
      [
        ["d/sub/we*ird.txt", 5],
        ["f", 1],
        ["tab\there.js", 4_200_000],
        ["vendor/lib", 0],
      ],
    );
  });
});

describe("truncatePatch", () => {
  it("says how much it dropped", () => {
    const cut = truncatePatch("a\nb\nc\nd", 2);
    assert.equal(cut.truncated, true);
    assert.match(cut.text, /2 more lines not shown/);
  });

  it("leaves a patch inside the limit exactly as it was", () => {
    const cut = truncatePatch("a\nb", 2);
    assert.deepEqual(cut, { text: "a\nb", truncated: false });
  });
});

/* ------------------------------------------------------------------ */
/* What the reviewer is shown                                          */
/* ------------------------------------------------------------------ */

describe("diffAsText", () => {
  const diff = (files: RunDiff["files"]): RunDiff => ({
    kind: "range",
    reason: null,
    base: "abc",
    branch: "uf/x-1",
    measuredFrom: null,
    head: "0123456789abcdef0123456789abcdef01234567",
    files,
    filesChanged: files.length,
    added: 0,
    deleted: 0,
    omittedPatches: 0,
    patchFailure: null,
    uncommitted: [],
    caveat: null,
  });

  const file = (path: string, patch: string | null) => ({
    path,
    oldPath: null,
    status: "modified" as const,
    added: 1,
    deleted: 0,
    binary: false,
    patch,
    patchTruncated: false,
  });

  it("names every file it could not include", () => {
    // The whole point. A reviewer handed a third of a change with no marker
    // writes a confident review of a change that did not happen.
    const out = diffAsText(diff([file("a", "+one"), file("b", "+two")]), 20);
    assert.equal(out.truncated, true);
    assert.equal(out.shown, 1);
    assert.match(out.text, /TRUNCATED: 1 of 2/);
    assert.match(out.text, /\bb\b/);
  });

  it("counts a file whose patch was already withheld as missing", () => {
    const out = diffAsText(diff([file("a", "+one"), file("big", null)]), 10_000);
    assert.equal(out.shown, 1);
    assert.equal(out.truncated, true);
    assert.match(out.text, /big/);
  });

  it("says nothing about truncation when everything fits", () => {
    const out = diffAsText(diff([file("a", "+one")]), 10_000);
    assert.equal(out.truncated, false);
    assert.doesNotMatch(out.text, /TRUNCATED/);
  });
});
