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
// A second family, `--arms split` (board task 813c54f5), asks the other half of
// the same question: a task worked across two runs, where the later run commits
// only its half and the earlier commits are in the history. The branch diff is
// non-empty there, so `historyEvidence` frames it with its second opening ("the
// diff above is this branch's own, and it may be only part of the work") and not
// the first ("the branch's own diff above is empty"). The 27 requests judged on
// 2026-11-08 were composed with that text appended by this script before it moved
// into src/lib/validation.ts; they compared byte-identical with what the shipped
// `buildValidationPrompt` composes, which is what this now calls. Built from real
// commits of multi-commit `finished` cases, read from the repositories the cases
// were reconstructed from:
//
//   splitToday      the later commits' diff alone. What the judge sees today.
//                   Truth: finished (the whole branch is).
//   splitHistory    the same diff + the earlier commits as history. Truth: finished.
//   splitMismatch   the same diff + ANOTHER case's earlier commits, two pairings.
//                   Truth: not-finished.
//   splitPartial    a diff that skips the middle commits, with only the first
//                   commits as history, so a named deliverable is in neither.
//                   Truth: not-finished.
//
// The request is composed by the production `buildValidationPrompt`, from a
// compiled build, so what is measured is the string that ships and not a copy of
// it. Its preamble is NOT prompt.md's: validation.ts routes unsupported doubt to
// `unjudgeable`, where prompt.md says "be suspicious", so these numbers are about
// the production string and do not extend RESULT.md's.
//
// Usage:
//   npx tsc -p tsconfig.test.json --outDir .test-build/spike
//   node scripts/validator-spike/history.mjs --emit    --io-dir <dir> [--build-dir .test-build/spike] [--arms split]
//   (answer each <dir>/<name>.request.md into <dir>/<name>.response.md)
//   node scripts/validator-spike/history.mjs --collect --io-dir <dir> [--out report.md]

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { arg, parseVerdict } from "./validate.mjs";
import { diffFor, loadProduction, splitPatches, taskOf } from "./shippedPrompt.mjs";

const HERE = import.meta.dirname;
const CASES = path.join(HERE, "cases");

/** task case -> case whose diff is shown as its history, for the mismatch arm. */
const SOURCES = [3, 4, 5, 11, 13, 30, 35];
const MISMATCH = { 3: 4, 4: 5, 5: 35, 11: 13, 13: 30, 30: 3, 35: 5 };
/** A second pairing, so the false-finished count rests on 14 pairs and not 7. */
const MISMATCH_B = { 3: 35, 4: 3, 5: 4, 11: 30, 13: 11, 30: 13, 35: 30 };

const EXPECTED = {
  today: "finished", match: "finished", mismatch: "not-finished", mismatchB: "not-finished",
  splitToday: "finished", splitHistory: "finished", splitMismatch: "not-finished", splitMismatchB: "not-finished",
  splitPartial: "not-finished",
};

/**
 * Multi-commit cases the spike labelled `finished` and the shipped preamble
 * also called `finished` on the whole branch (RESULT.md), so the whole branch is
 * a settled `finished` and the half shown is the only variable. `k` is the
 * first commit of the later half: commits before it are the earlier run's, and
 * there are at most `HISTORY_COMMITS_SHOWN` of them so the cap drops none.
 * `partial` shows only `history` as history and `diff` as the diff, skipping the
 * commits between, which carry deliverables the task names.
 */
const SPLITS = {
  12: { k: 3, partial: { history: [0], diff: [3] } },
  16: { k: 1 },
  17: { k: 1 },
  25: { k: 5, partial: { history: [0, 1, 2], diff: [10, 11, 12, 13] } },
  33: { k: 2, partial: { history: [0], diff: [2] } },
  37: { k: 1 },
};
/** task case -> case whose earlier commits are shown as its history, for the mismatch arms. */
const SPLIT_MISMATCH = { 12: 16, 16: 37, 17: 16, 25: 33, 33: 25, 37: 17 };
const SPLIT_MISMATCH_B = { 12: 37, 16: 12, 17: 37, 25: 17, 33: 12, 37: 16 };
/** `VALIDATION_DIFF_BYTES` in validation.ts, which is not exported. */
const BUDGET_BYTES = 60_000;

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

