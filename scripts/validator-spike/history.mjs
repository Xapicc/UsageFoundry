#!/usr/bin/env node
// The "already on main" measurement for the commits-in-history evidence
// (`src/lib/validationHistory.ts`, board task 17be140e).
//
// The 40 cases in cases/ measure the spike's prompt on a branch's own diff. The
// evidence added here only ever appears beside an EMPTY diff, so those 40 are
// unaffected by construction (a unit test pins that a prompt with no history is
// byte-identical to what it was). What needs a measurement is the new input, and
// there are two ways to get it wrong that point in opposite directions:
//
//   - not recognise work that is in the history  -> the incident (a false
//     not-finished that strands a done task), and
//   - take "a commit exists for this task" for "the task is done" -> a false
//     finished, the error the validator exists to prevent.
//
// So three arms, all built from the same seven labelled-`finished` single-commit
// cases whose whole diff was kept (the filter is label-independent of the verdict):
//
//   today     empty diff, no history. What the judge sees now for a task whose
//             work reached the branch another way. Expected answer: finished,
//             because the work is in the history; the judge cannot know.
//   match     empty diff + the case's own diff as history. Expected: finished.
//   mismatch  empty diff + ANOTHER case's diff as history, which is what a
//             trailer proves and no more (a run holding two tasks stamps both
//             ids on every commit). Expected: not-finished. Four of the seven
//             pairs are near misses, two `chat.ts` fixes for different faults.
//   mismatchB the same with a second pairing (two more near misses).
//
// The request is composed by the production `buildValidationPrompt`, from a
// compiled build, so what is measured is the string that ships and not a copy of
// it. Its preamble is NOT prompt.md's: validation.ts routes unsupported doubt to
// `unjudgeable`, where prompt.md says "be suspicious", so these numbers are about
// the production string and do not extend RESULT.md's.
//
// Usage:
//   npx tsc -p tsconfig.test.json --outDir .test-build/spike
//   node scripts/validator-spike/history.mjs --emit    --io-dir <dir> [--build-dir .test-build/spike]
//   (answer each <dir>/<name>.request.md into <dir>/<name>.response.md)
//   node scripts/validator-spike/history.mjs --collect --io-dir <dir> [--out report.md]

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { arg, parseVerdict } from "./validate.mjs";

const HERE = import.meta.dirname;
const CASES = path.join(HERE, "cases");

/** task case -> case whose diff is shown as its history, for the mismatch arm. */
const SOURCES = [3, 4, 5, 11, 13, 30, 35];
const MISMATCH = { 3: 4, 4: 5, 5: 35, 11: 13, 13: 30, 30: 3, 35: 5 };
/** A second pairing, so the false-finished count rests on 14 pairs and not 7. */
const MISMATCH_B = { 3: 35, 4: 3, 5: 4, 11: 30, 13: 11, 30: 13, 35: 30 };

const EXPECTED = { today: "finished", match: "finished", mismatch: "not-finished", mismatchB: "not-finished" };

const loadCase = (n) => {
  const file = fs.readdirSync(CASES).find((f) => f.startsWith(String(n).padStart(2, "0") + "-"));
  return JSON.parse(fs.readFileSync(path.join(CASES, file), "utf8"));
};

/**
 * The history block's body in the shape `validationHistory.ts` writes it: a
 * heading, the counts, then each file as `--- path ---` and its patch (what
 * `diffAsText` renders). The cases keep one `git diff` text, so it is split on
 * its `diff --git` headers; a single-commit case is the same bytes either way.
 */
function historyOf(c) {
  const [commit] = c.commits;
  const patches = c.diff.text.split(/^(?=diff --git )/m).filter(Boolean);
  const files = patches.map((p) => {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(p);
    return `\n--- ${m ? m[2] : "?"} ---\n${p.trimEnd()}\n`;
  });
  const stat = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(c.diff.stat);
  return {
    commits: [{ sha: commit.sha, subject: commit.subject }],
    text: [
      `### ${commit.sha.slice(0, 8)}  ${commit.subject}`,
      `${stat?.[1] ?? files.length} file(s) changed, +${stat?.[2] ?? 0} −${stat?.[3] ?? 0}.`,
      files.join(""),
    ].join("\n"),
    truncated: false,
  };
}

