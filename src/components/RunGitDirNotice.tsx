"use client";

import Link from "next/link";
import {
  hooksPathEntryOf,
  type GitDirChangeDTO,
  type GitDirCommandClassDTO,
  type GitDirDTO,
  type GitDirFindingDTO,
} from "../lib/apiTypes";
import { fmtDateTime } from "../lib/format";
import { Notice } from "./ui/Notice";

/**
 * What a run left in its repository's git directory that the operator's own
 * git will run (`gitDirWatch.ts`).
 *
 * Drawn in two places, because the two are where the operator decides
 * something: the run page's state block, and the land card, which is the
 * moment they are about to go back to that checkout. Nothing in a branch, a
 * diff or Land shows these files otherwise. The land card draws only what
 * needs acting on; "nothing changed" is the run page's to say, so that a
 * clean run's card stays as it was.
 */

/** What the operator does that makes git run a key of this class. */
const RUNS_WHEN: Record<GitDirCommandClassDTO, string> = {
  fsmonitor: "runs on git status, diff and blame",
  "hooks-path": "chooses the directory git runs hooks from",
  "config-hook":
    "defines a hook that git 2.54 and later runs on the event it names, beside .git/hooks",
  "attribute-driver":
    "runs on the files an attributes file assigns it to, on status, diff, log -p and commit",
  "external-diff": "runs on git diff",
  remote: "runs on fetch, pull, push, clone or submodule update",
  signing: "runs when a commit or tag is signed, or a signature is shown",
  interactive:
    "runs when git pages output, opens an editor, starts a tool, adds a trailer or sends mail",
  alias: "runs when you type that alias, and outranks your own of the same name",
  include: "pulls another file's settings into this repository's",
};

const CHANGE_WORD: Record<GitDirChangeDTO, string> = {
  added: "added",
  removed: "removed",
  changed: "changed",
};

export type GitDirPlacement = "inspector" | "land";

/** The three reads `docs/security.md` gives, none of which runs anything it lists. */
function Inspect() {
  return (
    <>
      <code>git config --list --show-scope --show-origin</code>, <code>ls .git/hooks</code> or the
      directory a <code>core.hooksPath</code> there names, and <code>cat .git/info/attributes</code>
    </>
  );
}

function findingKey(finding: GitDirFindingDTO): string {
  if (finding.kind === "config") return `config:${finding.key}`;
  return finding.kind === "hook" ? `hook:${finding.name}` : "attributes";
}

function within(commonDir: string, file: string): string {
  return file.startsWith(`${commonDir}/`) ? file.slice(commonDir.length + 1) : file;
}

function ValueOf({
  finding,
  value,
  commonDir,
}: {
  finding: Extract<GitDirFindingDTO, { kind: "config" }>;
  value: Extract<GitDirFindingDTO, { kind: "config" }>["now"][number];
  commonDir: string;
}) {
  const shown =
    value.shown !== null ? (
      <code className="break-all">{value.shown}</code>
    ) : finding.key.startsWith("credential.") ? (
      "a credential helper, not shown because one may carry a token"
    ) : (
      "set with no value"
    );
  return (
    <li>
      {shown} <span className="text-ink-faint">in {within(commonDir, value.origin)}</span>
    </li>
  );
}

/**
 * An entry of the directory a `core.hooksPath` names. Its name is not always
 * a hook's — husky's stubs all source one file, `h` — so whether git runs it
 * by name and whether a hook there can run it are both said.
 */
function HooksPathRow({
  finding,
  dir,
  entry,
}: {
  finding: Extract<GitDirFindingDTO, { kind: "hook" }>;
  dir: string;
  entry: string;
}) {
  const where = (
    <>
      <span className="mono break-all">{dir}</span>, the directory <code>core.hooksPath</code> has
      git run hooks from
    </>
  );
  if (entry === ".") {
    return (
      <li>
        The directory <code>core.hooksPath</code> has git run hooks from,{" "}
        <span className="mono break-all">{dir}</span>, was itself {CHANGE_WORD[finding.change]}
      </li>
    );
  }
  if (entry === "…") {
    return <li>More entries in {where} than this app reads at once, so some were not compared</li>;
  }
  return (
    <li>
      <code>{entry}</code> {CHANGE_WORD[finding.change]} in {where}
      {finding.change !== "removed" &&
        (finding.executable
          ? " — git runs it on the command it is named for, and any hook there can run it"
          : " — not executable, so git does not run it as a hook, but a hook there can source it")}
    </li>
  );
}

/** What git runs hooks from that this app could not read, as the report words it. */
function NotRead({ notRead }: { notRead: string[] }) {
  return (
    <>
      {notRead.map((sentence) => (
        <p key={sentence} className="mt-2">
          {sentence}
        </p>
      ))}
    </>
  );
}

