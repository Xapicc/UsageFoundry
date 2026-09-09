import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chownForChild, privilegeSeparated } from "./privsep";

/**
 * The empty files the CLI's sandbox needs to find, so that constructing one
 * does not fail.
 *
 * Claude Code's sandbox makes its own configuration surface unwritable by
 * bind-mounting `/dev/null` over a fixed list of paths **inside every tree it
 * exposes** — an agent that can rewrite `settings.json`, `hooks/` or `skills/`
 * can rewrite its own permission boundary, so the boundary is overmounted
 * rather than merely denied. bwrap needs a target inode for each of those
 * binds, and creates one where it finds nothing. When that create is refused it
 * aborts the whole sandbox, **before the command runs at all** — which reaches
 * this app as a `Bash` tool call that failed with bwrap's exit code and an
 * error naming a settings file the command never touched:
 *
 *     Exit code 1
 *     bwrap: Can't create file at /workspace/.uf-worktrees/x-1/.claude/skills: Permission denied
 *
 * Measured on this install: 255 such results over 2026-08-25 to 2026-09-04,
 * 15-56 a day, naming 261 paths between them, 252 of which are one of the
 * twelve names below inside a project tree. The commands were `cat`, `sed -n`,
 * `grep` and `git log`.
 *
 * Creating the mount points first removes the step that fails. It cannot make
 * the sandbox weaker: an empty file that gets `/dev/null` bound over it is
 * exactly what bwrap would have made itself, and the twelve paths are
 * unreadable inside any sandboxed session either way.
 *
 * Why *all twelve* rather than the ones seen failing: bwrap stops at the first
 * mount point it cannot create, so the name in the message is whichever it
 * reached first. Leaving one out moves the failure rather than removing it.
 *
 * **The config directory is deliberately not covered.** Eight of the 261 name
 * `policy-limits.json`, `local`, `seed-admin` or `mcp-skill-archives` under
 * `$CLAUDE_CONFIG_DIR`, and the sandbox's
 * list for that directory also holds `CLAUDE.md`, `projects` and `plugins` —
 * the operator's own global memory, their transcripts and their installed
 * plugins, in a bind mount of their real `~/.claude`. Creating empty files
 * under those names to save 3% of the failures is a trade nothing here should
 * make.
 *
 * Read out of the CLI's own sandbox construction at 2.1.260, and confirmed
 * against what a live sandboxed session leaves on disk: each of these paths is
 * a character device with `rdev=1,3` while a session holds it. The list is
 * therefore *this* CLI's, and a version that adds a name would start failing on
 * it again — visibly, as the same error, which is the direction that can be
 * noticed.
 */
export const SANDBOX_MOUNT_POINT_NAMES: readonly string[] = [
  "settings.json",
  "settings.local.json",
  "skills",
  "commands",
  "agents",
  "hooks",
  "launch.json",
  "workflows",
  "routines",
  "output-styles",
  "scheduled_tasks.json",
  "loop.md",
];

/**
 * What keeps the placeholders out of the run's own commits.
 *
 * An isolated run is ordered to commit, and `git add -A` stages whatever is
 * untracked: without this, twelve empty files would land on the run's branch in
 * the eleven of fourteen repositories here whose `.gitignore` says nothing
 * about `.claude/`. Worse than noise — an empty file named `skills` is a
 * directory that no longer works for whoever checks that branch out.
 *
 * A `.gitignore` *inside* `.claude/` rather than a line in the repository's own
 * or in `.git/info/exclude`: the first is a tracked file this app must not
 * edit, and the second is shared with the operator's checkout by every linked
 * worktree (git reads `info/exclude` from the common directory, not the
 * worktree's). This file is confined to the directory the placeholders are in.
 *
 * The entries are anchored and named one by one rather than written as `*`, so
 * that a repository which genuinely tracks something under `.claude/` keeps
 * seeing it. Ignoring cannot hide a *tracked* file in any case; what it hides
 * is a new untracked one at exactly one of the twelve paths, and at those paths
 * a placeholder is already in the way.
 */
