import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Settings } from "../../../lib/settings";

/**
 * Every key of `Settings` survives a round trip through `PUT /api/settings`.
 *
 * The route builds its patch from an explicit `if ("<key>" in body)` branch per
 * setting, and that shape is deliberate — it is where `defaultPermissionMode`,
 * `landStrategy`, `chatDefaultGuards` and `sessionResetOverrideAt` are narrowed
 * before they reach storage, so it must not become a `{ ...body }` merge. What
 * it costs is that a *missing* branch fails in silence: the settings page sends
 * the whole object, the route answers 200 with the value it already had, and
 * the page writes that answer back over the form — so the textarea reverts
 * under a "Saved" confirmation and the setting can never be changed at all.
 * That is what happened to `continuedWorkPrompt`, for as long as it existed.
 *
 * So the test is about the class rather than that key: the table below is typed
 * against `keyof Settings`, which makes a field added to the interface a
 * compile error here until it is probed, and every probe then proves the route
 * both answers with the value and stores it. One key, one named test, so a
 * dropped branch names itself.
 *
 * A field that is deliberately not settable through this route would fail here
 * too, and that is the intended cost: `Settings` is what the settings page
 * edits, so a key it cannot save is a decision to write down rather than a
 * probe to delete.
 *
 * It opens a database for the reason the chat route's test does — the defect is
 * in a payload, so only something that reads the payload can see it. The
 * database is a throwaway directory and the run is a few milliseconds.
 */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uf-settings-route-"));
const MOUNT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uf-settings-mount-"));

// Config is fixed at boot, so the throwaway database has to be named before the
// first import of anything that reads it — hence the dynamic imports below.
process.env.DATA_DIR = DATA_DIR;
// And the mounts too: `knowledgeBaseMountId` is refused unless it names one, so
// the probe below would otherwise pass or fail on whatever this machine happens
// to have bind-mounted.
process.env.WORKSPACE_ROOTS = `Probe Vault=${MOUNT_DIR}`;

// The provider-usage cases at the bottom need a reading to keep, and
// `planUsage` fetches only once it has found a token. A throwaway credential
// rather than this machine's, so no case can reach a real account.
const CLAUDE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uf-settings-claude-"));
process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;
fs.writeFileSync(
  path.join(CLAUDE_DIR, ".credentials.json"),
  JSON.stringify({
    claudeAiOauth: { accessToken: "probe-token", expiresAt: Date.now() + 24 * 60 * 60 * 1000 },
  }),
);

after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(MOUNT_DIR, { recursive: true, force: true });
  fs.rmSync(CLAUDE_DIR, { recursive: true, force: true });
});

/**
 * What to send for one key, and what should be stored for it.
 *
 * `stored` is only spelled out where the route normalizes on the way in; where
 * it is absent the value goes in as it stands. Every value has to differ from
 * the default, or a key the route drops would still read as accepted.
 */
type Probe = { send: unknown; stored?: unknown };

// The route refuses a reset instant more than five hours ahead, so this one is
// in the past — a value it will accept rather than answer 400 for.
const RESET_AT = Date.now() - 60 * 60 * 1000;

