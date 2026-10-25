/**
 * The `pkill`/`killall` denial, for a provider that has no `--disallowedTools`.
 *
 * `cycleInvocation.ts`'s `PROCESS_KILLERS` is what stands between an unattended
 * agent and the supervisor process it runs inside, and it rides every Claude
 * cycle's argv unconditionally. Codex has no argv flag that can express it: the
 * only mechanism that can refuse a *command* is execpolicy, whose rules are
 * Starlark files, and — measured against `codex-cli 0.153.4` with
 * `RUST_LOG=codex_core::exec_policy=debug` — the only place they are discovered
 * from is `$CODEX_HOME/rules/*.rules`. There is no argv flag and no `-c` key
 * naming a rules file: `policy_paths`, `exec_policy.policy_paths`,
 * `execpolicy.paths`, `exec_policy_paths` and `experimental_execpolicy_files`
 * were each tried and each left `policy_paths=[]` in the trace. A file in that
 * one directory is the whole of the mechanism, which is why this module writes
 * one rather than adding a flag.
 *
 * Two things about that are worth having in front of anyone editing this file,
 * because both are disclosed to the operator rather than only commented here.
 *
 * **It is a file, not a flag, so it is install-wide.** `$CODEX_HOME` defaults to
 * the agent uid's own `~/.codex` — it has to, because that is where the
 * credential a cycle bills against lives and a work cycle runs with a dropped
 * uid (`config.ts`'s `CODEX_HOME` carries the whole argument). So the denial
 * this installs is also in force for an operator's own interactive `codex` in
 * that home. That is a real difference from the Claude path, where the deny list
 * is per-spawn and reaches nothing the operator does by hand.
 *
 * **It is a weaker denial than `--disallowedTools`.** Codex's own
 * `<permissions instructions>` block states that a command using redirection,
 * command substitution, environment-variable prefixes or wildcards "will not be
 * evaluated against rules", so `$(echo pkill) node` may well reach the process
 * table with the rule in place. That specific bypass is **not** measured — no
 * turn has ever been run against a live model here — and it is the reason the
 * disclosure says the denial is weaker rather than saying it is equivalent.
 *
 * Nothing here is a substitute for `--ignore-rules` being absent from the argv:
 * that flag means "do not load user or project execpolicy `.rules` files", so a
 * cycle carrying it would load none of this. `buildCodexArgs` never emits it.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CODEX_HOME } from "./config";
import { privilegeSeparated } from "./privsep";

/**
 * The commands a work cycle may not run, and the reason each is on the list.
 *
 * Deliberately the same two names as `PROCESS_KILLERS`, in the same order, so
 * that the two providers deny the same set and a third name added to one is a
 * visibly missing name in the other. The incident behind it is recorded there
 * and not repeated here: a run's `pkill -f "next-server|next dev"` matched the
 * supervisor it was running inside and marked fourteen runs failed.
 */
export const CODEX_FORBIDDEN_COMMANDS = ["pkill", "killall"] as const;

/** Where the rules this app owns live, inside the directory Codex reads. */
export const CODEX_RULES_FILE = path.join(
  CODEX_HOME,
  "rules",
  "usagefoundry-process-killers.rules",
);

/**
 * The rules file's contents, as a pure function of the list above.
 *
 * `prefix_rule` with a one-word pattern is what was measured to work:
 * `codex execpolicy check -r <file> pkill node` answers
 * `{"decision":"forbidden"}`. `rule` and `define_program` do not exist in this
 * version, so a file written against either dialect loads as zero rules — and
 * *that* is the failure this function's test exists to catch, because a rules
 * file that fails to parse denies nothing while looking exactly like one that
 * does.
 *
 * The header names this app so an operator reading their own `~/.codex` can
 * tell where the file came from and what deleting it would cost them.
 */
export function codexRulesText(
  commands: readonly string[] = CODEX_FORBIDDEN_COMMANDS,
): string {
  return [
    "# Written by UsageFoundry. Deleting this file lets an agent it spawns kill",
    "# the server process that supervises it, which fails every run in flight.",
    "",
    ...commands.map(
      (command) =>
        `prefix_rule(pattern=["${command}"], decision="forbidden")`,
    ),
    "",
  ].join("\n");
}

