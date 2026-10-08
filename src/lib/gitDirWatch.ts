import { createHash } from "node:crypto";
import type {
  GitDirChangeDTO,
  GitDirCommandClassDTO,
  GitDirDTO,
  GitDirFindingDTO,
  GitDirReportDTO,
} from "./apiTypes";

/**
 * What a run left in its repository's git directory that the operator's own
 * git will run, read at the run's start and again at its end.
 *
 * A work cycle writes the operator's real `<repo>/.git` as the bind mount's
 * owner, and every worktree of a repository shares it. So it can plant a
 * `core.fsmonitor`, a `core.hooksPath`, an executable in `.git/hooks`, or a
 * filter or diff driver named from `.git/info/attributes`, and the operator's
 * next `git status` on the host runs it as them. None of that is in a branch, a
 * diff or anything Land shows (`docs/security.md`, "Your own git").
 *
 * This module is the comparison, and it compares a **list of keys that run
 * commands**, never the whole file: this app's own git writes `.git/config`
 * legitimately — `branch.<name>.*`, remotes, worktree bookkeeping,
 * `extensions.worktreeConfig` — and a warning that fires on every run is one
 * nobody reads. The list starts from `CHAT_GIT_CONFIG` in `chat.ts`, which is
 * what was measured running from a planted `.git/config`, and adds what runs
 * at the operator's terminal rather than in a chat turn: a pager, an editor,
 * an alias. `docs/agent/security/run-git-dir-watch.md` has the reasoning.
 */

/** Why a key is on the list: what the operator does that makes git run it. */
export type CommandClass = GitDirCommandClassDTO;

/** One value of a watched key, as git listed it. */
export interface WatchedConfigEntry {
  /** As `git config --list` prints it: section and variable lowercased. */
  key: string;
  /** Decided from the full value when it was read, since `shown` may be cut or withheld. */
  commandClass: CommandClass;
  /** `local` is the common `config` and every file it includes; `worktree` is `config.worktree`. */
  scope: "local" | "worktree";
  /** The file git read it from. */
  origin: string;
  /** Compared rather than the value, so a credential helper's value need not be kept. */
  digest: string;
  /** The value cut to `SHOWN_CHARS`, or null where it may carry a secret. */
  shown: string | null;
}

/** One entry of `<common>/hooks` that is not a `.sample`, or `"."` for the directory itself. */
export interface HookEntry {
  name: string;
  /** `file:<sha256>`, `large:<size>:<mtime>`, `symlink:<target>`, `dir` or `other`. */
  identity: string;
  executable: boolean;
}

export interface AttributesFile {
  digest: string;
  /** The lines that assign a `filter`, `diff` or `merge` driver, for showing. */
  driverLines: string[];
}

export interface GitDirSnapshot {
  config: WatchedConfigEntry[];
  hooks: HookEntry[];
  /** null when `info/attributes` does not exist. */
  attributes: AttributesFile | null;
}

/**
 * What the run's start recorded. A failed read is kept as one, because a
 * baseline that was not taken must never compare as "nothing changed".
 * `commonDir` is the real path the start resolved, and the end reads that path
 * rather than asking the checkout again: by then a work cycle has had every
 * chance to point the checkout's `.git` somewhere else.
 */
export type GitDirBaseline =
  | { ok: true; takenAt: number; commonDir: string; snapshot: GitDirSnapshot }
  | { ok: false; takenAt: number; commonDir: string | null; reason: string };

/** The end's reading of the same directory. */
export type GitDirReading = { ok: true; snapshot: GitDirSnapshot } | { ok: false; reason: string };

export type GitDirChange = GitDirChangeDTO;
export type GitDirFinding = GitDirFindingDTO;
export type GitDirReport = GitDirReportDTO;

/** Long enough to read a planted command, short enough that a pasted script is not stored whole. */
export const SHOWN_CHARS = 200;
/** Of the attributes lines kept for showing. The digest still covers the whole file. */
export const MAX_DRIVER_LINES = 20;

function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isExtUrl(value: string | null): boolean {
  return value !== null && value.trim().toLowerCase().startsWith("ext::");
}

/**
 * The class of command a configuration key runs, or null when it runs none.
 *
 * Section and variable compare case-insensitively and the subsection exactly,
 * as git does; the subsection is everything between the first and last dot,
 * because a driver or URL name may itself contain dots. Three keys run a
 * command only for some values — a remote URL or `insteadOf` base of the
 * `ext::` transport, and a submodule `update` starting with `!` — and the rest
 * are on the list whatever they hold.
 */