const PROBES: Record<keyof Settings, Probe> = {
  sessionCostLimit: { send: 42.5 },
  // Trimmed on the way in, so what comes back is not what was sent.
  landVerifyCommand: { send: "  npm test  ", stored: "npm test" },
  weeklyCostLimit: { send: 300 },
  sessionTokenLimit: { send: 1_000_000 },
  weeklyTokenLimit: { send: 9_000_000 },
  weeklyAnchor: { send: { weekday: 3, hourUTC: 9 } },
  sessionResetOverrideAt: { send: RESET_AT },
  reservedHeadroomFraction: { send: 0.2 },
  planUsageFromApi: { send: false },
  defaultPermissionMode: { send: "plan" },
  defaultModel: { send: "claude-sonnet-5" },
  // Two entries rather than one: a list that differs from the seed, keeps the
  // model `defaultModel`'s probe names enabled — these probes share a database
  // and the route judges that default against whatever list is stored — and
  // carries a `[1m]` id, which is the spelling square brackets could be
  // normalized out of anywhere between the form and the row.
  modelCatalogue: {
    send: [
      { id: "claude-sonnet-5", label: "Claude Sonnet 5", enabled: true },
      { id: "claude-opus-5[1m]", label: "Claude Opus 5 (1M)", enabled: false },
    ],
  },
  // The Codex pair: the list keeps the default's model enabled for
  // `modelCatalogue`'s reason, and differs from the empty shipped default.
  codexDefaultModel: { send: "gpt-6-astra" },
  codexNetworkAccess: { send: true },
  codexRunEffort: { send: "xhigh" },
  codexModelCatalogue: {
    send: [
      { id: "gpt-6-astra", label: "GPT-6-Astra", enabled: true },
      { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", enabled: false },
    ],
  },
  // Filled in by the hook below: the route refuses an id that names no usable
  // agent, so this is the one probe whose value has to exist in the database
  // before it can be sent.
  defaultAgentId: { send: null },
  continuationPrompt: { send: "CHANGED continuation" },
  includeSidechains: { send: false },
  forwardSubAgentText: { send: false },
  runEffort: { send: "xhigh" },
  readGuard: { send: true },
  contextPruning: { send: true },
  contextPruningStrictness: { send: "aggressive" },
  contextPruningEngine: { send: "winnow" },
  contextPruningForkMinColdAge: { send: 30 },
  // Sent above the CLI's own 25,000-token refusal and stored just under it: a
  // cap at or past that is a number nothing would ever act on, so the route
  // clamps rather than storing what was typed.
  readGuardMaxTokens: { send: 40_000, stored: 24_999 },
  freshStartContextTokens: { send: 150_000 },
  maxConcurrentRuns: { send: 3 },
  maxConcurrentAssists: { send: 5 },
  maxConcurrentLocalRuns: { send: 2 },
  resolveAllowedTools: { send: ["Bash(npm run typecheck:*)"] },
  resolutionBudgetUSD: { send: 12 },
  isolationCopyGlobs: { send: [".env.local"] },
  isolationCopyGlobsByRepo: { send: { "acme/web": ["apps/web/.env"] } },
  isolationPreamble: { send: "CHANGED preamble" },
  continuedWorkPrompt: { send: "CHANGED continued work" },
  telemetryForRuns: { send: true },
  taskboardForRuns: { send: true },
  validateTaskCompletion: { send: true },
  validationBudgetUSD: { send: 4 },
  maxValidationCycles: { send: 3 },
  donePushbackPrompt: { send: "CHANGED pushback" },
  liveGuardIntervalSeconds: { send: 90 },
  maxCycleSilenceMinutes: { send: 45 },
  resumeGraceHours: { send: 12 },
  landStrategy: { send: "squash" },
  killProcessGroup: { send: false },
  chatTurnBudgetUSD: { send: 7 },
  eventRetentionDays: { send: 14 },
  checkoutRetentionDays: { send: 3 },
  transcriptRetentionDays: { send: 45 },
  installDailyCostLimitUSD: { send: 250 },
  // `Probe Vault` above slugs to this id. The route refuses one that names no
  // configured mount, which is the same shape as `defaultAgentId`'s refusal.
  knowledgeBaseMountId: { send: "probe-vault" },
  // Sent in the form a person types and stored normalized, so the round trip
  // proves the two ends agree on the spelling rather than only on the value.
  knowledgeBaseSubpath: { send: "/Vault/Notes/", stored: "Vault/Notes" },
  dreamingEnabled: { send: true },
  dreamingMinutes: { send: 4 * 60 + 30 },
  dreamingTimeZone: { send: "Europe/Berlin" },
  dreamingMinDays: { send: 3 },
  dreamingMaxCostUSD: { send: 5 },
  dreamingMaxPerNight: { send: 8 },
  chatDefaultGuards: {
    send: {
      permissionMode: "plan",
      isolate: false,
      budget: { maxIterations: 3, maxDurationMinutes: 45 },
    },
    // `normalizePolicy` fills the policy out, so what comes back is the whole
    // shape rather than the two fields that were sent.
    stored: {
      permissionMode: "plan",
      isolate: false,
      budget: {
        maxWeeklyFraction: null,
        maxSessionFraction: null,
        maxRunCostFactor: null,
        maxRunCostUSD: null,
        maxRunTokens: null,
        maxIterations: 3,
        maxDurationMinutes: 45,
        enforcement: "between-cycles",
        continueAfterDone: false,
      },
    },
  },
};

/**
 * A real saved agent for the one probe that has to name one.
 *
 * The route refuses a `defaultAgentId` that names nothing or that names a row
 * Claude Code would drop, which is the whole point of that branch — so the probe
 * cannot be a made-up string. The value is patched in rather than written above
 * because `createAgent` mints the id, and the loop reads `PROBES[key]` inside
 * each test callback, after this has run.
 */
before(async () => {
  const { createAgent } = await import("../../../lib/agents");
  const agent = createAgent({
    name: "probe-reviewer",
    description: "reads diffs",
    prompt: "You review.",
    model: null,
  });
  PROBES.defaultAgentId.send = agent.id;
});

function expected(probe: Probe): unknown {
  return "stored" in probe ? probe.stored : probe.send;
}

type Answer = { settings: Settings; nonDefaultKeys: string[] };

async function readAll(): Promise<Answer> {
  const { GET } = await import("./route");
  return (await (await GET(new Request("http://localhost/api/settings"))).json()) as Answer;
}

async function read(): Promise<Settings> {
  return (await readAll()).settings;
}

async function writeAll(key: string, value: unknown): Promise<Answer> {
  const { PUT } = await import("./route");
  const res = await PUT(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    }),
  );
  const body = (await res.json()) as {
    settings?: Settings;
    nonDefaultKeys?: string[];
    error?: string;
  };
  assert.equal(
    res.status,
    200,
    `PUT /api/settings refused ${key}: ${body.error ?? "(no message)"}`,
  );
  assert.ok(body.settings, `PUT /api/settings answered without settings`);
  const moved = body.nonDefaultKeys;
  assert.ok(
    Array.isArray(moved),
    `PUT /api/settings answered without nonDefaultKeys — the settings page ` +
      `sets its state from this response, so every fold's count would be ` +
      `stale from the moment the operator pressed Save`,
  );
  return { settings: body.settings, nonDefaultKeys: moved };
}

