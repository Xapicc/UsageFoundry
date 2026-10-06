"use client";

import { useEffect, useState } from "react";
import { Notice } from "@/components/ui/Notice";
import { jsonRequest } from "@/lib/jsonRequest";
import { startPoll } from "@/lib/poll";
import { readOnlyBanner } from "@/lib/readOnlyBanner";

/**
 * How often the claim is re-read.
 *
 * Slow on purpose. The answer moves at most twice in a process's life — once at
 * boot, and once more if the heartbeat finds the directory has changed hands —
 * and this poll runs on every page in the app, beside four others that are
 * already competing with a live agent for the same CPU.
 */
const POLL_MS = 60_000;

/**
 * The banner a server that cannot write puts above every page.
 *
 * It exists because the only signal used to be one `console.warn` at boot,
 * phrased reassuringly, into a container whose stdout nobody is tailing. The
 * process then served every page normally, so a second replica looked exactly
 * like the first right up to the moment somebody pressed Start and got an error
 * naming a pid they had never heard of.
 *
 * A failed poll renders nothing. This is standing context about the server
 * rather than a reading the operator is acting on, and a banner that appeared
 * because one fetch was dropped by a proxy would train the eye to skip the one
 * that means something.
 */
export function ReadOnlyNotice() {
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    let live = true;

    async function read() {
      // The refusal *is* the failure branch: the route answers 503 so a load
      // balancer can act on it. `readOnlyBanner` decides what that 503 may say
      // — the sentence the server wrote, out of `checks` or out of `error` —
      // and what it must not: a dropped fetch, and a 503 whose body a proxy
      // ate, are not statements about the server and show nothing.
      const res = await jsonRequest<unknown>("/api/health");
      if (!live) return;
      setRefusal(readOnlyBanner(res));
    }

    const stop = startPoll(read, POLL_MS);
    return () => {
      live = false;
      stop();
    };
  }, []);

  if (!refusal) return null;

  return (
    <Notice tone="warn" className="shrink-0">
      {refusal}
    </Notice>
  );
}
