import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_MOUNTS } from "./config";
import { db } from "./db";
import { git } from "./git";
import { HOOKS_PATH_PREFIX } from "./apiTypes";
import {
  attributesFileOf,
  compareGitDir,
  hooksPathOf,
  watchedConfigOf,
  type AttributesFile,
  type GitDirBaseline,
  type GitDirReading,
  type GitDirReport,
  type HookEntry,
  SHOWN_CHARS,
} from "./gitDirWatch";

/**
 * The disk and database half of `gitDirWatch.ts`: reading a run's repository
 * git directory at its start and end, and keeping both on the run's row.
 *
 * Reading must run nothing the repository chose. Configuration is read with
 * `git config --list`, which was measured running no `core.fsmonitor`, hook or
 * filter (`docs/verification/git-and-review.md`), through `git()`, which
 * carries `gitArgs`' cleared `core.fsmonitor` and `core.hooksPath` anyway. Hooks
 * and `info/attributes` are read as files, never through git, opened without
 * following a symlink and without blocking on a FIFO: this server reads them as
 * root, and both are a work cycle's to replace with anything.
 */

/** Past this a file is identified by size and mtime rather than read. */
const MAX_HASHED_BYTES = 1 << 20;
/** Of one hooks directory's entries read; a directory holding more says so as one entry. */
const MAX_HOOK_ENTRIES = 256;
/**
 * Each git call here is a read of a few small files. `include.path` can name a
 * FIFO, and `git config` would wait on it for ever; the start's read is also
 * all that stands between a run and its first cycle.
 */
const GIT_READ_TIMEOUT_MS = 10_000;

function within(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.lstat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether git's own discovery could find a repository from `dir`: a `.git`
 * in it or any directory above it. Asked before any git is spawned, so a run
 * in a plain folder starts its first cycle without one.
 */
async function insideAnyRepository(dir: string): Promise<boolean> {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (await exists(path.join(current, ".git"))) return true;
    if (path.dirname(current) === current) return false;
  }
}

async function insideAMount(real: string): Promise<boolean> {
  const roots = await Promise.all(
    WORKSPACE_MOUNTS.map((mount) => fs.promises.realpath(mount.path).catch(() => null)),
  );
  return roots.some((root) => root !== null && within(root, real));
}

/**
 * The repository's common git directory, as a real path inside a configured
 * mount.
 *
 * Containment is checked because the answer comes from the checkout's `.git`,
 * which a work cycle in an in-place run writes: a `gitdir:` line pointing at
 * this app's data directory would otherwise have the server, as root, list and
 * hash whatever is there.
 */
async function resolveCommonDir(
  cwd: string,
): Promise<
  { ok: true; commonDir: string } | { ok: false; commonDir: string | null; reason: string } | null
> {
  if (!(await insideAnyRepository(cwd))) return null;
  const asked = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    timeoutMs: GIT_READ_TIMEOUT_MS,
  });
  if (!asked.ok) {
    // Not a repository is the one failure that is not a failure: such a run
    // has no `.git` of the operator's to plant anything in.
    if (/not a git repository/i.test(asked.stderr)) return null;
    return {
      ok: false,
      commonDir: null,
      reason: `git could not name the repository's git directory: ${asked.stderr || "no output"}`,
    };
  }
  let real: string;
  try {
    real = await fs.promises.realpath(asked.stdout);
  } catch (err) {
    return {
      ok: false,
      commonDir: asked.stdout,
      reason: `${asked.stdout} could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!(await insideAMount(real))) {
    return {
      ok: false,
      commonDir: real,
      reason: `The repository's git directory resolves to ${real}, outside every configured folder, so this app does not read it.`,
    };
  }
  return { ok: true, commonDir: real };
}

async function executableTarget(file: string): Promise<boolean> {
  try {
    const target = await fs.promises.stat(file);
    return target.isFile() && (target.mode & 0o111) !== 0;
  } catch {
    // A dangling link runs nothing.
    return false;
  }
}

/**
 * One file's identity without following a symlink or waiting on a FIFO, and
 * its text when it is a regular file small enough to read.
 */
