import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GIT_BIN, WORKSPACE_MOUNTS } from "./config";
import { fmtDuration } from "./format";
import { childCredentials } from "./privsep";
import { agentEnvironment } from "./stacks";
import { WORKTREE_STORE_DIR } from "./worktreeStoreDir";

/**
 * The one way this app runs git.
 *
 * Extracted from `orchestrator.ts` when reviewing and landing a run's branch
 * became things the app does too: three modules now shell out to git, and the
 * scrubbing below is the whole reason it is safe to. Arguments go as an array
 * and never through a shell; the config the calls carry turns off the two ways
 * a repository gets git to run a command of its choosing (`core.fsmonitor` and
 * hooks — `worktree add` fires `post-checkout`, `merge` fires
 * `pre-merge-commit`/`commit-msg`); and the environment is stripped of this
 * app's configuration anyway, because the drivers reached through
 * `.gitattributes` are repository-controlled too and `diff.ts` disables those
 * per call rather than here. Terminal prompting is disabled because these
 * children have no stdin; a credential prompt would otherwise hang until a
 * timeout.
 */

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Raw exit status. `merge-tree` uses 1 for "conflicts", not for "failed". */
  code: number | null;
}

/**
 * Every mount's checkout store, as a directory git's repository search never
 * climbs into.
 *
 * A slot is found as a repository by its own `.git` file. A slot directory that
 * has lost that file (a `worktree remove` cut short, an agent deleting it, a
 * directory left by hand) found nothing above it while the mount root was not a
 * repository. A repository at the mount root can now be isolated, and then the
 * store is inside its working tree: git asked about an orphaned slot would
 * walk up and answer for the operator's own checkout, and Land would read its
 * branch as the slot's, switch it for a verify command, or commit the
 * operator's uncommitted work as the run's. With the store as a ceiling git
 * stops at the slot and says "not a git repository", which every caller
 * already reads as a slot it must not use. Measured on git 2.39: a slot and a
 * directory inside one still resolve, an orphan and anything under it do not.
 *
 * It does not cover the store directory itself as a working directory, which
 * still resolves to a repository above it; nothing here runs git there. A
 * mount path holding a colon cannot be spelled in the list and is left out.
 * The agent's own git does not get this: what bounds an agent is its sandbox,
 * and an agent can unset a variable.
 */
const STORE_CEILINGS = WORKSPACE_MOUNTS.map((m) => path.join(m.path, WORKTREE_STORE_DIR))
  .filter((store) => !store.includes(":"))
  .join(":");

/**
 * Environment for the git this app runs on its own behalf.
 *
 * The exclusion list is `childEnv`'s in `orchestrator.ts`, deliberately the
 * same one rather than a shorter one: a git child is the *only* child here that
 * executes code written by something other than this app — a hook, a
 * `core.fsmonitor`, a `textconv` — and it does so with no permission mode, no
 * tool lists and no line in `run_events`. It had the shortest exclusion list of
 * the three, which was the wrong way round. `DATA_DIR` is the one that bites:
 * `serverLock.ts` names it as the variable withholding exists to protect, and
 * nothing git does needs to know where this app's database is.
 *
 * `CLAUDE_CONFIG_DIR` and `HOME` still pass through, as they do for the agent —
 * git reads `HOME` for its own configuration, and an allowlist here would fail
 * in ways that are tedious to diagnose from inside a container.
 *
 * `NODE_OPTIONS` is on the list for the reason `childEnv` gives, and it is not
 * dead weight here even though git ignores it: the hooks, `textconv` drivers
 * and `core.fsmonitor` this child can be made to run are repository-controlled
 * and one of them may well be a Node program.
 *
 * `GIT_OPTIONAL_LOCKS=0` because `git status` refreshes the index as a side
 * effect and takes `index.lock` to write it back, and this app runs `status` in
 * the operator's own checkout from the poll behind every Land card. A merge
 * into that checkout that starts while one of those holds the lock is refused
 * by git, and the land with it. With it off a `status` reads the same and
 * writes nothing; the cost is that a stat-dirty file is re-hashed on every read
 * until something else refreshes the index. It covers `status` and not
 * `git diff` against the working tree, which on 2.39 still writes a refreshed
 * index — measured — so it holds only while every diff this app runs is between
 * commits, as each one is but `conflictedFiles`, which runs inside the land it
 * would otherwise race. It is not in
 * `agentEnvironment()`, which this copies, so an agent's own git behaves as it
 * would at the operator's terminal.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const base = agentEnvironment();
  const inherited = base.GIT_CEILING_DIRECTORIES;
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    // Ours first: git resolves symlinks in every entry until it meets an empty
    // one, and an inherited list may carry one.
    GIT_CEILING_DIRECTORIES: inherited ? `${STORE_CEILINGS}:${inherited}` : STORE_CEILINGS,
  };
  for (const k of Object.keys(env)) {
    if (
      k.startsWith("ANTHROPIC_") ||
      k.startsWith("UF_") ||
      k.startsWith("OTEL_") ||
      k === "OPENAI_API_KEY" ||
      k === "CODEX_API_KEY" ||
      k === "CODEX_ACCESS_TOKEN" ||
      k === "GH_TOKEN" ||
      k === "GITHUB_TOKEN" ||
      k === "CLAUDE_CODE_ENABLE_TELEMETRY" ||
      k === "DATA_DIR" ||
      k === "NODE_OPTIONS"
    ) {
      delete env[k];
    }
  }
  return env;
}

/**
 * `core.fsmonitor` is a command git runs, so it is cleared on every call.
 *
 * `core.hooksPath` is cleared for exactly that reason and is the larger half of
 * it: a hook is a repository-controlled command that git runs, `worktree add`
 * and `checkout` fire `post-checkout`, and `merge`/`commit` fire four more —
 * inside the operator's own checkout, at a moment the operator triggered. An
 * agent can write `.git/hooks/post-checkout` in any repository it works in, and
 * a run started afterwards would execute it as this server's git child, outside
 * the CLI's permission model entirely. `/dev/null` is not a directory, so git
 * finds no hook there and carries on; verified against 2.39, including that it
 * outranks a `core.hooksPath` the repository sets in its own `.git/config`.
 * On git 2.54 and later that covers only the hooks directory: a hook named in
 * config (`hook.<name>.command` plus `.event`) still runs, and git has no switch
 * that turns all of those off (measured on 2.54.0 and 2.56.0,
 * `docs/verification/security-and-sandboxing-server-git.md`). The image's 2.39
 * has no such hooks, which is the only reason that gap is not live.
 *
 * This is the git *this app* runs, and nothing here reaches the agent's own:
 * `buildArgs` passes no config at all, so a repository's `pre-commit` still runs
 * for the run that was asked to commit. That is part of the work.
 *
 * `safe.directory` is waived for the same reason the image waives it: a
 * bind-mounted repository carries the host's uid, which need not be this
 * process's, and git's refusal is indistinguishable from "not a repository" by
 * the time `probeIsolation` sees it. The check it disables guards against
 * repositories reached by surprise on a shared host; every path that gets here
 * has already been proved to sit inside a configured mount by `resolveInMount`.
 *
 * The four signing keys below are the same class again: `commit.gpgSign=true`
 * with `gpg.program=<path>` in a repository's `.git/config` makes `git commit`
 * run that path — commitPending's commit and land's `commit --no-edit` both hit
 * it, inside the operator's own checkout — so `commit.gpgSign` is forced off and
 * the three signing programs are pinned to git's own defaults, exactly the pins
 * `CHAT_GIT_CONFIG` carries in `chat.ts`. They are on the command line, which
 * outranks `.git/config`; verified against 2.39. `credential.helper` and
 * `core.sshCommand` are deliberately *not* pinned here: an empty
 * `-c credential.helper=` resets the whole helper list at the highest
 * precedence and would take `githubEnv`'s scoped `credential.https://github.com`
 * helper with it (measured for the chat's block, `chat-child-config-files.md`),
 * so those two belong to Deliver's own fetch/push env, not to every git child.
 *
 * `extraConfig` is where `git()`/`gitSync()` splice the submodule pins and the
 * driver blanks for the content-moving subcommands (see `prepareContentCall`);
 * it precedes the subcommand because it is config, and defaults to none so a
 * read call is unchanged.
 */
