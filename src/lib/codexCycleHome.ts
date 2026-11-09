import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CODEX_HOME } from "./config";
import { childCredentials, chownForChild, privilegeSeparated } from "./privsep";

/**
 * A `CODEX_HOME` of its own for every Codex work cycle, so that no other cycle
 * can break the one write that keeps its repository's `.codex/config.toml` out.
 *
 * Every `workspace-write` or bypass cycle writes a `trust_level` entry into
 * `$CODEX_HOME/config.toml` about 0.1 s in, and one whose write fails loads its
 * repository's `.codex/config.toml` instead, with nothing in its output (board
 * tasks `c15641cc` and `1eff0ac8`, codex-cli 0.153.4). The write is
 * unconditional: over a file that already trusted the directory it replaced
 * the file again, and a trust level passed with `-c`, `trusted` or
 * `untrusted`, neither skipped it nor kept the layer out over a garbled file.
 * So a file only root can write fails the write, and the file has to be one the
 * cycle replaces. In the shared home that is a file every cycle can replace,
 * which is board task `27f99097`: a cycle garbling it in the ~0.1 s before
 * another cycle's write made that cycle load its repository's file, and the
 * checks that refused a garbled file before the spawn were not a lock.
 *
 * **Here each cycle gets a fresh directory whose name no other cycle has**,
 * created by the server just before the spawn under a parent the agents can
 * pass through and not list, and its `config.toml` starts absent, so the
 * cycle's own write creates it. Measured on 0.153.4 with the shared file
 * garbled every 20 ms: 5 of 5 cycles in the shared home loaded the repository's
 * file and 0 of 5 in a home of their own did. That is not a uid boundary,
 * because every cycle is the same uid: a process of that uid that can see this
 * cycle's processes reads the name out of `/proc/<pid>/environ` (measured,
 * since `codex` does not make itself undumpable). Such a process is unconfined
 * and can already run what that file could start, so this closes the race for
 * everything that cannot.
 *
 * **Everything a cycle shares with the next one is a link back to the shared
 * home**, so nothing but `config.toml` and Codex's per-process scratch differs
 * from a cycle in the shared home. Each was measured through a link on
 * 0.153.4: a ChatGPT token refresh writes the shared `auth.json` (board task
 * `93f1c142`); `exec resume` from a second home found the thread its first
 * home started and sent its turn back; the rollout lands in the shared
 * `sessions/`, which is where `codexRollout.ts` reads it; execpolicy loaded
 * the denial through a linked `rules/`; the linked `AGENTS.md` reached the
 * request; and `installation_id`, which rides every request, came from the
 * shared file. The SQLite state goes to the shared home through
 * `CODEX_SQLITE_HOME` rather than by link, since SQLite makes its `-wal` and
 * `-shm` beside the name it opened. The links are root's, in a directory that
 * is root's and sticky, so the cycle cannot repoint one.
 *
 * **A home that started a thread is kept, stripped to its `sessions` link.**
 * The state database records a thread's rollout by its absolute path, which is
 * through the home that started it (`…/.uf-cycle-homes/<name>/sessions/…`), and
 * `exec resume` answered `no rollout found` once that home was gone; a resume
 * kept the first path (measured, 0.153.4). A fresh database per cycle avoided
 * that but backfilled every rollout in `sessions/` on each start, about 7 ms a
 * thread, and lost what else the database holds across cycles, goals among
 * it. So the anchor stays, which grows with threads as `sessions/` does, and is
 * why the homes live on the Codex volume rather than in `/run`, which a boot
 * would clear.
 */

/** The shared home's entries a cycle reads or writes through its own. */
export const CODEX_CYCLE_HOME_LINKS = [
  "auth.json",
  "installation_id",
  "sessions",
  "thread-writer-locks",
  "rules",
  "AGENTS.md",
] as const;

/**
 * The links that must name a directory before the cycle starts. Codex makes
 * both when they are missing, and over a link to nothing it failed the whole
 * cycle (`failed to create thread writer lock directory … File exists`), where
 * a link to a missing file was created through. `rules/` is
 * `prepareCodexRules`', which runs first.
 */
const SHARED_DIRECTORIES = ["sessions", "thread-writer-locks"] as const;

/**
 * Where the homes go: a directory in the shared home that, under the split,
 * only root can write or list, since a name the agents could list is one a
 * cycle could find and plant at before the cycle it belongs to writes there.
 * The shared home is sticky, so no cycle can rename it away either, and
 * `docker-entrypoint.sh` moves aside anything a cycle put at the name first.
 */
export function codexCycleHomesBase(): string {
  return path.join(CODEX_HOME, ".uf-cycle-homes");
}

export type CodexCycleHome =
  | { kind: "ready"; home: string; env: Record<string, string> }
  | { kind: "unavailable"; reason: string };

/**
 * Each run's live home, so a cycle that threw between making it and spawning
 * is cleared by the next cycle or the run's end rather than left. A new key
 * rather than any older shape's, for `globalThis`'s dev-reload rule.
 */
const liveHomes = ((globalThis as unknown as {
  __ufCodexCycleHomesV1?: Map<string, string>;
}).__ufCodexCycleHomesV1 ??= new Map<string, string>());

/**
 * A fresh `CODEX_HOME` for `runId`'s next cycle, and the variables that point
 * the cycle at it. Called after `prepareCodexRules`, which checks the shared
 * home and writes the `rules/` linked here. Refused rather than degraded:
 * a cycle in the shared home is the one this exists to stop.
 */
