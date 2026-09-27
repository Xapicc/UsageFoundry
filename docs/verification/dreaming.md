# Verification: Dreaming

[← Verification index](../verification.md)

## Verified

- **The dreaming pane's cold read, streamed rather than read whole,
  2026-09-11**, at `8b7f1e2` on Node 22.23.2 over a real 1.91 GiB corpus (2,260
  `.jsonl` files). A fresh `next start` per run was asked for `/api/usage` and
  then `/api/dreaming`, in that order, with the peak read out of
  `/proc/self/status` by a `--require` preload; three runs each way at each heap
  cap. At the shipped `--max-old-space-size=2048`, VmHWM **1,478-1,552 MB before
  against 1,252-1,316 MB after**; at this install's 1,024, **898-949 MB against
  687-697 MB**. The readout is identical in all twelve runs — 2,260 walked,
  3,341 instances, 1,549 signatures, 128 recurring — and the cold scan is a
  little slower, 6.4-6.5 s before against 6.6-7.8 s after. Caveat: VmHWM is a
  high-water mark of RSS under a lazy collector rather than a live-set figure, so
  the saving moves with the heap cap and is not a fixed number of megabytes.

- **Dreaming end to end, 2026-09-02**, built app over the real corpus: the
  readout matches `proposals/Dreaming` (77 signatures, 1,260 of 2,553
  instances); warm scan 21 ms, 0 files re-read. One night ($9.40) wrote notes
  passing `_Meta/qc.py`'s ERROR gate for nine of twelve signatures, and found
  the scan double-counting the 5.1% of records resumes rewrite.

## Not yet verified by hand

- **Dreaming's nightly timer has never fired**: every night was a press, and
  `tickDreaming`, `reconcileDreamingOnBoot` and `armDreaming` have never run
  unattended; two faults a press cannot expose were found only by reading the
  code. Nothing enforces that an agent reads `CLAUDE.md` first. Settle: one
  03:04 that nobody is present for.