export function commandClassOf(key: string, value: string | null): CommandClass | null {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first <= 0 || last === key.length - 1) return null;
  const section = key.slice(0, first).toLowerCase();
  const variable = key.slice(last + 1).toLowerCase();
  const subsection = first === last ? null : key.slice(first + 1, last);

  switch (section) {
    case "core":
      if (subsection !== null) return null;
      if (variable === "fsmonitor") return "fsmonitor";
      if (variable === "hookspath") return "hooks-path";
      if (["sshcommand", "askpass", "gitproxy", "alternaterefscommand"].includes(variable)) {
        return "remote";
      }
      if (variable === "pager" || variable === "editor") return "interactive";
      return null;
    case "diff":
      if (subsection === null) return variable === "external" ? "external-diff" : null;
      return variable === "textconv" || variable === "command" ? "attribute-driver" : null;
    case "filter":
      return subsection !== null && ["clean", "smudge", "process"].includes(variable)
        ? "attribute-driver"
        : null;
    case "merge":
      return subsection !== null && variable === "driver" ? "attribute-driver" : null;
    case "credential":
      return variable === "helper" ? "remote" : null;
    case "remote":
      if (subsection === null) return null;
      if (["uploadpack", "receivepack", "vcs"].includes(variable)) return "remote";
      return (variable === "url" || variable === "pushurl") && isExtUrl(value) ? "remote" : null;
    case "url":
      return subsection !== null &&
        isExtUrl(subsection) &&
        (variable === "insteadof" || variable === "pushinsteadof")
        ? "remote"
        : null;
    case "protocol":
      // Not a command itself: it is what lets an `ext::` URL be one.
      return variable === "allow" ? "remote" : null;
    case "submodule":
      return subsection !== null && variable === "update" && value?.trimStart().startsWith("!")
        ? "remote"
        : null;
    case "gpg":
      if (variable === "program") return "signing";
      return subsection === "ssh" && variable === "defaultkeycommand" ? "signing" : null;
    case "pager":
      return subsection === null ? "interactive" : null;
    case "sequence":
      return subsection === null && variable === "editor" ? "interactive" : null;
    case "interactive":
      return subsection === null && variable === "difffilter" ? "interactive" : null;
    case "difftool":
    case "mergetool":
    case "browser":
    case "man":
      return subsection !== null && variable === "cmd" ? "interactive" : null;
    case "alias":
      return "alias";
    case "include":
      return subsection === null && variable === "path" ? "include" : null;
    case "includeif":
      return subsection !== null && variable === "path" ? "include" : null;
    default:
      return null;
  }
}

/** A credential helper is the one command whose text routinely carries a token. */
function mayCarrySecret(key: string): boolean {
  return key.toLowerCase().startsWith("credential.");
}

/**
 * The watched entries of `git config --list --show-scope --show-origin -z`.
 *
 * Records are NUL-separated triples — scope, origin, then key and value split
 * by a newline, or the key alone for a bare boolean. Only `local` and
 * `worktree` are kept: system and global are not the repository's, and
 * `command` is this app's own `-c` flags.
 */
export function watchedConfigOf(listing: string): WatchedConfigEntry[] {
  const fields = listing.split("\0");
  const out: WatchedConfigEntry[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const scope = fields[i];
    if (scope !== "local" && scope !== "worktree") continue;
    const origin = fields[i + 1].replace(/^file:/, "");
    const record = fields[i + 2];
    const newline = record.indexOf("\n");
    const key = newline < 0 ? record : record.slice(0, newline);
    const value = newline < 0 ? null : record.slice(newline + 1);
    const commandClass = commandClassOf(key, value);
    if (commandClass === null) continue;
    out.push({
      key,
      commandClass,
      scope,
      origin,
      digest: digestOf(value === null ? "\0bare" : `=${value}`),
      shown: value === null || mayCarrySecret(key) ? null : value.slice(0, SHOWN_CHARS),
    });
  }
  return out;
}

/** `info/attributes` as the snapshot keeps it: a digest, and the driver lines for showing. */
export function attributesFileOf(text: string): AttributesFile {
  const driverLines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && /(^|\s)(filter|diff|merge)=/.test(line))
    .slice(0, MAX_DRIVER_LINES)
    .map((line) => line.slice(0, SHOWN_CHARS));
  return { digest: digestOf(text), driverLines };
}

function changeOf(before: boolean, after: boolean): GitDirChange {
  return before ? (after ? "changed" : "removed") : "added";
}

