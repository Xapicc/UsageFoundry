import {
  DEFAULT_LIMITER,
  type AttemptState,
  type LoginVerdict,
  planLoginAttempt,
  recordFailure,
} from "./loginLimiter";

/**
 * The edge gate's budget on `Authorization: Bearer` guesses at `UF_AUTH_TOKEN`.
 *
 * Every route accepts the master token as a bearer header, and the gate used to
 * compare it with no counter at all: a wrong one was a 401, the right one was
 * let through, and that held while `/api/login` sat locked — the oracle the
 * sign-in limiter's own rule exists to forbid, on every route, with no budget.
 *
 * **In memory, deliberately, and what that costs is written down rather than
 * absorbed.** `middleware.ts` runs in the edge runtime and cannot reach the
 * `login_attempts` table, so this bucket is not the sign-in one: the two
 * budgets are separate, a restart empties this one, and nothing on the Settings
 * page reports it. The alternative was moving the gate to the Node runtime so
 * it could charge the table directly — one budget, durable, and the sign-in
 * lock refusing bearers too — but that changes what `middleware.ts` *is*, and
 * it is the same move that would let the gate read session revocations, so it
 * is that decision rather than a part of this one. Both budgets bound guessing;
 * together they allow twice the install-wide rate, plus one budget per restart.
 *
 * **Install-wide only, with sign-in's shorter lockout.** A per-source bucket
 * would key on `x-forwarded-for`, which a caller writes itself, so it would be
 * evadable by the guesser and fillable against the operator's own scripts. And
 * a lock any caller can trip must be short, because it refuses the operator's
 * scripts too — never their browser, whose cookie the gate checks first.
 *
 * **A right bearer refunds nothing.** On sign-in a success clears both buckets,
 * which is right for a press that happens once a day. A script polling with the
 * real token would clear this one between every pair of guesses, and the budget
 * would bound nothing.
 *
 * On `globalThis` for the reason every long-lived module state here is: a dev
 * reload re-evaluates the module, and a counter that reset on every reload is a
 * counter an attacker never meets.
 */

type BearerGuesses = { state: AttemptState | null };

const store = globalThis as unknown as { __ufBearerGuesses?: BearerGuesses };
const guesses = (store.__ufBearerGuesses ??= { state: null });

/**
 * May a bearer be compared at all? Asked before the comparison, and with nothing
 * awaited between this, the comparison and `recordBearerFailure`, which is what
 * keeps a concurrent burst from passing the check whole.
 */
export function checkBearerAllowed(now: number): LoginVerdict {
  return planLoginAttempt({ now, source: null, global: guesses.state });
}

export function recordBearerFailure(now: number): void {
  const before = guesses.state;
  guesses.state = recordFailure(
    before,
    now,
    DEFAULT_LIMITER.maxGlobalFailures,
    DEFAULT_LIMITER.globalLockoutMs,
  );
  if (guesses.state.lockedUntil !== null && before?.lockedUntil == null) {
    console.warn(
      `[usagefoundry] Bearer access locked out install-wide after ` +
        `${guesses.state.failures} wrong tokens. Session cookies still work.`,
    );
  }
}
