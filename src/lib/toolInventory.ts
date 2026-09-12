import fs from "node:fs";
import path from "node:path";

import { db } from "./db";
import { retentionCutoff } from "./retention";
import { getSettings } from "./settings";

/**
 * What this install's agents can actually run, and how sure the app is of it.
 *
 * Three sources put a tool inside this container — `UF_PY_TOOLS`,
 * `UF_GH_EXTENSIONS` and, from `proposals/CustomStacks/` phase 2, a stack — and
 * until this module none of them was readable from the app at all. An operator
 * learned whether an install worked by reading the boot log, which
 * `db.ts:182-184` already explains is not enough: *"a container's stdout is a
 * scrollback buffer that the restart destroys, and the restart is exactly when
 * an operator comes looking."*
 *
 * ## Why a reading and not a status
 *
 * The receipt is not the truth. What an agent gets is whatever resolves at the
 * moment it types a word, and a tool can be installed perfectly and still be
 * absent, shadowed by a copy outside the toolbox, or failing every call. So
 * every row here is composed from four readings taken from four places —
 * declared, installed, reachable, observed — and `composeState` is the one
 * function that turns them into a word. A layer is never inferred from the
 * layer above it, and `installed` is the only word that requires all four to
 * agree, because it is the one an operator acts on without reading further.
 *
 * ## Why the two list parsers are one module and not two one-liners
 *
 * They do not split on the same characters and the difference is silent.
 * `docker-entrypoint.sh:185` splits `UF_GH_EXTENSIONS` with `tr '|,' '  '`;
 * `:252` splits `UF_PY_TOOLS` with `tr '|' ' '` and says why — *"a comma is
 * meaningful inside a version specifier (`cozempic>=1.8,<2`), so accepting it
 * as a separator would turn one pinned entry into two unpinnable ones."* A
 * parser that gets that backwards reports two tools an operator never asked
 * for, neither of which installed, and nothing anywhere says the line was
 * misread.
 *
 * ## Why the environment is read here rather than through `config.ts`
 *
 * `privsep.ts:207` and `middleware.ts:41` already read `process.env.UF_*` in
 * the module that owns the subject, and this is that module for these two.
 * Routing them through `config.ts` would mean adding both to
 * `BLANK_MEANINGFUL_ENV_VARS` and to README's counted list — three files of
 * churn (`deployment.test.ts:805`, `:816`) for two variables nothing else
 * reads. What matters either way is the direction: `childEnv` deletes every
 * `UF_` key from a child's environment (`orchestrator.ts:5698-5715`), so
 * reading these on the server is legal and reading them in any agent would
 * find nothing.
 */

/** Where `uv tool install` puts its launchers — `Dockerfile:283`, and on `PATH` at `:281`. */
export const PY_TOOLS_BIN_DIR = "/home/node/pytools/bin";

/** Where `gh` keeps extensions — `docker-entrypoint.sh:69`, the third named volume. */
export const GH_EXTENSIONS_DIR = "/home/node/.local/share/gh/extensions";

/**
 * The two ways a tool arrives today. Phase 2 adds `"stack"` beside them and
 * nothing in `composeState` changes to admit it.
 */
export type ToolSource = "python" | "gh-extension";

/**
 * One word per tool, worst reading wins.
 *
 * Six of the seven are `01f-read-back.md` §3's. The seventh, `unknown`, is this
 * module's and it is forced by `.env.example:263`: a `UF_PY_TOOLS` entry may be
 * a bare container path, which is installed editable and whose console script
 * name lives in the project's metadata rather than in the string. There is no
 * command to resolve, so every one of the other six would be a claim nobody
 * measured. `SandboxRow` reserves the same word for the same reason — *"a
 * policy file this app could not read, and it is deliberately neutral rather
 * than reassuring"* (`settings/page.tsx:1747-1750`).
 */
export type ToolState =
  | "installed"
  | "unverified"
  | "shadowed"
  | "failing"
  | "broken"
  | "failed"
  | "unknown";

/** One entry of `UF_PY_TOOLS` or `UF_GH_EXTENSIONS`, as the operator wrote it. */
export interface DeclaredTool {
  source: ToolSource;
  /** The entry verbatim. This is what the operator recognises in `.env`. */
  spec: string;
  /**
   * The command an agent would type, or `null` when the spec carries none.
   *
   * For a Python tool it is the package name, parsed exactly the way
   * `docker-entrypoint.sh:282` parses it (`${entry%%[=<>!~[@]*}`), and it is a
   * guess at the console script rather than a fact: a package may ship a script
   * under another name or several. For a gh extension it is `gh <command>`,
   * which needs no guessing — see `readGhExtensions`.
   */
  command: string | null;
  /** The version or tag the entry pins, or `null` for an unpinned one. */
  pin: string | null;
}

