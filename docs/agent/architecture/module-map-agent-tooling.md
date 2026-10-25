# The module map: tools, stacks and plugins

[← architecture index](../architecture.md)

Read before editing `plugins.ts`, `vaultSkill.ts`, `readGuard.ts`, `fileCostNotice.ts`, `stacks.ts` or `scripts/apply-stacks.mjs`. The rest of the map, and the rule for adding, removing or re-purposing a module in `src/lib/`, are in [module-map.md](module-map.md).

What an agent can run, and what is loaded into its cycle:

```
toolInventory.ts what this install's agents can actually run, and how sure the
                app is of each one. Four readings from four places — declared
                (UF_PY_TOOLS / UF_GH_EXTENSIONS), installed (the gh extensions
                volume, and later a stack's receipt), reachable (a PATH
                resolution over the server's own PATH, which *is* the child's
                because childEnv strips no PATH), observed (a bounded, cached
                run_events scan) — composed into one word by `composeState`. A
                layer is never inferred from the layer above it, and
                `installed` is the only word needing all four to agree, because
                it is the one an operator acts on without reading further. The
                two kinds of event do not carry the command in the same place
                — `tool` at $.input.command, `tool_error` at $.command — and a
                query reading both the same way counts zero failures for ever.
                Read by /api/tools and by status.ts's two integers; nothing
                writes through it, because add, remove and change are all a
                file edit on the host and a restart.
stacks.ts       the read-back over what apply-stacks.mjs installed, and the
                only reader of the receipts. A *reader*: it installs nothing,
                removes nothing and repairs nothing, because the applier runs
                in the one window of the container's life with no agent alive
                and this runs in a request. `parseReceipt` validates at the
                boundary a shell script writes across — the truncated receipt a
                container killed mid-write leaves behind must read `unreadable`
                and never a partial `ok`, since a partial `ok` is the read-back
                reporting an install that did not happen. It also
                projects what every ok stack grants a cycle
                (`Bash(<bin>:*)` onto --allowedTools) and denies it
                (`Bash(<entry>:*)` onto --disallowedTools), cached for the life
                of the process because that is the exact life of the receipts.
                `agentEnvironment` is what every builder for a child dropped to
                the agent uid starts from: the server's environment with
                `stackEnvironment`'s block under it, so the operator's value
                wins, and `agentPath()` over it. Never `process.env` itself —
                the server is root, and so is winnow under it. `chatPath`
                narrows that `PATH` for the chat and block child to root's
                directories and the toolbox, since it holds UF_CHAT_GID.
                There is **no `stacks` table** and must not be: the receipts
                are the state and they are per boot, so the one question a
                monitor asks — what did *this* boot find wrong — is answered by
                a set nothing outlives a restart with.
stackRequests.ts
                what runs asked the operator to install through
                `request_stack`, and which runs wait on each — text an agent
                wrote for a person to read, never anything the app applies.
                It records requests (`pending` or `declined`) and never
                installs: whether one is answered is `stackSatisfaction` over
                the receipts, asked by both the tool and the release so the two
                cannot disagree. `decideStackWait` is the release's pure
                decision; the status writes are `orchestrator.ts`'s
                `releaseStackWaits`. `checkStackDraft` asks the image's own
                `scripts/apply-stacks.mjs` whether a draft would parse, loaded
                at runtime rather than bundled. See
                docs/agent/run-lifecycle/waiting-for-stack.md.
scripts/apply-stacks.mjs
                not in src/ and not bundled into it — it runs from the
                entrypoint before `exec "$@"`, because PATH has to be final
                before the server starts and childEnv copies the server's
                environment into every agent, and the server reaches its
                parser only by loading the image's copy at runtime
                (`checkStackDraft`). Parse, digest, download, verify,
                unpack, link, write receipts. Three verbs and nothing else:
                `archive` executes nothing it downloads, `uv-tool` and
                `npm-global` run the package's own install hooks as the agent
                uid. Never a shell — every URL, filename and digest on its argv
                came out of a file a stranger wrote. **C1: the image ships
                nothing under /var/lib/uf-stacks, ever.** A named volume takes
                its contents from the image exactly once, at creation, so
                anything the image puts at that mount point is visible on a
                reviewer's fresh install and masked on every install that
                already exists — which is the one breach here invisible to
                whoever commits it, and the reason deployment.test.ts asserts
                the Dockerfile names no path under it.
plugins.ts      Claude Code plugins found in the mounts, switched on per install
                and carried onto every work cycle as --plugin-dir. Deliberately
                *not* `claude plugin install`: compose binds the operator's
                ~/.claude onto /home/node/.claude, so the CLI's own registry is
                one file shared by host and container and it records absolute
                paths — whichever side installs last silently breaks the other,
                since a plugin path that does not resolve is skipped with a
                warning and exit 0. So this app owns the list, in its own
                settings row (never a key of Settings — the settings form sends
                the whole blob on Save, and this decides what code every agent
                loads). Two invariants, both silent when broken: the flag goes
                on **every** cycle's argv because --plugin-dir does not survive
                --resume, and a stored path is proved contained in a mount again
                at *use* time, not just when it was switched on, because what it
                becomes is a directory whose hooks the container executes. An
                enabled plugin that stops resolving, or whose manifest stops
                parsing, is withheld and reaches the run's own log rather than
                being dropped. Switching off proves nothing: the entries that
                most need it are the ones the enable proofs would refuse
vaultSkill.ts   the vault-lookup skill, delivered the same way and for the same
                reason: a plugin directory generated per spawn and passed as
                --plugin-dir, never installed into ~/.claude/skills, where it
                would break the operator's host sessions exactly as above. Its
                switch is its own settings row and is refused with no knowledge
                base configured. It is *generated* rather than shipped as a file
                because it must name the vault's absolute path as the child sees
                it, and whether that vault has a ranked search is discoverable
                only by looking — and it goes to /run/uf-skills rather than
                DATA_DIR, which is 0700 root and on the CLI's managed denyRead
                list, so a skill there is unreadable by the agent uid on exactly
                the hardened install this is for. The vault also needs --add-dir
                or the skill names a path the run may not read; measurement says
                that flag grants **write**, so the skill's own text is the only
                thing forbidding writes into the vault
vaultPointer.ts the vault's notes named in a run's opening prompt rather than left
                for the skill to be asked about, because the skill was asked in
                6 of 592 runs. The vault's own search proposes and a Haiku call
                picks at most three or none; both children run as the agent uid,
                since the search is a script runs can edit. Off wherever the
                vault skill is off. The rules are in
                docs/agent/run-lifecycle/vault-pointer.md
readGuard.ts    the second *generated* directory on that same --plugin-dir list
                — which now carries three kinds of entry, the plugins found in
                the mounts, the vault skill and this — and the only one shipping
                hooks rather than a skill, so unlike the vault skill it puts
                nothing in the window and needs no --add-dir. It is a PreToolUse
                hook on Read that refuses a repeat of a read this session has
                already made (size and mtime unchanged) and a whole
                read past settings.readGuardMaxTokens. A *ranged* read is tested
                first and never refused, so nothing it says no to becomes
                unreachable — an agent stranded by a guard burns work cycles,
                which costs more than the tokens saved. /run rather than
                DATA_DIR for vaultSkill.ts's reason, root-owned so no agent can
                rewrite the script; the per-session ledger is a *sibling*
                directory the agents may write. Off by default: the savings it
                attacks are measured and that refusing a read produces them is
                not, and it is not confirmed that --plugin-dir registers a
                plugin's hooks as well as its skills
fileCostNotice.ts
                what a Read of this repository's largest files costs, ranked on
                tokens x how often this fleet has read each one, generated once
                at createRun and frozen on runs.file_cost_notice — the appended
                system prompt is part of the cached prefix, so a version of this
                text that differed between two cycles of one run would cold-start
                every token behind it. Every failure degrades to "", because a
                run that could not be created for want of a cost hint would cost
                infinitely more than the hint saves
tmpdirNotice.ts
                the literal $TMPDIR a sandboxed Bash command gets, derived from
                the child's uid and inherited environment (never a constant) and
                withheld wherever it cannot be known; taken once at createRun and
                frozen on runs.tmpdir_notice, for fileCostNotice.ts's reason
```
