import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RunEventDTO } from "./apiTypes";
import {
  describeEvent,
  folderHolder,
  logFilterActive,
  matchesLogFilter,
  parkTrigger,
  stopCause,
  toolArgs,
  type LogFilter,
} from "./logLine";

/**
 * How a `log` row is set, which is the one event kind whose text this app did
 * not write.
 *
 * Every other row in the feed comes from a branch in this process, so what it
 * says is decided beside the code that decides it. A `log` row is whatever a
 * child wrote to stderr — a build, a compiler, or a plugin registered through
 * `--plugin-dir`, whose hooks' stderr is its only channel back to the operator.
 * Telling the last of those from the first two is a judgement made on the text
 * alone, and both directions of getting it wrong are silent: a plugin's report
 * buried in a build reads as noise, and a compiler's line wearing a plugin's
 * name says something ran that never did.
 *
 * No `DATA_DIR` dance ahead of the import, unlike `retention.test.ts` beside
 * it: `logLine.ts` is client-safe and reaches no module that binds a path.
 */

/** A `log` event as the stream reader hands one over. */
function logEvent(message: string, truncatedFrom?: number): RunEventDTO {
  return {
    id: 1,
    runId: "r",
    ts: 0,
    kind: "log",
    payload: truncatedFrom === undefined ? { message } : { message, truncatedFrom },
  };
}

describe("describeEvent — a plugin's line on stderr", () => {
  it("labels a recognised prefix and does not say it twice", () => {
    const entry = describeEvent(
      logEvent("winnow: team state checkpointed to /home/node/.winnow/team-checkpoint.md"),
    );

    assert.deepEqual(entry, {
      voice: "system",
      tone: "accent",
      label: "winnow",
      text: "team state checkpointed to /home/node/.winnow/team-checkpoint.md",
    });
  });

  it("sets a refusal in the same tone as a success", () => {
    // The prefix carries both and this file cannot tell them apart, so `ok`
    // would dress a refusal as a job done and `warn` would do the reverse. What
    // the row claims is who spoke.
    const entry = describeEvent(logEvent("winnow: refused: guard would terminate this session (§8.3)"));

    assert.equal(entry?.tone, "accent");
    assert.equal(entry?.label, "winnow");
    assert.equal(entry?.text, "refused: guard would terminate this session (§8.3)");
  });

  it("strips the prefix from every line of a chunk that carries it", () => {
    // stderr reaches `run_events` one chunk per row rather than one line, so a
    // hook that wrote twice inside one tick arrives as a single row.
    const entry = describeEvent(logEvent("winnow: PreCompact fired\nwinnow: no session to checkpoint"));

    assert.equal(entry?.label, "winnow");
    assert.equal(entry?.text, "PreCompact fired\nno session to checkpoint");
  });

  it("still marks a labelled line that was cut for storage", () => {
    const entry = describeEvent(logEvent("winnow: team state checkpointed", 12_000));

    assert.equal(entry?.label, "winnow");
    assert.equal(entry?.text, "team state checkpointed · line shortened for storage");
  });
});

