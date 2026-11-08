"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { CodexWindows } from "@/components/CodexWindows";
import { InstallSpendCard } from "@/components/InstallSpendCard";
import { LiveTelemetry } from "@/components/LiveTelemetry";
import { Meter } from "@/components/Meter";
import { SourceRegion } from "@/components/SourceRegion";
import { UsageNotices } from "@/components/UsageNotices";
import { WindowHead, resetText } from "@/components/WindowHead";
import {
  isProjectable,
  outlookLine,
  windowOutlooks,
  type WindowOutlook,
} from "@/components/windowOutlook";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle, Stat, StatSub } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { windowCardNotes } from "@/lib/windowCardNotes";
import { startPoll } from "@/lib/poll";
import type {
  PlanUsageDTO,
  UsageResponse,
  WindowStateDTO,
} from "@/lib/apiTypes";
import {
  fmtPct,
  fmtRelative,
  fmtTokens,
  fmtUSD,
  pollFailureMessage,
  shortPath,
} from "@/lib/format";

/**
 * What a window's percentage is measured against, in the meter's detail line.
 *
 * `w.limit` is the *effective* ceiling: `limitConfig()` has already subtracted
 * reserved headroom. Calling that "your configured estimate" named the wrong
 * number — at a 15% reserve a typed $650 is measured against $552.50, so the
 * bar climbs ~18% faster than the figure in Settings implies and the gap widens
 * with usage. The arithmetic was never wrong; the label was, and a meter that
 * disagrees with the value you set reads as a broken calculation. So say both
 * numbers whenever a reserve is in force.
 *
 * A raw-token reading behind a cost meter rides on the same line: it is the
 * other ceiling the run-out line below may have been projected from.
 */
function ceilingDetail(
  w: WindowStateDTO,
  configured: number | null,
  reserve: number,
  plan: PlanUsageDTO | null,
  now: number,
): string {
  const reduced = reserve > 0 && configured !== null;

  // The provider's own percentage has no ceiling behind it to describe, so
  // this says whose it is and how old: it is cached for up to five minutes,
  // and a reader reconciling it against a window that just moved needs to
  // know they are looking at a reading, not a live tap.
  if (w.fractionMetric === "plan") {
    return plan
      ? `Anthropic’s reading, ${fmtRelative(plan.fetchedAt, now)}`
      : "Anthropic’s reading";
  }

  if (w.fractionMetric === "cost") {
    const ceiling = reduced
      ? `Ceiling ${fmtUSD(w.limit ?? 0)} API-equivalent: your ${fmtUSD(configured)} less ${fmtPct(reserve)} reserve`
      : `Ceiling ${fmtUSD(w.limit ?? 0)} API-equivalent, your estimate`;
    return w.tokenFraction !== null
      ? `${ceiling} · token ceiling ${fmtPct(w.tokenFraction)}`
      : ceiling;
  }
  if (w.fractionMetric === "tokens") {
    return reduced
      ? `Ceiling ${fmtTokens(w.limit ?? 0)} raw tokens: your ${fmtTokens(configured)} less ${fmtPct(reserve)} reserve`
      : `Ceiling ${fmtTokens(w.limit ?? 0)} raw tokens`;
  }
  return "Set a ceiling in Settings to see a percentage";
}

/** Poll cadence: the second one applies while a run is still working. */
const POLL_IDLE_MS = 120_000;
const POLL_WORKING_MS = 60_000;

/**
 * The line under a Claude window's meter that answers whether it runs out
 * before it resets. A run-out is set in the ink colour rather than muted,
 * because it is the one outcome on this card an operator acts on; the words
 * carry it as well, so nothing is said in colour alone.
 */
function OutlookLine({ outlook, rate }: { outlook: WindowOutlook; rate: string | null }) {
  const line = outlookLine(outlook, rate);
  if (line === null) return null;
  return (
    <div
      className={`tabular-nums ${
        outlook.kind === "runs-out" ? "font-medium text-ink" : "text-ink-muted"
      }`}
    >
      {line}
    </div>
  );
}

