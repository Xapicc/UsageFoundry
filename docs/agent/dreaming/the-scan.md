# The scan: days, its memo and deduplication

[← dreaming index](../dreaming.md)

Read before editing `scanDreaming`, `dayKey`, the scan memo or `forgetDreamingFiles` in `src/lib/dreaming.ts`, or how `dreamingTimeZone` is read.

**A day is the operator's day.** `dayKey` takes a zone and `dreamingTimeZone`
supplies it, read twice: it decides when the pass fires *and* where a day begins.
UTC is the wrong boundary for a feature denominated in days — a session at 01:00
in Berlin belongs to the night the operator would call it — and the failure is
silent in the expensive direction: two sightings one local evening apart read as
two days and qualify for a note. An unknown zone falls back to UTC rather than
throwing, because a boundary off by an hour beats a blank page.

**The scan keeps its own cache and must never ride `scanUsage`'s.** `/api/usage`
already pays a cold transcript walk the dashboard is waiting on, and adding a
second parse of every file to it would put this feature's latency on a page that
has nothing to do with it. So `dreaming.ts` holds a per-file memo keyed on size
and mtime under its own `globalThis` key. Measured on the real corpus: cold 3,483
ms over 1,954 files, warm **21 ms with 0 files re-read**. The retention sweep
calls `forgetDreamingFiles` beside `forgetTranscriptFiles` — two caches over one
corpus, and a sweep that forgot only the first would leave this one holding the
parse of every transcript ever deleted for the life of the process.

**There is no eviction bound on the scan memo and that is deliberate**, which is
the one place this feature does not follow `transcripts.ts`. That cache holds
parsed turns and needs `TRANSCRIPT_CACHE_MAX_ENTRIES`; this one holds a
size/mtime stamp per file plus the error results, and the whole error corpus is
0.90 MiB across 23 days. It is bounded by the retention horizon through
`forgetDreamingFiles`. If it ever holds successful results it needs both.

**The scan deduplicates on the record, never on the signature, and the
distinction is load-bearing.** A resumed session copies its earlier records into
the new transcript, so the same failure is written twice in two different files
and a per-file pass cannot see it — `transcripts.ts` already dedupes across
files for exactly this reason. Measured: 2,567 error blocks carrying 2,435
distinct `tool_use_id`s, **132 surplus, 5.1%**. It moves the counts and not the
policy: no copied-forward record was ever found on a different day from its
original, so the same 78 signatures span two days either way. A future change
that deduplicated on the *signature* instead would silently collapse a genuine
recurrence into one sighting and stop writing notes at all, which is why
`dreamingScan.test.ts` asserts the day span as well as the instance count. This
was found by the first note the feature ever wrote — the agent re-derived the
counts from the corpus rather than trusting the ones it was handed.
