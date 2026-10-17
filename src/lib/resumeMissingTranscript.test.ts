import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";

/**
 * What a run picked up on a session whose transcript is gone does next.
 *
 * The pinned CLI deletes its own transcripts 30 days after they were last
 * written, and nothing in this app sets that or hears about it, so
 * `runs.session_id` can outlive the file it names. Every pick-up of such a run
 * used to put `--resume` on the argv, be charged a cycle the CLI refused with
 * "No conversation found", and end `failed` on a bare exit code — the same way
 * on every pick-up, with nothing on the row ever changing. The fix is a
 * decision taken in `startRun` before the spawn, so it drives real segments
 * through `startRun` and `reopenRun` against a stubbed child and reads what
 * the child was handed: an argv assertion on `buildArgs` cannot see which
 * session the loop chose, and `nextPrompt` cannot see which follow-up survived.
 * And what one does when the check lets the resume through and the CLI refuses
 * it, which arrives as a zero-turn error `result` rather than as silence.
 *
 * Its own file with the environment set before anything is required, for the
 * reason every database-backed test here needs it: `config.ts` fixes `DATA_DIR`
 * and `CLAUDE_HOME` at module load.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-resume-missing-")));
fs.mkdirSync(path.join(tmp, "workspace", "project"), { recursive: true });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// Pinned rather than left to fall back to CLAUDE_HOME, `orchestrator.test.ts`'s
// rule: an ambient one puts a real OAuth token within reach of anything here
// that reads plan usage.
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

const { createRun, getRun, reopenRun, runEvents } =
  require("./orchestrator") as typeof import("./orchestrator");
const { DEFAULT_CONTINUATION_PROMPT, DEFAULT_DONE_PUSHBACK_PROMPT } =
  require("./settings") as typeof import("./settings");
const { transcriptPresence } = require("./transcripts") as typeof import("./transcripts");
const { recordForkAttempt } = require("./contextPruning") as typeof import("./contextPruning");
const { db } = require("./db") as typeof import("./db");

// One project directory holding a transcript nobody resumes, so the tree is
// a populated one: an empty tree is answered as unknown, which resumes.
const projectDir = path.join(config.PROJECTS_DIR, "-workspace-project");
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, "unrelated-session.jsonl"), "");

/**
 * A `--resume` the CLI refuses before any turn, as the pinned 2.1.280 answers
 * one whose transcript it cannot find: measured, stderr names the session and
 * stdout carries this one line and nothing else — no `init`, no `result` text —
 * then exit 1.
 */
const REFUSES = { refuses: true } as const;

/**
 * A reply with stream lines ahead of its text: the background-task events a
 * cycle's own log is read back from.
 */
type Streamed = { text: string; stream: unknown[] };

/** What each child the loop spawns says, in spawn order. */
let replies: Array<string | typeof REFUSES | Streamed> = [];
/** What each child was asked to `--resume`, and the prompt it was handed. */
let spawns: Array<{ resumed: string | null; prompt: string }> = [];
/** Across tests, so no two runs ever share a fresh session's id. */
let sessionsOpened = 0;

const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawn = childProcess.spawn as typeof import("node:child_process").spawn;