describe("describeEvent — what is not a plugin", () => {
  // Every one of these is ordinary output from something a run builds with, and
  // each has the shape a `<word>: ` pattern would have matched. A rule that
  // labels them is worse than no rule: it answers "did the plugin run" with a
  // yes it invented.
  const buildOutput = [
    "error: could not resolve './missing' from 'src/index.ts'",
    "warning: 1 moderate severity vulnerability",
    "note: this error originates in a macro",
    "TypeError: undefined is not a function",
    "src/lib/windows.ts:412:7 - error TS2345: argument of type 'null'",
    "fatal: not a git repository",
  ];

  for (const line of buildOutput) {
    it(`leaves \`${line.slice(0, 28)}…\` unlabelled and neutral`, () => {
      assert.deepEqual(describeEvent(logEvent(line)), {
        voice: "system",
        tone: "neutral",
        label: null,
        text: line,
      });
    });
  }

  it("does not attribute a plugin this build has not heard of", () => {
    // The closed list, stated as a test: a name nobody added renders as it did
    // before any of this existed, which is the cheap direction to be wrong in.
    const entry = describeEvent(logEvent("cozempic: pruned 3 transcripts"));

    assert.equal(entry?.label, null);
    assert.equal(entry?.tone, "neutral");
    assert.equal(entry?.text, "cozempic: pruned 3 transcripts");
  });

  it("needs the space after the colon, so a path stays a path", () => {
    const entry = describeEvent(logEvent("winnow:/home/node/.winnow is not writable"));

    assert.equal(entry?.label, null);
    assert.equal(entry?.tone, "neutral");
  });

  it("attributes a bare prefix to nobody rather than rendering a blank row", () => {
    // A blank `text` means "a tool call that carried no arguments" everywhere
    // else in this file, so the prefix is kept and the row stays a build line.
    const entry = describeEvent(logEvent("winnow: "));

    assert.equal(entry?.label, null);
    assert.equal(entry?.text, "winnow: ");
  });

  it("still drops the CLI's own chatter and an empty row", () => {
    assert.equal(describeEvent(logEvent("system: initialising session")), null);
    assert.equal(describeEvent(logEvent("")), null);
  });

  it("gives a cycle's init one line saying which MCP servers it got, and drops every other system event", () => {
    const init = (raw: unknown): RunEventDTO => ({
      id: 1,
      runId: "r",
      ts: 0,
      kind: "log",
      payload: { message: "system:init", raw },
    });
    assert.deepEqual(
      describeEvent(
        init({
          tools: ["mcp__uf__list_my_tasks"],
          mcp_servers: [
            { name: "uf", status: "connected", source: "dynamic" },
            { name: "daiveloper", status: "failed", source: "user" },
          ],
        }),
      ),
      { voice: "system", tone: "neutral", label: "MCP servers", text: "uf 1 tool · failed: daiveloper" },
    );
    assert.equal(describeEvent(init({ subtype: "init" })), null, "an init without a server list says nothing");
    assert.equal(describeEvent(logEvent("system:hook_started")), null);
  });
});

/**
 * Which lines a narrowed log keeps.
 *
 * The failure is the one this whole surface exists to prevent, and it is
 * silent in the worst direction: a filter that drops a line the run wrote
 * answers "did anything fail here" with a no it invented, and a log that hides
 * a line is indistinguishable from a run that never wrote one. Two facts carry
 * that and neither is visible from the page — a failed tool call renders as a
 * *system* row, so grouping on the rendered voice would file it away from the
 * tool calls it belongs with; and the group map is exhaustive over
 * `RunEventDTO["kind"]`, so a kind added later cannot quietly belong to
 * nothing.
 */
/** A `tool` event, as a work cycle's stream reader or `review.ts` hands one over. */
function toolEvent(payload: Record<string, unknown>): RunEventDTO {
  return { id: 1, runId: "r", ts: 0, kind: "tool", payload };
}

/**
 * Who made a tool call, which the row has to say when it was not the run.
 *
 * The same judgement the plugin cases above are about, on the one kind where
 * getting it wrong is silent in the expensive direction: an assist's calls land
 * *interleaved* with the run's own — a check reads the branch while the run
 * that asked for it is still mid-cycle — so an unattributed `Grep` does not
 * look like a missing label, it looks like the run reading a file it never
 * opened. Nothing else in the feed distinguishes the two.
 */
describe("describeEvent — a tool call somebody else made", () => {
  it("names the assist that made it, by the word the log already uses", () => {
    for (const [assist, word] of [
      ["validate", "check"],
      ["review", "review"],
      ["resolve", "resolve"],
    ] as const) {
      const entry = describeEvent(
        toolEvent({ name: "Grep", input: { pattern: "readBullets" }, assist }),
      );
      assert.equal(entry?.label, `${word} › Grep`);
      assert.equal(entry?.voice, "tool");
    }
  });

  it("leaves the run's own call unlabelled and keeps a sub-agent's name", () => {
    assert.equal(describeEvent(toolEvent({ name: "Grep", input: {} }))?.label, "Grep");
    assert.equal(
      describeEvent(
        toolEvent({ name: "Grep", input: {}, parentToolUseId: "t1", subagent: "Explore" }),
      )?.label,
      "Explore › Grep",
    );
  });
});

