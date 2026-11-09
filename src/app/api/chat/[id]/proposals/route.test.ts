import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import type { ProposalInput } from "../../../../../lib/chat";
import type { BudgetPolicy } from "../../../../../lib/budget";

/**
 * Approving a chat proposal refuses a fraction guard with nothing to read, and
 * leaves the proposal pending.
 *
 * `planProposal` takes the run's budget from the template or from the guard set
 * the card froze, and either can hold `maxWeeklyFraction`/`maxSessionFraction`
 * (`PUT /api/settings` accepts both on `chatDefaultGuards.budget`). `createRun`
 * does not ask whether that window can be read and the pre-cycle guard only
 * records it (`RUN_ENFORCEABLE_CODES`), so an approval on an install with no
 * reading started a run whose guard was never evaluated. The click is a person
 * with an error channel, so it refuses, as `POST /api/runs` does.
 *
 * Route-level because the gap was between the route and the batch: the route
 * fetches the readings and `approveRunBatch` judges with them, and a unit test
 * of either half passes with the other missing. Its own file with `DATA_DIR`
 * named before the first import, for `runOrigin.test.ts`'s reason: `config.ts`
 * is read at module load. The fleet is paused, so a run a regression lets
 * through is held in `waiting` rather than spawned.
 */

type Answer = { status: number; body: Record<string, unknown> };

let root: string;
let mountId: string;
let budgetOf: () => BudgetPolicy;
let withGuards: (budget: Partial<BudgetPolicy>) => void;
let propose: (over?: Partial<ProposalInput>) => { chatId: string; id: string };
let approve: (chatId: string, ids: string[]) => Promise<Answer>;
let reject: (chatId: string, ids: string[]) => Promise<Answer>;
let statusOf: (proposalId: string) => string;
let runsFor: (proposalId: string) => number;
let makeTemplate: (budget: Partial<BudgetPolicy>) => string;
let setReading: (weeklyCostLimit: number | null) => void;

