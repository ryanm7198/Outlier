#!/usr/bin/env python3
"""Outlier - a "rarest answer wins" trivia game. Standard library only.

Run:      python server.py            (then open http://localhost:8321)
Review:   python server.py suggestions
Approve:  python server.py approve <prompt-id> <answer text>
"""
import datetime
import glob
import json
import math
import os
import random
import re
import secrets
import socket
import sqlite3
import sys
import threading
import time
import traceback
import unicodedata
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
# Where the crowd's answer counts live. On a host with a persistent disk, set OUTLIER_DB to a file on that disk.
DB_PATH = os.environ.get("OUTLIER_DB") or os.path.join(ROOT, "data", "outlier.db")
PORT = int(os.environ.get("PORT", "8321"))

DAILY_N = 5            # prompts in a daily game
GAME_N = 7             # prompts in a free-play game
ERAS = {"60s": "1960s", "70s": "1970s", "80s": "1980s", "90s": "1990s", "00s": "2000s", "10s": "2010s", "20s": "2020s"}
ERA_MIN = 10           # a decade gets its own version of a broad question once it has this many answers
ROUND_S = 30           # seconds to answer
OUTLIER_PAIR = 30       # questions with this many answers have two Outliers
MIN_ANSWERS = 8        # prompts with fewer possible answers are left out
GRACE_S = 2            # leeway for answers sent as the clock hits zero
PICK_S = 10            # party: seconds to decide whether to double down
TIMERS = (15, 20, 30, 45, 60)   # party: answer times the host can pick
LAUNCH = datetime.date(2026, 11, 10)
LOCK = threading.RLock()

MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json",
    ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
    ".png": "image/png", ".ico": "image/x-icon",
}


class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status, self.msg = status, msg


# ---------------------------------------------------------------- matching

# Letters that Unicode does not decompose into a plain letter plus an accent.
SPECIAL = str.maketrans({"æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE", "ø": "o", "Ø": "O", "ß": "ss", "ł": "l",
                         "Ł": "L", "đ": "d", "Đ": "D", "ð": "d", "Ð": "D", "þ": "th", "Þ": "Th", "ı": "i"})


def norm(s):
    s = str(s).replace("’", "").replace("'", "").replace("&", " and ").translate(SPECIAL)
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    s = re.sub(r"^(the|a|an) ", "", s)
    return s[:80]


def lev(a, b, cap):
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) > cap:
            return cap + 1
        prev = cur
    return prev[-1]


CATS = []      # [{id, label, filters: [{label, tags: [{id, label}]}]}]
PROMPTS = {}   # id -> {id, text, cat, tags, names: [canonical...]}
LOOKUP = {}    # id -> {normalised key: canonical name}
CODES = {}     # 4-character code -> prompt id; a game's seed is its prompts' codes joined together

B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"


def code_for(pid):
    """A short code that depends only on the prompt id, so seeds survive new questions and redeploys."""
    n, out = zlib.crc32(pid.encode()) % 62 ** 4, ""
    for _ in range(4):
        n, r = divmod(n, 62)
        out = B62[r] + out
    return out


def add_key(pid, key, name):
    if key:
        LOOKUP[pid].setdefault(key, name)
        LOOKUP[pid].setdefault(key.replace(" ", ""), name)


def load_prompts():
    with open(os.path.join(ROOT, "aliases.json"), encoding="utf-8") as f:
        shared = json.load(f)   # spellings accepted wherever that answer appears
    files = []
    for path in sorted(glob.glob(os.path.join(ROOT, "prompts-*.json"))):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except ValueError as e:   # one broken file should not take the whole game down
            print(f"WARNING: skipped {os.path.basename(path)}: {e}", flush=True)
            continue
        if isinstance(data, list):
            data = {"cat": "general", "label": "General", "prompts": data}
        files.append(data)
    # Files that define a category (label and filters) load before files that only add prompts to it.
    for data in sorted(files, key=lambda d: "filters" not in d):
        if not any(c["id"] == data["cat"] for c in CATS):
            CATS.append({
                "id": data["cat"], "label": data["label"], "order": data.get("order", 99),
                "parent": data.get("parent"),   # e.g. Football sits inside Sport
                "filters": [{"label": g["label"], "tags": [{"id": t[0], "label": t[1]} for t in g["tags"]]}
                            for g in data.get("filters", [])],
            })
        for p in data["prompts"]:
            answers = [[a] if isinstance(a, str) else a for a in p["answers"]]
            answers = [a + shared.get(a[0], []) for a in answers]
            add_prompt(p["id"], p["text"], data["cat"], p.get("tags", []), bool(p.get("deep")), answers)
            # Era variants: a broad question whose answers carry decades also comes in one version
            # per decade ("...in the 2010s"), accepting only that decade's answers. They only appear
            # when the player picks that decade.
            for era, label in ERAS.items():
                if not p.get("eras"):
                    break
                subset = [a for a in answers if era in p["eras"].get(a[0], [])]
                if len(subset) >= ERA_MIN:
                    add_prompt(f'{p["id"]}--{era}', p["eraText"].format(era=label), data["cat"],
                               p.get("tags", []) + [era], True, subset, era_only=era)
    CATS.sort(key=lambda c: (c.get("order", 99), c["label"]))   # the picker's order


