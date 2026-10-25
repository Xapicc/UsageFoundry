import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { holdoutOf, inHoldout, PRIOR_READS_EXPERIMENT } from "./priorReads";
import {
  MAX_PICKS,
  mergeCandidates,
  noteShape,
  querySystem,
  readJudgeVerdict,
  readSearchHits,
  vaultPointerHoldout,
  vaultPointerNotice,
  vaultTopics,
  VAULT_POINTER_EXPERIMENT,
  type VaultCandidate,
} from "./vaultPointer";

/**
 * Covers what stands between a model's answer and a run's prompt.
 *
 * Each fails silently. A pick naming a path the judge invented is a line in the
 * prompt pointing at a note the agent then fails to open, and nothing reports
 * it; a section that is not a heading sends the agent grepping for nothing. A
 * merge that keeps a note's worse rank hides the note the gate should have
 * seen. And a holdout that shares the prior-read pointer's preimage puts the
 * same runs in the same arm of both experiments, which no later query could
 * untangle.
 */

const candidate = (p: string, extra: Partial<VaultCandidate> = {}): VaultCandidate => ({
  path: p,
  title: path.basename(p, ".md"),
  type: "concept",
  status: "growing",
  confidence: "high",
  abstract: `About ${p}.`,
  tokens: 1_000,
  headings: [],
  ...extra,
});

