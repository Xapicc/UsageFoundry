#!/usr/bin/env node
/**
 * Install the stacks the operator declared, before the server starts.
 *
 * A stack is a directory under the host's `./stacks`, bind-mounted read-only at
 * `/etc/uf-stacks`, holding one `stack.json`. This script reads them, installs
 * what they declare into the `usagefoundry-stacks` named volume at
 * `/var/lib/uf-stacks`, links the binaries into a directory the image already
 * has on `PATH`, and writes one receipt per stack saying what happened.
 *
 * `proposals/CustomStacks/01a-mechanism.md` is the design and
 * `01b-stack-format.md` is the format. What matters here:
 *
 * ## Why boot, and why before `exec "$@"`
 *
 * `PATH` has to be final before the server starts. `childEnv` copies the
 * server's environment into every agent child (`src/lib/orchestrator.ts:5698`),
 * so a run-time installer would have to mutate `process.env.PATH` after some
 * children had already been spawned, and the two sets of children would then
 * differ in what they could resolve with nothing saying so. This is also the
 * only window in the container's life with no agent process alive, which is
 * what makes the uid split below safe.
 *
 * ## Never a shell
 *
 * `docs/agent/security.md:14` — the agent is spawned with an argument array,
 * never a shell. The same rule holds here and for a stronger reason: every URL,
 * filename and digest in the argv below came out of a file a stranger wrote.
 * There is no `exec`, no `sh -c` and no string interpolation into a command;
 * `run()` takes an array and `spawnSync` gets `shell: false` by construction.
 * The format has four expansion tokens and no `$VAR`, no backtick and no `$( )`
 * for the same reason.
 *
 * ## The uid split
 *
 * Download, verify, unpack and `chmod` run as `UF_AGENT_UID`; the `chown` to
 * root and the `install` into `bin/` are root's. That is the opposite of what
 * the two existing install loops do (`docker-entrypoint.sh:147`, `:218`), which
 * install as the uid that will run them so an agent can upgrade its own tools.
 * The reason it inverts here is `01a-` §2.2: `bin/` is on the *server's* `PATH`,
 * the server is root, and a directory on that `PATH` which a sibling agent can
 * rewrite is a way for one run to put its own code on every other run's
 * transcript. `/home/node/pytools/bin` is already one of those and this design
 * will not add a second. The cost is that an agent cannot upgrade a stack tool,
 * which is correct: upgrading is an operator act.
 *
 * ## Nothing here refuses the boot
 *
 * A stack that will not install is a degraded install, on the same argument the
 * gh and Python loops are best-effort for. Every failure writes a `failed`
 * receipt and a log line and the next stack is attempted. The one thing that
 * must never happen is a stack that was not attempted reading as one that
 * installed — a missing receipt is indistinguishable from a stack that was
 * never declared, so the time budget writes `failed` receipts for everything it
 * did not reach.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The read-only bind of the host's `./stacks`. Declarations, never artifacts. */
export const DECLARATIONS_DIR = "/etc/uf-stacks";

/**
 * The named volume. The image ships **nothing** under this path, ever.
 *
 * A named volume takes its contents from the image exactly once, at creation
 * (`Dockerfile:303-309`), so anything the image puts at a volume's mount point
 * is visible on a reviewer's fresh install and masked on every install that
 * already exists. `deployment.test.ts` asserts the `Dockerfile` names no path
 * under here, because that is the one breach nothing else would catch.
 */
export const TOOLBOX_DIR = "/var/lib/uf-stacks";

/**
 * What the whole run may spend, and why it is not only a per-step timeout.
 *
 * Ten stacks each timing out politely at a per-step ceiling is still a boot
 * that took ten ceilings, so the ceiling is on the run as well, spent in
 * declaration order.
 *
 * **Raised from two minutes on 2026-09-12, and the reason is a measurement.**
 * The Swift toolchain for Debian 12 is 1,053,793,547 bytes — the smallest form
 * in which that language arrives, since there is no partial toolchain — and two
 * minutes could not have fetched it on any link. The old numbers were sized
 * against `HEALTHCHECK --start-period=180s` alone, which is the right bound for
 * an install whose largest artifact is a 3 MB linter and the wrong one for a
 * language.
 *
 * What keeps a raised ceiling from costing every boot is that it is **not** the
 * thing that catches a hung download any more: `curl` now aborts on *progress*
 * rather than on wall clock (see `CURL_STALL_ARGS`), so an unreachable host
 * fails in about thirty seconds whatever this number says. This is the ceiling
 * for a transfer that is moving and merely enormous, and for a `tar` that has
 * stopped.
 */
export const TOTAL_BUDGET_MS = 30 * 60_000;

/**
 * What one `curl`, `tar`, `sha256sum` or package install may spend.
 *
 * Generous for the same reason and with the same guard in front of it. The two
 * package verbs have no equivalent of `--speed-time`, so this is the whole of
 * what bounds a `uv` or `npm` install that hangs — both carry their own network
 * timeouts well inside it.
 */
export const STEP_TIMEOUT_MS = 20 * 60_000;

/**
 * How `curl` decides a download has stopped, as opposed to being slow.
 *
 * Under 1 KB/s for 30 seconds and it gives up. This is what replaced the wall
 * clock as the real guard, and the difference matters in both directions: a
 * 45-second ceiling cannot fetch a gigabyte on any link, and a 20-minute one
 * would hold the boot for 20 minutes against a host that is simply not
 * answering — on **every** restart, since a failed stack is retried rather than
 * latched. Progress is the question actually being asked.
 */
const CURL_STALL_ARGS = ["--speed-limit", "1024", "--speed-time", "30"];

/**
 * How much of a failing step's stderr the receipt carries.
 *
 * Verbatim and never parsed, for `orchestrator.ts:7934-7936`'s reason about
 * text read out of a CLI: an applier that summarised a `curl` failure into a
 * category would be inventing the one field an operator actually needs. The cap
 * is a cap and the receipt carries the original byte count beside the text, on
 * `status.ts:41-46`'s rule that *a plausible number that is quietly a third of
 * the real one is worse than no number*.
 */
export const STDERR_CAP_BYTES = 4096;

/** The only schema version. A stack declaring another is refused, not migrated. */
export const SCHEMA_VERSION = 1;

const TOP_LEVEL_KEYS = new Set(["schema", "name", "summary", "install", "env", "state", "deny"]);
const ARCHIVE_KEYS = new Set(["kind", "url", "checksums", "sha256", "unpack", "bin"]);
const PACKAGE_KEYS = new Set(["kind", "spec", "bin"]);
const BIN_KEYS = new Set(["from", "as"]);
const UNPACK_KINDS = new Set(["zip", "tar.gz", "none"]);

