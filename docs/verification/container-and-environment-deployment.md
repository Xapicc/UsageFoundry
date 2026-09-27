# Verification: Container and environment — the image, network, volumes, backup and health

[← Verification index](../verification.md)

## Verified

- **Multiple workspaces:** slots list independently, a disabled one is skipped,
  a missing one reads unavailable rather than empty, and a folder maps back to
  its workspace through a symlinked mount.

- **Backup and restore against a live writer:** mid-transaction, `cp` got 25
  runs and `scripts/backup-db.mjs` the live 386, both passing
  `integrity_check`; restore never deletes, refuses under a live
  `server.lock`, and a copy killed part-way leaves the database in place.
  Seven tests in `backupRestore.test.ts`.

- **`UF_BIND_ADDRESS=0.0.0.0` with a token, from the LAN address:** bound
  `0.0.0.0:3000`, `/api/usage` 401 bare and 200 with the bearer; with
  `UF_COOKIE_SECURE=0` the cookie had no `Secure`. A new binding needs a
  recreate; `docker compose restart` keeps the old one.

- **Go in the image, arm64 only:** the tarball passed `sha256sum --check`, the
  image reports `go1.26.6 linux/arm64` with both caches under `/home/node/go`,
  and a fresh cache volume was re-owned to `UF_AGENT_UID=1001` once.

- **`jq` 1.6 in the image, 2026-08-25:** runs as uid 1000 under
  `uf-seccomp.json`, unwrapped and inside both `bwrap` shapes, unconfigured.

- **Discord's 400, the in-container relay, and the URL it keeps,
  2026-08-24.** The generic body to a live Discord webhook got 400 (`"code":
  50006`), `{"content": …}` 204. `scripts/discord-relay.mjs` forwarded a
  signed body (204; unsigned 401). The server holds no `DISCORD_*`, and uid
  1000 was refused the root relay's environ.

- **Playwright renders a real page as uid 1000, 2026-08-24.** 1.62.1 on
  Debian 12 arm64 installed Chrome for Testing 151.0.7922.34 (`chromium-1234`,
  641 MB, plus a 340 MB headless shell) and screenshotted `/login` correctly
  at 1280×800. Chromium's own sandbox is unusable (`unshare` EPERM) and
  unneeded: `chromiumSandbox` defaults to false.

- **`playwright install` fails in the container two ways; rendering does
  not, 2026-08-25.** As uid 1000, `EACCES: permission denied, open
  '/opt/playwright/browsers/.links/4aea…'` (a root-owned link file); under
  `UF_SANDBOX=1`, `Read-only file system` (`srt` 0.0.71). Screenshots work
  both ways. A bare-`srt` ENOENT on `/tmp/claude` is an artifact; don't add it.

- **The host-side causes of an unreachable LAN install are ruled out.** From
  the container's own host, `lsof -nP -iTCP:3000 -sTCP:LISTEN` showed Docker on
  `*:3000` and the macOS application firewall was confirmed disabled.

## Not yet verified by hand

- **That the next boot after a failed restore comes up green on an empty path
  was not executed**; it follows from `db.ts`'s unconditional
  `new Database(DB_PATH)` and wants a container.

- **Go on amd64, and a real agent building Go, are unchecked:** the amd64
  branch and digest were never built; only a shell has built Go in the image.

- **`jq` has not run inside a CLI-wrapped `Bash` call**, only in `bwrap`
  command lines.

- **The image has not been built since `npm run build` gained its wrapper.**
  `scripts/redirect-dist-dir.mjs` was measured to do nothing on `overlayfs`,
  which `/app` is on, so the builder should reach `next build` as before; that
  is an argument, not a measurement (no docker client). Settle: `docker
  compose up --build`.

- **`RELAY_PORT` and `RELAY_BIND` have never reached a container.** They are
  in compose's `environment:`, statically reconciled by `deployment.test.ts`;
  unseen are compose substituting them, the relay inheriting them and delivery
  on a moved port. Settle with `RELAY_PORT=9000`: `printenv`, then a notifying
  run's message must arrive: the listening line looked healthy while none did.

- **No second machine has reached a LAN install, and no browser has signed in
  to one.** Client isolation is not ruled out, and `curl` cannot see the
  `Secure`-cookie failure. From another machine, run
  `curl -sf http://<host>:3000/api/health`, sign in and reload; a bounce to
  `/login` means `UF_COOKIE_SECURE` is not `0`.

- **`/api/status` has not been polled on an install with runs in flight.**
  `npm test` covers it on a six-row database; its cost at size is reasoned. No
  browser drew the restart banner, and no monitor has scraped a stdout JSON
  line or checked one for a prompt, path or token:
  `docker logs usagefoundry --since 1h | grep '^{' | jq -c .`

- **Docker has never run the container's `HEALTHCHECK`.** `/api/health` is
  tested both ways and `deployment.test.ts` pins the directive, but the image
  was never built. Settle with `docker inspect --format '{{json
  .State.Health}}' usagefoundry`; after `kill -STOP 1` it should read
  `unhealthy` within ~3 min. Docker reports that and restarts nothing.

- **No Docker has applied the container's log cap.** `json-file`, 20m × 5, is
  pinned by `deployment.test.ts`, but no line has been seen rotating; ~270 B a
  line and README's 25-run fleet rates are derived, not measured. A daemon
  `log-driver` in `/etc/docker/daemon.json` would silently override it.
  ```bash
  docker inspect -f '{{json .HostConfig.LogConfig}}' usagefoundry
  # expect {"Type":"json-file","Config":{"max-file":"5","max-size":"20m"}}
  ```

- **The image with `gh` in it.** The install layer, the checksum check and the
  arch mapping have not been built — no Docker on the machine this was written
  on — so `docker compose up --build` is the first thing to run against this.

- **That a fresh `usagefoundry-data` volume is writable under a non-1000
  `UF_UID`.** `/data` is 0777, relying on Docker copying that mode onto a new
  volume; no `docker build` since. On Linux with `id -u` not 1000, then again
  with both uid variables unset:
  ```bash
  UF_UID=1001 UF_GID=1001 UF_PORT=3100 UF_CONTAINER_NAME=usagefoundry-uidtest \
    docker compose -p uf-uidtest up --build -d
  docker compose -p uf-uidtest exec usagefoundry ls -ld /data   # expect drwxrwxrwx
  curl -fsS localhost:3100/api/usage >/dev/null && echo OK      # with UF_AUTH_TOKEN blank
  docker compose -p uf-uidtest down -v
  ```

- **Backup and restore inside Docker.** Driven against real databases and the
  real scripts, never through the container; a restore after
  `docker compose down -v` is the case it exists for.
  ```bash
  docker compose up -d --build
  docker compose exec usagefoundry which sqlite3
  docker compose exec usagefoundry node scripts/backup-db.mjs /backups
  ls -la backups/
  # then, with the app stopped:
  docker compose down
  docker compose run --rm --entrypoint node usagefoundry \
    scripts/restore-db.mjs /backups/usagefoundry-<stamp>.db
  docker compose up -d
  ```

- **The `VACUUM` command in `README.md`**, never executed; check it names one
  `usagefoundry-data` volume and leaves the database file's ownership alone.
