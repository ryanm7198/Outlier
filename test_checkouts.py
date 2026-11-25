#!/usr/bin/env python3
"""Tests for darts checkouts.  python -m unittest test_checkouts"""
import json
import os
import unittest

from checkouts import canonical, parse, routes
from make_checkouts import ordered, scores

ROOT = os.path.dirname(os.path.abspath(__file__))


class Routes(unittest.TestCase):
    def test_counts(self):
        self.assertEqual(len(routes(140)), 23)
        self.assertEqual(len(routes(141)), 10)
        self.assertEqual(routes(170), {"T20-T20-BULL"})

    def test_every_route_adds_up_and_finishes_on_a_double(self):
        from checkouts import value
        for s in range(2, 171):
            for r in routes(s):
                a, b, d = r.split("-")
                self.assertEqual(value(a) + value(b) + value(d), s, r)
                self.assertTrue(d == "BULL" or d.startswith("D"), r)

    def test_canonical_order(self):
        self.assertEqual(canonical("T16", "T20", "D16"), "T20-T16-D16")
        self.assertEqual(canonical("BULL", "T20", "D15"), "T20-BULL-D15")   # by score: 60 beats 50
        self.assertEqual(canonical("S20", "D10", "D20"), "D10-S20-D20")     # a tie goes T, D, S
        self.assertEqual(canonical("25", "S25" if False else "T20", "D20"), "T20-25-D20")

    def test_scores_chosen(self):
        self.assertEqual(scores(), list(range(111, 141)) + [142])
        self.assertTrue(all(len(routes(s)) >= 15 for s in scores()))

    def test_order_starts_with_the_pro_routes(self):
        self.assertEqual(ordered(140)[:3], ["T20-T20-D10", "T20-T16-D16", "T20-T14-D19"])
        self.assertEqual(sorted(ordered(140)), sorted(routes(140)))


class Parse(unittest.TestCase):
    def test_either_order_and_auto_finish(self):
        for raw in ("T20-T16-D16", "t16 t20 d16", "t20 t16", "T16,T20", "t20 t16 D16"):
            self.assertEqual(parse(raw, 140), "T20-T16-D16", raw)

    def test_bulls(self):
        self.assertEqual(parse("bull t20", 140), "T20-BULL-D15")
        self.assertEqual(parse("t20 t20 bull", 170), "T20-T20-BULL")
        self.assertEqual(parse("t20 t20 d25", 170), "T20-T20-BULL")
        self.assertEqual(parse("25 t20", 125), "T20-25-D20")

    def test_rejects(self):
        for raw in ("20 16", "t20", "t20 t16 d10", "t20 t20 t20", "t21 t16", "s25 t20 d10", "", "t20 t16 d16 d1",
                    "t20 s3"):   # bare numbers, too few/many darts, wrong double, no such segment, 77 left
            self.assertIsNone(parse(raw, 140), raw)


class QuestionFile(unittest.TestCase):
    def test_file_matches_generator(self):
        with open(os.path.join(ROOT, "prompts-sport-checkouts.json"), encoding="utf-8") as f:
            data = json.load(f)
        got = {p["target"]: p for p in data["prompts"]}
        self.assertEqual(sorted(got), scores())
        for s, p in got.items():
            self.assertEqual(p["answers"], ordered(s))
            self.assertEqual(p["input"], "darts")
            self.assertIn("3 darts", p["text"])

    def test_server_matches_every_route(self):
        import server
        if not server.PROMPTS:
            server.load_prompts()
        for s in scores():
            pid = f"dc-{s}"
            for r in routes(s):
                a, b, d = r.split("-")
                self.assertEqual(server.match(pid, f"{b} {a}"), r)      # reversed setup darts, no double typed
                self.assertEqual(server.match(pid, r.lower()), r)
            self.assertIsNone(server.match(pid, "nonsense"))


if __name__ == "__main__":
    unittest.main()
