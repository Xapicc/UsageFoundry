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
import { childCredentials, privilegeSeparated } from "./privsep";

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

/** Codex's own configuration file, which is the agents' and not this app's. */
export const CODEX_CONFIG_FILE = path.join(CODEX_HOME, "config.toml");

/**
 * Why `$CODEX_HOME/config.toml` is something other than the regular file Codex
 * needs there, or one its reader cannot read or replace, or null when it is
 * usable or absent.
 *
 * Two readers, both measured on codex-cli 0.153.4. Every `workspace-write` or
 * bypass cycle writes a `trust_level` entry into this file, and one whose write
 * failed — a directory at the name, or a home it could not create its
 * temporary file in — loaded its repository's `.codex/config.toml` and started
 * the MCP servers named there, 15 of 15 runs against 0 of 14, with nothing in
 * its output. And `login status`, both logins and `logout` exit 1 with `Error
 * loading configuration: … is not a file` over a directory, a FIFO or a link
 * to a directory, so the panel had only that to quote. `app-server` logs the
 * same error and goes on with the defaults and its `-c` pins (measured), so
 * `codexAccount.ts` does not ask. Absent is a fresh install: the cycle's write
 * creates the file, and a dangling link read as absent to `login status`.
 *
 * The file is the agents' own under a uid split — group-writable sticky home,
 * their file — so any cycle can `rm` it and put something else at the name,
 * and **nothing here repairs it**: a rename by root at cycle time races a cycle
 * still running, `tamperedBecause`'s reason, and making root own the file is
 * what `docs/agent/security/cycle-settings-env.md` records as widening every
 * cycle. The entrypoint moves it aside at boot instead. A check here is also
 * not a lock: a cycle running beside the one about to spawn can still swap the
 * name in the ~0.1 s before that cycle's write.
 *
 * **A regular file is not enough either** (board task `93f1c142`, measured on
 * 0.153.4): the write also failed, and the repository's file loaded, over a
 * file the cycle could not read (mode 0000 or 0200) or decode (`[[[`, a byte
 * that is not UTF-8). And the write is a rename over the file, which the
 * sticky `CODEX_HOME` refuses to anyone but the file's owner, so under the
 * split a file the agents do not own fails it too (inferred from the sticky
 * bit; the suite has no second uid). Ownership and the read bit are checked
 * here; whether Codex can parse the file is asked of Codex
 * (`codexConfigLoadRefusal`), because this repository has no TOML parser and a
 * second one would differ from Codex's exactly where a cycle looks for it.
 * Mode 0400 passed, because the rename needs no write bit on the file.
 *
 * @param followLinks `stat` rather than `lstat`. True for the sign-in children,
 *   which read through a link as Codex does, and for a cycle without a uid
 *   split, where a link is an operator's dotfiles; false for a cycle under the
 *   split, where a link is a name the agents can repoint after the check, so it
 *   is refused whatever it names.
 * @param cycleUid the uid a work cycle runs as under the split, which must own
 *   the file and have its read bit; null to ask `access(2)` whether this
 *   process can read it, which without the split is the cycle's own answer.
 *   Null for the sign-in children too: they never write the file, so whose it
 *   is costs them nothing, and their own output names a read they could not do.
 */
