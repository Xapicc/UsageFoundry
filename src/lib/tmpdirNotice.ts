import path from "node:path";

import type { RunProviderDTO, SandboxDTO } from "./apiTypes";
import { childCredentials } from "./privsep";
import { currentSandbox } from "./sandbox";

/**
 * The literal value of `$TMPDIR`, told to a run so its `Read` stops missing the
 * files it wrote itself.
 *
 * ## Why it is worth a sentence on every turn
 *
 * Bash expands `$TMPDIR` and the `Read` tool does not, so a run that writes
 * `"$TMPDIR/x.txt"` in one and reads it back in the other has to spell the
 * directory out itself — and the CLI's own prompt only says "always use the
 * `$TMPDIR` environment variable", never what it holds. Over 2026-09-02 to
 * 2026-10-01 fifteen `File does not exist` misses were a session reading back a
 * file it had just written, through a prefix it had mis-spelled (`/tmp/claude/`
 * seven times, a session segment inserted after the uid four, `/tmp/<file>`
 * twice); fourteen of them in this container. Each cost a call, usually
 * recovered with `echo "$TMPDIR"`. The recount is in the vault's *Reads of Paths
 * That Do Not Exist*, and whether this sentence removes the kind is that note's
 * open question — a measurement a run cannot make for itself.
 *
 * ## Why the value is derived and never typed in
 *
 * `/tmp/claude-1000` is what it is *here*, for the uid this container's operator
 * happens to have. The directory is the CLI's per-uid temp root — read out of the
 * pinned binary (2.1.280): `join(CLAUDE_CODE_TMPDIR || os.tmpdir(),
 * "claude-" + process.getuid())`, handed to a **sandboxed** Bash command as
 * `$TMPDIR` — so it follows the uid the child runs as, which is `UF_AGENT_UID`
 * under privilege separation and the server's own otherwise, and it follows
 * whichever of `CLAUDE_CODE_TMPDIR`/`TMPDIR`/`TMP`/`TEMP` the child inherits. A
 * constant would be right on the install that wrote it and a confident wrong
 * path everywhere else, which is the failure this sentence exists to remove.
 *
 * ## When it says nothing
 *
 * Absence is the answer whenever the value is not known, because a guessed path
 * is worse than none — it is the mis-spelled prefix again, stated by the
 * supervisor. Four such readings, each of them `""`:
 *
 *   - **No managed sandbox in force** (`state` other than `on`). The CLI only
 *     sets the per-uid directory as `$TMPDIR` for a sandboxed command; any other
 *     gets the bare temp root or whatever this server's environment holds, never
 *     that directory. `empty` and `unknown` are refused for the sandbox note's
 *     reason: a policy that names nothing runs commands unwrapped, and a file
 *     that cannot be read is not evidence of one.
 *   - **A Codex run.** The rule above is Claude Code's.
 *   - **No uid** (`process.getuid` absent). The CLI falls back to `claude-0`
 *     there, on a platform the sandbox does not run on.
 *   - **A root longer than the CLI's socket-path bound.** Past `CLI_TMPDIR_MAX_BYTES`
 *     the CLI swaps in a different, shorter directory whose identity depends on
 *     a `mkdir` succeeding at spawn time, which nothing here can see.
 *
 * ## Why it is frozen on the run's row
 *
 * **The appended system prompt is part of the cached prefix**, exactly as
 * `fileCostNotice.ts` argues at length: text that differed between cycle 1 and
 * cycle 2 of one run would leave every token behind it cold. The reading
 * (sandbox state, uid, environment) is stable for a server's life but not for a
 * run's — an operator can edit the managed policy between two cycles — so it is
 * taken **once**, in `createRun`, stored on `runs.tmpdir_notice`, and every cycle
 * puts the *stored* text on the argv. Do not recompute it per cycle.
 *
 * ## Why digits and an absolute path are safe here
 *
 * `SELF_HOSTING_NOTICE`'s rule is that nothing on the appended prompt may offer
 * an agent a literal to match a process on, since the whole prompt is on every
 * sibling's command line; `orchestrator.test.ts` holds the standing half to no
 * multi-digit run at all. This is the per-run half, beside the price list, and
 * the property that makes its figure inert is the price list's: it names no
 * command, no verb beside it is `kill`, and it is a directory the agent is told
 * to *read from*. `tmpdirNotice.test.ts` pins that.
 */