async function write(key: string, value: unknown): Promise<Settings> {
  return (await writeAll(key, value)).settings;
}

test("the probe table covers exactly the keys Settings has", async () => {
  const { SETTINGS_KEYS } = await import("../../../lib/settings");
  assert.deepEqual(
    Object.keys(PROBES).sort(),
    [...SETTINGS_KEYS].sort(),
    "every key of Settings needs a probe below, and nothing else belongs there",
  );
});

for (const key of Object.keys(PROBES) as (keyof Settings)[]) {
  test(`PUT /api/settings accepts ${key}`, async () => {
    const probe = PROBES[key];
    const want = expected(probe);

    const before = await read();
    assert.notDeepEqual(
      before[key],
      want,
      `the probe for ${key} must differ from what is already stored, or a ` +
        `key the route drops would still look accepted`,
    );

    const answered = await write(key, probe.send);
    assert.deepEqual(
      answered[key],
      want,
      `PUT /api/settings answered with the old ${key}, so the route has no ` +
        `branch for it — the settings page writes this answer back over the ` +
        `form, which is what makes the edit vanish under a "Saved" message`,
    );

    assert.deepEqual(
      (await read())[key],
      want,
      `GET /api/settings does not report the ${key} that was just stored`,
    );
  });
}

/**
 * The one key here whose `0` and blank are opposites rather than synonyms.
 *
 * Everywhere else on this route a number is a limit, and `optionalNumber`
 * folds a typed 0 to `null` where that is the field's rule: a cost ceiling of
 * zero and no cost ceiling are the same request. This key is a threshold, not a
 * limit. `0` is the shipped default and the only value that ever forks; blank
 * defers to winnow's own hour, and an hour at a cycle boundary refuses every
 * time. Sharing that helper meant typing 0 returned 200, redrew the form as
 * blank, and left the engine off.
 *
 * The probe loop above cannot catch this, and did not: its probe sends 30, and
 * 30 is on the surviving side of the fold. Only 0 distinguishes the two.
 */
test("PUT /api/settings stores a fork quiet period of 0 as 0, not as blank", async () => {
  const answered = await write("contextPruningForkMinColdAge", 0);
  assert.equal(
    answered.contextPruningForkMinColdAge,
    0,
    `0 came back as ${JSON.stringify(answered.contextPruningForkMinColdAge)} — ` +
      `blank here means "use winnow's hour", which never forks, so an operator ` +
      `asking for 0 would be answered with the opposite of what they asked for`,
  );
  assert.equal((await read()).contextPruningForkMinColdAge, 0);
});

