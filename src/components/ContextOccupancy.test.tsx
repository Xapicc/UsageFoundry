import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextOccupancy } from "./ContextOccupancy";
// The component's own formatter, so a case about a clock time cannot drift from
// what is rendered by asserting against a second spelling of the same instant.
import { fmtClock } from "../lib/format";
import type { ContextCheckDTO, ContextOccupancyDTO, ContextSampleDTO } from "../lib/apiTypes";

/**
 * Four failure modes, all silent, all of which render a picture that looks
 * entirely ordinary:
 *
 *  - A percentage computed against anything but the window the DTO reports — or
 *    against a window a Claude run never had. Nothing here knows a Claude
 *    model's window, and a meter at a guessed one reads as a limit.
 *  - A run with no readings drawn as a 0% fill. "Nothing measured" and "measured
 *    at nothing" are opposite statements and the same empty bar.
 *  - The caption rendering as an empty paragraph. Every clause in it is
 *    conditional, and a `<p>` with no children still takes its bottom margin
 *    under the chart.
 *  - The age drawn against the newest *point* rather than the newest *read*.
 *    Samples are deduplicated on the `usage` frame they came from, so a run
 *    inside one sub-agent gains none for as long as that lasts — 22 minutes,
 *    measured on this install — and the panel then reported a poll that had
 *    died over a figure that was current. Both halves are pinned: the age comes
 *    off `lastCheck`, and the hold is named rather than left to be inferred
 *    from an age that no longer moves.
 *
 * `LiveTelemetry.test.tsx` is the precedent for the last one: a component whose
 * copy is load-bearing gets that copy pinned.
 */

const NOW = 1_700_000_000_000;
/** A Codex-reported window, chosen so the arithmetic below is round. */
const WINDOW = 120_000;

function sample(over: Partial<ContextSampleDTO> = {}): ContextSampleDTO {
  return {
    ts: NOW - 60_000,
    iteration: 1,
    tokens: 40_000,
    basis: "api",
    turnIndex: 4,
    turnsExact: true,
    ...over,
  };
}

/** Three readings a thousand milliseconds apart, against a reported window. */
function series(over: Partial<ContextOccupancyDTO> = {}): ContextOccupancyDTO {
  const samples = [
    sample({ ts: NOW - 2_000, tokens: 30_000 }),
    sample({ ts: NOW - 1_000, tokens: 90_000, iteration: 2 }),
    sample({ ts: NOW, tokens: 60_000, iteration: 2 }),
  ];
  return {
    windowTokens: WINDOW,
    samples,
    sampleCount: samples.length,
    // Read on the same tick that wrote the newest point, which is the ordinary
    // steady state: the cases below are the ones where it is not.
    lastCheck: { ts: NOW, basis: "api" },
    ...over,
  };
}

/** A tick that looked, at a time of its own. */
function check(over: Partial<ContextCheckDTO> = {}): ContextCheckDTO {
  return { ts: NOW, basis: "api", ...over };
}

function render(context: ContextOccupancyDTO, live = true): string {
  return renderToStaticMarkup(
    <ContextOccupancy context={context} now={NOW} live={live} />,
  );
}

test("the percentage is against the window the DTO reports", () => {
  const html = render(series());
  assert.match(html, /50\.0%/);
  assert.match(html, /aria-valuenow="50"/);
  // And the window is named in the legend at the value it was given, so the
  // denominator is on screen rather than only in the arithmetic.
  assert.match(html, /window 120\.0k/);
});

test("a window that moves moves the reading with it", () => {
  // The control half of the test above: a component that divided by a literal
  // would pass the first one for any window that happened to be 120,000.
  const html = render(series({ windowTokens: 240_000 }));
  assert.match(html, /25\.0%/);
  assert.match(html, /window 240\.0k/);
  assert.doesNotMatch(html, /50\.0%/);
});

test("a run with no window gets no meter and no rule, and keeps its figure", () => {
  // A Claude run. A meter drawn against a guessed window would read as a limit
  // the run is approaching; a hatched one would read as a figure that is
  // missing, when the figure is right there.
  const html = render(series({ windowTokens: null }));
  assert.match(html, /60\.0k/);
  assert.doesNotMatch(html, /aria-valuenow/);
  assert.doesNotMatch(html, /hatched/);
  assert.doesNotMatch(html, /stroke-danger/, "no rule is drawn across the chart");
  assert.doesNotMatch(html, /window /);
  assert.doesNotMatch(html, /\(\d+%\)/, "the description claims no percentage");
});

