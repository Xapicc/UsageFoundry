# Verification: Security and sandboxing, what this app's own git runs from a repository a work cycle wrote — filters, merge drivers and empty names

[← Verification index](../verification.md)

## Verified

- **A `--config-env` blank stops a filter driver named `a=b` on 2.39.5, and
  the `-c` blank does not, 2026-10-25.** Board task `a9fde194`, `main` at
  `5ba27e95`. The image's git 2.39.5, every `GIT_*` variable unset, a scratch
  `HOME` and `GIT_CONFIG_NOSYSTEM=1`. A fresh repository per case had
  `[filter "a=b"] clean = <prog>` in `.git/config`, `* filter=a=b` in
  `.git/info/attributes` and an edited tracked file, and `<prog>` writes a
  marker. `git -c 'filter.a=b.clean=' add -A` wrote the marker.
  `E= git --config-env='filter.a=b.clean=E' add -A` exited 0 and wrote none,
  and neither did `GIT_CONFIG_COUNT=1` with `GIT_CONFIG_KEY_0='filter.a=b.clean'`
  and an empty value. With `E` unset, `--config-env` exits 128 naming it. With
  `filter.a=b.required=true` as well, the three `--config-env` blanks made
  `add` exit 128 (`clean filter 'a=b' failed`) and wrote no marker. Caveat:
  uid 1000 in an agent container, not a booted image.

- **An empty `merge.<x>.driver` runs nothing and fails the merge on 2.39.5,
  where `false` and `true` each give a wrong merge, 2026-10-25.** Board task
  `a38856ec`, same harness as the entry above. Two branches changed lines 2
  and 5 of one file, `[merge "evil"] driver = <prog> %O %A %B` was in
  `.git/config` and `* merge=evil` in `.git/info/attributes`, and `<prog>`
  writes a marker and keeps theirs. With only `-c core.hooksPath=/dev/null`,
  `merge-tree --write-tree -z` and `merge --no-edit` each ran it. With `-c
  merge.evil.driver=` neither did: both printed `error: cannot run : No such
  file or directory`, `merge-tree` exited 128 and `merge` exited 2, and
  afterwards `status` was clean with no `MERGE_HEAD`. With `false`, both
  reported a content conflict in the file, and the marker was not written. With `true`, both
  reported a clean merge and the result was ours. A driver named `a=b` still
  ran under `-c 'merge.a=b.driver='` and did not under
  `--config-env='merge.a=b.driver=E'` with `E` empty. Caveat: uid 1000 in an
  agent container, not a booted image.

- **A filter behind `includeIf "onbranch:uf/**"` or `includeIf
  "gitdir:<repo>/.git/worktrees/"` is invisible from the main checkout and
  runs in `worktree add` and in an unforced `worktree remove`, 2026-10-25.**
  Board task `d8cae532`, same harness. The filter's `smudge` and `clean` were
  in `.git/evil.inc`, reached only through the include, with `* filter=evil`
  in `.git/info/attributes`. In the main checkout `git config --includes
  --get-regexp '^filter\.'` listed nothing. `worktree add -b uf/slot-1` ran
  the smudge in both forms. `worktree add --no-checkout` ran nothing; the
  same probe inside the new tree listed both commands; and `reset --hard
  --no-recurse-submodules` there with them blanked by `--config-env` ran
  nothing and left `status` clean. `worktree remove` of that tree after a
  `touch` ran the clean filter in both forms, and `remove --force` did not.
  In the main checkout, an in-process `checkout -b uf/new` and a `checkout` of
  an existing `uf/old` whose file differed ran nothing. When a plain add's
  checkout failed (a required filter), git deleted the tree and its
  registration and kept the `-b` branch. `--lock --reason initializing` shows
  as `locked initializing` in `worktree list --porcelain`, and a locked tree
  needs `remove -f -f`.

- **A blanked merge driver's failure starts with git's `cannot run :` line,
  2026-10-26.** Board task `adb9e828`, same harness as the merge-driver entry
  above. `merge-tree --write-tree -z` printed `error: cannot run : No such
  file or directory`, then `error: error: Failed to execute internal merge`
  and `fatal: failure to merge`, and exited 128. `merge --no-edit` printed the
  same first two lines, then `Merge with strategy ort failed.`

