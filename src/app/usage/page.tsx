"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { HoldoutReadbackCard } from "@/components/HoldoutReadbackCard";
import { RepoReadingCards } from "@/components/RepoReadingCards";
import { RepoSpendCard } from "@/components/RepoSpendCard";
import { SourceRegion } from "@/components/SourceRegion";
import { UsageNotices } from "@/components/UsageNotices";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { ListGroup, ListRow } from "@/components/ui/List";
import { ListView, STICKY_HEAD } from "@/components/ui/ListView";
import { Notice } from "@/components/ui/Notice";
import { startPoll } from "@/lib/poll";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/Table";
import { PERIOD_OPTIONS, UsagePeriods } from "@/components/UsagePeriods";
import type { PeriodGranularityDTO, UsageResponse } from "@/lib/apiTypes";
import {
  agentOriginBadge,
  type BadgeTone,
  fmtPct,
  fmtTokens,
  fmtUSD,
  pollFailureMessage,
  shortPath,
} from "@/lib/format";
import { totalTokens } from "@/lib/pricing";

/*
 * The analysis half of what the dashboard used to be.
 *
 * `/` answers what an operator needs on landing — what is left of each window,
 * whether it will run out first, and whether something is spending or held.
 * Everything here is a reading of how the money went, which nobody needs in
 * order to decide whether to start a run, and which buried the four answers
 * that are needed under a dozen cards. Every figure is the same `GET
 * /api/usage` answer the dashboard reads, laid out rather than recomputed.
 */

/** Fixed order, so the picker and the map it indexes cannot disagree. */
const DIMENSIONS = ["model", "project", "agent"] as const;
type Dimension = (typeof DIMENSIONS)[number];

/**
 * One name per slice, read by the picker and by the table's own column head.
 *
 * `agent` was "Sub-agent" while the only way a name reached `attributionAgent`
 * was a turn the main thread handed off. A run can now be *started as* an agent,
 * so a name in this column need not be a sub-agent at all — and the word has to
 * stop asserting that it is, because the arithmetic underneath cannot tell the
 * two apart and never tries to. It groups on whatever the CLI wrote.
 */
const DIMENSION_LABEL: Record<Dimension, string> = {
  model: "Model",
  project: "Project",
  agent: "Agent",
};

const DIMENSION_OPTIONS = DIMENSIONS.map((value) => ({
  value,
  label: DIMENSION_LABEL[value],
}));

/**
 * One row of the breakdown table, whichever slice is showing.
 *
 * `mark` is optional because only one dimension has anything to mark: an agent
 * bucket can say where its definition lives, and a model or a project cannot.
 * Named rather than inferred because `satisfies` keeps each key's own narrower
 * shape, so a `mark` on one dimension is invisible at the call site that renders
 * all three.
 */
interface BreakdownRow {
  label: string;
  cost: number;
  /**
   * `totalTokens` of the bucket, cache reads included — the figure the window
   * cards and the period table print, so a column of these adds up to
   * `s.weekly.tokens` the way Share adds up to 100%. Beside the dollars because
   * a cost alone cannot tell a small job on an expensive model from a large one
   * on a cheap one.
   */
  tokens: number;
  mark?: { text: string; tone: BadgeTone } | null;
}

interface Breakdown {
  rows: BreakdownRow[];
  hint?: string;
}

/**
 * Poll cadence: the second one applies while a run is still working. The
 * dashboard's, deliberately — this page reads the same answer and is no more
 * urgent than the page that reads it for the meters.
 */
const POLL_IDLE_MS = 120_000;
const POLL_WORKING_MS = 60_000;

/** Every table cuts its tail. What is cut is counted rather than dropped. */
const MAX_BREAKDOWN_ROWS = 12;
const MAX_TOOL_ROWS = 12;

/**
 * The figure at the right of a grouped row.
 *
 * Tabular for the reason every figure on this page is: the whole card re-renders
 * on every poll, and a proportional digit set moves the right edge of the
 * column each time a 1 becomes an 8.
 */
