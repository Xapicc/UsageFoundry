"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import type { StackDetailDTO, StackReceiptDTO } from "@/lib/apiTypes";
import { fmtBytes, type BadgeTone } from "@/lib/format";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { ListGroup, ListRow } from "@/components/ui/List";
import { Badge } from "@/components/ui/Badge";
import { Notice } from "@/components/ui/Notice";

/**
 * One stack's receipt, in full.
 *
 * A sub-route under Settings rather than an expander in the Tools section, and
 * rather than a tenth pane. `docs/agent/ui-density-audit.md:159-162` bans the
 * pane and names the replacement in the same sentence — *"New destinations are
 * sub-routes under an existing pane"* — and `01e-` §2.1 is what rules out the
 * expander: a receipt carries the last 4 KB of a failing step's stderr, and a
 * row that can hold 4 KB has stopped being a row. `activePane` matches on a
 * path segment, so this keeps Settings lit in the sidebar without any reader of
 * `panes.ts` learning the route exists.
 *
 * **Never filled from the list row.** The Tools section links here and passes
 * nothing; this fetches the receipt itself. That is load-bearing rather than
 * stylistic — the list deliberately does not carry the stderr, the per-step
 * detail or the exported environment, so a page seeded from a row would draw a
 * stack whose failure text was simply absent.
 *
 * **Fetched once and never polled.** A receipt is written by the applier in the
 * one window of the container's life with no agent process alive, so its answer
 * cannot change while this page is open. What changes it is a restart, which
 * takes the page with it.
 */

type Ctx = { params: Promise<{ name: string }> };

const STATUS_TONE: Record<StackReceiptDTO["status"], BadgeTone> = {
  ok: "ok",
  failed: "danger",
  conflicted: "warn",
};

export default function StackDetailPage({ params }: Ctx) {
  const { name } = use(params);
  const [detail, setDetail] = useState<StackDetailDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch(`/api/stacks/${encodeURIComponent(name)}`, { cache: "no-store" });
        const json = (await res.json()) as StackDetailDTO & { error?: string };
        if (!live) return;
        if (!res.ok) {
          setError(json.error ?? `The receipt could not be read (HTTP ${res.status}).`);
          return;
        }
        setDetail(json);
      } catch (err) {
        if (!live) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [name]);

  return (
    <>
      <h1 className="mb-1 font-mono text-xl font-semibold tracking-tight">{name}</h1>
      <p className="mb-4 text-sm text-ink-muted">
        What the applier did with this stack on the last boot.{" "}
        <Link href="/settings#tools">Back to Tools</Link> for every tool on this install.
      </p>

      {error && (
        <Notice tone="danger">
          <strong>The receipt could not be read.</strong> {error}
        </Notice>
      )}

      {!detail && !error && (
        <Card>
          <Empty>
            <span aria-busy="true">Reading the receipt…</span>
          </Empty>
        </Card>
      )}

      {/* The two ways of having nothing, kept apart: a name no receipt claims
          is an operator looking at a stack that is not declared, and a receipt
          this build cannot read is a boot that was killed part-way through.
          The fix differs and one of them fixes itself on the next restart. */}
      {detail?.absence?.kind === "missing" && (
        <Card>
          <Empty>{detail.absence.reason}.</Empty>
        </Card>
      )}

      {detail?.absence?.kind === "unreadable" && (
        <Notice tone="warn">
          <strong>There is a receipt here and it is not one this app can read.</strong>{" "}
          {detail.absence.reason}.
        </Notice>
      )}

      {detail?.receipt && <Receipt receipt={detail.receipt} detail={detail} />}

      {detail && <Removing detail={detail} />}
    </>
  );
}

