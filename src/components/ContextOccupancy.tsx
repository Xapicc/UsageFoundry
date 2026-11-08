"use client";

// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a tested component has to import the
// way src/lib, Meter.tsx and LiveTelemetry.tsx already do.
import { Fragment, type ReactNode } from "react";
import type { ContextOccupancyDTO, ContextSampleDTO } from "../lib/apiTypes";
import { fmtClock, fmtDuration, fmtRelative, fmtTokens } from "../lib/format";
import { Meter } from "./Meter";
import { Stat } from "./ui/Card";

/**
 * How far the figure may fall behind the read before the gap is worth naming.
 *
 * Above the two-minute ceiling on the read itself, deliberately: a gap smaller
 * than that is one tick that found the same frame, which is the ordinary case
 * on any tool call and says nothing an operator needs. What this catches is the
 * case that used to render as a dead poll — a run inside one long tool call or
 * one sub-agent, whose main thread has not been billed for a request in
 * minutes, and whose figure is nonetheless the current one.
 */
const HOLD_NOTICE_MS = 3 * 60_000;

/**
 * How full one run's context is now, and how it got there.
 *
 * ## What it is measured in
 *
 * `apiContextTokens` — the whole prompt as the API was billed for the last
 * finished request. It is neither money nor the transcript's own turns, and the
 * prompt carries a system prompt and tool list no transcript holds.
 *
 * ## Why only a Codex run has a line to be measured against
 *
 * `windowTokens` is the window a Codex run's CLI reported. Nothing in this app
 * knows a Claude model's window, so a Claude run is drawn without one and gets
 * no meter: a line drawn at a guess would be read as a limit.
 *
 * ## Why the age shown is not the newest point's
 *
 * `lastCheck` is when the tick last *read* this run; the newest sample is when
 * the number last *moved*. They come apart by design — the series is
 * deduplicated on the `usage` frame it came from, and a run whose main thread is
 * inside one sub-agent gains no frame at all for as long as that lasts, measured
 * at 22 minutes on this install. Drawing the sample's own timestamp as "read 22m
 * ago" said the poll had died when what had actually happened was that the
 * figure was still correct, which is the one thing this panel must not get
 * backwards. So the age is the read's, and the hold is said separately.
 *
 * ## What the picture claims
 *
 * Every returned sample is drawn; nothing is thinned. The series is already
 * capped server-side at `CONTEXT_SERIES_MAX_POINTS` as a **tail** rather than a
 * thinned set, and when it is holding one the caption says so — a graph that
 * quietly drops points claims a smoothness its data does not have. Dots are the
 * one thing that stands down on a long run, and they carry no information the
 * line does not, except for the fallback-basis markers, which are drawn at every
 * length because a reading in a different measure is not decoration.
 */
