import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Meter, type MeterSize } from "./Meter";

const SIZES: MeterSize[] = ["compact", "default", "hero"];

/**
 * The one invariant in this app that is expressed purely in styling: an
 * unconfigured ceiling must render as a hatched indeterminate bar, never as a
 * bar that looks like a reading.
 *
 * It earns a test on the same grounds as the others in this repo — the failure
 * is silent and expensive. `severityFor(null)` returns "ok" and an unknown
 * fill is clamped to full width, so the two ways of getting this wrong are an
 * empty bar reading "0% used, plenty left" and a solid green bar reading
 * "100% and fine". Both are the opposite of "we don't know", and neither
 * throws, logs, or fails a typecheck.
 */

test("no ceiling renders hatched, never as a severity colour", () => {
  const html = renderToStaticMarkup(<Meter label="Session" fraction={null} />);
  assert.match(html, /hatched/, "unknown fill must be hatched");
  assert.doesNotMatch(html, /bg-ok/, "unknown must not read as a healthy bar");
  assert.doesNotMatch(html, /bg-warn|bg-danger/);
  // No number may be claimed for a window with no ceiling.
  assert.match(html, /no ceiling set/);
  assert.doesNotMatch(html, /aria-valuenow/);
});

test("a known fraction renders its severity colour and no hatch", () => {
  const html = renderToStaticMarkup(<Meter label="Session" fraction={0.95} />);
  assert.match(html, /bg-danger/);
  assert.doesNotMatch(html, /hatched/);
  assert.match(html, /aria-valuenow="95"/);
});

test("severity thresholds map to the three fills", () => {
  const at = (f: number) => renderToStaticMarkup(<Meter label="w" fraction={f} />);
  assert.match(at(0.5), /bg-ok/);
  assert.match(at(0.7), /bg-warn/);
  assert.match(at(0.9), /bg-danger/);
});

test("an upper band is hatched and sits behind the solid fill", () => {
  const html = renderToStaticMarkup(
    <Meter label="Session" fraction={0.4} upperFraction={0.8} />,
  );
  // Both readings are shown, so a run refused above the visible bar is explicable.
  assert.match(html, /40\.0%/);
  assert.match(html, /80\.0%/);
  assert.match(html, /hatched/);
  assert.match(html, /bg-ok/);
  assert.ok(
    html.indexOf("hatched") < html.indexOf("bg-ok"),
    "hatched band must be emitted first so the solid fill paints over it",
  );
});

test("an upper reading equal to or below the known one draws no band", () => {
  // The normal, fully-priced case: a zero-width hatch would be visual noise.
  const equal = renderToStaticMarkup(
    <Meter label="w" fraction={0.4} upperFraction={0.4} />,
  );
  assert.doesNotMatch(equal, /hatched/);
});

/**
 * The size variants are the only thing standing between the invariant above and
 * a third lookup map, so each one is checked rather than only the default. A
 * size that forgot the `known` short-circuit — or that reached the fill class
 * through an interpolated string, which Tailwind emits as nothing — would leave
 * exactly one meter on the page painting an unknown window as a healthy one.
 */
test("the unknown state survives every size", () => {
  for (const size of SIZES) {
    const html = renderToStaticMarkup(
      <Meter label="Session" fraction={null} size={size} />,
    );
    assert.match(html, /hatched/, `${size}: unknown fill must be hatched`);
    assert.doesNotMatch(html, /bg-ok|bg-warn|bg-danger/, `${size}: no severity`);
    assert.match(html, /no ceiling set/, `${size}: must say it is unknown`);
    assert.doesNotMatch(html, /aria-valuenow/, `${size}: claims no value`);
  }
});

test("every size still colours a known reading by severity", () => {
  for (const size of SIZES) {
    const html = renderToStaticMarkup(
      <Meter label="Session" fraction={0.95} size={size} />,
    );
    assert.match(html, /bg-danger/, `${size}: severity fill`);
    assert.doesNotMatch(html, /hatched/, `${size}: no hatch on a known bar`);
  }
});