/** What an applier recorded. `none` is a source that has no applier and never will. */
export type InstallRecord = "ok" | "failed" | "conflicted" | "missing" | "none";

/** The four readings `composeState` turns into one word. */
export interface ToolReadings {
  install: InstallRecord;
  /** Absolute path the command resolved to, or `null` when nothing resolves. */
  resolvedAt: string | null;
  /** False when the resolution landed outside the directory this source installs into. */
  insideItsOwnToolbox: boolean;
  /** `null` when the declaration names no command this app can check. */
  command: string | null;
  calls: number;
  failures: number;
}

/** One row of the Tools section. */
export interface ToolRow {
  source: ToolSource;
  spec: string;
  command: string | null;
  pin: string | null;
  /** What `gh` says it actually installed, when it differs from the pin. */
  installedPin: string | null;
  state: ToolState;
  resolvedAt: string | null;
  calls: number;
  failures: number;
  /** The server's sentence. The page draws it and never writes a second copy. */
  detail: string;
}

export interface ToolInventory {
  rows: ToolRow[];
  /**
   * Commands in a toolbox that no declaration claims.
   *
   * Carried rather than dropped, on `PluginsReportDTO`'s grounds: a list that
   * silently omits things cannot explain why what an operator is looking for is
   * not there. Installing by hand is the case it is *for*, and it is not the
   * only one it catches — a Python package whose console script is named
   * something other than the package appears here too, because the declaration
   * only ever carried the package name. `docker-entrypoint.sh:280-281` parses
   * that name *"only to ask whether it is already installed"* and never as the
   * command, so the app has no second source to join against. The page has to
   * say so rather than call every row here somebody's doing.
   */
  unclaimed: string[];
  /**
   * How far back the invocation counts reach, in days, or `null` when this
   * install keeps events for ever. Printed, never implied: *"never observed"*
   * means *"not in the retained window"* and the page has to say which window.
   */
  observedWindowDays: number | null;
  /** Whatever could not be read at all. Never rendered as an empty list. */
  problems: string[];
}

/* ------------------------------------------------------------------ */
/* Parsing the two declarations                                        */
/* ------------------------------------------------------------------ */

/**
 * Split one of the two list variables into entries and name what each installs.
 *
 * The separator set is per source and is the entrypoint's, not a convention:
 * a comma separates `UF_GH_EXTENSIONS` and is part of the value in
 * `UF_PY_TOOLS`. Both also split on any run of whitespace, because the shell
 * word-splits the `tr` output and `.env.example:216` documents spaces as the
 * ordinary separator for one and `:253` for the other.
 *
 * Taking the source rather than a separator pattern is deliberate. The split
 * rule and the name rule are both per source, and a signature that let a caller
 * pair one source's separators with the other's name parser would make the one
 * mistake this function exists to prevent expressible.
 */
export function parseToolList(value: string, source: ToolSource): DeclaredTool[] {
  const separators = source === "python" ? /[\s|]+/ : /[\s,|]+/;
  const out: DeclaredTool[] = [];
  for (const spec of value.split(separators)) {
    if (!spec) continue;
    out.push(source === "python" ? pythonEntry(spec) : ghEntry(spec));
  }
  return out;
}

