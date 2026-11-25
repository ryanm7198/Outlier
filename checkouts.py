"""Darts checkouts: "Check out 140 in 3 darts". Shared by the server (reading players' routes) and make_checkouts.py
(writing the question file), so both agree on what a route is and how it is written.

A route is exactly three darts. Darts 1 and 2 can be any segment: S1-S20, D1-D20, T1-T20, 25 (outer bull) or BULL (50).
Dart 3 must be a double, D1-D20 or BULL (the bull counts as a double). Darts 1 and 2 can be thrown either way round,
so a route is written in one canonical form: darts 1 and 2 by score, highest first (a tie goes T, then D, then S,
then 25/BULL), then the double. "T20-T16-D16", "T20-BULL-D15", "T19-25-D18".
"""
import re

SEGMENTS = ([f"S{n}" for n in range(1, 21)] + [f"D{n}" for n in range(1, 21)] + [f"T{n}" for n in range(1, 21)]
            + ["25", "BULL"])
FINISHES = [f"D{n}" for n in range(1, 21)] + ["BULL"]
_RANK = {"T": 3, "D": 2, "S": 1}


def value(seg):
    if seg == "BULL":
        return 50
    if seg == "25":
        return 25
    return {"S": 1, "D": 2, "T": 3}[seg[0]] * int(seg[1:])


def _key(seg):
    return (-value(seg), -_RANK.get(seg[0], 0))   # 25 and BULL rank below T, D and S on a tie


def canonical(d1, d2, d3):
    a, b = sorted((d1, d2), key=_key)
    return f"{a}-{b}-{d3}"


def finish_for(left):
    """The double that finishes `left`, or None."""
    if left == 50:
        return "BULL"
    if 2 <= left <= 40 and left % 2 == 0:
        return f"D{left // 2}"
    return None


def routes(score):
    """Every distinct three-dart checkout of `score`, canonical, in no particular order."""
    out = set()
    for i, a in enumerate(SEGMENTS):
        for b in SEGMENTS[i:]:
            d3 = finish_for(score - value(a) - value(b))
            if d3:
                out.add(canonical(a, b, d3))
    return out


_TOKEN = re.compile(r"^(?:(bull|bullseye|bulls|db|d25|50)|(25|s25|sb|outer|ob)|([sdt])(\d{1,2}))$")


def segment(tok):
    """One typed dart ("t20", "D16", "s5", "25", "bull") as a segment, or None. Bare numbers other than 25 and 50 are
    not darts: "20" could be a single, double or treble."""
    m = _TOKEN.match(tok.lower())
    if not m:
        return None
    if m.group(1):
        return "BULL"
    if m.group(2):
        return "25"
    n = int(m.group(4))
    return f"{m.group(3).upper()}{n}" if 1 <= n <= 20 else None


def parse(raw, target):
    """A typed route to `target` in canonical form, or None if it isn't a valid three-dart checkout.
    Two darts are enough: the third is the double that finishes what's left. "t20 t16", "T16-T20-D16", "t20,bull,d15"."""
    toks = [t for t in re.split(r"[\s,\-–—/+]+", str(raw or "").strip()) if t]
    if len(toks) not in (2, 3):
        return None
    darts = [segment(t) for t in toks]
    if None in darts:
        return None
    d3 = finish_for(target - value(darts[0]) - value(darts[1]))
    if not d3 or (len(darts) == 3 and darts[2] != d3):
        return None
    return canonical(darts[0], darts[1], d3)
