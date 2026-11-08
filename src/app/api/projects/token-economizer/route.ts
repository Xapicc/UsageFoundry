import { NextResponse } from "next/server";
import { resolveProjectDir } from "@/lib/projects";
import { projectTokenEconomizer } from "@/lib/tokenEconomizerReport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What TokenEconomizer has recorded for one listed project.
 *
 * Its own route rather than a field on `/api/projects`, because it spawns the
 * plugin's command line and the inventory is read for a whole page at once.
 * The project is resolved the way Fetch and Push resolve theirs, so this can
 * only ever ask about a folder the inventory lists.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const mountId = params.get("mountId");
  const folder = params.get("folder");
  if (!mountId || !folder) {
    return NextResponse.json({ error: '"mountId" and "folder" are both required.' }, { status: 400 });
  }
  const resolved = await resolveProjectDir({ mountId, folder });
  if (!resolved.ok) return NextResponse.json({ error: resolved.reason }, { status: 404 });
  return NextResponse.json(await projectTokenEconomizer(resolved.dir));
}