/** Whether the denial is in place for the cycle about to spawn. */
export type CodexRulesDelivery =
  | { kind: "ready"; file: string }
  | { kind: "unavailable"; reason: string };

/**
 * The uid `CODEX_HOME` and its `rules/` must belong to, or null when there is
 * nobody to keep out of them.
 *
 * Null without a uid split — `npm run dev`, the suite, a container pinned to
 * one uid — because there the cycle *is* the server's uid and can rewrite the
 * file whoever owns the directory. A check would refuse cycles while protecting
 * nothing, and a `~/.codex/rules` linked into an operator's dotfiles is an
 * ordinary shape on a laptop that is a hostile one in the container.
 */
function rulesOwner(): number | null {
  return privilegeSeparated() ? (process.getuid?.() ?? 0) : null;
}

/**
 * Why a work cycle could change what Codex finds at `target`, or null.
 *
 * `lstat`, never `stat`: a link is a name the agents can repoint, so it is
 * refused whatever it names. A write bit for group or others is refused unless
 * `stickyWillDo` and the directory is sticky. For `CODEX_HOME` the sticky bit
 * is what stops a rename of root's `rules/` while the agents' group still
 * creates `auth.json` and `sessions/` beside it; for `rules/` no write bit is
 * safe, because a cycle that can write there can delete the denial.
 */
function untrustedBecause(
  target: string,
  owner: number,
  stickyWillDo: boolean,
): string | null {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return `${target} is a symbolic link`;
  if (!stat.isDirectory()) return `${target} is not a directory`;
  if (stat.uid !== owner) {
    return `${target} is owned by uid ${stat.uid}, not by this server's uid ${owner}`;
  }
  const mode = stat.mode & 0o7777;
  const sticky = (mode & 0o1000) !== 0;
  if ((mode & 0o022) !== 0 && !(stickyWillDo && sticky)) {
    return (
      `${target} is mode ${mode.toString(8).padStart(4, "0")}, writable by group or ` +
      `others${stickyWillDo ? " and not sticky" : ""}`
    );
  }
  return null;
}

/** The three fields of an `lstat` that decide whether a name can be swapped. */
export type NameStat = Pick<fs.Stats, "dev" | "uid" | "mode">;

/**
 * Why a work cycle could put a directory of its own at `home`'s name, or null.
 *
 * Checking `CODEX_HOME` and `rules/` closes both directories and not the name
 * they are reached by: a rename is a write to the directory holding the name,
 * and on the stock image that is `/home/node`, the agents' own. So the name
 * holds only if `rename` cannot take it, for one of two reasons. Either `home`
 * is a mount point (its device differs from its parent's), which `rename` and
 * `rmdir` refuse with `EBUSY` from the namespace it is mounted in; that is the
 * `usagefoundry-codex` volume compose mounts there. Or the parent is the
 * server's and has no write bit for group or others. Any group, not only the
 * agents': `privsep.ts` says a child keeps the server's supplementary groups,
 * so a group-writable parent is not provably out of a cycle's reach from here.
 * Sticky does not rescue the parent the way it rescues `CODEX_HOME`, because
 * nothing here needs the agents to create entries beside it.
 *
 * Fails closed on an install that runs a uid split without the volume and
 * leaves `CODEX_HOME` under the agents' home, and the refusal names both fixes.
 * Pure over two `lstat` results so each side is testable without root or a
 * mount.
 *
 * @param owner the server's uid, as `rulesOwner()` answers it.
 */
export function codexHomeNameUnsafeBecause(
  home: string,
  homeStat: NameStat,
  parentStat: NameStat,
  owner: number,
): string | null {
  if (homeStat.dev !== parentStat.dev) return null;
  const mode = parentStat.mode & 0o7777;
  if (parentStat.uid === owner && (mode & 0o022) === 0) return null;
  const parent = path.dirname(home);
  const parentIs =
    parentStat.uid !== owner
      ? `owned by uid ${parentStat.uid}, not by this server's uid ${owner}`
      : `mode ${mode.toString(8).padStart(4, "0")}, writable by group or others`;
  return (
    `${home} is not a mount point and ${parent} is ${parentIs}, so a work cycle could ` +
    `rename ${home} and put a directory of its own at that name. Mount the ` +
    `usagefoundry-codex volume at CODEX_HOME, as docker-compose.yml does at /home/node/.codex, ` +
    `or point CODEX_HOME at a directory whose parent only root can write.`
  );
}