/**
 * What happens if the operator deletes the directory, said before they do it.
 *
 * There is no button here and there is not going to be one: `/api/settings` is
 * reachable with the master key, and a control that installs software is a
 * control that installs software for anyone holding it (`01e-` §7). Removing is
 * `rm -r` and a restart. The app's whole part is to say the one thing an
 * operator cannot see from the host — that `state/<name>` goes with the stack.
 *
 * **The host path is a hedge and is marked as one.** The container knows where
 * it read the declaration; the host directory is `UF_STACKS_DIR`'s compose
 * interpolation, which never enters the container's environment and must not be
 * forwarded into it — `deployment.test.ts` asserts that the `environment:` block
 * carries every variable the entrypoint reads *and nothing else*. So this prints
 * the container path it knows and names the default beside it, which is right
 * for every install that did not set the variable and honest for the ones that
 * did.
 */
function Removing({ detail }: { detail: StackDetailDTO }) {
  return (
    <Card>
      <CardTitle>Removing it</CardTitle>
      <p className="mb-3 max-w-[70ch] text-sm text-ink">
        Delete the directory and restart. The applier removes only paths its own receipt records, so
        anything you put in the toolbox by hand stays where it is.
      </p>
      <ListGroup
        footnote={
          <>
            Bind-mounted read-only from the host — <code>./stacks/{detail.name}</code> beside your{" "}
            <code>docker-compose.yml</code>, unless you set <code>UF_STACKS_DIR</code>, which this
            container cannot see.
          </>
        }
      >
        <ListRow label="Read from">
          <span className="break-all font-mono text-2xs text-ink-muted">{detail.declaredAt}</span>
        </ListRow>
        <ListRow
          label="Destroyed with it"
          description={
            <>
              <span className="block break-all font-mono text-2xs">{detail.stateDir}</span>
              <span className="block">
                {detail.stateBytes === null
                  ? "Nothing walked it, which is not the same as it being empty"
                  : "A provider cache is a re-download; anything else is gone"}
              </span>
            </>
          }
        >
          <span className="text-sm text-ink-muted">
            {detail.stateBytes === null ? "not measured" : fmtBytes(detail.stateBytes)}
          </span>
        </ListRow>
      </ListGroup>
    </Card>
  );
}

