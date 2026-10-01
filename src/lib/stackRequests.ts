import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RunDTO, StackRequestDTO } from "./apiTypes";
import { db } from "./db";
import type { StackReceipt } from "./stacks";

/**
 * A run asking for software nobody installed, recorded for the operator to read.
 *
 * `request_stack` is the third answer a run has to a missing `cargo` or
 * `terraform`, beside failing inside a tool call and reporting it could not
 * finish. This module is the record of what was asked, and it is deliberately
 * nothing more:
 *
 * - **A request is text, never an install.** Nothing here writes a declaration,
 *   runs the applier or touches `/etc/uf-stacks`, which stays a read-only bind of
 *   the host's `./stacks`. The operator reads the request, writes the
 *   `stack.json` on the host themselves and restarts — the same reviewable act
 *   `docs/agent/security/stacks.md` describes for every other stack. A draft an
 *   agent attaches is shown as preformatted text and goes nowhere else.
 * - **It records requests and never installs.** Whether a stack is installed is
 *   read from the receipts the applier wrote at boot, every time it is asked, so
 *   this table cannot become a second record of what is installed that disagrees
 *   with the directory — the reason `stacks.ts` gives for having no `stacks`
 *   table at all. A request is `pending` or `declined`; "installed" is not a
 *   state it can hold, only something its reader finds in a receipt.
 *
 * The run's side — the `waiting-for-stack` status, the park at the cycle
 * boundary and the release — lives in `orchestrator.ts`, which owns every run
 * status write. What it asks this module is pure where it can be:
 * `normalizeStackRequest` and `decideStackWait` are the two decisions whose
 * failure is silent, and both are unit-tested.
 */

/**
 * The name a request may carry, which is stricter than the applier's.
 *
 * The applier takes any directory entry under `/etc/uf-stacks` as a stack name —
 * `readDeclarations` reads what `readdirSync` returns and `parseStack` asks only
 * that `name` equal it — because a directory there is one the operator made.
 * This name is untrusted text an agent chose, and the run page prints it inside
 * a path the operator is told to create, which is a line somebody pastes into a
 * shell: a name carrying `; rm -rf ~` or a space is an instruction dressed as a
 * path. So it takes the rule the applier holds a linked binary's `as` to, a plain
 * command name, which admits no separator, no whitespace and no shell
 * metacharacter. Every name it admits is one the applier admits as a directory,
 * so a request can never name a stack the boot would refuse for its name.
 */
export const STACK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Long enough for `terraform-1.13` and short enough to fit a card. */
export const MAX_STACK_NAME_CHARS = 64;

/** A linked binary's name, the applier's `bin.as` rule verbatim. */
export const STACK_BINARY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** One request is one toolchain. Sixteen covers Swift's, which is the widest here. */
export const MAX_STACK_BINARIES = 16;

/** "One or two sentences", with room to spare and a ceiling a card can show. */
export const MAX_STACK_REASON_CHARS = 600;

/**
 * A draft is a `stack.json`, and the largest in `stacks/` is under 3 KB. The cap
 * is what keeps an agent from storing a transcript on the operator's settings
 * page through a field nobody will read past its first screen.
 */
export const MAX_STACK_DRAFT_BYTES = 16 * 1024;

/**
 * How many times one run may wait for a stack.
 *
 * A park for a stack refunds the work cycle it ended, the way a guard-cut cycle
 * is refunded — without that, a run on the default cap of one cycle asked for a
 * stack in that cycle and was ended on the cap the moment it resumed, having
 * waited a restart for nothing. A refund that nothing bounds stops
 * `maxIterations` being a terminus, so this is `MAX_PAUSES_PER_RUN`'s bound on
 * `guard_refunds` applied to `runs.stack_waits`: counted on the row, never reset,
 * and past it `request_stack` refuses rather than filing a wait the run could
 * not afford. Every wait needs an operator's answer, which bounds it in practice
 * too, but a terminus that rests on a person doing something is not one.
 */
export const MAX_STACK_WAITS_PER_RUN = 3;