test("a window of zero is refused rather than divided by", () => {
  // The DTO's type permits it and `x / 0` is `Infinity`.
  const html = render(series({ windowTokens: 0 }));
  assert.doesNotMatch(html, /aria-valuenow/);
  assert.doesNotMatch(html, /Infinity|NaN/);
  assert.match(html, /60\.0k/);
});

test("a run with no readings says so instead of drawing a zero", () => {
  const html = render(series({ samples: [], sampleCount: 0 }));
  // `Meter`'s vocabulary for "no figure": hatched, and no value claimed.
  assert.match(html, /not measured yet/);
  assert.match(html, /hatched/);
  assert.doesNotMatch(html, /aria-valuenow/, "no percentage may be asserted");
  assert.doesNotMatch(html, /0\.0%/, "an unmeasured run is not a run at zero");
  assert.doesNotMatch(html, /bg-ok|bg-warn|bg-danger/);
});

test("a single reading is a reading, and says it has no shape yet", () => {
  const one = sample({ ts: NOW, tokens: 60_000 });
  const html = render(series({ samples: [one], sampleCount: 1 }));
  assert.match(html, /50\.0%/);
  assert.match(html, /aria-valuenow="50"/);
  assert.doesNotMatch(html, /hatched/);
  // But nothing about a trend may be implied.
  assert.match(html, /one reading so far/, "said in the text alternative");
  assert.match(html, /No shape yet/);
});

test("a finished run's last point is a final reading, not a stale poll", () => {
  const live = render(series(), true);
  assert.match(live, /read /, "a live run says how old its reading is");
  assert.doesNotMatch(live, /final reading/);

  const done = render(series(), false);
  assert.match(done, /final reading/);
});

/**
 * A run that has spent 22 minutes inside one sub-agent, which is the case
 * measured on this install: the tick read the transcript 22 times, found the
 * same `usage` frame every time and wrote no row, and the figure it found was
 * correct throughout — a sub-agent's turns are not this conversation's context.
 */
function heldSeries(over: Partial<ContextOccupancyDTO> = {}): ContextOccupancyDTO {
  // The read is 20 seconds old and the newest point is 22 minutes older than
  // the read, so the two ages are separable in the output rather than differing
  // by a rounding.
  const read = NOW - 20_000;
  const held = [
    sample({ ts: read - 24 * 60_000, tokens: 30_000 }),
    sample({ ts: read - 22 * 60_000, tokens: 60_000 }),
  ];
  return series({
    samples: held,
    sampleCount: held.length,
    lastCheck: check({ ts: read }),
    ...over,
  });
}

test("the age is the tick's, not the newest point's", () => {
  const html = render(heldSeries());
  // 20 seconds since the read, so the age rounds to nothing. The bug this
  // replaces put "22m ago" here — a dead poll over a live figure.
  assert.match(html, /read just now/);
  assert.doesNotMatch(html, /read 22m ago/, "the point's own age is not the read's");
  assert.doesNotMatch(html, /read 22m/, "nor anywhere near it");
  // And the gap is named rather than left to be inferred from an age that has
  // stopped moving, which is the half that makes the first one readable.
  assert.match(html, /unchanged for 22m 0s/);
  assert.match(
    html,
    /main thread<\/em> finishes another request/,
    "and the caption says why a live run's figure can sit still",
  );
});

test("a gap inside one read interval is not worth naming", () => {
  // Two minutes is the ceiling on the read itself, so anything under it is one
  // tick that found the same frame — the ordinary case on any tool call, and a
  // "unchanged for" on every second run is noise that trains an operator to
  // stop reading the line.
  const html = render(
    heldSeries({
      samples: [sample({ ts: NOW - 2 * 60_000 - 20_000, tokens: 60_000 })],
      sampleCount: 1,
      lastCheck: check({ ts: NOW - 20_000 }),
    }),
  );
  assert.doesNotMatch(html, /unchanged for/);
});

test("with no read reported the age falls back to the point's own", () => {
  // A server restarted mid-run has read nothing yet. Borrowing the previous
  // process's reading would be exactly the freshness `lastCheck` exists to stop
  // this panel inventing, so it says what it did before the field existed.
  const html = render(heldSeries({ lastCheck: null }));
  assert.match(html, /read 22m ago/);
  assert.doesNotMatch(html, /unchanged for/, "there is no read to hold against");
});

