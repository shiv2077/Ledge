import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("costs", ROOT / "reader" / "costs.py")
costs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(costs)
FIXTURES = Path(__file__).resolve().parent / "fixtures"
DAY = dt.date(2030, 1, 2)


class CostTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.home)
        claude = self.home / ".claude" / "projects" / "-work-ledge"
        claude.mkdir(parents=True)
        shutil.copy(FIXTURES / "claude-transcript.jsonl", claude / "a.jsonl")
        codex = self.home / ".codex" / "sessions" / "2030" / "01" / "02"
        codex.mkdir(parents=True)
        shutil.copy(FIXTURES / "codex-rollout.jsonl", codex / "rollout-x.jsonl")
        self.env = {"HOME": str(self.home)}

    def test_claude_cache_tokens_are_billed_apart_from_input(self):
        usage = {"input": 1_000_000, "cache_read": 1_000_000, "cache_write": 1_000_000, "output": 1_000_000}
        self.assertAlmostEqual(costs.claude_cost("claude-opus-5-5", usage), 4 + 0.2 + 5 + 20)

    def test_openai_cached_input_is_inside_input(self):
        usage = {"input": 1_000_000, "cached": 400_000, "output": 100_000}
        self.assertAlmostEqual(costs.openai_cost("gpt-5-codex", usage), 0.6 * 1.25 + 0.4 * 0.125 + 0.1 * 10)

    def test_unknown_models_are_not_priced(self):
        self.assertIsNone(costs.claude_cost("mystery", {"input": 1}))
        self.assertEqual(costs.price(costs.CLAUDE_PRICES, "claude-opus-5-5-fast"), costs.CLAUDE_PRICES["claude-opus-5-5"])
        self.assertEqual(costs.price(costs.CLAUDE_PRICES, "claude-opus-5"), costs.CLAUDE_PRICES["claude-opus-5"])

    def test_repeated_events_count_once(self):
        doc = costs.read_document(self.env, DAY)
        claude, codex = doc["providers"]["claude"], doc["providers"]["codex"]
        # The duplicate Claude record counts once; the unknown model is unpriced.
        self.assertAlmostEqual(claude["today"], 29.2)
        self.assertEqual(claude["unpricedTokens"], 15)
        self.assertEqual(claude["projects"], [{"name": "ledge", "cost": 29.2}])
        # Codex: two events report the same total, a third doubles it.
        self.assertAlmostEqual(codex["week"], 2 * (0.6 * 1.25 + 0.4 * 0.125 + 0.1 * 10))
        self.assertTrue(doc["label"].startswith("estimate at API list prices"))

    def test_warm_run_reads_only_appended_lines_and_index_is_private(self):
        costs.read_document(self.env, DAY)
        index = self.home / ".cache" / "ledge" / "costs.json"
        self.assertEqual(stat.S_IMODE(index.stat().st_mode), 0o600)
        text = index.read_text()
        self.assertNotIn("/work/", text)
        path = self.home / ".claude" / "projects" / "-work-ledge" / "a.jsonl"
        with path.open("a") as stream:
            stream.write(json.dumps({"timestamp": "2030-01-02T12:00:00Z", "cwd": "/work/ledge", "requestId": "r3",
                                     "message": {"id": "m3", "model": "claude-opus-5-5",
                                                 "usage": {"output_tokens": 1_000_000}}}) + "\n")
        doc = costs.read_document(self.env, DAY)
        self.assertAlmostEqual(doc["providers"]["claude"]["today"], 49.2)

    def test_unfinished_line_waits_for_next_run(self):
        path = self.home / ".claude" / "projects" / "-work-ledge" / "a.jsonl"
        with path.open("a") as stream:
            stream.write('{"timestamp": "2030-01-02T12:00:00Z", "message": {"id": "m4"')
        doc = costs.read_document(self.env, DAY)
        self.assertAlmostEqual(doc["providers"]["claude"]["today"], 29.2)

    def test_old_days_drop_out_of_the_week(self):
        doc = costs.read_document(self.env, DAY + dt.timedelta(days=8))
        self.assertEqual(doc["providers"]["claude"]["week"], 0)


if __name__ == "__main__":
    unittest.main()