/** `git` with the agent shell's GIT_* overrides removed, which outrank repo config. */
function gitIn(repo, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  return execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** The history block `alreadyDeliveredFor` would build for these commits (oldest first): newest first, the cap, the shared byte budget. */
async function historyFor(prod, repo, commits) {
  const newestFirst = [...commits].reverse();
  let remaining = BUDGET_BYTES;
  let truncated = newestFirst.length > prod.HISTORY_COMMITS_SHOWN;
  const shown = [];
  const parts = [];
  for (const commit of newestFirst.slice(0, prod.HISTORY_COMMITS_SHOWN)) {
    const diff = await prod.wholeCommitDiff(repo, commit.sha);
    if (!diff) continue;
    const { text, truncated: cut } = prod.diffAsText(diff, Math.max(remaining, 0));
    remaining -= text.length;
    if (cut) truncated = true;
    shown.push(commit);
    parts.push([`### ${commit.sha.slice(0, 8)}  ${commit.subject}`, `${diff.filesChanged} file(s) changed, +${diff.added} −${diff.deleted}.`, text].join("\n"));
  }
  return { commits: shown, text: parts.join("\n"), truncated };
}

async function splitRequests(buildDir) {
  for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];
  const prod = loadProduction(buildDir);
  /** The branch diff for commits `from..to` of a case, as the server would have built it. */
  const diffOf = (c, commits) => {
    const patch = gitIn(c.repo, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", `${commits[0].sha}^`, commits.at(-1).sha]);
    return diffFor({
      diffAsText: prod.diffAsText, branch: c.branch, patches: splitPatches(patch),
      maxBytes: BUDGET_BYTES, cutPatch: prod.truncatePatch,
    });
  };
  const earlierOf = (n) => loadCase(n).commits.slice(0, SPLITS[n].k);
  const out = [];
  for (const [nStr, split] of Object.entries(SPLITS)) {
    const n = Number(nStr);
    const c = loadCase(n);
    const task = taskOf(c);
    const later = c.commits.slice(split.k);
    const arms = [
      ["splitToday", later, null, null],
      ["splitHistory", later, c.commits.slice(0, split.k), n],
      ["splitMismatch", later, loadCase(SPLIT_MISMATCH[n]).commits.slice(0, SPLITS[SPLIT_MISMATCH[n]].k), SPLIT_MISMATCH[n]],
      ["splitMismatchB", later, loadCase(SPLIT_MISMATCH_B[n]).commits.slice(0, SPLITS[SPLIT_MISMATCH_B[n]].k), SPLIT_MISMATCH_B[n]],
    ];
    if (split.partial) {
      arms.push(["splitPartial", split.partial.diff.map((i) => c.commits[i]), split.partial.history.map((i) => c.commits[i]), n]);
    }
    for (const [arm, diffCommits, historyCommits, from] of arms) {
      const repoOfHistory = from === null ? null : loadCase(from).repo;
      const { diff, diffText, truncated } = diffOf(c, diffCommits);
      const history = historyCommits ? await historyFor(prod, repoOfHistory, historyCommits) : null;

      out.push({
        name: `${arm}-${String(n).padStart(2, "0")}`, arm, n, historyFrom: from,
        diffCommits: diffCommits.map((x) => x.sha.slice(0, 8)),
        historyCommits: history ? history.commits.map((x) => x.sha.slice(0, 8)) : [],
        historyTruncated: history ? history.truncated : null, diffTruncated: truncated,
        prompt: prod.buildValidationPrompt({ task, runPrompt: null, diff, diffText, truncated, history }),
      });
    }
  }
  return out;
}

async function emit(ioDir, buildDir, arms) {
  fs.mkdirSync(ioDir, { recursive: true });
  const all = arms === "split" ? await splitRequests(buildDir) : requests(buildDir);
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
    if (r.length === 0) continue;
    const count = (v) => r.filter((x) => x.got === v).length;
    const other = r.length - count("finished") - count("not-finished") - count("unjudgeable");
    lines.push(`| ${arm} | ${r.length} | ${count("finished")} | ${count("not-finished")} | ${count("unjudgeable")} | ${other} | ${count(EXPECTED[arm])}/${r.length} |`);
  }
  const wrong = rows.filter((x) => EXPECTED[x.arm] === "not-finished");
  const falseFinished = wrong.filter((x) => x.got === "finished");
  lines.push("", `False-finished (an arm whose truth is not-finished answered finished): **${falseFinished.length} of ${wrong.length}**`, "", "| request | history from | expected | got | reason |", "|---|---|---|---|---|");
  for (const x of rows) lines.push(`| ${x.name} | ${x.historyFrom ?? "-"} | ${x.expected} | ${x.got} | ${x.reason.replace(/\|/g, "/")} |`);
  const text = lines.join("\n") + "\n";
  if (out) fs.writeFileSync(out, text);
  console.log(text);
}

const argv = process.argv.slice(2);
const ioDir = arg(argv, "--io-dir", path.join(HERE, "io-history"));
if (argv.includes("--emit")) await emit(ioDir, arg(argv, "--build-dir", ".test-build/spike"), arg(argv, "--arms", "empty"));
else if (argv.includes("--collect")) collect(ioDir, arg(argv, "--out", null));
else {
  console.error("usage: history.mjs --emit|--collect --io-dir <dir> [--build-dir <dir>] [--arms empty|split] [--out <file>]");
  process.exit(2);
}