test("PUT /api/settings still reads a blank fork quiet period as blank", async () => {
  await write("contextPruningForkMinColdAge", 45);
  const answered = await write("contextPruningForkMinColdAge", "");
  assert.equal(answered.contextPruningForkMinColdAge, null);
  assert.equal((await read()).contextPruningForkMinColdAge, null);
});

test("PUT /api/settings refuses a negative fork quiet period instead of blanking it", async () => {
  // Unreachable while the key went through `optionalNumber`: -5 was folded to
  // null and stored as "defer to winnow", so a typo turned the engine off and
  // answered 200. The route always carried this message; nothing could reach it.
  const { PUT } = await import("./route");
  const res = await PUT(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contextPruningForkMinColdAge: -5 }),
    }),
  );
  assert.equal(res.status, 400);
  assert.match(
    ((await res.json()) as { error: string }).error,
    /non-negative/,
  );
});

test("a blank prompt keeps whatever is stored", async () => {
  // The rule `continuationPrompt`, `isolationPreamble`, `donePushbackPrompt`
  // and `continuedWorkPrompt` share: emptying one would silently remove
  // instructions an agent depends on, so the stored text stands until it is
  // replaced by other text.
  const prompts = [
    "continuationPrompt",
    "isolationPreamble",
    "donePushbackPrompt",
    "continuedWorkPrompt",
  ] as const;

  for (const key of prompts) {
    const kept = (await read())[key];
    const answered = await write(key, "   ");
    assert.equal(answered[key], kept, `a blank ${key} was answered as empty`);
    assert.equal((await read())[key], kept, `a blank ${key} was stored`);
  }
});

/**
 * A knowledge base naming a mount that is not configured is refused here.
 *
 * `defaultAgentId`'s rule — refuse where the person is — and the same silence
 * if it were not: the mounts are fixed at boot, so a stored id that names none
 * can never start working, and the only symptom is a Knowledge base section
 * that stays empty on a page that gives no reason why. The refusal has to be a
 * 400 rather than a quiet drop for the reason the whole file exists: a dropped
 * value is answered as the old one and written back over the form.
 */
test("PUT /api/settings refuses a knowledge base mount that is not configured", async () => {
  const { PUT } = await import("./route");
  const before = (await read()).knowledgeBaseMountId;

  const res = await PUT(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ knowledgeBaseMountId: "no-such-mount" }),
    }),
  );
  assert.equal(res.status, 400, "an unconfigured mount id was accepted");
  const body = (await res.json()) as { error?: string };
  assert.match(String(body.error), /no-such-mount/, "the refusal does not name the id");

  assert.equal(
    (await read()).knowledgeBaseMountId,
    before,
    "a refused mount id was stored anyway",
  );
});

/**
 * The guard set every approved chat proposal starts under. `normalizePolicy`
 * threw on a budget that was not an object, which this route answered — and
 * audited — as a 500; read as the default policy instead, it would store one
 * cycle under a "Saved" the operator never asked for.
 */
test("PUT /api/settings refuses a chat guard set whose budget is not an object", async () => {
  const { PUT } = await import("./route");
  const { DEFAULTS } = await import("../../../lib/settings");
  const before = (await read()).chatDefaultGuards;

  for (const budget of ["lots", 5]) {
    const res = await PUT(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatDefaultGuards: { ...DEFAULTS.chatDefaultGuards, budget } }),
      }),
    );
    const body = (await res.json()) as { error?: string };
    assert.equal(res.status, 400, `budget ${JSON.stringify(budget)}: ${body.error ?? "(no message)"}`);
    assert.match(String(body.error), /"budget" has to be an object/);
  }

  assert.deepEqual(
    (await read()).chatDefaultGuards,
    before,
    "a refused guard set was stored anyway",
  );
});

