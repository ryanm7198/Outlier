#!/usr/bin/env python3
"""Outlier - a "rarest answer wins" trivia game. Standard library only (pywebpush, optional, sends streak reminders).

Run:      python server.py            (then open http://localhost:8321)
Review:   python server.py suggestions
Approve:  python server.py approve <prompt-id> <answer text>
"""
import datetime
import functools
import glob
import hashlib
import hmac
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
import urllib.error
import urllib.parse
import urllib.request
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:   # web push for streak reminders is optional: without pywebpush (or the VAPID keys below) reminders are simply off
    from pywebpush import WebPushException, webpush
except Exception:
    webpush = None
try:   # reminders go out in the UK evening; without time zone data (pip install tzdata) UTC is close enough
    from zoneinfo import ZoneInfo
    UK = ZoneInfo("Europe/London")
except Exception:
    UK = datetime.timezone.utc

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
# Where the crowd's answer counts live. On a host with a persistent disk, set OUTLIER_DB to a file on that disk.
DB_PATH = os.environ.get("OUTLIER_DB") or os.path.join(ROOT, "data", "outlier.db")
PORT = int(os.environ.get("PORT", "8321"))
DEV = os.environ.get("OUTLIER_DEV") == "1"                  # local testing: sign-in links are printed and returned, not emailed
MAIL_KEY = os.environ.get("RESEND_API_KEY", "")              # Resend (resend.com) key for sending sign-in emails
MAIL_FROM = os.environ.get("OUTLIER_MAIL_FROM", "Outlier <hello@outliertrivia.app>")
PAYWALL = os.environ.get("OUTLIER_PAYWALL") == "1"            # off: everyone has everything (nothing is limited)
# A secret pass code (set on the host, never in the code): typed into the sign-in email box, it signs that browser
# into its own new Plus account straight away, no email needed. Unset it to switch every pass account back to free.
PASS_CODE = os.environ.get("OUTLIER_PASS_CODE", "").strip().lower()
REVIEW_KEY = os.environ.get("OUTLIER_REVIEW_KEY", "").strip()    # lets the nightly reviewer read and clear rejected answers
VAPID_PUBLIC = os.environ.get("OUTLIER_VAPID_PUBLIC", "").strip()     # urlsafe base64 P-256 public key: the browser's applicationServerKey
VAPID_PRIVATE = os.environ.get("OUTLIER_VAPID_PRIVATE", "").strip()   # its private half (urlsafe base64 of the raw 32 bytes)
VAPID_SUB = os.environ.get("OUTLIER_VAPID_SUB", "").strip() or "mailto:hello@outliertrivia.app"   # who push services can contact
PUSH = bool(webpush and VAPID_PUBLIC and VAPID_PRIVATE)
REMIND_HOUR = 19   # UK time from which a streak at risk gets its one reminder of the day
LOOK_RX = re.compile(r"[0-9a-z]{4,5}")   # a party character: head, eyes, mouth, hat, face (one character each)
PASS_PREFIX = "pass:"   # pass accounts have no email; their "email" column is pass:<random>
PLUS_EMAILS = {e.strip().lower() for e in os.environ.get("OUTLIER_PLUS_EMAILS", "").split(",") if e.strip()}   # always full access
STRIPE_KEY = os.environ.get("STRIPE_SECRET_KEY", "")          # Stripe secret key (sk_test_... while testing)
STRIPE_PRICE = os.environ.get("STRIPE_PRICE_ID", "")           # the monthly Outlier Plus price (price_...)
STRIPE_HOOK = os.environ.get("STRIPE_WEBHOOK_SECRET", "")      # signing secret of the webhook endpoint (whsec_...)
PRICE_LABEL = os.environ.get("OUTLIER_PRICE_LABEL", "\u00a32.99 a month")
FREE_ROOM, PLUS_ROOM = 4, 12                                  # players in a party room
SITE_URL = os.environ.get("OUTLIER_SITE_URL", "https://outliertrivia.app").rstrip("/")

DAILY_N = 7            # prompts in a daily game
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
EASY_FROM = datetime.date(2026, 11, 17)     # dailies from this day on only use questions most people can answer
# How easy each question is (1 = specialist, 5 = almost anyone can name one), from daily_ease.json. Questions about a
# single artist, show, game or film series only make the daily if they are mega-famous (5); others need 4 or more.
# Category dailies (Sport, Music...) are allowed one notch harder, as the player chose that topic.
EASE = {}
# How far a whole table could go on one question in Fumble (5 = everyone can name several), from fumble_ease.json.
# Fumble's Everything only uses the deepest, so nobody gets a prompt the whole room is stuck on.
FUMBLE_EASE = {}
ONE_THING = re.compile(r"\b(song|single|track|album|b-side) (by|on|from)\b|'s '|character (from|in)|characters? (from|in)|"
                       r"episode|series of|season of|in (the )?[A-Z][\w' ]+ (series|franchise|films?)|\bfrom '", re.I)
ONE_NAME = re.compile(r"^Name an? (?:[A-Z][\w.'&-]*\s)+(single|song|album|film|track|character)s?\b")   # "Name a Stevie Wonder single"
TEAMS_FROM = datetime.date(2026, 11, 26)   # dailies from this day on keep to one prompt per club or national team
STREAM_FROM = datetime.date(2026, 11, 13)   # dailies from this day on use the endless mix below (earlier days keep their prompts)
# How big a share each top-level category gets in an Everything game: mostly general knowledge, with a sprinkle of
# the specialist ones. Sport covers football and the NBA too, so it is one share however many questions it has.
TOP_SHARE = {"geography": 1.5, "history": 0.9, "science": 1.5, "words": 1.5, "misc": 1.5, "food": 1.3,
             "film": 1.0, "music": 0.8, "gaming": 0.6, "sport": 0.6}
# Question health. A prompt players clearly dislike is retired: it stops coming up in new dailies and in quick,
# random, party and Fumble games (old challenge links and pinned dailies with it still play). The owner can force
# either way through /api/review/retire. A prompt whose crowd all says the same thing is only flagged for widening.
RETIRE_VOTES = 6          # retire only once at least this many players have voted on it...
RETIRE_DOWN = 0.65        # ...and at least this share of the votes are thumbs down
RETIRE_TTL = 300          # seconds the retired set is cached (a vote or override refreshes it straight away)
SPREAD_PLAYS = 40         # low-spread checks need this many real plays on a prompt
SPREAD_TOP = 0.70         # flagged if the most common answer has more than this share of real plays...
SPREAD_DISTINCT = 4       # ...or fewer than this many different answers were ever given
LOCK = threading.RLock()

MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json",
    ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
    ".png": "image/png", ".ico": "image/x-icon", ".jpg": "image/jpeg",
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


def load_ease():
    path = os.path.join(ROOT, "daily_ease.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            EASE.update(json.load(f))
    path = os.path.join(ROOT, "fumble_ease.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            FUMBLE_EASE.update(json.load(f))


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


HINT_STOP = {"the", "and", "of", "in", "on", "to", "for", "a", "an", "mr", "mrs", "dr"}


def singular(w):
    for suffix, cut in (("ies", 3), ("es", 2), ("s", 1)):
        if len(w) > cut + 2 and w.endswith(suffix):
            return w[:-cut] + ("y" if suffix == "ies" else "")
    return w


def near_miss(pid, raw):
    """A looser guess for the "Did you mean ...?" step, only used once the normal match has failed:
    1. a typed word (or its singular) that is a whole word of an answer: "dogs" -> "Zombie Dog" (the answers
       are listed likeliest first, so the likeliest one is offered);
    2. a few more typos than the normal match allows;
    3. a fragment that sits inside exactly one answer ("ronaldinh")."""
    n = norm(raw)
    if len(n) < 3:
        return None
    words = [w for w in n.split() if w not in HINT_STOP]
    if words and all(len(w) >= 3 for w in words):
        want = [{w, singular(w)} for w in words]
        for name in PROMPTS[pid]["names"]:
            toks = set(norm(name).split())
            if all(v & toks for v in want):
                return name
    if len(n) < 4:
        return None
    table = LOOKUP[pid]
    cap = 1 if len(n) < 6 else 2 if len(n) < 8 else 3
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
    try:   # real plays are kept apart from the starting crowd, so the starting crowd can fade as people play
        DB.execute("ALTER TABLE answers ADD COLUMN plays INTEGER NOT NULL DEFAULT 0")
    except sqlite3.OperationalError:
        pass
    DB.execute("CREATE TABLE IF NOT EXISTS suggestions (prompt_id TEXT, key TEXT, raw TEXT, count INTEGER, "
               "PRIMARY KEY (prompt_id, key))")
    DB.execute("CREATE TABLE IF NOT EXISTS scores (seed TEXT, cid TEXT, name TEXT, total INTEGER, pts TEXT, "
               "ts INTEGER, PRIMARY KEY (seed, cid))")
    DB.execute("CREATE TABLE IF NOT EXISTS review_seen (prompt_id TEXT, key TEXT, verdict TEXT, ts INTEGER, "
               "PRIMARY KEY (prompt_id, key))")
    DB.execute("CREATE TABLE IF NOT EXISTS daily_pins (cat TEXT, day TEXT, ids TEXT, PRIMARY KEY (cat, day))")
    DB.execute("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE, created INTEGER)")
    DB.execute("CREATE TABLE IF NOT EXISTS logins (hash TEXT PRIMARY KEY, email TEXT, created INTEGER, expires INTEGER, used INTEGER DEFAULT 0)")
    DB.execute("CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id INTEGER, expires INTEGER)")
    for col in ("code TEXT", "tries INTEGER DEFAULT 0"):   # the 6-digit code sent alongside each sign-in link
        try:
            DB.execute("ALTER TABLE logins ADD COLUMN " + col)
        except sqlite3.OperationalError:
            pass
    DB.execute("CREATE TABLE IF NOT EXISTS user_plays (user_id INTEGER, ts INTEGER, prompt_id TEXT, answer TEXT, points INTEGER, share REAL)")
    DB.execute("CREATE TABLE IF NOT EXISTS daily_claims (user_id INTEGER, day TEXT, cat TEXT, PRIMARY KEY (user_id, day))")
    DB.execute("CREATE TABLE IF NOT EXISTS subs (user_id INTEGER PRIMARY KEY, customer TEXT, sub_id TEXT, status TEXT, updated INTEGER)")
    DB.execute("CREATE TABLE IF NOT EXISTS daily_answers (day TEXT PRIMARY KEY, n INTEGER)")
    DB.execute("CREATE TABLE IF NOT EXISTS daily_seen (day TEXT, cid TEXT, PRIMARY KEY (day, cid))")
    DB.execute("CREATE TABLE IF NOT EXISTS votes (prompt_id TEXT, cid TEXT, vote INTEGER, ts INTEGER, PRIMARY KEY (prompt_id, cid))")
    DB.execute("CREATE TABLE IF NOT EXISTS streaks (user_id INTEGER PRIMARY KEY, n INTEGER, best INTEGER, last TEXT)")
    DB.execute("CREATE TABLE IF NOT EXISTS retired_overrides (prompt_id TEXT PRIMARY KEY, state TEXT, ts INTEGER)")   # 'retired' | 'kept'
    DB.execute("CREATE INDEX IF NOT EXISTS user_plays_user ON user_plays (user_id, ts)")
    # web push subscriptions for streak reminders, with the streak the browser last reported (n, last day played)
    # and the day it was last reminded; user_id links a signed-in player, whose streak in `streaks` wins
    DB.execute("CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, cid TEXT, p256dh TEXT, auth TEXT, created INTEGER, "
               "user_id INTEGER, n INTEGER NOT NULL DEFAULT 0, last TEXT NOT NULL DEFAULT '', notified TEXT NOT NULL DEFAULT '')")
    DB.execute("CREATE INDEX IF NOT EXISTS push_subs_cid ON push_subs (cid)")
    # Every solo and daily answer by browser id, for the You page. user_id is set when the player was signed in, which
    # links that browser to the account: stats then gather every browser the account has played on.
    DB.execute("CREATE TABLE IF NOT EXISTS cid_plays (cid TEXT, user_id INTEGER, ts INTEGER, day TEXT, prompt_id TEXT, cat TEXT, "
               "answer TEXT, valid INTEGER, points INTEGER, share REAL, outlier INTEGER)")
    DB.execute("CREATE INDEX IF NOT EXISTS cid_plays_cid ON cid_plays (cid, ts)")
    DB.execute("CREATE INDEX IF NOT EXISTS cid_plays_user ON cid_plays (user_id)")
    # One row per finished party game per browser (round = which game in that room, so rematches count again)
    DB.execute("CREATE TABLE IF NOT EXISTS party_results (cid TEXT, user_id INTEGER, ts INTEGER, mode TEXT, place INTEGER, "
               "players INTEGER, code TEXT, round INTEGER, PRIMARY KEY (cid, code, round))")
    # Friends leagues: a private Daily seven · Everything board for a group, built from the same scores as the public one
    DB.execute("CREATE TABLE IF NOT EXISTS leagues (code TEXT PRIMARY KEY, name TEXT, owner_cid TEXT, created INTEGER)")
    DB.execute("CREATE TABLE IF NOT EXISTS league_members (code TEXT, cid TEXT, name TEXT, joined INTEGER, PRIMARY KEY (code, cid))")
    DB.execute("CREATE INDEX IF NOT EXISTS league_members_cid ON league_members (cid)")
    try:   # 1 = an answer approved by hand (python server.py approve), which lives only in the database
        DB.execute("ALTER TABLE answers ADD COLUMN extra INTEGER NOT NULL DEFAULT 0")
    except sqlite3.OperationalError:
        pass
    sync_answers()
    # Answers approved later live only in the database; make them matchable too.
    for pid, name in DB.execute("SELECT prompt_id, name FROM answers"):
        if pid in LOOKUP:
            add_key(pid, norm(name), name)


def seeds_for(names):
    """A long-tailed start in list order. The last answer listed (last two on long lists) starts below
    everything else, so it is the Outlier; neighbours deep in a long list may tie, which only
    means they share a score."""
    seeds = [seed_count(rank) for rank in range(len(names))]
    for k in range(1, (2 if len(seeds) >= OUTLIER_PAIR else 1) + 1):
        if len(seeds) > k:
            seeds[-k] = k
    return seeds


def sync_answers():
    """Make the database's starting crowd follow the question files on every start, keeping real plays:
    - each listed answer's starting count follows its current place in the list (so reordering a list works);
    - an answer renamed in the files hands its plays to the new name (found through the new name's aliases);
    - an answer since removed from the files is dropped, so it can't linger as an unreachable "Outlier".
    Answers approved by hand (extra = 1) are kept as they are."""
    changed = 0
    for pid, p in PROMPTS.items():
        want = dict(zip(p["names"], seeds_for(p["names"])))
        rows = {n: (c, pl, ex) for n, c, pl, ex in
                DB.execute("SELECT name, count, plays, extra FROM answers WHERE prompt_id = ?", (pid,))}
        for name, seed in want.items():
            if name not in rows:
                DB.execute("INSERT INTO answers (prompt_id, name, count) VALUES (?, ?, ?)", (pid, name, seed))
                changed += 1
            elif rows[name][0] != seed + rows[name][1]:
                DB.execute("UPDATE answers SET count = ? + plays WHERE prompt_id = ? AND name = ?", (seed, pid, name))
                changed += 1
        for name, (_, plays, extra) in rows.items():
            if name in want or extra:
                continue
            new = LOOKUP[pid].get(norm(name))
            if plays and new in want:
                DB.execute("UPDATE answers SET plays = plays + ?, count = count + ? WHERE prompt_id = ? AND name = ?",
                           (plays, plays, pid, new))
            DB.execute("DELETE FROM answers WHERE prompt_id = ? AND name = ?", (pid, name))
            changed += 1
    DB.commit()
    if changed:
        print(f"  Answer lists synced with the question files ({changed} changes)", flush=True)


PRIOR_PLAYS = 300   # the starting crowd weighs as much as this many real plays on a prompt
PLAY_FLOOR = 0.1    # every answer counts as at least a tenth of a play, so rare ones can't collapse to zero


def counts_for(pid):
    """The crowd for one prompt: a fixed-size starting crowd (the list order) plus every real play.
    With few players each play moves things visibly; the more people play, the more the real crowd takes over
    and the starting crowd fades, so the numbers stay balanced however busy the prompt is."""
    rows = DB.execute("SELECT name, count - plays, plays FROM answers WHERE prompt_id = ?", (pid,)).fetchall()
    prior_total = sum(max(0, p) for _, p, _ in rows) or 1
    return {n: PRIOR_PLAYS * max(0, p) / prior_total + plays + PLAY_FLOOR for n, p, plays in rows}


def outliers_for(counts):
    """The rarest answer is the Outlier; lists of 30 or more answers have two."""
    return sorted(counts, key=lambda n: (counts[n], n))[:2 if len(counts) >= OUTLIER_PAIR else 1]


OUTLIER_POINTS = 150   # the rarest answer is worth a big step up from the 99 below it


def score_map(counts, top=None):
    """Points for every answer. Only an Outlier scores 150 (OUTLIER_POINTS). Everything else is spread from 10
    (the commonest) to 99 (the rarest non-Outlier), half by how rare it is on a log scale and half by its place in
    the ranking, so neighbouring answers sit close together and one very rare answer can't stretch the scale."""
    top = top if top is not None else outliers_for(counts)
    rest = sorted((n for n in counts if n not in top), key=lambda n: -counts[n])
    out = {n: OUTLIER_POINTS for n in top}
    if not rest:
        return out
    hi, lo = counts[rest[0]], counts[rest[-1]]
    first = {}
    for i, n in enumerate(rest):
        first.setdefault(counts[n], i)          # tied answers share the same place
    span = max(1, len(rest) - 1)
    for n in rest:
        rank = first[counts[n]] / span
        logp = (math.log(hi) - math.log(counts[n])) / (math.log(hi) - math.log(lo)) if hi > lo else rank
        out[n] = min(99, round(10 + 89 * (0.5 * rank + 0.5 * logp)))
    return out


def points_for(counts, name):
    return score_map(counts)[name]


def share_for(counts, name):
    return round(100 * counts[name] / sum(counts.values()), 1)


BOARD_MAX = 150   # long lists send the commonest answers plus the player's own and the Outliers


def board_for(counts, keep=(), cap=BOARD_MAX):
    rows, top = sorted(counts, key=lambda n: -counts[n]), outliers_for(counts)
    pts, total = score_map(counts, top), sum(counts.values())
    if cap and len(rows) > cap:
        rows = rows[:BOARD_MAX] + [n for n in rows[BOARD_MAX:] if n in top or n in keep]
    return [{"name": n, "share": round(100 * counts[n] / total, 1), "points": pts[n],
             "outlier": n in top} for n in rows]


def record(pid, name, raw):
    """Every entry nudges the crowd: valid answers get more common, unknown ones queue for review."""
    if name:
        DB.execute("UPDATE answers SET count = count + 1, plays = plays + 1 WHERE prompt_id = ? AND name = ?", (pid, name))
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


# ---------------------------------------------------------------- accounts
# Sign in with an emailed one-use link (no passwords). A session token lives in the browser; only its hash is stored.

CURRENT = {"token": "", "alt": "", "host": "", "cookie": None, "has_cookie": False}   # the request being served; set under LOCK in run_api
LOGIN_TTL, SESSION_TTL = 15 * 60, 90 * 86400
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,120}\.[^@\s]{2,24}$")


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def session_cookie(token, max_age):
    """The sign-in cookie: HttpOnly so scripts cannot read it, and kept for the full session length (Safari clears
    local storage after about a week of not visiting, but keeps cookies like this)."""
    secure = "; Secure" if (not DEV and SITE_URL.startswith("https")) else ""
    return f"outlier_session={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}"


def current_user():
    now, row = int(time.time()), None
    for tok in dict.fromkeys(t for t in (CURRENT["token"], CURRENT["alt"]) if t):   # the saved token first, then the cookie
        row = DB.execute("SELECT u.id, u.email, s.expires FROM sessions s JOIN users u ON u.id = s.user_id "
                         "WHERE s.hash = ? AND s.expires > ?", (sha(tok), now)).fetchone()
        if row:
            CURRENT["token"] = tok
            break
    if not row:
        return None
    tok = CURRENT["token"]
    if row[2] < now + SESSION_TTL - 86400:   # used again: the 90 days start over (at most once a day)
        DB.execute("UPDATE sessions SET expires = ? WHERE hash = ?", (now + SESSION_TTL, sha(tok)))
        DB.commit()
        CURRENT["cookie"] = session_cookie(tok, SESSION_TTL)
    elif not CURRENT["has_cookie"] or CURRENT["alt"] != tok:   # no cookie yet (or a stale one): give this session its cookie
        CURRENT["cookie"] = session_cookie(tok, SESSION_TTL)
    return {"id": row[0], "email": row[1]}


def is_plus(user=None):
    """Full access: everyone while the paywall is off, otherwise the owner list (paid subscribers join this later)."""
    user = user or current_user()
    if not PAYWALL:
        return True
    return bool(user and (user["email"] in PLUS_EMAILS or (PASS_CODE and user["email"].startswith(PASS_PREFIX))
                          or sub_status(user["id"]) in LIVE_SUB))


LIVE_SUB = ("active", "trialing", "past_due")   # past_due keeps access while Stripe retries the card


def sub_status(uid):
    row = DB.execute("SELECT status FROM subs WHERE user_id = ?", (uid,)).fetchone()
    return row[0] if row else None


# ---- Stripe (plain REST calls, no SDK): checkout to subscribe, portal to manage or cancel, webhook to learn the outcome

def stripe_call(path, data):
    if not STRIPE_KEY:
        raise ApiError(503, "Payments are not switched on yet")
    req = urllib.request.Request("https://api.stripe.com/v1/" + path, urllib.parse.urlencode(data).encode(), method="POST",
                                 headers={"Authorization": "Bearer " + STRIPE_KEY, "User-Agent": "outlier-trivia/1.0"})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=15).read())
    except urllib.error.HTTPError as e:
        print("  Stripe rejected the request:", e.code, e.read()[:400].decode("utf-8", "replace"), flush=True)
    except (urllib.error.URLError, OSError) as e:
        print("  Stripe unreachable:", e, flush=True)
    raise ApiError(502, "Could not reach the payment service. Try again in a moment.")


