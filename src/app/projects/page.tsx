"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import type {
  ProjectBranchDTO,
  ProjectDTO,
  ProjectFetchResponse,
  ProjectInventoryDTO,
  ProjectPushResponse,
  ProjectRefusalResponse,
  ProjectRunBranchDTO,
} from "@/lib/apiTypes";
import {
  STATUS_LABEL,
  STATUS_TONE,
  fmtDate,
  fmtDateTime,
  pollFailureMessage,
  shortId,
} from "@/lib/format";
import { actionFailureMessage, jsonRequest } from "@/lib/jsonRequest";
import { ChatPanel } from "@/components/ChatPanel";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty, SkeletonText } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { Hint, type HintTone } from "@/components/ui/Hint";
import { ListGroup } from "@/components/ui/List";
import { Notice } from "@/components/ui/Notice";
import { Sheet } from "@/components/ui/Sheet";

/**
 * Every git folder in the mounts: the branch the operator stands on in each,
 * how far it is from its upstream, and what is not merged into it.
 *
 * `/branches` is a run's branch's door; this is the operator's own checkout's.
 * It offers two presses and no more — Fetch, and Push of the current branch —
 * because Land, Delete and Purge exist only for a run's branch, and a second
 * copy of them here would split their refusal rules across two pages. A run's
 * branch listed here links to `/branches` instead.
 *
 * Not polled, for `/branches`' reason: a page of projects is a few hundred git
 * children and nothing in it changes on its own. It is read on load, once after
 * each press, and on Refresh.
 *
 * Every refusal is `planPush`'s or `planFetch`'s sentence, drawn where the
 * button would be. The inventory asks the same function the endpoint does, so
 * the page never offers a press the server would refuse for a reason it could
 * already see; what only the press can find out — the remote's own answer — is
 * drawn in the same place once it comes back.
 *
 * The orchestrator beside the list is `/chat`'s own panel, in its column
 * layout. "Ask the orchestrator" drafts a message naming the row and never
 * sends it: a turn is spend, and what the chat is asked is the operator's to
 * read first. The chat reads this list through `list_projects`, which is
 * `projectInventory` too, so the two cannot disagree about a row — and it can
 * propose the work a row needs but cannot press either door.
 */

const PRESS_FALLBACK = {
  push: "The push did not go through.",
  fetch: "The fetch did not go through.",
} as const;

type Door = "push" | "fetch";

/** The last press's answer on a row. */
interface Answer {
  door: Door;
  /** A refusal stands where its door's button was; a success is a line beside them. */
  refused: boolean;
  tone: HintTone;
  text: string;
}

const keyOf = (p: { mountId: string; folder: string }) => `${p.mountId}\0${p.folder}`;
const shortSha = (sha: string) => sha.slice(0, 8);
const branchName = (ref: string) => ref.replace(/^refs\/heads\//, "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const rest = { ...record };
  delete rest[key];
  return rest;
}

/**
 * Something to push first, then something unmerged, then the rest, each in the
 * order the server listed them. Within one page: the server reads a page
 * before it can know which rows these are.
 */
function rank(p: ProjectDTO): number {
  if ((p.ahead ?? 0) > 0) return 0;
  if (p.runBranches.length + p.otherBranches.length + p.branchesNotRead > 0) return 1;
  return 2;
}