const GITIGNORE_BODY = [
  "# Written by UsageFoundry, and safe to delete when nothing here is a run's",
  "# checkout. These are the paths Claude Code's sandbox binds /dev/null over;",
  "# they exist as empty files only so constructing the sandbox does not fail on",
  "# creating them. Ignored so that a run's `git add -A` cannot commit them.",
  "/.gitignore",
  "/.cc-writes/",
  ...SANDBOX_MOUNT_POINT_NAMES.map((name) => `/${name}`),
  "",
].join("\n");

/**
 * Which trees the sandbox will neutralise, given one the child is spawned with.
 *
 * The CLI walks from the working directory to the filesystem root and applies
 * the list at every level, which is why a run in `.uf-worktrees/x-1` fails on
 * `/workspace/.claude/settings.local.json` — the mounts' parent, and the single
 * most frequent path in the measurement above.
 *
 * The ancestor half is **guarded on `.claude` already existing**, and that is
 * this function's whole containment argument rather than an optimisation: the
 * CLI guards it the same way, so an ancestor without one is not a tree the
 * sandbox touches, and creating a `.claude` there would be this app inventing a
 * configuration directory in somebody's home or at `/`. Only the directory the
 * child actually runs in gets one made for it, and the CLI makes that one
 * anyway for its own atomic-write staging.
 *
 * Pure, with the filesystem passed in, because both ways of being wrong are
 * silent: too few directories and the failures continue with nothing saying
 * why, too many and this app writes into trees nobody asked it to.
 */
export function sandboxMountPointDirs(
  cwd: string,
  hasClaudeDir: (dir: string) => boolean,
): string[] {
  const dirs = [cwd];
  for (let dir = path.dirname(cwd); ; dir = path.dirname(dir)) {
    if (hasClaudeDir(dir)) dirs.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
  }
  return dirs;
}

/** What one pass did, for the run's log. */
export interface MountPointResult {
  /** Absolute paths created, empty when there was nothing left to create. */
  created: string[];
  /** What could not be created, as `<path>: <reason>`. */
  problems: string[];
}

/** True when `<dir>/.claude` is a directory, and false for every other answer. */
function hasClaudeDir(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, ".claude")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Create what is missing in one tree, and say what happened.
 *
 * `wx` rather than a check and a write: two cycles can be spawned against
 * neighbouring trees at once, and an existence test followed by a truncating
 * write is how a placeholder becomes a way to empty a file somebody else just
 * put there. `EEXIST` is the ordinary answer here and is not a problem.
 *
 * Owned by the child's uid for `chownForChild`'s reason at every other write
 * this server makes into a bind mount: the server is root under compose and the
 * agent is not, and a root-owned file in the tree an agent works in is a
 * surprise waiting for whoever hits it. It is not load-bearing for the mount
 * itself — bwrap binds over a file it does not own — so a chown that fails is
 * reported and the placeholder kept, rather than thrown the way `seedWorktree`
 * throws for a checkout the agent must be able to write.
 */
function fillOneTree(dir: string, result: MountPointResult): void {
  const claude = path.join(dir, ".claude");
  let madeSomething = false;
  for (const name of SANDBOX_MOUNT_POINT_NAMES) {
    const target = path.join(claude, name);
    try {
      fs.writeFileSync(target, "", { flag: "wx" });
      result.created.push(target);
      madeSomething = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST") continue;
      result.problems.push(`${target}: ${(err as Error).message}`);
      continue;
    }
    try {
      chownForChild(target);
    } catch (err) {
      result.problems.push(`${target}: created, but ${(err as Error).message}`);
    }
  }

  // This tree's own count, not the run's: a second tree that needed nothing
  // must not get a `.gitignore` because the first one did.
  if (!madeSomething) return;
  try {
    fs.writeFileSync(path.join(claude, ".gitignore"), GITIGNORE_BODY, { flag: "wx" });
    chownForChild(path.join(claude, ".gitignore"));
  } catch (err) {
    // EEXIST is the second run in the same tree and means the file this would
    // have written is already there. Anything else leaves the placeholders in
    // place and visible to git, which is worth a line on the log.
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
      result.problems.push(`${claude}/.gitignore: ${(err as Error).message}`);
    }
  }
}

