import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * The scan's deduplication, which is the one thing in this module a pure test
 * cannot reach and the one thing a real corpus proved wrong.
 *
 * **A resumed session copies its earlier records into the new transcript**, so
 * the same failure is written twice in two different files. A per-file pass
 * cannot see it, and the first note Dreaming ever wrote caught it: the agent
 * re-derived the counts from the corpus rather than trusting the ones it was
 * handed, and reported 2,428 error results where the readout had said 2,553.
 * Measured against the real corpus afterwards: 2,567 blocks carrying 2,435
 * distinct `tool_use_id`s — 132 surplus, 5.1%.
 *
 * It is a *counting* bug and not a policy one, which is why the day assertion
 * below matters as much as the instance assertion: no copied-forward record was
 * ever found on a different day from its original, so deduplication must not
 * change which signatures span two days and therefore must not change what gets
 * written. A future "fix" that deduplicated on the signature instead of on the
 * record would silently collapse a genuine recurrence into one sighting and
 * stop writing notes at all.
 *
 * `CLAUDE_HOME` is named before the first import, for `runOrigin.test.ts`'s
 * reason: `config.ts` is read at module load, so a file that imported the scan
 * at the top would already be bound to the operator's real transcripts.
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "uf-dreaming-scan-"));
const PROJECTS = path.join(HOME, "projects");
fs.mkdirSync(PROJECTS, { recursive: true });
process.env.CLAUDE_HOME = HOME;

/** Outside `PROJECTS` so the corpus-wiping `beforeEach` below leaves it alone. */
const PROBE = path.join(HOME, "chunk-probe");
fs.writeFileSync(PROBE, "x");

after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

type Scan = typeof import("./dreaming");
let mod: Scan;

before(async () => {
  mod = await import("./dreaming");
});

beforeEach(() => {
  for (const entry of fs.readdirSync(PROJECTS)) {
    fs.rmSync(path.join(PROJECTS, entry), { recursive: true, force: true });
  }
  // The memo is keyed on path plus size and mtime, and a fixture rewritten
  // inside one millisecond can otherwise reuse the previous parse.
  mod.forgetDreamingFiles(
    fs.existsSync(PROJECTS)
      ? fs.readdirSync(PROJECTS).map((f) => path.join(PROJECTS, f))
      : [],
  );
});

/** One `is_error` tool result, as the CLI writes it. */
function record(opts: { at: string; toolUseId: string; body: string; uuid?: string }) {
  return JSON.stringify({
    timestamp: opts.at,
    uuid: opts.uuid ?? `u-${opts.toolUseId}`,
    sessionId: "sess-1",
    message: {
      content: [
        { type: "tool_result", tool_use_id: opts.toolUseId, is_error: true, content: opts.body },
      ],
    },
  });
}

function write(name: string, lines: string[]) {
  const file = path.join(PROJECTS, name);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  mod.forgetDreamingFiles([file]);
}

