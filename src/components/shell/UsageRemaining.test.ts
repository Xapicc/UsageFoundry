import { strict as assert } from "node:assert";
import { test } from "node:test";
import type {
  UsageRemainingDTO,
  UsageRemainingProviderDTO,
} from "../../lib/apiTypes";
import { remainingOf, remainingStrip, shortWindowName } from "./UsageRemaining";

/**
 * The toolbar readout's mapping from the route's answer to what is drawn. It
 * fails quietly in three places: "left" computed by subtracting the wrong way
 * round or without clamping, an unknown window drawn as a number or tinted as
 * if it were fine, and a figure kept on screen after the poll behind it died.
 */

const NOW = 1_791_400_000_000;

function provider(
  overrides: Partial<UsageRemainingProviderDTO> = {},
): UsageRemainingProviderDTO {
  return {
    provider: "claude",
    windows: [
      { slot: "session", minutes: 300, used: 0.28, resetsAt: NOW + 3_600_000 },
      { slot: "weekly", minutes: 10_080, used: 0.06, resetsAt: NOW + 86_400_000 },
    ],
    fetchedAt: NOW - 60_000,
    stale: false,
    limitReached: null,
    note: null,
    ...overrides,
  };
}

function strip(p: UsageRemainingProviderDTO, failed = false) {
  const dto: UsageRemainingDTO = { providers: [p] };
  return remainingStrip(dto, NOW, failed)[0];
}

test("remaining is one minus used, clamped to 0–1", () => {
  assert.ok(Math.abs((remainingOf(0.28) ?? NaN) - 0.72) < 1e-9);
  assert.equal(remainingOf(0), 1);
  assert.equal(remainingOf(1), 0);
  // Over the wall is a real reading and is not a negative remainder.
  assert.equal(remainingOf(1.04), 0);
  assert.equal(remainingOf(-0.1), 1);
});

test("an unknown window stays unknown and is not a number", () => {
  assert.equal(remainingOf(null), null);
  assert.equal(remainingOf(Number.NaN), null);

  const unknown = strip(
    provider({
      windows: [
        { slot: "session", minutes: 300, used: null, resetsAt: null },
        { slot: "weekly", minutes: 10_080, used: 0.06, resetsAt: null },
      ],
    }),
  );
  assert.deepEqual(
    unknown.cells.map((c) => [c.text, c.remaining, c.tone]),
    [
      ["—", null, null],
      ["94%", 0.94, "ok"],
    ],
  );
});

test("colours by how much is used, so a nearly spent window stands out", () => {
  const toneAt = (used: number) =>
    strip(
      provider({
        windows: [{ slot: "session", minutes: 300, used, resetsAt: null }],
      }),
    ).cells[0].tone;
  assert.equal(toneAt(0.69), "ok");
  assert.equal(toneAt(0.7), "warn");
  assert.equal(toneAt(0.89), "warn");
  assert.equal(toneAt(0.9), "danger");
  assert.equal(toneAt(1.04), "danger");
});

test("rounds to a whole percent and marks a reading whose refresh failed", () => {
  const fresh = strip(provider());
  assert.deepEqual(
    fresh.cells.map((c) => c.text),
    ["72%", "94%"],
  );

  const stale = strip(provider({ stale: true }));
  assert.deepEqual(
    stale.cells.map((c) => c.text),
    ["~72%", "~94%"],
  );
  assert.match(stale.description, /last read 1m ago/);
});

test("a window the provider says is at its wall reads danger whatever it shows", () => {
  const hit = strip(provider({ provider: "codex", limitReached: "primary" }));
  assert.deepEqual(
    hit.cells.map((c) => c.tone),
    ["danger", "danger"],
  );
  assert.match(hit.description, /primary limit reached/);
});

test("a failed poll turns every held figure to unknown", () => {
  const out = strip(provider(), true);
  assert.deepEqual(
    out.cells.map((c) => [c.text, c.tone]),
    [
      ["—", null],
      ["—", null],
    ],
  );
  assert.match(out.description, /^Claude 5h unknown, wk unknown\. could not be refreshed$/);
});

test("names each window from its reported length", () => {
  assert.equal(shortWindowName(300, "short"), "5h");
  assert.equal(shortWindowName(10_080, "long"), "wk");
  assert.equal(shortWindowName(4_320, "long"), "3d");
  assert.equal(shortWindowName(90, "short"), "90m");
  assert.equal(shortWindowName(null, "short"), "short");
  assert.equal(shortWindowName(0, "long"), "long");

  const codex = strip(
    provider({
      provider: "codex",
      windows: [
        { slot: "session", minutes: null, used: 0.4, resetsAt: null },
        { slot: "weekly", minutes: 1_440, used: 0.1, resetsAt: null },
      ],
    }),
  );
  assert.deepEqual(
    codex.cells.map((c) => c.label),
    ["short", "1d"],
  );
});

test("the accessible name opens with what is on screen, then the resets, per provider", () => {
  const dto: UsageRemainingDTO = {
    providers: [provider(), provider({ provider: "codex" })],
  };
  const [claude, codex] = remainingStrip(dto, NOW, false);
  assert.equal(claude.name, "Claude");
  assert.equal(codex.name, "Codex");
  assert.match(
    claude.description,
    /^Claude 5h 72% left, wk 94% left\. 5-hour window resets .*; Weekly window resets /,
  );
  assert.doesNotMatch(claude.description, /Codex/);
});
