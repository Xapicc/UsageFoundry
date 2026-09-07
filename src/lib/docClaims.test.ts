import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * The completeness claims in `CLAUDE.md` and `docs/agent/`, held against the
 * code they are about — the sentences that say "there are 22 tables", "the list
 * is closed at ten", "all five", "which is the whole of that class".
 *
 * Not pure functions, and they earn a place here on the grounds the rest of
 * this suite exists for: the failure is silent. A claim decays the moment
 * somebody adds the thing it did not count, and nothing throws, nothing fails
 * to typecheck and the sentence still reads as authoritative — which is worse
 * than no sentence, because an enumeration that says of itself that it is
 * complete is the shape that makes a reader stop looking. `CLAUDE.md` routes
 * every editor of `src/lib/` to one of these documents *before* they touch the
 * code, so the reader being misled is the next agent making a change.
 *
 * It has been paid by hand instead, one issue at a time: #123, #124, #133,
 * #136, #140, #150, #151, #153, #161, #162, #163, #166, #169, #174, #175 and
 * #176 are each one count, one enumeration or one name in a document corrected
 * by a person, and #144, #152 and #154 are indexes of sweeps for more of them.
 * Three were checked against the tree when this file was written and two had
 * drifted again — #161's table list, closed at "22 tables, migrate() creates
 * 24", stood at 34; #166's globalThis grep, closed at "it misses two live
 * keys", missed five. A sweep finds them once. This fails the suite the next
 * time.
 *
 * **Every number asserted here is read out of the document.** Nothing below
 * hard-codes 34, or ten, or five: each case lifts the claim from the prose with
 * a regex and compares it against a measurement of the tree, so the only way to
 * clear a failure is to correct the sentence a reader will act on. Editing the
 * assertion instead fixes nothing, and the messages say so.
 *
 * What is deliberately not pinned: claims about intent, claims about *kinds*
 * rather than counts, and readings that carry their own date.
 * `docs/agent/testing.md`'s `# 109 as this is written` is the second idiom this
 * repository uses for the same problem, and it does not decay because it never
 * claimed to be current. Only a claim about a countable thing in the tree can
 * be pinned, and adding one here is a decision about that claim rather than a
 * pattern to apply to the rest of the prose.
 */

function repoRoot(): string {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, `no package.json above ${__dirname}`);
    dir = parent;
  }
  return dir;
}

const root = repoRoot();

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