export const gitArgs = (args: string[], extraConfig: string[] = []) => [
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "safe.directory=*",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "gpg.program=gpg",
  "-c",
  "gpg.x509.program=gpgsm",
  "-c",
  "gpg.ssh.program=ssh-keygen",
  ...extraConfig,
  ...args,
];

/**
 * The variable every neutraliser's `--config-env` takes its value from: set,
 * and empty, in the environment of every git child this module spawns.
 *
 * Deliberately outside the `UF_` namespace `gitEnv()` scrubs, so that "no `UF_`
 * variable reaches a git child" stays true, and set after `opts.env` so no
 * caller can hand a neutraliser a value.
 */
const BLANK_VAR = "USAGEFOUNDRY_BLANK";

/**
 * Blanking the filter drivers is what the signing pins above cannot be: a flat
 * `-c` list. A `filter.<x>.clean`/`smudge`/`process` is run whenever git
 * converts a file between the working tree and the object store, and the driver
 * `<x>` is named by the repository — in `.git/config` paired with a
 * `* filter=x` line in `.git/info/attributes`, both of which a work cycle can
 * write. git 2.39 has no `-c` pair or flag that turns filtering off wholesale
 * (`.git/info/attributes` outranks every attributes file a variable can name),
 * so the names must be read from the repository and each one's clean, smudge and
 * process blanked on the call. An empty value is "no filter" — identity — and
 * for a `filter.<x>.required=true` driver git then fails the operation rather
 * than running the planted program (measured, 2.39), which is the right failure:
 * nothing of the repository's choosing runs either way.
 *
 * Each blank is a `--config-env=<key>=BLANK_VAR` and never a `-c <key>=`,
 * because git splits a `-c` at its first `=` and a driver name may hold one:
 * `-c filter.a=b.clean=` sets `filter.a` to `b.clean=`, and the planted
 * `filter.a=b.clean` ran (board task a9fde194). `--config-env` splits at its
 * last `=`, and the variable's name has none, so whatever the subsection holds
 * stays in the key (measured, 2.39; the flag exists since 2.31). The carrier
 * `GIT_CONFIG_COUNT` would do too, but an inherited block would have to be
 * appended to rather than replaced, and the flag has nothing to merge.
 *
 * A `merge.<x>.driver` is the same kind of program, run on every three-way
 * content merge of a file whose attributes say `merge=x`, and Land runs two
 * such merges with nobody watching (board task a38856ec). Its blank is an empty
 * driver: git then runs nothing, says `cannot run :` and fails the merge, which
 * `merge-tree` reports as exit 128 and `merge` as exit 2 with no `MERGE_HEAD`
 * left behind (measured, 2.39.5). The two values that look gentler are worse:
 * `false` reads as a conflict whose file holds ours without a marker in it, and
 * `true` as a clean merge that dropped theirs. So a repository that relies on a
 * merge driver has this app's merges of such a file fail, the cost a required
 * filter already has. `merge.default` needs nothing of its own: it names a
 * driver, and a driver it names is defined by keys this blanks.
 *
 * The driver name is the subsection, whose case git preserves and which the
 * override must match, so it is captured verbatim and never lower-cased.
 */
function neutralizers(filters: Iterable<string>, merges: Iterable<string>): string[] {
  const out: string[] = [];
  for (const name of filters) {
    for (const command of ["clean", "smudge", "process"]) {
      out.push(`--config-env=filter.${name}.${command}=${BLANK_VAR}`);
    }
  }
  for (const name of merges) out.push(`--config-env=merge.${name}.driver=${BLANK_VAR}`);
  return out;
}

/** One record of the probe's output: the file it came from, its key, its value. */
interface ConfigRecord {
  origin: string;
  key: string;
  value: string | null;
}