def add_prompt(pid, text, cat, tags, deep, answers, era_only=None):
    if pid in PROMPTS:
        raise SystemExit(f"Duplicate prompt id: {pid}")
    if len(answers) < MIN_ANSWERS:
        return
    PROMPTS[pid] = {"id": pid, "text": text, "cat": cat, "tags": tags, "deep": deep, "era_only": era_only,
                    "names": [a[0] for a in answers]}
    LOOKUP[pid] = {}
    if code_for(pid) in CODES:
        print(f"WARNING: {pid} shares a seed code with {CODES[code_for(pid)]}; rename one", flush=True)
    CODES.setdefault(code_for(pid), pid)
    # Canonical names claim their keys first, so an alias never shadows one.
    for a in answers:
        add_key(pid, norm(a[0]), a[0])
    for a in answers:
        for alias in a[1:]:
            add_key(pid, norm(alias), a[0])


def match_detail(pid, raw):
    """Return (answer, exact). exact is False when only a near-miss spelling matched."""
    n = norm(raw)
    if not n:
        return None, False
    table = LOOKUP[pid]
    hit = table.get(n) or table.get(n.replace(" ", ""))
    if hit:
        return hit, True
    cap = 0 if len(n) < 5 else 1 if len(n) < 9 else 2
    if not cap:
        return None, False
    best, names = cap + 1, set()
    for key, name in table.items():
        d = lev(n, key, cap)
        if d < best:
            best, names = d, {name}
        elif d == best:
            names.add(name)
    return (names.pop(), False) if best <= cap and len(names) == 1 else (None, False)


def match(pid, raw):
    return match_detail(pid, raw)[0]


def near_miss(pid, raw):
    """A looser guess for the "Did you mean ...?" step, only used once the normal match has failed:
    a few more typos allowed, or a fragment that sits inside exactly one answer ("ronaldinh")."""
    n = norm(raw)
    if len(n) < 4:
        return None
    table = LOOKUP[pid]
    cap = 2 if len(n) < 8 else 3
    best, names = cap + 1, set()
    for key, name in table.items():
        d = lev(n, key, cap)
        if d < best:
            best, names = d, {name}
        elif d == best:
            names.add(name)
    if best <= cap and len(names) == 1:
        return names.pop()
    inside = {name for key, name in table.items() if len(n) >= 5 and n in key}
    return inside.pop() if len(inside) == 1 else None


# ---------------------------------------------------------------- storage

DB = None


def seed_count(rank):
    # Answers are listed most-obvious first; this gives a long-tailed starting crowd.
    return round(400 / (rank + 1) ** 0.85) + 3


def open_db():
    global DB
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    DB = sqlite3.connect(DB_PATH, check_same_thread=False)
    DB.execute("CREATE TABLE IF NOT EXISTS answers (prompt_id TEXT, name TEXT, count INTEGER, "
               "PRIMARY KEY (prompt_id, name))")
    DB.execute("CREATE TABLE IF NOT EXISTS suggestions (prompt_id TEXT, key TEXT, raw TEXT, count INTEGER, "
               "PRIMARY KEY (prompt_id, key))")
    for p in PROMPTS.values():
        # A long-tailed start in list order. The last answer listed (last two on long lists) starts below
        # everything else, so it is the Outlier; neighbours deep in a long list may tie, which only
        # means they share a score. (This used to force every seed apart, which flattened long lists.)
        seeds = [seed_count(rank) for rank in range(len(p["names"]))]
        for k in range(1, (2 if len(seeds) >= OUTLIER_PAIR else 1) + 1):
            if len(seeds) > k:
                seeds[-k] = k
        for name, seed in zip(p["names"], seeds):
            DB.execute("INSERT OR IGNORE INTO answers VALUES (?, ?, ?)", (p["id"], name, seed))
    DB.commit()
    # Answers approved later live only in the database; make them matchable too.
    for pid, name in DB.execute("SELECT prompt_id, name FROM answers"):
        if pid in LOOKUP:
            add_key(pid, norm(name), name)


def counts_for(pid):
    return dict(DB.execute("SELECT name, count FROM answers WHERE prompt_id = ?", (pid,)))


def outliers_for(counts):
    """The rarest answer is the Outlier; lists of 30 or more answers have two."""
    return sorted(counts, key=lambda n: (counts[n], n))[:2 if len(counts) >= OUTLIER_PAIR else 1]


def points_for(counts, name, stats=None):
    """Only an Outlier scores 100. Everything else runs from 10 (most common) up to 99.
    stats = (outliers, hi, lo) can be passed in when scoring a whole board at once."""
    top, hi, lo = stats or (outliers_for(counts), max(counts.values()), min(counts.values()))
    if name in top:
        return 100
    c = counts[name]
    if hi == lo:
        return 55
    return min(99, round(10 + 89 * (math.log(hi) - math.log(c)) / (math.log(hi) - math.log(lo))))