/**
 * The closed verb list, which is the whole of it: `01b-` §2.1's three.
 *
 * One set rather than the two this file carried while `archive` was the only
 * one built. A pair whose contents had become identical is a distinction that
 * rots in silence — the refusal it fed could never fire again, and the next
 * verb would be added to whichever set the author happened to read first.
 *
 * `archive` executes nothing at install time; `uv-tool` and `npm-global` run
 * whatever the package's install hooks run, as the agent uid. That is the same
 * trade `docker-entrypoint.sh:233` already makes for `UF_PY_TOOLS` and it is
 * stated rather than glossed: a stack using either is as trusted as the package
 * it names, where one using `archive` is as trusted as the URL it names.
 */
export const VERBS = new Set(["archive", "uv-tool", "npm-global"]);

/**
 * Where each package manager is pointed, and why both variables and not one.
 *
 * `01b-` §2.1 names `UV_TOOL_BIN_DIR={pkg}/bin` alone. That is half an install:
 * `Dockerfile:282` also sets `UV_TOOL_DIR=/home/node/pytools/tools`, which this
 * process inherits, so redirecting only the bin directory leaves the tool's
 * *environment* in the volume the agents own and write. A binary on the
 * server's `PATH` whose interpreter lives somewhere a sibling run can rewrite
 * is exactly the arrangement the uid split above exists to prevent, and it
 * would also mean a stack removal left the venv behind — `reconcile` may remove
 * only paths its own receipts record, and that one would be in nobody's.
 *
 * `HOME` because the step runs as the agent uid while this process is root's,
 * and both tools write under `$HOME`; it is `docker-entrypoint.sh:218-219`'s
 * own value for the same reason.
 */
const PACKAGE_ENV = {
  "uv-tool": (pkg) => ({ HOME: "/home/node", UV_TOOL_DIR: `${pkg}/tools`, UV_TOOL_BIN_DIR: `${pkg}/bin` }),
  "npm-global": () => ({ HOME: "/home/node" }),
};

/**
 * Environment keys a stack may not set, and the silent failure each prevents.
 *
 * `UF_` because `childEnv` deletes the whole prefix, so the variable would be
 * set here and absent in every child with nothing saying so. The rest because a
 * stack that can set them is a stack that can redirect the app rather than add
 * a tool to it.
 */
const REFUSED_ENV_PREFIXES = ["UF_", "GIT_", "CLAUDE_", "ANTHROPIC_", "OPENAI_", "CODEX_"];
const REFUSED_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DATA_DIR",
]);

/**
 * The host's `~/.claude` bind, which is every session on the machine and not
 * this container's (`docker-compose.yml:401`). A stack pointing a tool's state
 * at it would be writing into the operator's own configuration, which is what
 * `.env.example:304` already warns about for a tool that *"wires itself in
 * globally" on first run*.
 */
const CLAUDE_HOME = "/home/node/.claude";

/* ------------------------------------------------------------------ */
/* Parsing, which happens before anything is downloaded                */
/* ------------------------------------------------------------------ */

/**
 * Read one `stack.json` and refuse it, or return what the applier may act on.
 *
 * Takes the text rather than a parsed object so that "not valid JSON" is one of
 * this function's refusals and not a second error path in the caller. Every
 * refusal below is a branch whose absence fails on somebody else's machine: a
 * digest that does not pin what the URL fetches, a grant a stack does not own,
 * an environment key that is stripped after it is set.
 *
 * The directory name is the identity and `name` must equal it. A mismatch is a
 * refusal rather than a rename because it means somebody copied a directory and
 * did not finish, and silently trusting either one is how an operator ends up
 * with a tool they did not choose.
 */