describe("toolArgs — an object with nothing to say", () => {
  it("renders no own keys as blank, not the literal '{}'", () => {
    // The true statement about a tool declared with no parameters, and the
    // one the caller already treats as no body at all (`Log.tsx`'s `tool`
    // branch guards the args span on `entry.text &&`).
    assert.equal(toolArgs({}), "");
  });

  it("still renders raw JSON when nothing present is a headline field", () => {
    // Losing this would hide the call rather than describe it: the JSON is
    // the only thing the reader has for it.
    const input = { count: 3, force: true };
    assert.equal(toolArgs(input), JSON.stringify(input));
  });
});

describe("describeEvent — an MCP tool's wire name", () => {
  it("qualifies the tool's own name by its server, in words", () => {
    const entry = describeEvent(toolEvent({ name: "mcp__uf__list_my_tasks", input: {} }));
    assert.equal(entry?.label, "uf:list_my_tasks");
    // No headline field and no other field at all: a genuinely blank call.
    assert.equal(entry?.text, "");
  });

  it("keeps the sub-agent attribution ahead of the server-qualified name", () => {
    const entry = describeEvent(
      toolEvent({
        name: "mcp__uf__list_my_tasks",
        input: {},
        parentToolUseId: "t1",
        subagent: "Explore",
      }),
    );
    assert.equal(entry?.label, "Explore › uf:list_my_tasks");
  });
});

describe("matchesLogFilter", () => {
  const toolCall: RunEventDTO = {
    id: 1,
    runId: "r",
    ts: 0,
    kind: "tool",
    payload: { name: "Bash", input: { command: "npm run typecheck" } },
  };
  const toolFailure: RunEventDTO = {
    id: 2,
    runId: "r",
    ts: 0,
    kind: "tool_error",
    payload: { name: "Bash", command: "npm ci", text: "exit 1" },
  };
  const said: RunEventDTO = {
    id: 3,
    runId: "r",
    ts: 0,
    kind: "assistant",
    payload: { text: "I have finished the typecheck" },
  };
  const notice: RunEventDTO = {
    id: 4,
    runId: "r",
    ts: 0,
    kind: "status",
    payload: { status: "paused", message: "waiting out the window" },
  };

  /** The page's own pairing: the event's kind and the line it rendered as. */
  const keeps = (e: RunEventDTO, filter: LogFilter): boolean => {
    const entry = describeEvent(e);
    assert.ok(entry, "the fixture must render a line");
    return matchesLogFilter(e.kind, entry, filter);
  };

  it("keeps a failed tool call under tool calls, not only under problems", () => {
    // `describeEvent` sets `tool_error` as a system row with a danger tone,
    // which is why the filter reads the event kind. Grouped on the voice, an
    // operator narrowing to tool calls would see every call except the ones
    // that failed.
    assert.equal(keeps(toolFailure, { query: "", kind: "tool" }), true);
    assert.equal(keeps(toolFailure, { query: "", kind: "problem" }), true);
    assert.equal(keeps(toolFailure, { query: "", kind: "app" }), false);
  });

  it("separates the agent's words from this app's notices", () => {
    assert.equal(keeps(said, { query: "", kind: "agent" }), true);
    assert.equal(keeps(said, { query: "", kind: "app" }), false);
    assert.equal(keeps(notice, { query: "", kind: "app" }), true);
    assert.equal(keeps(notice, { query: "", kind: "agent" }), false);
  });

  it("counts a warning tone as a problem whatever kind carried it", () => {
    // A parked run is a `status` row at `warn`, so "warnings and failures"
    // crosses the kinds rather than naming one of them.
    assert.equal(keeps(notice, { query: "", kind: "problem" }), true);
    assert.equal(keeps(toolCall, { query: "", kind: "problem" }), false);
  });

  it("matches the body and the label, case-insensitively", () => {
    assert.equal(keeps(toolCall, { query: "TYPECHECK", kind: "all" }), true);
    assert.equal(keeps(toolCall, { query: "bash", kind: "all" }), true);
    assert.equal(keeps(toolCall, { query: "eslint", kind: "all" }), false);
  });

  it("applies the kind and the text together, never either alone", () => {
    assert.equal(keeps(said, { query: "typecheck", kind: "agent" }), true);
    // The words are in the agent's line, not in a tool call.
    assert.equal(keeps(said, { query: "typecheck", kind: "tool" }), false);
    assert.equal(keeps(toolCall, { query: "finished", kind: "tool" }), false);
  });

  it("is off when neither half asks for anything", () => {
    assert.equal(logFilterActive({ query: "", kind: "all" }), false);
    assert.equal(logFilterActive({ query: "   ", kind: "all" }), false);
    assert.equal(logFilterActive({ query: "npm", kind: "all" }), true);
    assert.equal(logFilterActive({ query: "", kind: "tool" }), true);
    // Whitespace is not a query, so a line is kept rather than matched on it.
    assert.equal(keeps(toolCall, { query: "   ", kind: "all" }), true);
  });

  it("still finds an MCP tool row by its bare name once the server prefix renders", () => {
    const mcpCall: RunEventDTO = {
      id: 5,
      runId: "r",
      ts: 0,
      kind: "tool",
      payload: { name: "mcp__uf__list_my_tasks", input: {} },
    };
    // The realistic query: an operator searching for the tool they know by name.
    assert.equal(keeps(mcpCall, { query: "list_my_tasks", kind: "all" }), true);
    // The loss this rendering accepts, pinned so a later change to the label's
    // form does not silently break the case above instead: a query typed as
    // the raw wire name no longer matches the row it names.
    assert.equal(keeps(mcpCall, { query: "mcp__uf__list_my_tasks", kind: "all" }), false);
  });
});