function FindingRow({ finding, commonDir }: { finding: GitDirFindingDTO; commonDir: string }) {
  if (finding.kind === "config") {
    return (
      <li>
        <code>{finding.key}</code> {CHANGE_WORD[finding.change]} — {RUNS_WHEN[finding.commandClass]}
        {finding.now.length > 0 && (
          <ul className="ml-4 list-disc">
            {finding.now.map((value, i) => (
              // Positions are what git orders values by, and the list is never
              // reordered in place: each report is drawn whole.
              <ValueOf key={i} finding={finding} value={value} commonDir={commonDir} />
            ))}
          </ul>
        )}
      </li>
    );
  }
  if (finding.kind === "hook") {
    const inHooksPath = hooksPathEntryOf(finding.name);
    if (inHooksPath) return <HooksPathRow finding={finding} {...inHooksPath} />;
    if (finding.name === ".") {
      return <li>The hooks directory itself was {CHANGE_WORD[finding.change]}</li>;
    }
    if (finding.name === "…") {
      return <li>More hooks than this app reads at once, so some were not compared</li>;
    }
    return (
      <li>
        Hook <code>{finding.name}</code> {CHANGE_WORD[finding.change]}
        {finding.change !== "removed" &&
          (finding.executable
            ? " — git runs it on the command it is named for"
            : ", not executable, so git skips it until it is")}
      </li>
    );
  }
  return (
    <li>
      <code>info/attributes</code> {CHANGE_WORD[finding.change]} — it assigns drivers to files
      {finding.driverLines.length > 0 && (
        <ul className="ml-4 list-disc">
          {finding.driverLines.map((line, i) => (
            <li key={i}>
              <code className="break-all">{line}</code>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function RunGitDirNotice({
  gitDir,
  settled,
  placement,
}: {
  gitDir: GitDirDTO | null | undefined;
  /** The run can no longer move, so a missing report is a comparison that never happened. */
  settled: boolean;
  placement: GitDirPlacement;
}) {
  if (!gitDir) return null;
  const { report } = gitDir;

  if (report === null) {
    if (!settled) return null;
    return (
      <Notice tone="warn" quiet className="mt-3">
        This run&apos;s repository git directory was read at its start and not compared at its end —
        the server stopped first, or the comparison failed and the log says why. Before you run git
        in that checkout, look: <Inspect />.
      </Notice>
    );
  }

  if (report.state === "unchanged" && report.notRead) {
    return (
      <Notice tone="warn" className="mt-3">
        <p>
          <strong>Part of where your own git runs hooks from was not checked.</strong> Nothing
          this app did read in <span className="mono break-all">{report.commonDir}</span> changed
          between{" "}
          {fmtDateTime(report.since)} and {fmtDateTime(report.checkedAt)}.
        </p>
        <NotRead notRead={report.notRead} />
        <p className="mt-2">
          Before you run git in that checkout, look: <Inspect />.
        </p>
      </Notice>
    );
  }

  if (report.state === "unchanged") {
    if (placement === "land") return null;
    return (
      <p className="mt-1 text-xs text-ink-muted">
        No setting, hook or attributes line your own git runs a command from changed in{" "}
        <span className="mono break-all">{report.commonDir}</span> while this run worked.
      </p>
    );
  }

  if (report.state === "unreadable") {
    return (
      <Notice tone="warn" className="mt-3">
        <strong>What this run left in its repository&apos;s git directory was not checked.</strong>{" "}
        {report.reason} Before you run git in that checkout, look: <Inspect />.
      </Notice>
    );
  }

  const others = report.concurrentRunIds;
  return (
    <Notice tone="warn" className="mt-3">
      <p>
        <strong>
          <span className="mono break-all">{report.commonDir}</span> changed where your own git runs
          commands from
        </strong>{" "}
        between {fmtDateTime(report.since)} and {fmtDateTime(report.checkedAt)}. None of it is in
        the branch, its diff or Land.
      </p>
      <ul className="my-2 ml-4 list-disc space-y-1">
        {report.findings.map((finding) => (
          <FindingRow key={findingKey(finding)} finding={finding} commonDir={report.commonDir} />
        ))}
      </ul>
      <p>
        {others.length === 0 ? (
          "No other run of this app worked in this repository in that time, so this run made the change unless you, the chat or another program did — this app cannot tell those apart."
        ) : (
          <>
            {others.length === 1 ? "Another run" : `${others.length} other runs`} of this app worked
            in this repository in that time, so it may be theirs:{" "}
            {others.map((id, i) => (
              <span key={id}>
                {i > 0 && ", "}
                <Link href={`/runs/${id}`} className="mono">
                  {id.slice(0, 8)}
                </Link>
              </span>
            ))}
            . Nor can this app tell any of it from a change of yours, the chat&apos;s or another
            program&apos;s.
          </>
        )}
      </p>
      {report.notRead && <NotRead notRead={report.notRead} />}
      <p className="mt-2">
        Before you run git in that checkout, look: <Inspect />.
      </p>
    </Notice>
  );
}