/**
 * In place of "% left" when a window has no reading: what it has spent, so the
 * slot still says something true and "Volumes and costs above are exact
 * regardless" in the no-ceiling notice still points at a figure.
 */
function WindowSpend({ w, size }: { w: WindowStateDTO; size: "large" | "default" }) {
  return (
    <>
      <Stat size={size}>{fmtUSD(w.costUSD)}</Stat>
      <StatSub>
        <span className="tabular-nums">
          {fmtTokens(w.tokens)} tokens · {w.agg.entryCount.toLocaleString()} turns
        </span>
      </StatSub>
    </>
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
 * layout shift a dashboard cannot avoid — first paint — happens below the fold
 * of the header rather than under it.
 */
function PageHeader({ children }: { children: ReactNode }) {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">
        Claude Code usage
      </h1>
      <p className="mb-5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs tabular-nums text-ink-muted">
        {children}
      </p>
    </>
  );
}

/**
 * Shaped like the cards it stands in for, so the page settles rather than
 * jumps when the first response lands.
 *
 * Deliberately static: a shimmer or a spinner would be the only looping motion
 * on the page, and the sentence above it already says what is happening.
 */
function DashboardSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-4 lg:grid-cols-2 lg:items-start">
      {/* The loaded page's two columns: the window card, and beside it the
          install limit, so the first response settles into the same shape. */}
      <Card emphasis="primary">
        <div className="h-3 w-40 rounded-sm bg-inset" />
        <div className="mt-4 h-7 w-32 rounded-sm bg-inset" />
        <div className="mt-5 h-3 w-full rounded-pill bg-inset" />
        <div className="mt-3 h-3 w-3/4 rounded-sm bg-inset" />
        <div className="mt-5 border-t border-line pt-4">
          <div className="h-3 w-28 rounded-sm bg-inset" />
          <div className="mt-4 h-6 w-24 rounded-sm bg-inset" />
          <div className="mt-5 h-2 w-full rounded-pill bg-inset" />
          <div className="mt-3 h-3 w-2/3 rounded-sm bg-inset" />
        </div>
      </Card>
      <Card>
        <div className="h-3 w-40 rounded-sm bg-inset" />
        <div className="mt-5 h-2 w-full rounded-pill bg-inset" />
        <div className="mt-3 h-3 w-3/4 rounded-sm bg-inset" />
      </Card>
    </div>
  );
}

/**
 * A machine with nothing to measure yet.
 *
 * The meters would all read $0.00 against a hatched bar, which is accurate and
 * useless: it is bit-for-bit what a wrongly-pointed `CLAUDE_HOME` looks like.
 * So say which of the two it is, and what to do about either.
 */
function FirstRun({
  transcriptDir,
  fileCount,
}: {
  transcriptDir: string;
  fileCount: number;
}) {
  return (
    <Card emphasis="primary">
      <CardTitle>Nothing to measure yet</CardTitle>
      <p className="max-w-[64ch] text-sm text-ink-muted">
        {fileCount > 0 ? (
          <>
            <span className="tabular-nums">{fileCount.toLocaleString()}</span>{" "}
            session {fileCount === 1 ? "file" : "files"} were read from{" "}
            <span className="mono">{transcriptDir}</span>, and none of them
            contains a billable turn yet.
          </>
        ) : (
          <>
            No Claude Code session files under{" "}
            <span className="mono">{transcriptDir}</span>.
          </>
        )}
      </p>
      <ul className="mt-3 max-w-[64ch] list-disc space-y-1.5 pl-5 text-sm text-ink-muted marker:text-ink-faint">
        <li>Use Claude Code once in any project.</li>
        <li>
          If you have already used it, <span className="mono">CLAUDE_HOME</span>{" "}
          points somewhere else; changing it means restarting the container.
        </li>
        <li>
          <Link href="/settings">Set a ceiling</Link> for the meters to measure
          against.
        </li>
      </ul>
    </Card>
  );
}

