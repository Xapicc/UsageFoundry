import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveTelemetry } from "./LiveTelemetry";
import type { TelemetryWindowDTO } from "../lib/apiTypes";

/**
 * This card puts a first-party dollar figure in the top row of a page whose two
 * headline meters are transcript-derived, and the app's central rule is that
 * the three sources are never summed or mixed. Both failure modes here are
 * silent: a card that shows $2.43 beside a $166 meter with nothing on it naming
 * where the figure came from reads as an addend, and a run list capped at six
 * with nothing saying so reads as the complete set — the same failure
 * `selectForPatch` is tested against in `diff.ts`. Neither throws, logs, or
 * fails a typecheck.
 *
 * The footnote that used to carry the first claim in three sentences is gone at
 * the operator's request (2026-09-04), so what pins it here is the title: the
 * two words `— first-party` are now the whole of the card's provenance, and the
 * assertion below is the only thing standing between them and a later editor
 * shortening the heading to `Live from runs`. `ContextOccupancy.tsx`'s module
 * doc records the same trade, made the same way and one commit earlier.
 */

const NOW = 1_700_000_000_000;

function windowOf(over: Partial<TelemetryWindowDTO> = {}): TelemetryWindowDTO {
  return {
    requests: 5,
    costUSD: 2.43,
    tokens: 1_684_600,
    lastAt: NOW - 30_000,
    runCount: 2,
    workingRunCount: 1,
    runs: [
      {
        runId: "aaaa1111-2222-3333-4444-555555555555",
        status: "running",
        requests: 3,
        costUSD: 0.93,
        tokens: 757_100,
        lastAt: NOW - 30_000,
      },
      {
        runId: "bbbb1111-2222-3333-4444-555555555555",
        status: "completed",
        requests: 2,
        costUSD: 1.5,
        tokens: 927_500,
        lastAt: NOW - 1_800_000,
      },
    ],
    ...over,
  };
}

test("the figure never appears without the source it came from", () => {
  const html = renderToStaticMarkup(
    <LiveTelemetry telemetry={windowOf()} now={NOW} />,
  );
  assert.match(html, /\$2\.43/, "the first-party total is the card's subject");
  // A dollar amount in the top row with no provenance on it is read as one more
  // reading of the window the card next to it meters. Pinned as one string
  // rather than on the word alone: "first-party" has to be on the same line as
  // the figure it qualifies to be read as qualifying it.
  assert.match(html, /Live from runs — first-party/);
});

test("a capped list says how many runs it left out", () => {
  const html = renderToStaticMarkup(
    // Eight runs in the window, six of them listed: what `telemetryWindow`
    // returns once TOP_RUNS bites.
    <LiveTelemetry telemetry={windowOf({ runCount: 8 })} now={NOW} />,
  );
  assert.match(html, /6 cheaper runs are in the total above but not listed/);
});

test("a complete list claims nothing about omissions", () => {
  const html = renderToStaticMarkup(
    <LiveTelemetry telemetry={windowOf()} now={NOW} />,
  );
  assert.doesNotMatch(html, /not listed/);
});

test("a run with no matching row reads as unknown, not as a status", () => {
  const telemetry = windowOf();
  // A second run that is working, because with none the card is one line and
  // has no table to put a status in. The assertions are scoped to the
  // status-less run's own row for that reason: the working run's badge is real.
  const html = renderToStaticMarkup(
    <LiveTelemetry
      telemetry={{
        ...telemetry,
        runCount: 2,
        workingRunCount: 1,
        runs: [
          { ...telemetry.runs[0], status: null },
          { ...telemetry.runs[1], status: "running" },
        ],
      }}
      now={NOW}
    />,
  );
  const row = /aaaa1111[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
  assert.notEqual(row, "", "the status-less run has a row");
  // Anchored on the cell, not on the document: the card title carries an
  // em-dash of its own, so a bare /—/ is satisfied before the table body is
  // reached and a component that rendered an *empty* cell for a null status
  // would pass it. The null branch is a bare dash as the only child of its
  // `Td`, which is what `>—<` picks out.
  assert.match(row, />—</, "the unknown status is a dash in its own cell");
  // Against the badge markup rather than the bare word, so this does not start
  // depending on "running" being absent from unrelated copy on the card.
  assert.doesNotMatch(
    row,
    /<span[^>]*>running<\/span>/,
    "no status may be invented for it",
  );
});

test("a run with a status wears it, so the dash is not what every cell says", () => {
  // The control half of the test above, for the reason `haltedMembers.test.ts`
  // carries three: a status cell that rendered a dash whatever it was handed
  // satisfies the unknown case just as happily, and the two assertions only
  // mean something as a pair.
  const telemetry = windowOf();
  const html = renderToStaticMarkup(
    <LiveTelemetry
      telemetry={{
        ...telemetry,
        runCount: 1,
        runs: [telemetry.runs[0]],
      }}
      now={NOW}
    />,
  );
  assert.match(html, /<span[^>]*>running<\/span>/, "a known status is a badge");
  assert.doesNotMatch(html, />—</, "and it is not also an unknown");
});

test("nothing is described as working when no run is", () => {
  const html = renderToStaticMarkup(
    <LiveTelemetry telemetry={windowOf({ workingRunCount: 0 })} now={NOW} />,
  );
  assert.doesNotMatch(html, /working/);
  // Collapsed to one line, which still names where its figure came from.
  assert.match(html, /Live from runs — first-party/);
  assert.match(html, /\$2\.43/);
  assert.match(html, /idle/);
  assert.doesNotMatch(html, /<table/, "the run breakdown waits for a run that is working");
});
