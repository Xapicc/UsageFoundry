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

/**
 * The denial under a uid split, where the server writing it is root and the
 * cycle it constrains is not.
 *
 * Root owning `rules/` was the whole of the protection, and it kept nothing:
 * renaming a directory is a write to the one that holds it, and that one was
 * the agents'. So a work cycle could move `rules/` aside and leave a file or a
 * dangling link at the name, which refused every later Codex cycle for good, or
 * a link into its own tree, which wrote the denial somewhere it can edit and
 * answered `ready`. These pin that the delivery checks the directories rather
 * than trusting a successful write, and that its refusal names the directory
 * rather than a missing denial.
 *
 * The suite is not root, so the uid that owns the fixture stands in for the
 * server's, passed explicitly; production passes what `rulesOwner()` answers.
 */
describe("prepareCodexRules when the cycle runs under another uid", () => {
  const self = process.getuid!();
  const home = () => process.env.CODEX_HOME!;
  const rulesDir = () => path.dirname(CODEX_RULES_FILE);

  function homeWithMode(mode: number): void {
    fs.rmSync(home(), { recursive: true, force: true });
    fs.mkdirSync(home());
    fs.chmodSync(home(), mode);
  }

  /** The refusal's reason, after asserting there is one and that it named `named`. */
  function refused(named: string, owner = self): string {
    const delivery = mod.prepareCodexRules(owner);
    assert.equal(delivery.kind, "unavailable", `answered ready with ${named} untrustworthy`);
    const reason = delivery.kind === "unavailable" ? delivery.reason : "";
    assert.equal(
      reason.includes(named),
      true,
      `the reason must name ${named}, the directory an operator has to fix: ${reason}`,
    );
    return reason;
  }

  it("answers ready for the shape the entrypoint makes", () => {
    // The control, and the one that matters most in the other direction: a
    // check that refused 1770 would refuse every Codex cycle on every install.
    // Group-writable is right for CODEX_HOME because the sticky bit is what
    // stops a rename of root's `rules/`; `rules/` itself is made 0755.
    homeWithMode(0o1770);
    assert.deepEqual(mod.prepareCodexRules(self), { kind: "ready", file: CODEX_RULES_FILE });
    assert.equal(fs.lstatSync(rulesDir()).mode & 0o777, 0o755);
    assert.equal(mod.prepareCodexRules(self).kind, "ready");

    homeWithMode(0o755);
    assert.equal(mod.prepareCodexRules(self).kind, "ready");
  });

  it("refuses a CODEX_HOME the agents can write that is not sticky", () => {
    for (const mode of [0o777, 0o775]) {
      homeWithMode(mode);
      const reason = refused(home());
      assert.match(reason, /sticky/);
      assert.equal(fs.existsSync(CODEX_RULES_FILE), false, "wrote the denial into it anyway");
    }
  });

  it("refuses a CODEX_HOME that is not the server's", () => {
    // What every stock container had: `/home/node/.codex` owned by the agent
    // uid at 0755, which no mode check alone would have caught.
    homeWithMode(0o755);
    const reason = refused(home(), self + 1);
    assert.match(reason, new RegExp(`uid ${self}\\b`));
  });

  it("refuses a rules/ that is a link to a directory an agent owns, and writes nothing through it", () => {
    homeWithMode(0o1770);
    const agentDir = path.join(path.dirname(home()), "agent-owned");
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.mkdirSync(agentDir);
    fs.symlinkSync(agentDir, rulesDir());

    assert.match(refused(rulesDir()), /symbolic link/);
    assert.deepEqual(fs.readdirSync(agentDir), [], "the denial was written where the agent can edit it");
  });

  it("names a dangling link at rules/ rather than an errno", () => {
    homeWithMode(0o1770);
    fs.symlinkSync(path.join(path.dirname(home()), "no-such-directory"), rulesDir());
    assert.match(refused(rulesDir()), /symbolic link/);
  });

  it("names a file at rules/ rather than an errno", () => {
    homeWithMode(0o1770);
    fs.writeFileSync(rulesDir(), "not a directory");
    assert.match(refused(rulesDir()), /not a directory/);
  });

  it("refuses a rules/ the agents can write into", () => {
    // Where they could delete the denial or add a file Codex also loads.
    homeWithMode(0o1770);
    fs.mkdirSync(rulesDir());
    fs.chmodSync(rulesDir(), 0o777);
    refused(rulesDir());
    assert.equal(fs.existsSync(CODEX_RULES_FILE), false);
  });

  it("refuses a CODEX_HOME the agents could rename out of its parent", () => {
    // A perfect 1770 home and 0755 `rules/` keep nothing if the name they are
    // reached by can be swapped: the fixture's parent is a plain directory on
    // the same filesystem, so only its mode stands between a cycle and a
    // directory of its own at that name. Every other case here runs under a
    // 0700 parent, which is why they answer ready.
    homeWithMode(0o1770);
    const parent = path.dirname(home());
    fs.chmodSync(parent, 0o777);
    try {
      const reason = refused(home());
      assert.match(reason, /not a mount point/);
      assert.match(reason, /Mount the usagefoundry-codex volume at CODEX_HOME/);
      assert.equal(fs.existsSync(rulesDir()), false, "made rules/ under a swappable name");
    } finally {
      fs.chmodSync(parent, 0o700);
    }
  });
});

