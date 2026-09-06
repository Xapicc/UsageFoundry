/**
 * What an operator's verify command is allowed to be, and nothing that runs it.
 *
 * Split out of `landGate.ts` for one reason: that file spawns, so it imports
 * `node:child_process` and cannot be reached from a client component. The
 * Settings field that writes `landVerifyCommand` has to be able to say "this
 * will be refused" while the operator is still typing, and a second copy of the
 * rule living in the page would be two parsers disagreeing about a value that
 * decides whether a branch reaches the operator's checkout.
 */

/** Characters that only mean anything to a shell. Refused, never escaped. */
const SHELL_METACHARACTERS = /[;&|<>$`(){}[\]!#*?~\n\r\\]/;

export type VerifyCommand =
  | { ok: true; argv: string[] }
  | { ok: false; reason: string };

/**
 * Split an operator's verify command into argv, or say why it cannot be one.
 *
 * Pure, and its failure mode is the silent kind this repository tests for: a
 * parser that quietly dropped a metacharacter would run a DIFFERENT command
 * from the one the operator read back to themselves in Settings, and it would
 * pass its own tests while doing it.
 */
export function parseVerifyCommand(raw: string): VerifyCommand {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, reason: "no verify command is configured" };
  if (SHELL_METACHARACTERS.test(text)) {
    return {
      ok: false,
      reason:
        "a verify command is argv, never a shell line — remove the shell " +
        "characters, or put them in a script and name the script here",
    };
  }
  const argv = text.split(/\s+/).filter(Boolean);
  if (!argv.length) return { ok: false, reason: "no verify command is configured" };
  return { ok: true, argv };
}
