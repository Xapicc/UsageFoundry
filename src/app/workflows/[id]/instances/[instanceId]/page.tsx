"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { WorkflowInstanceDTO, WorkflowPickUpDTO } from "@/lib/apiTypes";
import type { BadgeTone, PassRow } from "@/lib/format";
import {
  STATUS_TONE,
  WORKFLOW_LIMIT_TIMING_NOTE,
  fmtCycleInFlight,
  fmtCycles,
  fmtDateTime,
  fmtPct,
  fmtUSD,
  landingSummary,
  passRuns,
  passesOf,
  pollFailureMessage,
} from "@/lib/format";
import { Markdown } from "@/components/Markdown";
import { Meter } from "@/components/Meter";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import {
  Card,
  CardTitle,
  Empty,
  SkeletonText,
  Stat,
  StatSub,
} from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { Hint } from "@/components/ui/Hint";
import { ListGroup, ListRow } from "@/components/ui/List";
import { Notice } from "@/components/ui/Notice";
import { Sheet } from "@/components/ui/Sheet";
import {
  TBody,
  THead,
  Table,
  TableWrap,
  Td,
  Th,
  Tr,
} from "@/components/ui/Table";

const POLL_MS = 10_000;

/** Who halted it, in the same words the member runs' own reasons use. */
const CAUSE_LABEL: Record<"operator" | "guard" | "fleet", string> = {
  operator: "You stopped this run",
  guard: "Its budget guard stopped this run",
  fleet: "You stopped everything in flight, this run among it",
};

type BlockStatus = WorkflowInstanceDTO["blocks"][number]["status"];
type BlockKind = WorkflowInstanceDTO["blocks"][number]["kind"];

/**
 * What a block's status is called on the page.
 *
 * `emitted` is deliberately not "completed": a block that decided there was
 * nothing to start is emitted with zero runs, and the row beside this says how
 * many — so the word has to leave room for none rather than imply work. It is
 * also the status a loop settles in, where the same reasoning gives a different
 * word: "repeated" leaves room for a loop that took one pass and stopped.
 *
 * Per kind as well as per status, because the column holds one lifecycle for
 * every kind of block — see `BlockStatus`, which says why it is one vocabulary
 * and not four — and "deciding" is the wrong word for a merge in flight.
 */
const BLOCK_LABEL: Record<BlockStatus, string> = {
  waiting: "waiting",
  thinking: "deciding",
  looping: "repeating",
  emitted: "decided",
  failed: "failed",
  blocked: "blocked",
};

/**
 * The kinds that read their own status differently, and nothing else.
 *
 * Named for what it holds rather than `KIND_LABEL`, which is what
 * `WorkflowCanvas` exports for an unrelated thing — the display name of a block
 * *kind*. Two maps of one name in one feature area is how a later reader
 * imports the wrong one and gets a plausible word back.
 */
const STATUS_BY_KIND: Partial<
  Record<BlockKind, Partial<Record<BlockStatus, string>>>
> = {
  merge: { thinking: "merging", emitted: "landed" },
  loop: { emitted: "repeated" },
};

const blockLabel = (b: { kind: BlockKind; status: BlockStatus }) =>
  STATUS_BY_KIND[b.kind]?.[b.status] ?? BLOCK_LABEL[b.status];

const BLOCK_TONE: Record<BlockStatus, BadgeTone> = {
  waiting: "neutral",
  thinking: "accent",
  looping: "accent",
  emitted: "ok",
  failed: "danger",
  blocked: "neutral",
};

type BlockDTO = WorkflowInstanceDTO["blocks"][number];
type NodeDTO = WorkflowInstanceDTO["nodes"][number];

/**
 * What one pass spent, as the clause beside its run count.
 *
 * Empty where **nothing** in the pass reported a cost, rather than `$0.00`: a
 * null `spentUSD` is a provider that reports no cost, which the rows under it
 * already draw as a dash, and a zero here would be a figure nobody measured.
 * A pass where some runs reported and others did not is summed from the ones
 * that did — the same partial reading the workflow's own meter takes, and the
 * count beside it says how many runs the figure is over.
 */
function passSpend(runs: readonly NodeDTO[]): { usd: number | null; reported: number } {
  const reported = runs
    .map((n) => n.run?.spentUSD)
    .filter((usd): usd is number => usd !== null && usd !== undefined);
  if (reported.length === 0) return { usd: null, reported: 0 };
  return {
    usd: reported.reduce((total, usd) => total + usd, 0),
    reported: reported.length,
  };
}

/**
 * How a set of runs ended, most common first: "9 completed · 1 needs-review".
 *
 * The run's own status words, because they are the badges on the rows the fold
 * hides — a summary in other words is a second vocabulary to translate.
 */
