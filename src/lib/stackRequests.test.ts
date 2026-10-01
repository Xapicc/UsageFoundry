import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { StackReceipt } from "./stacks";

/**
 * What a run's request for a stack may say, and what the receipts make of it.
 *
 * Two decisions here are silent when wrong, and both are the run's to suffer.
 * `normalizeStackRequest` is the door for model output that ends up printed in
 * a path an operator is told to create — a name that is not a plain command
 * name is a shell line dressed as a directory. `decideStackWait` is the
 * release: resume too early and the run's next cycle meets the same missing
 * binary; never resume and a run waits for ever on a stack that is installed.
 * `stackSatisfaction` sits under both it and `request_stack`'s "already
 * installed", and the case that earns it is that the two must agree — a request
 * the tool files and the release then treats as answered is a run that parks
 * and resumes in a loop with nothing installed.
 *
 * The dedup cases open the database: one pending request per name is what
 * makes the operator answer once for every run that asked.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-stack-requests-")));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
delete process.env.WORKSPACE_ROOTS;
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to " +
    "run against the real database",
);

const {
  MAX_STACK_WAITS_PER_RUN,
  checkStackDraft,
  decideStackWait,
  declineStackRequest,
  normalizeStackRequest,
  recordStackRequest,
  stackRequest,
  stackResumeNotice,
  stackSatisfaction,
  stackWaitOf,
} = require("./stackRequests") as typeof import("./stackRequests");
const { db } = require("./db") as typeof import("./db");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function receipt(name: string, status: StackReceipt["status"], bins: string[]): StackReceipt {
  return {
    name,
    digest: "0".repeat(64),
    status,
    appliedAt: null,
    summary: "",
    bin: bins.map((bin) => ({ name: bin, path: `/var/lib/uf-stacks/bin/${bin}` })),
    deny: [],
    env: {},
    state: [],
    steps: [],
    error: status === "ok" ? null : { text: `stack ${name}: the download failed\nstderr`, bytes: 30 },
  };
}

const valid = { name: "rust", binaries: ["cargo", "rustc"], reason: "The task builds a crate." };

describe("what request_stack accepts", () => {
  it("accepts a plain request, and folds a repeated binary into one", () => {
    const checked = normalizeStackRequest({ ...valid, binaries: ["cargo", "rustc", "cargo"] });
    assert.deepEqual(checked, {
      ok: true,
      value: { name: "rust", binaries: ["cargo", "rustc"], reason: "The task builds a crate.", draft: null },
    });
  });

  it("refuses a name that is not a plain directory name", () => {
    // Each of these is printed inside `./stacks/<name>/stack.json` on a page an
    // operator copies from. The applier itself would take most of them as a
    // directory, which is why the rule here is the stricter `bin.as` one.
    for (const name of [
      "rust; rm -rf ~",
      "../etc",
      "a/b",
      "a b",
      " rust",
      "rust ",
      ".hidden",
      "-flag",
      "$(id)",
      "x".repeat(65),
      "",
    ]) {
      const checked = normalizeStackRequest({ ...valid, name });
      assert.equal(checked.ok, false, JSON.stringify(name));
    }
    assert.equal(normalizeStackRequest({ ...valid, name: 7 }).ok, false);
  });

  it("refuses binaries that are missing, empty, or not plain command names", () => {
    for (const binaries of [undefined, [], ["cargo build"], ["bin/cargo"], [""], [3], "cargo"]) {
      assert.equal(normalizeStackRequest({ ...valid, binaries }).ok, false, JSON.stringify(binaries));
    }
    const many = Array.from({ length: 17 }, (_, i) => `tool${i}`);
    assert.equal(normalizeStackRequest({ ...valid, binaries: many }).ok, false);
  });

  it("requires a reason and bounds it, rather than clipping it into a different one", () => {
    assert.equal(normalizeStackRequest({ ...valid, reason: "   " }).ok, false);
    assert.equal(normalizeStackRequest({ ...valid, reason: undefined }).ok, false);
    assert.equal(normalizeStackRequest({ ...valid, reason: "x".repeat(601) }).ok, false);
  });

  it("keeps a draft as the bytes the operator will read, and bounds it", () => {
    const object = normalizeStackRequest({ ...valid, draft: { schema: 1, name: "rust" } });
    assert.ok(object.ok);
    assert.equal(object.value.draft, JSON.stringify({ schema: 1, name: "rust" }, null, 2));

    const blank = normalizeStackRequest({ ...valid, draft: "  \n" });
    assert.ok(blank.ok);
    assert.equal(blank.value.draft, null);

    assert.equal(normalizeStackRequest({ ...valid, draft: "x".repeat(16 * 1024 + 1) }).ok, false);
    assert.equal(normalizeStackRequest({ ...valid, draft: 42 }).ok, false);
  });
});

describe("what the receipts make of a request", () => {
  it("answers it with a stack under its own name, and says what that stack left out", () => {
    const answer = stackSatisfaction("rust", ["cargo", "rustfmt"], [receipt("rust", "ok", ["cargo", "rustc"])]);
    assert.deepEqual(answer, {
      kind: "installed",
      stacks: [{ name: "rust", binaries: ["cargo", "rustc"] }],
      missing: ["rustfmt"],
    });
  });

  it("answers it with other stacks that link every binary it asked for", () => {
    const answer = stackSatisfaction("rust", ["cargo"], [
      receipt("python", "ok", ["python3"]),
      receipt("rust-toolchain", "ok", ["cargo"]),
    ]);
    assert.deepEqual(answer, {
      kind: "installed",
      stacks: [{ name: "rust-toolchain", binaries: ["cargo"] }],
      missing: [],
    });
  });

  it("does not count a binary a failed stack names, and reports that stack's failure", () => {
    const answer = stackSatisfaction("rust", ["cargo"], [receipt("rust", "failed", ["cargo"])]);
    assert.deepEqual(answer, { kind: "failed", reason: "stack rust: the download failed" });
    const conflicted = stackSatisfaction("rust", ["cargo"], [receipt("rust", "conflicted", [])]);
    assert.equal(conflicted.kind, "failed");
  });

  it("is absent when nothing answers it", () => {
    assert.deepEqual(stackSatisfaction("rust", ["cargo"], [receipt("go", "ok", ["go"])]), { kind: "absent" });
  });
});

describe("what the release does with a waiting run", () => {
  const ok = [receipt("rust", "ok", ["cargo", "rustc"])];

  it("resumes a run whose every request is answered", () => {
    assert.deepEqual(decideStackWait([{ name: "rust", state: "pending", binaries: ["cargo"] }], ok), {
      kind: "resume",
      installed: [{ name: "rust", binaries: ["cargo", "rustc"] }],
      missing: [],
    });
  });

  it("keeps a run waiting while one of its requests is not, and names a failed one", () => {
    const decision = decideStackWait(
      [
        { name: "rust", state: "pending", binaries: ["cargo"] },
        { name: "zig", state: "pending", binaries: ["zig"] },
        { name: "terraform", state: "pending", binaries: ["terraform"] },
      ],
      [...ok, receipt("terraform", "failed", [])],
    );
    assert.deepEqual(decision, {
      kind: "stay",
      failures: [{ name: "terraform", reason: "stack terraform: the download failed" }],
    });
  });

  it("lets a decline outrank a request still pending", () => {
    // Waiting on the other would be holding back a run that has already been
    // told it cannot have what it needs.
    const decision = decideStackWait(
      [
        { name: "zig", state: "pending", binaries: ["zig"] },
        { name: "terraform", state: "declined", binaries: ["terraform"] },
      ],
      [],
    );
    assert.deepEqual(decision, { kind: "declined", declined: ["terraform"], installed: [] });
  });

  it("resumes a run attached to nothing rather than leaving it waiting for ever", () => {
    assert.deepEqual(decideStackWait([], []), { kind: "resume", installed: [], missing: [] });
  });

  it("agrees with request_stack about what is installed, so a filed request cannot resume itself", () => {
    // Every shape of receipt set, through both readers: whatever the tool would
    // file (not `installed`), the release must keep waiting on.
    const sets: StackReceipt[][] = [
      [],
      ok,
      [receipt("rust", "failed", ["cargo"])],
      [receipt("rust-toolchain", "ok", ["cargo"])],
      [receipt("rust", "ok", [])],
    ];
    for (const receipts of sets) {
      for (const binaries of [["cargo"], ["cargo", "rustfmt"], ["zig"]]) {
        const filed = stackSatisfaction("rust", binaries, receipts).kind !== "installed";
        const decision = decideStackWait([{ name: "rust", state: "pending", binaries }], receipts);
        assert.equal(decision.kind === "stay", filed, JSON.stringify({ receipts, binaries }));
      }
    }
  });

  it("tells a resumed run what it got and what it did not", () => {
    const notice = stackResumeNotice({
      kind: "resume",
      installed: [{ name: "rust", binaries: ["cargo", "rustc"] }],
      missing: ["rustfmt"],
    });
    assert.match(notice, /rust \(cargo, rustc\)/);
    assert.match(notice, /rustfmt/);
    const declined = stackResumeNotice({ kind: "declined", declined: ["zig"], installed: [] });
    assert.match(declined, /declined the stack you asked for: zig/);
    assert.match(declined, /NEEDS_REVIEW/);
  });
});

describe("one pending request per name", () => {
  const input = { name: "rust", binaries: ["cargo"], reason: "Run one builds a crate.", draft: "{ }" };
  let runs = 0;

  /** A run row to attach to: the attachment's run end is a foreign key. */
  function aRun(): string {
    runs += 1;
    const id = `run-${runs}`;
    db()
      .prepare(
        `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations, created_at)
         VALUES (?, ?, 'p', 'running', '{}', 1, 0, ?)`,
      )
      .run(id, tmp, Date.now());
    return id;
  }

  it("files the first, attaches the second, and keeps the first draft", () => {
    const first = aRun();
    const second = aRun();
    const filed = recordStackRequest({ runId: first, input, receipts: [], waitsSoFar: 0 });
    assert.equal(filed.kind, "filed");

    const attached = recordStackRequest({
      runId: second,
      input: { ...input, binaries: ["cargo", "rustc"], reason: "Run two too.", draft: "{ \"other\": 1 }" },
      receipts: [],
      waitsSoFar: 0,
    });
    assert.ok(attached.kind === "attached" && filed.kind === "filed");
    assert.equal(attached.requestId, filed.requestId);
    assert.equal(attached.alreadyAttached, false);

    const request = stackRequest(filed.requestId)!;
    assert.deepEqual(request.binaries, ["cargo", "rustc"], "the operator is asked for the union");
    assert.equal(request.draft, "{ }", "a later run replaced the draft the operator may be reading");
    assert.deepEqual(
      request.runs.map((run) => [run.runId, run.reason]),
      [
        [first, "Run one builds a crate."],
        [second, "Run two too."],
      ],
    );

    const again = recordStackRequest({ runId: first, input, receipts: [], waitsSoFar: 0 });
    assert.ok(again.kind === "attached");
    assert.equal(again.alreadyAttached, true);
    assert.equal(stackWaitOf(first).length, 1, "a second call in one cycle is one wait");
  });

  it("records nothing for what the receipts already answer", () => {
    const run = aRun();
    const before = (db().prepare("SELECT COUNT(*) AS n FROM stack_requests").get() as { n: number }).n;
    const installed = recordStackRequest({
      runId: run,
      input: { ...input, name: "go" },
      receipts: [receipt("go", "ok", ["cargo"])],
      waitsSoFar: 0,
    });
    assert.equal(installed.kind, "installed");
    const incomplete = recordStackRequest({
      runId: run,
      input: { ...input, name: "go", binaries: ["gofmt"] },
      receipts: [receipt("go", "ok", ["go"])],
      waitsSoFar: 0,
    });
    assert.deepEqual(incomplete, { kind: "incomplete", stack: { name: "go", binaries: ["go"] }, missing: ["gofmt"] });
    const after = (db().prepare("SELECT COUNT(*) AS n FROM stack_requests").get() as { n: number }).n;
    assert.equal(after, before);
    assert.deepEqual(stackWaitOf(run), []);
  });

  it("refuses past the waits bound, and refuses a run the operator already declined", () => {
    const run = aRun();
    const spent = recordStackRequest({
      runId: run,
      input: { ...input, name: "zig" },
      receipts: [],
      waitsSoFar: MAX_STACK_WAITS_PER_RUN,
    });
    assert.deepEqual(spent, { kind: "waits-spent", waits: MAX_STACK_WAITS_PER_RUN });

    const filed = recordStackRequest({ runId: run, input: { ...input, name: "zig" }, receipts: [], waitsSoFar: 0 });
    assert.ok(filed.kind === "filed");
    assert.equal(declineStackRequest(filed.requestId), true);
    const refused = recordStackRequest({ runId: run, input: { ...input, name: "zig" }, receipts: [], waitsSoFar: 1 });
    assert.equal(refused.kind, "declined-before", "a declined run could re-file and park again");

    // A different run may still ask: the decline was an answer to the runs
    // that were waiting, and a new request is a new question.
    const other = recordStackRequest({ runId: aRun(), input: { ...input, name: "zig" }, receipts: [], waitsSoFar: 0 });
    assert.equal(other.kind, "filed");
  });
});

