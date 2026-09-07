/**
 * Leaving a page that has work in it, and every way of doing so.
 *
 * **`beforeunload` covers one exit out of five.** It is the browser's only hook
 * for this and it fires on a closed tab, a reload and a typed URL — never on a
 * client-side navigation, which is how this app leaves a page the other four
 * times: a link in the sidebar, a link in the page, ⌘1…⌘9, and quick open. The
 * last two are `router.push` calls in the shell, so the page holding the work
 * cannot see them at all, and the first two are anchors React has already
 * claimed the click on.
 *
 * So the page with something to lose registers a guard here and the exits ask
 * it. The guard, not this module, decides whether there is anything to lose —
 * one registration that is asked each time beats a flag two places have to keep
 * in step.
 *
 * Deliberately **not** on `globalThis`, against the usual rule: this is one
 * browser document's state, written only from an effect, so there is no server
 * instance to share it with and nothing that should survive the page. The
 * registration is remade on every mount, which is what makes a hot reload
 * self-healing rather than something a stale key would outlive.
 */

/**
 * What a page with unsaved work does when something tries to leave it.
 *
 * Returns true when it has taken the exit over: it has asked the operator, and
 * it will call `proceed` itself if the answer is yes. False is "nothing to lose
 * right now" and the caller goes.
 */
export type LeaveGuard = (proceed: () => void) => boolean;

let guard: LeaveGuard | null = null;

/** Registered by the page that has the work; the return value unregisters it. */
export function registerLeaveGuard(next: LeaveGuard): () => void {
  guard = next;
  return () => {
    // Only if it is still ours. An effect's cleanup can run after another
    // page's setup — StrictMode's double invoke and a route change both do it —
    // and an unconditional clear would drop a registration that is current.
    if (guard === next) guard = null;
  };
}

/**
 * Every in-app exit goes through this, including the ones with nothing to ask.
 *
 * A guard that returns false has answered, so `proceed` runs here rather than
 * in the guard: a caller that has to run it on one branch and not the other is
 * a caller that will one day navigate twice.
 */
export function leaving(proceed: () => void): void {
  if (guard?.(proceed)) return;
  proceed();
}

/** A click, reduced to what deciding about it needs. */
export interface ExitClick {
  /**
   * The clicked anchor's resolved `href`, or null when the click was not on
   * one. `HTMLAnchorElement.href` is always absolute, which is what makes the
   * origin and same-page tests below string comparisons.
   */
  href: string | null;
  /** The anchor's `target`; `""` when it has none. */
  target: string;
  download: boolean;
  /** `MouseEvent.button` — 0 is the primary one. */
  button: number;
  /** ⌘, Ctrl, Shift or Alt held. */
  modified: boolean;
  defaultPrevented: boolean;
  /** `location.href` and `location.origin` as the click was made. */
  here: string;
  origin: string;
}

/** Everything after the fragment is the same document, so it is not an exit. */
function withoutHash(url: string): string {
  const cut = url.indexOf("#");
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Where this click is about to take the page, or null if it is not taking it
 * anywhere the page would not survive.
 *
 * Every null is a case that must **not** prompt, and each is a different way of
 * not leaving: a modified or non-primary click opens a tab or a window and the
 * editor stays exactly where it is; a `target` or a `download` does the same; a
 * fragment moves the scroll; and an external URL does leave, but by an unload
 * that `beforeunload` already covers, so prompting here would ask twice. A
 * click something else has already handled is not this page's to take over.
 *
 * A returned href is an in-app navigation and the caller has to stop the event
 * *and* its propagation: `next/link` reads neither `defaultPrevented` nor the
 * bubble order, so preventing the default alone leaves the router push intact.
 */
export function exitHref(click: ExitClick): string | null {
  if (click.defaultPrevented) return null;
  if (click.button !== 0) return null;
  if (click.modified) return null;
  if (click.href === null || click.download) return null;
  if (click.target !== "" && click.target !== "_self") return null;
  if (!click.href.startsWith(`${click.origin}/`)) return null;
  if (withoutHash(click.href) === withoutHash(click.here)) return null;
  return click.href;
}
