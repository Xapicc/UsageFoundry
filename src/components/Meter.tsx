"use client";

// Relative, not "@/lib/format": tsconfig.test.json emits plain CommonJS and
// nothing rewrites the path alias at runtime, so a tested component has to
// import the way src/lib already does.
import { fmtPct, severityFor, type Severity } from "../lib/format";
import { AsciiBar } from "./ui/AsciiBar";

/**
 * A single limit meter.
 *
 * `fraction === null` means no ceiling is configured. That renders as a hatched
 * indeterminate bar rather than an empty one — an empty bar reads as "0% used,
 * plenty left", which is the opposite of "we don't know".
 *
 * `upperFraction` is an optional second, higher reading for the same reading's
 * subject: the figure the guard acts on, where the solid fill is what was
 * measured. It is drawn as a hatched band extending past the solid fill,
 * because that span is precisely the part we cannot put a number on. Without
 * it the budget guard would refuse a run at a threshold the visible meter has
 * not reached, with nothing on screen to explain why.
 *
 * *What* widens it differs by call site — an unpriced model charged a fallback
 * rate on a window meter, a work cycle that stopped before reporting on a spend
 * one — so the sentence a screen reader hears comes from the caller as
 * `upperHint`. It used to be one guess made here, and that guess was false at
 * three of this component's call sites.
 */

export type MeterSize = "compact" | "default" | "hero";

/**
 * Picked by a map, not by two competing CSS rules.
 *
 * `severityFor(null)` returns "ok", so an unknown fill used to carry both
 * `data-sev="ok"` and `data-unknown="true"` and the hatch won only because its
 * rule was declared three lines later in the stylesheet. As Tailwind variants
 * that tiebreak would move to Tailwind's internal variant sort order, which is
 * not a documented contract — and since an unknown fill is clamped to full
 * width, losing the race paints a solid green 100% bar. That is a worse lie
 * than the empty bar this component exists to avoid, so `known` short-circuits
 * before the severity map is ever consulted.
 */
const SEVERITY_FILL: Record<Severity, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
};

/**
 * The same three severities as a text colour, for the skin whose fill is a run
 * of characters. Same short-circuit, for the same reason: `severityFor(null)`
 * is "ok", and an unknown bar tinted green is the lie this component exists to
 * refuse, in a second place.
 */
const SEVERITY_TEXT: Record<Severity, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
};

/**
 * Complete class strings per size, never interpolated — Tailwind scans source
 * as text, so `h-${n}` emits nothing and does it silently. Same rule the tone
 * maps in `ui/Badge` and `ui/Button` follow.
 *
 * `hero` exists for the one meter the dashboard is built around: the 5-hour
 * window. Size is how that card says it leads, so the track and the reading
 * both step up rather than the card being tinted a different colour.
 */
const SIZE: Record<
  MeterSize,
  {
    root: string;
    head: string;
    track: string;
    value: string;
    /** The guard's higher reading. Never larger than `value` at the same size. */
    upper: string;
    detail: string;
    /**
     * The ascii skin's cell count, which is how *that* skin says a meter leads:
     * it has no track height to step, because a bar there is one row of text.
     *
     * Fixed rather than fitted to the card, because nothing can measure the
     * card without a layout pass, and a bar that reflowed its own resolution
     * mid-render would change what it says. The ceiling is the narrowest place
     * any of them lands: 34 characters at the 14px monospace this is set in is
     * ~286px, against ~326px inside a card at the 390px viewport — so `hero`,
     * the widest, still clears it with the brackets on.
     */
    cells: number;
  }
> = {
  compact: {
    root: "mt-2.5 first:mt-0",
    head: "mb-1.5",
    track: "h-1.5",
    value: "text-xs",
    upper: "text-xs",
    detail: "mt-1.5",
    cells: 16,
  },
  default: {
    root: "mt-3",
    head: "mb-1.5",
    track: "h-2",
    value: "text-sm",
    upper: "text-xs",
    detail: "mt-2",
    cells: 24,
  },
  hero: {
    root: "mt-3",
    head: "mb-2",
    track: "h-3",
    value: "text-lg",
    upper: "text-sm",
    detail: "mt-2",
    cells: 32,
  },
};

/**
 * A reading below about half a percent is a sub-pixel sliver on a 200px track,
 * so it paints as an empty bar — the same lie the hatch exists to prevent at
 * the other end of the scale. The floor is on the *drawn* width only:
 * `aria-valuenow` and the printed percentage keep reporting the true figure,
 * and a genuine zero still draws nothing.
 */
