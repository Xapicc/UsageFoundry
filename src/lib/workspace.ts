import fs from "node:fs/promises";
import path from "node:path";
import { WORKSPACE_MOUNTS, type WorkspaceMount } from "./config";
import { activeRuns, conflictKey, overlaps, workDirOf } from "./orchestrator";
import { git } from "./git";
import type { WorkspaceFolderDTO, WorkspaceMountDTO } from "./apiTypes";

/**
 * What the folder picker sees: every mount, every candidate project folder in
 * it, and who is already working there.
 *
 * Extracted from `/api/folders` when the orchestrator chat needed the same
 * answer through a tool call. It is the same walk with the same caps, so the
 * chat and the picker cannot disagree about what exists or what is busy —
 * which matters more here than it looks: the chat proposes runs against these
 * paths, and a second implementation that drifted would propose folders the
 * form would then refuse.
 */

/**
 * Per-mount cap on listed folders. A mount pointed at a large tree would
 * otherwise turn every page load into a full walk and a megabyte of JSON; the
 * response says when it truncated rather than silently showing a partial list.
 */
export const MAX_FOLDERS_PER_MOUNT = 400;

export interface WorkspaceScan {
  mounts: WorkspaceMountDTO[];
  folders: WorkspaceFolderDTO[];
}

/**
 * List candidate project folders in every configured workspace mount.
 *
 * Only descends two levels: deep enough to find `org/repo` layouts, shallow
 * enough that a large mount does not turn a page load into a full tree walk.
 */
export async function scanWorkspace(): Promise<WorkspaceScan> {
  const mounts: WorkspaceMountDTO[] = [];
  const folders: WorkspaceFolderDTO[] = [];

  // Occupancy is a pure string comparison against the live rows, so annotating
  // every folder costs one query rather than a syscall per candidate.
  const active = activeRuns();
  const activeKeys = active.map((r) => ({
    run: r,
    key: conflictKey(workDirOf(r)),
  }));

  function occupancy(abs: string) {
    const key = conflictKey(abs);
    const hits = activeKeys.filter((a) => overlaps(key, a.key));
    // Reported apart, because they mean different things to someone about to
    // start a run here. A running holder blocks: the new run queues behind it.
    // A parked one does not — it has yielded the folder and takes it back when
    // whatever runs next is finished — but it is still worth naming, since the
    // new run will find the tree changed under it when it resumes.
    const running = hits.find((h) => h.run.status === "running");
    const parked = hits.find((h) => h.run.status === "paused");
    return {
      busyRunId: running?.run.id ?? null,
      parkedRunId: parked?.run.id ?? null,
      queuedCount: hits.filter((h) => h.run.status === "queued").length,
    };
  }

  async function scan(
    mount: WorkspaceMount,
    dir: string,
    depth: number,
    count: { n: number },
  ) {
    if (count.n >= MAX_FOLDERS_PER_MOUNT) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count.n >= MAX_FOLDERS_PER_MOUNT) return;
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      if (e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      const isGitRepo = await fs
        .stat(path.join(full, ".git"))
        .then(() => true)
        .catch(() => false);

      // A bare repository has no `.git` entry, so the test above misses it and
      // the walk below would offer `objects/`, `refs/`, and `hooks/` as run
      // targets. Detect it and stop, without claiming it is a working tree.
      const isBareRepo =
        !isGitRepo &&
        (await Promise.all([
          fs.stat(path.join(full, "HEAD")).then(() => true).catch(() => false),
          fs.stat(path.join(full, "objects")).then(() => true).catch(() => false),
        ]).then(([head, objects]) => head && objects));

      folders.push({
        mountId: mount.id,
        path: path.relative(mount.path, full),
        name: e.name,
        isGitRepo,
        ...occupancy(full),
      });
      count.n += 1;

      // A repo is a leaf for our purposes — don't enumerate its subdirectories.
      if (!isGitRepo && !isBareRepo && depth < 2) {
        await scan(mount, full, depth + 1, count);
      }
    }
  }

  for (const mount of WORKSPACE_MOUNTS) {
    const count = { n: 0 };
    let available = true;
    let error: string | null = null;

    try {
      const st = await fs.stat(mount.path);
      if (!st.isDirectory()) {
        available = false;
        error = `${mount.path} is not a directory.`;
      }
    } catch {
      available = false;
      error = `Nothing is mounted at ${mount.path}.`;
    }

    if (available) await scan(mount, mount.path, 1, count);

    mounts.push({
      id: mount.id,
      label: mount.label,
      path: mount.path,
      available,
      error,
      folderCount: count.n,
      truncated: count.n >= MAX_FOLDERS_PER_MOUNT,
      // A run started on the mount root overlaps every folder beneath it, so
      // the root carries its own occupancy rather than inheriting a child's.
      ...(available
        ? occupancy(mount.path)
        : { busyRunId: null, parkedRunId: null, queuedCount: 0 }),
    });
  }

  folders.sort(
    (a, b) =>
      WORKSPACE_MOUNTS.findIndex((m) => m.id === a.mountId) -
        WORKSPACE_MOUNTS.findIndex((m) => m.id === b.mountId) ||
      a.path.localeCompare(b.path),
  );

  return { mounts, folders };
}