/**
 * Give the sandbox its mount points in every tree a child is about to be handed.
 *
 * Called immediately before the spawn rather than once when a checkout is made:
 * what has to be true is the state of the tree at the moment bwrap constructs
 * the sandbox, and between two cycles a session can remove what the last one
 * left. It costs a dozen `open(O_CREAT|O_EXCL)` calls per tree on the first
 * cycle and a dozen `EEXIST`s afterwards.
 *
 * Never throws. Every failure here leaves the install exactly where it was —
 * bwrap tries the create itself and the run behaves as it did before — so
 * refusing to spawn over one would trade a recoverable tool-call failure for an
 * unrecoverable run.
 */
export function ensureSandboxMountPoints(cwds: readonly string[]): MountPointResult {
  const result: MountPointResult = { created: [], problems: [] };
  const seen = new Set<string>();

  for (const cwd of cwds) {
    for (const dir of sandboxMountPointDirs(cwd, hasClaudeDir)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      // Only ever for the working directory itself, and only when it is not
      // already there: `sandboxMountPointDirs` returns an ancestor only when it
      // has one, and an existing directory is the operator's or the CLI's — not
      // this app's to re-own.
      if (!hasClaudeDir(dir)) {
        try {
          fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
          chownForChild(path.join(dir, ".claude"));
        } catch (err) {
          result.problems.push(`${dir}/.claude: ${(err as Error).message}`);
          continue;
        }
      }
      fillOneTree(dir, result);
    }
  }

  return result;
}

/**
 * The *other* list the same sandbox applies, and the one it leaves behind.
 *
 * `SANDBOX_MOUNT_POINT_NAMES` above is what gets bound inside `.claude/`. At
 * the **root of the working directory itself** the CLI binds `/dev/null` over a
 * second list: the shell profiles, the git and editor configuration and the MCP
 * and ripgrep files a repository could otherwise use to steer a command running
 * inside the sandbox. bwrap creates a missing bind target the same way it does
 * for the twelve above, `create_file(path, 0444)`, and that empty file outlives
 * the sandbox — the mount is in a namespace, the inode is on the disk.
 *
 * Measured on this install 2026-09-09: in a live session all eleven are
 * character devices with `rdev=1,3` at the root of the checkout and `git status`
 * lists all eleven as untracked, and six of the 47 checkouts under
 * `.uf-worktrees` with no session holding them carried all eleven as regular
 * empty `0444` files. `.idea` and `.vscode` are left as *files* where a checkout
 * wants directories, which is the harm the `skills` placeholder above names.
 *
 * Unlike the `.claude` list this one must **not** be created ahead of time.
 * There is no failure to prevent — the working directory is writable, so
 * bwrap's create succeeds — and creating them is precisely the mess. What this
 * app owes here is the clearing away.
 *
 * The working directory only, and that is measured rather than assumed: a
 * session whose cwd was `.uf-worktrees/usagefoundry-721638d11c0b-7` had all
 * eleven bound there, none at `/workspace` — an exposed ancestor that does get
 * the `.claude` list — and none at `/workspace2`, an added directory. This list
 * follows the cwd and nothing else.
 */
export const SANDBOX_TREE_ROOT_NAMES: readonly string[] = [
  ".bash_profile",
  ".bashrc",
  ".gitconfig",
  ".gitmodules",
  ".idea",
  ".mcp.json",
  ".profile",
  ".ripgreprc",
  ".vscode",
  ".zprofile",
  ".zshrc",
];

/** The three things the decision below reads off an `fs.Stats`. */
export interface PlaceholderStats {
  isFile(): boolean;
  size: number;
  mode: number;
}

/**
 * Is this bwrap's abandoned bind target, or a file somebody meant to have?
 *
 * All three conditions together, because deleting the wrong file is the failure
 * here that cannot be taken back. bwrap creates a missing target with
 * `create_file(path, 0444)` and never writes to it, so the signature is exactly
 * a regular file, zero bytes, mode `0444`. A real `.bashrc` or `.gitconfig` is
 * neither empty nor read-only, and `.idea`/`.vscode` in a checkout that has
 * them are directories, which `isFile` refuses.
 *
 * `lstat` at the call site rather than `stat`: a symlink named `.bashrc` is
 * somebody's, and following one would let a repository aim this at a file
 * outside the tree.
 *
 * The one way this can still be wrong is a repository that *tracks* an empty
 * `0444` file at one of the eleven names — and that is a loud way to be wrong,
 * because git then reports a deletion in the checkout the operator reviews,
 * rather than the silent kind this module's other half guards against.
 */
