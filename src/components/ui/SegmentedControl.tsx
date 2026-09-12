"use client";

import { useId, useRef } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";

export interface SegmentedOption<T extends string> {
  value: T;
  /** Always the accessible name, whether or not it is drawn. */
  label: string;
  icon?: IconName;
}

export type SegmentedLabels = "shown" | "hidden";

/**
 * `hidden` puts the label in the accessibility tree and nowhere else, for a
 * control whose options are glyphs. An option with no icon then renders an
 * empty segment — that is the caller's mistake to avoid, not something this can
 * decide, since a set where only some options have icons is worse than either.
 */
const LABEL_VISIBILITY: Record<SegmentedLabels, string> = {
  shown: "",
  hidden: "sr-only",
};

export type SegmentedState = "selected" | "unselected";

/**
 * Both states carry a border. macOS raises the selected segment as a bezeled
 * chip inside a recessed track, and a chip that gained a 1px border on
 * selection would shift every segment beside it by a pixel — so the unselected
 * one is transparent rather than absent.
 *
 * Weight is constant for the same reason: bolding the selected label changes
 * its width and the whole control reflows on every press.
 *
 * Exported because a second surface draws this vocabulary without being this
 * component: `/settings`' section strip is a `<nav>` of anchors, so it cannot
 * be a radiogroup of buttons, but it is the same object to look at and every
 * treatment it had of its own was one the skin then had to be taught
 * separately. `ButtonLink` sharing `Button`'s `VARIANT` is the same
 * arrangement and the reason is the same one conventions.md gives for it.
 *
 * `not-disabled:` rather than `enabled:` for that sharing: `:enabled` matches
 * form controls and an `<a>` is not one, so on the anchors every hover and
 * press state here would emit and silently never match.
 */
export const SEGMENT: Record<SegmentedState, string> = {
  selected: "border-line bg-bezel text-ink shadow-e1",
  unselected:
    "border-transparent bg-transparent text-ink-muted " +
    "not-disabled:hover:bg-bezel-hover not-disabled:hover:text-ink not-disabled:active:shadow-press",
};

/**
 * One choice from a short, fixed set — the macOS segmented control.
 *
 * A radiogroup rather than a row of toggle buttons, because that is what it is:
 * arrow keys move through the options and select as they go, Home and End reach
 * the ends, and only the selected segment is a tab stop, so the control is one
 * stop in the page's tab order rather than one per option.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  labels = "shown",
  className = "",
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Names the group. A radiogroup with no name is a set of unexplained shapes. */
  label: string;
  labels?: SegmentedLabels;
  className?: string;
}) {
  const groupId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function move(from: number, delta: number) {
    const next = (from + delta + options.length) % options.length;
    onChange(options[next].value);
    // Selection follows focus here, so focus has to follow selection back — a
    // radiogroup that changed value and left the focus behind would announce
    // the wrong option on the next arrow press.
    refs.current[next]?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      move(index, 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      move(index, -1);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(index, -index);
    } else if (e.key === "End") {
      e.preventDefault();
      move(index, options.length - 1 - index);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      // `flex-wrap` below the breakpoint and nowhere else: a five-option group
      // is about 330px of segments, which a 390px phone has almost exactly none
      // of to spare once the pane's own gutter is off — and an `inline-flex`
      // that cannot wrap answers that by pushing the pane sideways, which is the
      // scroll this whole breakpoint exists to remove. It changes nothing above
      // the line, where no group here comes near the width.
      className={`uf-segment-track inline-flex max-md:flex-wrap items-center gap-0.5 rounded-sm border border-line bg-inset p-0.5 ${className}`}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            id={`${groupId}-${option.value}`}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            // Roving tabindex: the group is one stop, and the stop is whichever
            // option is currently chosen.
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={
              // 44px below the shell's breakpoint, against --control-h above
              // it — the app's hit target, applied as an override rather than
              // as a change to the token. See Button's SIZE map.
              //
              // In both axes here, and the width is the half easily missed: a
              // `labels="hidden"` group is a 16px glyph in 10px of padding, so
              // the theme picker's three segments were 38px wide and cleared
              // the floor vertically only. A `min-w` and so a floor rather than
              // a size — the only *labelled* segment it reaches is the runs
              // list's "All" at ~37px — and the same figure in both states, so
              // pressing a segment still moves nothing. `Switch`'s `::after`
              // recipe is not available: segments sit 2px apart, so any bleed
              // would take the tap aimed at the neighbour.
              //
              // The cost lands in one place and is taken deliberately.
              // `ThemeToggle` is three of these on the toolbar, so the strip's
              // right-hand group grows ~20px and the title beside it — the one
              // item there that shrinks — truncates that much sooner. That
              // title is derived from the route and the page under it carries
              // its own <h1>, so what gives way is a duplicate.
              // `uf-segment` brackets the segment under the ascii skin, and it
              // is on the button rather than in either half of SEGMENT because
              // that is the whole point: both states are bracketed, so
              // selection still changes no width and no neighbour moves. The
              // padding the rule gives back is what the two characters cost,
              // for the strip on the toolbar that has five of these at 390px.
              "uf-segment ui-transition inline-flex min-h-[var(--control-h)] max-md:min-h-11 max-md:min-w-11 cursor-pointer " +
              "items-center justify-center gap-1.5 rounded-[4px] border px-2.5 text-sm " +
              `${SEGMENT[selected ? "selected" : "unselected"]}`
            }
          >
            {option.icon && <Icon name={option.icon} />}
            <span className={`uf-segment-label ${LABEL_VISIBILITY[labels]}`}>
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
