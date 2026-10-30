#!/usr/bin/env python3
"""Seeded sampling and excerpting shared by the keyword-based measurements.

`pick(instances, n)` sorts by id and draws with random.Random(27), so the same
corpus yields the same sample on every run. `excerpt(text, match, width)`
returns the match with `width` characters of context either side on one line.
"""
import random

SEED = 27
SAMPLE_SIZE = 25


def pick(instances, n=SAMPLE_SIZE):
    ordered = sorted(instances, key=lambda item: item["id"])
    if len(ordered) <= n:
        return ordered
    return sorted(random.Random(SEED).sample(ordered, n), key=lambda item: item["id"])


def excerpt(text, match, width=220):
    start, end = max(0, match.start() - width), min(len(text), match.end() + width)
    return ("..." if start else "") + text[start:end].replace("\n", " ") + ("..." if end < len(text) else "")
