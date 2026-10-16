# Projects: the Project manager page

[← isolation-and-landing index](../isolation-and-landing.md)

Read before editing `src/app/projects/page.tsx` or Project manager's row in `src/components/shell/panes.ts`. Added 2026-10-16. The inventory and the two presses it reads are in [projects-push-and-fetch.md](projects-push-and-fetch.md); every rule there holds here, and this file is only what the page adds.

**The page offers Fetch and Push of the current branch, and no door a run's branch has.** Land, Delete and Purge exist only for a run's branch and live on `/branches`; a copy here would split their refusal rules across two pages. A run's branch in a row's unmerged list links to its run and to `/branches?repo=<the project's path>`, which `/branches` reads with `useSearchParams` and a key so the sidebar's own Branches link puts the narrowing back. The path is the right value because a run branch is one whose run recorded this checkout as `repo_root`, which is what `/branches`' filter matches. Any other branch is listed read-only — name, tip date, commits ahead — and nothing more.

**A refused door shows the server's sentence where its button would be.** Each row's `push` and `fetch` verdicts are `planPush`'s and `planFetch`'s, so the page decides nothing about whether a press may happen; it draws the reason as a hint in place of the button rather than a greyed control. Two doors refused with the same sentence say it once, as "Fetch and push", and an unreadable row says git's line once rather than each door repeating it.

**A press's refusal stays where the button was until the operator asks afresh.** A 409, a 502, a 404 or a request that never came back replaces that door's button with its sentence, and the re-read that follows every press does not clear it — only Refresh, or the next press on that row, does. The reason is the remote: `upstream-gone` and the remote moving past the last fetch are answers only the press gets, and the row it carries back cannot know them, so the fresh row's verdict would offer the button again for a press that would be refused again.

**The Push sheet states one snapshot and sends exactly it.** Pressing Push holds the row as it was, and the sheet is drawn from that copy and the press sends its `branch`, `head` and upstream, so a re-read landing while the sheet is open cannot change what is confirmed. It names the remote, the branch there and the GitHub repository, the number of commits with the newest `MAX_UNPUSHED_LISTED` subjects from `unpushed` and how many of `ahead` it left out, that uncommitted changes are not included (with their count), and that a push cannot be taken back, in `seededRefusal`'s words. It is a `danger` sheet so it opens on Cancel.

**Read on load, once after each press, and on Refresh — never polled.** `/branches`' reason: a page of projects is a few hundred git children. A press's answer carries its row, which is drawn at once and moves the read ticket so an older read cannot land over it; then the whole page is read once. Ahead and behind always carry "as of" the last fetch or "never fetched".

**Rows with something to push sort first, then rows with something unmerged, then the rest — within the page.** The server picks a page before it reads anything, so it cannot sort by what it has not read yet; with more than `MAX_PROJECTS` git folders the order holds on each page, not across pages.

**"No remote" means the repository has none.** A row with no upstream lists the repository's `remotes`; only an empty list reads "No remote", and a branch with no upstream beside an `origin` reads "No upstream · remote origin", because the two are fixed differently.

**The list is one column of a grid, and the orchestrator panel is meant to be its second.** The column is `min-w-0`, so it narrows rather than pushing a panel off the pane at wide widths. Nothing is drawn there yet.

**The pane is the eighth row, directly under Branches, on the operator's ask.** Adding it moved the twelfth-pane ceiling in `design-language-and-grouping.md` and `ui-density-audit.md` §1.2 up by one, renumbered Knowledge to ⌘9 and took Dreaming's digit, by `panes.ts`' rule that the digit follows the row.
