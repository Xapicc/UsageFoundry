# Gate blocks

[← testing index](../testing.md)

Read before adding or editing a test of a workflow gate: `holdGate`, `continueGate`, `gateContinueRefusal` and the gate arms of `planInstanceStep`, `bootBlockPlan` and `reconcileBlocksOnBoot` in `src/lib/workflows.ts`.

`gateBlock.test.ts`, which opens the database and drives a gate from reached to let through, halted, restarted over and repeated by a loop, with gates chained to gates and a loop whose section is one gate so that "released" is a column and nothing reaches a spawn, a git probe or a checkout. What it pins is what the pure decisions beside it in `workflows.test.ts` cannot be handed: that a reached gate is written exactly once (a sentinel in `held_at` survives later advances, where the clock would hide a second write inside one millisecond), that Continue is guarded on a column `status` does not carry, that `reconcileBlocksOnBoot` joins `held_at` as well as `status`, and that each pass of a loop opens a row of its own, so a press on pass 1 cannot be spent on pass 2.

Its last describe holds the restart's other half: a merge the boot failed, and a loop whose pass the restart closed out, each beside a held gate with a gate `X` hung off it `on-finish`. The boot spares the instance for its gate, so it is the advance after it that must block `X` rather than reach it, while the held gate keeps its `held_at` and what is behind it stays `waiting`. The loop case is the only one that reaches `advanceLoop`'s write of the mark, since the boot spares that loop `looping` and it is the advance that fails it. Both failed at 9e878484 with `X` reached.

Each of those fails by mutation. The boot join, the once-guard and the per-pass hold were each switched off in the compiled output and a case went red. Each is also silent in use: a run that goes on past the point a person asked to be stopped at, or a wait closed out under a page still offering the button.

Its own file and `DATA_DIR` set before the first import, `bootBlocks.test.ts`'s reason: `config.ts` reads it at module load, and the boot reconciler acts on every row in the database.

The pure half lives in `workflows.test.ts` and earns its place on the same grounds as the rest of that file: `planInstanceStep` is what keeps a block behind a gate from starting before a person has pressed Continue, `bootBlockPlan` is the decision whose wrong answer is invisible until a wait has been closed out, and the save-time refusals (every run field on a gate, a gate with nothing after it, `run → gate → merge`) are the ones a graph written by a model or an API client reaches without a canvas ever drawing them.