test("size selects a track height rather than interpolating one", () => {
  const at = (size: MeterSize) =>
    renderToStaticMarkup(<Meter label="w" fraction={0.5} size={size} />);
  assert.match(at("compact"), /h-1\.5/);
  assert.match(at("default"), /h-2/);
  assert.match(at("hero"), /h-3/);
});

test("an unknown reading is announced as unknown, not as a bare bar", () => {
  const html = renderToStaticMarkup(<Meter label="Session" fraction={null} />);
  assert.match(html, /aria-valuetext="no ceiling set"/);
});

/**
 * What a screen reader is told the hatched band *means*, per meter that draws
 * one.
 *
 * A sighted reader has the card's own prose, the second percentage and the
 * hatch; a screen reader has this one sentence and nothing else. The component
 * used to compose it from a single guess — that the band is what unpriced
 * models would cost once charged — and that is true of the four window-shaped
 * meters and false of the three money-shaped ones, where the band is spend this
 * app reconciled or estimated for work Claude Code never reported. Fluent,
 * specific and wrong is the worst available failure here, and nothing about it
 * throws, renders differently or fails a typecheck.
 *
 * So the rows below are the call sites, and what each one announces is the
 * assertion. They are named by file and label rather than by line because the
 * point of the row is that a reviewer can go and read the call site.
 */
const ANNOUNCEMENTS: Array<{
  site: string;
  hint: string;
  says: string;
  /** Set at the sites that override the head's readings, spelled as they are. */
  value?: string;
  upperValue?: string;
}> = [
  {
    site: "src/app/page.tsx — Session consumed",
    hint: "once unpriced models are charged",
    says: "40.0%, up to 80.0% once unpriced models are charged",
  },
  {
    site: "src/app/page.tsx — Weekly consumed",
    hint: "once unpriced models are charged",
    says: "40.0%, up to 80.0% once unpriced models are charged",
  },
  {
    site: "src/components/UsagePeriods.tsx — {period} consumed",
    hint: "once unpriced models are charged",
    says: "40.0%, up to 80.0% once unpriced models are charged",
  },
  {
    site: "src/components/RunAgentCost.tsx — Outside the main thread",
    hint: "once unpriced models are charged",
    says: "40.0%, up to 80.0% once unpriced models are charged",
  },
  {
    site: "src/app/page.tsx — Spent by everything this app runs",
    hint: "including work still running and work that stopped before reporting its cost",
    says:
      "40.0%, up to 80.0% including work still running and work that stopped" +
      " before reporting its cost",
  },
  {
    site: "src/app/workflows/[id]/instances/[instanceId]/page.tsx — Spent across blocks",
    hint: "including work still running and work that stopped before reporting its cost",
    value: "$12.40",
    upperValue: "$18.90",
    says:
      "$12.40, up to $18.90 including work still running and work that stopped" +
      " before reporting its cost",
  },
  {
    site: "src/app/runs/[id]/page.tsx — Spend",
    hint: "including work cycles that stopped before reporting their cost",
    value: "$3.20",
    upperValue: "$4.50 / $10.00",
    says:
      "$3.20, up to $4.50 / $10.00 including work cycles that stopped before" +
      " reporting their cost",
  },
];

/** The whole attribute, so a partial match cannot pass a truncated sentence. */
function announced(html: string): string | null {
  return /aria-valuetext="([^"]*)"/.exec(html)?.[1] ?? null;
}

test("each meter announces the band its own caller can explain", () => {
  for (const { site, hint, says, value, upperValue } of ANNOUNCEMENTS) {
    const html = renderToStaticMarkup(
      <Meter
        label="w"
        fraction={0.4}
        upperFraction={0.8}
        upperHint={hint}
        value={value}
        upperValue={upperValue}
      />,
    );
    assert.equal(announced(html), says, site);
  }
});