/**
 * How many repositories one request will read a remote for.
 *
 * Reading a remote is a git child per folder, so this is a spend of processes
 * rather than of bytes. The picker never pays it — only the chat does — but a
 * mount holding two hundred repositories would still fork two hundred times on
 * one tool call, so it is capped.
 *
 * It is a **page**, and that is the whole difference from what it was: the cap
 * used to be `slice(0, 25)` over the folders in scan order, so the same
 * twenty-five repositories won every time and the twenty-sixth could not be
 * named however many times it was asked for. A caller that wants the rest asks
 * by `offset`, or names the folders it cares about and pays a git child only
 * for those.
 */
export const MAX_REMOTES_READ = 25;

/** The name a folder is reported and asked for by, on every remote lookup. */
export function folderKey(folder: { mountId: string; path: string }): string {
  return `${folder.mountId}:${folder.path}`;
}

/** Which git repositories a remote lookup is being asked about. */
export interface RemoteQuery {
  /**
   * `folderKey`s to read, or null/undefined for every git repository in scan
   * order. A key naming no folder in the scan comes back in `unmatched` rather
   * than being dropped: a filter that quietly matched nothing produces exactly
   * the "no such repository" this whole page exists to stop reporting.
   */
  folders?: readonly string[] | null;
  /** Git repositories to skip, in scan order. */
  offset?: number;
}

/** What a lookup must say about the repositories it did not read. */
export interface RemoteRemainder {
  /** Git repositories the scan holds at all, before `folders` narrows it. */
  gitRepos: number;
  /** Git repositories `folders` matched — `gitRepos` when it named none. */
  matching: number;
  offset: number;
  /** Matched repositories this request does not read, before it and after it. */
  notRead: number;
  /** Asked-for keys naming no git repository in the scan. */
  unmatched: string[];
}

export interface RemoteSelection<T> extends RemoteRemainder {
  /** The repositories this request pays a git child for, in scan order. */
  read: T[];
}

/**
 * Which repositories this request reads a remote for, and what it must say
 * about the rest.
 *
 * Pure, and split out from the git work below for the reason
 * `selectBranchCandidates` is split from its own: the failure mode is silent
 * and it is not the failure it looks like. A repository dropped here is one the
 * caller renders with no `owner/name`, which is the same rendering as "this is
 * not a GitHub repository" — so an operator reads a working repository as a
 * broken one, and nothing throws, nothing is red, and the total that ought to
 * say so used to be a bare count of how many, never which.
 *
 * `gitRepos` is counted over the unfiltered scan for `selectBranchCandidates`'
 * reason: a filter that hides how much it excluded is a filter you cannot tell
 * you are inside.
 */
