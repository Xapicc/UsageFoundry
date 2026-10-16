import fs from "node:fs";
import path from "node:path";
import { githubTokenFor, type GithubTokenScope } from "./config";
import { db } from "./db";
import { parseRemote, type Remote } from "./delivery";
import { git } from "./git";
import { jsonKind } from "./http";
import {
  branchOwnerOf,
  chainRuns,
  checkoutHolder,
  checkoutOperation,
  claimLanding,
  gitFailureLine,
  isLandedTip,
  mapWithLimit,
} from "./land";
import {
  githubEnv,
  isShuttingDown,
  resolveWorkspaceFolder,
  trackLand,
  type RunRow,
} from "./orchestrator";
import { scanWorkspace } from "./workspace";
import type {
  ProjectBranchDTO,
  ProjectCommitDTO,
  ProjectDTO,
  ProjectFetchRefusalDTO,
  ProjectInventoryDTO,
  ProjectOperationDTO,
  ProjectPushRefusalDTO,
  ProjectRunBranchDTO,
  ProjectUpstreamDTO,
  WorkspaceFolderDTO,
} from "./apiTypes";

/**
 * The operator's own checkouts, as opposed to the branches runs produced.
 *
 * `/branches` lists `uf/*` refs off the `runs` table, and Deliver pushes one of
 * them. Neither says anything about the branch the operator stands on in each
 * project, and Land moves that branch forward on every press without anything
 * here ever sending it on — so it piles up ahead of its remote, a hundred and
 * eighty commits in this repository when this was written. This module is the
 * missing reading and the one push it implies.
 *
 * **Push sends the current branch to its configured upstream, and nothing
 * else.** Never a run's branch (that is Deliver's, with its pull request), never
 * a ref the operator was not shown, never forced, never a deletion, and never a
 * new or changed upstream: the remote is somebody's, and an app asked to send a
 * branch on must not quietly rewrite one. What it sends is the commit the page
 * showed, named by its sha (`planPush` refuses when HEAD has moved off it), so a
 * commit made between the read and the press stays home.
 *
 * **There is no verify gate here, deliberately.** Land and Deliver run
 * `landVerifyCommand` because they are where a run's work *enters* the
 * operator's branch or leaves as a proposal to merge. The commits this pushes
 * are already on the operator's branch: either Land put them there, having run
 * that gate in front of the merge, or the operator committed them by hand,
 * which no gate here was ever asked to judge. Running the command again would
 * check, in the operator's own checkout, a tree that may hold uncommitted work
 * the push does not carry — `verifyTreeVerdict`'s reason for refusing such a
 * tree — and would make a push of hand-made commits wait on a check nobody
 * configured for them.
 *
 * **The credential is the repository's, on Deliver's path.** `githubTokenFor`
 * off the checkout, so a repository configured to get none refuses rather than
 * falling through to the install-wide token; handed to `git()` through
 * `githubEnv` and the `env` option, the same as `deliverRun`, with `gitArgs`'
 * `-c` flags keeping hooks and `core.fsmonitor` off. Push (an `ls-remote`, then
 * the push) and Fetch are the only git besides Deliver's that carries one, and
 * each is a press. Both are decided on every URL git will use, after every
 * rewrite, and only `https://github.com/` passes: anything else is a transport
 * for which git runs a program the repository's config can name, with the
 * token in its environment.
 *
 * Not polled: every project is several git children and nothing here changes
 * on its own. Fetch is the one thing that moves `ahead`/`behind`, and it is a
 * press too, never a loop.
 */

/**
 * Projects one request reads git for. Each is seven git children at most, run
 * one after another inside its worker, so this bounds the request's children
 * at `MAX_PROJECTS * 7` whatever the mounts hold; `offset` moves which ones.
 */
export const MAX_PROJECTS = 60;

/**
 * Commits a row names out of those its branch is ahead by, newest first. The
 * Push sheet says how many it left out, so a cap here costs a list, never a
 * count; a checkout hundreds ahead still costs one child that stops early.
 */
export const MAX_UNPUSHED_LISTED = 10;

/**
 * Unmerged branches one request examines, across every project on the page.
 *
 * Each is one `rev-list --count`, plus one `merge-base --is-ancestor` per
 * squash its run's chain recorded at that exact tip, which is usually none.
 * A branch over the cap is counted in `branchesNotRead` rather than listed:
 * listing it would mean saying whether it is landed without having asked.
 */
export const MAX_BRANCH_READS = 120;

/**
 * Git children in flight at once, for `branchInventory`'s reason: this app is
 * also running agents, and forking every read at once to save a wave is not a
 * trade worth making.
 */
const PROJECT_GIT_CONCURRENCY = 8;

/**
 * The push and the fetch run with no clock, for `NO_CLOCK`'s reason in
 * `land.ts`: a killed git reads as one that refused, so a push that was merely
 * slow would be reported as not sent when it may have been.
 */
const NO_CLOCK = { timeoutMs: 0 } as const;

/* ------------------------------------------------------------------ */
/* Reading a checkout                                                  */
/* ------------------------------------------------------------------ */

/** What `git status --porcelain=v2 --branch -z` says, as `parseBranchStatus` reads it. */
export interface BranchStatus {
  /** `branch.oid`; null on a branch with no commits yet. */
  head: string | null;
  /** `branch.head`; null when HEAD is detached. */
  branch: string | null;
  /** `branch.upstream`: the short name of the ref ahead and behind count against. */
  upstream: string | null;
  /** `branch.ab`. Both null with no upstream, or when its ref is missing. */
  ahead: number | null;
  behind: number | null;
  /** Changed, unmerged and untracked entries. */
  uncommitted: number;
}

/**
 * Parse `git status --porcelain=v2 --branch -z`.
 *
 * One child for the branch, its upstream, ahead/behind as of the last fetch and
 * the uncommitted count, rather than four. A rename or copy (`2 `) carries its
 * source path in the *next* field, and consuming it is not optional: left in
 * the stream it is counted as a change of its own, and a source path that
 * happens to begin `1 ` or `? ` would be read as one — `parseStatusZ`'s trap in
 * the other format. The caller must not trim the output, for the same reason.
 */
export function parseBranchStatus(raw: string): BranchStatus {
  const out: BranchStatus = {
    head: null,
    branch: null,
    upstream: null,
    ahead: null,
    behind: null,
    uncommitted: 0,
  };
  const fields = raw.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.startsWith("# ")) {
      const space = field.indexOf(" ", 2);
      if (space < 0) continue;
      const key = field.slice(2, space);
      const value = field.slice(space + 1);
      if (key === "branch.oid") out.head = value === "(initial)" ? null : value;
      else if (key === "branch.head") out.branch = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") out.upstream = value;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          out.ahead = Number(m[1]);
          out.behind = Number(m[2]);
        }
      }
      continue;
    }
    if (field.startsWith("1 ") || field.startsWith("u ") || field.startsWith("? ")) {
      out.uncommitted++;
    } else if (field.startsWith("2 ")) {
      out.uncommitted++;
      i++;
    }
  }
  return out;
}