export function ContextOccupancy({
  context,
  now,
  live,
  compact = false,
}: {
  context: ContextOccupancyDTO;
  now: number;
  /**
   * Whether the run can still move. Only the wording depends on it: the last
   * point of a finished run is a final reading, and "read 3h ago" on a series
   * that will never gain another point reads as a stalled poll.
   */
  live: boolean;
  /**
   * The figure, its age and the meter, and nothing that needs the series — for
   * `/runs/live`'s tiles, which are sent the newest sample alone
   * (`contextForTile`). The same code draws both, so a tile and the run page
   * cannot disagree about one run's reading.
   */
  compact?: boolean;
}) {
  const { windowTokens, samples } = context;
  // A window of zero is not a window. Guarded rather than divided by, because
  // `x / 0` is `Infinity`, `Meter` treats a non-finite fraction as unknown, and
  // the two would agree by accident rather than because anything checked.
  const window =
    windowTokens !== null && Number.isFinite(windowTokens) && windowTokens > 0
      ? windowTokens
      : null;
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;
  const fraction = latest !== null && window !== null ? latest.tokens / window : null;

  // Only while the run can move. A finished run's last reading is final and the
  // tick that took it stopped when the run did, so an age against it would count
  // up for ever on a number nothing is going to change.
  const check = live ? context.lastCheck : null;
  // Falls back to the sample's own timestamp, which is what this line said
  // before `lastCheck` existed: a server restarted mid-run has read nothing yet,
  // and borrowing the previous process's reading would be exactly the freshness
  // this exists to stop inventing.
  const readAt = check?.ts ?? latest?.ts ?? now;
  const held = latest === null || check === null ? 0 : check.ts - latest.ts;

  return (
    <>
      {latest === null ? (
        // Deliberately not a zero fill. `Meter`'s hatch is this app's vocabulary
        // for "no figure", and an empty bar here would read as "this run is
        // using none of its context" for a run nothing has measured yet.
        //
        // The meter says it and nothing above it repeats it: a headline over a
        // hint that carries the same words is one fact wearing two voices, and
        // the reader then looks for the difference between them.
        <Meter
          size="compact"
          label={window === null ? "Context" : "Of the context window"}
          fraction={null}
          unknownHint="not measured yet"
        />
      ) : (
        <>
          {/* The figure and the fill. The token count leads because it is what
              the operator carries to a transcript; the percentage rides the
              meter's own head, where it is already tabular and already sized. */}
          <Stat>{fmtTokens(latest.tokens)}</Stat>
          <div className="mt-0.5 text-xs tabular-nums text-ink-muted">
            {!live ? (
              <>final reading</>
            ) : check?.basis === "unreadable" ? (
              // Said in place of the age rather than beside it. A read that
              // failed is not a fresh reading, and "read just now" over a figure
              // nothing could confirm is the one wording that would make this
              // panel worse than having none.
              <>last read {fmtRelative(readAt, now)} found nothing to read</>
            ) : (
              <>read {fmtRelative(readAt, now)}</>
            )}
            {held >= HOLD_NOTICE_MS && (
              <> · unchanged for {fmtDuration(held)}</>
            )}{" "}
            · work cycle {latest.iteration}
          </div>
          {window !== null && (
            <Meter size="compact" label="Of the context window" fraction={fraction} />
          )}

          {!compact && (
            <>
              <Sparkline samples={samples} windowTokens={window} />
              <Caption context={context} latest={latest} held={held} />
            </>
          )}
        </>
      )}

    </>
  );
}

/* ------------------------------------------------------------------ */
/* The sparkline                                                       */
/* ------------------------------------------------------------------ */

/**
 * A fixed user-space box, scaled by the browser rather than by arithmetic here.
 *
 * `preserveAspectRatio` is left at its default on purpose: `none` would stretch
 * the box to the column and take the stroke widths, the dot radii and the
 * marker triangles with it, so the same picture would be drawn differently in
 * the inspector and on a phone. At 320 wide it is already narrower than the
 * 21rem inspector column, so the scale is a shrink of at most a few percent.
 */
const VIEW_W = 320;
const VIEW_H = 56;
const PAD_X = 3;
/** Room above the window rule so it is a line on the chart, not its edge. */
const PAD_TOP = 5;
const PAD_BOTTOM = 3;
const PLOT_W = VIEW_W - PAD_X * 2;
const PLOT_H = VIEW_H - PAD_TOP - PAD_BOTTOM;

/**
 * Above this many points the per-sample dots stand down and the line is drawn
 * alone.
 *
 * They are an affordance rather than data — the polyline already passes through
 * every point — so dropping them claims nothing about the series. The
 * fallback-basis markers are exempt and drawn at every length, because those
 * *are* data: they say a point is in a different measure from its neighbours.
 */
const DOT_LIMIT = 60;

