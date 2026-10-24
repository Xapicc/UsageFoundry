import fs from "node:fs";
import path from "node:path";
import { db } from "./db";
import type { SignatureRollup } from "./dreaming";
// Type-only, so the ledger stays loadable without the orchestrator behind it.
import type { RunStatus } from "./orchestrator";

/**
 * What Dreaming has written, and what a night decided.
 *
 * Three tables and no model. `dreaming_notes` is the deduplication key *and* the
 * retraction list: the vault has no author field and nothing in a note that
 * says this app produced it (and was not a repository when this was written),
 * so "what did Dreaming write" is a question only this side can answer.
 * `dreaming_nights` is the other half: a night that selected nothing wrote no
 * notes, and a pane reading only the first table cannot tell that from a night
 * that never ran. `dreaming_pending` holds a night whose notes are on a branch
 * that has not landed, between those two.
 *
 * Everything here is synchronous, like every other reader of this database.
 */

export interface DreamingNote {
  signature: string;
  sample: string;
  writtenAt: number;
  night: string;
  runId: string | null;
  /** Vault-relative, or null when the run wrote nothing for this signature. */
  notePath: string | null;
  daysSeen: number;
  instances: number;
}

export type NightOutcome = "selected" | "quiet" | "refused" | "failed";

export interface DreamingNight {
  night: string;
  startedAt: number;
  outcome: NightOutcome;
  reason: string | null;
  runId: string | null;
  selected: number;
  /**
   * The status of `runId`'s run, joined in by `listNights` and never stored:
   * `recordNight` takes a night without it. Null when the night created no run
   * or its run row is gone.
   */
  runStatus: RunStatus | null;
}

/** How many notes and nights the two lists below return before cutting. */
export const NOTE_LIMIT = 500;
export const NIGHT_LIMIT = 60;

/** Totals, so a cut list can say it was cut rather than reading as the whole. */
export function ledgerCounts(): { notes: number; nights: number } {
  const one = (sql: string) => (db().prepare(sql).get() as { n: number }).n;
  return {
    notes: one("SELECT COUNT(*) AS n FROM dreaming_notes"),
    nights: one("SELECT COUNT(*) AS n FROM dreaming_nights"),
  };
}

/** Every signature this app has already written a note for. */
export function writtenSignatures(): Set<string> {
  const rows = db().prepare("SELECT signature FROM dreaming_notes").all() as {
    signature: string;
  }[];
  return new Set(rows.map((r) => r.signature));
}

export function listNotes(limit = NOTE_LIMIT): DreamingNote[] {
  const rows = db()
    .prepare(
      `SELECT signature, sample, written_at, night, run_id, note_path, days_seen, instances
         FROM dreaming_notes
        ORDER BY written_at DESC, signature
        LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    signature: String(r.signature),
    sample: String(r.sample),
    writtenAt: Number(r.written_at),
    night: String(r.night),
    runId: (r.run_id as string | null) ?? null,
    notePath: (r.note_path as string | null) ?? null,
    daysSeen: Number(r.days_seen),
    instances: Number(r.instances),
  }));
}

/**
 * Claim a set of signatures for one night, before the run that writes them
 * exists. For a run that works in the vault's own folder: one that works on a
 * branch is claimed by `claimPendingLanding`, when the branch has landed.
 *
 * Claimed up front rather than recorded on the way out, and the ordering is the
 * whole point: a run that crashes halfway through has still written some of the
 * files, and a ledger written only on success would hand the same signatures to
 * the next night — which is the duplicate the vault's own conventions name as
 * the failure mode they exist to prevent. Over-claiming loses a note; under-
 * claiming writes a second one beside a note that is already there, and only
 * the second is a mess in somebody's document store.
 *
 * `note_path` stays null until `recordNotePath` hears otherwise, so a claimed
 * signature reads on the pane as "attempted, no file recorded" rather than as a
 * note that exists.
 *
 * `rollups` must be the array `buildDreamingPrompt` was handed, in its order:
 * each row stores its 1-based place in it as `prompt_item`, which is the item
 * number the run's report will name it by.
 */
export function claimSignatures(
  night: string,
  runId: string | null,
  rollups: readonly SignatureRollup[],
  now = Date.now(),
): number {
  const insert = db().prepare(
    `INSERT OR IGNORE INTO dreaming_notes
       (signature, sample, written_at, night, run_id, note_path, days_seen, instances, prompt_item)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  );
  return db().transaction(() => {
    let claimed = 0;
    for (const [index, r] of rollups.entries()) {
      const res = insert.run(
        r.signature,
        r.sample,
        now,
        night,
        runId,
        r.days.length,
        r.instances,
        index + 1,
      );
      claimed += res.changes;
    }
    return claimed;
  })();
}

