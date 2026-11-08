import { db } from "./db";
import { git } from "./git";

/**
 * Which run wrote a commit, recorded in the commit itself.
 *
 * ## The gap this closes
 *
 * Every commit on an isolated run's branch is authored by the one identity the
 * container is configured with, so the only trace of a run on the target is a
 * branch name in a merge subject — and a fast-forward land leaves not even
 * that. "Everything the run that wrote bad notes wrote" could not be listed.
 *
 * ## Trailers, not an identity
 *
 * The author stays what it was. A trailer is a line in the message that
 * `git log --format=%(trailers)` and `git log --grep` read, which is the whole
 * of what "which run" needs, and changing the author would break every
 * attribution the operator already reads (`git shortlog`, blame, a forge's
 * profile mapping).
 *
 * ## Two routes, and why neither is a hook
 *
 * The commits this app makes itself (`commitPending`, the land's merge and
 * squash, a resolution's merge) take their trailers where they are made, with
 * `--trailer` or in the message handed to `git merge`. The commits the agent
 * makes on its own are stamped by `stampBranchCommits`, after the cycle that
 * made them, with `git interpret-trailers` over the commits it finds.
 *
 * A `prepare-commit-msg` hook would be the obvious route and cannot be this
 * app's: `git()` runs with `core.hooksPath=/dev/null`, so no hook of the
 * repository's reaches a commit the app makes; installing one for the agent's
 * means writing into `.git/hooks`, which `gitDirWatch` reports as an agent
 * tampering with the repository; pointing `core.hooksPath` at ours by
 * environment would shadow the repository's own hooks; and any of them can be
 * undone by the process whose commits they are meant to label. The stamp
 * is done by this server, after the agent's process has exited, and nothing
 * the agent does inside a cycle can prevent it.
 */
export type Trailer = readonly [token: string, value: string];

/** The trailer that marks a commit as stamped, and that `hasRunTrailer` reads. */
export const RUN_TRAILER = "UF-Run";

/** The trailer naming a board task a run was started for, one per task. */
export const TASK_TRAILER = "UF-Task";

/**
 * A model id as git can carry it on a trailer line: no whitespace, no control
 * characters. `[` and `]` are allowed because the CLI's own ids carry them
 * (`claude-sonnet-5-5[1m]`).
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/;
const NIGHT = /^\d{4}-\d{2}-\d{2}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The trailers for one run, in the order they are written.
 *
 * Pure, and a value that could not sit on one trailer line is left out rather
 * than escaped: a trailer carrying a newline would start a second, forged one,
 * and a model id is typed by an operator.
 *
 * `model` is the id the run was *asked* to use. A run on the CLI's default has
 * none that this app knows, so it carries no `Model` trailer rather than a
 * guessed one. `night` is the Dreaming night the run was started for, and
 * `taskIds` are the board tasks it was started for, one trailer each.
 */
export function trailersFor(input: {
  runId: string;
  taskIds: readonly string[];
  model: string | null;
  night: string | null;
}): Trailer[] {
  // A run id is generated here, so one that is not a plain token is a bug and
  // not a value to leave out: a stamp without it would label nothing.
  if (!IDENTIFIER.test(input.runId)) {
    throw new Error(`run id ${JSON.stringify(input.runId)} cannot be written as a trailer`);
  }
  const out: Trailer[] = [[RUN_TRAILER, input.runId]];
  for (const id of input.taskIds) if (IDENTIFIER.test(id)) out.push([TASK_TRAILER, id]);
  if (input.night !== null && NIGHT.test(input.night)) out.push(["UF-Night", input.night]);
  if (input.model !== null && MODEL_ID.test(input.model)) out.push(["Model", input.model]);
  return out;
}

/** The Dreaming night a run was started for, from its `origin_ref`. */
export function nightOf(originRef: string | null): string | null {
  return originRef?.startsWith("dreaming:") ? originRef.slice("dreaming:".length) : null;
}

/** What a commit or squash made for `run` is handed: `git commit --trailer ...`. */
export function trailerFlags(trailers: readonly Trailer[]): string[] {
  return trailers.flatMap(([token, value]) => ["--trailer", `${token}: ${value}`]);
}

/** The same lines as one paragraph, for a message `git merge -m` is given. */
export function trailerParagraph(trailers: readonly Trailer[]): string {
  return trailers.map(([token, value]) => `${token}: ${value}`).join("\n");
}

