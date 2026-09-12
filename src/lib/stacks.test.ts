import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { parseReceipt, readReceipts, stackEnvironment } from "./stacks";

/**
 * Reading a receipt a shell-invoked script wrote.
 *
 * A receipt is written by `scripts/apply-stacks.mjs` and read by TypeScript,
 * which is a boundary, and `CLAUDE.md`'s rule is to validate at boundaries and
 * trust internal calls. The branch that earns this file is the truncated
 * receipt a container killed mid-write leaves behind: **it must read
 * unreadable and never a partial `ok`**, because a partial `ok` is this app
 * telling an operator a tool is installed when the install did not finish —
 * which is the exact failure the whole read-back exists to end, reintroduced by
 * the thing that reports it.
 *
 * The applier writes to a temporary file and renames, so a truncated receipt
 * should be unreachable from the current build. It is tested anyway, because
 * "should be unreachable" is a claim about one writer and this reader also
 * meets receipts from an older build, from a failed rename, and from a volume
 * restored from underneath a running container.
 *
 * The other assertions are the fields a page would *draw*. A receipt with no
 * status, an unknown status, or a link with a name and no path are each one
 * missing check away from a row on Settings claiming a binary that is not
 * there.
 */

let root: string;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-stacks-test-"));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const COMPLETE = {
  schema: 1,
  name: "terraform",
  digest: "a".repeat(64),
  status: "ok",
  appliedAt: "2026-09-12T10:00:00.000Z",
  summary: "HashiCorp Terraform 1.13.1.",
  bin: [{ name: "terraform", path: "/var/lib/uf-stacks/bin/terraform" }],
  deny: ["terraform apply"],
  env: { TF_PLUGIN_CACHE_DIR: "/var/lib/uf-stacks/state/terraform/plugin-cache" },
  state: ["/var/lib/uf-stacks/state/terraform/plugin-cache"],
  steps: [{ kind: "archive", status: "ok", detail: "1 binary from terraform_1.13.1_linux_arm64.zip" }],
  error: null,
};

function receipt(overrides: Record<string, unknown> = {}): unknown {
  return parseReceipt(JSON.stringify({ ...COMPLETE, ...overrides }));
}

