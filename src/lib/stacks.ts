import fs from "node:fs";
import path from "node:path";

/**
 * What the stack applier did, read back.
 *
 * `scripts/apply-stacks.mjs` installs the stacks an operator declared under
 * `./stacks` and writes one receipt per stack into the named volume. This
 * module is the only thing that reads them. It is deliberately a *reader*: it
 * installs nothing, removes nothing and repairs nothing, because the applier
 * runs in the one window of the container's life with no agent process alive
 * and this runs in a request.
 *
 * ## Why a receipt is validated rather than trusted
 *
 * A receipt is written by a script and read by TypeScript, which is a boundary,
 * and `CLAUDE.md`'s rule is to validate at boundaries and trust internal calls.
 * The branch that earns the validation is the truncated receipt a container
 * killed mid-write leaves behind: it must read `unreadable` and never a partial
 * `ok`, because a partial `ok` is the read-back reporting an install that did
 * not happen. The applier writes to a temporary file and renames, so this
 * should not be reachable from the current build — and an older build's
 * receipt, a failed rename and a volume restored from underneath the container
 * all still are.
 *
 * ## Why there is no `stacks` table
 *
 * The receipts *are* the state and they are per boot. A table would be a second
 * record of what is installed that could disagree with the directory, and the
 * one question a monitor asks — what did **this** boot find wrong — is answered
 * by a set that is rewritten on every boot and by nothing that outlives one.
 */

/**
 * The read-only bind of the host's `./stacks`, where declarations are read from.
 *
 * A copy of `DECLARATIONS_DIR` in `scripts/apply-stacks.mjs`, which is where it
 * is used — the runtime image ships `scripts/` without `src/`, so neither can
 * import the other. `deployment.test.ts` holds the two to the entrypoint's own
 * value, because a copy drifts silently and what it costs here is a page
 * telling an operator to edit a directory that is not there.
 *
 * Nothing in this app reads a file under it. It is carried only so the detail
 * page can say where a stack came from.
 */
export const STACKS_DECLARATIONS_DIR = "/etc/uf-stacks";

/** The named volume. Nothing in the image is ever written under here. */
export const STACKS_ROOT = "/var/lib/uf-stacks";

/** Every linked binary, one flat directory, root-owned and on the image's `PATH`. */
export const STACKS_BIN_DIR = `${STACKS_ROOT}/bin`;

/** One receipt per stack, rewritten on every boot. */
export const STACKS_RECEIPTS_DIR = `${STACKS_ROOT}/receipts`;

/** The tools' own caches, agent-owned, kept across a reinstall. */
export const STACKS_STATE_DIR = `${STACKS_ROOT}/state`;

/**
 * The environment every `ok` stack exports, merged into `process.env` at boot.
 *
 * A file because the applier is a child of the entrypoint and cannot write into
 * its parent's environment. `src/instrumentation.ts` reads it before the first
 * request; `childEnv` carries it onward to every agent child from there.
 */
export const STACKS_ENV_FILE = `${STACKS_ROOT}/env.json`;

/** What the applier recorded for one stack. */
export interface StackReceipt {
  name: string;
  /** `sha256` over the bytes of `stack.json`, which is what a reinstall turns on. */
  digest: string;
  status: "ok" | "failed" | "conflicted";
  /** ISO 8601, or `null` on a receipt that did not carry one. */
  appliedAt: string | null;
  summary: string;
  /** The binaries linked into `bin/`, and the only paths the applier may remove. */
  bin: { name: string; path: string }[];
  /** The commands a work cycle may not run. Empty means every command of every binary. */
  deny: string[];
  /** What this stack exports, already expanded. */
  env: Record<string, string>;
  /** The state directories created under `state/<name>`. */
  state: string[];
  steps: { kind: string; status: "ok" | "failed"; detail: string }[];
  /**
   * On failure, the last 4 KB of the step's stderr and the original byte count.
   *
   * Carried verbatim and never parsed, and the byte count is beside it because
   * a truncated message that does not say it is truncated is
   * `status.ts:41-46`'s *"plausible number that is quietly a third of the real
   * one"*. On an `ok` receipt this is either `null` or a note about something
   * the applier declined to do, such as an environment key another stack had
   * already exported.
   */
  error: { text: string; bytes: number } | null;
}

