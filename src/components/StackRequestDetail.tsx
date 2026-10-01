"use client";

import Link from "next/link";
import type { StackRequestDTO } from "@/lib/apiTypes";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { STATUS_LABEL } from "@/lib/format";

type AttachedRun = StackRequestDTO["runs"][number];

/**
 * One `request_stack` request, as the operator answers it.
 *
 * Two answers, and only one of them is a control. Installing is a `stack.json`
 * on the host and a restart, which nothing in this app may do, so it is a
 * sentence naming the path; declining is the button. An install button here
 * would be the app writing a declaration a model drafted.
 *
 * Every string a model wrote is drawn as React text and nothing else — no
 * markup, no markdown, no `href` built from it. `reason` and `draft` are
 * unvalidated, and this is the screen where the operator decides whether to
 * trust them.
 */
export function StackRequestDetail({
  request,
  runId,
  onDecline,
  declining = false,
}: {
  request: StackRequestDTO;
  /**
   * The run whose page this is: only its own reason is drawn. Absent, every run
   * still waiting on the request is listed with a link to it.
   */
  runId?: string;
  onDecline?: () => void;
  declining?: boolean;
}) {
  const waiting = request.runs.filter((run) => run.releasedAt === null);
  const own = runId === undefined ? undefined : request.runs.find((run) => run.runId === runId);
  // Not offered once the stack is installed: a decline outranks an install in
  // `decideStackWait`, so pressing it would tell the agent to do without a
  // command that is already on its PATH.
  const declinable =
    onDecline !== undefined &&
    request.state === "pending" &&
    request.receipt.kind !== "installed";

  return (
    <div className="min-w-0 text-xs text-ink-muted">
      <p className="text-ink">
        <span className="mono text-sm font-semibold">{request.name}</span>{" "}
        <span className="text-ink-muted">for</span>{" "}
        <span className="mono">{request.binaries.join(", ")}</span>
      </p>

      {runId !== undefined ? (
        own && <Reason text={own.reason} />
      ) : waiting.length === 0 ? (
        <p className="mt-1">No run is waiting on it now.</p>
      ) : (
        <ul className="mt-1.5 space-y-2">
          {waiting.map((run) => (
            <li key={run.runId}>
              <RunTag run={run} />
              <Reason text={run.reason} />
            </li>
          ))}
        </ul>
      )}

      <Answer request={request} />

      {declinable && (
        <ButtonRow className="mt-2.5">
          <Button variant="secondary" busy={declining} onClick={onDecline}>
            Decline
          </Button>
          <span>Every run waiting on it is told to carry on without it</span>
        </ButtonRow>
      )}
    </div>
  );
}

function RunTag({ run }: { run: AttachedRun }) {
  // A run no longer on record is named and not linked: its page is a 404.
  if (run.status === null) {
    return (
      <p>
        <span className="mono">{run.runId.slice(0, 8)}</span> no longer on record
      </p>
    );
  }
  return (
    <p>
      <Link className="mono" href={`/runs/${run.runId}`}>
        {run.runId.slice(0, 8)}
      </Link>{" "}
      {STATUS_LABEL[run.status]}
    </p>
  );
}

/**
 * The agent's own words, ruled off as a quote so they never read as this app
 * speaking. `[overflow-wrap:anywhere]` rather than `break-words` because only
 * `anywhere` shortens a min-content measurement, and one unbroken URL in a
 * reason is otherwise a floor under every column it sits in.
 */
function Reason({ text }: { text: string }) {
  return (
    <p className="mt-1 whitespace-pre-wrap border-l-2 border-l-line-strong pl-2 text-ink [overflow-wrap:anywhere]">
      {text}
    </p>
  );
}

/** Where the request stands, and the one next step that state has. */
function Answer({ request }: { request: StackRequestDTO }) {
  if (request.state === "declined") {
    return (
      <p className="mt-2">
        Declined. Every run waiting on it rejoins the queue on the next sweep.
      </p>
    );
  }
  if (request.receipt.kind === "installed") {
    return (
      <p className="mt-2">
        Installed at the last boot; a run waiting on nothing else resumes on the
        next sweep.
      </p>
    );
  }
  return (
    <>
      {request.receipt.kind === "failed" ? (
        <Notice tone="warn" className="mt-2">
          <strong>
            The <code>stack.json</code> for {request.name} failed at the last boot.
          </strong>{" "}
          Fixing it and restarting the container is the next step.
          <span className="mt-1 block [overflow-wrap:anywhere]">{request.receipt.reason}</span>
        </Notice>
      ) : (
        <p className="mt-2">
          To install it, put a <code>stack.json</code> at{" "}
          <code className="[overflow-wrap:anywhere]">{request.hostPath}</code> beside{" "}
          <code>docker-compose.yml</code>, or at <code>{request.name}/stack.json</code>{" "}
          under <code>UF_STACKS_DIR</code> if you set one. Read it, then run{" "}
          <code>docker compose restart</code>.
        </p>
      )}
      {request.draft !== null && (
        <Draft name={request.name} draft={request.draft} verdict={request.draftVerdict} />
      )}
    </>
  );
}

function Draft({
  name,
  draft,
  verdict,
}: {
  name: string;
  draft: string;
  verdict: StackRequestDTO["draftVerdict"];
}) {
  return (
    <div className="mt-2">
      <p>
        The agent&rsquo;s suggested <code>stack.json</code>: read every URL and
        digest in it before you use any of it.
      </p>
      {/* Unwrapped so a digest reads as one line, in its own scroll box with
          `contain-inline-size` so that line can never widen the pane; focusable
          for the run page's Task box's reason — a keyboard has to scroll it. */}
      <div
        tabIndex={0}
        role="group"
        aria-label={`Draft stack.json for ${name}`}
        className="mt-1.5 max-w-full overflow-x-auto contain-inline-size rounded-sm border border-line bg-inset"
      >
        <pre className="mono w-max min-w-full whitespace-pre p-2.5 text-2xs leading-relaxed text-ink-muted">
          {draft}
        </pre>
      </div>
      {verdict && (
        <p className={`mt-1.5 [overflow-wrap:anywhere] ${verdict.kind === "refused" ? "text-warn" : ""}`}>
          {verdict.kind === "accepted"
            ? "The boot's format check would accept this draft."
            : verdict.kind === "refused"
              ? `The boot's format check would refuse this draft: ${verdict.reason}`
              : `This draft could not be checked here: ${verdict.reason}`}
        </p>
      )}
    </div>
  );
}
