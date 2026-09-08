import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * What the prune does to the operator's own disk, around the one child it spawns.
 *
 * The sweep that removes winnow's backup is the quietest thing in this app: it
 * runs after a prune that succeeded, deletes nothing that anybody counts, and a
 * miss leaves a full copy of the pre-prune transcript inside `~/.claude` — a
 * bind mount of the operator's machine — with nothing in the tree that will ever
 * come back for it. `retention.ts` expires transcripts by asking the database
 * what is live and these files are not rows, so `grep -rn '\.bak' src/` returns
 * exactly one deletion in the whole codebase. Eleven of them survived on the
 * install this was measured on, 18.8 MB, every one with a live transcript still
 * beside it.
 *
 * Both ways of getting it wrong are silent and they are not symmetric. Deleting
 * too little is the leak above. Deleting too much reaches a file an operator
 * made by hand with `winnow treat` in a terminal, which is the copy they kept
 * *because* they were about to let a tool rewrite their transcript.
 *
 * The child is injected rather than spawned. What is being pinned is a
 * difference between two directory listings taken around it, and on a machine
 * with no winnow installed — CI, and every developer checkout — a real
 * `pruneTranscript` returns `unavailable` before either listing is taken, so the
 * only test that would run at all is the one that proves nothing.
 *
 * Its own file for `retentionSweep.test.ts`'s reason: `config.ts` reads
 * `DATA_DIR` at module load and `pruneTranscript` creates `WINNOW_DATA_DIR`
 * under it, so the throwaway directory has to be named before anything that
 * reaches the config is imported.
 */

let pruning: typeof import("./contextPruning");
let root: string;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-prune-child-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  // Nothing here reaches a spawn, and a `claude` that does not exist makes a
  // regression that somehow got that far a failed test rather than a billed one.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real data directory",
  );

  pruning = await import("./contextPruning");
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

/** A record shaped the way `contextTokens` counts one: bytes under `message`. */
const record = (text: string) => ({
  type: "assistant",
  // Outside `message`, and winnow demonstrably rewrites exactly these.
  version: "1.0.0",
  gitBranch: "main",
  message: { role: "assistant", content: text },
});

/**
 * A transcript in a directory of its own, last written 999 ms into a second two
 * seconds ago.
 *
 * That mtime is the whole point of the fixture. winnow does not write its
 * backup, it copies the transcript with `shutil.copy2`, so the copy carries the
 * *source's* mtime — and `~/.claude` is a bind mount whose `utime` lands on
 * whole seconds, so what the copy ends up carrying is `floor(lastWrite)`. The
 * filter this replaced compared that against the moment the prune started, with
 * one second of grace; a last write 999 ms into its second leaves 1 ms of it,
 * and `contextTokensOf`'s own docblock puts a single whole-file read at 31.9 ms.
 */
function fixture(name: string, lines: readonly unknown[]): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "0f0f0f0f-1111-2222-3333-444444444444.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  const lastWrite = Math.floor(Date.now() / 1000) - 2 + 0.999;
  fs.utimesSync(file, lastWrite, lastWrite);
  return file;
}

/** What winnow leaves beside the transcript, with the mtime `copy2` gives it. */
function writeBackup(transcript: string, stamp: string): string {
  const stem = path.basename(transcript, ".jsonl");
  const backup = path.join(path.dirname(transcript), `${stem}.${stamp}.jsonl.bak`);
  fs.copyFileSync(transcript, backup);
  const inherited = Math.floor(fs.statSync(transcript).mtimeMs / 1000);
  fs.utimesSync(backup, inherited, inherited);
  return backup;
}

const backupsIn = (transcript: string) =>
  fs
    .readdirSync(path.dirname(transcript))
    .filter((e) => e.endsWith(".jsonl.bak"))
    .sort();

const always = () => true;

/**
 * A rewrite that touches only what `contextTokens` cannot see.
 *
 * Through a temporary file and a rename, because that is what winnow's
 * `save_messages` does — `os.replace` over a temp — and the inode moving is what
 * the app reads the rewrite off. The keys dropped are the ones measured going
 * missing from every record surviving a prune on this install: `message` is
 * byte-identical, so not one token leaves the prompt.
 */
function rewriteOutsideMessage(transcript: string): void {
  const rewritten = fs
    .readFileSync(transcript, "utf8")
    .split("\n")
    .map((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      delete parsed.version;
      delete parsed.gitBranch;
      return JSON.stringify(parsed);
    })
    .join("\n");
  const temp = `${transcript}.tmp`;
  fs.writeFileSync(temp, rewritten);
  fs.renameSync(temp, transcript);
}