describe("the draft check, asked of the applier the boot runs", () => {
  const applier = path.join(__dirname, "..", "..", "scripts", "apply-stacks.mjs");
  // `01b-stack-format.md` §5's worked example, the one `applyStacks.test.ts`
  // parses, so the draft is known-good against this parser.
  const draft = JSON.stringify({
    schema: 1,
    name: "terraform",
    install: [
      {
        kind: "archive",
        url: "https://releases.hashicorp.com/terraform/1.13.1/terraform_1.13.1_linux_{arch}.zip",
        checksums: "https://releases.hashicorp.com/terraform/1.13.1/terraform_1.13.1_SHA256SUMS",
        unpack: "zip",
        bin: [{ from: "terraform", as: "terraform" }],
      },
    ],
  });

  it("says accepted or refused in the parser's own words", async () => {
    assert.deepEqual(await checkStackDraft("terraform", draft, applier), { kind: "accepted" });
    const refused = await checkStackDraft("other-name", draft, applier);
    assert.equal(refused.kind, "refused");
    assert.match(refused.kind === "refused" ? refused.reason : "", /directory is "other-name"/);
  });

  it("says unchecked, never accepted, when the parser is not there", async () => {
    const verdict = await checkStackDraft("terraform", draft, path.join(tmp, "no-applier.mjs"));
    assert.equal(verdict.kind, "unchecked");
  });
});
