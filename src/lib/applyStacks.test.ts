import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * The pure half of `scripts/apply-stacks.mjs`: the parser, the expander and the
 * reconciler that decide what a boot installs and, more dangerously, what it
 * removes.
 *
 * Three of the functions here meet `CLAUDE.md`'s bar — a pure function whose
 * failure mode is silent — and each is silent in a different direction.
 *
 * `parseStack` is the refusal list, and its failures land on **somebody else's
 * machine**. A stack is an artifact a third party writes and an operator copies
 * into a directory, so a refusal that does not fire is a stack that looks
 * correct to its author and fails for its consumer: one `sha256` against a URL
 * that names one file per architecture installs on the author's architecture
 * and fails the digest on the other, blaming a machine nobody has. A refusal
 * that fires wrongly is the same fault in the other direction and is not
 * cheaper.
 *
 * `expandTokens` is two spellings of one switch. `dpkg --print-architecture`
 * says `arm64` where `uname -m` says `aarch64`, publishers use both, and a
 * wrong expansion is a 404 at boot on one architecture only, read once by
 * whoever was watching the restart.
 *
 * `reconcile` is the one whose failure is **unrecoverable**. It decides which
 * paths a boot deletes, and the rule it must never break is that it removes
 * only paths a receipt of its own records — so an operator's hand-installed
 * binary sitting in the same directory outlives every restart. Its other two
 * rules are just as quiet: a reinstall that took `state/` with it would throw
 * away a provider cache and cost a slow work cycle nobody could see, and a
 * failed stack that was skipped rather than retried would make the receipt set
 * a record of the boot that first failed rather than of this one, which is the
 * latch `/api/status` exists not to have.
 *
 * **Why a test for a `scripts/` file lives under `src/lib/`.** `npm test`
 * compiles `src/**` and runs the result; a test anywhere else is a test nothing
 * runs. The applier is imported rather than spawned — `backupRestore.test.ts`
 * spawns `backup-db.mjs` because its subject is a database copied under load,
 * and this file's subject is four pure functions. The applier guards its own
 * entry point on `import.meta.url`, so importing it applies nothing.
 */

function repoRoot(): string {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, `no package.json above ${__dirname}`);
    dir = parent;
  }
  return dir;
}

interface ParsedBin {
  from: string;
  as: string;
}
/**
 * One shape rather than a union, because that is what the applier normalises
 * to: `bin` is the field every verb has, and it is `{ from, as }` on all three
 * even though the two package verbs are written as bare command names.
 */
interface ParsedStep {
  kind: string;
  /** `archive` only. */
  url?: string;
  checksums?: string | null;
  sha256?: { amd64: string; arm64: string } | null;
  unpack?: string;
  /** `uv-tool` and `npm-global` only. */
  spec?: string;
  bin: ParsedBin[];
}
interface ParsedStack {
  name: string;
  summary: string;
  install: ParsedStep[];
  env: Record<string, string>;
  state: string[];
  deny: string[];
}
type ParseResult = { ok: true; stack: ParsedStack } | { ok: false; reason: string };

interface Declaration {
  name: string;
  ok: boolean;
  reason?: string;
  digest: string;
  bins: string[];
}
interface Receipt {
  name: string;
  digest: string;
  status: string;
  bin?: { name: string; path: string }[];
}
interface Applier {
  parseStack(text: string, dirName: string): ParseResult;
  expandTokens(value: string, context: { arch: string; name: string; root?: string }): string;
  refuseEnv(key: string, value: string): string | null;
  reconcile(
    declarations: Declaration[],
    receipts: Receipt[],
  ): {
    plan: { name: string; action: string; reason: string }[];
    removals: { name: string; paths: string[] }[];
  };
  digestOfText(text: string): string;
}