/**
 * Whether the name `CODEX_HOME` is reached by can be swapped, decided over two
 * `lstat` results. The suite can neither mount a volume nor chown to root, so
 * the stock shape — a mount point under the agents' `/home/node` — is only
 * reachable here, and it is the case that has to stay ready: refusing it
 * refuses every Codex cycle on every install.
 */
describe("codexHomeNameUnsafeBecause", () => {
  const home = "/home/node/.codex";
  const agent = 1000;
  const server = 0;
  const dir = (dev: number, uid: number, mode: number) => ({
    dev,
    uid,
    mode: fs.constants.S_IFDIR | mode,
  });

  it("answers null for a mount point under the agents' own directory", () => {
    assert.equal(
      mod.codexHomeNameUnsafeBecause(home, dir(41, server, 0o1770), dir(60, agent, 0o755), server),
      null,
    );
  });

  it("refuses a plain directory under the agents' own directory, naming both fixes", () => {
    const reason = mod.codexHomeNameUnsafeBecause(
      home,
      dir(60, server, 0o1770),
      dir(60, agent, 0o755),
      server,
    );
    assert.equal(typeof reason, "string");
    assert.match(reason!, /\/home\/node\/\.codex is not a mount point/);
    assert.match(reason!, /\/home\/node is owned by uid 1000, not by this server's uid 0/);
    assert.match(reason!, /Mount the usagefoundry-codex volume at CODEX_HOME/);
    assert.match(reason!, /point CODEX_HOME at a directory whose parent only root can write/);
  });

  it("answers null for a plain directory under a parent only the server can write", () => {
    assert.equal(
      mod.codexHomeNameUnsafeBecause(
        "/var/lib/codex/home",
        dir(60, server, 0o1770),
        dir(60, server, 0o755),
        server,
      ),
      null,
    );
  });

  it("refuses a server-owned parent with any write bit for group or others, sticky or not", () => {
    // A child keeps the server's supplementary groups, so no group's write bit
    // is provably out of its reach.
    for (const mode of [0o775, 0o757, 0o1777, 0o1775]) {
      const reason = mod.codexHomeNameUnsafeBecause(
        "/var/lib/codex/home",
        dir(60, server, 0o1770),
        dir(60, server, mode),
        server,
      );
      assert.match(
        reason ?? "",
        new RegExp(`/var/lib/codex is mode ${mode.toString(8).padStart(4, "0")}`),
        `answered null under a ${mode.toString(8)} parent`,
      );
    }
  });
});
