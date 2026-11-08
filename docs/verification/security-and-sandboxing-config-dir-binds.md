# Verification: Security and sandboxing — the sandbox's config-directory binds

[← Verification index](../verification.md)

## Verified

- **The sandbox's config-directory binds re-read on 2.1.310, 2026-10-25: one
  name added.** `sandboxMountPoints.test.ts` threw at `y1t`, a third sidecar
  call in the `remote-settings.json` loop, written as `e+cY` with a default
  argument rather than a template literal; `cY` is `".synced-at"`. With the
  reader taught that shape, the CLI binds `remote-settings.json.synced-at`
  as a file, which is now a placeholder (`sandboxMountPoints.ts` says why), and
  the suite passes against 2.1.310 (21 of 21) and, as it should, fails its
  accounting against 2.1.280.

- **The sandbox's config-directory binds re-read on the pinned 2.1.280,
  2026-09-27, and the bound set is not identical: one name was added.**
  `sandboxMountPoints.test.ts` threw at "the config-directory bind loop" against
  the installed `claude.exe` (`claude --version` → 2.1.280). The loop is still
  there in the same shape; the test hard-coded two minified names (`tl`, `SN`)
  and 2.1.280 renamed all five the loop uses. `Gy`/`jy`/`tf`/`zy`, which the
  board task suspected, are not the sandbox. They are byte-identical in 2.1.260
  and belong to the Bash script-path classifier, where `zy` marks a dotfile,
  `tf` a dot-directory other than `.claude*/` or `.config/` (`private_dotdir`)
  and `jy` a path under one of `Gy`'s five data directories. None of them binds
  anything. With every identifier now discovered, the extraction run over
  `npm pack @anthropic-ai/claude-code-linux-arm64@2.1.260` and over 2.1.280
  differs by one name, `policy-limits.json.stamp.json`. It is a file, named by a
  third sidecar function (`${e}.stamp.json`) spread into the list. Every name
  2.1.260 bound is unchanged, file or directory. The stamp went onto
  `SANDBOX_CONFIG_DIR_REFUSED`, because 2.1.280 reads an empty stamp as
  `unusable` rather than `absent` and marks the policy cache's HIPAA history
  incomplete. The test was watched to fail four ways: against 2.1.260, with the
  stamp dropped from the list, against a copy of 2.1.280 with the loop's bytes
  altered, and against a copy naming an undefined sidecar function. Caveat: this
  is arm64 only. The twelve project-`.claude` names are still outside the
  test's extraction, so the claim that they are unchanged rests on reading both
  binaries by eye.

- **The `remote-settings.json` "Unable to find … in mount table" failure is not
  a missing mount point, read 2026-09-27.** The transcripts under
  `~/.claude/projects` hold two real events, both solo `Bash` calls in a dockrac
  worktree: 2026-09-20T18:06Z on 2.1.260 and 2026-09-26T17:02Z on 2.1.280. In
  both the bind source is `/oldroot/home/node/.claude/remote-settings.json`, the
  file itself, so the CLI found it present and emitted the self-mount form, and
  bwrap failed after the bind rather than on a create. The code that binds it is
  the same in both versions. So it does not follow from 2.1.280, and
  pre-creating in `sandboxMountPoints.ts` cannot touch it. The same wording also
  appears on tree-root dotfiles (`/workspace2/.zprofile`) and on
  `config.worktree`. Caveat: the cause was not established. A rewrite of the
  file between bwrap's bind and its mount-table lookup fits the message but was
  not measured, and the file's current mtime (2026-09-26 22:27Z) postdates the
  failure, so the question cannot be settled from what is on disk now.