def site_base():
    return f"http://{CURRENT['host']}" if DEV and CURRENT["host"] else SITE_URL


def start_checkout():
    user = current_user()
    if not user:
        raise ApiError(401, "Sign in first so your subscription is tied to your account")
    if not STRIPE_PRICE:
        raise ApiError(503, "Payments are not switched on yet")
    if is_plus(user) and PAYWALL:
        raise ApiError(400, "You already have Outlier Plus")
    row = DB.execute("SELECT customer FROM subs WHERE user_id = ?", (user["id"],)).fetchone()
    data = {"mode": "subscription", "line_items[0][price]": STRIPE_PRICE, "line_items[0][quantity]": "1",
            "success_url": site_base() + "/?plus=1", "cancel_url": site_base() + "/",
            "client_reference_id": str(user["id"]), "subscription_data[metadata][user_id]": str(user["id"]),
            "allow_promotion_codes": "true"}
    if row and row[0]:
        data["customer"] = row[0]
    else:
        data["customer_email"] = user["email"]
    return {"url": stripe_call("checkout/sessions", data)["url"]}


def open_portal():
    user = current_user()
    row = user and DB.execute("SELECT customer FROM subs WHERE user_id = ?", (user["id"],)).fetchone()
    if not row or not row[0]:
        raise ApiError(404, "No subscription found for this account")
    return {"url": stripe_call("billing_portal/sessions", {"customer": row[0], "return_url": site_base() + "/"})["url"]}


def stripe_event(raw, header):
    """Verify Stripe's signature (HMAC-SHA256 over 'timestamp.body'), then record what the event says about a subscription."""
    if not STRIPE_HOOK:
        raise ApiError(503, "Webhook is not configured")
    parts = [p.split("=", 1) for p in header.split(",") if "=" in p]
    stamp = next((v for k, v in parts if k == "t"), "")
    good = hmac.new(STRIPE_HOOK.encode(), stamp.encode() + b"." + raw, hashlib.sha256).hexdigest()
    if not stamp.isdigit() or abs(time.time() - int(stamp)) > 600 or not any(hmac.compare_digest(good, v) for k, v in parts if k == "v1"):
        raise ApiError(400, "Bad signature")
    ev = json.loads(raw)
    obj = ev.get("data", {}).get("object", {})
    now = int(time.time())
    if ev.get("type") == "checkout.session.completed" and obj.get("mode") == "subscription":
        uid = int(obj.get("client_reference_id") or 0)
        if uid:
            DB.execute("INSERT INTO subs (user_id, customer, sub_id, status, updated) VALUES (?, ?, ?, 'active', ?) "
                       "ON CONFLICT(user_id) DO UPDATE SET customer = excluded.customer, sub_id = excluded.sub_id, status = 'active', updated = excluded.updated",
                       (uid, obj.get("customer"), obj.get("subscription"), now))
    elif ev.get("type") in ("customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"):
        status = "canceled" if ev["type"].endswith("deleted") else obj.get("status")
        uid = int((obj.get("metadata") or {}).get("user_id") or 0)
        row = DB.execute("SELECT user_id FROM subs WHERE customer = ?", (obj.get("customer"),)).fetchone()
        uid = row[0] if row else uid
        if uid:
            DB.execute("INSERT INTO subs (user_id, customer, sub_id, status, updated) VALUES (?, ?, ?, ?, ?) "
                       "ON CONFLICT(user_id) DO UPDATE SET customer = excluded.customer, sub_id = excluded.sub_id, status = excluded.status, updated = excluded.updated",
                       (uid, obj.get("customer"), obj.get("id"), status, now))
    DB.commit()
    return {"ok": True}


def need_plus():
    if not is_plus():
        raise ApiError(402, "That is part of Outlier Plus")


def check_daily(cat):
    """Free players: Everything daily without an account, plus one other top-level category per day with a free account."""
    user = current_user()
    if is_plus(user) or cat == "all":
        return
    c = next((c for c in CATS if c["id"] == cat), None)
    if c is None or c["parent"]:
        raise ApiError(402, "Picking a specific sub-category is part of Outlier Plus")
    if not user:
        raise ApiError(401, "Sign in (it is free) to play a daily in this category")
    day = datetime.date.today().isoformat()
    row = DB.execute("SELECT cat FROM daily_claims WHERE user_id = ? AND day = ?", (user["id"], day)).fetchone()
    if row and row[0] != cat:
        raise ApiError(402, "You have used your free category daily today. More dailies are part of Outlier Plus.")
    if not row:
        DB.execute("INSERT INTO daily_claims VALUES (?, ?, ?)", (user["id"], day, cat))
        DB.commit()


def send_login_email(email, link, code):
    body = {"from": MAIL_FROM, "to": [email], "subject": f"Your Outlier sign-in code: {code}",
            "text": f"Your Outlier sign-in code is {code}\n\nType it into Outlier where you asked for it. "
                    f"Or tap this link to sign in (it opens in your phone's default browser or your mail app's own one):\n\n{link}\n\n"
                    "The code and link work once and expire in 15 minutes. If you did not ask for this, you can ignore this email."}
    req = urllib.request.Request("https://api.resend.com/emails", json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {MAIL_KEY}", "Content-Type": "application/json",
                                          "User-Agent": "outlier-trivia/1.0"})
    try:
        urllib.request.urlopen(req, timeout=10).read()
    except urllib.error.HTTPError as e:
        print("  Resend rejected the email:", e.code, e.read()[:300].decode("utf-8", "replace"), flush=True)
        raise ApiError(502, "Could not send the email. Try again in a moment.")
    except (urllib.error.URLError, OSError) as e:
        print("  Resend unreachable:", e, flush=True)
        raise ApiError(502, "Could not send the email. Try again in a moment.")


def request_login(body):
    email = str(body.get("email") or "").strip().lower()[:160]
    if PASS_CODE and len(PASS_CODE) >= 6 and hmac.compare_digest(email.encode(), PASS_CODE.encode()):
        return {**start_session(PASS_PREFIX + secrets.token_hex(8)), "email": "Plus pass", "pass": True}
    if not EMAIL_RE.match(email):
        raise ApiError(400, "That does not look like an email address")
    if not (MAIL_KEY or DEV):
        raise ApiError(503, "Email sign-in is not switched on yet")
    now = int(time.time())
    DB.execute("DELETE FROM logins WHERE expires < ?", (now - 86400,))
    if DB.execute("SELECT COUNT(*) FROM logins WHERE email = ? AND created > ?", (email, now - 3600)).fetchone()[0] >= 5:
        raise ApiError(429, "Too many sign-in emails for that address. Try again in an hour.")
    if DB.execute("SELECT COUNT(*) FROM logins WHERE created > ?", (now - 3600,)).fetchone()[0] >= 300:
        raise ApiError(429, "Lots of people are signing in. Try again shortly.")
    token, code = secrets.token_urlsafe(32), f"{secrets.randbelow(10 ** 6):06d}"
    DB.execute("INSERT INTO logins (hash, email, created, expires, code) VALUES (?, ?, ?, ?, ?)",
               (sha(token), email, now, now + LOGIN_TTL, sha(email + ":" + code)))
    DB.commit()
    base = f"http://{CURRENT['host']}" if DEV and CURRENT["host"] else SITE_URL
    link = f"{base}/?login={token}"
    if MAIL_KEY:
        send_login_email(email, link, code)
        return {"ok": True}
    print(f"  Sign-in link for {email}: {link}  code {code}")
    return {"ok": True, "devLink": link, "devCode": code}


