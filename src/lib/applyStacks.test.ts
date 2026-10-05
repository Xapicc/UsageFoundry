import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
 * entry point on `import.meta.url`, so importing it applies nothing. The one
 * exception spawns it, because its subject is which binary a spawn finds.
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
  /** Per architecture, like `url` and `sha256`. A plain string parses to both. */
  from: { amd64: string; arm64: string };
  as: string;
}
/**
 * One shape rather than a union, because that is what the applier normalises
 * to: `bin` is the field every verb has, and it is `{ from, as }` on all three
 * even though the two package verbs are written as bare command names.
 */
interface ParsedStep {
  kind: string;
  /** `archive` only. Normalised to one url per architecture, like `sha256`. */
  url?: { amd64: string; arm64: string };
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
    assert.deepEqual(result.stack.install[0].bin, [
      { from: { amd64: "terraform", arm64: "terraform" }, as: "terraform" },
    ]);
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

  it("takes a url per architecture, for a publisher whose layout no token spells", () => {
    // Swift, measured 2026-09-12: `debian12-aarch64/…-debian12-aarch64.tar.gz`
    // on one architecture and `debian12/…-debian12.tar.gz` on the other, where
    // the second names no architecture at all and `…/debian12-x86_64/…` is a
    // 404. `{arch}` and `{arch_uname}` both expand to *something*, so neither
    // can produce a url with the segment missing.
    const step = {
      ...TERRAFORM.install[0],
      url: { amd64: "https://example.com/tool.tar.gz", arm64: "https://example.com/tool-aarch64.tar.gz" },
      sha256: { amd64: "a".repeat(64), arm64: "b".repeat(64) },
    } as Record<string, unknown>;
    delete step.checksums;
    const result = parse({ install: [step] });
    assert.equal(result.ok, true, result.ok ? "" : (result as { reason: string }).reason);
    if (!result.ok) return;
    assert.deepEqual(result.stack.install[0].url, {
      amd64: "https://example.com/tool.tar.gz",
      arm64: "https://example.com/tool-aarch64.tar.gz",
    });
  });

  it("refuses one digest against two urls, the same way it refuses one against a token", () => {
    // The refusal that matters on this field: two urls are two files, and a
    // single digest is then true of at most one of them — which installs on the
    // author's architecture and fails the digest on the consumer's.
    const step = {
      ...TERRAFORM.install[0],
      url: { amd64: "https://example.com/tool.tar.gz", arm64: "https://example.com/tool-aarch64.tar.gz" },
      sha256: "a".repeat(64),
    } as Record<string, unknown>;
    delete step.checksums;
    assert.match(refusal(parse({ install: [step] })), /one digest against a url/);
  });

  it("accepts one digest when both architectures name one file", () => {
    // The control for the pair above: an object url whose two entries are the
    // same url is one file, so a single digest is honest.
    const same = "https://example.com/tool.tar.gz";
    const step = {
      ...TERRAFORM.install[0],
      url: { amd64: same, arm64: same },
      sha256: "a".repeat(64),
    } as Record<string, unknown>;
    delete step.checksums;
    const result = parse({ install: [step] });
    assert.equal(result.ok, true, result.ok ? "" : (result as { reason: string }).reason);
  });