describe("pruneTranscript's backup sweep", () => {
  it("removes the copy its own child made, whatever mtime that copy carries", async () => {
    const transcript = fixture("swept", [
      record("x".repeat(4_000)),
      record("y".repeat(4_000)),
    ]);

    const result = await pruning.pruneTranscript(transcript, "standard", {
      available: always,
      spawn: async () => {
        writeBackup(transcript, "20260908_120000");
        fs.writeFileSync(transcript, JSON.stringify(record("x".repeat(400))));
        return { ok: true };
      },
    });

    assert.equal(result.kind, "pruned");
    assert.deepEqual(
      backupsIn(transcript),
      [],
      "the backup this prune's own child wrote is still on the operator's disk",
    );
  });

  it("leaves a backup that was already there before the child started", async () => {
    const transcript = fixture("operators-own", [record("z".repeat(4_000))]);
    // The copy somebody kept *because* they were about to let a tool rewrite
    // their transcript. It matches winnow's naming exactly, so nothing but the
    // listing taken before the spawn can tell it from the child's own.
    writeBackup(transcript, "20240101_030000");

    const result = await pruning.pruneTranscript(transcript, "standard", {
      available: always,
      spawn: async () => {
        writeBackup(transcript, "20260908_120000");
        fs.writeFileSync(transcript, JSON.stringify(record("z".repeat(400))));
        return { ok: true };
      },
    });

    assert.equal(result.kind, "pruned");
    assert.deepEqual(backupsIn(transcript), [
      "0f0f0f0f-1111-2222-3333-444444444444.20240101_030000.jsonl.bak",
    ]);
  });

  it("sweeps a child that copied the transcript and then failed", async () => {
    const transcript = fixture("failed-child", [record("q".repeat(4_000))]);

    const result = await pruning.pruneTranscript(transcript, "standard", {
      available: always,
      // `save_messages(create_backup=True)` writes the copy before it can fail,
      // so a non-zero exit — or a SIGKILL at `PRUNE_TIMEOUT_MS` — used to leave
      // one behind per failing cycle, unbounded.
      spawn: async () => {
        writeBackup(transcript, "20260908_121500");
        return { ok: false, reason: "winnow exited 1" };
      },
    });

    assert.deepEqual(result, { kind: "failed", reason: "winnow exited 1" });
    assert.deepEqual(backupsIn(transcript), []);
  });
});

describe("pruneTranscript's two questions", () => {
  it("reports a rewrite that removed no prompt tokens, so the cost is charged", async () => {
    const transcript = fixture("rewritten", [
      record("a".repeat(4_000)),
      record("b".repeat(4_000)),
    ]);
    const before = pruning.contextTokens(transcript);

    const result = await pruning.pruneTranscript(transcript, "standard", {
      available: always,
      spawn: async () => {
        rewriteOutsideMessage(transcript);
        return { ok: true };
      },
    });

    // Not `nothing`. The child replaced the file, so the cached prefix is gone
    // and the next `--resume` pays a full cache write whether or not anything
    // came out of the prompt — but `contextTokens` sums `message` and nothing
    // else, so the subtraction that used to decide this alone reads zero.
    assert.equal(result.kind, "rewritten");
    assert.equal(result.kind === "rewritten" && result.outcome.tokensRemoved, 0);
    assert.equal(pruning.contextTokens(transcript), before, "no tokens left the prompt");

    // And the receipt that carries it. `netReceipt` can only charge an
    // invalidation against a row, so a zero-token rewrite with no row is a cost
    // that lands nowhere — dropped in exactly the direction that flatters the
    // net figure, since the rewrites which *did* earn something keep theirs.
    if (result.kind !== "rewritten") return;
    pruning.recordPrune("rewritten-run", "early-end", result.outcome, "claude-opus-5");
    const receipts = pruning.readReceipts({ runId: "rewritten-run" });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].tokensRemoved, 0);
    assert.equal(receipts[0].trigger, "early-end");

    const net = pruning.netReceipt(receipts[0], 20);
    assert.equal(net.cacheSavedUSD, 0, "nothing was removed, so nothing was saved");
    assert.ok(net.netUSD < 0, "the rewrite it did perform has to be able to show a loss");
  });

  it("still reports nothing when the child left the file alone", async () => {
    const transcript = fixture("untouched", [record("c".repeat(4_000))]);

    const result = await pruning.pruneTranscript(transcript, "standard", {
      available: always,
      spawn: async () => ({ ok: true }),
    });

    // The control, and the reason the rewrite is read off the file rather than
    // assumed from the child having exited 0: a boundary that cost nothing must
    // not start writing receipts, or every cycle on a quiet run carries an
    // invalidation that never happened.
    assert.deepEqual(result, {
      kind: "nothing",
      tokensBefore: pruning.contextTokens(transcript),
    });
    assert.deepEqual(pruning.readReceipts({ runId: "untouched-run" }), []);
  });
});
