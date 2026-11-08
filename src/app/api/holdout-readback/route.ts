import { NextResponse } from "next/server";
import { holdoutReadback } from "@/lib/holdoutReadback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The prior-read pointer's holdout, read back: compliance, displacement and
 * outcome per arm.
 *
 * Its own route, `repo-reading`'s reason: it reads three tables in full on
 * request and neither `/api/usage` nor `/api/repo-spend` should pay for that on
 * their cadence. It reads the export tables and never `run_events`, so it
 * answers the same after the thirty-day sweep.
 *
 * Reporting and never a guard — see `holdoutReadback.ts`.
 */
export async function GET() {
  return NextResponse.json(holdoutReadback());
}