/**
 * `-z --show-origin` output is `<origin> NUL <key> LF <value> NUL` per record,
 * with no LF at all for a key written without a value.
 */
function configRecords(output: string): ConfigRecord[] {
  const fields = output.split("\0");
  const records: ConfigRecord[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const entry = fields[i + 1];
    const lf = entry.indexOf("\n");
    records.push({
      origin: fields[i],
      key: lf === -1 ? entry : entry.slice(0, lf),
      value: lf === -1 ? null : entry.slice(lf + 1),
    });
  }
  return records;
}

/** The filter and merge drivers the records define, by name. */
function driverNames(records: ConfigRecord[]): { filters: string[]; merges: string[] } {
  const filters: string[] = [];
  const merges: string[] = [];
  for (const { key } of records) {
    const filter = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(key);
    if (filter) filters.push(filter[1]);
    const merge = /^merge\.(.+)\.(?:driver|name|recursive)$/i.exec(key);
    if (merge) merges.push(merge[1]);
  }
  return { filters, merges };
}

/**
 * Reads the repository's filter and merge drivers, without running any of them.
 *
 * `config` is a read that runs nothing the repository chose, so it is never
 * itself a content subcommand and the enumeration never recurses. `--includes`
 * because a driver reached through an `include.path` would fire too. It exits 1
 * with nothing on stdout when no driver and no include is defined, which is the
 * common case; `readFilterProbe` is where every other ending is told apart from
 * that one. The `merge` section also holds plain settings (`merge.ff`,
 * `merge.renames`), so exit 0 can be a list with no driver in it, which blanks
 * nothing.
 *
 * The `include` keys and `--show-origin` are for `configFingerprint`: an
 * included file is configuration the call reads, so it is watched like the
 * repository's own, and its path is relative to the file that names it. They
 * blank nothing.
 */
const FILTER_PROBE = [
  "config",
  "-z",
  "--show-origin",
  "--includes",
  "--get-regexp",
  "^(filter|merge|include|includeif)\\.",
];

/**
 * The most any step of the probe may print. Only the index listing comes near
 * it — about 65 bytes a file, so a checkout of a million files — and it is a
 * bound at all because `spawnSync` otherwise stops at 1 MiB, which is a
 * checkout of fifteen thousand.
 */
const STEP_MAX_BYTES = 64 * 1024 * 1024;

/** How one of the probe's git children ended. */
interface ProbeEnding {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** The clock that killed it, if one did. */
  timedOutAfterMs: number | null;
  /** Killed for printing more than `STEP_MAX_BYTES`. */
  overflowed: boolean;
}

/**
 * Why a step of the probe failed, as the reason the call was not run.
 *
 * The reason names the step, how it ended and what git said, because the
 * operator reading it sees only that a run's git call failed.
 */
function probeFailure(ending: ProbeEnding, cwd: string, args: string[], step: string[]): string {
  let how: string;
  if (ending.overflowed) {
    how = `printed more than ${STEP_MAX_BYTES} characters`;
  } else if (ending.timedOutAfterMs !== null) {
    how = `was killed after ${fmtDuration(ending.timedOutAfterMs)} without finishing`;
  } else if (ending.signal) {
    how = `was killed by ${ending.signal}`;
  } else if (ending.code === null) {
    how = "ended without an exit status";
  } else {
    how = `exited with status ${ending.code}${ending.stdout === "" ? "" : " and printed output"}`;
  }
  // One line, so a caller that keeps only the line of git's output that names
  // the failure (`gitFailureLine`) keeps this whole sentence rather than the
  // tail of it.
  const said = ending.stderr ? `: ${ending.stderr.replace(/\s*\n\s*/g, " ")}` : "";
  return `The filter probe failed in ${cwd}, so git ${args[0]} was not run: git ${step.join(" ")} ${how}${said}`;
}

/**
 * What a probe's ending means for the call that asked for it: the records to
 * read the drivers and includes from, or the reason the call must not run.
 *
 * Only exit 1 with an empty stdout is "no filters", and only exit 0 is a list
 * to blank. Everything else (killed by its clock, killed by a signal, never
 * started, any other status, exit 1 with output) means this app does not know
 * which drivers the repository names, and a call run on that guess runs them: a
 * `filter.<x>.clean` a work cycle wrote to `.git/config` would execute in this
 * server's git, which is what the blanking exists to prevent. So the call fails
 * closed, before the child is spawned. It is not retried: a probe the clock
 * killed on a slow checkout would most likely be killed again, so a retry would
 * double the slow path and still have to fail in the end.
 *
 * One function for `git()` and `gitSync()` so the two cannot read a probe
 * differently, and so a probe widened to more keys (`hook.*`) inherits the check
 * rather than re-deriving it.
 */
function readFilterProbe(
  probe: ProbeEnding,
  cwd: string,
  args: string[],
): { ok: true; records: ConfigRecord[] } | { ok: false; reason: string } {
  if (probe.code === 0 && !probe.overflowed) return { ok: true, records: configRecords(probe.stdout) };
  if (probe.code === 1 && probe.stdout === "") return { ok: true, records: [] };
  return { ok: false, reason: probeFailure(probe, cwd, args, FILTER_PROBE) };
}

/**
 * The subcommands that convert content between the working tree and the object
 * store, and so consult a filter driver. Preparing one costs three git children
 * for each repository it reaches (see `prepareContentCall`), so it is paid only
 * here and not on the object-store reads
 * — `rev-parse`, `rev-list`, `merge-base`, `cat-file`, `ls-tree`, `log`,
 * `show` — that are the bulk of this app's git calls and never touch the
 * working tree. `status`, `update-index --refresh` and `diff` are on the list
 * because their stat-dirty check re-hashes a file through its clean filter:
 * `conflictedFiles`' `diff --name-only --diff-filter=U` ran one three times
 * mid-merge (measured, 2.39), though `--name-only` opens no blob for a diff
 * driver. `diff` is gated whole rather than only against the working tree,
 * since telling a range from a pathspec means parsing git's own grammar, and
 * the probe is small beside a diff. `merge-tree` writes no working tree and is
 * on the list for the merge drivers: Land's preview is a three-way content
 * merge, and a planted driver ran there before it was. The gate reads
 * `args[0]`, which every call site passes as the subcommand; this app never
 * puts a global flag before it.
 */
