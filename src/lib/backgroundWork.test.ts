import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { RunEventDTO } from "./apiTypes";
import { workedMs } from "./budget";
import {
  MAX_LISTED_TASKS,
  backgroundWaitCeiling,
  operatorBackgroundWait,
  stoppedTasksNotice,
} from "./backgroundWork";

/**
 * Both decisions here are billed and both fail silently, in opposite
 * directions.
 *
 * A note that is not written leaves an agent resuming into a conversation that
 * still says its sub-agents are working: it waits on them, ends its turn, and a
 * cycle is spent on nothing (run 350ef202, $24.45, nothing committed). A note
 * that is written about work that finished sends the agent to redo it, which is
 * the same bill for a different reason. Neither throws, and the prompt that
 * results reads as perfectly ordinary.
 *
 * The payloads are the CLI's own `system:task_*` events, as `runTasks.test.ts`
 * and the stub-server measurement in `docs/verification/run-lifecycle-background-work.md` have
 * them; the field names are not invented here.
 */

function systemEvent(
  ts: number,
  subtype: string,
  raw: Record<string, unknown>,
): RunEventDTO {
  return {
    runId: "r",
    ts,
    kind: "log",
    payload: { message: `system:${subtype}`, raw: { type: "system", subtype, ...raw } },
  };
}

const started = (
  ts: number,
  taskId: string,
  description: string,
  taskType = "local_agent",
) =>
  systemEvent(ts, "task_started", {
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    description,
    task_type: taskType,
  });

const killed = (ts: number, taskId: string) =>
  systemEvent(ts, "task_updated", { task_id: taskId, patch: { status: "killed" } });

const notified = (
  ts: number,
  taskId: string,
  status: string,
  description: string,
  outputFile = "",
) =>
  systemEvent(ts, "task_notification", {
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    status,
    summary: description,
    output_file: outputFile,
  });

describe("the note a cycle opens with after its background tasks were stopped", () => {
  it("names a sub-agent the CLI killed at its ceiling, and where its output is", () => {
    const note = stoppedTasksNotice([
      started(1, "a1", "Audit the payment module"),
      killed(9, "a1"),
      notified(9, "a1", "stopped", "Audit the payment module", "/tmp/tasks/a1.output"),
    ]);
    assert.ok(note, "a killed sub-agent produced no note");
    assert.match(note, /Audit the payment module/);
    assert.match(note, /\/tmp\/tasks\/a1\.output/);
    assert.match(note, /sub-agent/);
    // The sentence that stops the wait: the agent has to be told they are not
    // running, not merely that something ended.
    assert.match(note, /not running/);
  });

  it("is written for a task the notification alone reported stopped", () => {
    // `task_updated` and `task_notification` are two events; a log that kept
    // only the second must not read as a task nobody stopped.
    const note = stoppedTasksNotice([
      started(1, "b1", "Run the full suite", "local_bash"),
      notified(9, "b1", "stopped", "Run the full suite", "/tmp/tasks/b1.output"),
    ]);
    assert.ok(note);
    assert.match(note, /shell command "Run the full suite"/);
  });

  it("is written for a task patched killed with no notification after it", () => {
    const note = stoppedTasksNotice([
      started(1, "c1", "Index the repository"),
      killed(9, "c1"),
    ]);
    assert.ok(note);
    assert.match(note, /Index the repository/);
    assert.match(note, /wrote no output file/);
  });

  it("says nothing for a task that completed", () => {
    // The case that sends an agent to redo finished work.
    assert.equal(
      stoppedTasksNotice([
        started(1, "d1", "Audit the payment module"),
        notified(5, "d1", "completed", "Audit the payment module", "/tmp/tasks/d1.output"),
      ]),
      null,
    );
  });

  it("says nothing for a cycle that started no background task", () => {
    assert.equal(stoppedTasksNotice([]), null);
    assert.equal(
      stoppedTasksNotice([
        {
          runId: "r",
          ts: 1,
          kind: "log",
          payload: { message: "system:init", raw: { type: "system", subtype: "init" } },
        },
      ]),
      null,
    );
  });

  it("says nothing for a task whose ending never reached the log", () => {
    // A task that finishes quietly leaves the CLI's snapshot without any event
    // naming it, so "no ending" is also what finished work looks like.
    assert.equal(
      stoppedTasksNotice([
        started(1, "e1", "Watch the build", "local_bash"),
        systemEvent(2, "background_tasks_changed", {
          tasks: [{ task_id: "e1", task_type: "local_bash", description: "Watch the build" }],
        }),
      ]),
      null,
    );
  });

  it("lists only the stopped ones when others finished", () => {
    const note = stoppedTasksNotice([
      started(1, "f1", "Finished fine"),
      started(1, "f2", "Cut off at the ceiling"),
      notified(4, "f1", "completed", "Finished fine", "/tmp/f1.output"),
      killed(9, "f2"),
      notified(9, "f2", "stopped", "Cut off at the ceiling", "/tmp/f2.output"),
    ]);
    assert.ok(note);
    assert.match(note, /Cut off at the ceiling/);
    assert.doesNotMatch(note, /Finished fine/);
    assert.doesNotMatch(note, /f1\.output/);
  });

  it("keeps a model-written description to one bounded line", () => {
    const note = stoppedTasksNotice([
      started(1, "g1", `first line\nsecond line ${"x".repeat(500)}`),
      killed(9, "g1"),
    ]);
    assert.ok(note);
    const line = note.split("\n").find((l) => l.startsWith("- "));
    assert.ok(line, "the task was not listed");
    assert.match(line, /first line second line/);
    assert.ok(line.length < 400, `one task took ${line.length} characters`);
  });

  it("names a bounded number of tasks and counts the rest", () => {
    const events: RunEventDTO[] = [];
    const total = MAX_LISTED_TASKS + 3;
    for (let i = 0; i < total; i++) {
      events.push(started(i, `h${i}`, `task number ${i}`));
      events.push(killed(100 + i, `h${i}`));
    }
    const note = stoppedTasksNotice(events);
    assert.ok(note);
    assert.equal(
      note.split("\n").filter((l) => l.startsWith('- sub-agent "task number')).length,
      MAX_LISTED_TASKS,
    );
    assert.match(note, /- and 3 more/);
  });
});

