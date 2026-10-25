/** What the "Pick up N runs" sheet holds while it is open. */
export interface PickUpSheetFields {
  /** The cycle field as typed; blank is "no cycle limit". */
  moreCycles: string;
  /** The spending field as typed; blank is "leave each run's own". */
  spendLimit: string;
  /** The separate choice to take the spending limit off every run. */
  removeSpendLimit: boolean;
}

/** The `budget` `POST /api/fleet` takes, which `reopenFleet` lays over each run's own. */
export interface PickUpBudget {
  moreIterations: number | null;
  /** Absent means "keep each run's own"; `null` is an explicit "no limit". */
  maxRunCostUSD?: number | null;
}

/**
 * The sheet's answer as it goes on the wire.
 *
 * `reopenFleet` spreads the wire over each run's stored budget, so a key that is
 * *present* wins and a key that is absent leaves that run's own value alone.
 * The spending field used to send `null` when blank, which at its untouched
 * default removed every run's spending limit on a press aimed at something
 * else, and nothing threw. A blank field therefore leaves the key off, a
 * number sets that limit on every run, and taking the guard off is its own
 * switch — a spending guard is never removed by a default nobody chose.
 *
 * The cycle field is the other way round on purpose: it opens at 1 and blank
 * is a deliberate "no cycle limit", so it is always sent.
 *
 * Pure and in `src/lib/` so the component and the test that pins its wire call
 * one function, and the test cannot drift from the sheet.
 */
export function pickUpBudget(fields: PickUpSheetFields): PickUpBudget {
  const budget: PickUpBudget = {
    moreIterations: fields.moreCycles === "" ? null : Number(fields.moreCycles),
  };
  if (fields.removeSpendLimit) budget.maxRunCostUSD = null;
  else if (fields.spendLimit !== "") budget.maxRunCostUSD = Number(fields.spendLimit);
  return budget;
}

/** The sheet as it opens: cycles at 1, nothing typed, nothing switched off. */
export const PICK_UP_SHEET_DEFAULTS: PickUpSheetFields = {
  moreCycles: "1",
  spendLimit: "",
  removeSpendLimit: false,
};
