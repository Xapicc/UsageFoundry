"use client";

import { useEffect, useState } from "react";
import type {
  HoldoutArmDTO,
  HoldoutInterferenceDTO,
  HoldoutLeftOutReason,
  HoldoutLookDTO,
  HoldoutLookVerdict,
  HoldoutReadbackDTO,
  HoldoutTargetDTO,
} from "@/lib/apiTypes";
import { endingLabel, fmtDateTime, fmtPct, fmtUSD, pollFailureMessage } from "@/lib/format";
import { Card, CardTitle, Empty, Subsection } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { ListView, STICKY_HEAD_FLAT } from "@/components/ui/ListView";
import { Notice } from "@/components/ui/Notice";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/Table";

/**
 * The prior-read pointer's holdout, read back: three questions, one section
 * each, sharing no figure and no verdict.
 *
 * What the copy has to keep saying, because each is a way of reading this
 * wrongly:
 *
 *   - **Compliance is not effect.** A run opens many of the files a list names
 *     whatever any list said; the held-out arm's share is that baseline, and
 *     only the gap between the two is the pointer's.
 *   - **No interval is a verdict before its sample size.** Each section says
 *     how many each arm needs and how many the smaller one has.
 *   - **Spend has one source.** It is named, and nothing else is added to it.
 *   - **Reloading is not a look.** The primary is called only at two looks, each
 *     fixed at the runs there were when the smaller arm reached its size, so the
 *     card says what a figure to date is: descriptive.
 *
 * Loaded once and never polled, `RepoReadingCards`' choice: the figures move
 * when a run ends and the export that feeds them runs every six hours.
 */
export function HoldoutReadbackCard() {
  const [data, setData] = useState<HoldoutReadbackDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/holdout-readback", { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as Partial<
          HoldoutReadbackDTO & { error: string }
        >;
        if (!live) return;
        if (!res.ok || !json.population) {
          setError(
            pollFailureMessage(
              res.status,
              json.error ?? (res.ok ? "no readback in the response" : null),
            ),
          );
          return;
        }
        setData(json as HoldoutReadbackDTO);
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
        <Empty>Reading the holdout…</Empty>
      </Card>
    );
  }
  return <Readback data={data} />;
}

const ARM_LABEL: Record<HoldoutArmDTO, string> = {
  pointer: "Pointer",
  holdout: "Held out",
};
const ARMS: readonly HoldoutArmDTO[] = ["pointer", "holdout"];

const LEFT_OUT_LABEL: Record<HoldoutLeftOutReason, string> = {
  "arm-derived": "Arm recomputed, never logged",
  "earlier-list": "Dealt the earlier rolling list",
  continuation: "Continues another run",
  unsettled: "Still running",
  "nothing-to-show": "No file to name",
};

