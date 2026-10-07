import { NextResponse } from "next/server";
import { jsonNoStore } from "@/lib/http";
import { claudeSignInStored, planUsage } from "@/lib/planUsage";
import { codexSignInStored, codexUsage } from "@/lib/codexAccount";
import { getSettings } from "@/lib/settings";
import { usageRemaining } from "@/lib/usageRemaining";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What is left of each signed-in provider's windows, for the toolbar that sits
 * above every page.
 *
 * **Not `GET /api/usage`.** That route scans every transcript on the machine and
 * sends ~52 KB, which is right for the dashboard it is the heartbeat of and
 * wrong for a poll behind every page. This one reads the two provider caches
 * `/api/usage` already fills — five minutes to refresh, a failure keeps the last
 * good value — and the answer is a few hundred bytes. It starts no
 * `claude auth status` or `codex login status` either: a sign-in is a file that
 * exists (`claudeSignInStored`, `codexSignInStored`), so a poll from an install
 * that has signed nothing in costs two `stat`-sized reads.
 *
 * It can still make the one request the dashboard would: the first call after a
 * reading ages out asks Anthropic, and asks Codex's app server, exactly as a
 * dashboard poll would have. Opening any page keeps those two readings warm.
 */
export async function GET() {
  try {
    const now = Date.now();
    const settings = getSettings();

    const claudeSignedIn = await claudeSignInStored();
    const codexSignedIn = codexSignInStored();
    const readingsOff = !settings.planUsageFromApi;
    const [claudePlan, codexPlan] = await Promise.all([
      claudeSignedIn && !readingsOff ? planUsage(now) : Promise.resolve(null),
      codexSignedIn ? codexUsage(now) : Promise.resolve(null),
    ]);

    return jsonNoStore(
      usageRemaining(
        {
          claude: { signedIn: claudeSignedIn, plan: claudePlan, readingsOff },
          codex: { signedIn: codexSignedIn, plan: codexPlan },
        },
        now,
      ),
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