const CONTENT_SUBCOMMANDS = new Set([
  "add",
  "commit",
  "merge",
  "merge-tree",
  "checkout",
  "switch",
  "restore",
  "worktree",
  "reset",
  "read-tree",
  "checkout-index",
  "update-index",
  "stash",
  "cherry-pick",
  "revert",
  "rebase",
  "am",
  "apply",
  "pull",
  "status",
  "diff",
  "sparse-checkout",
]);

/**
 * The directories a content subcommand's probe runs in, or why the call is
 * refused before any probe runs.
 *
 * The probe reads configuration as git in `cwd` sees it, and two `worktree`
 * subcommands hand their content work to a child git inside another worktree:
 * `worktree add` checks the new tree out with a `reset --hard` run in it, and
 * `worktree remove` without `--force` runs a `status` in the tree it removes.
 * That child reads configuration with its own HEAD, git directory and
 * `config.worktree`, so a driver behind `[includeIf "onbranch:uf/**"]` or
 * `[includeIf "gitdir:<repo>/.git/worktrees/"]` was invisible to a probe in the
 * operator's checkout and live in the child, and its smudge ran on every
 * isolated run's `worktree add` (board task d8cae532; the remove's `status` ran
 * a clean filter the same way, measured on 2.39.5). This app never evaluates a
 * condition itself; it probes where the child will read.
 *
 * A remove is probed in the tree it removes as well as in `cwd`. An add has no
 * tree to probe until it has made one, so it is refused unless it is
 * `--no-checkout`, and `addWorktree` makes the checkout a call of its own
 * inside the new tree. An in-process `checkout` or `switch` needs neither:
 * git reads configuration once, before HEAD moves, which is the view the probe
 * had (measured, 2.39.5, onto a branch an `onbranch:` include matches).
 */
function probeSites(
  cwd: string,
  args: string[],
): { ok: true; dirs: string[] } | { ok: false; reason: string } {
  if (args[0] !== "worktree") return { ok: true, dirs: [cwd] };
  if (args[1] === "add" && (!args.includes("--no-checkout") || args.includes("--checkout"))) {
    return {
      ok: false,
      reason:
        `git worktree add was not run in ${cwd}: its checkout would run in a tree ` +
        "the filter probe cannot read first. Add it with addWorktree.",
    };
  }
  if (args[1] === "remove" && !args.includes("--force") && !args.includes("-f")) {
    const operands = args.slice(2).filter((a) => !a.startsWith("-"));
    const tree = operands.length > 0 ? path.resolve(cwd, operands[operands.length - 1]) : null;
    // A tree that is not there has nowhere for `status` to run.
    if (tree !== null && fs.existsSync(tree)) return { ok: true, dirs: [cwd, tree] };
  }
  return { ok: true, dirs: [cwd] };
}

/**
 * Every gitlink in the index, with paths relative to the directory it ran in
 * (`:/` reaches the whole tree from a subdirectory, as `../sm`).
 */
const GITLINK_LIST = ["ls-files", "--stage", "-z", "--", ":/"];

/**
 * The populated submodules in a probe site's index, each a probe site of its
 * own.
 *
 * A content subcommand starts a child git inside a populated submodule —
 * `status` and a work-tree `diff` to ask whether it is dirty, and `add -A`,
 * `commit -a`, a `checkout` reporting local changes and an unforced
 * `worktree remove` the same way — and that child reads the submodule's own
 * configuration and `info/attributes`, in `.git/modules/<name>/` or in the
 * submodule's `.git` directory, which a probe in `cwd` never reads. A filter
 * planted there ran on this app's own `status` of the superproject (board task
 * a559b561), and on each subcommand named here (measured, 2.39.5).
 *
 * Telling git not to recurse covers too little. `--ignore-submodules` stops
 * `status` and `diff`, but `add` has no such flag and ran the filter under
 * every `ignore` setting, and the config form, `diff.ignoreSubmodules`, loses
 * to a `submodule.<name>.ignore` the repository sets (both measured). So the
 * probe follows the child instead. git hands the blanks on to a submodule's
 * child in `GIT_CONFIG_PARAMETERS` (measured), so a submodule's drivers blanked
 * on the superproject's call are blanked in the child that would have run
 * them; a submodule nested in one is reached by probing that one in turn.
 *
 * A gitlink counts when its directory holds a `.git`, which is the test git
 * applies before it starts the child, and whether or not `.gitmodules` names
 * it, because git recurses into one it does not (measured).
 */
function populatedGitlinks(dir: string, output: string): string[] {
  const trees: string[] = [];
  for (const record of output.split("\0")) {
    if (!record.startsWith("160000 ")) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const tree = path.resolve(dir, record.slice(tab + 1));
    if (fs.existsSync(path.join(tree, ".git"))) trees.push(tree);
  }
  return trees;
}

/**
 * How many repositories one content subcommand's probe reaches, its own and
 * every populated submodule counted. Each costs three git children on every
 * such call, and `status` is polled, so a checkout with more is refused rather
 * than probed.
 */
const MAX_PROBE_SITES = 64;

/** A site's own configuration files, absolute: `config` and `config.worktree`. */
const CONFIG_FILES = [
  "rev-parse",
  "--path-format=absolute",
  "--git-path",
  "config",
  "--git-path",
  "config.worktree",
];

/**
 * What a configuration file is at one moment, as a string that changes whenever
 * it is written or replaced.
 *
 * The probe and the call each read configuration for themselves, so a writer
 * swapping `.git/config` between a version without a driver and one with it
 * had the driver run whenever the probe read the first and the call the second
 * (board task 7d41bb25: 88 of 300 calls against a rename loop, 2.39.5). git
 * 2.39 cannot be handed the configuration the probe read, so nothing here
 * closes that; `prepareContentCall` refuses a call when a file the probe read
 * changed between the moment before the probe and the moment before the call.
 *
 * The inode and ctime rather than mtime, because `utimes` sets mtime to
 * anything and ctime only to now, and a rename replaces the inode: a file
 * renamed away and back reads as changed (measured on this container's overlay
 * and fuse mounts). A file that is not there is a state too, so one created in
 * the window counts.
 */