/** A night's selection whose notes are on a branch that has not landed. */
export interface PendingLanding {
  runId: string;
  night: string;
  /** The array the prompt numbered, in its order (`claimSignatures`' contract). */
  selected: SignatureRollup[];
  createdAt: number;
  /** When the branch was last put in the merge queue, or null if it never was. */
  attemptedAt: number | null;
}

/**
 * Record a selection to be claimed when its run's branch lands.
 *
 * What `claimSignatures` is for a run that works in the vault itself, for a run
 * that works on a branch: the signatures are held here instead of in
 * `dreaming_notes`, because that table says "a note was written" and nothing
 * has been written into the vault until the branch lands. Claiming up front
 * would suppress a signature for a note that a refused land then never
 * delivers, and the next night would not try it again.
 */
export function recordPendingLanding(
  night: string,
  runId: string,
  rollups: readonly SignatureRollup[],
  now = Date.now(),
): void {
  db()
    .prepare(
      `INSERT OR REPLACE INTO dreaming_pending (run_id, night, selected, created_at, attempted_at)
       VALUES (?, ?, ?, ?, NULL)`,
    )
    .run(runId, night, JSON.stringify(rollups), now);
}

/** Oldest first, so a settle works through them in the order they were started. */
export function pendingLandings(): PendingLanding[] {
  const rows = db()
    .prepare(
      `SELECT run_id, night, selected, created_at, attempted_at
         FROM dreaming_pending ORDER BY created_at, rowid`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    runId: String(r.run_id),
    night: String(r.night),
    selected: JSON.parse(String(r.selected)) as SignatureRollup[],
    createdAt: Number(r.created_at),
    attemptedAt: (r.attempted_at as number | null) ?? null,
  }));
}

export function markLandingAttempted(runId: string, at = Date.now()): void {
  db().prepare("UPDATE dreaming_pending SET attempted_at = ? WHERE run_id = ?").run(at, runId);
}

/**
 * Move a pending selection into `dreaming_notes` and delete the pending row, as
 * one transaction so a crash between the two cannot leave a signature claimed
 * and also still pending, or pending with no claim after the row is gone.
 * Returns how many signatures were newly claimed; 0 when the row was already
 * settled, which is what makes a second settle on the same run harmless.
 */
export function claimPendingLanding(runId: string, now = Date.now()): number {
  return db().transaction(() => {
    const pending = pendingLandings().find((p) => p.runId === runId);
    if (!pending) return 0;
    const claimed = claimSignatures(pending.night, runId, pending.selected, now);
    db().prepare("DELETE FROM dreaming_pending WHERE run_id = ?").run(runId);
    return claimed;
  })();
}

/**
 * Let a pending selection go without claiming it, so a later night may select
 * those signatures again. For a branch somebody deleted or purged, which is a
 * decision that the notes on it are not wanted in the vault.
 */
export function dropPendingLanding(runId: string): boolean {
  return db().prepare("DELETE FROM dreaming_pending WHERE run_id = ?").run(runId).changes > 0;
}

/**
 * Attach the file a run says it wrote.
 *
 * Best-effort by design. The run reports its own paths and nothing verifies
 * that it wrote what it claims — `noteStillPresent` below is the check, and it
 * runs when a person looks rather than when the run speaks, because a file can
 * be deleted at any point after and the row must not claim otherwise.
 */
export function recordNotePath(signature: string, notePath: string | null): void {
  db()
    .prepare("UPDATE dreaming_notes SET note_path = ? WHERE signature = ?")
    .run(notePath, signature);
}

/**
 * Forget a note this app wrote.
 *
 * Deletes the *row*, never the file. Retraction in the vault is a person moving
 * a file in Obsidian — `_to_delete/` is what that store's own conventions use —
 * and an app that deleted from a mount it does not own would be a heavier thing
 * than anything else this app does. What this buys is that the signature stops
 * being suppressed: forget a row and the next qualifying night writes it again.
 */
export function forgetNote(signature: string): boolean {
  return (
    db().prepare("DELETE FROM dreaming_notes WHERE signature = ?").run(signature).changes > 0
  );
}

