import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CodexUsageDTO } from "../lib/apiTypes";
import { CodexWindows, codexWindowName } from "./CodexWindows";

/**
 * The Codex section of the window card. Two ways to get it wrong quietly: a
 * window labelled "5-hour" over a reading of some other length, and a window
 * the backend did not report drawn as an empty bar — "0%, plenty left" where
 * the truth is "unknown".
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