describe("how long a cycle's child waits for its background sub-agents", () => {
  const MIN = 60_000;
  const NOW = 1_800_000_000_000;
  const ceiling = (o: Partial<Parameters<typeof backgroundWaitCeiling>[0]> = {}) =>
    backgroundWaitCeiling({
      operatorValue: null,
      maxDurationMinutes: null,
      startedAt: NOW - 10 * MIN,
      pausedMs: 0,
      now: NOW,
      ...o,
    });

  it("is what is left of the run's time limit", () => {
    assert.deepEqual(ceiling({ maxDurationMinutes: 60 }), {
      value: String(50 * MIN),
      source: "duration",
    });
  });

  it("counts the time the run worked, not the time it existed", () => {
    // Thirty minutes of wall clock, twenty of them parked: ten worked. Measured
    // from the wall clock this would be a ceiling of thirty minutes, and the
    // guard — which reads worked time — would let the cycle run for fifty.
    assert.equal(
      ceiling({
        maxDurationMinutes: 60,
        startedAt: NOW - 30 * MIN,
        pausedMs: 20 * MIN,
      }).value,
      String(50 * MIN),
    );
  });

  it("ends at the instant the duration guard would", () => {
    const o = { maxDurationMinutes: 60, startedAt: NOW - 17 * MIN, pausedMs: 4 * MIN };
    const ms = Number(ceiling(o).value);
    assert.ok(workedMs(o.startedAt, o.pausedMs, NOW + ms) / MIN >= 60);
    assert.ok(workedMs(o.startedAt, o.pausedMs, NOW + ms - 1_000) / MIN < 60);
  });

  it("waits without limit when no time limit is set", () => {
    assert.deepEqual(ceiling(), { value: "0", source: "unbounded" });
    // A limit that is not a number is no limit, not a limit of zero.
    assert.equal(ceiling({ maxDurationMinutes: Number.NaN }).value, "0");
    assert.equal(ceiling({ maxDurationMinutes: Number.POSITIVE_INFINITY }).value, "0");
  });

  it("never asks for 0 when a limit is set, however little is left", () => {
    // 0 is the CLI's spelling of "no ceiling", so a run whose limit is spent
    // would otherwise be handed the one value that outlives it.
    for (const startedAt of [NOW - 60 * MIN, NOW - 90 * MIN, NOW - 60 * MIN + 1]) {
      const { value, source } = ceiling({ maxDurationMinutes: 60, startedAt });
      assert.equal(source, "duration");
      assert.ok(Number(value) >= 1_000, `asked for ${value}ms`);
    }
    assert.ok(Number(ceiling({ maxDurationMinutes: 0 }).value) >= 1_000);
  });

  it("is a whole number of milliseconds, which is all the CLI's parser reads", () => {
    // "1.5" and "10s" both parse as 1 millisecond against the pinned CLI.
    const { value } = ceiling({ maxDurationMinutes: 0.0001234, startedAt: NOW });
    assert.match(String(value), /^\d+$/);
    assert.match(String(ceiling({ maxDurationMinutes: 1e12 }).value), /^\d+$/);
  });

  it("measures from the whole limit for a run that has no start yet", () => {
    assert.equal(
      ceiling({ maxDurationMinutes: 60, startedAt: null }).value,
      String(60 * MIN),
    );
  });

  it("leaves the server's own value alone, and says so", () => {
    assert.deepEqual(ceiling({ operatorValue: "120000", maxDurationMinutes: 60 }), {
      value: null,
      source: "operator",
    });
  });

  it("reads a blank value as none, as compose renders an unset one", () => {
    assert.equal(operatorBackgroundWait({}), null);
    assert.equal(operatorBackgroundWait({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "" }), null);
    assert.equal(operatorBackgroundWait({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "  " }), null);
    assert.equal(
      operatorBackgroundWait({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" }),
      "0",
    );
  });
});
