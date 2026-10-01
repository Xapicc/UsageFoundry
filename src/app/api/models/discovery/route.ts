import { NextResponse } from "next/server";
// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime.
import type { ModelDiscoveryCheckDTO, ModelDiscoveryDTO } from "../../../../lib/apiTypes";
import {
  checkForNewModels,
  modelDiscoveryStatus,
} from "../../../../lib/modelDiscovery";
import { auditMutation } from "../../../../lib/requestLog";
import { dataDirRefusal } from "../../../../lib/serverLock";
import { getSettings } from "../../../../lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the last check did. Reads the record; never asks the provider. */
export async function GET() {
  return NextResponse.json(modelDiscoveryStatus() satisfies ModelDiscoveryDTO);
}

/**
 * Check now, with a person waiting for the answer.
 *
 * A provider refusal is a 200 carrying its sentence, the dreaming button's
 * rule: a 401 from `/v1/models` is a state the panel exists to show, not a
 * fault in this request. The catalogue comes back beside it so the page can
 * show what was added without a reload that would cost every unsaved edit.
 *
 * Refused outright on a server that does not own the data directory, because
 * the whole of what a check does is write the catalogue.
 */
export const POST = auditMutation(async () => {
  const refusal = dataDirRefusal();
  if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });

  const discovery = await checkForNewModels();
  return NextResponse.json({
    discovery,
    modelCatalogue: getSettings().modelCatalogue,
  } satisfies ModelDiscoveryCheckDTO);
});