describe("parseReceipt — a file written by a script and read by an app", () => {
  it("reads a complete receipt whole", () => {
    const parsed = parseReceipt(JSON.stringify(COMPLETE));
    assert.notEqual(parsed, null);
    assert.equal(parsed?.name, "terraform");
    assert.equal(parsed?.status, "ok");
    assert.deepEqual(parsed?.bin, [{ name: "terraform", path: "/var/lib/uf-stacks/bin/terraform" }]);
    assert.deepEqual(parsed?.deny, ["terraform apply"]);
    assert.equal(parsed?.env.TF_PLUGIN_CACHE_DIR, "/var/lib/uf-stacks/state/terraform/plugin-cache");
    assert.equal(parsed?.steps[0].status, "ok");
    assert.equal(parsed?.error, null);
  });

  it("refuses a receipt truncated part-way through, at every cut", () => {
    // The whole reason this function exists. A container killed mid-write
    // leaves one of these, and JSON.parse gives up somewhere in the middle of
    // it — which must be an absence and never a partial ok.
    const text = JSON.stringify(COMPLETE);
    for (let cut = 1; cut < text.length; cut += 7) {
      assert.equal(parseReceipt(text.slice(0, cut)), null, `a cut at ${cut} bytes parsed`);
    }
  });

  it("refuses a receipt carrying no status, or one this app does not know", () => {
    const without = { ...COMPLETE } as Record<string, unknown>;
    delete without.status;
    assert.equal(parseReceipt(JSON.stringify(without)), null);
    assert.equal(receipt({ status: "installed" }), null);
    assert.equal(receipt({ status: "" }), null);
  });

  it("refuses a receipt with no name, since the name is the stack's identity", () => {
    assert.equal(receipt({ name: "" }), null);
    assert.equal(receipt({ name: 7 }), null);
  });

  it("refuses a link that has a name and no path", () => {
    // The one field a page draws as a resolved binary. Half of one is a row
    // claiming a command whose location nothing recorded.
    assert.equal(receipt({ bin: [{ name: "terraform" }] }), null);
    assert.equal(receipt({ bin: [{ path: "/var/lib/uf-stacks/bin/terraform" }] }), null);
    assert.equal(receipt({ bin: "terraform" }), null);
  });

  it("reads a failed receipt and keeps the applier's text verbatim", () => {
    const failed = parseReceipt(
      JSON.stringify({
        ...COMPLETE,
        status: "failed",
        bin: [],
        error: { text: "curl: (22) The requested URL returned error: 404", bytes: 120_000 },
      }),
    );
    assert.equal(failed?.status, "failed");
    // Never summarised into a category: an applier that turned a curl failure
    // into "network error" would be inventing the one field an operator
    // actually needs to read.
    assert.match(String(failed?.error?.text), /404/);
    // And the original byte count beside it, because a message quietly a third
    // of the real one is worse than no message.
    assert.equal(failed?.error?.bytes, 120_000);
  });

  it("is not JSON, an array, or a bare value", () => {
    assert.equal(parseReceipt("not json"), null);
    assert.equal(parseReceipt("[]"), null);
    assert.equal(parseReceipt('"terraform"'), null);
    assert.equal(parseReceipt("null"), null);
  });

  it("tolerates a receipt missing the fields nothing is decided on", () => {
    // An older build's receipt should still read, because the alternative is a
    // page that goes blank on an upgrade. What may be missing is everything a
    // badge is not composed from.
    const parsed = parseReceipt(JSON.stringify({ name: "x", digest: "d", status: "ok" }));
    assert.notEqual(parsed, null);
    assert.deepEqual(parsed?.bin, []);
    assert.deepEqual(parsed?.deny, []);
    assert.deepEqual(parsed?.env, {});
    assert.equal(parsed?.appliedAt, null);
  });
});

describe("readReceipts — an empty volume and an unreadable one are not the same", () => {
  it("reads nothing and reports no fault when the directory is not there", () => {
    // An install with no stacks. Not a fault, and a fault line here would be on
    // every install that never declared one.
    const result = readReceipts(path.join(root, "absent"));
    assert.deepEqual(result.receipts, []);
    assert.equal(result.problem, null);
  });

  it("separates the receipts it read from the ones it could not", () => {
    const dir = path.join(root, "receipts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "terraform.json"), JSON.stringify(COMPLETE));
    fs.writeFileSync(path.join(dir, "shell-lint.json"), JSON.stringify(COMPLETE).slice(0, 60));
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");

    const result = readReceipts(dir);
    assert.deepEqual(result.receipts.map((r) => r.name), ["terraform"]);
    // Named rather than omitted: an empty space where a stack should be reads
    // exactly like a stack that was never declared.
    assert.deepEqual(result.unreadable.map((u) => u.name), ["shell-lint"]);
    assert.equal(result.problem, null);
  });
});

describe("stackEnvironment — what the boot merges into process.env", () => {
  it("is empty rather than throwing when there is no file", () => {
    // It runs inside register(), and a rejected register() leaves Next
    // listening anyway — so a throw here is a server that starts without the
    // environment and says nothing about it.
    assert.deepEqual(stackEnvironment(path.join(root, "absent.json")), {});
  });

  it("is empty rather than half-read when the file is not an object of strings", () => {
    const file = path.join(root, "env.json");
    fs.writeFileSync(file, '{"A": "1", "B": 2, "C": null}');
    assert.deepEqual(stackEnvironment(file), { A: "1" });
    fs.writeFileSync(file, "[]");
    assert.deepEqual(stackEnvironment(file), {});
    fs.writeFileSync(file, '{"A": "1"');
    assert.deepEqual(stackEnvironment(file), {});
  });
});
