#!/usr/bin/env node
/**
 * The smoke pass: open every page this app has, in two skins at two widths, and
 * assert four things about each.
 *
 * `proposals/UIChecks/` surveyed what could check the interface and recommended
 * exactly this and no more — Option C2, "the smoke pass", against Option C1, a
 * Playwright *suite*, which it refused by name. The distinction is the whole
 * design of this file and it is worth stating so a later editor does not erase
 * it by degrees: **this asserts about load, never about interaction.** It clicks
 * nothing, fills nothing in and waits for no element to appear, which is why it
 * buys almost none of the measured maintenance tax that sank C1 — 44.7% of
 * browser-test flakiness is the check-then-act race, and this file never acts.
 * A page-object, a login helper, a second file, or an assertion that some
 * particular text is present is C1 arriving one commit at a time.
 *
 * The first three assertions are the survey's, in its order:
 *
 *   1. the response is 200 — a page that 500s on load is caught by nothing else
 *      in this repository;
 *   2. the console produced no error — including an uncaught exception in a
 *      client component, which renders as a blank region and no failed build;
 *   3. the body does not scroll sideways — the class of the one interface defect
 *      this project has actually recorded (the `w-auto`/`w-full` ordering in
 *      `RunLand.tsx`) and the reason a *browser* was bought rather than jsdom.
 *
 * The fourth is the half of assertion 3 the document cannot show: no box is
 * wider than a parent that is not a scroll container. `AppShell` clips rather
 * than scrolls, so the app's worst narrow-viewport failure leaves `scrollWidth`
 * equal to `clientWidth` and assertion 3 green. `clippedOverflow` below carries
 * the measurement that proved it.
 *
 * Assertion 2 has no exception list, and `/knowledge` is why it does not need
 * one. That page is the only one here whose interesting half — the note list,
 * the backlinks, the health rows, the graph — exists only once a knowledge base
 * is configured, and with none configured its client fetches answer 409 before
 * the status call has come back, which Chromium logs as a failed resource
 * however correctly the page then handles it. The cheap fix is to let this route
 * opt out of assertion 2 for that one expected status; it buys a green run and
 * checks strictly less, because the unconfigured page is a warning and a link
 * and every path worth a browser is on the other side of it. So `seedVault`
 * gives the sandbox a vault instead. The three notes are not arbitrary: one
 * links to a note that exists and to one that does not, and one carries no
 * frontmatter, so each of the health pane's three lists has a row in it and gets
 * drawn rather than skipped. An exception list would have been the first entry
 * in an exception list.
 *
 * No accessibility engine, deliberately. `proposals/OperatorInterface/` refused
 * `axe-core` on two grounds, and only the first — that no harness existed — is
 * answered by this file. The second stands: its yield here is unmeasurable in
 * advance and contrast, the criterion it is best at, is already decided by
 * arithmetic on declared tokens with no DOM.
 *
 * This is not wired into `npm test`. That suite is pure functions and must stay
 * runnable with no browser and no network; this one needs a Chromium and a
 * built app. Run it by hand:
 *
 *     env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build
 *     npm run smoke-pages
 *
 * Exit codes are three-valued on purpose. 0 passed, 1 a page failed, **2 the
 * pass did not run** — no build, no Playwright, no browser. A skip that exited 0
 * would report a pass for work that never happened, which is the one outcome
 * this file exists to make impossible.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const REPO = path.resolve(import.meta.dirname, "..");

/** The narrowest width the interface claims to support, and a desktop one. */
const WIDTHS = [390, 1280];

/**
 * The second axis: both skins, because nothing else scripted opens the ascii one.
 *
 * `:root[data-skin="ascii"]` restyles the whole interface — the token block,
 * the kit primitives, the charts, the meters and the app shell — and an
 * overlong fill string clipped by an `overflow: hidden` is exactly the failure
 * the assertions below already look for. They simply never looked for it with
 * the skin on.
 *
 * It doubles the pass. That is affordable here and nowhere else: `CLAUDE.md`
 * keeps this file out of `npm test` and out of CI on purpose, so the minutes
 * are paid by whoever runs it by hand and never by a push.
 *
 * The standard skin sets nothing, because that is what it *is*: `SkinToggle`
 * removes the key rather than writing "standard", and the pre-paint script in
 * `src/app/layout.tsx` keys on the stored value being exactly "ascii".
 */
