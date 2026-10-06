# Sign-in limits

[← testing index](../testing.md)

Read before adding or editing tests of `loginLimiter.ts`, `loginAttempts.ts`, or any case that sends more than one wrong token: the budgets on `/api/login` and what charges them.

`loginLimiter`'s two (`loginLimiter.test.ts`) fail in opposite directions, one that never fires being bit-for-bit the unbounded route and one that never lets go locking the operator out of an app whose only other credential is an environment variable and a restart.

`src/app/api/login/route.test.ts` carries the limiter's *concurrent* half, because the pure decision cannot see it: `planLoginAttempt` was right all along, and the route asked it and charged the answer on opposite sides of `await req.json()`, so a burst passed the check whole and the budgets bounded only a client that waited for each answer. Two bursts pin it — one source sending three times its budget at once, and rotating sources sending more than twice the install-wide budget, twice, with `Date.now` wound past the global lockout between them — and each asserts the *exact* split between 401 and 429 rather than an upper bound, since a limiter that refused the whole burst would pass a bound while locking the operator out early. Every answer's body is read and compared, because the oracle rule is that a locked answer and a wrong one look the same. The cases clear `login_attempts` behind them: a global lock left standing refuses every later case in the file, and the wound clock leaves one that outlives the real minute.