- **That failure is a delete-and-recreate race, not a rename, measured
  2026-09-27 against bwrap 0.8.0 and CLI 2.1.280.** bwrap looks its bind target
  up in `/proc/self/mountinfo` right after binding it. The message means the
  path's directory entry was replaced in between, which detaches the bind. A
  nested `bwrap --ro-bind f f` reproduced it word for word: 462 of 1,000 starts
  against a rename-over loop, 155 of 400 on the `~/.claude` virtiofs share, and
  357 of 1,000 against unlink-then-recreate. It failed 0 times in 1,400 against
  in-place writes, 0 in 1,000 each against sibling churn and a `stat` loop on
  the share, and 0 in 300 with no writer. Only unlink-then-recreate also gives
  "Can't get type of source: No such file". This install's transcripts show
  that wording on the file twice (2026-09-20, 09-26), alongside the three
  mount-table-family events and "Can't create file" as late as 09-25, so the
  file keeps vanishing. Neither 2.1.260 nor 2.1.280 renames it: both write it
  in place (`open(…, "w")`). It is deleted by the auth-change cache clear and
  by the sandbox's placeholder cleanup, which unlinks any zero-byte file at a
  path its process covered with `/dev/null`. It is recreated by bwrap's
  placeholder create or by the CLI's first write. `~/.claude` is listed twice
  in a sandbox's mount table, but so is `/workspace2`, so that is the
  read-only root bind with the write allowlist's bind on top, not the share.
  The race also fails on overlay, where nothing is stacked. Nothing in this app
  can prevent it. Pre-creating the file is refused in
  `SANDBOX_CONFIG_DIR_REFUSED`, and an empty file there is exactly what that
  cleanup deletes. The cost is one tool call, and the file has been stable
  since it regained content (inode and mtime unchanged 07:57 to 08:17Z). Caveat:
  which deleter fired at each event is inferred. Logging
  `stat -c '%i %s %Y' ~/.claude/remote-settings.json` through the next spell
  when it is missing would settle that.

- **A replacement also strips the read-only bind from sandboxes already
  running, measured 2026-09-27 on bwrap 0.8.0.** A nested sandbox binding a
  file read-only under a read-write bind of its directory could not write the
  file until something outside renamed over it. After that the bind was gone
  from its mount table and the write succeeded. It happened live at 08:08:44Z:
  this session's own Bash sandbox lost its bind on `~/.claude/.config.json`,
  whose mtime is that same second. Caveat: the writer was not identified, the
  deny list is the CLI's and not this app's, and nothing here was changed for
  it.

- **Which deny-listed `~/.claude` files the CLI replaces by rename, and whether
  that widens anything, read off CLI 2.1.280 on 2026-09-27.** By rename, so the
  bind strips: the global config (`.config.json` at its legacy path, else
  `.claude.json`) and `settings.json` through `vv` (temp file beside the target,
  or in `.cc-writes` for `settings.json`), and `.credentials.json` and
  `policy-limits.json.stamp.json` through `cQ` (byte 190881839). In place, so the
  bind holds: `remote-settings.json` (`open(..., "w")`, byte ~203301020),
  `policy-limits.json` (`writeFile`, byte ~203076400) and the `.signature.json`
  sidecars; both halves of the earlier reading stand. Live: a scratch home's
  `.config.json` changed inode (53037914 to 53037957) across its first
  `claude -p`, with nine "written atomically" debug lines, and a nested
  `bwrap --ro-bind` on it refused a write until that rename and allowed it after;
  a second run rewrote nothing. Only `settings.json` would widen a later cycle,
  being the honoured source for `sandbox.filesystem.allowWrite` and permissions
  (`orchestrator.ts:5497-5507`), and neither run rewrote it: its inode held
  across both. The global config does get rewritten, but the eleven
  permission-rule sources (byte 193336360) do not include it, so the legacy
  `projects[cwd].allowedTools` it still parses (byte 192721656) grants nothing;
  what its lapse opens is an `mcpServers` entry a later work cycle would load,
  since that argv carries no `--strict-mcp-config` (`cycleInvocation.ts:1188`).
  `.credentials.json`'s lapse exposes a read, not a widening. Against the open
  "No sandbox has ever honoured the per-run write set": with
  `UF_LOCK_CLAUDE_HOME` unset `settings.json` is agent-writable anyway, so the
  lapse adds no route; with it set the directory is root-owned 0750
  (`docker-entrypoint.sh:705-707`), no rename into it can succeed from the
  agent's uid, and `vv` falls back to writing in place, which keeps the bind.
  Caveat: both runs were unauthenticated and stopped at "Not logged in", so an
  authenticated cycle's writes were not watched, and the locked half is read
  from the writer rather than run, like the lock itself.
  `docs/agent/security.md` states no guarantee that these binds hold.

- **The sandbox's bind lists are unchanged on 2.1.319, 2026-11-08.**
  `sandboxMountPoints.test.ts` run with `CLAUDE_BIN` at the macOS build of
  2.1.319: 21 of 21 passed and none skipped, so the tree-root list and both
  config-directory lists still match what that build binds. Caveat: the
  darwin build, whose bundled JavaScript is assumed to be the linux one's.

## Not yet verified by hand

None yet.