test("a read that found nothing is not a fresh reading", () => {
  // `unreadable` is a different statement from a figure that has not moved, and
  // "read just now" over a number nothing could confirm is the one wording that
  // would leave this panel worse than absent.
  const html = render(
    heldSeries({ lastCheck: check({ ts: NOW - 20_000, basis: "unreadable" }) }),
  );
  assert.match(html, /last read just now found nothing to read/);
  assert.doesNotMatch(html, /read just now ·/);
});

test("a finished run is not given an age at all", () => {
  // Its tick stopped when it did, so an age would count up for ever against a
  // number nothing is going to change.
  const html = render(heldSeries(), false);
  assert.match(html, /final reading/);
  assert.doesNotMatch(html, /unchanged for/);
  assert.doesNotMatch(html, /read /);
});

test("a caption with nothing to say renders nothing at all", () => {
  // Every clause under the chart is conditional, so the ordinary steady state —
  // a complete, current, all-api series — owes the reader no paragraph, and an
  // empty <p> would still take its own bottom margin under the chart.
  const html = render(series());
  assert.doesNotMatch(html, /max-w-\[68ch\]/, "no caption element is emitted");
  assert.match(html, /50\.0%/);
  assert.match(html, /role="img"/);
});

test("the first clause that renders opens the paragraph", () => {
  // Whichever clause comes first must not start with a space, and any two that
  // render together must still be separated by one.
  const held = render(heldSeries());
  assert.match(held, /leading-snug text-ink-muted">The figure is current/);

  const context = series({ sampleCount: 900 });
  const two = render({
    ...context,
    samples: [
      context.samples[0],
      context.samples[1],
      { ...context.samples[2], basis: "transcript" },
    ],
  });
  assert.match(two, /text-ink-muted">This last reading is a byte estimate/);
  assert.match(two, /rather than a rougher one\. Drawn from the newest 3 of 900/);
});

test("a fallback reading is not presented as the same measurement", () => {
  const context = series();
  const html = render({
    ...context,
    samples: [
      { ...context.samples[0], basis: "transcript" },
      context.samples[1],
      context.samples[2],
    ],
  });
  // Drawn as a hollow square rather than a dot on the same line.
  assert.match(html, /fill-surface stroke-accent/);
  assert.match(html, /1 byte estimate/, "and named in the legend");
  assert.match(html, /a different measure rather than a[\s\S]*rougher one/);
});

test("a fallback as the newest reading qualifies the headline figure itself", () => {
  const context = series();
  const html = render({
    ...context,
    samples: [
      context.samples[0],
      context.samples[1],
      { ...context.samples[2], basis: "transcript" },
    ],
  });
  assert.match(html, /This last reading is a byte estimate from the transcript/);
});

test("an all-api series claims nothing about a fallback", () => {
  // The control for the two above: a component that printed the qualification
  // unconditionally would satisfy both and mean nothing.
  const html = render(series());
  assert.doesNotMatch(html, /byte estimate/);
  assert.doesNotMatch(html, /fill-surface stroke-accent/);
});

test("a series holding the end of a longer one says which end", () => {
  const html = render(series({ sampleCount: 900 }));
  assert.match(html, /Drawn from the newest 3 of 900 readings/);
  assert.match(html, /the end of the series, not a thinning of it/);
});

test("a complete series claims no tail", () => {
  const html = render(series());
  assert.doesNotMatch(html, /Drawn from the newest/);
});

test("the dots stand down on a long run", () => {
  const many = Array.from({ length: 80 }, (_, i) =>
    sample({ ts: NOW - (79 - i) * 1_000, tokens: 30_000 + i * 100 }),
  );
  const html = render(series({ samples: many, sampleCount: 80 }));
  // One dot: the newest reading, which is the point the indicator above names.
  assert.equal(html.match(/<circle/g)?.length, 1);

  // And a short run draws them all, so the cap is not always in force.
  const short = render(series());
  assert.equal(short.match(/<circle/g)?.length, 3);
});

test("the series is not sighted-only", () => {
  const html = render(series());
  assert.match(html, /role="img"/);
  // The shape and its notable points, which is what a sparkline's alternative is.
  assert.match(html, /aria-label="Context occupancy: 3 readings/);
  assert.match(html, /starts at 30\.0k \(25%\)/);
  assert.match(html, /peaks at 90\.0k \(75%\)/);
  assert.match(html, /is now 60\.0k \(50%\)/);
});