export default function Projects() {
  const [data, setData] = useState<ProjectInventoryDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  // A press in flight per row. Rows are independent checkouts, so a fetch of
  // one does not wait on a push of another.
  const [busy, setBusy] = useState<Record<string, Door>>({});
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [announcement, setAnnouncement] = useState("");
  // The row as it was when Push was pressed. The sheet states it and the press
  // sends it, so a re-read landing while the sheet is open cannot change what
  // is confirmed out from under the operator.
  const [confirming, setConfirming] = useState<ProjectDTO | null>(null);
  // What "Ask the orchestrator" last put in the panel's composer; a new object
  // per press, which is what the panel reads as a new request.
  const [ask, setAsk] = useState<{ text: string } | null>(null);

  /** Which inventory read is allowed to write; see `load`. */
  const inventoryRequest = useRef(0);

  const load = useCallback(async () => {
    // Only the newest read may write: a press's re-read, Refresh and a page
    // change can all be out together, and a press's own answer moves the
    // ticket as it draws its row.
    const ticket = ++inventoryRequest.current;
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (offset > 0) query.set("offset", String(offset));
      const res = await fetch(`/api/projects?${query}`, { cache: "no-store" });
      // Parsed before the status check: a 500 carries no JSON, and letting that
      // throw would report a reachable server as an unreachable one.
      const json = (await res.json().catch(() => ({}))) as Partial<
        ProjectInventoryDTO & { error: string }
      >;
      if (ticket !== inventoryRequest.current) return;
      if (!res.ok || !json.projects) {
        const detail = json.error ?? (res.ok ? "no projects in the response" : null);
        setReadError(pollFailureMessage(res.status, detail));
        return;
      }
      setData(json as ProjectInventoryDTO);
      setReadError(null);
    } catch (err) {
      if (ticket !== inventoryRequest.current) return;
      setReadError(pollFailureMessage(null, err instanceof Error ? err.message : String(err)));
    } finally {
      if (ticket === inventoryRequest.current) setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Refresh is the operator asking afresh, so the last answers go with it. */
  function refresh() {
    setAnswers({});
    void load();
  }

  /** A press's own answer carries its row as it now stands; draw it at once. */
  function drawRow(project: ProjectDTO) {
    inventoryRequest.current++;
    setLoading(false);
    setData((prev) =>
      prev && {
        ...prev,
        projects: prev.projects.map((p) => (keyOf(p) === keyOf(project) ? project : p)),
      },
    );
  }

  /**
   * One press on one row: Fetch, or Push of the row the sheet showed.
   *
   * Through `jsonRequest` so a request that never came back is said rather than
   * dropped — it may still have been carried out, which is the one thing a
   * press that sends something to a remote must never leave unsaid.
   */
  async function press(p: ProjectDTO, door: Door) {
    const key = keyOf(p);
    setBusy((prev) => ({ ...prev, [key]: door }));
    setAnswers((prev) => without(prev, key));
    try {
      let answer: Answer;
      let project: ProjectDTO | undefined;
      if (door === "push") {
        const res = await jsonRequest<ProjectPushResponse>("/api/projects/push", {
          method: "POST",
          body: {
            mountId: p.mountId,
            folder: p.folder,
            branch: p.branch,
            sha: p.head,
            remote: p.upstream?.remote,
            remoteRef: p.upstream?.remoteRef,
          },
        });
        if (res.ok) {
          const sent = res.data;
          project = sent.project;
          answer = {
            door,
            refused: false,
            tone: "neutral",
            text:
              `Pushed ${shortSha(sent.sha)} to ${branchName(sent.remoteRef)} on ${sent.remote}.` +
              (sent.note ? ` ${sent.note}` : ""),
          };
        } else {
          project = (res.body as ProjectRefusalResponse | undefined)?.project;
          answer = failedAnswer(door, res.status, actionFailureMessage(res, PRESS_FALLBACK.push));
        }
      } else {
        const res = await jsonRequest<ProjectFetchResponse>("/api/projects/fetch", {
          method: "POST",
          body: { mountId: p.mountId, folder: p.folder },
        });
        if (res.ok) {
          project = res.data.project;
          answer = { door, refused: false, tone: "neutral", text: `Fetched ${res.data.remote}.` };
        } else {
          project = (res.body as ProjectRefusalResponse | undefined)?.project;
          answer = failedAnswer(door, res.status, actionFailureMessage(res, PRESS_FALLBACK.fetch));
        }
      }
      setAnswers((prev) => ({ ...prev, [key]: answer }));
      setAnnouncement(`${p.name}: ${answer.text}`);
      if (project) drawRow(project);
      // Read again either way: a request that never came back may still have
      // been carried out, and the list is where the operator finds out.
      await load();
    } finally {
      setBusy((prev) => without(prev, key));
    }
  }

  const sorted = useMemo(
    () =>
      (data?.projects ?? [])
        .map((p, i) => ({ p, i }))
        .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
        .map(({ p }) => p),
    [data],
  );
  const mountLabel = useMemo(
    () => new Map((data?.mounts ?? []).map((m) => [m.id, m.label])),
    [data],
  );
  const missingMounts = (data?.mounts ?? []).filter((m) => !m.available);

  return (
    <>
      <div className="mb-6">
        <h1 className="mb-1 text-xl font-semibold tracking-tight">Project manager</h1>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <div role="alert">{readError && <Notice tone="danger">{readError}</Notice>}</div>

      {/* The orchestrator beside the list from `xl` and under it below, where
          beside it would leave the list too narrow for a path. `min-w-0` is
          what lets the list's column narrow for the panel rather than push it
          off the pane; the panel's column is about `/chat`'s own 360px proposal
          column plus the room its thread needs to be read in. */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_26rem] xl:items-start">
        <div className="min-w-0">
          {missingMounts.length > 0 && (
            <Notice tone="warn" quiet>
              {missingMounts.map((m) => (
                <div key={m.id}>
                  <strong>{m.label}</strong> is not there, so none of its projects are listed
                  {m.error ? `: ${m.error}` : "."}
                </div>
              ))}
            </Notice>
          )}

          <Card emphasis="default">
            <CardTitle>
              {data ? plural(data.total, "project") : "Projects"}
              <Button
                variant="secondary"
                className="ml-auto min-w-[104px]"
                onClick={refresh}
                disabled={loading}
              >
                {loading ? "Reading…" : "Refresh"}
              </Button>
            </CardTitle>

            {data && data.total > data.limit && (
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <span className="text-sm tabular-nums text-ink-muted">
                  {data.offset + 1}–{data.offset + data.projects.length} of {data.total}
                </span>
                <ButtonRow className="ml-auto">
                  <Button
                    variant="secondary"
                    disabled={loading || data.offset === 0}
                    onClick={() => setOffset(Math.max(0, data.offset - data.limit))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={loading || data.offset + data.limit >= data.total}
                    onClick={() => setOffset(data.offset + data.limit)}
                  >
                    Next
                  </Button>
                </ButtonRow>
              </div>
            )}

            {loading && !data ? (
              <div aria-busy="true">
                <span className="sr-only">Reading projects…</span>
                <SkeletonText lines={6} />
              </div>
            ) : !data ? (
              // "No projects" is a claim about the mounts, and making it off the
              // back of a failed read is the lie the notice above exists to stop.
              <Empty>
                <span className="text-ink-muted">Nothing could be read from the mounts.</span>
              </Empty>
            ) : sorted.length === 0 ? (
              <Empty>
                <div className="font-medium text-ink">
                  {data.total > 0 ? "None on this page" : "No git folders in the mounts"}
                </div>
                {data.total === 0 && (
                  <div className="mx-auto mt-1 max-w-[52ch] text-ink-muted">
                    A project is a folder holding a <span className="mono">.git</span> that the
                    folder picker lists.
                  </div>
                )}
              </Empty>
            ) : (
              <ul className="divide-y divide-line">
                {sorted.map((p) => (
                  <ProjectRow
                    key={keyOf(p)}
                    p={p}
                    mount={mountLabel.get(p.mountId) ?? p.mountId}
                    busy={busy[keyOf(p)] ?? null}
                    answer={answers[keyOf(p)] ?? null}
                    onFetch={() => void press(p, "fetch")}
                    onPush={() => setConfirming(p)}
                    onAsk={() => setAsk({ text: askAbout(p) })}
                  />
                ))}
              </ul>
            )}
          </Card>
        </div>

        <ChatPanel layout="column" compose={ask} />
      </div>

      {/* Always rendered, never conditionally mounted — see `Sheet`. `danger`,
          so it opens with Cancel focused: one Return is not a confirmation for
          something that cannot be taken back. */}
      <Sheet
        open={confirming !== null}
        onDismiss={() => setConfirming(null)}
        title={
          confirming && (
            <>
              Push <span className="mono">{confirming.branch}</span> to{" "}
              <span className="mono">{confirming.upstream?.remote}</span>?
            </>
          )
        }
        confirmLabel="Push"
        confirmVariant="danger"
        onConfirm={() => {
          const shown = confirming;
          setConfirming(null);
          if (shown) void press(shown, "push");
        }}
      >
        {confirming && <PushSummary p={confirming} />}
      </Sheet>
    </>
  );
}

/**
 * The message "Ask the orchestrator" drafts. It names the project as
 * `mountId:folder`, the form `list_folders` and `list_projects` both speak, so
 * the chat finds the row without guessing which mount a bare name is on.
 */
function askAbout(p: ProjectDTO): string {
  return (
    `Look at project ${p.mountId}:${p.folder} — what is unmerged there, ` +
    "what would a push send, and does any of it need a run?"
  );
}

/** A press that did not go through, said where its door's button was. */
function failedAnswer(door: Door, status: number | null, text: string): Answer {
  // 409 is a refusal, decided before anything left: a state to change, not a
  // fault. Anything else — the remote refused, the folder went, the request
  // never came back — is a failure, and may have left something half done.
  return { door, refused: true, tone: status === 409 ? "warn" : "danger", text };
}

/** What the sheet states before a push: where, which commits, and what stays home. */
function PushSummary({ p }: { p: ProjectDTO }) {
  const upstream = p.upstream;
  if (!upstream || !p.head || !p.branch) return null;
  const ahead = p.ahead ?? p.unpushed.length;
  const left = Math.max(0, ahead - p.unpushed.length);
  const where = upstream.github ? `github.com/${upstream.github}` : (upstream.pushUrls[0] ?? upstream.url);

  return (
    <>
      <p>
        Sends {plural(ahead, "commit")} on <span className="mono">{p.branch}</span>, up to{" "}
        <span className="mono">{shortSha(p.head)}</span>, to{" "}
        <span className="mono">{branchName(upstream.remoteRef)}</span> on{" "}
        <span className="mono">{upstream.remote}</span>
        {where && (
          <>
            {" "}
            (<span className="mono break-all">{where}</span>)
          </>
        )}
        :
      </p>
      <ul className="mt-2 space-y-1">
        {p.unpushed.map((c) => (
          <li key={c.sha} className="flex min-w-0 gap-2">
            <span className="mono shrink-0 text-ink-faint">{shortSha(c.sha)}</span>
            <span className="min-w-0 break-words text-ink">{c.subject}</span>
          </li>
        ))}
      </ul>
      {left > 0 && (
        <p className="mt-1">
          and {plural(left, "earlier commit")} not listed.
        </p>
      )}
      <p className="mt-3">
        {p.uncommitted === null
          ? "Uncommitted changes are not included."
          : p.uncommitted === 0
            ? "Uncommitted changes are not included; this checkout has none."
            : `Uncommitted changes are not included: ${plural(p.uncommitted, "path")} in this checkout stay${p.uncommitted === 1 ? "s" : ""} here.`}
      </p>
      <p className="mt-3 font-medium text-ink">
        This publishes them to GitHub, and a push cannot be taken back.
      </p>
    </>
  );
}

function ProjectRow({
  p,
  mount,
  busy,
  answer,
  onFetch,
  onPush,
  onAsk,
}: {
  p: ProjectDTO;
  mount: string;
  busy: Door | null;
  answer: Answer | null;
  onFetch: () => void;
  onPush: () => void;
  /** Drafts a message about this project in the panel; never sends one. */
  onAsk: () => void;
}) {
  const unmerged = p.runBranches.length + p.otherBranches.length;
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-medium text-ink">{p.name}</span>
        <span className="mono min-w-0 break-all text-xs text-ink-muted">
          {mount} / {p.folder}
        </span>
        {p.operation && <Badge tone="warn">{p.operation} in progress</Badge>}
        {/* On every row, an unreadable one included: why a checkout cannot be
            read is a fair thing to ask about. */}
        <Button variant="ghost" size="compact" className="ml-auto" onClick={onAsk}>
          Ask the orchestrator
        </Button>
      </div>

      {p.error !== null ? (
        // The doors' own sentences would each repeat this with "so it cannot
        // be pushed" in front; the row says it once.
        <Hint tone="danger" className="mono break-all">
          Could not read this checkout: {p.error}
        </Hint>
      ) : (
        <>
          <CheckoutFacts p={p} />
          <Doors p={p} busy={busy} answer={answer} onFetch={onFetch} onPush={onPush} />
          {(unmerged > 0 || p.branchesNotRead > 0) && (
            <Disclosure
              summary="Unmerged branches"
              count={unmerged + p.branchesNotRead}
              className="mt-2 text-sm"
            >
              <UnmergedBranches p={p} />
            </Disclosure>
          )}
        </>
      )}
    </li>
  );
}

/** Branch, upstream and counts, then where the remote is. */
function CheckoutFacts({ p }: { p: ProjectDTO }) {
  const facts: ReactNode[] = [];

  facts.push(
    p.branch ? (
      <span key="branch">
        <span className="mono break-all text-ink">{p.branch}</span>
        {p.head === null && <span className="text-ink-muted"> (no commits yet)</span>}
      </span>
    ) : (
      <span key="branch" className="text-ink">
        detached{p.head && <> at <span className="mono">{shortSha(p.head)}</span></>}
      </span>
    ),
  );

  if (p.upstream) {
    facts.push(
      <span key="counts">
        {p.ahead === null || p.behind === null ? (
          <span className="text-ink-muted">
            not counted against <span className="mono break-all">{p.upstream.short}</span>
          </span>
        ) : (
          <>
            <span className={p.ahead > 0 ? "font-medium text-ink" : ""}>{p.ahead} ahead</span>,{" "}
            <span className={p.behind > 0 ? "font-medium text-ink" : ""}>{p.behind} behind</span>{" "}
            <span className="mono break-all">{p.upstream.short}</span>
          </>
        )}{" "}
        <span className="text-ink-muted">
          {/* The counts are against the local tracking ref, so they are only as
              fresh as the last fetch — and a count with no time beside it reads
              as now. */}
          {p.fetchedAt === null ? "· never fetched" : `· as of ${fmtDateTime(p.fetchedAt)}`}
        </span>
      </span>,
    );
  }

  facts.push(
    <span key="uncommitted">
      {p.uncommitted === null
        ? "uncommitted not read"
        : p.uncommitted === 0
          ? "nothing uncommitted"
          : `${p.uncommitted} uncommitted`}
    </span>,
  );

  return (
    <>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm tabular-nums text-ink-muted">
        {facts}
      </div>
      <div className="mt-0.5 min-w-0 text-xs text-ink-muted">
        <RemoteLine p={p} />
      </div>
    </>
  );
}

/** Where a push or fetch would go, or why there is nowhere. */
function RemoteLine({ p }: { p: ProjectDTO }) {
  const upstream = p.upstream;
  if (!upstream) {
    if (p.remotes === null || p.remotes.length === 0) {
      return <span className="text-ink">No remote</span>;
    }
    return (
      <>
        No upstream · remote{p.remotes.length === 1 ? "" : "s"}{" "}
        <span className="mono break-all">{p.remotes.join(", ")}</span>
      </>
    );
  }
  if (upstream.remote === ".") return <>Tracks a local branch, not a remote</>;
  return (
    <>
      <span className="mono">{upstream.remote}</span>{" "}
      <span className="mono break-all">{upstream.url ?? "has no URL git could name"}</span>
    </>
  );
}

/**
 * Fetch and Push, each a button or the sentence saying why not.
 *
 * A refusal stands where its button would be rather than beside a disabled
 * one: a greyed control says no and leaves the operator to guess why. Two
 * doors refused for the same reason say it once.
 */
function Doors({
  p,
  busy,
  answer,
  onFetch,
  onPush,
}: {
  p: ProjectDTO;
  busy: Door | null;
  answer: Answer | null;
  onFetch: () => void;
  onPush: () => void;
}) {
  const doors = (["fetch", "push"] as const).map((door) => {
    // What the press said outranks what the inventory said: only the press
    // asks the remote, and the row it carried back cannot know what it said.
    if (answer?.refused && answer.door === door) {
      return { door, open: false, reason: answer.text, tone: answer.tone };
    }
    const verdict = p[door];
    return {
      door,
      open: verdict.possible,
      reason: verdict.reason ?? "",
      tone: "neutral" as HintTone,
    };
  });
  const open = doors.filter((d) => d.open);
  const shut = doors.filter((d) => !d.open);
  const merged =
    shut.length === 2 && shut[0].reason === shut[1].reason && shut[0].tone === shut[1].tone
      ? [{ ...shut[0], label: "Fetch and push" }]
      : shut.map((d) => ({ ...d, label: d.door === "fetch" ? "Fetch" : "Push" }));

  return (
    <div className="mt-2.5">
      {open.length > 0 && (
        <ButtonRow>
          {open.map((d) => (
            <Button
              key={d.door}
              variant="secondary"
              size="compact"
              busy={busy === d.door}
              disabled={busy !== null}
              onClick={d.door === "fetch" ? onFetch : onPush}
            >
              {d.door === "fetch" ? "Fetch" : "Push"}
            </Button>
          ))}
        </ButtonRow>
      )}
      {merged.map((d) => (
        <Hint key={d.label} tone={d.tone}>
          <span className="font-medium">{d.label}:</span> {d.reason}
        </Hint>
      ))}
      {answer && !answer.refused && <Hint>{answer.text}</Hint>}
    </div>
  );
}

/**
 * What is not merged into the current branch, read-only.
 *
 * A run's branch links to its run and to `/branches`, which holds every door
 * a run's branch has; any other branch is listed and nothing more.
 */
function UnmergedBranches({ p }: { p: ProjectDTO }) {
  return (
    <div className="mt-2 space-y-3">
      {p.runBranches.length > 0 && (
        <ListGroup
          label={
            <>
              From runs ·{" "}
              <Link href={`/branches?repo=${encodeURIComponent(p.path)}`}>
                land or delete on Branches
              </Link>
            </>
          }
        >
          {p.runBranches.map((b) => (
            <RunBranchItem key={b.branch} b={b} />
          ))}
        </ListGroup>
      )}
      {p.otherBranches.length > 0 && (
        <ListGroup label="Other branches">
          {p.otherBranches.map((b) => (
            <div key={b.branch} className="px-3 py-2">
              <BranchLine b={b} />
            </div>
          ))}
        </ListGroup>
      )}
      {p.branchesNotRead > 0 && (
        // Not listed rather than listed unread: listing one would mean saying
        // whether it is landed without having asked.
        <p className="text-xs text-ink-muted">
          {plural(p.branchesNotRead, "more branch", "more branches")} not read on this page;{" "}
          <Link href={`/branches?repo=${encodeURIComponent(p.path)}`}>Branches</Link> lists every
          run&rsquo;s.
        </p>
      )}
    </div>
  );
}

function RunBranchItem({ b }: { b: ProjectRunBranchDTO }) {
  return (
    <div className="px-3 py-2">
      <BranchLine b={b} />
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
        <Badge tone={STATUS_TONE[b.runStatus]}>{STATUS_LABEL[b.runStatus]}</Badge>
        <Link href={`/runs/${b.runId}`} className="mono">
          run {shortId(b.runId)}
        </Link>
        {b.target && (
          <span>
            for <span className="mono break-all">{b.target}</span>
          </span>
        )}
        <span className="min-w-0 break-words">{b.task}</span>
      </div>
    </div>
  );
}

function BranchLine({ b }: { b: ProjectBranchDTO }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
      <span className="mono min-w-0 break-all text-ink">{b.branch}</span>
      <span className="tabular-nums text-xs text-ink-muted">
        {b.ahead === null ? "not counted" : `${plural(b.ahead, "commit")} ahead`} · tip{" "}
        {fmtDate(b.tipAt)}
      </span>
    </div>
  );
}