/**
 * What the settings page folds on.
 *
 * A fold whose contents differ from their defaults opens by default, and that
 * rule is the whole reason folding a once-per-install control is safe rather
 * than a way to hide a surprise. The page cannot compute it — `DEFAULTS` is
 * server-side — so it reads this field, and every failure mode here is silent:
 * a key missing from the list is a setting left behind a summary at a value
 * nobody expects, and a key reported too coarsely opens a fold that holds
 * nothing the operator changed.
 *
 * The spelling is the other half of it. The page marks its fields by the dotted
 * path that reaches one control, so the guard set has to arrive split into its
 * leaves; reported whole it would say a fold holding one guard row holds a
 * change when what moved was one of the other six.
 */
test("the answer names which settings this install has moved, per control", async () => {
  const { DEFAULTS } = await import("../../../lib/settings");

  // One leaf of the guard set moved and the rest of it left at the shipped
  // value, so the dotted spelling is proved rather than incidental.
  await write("chatDefaultGuards", {
    ...DEFAULTS.chatDefaultGuards,
    budget: { ...DEFAULTS.chatDefaultGuards.budget, maxIterations: 9 },
  });
  await write("continuationPrompt", "CHANGED continuation, again");

  const moved = new Set((await readAll()).nonDefaultKeys);
  assert.ok(
    moved.has("chatDefaultGuards.budget.maxIterations"),
    "a guard field this install moved is not on the list",
  );
  assert.ok(
    !moved.has("chatDefaultGuards.budget.maxDurationMinutes"),
    "a guard field still at the shipped value is reported as moved",
  );
  assert.ok(
    !moved.has("chatDefaultGuards"),
    "the guard set is reported whole, which opens a fold holding one of its " +
      "rows for a change to any of the other six",
  );
  assert.ok(moved.has("continuationPrompt"), "a moved prompt is not on the list");

  // And it drops off again. This is the case the page's badge has to follow:
  // a prompt saved back to the shipped text is no longer a reason to fold it
  // open, and the count beside its summary says so.
  const restored = await writeAll("continuationPrompt", DEFAULTS.continuationPrompt);
  assert.ok(
    !restored.nonDefaultKeys.includes("continuationPrompt"),
    "a prompt restored to the shipped default is still reported as moved",
  );
});

/**
 * A number that is not a positive one.
 *
 * Every number on this route is one of three kinds, and the route has to
 * answer each one differently:
 *
 *  - a **money or token limit**, where 0 is the same request as blank — no
 *    ceiling — because every consumer of a stored ceiling reads `null` as off,
 *    and for the three budget fields a stored 0 would reach a child as
 *    `--max-budget-usd 0`, a budget no child can satisfy. 0 stores `null`.
 *  - a **cap or horizon**, where 0 has no meaning: a concurrency cap of 0
 *    wedges every run behind a slot nothing can satisfy, and a retention of 0
 *    days deletes the moment a run ends. 0 stores the floor the field's own
 *    rule names.
 *  - a **value that happens to be 0**: `maxValidationCycles`, where 0 is the
 *    real off switch and is a real answer.
 *
 * What none of them may do is answer 200 for a number they will not store.
 * While the shared helper folded everything but a positive number to `null`,
 * every one of these inputs — a 0 that meant a floor, a -50 that meant a
 * ceiling the operator never intended, a `"5O"` from a hand that slipped —
 * arrived as "no limit" with a 200 and a saved badge, and the page wrote that
 * answer back over the form.
 */