const SKINS = [
  { name: "standard", attribute: null },
  { name: "ascii", attribute: "ascii" },
];

/**
 * How long to let a page settle after `load` before reading the console and the
 * scroll width.
 *
 * Every page here is a client component that fetches after hydration, so both
 * of the interesting assertions are about a state that does not exist at `load`.
 * `networkidle` is not available to us: the app holds an SSE stream open and
 * polls on a three-second timer, so the network is never idle by design. A flat
 * wait is the honest instrument for that — it cannot be retried into a green
 * build the way a waited-for selector can, and when it is too short it fails
 * loudly rather than silently checking an empty page.
 */
const SETTLE_MS = 2000;

const NAV_TIMEOUT_MS = 30_000;
const BOOT_TIMEOUT_MS = 60_000;

function skip(reason) {
  console.error(`\nSKIPPED — the smoke pass did not run.\n\n  ${reason}\n`);
  process.exit(2);
}

/**
 * The `localStorage` key the skin is stored under, read out of the component
 * that declares it.
 *
 * `src/components/SkinToggle.tsx` and the pre-paint script in
 * `src/app/layout.tsx` already spell that string twice. A third spelling here
 * would be a third thing to keep in step, and it is the one whose drift is
 * silent: a stale key puts every ascii-skin page load into the standard skin
 * and reports the whole axis green. This file cannot import the constant — the
 * component is TSX and this is plain Node with no build step — so it reads the
 * declaration, and refuses to run rather than guess.
 */
function skinStorageKey() {
  const owner = path.join("src", "components", "SkinToggle.tsx");
  let match = null;
  try {
    const source = fs.readFileSync(path.join(REPO, owner), "utf8");
    match = /export const SKIN_STORAGE_KEY = "([^"]+)"/.exec(source);
  } catch (error) {
    // A skip rather than a throw, because the exit code is the whole contract
    // here: an unreadable source file means the pass did not run, and a bare
    // throw would exit 1 and report it as a page that failed.
    skip(`could not read ${owner}: ${error.message}`);
  }
  if (match === null) {
    skip(
      `${owner} no longer declares SKIN_STORAGE_KEY where this can read it.\n` +
        "  The ascii half of the pass sets that key on a browser context before the\n" +
        "  first paint. Guessing it would run every page in the standard skin twice\n" +
        "  and report it clean.",
    );
  }
  return match[1];
}

/**
 * Playwright is deliberately not a dependency of this package.
 *
 * Adding it would put a browser download in front of `npm ci`, which every
 * other script in this repository manages without. So it is resolved wherever
 * the operator installed it — locally if they added it, globally otherwise —
 * and its absence is a skip rather than a failure.
 */
function resolvePlaywright() {
  const require_ = createRequire(import.meta.url);
  try {
    return require_.resolve("playwright");
  } catch {
    /* not installed locally; try the global root */
  }
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    // Resolved from *inside* the global root, so this is the package's entry
    // file rather than its directory — an ESM import of a directory is refused.
    return createRequire(path.join(root, "resolve-from-here.js")).resolve("playwright");
  } catch {
    /* no npm on PATH, no global root, or not installed there either */
  }
  return null;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * A throwaway install: its own data directory, its own `CLAUDE_HOME`, its own
 * workspace mount, and a `CLAUDE_BIN` that exits non-zero the moment it is
 * spawned.
 *
 * That last one is not a detail. This app starts billed agents, and a smoke
 * pass that seeds a run through the app's own API — which is the only way to
 * seed one without a second process writing to a database that permits exactly
 * one writer — would otherwise start a real one. The stub makes the run fail in
 * milliseconds, which is a perfectly good seeded run and costs nothing.
 */
