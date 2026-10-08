import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  afterFixRun,
  commandVerdict,
  fixRunPrompt,
  nextReviewStep,
  reviewBlockSummary,
  statusVerdict,
} from "./reviewBlock";
import type { RunStatus } from "./orchestrator";

/**
 * What a workflow's review block does with one branch, step by step.
 *
 * Each rule fails silently in a direction that costs: an approval read out of a
 * hedge lands work nobody signed off on; a fix round past the cap is a billed
 * run nobody agreed to; a review that could not run, read as a rejection, marks
 * the operator's tasks as beyond the local model for a reason that had nothing
 * to do with it.
 */

const review = (verdict: string) => ({
  status: "completed" as const,
  text: `## Summary\nIt does the task.\n\n## Verdict\n${verdict}\n`,
  error: null,
});

describe("nextReviewStep", () => {
  it("passes an approved branch on", () => {
    assert.deepEqual(nextReviewStep(review("APPROVE"), 0, 2), { kind: "approve" });
  });

  it("sends a rejection back for the next fix round while rounds are left", () => {
    assert.deepEqual(nextReviewStep(review("REJECT"), 0, 2), { kind: "fix", round: 1 });
    assert.deepEqual(nextReviewStep(review("REJECT"), 1, 2), { kind: "fix", round: 2 });
  });

  it("sets a branch aside and marks its tasks once the last round is used", () => {
    const step = nextReviewStep(review("REJECT"), 2, 2);
    assert.equal(step.kind, "set-aside");
    assert.equal(step.kind === "set-aside" && step.needsFrontier, true);
    assert.match(step.kind === "set-aside" ? step.reason : "", /after 2 fix round/);
  });

  it("never starts a fix round on a block with none", () => {
    const step = nextReviewStep(review("REJECT"), 0, 0);
    assert.equal(step.kind, "set-aside");
  });

  it("reads a hedged verdict as no approval", () => {
    assert.deepEqual(nextReviewStep(review("APPROVE with caveats"), 0, 1), {
      kind: "fix",
      round: 1,
    });
    const last = nextReviewStep(review("looks fine"), 1, 1);
    assert.equal(last.kind, "set-aside");
    assert.match(last.kind === "set-aside" ? last.reason : "", /no clear APPROVE or REJECT/);
  });

  it("sets aside a review that could not run without blaming the model", () => {
    const step = nextReviewStep({ status: "failed", text: null, error: "timed out" }, 0, 2);
    assert.deepEqual(step, {
      kind: "set-aside",
      reason: "the review could not finish: timed out",
      needsFrontier: false,
    });
  });
});

describe("afterFixRun", () => {
  it("reviews a fix that finished or asked for review", () => {
    assert.deepEqual(afterFixRun("completed", 1), { kind: "review" });
    assert.deepEqual(afterFixRun("needs-review", 2), { kind: "review" });
  });

  it("marks the tasks when the model could not manage even the fix", () => {
    assert.deepEqual(afterFixRun("failed", 1), {
      kind: "set-aside",
      reason: "the fix run failed",
      needsFrontier: true,
    });
  });

  it("does not blame the model for a fix a person stopped or that never started", () => {
    for (const [status, iterations] of [["stopped", 1], ["blocked", 0], ["completed", 0]] as const) {
      const step = afterFixRun(status, iterations);
      assert.equal(step.kind, "set-aside", status);
      assert.equal(step.kind === "set-aside" && step.needsFrontier, false, status);
    }
  });
});

/**
 * A review block whose verdict is the run's own status. Silent both ways: a
 * non-completed run approved lands work that asked for review with nobody
 * looking, and a set-aside marked needs-frontier keeps a local pass off a task
 * no model ever judged.
 */
describe("statusVerdict", () => {
  it("approves a run that completed", () => {
    assert.deepEqual(statusVerdict("completed"), { kind: "approve" });
  });

  it("sets every other ending aside by name, and never marks its tasks", () => {
    const endings: RunStatus[] = ["needs-review", "failed", "stopped", "blocked"];
    for (const status of endings) {
      assert.deepEqual(
        statusVerdict(status),
        {
          kind: "set-aside",
          reason: `its run ended ${status} rather than completed`,
          needsFrontier: false,
        },
        status,
      );
    }
    assert.deepEqual(statusVerdict(null), {
      kind: "set-aside",
      reason: "its run has been deleted",
      needsFrontier: false,
    });
  });

  it("approves nothing but completed, whatever status a run could hold", () => {
    // The live ones cannot reach a review block — its links release it only
    // on terminal runs — but a verdict that approved one would be a branch
    // handed to the merge while its run is still writing to it.
    const live: RunStatus[] = ["waiting", "queued", "running", "paused"];
    for (const status of live) {
      assert.equal(statusVerdict(status).kind, "set-aside", status);
    }
  });
});

