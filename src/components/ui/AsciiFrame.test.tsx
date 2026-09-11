import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Card, CardTitle } from "./Card";
import { AsciiEdge, AsciiFrame } from "./AsciiFrame";
import { AsciiArt, MARK, WORDMARK } from "./AsciiArt";
import { Switch } from "./Field";
import { StatusMark } from "../StatusMark";

/**
 * Two rules. The first is the whole reason this component is allowed to exist:
 * **nothing the ascii skin draws may reach the accessibility tree.**
 *
 * A card's frame is 1,600 characters. A screen reader that reaches one reads
 * "box drawings light horizontal" four hundred times before the heading it was
 * asked for — and the page it happens on looks pixel-identical, typechecks,
 * and passes `smoke-pages`, which asserts a 200 and no sideways scroll and
 * cannot see an accessible name at all. Every instrument this repository has
 * is blind to it, which is what earns a test rather than a comment.
 *
 * The other half is the pair: each of these marks is drawn twice, once as a
 * shape and once as characters, with `globals.css` turning one off. Both are
 * in the DOM at once on every page, under both skins, so both have to be
 * hidden — the CSS that hides one of them is not what keeps it quiet.
 *
 * The second rule is one file over and is why it is pinned here rather than
 * left to the comments on both ends of it: `globals.css` corrects this frame's
 * inset for a host that still carries the border `uf-unboxed` only paints out,
 * and it does that through a selector — `.uf-unboxed > .uf-ascii-frame` — whose
 * two halves are written in two other files. Rename either class, or stop
 * rendering the frame as the host's own child, and the rule matches nothing:
 * no throw, no type error, the page renders, and every framed box in the app
 * quietly goes back to drawing its edge a pixel inside itself. That is the
 * defect `docs/verification.md` records shipping app-wide twice already, each
 * time caught only by reading device pixels off a screenshot by hand.
 */

/**
 * The text a reader is left with: every `aria-hidden` subtree dropped whole,
 * then the tags taken off what remains.
 *
 * Text rather than markup, because every character these components draw —
 * `x`, `+`, `/`, `[` — also occurs in a Tailwind class name, and a check run
 * against the markup reads `inline-flex` as a status mark. Comparing the text
 * to what the component is *supposed* to announce is both stricter and honest.
 */
function accessibleText(markup: string): string {
  let kept = "";
  let i = 0;
  for (;;) {
    const hidden = markup.indexOf('aria-hidden="true"', i);
    if (hidden === -1) {
      kept += markup.slice(i);
      return kept.replace(/<[^>]*>/g, "").trim();
    }
    const start = markup.lastIndexOf("<", hidden);
    kept += markup.slice(i, start);
    i = endOfElement(markup, start);
  }
}

/** The index just past the element opening at `start`, children included. */
function endOfElement(markup: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < markup.length) {
    const open = markup.indexOf("<", i);
    const close = markup.indexOf(">", open);
    if (open === -1 || close === -1) break;
    const tag = markup.slice(open, close + 1);
    // `<circle …/>` opens and closes at once; anything else moves the depth.
    if (tag.startsWith("</")) depth -= 1;
    else if (!tag.endsWith("/>")) depth += 1;
    if (depth === 0) return close + 1;
    i = close + 1;
  }
  throw new Error(`unbalanced markup from index ${start}`);
}

/** The repository root, found the way `deployment.test.ts` finds it. */
function repoRoot(): string {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, `no package.json above ${__dirname}`);
    dir = parent;
  }
  return dir;
}

/** The first two element openings in a fragment: the root, then its first child. */
function rootAndFirstChild(markup: string): [string, string] {
  const tags = markup.match(/<[a-z][^>]*>/g);
  assert.ok(tags !== null && tags.length >= 2, "expected a root with a child element");
  return [tags[0], tags[1]];
}

function classesOn(tag: string): string[] {
  const attribute = /class="([^"]*)"/.exec(tag);
  return attribute === null ? [] : attribute[1].split(/\s+/);
}

