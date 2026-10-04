import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildArgs } from "./cycleInvocation";
import {
  CLI_TMPDIR_MAX_BYTES,
  claudeSessionTmpdir,
  decideTmpdirNotice,
} from "./tmpdirNotice";

/**
 * The `$TMPDIR` notice, and the ways it can be worse than not shipping it.
 *
 * Every one is silent, which is the bar `docs/agent/testing.md` sets: nothing
 * throws, nothing fails to typecheck, and the run reads a path and carries on.
 *
 * **A confident wrong path** is the failure the notice exists to remove, stated
 * by the supervisor this time. The directory follows the uid the CLI runs as and
 * the environment it inherits, so a constant is right on the install that typed
 * it and wrong everywhere else; and where the value cannot be known the answer
 * is no notice, not a guess.
 *
 * **Drift** is the expensive one, as `fileCostNotice.test.ts` argues at length:
 * the text joins the cached prefix, so a prompt that differed between two cycles
 * of one run is a full-price re-read of the whole context, and the run looks
 * fine while it costs more.
 */

const base = {
  prompt: "do the thing",
  model: null,
  permissionMode: "acceptEdits" as const,
  resumeSessionId: null,
  maxRunCostUSD: null,
  maxRunCostFactor: null,
  spentGuardUSD: 0,
};

const known = { provider: null, sandbox: "on" as const, uid: 1000, env: {} };

const SENTENCE =
  "In sandboxed Bash commands $TMPDIR is /tmp/claude-1000. The Read tool does not " +
  "expand variables, so when you Read a file you wrote under $TMPDIR, give Read " +
  "that literal path.";

function appended(args: string[]): string {
  return args[args.indexOf("--append-system-prompt") + 1] ?? "";
}

