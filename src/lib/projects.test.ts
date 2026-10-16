import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_PROJECTS,
  parseBranchStatus,
  planFetch,
  planPush,
  readPushFields,
  redactUrl,
  selectBranchReads,
  selectProjectPage,
  type CheckoutFacts,
  type Shown,
} from "./projects";

/**
 * `planPush` is the decision in front of the one git call here that sends the
 * operator's own branch to somebody's remote, and every wrong answer it can give
 * is silent: a push that should have been refused succeeds, or fails at the
 * remote with a message about something else, and the button and the endpoint
 * disagree without either saying so. So each refusal is pinned against a
 * pushable baseline, and so is the order between the ones that can hold at
 * once, because the order is what each sentence assumes.
 *
 * `parseBranchStatus` and the two selections are here for the same bar: a
 * miscounted status or a selection that drops a project is a wrong number on a
 * page with nothing red anywhere.
 */

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

function facts(over: Partial<CheckoutFacts> = {}): CheckoutFacts {
  return {
    error: null,
    branch: "main",
    head: SHA,
    operation: null,
    upstream: {
      remote: "origin",
      remoteRef: "refs/heads/main",
      short: "origin/main",
      urls: ["https://github.com/acme/widgets.git"],
      pushUrls: ["https://github.com/acme/widgets.git"],
    },
    ahead: 3,
    behind: 0,
    credential: { scope: "repository", key: "widgets" },
    holder: { landing: false, runId: null },
    runBranch: null,
    ...over,
  };
}

const shown: Shown = { branch: "main", sha: SHA, remote: "origin", remoteRef: "refs/heads/main" };

function refusal(f: CheckoutFacts, s: Shown | null = shown, remote?: Parameters<typeof planPush>[2]): string {
  const plan = planPush(f, s, remote);
  assert.equal(plan.ok, false, "expected a refusal");
  return (plan as { code: string }).code;
}

