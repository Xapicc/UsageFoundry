-- What the transcripts could only approximate, asked of the app's own DB.
-- Not run: /data is read-denied in the sandbox and there is no docker CLI.
--   docker exec -i usagefoundry sqlite3 -readonly /data/usagefoundry.db < settle-from-db.sql
-- Columns from src/lib/db.ts migrate(): runs(id, folder, repo_root, isolation,
-- worktree_branch, status, created_at, started_at, finished_at, landed_at,
-- landed_into), run_events(run_id, ts, kind, payload), run_reviews(id, run_id,
-- created_at, finished_at, status, kind, cost_usd, resolved_paths, resolved_commit).
-- All timestamps are epoch milliseconds.

-- 1. Naive-span concurrency per repository (parked time included).
WITH r AS (
  SELECT id, COALESCE(repo_root, folder) AS repo, started_at AS s,
         COALESCE(finished_at, CAST(strftime('%s','now') AS INTEGER) * 1000) AS e
    FROM runs WHERE started_at IS NOT NULL
)
SELECT a.repo,
       COUNT(*)                                   AS overlapping_pairs,
       ROUND(SUM(MIN(a.e, b.e) - MAX(a.s, b.s)) / 3.6e6, 1) AS pair_overlap_hours
  FROM r a JOIN r b ON a.repo = b.repo AND a.id < b.id AND a.s < b.e AND b.s < a.e
 GROUP BY a.repo ORDER BY overlapping_pairs DESC;

-- 2. Live (cycle) intervals: an `iteration` event opens a cycle; the next
--    `status` event of the same run closes it.
CREATE TEMP VIEW cycles AS
SELECT i.run_id, COALESCE(r.repo_root, r.folder) AS repo, i.ts AS s,
       (SELECT MIN(x.ts) FROM run_events x
         WHERE x.run_id = i.run_id AND x.kind = 'status' AND x.ts > i.ts) AS e
  FROM run_events i JOIN runs r ON r.id = i.run_id
 WHERE i.kind = 'iteration';
SELECT a.repo, COUNT(DISTINCT a.run_id || '|' || b.run_id) AS live_pairs,
       ROUND(SUM(MIN(a.e, b.e) - MAX(a.s, b.s)) / 3.6e6, 1) AS live_pair_hours
  FROM cycles a JOIN cycles b
    ON a.repo = b.repo AND a.run_id < b.run_id AND a.s < b.e AND b.s < a.e
 GROUP BY a.repo ORDER BY live_pairs DESC;

-- 3. Each paid conflict resolution, against the siblings that landed into the
--    same target after the resolved run started, and whether they were live
--    at the same time as it (naive span).
SELECT rr.id, rr.created_at, rr.status, rr.cost_usd, r.worktree_branch,
       s.worktree_branch AS sibling, s.landed_at,
       (s.started_at < COALESCE(r.finished_at, rr.created_at)
        AND r.started_at < COALESCE(s.finished_at, s.landed_at)) AS spans_overlap
  FROM run_reviews rr
  JOIN runs r ON r.id = rr.run_id
  JOIN runs s ON COALESCE(s.repo_root, s.folder) = COALESCE(r.repo_root, r.folder)
             AND s.id <> r.id AND s.landed_at BETWEEN r.started_at AND rr.created_at
 WHERE rr.kind = 'resolve'
 ORDER BY rr.created_at;
