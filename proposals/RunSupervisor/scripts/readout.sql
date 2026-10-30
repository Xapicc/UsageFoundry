-- RunSupervisor readout: the figures 13-validation.md §3's thresholds are read against.
-- Not run here: /data is read-denied to a work cycle and there is no docker CLI.
--   docker exec -i usagefoundry sqlite3 -readonly /data/usagefoundry.db < readout.sql
-- Timestamps are epoch milliseconds (as proposals/CrossSessionCommunication/scripts/
-- settle-from-db.sql records). A pick-up clears runs.ending_code and
-- runs.needs_review_reason (src/lib/orchestrator.ts reopenRun), so endings are
-- counted from run_events' status events rather than from the row: setStatus emits
-- { status, ...patch } (src/lib/orchestrator.ts:1797).

.mode column
.headers on

-- 1. needs-review endings per week (%W, Monday-based). run_events expire after
--    eventRetentionDays (30 by default), so this sees about the last month: run it monthly.
SELECT strftime('%Y-W%W', ts / 1000, 'unixepoch') AS week,
       COUNT(*) AS needs_review_endings,
       COUNT(DISTINCT run_id) AS runs
  FROM run_events
 WHERE kind = 'status' AND json_extract(payload, '$.status') = 'needs-review'
 GROUP BY week ORDER BY week;

-- 2. Of those runs, how many were later picked up, and with a note.
--    reopened_at is set by every pick-up; follow_up_is_note is the last pick-up's.
WITH asked AS (
  SELECT DISTINCT run_id FROM run_events
   WHERE kind = 'status' AND json_extract(payload, '$.status') = 'needs-review'
)
SELECT COUNT(*) AS asked,
       SUM(r.reopened_at IS NOT NULL) AS picked_up,
       SUM(r.reopened_at IS NOT NULL AND r.follow_up_is_note = 1) AS picked_up_last_with_note
  FROM asked a JOIN runs r ON r.id = a.run_id;

-- 3. After Phase 1 ships: refunds spent through the answer box.
--    Fails with "no such column" before then, which is the expected answer.
SELECT SUM(review_answers) AS answers_given, SUM(review_answers > 0) AS runs_answered FROM runs;

-- 4. Tasks runs filed for the operator, per week (the board route decisions take today).
SELECT strftime('%Y-W%W', created_at / 1000, 'unixepoch') AS week,
       SUM(operator_only = 1) AS operator_only_tasks,
       COUNT(*) AS run_filed_tasks
  FROM tasks
 WHERE origin = 'run'
 GROUP BY week ORDER BY week;
