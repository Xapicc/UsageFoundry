"use client";

import { useState, type ReactNode } from "react";
import type { ProjectTokenEconomizerDTO, TokenEconomizerRepoReportDTO } from "@/lib/apiTypes";
import { fmtPct, pollFailureMessage } from "@/lib/format";
import { Disclosure } from "@/components/ui/Disclosure";
import { Hint } from "@/components/ui/Hint";

/**
 * One project's TokenEconomizer record, behind a fold that reads it on first
 * open.
 *
 * Fetched on open rather than with the row because each read is a Python child
 * on the server, and the Project manager reads a whole page of rows at once.
 * Read once per page load: the record moves when a session ends, and a fold
 * that re-read on every toggle would spend a child to show the same counts.
 *
 * **Counts, never savings**, and the caption says it where the counts are. A
 * redirect or a left-out tool is what the plugin did; whether that made a run
 * cheaper is a comparison against runs without it, which no live install makes.
 */
export function ProjectTokenEconomizer({ mountId, folder }: { mountId: string; folder: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ProjectTokenEconomizerDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);

  const load = async () => {
    try {
      const query = new URLSearchParams({ mountId, folder });
      const res = await fetch(`/api/projects/token-economizer?${query}`, { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as Partial<ProjectTokenEconomizerDTO> & {
        error?: string;
      };
      if (!res.ok || !json.state) {
        setError(pollFailureMessage(res.status, json.error ?? (res.ok ? "no record in the response" : null)));
        return;
      }
      setData(json as ProjectTokenEconomizerDTO);
      setError(null);
    } catch (err) {
      setError(pollFailureMessage(null, err instanceof Error ? err.message : String(err)));
    }
  };

  return (
    <Disclosure
      summary="TokenEconomizer"
      open={open}
      onToggle={(next) => {
        setOpen(next);
        if (next && !asked) {
          setAsked(true);
          void load();
        }
      }}
      className="mt-2 text-sm"
    >
      <div className="mt-2">
        {error ? (
          <Hint tone="danger">{error}</Hint>
        ) : data === null ? (
          <p className="text-ink-muted">Reading its record…</p>
        ) : data.state === "ready" ? (
          <Report r={data.report} />
        ) : data.state === "failed" ? (
          <Hint tone="danger">Could not read its record: {data.reason}</Hint>
        ) : data.state === "off" ? (
          <p className="text-ink-muted">Switched off in Settings.</p>
        ) : (
          <p className="text-ink-muted">Not in this image.</p>
        )}
      </div>
    </Disclosure>
  );
}

function Report({ r }: { r: TokenEconomizerRepoReportDTO }) {
  if (r.sessions === 0 && r.toolprune.leftOut.length === 0) {
    return <p className="text-ink-muted">No session has ended with it loaded here yet.</p>;
  }
  const proposed = r.toolprune.proposed.filter((t) => !r.toolprune.leftOut.includes(t));
  return (
    <>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 tabular-nums">
        <Fact label="Learned from">{plural(r.sessions, "session")}</Fact>
        <Fact label="Unused tools">
          {r.toolprune.mode === "off" ? (
            "off"
          ) : (
            <>
              {r.toolprune.leftOut.length === 0 ? (
                "none left out yet"
              ) : (
                <>
                  {r.toolprune.leftOut.length} left out in {plural(r.toolprune.checkouts, "checkout")}:{" "}
                  <Names names={r.toolprune.leftOut} />
                </>
              )}
              {proposed.length > 0 && (
                <span className="block text-ink-muted">
                  {r.toolprune.mode === "propose" ? "proposed, not applied: " : "next, after the quiet period: "}
                  <Names names={proposed} />
                </span>
              )}
              {r.toolprune.givenBack.length > 0 && (
                <span className="block text-ink-muted">
                  given back: <Names names={r.toolprune.givenBack} />
                </span>
              )}
            </>
          )}
        </Fact>
        <Fact label="Repository facts">
          {r.microskills.mode === "off"
            ? "off"
            : `${plural(r.microskills.facts, "fact")} in use · given to ${plural(r.microskills.injectedSessions, "session")}`}
        </Fact>
        <Fact label="Stuck turns">
          {r.loopguard.mode === "off"
            ? "off"
            : `${r.loopguard.redirects} redirected · ${r.loopguard.stillStuck} still stuck after it`}
        </Fact>
        {r.overheadShare !== null && (
          <Fact label="Its own model calls">{fmtPct(r.overheadShare)} of these sessions&rsquo; tokens</Fact>
        )}
      </dl>
      <p className="mt-2 text-xs text-ink-muted">
        Counts of what it did, not savings: nothing here is compared against runs without it.
      </p>
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </>
  );
}

function Names({ names }: { names: readonly string[] }) {
  return <span className="mono break-all">{names.join(", ")}</span>;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}
