#!/usr/bin/env node
/**
 * The smoke pass: open every page this app has, at two widths, and assert three
 * things about each.
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
 * The three assertions are the survey's, in its order:
 *
 *   1. the response is 200 — a page that 500s on load is caught by nothing else
 *      in this repository;
 *   2. the console produced no error — including an uncaught exception in a
 *      client component, which renders as a blank region and no failed build;
 *   3. the body does not scroll sideways — the class of the one interface defect
 *      this project has actually recorded (the `w-auto`/`w-full` ordering in
 *      `RunLand.tsx`) and the reason a *browser* was bought rather than jsdom.
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
 *     npm run smoke
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-smoke-"));
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
 * Serve the artifact that actually ships.
 *
 * `next.config.ts` sets `output: "standalone"`, and `next start` warns that it
 * does not work with it. The container runs `.next/standalone/server.js`, so
 * this does too — which means copying the static assets beside it exactly as
 * the `Dockerfile` does. Skipping that copy is not a visible failure: the pages
 * still render, without any CSS, and the sideways-scroll assertion then measures
 * an unstyled document and passes everything.
 */
function stageStandalone() {
  const standalone = path.join(REPO, ".next", "standalone");
  if (!fs.existsSync(path.join(REPO, ".next", "BUILD_ID"))) {
    skip(
      "no production build in .next/. Run:\n\n" +
        "    env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build\n\n" +
        "  (the -u is load-bearing inside a UsageFoundry container: an inherited\n" +
        "  __NEXT_PRIVATE_STANDALONE_CONFIG makes next build die in loadConfig.)",
    );
  }
  if (!fs.existsSync(path.join(standalone, "server.js"))) {
    skip(`.next/BUILD_ID exists but ${standalone}/server.js does not — the build is not a standalone one.`);
  }
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
  return path.join(standalone, "server.js");
}

/**
 * Every key the operator's `.env` sets, so each can be blanked.
 *
 * `next build` copies `.env` into `.next/standalone/`, and the standalone server
 * loads it at boot — which quietly undoes the isolation `serverEnv` is for.
 * The one that proved it: a seeded run failing under this harness reached
 * `deliver()` in `notify.ts` and POSTed to the operator's real
 * `UF_WEBHOOK_URL`, from a smoke test, on their own machine.
 *
 * Blanking rather than deleting the file, because the file is somebody else's:
 * Next's `loadEnvConfig` only fills keys that are `undefined`, so a key already
 * present as `""` is left alone. Reading the keys off the file rather than
 * listing them here is what keeps this true of a variable added next year.
 */
function envKeysToBlank(serverScript) {
  const dotenv = path.join(path.dirname(serverScript), ".env");
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
function serverEnv(sandbox, token, port, serverScript) {
  return {
    ...envKeysToBlank(serverScript),
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

async function postJSON(baseUrl, pathname, headers, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${pathname} answered ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

/**
 * Seed through the app's own API, never by writing to its database.
 *
 * Six of the nineteen pages are addressed by an id, and a page fetching an id
 * that does not exist logs a console error for the 404 — so the ids have to be
 * real or a third of the pass measures the wrong thing. The app permits exactly
 * one writer to a data directory and says so at boot, which rules out opening
 * the SQLite file from here while the server holds it.
 */
async function seed(baseUrl, headers, workspace) {
  const run = await postJSON(baseUrl, "/api/runs", headers, {
    folder: path.join(workspace, "project"),
    prompt: "Seeded by the smoke pass. Nothing spawns: CLAUDE_BIN exits 1.",
    maxIterations: 1,
    budget: {},
  });
  const workflow = await postJSON(baseUrl, "/api/workflows", headers, {
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
  const instance = await postJSON(baseUrl, `/api/workflows/${workflow.workflow.id}/run`, headers, {});
  return {
    runId: run.run.id,
    workflowId: workflow.workflow.id,
    instanceId: instance.instance.id,
  };
}

/** Every `src/app/**\/page.tsx`, with the six dynamic ones bound to the seeds. */
function routes({ runId, workflowId, instanceId }) {
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
    .replace(seeds.runId, "[id]");
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

async function checkPage(context, baseUrl, route, width) {
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

    for (const text of consoleErrors) {
      problems.push(`console error: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  } catch (error) {
    problems.push(`${error.message.split("\n")[0]}`);
  } finally {
    await page.close();
  }
  return { route, width, problems };
}

async function main() {
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

  const serverScript = stageStandalone();

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
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${token}` };

  const output = [];
  const server = spawn(process.execPath, [serverScript], {
    cwd: path.dirname(serverScript),
    env: serverEnv(sandbox, token, port, serverScript),
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
    console.log(`${pages.length} pages × ${WIDTHS.length} widths against ${baseUrl}\n`);

    for (const width of WIDTHS) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        extraHTTPHeaders: headers,
      });
      for (const route of pages) {
        const result = await checkPage(context, baseUrl, route, width);
        checked += 1;
        const name = label(route, seeds);
        if (result.problems.length === 0) {
          console.log(`  ok    ${String(width).padEnd(5)} ${name}`);
        } else {
          console.log(`  FAIL  ${String(width).padEnd(5)} ${name}`);
          for (const problem of result.problems) console.log(`          ${problem}`);
          failures.push({ width, name, problems: result.problems });
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    server.kill("SIGTERM");
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }

  const failedPages = new Set(failures.map((f) => f.name));
  console.log(
    `\n${checked - failures.length}/${checked} page loads clean; ` +
      `${failedPages.size} of the ${checked / WIDTHS.length} pages failed at some width.`,
  );
  if (failures.length > 0) {
    console.log("\nFailing pages:");
    for (const name of failedPages) console.log(`  ${name}`);
    process.exit(1);
  }
}

await main();
