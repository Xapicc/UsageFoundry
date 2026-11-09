import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Covers two things, both about what `parseLine` hands the price lookup and
 * `costOf`, and both silent when forgotten.
 *
 * The first is that a scan prices each transcript turn at the tier its own
 * prompt earns, for a model priced by prompt length (Claude Haiku 5.5: $0.10
 * input up to a 100,000-token prompt, $0.50 over it). `parseLine` is where
 * `costOf` is handed one request's usage, and the only thing that says so is
 * the `"request"` it passes. Without it the call falls to the default, which
 * shows the short row for every turn and charges the long row to every guard —
 * so a long Haiku turn is shown at a fifth of its cost with nothing failing
 * anywhere, and a short one is refused by a guard at five times its.
 * `pricing.test.ts` pins the tiers; only a scan can tell whether this call site
 * asks for them.
 *
 * The second is that a scan prices each turn at the rate in force when it ran,
 * for a model whose rate changed on a date (Claude Sonnet 5.5's cache read:
 * 0.10x before 2026-10-08T00:00Z, 0.05x from it). `parseLine` is the one caller
 * in `src/lib/` that passes `resolvePrice` an `at`, and a call without one
 * prices every old turn at today's rate. `pricing.test.ts` pins the lookup;
 * only a scan can tell whether this call site names the instant.
 *
 * Its own file for `transcriptDedupe.test.ts`'s reason: `CLAUDE_HOME` is read
 * into `config.ts` at module load, which a file that statically imports
 * `./transcripts` cannot arrange.
 */

let transcripts: typeof import("./transcripts");
let root: string;
let projects: string;

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

/** One Haiku 5.5 turn whose prompt is `20,000 + cacheRead + 10,000` tokens. */
function record(session: string, cacheRead: number): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `u-${session}`,
    requestId: `req_${session}`,
    timestamp: new Date(NOW).toISOString(),
    sessionId: session,
    cwd: `/workspace/${session}`,
    message: {
      id: `msg_${session}`,
      model: "claude-haiku-5-5",
      usage: {
        input_tokens: 20_000,
        output_tokens: 1_000,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: 10_000,
        cache_creation: { ephemeral_5m_input_tokens: 10_000 },
      },
    },
  });
}

function write(session: string, lines: string[]): void {
  const dir = path.join(projects, session);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session}.jsonl`), `${lines.join("\n")}\n`);
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-transcript-prompt-tier-"));
  projects = path.join(root, "claude", "projects");
  fs.mkdirSync(projects, { recursive: true });
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.DATA_DIR = path.join(root, "data");

  const config = await import("./config");
  assert.equal(
    config.CLAUDE_HOME,
    process.env.CLAUDE_HOME,
    "config was already loaded by another test file in this process — refusing " +
      "to scan the real transcript tree",
  );

  transcripts = await import("./transcripts");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a scan prices a Haiku 5.5 turn by its own prompt length", () => {
  it("charges the short row at 100,000 tokens and the long row at 100,001", async () => {
    write("session-short", [record("session-short", 70_000)]);
    write("session-long", [record("session-long", 70_001)]);

    const scan = await transcripts.scanUsage();
    const short = scan.entries.find((e) => e.sessionId === "session-short");
    const long = scan.entries.find((e) => e.sessionId === "session-long");
    assert.ok(short && long, "both turns are in the scan");
    assert.equal(short.unpriced, false);

    // 20,000 input + 70,000 reads + 10,000 5m writes + 1,000 output, at the
    // short row's $0.10 / $0.01 / $0.125 / $0.50 per MTok.
    const shortUSD = (20_000 * 0.1 + 70_000 * 0.01 + 10_000 * 0.125 + 1_000 * 0.5) / 1e6;
    // One more read token tips the prompt over, and every column steps up.
    const longUSD = (20_000 * 0.5 + 70_001 * 0.05 + 10_000 * 0.625 + 1_000 * 2.5) / 1e6;
    assert.ok(Math.abs(short.costUSD - shortUSD) < 1e-12, `short turn shown at $${short.costUSD}`);
    assert.ok(Math.abs(long.costUSD - longUSD) < 1e-12, `long turn shown at $${long.costUSD}`);
    // The guard knows the prompt, so it charges what the turn cost and not the
    // ceiling it would charge a turn it could not measure.
    assert.equal(short.costGuardUSD, short.costUSD);
    assert.equal(long.costGuardUSD, long.costUSD);
  });
});

describe("a scan prices a Sonnet 5.5 turn at the rate in force when it ran", () => {
  // `SONNET_5_5_CACHE_READ_CUT_AT` in `pricing.ts`, written out again here on
  // purpose and not exported from there: if the cut moves, this has to be
  // edited by someone who has read why the pair below sits where it does.
  const CUT = Date.UTC(2026, 9, 8);

  /** One Sonnet 5.5 turn that read a million cached tokens and did nothing else. */
  function sonnetReads(session: string, ts: number): string {
    return JSON.stringify({
      type: "assistant",
      uuid: `u-${session}`,
      requestId: `req_${session}`,
      timestamp: new Date(ts).toISOString(),
      sessionId: session,
      cwd: `/workspace/${session}`,
      message: {
        id: `msg_${session}`,
        model: "claude-sonnet-5-5",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 1_000_000,
        },
      },
    });
  }

  it("charges 0.10x for a read the last millisecond before the cut and 0.05x at it", async () => {
    // The same million reads at two prices, one millisecond apart. Both sides
    // are asserted because a one-sided assertion passes on a lookup that read
    // the wall clock, whichever side of the cut the clock is on: today is past
    // the cut, so a lookup with no `at` prices the first turn at 10 cents and
    // fails here, and a clock set back before the cut would price the second
    // at 20 cents and fail here too.
    write("session-before-cut", [sonnetReads("session-before-cut", CUT - 1)]);
    write("session-at-cut", [sonnetReads("session-at-cut", CUT)]);

    const scan = await transcripts.scanUsage();
    const before = scan.entries.find((e) => e.sessionId === "session-before-cut");
    const atCut = scan.entries.find((e) => e.sessionId === "session-at-cut");
    assert.ok(before && atCut, "both turns are in the scan");
    assert.equal(before.unpriced, false);
    assert.equal(atCut.unpriced, false);

    // $2 per MTok of input, so a million reads are 20 cents at 0.10x, 10 at 0.05x.
    assert.ok(Math.abs(before.costUSD - 0.2) < 1e-12, `before the cut priced at ${before.costUSD}`);
    assert.ok(Math.abs(atCut.costUSD - 0.1) < 1e-12, `at the cut priced at ${atCut.costUSD}`);
    // The guard reads the same price, so an under-read here would also let a
    // run past a ceiling it had already reached.
    assert.equal(before.costGuardUSD, before.costUSD);
    assert.equal(atCut.costGuardUSD, atCut.costUSD);
  });
});