/**
 * Node resolves an ES module through `require` since 22.12, which is what lets
 * the CommonJS these tests compile to import the applier at all. `engines` in
 * `package.json` already says `>=22`.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const applier = require(path.join(repoRoot(), "scripts/apply-stacks.mjs")) as Applier;

/** The worked example from `proposals/CustomStacks/01b-stack-format.md` §5. */
const TERRAFORM = {
  schema: 1,
  name: "terraform",
  summary: "HashiCorp Terraform 1.13.1, with its provider cache off $HOME.",
  install: [
    {
      kind: "archive",
      url: "https://releases.hashicorp.com/terraform/1.13.1/terraform_1.13.1_linux_{arch}.zip",
      checksums: "https://releases.hashicorp.com/terraform/1.13.1/terraform_1.13.1_SHA256SUMS",
      unpack: "zip",
      bin: [{ from: "terraform", as: "terraform" }],
    },
  ],
  env: {
    TF_PLUGIN_CACHE_DIR: "{state}/plugin-cache",
    TF_CLI_ARGS_init: "-input=false",
    CHECKPOINT_DISABLE: "1",
  },
  state: ["plugin-cache"],
  deny: ["terraform apply", "terraform destroy"],
};

function parse(overrides: Record<string, unknown> = {}, dirName = "terraform"): ParseResult {
  return applier.parseStack(JSON.stringify({ ...TERRAFORM, ...overrides }), dirName);
}

function refusal(result: ParseResult): string {
  assert.equal(result.ok, false, "expected a refusal and the stack parsed");
  return (result as { ok: false; reason: string }).reason;
}

