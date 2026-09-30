import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("ledge_status", ROOT / "tools" / "ledge_status.py")
ledge_status = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ledge_status)


class RunStatusTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.dir = Path(self.folder.name) / "runs"

    def tearDown(self):
        self.folder.cleanup()

    def read(self, status):
        return json.loads(status.path.read_text())

    def test_writes_every_n_updates_and_on_force(self):
        status = ledge_status.RunStatus("demo run/1", total_epochs=5, every=3, directory=self.dir)
        self.assertEqual(status.path.name, "demo-run-1.json")
        self.assertEqual(self.read(status)["state"], "running")
        status.update(epoch=1, step=1, loss=2.0)
        status.update(epoch=1, step=2, loss=1.5)
        self.assertIsNone(self.read(status)["loss"])
        status.update(epoch=1, step=3, loss=1.25, eta_seconds=60)
        doc = self.read(status)
        self.assertEqual((doc["epoch"], doc["step"], doc["loss"], doc["total_epochs"]), (1, 3, 1.25, 5))
        status.update(loss=float("nan"), force=True)
        self.assertIsNone(self.read(status)["loss"])
        self.assertEqual([p.name for p in self.dir.iterdir()], ["demo-run-1.json"])

    def test_context_manager_marks_done_or_crashed(self):
        with ledge_status.RunStatus("ok", directory=self.dir) as status:
            status.update(epoch=1)
        self.assertEqual(self.read(status)["state"], "done")
        with self.assertRaises(ValueError):
            with ledge_status.RunStatus("bad", directory=self.dir) as status:
                raise ValueError("boom")
        doc = self.read(status)
        self.assertEqual(doc["state"], "crashed")
        self.assertIsInstance(doc["updated_at"], float)


if __name__ == "__main__":
    unittest.main()
