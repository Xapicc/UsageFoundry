# Verification: Knowledge and plugins

[← Verification index](../verification.md)

## Verified

- **Vault reader on a real 773-note vault, read-only, 2026-08-21:** 885 nodes
  and 19,438 edges, cold scan 303ms, cached 9ms, and
  `/note?path=../../../etc/passwd` answered 404. It caught frontmatter tags
  being dropped (747 notes tag only there).

- **`--plugin-dir` delivers the generated skill, CLI 2.1.226, 2026-08-21,
  $0.00:** the request carried `usagefoundry:knowledge-vault` with
  `renderVaultSkill`'s exact text, namespaced so it cannot shadow the
  operator's skills; `--add-dir` proved a write grant, not a read-only one.

- **Knowledge page and renderer over a real 785-note vault, 2026-08-21:** the
  routes answered with live counts, 213 of 13,100 wikilinks leaked as literal
  `[[…]]` inside emphasis (24 after the fix, all vault content), and `sha256`
  digests showed the vault untouched.

- **Graph view at the real vault's size, 2026-08-22:** 893 nodes and 19,995
  edges in 605ms, uncapped; the layout settles in 251 frames at 1.49ms a step
  (Node 22.23.2), and Barnes-Hut is 2.7x all-pairs, 4.32ms a step at the
  2,500-node render cap.

- **Obsidian markdown over all 785 real notes, 2026-08-22:** 760 carry a
  callout, 621 a table, 524 a task list, all previously literal text; now 0
  notes leak a construct and 0 throw; two bugs the pass found, both invisible
  from the desktop, are tested.

- **Four hook and read facts, read in the pinned CLI bundle.** A `PreToolUse`
  deny lacking `hookSpecificOutput.hookEventName` is silently discarded; a
  plugin's `hooks/hooks.json` needs the `{"hooks": …}` wrapper; `agent_id` is
  on hook stdin only in a sub-agent; a whole-file read caps at 25,000 tokens
  and the first 2,000 lines.

- **`--plugin-dir` registers a plugin's hooks, observed 2026-08-23.** 213
  `hook_response` rows from `/workspace/winnow/plugin`, all exit 0:
  `SessionStart:startup` 93, `:compact` 88, `:resume` 32, so resumed cycles
  get hooks and autocompact re-fires `SessionStart`. Only the shell ran:
  `cozempic` was absent, so 213 sessions were told a guard was active.

- **The `/knowledge` graph orientation layer, `next dev`, 2026-09-02**, on the
  mounted vault (1,227 notes, 1,258 of 1,375 nodes drawn) at 1440px and 390px:
  graph first, three closed folds, legend, `Fit`, a readout that survives the
  pointer leaving, `role="img"` with a label. `textFade` 0.35 chosen by eye: a
  threshold just under `fitView`'s `k` 0.12–0.14 put 1,258 titles in 820px.

- **The vault skill is on `--plugin-dir` for first and resumed cycles.** Three
  `buildArgs` cases pin it; the skill reaches the model's skill list.

- **`graphTags`, `tagGroups` and the query they write are unit-tested.**

- **A plugin's `.mcp.json` server starts under `--plugin-dir`, CLI 2.1.280,
  2026-09-26.** Probed in the container as uid 1000 with `UF_SANDBOX=1`:
  LocalModelOffload's local reader, packaged as a plugin, connected and listed
  six tools named `mcp__plugin_<plugin>_<server>__<tool>`, with its path given
  as `${CLAUDE_PLUGIN_ROOT}/../poc/local-reader.mjs`. A server that cannot start
  is reported `failed` and the session starts anyway, and
  `--strict-mcp-config` drops plugin and user-scope servers alike
  (`proposals/McpServers/04-validation.md`).

- **A work cycle gets it from Settings › Plugins, 2026-09-26.** Run
  `656b73eb`'s first cycle at 23:01 UTC listed `plugin:local-reader:local`
  connected with six tools, and its transcript carried the server's
  instructions (`mcp_instructions_delta`).

- **A stdio MCP server a work cycle starts runs inside the sandbox,
  2026-09-26.** The local reader, started by the trial's first cycles under
  `UF_SANDBOX=1`, reached the model host on the LAN, wrote its log under
  `/workspace` and was rooted in the run's worktree.