function requests(buildDir) {
  // The compiled module reaches db.ts and config.ts at load, which want a data dir.
  process.env.DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "uf-history-spike-"));
  process.env.CLAUDE_BIN ??= "/nonexistent";
  const { buildValidationPrompt } = createRequire(import.meta.url)(
    path.resolve(buildDir, "lib/validation.js"),
  );
  const emptyDiff = {
    kind: "range", reason: null, base: "base", branch: "uf/spike", measuredFrom: null, head: "0".repeat(40),
    files: [], filesChanged: 0, added: 0, deleted: 0, omittedPatches: 0, patchFailure: null, uncommitted: [], caveat: null,
  };
  const out = [];
  for (const n of SOURCES) {
    const c = loadCase(n);
    // `runs.task` is the composed prompt, which is what the spike always judged;
    // the board's title/brief split does not exist for these rows.
    const task = {
      id: `spike-${n}`, title: "(the run's task, as the spike recovered it)", body: c.task, status: "claimed",
      priority: "normal", origin: "operator", mountId: "m", folder: "/w", createdByRunId: null, claimedByRunId: "r",
      claimedByOperator: false, completedByRunId: null, parentTaskId: null, operatorOnly: false, needsFrontier: false,
      createdAt: 1, updatedAt: 2, closedAt: null,
    };
    const arms = {
      today: null,
      match: historyOf(c),
      mismatch: historyOf(loadCase(MISMATCH[n])),
      mismatchB: historyOf(loadCase(MISMATCH_B[n])),
    };
    for (const [arm, history] of Object.entries(arms)) {
      out.push({
        name: `${arm}-${String(n).padStart(2, "0")}`, arm, n, historyFrom: arm === "mismatch" ? MISMATCH[n] : arm === "mismatchB" ? MISMATCH_B[n] : arm === "match" ? n : null,
        prompt: buildValidationPrompt({ task, runPrompt: null, diff: emptyDiff, diffText: "", truncated: false, history }),
      });
    }
  }
  return out;
}

function emit(ioDir, buildDir) {
  fs.mkdirSync(ioDir, { recursive: true });
  const all = requests(buildDir);
  for (const r of all) fs.writeFileSync(path.join(ioDir, `${r.name}.request.md`), r.prompt);
  fs.writeFileSync(
    path.join(ioDir, "manifest.json"),
    JSON.stringify(all.map(({ prompt, ...rest }) => ({ ...rest, bytes: prompt.length, expected: EXPECTED[rest.arm] })), null, 2),
  );
  console.log(`wrote ${all.length} requests to ${ioDir}`);
}

function collect(ioDir, out) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ioDir, "manifest.json"), "utf8"));
  const rows = manifest.map((m) => {
    const file = path.join(ioDir, `${m.name}.response.md`);
    const parsed = fs.existsSync(file) ? parseVerdict(fs.readFileSync(file, "utf8")) : null;
    return { ...m, got: parsed?.verdict ?? (fs.existsSync(file) ? "unparsed" : "missing"), reason: parsed?.reason ?? "" };
  });
  const lines = ["# Commits-in-history arms", "", "| arm | n | finished | not-finished | unjudgeable | other | as expected |", "|---|---|---|---|---|---|---|"];
  for (const arm of Object.keys(EXPECTED)) {
    const r = rows.filter((x) => x.arm === arm);
    const count = (v) => r.filter((x) => x.got === v).length;
    const other = r.length - count("finished") - count("not-finished") - count("unjudgeable");
    lines.push(`| ${arm} | ${r.length} | ${count("finished")} | ${count("not-finished")} | ${count("unjudgeable")} | ${other} | ${count(EXPECTED[arm])}/${r.length} |`);
  }
  const wrong = rows.filter((x) => x.arm.startsWith("mismatch"));
  const falseFinished = wrong.filter((x) => x.got === "finished");
  lines.push("", `False-finished (a mismatch arm answered finished): **${falseFinished.length} of ${wrong.length}**`, "", "| request | history from | expected | got | reason |", "|---|---|---|---|---|");
  for (const x of rows) lines.push(`| ${x.name} | ${x.historyFrom ?? "-"} | ${x.expected} | ${x.got} | ${x.reason.replace(/\|/g, "/")} |`);
  const text = lines.join("\n") + "\n";
  if (out) fs.writeFileSync(out, text);
  console.log(text);
}

const argv = process.argv.slice(2);
const ioDir = arg(argv, "--io-dir", path.join(HERE, "io-history"));
if (argv.includes("--emit")) emit(ioDir, arg(argv, "--build-dir", ".test-build/spike"));
else if (argv.includes("--collect")) collect(ioDir, arg(argv, "--out", null));
else {
  console.error("usage: history.mjs --emit|--collect --io-dir <dir> [--build-dir <dir>] [--out <file>]");
  process.exit(2);
}