/** A `budget` event as the guard sites in `orchestrator.ts` emit one. */
function budgetEvent(payload: Record<string, unknown>): RunEventDTO {
  return { id: 2, runId: "r", ts: 0, kind: "budget", payload };
}

/**
 * The one refusal this app records and then carries past.
 *
 * `no_ceiling` is the ordinary state of a stock install while the provider's
 * percentage is unreadable: the verdict is a real refusal, `enforceable` is
 * false, and the run starts its next cycle anyway. Reading the row off
 * `disposition` alone puts "budget · stop" in the feed beside cycles that then
 * ran to completion — a sentence about the run that is not true, in the tone
 * reserved for what went wrong, once per cycle for as long as the outage lasts.
 * Nothing throws and the page renders, which is why it needs pinning here.
 */
describe("describeEvent — a guard verdict the run may not be ended on", () => {
  const unreadable = {
    allowed: false,
    code: "no_ceiling",
    disposition: "stop",
    enforceable: false,
    reason:
      "A weekly-fraction guard is set but that window has no reading to " +
      "measure against: the provider's own utilisation was not available.",
  };

  it("does not say a run was stopped by a guard that stopped nothing", () => {
    const entry = describeEvent(budgetEvent(unreadable));
    assert.ok(entry, "an unenforceable refusal is still a row");
    assert.doesNotMatch(entry.text, /stop/i, "nothing was stopped");
    assert.notEqual(entry.tone, "warn", "a non-event is not a warning");
    assert.match(entry.text, /could not be read/i);
    assert.match(entry.text, /carried on/i);
  });

  it("keeps it out of the reader's warnings-and-failures view", () => {
    const entry = describeEvent(budgetEvent(unreadable));
    assert.ok(entry);
    assert.equal(
      matchesLogFilter("budget", entry, { query: "", kind: "problem" }),
      false,
      "an operator asking what went wrong is not asking about this",
    );
  });

  it("still reads as a stop when the field says so, and when it is absent", () => {
    // `!== false` rather than `=== true`, for the reason `notifiableEvent` gives:
    // the two emit sites that really do end a run omit the field entirely, and
    // reading absent as unenforceable would silence every guard that ever fired.
    for (const payload of [
      { ...unreadable, code: "run_cost", enforceable: true },
      { allowed: false, code: "run_cost", disposition: "stop", reason: unreadable.reason },
    ]) {
      const entry = describeEvent(budgetEvent(payload));
      assert.ok(entry);
      assert.equal(entry.tone, "warn");
      assert.match(entry.text, /^stop — /);
    }
  });
});