def verify_login(body):
    token = str(body.get("token") or "")
    now = int(time.time())
    row = DB.execute("SELECT email FROM logins WHERE hash = ? AND used = 0 AND expires > ?", (sha(token), now)).fetchone()
    if not row:
        raise ApiError(400, "That sign-in link has expired or was already used. Ask for a new one.")
    DB.execute("UPDATE logins SET used = 1 WHERE hash = ?", (sha(token),))
    return start_session(row[0])


def verify_code(body):
    """The 6-digit code from the email, typed into the browser that asked for it (the link may open somewhere else,
    such as a mail app's own browser). Five wrong guesses use up that email's code."""
    email = str(body.get("email") or "").strip().lower()[:160]
    code = re.sub(r"\D", "", str(body.get("code") or ""))[:6]
    now = int(time.time())
    row = DB.execute("SELECT hash, code FROM logins WHERE email = ? AND used = 0 AND expires > ? AND tries < 5 AND code IS NOT NULL "
                     "ORDER BY created DESC LIMIT 1", (email, now)).fetchone()
    if not row:
        raise ApiError(400, "That code has expired. Ask for a new email.")
    if len(code) != 6 or not hmac.compare_digest(row[1], sha(email + ":" + code)):
        DB.execute("UPDATE logins SET tries = tries + 1 WHERE hash = ?", (row[0],))
        DB.commit()
        raise ApiError(400, "That code is not right. Check the latest email and try again.")
    DB.execute("UPDATE logins SET used = 1 WHERE hash = ?", (row[0],))
    return start_session(email)


def start_session(email):
    now = int(time.time())
    DB.execute("INSERT OR IGNORE INTO users (email, created) VALUES (?, ?)", (email, now))
    uid = DB.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()[0]
    session = secrets.token_urlsafe(32)
    DB.execute("INSERT INTO sessions VALUES (?, ?, ?)", (sha(session), uid, now + SESSION_TTL))
    DB.execute("DELETE FROM sessions WHERE expires < ?", (now,))
    DB.commit()
    CURRENT["cookie"] = session_cookie(session, SESSION_TTL)
    return {"session": session, "email": email}


def logout():
    if CURRENT["token"]:
        DB.execute("DELETE FROM sessions WHERE hash = ?", (sha(CURRENT["token"]),))
        DB.commit()
    CURRENT["cookie"] = session_cookie("", 0)
    return {"ok": True}


def note_play(cid):
    """Tallies for the owner's stats page: answers per day, and which anonymous player ids were active that day."""
    day = datetime.date.today().isoformat()
    DB.execute("INSERT INTO daily_answers (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1", (day,))
    if cid:
        DB.execute("INSERT OR IGNORE INTO daily_seen (day, cid) VALUES (?, ?)", (day, cid))


def ratings(min_votes=3, n=15):
    """Prompt ratings from thumbs up/down: the best and worst liked, with a small prior so one vote can't top the table."""
    rows = DB.execute("SELECT prompt_id, SUM(vote = 1), SUM(vote = -1) FROM votes GROUP BY prompt_id HAVING COUNT(*) >= ?", (min_votes,)).fetchall()
    scored = [{"id": p, "text": PROMPTS[p]["text"] if p in PROMPTS else p, "up": u, "down": d,
               "score": round(100 * (u + 1) / (u + d + 2))} for p, u, d in rows]
    best = sorted(scored, key=lambda r: (-r["score"], -(r["up"] + r["down"])))
    best = [r for r in best if r["score"] >= 50][:n]
    worst = sorted(scored, key=lambda r: (r["score"], -(r["up"] + r["down"])))
    worst = [r for r in worst if r["score"] < 50][:n]
    return {"best": best, "worst": worst, "rated": len(scored)}


def stats():
    user = current_user()
    if not user or user["email"] not in PLUS_EMAILS:
        raise ApiError(404, "Not found")
    today = datetime.date.today()
    day = lambda n: (today - datetime.timedelta(days=n)).isoformat()
    one = lambda q, *a: DB.execute(q, a).fetchone()[0] or 0
    players = dict(DB.execute("SELECT day, COUNT(*) FROM daily_seen GROUP BY day").fetchall())
    answers = dict(DB.execute("SELECT day, n FROM daily_answers").fetchall())
    now = int(time.time())
    return {
        "days": [{"day": day(i), "players": players.get(day(i), 0), "answers": answers.get(day(i), 0)} for i in range(14)],
        "players": {"today": players.get(day(0), 0), "week": one("SELECT COUNT(DISTINCT cid) FROM daily_seen WHERE day >= ?", day(6)),
                    "month": one("SELECT COUNT(DISTINCT cid) FROM daily_seen WHERE day >= ?", day(29)),
                    "all": one("SELECT COUNT(DISTINCT cid) FROM daily_seen")},
        "answers": {"today": answers.get(day(0), 0), "all": one("SELECT SUM(n) FROM daily_answers")},
        "accounts": {"total": one("SELECT COUNT(*) FROM users"), "week": one("SELECT COUNT(*) FROM users WHERE created > ?", now - 7 * 86400),
                     "subscribers": one("SELECT COUNT(*) FROM subs WHERE status IN ('active', 'trialing', 'past_due')"),
                     "canceled": one("SELECT COUNT(*) FROM subs WHERE status NOT IN ('active', 'trialing', 'past_due')")},
        "leaderboardScores": one("SELECT COUNT(*) FROM scores"),
        "votes": one("SELECT COUNT(*) FROM votes"),
        "ratings": ratings(),
        "health": question_health(20),
        "since": min(list(players) + list(answers) + [day(0)]),
        "paywall": PAYWALL,
        "db": DB_PATH, "dbPersistent": not os.path.abspath(DB_PATH).startswith(ROOT),   # anywhere outside the code folder (a mounted disk)
        "firstAccount": datetime.datetime.fromtimestamp(one("SELECT MIN(created) FROM users")).strftime("%d %b %Y %H:%M") if one("SELECT MIN(created) FROM users") else None,
    }


# ---------------------------------------------------------------- streak reminders (web push)
# A player whose streak is alive (last daily yesterday) and who hasn't played today gets one nudge in the UK evening.

B64URL = re.compile(r"^[A-Za-z0-9_-]{8,200}=*$")


def clean_cid(cid):
    return re.sub(r"[^0-9A-Za-z]", "", str(cid or ""))[:32]


def clean_streak(s):
    """The streak a browser reports, {n, last}. Anything odd counts as no streak."""
    if not isinstance(s, dict):
        return 0, ""
    last = str(s.get("last") or "")[:10]
    try:
        n = max(0, min(10000, int(s.get("n") or 0)))
        datetime.date.fromisoformat(last)
    except (TypeError, ValueError):
        return 0, ""
    return n, last


def need_push():
    if not PUSH:
        raise ApiError(503, "Reminders are not switched on")


def push_subscribe(body):
    need_push()
    cid, sub = clean_cid(body.get("cid")), body.get("subscription")
    sub = sub if isinstance(sub, dict) else {}
    keys = sub.get("keys") if isinstance(sub.get("keys"), dict) else {}
    endpoint, p256dh, auth = str(sub.get("endpoint") or ""), str(keys.get("p256dh") or ""), str(keys.get("auth") or "")
    if not cid or not endpoint.startswith("https://") or len(endpoint) > 1000 or not B64URL.match(p256dh) or not B64URL.match(auth):
        raise ApiError(400, "Bad subscription")
    n, last = clean_streak(body.get("streak"))
    user = current_user()
    DB.execute("INSERT INTO push_subs (endpoint, cid, p256dh, auth, created, user_id, n, last) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
               "ON CONFLICT(endpoint) DO UPDATE SET cid = excluded.cid, p256dh = excluded.p256dh, auth = excluded.auth, created = excluded.created, "
               "user_id = COALESCE(excluded.user_id, push_subs.user_id), n = excluded.n, last = excluded.last",
               (endpoint, cid, p256dh, auth, int(time.time()), user["id"] if user else None, n, last))
    # a browser that rotates its subscription leaves the old one behind: keep only its newest few
    DB.execute("DELETE FROM push_subs WHERE cid = ? AND endpoint NOT IN "
               "(SELECT endpoint FROM push_subs WHERE cid = ? ORDER BY created DESC LIMIT 3)", (cid, cid))
    DB.commit()
    return {"ok": True}


def push_unsubscribe(body):
    DB.execute("DELETE FROM push_subs WHERE endpoint = ?", (str(body.get("endpoint") or "")[:1000],))
    DB.commit()
    return {"ok": True}


def push_state(body):
    """The browser's streak after a daily or on opening the app, so tonight's reminder knows whether it's needed."""
    cid = clean_cid(body.get("cid"))
    if not cid:
        raise ApiError(400, "Missing player id")
    n, last = clean_streak(body.get("streak"))
    user = current_user()
    cur = DB.execute("UPDATE push_subs SET n = ?, last = ?, user_id = COALESCE(?, user_id) WHERE cid = ?",
                     (n, last, user["id"] if user else None, cid))
    DB.commit()
    return {"ok": True, "subscribed": cur.rowcount > 0}


def push_due(now, today=None):
    """Who to remind at `now` (UK time): from REMIND_HOUR on, streak alive, today not played, not reminded today.
    Returns [(endpoint, p256dh, auth, n)]. `today` is the game's day (the server's date, as the dailies use)."""
    if now.hour < REMIND_HOUR:
        return []
    today = today or datetime.date.today()
    day, yday = today.isoformat(), (today - datetime.timedelta(days=1)).isoformat()
    rows = DB.execute("SELECT p.endpoint, p.p256dh, p.auth, p.n, p.last, s.n, s.last FROM push_subs p "
                      "LEFT JOIN streaks s ON s.user_id = p.user_id WHERE p.notified != ?", (day,)).fetchall()
    due = []
    for endpoint, p256dh, auth, n, last, sn, slast in rows:
        if slast and slast >= (last or ""):   # signed in: the account's streak wins unless this browser has seen a later day
            n, last = sn, slast
        if last == yday and n > 0:
            due.append((endpoint, p256dh, auth, n))
    return due


def push_message(n):
    return {"title": "Outlier", "body": f"\U0001F525 Your {n}-day streak ends at midnight \u2014 today's Daily seven is waiting",
            "url": "/", "tag": "streak"}


def push_send(sub, payload):
    """One notification. Returns the push service's HTTP status (201 sent, 404/410 gone), or 0 if it couldn't be reached."""
    try:
        r = webpush({"endpoint": sub[0], "keys": {"p256dh": sub[1], "auth": sub[2]}}, json.dumps(payload),
                    vapid_private_key=VAPID_PRIVATE, vapid_claims={"sub": VAPID_SUB},   # a fresh dict each time: webpush adds aud per endpoint
                    ttl=4 * 3600, timeout=10)
        return getattr(r, "status_code", 201)
    except WebPushException as e:
        return getattr(e.response, "status_code", 0) or 0
    except Exception as e:   # network trouble: one line in the log is enough
        print(f"push failed: {type(e).__name__}: {str(e)[:200]}", flush=True)
        return 0


def push_round(now=None, today=None):
    """One pass of the reminder thread. Marks before sending (so a slow or failed send is never repeated), sends
    outside the lock (so the game isn't held up by push services), then forgets subscriptions that have gone."""
    now = now or datetime.datetime.now(UK)
    with LOCK:
        due = push_due(now, today)
        day = (today or datetime.date.today()).isoformat()
        DB.executemany("UPDATE push_subs SET notified = ? WHERE endpoint = ?", [(day, d[0]) for d in due])
        DB.commit()
    gone = [d[0] for d in due if push_send(d, push_message(d[3])) in (404, 410)]
    if gone:
        with LOCK:
            DB.executemany("DELETE FROM push_subs WHERE endpoint = ?", [(e,) for e in gone])
            DB.commit()
    return {"sent": len(due), "gone": len(gone)}


def push_loop():
    while True:
        try:
            push_round()
        except Exception:
            traceback.print_exc()
        time.sleep(300)


def push_test(body):
    """For the owner: a test notification now, to one subscription or to all of them (needs X-Review-Key)."""
    need_review_key()
    need_push()
    endpoint = str(body.get("endpoint") or "")
    rows = DB.execute("SELECT endpoint, p256dh, auth, n FROM push_subs" + (" WHERE endpoint = ?" if endpoint else ""),
                      (endpoint,) if endpoint else ()).fetchall()
    payload = {"title": "Outlier", "body": "Test reminder: streak notifications are working.", "url": "/", "tag": "streak"}
    out = [{"endpoint": r[0][:60], "status": push_send(r, payload)} for r in rows]
    gone = [r[0] for r, o in zip(rows, out) if o["status"] in (404, 410)]
    DB.executemany("DELETE FROM push_subs WHERE endpoint = ?", [(e,) for e in gone])
    DB.commit()
    return {"sent": len(out), "gone": len(gone), "results": out}


# ---------------------------------------------------------------- nightly answer review
# A scheduled agent fetches the answers players typed that weren't on the list, checks each one online, adds the
# real ones to the prompt files and pushes, then marks everything it looked at so it isn't offered again.

def need_review_key():
    if not REVIEW_KEY or not hmac.compare_digest(CURRENT.get("review", ""), REVIEW_KEY):
        raise ApiError(404, "Not found")


def review_queue(limit):
    need_review_key()
    rows = DB.execute("SELECT s.prompt_id, s.key, s.raw, s.count FROM suggestions s LEFT JOIN review_seen r "
                      "ON r.prompt_id = s.prompt_id AND r.key = s.key WHERE r.key IS NULL "
                      "ORDER BY s.count DESC, s.prompt_id LIMIT ?", (limit,)).fetchall()
    out = []
    for pid, key, raw, count in rows:
        if pid in PROMPTS and not match(pid, raw):   # already fixed by a deploy: nothing to review
            out.append({"promptId": pid, "prompt": PROMPTS[pid]["text"], "key": key, "typed": raw, "times": count,
                        "baseId": pid.split("--")[0], "answers": len(PROMPTS[pid]["names"])})
    return {"items": out}