def share_for(counts, name):
    return round(100 * counts[name] / sum(counts.values()), 1)


BOARD_MAX = 150   # long lists send the commonest answers plus the player's own and the Outliers


def board_for(counts, keep=()):
    rows, top = sorted(counts, key=lambda n: -counts[n]), outliers_for(counts)
    stats, total = (top, max(counts.values()), min(counts.values())), sum(counts.values())
    if len(rows) > BOARD_MAX:
        rows = rows[:BOARD_MAX] + [n for n in rows[BOARD_MAX:] if n in top or n in keep]
    return [{"name": n, "share": round(100 * counts[n] / total, 1), "points": points_for(counts, n, stats),
             "outlier": n in top} for n in rows]


def record(pid, name, raw):
    """Every entry nudges the crowd: valid answers get more common, unknown ones queue for review."""
    if name:
        DB.execute("UPDATE answers SET count = count + 1 WHERE prompt_id = ? AND name = ?", (pid, name))
    else:
        key = norm(raw)
        if key:
            DB.execute("INSERT INTO suggestions VALUES (?, ?, ?, 1) "
                       "ON CONFLICT (prompt_id, key) DO UPDATE SET count = count + 1", (pid, key, str(raw)[:60]))
    DB.commit()


def judge(pid, raw, counts=None):
    raw = str(raw or "").strip()[:60]
    counts = counts or counts_for(pid)
    name = match(pid, raw)
    out = {"given": raw, "valid": bool(name), "points": 0, "share": 0, "canonical": None, "outlier": False}
    if name:
        out.update(canonical=name, points=points_for(counts, name), share=share_for(counts, name),
                   outlier=name in outliers_for(counts))
    return out


# ---------------------------------------------------------------- categories

def group_ok(group, chosen, ptags):
    """Does a prompt pass one filter group? Within a group any chosen tag may match, except for Era:
    there every decade a prompt spans must be chosen, so picking the 2010s only gives questions
    that sit entirely inside the 2010s."""
    if not chosen:
        return True
    have = group & ptags
    hit = chosen & have
    if not hit:
        return False
    return not group.label_is_era or hit == have


class Group(set):
    label_is_era = False


def filter_groups(cat):
    for c in CATS:
        if c["id"] == cat:
            out = []
            for g in c["filters"]:
                group = Group(t["id"] for t in g["tags"])
                group.label_is_era = g["label"] == "Era"
                out.append(group)
            return out
    return []


def parent_of(cat):
    return next((c["parent"] for c in CATS if c["id"] == cat), None)


def children_of(cat):
    return [c["id"] for c in CATS if c["parent"] == cat]


def in_cat(pcat, cat):
    """A prompt counts for its own category, for its parent (Football questions are Sport too) and for Everything."""
    return cat in ("all", pcat) or parent_of(pcat) == cat


def sub_choices(cat, tags):
    """For a parent category (Sport): the sports and sub-categories the player ticked, e.g. {"football", "darts"}.
    The parent's first filter group lists its own sports; sub-categories (Football) are ticked by their id."""
    groups = filter_groups(cat)
    lead = set(groups[0]) if groups else set()
    return lead, set(tags or []) & (lead | set(children_of(cat)))


def parse_mix(tags):
    """A mix of categories travels as cat "mix" with one tag per pick: "football:pl.10s", "sport:darts.cue", "food:"."""
    known = {c["id"] for c in CATS}
    out = []
    for item in tags or []:
        c, _, rest = str(item).partition(":")
        if c in known:
            out.append((c, [t for t in rest.split(".") if t]))
    return out


def mix_plan(tags, ids):
    """Buckets and weights for a mix: every pick gets an equal share, split within it the usual way."""
    ids = set(ids)
    groups, weights = [], []
    for c, t in parse_mix(tags):
        mine = [i for i in pool(c, t) if i in ids]
        if not mine:
            continue
        g = buckets(c, t, mine)
        w = bucket_weights(c, g, t)
        total = sum(w) or 1
        groups += g
        weights += [x / total for x in w]
    return groups, weights


def pool(cat, tags, deep=None):
    """Prompt ids in a category that pass every filter group. Questions marked "deep" (specialist
    ones, like one club's squad in one season) only come up once the player has picked a filter.
    A parent category (Sport) includes its sub-categories (Football). Ticking sports narrows it to those;
    Football's own filters (Era, Competition) then apply to the football questions only."""
    if cat == "mix":
        return sorted({i for c, t in parse_mix(tags) for i in pool(c, t, deep)})
    tags = set(tags or [])
    kids = children_of(cat)
    lead, subs = sub_choices(cat, tags) if kids else (set(), set())
    out = []
    for p in PROMPTS.values():
        if not in_cat(p["cat"], cat):
            continue
        if p["era_only"] and p["era_only"] not in tags:   # decade versions need their decade picked
            continue
        home, mine = cat, tags
        if kids:
            if p["cat"] in kids:
                if subs and p["cat"] not in subs:
                    continue
                home = p["cat"]
            elif subs and not (subs & lead):
                continue
            mine = tags & {t for g in filter_groups(home) for t in g}   # a filter that applies to this prompt
        if p["deep"] and not (mine if deep is None else deep):
            continue
        ptags = set(p["tags"])
        if all(group_ok(g, g & tags, ptags) for g in filter_groups(home)):
            out.append(p["id"])
    return sorted(out)