/** What `request_stack` was asked, once it has been checked. */
export interface StackRequestInput {
  name: string;
  binaries: string[];
  reason: string;
  /** A `stack.json` as text, or null when the agent offered none. */
  draft: string | null;
}

export type StackRequestNormalization =
  | { ok: true; value: StackRequestInput }
  | { ok: false; error: string };

/**
 * Check a `request_stack` call at the door, and say what was wrong with it.
 *
 * Every field is a model's output, so every refusal names the field, the rule
 * and a clipped echo of what arrived — a model told only "invalid" re-sends the
 * same call. Nothing is trimmed into validity: a name with a trailing space is
 * refused rather than silently becoming a different name than the one the agent
 * will look for later.
 *
 * `draft` may arrive as an object as well as a string, because a schema field
 * that holds JSON is one a model fills with JSON more often than with a string
 * of it. The object is serialised once here, so what the operator reads and
 * what the parser checks are the same bytes.
 */
export function normalizeStackRequest(args: Record<string, unknown>): StackRequestNormalization {
  const { name, binaries, reason, draft } = args;

  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, error: "name is required: the stack's directory name, such as \"rust\"." };
  }
  if (name.length > MAX_STACK_NAME_CHARS || !STACK_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      error:
        `name ${JSON.stringify(clip(name, 80))} is not a stack name: it must start with a ` +
        `letter or digit and hold only letters, digits, "_", "." and "-", at most ` +
        `${MAX_STACK_NAME_CHARS} characters.`,
    };
  }

  if (!Array.isArray(binaries) || binaries.length === 0) {
    return {
      ok: false,
      error: "binaries is required: the commands this run needs on PATH, such as [\"cargo\"].",
    };
  }
  const seen = new Set<string>();
  for (const entry of binaries) {
    if (typeof entry !== "string" || !STACK_BINARY_PATTERN.test(entry)) {
      return {
        ok: false,
        error:
          `binaries holds ${JSON.stringify(clip(String(entry), 80))}, which is not a plain ` +
          `command name: one word, starting with a letter or digit.`,
      };
    }
    seen.add(entry);
  }
  if (seen.size > MAX_STACK_BINARIES) {
    return {
      ok: false,
      error: `binaries names ${seen.size} commands and one request may name at most ${MAX_STACK_BINARIES}.`,
    };
  }

  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length === 0) {
    return {
      ok: false,
      error: "reason is required: one or two sentences on what this run needs the tools for.",
    };
  }
  if (why.length > MAX_STACK_REASON_CHARS) {
    return {
      ok: false,
      error: `reason is ${why.length} characters and may be at most ${MAX_STACK_REASON_CHARS}: one or two sentences.`,
    };
  }

  let text: string | null = null;
  if (typeof draft === "string") {
    text = draft.trim().length > 0 ? draft : null;
  } else if (draft !== undefined && draft !== null) {
    if (typeof draft !== "object") {
      return { ok: false, error: "draft must be the text of a stack.json, or omitted." };
    }
    text = JSON.stringify(draft, null, 2);
  }
  if (text !== null && Buffer.byteLength(text, "utf8") > MAX_STACK_DRAFT_BYTES) {
    return {
      ok: false,
      error: `draft is larger than ${MAX_STACK_DRAFT_BYTES / 1024} KB; a stack.json is a few hundred bytes.`,
    };
  }

  return { ok: true, value: { name, binaries: [...seen], reason: why, draft: text } };
}

/** A stack the receipts say is installed, and what it put on `PATH`. */
export interface InstalledStack {
  name: string;
  binaries: string[];
}

/**
 * What the receipts say about one request: answered, failed, or not there.
 *
 * `installed` carries the requested binaries no `ok` stack links in `missing`,
 * because an operator may answer a request for `rust` with a `rust` stack that
 * links `cargo` and not the `rustfmt` the run also named — that is the
 * operator's answer, and the resumed run is told what it did not get rather
 * than waiting for a binary nobody is going to install under that name.
 */
export type StackSatisfaction =
  | { kind: "installed"; stacks: InstalledStack[]; missing: string[] }
  | { kind: "failed"; reason: string }
  | { kind: "absent" };