function configFingerprint(file: string): string {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.size}`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "absent" : `unreadable (${code})`;
  }
}

/**
 * The files the records' `include.path` and `includeIf.<condition>.path` name,
 * resolved as git resolves them: `~/` against the child's `HOME`, anything
 * else against the directory of the file that names it. A conditional include
 * is listed whether or not its condition holds, which watches more than git
 * reads and never less.
 */
function includeTargets(dir: string, records: ConfigRecord[]): string[] {
  const home = gitEnv().HOME;
  const targets: string[] = [];
  for (const { origin, key, value } of records) {
    if (!/^include(?:if\..+)?\.path$/i.test(key) || !value || !origin.startsWith("file:")) continue;
    if (value.startsWith("~/")) {
      // git ignores a `~/` include when HOME is unset, so there is nothing to watch.
      if (home) targets.push(path.join(home, value.slice(2)));
      continue;
    }
    const namedIn = path.resolve(dir, origin.slice("file:".length));
    targets.push(path.resolve(path.dirname(namedIn), value));
  }
  return targets;
}

/**
 * Config every content subcommand carries so that git starts no child inside a
 * submodule the probe could not have read first.
 *
 * `submodule.recurse=false`, because with the repository's `submodule.recurse`
 * on, a `checkout`, `reset --hard` or `read-tree -u` onto a commit that adds a
 * submodule checks it out with a child git that reads `.git/modules/<name>/`,
 * which the probe, listing the index as it stood before, never reached: a smudge
 * planted there ran on each of the three (measured, 2.39.5), and Land runs
 * `read-tree -m -u` in the operator's checkout. `diff.submodule=short`, because
 * under `diff.submodule=diff` a patch of a submodule change is made by a child
 * `git diff` inside the submodule, which runs the submodule's textconv: the
 * `--no-textconv` that `diff.ts` passes is the parent's option and does not
 * reach the child (measured). On the command line, each outranks the
 * repository's own value.
 */
const SUBMODULE_PINS = ["-c", "submodule.recurse=false", "-c", "diff.submodule=short"];

/**
 * The subcommands that get `--quiet`, because their report of the local changes
 * left after a switch is a diff of the *new* index against the work tree. A
 * submodule only the target has is then asked whether it is dirty by a child
 * that reads its own configuration, and the probe listed the index before the
 * switch: a clean filter in a submodule directory left behind ran that way
 * (measured, 2.39.5, for `checkout`, `checkout -b` and `switch`). Nothing but
 * `--quiet` turns the report off; `diff.ignoreSubmodules` loses to the
 * repository's `submodule.<name>.ignore`, as above.
 */
const QUIETED = new Set(["checkout", "switch"]);

/** A git child that preparing a content subcommand needs run in `dir`. */
interface PrepareStep {
  dir: string;
  args: string[];
}

/** The content subcommand as it is to be spawned, or why it must not be. */
type Prepared =
  | {
      ok: true;
      args: string[];
      /** The pins and blanks, spliced in ahead of the subcommand. */
      extra: string[];
      /** The merge drivers blanked, for `explainBlankedMergeDrivers`. */
      mergeDrivers: string[];
    }
  | { ok: false; reason: string };

/**
 * Everything a content subcommand is spawned with, worked out by the git
 * children it yields and is handed back the endings of.
 *
 * A generator so that `git()` and `gitSync()` drive the same steps, one
 * awaiting each child and the other spawning it synchronously, and cannot
 * prepare a call differently. Each site takes three: where its configuration
 * lives, fingerprinted before the probe runs; the probe; and, for every
 * subcommand but `merge-tree`, which writes no work tree, the index listing its
 * populated submodules, which become sites. Then every watched file is
 * fingerprinted again, last thing before the caller spawns the call, and one
 * that changed refuses it.
 */
function* prepareContentCall(
  cwd: string,
  args: string[],
): Generator<PrepareStep, Prepared, ProbeEnding> {
  const sites = probeSites(cwd, args);
  if (!sites.ok) return sites;

  const filters = new Set<string>();
  const merges = new Set<string>();
  const watched = new Map<string, string>();
  const watch = (file: string) => {
    if (!watched.has(file)) watched.set(file, configFingerprint(file));
  };
  const queue = [...sites.dirs];
  const seen = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const dir = queue[i];
    // A submodule reached twice, through a symlink or a gitlink back up the
    // tree, is one site. A path that does not resolve is keyed as written, and
    // the git children run in it next say what is wrong with it.
    let identity = dir;
    try {
      identity = fs.realpathSync(dir);
    } catch {}
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (seen.size > MAX_PROBE_SITES) {
      return {
        ok: false,
        reason:
          `git ${args[0]} was not run in ${cwd}: it reaches more than ${MAX_PROBE_SITES} ` +
          "repositories counting populated submodules, more than the filter probe reads before one call.",
      };
    }

    const located = yield { dir, args: CONFIG_FILES };
    if (located.code !== 0 || located.overflowed) {
      return { ok: false, reason: probeFailure(located, dir, args, CONFIG_FILES) };
    }
    for (const file of located.stdout.split("\n")) if (file !== "") watch(file);

    const probe = yield { dir, args: FILTER_PROBE };
    const read = readFilterProbe(probe, dir, args);
    if (!read.ok) return read;
    const names = driverNames(read.records);
    for (const name of names.filters) filters.add(name);
    for (const name of names.merges) merges.add(name);
    for (const file of includeTargets(dir, read.records)) watch(file);

    if (args[0] === "merge-tree") continue;
    const index = yield { dir, args: GITLINK_LIST };
    if (index.code !== 0 || index.overflowed) {
      return { ok: false, reason: probeFailure(index, dir, args, GITLINK_LIST) };
    }
    queue.push(...populatedGitlinks(dir, index.stdout));
  }

  for (const [file, before] of watched) {
    if (configFingerprint(file) !== before) {
      return {
        ok: false,
        reason:
          `${file} changed while the filter probe read it, so git ${args[0]} was not run in ${cwd}: ` +
          "a driver written there then would have run unblanked.",
      };
    }
  }
  return {
    ok: true,
    args: QUIETED.has(args[0]) ? [args[0], "--quiet", ...args.slice(1)] : args,
    extra: [...SUBMODULE_PINS, ...neutralizers(filters, merges)],
    mergeDrivers: [...merges],
  };
}

/**
 * A failed call's result with git's `cannot run :` line saying why it could not.
 *
 * A blanked merge driver fails the merge with `error: cannot run : No such file
 * or directory`, which names no driver and no reason, so a repository relying
 * on a legitimate one (`merge.ours.driver = true`) got a refusal it could not
 * diagnose (board task adb9e828). The sentence goes on that same line because
 * the callers that show a failure keep one line of it: `parseMergeTree` line 0,
 * which is this one for both `merge-tree` and `merge` (measured, 2.39.5), and
 * `gitFailureLine` the first `error:` line, which is this one too. Every merge
 * driver blanked is named, since git does not say which file it was merging.
 */
function explainBlankedMergeDrivers<T extends { ok: boolean; stderr: string }>(
  res: T,
  drivers: string[],
): T {
  if (res.ok || drivers.length === 0) return res;
  const lines = res.stderr.split("\n");
  const at = lines.findIndex((line) => line.includes("cannot run : "));
  if (at === -1) return res;
  const keys = drivers.map((name) => `merge.${name}.driver`).join(", ");
  lines[at] +=
    ` (this app does not run a repository's merge drivers, so it blanked ${keys} ` +
    `and git could not merge a file that uses ${drivers.length === 1 ? "it" : "one of them"})`;
  return { ...res, stderr: lines.join("\n") };
}

