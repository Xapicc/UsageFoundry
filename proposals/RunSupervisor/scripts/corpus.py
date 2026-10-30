#!/usr/bin/env python3
"""Shared reader for the RunSupervisor measurements: one pass over every
top-level Claude Code session transcript, a compact per-session record, and
the run keying every other script uses.

What it measures: nothing by itself. It is imported by the other scripts, and
run directly it builds the cache they read:

    python3 corpus.py build [OUT_DIR]     # default $RS_OUT or /tmp/claude-1000/runsupervisor-27/cache
    python3 corpus.py summary [OUT_DIR]   # population and date range

Population rules (reused from proposals/CrossSessionCommunication/scripts/
index_sessions.py and concurrency.py, extended where noted):
  * only top-level <project>/<session>.jsonl; <session>/subagents/** is never
    read, so sub-agent text can not count as a run's;
  * -Users-* and -private-* directories (the operator's Mac) are skipped;
  * a session is a RUN session when its first prompt opens with ISOLATED
    ("You are working in a dedicated git worktree"), when it lives in a
    -workspace-<Repo> directory and is not a dispatcher or probe, or when its
    first prompt is one of the unattended-run prompts listed in RUN_OPENERS;
  * validator ("You are reading the work of a coding agent"), conflict
    resolver ("You are resolving a git merge conflict"), reviewer ("You are
    reviewing the work an unattended Claude Code run committed"), the
    orchestrator chat (-run-uf-chat), vault-gate and scheduler/dispatcher
    sessions ("Start runs for Tasks on the Taskboard") are not runs;
  * -workspace2* (the notes vault's own folder) is reported separately and is
    not in the headline population;
  * the session(s) of THIS measurement (branch EXCLUDED_BRANCHES) are dropped
    because their prompts and tool calls contain every search term.

A run is keyed by the uf/<slug>-<N>-<hash> branch its sessions sat on (the
branch with the most lines in the session); an unisolated run is one session
file.

The cache is JSON lines, one object per session; text is capped (see CAPS) so
the cache stays small. Everything is deterministic: sessions are sorted by
(first timestamp, path).
"""
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime

PROJECTS = os.environ.get("RS_PROJECTS", "/home/node/.claude/projects")
DEFAULT_OUT = os.path.join(os.environ.get("RS_OUT") or "/tmp/claude-1000/runsupervisor-27/cache")

ISOLATED = "You are working in a dedicated git worktree"
VALIDATOR = "You are reading the work of a coding agent"
RESOLVER = "You are resolving a git merge conflict"
REVIEWER = "You are reviewing the work an unattended Claude Code run committed"
DISPATCHER = "Start runs for Tasks on the Taskboard"
PROBES = ("Read package.json in this directory", "Reply with the single word OK")
# First prompts of runs started without isolation that are real work cycles.
# Everything else in -workspace-<Repo> is hand-typed or a dispatcher.
RUN_OPENERS = (
    "You are running unattended.",
    "You will get a task given from another source",
    "Bug hunt in the code that was last merged",
    "The 20 files that earlier runs on this repository opened most",
    "<to be replaced>",
)
BRANCH = re.compile(r"^uf/(.+)-([0-9a-f]{12})-(\d+)-([0-9a-f]{8})$")
# The branch of the run that wrote this measurement. Its transcript quotes
# every marker the scripts search for.
EXCLUDED_BRANCHES = {"uf/usagefoundry-721638d11c0b-27-25bfc8a2"}
# Sessions that began on or after this instant are not read, so that the
# figures do not move as the install keeps writing transcripts (the measurement
# was taken on 2026-10-30; the last run session in the corpus is 2026-10-27).
CUTOFF = "2026-10-30T00:00:00"

CAP_USER = 6000       # chars kept of one user turn
CAP_TEXT = 12000      # chars kept of one assistant text block
CAP_INPUT = 600       # chars kept of a tool_use input
CAP_RESULT_EXCERPT = 300
CAP_BOARD_TEXT = 1500
CAP_CMD = 400
CAP_HEAD = 160
BOARD_TOOLS = ("create_task", "release_task", "comment_on_task", "complete_task")