/**
 * Whether the receipts already answer a request for `name` linking `binaries`.
 *
 * Answered when an `ok` receipt carries the name, or when `ok` receipts between
 * them link every binary asked for — an operator who already has `cargo` from a
 * stack called `rust-toolchain` has answered a request for `rust`. This one
 * predicate is read by both `request_stack`, to say "already installed" and
 * file nothing, and the release, to resume a waiting run, and that is the
 * point of having one: if the two disagreed, a run could file a request the
 * release then treats as answered on its next pass, and park and resume in a
 * loop with nothing ever installed.
 *
 * `failed` is reported only for a receipt under the requested name, because that
 * is the one the operator wrote in answer. A `conflicted` receipt is a failure
 * here too: it linked nothing.
 */
export function stackSatisfaction(
  name: string,
  binaries: readonly string[],
  receipts: readonly StackReceipt[],
): StackSatisfaction {
  const ok = receipts.filter((receipt) => receipt.status === "ok");
  const linkedBy = new Map<string, string>();
  for (const receipt of ok) {
    for (const entry of receipt.bin) {
      if (!linkedBy.has(entry.name)) linkedBy.set(entry.name, receipt.name);
    }
  }
  const missing = binaries.filter((binary) => !linkedBy.has(binary));
  const named = ok.find((receipt) => receipt.name === name);

  if (named || missing.length === 0) {
    const providers = new Set(binaries.map((binary) => linkedBy.get(binary)).filter(Boolean));
    if (named) providers.add(named.name);
    const stacks = ok
      .filter((receipt) => providers.has(receipt.name))
      .map((receipt) => ({ name: receipt.name, binaries: receipt.bin.map((entry) => entry.name) }));
    return { kind: "installed", stacks, missing };
  }

  const failed = receipts.find((receipt) => receipt.name === name);
  if (failed) {
    return {
      kind: "failed",
      reason: firstLine(failed.error?.text ?? "") || `the receipt says ${failed.status} and records no reason`,
    };
  }
  return { kind: "absent" };
}

/** One request a waiting run is attached to, as the release reads it. */
export interface StackWaitRequest {
  name: string;
  state: "pending" | "declined";
  /** What this run asked for, which may be fewer than the request as a whole. */
  binaries: string[];
}

/**
 * What to do with one `waiting-for-stack` run, given the receipts.
 *
 * - `resume`: every stack it asked for is answered. `missing` is what the
 *   answering stacks did not link, so the notice can say so.
 * - `declined`: the operator said no to at least one. The run goes back to work
 *   told so — waiting on the others would be waiting for a run that has already
 *   been told it cannot have what it needs, and it is the agent's judgement
 *   whether it can finish without.
 * - `stay`: something is still pending. `failures` is every pending stack whose
 *   receipt failed, which the request shows and the run does not act on: the
 *   operator fixing a `stack.json` and restarting is the ordinary next step.
 */
export type StackWaitDecision =
  | { kind: "resume"; installed: InstalledStack[]; missing: string[] }
  | { kind: "declined"; declined: string[]; installed: InstalledStack[] }
  | { kind: "stay"; failures: { name: string; reason: string }[] };

/**
 * The release's one decision, pure: requests and receipts in, a verdict out.
 *
 * Declined outranks everything because it is a person's answer and the only one
 * that cannot change by waiting. A run attached to nothing resumes rather than
 * staying — a waiting run with no request to wait on would wait for ever, and
 * the notice says the request is gone rather than inventing an install.
 */
