import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  sandboxArrangement,
  sandboxFailureNote,
  sandboxRefusal,
  type ManagedSettings,
} from "./sandbox";

/**
 * Covers the three pure readings in `sandbox.ts`, and only those.
 *
 * Both earn a test on the same grounds and both are asserted in **both**
 * directions, because each has two silent failure modes that point opposite
 * ways. The detector: miss a sandbox refusal and an operator is back to reading
 * a run that spent money and wrote nothing with no way to tell a policy from an
 * unproductive agent — the failure `seedReport` was written to end for seeding —
 * and match too eagerly and every ordinary permission error in every run is
 * filed as a policy decision, which is a signal that fires on everything. The
 * arrangement: a policy that is switched on and names nothing runs every command
 * unwrapped, and an unreadable policy file is not evidence of absence, so both
 * have to be distinguishable from a working sandbox and from a stock install.
 *
 * Most of the literals below were read out of the pinned CLI binary in
 * `proposals/implemented - Sandboxing/` and have never been executed. The `bwrap:` ones are
 * the exception and the reason the rest are worth having: they are copied out
 * of this install's own failed tool calls, where a sandbox that could not start
 * produced 214 of them and no `sandbox` row at all — and then, once that was
 * fixed, 714 more in a wording nobody had read. What this pins either way is
 * that the matcher is exactly as wide as the evidence, no wider.
 *
 * The third reading is the note the settings row carries when the detector has
 * been firing, and it earns a test on the same grounds as the other two: it is
 * the only place this module names a file for an operator to edit, and naming
 * the wrong one is a silent way to spend somebody's afternoon.
 */