test("a band no caller explained claims no mechanism", () => {
  // The default has to be true of every meter in the app, which means it can
  // name the measured-versus-estimated split and nothing narrower. A default
  // that named a mechanism would go on being spoken at the meters it is false
  // at, which is the defect this replaced.
  const html = renderToStaticMarkup(
    <Meter label="w" fraction={0.4} upperFraction={0.8} />,
  );
  assert.equal(
    announced(html),
    "40.0%, up to 80.0% counting what this app estimated as well as what it measured",
  );
  assert.doesNotMatch(
    html,
    /unpriced/,
    "an unexplained band must not be attributed to unpriced models",
  );
});

test("a band nobody draws is announced as nothing at all", () => {
  // `aria-valuenow` alone is the reading when there is no band, and a hint that
  // leaked into that case would describe a span that is not on the track.
  const html = renderToStaticMarkup(
    <Meter label="w" fraction={0.4} upperFraction={0.4} upperHint="ignored" />,
  );
  assert.equal(announced(html), null);
  assert.match(html, /aria-valuenow="40"/);
});

test("a supplied value is suppressed when the fraction is unknown", () => {
  // `value` exists for readings where the raw pair says more than the ratio
  // ("2/5"). With no ceiling there is no pair, and any number in that slot
  // reads as a measurement of a window nothing has measured.
  const html = renderToStaticMarkup(
    <Meter label="w" fraction={null} value="2/5" />,
  );
  assert.doesNotMatch(html, /2\/5/);
  assert.match(html, /no ceiling set/);
});

/**
 * The head's dash joins two ends of one range, so both ends have to be the same
 * kind of quantity.
 *
 * A caller that overrides `value` is naming something that is not a percentage,
 * and the band's reading used to be formatted as one regardless — so the two
 * money-shaped meters that also draw a band read `$12.40 – 18.9%`, a dollar
 * amount and a percentage presented as one span. It is the failure this repo
 * tests for: nothing throws, nothing fails a typecheck, and the number on the
 * right is a plausible figure for the number on the left to run to.
 */
test("a value-headed meter spells its band in the same quantity", () => {
  const html = renderToStaticMarkup(
    <Meter
      label="Spent across blocks"
      fraction={0.248}
      upperFraction={0.378}
      value="$12.40"
      upperValue="$18.90"
    />,
  );
  assert.match(html, /\$12\.40/);
  assert.match(html, /\$18\.90/);
  // Anchored on the dash rather than on "37.8%", because the band's *width*
  // is a percentage too and always will be.
  assert.doesNotMatch(
    html,
    /–\s*[\d.]+%/,
    "no percentage may sit across the dash from a value the caller spelled",
  );
  assert.equal(
    announced(html),
    "$12.40, up to $18.90 counting what this app estimated as well as what it measured",
    "the spoken sentence quotes the head rather than re-deriving percentages",
  );
});

test("a band a value-headed meter cannot spell is not drawn at all", () => {
  // There is no fallback: only the caller knows how its own quantity is
  // spelled. Dropping the band from the head but leaving it on the track would
  // be the same defect one step quieter — a hatch with nothing to explain it.
  const html = renderToStaticMarkup(
    <Meter label="Spend" fraction={0.4} upperFraction={0.8} value="$3.20" />,
  );
  assert.match(html, /\$3\.20/);
  assert.doesNotMatch(html, /80\.0%/, "the band must not print as a percentage");
  assert.doesNotMatch(html, /hatched/, "an unexplained band must not be drawn");
  assert.equal(announced(html), null);
});

test("a tiny non-zero reading is drawn, a zero one is not", () => {
  // 0.2% of a 200px track is a third of a pixel, so it paints as an empty bar —
  // "nothing used" for a window that has been used. The floor is on the drawn
  // width only: the reported percentage and aria-valuenow are untouched.
  const tiny = renderToStaticMarkup(<Meter label="w" fraction={0.002} />);
  assert.match(tiny, /min-width:3px/);
  assert.match(tiny, /aria-valuenow="0"/);

  const zero = renderToStaticMarkup(<Meter label="w" fraction={0} />);
  assert.doesNotMatch(zero, /min-width/, "a real zero must draw nothing");
});