/** A receipt file that could not be turned into a receipt. */
export interface UnreadableReceipt {
  name: string;
  reason: string;
}

const STATUSES = new Set(["ok", "failed", "conflicted"]);

/**
 * Turn one receipt file's text into a receipt, or say why it is not one.
 *
 * Returns `null` for anything it will not vouch for. Every field the app acts
 * on is checked: a receipt with no `status`, an unknown `status` or a `bin`
 * entry that is not a path is a receipt this app would otherwise draw as an
 * installed tool, and a half-written file parses as far as its truncation and
 * no further.
 */
export function parseReceipt(text: string): StackReceipt | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  if (typeof record.name !== "string" || record.name.length === 0) return null;
  if (typeof record.status !== "string" || !STATUSES.has(record.status)) return null;
  if (typeof record.digest !== "string") return null;

  const bin: { name: string; path: string }[] = [];
  if (record.bin !== undefined) {
    if (!Array.isArray(record.bin)) return null;
    for (const entry of record.bin) {
      if (entry === null || typeof entry !== "object") return null;
      const { name, path: binPath } = entry as Record<string, unknown>;
      // A link whose path is missing is the one field a page would draw as a
      // resolved binary, so a receipt carrying half of one is refused whole.
      if (typeof name !== "string" || typeof binPath !== "string") return null;
      bin.push({ name, path: binPath });
    }
  }

  return {
    name: record.name,
    digest: record.digest,
    status: record.status as StackReceipt["status"],
    appliedAt: typeof record.appliedAt === "string" ? record.appliedAt : null,
    summary: typeof record.summary === "string" ? record.summary : "",
    bin,
    deny: stringList(record.deny),
    env: stringMap(record.env),
    state: stringList(record.state),
    steps: steps(record.steps),
    error: errorOf(record.error),
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function stringMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function steps(value: unknown): StackReceipt["steps"] {
  if (!Array.isArray(value)) return [];
  const out: StackReceipt["steps"] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const { kind, status, detail } = entry as Record<string, unknown>;
    if (typeof kind !== "string") continue;
    out.push({
      kind,
      status: status === "ok" ? "ok" : "failed",
      detail: typeof detail === "string" ? detail : "",
    });
  }
  return out;
}

function errorOf(value: unknown): StackReceipt["error"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { text, bytes } = value as Record<string, unknown>;
  if (typeof text !== "string") return null;
  return { text, bytes: typeof bytes === "number" && Number.isFinite(bytes) ? bytes : text.length };
}

/**
 * Every receipt in the volume, plus the ones that are there and unreadable.
 *
 * The two are separated rather than both becoming an absence, on
 * `PluginsReportDTO`'s grounds: a list that silently omits a stack cannot
 * explain why what an operator is looking for is not in it. A missing directory
 * is an install with no stacks and is not a fault; a directory that cannot be
 * read is one, and that is what `problem` carries.
 */
export function readReceipts(dir = STACKS_RECEIPTS_DIR): {
  receipts: StackReceipt[];
  unreadable: UnreadableReceipt[];
  problem: string | null;
} {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { receipts: [], unreadable: [], problem: null };
    return {
      receipts: [],
      unreadable: [],
      problem: `The stack receipts in ${dir} could not be read (${code ?? "unknown error"}).`,
    };
  }

  const receipts: StackReceipt[] = [];
  const unreadable: UnreadableReceipt[] = [];
  for (const file of names.filter((name) => name.endsWith(".json")).sort()) {
    const stackName = file.slice(0, -".json".length);
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, file), "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      unreadable.push({ name: stackName, reason: `the receipt could not be read (${code ?? "unknown error"})` });
      continue;
    }
    const receipt = parseReceipt(text);
    if (receipt === null) {
      unreadable.push({
        name: stackName,
        reason:
          "the receipt is not one this app can read — a container killed part-way through a boot " +
          "leaves one of these, and the next restart rewrites it",
      });
      continue;
    }
    receipts.push(receipt);
  }
  return { receipts, unreadable, problem: null };
}

