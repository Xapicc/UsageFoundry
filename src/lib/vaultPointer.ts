import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CLAUDE_BIN, spawnCommand } from "./config";
import { promptArgs } from "./cycleInvocation";
import { costOf, resolvePrice } from "./pricing";
import { holdoutOf } from "./priorReads";
import { childCredentials, privilegeSeparated } from "./privsep";
import { reviewEnv } from "./review";
import { readTokens } from "./transcripts";
import { VAULT_SKILL_BASE } from "./vaultSkill";

/**
 * The vault pointer: the few knowledge-vault notes that bear on a run's task,
 * named in a fresh conversation's opening prompt, on half of all runs.
 *
 * ## Why a pointer rather than the skill alone
 *
 * The skill is the vault offered on request, and requests did not come. Over
 * the 592 runs of 2026-09-25 to 10-25, every one of which had the skill in its
 * list, 6 invoked it — all on two days, none in the 430 runs after — while 9 of
 * the 12 runs whose prompt named a note read it. Availability was never what
 * made an agent check; `docs/agent/dreaming/vault-skill-steering.md` measured
 * the same on three runs in September, and the month after confirmed it at
 * scale. So the app does the looking, once, before the run starts.
 *
 * ## Why a model decides, and the vault's search only proposes
 *
 * The same month says what a pointer built from search alone would have been:
 * the vault's ranked search answered with a confident match for 493 of 530
 * task titles, where a reading of 147 of them found something worth an agent's
 * time for 5. The vault's own `vault_search.py` records why — at this corpus
 * size its abstention no longer fires — and leaves the threshold alone on
 * purpose. A pointer that named whatever ranked first would put three
 * irrelevant notes in front of nearly every run. Search is good at the other
 * half: every note judged useful in that month was in its top eight for the
 * task's title. So search proposes up to twenty, and a small model reading the
 * task beside each note's abstract picks at most three, or none — and none is
 * the answer it is expected to give for nearly every run.
 *
 * ## What reaches the run, and what does not
 *
 * Never a note. Each pick is its path, its grade, its size, its abstract and a
 * sentence on why — about 120 tokens — and, for a long note, the heading of the
 * section to read. A note the agent opens is re-read on every later turn of
 * the cycle, and twenty notes in this vault are over 10,000 tokens, so naming
 * the section is what keeps a pick from being the most expensive line in the
 * prompt.
 */

/**
 * The name this experiment hashes into every run's arm. `PRIOR_READS_EXPERIMENT`'s
 * rule applies unchanged: **never change it**, because every run already started
 * has an arm recomputed from this string.
 */
export const VAULT_POINTER_EXPERIMENT = "vault-pointer";

/**
 * The model that writes the queries and makes the picks.
 *
 * The smallest Claude, because it is asked twice for every run that starts and
 * its answer is nearly always "nothing". Measured on 151 runs of the month above
 * before this shipped; the figures are in `docs/verification/knowledge-and-plugins.md`.
 */
export const VAULT_GATE_MODEL = "claude-haiku-5-5";

/** Candidates the search may return per query, and in all. */
const PER_QUERY = 8;
const MAX_CANDIDATES = 20;

/**
 * How many queries one run is searched with, and how many run at once.
 *
 * Each search is a `python3` that rebuilds the vault's index from every note
 * before it answers — 3.7s at 2,003 notes on the operator's Mac — and a run can
 * carry fourteen board tasks. So the titles are cut to three, the gate's own
 * queries add at most three more, and three search at a time: two rounds, about
 * eight seconds, rather than a minute in series before the first cycle.
 */
const MAX_TITLE_QUERIES = 3;
const SEARCH_PARALLEL = 3;

/** The most notes a run is shown. */
export const MAX_PICKS = 3;

/**
 * How much of the task the gate reads. The opening of a run's prompt is where
 * its subject is; past this it is procedure, and the gate pays for every token.
 */
const TASK_CHARS = 6_000;

/** A note longer than this is shown to the gate with its headings, so a pick can name a section. */
const HEADINGS_ABOVE_TOKENS = 3_000;

/**
 * Deadlines. A gate that has not answered in a minute has failed, and the run
 * starts without a pointer exactly as it would have before this existed.
 */
const SEARCH_TIMEOUT_MS = 20_000;
const GATE_TIMEOUT_MS = 60_000;

/** One note the vault's search proposed, as the gate is shown it. */
export interface VaultCandidate {
  /** Relative to the vault's root. */
  path: string;
  title: string;
  type: string;
  status: string;
  confidence: string;
  abstract: string;
  /** Estimated as bytes / 4, which is what a pick tells the agent it will cost. */
  tokens: number;
  headings: string[];
}