describe("scanDreaming deduplication", () => {
  it("counts a record copied into a resumed session once", async () => {
    const line = record({
      at: "2026-08-10T09:00:00Z",
      toolUseId: "toolu_1",
      body: "bwrap: Can't create file at /a/b/settings.json: Permission denied",
    });
    // The original, and the copy a resume wrote into a second transcript.
    write("original.jsonl", [line]);
    write("resumed.jsonl", [line]);

    const out = await mod.scanDreaming({ timeZone: "UTC" });
    assert.equal(out.totalInstances, 1, "the copy must not be counted again");
    assert.equal(out.duplicates, 1, "and the drop must be reported rather than absorbed");
  });

  it("keeps two genuinely separate failures that share a message", async () => {
    // Same text, different calls — two real failures, and collapsing them would
    // understate a recurring problem rather than overstate it.
    write("a.jsonl", [
      record({ at: "2026-08-10T09:00:00Z", toolUseId: "toolu_1", body: "pdftoppm is not installed" }),
      record({ at: "2026-08-10T10:00:00Z", toolUseId: "toolu_2", body: "pdftoppm is not installed" }),
    ]);

    const out = await mod.scanDreaming({ timeZone: "UTC" });
    assert.equal(out.totalInstances, 2);
    assert.equal(out.duplicates, 0);
  });

  it("does not change which signatures span two days", async () => {
    // The assertion that keeps this a counting fix. A dedup keyed on the
    // signature rather than the record would leave this at one day and the
    // write policy would stop firing, silently.
    const body = "Exit code 128 error: .bash_profile: can only add regular files";
    write("day1.jsonl", [
      record({ at: "2026-08-10T09:00:00Z", toolUseId: "toolu_1", body }),
      // A copy of day one's record, carried forward — same id, same day.
      record({ at: "2026-08-10T09:00:00Z", toolUseId: "toolu_1", body }),
    ]);
    write("day2.jsonl", [record({ at: "2026-08-12T09:00:00Z", toolUseId: "toolu_9", body })]);

    const out = await mod.scanDreaming({ timeZone: "UTC" });
    assert.equal(out.recurring.length, 1, "still one recurring signature");
    assert.deepEqual(out.recurring[0].days, ["2026-08-10", "2026-08-12"]);
    assert.equal(out.recurring[0].instances, 2, "two real failures, not three");
  });

  it("counts a record with no identifiers rather than dropping it", async () => {
    // The direction that over-counts: without an id there is nothing to prove
    // two records are the same, and losing a real failure is the worse error.
    const bare = (at: string) =>
      JSON.stringify({
        timestamp: at,
        sessionId: "s",
        message: { content: [{ type: "tool_result", is_error: true, content: "boom" }] },
      });
    write("bare.jsonl", [bare("2026-08-10T09:00:00Z"), bare("2026-08-10T10:00:00Z")]);

    const out = await mod.scanDreaming({ timeZone: "UTC" });
    assert.equal(out.totalInstances, 2);
  });

  it("holds the window against the reported days rather than the files read", async () => {
    write("old.jsonl", [
      record({ at: "2020-01-01T09:00:00Z", toolUseId: "toolu_old", body: "ancient" }),
    ]);
    write("new.jsonl", [
      record({ at: new Date().toISOString(), toolUseId: "toolu_new", body: "recent" }),
    ]);

    const out = await mod.scanDreaming({ timeZone: "UTC", sinceDays: 30 });
    assert.equal(out.totalInstances, 1, "the ancient one is outside the window");
    // Still walked and still stat'd: the memo is keyed on the file, and a
    // window that moved would otherwise re-read the corpus every midnight.
    assert.equal(out.filesWalked, 2);
  });
});

/** Bytes exactly as given, for the cases where the line breaks are the subject. */
function writeRaw(name: string, text: string) {
  const file = path.join(PROJECTS, name);
  fs.writeFileSync(file, text);
  mod.forgetDreamingFiles([file]);
}

/**
 * `fs.createReadStream`'s chunk size, read rather than assumed.
 *
 * The hazard below only exists at a chunk boundary, so a hard-coded 64 KiB would
 * quietly stop testing anything the day Node changed its default. The probe file
 * outlives the stream deliberately: destroying one whose open is still in flight
 * over a path that has already been unlinked raises ENOENT off the event loop,
 * where no test can catch it.
 */
function chunkSize(): number {
  const stream = fs.createReadStream(PROBE);
  const size = stream.readableHighWaterMark;
  stream.destroy();
  return size;
}

/**
 * The three ways a chunked reader can disagree with the whole-file read it
 * replaced, each of them silent.
 *
 * `readOne` reads a transcript a chunk at a time because `readFile` plus
 * `split("\n")` held two copies of every file and took the server's high-water
 * mark to 1,531 MB on a cold scan. Nothing about *what* a scan finds was meant
 * to change, and all three ways of getting that wrong leave a readout that looks
 * exactly like a correct one: no error, no throw, no failing typecheck, just a
 * different set of numbers on the pane and a different set of notes written.
 */