describe("PUT /api/settings with a number that is not a positive one", () => {
  // 0 is a value; the call site's floor decides what it becomes.
  const ZERO_IS_A_VALUE = [
    { key: "maxConcurrentRuns", stored: 1 },
    { key: "maxConcurrentAssists", stored: 1 },
    { key: "maxConcurrentLocalRuns", stored: 1 },
    { key: "eventRetentionDays", stored: 1 },
    { key: "checkoutRetentionDays", stored: 1 },
    { key: "transcriptRetentionDays", stored: 1 },
    { key: "liveGuardIntervalSeconds", stored: 15 },
    { key: "maxCycleSilenceMinutes", stored: 5 },
    { key: "resumeGraceHours", stored: 1 },
    { key: "freshStartContextTokens", stored: 20_000 },
    { key: "readGuardMaxTokens", stored: 500 },
    { key: "maxValidationCycles", stored: 0 },
  ] as const;

  // 0 is off; what is stored is `null`, the reading every consumer takes.
  const ZERO_IS_OFF = [
    "sessionCostLimit",
    "weeklyCostLimit",
    "sessionTokenLimit",
    "weeklyTokenLimit",
    "reservedHeadroomFraction",
    "validationBudgetUSD",
    "resolutionBudgetUSD",
    "chatTurnBudgetUSD",
    "installDailyCostLimitUSD",
  ] as const;

  const EVERY_NUMBER = [
    ...ZERO_IS_A_VALUE.map((f) => f.key),
    ...ZERO_IS_OFF,
  ];

  /** The shape the negative and unparseable cases share: a direct PUT. */
  async function refuse(key: keyof Settings, value: unknown) {
    const { PUT } = await import("./route");
    const res = await PUT(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      }),
    );
    const body = (await res.json()) as { error?: string };
    return { status: res.status, error: String(body.error ?? "") };
  }

  for (const { key, stored } of ZERO_IS_A_VALUE) {
    test(`a typed 0 ${key} is stored as its floor, ${stored}`, async () => {
      const answered = await write(key, 0);
      assert.equal(
        answered[key],
        stored,
        `a 0 ${key} came back as ${JSON.stringify(answered[key])} — the ` +
          `helper's fold to "no limit" swallows a 0 the field's own rule ` +
          `floors, and the page writes the answer back over the form`,
      );
      assert.equal((await read())[key], stored, `a 0 ${key} was stored another way`);
    });
  }

  for (const key of ZERO_IS_OFF) {
    test(`a typed 0 ${key} is stored as no limit`, async () => {
      const answered = await write(key, 0);
      assert.equal(
        answered[key],
        null,
        `a 0 ${key} came back as ${JSON.stringify(answered[key])} — a 0 on a ` +
          `money limit is the same request as off, and off is stored as null`,
      );
      assert.equal((await read())[key], null, `a 0 ${key} was stored another way`);
    });
  }

  test("a negative number is refused for every numeric field, and nothing is stored", async () => {
    for (const key of EVERY_NUMBER) {
      const before = (await read())[key];
      // The two inputs the defect report names, verbatim; the rest use -1.
      const bad =
        key === "installDailyCostLimitUSD" ? -50 : key === "maxConcurrentRuns" ? -2 : -1;
      const { status, error } = await refuse(key, bad);
      assert.equal(status, 400, `a negative ${key} (${bad}) was accepted`);
      assert.match(
        error,
        new RegExp(key),
        `the refusal does not name the field: ${error}`,
      );
      assert.equal((await read())[key], before, `a refused ${key} was stored anyway`);
    }
  });

  test("a value that is not a number is refused for every numeric field, and nothing is stored", async () => {
    for (const key of EVERY_NUMBER) {
      const before = (await read())[key];
      const { status, error } = await refuse(key, "5O");
      assert.equal(status, 400, `"5O" for ${key} was accepted`);
      assert.match(
        error,
        new RegExp(key),
        `the refusal does not name the field: ${error}`,
      );
      assert.equal((await read())[key], before, `a refused ${key} was stored anyway`);
    }
  });

  // A blank's one meaning per field: `null`, or the field's own answer to the
  // absence of a number — 0 for the cycle cap that may never be null, and the
  // shipped default for the three cadences that have no "no limit".
  const BLANK_STORES: { key: keyof Settings; stored: number | null }[] = [
    ...ZERO_IS_OFF.map((key) => ({ key, stored: null as number | null })),
    { key: "maxConcurrentRuns", stored: null },
    { key: "maxConcurrentAssists", stored: null },
    { key: "maxConcurrentLocalRuns", stored: null },
    { key: "eventRetentionDays", stored: null },
    { key: "checkoutRetentionDays", stored: null },
    { key: "transcriptRetentionDays", stored: null },
    { key: "freshStartContextTokens", stored: null },
    { key: "readGuardMaxTokens", stored: null },
    { key: "maxValidationCycles", stored: 0 },
    { key: "liveGuardIntervalSeconds", stored: 60 },
    { key: "maxCycleSilenceMinutes", stored: 120 },
    { key: "resumeGraceHours", stored: 24 },
  ];

  test("a blank value is answered as each field's own rule says", async () => {
    for (const { key, stored } of BLANK_STORES) {
      const answered = await write(key, "");
      assert.equal(
        answered[key],
        stored,
        `a blank ${key} came back as ${JSON.stringify(answered[key])}, not ` +
          `${JSON.stringify(stored)} — blank must keep its one meaning per ` +
          `field, whatever the other two kinds of input are`,
      );
    }
  });

  // `null` is the one shape whose answer is the same for the anchor as for
  // every number: no anchor, a rolling seven days.
  test("a null weeklyAnchor still means no anchor", async () => {
    const answered = await write("weeklyAnchor", null);
    assert.equal(answered.weeklyAnchor, null);
  });

  // The anchor's two numbers are ranges, not magnitudes: an hour of 24 is not
  // "a late hour", it is a different day, and a weekday of 7 is a day that
  // does not exist. Folding either to `null` was the old answer — a 200, a
  // saved badge, and the operator's anchored week silently replaced by a
  // rolling seven days.
  test("a weeklyAnchor whose hour is not 0–23 is refused", async () => {
    const before = (await read()).weeklyAnchor;
    const { status, error } = await refuse("weeklyAnchor", { weekday: 3, hourUTC: 24 });
    assert.equal(status, 400, "an out-of-range hour was accepted");
    assert.match(error, /hourUTC/, `the refusal does not name the field: ${error}`);
    assert.deepEqual(
      (await read()).weeklyAnchor,
      before,
      "a refused anchor was stored anyway",
    );
  });

  test("a weeklyAnchor whose weekday is not 0–6 is refused", async () => {
    const before = (await read()).weeklyAnchor;
    const { status, error } = await refuse("weeklyAnchor", { weekday: 7, hourUTC: 9 });
    assert.equal(status, 400, "an out-of-range weekday was accepted");
    assert.match(error, /weekday/, `the refusal does not name the field: ${error}`);
    assert.deepEqual(
      (await read()).weeklyAnchor,
      before,
      "a refused anchor was stored anyway",
    );
  });

  test("a weeklyAnchor with a fractional hour is refused", async () => {
    const before = (await read()).weeklyAnchor;
    const { status, error } = await refuse("weeklyAnchor", { weekday: 3, hourUTC: 7.5 });
    assert.equal(status, 400, "a fractional hour was accepted");
    assert.match(error, /hourUTC/, `the refusal does not name the field: ${error}`);
    assert.deepEqual(
      (await read()).weeklyAnchor,
      before,
      "a refused anchor was stored anyway",
    );
  });
});