/**
 * The longest one synchronous git call may hold the event loop.
 *
 * Named rather than inlined because it is read from outside this module:
 * `serverLock.ts` derives `STALE_MS` from it, since a `spawnSync` is a hold on
 * the one event loop that also beats the lock's heartbeat, and a heartbeat
 * window shorter than a single git call is a window a working server can miss
 * with no other load at all.
 */
export const GIT_SYNC_TIMEOUT_MS = 20_000;

/**
 * Synchronous git, for the admission decision only.
 *
 * `createRun` runs from entry to INSERT with no `await`, and that is what makes
 * its folder claim atomic — so the calls it makes have to be synchronous. These
 * are single-digit milliseconds for the `rev-parse`s, and are emphatically not
 * for `status --porcelain` on a large checkout with `core.fsmonitor` cleared,
 * which is what the ceiling above is really about. Everything else uses `git()`
 * below.
 */
export function gitSync(cwd: string, args: string[]): GitResult {
  let call = { args, extra: [] as string[], mergeDrivers: [] as string[] };
  if (CONTENT_SUBCOMMANDS.has(args[0])) {
    const steps = prepareContentCall(cwd, args);
    let step = steps.next();
    while (!step.done) step = steps.next(stepSync(step.value));
    if (!step.value.ok) return { ok: false, stdout: "", stderr: step.value.reason, code: null };
    call = step.value;
  }
  const res = spawnGitSync(cwd, call.args, call.extra);

  return explainBlankedMergeDrivers(
    {
      ok: res.status === 0,
      stdout: (res.stdout ?? "").trim(),
      stderr: (res.stderr ?? "").trim(),
      code: res.status,
    },
    call.mergeDrivers,
  );
}

/** One step of `prepareContentCall`, spawned synchronously. */
function stepSync(step: PrepareStep): ProbeEnding {
  const res = spawnGitSync(step.dir, step.args, [], STEP_MAX_BYTES);
  // `spawnSync` reports its own clock and its buffer limit as errors with these
  // codes, and a child that could not start as one with its message, which is
  // all there is to say.
  const errno = (res.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    code: res.status,
    signal: res.signal,
    stdout: res.stdout ?? "",
    stderr: (res.stderr ?? "").trim() || res.error?.message || "",
    timedOutAfterMs: errno === "ETIMEDOUT" ? GIT_SYNC_TIMEOUT_MS : null,
    overflowed: errno === "ENOBUFS",
  };
}

