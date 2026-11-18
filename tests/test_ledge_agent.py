import datetime as dt
import importlib.util
import json
from pathlib import Path
import shutil
import stat
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('ledge_agent', ROOT / 'tools' / 'ledge_agent.py')
agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent)
NOW = dt.datetime(2030, 1, 1, 12, tzinfo=dt.timezone.utc)


def fake_proc(root: Path, pid: int, ppid: int, cmdline: list[str]) -> None:
    d = root / str(pid)
    d.mkdir(parents=True)
    (d / 'cmdline').write_bytes('\0'.join(cmdline).encode() + b'\0')
    (d / 'stat').write_text(f'{pid} (x y) S {ppid} 0 0')


class HookTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        self.proc = self.root / 'proc'
        fake_proc(self.proc, 500, 400, ['python3', 'ledge_agent.py'])
        fake_proc(self.proc, 400, 300, ['/bin/sh', '-c', 'python3 ledge_agent.py'])
        fake_proc(self.proc, 300, 200, ['/home/u/.local/bin/claude', '--resume'])
        fake_proc(self.proc, 200, 1, ['bash'])
        self.env = {'HOME': str(self.root)}

    def hook(self, name, **fields):
        return agent.from_hook({'session_id': 'abc-123', 'cwd': '/w/repo', 'hook_event_name': name, **fields},
                               self.env, NOW, 500, self.proc)

    def test_prompt_marks_working_with_the_agents_pid(self):
        path = self.hook('UserPromptSubmit', prompt='a secret prompt')
        data = json.loads(path.read_text())
        self.assertEqual((data['state'], data['pid'], data['cwd'], data['id']), ('working', 300, '/w/repo', 'abc-123'))
        self.assertNotIn('secret', path.read_text())
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_notification_maps_to_an_enum_and_drops_the_message(self):
        path = self.hook('Notification', message='Claude needs your permission to use Bash: rm -rf secret')
        data = json.loads(path.read_text())
        self.assertEqual((data['state'], data['waitingFor']), ('waiting', 'permission'))
        self.assertNotIn('secret', path.read_text())
        data = json.loads(self.hook('Notification', message='Claude is waiting for your input').read_text())
        self.assertEqual(data['waitingFor'], 'input')

    def test_stop_finishes_and_session_end_deletes(self):
        path = self.hook('Stop')
        self.assertEqual(json.loads(path.read_text())['state'], 'finished')
        self.hook('SessionEnd')
        self.assertFalse(path.exists())

    def test_no_claude_ancestor_records_no_pid(self):
        self.assertIsNone(agent.agent_pid('claude', 200, self.proc))
        self.assertIsNone(agent.from_hook({'hook_event_name': 'Stop'}, self.env, NOW, 500, self.proc))


if __name__ == '__main__':
    unittest.main()
