import { spawn, spawnSync } from "node:child_process";
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
 * `extraConfig` is where `git()`/`gitSync()` splice the filter neutralisers for
 * the content-moving subcommands (see `filterNeutralizers`); it precedes the
 * subcommand because it is config, and defaults to none so a read call is
 * unchanged.
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
 * `-z` output is `key\nvalue` per record; the driver name is the subsection,
 * whose case git preserves and which the override must match, so it is captured
 * verbatim and never lower-cased.
 */
function filterNeutralizers(configOutput: string): string[] {
  const names = new Set<string>();
  for (const record of configOutput.split("\0")) {
    if (!record) continue;
    const key = record.split("\n", 1)[0];
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(key);
    if (match) names.add(match[1]);
  }
  const out: string[] = [];
  for (const name of names) {
    out.push(
      "-c",
      `filter.${name}.clean=`,
      "-c",
      `filter.${name}.smudge=`,
      "-c",
      `filter.${name}.process=`,
    );
  }
  return out;
}

/**
 * Reads the repository's filter drivers, without running any of them.
 *
 * `config` is a read that runs nothing the repository chose, so it is never
 * itself a content subcommand and the enumeration never recurses. `--includes`
 * because a driver reached through an `include.path` would fire too. It exits
 * non-zero when no driver is defined, which is the common case and reads as an
 * empty list, so the status is not checked.
 */
const FILTER_PROBE = ["config", "-z", "--includes", "--get-regexp", "^filter\\."];

/**
 * The subcommands that convert content between the working tree and the object
 * store, and so consult a filter driver. The enumeration costs one extra
 * `git config` child, so it is paid only here and not on the object-store reads
 * — `rev-parse`, `rev-list`, `merge-base`, `cat-file`, `ls-tree`, `log`,
 * `show` — that are the bulk of this app's git calls and never touch the
 * working tree. `status`, `update-index --refresh` and `diff` are on the list
 * because their stat-dirty check re-hashes a file through its clean filter:
 * `conflictedFiles`' `diff --name-only --diff-filter=U` ran one three times
 * mid-merge (measured, 2.39), though `--name-only` opens no blob for a diff
 * driver. `diff` is gated whole rather than only against the working tree,
 * since telling a range from a pathspec means parsing git's own grammar, and
 * the probe is small beside a diff. The gate reads `args[0]`, which every call
 * site passes as the subcommand; this app never puts a global flag before it.
 */
const CONTENT_SUBCOMMANDS = new Set([
  "add",
  "commit",
  "merge",
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
  const extra = CONTENT_SUBCOMMANDS.has(args[0])
    ? filterNeutralizers(gitSync(cwd, FILTER_PROBE).stdout)
    : [];
  const res = spawnSync(GIT_BIN, gitArgs(args, extra), {
    cwd,
    env: gitEnv(),
    ...childCredentials(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_SYNC_TIMEOUT_MS,
  });

  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
    code: res.status,
  };
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
  const { timeoutMs = 20_000, maxBytes = 0, trim = true } = opts;

  // The probe is a `config` read, never a content subcommand, so this recurses
  // exactly one level and never for a read call. `git()` never rejects, so the
  // await cannot throw. `trim: false` keeps the `-z` record separators intact.
  const extra = CONTENT_SUBCOMMANDS.has(args[0])
    ? filterNeutralizers(
        (await git(cwd, FILTER_PROBE, { env: opts.env, trim: false })).stdout,
      )
    : [];

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let overflowed = false;
    let killedByClock = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: code === 0 && !overflowed,
        stdout: trim ? stdout.trim() : stdout,
        stderr: stderr.trim(),
        code,
        overflowed,
        // A child that exited by itself in the instant the clock fired has a
        // code, and was not killed by it.
        timedOutAfterMs: killedByClock && code === null ? timeoutMs : null,
      });
    };

    try {
      const options = {
        cwd,
        env: opts.env ? { ...gitEnv(), ...opts.env } : gitEnv(),
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
      child.on("close", (code) => finish(code));
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
