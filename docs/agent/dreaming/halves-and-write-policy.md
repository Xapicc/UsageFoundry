# Two halves, the corpus, signatures and the write policy

[← dreaming index](../dreaming.md)

Read before editing `signatureOf` or `selectWritable` in `src/lib/dreaming.ts`, `dreamingMinDays`, `settings.dreamingEnabled`, or anything that makes the readout depend on the writer's configuration.

**Two halves, and only one of them can be wrong.** The readout is arithmetic over
the transcript corpus: `tool_result` blocks carrying `is_error`, normalised into
signatures, counted per day. It writes nothing, needs no configuration, is
always available, and its failure mode is a bug rather than a false claim in
somebody's document store. The writer is a nightly run pointed at the operator's
vault, and that half *can* be wrong — so everything about it is built around the
question of how a wrong note gets found and taken back. **`settings.dreamingEnabled`
is off by default and is the only setting in this app that authorises an
unattended write into a store this app does not own.** A change that makes the
readout depend on the writer's configuration, or that makes the writer reachable
without that flag, breaks the split the whole feature rests on.

**Why the corpus is the error slice and not the day.** Measured in
`git show a74a1bb:"proposals/implemented - Dreaming/scripts/tool-corpus.mjs"`: the whole tool corpus is 5,521k
tokens a night, overflows a 1,000k window on 21 of 23 days and by 12.8× on the
worst, and — the figure that actually decides it — **99.8% of it by bytes carries
no deduplication key.** An error result has a message a signature can be taken
from; a successful one has nothing to match on but a model's own judgement, which
is a nightly retrieval-then-judgement pass over 1,224 notes with no verifier. The
error slice is 0.90 MiB over 23 days, 11k tokens a night, and is 100% keyed.
Widening the corpus is not a scope decision, it is a decision to delete the
deduplication mechanism.

**The write policy is the feature, and its number is measured rather than
chosen.** `scripts/ledger.mjs` over the same 23 days: writing every distinct
signature every night produces **1,361** notes; writing each once on first sight
produces **1,177**, of which **1,100 (93.5%) are about something that never
happened again**; writing on the night a signature reaches its *second* day
produces **77**, all about something seen on two or more days. So `selectWritable`
takes `minDays` and a set of already-written signatures, and `dreamingMinDays`
defaults to 2. A ledger *alone* saves 13.5% and still doubles a 1,224-note vault
in 24 days — the deduplication everyone reaches for first is the small half. The
latency the policy costs was measured too and must not be presented as free:
median 3 days from first sighting to the night it qualifies, mean 3.8, max 20.

**A signature is a string, not a cause, and every surface has to say so.**
Normalisation collapses numbers, hex runs and path interiors, so one cause
appears as several rows — four `bwrap` denials at four paths are one denial — and
one row carries many causes, of which `Exit code N` is the worst in this corpus.
`signatureOf` matches `scripts/recurrence.mjs` **exactly**, and that is not
tidiness: the script is how every figure behind this feature was measured, so a
normalisation that drifted from it would leave `git show a74a1bb:"proposals/implemented - Dreaming/"` describing a
different feature. Roughly half the top recurring rows are not failures at all —
a person declining a tool call, a permission prompt working correctly — and
nothing separates them, which is why the page carries the caveat and the prompt
tells the run to skip them rather than write about them.
