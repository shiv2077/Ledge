import datetime as dt
import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("lmstudio", ROOT / "reader" / "lmstudio.py")
lmstudio = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lmstudio)
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "lmstudio.log"
DAY = dt.date(2030, 1, 2)


class LmStudioTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.home)
        logs = self.home / ".lmstudio" / "server-logs" / "2030-01"
        logs.mkdir(parents=True)
        self.log = logs / "2030-01-02.1.log"
        shutil.copy(FIXTURE, self.log)
        self.env = {"HOME": str(self.home)}

    def test_counts_requests_but_not_embeddings_or_bodies(self):
        doc = lmstudio.read_document(self.env, DAY)
        self.assertEqual(doc["today"], 2)
        self.assertEqual(doc["endpoints"], {"/v1/chat/completions": 1, "/v1/models": 1})
        self.assertEqual(doc["last"], "2030-01-02T10:01:00")
        cache = (self.home / ".cache" / "ledge" / "lmstudio.json").read_text()
        self.assertNotIn("secret", cache)

    def test_second_run_reads_only_new_lines(self):
        lmstudio.read_document(self.env, DAY)
        with self.log.open("a") as stream:
            stream.write("2030-01-02 11:00:00 [INFO] Received POST request to /v1/completions with body: {}\n")
        doc = lmstudio.read_document(self.env, DAY)
        self.assertEqual(doc["today"], 3)
        self.assertEqual(doc["week"], 3)

    def test_no_logs(self):
        doc = lmstudio.read_document({"HOME": str(self.home / "nobody")}, DAY)
        self.assertEqual((doc["today"], doc["logs"]), (0, False))


if __name__ == "__main__":
    unittest.main()
