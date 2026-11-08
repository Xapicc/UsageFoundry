# Verification: Security and sandboxing, what this app's own git runs from a repository a work cycle wrote — the push doors, Deliver and Projects

[← Verification index](../verification.md)

## Verified

- **A push to a local-path remote runs that repository's receive hooks,
  whatever this app's git is told, 2026-11-06.** Apple git 2.54.0, a bare
  repository with a `hooks/pre-receive` and a configured `pre-receive` hook,
  pushed to by path from `git -c core.hooksPath=/dev/null -c
  hook.r.enabled=false push`: both hooks ran. The receiving side is a second
  git that reads its own repository's configuration, and neither pair reached
  it. Not measured on 2.39.5, and not through `git()`.

- **Deliver's push sent an annotated tag under `push.followTags`, and
  `--recurse-submodules=check` would refuse a branch it has always sent,
  2026-11-08.** Board task `2b0d973f`, branch at `60db46c4`, git 2.39.5.
  `deliverRun.test.ts`' harness with `push.followTags=true` in the repository
  and an annotated tag on the run's tip: the bare remote held
  `refs/tags/internal-release-candidate` beside the branch, and with
  `--no-follow-tags` it held the two branches only. Through the compiled
  `git()`, `push <sha>:refs/heads/x` with and without `--no-follow-tags
  --recurse-submodules=check`: no submodule, and a submodule commit on its
  remote, pushed either way; a submodule commit on no remote pushed without
  the flag and was refused with exit 128 (`not be found on any remote`) with
  it, from a sha source and from a branch name. With
  `push.recurseSubmodules=on-demand` set, a sha source pushed the parent and no
  submodule commit, through `git()` and through plain git. Caveat: local bare
  remotes only, parent and submodule both.

- **Neither push door spawns a push to a local path, so no receiving hook
  runs, on git 2.39.5, 2026-11-08.** Board task `474d09dd`, branch at
  `d8e52114`, `git --version` 2.39.5 (the image's). `deliverRun.test.ts` and
  `projectPush.test.ts`, each with a bare repository holding an executable
  `hooks/pre-receive` that writes a marker: a plain `git push` to it wrote the
  marker (the control). With `origin` a path, a `file://` URL, a `pushurl` to a
  path, a `pushInsteadOf` to it and an `insteadOf` to it, Deliver's card and
  press and Projects' button and press each refused (`is not a GitHub remote`,
  `not-github`) with no marker and nothing reaching the path. With the
  `https://` test in `planDelivery` and in `githubDestination` replaced by a
  constant in the compiled modules, all ten cases failed on the marker, so
  through this app's `git()` on 2.39.5 a push to a path did run the receiving
  repository's `pre-receive`. The harnesses never push to a path: their
  remotes are `https://github.com/acme/<name>.git`, carried to bare
  repositories by a stand-in `git-remote-https` on `GIT_EXEC_PATH`, which is
  how `originPushUrls` accepts them. Also, `remote.origin.mirror=true` with
  Deliver's explicit refspec failed closed (`--mirror can't be combined with
  refspecs`). Caveat: a configured hook on the receiving side (git 2.54 and
  later) was not driven; the image has no such git, and the refusal comes
  before the spawn whatever the version.

## Not yet verified by hand

None yet.
