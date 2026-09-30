import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

from reader import activity


class ActivityTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.environment = mock.patch.dict(os.environ, {
            'HOME': self.home.name,
            'CODEX_HOME': str(Path(self.home.name) / 'codex'),
            'XDG_CONFIG_HOME': str(Path(self.home.name) / 'config'),
            'CLAUDE_CONFIG_DIR': str(Path(self.home.name) / 'claude'),
        }, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def _make_proc(self, root, pid, started, command='/opt/Cursor/cursor', state='S'):
        directory = root / str(pid)
        directory.mkdir(parents=True, exist_ok=True)
        (root / 'stat').write_text('btime 0\n')
        (directory / 'status').write_text(f'Uid:\t{os.getuid()}\n')
        fields = [state] + ['0'] * 18 + [str(int(started * os.sysconf('SC_CLK_TCK')))]
        (directory / 'stat').write_text(f'{pid} (test process) ' + ' '.join(fields))
        (directory / 'cmdline').write_bytes(command.encode() + b'\0')
        return directory

    def test_empty_enablement_performs_no_provider_io(self):
        original_scandir = activity.os.scandir
        original_connect = activity.sqlite3.connect

        def fail_scandir(*_args, **_kwargs):
            raise AssertionError("empty enablement scanned a directory")

        def fail_connect(*_args, **_kwargs):
            raise AssertionError("empty enablement opened SQLite")

        activity.os.scandir = fail_scandir
        activity.sqlite3.connect = fail_connect
        try:
            self.assertEqual(activity.read_activity([], now=1), {
                "version": 1,
                "providers": [],
            })
        finally:
            activity.os.scandir = original_scandir
            activity.sqlite3.connect = original_connect

    def test_demo_has_explicit_states_and_does_not_read_local_stores(self):
        original_scandir = activity.os.scandir
        original_connect = activity.sqlite3.connect

        def fail_scandir(*_args, **_kwargs):
            raise AssertionError("demo scanned a directory")

        def fail_connect(*_args, **_kwargs):
            raise AssertionError("demo opened SQLite")

        activity.os.scandir = fail_scandir
        activity.sqlite3.connect = fail_connect
        try:
            payload = activity.read_activity(
                "claude,cursor,codex", demo=True, now=1000
            )
        finally:
            activity.os.scandir = original_scandir
            activity.sqlite3.connect = original_connect

        self.assertEqual([item["id"] for item in payload["providers"]],
                         ["claude", "cursor", "codex"])
        self.assertEqual(
            [item["sessions"][0]["state"] for item in payload["providers"]],
            ["busy", "waiting", "busy"],
        )
        self.assertTrue(payload["providers"][2]["sessions"][0]["derived"])

    def test_claude_honors_config_dir_and_rejects_dead_or_recycled_pids(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "claude-config"
            sessions = config / "sessions"
            sessions.mkdir(parents=True)
            proc = root / "proc"
            self._make_proc(proc, 42, 1000, command='/usr/bin/claude')

            record = {
                "pid": 42,
                "cwd": "/work/usage-notch",
                "entrypoint": "claude-vscode",
                "name": "Editor task\nwith a long label",
                "status": "busy",
                "startedAt": 1_000_000,
                "statusUpdatedAt": 1_005_000,
            }
            (sessions / "42.json").write_text(json.dumps(record))
            (sessions / "dead.json").write_text(json.dumps({
                **record, "pid": 43,
            }))
            (sessions / "recycled.json").write_text(json.dumps({
                **record, "pid": 42, "startedAt": 2_000_000,
            }))

            found = activity.read_claude_sessions(
                env={"HOME": str(root), "CLAUDE_CONFIG_DIR": str(config)},
                now=1005,
                proc_root=proc,
                current_uid=os.getuid(),
            )

        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["state"], "busy")
        self.assertEqual(found[0]["detail"], "VS Code · usage-notch")
        self.assertNotIn("\n", found[0]["name"])

    def test_claude_caps_file_size_and_excludes_unknown_state(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sessions = root / "sessions"
            sessions.mkdir()
            self._make_proc(root / 'proc', 7, 90, command='/usr/bin/claude')
            record = {"pid": 7, "cwd": "/tmp/app", "status": "hibernating"}
            (sessions / "valid.json").write_text(json.dumps(record))
            (sessions / "too-large.json").write_bytes(
                b"{" + b"x" * activity.CLAUDE_MAX_FILE_BYTES + b"}"
            )
            found = activity.read_claude_sessions(
                env={"HOME": str(root), "CLAUDE_CONFIG_DIR": str(root)},
                now=100,
                proc_root=root / "proc",
                current_uid=os.getuid(),
            )

        self.assertEqual(found, [])

    def _make_cursor_store(self, path, values):
        db = sqlite3.connect(path)
        try:
            db.execute(
                "CREATE TABLE composerHeaders "
                "(value TEXT, isArchived INT, recency INT)"
            )
            for index, (value, archived) in enumerate(values):
                db.execute(
                    "INSERT INTO composerHeaders VALUES (?, ?, ?)",
                    (json.dumps(value), archived, index),
                )
            db.commit()
        finally:
            db.close()

    def test_cursor_reads_exact_headers_and_requires_running_editor_for_waiting(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = root / "state.vscdb"
            self._make_cursor_store(store, [
                ({
                    "composerId": "busy",
                    "unfinishedRunAt": 1_400_000,
                    "conversationCheckpointLastUpdatedAt": 1_490_000,
                    "name": "Busy chat",
                    "subtitle": "Tool result",
                }, 0),
                ({
                    "composerId": "waiting",
                    "hasPendingPlan": True,
                    "lastUpdatedAt": 1_495_000,
                    "name": "Plan chat",
                }, 0),
                ({
                    "composerId": "archived",
                    "unfinishedRunAt": 1_499_000,
                }, 1),
            ])

            found = activity.read_cursor_sessions(
                store=store,
                now=1500,
                stale_after=900,
                cursor_launched_at=900,
            )
            self.assertEqual([row["state"] for row in found], ["waiting", "busy"])
            self.assertEqual(found[0]["waitingFor"], "needs your input")

            self.assertEqual(activity.read_cursor_sessions(
                store=store,
                now=1500,
                cursor_launched_at=None,
            ), [])

    def test_cursor_process_discovery_uses_same_uid_and_exe(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            proc = root / "proc"
            pid_dir = self._make_proc(proc, 88, 1234)
            os.symlink("/opt/Cursor/cursor", pid_dir / "exe")
            self.assertEqual(
                activity.find_cursor_launch_date(
                    proc_root=proc, current_uid=os.getuid()
                ),
                1234,
            )

    def test_cursor_ignores_helper_arguments_and_zombies(self):
        with tempfile.TemporaryDirectory() as temp:
            proc = Path(temp)
            helper = self._make_proc(proc, 1, 1000, '/usr/bin/python3')
            (helper / 'cmdline').write_bytes(b'/usr/bin/python3\0activity.py\0--providers\0claude,cursor,codex\0/tmp/cursor\0')
            self._make_proc(proc, 2, 1000, '/opt/Cursor/cursor', 'Z')
            self.assertIsNone(activity.find_cursor_launch_date(proc_root=proc))

    def test_long_uptime_uses_clock_ticks_and_rejects_recycled_pid(self):
        with tempfile.TemporaryDirectory() as temp:
            proc = Path(temp)
            started = 2_000_000
            self._make_proc(proc, 9, started)
            self.assertTrue(activity.process_is_live(9, started, proc_root=proc))
            self.assertFalse(activity.process_is_live(9, started - 30, proc_root=proc))

    def test_cursor_xdg_path_wal_and_unknown_or_future_timestamps(self):
        store = Path(os.environ['XDG_CONFIG_HOME']) / 'Cursor/User/globalStorage/state.vscdb'
        store.parent.mkdir(parents=True)
        self._make_cursor_store(store, [])
        with sqlite3.connect(store) as writer:
            writer.execute('PRAGMA journal_mode=WAL')
            for i, head in enumerate([
                {'composerId': 'valid', 'hasPendingPlan': True, 'lastUpdatedAt': 1_495_000},
                {'composerId': 'unknown', 'hasPendingPlan': True},
                {'composerId': 'future', 'hasPendingPlan': True, 'lastUpdatedAt': 9_000_000},
            ]):
                writer.execute('INSERT INTO composerHeaders VALUES (?,0,?)', (json.dumps(head), i))
            writer.commit()
            sessions = activity.read_cursor_sessions(now=1500, cursor_launched_at=900)
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]['state'], 'waiting')

    def _make_codex_store(self, path, rollout_paths):
        db = sqlite3.connect(path)
        try:
            db.execute(
                "CREATE TABLE threads "
                "(rollout_path TEXT, archived INT, updated_at_ms INT)"
            )
            for index, rollout in enumerate(rollout_paths):
                db.execute(
                    "INSERT INTO threads VALUES (?, 0, ?)",
                    (str(rollout), 10_000 - index),
                )
            db.commit()
        finally:
            db.close()

    def test_codex_uses_indexed_rollout_or_newest_desktop_title(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = root / "state_5.sqlite"
            rollout = root / "rollout.jsonl"
            rollout.write_text('{"type":"session_meta"}\n')
            os.utime(rollout, (1998, 1998))
            self._make_codex_store(state, [root / "missing.jsonl", rollout])

            desktop = root / "codex-dev.db"
            db = sqlite3.connect(desktop)
            try:
                db.execute(
                    "CREATE TABLE local_thread_catalog "
                    "(thread_id TEXT, display_title TEXT, "
                    "source_updated_at REAL, source_kind TEXT)"
                )
                db.execute(
                    "INSERT INTO local_thread_catalog VALUES (?, ?, ?, ?)",
                    ("thread", "Desktop research", 1999, "chatgpt"),
                )
                db.commit()
            finally:
                db.close()

            found = activity.read_codex_sessions(
                state_store=state,
                desktop_store=desktop,
                now=2000,
            )

        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["name"], "Desktop research")
        self.assertEqual(found[0]["detail"], "Recent activity (estimated)")
        self.assertTrue(found[0]["derived"])

    def test_codex_old_activity_is_empty_and_malformed_db_is_safe(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old = root / "old.jsonl"
            old.write_text("metadata")
            os.utime(old, (1000, 1000))
            state = root / "state_5.sqlite"
            self._make_codex_store(state, [old])
            self.assertEqual(
                activity.read_codex_sessions(state_store=state, now=1009), []
            )
            self.assertEqual(
                activity.read_codex_sessions(state_store=state, now=900), []
            )

            malformed = root / "broken.sqlite"
            malformed.write_bytes(b"not sqlite")
            self.assertEqual(
                activity.read_codex_sessions(state_store=malformed, now=1000), []
            )


if __name__ == "__main__":
    unittest.main()