/**
 * What the stacks export, for `src/instrumentation.ts` to merge at boot.
 *
 * Returns an empty object for an install with no stacks and for one whose file
 * cannot be read, because there is nothing the server could do differently
 * either way: the applier has already written a receipt saying what happened,
 * and that is the surface an operator reads. What this must never do is throw,
 * since it runs inside `register()` and a rejected `register()` leaves Next
 * listening anyway.
 */
export function stackEnvironment(file = STACKS_ENV_FILE): Record<string, string> {
  try {
    return stringMap(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return {};
  }
}

/**
 * What every `ok` stack grants a work cycle, and what it takes back.
 *
 * `--allowedTools` and `--disallowedTools` entries, ready to spread onto an
 * argv. `01a-` §4.2 is the design and `23-revision-per-repo-and-login.md` §9 is
 * the revision that made it a deny-list rather than an allow-list:
 *
 * - **`allow` is derived and needs no author decision.** Every binary a stack
 *   links becomes `Bash(<name>:*)`. An operator who declared a tool meant their
 *   agents to be able to run it, and a stack that installed perfectly and
 *   granted nothing is the quiet failure `01a-` §8 names — measured on
 *   2026-09-12, an ungranted binary at `acceptEdits` is refused with *"This
 *   command requires approval"* and the turn ends `success` having run nothing.
 * - **`deny` is what the author wrote**, one `Bash(<entry>:*)` each. Deny beats
 *   allow and beats the mode, which is the verified half of the pair
 *   (`agents.ts:216-218`), so the result reads the way the operator asked for
 *   it: everything this stack installs, except what you denied.
 *
 * **Only `ok` receipts.** A `failed` or `conflicted` stack linked nothing, so
 * its grant would name a binary that is not there and its denial would bind a
 * command nothing can run.
 *
 * **Nothing is re-validated here, deliberately.** That an entry names one of
 * this stack's own binaries, and that it carries no parenthesis to close the
 * `Bash(...)` it is interpolated into, are refusals `parseStack` makes before a
 * byte is downloaded. A second check here would be a second place that can
 * disagree with the first about what a stack may grant — and the receipts are
 * root-owned in a volume no agent can write, so the only way to get past the
 * first is to be root in the container already.
 *
 * **Two of the five child kinds read this**, per `01c-` §5: the work cycle and
 * the conflict assist. A reviewer runs `plan` and cannot invoke a tool whatever
 * any list says; a chat turn and a workflow orchestrator run
 * `bypassPermissions`, where the allow half is redundant — and where the deny
 * half is deliberately absent, because those children could already run every
 * binary in the image and a stack does not change what they may do.
 */
export interface StackGrants {
  allow: string[];
  deny: string[];
}

/**
 * Cached for the life of the process, which is the exact life of the receipts.
 *
 * The applier runs in `docker-entrypoint.sh` before `exec "$@"`, so every
 * receipt this server will ever see was written before it started and the only
 * thing that rewrites one is a restart — which takes this cache with it. A TTL
 * would be a re-read that can never return anything different.
 */
const grants = (globalThis as unknown as { __ufStackGrants?: { value: StackGrants | null } });
grants.__ufStackGrants ??= { value: null };

export function stackGrants(dir = STACKS_RECEIPTS_DIR): StackGrants {
  const cache = grants.__ufStackGrants!;
  if (cache.value) return cache.value;
  const allow: string[] = [];
  const deny: string[] = [];
  for (const receipt of readReceipts(dir).receipts) {
    if (receipt.status !== "ok") continue;
    for (const entry of receipt.bin) allow.push(`Bash(${entry.name}:*)`);
    for (const entry of receipt.deny) deny.push(`Bash(${entry}:*)`);
  }
  cache.value = { allow, deny };
  return cache.value;
}

/**
 * The one event name every non-`ok` stack is recorded under.
 *
 * One name rather than one per failure kind, on `db.ts:207-211`'s grounds for
 * `SCHEMA_FAULT_EVENT`: they answer a single question — what did **this** boot
 * find wrong — and a reader asks it with a single-name query, with `detail`
 * saying which kind it was.
 */
export const STACK_FAULT_EVENT = "stacks.not_ok";

/** One stack this boot did not install, in the shape an ops row carries. */
export interface StackFault {
  name: string;
  /** `failed`, `conflicted`, or `unreadable` for a receipt that is not one. */
  status: string;
  reason: string;
}

/**
 * Every stack this boot found wrong, for the archive a restart does not erase.
 *
 * A reader, like everything else here — the caller writes the rows. That keeps
 * this module free of `db.ts` and puts the boot-time side effect in the boot
 * hook, beside every other one.
 *
 * **Per stack and never per step.** `ops_events` is capped at 500 rows and the
 * cap was sized for *"boot-frequency writes"* (`db.ts:136-137`); a row per step
 * per boot on an install with a few stacks would evict the rest of the table,
 * which is the trap `contextPruning.ts:2919-2922` records for a repeating
 * fault. One stack that will not install is one row however many steps it has.
 *
 * The reason is the applier's own text, clipped: a receipt can carry 4 KB of
 * somebody's stderr and this row is an index into the detail page, not a
 * replacement for it.
 */
export function stackFaults(dir = STACKS_RECEIPTS_DIR): StackFault[] {
  const { receipts, unreadable } = readReceipts(dir);
  const faults: StackFault[] = [];
  for (const receipt of receipts) {
    if (receipt.status === "ok") continue;
    faults.push({
      name: receipt.name,
      status: receipt.status,
      reason: firstLine(receipt.error?.text ?? "") || "the receipt records no reason",
    });
  }
  for (const entry of unreadable) {
    faults.push({ name: entry.name, status: "unreadable", reason: entry.reason });
  }
  return faults;
}

/** The applier's own sentence, which it writes ahead of the tool's stderr. */
function firstLine(text: string): string {
  return (text.split("\n", 1)[0] ?? "").slice(0, 300);
}

/**
 * How much the tools' own caches are holding for one stack, in bytes.
 *
 * This is what the detail page has to be able to say before an operator deletes
 * a directory: `state/<name>` goes with the stack, and for a stack whose state
 * is a provider cache that is a re-download, while for one whose state is
 * anything else it is a loss (`01e-` §6).
 *
 * Uncached, and that is a decision rather than an oversight: it is one walk over
 * one directory, on a page an operator opens on purpose and leaves — which is
 * the opposite of the Storage card's walks, whose caching `retention.md`
 * governs because they run on a page that polls.
 *
 * Returns `null` rather than `0` when the directory is not there or cannot be
 * walked. A stack that declared no `state` and one whose cache could not be
 * measured are not the same fact, and a zero would say the operator has nothing
 * to lose when nothing looked.
 */
export function stateBytes(name: string, root = STACKS_STATE_DIR): number | null {
  const dir = path.join(root, name);
  let total = 0;
  const walk = (at: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const child = path.join(at, entry.name);
      // Never followed. A symlink into the run's own checkout would otherwise
      // have this walk measure a repository and call it a cache.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!walk(child)) return false;
        continue;
      }
      try {
        total += fs.statSync(child).size;
      } catch {
        return false;
      }
    }
    return true;
  };
  return walk(dir) ? total : null;
}