function pythonEntry(spec: string): DeclaredTool {
  // A bare container path is a checkout, installed `--editable`, and the one
  // form that carries no name: `docker-entrypoint.sh:275-277` takes the
  // `/*` branch precisely so it never parses one out. Its console scripts come
  // from the project's metadata, which this app does not read.
  if (spec.startsWith("/")) return { source: "python", spec, command: null, pin: null };

  // `${entry%%[=<>!~[@]*}` at `docker-entrypoint.sh:282`, character for
  // character. Everything after the first of those is a PEP 508 specifier, an
  // extra, or a direct URL, and all three belong to uv rather than here.
  const cut = spec.search(/[=<>!~[@]/);
  if (cut === -1) return { source: "python", spec, command: spec, pin: null };
  return {
    source: "python",
    spec,
    command: spec.slice(0, cut) || null,
    pin: spec.slice(cut) || null,
  };
}

function ghEntry(spec: string): DeclaredTool {
  // `case *@*) repo="${entry%@*}"; tag="${entry##*@}"` — both cut at the LAST
  // `@`, which is what lets an owner or a repository contain one.
  const at = spec.lastIndexOf("@");
  const repo = at === -1 ? spec : spec.slice(0, at);
  const tag = at === -1 ? null : spec.slice(at + 1) || null;
  // gh requires an extension repository to be named `gh-<command>` and creates
  // the directory under that name, so the command is the repository's name with
  // the prefix off. `docker-entrypoint.sh:191-194` declines to derive it and
  // matches on the slug instead, which is the right call *there* — it is
  // comparing against `gh extension list` output, which carries the slug. Here
  // the join is against the directory, and `readGhExtensions` does it by name
  // rather than by derivation.
  const name = repo.slice(repo.lastIndexOf("/") + 1);
  return {
    source: "gh-extension",
    spec,
    command: name ? `gh ${name.replace(/^gh-/, "")}` : null,
    pin: tag,
  };
}

/* ------------------------------------------------------------------ */
/* Reachable                                                           */
/* ------------------------------------------------------------------ */

/**
 * Resolve a bare command the way a child would, against the server's own
 * `PATH`.
 *
 * The server's is the right one to split and that is the fact the whole layer
 * rests on: `childEnv` copies `process.env` and deletes four prefixes and six
 * names (`orchestrator.ts:5698-5715`), none of which is `PATH`, so the server's
 * `PATH` *is* the child's.
 *
 * The predicate is injected so the function stays pure. Its failure mode is the
 * classic one — an empty `PATH` element means the current directory and a
 * trailing colon means the same, so a resolver that treats either as "not
 * found" or as "found" silently changes what the page claims about every binary
 * at once.
 */
export function resolveOnPath(
  name: string,
  pathValue: string,
  exists: (candidate: string) => boolean,
): string | null {
  if (!name || name.includes("/")) return null;
  for (const element of pathValue.split(":")) {
    // POSIX: a zero-length element is the current directory, which is what a
    // trailing or a doubled colon writes by accident. Spelled `./name` rather
    // than handed to `path.join`, which normalises the `./` away and would
    // leave the page reporting a bare word where every other row shows a path.
    const candidate = element === "" ? `./${name}` : path.join(element, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** An executable file, for `resolveOnPath`. Separate so the caller can inject it. */
export function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** One extension `gh` has actually installed, read off the volume. */
export interface InstalledGhExtension {
  /** The directory name, which gh makes equal to the repository's name. */
  repoName: string;
  /** From `manifest.yml`, which binary extensions carry and git ones may not. */
  owner: string | null;
  tag: string | null;
  /** The executable inside the directory, when it is there. */
  binPath: string | null;
}

/**
 * What is in the gh extensions volume.
 *
 * A gh extension is not a binary on `PATH` and `resolveOnPath` does not apply
 * to it: the child types `gh layer10`, and what has to exist is the extension
 * directory, not a command called `layer10`. Measured in the running container
 * 2026-09-12 — `/home/node/.local/share/gh/extensions/gh-layer10/` holding
 * `gh-layer10` and a `manifest.yml` reading `owner: Xapicc`, `name: gh-layer10`,
 * `tag: v0.1.0`.
 *
 * The manifest is worth reading for one reason beyond the join: it carries the
 * tag gh *installed*, and `.env.example:227-229` says an entry whose `@tag` has
 * since moved is deliberately **not** reinstalled — *"a restart is not a good
 * moment to silently swap out an executable that holds a token."* That drift is
 * invisible today. With the manifest it is one line on a card.
 *
 * Throws nothing: a missing directory is an install with no extensions and is
 * not a fault, while a directory that cannot be read is, and the two are
 * separated by the caller through `problems` rather than both becoming an empty
 * list.
 */
export function readGhExtensions(dir = GH_EXTENSIONS_DIR): {
  extensions: InstalledGhExtension[];
  problem: string | null;
} {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Nothing has ever installed one. An empty list is the truth here.
    if (code === "ENOENT") return { extensions: [], problem: null };
    return {
      extensions: [],
      problem: `The gh extensions directory ${dir} could not be read (${code ?? "unknown error"}).`,
    };
  }

  const extensions: InstalledGhExtension[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const home = path.join(dir, entry.name);
    let owner: string | null = null;
    let tag: string | null = null;
    let declaredPath: string | null = null;
    try {
      const manifest = fs.readFileSync(path.join(home, "manifest.yml"), "utf8");
      owner = /^owner:\s*(\S+)\s*$/m.exec(manifest)?.[1] ?? null;
      tag = /^tag:\s*(\S+)\s*$/m.exec(manifest)?.[1] ?? null;
      declaredPath = /^path:\s*(\S+)\s*$/m.exec(manifest)?.[1] ?? null;
    } catch {
      // A git-cloned extension has no manifest. The directory name is still the
      // repository's name, which is the half the join needs.
    }
    // The manifest's own `path` where there is one, because it is what gh
    // recorded rather than what this app guessed. `<dir>/<dir-name>` is the
    // convention a precompiled extension follows and the only layout seen here;
    // a script extension's has not been observed, and guessing it wrong would
    // draw every one of them `failed`.
    const bin = declaredPath ?? path.join(home, entry.name);
    extensions.push({
      repoName: entry.name,
      owner,
      tag,
      binPath: isExecutableFile(bin) ? bin : null,
    });
  }
  return { extensions, problem: null };
}

/* ------------------------------------------------------------------ */
/* Observed                                                            */
/* ------------------------------------------------------------------ */

/**
 * Every command name invoked at a command position in one `Bash` call.
 *
 * A leading-prefix test is what the design asked for and it is too weak to
 * carry the layer. Measured with this function against this install's own
 * history on 2026-09-12, over the 30-day window and its 53,833 `Bash` rows:
 * **105 commands begin `gh ` against 1,000 that invoke it at a command
 * position — 10.5% recall.** At that rate no tool ever reaches `installed` and
 * the whole reading stops carrying information.
 *
 * So the test moves from "starts with" to "appears where a command may start":
 * the head of the string, and the head of every segment after `&&`, `||`, `|`,
 * `;`, `&`, a bracket or a newline. A leading `VAR=value` assignment is stepped
 * over, and an absolute path is reduced to its basename, both of which the SQL
 * version could not do: 3,282 of those commands do not begin with a bare
 * binary name at all, and `git` is found at a command position 6,765 times.
 *
 * **It both under- and over-counts and the page must not pretend otherwise.**
 * It misses a binary reached through a wrapper script, a shell function or a
 * quoted `sh -c`, which is `sandbox.ts:157-159`'s trade taken in the same
 * direction; and because it does not parse quoting, a declared tool's name
 * inside a quoted string after a `;` counts as a call. The first leaves a
 * working tool reading `unverified`, the second is the expensive direction and
 * is why `installed` needs the other three layers to agree as well.
 */
export function commandPositionNames(command: string): string[] {
  const out: string[] = [];
  for (const segment of command.split(/&&|\|\||[;|&()\n{}]/)) {
    for (const word of segment.trim().split(/\s+/)) {
      if (!word) break;
      // `FOO=bar cmd` — the assignment is not the command, the next word is.
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
      out.push(word.slice(word.lastIndexOf("/") + 1));
      break;
    }
  }
  return out;
}

/** How often a name has been invoked, and how often that came back an error. */
export interface InvocationCounts {
  calls: number;
  failures: number;
}

/**
 * `calls` and `failures` per name, over the retained window.
 *
 * ## The two kinds do not carry the command in the same place
 *
 * Measured against this install's database on 2026-09-12: of 2,249
 * `tool_error` rows, 2,249 carry the command at `$.command` and **none** at
 * `$.input.command`; of 52,051 `tool` rows it is the other way round. A query
 * that reads both the same way counts zero failures for ever — so `failing`
 * becomes unreachable and every failing tool reads `installed`, which is the
 * one direction `01f-read-back.md` §3 calls expensive.
 *
 * `calls − failures` is **not** successes and the page never subtracts them:
 * *"Errors only — a successful result is not recorded at all"*
 * (`apiTypes.ts:2216`), and a run killed mid-call produces neither answer.
 *
 * ## One scan, matched here rather than in SQL
 *
 * `run_events` has no index for this question — `idx_run_events_run` is
 * `(run_id, id)` and `idx_run_events_sandbox` is partial on `kind = 'sandbox'`
 * — so it is a scan either way. Matching in SQL costs a `LIKE` sweep per name:
 * measured 95 ms for the bare scan, then about 130 ms for each name added,
 * 1,444 ms at ten. `better-sqlite3` is synchronous, so that is the event loop
 * of the server that also admits runs. One `iterate()` pass matched here is
 * 308 ms for all ten and flat in the number of names, because another name is
 * another `Map` lookup. `iterate` rather than `all` keeps peak memory at one
 * row instead of the 18.5 MB of command text the window holds.
 *
 * The cache is `fileCostNotice.ts:310-315`'s, whole, and its argument
 * transfers: staleness costs nothing on a reading of thirty days of history,
 * and an index would move the cost onto every insert into the busiest table in
 * the schema instead.
 */
const INVOCATION_TTL_MS = 60_000;

const invocationCache = ((
  globalThis as unknown as {
    __ufToolInvocations?: { at: number; cutoff: number | null; value: Map<string, InvocationCounts> };
  }
).__ufToolInvocations ??= { at: 0, cutoff: null, value: new Map() });

export function invocationCounts(
  names: string[],
  now = Date.now(),
): Map<string, InvocationCounts> {
  const cutoff = retentionCutoff(getSettings().eventRetentionDays, now);
  const wanted = new Set(names);
  const fresh =
    now - invocationCache.at < INVOCATION_TTL_MS && invocationCache.cutoff === cutoff;
  if (fresh && [...wanted].every((name) => invocationCache.value.has(name))) {
    return invocationCache.value;
  }

  const counts = new Map<string, InvocationCounts>();
  for (const name of wanted) counts.set(name, { calls: 0, failures: 0 });
  if (wanted.size > 0) {
    const rows = db()
      .prepare(
        `SELECT CASE kind WHEN 'tool' THEN 0 ELSE 1 END AS failed,
                CASE kind WHEN 'tool' THEN json_extract(payload, '$.input.command')
                          ELSE json_extract(payload, '$.command') END AS command
           FROM run_events
          WHERE kind IN ('tool', 'tool_error')
            AND ts >= ?
            AND json_extract(payload, '$.name') = 'Bash'`,
      )
      // A null cutoff is retention switched off, which means every row.
      .iterate(cutoff ?? 0) as Iterable<{ failed: number; command: string | null }>;
    for (const row of rows) {
      if (!row.command) continue;
      // A command naming one tool twice is one call of it, not two.
      const seen = new Set(commandPositionNames(row.command));
      for (const name of seen) {
        const counted = counts.get(name);
        if (!counted) continue;
        if (row.failed) counted.failures += 1;
        else counted.calls += 1;
      }
    }
  }

  invocationCache.at = now;
  invocationCache.cutoff = cutoff;
  invocationCache.value = counts;
  return counts;
}

/* ------------------------------------------------------------------ */
/* Composing one word                                                  */
/* ------------------------------------------------------------------ */

/**
 * The worst reading wins, and a higher layer may never overwrite a lower one's
 * fault.
 *
 * `installed` is the only word that requires all four layers to agree, which is
 * the direction a page whose failure mode is false reassurance has to lean.
 * Three of the seven — `broken`, `failing`, `shadowed` — are states where the
 * install record says nothing is wrong.
 *
 * **`broken` is widened from `01f-read-back.md` §3 and the reason is that phase
 * 1 has no receipts.** There, `broken` is *"receipt `ok`, and a claimed binary
 * does not resolve"* and `failed` covers *"a declaration with no receipt"*.
 * Neither clause can fire for `UF_PY_TOOLS` or `UF_GH_EXTENSIONS`, which have
 * no applier and never will, so a tool declared and absent would fall through
 * the table it was meant to be caught by. It is `broken` here — declared, and
 * what it declares does not resolve — and `failed` stays strictly for an
 * install record that says so, because claiming the install failed is claiming
 * a cause nobody measured.
 */
export function composeState(readings: ToolReadings): ToolState {
  if (readings.install !== "ok" && readings.install !== "none") return "failed";
  if (readings.command === null) return "unknown";
  if (readings.resolvedAt === null) return "broken";
  if (readings.failures > 0) return "failing";
  if (!readings.insideItsOwnToolbox) return "shadowed";
  if (readings.calls === 0) return "unverified";
  return "installed";
}

/* ------------------------------------------------------------------ */
/* The report                                                          */
/* ------------------------------------------------------------------ */

/**
 * The sentence beside each badge.
 *
 * The server's, not the page's, for `SandboxRow`'s reason at
 * `settings/page.tsx:1752-1754`: *"a second copy written here is a second thing
 * to keep honest."* It says what was counted and never why a call failed — a
 * count cannot tell a missing binary from a tool that ran and did not like its
 * arguments, and a word that claims a cause sends somebody to fix the wrong
 * thing (`01e-operator-surface.md` §4).
 */
function detailFor(row: {
  state: ToolState;
  install: InstallRecord;
  source: ToolSource;
  command: string | null;
  resolvedAt: string | null;
  calls: number;
  failures: number;
  windowDays: number | null;
}): string {
  const over =
    row.windowDays === null ? "over all retained history" : `in the last ${row.windowDays} days`;
  const where = row.source === "gh-extension" ? "the gh extensions volume" : PY_TOOLS_BIN_DIR;
  switch (row.state) {
    case "unknown":
      return (
        "This entry is a checkout installed editable, so the command it provides is named in " +
        "the project's own metadata rather than in the line. Nothing here can check it."
      );
    case "failed":
      // Two different facts, and an operator acts on them differently: nothing
      // by that name was installed at all, against something installed that is
      // not runnable. Neither names a cause — a count and a directory listing
      // cannot tell a refused credential from a network that was down.
      return row.install === "missing"
        ? `Declared, and nothing by that name is installed in ${where}.`
        : `Installed into ${where} and not runnable from there.`;
    case "broken":
      return (
        `Declared, and \`${row.command}\` does not resolve. Nothing an agent types will find ` +
        `it; the boot log for this container is where the install said why.`
      );
    case "failing":
      return `${row.calls} calls ${over}, ${row.failures} of which came back an error. What went wrong is in those runs, not here.`;
    case "shadowed":
      return `Resolves to ${row.resolvedAt}, which is outside ${where} — an agent gets that copy and not the one this entry installed.`;
    case "unverified":
      return `Resolves at ${row.resolvedAt}. Nothing has invoked it ${over}, so nothing here has seen it work.`;
    case "installed":
      return `Resolves at ${row.resolvedAt}. ${row.calls} calls ${over}, none of which came back an error.`;
  }
}

/**
 * Everything the Tools section draws, read fresh.
 *
 * The first three layers are uncached on purpose: a handful of small file reads
 * and about ten `lstat`s, on a page that already does more than that, against
 * staleness on the one surface whose whole job is saying what is true now. Only
 * the fourth is cached, and `invocationCounts` carries that argument.
 */
export function toolInventory(
  now = Date.now(),
  { countInvocations = true }: { countInvocations?: boolean } = {},
): ToolInventory {
  const problems: string[] = [];
  const windowDays = getSettings().eventRetentionDays;
  const pathValue = process.env.PATH ?? "";

  const declared = [
    ...parseToolList(process.env.UF_PY_TOOLS ?? "", "python"),
    ...parseToolList(process.env.UF_GH_EXTENSIONS ?? "", "gh-extension"),
  ];

  const gh = readGhExtensions();
  if (gh.problem) problems.push(gh.problem);
  const byRepoName = new Map(gh.extensions.map((ext) => [ext.repoName, ext]));

  // Only names this install actually declared reach the scan. The set bounds
  // what the query can be asked, and an install that declares nothing pays for
  // no query at all.
  const commandNames = declared
    .map((tool) => tool.command)
    .filter((command): command is string => command !== null)
    .map((command) => (command.startsWith("gh ") ? "gh" : command));
  // `/api/status` is polled by a monitor, and the observed layer is a full
  // scan of the busiest table in the schema on a synchronous driver. It is also
  // the one layer that payload does not need: `notOk` counts `failed` and
  // `broken`, and `composeState` reaches both before it ever looks at a count.
  // So the scan is the page's cost and never the monitor's.
  const counts = countInvocations
    ? invocationCounts(commandNames, now)
    : new Map<string, InvocationCounts>();

  const rows: ToolRow[] = [];
  const claimedGh = new Set<string>();
  const claimedPy = new Set<string>();

  for (const tool of declared) {
    let resolvedAt: string | null = null;
    let insideItsOwnToolbox = true;
    let install: InstallRecord = "none";
    let installedPin: string | null = null;

    if (tool.source === "python") {
      if (tool.command) {
        claimedPy.add(tool.command);
        resolvedAt = resolveOnPath(tool.command, pathValue, isExecutableFile);
        insideItsOwnToolbox =
          resolvedAt === null || resolvedAt.startsWith(`${PY_TOOLS_BIN_DIR}/`);
      }
    } else {
      // The join is the directory name against the repository's name, which gh
      // makes equal. No derivation, so no guess to be wrong about.
      const repoName = tool.spec.replace(/@[^@]*$/, "");
      const shortName = repoName.slice(repoName.lastIndexOf("/") + 1);
      claimedGh.add(shortName);
      const installed = byRepoName.get(shortName);
      if (installed) {
        resolvedAt = installed.binPath;
        installedPin = installed.tag;
        // A pinned entry whose pin has moved is deliberately not reinstalled
        // (`.env.example:227-229`), so the two tags disagreeing is a fact about
        // this install rather than a fault, and the page says it rather than
        // resolving it.
        if (installed.binPath === null) install = "failed";
      } else if (tool.command) {
        // gh refuses every API call with no credential, so an install with a
        // list and no token installed none of them — `docker-entrypoint.sh:176`
        // says so at boot and this is the same fact after the restart.
        install = "missing";
      }
    }

    const state = composeState({
      install,
      resolvedAt,
      insideItsOwnToolbox,
      command: tool.command,
      calls: counts.get(ghKey(tool))?.calls ?? 0,
      failures: counts.get(ghKey(tool))?.failures ?? 0,
    });

    rows.push({
      source: tool.source,
      spec: tool.spec,
      command: tool.command,
      pin: tool.pin,
      installedPin,
      state,
      resolvedAt,
      calls: counts.get(ghKey(tool))?.calls ?? 0,
      failures: counts.get(ghKey(tool))?.failures ?? 0,
      detail: detailFor({
        state,
        install,
        source: tool.source,
        command: tool.command,
        resolvedAt,
        calls: counts.get(ghKey(tool))?.calls ?? 0,
        failures: counts.get(ghKey(tool))?.failures ?? 0,
        windowDays,
      }),
    });
  }

  const unclaimed = [
    ...ghUnclaimed(gh.extensions, claimedGh),
    ...pyUnclaimed(claimedPy, problems),
  ];

  return { rows, unclaimed, observedWindowDays: windowDays, problems };
}

/**
 * Which counted name a row reads.
 *
 * Every gh extension is invoked as `gh <command>`, so the binary an operator
 * would see called is `gh` and not the extension. The count is therefore
 * `gh`'s for all of them, which over-reports a single extension's own use and
 * is the honest reading available: nothing in `run_events` separates
 * `gh pr list` from `gh layer10 issues` at the level this counts.
 */
function ghKey(tool: DeclaredTool): string {
  if (tool.source === "gh-extension") return "gh";
  return tool.command ?? "";
}

function ghUnclaimed(installed: InstalledGhExtension[], claimed: Set<string>): string[] {
  return installed
    .filter((ext) => !claimed.has(ext.repoName))
    .map((ext) => `gh ${ext.repoName.replace(/^gh-/, "")}`);
}

/**
 * What is in uv's launcher directory that no entry claims.
 *
 * Over-reports by construction, and the direction is the safe one: a package
 * whose console script differs from its name leaves the script here rather than
 * leaving a declared tool unaccounted for. The alternative — resolving the
 * package's own entry points — means reading its metadata out of the volume,
 * which is a second parser over a third party's file for a row that is already
 * only a prompt to go and look.
 */
function pyUnclaimed(claimed: Set<string>, problems: string[]): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(PY_TOOLS_BIN_DIR);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    problems.push(
      `The Python tool directory ${PY_TOOLS_BIN_DIR} could not be read (${code ?? "unknown error"}).`,
    );
    return [];
  }
  return names.filter((name) => !claimed.has(name)).sort();
}

/**
 * The two integers `/api/status` carries, on `status.ts:23-28`'s closed rule:
 * counts only, never a tool's name, its version or the path it resolved to.
 *
 * `notOk` is the number of declared entries whose composed state is drawn in a
 * danger tone — `failed` and `broken`, and deliberately not the two warn states
 * — so phase 2 widens the declaration set with stacks and adds nothing to the
 * definition a monitor already thresholds.
 */
export function toolCounts(now = Date.now()): { declared: number; notOk: number } {
  const inventory = toolInventory(now, { countInvocations: false });
  return {
    declared: inventory.rows.length,
    notOk: inventory.rows.filter((row) => row.state === "failed" || row.state === "broken").length,
  };
}