function statusTally(runs: readonly NodeDTO[]): string {
  const counts = new Map<string, number>();
  for (const n of runs) {
    const status = n.run?.status ?? "gone";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${count} ${status}`)
    .join(" · ");
}

/**
 * Whether a pass landed, including the two states `landingSummary` leaves out.
 *
 * `landingSummary` answers only for a merge that ran. A merge still waiting is
 * nothing to say yet, but a **blocked** one is the pass that did not land at
 * all — the ending that stops a loop, and the one its summary line most needs.
 */
function passLanding(
  landing: BlockDTO | null,
): { text: string; warn: boolean } | null {
  if (landing === null) return null;
  if (landing.status === "blocked") {
    return { text: "not landed — its merge never started", warn: true };
  }
  if (landing.status === "thinking") return { text: "landing…", warn: false };
  const text = landingSummary(landing);
  if (text === null) return null;
  return {
    text,
    warn: landing.branchesFailed > 0 || landing.branchesLanded === 0,
  };
}

/** Where the run is working. Absolute when its mount has since been removed. */
function folderLabel(run: NonNullable<NodeDTO["run"]>): string {
  return run.mountLabel ? `${run.mountLabel} / ${run.relPath || "."}` : run.relPath;
}

/**
 * The rows of a run table, for both of the tables on this page.
 *
 * Two tables rather than one because the runs a block decided on were started
 * with nobody approving them, and separating them is the whole of what this
 * page can say about that — but a run is a run, so there is one row and one
 * header, and only the heading and the caption differ.
 */
function RunRows({
  nodes,
  nodeName,
  nested = false,
}: {
  nodes: NodeDTO[];
  nodeName: Map<string, string>;
  /**
   * Drawn directly under the block that decided them, inside a pass. The
   * "started by" line is dropped there rather than repeated: the row above is
   * that block, and ten copies of its name down one pass buried the one line
   * per run that differed.
   */
  nested?: boolean;
}) {
  return (
    <TBody>
      {nodes.map((n) => {
        const waits = n.waitsFor.map((from) => nodeName.get(from) ?? from);
        // Reads the run's own `fmtCycleInFlight`, in that function's argument
        // shape rather than a second copy of its rules: what counts as a cycle
        // in flight is one definition, and the DTO here is simply camelCase.
        const inFlight = n.run
          ? fmtCycleInFlight({
              status: n.run.status,
              max_iterations: n.run.maxIterations,
              active_iteration: n.run.activeIteration,
            })
          : null;
        return (
          <Tr key={n.nodeId}>
            <Td className="align-top">
              {n.run ? (
                <Badge tone={STATUS_TONE[n.run.status]}>{n.run.status}</Badge>
              ) : (
                <Badge tone="neutral">gone</Badge>
              )}
            </Td>
            <Td
              className={`align-top ${nested ? "md:border-l-2 md:border-l-line md:pl-4" : ""}`}
            >
              <Link
                href={`/runs/${n.runId}`}
                className="block font-medium text-ink hover:text-accent max-md:inline-flex max-md:min-h-11 max-md:items-center"
              >
                {n.nodeName}
              </Link>
              {!nested && (
                <div className="mt-0.5 text-ink-muted">
                  {n.emittedBy
                    ? `started by ${nodeName.get(n.emittedBy) ?? n.emittedBy}`
                    : waits.length === 0
                      ? "started immediately"
                      : `after ${waits.join(", ")}`}
                </div>
              )}
              {n.run && (
                // Under the name because a block a model wrote chose this
                // folder itself, within the mount the operator fixed — it is
                // not readable off the saved graph.
                <div
                  className="mono mt-0.5 max-w-[56ch] truncate text-ink-muted"
                  title={folderLabel(n.run)}
                >
                  {folderLabel(n.run)}
                </div>
              )}
              {inFlight && <div className="mt-0.5 text-accent">{inFlight}</div>}
              {n.leftBehind && (
                <div className="mt-0.5 text-warn">
                  Left behind — the workflow carried on without it
                </div>
              )}
              {n.run?.stopReason && (
                <div className="mt-0.5 max-w-[56ch] text-ink-muted">
                  {n.run.stopReason}
                </div>
              )}
            </Td>
            <Td
              num
              label="Cycles"
              className="whitespace-nowrap align-top text-ink-muted"
            >
              {n.run ? fmtCycles(n.run.iterations, n.run.maxIterations) : "—"}
            </Td>
            <Td num label="Spent" className="whitespace-nowrap align-top">
              {/* Null is a provider that reports no cost, not a member that
                  spent nothing — the runs list draws the same dash for the
                  same reason. */}
              {n.run && n.run.spentUSD !== null ? fmtUSD(n.run.spentUSD) : "—"}
            </Td>
            <Td
              num
              label="Started"
              className="whitespace-nowrap align-top text-ink-muted"
            >
              {n.run?.startedAt ? fmtDateTime(n.run.startedAt) : "—"}
            </Td>
          </Tr>
        );
      })}
    </TBody>
  );
}

/**
 * A pass member that is a ledger row rather than a run.
 *
 * The same five columns as `RunRows`, because it is the same table and a member
 * of a pass is a member of a pass whichever kind it is — an operator reading a
 * pass down the page may not have to change how they read it halfway. What
 * differs is what each column can say: a ledger row has no run to link to, no
 * work cycles, and a cost that is a turn's rather than a run's.
 */
function MemberBlockRows({
  block,
  nodeName,
}: {
  block: BlockDTO;
  nodeName: Map<string, string>;
}) {
  const waits = block.waitsFor.map((from) => nodeName.get(from) ?? from);
  return (
    <TBody>
      <Tr>
        <Td className="align-top">
          <Badge tone={BLOCK_TONE[block.status]}>{blockLabel(block)}</Badge>
        </Td>
        <Td className="align-top">
          <div className="font-medium text-ink">{block.nodeName}</div>
          <div className="mt-0.5 text-ink-muted">
            {blockSummary(block, waits)}
          </div>
          {block.error && (
            <div className="mt-0.5 max-w-[56ch] text-ink-muted">
              {block.error}
            </div>
          )}
          {/* This app's account before the block's own, because a refused
              emission explains a reply that says it gave up, and the reply read
              first does not. */}
          {block.notes.map((note, i) => (
            <div key={i} className="mt-0.5 max-w-[56ch] text-warn">
              {note}
            </div>
          ))}
          {block.reply && (
            <div className="mt-2 max-w-[80ch] rounded-sm border-l-[3px] border-line-strong bg-inset px-3 py-2">
              <Markdown text={block.reply} />
            </div>
          )}
        </Td>
        <Td num label="Cycles" className="whitespace-nowrap align-top text-ink-muted">
          {/* A turn, not a run: there are no work cycles to count, and a `0`
              here would read as a run that never got going. */}
          —
        </Td>
        <Td num label="Spent" className="whitespace-nowrap align-top">
          {block.costUSD === null ? "—" : fmtUSD(block.costUSD)}
        </Td>
        <Td
          num
          label="Started"
          className="whitespace-nowrap align-top text-ink-muted"
        >
          {block.startedAt === null ? "—" : fmtDateTime(block.startedAt)}
        </Td>
      </Tr>
    </TBody>
  );
}

function RunTableHead() {
  return (
    // `min-w` rather than `w` on every fixed column here, and it is a
    // correctness fix rather than a preference. A `width` on a table cell is a
    // *suggestion* the auto layout algorithm trades away against a `w-full`
    // column's own content — measured on `/workflows/[id]`, a column declared
    // at 260px rendered at 93 and wrapped one dependency into four lines, and
    // these four columns are declared exactly the same way. `min-width` is a
    // constraint the algorithm may not go under, so each column gets at least
    // what it was written for and `w-full` still takes whatever is left. It
    // cannot reach the narrow layout either way: `THead` is `max-md:hidden` on
    // a stacked table, so below the breakpoint these cells are not rendered at
    // all.
    <THead>
      <tr>
        <Th scope="col" className="min-w-[116px]">
          Status
        </Th>
        <Th scope="col" className="w-full">
          Run
        </Th>
        {/* The head carried a `title` saying "work cycles that finished,
            against the run's cap" — the second copy of that exact string, the
            other being `/runs`. Both are gone rather than relocated. A hover
            has no touch equivalent, and this table stacks, so the sentence
            existed on exactly one of the two layouts; and nothing was lost
            with it, because `n/m` reads as "n of m" and the run's own state is
            already in the cell beside it. */}
        <Th scope="col" num className="min-w-[104px]">
          Cycles
        </Th>
        <Th scope="col" num className="min-w-[96px]">
          Spent
        </Th>
        <Th scope="col" num className="min-w-[128px]">
          Started
        </Th>
      </tr>
    </THead>
  );
}

/** The request each kind of pick-up sends. */
function pickUpRequest(p: WorkflowPickUpDTO): Record<string, string> {
  switch (p.kind) {
    case "run":
      return { action: "leave-behind", runId: p.runId };
    case "merge":
      return { action: "retry-merge", nodeId: p.nodeId };
    case "loop":
      return { action: "resume-loop", nodeId: p.nodeId };
  }
}

/** What each kind's confirmation says, before anything is released. */
const PICK_UP_SHEET: Record<
  WorkflowPickUpDTO["kind"],
  { title: (name: string) => string; confirm: string; body: string }
> = {
  run: {
    title: (name) => `Continue without “${name}”?`,
    confirm: "Continue without it",
    body:
      "The workflow carries on now without this run: a merge behind it lands the other branches, and in a loop the next pass starts once this pass has landed. The run keeps its status and its branch.",
  },
  merge: {
    title: (name) => `Retry “${name}”?`,
    confirm: "Retry merge",
    body:
      "Every branch it was given that is not on its target yet goes back through the merge queue, into your checkout; a branch already landed is skipped. If the section repeats, its next pass starts once this one has landed.",
  },
  loop: {
    title: (name) => `Carry on “${name}”?`,
    confirm: "Carry on the loop",
    body:
      "The pass it stopped at is decided again on what is true now: its merge lands what the pass produced, and the loop takes its next pass if its limits allow — each pass starting agents with nobody watching.",
  },
};

/**
 * What is holding this workflow run up, and the way past each obstacle.
 *
 * One row per obstacle and one press per row, never "pick everything up": each
 * way past starts agents nobody watches, and the question a `needs-review` run
 * asked is the operator's to answer by name. Resume is a link rather than a
 * button because resuming is `reopenRun`, which asks for the budget and the note
 * on the run's own page — and already carries the workflow on once the run
 * completes. The two actions here are the ones no other page can take.
 *
 * Both go through a `Sheet`: each releases work straight away — a merge into
 * the operator's checkout, a loop's next pass — which is the kind of action the
 * grouping vocabulary reserves one for.
 */
function PickUpCard({
  pickUps,
  workflowId,
  instanceId,
  onPickedUp,
}: {
  pickUps: WorkflowPickUpDTO[];
  workflowId: string;
  instanceId: string;
  onPickedUp: (instance: WorkflowInstanceDTO) => void;
}) {
  const [pending, setPending] = useState<WorkflowPickUpDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workflows/${workflowId}/instances/${instanceId}/pick-up`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pickUpRequest(pending)),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        instance?: WorkflowInstanceDTO;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      if (data.instance) onPickedUp(data.instance);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      // Closed however this ended, `stopAll`'s reason: the error renders behind
      // the modal, and a sheet left open over a failure reads as one that is
      // still waiting to be confirmed.
      setPending(null);
    }
  }

  return (
    <>
      <CardTitle>What is holding this up</CardTitle>
      <Card>
        {error && (
          <Notice tone="danger" live>
            {error}
          </Notice>
        )}
        <ListGroup>
          {pickUps.map((p) =>
            p.kind === "run" ? (
              <ListRow
                key={p.runId}
                label={
                  <Link href={`/runs/${p.runId}`} className="font-medium text-ink hover:text-accent">
                    {p.nodeName}
                  </Link>
                }
                description={
                  p.leaveBehindRefusal ?? `Ended ${p.status}`
                }
              >
                <div className="flex flex-wrap justify-end gap-2">
                  <ButtonLink href={`/runs/${p.runId}`} size="compact">
                    Resume…
                  </ButtonLink>
                  {p.leaveBehindRefusal === null && (
                    <Button
                      size="compact"
                      variant="secondary"
                      onClick={() => setPending(p)}
                      disabled={busy}
                    >
                      Continue without it
                    </Button>
                  )}
                </div>
              </ListRow>
            ) : p.kind === "loop" ? (
              <ListRow
                key={p.nodeId}
                label={<span className="font-medium text-ink">{p.nodeName}</span>}
                description={
                  p.refusal ??
                  `Stopped at pass ${p.pass}, and what stopped it has since cleared`
                }
              >
                {p.refusal === null && (
                  <Button
                    size="compact"
                    variant="secondary"
                    onClick={() => setPending(p)}
                    disabled={busy}
                  >
                    Carry on the loop
                  </Button>
                )}
              </ListRow>
            ) : (
              <ListRow
                key={p.nodeId}
                label={<span className="font-medium text-ink">{p.nodeName}</span>}
                description={p.retryRefusal ?? p.error ?? "The merge failed"}
              >
                {p.retryRefusal === null && (
                  <Button
                    size="compact"
                    variant="secondary"
                    onClick={() => setPending(p)}
                    disabled={busy}
                  >
                    Retry merge
                  </Button>
                )}
              </ListRow>
            ),
          )}
        </ListGroup>
        {pickUps.some((p) => p.kind === "run") && (
          <Hint>
            Resume carries the workflow on once the run completes; Continue
            without it leaves its branch unlanded
          </Hint>
        )}
      </Card>
      {/* Always rendered, never conditionally mounted — see `Sheet`. */}
      <Sheet
        open={pending !== null}
        onDismiss={() => setPending(null)}
        title={pending ? PICK_UP_SHEET[pending.kind].title(pending.nodeName) : ""}
        confirmLabel={pending ? PICK_UP_SHEET[pending.kind].confirm : ""}
        busy={busy}
        onConfirm={confirm}
      >
        {pending ? PICK_UP_SHEET[pending.kind].body : null}
      </Sheet>
    </>
  );
}

