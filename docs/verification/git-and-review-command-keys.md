# Verification: Git keys that run a command

[← Verification index](../verification.md)

What was measured about the keys `commandClassOf` in `src/lib/gitDirWatch.ts` watches; the reasoning is in `docs/agent/security/run-git-dir-watch.md`.

## Verified

- **Eight more keys run a planted value in git 2.39.5.** Measured 2026-10-25 for board task `0543690d`, in throwaway repositories under `$TMPDIR` with `env -i`, `GIT_CONFIG_NOSYSTEM=1` and a scratch `HOME`. Each key was set in `.git/config` to something that writes a marker. `instaweb.httpd` naming a fake `lighttpd`, and `instaweb.gitwebDir` naming a directory holding one, each ran on `git instaweb --start`. Without either, the same command said `lighttpd not found` and wrote nothing. `imap.tunnel` ran on `git imap-send` with a patch on stdin, and `tar.tar.gz.command` on `git archive -o x.tar.gz HEAD`. An `ext::sh -c touch…` URL ran as `branch.main.remote` on a plain `git fetch`, as `submodule.lib.url` on `git submodule update`, and as `branch.main.pushRemote` or `remote.pushDefault` on a plain `git push` from a branch tracking `origin`. Each of those four needed `-c protocol.ext.allow=always`; without it none ran. Caveat: so an `ext::` URL runs only where `protocol.allow`, itself watched, or the operator's own configuration allows it.

- **A repository's own `uploadpack.packObjectsHook` is not run.** Same date and setup. A source repository had the key in `.git/config`, naming a wrapper that writes a marker and then runs `pack-objects`. `git clone file://…` of it wrote no marker; the same key in the scratch `HOME`'s `.gitconfig` did. That is why it is not watched. Caveat: one version, 2.39.5; git-config(1) at 2.56.0 says the same.

## Not yet verified by hand

- **`guitool.<name>.cmd`, `svn.authorsProg`, `instaweb.modulePath` and `gc.recentObjectsHook` running a planted value.** Reasoned, not run: git gui, git svn and Apache are not in the image, and its git predates the gc key (git 2.42). The grounds are git-config(1) at 2.39.5 and 2.56.0, `perl/Git/SVN.pm`'s `call_authors_prog` (runs the value in backticks), `git-instaweb.sh`'s `LoadModule … $module_path/mod_*.so`, and `reachable.c`'s `gc.recentobjectshook`. To settle it, on a host with git 2.42 or later, git-gui, git-svn and apache2, set each in a scratch repository's `.git/config` to write a marker. Then pick the tool from git gui's Tools menu; run `git svn fetch` against a repository with an author missing from `svn.authorsFile`; run `git instaweb --httpd="apache2 -f" --start` with the module path pointing at a directory of non-modules and see Apache fail on a file from there; and run `echo x | git hash-object -w --stdin` then `git gc --cruft`.