/**
 * A Save that leaves the usage source alone keeps the provider's reading.
 *
 * The page PUTs the whole effective object on every Save, so
 * `planUsageFromApi` is in the body of a prompt edit as much as of a flip.
 * Dropping the cache on its mere presence threw away the two things
 * `planUsage` keeps across a refusal: the last good reading, re-served for up
 * to an hour while the endpoint answers 429, and the back-off that keeps a 429
 * from being answered with another request. With the reading gone the fraction
 * guards have nothing to read and are recorded rather than acted on, so a Save
 * pressed during a refusal spell switched `maxSessionFraction` and
 * `maxWeeklyFraction` off with nothing on screen to say so.
 *
 * `fetch` answers 200 once and 429 after that, which is the spell. The times
 * are passed to `planUsage` rather than waited out: its clock is its argument.
 */
describe("PUT /api/settings and the cached provider usage reading", () => {
  const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
  const FIVE_HOURS = 5 * 60 * 60 * 1000;
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const realFetch = globalThis.fetch;
  let usageRequests = 0;

  before(() => {
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== USAGE_URL) {
        throw new Error(`the settings route test fetched ${url}, expected only ${USAGE_URL}`);
      }
      usageRequests += 1;
      if (usageRequests > 1) return new Response("rate limited", { status: 429 });
      return Response.json({
        five_hour: { utilization: 91, resets_at: new Date(Date.now() + FIVE_HOURS).toISOString() },
        seven_day: { utilization: 40, resets_at: new Date(Date.now() + WEEK).toISOString() },
      });
    };
  });

  after(() => {
    globalThis.fetch = realFetch;
  });


  /**
   * One reading taken at `t0`, then a refused refresh six minutes later that
   * re-served it — the state the defect report was measured in.
   */
  async function seedReadingUnderRefusal(t0: number) {
    const { planUsage, invalidatePlanUsage, REFRESH_MS } = await import(
      "../../../lib/planUsage"
    );
    invalidatePlanUsage();
    usageRequests = 0;

    const seeded = await planUsage(t0);
    assert.equal(seeded?.session?.utilization, 0.91, "the stub's reading was not taken");

    const underRefusal = await planUsage(t0 + REFRESH_MS + 60_000);
    assert.equal(usageRequests, 2, "the refresh past REFRESH_MS was never attempted");
    assert.deepEqual(underRefusal, seeded, "a refused refresh did not re-serve the kept reading");
    return seeded;
  }

  async function put(body: Record<string, unknown>) {
    const { PUT } = await import("./route");
    const res = await PUT(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    assert.equal(res.status, 200, `PUT /api/settings refused ${JSON.stringify(body)}`);
  }

  test("a Save that re-sends an unchanged source keeps the reading and the back-off", async () => {
    const { planUsage, REFRESH_MS } = await import("../../../lib/planUsage");
    await write("planUsageFromApi", true);
    const t0 = Date.now();
    const seeded = await seedReadingUnderRefusal(t0);

    await put({ planUsageFromApi: true, continuationPrompt: "CHANGED during a 429 spell" });

    const afterSave = await planUsage(t0 + REFRESH_MS + 65_000);
    assert.deepEqual(
      afterSave,
      seeded,
      "a Save that did not change the usage source dropped the provider's " +
        "reading, so every fraction guard is left with nothing to read",
    );
    assert.equal(
      usageRequests,
      2,
      "the read after the Save went back to the endpoint inside the back-off, " +
        "which is how a transient 429 becomes a lasting one",
    );
  });

  test("switching the source off drops the reading", async () => {
    const { planUsage, REFRESH_MS } = await import("../../../lib/planUsage");
    await write("planUsageFromApi", true);
    const t0 = Date.now();
    await seedReadingUnderRefusal(t0);

    await put({ planUsageFromApi: false });

    // Still 429, so a reading here could only have come out of the cache.
    assert.equal(
      await planUsage(t0 + REFRESH_MS + 65_000),
      null,
      "switching the source off kept the provider's reading, which reads as " +
        "the switch not working",
    );
    assert.equal(usageRequests, 3, "the cache was not dropped, so nothing was requested");
  });
});