describe("sandboxRefusal", () => {
  it("names the seccomp applier from the CLI's wrap-time message", () => {
    const text =
      "[Sandbox Linux] apply-seccomp binary not available - unix socket " +
      "blocking disabled. Install @anthropic-ai/sandbox-runtime globally for " +
      "full protection.";
    const refusal = sandboxRefusal(text);

    assert.equal(refusal?.kind, "seccomp-unavailable");
    // The more precise of the two true things about a message carrying both
    // the tag and the applier string.
    assert.equal(refusal?.matched, "apply-seccomp binary not available");
    // Verbatim: this recognises text read out of one build and never run, so
    // what it decided has to be checkable against what the tool said.
    assert.equal(refusal?.reason, text);
  });

  it("names it from the dependency check's own wording too", () => {
    const refusal = sandboxRefusal(
      "seccomp not available - unix socket access not restricted",
    );
    assert.equal(refusal?.kind, "seccomp-unavailable");
  });

  it("separates a sandbox that could not start from one that refused", () => {
    assert.equal(
      sandboxRefusal(
        "Sandbox required but unavailable: bwrap exited 1. Set " +
          "sandbox.failIfUnavailable=false to allow unsandboxed execution.",
      )?.kind,
      "sandbox-unavailable",
    );
    assert.equal(
      sandboxRefusal(
        "sandbox.failIfUnavailable is set — refusing to start without a " +
          "working sandbox.",
      )?.kind,
      "sandbox-unavailable",
    );
  });

  it("names a missing dependency as one, not as a refusal", () => {
    assert.equal(
      sandboxRefusal("bubblewrap (bwrap) not installed")?.kind,
      "dependency-missing",
    );
    assert.equal(sandboxRefusal("socat not installed")?.kind, "dependency-missing");
  });

  it("names a bubblewrap that could not start, which is what actually happened", () => {
    // The whole recorded line, copied out of `run_events` rather than trimmed
    // to the needle: this is the text the matcher has to survive, and the
    // `Exit code 1` prefix in front of it is the CLI's, not bwrap's.
    const text =
      "Exit code 1 bwrap: No permissions to create new namespace, likely " +
      "because the kernel does not allow non-privileged user namespaces. See " +
      "<https://deb.li/bubblewrap> or " +
      "<file:///usr/share/doc/bubblewrap/README.Debian.gz>.";
    const refusal = sandboxRefusal(text);

    assert.equal(refusal?.kind, "bwrap-failed");
    assert.equal(refusal?.matched, "bwrap: No permissions to create new namespace");
    assert.equal(refusal?.reason, text);

    // The failure after the seccomp profile is applied: the namespace is
    // created and the procfs mount inside it is refused.
    assert.equal(
      sandboxRefusal("bwrap: Can't mount proc on /newroot/proc: Operation not permitted")
        ?.kind,
      "bwrap-failed",
    );
    assert.equal(
      sandboxRefusal("bwrap: Creating new namespace failed: nesting depth or /proc/sys/user/max_*_namespaces exceeded (ENOSPC)")
        ?.kind,
      "bwrap-failed",
    );
  });

  it("names a bubblewrap that got as far as its mounts, which is what happens now", () => {
    // Copied out of this install's own failed tool calls, `Exit code 1` prefix
    // and newline included, because the whole recorded text is what the matcher
    // has to survive. Five wordings, 714 of them in the 18 days from
    // 2026-08-25, and every one is a command that never ran. The one above this
    // test — the namespace being refused outright — has not been recorded since
    // 2026-08-19, so before these matched, the detector was pinned entirely to
    // a string this install had stopped producing.
    const recorded = [
      "Exit code 1\nbwrap: Can't create file at /workspace/.claude/skills: Permission denied",
      "Exit code 1\nbwrap: Can't find source path /home/node/.claude/policy-limits.json: No such file or directory",
      "Exit code 1\nbwrap: Can't get type of source /workspace/Mclear/.git/config.lock: No such file or directory",
      "Exit code 1\nbwrap: Can't bind mount /oldroot/workspace2/.mcp.json on /newroot/workspace2/.mcp.json: Unable to mount source on destination: No such file or directory",
      'Exit code 1\nbwrap: Can\'t bind mount /oldroot/dev/null on /newroot/home/node/.claude/remote-settings.json.signature-iat.json: Unable to find "/newroot/home/node/.claude/remote-settings.json.signature-iat.json" in mount table',
      "Exit code 1\nbwrap: Can't create file at /workspace2/.claude/commands: Read-only file system",
    ];

    for (const text of recorded) {
      const refusal = sandboxRefusal(text);
      assert.equal(refusal?.kind, "bwrap-failed", text);
      assert.equal(refusal?.reason, text);
    }

    // The specific mount-time needle still answers first where it applies, so
    // the row keeps the more precise literal rather than the catch-all.
    assert.equal(
      sandboxRefusal("bwrap: Can't mount proc on /newroot/proc: Operation not permitted")
        ?.matched,
      "bwrap: Can't mount proc on",
    );
  });

  it("leaves a failed call that merely mentions bwrap alone", () => {
    // Both are real failed tool calls from this install, and both are why the
    // needle is `bwrap: Can't ` and not `bwrap: `: a process listing and a grep
    // of the compose file carry the word, and a run working on this repository
    // produces the second one on purpose.
    assert.equal(
      sandboxRefusal(
        "Exit code 7\n37946 bwrap --new-session --die-with-parent --unshare-net " +
          "--bind /tmp/claude-http-bbf9ae1008585e56.sock /tmp/claude-http-bbf9ae1008585e56.sock",
      ),
      null,
    );
    assert.equal(
      sandboxRefusal(
        "Exit code 2\n165:      # It needs the seccomp profile from the " +
          "security_opt block at the bottom\n435:    # bwrap, socat and the " +
          "seccomp applier, and every one of them sits unused,",
      ),
      null,
    );
  });

  it("does not fire on the word bwrap, which this repository also carries", () => {
    // The same argument the bare word "sandbox" is refused by, and it applies
    // harder here: the needles now live in this file, in `sandbox.ts` and in
    // `scripts/sandbox-probe/`, so a run grepping its own source must not
    // report a policy failure.
    assert.equal(sandboxRefusal("src/lib/sandbox.ts:88:  needle: \"bwrap: \""), null);
    assert.equal(sandboxRefusal("bwrap: --version"), null);
    assert.equal(sandboxRefusal("/usr/bin/bwrap: not found"), null);
  });

  it("keeps a tagged message this app has never read", () => {
    // The catch-all, and the direction it fails in: a message under the CLI's
    // own tag that nothing here recognises is reported as a sandbox message
    // rather than dropped, which costs a precise label and not the signal.
    const refusal = sandboxRefusal("[Sandbox Linux] some future sentence");
    assert.equal(refusal?.kind, "sandbox-message");
    assert.equal(refusal?.matched, "[Sandbox Linux]");
  });

  it("leaves an ordinary permission error alone", () => {
    // The expensive direction. A policy denial out of a mount namespace is
    // *also* an EACCES, so matching this would be the only way to catch one —
    // and would relabel every genuinely missing permission in every run as a
    // policy decision. It stays unmatched until there is a measured string to
    // match; see docs/verification.md.
    assert.equal(sandboxRefusal("EACCES: permission denied, open '/etc/hosts'"), null);
    assert.equal(sandboxRefusal("bash: /usr/local/bin/x: Permission denied"), null);
    assert.equal(
      sandboxRefusal(
        "Claude requested permissions to use Bash, but you haven't granted it yet.",
      ),
      null,
    );
  });

  it("does not match the bare word, which this repository is full of", () => {
    // A run working on UsageFoundry greps its own source. Every marker is a
    // sentence for exactly this reason.
    assert.equal(sandboxRefusal("src/lib/sandbox.ts:1:import fs"), null);
    assert.equal(sandboxRefusal("npm ERR! path /app/sandbox"), null);
    assert.equal(sandboxRefusal(""), null);
  });
});