export function parseStack(text, dirName) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return refuse(`stack.json is not valid JSON: ${err.message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return refuse("stack.json is not a JSON object");
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      // `allow` by name, because it was the field until the operator ruled the
      // grant a deny-list (`23-revision-per-repo-and-login.md` §9) and a stack
      // written against the older text would otherwise be refused as a typo.
      if (key === "allow") {
        return refuse(
          '"allow" is no longer a field: the grant is a deny-list. Every binary a ' +
            'stack links is granted, and "deny" names the commands that are not.',
        );
      }
      return refuse(`unknown top-level key "${key}"`);
    }
  }

  if (raw.schema !== SCHEMA_VERSION) {
    return refuse(`schema is ${JSON.stringify(raw.schema)} and this build reads ${SCHEMA_VERSION}`);
  }
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    return refuse("name is missing or is not a string");
  }
  if (raw.name !== dirName) {
    return refuse(`name is "${raw.name}" and the directory is "${dirName}"`);
  }
  if (raw.summary !== undefined && typeof raw.summary !== "string") {
    return refuse("summary is not a string");
  }
  if (!Array.isArray(raw.install) || raw.install.length === 0) {
    return refuse("install is missing, is not an array, or is empty");
  }

  const steps = [];
  const bins = [];
  for (const [index, step] of raw.install.entries()) {
    const parsed = parseStep(step, index);
    if (!parsed.ok) return parsed;
    steps.push(parsed.step);
    bins.push(...parsed.step.bin);
  }

  const seenBin = new Set();
  for (const entry of bins) {
    if (seenBin.has(entry.as)) {
      return refuse(`two install steps both link a binary called "${entry.as}"`);
    }
    seenBin.add(entry.as);
  }

  const env = {};
  if (raw.env !== undefined) {
    if (raw.env === null || typeof raw.env !== "object" || Array.isArray(raw.env)) {
      return refuse("env is not an object");
    }
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value !== "string") return refuse(`env.${key} is not a string`);
      const reason = refuseEnv(key, value);
      if (reason) return refuse(reason);
      env[key] = value;
    }
  }

  const state = [];
  if (raw.state !== undefined) {
    if (!Array.isArray(raw.state)) return refuse("state is not an array");
    for (const entry of raw.state) {
      if (typeof entry !== "string" || entry.length === 0) {
        return refuse("a state entry is not a non-empty string");
      }
      if (escapesRoot(entry)) return refuse(`state entry "${entry}" escapes {state}`);
      state.push(entry);
    }
  }

  const deny = [];
  if (raw.deny !== undefined) {
    if (!Array.isArray(raw.deny)) return refuse("deny is not an array");
    for (const entry of raw.deny) {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        return refuse("a deny entry is not a non-empty string");
      }
      // A grant is interpolated into `Bash(...)`, so a parenthesis in one would
      // close it and turn the rest of the entry into a second rule.
      if (entry.includes("(") || entry.includes(")")) {
        return refuse(`deny entry "${entry}" contains a parenthesis`);
      }
      // The first word must be a binary this stack itself links — not to stop a
      // stack granting what it should not, but to stop one *denying* what it
      // does not own. Deny beats `ISOLATED_GIT_TOOLS` the same way it beats the
      // mode, so a stack that could write "git commit" here would silently
      // break every isolated run on the install.
      const first = entry.trim().split(/\s+/)[0];
      if (!seenBin.has(first)) {
        return refuse(`deny entry "${entry}" names "${first}", which this stack does not link`);
      }
      deny.push(entry.trim());
    }
  }

  return { ok: true, stack: { name: raw.name, summary: raw.summary ?? "", install: steps, env, state, deny } };
}

function parseStep(step, index) {
  const where = `install[${index}]`;
  if (step === null || typeof step !== "object" || Array.isArray(step)) {
    return refuse(`${where} is not an object`);
  }
  if (typeof step.kind !== "string") return refuse(`${where}.kind is missing`);
  if (!VERBS.has(step.kind)) return refuse(`${where}.kind is "${step.kind}", which is not a verb`);
  if (step.kind === "archive") return parseArchiveStep(step, where);
  return parsePackageStep(step, where);
}

/**
 * A `uv-tool` or `npm-global` step, normalised into the shape `archive` leaves.
 *
 * `bin` is written as command names — `"bin": ["ruff"]` — because that is all
 * an author knows: the package manager decides where it puts them, and both
 * put them in `{pkg}/bin`. It is turned into `archive`'s `{ from, as }` here so
 * that everything downstream has one shape to read. The alternative, a second
 * shape carried to the end, would mean the duplicate-binary check, the `deny`
 * ownership rule, the linker and the receipt each learning which verb they were
 * looking at, and four places that can disagree about what a stack links.
 */
function parsePackageStep(step, where) {
  for (const key of Object.keys(step)) {
    if (!PACKAGE_KEYS.has(key)) return refuse(`${where} has an unknown key "${key}"`);
  }
  if (typeof step.spec !== "string" || step.spec.trim().length === 0) {
    return refuse(`${where}.spec is missing or is not a non-empty string`);
  }
  // The two refusals that are argv and not taste. There is no shell here, so a
  // metacharacter is inert — but a spec is passed as one positional argument,
  // and a leading `-` is read as a flag by both tools while whitespace is read
  // as a second argument. Either one is a stack whose declaration says one
  // thing and whose install does another.
  if (step.spec.startsWith("-")) {
    return refuse(`${where}.spec starts with "-", which both tools read as a flag rather than a package`);
  }
  if (/\s/.test(step.spec)) {
    return refuse(`${where}.spec contains whitespace: one package per step, since it is one argument`);
  }
  if (!Array.isArray(step.bin) || step.bin.length === 0) {
    return refuse(`${where}.bin is missing, is not an array, or is empty`);
  }
  const bin = [];
  for (const entry of step.bin) {
    if (typeof entry !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(entry)) {
      return refuse(`${where}.bin has an entry that is not a plain command name`);
    }
    bin.push({ from: { amd64: `bin/${entry}`, arm64: `bin/${entry}` }, as: entry });
  }
  return { ok: true, step: { kind: step.kind, spec: step.spec, bin } };
}

function parseArchiveStep(step, where) {
  for (const key of Object.keys(step)) {
    if (!ARCHIVE_KEYS.has(key)) return refuse(`${where} has an unknown key "${key}"`);
  }

  // A string, or the same per-architecture object `sha256` takes. The object
  // form exists because tokens cannot express every publisher's layout: Swift
  // serves `debian12-aarch64/…-debian12-aarch64.tar.gz` for one architecture
  // and `debian12/…-debian12.tar.gz` for the other, where the second contains
  // no architecture name at all — measured 2026-09-12, and
  // `…/debian12-x86_64/…` is a 404. No expansion of `{arch}` or `{arch_uname}`
  // produces both, and inventing a fifth token for "the part that vanishes on
  // one architecture" would be a vocabulary nobody could guess. Reusing the
  // shape beside it costs no new concept.
  const url = archPair(step.url, `${where}.url`, (u) => typeof u === "string" && u.startsWith("https://"));
  if (url.reason) return refuse(url.reason);
  if (step.checksums !== undefined && (typeof step.checksums !== "string" || !step.checksums.startsWith("https://"))) {
    return refuse(`${where}.checksums is not an https:// URL`);
  }
  const hasChecksums = step.checksums !== undefined;
  const hasDigest = step.sha256 !== undefined;
  if (hasChecksums === hasDigest) {
    return refuse(`${where} must carry exactly one of "checksums" and "sha256"`);
  }

  // One file per architecture, however it was spelled: a token that expands
  // differently, or two urls written out. Both make a single digest a lie.
  const perArch =
    /\{arch\}|\{arch_uname\}/.test(url.value.amd64) || url.value.amd64 !== url.value.arm64;
  let sha256 = null;
  if (hasDigest) {
    if (typeof step.sha256 === "string") {
      // One digest cannot be true of two files. A string against a per-arch URL
      // is the defect `01g-` §5.2 found: it installs on its author's
      // architecture and fails the digest on the other, blaming the consumer's
      // machine in a message nobody wrote.
      if (perArch) {
        return refuse(
          `${where}.sha256 is one digest against a url that names one file per architecture — ` +
            'use { "amd64": "…", "arm64": "…" }',
        );
      }
      if (!isSha256(step.sha256)) return refuse(`${where}.sha256 is not 64 hex characters`);
      sha256 = { amd64: step.sha256, arm64: step.sha256 };
    } else if (step.sha256 !== null && typeof step.sha256 === "object" && !Array.isArray(step.sha256)) {
      for (const arch of ["amd64", "arm64"]) {
        if (!isSha256(step.sha256[arch])) {
          return refuse(`${where}.sha256.${arch} is missing or is not 64 hex characters`);
        }
      }
      for (const key of Object.keys(step.sha256)) {
        if (key !== "amd64" && key !== "arm64") return refuse(`${where}.sha256 has an unknown key "${key}"`);
      }
      sha256 = { amd64: step.sha256.amd64, arm64: step.sha256.arm64 };
    } else {
      return refuse(`${where}.sha256 is neither a string nor an object`);
    }
  }

  if (typeof step.unpack !== "string" || !UNPACK_KINDS.has(step.unpack)) {
    return refuse(`${where}.unpack is missing or is not one of zip, tar.gz, none`);
  }
  if (!Array.isArray(step.bin) || step.bin.length === 0) {
    return refuse(`${where}.bin is missing, is not an array, or is empty`);
  }
  const bin = [];
  for (const entry of step.bin) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return refuse(`${where}.bin has an entry that is not an object`);
    }
    for (const key of Object.keys(entry)) {
      if (!BIN_KEYS.has(key)) return refuse(`${where}.bin has an unknown key "${key}"`);
    }
    // A string, or the per-architecture pair `url` and `sha256` take. Needed for
    // the same publisher and the same reason: Swift's tarball unpacks to
    // `swift-6.3.3-RELEASE-debian12-aarch64/` on one architecture and
    // `swift-6.3.3-RELEASE-debian12/` on the other, so the path to a binary
    // inside it differs by a segment that is absent rather than different. Three
    // fields now take this form, which is one idea — *anything that differs per
    // architecture may be written per architecture* — rather than three.
    const from = archPair(entry.from, `${where}.bin "from"`, (v) => typeof v === "string" && v.length > 0);
    if (from.reason) return refuse(from.reason);
    if (typeof entry.as !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(entry.as)) {
      return refuse(`${where}.bin entry "as" is missing or is not a plain command name`);
    }
    // After normalisation, because `a/../../etc/passwd` is `../etc/passwd` and
    // only one of the two spellings is obvious. Both architectures are checked:
    // a pair that escapes on one of them escapes.
    for (const arch of ["amd64", "arm64"]) {
      if (escapesRoot(from.value[arch])) {
        return refuse(`${where}.bin "from" escapes {pkg}: ${from.value[arch]}`);
      }
    }
    bin.push({ from: from.value, as: entry.as });
  }

  return { ok: true, step: { kind: step.kind, url: url.value, checksums: step.checksums ?? null, sha256, unpack: step.unpack, bin } };
}