def review_done(body):
    need_review_key()
    items = body.get("items") or []
    now = int(time.time())
    for it in items[:200]:
        pid, key = str(it.get("promptId") or ""), str(it.get("key") or "")
        verdict = "added" if it.get("verdict") == "added" else "rejected"
        DB.execute("INSERT OR REPLACE INTO review_seen VALUES (?, ?, ?, ?)", (pid, key, verdict, now))
        DB.execute("DELETE FROM suggestions WHERE prompt_id = ? AND key = ?", (pid, key))
    DB.commit()
    return {"ok": True, "marked": min(len(items), 200)}


# ---------------------------------------------------------------- question health

_RETIRED = {"at": 0.0, "ids": frozenset()}


def vote_tally():
    """{base prompt id: (up, down)} for every prompt anyone has voted on."""
    return {p: (u or 0, d or 0) for p, u, d in
            DB.execute("SELECT prompt_id, SUM(vote = 1), SUM(vote = -1) FROM votes GROUP BY prompt_id")}


def retired_ids():
    """Base prompt ids that are retired: disliked by the votes or forced by the owner, minus any the owner kept.
    Cached for a few minutes, as pool() asks on every game."""
    if DB is None:
        return frozenset()
    if time.time() - _RETIRED["at"] > RETIRE_TTL:
        out = {p for p, (u, d) in vote_tally().items() if u + d >= RETIRE_VOTES and d >= RETIRE_DOWN * (u + d)}
        for p, state in DB.execute("SELECT prompt_id, state FROM retired_overrides"):
            (out.add if state == "retired" else out.discard)(p)
        _RETIRED.update(at=time.time(), ids=frozenset(out))
    return _RETIRED["ids"]


def is_retired(pid):
    return pid.split("--")[0] in retired_ids()   # era versions go with the main prompt (votes are on the main one)


def retire_override(body):
    """The owner forces a prompt out ('retired') or keeps it whatever the votes say ('kept'); 'clear' goes back to the votes."""
    need_review_key()
    pid = str(body.get("promptId") or "").split("--")[0]
    state = str(body.get("state") or "")
    if pid not in PROMPTS or state not in ("retired", "kept", "clear"):
        raise ApiError(400, "Need a known promptId and state 'retired', 'kept' or 'clear'")
    if state == "clear":
        DB.execute("DELETE FROM retired_overrides WHERE prompt_id = ?", (pid,))
    else:
        DB.execute("INSERT OR REPLACE INTO retired_overrides VALUES (?, ?, ?)", (pid, state, int(time.time())))
    DB.commit()
    _RETIRED["at"] = 0
    return {"ok": True, "promptId": pid, "state": state, "retired": pid in retired_ids()}


def question_health(spread_limit=None):
    """Retired prompts with their votes, and prompts whose real plays are bunched on one answer (to widen)."""
    tally = vote_tally()
    forced = dict(DB.execute("SELECT prompt_id, state FROM retired_overrides").fetchall())
    retired = [{"promptId": p, "prompt": PROMPTS[p]["text"], "up": tally.get(p, (0, 0))[0], "down": tally.get(p, (0, 0))[1],
                "forced": forced.get(p) == "retired"} for p in sorted(retired_ids()) if p in PROMPTS]
    low = []
    for pid, plays, top, distinct in DB.execute(
            "SELECT prompt_id, SUM(plays), MAX(plays), SUM(plays > 0) FROM answers GROUP BY prompt_id HAVING SUM(plays) >= ?",
            (SPREAD_PLAYS,)):
        if pid not in PROMPTS or not (top > SPREAD_TOP * plays or distinct < SPREAD_DISTINCT):
            continue
        name = DB.execute("SELECT name FROM answers WHERE prompt_id = ? ORDER BY plays DESC, name LIMIT 1", (pid,)).fetchone()[0]
        low.append({"promptId": pid, "prompt": PROMPTS[pid]["text"], "plays": plays, "topAnswer": name,
                    "topShare": round(top / plays, 3), "distinct": distinct})
    low.sort(key=lambda r: (-r["topShare"], r["distinct"], -r["plays"]))
    return {"retired": retired, "lowSpread": low[:spread_limit] if spread_limit else low,
            "lowSpreadTotal": len(low)}


def review_flags():
    need_review_key()
    out = question_health()
    out.pop("lowSpreadTotal")
    return out


def log_play(pid, out, cid=""):
    user = current_user()
    if user and out["given"]:
        DB.execute("INSERT INTO user_plays VALUES (?, ?, ?, ?, ?, ?)",
                   (user["id"], int(time.time()), pid, out["canonical"] or out["given"], out["points"], out["share"]))
    if out["given"] and (cid or user):
        cat = PROMPTS[pid]["cat"]
        DB.execute("INSERT INTO cid_plays VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   (cid, user["id"] if user else None, int(time.time()), datetime.date.today().isoformat(), pid,
                    parent_of(cat) or cat, out["canonical"] or out["given"], int(out["valid"]), out["points"],
                    out["share"], int(out["outlier"])))


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


def pool(cat, tags, deep=None, retired=False):
    """Prompt ids in a category that pass every filter group. Questions marked "deep" (specialist
    ones, like one club's squad in one season) only come up once the player has picked a filter.
    A parent category (Sport) includes its sub-categories (Football). Ticking sports narrows it to those;
    Football's own filters (Era, Competition) then apply to the football questions only.
    Retired prompts are left out unless retired=True, though a pick made up only of retired ones keeps them."""
    if cat == "mix":
        return sorted({i for c, t in parse_mix(tags) for i in pool(c, t, deep, retired)})
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
    if not retired:
        out = [i for i in out if not is_retired(i)] or out
    return sorted(out)


def top_of(pid):
    c = PROMPTS[pid]["cat"]
    return parent_of(c) or c


def fine_key(pid):
    """Where a prompt sits for the Everything round: (top-level category, sub-category). Football and each sport
    inside Sport are separate sub-categories of Sport."""
    p = PROMPTS[pid]
    c = p["cat"]
    if parent_of(c):
        return (parent_of(c), c)
    if children_of(c):
        lead = filter_groups(c)[0]
        return (c, next((t for t in p["tags"] if t in lead), ""))
    return (c, "")


def buckets(cat, tags, ids):
    """Split a pool by the filters the player chose, so picking can share prompts out evenly between
    them (Food and Games should be a mix, not mostly whichever has more questions). The filter group
    with the most chosen tags decides the split."""
    if cat == "all":   # Everything: one bucket per sub-category (football, darts, tennis, music...)
        by = {}
        for i in ids:
            by.setdefault(fine_key(i), []).append(i)
        return [by[k] for k in sorted(by)]
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
    if cat == "all":
        # Every top-level category gets the same share of the round (so Sport, with far more questions, can't
        # dominate). Inside one, its sub-categories (Football, Darts, Tennis...) split that share by sqrt of size.
        root = [math.sqrt(len(b)) for b in groups]
        tops = [top_of(b[0]) for b in groups]
        totals = {}
        for t, r in zip(tops, root):
            totals[t] = totals.get(t, 0) + r
        return [TOP_SHARE.get(t, 1.0) * r / totals[t] for t, r in zip(tops, root)]
    spread = children_of(cat) and not sub_choices(cat, tags)[1]
    return [math.sqrt(len(b)) if spread else 1.0 for b in groups]


def balanced_order(cat, tags, ids, rng):
    """Every prompt in a fair, repeatable order (for the Daily five): the sub-category furthest below its share
    goes next, so any five-in-a-row slice is a good mix."""
    groups = buckets(cat, tags, ids)
    weights = bucket_weights(cat, groups, tags)
    queues = []
    for b in groups:
        b = list(b)
        rng.shuffle(b)
        queues.append(b)
    taken = [0] * len(queues)
    out = []
    while any(queues):
        live = [k for k in range(len(queues)) if queues[k]]
        k = min(live, key=lambda k: (taken[k] + rng.random()) / weights[k])
        out.append(queues[k].pop(0))
        taken[k] += 1
    return out


def balanced_stream(cat, tags, ids, rng, length):
    """Like balanced_order, but no group ever runs dry: a group that has used all its prompts starts its
    (shuffled) list again. So day 400 of a cycle is as well mixed as day 1, instead of being whatever is left
    of the biggest category."""
    groups = buckets(cat, tags, ids)
    weights = bucket_weights(cat, groups, tags)
    queues = []
    for b in groups:
        b = list(b)
        rng.shuffle(b)
        queues.append(b)
    taken = [0] * len(queues)
    out = []
    for _ in range(length):
        k = min(range(len(queues)), key=lambda k: (taken[k] + rng.random()) / weights[k])
        out.append(queues[k][taken[k] % len(queues[k])])
        taken[k] += 1
    return out


def everything_stream(ids, rng, length):
    """The Everything daily: whole top-level categories take turns by their TOP_SHARE, so the sprinkle of sport
    or music is spread evenly (never three on one day), and inside each category its own sub-categories
    (football, darts, tennis...) take turns as well."""
    fams = sorted({top_of(i) for i in ids})
    total = sum(TOP_SHARE.get(f, 1.0) for f in fams)
    queues = {}
    for f in fams:
        mine = [i for i in ids if top_of(i) == f]
        need = int(length * TOP_SHARE.get(f, 1.0) / total * 1.5) + 10
        queues[f] = balanced_stream(f, [], mine, random.Random(f"{rng.random()}"), need)
    taken = dict.fromkeys(fams, 0)
    out = []
    for _ in range(length):
        f = min(fams, key=lambda f: (taken[f] + rng.random() * .5) / TOP_SHARE.get(f, 1.0))
        q = queues[f]
        out.append(q[taken[f] % len(q)])
        taken[f] += 1
    return out


def daily_ok(pid, cat):
    """Is this question easy enough for a daily? Unrated questions are left out once ratings exist."""
    score = EASE.get(pid.split("--")[0], 0)
    need = 5 if cat == "all" else 3   # Everything: only questions almost anyone can answer
    if ONE_THING.search(PROMPTS[pid]["text"]) or ONE_NAME.search(PROMPTS[pid]["text"]):
        need += 1   # one artist or one show: only the very famous ones
    return score >= need


def daily_pool(cat, day):
    # Only days that get pinned now (today on) drop retired prompts: older, never-pinned days are worked out again
    # for the leaderboards and must come out as they did then.
    ids = pool(cat, [], retired=day < datetime.date.today() - datetime.timedelta(days=1))
    if day < EASY_FROM or not EASE:
        return ids
    easy = [i for i in ids if daily_ok(i, cat)]
    return easy if len(easy) >= 5 * DAILY_N else ids   # a tiny category keeps everything rather than repeating a handful


@functools.lru_cache(maxsize=64)
def daily_ids(cat, day):
    """Today's prompt ids for a category. Worked out once per day and pinned in the database, so a deploy that adds
    prompts mid-day can't reshuffle a daily people are already playing (or split its leaderboard)."""
    key = (cat, day.isoformat())
    row = DB.execute("SELECT ids FROM daily_pins WHERE cat = ? AND day = ?", key).fetchone() if DB else None
    if row:
        pinned = tuple(i for i in row[0].split(",") if i in PROMPTS)
        if len(pinned) == len(row[0].split(",")):   # every prompt still exists; otherwise pick afresh
            return pinned
    todays = pick_daily(cat, day)
    if DB and day >= datetime.date.today() - datetime.timedelta(days=1):
        DB.execute("INSERT OR REPLACE INTO daily_pins VALUES (?, ?, ?)", (*key, ",".join(todays)))
        DB.commit()
    return todays


