#!/usr/bin/env python3
"""Index every top-level Claude Code session transcript on this install.

One output line per session file: where it ran (cwd, gitBranch), which
minutes it wrote a line in, its first prompt, and every create_task call.
Sub-agent transcripts (<session>/subagents/) and the operator's Mac
sessions (-Users-*, -private-tmp-*) are skipped.

Usage: python3 index_sessions.py [projects_dir] > sessions.jsonl
"""
import json
import os
import sys
from collections import Counter
from datetime import datetime

PROJECTS = sys.argv[1] if len(sys.argv) > 1 else "/home/node/.claude/projects"


def epoch(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


def first_text(message):
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                return block.get("text", "")
    return None


def index_file(path, dirname):
    cwds, branches, entrypoints = Counter(), Counter(), Counter()
    minutes = set()
    first_prompt = None
    queue_prompt = None
    task_calls = []
    lines = 0
    first_ts = last_ts = None
    with open(path, "rb") as handle:
        for raw in handle:
            lines += 1
            try:
                obj = json.loads(raw)
            except ValueError:
                continue
            ts = obj.get("timestamp")
            kind = obj.get("type")
            if obj.get("cwd"):
                cwds[obj["cwd"]] += 1
            if obj.get("gitBranch"):
                branches[obj["gitBranch"]] += 1
            if obj.get("entrypoint"):
                entrypoints[obj["entrypoint"]] += 1
            if ts:
                try:
                    t = epoch(ts)
                except ValueError:
                    t = None
                if t is not None:
                    minutes.add(int(t // 60))
                    first_ts = t if first_ts is None else min(first_ts, t)
                    last_ts = t if last_ts is None else max(last_ts, t)
            if kind == "queue-operation" and queue_prompt is None and isinstance(obj.get("content"), str):
                queue_prompt = obj["content"][:400]
            if kind == "user" and first_prompt is None and not obj.get("isMeta"):
                text = first_text(obj.get("message"))
                if text:
                    first_prompt = text[:400]
            if kind == "assistant":
                content = (obj.get("message") or {}).get("content")
                if isinstance(content, list):
                    for block in content:
                        if (
                            isinstance(block, dict)
                            and block.get("type") == "tool_use"
                            and str(block.get("name", "")).endswith("create_task")
                        ):
                            tool_input = block.get("input") or {}
                            task_calls.append(
                                {
                                    "ts": ts,
                                    "name": block.get("name"),
                                    "title": tool_input.get("title"),
                                    "body": str(tool_input.get("body") or tool_input.get("description") or "")[:600],
                                    "folder": tool_input.get("folder"),
                                }
                            )
    return {
        "dir": dirname,
        "file": path,
        "lines": lines,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "minutes": sorted(minutes),
        "cwds": dict(cwds),
        "branches": dict(branches),
        "entrypoints": dict(entrypoints),
        "first_prompt": first_prompt or queue_prompt,
        "task_calls": task_calls,
    }


def main():
    for dirname in sorted(os.listdir(PROJECTS)):
        if dirname.startswith("-Users") or dirname.startswith("-private-tmp"):
            continue
        full = os.path.join(PROJECTS, dirname)
        if not os.path.isdir(full):
            continue
        for name in sorted(os.listdir(full)):
            if not name.endswith(".jsonl"):
                continue
            record = index_file(os.path.join(full, name), dirname)
            sys.stdout.write(json.dumps(record) + "\n")


if __name__ == "__main__":
    main()
