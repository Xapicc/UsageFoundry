# The knowledge vault reader, vault skill and graph view

[← testing index](../testing.md)

Read before adding or editing tests of `knowledge.ts`, `vaultSkill.ts`, `knowledgeGraph.ts`, `forceLayout.ts` and `canvasView.ts`.

`knowledge.test.ts` is the vault reader, and it earns its place on the `parsePlanUsage` grounds one step further out: it parses a *format*, and the format belongs to another program that nothing here can ask.

A link form the scanner does not know about is not an error and never will be — it is a note that reads as having fewer connections than it has, on a page whose entire purpose is to show connections — so each of the six forms Obsidian writes is a case, as are the two things that must **not** become links, a fenced block and an inline span, which one vault of engineering notes turns into hundreds of false tags and phantom notes if the stripper is wrong.

The resolution order is the other half and the sharper one: basename, then path, then alias, with ties to the shortest path.

Put aliases first and giving one note an alias equal to another note's filename silently repoints every link written with that filename — an edge nobody wrote, drawn confidently, with nothing anywhere to report it — so that inversion is its own case against a hand-built two-note fixture.

The broken-link cases are there because the tempting implementation drops what it cannot resolve, which turns "this vault has 212 dangling links" into a graph that reads as complete, and the complete-looking one is the reading an operator would act on.

And the cache cases pin the only claim that makes the walk affordable — an unchanged vault returns the *same object*, an edited note invalidates and the notes beside it do not — because a cache that misses an edit shows yesterday's graph indefinitely with a "last scan" beside it saying otherwise.

The fixture is a `Record<path, contents>` literal materialised into a `mkdtemp` directory: there is no fixture-directory convention in this repo, every other file that needs files builds them the same way, and cache invalidation is a claim about `mtimeMs` and `size` that nothing short of a real file can carry.

It writes its own timestamps forward explicitly rather than trusting the clock, since a rewrite inside one coarse mtime tick keeps the old stamp and the test would pass by measuring nothing.

The browse and health cases were added when the vault got a page, and they earn their place on a different failure from the parser's: every one of them is a *count an operator reads as a fact about their vault*, and each way of getting it wrong leaves a page that looks right.

Facets counted over the filtered set rather than the whole vault give a picker whose every option says the number you are already looking at, and whose other options quietly vanish as you narrow — so the ancestor counting is pinned against a synthetic vault where a folder's own notes and its children's differ.

A folder filter written as `startsWith` matches `Archive` against `Archived Projects`, which is a filter that silently includes what it excludes; `noteType` reading the `type/moc` *tag* rather than the `type:` property turns a tag convention into a phantom type column, and the fixture's own `INDEX.md` is exactly that case.

The page window is pinned in both directions — that page two is disjoint from page one, and that an offset past the end lands on the last page rather than on nothing — because an empty final page is indistinguishable from a filter that matched nothing, and the operator's next move differs.

The three sort orders each tie-break on path, since an unstable order reshuffles rows under a reader between two identical requests.

And the health lists are pinned as coming from one pass with the counts, because a list sliced to a cap beside a count derived separately is how a panel comes to say "19 orphans" above twenty rows.

`vaultSkill.test.ts` is the generated vault-lookup skill, and it earns its place because the failure is silent *twice over* — once in a program that is not this one, and once in a model.

A SKILL.md whose frontmatter does not parse is skipped by the CLI: the spawn succeeds, the argv is right, the run's log says nothing, and the debug output only ever names the plugin it did load. So the frontmatter's shape is a case rather than a comment, and the case is the one a later edit is likeliest to break — that every key is on one line, asserted against a vault label carrying a colon and an em dash, because reflowing the description to fit the margin is a natural edit that turns the file into something YAML rejects.

The rest is the contract with the *reader*: that the resolved absolute path is in the body verbatim, that the instruction to stop rather than answer from memory survives, that the sentence forbidding writes survives — `--add-dir` was measured to grant **write**, so that sentence is the whole of the protection — and which of the two search branches was taken, since a vault with no ranked search that quietly greps is a run making a claim about relevance nothing measured.

`findSearchScript`'s three cases pin the order and the absence, the absence being the one that matters: a script named but not there opens every cycle with a command that fails.

Deliberately not tested is `writeVaultSkill`, whose claims are about ownership and mode on an install this suite does not run on — `privsep.test.ts` is where that reasoning lives, and it is on `verification.md`'s not-yet-verified list rather than pretended at here.

`knowledgeGraph.test.ts` and `forceLayout.test.ts` are the graph view, and they earn their place on `knowledge.test.ts`'s grounds one layer up: every decision either file makes is invisible from the picture it produces, because a wrong graph is still a graph.

`parseGraphQuery`'s cases are one per way of misreading the box, and each one is a *quiet* misreading — a quoted phrase split into two AND terms narrows the result instead of failing, a `tag:` read as a bare term matches the word in a title, an `OR` dropped turns a union into an intersection, and a lone `-` left as a literal blanks the whole graph for as long as it takes to type the next character.