function spawnGitSync(cwd: string, args: string[], extra: string[], maxBuffer?: number) {
  return spawnSync(GIT_BIN, gitArgs(args, extra), {
    cwd,
    env: { ...gitEnv(), [BLANK_VAR]: "" },
    ...childCredentials(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_SYNC_TIMEOUT_MS,
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
  });
}

/**
 * Async twin of `gitSync`, for everything outside the admission decision.
 *
 * `worktree add` is a full checkout — minutes on a large repository — and the
 * synchronous form would hold the event loop for all of it, stalling every
 * other run's event stream and every poll in every open tab.
 *
 * `maxBytes` bounds stdout for the callers that read a diff: an unbounded read
 * of a generated-file change is a heap the server does not have. Hitting it
 * kills the child and reports `ok: false` rather than returning a patch that is
 * short by an unstated amount.
 *
 * `trim: false` is for the one output shape where leading whitespace carries
 * meaning: `git status --porcelain` writes an unstaged edit as `" M path"`, and
 * trimming the stream eats that first space — which shifts the whole record and
 * reads the status letters off the middle of a filename.
 *
 * `timeoutMs: 0` runs with **no clock at all**, and it exists for the landing
 * path. A timeout here is a `SIGKILL`, which arrives at the caller as
 * `ok: false` and, unless the caller reads `timedOutAfterMs`, is
 * indistinguishable from git having refused — so a merge on
 * a large repository was rolled back and reported as "git refused the merge"
 * for the sole reason that it took longer than a number nobody measured. There
 * is no length of time after which merging somebody's work becomes the wrong
 * thing to do, so `land.ts` passes this on every call that decides or performs
 * one. Memory is still bounded by `maxBytes` where a caller reads a diff, and
 * an unbounded call is still killed when the process ends.
 *
 * **It never rejects, and that is a contract the whole app was already reading
 * it as having.** Not every failure to start a child reaches the `error` event:
 * `spawn` demotes exactly `EACCES`/`EAGAIN`/`EMFILE`/`ENFILE`/`ENOENT` to one,
 * and throws every other errno synchronously — `ENOTDIR` from a `cwd` that has
 * become a file, `EPERM` from `childCredentials()`. `EMFILE` and `ENFILE` are
 * worse than a throw from `spawn`: they *return*, having deliberately skipped
 * the stdio wiring, so `child.stdout` is `undefined` and the `setEncoding`
 * below is what throws — and file descriptors are the resource this app is
 * closest to spending, at four merge workers each running a dozen git children
 * beside a fleet of agents. Every caller in `land.ts` reads a `GitResult` and
 * none of them has a `catch`, so a rejection propagated out of the merge
 * worker's loop and left the row it was landing stuck on `landing` for ever.
 * A child that could not be started is reported as the failed call it is.
 *
 * A content subcommand whose filter probe failed is reported the same way and
 * was never spawned: `ok: false`, `code: null`, `timedOutAfterMs: null` and a
 * `stderr` that names the probe and how it ended (see `readFilterProbe`). `code`
 * is null and not the probe's status so that no caller reads a probe's exit 1
 * as its own call's answer (`diff --quiet` uses 1 for "differs").
 */
export async function git(
  cwd: string,
  args: string[],
  opts: {
    timeoutMs?: number;
    maxBytes?: number;
    trim?: boolean;
    /**
     * Extra environment for the one call shape that talks to a remote.
     *
     * Applied **after** `gitEnv()`'s scrub, and it has to be: the scrub drops
     * the whole `UF_` namespace, which is deliberate and is what withholds
     * `UF_GITHUB_TOKEN` from every git child this app runs — the reasoning is
     * written out at `githubEnv` in `orchestrator.ts` and rests on git being
     * the one child here that executes repository-controlled code. So the
     * credential cannot be *left in*; it has to be handed back by a caller
     * that means to, which makes every credentialed git call greppable.
     *
     * The only git this app runs that reaches the network, each on a
     * person's press: `deliverRun`'s push of a run's branch, and `projects.ts`'
     * push of the operator's current branch (an `ls-remote`, then the push)
     * and its fetch.
     * Nothing here overrides the `-c` flags in
     * `gitArgs`: those go on the command line, which outranks `GIT_CONFIG_*`,
     * so hooks and `core.fsmonitor` stay off however this is filled in.
     */
    env?: Record<string, string>;
    /**
     * Written to the child's stdin, which is then closed, for the one plumbing
     * call that reads its records from there (`update-index --index-info`).
     * Absent, the child has no stdin at all, for the prompt reason above; a
     * child given one reads end-of-file once this is written, so a prompt
     * still cannot wait on it.
     */
    input?: string;
  } = {},
): Promise<GitResult & { overflowed: boolean; timedOutAfterMs: number | null }> {
  let call = { args, extra: [] as string[], mergeDrivers: [] as string[] };
  if (CONTENT_SUBCOMMANDS.has(args[0])) {
    const steps = prepareContentCall(cwd, args);
    let step = steps.next();
    while (!step.done) {
      // A step is a read (`rev-parse`, `config`, `ls-files`), never a content
      // subcommand, so it is spawned directly and never recurses. It takes the
      // clock the caller gave the call: a step that fails now fails the call, so
      // a call that has no clock (landing) must not have one on its probe
      // either. `trim: false` keeps the `-z` record separators intact.
      const ending = await spawnGit(step.value.dir, step.value.args, [], {
        env: opts.env,
        timeoutMs: opts.timeoutMs,
        trim: false,
        maxBytes: STEP_MAX_BYTES,
      });
      step = steps.next(ending);
    }
    if (!step.value.ok) {
      return {
        ok: false,
        stdout: "",
        stderr: step.value.reason,
        code: null,
        overflowed: false,
        timedOutAfterMs: null,
      };
    }
    call = step.value;
  }

  // `signal` is the probe's to read; the public result has never carried it.
  const { signal: _signal, ...result } = await spawnGit(cwd, call.args, call.extra, opts);
  return explainBlankedMergeDrivers(result, call.mergeDrivers);
}

/**
 * `git worktree add`, with its checkout made by a call of its own inside the
 * new tree, which is the only way `git()` adds one (see `probeSites`).
 *
 * `--no-checkout` makes the tree's git directory, its HEAD and any `-b` branch
 * and writes no file; `reset --hard --no-recurse-submodules` in the new tree is
 * the checkout `worktree add` would have run as its child, and through `git()`
 * its probe reads configuration as that tree does.
 *
 * The tree is locked with the reason `initializing` from the add until the
 * checkout is done, because that is the record git's own `worktree add` keeps
 * across its checkout and `finishCutOffCheckout` reads it: a server killed
 * between the two calls would otherwise leave a registered tree on the branch
 * with no files and no lock, which a continuing run adopts as it stands and
 * whose every file an agent's `git add -A` commits as deleted.
 *
 * A checkout that fails takes the tree with it and leaves a `-b` branch in
 * place, which is what git's own `worktree add` leaves when its checkout fails
 * (measured, 2.39.5), so the caller's next attempt finds the path free. The
 * result is the step that decided it, with that step's `cwd` and `args` for
 * `gitFailureReason`.
 */
export async function addWorktree(
  repoRoot: string,
  tree: string,
  commitish: string,
  opts: { newBranch?: string; timeoutMs?: number } = {},
): Promise<
  GitResult & { overflowed: boolean; timedOutAfterMs: number | null; cwd: string; args: string[] }
> {
  const { newBranch, timeoutMs } = opts;
  const addArgs = [
    "worktree",
    "add",
    "--no-checkout",
    "--lock",
    "--reason",
    "initializing",
    ...(newBranch === undefined ? [] : ["-b", newBranch]),
    tree,
    commitish,
  ];
  const add = await git(repoRoot, addArgs, { timeoutMs });
  if (!add.ok) return { ...add, cwd: repoRoot, args: addArgs };

  const checkoutArgs = ["reset", "--hard", "--no-recurse-submodules"];
  const checkout = await git(tree, checkoutArgs, { timeoutMs });
  if (checkout.ok) {
    const unlockArgs = ["worktree", "unlock", tree];
    const unlock = await git(repoRoot, unlockArgs);
    return { ...unlock, cwd: repoRoot, args: unlockArgs };
  }

  // Forced twice, because the tree is still locked; and forced at all because
  // a tree whose checkout failed has no index, so every file reads as deleted.
  // A forced remove runs no `status` in it.
  const removeArgs = ["worktree", "remove", "--force", "--force", tree];
  const removed = await git(repoRoot, removeArgs, { timeoutMs });
  const stderr = removed.ok
    ? checkout.stderr
    : [
        checkout.stderr,
        `The checkout that failed is still at ${tree}: ${gitFailureReason(removed, repoRoot, removeArgs)}`,
      ]
        .filter((line) => line !== "")
        .join("\n");
  return { ...checkout, stderr, cwd: tree, args: checkoutArgs };
}

/**
 * One git child, with the config in `extra` spliced in. `git()` is this plus the
 * filter probe's verdict; the probe is spawned through here too, which is why it
 * is a function of its own and reports the `signal` it was killed by.
 */
function spawnGit(
  cwd: string,
  args: string[],
  extra: string[],
  opts: {
    timeoutMs?: number;
    maxBytes?: number;
    trim?: boolean;
    env?: Record<string, string>;
    input?: string;
  },
): Promise<GitResult & { overflowed: boolean; timedOutAfterMs: number | null; signal: NodeJS.Signals | null }> {
  const { timeoutMs = 20_000, maxBytes = 0, trim = true } = opts;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let overflowed = false;
    let killedByClock = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: code === 0 && !overflowed,
        stdout: trim ? stdout.trim() : stdout,
        stderr: stderr.trim(),
        code,
        signal,
        overflowed,
        // A child that exited by itself in the instant the clock fired has a
        // code, and was not killed by it.
        timedOutAfterMs: killedByClock && code === null ? timeoutMs : null,
      });
    };

    try {
      const options = {
        cwd,
        env: { ...gitEnv(), ...opts.env, [BLANK_VAR]: "" },
        ...childCredentials(),
      };
      const child =
        opts.input === undefined
          ? spawn(GIT_BIN, gitArgs(args, extra), { ...options, stdio: ["ignore", "pipe", "pipe"] })
          : spawn(GIT_BIN, gitArgs(args, extra), { ...options, stdio: ["pipe", "pipe", "pipe"] });

      if (opts.input !== undefined && child.stdin) {
        // A child that exits before reading all of it makes this write fail
        // with EPIPE, and an unhandled stream error would take the server down.
        // The exit status already reports that call as failed.
        child.stdin.on("error", () => {});
        child.stdin.end(opts.input);
      }
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c: string) => {
        if (overflowed) return;
        stdout += c;
        if (maxBytes > 0 && stdout.length > maxBytes) {
          overflowed = true;
          child.kill("SIGKILL");
        }
      });
      child.stderr.on("data", (c: string) => (stderr += c));

      // Zero is "no clock", not "kill immediately" — see the note above.
      timer =
        timeoutMs > 0
          ? setTimeout(() => {
              killedByClock = true;
              child.kill("SIGKILL");
            }, timeoutMs)
          : null;
      timer?.unref?.();

      child.on("error", () => finish(null));
      child.on("close", (code, signal) => finish(code, signal));
    } catch (err) {
      // The child never started, and the errno said so by throwing rather than
      // by the `error` event. `stderr` is where a caller already looks for why
      // a git call failed, so the reason goes there rather than into a rejection
      // nothing above is written to catch.
      stderr = err instanceof Error ? err.message : String(err);
      finish(null);
    }
  });
}

