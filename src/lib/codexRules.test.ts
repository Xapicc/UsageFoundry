import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * The `pkill`/`killall` denial for the provider that cannot carry it on argv.
 *
 * Every other deny list in this app is a flag on a command line, and a typo in
 * one fails the spawn. This one is a Starlark file that a separate binary
 * parses, and its failure mode is the worst shape a safety mechanism has: a
 * file written in a dialect this version of Codex does not know **loads as zero
 * rules**. Nothing throws, nothing warns, `prepareCodexRules` answers `ready`,
 * the cycle spawns, and the only difference from a working install is that
 * `pkill -f next-server` now succeeds against the server supervising the agent.
 * That is the incident `PROCESS_KILLERS` was written after, one provider over.
 *
 * So the text is pinned whole rather than probed. `prefix_rule` with a one-word
 * pattern is what was measured to work against codex-cli 0.153.4 —
 * `codex execpolicy check -r <file> pkill node` answers
 * `{"decision":"forbidden"}` — and `rule` and `define_program`, which read like
 * plausible spellings of the same thing, do not exist in this version at all.
 * A test asserting only that the word `pkill` appears somewhere would pass
 * against every one of those.
 *
 * The delivery earns its half on `settleOnExit`'s terms rather than on purity:
 * it is the only thing in the process that decides whether a Codex cycle is
 * allowed to start, the caller must refuse on `unavailable`, and a temp file
 * left where the rename should have gone is a directory Codex reads.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-codex-rules-")));
// `config.ts` reads both once at import, and `CODEX_HOME` is the one that
// matters here: unpinned, this file would install a process-kill denial into
// the home directory of whoever ran the suite, which is a side effect on a
// machine rather than on a fixture.
process.env.DATA_DIR = path.join(tmp, "data");
process.env.CODEX_HOME = path.join(tmp, "codex");

let mod: typeof import("./codexRules");
let CODEX_RULES_FILE: string;

before(async () => {
  const config = await import("./config");
  assert.equal(
    config.CODEX_HOME,
    process.env.CODEX_HOME,
    "config was already loaded by another test file in this process — refusing " +
      "to write rules into the real ~/.codex",
  );
  mod = await import("./codexRules");
  ({ CODEX_RULES_FILE } = mod);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("codexRulesText", () => {
  it("writes the one dialect this Codex parses, verbatim", () => {
    assert.equal(
      mod.codexRulesText(),
      [
        "# Written by UsageFoundry. Deleting this file lets an agent it spawns kill",
        "# the server process that supervises it, which fails every run in flight.",
        "",
        'prefix_rule(pattern=["pkill"], decision="forbidden")',
        'prefix_rule(pattern=["killall"], decision="forbidden")',
        "",
      ].join("\n"),
    );
  });

  it("denies every command it is given and no others", () => {
    // The list is the subject, not the two names: a third process-killer added
    // to `CODEX_FORBIDDEN_COMMANDS` must produce a third rule rather than a
    // file that mentions it in a comment. `orchestrator.test.ts` holds the
    // other half of this, which is that the list matches the Claude argv's.
    const text = mod.codexRulesText(["pkill", "killall", "skill"]);
    const rules = text
      .split("\n")
      .filter((l) => l.startsWith("prefix_rule("))
      .map((l) => /pattern=\["([^"]+)"\]/.exec(l)?.[1]);
    assert.deepEqual(rules, ["pkill", "killall", "skill"]);
    for (const line of text.split("\n").filter((l) => l.startsWith("prefix_rule("))) {
      assert.equal(line.includes('decision="forbidden"'), true);
    }
  });

  it("says who wrote the file and what deleting it costs", () => {
    // Not decoration. The file lands in a directory this app does not own
    // exclusively — it is the agent uid's own `~/.codex`, because that is where
    // the credential a cycle bills against has to live — so an operator finding
    // it there must be able to tell what it is before they tidy it away.
    const header = mod
      .codexRulesText()
      .split("\n")
      .filter((l) => l.startsWith("#"))
      .join(" ");
    assert.equal(header.includes("UsageFoundry"), true);
    assert.equal(header.includes("Deleting this file"), true);
  });
});

describe("prepareCodexRules", () => {
  it("puts the denial where Codex was measured to look for it", () => {
    const delivery = mod.prepareCodexRules();
    assert.deepEqual(delivery, { kind: "ready", file: CODEX_RULES_FILE });
    // `$CODEX_HOME/rules/*.rules` is the only place rules are discovered from —
    // there is no argv flag and no `-c` key naming a file — so the path is as
    // much of the mechanism as the text is.
    assert.equal(path.dirname(CODEX_RULES_FILE), path.join(process.env.CODEX_HOME!, "rules"));
    assert.equal(path.extname(CODEX_RULES_FILE), ".rules");
    assert.equal(fs.readFileSync(CODEX_RULES_FILE, "utf8"), mod.codexRulesText());
    // World-readable on purpose: the server writes it and the cycle reads it,
    // under a dropped uid. A mode nobody checked is a denial the process that
    // has to honour it cannot open.
    assert.equal(fs.statSync(CODEX_RULES_FILE).mode & 0o777, 0o644);
  });

  it("leaves nothing behind that Codex would also try to load", () => {
    // The write is atomic for `readGuard.ts`' reason — a cycle spawning while a
    // half-written file is on disk loads a rules file that parses to nothing —
    // and the temp file it goes through is inside the directory Codex globs.
    // Rewritten per cycle rather than once per install, so this runs twice.
    mod.prepareCodexRules();
    mod.prepareCodexRules();
    assert.deepEqual(fs.readdirSync(path.dirname(CODEX_RULES_FILE)), [
      path.basename(CODEX_RULES_FILE),
    ]);
  });

  it("says why rather than answering ready when it cannot write", () => {
    // The case the caller refuses the whole cycle on. Getting this wrong in the
    // other direction — reporting `ready` for a file that is not there — starts
    // an agent with no denial at all, which is the one outcome this module
    // exists to prevent.
    const dir = path.dirname(CODEX_RULES_FILE);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, "not a directory");

    const delivery = mod.prepareCodexRules();
    assert.equal(delivery.kind, "unavailable");
    assert.equal(
      delivery.kind === "unavailable" && delivery.reason.includes(CODEX_RULES_FILE),
      true,
      "the reason must name the path, because it reaches an operator as a refusal",
    );

    // And recovers: the failure is about the filesystem, not about state this
    // module keeps.
    fs.rmSync(dir);
    assert.equal(mod.prepareCodexRules().kind, "ready");
  });
});
