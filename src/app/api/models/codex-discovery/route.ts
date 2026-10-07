import { NextResponse } from "next/server";
// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime.
import type {
  CodexModelDiscoveryCheckDTO,
  CodexModelDiscoveryDTO,
} from "../../../../lib/apiTypes";
import {
  checkForNewCodexModels,
  codexModelDiscoveryStatus,
} from "../../../../lib/codexModelDiscovery";
import { auditMutation } from "../../../../lib/requestLog";
import { dataDirRefusal } from "../../../../lib/serverLock";
import { getSettings } from "../../../../lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the last Codex check did. Reads the record; never spawns the CLI. */
export async function GET() {
  return NextResponse.json(codexModelDiscoveryStatus() satisfies CodexModelDiscoveryDTO);
}

/**
 * Check now, `POST /api/models/discovery`'s terms: a signed-out Codex or a CLI
 * that will not answer is a 200 carrying its sentence, and the list comes back
 * beside it so the page can show what was added without a reload.
 */
export const POST = auditMutation(async () => {
  const refusal = dataDirRefusal();
  if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });

  const discovery = await checkForNewCodexModels();
  return NextResponse.json({
    discovery,
    codexModelCatalogue: getSettings().codexModelCatalogue,
  } satisfies CodexModelDiscoveryCheckDTO);
});
