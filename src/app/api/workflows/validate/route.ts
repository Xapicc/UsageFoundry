import { NextResponse } from "next/server";
import {
  boardReadings,
  currentKnowledge,
  folderRefusal,
  normalizeWorkflowInput,
} from "@/lib/workflows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What would stop this graph being saved, asked while it is being drawn.
 *
 * The canvas cannot answer this itself and must not try. `normalizeWorkflowInput`
 * is the authority on what a workflow may be — a loop, a deleted template, a
 * workspace that is not mounted, a block with no task, a condition nobody chose
 * — and a second copy of those rules in the client would be a second set to keep
 * in step, disagreeing with the save route on the day one of them changed. So
 * the editor asks the same function the save route asks, with the same
 * knowledge, and shows the sentence it gets back.
 *
 * A POST that writes nothing, and so deliberately **not** wrapped in
 * `auditMutation`: it is an advisory check the canvas runs while somebody is
 * drawing, and an audit line per keystroke would bury the requests that
 * actually changed something.
 *
 * It runs `folderRefusal` too, for the reason `POST /api/workflows` does: a
 * block's folder is what its run will use, and it is the one check that is a
 * syscall rather than a decision.
 *
 * The verdict is a 200 either way. A refusal is the answer, not a failed
 * request — a 400 here would be indistinguishable to the caller from the route
 * being unreachable, and the editor says something different in those two cases:
 * this is advisory, and Save is still the thing that decides.
 *
 * It also answers what each loop's board condition counts **today**, beside the
 * verdict rather than behind it: the operator picking a project and typing a
 * number has to be able to see what the number is compared against, and a graph
 * being drawn is refused for most of the time it is being drawn — so a figure
 * gated on the verdict would be missing exactly when it is wanted. It is the one
 * thing this route reads rather than decides, and it reads it through the same
 * function `advanceLoop` reads it through.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const known = currentKnowledge();
  const boards = boardReadings(body, known);

  const parsed = normalizeWorkflowInput(body, known);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error, boards });
  }

  const missing = folderRefusal(parsed.value.graph);
  if (missing) return NextResponse.json({ ok: false, error: missing, boards });

  return NextResponse.json({ ok: true, boards });
}
