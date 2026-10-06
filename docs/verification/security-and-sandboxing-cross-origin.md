# Verification: Security and sandboxing — which browser requests the session cookie authorises

[← Verification index](../verification.md)

## Verified

- **A page on another port is refused and the app's own pages are not, in
  Chromium against the standalone bundle, 2026-10-06.** Board task `0fa08b16`,
  commit `88f33a2` on `3d325d3`. `npm run build`'s `server.js` ran on
  `HOSTNAME=0.0.0.0`, port 39217, with a scratch `DATA_DIR` and a token. Global
  Playwright's Chromium signed in through the `/login` form, sent a same-origin
  `fetch` POST to `/api/tasks`, then opened a page on port 39218 that sent
  `no-cors` `text/plain` POSTs to `/api/tasks` and `/api/runs`. Over
  `localhost`, sign-in was 200 with `Sec-Fetch-Site: same-origin`, the
  own-page POST was 200, and both cross-port POSTs were 403. A 403 and not a
  401 means the cookie arrived and was valid. Over `uf.lan`, mapped to
  loopback, Chromium sent `Origin` and no `Sec-Fetch-Site`, because the origin
  is not trustworthy. The results were the same, and the own-page 200 there
  depended on the `Host` header, because `nextUrl` was `0.0.0.0:39217`. A
  bearer read afterwards listed only the own-page task. Caveat: not run through
  `docker compose` or a reverse proxy.

## Not yet verified by hand

- **A reverse proxy at `UF_PUBLIC_URL` that rewrites `Host`, and browsers
  other than Chromium.** No proxy was put in front, and only Chromium ran.
  Firefox and Safari are expected to omit `Sec-Fetch-Site` for an untrustworthy
  origin, as Chromium does, and so to reach the `Origin` fallback on a
  plain-http install. Settle: put nginx with `proxy_pass http://127.0.0.1:3000`
  and no `proxy_set_header Host` in front, on plain http under a non-loopback
  name so no `Sec-Fetch-Site` is sent. Set `UF_PUBLIC_URL` to that URL, sign in
  through it and save Settings, then repeat with `UF_PUBLIC_URL` blank and
  expect a 403 on the save.
