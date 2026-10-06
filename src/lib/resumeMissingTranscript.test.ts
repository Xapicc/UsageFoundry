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

// One project directory holding a transcript nobody resumes, so the tree is
// a populated one: an empty tree is answered as unknown, which resumes.
const projectDir = path.join(config.PROJECTS_DIR, "-workspace-project");
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, "unrelated-session.jsonl"), "");

/** What each child the loop spawns says, in spawn order. */
let replies: string[] = [];
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

  // The stub resumes whatever it is asked to: a transcript that is gone is the
  // loop's to notice before the spawn, and a child that failed here would only
  // make the failing-first case fail for a different reason.
  const session = resumed ?? `session-${++sessionsOpened}`;
  const events = [
    { type: "system", subtype: "init", session_id: session },
    {
      type: "assistant",
      session_id: session,
      message: {
        id: `msg_${spawns.length}`,
        role: "assistant",
        content: [{ type: "text", text: reply }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      type: "result",
      subtype: "success",
      session_id: session,
      result: reply,
      num_turns: 1,
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ];
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    // No pid, so `signalTree` skips `process.kill(-pid)`.
    pid: undefined as number | undefined,
    kill: () => true,
  });
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