/**
 * One repeating block: how far through its caps it got, why it stopped, and
 * each pass folded down to the line that says how it went.
 *
 * The loop's own status and stop reason used to sit in "Blocks not yet runs",
 * a card away from the passes they explain, and every pass was one flat table
 * under a thin heading row — a pass of ten runs was twenty screen-heights of
 * scrolling before the next one began. A pass's summary line carries what a
 * reader scans for — how its runs ended, what they cost, whether it landed —
 * so the earlier passes fold behind it. The latest opens at mount, and only at
 * mount: `Disclosure` is uncontrolled so a poll never closes one under a
 * reader.
 */
function LoopCard({
  loop,
  passes,
  nodeName,
  emphasis,
}: {
  loop: BlockDTO;
  passes: PassRow[];
  nodeName: Map<string, string>;
  emphasis: "primary" | "default";
}) {
  const runs = passes.flatMap(passRuns);
  const spend = passSpend(runs);
  const waits = loop.waitsFor.map((from) => nodeName.get(from) ?? from);

  return (
    <Card emphasis={emphasis}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge tone={BLOCK_TONE[loop.status]}>{blockLabel(loop)}</Badge>
        {loop.startedAt !== null && (
          <span className="text-ink-muted">
            started {fmtDateTime(loop.startedAt)}
          </span>
        )}
      </div>

      {passes.length === 0 ? (
        <Empty>
          <div className="text-ink-muted">
            No pass yet — {blockSummary(loop, waits)}.
          </div>
        </Empty>
      ) : (
        <div className="mt-4 grid grid-cols-3 gap-4">
          <div>
            <div className="text-xs text-ink-muted">Passes</div>
            <Stat>{passes.length}</Stat>
            <StatSub>
              {loop.maxPasses === null ? "no pass limit" : `of ${loop.maxPasses} at most`}
            </StatSub>
          </div>
          <div>
            <div className="text-xs text-ink-muted">Runs</div>
            <Stat>{runs.length}</Stat>
            <StatSub>{statusTally(runs)}</StatSub>
          </div>
          <div>
            <div className="text-xs text-ink-muted">Spent by its runs</div>
            {/* A dash rather than $0.00 when nothing reported: see `passSpend`. */}
            <Stat>{spend.usd === null ? "—" : fmtUSD(spend.usd)}</Stat>
            <StatSub>
              {loop.maxLoopCostUSD === null
                ? "no spending limit"
                : `of ${fmtUSD(loop.maxLoopCostUSD)} limit`}
              {spend.reported < runs.length &&
                ` · ${spend.reported} of ${runs.length} reported a cost`}
            </StatSub>
          </div>
        </div>
      )}

      {/* Why it stopped, above the passes rather than in a table cell beside
          the loop's name: it is the sentence every pass below is read against. */}
      {loop.error && (
        <Notice
          tone={loop.status === "failed" ? "danger" : "info"}
          className="mt-4"
        >
          {loop.error}
        </Notice>
      )}
      {loop.notes.map((note, i) => (
        <Notice key={i} tone="warn" className="mt-4">
          {note}
        </Notice>
      ))}

      {passes.length > 0 && (
        <div className="mt-4 border-t border-line">
          {passes.map((row, index) => {
            const passRunList = passRuns(row);
            const passCost = passSpend(passRunList);
            const landing = passLanding(row.landing);
            return (
              <Disclosure
                key={row.pass}
                defaultOpen={index === passes.length - 1}
                className="border-b border-line py-2"
                summary={
                  <>
                    <span className="font-medium text-ink">Pass {row.pass}</span>
                    <span className="ml-2 text-ink-muted">
                      {passRunList.length === 0
                        ? "no runs"
                        : statusTally(passRunList)}
                      {passCost.usd !== null && ` · ${fmtUSD(passCost.usd)}`}
                    </span>
                    {/* The landing on the pass's own line, because it is the
                        fact that decides whether the next pass could see this
                        one's work — not a property of the merge member it is
                        read off. */}
                    {landing && (
                      <span
                        className={landing.warn ? "text-warn" : "text-ink-muted"}
                      >
                        {" "}
                        · {landing.text}
                      </span>
                    )}
                  </>
                }
              >
                <div className="mt-2">
                  <TableWrap>
                    <Table stack>
                      <caption className="sr-only">
                        Pass {row.pass} of {loop.nodeName}: the blocks it ran and
                        the runs they started
                      </caption>
                      <RunTableHead />
                      {row.members.map((member) =>
                        member.kind === "run" ? (
                          <RunRows
                            key={member.key}
                            nodes={[member.node]}
                            nodeName={nodeName}
                          />
                        ) : (
                          <Fragment key={member.key}>
                            <MemberBlockRows
                              block={member.block}
                              nodeName={nodeName}
                            />
                            {/* Under the member that decided them: these are
                                runs this pass caused, and the operator reading a
                                pass's spend has to see them inside it. */}
                            <RunRows
                              nodes={member.emitted}
                              nodeName={nodeName}
                              nested
                            />
                          </Fragment>
                        ),
                      )}
                    </Table>
                  </TableWrap>
                </div>
              </Disclosure>
            );
          })}
        </div>
      )}

      <Hint>
        Stops when every run of a pass reports the work complete, a pass does
        not complete or does not land, or one of its limits is reached
      </Hint>
    </Card>
  );
}

