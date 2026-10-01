#!/usr/bin/env python3
"""What this install's runs have done with Claude Code's peer-messaging tools.

Walks every session transcript (top level and sub-agent) outside the
operator's Mac directories and reports:
  - every ListAgents call, and whether its result listed another live session;
  - every SendMessage call, and whether it was addressed to a peer session or
    to one of the run's own in-process sub-agents (an id of 'a' + 16 hex);
  - every received cross-session message (a user turn opening with
    <cross-session-message, or a record whose origin.kind is "peer").

Read-only. Usage: python3 peer_usage.py [projects_dir]
"""
import collections
import glob
import json
import os
import re
import sys

PROJECTS = sys.argv[1] if len(sys.argv) > 1 else "/home/node/.claude/projects"
SUBAGENT_ID = re.compile(r"^a[0-9a-f]{16}$")
PEER_ROW = re.compile(r"\n  ([a-z0-9-]+) \[([0-9a-f]+)\]\s+·")


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(x.get("text", "") for x in content if isinstance(x, dict))
    return ""


def files():
    for pattern in ("*/*.jsonl", "*/*/subagents/*.jsonl", "*/*/subagents/workflows/*/*.jsonl"):
        for f in glob.glob(os.path.join(PROJECTS, pattern)):
            top = os.path.relpath(f, PROJECTS).split(os.sep)[0]
            if top.startswith("-Users-") or top.startswith("-private-tmp"):
                continue
            yield f


lists, sends, received = {}, [], []
results = []
for f in files():
    for line in open(f, errors="replace"):
        if not any(k in line for k in ("ListAgents", "SendMessage", "tool_result", "cross-session-message", '"peer"')):
            continue
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if (o.get("origin") or {}).get("kind") == "peer":
            received.append((f, o.get("timestamp")))
        content = (o.get("message") or {}).get("content")
        if isinstance(content, str) and content.lstrip().startswith("<cross-session-message"):
            received.append((f, o.get("timestamp")))
        if not isinstance(content, list):
            continue
        for b in content:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_use" and b.get("name") in ("ListAgents", "ListPeers"):
                lists[b.get("id")] = (f, o.get("timestamp"))
            elif b.get("type") == "tool_use" and b.get("name") == "SendMessage":
                to = str((b.get("input") or {}).get("to", ""))
                sends.append((f, o.get("timestamp"), "subagent" if SUBAGENT_ID.match(to) else "peer", to))
            elif b.get("type") == "tool_result" and b.get("tool_use_id") in lists:
                results.append((lists[b["tool_use_id"]], text_of(b.get("content"))))
            elif b.get("type") == "text" and b.get("text", "").lstrip().startswith("<cross-session-message"):
                received.append((f, o.get("timestamp")))

kinds = collections.Counter()
print("== ListAgents results that listed another live session")
for (f, ts), t in results:
    peers = PEER_ROW.findall(t)
    kind = "peers" if peers else ("none-reachable" if "No reachable agents" in t else "subagents-only")
    kinds[kind] += 1
    if peers:
        me = re.search(r"This session is (\S+)", t)
        print(ts[:16], me.group(1) if me else "?", "->", ", ".join(p[0] for p in peers))
print("ListAgents calls:", len(lists), "results:", len(results), dict(kinds))
print("SendMessage calls:", len(sends), dict(collections.Counter(s[2] for s in sends)))
for s in sends:
    if s[2] == "peer":
        print("  PEER SEND", s[1], os.path.relpath(s[0], PROJECTS), s[3])
print("Received cross-session messages:", len(received))