/** A local branch `for-each-ref --no-merged` listed. */
interface UnmergedRef {
  branch: string;
  tip: string;
  tipAt: number;
}

/** `%H%x00%s`, one commit per line, the subject cut to 200 characters. */
function parseCommits(raw: string): ProjectCommitDTO[] {
  const out: ProjectCommitDTO[] = [];
  for (const line of raw.split("\n")) {
    const [sha, subject] = line.split("\0");
    if (!sha || subject === undefined) continue;
    out.push({ sha, subject: subject.slice(0, 200) });
  }
  return out;
}

/** `%(refname)%00%(objectname)%00%(committerdate:unix)`, one per line. */
function parseUnmerged(raw: string): UnmergedRef[] {
  const out: UnmergedRef[] = [];
  for (const line of raw.split("\n")) {
    const [ref, tip, at] = line.split("\0");
    if (!ref?.startsWith("refs/heads/") || !tip) continue;
    out.push({ branch: ref.slice("refs/heads/".length), tip, tipAt: Number(at) * 1000 });
  }
  return out;
}

/** The current branch's upstream, as far as git configures one. */
interface Upstream {
  remote: string;
  remoteRef: string;
  short: string;
  /**
   * Every URL a fetch of `remote` may use, as git will use them: the
   * repository's `insteadOf` and `githubEnv`'s own rewrites applied. Empty for
   * a local upstream or a remote git could not name a URL for.
   */
  urls: string[];
  /**
   * Every URL a push to `remote` goes to — git pushes to each — with `pushurl`
   * and `pushInsteadOf` applied as well, which `urls` does not show. Read apart
   * because these are what the credential travels with, and a repository's own
   * config can point them anywhere.
   */
  pushUrls: string[];
}

/**
 * `githubEnv`'s URL rewrites without the token, for reading where a push or a
 * fetch will actually go. The rewrites do not depend on the token, so a
 * placeholder stands in and the real one stays off a call that needs none.
 */
function urlReadEnv(): Record<string, string> {
  return githubEnv("placeholder-not-a-credential");
}

/**
 * The upstream's remote and its branch there, read from `for-each-ref`, or
 * from the branch's config when the branch has no commits yet: its ref does
 * not exist, so `for-each-ref` lists nothing, while git still reports the
 * upstream it is configured with.
 */
async function upstreamOf(
  dir: string,
  branch: string,
): Promise<{ ok: true; remote: string; remoteRef: string } | { ok: true; remote: null } | { ok: false; error: string }> {
  const up = await git(dir, [
    "for-each-ref",
    "--format=%(upstream:remotename)%00%(upstream:remoteref)",
    `refs/heads/${branch}`,
  ]);
  if (!up.ok) return { ok: false, error: gitFailureLine(up.stderr) };
  const [remote, remoteRef] = (up.stdout.split("\n")[0] ?? "").split("\0");
  if (remote && remoteRef) return { ok: true, remote, remoteRef };
  if (up.stdout !== "") return { ok: true, remote: null };
  const [configured, merge] = await Promise.all(
    ["remote", "merge"].map((key) =>
      git(dir, ["config", "--get", `branch.${branch}.${key}`]).then((r) => (r.ok ? r.stdout : "")),
    ),
  );
  return configured && merge ? { ok: true, remote: configured, remoteRef: merge } : { ok: true, remote: null };
}

/** One checkout's state, or why git could not give it. */
interface CheckoutRead {
  error: string | null;
  branch: string | null;
  head: string | null;
  operation: ProjectOperationDTO | null;
  uncommitted: number | null;
  upstream: Upstream | null;
  remotes: string[] | null;
  ahead: number | null;
  behind: number | null;
  fetchedAt: number | null;
  unmerged: UnmergedRef[];
  unpushed: ProjectCommitDTO[];
}

const UNREAD: Omit<CheckoutRead, "error"> = {
  branch: null,
  head: null,
  operation: null,
  uncommitted: null,
  upstream: null,
  remotes: null,
  ahead: null,
  behind: null,
  fetchedAt: null,
  unmerged: [],
  unpushed: [],
};

function failed(error: string): CheckoutRead {
  return { ...UNREAD, error: error || "git could not read this checkout." };
}