/**
 * A review block whose verdict is a verify command saved on it. Silent both
 * ways: anything but a pass read as one hands the merge a branch nothing
 * checked — a timeout and a command that never ran are the two that look most
 * like one — and a failure that drops its output sets a branch aside with
 * nothing on the page saying what failed.
 */
describe("commandVerdict", () => {
  const ran = { ran: true, passed: false, reason: "Land's sentence, never shown here." };

  it("approves only a pass", () => {
    assert.deepEqual(commandVerdict({ ...ran, passed: true, ending: "", tail: "ok" }), {
      kind: "approve",
    });
  });

  it("sets aside the pass `landVerdict` gives a blank command, which never ran", () => {
    // Unconfigured is a pass at Land — no gate was asked for. Here it would be
    // a branch handed on with nothing run against it.
    assert.deepEqual(commandVerdict({ ran: false, passed: true, ending: "", tail: "", reason: "" }), {
      kind: "set-aside",
      reason: "it could not be verified: the block has no verify command to run",
      needsFrontier: false,
    });
  });

  it("sets a failing command aside with how it ended, and its output on the lines after", () => {
    assert.deepEqual(
      commandVerdict({ ...ran, ending: "exited 1", tail: "  2 tests failed\nsee above  " }),
      {
        kind: "set-aside",
        reason: "its verify command exited 1\n2 tests failed\nsee above",
        needsFrontier: false,
      },
    );
    assert.deepEqual(commandVerdict({ ...ran, ending: "was killed by SIGTERM", tail: "boom" }), {
      kind: "set-aside",
      reason: "its verify command was killed by SIGTERM\nboom",
      needsFrontier: false,
    });
  });

  it("sets a timeout aside the same way, carrying what it printed before it was killed", () => {
    const verdict = commandVerdict({
      ...ran,
      ending: "did not finish in time and was killed after 15 minutes",
      tail: "running 412 tests",
    });
    assert.deepEqual(verdict, {
      kind: "set-aside",
      reason:
        "its verify command did not finish in time and was killed after 15 minutes\nrunning 412 tests",
      needsFrontier: false,
    });
  });

  it("says so when the command printed nothing, rather than leaving a bare ending", () => {
    assert.deepEqual(commandVerdict({ ...ran, ending: "exited 2", tail: "" }), {
      kind: "set-aside",
      reason: "its verify command exited 2, and printed nothing",
      needsFrontier: false,
    });
  });

  it("sets aside a command that never ran, with why, rather than reading it as a pass", () => {
    assert.deepEqual(
      commandVerdict({
        ran: false,
        passed: false,
        ending: "",
        tail: "",
        reason: "A verify command is configured, but /w/slot no longer holds uf/x.",
      }),
      {
        kind: "set-aside",
        reason: "it could not be verified: A verify command is configured, but /w/slot no longer holds uf/x.",
        needsFrontier: false,
      },
    );
  });
});

describe("fixRunPrompt and reviewBlockSummary", () => {
  it("keeps the original brief first and the review under its own heading", () => {
    const prompt = fixRunPrompt("Do the task.", "## Risks\nThe default hides a bug.", 1, 2);
    assert.ok(prompt.startsWith("Do the task."));
    assert.match(prompt, /fix round 1 of 2/);
    assert.match(prompt, /<review>\n## Risks\nThe default hides a bug.\n<\/review>$/);
  });

  it("names every branch it set aside and why", () => {
    assert.equal(reviewBlockSummary([]), "There was no branch to review.");
    assert.equal(
      reviewBlockSummary([{ branch: "a", status: "approved", note: null }]),
      "Approved all 1 branch(es).",
    );
    assert.equal(
      reviewBlockSummary([
        { branch: "a", status: "approved", note: null },
        { branch: "b", status: "set-aside", note: "still rejected after 2 fix round(s)" },
      ]),
      "Approved 1 of 2 branch(es); set aside b — still rejected after 2 fix round(s).",
    );
  });

  it("names a set-aside branch by its note's first line, leaving a command's output to its row", () => {
    // A verify command's tail is up to `VERIFY_TAIL_BYTES` a branch; carried
    // into the block's one-paragraph note it buries the count it is there for.
    assert.equal(
      reviewBlockSummary([
        { branch: "a", status: "set-aside", note: "its verify command exited 1\nFAIL x.test.ts\n1 failed" },
      ]),
      "Approved 0 of 1 branch(es); set aside a — its verify command exited 1.",
    );
  });
});
