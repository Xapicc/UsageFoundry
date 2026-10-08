import { NextResponse } from "next/server";
import { currentSnapshot } from "@/lib/orchestrator";
import { startWorkflow, type WorkflowFolder } from "@/lib/workflows";
import { optionalObjectField, optionalStringField } from "@/lib/http";
import { instanceDTO } from "../../dto";
import { auditMutation } from "../../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Turn a saved graph into runs.
 *
 * This is the second route in the app that starts unattended agents from
 * something other than the run form — the chat's approval gate is the first —
 * and it is narrow in the same way: the graph decides *what work to do*, and
 * every guard comes from the template each block names or from
 * `settings.chatDefaultGuards`. Nothing on the wire here sets a budget or a
 * permission mode; the request body is not read at all.
 *
 * `startWorkflow` creates every run in one synchronous pass and rolls the whole
 * thing back if any of them cannot be created, so this answers either "all of
 * them started" or "none of them are running", never a count in between. The
 * refusal is a 400 with a sentence for the same reason every other refusal here
 * is: it names something the operator can act on.
 *
 * The snapshot is read here rather than in `startWorkflow`, which must stay
 * synchronous from its first `createRun` to its last for the folder claim to be
 * atomic. It is what the workflow-wide budget is checked against at the door: a
 * fraction guard with no ceiling behind it, or a window already past the guard,
 * is a 400 with a sentence instead of a graph that halts before its first block
 * does anything. The instance budget comes off the saved workflow and there is
 * no field here that could set one.
 *
 * The body carries one thing, and only for a workflow saved with folders to
 * choose from: `folder`, which of those saved folders this press works in.
 * It is a choice and never a path — `startWorkflow` asks `chooseFolder`, which
 * accepts exactly an entry a person saved and refuses anything else, so this
 * route widens no block's reach past what the editor saved. An empty body is
 * what every press before this sent, and still means "no choice".
 */
async function postHandler(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;

  const chosen = await chosenFolderOf(req);
  if (!chosen.ok) {
    return NextResponse.json({ error: chosen.error }, { status: 400 });
  }

  const outcome = startWorkflow(id, await currentSnapshot(), {
    kind: "manual",
    folder: chosen.folder,
  });
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.reason }, { status: 400 });
  }
  return NextResponse.json({ instance: instanceDTO(outcome.instance) });
}

type ChosenFolderRead =
  | { ok: true; folder: WorkflowFolder | null }
  | { ok: false; error: string };

/**
 * The saved folder the body names, or none. Not `readJsonObject`, which refuses
 * an empty body: the Run button sent none until this field existed, and a
 * workflow with no folders to choose from still sends none.
 */
async function chosenFolderOf(req: Request): Promise<ChosenFolderRead> {
  const text = await req.text();
  if (text.trim() === "") return { ok: true, folder: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "The body has to be a JSON object; this one did not parse as JSON." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "The body has to be a JSON object." };
  }
  const field = optionalObjectField(parsed as Record<string, unknown>, "folder");
  if (!field.ok) return field;
  if (!field.value) return { ok: true, folder: null };
  const mountId = optionalStringField(field.value, "mountId");
  if (!mountId.ok) return mountId;
  const folder = optionalStringField(field.value, "folder");
  if (!folder.ok) return folder;
  if (mountId.value === undefined || folder.value === undefined) {
    return {
      ok: false,
      error: '"folder" names a saved folder by its "mountId" and "folder"; one of the two is missing.',
    };
  }
  return { ok: true, folder: { mountId: mountId.value, folder: folder.value } };
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
