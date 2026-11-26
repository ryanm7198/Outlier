#!/usr/bin/env python3
"""Write prompts-sport-checkouts.json: one "Check out N in 3 darts" prompt per score from 111 to 170 that has at
least MIN_ROUTES three-dart routes (111-140 and 142). Every valid route is an answer; nothing is written by hand.

    python make_checkouts.py

The list order is the starting crowd (first = commonest, last = the Outlier), so routes are ordered by how likely a
player is to say them: the standard pro route(s) from PRO first, then the rest by commonness(), which favours big
trebles and the classic doubles and pushes singles, the outer bull and doubles used as setup darts to the rare end.
"""
import json
import os

from checkouts import canonical, routes, value

LOW, HIGH = 111, 170
MIN_ROUTES = 15

# The usual checkout-chart route for each score, given first (a score's list is longest-established first).
PRO = {
    111: ["T20-S19-D16"], 112: ["T20-S12-D20"], 113: ["T20-S13-D20"], 114: ["T20-S14-D20"], 115: ["T20-S15-D20"],
    116: ["T20-S16-D20"], 117: ["T20-S17-D20"], 118: ["T20-S18-D20"], 119: ["T19-T12-D13"], 120: ["T20-S20-D20"],
    121: ["T20-T11-D14"], 122: ["T20-T18-D4"], 123: ["T19-T16-D9"], 124: ["T20-T16-D8"], 125: ["T20-25-D20"],
    126: ["T19-T19-D6"], 127: ["T20-T17-D8"], 128: ["T18-T14-D16"], 129: ["T19-T16-D12"], 130: ["T20-T20-D5"],
    131: ["T20-T13-D16"], 132: ["T20-T16-D12"], 133: ["T20-T19-D8"], 134: ["T20-T14-D16"], 135: ["T20-T17-D12"],
    136: ["T20-T20-D8"], 137: ["T20-T19-D10"], 138: ["T20-T18-D12"], 139: ["T20-T13-D20"],
    140: ["T20-T20-D10", "T20-T16-D16", "T20-T14-D19"], 142: ["T20-T14-D20"],
}

# How natural each finishing double is: the ones players are drilled to leave score highest.
FINISH = {20: 7, 16: 7, 10: 6, 18: 5, 12: 5, 8: 5, 19: 4, 14: 4, 15: 4, 17: 3.5, 13: 3.5, 11: 3.5, 9: 3, 4: 3, 6: 3,
          5: 2.5, 7: 2.5, 3: 2, 2: 2, 1: 1}
TREBLE = {20: 10, 19: 8, 18: 6.5, 17: 6, 16: 5.5, 15: 4.5, 14: 4.5, 13: 4, 12: 3.5, 11: 3.5, 10: 3.5}


def setup(seg):
    """How natural a scoring (first or second) dart is."""
    if seg == "BULL":
        return 4
    if seg == "25":
        return 1.5
    kind, n = seg[0], int(seg[1:])
    if kind == "T":
        return TREBLE.get(n, 2 + n / 10)
    if kind == "S":
        return 5 if n == 20 else 3 if n >= 16 else 1.5 + n / 20
    return 1 + n / 20   # a double as a setup dart is unusual


def commonness(route):
    a, b, d = route.split("-")
    fin = 3.5 if d == "BULL" else FINISH[int(d[1:])]
    return setup(a) + setup(b) + fin


def ordered(score):
    every = routes(score)
    pro = [r for r in PRO.get(score, [])]
    for r in pro:
        assert r in every and r == canonical(*r.split("-")), (score, r)
    rest = sorted(every - set(pro), key=lambda r: (-commonness(r), r))
    return pro + rest


def scores():
    return [s for s in range(LOW, HIGH + 1) if len(routes(s)) >= MIN_ROUTES]


def prompt(score):
    return {"id": f"dc-{score}", "tags": ["checkouts"], "deep": True, "input": "darts", "target": score,
            "text": f"Check out {score} in 3 darts (finish on a double or the Bull)", "answers": ordered(score)}


def main():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prompts-sport-checkouts.json")
    rows = [prompt(s) for s in scores()]
    with open(path, "w", encoding="utf-8") as f:
        f.write('{"cat": "darts", "prompts": [\n' + ",\n".join(json.dumps(p) for p in rows) + "\n]}\n")
    print(f"Wrote {len(rows)} prompts to {os.path.basename(path)}: "
          + ", ".join(f"{p['target']} ({len(p['answers'])})" for p in rows))


if __name__ == "__main__":
    main()
