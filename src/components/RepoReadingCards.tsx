"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { RepoReadingDTO, RepoReadingRepositoryDTO } from "@/lib/apiTypes";
import { fmtDate, fmtPct, fmtUSD, pollFailureMessage } from "@/lib/format";
import { Card, CardTitle, Empty, Subsection } from "@/components/ui/Card";
import { ListView, STICKY_HEAD_FLAT } from "@/components/ui/ListView";
import { Notice } from "@/components/ui/Notice";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/Table";

/**
 * What runs on each repository keep reading, failing at and colliding in: one
 * card per repository.
 *
 * Three things the copy has to keep saying, because each is a way of reading
 * this wrongly:
 *
 *   - **A repeat is not waste.** Half the files a run re-reads it then edits,
 *     and it had to open those whatever an earlier run knew. The split is on
 *     the card in words, never one share standing alone.
 *   - **A failure is a string, not a cause.** Dreaming's rule, from the
 *     normaliser this shares with it: two faults can share one signature.
 *   - **The resolutions' money is per repository.** A resolution names every
 *     file it was given and costs one figure for all of them.
 *
 * Loaded once and never polled, `RepoSpendCard`'s choice: what it reads changes
 * when a run ends, and each read is a full scan of `run_events`.
 */
export function RepoReadingCards() {
  const [data, setData] = useState<RepoReadingDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/repo-reading", { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as Partial<
          RepoReadingDTO & { error: string }
        >;
        if (!live) return;
        if (!res.ok || !json.repositories) {
          setError(
            pollFailureMessage(
              res.status,
              json.error ?? (res.ok ? "no repositories in the response" : null),
            ),
          );
          return;
        }
        setData(json as RepoReadingDTO);
        setError(null);
      } catch (err) {
        if (live) {
          setError(
            pollFailureMessage(null, err instanceof Error ? err.message : String(err)),
          );
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (error) {
    return (
      <div role="alert" className="mb-4">
        <Notice tone="danger">{error}</Notice>
      </div>
    );
  }
  if (!data) {
    return (
      <Card emphasis="quiet" className="mb-4">
        <Empty>Reading run logs…</Empty>
      </Card>
    );
  }
  if (data.repositories.length === 0) {
    return (
      <Card emphasis="quiet" className="mb-4">
        <Empty>No run has logged a file read, a tool failure or a conflict resolution yet.</Empty>
      </Card>
    );
  }
  return (
    <>
      {data.repositories.map((repo) => (
        <RepositoryCard key={repo.key} repo={repo} data={data} />
      ))}
    </>
  );
}

function RepositoryCard({
  repo,
  data,
}: {
  repo: RepoReadingRepositoryDTO;
  data: RepoReadingDTO;
}) {
  return (
    <Card emphasis="quiet" className="mb-4">
      <CardTitle>
        <span className={repo.isRepository ? "mono max-md:break-all" : undefined}>
          {repo.label}
        </span>
      </CardTitle>
      <div className="mb-2.5 text-xs font-semibold text-ink">What runs keep reading</div>
      <Reading reading={repo.reading} />
      <Subsection title="What they keep failing at">
        <Failures failures={repo.failures} />
      </Subsection>
      <Subsection title="What they keep colliding in">
        <Collisions contention={repo.contention} />
      </Subsection>
      <p className="mt-3 max-w-[72ch] text-xs text-ink-muted">
        {data.eventsFrom === null
          ? "No run log is kept."
          : `From run logs back to ${fmtDate(data.eventsFrom)}`}
        {data.eventsFrom !== null &&
          (data.eventRetentionDays === null
            ? ", kept forever."
            : `, kept ${data.eventRetentionDays} days.`)}{" "}
        Nothing here is a limit.
      </p>
    </Card>
  );
}

function Reading({ reading }: { reading: RepoReadingRepositoryDTO["reading"] }) {
  if (!reading) {
    return <Empty>No run here has read a file in the kept logs.</Empty>;
  }
  const r = reading;
  return (
    <>
      <p className="max-w-[72ch] text-sm text-ink">
        {r.reads.toLocaleString()} Read {r.reads === 1 ? "call" : "calls"} by {r.runs}{" "}
        {r.runs === 1 ? "run" : "runs"}. {r.repeats.toLocaleString()} (
        {fmtPct(r.repeats / r.reads)}) opened a file an earlier run here had already
        read.
        {r.repeats > 0 && (
          <>
            {" "}
            The run then edited {r.repeatsEdited.toLocaleString()} of those; the other{" "}
            {r.repeatsNotEdited.toLocaleString()}, {fmtPct(r.repeatsNotEdited / r.reads)} of
            all reading, re-read a file without changing it.
          </>
        )}
      </p>
      {r.reReadNotEdited.length > 0 && (
        <ListView box="capped" className="mt-2">
          <Table stack>
            <caption className="sr-only">
              Files runs re-read without editing, most runs first
            </caption>
            <THead>
              <tr>
                <Th className={STICKY_HEAD_FLAT}>Re-read, not edited</Th>
                <Th num className={STICKY_HEAD_FLAT}>
                  Runs
                </Th>
                <Th num className={STICKY_HEAD_FLAT}>
                  Reads
                </Th>
              </tr>
            </THead>
            <TBody>
              {r.reReadNotEdited.map((f) => (
                <Tr key={f.path}>
                  <Td className="mono break-all">{f.path}</Td>
                  <Td num label="Runs">
                    {f.runs}
                  </Td>
                  <Td num label="Reads">
                    {f.reads}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </ListView>
      )}
      {r.reReadFiles > r.reReadNotEdited.length && (
        <p className="mt-1 text-xs text-ink-muted">
          {r.reReadFiles - r.reReadNotEdited.length} more files were re-read without being
          edited.
        </p>
      )}
    </>
  );
}

function Failures({ failures }: { failures: RepoReadingRepositoryDTO["failures"] }) {
  if (!failures) {
    return <Empty>No tool call failed here in the kept logs.</Empty>;
  }
  const f = failures;
  return (
    <>
      <p className="max-w-[72ch] text-sm text-ink">
        {f.rows.toLocaleString()} failed tool {f.rows === 1 ? "call" : "calls"} across{" "}
        {f.runs} {f.runs === 1 ? "run" : "runs"}: {f.recurringCount}{" "}
        {f.recurringCount === 1 ? "failure" : "failures"} recurred in more than one run, and{" "}
        {f.singleRun} {f.singleRun === 1 ? "was" : "were"} seen in one run only.
      </p>
      {f.recurring.length > 0 && (
        <ListView box="capped" className="mt-2">
          <Table stack>
            <caption className="sr-only">
              Tool failures more than one run hit, most runs first
            </caption>
            <THead>
              <tr>
                <Th className={STICKY_HEAD_FLAT}>Failure</Th>
                <Th num className={STICKY_HEAD_FLAT}>
                  Runs
                </Th>
                <Th num className={STICKY_HEAD_FLAT}>
                  Times
                </Th>
              </tr>
            </THead>
            <TBody>
              {f.recurring.map((s) => (
                <Tr key={`${s.tool}\u0000${s.signature}`}>
                  <Td className="break-words">
                    <span className="text-ink-muted">{s.tool}</span>{" "}
                    <span className="mono">{s.sample || "(no text)"}</span>
                  </Td>
                  <Td num label="Runs">
                    {s.runs}
                  </Td>
                  <Td num label="Times">
                    {s.rows}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </ListView>
      )}
      <p className="mt-1 max-w-[72ch] text-xs text-ink-muted">
        Numbers, hashes and directories are blanked, so two different faults can read
        the same. <Link href="/dreaming">Dreaming</Link> counts these across every
        transcript on this machine, by day.
      </p>
    </>
  );
}

function Collisions({
  contention,
}: {
  contention: RepoReadingRepositoryDTO["contention"];
}) {
  if (!contention) {
    return <Empty>No conflict resolution has been recorded on this repository.</Empty>;
  }
  const c = contention;
  const span =
    fmtDate(c.firstAt) === fmtDate(c.lastAt)
      ? `on ${fmtDate(c.firstAt)}`
      : `between ${fmtDate(c.firstAt)} and ${fmtDate(c.lastAt)}`;
  return (
    <>
      <p className="max-w-[72ch] text-sm text-ink">
        {c.resolutions} paid conflict {c.resolutions === 1 ? "resolution" : "resolutions"}{" "}
        {span}, {fmtUSD(c.costUSD)} in all: outside every run&apos;s own spend, and not
        divisible between the files below, because one resolution costs one figure for
        every file it was given.
      </p>
      {c.files.length > 0 && (
        <ListView box="capped" className="mt-2">
          <Table stack>
            <caption className="sr-only">
              Files more than one conflict resolution named, most first
            </caption>
            <THead>
              <tr>
                <Th className={STICKY_HEAD_FLAT}>File</Th>
                <Th num className={STICKY_HEAD_FLAT}>
                  Resolutions
                </Th>
              </tr>
            </THead>
            <TBody>
              {c.files.map((f) => (
                <Tr key={f.path}>
                  <Td className="mono break-all">{f.path}</Td>
                  <Td num label="Resolutions">
                    {f.resolutions}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </ListView>
      )}
      <p className="mt-1 text-xs text-ink-muted">
        {c.fileCount > c.files.length &&
          `${c.fileCount - c.files.length} more files were named by more than one. `}
        {c.namedOnce} {c.namedOnce === 1 ? "file was" : "files were"} named once.
        Resolutions are kept forever.
      </p>
    </>
  );
}