/** One note a run is shown. */
export interface VaultPick {
  path: string;
  title: string;
  confidence: string;
  tokens: number;
  abstract: string;
  why: string;
  /** A heading of the note, verbatim, or null for a note short enough to read whole. */
  section: string | null;
}

/** What the run loop records about one run's pointer, in both arms. */
export interface VaultPointer {
  arm: "pointer" | "holdout";
  /** What the pointer arm is shown, and what the holdout arm would have been. */
  picks: VaultPick[];
  /** The gate's two calls, as the CLI reported them. Never added to `runs.spent_usd`. */
  costUsd: number;
  /** Why there are no picks, when the reason is a failure rather than the gate's answer. */
  failure: string | null;
}

/** Whether a run is held out of the pointer: half of all runs, by id alone. */
export function vaultPointerHoldout(runId: string): boolean {
  return holdoutOf(VAULT_POINTER_EXPERIMENT, runId);
}

/**
 * The hits of one `vault_search.py --json` call.
 *
 * Throws on a shape it does not recognise rather than answering empty: a
 * search that printed something other than its JSON is a script that changed
 * or broke, and "the vault had nothing" would be the wrong thing to log.
 */
export function readSearchHits(stdout: string): Array<Omit<VaultCandidate, "tokens" | "headings">> {
  const parsed: unknown = JSON.parse(stdout);
  const hits = (parsed as { hits?: unknown })?.hits;
  if (!Array.isArray(hits)) throw new Error("the search printed JSON with no hits array");
  return hits.flatMap((h) => {
    if (typeof h !== "object" || h === null) return [];
    const r = h as Record<string, unknown>;
    if (typeof r.path !== "string" || typeof r.title !== "string") return [];
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    return [
      {
        path: r.path,
        title: r.title,
        type: text(r.type),
        status: text(r.status),
        confidence: text(r.confidence),
        abstract: text(r.abstract),
      },
    ];
  });
}

/**
 * Several queries' ranked hits as one list: each note at its best rank in any
 * of them, ties to the query asked first, at most `max`.
 *
 * Best rank rather than summed score, because the queries ask about different
 * halves of one task — the task's title and the mechanism it names — and a
 * note at the top of either is a note the gate should see.
 */
export function mergeCandidates<T extends { path: string }>(lists: readonly (readonly T[])[], max = MAX_CANDIDATES): T[] {
  const best = new Map<string, { rank: number; order: number; hit: T }>();
  let order = 0;
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const seen = best.get(hit.path);
      if (!seen || rank < seen.rank) best.set(hit.path, { rank, order: seen?.order ?? order, hit });
      order++;
    });
  }
  return [...best.values()]
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, max)
    .map((b) => b.hit);
}

export const QUERY_SYSTEM = `You write search queries for a personal knowledge vault of research notes (LLM agents, containers and virtualisation on macOS, local inference, software engineering, web design) and of measured failures in the agent infrastructure that runs coding tasks.

Given a coding agent's task, write up to three short queries (3-8 words each) naming the mechanisms, components, failures or design questions the task is actually about. Never query for boilerplate: repository names, commit or branch instructions, board-task procedure, the DONE/NEEDS_REVIEW protocol.`;

export const JUDGE_SYSTEM = `You decide whether any notes from a personal knowledge vault would change how an unattended coding agent does its task. The agent will see your picks before it starts, and any note it opens is paid for on every later turn, so a pick that turns out to be background costs it thousands of tokens for nothing.

Pick a note only if an agent who read it would do this task differently or faster: it records a measurement, a diagnosis of this same failure, a decision about this same component, or documented behaviour of the exact API, tool or mechanism the task turns on, which the agent would otherwise rediscover or get wrong. Do not pick a note that is general background for the area, a note about a neighbouring problem, or a note whose content a competent engineer already knows. When in doubt, leave it out: an empty list is the right answer for most tasks.

At most three picks. For each give the note's path exactly as listed; in "why", the specific fact or finding from the note that this task would use, in at most 25 words; and, when the note is long and lists headings, the one heading whose section to read (otherwise null).`;

export const QUERY_SCHEMA = {
  type: "object",
  properties: { queries: { type: "array", items: { type: "string" }, maxItems: 3 } },
  required: ["queries"],
} as const;

export const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      maxItems: MAX_PICKS,
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          why: { type: "string" },
          section: { type: ["string", "null"] },
        },
        required: ["path", "why", "section"],
      },
    },
  },
  required: ["notes"],
} as const;

