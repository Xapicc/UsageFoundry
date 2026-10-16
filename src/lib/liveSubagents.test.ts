import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NO_SUBAGENTS,
  foldSubagentEvent,
  subagentSummary,
  type SubagentFold,
} from "./liveSubagents";

/**
 * The sub-agent roster on a `/runs/live` tile, as a fold over the CLI's own
 * stream.
 *
 * It earns a test because every way of being wrong renders a tile that looks
 * right: a sub-agent missing from it reads as a run that delegated nothing, one
 * that never leaves it reads as a delegation still at work, and a heartbeat
 * counted as a sub-agent is a run that looks busier than it is. The clearing at
 * a cycle's end is a line in `runIteration`, not here, and is pinned against a
 * real child in `cycleDeadline.test.ts`.
 *
 * The lines are Claude Code 2.1.280's own, captured 2026-10-16 from
 * `claude -p --output-format stream-json --verbose --forward-subagent-text`
 * against a loopback stub of the Messages API, and cut to the keys the fold
 * could read — uuids, session ids, prompts and usage are dropped. Each is keyed
 * on its offset in milliseconds from the CLI's start.
 */

type Line = [ms: number, ev: Record<string, unknown>];

const T0 = 1_792_133_300_000;

function fold(lines: readonly Line[], from: SubagentFold = NO_SUBAGENTS): SubagentFold {
  return lines.reduce((state, [ms, ev]) => foldSubagentEvent(state, ev, T0 + ms), from);
}

const agentCall = (id: string, input: Record<string, unknown>): Record<string, unknown> => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: "Agent", input }] },
  parent_tool_use_id: null,
});

const toolResult = (id: string, text: string): Record<string, unknown> => ({
  type: "user",
  message: {
    role: "user",
    content: [{ tool_use_id: id, type: "tool_result", content: [{ type: "text", text }] }],
  },
});

/** A foreground delegation whose sub-agent took 70 seconds. */
const FOREGROUND: Line[] = [
  [
    245,
    agentCall("toolu_main_agent_A", {
      description: "Slow look around",
      prompt: "SUBAGENT_MARKER_A do nothing",
      subagent_type: "general-purpose",
      run_in_background: false,
    }),
  ],
  [
    250,
    {
      type: "system",
      subtype: "task_started",
      task_id: "a93351b95e0f73c99",
      tool_use_id: "toolu_main_agent_A",
      description: "Slow look around",
      subagent_type: "general-purpose",
      is_backgrounded: false,
      spawn_depth: 1,
      task_type: "local_agent",
    },
  ],
  [
    30_249,
    {
      type: "tool_progress",
      tool_use_id: "toolu_main_agent_A-heartbeat-0",
      tool_name: "Agent",
      parent_tool_use_id: "toolu_main_agent_A",
      elapsed_time_seconds: 30,
      heartbeat: true,
    },
  ],
  [
    60_247,
    {
      type: "tool_progress",
      tool_use_id: "toolu_main_agent_A-heartbeat-1",
      tool_name: "Agent",
      parent_tool_use_id: "toolu_main_agent_A",
      elapsed_time_seconds: 60,
      heartbeat: true,
    },
  ],
  [
    70_293,
    {
      type: "system",
      subtype: "task_updated",
      task_id: "a93351b95e0f73c99",
      patch: { status: "completed", end_time: T0 + 70_290 },
    },
  ],
  [
    70_293,
    {
      type: "system",
      subtype: "task_notification",
      task_id: "a93351b95e0f73c99",
      tool_use_id: "toolu_main_agent_A",
      status: "completed",
      summary: "sub-agent done",
    },
  ],
  [70_296, toolResult("toolu_main_agent_A", "sub-agent done")],
];

