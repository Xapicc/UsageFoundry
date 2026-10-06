/**
 * What a loop's pass names its rows, written down once.
 *
 * A module of its own, with no imports at all, and that is the whole reason it
 * is not in `workflows.ts` beside everything that reads it: `land.ts` has to
 * parse one of these ids too — the refusal that keeps a person from landing a
 * branch out from under a live pass names the pass — and `land.ts` cannot reach
 * `workflows.ts`, which imports `mergeQueue.ts`, which imports `land.ts`. The
 * alternative was a second copy of the format in the file that parses it, which
 * is precisely the failure the one-definition rule below exists to prevent.
 */

/**
 * What a pass's member is called in the two member tables.
 *
 * One definition, because the string is also parsed back: `passMemberOf` is what
 * tells `loopPasses` where one pass ends and the next begins, and which block of
 * the section a row is. A format written in one place and read in another is a
 * grouping that reports one pass of six where there were three passes of two —
 * which trips the pass cap four passes early and reports it as running out.
 *
 * **Every row a loop causes is named under this prefix**, not only its members:
 * `createEmitted` names a run an orchestrator member started
 * `<memberId>#<specId>`, so it carries the prefix too. `loopSpend` is written
 * against that fact, and it is what keeps a pass's spend from being understated
 * by the runs a model decided on.
 */
export function passMemberId(
  loopNodeId: string,
  pass: number,
  bodyNodeId: string,
): string {
  return `${passPrefix(loopNodeId)}${pass}#${bodyNodeId}`;
}

/** The prefix every row one loop caused is named under. See `passMemberId`. */
export function passPrefix(loopNodeId: string): string {
  return `${loopNodeId}#pass-`;
}

/**
 * The loop, the pass and whatever follows, split at the **first** `#pass-N`.
 *
 * The first, because `pass-2` is a legal block id and a legal spec id, so a
 * member id can carry the spelling twice and only the first is the loop's. A
 * node id cannot contain `#` and a loop cannot sit inside another loop's
 * section, so the first `#` is always the end of the loop's own id. Read off
 * the last, a member of pass 1 was filed under a loop called `L#pass-1`, the
 * pass never saw it, and every step created it again — one press of Run queued
 * 64 runs that no stop, budget or cap could see.
 */
const PASS_MEMBER = /^([^#]*)#pass-(\d+)(?:#(.*))?$/;

/** Which pass a member id belongs to, or null when it does not carry one. */
export function passNumberOf(memberId: string): number | null {
  return passMemberOf(memberId)?.pass ?? null;
}

/** What a member id says: which loop, which pass, and which block of it. */
export interface PassMemberId {
  loopNodeId: string;
  pass: number;
  /** Null for the one spelling that names no block — see below. */
  bodyNodeId: string | null;
}

/**
 * Take a member id apart, or null when the string does not name a pass member.
 *
 * `bodyNodeId` is null for `…#pass-N`, the spelling a loop wrote when it held a
 * task of its own and repeated *that* rather than framing a section. Nothing
 * writes it any more — a loop with no section is refused at save — but an
 * instance carries a **copy** of the graph it was started from, so a loop that
 * has been repeating since before that change is read back from one, and its
 * rows are still in the database. It reads as the loop's own block, which is
 * what it was.
 */
export function passMemberOf(memberId: string): PassMemberId | null {
  const found = PASS_MEMBER.exec(memberId);
  if (!found) return null;
  return {
    loopNodeId: found[1],
    pass: Number(found[2]),
    bodyNodeId: found[3] ?? null,
  };
}

/**
 * What a pass's member is called on the page.
 *
 * The member's own name and the pass, rather than the loop's: a pass of a
 * section is several rows on the instance page, and “Nightly — pass 2” three
 * times over says nothing about which of them is which.
 */
export function passMemberName(nodeName: string, pass: number): string {
  return `${nodeName} — pass ${pass}`;
}
