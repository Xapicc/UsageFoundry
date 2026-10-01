import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveRunFigures } from "./LiveRunFigures";

/**
 * A live tile's two money figures.
 *
 * Both failures are silent and both read as measurements. Most runs export no
 * telemetry at all, so a tile that rendered "nothing arrived" as `$0.00` would
 * tell the operator, on nearly every tile, that the cycle in flight has cost
 * nothing — `metering.md`'s first rule, broken where it is read most. And a
 * total of the two figures is a number no instrument produced, which
 * `LiveTelemetry.tsx` already records as the hazard of putting a telemetry
 * reading beside another.
 */

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("a run with no telemetry says so and never shows it as $0", () => {
  const html = text(
    renderToStaticMarkup(
      <LiveRunFigures run={{ provider: "claude", spent_usd: 1.25, cycleTelemetry: null }} />,
    ),
  );
  assert.match(html, /none reported this cycle/);
  assert.match(html, /\$1\.25/);
  assert.doesNotMatch(html, /\$0\.00/);
});

test("both figures are shown apart and never added", () => {
  const html = text(
    renderToStaticMarkup(
      <LiveRunFigures
        run={{
          provider: "claude",
          spent_usd: 1.25,
          cycleTelemetry: { requests: 4, costUSD: 0.5, tokens: 120_000 },
        }}
      />,
    ),
  );
  assert.match(html, /\$1\.25/);
  assert.match(html, /\$0\.50/);
  assert.doesNotMatch(html, /\$1\.75/);
  // The telemetry figure is named as what it is.
  assert.match(html, /Telemetry — first-party/);
});

test("a provider that reports no cost gets no spent figure at all", () => {
  const html = text(
    renderToStaticMarkup(
      <LiveRunFigures run={{ provider: "local", spent_usd: 0, cycleTelemetry: null }} />,
    ),
  );
  assert.match(html, /provider reports no cost/);
  assert.doesNotMatch(html, /\$0\.00/);
});