export default function Dashboard() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  /**
   * A run in flight is the one time this page has something new to say every
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
          // figures the operator had, and a dashboard that vanishes for a
          // second every time the server restarts is worse than a stale one
          // that admits it.
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

  // The banner is a live region so a page that has quietly stopped refreshing
  // announces itself. The figures deliberately are not: a polite region over
  // the meters would read every dollar total aloud on every poll.
  const banner = (
    <div aria-live="polite">
      {pollError && <Notice tone="danger">{pollError}</Notice>}
      {/* Above the meters rather than under them with the other notices, and
          that is the whole distinction: those explain a number the reader has
          just looked at, where this one says the numbers may be describing the
          wrong machine. A mount that is not a directory and a CLAUDE_HOME with
          no transcripts under it both render as the zeros below — which is also
          what a quiet week looks like. A refusal never reaches here (the boot
          exits on one), but it is rendered as danger rather than dropped, so a
          route that somehow serves one still shows it. */}
      {data?.meta.configProblems.map((p) => (
        <Notice
          key={`${p.variable}:${p.message}`}
          tone={p.severity === "refuse" ? "danger" : "warn"}
        >
          <strong className="mono">{p.variable}</strong> {p.message}
        </Notice>
      ))}
      {/* In words, because a held fleet and a quiet one are identical on this
          page otherwise: every meter reads the same and the only difference is
          that the queue never moves. It sits with the poll failure rather than
          among the cards for the same reason — it is a fact about whether what
          is below can still change. */}
      {data?.meta?.newWorkPaused && (
        <Notice tone="warn">
          <strong>New work is held.</strong> Queued runs, dependents, schedules,
          orchestrator blocks and review blocks all wait, and no merge conflict
          is resolved; work in flight carries on.{" "}
          <Link href="/runs">Resume it on the runs page</Link>.
        </Notice>
      )}
    </div>
  );

  if (!data) {
    return (
      <>
        <PageHeader>
          {pollError ? "Could not read usage." : "Reading transcripts…"}
        </PageHeader>
        {banner}
        {!pollError && <DashboardSkeleton />}
      </>
    );
  }

  const { snapshot: s, meta, telemetry, install } = data;
  // `wkEnd` is `now` itself unless a weekly reset instant is known, so this is
  // a reading of the window rather than a guess about the setting behind it.
  const weeklyResets = s.weekly.endsAt > s.now;
  const cardNotes = windowCardNotes(s, meta.sessionResetOverrideAt);
  const sessionResetEstimated = cardNotes.sessionResetSource === "derived";
  const anyProviderReading =
    s.session.fractionMetric === "plan" || s.weekly.fractionMetric === "plan";

  // One projected instant, set against the reset of the window it belongs to —
  // see `windowOutlooks` for how that window is told, and when it cannot be.
  const outlooks = windowOutlooks(
    s.projectedExhaustionAt,
    s.now,
    { resetsAt: s.session.endsAt, projectable: isProjectable(s.session) },
    {
      resetsAt: weeklyResets ? s.weekly.endsAt : null,
      projectable: isProjectable(s.weekly),
    },
  );
  // The rate the projection extrapolates, said once: on the line that carries
  // a run-out the week owns, and otherwise on the session's.
  const rate = `${fmtUSD(s.burnCostPerHour)}/h`;
  const rateOnWeekly = outlooks.weekly.kind === "runs-out";

  // The provenance strip — where the transcripts were read from, how many
  // turns, the heap behind them — moved to `/usage` with the analysis it
  // describes. What is left here is the plan, which is about the windows, and
  // the way to that page.
  const header = (
    <PageHeader>
      {/* Names the plan only. Anthropic publishes no number for a tier, so this
          never implies a ceiling — the meters stay indeterminate until one is
          configured. */}
      {meta.account.label && (
        <>
          <span className="font-medium text-ink">{meta.account.label}</span>
          <Sep />
        </>
      )}
      <Link href="/usage">Breakdowns and history</Link>
    </PageHeader>
  );

  if (meta.entryCount === 0) {
    return (
      <>
        {header}
        {banner}
        <FirstRun
          transcriptDir={shortPath(meta.transcriptDir, 3)}
          fileCount={meta.fileCount}
        />
      </>
    );
  }

  return (
    <>
      {header}
      {banner}

      {/* Two columns from `lg`: the windows, and beside them what this app's
          own runs are doing — live telemetry, then the install limit. Both
          right-hand cards are about money this app spent, which is why they
          sit together and apart from the windows; they are still two readings
          (telemetry and `runs.spent_usd`), each in its own card, and the
          install card keeps its own region. The right column used to hold
          telemetry alone with the install card a band below the row, and at
          1280×800 that put the limit under the fold of a page meant to be read
          without scrolling.

          `items-start` so a short right column keeps its own height rather
          than being stretched to the window card's. Below `lg` it is one
          column in the same reading order. */}
      <div className="mb-4 grid gap-4 lg:grid-cols-2 lg:items-start">
        {/* The one `primary` card on the screen. Both windows live in it
            because they are one subject — what may be spent — and inside it
            the session leads: it refills on its own, so it is the allowance an
            operator can act on in the next few minutes. Each window answers
            three things in order — what is left and when it resets, the meter,
            and whether it runs out first — and nothing else is drawn unless
            it changes what the meter means. */}
        <Card emphasis="primary">
          <WindowHead
            size="large"
            title={
              <CardTitle>
                {s.session.label}
                {s.session.agg.entryCount > 0 && <Badge tone="accent">active</Badge>}
              </CardTitle>
            }
            used={s.session.fraction}
            instead={<WindowSpend w={s.session} size="large" />}
            reset={resetText(s.session.endsAt, s.now, sessionResetEstimated)}
          />
          <Meter
            size="hero"
            label="Session consumed"
            fraction={s.session.fraction}
            upperFraction={s.session.guardFraction}
            upperHint="once unpriced models are charged"
            detail={ceilingDetail(
              s.session,
              s.session.fractionMetric === "tokens"
                ? meta.configuredCeilings.sessionTokens
                : meta.configuredCeilings.sessionCost,
              meta.reservedHeadroomFraction,
              s.plan,
              s.now,
            )}
          />
          <div className="mt-2 space-y-1 text-xs">
            <OutlookLine outlook={outlooks.session} rate={rateOnWeekly ? null : rate} />
            {/* Visible rather than folded, unlike the other two provenances of
                this clock: a pinned start changes what the meter counts — and
                what the guard does — so it is a state, not an explanation. */}
            {cardNotes.sessionResetSource === "pinned" && (
              <div className="text-ink-muted">
                Window start set by a <Link href="/settings">manual reset</Link>:
                usage before{" "}
                <span className="tabular-nums">
                  {new Date(s.session.startsAt).toLocaleString()}
                </span>{" "}
                is excluded here and from the budget guard.
              </div>
            )}
          </div>

          <div className="mt-5 border-t border-line pt-4">
            <WindowHead
              title={<CardTitle>{s.weekly.label}</CardTitle>}
              used={s.weekly.fraction}
              instead={<WindowSpend w={s.weekly} size="default" />}
              reset={
                weeklyResets
                  ? resetText(s.weekly.endsAt, s.now)
                  : "No reset · old turns age out"
              }
            />
            <Meter
              label="Weekly consumed"
              fraction={s.weekly.fraction}
              upperFraction={s.weekly.guardFraction}
              upperHint="once unpriced models are charged"
              detail={ceilingDetail(
                s.weekly,
                s.weekly.fractionMetric === "tokens"
                  ? meta.configuredCeilings.weeklyTokens
                  : meta.configuredCeilings.weeklyCost,
                meta.reservedHeadroomFraction,
                s.plan,
                s.now,
              )}
            />
            <div className="mt-2 space-y-1 text-xs">
              <OutlookLine outlook={outlooks.weekly} rate={rateOnWeekly ? rate : null} />
              {/* A wall that binds without ever reaching this meter: the weekly
                  allowance is split per model family on some plans, so Opus can
                  be full while the all-model window reads a quarter. The guard
                  stops on the worst of them, so name them rather than letting a
                  refusal arrive with nothing on screen behind it. */}
              {cardNotes.modelWallLine !== null && (
                <div className="tabular-nums text-ink-muted">{cardNotes.modelWallLine}</div>
              )}
            </div>
          </div>

          {/* In the same card because it is the same subject — what may still
              be spent — for the other provider. Only once Codex has a stored
              sign-in: an install that never used Codex is not shown an empty
              section about it. */}
          {data.codex && <CodexWindows codex={data.codex} now={s.now} />}

          {/* Where each figure on this card comes from. Read once, and no
              decision here is taken against it, which is the one ground
              `ui-density-audit.md` §1.1 gives for folding an explanation:
              each line used to sit under the meter it explains, and together
              they were most of the card's height. The facts that change what a
              meter means — a pinned start, a per-model wall — stay visible
              above. */}
          <Disclosure
            summary="How these are read"
            className="mt-4 text-xs text-ink-muted"
            summaryClassName="w-fit"
          >
            <ul className="mt-2 max-w-[68ch] list-disc space-y-1 pl-5 marker:text-ink-faint">
              {cardNotes.sessionResetSource === "provider" ? (
                <li>
                  The 5-hour reset is Anthropic&rsquo;s own instant, so it matches{" "}
                  <span className="mono">/usage</span> exactly.
                </li>
              ) : cardNotes.sessionResetSource === "derived" ? (
                <li>
                  The 5-hour reset (marked ~) is derived from your own turns, so it
                  can sit minutes off what <span className="mono">/usage</span>{" "}
                  reports. <Link href="/settings">Pin it</Link> if they disagree.
                </li>
              ) : null}
              {anyProviderReading && (
                <li>
                  Anthropic&rsquo;s reading covers every Claude surface that shares
                  the allowance, and is cached for up to five minutes.
                </li>
              )}
              <li>
                The burn rate is the last hour&rsquo;s spend at this app&rsquo;s
                prices. A run-out is projected only up to each window&rsquo;s own
                reset, and only the earliest is reported, so one that falls before
                the session resets is named as the session&rsquo;s or the
                week&rsquo;s unless only one of them could be it.
              </li>
              {!weeklyResets && (
                <li>
                  With no weekly reset known, the week is a trailing total and
                  never resets. Pick a <Link href="/settings">weekly reset</Link>{" "}
                  day for a fixed week.
                </li>
              )}
              {data.codex && (
                <li>
                  Codex figures are OpenAI&rsquo;s for the signed-in account, so
                  they match Codex&rsquo;s <span className="mono">/status</span>.
                  Codex reports no rate, so they carry no run-out projection.
                </li>
              )}
            </ul>
          </Disclosure>
        </Card>

        <div>
          {/* Gated on the window itself, and it has to be: `telemetryWindow`
              answers `null` when agent self-reporting is off or nothing has
              reported, so an absent card is "no run has reported" rather than
              "$0.00" — and $0.00 beside the meters is a reading an operator
              would act on. The gate is the setting and what came back on it,
              never the guard figure. With nothing working it is one line. */}
          {telemetry && <LiveTelemetry telemetry={telemetry} now={s.now} />}

          <SourceRegion
            heading="What this app spent"
            statement="Money runs this app started reported spending."
          >
            {/* The install limit stays on `/` when every other reading of
                this source went to `/usage`: a limit that stops every agent
                when it trips is a thing to see on landing. What each
                repository's runs spent is on that page, in the band of the
                same name. */}
            <InstallSpendCard install={install} />
          </SourceRegion>
        </div>
      </div>

      {/* Under the meters, not above them: each of these explains something the
          reader has just looked at — a hatched bar, a span past the fill, a
          figure that is a floor. Stacked above, they were a wall of prose
          between the title and the subject of the page. */}
      <UsageNotices meta={meta} snapshot={s} page="dashboard" />
    </>
  );
}
