import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Card, CardTitle } from "./Card";
import { AsciiFrame } from "./AsciiFrame";
import { Switch } from "./Field";
import { StatusMark } from "../StatusMark";

/**
 * One rule, and it is the whole reason this component is allowed to exist:
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