/**
 * Record what a night decided, without letting a later pass erase an earlier
 * one that wrote.
 *
 * A night can be decided more than once — a press at noon and the timer at
 * 03:04 share a calendar night — and the naive upsert overwrote. So a night
 * that had already selected three signatures and started a run read back as
 * `quiet`, which the pane draws as "nothing recurred": a night that wrote into
 * somebody's vault, reported on the one surface that shows it as a night that
 * did nothing. Nothing else would have contradicted it, because the notes
 * carry a run rather than an outcome.
 *
 * So `selected` is sticky. Later passes still refresh the row — a second press
 * that also selects moves it to the newer run, which is the one whose report
 * the reconciler will read — but a `quiet`, `refused` or `failed` result never
 * downgrades a night that has already written. What is lost is only that the
 * later pass found nothing, which is the uninteresting half; `dreaming_notes`
 * keeps the authoritative record of what each run claimed.
 */
export function recordNight(night: Omit<DreamingNight, "runStatus">): void {
  db()
    .prepare(
      `INSERT INTO dreaming_nights (night, started_at, outcome, reason, run_id, selected)
       VALUES (@night, @startedAt, @outcome, @reason, @runId, @selected)
       ON CONFLICT(night) DO UPDATE SET
         started_at = excluded.started_at,
         outcome    = CASE WHEN dreaming_nights.outcome = 'selected'
                             AND excluded.outcome <> 'selected'
                           THEN dreaming_nights.outcome ELSE excluded.outcome END,
         reason     = CASE WHEN dreaming_nights.outcome = 'selected'
                             AND excluded.outcome <> 'selected'
                           THEN dreaming_nights.reason ELSE excluded.reason END,
         run_id     = COALESCE(excluded.run_id, dreaming_nights.run_id),
         selected   = CASE WHEN dreaming_nights.outcome = 'selected'
                             AND excluded.outcome <> 'selected'
                           THEN dreaming_nights.selected
                           ELSE dreaming_nights.selected + excluded.selected END`,
    )
    .run(night);
}

/**
 * Newest night first, each with the status of the run its `run_id` names.
 *
 * `outcome` is a record of what the night decided and is never rewritten from
 * the run: a run that was created and then failed, stopped or was killed stays
 * `selected`. The run's own row is the authority on how it ended, so the status
 * is read from there at list time rather than copied into this table, where it
 * would be stale the moment the run moved.
 *
 * A LEFT JOIN, because retention deletes old runs and the night happened
 * whether or not its run is still there; an inner join would drop it from the
 * list. `runStatus` is null for a night with no run and for one whose run is
 * gone, and the two read the same on purpose — neither has a status to show.
 *
 * `run_id` is the **latest** run of the night (`recordNight` overwrites it when
 * a second pass also selects), so the status is the latest run's too.
 */
export function listNights(limit = NIGHT_LIMIT): DreamingNight[] {
  const rows = db()
    .prepare(
      `SELECT n.night, n.started_at, n.outcome, n.reason, n.run_id, n.selected,
              r.status AS run_status
         FROM dreaming_nights n
         LEFT JOIN runs r ON r.id = n.run_id
        ORDER BY n.night DESC LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    night: String(r.night),
    startedAt: Number(r.started_at),
    outcome: String(r.outcome) as NightOutcome,
    reason: (r.reason as string | null) ?? null,
    runId: (r.run_id as string | null) ?? null,
    selected: Number(r.selected),
    runStatus: (r.run_status as RunStatus | null) ?? null,
  }));
}

/**
 * Whether the file a row points at is still on disk.
 *
 * The one column in this feature that reports on the operator's store rather
 * than on this app's record of it, and the only way a deleted note becomes
 * visible: there is no `.git` behind the vault, so a note removed in Obsidian
 * leaves no trace anywhere except its absence.
 *
 * Containment is proved here rather than trusted from the row, on the rule that
 * a stored path is not evidence about the filesystem it is read back into. The
 * check is lexical, then again after `realpathSync` — a symlink inside the
 * vault can still point out of it — and mirrors `containedIn` in `knowledge.ts`
 * rather than importing it, for the reason that one gives about not reaching
 * into a stranger's internals.
 */
export function noteStillPresent(vaultRoot: string, notePath: string | null): boolean | null {
  if (!notePath) return null;
  let root: string;
  try {
    root = fs.realpathSync(vaultRoot);
  } catch {
    return null;
  }
  const contained = (p: string) => {
    const rel = path.relative(root, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const candidate = path.resolve(root, notePath);
  if (!contained(candidate)) return false;
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return false;
  }
  if (!contained(real)) return false;
  try {
    return fs.statSync(real).isFile();
  } catch {
    return false;
  }
}
