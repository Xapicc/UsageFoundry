"use client";

import { useEffect, useState } from "react";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/SegmentedControl";

export type Skin = "standard" | "ascii";

/** Read by the pre-paint script in layout.tsx as well — keep them in step. */
export const SKIN_STORAGE_KEY = "uf-skin";

/**
 * Two segments rather than a switch, to match the control beside this one. A
 * switch would be narrower and would put the two states in different
 * vocabularies — one of them a label, the other the absence of a tick — on a
 * strip where the axis next to it draws its states as peers.
 *
 * Glyphs rather than words for ThemeToggle's reason, and here it is load
 * bearing rather than tidy: the toolbar already fits a sidebar button, a title,
 * quick open, three appearance segments and sometimes an action into 390px, and
 * "Standard ASCII" spelled out is about 100px this strip does not have.
 */
const OPTIONS: readonly SegmentedOption<Skin>[] = [
  { value: "standard", label: "Standard", icon: "text" },
  { value: "ascii", label: "ASCII", icon: "terminal" },
];

/**
 * The skin is a second axis and not a fourth theme: it sets `data-skin` on
 * `<html>` and leaves `data-theme` alone, so ascii-light, ascii-dark and
 * ascii-follows-the-OS are all reachable and switching it on never discards the
 * appearance setting. Offered as a fourth value on ThemeToggle it would have
 * cost both of those.
 *
 * `standard` is the default and is expressed as the *absence* of the attribute,
 * which is what lets the pre-paint script cost nothing for anyone who has never
 * touched this — so the two states are not symmetric in storage even though
 * they are drawn as peers.
 */
export function SkinToggle() {
  // Always renders "standard" on the server and on the first client paint. The
  // pre-paint script has already set the attribute by then, so the DOM is
  // correct; this only catches the state up so the label matches.
  const [skin, setSkin] = useState<Skin>("standard");

  useEffect(() => {
    if (localStorage.getItem(SKIN_STORAGE_KEY) === "ascii") setSkin("ascii");
  }, []);

  function apply(next: Skin) {
    setSkin(next);
    if (next === "ascii") {
      document.documentElement.dataset.skin = next;
      localStorage.setItem(SKIN_STORAGE_KEY, next);
    } else {
      delete document.documentElement.dataset.skin;
      localStorage.removeItem(SKIN_STORAGE_KEY);
    }
  }

  return (
    <SegmentedControl
      options={OPTIONS}
      value={skin}
      onChange={apply}
      label="Skin"
      labels="hidden"
    />
  );
}