function ListValue({ children }: { children: ReactNode }) {
  return (
    <span className="text-sm font-medium tabular-nums text-ink">{children}</span>
  );
}

/** Middot between metadata items, hidden from assistive tech as pure ornament. */
function Sep() {
  return (
    <span aria-hidden="true" className="text-ink-faint">
      ·
    </span>
  );
}

/**
 * The title renders before any data does, and never moves afterwards.
 *
 * The loading, error and loaded states all mount this identically, so the one
 * layout shift a page like this cannot avoid — first paint — happens below the
 * fold of the header rather than under it.
 */
function PageHeader({ children }: { children: ReactNode }) {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">
        Usage breakdown
      </h1>
      <p className="mb-5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs tabular-nums text-ink-muted">
        {children}
      </p>
    </>
  );
}

/**
 * Shaped like the grouped cards it stands in for, and static for the reason
 * the dashboard's is: a shimmer would be the only looping motion on the page,
 * and the sentence above it already says what is happening.
 */
function UsageSkeleton() {
  return (
    <div aria-busy="true">
      {[0, 1].map((card) => (
        <Card key={card} emphasis="quiet" className="mb-4">
          <div className="mb-3 h-3 w-32 rounded-sm bg-inset" />
          <div className="divide-y divide-line rounded-lg border border-line bg-grouped">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center justify-between px-3.5 py-3">
                <div className="h-3 w-40 rounded-sm bg-inset" />
                <div className="h-3 w-16 rounded-sm bg-inset" />
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

export default function UsagePage() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [dimension, setDimension] = useState<Dimension>("model");
  const [granularity, setGranularity] = useState<PeriodGranularityDTO>("week");

  /**
   * A run in flight is the one time this answer has something new to say every
   * few seconds — its telemetry lands per API request, while `runs.spent_usd`
   * waits for the end of the whole work cycle. Only 2x faster, and only while
   * that is true: `buildSnapshot` re-aggregates the full history on every
   * request and the agent is competing for the same CPU.
   */
  const working = (data?.telemetry?.workingRunCount ?? 0) > 0;

  useEffect(() => {
    let alive = true;
    // The calendar buckets are cut server-side, and cutting them in the
    // container's UTC would file a late-evening turn under tomorrow. Read here
    // rather than at render: this component is server-rendered too, and the
    // server's zone in the first paint would not match the browser's in the
    // second. `resolveTimeZone` refuses anything that is not a zone.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    const load = async () => {
      try {
        const res = await fetch(`/api/usage?tz=${encodeURIComponent(tz)}`, {
          cache: "no-store",
        });
        const json = await res.json().catch(() => ({}));
        if (!alive) return;
        if (!res.ok) {
          // The last good snapshot stays on screen and the banner says it is
          // stale. Blanking the page on one failed poll threw away the only
          // figures the operator had, and a page that vanishes for a second
          // every time the server restarts is worse than a stale one that
          // admits it.
          setPollError(pollFailureMessage(res.status, json.error));
          return;
        }
        setData(json);
        setPollError(null);
      } catch (e) {
        if (alive) {
          setPollError(
            pollFailureMessage(null, e instanceof Error ? e.message : String(e)),
          );
        }
      }
    };
    const stop = startPoll(load, working ? POLL_WORKING_MS : POLL_IDLE_MS);
    return () => {
      alive = false;
      stop();
    };
  }, [working]);

  /**
   * Five separate cards became one switchable list. They were identical in
   * shape — a label, a cost, a share of the window — so five of them side by
   * side spent a screen of vertical space saying "there are five ways to slice
   * this" rather than showing any one slice well.
   */
  const breakdowns = useMemo<Record<Dimension, Breakdown> | null>(() => {
    if (!data) return null;
    const s = data.snapshot;
    return {
      model: {
        rows: s.byModel.map((m) => ({
          label: m.model,
          cost: m.agg.costUSD,
          tokens: totalTokens(m.agg.tokens),
        })),
      },
      project: {
        rows: s.byProject.map((p) => ({
          label: shortPath(p.project),
          cost: p.agg.costUSD,
          tokens: totalTokens(p.agg.tokens),
        })),
      },
      agent: {
        // The bucket is still whatever the CLI recorded on the turn; the chip
        // says where this install found a definition for that name. Nothing
        // about the registry moves a dollar between rows, and neither does
        // starting a run as an agent — this app never infers a bucket.
        rows: s.byAgent.map((r) => ({
          label: r.agent,
          cost: r.agg.costUSD,
          tokens: totalTokens(r.agg.tokens),
          mark: agentOriginBadge(r.origin),
        })),
        // `(main thread)` is the bucket whose meaning moved. It was "not an
        // agent"; it is now "no agent name on the turn", which a run started as
        // one may or may not land in — unmeasured, and nothing here branches on
        // the answer. Saying so is what stops a column of agent names reading as
        // proof of delegation, and an all-main-thread column reading as proof
        // that no run was ever started as anything.
        hint: data.meta.includeSidechains
          ? "Unmarked names have no definition here: a built-in, a repository's own agent, or a deleted one. (main thread) is a turn with no agent name recorded, which may include a run started as one."
          : "Sub-agent turns are excluded in Settings, but a session started as an agent can still record its name here.",
      },
    };
  }, [data]);

  // A live region so a page that has quietly stopped refreshing announces
  // itself. The figures deliberately are not: a polite region over the tables
  // would read every dollar total aloud on every poll. Only the poll failure:
  // the configuration problems and the held fleet are facts about whether
  // anything can run, and those are said on the dashboard.
  const banner = (
    <div aria-live="polite">
      {pollError && <Notice tone="danger">{pollError}</Notice>}
    </div>
  );

  if (!data || !breakdowns) {
    return (
      <>
        <PageHeader>
          {pollError ? "Could not read usage." : "Reading transcripts…"}
        </PageHeader>
        {banner}
        {!pollError && <UsageSkeleton />}
      </>
    );
  }

  const { snapshot: s, meta, periods } = data;
  const cacheShare =
    s.weekly.tokens > 0 ? s.weekly.agg.tokens.cacheRead / s.weekly.tokens : null;
  const current = breakdowns[dimension];
  const breakdownOmitted = Math.max(0, current.rows.length - MAX_BREAKDOWN_ROWS);
  const toolsOmitted = Math.max(0, s.byTool.rows.length - MAX_TOOL_ROWS);

  return (
    <>
      <PageHeader>
        <span>
          Computed from{" "}
          <span className="mono" title={meta.transcriptDir}>
            {shortPath(meta.transcriptDir, 2)}
          </span>
        </span>
        <Sep />
        {/* This app's own footprint used to get its own segment here — it is a
            fact about the reading, not a reading, and it used to be the thing
            that eventually killed the container — but a reader skimming this
            strip for usage facts has no use for a live number, so it now rides
            the count it fills rather than standing beside it: the parsed turns
            are what fills this heap. Still findable on hover, not on the eviction
            Notice below, because that one only renders once the cache is already
            past its bound and this figure is the thing an operator would want
            before that happens. */}
        <span
          title={`${Math.round(meta.memory.heapUsedBytes / 1e6).toLocaleString()} MB heap of ${Math.round(meta.memory.heapLimitBytes / 1e6).toLocaleString()} MB — ${meta.memory.cache.entries.toLocaleString()} of at most ${meta.memory.cache.maxEntries.toLocaleString()} parsed turns cached across ${meta.memory.cache.files.toLocaleString()} files`}
        >
          {meta.entryCount.toLocaleString()} deduplicated turns
        </span>
        <Sep />
        <span>{meta.fileCount.toLocaleString()} session files</span>
        {meta.entrypoints.length > 0 && (
          <>
            <Sep />
            <span className="mono">{meta.entrypoints.join(", ")}</span>
          </>
        )}
      </PageHeader>
      {banner}

      {/* Above the regions, because each qualifies figures in all of them. */}
      <UsageNotices meta={meta} snapshot={s} page="usage" />

      {/* The cards this page's own price table produced. The two meters on the
          dashboard are the same reading; these are what it breaks down into. */}
      <SourceRegion
        heading="Your subscription"
        statement="This app’s price table over every Claude Code transcript on this machine."
      >
        {/* History first: this page is where the last fortnight is read, and
            the meters that describe right now are on the dashboard. */}
        <UsagePeriods
          series={periods[granularity]}
          // The picker is rendered here rather than inside the card because that
          // component is unit-tested against the plain CommonJS emits, where the
          // path alias `SegmentedControl` reaches `Icon` through does not
          // resolve. The page already owns which granularity is selected.
          control={
            <SegmentedControl
              options={PERIOD_OPTIONS}
              value={granularity}
              onChange={setGranularity}
              label="Period length"
            />
          }
          reservedHeadroomFraction={meta.reservedHeadroomFraction}
        />

        <Card emphasis="quiet" className="mb-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            {/* The row above already states the gap under this heading, so the
                title's own `mb-3` is not a gap here at all — it is 12px inside
                the flex line, and `items-center` centres each item's *margin*
                box, so the words sat 6px above the control beside them. The
                cancellation is on a wrapper rather than an `mb-0` on the title
                for the reason `ui/Field` states about width: two utilities for
                one property on one element resolve by stylesheet order, and
                Tailwind emits `mb-*` ascending, so the component's larger value
                wins whatever a call site writes. */}
            <div className="-mb-3">
              <CardTitle>
                Where it went — {s.weekly.label.toLowerCase()}
              </CardTitle>
            </div>
            {/* Was a hand-rolled pill strip claiming `role="tablist"`. The kit's
                segmented control is the native idiom for one choice from a short
                fixed set, and it owns the roving tabindex and the arrow keys that
                used to be written out here. */}
            <SegmentedControl
              options={DIMENSION_OPTIONS}
              value={dimension}
              onChange={setDimension}
              label="Breakdown dimension"
            />
          </div>

          {/* No tabpanel role and no tabindex: a radiogroup is not a tablist, and
              a focusable region with nothing focusable inside it is a dead tab
              stop. The list names itself with a caption instead. */}
          {current.rows.length === 0 ? (
            <Empty>No usage in this window.</Empty>
          ) : (
            <ListView box="capped">
              <Table stack>
                <caption className="sr-only">
                  Cost and tokens by {DIMENSION_LABEL[dimension].toLowerCase()}{" "}
                  over {s.weekly.label.toLowerCase()}, highest cost first
                </caption>
                <THead>
                  <tr>
                    <Th className={STICKY_HEAD}>{DIMENSION_LABEL[dimension]}</Th>
                    <Th num className={STICKY_HEAD}>
                      Cost
                    </Th>
                    <Th num className={STICKY_HEAD}>
                      Tokens
                    </Th>
                    <Th num className={STICKY_HEAD}>
                      Share
                    </Th>
                  </tr>
                </THead>
                <TBody>
                  {/* Every turn lands in some bucket — including an explicit
                      "(main thread)" row — so the column adds to 100% instead
                      of quietly omitting a remainder. */}
                  {current.rows.slice(0, MAX_BREAKDOWN_ROWS).map((r) => (
                    <Tr key={r.label}>
                      {/* No label: the bucket's own name is what the record is,
                          and the picker above already says which dimension
                          is being named. `break-all` below the
                          breakpoint because a project bucket is a path, which has
                          no space to wrap at and would take the pane sideways. */}
                      <Td className="max-md:break-all">
                        <span className="mono">{r.label}</span>
                        {r.mark && (
                          <>
                            {" "}
                            <Badge tone={r.mark.tone}>{r.mark.text}</Badge>
                          </>
                        )}
                      </Td>
                      <Td num label="Cost">
                        {fmtUSD(r.cost)}
                      </Td>
                      <Td num label="Tokens">
                        {fmtTokens(r.tokens)}
                      </Td>
                      <Td num label="Share">
                        {s.weekly.costUSD > 0
                          ? fmtPct(r.cost / s.weekly.costUSD)
                          : "—"}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </ListView>
          )}

          {/* Rows are cost-descending, so the tail really is the cheap end — but
              a list that stops at twelve with nothing said reads as the whole
              set. Same rule a shortened diff follows. */}
          {breakdownOmitted > 0 && (
            <div className="mt-2 text-xs tabular-nums text-ink-muted">
              {breakdownOmitted} cheaper{" "}
              {breakdownOmitted === 1 ? "row is" : "rows are"} in the totals above
              but not listed.
            </div>
          )}
          {current.hint && (
            <div className="mt-2 text-xs text-ink-muted">{current.hint}</div>
          )}
        </Card>

        {/* Sits with the breakdowns because it reads the same transcripts, and
            it is deliberately *not* a fourth slice of them: every row above is a
            share of the money, and every row here is a share of the characters.
            A tool result is not a billable turn — it carries no usage block at
            all — so this card draws no per-tool dollar figure and none can be
            derived from it. What it does carry is the price of *placing* a
            token, which is the number that makes the composition actionable. */}
        <Card emphasis="quiet" className="mb-4">
          <CardTitle>What filled the context</CardTitle>
          <p className="mb-3 max-w-[68ch] text-xs text-ink-muted">
            Shares are of tool-output characters over{" "}
            {s.weekly.label.toLowerCase()}, not of money.
          </p>

          <ListGroup>
            <ListRow
              label="Tokens placed"
              description="Fresh input, cache writes and output; re-reads excluded"
            >
              <ListValue>{fmtTokens(s.byTool.placedTokens)}</ListValue>
            </ListRow>
            <ListRow
              label="Read back"
              description="Times the average placed token was re-read"
            >
              <ListValue>
                {s.byTool.reReadRatio === null
                  ? "—"
                  : `${s.byTool.reReadRatio.toFixed(1)}×`}
              </ListValue>
            </ListRow>
            <ListRow
              label="Cost per million placed"
              description="This window’s bill over the tokens placed; not a rate anyone is charged"
            >
              <ListValue>
                {s.byTool.costPerMillionPlacedUSD === null
                  ? "—"
                  : fmtUSD(s.byTool.costPerMillionPlacedUSD)}
              </ListValue>
            </ListRow>
          </ListGroup>

          {s.byTool.rows.length === 0 ? (
            <div className="mt-4">
              <Empty>No tool calls recorded in this window.</Empty>
            </div>
          ) : (
            <div className="mt-4">
              <ListView box="capped">
                <Table stack>
                  <caption className="sr-only">
                    Characters of tool output placed into contexts over{" "}
                    {s.weekly.label.toLowerCase()}, largest first
                  </caption>
                  <THead>
                    <tr>
                      <Th className={STICKY_HEAD}>Tool</Th>
                      <Th num className={STICKY_HEAD}>
                        Calls
                      </Th>
                      <Th num className={STICKY_HEAD}>
                        Characters
                      </Th>
                      <Th num className={STICKY_HEAD}>
                        Share
                      </Th>
                    </tr>
                  </THead>
                  <TBody>
                    {s.byTool.rows.slice(0, MAX_TOOL_ROWS).map((r) => (
                      <Tr key={r.tool}>
                        {/* No label: the tool's own name is what the record is.
                            `break-all` below the breakpoint because an MCP tool
                            id is one long token with nothing to wrap at. */}
                        <Td className="max-md:break-all">
                          <span className="mono">{r.tool}</span>
                        </Td>
                        <Td num label="Calls">
                          {r.calls.toLocaleString()}
                        </Td>
                        <Td num label="Characters">
                          {fmtTokens(r.resultChars)}
                        </Td>
                        <Td num label="Share">
                          {fmtPct(r.share)}
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </ListView>
            </div>
          )}

          {toolsOmitted > 0 && (
            <div className="mt-2 text-xs tabular-nums text-ink-muted">
              {toolsOmitted} smaller{" "}
              {toolsOmitted === 1 ? "tool is" : "tools are"} in the totals above
              but not listed.
            </div>
          )}
          {/* Only where there is something to qualify: an empty window has
              already said so above, and a caveat with no figure under it is a
              sentence the eye learns to skip. */}
          {s.byTool.totalCalls > 0 && (
            <div className="mt-2 max-w-[68ch] text-xs text-ink-muted">
              {s.byTool.totalCalls.toLocaleString()} calls placed{" "}
              {fmtTokens(s.byTool.totalResultChars)} characters.
              {s.byTool.unansweredCalls > 0 && (
                <>
                  {" "}
                  {s.byTool.unansweredCalls.toLocaleString()} have no recorded
                  result and count toward calls but no share.
                </>
              )}{" "}
              Image results count no characters, so a tool that answers in
              pictures reads low.
            </div>
          )}
        </Card>

        {/* The half of "Rate and totals" that is not about running out; the
            burn rate and the exhaustion projection stayed on the dashboard,
            because those answer whether a run can start. A grouped list rather
            than equally-weighted bordered boxes, for the reason it always was:
            these are derived figures about the window, not peers of the
            meters. The unit rides in the description rather than beside the
            figure, so the values stay one column of comparable numbers — a
            percentage, a dollar figure. */}
        <Card className="mb-4">
          <CardTitle>Totals</CardTitle>
          <ListGroup>
            {/* Never "which is why the dollar figures track work": this install's
                own telemetry had cache reads at 60% of the *bill* as well as 96%
                of the tokens, so a reader told that looks for the expensive run
                rather than the long one. */}
            <ListRow label="Cache reads" description="Share of all tokens, billed at 0.1×">
              <ListValue>{fmtPct(cacheShare)}</ListValue>
            </ListRow>

            <ListRow
              label="Lifetime recorded"
              description="Equivalent API cost, all local transcripts"
            >
              <ListValue>{fmtUSD(s.totalCostUSD)}</ListValue>
            </ListRow>
          </ListGroup>
        </Card>
      </SourceRegion>

      <SourceRegion
        heading="What this app spent"
        statement="Money runs this app started reported spending."
      >
        {/* A different question with a different source: the cards above
            slice the transcript window by what produced it, this one says what
            each repository's own runs reported spending. The two are never
            added — see the card. The install limit's card reads the same
            source and stayed on the dashboard, because a limit that stops
            every agent when it trips is a thing to see on landing. */}
        <RepoSpendCard />
      </SourceRegion>

      {/* Its own band, because two of its three readings are counts and are no
          cost source at all; the third is `run_reviews.cost_usd`, which no
          card above sums. Beside the repository spend because it answers the
          question that card raises — where a repository's money went over
          and over again — and never adds to it. */}
      <SourceRegion
        heading="What runs keep re-deriving"
        statement="Counted per repository from each run’s own log, and from the conflict resolutions this app paid for."
      >
        <RepoReadingCards />
      </SourceRegion>

      {/* The prior-read pointer's holdout, read from the export tables the
          event sweep does not touch. Its own band because it asks a different
          question from the one above: that band counts what runs re-derive,
          this one asks whether naming files in advance changed it. Its one
          spend figure is `runs.spent_usd`, named on the card. */}
      <SourceRegion
        heading="Does the prior-read pointer change what runs do"
        statement="Runs dealt the list of files earlier runs opened most, against runs held back from it, read from the holdout export."
      >
        <HoldoutReadbackCard />
      </SourceRegion>
    </>
  );
}