async function identify(
  file: string,
): Promise<{ identity: string; executable: boolean; text: string | null } | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") {
      return {
        identity: `symlink:${await fs.promises.readlink(file)}`,
        // git follows a symlinked hook, so whether it runs is the target's
        // mode. A `stat` reads the mode and opens nothing.
        executable: await executableTarget(file),
        text: null,
      };
    }
    // A socket cannot be opened at all; it is still something that is there.
    if (code === "ENXIO") return { identity: "other", executable: false, text: null };
    throw err;
  }
  try {
    const stat = await handle.stat();
    // A directory's search bit is not one git can run.
    const executable = stat.isFile() && (stat.mode & 0o111) !== 0;
    if (stat.isDirectory()) return { identity: "dir", executable, text: null };
    if (!stat.isFile()) return { identity: "other", executable, text: null };
    if (stat.size > MAX_HASHED_BYTES) {
      return { identity: `large:${stat.size}:${stat.mtimeMs}`, executable, text: null };
    }
    const bytes = await handle.readFile();
    return {
      identity: `file:${createHash("sha256").update(bytes).digest("hex")}`,
      executable,
      text: bytes.toString("utf8"),
    };
  } finally {
    await handle.close();
  }
}

/** The entries of a directory git runs hooks from, each name after `prefix`. */
async function readHookDir(dir: string, prefix: string): Promise<HookEntry[]> {
  const self = await fs.promises.lstat(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (self === null) return [];
  // git follows a symlinked hooks directory, so its target is what would run;
  // it is reported as the one entry rather than listed through.
  if (self.isSymbolicLink()) {
    return [
      {
        name: `${prefix}.`,
        identity: `symlink:${await fs.promises.readlink(dir)}`,
        executable: false,
      },
    ];
  }
  if (!self.isDirectory()) return [{ name: `${prefix}.`, identity: "other", executable: false }];
  const names = (await fs.promises.readdir(dir)).filter((name) => !name.endsWith(".sample")).sort();
  const listed = names.slice(0, MAX_HOOK_ENTRIES);
  const hooks = await Promise.all(
    listed.map(async (name) => {
      const found = await identify(path.join(dir, name));
      return found
        ? { name: `${prefix}${name}`, identity: found.identity, executable: found.executable }
        : null;
    }),
  );
  const present = hooks.filter((hook): hook is HookEntry => hook !== null);
  if (names.length > listed.length) {
    present.push({ name: `${prefix}…`, identity: `more:${names.length}`, executable: false });
  }
  return present;
}

/**
 * Where a path really is, or, when nothing is there, whether that absence is
 * also the host's.
 *
 * A path inside a mount is the same directory on both sides, so nothing there
 * means no hook runs from it. Anywhere else the container's view is not the
 * host's: a host path such as `/Users/…` is simply missing here, and so is the
 * target of a symlink into one. Walked up by dropping the last component
 * rather than normalised, because `..` after a symlink is resolved by the
 * kernel from the link's target, not lexically.
 */
async function locate(
  candidate: string,
): Promise<
  | { state: "found"; real: string }
  | { state: "missing"; nearest: string }
  | { state: "dangling"; link: string; target: string }
> {
  for (let current = candidate; ; current = path.dirname(current)) {
    try {
      const real = await fs.promises.realpath(current);
      return current === candidate ? { state: "found", real } : { state: "missing", nearest: real };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    }
    const self = await fs.promises.lstat(current).catch(() => null);
    if (self?.isSymbolicLink()) {
      return { state: "dangling", link: current, target: await fs.promises.readlink(current) };
    }
  }
}

/**
 * The directory the repository's own `core.hooksPath` names, which is where
 * git runs the main checkout's hooks from instead of `<common>/hooks`: husky
 * sets `.husky/_`, a gitignored directory a work cycle can write in the
 * operator's checkout without a line of it in the branch.
 *
 * Resolved as git does for the main checkout: relative to its work tree,
 * which for a non-bare repository is the common directory's parent. What
 * cannot be placed from the container — a path git expands against the
 * host's home or install prefix, or one whose base this app cannot tell — and
 * a directory outside every mount, which this server would be reading as
 * root, come back as the reason they were not read.
 */
async function readHooksPath(
  commonDir: string,
  configured: string | null,
): Promise<{ hooks: HookEntry[]; unread: string | null }> {
  // `/dev/null` is the usual way to turn hooks off, and is no directory on
  // either side.
  if (configured === null || configured === "/dev/null") return { hooks: [], unread: null };
  const shown = configured.slice(0, SHOWN_CHARS);
  const unread = (why: string) => ({
    hooks: [],
    unread: `core.hooksPath is ${shown}, ${why}, so the hooks there were not compared.`,
  });
  if (configured === "") return unread("which names no directory this app can read");
  if (/^(~|%\(prefix\)\/)/.test(configured)) {
    return unread("which git expands against your host's home or its install, not the container's");
  }
  let candidate = configured;
  if (!path.isAbsolute(configured)) {
    if (path.basename(commonDir) !== ".git") {
      return unread(
        `a relative path, and ${commonDir} is not a checkout's .git, so this app cannot tell what it is relative to`,
      );
    }
    candidate = `${path.dirname(commonDir)}/${configured}`;
  }
  const located = await locate(candidate);
  if (located.state === "dangling") {
    return unread(
      `and ${located.link} on the way there is a symlink to ${located.target}, which the container does not have`,
    );
  }
  const real = located.state === "found" ? located.real : located.nearest;
  if (!(await insideAMount(real))) {
    return unread(`which resolves to ${real}, outside every configured folder`);
  }
  if (located.state === "missing") return { hooks: [], unread: null };
  return { hooks: await readHookDir(real, `${HOOKS_PATH_PREFIX}${real}/`), unread: null };
}

/**
 * `info/attributes`, read without following `info` either: a symlinked `info`
 * would otherwise have this server read a file named `attributes` wherever it
 * pointed.
 */
async function readAttributes(commonDir: string): Promise<AttributesFile | null> {
  const info = path.join(commonDir, "info");
  const dir = await fs.promises.lstat(info).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (dir === null) return null;
  if (dir.isSymbolicLink()) {
    return { digest: `symlinked-info:${await fs.promises.readlink(info)}`, driverLines: [] };
  }
  const file = await identify(path.join(info, "attributes"));
  if (file === null) return null;
  return file.text === null
    ? { digest: file.identity, driverLines: [] }
    : attributesFileOf(file.text);
}

/**
 * Run from inside the git directory with it named explicitly, so the reading
 * needs neither checkout to exist any more and is the main checkout's view:
 * `config.worktree` here is the common one the operator's own checkout reads,
 * not the run's linked worktree's.
 */
async function readSnapshot(commonDir: string): Promise<GitDirReading> {
  const listing = await git(
    commonDir,
    [
      `--git-dir=${commonDir}`,
      "config",
      "--list",
      "--show-scope",
      "--show-origin",
      "-z",
      "--includes",
    ],
    { timeoutMs: GIT_READ_TIMEOUT_MS, trim: false },
  );
  // Never empty when it worked: `gitArgs`' own `-c` pairs are listed too, under
  // the `command` scope `watchedConfigOf` drops.
  if (!listing.ok) {
    return {
      ok: false,
      reason: `git config could not list ${commonDir}/config: ${listing.stderr || `exit ${listing.code}`}`,
    };
  }
  try {
    const [hooks, hooksPath, attributes] = await Promise.all([
      readHookDir(path.join(commonDir, "hooks"), ""),
      readHooksPath(commonDir, hooksPathOf(listing.stdout)),
      readAttributes(commonDir),
    ]);
    return {
      ok: true,
      snapshot: {
        config: watchedConfigOf(listing.stdout),
        hooks: [...hooks, ...hooksPath.hooks],
        attributes,
        hooksPathUnread: hooksPath.unread,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: `${commonDir} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function baselineOf(runId: string): GitDirBaseline | null {
  const row = db().prepare("SELECT git_dir_baseline FROM runs WHERE id = ?").get(runId) as
    { git_dir_baseline: string | null } | undefined;
  // Written by `recordGitDirBaseline` alone, from this type.
  return row?.git_dir_baseline ? (JSON.parse(row.git_dir_baseline) as GitDirBaseline) : null;
}

/**
 * What a run's start keeps: the repository's git directory as `cwd` finds it,
 * or why it could not be read. Null for a folder that is not in a repository.
 */
export async function readGitDirBaseline(
  cwd: string,
  takenAt: number,
): Promise<GitDirBaseline | null> {
  const resolved = await resolveCommonDir(cwd);
  if (resolved === null) return null;
  if (!resolved.ok) {
    return { ok: false, takenAt, commonDir: resolved.commonDir, reason: resolved.reason };
  }
  const reading = await readSnapshot(resolved.commonDir);
  return reading.ok
    ? { ok: true, takenAt, commonDir: resolved.commonDir, snapshot: reading.snapshot }
    : { ok: false, takenAt, commonDir: resolved.commonDir, reason: reading.reason };
}

/**
 * The end's reading of the directory the start resolved, rather than of
 * whatever the checkout names now, and refused when its real path has moved:
 * a work cycle can repoint the checkout's `.git`, or swap the directory for a
 * symlink, and the answer would then be about somewhere else.
 */
export async function readGitDirAgain(baseline: GitDirBaseline): Promise<GitDirReading> {
  if (!baseline.ok) return { ok: false, reason: baseline.reason };
  const real = await fs.promises.realpath(baseline.commonDir).catch(() => null);
  if (real === null) return { ok: false, reason: `${baseline.commonDir} is gone.` };
  if (real !== baseline.commonDir) {
    return {
      ok: false,
      reason: `${baseline.commonDir} now resolves to ${real}, so it is no longer the directory the run's start read.`,
    };
  }
  return readSnapshot(baseline.commonDir);
}

/**
 * Keep the run's baseline, once per run.
 *
 * Once rather than per segment: a resumed or reopened run compares against
 * the state before it first worked, so what it changed before a park or a
 * reopen is still in the comparison at its end. A failed read is stored as
 * one, so the end reports the run as unreadable rather than unchanged.
 */
export async function recordGitDirBaseline(runId: string, cwd: string): Promise<void> {
  if (baselineOf(runId) !== null) return;
  const baseline = await readGitDirBaseline(cwd, Date.now());
  if (baseline === null) return;
  db()
    .prepare("UPDATE runs SET git_dir_baseline = ? WHERE id = ? AND git_dir_baseline IS NULL")
    .run(JSON.stringify(baseline), runId);
}

/**
 * Every other run whose baseline names the same git directory and whose time
 * in it overlaps `[since, until]`.
 *
 * From the other run's baseline rather than its `started_at`, which a reopen
 * clears: the baseline is taken once, before the run's first cycle, so it is
 * the earliest the run can have written anything. A run not finished counts
 * as still in there.
 */
function concurrentRuns(runId: string, commonDir: string, since: number, until: number): string[] {
  const rows = db()
    .prepare(
      `SELECT id FROM runs
        WHERE id <> ?
          AND git_dir_baseline IS NOT NULL
          AND json_extract(git_dir_baseline, '$.commonDir') = ?
          AND json_extract(git_dir_baseline, '$.takenAt') <= ?
          AND (finished_at IS NULL OR finished_at >= ?)`,
    )
    .all(runId, commonDir, until, since) as { id: string }[];
  return rows.map((row) => row.id);
}

/**
 * Compare the run's repository git directory against its baseline and keep
 * the report on the row. A run with no baseline has nothing to compare.
 */
export async function settleGitDirWatch(runId: string): Promise<GitDirReport | null> {
  const baseline = baselineOf(runId);
  if (baseline === null) return null;
  const reading = await readGitDirAgain(baseline);
  const checkedAt = Date.now();
  const concurrent =
    baseline.commonDir === null
      ? []
      : concurrentRuns(runId, baseline.commonDir, baseline.takenAt, checkedAt);
  const report = compareGitDir(baseline, reading, concurrent, checkedAt);
  db()
    .prepare("UPDATE runs SET git_dir_report = ? WHERE id = ?")
    .run(JSON.stringify(report), runId);
  return report;
}