/** Every TypeScript file under `src/`, which is what the claims below count. */
function sourceFiles(): { rel: string; text: string }[] {
  const found: { rel: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        found.push({ rel: path.relative(root, full), text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(path.join(root, "src"));
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

const sources = sourceFiles();

/**
 * The failure message every case here produces. It names the document, quotes
 * the claim as the document makes it and states what the tree says instead,
 * because `expected 22 to equal 34` sends the next reader looking for a bug in
 * the code rather than a sentence to correct.
 */
function stale(doc: string, claim: string, tree: string): string {
  return [
    `${doc} carries a completeness claim the tree no longer supports.`,
    `  the document says: ${claim}`,
    `  the tree says:     ${tree}`,
    `  Correct the sentence in ${doc}. This assertion reads the claim out of`,
    "  the document, so changing the number here instead fixes nothing.",
  ].join("\n");
}

/**
 * A reworded claim must fail loudly rather than pass vacuously: a regex that
 * stops matching is the one way this whole file could go quiet while every
 * claim it names rots.
 */
function claimIn(doc: string, text: string, pattern: RegExp): RegExpExecArray {
  const match = pattern.exec(text);
  assert.ok(
    match,
    `${doc} no longer contains the claim this case pins:\n  ${pattern}\n` +
      "  If the sentence was reworded, update the pattern here so the claim stays\n" +
      "  pinned. If it was deleted, delete this case with it.",
  );
  return match;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

function spelledNumber(doc: string, word: string): number {
  const value = NUMBER_WORDS[word.toLowerCase()];
  assert.ok(
    value !== undefined,
    `${doc} spells a count as "${word}", which this test has no reading for. ` +
      "Add it to NUMBER_WORDS.",
  );
  return value;
}

describe("docs/agent/architecture.md's db.ts table list", () => {
  const doc = "docs/agent/architecture.md";
  const architecture = read(doc);
  const dbSource = read("src/lib/db.ts");
  const created = [
    ...new Set(
      [...dbSource.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((match) => match[1]),
    ),
  ].sort();

  // The entry says of itself that it is a completeness claim and hands the
  // reader a command to check it with, which is the strongest form of the
  // failure this file exists for: a list that invites trust and had grown
  // twelve short before anything re-measured it.
  it("names every table migrate() creates, and no table it does not", () => {
    const claim = claimIn(
      doc,
      architecture,
      /every table migrate\(\) creates, and there are (\d+) —([\s\S]*?)\. The list is a\s+completeness claim/,
    );
    const listed = claim[2].split(/[\s,]+/).filter(Boolean).sort();

    assert.equal(
      listed.length,
      Number(claim[1]),
      stale(
        doc,
        `"there are ${claim[1]}" tables`,
        `the entry's own list names ${listed.length} — the sentence and the list beneath it disagree`,
      ),
    );

    const missing = created.filter((table) => !listed.includes(table));
    const surplus = listed.filter((table) => !created.includes(table));
    assert.ok(
      missing.length === 0 && surplus.length === 0,
      stale(
        doc,
        `the db.ts entry lists ${listed.length} tables and calls the list a completeness claim`,
        `src/lib/db.ts creates ${created.length}` +
          (missing.length ? `; created but not listed: ${missing.join(", ")}` : "") +
          (surplus.length ? `; listed but not created: ${surplus.join(", ")}` : ""),
      ),
    );
  });

  // The clause beside the list, which is a claim about the *wrong* way to count
  // and has held through twelve schema changes while the number above it did
  // not. Two comment lines quote the statement; every other line creates a
  // table, so the gap between the two counts is the part that must stay two.
  it("states what a plain grep -c over db.ts answers, and why it differs", () => {
    const claim = claimIn(doc, architecture, /`grep -c` says (\d+) and counts two comments/);
    const lines = dbSource
      .split("\n")
      .filter((line) => line.includes("CREATE TABLE IF NOT EXISTS")).length;

    assert.equal(
      lines,
      Number(claim[1]),
      stale(
        doc,
        `a plain \`grep -c\` over src/lib/db.ts "says ${claim[1]}"`,
        `${lines} lines carry the statement`,
      ),
    );
    assert.equal(
      lines - created.length,
      2,
      stale(
        doc,
        'the two counts differ because grep -c "counts two comments"',
        `${lines} lines carry the statement against ${created.length} tables, a difference of ${
          lines - created.length
        }`,
      ),
    );
  });
});

describe("the globalThis key roster in CLAUDE.md and docs/agent/conventions.md", () => {
  // A key is *declared* where it is named as a member of the cast's object
  // type. Counting every mention instead counts the three retired names the
  // comments warn about reusing, which is how a hand count reaches 59 for a
  // roster of 56.
  const declaration = /(?<![A-Za-z0-9_])(__uf[A-Za-z0-9_]+)\s*\??\s*:/g;
  const sites = new Map<string, { rel: string; line: number; context: string }[]>();
  for (const { rel, text } of sources) {
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(declaration)) {
        // The cast opening the type literal can sit up to three lines above the
        // member, so what the documented grep has to reach is the declaration's
        // neighbourhood rather than its own line.
        const context = lines.slice(Math.max(0, index - 3), index + 1).join("\n");
        sites.set(match[1], [...(sites.get(match[1]) ?? []), { rel, line: index + 1, context }]);
      }
    });
  }

  function keysMissedBy(pattern: string): string[] {
    return [...sites.entries()]
      .filter(([, where]) => !where.some((site) => site.context.includes(pattern)))
      .map(([key, where]) => `${key} (${where[0].rel}:${where[0].line})`)
      .sort();
  }

  const DECADE_WORDS: Record<string, number> = {
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
  };

  /**
   * Both documents state the roster's size as a decade — "thirty-odd" — so what
   * a reader acts on is the tens digit, and that is what is asserted. The
   * looseness is the claim's own: it is wrong when the count leaves the decade
   * it names, and it had been wrong by a factor of two.
   */
  function assertDecade(doc: string, word: string): void {
    const decade = DECADE_WORDS[word.toLowerCase()];
    assert.ok(
      decade !== undefined,
      `${doc} spells the roster's size as "${word}-odd", which this test has no ` +
        "reading for. Add it to DECADE_WORDS.",
    );
    assert.ok(
      sites.size >= decade && sites.size < decade + 10,
      stale(
        doc,
        `there are "${word}-odd" globalThis keys`,
        `src/ declares ${sites.size}`,
      ),
    );
  }

  it("CLAUDE.md's grep finds every key, and names the right decade", () => {
    const doc = "CLAUDE.md";
    const claim = claimIn(
      doc,
      read(doc),
      /`grep -rn "([^"]+)" src\/` finds the ([a-z]+)-odd keys already there/,
    );
    const missed = keysMissedBy(claim[1]);
    assert.ok(
      missed.length === 0,
      stale(
        doc,
        `\`grep -rn "${claim[1]}" src/\` finds the keys already there`,
        `it reaches none of these ${missed.length}, which use another cast idiom:\n` +
          missed.map((key) => `                     ${key}`).join("\n"),
      ),
    );
    assertDecade(doc, claim[2]);
  });

  it("conventions.md's grep finds every one, and names the right decade", () => {
    const doc = "docs/agent/conventions.md";
    const claim = claimIn(
      doc,
      read(doc),
      /there are ([a-z]+)-odd such keys and `grep -rn "([^"]+)" src\/` finds every one/,
    );
    const missed = keysMissedBy(claim[2]);
    assert.ok(
      missed.length === 0,
      stale(
        doc,
        `\`grep -rn "${claim[2]}" src/\` "finds every one"`,
        `it reaches none of these ${missed.length}, which use another cast idiom:\n` +
          missed.map((key) => `                     ${key}`).join("\n"),
      ),
    );
    assertDecade(doc, claim[1]);
  });
});

describe("docs/agent/conventions.md's pane list", () => {
  const doc = "docs/agent/conventions.md";
  const conventions = read(doc);

  // #163 was this list drifting once already, and it is the claim with the
  // hardest ceiling behind it: ⌘1…⌘9 is nine digits, so an eleventh row is two
  // panes with no shortcut and a vocabulary sentence that no longer describes
  // the file it points at.
  it("is closed at the number of rows panes.ts holds", () => {
    const claim = claimIn(doc, conventions, /the list is closed at ([a-z]+), because/);
    const panes = read("src/components/shell/panes.ts");
    const literal = claimIn(
      "src/components/shell/panes.ts",
      panes,
      /export const PANES: readonly Pane\[\] = \[([\s\S]*?)\n\];/,
    );
    const rows = [...literal[1].matchAll(/\{\s*href:/g)].length;

    assert.equal(
      spelledNumber(doc, claim[1]),
      rows,
      stale(
        doc,
        `the pane list is "closed at ${claim[1]}"`,
        `src/components/shell/panes.ts holds ${rows} rows`,
      ),
    );
  });

  it("counts the modules that read panes.ts", () => {
    const claim = claimIn(doc, conventions, /and ([a-z]+) things read that file/);
    const readers = sources
      .filter(({ rel }) => rel !== path.join("src", "components", "shell", "panes.ts"))
      .filter(({ text }) => /from "[^"]*\bpanes"/.test(text))
      .map(({ rel }) => rel);

    assert.equal(
      spelledNumber(doc, claim[1]),
      readers.length,
      stale(
        doc,
        `"${claim[1]} things read that file"`,
        `${readers.length} import it: ${readers.join(", ")}`,
      ),
    );
  });
});

describe("docs/agent/security.md's environment scrubs", () => {
  const doc = "docs/agent/security.md";

  // The sentence beside this one is "**A sixth spawn site adds a sixth copy; it
  // does not add a shared module.**" — the doc anticipates the decay and says
  // what to do about it, and this is what tells anybody that the sixth has
  // arrived. Test files are excluded because the claim is about spawn sites,
  // and a test asserting on the name is not one.
  it("counts the copies that strip a second provider's credential", () => {
    const claim = claimIn(
      doc,
      read(doc),
      /`OPENAI_API_KEY` and `CODEX_API_KEY` are on all ([a-z]+) and reach none of them/,
    );
    const scrubs = (variable: string) =>
      sources
        .filter(({ rel }) => !/\.test\.tsx?$/.test(rel))
        .filter(({ text }) => text.includes(`=== "${variable}"`))
        .map(({ rel }) => rel);
    const openai = scrubs("OPENAI_API_KEY");
    const codex = scrubs("CODEX_API_KEY");

    assert.deepEqual(
      openai,
      codex,
      stale(
        doc,
        "`OPENAI_API_KEY` and `CODEX_API_KEY` are on the same copies",
        `OPENAI_API_KEY is in ${openai.join(", ")}; CODEX_API_KEY is in ${codex.join(", ")}`,
      ),
    );
    assert.equal(
      spelledNumber(doc, claim[1]),
      openai.length,
      stale(
        doc,
        `both are "on all ${claim[1]}" environment copies`,
        `${openai.length} strip them: ${openai.join(", ")}`,
      ),
    );
  });
});

describe("docs/agent/testing.md's rendering tests", () => {
  const doc = "docs/agent/testing.md";

  // "which is the whole of that class" is the completeness claim, and the file
  // ships the command that measures it. A rendering test added without a line
  // here is one whose grounds nobody wrote down, which is the thing this
  // document exists to refuse.
  it("counts every *.test.tsx in the tree", () => {
    const claim = claimIn(doc, read(doc), /^([A-Z][a-z]+) are renderings rather than functions/m);
    const renderings = sources.filter(({ rel }) => rel.endsWith(".test.tsx")).map(({ rel }) => rel);

    assert.equal(
      spelledNumber(doc, claim[1]),
      renderings.length,
      stale(
        doc,
        `"${claim[1]} are renderings rather than functions … the whole of that class"`,
        `find src -name '*.test.tsx' answers ${renderings.length}: ${renderings.join(", ")}`,
      ),
    );
  });
});
