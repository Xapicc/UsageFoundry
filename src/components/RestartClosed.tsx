"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { Sheet } from "@/components/ui/Sheet";
import { actionFailureMessage, jsonRequest } from "@/lib/jsonRequest";
import {
  restartClosedView,
  type Refusal,
  type RestartClosedPress,
} from "@/lib/restartClosedView";

interface Restarted {
  count: number;
  runs: { id: string; prompt: string; status: string }[];
}

interface Reopened {
  reopened: number;
  refused: Refusal[];
}

/**
 * "N runs were closed out by a restart", and one press to pick them all up.
 *
 * The only route back used to be the run page, one run at a time, each asking
 * for a budget at the door — and nothing in the product said the runs were
 * there at all. The count went to a `console.warn` at boot, into a container
 * log, so the operator's first sign of a restart was a dashboard that had gone
 * quiet.
 *
 * Read once rather than polled. It is a fact about the last boot: it changes
 * when this component changes it, and at no other time.
 *
 * The press is behind a `Sheet` because it starts up to N billed agents at
 * once, which is the one thing in this app that never happens without somebody
 * saying so a second time. The sheet states the count, which is the number that
 * matters.
 */
export function RestartClosed({ onReopened }: { onReopened: () => void }) {
  const [state, setState] = useState<Restarted | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [press, setPress] = useState<RestartClosedPress | null>(null);

  const load = useCallback(async () => {
    const res = await jsonRequest<Restarted>("/api/runs/restarted");
    // A failed read shows nothing. This is standing context rather than a
    // reading being acted on, and the page's own poll already reports a server
    // that has stopped answering.
    setState(res.ok ? res.data : null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function pickUpAll() {
    setBusy(true);
    setPress(null);
    const res = await jsonRequest<Reopened>("/api/runs/restarted", { method: "POST" });
    setBusy(false);
    setConfirming(false);

    if (!res.ok) {
      setPress({
        ok: false,
        message: actionFailureMessage(res, "Could not pick those runs up. Try again."),
      });
      // Read the list again rather than trust the count from before the press:
      // a request that never reached the server may still have been carried
      // out, and the count is what the failure message tells the operator to
      // check before pressing a second time.
      await load();
      return;
    }

    setPress({ ok: true, reopened: res.data.reopened, refused: res.data.refused });
    await load();
    onReopened();
  }

  const { offer: count, report } = restartClosedView(state?.count ?? null, press);

  const reportNotice = report && (
    <Notice tone={report.tone} live>
      <p>{report.summary}</p>
      {report.refused.length > 0 && (
        // `anywhere` rather than `break-words`: a reason can carry a branch
        // name with no break in it, and only `anywhere` lowers the min-content
        // width a flex item is sized from, so at 390px the other one still
        // pushes the pane sideways.
        <ul className="mt-2 flex flex-col gap-1 [overflow-wrap:anywhere]">
          {report.refused.map((r) => (
            <li key={r.id}>
              <Link href={`/runs/${r.id}`} className="mono">
                {r.name}
              </Link>{" "}
              — {r.reason}
            </li>
          ))}
        </ul>
      )}
      {report.followUp && <p className="mt-2">{report.followUp}</p>}
    </Notice>
  );

  if (count === null) return reportNotice;

  return (
    <>
      <Notice tone="warn">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            {count} run{count === 1 ? " was" : "s were"} closed out when the
            server last restarted and can resume where{" "}
            {count === 1 ? "it" : "they"} left off.
          </span>
          <Button onClick={() => setConfirming(true)} disabled={busy}>
            Pick up {count}
          </Button>
        </div>
      </Notice>

      {reportNotice}

      <Sheet
        open={confirming}
        title={`Pick up ${count} run${count === 1 ? "" : "s"}?`}
        onDismiss={() => setConfirming(false)}
        confirmLabel="Pick up"
        onConfirm={() => void pickUpAll()}
        confirmDisabled={busy}
        busy={busy}
      >
        {/* Both conditions in one clause, and neither of them first: naming
            the folder as *the* condition and the cap as a postscript is what
            `/runs` and `/runs/[id]` were just corrected for, and a batch
            pick-up is the case where the cap, not the folder, is what most of
            them will wait on. "run slot" is the phrase those two surfaces
            already use. */}
        <p>
          Each goes back in the queue under the limits it was started with, and
          starts spending again when its folder and a run slot are both free.
        </p>
      </Sheet>
    </>
  );
}