/** `FETCH_HEAD`'s mtime in `dir`, or null when no fetch has written one there. */
function fetchedIn(dir: string): number | null {
  try {
    return fs.statSync(path.join(dir, "FETCH_HEAD")).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Everything a project row and both verdicts need, from one checkout.
 *
 * Its children run one after another, so a project costs one git child in
 * flight however many it needs. Any read that fails makes the whole checkout an
 * error rather than a half-filled row, because a row with a branch and no
 * upstream reads as "no upstream", which is a different sentence from "could
 * not tell".
 *
 * `FETCH_HEAD` is per checkout — a fetch in a linked worktree writes it under
 * `worktrees/<id>` (measured against git 2.39) — while the remote-tracking refs
 * ahead/behind count against are the repository's. So "last fetched" is the
 * newer of this checkout's and the repository's own, which covers the common
 * case of fetching from the main checkout; a fetch from a third worktree of the
 * same repository moves the refs without moving either.
 */
async function readCheckout(dir: string, withBranches: boolean): Promise<CheckoutRead> {
  const dirs = await git(dir, ["rev-parse", "--absolute-git-dir", "--git-common-dir"]);
  if (!dirs.ok) return failed(gitFailureLine(dirs.stderr));
  const [gitDir, commonDir] = dirs.stdout.split("\n").map((line) => path.resolve(dir, line));
  if (!gitDir || !commonDir) return failed("git did not name this checkout's git directory.");

  let operation: ProjectOperationDTO | null;
  let fetchedAt: number | null;
  try {
    operation = checkoutOperation(gitDir);
    const times = [fetchedIn(gitDir), fetchedIn(commonDir)].filter(
      (t): t is number => t !== null,
    );
    fetchedAt = times.length ? Math.round(Math.max(...times)) : null;
  } catch (err) {
    return failed(
      `Could not read its git directory: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const status = await git(dir, ["status", "--porcelain=v2", "--branch", "-z"], { trim: false });
  if (!status.ok) return failed(gitFailureLine(status.stderr));
  const s = parseBranchStatus(status.stdout);

  let upstream: Upstream | null = null;
  if (s.branch && s.upstream) {
    const up = await upstreamOf(dir, s.branch);
    if (!up.ok) return failed(up.error);
    if (up.remote) {
      const { remote, remoteRef } = up;
      // `--all`, because git pushes to every URL a remote has and the first
      // one alone says nothing about the rest. A remote git cannot name a URL
      // for is still an upstream, with none, which the verdicts refuse.
      const urlsOf = async (args: string[]) =>
        remote === "."
          ? []
          : await git(dir, args, { env: urlReadEnv() }).then((r) =>
              r.ok ? r.stdout.split("\n").filter(Boolean) : [],
            );
      upstream = {
        remote,
        remoteRef,
        short: s.upstream,
        urls: await urlsOf(["remote", "get-url", "--all", "--end-of-options", remote]),
        pushUrls: await urlsOf(["remote", "get-url", "--push", "--all", "--end-of-options", remote]),
      };
    }
  }

  let remotes: string[] | null = null;
  // Only when no upstream names a remote, so the row can say "no remote" and
  // mean it: a repository with none needs one added, where a branch with no
  // upstream beside an `origin` needs only `--set-upstream-to`.
  if (!upstream) {
    const listed = await git(dir, ["remote"]);
    if (!listed.ok) return failed(gitFailureLine(listed.stderr));
    remotes = listed.stdout.split("\n").filter(Boolean);
  }

  let unmerged: UnmergedRef[] = [];
  // A branch with no commits has no HEAD to measure against, and git refuses
  // `--no-merged HEAD` there; nothing can be unmerged into it either.
  if (withBranches && s.head) {
    const refs = await git(dir, [
      "for-each-ref",
      "--no-merged",
      s.head,
      "--sort=-committerdate",
      "--format=%(refname)%00%(objectname)%00%(committerdate:unix)",
      "refs/heads/",
    ]);
    if (!refs.ok) return failed(gitFailureLine(refs.stderr));
    unmerged = parseUnmerged(refs.stdout);
  }

  let unpushed: ProjectCommitDTO[] = [];
  // What the Push sheet names, counted from the sha this read saw rather than
  // from HEAD, so the list is about the commit the row shows and a press sends.
  // `@{upstream}` rather than the status's short name, which a local branch
  // called `origin/main` would make ambiguous.
  if (withBranches && s.head && s.branch && upstream && (s.ahead ?? 0) > 0) {
    const log = await git(dir, [
      "log",
      "--no-show-signature",
      `--max-count=${MAX_UNPUSHED_LISTED}`,
      "--format=%H%x00%s",
      s.head,
      `^${s.branch}@{upstream}`,
    ]);
    if (!log.ok) return failed(gitFailureLine(log.stderr));
    unpushed = parseCommits(log.stdout);
  }

  return {
    error: null,
    branch: s.branch,
    head: s.head,
    operation,
    uncommitted: s.uncommitted,
    upstream,
    remotes,
    // Ahead and behind come only with an upstream this read could name: the
    // status's own pair is about the same ref, and a pair with no upstream
    // beside it would be a count against nothing the row shows.
    ahead: upstream ? s.ahead : null,
    behind: upstream ? s.behind : null,
    fetchedAt,
    unmerged,
    unpushed,
  };
}

/* ------------------------------------------------------------------ */
/* Deciding                                                            */
/* ------------------------------------------------------------------ */

/** Everything `planPush` and `planFetch` decide from. Pure data, read beforehand. */
export interface CheckoutFacts {
  error: string | null;
  branch: string | null;
  head: string | null;
  operation: ProjectOperationDTO | null;
  upstream: Upstream | null;
  ahead: number | null;
  behind: number | null;
  /** `githubTokenFor`'s answer for the checkout, without the token. */
  credential: { scope: GithubTokenScope; key: string | null };
  /** `checkoutHolder`'s answer. */
  holder: { landing: boolean; runId: string | null };
  /**
   * Set when the current branch is a run's: a run in this repository recorded
   * it (`runId`), or it is in the `uf/` namespace this app names them in and
   * none here did (`runId` null).
   */
  runBranch: { runId: string | null } | null;
}

/** What the press is told the operator was shown, and is refused unless it still holds. */
export interface Shown {
  branch: string;
  sha: string;
  /** The upstream's remote and its branch there, as `ProjectUpstreamDTO` named them. */
  remote: string;
  remoteRef: string;
}

/**
 * What the remote says about the upstream's branch. Read by the press just
 * before it pushes, never by the inventory, which does not reach a remote.
 */
export interface RemoteTip {
  /** The branch's commit on the remote; null when the remote has no such branch. */
  sha: string | null;
  /** That commit is the one being pushed or an ancestor of it. False when this checkout has never seen it. */
  contained: boolean;
}

export type PushPlan =
  | {
      ok: true;
      branch: string;
      sha: string;
      remote: string;
      remoteRef: string;
      /** The one URL the push goes to, which the press asks the remote about first. */
      pushUrl: string;
      github: Remote;
    }
  | { ok: false; code: ProjectPushRefusalDTO; reason: string };

export type FetchPlan =
  | { ok: true; remote: string; github: Remote }
  | { ok: false; code: ProjectFetchRefusalDTO; reason: string };

/** What ends each operation, for the sentence refusing a push under one. */
const OPERATION_ENDED_BY: Record<ProjectOperationDTO, string> = {
  merge: "git merge --continue or git merge --abort",
  rebase: "git rebase --continue or git rebase --abort",
  bisect: "git bisect reset",
};

const short = (sha: string) => sha.slice(0, 8);

/** A remote's branch as a person names it: `main` for `refs/heads/main`. */
const branchName = (ref: string) => ref.replace(/^refs\/heads\//, "");

/**
 * A URL with any credentials in it removed, for a sentence or the page.
 *
 * `git remote get-url` returns a URL exactly as configured, and
 * `https://x-access-token:<token>@github.com/…` is a configuration people
 * write; the browser has no use for the part before the `@`.
 */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/?#]*@/i, "$1");
}

/**
 * The GitHub repository these URLs name, or the first that is not one.
 *
 * Only `https://github.com/<owner>/<repo>`, read after every rewrite git will
 * apply — `githubEnv`'s too, which is what turns an SSH GitHub remote into
 * this form. Anything else is a transport for which git runs a program the
 * repository's config can name (`core.sshCommand`, a local path's
 * `uploadpack`/`receivepack`) or a host the credential helper is not keyed to,
 * and either way the token is in that child's environment. Every URL is held
 * to it, because git pushes to all of a remote's push URLs.
 */
function githubDestination(urls: readonly string[]): { ok: true; github: Remote } | { ok: false; url: string | null } {
  if (urls.length === 0) return { ok: false, url: null };
  let first: Remote | null = null;
  for (const url of urls) {
    const github = url.startsWith("https://") ? parseRemote(url) : null;
    if (!github) return { ok: false, url };
    first ??= github;
  }
  return { ok: true, github: first! };
}

/**
 * The refusals Push and Fetch share: conditions of the checkout and the
 * install, not of the press, each said in the words of the door asking.
 *
 * Worded to read the same in place of the button as in answer to a press,
 * `seededRefusal`'s rule: the page shows these before anything is pressed, so
 * none of them says "nothing was pushed" about a push nobody asked for.
 */
function standingRefusal(
  f: CheckoutFacts,
  door: "push" | "fetch",
):
  | { code: "detached" | "no-upstream" | "not-github" | "no-credential"; reason: string }
  | { ok: true; upstream: Upstream; github: Remote } {
  if (!f.branch) {
    return {
      code: "detached",
      reason: f.operation
        ? `HEAD is detached by the ${f.operation} in progress, so there is no current branch ` +
          `to take an upstream from; end it (${OPERATION_ENDED_BY[f.operation]}) or ${door} by hand.`
        : "HEAD is detached, so there is no current branch and no upstream.",
    };
  }
  if (!f.upstream) {
    return {
      code: "no-upstream",
      reason:
        `${f.branch} has no upstream configured, and this never creates or changes one: ` +
        "set it by hand (git branch --set-upstream-to) if that is what you want.",
    };
  }
  if (f.upstream.remote === ".") {
    return {
      code: "not-github",
      reason: `${f.branch} tracks the local branch ${f.upstream.short}, not a remote.`,
    };
  }
  // The URLs this door's git will actually reach, so a `pushurl`, a
  // `pushInsteadOf` or a second URL sending a GitHub remote's pushes elsewhere
  // refuses here rather than taking the credential with it.
  const urls = door === "push" ? f.upstream.pushUrls : f.upstream.urls;
  if (door === "push" && urls.length > 1) {
    return {
      code: "not-github",
      reason:
        `${f.upstream.remote} pushes to ${urls.length} URLs, and Push sends to one GitHub ` +
        "repository; it can still be done by hand.",
    };
  }
  const destination = githubDestination(urls);
  if (!destination.ok) {
    return {
      code: "not-github",
      reason:
        `\`${destination.url ? redactUrl(destination.url) : f.upstream.remote}\` is not an ` +
        "https://github.com/ repository once git's own rewrites are applied, and GitHub is the " +
        "only host this app holds a credential for; it can still be done by hand.",
    };
  }
  if (f.credential.scope === "none") {
    return {
      code: "no-credential",
      reason:
        f.credential.key !== null
          ? `This repository's entry in UF_GITHUB_TOKENS (${f.credential.key}) gives it no ` +
            "credential, and the install-wide token is deliberately not used in its place. " +
            "Both are read at boot."
          : "There is no GitHub credential for this repository: UF_GITHUB_TOKEN is unset and " +
            "no entry in UF_GITHUB_TOKENS names it. Both are read at boot.",
    };
  }
  return { ok: true, upstream: f.upstream, github: destination.github };
}

/** Why what the operator was shown no longer holds, or null when it does. */
function movedRefusal(f: CheckoutFacts, shown: Shown): string | null {
  const now = (sha: string | null) => (sha ? short(sha) : "no commit");
  if (shown.branch !== f.branch || shown.sha !== f.head) {
    return (
      `HEAD is no longer ${shown.branch} at ${short(shown.sha)}: it is ` +
      `${f.branch ? `${f.branch} at ${now(f.head)}` : `detached at ${now(f.head)}`}. ` +
      "Nothing was pushed, because a push sends what was on screen and nothing else."
    );
  }
  if (f.upstream?.remote !== shown.remote || f.upstream.remoteRef !== shown.remoteRef) {
    return (
      `${f.branch}'s upstream is no longer ${branchName(shown.remoteRef)} on ${shown.remote}` +
      `${f.upstream ? `: it is ${branchName(f.upstream.remoteRef)} on ${f.upstream.remote}` : ""}. ` +
      "Nothing was pushed, because a push goes where the screen said and nowhere else."
    );
  }
  return null;
}

/**
 * Whether Push may send this checkout's branch, and exactly what it sends.
 *
 * The one decision, asked by the inventory for each row's button with nothing
 * shown and no remote reading, and twice by the press: with what the operator
 * was shown before it reaches the remote, then again with what the remote said
 * about the branch (`remote`), so the button and the endpoint cannot disagree
 * about anything the button could know. What the remote says only the press
 * can learn, because the inventory never contacts one.
 *
 * The order is what each sentence assumes. Moved comes first after an
 * unreadable checkout, because every later reason describes a state the
 * operator was not shown. An operation comes before a detached HEAD, because a
 * rebase or bisect detaches it and "detached" alone would hide the command
 * that ends it. A run's branch is refused before anything about its upstream,
 * because no upstream would make it this door's. Behind comes before ahead,
 * because a branch that has diverged is both and the remote would refuse it.
 *
 * Uncommitted paths refuse nothing: a push carries commits, and the response
 * says what it left behind instead.
 */
export function planPush(f: CheckoutFacts, shown: Shown | null, remote?: RemoteTip): PushPlan {
  if (f.error !== null) {
    return {
      ok: false,
      code: "unreadable",
      reason: `Could not read this checkout, so it cannot be pushed: ${f.error}`,
    };
  }
  const moved = shown ? movedRefusal(f, shown) : null;
  if (moved) return { ok: false, code: "moved", reason: moved };
  if (f.operation) {
    return {
      ok: false,
      code: "operation",
      reason:
        `A ${f.operation} is in progress in this checkout; ` +
        `end it (${OPERATION_ENDED_BY[f.operation]}) before pushing.`,
    };
  }
  if (f.runBranch) {
    return {
      ok: false,
      code: "run-branch",
      reason:
        `${f.branch} is ${f.runBranch.runId ? `run ${short(f.runBranch.runId)}'s branch` : "a run's branch"}, ` +
        "and a run's branch leaves by Deliver, which runs the checks Push does not.",
    };
  }
  const standing = standingRefusal(f, "push");
  if (!("ok" in standing)) return { ok: false, ...standing };
  const { upstream, github } = standing;
  const branch = f.branch!;
  const theirs = `${branchName(upstream.remoteRef)} on ${upstream.remote}`;

  if (f.holder.landing) {
    return {
      ok: false,
      code: "busy",
      reason:
        "A land, a delivery or another push is working in this checkout; " +
        "push once it has finished.",
    };
  }
  if (f.holder.runId) {
    return {
      ok: false,
      code: "busy",
      reason:
        `Run ${short(f.holder.runId)} is working in this folder; ` +
        "push once it has finished.",
    };
  }
  if (!f.head) {
    return { ok: false, code: "nothing-to-push", reason: `${branch} has no commits yet.` };
  }
  if (f.ahead === null || f.behind === null) {
    return {
      ok: false,
      code: "uncounted",
      reason:
        `Could not count ${branch} against ${upstream.short}: its local ref is missing, ` +
        "which is what an upstream never fetched looks like. Fetch first.",
    };
  }
  if (f.behind > 0) {
    return {
      ok: false,
      code: "behind",
      reason:
        `${branch} is ${f.behind} commit${f.behind === 1 ? "" : "s"} behind ${upstream.short} ` +
        "as of the last fetch: pull or rebase by hand first, because " +
        "this only ever sends a fast-forward.",
    };
  }
  if (f.ahead === 0) {
    return {
      ok: false,
      code: "nothing-to-push",
      reason: `${branch} has nothing ${upstream.short} lacks as of the last fetch.`,
    };
  }
  if (remote) {
    // The tracking ref is only as fresh as the last fetch, and this module's
    // own fetch never prunes, so a branch deleted on the remote still counts
    // as an upstream here — and a plain push would create it again.
    if (remote.sha === null) {
      return {
        ok: false,
        code: "upstream-gone",
        reason:
          `${theirs} no longer exists, and this never creates a branch on a remote. ` +
          "Nothing was pushed; set a new upstream by hand if one is wanted.",
      };
    }
    if (remote.sha === f.head) {
      return { ok: false, code: "nothing-to-push", reason: `${theirs} is already at ${short(f.head)}.` };
    }
    if (!remote.contained) {
      return {
        ok: false,
        code: "behind",
        reason:
          `${theirs} has moved since the last fetch, to ${short(remote.sha)}, which this checkout ` +
          "has not got. Nothing was pushed; fetch, then pull or rebase by hand.",
      };
    }
  }
  return {
    ok: true,
    branch,
    sha: f.head,
    remote: upstream.remote,
    remoteRef: upstream.remoteRef,
    pushUrl: upstream.pushUrls[0],
    github,
  };
}

/**
 * Whether Fetch may fetch this checkout's upstream remote.
 *
 * Push's standing refusals and nothing else: a fetch writes remote-tracking
 * refs and `FETCH_HEAD`, never the working tree, the index or HEAD, so a merge
 * in progress, a land in flight or a branch behind its remote are no reason to
 * refuse one. A rebase or bisect does refuse it, as a detached HEAD, because
 * the upstream to fetch is the current branch's and there is none. A GitHub
 * https remote and a credential are still required, and not as a formality:
 * `githubEnv` is what rewrites an SSH GitHub remote to https, and any other
 * transport runs a program the repository's config can name, with the token in
 * its environment.
 */
export function planFetch(f: CheckoutFacts): FetchPlan {
  if (f.error !== null) {
    return {
      ok: false,
      code: "unreadable",
      reason: `Could not read this checkout, so it cannot be fetched: ${f.error}`,
    };
  }
  const standing = standingRefusal(f, "fetch");
  if (!("ok" in standing)) return { ok: false, ...standing };
  return { ok: true, remote: standing.upstream.remote, github: standing.github };
}

/* ------------------------------------------------------------------ */
/* Choosing what one request reads                                     */
/* ------------------------------------------------------------------ */

/** The slice of the git folders one request reads, and what it says about the rest. */
export interface ProjectPage<T> {
  examined: T[];
  total: number;
  offset: number;
  limit: number;
  notShown: number;
}

/**
 * Which projects this request reads, `selectBranchCandidates`' rule over a
 * folder list: a limit that is missing or unreadable is the default page, an
 * offset past the end is clamped, and `total` counts every git folder so
 * `notShown` is derived from what exists rather than from the page.
 */
export function selectProjectPage<T>(
  folders: readonly T[],
  query: { offset?: number; limit?: number } = {},
): ProjectPage<T> {
  const asked = Math.floor(Number(query.limit));
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(MAX_PROJECTS, asked) : MAX_PROJECTS;
  const offset = Math.min(
    Math.max(0, Math.floor(Number(query.offset) || 0)),
    Math.max(0, folders.length - 1),
  );
  const examined = folders.slice(offset, offset + limit);
  return {
    examined,
    total: folders.length,
    offset,
    limit,
    notShown: folders.length - examined.length,
  };
}

/**
 * Which unmerged branches get read, as `[project, branch]` index pairs.
 *
 * `selectProbeTargets`' discipline: decided in one synchronous pass before any
 * read is dispatched, because the reads run under a pool and a counter tested
 * across awaits caps nothing. Taken round-robin across projects — every
 * project's newest branch, then every project's second — rather than in page
 * order, so one repository holding hundreds of stale branches cannot spend the
 * whole cap and leave every project after it reading "not read".
 */
export function selectBranchReads(
  counts: readonly number[],
  limit: number,
): Array<[number, number]> {
  const picked: Array<[number, number]> = [];
  const deepest = Math.max(0, ...counts);
  for (let depth = 0; depth < deepest && picked.length < limit; depth++) {
    for (let p = 0; p < counts.length && picked.length < limit; p++) {
      if (depth < counts[p]) picked.push([p, depth]);
    }
  }
  return picked;
}

/* ------------------------------------------------------------------ */
/* The inventory                                                       */
/* ------------------------------------------------------------------ */

/** A git folder this request reads, resolved inside its mount. */
interface ProjectTarget {
  folder: WorkspaceFolderDTO;
  /** Null when the folder no longer resolves inside its mount; `error` says why. */
  dir: string | null;
  error: string | null;
}

function targetOf(folder: WorkspaceFolderDTO): ProjectTarget {
  try {
    return { folder, dir: resolveWorkspaceFolder(folder.path, folder.mountId), error: null };
  } catch (err) {
    return { folder, dir: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function factsOf(dir: string | null, read: CheckoutRead): CheckoutFacts {
  const credential = githubTokenFor(dir);
  return {
    error: read.error,
    branch: read.branch,
    head: read.head,
    operation: read.operation,
    upstream: read.upstream,
    ahead: read.ahead,
    behind: read.behind,
    credential: { scope: credential.scope, key: credential.key },
    holder: dir ? checkoutHolder(dir) : { landing: false, runId: null },
    runBranch: dir && read.branch ? runBranchOf(dir, read.branch) : null,
  };
}

/**
 * Whether `branch` is a run's, which Push refuses: Deliver is a run branch's
 * exit, and it runs the verify gate, the seeded-file refusal and the
 * certification gate that Push does not. Deliver's `push --set-upstream` gives
 * the branch an upstream, so an operator who checks a delivered branch out
 * would otherwise be offered Push on it. The `uf/` name counts on its own,
 * because a run recorded in another install, or swept from this one, is still
 * a run's branch.
 */
function runBranchOf(dir: string, branch: string): { runId: string | null } | null {
  const run = runsOn(dir, [branch]).get(branch);
  if (run) return { runId: run.id };
  return branch.startsWith("uf/") ? { runId: null } : null;
}

/** The newest run that recorded each of these branches in this repository. */
function runsOn(repoRoot: string, branches: readonly string[]): Map<string, RunRow> {
  const found = new Map<string, RunRow>();
  if (branches.length === 0) return found;
  const rows = db()
    .prepare(
      `SELECT * FROM runs
        WHERE repo_root = ? AND isolation = 'worktree'
          AND worktree_branch IN (${branches.map(() => "?").join(",")})
        ORDER BY created_at DESC`,
    )
    .all(repoRoot, ...branches) as RunRow[];
  for (const run of rows) {
    if (!found.has(run.worktree_branch!)) found.set(run.worktree_branch!, run);
  }
  return found;
}

/** One unmerged branch, with what its read needs. */
interface BranchRow {
  ref: UnmergedRef;
  /** The run that owns it and its chain, when a run recorded it here. */
  run: { owner: RunRow; chain: RunRow[] } | null;
}

/**
 * One branch's read: whether a squash landed it into the current branch, and
 * how many commits it has that the current branch lacks.
 *
 * A squash is landed work git cannot see, so `--no-merged` lists a
 * squash-landed `uf/*` branch for ever; `isLandedTip` is the existing rule for
 * it (the tip unmoved, the squash's commit still in the target) and is asked
 * here with the current branch as the target, which is the branch `--no-merged`
 * was measured against. A merge-landed branch never reaches this: its tip is an
 * ancestor, so `--no-merged` already left it out.
 *
 * Counted from the shas this request read rather than the names, so the count
 * is about the tip the row shows.
 */
async function readBranch(
  dir: string,
  current: { branch: string | null; head: string },
  row: BranchRow,
): Promise<{ landed: boolean; ahead: number | null }> {
  if (row.run && (await isLandedTip(dir, current.branch, row.run.chain, row.ref.tip, {}))) {
    return { landed: true, ahead: null };
  }
  const count = await git(dir, ["rev-list", "--count", `${current.head}..${row.ref.tip}`]);
  const ahead = count.ok ? Number.parseInt(count.stdout, 10) : NaN;
  return { landed: false, ahead: Number.isFinite(ahead) ? ahead : null };
}

function branchRows(dir: string, unmerged: readonly UnmergedRef[]): BranchRow[] {
  const runs = runsOn(dir, unmerged.map((u) => u.branch));
  return unmerged.map((ref) => {
    const newest = runs.get(ref.branch);
    if (!newest) return { ref, run: null };
    const chain = chainRuns(newest);
    const ownerId = branchOwnerOf(newest);
    return { ref, run: { owner: chain.find((r) => r.id === ownerId) ?? newest, chain } };
  });
}

function upstreamDTO(upstream: Upstream | null): ProjectUpstreamDTO | null {
  if (!upstream) return null;
  const url = upstream.urls[0] ?? null;
  const github = url?.startsWith("https://") ? parseRemote(url) : null;
  return {
    remote: upstream.remote,
    remoteRef: upstream.remoteRef,
    short: upstream.short,
    url: url === null ? null : redactUrl(url),
    pushUrls: upstream.pushUrls.map(redactUrl),
    github: github ? `${github.owner}/${github.repo}` : null,
  };
}

/** A project's row, from its read and whichever of its branches were read. */
function projectDTO(
  target: ProjectTarget,
  read: CheckoutRead,
  branches: ReadonlyArray<{ row: BranchRow; answer: { landed: boolean; ahead: number | null } }>,
  branchesNotRead: number,
): ProjectDTO {
  const facts = factsOf(target.dir, read);
  const push = planPush(facts, null);
  const fetch = planFetch(facts);

  const runBranches: ProjectRunBranchDTO[] = [];
  const otherBranches: ProjectBranchDTO[] = [];
  for (const { row, answer } of branches) {
    if (answer.landed) continue;
    const base = { ...row.ref, ahead: answer.ahead };
    if (!row.run) {
      otherBranches.push(base);
      continue;
    }
    const owner = row.run.owner;
    runBranches.push({
      ...base,
      runId: owner.id,
      runStatus: owner.status,
      target: owner.worktree_base_branch,
      task: owner.prompt.split("\n")[0].slice(0, 200),
    });
  }

  return {
    mountId: target.folder.mountId,
    folder: target.folder.path,
    name: target.folder.name,
    path: target.dir ?? "",
    error: read.error,
    branch: read.branch,
    head: read.head,
    detached: read.error === null && read.branch === null,
    operation: read.operation,
    uncommitted: read.uncommitted,
    upstream: upstreamDTO(read.upstream),
    remotes: read.remotes,
    ahead: read.ahead,
    behind: read.behind,
    fetchedAt: read.fetchedAt,
    unpushed: read.unpushed,
    credential: facts.credential.scope,
    holder: facts.holder,
    runBranches,
    otherBranches,
    branchesNotRead,
    push: push.ok
      ? { possible: true, code: null, reason: null }
      : { possible: false, code: push.code, reason: push.reason },
    fetch: fetch.ok
      ? { possible: true, code: null, reason: null }
      : { possible: false, code: fetch.code, reason: fetch.reason },
  };
}

/**
 * Read a set of projects in full, under one branch cap.
 *
 * Three passes, `branchInventory`'s shape. The checkouts are read under the
 * pool. Then, synchronously and before any branch read is dispatched,
 * `selectBranchReads` decides which unmerged branches this request pays for.
 * Then those are read under the pool. A folder that does not resolve, or whose
 * git fails, is a row with its error, never a missing one and never a failed
 * request.
 */
async function readProjects(targets: readonly ProjectTarget[]): Promise<ProjectDTO[]> {
  const reads = await mapWithLimit(targets, PROJECT_GIT_CONCURRENCY, (t) =>
    t.dir ? readCheckout(t.dir, true) : Promise.resolve(failed(t.error ?? "")),
  );

  const picks = selectBranchReads(
    reads.map((r) => r.unmerged.length),
    MAX_BRANCH_READS,
  );
  const pickedPer = targets.map(() => 0);
  for (const [p] of picks) pickedPer[p]++;

  // Joined to their runs only for the branches picked, and in the order
  // `--sort=-committerdate` gave, which `selectBranchReads` picked a prefix of.
  const rows = targets.map((t, p) =>
    t.dir ? branchRows(t.dir, reads[p].unmerged.slice(0, pickedPer[p])) : [],
  );
  const answers = await mapWithLimit(picks, PROJECT_GIT_CONCURRENCY, ([p, i]) =>
    readBranch(targets[p].dir!, { branch: reads[p].branch, head: reads[p].head! }, rows[p][i]),
  );

  const byProject = targets.map(
    () => [] as Array<{ row: BranchRow; answer: { landed: boolean; ahead: number | null } }>,
  );
  picks.forEach(([p, i], k) => byProject[p].push({ row: rows[p][i], answer: answers[k] }));
  for (const list of byProject) list.sort((a, b) => b.row.ref.tipAt - a.row.ref.tipAt);

  return targets.map((t, p) =>
    projectDTO(t, reads[p], byProject[p], reads[p].unmerged.length - pickedPer[p]),
  );
}

/**
 * Every git folder `scanWorkspace` finds, a page of them read.
 *
 * The folder walk is the picker's own, so the two cannot disagree about what a
 * project is. Mount roots are never projects, because the walk never lists one.
 */
export async function projectInventory(
  query: { offset?: number; limit?: number } = {},
): Promise<ProjectInventoryDTO> {
  const scan = await scanWorkspace();
  const page = selectProjectPage(
    scan.folders.filter((f) => f.isGitRepo),
    query,
  );
  return {
    projects: await readProjects(page.examined.map(targetOf)),
    mounts: scan.mounts,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    notShown: page.notShown,
  };
}

/* ------------------------------------------------------------------ */
/* The two presses                                                     */
/* ------------------------------------------------------------------ */

/** A project named on the wire, before anything about it is trusted. */
export interface ProjectRef {
  mountId: string;
  folder: string;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The fields every press names its project by, or the sentence refusing them.
 *
 * Checked before anything runs, `readDeliveryFields`' rule: a cast that failed
 * late failed after the remote had been touched.
 */
function requiredStrings<K extends string>(
  raw: Record<string, unknown>,
  keys: readonly K[],
  nothing: string,
): { ok: true; value: Record<K, string> } | { ok: false; error: string } {
  const value = {} as Record<K, string>;
  for (const key of keys) {
    const field = raw[key];
    if (typeof field !== "string" || field.trim() === "") {
      return {
        ok: false,
        error: `"${key}" has to be a non-empty string; got ${jsonKind(field)}. ${nothing}`,
      };
    }
    value[key] = field;
  }
  return { ok: true, value };
}

/** A Fetch body: `{ mountId, folder }`. */
export function readFetchFields(
  raw: Record<string, unknown>,
): { ok: true; value: ProjectRef } | { ok: false; error: string } {
  return requiredStrings(raw, ["mountId", "folder"], "Nothing was fetched.");
}

/**
 * A Push body: the project, and what the operator was shown — the branch, the
 * commit, and the upstream's remote and branch, so a push goes to the place the
 * screen named as well as sending what it named. The sha is checked for shape
 * because it is compared with HEAD and then handed to git as what the push
 * sends, and anything that is not a commit id has no business reaching either.
 */
export function readPushFields(
  raw: Record<string, unknown>,
): { ok: true; value: ProjectRef & Shown } | { ok: false; error: string } {
  const read = requiredStrings(
    raw,
    ["mountId", "folder", "branch", "sha", "remote", "remoteRef"],
    "Nothing was pushed.",
  );
  if (read.ok && !SHA.test(read.value.sha)) {
    return { ok: false, error: '"sha" has to be a full commit id in lowercase hex. Nothing was pushed.' };
  }
  return read;
}

/**
 * A project resolved inside its mount, or the 404 sentence.
 *
 * Only a git folder `scanWorkspace` lists, so these doors act on exactly what
 * the inventory shows: never a slot under `.uf-worktrees`, a `node_modules`, or
 * a checkout deeper than the walk goes. It costs one walk per press.
 */
async function resolveProject(
  ref: ProjectRef,
): Promise<{ ok: true; target: ProjectTarget } | { ok: false; reason: string }> {
  const listed = (await scanWorkspace()).folders.find(
    (f) => f.isGitRepo && f.mountId === ref.mountId && f.path === ref.folder,
  );
  if (!listed) {
    return { ok: false, reason: `${ref.folder} is not a git folder listed in the ${ref.mountId} mount.` };
  }
  const target = targetOf(listed);
  return target.dir ? { ok: true, target } : { ok: false, reason: target.error ?? "" };
}

export type PressOutcome<T> =
  | ({ ok: true; project: ProjectDTO } & T)
  | {
      ok: false;
      status: 404 | 409;
      reason: string;
      code?: ProjectPushRefusalDTO | ProjectFetchRefusalDTO;
      project?: ProjectDTO;
    }
  | { ok: false; status: 502; reason: string; code: "remote"; project: ProjectDTO };

/** One project's row as it stands now, for a press's answer. */
async function projectNow(target: ProjectTarget): Promise<ProjectDTO> {
  return (await readProjects([target]))[0];
}

/**
 * Shut-down refusal, read where nothing awaits before the push's spawn, as
 * `deliverRun` reads it: before it nothing has left the machine.
 */
const PUSH_SHUTDOWN_REFUSAL =
  "The server is shutting down, so nothing was pushed. Try again once it has restarted.";

/**
 * Push the checkout's current branch to its upstream: the commit the operator
 * was shown, as an ordinary fast-forward.
 *
 * Takes `landing` for the checkout first, `deliverRun`'s claim, so no land,
 * delivery or second push starts in it while this one decides and sends; when
 * something already holds it, the read still runs and `planPush` states the
 * refusal in its order, so one function says every no.
 *
 * Asks the remote before it pushes, with `ls-remote` on the one push URL, on
 * the same credential path: the counts are as of the last fetch, and without
 * this a branch deleted on the remote since would be created again by the push
 * (this module's fetch never prunes, so the stale tracking ref survives), and a
 * remote that moved would be found out only by its own refusal. Then the
 * checkout is read again and `planPush` asked with both, with nothing awaited
 * between that and the push's spawn.
 *
 * `<sha>:<upstream ref>` rather than the branch's name, so what leaves is the
 * commit `planPush` compared against what was shown, whatever HEAD does after.
 * `--no-follow-tags` and `--recurse-submodules=check` overrule the two configs
 * that would make one push carry more than that branch (`push.followTags`,
 * `push.recurseSubmodules=on-demand`). No `--set-upstream`, so `.git/config` is
 * not written.
 */
export async function pushProject(ref: ProjectRef, shown: Shown): Promise<PressOutcome<PushSent>> {
  const resolved = await resolveProject(ref);
  if (!resolved.ok) return { ok: false, status: 404, reason: resolved.reason };
  const { target } = resolved;

  const release = claimLanding(target.dir!);
  let sent: Awaited<ReturnType<typeof sendBranch>>;
  try {
    sent = await sendBranch(target.dir!, shown, release !== null);
  } finally {
    release?.();
  }
  // Read once the claim is let go, or the row would report this push's own
  // claim as something holding the checkout.
  if (sent.ok === null) return { ok: false, status: 409, reason: sent.reason };
  const project = await projectNow(target);
  if (!sent.ok) {
    return sent.code === "remote"
      ? { ok: false, status: 502, code: "remote", reason: sent.reason, project }
      : { ok: false, status: 409, code: sent.code, reason: sent.reason, project };
  }
  return { ok: true, ...sent.value, project };
}

/** What a push that went out reports, beside the project as it now stands. */
interface PushSent {
  branch: string;
  sha: string;
  remote: string;
  remoteRef: string;
  github: string;
  uncommitted: number | null;
  note: string | null;
}

/** The checkout's facts for a press, with this press's own claim not counted against it. */
async function factsNow(dir: string, claimed: boolean): Promise<{ read: CheckoutRead; facts: CheckoutFacts }> {
  const read = await readCheckout(dir, false);
  const facts = factsOf(dir, read);
  // Once this press holds `landing`, the holder `checkoutHolder` reports is
  // this press; what `planPush` is asked is whether anybody else held it.
  if (claimed) facts.holder = { ...facts.holder, landing: false };
  return { read, facts };
}

/**
 * What the remote has on the branch the push would update, from `ls-remote` on
 * the push URL. The commit's ancestry is read locally, so one this checkout has
 * never fetched reads as not contained, which is the honest answer: the push
 * would not be a fast-forward of anything it can see.
 */
async function remoteTipOf(
  dir: string,
  plan: Extract<PushPlan, { ok: true }>,
): Promise<{ ok: true; tip: RemoteTip } | { ok: false; reason: string }> {
  const listed = await git(dir, ["ls-remote", "--end-of-options", plan.pushUrl, plan.remoteRef], {
    ...NO_CLOCK,
    env: githubEnv(githubTokenFor(dir).token),
  });
  if (!listed.ok) {
    return {
      ok: false,
      reason:
        `${plan.remote} could not be asked where ${branchName(plan.remoteRef)} is: ` +
        `${gitFailureLine(listed.stderr) || "git gave no reason"}. Nothing was pushed.`,
    };
  }
  const line = listed.stdout
    .split("\n")
    .map((l) => l.split("\t"))
    .find(([, ref]) => ref === plan.remoteRef);
  const sha = line?.[0] ?? null;
  if (!sha) return { ok: true, tip: { sha: null, contained: false } };
  const contained =
    sha === plan.sha || (await git(dir, ["merge-base", "--is-ancestor", sha, plan.sha])).ok;
  return { ok: true, tip: { sha, contained } };
}

/**
 * The decision and the push, inside the claim. `ok: null` is a refusal that
 * read nothing worth showing back, which only the shutdown is.
 */
async function sendBranch(
  dir: string,
  shown: Shown,
  claimed: boolean,
): Promise<
  | { ok: true; value: PushSent }
  | { ok: false; code: ProjectPushRefusalDTO | "remote"; reason: string }
  | { ok: null; reason: string }
> {
  // Everything that can be refused without the remote is, before it is asked.
  const before = planPush((await factsNow(dir, claimed)).facts, shown);
  if (!before.ok) return { ok: false, code: before.code, reason: before.reason };
  const remote = await remoteTipOf(dir, before);
  if (!remote.ok) return { ok: false, code: "remote", reason: remote.reason };

  const { read, facts } = await factsNow(dir, claimed);
  const plan = planPush(facts, shown, remote.tip);
  if (!plan.ok) return { ok: false, code: plan.code, reason: plan.reason };
  // The remote was asked about one commit; a checkout read since that names
  // another has been refused as moved above, so this holds by construction.
  if (plan.sha !== before.sha || plan.pushUrl !== before.pushUrl) {
    return { ok: false, code: "moved", reason: "The checkout changed while the remote was asked. Nothing was pushed." };
  }
  if (isShuttingDown()) return { ok: null, reason: PUSH_SHUTDOWN_REFUSAL };

  const untrack = trackLand();
  let push: Awaited<ReturnType<typeof git>>;
  try {
    push = await git(
      dir,
      [
        "push",
        "--no-follow-tags",
        "--recurse-submodules=check",
        // The remote's name is the repository's own `branch.<name>.remote`, so
        // it is never let be read as an option.
        "--end-of-options",
        plan.remote,
        `${plan.sha}:${plan.remoteRef}`,
      ],
      { ...NO_CLOCK, env: githubEnv(githubTokenFor(dir).token) },
    );
  } finally {
    untrack();
  }
  if (!push.ok) {
    return {
      ok: false,
      code: "remote",
      reason:
        `${plan.remote} refused the push: ${gitFailureLine(push.stderr) || "git gave no reason"}. ` +
        "If the remote has moved since the last fetch, fetch, then pull or rebase by hand.",
    };
  }
  const left = read.uncommitted;
  return {
    ok: true,
    value: {
      branch: plan.branch,
      sha: plan.sha,
      remote: plan.remote,
      remoteRef: plan.remoteRef,
      github: `${plan.github.owner}/${plan.github.repo}`,
      uncommitted: left,
      note:
        left === null
          ? "Whether the checkout holds uncommitted work could not be read; a push sends commits only."
          : left > 0
            ? `${left} uncommitted path${left === 1 ? " was" : "s were"} not included: a push sends commits only.`
            : null,
    },
  };
}

/**
 * Fetch the checkout's upstream remote: a plain fetch, from a press only.
 *
 * `--no-prune` because a fetch is asked to bring news, not to delete
 * remote-tracking refs, and `fetch.prune` in the operator's config would
 * otherwise turn this into one that does. `--recurse-submodules=no` so it
 * fetches the one remote named and no submodule's, whose remotes need not be
 * GitHub. It takes no claim: what it writes is remote-tracking refs and
 * `FETCH_HEAD`, which no land, delivery or push reads to decide anything
 * written into the checkout.
 */
export async function fetchProject(
  ref: ProjectRef,
): Promise<PressOutcome<{ remote: string }>> {
  const resolved = await resolveProject(ref);
  if (!resolved.ok) return { ok: false, status: 404, reason: resolved.reason };
  const { target } = resolved;
  const dir = target.dir!;

  const read = await readCheckout(dir, false);
  const plan = planFetch(factsOf(dir, read));
  if (!plan.ok) {
    return {
      ok: false,
      status: 409,
      reason: plan.reason,
      code: plan.code,
      project: await projectNow(target),
    };
  }

  const fetched = await git(
    dir,
    ["fetch", "--no-prune", "--recurse-submodules=no", "--end-of-options", plan.remote],
    {
      ...NO_CLOCK,
      env: githubEnv(githubTokenFor(dir).token),
    },
  );
  const project = await projectNow(target);
  if (!fetched.ok) {
    return {
      ok: false,
      status: 502,
      code: "remote",
      reason: `${plan.remote} could not be fetched: ${gitFailureLine(fetched.stderr) || "git gave no reason"}.`,
      project,
    };
  }
  return { ok: true, remote: plan.remote, project };
}