function Receipt({ receipt, detail }: { receipt: StackReceiptDTO; detail: StackDetailDTO }) {
  const applied = receipt.appliedAt ? new Date(receipt.appliedAt) : null;
  return (
    <>
      <Card className="mb-4">
        <CardTitle>
          What happened
          <Badge tone={STATUS_TONE[receipt.status]}>{receipt.status}</Badge>
        </CardTitle>
        {receipt.summary && <p className="mb-3 max-w-[70ch] text-sm text-ink">{receipt.summary}</p>}
        <ListGroup
          footnote={
            // The digest is what a reinstall turns on, and saying so is what
            // makes the field act on rather than decorative: an operator who
            // edited stack.json and sees the same digest is looking at a boot
            // that did not read their edit.
            "The digest is sha256 over the whole stack.json. A boot compares it with the one recorded here and reinstalls when they differ, so an unchanged digest after an edit means the file the container read is not the file you changed"
          }
        >
          <ListRow label="Applied">
            <span className="text-sm text-ink-muted">
              {applied ? applied.toLocaleString() : "the receipt carries no timestamp"}
            </span>
          </ListRow>
          <ListRow label="Digest">
            <span className="break-all font-mono text-2xs text-ink-muted">{receipt.digest}</span>
          </ListRow>
        </ListGroup>
      </Card>

      {receipt.error && (
        <Card className="mb-4">
          <CardTitle>
            {receipt.status === "ok" ? "What the applier declined to do" : "What the step said"}
          </CardTitle>
          <pre className="mono max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-line bg-inset p-2.5 text-2xs leading-relaxed text-ink-muted">
            {receipt.error.text}
          </pre>
          {/* The byte count beside the text rather than instead of it: a
              truncated message that does not say it is truncated is a
              plausible number that is quietly a fraction of the real one. */}
          {receipt.error.bytes > receipt.error.text.length && (
            <p className="mt-1.5 text-xs text-ink-muted">
              The last {receipt.error.text.length.toLocaleString()} of{" "}
              {receipt.error.bytes.toLocaleString()} bytes. The rest was in the boot log, which the
              restart that wrote this receipt destroyed.
            </p>
          )}
        </Card>
      )}

      <Card className="mb-4">
        <CardTitle>Install</CardTitle>
        {receipt.steps.length === 0 ? (
          <Empty>
            No step ran. A stack refused at parse, one that lost a binary name to another stack, and
            one the applier never reached all record the reason above rather than a step.
          </Empty>
        ) : (
          <ListGroup footnote="Steps run in the order they are written and the first failure ends the stack, so a step after a failed one did not run rather than passing">
            {receipt.steps.map((step, i) => (
              <ListRow
                key={`${step.kind}:${i}`}
                label={<span className="font-mono text-xs">{step.kind}</span>}
                description={step.detail}
              >
                <Badge tone={step.status === "ok" ? "ok" : "danger"}>{step.status}</Badge>
              </ListRow>
            ))}
          </ListGroup>
        )}
      </Card>

      <Card className="mb-4">
        <CardTitle>What it put on PATH</CardTitle>
        {receipt.bin.length === 0 ? (
          <Empty>
            Nothing is linked. No binary from a failed stack reaches PATH — the applier removes the
            tree rather than leaving half of it there.
          </Empty>
        ) : (
          <ListGroup footnote="Root-owned, in a directory no agent can write, which is why an agent cannot upgrade a stack tool: upgrading is an operator act and it is an edit to stack.json">
            {receipt.bin.map((entry) => (
              <ListRow
                key={entry.name}
                label={<span className="font-mono text-xs">{entry.name}</span>}
                description={<span className="font-mono text-2xs">{entry.path}</span>}
              >
                <Badge tone="neutral">linked</Badge>
              </ListRow>
            ))}
          </ListGroup>
        )}
      </Card>

      <Card className="mb-4">
        <CardTitle>What a work cycle may not run</CardTitle>
        {receipt.deny.length === 0 ? (
          <Empty>
            Nothing is denied. Every command of every binary above is granted, which is what a stack
            with no <code>deny</code> asks for.
          </Empty>
        ) : (
          <ListGroup footnote="A prefix, and deny beats every grant — so these refuse inside a tool call whatever mode the run is in. A stack may only deny commands of binaries it links, which is checked when the file is read">
            {receipt.deny.map((entry) => (
              <ListRow key={entry} label={<span className="font-mono text-xs">{entry}</span>}>
                <Badge tone="warn">denied</Badge>
              </ListRow>
            ))}
          </ListGroup>
        )}
      </Card>

      {(Object.keys(receipt.env).length > 0 || receipt.state.length > 0) && (
        <Card>
          <CardTitle>Environment and state</CardTitle>
          {Object.keys(receipt.env).length > 0 && (
            <ListGroup
              label="Exported"
              footnote="Merged into the server's environment at boot and copied into every agent child from there. Two stacks setting one key is not a merge: the first wins and the second is told so above"
            >
              {Object.entries(receipt.env).map(([key, value]) => (
                <ListRow key={key} label={<span className="font-mono text-xs">{key}</span>}>
                  <span className="break-all font-mono text-2xs text-ink-muted">{value}</span>
                </ListRow>
              ))}
            </ListGroup>
          )}
          {receipt.state.length > 0 && (
            <ListGroup
              className={Object.keys(receipt.env).length > 0 ? "mt-4" : ""}
              label="Kept across a reinstall"
              footnote={
                <>
                  Agent-owned directories in the named volume. A version bump takes the package and
                  leaves these, so a provider or module cache is not re-downloaded — removing the
                  stack does not, and what that would cost is below
                  {detail.stateBytes === null ? "" : ` (${fmtBytes(detail.stateBytes)} today)`}.
                </>
              }
            >
              {receipt.state.map((dir) => (
                <ListRow key={dir} label={<span className="break-all font-mono text-xs">{dir}</span>}>
                  <Badge tone="neutral">kept</Badge>
                </ListRow>
              ))}
            </ListGroup>
          )}
        </Card>
      )}
    </>
  );
}
