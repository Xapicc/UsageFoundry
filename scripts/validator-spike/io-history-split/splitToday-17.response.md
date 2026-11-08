The task required a working backup mechanism and a demonstrated restore for issue #92. The branch changed only five documentation files, and none of the code the documentation relies on is in the diff.

The five files are `README.md`, `docs/README.md`, `docs/backup-and-restore.md`, `docs/install.md` and `docs/verification.md`. The diffstat is complete, so this is not a shortened patch.

The new docs depend on several things the diff never adds:
- `scripts/backup-db.mjs`
- `scripts/restore-db.mjs`
- `backupRestore.test.ts`, which `docs/verification.md` says holds six unit tests
- a `deployment.test.ts` pin
- the `./backups` bind mount to `/backups`, with no `docker-compose.yml` change
- `sqlite3` in the image, with no `Dockerfile` change

The task's deliverable was a backup consistent under concurrent writes and a restore demonstrated end to end. A repo-wide search had found no `backup` or `restore` anywhere, so the scripts should not already exist. The `VACUUM INTO` mechanism, the restore refusals and the `--keep` pruning are described in prose but not implemented in the evidence.

```json
{
  "verdict": "not-finished",
  "reason": "Only five docs files changed; the backup/restore scripts, tests and compose/Dockerfile changes the docs describe are absent from the branch diff.",
  "evidence": ["diff touches only README.md, docs/README.md, docs/backup-and-restore.md, docs/install.md, docs/verification.md", "scripts/backup-db.mjs and scripts/restore-db.mjs never added", "backupRestore.test.ts and deployment.test.ts not in diff", "docker-compose.yml and Dockerfile unchanged despite docs relying on /backups mount and sqlite3"]
}
```