def pick_daily(cat, day):
    ids = daily_pool(cat, day)
    n = min(DAILY_N, len(ids))
    cycle, idx = divmod(day.toordinal(), max(1, len(ids) // n))
    rng = random.Random(f"outlier-{cat}-{cycle}")
    if day < STREAM_FROM:
        return tuple(balanced_order(cat, [], ids, rng)[idx * n:(idx + 1) * n])
    stream = everything_stream(ids, rng, (idx + 1) * n) if cat == "all" else balanced_stream(cat, [], ids, rng, (idx + 1) * n)
    todays = []
    for i in stream[idx * n:] + [j for j in ids if j not in stream[idx * n:]]:   # a small category wrapping inside one day can't repeat a prompt
        if i not in todays:
            todays.append(i)
    if day >= TEAMS_FROM:
        return tuple(one_per_team(todays, n))
    return tuple(todays[:n])


def pick_balanced(cat, tags, ids, seen, n):
    """Up to n prompts spread across the chosen filters (or categories); within each, unseen prompts
    first and then the ones seen longest ago (seen is oldest first)."""
    groups = buckets(cat, tags, ids)
    weights = bucket_weights(cat, groups, tags)
    # Decade versions ("...number 14 in the 1990s") are the same question as the main one: seeing one counts as
    # seeing them all, and a game never has two of them.
    last = {}
    for pos, s in enumerate(seen):
        last[s.split("--")[0]] = pos
    order = []
    for b in groups:
        fresh = [i for i in b if i.split("--")[0] not in last]
        random.shuffle(fresh)
        order.append(fresh + sorted((i for i in b if i.split("--")[0] in last), key=lambda i: last[i.split("--")[0]]))
    taken = [0] * len(order)
    picked, bases, kinds, spare, clubs = [], set(), {}, [], set()

    def fits(i):
        k = kind_of(i)
        return (i.split("--")[0] not in bases and not (k and kinds.get(k, 0) >= KIND_CAP)
                and not (teams_of(i) & clubs))

    while len(picked) < n and any(order):
        # The filter furthest below its fair share goes next; the random nudge lets bigger ones win ties more often.
        live = [k for k in range(len(order)) if order[k]]
        k = min(live, key=lambda k: (taken[k] + random.random()) / weights[k])
        b = order[k]
        while b and not fits(b[0]):
            spare.append(b.pop(0))
        if b:
            i = b.pop(0)
            picked.append(i)
            bases.add(i.split("--")[0])
            clubs.update(teams_of(i))
            if kind_of(i):
                kinds[kind_of(i)] = kinds.get(kind_of(i), 0) + 1
            taken[k] += 1
    # A narrow pick (only shirt numbers, or one club's filter) still fills the game: first with prompts about a team
    # not used yet, then with anything left.
    for strict in (True, False):
        for i in spare:
            if len(picked) >= n:
                break
            if i not in picked and i.split("--")[0] not in bases and not (strict and teams_of(i) & clubs):
                picked.append(i)
                bases.add(i.split("--")[0])
                clubs.update(teams_of(i))
    random.shuffle(picked)
    return picked


def one_per_team(ids, n):
    """The first n of ids, skipping any prompt about a club or national team already in; skipped ones fill any gap."""
    out, clubs, later = [], set(), []
    for i in ids:
        if len(out) >= n:
            break
        if teams_of(i) & clubs:
            later.append(i)
            continue
        out.append(i)
        clubs.update(teams_of(i))
    return out + later[:n - len(out)]


# Question "kinds" that look alike from one round to the next (Name a Premier League number 14 / number 7 /
# a Chelsea number 9...): a game gets at most one of each kind, so they come up as a sprinkle, not a run.
KIND_CAP = 1
KINDS = [("shirt", re.compile(r"\bnumber (\d+)\b(?! of)", re.I))]


# Football prompts about the same team ("a Liverpool player from their 2019-20 title season", "a Liverpool player in
# the 2019 Champions League final") feel like a repeat, so a game takes one prompt per club or national team.
# A prompt naming two teams (a final, "played for both...") counts for both.
_T = lambda *names: re.compile(r"\b(?:" + "|".join(names) + r")\b")
FOOTBALL_TEAMS = [
    ("man-utd", _T("Man Utd", "Manchester United", "Man United")), ("man-city", _T("Man City", "Manchester City")),
    ("liverpool", _T("Liverpool")), ("chelsea", _T("Chelsea")), ("arsenal", _T("Arsenal")),
    ("spurs", _T("Spurs", "Tottenham")), ("everton", _T("Everton")), ("newcastle", _T("Newcastle")),
    ("villa", _T("Aston Villa", "Villa")), ("west-ham", _T("West Ham")), ("leeds", _T("Leeds")),
    ("leicester", _T("Leicester")), ("celtic", _T("Celtic")), ("rangers", re.compile(r"(?<!Queens Park )(?<!Park )\bRangers\b")),
    ("blackburn", _T("Blackburn")), ("forest", _T("Nottingham Forest", "Forest")), ("derby", _T("Derby")),
    ("southampton", _T("Southampton")), ("sunderland", _T("Sunderland")), ("wolves", _T("Wolves", "Wolverhampton")),
    ("palace", _T("Crystal Palace")), ("middlesbrough", _T("Middlesbrough")), ("fulham", _T("Fulham")),
    ("brighton", _T("Brighton")), ("bolton", _T("Bolton")), ("hearts", _T("Hearts")), ("hibs", _T("Hibs", "Hibernian")),
    ("aberdeen", _T("Aberdeen")), ("barcelona", _T("Barcelona", "Barça")), ("real-madrid", re.compile(r"Real(?! Betis| Sociedad| Valladolid| Zaragoza| Mallorca| Oviedo)")),
    ("atletico", _T("Atlético", "Atletico")), ("bayern", _T("Bayern")), ("dortmund", _T("Dortmund")),
    ("juventus", _T("Juventus")), ("ac-milan", _T("AC Milan")), ("inter", _T("Inter Milan", "Inter")),
    ("psg", _T("PSG", "Paris Saint-Germain")), ("ajax", _T("Ajax")), ("porto", _T("Porto")), ("benfica", _T("Benfica")),
    ("england", _T("England", "England's")), ("scotland", _T("Scotland", "Scotland's")), ("wales", _T("Wales", "Wales's")),
    ("brazil", _T("Brazil", "Brazil's")), ("argentina", _T("Argentina", "Argentina's")), ("germany", _T("Germany", "Germany's")),
    ("france", _T("France", "France's")), ("spain", _T("Spain", "Spain's")), ("italy", _T("Italy", "Italy's")),
    ("portugal", _T("Portugal", "Portugal's")), ("netherlands", _T("Netherlands", "Netherlands'")),
]
NBA_TEAMS = [(k.lower().replace(" ", "-"), _T(k)) for k in (
    "Lakers", "Celtics", "Bulls", "Warriors", "Knicks", "Heat", "Spurs", "Pistons", "Rockets", "76ers", "Sixers",
    "Mavericks", "Suns", "Cavaliers", "Thunder", "Nets", "Clippers", "Jazz", "Trail Blazers", "Bucks", "Nuggets",
    "Raptors", "Hawks", "Kings", "Magic", "Pacers", "Timberwolves", "Pelicans", "Grizzlies", "Hornets", "Wizards")]


@functools.lru_cache(maxsize=None)
def teams_of(pid):
    p = PROMPTS[pid]
    table = FOOTBALL_TEAMS if p["cat"] == "football" else NBA_TEAMS if p["cat"] == "nba" else ()
    return frozenset(key for key, rx in table if rx.search(p["text"]))


def kind_of(pid):
    p = PROMPTS[pid]
    if p["cat"] not in ("football", "nba", "sport"):
        return None
    for name, rx in KINDS:
        if rx.search(p["text"]):
            return name
    return None


def categories():
    every = pool("all", [])
    out = [{"id": "all", "label": "Everything", "count": len(every), "big": sum(map(potato_ok, every)), "filters": []}]
    for c in CATS:
        ids = pool(c["id"], [])
        # "big" counts only prompts long enough for Fumble; "~small" marks the rest, so the party lobby can leave them out
        out.append({"id": c["id"], "label": c["label"], "count": len(ids), "parent": c["parent"],
                    "big": sum(map(potato_ok, ids)),
                    "tagsets": [p["tags"] + (["~deep"] if p["deep"] else []) + ([f'~only:{p["era_only"]}'] if p["era_only"] else [])
                                + ([f'~cat:{p["cat"]}'] if p["cat"] != c["id"] else [])
                                + ([] if len(p["names"]) >= POTATO_FLOOR else ["~small"])
                                for p in PROMPTS.values() if in_cat(p["cat"], c["id"])], "filters": [
            {"label": g["label"], "tags": [
                {"id": t["id"], "label": t["label"], "count": len(pool(c["id"], [t["id"]])),
                 "big": sum(map(potato_ok, pool(c["id"], [t["id"]])))} for t in g["tags"]]}
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
    todays = daily_ids(cat, today)
    return {"date": today.isoformat(), "number": (today - LAUNCH).days + 1, "cat": cat,
            "label": describe(cat, []), "roundMs": ROUND_S * 1000,
            "seed": "".join(code_for(i) for i in todays),   # the day's leaderboard is keyed by this
            "prompts": [public_prompt(i) for i in todays]}


def archive_days():
    """Every Daily seven · Everything before today, newest first (today's is on the main menu)."""
    today = datetime.date.today()
    return [{"day": d.isoformat(), "number": (d - LAUNCH).days + 1}
            for d in (today - datetime.timedelta(days=i) for i in range(1, (today - LAUNCH).days + 1))]


def past_daily(date):
    """A past Daily seven · Everything, for the archive (a Plus perk). Uses the very seven the day's leaderboard is keyed
    by (everything_seed: the pin, or the same fallback the boards use) and never pins anything new."""
    try:
        day = datetime.date.fromisoformat(str(date))
    except ValueError:
        raise ApiError(400, "Bad date")
    if not LAUNCH <= day < datetime.date.today():
        raise ApiError(404, "No archive daily for that day")
    if PAYWALL and not is_plus(current_user()):
        raise ApiError(402, "Past dailies are part of Outlier Plus")
    seed = everything_seed(day)
    ids = [CODES[seed[i:i + 4]] for i in range(0, len(seed), 4) if seed[i:i + 4] in CODES]
    if not ids:
        raise ApiError(404, "That day's prompts are no longer available")
    return {"date": day.isoformat(), "number": (day - LAUNCH).days + 1, "cat": "all",
            "label": describe("all", []), "roundMs": ROUND_S * 1000, "seed": seed, "archive": True,
            "prompts": [public_prompt(i) for i in ids]}


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


def clean_seed(seed):
    seed = re.sub(r"[^0-9A-Za-z]", "", str(seed or ""))
    parts = [seed[i:i + 4] for i in range(0, len(seed), 4)]
    if not parts or len(parts) > 20 or any(len(p) != 4 or p not in CODES for p in parts):
        raise ApiError(404, "That seed doesn't match any game")
    return seed


BOARD_MAX = 300   # scores kept per challenge seed


def post_score(body):
    """A finished seeded game: one row per (seed, player id). Names can be changed; a better score replaces a worse one."""
    seed = clean_seed(body.get("seed"))
    cid = re.sub(r"[^0-9A-Za-z]", "", str(body.get("cid") or ""))[:32]
    pts = body.get("points")
    if len(cid) < 8 or not isinstance(pts, list) or len(pts) != len(seed) // 4:
        raise ApiError(400, "Bad score")
    try:
        pts = [max(0, min(150, int(x))) for x in pts]
    except (TypeError, ValueError):
        raise ApiError(400, "Bad score")
    if seed in past_daily_seeds():   # an archive replay must not land on that day's (or the week's / all-time) board
        raise ApiError(403, "Past dailies don't count for the leaderboard")
    name = " ".join(str(body.get("name") or "").split())[:16] or "Player"
    if body.get("name"):   # keep league boards in step with the name on the public one
        DB.execute("UPDATE league_members SET name = ? WHERE cid = ?", (league_player(name), cid))
    total = sum(pts)
    row = DB.execute("SELECT total FROM scores WHERE seed = ? AND cid = ?", (seed, cid)).fetchone()
    if row is None:
        if DB.execute("SELECT COUNT(*) FROM scores WHERE seed = ?", (seed,)).fetchone()[0] >= BOARD_MAX:
            return board_out(seed, cid)
        DB.execute("INSERT INTO scores VALUES (?, ?, ?, ?, ?, ?)",
                   (seed, cid, name, total, ".".join(map(str, pts)), int(time.time())))
    elif total > row[0]:
        DB.execute("UPDATE scores SET name = ?, total = ?, pts = ?, ts = ? WHERE seed = ? AND cid = ?",
                   (name, total, ".".join(map(str, pts)), int(time.time()), seed, cid))
    else:
        DB.execute("UPDATE scores SET name = ? WHERE seed = ? AND cid = ?", (name, seed, cid))
    DB.commit()
    return board_out(seed, cid)


def cast_vote(body):
    """Thumbs up (1) or down (-1) on a prompt after playing it; 0 takes the vote back. One vote per player id."""
    pid = str(body.get("promptId") or "").split("--")[0]   # era versions count towards the main prompt
    cid = re.sub(r"[^0-9A-Za-z]", "", str(body.get("cid") or ""))[:32]
    if pid not in PROMPTS or len(cid) < 8:
        raise ApiError(400, "Bad vote")
    try:
        vote = max(-1, min(1, int(body.get("vote"))))
    except (TypeError, ValueError):
        raise ApiError(400, "Bad vote")
    if vote:
        DB.execute("INSERT INTO votes VALUES (?, ?, ?, ?) ON CONFLICT(prompt_id, cid) DO UPDATE SET vote = excluded.vote, ts = excluded.ts",
                   (pid, cid, vote, int(time.time())))
    else:
        DB.execute("DELETE FROM votes WHERE prompt_id = ? AND cid = ?", (pid, cid))
    DB.commit()
    _RETIRED["at"] = 0   # work the retired set out again on the next game
    return {"ok": True}


def streak_for(uid):
    row = DB.execute("SELECT n, best, last FROM streaks WHERE user_id = ?", (uid,)).fetchone()
    return {"n": row[0], "best": row[1], "last": row[2]} if row else None


def bump_streak(body):
    """A daily finished by a signed-in player: today extends a streak that last moved yesterday, otherwise it starts again.
    A streak built before signing in is carried over once, if the account has none yet."""
    user = current_user()
    if not user:
        raise ApiError(401, "Sign in to keep your streak on your account")
    today = datetime.date.today()
    have = streak_for(user["id"])
    carry = body.get("carry") or {}
    if not have and isinstance(carry, dict) and str(carry.get("last") or "") in (today.isoformat(), (today - datetime.timedelta(days=1)).isoformat()):
        try:
            have = {"n": max(0, min(10000, int(carry.get("n") or 0))), "best": max(0, min(10000, int(carry.get("best") or 0))), "last": carry["last"]}
        except (TypeError, ValueError):
            have = None
    n, best, last = (have["n"], have["best"], have["last"]) if have else (0, 0, "")
    if body.get("played"):
        if last != today.isoformat():
            n = n + 1 if last == (today - datetime.timedelta(days=1)).isoformat() else 1
            last = today.isoformat()
    best = max(best, n)
    DB.execute("INSERT INTO streaks VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET n = excluded.n, best = excluded.best, last = excluded.last",
               (user["id"], n, best, last))
    DB.commit()
    return {"n": n, "best": best, "last": last}


def board_out(seed, cid="", size=10, members=None):
    """members: {cid: name} keeps only a league's players, under their league names."""
    seed = clean_seed(seed)
    rows = DB.execute("SELECT cid, name, total FROM scores WHERE seed = ? ORDER BY total DESC, ts ASC", (seed,)).fetchall()
    if members is not None:
        rows = [(c, members[c], t) for c, n, t in rows if c in members]
    top = [{"name": n, "total": t, "me": c == cid} for c, n, t in rows[:size]]
    mine = next((i for i, r in enumerate(rows) if r[0] == cid), None)
    if mine is not None and mine >= size:
        top.append({"name": rows[mine][1], "total": rows[mine][2], "me": True, "rank": mine + 1})
    return {"seed": seed, "count": len(rows), "top": top, "rank": mine + 1 if mine is not None else None}


def boards_out(seeds, cid):
    """Your challenges at a glance: for each seed, how many have played, who leads and where you stand."""
    out = []
    for seed in str(seeds).split(",")[:40]:
        try:
            seed = clean_seed(seed)
        except ApiError:
            continue
        rows = DB.execute("SELECT cid, name, total FROM scores WHERE seed = ? ORDER BY total DESC, ts ASC", (seed,)).fetchall()
        mine = next((i for i, r in enumerate(rows) if r[0] == cid), None)
        out.append({"seed": seed, "count": len(rows), "rank": mine + 1 if mine is not None else None,
                    "lead": {"name": rows[0][1], "total": rows[0][2], "me": rows[0][0] == cid} if rows else None})
    return out


_PAST_SEEDS = {}


def everything_seed(day):
    """The seed of the Everything daily on a past or present day, without pinning anything new. Days from before
    pinning existed are worked out again (and cached); they match as long as the prompt pool hasn't moved since."""
    row = DB.execute("SELECT ids FROM daily_pins WHERE cat = 'all' AND day = ?", (day.isoformat(),)).fetchone()
    if row:
        return "".join(code_for(i) for i in row[0].split(",") if i in PROMPTS)
    if day == datetime.date.today():
        return "".join(code_for(i) for i in daily_ids("all", day))
    if day not in _PAST_SEEDS:
        _PAST_SEEDS[day] = "".join(code_for(i) for i in pick_daily("all", day))
    return _PAST_SEEDS[day]


_PAST_DAILY = {"key": None, "seeds": frozenset()}
SCORE_GRACE_S = 3600   # a daily started before midnight can still post its score for this long into the next day


def past_daily_seeds():
    """Seeds that were a daily on an earlier day (and aren't also one today): any category's pins, plus the Everything
    daily of every day since LAUNCH (from before pinning existed too, the same way the leaderboards work them out)."""
    now = datetime.datetime.now()
    today = now.date()
    open_days = {today.isoformat()}
    if (now - datetime.datetime.combine(today, datetime.time())).total_seconds() < SCORE_GRACE_S:
        open_days.add((today - datetime.timedelta(days=1)).isoformat())
    key = (DB.execute("SELECT COUNT(*) FROM daily_pins").fetchone()[0], tuple(sorted(open_days)))
    if _PAST_DAILY["key"] != key:
        past, live = set(), set()
        for day, ids in DB.execute("SELECT day, ids FROM daily_pins"):
            (live if day in open_days else past).add("".join(code_for(i) for i in ids.split(",")))
        for n in range((today - LAUNCH).days):
            d = LAUNCH + datetime.timedelta(days=n)
            (live if d.isoformat() in open_days else past).add(everything_seed(d))
        _PAST_DAILY.update(key=key, seeds=frozenset(past - live - {""}))
    return _PAST_DAILY["seeds"]


def period_board(days, cid, best, size=25, members=None):
    """The Daily seven · Everything over several days. best=False adds up each player's days (this week);
    best=True keeps each player's single best day (all time). members: {cid: name} as in board_out."""
    seeds = {}
    for d in days:
        seeds.setdefault(everything_seed(d), d)
    seeds.pop("", None)
    if not seeds:
        return {"count": 0, "top": [], "rank": None}
    marks = ",".join("?" * len(seeds))
    rows = DB.execute(f"SELECT seed, cid, name, total, ts FROM scores WHERE seed IN ({marks})", tuple(seeds)).fetchall()
    if members is not None:
        rows = [(s, c, members[c], t, ts) for s, c, n, t, ts in rows if c in members]
    per = {}
    for seed, c, name, total, ts in rows:
        p = per.setdefault(c, {"name": name, "total": 0, "days": 0, "ts": ts, "last": 0, "day": None})
        if ts >= p["last"]:   # the latest name a player used
            p["name"], p["last"] = name, ts
        p["days"] += 1
        if best:
            if total > p["total"] or (total == p["total"] and ts < p["ts"]):
                p["total"], p["ts"], p["day"] = total, ts, seeds[seed].isoformat()
        else:
            p["total"] += total
            p["ts"] = max(p["ts"], ts)
    order = sorted(per.items(), key=lambda kv: (-kv[1]["total"], kv[1]["ts"]))
    out = lambda c, p: {"name": p["name"], "total": p["total"], "me": c == cid, "days": p["days"], "day": p["day"]}
    top = [out(c, p) for c, p in order[:size]]
    mine = next((i for i, (c, _) in enumerate(order) if c == cid), None)
    if mine is not None and mine >= size:
        top.append({**out(*order[mine]), "rank": mine + 1})
    return {"count": len(order), "top": top, "rank": mine + 1 if mine is not None else None}


def daily_board(period, cid, size=25, members=None):
    """The Daily seven · Everything board for today, this week (Monday on) or all time; members narrows it to a league."""
    today = datetime.date.today()
    if period == "week":
        monday = today - datetime.timedelta(days=today.weekday())
        board = period_board([monday + datetime.timedelta(days=i) for i in range((today - monday).days + 1)], cid, False, size, members)
        return {**board, "period": "week", "from": monday.isoformat(), "date": today.isoformat()}
    if period == "all":
        board = period_board([LAUNCH + datetime.timedelta(days=i) for i in range((today - LAUNCH).days + 1)], cid, True, size, members)
        return {**board, "period": "all", "from": LAUNCH.isoformat(), "date": today.isoformat()}
    board = board_out(today_seed(), cid, size, members)
    return {**board, "period": "today", "date": today.isoformat(), "number": (today - LAUNCH).days + 1}


def today_seed():
    return "".join(code_for(i) for i in daily_ids("all", datetime.date.today()))


# ---------------------------------------------------------------- friends leagues

LEAGUE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"   # no 0/O, 1/I/L: codes get read out and typed
LEAGUE_MAX = 50        # members per league
LEAGUES_PER_CID = 10   # leagues one player can be in


def clean_text(s, n):
    s = "".join(ch for ch in str(s or "") if unicodedata.category(ch)[0] != "C")   # no control or invisible characters
    return " ".join(s.split())[:n].strip()


def league_player(name):
    return clean_text(name, 16) or "Player"


def league_code(code):
    return re.sub(r"[^0-9A-Za-z]", "", str(code or "")).upper()[:6]


def league_row(code):
    row = DB.execute("SELECT code, name, owner_cid FROM leagues WHERE code = ?", (league_code(code),)).fetchone()
    if not row:
        raise ApiError(404, "That league doesn't exist (or everyone has left it)")
    return row


def league_cid(body):
    cid = clean_cid(body.get("cid"))
    if len(cid) < 8:
        raise ApiError(400, "Bad player id")
    return cid


def league_members(code):
    return DB.execute("SELECT cid, name FROM league_members WHERE code = ? ORDER BY joined, rowid", (code,)).fetchall()


def league_room(cid):
    if DB.execute("SELECT COUNT(*) FROM league_members WHERE cid = ?", (cid,)).fetchone()[0] >= LEAGUES_PER_CID:
        raise ApiError(400, f"You're in {LEAGUES_PER_CID} leagues already. Leave one to join another.")


def league_create(body):
    cid = league_cid(body)
    name = clean_text(body.get("name"), 30)
    if not name:
        raise ApiError(400, "Give your league a name")
    league_room(cid)
    while True:
        code = "".join(secrets.choice(LEAGUE_ALPHABET) for _ in range(6))
        if not DB.execute("SELECT 1 FROM leagues WHERE code = ?", (code,)).fetchone():
            break
    now = int(time.time())
    DB.execute("INSERT INTO leagues VALUES (?, ?, ?, ?)", (code, name, cid, now))
    DB.execute("INSERT INTO league_members VALUES (?, ?, ?, ?)", (code, cid, league_player(body.get("you")), now))
    DB.commit()
    return {"code": code, "name": name}


def league_join(body):
    cid = league_cid(body)
    code, name, _ = league_row(body.get("code"))
    you = league_player(body.get("you"))
    if DB.execute("SELECT 1 FROM league_members WHERE code = ? AND cid = ?", (code, cid)).fetchone():
        DB.execute("UPDATE league_members SET name = ? WHERE code = ? AND cid = ?", (you, code, cid))
    else:
        league_room(cid)
        if len(league_members(code)) >= LEAGUE_MAX:
            raise ApiError(400, f"That league is full ({LEAGUE_MAX} players)")
        DB.execute("INSERT INTO league_members VALUES (?, ?, ?, ?)", (code, cid, you, int(time.time())))
    DB.commit()
    return {"code": code, "name": name}


def league_leave(body):
    """The owner leaving hands the league to whoever joined first after them; the last one out deletes it."""
    cid = league_cid(body)
    code, _, owner = league_row(body.get("code"))
    DB.execute("DELETE FROM league_members WHERE code = ? AND cid = ?", (code, cid))
    left = league_members(code)
    if not left:
        DB.execute("DELETE FROM leagues WHERE code = ?", (code,))
    elif owner == cid:
        DB.execute("UPDATE leagues SET owner_cid = ? WHERE code = ?", (left[0][0], code))
    DB.commit()
    return {"ok": True}


def league_rename(body):
    cid = league_cid(body)
    code, _, owner = league_row(body.get("code"))
    if owner != cid:
        raise ApiError(403, "Only the league's owner can rename it")
    name = clean_text(body.get("name"), 30)
    if not name:
        raise ApiError(400, "Give your league a name")
    DB.execute("UPDATE leagues SET name = ? WHERE code = ?", (name, code))
    DB.commit()
    return {"code": code, "name": name}


def leagues_mine(q):
    """Your leagues, with where you are on each one's board today (for the daily results screen)."""
    cid = clean_cid(q.get("cid"))
    rows = DB.execute("SELECT l.code, l.name, l.owner_cid FROM league_members m JOIN leagues l ON l.code = m.code "
                      "WHERE m.cid = ? ORDER BY m.joined", (cid,)).fetchall() if cid else []
    if not rows:
        return []
    today = dict(DB.execute("SELECT cid, total FROM scores WHERE seed = ?", (today_seed(),)).fetchall())
    out = []
    for code, name, owner in rows:
        mem = [c for c, _ in league_members(code)]
        played = [today[c] for c in mem if c in today]
        rank = 1 + sum(1 for t in played if t > today[cid]) if cid in today else None
        out.append({"code": code, "name": name, "members": len(mem), "owner": owner == cid, "rank": rank, "played": len(played)})
    return out


def league_board(q):
    """A league's own board. Someone who isn't in it (yet) only sees its name and size, for the join screen."""
    cid = clean_cid(q.get("cid"))
    code, name, owner = league_row(q.get("code"))
    mem = league_members(code)
    head = {"code": code, "name": name, "size": len(mem), "max": LEAGUE_MAX}
    names = dict(mem)
    if cid not in names:
        return {**head, "member": False}
    board = daily_board(q.get("period", "today"), cid, LEAGUE_MAX, names)
    if board["period"] == "today":   # who has yet to play today, listed under the board
        played = {c for (c,) in DB.execute("SELECT cid FROM scores WHERE seed = ?", (board["seed"],))}
        members = [{"name": n, "me": c == cid, "played": c in played} for c, n in mem]
    else:
        members = [{"name": n, "me": c == cid} for c, n in mem]
    return {**board, **head, "member": True, "owner": owner == cid, "members": members}


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
    if len(room["players"]) >= room.get("cap", PLUS_ROOM):
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
                              "double_left": True, "doubling": False, "picked": False, "color": color, "look": None}
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
            "secs": ROUND_S, "history": [], "asks": [], "screens": {}, "setup": None}
    room["cap"] = PLUS_ROOM if is_plus() else FREE_ROOM   # set by the host's plan
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


# ---- big screens: a TV or laptop showing the game to the room. A screen is a view-only token kept apart from the
# players, so it never counts towards the cap, lock-ins, host handover or results.
SCREEN_TTL = 30   # seconds without a poll before a screen is forgotten
MAX_SCREENS = 4


def live_screens(room):
    now = time.time()
    screens = room.setdefault("screens", {})
    for sid in [s for s, t in screens.items() if now - t > SCREEN_TTL]:
        del screens[sid]
    return screens


def add_screen(room):
    screens = live_screens(room)
    if len(screens) >= MAX_SCREENS:
        raise ApiError(400, "That room already has enough screens")
    sid = secrets.token_hex(8)
    screens[sid] = time.time()
    return sid


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
    # Not a team this game has already had (round 1 starts the game, so only the rounds since count)
    recent = set().union(*(teams_of(i) for i in room["used"][-(room["round"]):] if i in PROMPTS)) if room["round"] else set()
    room["prompt"] = random.choice([i for i in fresh[k] if not teams_of(i) & recent] or fresh[k])
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
                             "shared": r["shared"], "doubled": r["doubled"], "pid": pid} for r in results])
    board = board_for(counts, keep={r["canonical"] for r in results if r["valid"]})
    results.sort(key=lambda r: -r["points"])
    room["reveal"] = {"prompt": PROMPTS[pid]["text"], "results": results, "answers": len(counts),
                      "outliers": [b for b in board if b["outlier"]], "commonest": board[0], "promptId": pid}
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


