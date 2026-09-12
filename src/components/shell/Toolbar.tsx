"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { SkinToggle } from "@/components/SkinToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { AsciiEdge } from "@/components/ui/AsciiFrame";
import { SIDEBAR_DRAWER_ID, SIDEBAR_ID } from "@/components/shell/Sidebar";
import { toolbarAction, toolbarTitle } from "@/components/shell/panes";

/**
 * The strip at the top of the content pane: what you are looking at, and the
 * one place this pane can send you next.
 *
 * Its height is a *floor*, not a height. In an installed window with Window
 * Controls Overlay the browser hands the page the whole title bar and states
 * where its own buttons are in `env(titlebar-area-*)`; the strip keeps clear
 * of them on both sides, because they are on the left on macOS and on the
 * right everywhere else. In an ordinary tab every one of those values falls
 * back to a figure that makes each `max()` pick the plain padding, so nothing
 * here branches on which case it is in — which matters, because the tab is
 * the only case that could be checked from this container.
 *
 * The empty part of the strip drags the window; every control on it says
 * `app-no-drag`, because a drag region swallows the pointer press.
 */
export function Toolbar({
  sidebarCollapsed,
  onToggleSidebar,
  drawerOpen,
  onToggleDrawer,
  onQuickOpen,
}: {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  onQuickOpen: () => void;
}) {
  const pathname = usePathname();
  const action = toolbarAction(pathname);

  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const appearanceId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const discloseRef = useRef<HTMLDivElement>(null);

  /**
   * Esc, and a press anywhere outside, close the appearance panel.
   *
   * Both listeners exist only while it is open, and neither can race the two
   * `<dialog>`s the shell already owns: those are modal, so the strip behind
   * them is inert and the button that opens this cannot be pressed while either
   * is up. That is also why AppShell's "Esc is not bound here" reasoning is
   * untouched — this key never reaches a frame where a dialog also wants it.
   */
  useEffect(() => {
    if (!appearanceOpen) return;

    function close() {
      // Focus goes back to what opened it, or it is left on a segment that this
      // same state change turns into `display: none` — and a keyboard then
      // starts its next Tab from the top of the document.
      if (panelRef.current?.contains(document.activeElement)) {
        discloseRef.current?.querySelector("button")?.focus();
      }
      setAppearanceOpen(false);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }

    function onPointerDown(e: PointerEvent) {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      // The button's own click already toggles. Closing on its pointerdown as
      // well would close and immediately reopen, on every press.
      if (discloseRef.current?.contains(target)) return;
      close();
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [appearanceOpen]);

  return (
    <header
      // The title is the only item here that shrinks (`min-w-0 truncate`, and
      // the group on the right is `shrink-0`), so the strip is one row at any
      // width — the tighter gap below the breakpoint is what it has left to
      // give back to the title before it starts eating words.
      //
      // `relative` is the appearance panel's containing block, and it is
      // load-bearing only in the *default* skin: `uf-framed` states the same
      // thing under ascii, so without this the panel resolved against the
      // initial containing block in one skin and against the strip in the
      // other.
      className={
        // The sidebar's pair, for the sidebar's reason: the underline becomes a
        // row of `─` and the 1px one stops being drawn, without either of them
        // changing the strip's height.
        "app-drag uf-framed uf-unboxed relative flex shrink-0 items-center gap-3 border-b border-line " +
        // Below the breakpoint the source list is a drawer, so it is absorbing
        // none of the window's left edge and the sum below must subtract
        // nothing. An installed window narrowed past this point is the only
        // case that reaches it, and it fails silently: the subtraction stays
        // negative, the max() keeps picking the 12px padding, and the first
        // button on the strip sits under the traffic lights.
        "bg-canvas max-md:gap-2 max-md:[--sidebar-w-absorbed:0px]"
      }
      style={{
        height: "var(--toolbar-actual)",
        // The traffic lights are measured from the *window's* left edge, and
        // the sidebar has already absorbed that much of it. What is left over
        // is what this strip has to keep clear — nothing on macOS with the
        // list open, 22px when it is a 56px rail.
        paddingLeft:
          "max(0.75rem, calc(env(titlebar-area-x, 0px) - var(--sidebar-w-absorbed)))",
        // And the same sum from the other end, which is where Windows and
        // Linux put the window's buttons. The fallbacks are chosen so the
        // subtraction is exactly zero when the browser answers nothing.
        paddingRight:
          "max(0.75rem, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)))",
      }}
    >
      <AsciiEdge side="bottom" />

      {/* Two controls in the same place, because the one button does two
          different things either side of the breakpoint: above it there is a
          docked source list to collapse to a rail, below it there is no docked
          list at all and the button opens the drawer. Which one is showing is a
          media query rather than a `matchMedia` read, because a JS branch here
          would be a second place the boundary is written *and* would render the
          wrong control on the first paint. Each states what it actually
          controls: two elements, two ids, two `aria-expanded` meanings. */}
      <Button
        variant="ghost"
        size="compact"
        onClick={onToggleSidebar}
        aria-expanded={!sidebarCollapsed}
        aria-controls={SIDEBAR_ID}
        aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        className="app-no-drag max-md:hidden"
      >
        <Icon name="sidebar" />
      </Button>

      <Button
        variant="ghost"
        size="compact"
        onClick={onToggleDrawer}
        aria-expanded={drawerOpen}
        aria-controls={SIDEBAR_DRAWER_ID}
        aria-label={drawerOpen ? "Hide navigation" : "Show navigation"}
        className="app-no-drag md:hidden max-md:min-h-11 max-md:min-w-11"
      >
        <Icon name="sidebar" />
      </Button>

      {/* Not a heading: every page still carries its own <h1>, and a second one
          up here would put two titles in the document outline.

          It is meant to be the item that gives way, and the figure to hold on
          to is how little is left. At 390px on `/` in the ascii skin — where
          three bracketed icon buttons cost 55.8px over the default skin's —
          this has 52.7px against a natural 59 and draws "Dashbo…". Every other
          route and the whole of the default skin draw it in full. That 6.3px
          is the entire headroom on this strip, so anything added to the
          right-hand group spends it and starts eating words. What spending it
          past zero looks like is the failure this replaced, and it is worth
          knowing by sight: `min-w-0` shrinks to nothing, and the title is then
          silently not drawn at all rather than truncating. */}
      <div className="min-w-0 truncate text-sm font-semibold text-ink">
        {toolbarTitle(pathname)}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {/* The chord is on the control, so the binding is discoverable without
            a shortcuts sheet nobody opens — and announced, so it is not only
            discoverable by sight. */}
        <Button
          variant="secondary"
          size="compact"
          onClick={onQuickOpen}
          aria-keyshortcuts="Meta+K"
          className="app-no-drag max-md:min-h-11 max-md:min-w-11"
        >
          <Icon name="search" />
          {/* Below the breakpoint the strip has a sidebar button, a title, this,
              the appearance disclosure and sometimes New run to fit in 390px,
              and this is the one of them whose label can go without a
              destination going with it. It is still the tightest route on the
              strip — see the appearance pair below for the measurement — so the
              label stays gone even though the pickers moved.
              The words go to the accessibility tree rather than away,
              for the rail's reason — the glyph is then the only thing naming
              the control. The chord goes entirely: there is no ⌘ key on a phone,
              and `aria-keyshortcuts` above already carries it for anyone who
              has one. */}
          <span className="max-md:sr-only">Quick open</span>
          <kbd className="uf-kbd mono rounded-[4px] border border-line bg-inset px-1 text-2xs text-ink-faint max-md:hidden">
            ⌘K
          </kbd>
        </Button>

        {/* The appearance pair is what gives way at 390px, and it is the only
            thing on this strip that can.

            Measured on `/` in the ascii skin at 390px, at natural widths: 24px
            of padding, a 59.8px drawer button, a 64px quick open, 142px of
            theme segments, 96px of skin segments, a 93.5px New run and five
            8px gaps want 519.3px of a 390px window — before the title is given
            a pixel. (Read a *narrower* drawer button off the broken layout and
            it is the overflow you are measuring: that button carries no
            `shrink-0`, so it was being squeezed to its 44px hit-target floor,
            which is the second thing on this strip that was silently giving
            way.)

            Everything else here was tried against that 129.3px first and none
            of it reaches: hiding the route title recovers one gap — 8px — and
            dropping New run as well is still 19.8px over, while dropping
            either picker instead makes the skin a one-way trap for anyone who
            set ascii on a desktop. Only moving both pickers off the row fits.
            It saves 254px and spends 72px back on the disclosure, which is
            what puts the title on screen as well.

            It is also the right one to move on grounds other than arithmetic.
            This strip's job — see the top of this file — is what you are
            looking at and the one place this pane can send you next. A picker
            you touch once and a picker you may never touch are neither, and
            between them they were taking 65% of a phone's toolbar and evicting
            both of the things the strip exists for.

            What it costs is one press on a phone. What it deliberately does not
            cost: `data-theme` and `data-skin` stay two axes, all six
            combinations stay reachable, neither control changes, and neither is
            duplicated — `md:contents` means this element has no box above the
            breakpoint and its two children are the strip's own flex items,
            exactly as before. A second copy in the drawer was the obvious
            alternative and is the one thing that must not be done: both would
            be mounted at once, each mirrors the stored value in its own state,
            and turning a phone to landscape crosses 768px and reveals whichever
            copy was not the one you pressed, still showing the old answer. */}
        <div ref={discloseRef} className="app-no-drag md:hidden">
          <Button
            variant="secondary"
            size="compact"
            onClick={() => setAppearanceOpen((open) => !open)}
            aria-expanded={appearanceOpen}
            aria-controls={appearanceId}
            aria-label="Appearance and skin"
            className="max-md:min-h-11 max-md:min-w-11"
          >
            <Icon name="contrast" />
          </Button>
        </div>

        {/* Two axes, two controls, in the order they were added: the colour
            scheme and then the skin. They are independent — neither reads the
            other's attribute — so there is nothing to group them into beyond
            the strip's own gap. */}
        <div
          id={appearanceId}
          ref={panelRef}
          // No `AsciiFrame` on the panel, and that is not an oversight: the
          // frame is `absolute inset-0` and carries no `display` of its own by
          // decision, so above the breakpoint — where this element is
          // `contents` and has no box for it to line — it would resolve against
          // the strip and draw a character frame around the whole toolbar.
          className={
            "app-no-drag md:contents " +
            (appearanceOpen
              ? "max-md:absolute max-md:right-3 max-md:top-full max-md:z-20 " +
                "max-md:mt-1 max-md:flex max-md:flex-col max-md:items-end " +
                "max-md:gap-2 max-md:rounded-md max-md:border max-md:border-line " +
                "max-md:bg-surface max-md:p-2 max-md:shadow-e2"
              : "max-md:hidden")
          }
        >
          <div className="app-no-drag">
            <ThemeToggle />
          </div>

          <div className="app-no-drag">
            <SkinToggle />
          </div>
        </div>

        {action && (
          <ButtonLink
            href={action.href}
            variant="secondary"
            size="compact"
            className="app-no-drag"
          >
            {action.label}
          </ButtonLink>
        )}
      </div>
    </header>
  );
}
