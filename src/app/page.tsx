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
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle, Stat, StatSub } from "@/components/ui/Card";
import { ListGroup, ListRow } from "@/components/ui/List";
import { Notice } from "@/components/ui/Notice";
import { windowCardNotes } from "@/lib/windowCardNotes";
import { startPoll } from "@/lib/poll";
import type {
  PlanUsageDTO,
  UsageResponse,
  WindowStateDTO,
} from "@/lib/apiTypes";
import {
  fmtDateTime,
  fmtDuration,
  fmtPct,
  fmtRelative,
  fmtTokens,
  fmtUSD,
  pollFailureMessage,
  shortPath,
} from "@/lib/format";

/**
 * Describe the ceiling a window's percentage is measured against.
 *
 * `w.limit` is the *effective* ceiling: `limitConfig()` has already subtracted
 * reserved headroom. Calling that "your configured estimate" named the wrong
 * number — at a 15% reserve a typed $650 is measured against $552.50, so the
 * bar climbs ~18% faster than the figure in Settings implies and the gap widens
 * with usage. The arithmetic was never wrong; the label was, and a meter that
 * disagrees with the value you set reads as a broken calculation. So say both
 * numbers whenever a reserve is in force.
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
  // this says where it came from and how old it is instead. Both matter: it
  // covers surfaces the dollar figure above it cannot see, and it is cached
  // for up to five minutes, so a reader reconciling it against a window that
  // just moved needs to know they are looking at a reading, not a live tap.
  if (w.fractionMetric === "plan") {
    const age = plan ? ` Read ${fmtRelative(plan.fetchedAt, now)}.` : "";
    return `Anthropic's reading for this account, across every Claude surface that shares the allowance.${age}`;
  }

  if (w.fractionMetric === "cost") {
    return reduced
      ? `Ceiling: ${fmtUSD(w.limit ?? 0)} equivalent API cost — your ${fmtUSD(configured)} estimate less ${fmtPct(reserve)} reserved headroom.`
      : `Ceiling: ${fmtUSD(w.limit ?? 0)} equivalent API cost — your configured estimate.`;
  }
  if (w.fractionMetric === "tokens") {
    return reduced
      ? `Ceiling: ${fmtTokens(w.limit ?? 0)} raw tokens — your ${fmtTokens(configured)} estimate less ${fmtPct(reserve)} reserved headroom.`
      : `Ceiling: ${fmtTokens(w.limit ?? 0)} raw tokens.`;
  }
  return "Set a ceiling in Settings to see a percentage.";
}

/** Poll cadence: the second one applies while a run is still working. */
const POLL_IDLE_MS = 120_000;
const POLL_WORKING_MS = 60_000;

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
    <div aria-busy="true">
      {/* One lead card holding both windows, then a grouped list — the shape
          the loaded page has, so the first response settles into it. */}
      <Card emphasis="primary" className="mb-4">
        <div className="h-3 w-40 rounded-sm bg-inset" />
        <div className="mt-4 h-7 w-32 rounded-sm bg-inset" />
        <div className="mt-2 h-3 w-48 rounded-sm bg-inset" />
        <div className="mt-5 h-3 w-full rounded-pill bg-inset" />
        <div className="mt-3 h-3 w-3/4 rounded-sm bg-inset" />
        <div className="mt-5 border-t border-line pt-4">
          <div className="h-3 w-28 rounded-sm bg-inset" />
          <div className="mt-4 h-6 w-24 rounded-sm bg-inset" />
          <div className="mt-2 h-3 w-40 rounded-sm bg-inset" />
          <div className="mt-5 h-2 w-full rounded-pill bg-inset" />
        </div>
      </Card>
      <Card emphasis="quiet">
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
  // Spelled out per case rather than assembled from parts. Tailwind scans this
  // file for literal class strings and emits nothing for a computed one, so a
  // template built from a variable arrives in the browser as a class with no
  // rule behind it — and the failure is the silent kind this page is full of:
  // the row keeps stacking at every width and nothing throws, warns or fails a
  // typecheck. (Scanning is literal in the other direction too: an arbitrary
  // value written out in a comment here is compiled into the stylesheet.)
  //
  // Which template applies is the same question as which cards render, so the
  // two conditions are the same ones their call sites carry. A track with no
  // card in it is not free: the row packs left and the leftover is blank.
  const topRowColumns = telemetry
    ? // The cap costs nothing at any width and can start where the row does.
      "lg:grid-cols-[minmax(0,50%)_minmax(0,1fr)]"
    : // Nothing beside it, so nothing to make room for. Half a row of white
      // space to the right of the meters is a worse answer to "this box could
      // be shorter" than the wide box was.
      "";
  // The exhaustion projection extrapolates dollars and tokens per hour, so it
  // needs an allowance to run them into: a configured ceiling, or a provider
  // percentage, which implies one from what the window had spent when it was
  // read. With neither it has to say so in its own terms rather than borrowing
  // the `noCeilings` that gates `UsageNotices`' "No percentages available".
  const nothingToProjectAgainst =
    meta.configuredCeilings.sessionCost === null &&
    meta.configuredCeilings.weeklyCost === null &&
    meta.configuredCeilings.sessionTokens === null &&
    meta.configuredCeilings.weeklyTokens === null &&
    s.session.planFraction === null &&
    s.weekly.planFraction === null;
  // `wkEnd` is `now` itself unless a weekly anchor is configured, so this is a
  // reading of the window rather than a guess about the setting behind it.
  const weeklyResets = s.weekly.endsAt > s.now;
  const cardNotes = windowCardNotes(s, meta.sessionResetOverrideAt);

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

      {/* Up to two columns: the window card capped at half the row, the
          live-telemetry card taking the remainder. Which template applies,
          and from which breakpoint, is `topRowColumns` above.

          The window card used to be `minmax(0,1fr)` against that 16rem alone —
          about 84% of a 1920px row — and the comment here defended the
          asymmetry, the objection being that two co-equal cards side by side
          would say neither leads. That objection stands and so does the answer
          to it; what changed is which property carries it. `primary` against
          `default`, and a hero meter against a `text-xl` figure, are what say
          this card leads. Width was never doing that work: at 84% the extra
          space went to a `max-w-[68ch]` paragraph in a 1400px box, while the
          first-party spend figure — the one number on this page that moves
          *during* a work cycle — sat 5,700px below the fold. Half a row is
          still the widest box on the page and still the only one an elevation
          up, so nothing about what leads has changed, and neither aside's
          conclusion is now reachable only from the bottom of the page.

          Capped at half only where something is in fact beside it. A template
          with a track no card was rendered for packs the cards left and leaves
          the rest of the row blank, and a cap with nothing in the space it
          freed does the same thing on purpose — both read as something that
          failed to load, which is what `items-start` is here to avoid one axis
          over.

          `items-start` so the asides keep their own height; stretching them
          would pad a three-line card out to the meters' and make the empty
          space look like something failed to load. Below `lg` it is one column
          and they follow the meters, which is the same reading order. */}
      <div className={`mb-4 grid gap-4 lg:items-start ${topRowColumns}`}>
        {/* The one `primary` card on the screen, and the only thing on it sized
            to be read from across a room. Both windows live in it because they
            are one subject — what may be spent — and two co-equal cards side by
            side said neither of them leads. Inside it the session leads: it is
            the allowance that refills on its own, so it is the one an operator
            can act on in the next few minutes, and the week sits under the same
            hairline a grouped list uses. */}
        <Card emphasis="primary">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <div>
              <CardTitle>
                5-hour session window
                {s.session.agg.entryCount > 0 && (
                  <Badge tone="accent">active</Badge>
                )}
              </CardTitle>
              <Stat size="large">{fmtUSD(s.session.costUSD)}</Stat>
              <StatSub>
                <span className="tabular-nums">
                  {fmtTokens(s.session.tokens)} tokens ·{" "}
                  {s.session.agg.entryCount.toLocaleString()} turns
                </span>
              </StatSub>
            </div>
            {/* Relative first because that is the decision — whether to start
                something now or wait. The clock time is the confirmation, and
                the exact instant is on the title for anyone reconciling with
                `/usage`. */}
            <div
              className="text-right"
              title={new Date(s.session.endsAt).toLocaleString()}
            >
              <div className="text-sm font-medium tabular-nums text-ink">
                Resets {fmtRelative(s.session.endsAt, s.now)}
              </div>
              <div className="mt-0.5 text-xs tabular-nums text-ink-muted">
                {fmtDateTime(s.session.endsAt)}
              </div>
            </div>
          </div>

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

          {/* One block, so the footnotes read as a group belonging to the meter
              rather than as three unrelated remarks stacked under it. */}
          <div className="mt-3 max-w-[68ch] space-y-1 text-xs text-ink-muted">
            {s.session.tokenFraction !== null &&
              s.session.fractionMetric === "cost" && (
                <div className="tabular-nums">
                  Against the raw-token ceiling: {fmtPct(s.session.tokenFraction)}
                </div>
              )}
            {/* Three different provenances for one clock, and they are worth
                telling apart: the provider's own instant, a pinned one, and a
                derived one that can sit minutes off `/usage`. Saying nothing
                makes the third read as a bug rather than as the estimate it
                is — and makes the first read as an estimate when it is not. */}
            {cardNotes.sessionResetSource === "provider" ? (
              <div>
                Reset instant reported by Anthropic, so it matches{" "}
                <span className="mono">/usage</span> exactly.
              </div>
            ) : cardNotes.sessionResetSource === "pinned" ? (
              <div>
                Window start set by a{" "}
                <Link href="/settings">manual reset</Link>: usage before{" "}
                <span className="tabular-nums">
                  {new Date(s.session.startsAt).toLocaleString()}
                </span>{" "}
                is excluded here and from the budget guard.
              </div>
            ) : (
              <div>
                Reset time derived from your own turns, so it can sit minutes off
                what <span className="mono">/usage</span> reports.{" "}
                <Link href="/settings">Pin it</Link> if they disagree.
              </div>
            )}
          </div>

          <div className="mt-5 border-t border-line pt-4">
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
              <div>
                <CardTitle>{s.weekly.label}</CardTitle>
                <Stat>{fmtUSD(s.weekly.costUSD)}</Stat>
                <StatSub>
                  <span className="tabular-nums">
                    {fmtTokens(s.weekly.tokens)} tokens ·{" "}
                    {s.weekly.agg.entryCount.toLocaleString()} turns
                  </span>
                </StatSub>
              </div>
              {/* Where the session card puts its reset, so the eye finds both in
                  one place. Without an anchor this window has no reset instant at
                  all, and the sentence under the meter is what explains that —
                  the rail only says which of the two kinds of window it is. */}
              <div className="text-right">
                {weeklyResets ? (
                  // Days out, so the absolute date rather than `fmtRelative`,
                  // which would render this as "in 137h 12m".
                  <div
                    className="text-sm font-medium tabular-nums text-ink"
                    title={new Date(s.weekly.endsAt).toLocaleString()}
                  >
                    Resets {fmtDateTime(s.weekly.endsAt)}
                  </div>
                ) : (
                  <div className="text-sm font-medium text-ink">
                    Trailing total
                  </div>
                )}
              </div>
            </div>

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

            <div className="mt-3 max-w-[68ch] space-y-1 text-xs text-ink-muted">
              {s.weekly.tokenFraction !== null &&
                s.weekly.fractionMetric === "cost" && (
                  <div className="tabular-nums">
                    Against the raw-token ceiling: {fmtPct(s.weekly.tokenFraction)}
                  </div>
                )}
              {/* An operator waiting for this one to clear the way the 5-hour one
                  does is waiting for nothing, so say what it is instead. */}
              {!weeklyResets && (
                <div>
                  It never resets; old turns age out. Pick a{" "}
                  <Link href="/settings">weekly reset</Link> day for a fixed week.
                </div>
              )}
              {/* A wall that binds without ever reaching this meter: the weekly
                  allowance is split per model family on some plans, so Opus can
                  be full while the all-model window reads a quarter. The guard
                  stops on the worst of them, so name them rather than letting a
                  refusal arrive with nothing on screen behind it. */}
              {cardNotes.modelWallLine !== null && (
                <div className="tabular-nums">{cardNotes.modelWallLine}</div>
              )}
            </div>
          </div>

          {/* In the same card because it is the same subject — what may still
              be spent — for the other provider. Only once Codex has a stored
              sign-in: an install that never used Codex is not shown an empty
              section about it. */}
          {data.codex && <CodexWindows codex={data.codex} now={s.now} />}
        </Card>

        {/* Gated on the window itself, and it has to be: `telemetryWindow`
            answers `null` when agent self-reporting is off or nothing has
            reported, so an absent card is "no run has reported" rather than
            "$0.00" — and $0.00 at the top of the dashboard, beside the meters,
            is a reading an operator would act on. The gate is the setting and
            what came back on it, never the guard figure. */}
        {telemetry && (
          <LiveTelemetry telemetry={telemetry} now={s.now} />
        )}
      </div>

      {/* Under the meters, not above them: each of these explains something the
          reader has just looked at — a hatched bar, a span past the fill, a
          figure that is a floor. Stacked above, they were a wall of prose
          between the title and the subject of the page. */}
      <UsageNotices meta={meta} snapshot={s} page="dashboard" />

      {/* The rate this page's own price table produces. The two meters above
          are the same reading; this is how fast it is moving. What it breaks
          down into is on `/usage`, under the same heading. */}
      <SourceRegion
        heading="Your subscription"
        statement="This app’s price table over every Claude Code transcript on this machine."
      >
        {/* The half of what was "Rate and totals" that answers whether the
            windows above run out before they reset; cache reads and the
            lifetime total went to `/usage`. A grouped list rather than
            equally-weighted bordered boxes, because these are derived figures
            about the window the card above measures, not its peers. */}
        <Card className="mb-4">
          <CardTitle>Rate</CardTitle>
          <ListGroup>
            {/* The unit rides in the description rather than beside the figure,
                so the values stay one column of comparable numbers — a dollar
                figure, a duration. */}
            <ListRow label="Burn rate" description="Per hour, trailing 60 minutes">
              <ListValue>{fmtUSD(s.burnCostPerHour)}</ListValue>
            </ListRow>

            <ListRow
              label="Projected exhaustion"
              description={
                s.projectedExhaustionAt ? (
                  <span
                    className="tabular-nums"
                    title={new Date(s.projectedExhaustionAt).toLocaleString()}
                  >
                    At this burn rate, around{" "}
                    {fmtDateTime(s.projectedExhaustionAt)}
                  </span>
                ) : nothingToProjectAgainst ? (
                  "Needs a configured ceiling"
                ) : (
                  "Not projected to run out"
                )
              }
            >
              <ListValue>
                {s.projectedExhaustionAt
                  ? fmtDuration(Math.max(0, s.projectedExhaustionAt - s.now))
                  : "—"}
              </ListValue>
            </ListRow>
          </ListGroup>
        </Card>
      </SourceRegion>

      <SourceRegion
        heading="What this app spent"
        statement="Money runs this app started reported spending."
      >
        {/* The install limit stays here when every other reading of this
            source went to `/usage`: a limit that stops every agent when it
            trips is a thing to see on landing. What each repository's runs
            spent is on that page, in the band of the same name. */}
        <InstallSpendCard install={install} />
      </SourceRegion>
    </>
  );
}
