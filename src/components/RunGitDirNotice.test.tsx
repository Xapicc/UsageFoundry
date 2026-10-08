import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RunGitDirNotice, type GitDirPlacement } from "./RunGitDirNotice";
import type { GitDirDTO, GitDirReportDTO } from "../lib/apiTypes";

/**
 * Which of a run's git-directory readings reach the operator, and where.
 *
 * Every state that is not "nothing changed" has to be drawn in both places,
 * and that is decided by early returns in this component and nothing else: a
 * report the land card skipped, or a baseline with no report that rendered as
 * nothing, would read exactly like a run that left the repository alone —
 * which is the one thing this check exists never to say without having read
 * twice. The other direction is the land card staying as it was for a clean
 * run, which is why "unchanged" is the run page's alone.
 */

const COMMON = "/workspace/repo/.git";

function gitDir(report: GitDirReportDTO | null): GitDirDTO {
  return { since: 1_000, commonDir: COMMON, report };
}

function render(dto: GitDirDTO | null, placement: GitDirPlacement, settled = true): string {
  return renderToStaticMarkup(
    <RunGitDirNotice gitDir={dto} settled={settled} placement={placement} />,
  );
}

const CHANGED: GitDirReportDTO = {
  state: "changed",
  commonDir: COMMON,
  since: 1_000,
  checkedAt: 2_000,
  findings: [
    {
      kind: "config",
      commandClass: "fsmonitor",
      key: "core.fsmonitor",
      change: "added",
      now: [{ scope: "local", origin: `${COMMON}/config`, shown: "touch /tmp/ran #" }],
    },
    {
      kind: "config",
      commandClass: "remote",
      key: "credential.helper",
      change: "added",
      now: [{ scope: "local", origin: `${COMMON}/config`, shown: null }],
    },
  ],
  concurrentRunIds: ["abcdef12-0000-0000-0000-000000000000"],
};

test("a change is drawn on the run page and on the land card, with what runs it", () => {
  for (const placement of ["inspector", "land"] as const) {
    const html = render(gitDir(CHANGED), placement);
    assert.match(html, /core\.fsmonitor<\/code> added/, placement);
    assert.match(html, /touch \/tmp\/ran #/, placement);
    assert.match(html, /href="\/runs\/abcdef12-0000-0000-0000-000000000000"/, placement);
    assert.match(html, /git config --list --show-scope --show-origin/, placement);
  }
});

test("a credential helper's text is never drawn", () => {
  const html = render(gitDir(CHANGED), "inspector");
  assert.match(html, /credential\.helper<\/code> added/);
  assert.match(html, /not shown because one may carry a token/);
});

test("a check that could not run is drawn in both places", () => {
  const report: GitDirReportDTO = {
    state: "unreadable",
    commonDir: COMMON,
    reason: "At the run's end: gone.",
    checkedAt: 2_000,
  };
  for (const placement of ["inspector", "land"] as const) {
    assert.match(
      render(gitDir(report), placement),
      /was not checked\..*At the run&#x27;s end: gone\./,
    );
  }
});

test("a settled run whose end never compared says so in both places", () => {
  for (const placement of ["inspector", "land"] as const) {
    assert.match(render(gitDir(null), placement), /not compared at its/, placement);
  }
  // Still going: the end has not happened, so there is nothing to say yet.
  assert.equal(render(gitDir(null), "inspector", false), "");
});

test("nothing changed is the run page's to say, and no baseline is nothing at all", () => {
  const report: GitDirReportDTO = {
    state: "unchanged",
    commonDir: COMMON,
    since: 1_000,
    checkedAt: 2_000,
  };
  assert.match(render(gitDir(report), "inspector"), /No setting, hook or attributes line/);
  assert.equal(render(gitDir(report), "land"), "");
  assert.equal(render(null, "inspector"), "");
  assert.equal(render(null, "land"), "");
});
