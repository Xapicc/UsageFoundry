import type { BudgetPolicyDTO, RunDTO } from "@/lib/apiTypes";

/** Everything a template or an earlier run supplies to this form. */
export interface FormSeed {
  mountId: string | null;
  folder: string | null;
  prompt: string;
  isolate: boolean;
  permissionMode: string;
  /**
   * The saved agent, by id. A copied run carries null: it holds the definition
   * it ran with rather than the id, deliberately, so there is nothing to select
   * with — and picking the agent that happens to have the same name today would
   * be this form guessing at an identity the run never recorded.
   */
  agentId: string | null;
  /**
   * The model the seed names, or null for "whatever Settings says".
   *
   * Both paths fill it now that a template carries one. It **seeds** the field,
   * the treatment `mountId`/`folder` get and not the treatment the prompt and
   * the guards get: what starts the run is whatever is in the box when Start is
   * pressed, so a template's model can be overridden for one run without
   * editing the template. Filling it is not the same act as pre-filling an
   * empty form with `settings.defaultModel`, which this page deliberately does
   * not do: a seed's model is a fact about that template or that run, and both
   * *Start another like this* and picking a template promise the configuration
   * that was saved rather than today's defaults.
   */
  model: string | null;
  budget: BudgetPolicyDTO;
}

/**
 * What *Start another like this* puts on the form, read off the run it copies.
 *
 * Pure, and out of the page, because the one mapping here that can go wrong
 * does so silently: a copy seeded with isolation off on a git repository runs
 * in the operator's own checkout and holds the folder against every other run
 * in that subtree, and nothing on the form says the original asked for a
 * worktree. Nothing here may import a component or a browser API, or
 * `formSeed.test.ts` stops running.
 */
export function seedFromRun(run: RunDTO): FormSeed {
  return {
    // A run stores its folder absolute; `relPath` is the same folder as the
    // picker names it. A run whose mount has since gone gives null, and then
    // the folder cannot be carried at all.
    mountId: run.mountId ?? null,
    folder: run.mountId ? (run.relPath ?? "") : null,
    prompt: run.prompt,
    // What the run did, where it did anything: one that asked for a worktree
    // and got none because the folder was not a repository reads "none", and
    // copying that outcome is the honest reading of the arrangement that
    // produced the result. Null is a run whose workspace was never planned —
    // created behind a dependency, then blocked, or failed at release — and
    // `createRun` writes it only for a run that asked to be isolated, so it is
    // read here the way the orchestrator reads it at release. `canIsolate`
    // still re-gates the answer against whatever folder the copy lands on.
    isolate: run.isolation !== "none",
    permissionMode: run.budget.permissionMode ?? "acceptEdits",
    // A run records the definition it was given, not the row it came from, so
    // there is no id to carry — see `FormSeed`.
    agentId: null,
    // The model the run actually got, which is the point of the copy: a run
    // started under a model that has since stopped being the default would
    // otherwise come back as a differently-priced run wearing the same task.
    // The same treatment the permission mode gets, and for the same reason —
    // what is copied is the arrangement that produced the result, not today's
    // settings.
    model: run.model,
    budget: run.budget,
  };
}