/**
 * Whether a stack may set this environment variable to this value.
 *
 * Returns the reason it may not, or `null`. Every entry prevents a failure that
 * is silent by construction, which is why this is a function rather than four
 * conditions inline: a key stripped by `childEnv` is set here and gone in the
 * child, and nothing between the two says a word about it.
 */
export function refuseEnv(key, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `env key "${key}" is not a variable name`;
  if (REFUSED_ENV_NAMES.has(key)) return `env may not set ${key}: it decides where things are, not what is installed`;
  for (const prefix of REFUSED_ENV_PREFIXES) {
    if (key.startsWith(prefix)) {
      return prefix === "UF_"
        ? `env may not set ${key}: childEnv deletes every UF_ key, so it would be set here and absent in every agent`
        : `env may not set ${key}: the ${prefix}* keys belong to the app rather than to a stack`;
    }
  }
  // The four expansion tokens are the only braces the format has, so they are
  // removed before the metacharacter test rather than being carved out of it.
  const withoutTokens = value.replace(/\{(arch|arch_uname|state|pkg)\}/g, "");
  const metacharacter = /[$`\\"';&|<>(){}\n\r]/.exec(withoutTokens);
  if (metacharacter) {
    return `env ${key} contains ${JSON.stringify(metacharacter[0])}, and there is no shell here to interpret it`;
  }
  const expanded = withoutTokens;
  if (expanded.startsWith("/") && (path.posix.normalize(expanded) + "/").startsWith(`${CLAUDE_HOME}/`)) {
    return `env ${key} resolves under ${CLAUDE_HOME}, which is the host's own ~/.claude for every session on the machine`;
  }
  return null;
}

/**
 * A path that leaves the directory it is relative to, in either spelling.
 *
 * Checked against the value as written, before expansion, and that is sound
 * rather than an oversight: of the four tokens, two expand to an architecture
 * name with no separator in it and two to absolute paths **under the toolbox**,
 * and `path.posix.join` of a directory with an absolute path lands under that
 * directory. So no expansion can turn a value that passes here into one that
 * escapes, and checking the authored string is what lets the refusal name the
 * line the author wrote.
 */
/**
 * A field as the two it always is underneath: one value per architecture.
 *
 * A plain value is both, which is every stack written before this existed and
 * every one whose publisher spells the two the same way. The object form is for
 * the ones who do not — and `sha256` has taken it since `01g-` §5.2, so this is
 * the vocabulary the format already had rather than a new one.
 *
 * `ok` says what counts as a value at all, so one helper serves a url and a
 * path without either learning about the other.
 */
function archPair(value, where, ok) {
  const what = where.endsWith("url") ? "an https:// URL" : "a non-empty string";
  if (ok(value)) return { value: { amd64: value, arm64: value }, reason: null };
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (key !== "amd64" && key !== "arm64") {
        return { value: null, reason: `${where} has an unknown key "${key}"` };
      }
    }
    for (const arch of ["amd64", "arm64"]) {
      if (!ok(value[arch])) {
        return { value: null, reason: `${where}.${arch} is missing or is not ${what}` };
      }
    }
    return { value: { amd64: value.amd64, arm64: value.arm64 }, reason: null };
  }
  return { value: null, reason: `${where} is missing or is not ${what}` };
}

