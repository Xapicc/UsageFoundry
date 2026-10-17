import { NextResponse } from "next/server";
import { repoReading } from "@/lib/repoReading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What runs on each repository keep reading, failing at and colliding in.
 *
 * Its own route rather than a field on `/api/usage` or `/api/repo-spend`: it is
 * a full scan of `run_events`, which has no index on `kind`, and neither of
 * those should pay for it on their cadence. Read on request, never per cycle.
 *
 * No span parameter. "An earlier run" needs the history before any span's
 * start, and the logs are bounded by `eventRetentionDays` already, so the card
 * reads every run whose log is kept and says how far back that is.
 *
 * Reporting and never a guard — see `repoReading.ts`.
 */
export async function GET() {
  return NextResponse.json(repoReading());
}