function makeSandbox() {
  // Real path, not the spelling `os.tmpdir()` hands back, and this is what
  // makes the pass run on a Mac at all. There `/var` is a symlink to
  // `private/var`, so the sandbox's workspace arrives as
  // `/var/folders/…/workspace` while the containment check resolves it to
  // `/private/var/…` — and `POST /api/runs` refuses the seed with *"Folder is
  // outside the \"workspace\" mount"*, which kills the pass before a browser
  // opens. Resolving here hands both halves the same string.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-smoke-")));
  const claudeBin = path.join(root, "claude-cannot-spawn");
  fs.writeFileSync(
    claudeBin,
    '#!/bin/sh\necho "smoke pass: this CLAUDE_BIN cannot spawn" >&2\nexit 1\n',
  );
  fs.chmodSync(claudeBin, 0o755);

  const dataDir = path.join(root, "data");
  const claudeHome = path.join(root, "claude-home");
  const workspace = path.join(root, "workspace");
  // `projects/` present but empty: the app warns about a CLAUDE_HOME without
  // one, and an empty one is the state a machine that has never run Claude Code
  // is in — which is what we want every usage figure to read.
  for (const dir of [dataDir, path.join(claudeHome, "projects"), path.join(workspace, "project")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return { root, dataDir, claudeHome, workspace, claudeBin };
}

/**
 * Serve the artifact that actually ships, or fall back to `next start`.
 *
 * `next.config.ts` sets `output: "standalone"`. The container runs
 * `.next/standalone/server.js`, so this does too — which means copying the
 * static assets beside it exactly as the `Dockerfile` does. Skipping that copy
 * is not a visible failure: the pages still render, without any CSS, and the
 * sideways-scroll assertion then measures an unstyled document and passes
 * everything.
 *
 * The fallback was written for the agent containers, where `next build` could
 * not finish: the worktree sits on a virtiofs mount whose directory cache
 * outlives an unlink, so the standalone copy died on a spurious ENOENT/ENOTDIR
 * against a path whose parent is right there, on a different path every run.
 * `scripts/redirect-dist-dir.mjs` moves the output off that mount and those
 * containers now reach the standalone branch, so this is no longer their only
 * road — it is kept because a `.next` without a bundle beside it is still a
 * state this can be handed, and half a check beats refusing to run. `next
 * start` serves such a build — Next warns that `start` does not work with
 * `output: "standalone"`, but the warning is the whole of it and the app
 * serves.
 *
 * That mode is a strictly weaker check: it proves nothing about whether the
 * shipped bundle boots or whether the `node_modules` tracing copied into it is
 * complete, which is exactly the class of defect a standalone-only run catches.
 * So it is second choice, never silent, and `main` prints which one it took.
 */
function stageServer(port) {
  const standalone = path.join(REPO, ".next", "standalone");
  if (!fs.existsSync(path.join(REPO, ".next", "BUILD_ID"))) {
    skip(
      "no production build in .next/. Run:\n\n" +
        "    env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build\n\n" +
        "  (the -u is load-bearing inside a UsageFoundry container: an inherited\n" +
        "  __NEXT_PRIVATE_STANDALONE_CONFIG makes next build die in loadConfig.)",
    );
  }

  if (fs.existsSync(path.join(standalone, "server.js"))) {
    fs.cpSync(path.join(REPO, ".next", "static"), path.join(standalone, ".next", "static"), {
      recursive: true,
      force: true,
    });
    if (fs.existsSync(path.join(REPO, "public"))) {
      fs.cpSync(path.join(REPO, "public"), path.join(standalone, "public"), {
        recursive: true,
        force: true,
      });
    }
    return {
      banner: "serving .next/standalone/server.js — the artifact the container ships",
      argv: [path.join(standalone, "server.js")],
      cwd: standalone,
      // `next build` copies `.env` in beside the server, and the standalone
      // server loads it from its own directory rather than from the repo.
      envDir: standalone,
    };
  }

  const nextBin = path.join(REPO, "node_modules", "next", "dist", "bin", "next");
  if (!fs.existsSync(nextBin)) {
    skip(
      `.next/BUILD_ID exists but neither ${standalone}/server.js nor ${nextBin} does.\n` +
        "  The build is not a standalone one and there is no next binary to serve it with.",
    );
  }
  return {
    banner:
      "serving .next/ via `next start` — FALLBACK, because .next/standalone/server.js\n" +
      "  is absent. Everything below is a real check of the pages, but nothing here\n" +
      "  exercises the standalone bundle the container actually runs.",
    // Explicit rather than via PORT/HOSTNAME: `next start` defaults its host to
    // 0.0.0.0, which would put a seeded smoke install on the container network
    // for the length of the run.
    argv: [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)],
    cwd: REPO,
    envDir: REPO,
  };
}

/**
 * Every key the operator's `.env` sets, so each can be blanked.
 *
 * Whichever directory the server loads its `.env` from — `.next/standalone/`,
 * which `next build` copies it into, or the repo root under `next start` — it
 * is loaded at boot, which quietly undoes the isolation `serverEnv` is for.
 * The one that proved it: a seeded run failing under this harness reached
 * `deliver()` in `notify.ts` and POSTed to the operator's real
 * `UF_WEBHOOK_URL`, from a smoke test, on their own machine.
 *
 * Blanking rather than deleting the file, because the file is somebody else's:
 * Next's `loadEnvConfig` only fills keys that are `undefined`, so a key already
 * present as `""` is left alone. Reading the keys off the file rather than
 * listing them here is what keeps this true of a variable added next year.
 */
function envKeysToBlank(envDir) {
  const dotenv = path.join(envDir, ".env");
  if (!fs.existsSync(dotenv)) return {};
  const blanked = {};
  for (const line of fs.readFileSync(dotenv, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match !== null) blanked[match[1]] = "";
  }
  return blanked;
}

/**
 * The child's environment is built from nothing rather than inherited.
 *
 * This matters more than it looks. A shell inside a UsageFoundry container
 * already carries `UF_AUTH_TOKEN`, `WORKSPACE_ROOTS`, `DATA_DIR` and
 * `CLAUDE_HOME` for the *real* install, and every one of them silently outranks
 * what this function is trying to set — `WORKSPACE_ROOTS` in particular beats
 * `WORKSPACE_ROOT`, so an inherited one points the smoke pass at the operator's
 * own mounts. Naming every variable, and blanking the ones the staged `.env`
 * would otherwise supply, is the only way this is reproducible off one machine.
 */
function serverEnv(sandbox, token, port, envDir) {
  return {
    ...envKeysToBlank(envDir),
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: sandbox.root,
    TZ: "UTC",
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    DATA_DIR: sandbox.dataDir,
    CLAUDE_HOME: sandbox.claudeHome,
    CLAUDE_BIN: sandbox.claudeBin,
    WORKSPACE_ROOT: sandbox.workspace,
    UF_AUTH_TOKEN: token,
    // Staged, for `seed`'s reason one variable over: the Tools section draws a
    // row per declared tool and an empty install renders one `Empty` line, so a
    // pass that set neither of these would measure the nothing-state at both
    // widths and never the rows. Three entries across the two groups, chosen to
    // need nothing installed and to land on three different badges — a package
    // that will not resolve, a bare checkout path that names no command at all,
    // and an extension no volume here holds.
    UF_PY_TOOLS: "ruff==0.5.0|/workspace/winnow",
    UF_GH_EXTENSIONS: "dlvhdr/gh-dash",
  };
}

async function waitForHealth(baseUrl, headers, log) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { headers });
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `the server did not answer /api/health within ${BOOT_TIMEOUT_MS / 1000}s. Its output:\n${log()}`,
  );
}

