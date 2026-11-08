"use client";

import Link from "next/link";
// Relative rather than `@/`: the unit tests run the plain CommonJS emits, and
// nothing there rewrites the path alias at runtime.
import type { UsageResponse } from "../lib/apiTypes";
import { fmtTokens } from "../lib/format";
import { Notice } from "./ui/Notice";

/** Which page is drawing the notices; each carries one the other does not. */
export type UsageNoticesPage = "dashboard" | "usage";

/**
 * The fields read, named rather than the whole DTO, so a full `meta` and a
 * full `SnapshotDTO` are accepted as they are and a test needs no more than
 * this to build one.
 */
type NoticesMeta = Pick<
  UsageResponse["meta"],
  | "hasSessionCeiling"
  | "hasWeeklyCeiling"
  | "planUsageFromApi"
  | "unpricedModels"
  | "readFailures"
  | "readFailureCount"
> & { memory: { cache: { evictions: number } } };

interface CacheWriteReading {
  agg: { tokens: { cacheWriteUnattributed: number } };
}

/**
 * The conditional notices `/` and `/usage` both carry, written once so the two
 * pages cannot drift apart on a condition or a word.
 *
 * Three render on both, because each qualifies every figure drawn from the
 * transcripts and both pages draw those. One belongs to each page alone.
 * "No percentages available" explains the hatched meters, and the meters are on
 * `/`. The transcript-cache bound is a fact about what a refresh costs rather
 * than about any figure, so it sits on `/usage` with the provenance strip whose
 * heap figure it follows on from.
 */
export function UsageNotices({
  meta,
  snapshot,
  page,
}: {
  meta: NoticesMeta;
  snapshot: { session: CacheWriteReading; weekly: CacheWriteReading };
  page: UsageNoticesPage;
}) {
  const noCeilings = !meta.hasSessionCeiling && !meta.hasWeeklyCeiling;
  // Read off the two windows the meters draw rather than off the scan, so the
  // notice appears exactly when a figure on this page is affected. A record
  // that never declared a cache TTL could have been billed at either class, and
  // the two are 1.25× and 2.00× input.
  const unattributedCacheWrite = Math.max(
    snapshot.session.agg.tokens.cacheWriteUnattributed,
    snapshot.weekly.agg.tokens.cacheWriteUnattributed,
  );

  return (
    <>
      {page === "dashboard" && noCeilings && (
        <Notice tone="warn">
          <strong>No percentages available.</strong>{" "}
          {meta.planUsageFromApi ? (
            <>
              The account&rsquo;s utilisation read did not answer: Claude
              Code&rsquo;s credential here is missing or expired, or the request
              failed. Sign in with <span className="mono">claude</span> and it
              resumes by itself.
            </>
          ) : (
            <>
              Reading the account&rsquo;s utilisation is{" "}
              <Link href="/settings">switched off</Link>, and Anthropic
              publishes no number for a Pro/Max limit.
            </>
          )}{" "}
          Until then a percentage needs your own ceiling: enter one, or derive
          one in Settings →{" "}
          <Link href="/settings">Estimate a ceiling from your own history</Link>.
          Volumes and costs above are exact regardless.
        </Notice>
      )}

      {meta.unpricedModels.length > 0 && (
        <Notice tone="warn">
          <strong>Unpriced models seen:</strong>{" "}
          <span className="mono">{meta.unpricedModels.join(", ")}</span>. They
          count toward volume at $0, so dollar figures here are a floor. The
          budget guard charges them a conservative rate instead (the hatched
          span above), so a run can stop before the solid bar looks full.
        </Notice>
      )}

      {/* The same shape as the banner above and for the same reason: the
          hatched span says a guard is charging more than the solid bar shows,
          and nothing else on the page says why. Transcripts written before the
          cache TTL split — and any ~/.claude copied from a machine whose CLI
          predates it — record a write volume without saying which class billed
          it. */}
      {unattributedCacheWrite > 0 && (
        <Notice tone="warn">
          <strong>Cache writes with no declared lifetime:</strong>{" "}
          {fmtTokens(unattributedCacheWrite)}. Billed at 1.25× or 2× input and
          the records do not say which: figures here take the cheaper rate, the
          budget guard the dearer one (the hatched span above).
        </Notice>
      )}

      {/* Loud rather than quiet: every number on this page — and every budget
          verdict taken since — is short by however much was behind these
          paths, and the two ordinary reasons are a permissions mismatch on the
          mounted ~/.claude and a descriptor limit. Neither announces itself
          anywhere else. */}
      {meta.readFailureCount > 0 && (
        <Notice tone="warn">
          <strong>
            {meta.readFailureCount.toLocaleString()}{" "}
            {meta.readFailureCount === 1 ? "path" : "paths"} could not be read:
          </strong>{" "}
          {meta.readFailures.map((f, i) => (
            <span key={f.path}>
              {i > 0 && ", "}
              <span className="mono">{f.path}</span> ({f.message})
            </span>
          ))}
          {meta.readFailureCount > meta.readFailures.length && (
            <>
              , and {(meta.readFailureCount - meta.readFailures.length).toLocaleString()}{" "}
              more
            </>
          )}
          . Every figure here, and every run&rsquo;s budget guard, is short by
          whatever those hold.
        </Notice>
      )}

      {/* Shown only while it is true, unlike the blind-spot notice below: this
          one is a state an operator can act on, and it says which way the
          trade went — correctness kept, refresh cost paid. */}
      {page === "usage" && meta.memory.cache.evictions > 0 && (
        <Notice quiet>
          <strong>Transcript cache at its bound.</strong>{" "}
          <span className="tabular-nums">
            {meta.memory.cache.evictions.toLocaleString()}
          </span>{" "}
          {meta.memory.cache.evictions === 1 ? "file has" : "files have"} been
          dropped from memory and are re-read from disk on every scan. Figures
          here are unaffected; each refresh costs more. Raise{" "}
          <span className="mono">UF_TRANSCRIPT_CACHE_MAX_ENTRIES</span> — and the
          heap behind it — or keep less history under{" "}
          <span className="mono">CLAUDE_HOME</span>.
        </Notice>
      )}
    </>
  );
}
