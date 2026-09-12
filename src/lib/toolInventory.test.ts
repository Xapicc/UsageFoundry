import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";

/**
 * Four pure functions, all silent when they are wrong, and three of them wrong
 * in the direction that costs money rather than the one that shows.
 *
 * `parseToolList` decides what the page claims an operator asked for, against
 * two variables whose separator rules differ and whose difference nothing
 * typechecks. `resolveOnPath` decides what it claims is *there*, and one
 * mishandled `PATH` element moves every row at once. `composeState` turns four
 * readings into the one word an operator acts on without reading further, and
 * the expensive way for it to be wrong is to say `installed` over a reading
 * that is not. `commandPositionNames` decides whether the observed layer
 * carries information at all — a leading-prefix test was measured at 10.5% recall
 * on this install's own history, and at that rate nothing ever leaves
 * `unverified`.
 *
 * Its own `DATA_DIR` before the first import, for `runOrigin.test.ts`'s reason:
 * the module reaches `db.ts` for the invocation count, `config.ts` is read at
 * module load, and a file that imported it bound to the repository's own
 * `.data` would be pointed at a developer's real database.
 */

let root: string;
let mod: typeof import("./toolInventory");

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-tool-inventory-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  mod = await import("./toolInventory");
});

describe("parseToolList", () => {
  it("splits gh extensions on commas and Python tools not at all", () => {
    // The one place the two part company, and it is silent both ways.
    // `docker-entrypoint.sh:252` says why: a comma is meaningful inside a
    // version specifier, so splitting on it turns one pinned entry into two
    // unpinnable ones — each of which then reports as a tool that failed to
    // install rather than as a line that was misread.
    assert.deepEqual(
      mod.parseToolList("cozempic>=1.8,<2", "python").map((t) => t.spec),
      ["cozempic>=1.8,<2"],
    );
    assert.deepEqual(
      mod.parseToolList("dlvhdr/gh-dash,github/gh-copilot", "gh-extension").map((t) => t.spec),
      ["dlvhdr/gh-dash", "github/gh-copilot"],
    );
  });

  it("splits both on spaces and on the pipe the other list variables use", () => {
    // `.env.example` documents spaces for both and the entrypoint accepts `|`
    // beside them, "because the other list-valued variables in .env are
    // '|'-separated and an operator should not have to remember which of them
    // this is".
    assert.equal(mod.parseToolList("a b|c", "python").length, 3);
    assert.equal(mod.parseToolList("o/gh-a o/gh-b|o/gh-c", "gh-extension").length, 3);
    assert.deepEqual(mod.parseToolList("", "python"), []);
    assert.deepEqual(mod.parseToolList("   ", "gh-extension"), []);
  });

  it("cuts a Python name at the first specifier character and nowhere else", () => {
    // `${entry%%[=<>!~[@]*}` at docker-entrypoint.sh:282, which is what decides
    // whether the boot loop thinks a tool is already installed. A parser that
    // disagrees with it draws a row for a package name the container never
    // used.
    const name = (spec: string) => mod.parseToolList(spec, "python")[0];
    assert.equal(name("cozempic").command, "cozempic");
    assert.equal(name("cozempic==1.8.39").command, "cozempic");
    assert.equal(name("cozempic>=1.8,<2").command, "cozempic");
    assert.equal(name("cozempic[extra]").command, "cozempic");
    assert.equal(name("cozempic@file:///workspace/winnow").command, "cozempic");
    assert.equal(name("cozempic!=1.0").command, "cozempic");
    assert.equal(name("cozempic~=1.8").command, "cozempic");
    assert.equal(name("cozempic==1.8.39").pin, "==1.8.39");
  });

  it("gives a bare container path no command at all rather than guessing one", () => {
    // `.env.example:263`: an absolute path is a checkout installed editable,
    // and its console script is named in the project's metadata. Deriving
    // "winnow" from the directory would be a claim nobody measured, and the row
    // it draws would read `broken` on every install whose script is named
    // anything else.
    const editable = mod.parseToolList("/workspace/winnow", "python")[0];
    assert.equal(editable.command, null);
    assert.equal(editable.pin, null);
    assert.equal(editable.spec, "/workspace/winnow");
  });

  it("cuts a gh entry at the last @, so an owner may contain one", () => {
    // `${entry%@*}` and `${entry##*@}` both cut at the last, and the command is
    // the repository's name with the `gh-` prefix off — which is what gh itself
    // requires an extension repository to be called.
    const one = mod.parseToolList("dlvhdr/gh-dash@v1.2.3", "gh-extension")[0];
    assert.equal(one.command, "gh dash");
    assert.equal(one.pin, "v1.2.3");
    const unpinned = mod.parseToolList("Xapicc/gh-layer10", "gh-extension")[0];
    assert.equal(unpinned.command, "gh layer10");
    assert.equal(unpinned.pin, null);
  });
});