/** A background delegation, launched with the flag, whose sub-agent took 35 seconds. */
const BACKGROUND: Line[] = [
  [
    248,
    agentCall("toolu_main_agent_B", {
      description: "Background look",
      prompt: "SUBAGENT_MARKER_B do nothing",
      subagent_type: "general-purpose",
      run_in_background: true,
    }),
  ],
  [
    253,
    {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "a13545673b1072458", task_type: "local_agent", description: "Background look" },
      ],
    },
  ],
  [
    254,
    {
      type: "system",
      subtype: "task_started",
      task_id: "a13545673b1072458",
      tool_use_id: "toolu_main_agent_B",
      description: "Background look",
      subagent_type: "general-purpose",
      is_backgrounded: true,
      spawn_depth: 1,
      task_type: "local_agent",
    },
  ],
  [259, toolResult("toolu_main_agent_B", "Async agent launched successfully.")],
  [
    35_276,
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "sub-agent done" }] },
      parent_tool_use_id: "toolu_main_agent_B",
    },
  ],
  [35_279, { type: "system", subtype: "background_tasks_changed", tasks: [] }],
  [
    35_279,
    {
      type: "system",
      subtype: "task_updated",
      task_id: "a13545673b1072458",
      patch: { status: "completed", end_time: T0 + 35_278 },
    },
  ],
  [
    35_280,
    {
      type: "system",
      subtype: "task_notification",
      task_id: "a13545673b1072458",
      tool_use_id: "toolu_main_agent_B",
      status: "completed",
      summary: "sub-agent done",
    },
  ],
];

/** Every line before the one at `ms`. */
const until = (lines: readonly Line[], ms: number) => lines.filter(([at]) => at < ms);

describe("a foreground delegation", () => {
  it("is on the roster from its tool_use, before any heartbeat", () => {
    // The strip's first word about this call is its heartbeat at 30 s; a
    // sub-agent that answers sooner is never on it at all.
    const summary = subagentSummary(fold(FOREGROUND.slice(0, 1)));
    assert.deepEqual(summary, {
      running: [
        {
          toolUseId: "toolu_main_agent_A",
          agentType: "general-purpose",
          description: "Slow look around",
          background: false,
          startedAt: T0 + 245,
        },
      ],
      finished: 0,
    });
  });

  it("is neither moved nor doubled by its own heartbeats", () => {
    const before = fold(until(FOREGROUND, 30_000));
    const heartbeats = FOREGROUND.filter(([, ev]) => ev.type === "tool_progress");
    const after = fold(heartbeats, before);
    // The same state, not merely an equal one: nothing to publish.
    assert.equal(after, before);
    assert.equal(subagentSummary(after).running[0].startedAt, T0 + 245);
  });

  it("ends on the CLI's word and is counted once, whatever follows", () => {
    const state = fold(FOREGROUND);
    assert.deepEqual(subagentSummary(state), { running: [], finished: 1 });
  });

  it("ends at its tool_result when the CLI filed no task for it", () => {
    // The fold's own answer for a CLI that does not write the task events,
    // which is every pin before they existed.
    const bare = FOREGROUND.filter(([, ev]) => ev.type !== "system");
    assert.deepEqual(subagentSummary(fold(bare)), { running: [], finished: 1 });
  });
});

describe("a background delegation", () => {
  it("stays on the roster after the tool_result that acknowledges its launch", () => {
    // The open-call strip's failure: the launch is answered in 5 ms and that
    // answer is what took the call off the strip.
    const summary = subagentSummary(fold(until(BACKGROUND, 35_000)));
    assert.equal(summary.running.length, 1);
    assert.equal(summary.running[0].background, true);
    assert.equal(summary.running[0].startedAt, T0 + 248);
  });

  it("is backgrounded by task_started when the call left the flag out", () => {
    // Measured, and the case the call's own input would get wrong: 2.1.280
    // backgrounded a call with no `run_in_background` at all, and its result
    // came back four milliseconds later saying the agent had launched.
    const unflagged: Line[] = BACKGROUND.map(([ms, ev]) =>
      ms === 248
        ? [
            ms,
            agentCall("toolu_main_agent_B", {
              description: "Background look",
              prompt: "SUBAGENT_MARKER_B do nothing",
              subagent_type: "general-purpose",
            }),
          ]
        : [ms, ev],
    );
    const summary = subagentSummary(fold(until(unflagged, 35_000)));
    assert.equal(summary.running.length, 1, "ended at its own launch");
    assert.equal(summary.running[0].background, true);
  });

  it("ends on task_notification", () => {
    const notifiedOnly = BACKGROUND.filter(([, ev]) => ev.subtype !== "task_updated");
    assert.deepEqual(subagentSummary(fold(notifiedOnly)), { running: [], finished: 1 });
  });

  it("is counted once when task_updated and task_notification both end it", () => {
    assert.deepEqual(subagentSummary(fold(BACKGROUND)), { running: [], finished: 1 });
  });

  it("is not ended by a snapshot that no longer lists it", () => {
    // `background_tasks_changed` lists what is live, and leaving it is how a
    // finish looks as much as how a kill does; the CLI's own words end a task.
    const emptied: Line[] = [
      ...until(BACKGROUND, 35_000),
      [36_000, { type: "system", subtype: "background_tasks_changed", tasks: [] }],
    ];
    assert.equal(subagentSummary(fold(emptied)).running.length, 1);
  });
});