/**
 * Why a failed `git()` call failed, in words an operator can act on.
 *
 * A call the clock killed is `ok: false`, `code: null` and an empty `stderr` —
 * the same shape as a git that could not be started — so a message built from
 * `stderr` alone ends in a colon with nothing after it. `timedOutAfterMs` is
 * what tells a kill by the clock from every other way a call ends without a
 * status, and the sentence names the call and the checkout it ran in, because
 * the operator reading it has only the run's reason to go on and the fix
 * (usually a checkout whose files are slow to read) is to the checkout.
 *
 * A refusal is git's own `stderr`, unaltered, so that what git said reaches
 * the operator in git's words.
 */
export function gitFailureReason(
  res: { stderr: string; code: number | null; timedOutAfterMs: number | null },
  cwd: string,
  args: string[],
): string {
  const call = `git ${args.join(" ")} in ${cwd}`;
  if (res.timedOutAfterMs !== null) {
    return `${call} was killed after ${fmtDuration(res.timedOutAfterMs)} without finishing`;
  }
  if (res.stderr) return res.stderr;
  return res.code === null
    ? `${call} ended without an exit status and printed nothing`
    : `${call} exited with status ${res.code} and printed nothing`;
}

/**
 * The branch a checkout has out, and whether git could say.
 *
 * `branch` is null both for a detached HEAD and for a read that failed, and
 * `readable` is what tells those two apart. It is the one place the question
 * "does this slot still hold the run's branch" is asked, because slots are
 * reused: the directory a finished run worked in is usually a later run's
 * checkout of an unrelated branch, and everything git says about it — status,
 * files, a context to read from — is then about that run. A caller that
 * compares `branch` against `runs.worktree_branch` must also refuse a null on
 * both sides, since a run with no branch and a detached slot would otherwise
 * match.
 */
export async function headBranchOf(
  dir: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ readable: boolean; branch: string | null }> {
  const head = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"], opts);
  return {
    readable: head.ok,
    branch: head.ok && head.stdout !== "HEAD" ? head.stdout : null,
  };
}