export async function prepareCodexCycleHome(runId: string): Promise<CodexCycleHome> {
  const stale = await releaseCodexCycleHome(runId);
  if (stale) return { kind: "unavailable", reason: stale };
  let home: string | null = null;
  try {
    for (const name of SHARED_DIRECTORIES) ensureSharedDirectory(name);
    const base = ensureBase();
    home = path.join(base, randomBytes(16).toString("hex"));
    // 0700 and exclusive until every link is in place, so the agents never
    // see it half made.
    fs.mkdirSync(home, { mode: 0o700 });
    liveHomes.set(runId, home);
    for (const name of CODEX_CYCLE_HOME_LINKS) {
      fs.symlinkSync(path.join(CODEX_HOME, name), path.join(home, name));
    }
    const { gid } = childCredentials();
    if (gid !== undefined) {
      // The shared home's arrangement: the agents' group creates Codex's own
      // files, and the sticky bit keeps the cycle from replacing root's links.
      fs.chownSync(home, process.getuid?.() ?? 0, gid);
      fs.chmodSync(home, 0o1770);
    }
    return { kind: "ready", home, env: { CODEX_HOME: home, CODEX_SQLITE_HOME: CODEX_HOME } };
  } catch (err) {
    const cleanup = home ? await releaseCodexCycleHome(runId) : null;
    return {
      kind: "unavailable",
      reason:
        `Could not make this cycle its own CODEX_HOME under ${codexCycleHomesBase()}: ` +
        `${(err as Error).message}` +
        (cleanup ? `; and ${cleanup}` : ""),
    };
  }
}

/** The parent, made or checked: a real directory of this server's that nobody else can write. */
function ensureBase(): string {
  const base = codexCycleHomesBase();
  const separated = privilegeSeparated();
  try {
    fs.mkdirSync(base, { mode: separated ? 0o711 : 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const stat = fs.lstatSync(base);
  const self = process.getuid?.() ?? 0;
  if (!stat.isDirectory() || stat.uid !== self) {
    throw new Error(
      `${base} is not a directory of uid ${self}'s, so a work cycle may have made it to list ` +
        `every cycle's home; restarting the container moves it aside`,
    );
  }
  // Re-asserted rather than trusted: a parent the agents could list names
  // every live home to them.
  fs.chmodSync(base, separated ? 0o711 : 0o700);
  return base;
}

/**
 * A directory the cycle needs at a shared name, made for it when absent. Made
 * by root and then given to the agents, as Codex would have made it; nothing
 * can be swapped in between, because the shared home is sticky
 * (`prepareCodexRules` refuses one that is not) and the entry is root's until
 * the chown. Whatever is already at the name is left to the agents, whose it
 * is: root never goes through it.
 */
function ensureSharedDirectory(name: string): void {
  const target = path.join(CODEX_HOME, name);
  try {
    fs.mkdirSync(target, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
    throw err;
  }
  chownForChild(target);
}

/**
 * Clear `runId`'s home, if it has one, and say what could not be cleared, or
 * null. Never throws.
 *
 * `keepAnchor` for a cycle that started a thread: the home is left as a
 * directory only root can write, holding the `sessions` link and nothing else,
 * so the path the state database recorded for that thread's rollout goes on
 * resolving. Otherwise nothing of it is left.
 *
 * **Root deletes only its own links.** Everything else in the home is the
 * cycle's, and a recursive delete by root of a tree another uid can write is
 * the old `rm -rf` race: a directory swapped for a link between root's `lstat`
 * and its descent sends root's unlinks through the link. So the cycle's files
 * are deleted by `/bin/rm` as the agents, which can delete nothing they could
 * not, and which the sticky bit stops at root's links.
 */
export async function releaseCodexCycleHome(runId: string, keepAnchor = false): Promise<string | null> {
  const home = liveHomes.get(runId);
  if (home === undefined) return null;
  liveHomes.delete(runId);
  try {
    for (const name of CODEX_CYCLE_HOME_LINKS) {
      if (keepAnchor && name === "sessions") continue;
      const entry = path.join(home, name);
      try {
        if (fs.lstatSync(entry).isSymbolicLink()) fs.unlinkSync(entry);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    if (childCredentials().uid === undefined) {
      for (const entry of fs.readdirSync(home)) {
        if (keepAnchor && entry === "sessions") continue;
        fs.rmSync(path.join(home, entry), { recursive: true, force: true });
      }
    } else {
      await removeAsAgents(home);
    }
    if (!keepAnchor) {
      fs.rmdirSync(home);
      return null;
    }
    // Before the check, so nothing can be added after it.
    fs.chmodSync(home, 0o755);
    const left = fs.readdirSync(home).filter((entry) => entry !== "sessions");
    return left.length === 0 ? null : `the cycle's CODEX_HOME ${home} still holds ${left.join(", ")}`;
  } catch (err) {
    return `could not clear the cycle's CODEX_HOME ${home}: ${(err as Error).message}`;
  }
}

/**
 * `rm -rf` of the cycle's own files, as the uid that made them. Its exit code
 * is not read: it cannot remove root's links or `home` itself, and what it
 * left is read back by the caller.
 */
function removeAsAgents(home: string): Promise<void> {
  // Nothing of the server's environment: the child is the agents' uid. Cast
  // because Next's types make `NODE_ENV` required on every `ProcessEnv`, and
  // `rm` needs only a PATH.
  const env = { PATH: "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv;
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/rm", ["-rf", "--", home], {
      env,
      ...childCredentials(),
      stdio: "ignore",
      timeout: 30_000,
    });
    child.once("error", reject);
    child.once("close", () => resolve());
  });
}