export function isAbandonedMountPoint(stats: PlaceholderStats | null): boolean {
  if (!stats) return false;
  return stats.isFile() && stats.size === 0 && (stats.mode & 0o777) === 0o444;
}

/** What one sweep did, for the run's log. */
export interface SweptMountPoints {
  /** Absolute paths removed, empty when the sandbox left nothing behind. */
  removed: string[];
  /** What could not be removed, as `<path>: <reason>`. */
  problems: string[];
}

/**
 * Take the working directory back once a cycle's sandboxes are gone.
 *
 * Pure, with the two filesystem calls passed in, for `sandboxMountPointDirs`'
 * reason: both ways of being wrong are silent. Sweep too little and the run
 * hands back a checkout holding eleven files no agent wrote, which is what a
 * reviewer sees and what the next `git add -A` trips over; sweep too much and
 * this app deletes a file out of somebody's repository.
 */
export function sweepAbandonedMountPoints(
  dir: string,
  lstat: (target: string) => PlaceholderStats | null,
  unlink: (target: string) => void,
): SweptMountPoints {
  const swept: SweptMountPoints = { removed: [], problems: [] };

  for (const name of SANDBOX_TREE_ROOT_NAMES) {
    const target = path.join(dir, name);
    if (!isAbandonedMountPoint(lstat(target))) continue;
    try {
      unlink(target);
      swept.removed.push(target);
    } catch (err) {
      swept.problems.push(`${target}: ${(err as Error).message}`);
    }
  }

  return swept;
}

/**
 * `sweepAbandonedMountPoints` against the real filesystem.
 *
 * Called when the cycle's child has exited rather than before the next spawn,
 * which is the opposite of `ensureSandboxMountPoints` and for the opposite
 * reason: the last cycle of a run has no next spawn, and the state that has to
 * be right is the checkout the operator reviews and the merge queue lands.
 *
 * A grandchild that outlived the child can still hold one of these mounted, and
 * the unlink then answers `EBUSY`. That is recorded and left alone rather than
 * retried — fighting a live sandbox for an empty file is not worth a cycle's
 * settling, and the next cycle's sweep gets it.
 *
 * Never throws, for `ensureSandboxMountPoints`' reason: a cycle that already
 * produced its result must not be lost to tidying up after it.
 */
export function sweepSandboxTreeRoot(dir: string): SweptMountPoints {
  return sweepAbandonedMountPoints(
    dir,
    (target) => {
      try {
        return fs.lstatSync(target);
      } catch {
        return null;
      }
    },
    (target) => fs.unlinkSync(target),
  );
}

/**
 * What keeps the sandbox's *root* binds out of a work cycle's `git add -A`.
 *
 * The sweep above takes them once the child is gone. While the child is alive
 * the eleven names are character devices at the root of its checkout, and git
 * refuses to stage one:
 *
 *     error: .bash_profile: can only add regular files, symbolic links or
 *     git-directories
 *     fatal: adding files failed
 *
 * Every run is told to commit its work and `git add -A` is the obvious way to do
 * it, so that is fatal, in a way whose message names a file the agent never
 * touched — and an agent that does not read it carefully ends its run with
 * everything uncommitted, which is then discarded with the worktree. The sweep
 * cannot reach this: it runs after the child has exited, and the mounts are in
 * that child's namespace rather than on the disk.
 *
 * So the rule is handed to the *child* instead of written anywhere, through
 * `core.excludesFile` in its environment (`agentGitEnv` in `orchestrator.ts`),
 * and nothing goes into any repository. The two ordinary places are both closed
 * here for `GITIGNORE_BODY`'s reasons one list up: the repository's own
 * `.gitignore` is a tracked file this app must not edit — and would have to be
 * edited in every repository an operator points a run at — and `info/exclude` is
 * read from `$GIT_COMMON_DIR`, which every linked worktree shares with the
 * operator's own checkout.
 *
 * Root-anchored and named one by one for `GITIGNORE_BODY`'s reason too: a
 * repository that genuinely tracks `docs/.gitconfig` keeps seeing it, and only a
 * path at the top of the working tree is hidden — which is the only place bwrap
 * put one. Derived from the list rather than restated, so a name added there is
 * covered here without a second edit.
 */