const MIN_VISIBLE_PX = 3;

/**
 * The fill's own motion, off the kit's tokens rather than the 200ms/ease-out
 * this used to hardcode.
 *
 * `--motion-slow` is the step globals.css defines as "something travelling a
 * distance the eye must follow (a meter)", and a hardcoded duration is a second
 * place that has to be remembered when that step moves. Width is the one
 * property animated here, which is also why this is not `ui-transition`: that
 * utility deliberately omits width, because a *control* must not resize between
 * its states — a level indicator is not a control, and its width is the reading.
 */
const FILL_MOTION =
  "transition-[width] duration-[var(--motion-slow)] ease-standard";

/**
 * What the hatched band is announced as when a caller names nothing.
 *
 * The one thing true at every call site is the split itself: the solid fill is
 * a floor of what was measured and the band is this app's own estimate on top
 * of it. Anything more specific — which is to say any *mechanism* — is a claim
 * about a particular meter, and a default that named one would go on being
 * spoken at the meters where it is false, which is exactly the defect this
 * replaced.
 */
const UPPER_HINT_DEFAULT =
  "counting what this app estimated as well as what it measured";

export function Meter({
  label,
  fraction,
  upperFraction,
  upperHint = UPPER_HINT_DEFAULT,
  detail,
  value,
  upperValue,
  unknownHint = "no ceiling set",
  size = "default",
}: {
  label: string;
  fraction: number | null;
  upperFraction?: number | null;
  /**
   * Completes the spoken sentence "…, up to 80.0% ___", saying what the band
   * past the solid fill is. Announced only — the sighted reading of the band is
   * the second reading in the head and the hatch on the track, and this string
   * is never drawn.
   *
   * Required in practice rather than by the type, because only the caller knows
   * what widens its own reading; `UPPER_HINT_DEFAULT` is what a caller that
   * supplies nothing promises, and it is deliberately mechanism-free.
   */
  upperHint?: string;
  detail?: string;
  /**
   * Replaces the percentage in the head, for readings where the raw pair says
   * more than the ratio does ("2/5" over "40.0%"). Ignored when the fraction is
   * unknown — that state must keep saying so rather than showing any number.
   */
  value?: string;
  /**
   * How the band's own reading is spelled once `value` has replaced the
   * percentage — the dash in the head joins two ends of one range, so both ends
   * have to be the same kind of quantity. Required in practice rather than by
   * the type: a caller that overrides `value` and supplies nothing here gets no
   * band drawn at all, in the head, on the track or to a screen reader, because
   * this component has no way to spell a dollar figure from a fraction and a
   * percentage next to a dollar figure is not a range.
   */
  upperValue?: string;
  unknownHint?: string;
  size?: MeterSize;
}) {
  const known = fraction !== null && Number.isFinite(fraction);
  const clamped = known ? Math.min(Math.max(fraction, 0), 1) : 1;
  const sz = SIZE[size];

  // Only meaningful when it exceeds the known reading; equal values are the
  // normal, fully-priced case and must not draw a zero-width band.
  const bandExceedsFill =
    known &&
    upperFraction !== null &&
    upperFraction !== undefined &&
    Number.isFinite(upperFraction) &&
    upperFraction > fraction;

  const reading = known ? (value ?? fmtPct(fraction)) : null;

  /**
   * The band's reading, or `undefined` for "do not draw one".
   *
   * A caller that overrode `value` is naming some quantity that is not a
   * percentage — money, or a pair like "2/5" — and the percentage this would
   * otherwise print sits on the far side of an en dash from it, which reads as
   * one range with two units in it (`$12.40 – 18.9%`). There is nothing to fall
   * back to: only the caller knows how its own quantity is spelled. So an
   * unspellable band is dropped from the head, the track and `aria-valuetext`
   * together, because a hatch nothing explains is the same defect one step
   * quieter.
   */
  const upperReading = !bandExceedsFill
    ? undefined
    : value === undefined
      ? fmtPct(upperFraction)
      : upperValue;
  const hasUpper = upperReading !== undefined;
  const upperClamped = bandExceedsFill
    ? Math.min(Math.max(upperFraction, 0), 1)
    : clamped;

  return (
    <div className={sz.root}>
      <div
        className={`flex items-baseline justify-between gap-3 text-xs text-ink-muted ${sz.head}`}
      >
        <span>{label}</span>
        {/* An unknown reading is never scaled up with the size: it is a
            statement that there is no figure, and setting it in the headline
            weight the known reading uses makes absence look like a value. */}
        {/* `shrink-0` on both: the label is prose and the reading is a figure,
            so the label is what gives when the two do not fit on one line. Left
            shrinkable, the reading is a flex item that wraps at its own spaces —
            and this reading's spaces are inside `82.4% – 91.1%`, which broke
            after the en dash at 390px and read as two unrelated figures on two
            lines. The pair is one reading and the dash is what says so. */}
        {known ? (
          <span
            className={`shrink-0 font-semibold tabular-nums text-ink ${sz.value}`}
          >
            {reading}
            {hasUpper && (
              <span className={`font-medium text-ink-muted ${sz.upper}`}>
                {" "}
                – {upperReading}
              </span>
            )}
          </span>
        ) : (
          <span className="shrink-0 text-xs font-medium text-ink-muted">
            {unknownHint}
          </span>
        )}
      </div>
      {/* `uf-meter` on the track itself rather than a second element beside it:
          this is the node carrying `role="progressbar"` and the whole spoken
          reading, and a skin that swapped it for a different box would take the
          accessible widget off the page every time the toolbar was clicked.
          Under the ascii skin the box goes flat and its two fills stop being
          drawn — the element, its role and its value stay exactly where they
          were, and the characters are its aria-hidden child. */}
      <div
        className={`uf-meter relative overflow-hidden rounded-full border border-line bg-inset ${sz.track}`}
        role="progressbar"
        aria-valuenow={known ? Math.round(clamped * 100) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        // Spoken instead of the bare percentage in the two cases where the
        // number alone misleads: no ceiling at all, and a guard reading that
        // sits above the visible bar. The second reads its explanation off the
        // caller — a sighted reader has the hatch, the two readings and the
        // card's own prose to tell the bands apart, and this sentence is all a
        // screen reader gets. It quotes the head's own two readings rather than
        // re-deriving percentages, so the sentence and the screen never name
        // two different quantities.
        aria-valuetext={
          !known
            ? unknownHint
            : hasUpper
              ? `${reading}, up to ${upperReading} ${upperHint}`
              : undefined
        }
        aria-label={label}
      >
        {/* Absolutely positioned so the hatched upper band can sit *behind* the
            solid known-spend bar. As block siblings the second would be laid
            out below the first and clipped away by overflow-hidden. */}
        {hasUpper && (
          <div
            className={`hatched uf-plain absolute inset-y-0 left-0 rounded-full ${FILL_MOTION}`}
            data-unknown="true"
            style={{ width: `${upperClamped * 100}%` }}
          />
        )}
        <div
          className={`uf-plain absolute inset-y-0 left-0 rounded-full ${FILL_MOTION} ${
            known ? SEVERITY_FILL[severityFor(fraction)] : "hatched"
          }`}
          data-sev={known ? severityFor(fraction) : undefined}
          data-unknown={!known}
          style={{
            width: `${clamped * 100}%`,
            minWidth: clamped > 0 ? MIN_VISIBLE_PX : undefined,
          }}
        />
        {/* Handed the *raw* readings, not the clamped pair above: the band is
            only drawn where it genuinely exceeds the fill, and that comparison
            is the caller's two numbers rather than two widths. `hasUpper` and
            not `bandExceedsFill`, so a band the head could not spell is absent
            from the characters exactly as it is from the pixels. */}
        <AsciiBar
          fraction={fraction}
          upperFraction={hasUpper ? upperFraction : null}
          cells={sz.cells}
          className={`text-sm ${known ? SEVERITY_TEXT[severityFor(fraction)] : "text-ink-muted"}`}
        />
      </div>
      {/* `text-ink-muted`, not `text-ink-faint`: this line names the ceiling the
          bar above is measured against, and `--fg-faint` is 3.4:1 on the card
          surface in light and 3.6:1 in dark — under 4.5:1 at 12px in both. */}
      {/* The track spans its card and this line does not, which is `Notice`'s
          split: the bar has to be the card's width to be read against it, and
          this is a sentence. 68ch is the measure `Hint` and `ListRow` already
          state. */}
      {detail && (
        <div className={`max-w-[68ch] text-xs text-ink-muted ${sz.detail}`}>
          {detail}
        </div>
      )}
    </div>
  );
}