describe("parkTrigger — which of the two parks put a run where it is", () => {
  const guardPark = budgetEvent({
    allowed: false,
    code: "session_fraction",
    disposition: "pause",
    reason: "5-hour window at 80%, over this run's 75%.",
  });
  // The mid-cycle guard's own emit, which carries no `enforceable` at all.
  const liveGuardPark = budgetEvent({
    allowed: false,
    live: true,
    code: "session_fraction",
    disposition: "pause",
    reason: "5-hour window at 80%, over this run's 75%.",
  });
  const refusal = (waiting: boolean): RunEventDTO => ({
    id: 3,
    runId: "r",
    ts: 0,
    kind: "error",
    payload: {
      message: "Claude AI usage limit reached",
      usageLimit: true,
      waiting,
      retrying: false,
    },
  });

  it("names the provider's refusal, which is the park a stock install gets", () => {
    assert.equal(parkTrigger([refusal(true)]), "refusal");
  });

  it("names the guard for either of its emits", () => {
    assert.equal(parkTrigger([guardPark]), "guard");
    assert.equal(parkTrigger([liveGuardPark]), "guard");
  });

  it("answers with the newest park when a run has parked both ways", () => {
    assert.equal(parkTrigger([guardPark, refusal(true)]), "refusal");
    assert.equal(parkTrigger([refusal(true), guardPark]), "guard");
  });

  it("does not credit the guard with a verdict the run carried past", () => {
    // A `no_ceiling` pause verdict is recorded and the cycle runs anyway, so a
    // later refusal park is still the refusal's.
    const carried = budgetEvent({
      allowed: false,
      code: "no_ceiling",
      disposition: "pause",
      enforceable: false,
      reason: "nothing to read",
    });
    assert.equal(parkTrigger([refusal(true), carried]), "refusal");
    assert.equal(parkTrigger([carried]), null);
  });

  it("does not read a refusal that failed the run, or a stop, as a park", () => {
    assert.equal(parkTrigger([refusal(false)]), null);
    assert.equal(
      parkTrigger([
        budgetEvent({ allowed: false, code: "run_cost", disposition: "stop", reason: "x" }),
      ]),
      null,
    );
  });

  it("says nothing before the events that would say have arrived", () => {
    assert.equal(parkTrigger([]), null);
  });
});

describe("stopCause — whether a window guard or a limit ended a run", () => {
  const stop = (code: string, extra: Record<string, unknown> = {}) =>
    budgetEvent({ allowed: false, code, disposition: "stop", reason: "x", ...extra });

  it("names the guard for either window, and for the mid-cycle emit", () => {
    assert.equal(stopCause([stop("weekly_fraction")]), "guard");
    assert.equal(stopCause([stop("session_fraction")]), "guard");
    assert.equal(stopCause([stop("weekly_fraction", { live: true })]), "guard");
  });

  it("names a limit for every other code the run was ended on", () => {
    for (const code of [
      "iterations",
      "duration",
      "run_cost",
      "run_cost_outlier",
      "run_tokens",
      "no_terminus",
    ]) {
      assert.equal(stopCause([stop(code)]), "limit", code);
    }
  });

  it("names where the limit lives when the reopen form cannot raise it", () => {
    // Resuming with more room is advice about this run's own limits; these two
    // are set in Settings and in the workflow, and a resume carries them over.
    assert.equal(stopCause([stop("install_cost", { scope: "install" })]), "install_limit");
    assert.equal(stopCause([stop("instance_cost", { scope: "workflow" })]), "workflow_limit");
    assert.equal(stopCause([stop("install_cost"), stop("run_cost")]), "limit");
    assert.equal(stopCause([stop("run_cost"), stop("install_cost")]), "install_limit");
  });

  it("does not credit anything with a verdict the run carried past", () => {
    // A `no_ceiling` stop verdict is recorded with `enforceable: false` and the
    // next cycle starts anyway, so a later operator stop is nobody's guard.
    const carried = stop("no_ceiling", { enforceable: false });
    assert.equal(stopCause([carried]), null);
    assert.equal(stopCause([stop("run_cost"), carried]), "limit");
  });

  it("does not read a park as a stop", () => {
    assert.equal(
      stopCause([
        budgetEvent({
          allowed: false,
          code: "session_fraction",
          disposition: "pause",
          reason: "x",
        }),
      ]),
      null,
    );
  });

  it("answers with the newest stop when a reopened run carries an earlier one", () => {
    assert.equal(stopCause([stop("run_cost"), stop("weekly_fraction")]), "guard");
    assert.equal(stopCause([stop("weekly_fraction"), stop("iterations")]), "limit");
  });
});