test("the skin's border correction still has the two ends it is written between", () => {
  // Read out of the stylesheet rather than spelled again here, so the test
  // cannot pass against a selector that has been edited or deleted — the whole
  // failure being guarded is the two halves drifting apart.
  const css = fs.readFileSync(path.join(repoRoot(), "src/app/globals.css"), "utf8");
  const rule = /:root\[data-skin="ascii"\]\s+\.([\w-]+)\s*>\s*\.([\w-]+)\s*\{\s*inset:/.exec(css);
  assert.ok(
    rule !== null,
    "globals.css no longer carries an `inset` rule for a framed host's own border",
  );
  const [, hostClass, frameClass] = rule;

  const [root, firstChild] = rootAndFirstChild(
    renderToStaticMarkup(
      <Card>
        <CardTitle>Current 5-hour window</CardTitle>
      </Card>,
    ),
  );
  assert.ok(
    classesOn(root).includes(hostClass),
    `a card no longer says .${hostClass}, so the correction stops applying to it`,
  );
  assert.ok(
    classesOn(firstChild).includes(frameClass),
    `the frame is no longer the card's own .${frameClass} child, which is all the rule selects`,
  );
});

test("a card's frame never reaches the accessibility tree", () => {
  const markup = renderToStaticMarkup(
    <Card>
      <CardTitle>Current 5-hour window</CardTitle>
    </Card>,
  );
  assert.match(markup, /─/, "the frame is in the DOM under both skins");
  assert.equal(
    accessibleText(markup),
    "Current 5-hour window",
    "and a reader is left with the heading and nothing else",
  );
});

test("the frame is hidden at its root, not one node at a time", () => {
  // Both fills and all four corners hang off one `aria-hidden`. Hiding them
  // individually would pass the test above and still leave a *second* frame
  // added later announcing itself, so this pins where the attribute sits.
  const markup = renderToStaticMarkup(<AsciiFrame />);
  assert.match(markup, /^<span aria-hidden="true"/);
});

test("both halves of a status mark are hidden, not just the one on screen", () => {
  for (const status of ["running", "failed", "needs-review"] as const) {
    const markup = renderToStaticMarkup(<StatusMark status={status} />);
    assert.equal(
      accessibleText(markup),
      "",
      `${status} announces its shape beside the word that already says it`,
    );
  }
});

test("a switch reports its state with aria-checked and never with `[x]`", () => {
  // A `ListRow` names most of these switches rather than a `label` prop, so a
  // `[x]` left visible to a reader becomes the control's own accessible name
  // and the row's label stops being read.
  for (const checked of [true, false]) {
    const markup = renderToStaticMarkup(
      <Switch checked={checked} onChange={() => {}} label="Read plan usage" />,
    );
    assert.match(markup, /aria-checked="(true|false)"/);
    assert.equal(accessibleText(markup), "");
  }
});

test("the shell's edges and its wordmark leave a reader nothing to hear", () => {
  // Higher stakes than the boxes above, and the same mechanism: these three
  // are in the *shell*, so whatever they announce is announced on all 22
  // routes rather than on the one page that drew a card. The wordmark alone is
  // 528 block characters, and it is the app's name — exactly the art a later
  // edit is tempted to let carry the accessible name. It may not: the sidebar's
  // own "UsageFoundry" text does, which is why that label is `sr-only` on the
  // collapsed rail rather than removed.
  for (const [what, element] of [
    ["the source list's edge", <AsciiEdge side="right" />],
    ["the toolbar's underline", <AsciiEdge side="bottom" />],
    ["the wordmark", <AsciiArt art={WORDMARK} />],
    ["the mark", <AsciiArt art={MARK} />],
  ] as const) {
    assert.equal(
      accessibleText(renderToStaticMarkup(element)),
      "",
      `${what} is announced on every page in the app`,
    );
  }
});

test("a gap in the art is a transparent block, never a space", () => {
  // The one invariant here that nothing else enforces, and the whole reason
  // `AsciiArt.tsx` exists rather than the marketing site's file being copied:
  // a space is *half* the width of a block on the fallback face this app gets
  // for U+2580–259F — see the character-art bullet in
  // docs/agent/conventions.md for the measurement — so a single literal space
  // puts every letter after it in the wrong column. It is one character away
  // from being undone by an edit that looks like a simplification.
  //
  // The art's other invariant, that no row is short, needs no test: `toArt`
  // throws on one, the art is a module-level constant, so a ragged row takes
  // this file's own import down and every test in it with it.
  for (const [name, art] of [
    ["WORDMARK", WORDMARK],
    ["MARK", MARK],
  ] as const) {
    assert.ok(art.cols > 0, `${name} has no columns`);
    for (const [y, runs] of art.rows.entries()) {
      for (const run of runs) {
        assert.match(
          run.cells,
          /^█+$/,
          `${name} row ${y} emits something other than U+2588`,
        );
      }
    }
  }
});
