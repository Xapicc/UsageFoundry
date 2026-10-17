import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { ModelCatalogueEntry } from "./modelCatalogue";
import type { Settings } from "./settings";

/**
 * The two decisions between the model decider's answer and `--model`.
 *
 * Both fail silently and in money. `deciderApplies` answering yes for a Codex
 * or local run hands a Claude id to a CLI that does not serve it, which fails
 * at the provider rather than here; answering yes over a template's or an
 * agent's model replaces a price the operator chose with one a 4B classifier
 * chose, and the run page shows it as chosen either way. `readDeciderReply`
 * letting through an id the operator switched off starts a run on it, priced
 * at `UNKNOWN_MODEL_PRICE` if the price table has never heard of it; reading
 * an abstention or an error as a pick does the same with no id at all.
 */
/*
 * `decideRunModel` reads `UF_MODEL_DECIDER_URL` and the settings at import and
 * on every call, so the module is loaded in `before`, after a throwaway
 * `DATA_DIR` and a loopback server's address are in the environment. The pure
 * cases below take their functions from the same load.
 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uf-model-decider-"));
process.env.DATA_DIR = DATA_DIR;

/** What the loopback decider does on its next request, set by each case. */
let onRequest: (body: { models: string[] }) => unknown = () => ({ model: null, reason: "unset" });
/** The model lists the loopback decider was offered, one per request. */
const offered: string[][] = [];
const decider = http.createServer((req, res) => {
  let text = "";
  req.on("data", (chunk) => (text += chunk));
  req.on("end", () => {
    const body = JSON.parse(text) as { models: string[] };
    offered.push(body.models);
    const answer = onRequest(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(answer));
  });
});

let deciderApplies: typeof import("./modelDecider").deciderApplies;
let readDeciderReply: typeof import("./modelDecider").readDeciderReply;
let decideRunModel: typeof import("./modelDecider").decideRunModel;
let saveSettings: (patch: Partial<Settings>) => Settings;

before(async () => {
  await new Promise<void>((resolve) => decider.listen(0, "127.0.0.1", resolve));
  process.env.UF_MODEL_DECIDER_URL = `http://127.0.0.1:${(decider.address() as AddressInfo).port}`;
  ({ deciderApplies, readDeciderReply, decideRunModel } = await import("./modelDecider"));
  ({ saveSettings } = await import("./settings"));
});

after(() => {
  decider.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const CATALOGUE: ModelCatalogueEntry[] = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", enabled: true },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", enabled: true },
  { id: "claude-opus-4-1", label: "Claude Opus 4.1", enabled: false },
];

describe("deciderApplies — which runs the decider may answer", () => {
  const open = { provider: null, named: null, templateModel: null, agentModel: null };

  it("answers an ordinary Claude run that nothing has named a model for", () => {
    assert.equal(deciderApplies(open), true);
    assert.equal(deciderApplies({ ...open, provider: "claude" }), true);
  });

  it("never answers for the local provider", () => {
    assert.equal(deciderApplies({ ...open, provider: "local" }), false);
  });

  // A Codex run is answered from the Codex list, and only the run's own model
  // stands it aside: a template's or an agent's is a Claude id that never
  // reaches `codex exec`, so treating it as an answer would leave every Codex
  // run from a template with a model on the Codex default for good.
  it("answers a Codex run unless the run itself named a model", () => {
    assert.equal(deciderApplies({ ...open, provider: "codex" }), true);
    assert.equal(
      deciderApplies({ ...open, provider: "codex", templateModel: "claude-sonnet-5", agentModel: "claude-haiku-4-5" }),
      true,
    );
    assert.equal(deciderApplies({ ...open, provider: "codex", named: "gpt-5.6-luna" }), false);
  });

  it("stands aside for a model the chat, the template or the agent named", () => {
    assert.equal(deciderApplies({ ...open, named: "claude-sonnet-5" }), false);
    assert.equal(deciderApplies({ ...open, templateModel: "claude-sonnet-5" }), false);
    assert.equal(deciderApplies({ ...open, agentModel: "claude-haiku-4-5" }), false);
  });

  it("reads a blank model as none named, the rule every door keeps", () => {
    assert.equal(deciderApplies({ ...open, templateModel: "  ", agentModel: "" }), true);
  });
});