/**
 * The one line under a block's name.
 *
 * A deciding block that started nothing is what this exists to separate. Zero
 * runs is three different endings — it called emit_runs and named nothing, it
 * never called it, or it failed before it got there — and all three stop the
 * branch of the graph behind them, so "which of the three" is the operator's
 * whole question. The block's own reply sits under this and answers *why*;
 * this says *what*.
 */
function blockSummary(b: BlockDTO, waits: string[]): string {
  const ran = b.status === "emitted" || b.status === "failed";
  if (b.kind === "merge") {
    const branches = b.branchesLanded + b.branchesFailed;
    if (branches > 0) return `landed ${b.branchesLanded} of ${branches} branch(es)`;
    // Only for a merge that finished: one that failed with nothing queued has
    // not established that there was nothing to land, and its error says more.
    if (b.status === "emitted") return "no branches to land";
  } else if (b.kind === "loop") {
    // A pass is not a work cycle: it is a whole run, with its own cycles and
    // its own spend. The two must never share a word. Read on every status but
    // `waiting` rather than only the settled ones, because a loop still taking
    // passes is exactly when the count is worth watching.
    if (b.status !== "waiting") return `${b.emitted} pass(es)`;
  } else if (ran) {
    if (b.emitted > 0) return `started ${b.emitted} run(s)`;
    if (b.kind === "orchestrator") {
      if (b.decided) return "decided there was nothing to start";
      return b.status === "failed"
        ? "failed without emitting anything"
        : "ended without emitting anything";
    }
  }
  if (b.kind === "run" && b.status !== "waiting") return "never started";
  if (waits.length > 0) return `after ${waits.join(", ")}`;
  // A loop decides nothing: its first pass is the work it was given — its own
  // task, or the section it repeats.
  return b.kind === "loop" ? "starts immediately" : "decides immediately";
}