/**
 * The CLI's bound on the per-uid temp root, in bytes — `Q$n` in the pinned
 * binary, there so a path under it still fits an `AF_UNIX` socket name.
 */
export const CLI_TMPDIR_MAX_BYTES = 44;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `os.tmpdir()` as Node computes it on POSIX, over an environment of our
 * choosing: the first non-empty of `TMPDIR`, `TMP`, `TEMP`, else `/tmp`, with one
 * trailing slash dropped. Reimplemented only because the real one reads this
 * process's `process.env`, and the question here is what a *child's* is.
 */
function nodeTmpdir(env: Env): string {
  const raw = env.TMPDIR || env.TMP || env.TEMP || "/tmp";
  return raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

/**
 * The directory a sandboxed Bash command gets as `$TMPDIR`, or null when it
 * cannot be said.
 *
 * Pure, and unit-tested for the reason this file's header gives: every way of
 * getting it wrong is a plausible path that is not the child's.
 */
export function claudeSessionTmpdir(o: { env: Env; uid: number }): string | null {
  const root = o.env.CLAUDE_CODE_TMPDIR || nodeTmpdir(o.env);
  if (!path.isAbsolute(root)) return null;
  const dir = path.join(root, `claude-${o.uid}`);
  return Buffer.byteLength(dir) <= CLI_TMPDIR_MAX_BYTES ? dir : null;
}

/** The sentence, for a directory already known. */
export function renderTmpdirNotice(dir: string): string {
  return (
    `In sandboxed Bash commands $TMPDIR is ${dir}. The Read tool does not expand ` +
    "variables, so when you Read a file you wrote under $TMPDIR, give Read that " +
    "literal path."
  );
}

/**
 * The decision, separated from the readings that feed it: the notice for a run
 * about to be created, or `""` when the value is not known.
 *
 * @param o.uid the uid the CLI will run as, or null when this platform has none.
 * @param o.env the environment the child will inherit.
 */
export function decideTmpdirNotice(o: {
  provider: RunProviderDTO | null | undefined;
  sandbox: SandboxDTO["state"];
  uid: number | null;
  env: Env;
}): string {
  if (o.provider === "codex") return "";
  if (o.sandbox !== "on") return "";
  if (o.uid === null) return "";
  const dir = claudeSessionTmpdir({ env: o.env, uid: o.uid });
  return dir ? renderTmpdirNotice(dir) : "";
}

/**
 * The frozen notice for a run about to be created, or `""`.
 *
 * Every failure degrades to `""`, which is `fileCostNotice`'s contract and for
 * its reason: `createRun` is the one door every run comes through, and a run
 * that cannot be created because a hint could not be built costs infinitely more
 * than the hint saves. What this reads that can throw — `childCredentials()` on a
 * `UF_AGENT_UID` the process cannot switch to — is a misconfiguration the first
 * spawn refuses loudly anyway, so nothing is hidden by not repeating it here.
 *
 * @param env what the child will inherit: `childEnv()`, passed in so this module
 *   does not import the orchestrator that imports it.
 */
export function tmpdirNotice(provider: RunProviderDTO | null | undefined, env: Env): string {
  try {
    return decideTmpdirNotice({
      provider,
      sandbox: currentSandbox().state,
      uid: childCredentials().uid ?? process.getuid?.() ?? null,
      env,
    });
  } catch {
    return "";
  }
}
