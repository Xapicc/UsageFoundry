import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CodexUsageDTO } from "../lib/apiTypes";
import { CodexWindows, codexWindowName } from "./CodexWindows";

/**
 * The Codex section of the window card. Three ways to get it wrong quietly: a
 * window labelled "5-hour" over a reading of some other length, a window the
 * backend did not report drawn as an empty bar — "0%, plenty left" where the
 * truth is "unknown" — and a window that has reset since the cached reading
 * was taken drawn at its last figure.
 */

test("names a window by the length the backend reported", () => {
  assert.equal(codexWindowName(300, "Short"), "5-hour");
  assert.equal(codexWindowName(10_080, "Long"), "Weekly");
  assert.equal(codexWindowName(1_440, "Long"), "1-day");
  assert.equal(codexWindowName(43_200, "Long"), "30-day");
  assert.equal(codexWindowName(90, "Short"), "90-minute");
  assert.equal(codexWindowName(null, "Short"), "Short");
  assert.equal(codexWindowName(0, "Long"), "Long");
});

const PLAN: NonNullable<CodexUsageDTO["plan"]> = {
  session: { utilization: 0.25, resetsAt: 1_791_414_721_000 },
  weekly: null,
  scopedWeekly: [],
  fetchedAt: 1_791_400_000_000,
  sessionMinutes: 300,
  weeklyMinutes: null,
  planType: "team",
  limitReached: null,
};

test("draws an unreported window as unknown, never as 0%", () => {
  const html = renderToStaticMarkup(
    <CodexWindows codex={{ plan: PLAN, error: null }} now={1_791_400_000_000} />,
  );
  assert.match(html, /5-hour window/);
  assert.match(html, /25\.0%/);
  assert.match(html, /Long window/);
  assert.match(html, /not reported/);
  assert.doesNotMatch(html, /0\.0%/);
  assert.match(html, /ChatGPT Team/);
});

test("says why there is no reading rather than drawing meters", () => {
  const html = renderToStaticMarkup(
    <CodexWindows
      codex={{ plan: null, error: "`codex app-server` did not answer within 20s" }}
      now={0}
    />,
  );
  assert.match(html, /No reading: /);
  assert.doesNotMatch(html, /window<\/span>/);
});

test("a window whose reset has passed is unknown, not its last percentage", () => {
  // Fetched four minutes ago, inside the five-minute refresh, so `codexUsage`
  // serves it as it stands; the 5-hour window was full and reset a minute ago.
  const now = 1_791_400_000_000;
  const plan: NonNullable<CodexUsageDTO["plan"]> = {
    ...PLAN,
    session: { utilization: 1.0, resetsAt: now - 60_000 },
    weekly: { utilization: 0.4, resetsAt: now + 3 * 86_400_000 },
    fetchedAt: now - 4 * 60_000,
    weeklyMinutes: 10_080,
    limitReached: "rate_limit_reached",
  };
  const html = renderToStaticMarkup(<CodexWindows codex={{ plan, error: null }} now={now} />);
  assert.doesNotMatch(html, /100\.0%/, "the closed 5-hour window is drawn as 100% used");
  assert.match(html, /reset since this reading/);
  assert.match(html, /40\.0%/, "the open weekly window still reads");
  // The wall was the window that reset, so nothing open is at it now.
  assert.doesNotMatch(html, /limit reached/);

  // The control: the same wall before its reset is drawn, badge and all.
  const before = renderToStaticMarkup(
    <CodexWindows
      codex={{ plan: { ...plan, session: { utilization: 1.0, resetsAt: now + 60_000 } }, error: null }}
      now={now}
    />,
  );
  assert.match(before, /100\.0%/);
  assert.match(before, /limit reached/);
});