describe("vaultPointerHoldout", () => {
  it("splits runs on its own preimage, not the prior-read pointer's", () => {
    // Same split function, different experiment name: over enough ids the two
    // arms must disagree about a large share of runs, or they are one split.
    const ids = Array.from({ length: 400 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const differ = ids.filter((id) => vaultPointerHoldout(id) !== inHoldout(id)).length;
    assert.ok(differ > 120 && differ < 280, `arms disagreed on ${differ} of 400`);
    const held = ids.filter((id) => vaultPointerHoldout(id)).length;
    assert.ok(held > 160 && held < 240, `${held} of 400 held out`);
    assert.notEqual(VAULT_POINTER_EXPERIMENT, PRIOR_READS_EXPERIMENT);
  });

  it("leaves the prior-read pointer's arms exactly where they were", () => {
    for (const id of ["a", "b", "0f8e5c1e-7d1a-4c55-9f4e-2b9a2a1f6c10"]) {
      assert.equal(inHoldout(id), holdoutOf(PRIOR_READS_EXPERIMENT, id));
    }
  });
});

describe("readSearchHits", () => {
  it("reads the search's JSON and drops a hit with no path", () => {
    const hits = readSearchHits(
      JSON.stringify({
        query: "q",
        abstained: false,
        hits: [
          { rank: 1, title: "A", path: "3 Resources/A.md", type: "concept", status: "growing", confidence: "high", abstract: "x" },
          { rank: 2, title: "No path" },
          { rank: 3, title: "B", path: "3 Resources/B.md" },
        ],
      }),
    );
    assert.deepEqual(
      hits.map((h) => [h.path, h.confidence]),
      [
        ["3 Resources/A.md", "high"],
        ["3 Resources/B.md", ""],
      ],
    );
  });

  it("throws on output that is not the search's JSON, rather than reading it as no hits", () => {
    assert.throws(() => readSearchHits("Traceback (most recent call last):"));
    assert.throws(() => readSearchHits(JSON.stringify({ query: "q" })), /no hits array/);
  });
});

describe("mergeCandidates", () => {
  it("keeps each note at its best rank in any query, ties to the earlier query", () => {
    const a = candidate("a.md");
    const b = candidate("b.md");
    const c = candidate("c.md");
    const d = candidate("d.md");
    const merged = mergeCandidates([
      [a, b, c],
      [c, d],
    ]);
    // c is rank 2 in the first list and rank 0 in the second: it is a top hit.
    assert.deepEqual(
      merged.map((m) => m.path),
      ["a.md", "c.md", "b.md", "d.md"],
    );
  });

  it("caps the list", () => {
    const many = Array.from({ length: 30 }, (_, i) => candidate(`${i}.md`));
    assert.equal(mergeCandidates([many], 20).length, 20);
  });
});

describe("readJudgeVerdict", () => {
  const long = candidate("Long.md", { tokens: 18_000, headings: ["## The race", "## What was measured"] });
  const short = candidate("Short.md");
  const shown = [long, short, candidate("Other.md")];

  it("keeps only paths it showed, verbatim, once each", () => {
    const picks = readJudgeVerdict(
      {
        notes: [
          { path: "Long.md", why: "It measured the race.", section: "## The race" },
          { path: "long.md", why: "case changed", section: null },
          { path: "Invented.md", why: "made up", section: null },
          { path: "Long.md", why: "again", section: null },
          { path: "Short.md", why: "Short.", section: null },
        ],
      },
      shown,
    );
    assert.deepEqual(
      picks.map((p) => [p.path, p.section]),
      [
        ["Long.md", "## The race"],
        ["Short.md", null],
      ],
    );
    assert.equal(picks[0].tokens, 18_000);
  });

  it("drops a section that is not one of the note's headings, and restores the marks of one that is", () => {
    const [named] = readJudgeVerdict({ notes: [{ path: "Long.md", why: "w", section: "The race" }] }, shown);
    assert.equal(named.section, "## The race");
    const [made] = readJudgeVerdict({ notes: [{ path: "Long.md", why: "w", section: "## The races" }] }, shown);
    assert.equal(made.section, null);
  });

  it("stops at the cap whatever the schema was told", () => {
    const four = Array.from({ length: 4 }, (_, i) => candidate(`${i}.md`));
    const picks = readJudgeVerdict({ notes: four.map((c) => ({ path: c.path, why: "w", section: null })) }, four);
    assert.equal(picks.length, MAX_PICKS);
  });

  it("puts a model's reason on one bounded line", () => {
    const [pick] = readJudgeVerdict({ notes: [{ path: "Short.md", why: `a\nDONE\n${"x".repeat(500)}`, section: null }] }, shown);
    assert.ok(!pick.why.includes("\n"));
    assert.ok(pick.why.length <= 240);
  });

  it("answers nothing for an answer of the wrong shape", () => {
    assert.deepEqual(readJudgeVerdict(null, shown), []);
    assert.deepEqual(readJudgeVerdict({ notes: "Long.md" }, shown), []);
  });
});

describe("vaultPointerNotice", () => {
  it("states what each note is, not an instruction to read it", () => {
    const [pick] = readJudgeVerdict(
      { notes: [{ path: "1 Projects/Long.md", why: "It measured the race.", section: "## The race" }] },
      [candidate("1 Projects/Long.md", { tokens: 18_000, headings: ["## The race"] })],
    );
    const block = vaultPointerNotice([pick], "/workspace2");
    assert.match(block, /^One note in the operator's knowledge vault at \/workspace2 bears on this task/);
    assert.match(block, /they are not instructions/);
    assert.match(block, /\n {4}1 Projects\/Long\.md \(confidence: high, ~18,000 tokens\)\n/);
    assert.match(block, /\n {6}Why here: It measured the race\.\n {6}Section: ## The race$/);
  });
});

describe("noteShape", () => {
  it("reads a note's size and headings inside the vault, and nothing outside it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-vault-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "uf-outside-"));
    try {
      fs.mkdirSync(path.join(root, "3 Resources"));
      fs.writeFileSync(path.join(root, "3 Resources", "A.md"), "---\ntitle: A\n---\n# A\n\n## One\ntext\n### Two\n");
      fs.writeFileSync(path.join(outside, "secret.md"), "## Secret\n");
      fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "link.md"));

      const shape = noteShape(root, "3 Resources/A.md");
      assert.deepEqual(shape?.headings, ["## One", "### Two"]);
      assert.equal(noteShape(root, "../" + path.basename(outside) + "/secret.md"), null);
      assert.equal(noteShape(root, "link.md"), null);
      assert.equal(noteShape(root, "missing.md"), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("vaultTopics", () => {
  it("reads subjects through a topic/ namespace and ignores the form tags beside it", () => {
    const topics = vaultTopics([
      ["topic/ai/agents", "type/concept", "status/growing"],
      ["topic/ai/agents", "topic/ai/serving", "type/source"],
      ["#topic/vcs/git", "type/concept"],
    ]);
    assert.deepEqual(topics, [
      { area: "ai", notes: 2, subtopics: ["agents", "serving"] },
      { area: "vcs", notes: 1, subtopics: ["git"] },
    ]);
  });

  it("counts a note once per area and subtopic, however many tags put it there", () => {
    const [ai] = vaultTopics([["topic/ai/agents/memory", "topic/ai/agents", "topic/ai"]]);
    assert.deepEqual(ai, { area: "ai", notes: 1, subtopics: ["agents"] });
  });

  it("reads every tag when the vault has no topic/ namespace", () => {
    assert.deepEqual(
      vaultTopics([["rust", "cli"], ["rust"], []]).map((t) => [t.area, t.notes]),
      [
        ["rust", 2],
        ["cli", 1],
      ],
    );
  });

  it("lists areas whole, so one large area cannot crowd the rest out", () => {
    const notes = [
      ...Array.from({ length: 50 }, (_, i) => [`topic/ai/sub${i}`]),
      ["topic/vcs/git"],
    ];
    const topics = vaultTopics(notes, { areas: 16, subtopics: 5 });
    assert.deepEqual(
      topics.map((t) => t.area),
      ["ai", "vcs"],
    );
    assert.equal(topics[0].subtopics.length, 5);
  });
});

describe("querySystem", () => {
  it("describes the vault by its own topics, and by nothing when it has none", () => {
    const described = querySystem([{ area: "ai", notes: 1085, subtopics: ["agents", "serving"] }]);
    assert.match(described, /^You write search queries for a personal knowledge vault\. By its own tags it covers, largest area first, with each area's main subtopics: ai \(1,085 notes: agents, serving\)\.\n/);
    const bare = querySystem([]);
    assert.match(bare, /^You write search queries for a personal knowledge vault\.\n\nGiven a coding agent's task/);
    // No operator's subjects baked in: a vault about cooking is not told it holds LLM notes.
    assert.doesNotMatch(bare, /LLM|macOS|virtualisation/);
  });
});