- **User-scope MCP servers reach work cycles, CLI 2.1.280, 2026-09-26**, with
  the Mac's paths: the CLI keeps them in `.config.json` inside the mounted
  config directory, and every cycle's init lists the operator's `daiveloper`
  and `uf_local` as `failed`, `source: user`. `docs/install.md` says the
  opposite.

- **Broken links on the real 1,711-note vault, read-only, 2026-09-27, at
  `17ae20f`:** 706 across 53 targets before the fix, 705 of them naming a
  note that exists, and 1 after (`[[url]]`). The resolver read a dot in a
  note's name as an attachment extension, so earlier counts of this vault's
  broken links were taken with it.

- **A note's Backlinks panel in Chromium, 2026-09-27, at `773f12c`:** on the
  standalone build over a scratch vault where `Alpha.md` links `[[Beta]]`,
  `Beta.md`'s row read "Alpha" and linked to `Alpha.md`, with no console
  error. Seen at 1280px in the standard light skin only.

## Not yet verified by hand

- **The MCP status has not been seen rendered.** The run log's "MCP servers"
  line and the per-plugin status in Settings › Plugins are unit-tested
  (`mcpStatus.test.ts`, `logLine.test.ts`); settled by opening both after a
  cycle with the local-reader plugin on.

- **Whether every cycle, a resumed one included, stores its own
  `system:init`.** Both readers assume it. Settled by comparing
  `select run_id, count(*) from run_events where json_extract(payload,
  '$.message') = 'system:init' group by run_id` with `iterations`.

- **None of the four pinned-bundle hook and read facts has been run.** Each
  stays read-not-run until a billed run confirms it.

- **No hook event but `SessionStart` has been observed.** `hook_response` is
  emitted only for `["SessionStart","Setup"]` outside `CLAUDE_CODE_REMOTE`,
  so `PostToolUse`, `PreCompact`, `PostCompact`, `Stop` and `readGuard`'s
  `PreToolUse` run, or not, unobserved.

- **The graph orientation layer is unseen in the dark theme, on a touch
  device, with a screen reader and under `docker compose`**, and no run passed
  through auth: the middleware was moved aside because the edge bundle will
  not load under that container's sandbox. The canvas click-list is unrun.

- **`canvasView.ts` has now been driven, but only on Chromium at dpr 1.** The
  2026-09-12 framing run above exercised `observeTheme` on both attributes,
  `observeCanvasSize`/`sizeCanvasToHost` through a font-driven 950->984 resize,
  `probeTokens`, `fitView`, `panBy`, `zoomAt` into `clampZoom`'s ceiling and
  `nearestWithin` on a node grab. Still unrun: dpr sizing anywhere but 1, the
  rest of its ten-step click-list, and Firefox on `wheelZoomFactor`'s estimated
  16px line.

- **The Knowledge base settings section has never rendered**, and no `docker
  compose up --build` ran where it landed. Four states unseen: nothing
  configured, a gone mount (*Folder no longer mounted*), a scanned vault, a
  capped walk; the `≥` prefix and Truncated badge need more than 5,000 notes.

- **Of the Knowledge page, only the graph's orientation layer has been drawn
  (2026-09-02).** Unverified in a browser:
  wikilink and modified clicks, **Back** via `popstate`, the 250ms debounce,
  stacking below `md`, the 2026-08-22 Obsidian constructs (a DOM count is no
  substitute) and chrome pass (scroll-to-note, reduced motion, the 180ms
  spinner, tag chips), and the graph box's `aspect-[4/3]` on a wide window.

- **No run has answered out of the vault.** Unmeasured: that the model invokes
  the skill, stops and reports on an unreadable path, and carries the
  confidence grade. The root-owned 0755 `/run/uf-skills` is reasoned, not
  measured (only the `os.tmpdir()` fallback has run); the Settings switch has
  never rendered.

- **The graph view's frame rate and interaction are unmeasured.** Unseen: the
  colour probe and its theme re-run,
  crisp strokes, the rAF stopping, wheel/drag/hover, the non-passive wheel,
  `LINE_HEIGHT_PX` 16 (an estimate), the 7.3MB payload's parse, the row-height
  sizing, and the one-shot tag seed with `uf.knowledge-graph` cleared.

- **`readGuard`'s `PreToolUse` hook has never been seen to fire.** Plugin
  hooks are observed for `SessionStart` only, and the CLI emits
  `hook_response` for `SessionStart` and `Setup` alone, so an inert guard looks
  exactly like one switched off. One billed run settles it: switch `readGuard`
  on, have a cycle read one file twice, and confirm the second read is refused.