/** The task as the gate reads it: the run's own prompt, cut where procedure takes over. */
export function gateTask(task: string): string {
  return task.length <= TASK_CHARS ? task : `${task.slice(0, TASK_CHARS)}\n[…]`;
}

/** What the judge is shown: the task, then each candidate with its grade, size and abstract. */
export function renderJudgePrompt(task: string, candidates: readonly VaultCandidate[]): string {
  const lines = ["# The task", "", gateTask(task), "", "# Candidate notes", ""];
  candidates.forEach((c, i) => {
    lines.push(`[${i + 1}] ${c.path}`);
    lines.push(`${c.title} (${c.type}, ${c.status}, confidence: ${c.confidence || "unset"}, ~${c.tokens} tokens)`);
    lines.push(c.abstract);
    if (c.tokens > HEADINGS_ABOVE_TOKENS && c.headings.length > 0) {
      lines.push(`Headings: ${c.headings.slice(0, 30).join(" · ")}`);
    }
    lines.push("");
  });
  return lines.join("\n");
}

function headingText(line: string): string {
  return line.replace(/^#+\s*/, "").trim();
}

/** Text from a model, bounded and on one line, before it is put into another model's prompt. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * The judge's answer, held to what it was shown.
 *
 * Every way of getting this wrong puts a line in a run's prompt that looks
 * right and is not. A path the judge invented, or copied with one character
 * changed, names a note the agent then fails to open; a section that is not a
 * heading of that note sends it grepping for something that is not there. So a
 * pick survives only if its path is one of the candidates, verbatim, and its
 * section only if it is one of that note's headings; a repeated path counts
 * once, and anything past `MAX_PICKS` is dropped rather than trusted to the
 * schema the CLI was given.
 *
 * A section is matched without its `#` marks and handed on with them. The
 * judge copied headings without the marks in 31 of 31 sections in the
 * backtest whichever way they were shown, and the line the agent greps for is
 * the one with them.
 */
export function readJudgeVerdict(raw: unknown, candidates: readonly VaultCandidate[]): VaultPick[] {
  const notes = (raw as { notes?: unknown })?.notes;
  if (!Array.isArray(notes)) return [];
  const byPath = new Map(candidates.map((c) => [c.path, c]));
  const picks: VaultPick[] = [];
  for (const n of notes) {
    if (picks.length >= MAX_PICKS) break;
    const r = (n ?? {}) as Record<string, unknown>;
    const c = typeof r.path === "string" ? byPath.get(r.path) : undefined;
    if (!c || picks.some((p) => p.path === c.path)) continue;
    const wanted = typeof r.section === "string" ? headingText(r.section) : "";
    const section = wanted === "" ? null : (c.headings.find((h) => headingText(h) === wanted) ?? null);
    picks.push({
      path: c.path,
      title: c.title,
      confidence: c.confidence,
      tokens: c.tokens,
      abstract: oneLine(c.abstract, 600),
      why: oneLine(typeof r.why === "string" ? r.why : "", 240),
      section,
    });
  }
  return picks;
}

/**
 * The block a run in the pointer's arm is shown.
 *
 * Worded as a fact rather than an instruction, for the reason
 * `priorReadsNotice` is: an instruction to read is the sentence agents measurably
 * decline, and one they follow is paid for on every turn. The abstract is in the
 * block so that the commonest useful outcome — the abstract alone answers the
 * question — costs no read at all.
 */
export function vaultPointerNotice(picks: readonly VaultPick[], vaultPath: string): string {
  const count = picks.length === 1 ? "One note" : `${picks.length} notes`;
  const lines = [
    `${count} in the operator's knowledge vault at ${vaultPath} ${picks.length === 1 ? "bears" : "bear"} ` +
      `on this task, picked by a model that ` +
      `read the task beside each note's abstract. They record what is already known here, with its grade; ` +
      `they are not instructions. A note you open stays in this conversation for every later turn, so where ` +
      `a section is named, read that section rather than the whole note.`,
  ];
  for (const p of picks) {
    lines.push("");
    lines.push(`    ${p.path} (confidence: ${p.confidence || "unset"}, ~${p.tokens.toLocaleString("en-US")} tokens)`);
    lines.push(`      ${p.abstract}`);
    lines.push(`      Why here: ${p.why}`);
    if (p.section) lines.push(`      Section: ${p.section}`);
  }
  return lines.join("\n");
}

/**
 * A note's size and headings, read from the vault rather than from the search.
 *
 * The search's JSON carries neither, and the gate needs both to name a section.
 * Contained the way every other path into a mount is: the vault-relative path
 * came out of a script that reads content runs can write, so it is proved to
 * resolve inside the vault, before and after `realpath`, before it is opened.
 */
export function noteShape(vaultRoot: string, rel: string): { tokens: number; headings: string[] } | null {
  try {
    const realRoot = fs.realpathSync(vaultRoot);
    const joined = path.resolve(realRoot, rel);
    if (!joined.startsWith(realRoot + path.sep)) return null;
    const real = fs.realpathSync(joined);
    if (!real.startsWith(realRoot + path.sep)) return null;
    const text = fs.readFileSync(real, "utf8");
    const headings = text
      .split("\n")
      .filter((line) => /^#{2,4} \S/.test(line))
      .map((line) => line.trim());
    return { tokens: Math.round(Buffer.byteLength(text) / 4), headings };
  } catch {
    return null;
  }
}

interface ChildOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string | null;
}

/**
 * Run one child as the agents' uid and collect what it printed.
 *
 * As the agents' uid for two reasons, one per child. The search is a script
 * that lives in the vault, which runs can write, so running it with the
 * server's authority would hand any run that edits `_Meta/` the server's
 * authority too. The gate is `claude`, whose credential is written 0600 by the
 * agents' uid and is unreadable to anybody else. `reviewEnv` is the environment
 * a reviewer gets, for a reviewer's reason: no token this app holds has any
 * business in either.
 */
function runChild(command: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (o: Omit<ChildOutcome, "stdout" | "stderr" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...o, stdout, stderr, timedOut });
    };
    const child = spawn(command, [...args], {
      cwd,
      env: reviewEnv(),
      ...childCredentials(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      if (stdout.length < 1_000_000) stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      if (stderr.length < 4_096) stderr += c;
    });
    child.on("error", (err) => finish({ code: null, error: err.message }));
    child.on("close", (code) => finish({ code, error: null }));
  });
}

