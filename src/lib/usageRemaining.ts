import type {
  UsageRemainingDTO,
  UsageRemainingProviderDTO,
  UsageRemainingWindowDTO,
} from "./apiTypes";
import type { CodexPlanUsage } from "./codexAccount";
import { currentCodexReading } from "./codexReading";
import { REFRESH_MS } from "./planUsage";
import {
  FIVE_HOURS_MS,
  WEEK_MS,
  currentPlanReading,
  type PlanUsage,
  type PlanWindow,
} from "./windows";

export interface RemainingInputs {
  claude: {
    signedIn: boolean;
    /** What the cached reader answered, or null when it was not asked or had nothing. */
    plan: PlanUsage | null;
    /** `settings.planUsageFromApi` is off, so a null `plan` is a choice and not a fault. */
    readingsOff: boolean;
  };
  codex: {
    signedIn: boolean;
    plan: CodexPlanUsage | null;
  };
}

function windowOf(
  slot: UsageRemainingWindowDTO["slot"],
  minutes: number | null,
  window: PlanWindow | null,
): UsageRemainingWindowDTO {
  return {
    slot,
    minutes,
    used: window ? window.utilization : null,
    resetsAt: window ? window.resetsAt : null,
  };
}

function providerOf(
  provider: UsageRemainingProviderDTO["provider"],
  windows: UsageRemainingWindowDTO[],
  fetchedAt: number | null,
  limitReached: string | null,
  noReadingNote: string,
  now: number,
): UsageRemainingProviderDTO {
  const hasReading = windows.some((w) => w.used !== null);
  return {
    provider,
    windows,
    fetchedAt,
    // Only a reading that is being shown can be old. `planUsage` and
    // `codexUsage` refresh on any call once a reading passes `REFRESH_MS`, so
    // one served past it is one whose refresh just failed.
    stale: hasReading && fetchedAt !== null && now - fetchedAt > REFRESH_MS,
    limitReached,
    note: hasReading ? null : noReadingNote,
  };
}

/**
 * What the toolbar's readout is told, from what the two cached readers hold.
 * Pure, and the part under test.
 *
 * A provider without a stored sign-in is absent, not present with no reading:
 * the strip names who is signed in. The local provider is not an input at all —
 * it has no allowance, so there is no remainder to state and a bare name would
 * spend width on the tightest strip in the app to say nothing.
 *
 * A window with no current reading is `used: null` and never a number. The
 * readers are themselves null-or-reading, so what this adds is the staleness
 * test every surface already applies — a window whose reset has passed is
 * described by `currentPlanReading` or `currentCodexReading` as closed, not as
 * full — and the refusal to turn an absent window into a 0% or a 100%.
 */
export function usageRemaining(inputs: RemainingInputs, now: number): UsageRemainingDTO {
  const providers: UsageRemainingProviderDTO[] = [];

  if (inputs.claude.signedIn) {
    const plan = inputs.claude.plan;
    const current = plan ? currentPlanReading(plan, now) : null;
    providers.push(
      providerOf(
        "claude",
        [
          windowOf("session", FIVE_HOURS_MS / 60_000, current?.session ?? null),
          windowOf("weekly", WEEK_MS / 60_000, current?.weekly ?? null),
        ],
        plan ? plan.fetchedAt : null,
        null,
        inputs.claude.readingsOff
          ? "Plan readings are switched off in Settings"
          : "No current reading from Anthropic",
        now,
      ),
    );
  }

  if (inputs.codex.signedIn) {
    const plan = inputs.codex.plan ? currentCodexReading(inputs.codex.plan, now) : null;
    providers.push(
      providerOf(
        "codex",
        [
          windowOf("session", plan?.sessionMinutes ?? null, plan?.session ?? null),
          windowOf("weekly", plan?.weeklyMinutes ?? null, plan?.weekly ?? null),
        ],
        plan ? plan.fetchedAt : null,
        plan?.limitReached ?? null,
        "No current reading from Codex",
        now,
      ),
    );
  }

  return { providers };
}