describe("readDeciderReply — what becomes a run's model", () => {
  it("takes an enabled id and says the decider picked it", () => {
    const decision = readDeciderReply(
      200,
      { model: "claude-sonnet-5", reason: "Tev1 classed the task as routine_engineering at 0.994" },
      CATALOGUE,
    );
    assert.equal(decision.model, "claude-sonnet-5");
    assert.match(decision.note, /^Picked by the model decider: Tev1 classed/);
  });

  it("refuses an id the operator switched off, and one the list never had", () => {
    for (const model of ["claude-opus-4-1", "claude-opus-9"]) {
      const decision = readDeciderReply(200, { model, reason: "r" }, CATALOGUE);
      assert.equal(decision.model, null, model);
      assert.match(decision.note, /was refused/, model);
    }
  });

  // Held to the Codex list for a Codex run, and the sentence names that list:
  // a Claude id the decider answered with is refused there however enabled it
  // is on the Claude list.
  it("holds a Codex run's pick to the Codex list", () => {
    const codex: ModelCatalogueEntry[] = [
      { id: "gpt-6-astra", label: "GPT-6-Astra", enabled: true },
      { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", enabled: true },
    ];
    const ok = readDeciderReply(200, { model: "gpt-5.6-luna", reason: "mechanical_change" }, codex, "codex");
    assert.equal(ok.model, "gpt-5.6-luna");
    const crossed = readDeciderReply(200, { model: "claude-sonnet-5", reason: "r" }, codex, "codex");
    assert.equal(crossed.model, null);
    assert.match(crossed.note, /not on this install's Codex list/);
  });

  it("reads an abstention, an error and a body it cannot parse as no pick", () => {
    assert.equal(readDeciderReply(200, { model: null, reason: "below the 0.6 threshold" }, CATALOGUE).model, null);
    const down = readDeciderReply(503, { error: "llama-server unreachable" }, CATALOGUE);
    assert.equal(down.model, null);
    assert.equal(down.note, "The model decider answered 503: llama-server unreachable.");
    assert.equal(readDeciderReply(200, "not an object", CATALOGUE).model, null);
    assert.equal(readDeciderReply(200, { model: 42 }, CATALOGUE).model, null);
  });

  it("flattens and bounds the decider's text before a card or a note carries it", () => {
    const decision = readDeciderReply(200, { model: null, reason: `line one\nline two ${"x".repeat(400)}` }, CATALOGUE);
    assert.ok(!decision.note.includes("\n"));
    assert.ok(decision.note.length < 360, `${decision.note.length} characters`);
  });
});

describe("decideRunModel — the list an answer is held to", () => {
  const entry = (id: string, enabled: boolean): ModelCatalogueEntry => ({ id, label: id, enabled });

  // The request takes up to 30 seconds, and the operator can switch a model
  // off in Settings while it is out. The answer is held to the list as it is
  // when the answer arrives, not as it was when the question was built: a run
  // started on a model the operator had just refused to pay for is the failure,
  // and the note on it would say the decider picked it.
  it("refuses an id switched off while the decider was deciding", async () => {
    saveSettings({ modelCatalogue: [entry("claude-opus-5", true), entry("claude-sonnet-5", true)] });
    onRequest = () => {
      saveSettings({ modelCatalogue: [entry("claude-opus-5", false), entry("claude-sonnet-5", true)] });
      return { model: "claude-opus-5", reason: "hard task" };
    };

    const decision = await decideRunModel({ task: "refactor the parser", provider: "claude" });

    assert.deepEqual(offered.at(-1), ["claude-opus-5", "claude-sonnet-5"]);
    assert.equal(decision?.model, null);
    assert.match(decision?.note ?? "", /claude-opus-5.*refused/);
  });

  it("takes an id that is still enabled when the answer arrives", async () => {
    saveSettings({ modelCatalogue: [entry("claude-opus-5", true), entry("claude-sonnet-5", true)] });
    onRequest = () => ({ model: "claude-sonnet-5", reason: "routine" });

    const decision = await decideRunModel({ task: "rename a field", provider: "claude" });

    assert.equal(decision?.model, "claude-sonnet-5");
  });
});