# Tool-result patterns scanned at build time. name -> regex. Kept here so
# that the build and errors_known.py agree.
ERROR_PATTERNS = {
    "npm-ci-prod-127": r"(?:tsc|next|tsx|ts-node|eslint): (?:command )?not found|sh: \d+: (?:tsc|next|tsx): not found",
    "exit-127": r"Exit code 127",
    "generate-not-a-function": r"generate is not a function",
    "standalone-config": r"__NEXT_PRIVATE_STANDALONE_CONFIG",
    "enoent-next-build": r"(?:ENOENT|ENOTDIR)[^\n]{0,200}(?:\.next|@swc/helpers)",
    "enotdir-mkdir-img": r"ENOTDIR[^\n]{0,80}mkdir[^\n]{0,80}node_modules/@img|mkdir[^\n]{0,80}node_modules/@img[^\n]{0,80}ENOTDIR",
    "enotdir-any": r"ENOTDIR",
    "command-not-found": r"(?:^|[\s:'\"])([A-Za-z0-9_.+-]+): (?:command )?not found",
    "not-logged-in": r"Not logged in",
    "mac-toolchain-missing": r"\b(?:xcrun|xcodebuild|swiftc?|codesign|lipo|hdiutil|plutil|launchctl|sw_vers): (?:command )?not found|unable to load standard library for target '[a-z0-9_-]*apple-macos",
    "read-only-fs": r"Read-only file system",
    "erofs": r"EROFS",
    "winnow-stripped": r"\[winnow: [A-Za-z]+ result removed, rule ([A-Z]\d+)",
}
ERROR_RES = {k: re.compile(v) for k, v in ERROR_PATTERNS.items()}