async function sendJSON(method, baseUrl, pathname, headers, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${pathname} answered ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

/**
 * A vault on disk, then the two settings that point the install at it.
 *
 * The files are written straight into the sandbox workspace because they are not
 * the app's to create — it reads a directory somebody else keeps, and there is no
 * API for putting a note in it. The *settings* still go through the app's own
 * door, which is where the mount id is validated and the subpath is refused for
 * escaping the mount.
 *
 * Basenames rather than titles: a `[[wikilink]]` resolves against the file's own
 * name, so `[[Second note]]` needs `Second note.md` and nothing else will do.
 */
async function seedVault(baseUrl, headers, workspace) {
  const vault = path.join(workspace, "vault");
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(
    path.join(vault, "Smoke pass index.md"),
    "---\ntitle: Smoke pass index\ntags: [smoke]\n---\n\n" +
      "Seeded by the smoke pass. Links to [[Second note]], which exists, and to\n" +
      "[[Missing note]], which does not.\n",
  );
  fs.writeFileSync(
    path.join(vault, "Second note.md"),
    "---\ntitle: Second note\ntags: [smoke]\n---\n\n" +
      "Linked from [[Smoke pass index]], so the backlinks pane has a row.\n",
  );
  // No frontmatter, deliberately: it is the third of the three things the health
  // pane counts, and an all-tidy vault renders none of them.
  fs.writeFileSync(
    path.join(vault, "Unfiled note.md"),
    "A note nobody linked and nobody filed.\n",
  );

  await sendJSON("PUT", baseUrl, "/api/settings", headers, {
    knowledgeBaseMountId: "workspace",
    knowledgeBaseSubpath: "vault",
  });
}

/**
 * Seed through the app's own API, never by writing to its database.
 *
 * Seven of the twenty-two pages are addressed by an id, and a page fetching an
 * id that does not exist logs a console error for the 404 — so the ids have to
 * be real or a third of the pass measures the wrong thing. The app permits
 * exactly one writer to a data directory and says so at boot, which rules out
 * opening the SQLite file from here while the server holds it.
 */
async function seed(baseUrl, headers, workspace) {
  const run = await sendJSON("POST", baseUrl, "/api/runs", headers, {
    folder: path.join(workspace, "project"),
    prompt: "Seeded by the smoke pass. Nothing spawns: CLAUDE_BIN exits 1.",
    maxIterations: 1,
    budget: {},
  });
  const workflow = await sendJSON("POST", baseUrl, "/api/workflows", headers, {
    name: "Smoke pass workflow",
    graph: {
      nodes: [
        {
          id: "n1",
          name: "Block one",
          task: "Seeded by the smoke pass.",
          mountId: "workspace",
          path: "project",
        },
      ],
      edges: [],
    },
  });
  const instance = await sendJSON("POST", baseUrl, `/api/workflows/${workflow.workflow.id}/run`, headers, {});
  // Carries a project, because the task page's folder picker draws a second
  // select from it — an unassigned task would load the same page with half of
  // the widest row on it never rendered.
  const task = await sendJSON("POST", baseUrl, "/api/tasks", headers, {
    title: "Seeded by the smoke pass",
    body: "Nothing picks this up: no run is started for a task by filing it.",
    mountId: "workspace",
    folder: "project",
  });
  await seedVault(baseUrl, headers, workspace);
  return {
    runId: run.run.id,
    workflowId: workflow.workflow.id,
    instanceId: instance.instance.id,
    taskId: task.task.id,
  };
}

/** Every `src/app/**\/page.tsx`, with the seven dynamic ones bound to seeds. */
function routes({ runId, workflowId, instanceId, taskId }) {
  return [
    "/",
    "/account",
    "/agents",
    "/branches",
    "/chat",
    "/dreaming",
    "/knowledge",
    "/login",
    "/runs",
    "/runs/new",
    `/runs/${runId}`,
    `/runs/${runId}/touched`,
    `/runs/${runId}/conflicts`,
    "/settings",
    // Not seeded, and it cannot be: a receipt is written by the applier into a
    // named volume the host has no copy of, so what this asserts is the page's
    // "no receipt names this stack" state. That is the state an operator most
    // often reaches it in — from a link on a row whose stack has since been
    // removed — and the half with a receipt is verified by hand against the
    // container, in `docs/verification.md`.
    "/settings/stacks/none-declared",
    "/tasks",
    "/tasks/new",
    `/tasks/${taskId}`,
    "/workflows",
    "/workflows/new",
    `/workflows/${workflowId}`,
    `/workflows/${workflowId}/edit`,
    `/workflows/${workflowId}/instances/${instanceId}`,
  ];
}

/** What a route is called in the report, with the seeded id put back. */
function label(route, seeds) {
  return route
    .replace(seeds.instanceId, "[instanceId]")
    .replace(seeds.workflowId, "[id]")
    .replace(seeds.runId, "[id]")
    .replace(seeds.taskId, "[id]");
}

/**
 * Boxes wider than the box they sit in — the overflow the document cannot show.
 *
 * Assertion 3 stands on the *document's* scroll width, and that is blind to the
 * most damaging narrow-viewport failure this app has: `AppShell`'s outermost
 * wrapper is `flex overflow-hidden`, so a box wider than the pane is **clipped**
 * rather than allowed to scroll the document. `scrollWidth` stays equal to
 * `clientWidth` and the page reports clean with its right-hand side off screen
 * and unreachable. Measured 2026-09-10 on `/chat` at 390x844: the thread card
 * and the proposals card were each 584px inside a 358px grid track, and this
 * file passed that page at that width with an identical `44/44 page loads
 * clean`.
 *
 * The guard is on the **parent**, and it is the whole of what keeps the true
 * positives. A parent that declares a scroll mechanism is overflowing on
 * purpose: a `<pre class="overflow-x-auto">` whose `<code>` is 824px inside
 * 318px is correct, and so is a `TableWrap` around a wide table. Only a parent
 * whose `overflow-x` is `visible` is claiming its child fits.
 *
 * Three things are excluded, and each was read off a run rather than guessed:
 *
 *   - a parent whose `clientWidth` is 0 has no content box to measure against.
 *     An inline `<span>` or `<a>` reports 0, and so does a stacked `Table`'s
 *     cell; comparing against it would call every child's full width overflow.
 *   - **inside an `<svg>`** nothing is a CSS box: a `<path>` is laid out in the
 *     viewBox's own coordinate system, which is then scaled to fit. The root
 *     `<svg>` is a replaced CSS box and is measured, through its client rect —
 *     `offsetWidth` is an `HTMLElement` property and is `undefined` on every
 *     SVG element, and `undefined - 346` is `NaN`, which slips past a `<=`
 *     rather than failing it. 268 hits in the first run, all of them this.
 *   - an **out-of-flow** element is measured against its nearest positioned
 *     ancestor, not against its parent, so the two numbers are different boxes.
 *     `.uf-ascii-frame` is the case that proved it: `globals.css` gives it
 *     `inset: calc(-0.5em - 1px)`, deliberately drawing the character border
 *     *outside* its host, and it reported 361px in 346px on every ascii page.
 */
function clippedOverflow() {
  function describe(element) {
    const classes =
      typeof element.className === "string" && element.className.trim() !== ""
        ? "." + element.className.trim().split(/\s+/).slice(0, 3).join(".")
        : "";
    return element.tagName.toLowerCase() + classes;
  }
  const hits = [];
  for (const element of document.querySelectorAll("body *")) {
    if (!(element instanceof HTMLElement) && !(element instanceof SVGSVGElement)) continue;
    const parent = element.parentElement;
    if (parent === null || parent.clientWidth === 0) continue;
    const width =
      element instanceof HTMLElement
        ? element.offsetWidth
        : Math.round(element.getBoundingClientRect().width);
    // The 1px allowance is for a fractional layout rounded up to an integer;
    // a real clipping defect is tens of pixels or more.
    if (width - parent.clientWidth <= 1) continue;
    // The style reads sit behind that arithmetic on purpose: `getComputedStyle`
    // forces a style recalculation, and a page has thousands of elements but
    // only a handful that are over-wide at all.
    if (getComputedStyle(parent).overflowX !== "visible") continue;
    const style = getComputedStyle(element);
    if (style.position === "absolute" || style.position === "fixed") continue;
    // The **margin** box is what occupies the parent, and a negative horizontal
    // margin is the author asking for the extra width rather than losing it: a
    // full-bleed sticky footer is `-mx-4` inside a padded pane, and it measured
    // 390px in a 358px <form> at 390 and 1056 in 1016 at 1280 — both exactly
    // its own margins, both reaching the pane edge with nothing cut off.
    const over =
      width + parseFloat(style.marginLeft) + parseFloat(style.marginRight) - parent.clientWidth;
    if (over <= 1) continue;
    hits.push({
      over,
      text: `<${describe(element)}> ${width}px in ${parent.clientWidth}px <${describe(parent)}>`,
    });
  }
  return hits.sort((a, b) => b.over - a.over).map((hit) => hit.text);
}

/**
 * Name the widest thing on the page, so a sideways-scroll failure is actionable
 * rather than merely true. Diagnostic only — the assertion above it stands on
 * the document's own scroll width.
 */
function widestOffender() {
  const limit = document.documentElement.clientWidth;
  let worst = null;
  for (const element of document.querySelectorAll("body *")) {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.right <= limit) continue;
    if (worst !== null && box.right <= worst.right) continue;
    const classes =
      typeof element.className === "string" && element.className.trim() !== ""
        ? "." + element.className.trim().split(/\s+/).slice(0, 3).join(".")
        : "";
    worst = { right: box.right, tag: element.tagName.toLowerCase() + classes };
  }
  return worst;
}