# ---------------------------------------------------------------- Fumble (party mode; "potato" in the code)
# Players take turns naming an answer to one prompt. A valid answer nobody has given yet passes the turn on;
# running out of time costs a life and brings a new prompt. Out of lives = out; the last player standing wins.
# Every valid answer also earns its usual rarity points, and points earn extra lives: the first at POTATO_BONUS,
# then each one costs POTATO_BONUS more than the last (250, then 500 more, then 750 more...).
POTATO_LIVES = (1, 3, 5)
POTATO_TIMERS = (5, 10, 15)
POTATO_BONUS = 250
POTATO_PAUSE = 3          # seconds to read a new prompt before the clock starts
POTATO_BREAK = 4.5        # the intermission after someone runs out of time: everyone's lives, one heart dropping away
POTATO_MIN_ANSWERS = 30   # prompts with plenty of answers, so a round can go round the table many times...
POTATO_FLOOR = 15         # ...and never one with fewer than this


def potato_ok(pid):
    return len(PROMPTS[pid]["names"]) >= POTATO_FLOOR


def potato_prompt(room):
    ids = [i for i in pool(room["cat"], room["tags"]) if potato_ok(i)]
    big = [i for i in ids if len(PROMPTS[i]["names"]) >= POTATO_MIN_ANSWERS]
    big = big if len(big) >= 10 else ids
    if room["cat"] == "all":   # Everything: questions most people can have a go at
        for need in (5, 4):
            easy = [i for i in big if FUMBLE_EASE.get(i.split("--")[0], 0) >= need]
            if len(easy) >= 40:
                big = easy
                break
        else:
            easy = [i for i in big if EASE.get(i.split("--")[0], 0) >= 5]
            big = easy if len(easy) >= 20 else big
    fresh = [i for i in big if i not in room["used"]] or big
    pid = random.choice(fresh)
    room["used"].append(pid)
    return pid


def potato_alive(room):
    return [t for t in room["order"] if not room["players"][t]["out"]]


def potato_next(room, after):
    """The next player still in, going round the table from `after`."""
    order = room["order"]
    i = order.index(after)
    for k in range(1, len(order) + 1):
        t = order[(i + k) % len(order)]
        if not room["players"][t]["out"]:
            return t
    return after


def potato_round(room, starter, pause=POTATO_PAUSE):
    """A fresh prompt, with `starter` to go first once the pause is over."""
    room["prompt"] = potato_prompt(room)
    room["said"], room["current"] = [], starter
    room["round"] += 1
    potato_turn(room, starter, pause)


def potato_turn(room, token, pause=0.0):
    now = time.time()
    room["current"] = token
    room["turn_id"] += 1
    room["turn_start"] = now + pause
    room["deadline"] = now + pause + room["secs"]


def start_potato(room):
    order = [t for t, p in room["players"].items() if online(p)] or list(room["players"])
    random.shuffle(order)
    for t, p in room["players"].items():
        p.update(score=0, lives=room["lives"] if t in order else 0, out=t not in order, out_at=0,
                 bonus_at=POTATO_BONUS, bonus_step=POTATO_BONUS, double_left=False)
    room.update(phase="potato", round=0, history=[], asks=[], order=order, said=[], log=[], boom=None, turn_id=0,
                ending=False, break_until=0)
    potato_round(room, order[0])


