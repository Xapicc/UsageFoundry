// Relative, not "@/…": the test build is plain CommonJS and nothing rewrites
// the alias at runtime.
import type { WaitingDTO, WaitingReadingDTO } from "../lib/apiTypes";

export type WaitingKey = "needs-review" | "failed" | "branches" | "proposals" | "tasks";

export interface WaitingItem {
  key: WaitingKey;
  /** Where the operator acts on it. */
  href: string;
  /**
   * The figure as it is said — `3`, or `At least 12` for a floor — or null when
   * there is none, in which case `label` carries the whole sentence.
   */
  count: string | null;
  label: string;
}

export type WaitingView =
  | { kind: "loading" }
  /** The read itself failed, so every count is unknown. */
  | { kind: "failed" }
  /** Every count was read in full and every one is zero. */
  | { kind: "quiet" }
  | { kind: "items"; items: WaitingItem[] };

interface Place {
  key: WaitingKey;
  /**
   * `/runs` takes only an in-flight status in `?status=` and refuses any other,
   * and the tasks board keeps its operator-only filter in the browser rather
   * than the URL, so none of these can narrow the page it opens.
   */
  href: string;
  one: string;
  many: string;
  /** Names the count when there is no figure to lead the sentence with. */
  name: string;
}

/** In the order the strip lists them. */
const PLACES: Record<keyof Omit<WaitingDTO, "failedSince">, Place> = {
  needsReview: {
    key: "needs-review",
    href: "/runs",
    one: "run needs review",
    many: "runs need review",
    name: "Runs needing review",
  },
  failedRecently: {
    key: "failed",
    href: "/runs",
    one: "run failed in the last 24 hours",
    many: "runs failed in the last 24 hours",
    name: "Runs failed in the last 24 hours",
  },
  branches: {
    key: "branches",
    href: "/branches",
    one: "branch ready to land",
    many: "branches ready to land",
    name: "Branches ready to land",
  },
  proposals: {
    key: "proposals",
    href: "/chat",
    one: "chat proposal waiting",
    many: "chat proposals waiting",
    name: "Chat proposals waiting",
  },
  tasks: {
    key: "tasks",
    href: "/tasks",
    one: "operator-only task open",
    many: "operator-only tasks open",
    name: "Operator-only tasks open",
  },
};

/**
 * One reading as an item, or null when it is a known zero and says nothing.
 *
 * A floor of zero is not a zero — the read looked at part of what it counts
 * over and found none there — so it is said as a count that is not complete
 * rather than dropped, and it is also why a floor never lets the strip go quiet.
 */
function itemOf(place: Place, reading: WaitingReadingDTO): WaitingItem | null {
  const base = { key: place.key, href: place.href };
  switch (reading.state) {
    case "unknown":
      return { ...base, count: null, label: `${place.name}: unknown` };
    case "floor":
      if (reading.count === 0) {
        return { ...base, count: null, label: `${place.name}: not all checked` };
      }
      return { ...base, count: `At least ${reading.count}`, label: place.many };
    case "exact":
      if (reading.count === 0) return null;
      return {
        ...base,
        count: String(reading.count),
        label: reading.count === 1 ? place.one : place.many,
      };
  }
}

/**
 * What the strip says, from the last answer and whether the latest poll failed.
 *
 * Pure, and the part under test. `failed` wins over any held answer, as it does
 * for the toolbar's readout: counts held from before a failed poll can no longer
 * be vouched for, and the strip's whole job is to be believed when it says
 * nothing is waiting.
 */
export function waitingView(waiting: WaitingDTO | null, failed: boolean): WaitingView {
  if (failed) return { kind: "failed" };
  if (waiting === null) return { kind: "loading" };

  const items: WaitingItem[] = [];
  for (const [field, place] of Object.entries(PLACES) as [keyof typeof PLACES, Place][]) {
    const item = itemOf(place, waiting[field]);
    if (item) items.push(item);
  }
  return items.length === 0 ? { kind: "quiet" } : { kind: "items", items };
}