describe("parseStack — what is refused before anything is downloaded", () => {
  it("accepts the worked example whole", () => {
    const result = parse();
    assert.equal(result.ok, true, result.ok ? "" : (result as { reason: string }).reason);
    if (!result.ok) return;
    assert.equal(result.stack.name, "terraform");
    assert.equal(result.stack.install.length, 1);
    assert.deepEqual(result.stack.install[0].bin, [{ from: "terraform", as: "terraform" }]);
    assert.equal(result.stack.install[0].sha256, null);
    assert.deepEqual(result.stack.state, ["plugin-cache"]);
    assert.deepEqual(result.stack.deny, ["terraform apply", "terraform destroy"]);
  });

  it("refuses text that is not JSON at all, rather than throwing at the caller", () => {
    const result = applier.parseStack('{"schema": 1,', "terraform");
    assert.match(refusal(result), /not valid JSON/);
  });

  it("refuses an unknown top-level key", () => {
    assert.match(refusal(parse({ postinstall: "curl evil.example" })), /unknown top-level key/);
  });

  it("names `allow` rather than calling it a typo", () => {
    // It was the field until the grant became a deny-list, so a stack written
    // against the older text is a real thing to meet and "unknown key" would
    // send its author looking for a spelling mistake.
    assert.match(refusal(parse({ allow: ["terraform plan"] })), /deny-list/);
  });

  it("refuses a schema this build does not read", () => {
    assert.match(refusal(parse({ schema: 2 })), /schema is 2/);
  });

  it("refuses a name that disagrees with the directory", () => {
    // A mismatch means somebody copied a directory and did not finish, and
    // silently trusting either one is how an operator ends up with a tool they
    // did not choose.
    assert.match(refusal(parse({}, "terraform-copy")), /"terraform".*"terraform-copy"/);
  });

  it("refuses an empty install list", () => {
    assert.match(refusal(parse({ install: [] })), /install is missing/);
  });

  it("refuses a verb that is not one of the three", () => {
    // `apt-get` is the one an operator reaches for and the one `01d-` §3
    // refuses by name, so this is the message they actually meet.
    assert.match(refusal(parse({ install: [{ kind: "apt", spec: "jq" }] })), /not a verb/);
  });

  it("refuses a url or a checksums url that is not https", () => {
    assert.match(
      refusal(parse({ install: [{ ...TERRAFORM.install[0], url: "http://example.com/t.zip" }] })),
      /url is missing or is not an https/,
    );
    assert.match(
      refusal(
        parse({ install: [{ ...TERRAFORM.install[0], checksums: "ftp://example.com/SUMS" }] }),
      ),
      /checksums is not an https/,
    );
  });

  it("refuses a step carrying neither a digest nor a manifest, and one carrying both", () => {
    const neither = { ...TERRAFORM.install[0] } as Record<string, unknown>;
    delete neither.checksums;
    assert.match(refusal(parse({ install: [neither] })), /exactly one/);
    assert.match(
      refusal(parse({ install: [{ ...TERRAFORM.install[0], sha256: "a".repeat(64) }] })),
      /exactly one/,
    );
  });

  it("refuses one digest against a url that names one file per architecture", () => {
    // The defect a second worked example found: the string form makes a
    // correct-looking stack install on its author's architecture and fail the
    // digest on the other, blaming the consumer's machine in a message nobody
    // wrote.
    const step = { ...TERRAFORM.install[0], sha256: "a".repeat(64) } as Record<string, unknown>;
    delete step.checksums;
    assert.match(refusal(parse({ install: [step] })), /one digest against a url/);
  });

  it("accepts one digest when the url names one file", () => {
    const step = {
      ...TERRAFORM.install[0],
      url: "https://example.com/terraform.zip",
      sha256: "a".repeat(64),
    } as Record<string, unknown>;
    delete step.checksums;
    const result = parse({ install: [step] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Widened to both architectures so the applier has one code path, and the
    // widening is safe precisely because the url names one file.
    assert.deepEqual(result.stack.install[0].sha256, { amd64: "a".repeat(64), arm64: "a".repeat(64) });
  });

  it("refuses a per-architecture digest missing an architecture, or one that is not a digest", () => {
    const step = { ...TERRAFORM.install[0], sha256: { amd64: "a".repeat(64) } } as Record<string, unknown>;
    delete step.checksums;
    assert.match(refusal(parse({ install: [step] })), /sha256\.arm64 is missing/);

    const short = {
      ...TERRAFORM.install[0],
      sha256: { amd64: "a".repeat(64), arm64: "abc" },
    } as Record<string, unknown>;
    delete short.checksums;
    assert.match(refusal(parse({ install: [short] })), /sha256\.arm64/);
  });

  it("refuses an unpack this applier does not do", () => {
    assert.match(
      refusal(parse({ install: [{ ...TERRAFORM.install[0], unpack: "tar.xz" }] })),
      /unpack is missing or is not one of/,
    );
  });

  it("refuses a bin path that escapes the package directory, in either spelling", () => {
    for (const from of ["/etc/passwd", "../../etc/passwd", "a/../../etc/passwd"]) {
      assert.match(
        refusal(parse({ install: [{ ...TERRAFORM.install[0], bin: [{ from, as: "terraform" }] }] })),
        /escapes \{pkg\}/,
        `"${from}" was accepted`,
      );
    }
  });

  it("refuses a command name that is not a plain command name", () => {
    assert.match(
      refusal(
        parse({ install: [{ ...TERRAFORM.install[0], bin: [{ from: "terraform", as: "../tf" }] }] }),
      ),
      /plain command name/,
    );
  });

  it("refuses two steps linking one command name", () => {
    assert.match(
      refusal(parse({ install: [TERRAFORM.install[0], TERRAFORM.install[0]] })),
      /both link a binary called "terraform"/,
    );
  });

  it("refuses a deny entry naming a binary this stack does not link", () => {
    // Not to stop a stack granting what it should not, but to stop one denying
    // what it does not own: deny beats ISOLATED_GIT_TOOLS the same way it beats
    // the mode, so a stack that could write "git commit" here would silently
    // break every isolated run on the install.
    assert.match(refusal(parse({ deny: ["git commit"] })), /which this stack does not link/);
  });

  it("refuses a deny entry that could close the Bash(...) it is interpolated into", () => {
    assert.match(refusal(parse({ deny: ["terraform apply)"] })), /parenthesis/);
  });
});

/**
 * The two verbs that hand a spec to a package manager.
 *
 * Their refusals are argv refusals and nothing else, which is the difference
 * from `archive`: there is no URL to pin and no digest to check, because both
 * tools resolve a spec to a release at install time against their own
 * registries. What a stack carries here is the spec, and the two ways a spec
 * can stop being one argument are the two branches below — a leading `-`,
 * which both tools read as a flag, and whitespace, which is a second argument.
 * Either would install something other than what the file says, quietly, and
 * the operator's evidence would be a receipt naming the spec they wrote.
 */
describe("parsePackageStep — one spec, one argument", () => {
  const uv = { kind: "uv-tool", spec: "ruff==0.14.1", bin: ["ruff"] };
  const npm = { kind: "npm-global", spec: "@musistudio/claude-code-router@1.0.66", bin: ["ccr"] };

  function parseWith(step: Record<string, unknown>, extra: Record<string, unknown> = {}): ParseResult {
    return applier.parseStack(
      JSON.stringify({ schema: 1, name: "tools", install: [step], ...extra }),
      "tools",
    );
  }

  it("normalises a bare command name into the shape archive leaves", () => {
    // The whole reason the two shapes converge here: the duplicate-binary
    // check, the deny rule, the linker and the receipt all read `{ from, as }`,
    // and a second shape carried to the end would be four places that can
    // disagree about what a stack links.
    const result = parseWith(uv);
    assert.equal(result.ok, true, result.ok ? "" : (result as { reason: string }).reason);
    if (!result.ok) return;
    assert.deepEqual(result.stack.install[0].bin, [{ from: "bin/ruff", as: "ruff" }]);
    assert.equal(result.stack.install[0].spec, "ruff==0.14.1");
  });

  it("keeps a scoped npm package, whose spec is full of characters a name may not have", () => {
    const result = parseWith(npm);
    assert.equal(result.ok, true, result.ok ? "" : (result as { reason: string }).reason);
    if (!result.ok) return;
    assert.equal(result.stack.install[0].spec, "@musistudio/claude-code-router@1.0.66");
    assert.deepEqual(result.stack.install[0].bin, [{ from: "bin/ccr", as: "ccr" }]);
  });

  it("refuses a spec that would be read as a flag rather than a package", () => {
    assert.match(refusal(parseWith({ ...uv, spec: "--upgrade" })), /reads? as a flag/);
  });

  it("refuses a spec carrying a second argument inside it", () => {
    assert.match(refusal(parseWith({ ...uv, spec: "ruff --force" })), /one package per step/);
    assert.match(refusal(parseWith({ ...uv, spec: "" })), /missing or is not a non-empty string/);
  });

  it("refuses archive's keys on a package step, and its own on an archive one", () => {
    assert.match(refusal(parseWith({ ...uv, url: "https://example.com/x.tgz" })), /unknown key "url"/);
    assert.match(
      refusal(parse({ install: [{ ...TERRAFORM.install[0], spec: "ruff" }] })),
      /unknown key "spec"/,
    );
  });

  it("refuses a bin entry that is not a plain command name", () => {
    // `archive` spells its `bin` as objects and this spells it as strings, so
    // an author copying one into the other meets a refusal rather than a step
    // that installs and links nothing.
    assert.match(refusal(parseWith({ ...uv, bin: [{ from: "ruff", as: "ruff" }] })), /plain command name/);
    assert.match(refusal(parseWith({ ...uv, bin: ["../ruff"] })), /plain command name/);
    assert.match(refusal(parseWith({ ...uv, bin: [] })), /is missing, is not an array, or is empty/);
  });

  it("lets a deny entry name a command a package step links", () => {
    const result = parseWith(npm, { deny: ["ccr start"] });
    assert.equal(result.ok, true, result.ok ? "" : (result as { reason: string }).reason);
    if (!result.ok) return;
    assert.deepEqual(result.stack.deny, ["ccr start"]);
  });

  it("catches two verbs claiming one command name, across the shape boundary", () => {
    assert.match(
      refusal(
        applier.parseStack(
          JSON.stringify({
            schema: 1,
            name: "tools",
            install: [uv, { kind: "npm-global", spec: "ruff-js@1.0.0", bin: ["ruff"] }],
          }),
          "tools",
        ),
      ),
      /both link a binary called "ruff"/,
    );
  });
});

describe("refuseEnv — the keys a stack may set, and the values", () => {
  it("refuses every UF_ key, because childEnv would delete it after it was set", () => {
    const reason = applier.refuseEnv("UF_SANDBOX", "1");
    assert.match(String(reason), /childEnv deletes every UF_ key/);
  });

  it("refuses the keys that decide where things are rather than what is installed", () => {
    for (const key of ["PATH", "HOME", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "DATA_DIR"]) {
      assert.notEqual(applier.refuseEnv(key, "/tmp"), null, `${key} was accepted`);
    }
    for (const key of ["GIT_DIR", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME"]) {
      assert.notEqual(applier.refuseEnv(key, "x"), null, `${key} was accepted`);
    }
  });

  it("refuses a value that assumes a shell, because there is not one", () => {
    assert.notEqual(applier.refuseEnv("TF_CLI_ARGS", "$(whoami)"), null);
    assert.notEqual(applier.refuseEnv("TF_CLI_ARGS", "a; rm -rf /"), null);
    assert.notEqual(applier.refuseEnv("TF_CLI_ARGS", "`id`"), null);
  });

  it("allows the four expansion tokens, which are the only braces the format has", () => {
    assert.equal(applier.refuseEnv("TF_PLUGIN_CACHE_DIR", "{state}/plugin-cache"), null);
    assert.equal(applier.refuseEnv("TOOL_HOME", "{pkg}"), null);
    assert.equal(applier.refuseEnv("TF_CLI_ARGS_init", "-input=false"), null);
  });

  it("refuses a value pointing into the host's own ~/.claude", () => {
    // That bind is every session on the machine, not this container's.
    const reason = applier.refuseEnv("TOOL_HOME", "/home/node/.claude/plugins");
    assert.match(String(reason), /host's own ~\/\.claude/);
  });

  it("refuses a key that is not a variable name", () => {
    assert.notEqual(applier.refuseEnv("not a name", "x"), null);
  });
});

describe("expandTokens — two spellings of one architecture, and two directories", () => {
  const context = { arch: "arm64", name: "terraform", root: "/var/lib/uf-stacks" };

  it("spells the architecture both ways from the same switch", () => {
    assert.equal(applier.expandTokens("linux_{arch}.zip", context), "linux_arm64.zip");
    assert.equal(applier.expandTokens("linux.{arch_uname}.tar.gz", context), "linux.aarch64.tar.gz");
    assert.equal(
      applier.expandTokens("{arch}-{arch_uname}", { ...context, arch: "amd64" }),
      "amd64-x86_64",
    );
  });

  it("does not let {arch} eat the first half of {arch_uname}", () => {
    // The two tokens share a prefix, and a substitution done in the other order
    // leaves `{arch_uname}` reading `arm64_uname}` — a 404 at boot on one
    // architecture, read once.
    assert.equal(applier.expandTokens("{arch_uname}", context), "aarch64");
  });

  it("expands the two directories a stack is given", () => {
    assert.equal(
      applier.expandTokens("{state}/plugin-cache", context),
      "/var/lib/uf-stacks/state/terraform/plugin-cache",
    );
    assert.equal(applier.expandTokens("{pkg}/bin", context), "/var/lib/uf-stacks/pkg/terraform/bin");
  });

  it("leaves anything that is not one of the four tokens alone", () => {
    // There is no shell, so there is no $VAR, no backtick and no $( ).
    assert.equal(applier.expandTokens("$HOME/{arch}", context), "$HOME/arm64");
  });
});

describe("reconcile — what a boot installs, and the paths it is allowed to delete", () => {
  const ok = (name: string, digest: string, bins: string[] = [name]): Declaration => ({
    name,
    ok: true,
    digest,
    bins,
  });

  it("skips a declaration whose digest matches an ok receipt, and only then", () => {
    const { plan } = applier.reconcile(
      [ok("terraform", "abc")],
      [{ name: "terraform", digest: "abc", status: "ok" }],
    );
    assert.deepEqual(plan.map((p) => [p.name, p.action]), [["terraform", "skip"]]);
  });

  it("retries a declaration whose digest matches a failed receipt", () => {
    // Without this a failed stack is attempted once and skipped for ever, which
    // makes the receipt set a record of the boot that first failed rather than
    // of this one — and the whole claim of the status reading is that it
    // de-latches on a boot.
    for (const status of ["failed", "conflicted"]) {
      const { plan } = applier.reconcile(
        [ok("terraform", "abc")],
        [{ name: "terraform", digest: "abc", status }],
      );
      assert.equal(plan[0].action, "install");
      assert.match(plan[0].reason, new RegExp(status));
    }
  });

  it("reinstalls when the declaration changed, and installs when there is no receipt", () => {
    const changed = applier.reconcile(
      [ok("terraform", "def")],
      [{ name: "terraform", digest: "abc", status: "ok" }],
    );
    assert.equal(changed.plan[0].action, "install");
    assert.match(changed.plan[0].reason, /declaration changed/);

    const fresh = applier.reconcile([ok("terraform", "abc")], []);
    assert.equal(fresh.plan[0].action, "install");
    assert.match(fresh.plan[0].reason, /no receipt/);
  });

  it("removes only the paths the receipt itself records", () => {
    // The failure mode is deleting something the applier did not install, which
    // is silent and unrecoverable. The links come off the receipt and never off
    // a listing of bin/, so a binary somebody put there by hand outlives every
    // restart.
    const { plan, removals } = applier.reconcile(
      [],
      [
        {
          name: "shell-lint",
          digest: "abc",
          status: "ok",
          bin: [{ name: "shellcheck", path: "/var/lib/uf-stacks/bin/shellcheck" }],
        },
      ],
    );
    assert.deepEqual(plan, []);
    assert.deepEqual(removals, [
      {
        name: "shell-lint",
        paths: [
          "/var/lib/uf-stacks/pkg/shell-lint",
          "/var/lib/uf-stacks/state/shell-lint",
          "/var/lib/uf-stacks/bin/shellcheck",
        ],
      },
    ]);
  });

  it("does not plan a removal for a stack that is still declared", () => {
    const { removals } = applier.reconcile(
      [ok("terraform", "abc")],
      [{ name: "terraform", digest: "abc", status: "ok" }],
    );
    assert.deepEqual(removals, []);
  });

  it("refuses both stacks that claim one command, and tells each about the other", () => {
    // Letting the lexically first win would hand the operator a version they
    // did not choose with nothing to read.
    const { plan } = applier.reconcile(
      [ok("terraform", "abc"), ok("terraform-edge", "def", ["terraform"])],
      [],
    );
    assert.deepEqual(plan.map((p) => p.action), ["conflict", "conflict"]);
    assert.match(plan[0].reason, /"terraform-edge"/);
    assert.match(plan[1].reason, /"terraform"/);
    assert.match(plan[0].reason, /Neither was linked/);
  });

  it("carries a parse refusal through as its own action and lets it contest nothing", () => {
    // A stack that did not parse declares no binaries, so it cannot take a name
    // away from one that did.
    const { plan } = applier.reconcile(
      [
        { name: "broken", ok: false, reason: "schema is 2 and this build reads 1", digest: "", bins: [] },
        ok("terraform", "abc"),
      ],
      [],
    );
    assert.equal(plan[0].action, "refuse");
    assert.match(plan[0].reason, /schema is 2/);
    assert.equal(plan[1].action, "install");
  });
});

describe("digestOfText — what a reinstall turns on", () => {
  it("is sha256 over the whole file and not over the install steps", () => {
    // A narrower digest would skip a reinstall when only `deny` changed. The
    // cost of the simple rule is one unnecessary download; the cost of the
    // clever one is a binary that does not match its declaration with nothing
    // saying so.
    const one = applier.digestOfText(JSON.stringify(TERRAFORM));
    const two = applier.digestOfText(JSON.stringify({ ...TERRAFORM, deny: [] }));
    assert.notEqual(one, two);
    assert.match(one, /^[0-9a-f]{64}$/);
  });
});