def potato_answer(room, token, raw):
    """The current player's go. Returns a reason it didn't count, or None when it did (and the turn moved on)."""
    if room["phase"] != "potato" or room["current"] != token:
        return "It's not your turn"
    now = time.time()
    if now < room["turn_start"]:
        return "Wait for the clock to start"
    if now > room["deadline"] + GRACE_S:
        return "Too late"
    raw = str(raw or "").strip()[:60]
    if not raw:
        return "Type an answer"
    pid = room["prompt"]
    r = judge(pid, raw)
    if not r["valid"]:
        record(pid, None, raw)
        return "Not on the list"
    if r["canonical"] in room["said"]:
        return f"{r['canonical']} has already been said"
    record(pid, r["canonical"], raw)
    p = room["players"][token]
    p["score"] += r["points"]
    bonus = 0
    while p["score"] >= p["bonus_at"]:
        p["lives"] += 1
        p["bonus_step"] += POTATO_BONUS
        p["bonus_at"] += p["bonus_step"]
        bonus += 1
    room["said"].append(r["canonical"])
    room["log"].append({"n": p["n"], "name": p["name"], "answer": r["canonical"], "points": r["points"],
                        "outlier": r["outlier"], "bonus": bonus, "round": room["round"]})
    potato_turn(room, potato_next(room, token))
    return None


def potato_tick(room):
    now = time.time()
    if room.get("ending"):   # the last intermission plays out, then the results
        if now >= room["break_until"]:
            room["phase"], room["ending"] = "final", False
            room["games"] = room.get("games", 0) + 1
        return
    if now < room["deadline"] + GRACE_S:
        return
    token = room["current"]
    p = room["players"][token]
    p["lives"] -= 1
    if p["lives"] <= 0:
        p["lives"], p["out"], p["out_at"] = 0, True, now
    room["log"].append({"n": p["n"], "name": p["name"], "timeout": True, "out": p["out"], "round": room["round"]})
    room["break_until"] = now + POTATO_BREAK
    alive = potato_alive(room)
    if not alive or (len(room["order"]) > 1 and len(alive) == 1):
        room["ending"] = True
        room["boom"] = {"n": p["n"], "name": p["name"], "out": p["out"], "turn": room["turn_id"], "end": True}
        return
    potato_round(room, potato_next(room, token), POTATO_BREAK + POTATO_PAUSE)   # the next player starts the new prompt
    room["boom"] = {"n": p["n"], "name": p["name"], "out": p["out"], "turn": room["turn_id"]}


def potato_standings(room):
    """Winner first, then whoever lasted longest."""
    players = room["players"]
    return [players[t]["n"] for t in sorted(room["order"], key=lambda t: (players[t]["out"], -players[t]["out_at"],
                                                                         -players[t]["lives"], -players[t]["score"]))]


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
    if room["phase"] == "potato":
        potato_tick(room)


def shared_state(room):
    """Everything about the room that every viewer sees: players' phones and big screens alike."""
    state = {
        "code": room["code"], "phase": room["phase"], "host": room["players"][room["host"]]["n"],
        "round": room["round"], "rounds": room["rounds"], "secs": room["secs"], "doubles": room["cat"] == "all",
        "label": describe(room["cat"], room["tags"]), "screens": len(live_screens(room)),
        "players": [{"n": p["n"], "name": p["name"], "score": p["score"], "online": online(p), "color": p["color"],
                     "look": p.get("look"), "emote": p.get("emote"),
                     "answered": p["answer"] is not None, "picked": p["picked"] or not p["double_left"],
                     "doubleLeft": p["double_left"], "lives": p.get("lives", 0), "out": p.get("out", False),
                     "bonusAt": p.get("bonus_at", POTATO_BONUS), "bonusStep": p.get("bonus_step", POTATO_BONUS)} for p in room["players"].values()],
        "asks": room["asks"], "mode": room.get("mode", "classic"), "game": room.get("games", 0),
    }
    if room.get("mode") == "potato" and room["phase"] in ("potato", "final"):
        now = time.time()
        state.update(lives=room["lives"], bonus=POTATO_BONUS, boom=room.get("boom"),
                     order=[room["players"][t]["n"] for t in room["order"]],
                     log=room["log"][-60:][::-1], standings=potato_standings(room))
        if room["phase"] == "potato":
            state.update(prompt=PROMPTS[room["prompt"]]["text"], promptId=room["prompt"], hint=hint_for(room["prompt"]),
                         current=room["players"][room["current"]]["n"], turnId=room["turn_id"], roundMs=room["secs"] * 1000,
                         startsInMs=max(0, int((room["turn_start"] - now) * 1000)),
                         breakMs=max(0, int((room.get("break_until", 0) - now) * 1000)),
                         remainingMs=max(0, int((room["deadline"] - max(now, room["turn_start"])) * 1000)),
                         said=len(room["said"]))
    left = max(0, int((room["deadline"] - time.time()) * 1000))
    if room["phase"] == "lobby" and room.get("setup"):
        state["setup"] = room["setup"]
    if room["phase"] == "pick":
        state.update(hint=hint_for(room["prompt"]), roundMs=PICK_S * 1000, remainingMs=left)
    if room["phase"] == "question":
        state.update(prompt=PROMPTS[room["prompt"]]["text"], promptId=room["prompt"], hint=hint_for(room["prompt"]),
                     roundMs=room["secs"] * 1000, remainingMs=left)
    if room["phase"] == "reveal":
        state["reveal"] = room["reveal"]
    if room["phase"] == "final":
        state["awards"] = awards_for(room)
    return state


def played_for(room, n):
    """A finished classic game's prompts, in order, with what player n said to each: the end screen's answer list."""
    out = []
    for rnd in room["history"]:
        pid = rnd[0].get("pid") if rnd else None
        if pid not in PROMPTS:
            continue
        mine = next((h for h in rnd if h["n"] == n), None) or {}
        out.append({"promptId": pid, "prompt": PROMPTS[pid]["text"], "answer": mine.get("answer"),
                    "valid": mine.get("valid", False), "points": mine.get("points", 0), "outlier": mine.get("outlier", False),
                    "doubled": mine.get("doubled", False)})
    return out


def room_state(room, token):
    room["players"][token]["last"] = time.time()
    tick(room)
    me = room["players"][token]
    state = shared_state(room)
    state.update(you=me["n"], doubleLeft=me["double_left"], doubling=me["doubling"], picked=me["picked"])
    if room["phase"] == "question":
        state["yourAnswer"] = me["answer"]
    if room["phase"] == "final" and room.get("mode", "classic") == "classic":
        state["played"] = played_for(room, me["n"])
    return state


def screen_state(room, sid):
    """A big screen's view. Its polls also move the game on, so the TV keeps pace even if phones are slow."""
    screens = live_screens(room)
    if sid not in screens:
        raise ApiError(410, "Screen expired")
    screens[sid] = time.time()
    tick(room)
    return {**shared_state(room), "screen": True}


# ---------------------------------------------------------------- the You page: personal stats and badges

BIG_DAY = 500   # a daily total worth a badge: seven answers score 10-99 (150 for an Outlier), so 500 is a cracking day


def party_result(body):
    """A finished party game, posted once by each player's browser from the final screen."""
    cid, code = clean_cid(body.get("cid")), re.sub(r"[^A-Za-z]", "", str(body.get("code") or "")).upper()[:8]
    mode = body.get("mode") if body.get("mode") in ("classic", "potato") else None
    try:
        place, players, rnd = int(body.get("place")), int(body.get("players")), int(body.get("round") or 0)
    except (TypeError, ValueError):
        raise ApiError(400, "Bad result")
    if len(cid) < 8 or not mode or not 1 <= place <= players <= 50:
        raise ApiError(400, "Bad result")
    room = ROOMS.get(code)
    if not room or room["phase"] != "final":   # only from a game that has really just finished
        raise ApiError(404, "Room not found")
    user = current_user()
    DB.execute("INSERT OR IGNORE INTO party_results VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
               (cid, user["id"] if user else None, int(time.time()), mode, place, players, code, rnd))
    DB.commit()
    return {"ok": True}


_DAILY_SEEDS = {"n": -1, "seeds": set()}


def daily_seeds():
    """Every seed that was a daily (pinned) in any category, to tell dailies apart from other seeded games in `scores`."""
    n = DB.execute("SELECT COUNT(*) FROM daily_pins").fetchone()[0]
    if n != _DAILY_SEEDS["n"]:
        _DAILY_SEEDS.update(n=n, seeds={"".join(code_for(i) for i in ids.split(",")) for (ids,) in DB.execute("SELECT ids FROM daily_pins")})
    return _DAILY_SEEDS["seeds"]


def cat_unlocks(plays, cids):
    """What the character items for each main category are unlocked by: right answers and Outliers in it, and the
    best total in a seven-prompt game (quick game, daily or challenge) where every prompt came from it."""
    out = {c["id"]: {"right": 0, "outliers": 0, "best": 0} for c in CATS if not c["parent"]}
    for p in plays:
        if p[2] in out:
            out[p[2]]["right"] += p[4]
            out[p[2]]["outliers"] += p[7]
    if cids:
        for seed, total in DB.execute(f"SELECT seed, total FROM scores WHERE cid IN ({','.join('?' * len(cids))})", tuple(cids)):
            ids = [CODES.get(seed[i:i + 4]) for i in range(0, len(seed), 4)]
            if len(ids) < 7 or not all(i in PROMPTS for i in ids):
                continue
            cats = {parent_of(PROMPTS[i]["cat"]) or PROMPTS[i]["cat"] for i in ids}
            if len(cats) == 1 and (c := cats.pop()) in out:
                out[c]["best"] = max(out[c]["best"], total)
    return out


def my_stats(q):
    cid, user = clean_cid(q.get("cid")), current_user()
    uid = user["id"] if user else -1
    # This browser, plus (signed in) every browser the account has played on
    cids = {cid} if cid else set()
    if user:
        cids |= {c for (c,) in DB.execute("SELECT DISTINCT cid FROM cid_plays WHERE user_id = ? AND cid != ''", (uid,))}
    if not cids and not user:
        raise ApiError(400, "No player id")
    marks = ",".join("?" * len(cids)) or "''"
    # answers and party games: everything from this browser, plus anything played signed in to this account elsewhere
    # (not other people's games on a shared browser); daily scores have no account, so they come from all its browsers
    who, args = "(cid = ? OR user_id = ?)", (cid, uid)
    plays = DB.execute(f"SELECT ts, prompt_id, cat, answer, valid, points, share, outlier FROM cid_plays WHERE {who} ORDER BY ts", args).fetchall()
    dseeds = daily_seeds()
    dailies = [(t, ts, [int(x) for x in pts.split(".") if x]) for s, t, pts, ts in
               DB.execute(f"SELECT seed, total, pts, ts FROM scores WHERE cid IN ({marks}) ORDER BY ts", tuple(cids)) if s in dseeds]
    party = DB.execute(f"SELECT ts, place FROM party_results WHERE {who} ORDER BY ts", args).fetchall()

    valid = [p for p in plays if p[4]]
    outs = [p for p in plays if p[7]]
    rare = min(valid, key=lambda p: (p[6], p[0]), default=None)
    wins = [p for p in party if p[1] == 1]
    try:
        streak = max(0, min(10000, int(q.get("streak") or 0)))   # the browser's best streak
    except ValueError:
        streak = 0
    if user:
        s = streak_for(uid)
        streak = max(streak, s["best"] if s else 0)
    tops = [c for c in CATS if not c["parent"] and pool(c["id"], [])]
    first_right = {}
    for p in valid:
        first_right.setdefault(p[2], p[0])
    perfect = [d for d in dailies if len(d[2]) == 7 and all(x > 0 for x in d[2])]
    big = [d for d in dailies if d[0] >= BIG_DAY]

    def nth(rows, n):   # when the nth qualifying row happened
        return rows[n - 1][0] if len(rows) >= n else None

    def count(id, name, desc, icon, rows, n, at=0):
        return {"id": id, "name": name, "desc": desc, "icon": icon, "earned": len(rows) >= n,
                "progress": f"{min(len(rows), n)}/{n}", "earnedAt": nth([(r[at],) for r in rows], n)}

    def streak_badge(n, name, desc):
        return {"id": f"streak{n}", "name": name, "desc": desc, "icon": "flame", "earned": streak >= n,
                "progress": f"{min(streak, n)}/{n}", "earnedAt": None}

    got = [c for c in tops if c["id"] in first_right]
    badges = [
        count("first", "Off the mark", "Give your first answer", "play", plays, 1),
        count("outlier1", "Lone wolf", "Find your first Outlier", "crosshair", outs, 1),
        count("outlier10", "Off the beaten track", "Find 10 Outliers", "sparkles", outs, 10),
        count("outlier50", "Proper oddball", "Find 50 Outliers", "gem", outs, 50),
        count("under1", "Needle in a haystack", "A right answer that under 1% of people gave", "zap", [p for p in valid if p[6] < 1], 1),
        count("century", "Ton up", "100 right answers", "check", valid, 100),
        count("regular", "Regular", "Play 10 dailies", "calendar", dailies, 10, 1),
        count("perfect", "Clean sheet", "A daily with all seven answers right", "shield", perfect, 1, 1),
        count("bigday", "Absolute scenes", f"Score {BIG_DAY}+ in a daily", "star", big, 1, 1),
        streak_badge(3, "Hat-trick", "A 3-day daily streak"),
        streak_badge(7, "Week in, week out", "A 7-day daily streak"),
        streak_badge(30, "Creature of habit", "A 30-day daily streak"),
        count("partywin", "Life and soul", "Win a party game", "trophy", wins, 1),
        count("party10", "Party animal", "Play 10 party games", "users", party, 10),
        {"id": "allround", "name": "Jack of all trades", "desc": "A right answer in every main category", "icon": "globe",
         "earned": bool(tops) and len(got) == len(tops), "progress": f"{len(got)}/{len(tops)}",
         "earnedAt": max((first_right[c["id"]] for c in got), default=None) if tops and len(got) == len(tops) else None},
    ]
    out = {
        "headline": {
            "answers": len(plays), "correct": len(valid),
            "correctPct": round(100 * len(valid) / len(plays)) if plays else 0,
            "outliers": len(outs),
            "rarest": {"answer": rare[3], "share": rare[6], "prompt": PROMPTS[rare[1]]["text"] if rare[1] in PROMPTS else "",
                       "points": rare[5], "outlier": bool(rare[7])} if rare else None,
            "avgPoints": round(sum(p[5] for p in plays) / len(plays), 1) if plays else 0,
            "dailies": len(dailies), "bestDaily": max((d[0] for d in dailies), default=0),
            "parties": len(party), "partyWins": len(wins), "streakBest": streak,
        },
        "badges": badges,
        "plus": is_plus(user),
        "unlocks": cat_unlocks(plays, cids),
    }
    if not out["plus"]:
        out.update(categories={"locked": True}, recent={"locked": True})
        return out
    by = {}
    for p in plays:
        by.setdefault(p[2], []).append(p)
    out["categories"] = [{"id": c["id"], "label": c["label"], "answers": len(by.get(c["id"], [])),
                          "correctPct": round(100 * sum(p[4] for p in by[c["id"]]) / len(by[c["id"]])) if by.get(c["id"]) else 0,
                          "avgPoints": round(sum(p[5] for p in by[c["id"]]) / len(by[c["id"]]), 1) if by.get(c["id"]) else 0}
                         for c in tops]
    out["recent"] = [{"ts": p[0], "prompt": PROMPTS[p[1]]["text"] if p[1] in PROMPTS else "", "cat": p[2], "answer": p[3],
                      "valid": bool(p[4]), "points": p[5], "share": p[6], "outlier": bool(p[7])} for p in plays[::-1][:50]]
    return out