describe("resolveOnPath", () => {
  const present = (paths: string[]) => (candidate: string) => paths.includes(candidate);

  it("takes the first element that has it, not the last", () => {
    // The toolbox is prepended to PATH, so first-wins is the whole of how a
    // stack's copy beats /usr/local/bin's. A resolver that walked the other way
    // would report the shadowed copy as the one an agent gets.
    assert.equal(
      mod.resolveOnPath("rg", "/a:/b", present(["/a/rg", "/b/rg"])),
      "/a/rg",
    );
  });

  it("treats an empty element as the current directory, both ways round", () => {
    // POSIX, and the failure is silent in both directions: read as "not found"
    // it hides a resolution that will happen, and dropped it changes what the
    // page claims about every binary at once. A trailing colon is the same
    // element written a second way, which is how it gets into a PATH by
    // accident.
    assert.equal(mod.resolveOnPath("x", ":/b", present(["x"])), null);
    assert.equal(mod.resolveOnPath("x", ":/b", present(["./x"])), "./x");
    assert.equal(mod.resolveOnPath("x", "/b:", present(["./x"])), "./x");
    assert.equal(mod.resolveOnPath("x", "/b::/c", present(["./x"])), "./x");
  });

  it("answers null for an empty PATH and for a name that is a path", () => {
    assert.equal(mod.resolveOnPath("rg", "", present(["/rg"])), null);
    assert.equal(mod.resolveOnPath("", "/a", present(["/a"])), null);
    // A name with a slash is not resolved through PATH by any shell, and
    // joining one would produce a candidate that could exist and mean nothing.
    assert.equal(
      mod.resolveOnPath("bin/rg", "/a", present(["/a/bin/rg"])),
      null,
    );
  });
});

