The task asks for a working backup (a consistent online copy of the SQLite database), a restore path, and the operator-facing steps. The diff's five files are all documentation: `README.md`, `docs/README.md`, `docs/backup-and-restore.md`, `docs/install.md` and `docs/verification.md`. The docs describe `scripts/backup-db.mjs`, `scripts/restore-db.mjs`, a `backupRestore.test.ts`, a `deployment.test.ts` pin, a shipped `./backups` bind mount and `sqlite3` in the image. None of those appear in the diffstat, and the diff touches no `Dockerfile`, no `docker-compose.yml`, no `scripts/` file and no `src/` file. The only history commit (c9669074) concerns the paused-run sweeper in `orchestrator.ts` and has nothing to do with backup. So the mechanism the task is about, and the tests and packaging the docs cite, are absent. Documentation that says the scripts exist is not the scripts existing.

```json
{
  "verdict": "not-finished",
  "reason": "Diff is docs only; the backup and restore scripts, their tests and the Dockerfile/compose changes the docs cite are never added, and the one history commit is an unrelated sweeper change.",
  "evidence": [
    "diffstat: README.md, docs/README.md, docs/backup-and-restore.md, docs/install.md, docs/verification.md only",
    "scripts/backup-db.mjs and scripts/restore-db.mjs referenced by the docs but not added anywhere in the diff",
    "backupRestore.test.ts and deployment.test.ts cited in docs/verification.md but not in the diff",
    "no Dockerfile or docker-compose.yml change, though the docs depend on a ./backups bind mount and sqlite3 in the image",
    "history commit c9669074 only touches src/lib/orchestrator.ts and orchestrator.test.ts (paused-run sweeper)"
  ]
}
```