def buckets(cat, tags, ids):
    """Split a pool by the filters the player chose, so picking can share prompts out evenly between
    them (Food and Games should be a mix, not mostly whichever has more questions). The filter group
    with the most chosen tags decides the split."""
    if cat == "all":   # Everything: share prompts out between the categories
        return [b for b in ([i for i in ids if PROMPTS[i]["cat"] == c["id"]] for c in CATS) if b]
    if cat == "mix":
        return mix_plan(tags, ids)[0]
    tags = set(tags or [])
    if children_of(cat):   # Sport: Football, Darts, Tennis... each get a share
        lead, subs = sub_choices(cat, tags)

        def key(i):
            p = PROMPTS[i]
            if p["cat"] != cat:
                return p["cat"]
            return next((t for t in p["tags"] if t in lead and (not subs or t in subs)), "")
        keys = sorted({key(i) for i in ids})
        return [[i for i in ids if key(i) == k] for k in keys]
    best = max((g & tags for g in filter_groups(cat)), key=len, default=set())
    if len(best) < 2:
        return [list(ids)]
    out = [[i for i in ids if t in PROMPTS[i]["tags"]] for t in sorted(best)]
    return [b for b in out if b]


def bucket_weights(cat, groups, tags=()):
    """Chosen filters share prompts equally. In Everything, and in all of Sport, a share grows with the
    square root of its size, so small ones turn up often enough without repeating themselves."""
    if cat == "mix":
        return mix_plan(tags, sorted(set().union(*groups)) if groups else [])[1]
    spread = cat == "all" or (children_of(cat) and not sub_choices(cat, tags)[1])
    return [math.sqrt(len(b)) if spread else 1.0 for b in groups]


def pick_balanced(cat, tags, ids, seen, n):
    """Up to n prompts spread across the chosen filters (or categories); within each, unseen prompts
    first and then the ones seen longest ago (seen is oldest first)."""
    groups = buckets(cat, tags, ids)
    weights = bucket_weights(cat, groups, tags)
    order = []
    for b in groups:
        fresh = [i for i in b if i not in seen]
        random.shuffle(fresh)
        order.append(fresh + sorted((i for i in b if i in seen), key=seen.index))
    taken = [0] * len(order)
    picked = []
    while len(picked) < n and any(order):
        # The filter furthest below its fair share goes next; the random nudge lets bigger ones win ties more often.
        live = [k for k in range(len(order)) if order[k]]
        k = min(live, key=lambda k: (taken[k] + random.random()) / weights[k])
        b = order[k]
        while b and b[0] in picked:
            b.pop(0)
        if b:
            picked.append(b.pop(0))
            taken[k] += 1
    random.shuffle(picked)
    return picked


def categories():
    out = [{"id": "all", "label": "Everything", "count": len(pool("all", [])), "filters": []}]
    for c in CATS:
        ids = pool(c["id"], [])
        out.append({"id": c["id"], "label": c["label"], "count": len(ids), "parent": c["parent"],
                    "tagsets": [p["tags"] + (["~deep"] if p["deep"] else []) + ([f'~only:{p["era_only"]}'] if p["era_only"] else [])
                                + ([f'~cat:{p["cat"]}'] if p["cat"] != c["id"] else [])
                                for p in PROMPTS.values() if in_cat(p["cat"], c["id"])], "filters": [
            {"label": g["label"], "tags": [
                {"id": t["id"], "label": t["label"],
                 "count": len(pool(c["id"], [t["id"]]))} for t in g["tags"]]}
            for g in c["filters"]]})
    return out


def describe(cat, tags):
    if cat == "mix":
        return " + ".join(describe(c, t) for c, t in parse_mix(tags)) or "Everything"
    for c in CATS:
        if c["id"] == cat:
            tags = tags or []
            labels = [t["label"] for g in c["filters"] for t in g["tags"] if t["id"] in tags]
            for k in CATS:   # ticked sub-categories (Football) and their own filters
                if k["parent"] == cat and k["id"] in tags:
                    labels += [k["label"]] + [t["label"] for g in k["filters"] for t in g["tags"] if t["id"] in tags]
            return " · ".join([c["label"]] + labels)
    return "Everything"


def public_prompt(pid):
    p = PROMPTS[pid]
    return {"id": pid, "text": p["text"], "cat": p["cat"]}


