import { MODEL_DECIDER_URL, USER_AGENT } from "./config";
import { enabledModels, modelRefusal, type ModelCatalogueEntry } from "./modelCatalogue";
import { getSettings } from "./settings";

/**
 * Asks the model decider which model a run should use: a Claude model for a
 * Claude run, a Codex model for a Codex run.
 *
 * The decider is a separate local service (the LocalDecider project: a Tev1-4B
 * classifier behind llama-server) that is handed a run's task and this
 * install's enabled models and answers with one of them or abstains. Two doors
 * ask it — the orchestrator chat's `propose_run` and an orchestrator block's
 * `emit_runs` — and only for a run nothing a person configured has already
 * answered: see `deciderApplies`.
 *
 * **It replaces the rule that a model may not choose what a run costs with
 * nobody in the loop**, which `RunSpec` used to state for the block. The
 * operator overruled it on 2026-10-05: a block's runs may be started on a model
 * the decider picked with no one reading the choice. What still holds is why
 * the old rule could be dropped at all — a model moves cost and never
 * capability, every cost guard measures whatever it selects, and the answer is
 * checked against the operator's own list with `modelRefusal` before it can
 * reach `--model`.
 *
 * **It never decides whether a run happens, and it is never a reason to stop
 * one.** Off, unreachable, slow, unsure or answering nonsense all come back as
 * `model: null` with a sentence saying which, and the run takes the rung below
 * — the operator's default — exactly as it did before the decider existed.
 */

/** Long enough for a queued request behind the decider's own 10s llama timeout. */
const DECIDER_TIMEOUT_MS = 15_000;

/** The decider's reason is text from another process; this bounds what a card or a note carries. */
const MAX_NOTE_DETAIL = 300;

/** One run's work, as the decider is shown it. */
export interface DeciderWork {
  /** The title and task as the chat or the block wrote them. */
  task: string;
  /** The saved agent's name, when the run is started as one. */
  agent?: string | null;
  /** The template's name, when the run has one. */
  template?: string | null;
  /**
   * Which CLI the run is spawned as, and so which list the decider is handed
   * and its answer is held to. Null or absent is the ordinary Claude run.
   */
  provider?: string | null;
}

/**
 * The verdict on one run. `model` null keeps the run on the rung below the
 * decider; `note` is always written, because "the decider was down" and "the
 * decider was unsure" read the same on a run that took the default otherwise.
 */
export interface ModelDecision {
  model: string | null;
  note: string;
}

/**
 * Whether a run is the decider's to answer.
 *
 * A Claude run or a Codex run, each from its own list (`catalogueFor`), and
 * never a local one, whose server lists nothing the decider could be handed.
 * And only where nothing a person configured names a model: the run's own (the
 * chat may name one), its template's, and its agent's, because an agent pinned
 * to a model is the operator's answer for that role. On a Codex run only the
 * run's own counts — a template's or an agent's model is a Claude id that never
 * reaches `codex exec`, so it answers nothing there. `settings.defaultModel` and
 * `settings.codexDefaultModel` are deliberately not on the list; they are the
 * fallbacks the decider sits above.
 */
export function deciderApplies(run: {
  provider: string | null | undefined;
  named: string | null | undefined;
  templateModel: string | null | undefined;
  agentModel: string | null | undefined;
}): boolean {
  if (run.provider === "codex") return !run.named?.trim();
  if (run.provider && run.provider !== "claude") return false;
  return [run.named, run.templateModel, run.agentModel].every((model) => !model?.trim());
}

/** The list a run's model is chosen from and held to: its own provider's. */
function catalogueFor(provider: string | null | undefined): readonly ModelCatalogueEntry[] {
  const settings = getSettings();
  return provider === "codex" ? settings.codexModelCatalogue : settings.modelCatalogue;
}

/**
 * Read one decider response into a verdict. Pure, and the one place an
 * answer is checked against the operator's list before it can become a run's
 * model — an id switched off since the request was sent is refused here.
 */
export function readDeciderReply(
  status: number,
  body: unknown,
  catalogue: readonly ModelCatalogueEntry[],
  provider: string | null | undefined = null,
): ModelDecision {
  const field = (name: string): unknown =>
    body !== null && typeof body === "object" ? Reflect.get(body, name) : undefined;

  if (status !== 200) {
    const error = field("error");
    const detail = typeof error === "string" ? `: ${clip(error)}` : "";
    return { model: null, note: `The model decider answered ${status}${detail}.` };
  }

  const model = field("model");
  const reason = field("reason");
  const why = typeof reason === "string" ? clip(reason) : "no reason given";
  if (model === null) return { model: null, note: `The model decider abstained: ${why}.` };
  if (typeof model !== "string" || !model.trim()) {
    return { model: null, note: "The model decider answered in a shape this build cannot read." };
  }

  const refusal = modelRefusal(catalogue, model, provider === "codex" ? "codex" : "claude");
  if (refusal) return { model: null, note: `The model decider picked ${clip(model)}, which was refused. ${refusal}` };
  return { model: model.trim(), note: `Picked by the model decider: ${why}.` };
}

/**
 * Ask, or answer null without asking when the decider is off. Never rejects:
 * both callers are inside a tool call a model is waiting on, and a decider
 * problem is a sentence on the card or the block, never a failed tool call.
 */
export async function decideRunModel(work: DeciderWork): Promise<ModelDecision | null> {
  if (!MODEL_DECIDER_URL) return null;

  // One provider's list per request: the decider ranks within a tier by
  // version, and a Claude id beside a Codex one would be a pick this run's CLI
  // cannot take.
  const catalogue = catalogueFor(work.provider);
  const models = enabledModels(catalogue).map((entry) => entry.id);
  if (models.length === 0) {
    return {
      model: null,
      note:
        work.provider === "codex"
          ? "The model decider was not asked: this install has no enabled Codex models to choose from."
          : "The model decider was not asked: this install has no enabled models to choose from.",
    };
  }

  let res: Response;
  let body: unknown = null;
  try {
    res = await fetch(new URL("/v1/decide", MODEL_DECIDER_URL), {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({
        prompt: work.task,
        models,
        agent: work.agent ?? undefined,
        template: work.template ?? undefined,
      }),
      // Next patches `fetch` and caches through it; a cached verdict would be
      // another task's.
      cache: "no-store",
      signal: AbortSignal.timeout(DECIDER_TIMEOUT_MS),
    });
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    const why = timedOut
      ? `did not answer within ${DECIDER_TIMEOUT_MS / 1000} seconds`
      : `could not be reached (${err instanceof Error ? clip(err.message) : String(err)})`;
    console.warn(`[usagefoundry] model decider ${why}`);
    return { model: null, note: `The model decider ${why}.` };
  }

  const decision = readDeciderReply(res.status, body, catalogue, work.provider);
  if (res.status !== 200) console.warn(`[usagefoundry] ${decision.note}`);
  return decision;
}

function clip(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > MAX_NOTE_DETAIL ? `${flat.slice(0, MAX_NOTE_DETAIL)}…` : flat;
}