describe("composeState", () => {
  const readings = (over: Partial<import("./toolInventory").ToolReadings> = {}) => ({
    install: "none" as const,
    resolvedAt: "/home/node/pytools/bin/rg",
    insideItsOwnToolbox: true,
    command: "rg" as string | null,
    calls: 3,
    failures: 0,
    ...over,
  });

  it("says installed only when all four readings agree", () => {
    assert.equal(mod.composeState(readings()), "installed");
    assert.equal(mod.composeState(readings({ calls: 0 })), "unverified");
    assert.equal(mod.composeState(readings({ insideItsOwnToolbox: false })), "shadowed");
    assert.equal(mod.composeState(readings({ calls: 3, failures: 3 })), "failing");
    assert.equal(mod.composeState(readings({ resolvedAt: null })), "broken");
    assert.equal(mod.composeState(readings({ install: "failed" })), "failed");
    assert.equal(mod.composeState(readings({ command: null })), "unknown");
  });

  it("never lets a higher layer paint over a lower one's fault", () => {
    // The expensive direction, and the only one worth a test on its own: a
    // composition that reports `installed` over a resolution that failed is a
    // page telling an operator the thing costing them money is fine.
    assert.equal(
      mod.composeState(readings({ resolvedAt: null, calls: 900, failures: 0 })),
      "broken",
    );
    assert.equal(
      mod.composeState(readings({ install: "missing", resolvedAt: null, calls: 900 })),
      "failed",
    );
    assert.equal(
      mod.composeState(readings({ calls: 4, failures: 4, insideItsOwnToolbox: false })),
      "failing",
    );
  });

  it("does not call a working tool failing because some calls errored", () => {
    // `tool_error` is written on the tool result and the `tool` row when the
    // call is made (`orchestrator.ts:7925`), so failures are a subset of calls
    // and any tool used daily for a month has some. Keyed on `failures > 0`
    // this word is a warn badge on every working tool on the install and
    // `installed` is unreachable — measured on this install the day it
    // shipped, 4 errors in 996 calls read `failing`. What earns the word is
    // that nothing has ever worked.
    assert.equal(mod.composeState(readings({ calls: 996, failures: 4 })), "installed");
    assert.equal(mod.composeState(readings({ calls: 2, failures: 1 })), "installed");
    assert.equal(mod.composeState(readings({ calls: 1, failures: 1 })), "failing");
    // No call at all is not a failing tool, it is an unverified one — and the
    // guard has to be there, because `0 >= 0` is true.
    assert.equal(mod.composeState(readings({ calls: 0, failures: 0 })), "unverified");
  });

  it("does not read a source with no applier as a source that failed", () => {
    // `install: "none"` is UF_PY_TOOLS and UF_GH_EXTENSIONS, which have no
    // receipt and never will. 01f- §3 composes "a declaration with no receipt"
    // to `failed`; applied here that would mark every correctly installed tool
    // on every install as a failure.
    assert.equal(mod.composeState(readings({ install: "none" })), "installed");
    assert.equal(mod.composeState(readings({ install: "ok" })), "installed");
    assert.equal(mod.composeState(readings({ install: "conflicted" })), "failed");
  });

  it("says unknown before broken when there is no command to resolve", () => {
    // An editable checkout resolves nothing because there is nothing to
    // resolve. Drawing it `broken` would send an operator to fix an install
    // that is fine.
    assert.equal(
      mod.composeState(readings({ command: null, resolvedAt: null })),
      "unknown",
    );
  });
});

describe("commandPositionNames", () => {
  it("finds a command after every separator, not only at the head", () => {
    // The measurement this function exists for: over 30 days of this install's
    // own history, 105 commands began with `gh ` and 697 more invoked it after
    // a separator. A leading-prefix test finds 13% of them, and at that recall
    // no tool ever reaches `installed` and the layer stops carrying anything.
    assert.deepEqual(mod.commandPositionNames("gh pr list"), ["gh"]);
    assert.deepEqual(mod.commandPositionNames("cd /x && gh pr list"), ["cd", "gh"]);
    assert.deepEqual(mod.commandPositionNames("rg foo | jq .bar"), ["rg", "jq"]);
    assert.deepEqual(mod.commandPositionNames("a; b"), ["a", "b"]);
    assert.deepEqual(mod.commandPositionNames("x || y"), ["x", "y"]);
    assert.deepEqual(mod.commandPositionNames("a\nb"), ["a", "b"]);
  });

  it("reduces an absolute path to the name an operator declared", () => {
    // `/usr/local/bin/terraform plan` is a call of the tool the row is about,
    // and a name-only test misses it. This is a quarter of the commands on this
    // install by the same measurement.
    assert.deepEqual(mod.commandPositionNames("/usr/local/bin/terraform plan"), ["terraform"]);
    assert.deepEqual(mod.commandPositionNames("./scripts/run.sh"), ["run.sh"]);
  });

  it("steps over a leading assignment rather than counting it", () => {
    // `GH_TOKEN=x gh api …` is a call of gh. Counting `GH_TOKEN=x` as the
    // command would both miss the call and invent one.
    assert.deepEqual(mod.commandPositionNames("GH_TOKEN=x gh api /user"), ["gh"]);
    assert.deepEqual(mod.commandPositionNames("A=1 B=2 rg foo"), ["rg"]);
  });

  it("takes only the head of each segment, so an argument is not a call", () => {
    // The over-counting direction is the expensive one, since a call pushes a
    // row toward `installed`. An argument that happens to be a tool's name is
    // the common way that would happen.
    assert.deepEqual(mod.commandPositionNames("which terraform"), ["which"]);
    assert.deepEqual(mod.commandPositionNames("echo rg"), ["echo"]);
    assert.deepEqual(mod.commandPositionNames(""), []);
    assert.deepEqual(mod.commandPositionNames("   "), []);
  });
});