/**
 * The directory the gate's `claude` runs in.
 *
 * Its own, so the gate's transcripts land under a project of their own in the
 * metering path rather than in the vault's, which is Dreaming's corpus, or in a
 * run's, whose spend they would then seem to be. Under `VAULT_SKILL_BASE` for
 * that constant's reason: root-owned and readable, written by nobody else —
 * and, like the skill's own directory, under the temporary directory instead
 * when there is no separation to build, which is also every host install.
 */
function gateCwd(): string {
  const dir = path.join(privilegeSeparated() ? VAULT_SKILL_BASE : os.tmpdir(), "uf-vault-gate");
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  return dir;
}

async function askGate(
  system: string,
  prompt: string,
  schema: object,
  cwd: string,
): Promise<{ output: unknown; costUsd: number }> {
  const args = [
    "-p",
    "--model",
    VAULT_GATE_MODEL,
    // No tools, no settings, no MCP and no skills: the gate reads what it is
    // handed and answers in JSON, and anything it could reach is something a
    // task's text could ask it to reach. Settings are skipped so that the
    // operator's own hooks, which are for agents, do not fire on a classifier;
    // a managed policy still applies, since nothing can skip that.
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema),
    "--system-prompt",
    system,
    ...promptArgs(prompt),
  ];
  const cli = spawnCommand(CLAUDE_BIN, args);
  const out = await runChild(cli.command, cli.args, cwd, GATE_TIMEOUT_MS);
  if (out.timedOut) throw new Error(`the gate gave no answer in ${GATE_TIMEOUT_MS / 1000}s`);
  if (out.error) throw new Error(`the gate could not start: ${out.error}`);
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(out.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`the gate exited ${out.code} without its JSON result: ${oneLine(out.stderr || out.stdout, 300)}`);
  }
  const costUsd = gateCost(result);
  if (result.is_error === true || result.structured_output === undefined) {
    throw new Error(`the gate answered with an error: ${oneLine(String(result.result ?? ""), 300)}`);
  }
  return { output: result.structured_output, costUsd };
}

/**
 * What one gate call cost, priced from its tokens by this app's own table.
 *
 * Not the CLI's `total_cost_usd`: the pinned 2.1.280 does not know
 * `claude-haiku-5-5`, warns `unrecognized_model`, runs it anyway and prices it
 * at a fallback rate — measured at $0.0018 for a two-word reply that 2.1.310
 * priced at $0.0001. The CLI's figure is kept only for a result with no usage
 * block, where it errs high, which is the direction a cost record may err in.
 */