describe("folderHolder — a parked run the sweeper is holding for its folder", () => {
  const status = (value: string): RunEventDTO => ({
    id: 4,
    runId: "r",
    ts: 0,
    kind: "status",
    payload: { status: value },
  });
  const waitingFor = (holder: string): RunEventDTO => ({
    id: 5,
    runId: "r",
    ts: 0,
    kind: "log",
    payload: { message: "Waiting for the folder.", waitingFor: holder },
  });
  const now = 1_000_000;
  const past = now - 60_000;

  it("names the run in the folder once the sweep has held this one", () => {
    const held = [status("paused"), waitingFor("occupant")];
    assert.equal(folderHolder(held, past, now), "occupant");
    assert.equal(folderHolder(held, null, now), "occupant");
  });

  it("holds from the instant the run is due, which is when the sweep looks", () => {
    assert.equal(folderHolder([status("paused"), waitingFor("occupant")], now, now), "occupant");
  });

  it("reads nothing while the run is still waiting for its window", () => {
    // Parked, not yet swept: the park is the newest thing that happened.
    assert.equal(folderHolder([waitingFor("occupant"), status("paused")], past, now), null);
  });

  it("drops a hold the sweep has since re-parked for the window", () => {
    // That write moves `resume_at` ahead and emits nothing.
    assert.equal(
      folderHolder([status("paused"), waitingFor("occupant")], now + 60_000, now),
      null,
    );
  });

  it("does not carry a hold from an earlier park into this one", () => {
    const events = [
      status("paused"),
      waitingFor("earlier"),
      status("queued"),
      status("running"),
      status("paused"),
    ];
    assert.equal(folderHolder(events, past, now), null);
  });

  it("does not read the queue wait logged at creation as a hold", () => {
    const events = [status("queued"), waitingFor("ahead"), status("running"), status("paused")];
    assert.equal(folderHolder(events, past, now), null);
  });

  it("looks past ordinary lines to the hold", () => {
    const events = [status("paused"), waitingFor("occupant"), logEvent("npm test")];
    assert.equal(folderHolder(events, past, now), "occupant");
  });

  it("says nothing before the events that would say have arrived", () => {
    assert.equal(folderHolder([], past, now), null);
  });
});

/**
 * A purge row is the run's only record of what was destroyed. `purgeBranch`
 * writes either count as null when git would not give it, and a row that
 * printed that as "null commits" — or as 0, which is what the counts used to be
 * — says the one irreversible press cost nothing.
 */
describe("describeEvent — a purge whose counts could not be taken", () => {
  const purgeEvent = (payload: Record<string, unknown>): RunEventDTO => ({
    id: 3,
    runId: "r",
    ts: 0,
    kind: "land",
    payload: { branch: "uf/x", deleted: true, purged: true, ...payload },
  });

  it("states the counts it has", () => {
    const entry = describeEvent(purgeEvent({ commits: 3, discarded: 1 }));
    assert.equal(entry?.text, "uf/x — 3 commits and 1 uncommitted path gone");
  });

  it("says a count is missing rather than printing it", () => {
    const entry = describeEvent(purgeEvent({ commits: null, discarded: null }));
    assert.ok(entry);
    assert.doesNotMatch(entry.text, /null|\d/);
    assert.match(entry.text, /uncounted commits/);
  });
});