function escapesRoot(value) {
  if (value.startsWith("/")) return true;
  const normalised = path.posix.normalize(value);
  return normalised === ".." || normalised.startsWith("../");
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function refuse(reason) {
  return { ok: false, reason };
}

/* ------------------------------------------------------------------ */
/* Expansion                                                           */
/* ------------------------------------------------------------------ */

/**
 * The four tokens, and nothing else expands.
 *
 * `{arch}` and `{arch_uname}` are two spellings of one switch and both are
 * real: measured in this container on 2026-09-12, `dpkg --print-architecture`
 * says `arm64` where `uname -m` says `aarch64`, and publishers use both. A
 * wrong expansion is a 404 at boot, on one architecture only, read once.
 */
export function expandTokens(value, { arch, name, root = TOOLBOX_DIR }) {
  const unameArch = arch === "arm64" ? "aarch64" : "x86_64";
  return value
    .replaceAll("{arch_uname}", unameArch)
    .replaceAll("{arch}", arch)
    .replaceAll("{state}", path.posix.join(root, "state", name))
    .replaceAll("{pkg}", path.posix.join(root, "pkg", name));
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

/**
 * What this boot should do with each stack, and what it should remove.
 *
 * The three rules are `01a-` §7's, plus the de-latching one
 * `22-validation.md` §2.2 added: **only an `ok` receipt is a reason to skip.**
 * Without that a failed stack is attempted once and skipped for ever, which
 * makes the receipt set a record of the boot that first failed rather than of
 * this one — and `/api/status`'s whole claim is that the set de-latches on a
 * boot, which is `db.ts:184-189`'s own rule for a reading a monitor thresholds.
 * The cost is one retried download per boot on an install whose network is
 * down, which is loud and correct.
 *
 * **Removal names only paths the receipt itself records.** That is the
 * assertion that matters here: the failure mode is deleting something the
 * applier did not install, which is silent and unrecoverable. A reinstall keeps
 * `state/`, so a version bump does not throw away a provider cache.
 *
 * Two stacks claiming one binary name lose it, both, and neither silently.
 * Letting the lexically first win would hand the operator a version they did
 * not choose with nothing to read.
 */
export function reconcile(declarations, receipts) {
  const byName = new Map(receipts.map((receipt) => [receipt.name, receipt]));
  const claimants = new Map();
  for (const declaration of declarations) {
    if (!declaration.ok) continue;
    for (const binName of declaration.bins) {
      if (!claimants.has(binName)) claimants.set(binName, []);
      claimants.get(binName).push(declaration.name);
    }
  }

  const plan = [];
  for (const declaration of declarations) {
    if (!declaration.ok) {
      plan.push({ name: declaration.name, action: "refuse", reason: declaration.reason });
      continue;
    }
    const contested = declaration.bins
      .filter((binName) => claimants.get(binName).length > 1)
      .map((binName) => ({ bin: binName, others: claimants.get(binName).filter((n) => n !== declaration.name) }));
    if (contested.length > 0) {
      const said = contested
        .map((c) => `"${c.bin}" is also claimed by ${c.others.map((n) => `"${n}"`).join(", ")}`)
        .join("; ");
      plan.push({ name: declaration.name, action: "conflict", reason: `${said}. Neither was linked.` });
      continue;
    }
    const receipt = byName.get(declaration.name);
    if (receipt && receipt.digest === declaration.digest && receipt.status === "ok") {
      plan.push({ name: declaration.name, action: "skip", reason: "receipt matches" });
    } else if (receipt && receipt.digest === declaration.digest) {
      plan.push({ name: declaration.name, action: "install", reason: `the last attempt was ${receipt.status}` });
    } else if (receipt) {
      plan.push({ name: declaration.name, action: "install", reason: "the declaration changed" });
    } else {
      plan.push({ name: declaration.name, action: "install", reason: "no receipt" });
    }
  }

  const declaredNames = new Set(declarations.map((declaration) => declaration.name));
  const removals = [];
  for (const receipt of receipts) {
    if (declaredNames.has(receipt.name)) continue;
    removals.push({ name: receipt.name, paths: pathsOwnedBy(receipt) });
  }

  return { plan, removals };
}

/**
 * Every path a receipt records as its own, and no others.
 *
 * The links come off the receipt rather than off a `readdir` of `bin/`, which
 * is the whole of the rule: a name in `bin/` that no receipt claims was put
 * there by somebody and is not this applier's to delete.
 */
function pathsOwnedBy(receipt) {
  const paths = [
    path.posix.join(TOOLBOX_DIR, "pkg", receipt.name),
    path.posix.join(TOOLBOX_DIR, "state", receipt.name),
  ];
  for (const entry of receipt.bin ?? []) {
    if (typeof entry?.path === "string") paths.push(entry.path);
  }
  return paths;
}

/* ------------------------------------------------------------------ */
/* Running things                                                      */
/* ------------------------------------------------------------------ */

/**
 * An argv array and never a command string; `spawnSync` without `shell`.
 *
 * `env` is merged over this process's own rather than replacing it, because a
 * package manager dropped into an empty environment loses `PATH` and cannot
 * find the interpreter it is about to write a shebang for.
 */
function run(argv, { cwd, timeoutMs, env } = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    timeout: Math.max(1, timeoutMs ?? STEP_TIMEOUT_MS),
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = result.stderr ? result.stderr.toString("utf8") : "";
  if (result.error && result.error.code === "ETIMEDOUT") {
    return { ok: false, stderr: `${argv[0]} did not finish inside its timeout`, bytes: 0 };
  }
  if (result.error) return { ok: false, stderr: `${argv[0]}: ${result.error.message}`, bytes: 0 };
  if (result.status !== 0) {
    return {
      ok: false,
      stderr: stderr.slice(-STDERR_CAP_BYTES),
      bytes: Buffer.byteLength(stderr, "utf8"),
      exit: result.status,
    };
  }
  return { ok: true, stderr: "", bytes: 0 };
}

/**
 * The same argv, dropped to the uid that will never own what it writes.
 *
 * `setpriv --reuid --regid --clear-groups` is the form `docker-entrypoint.sh:147`
 * and `:218` already use. Skipped when `UF_AGENT_UID` is unset, which is the
 * arrangement whose children are root anyway.
 */
function runAsAgent(argv, options) {
  const uid = process.env.UF_AGENT_UID;
  if (!uid) return run(argv, options);
  const gid = process.env.UF_AGENT_GID || uid;
  return run(["setpriv", `--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", ...argv], options);
}

function agentOwner() {
  const uid = process.env.UF_AGENT_UID;
  if (!uid) return null;
  return `${uid}:${process.env.UF_AGENT_GID || uid}`;
}

/**
 * The architecture, from the call the image already makes at `Dockerfile:164`.
 *
 * Falls back to Node's own name for it rather than guessing one spelling: an
 * install where `dpkg` is missing is not this script's to refuse, and the two
 * names agree for the two architectures this image is built for.
 */
function architecture() {
  const result = spawnSync("dpkg", ["--print-architecture"], { encoding: "utf8", timeout: 5_000 });
  const printed = (result.stdout ?? "").trim();
  if (printed) return printed;
  return process.arch === "arm64" ? "arm64" : "amd64";
}

/* ------------------------------------------------------------------ */
/* Applying                                                            */
/* ------------------------------------------------------------------ */

function say(message) {
  process.stdout.write(`[usagefoundry] ${message}\n`);
}

function complain(message) {
  process.stderr.write(`[usagefoundry] ${message}\n`);
}

/**
 * The digest the applier reconciles against: sha256 over the bytes of
 * `stack.json`, whole.
 *
 * A narrower digest over only the install steps would skip a reinstall when
 * only `deny` changed, and it is refused: the cost of the simple rule is one
 * unnecessary download, and the cost of the clever one is a binary that does
 * not match its declaration with nothing saying so.
 */
export function digestOfText(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Read `/etc/uf-stacks`, one directory per stack, in lexical order. */
function readDeclarations(declarationsDir) {
  let entries;
  try {
    entries = fs.readdirSync(declarationsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return { mounted: false, declarations: [] };
    throw err;
  }
  const declarations = [];
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const file = path.join(declarationsDir, entry.name, "stack.json");
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      declarations.push({ name: entry.name, ok: false, reason: `stack.json could not be read (${err.code ?? err.message})`, digest: "", bins: [] });
      continue;
    }
    const digest = digestOfText(text);
    const parsed = parseStack(text, entry.name);
    if (!parsed.ok) {
      declarations.push({ name: entry.name, ok: false, reason: parsed.reason, digest, bins: [] });
      continue;
    }
    declarations.push({
      name: entry.name,
      ok: true,
      digest,
      stack: parsed.stack,
      bins: parsed.stack.install.flatMap((step) => step.bin.map((b) => b.as)),
    });
  }
  return { mounted: true, declarations };
}

function readReceipts(receiptsDir) {
  let names;
  try {
    names = fs.readdirSync(receiptsDir);
  } catch {
    return [];
  }
  const receipts = [];
  for (const file of names.filter((n) => n.endsWith(".json")).sort()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(receiptsDir, file), "utf8"));
      if (parsed && typeof parsed.name === "string") receipts.push(parsed);
    } catch {
      // A receipt this script cannot read is a receipt it cannot act on, and
      // acting on a half-written one is how it would delete a path it does not
      // own. Left where it is; the next successful apply overwrites it, and the
      // app's own reader renders it `unreadable` rather than a partial `ok`.
      complain(`stacks: receipt ${file} is unreadable and was left alone`);
    }
  }
  return receipts;
}

function writeReceipt(receiptsDir, receipt) {
  fs.mkdirSync(receiptsDir, { recursive: true });
  const target = path.join(receiptsDir, `${receipt.name}.json`);
  const temporary = `${target}.tmp`;
  // Written and renamed rather than written in place: a container killed
  // mid-write then leaves the previous receipt rather than a truncated one.
  // The app's reader still validates, because an older build's receipt and a
  // failed rename are both reachable.
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporary, target);
}

function removePath(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

/** One `archive` step, in `01b-` §4's order. Steps 1 to 4 are the agent's. */
function applyArchiveStep(step, context) {
  const { name, arch, root, deadline } = context;
  const pkg = path.posix.join(root, "pkg", name);
  const download = path.posix.join(pkg, ".download");
  const url = expandTokens(step.url[arch] ?? step.url.amd64, { arch, name, root });
  const artifact = path.posix.basename(new URL(url).pathname);
  if (!artifact) return { ok: false, detail: `the url names no file: ${url}`, stderr: "", bytes: 0 };

  const budget = () => deadline - Date.now();
  if (budget() <= 0) return { ok: false, detail: "the applier's time budget was spent", stderr: "", bytes: 0 };

  fs.mkdirSync(download, { recursive: true });
  const owner = agentOwner();
  if (owner) {
    const chown = run(["chown", "-R", owner, pkg]);
    if (!chown.ok) return { ok: false, detail: `could not hand ${pkg} to ${owner}`, stderr: chown.stderr, bytes: chown.bytes };
  }

  // `curl -fsSL` is `Dockerfile:171`'s own flag set. The two additions are this
  // design's and are worth one flag each here, because the URL came out of a
  // file a stranger wrote rather than out of a reviewed Dockerfile line.
  const curl = ["curl", "-fsSL", "--proto", "=https", "--tlsv1.2", ...CURL_STALL_ARGS, "-o", artifact, url];
  const fetched = runAsAgent(curl, { cwd: download, timeoutMs: Math.min(STEP_TIMEOUT_MS, budget()) });
  if (!fetched.ok) return { ok: false, detail: `could not download ${url}`, stderr: fetched.stderr, bytes: fetched.bytes };

  // One verification path for both forms. A literal digest is written into a
  // manifest of one line and checked by the same `sha256sum --ignore-missing
  // --check` the image already uses at `Dockerfile:173`, rather than being
  // compared by a second piece of code that could disagree with it.
  const manifest = path.posix.join(download, "SHA256SUMS");
  if (step.checksums) {
    const checksumsUrl = expandTokens(step.checksums, { arch, name, root });
    const got = runAsAgent(["curl", "-fsSL", "--proto", "=https", "--tlsv1.2", ...CURL_STALL_ARGS, "-o", "SHA256SUMS", checksumsUrl], {
      cwd: download,
      timeoutMs: Math.min(STEP_TIMEOUT_MS, budget()),
    });
    if (!got.ok) return { ok: false, detail: `could not download ${checksumsUrl}`, stderr: got.stderr, bytes: got.bytes };
  } else {
    fs.writeFileSync(manifest, `${step.sha256[arch] ?? step.sha256.amd64}  ${artifact}\n`);
    if (owner) run(["chown", owner, manifest]);
  }
  const verified = runAsAgent(["sha256sum", "--ignore-missing", "--check", "SHA256SUMS"], {
    cwd: download,
    timeoutMs: Math.min(STEP_TIMEOUT_MS, budget()),
  });
  if (!verified.ok) {
    // Nothing is unpacked, nothing is linked, and nothing downloaded has been
    // executed at any point. This is the verb's whole property.
    return { ok: false, detail: `${artifact} does not match its checksum`, stderr: verified.stderr, bytes: verified.bytes };
  }

  const archivePath = path.posix.join(download, artifact);
  let unpack;
  if (step.unpack === "tar.gz") {
    unpack = runAsAgent(["tar", "-xzf", archivePath, "-C", pkg], { timeoutMs: Math.min(STEP_TIMEOUT_MS, budget()) });
  } else if (step.unpack === "zip") {
    // `python3 -m zipfile -e`, which is stdlib in the python3 already at
    // `Dockerfile:130`, because this image has no `unzip`.
    unpack = runAsAgent(["python3", "-m", "zipfile", "-e", archivePath, pkg], { timeoutMs: Math.min(STEP_TIMEOUT_MS, budget()) });
  } else {
    unpack = runAsAgent(["cp", archivePath, path.posix.join(pkg, artifact)], { timeoutMs: Math.min(STEP_TIMEOUT_MS, budget()) });
  }
  if (!unpack.ok) return { ok: false, detail: `could not unpack ${artifact}`, stderr: unpack.stderr, bytes: unpack.bytes };

  // `python3 -m zipfile` does not preserve the executable bit — measured in
  // this container on 2026-09-12, a file zipped at 0755 extracts at 0644, which
  // is otherwise a `Permission denied` inside a tool call at the far end of a
  // green install.
  for (const entry of step.bin) {
    const declared = entry.from[arch] ?? entry.from.amd64;
    const from = path.posix.join(pkg, expandTokens(declared, { arch, name, root }));
    const marked = runAsAgent(["chmod", "0755", from], { timeoutMs: 10_000 });
    if (!marked.ok) return { ok: false, detail: `${declared} is not in the archive`, stderr: marked.stderr, bytes: marked.bytes };
  }

  return { ok: true, detail: `${step.bin.length} binary${step.bin.length === 1 ? "" : " files"} from ${artifact}`, stderr: "", bytes: 0 };
}

/**
 * One `uv-tool` or `npm-global` step: a package manager installs into `{pkg}`.
 *
 * The one thing this does that `applyArchiveStep` does not is **execute code
 * the package ships**, at install time, as the agent uid. `01b-` §2.1 says so
 * plainly and it is why this verb did not ship with the carrier: the first
 * thing the mechanism ever did was not going to be running a stranger's
 * install hook against an install nobody had reviewed yet.
 *
 * There is no digest and there cannot be one. `uv` and `npm` resolve a spec to
 * a release at install time and both verify what they fetch against their own
 * registries; a digest here would pin the spec's *text* and say nothing about
 * the bytes. What pins a version is the spec, which is why the worked examples
 * carry `==` and `@`.
 *
 * The binaries are checked to exist before the step is called `ok`, because
 * both tools exit 0 having installed a package whose console script is named
 * something other than the package — which is the same over-report the
 * `unclaimed` list carries, met here where it can still be a `failed` receipt
 * naming the name that is missing.
 */
function applyPackageStep(step, context) {
  const { name, arch, root, deadline } = context;
  const pkg = path.posix.join(root, "pkg", name);
  const spec = expandTokens(step.spec, { arch, name, root });

  const budget = () => deadline - Date.now();
  if (budget() <= 0) return { ok: false, detail: "the applier's time budget was spent", stderr: "", bytes: 0 };

  fs.mkdirSync(path.posix.join(pkg, "bin"), { recursive: true });
  const owner = agentOwner();
  if (owner) {
    const chown = run(["chown", "-R", owner, pkg]);
    if (!chown.ok) return { ok: false, detail: `could not hand ${pkg} to ${owner}`, stderr: chown.stderr, bytes: chown.bytes };
  }

  const argv =
    step.kind === "uv-tool"
      ? ["uv", "tool", "install", spec]
      : ["npm", "install", "-g", "--prefix", pkg, spec];
  const installed = runAsAgent(argv, {
    timeoutMs: Math.min(STEP_TIMEOUT_MS, budget()),
    env: PACKAGE_ENV[step.kind](pkg),
  });
  if (!installed.ok) {
    return { ok: false, detail: `${step.kind} could not install ${spec}`, stderr: installed.stderr, bytes: installed.bytes };
  }

  for (const entry of step.bin) {
    if (!fs.existsSync(path.posix.join(pkg, entry.from))) {
      return {
        ok: false,
        detail: `${spec} installed but left no command called "${entry.as}"`,
        stderr: "",
        bytes: 0,
      };
    }
  }

  return { ok: true, detail: `${step.bin.length} command${step.bin.length === 1 ? "" : "s"} from ${spec}`, stderr: "", bytes: 0 };
}

/**
 * What goes on `PATH`: a link into `{pkg}`, for every verb, always.
 *
 * **This replaced `install -m 0755` on 2026-09-12 and the reason is that a copy
 * cannot carry a toolchain.** `npm install -g --prefix` writes its bin as a
 * symlink into `lib/node_modules/`, and `install` follows one — measured, the
 * copy throws on its first relative `require`. Swift is the same fault one size
 * up: its driver resolves its resource directory from `/proc/self/exe`, so a
 * `swift` copied out of `usr/bin/` looks for `../lib/swift` beside wherever it
 * was copied to and finds nothing. A self-contained binary like `shellcheck`
 * does not care either way, so one rule serves all three and there is no
 * exception for somebody to find out about the hard way.
 *
 * **It is also the louder failure**, which is what decided it once both worked.
 * A reinstall that fails takes `pkg/` with it and leaves whatever is in `bin/`,
 * because removals happen only for stacks no longer declared. The copy left the
 * *previous version* there, working, claimed by no receipt — a stale tool
 * reported as `unclaimed` while agents went on invoking it, which is the exact
 * silent-wrong-version failure this whole mechanism exists to end. The link
 * dangles instead, and a dangling command fails the moment anything runs it.
 *
 * As safe as the copy was: the link is root's, in a root-owned directory, and it
 * points into `{pkg}`, which `claimAndLink` has already taken for root and
 * narrowed. Removed first because `symlink` refuses an existing path, which is
 * the second boot of an unchanged stack.
 */
function symlinkOnto(from, target) {
  try {
    fs.rmSync(target, { force: true });
    fs.symlinkSync(from, target);
    return { ok: true, stderr: "", bytes: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, stderr: message, bytes: message.length };
  }
}

/** Steps 5 and 6: root takes the tree, then links it onto `PATH`. */
function claimAndLink(stack, context) {
  const { name, arch, root } = context;
  const pkg = path.posix.join(root, "pkg", name);
  const binDir = path.posix.join(root, "bin");
  removePath(path.posix.join(pkg, ".download"));

  const owned = run(["chown", "-R", "root:root", pkg]);
  if (!owned.ok) return { ok: false, detail: `could not take ${pkg} for root`, stderr: owned.stderr, bytes: owned.bytes };
  const narrowed = run(["chmod", "-R", "go-w", pkg]);
  if (!narrowed.ok) return { ok: false, detail: `could not narrow ${pkg}`, stderr: narrowed.stderr, bytes: narrowed.bytes };

  fs.mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const linked = [];
  for (const step of stack.install) {
    for (const entry of step.bin) {
      const from = path.posix.join(pkg, expandTokens(entry.from[arch] ?? entry.from.amd64, { arch, name, root }));
      const target = path.posix.join(binDir, entry.as);
      const result = symlinkOnto(from, target);
      if (!result.ok) {
        return { ok: false, detail: `could not link ${entry.as}`, stderr: result.stderr, bytes: result.bytes };
      }
      linked.push({ name: entry.as, path: target });
    }
  }
  return { ok: true, linked };
}

/** The state directories, which exist because some tools refuse to create them. */
function makeState(stack, context) {
  const { name, root } = context;
  const stateDir = path.posix.join(root, "state", name);
  const made = [];
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o775 });
  for (const entry of stack.state) {
    const target = path.posix.join(stateDir, entry);
    fs.mkdirSync(target, { recursive: true, mode: 0o775 });
    made.push(target);
  }
  const owner = agentOwner();
  // Agent-owned because the tools write here, and recursive because a cache
  // that survived the last boot is already full of the agent's own files.
  if (owner) run(["chown", "-R", owner, stateDir]);
  run(["chmod", "0775", stateDir]);
  return made;
}

/**
 * The environment every `ok` stack exports, as one file the server reads.
 *
 * A file rather than an exported variable because the applier is a child of the
 * entrypoint and cannot put anything into its parent's environment;
 * `src/instrumentation.ts` merges it into `process.env` before the first
 * request, and `childEnv` copies it onward from there.
 *
 * Two stacks setting one key is the same fault as two claiming one binary and
 * is answered the same way, minus the severity: the lexically first stack wins,
 * the second is told in its receipt, and nothing is silently overridden.
 */
function writeEnvFile(root, exported) {
  const file = path.posix.join(root, "env.json");
  fs.writeFileSync(file, `${JSON.stringify(exported, null, 2)}\n`, { mode: 0o644 });
}

function main(argv) {
  const declarationsDir = argv[0] ?? DECLARATIONS_DIR;
  const root = argv[1] ?? TOOLBOX_DIR;
  const receiptsDir = path.posix.join(root, "receipts");
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const arch = architecture();

  const { mounted, declarations } = readDeclarations(declarationsDir);
  if (!mounted) {
    // An absent directory is not an empty one, and the difference is
    // destructive: reconciling against zero declarations removes every stack.
    // An operator who pointed UF_STACKS_DIR at the wrong path must not lose
    // what they installed on the strength of a typo.
    complain(
      `stacks: ${declarationsDir} is not mounted, so nothing was reconciled. ` +
        `Anything already installed is untouched.`,
    );
    return;
  }

  fs.mkdirSync(receiptsDir, { recursive: true });
  const receipts = readReceipts(receiptsDir);
  const { plan, removals } = reconcile(declarations, receipts);

  say(`stacks: ${declarations.length} declared in ${declarationsDir}`);

  for (const removal of removals) {
    for (const target of removal.paths) removePath(target);
    removePath(path.posix.join(receiptsDir, `${removal.name}.json`));
    say(`stack ${removal.name}: no longer declared, removed`);
  }

  const byName = new Map(declarations.map((d) => [d.name, d]));
  const exported = {};
  const exportedBy = new Map();
  let ok = 0;
  let failed = 0;

  for (const entry of plan) {
    const declaration = byName.get(entry.name);
    const context = { name: entry.name, arch, root, deadline };
    const base = { schema: SCHEMA_VERSION, name: entry.name, digest: declaration.digest, appliedAt: new Date().toISOString() };

    if (entry.action === "refuse" || entry.action === "conflict") {
      const status = entry.action === "refuse" ? "failed" : "conflicted";
      writeReceipt(receiptsDir, { ...base, status, summary: "", bin: [], deny: [], env: {}, state: [], steps: [], error: { text: entry.reason, bytes: entry.reason.length } });
      complain(`stack ${entry.name}: ${status} — ${entry.reason}`);
      failed += 1;
      continue;
    }

    if (entry.action === "skip") {
      const previous = receipts.find((r) => r.name === entry.name);
      say(`stack ${entry.name}: receipt matches, skipped`);
      for (const [key, value] of Object.entries(previous?.env ?? {})) {
        if (!exportedBy.has(key)) {
          exported[key] = value;
          exportedBy.set(key, entry.name);
        }
      }
      ok += 1;
      continue;
    }

    if (Date.now() >= deadline) {
      const reason = "not attempted: the applier's time budget was spent";
      writeReceipt(receiptsDir, { ...base, status: "failed", summary: declaration.stack.summary, bin: [], deny: [], env: {}, state: [], steps: [], error: { text: reason, bytes: reason.length } });
      complain(`stack ${entry.name}: ${reason}`);
      failed += 1;
      continue;
    }

    const stack = declaration.stack;
    say(`stack ${entry.name}: installing (${stack.install.map((s) => s.kind).join(", ")}, ${stack.install.length} step${stack.install.length === 1 ? "" : "s"}) — ${entry.reason}`);

    // A reinstall takes `pkg/` and leaves `state/`, so a version bump does not
    // throw away a provider cache.
    removePath(path.posix.join(root, "pkg", entry.name));

    const steps = [];
    let failure = null;
    for (const step of stack.install) {
      const result = step.kind === "archive" ? applyArchiveStep(step, context) : applyPackageStep(step, context);
      steps.push({ kind: step.kind, status: result.ok ? "ok" : "failed", detail: result.detail });
      if (!result.ok) {
        failure = { text: result.stderr ? `${result.detail}\n${result.stderr}` : result.detail, bytes: result.bytes };
        break;
      }
    }

    let linked = [];
    if (!failure) {
      const claimed = claimAndLink(stack, context);
      if (claimed.ok) {
        linked = claimed.linked;
      } else {
        steps.push({ kind: "link", status: "failed", detail: claimed.detail });
        failure = { text: `${claimed.detail}\n${claimed.stderr}`, bytes: claimed.bytes };
      }
    }

    if (failure) {
      // No binary from a failed stack is linked, which is why this removes the
      // tree rather than leaving half of it on PATH.
      removePath(path.posix.join(root, "pkg", entry.name));
      writeReceipt(receiptsDir, { ...base, status: "failed", summary: stack.summary, bin: [], deny: stack.deny, env: {}, state: [], steps, error: { text: failure.text.slice(-STDERR_CAP_BYTES), bytes: failure.bytes || failure.text.length } });
      complain(`stack ${entry.name}: failed — ${steps[steps.length - 1]?.detail ?? "unknown"}`);
      failed += 1;
      continue;
    }

    const state = makeState(stack, context);
    const env = {};
    const declined = [];
    for (const [key, value] of Object.entries(stack.env)) {
      const expanded = expandTokens(value, { arch, name: entry.name, root });
      if (exportedBy.has(key)) {
        declined.push(`${key} is already exported by stack "${exportedBy.get(key)}"`);
        continue;
      }
      exported[key] = expanded;
      exportedBy.set(key, entry.name);
      env[key] = expanded;
    }

    writeReceipt(receiptsDir, {
      ...base,
      status: "ok",
      summary: stack.summary,
      bin: linked,
      deny: stack.deny,
      env,
      state,
      steps,
      error: declined.length > 0 ? { text: declined.join("; "), bytes: declined.join("; ").length } : null,
    });
    for (const message of declined) complain(`stack ${entry.name}: ${message}`);
    say(`stack ${entry.name}: installed, ${linked.length} binar${linked.length === 1 ? "y" : "ies"}, ${stack.deny.length} denied`);
    ok += 1;
  }

  writeEnvFile(root, exported);
  say(`stacks: ${ok} ok, ${failed} failed`);
}

// Guarded so a test may import the pure half without applying anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    // Never fatal: a stack that will not install is a degraded install, and
    // refusing the boot over one would take the dashboard, the run history and
    // every guard away from an operator whose agents may never reach for it.
    complain(`stacks: the applier did not finish — ${err instanceof Error ? err.message : String(err)}`);
  }
}