export function gateCost(result: Record<string, unknown>): number {
  const usage = result.usage;
  if (typeof usage === "object" && usage !== null) {
    return costOf(readTokens(usage as Record<string, unknown>), resolvePrice(VAULT_GATE_MODEL));
  }
  return typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0;
}

async function searchVault(script: string, vaultRoot: string, query: string): Promise<Array<Omit<VaultCandidate, "tokens" | "headings">>> {
  // `python3` by name, as the skill tells an agent to run it, and from the
  // vault's root so that the script finds the vault the way it does for them.
  const out = await runChild("python3", [script, "--json", "-n", String(PER_QUERY), query], vaultRoot, SEARCH_TIMEOUT_MS);
  if (out.timedOut) throw new Error(`the vault's search gave no answer in ${SEARCH_TIMEOUT_MS / 1000}s`);
  if (out.code !== 0) throw new Error(`the vault's search exited ${out.code}: ${oneLine(out.stderr, 300)}`);
  return readSearchHits(out.stdout);
}

/**
 * Bounds how many gates run at once across the install.
 *
 * A `claude` child is a few hundred megabytes for a few seconds, and runs start
 * in bursts — `promoteQueued` after a boot or a fleet resume can start twenty
 * at once. Two at a time turns that burst into a queue of seconds rather than
 * twenty CLIs in memory together.
 */
const GATE_CONCURRENCY = 2;
const gateSlots = ((globalThis as unknown as { __ufVaultGateSlotsV1?: { busy: number; waiting: Array<() => void> } })
  .__ufVaultGateSlotsV1 ??= { busy: 0, waiting: [] });

async function withGateSlot<T>(work: () => Promise<T>): Promise<T> {
  if (gateSlots.busy >= GATE_CONCURRENCY) {
    await new Promise<void>((resolve) => gateSlots.waiting.push(resolve));
  } else {
    gateSlots.busy++;
  }
  try {
    return await work();
  } finally {
    const next = gateSlots.waiting.shift();
    if (next) next();
    else gateSlots.busy--;
  }
}

/**
 * The pointer for a run about to open a conversation, in either arm.
 *
 * Both arms are asked, as the prior-read pointer computes its list for both:
 * which held-out runs *would* have been shown a note is the whole of what the
 * comparison needs, and it cannot be recovered afterwards. A failure anywhere
 * is an answer with no picks and the failure named, never a thrown error: this
 * is never a reason for a run not to start.
 */
export async function resolveVaultPointer(o: {
  runId: string;
  task: string;
  taskTitles: readonly string[];
  vaultRoot: string;
  searchScript: string;
}): Promise<VaultPointer> {
  const arm = vaultPointerHoldout(o.runId) ? "holdout" : "pointer";
  let costUsd = 0;
  try {
    return await withGateSlot(async () => {
      const cwd = gateCwd();
      const asked = await askGate(QUERY_SYSTEM, gateTask(o.task), QUERY_SCHEMA, cwd);
      costUsd += asked.costUsd;
      const written = (asked.output as { queries?: unknown })?.queries;
      const queries = [
        ...o.taskTitles.slice(0, MAX_TITLE_QUERIES),
        ...(Array.isArray(written) ? written.filter((q): q is string => typeof q === "string").slice(0, 3) : []),
      ]
        .map((q) => oneLine(q, 200))
        .filter((q) => q !== "");
      if (queries.length === 0) return { arm, picks: [], costUsd, failure: "no query could be written for this task" };

      const lists: Array<Awaited<ReturnType<typeof searchVault>>> = [];
      for (let at = 0; at < queries.length; at += SEARCH_PARALLEL) {
        const round = queries.slice(at, at + SEARCH_PARALLEL);
        lists.push(...(await Promise.all(round.map((q) => searchVault(o.searchScript, o.vaultRoot, q)))));
      }
      const candidates = mergeCandidates(lists).flatMap((hit) => {
        const shape = noteShape(o.vaultRoot, hit.path);
        return shape ? [{ ...hit, ...shape }] : [];
      });
      if (candidates.length === 0) return { arm, picks: [], costUsd, failure: null };

      const judged = await askGate(JUDGE_SYSTEM, renderJudgePrompt(o.task, candidates), JUDGE_SCHEMA, cwd);
      costUsd += judged.costUsd;
      return { arm, picks: readJudgeVerdict(judged.output, candidates), costUsd, failure: null };
    });
  } catch (err) {
    return { arm, picks: [], costUsd, failure: err instanceof Error ? err.message : String(err) };
  }
}