def daily(cat):
    ids = pool(cat, [])
    if not ids:
        raise ApiError(404, "No prompts in that category")
    today = datetime.date.today()
    n = min(DAILY_N, len(ids))
    cycle, idx = divmod(today.toordinal(), max(1, len(ids) // n))
    random.Random(f"outlier-{cat}-{cycle}").shuffle(ids)
    return {"date": today.isoformat(), "number": (today - LAUNCH).days + 1, "cat": cat,
            "label": describe(cat, []), "roundMs": ROUND_S * 1000,
            "prompts": [public_prompt(i) for i in ids[idx * n:(idx + 1) * n]]}


def new_game(cat, tags, seen):
    """Seven prompts, preferring ones this player has not seen (seen is oldest first)."""
    ids = pool(cat, tags)
    if not ids:
        raise ApiError(404, "No prompts match those filters")
    return game_out(pick_balanced(cat, tags, ids, seen, GAME_N), describe(cat, tags))


def seeded_game(seed):
    seed = re.sub(r"[^0-9A-Za-z]", "", str(seed or ""))
    parts = [seed[i:i + 4] for i in range(0, len(seed), 4)]
    if not parts or len(parts) > 20 or any(len(p) != 4 or p not in CODES for p in parts):
        raise ApiError(404, "That seed doesn't match any game")
    return game_out([CODES[p] for p in parts], "Challenge")


def game_out(ids, label):
    return {"seed": "".join(code_for(i) for i in ids), "label": label, "roundMs": ROUND_S * 1000,
            "prompts": [public_prompt(i) for i in ids]}


# ---------------------------------------------------------------- party rooms

ROOMS = {}
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"
PLAYER_COLORS = 12   # swatches the page draws (indexes 0-11)


def clean_name(name):
    name = re.sub(r"\s+", " ", str(name or "")).strip()[:16]
    if not name:
        raise ApiError(400, "Enter a name first")
    return name


def add_player(room, name):
    if len(room["players"]) >= 12:
        raise ApiError(400, "That room is full")
    name, taken = clean_name(name), {p["name"].lower() for p in room["players"].values()}
    base, i = name, 2
    while name.lower() in taken:
        name, i = f"{base[:14]} {i}", i + 1
    token = secrets.token_hex(8)
    room["seq"] += 1
    used = {p["color"] for p in room["players"].values()}
    color = next((c for c in range(PLAYER_COLORS) if c not in used), room["seq"] % PLAYER_COLORS)
    room["players"][token] = {"n": room["seq"], "name": name, "score": 0, "answer": None, "last": time.time(),
                              "double_left": True, "doubling": False, "picked": False, "color": color}
    return token


def create_room(name):
    now = time.time()
    for code in [c for c, r in ROOMS.items() if now - r["touched"] > 3 * 3600]:
        del ROOMS[code]
    while True:
        code = "".join(random.choice(CODE_ALPHABET) for _ in range(4))
        if code not in ROOMS:
            break
    room = {"code": code, "players": {}, "seq": 0, "host": None, "phase": "lobby", "round": 0, "rounds": 5,
            "cat": "all", "tags": [], "used": [], "prompt": None, "deadline": 0, "reveal": None, "touched": now,
            "secs": ROUND_S, "history": [], "asks": []}
    token = add_player(room, name)
    room["host"] = token
    ROOMS[code] = room
    return room, token


def get_room(code, token=None):
    room = ROOMS.get(str(code or "").upper().strip())
    if not room:
        raise ApiError(404, "Room not found")
    if token is not None and token not in room["players"]:
        raise ApiError(404, "You are not in that room")
    room["touched"] = time.time()
    return room


def online(p):
    return time.time() - p["last"] < 8


def next_question(room):
    ids = pool(room["cat"], room["tags"])
    if all(i in room["used"] for i in ids):   # the room has been through every matching prompt; start over
        room["used"] = [i for i in room["used"] if i not in ids]
    # Take turns between the chosen filters: the one furthest below its fair share goes next.
    groups = buckets(room["cat"], room["tags"], ids)
    weights = bucket_weights(room["cat"], groups, room["tags"])
    fresh = [[i for i in b if i not in room["used"]] for b in groups]
    played = [sum(1 for i in b if i in room["used"]) for b in groups]
    choices = [k for k in range(len(groups)) if fresh[k]]
    k = min(choices, key=lambda k: (played[k] + random.random()) / weights[k])
    room["prompt"] = random.choice(fresh[k])
    room["used"].append(room["prompt"])
    room["round"] += 1
    for p in room["players"].values():
        p["answer"], p["doubling"], p["picked"] = None, False, False
    # Before the prompt is shown, anyone with their double down left sees the category and may use it.
    # Only in Everything games: with a single category chosen, the hint would tell players nothing.
    if room["cat"] == "all" and any(online(p) and p["double_left"] for p in room["players"].values()):
        room["deadline"] = time.time() + PICK_S
        room["phase"] = "pick"
    else:
        begin_question(room)


def begin_question(room):
    room["deadline"] = time.time() + room["secs"]
    room["phase"] = "question"


def hint_for(pid):
    """What players see before doubling: the category and the prompt's filter labels, never the prompt."""
    p = PROMPTS[pid]
    return describe(p["cat"], p["tags"])


def resolve(room):
    pid = room["prompt"]
    counts = counts_for(pid)
    results = []
    for p in room["players"].values():
        r = judge(pid, p["answer"], counts)
        r.update(n=p["n"], name=p["name"], shared=False, doubled=p["doubling"])
        results.append(r)
    for r in results:
        if r["valid"] and sum(1 for o in results if o["canonical"] == r["canonical"]) > 1:
            r["shared"], r["points"] = True, round(r["points"] / 2)
        if r["doubled"]:
            r["points"] *= 2
    for p, r in zip(room["players"].values(), results):
        p["score"] += r["points"]
        if r["given"]:
            record(pid, r["canonical"], r["given"])
    room["history"].append([{"n": r["n"], "name": r["name"], "points": r["points"], "valid": r["valid"],
                             "answer": r["canonical"] or r["given"], "share": r["share"], "outlier": r["outlier"],
                             "shared": r["shared"], "doubled": r["doubled"]} for r in results])
    board = board_for(counts, keep={r["canonical"] for r in results if r["valid"]})
    results.sort(key=lambda r: -r["points"])
    # The crowd chart: the most common answers, plus every answer a player in the room gave.
    said = {r["canonical"] for r in results if r["valid"]}
    crowd = [b for i, b in enumerate(board) if i < 8 or b["name"] in said]
    room["reveal"] = {"prompt": PROMPTS[pid]["text"], "results": results, "crowd": crowd, "answers": len(counts),
                      "outliers": [b for b in board if b["outlier"]], "commonest": board[0]}
    room["phase"] = "reveal"


def awards_for(room):
    """Fun end-of-game awards worked out from every round. Only awards somebody actually earned are returned."""
    names = {p["n"]: p["name"] for p in room["players"].values()}
    rows = [h for rnd in room["history"] for h in rnd if h["n"] in names]
    out = []

    def best(title, icon, scores, detail, floor=1):
        top = max(scores.values(), default=0)
        if top >= floor:
            who = [names[n] for n, v in scores.items() if v == top]
            out.append({"title": title, "icon": icon, "winners": who, "detail": detail(top)})

    best("Outlier hunter", "crosshair", {n: sum(1 for r in rows if r["n"] == n and r["outlier"]) for n in names},
         lambda v: f"Found the Outlier {v} time{'s' if v != 1 else ''}")
    best("Best round", "trophy", {n: max([r["points"] for r in rows if r["n"] == n] or [0]) for n in names},
         lambda v: f"{v} points in a single round", floor=50)
    valid = {n: [r["share"] for r in rows if r["n"] == n and r["valid"]] for n in names}
    best("Rarest find", "sparkles", {n: round(100 - min(v), 1) for n, v in valid.items() if v},
         lambda v: f"Gave an answer only {round(100 - v, 1)}% of people give", floor=96)
    best("Crowd pleaser", "users", {n: round(sum(v) / len(v)) for n, v in valid.items() if len(v) >= 2},
         lambda v: f"Their answers averaged {v}% of the crowd", floor=8)
    best("Great minds", "link", {n: sum(1 for r in rows if r["n"] == n and r["shared"]) for n in names},
         lambda v: f"Matched another player {v} time{'s' if v != 1 else ''}")
    best("Double trouble", "zap", {n: max([r["points"] // 2 for r in rows if r["n"] == n and r["doubled"]] or [0]) for n in names},
         lambda v: f"Their double down earned an extra {v}", floor=20)
    return out[:7]


def tick(room):
    players = room["players"]
    if not online(players[room["host"]]) and time.time() - players[room["host"]]["last"] > 15:
        for token, p in players.items():
            if online(p):
                room["host"] = token
                break
    if room["phase"] == "pick":
        deciding = [p for p in players.values() if online(p) and p["double_left"] and not p["picked"]]
        if not deciding or time.time() >= room["deadline"]:
            begin_question(room)
    if room["phase"] == "question":
        waiting = [p for p in players.values() if online(p) and p["answer"] is None]
        if not waiting or time.time() >= room["deadline"] + GRACE_S:
            resolve(room)


def room_state(room, token):
    room["players"][token]["last"] = time.time()
    tick(room)
    me = room["players"][token]
    state = {
        "code": room["code"], "phase": room["phase"], "you": me["n"], "host": room["players"][room["host"]]["n"],
        "round": room["round"], "rounds": room["rounds"], "secs": room["secs"], "doubles": room["cat"] == "all",
        "label": describe(room["cat"], room["tags"]),
        "doubleLeft": me["double_left"], "doubling": me["doubling"], "picked": me["picked"],
        "players": [{"n": p["n"], "name": p["name"], "score": p["score"], "online": online(p), "color": p["color"],
                     "answered": p["answer"] is not None, "picked": p["picked"] or not p["double_left"],
                     "doubleLeft": p["double_left"]} for p in room["players"].values()],
        "asks": room["asks"],
    }
    left = max(0, int((room["deadline"] - time.time()) * 1000))
    if room["phase"] == "pick":
        state.update(hint=hint_for(room["prompt"]), roundMs=PICK_S * 1000, remainingMs=left)
    if room["phase"] == "question":
        state.update(prompt=PROMPTS[room["prompt"]]["text"], promptId=room["prompt"], hint=hint_for(room["prompt"]),
                     roundMs=room["secs"] * 1000, yourAnswer=me["answer"], remainingMs=left)
    if room["phase"] == "reveal":
        state["reveal"] = room["reveal"]
    if room["phase"] == "final":
        state["awards"] = awards_for(room)
    return state


# ---------------------------------------------------------------- api

def api_get(path, q):
    if path == "/api/categories":
        return categories()
    if path == "/api/daily":
        return daily(q.get("cat", "all"))
    if path == "/api/game":
        if q.get("seed"):
            return seeded_game(q["seed"])
        tags = [t for t in q.get("tags", "").split(",") if t]
        return new_game(q.get("cat", "all"), tags, q.get("exclude", "").split(","))
    if path == "/api/random":
        tags = [t for t in q.get("tags", "").split(",") if t]
        ids = pool(q.get("cat", "all"), tags)
        if not ids:
            raise ApiError(404, "No prompts match those filters")
        seen = q.get("exclude", "").split(",")   # oldest first
        out = public_prompt(pick_balanced(q.get("cat", "all"), tags, ids, seen, 1)[0])
        out.update(roundMs=ROUND_S * 1000, poolSize=len(ids))
        return out
    if path == "/api/room/state":
        room = get_room(q.get("code"), q.get("pid"))
        return room_state(room, q.get("pid"))
    raise ApiError(404, "Not found")


def api_post(path, body):
    if path == "/api/answer":
        pid = body.get("promptId")
        if pid not in PROMPTS:
            raise ApiError(404, "Unknown prompt")
        counts = counts_for(pid)
        out = judge(pid, body.get("answer"), counts)
        out["board"] = board_for(counts, keep=(out["canonical"],))
        out["boardTotal"] = len(counts)
        out["prompt"] = PROMPTS[pid]["text"]
        if out["given"]:
            record(pid, out["canonical"], out["given"])
        return out
    if path == "/api/check":
        # Lets the page ask "Did you mean ...?" before a near-miss spelling is locked in.
        pid = body.get("promptId")
        if pid not in PROMPTS:
            raise ApiError(404, "Unknown prompt")
        raw = str(body.get("answer") or "").strip()[:60]
        name, exact = match_detail(pid, raw)
        if not name:
            name = near_miss(pid, raw)   # offered as "Did you mean ...?", never scored as typed
        if not name:
            record(pid, None, raw)   # rejected attempts still queue for review
        return {"suggest": name, "exact": exact}
    if path == "/api/room/create":
        room, token = create_room(body.get("name"))
        return {"code": room["code"], "pid": token}
    if path == "/api/room/join":
        room = get_room(body.get("code"))
        return {"code": room["code"], "pid": add_player(room, body.get("name"))}

    token = body.get("pid")
    room = get_room(body.get("code"), token)
    if path == "/api/room/double":
        me = room["players"][token]
        if room["phase"] == "pick" and me["double_left"] and not me["picked"]:
            me["picked"] = True
            if body.get("double"):
                me["doubling"], me["double_left"] = True, False
        return room_state(room, token)
    if path == "/api/room/color":
        me = room["players"][token]
        try:
            c = int(body.get("color"))
        except (TypeError, ValueError):
            c = -1
        if 0 <= c < PLAYER_COLORS and all(p["color"] != c for t, p in room["players"].items() if t != token):
            me["color"] = c
        return room_state(room, token)
    if path == "/api/room/ask":
        me = room["players"][token]
        if room["phase"] == "final" and me["n"] not in room["asks"]:
            room["asks"].append(me["n"])
        return room_state(room, token)
    if path == "/api/room/answer":
        me = room["players"][token]
        if room["phase"] == "question" and me["answer"] is None and time.time() < room["deadline"] + GRACE_S:
            me["answer"] = str(body.get("answer") or "").strip()[:60]
        return room_state(room, token)
    if token != room["host"]:
        raise ApiError(403, "Only the host can do that")
    if path == "/api/room/start":
        if room["phase"] not in ("lobby", "final"):
            raise ApiError(400, "Game already running")
        cat, tags = str(body.get("cat") or "all"), [str(t) for t in body.get("tags") or []][:20]
        size = len(pool(cat, tags))
        if not size:
            raise ApiError(400, "No prompts match those filters")
        try:
            rounds = int(body.get("rounds") or 5)
        except (TypeError, ValueError):
            rounds = 5
        try:
            secs = int(body.get("secs") or ROUND_S)
        except (TypeError, ValueError):
            secs = ROUND_S
        room.update(cat=cat, tags=tags, rounds=max(1, min(rounds, 10, size)), round=0,
                    secs=secs if secs in TIMERS else ROUND_S, history=[], asks=[])
        for p in room["players"].values():
            p["score"], p["double_left"] = 0, True
        next_question(room)
    elif path == "/api/room/rematch":   # same category, rounds, timer and players; fresh scores and new prompts
        if room["phase"] != "final":
            raise ApiError(400, "The game isn't over yet")
        room.update(round=0, history=[], asks=[])
        for p in room["players"].values():
            p["score"], p["double_left"] = 0, True
        next_question(room)
    elif path == "/api/room/next":
        if room["phase"] == "reveal":
            if room["round"] >= room["rounds"]:
                room["phase"] = "final"
            else:
                next_question(room)
    elif path == "/api/room/lobby":
        if room["phase"] == "final":
            room["phase"] = "lobby"
    else:
        raise ApiError(404, "Not found")
    return room_state(room, token)


class Handler(BaseHTTPRequestHandler):
    server_version = "Outlier"

    def log_message(self, *args):
        pass

    def send_body(self, status, ctype, body):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, status=200):
        self.send_body(status, "application/json", json.dumps(obj).encode())

    def run_api(self, fn, *args):
        try:
            with LOCK:
                out = fn(*args)
            self.send_json(out)
        except ApiError as e:
            self.send_json({"error": e.msg}, e.status)
        except (BrokenPipeError, ConnectionError):
            pass
        except Exception:
            traceback.print_exc()
            self.send_json({"error": "Server error"}, 500)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            return self.run_api(api_get, url.path, q)
        if url.path.startswith("/c/"):   # a challenge link: the app, with a preview card for messaging apps
            return self.send_body(200, "text/html; charset=utf-8", challenge_page(url.path))
        rel = "index.html" if url.path == "/" else url.path.lstrip("/")
        full = os.path.normpath(os.path.join(PUBLIC, rel))
        if not full.startswith(PUBLIC + os.sep) or not os.path.isfile(full):
            return self.send_body(404, "text/plain", b"Not found")
        with open(full, "rb") as f:
            body = f.read()
        try:
            self.send_body(200, MIME.get(os.path.splitext(full)[1], "application/octet-stream"), body)
        except (BrokenPipeError, ConnectionError):
            pass

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(min(length, 8192)) or b"{}")
            if not isinstance(body, dict):
                raise ValueError
        except ValueError:
            return self.send_json({"error": "Bad request"}, 400)
        self.run_api(api_post, urlparse(self.path).path, body)


# ---------------------------------------------------------------- entry

def challenge_page(path):
    """index.html with Open Graph tags, so a texted challenge link shows "Ryan scored 310 on Outlier"."""
    import html
    from urllib.parse import unquote
    parts = path.split("/")
    name = unquote(parts[2]).replace("_", " ")[:16] if len(parts) > 2 else ""
    token = parts[3] if len(parts) > 3 else ""
    if len(token) % 6 == 0:   # seed (4 characters a prompt) then points (2 characters a prompt, base 36)
        k = len(token) // 6
        pts = token[4 * k:]
        total = sum(min(100, int(pts[i:i + 2], 36)) for i in range(0, len(pts), 2) if pts[i:i + 2].isalnum())
    else:   # older links carried one rarity-tier digit a prompt
        k = len(token) // 5
        total = sum([0, 10, 25, 50, 75, 100][int(c)] for c in token[4 * k:] if c.isdigit() and int(c) < 6)
    title = f"{name or 'A friend'} scored {total} on Outlier" if k else "Outlier"
    desc = f"Can you beat them on the same {k} prompts? Give the answer nobody else did." if k else "Give the answer nobody else did."
    with open(os.path.join(PUBLIC, "index.html"), encoding="utf-8") as f:
        page = f.read()
    tags = (f'<meta property="og:title" content="{html.escape(title)}">\n'
            f'  <meta property="og:description" content="{html.escape(desc)}">\n'
            f'  <meta property="og:site_name" content="Outlier">\n  <title>')
    return page.replace("<title>", tags, 1).encode()


def cli(args):
    if args[0] == "suggestions":
        rows = DB.execute("SELECT prompt_id, raw, count FROM suggestions ORDER BY count DESC LIMIT 100").fetchall()
        for pid, raw, count in rows:
            print(f"{count:4}  {pid:28} {raw}")
        print(f"\n{len(rows)} unmatched answers. Approve one with: python server.py approve <prompt-id> <answer>")
    elif args[0] == "approve" and len(args) >= 3 and args[1] in PROMPTS:
        name = " ".join(args[2:])
        seen = DB.execute("SELECT count FROM suggestions WHERE prompt_id = ? AND key = ?", (args[1], norm(name))).fetchone()
        DB.execute("INSERT OR IGNORE INTO answers VALUES (?, ?, ?)", (args[1], name, max(3, seen[0] if seen else 0)))
        DB.execute("DELETE FROM suggestions WHERE prompt_id = ? AND key = ?", (args[1], norm(name)))
        DB.commit()
        print(f"Added '{name}' to {args[1]}. Restart the server to pick it up.")
    else:
        print(__doc__)


def main():
    load_prompts()
    open_db()
    if len(sys.argv) > 1:
        return cli(sys.argv[1:])
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print(f"Outlier is running with {len(PROMPTS)} prompts.", flush=True)
    print(f"  On this computer:  http://localhost:{PORT}", flush=True)
    try:
        for ip in sorted(set(socket.gethostbyname_ex(socket.gethostname())[2])):
            if not ip.startswith("127."):
                print(f"  On your phone:     http://{ip}:{PORT}   (same Wi-Fi)", flush=True)
    except OSError:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