describe("sandboxArrangement", () => {
  const absent: ManagedSettings = { kind: "absent" };
  const present = (json: unknown): ManagedSettings => ({ kind: "present", json });

  it("says none on a stock install", () => {
    assert.equal(sandboxArrangement(absent).state, "none");
    assert.equal(sandboxArrangement(absent).failIfUnavailable, null);
  });

  it("says none for a managed file that configures something else", () => {
    assert.equal(sandboxArrangement(present({ model: "opus" })).state, "none");
    assert.equal(
      sandboxArrangement(present({ sandbox: { enabled: false } })).state,
      "none",
    );
  });

  it("refuses to read a policy that names nothing as a sandbox", () => {
    // The finding this state exists for: with no filesystem, network or
    // credential entry the wrapper hands the command back unwrapped, so
    // `enabled: true` alone is an install that believes it is confined and is
    // not — and `failIfUnavailable` does not catch it, because a sandbox that
    // was never asked for anything is not one that failed.
    const reading = sandboxArrangement(present({ sandbox: { enabled: true } }));
    assert.equal(reading.state, "empty");
    assert.notEqual(reading.state, "on");
    // Absent defaults to on in the binary, so a missing key must not report a
    // refusal to start as a warning.
    assert.equal(reading.failIfUnavailable, true);
  });

  it("says on for a policy that names a path, a domain or a credential", () => {
    for (const sandbox of [
      { enabled: true, filesystem: { allowWrite: ["/workspace"] } },
      { enabled: true, network: { allowedDomains: ["registry.npmjs.org"] } },
      { enabled: true, network: { allowManagedDomainsOnly: true } },
      { enabled: true, credentials: { files: [{ path: "~/.claude" }] } },
    ]) {
      assert.equal(sandboxArrangement(present({ sandbox })).state, "on");
    }
  });

  it("does not take an empty list for an entry", () => {
    assert.equal(
      sandboxArrangement(present({ sandbox: { enabled: true, filesystem: { allowWrite: [] } } }))
        .state,
      "empty",
    );
  });

  it("carries failIfUnavailable rather than folding it into the state", () => {
    // Two different facts: whether a sandbox is configured, and whether an
    // install finds out when it cannot start. A false here is a fleet running
    // unsandboxed on a warning nobody reads.
    const reading = sandboxArrangement(
      present({
        sandbox: {
          enabled: true,
          failIfUnavailable: false,
          filesystem: { denyRead: ["/data"] },
        },
      }),
    );
    assert.equal(reading.state, "on");
    assert.equal(reading.failIfUnavailable, false);
    assert.match(reading.detail, /still runs/);
  });

  it("says unknown for a policy file it could not read", () => {
    // Never "none": a file that exists and cannot be parsed is the one case
    // where this app does not know what confines a run, and a confident zero
    // there is the same failure as a 0% meter over a window with no reading.
    const reading = sandboxArrangement({
      kind: "unreadable",
      problem: "Unexpected end of JSON input",
    });
    assert.equal(reading.state, "unknown");
    assert.equal(reading.failIfUnavailable, null);
    assert.match(reading.detail, /Unexpected end of JSON input/);
  });

  it("reads a sandbox key that is not an object as no policy", () => {
    // Hand-edited files are the case this arrives from, and the direction that
    // is safe is understating a boundary rather than claiming one.
    assert.equal(sandboxArrangement(present({ sandbox: true })).state, "none");
    assert.equal(sandboxArrangement(present("not settings at all")).state, "none");
    assert.equal(sandboxArrangement(present(null)).state, "none");
  });
});

