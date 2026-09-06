import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { landVerdict, parseVerifyCommand } from "./landGate";
import { verifyTreeVerdict } from "./land";

/**
 * The gate in front of Land, and the two ways it could fail quietly.
 *
 * Both halves decide whether somebody's work merges, and both fail silently if
 * they are wrong: a parser that dropped a metacharacter would run a different
 * command from the one the operator read back in Settings, and a verdict that
 * treated "could not run" as "passed" would hand back an open door to an
 * operator who had asked for a gate. Neither throws, neither fails to
 * typecheck, and the button looks the same.
 *
 * So these assert the enumeration in BOTH directions — the shapes that must be
 * refused and the shapes that must be allowed — because a refusal that admits
 * everything measures nothing and one that refuses everything is not a feature.
 */
describe("parseVerifyCommand takes argv and refuses a shell line", () => {
  it("splits an ordinary command into argv", () => {
    assert.deepEqual(parseVerifyCommand("npm test"), { ok: true, argv: ["npm", "test"] });
    assert.deepEqual(parseVerifyCommand("  npx  tsc --noEmit "), {
      ok: true,
      argv: ["npx", "tsc", "--noEmit"],
    });
  });

  it("treats an empty command as unconfigured rather than as a pass", () => {
    for (const raw of ["", "   ", "\t"]) {
      const parsed = parseVerifyCommand(raw);
      assert.equal(parsed.ok, false);
      assert.match(parsed.ok === false ? parsed.reason : "", /no verify command/);
    }
  });

  it("refuses every shell metacharacter rather than escaping it", () => {
    // One per character class that changes what runs. `a && b` is the honest
    // case — an operator wanting it is asking for a shell — and the backtick
    // one is the reason refusing beats escaping: a repository whose name
    // carries it would otherwise be executed.
    for (const raw of [
      "npm test && npm run build",
      "npm test; rm -rf /",
      "echo `whoami`",
      "npm test | tee out",
      "npm test > out",
      "sh -c $(cat cmd)",
      "npm test\nrm -rf /",
    ]) {
      const parsed = parseVerifyCommand(raw);
      assert.equal(parsed.ok, false, `should have refused: ${raw}`);
      assert.match(parsed.ok === false ? parsed.reason : "", /argv, never a shell/);
    }
  });
});

describe("landVerdict never turns 'could not check' into 'passed'", () => {
  const parsed = parseVerifyCommand("npm test");

  it("is a pass, and did not run, when nothing is configured", () => {
    const v = landVerdict({
      configured: false,
      parse: parseVerifyCommand(""),
      exitCode: null,
      timedOut: false,
      tail: "",
    });
    assert.deepEqual(v, { ran: false, passed: true, reason: "" });
  });

  it("passes on exit 0", () => {
    const v = landVerdict({ configured: true, parse: parsed, exitCode: 0, timedOut: false, tail: "" });
    assert.equal(v.passed, true);
    assert.equal(v.ran, true);
  });

  it("refuses on a non-zero exit and carries the output", () => {
    const v = landVerdict({
      configured: true,
      parse: parsed,
      exitCode: 1,
      timedOut: false,
      tail: "2 tests failed",
    });
    assert.equal(v.passed, false);
    assert.match(v.reason, /exited 1/);
    assert.match(v.reason, /2 tests failed/);
  });

  it("refuses a timeout rather than guessing", () => {
    const v = landVerdict({ configured: true, parse: parsed, exitCode: null, timedOut: true, tail: "" });
    assert.equal(v.passed, false);
    assert.match(v.reason, /did not finish in time/);
  });

  it("refuses a command it could not parse — the door does not open on a typo", () => {
    // The case that decides whether this module is worth having. An operator
    // configured a gate; their string was malformed; the answer is not to land.
    const v = landVerdict({
      configured: true,
      parse: parseVerifyCommand("npm test && npm run build"),
      exitCode: null,
      timedOut: false,
      tail: "",
    });
    assert.equal(v.passed, false);
    assert.match(v.reason, /not runnable/);
  });
});

/**
 * WHICH TREE THE CHECK RUNS IN, which is the whole of whether it checks
 * anything.
 *
 * The first version of the gate handed `runVerify` the operator's checkout —
 * `state.checkout.path` — which `landRefusal` has already required to be clean
 * and standing on the *target*. The command therefore ran against the branch
 * the work was about to be merged into and never saw the work: it passed or
 * failed identically whatever the agent had written, and nothing on either side
 * could tell. A gate set to `/bin/false` still refused; one set to `/bin/true`
 * still allowed. That is the failure these pin, and no subprocess-driven test
 * can catch it, because the subprocess behaves the same in either tree.
 */
describe("verifyTreeVerdict answers the run's own tree or refuses", () => {
  it("answers the run's slot while it still holds the run's branch", () => {
    assert.deepEqual(
      verifyTreeVerdict({
        slotPath: "/workspace/.uf-worktrees/acme-1",
        checkedOutBranch: "uf/task-a",
        runBranch: "uf/task-a",
      }),
      { ok: true, path: "/workspace/.uf-worktrees/acme-1" },
    );
  });

  it("refuses when a later run has taken the slot over", () => {
    // The expensive wrong answer is falling back to the operator's checkout,
    // which is clean and on the target and would sail through any check that
    // the target itself passes.
    const v = verifyTreeVerdict({
      slotPath: "/workspace/.uf-worktrees/acme-1",
      checkedOutBranch: "uf/task-b",
      runBranch: "uf/task-a",
    });
    assert.equal(v.ok, false);
    assert.match(v.ok ? "" : v.reason, /no longer holds uf\/task-a/);
    assert.match(v.ok ? "" : v.reason, /Nothing was landed/);
  });

  it("refuses when the run never had a checkout", () => {
    const v = verifyTreeVerdict({
      slotPath: null,
      checkedOutBranch: null,
      runBranch: "uf/task-a",
    });
    assert.equal(v.ok, false);
    assert.match(v.ok ? "" : v.reason, /no checkout of its own/);
  });

  it("refuses a detached slot rather than reading null as a match", () => {
    // `slotState` answers null for a detached HEAD and for a `rev-parse` that
    // failed. A comparison written as `!==` against a null run branch would
    // make those two nulls agree and hand back a tree holding no known branch.
    const v = verifyTreeVerdict({
      slotPath: "/workspace/.uf-worktrees/acme-1",
      checkedOutBranch: null,
      runBranch: null,
    });
    assert.equal(v.ok, false);
  });
});