/**
 * A model list cleared to "no list" is still cleared after the server restarts.
 *
 * An empty `modelCatalogue` means no catalogue and nothing is refused, which is
 * what the settings page tells an operator to do to switch the check off. The
 * defect was in `migrate()`, not the route: the PUT stored `[]` and answered
 * 200, and the next boot's seed merge read "every seeded id is absent" and wrote
 * the whole seed back — so a model the operator relied on the empty list to
 * allow was refused at every door, with nothing connecting it to a restart.
 * Only a reopened connection runs `migrate()` again, so the test closes one.
 */
describe("PUT /api/settings and a model list that a restart merges the seed into", () => {
  function restart() {
    const g = globalThis as { __ufDb?: { close(): void } };
    g.__ufDb?.close();
    delete g.__ufDb;
  }

  after(async () => {
    const { SEEDED_MODEL_CATALOGUE } = await import("../../../lib/modelCatalogue");
    await write("modelCatalogue", SEEDED_MODEL_CATALOGUE);
  });

  test("a list cleared to empty stays empty across a restart", async () => {
    const answered = await write("modelCatalogue", []);
    assert.deepEqual(answered.modelCatalogue, []);

    restart();

    const after = await read();
    assert.deepEqual(
      after.modelCatalogue,
      [],
      `the cleared list came back with ${after.modelCatalogue.length} entries after ` +
        `a restart — an empty list is the operator's answer that nothing is refused, ` +
        `and filling it turns the model check back on`,
    );
  });

  test("a stored list still gains a model this release shipped", async () => {
    const { SEEDED_MODEL_CATALOGUE } = await import("../../../lib/modelCatalogue");
    // An enabled one: the route refuses a non-empty list with nothing switched on.
    const kept = SEEDED_MODEL_CATALOGUE.find((entry) => entry.enabled);
    assert.ok(kept);
    await write("modelCatalogue", [kept]);

    restart();

    const merged = (await read()).modelCatalogue;
    assert.equal(
      merged.length,
      SEEDED_MODEL_CATALOGUE.length,
      "a non-empty stored list stopped receiving seeded additions at boot",
    );
  });
});