export function codexConfigUnusableBecause(
  followLinks: boolean,
  cycleUid: number | null = null,
): string | null {
  let stat: fs.Stats;
  try {
    stat = followLinks ? fs.statSync(CODEX_CONFIG_FILE) : fs.lstatSync(CODEX_CONFIG_FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // A reason rather than a throw, so `prepareCodexRules` does not report a
    // link loop here as the denial failing to write.
    return `${CODEX_CONFIG_FILE} could not be checked: ${(err as Error).message}`;
  }
  if (stat.isFile()) return regularConfigUnusableBecause(stat, cycleUid);
  const what = stat.isSymbolicLink()
    ? "a symbolic link, which a work cycle could repoint"
    : stat.isDirectory()
      ? "a directory"
      : "not a regular file";
  return (
    `${CODEX_CONFIG_FILE} is ${what}. A Codex work cycle writes its project trust entry there, ` +
    `and one that cannot loads its repository's .codex/config.toml, which can start the MCP ` +
    `servers that file names; Codex's sign-in children fail on a directory there too. ` +
    `Restarting the container moves it aside (docker-entrypoint.sh, at every boot); without the ` +
    `container, rename it yourself and Codex makes a new one.`
  );
}

/**
 * What a cycle loses over a regular `config.toml` it cannot use, and the one
 * remedy there is. The boot moves only a thing that is not a file aside, so
 * this says to rename it by hand rather than to restart.
 */
function regularConfigRefusal(problem: string): string {
  return (
    `${problem}. A Codex work cycle writes its project trust entry into ${CODEX_CONFIG_FILE} by ` +
    `reading it and renaming a new file over it, and one that cannot loads its repository's ` +
    `.codex/config.toml, which can start the MCP servers that file names. Rename it aside ` +
    `yourself and the next cycle makes a new one; a restart does not, because the container ` +
    `moves aside only something that is not a file.`
  );
}

/** `codexConfigUnusableBecause` for a regular file: whose it is, and whether its reader can read it. */
function regularConfigUnusableBecause(stat: fs.Stats, cycleUid: number | null): string | null {
  if (cycleUid === null) {
    try {
      fs.accessSync(CODEX_CONFIG_FILE, fs.constants.R_OK);
      return null;
    } catch (err) {
      return regularConfigRefusal(
        `${CODEX_CONFIG_FILE} cannot be read by this server's uid ${process.getuid?.() ?? "?"}, ` +
          `which Codex runs as here: ${(err as Error).message}`,
      );
    }
  }
  if (stat.uid !== cycleUid) {
    return regularConfigRefusal(
      `${CODEX_CONFIG_FILE} is owned by uid ${stat.uid}, not by uid ${cycleUid}, which Codex work ` +
        `cycles run as, and the sticky CODEX_HOME refuses a rename over it to anyone but its owner`,
    );
  }
  const mode = stat.mode & 0o7777;
  if ((mode & 0o400) === 0) {
    return regularConfigRefusal(
      `${CODEX_CONFIG_FILE} is mode ${mode.toString(8).padStart(4, "0")}, which its owner, ` +
        `the uid Codex work cycles run as, cannot read`,
    );
  }
  return null;
}

/** What every Codex child prints, and exits 1 on, when it cannot load its configuration. */
const CONFIG_LOAD_ERROR = "Error loading configuration:";

/**
 * The refusal for a Codex child's output that says it could not load its
 * configuration, or null when the output says nothing of the kind.
 *
 * The parse half of board task `93f1c142`. `login status` is the reader,
 * because it loads `config.toml` whole and writes nothing, and it exits 1 with
 * one `Error loading configuration: …` line on everything that failed a
 * cycle's trust write: `[[[`, a byte that is not UTF-8, mode 0000 and 0200
 * (measured on 0.153.4). It is stricter than the write: valid TOML of the
 * wrong type, `model = 5` or `projects = 5`, fails it too, where the cycle
 * replaced the file and loaded nothing. That refusal is kept rather than told
 * apart from a syntax error by wording, since the sign-in children fail on
 * that file all the same and the line does not say which it is.
 *
 * Codex's own reason is quoted, because it names the line and column, and it
 * names whichever file failed rather than one assumed here. The caller redacts
 * the output first: a type error quotes the value it rejected.
 */
export function codexConfigLoadFailure(output: string): string | null {
  const line = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(CONFIG_LOAD_ERROR));
  if (line === undefined) return null;
  const reason = line.slice(CONFIG_LOAD_ERROR.length).trim().slice(0, 300);
  return regularConfigRefusal(
    `Codex cannot load its configuration (${reason || "it gave no reason"}), so its sign-in ` +
      `children cannot start over it either`,
  );
}

/** Whether the cycle about to spawn may: the denial is in place and Codex's own file is usable. */
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
 * agents', which is stricter than libuv needs and deliberately so: a child's
 * supplementary groups are cleared before it drops (`privsep.ts`, read from
 * libuv's source and not measured), but libuv ignores that call failing, so a
 * group-writable parent is not provably out of a cycle's reach from here.
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
    `${reason}, so the process-kill denial would not be where only this server can write it. ` +
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
 * `config.toml` is checked here too (`codexConfigUnusableBecause`), after the
 * home and its name hold, because this is already the one call every Codex
 * cycle is refused at, and a cycle that cannot write its trust entry degrades
 * silently to one that loads its repository's Codex config. So each reason
 * says which of the two it is about. Whether Codex can parse it is the one
 * check that needs a child, so the run loop asks `codexConfigLoadRefusal`
 * after this rather than this growing an `await`.
 *
 * @param owner the uid both directories, and `CODEX_HOME`'s parent unless it
 *   is a mount point, must belong to, or null to check nothing; `rulesOwner()`
 *   says which, and the tests pass their own.
 * @param cycleUid the uid the cycle will run as, which must own `config.toml`;
 *   the child's own uid under the split, null without it, and the tests pass
 *   their own.
 */
export function prepareCodexRules(
  owner: number | null = rulesOwner(),
  cycleUid: number | null = owner === null ? null : (childCredentials().uid ?? null),
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
    const config = codexConfigUnusableBecause(owner === null, cycleUid);
    if (config) return { kind: "unavailable", reason: config };
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
      reason: `The process-kill denial ${CODEX_RULES_FILE} could not be written: ${(err as Error).message}`,
    };
  }
}
