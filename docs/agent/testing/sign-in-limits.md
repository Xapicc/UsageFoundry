# Sign-in limits

[← testing index](../testing.md)

Read before adding or editing tests of `loginLimiter.ts`, `loginAttempts.ts`, or any case that sends more than one wrong token: the budgets on `/api/login` and what charges them.

`loginLimiter`'s two (`loginLimiter.test.ts`) fail in opposite directions, one that never fires being bit-for-bit the unbounded route and one that never lets go locking the operator out of an app whose only other credential is an environment variable and a restart.

`src/app/api/login/route.test.ts` carries the limiter's *concurrent* half, because the pure decision cannot see it: `planLoginAttempt` was right all along, and the route asked it and charged the answer on opposite sides of `await req.json()`, so a burst passed the check whole and the budgets bounded only a client that waited for each answer. Two bursts pin it — one source sending three times its budget at once, and rotating sources sending more than twice the install-wide budget, twice, with `Date.now` wound past the global lockout between them — and each asserts the *exact* split between 401 and 429 rather than an upper bound, since a limiter that refused the whole burst would pass a bound while locking the operator out early. Every answer's body is read and compared, because the oracle rule is that a locked answer and a wrong one look the same. The cases clear `login_attempts` behind them: a global lock left standing refuses every later case in the file, and the wound clock leaves one that outlives the real minute.

The same file pins what a request carrying no forwarding header is charged to, in both directions, because each failure is silent in its own way. Ten headerless wrong guesses followed by the right token, also headerless, must be a 200: one shared bucket for every unnamed client locked the operator out on anybody's ten guesses, and nothing anywhere said whose they were. And a headerless burst past the install-wide budget must still be compared exactly that many times — the case that stops "held to no bucket of its own" from becoming "held to no budget at all", which would be the unbounded route again for the one client compose ships with.