export function selectRemoteReads<
  T extends { mountId: string; path: string; isGitRepo: boolean },
>(folders: readonly T[], query: RemoteQuery = {}): RemoteSelection<T> {
  const candidates = folders.filter((f) => f.isGitRepo);

  const asked = query.folders?.length ? query.folders : null;
  const wanted = asked ? new Set(asked) : null;
  const matching = wanted
    ? candidates.filter((f) => wanted.has(folderKey(f)))
    : candidates;
  const present = new Set(candidates.map((f) => folderKey(f)));
  const unmatched = asked
    ? [...new Set(asked)].filter((key) => !present.has(key))
    : [];

  // Clamped rather than refused, as the branch inventory clamps its own: an
  // offset past the end is what asking for one page more than there is
  // produces, and an empty page beside an honest `matching` is a better answer
  // to that than an error a model has to interpret.
  const offset = Math.min(
    Math.max(0, Math.floor(Number(query.offset) || 0)),
    Math.max(0, matching.length - 1),
  );
  const read = matching.slice(offset, offset + MAX_REMOTES_READ);

  return {
    read,
    gitRepos: candidates.length,
    matching: matching.length,
    offset,
    notRead: matching.length - read.length,
    unmatched,
  };
}

export interface RemoteLookup extends RemoteRemainder {
  /** `folderKey` → `owner/name`, for the repositories whose remote resolved. */
  repos: Record<string, string>;
  /** The folders this request paid a git child for, resolved or not. */
  read: string[];
}

/**
 * `owner/name` for the git repositories a query names, as GitHub would name it.
 *
 * The chat needs this and nothing else about a repository: `gh issue list`
 * takes `--repo owner/name`, so supplying it saves the chat a shell round trip
 * per folder — and, more usefully, saves it *guessing*. It could run `git
 * remote` itself now that it runs without an allowlist; what it could not do is
 * be told when the answer is "this is not a GitHub repository".
 *
 * A remote that is not GitHub, or missing, yields no entry — never a guess. The
 * chat is then told it could not identify the repository, which is a sentence
 * an operator can act on; a wrong `owner/name` is a `gh` call against somebody
 * else's project.
 *
 * `read` comes back as well as `repos` because those two absences are different
 * sentences and only one of them is about the repository: a folder that was
 * read and has no entry is not on GitHub, and a folder that was not read is a
 * question nobody asked. A caller holding only a count of the second knows how
 * many it is missing and never which — and the one it is missing is the one it
 * then reports to an operator as unidentifiable.
 */
export async function githubRemotes(
  folders: WorkspaceFolderDTO[],
  query: RemoteQuery = {},
): Promise<RemoteLookup> {
  const selection = selectRemoteReads(folders, query);

  const mountPath = new Map(WORKSPACE_MOUNTS.map((m) => [m.id, m.path]));
  const repos: Record<string, string> = {};

  await Promise.all(
    selection.read.map(async (f) => {
      const root = mountPath.get(f.mountId);
      if (!root) return;
      const res = await git(path.join(root, f.path), [
        "remote",
        "get-url",
        "origin",
      ]);
      if (!res.ok) return;
      const slug = githubSlug(res.stdout);
      if (slug) repos[folderKey(f)] = slug;
    }),
  );

  return { ...selection, repos, read: selection.read.map((f) => folderKey(f)) };
}

/**
 * `owner/name` out of a git remote URL, or null when it is not GitHub.
 *
 * Pure, and matched against both forms the same repository is cloned with —
 * `git@github.com:owner/name.git` and `https://github.com/owner/name`. Anything
 * else is another host: `githubEnv()` credentials a helper keyed to
 * `https://github.com` and nothing else, so claiming a slug for a GitLab remote
 * would produce a `gh` call that fails for a reason the chat cannot explain.
 */
export function githubSlug(url: string): string | null {
  const m = url
    .trim()
    .match(/^(?:git@github\.com:|(?:ssh:\/\/git@|https?:\/\/)(?:[^@/]*@)?github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}
