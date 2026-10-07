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
      <LiveRunFigures run={{ provider: "claude", spent_usd: 1.25, spent_tokens: 0, cycleTelemetry: null, cycleCodex: null }} />,
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
          spent_tokens: 0,
          cycleTelemetry: { requests: 4, costUSD: 0.5, tokens: 120_000 },
          cycleCodex: null,
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
      <LiveRunFigures run={{ provider: "local", spent_usd: 0, spent_tokens: 0, cycleTelemetry: null, cycleCodex: null }} />,
    ),
  );
  assert.match(html, /provider reports no cost/);
  assert.doesNotMatch(html, /\$0\.00/);
});

// A Codex tile shows tokens where a Claude tile shows money, and neither of its
// figures may read as a dollar amount or as a measured zero: Codex reports no
// cost, and a cycle nothing has been read for is a dash.
test("a Codex run shows its tokens, finished and in flight, and no money", () => {
  const html = text(
    renderToStaticMarkup(
      <LiveRunFigures
        run={{
          provider: "codex",
          spent_usd: 0,
          spent_tokens: 130_963,
          cycleTelemetry: null,
          cycleCodex: { requests: 3, tokens: 45_285 },
        }}
      />,
    ),
  );
  assert.match(html, /Tokens used/);
  assert.match(html, /This cycle — Codex/);
  assert.match(html, /3 requests so far/);
  assert.doesNotMatch(html, /\$/);
});

test("a Codex cycle nothing has been read for is a dash, not zero tokens", () => {
  const html = text(
    renderToStaticMarkup(
      <LiveRunFigures
        run={{ provider: "codex", spent_usd: 0, spent_tokens: 0, cycleTelemetry: null, cycleCodex: null }}
      />,
    ),
  );
  assert.match(html, /none read this cycle/);
  assert.doesNotMatch(html, /\$0\.00/);
});