childProcess.spawn = (bin: string, args: readonly string[], options: unknown) => {
  // Only the work cycle is stubbed; anything else the loop starts is itself.
  if (bin !== config.CLAUDE_BIN) {
    return (realSpawn as (...a: unknown[]) => unknown)(bin, args, options);
  }
  const reply = replies[spawns.length];
  assert.ok(
    reply !== undefined,
    `the loop spawned work cycle ${spawns.length + 1}, and the script has ${replies.length}`,
  );
  const at = args.indexOf("--resume");
  const resumed = at >= 0 ? args[at + 1] : null;
  // `promptArgs` puts the prompt last, behind `--`.
  spawns.push({ resumed, prompt: args[args.length - 1] });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    // No pid, so `signalTree` skips `process.kill(-pid)`.
    pid: undefined as number | undefined,
    kill: () => true,
  });

  if (typeof reply !== "string" && "refuses" in reply) {
    const refusal = `No conversation found with session ID: ${resumed}`;
    stdout.on("end", () => {
      child.emit("exit", 1, null);
      child.emit("close", 1, null);
    });
    setImmediate(() => {
      stderr.end(`${refusal}\n`);
      stdout.end(
        `${JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          duration_ms: 0,
          duration_api_ms: 0,
          is_error: true,
          num_turns: 0,
          stop_reason: null,
          session_id: resumed,
          total_cost_usd: 0,
          permission_denials: [],
          errors: [refusal],
          result_index: 0,
        })}\n`,
      );
    });
    return child;
  }

  // The stub resumes whatever it is asked to: a transcript that is gone is the
  // loop's to notice before the spawn, and a child that failed here would only
  // make the failing-first case fail for a different reason.
  const session = resumed ?? `session-${++sessionsOpened}`;
  const text = typeof reply === "string" ? reply : reply.text;
  const events = [
    { type: "system", subtype: "init", session_id: session },
    ...(typeof reply === "string" ? [] : reply.stream),
    {
      type: "assistant",
      session_id: session,
      message: {
        id: `msg_${spawns.length}`,
        role: "assistant",
        content: [{ type: "text", text }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      type: "result",
      subtype: "success",
      session_id: session,
      result: text,
      num_turns: 1,
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ];
  // Settled on `end`, so every line has been read before `close` says so.
  stdout.on("end", () => {
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  setImmediate(() => {
    for (const e of events) stdout.write(`${JSON.stringify(e)}\n`);
    stdout.end();
  });
  return child;
};

after(() => {
  childProcess.spawn = realSpawn;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Wait for the segment in flight to end, however it ends. */
async function settled(id: string) {
  for (let i = 0; i < 1_000; i++) {
    const row = getRun(id)!;
    if (row.status !== "queued" && row.status !== "running") return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`run ${id} did not end`);
}

const TASK = "do the thing";

/**
 * One finished cycle on a fresh session, then the transcript put in the state
 * the case needs, then a pick-up — and the second spawn is what is read.
 */
async function pickUpAfterOneCycle(o: {
  firstReply: string;
  transcriptKept: boolean;
  note?: string;
}) {
  replies = [o.firstReply, "Still working."];
  spawns = [];
  const run = createRun({
    folder: "project",
    mountId: null,
    prompt: TASK,
    budget: { maxIterations: 1 },
    origin: "form",
  });
  const first = await settled(run.id);
  assert.equal(first.status, "completed", first.stop_reason ?? "");
  const session = first.session_id;
  assert.ok(session, "the fixture's first cycle must leave a session to resume");
  if (o.transcriptKept) fs.writeFileSync(path.join(projectDir, `${session}.jsonl`), "");

  const reopened = reopenRun(run.id, { maxIterations: 2 }, o.note);
  assert.ok(reopened.ok, JSON.stringify(reopened));
  const row = await settled(run.id);
  assert.equal(spawns.length, 2, "one cycle before the pick-up and one after it, no retry");
  return { row, session, picked: spawns[1] };
}

const PRIOR_WORK = "A previous attempt at this task already ran 1 work cycle";

describe("a pick-up whose session's transcript is gone", () => {
  it("starts over from the task instead of resuming", async () => {
    const { row, session, picked } = await pickUpAfterOneCycle({
      firstReply: "Still working.",
      transcriptKept: false,
    });

    assert.equal(picked.resumed, null, "a session with no transcript must not be resumed");
    assert.ok(picked.prompt.includes(PRIOR_WORK), picked.prompt);
    assert.ok(picked.prompt.includes(TASK), picked.prompt);
    // Not the failure the resume used to end in, and charged one cycle, not two.
    assert.equal(row.status, "completed", row.stop_reason ?? "");
    assert.equal(row.iterations, 2);
    assert.notEqual(row.session_id, session, "the run is on the conversation it opened");
    assert.ok(
      runEvents(row.id).events.some(
        (e) => e.kind === "log" && String(e.payload.message).includes(session),
      ),
      "the run's own log names the session it could not resume",
    );
  });

  it("keeps the operator's note, after the task", async () => {
    const note = "Also update the README.";
    const { picked } = await pickUpAfterOneCycle({
      firstReply: "Still working.",
      transcriptKept: false,
      note,
    });

    assert.equal(picked.resumed, null);
    assert.ok(picked.prompt.includes(PRIOR_WORK), picked.prompt);
    assert.ok(
      picked.prompt.indexOf(TASK) < picked.prompt.indexOf(note),
      `the note follows the task: ${picked.prompt}`,
    );
  });

  it("drops a notice this app wrote for the conversation that is gone", async () => {
    // A run whose agent said DONE is picked up with the DONE pushback, which
    // tells it that it reported the task complete — in a conversation that no
    // longer exists, ahead of a task it is being handed afresh.
    const { row, picked } = await pickUpAfterOneCycle({
      firstReply: "All finished.\n\nDONE",
      transcriptKept: false,
    });

    assert.equal(picked.resumed, null);
    assert.ok(picked.prompt.includes(PRIOR_WORK), picked.prompt);
    assert.ok(
      !picked.prompt.includes(DEFAULT_DONE_PUSHBACK_PROMPT),
      `the pushback was written for the session: ${picked.prompt}`,
    );
    assert.equal(row.follow_up, null);
  });
});

describe("a pick-up whose session's transcript is there", () => {
  it("resumes it exactly as before", async () => {
    const { session, picked } = await pickUpAfterOneCycle({
      firstReply: "Still working.",
      transcriptKept: true,
    });

    assert.equal(picked.resumed, session);
    // The continuation, with the stop contract `nextPrompt` puts after it, and
    // nothing of the restart: the task is not sent into a conversation that
    // already holds it.
    assert.ok(picked.prompt.startsWith(DEFAULT_CONTINUATION_PROMPT), picked.prompt);
    assert.ok(!picked.prompt.includes(TASK), picked.prompt);
  });

  it("still sends the DONE pushback into it", async () => {
    const { session, picked } = await pickUpAfterOneCycle({
      firstReply: "All finished.\n\nDONE",
      transcriptKept: true,
    });

    assert.equal(picked.resumed, session);
    assert.ok(picked.prompt.includes(DEFAULT_DONE_PUSHBACK_PROMPT), picked.prompt);
  });
});

describe("a pick-up the CLI refuses to resume", () => {
  it("retries once and then names the command that resumes it by hand", async () => {
    // The transcript is kept, so the check before the spawn resumes and the
    // refusal is the CLI's own — the shape every refusal that check cannot see
    // arrives in.
    replies = ["Still working.", REFUSES, REFUSES];
    spawns = [];
    const run = createRun({
      folder: "project",
      mountId: null,
      prompt: TASK,
      budget: { maxIterations: 1 },
      origin: "form",
    });
    const first = await settled(run.id);
    const session = first.session_id;
    assert.ok(session, "the fixture's first cycle must leave a session to resume");
    fs.writeFileSync(path.join(projectDir, `${session}.jsonl`), "");

    const reopened = reopenRun(run.id, { maxIterations: 2 });
    assert.ok(reopened.ok, JSON.stringify(reopened));
    const row = await settled(run.id);

    // A result arrived, so the loop read the refusal as a cycle that worked
    // and failed: no retry, and a stop reason naming only the exit code.
    assert.deepEqual(
      spawns.map((s) => s.resumed),
      [null, session, session],
      "the refused resume is retried once, on the same session",
    );
    assert.equal(row.status, "failed");
    assert.equal(row.ending_code, "resume_failed");
    assert.ok(row.stop_reason?.includes(`claude --resume ${session}`), row.stop_reason ?? "");
    assert.equal(row.iterations, 2, "the attempt the retry replaced is not charged");
  });
});

/**
 * One finished cycle, then a pick-up whose first resume the CLI refuses and
 * whose retry it accepts — and what the retry was handed is what is read.
 *
 * The pick-up's message is cleared at the spawn, on the premise that a spawned
 * cycle delivered it. A zero-turn refusal delivered nothing, and the retry used
 * to be sent the plain continuation: the operator's note never reached any
 * model, and a run that had said DONE was billed a cycle that said it again.
 */
async function pickUpRefusedOnce(o: {
  firstReply: string | Streamed;
  note?: string;
  /** The run adopted a fork at that boundary and never resumed it. */
  forked?: boolean;
}) {
  replies = [o.firstReply, REFUSES, "Still working."];
  spawns = [];
  const run = createRun({
    folder: "project",
    mountId: null,
    prompt: TASK,
    budget: { maxIterations: 1 },
    origin: "form",
  });
  const first = await settled(run.id);
  assert.equal(first.status, "completed", first.stop_reason ?? "");
  const session = first.session_id;
  assert.ok(session, "the fixture's first cycle must leave a session to resume");
  fs.writeFileSync(path.join(projectDir, `${session}.jsonl`), "");
  let picked = session;
  if (o.forked) {
    // As the boundary leaves it: the fork's row with no verdict, and the run
    // on the fork's id, which is what `startRun` recovers the rollback from.
    picked = `${session}-fork`;
    const fork = {
      written: true,
      newSessionId: picked,
      out: path.join(projectDir, `${picked}.jsonl`),
      refusedBy: null,
      reason: null,
      removedBytes: 24_029,
      netBytes: 22_725,
      suffixBytes: 122_902,
      breakEvenTurns: 82.8,
      coldAgeSeconds: 12.5,
    };
    assert.ok(recordForkAttempt(run.id, session, fork, 0, "boundary", null, null));
    db().prepare("UPDATE runs SET session_id = ? WHERE id = ?").run(picked, run.id);
  }

  const reopened = reopenRun(run.id, { maxIterations: 2 }, o.note);
  assert.ok(reopened.ok, JSON.stringify(reopened));
  const row = await settled(run.id);
  assert.deepEqual(
    spawns.map((s) => s.resumed),
    [null, picked, session],
    o.forked
      ? "the refused fork rolls back to the conversation it was cut from"
      : "the refused resume is retried once, on the same session",
  );
  return { row, refused: spawns[1], retried: spawns[2] };
}

describe("a pick-up the CLI refuses once and then resumes", () => {
  it("delivers the operator's note on the retry", async () => {
    const note = "Also update the README.";
    const { row, refused, retried } = await pickUpRefusedOnce({
      firstReply: "Still working.",
      note,
    });

    assert.equal(refused.prompt, note, "the refused attempt was handed the note");
    assert.equal(retried.prompt, note, "the retry carries the note the refusal never delivered");
    assert.equal(row.status, "completed", row.stop_reason ?? "");
    assert.equal(row.iterations, 2, "the refused attempt is not charged");
    assert.equal(row.follow_up, null, "delivered once, by the cycle that ran");
  });

  it("delivers the DONE pushback on the retry", async () => {
    const { refused, retried } = await pickUpRefusedOnce({ firstReply: "All finished.\n\nDONE" });

    assert.ok(refused.prompt.includes(DEFAULT_DONE_PUSHBACK_PROMPT), refused.prompt);
    assert.ok(
      retried.prompt.includes(DEFAULT_DONE_PUSHBACK_PROMPT),
      `the retry was sent: ${retried.prompt}`,
    );
    assert.ok(!retried.prompt.startsWith(DEFAULT_CONTINUATION_PROMPT), retried.prompt);
  });

  it("delivers the operator's note on the conversation a refused fork rolls back to", async () => {
    const note = "Also update the README.";
    const { row, refused, retried } = await pickUpRefusedOnce({
      firstReply: "Still working.",
      note,
      forked: true,
    });

    assert.equal(refused.prompt, note);
    assert.equal(retried.prompt, note, "the rollback carries the note the refusal never delivered");
    assert.equal(row.follow_up, null);
  });

  it("tells the retry which background tasks the last cycle left stopped", async () => {
    // No note and no DONE, so the pick-up writes no follow-up and the note is
    // read off the log at the spawn — where the refused attempt's own
    // `iteration` event is the boundary by the time the retry asks.
    const { refused, retried } = await pickUpRefusedOnce({
      firstReply: {
        text: "Still working.",
        stream: [
          {
            type: "system",
            subtype: "task_started",
            task_id: "a1",
            tool_use_id: "toolu_a1",
            description: "bg sleeper",
            subagent_type: "general-purpose",
            is_backgrounded: true,
            task_type: "local_agent",
          },
          {
            type: "system",
            subtype: "task_updated",
            task_id: "a1",
            patch: { status: "killed", end_time: 1 },
          },
          {
            type: "system",
            subtype: "task_notification",
            task_id: "a1",
            tool_use_id: "toolu_a1",
            status: "stopped",
            output_file: "/tmp/tasks/a1.output",
            summary: "bg sleeper",
          },
        ],
      },
    });

    assert.ok(refused.prompt.includes("bg sleeper"), refused.prompt);
    assert.ok(retried.prompt.includes("bg sleeper"), `the retry was sent: ${retried.prompt}`);
  });
});

/**
 * The walk's answer, which is the only thing standing between a conversation on
 * disk and a run that restarts on top of it. Every wrong `absent` throws one
 * away in silence; a wrong `present` is the old failure, which at least names
 * itself.
 */
describe("transcriptPresence", () => {
  const tree = ["/p/-a/other.jsonl", "/p/-b/mine.jsonl"];

  it("is present when one file is named for the session", () => {
    assert.equal(transcriptPresence(tree, false, "mine"), "present");
  });

  it("is present when two are, which resolving refuses and resuming does not", () => {
    assert.equal(
      transcriptPresence([...tree, "/p/-c/mine.jsonl"], false, "mine"),
      "present",
    );
  });

  it("is present when found, even if part of the walk failed", () => {
    assert.equal(transcriptPresence(tree, true, "mine"), "present");
  });

  it("is absent only from a populated tree that was read whole", () => {
    assert.equal(transcriptPresence(tree, false, "gone"), "absent");
  });

  it("is unknown when a directory could not be read", () => {
    assert.equal(transcriptPresence(tree, true, "gone"), "unknown");
  });

  it("is unknown when the tree holds no transcripts at all", () => {
    assert.equal(transcriptPresence([], false, "gone"), "unknown");
  });

  it("matches the whole basename, not a prefix or a suffix", () => {
    assert.equal(
      transcriptPresence(["/p/-a/mine.jsonl.bak", "/p/-a/not-mine.jsonl"], false, "mine"),
      "absent",
    );
  });
});
