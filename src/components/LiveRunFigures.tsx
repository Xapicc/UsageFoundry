// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a tested component has to import the
// way src/lib and LiveTelemetry.tsx already do.
import { providerReportsSpend, type LiveRunDTO } from "../lib/apiTypes";
import { fmtBankedTokens, fmtTokens, fmtUSD, runTokenFigures } from "../lib/format";
import { Stat } from "./ui/Card";

const SUB = "mt-0.5 text-xs tabular-nums text-ink-muted";

/**
 * A running run's two money figures on its `/runs/live` tile: what its finished
 * cycles reported, and what Claude Code's own telemetry has counted of the cycle
 * in flight.
 *
 * **Two figures, never a sum.** They are two instruments — a cost per finished
 * cycle from the CLI's `result` event, and a cost per request from its OTLP
 * export since the cycle in flight started — and telemetry exists only when a
 * setting or a mid-cycle guard asks for it, so a total would change meaning
 * from one tile to the next with nothing on the tile saying so.
 * `LiveTelemetry.tsx` records why the app never folds a telemetry reading into
 * another.
 *
 * **No telemetry is a dash with words under it, never `$0.00`.** Most runs
 * export none, and a zero would say a cycle has cost nothing when nothing was
 * measured — `metering.md`'s first rule. Spent gets the run page's dash for a
 * provider that reports no cost, on the same rule.
 */
export function LiveRunFigures({
  run,
}: {
  run: Pick<
    LiveRunDTO,
    | "provider"
    | "spent_usd"
    | "cycleTelemetry"
    | "spent_tokens"
    | "spent_tokens_est"
    | "cycleCodex"
  >;
}) {
  if (run.provider === "codex") return <CodexFigures run={run} />;
  const reportsSpend = providerReportsSpend(run.provider);
  const telemetry = run.cycleTelemetry;
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="min-w-0">
        <div className="text-xs font-semibold text-ink">Spent</div>
        <Stat>{reportsSpend ? fmtUSD(run.spent_usd) : "—"}</Stat>
        <div className={SUB}>
          {reportsSpend ? "finished cycles" : "provider reports no cost"}
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-xs font-semibold text-ink">Telemetry — first-party</div>
        {telemetry ? (
          <>
            <Stat>{fmtUSD(telemetry.costUSD)}</Stat>
            <div className={SUB}>
              this cycle · {fmtTokens(telemetry.tokens)} tokens
            </div>
          </>
        ) : (
          <>
            <Stat>—</Stat>
            <div className={SUB}>none reported this cycle</div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The same two figures for a Codex run, in tokens: what its finished cycles
 * used, and what its cycle in flight has used so far by its session file. A
 * finished cycle that never reported is counted from its session file too, and
 * the tile says how many tokens that is. Codex reports no cost, so there is no money to show and
 * none is derived; the cycle figure is a dash until something has been read.
 */
function CodexFigures({
  run,
}: {
  run: Pick<
    LiveRunDTO,
    "provider" | "spent_tokens" | "spent_tokens_est" | "cycleCodex"
  >;
}) {
  const cycle = run.cycleCodex;
  // What the token limit counts, not what Codex reported: a cycle cut short
  // reports nothing, and the tile would read under the limit that ended it.
  const tokens = runTokenFigures(run);
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="min-w-0">
        <div className="text-xs font-semibold text-ink">Tokens used</div>
        <Stat>{fmtTokens(tokens.counted)}</Stat>
        <div className={SUB}>finished cycles · no cost reported</div>
        {tokens.banked > 0 && <div className={SUB}>{fmtBankedTokens(tokens.banked)}</div>}
      </div>
      <div className="min-w-0">
        <div className="text-xs font-semibold text-ink">This cycle — Codex</div>
        {cycle ? (
          <>
            <Stat>{fmtTokens(cycle.tokens)}</Stat>
            <div className={SUB}>
              {cycle.requests} {cycle.requests === 1 ? "request" : "requests"} so far
            </div>
          </>
        ) : (
          <>
            <Stat>—</Stat>
            <div className={SUB}>none read this cycle</div>
          </>
        )}
      </div>
    </div>
  );
}