# ---------------------------------------------------------------- api

def api_get(path, q):
    if path == "/api/categories":
        return categories()
    if path == "/api/daily":
        if q.get("date"):   # the archive: a past Daily seven · Everything
            if q.get("cat", "all") != "all":
                raise ApiError(400, "The archive only has the Daily seven · Everything")
            return past_daily(q["date"])
        check_daily(q.get("cat", "all"))
        return daily(q.get("cat", "all"))
    if path == "/api/archive":
        return {"days": archive_days(), "today": datetime.date.today().isoformat()}
    if path == "/api/game":
        if q.get("seed"):
            return seeded_game(q["seed"])
        need_plus()
        tags = [t for t in q.get("tags", "").split(",") if t]
        return new_game(q.get("cat", "all"), tags, q.get("exclude", "").split(","))
    if path == "/api/random":
        need_plus()
        tags = [t for t in q.get("tags", "").split(",") if t]
        ids = pool(q.get("cat", "all"), tags)
        if not ids:
            raise ApiError(404, "No prompts match those filters")
        seen = q.get("exclude", "").split(",")   # oldest first
        out = public_prompt(pick_balanced(q.get("cat", "all"), tags, ids, seen, 1)[0])
        out.update(roundMs=ROUND_S * 1000, poolSize=len(ids))
        return out
    if path == "/api/push/key":
        return {"enabled": PUSH, "key": VAPID_PUBLIC if PUSH else ""}
    if path == "/api/me":
        user = current_user()
        claim = None
        if user:
            row = DB.execute("SELECT cat FROM daily_claims WHERE user_id = ? AND day = ?", (user["id"], datetime.date.today().isoformat())).fetchone()
            claim = row[0] if row else None
        return {"user": {"email": "Plus pass" if user["email"].startswith(PASS_PREFIX) else user["email"]} if user else None, "signin": bool(MAIL_KEY or DEV),
                "plus": is_plus(user), "paywall": PAYWALL, "claim": claim,
                "payments": bool(STRIPE_KEY and STRIPE_PRICE), "price": PRICE_LABEL,
                "subscribed": bool(user and sub_status(user["id"]) in LIVE_SUB),
                "streak": streak_for(user["id"]) if user else None, "today": datetime.date.today().isoformat()}
    if path == "/api/stats":
        return stats()
    if path == "/api/me/stats":
        return my_stats(q)
    if path == "/api/dailyboard":   # the Everything daily, for the leaderboard on the main menu: today, this week or all time
        return daily_board(q.get("period", "today"), clean_cid(q.get("cid", "")))
    if path == "/api/league/mine":
        return leagues_mine(q)
    if path == "/api/league/board":
        return league_board(q)
    if path == "/api/answers":   # every answer to one prompt, for the end-of-game answer lists
        pid = q.get("promptId")
        if pid not in PROMPTS:
            raise ApiError(404, "Unknown prompt")
        counts = counts_for(pid)
        return {"promptId": pid, "prompt": PROMPTS[pid]["text"], "total": len(counts), "board": board_for(counts, cap=0)}
    if path == "/api/board":
        try:
            size = max(1, min(int(q.get("size") or 10), 50))
        except ValueError:
            size = 10
        return board_out(q.get("seed"), re.sub(r"[^0-9A-Za-z]", "", q.get("cid", ""))[:32], size)
    if path == "/api/boards":
        return boards_out(q.get("seeds", ""), re.sub(r"[^0-9A-Za-z]", "", q.get("cid", ""))[:32])
    if path == "/api/review/queue":
        try:
            limit = max(1, min(int(q.get("limit") or 300), 1000))
        except ValueError:
            limit = 300
        return review_queue(limit)
    if path == "/api/review/flags":
        return review_flags()
    if path == "/api/room/state":
        room = get_room(q.get("code"), q.get("pid"))
        return room_state(room, q.get("pid"))
    if path == "/api/room/screen/state":
        return screen_state(get_room(q.get("code")), str(q.get("sid") or ""))
    raise ApiError(404, "Not found")


def api_post(path, body):
    if path == "/api/vote":
        return cast_vote(body)
    if path == "/api/streak":
        return bump_streak(body)
    if path == "/api/push/subscribe":
        return push_subscribe(body)
    if path == "/api/push/unsubscribe":
        return push_unsubscribe(body)
    if path == "/api/push/state":
        return push_state(body)
    if path == "/api/push/test":
        return push_test(body)
    if path == "/api/score":
        return post_score(body)
    if path == "/api/party/result":
        return party_result(body)
    if path == "/api/checkout":
        return start_checkout()
    if path == "/api/portal":
        return open_portal()
    if path == "/api/auth/request":
        return request_login(body)
    if path == "/api/auth/code":
        return verify_code(body)
    if path == "/api/auth/verify":
        return verify_login(body)
    if path == "/api/auth/logout":
        return logout()
    if path == "/api/answer":
        pid = body.get("promptId")
        if pid not in PROMPTS:
            raise ApiError(404, "Unknown prompt")
        counts = counts_for(pid)
        out = judge(pid, body.get("answer"), counts)
        out["board"] = board_for(counts, keep=(out["canonical"],))
        out["boardTotal"] = len(counts)
        out["prompt"] = PROMPTS[pid]["text"]
        out["promptId"] = pid
        if out["given"]:
            record(pid, out["canonical"], out["given"])
            cid = clean_cid(body.get("cid"))
            note_play(cid)
            log_play(pid, out, cid)
            DB.commit()
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
    if path == "/api/review/done":
        return review_done(body)
    if path == "/api/review/retire":
        return retire_override(body)
    if path == "/api/league/create":
        return league_create(body)
    if path == "/api/league/join":
        return league_join(body)
    if path == "/api/league/leave":
        return league_leave(body)
    if path == "/api/league/rename":
        return league_rename(body)
    if path == "/api/room/create":
        room, token = create_room(body.get("name"))
        return {"code": room["code"], "pid": token}
    if path == "/api/room/join":
        room = get_room(body.get("code"))
        return {"code": room["code"], "pid": add_player(room, body.get("name"))}
    if path == "/api/room/screen":   # attach a big screen (a TV or laptop) to a room
        room = get_room(body.get("code"))
        return {"code": room["code"], "sid": add_screen(room)}
    if path == "/api/room/screen/leave":   # so phones stop saying a big screen is watching straight away
        live_screens(get_room(body.get("code"))).pop(str(body.get("sid") or ""), None)
        return {"ok": True}

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
    if path == "/api/room/look":   # the player's little character: head, eyes, mouth, hat and face
        look = str(body.get("look") or "")
        if LOOK_RX.fullmatch(look):
            room["players"][token]["look"] = look
        emote = str(body.get("emote") or "")
        if re.fullmatch(r"[a-z]{2,12}", emote):   # what they do on the podium
            room["players"][token]["emote"] = emote
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
    if path == "/api/room/potato":
        miss = potato_answer(room, token, body.get("answer"))
        return {**room_state(room, token), "miss": miss}
    if token != room["host"]:
        raise ApiError(403, "Only the host can do that")
    if path == "/api/room/start":
        if room["phase"] not in ("lobby", "final"):
            raise ApiError(400, "Game already running")
        cat, tags = str(body.get("cat") or "all"), [str(t) for t in body.get("tags") or []][:20]
        if (cat != "all" or tags) and not is_plus():   # free hosts play Everything; choosing categories is Plus
            raise ApiError(402, "Choosing categories for a party is part of Outlier Plus. Free rooms play Everything.")
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
        if body.get("mode") == "potato":
            if not any(potato_ok(i) for i in pool(cat, tags)):
                raise ApiError(400, f"Fumble needs prompts with at least {POTATO_FLOOR} answers. Pick more categories")
            try:
                lives = int(body.get("lives") or 3)
            except (TypeError, ValueError):
                lives = 3
            room.update(mode="potato", cat=cat, tags=tags, lives=lives if lives in POTATO_LIVES else 3,
                        secs=secs if secs in POTATO_TIMERS else 10)
            start_potato(room)
            return room_state(room, token)
        room.update(mode="classic", cat=cat, tags=tags, rounds=max(1, min(rounds, 10, size)), round=0,
                    secs=secs if secs in TIMERS else ROUND_S, history=[], asks=[])
        for p in room["players"].values():
            p["score"], p["double_left"] = 0, True
        next_question(room)
    elif path == "/api/room/rematch":   # same category, rounds, timer and players; fresh scores and new prompts
        if room["phase"] != "final":
            raise ApiError(400, "The game isn't over yet")
        if room.get("mode") == "potato":
            start_potato(room)
            return room_state(room, token)
        room.update(round=0, history=[], asks=[])
        for p in room["players"].values():
            p["score"], p["double_left"] = 0, True
        next_question(room)
    elif path == "/api/room/next":
        sent = body.get("round")   # a repeated tap from the same round must not skip the next one
        if room["phase"] == "reveal" and (sent is None or sent == room["round"]):
            if room["round"] >= room["rounds"]:
                room["phase"] = "final"
                room["games"] = room.get("games", 0) + 1
            else:
                next_question(room)
    elif path == "/api/room/lobby":
        if room["phase"] == "final":
            room["phase"] = "lobby"
    elif path == "/api/room/setup":   # the host's lobby choices, so a big screen can show what's coming
        mode = "potato" if body.get("mode") == "potato" else "classic"
        cat, tags = str(body.get("cat") or "all")[:40], [str(t)[:40] for t in body.get("tags") or []][:20]
        if not is_plus():
            cat, tags = "all", []

        def num(k, ok, fallback):
            try:
                v = int(body.get(k))
            except (TypeError, ValueError):
                return fallback
            return v if v in ok else fallback
        room["setup"] = {"mode": mode, "label": describe(cat, tags), "rounds": num("rounds", (3, 5, 7, 10), 5),
                         "secs": num("secs", POTATO_TIMERS if mode == "potato" else TIMERS, 10 if mode == "potato" else ROUND_S),
                         "lives": num("lives", POTATO_LIVES, 3)}
    else:
        raise ApiError(404, "Not found")
    return room_state(room, token)


class Handler(BaseHTTPRequestHandler):
    server_version = "Outlier"

    def log_message(self, *args):
        pass

    def send_body(self, status, ctype, body, cookie=None, extra=None):
        self.send_response(status)
        if cookie:
            self.send_header("Set-Cookie", cookie)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, status=200, cookie=None):
        self.send_body(status, "application/json", json.dumps(obj).encode(), cookie)

    def run_api(self, fn, *args):
        try:
            with LOCK:
                jar = {k.strip(): v for k, _, v in (p.partition("=") for p in (self.headers.get("Cookie") or "").split(";"))}
                CURRENT["has_cookie"] = bool(jar.get("outlier_session"))
                CURRENT["cookie"] = None
                CURRENT["token"] = ((self.headers.get("X-Session") or "") or jar.get("outlier_session", ""))[:80]
                CURRENT["alt"] = jar.get("outlier_session", "")[:80]
                CURRENT["host"] = (self.headers.get("Host") or "")[:80]
                CURRENT["review"] = (self.headers.get("X-Review-Key") or "")[:200]
                out = fn(*args)
                cookie = CURRENT["cookie"]
            self.send_json(out, cookie=cookie)
        except ApiError as e:
            self.send_json({"error": e.msg}, e.status)
        except (BrokenPipeError, ConnectionError):
            pass
        except Exception:
            traceback.print_exc()
            self.send_json({"error": "Server error"}, 500)

    def do_GET(self):
        url = urlparse(self.path)
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        if not DEV and SITE_URL.startswith("https") and host.endswith(".onrender.com") and not url.path.startswith("/api/"):
            self.send_response(301)   # the old Render address: send everyone to the real domain
            self.send_header("Location", SITE_URL + self.path)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
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
        ctype, extra = MIME.get(os.path.splitext(full)[1], "application/octet-stream"), None
        if rel == "sw.js":   # the service worker (streak reminders): served from the root so it may cover the whole app
            ctype, extra = "application/javascript; charset=utf-8", {"Service-Worker-Allowed": "/"}
        try:
            self.send_body(200, ctype, body, extra=extra)
        except (BrokenPipeError, ConnectionError):
            pass

    def do_POST(self):
        if urlparse(self.path).path == "/stripe/webhook":
            raw = self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 1_000_000))
            return self.run_api(stripe_event, raw, self.headers.get("Stripe-Signature") or "")
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(min(length, 65536 if self.path.startswith("/api/review/") else 8192)) or b"{}")
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
        total = sum(min(150, int(pts[i:i + 2], 36)) for i in range(0, len(pts), 2) if pts[i:i + 2].isalnum())
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
        DB.execute("INSERT OR IGNORE INTO answers (prompt_id, name, count, extra) VALUES (?, ?, ?, 1)", (args[1], name, max(3, seen[0] if seen else 0)))
        DB.execute("DELETE FROM suggestions WHERE prompt_id = ? AND key = ?", (args[1], norm(name)))
        DB.commit()
        print(f"Added '{name}' to {args[1]}. Restart the server to pick it up.")
    else:
        print(__doc__)


def main():
    load_prompts()
    load_ease()
    open_db()
    if len(sys.argv) > 1:
        return cli(sys.argv[1:])
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    if PUSH:   # streak reminders: checks every few minutes, sends from the UK evening on
        threading.Thread(target=push_loop, daemon=True).start()
    print(f"Outlier is running with {len(PROMPTS)} prompts.", flush=True)
    print(f"  Streak reminders:  {'on' if PUSH else 'off (needs pywebpush and OUTLIER_VAPID_PUBLIC/PRIVATE)'}", flush=True)
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