describe("scanDreaming reads a transcript a chunk at a time", () => {
  it("does not treat a lone carriage return as a line break", async () => {
    const alpha = record({ at: "2026-08-10T09:00:00Z", toolUseId: "toolu_a", body: "ENOENT alpha" });
    const beta = record({ at: "2026-08-10T10:00:00Z", toolUseId: "toolu_b", body: "ENOENT beta" });
    const gamma = record({ at: "2026-08-12T09:00:00Z", toolUseId: "toolu_c", body: "ENOENT gamma" });
    // `node:readline` breaks on `\r`, `\n` and `\r\n`; `split("\n")` breaks on
    // `\n` alone. So the joined pair is one unparseable line to the reader this
    // replaced and two good records to readline. Counts here feed a
    // write-on-second-sighting policy, and a reader that found records the old
    // one did not would change what gets written with nothing to say it had.
    writeRaw("cr.jsonl", `${alpha}\r${beta}\n${gamma}\n`);

    const out = await mod.scanDreaming({ timeZone: "UTC" });
    assert.equal(out.totalInstances, 1, "the CR-joined pair is one line, and it does not parse");
    assert.deepEqual(out.days, ["2026-08-12"], "and the line after it was still read");
  });

  it("keeps a multi-byte character whole across a chunk boundary", async () => {
    // Four UTF-8 bytes, laid across the boundary two and two. Decoded per chunk
    // rather than through a StringDecoder, both halves become U+FFFD — which is
    // still valid JSON, so the record parses and carries a mangled prefix into
    // `signatureOf`. One recurring failure silently becomes two that each look
    // like they happened once.
    const emoji = "🙈";
    const body = `${emoji} ENOENT open failed`;
    const first = record({ at: "2026-08-10T09:00:00Z", toolUseId: "toolu_1", body });
    const second = record({ at: "2026-08-12T09:00:00Z", toolUseId: "toolu_2", body });

    const emojiAt = Buffer.byteLength(first.slice(0, first.indexOf(emoji)));
    // `write` joins with a newline, so the record starts one byte past the filler.
    const fillerLength = chunkSize() - 2 - 1 - emojiAt;
    assert.ok(fillerLength > 0, "a record longer than a chunk cannot straddle its boundary");
    write("wide.jsonl", ["#".repeat(fillerLength), first, second]);

    const out = await mod.scanDreaming({ timeZone: "UTC" });
    assert.equal(out.totalSignatures, 1, "one failure, not one mangled and one whole");
    assert.equal(out.recurring.length, 1, "so it still spans two days and still gets written");
    assert.equal(out.recurring[0].instances, 2);
    assert.ok(out.recurring[0].sample.startsWith(emoji), "the character survives the boundary");
    assert.ok(!out.recurring[0].sample.includes("�"), "and is not replaced half at a time");
  });

  it("answers for a file it cannot open rather than failing the scan", {
    // Root reads a mode-000 file, and the assertion would pass for the wrong reason.
    skip: process.getuid?.() === 0 ? "chmod 000 does not refuse root" : undefined,
  }, async () => {
    write("good.jsonl", [
      record({ at: "2026-08-10T09:00:00Z", toolUseId: "toolu_ok", body: "ENOENT readable" }),
    ]);
    // The retention sweep really does delete a file between this scan's stat and
    // its open, and that window cannot be hit on demand. An open that fails is
    // the same catch reached through the failure a test can force.
    const shut = path.join(PROJECTS, "shut.jsonl");
    fs.writeFileSync(
      shut,
      record({ at: "2026-08-10T10:00:00Z", toolUseId: "toolu_shut", body: "ENOENT unreadable" }) +
        "\n",
    );
    fs.chmodSync(shut, 0o000);
    mod.forgetDreamingFiles([shut]);

    const out = await mod.scanDreaming({ timeZone: "UTC" });
    assert.equal(out.filesWalked, 2);
    assert.equal(out.filesRead, 1, "the unopenable one is not counted as read");
    assert.equal(out.totalInstances, 1, "and the rest of the corpus is still reported");

    // Nothing was memoised for it, so it is picked up the moment it can be
    // opened: a stamp stored against an empty parse would hide the file until
    // somebody wrote to it again.
    fs.chmodSync(shut, 0o644);
    const again = await mod.scanDreaming({ timeZone: "UTC" });
    assert.equal(again.filesRead, 1, "only the recovered file is re-read");
    assert.equal(again.totalInstances, 2);
  });
});