export const SANDBOX_TREE_ROOT_EXCLUDES = [
  "# Written by UsageFoundry, outside every repository, and read only by the git",
  "# of one spawned agent through core.excludesFile in its environment. These are",
  "# the paths Claude Code's sandbox bind-mounts /dev/null over at the root of the",
  "# working directory; git cannot stage a character device, so `git add -A` dies",
  "# on the first of them unless they are ignored.",
  ...SANDBOX_TREE_ROOT_NAMES.map((name) => `/${name}`),
  "",
].join("\n");

/**
 * Where that file goes when children are a different uid.
 *
 * `vaultSkill.ts`'s `VAULT_SKILL_BASE` one door over, and the same argument:
 * this is not a secret and has to reach every agent, so it is root-owned and
 * world-readable — 0755 on the directory, 0644 on the file — and `chownForChild`
 * is deliberately **not** applied, unlike the placeholders above. The asymmetry
 * is the point. A placeholder sits in the tree the agent works in and is the
 * agent's to delete; this file decides what every agent's `git add -A` can see,
 * install-wide, so an agent able to rewrite it could hide an untracked file from
 * another run's commit.
 *
 * Never under the checkout, which is the whole reason it is out here: a file
 * there would be one more untracked path in the tree the operator reviews, and
 * this exists to remove those rather than add one.
 *
 * Without separation there is no boundary to build and no point pretending
 * otherwise, so it falls back to a directory of this app's own under
 * `os.tmpdir()` — one uid means a sibling can write whatever this process can
 * write, wherever it is put. A directory of its own rather than `os.tmpdir()`
 * itself, so the mode below is never applied to a directory this app does not
 * own.
 */
export const SANDBOX_EXCLUDES_BASE = "/run/uf-git";

/** What one attempt at the excludes file did, for the run's log. */
export interface SandboxExcludesFile {
  /** Absolute path to hand git, or null when it could not be written. */
  path: string | null;
  /** Why not, as `<path>: <reason>`, or null when it was written. */
  problem: string | null;
}

/**
 * Materialise the excludes file and answer with its path.
 *
 * One file for the install rather than one per run, `writeVaultSkill`'s reason:
 * the content is a function of a compile-time list, so two cycles spawning
 * together write identical bytes. Temp-then-rename anyway, because they can be
 * spawning *while a third cycle's git is reading it*, and a truncating write is
 * how that git comes to see four of the eleven names and die on the fifth —
 * intermittently, which is the expensive way to be wrong here. Not cleaned up
 * when a run ends: git opens it when the agent runs a command, so a file removed
 * after the spawn is a rule that exists until the moment it is needed.
 *
 * Never throws, for `ensureSandboxMountPoints`' reason: a cycle must not be lost
 * to preparing for it. A failure comes back as `problem`, the caller says so on
 * the run's log and spawns without `core.excludesFile` — which is the behaviour
 * before this existed, stated out loud rather than defaulted past.
 */
export function ensureSandboxExcludesFile(): SandboxExcludesFile {
  const dir = privilegeSeparated()
    ? SANDBOX_EXCLUDES_BASE
    : path.join(os.tmpdir(), "uf-git");
  const file = path.join(dir, "sandbox-root-excludes");
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    try {
      fs.mkdirSync(dir, { recursive: false, mode: 0o755 });
    } catch (err) {
      // Every cycle after the first finds it already there, which is the
      // ordinary answer and not a problem. Not `recursive`, because the only
      // parent this would ever create is a missing `/run` or a `TMPDIR` naming
      // a directory that is not there — a misconfiguration to report rather
      // than one to quietly invent a directory for.
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    }
    // `mkdir` masks the mode through the umask and does nothing at all when the
    // directory already exists, so both modes are set rather than requested — a
    // directory the agent's uid cannot enter, or a file it cannot read, is a
    // `core.excludesFile` that silently is not there.
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(tmp, SANDBOX_TREE_ROOT_EXCLUDES);
    fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, file);
    return { path: file, problem: null };
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The rename is what matters; a leftover temp file is not worth masking
      // the error that caused it.
    }
    return { path: null, problem: `${file}: ${(err as Error).message}` };
  }
}
