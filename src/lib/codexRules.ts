/**
 * The `pkill`/`killall` denial, for a provider that has no `--disallowedTools`.
 *
 * `cycleInvocation.ts`'s `PROCESS_KILLERS` is what stands between an unattended
 * agent and the supervisor process it runs inside, and it rides every Claude
 * cycle's argv unconditionally. Codex has no argv flag that can express it: the
 * only mechanism that can refuse a *command* is execpolicy, whose rules are
 * Starlark files, and — measured against `codex-cli 0.153.4` with
 * `RUST_LOG=codex_core::exec_policy=debug` — the only place they are discovered
 * from is `$CODEX_HOME/rules/*.rules`. There is no argv flag and no `-c` key
 * naming a rules file: `policy_paths`, `exec_policy.policy_paths`,
 * `execpolicy.paths`, `exec_policy_paths` and `experimental_execpolicy_files`
 * were each tried and each left `policy_paths=[]` in the trace. A file in that
 * one directory is the whole of the mechanism, which is why this module writes
 * one rather than adding a flag.
 *
 * Two things about that are worth having in front of anyone editing this file,
 * because both are disclosed to the operator rather than only commented here.
 *
 * **It is a file, not a flag, so it is install-wide.** `$CODEX_HOME` defaults to
 * the agent uid's own `~/.codex` — it has to, because that is where the
 * credential a cycle bills against lives and a work cycle runs with a dropped
 * uid (`config.ts`'s `CODEX_HOME` carries the whole argument). So the denial
 * this installs is also in force for an operator's own interactive `codex` in
 * that home. That is a real difference from the Claude path, where the deny list
 * is per-spawn and reaches nothing the operator does by hand.
 *
 * **It is a weaker denial than `--disallowedTools`.** Codex's own
 * `<permissions instructions>` block states that a command using redirection,
 * command substitution, environment-variable prefixes or wildcards "will not be
 * evaluated against rules", so `$(echo pkill) node` may well reach the process
 * table with the rule in place. That specific bypass is **not** measured — no
 * turn has ever been run against a live model here — and it is the reason the
 * disclosure says the denial is weaker rather than saying it is equivalent.
 *
 * Nothing here is a substitute for `--ignore-rules` being absent from the argv:
 * that flag means "do not load user or project execpolicy `.rules` files", so a
 * cycle carrying it would load none of this. `buildCodexArgs` never emits it.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CODEX_HOME } from "./config";

/**
 * The commands a work cycle may not run, and the reason each is on the list.
 *
 * Deliberately the same two names as `PROCESS_KILLERS`, in the same order, so
 * that the two providers deny the same set and a third name added to one is a
 * visibly missing name in the other. The incident behind it is recorded there
 * and not repeated here: a run's `pkill -f "next-server|next dev"` matched the
 * supervisor it was running inside and marked fourteen runs failed.
 */
export const CODEX_FORBIDDEN_COMMANDS = ["pkill", "killall"] as const;

/** Where the rules this app owns live, inside the directory Codex reads. */
export const CODEX_RULES_FILE = path.join(
  CODEX_HOME,
  "rules",
  "usagefoundry-process-killers.rules",
);

/**
 * The rules file's contents, as a pure function of the list above.
 *
 * `prefix_rule` with a one-word pattern is what was measured to work:
 * `codex execpolicy check -r <file> pkill node` answers
 * `{"decision":"forbidden"}`. `rule` and `define_program` do not exist in this
 * version, so a file written against either dialect loads as zero rules — and
 * *that* is the failure this function's test exists to catch, because a rules
 * file that fails to parse denies nothing while looking exactly like one that
 * does.
 *
 * The header names this app so an operator reading their own `~/.codex` can
 * tell where the file came from and what deleting it would cost them.
 */
export function codexRulesText(
  commands: readonly string[] = CODEX_FORBIDDEN_COMMANDS,
): string {
  return [
    "# Written by UsageFoundry. Deleting this file lets an agent it spawns kill",
    "# the server process that supervises it, which fails every run in flight.",
    "",
    ...commands.map(
      (command) =>
        `prefix_rule(pattern=["${command}"], decision="forbidden")`,
    ),
    "",
  ].join("\n");
}

/** Whether the denial is in place for the cycle about to spawn. */
export type CodexRulesDelivery =
  | { kind: "ready"; file: string }
  | { kind: "unavailable"; reason: string };

/**
 * Put the denial where Codex will find it, or say why it is not there.
 *
 * Rewritten per cycle rather than once per install, `plugins.ts`' reason: the
 * file is outside anything this app owns exclusively, so "it was written at
 * boot" is not evidence that it is there now. The write is atomic for the
 * reason `readGuard.ts`' is — a cycle spawning while a half-written file is on
 * disk would load a rules file that parses to nothing.
 *
 * The caller must **refuse the cycle** on `unavailable` rather than log it and
 * carry on. That is the one place this differs from the read guard, which
 * degrades to a cycle that re-reads files: this degrades to a cycle that can
 * kill the supervisor, and the Claude equivalent is not optional either.
 */
export function prepareCodexRules(): CodexRulesDelivery {
  const dir = path.dirname(CODEX_RULES_FILE);
  const tmp = `${CODEX_RULES_FILE}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(tmp, codexRulesText());
    // World-readable on purpose: the process that writes it is the server, and
    // the process that has to read it is the cycle, under a different uid.
    fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, CODEX_RULES_FILE);
    return { kind: "ready", file: CODEX_RULES_FILE };
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The rename is what matters; a leftover temp file is not worth masking
      // the error that caused it.
    }
    return {
      kind: "unavailable",
      reason: `${CODEX_RULES_FILE} could not be written: ${(err as Error).message}`,
    };
  }
}