/**
 * The tasks a run was started for, from the table that records them.
 *
 * `runs.task_id` is no longer written (`db.ts`), and a run can hold several
 * tasks, so this reads `run_tasks` in the order the proposal named them.
 */
function taskIdsOf(runId: string): string[] {
  return (
    db()
      .prepare("SELECT task_id AS id FROM run_tasks WHERE run_id = ? ORDER BY position")
      .all(runId) as Array<{ id: string }>
  ).map((row) => row.id);
}

/**
 * The trailers for a run row.
 *
 * `withModel` is false for a commit whose content the run's own model did not
 * write — a merge the app made, a resolution — because `Model` there would
 * name a model that wrote none of it.
 */
export function runTrailers(
  run: { id: string; model: string | null; origin_ref: string | null },
  opts: { withModel: boolean; model?: string | null },
): Trailer[] {
  return trailersFor({
    runId: run.id,
    taskIds: taskIdsOf(run.id),
    model: opts.withModel ? (opts.model ?? run.model) : null,
    night: nightOf(run.origin_ref),
  });
}

/**
 * Whether a message already carries a run's trailer, read off its last
 * paragraph as git reads a trailer block. A commit that does is somebody's
 * already — stamped by the cycle that made it — and is never stamped again, so
 * a continuation's commits are not relabelled with the continuation's run.
 */
export function hasRunTrailer(message: string): boolean {
  const paragraphs = message.replace(/\s+$/, "").split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  return last.split("\n").some((line) => line.startsWith(`${RUN_TRAILER}: `));
}

/** A commit as `git cat-file commit` writes it, with what stamping needs. */
export interface RawCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/**
 * Split a commit object, or null for one that cannot be re-made without
 * changing more than its message.
 *
 * Any header besides the four — `gpgsig`, `mergetag`, `encoding` — is refused:
 * a signature cannot survive a new parent or message, and re-making it without
 * the header would drop it silently, which is worse than leaving the commit as
 * it was.
 */
export function parseCommitObject(raw: string): RawCommit | null {
  const split = raw.indexOf("\n\n");
  if (split === -1) return null;
  const headers = raw.slice(0, split).split("\n");
  const message = raw.slice(split + 2);
  let tree: string | null = null;
  const parents: string[] = [];
  let author: string | null = null;
  let committer: string | null = null;
  for (const line of headers) {
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "" : line.slice(space + 1);
    if (key === "tree" && tree === null) tree = value;
    else if (key === "parent") parents.push(value);
    else if (key === "author" && author === null) author = value;
    else if (key === "committer" && committer === null) committer = value;
    else return null;
  }
  if (tree === null || author === null || committer === null) return null;
  return { tree, parents, author, committer, message };
}

/**
 * The environment that makes `git commit-tree` write a commit under the same
 * name, address and time as the one it replaces.
 *
 * The author is kept exactly; this is a trailer and not an identity change.
 * Null for a header it cannot read, or for an empty name or address, which
 * `commit-tree` would refuse.
 */
export function identityEnv(
  kind: "AUTHOR" | "COMMITTER",
  header: string,
): Record<string, string> | null {
  const match = /^(.+) <([^<>]*)> (\d+ [+-]\d{4})$/.exec(header);
  if (!match || !match[2]) return null;
  return {
    [`GIT_${kind}_NAME`]: match[1],
    [`GIT_${kind}_EMAIL`]: match[2],
    [`GIT_${kind}_DATE`]: match[3],
  };
}

/** More commits than this in one stamp is a branch nobody should be rewriting in a cycle's tail. */
export const STAMP_MAX_COMMITS = 500;

export type StampOutcome =
  | { ok: true; stamped: number }
  | { ok: false; reason: string };

/**
 * Add `trailers` to every commit on `branch` that has none of a run's, and move
 * the branch to the result — or change nothing.
 *
 * ## What is rewritten, and what never is
 *
 * The commits reachable from `branch` and not from `target` or from any of
 * `landedTips`. The target's own commits are not the run's and a branch that
 * merged the target in carries them; rewriting one would fork the target's
 * history. A tip an earlier run on this chain landed is where `squashBase`
 * measures the next land from, and it must stay an ancestor of the branch
 * (`land.ts`), so nothing at or below one is touched — which also keeps the
 * commits of a chain that landed before this existed exactly as they were.
 *
 * ## Why it is safe to do this here
 *
 * Only the *message* changes. Each commit is re-made with `commit-tree` over
 * the same tree, under the same author, committer and dates, so what any
 * review, verification or diff reads is identical; only the SHAs differ. That
 * is why it runs at the end of a cycle and not at land: a review's `head_sha`
 * certifies a SHA (`db.ts`), a verify command's proof is one, and a land that
 * rewrote the tip after either would invalidate both. At the end of a cycle
 * nothing has read the tip yet.
 *
 * All or nothing. Every new commit is written before the branch moves, and the
 * move is a compare-and-swap against the tip that was read, so a commit that
 * arrived meanwhile — the card's Commit button, a second tab — leaves the
 * branch where it was with nothing half-stamped. A commit that cannot be
 * re-made faithfully (`parseCommitObject`) stops the whole stamp for the same
 * reason.
 */
