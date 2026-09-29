import type { NoticeTone } from "./format";

/** One run the pick-up could not start, as `POST /api/runs/restarted` names it. */
export interface Refusal {
  id: string;
  reason: string;
}

/**
 * What the last press on the restart notice came back with.
 *
 * One value rather than an outcome and an error side by side, because a press
 * ends one way: two fields admit a stale refusal list drawn beside the failure
 * of the press after it.
 */
export type RestartClosedPress =
  | { ok: true; reopened: number; refused: Refusal[] }
  | { ok: false; message: string };

/** The answer to a press, drawn under the notice. */
export interface PressReport {
  tone: NoticeTone;
  summary: string;
  /** Each refused run by its short id, with the sentence `reopenRun` refused it in. */
  refused: { id: string; name: string; reason: string }[];
  /** What clears a refused run from the count, since pressing again will not. */
  followUp: string | null;
}

export interface RestartClosedView {
  /** The count on the "Pick up" button, or null when there is no button. */
  offer: number | null;
  report: PressReport | null;
}

/**
 * What `RestartClosed` draws, given the ids the last read of the list returned
 * and the last press.
 *
 * The component used to choose one of three returns, and each hid something:
 *
 *  - the answer to a press was drawn only once the count reached zero, but only
 *    a successful pick-up clears `restart_closed`, so a refused run is still in
 *    the count after the press. A partial pick-up therefore redrew the same
 *    notice and the same button, and the sentence naming each refused run and
 *    its reason was never on screen. Some refusals are permanent — a run of a
 *    stopped workflow, a run whose work cycles are used up — so every further
 *    press was refused again, silently.
 *  - a failed press returned the error in place of the notice, which removed
 *    the button, and the only thing that cleared the error was the button. The
 *    message said "try again" over a page with nothing to press until a reload.
 *
 * So the answer to the last press is drawn whenever there is one, and the
 * button beside it whenever runs are waiting — unless one of them is a run
 * that press just refused. The offer is a sentence saying the runs "can resume
 * where they left off" over a button that picks them up, and for a run just
 * refused that is false: a refusal can be permanent, and pressing again only
 * asks again. The answer already names each of them with the way out, which is
 * on its own page.
 *
 * No offer at all rather than one for the runs that were not refused, because
 * the press does not take a list: it picks up everything `restartClosedRuns`
 * returns, the refused runs included, and the sheet's count is the promise
 * about how many agents one press may start. After a press the list is read
 * again at once and is exactly what it refused, so the two only mix when a run
 * joins the list between the press and that read; it is then offered on the
 * next load of the page. A failed press refused nothing anybody knows of, so
 * it keeps the button, which is how its error is cleared.
 */
export function restartClosedView(
  waiting: readonly string[] | null,
  press: RestartClosedPress | null,
): RestartClosedView {
  const justRefused = new Set(press?.ok ? press.refused.map((r) => r.id) : []);
  const offerable =
    waiting !== null && waiting.length > 0 && !waiting.some((id) => justRefused.has(id));
  return {
    offer: offerable ? waiting.length : null,
    report: press === null ? null : pressReport(press),
  };
}

function pressReport(press: RestartClosedPress): PressReport {
  if (!press.ok) {
    return { tone: "danger", summary: press.message, refused: [], followUp: null };
  }

  const { reopened, refused } = press;
  if (refused.length === 0) {
    return {
      tone: "info",
      summary: `${runs(reopened)} back in the queue.`,
      refused: [],
      followUp: null,
    };
  }

  return {
    tone: "warn",
    summary:
      reopened === 0
        ? `None went back in the queue. ${runs(refused.length)} refused:`
        : `${runs(reopened)} back in the queue. ${refused.length} refused:`,
    // The short id is how the rest of the app names a run in running text, and
    // each reason is `reopenRun`'s own sentence, which says "this run" and
    // would be anonymous without it.
    refused: refused.map((r) => ({ id: r.id, name: r.id.slice(0, 8), reason: r.reason })),
    // A refused run keeps `restart_closed`, so it stays in the count and a
    // second press meets the same refusal. Its own page is where either way
    // out of the count is: a pick-up under a budget the operator enters, or
    // setting it aside.
    followUp: `${
      refused.length === 1 ? "It stays" : "They stay"
    } in the count until picked up or set aside from ${
      refused.length === 1 ? "its own page" : "their own pages"
    }.`,
  };
}

function runs(count: number): string {
  return `${count} run${count === 1 ? "" : "s"}`;
}