describe("sandboxFailureNote", () => {
  const mount = {
    matched: "bwrap: Can't ",
    reason:
      "Exit code 1\nbwrap: Can't create file at /home/node/.claude/seed-admin: Permission denied",
  };

  it("says nothing when nothing has failed", () => {
    // The row it sits on already says what the policy is. A note that appeared
    // on a working install would be the signal that fires on everything.
    assert.equal(sandboxFailureNote({ count: 0, hours: 24, latest: null }), null);
  });

  it("counts the calls and quotes the newest, without saying denied", () => {
    const note = sandboxFailureNote({ count: 14, hours: 24, latest: mount });
    assert.match(note ?? "", /^14 tool calls died inside bubblewrap in the last 24 hours/);
    // Verbatim and last: the one part of the sentence an operator can check
    // against the failed call itself.
    assert.match(
      note ?? "",
      /bwrap: Can't create file at \/home\/node\/\.claude\/seed-admin: Permission denied$/,
    );
    // Never the `Exit code 1` the CLI wrapped it in, and never a second line.
    assert.equal(note?.includes("Exit code"), false);
    assert.equal(note?.includes("denied the"), false);
  });

  it("names the seccomp profile only when the namespace was refused", () => {
    // The distinction the whole note exists for. `unshare` being EPERM is
    // fixed in one file; a mount point bubblewrap could not prepare is not, and
    // an operator sent to `security_opt` over the second edits nothing useful.
    const namespaceRefused = sandboxFailureNote({
      count: 3,
      hours: 24,
      latest: {
        matched: "bwrap: No permissions to create new namespace",
        reason:
          "Exit code 1\nbwrap: No permissions to create new namespace, likely " +
          "because the kernel does not allow non-privileged user namespaces.",
      },
    });
    assert.match(namespaceRefused ?? "", /docker-compose\.yml/);
    assert.match(namespaceRefused ?? "", /security_opt/);

    assert.equal(sandboxFailureNote({ count: 3, hours: 24, latest: mount })?.includes("seccomp"), false);
    // A needle this build does not know about falls to the quoted line alone.
    assert.equal(
      sandboxFailureNote({
        count: 1,
        hours: 24,
        latest: { matched: "[Sandbox Linux]", reason: "[Sandbox Linux] a future sentence" },
      })?.includes("docker-compose.yml"),
      false,
    );
  });

  it("agrees with itself about one call", () => {
    assert.match(
      sandboxFailureNote({ count: 1, hours: 24, latest: null }) ?? "",
      /^1 tool call died/,
    );
  });
});
