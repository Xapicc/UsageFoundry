# Verification: Build and release

[← Verification index](../verification.md)

## Verified

- **The standalone build boots and serves**, native SQLite binding included.

- **`npm run build` cannot finish on an agent worktree's virtiofs mount,
  2026-09-08**, at `23a3d45`: 4 of 4 died copying the standalone bundle, a
  different path each time; `rm -rf` gave `ENOTEMPTY` 6/40 there, 0/40 under
  `$TMPDIR`. `scripts/redirect-dist-dir.mjs` made 7 consecutive builds exit 0
  with a serving bundle; `distDir` and a bare symlink were measured and fail.

- **`next build` failing with `TypeError: generate is not a function` in a
  spawned run** is the inherited `__NEXT_PRIVATE_STANDALONE_CONFIG`; with it
  unset, `npm run build` builds cleanly, standalone output included.

- **Four traps for a hand check inside an agent's sandbox.** The ambient
  `NODE_ENV=production` makes `next dev` answer every request with a 500
  (`EvalError: Code generation from strings disallowed`); the ambient
  `WORKSPACE_ROOTS` silently outranks any `WORKSPACE_ROOT`; `UF_ALLOW_NO_AUTH=1`
  does not open the app while `UF_AUTH_TOKEN` is set — export it empty instead;
  and each shell has its own network namespace, so boot, seed, drive and tear
  down in one command.

## Not yet verified by hand

None yet.
