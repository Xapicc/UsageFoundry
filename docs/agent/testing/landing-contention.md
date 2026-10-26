# Another git process in the operator's checkout

[← testing index](../testing.md)

Read before adding or editing the cases that pin what a land does when another git process holds a lock in the operator's checkout. They live in four files whose other grounds are in [landing-and-delivery.md](landing-and-delivery.md) and [merge-queue.md](merge-queue.md); they are here because that first file is past the size this directory keeps to. The rule they pin is [another-git-in-the-checkout.md](../isolation-and-landing/another-git-in-the-checkout.md).

`landAfterVerify.test.ts`' three new cases in its index-lock describe drive the real `landRun` with the lock held for 300 ms rather than for the whole land, which is the queue's case: a fast-forward and a true merge each land without a second press, and a MERGE_HEAD planted over an unchanged tree refuses the land in `checkoutRefusal`'s sentence with the MERGE_HEAD still there. All three failed before the fix — the first with `lockRefusal`'s sentence, the second under git 2.39.5 with exactly the queue's "could not be rolled back … Unable to write index.", the third with the MERGE_HEAD gone. The true merge is the one that needs 2.39.5 to mean what it says: that version writes MERGE_HEAD before it meets the lock, so it exercises the abort's retry as well as the merge's, where 2.54 refuses the merge before writing anything. The describe's older cases hold the lock throughout, so each now pays the seven seconds of waits before it refuses; they are kept as the stale-lock path, which is real.

`landUnwind.test.ts`' abort case is the version-independent half of that: a conflicted merge, the lock held for 300 ms, and `unwind` must say `restored` with no MERGE_HEAD left, where it said `mid-merge` before.

`land.test.ts`' `passingRefusal` cases are the predicate's two directions, each silent when wrong: a refusal it misses is a failed row for a millisecond's contention, and one it takes in is a branch merged into the checkout four times. `landRecheck`'s list of refusals gains a merging checkout, held to `landRefusal`'s sentence like the others. `mergeQueue.test.ts`' `planItem` case is the halt, which a checkout read as clean never reached.

The suite on the macOS host's git 2.54 fails "says a merge left part-way is part-way" before and after this change, because that case is written to 2.39.5's MERGE_HEAD; it and the rest of these pass inside the container (`docs/verification/isolation-and-landing-contention.md`).