/**
 * One press of Run: every block, and what became of the run it created.
 *
 * Read off the instance's own snapshot of the graph rather than the live
 * workflow, so editing the workflow afterwards cannot rewrite what this says
 * happened. The run statuses are live; the shape of the graph is history.
 */
export default function WorkflowInstancePage() {
  const params = useParams<{ id: string; instanceId: string }>();
  const { id, instanceId } = params;

  const [instance, setInstance] = useState<WorkflowInstanceDTO | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/workflows/${id}/instances/${instanceId}`,
        { cache: "no-store" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        instance?: WorkflowInstanceDTO;
        error?: string;
      };
      if (!res.ok || !data.instance) {
        setPollError(
          pollFailureMessage(res.status, data.error ?? "no instance in the response"),
        );
        return;
      }
      setInstance(data.instance);
      setPollError(null);
    } catch (err) {
      setPollError(
        pollFailureMessage(null, err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setLoaded(true);
    }
  }, [id, instanceId]);

  useEffect(() => {
    load();
    const poll = setInterval(load, POLL_MS);
    return () => clearInterval(poll);
  }, [load]);

  /**
   * Halt every block at once.
   *
   * Guarded by `chatRequest`'s rule rather than a bare `fetch`: an unguarded
   * rejection out of a handler that sets a busy flag leaves the button disabled
   * with no cue and no way back but a reload — and this is the button that stops
   * unattended agents from spending.
   */
  async function stopAll() {
    setStopping(true);
    setStopError(null);
    try {
      const res = await fetch(
        `/api/workflows/${id}/instances/${instanceId}/stop`,
        { method: "POST" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        instance?: WorkflowInstanceDTO;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      if (data.instance) setInstance(data.instance);
    } catch (err) {
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
      // Closed however this ended. `stopError` renders behind the modal, so a
      // sheet left open over a failure shows an enabled, un-busy "Stop all
      // blocks" and no sign that the agents are still spending.
      setConfirmStop(false);
    }
  }

  const nodeName = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of instance?.nodes ?? []) map.set(n.nodeId, n.nodeName);
    for (const b of instance?.blocks ?? []) map.set(b.nodeId, b.nodeName);
    return map;
  }, [instance]);

  /**
   * The three tables, split once.
   *
   * A pass is several members of several kinds now, so everything one loop
   * caused is lifted out of the flat tables and grouped: its member runs, the
   * ledger rows for an orchestrator or merge member, and the runs an
   * orchestrator member decided on. Every row lands in exactly one place — a
   * run missing from all of them would be an unattended agent this page has no
   * other mention of.
   */
  const { savedRuns, emittedRuns, passSections } = useMemo(() => {
    const savedRuns: NodeDTO[] = [];
    const emittedRuns: NodeDTO[] = [];
    const loops = (instance?.blocks ?? []).filter((b) => b.kind === "loop");
    const loopIds = new Set(loops.map((b) => b.nodeId));

    /** Every row one loop caused, keyed on that loop. */
    const caused = new Map<string, { nodes: NodeDTO[]; blocks: BlockDTO[] }>();
    const own = (loopNodeId: string) => {
      const found = caused.get(loopNodeId);
      if (found) return found;
      const fresh = { nodes: [] as NodeDTO[], blocks: [] as BlockDTO[] };
      caused.set(loopNodeId, fresh);
      return fresh;
    };

    for (const n of instance?.nodes ?? []) {
      // The member id decides, not `emittedBy`: a run an orchestrator *member*
      // started is named under its pass too, and its cost is that pass's.
      if (n.passMember && loopIds.has(n.passMember.loopNodeId)) {
        own(n.passMember.loopNodeId).nodes.push(n);
      } else if (n.emittedBy) {
        emittedRuns.push(n);
      } else {
        savedRuns.push(n);
      }
    }
    for (const b of instance?.blocks ?? []) {
      if (b.passMember && loopIds.has(b.passMember.loopNodeId)) {
        own(b.passMember.loopNodeId).blocks.push(b);
      }
    }

    // Every loop, including one with no pass yet: its card is where its
    // status is drawn now, so a loop still waiting must not vanish off the page.
    const passSections = loops.map((loop) => ({
      loop,
      passes: passesOf(loop, caused.get(loop.nodeId) ?? { nodes: [], blocks: [] }),
    }));

    // Back into the order the graph declared, because the split above walked
    // the rows in whatever order they were created.
    emittedRuns.sort((a, b) => a.position - b.position);
    return { savedRuns, emittedRuns, passSections };
  }, [instance]);

  /**
   * The ledger rows that are not part of a pass, and not a loop.
   *
   * A pass's own members are drawn in the pass, with what they waited for and
   * what they landed, and a loop is drawn on its own card above its passes —
   * listing either here as well would put one block on the page twice with two
   * different accounts of it.
   */
  const standaloneBlocks = useMemo(
    () =>
      (instance?.blocks ?? []).filter(
        (b) => b.passMember === null && b.kind !== "loop",
      ),
    [instance],
  );

  if (!loaded) {
    return (
      <Card emphasis="quiet">
        <span className="sr-only">Reading this run of the workflow…</span>
        <SkeletonText lines={4} />
      </Card>
    );
  }

  if (!instance) {
    return (
      <>
        <div role="alert">
          {pollError && <Notice tone="danger">{pollError}</Notice>}
        </div>
        <Card emphasis="quiet">
          <Empty>
            <div className="font-medium text-ink">No such workflow run</div>
            <div className="mt-3">
              <Link href={`/workflows/${id}`}>Back to the workflow</Link>
            </div>
          </Empty>
        </Card>
      </>
    );
  }

  const budget = instance.instanceBudget;
  const noLimits =
    budget.maxInstanceCostUSD === null &&
    budget.maxSessionFraction === null &&
    budget.maxWeeklyFraction === null;

  /**
   * What each kind of block is, for a reader meeting one for the first time.
   *
   * Four paragraphs stacked at the foot of one card, each appended by the
   * commit that added its kind, two of them describing a kind this graph may
   * not even hold. They are foldable **here and nowhere else**: on this page
   * the press of Run has already happened, so none of this is a fact a decision
   * is being approved against — which is exactly what `BlockStatement` in the
   * editor is, and why nothing folds it.
   *
   * Held as an array so the count on the fold is the number actually behind it:
   * a fold that overstates what it holds is one a reader stops opening, and a
   * count computed separately from the conditions is one that goes wrong the
   * next time a kind is added.
   */
  const blockKindNotes = [
    <Hint key="spend">
      A deciding block&rsquo;s own spend is counted against this workflow&rsquo;s
      limit and never against a run
    </Hint>,
    ...(instance.blocks.some((b) => b.kind === "merge")
      ? [
          <Hint key="merge">
            A merge block&rsquo;s branches are in the merge queue on Branches,
            with git&rsquo;s answer for each
          </Hint>,
        ]
      : []),
  ];

  return (
    <>
      <div className="mb-6">
        {/* `inline-flex` only below the breakpoint, for `agents/page.tsx`'s
            reason: this is the page's back button under a thumb and owes the
            44px target, and above it it is pointed at and reads as the inline
            text it is. */}
        <Link
          href={`/workflows/${id}`}
          className="text-sm text-ink-muted max-md:inline-flex max-md:min-h-11 max-md:items-center"
        >
          ← {instance.workflowName}
        </Link>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            Run of {fmtDateTime(instance.createdAt)}
          </h1>
          {/* Not disabled by `confirmStop`: that lands in the same commit that
              opens the sheet, so the button is blurred to <body> before
              `showModal()` records what to restore focus to, and Esc would drop
              the operator at the top of the page. */}
          {/* `started` is now exactly "something is still live" — an instance
              with nothing live reads `finished` or `blocked` — so the count
              beside this test would be a second copy of that rule. */}
          {instance.status === "started" && (
            <Button
              variant="danger"
              onClick={() => setConfirmStop(true)}
              disabled={stopping}
            >
              Stop all
            </Button>
          )}
        </div>
      </div>

      <div role="alert">
        {pollError && <Notice tone="danger">{pollError}</Notice>}
        {stopError && (
          <Notice tone="danger" live>
            {stopError}
          </Notice>
        )}
      </div>

      {/* A sheet: the pane behind it goes inert, and Cancel takes the focus, so
          one Return on the control that ends unattended agents mid-cycle is not
          a confirmation. */}
      <Sheet
        open={confirmStop}
        onDismiss={() => setConfirmStop(false)}
        title={`Stop ${instance.liveRunCount} unfinished block(s)?`}
        confirmLabel="Stop all blocks"
        confirmVariant="danger"
        busy={stopping}
        onConfirm={stopAll}
      >
        A block working now is interrupted mid-cycle, so what that cycle spent is
        estimated rather than measured. Committed work stays on its branch;
        anything uncommitted stays in the checkout, to commit from the run page.
        Finished blocks are untouched.
      </Sheet>

      {instance.status === "failed" && (
        <Notice tone="danger">
          <strong>Nothing from this workflow is running.</strong> {instance.error}
        </Notice>
      )}

      {(instance.status === "stopping" || instance.status === "stopped") && (
        <Notice tone={instance.status === "stopping" ? "warn" : "info"}>
          <strong>
            {instance.status === "stopping"
              ? `Stopping — ${instance.liveRunCount} block(s) still finishing.`
              : "Stopped."}
          </strong>{" "}
          {instance.stoppedAt !== null && (
            <>
              {CAUSE_LABEL[instance.stopCause ?? "operator"]} at{" "}
              {fmtDateTime(instance.stoppedAt)}.{" "}
            </>
          )}
          {instance.stopReason}
        </Notice>
      )}

      {instance.pickUps.length > 0 && (
        <div className="mb-8">
          <PickUpCard
            pickUps={instance.pickUps}
            workflowId={id}
            instanceId={instanceId}
            onPickedUp={setInstance}
          />
        </div>
      )}

      <CardTitle>Limits for the whole workflow</CardTitle>
      <Card emphasis="quiet">
        {/* `fraction === null` when no spending limit was set, which renders
            hatched rather than as an empty bar: an instance whose share of a
            limit is unknown and one that has spent nothing must not look alike.
            The solid fill is what the blocks' own CLIs measured; the hatched
            band past it is the figure the guard acts on, which adds reconciled
            estimates for killed cycles and what telemetry has seen of the
            cycles in flight. Same split, same rendering, as an unpriced model
            widens a window meter. */}
        <Meter
          label="Spent across blocks"
          fraction={
            budget.maxInstanceCostUSD === null
              ? null
              : instance.spentUSD / budget.maxInstanceCostUSD
          }
          upperFraction={
            budget.maxInstanceCostUSD === null
              ? null
              : instance.spentGuardUSD / budget.maxInstanceCostUSD
          }
          // Said in the comment above and now said to a screen reader too: the
          // band here is reconciled and telemetry-derived spend, not the
          // unpriced-model gap the window meters draw.
          upperHint="including work still running and work that stopped before reporting its cost"
          value={fmtUSD(instance.spentUSD)}
          upperValue={fmtUSD(instance.spentGuardUSD)}
          unknownHint="no workflow spending limit"
          detail={
            budget.maxInstanceCostUSD === null
              ? // "measured" is a claim, and it is false as soon as one block
                // reported no cost at all: the figure is then what the rest of
                // them reported and says nothing about that one.
                instance.spentUnmeasured > 0
                ? `${fmtUSD(instance.spentUSD)} reported so far`
                : `${fmtUSD(instance.spentUSD)} measured so far`
              : // The ceiling and nothing else. `value`/`upperValue` put both
                // dollar figures in the head, so a "the guard reads …" clause
                // here printed one of them twice a hand's width apart; and where
                // the two agree `Meter` draws no band at all, so the head's
                // single figure already *is* the guard's. What the band means is
                // said by the live-blocks hint below and, to a screen reader, by
                // `upperHint`. `InstallSpendCard` keeps the clause because its
                // head is percentages and its detail is the only place its
                // dollar figures appear.
                `of ${fmtUSD(budget.maxInstanceCostUSD)}`
          }
        />

        <ListGroup className="mt-4">
          <ListRow label="5-hour window">
            <span
              className={`text-sm ${budget.maxSessionFraction === null ? "text-ink-faint" : "text-ink"}`}
            >
              {budget.maxSessionFraction === null
                ? "No guard"
                : `Stops the workflow at ${fmtPct(budget.maxSessionFraction)}`}
            </span>
          </ListRow>
          <ListRow label="Weekly window">
            <span
              className={`text-sm ${budget.maxWeeklyFraction === null ? "text-ink-faint" : "text-ink"}`}
            >
              {budget.maxWeeklyFraction === null
                ? "No guard"
                : `Stops the workflow at ${fmtPct(budget.maxWeeklyFraction)}`}
            </span>
          </ListRow>
        </ListGroup>

        {!noLimits && <Hint>{WORKFLOW_LIMIT_TIMING_NOTE}</Hint>}
        {instance.liveRunCount > 0 && (
          <Hint>
            {instance.liveRunCount} block(s) working: until their cycles end,
            the measured figure is a floor and the guard&rsquo;s is what
            telemetry has seen
          </Hint>
        )}
        {instance.spentUnmeasured > 0 && (
          <Hint>
            Money covers {instance.spentSubjects - instance.spentUnmeasured} of{" "}
            {instance.spentSubjects} block(s); the rest reported no cost, so
            what they spent is unknown rather than nothing
          </Hint>
        )}
      </Card>

      {standaloneBlocks.length > 0 && (
        <>
          <CardTitle className="mt-8">Blocks not yet runs</CardTitle>
          <Card emphasis="quiet">
            <TableWrap>
              <Table stack>
                <caption className="sr-only">
                  Blocks that decide what to run, blocks that repeat one, blocks
                  that land branches, and blocks waiting on any of them
                </caption>
                {/* `min-w` for `RunTableHead`'s reason, one table over: a
                    `width` is traded away against the `w-full` column's own
                    content, where a `min-width` is a floor the auto layout may
                    not go under. */}
                <THead>
                  <tr>
                    <Th scope="col" className="min-w-[116px]">
                      Status
                    </Th>
                    <Th scope="col" className="w-full">
                      Block
                    </Th>
                    <Th scope="col" num className="min-w-[104px]">
                      Started
                    </Th>
                    <Th scope="col" num className="min-w-[96px]">
                      Spent
                    </Th>
                  </tr>
                </THead>
                <TBody>
                  {standaloneBlocks.map((b) => {
                    const waits = b.waitsFor.map(
                      (from) => nodeName.get(from) ?? from,
                    );
                    return (
                      <Tr key={b.nodeId}>
                        <Td className="align-top">
                          <Badge tone={BLOCK_TONE[b.status]}>
                            {blockLabel(b)}
                          </Badge>
                        </Td>
                        <Td className="align-top">
                          <div className="font-medium text-ink">{b.nodeName}</div>
                          <div className="mt-0.5 text-ink-muted">
                            {blockSummary(b, waits)}
                          </div>
                          {b.error && (
                            <div className="mt-0.5 max-w-[56ch] text-ink-muted">
                              {b.error}
                            </div>
                          )}
                          {/* This app's account before the block's own, because
                              a refused emission explains a reply that says it
                              gave up, and the reply read first does not. */}
                          {b.notes.map((note, i) => (
                            <div key={i} className="mt-0.5 max-w-[56ch] text-warn">
                              {note}
                            </div>
                          ))}
                          {b.reply && (
                            <div className="mt-2 max-w-[80ch] rounded-sm border-l-[3px] border-line-strong bg-inset px-3 py-2">
                              <Markdown text={b.reply} />
                            </div>
                          )}
                        </Td>
                        <Td
                          num
                          label="Started"
                          className="whitespace-nowrap align-top text-ink-muted"
                        >
                          {b.startedAt === null ? "—" : fmtDateTime(b.startedAt)}
                        </Td>
                        {/* Only the two kinds that pay a model for a turn of
                            their own. A loop block spends nothing: every pass
                            is a run, and its cost is on that run's row. */}
                        <Td
                          num
                          label="Spent"
                          className="whitespace-nowrap align-top"
                        >
                          {(b.kind === "orchestrator" || b.kind === "merge") &&
                          b.costUSD !== null
                            ? fmtUSD(b.costUSD)
                            : "—"}
                        </Td>
                      </Tr>
                    );
                  })}
                </TBody>
              </Table>
            </TableWrap>
            {/* See `blockKindNotes` for why a fold is allowed here. */}
            <Disclosure
              className="mt-3"
              summaryClassName="text-xs font-medium text-ink-muted"
              summary="What these block kinds do"
              count={blockKindNotes.length}
            >
              {blockKindNotes}
            </Disclosure>
          </Card>
        </>
      )}

      {/* Whichever table holds the runs leads — the saved graph's own runs,
          then a loop's passes, then what a block decided on. A workflow that is
          one orchestrator block has no saved-graph run at all, and an empty
          primary card above the runs the operator came for is the wrong
          emphasis; a workflow that is one loop has the same empty card, and
          there it is dropped outright, because the loop card below already
          says where every run went. */}
      {(savedRuns.length > 0 || passSections.length === 0) && (
        <>
          <CardTitle className="mt-8">Blocks</CardTitle>
          <Card emphasis={savedRuns.length > 0 ? "primary" : "quiet"}>
            {savedRuns.length === 0 ? (
              <Empty>
                <div className="text-ink-muted">
                  No block of the saved graph became a run.
                </div>
              </Empty>
            ) : (
              <TableWrap>
                {/* Both of these tables are one `RunTableHead` and one `RunRows`,
                    so the stacked presentation is one component too — a second copy
                    would be the column that gained a fix here and not there. */}
                <Table stack>
                  <caption className="sr-only">
                    Each block of the workflow and the run it created
                  </caption>
                  <RunTableHead />
                  <RunRows nodes={savedRuns} nodeName={nodeName} />
                </Table>
              </TableWrap>
            )}
          </Card>
        </>
      )}

      {/* One card per repeating block, titled with the block's own name. */}
      {passSections.map(({ loop, passes }, index) => (
        <Fragment key={loop.nodeId}>
          <CardTitle className="mt-8">{loop.nodeName}</CardTitle>
          <LoopCard
            loop={loop}
            passes={passes}
            nodeName={nodeName}
            emphasis={
              savedRuns.length === 0 && index === 0 ? "primary" : "default"
            }
          />
        </Fragment>
      ))}

      {/* Only when there are any: a graph with no orchestrator block never
          reaches this, and an empty section under that heading would suggest
          one could have. */}
      {emittedRuns.length > 0 && (
        <>
          <CardTitle className="mt-8">Runs a block started</CardTitle>
          <Card
            emphasis={
              savedRuns.length > 0 || passSections.length > 0
                ? "default"
                : "primary"
            }
          >
            <TableWrap>
              <Table stack>
                <caption className="sr-only">
                  Runs an orchestrator block decided on, and where each has got to
                </caption>
                <RunTableHead />
                <RunRows nodes={emittedRuns} nodeName={nodeName} />
              </Table>
            </TableWrap>
            {/* One line, and it leads with what is not already said a card
                up: these count against the same limit and the same Stop. */}
            <Hint>
              Counted against this workflow&rsquo;s limit and ended by Stop all,
              like every other block — started with no approval, under the
              guards and fan-out cap the saved workflow fixed
            </Hint>
          </Card>
        </>
      )}
    </>
  );
}