describe("planPush", () => {
  it("pushes exactly the sha shown to the upstream's own ref", () => {
    const plan = planPush(facts(), shown);
    assert.deepEqual(plan, {
      ok: true,
      branch: "main",
      sha: SHA,
      remote: "origin",
      remoteRef: "refs/heads/main",
      pushUrl: "https://github.com/acme/widgets.git",
      github: { owner: "acme", repo: "widgets" },
    });
  });

  it("answers the button (nothing shown) the way it answers the press", () => {
    assert.equal(planPush(facts(), null).ok, true);
    assert.equal(refusal(facts({ behind: 1 }), null), "behind");
  });

  it("takes the install-wide token for a repository no entry names", () => {
    assert.equal(planPush(facts({ credential: { scope: "install", key: null } }), shown).ok, true);
  });

  it("refuses when HEAD moved off the sha that was shown", () => {
    assert.equal(refusal(facts({ head: OTHER })), "moved");
  });

  it("refuses when HEAD is on another branch at the same sha", () => {
    assert.equal(refusal(facts({ branch: "feature" })), "moved");
  });

  it("refuses a detached HEAD that was shown as a branch as moved, not as detached", () => {
    assert.equal(refusal(facts({ branch: null })), "moved");
    assert.equal(refusal(facts({ branch: null }), null), "detached");
  });

  it("refuses when the upstream is no longer the one that was shown", () => {
    const elsewhere = { ...facts().upstream!, remote: "fork" };
    assert.equal(refusal(facts({ upstream: elsewhere })), "moved");
    const otherRef = { ...facts().upstream!, remoteRef: "refs/heads/release" };
    assert.equal(refusal(facts({ upstream: otherRef })), "moved");
    assert.equal(refusal(facts({ upstream: null })), "moved");
  });

  it("never says moved without a shown state to compare against", () => {
    assert.equal(planPush(facts({ head: OTHER }), null).ok, true);
  });

  for (const operation of ["merge", "rebase", "bisect"] as const) {
    it(`refuses mid-${operation}, naming it before the detached HEAD it leaves`, () => {
      const plan = planPush(facts({ operation, branch: null }), null);
      assert.equal(plan.ok, false);
      assert.equal((plan as { code: string }).code, "operation");
      assert.match((plan as { reason: string }).reason, new RegExp(operation));
    });
  }

  it("refuses with no upstream, and says it never sets one", () => {
    const plan = planPush(facts({ upstream: null, ahead: null, behind: null }), null);
    assert.equal((plan as { code: string }).code, "no-upstream");
    assert.match((plan as { reason: string }).reason, /never creates or changes/);
  });

  it("refuses an upstream that is a local branch", () => {
    const upstream = { remote: ".", remoteRef: "refs/heads/dev", short: "dev", urls: [], pushUrls: [] };
    assert.equal(refusal(facts({ upstream }), { ...shown, remote: "." , remoteRef: "refs/heads/dev" }), "not-github");
  });

  it("refuses a remote that is not GitHub, or that git could not name", () => {
    const gitlab = { ...facts().upstream!, pushUrls: ["https://gitlab.com/acme/widgets.git"] };
    assert.equal(refusal(facts({ upstream: gitlab })), "not-github");
    assert.equal(refusal(facts({ upstream: { ...gitlab, pushUrls: [] } })), "not-github");
  });

  it("decides on where the push goes, not where a fetch would", () => {
    // A GitHub remote whose pushes a `pushurl` or `pushInsteadOf` sends
    // elsewhere: the credential would travel with the push.
    const redirected = { ...facts().upstream!, pushUrls: ["ssh://elsewhere.example/widgets.git"] };
    const plan = planPush(facts({ upstream: redirected }), shown);
    assert.equal((plan as { code: string }).code, "not-github");
    assert.match((plan as { reason: string }).reason, /elsewhere\.example/);
    assert.equal(planFetch(facts({ upstream: redirected })).ok, true);
  });

  it("refuses a remote with several push URLs, which git pushes to all of", () => {
    const two = {
      ...facts().upstream!,
      pushUrls: ["https://github.com/acme/widgets.git", "/srv/git/widgets.git"],
    };
    assert.equal(refusal(facts({ upstream: two })), "not-github");
    // A second GitHub URL is refused too: Push asks one remote what it has.
    const both = { ...two, pushUrls: [two.pushUrls[0], "https://github.com/acme/mirror.git"] };
    assert.equal(refusal(facts({ upstream: both })), "not-github");
  });

  it("accepts only an https GitHub URL, as git will use it after the rewrites", () => {
    // Each of these passed `parseRemote` once, or still does, and each reaches
    // GitHub by a transport that runs a program the repository can name.
    for (const url of [
      "git@github.com:acme/widgets.git",
      "ssh://git@github.com/acme/widgets.git",
      "git@github.com/acme/widgets.git",
      "http://github.com/acme/widgets.git",
      "https://elsewhere.example/@github.com/acme/widgets.git",
    ]) {
      const upstream = { ...facts().upstream!, urls: [url], pushUrls: [url] };
      assert.equal(refusal(facts({ upstream })), "not-github", url);
      assert.equal((planFetch(facts({ upstream })) as { code?: string }).code, "not-github", url);
    }
  });

  it("names a refused URL without the credentials written into it", () => {
    const url = "https://x-access-token:ghp_secret@gitlab.com/acme/widgets.git";
    const plan = planPush(facts({ upstream: { ...facts().upstream!, pushUrls: [url] } }), shown);
    assert.doesNotMatch((plan as { reason: string }).reason, /ghp_secret|x-access-token/);
    assert.equal(redactUrl(url), "https://gitlab.com/acme/widgets.git");
    assert.equal(redactUrl("git@github.com:acme/widgets.git"), "git@github.com:acme/widgets.git");
  });

  it("refuses a run's branch, which leaves by Deliver", () => {
    const run = { branch: "uf/widgets-1-abcdef12", runBranch: { runId: "abcdef1234567890" } };
    const plan = planPush(facts(run), { ...shown, branch: run.branch });
    assert.equal((plan as { code: string }).code, "run-branch");
    assert.match((plan as { reason: string }).reason, /run abcdef12's branch.*Deliver/);
    assert.equal(refusal(facts({ runBranch: { runId: null } }), null), "run-branch");
  });

  it("refuses with no credential at all", () => {
    assert.equal(refusal(facts({ credential: { scope: "none", key: null } })), "no-credential");
  });

  it("refuses a repository configured to get none, naming its entry", () => {
    const plan = planPush(facts({ credential: { scope: "none", key: "widgets" } }), shown);
    assert.equal((plan as { code: string }).code, "no-credential");
    assert.match((plan as { reason: string }).reason, /\(widgets\) gives it no credential/);
  });

  it("refuses while a land, delivery or other push holds the checkout", () => {
    assert.equal(refusal(facts({ holder: { landing: true, runId: null } })), "busy");
  });

  it("refuses while a run works in the folder, naming it", () => {
    const plan = planPush(facts({ holder: { landing: false, runId: "1234567890abcdef" } }), shown);
    assert.equal((plan as { code: string }).code, "busy");
    assert.match((plan as { reason: string }).reason, /Run 12345678/);
  });

  it("refuses when ahead and behind could not be counted", () => {
    assert.equal(refusal(facts({ ahead: null, behind: null })), "uncounted");
  });

  it("refuses a branch behind its upstream, even when it is also ahead", () => {
    const plan = planPush(facts({ ahead: 2, behind: 1 }), shown);
    assert.equal((plan as { code: string }).code, "behind");
    assert.match((plan as { reason: string }).reason, /pull or rebase by hand/);
  });

  it("refuses when there is nothing the upstream lacks", () => {
    assert.equal(refusal(facts({ ahead: 0 })), "nothing-to-push");
  });

  it("refuses a branch with no commits yet as nothing to push", () => {
    assert.equal(refusal(facts({ head: null, ahead: null, behind: null }), null), "nothing-to-push");
  });

  it("refuses, once the remote is asked, a branch deleted there, rather than creating it", () => {
    assert.equal(refusal(facts(), shown, { sha: null, contained: false }), "upstream-gone");
  });

  it("refuses, once the remote is asked, a remote that moved past what was fetched", () => {
    assert.equal(refusal(facts(), shown, { sha: OTHER, contained: false }), "behind");
    assert.equal(refusal(facts(), shown, { sha: SHA, contained: true }), "nothing-to-push");
    assert.equal(planPush(facts(), shown, { sha: OTHER, contained: true }).ok, true);
  });

  it("asks the remote only after everything it can refuse without it", () => {
    assert.equal(refusal(facts({ behind: 2 }), shown, { sha: null, contained: false }), "behind");
    assert.equal(refusal(facts({ ahead: 0 }), shown, { sha: null, contained: false }), "nothing-to-push");
  });

  it("refuses an unreadable checkout before anything else", () => {
    assert.equal(
      refusal(facts({ error: "fatal: not a git repository", head: OTHER, behind: 4 })),
      "unreadable",
    );
  });

  it("says moved before every refusal about the state that was not shown", () => {
    assert.equal(
      refusal(
        facts({
          head: OTHER,
          operation: "rebase",
          upstream: null,
          credential: { scope: "none", key: null },
          holder: { landing: true, runId: null },
          behind: 2,
        }),
      ),
      "moved",
    );
  });

  it("orders the standing refusals ahead of the busy ones, and busy ahead of the counts", () => {
    assert.equal(
      refusal(facts({ credential: { scope: "none", key: null }, holder: { landing: true, runId: null } })),
      "no-credential",
    );
    assert.equal(refusal(facts({ holder: { landing: true, runId: null }, behind: 3 })), "busy");
  });

  it("does not refuse over uncommitted paths, which it has no input for", () => {
    // `CheckoutFacts` carries no uncommitted count on purpose: a push sends
    // commits, and the press's answer says what it left behind instead.
    assert.equal("uncommitted" in facts(), false);
  });
});

describe("planFetch", () => {
  it("fetches the upstream's remote", () => {
    assert.deepEqual(planFetch(facts()), {
      ok: true,
      remote: "origin",
      github: { owner: "acme", repo: "widgets" },
    });
  });

  it("names the operation when a rebase or bisect is why there is no branch to fetch for", () => {
    const plan = planFetch(facts({ branch: null, operation: "rebase" }));
    assert.equal((plan as { code: string }).code, "detached");
    assert.match((plan as { reason: string }).reason, /rebase in progress.*git rebase --abort/);
  });

  it("is not refused by what refuses a push but writes nothing a fetch touches", () => {
    for (const over of [
      { runBranch: { runId: "r" } },
      { operation: "merge" as const },
      { holder: { landing: true, runId: "r" } },
      { behind: 5 },
      { ahead: 0 },
      { ahead: null, behind: null },
    ]) {
      assert.equal(planFetch(facts(over)).ok, true, JSON.stringify(over));
    }
  });

  it("shares push's standing refusals", () => {
    const code = (f: CheckoutFacts) => (planFetch(f) as { code?: string }).code;
    assert.equal(code(facts({ error: "x" })), "unreadable");
    assert.equal(code(facts({ branch: null })), "detached");
    assert.equal(code(facts({ upstream: null })), "no-upstream");
    assert.equal(code(facts({ upstream: { ...facts().upstream!, urls: ["/srv/git/widgets.git"] } })), "not-github");
    assert.equal(code(facts({ credential: { scope: "none", key: "widgets" } })), "no-credential");
  });
});

describe("readPushFields", () => {
  const body = { mountId: "workspace", folder: "widgets", ...shown };

  it("reads a whole body", () => {
    assert.deepEqual(readPushFields(body), { ok: true, value: body });
  });

  it("refuses a missing or non-string field, and a sha that is not one", () => {
    assert.equal(readPushFields({ ...body, branch: undefined }).ok, false);
    assert.equal(readPushFields({ ...body, remoteRef: undefined }).ok, false);
    assert.equal(readPushFields({ ...body, folder: 5 }).ok, false);
    assert.equal(readPushFields({ ...body, sha: "HEAD" }).ok, false);
    assert.equal(readPushFields({ ...body, sha: SHA.toUpperCase() }).ok, false);
    assert.equal(readPushFields({ ...body, sha: `${SHA}:refs/heads/x` }).ok, false);
  });
});

describe("parseBranchStatus", () => {
  it("reads the branch headers and counts every kind of entry", () => {
    const raw = [
      `# branch.oid ${SHA}`,
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +4 -2",
      "1 .M N... 100644 100644 100644 x y edited.ts",
      "u UU N... 100644 100644 100644 100644 x y z conflicted.ts",
      "? new.txt",
      "",
    ].join("\0");
    assert.deepEqual(parseBranchStatus(raw), {
      head: SHA,
      branch: "main",
      upstream: "origin/main",
      ahead: 4,
      behind: 2,
      uncommitted: 3,
    });
  });

  it("consumes a rename's source path rather than counting it", () => {
    // The source path is the next NUL field and begins with what would read
    // as an untracked entry if it were taken for a record.
    const raw = [
      `# branch.oid ${SHA}`,
      "# branch.head main",
      "2 R. N... 100644 100644 100644 x y R100 renamed.ts",
      "? looks-untracked.ts",
      "",
    ].join("\0");
    assert.equal(parseBranchStatus(raw).uncommitted, 1);
  });

  it("reads a detached HEAD, a branch with no commits, and an upstream whose ref is gone", () => {
    assert.equal(parseBranchStatus(`# branch.oid ${SHA}\0# branch.head (detached)\0`).branch, null);
    const unborn = parseBranchStatus("# branch.oid (initial)\0# branch.head main\0");
    assert.equal(unborn.head, null);
    assert.equal(unborn.branch, "main");
    const gone = parseBranchStatus(`# branch.oid ${SHA}\0# branch.head main\0# branch.upstream origin/main\0`);
    assert.equal(gone.upstream, "origin/main");
    assert.equal(gone.ahead, null);
    assert.equal(gone.behind, null);
  });
});

describe("selectBranchReads", () => {
  it("takes round-robin so one repository cannot spend the whole cap", () => {
    assert.deepEqual(selectBranchReads([5, 1, 2], 5), [
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
      [2, 1],
    ]);
  });

  it("reads everything under the cap, and a prefix of each project's list", () => {
    const picks = selectBranchReads([3, 0, 2], 100);
    assert.equal(picks.length, 5);
    for (const p of [0, 2]) {
      const depths = picks.filter(([q]) => q === p).map(([, d]) => d);
      assert.deepEqual(depths, [...depths.keys()]);
    }
  });

  it("reads nothing with nothing to read", () => {
    assert.deepEqual(selectBranchReads([], 10), []);
    assert.deepEqual(selectBranchReads([0, 0], 10), []);
  });
});

describe("selectProjectPage", () => {
  const folders = Array.from({ length: MAX_PROJECTS + 7 }, (_, i) => i);

  it("caps the page and counts what it left out over every folder", () => {
    const page = selectProjectPage(folders);
    assert.equal(page.examined.length, MAX_PROJECTS);
    assert.equal(page.total, MAX_PROJECTS + 7);
    assert.equal(page.notShown, 7);
  });

  it("reaches the rest by offset, and clamps an offset past the end", () => {
    assert.deepEqual(selectProjectPage(folders, { offset: MAX_PROJECTS }).examined, [
      ...folders.slice(MAX_PROJECTS),
    ]);
    assert.equal(selectProjectPage(folders, { offset: 10_000 }).offset, folders.length - 1);
  });

  it("reads a nonsense limit as the default page", () => {
    assert.equal(selectProjectPage(folders, { limit: Number.NaN }).limit, MAX_PROJECTS);
    assert.equal(selectProjectPage(folders, { limit: -3 }).limit, MAX_PROJECTS);
    assert.equal(selectProjectPage(folders, { limit: 5 }).limit, 5);
  });
});
