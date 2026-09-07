import { strict as assert } from "node:assert";
import { test } from "node:test";
import { exitHref, leaving, registerLeaveGuard, type ExitClick } from "./unsavedWork";

/**
 * Two decisions here fail silently and neither shows on the page.
 *
 * `exitHref` is what stands between a drawn workflow and a press on the
 * sidebar, and it is wrong in two directions. A click it fails to recognise as
 * a navigation takes the graph with it and says nothing — the failure the
 * prompt exists for. A click it recognises that was never going to leave the
 * page raises a dialog over nothing, which teaches the operator to dismiss the
 * dialog, and the next one they dismiss is the real one. Both look identical to
 * a typechecker, and every branch below is a case a browser produces routinely.
 *
 * `registerLeaveGuard`'s disposer is the other: an effect's cleanup can run
 * after the next page's setup, so a disposer that cleared unconditionally would
 * leave the app with no guard at all while a graph was on screen.
 */

const HERE = "https://uf.example/workflows/new";

function click(over: Partial<ExitClick> = {}): ExitClick {
  return {
    href: "https://uf.example/runs",
    target: "",
    download: false,
    button: 0,
    modified: false,
    defaultPrevented: false,
    here: HERE,
    origin: "https://uf.example",
    ...over,
  };
}

test("a plain click on an in-app link is an exit", () => {
  assert.equal(exitHref(click()), "https://uf.example/runs");
});

test("a click that leaves the page standing is not an exit", () => {
  const staying: Array<[string, Partial<ExitClick>]> = [
    ["a click on nothing that is a link", { href: null }],
    ["a middle click, which opens a tab", { button: 1 }],
    ["a modified click, which opens a tab or a window", { modified: true }],
    ["a download", { download: true }],
    ["a link that opens elsewhere", { target: "_blank" }],
    ["a click something else has already taken", { defaultPrevented: true }],
    ["a fragment on this page", { href: `${HERE}#blocks` }],
    ["this page again", { href: HERE }],
  ];
  for (const [what, over] of staying) {
    assert.equal(exitHref(click(over)), null, `${what} must not prompt`);
  }
});

test("an external link is left to the unload prompt rather than asked twice", () => {
  // It does leave, but by an unload, and `beforeunload` is already registered
  // on the same condition — two dialogs for one navigation is one too many.
  assert.equal(exitHref(click({ href: "https://elsewhere.example/x" })), null);
  assert.equal(exitHref(click({ href: "mailto:someone@example.com" })), null);
  // A host that merely starts with this one's is a different host.
  assert.equal(exitHref(click({ href: "https://uf.example.evil/runs" })), null);
});

test("a target of _self is this window, so it is an exit", () => {
  assert.equal(exitHref(click({ target: "_self" })), "https://uf.example/runs");
});

test("a guard is asked before an exit and answers for it", () => {
  const asked: Array<() => void> = [];
  const dispose = registerLeaveGuard((proceed) => {
    asked.push(proceed);
    return true;
  });
  let went = false;
  leaving(() => {
    went = true;
  });
  assert.equal(went, false, "the exit was taken without asking");
  assert.equal(asked.length, 1);
  asked[0]!();
  assert.equal(went, true, "answering yes did not take the exit");
  dispose();
});

test("a guard with nothing to lose lets the exit through once", () => {
  const dispose = registerLeaveGuard(() => false);
  let went = 0;
  leaving(() => {
    went += 1;
  });
  assert.equal(went, 1);
  dispose();
});

test("a disposer only clears its own registration", () => {
  // The order a route change produces: the arriving page registers before the
  // leaving one's cleanup runs. An unconditional clear here would leave the new
  // page unguarded, which is the defect the prompt exists to prevent.
  const stale = registerLeaveGuard(() => true);
  let asked = false;
  registerLeaveGuard(() => {
    asked = true;
    return true;
  });
  stale();
  leaving(() => void 0);
  assert.equal(asked, true, "the current guard was cleared by an old disposer");
  registerLeaveGuard(() => false)();
});

test("no guard at all is an exit taken straight away", () => {
  let went = false;
  leaving(() => {
    went = true;
  });
  assert.equal(went, true);
});