const WEEKLY = /^“[^”]+”: A weekly-fraction guard is set but that window has no reading/;

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-chat-approve-route-")));
  fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  // An empty home, so a Codex run has no sign-in and therefore no reading,
  // whatever this machine's own `~/.codex` holds.
  process.env.CODEX_HOME = path.join(root, "codex");
  process.env.WORKSPACE_ROOTS = `Scratch=${path.join(root, "workspace")}`;
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("../../../../../lib/config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  mountId = config.WORKSPACE_MOUNTS[0].id;
  (await import("../../../../../lib/fleet")).setFleetPaused(true);
  const settings = await import("../../../../../lib/settings");
  // No network here, so the Claude reading is whatever Settings holds.
  settings.saveSettings({ planUsageFromApi: false });
  const chat = await import("../../../../../lib/chat");
  const templates = await import("../../../../../lib/templates");
  const { db } = await import("../../../../../lib/db");
  const { POST } = await import("./route");

  budgetOf = () => settings.chatGuards().budget;
  withGuards = (budget) => {
    const guards = settings.chatGuards();
    settings.saveSettings({
      chatDefaultGuards: { ...guards, budget: { ...guards.budget, ...budget } },
    });
  };

  let serial = 0;
  propose = (over = {}) => {
    const thread = chat.createChat();
    // One folder each, so no case contends for a checkout and what it asserts
    // is the guard's refusal and nothing about occupancy.
    const folder = `project-${serial++}`;
    fs.mkdirSync(path.join(root, "workspace", folder), { recursive: true });
    const proposal = chat.createProposal(thread.id, {
      templateId: null,
      title: `Task ${serial}`,
      task: "Do the thing.",
      promptOverride: null,
      mountId,
      folder,
      ...over,
    });
    return { chatId: thread.id, id: proposal.id };
  };
  makeTemplate = (budget) =>
    templates.createTemplate({
      name: `Guarded ${serial++}`,
      prompt: "Work carefully.",
      mountId,
      folder: "",
      isolate: false,
      permissionMode: "plan",
      agentId: null,
      model: null,
      budget: { ...budgetOf(), ...budget },
    }).id;
  statusOf = (proposalId) => chat.getProposal(proposalId)!.status;
  runsFor = (proposalId) =>
    (
      db().prepare("SELECT COUNT(*) AS n FROM runs WHERE origin_ref = ?").get(proposalId) as {
        n: number;
      }
    ).n;
  setReading = (weeklyCostLimit) => settings.saveSettings({ weeklyCostLimit });

  const post = async (chatId: string, action: string, ids: string[]): Promise<Answer> => {
    const res = await POST(
      new Request(`http://localhost/api/chat/${chatId}/proposals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ids }),
      }),
      { params: Promise.resolve({ id: chatId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  approve = (chatId, ids) => post(chatId, "approve", ids);
  reject = (chatId, ids) => post(chatId, "reject", ids);
});

afterEach(() => {
  setReading(null);
  withGuards({ maxWeeklyFraction: null, maxSessionFraction: null });
});

after(async () => {
  // A run a regression let through is only held, but give anything a tick to
  // fall over before the directory it works in is removed.
  await new Promise((resolve) => setTimeout(resolve, 50));
  delete process.env.WORKSPACE_ROOTS;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("POST /api/chat/[id]/proposals — a fraction guard with nothing to read", () => {
  it("approves a proposal whose guards carry no fraction, as it always did", async () => {
    const { chatId, id } = propose();
    const answer = await approve(chatId, [id]);
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 200, reason);
    assert.equal(statusOf(id), "approved", reason);
    assert.equal(runsFor(id), 1, reason);
  });

  it("refuses a frozen weekly fraction, starts nothing and leaves the proposal pending", async () => {
    withGuards({ maxWeeklyFraction: 0.5 });
    const { chatId, id } = propose();
    const answer = await approve(chatId, [id]);
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 400, reason);
    assert.match(String(answer.body.error), WEEKLY, reason);
    assert.match(String(answer.body.error), /Nothing was decided/, reason);
    assert.equal(statusOf(id), "pending", `${reason}: the proposal was decided`);
    assert.equal(runsFor(id), 0, `${reason}: a run started with its guard unread`);
  });

  it("refuses a frozen session fraction in the 5-hour window's words", async () => {
    withGuards({ maxSessionFraction: 0.5 });
    const { chatId, id } = propose();
    const answer = await approve(chatId, [id]);
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 400, reason);
    assert.match(
      String(answer.body.error),
      /A session-fraction guard is set but the 5-hour window has no reading/,
      reason,
    );
    assert.equal(statusOf(id), "pending", reason);
    assert.equal(runsFor(id), 0, reason);
  });

  it("refuses a templated proposal by the template's budget, which is read live", async () => {
    const templateId = makeTemplate({ maxWeeklyFraction: 0.5 });
    const { chatId, id } = propose({ templateId });
    const answer = await approve(chatId, [id]);
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 400, reason);
    assert.match(String(answer.body.error), WEEKLY, reason);
    assert.equal(statusOf(id), "pending", reason);
    assert.equal(runsFor(id), 0, reason);
  });

  it("starts the same proposal on the next click once the window has a reading", async () => {
    withGuards({ maxWeeklyFraction: 0.5 });
    const { chatId, id } = propose();
    assert.equal((await approve(chatId, [id])).status, 400);

    setReading(100);
    const answer = await approve(chatId, [id]);
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 200, reason);
    assert.equal(statusOf(id), "approved", reason);
    assert.equal(runsFor(id), 1, reason);
  });

  it("reads a Codex proposal against Codex's windows, not the Claude reading beside them", async () => {
    // A reading for Claude's week and none for Codex's: a door that asked only
    // `currentSnapshot()` would admit this run.
    setReading(100);
    withGuards({ maxWeeklyFraction: 0.5 });
    const { chatId, id } = propose({ provider: "codex" });
    const answer = await approve(chatId, [id]);
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 400, reason);
    assert.match(String(answer.body.error), /Codex's weekly window has no reading/, reason);
    assert.equal(statusOf(id), "pending", reason);
    assert.equal(runsFor(id), 0, reason);
  });

  it("refuses the whole click when one proposal in it is unreadable, deciding none of them", async () => {
    // Refusing one member inside the batch would fail whatever depends on it
    // terminally while it stayed pending, so the click is the unit.
    const plainTemplate = makeTemplate({ maxWeeklyFraction: null });
    const plain = propose({ templateId: plainTemplate });
    const guardedTemplate = makeTemplate({ maxWeeklyFraction: 0.5 });
    const guarded = propose({ templateId: guardedTemplate });
    // Proposals of one chat, so one click holds both.
    const { chatId } = plain;
    const { db } = await import("../../../../../lib/db");
    db().prepare("UPDATE chat_proposals SET chat_id = ? WHERE id = ?").run(chatId, guarded.id);

    const answer = await approve(chatId, [plain.id, guarded.id]);
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 400, reason);
    assert.match(String(answer.body.error), WEEKLY, reason);
    assert.equal(statusOf(plain.id), "pending", `${reason}: the readable one was decided`);
    assert.equal(statusOf(guarded.id), "pending", reason);
    assert.equal(runsFor(plain.id) + runsFor(guarded.id), 0, reason);
  });

  it("still lets a person reject a proposal whose guard cannot be read", async () => {
    withGuards({ maxWeeklyFraction: 0.5 });
    const { chatId, id } = propose();
    const answer = await reject(chatId, [id]);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(statusOf(id), "rejected");
  });
});