function Sparkline({
  samples,
  windowTokens,
}: {
  samples: ContextSampleDTO[];
  /** The rule drawn across the chart, or null for none. */
  windowTokens: number | null;
}) {
  const t0 = samples[0].ts;
  const span = samples[samples.length - 1].ts - t0;
  const peak = samples.reduce((m, s) => Math.max(m, s.tokens), 0);
  // The window, where there is one, is always on the chart so the distance to
  // it is readable without arithmetic.
  const yMax = Math.max(windowTokens ?? 0, peak, 1);

  const x = (ts: number) =>
    round(span <= 0 ? PAD_X + PLOT_W / 2 : PAD_X + ((ts - t0) / span) * PLOT_W);
  const y = (tokens: number) =>
    round(
      PAD_TOP + (1 - Math.min(Math.max(tokens, 0), yMax) / yMax) * PLOT_H,
    );

  const windowY = windowTokens === null ? null : y(windowTokens);
  const points = samples.map((s) => ({ s, cx: x(s.ts), cy: y(s.tokens) }));
  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.cx} ${p.cy}`)
    .join(" ");

  const fallbacks = samples.filter((s) => s.basis === "transcript").length;

  return (
    <>
      <svg
        // `h-auto` with a viewBox: the intrinsic ratio drives the height, so the
        // box never letterboxes and never has to be kept in step with VIEW_H.
        className="mt-2.5 block h-auto w-full"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={describeSeries(samples, windowTokens, peak)}
      >
        {/* No floor is drawn: a rule at zero tokens carries nothing, and the
            only tone available for it is `--border`, which reads as the
            inspector's own section divider. */}

        {/* The window. Dashed rather than tinted, because the legend under the
            chart names it in words and a reader who cannot separate the two
            colours still has a solid line and a broken one. */}
        {windowY !== null && (
          <path
            d={`M${PAD_X} ${windowY}H${VIEW_W - PAD_X}`}
            className="stroke-danger"
            strokeWidth="1.25"
            strokeDasharray="4 3"
            fill="none"
          />
        )}

        {samples.length > 1 && (
          <path
            d={line}
            className="stroke-accent"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        )}

        {points.map((p, i) => {
          const last = i === points.length - 1;
          // A hollow square, never a smaller circle: this point was measured
          // off the transcript's bytes rather than a usage frame, and a reader
          // has to be able to tell that apart from its neighbours in greyscale.
          if (p.s.basis === "transcript") {
            const r = last ? 2.6 : 2;
            return (
              <rect
                key={`f-${i}`}
                x={round(p.cx - r)}
                y={round(p.cy - r)}
                width={r * 2}
                height={r * 2}
                className="fill-surface stroke-accent"
                strokeWidth="1.2"
              />
            );
          }
          if (!last && samples.length > DOT_LIMIT) return null;
          return (
            <circle
              key={`d-${i}`}
              cx={p.cx}
              cy={p.cy}
              r={last ? 2.6 : 1.6}
              className="fill-accent"
            />
          );
        })}
      </svg>

      {/* The legend, so the chart's marks are not colour alone: each one is
          named here beside the mark that draws it. */}
      {(windowTokens !== null || fallbacks > 0) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
          {windowTokens !== null && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <svg viewBox="0 0 14 4" className="h-1 w-3.5" aria-hidden="true">
                <path
                  d="M0 2h14"
                  className="stroke-danger"
                  strokeWidth="2"
                  strokeDasharray="4 3"
                  fill="none"
                />
              </svg>
              <span className="tabular-nums">window {fmtTokens(windowTokens)}</span>
            </span>
          )}
          {fallbacks > 0 && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <svg viewBox="0 0 8 8" className="h-2 w-2" aria-hidden="true">
                <rect
                  x="1.6"
                  y="1.6"
                  width="4.8"
                  height="4.8"
                  className="fill-surface stroke-accent"
                  strokeWidth="1.4"
                />
              </svg>
              <span className="tabular-nums">{fallbacks} byte estimate</span>
            </span>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Two decimals, because this markup is re-rendered every three seconds.
 *
 * Full float precision puts fifteen digits into every coordinate of a
 * five-hundred-point path for a picture drawn at three hundred pixels.
 */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The series in words, for the reader who gets no picture at all.
 *
 * A sparkline's text alternative is its shape and its notable points, not a
 * transcription of five hundred coordinates.
 */
function describeSeries(
  samples: ContextSampleDTO[],
  windowTokens: number | null,
  peak: number,
): string {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const pct = (n: number) =>
    windowTokens !== null ? ` (${Math.round((n / windowTokens) * 100)}%)` : "";
  const against =
    windowTokens === null ? "" : `, against a window of ${fmtTokens(windowTokens)} tokens`;

  if (samples.length === 1) {
    return (
      `Context occupancy: one reading so far, ${fmtTokens(first.tokens)} tokens` +
      `${pct(first.tokens)}${against}, taken at ${fmtClock(first.ts)}. No shape yet.`
    );
  }

  return (
    `Context occupancy: ${samples.length} readings from ${fmtClock(first.ts)} ` +
    `to ${fmtClock(last.ts)}${against}. It starts at ` +
    `${fmtTokens(first.tokens)}${pct(first.tokens)}, peaks at ${fmtTokens(peak)}` +
    `${pct(peak)} and is now ${fmtTokens(last.tokens)}${pct(last.tokens)}.`
  );
}

/**
 * What this drawing is doing that the picture alone does not say.
 *
 * Every clause is conditional, so the ordinary case — an api-basis series that
 * is complete and current — renders **nothing**, and this returns `null`
 * rather than an empty `<p>`, whose bottom margin would otherwise sit under the
 * chart with no text in it. The standing prose that used to open it, naming the
 * two token currencies and the one-turn lag, was removed at the operator's ask:
 * it was read as wall-of-text, being the longest paragraph in that region. What
 * it stated is unchanged as a fact about the data and is on record on the module
 * doc above.
 *
 * The clauses are assembled as a list rather than written as siblings inside the
 * `<p>` because each used to carry its own leading separator, prose having run
 * before it. Whichever one renders first now opens the paragraph, and there is
 * no combination in which that one may start with a space.
 */
function Caption({
  context,
  latest,
  held,
}: {
  context: ContextOccupancyDTO;
  latest: ContextSampleDTO;
  /** How far the newest reading trails the newest read; 0 where it does not. */
  held: number;
}) {
  const { samples, sampleCount } = context;
  const fallbacks = samples.filter((s) => s.basis === "transcript").length;

  const clauses: { key: string; node: ReactNode }[] = [];

  if (held >= HOLD_NOTICE_MS) {
    clauses.push({
      key: "held",
      node: (
        <>
          The figure is current. It moves only when the <em>main thread</em>{" "}
          finishes another request, and a long tool call or a sub-agent adds
          nothing until it returns.
        </>
      ),
    });
  }

  if (latest.basis === "transcript") {
    clauses.push({
      key: "latest-fallback",
      node: (
        <>
          This last reading is a byte estimate from the transcript, a different
          measure rather than a rougher one.
        </>
      ),
    });
  }

  if (fallbacks > 0 && latest.basis !== "transcript") {
    clauses.push({
      key: "earlier-fallbacks",
      node: (
        <>
          {fallbacks} earlier{" "}
          {fallbacks === 1 ? "reading is a byte estimate" : "readings are byte estimates"}{" "}
          from the transcript, a different measure rather than a rougher one.
        </>
      ),
    });
  }

  if (sampleCount > samples.length) {
    clauses.push({
      key: "tail",
      node: (
        <>
          Drawn from the newest {samples.length} of {sampleCount} readings: the
          end of the series, not a thinning of it.
        </>
      ),
    });
  }

  if (clauses.length === 0) return null;

  return (
    <p className="mt-2 max-w-[68ch] text-xs leading-snug text-ink-muted">
      {clauses.map((clause, i) => (
        <Fragment key={clause.key}>
          {i > 0 && " "}
          {clause.node}
        </Fragment>
      ))}
    </p>
  );
}
