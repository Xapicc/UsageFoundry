#!/usr/bin/env node
// Resolve every citation in proposals/KnowledgeManager/ mechanically.
// Copied from proposals/LocalModelOffload/scripts/check-citations.mjs. Two
// differences: a path may contain spaces, because vault note names do; and a
// path under /workspace2/ is resolved against the vault, read-only, instead of
// being skipped as foreign — this proposal cites the vault as often as the repo.
// A bare name that is not a repo path is tried against the vault root, its
// `_Meta/`, and then by file name anywhere in the vault, where it must be
// unique; a token that is a command (`python3 _Meta/qc.py`) is resolved by its
// last word; and the files this proposal would create are named in PROPOSED,
// so they are counted rather than reported.
//
//   `path/file.ts:N`        full citation; N must exist in that file
//   `/workspace2/note.md:N` the same, against the vault
//   `path/file.ts:N`–`:M`   a range on the SAME file
//   `:N` otherwise          chains to the last named repo path in the same
//                           markdown file — the form ContextControl's
//                           validation pass found fifty violations of
//
// Names that are not repo paths (Codex sources, `config.toml`, `AGENTS.md`,
// absolute host paths) suppress the anchor instead of erroring, so a bare `:N`
// after one is reported rather than silently chained to something older.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Derived from this file's own location, so the script runs from anywhere.
const DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(dirname(DIR));
const VAULT = "/workspace2/";
const files = readdirSync(DIR).filter((f) => f.endsWith(".md")).sort();
const problems = [];
let links = 0, paths = 0, named = 0, bare = 0, foreign = 0;

const counts = new Map();
const lines = (p) => {
  if (!counts.has(p))
    counts.set(p, readFileSync(p.startsWith(VAULT) ? p : join(ROOT, p), "utf8").split("\n").length);
  return counts.get(p);
};
// Every vault file by its name, for a note cited by name alone. Skips the
// directories vaultlib skips, so a name is a note's or a script's.
const SKIP = new Set([".obsidian", ".git", "_to_delete", "__pycache__", "uf-c3-base"]);
const byName = new Map();
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full);
    else if (st.isFile()) byName.set(name, byName.has(name) ? null : full);
  }
};
if (existsSync(VAULT)) walk(VAULT.slice(0, -1));

const PROPOSED = new Set(["_Meta/housekeeping.py", "housekeeping.py", "test_housekeeping.py",
  "_Meta/tests/test_housekeeping.py", "knowledgeManager.ts", "manifest.json"]);
let proposed = 0;

const resolveOne = (p) => {
  if (p.startsWith(VAULT)) return existsSync(p) ? p : null;
  if (existsSync(join(ROOT, p))) return p;
  for (const d of ["src/lib/", "src/app/"]) if (existsSync(join(ROOT, d + p))) return d + p;
  for (const d of [VAULT, VAULT + "_Meta/"]) if (existsSync(d + p)) return d + p;
  const named = byName.get(p.split("/").pop());
  return named && named.endsWith(p) ? named : null;
};
const resolve = (p) => resolveOne(p) ?? (p.includes(" ") ? resolveOne(p.split(" ").pop()) : null);
// Anything matching these is not this repository's and is not an error.
const FOREIGN = /^(\/(?!workspace2\/)|~|\.credentials\.json$)/;

const TOKEN =
  /(–|-)?`(?:(Dockerfile|docker-compose\.yml|[A-Za-z0-9_.\/~ -]+\.(?:ts|tsx|mjs|sh|py|md|json|jsonl|yml|toml|sql))(?::(\d+))?|:(\d+))`/g;

for (const f of files) {
  const text = readFileSync(join(DIR, f), "utf8");

  for (const m of text.matchAll(/\]\((?!https?:)([^)\s#]+)\)/g)) {
    links++;
    if (!existsSync(join(DIR, m[1]))) problems.push(`${f}: dead link → ${m[1]}`);
  }

  let anchor = null;
  for (const m of text.matchAll(TOKEN)) {
    const [, dash, path, pathLine, bareLine] = m;
    if (path) {
      if (existsSync(join(DIR, path))) { anchor = null; continue; }   // sibling doc
      if (FOREIGN.test(path)) { foreign++; anchor = null; continue; }
      if (PROPOSED.has(path)) { proposed++; anchor = null; continue; }
      if (path.includes(" ") && existsSync(join(DIR, path.split(" ").pop()))) { anchor = null; continue; }
      const p = resolve(path);
      if (!p) { problems.push(`${f}: no such path → ${path}`); anchor = null; continue; }
      paths++;
      anchor = p;
      if (pathLine) {
        named++;
        if (Number(pathLine) > lines(p))
          problems.push(`${f}: ${p}:${pathLine} past EOF (${lines(p)})`);
      }
      continue;
    }
    const n = Number(bareLine);
    bare++;
    if (!anchor) { problems.push(`${f}: ${dash ? "range end" : "bare"} \`:${n}\` with no anchor`); continue; }
    if (n > lines(anchor))
      problems.push(
        `${f}: ${dash ? "range end" : "bare"} \`:${n}\` → ${anchor} (${lines(anchor)} lines) WRONG ANCHOR`,
      );
  }
}

console.log(
  `files ${files.length}  links ${links}  repo and vault paths ${paths}  foreign names ${foreign}  proposed files ${proposed}  named lines ${named}  bare :N ${bare}`,
);
console.log(problems.length ? `\nPROBLEMS (${problems.length}):` : "\nno problems");
for (const p of problems) console.log("  " + p);