/**
 * The one reading here that is a query rather than a pure function, and the
 * only branch of it whose wrong answer is a number that is too **high**.
 *
 * Everything else about `invocationCounts` fails low — an unmatched command
 * shape, a retained window that is shorter than an operator assumes — which
 * `01f-read-back.md` §2.4 argues is the safe direction: a tool reads
 * `unverified` when it has in fact been used. The install floor inverts that. A
 * command name outlives an install of it, so counting calls made before a stack
 * existed composes to `installed` on evidence that says nothing about the
 * binary now on `PATH` — and *"the only evidence that a tool works is a run
 * that used it"* is the one claim the read-back may never get wrong
 * (`01f-` §7).
 *
 * Measured on this install the day stacks shipped, which is why the floor is
 * here at all: `shellcheck` had 20 `Bash` calls in the retained window against
 * a binary four minutes old, and without the floor that row read `installed`.
 */
describe("invocationCounts — a call made before the install is not evidence of it", () => {
  const RUN = "floor-test-run";

  before(async () => {
    const { db } = await import("./db");
    db()
      .prepare(
        "INSERT INTO runs (id, folder, prompt, status, budget, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(RUN, "/workspace/x", "p", "success", "{}", 1);
    const event = db().prepare(
      "INSERT INTO run_events (run_id, ts, kind, payload) VALUES (?,?,?,?)",
    );
    const call = (ts: number, command: string) =>
      event.run(RUN, ts, "tool", JSON.stringify({ name: "Bash", input: { command } }));
    const failed = (ts: number, command: string) =>
      event.run(RUN, ts, "tool_error", JSON.stringify({ name: "Bash", command, text: "no" }));

    call(1_000, "shellcheck old.sh");
    failed(1_000, "shellcheck old.sh");
    call(9_000, "shellcheck new.sh");
    call(9_000, "shfmt -l .");
  });

  it("counts every call when nothing names a floor", () => {
    const counts = mod.invocationCounts(["shellcheck", "shfmt"], 10_000);
    assert.deepEqual(counts.get("shellcheck"), { calls: 2, failures: 1 });
    assert.deepEqual(counts.get("shfmt"), { calls: 1, failures: 0 });
  });

  it("drops the calls that predate the install, failures included", () => {
    // A failure from before the install is as misleading as a success: it would
    // draw `failing` on a binary that has never been run.
    const counts = mod.invocationCounts(
      ["shellcheck", "shfmt"],
      10_001,
      new Map([["shellcheck", 5_000]]),
    );
    assert.deepEqual(counts.get("shellcheck"), { calls: 1, failures: 0 });
    // A name with no floor is untouched by another name's.
    assert.deepEqual(counts.get("shfmt"), { calls: 1, failures: 0 });
  });

  it("reads nothing at all for a stack installed after the last call", () => {
    // Which is every stack on its first boot, and is what makes `unverified`
    // the honest first word rather than `installed`.
    const counts = mod.invocationCounts(
      ["shellcheck"],
      10_002,
      new Map([["shellcheck", 9_500]]),
    );
    assert.deepEqual(counts.get("shellcheck"), { calls: 0, failures: 0 });
  });

  it("does not answer a moved floor out of the cache it filled for the old one", () => {
    // The cache is keyed on the floors as well as on the retention cutoff,
    // because a floor that moved is a stack that was reapplied — which is
    // exactly the moment the counts must start again.
    const before = mod.invocationCounts(["shellcheck"], 10_003, new Map([["shellcheck", 0]]));
    assert.equal(before.get("shellcheck")?.calls, 2);
    const after = mod.invocationCounts(["shellcheck"], 10_004, new Map([["shellcheck", 9_500]]));
    assert.equal(after.get("shellcheck")?.calls, 0);
  });
});