export function decideStackWait(
  requests: readonly StackWaitRequest[],
  receipts: readonly StackReceipt[],
): StackWaitDecision {
  const installed: InstalledStack[] = [];
  const missing: string[] = [];
  const failures: { name: string; reason: string }[] = [];
  const declined: string[] = [];
  let pending = 0;

  for (const request of requests) {
    if (request.state === "declined") {
      declined.push(request.name);
      continue;
    }
    const satisfaction = stackSatisfaction(request.name, request.binaries, receipts);
    if (satisfaction.kind === "installed") {
      for (const stack of satisfaction.stacks) {
        if (!installed.some((known) => known.name === stack.name)) installed.push(stack);
      }
      for (const binary of satisfaction.missing) {
        if (!missing.includes(binary)) missing.push(binary);
      }
      continue;
    }
    pending += 1;
    if (satisfaction.kind === "failed") failures.push({ name: request.name, reason: satisfaction.reason });
  }

  if (declined.length > 0) return { kind: "declined", declined, installed };
  if (pending > 0) return { kind: "stay", failures };
  return { kind: "resume", installed, missing };
}

/**
 * What a run resumed from `waiting-for-stack` is told, as its next turn.
 *
 * Written into `runs.follow_up`, the door `reopenPrompt`'s notices already use,
 * so it is consumed at the spawn and is the whole of the resumed turn. It says
 * what changed and names the binaries, because the agent's last turn was "I am
 * waiting for cargo" and the useful first act is to check `cargo --version`
 * rather than to re-derive where it was.
 */