def epoch(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


def block_text(content):
    """Return (text, has_tool_result) for a user message content."""
    if isinstance(content, str):
        return content, False
    parts, has_result = [], False
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                parts.append(block.get("text", ""))
            elif block.get("type") == "tool_result":
                has_result = True
    return "\n".join(parts), has_result


def result_text(block):
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def parse_session(path, dirname):
    branches, cwds, entry = Counter(), Counter(), Counter()
    first_ts = last_ts = None
    lines = 0
    users = []        # {"i","ts","text"}  non-tool-result, non-meta user turns
    assistants = []   # one per assistant message id: {"i","ts","id","texts":[],"tools":[{name,input}]}
    by_id = {}
    errors = []       # {"pattern","i","ts","excerpt","tool"}
    tool_by_use = {}  # tool_use id -> name
    seq = 0           # event ordinal: assistant messages and user turns, in file order
    with open(path, "rb") as handle:
        for raw in handle:
            lines += 1
            try:
                obj = json.loads(raw)
            except ValueError:
                continue
            ts = obj.get("timestamp")
            kind = obj.get("type")
            if obj.get("gitBranch"):
                branches[obj["gitBranch"]] += 1
            if obj.get("cwd"):
                cwds[obj["cwd"]] += 1
            if obj.get("entrypoint"):
                entry[obj["entrypoint"]] += 1
            if ts:
                first_ts = ts if first_ts is None or ts < first_ts else first_ts
                last_ts = ts if last_ts is None or ts > last_ts else last_ts
            if obj.get("isSidechain"):
                continue
            if kind == "user":
                message = obj.get("message") or {}
                content = message.get("content")
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_result":
                            text = result_text(block)
                            for name, regex in ERROR_RES.items():
                                match = regex.search(text)
                                if match:
                                    start = max(0, match.start() - 100)
                                    errors.append({
                                        "pattern": name, "i": seq, "ts": ts,
                                        "excerpt": text[start:match.end() + 160].replace("\n", " ")[:CAP_RESULT_EXCERPT],
                                        "tool": (tool_by_use.get(block.get("tool_use_id")) or (None, ""))[0],
                                        "cmd": (tool_by_use.get(block.get("tool_use_id")) or (None, ""))[1],
                                        "head": text[:CAP_HEAD].replace("\n", " "),
                                        "is_error": bool(block.get("is_error")),
                                    })
                text, has_result = block_text(content)
                if has_result or obj.get("isMeta") or not text.strip():
                    continue
                seq += 1
                users.append({"i": seq, "ts": ts, "text": text[:CAP_USER], "len": len(text)})
            elif kind == "assistant":
                message = obj.get("message") or {}
                mid = message.get("id") or obj.get("uuid")
                entry_ = by_id.get(mid)
                if entry_ is None:
                    seq += 1
                    entry_ = {"i": seq, "ts": ts, "id": mid, "texts": [], "tools": []}
                    by_id[mid] = entry_
                    assistants.append(entry_)
                content = message.get("content")
                if isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        if block.get("type") == "text":
                            entry_["texts"].append(block.get("text", "")[:CAP_TEXT])
                        elif block.get("type") == "tool_use":
                            tool_input = block.get("input") or {}
                            tool_by_use[block.get("id")] = (block.get("name"), str(tool_input.get("command") or tool_input.get("pattern") or tool_input.get("file_path") or "")[:CAP_CMD])
                            raw_input = json.dumps(tool_input, ensure_ascii=False)
                            record_ = {"name": block.get("name"), "input": raw_input[:CAP_INPUT],
                                       "input_len": len(raw_input)}
                            if str(block.get("name")).endswith(BOARD_TOOLS):
                                # Board tools carry the run's account of itself; keep the fields
                                # the measurements read, whole enough to quote.
                                record_["operatorOnly"] = bool(tool_input.get("operatorOnly"))
                                record_["title"] = str(tool_input.get("title") or "")[:200]
                                record_["text"] = str(tool_input.get("reason") or tool_input.get("body")
                                                      or tool_input.get("comment") or "")[:CAP_BOARD_TEXT]
                            entry_["tools"].append(record_)
    first_prompt = users[0]["text"] if users else None
    return {
        "dir": dirname, "file": path, "lines": lines, "first_ts": first_ts, "last_ts": last_ts,
        "branches": dict(branches), "cwds": dict(cwds), "entrypoints": dict(entry),
        "first_prompt": first_prompt, "users": users, "assistants": assistants, "errors": errors,
    }


def session_class(dirname, first_prompt):
    """One of: run-isolated, run-unisolated, validator, resolver, reviewer,
    chat, vault-gate, workspace2, dispatcher, probe, other."""
    prompt = (first_prompt or "").lstrip()
    if dirname == "-run-uf-chat":
        return "chat"
    if "vault-gate" in dirname:
        return "vault-gate"
    if dirname.startswith("-workspace2"):
        return "workspace2"
    if prompt.startswith(VALIDATOR):
        return "validator"
    if prompt.startswith(RESOLVER):
        return "resolver"
    if prompt.startswith(REVIEWER):
        return "reviewer"
    if prompt.startswith(ISOLATED):
        return "run-isolated"
    if dirname.startswith("-workspace-") and not dirname.startswith("-workspace--"):
        if prompt.startswith(DISPATCHER):
            return "dispatcher"
        if prompt.startswith(PROBES):
            return "probe"
        if prompt.startswith(RUN_OPENERS):
            return "run-unisolated"
        return "other-unisolated"
    return "other"


def iter_session_files():
    for dirname in sorted(os.listdir(PROJECTS)):
        if dirname.startswith("-Users") or dirname.startswith("-private-tmp") or dirname.startswith("-private-var"):
            continue
        full = os.path.join(PROJECTS, dirname)
        if not os.path.isdir(full):
            continue
        for name in sorted(os.listdir(full)):
            if name.endswith(".jsonl"):
                yield dirname, os.path.join(full, name)


def run_key(record):
    """Branch-keyed for isolated sessions, the file for unisolated ones."""
    if record["class"] == "run-isolated":
        branches = {b: n for b, n in record["branches"].items() if b.startswith("uf/")}
        if not branches:
            return record["file"]
        key = max(branches, key=branches.get)
        if not BRANCH.match(key):
            raise ValueError(f"unexpected branch shape {key!r} in {record['file']}")
        return key
    return record["file"]


def build(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    records = []
    for dirname, path in iter_session_files():
        record = parse_session(path, dirname)
        record["class"] = session_class(dirname, record["first_prompt"])
        record["run"] = run_key(record) if record["class"].startswith("run-") else None
        # The first prompt is long; keep only what classification needs downstream.
        records.append(record)
    records.sort(key=lambda r: (r["first_ts"] or "", r["file"]))
    target = os.path.join(out_dir, "corpus.jsonl")
    with open(target, "w") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return target


def load(out_dir=DEFAULT_OUT, apply_cutoff=True):
    """All session records, this measurement's own branch removed."""
    path = os.path.join(out_dir, "corpus.jsonl")
    if not os.path.exists(path):
        build(out_dir)
    records = []
    with open(path) as handle:
        for line in handle:
            record = json.loads(line)
            if record["run"] in EXCLUDED_BRANCHES:
                continue
            if apply_cutoff and (record["first_ts"] or "") >= CUTOFF:
                continue
            records.append(record)
    return records


def runs(records):
    """Group run sessions: {key: [session records in time order]}."""
    grouped = {}
    for record in records:
        if record["class"] in ("run-isolated", "run-unisolated"):
            grouped.setdefault(record["run"], []).append(record)
    for sessions in grouped.values():
        sessions.sort(key=lambda r: (r["first_ts"] or "", r["file"]))
    return dict(sorted(grouped.items(), key=lambda kv: (kv[1][0]["first_ts"] or "", kv[0])))


def repo_of(key, sessions):
    match = BRANCH.match(key)
    if match:
        return match.group(1).lower()
    return sessions[0]["dir"].replace("-workspace-", "", 1).lower()


def final_text(assistant):
    return "\n".join(assistant["texts"]).strip()


def events(session):
    """User turns and assistant messages in file order: (ordinal, kind, obj)."""
    merged = [(u["i"], "user", u) for u in session["users"]] + [(a["i"], "assistant", a) for a in session["assistants"]]
    merged.sort(key=lambda e: e[0])
    return merged


def cycles(session):
    """Split a session at every user turn: [(user_turn, [assistant messages])].

    A user turn that is a task-notification or other injected text still
    splits; callers pick the turns they count with `is_prompt_turn`.
    """
    out, current = [], None
    for _, kind, obj in events(session):
        if kind == "user":
            current = (obj, [])
            out.append(current)
        elif current is not None:
            current[1].append(obj)
    return out


NOTIFICATION = re.compile(r"^\s*(<task-notification>|<system-reminder>|\[Request interrupted|<command-name>|<local-command)")


def is_prompt_turn(user):
    return not NOTIFICATION.match(user["text"])


def short(ts):
    return (ts or "")[:19]


def date_range(records):
    stamps = [r["first_ts"] for r in records if r["first_ts"]] + [r["last_ts"] for r in records if r["last_ts"]]
    return (min(stamps)[:10], max(stamps)[:10]) if stamps else (None, None)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "summary"
    out_dir = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    if cmd == "build":
        print("wrote", build(out_dir))
        return
    records = load(out_dir)
    classes = Counter(r["class"] for r in records)
    print("sessions by class:", dict(sorted(classes.items())))
    grouped = runs(records)
    print("runs (branch-keyed isolated + one-file unisolated):", len(grouped),
          "| isolated:", sum(1 for k in grouped if k.startswith("uf/")),
          "| unisolated:", sum(1 for k in grouped if not k.startswith("uf/")))
    sessions = [s for ss in grouped.values() for s in ss]
    print("run sessions:", len(sessions), "| date range of run sessions:", date_range(sessions))
    print("date range of all non-Mac sessions:", date_range(records))
    print("runs by repository:", dict(Counter(repo_of(k, v) for k, v in grouped.items()).most_common()))
    cycle_counts = Counter(sum(1 for s in v for u in s["users"] if is_prompt_turn(u)) for v in grouped.values())
    print("runs by number of prompt turns (cycles):", sorted(cycle_counts.items()))


if __name__ == "__main__":
    main()
