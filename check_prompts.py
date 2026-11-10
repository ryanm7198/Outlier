#!/usr/bin/env python3
"""Validate question files.  python check_prompts.py [file ...]   (no args = every prompts-*.json)

Checks JSON shape, unique ids across all files, valid tags, a minimum number of answers,
and that no spelling (name or alias) inside one question points at two different answers.
"""
import glob
import json
import os
import sys

from server import MIN_ANSWERS, norm

ROOT = os.path.dirname(os.path.abspath(__file__))
WANT = 12   # new questions should have at least this many answers


def read(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        data = {"cat": "general", "prompts": data}
    return data


def main():
    every = sorted(glob.glob(os.path.join(ROOT, "prompts-*.json")))
    targets = [os.path.abspath(a) for a in sys.argv[1:]] or every
    with open(os.path.join(ROOT, "aliases.json"), encoding="utf-8") as f:
        shared = json.load(f)
    tags, owner, problems, loaded = {}, {}, [], {}
    for path in every:
        try:
            loaded[path] = read(path)
        except (ValueError, OSError) as e:
            if path in targets:
                problems.append(f"{os.path.basename(path)}: cannot parse: {e}")
            continue
        data = loaded[path]
        for group in data.get("filters", []):
            tags.setdefault(data["cat"], set()).update(t[0] for t in group["tags"])
        for p in data.get("prompts", []):
            if p.get("id") in owner and path in targets:
                problems.append(f"{p['id']}: id already used in {os.path.basename(owner[p['id']])}")
            owner.setdefault(p.get("id"), path)

    total = 0
    for path in targets:
        data = loaded.get(path)
        if not data:
            continue
        name = os.path.basename(path)
        for p in data["prompts"]:
            pid = p.get("id", "?")
            total += 1
            if not p.get("text") or not isinstance(p.get("answers"), list):
                problems.append(f"{name} {pid}: needs text and answers")
                continue
            bad = set(p.get("tags", [])) - tags.get(data["cat"], set())
            if bad:
                problems.append(f"{name} {pid}: unknown tags {sorted(bad)}")
            if data["cat"] != "general" and not p.get("tags"):
                problems.append(f"{name} {pid}: needs tags")
            answers = [[a] if isinstance(a, str) else a for a in p["answers"]]
            if len(answers) < MIN_ANSWERS:
                problems.append(f"{name} {pid}: only {len(answers)} answers, will be skipped by the game")
            elif len(answers) < WANT:
                print(f"note  {name} {pid}: {len(answers)} answers (aim for {WANT}+)")
            keys = {}
            for a in answers:   # canonical names first, exactly as the game does
                keys.setdefault(norm(a[0]), a[0])
            for a in answers:
                if keys.get(norm(a[0])) != a[0]:
                    problems.append(f"{name} {pid}: '{a[0]}' duplicates '{keys[norm(a[0])]}'")
                for alias in a[1:] + shared.get(a[0], []):
                    k = norm(alias)
                    if not k:
                        problems.append(f"{name} {pid}: empty alias on '{a[0]}'")
                    elif keys.setdefault(k, a[0]) != a[0]:
                        problems.append(f"{name} {pid}: alias '{alias}' of '{a[0]}' also matches '{keys[k]}'")
    for line in problems:
        print("ERROR", line)
    print(f"{total} questions checked, {len(problems)} errors")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