/**
 * Make `rules/` if it is missing, and say what is wrong with it, with
 * `CODEX_HOME` or with the name `CODEX_HOME` is reached by, or null when only
 * this server can change any of them.
 *
 * `CODEX_HOME` and its name first, and before anything is made inside: while
 * the agents can rename `CODEX_HOME` or entries in it, nothing found in
 * `rules/` stays what it was found to be. Once both hold they cannot touch
 * root's `rules/`, so the check and the write after it see the same directory.
 * The directory before its name only so that each refusal has a case of its
 * own in the suite, which cannot make a parent another uid's. Refused rather
 * than repaired, because a repair at cycle time races a cycle that is still
 * running; the entrypoint repairs at boot, before there is one. The name's
 * refusal carries its own remedy, since a restart does not mount a volume.
 */
function tamperedBecause(dir: string, owner: number): string | null {
  let reason = untrustedBecause(CODEX_HOME, owner, true);
  if (!reason) {
    const swappable = codexHomeNameUnsafeBecause(
      CODEX_HOME,
      fs.lstatSync(CODEX_HOME),
      fs.lstatSync(path.dirname(CODEX_HOME)),
      owner,
    );
    if (swappable) return swappable;
    makeDirectory(dir);
    reason = untrustedBecause(dir, owner, false);
  }
  if (!reason) return null;
  return (
    `${reason}, so the denial would not be where only this server can write it. ` +
    `Restarting the container puts the default CODEX_HOME back: ` +
    `docker-entrypoint.sh makes it root's and sticky, and its rules/ root's alone, at every boot.`
  );
}

/** `mkdir` that leaves whatever is already at the name for the caller to describe. */
function makeDirectory(dir: string): void {
  try {
    fs.mkdirSync(dir, { mode: 0o755 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

/**
 * Put the denial where Codex will find it, or say why it is not there.
 *
 * Rewritten per cycle rather than once per install, `plugins.ts`' reason: the
 * file is outside anything this app owns exclusively, so "it was written at
 * boot" is not evidence that it is there now. The write is atomic for the
 * reason `readGuard.ts`' is — a cycle spawning while a half-written file is on
 * disk would load a rules file that parses to nothing.
 *
 * **A successful write is not enough to answer `ready` under a uid split.**
 * Root owning `rules/` protected nothing while the agents owned the directory
 * holding it, since a rename needs write on the parent only: a cycle could move
 * `rules/` aside and leave a link into its own tree, which this used to follow
 * and answer `ready` with the denial somewhere the agent can edit. So both
 * directories are checked, and the name `CODEX_HOME` is reached by, and the
 * refusal names the one that is wrong.
 *
 * The caller must **refuse the cycle** on `unavailable` rather than log it and
 * carry on. That is the one place this differs from the read guard, which
 * degrades to a cycle that re-reads files: this degrades to a cycle that can
 * kill the supervisor, and the Claude equivalent is not optional either.
 *
 * @param owner the uid both directories, and `CODEX_HOME`'s parent unless it
 *   is a mount point, must belong to, or null to check nothing; `rulesOwner()`
 *   says which, and the tests pass their own.
 */
export function prepareCodexRules(
  owner: number | null = rulesOwner(),
): CodexRulesDelivery {
  const dir = path.dirname(CODEX_RULES_FILE);
  const tmp = `${CODEX_RULES_FILE}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    if (owner === null) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    } else {
      const tampered = tamperedBecause(dir, owner);
      if (tampered) return { kind: "unavailable", reason: tampered };
    }
    fs.writeFileSync(tmp, codexRulesText());
    // World-readable on purpose: the process that writes it is the server, and
    // the process that has to read it is the cycle, under a different uid.
    fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, CODEX_RULES_FILE);
    return { kind: "ready", file: CODEX_RULES_FILE };
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The rename is what matters; a leftover temp file is not worth masking
      // the error that caused it.
    }
    return {
      kind: "unavailable",
      reason: `${CODEX_RULES_FILE} could not be written: ${(err as Error).message}`,
    };
  }
}
