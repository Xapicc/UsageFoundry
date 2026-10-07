"use client";

// Relative, not "@/…": the test build is plain CommonJS and nothing rewrites
// the alias at runtime.
import { useEffect, useState } from "react";
import Link from "next/link";
import type { UsageRemainingDTO, UsageRemainingProviderDTO } from "../../lib/apiTypes";
import { fmtDateTime, fmtRelative, severityFor, type Severity } from "../../lib/format";
import { jsonRequest } from "../../lib/jsonRequest";
import { startPoll } from "../../lib/poll";
import { codexWindowName } from "../CodexWindows";

/**
 * The dashboard's idle cadence. The readings behind the route refresh every
 * five minutes at most, so a faster poll would buy a sooner answer to a
 * sign-in and nothing else, and this runs on every page.
 */
const POLL_MS = 120_000;

const DAY_MINUTES = 24 * 60;

/** A window's name for a strip with no width to spare: `5h`, `wk`, `3d`. */
export function shortWindowName(minutes: number | null, fallback: string): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes === 7 * DAY_MINUTES) return "wk";
  if (minutes % DAY_MINUTES === 0) return `${minutes / DAY_MINUTES}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export interface StripCell {
  slot: "session" | "weekly";
  label: string;
  /** What is left, 0–1, or null when there is no current reading. */
  remaining: number | null;
  /** `72%`, `~72%` for a reading whose refresh failed, or `—` for none. */
  text: string;
  /** Null for an unknown reading, which has no severity — not a green one. */
  tone: Severity | null;
}

export interface StripProvider {
  provider: UsageRemainingProviderDTO["provider"];
  name: string;
  cells: StripCell[];
  /** The accessible name and tooltip for this provider alone. */
  description: string;
}

const PROVIDER_NAME: Record<UsageRemainingProviderDTO["provider"], string> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * What is left of a window, 0–1, from how much of it is used.
 *
 * Over the wall is a real reading (`planUsage.ts` never caps it), so 104% used
 * is 0% left rather than a negative. Null stays null: an absent reading is
 * not "all used" and not "all left".
 */
export function remainingOf(used: number | null): number | null {
  if (used === null || !Number.isFinite(used)) return null;
  return Math.min(Math.max(1 - used, 0), 1);
}

/**
 * The strip's rows from the route's answer. Pure, and the part under test.
 *
 * Severity is read off the *used* fraction, as every meter in the app does, so
 * a nearly-spent window turns warn at 70% used and danger at 90% used — 30% and
 * 10% left. `failed` is the poll itself having failed: the figures held from
 * the last good answer can no longer be vouched for, so each becomes unknown
 * rather than being kept on screen as current.
 */
export function remainingStrip(
  dto: UsageRemainingDTO,
  now: number,
  failed: boolean,
): StripProvider[] {
  return dto.providers.map((provider) => {
    const name = PROVIDER_NAME[provider.provider];
    const cells = provider.windows.map((window): StripCell => {
      const used = failed ? null : window.used;
      const remaining = remainingOf(used);
      const known = remaining !== null;
      return {
        slot: window.slot,
        label: shortWindowName(window.minutes, window.slot === "session" ? "short" : "long"),
        remaining,
        text: !known
          ? "—"
          : `${provider.stale ? "~" : ""}${Math.round(remaining * 100)}%`,
        // A wall the provider says is hit outranks a window that reads below
        // it: the reading is a snapshot and the wall is the verdict.
        tone: !known ? null : provider.limitReached ? "danger" : severityFor(used),
      };
    });

    // Starts with the words the eye reads off the strip, so a voice command
    // naming what is on screen ("Claude 5h") lands on the name. The resets
    // come after because they are what the strip has no room for.
    const head = `${name} ${cells
      .map((c) => `${c.label} ${c.remaining === null ? "unknown" : `${Math.round(c.remaining * 100)}% left`}`)
      .join(", ")}`;
    const resets = provider.windows
      .map((window, i) =>
        cells[i].remaining === null || window.resetsAt === null
          ? null
          : `${codexWindowName(window.minutes, window.slot === "session" ? "Short" : "Long")} window resets ${fmtDateTime(window.resetsAt)}`,
      )
      .filter((r): r is string => r !== null);
    const caveats = [
      failed ? "could not be refreshed" : null,
      provider.limitReached ? `${provider.limitReached} limit reached` : null,
      !failed && provider.stale && provider.fetchedAt !== null
        ? `last read ${fmtRelative(provider.fetchedAt, now)}`
        : null,
      !failed && provider.note,
    ].filter((c): c is string => Boolean(c));

    return {
      provider: provider.provider,
      name,
      cells,
      description: [head, resets.join("; "), ...caveats].filter(Boolean).join(". "),
    };
  });
}

const TONE: Record<Severity | "unknown", string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  unknown: "text-ink-muted",
};

/**
 * Container-query widths, per number of providers, because the strip's room
 * is not a viewport width: the source list is 224px or 56px and the route's
 * action comes and goes. The container is the title's own row, so the query is
 * "how much of the strip is the title's to share" — the title truncates first,
 * and the readout only appears when it fits beside a title worth reading.
 * Complete class strings, for Tailwind's scanner.
 */
const SHOW: Record<number, string> = {
  1: "@min-[14.5rem]:flex",
  2: "@min-[20.5rem]:flex",
};
const SHOW_WEEKLY: Record<number, string> = {
  1: "@min-[18rem]:inline-flex",
  2: "@min-[27.5rem]:inline-flex",
};

/**
 * What is left of each signed-in provider's windows, in the toolbar.
 *
 * Another reading of the same two numbers the dashboard's meters print, drawn
 * as remaining where they draw used — the strip answers "can I start something
 * now", the meter "how far in am I" — and, like them, never summed across
 * providers: Claude's and Codex's are separate allowances, and a combined
 * figure would be a statement about neither.
 *
 * A failed poll keeps the providers on screen and turns their figures to
 * dashes. A poll that never succeeded, or an install with nothing signed in,
 * draws nothing: this is standing context, and a strip that announced its own
 * failure on every page would be one more thing to skip.
 */
export function UsageRemaining() {
  const [state, setState] = useState<{
    dto: UsageRemainingDTO | null;
    at: number;
    failed: boolean;
  }>({ dto: null, at: 0, failed: false });

  useEffect(() => {
    let live = true;

    async function read() {
      const res = await jsonRequest<UsageRemainingDTO>("/api/usage/remaining");
      if (!live) return;
      if (res.ok) setState({ dto: res.data, at: Date.now(), failed: false });
      else setState((previous) => ({ ...previous, failed: true }));
    }

    const stop = startPoll(read, POLL_MS);
    return () => {
      live = false;
      stop();
    };
  }, []);

  if (!state.dto || state.dto.providers.length === 0) return null;

  const providers = remainingStrip(state.dto, state.at, state.failed);
  const count = Math.min(providers.length, 2);
  const description = providers.map((p) => p.description).join(". ");

  return (
    <Link
      href="/"
      aria-label={description}
      title={providers.map((p) => p.description).join("\n")}
      className={
        "app-no-drag ui-transition ml-auto hidden min-h-[var(--control-h)] shrink-0 " +
        "items-center gap-x-4 rounded-sm px-2 text-xs whitespace-nowrap no-underline " +
        `hover:bg-inset hover:no-underline ${SHOW[count]}`
      }
    >
      {providers.map((provider) => (
        <span key={provider.provider} className="inline-flex items-baseline gap-1.5">
          <span className="font-medium text-ink">{provider.name}</span>
          {provider.cells.map((cell, i) => (
            <span
              key={cell.slot}
              className={
                i === 0
                  ? "inline-flex items-baseline gap-1"
                  : `hidden items-baseline gap-1 ${SHOW_WEEKLY[count]}`
              }
            >
              {i > 0 && (
                <span aria-hidden className="text-ink-faint">
                  ·
                </span>
              )}
              <span className="text-ink-muted">{cell.label}</span>
              <span
                className={`font-medium tabular-nums ${TONE[cell.tone ?? "unknown"]}`}
              >
                {cell.text}
              </span>
            </span>
          ))}
        </span>
      ))}
    </Link>
  );
}