function configFindings(
  before: WatchedConfigEntry[],
  after: WatchedConfigEntry[],
): GitDirFinding[] {
  const byKey = (entries: WatchedConfigEntry[]) => {
    const map = new Map<string, WatchedConfigEntry[]>();
    for (const entry of entries) map.set(entry.key, [...(map.get(entry.key) ?? []), entry]);
    return map;
  };
  const was = byKey(before);
  const now = byKey(after);
  const findings: GitDirFinding[] = [];
  for (const key of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const old = was.get(key) ?? [];
    const cur = now.get(key) ?? [];
    // Order is compared too: for a single-valued key the last one wins, so
    // swapping two values changes which command runs.
    const same =
      old.length === cur.length && old.every((entry, i) => entry.digest === cur[i].digest);
    if (same) continue;
    findings.push({
      kind: "config",
      // Both sides were watched, so either can say why; the end's reading is
      // the one the operator is about to run.
      commandClass: (cur[0] ?? old[0]).commandClass,
      key,
      change: changeOf(old.length > 0, cur.length > 0),
      now: cur.map(({ scope, origin, shown }) => ({ scope, origin, shown })),
    });
  }
  return findings;
}

function hookFindings(before: HookEntry[], after: HookEntry[]): GitDirFinding[] {
  const was = new Map(before.map((hook) => [hook.name, hook]));
  const now = new Map(after.map((hook) => [hook.name, hook]));
  const findings: GitDirFinding[] = [];
  for (const name of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const old = was.get(name);
    const cur = now.get(name);
    if (old && cur && old.identity === cur.identity && old.executable === cur.executable) continue;
    findings.push({
      kind: "hook",
      name,
      change: changeOf(old !== undefined, cur !== undefined),
      executable: cur?.executable ?? false,
    });
  }
  return findings;
}

function attributesFindings(
  before: AttributesFile | null,
  after: AttributesFile | null,
): GitDirFinding[] {
  if (before?.digest === after?.digest) return [];
  return [
    {
      kind: "attributes",
      change: changeOf(before !== null, after !== null),
      driverLines: after?.driverLines ?? [],
    },
  ];
}

/**
 * Two snapshots of one repository's git directory, as the run page reports
 * them.
 *
 * Pure, and the whole of what decides a warning: a missing finding is a
 * planted command the operator is never told about, and a spurious one is a
 * warning on every run that teaches them to skip it. A baseline that failed
 * is reported as unreadable rather than as unchanged, because "nothing
 * changed" is a claim this app can only make about something it read twice.
 */
export function compareGitDir(
  baseline: GitDirBaseline,
  after: GitDirReading,
  concurrentRunIds: string[],
  checkedAt: number,
): GitDirReport {
  if (!baseline.ok) {
    return {
      state: "unreadable",
      commonDir: baseline.commonDir,
      reason: `At the run's start: ${baseline.reason}`,
      checkedAt,
    };
  }
  if (!after.ok) {
    return {
      state: "unreadable",
      commonDir: baseline.commonDir,
      reason: `At the run's end: ${after.reason}`,
      checkedAt,
    };
  }
  const was = baseline.snapshot;
  const now = after.snapshot;
  const findings = [
    ...configFindings(was.config, now.config),
    ...hookFindings(was.hooks, now.hooks),
    ...attributesFindings(was.attributes, now.attributes),
  ];
  const since = baseline.takenAt;
  if (findings.length === 0) {
    return { state: "unchanged", commonDir: baseline.commonDir, since, checkedAt };
  }
  return {
    state: "changed",
    commonDir: baseline.commonDir,
    since,
    checkedAt,
    findings,
    concurrentRunIds: [...concurrentRunIds].sort(),
  };
}

/**
 * The two columns as the run page is sent them: parsed, and the baseline
 * reduced to when and where it was read. The baseline itself stays on the
 * server, since it is only ever compared against.
 */
export function gitDirOf(row: {
  git_dir_baseline: string | null;
  git_dir_report: string | null;
}): GitDirDTO | null {
  if (row.git_dir_baseline === null) return null;
  // Both columns are written by `gitDirRead.ts` alone, from these types.
  const baseline = JSON.parse(row.git_dir_baseline) as GitDirBaseline;
  return {
    since: baseline.takenAt,
    commonDir: baseline.commonDir,
    report: row.git_dir_report === null ? null : (JSON.parse(row.git_dir_report) as GitDirReport),
  };
}