export async function stampBranchCommits(opts: {
  /** A checkout of the repository; the run's slot. */
  cwd: string;
  branch: string;
  target: string;
  landedTips: readonly string[];
  trailers: readonly Trailer[];
}): Promise<StampOutcome> {
  const { cwd, branch, target, trailers } = opts;
  const branchRef = `refs/heads/${branch}`;
  const tip = await git(cwd, ["rev-parse", "--verify", branchRef]);
  if (!tip.ok || !tip.stdout) return { ok: false, reason: `could not read ${branch}` };
  const targetTip = await git(cwd, ["rev-parse", "--verify", `refs/heads/${target}`]);
  if (!targetTip.ok || !targetTip.stdout) {
    return { ok: false, reason: `the target ${target} is not a local branch` };
  }

  const not = [targetTip.stdout];
  for (const landed of opts.landedTips) {
    // A landed tip the repository no longer has excludes nothing.
    const known = await git(cwd, ["rev-parse", "--verify", "--quiet", `${landed}^{commit}`]);
    if (known.ok && known.stdout) not.push(known.stdout);
  }
  const listed = await git(cwd, ["rev-list", "--topo-order", "--reverse", tip.stdout, "--not", ...not]);
  if (!listed.ok) return { ok: false, reason: `could not list the commits on ${branch}` };
  const order = listed.stdout.split("\n").filter(Boolean);
  if (order.length === 0) return { ok: true, stamped: 0 };
  if (order.length > STAMP_MAX_COMMITS) {
    return { ok: false, reason: `${order.length} commits are ahead of ${target}, more than ${STAMP_MAX_COMMITS}` };
  }

  const remade = new Map<string, string>();
  let stamped = 0;
  for (const sha of order) {
    const object = await git(cwd, ["cat-file", "commit", sha], { trim: false });
    const commit = object.ok ? parseCommitObject(object.stdout) : null;
    if (!commit) {
      return { ok: false, reason: `commit ${sha.slice(0, 12)} cannot be re-made with only its message changed` };
    }
    const parents = commit.parents.map((p) => remade.get(p) ?? p);
    const moved = parents.some((p, i) => p !== commit.parents[i]);

    const needsStamp = !hasRunTrailer(commit.message);
    if (!needsStamp && !moved) continue;
    let message = commit.message;
    if (needsStamp) {
      const added = await git(cwd, ["interpret-trailers", "--no-divider", ...trailerFlags(trailers)], {
        trim: false,
        input: commit.message,
      });
      if (!added.ok) return { ok: false, reason: `git interpret-trailers failed: ${added.stderr.split("\n")[0]}` };
      message = added.stdout;
      stamped += 1;
    }

    const author = identityEnv("AUTHOR", commit.author);
    const committer = identityEnv("COMMITTER", commit.committer);
    if (!author || !committer) {
      return { ok: false, reason: `commit ${sha.slice(0, 12)} has an identity that cannot be carried over` };
    }
    const made = await git(
      cwd,
      ["commit-tree", commit.tree, ...parents.flatMap((p) => ["-p", p])],
      { input: message, env: { ...author, ...committer } },
    );
    if (!made.ok || !made.stdout) {
      return { ok: false, reason: `git commit-tree failed: ${made.stderr.split("\n")[0]}` };
    }
    remade.set(sha, made.stdout);
  }

  const newTip = remade.get(tip.stdout);
  if (newTip === undefined || stamped === 0) return { ok: true, stamped: 0 };
  const moved = await git(cwd, ["update-ref", "-m", "usagefoundry: add run trailers", branchRef, newTip, tip.stdout]);
  if (!moved.ok) {
    return { ok: false, reason: `${branch} moved while it was being stamped, so nothing was changed` };
  }
  return { ok: true, stamped };
}