  it("refuses a url object that is missing an architecture or names an extra one", () => {
    for (const [url, pattern] of [
      [{ amd64: "https://example.com/t.tar.gz" }, /url\.arm64 is missing/],
      [{ amd64: "https://e.com/t", arm64: "https://e.com/t", riscv: "https://e.com/t" }, /unknown key "riscv"/],
      [{ amd64: "https://e.com/t", arm64: "http://e.com/t" }, /url\.arm64 is missing or is not an https/],
    ] as const) {
      const step = { ...TERRAFORM.install[0], url } as Record<string, unknown>;
      assert.match(refusal(parse({ install: [step] })), pattern);
    }
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
 * The stacks under the operator's `./stacks` on 2026-10-04, as written there.
 * `stacks/*` is git-ignored, so they are copied here rather than read: a test
 * reading the directory would pass on an empty checkout having parsed nothing.
 */
const SHIPPED_STACKS = [
  {
    schema: 1,
    name: "go",
    summary: "Go 1.26.6 — the toolchain that used to be in the image, with the module cache left where it was.",
    install: [
      {
        kind: "archive",
        url: "https://dl.google.com/go/go1.26.6.linux-{arch}.tar.gz",
        sha256: {
          amd64: "708effb774be8237570d0add163225abbdfaf4fca28b2611df167beba4feef89",
          arm64: "d0507e9e9d7fe012aae570108cbd76c15de879e17130ab8cb90d4d7445cb1f2e",
        },
        unpack: "tar.gz",
        bin: [
          { from: "go/bin/go", as: "go" },
          { from: "go/bin/gofmt", as: "gofmt" },
        ],
      },
    ],
  },
  {
    schema: 1,
    name: "python",
    summary:
      "CPython 3.13.15 (python-build-standalone) as python, pip and pip3, with the ensurepip the image's python3 lacks — so python -m venv works. python3 stays the image's 3.11.",
    install: [
      {
        kind: "archive",
        url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260924/cpython-3.13.15+20260924-{arch_uname}-unknown-linux-gnu-install_only.tar.gz",
        checksums: "https://github.com/astral-sh/python-build-standalone/releases/download/20260924/SHA256SUMS",
        unpack: "tar.gz",
        bin: [
          { from: "python/bin/python3.13", as: "python" },
          { from: "python/bin/pip", as: "pip" },
          { from: "python/bin/pip3", as: "pip3" },
        ],
      },
    ],
    env: { PIP_REQUIRE_VIRTUALENV: "true" },
  },
  {
    schema: 1,
    name: "shell-lint",
    summary: "shellcheck 0.11.0 and shfmt 3.14.1, for agents editing shell scripts",
    install: [
      {
        kind: "archive",
        url: "https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.{arch_uname}.tar.gz",
        sha256: {
          amd64: "b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6",
          arm64: "68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc",
        },
        unpack: "tar.gz",
        bin: [{ from: "shellcheck-v0.11.0/shellcheck", as: "shellcheck" }],
      },
      {
        kind: "archive",
        url: "https://github.com/mvdan/sh/releases/download/v3.14.1/shfmt_v3.14.1_linux_{arch}",
        sha256: {
          amd64: "76e77641faa025814b77f153b29796b8e6fa2fca03e0c76a691608b86c7ea7bf",
          arm64: "5f2db09dae91fca848f7adbdd014632e921a383863a2ad7e0450ad3aba0c6489",
        },
        unpack: "none",
        bin: [{ from: "shfmt_v3.14.1_linux_{arch}", as: "shfmt" }],
      },
    ],
    deny: ["shfmt -w"],
  },
  {
    schema: 1,
    name: "swift",
    summary: "Swift 6.3.3 for Debian 12 — swiftc and swift build, with the package cache off $HOME.",
    install: [
      {
        kind: "archive",
        url: {
          amd64: "https://download.swift.org/swift-6.3.3-release/debian12/swift-6.3.3-RELEASE/swift-6.3.3-RELEASE-debian12.tar.gz",
          arm64: "https://download.swift.org/swift-6.3.3-release/debian12-aarch64/swift-6.3.3-RELEASE/swift-6.3.3-RELEASE-debian12-aarch64.tar.gz",
        },
        sha256: {
          amd64: "19e0c78cad5418ad48bfa87aa20c53ac9ac9996d1695d04dd94f7c7ea4eb133f",
          arm64: "ecba8ef87b54a5048d466af500f3169c939a6b8a2cb7c600f76b5184457f293a",
        },
        unpack: "tar.gz",
        bin: [
          {
            from: {
              amd64: "swift-6.3.3-RELEASE-debian12/usr/bin/swift",
              arm64: "swift-6.3.3-RELEASE-debian12-aarch64/usr/bin/swift",
            },
            as: "swift",
          },
          {
            from: {
              amd64: "swift-6.3.3-RELEASE-debian12/usr/bin/swiftc",
              arm64: "swift-6.3.3-RELEASE-debian12-aarch64/usr/bin/swiftc",
            },
            as: "swiftc",
          },
        ],
      },
    ],
    env: { SWIFTPM_CACHE_DIR: "{state}/swiftpm" },
    state: ["swiftpm"],
  },
];

/**
 * `bin/` is first on root's `PATH`, so a stack that links a name root looks up
 * gets its code run as root on the next boot, whatever its verb. The refusal
 * has to name the word, because the author who meets it has done nothing wrong
 * by their own lights, and the list has to stop short of the image: shadowing
 * the image is what `bin/` is first on `PATH` for.
 */
describe("parseStack — the names root runs, which no stack may link", () => {
  it("refuses an archive that links git, and says git is the reserved word", () => {
    // Also what keeps `deny: ["git commit"]` refused: a stack that may not link
    // `git` cannot own it, and deny beats ISOLATED_GIT_TOOLS.
    const reason = refusal(
      parse({ install: [{ ...TERRAFORM.install[0], bin: [{ from: "terraform", as: "git" }] }], deny: ["git commit"] }),
    );
    assert.match(reason, /"git" is a reserved name/);
  });

  it("refuses the applier's own tools and the server's interpreter, from either kind of step", () => {
    for (const name of ["node", "chown", "curl", "setpriv", "sha256sum", "tar"]) {
      assert.match(
        refusal(parse({ install: [{ ...TERRAFORM.install[0], bin: [{ from: "terraform", as: name }] }], deny: [] })),
        new RegExp(`"${name}" is a reserved name`),
      );
      assert.match(
        refusal(
          applier.parseStack(
            JSON.stringify({ schema: 1, name: "tools", install: [{ kind: "npm-global", spec: "x@1.0.0", bin: [name] }] }),
            "tools",
          ),
        ),
        new RegExp(`"${name}" is a reserved name`),
      );
    }
  });

  it("still parses every stack the operator ships, python's python, pip and pip3 included", () => {
    for (const stack of SHIPPED_STACKS) {
      const result = applier.parseStack(JSON.stringify(stack), stack.name);
      assert.equal(result.ok, true, result.ok ? "" : `${stack.name}: ${(result as { reason: string }).reason}`);
    }
  });
});

/**
 * The applier is root and runs under a `PATH` that starts with the directory it
 * links stacks into, so every program it spawns has to be the image's by path.
 * Spawned rather than imported because what is under test is `spawnSync`'s
 * lookup: a `PATH` with a planted copy of every tool goes first, and nothing
 * planted may run. The download is aimed at a closed loopback port so the boot
 * reaches `dpkg` and `curl` and fails before anything needs root or a network.
 */
describe("the applier's own tools — the image's, never the first on PATH", () => {
  it("runs none of the copies planted ahead of them", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "uf-stacks-path-"));
    const planted = path.join(scratch, "planted");
    const ran = path.join(scratch, "ran.log");
    fs.mkdirSync(planted);
    const tools = ["chmod", "chown", "cp", "curl", "dpkg", "npm", "python3", "setpriv", "sha256sum", "tar", "uv"];
    for (const name of tools) {
      fs.writeFileSync(path.join(planted, name), `#!/bin/sh\necho ${name} >> "${ran}"\nexit 1\n`, { mode: 0o755 });
    }
    const declarations = path.join(scratch, "declarations");
    fs.mkdirSync(path.join(declarations, "tool"), { recursive: true });
    fs.writeFileSync(
      path.join(declarations, "tool", "stack.json"),
      JSON.stringify({
        schema: 1,
        name: "tool",
        install: [
          {
            kind: "archive",
            url: "https://127.0.0.1:9/tool.tar.gz",
            sha256: "0".repeat(64),
            unpack: "tar.gz",
            bin: [{ from: "tool", as: "tool" }],
          },
        ],
      }),
    );
    const toolbox = path.join(scratch, "toolbox");
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${planted}${path.delimiter}${process.env.PATH ?? ""}` };
    // No uid drop, which would need root, and no proxy between curl and the
    // closed port.
    for (const key of ["UF_AGENT_UID", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
      delete env[key];
    }

    try {
      const result = spawnSync(
        process.execPath,
        [path.join(repoRoot(), "scripts/apply-stacks.mjs"), declarations, toolbox],
        { env, encoding: "utf8", timeout: 60_000 },
      );
      assert.equal(result.status, 0, result.stderr);
      const plantedThatRan = fs.existsSync(ran) ? fs.readFileSync(ran, "utf8").trim().split("\n") : [];
      assert.deepEqual(plantedThatRan, [], `the applier ran ${plantedThatRan.join(", ")} off PATH`);
      const receipt = JSON.parse(fs.readFileSync(path.join(toolbox, "receipts", "tool.json"), "utf8"));
      assert.equal(receipt.status, "failed");
      assert.match(receipt.error.text, /could not download/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
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
    assert.deepEqual(result.stack.install[0].bin, [
      { from: { amd64: "bin/ruff", arm64: "bin/ruff" }, as: "ruff" },
    ]);
    assert.equal(result.stack.install[0].spec, "ruff==0.14.1");
  });

  it("keeps a scoped npm package, whose spec is full of characters a name may not have", () => {
    const result = parseWith(npm);
    assert.equal(result.ok, true, result.ok ? "" : (result as { reason: string }).reason);
    if (!result.ok) return;
    assert.equal(result.stack.install[0].spec, "@musistudio/claude-code-router@1.0.66");
    assert.deepEqual(result.stack.install[0].bin, [
      { from: { amd64: "bin/ccr", arm64: "bin/ccr" }, as: "ccr" },
    ]);
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
    for (const key of ["GIT_DIR", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME", "OTEL_EXPORTER_OTLP_ENDPOINT"]) {
      assert.notEqual(applier.refuseEnv(key, "x"), null, `${key} was accepted`);
    }
  });

  it("refuses what another program loads, sources or trusts, the proxies in either case", () => {
    // Every one of these passed before board task 76b451aa, and the agents'
    // environment is also the Claude CLI's.
    for (const key of [
      "PYTHONPATH",
      "PYTHONHOME",
      "PYTHONSTARTUP",
      "NODE_PATH",
      "NODE_EXTRA_CA_CERTS",
      "BASH_ENV",
      "ENV",
      "LD_AUDIT",
      "PERL5OPT",
      "RUBYOPT",
      "HTTPS_PROXY",
      "https_proxy",
      "HTTP_PROXY",
      "ALL_PROXY",
      "SSL_CERT_FILE",
    ]) {
      assert.match(String(applier.refuseEnv(key, "/tmp/x")), /what other programs load, run or trust/, `${key} was accepted`);
    }
    // A package manager's own configuration is what `env` is for.
    assert.equal(applier.refuseEnv("PIP_REQUIRE_VIRTUALENV", "true"), null);
    assert.equal(applier.refuseEnv("npm_config_cache", "{state}/npm"), null);
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
