#!/usr/bin/env python3
"""Kind 5: runs that hit an error the repository's own notes already explain.

Explanations used (the first four are CLAUDE.md "Commands" traps; the rest are
memory notes under /home/node/.claude/projects/*/memory, listed by
`ls /home/node/.claude/projects/*/memory/*.md`):
  A  env-prod-127      `npm ci` under NODE_ENV=production skips devDependencies and
                       typecheck/test die `sh: 1: tsc: not found` (CLAUDE.md trap 1)
  B  generate-not-fn   `TypeError: generate is not a function` from next build when
                       __NEXT_PRIVATE_STANDALONE_CONFIG is inherited (trap 2)
  C  virtiofs-next     spurious ENOENT/ENOTDIR against .next / @swc/helpers in next
                       build on the worktree mount (trap 3)
  D  enotdir-img       `ENOTDIR: mkdir node_modules/@img` during npm ci (trap 3, last
                       sentence)
  E  nested-claude     `Not logged in` from a `claude -p` run inside a work cycle
                       (memory: uf-work-cycle-cannot-call-claude-api)
  F  memory-ro         a shell write to the agent memory directory fails `Read-only
                       file system` (memory: memory-dir-is-read-only-to-bash)
  G  mac-toolchain     xcrun / xcodebuild / swift(c) / codesign / lipo / hdiutil /
                       plutil / launchctl `command not found` (memory:
                       runs-cannot-build-mac-apps)
  H  winnow-strip      a Bash result replaced by "[winnow: Bash result removed, rule
                       X ...]" (memory: uf-winnow-strips-test-summaries) -- reported
                       because it HIDES output from any scan of this kind.

A hit is GENUINE when the text is the shell's or tool's own output for a command
the run typed. Raw matches are far more numerous than genuine ones because runs
read CLAUDE.md, source comments and memory files that quote these strings; the
script prints both ("mentions" are matches inside Read/Grep results, or Bash
results of a command that only reads a file). Counts are exact for the stated
rules; transcripts record what the model saw, so output inside a winnow-replaced
result (H) is not visible and these counts are lower bounds.

Turns: for A and F the script also reports how many assistant messages passed
between the first genuine hit and the first message that applies the documented
fix (A: a command or text with NODE_ENV=development / --include=dev; F: a Write
tool_use to a path under /memory/). Whether the run "found the explanation
itself" is read off that: a fix applied with no sub-agent, Read of CLAUDE.md or
supervisor between is the run finding it itself; the script flags the cases where
the run's own first prompt already named the trap.

Run: python3 known_errors.py [--runs]
"""
import re
import statistics
import sys
from collections import Counter, defaultdict

import corpus

READER = re.compile(r"^\s*(cat|grep|rg|sed|head|tail|awk|ls|wc|find|jq|echo|printf|git\s+(log|show|grep|diff|blame))\b")
WRITE = re.compile(r">>|[^>]>[^>&]|\bsed -i\b|\bopen\(|\.write\(|\btee\b|\brm\b|\bmv\b|\bcp\b|\bpython3?\b")
CHECKS = {
    "A env-prod-127": lambda e: bool(re.search(r"(?:bash|sh)(?:: line \d+)?: (?:\d+: )?(?:tsc|next|tsx): (?:command )?not found", e["excerpt"])),
    "B generate-not-fn": lambda e: "TypeError: generate is not a function" in e["excerpt"] and not READER.match(e["cmd"])
                                  and bool(re.search(r"build", e["cmd"])),
    "C virtiofs-next": lambda e: bool(re.search(r"(?:ENOENT|ENOTDIR)[^\n]{0,200}(?:\.next|@swc/helpers)", e["excerpt"]))
                                 and not READER.match(e["cmd"]) and bool(re.search(r"build", e["cmd"])),
    "D enotdir-img": lambda e: bool(re.search(r"ENOTDIR[^\n]{0,80}node_modules/@img", e["excerpt"]))
                               and bool(re.search(r"npm (?:ci|install)", e["cmd"])),
    "E nested-claude": lambda e: bool(re.search(r"Not logged in · Please run /login", e["excerpt"]))
                                 and bool(re.search(r"\bclaude (?:-p|--print|--model)", e["cmd"])),
    "F memory-ro": lambda e: bool(re.search(r"(?:memory|MEMORY)[\w./-]*: Read-only file system|Errno 30\] Read-only file system: '[^']*(?:memory|MEMORY)", e["excerpt"]))
                             and bool(WRITE.search(e["cmd"])),
    "G mac-toolchain": lambda e: e["tool"] == "Bash" and not READER.match(e["cmd"]),
    "H winnow-strip": lambda e: e["head"].startswith("[winnow:"),
}
PATTERN_FOR = {  # which scanned pattern (corpus.ERROR_PATTERNS) carries each kind
    "A env-prod-127": "npm-ci-prod-127", "B generate-not-fn": "generate-not-a-function",
    "C virtiofs-next": "enoent-next-build", "D enotdir-img": "enotdir-mkdir-img", "E nested-claude": "not-logged-in",
    "F memory-ro": "read-only-fs", "G mac-toolchain": "mac-toolchain-missing", "H winnow-strip": "winnow-stripped",
}
NEEDS_REVIEW = re.compile(r"^\\s*NEEDS_REVIEW\\s*$", re.M)
FIX_A = re.compile(r"NODE_ENV=development|--include=dev|include=dev")
WORKAROUND_A = re.compile(r"ln -s [^\"]*node_modules|node_modules/\.bin|npx (?:--no-install )?tsc|PATH=[^\"]*node_modules")
TRAP_IN_BRIEF = re.compile(r"NODE_ENV=development|--include=dev|environment traps?", re.I)
MEMORY_WRITE = re.compile(r'"file_path":\s*"[^"]*/memory/')