describe("decideTmpdirNotice", () => {
  it("states the literal directory in the pinned sentence", () => {
    for (const provider of [null, undefined, "claude", "local"] as const) {
      assert.equal(decideTmpdirNotice({ ...known, provider }), SENTENCE);
    }
  });

  it("derives the directory from the uid rather than carrying a constant", () => {
    const notice = decideTmpdirNotice({ ...known, uid: 1234 });
    assert.match(notice, /\/tmp\/claude-1234\b/);
    assert.doesNotMatch(notice, /claude-1000/);
    assert.equal(claudeSessionTmpdir({ env: {}, uid: 0 }), "/tmp/claude-0");
  });

  it("follows the temp root the child inherits, in the CLI's own order", () => {
    // The CLI's per-uid root is `CLAUDE_CODE_TMPDIR || os.tmpdir()`, and Node's
    // `os.tmpdir()` is the first non-empty of TMPDIR, TMP, TEMP — an empty
    // string is unset in both, which is how compose renders an optional variable.
    assert.equal(
      claudeSessionTmpdir({ env: { CLAUDE_CODE_TMPDIR: "/var/uf", TMPDIR: "/scratch" }, uid: 7 }),
      "/var/uf/claude-7",
    );
    assert.equal(claudeSessionTmpdir({ env: { TMPDIR: "/scratch/" }, uid: 7 }), "/scratch/claude-7");
    assert.equal(claudeSessionTmpdir({ env: { TMP: "/a", TEMP: "/b" }, uid: 7 }), "/a/claude-7");
    assert.equal(
      claudeSessionTmpdir({ env: { CLAUDE_CODE_TMPDIR: "", TMPDIR: "", TEMP: "/b" }, uid: 7 }),
      "/b/claude-7",
    );
  });

  it("says nothing wherever the value is not known", () => {
    for (const sandbox of ["none", "empty", "unknown"] as const) {
      assert.equal(decideTmpdirNotice({ ...known, sandbox }), "", `sandbox ${sandbox}`);
    }
    assert.equal(decideTmpdirNotice({ ...known, provider: "codex" }), "", "a Codex run");
    assert.equal(decideTmpdirNotice({ ...known, uid: null }), "", "no uid on this platform");
    assert.equal(
      decideTmpdirNotice({ ...known, env: { TMPDIR: "relative/dir" } }),
      "",
      "a relative root is not a path Read can be given",
    );
  });

  it("withholds a root the CLI would replace with a shorter directory", () => {
    // `/claude-1000` is 12 bytes, so a 32-byte root makes the per-uid directory
    // exactly the CLI's bound and a 33-byte one is the first the CLI swaps out.
    const atBound = `/${"a".repeat(CLI_TMPDIR_MAX_BYTES - 12 - 1)}`;
    assert.equal(claudeSessionTmpdir({ env: { TMPDIR: atBound }, uid: 1000 })?.length, 44);
    assert.equal(claudeSessionTmpdir({ env: { TMPDIR: `${atBound}a` }, uid: 1000 }), null);
    assert.equal(decideTmpdirNotice({ ...known, env: { TMPDIR: `${atBound}a` } }), "");
  });

  it("offers an agent nothing to match a process on", () => {
    // It rides every sibling's command line, and the same path is on all of them,
    // so what keeps its digits inert is what keeps the price list's inert:
    // nothing beside it reads as a command. The standing half's strict form —
    // no multi-digit run — is deliberately not asked of this half.
    const notice = decideTmpdirNotice(known);
    assert.doesNotMatch(notice, /\bp?kill(all)?\b|\bpgrep\b|\bps -|\$\(|\s-f\b/);
    assert.equal(notice.includes("\n"), false, "one sentence-pair, not a block");
    assert.ok(notice.length < 220, "every character is re-read on every turn");
  });
});

describe("the notice on a cycle's argv", () => {
  const stored = decideTmpdirNotice(known);
  const priceList = "src/lib/orchestrator.ts — 116k";

  it("is the same bytes on every cycle of a run, resumed or not", () => {
    // What `runs.tmpdir_notice` holds is handed to every cycle unchanged, and
    // nothing else varying between cycles may reach it: the guard figure, the
    // resume id and the isolation flag all move across a run.
    const opening = appended(buildArgs({ ...base, isolated: true, tmpdirNotice: stored }));
    const later = appended(
      buildArgs({
        ...base,
        isolated: true,
        resumeSessionId: "sess-1",
        spentGuardUSD: 3.5,
        tmpdirNotice: stored,
      }),
    );
    const third = appended(
      buildArgs({ ...base, isolated: false, resumeSessionId: "sess-2", tmpdirNotice: stored }),
    );
    assert.equal(later, opening);
    assert.ok(opening.endsWith(stored), "the notice must reach the flag");
    assert.equal(third.endsWith(stored), true);
  });

  it("rides after the price list and never displaces it", () => {
    const said = appended(
      buildArgs({ ...base, isolated: true, fileCostNotice: priceList, tmpdirNotice: stored }),
    );
    assert.ok(said.endsWith(`${priceList}\n\n${stored}`));
    const without = appended(buildArgs({ ...base, isolated: true, fileCostNotice: priceList }));
    assert.ok(said.startsWith(without), "the stored price list keeps its bytes and its place");
  });

  it("leaves the prompt byte-identical for a run with no notice", () => {
    // Every run created before `runs.tmpdir_notice` reads null here, and so does a
    // Codex run or one whose value was not known. The prompt for those has to be
    // the exact string this app sent before the feature — trailing blank lines
    // included — or a run mid-flight across a deploy pays a cold prefix on its
    // next cycle for a notice it was never given.
    const without = appended(buildArgs({ ...base, isolated: true, fileCostNotice: priceList }));
    for (const tmpdirNotice of [undefined, null, "", "   \n  "]) {
      assert.equal(
        appended(buildArgs({ ...base, isolated: true, fileCostNotice: priceList, tmpdirNotice })),
        without,
      );
    }
  });
});