export function stackResumeNotice(decision: Exclude<StackWaitDecision, { kind: "stay" }>): string {
  const installed = decision.installed.map(
    (stack) => `${stack.name} (${stack.binaries.length > 0 ? stack.binaries.join(", ") : "no binaries"})`,
  );
  if (decision.kind === "declined") {
    return [
      `The operator declined the stack you asked for: ${decision.declined.join(", ")}. ` +
        "It will not be installed for this run.",
      installed.length > 0 ? `Installed and on PATH now: ${installed.join("; ")}.` : null,
      "Continue the task without it if you can. If you cannot finish without it, " +
        "say exactly what you would have used it for, and reply with exactly " +
        "NEEDS_REVIEW on its own line.",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (installed.length === 0) {
    return (
      "The stack request this run was waiting on is no longer on record, so it " +
      "is not waiting any more. Check whether the tools you needed are on PATH " +
      "before you carry on; if they are not, continue without them or ask again " +
      "with request_stack."
    );
  }
  return [
    `The stack you asked for is installed, and this run has resumed in the same ` +
      `session. Now on PATH and allowed: ${installed.join("; ")}.`,
    decision.missing.length > 0
      ? `Not provided by what was installed: ${decision.missing.join(", ")}.`
      : null,
    "Check that the tools answer, then carry on with the task from where you stopped.",
  ]
    .filter(Boolean)
    .join(" ");
}

/* ------------------------------------------------------------------ */
/* The record                                                          */
/* ------------------------------------------------------------------ */

interface RequestRow {
  id: string;
  name: string;
  binaries: string;
  draft: string | null;
  state: "pending" | "declined";
  created_at: number;
  updated_at: number;
  declined_at: number | null;
}

interface AttachmentRow {
  request_id: string;
  run_id: string;
  reason: string;
  binaries: string;
  created_at: number;
  released_at: number | null;
}

/** One request, whole, for the two operator surfaces. */
export interface StackRequestRecord {
  id: string;
  name: string;
  /** Every binary any attached run asked for, in the order they were asked. */
  binaries: string[];
  draft: string | null;
  state: "pending" | "declined";
  createdAt: number;
  declinedAt: number | null;
  runs: {
    runId: string;
    reason: string;
    binaries: string[];
    createdAt: number;
    /** When the run stopped waiting on this request; null while it still does. */
    releasedAt: number | null;
  }[];
}

/** What `request_stack` did, for the tool to put into words. */
export type StackRequestOutcome =
  | { kind: "installed"; stacks: InstalledStack[] }
  | { kind: "incomplete"; stack: InstalledStack; missing: string[] }
  | { kind: "waits-spent"; waits: number }
  | { kind: "declined-before"; declinedAt: number }
  | { kind: "filed"; requestId: string }
  | { kind: "attached"; requestId: string; alreadyAttached: boolean };

/**
 * Record a run's request, or answer it from the receipts without recording.
 *
 * The order of the tests is the order of what is true regardless of this run:
 * installed first, so a request the receipts answer writes nothing whatever this
 * run's history; then the waits bound; then this run's own earlier decline, so
 * a run the operator has said no to cannot re-file the same request and park
 * again; and only then a write.
 *
 * One pending request per name, enforced by a partial unique index rather than
 * by this function's read: a second run asking for `rust` attaches to the first
 * run's request, so the operator answers once and both resume. The draft is the
 * first one offered and is never replaced — a later run overwriting a draft the
 * operator may already be reading would change the text under them.
 */
export function recordStackRequest(o: {
  runId: string;
  input: StackRequestInput;
  receipts: readonly StackReceipt[];
  /** `runs.stack_waits`, read by the caller off the row. */
  waitsSoFar: number;
  now?: number;
}): StackRequestOutcome {
  const { runId, input, receipts } = o;
  const now = o.now ?? Date.now();

  const satisfaction = stackSatisfaction(input.name, input.binaries, receipts);
  if (satisfaction.kind === "installed") {
    const named = satisfaction.stacks.find((stack) => stack.name === input.name);
    if (satisfaction.missing.length > 0 && named) {
      return { kind: "incomplete", stack: named, missing: satisfaction.missing };
    }
    return { kind: "installed", stacks: satisfaction.stacks };
  }

  if (o.waitsSoFar >= MAX_STACK_WAITS_PER_RUN) {
    return { kind: "waits-spent", waits: o.waitsSoFar };
  }

  const database = db();
  return database.transaction((): StackRequestOutcome => {
    const refused = database
      .prepare(
        `SELECT r.declined_at FROM stack_requests r
           JOIN stack_request_runs a ON a.request_id = r.id
          WHERE r.name = ? AND r.state = 'declined' AND a.run_id = ?
          ORDER BY r.declined_at DESC LIMIT 1`,
      )
      .get(input.name, runId) as { declined_at: number | null } | undefined;
    if (refused) return { kind: "declined-before", declinedAt: refused.declined_at ?? now };

    const pending = database
      .prepare("SELECT * FROM stack_requests WHERE name = ? AND state = 'pending'")
      .get(input.name) as RequestRow | undefined;

    if (!pending) {
      const id = randomUUID();
      database
        .prepare(
          `INSERT INTO stack_requests (id, name, binaries, draft, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(id, input.name, JSON.stringify(input.binaries), input.draft, now, now);
      attach(id);
      return { kind: "filed", requestId: id };
    }

    const known = parseList(pending.binaries);
    const union = [...known, ...input.binaries.filter((binary) => !known.includes(binary))];
    database
      .prepare(
        "UPDATE stack_requests SET binaries = ?, draft = COALESCE(draft, ?), updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(union), input.draft, now, pending.id);
    const alreadyAttached = attach(pending.id);
    return { kind: "attached", requestId: pending.id, alreadyAttached };
  })();

  /**
   * Attach this run, or re-attach it after an earlier release. True when it was
   * already waiting on this request, which is a model calling twice in one
   * cycle and is answered the same way rather than refused.
   */
  function attach(requestId: string): boolean {
    const existing = database
      .prepare("SELECT released_at FROM stack_request_runs WHERE request_id = ? AND run_id = ?")
      .get(requestId, runId) as { released_at: number | null } | undefined;
    if (existing) {
      database
        .prepare(
          `UPDATE stack_request_runs SET released_at = NULL, reason = ?, binaries = ?
            WHERE request_id = ? AND run_id = ?`,
        )
        .run(input.reason, JSON.stringify(input.binaries), requestId, runId);
      return existing.released_at === null;
    }
    database
      .prepare(
        `INSERT INTO stack_request_runs (request_id, run_id, reason, binaries, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(requestId, runId, input.reason, JSON.stringify(input.binaries), now);
    return false;
  }
}

/**
 * The requests one run is still waiting on, in the shape the release reads.
 *
 * Unreleased attachments only. This is also what decides whether a cycle that
 * has just ended parks: a run with anything here asked for a stack that has not
 * yet been answered, whatever it said about the task.
 */
export function stackWaitOf(runId: string): StackWaitRequest[] {
  const rows = db()
    .prepare(
      `SELECT r.name, r.state, a.binaries FROM stack_request_runs a
         JOIN stack_requests r ON r.id = a.request_id
        WHERE a.run_id = ? AND a.released_at IS NULL
        ORDER BY a.created_at`,
    )
    .all(runId) as { name: string; state: "pending" | "declined"; binaries: string }[];
  return rows.map((row) => ({ name: row.name, state: row.state, binaries: parseList(row.binaries) }));
}

/**
 * Stop counting a run as waiting on anything.
 *
 * Called on every way out of a wait — the release, a stop, any ending of the
 * loop that is not a park, and a pick-up — so the attachment means exactly
 * "this run is between asking and being answered". Left standing on a run that
 * ended, it would park that run at the end of the first cycle after a pick-up,
 * on a request the operator may have forgotten about.
 */
export function releaseStackWait(runId: string, at: number = Date.now()): void {
  db()
    .prepare("UPDATE stack_request_runs SET released_at = ? WHERE run_id = ? AND released_at IS NULL")
    .run(at, runId);
}

/**
 * Decline a pending request. The runs waiting on it are released by the caller,
 * which owns their status — `orchestrator.ts`'s `releaseStackWaits`.
 *
 * Returns false for an id that is not a pending request, so a second press, or
 * a press on a request a restart has just answered, changes nothing.
 */
export function declineStackRequest(id: string, at: number = Date.now()): boolean {
  const result = db()
    .prepare(
      "UPDATE stack_requests SET state = 'declined', declined_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
    )
    .run(at, at, id);
  return result.changes === 1;
}

/** One request by id, or null. */
export function stackRequest(id: string): StackRequestRecord | null {
  const row = db().prepare("SELECT * FROM stack_requests WHERE id = ?").get(id) as RequestRow | undefined;
  return row ? withRuns([row])[0] : null;
}

/**
 * Every pending request, oldest first. The ones a receipt has since answered
 * are still pending in the table — "installed" is never written — and the
 * caller reads the receipts to tell them apart.
 */
export function pendingStackRequests(): StackRequestRecord[] {
  const rows = db()
    .prepare("SELECT * FROM stack_requests WHERE state = 'pending' ORDER BY created_at")
    .all() as RequestRow[];
  return withRuns(rows);
}

/** Every request a run has been attached to, newest first, for its page. */
export function stackRequestsOfRun(runId: string): StackRequestRecord[] {
  const rows = db()
    .prepare(
      `SELECT r.* FROM stack_requests r
         JOIN stack_request_runs a ON a.request_id = r.id
        WHERE a.run_id = ?
        ORDER BY a.created_at DESC`,
    )
    .all(runId) as RequestRow[];
  return withRuns(rows);
}

/** The ids of every run currently in a wait, for the release pass. */
export function runsAttachedToStacks(): string[] {
  return (
    db()
      .prepare("SELECT DISTINCT run_id FROM stack_request_runs WHERE released_at IS NULL")
      .all() as { run_id: string }[]
  ).map((row) => row.run_id);
}

function withRuns(rows: RequestRow[]): StackRequestRecord[] {
  if (rows.length === 0) return [];
  const attachments = db()
    .prepare(
      `SELECT * FROM stack_request_runs WHERE request_id IN (${rows.map(() => "?").join(",")})
        ORDER BY created_at`,
    )
    .all(...rows.map((row) => row.id)) as AttachmentRow[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    binaries: parseList(row.binaries),
    draft: row.draft,
    state: row.state,
    createdAt: row.created_at,
    declinedAt: row.declined_at,
    runs: attachments
      .filter((attachment) => attachment.request_id === row.id)
      .map((attachment) => ({
        runId: attachment.run_id,
        reason: attachment.reason,
        binaries: parseList(attachment.binaries),
        createdAt: attachment.created_at,
        releasedAt: attachment.released_at,
      })),
  }));
}

/* ------------------------------------------------------------------ */
/* The draft, checked by the applier's own parser                      */
/* ------------------------------------------------------------------ */

/**
 * Whether the boot would accept a draft, asked of the parser the boot runs.
 *
 * `unchecked` is a third answer rather than a guess in either direction: a
 * draft nobody could check must not read as one the boot will take.
 */
export type StackDraftVerdict =
  | { kind: "accepted" }
  | { kind: "refused"; reason: string }
  | { kind: "unchecked"; reason: string };

/**
 * Where the applier is at runtime, which is the image's `/app/scripts/` and the
 * checkout's `scripts/` under `next dev` — both the process's working directory
 * plus the same relative path, because the standalone `server.js` changes into
 * its own directory before it serves.
 *
 * Loaded rather than bundled. `stacks.ts` records that the image ships
 * `scripts/` without `src/`, and the applier imports nothing but Node's own
 * modules, so the file the entrypoint runs at boot is the one asked here: one
 * parser, and no copy of its rules that could disagree with it about what a
 * stack may grant. A layout without the file — the standalone bundle
 * `smoke-pages` serves out of `.next/standalone` — answers `unchecked`.
 */
const APPLIER_PATH = path.join(process.cwd(), "scripts", "apply-stacks.mjs");

type ParseStack = (
  text: string,
  dirName: string,
) => { ok: true } | { ok: false; reason: string };

export async function checkStackDraft(
  name: string,
  draft: string,
  applierPath: string = APPLIER_PATH,
): Promise<StackDraftVerdict> {
  let parseStack: ParseStack;
  try {
    // `webpackIgnore` because the path is a runtime fact about the image, and a
    // bundler resolving it at build time would either fail or freeze a copy.
    const applier = (await import(/* webpackIgnore: true */ applierPath)) as {
      parseStack?: unknown;
    };
    if (typeof applier.parseStack !== "function") {
      return { kind: "unchecked", reason: `${applierPath} exports no parseStack` };
    }
    parseStack = applier.parseStack as ParseStack;
  } catch (err) {
    return {
      kind: "unchecked",
      reason: `the applier at ${applierPath} could not be loaded (${(err as Error).message})`,
    };
  }
  const parsed = parseStack(draft, name);
  return parsed.ok ? { kind: "accepted" } : { kind: "refused", reason: parsed.reason };
}

/**
 * Requests as the operator's surfaces draw them, with what the receipts and the
 * parser say about each read now rather than stored.
 *
 * The parser is asked per request on every call, and that is affordable: Node
 * caches the module after the first load and a `stack.json` parses in well
 * under a millisecond, against a run page that polls every three seconds.
 */
export async function stackRequestDTOs(
  records: readonly StackRequestRecord[],
  receipts: readonly StackReceipt[],
): Promise<StackRequestDTO[]> {
  const runIds = [...new Set(records.flatMap((record) => record.runs.map((run) => run.runId)))];
  const statuses = new Map<string, RunDTO["status"]>();
  if (runIds.length > 0) {
    const rows = db()
      .prepare(`SELECT id, status FROM runs WHERE id IN (${runIds.map(() => "?").join(",")})`)
      .all(...runIds) as { id: string; status: RunDTO["status"] }[];
    for (const row of rows) statuses.set(row.id, row.status);
  }
  return Promise.all(
    records.map(async (record) => ({
      id: record.id,
      name: record.name,
      binaries: record.binaries,
      draft: record.draft,
      draftVerdict: record.draft === null ? null : await checkStackDraft(record.name, record.draft),
      state: record.state,
      receipt: stackSatisfaction(record.name, record.binaries, receipts),
      hostPath: `./stacks/${record.name}/stack.json`,
      createdAt: record.createdAt,
      declinedAt: record.declinedAt,
      runs: record.runs.map((run) => ({ ...run, status: statuses.get(run.runId) ?? null })),
    })),
  );
}

/** Both list columns are written only by this module, as `JSON.stringify` of a `string[]`. */
function parseList(text: string): string[] {
  return JSON.parse(text) as string[];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The applier writes its own sentence ahead of a tool's stderr. */
function firstLine(text: string): string {
  return (text.split("\n", 1)[0] ?? "").slice(0, 300);
}
