import { spawn } from "node:child_process";

import { childCredentials } from "./privsep";
import { parseVerifyCommand, type VerifyCommand } from "./verifyCommand";

/**
 * The check an operator can put in front of Land.
 *
 * ## The gap this closes
 *
 * `docs/agent/isolation-and-landing.md` describes every condition Land already
 * enforces about the *checkout* — clean, on target, nobody working in it — and
 * none about the *work*. Without this an operator cannot say "do not land this
 * unless the tests pass": nothing in `landRun` asks, and the one setting that
 * read as though it did — `resolveAllowedTools`, called `resolveVerifyTools`
 * until that reading was the whole of why it was renamed — has a single reader
 * that is the conflict-resolution assist and ships as `[]`.
 *
 * That asymmetry is the point. This app will spend an afternoon of an
 * operator's allowance producing a branch unattended, then let it into their
 * checkout on a button that has checked the tree and nothing else.
 *
 * ## Off unless asked for, and a refusal rather than a warning
 *
 * `landVerifyCommand` is `""` by default and an empty command is not a check
 * that passes — it is no check, and Land behaves exactly as it does today.
 * When it is set, a non-zero exit REFUSES the land. A gate that warned would be
 * advice, and the invariant an operator wants here is the one they cannot
 * forget to read.
 *
 * ## Never a shell
 *
 * `docs/agent/security.md` states it for spawn argv and it holds here: the
 * command is split into argv and any shell metacharacter is refused at parse
 * time rather than escaped. An operator who wants `a && b` is asking for a
 * shell, and the honest answer is to say so and point at a script, not to
 * interpolate their string into `sh -c` where a repository name with a
 * backtick in it becomes execution.
 */

/**
 * The parser, and it lives in `verifyCommand.ts` rather than here.
 *
 * Re-exported so this file stays the one place to read about the gate, while
 * the Settings field that writes the value can import the rule without
 * dragging `node:child_process` into a client bundle.
 */
export { parseVerifyCommand, type VerifyCommand } from "./verifyCommand";

export type VerifyOutcome = {
  ran: boolean;
  passed: boolean;
  /** What to show the operator. Empty when there is nothing to say. */
  reason: string;
};

/**
 * What Land should do with a finished check.
 *
 * Separated from running it so the decision is testable without a subprocess,
 * which is the half that decides whether somebody's work merges.
 */
export function landVerdict(o: {
  configured: boolean;
  parse: VerifyCommand;
  exitCode: number | null;
  timedOut: boolean;
  tail: string;
}): VerifyOutcome {
  if (!o.configured) return { ran: false, passed: true, reason: "" };
  if (!o.parse.ok) {
    // A command that cannot be parsed is NOT a pass. The operator asked for a
    // gate; handing them an open door because their string was malformed is the
    // failure this whole module exists to prevent, and it would be silent.
    return {
      ran: false,
      passed: false,
      reason: `The verify command is not runnable: ${o.parse.reason}.`,
    };
  }
  if (o.timedOut) {
    return {
      ran: true,
      passed: false,
      reason:
        "The verify command did not finish in time, so nothing here knows " +
        "whether this branch is good. Land refused rather than guessed.",
    };
  }
  if (o.exitCode === 0) return { ran: true, passed: true, reason: "" };
  const tail = o.tail.trim();
  return {
    ran: true,
    passed: false,
    reason:
      `The verify command exited ${o.exitCode ?? -1}, so this branch was not ` +
      `landed.` + (tail ? ` Its last output was: ${tail}` : ""),
  };
}