describe("a heartbeat", () => {
  const opened = fold(FOREGROUND.slice(0, 2));

  it("from a tool inside a sub-agent is not a second sub-agent", () => {
    // 2.1.280 sent none for a sub-agent's blocking `Read` — only the `Agent`
    // call's own — so these are the two shapes a later pin could send: keyed
    // on the sub-agent's call, and keyed on the inner tool's own.
    const inner = [
      {
        type: "tool_progress",
        tool_use_id: "toolu_inner-heartbeat-0",
        tool_name: "Read",
        parent_tool_use_id: "toolu_main_agent_A",
        elapsed_time_seconds: 30,
      },
      {
        type: "tool_progress",
        tool_use_id: "toolu_inner-heartbeat-0",
        tool_name: "Read",
        parent_tool_use_id: "toolu_inner",
        elapsed_time_seconds: 30,
      },
    ];
    for (const ev of inner) {
      assert.equal(foldSubagentEvent(opened, ev, T0 + 31_000), opened);
    }
  });

  it("dates a delegation it is the first word of from its elapsed figure", () => {
    const [, heartbeat] = FOREGROUND[2];
    const summary = subagentSummary(fold([[30_249, heartbeat]]));
    assert.equal(summary.running[0].startedAt, T0 + 30_249 - 30_000);
  });

  it("leaves one with no elapsed figure undated rather than dating it now", () => {
    // `runTasks.ts`'s rule: a start nobody saw is not the moment this process
    // first heard of it.
    const [, heartbeat] = FOREGROUND[2];
    const { elapsed_time_seconds: _elapsed, ...undated } = heartbeat;
    const summary = subagentSummary(fold([[30_249, undated]]));
    assert.equal(summary.running.length, 1);
    assert.equal(summary.running[0].startedAt, null);
  });
});

describe("the summary", () => {
  it("puts the longest-running first and an undated one last", () => {
    const state = fold([
      [100, { ...FOREGROUND[2][1], elapsed_time_seconds: undefined }],
      [
        200,
        {
          type: "system",
          subtype: "task_started",
          task_id: "t-late",
          tool_use_id: "toolu_late",
          task_type: "local_agent",
          is_backgrounded: true,
        },
      ],
      [300, agentCall("toolu_early", { subagent_type: "Explore", description: "Find it" })],
      [
        400,
        { ...FOREGROUND[2][1], parent_tool_use_id: "toolu_older", elapsed_time_seconds: 60 },
      ],
    ]);
    assert.deepEqual(
      subagentSummary(state).running.map((a) => a.toolUseId),
      ["toolu_older", "toolu_late", "toolu_early", "toolu_main_agent_A"],
    );
  });

  it("does not take a backgrounded shell for a sub-agent", () => {
    const shell = fold([
      [
        100,
        {
          type: "system",
          subtype: "task_started",
          task_id: "b1",
          tool_use_id: "toolu_bash",
          task_type: "local_bash",
          description: "npm run build",
        },
      ],
    ]);
    assert.equal(shell, NO_SUBAGENTS);
  });
});