def serial(session, event):
    return f"{session['file'].split('/')[-1][:8]}@{event['ts'][:19]}"


def tool_or_text(assistant, regex):
    return any(regex.search(t["input"]) for t in assistant["tools"]) or any(regex.search(x) for x in assistant["texts"])


def turns_until(session, first_i, predicate):
    """Assistant messages after ordinal first_i up to and including the first that satisfies predicate."""
    count = 0
    for assistant in session["assistants"]:
        if assistant["i"] <= first_i:
            continue
        count += 1
        if predicate(assistant):
            return count
    return None


def main():
    records = corpus.load()
    grouped = corpus.runs(records)
    table = {}
    for kind in CHECKS:
        genuine_runs, mention_runs = set(), set()
        genuine_hits = 0
        per_run_first = {}
        for key, sessions in grouped.items():
            for session in sessions:
                for event in session["errors"]:
                    if event["pattern"] != PATTERN_FOR[kind]:
                        continue
                    if CHECKS[kind](event):
                        genuine_runs.add(key)
                        genuine_hits += 1
                        per_run_first.setdefault(key, (session, event))
                    else:
                        mention_runs.add(key)
        table[kind] = (genuine_runs, mention_runs, genuine_hits, per_run_first)
    print(f"population: {len(grouped)} runs, {corpus.date_range([s for ss in grouped.values() for s in ss])}")
    print(f"{'error':<18} {'genuine runs':>12} {'hits':>5} {'only-mention runs':>18}  first..last genuine hit")
    for kind, (genuine, mention, hits, firsts) in table.items():
        stamps = sorted(e["ts"][:10] for _, e in firsts.values())
        span = f"{stamps[0]}..{stamps[-1]}" if stamps else "-"
        print(f"{kind:<18} {len(genuine):>12} {hits:>5} {len(mention - genuine):>18}  {span}")
    by_repo = defaultdict(Counter)
    for kind, (genuine, _, _, _) in table.items():
        for key in genuine:
            by_repo[kind][corpus.repo_of(key, grouped[key])] += 1
    for kind in table:
        if by_repo[kind]:
            print(f"  {kind} by repository: {dict(by_repo[kind])}")

    # How much of "look it up" the runs already do for themselves: tool calls whose input
    # names the agent memory directory (the notes the explanations above live in) or other
    # sessions' transcripts.
    memory_runs, transcript_runs = set(), set()
    for key, sessions in grouped.items():
        for session in sessions:
            for assistant in session["assistants"]:
                for tool in assistant["tools"]:
                    if tool["name"] in ("Bash", "Grep", "Read", "Glob") and ".claude/projects" in tool["input"]:
                        (memory_runs if "/memory" in tool["input"] else transcript_runs).add(key)
    print(f"runs that opened or searched the memory directory themselves: {len(memory_runs)} of {len(grouped)}; "
          f"runs that searched other sessions' transcripts: {len(transcript_runs)}")
    nr_runs = {key for key, sessions in grouped.items() for session in sessions
               for user, assistants in corpus.cycles(session)
               if assistants and corpus.is_prompt_turn(user) and NEEDS_REVIEW.search(corpus.final_text(assistants[-1]))}
    for kind, (genuine, _, _, _) in table.items():
        if genuine:
            print(f"  {kind}: runs among the genuine ones that ended NEEDS_REVIEW: {len(genuine & nr_runs)}")
    classified = {}
    print()
    print("-- A env-prod-127: per run --")
    print("   cmd kind: npm-script = `npm run ...`/`npm test` hit the missing tsc (the trap as CLAUDE.md states it);")
    print("             bare = a bare `tsc`/`next` typed in a worktree whose node_modules/.bin is not on PATH.")
    print("   route: documented = NODE_ENV=development / --include=dev (CLAUDE.md); workaround = symlink a sibling's")
    print("          node_modules, PATH=node_modules/.bin, npx tsc, node_modules/.bin/tsc.")
    genuine, _, _, firsts = table["A env-prod-127"]
    rows = []
    for key in sorted(genuine, key=lambda k: firsts[k][1]["ts"]):
        session, event = firsts[key]
        ordinal = event_ordinal(session, event)
        kind = "npm-script" if re.search(r"\bnpm (?:run|test|t)\b", event["cmd"]) else "bare"
        documented = turns_until(session, ordinal, lambda a: tool_or_text(a, FIX_A))
        workaround = turns_until(session, ordinal, lambda a: tool_or_text(a, WORKAROUND_A))
        any_route = [x for x in (documented, workaround) if x is not None]
        first_route = min(any_route) if any_route else None
        route = "none seen" if first_route is None else ("documented" if documented == first_route else "workaround")
        brief_named = bool(TRAP_IN_BRIEF.search(grouped[key][0]["first_prompt"] or ""))
        rows.append({"key": key, "ts": event["ts"][:19], "kind": kind, "turns": first_route, "route": route, "brief": brief_named})
        if "--runs" in sys.argv:
            print(f"  {event['ts'][:19]} {key[-26:]:<26} {kind:<10} turns to a way past: {first_route!s:>4} ({route})  brief named the trap: {brief_named}")
            print(f"       {session['file']}")
            print(f"       cmd: {event['cmd'][:110]!r}   result: {event['excerpt'][60:200]!r}")
    classified["A env-prod-127"] = [r["turns"] for r in rows]
    repeats = Counter()
    for key in genuine:
        repeats[sum(1 for session in grouped[key] for e in session["errors"]
                    if e["pattern"] == PATTERN_FOR["A env-prod-127"] and CHECKS["A env-prod-127"](e))] += 1
    print(f"  genuine hits per run (a run that kept hitting it would show more than 1): {sorted(repeats.items())}")
    for kind in ("npm-script", "bare"):
        sub = [r for r in rows if r["kind"] == kind]
        turns = [r["turns"] for r in sub if r["turns"] is not None]
        print(f"  {kind}: {len(sub)} runs; a way past seen in {len(turns)}; routes {dict(Counter(r['route'] for r in sub))}; "
              f"brief already named the trap in {sum(1 for r in sub if r['brief'])}")
        if turns:
            print(f"     turns to it: median {statistics.median(turns)}, max {max(turns)}; distribution {sorted(Counter(turns).items())}")
    print("  by date of first hit: " + str(sorted(Counter(r["ts"][:10] for r in rows).items())))

    print()
    print("-- F memory-ro: per run (turns until a Write or Edit tool_use on a /memory/ path) --")
    genuine, _, _, firsts = table["F memory-ro"]
    rows = []
    for key in sorted(genuine, key=lambda k: firsts[k][1]["ts"]):
        session, event = firsts[key]
        wrote = turns_until(session, event_ordinal(session, event),
                            lambda a: any(t["name"] in ("Write", "Edit") and MEMORY_WRITE.search(t["input"]) for t in a["tools"]))
        rows.append((key, wrote))
    classified["F memory-ro"] = [r[1] for r in rows]
    got = [r[1] for r in rows if r[1] is not None]
    print(f"  runs: {len(rows)}; a Write/Edit on /memory/ followed: {len(got)}; never: {len(rows) - len(got)}")
    if got:
        print(f"  turns to the Write/Edit: median {statistics.median(got)}, max {max(got)}; distribution {sorted(Counter(got).items())}")
    classified["E nested-claude"] = [1]
    print()
    print("-- classification (rule in rules.txt; applied mechanically here because the evidence is the turn count) --")
    print("   NOT A QUESTION   the run itself got past the error within 3 assistant messages (it had CLAUDE.md / its brief in context)")
    print("   MODEL-ANSWERABLE it did not, and the documented fix was one line of CLAUDE.md or a memory note a supervisor could quote")
    print("   (E: the single nested-claude run moved on after one message and wrote the memory note itself, counted as 1 turn)")
    for kind, turns in classified.items():
        not_q = sum(1 for t in turns if t is not None and t <= 3)
        print(f"   {kind:<16} n={len(turns):>2}  NOT A QUESTION={not_q}  MODEL-ANSWERABLE={len(turns) - not_q}  OPERATOR-ONLY=0")


def event_ordinal(session, event):
    """Ordinal of the last assistant message before the error's timestamp."""
    ordinal = 0
    for assistant in session["assistants"]:
        if assistant["ts"] <= event["ts"]:
            ordinal = assistant["i"]
        else:
            break
    return ordinal


if __name__ == "__main__":
    main()
