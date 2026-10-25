# Verification: Security and sandboxing, the managed policy's Unix sockets

[← Verification index](../verification.md)

## Verified

- **The pinned CLI reads `sandbox.network.allowAllUnixSockets`, and the key
  skips the seccomp filter, 2026-10-25.** Board task `e81b4553`. Strings read
  out of `claude.exe` 2.1.310 (not executed): the settings schema declares the
  key ("allow all Unix sockets, disables blocking on both platforms"; on Linux
  it also unblocks `AF_VSOCK`), the Linux wrapper logs "Skipping seccomp filter
  - allowAllUnixSockets is enabled", and the domain list is built from
  `allowedDomains` entries and `WebFetch(domain:)` rules whether or not a
  `network` object exists, so adding the key alone leaves that list as it was.
  Caveat: read, not run.

- **The container this was written in holds no Unix socket worth reaching,
  2026-10-25.** From inside a sandboxed `Bash` call: no `/var/run/docker.sock`,
  `/run/docker.sock` or `/run/containerd/containerd.sock`, no `docker` on `PATH`,
  no `/dev/vsock`, nothing with `sock` in `/proc/self/mountinfo`, and `find /
  -type s` listed only `/tmp/claude-http-*.sock` and `/tmp/srt-mux-*.sock` (six
  of each), the sandbox runtime's own egress bridges. No `cc-socks` socket
  existed. Caveat: one container, one afternoon, and sockets in a mount the
  sandbox hides from `find` would not show.

- **The policy block writes the key in both shapes, 2026-10-25.**
  `deployment.test.ts` runs the entrypoint's policy block against a scratch
  directory with `UF_SANDBOX_ALLOWED_DOMAINS` named and unset, and
  `JSON.parse`s each file: `network` is `{allowedDomains, allowManagedDomainsOnly:
  true, allowAllUnixSockets: true}` and `{allowAllUnixSockets: true}`. Against
  the previous entrypoint the two shape cases fail. `bash -n` and `dash -n` pass.
  Caveat: this shows the file, not what the CLI does with it.

## Not yet verified by hand

- **That a sandboxed `AF_UNIX` bind now succeeds**, which needs the rebuilt
  image: the sandbox that wrote this refuses `AF_UNIX` and `AF_VSOCK` alike.
  In a run after the rebuild:
  ```bash
  python3 -c "import socket; socket.socket(socket.AF_UNIX).bind('/tmp/x.sock')"   # expect: exit 0
  ```
  Then, with `UF_SANDBOX_ALLOWED_DOMAINS` naming a domain, that the allowlist
  still holds with the filter gone: `curl -sS -m 10 https://example.org` from a
  sandboxed call must fail while a listed domain succeeds.

- **That a dial to another session's bridge socket is refused.** The proxy
  reads a per-session token from `Proxy-Authorization`, which a sibling's
  commands are handed and this session's are not; read in sandbox-runtime
  0.0.71, never exercised. From a sandboxed call, send `CONNECT
  example.org:443` to another run's `/tmp/claude-http-*.sock` without that
  token; expect `407`.