- **On git 2.56.0 a blanked merge driver makes `merge-tree` exit 1 with a
  conflict listing, and `parseMergeTree` now reads it as unknown,
  2026-11-08.** Board task `9dddc18a`, branch at `5773bb0b`. `git --version`
  2.56.0, a build of the `v2.56.0` tag with `NO_RUST=1` that a sibling run left
  under `$TMPDIR`, as `GIT_BIN` through this app's compiled `git()`; the
  image's 2.39.5 beside it. Two branches editing different lines of one file,
  `merge.evil.driver` set and `* merge=evil` in `.git/info/attributes`.
  `merge-tree --write-tree -z main side`: on 2.39.5 exit 128, empty stdout, and
  stderr `error: cannot run : No such file or directory (this app does not run
  a repository's merge drivers, so it blanked merge.evil.driver and …)`, then
  `error: error: Failed to execute internal merge` and `fatal: failure to
  merge`. On 2.56.0 exit 1, stderr only that first line, and stdout a complete
  conflict listing: the merged tree's oid, the file's three stage records, an
  empty record, then `Auto-merging` and `CONFLICT (content): Merge conflict in
  f.txt`. The driver ran on neither. `parseMergeTree` read exit 1 as
  `conflict` and the case "Land's preview of a merge the blank failed names
  the driver and says why" failed on 2.56.0 with `'conflict' !== 'unknown'`
  (53 of 54, the only failure). With `parseMergeTree` taking the line that
  carries `BLANKED_MERGE_DRIVER_NOTE` as an unknown, whatever the status,
  `gitFilterProbe.test.ts` passed 54 of 54 on 2.56.0 and 53 with one skip
  (the hook case) on 2.39.5, and `land.test.ts`' new case, fed the 2.56.0
  output above, failed with the check removed from the compiled module and
  passed with it. The real `merge --no-edit side` differs the same way: exit 2
  and a clean checkout on 2.39.5, exit 1 on 2.56.0 with `CONFLICT (content)`
  on stdout, `f.txt` as `UU` and a `MERGE_HEAD`, the file's content as it was
  and no marker run. Caveat: the real merge is only measured, not changed;
  Land's own `mergeRefusal` reading that exit 1 as a conflict is read from the
  code, not run.

- **A filter, merge driver or configured hook with an empty name runs, and a
  `--config-env` blank of it stops it, 2026-11-08.** Board task `582bceef`,
  `main` at `60db46c4`. The container's git 2.39.5 and `v2.56.0` built with
  `NO_RUST=1` against a scratch zlib under `$TMPDIR`, each under `env -i`. git
  lists `[filter ""]`, `[merge ""]` and `[hook ""]` as `filter..clean`,
  `merge..driver` and `hook..command`. On both, `filter..clean` with
  `* filter=` ran on `add -A` and did not under
  `--config-env=filter..clean=B`, `B` empty; `merge..driver` with `* merge=`
  ran on `merge-tree --write-tree`, and blanked it ran nothing and exited 128
  (2.39.5) or 1 (2.56.0). On 2.56.0 a `[hook ""]` `pre-commit` ran on
  `commit` and did not under `--config-env=hook..enabled=F` or
  `-c hook..enabled=false`. Through this app's compiled `git()` and
  `gitSync()`, `gitFilterProbe.test.ts`'s empty-name cases ran the plant at
  `60db46c4`, four on 2.39.5 and five on 2.56.0, and none with the change.
  Caveat: 2.54.0 was not built, and the hook case skips on 2.39.5.

- **On git 2.56.0 Land's real merge of a file a blanked driver failed read as a
  conflict in that file, and now gives the driver's sentence, 2026-11-08.**
  Board task `716f904b`, branch at `00299ab3`. Through this app's compiled
  `git()` with `GIT_BIN` at the `v2.56.0` build above, two branches changing
  different lines of `f.txt` under `merge.evil.driver` and `* merge=evil`:
  `merge --no-edit --no-overwrite-ignore side` and `merge --squash
  --no-overwrite-ignore side` each exited 1 with CONFLICT for `f.txt` on
  stdout, stderr only git's `cannot run :` line carrying the sentence,
  `UU f.txt`, MERGE_HEAD for the merge and none for the squash, and the
  driver did not run; `conflictedFiles` returned `["f.txt"]` and `unwind`
  returned `restored` with an empty status for both. On the image's 2.39.5
  both exited 2 over a clean checkout with nothing unmerged. The unfixed
  `mergeRefusal`, exported for the test, gave "The merge conflicted and was
  rolled back — your checkout is untouched. Conflicting: f.txt" for the
  2.56.0 shape; with the change, `land.test.ts`' five cases on those
  captured shapes pass, and on the 2.56.0 repositories above the reason for
  each was "git refused the merge, and your checkout is as it was:" and
  that line. With the two blanked checks taken out of the compiled module,
  three of the five fail. Caveat: `landRun` and `resolveConflicts` were not
  driven whole on 2.56.0, and that `unresolvableMerge` keeps a resolver from
  starting is read from the code.

## Not yet verified by hand

None yet.