/**
 * Environment for the verify child.
 *
 * The same strip every other child this app spawns gets, and every exclusion's
 * reasoning is the block above `CONTEXT_SHAPING_ENV` in `orchestrator.ts`,
 * which the copies of this list cite in turn. It is a copy and not an import:
 * `docs/agent/security.md` is explicit that a new spawn site takes a copy
 * rather than a shared module, because a denylist that moves has to be read at
 * every site that spawns and an import is what stops it being read — and here
 * the import would also put the whole run loop behind the Land button, the
 * same objection `authEnv` records and the same one that split
 * `verifyCommand.ts` out of this file.
 *
 * Until this existed the spawn below passed **no `env` at all**, so the child
 * inherited `process.env` whole. Two consequences, and only the first is a
 * security one:
 *
 * - `UF_AUTH_TOKEN` opens `POST /api/runs`, `PUT /api/settings` and every other
 *   run's diff; `ANTHROPIC_ADMIN_KEY` and `DATA_DIR` are the same shape one
 *   notch down. The command is the operator's, written in Settings, but *what
 *   it runs* is not: the default shape of a verify command is `npm test`, and
 *   the script behind that name lives in the `package.json` of the tree Land is
 *   about to merge — a tree an agent wrote. That is the argument the docblock
 *   over `runVerify` already makes for the uid, and this is the half it did not
 *   carry through.
 * - `__NEXT_PRIVATE_STANDALONE_CONFIG` breaks `npm run build` as a verify
 *   command in every Next repository: this server is a Next standalone server,
 *   so the variable is set on it in production and carries *this* app's
 *   resolved config, and an inheriting child gets `loadConfig()` returning that
 *   JSON verbatim instead of reading its own `next.config.ts`. The build dies
 *   on the `generateBuildId` a JSON round trip could not carry, and
 *   `landVerdict` reports that as a failing check — so the operator is told
 *   their branch is bad by an error that names none of this.
 *
 * `PATH` is deliberately not on the list, here as everywhere: the command is
 * resolved on it, and a gate that could not find `npm` would refuse every land.
 *
 * `FORCE_COLOR: "0"` for a reason the other copies do not have: a failing
 * check's last output is carried into `landVerdict`'s refusal and rendered as
 * text, so a test runner that decided it was talking to a terminal would spell
 * that sentence with escape sequences in it.
 */
export function verifyEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0" };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("UF_") ||
      key.startsWith("OTEL_") ||
      key.startsWith("__NEXT_") ||
      key === "ANTHROPIC_ADMIN_KEY" ||
      key === "OPENAI_API_KEY" ||
      key === "CODEX_API_KEY" ||
      key === "CLAUDE_CODE_ENABLE_TELEMETRY" ||
      key === "DATA_DIR" ||
      key === "NODE_OPTIONS"
    ) {
      delete env[key];
    }
  }
  return env;
}

/** How long a check may take before Land stops waiting on it. */
export const VERIFY_TIMEOUT_MS = 15 * 60_000;

/** How much of a failing check's output the refusal carries. */
export const VERIFY_TAIL_BYTES = 2000;

/**
 * Run the configured check in the checkout Land is about to merge into.
 *
 * As the child uid, not the server's: this runs a command an operator wrote
 * against a tree an agent produced, and `docs/agent/security.md`'s reason for
 * separating those uids does not stop applying because the command came from
 * Settings rather than from a model. `verifyEnv` is the same argument applied
 * to what the child can read, which for a long time this spawn did not make.
 */
export function runVerify(
  cwd: string,
  raw: string,
  deps: { timeoutMs?: number } = {},
): Promise<VerifyOutcome> {
  const configured = Boolean((raw ?? "").trim());
  const parse = parseVerifyCommand(raw);
  if (!configured || !parse.ok) {
    return Promise.resolve(
      landVerdict({ configured, parse, exitCode: null, timedOut: false, tail: "" }),
    );
  }
  const [bin, ...args] = parse.argv;
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(landVerdict({ configured, parse, exitCode, timedOut, tail: out }));
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        cwd,
        env: verifyEnv(),
        ...childCredentials(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        ran: false,
        passed: false,
        reason: `The verify command could not start: ${
          err instanceof Error ? err.message : String(err)
        }.`,
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, deps.timeoutMs ?? VERIFY_TIMEOUT_MS);
    const take = (chunk: string) => {
      out = (out + chunk).slice(-VERIFY_TAIL_BYTES);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    // Settled through the same latch as `close`, and the timer cleared with
    // it. A bare `resolve` here leaves `settled` false and a 15-minute
    // `setTimeout` armed on a child that never started: the promise the caller
    // holds is already answered, so nothing is visibly wrong, but the server's
    // event loop carries a pending timer for a quarter of an hour per failed
    // press. `error` and `close` both fire for an ENOENT, and the latch is
    // what stops the second one re-answering with a different verdict.
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ran: false,
        passed: false,
        reason: `The verify command could not start: ${err.message}.`,
      });
    });
    child.on("close", (code) => finish(code));
  });
}
