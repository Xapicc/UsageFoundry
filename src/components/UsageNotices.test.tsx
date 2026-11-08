import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageNotices, type UsageNoticesPage } from "./UsageNotices";

/**
 * Five notices, two pages, one component — and the risk is a notice that
 * stops rendering where it is owed.
 *
 * Each one explains a figure that otherwise looks right: a hatched meter with
 * no ceiling, a dollar total that is a floor, a guard band wider than the fill.
 * Wired to the wrong page, or gated on one window when the figure reads two,
 * the notice is simply absent, and the page under it is indistinguishable
 * from a healthy one. Nothing throws and nothing fails to typecheck.
 */

const NO_PERCENTAGES = /No percentages available\./;
const UNPRICED = /Unpriced models seen:/;
const CACHE_WRITE = /Cache writes with no declared lifetime:/;
const READ_FAILURE = /could not be read:/;
const CACHE_BOUND = /Transcript cache at its bound\./;

interface Conditions {
  noCeilings?: boolean;
  unpriced?: boolean;
  sessionCacheWrite?: number;
  weeklyCacheWrite?: number;
  readFailureCount?: number;
  evictions?: number;
}

function render(page: UsageNoticesPage, c: Conditions = {}): string {
  const reading = (cacheWriteUnattributed: number) => ({
    agg: { tokens: { cacheWriteUnattributed } },
  });
  const failures = Math.min(c.readFailureCount ?? 0, 2);
  return renderToStaticMarkup(
    <UsageNotices
      page={page}
      meta={{
        hasSessionCeiling: !c.noCeilings,
        hasWeeklyCeiling: !c.noCeilings,
        planUsageFromApi: true,
        unpricedModels: c.unpriced ? ["claude-new-model"] : [],
        readFailures: Array.from({ length: failures }, (_, i) => ({
          path: `/claude/projects/p${i}.jsonl`,
          message: "EACCES",
        })),
        readFailureCount: c.readFailureCount ?? 0,
        memory: { cache: { evictions: c.evictions ?? 0 } },
      }}
      snapshot={{
        session: reading(c.sessionCacheWrite ?? 0),
        weekly: reading(c.weeklyCacheWrite ?? 0),
      }}
    />,
  );
}

const EVERYTHING: Conditions = {
  noCeilings: true,
  unpriced: true,
  sessionCacheWrite: 1_000,
  readFailureCount: 1,
  evictions: 3,
};

test("the dashboard carries the ceiling notice and not the cache bound", () => {
  const html = render("dashboard", EVERYTHING);
  for (const notice of [NO_PERCENTAGES, UNPRICED, CACHE_WRITE, READ_FAILURE]) {
    assert.match(html, notice);
  }
  assert.doesNotMatch(html, CACHE_BOUND);
});

test("/usage carries the cache bound and not the ceiling notice", () => {
  const html = render("usage", EVERYTHING);
  for (const notice of [UNPRICED, CACHE_WRITE, READ_FAILURE, CACHE_BOUND]) {
    assert.match(html, notice);
  }
  assert.doesNotMatch(html, NO_PERCENTAGES);
});

test("nothing renders on either page while nothing is wrong", () => {
  assert.equal(render("dashboard"), "");
  assert.equal(render("usage"), "");
});

test("one ceiling is enough to withhold the no-percentages notice", () => {
  const html = renderToStaticMarkup(
    <UsageNotices
      page="dashboard"
      meta={{
        hasSessionCeiling: false,
        hasWeeklyCeiling: true,
        planUsageFromApi: true,
        unpricedModels: [],
        readFailures: [],
        readFailureCount: 0,
        memory: { cache: { evictions: 0 } },
      }}
      snapshot={{
        session: { agg: { tokens: { cacheWriteUnattributed: 0 } } },
        weekly: { agg: { tokens: { cacheWriteUnattributed: 0 } } },
      }}
    />,
  );
  assert.equal(html, "");
});

test("an unattributed cache write in either window raises the notice, at the larger", () => {
  // The session is a slice of the week only when no weekly anchor cuts it, so
  // neither window bounds the other and the notice must read both.
  const sessionOnly = render("usage", { sessionCacheWrite: 2_000_000 });
  assert.match(sessionOnly, CACHE_WRITE);
  assert.match(sessionOnly, /2\.00M/);

  const weeklyOnly = render("usage", { weeklyCacheWrite: 3_000_000 });
  assert.match(weeklyOnly, CACHE_WRITE);
  assert.match(weeklyOnly, /3\.00M/);

  const both = render("usage", {
    sessionCacheWrite: 3_000_000,
    weeklyCacheWrite: 2_000_000,
  });
  assert.match(both, /3\.00M/);
  assert.doesNotMatch(both, /2\.00M/);
});

test("read failures past the listed ones are counted, not dropped", () => {
  const html = render("dashboard", { readFailureCount: 5 });
  assert.match(html, /5 paths could not be read:/);
  assert.match(html, /p0\.jsonl/);
  assert.match(html, /p1\.jsonl/);
  assert.match(html, /, and 3\s+more/);
});