function Readback({ data }: { data: HoldoutReadbackDTO }) {
  const { population, compliance, displacement, outcome, interference } = data;
  const read = population.read.pointer + population.read.holdout;
  const leftOut = population.leftOut.filter((l) => l.pointer + l.holdout > 0);
  return (
    <Card emphasis="quiet" className="mb-4">
      <CardTitle>Pointer against holdout</CardTitle>
      <p className="max-w-[72ch] text-sm text-ink">
        {read === 0
          ? "No run has been read yet."
          : `${population.read.pointer} pointer and ${population.read.holdout} held-out runs, each with a list to name.`}{" "}
        {data.exportedAt === null
          ? "The export has not run."
          : `Exported ${fmtDateTime(data.exportedAt)}; a run that ended since is not here.`}
      </p>
      {leftOut.length > 0 && (
        <Disclosure className="mt-1 text-xs text-ink-muted" summary="Runs left out">
          <ListView box="capped" className="mt-2">
            <Table stack>
              <caption className="sr-only">Runs the pointer considered and this reading left out</caption>
              <THead>
                <tr>
                  <Th className={STICKY_HEAD_FLAT}>Reason</Th>
                  <Th num className={STICKY_HEAD_FLAT}>
                    Pointer
                  </Th>
                  <Th num className={STICKY_HEAD_FLAT}>
                    Held out
                  </Th>
                </tr>
              </THead>
              <TBody>
                {leftOut.map((l) => (
                  <Tr key={l.reason}>
                    <Td>{LEFT_OUT_LABEL[l.reason]}</Td>
                    <Td num label="Pointer">
                      {l.pointer}
                    </Td>
                    <Td num label="Held out">
                      {l.holdout}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </ListView>
        </Disclosure>
      )}

      <Subsection title="Compliance: did the run open a file on its list">
        <Grid
          caption="Files on the list, opened at or after the cycle began"
          columns={["Runs", "Pairs", "Opened", "Share"]}
          rows={ARMS.map((arm) => [
            ARM_LABEL[arm],
            compliance[arm].runs,
            compliance[arm].pairs,
            compliance[arm].opened,
            fmtPct(compliance[arm].share),
          ])}
        />
        <p className="mt-2 max-w-[72ch] text-sm text-ink">
          Pointer minus held out:{" "}
          {interval(compliance.difference, compliance.low, compliance.high, POINTS)}
        </p>
        <Sample
          targets={compliance.targets}
          have={Math.min(compliance.pointer.pairs, compliance.holdout.pairs)}
        />
        <p className="mt-1 max-w-[72ch] text-xs text-ink-muted">
          The held-out share is how often a run opens these files with no list, so it
          is the baseline and the gap is the pointer’s. A pair is one file on one
          cycle’s list.
          {compliance.briefNamedPairs.pointer + compliance.briefNamedPairs.holdout > 0 &&
            ` ${compliance.briefNamedPairs.pointer + compliance.briefNamedPairs.holdout} pairs are left out because the task named the file.`}
          {compliance.unlistedCycles.pointer + compliance.unlistedCycles.holdout > 0 &&
            ` ${compliance.unlistedCycles.pointer + compliance.unlistedCycles.holdout} cycles are left out because their list was not logged.`}
        </p>
      </Subsection>

      <Subsection title="Displacement: did the run read less">
        <Grid
          caption="Distinct files the main thread read, per run"
          columns={["Runs", "Before first edit", "In the run"]}
          rows={ARMS.map((arm) => [
            ARM_LABEL[arm],
            displacement.beforeEdit[arm].n,
            meanText(displacement.beforeEdit[arm].mean, 1),
            meanText(displacement.wholeRun[arm].mean, 1),
          ])}
        />
        <p className="mt-2 max-w-[72ch] text-sm text-ink">
          Before the first edit, pointer minus held out:{" "}
          {interval(displacement.beforeEdit.difference, displacement.beforeEdit.low, displacement.beforeEdit.high, FILES)}
        </p>
        <p className="max-w-[72ch] text-sm text-ink">
          In the whole run:{" "}
          {interval(displacement.wholeRun.difference, displacement.wholeRun.low, displacement.wholeRun.high, FILES)}
        </p>
        <Sample
          targets={displacement.targets}
          have={Math.min(population.read.pointer, population.read.holdout)}
        />
        <p className="mt-1 max-w-[72ch] text-xs text-ink-muted">
          Counted the same in both arms, so naming twenty files cannot lower it. A run
          that never edits has read everything “before its first edit”:{" "}
          {displacement.neverEdited.pointer} pointer and {displacement.neverEdited.holdout} held-out
          runs.
        </p>
      </Subsection>

      <Subsection title="Primary: files read in the run, by repository">
        <Primary primary={displacement.primary} />
      </Subsection>

      <Subsection title="Interference: does the held-out arm move with the runs around it">
        <Interference rows={interference} />
      </Subsection>

      <Subsection title="Outcome: did the run end differently">
        <Grid
          caption="Per run, by arm"
          columns={["Runs", "Reached a second cycle", "Spend"]}
          rows={ARMS.map((arm) => [
            ARM_LABEL[arm],
            outcome.secondCycle[arm].n,
            fmtPct(outcome.secondCycle[arm].mean),
            outcome.spend[arm].mean === null ? "—" : fmtUSD(outcome.spend[arm].mean),
          ])}
        />
        <p className="mt-2 max-w-[72ch] text-sm text-ink">
          Reaching a second cycle, pointer minus held out:{" "}
          {interval(outcome.secondCycle.difference, outcome.secondCycle.low, outcome.secondCycle.high, POINTS)}
        </p>
        <Sample
          targets={outcome.secondCycleTargets}
          have={Math.min(population.read.pointer, population.read.holdout)}
        />
        <p className="mt-2 max-w-[72ch] text-sm text-ink">
          Spend per run:{" "}
          {interval(outcome.spend.difference, outcome.spend.low, outcome.spend.high, USD)}
        </p>
        <Sample
          targets={outcome.spendTargets}
          have={Math.min(population.read.pointer, population.read.holdout)}
        />
        <p className="mt-1 max-w-[72ch] text-xs text-ink-muted">
          Spend is <span className="mono">runs.spent_usd</span>, the cost the CLI reported
          per cycle. It leaves out a cycle killed before it reported, and no transcript
          or telemetry figure is added to it.
        </p>
        {outcome.endings.length > 0 && (
          <ListView box="capped" className="mt-2">
            <Table stack>
              <caption className="sr-only">How the runs ended, by arm</caption>
              <THead>
                <tr>
                  <Th className={STICKY_HEAD_FLAT}>Ending</Th>
                  <Th num className={STICKY_HEAD_FLAT}>
                    Pointer
                  </Th>
                  <Th num className={STICKY_HEAD_FLAT}>
                    Held out
                  </Th>
                </tr>
              </THead>
              <TBody>
                {outcome.endings.map((e) => (
                  <Tr key={e.code ?? "unrecorded"}>
                    <Td>{e.code === null ? "Not recorded" : (endingLabel(e.code) ?? e.code)}</Td>
                    <Td num label="Pointer">
                      {e.pointer}
                    </Td>
                    <Td num label="Held out">
                      {e.holdout}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </ListView>
        )}
      </Subsection>

      <p className="mt-3 max-w-[72ch] text-xs text-ink-muted">
        Intervals are approximate 95%; only the primary is stratified by repository.
        Nothing here is a limit.
      </p>
    </Card>
  );
}

const VERDICT_TEXT: Record<HoldoutLookVerdict, string> = {
  "before-interim": "Nothing is called before the interim look.",
  continue: "The interim boundary was not crossed. The final look decides; figures before it are descriptive.",
  "difference-at-interim":
    "The interim boundary was crossed: the arms differ. The test ends there, and later figures are descriptive.",
  "difference-at-final": "The final boundary was crossed: the arms differ.",
  "none-at-final": "Neither boundary was crossed: no difference was found at the planned size.",
};

function Primary({ primary }: { primary: HoldoutReadbackDTO["displacement"]["primary"] }) {
  const { estimate, permutation, looks, verdict } = primary;
  const setAside = estimate.setAside;
  return (
    <>
      <p className="max-w-[72ch] text-sm text-ink">
        To date, pointer minus held out (descriptive):{" "}
        {interval(estimate.difference, estimate.low, estimate.high, FILES)}
      </p>
      <p className="max-w-[72ch] text-sm text-ink">
        Permutation p-value:{" "}
        {permutation.p === null
          ? "no repository with two runs in each arm"
          : `${pText(permutation.p)}, over ${permutation.assignments.toLocaleString()} ${permutation.exact ? "arm assignments, all of them" : "re-dealt arm assignments"}`}
      </p>
      <ListView box="capped" className="mt-2">
        <Table stack>
          <caption className="sr-only">The two looks, each at the runs there were when the smaller arm reached its size</caption>
          <THead>
            <tr>
              <Th className={STICKY_HEAD_FLAT}>Look</Th>
              <Th num className={STICKY_HEAD_FLAT}>
                Each arm needs
              </Th>
              <Th num className={STICKY_HEAD_FLAT}>
                z
              </Th>
              <Th num className={STICKY_HEAD_FLAT}>
                Boundary
              </Th>
              <Th className={STICKY_HEAD_FLAT}>Result</Th>
            </tr>
          </THead>
          <TBody>
            {looks.map((look) => (
              <Tr key={look.stage}>
                <Td>{look.stage === "interim" ? "Interim" : "Final"}</Td>
                <Td num label="Each arm needs">
                  {look.perArm.toLocaleString()}
                </Td>
                <Td num label="z">
                  {look.z === null ? "—" : signed(look.z, Math.abs(look.z).toFixed(2))}
                </Td>
                <Td num label="Boundary">
                  ±{look.boundary}
                </Td>
                <Td label="Result">{lookResult(look)}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </ListView>
      <p className="mt-2 max-w-[72ch] text-sm text-ink">{VERDICT_TEXT[verdict]}</p>
      <p className="mt-1 max-w-[72ch] text-xs text-ink-muted">
        A look is the runs there were when the smaller arm first held its size, so
        reloading this card is not another look. Each repository is weighted by its
        runs.
        {setAside > 0 &&
          ` ${setAside} runs are left out of it because one arm held fewer than two runs in their repository.`}
      </p>
    </>
  );
}

function lookResult(look: HoldoutLookDTO): string {
  if (look.crossed === null) {
    return `Waiting: the smaller arm holds ${Math.min(look.runs.pointer, look.runs.holdout).toLocaleString()}`;
  }
  const crossed = look.crossed ? "Crossed" : "Not crossed";
  return `${crossed}, at ${look.runs.pointer.toLocaleString()} pointer and ${look.runs.holdout.toLocaleString()} held-out runs`;
}

const EXPOSURE_LABEL: Record<HoldoutInterferenceDTO["exposure"], string> = {
  preceding: "The hundred runs before it",
  overlapping: "Runs alive alongside it",
  live: "Runs live when it started",
};

function Interference({ rows }: { rows: HoldoutInterferenceDTO[] }) {
  const spread = rows.find((r) => r.exposure === "preceding")?.exposureSd ?? null;
  return (
    <>
      <ListView box="capped">
        <Table stack>
          <caption className="sr-only">Held-out runs' reading against the treated share of the runs around them</caption>
          <THead>
            <tr>
              <Th className={STICKY_HEAD_FLAT}>Runs around it</Th>
              <Th num className={STICKY_HEAD_FLAT}>
                Held-out runs
              </Th>
              <Th className={STICKY_HEAD_FLAT}>Files per 10 points more treated</Th>
              <Th num className={STICKY_HEAD_FLAT}>
                p
              </Th>
            </tr>
          </THead>
          <TBody>
            {rows.map((row) => (
              <Tr key={row.exposure}>
                <Td>{EXPOSURE_LABEL[row.exposure]}</Td>
                <Td num label="Held-out runs">
                  {row.runs.toLocaleString()}
                </Td>
                <Td label="Files per 10 points more treated">
                  {row.slope === null || row.low === null || row.high === null
                    ? "no exposure to compare"
                    : interval(row.slope / 10, row.low / 10, row.high / 10, FILES)}
                </Td>
                <Td num label="p">
                  {row.p === null ? "—" : pText(row.p)}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </ListView>
      <p className="mt-1 max-w-[72ch] text-xs text-ink-muted">
        A slope away from zero would mean something a pointer run left behind reached a
        run that never saw the list.
        {spread !== null &&
          ` The treated share of the hundred before a run varies by only ${(spread * 100).toFixed(1)} points within a repository, so a wide interval is no evidence of no leak.`}{" "}
        Re-dealt {rows[0]?.draws.toLocaleString() ?? 0} times by the real assignment rule.
      </p>
    </>
  );
}

function pText(p: number): string {
  return p < 0.001 ? "< 0.001" : p.toFixed(3);
}

function Grid({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: Array<Array<string | number>>;
}) {
  return (
    <ListView box="capped">
      <Table stack>
        <caption className="sr-only">{caption}</caption>
        <THead>
          <tr>
            <Th className={STICKY_HEAD_FLAT}>Arm</Th>
            {columns.map((c) => (
              <Th key={c} num className={STICKY_HEAD_FLAT}>
                {c}
              </Th>
            ))}
          </tr>
        </THead>
        <TBody>
          {rows.map((row) => (
            <Tr key={row[0]}>
              <Td>{row[0]}</Td>
              {columns.map((c, i) => (
                <Td key={c} num label={c}>
                  {typeof row[i + 1] === "number" ? (row[i + 1] as number).toLocaleString() : row[i + 1]}
                </Td>
              ))}
            </Tr>
          ))}
        </TBody>
      </Table>
    </ListView>
  );
}

/**
 * What the sample can support, in the proposal's own sizes. Present whether or
 * not it is reached: a card that stops saying so the day the first size is met
 * has told its reader that a wide interval is now a finding.
 */
function Sample({ targets, have }: { targets: HoldoutTargetDTO[]; have: number }) {
  const first = targets[0];
  if (!first) return null;
  const next = targets.find((t) => !t.reached);
  return (
    <p className="max-w-[72ch] text-xs text-ink-muted">
      {first.reached
        ? `Each arm holds ${first.perArm.toLocaleString()} ${first.unit}, the size priced for ${first.effect}.`
        : `Not significant until each arm holds ${first.perArm.toLocaleString()} ${first.unit}, the size priced for ${first.effect}. The smaller arm holds ${have.toLocaleString()}.`}
      {first.reached &&
        next &&
        ` A smaller effect needs ${next.perArm.toLocaleString()} (${next.effect}).`}
    </p>
  );
}

function signed(value: number, text: string): string {
  return `${value < 0 ? "−" : "+"}${text}`;
}

interface Unit {
  /** One number, without its unit when the unit follows it. */
  format: (magnitude: number) => string;
  /** Said once, after the difference: " points", " files". */
  suffix: string;
}

const POINTS: Unit = { format: (v) => (Math.abs(v) * 100).toFixed(1), suffix: " points" };
const FILES: Unit = { format: (v) => Math.abs(v).toFixed(1), suffix: " files" };
const USD: Unit = { format: (v) => fmtUSD(Math.abs(v)), suffix: "" };

function interval(
  difference: number | null,
  low: number | null,
  high: number | null,
  unit: Unit,
): string {
  if (difference === null || low === null || high === null) {
    return "not enough runs in one arm to compare";
  }
  return `${signed(difference, unit.format(difference))}${unit.suffix} (95%: ${signed(low, unit.format(low))} to ${signed(high, unit.format(high))})`;
}

function meanText(mean: number | null, digits: number): string {
  return mean === null ? "—" : mean.toFixed(digits);
}