async function checkPage(context, baseUrl, route, width, skin) {
  const page = await context.newPage();
  const problems = [];
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    consoleErrors.push(`uncaught ${error.message}`);
  });

  try {
    const response = await page.goto(`${baseUrl}${route}`, {
      waitUntil: "load",
      timeout: NAV_TIMEOUT_MS,
    });
    if (response === null) {
      problems.push("no response");
    } else if (response.status() !== 200) {
      problems.push(`HTTP ${response.status()}`);
    }

    await page.waitForTimeout(SETTLE_MS);

    // Not a check of the interface but of this harness: everything the skin axis
    // asserts is worthless if the attribute never arrived, and it would arrive
    // as a clean run rather than as an error.
    const applied = await page.evaluate(() => document.documentElement.dataset.skin ?? null);
    if (applied !== skin.attribute) {
      const spell = (value) => (value === null ? "absent" : `"${value}"`);
      problems.push(`skin not applied: data-skin is ${spell(applied)}, expected ${spell(skin.attribute)}`);
    }

    const scroll = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    if (scroll.scrollWidth > scroll.clientWidth) {
      const offender = await page.evaluate(widestOffender);
      problems.push(
        `scrolls sideways: ${scroll.scrollWidth}px in a ${scroll.clientWidth}px viewport` +
          (offender ? ` (widest: <${offender.tag}> reaching ${Math.round(offender.right)}px)` : ""),
      );
    }

    const clipped = await page.evaluate(clippedOverflow);
    if (clipped.length > 0) {
      // Three, then a count: one clipped box usually drags its whole subtree
      // over with it, and the widest few are what name the container at fault.
      problems.push(
        `clipped overflow: ${clipped.length} box${clipped.length === 1 ? "" : "es"} wider than ` +
          `a parent that is not a scroll container\n          ` +
          clipped.slice(0, 3).join("\n          ") +
          (clipped.length > 3 ? `\n          …and ${clipped.length - 3} more` : ""),
      );
    }

    for (const text of consoleErrors) {
      problems.push(`console error: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  } catch (error) {
    problems.push(`${error.message.split("\n")[0]}`);
  } finally {
    await page.close();
  }
  return { route, width, skin: skin.name, problems };
}

async function main() {
  const storageKey = skinStorageKey();
  const playwrightEntry = resolvePlaywright();
  if (playwrightEntry === null) {
    skip(
      "Playwright is not installed. It is deliberately not a dependency of this\n" +
        "  package — installing it would put a browser download in front of npm ci.\n" +
        "  Install it once, then re-run:\n\n" +
        "    npm i -g playwright && npx playwright install chromium",
    );
  }
  // Playwright's entry is CommonJS, so a global install arrives under `default`
  // and a local one under both. Read whichever is there rather than assuming.
  const playwright = await import(pathToFileURL(playwrightEntry).href);
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  if (chromium === undefined) {
    skip(`${playwrightEntry} exports no \`chromium\` — that is not the Playwright package.`);
  }

  // Before the sandbox and the browser, because `stageServer` can `skip()` and
  // both of those would then be left behind; `freePort` moves up with it
  // because `next start` takes its port on the command line.
  const port = await freePort();
  const target = stageServer(port);
  console.log(`${target.banner}\n`);

  let sandbox;
  try {
    sandbox = makeSandbox();
  } catch (error) {
    skip(`could not create a throwaway data directory under ${os.tmpdir()}: ${error.message}`);
  }

  // Everything that can decide to skip happens before the server is spawned:
  // `skip()` calls process.exit, which does not run a `finally`, so a skip after
  // that point would leave the child running.
  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
    skip(
      `Playwright is installed but Chromium would not launch: ${error.message.split("\n")[0]}\n\n` +
        "    npx playwright install chromium",
    );
  }

  // Not a credential: it exists so the pass runs against the middleware every
  // real install has switched on, rather than against UF_ALLOW_NO_AUTH, whose
  // banner is on every page and would be measured as part of every layout.
  const token = `smoke-${Math.random().toString(36).slice(2)}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${token}` };

  const output = [];
  const server = spawn(process.execPath, target.argv, {
    cwd: target.cwd,
    env: serverEnv(sandbox, token, port, target.envDir),
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => output.push(d.toString()));
  server.stderr.on("data", (d) => output.push(d.toString()));
  const serverLog = () => output.join("").slice(-4000);

  // A signal does not run the `finally` below, and what would survive it is a
  // server still holding a temporary data directory this process is about to
  // stop being able to name.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.kill("SIGKILL");
      fs.rmSync(sandbox.root, { recursive: true, force: true });
      process.exit(130);
    });
  }

  const failures = [];
  let checked = 0;
  try {
    await waitForHealth(baseUrl, headers, serverLog);

    const seeds = await seed(baseUrl, headers, sandbox.workspace);
    const pages = routes(seeds);
    console.log(
      `${pages.length} pages × ${SKINS.length} skins × ${WIDTHS.length} widths ` +
        `against ${baseUrl}\n`,
    );

    for (const skin of SKINS) {
      for (const width of WIDTHS) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          extraHTTPHeaders: headers,
        });
        if (skin.attribute !== null) {
          // Before any of the page's own scripts, which is what makes this the
          // state a person is in rather than a page caught mid-swap: the
          // pre-paint script reads the key and sets the attribute before the
          // first frame. Uncaught on purpose — a `localStorage` that refused
          // the write must fail the run, not skin half of it.
          await context.addInitScript(
            ([key, value]) => localStorage.setItem(key, value),
            [storageKey, skin.attribute],
          );
        }
        for (const route of pages) {
          const result = await checkPage(context, baseUrl, route, width, skin);
          checked += 1;
          const name = label(route, seeds);
          const where = `${skin.name.padEnd(8)} ${String(width).padEnd(5)}`;
          if (result.problems.length === 0) {
            console.log(`  ok    ${where} ${name}`);
          } else {
            console.log(`  FAIL  ${where} ${name}`);
            for (const problem of result.problems) console.log(`          ${problem}`);
            failures.push({ skin: skin.name, width, name, problems: result.problems });
          }
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.kill("SIGTERM");
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }

  const failedPages = new Set(failures.map((f) => f.name));
  console.log(
    `\n${checked - failures.length}/${checked} page loads clean; ` +
      `${failedPages.size} of the ${checked / (SKINS.length * WIDTHS.length)} pages ` +
      `failed in some skin at some width.`,
  );
  if (failures.length > 0) {
    console.log("\nFailing pages:");
    for (const name of failedPages) console.log(`  ${name}`);
    process.exit(1);
  }
}

await main();