That last one was a real defect and the test was written failing.

`groupIndexFor`'s two are the whole of what the reorder buttons are for: first-match-wins is the rule the numbered rows in the panel *state*, so a scan that returned the last match instead would leave the operator moving rows and watching nothing change.

The filter cases split on where each predicate is evaluated rather than on what it does, since the order is the part that can be wrong while every individual answer is right: a kind toggle has to take the edges that reached it away too, or the graph keeps links to nodes that are gone; and **orphan is decided against what the other filters left**, not against the vault, so hiding tags turns tag-only notes into orphans and the orphan toggle then has to be able to hide them.

`localGraph`'s are the depth walk in both directions plus the neighbour-links pass, which is the one that adds edges the walk itself never traversed — omit it and the setting silently does nothing at depth 1, which is the depth it is most often looked at.

`coerceGraphSettings` is read straight out of `localStorage`, so its cases are the hostile ones: every slider clamped on the way *out* as well as in, a group colour that is not `#rrggbb` refused before it reaches a canvas fill that ignores it silently and keeps the last colour drawn, and `defaultGraphSettings()` handing back a fresh object rather than the shared `GRAPH_DEFAULTS` a reset would otherwise mutate for the rest of the session.

`capGraph` is the deliberate degradation, and what is pinned is which nodes survive — the hubs — and that the loss is *reported*, because a graph silently missing a third of the vault is the failure this exists to avoid.

`forceLayout.test.ts` is the arithmetic under it, and four of its cases are for faults that produce a picture rather than an error.

**Barnes-Hut is asserted against the exact all-pairs sum it stands in for**, which is the only way to say the approximation is the same force: the tree is the optimisation and `repulsionExact` is the definition, and a tree that quietly disagrees just lays the graph out differently and nobody can tell which one is right.

Two coincident nodes are the case that found two defects at once, both of which were in the source and neither of which threw — the second node was being dropped out of the quadtree entirely at the depth cap, so it exerted no repulsion on anything and sat inside its neighbour forever; and the fixed nudge that separates a zero distance pushed *both* of them the same way, which moves the pair and never separates it.

The sign now comes from the index order so the two disagree about which way apart is.

The cooling case is the frame budget on the page: `step` must return `false` once the alpha is under `ALPHA_MIN` and the component stops asking for frames on that answer, so a curve that never reaches it is a canvas repainting a settled layout for as long as the tab is open.

A pin is asserted to hold *exactly*, because the whole of "drag a node and it stays where you dropped it" is that the forces cannot move it, and a spring that nudges a pinned node a pixel a frame reads as drift nobody can attribute.

And every coordinate is asserted finite over a full settle, since one `NaN` anywhere in the integrator propagates through the next frame's centre of mass and empties the canvas with nothing logged.

`canvasView.test.ts` is the view above that layout, and it exists because the arithmetic became assertable: the transform, the hit test and the framing were private inside `KnowledgeGraphCanvas` until `canvasView.ts` was extracted, and a component's internals are not something this suite can reach.

Its grounds are `forceLayout.test.ts`'s exactly — a canvas has no layout engine underneath to disagree with it, so a wrong transform draws a graph that is merely somewhere else and is indistinguishable from a layout choice until someone tries to click on it.

**A zoom is asserted to leave the point under the cursor fixed**, which is the one invariant that separates a wheel that feels like moving a camera from one that feels like the page fighting back, and it is asserted again *at the clamp*, where the fault has a different shape: a factor the limit refuses must contribute nothing to the pan either, or the graph creeps sideways under a wheel that visibly is not zooming, which reads as a rendering fault rather than an arithmetic one.

The cull rectangle is checked against `screenToWorld` rather than against numbers, because it is a second copy of the transform written in different-looking arithmetic and the symptom of the two disagreeing is marks vanishing near an edge — on a graph, indistinguishable from there being no link there.

`fitView` is asserted over a bounding box with **no extent** — one node, or a row of them on an exact horizontal — since that divides by zero into an `Infinity` scale and a blank canvas with nothing in the console, and the `Math.max(1, …)` that prevents it looks like defensive noise until it is gone.

`nearestWithin` pins nearest-over-first in both list orders, which is what makes it a rule rather than an accident of ordering: overlap is routine at low zoom and "whichever the vault listed earlier" is not something an operator can see, predict or report precisely.

And the line-mode wheel case is the one that is invisible on the hardware it was written on: Firefox reports a notch as three lines where the others report a hundred pixels, so a delta taken literally is a factor of 1.005 — a zoom that reads as absent rather than broken, in the one engine nobody had open.

Deliberately not tested is everything in that module that only calls a browser API — `observeCanvasSize`, `observeTheme`, `probeTokens`, `sizeCanvasToHost`.

There is no DOM in this suite, what a test of them would assert is that `ResizeObserver` and `getComputedStyle` exist, and the claims that actually matter about them — that a probe re-resolves on a theme flip, that a backing store is sized at the right ratio — are a browser's answer and belong on `verification.md`'s by-hand list, where they now are.
