import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { landVerdict, parseVerifyCommand, runVerify, verifyEnv } from "./landGate";
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
 * WHAT THE CHECK CAN READ, which nothing else in this app would report.
 *
 * The spawn used to pass no `env` at all, so the child took `process.env`
 * whole. Nothing about that was visible: the gate ran, the exit code meant what
 * it always meant, and the only thing that changed was that a command whose
 * script body lives in the tree an agent just wrote could read this app's
 * master token. These are the four names the shared strip exists for, and they
 * are asserted on the same grounds as `childEnv`'s four describes — no page, no
 * log and no other test would notice if one came back.
 *
 * The planted values are set on this process rather than passed in, for the
 * reason those describes give: reading `process.env` is the whole of what the
 * builder does.
 */
describe("verifyEnv — what a command an agent's tree defines may read", () => {
  const planted = {
    UF_AUTH_TOKEN: "master-token-that-opens-every-run",
    ANTHROPIC_ADMIN_KEY: "sk-ant-admin-that-nothing-here-bills-against",
    DATA_DIR: "/data",
    __NEXT_PRIVATE_STANDALONE_CONFIG: JSON.stringify({
      output: "standalone",
      outputFileTracingRoot: "/app",
    }),
  };
  const previous = Object.fromEntries(
    Object.keys(planted).map((k) => [k, process.env[k]]),
  );
  after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("withholds the app's own credentials and DATA_DIR from the verify child", () => {
    for (const [k, v] of Object.entries(planted)) process.env[k] = v;
    const env = verifyEnv();
    for (const [k, v] of Object.entries(planted)) {
      assert.equal(env[k], undefined, `${k} reached the verify command`);
      for (const [key, value] of Object.entries(env)) {
        assert.equal(
          value?.includes(v),
          false,
          `${key} carries ${k}'s value under another name`,
        );
      }
    }
  });

  it("passes PATH through, because the command is resolved on it", () => {
    // The strip is three prefixes and six names and PATH is in none of them.
    // A copy that took it would not fail visibly — it would refuse every land
    // with "could not start", which reads as the operator's command being
    // wrong. The assertion is over a *planted* directory rather than equality
    // alone, for the reason `childEnv`'s is: what
    // `proposals/CustomStacks/01c-reach-and-permission.md` §2 claims is that a
    // directory added to this server's PATH arrives, in the position it was
    // added at.
    const before = process.env.PATH;
    const TOOLBOX = "/var/lib/uf-stacks/bin";
    try {
      process.env.PATH = `${TOOLBOX}:${before ?? "/usr/bin"}`;
      const env = verifyEnv();
      assert.equal(env.PATH, process.env.PATH);
      assert.equal(
        env.PATH?.split(path.delimiter)[0],
        TOOLBOX,
        "a directory prepended to the server's PATH did not reach the verify child first",
      );
    } finally {
      if (before === undefined) delete process.env.PATH;
      else process.env.PATH = before;
    }
  });
});

/**
 * And the same question asked of the child rather than of the builder.
 *
 * `verifyEnv` above is a pure function, so every assertion in it still holds if
 * the `env:` option is dropped from the spawn — which is precisely the defect
 * that was there. This one runs the gate for real and lets the child report its
 * own environment, so the two halves cannot drift apart silently.
 *
 * It is the only subprocess in this file and it costs one `node` start. The
 * script is written to a temp file rather than passed with `-e` because
 * `parseVerifyCommand` refuses every shell metacharacter, quotes included.
 */
describe("runVerify hands the child that environment and not this process's", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uf-landgate-env-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const previous = {
    UF_AUTH_TOKEN: process.env.UF_AUTH_TOKEN,
    DATA_DIR: process.env.DATA_DIR,
  };
  after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("exits 0 only because the stripped names are absent and PATH is not", async () => {
    process.env.UF_AUTH_TOKEN = "master-token-that-opens-every-run";
    process.env.DATA_DIR = "/data";

    // Exits non-zero, and says which name, if the child can see any of them —
    // so a regression arrives as a named failure rather than as a missing
    // assertion. PATH is checked in the same breath: a strip that took it
    // would otherwise look identical to one that works.
    const probe = path.join(dir, "probe.cjs");
    fs.writeFileSync(
      probe,
      [
        "const leaked = ['UF_AUTH_TOKEN', 'ANTHROPIC_ADMIN_KEY', 'DATA_DIR',",
        "  '__NEXT_PRIVATE_STANDALONE_CONFIG'].filter((k) => process.env[k]);",
        "if (leaked.length) { console.log('leaked ' + leaked.join(',')); process.exit(1); }",
        "if (!process.env.PATH) { console.log('no PATH'); process.exit(2); }",
        "process.exit(0);",
      ].join("\n"),
    );

    const outcome = await runVerify(dir, `${process.execPath} ${probe}`);
    assert.equal(outcome.ran, true);
    assert.equal(outcome.passed, true, outcome.reason);
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
