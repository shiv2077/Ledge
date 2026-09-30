import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "reader" / "usage_reader.py"
SPEC = importlib.util.spec_from_file_location("usage_reader", MODULE_PATH)
reader = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(reader)


UTC = dt.timezone.utc


class ParserTests(unittest.TestCase):
    def test_claude_order_zero_and_null_reset(self):
        payload = {
            "limits": [
                {"kind": "weekly_sonnet", "percent": 12, "resetsAt": None},
                {"kind": "weekly_all", "percent": 0, "resetsAt": "2030-01-07T00:00:00Z"},
            ],
            "five_hour": {"utilization": 0, "resets_at": None},
        }
        windows = reader.parse_claude_usage(payload)
        self.assertEqual([item["id"] for item in windows],
                         ["session", "weekly_all", "weekly_sonnet"])
        self.assertEqual(windows[0]["usedPercent"], 0.0)
        self.assertIsNone(windows[0]["resetsAt"])
        self.assertEqual(windows[1]["usedPercent"], 0.0)

    def test_cursor_percentages_and_reset(self):
        payload = {
            "billingCycleEnd": "2030-02-01T00:00:00.000Z",
            "individualUsage": {
                "plan": {
                    "totalPercentUsed": 0,
                    "apiPercentUsed": 25,
                },
                "onDemand": {"enabled": True, "used": 0, "limit": 10},
            },
        }
        windows = reader.parse_cursor_usage(payload)
        self.assertEqual([item["id"] for item in windows], ["included", "api", "on_demand"])
        self.assertEqual(windows[0]["usedPercent"], 0.0)
        self.assertEqual(windows[1]["usedPercent"], 25.0)
        self.assertTrue(windows[0]["resetsAt"].startswith("2030-02-01T00:00:00"))
        self.assertEqual(windows[2]["usedPercent"], 0.0)

    def test_codex_latest_timestamp_and_countdown_reset(self):
        now = dt.datetime(2026, 9, 6, tzinfo=UTC)
        old = {
            "timestamp": "2026-09-05T00:00:00Z",
            "payload": {"rate_limits": {"primary": {
                "used_percent": 10, "window_minutes": 300,
                "resets_in_seconds": 60,
            }}},
        }
        new = {
            "timestamp": "2026-09-06T00:00:00Z",
            "payload": {"rate_limits": {
                "primary": {"used_percent": 0, "window_minutes": 300,
                             "resets_in_seconds": 120},
                "secondary": {"used_percent": 80, "window_minutes": 10080,
                               "resets_at": 1893974400},
            }},
        }
        windows = reader.parse_codex_rollout(
            json.dumps(new) + "\n" + json.dumps(old), now=now
        )
        self.assertEqual([item["id"] for item in windows], ["primary", "secondary"])
        self.assertEqual(windows[0]["usedPercent"], 0.0)
        self.assertEqual(windows[0]["label"], "5h limit")
        self.assertEqual(windows[1]["label"], "Weekly limit")
        self.assertEqual(windows[0]["resetsAt"], "2026-09-06T00:02:00.000Z")
        self.assertEqual(reader.codex_recorded_at(json.dumps(old) + "\n" + json.dumps(new)),
                         dt.datetime(2026, 9, 6, tzinfo=UTC))

    def test_codex_countdown_uses_snapshot_time_and_unknown_time_stays_unknown(self):
        snapshot = {
            "timestamp": "2026-09-01T00:00:00Z",
            "rate_limits": {"primary": {"used_percent": 4,
                                           "resets_in_seconds": 60}},
        }
        windows = reader.parse_codex_rollout(
            json.dumps(snapshot), now=dt.datetime(2026, 9, 6, tzinfo=UTC)
        )
        self.assertEqual(windows[0]["resetsAt"], "2026-09-01T00:01:00.000Z")
        unknown = reader.parse_codex_rollout(json.dumps({
            "rate_limits": {"primary": {"used_percent": 4,
                                           "resets_in_seconds": 60}},
        }), now=dt.datetime(2026, 9, 6, tzinfo=UTC))
        self.assertIsNone(unknown[0]["resetsAt"])

    def test_boolean_nan_and_malformed_values_are_rejected(self):
        with self.assertRaises(reader.UsageParseError):
            reader.parse_cursor_usage({"individualUsage": {"plan": {"totalPercentUsed": True}}})
        with self.assertRaises(reader.UsageParseError):
            reader.parse_codex_rollout(
                '{"timestamp":"2030-01-01T00:00:00Z",'
                '"rate_limits":{"primary":{"used_percent":NaN}}}'
            )
        with self.assertRaises(reader.UsageParseError):
            reader.parse_claude_usage("[]")


class LocalReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = {
            "HOME": str(self.root / "home"),
            "XDG_CACHE_HOME": str(self.root / "cache"),
            "XDG_CONFIG_HOME": str(self.root / "config"),
            "CODEX_HOME": str(self.root / "codex"),
            "CLAUDE_CONFIG_DIR": str(self.root / "claude"),
        }
        Path(self.env["HOME"]).mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def test_cache_failure_keeps_original_timestamp_and_becomes_stale(self):
        original = {
            "status": "ok",
            "message": "",
            "source": "Claude OAuth usage",
            "updatedAt": "2026-09-06T00:00:00.000Z",
            "windows": [{"id": "session", "label": "Current session",
                          "usedPercent": 0.0, "resetsAt": None}],
        }
        reader._save_cache("claude", original, self.env)
        output = reader.read_document(["claude"], env=self.env,
                                      now=dt.datetime(2026, 9, 6, 1, tzinfo=UTC))
        provider = output["providers"][0]
        self.assertEqual(provider["status"], "stale")
        self.assertEqual(provider["updatedAt"], original["updatedAt"])
        self.assertEqual(provider["windows"][0]["usedPercent"], 0.0)
        self.assertIn("credentials", provider["message"])

    def test_disabled_provider_cache_is_purged_without_provider_reads(self):
        reading = {
            "status": "ok", "message": "", "source": "Test",
            "updatedAt": "2030-01-01T00:00:00.000Z",
            "windows": [{"id": "included", "label": "Included usage",
                          "usedPercent": 1.0, "resetsAt": None}],
        }
        reader._save_cache("cursor", reading, self.env)
        reader._save_cache("codex", reading, self.env)
        reader._save_cache("claude", reading, self.env)
        with mock.patch.object(reader, "_read_codex", side_effect=AssertionError), \
             mock.patch.object(reader, "_read_claude", side_effect=AssertionError), \
             mock.patch.object(reader, "_read_cursor", side_effect=AssertionError):
            output = reader.read_document([], env=self.env,
                                          now=dt.datetime(2030, 1, 1, tzinfo=UTC))
        self.assertEqual(output["providers"], [])
        self.assertFalse((reader.cache_dir(self.env) / "codex.json").exists())
        self.assertFalse((reader.cache_dir(self.env) / "claude.json").exists())
        self.assertFalse((reader.cache_dir(self.env) / "cursor.json").exists())

    def test_codex_state_is_read_only_and_selects_freshest_reading(self):
        codex_home = Path(self.env["CODEX_HOME"])
        codex_home.mkdir()
        rollout_old = codex_home / "old.jsonl"
        rollout_new = codex_home / "new.jsonl"
        rollout_old.write_text(json.dumps({
            "timestamp": "2026-09-05T00:00:00Z",
            "rate_limits": {"primary": {"used_percent": 1}},
        }) + "\n")
        rollout_new.write_text(json.dumps({
            "timestamp": "2026-09-06T00:00:00Z",
            "rate_limits": {"primary": {"used_percent": 2}},
        }) + "\n")
        state = codex_home / "state_5.sqlite"
        connection = sqlite3.connect(state)
        connection.execute("CREATE TABLE threads (rollout_path TEXT, archived INTEGER, updated_at_ms INTEGER)")
        connection.executemany("INSERT INTO threads VALUES (?, 0, ?)", [
            (str(rollout_old), 2), (str(rollout_new), 1),
        ])
        connection.commit()
        connection.close()
        before = state.stat().st_mtime_ns
        reading = reader._codex_local_reading(self.env,
                                               dt.datetime(2026, 9, 6, 1, tzinfo=UTC))
        self.assertEqual(reading["windows"][0]["usedPercent"], 2.0)
        self.assertEqual(reading["updatedAt"], "2026-09-06T00:00:00.000Z")
        self.assertEqual(state.stat().st_mtime_ns, before)

    def test_codex_command_finds_newest_bounded_nvm_version(self):
        versions = Path(self.env["HOME"]) / ".nvm" / "versions" / "node"
        old_bin = versions / "v20.0.0" / "bin"
        new_bin = versions / "v24.0.0" / "bin"
        old_bin.mkdir(parents=True)
        new_bin.mkdir(parents=True)
        old = old_bin / "codex"
        new = new_bin / "codex"
        old.write_text("#!/bin/sh\n")
        new.write_text("#!/bin/sh\n")
        old.chmod(old.stat().st_mode | stat.S_IXUSR)
        new.chmod(new.stat().st_mode | stat.S_IXUSR)
        os.utime(old_bin.parent, (1, 1))
        os.utime(new_bin.parent, (2, 2))
        with mock.patch.object(reader.shutil, "which", return_value=None):
            self.assertEqual(reader.find_codex_command(self.env), str(new))

    def test_session_traversal_visits_newest_directory_before_cap(self):
        sessions = Path(self.env["CODEX_HOME"]) / "sessions"
        old_dir = sessions / "2025" / "01"
        new_dir = sessions / "2026" / "09"
        old_dir.mkdir(parents=True)
        new_dir.mkdir(parents=True)
        old_file = old_dir / "old.jsonl"
        new_file = new_dir / "new.jsonl"
        old_file.write_text("{}\n")
        new_file.write_text("{}\n")
        paths = reader._session_paths(Path(self.env["CODEX_HOME"]), max_files=1)
        self.assertEqual(paths, [new_file])

    def test_claude_429_persists_deadline_and_skips_second_network_attempt(self):
        claude_dir = Path(self.env["CLAUDE_CONFIG_DIR"])
        claude_dir.mkdir()
        (claude_dir / ".credentials.json").write_text(json.dumps({
            "claudeAiOauth": {"accessToken": "token-value", "expiresAt": 1893974400000}
        }))
        now = dt.datetime(2026, 9, 6, tzinfo=UTC)
        with mock.patch.object(reader, "_http_json", return_value=(429, b"", {"Retry-After": "120"}, 120)) as request:
            first = reader._read_claude(self.env, now)
            self.assertEqual(first["status"], "error")
            self.assertEqual(request.call_count, 1)
        backoff = json.loads((reader.cache_dir(self.env) / "claude.backoff.json").read_text())
        deadline = reader._parse_iso(backoff["retryUntil"])
        self.assertGreaterEqual((deadline - now).total_seconds(), 120)
        with mock.patch.object(reader, "_http_json", side_effect=AssertionError), \
             mock.patch.object(reader, "claude_credentials", side_effect=AssertionError):
            second = reader._read_claude(self.env, now + dt.timedelta(seconds=1))
        self.assertEqual(second["status"], "error")
        with mock.patch.object(reader, "_http_json", return_value=(429, b"", {}, None)) as request:
            third = reader._read_claude(self.env, now + dt.timedelta(seconds=121))
        self.assertEqual(third["status"], "error")
        self.assertEqual(request.call_count, 1)
        backoff = json.loads((reader.cache_dir(self.env) / "claude.backoff.json").read_text())
        deadline = reader._parse_iso(backoff["retryUntil"])
        self.assertGreaterEqual((deadline - (now + dt.timedelta(seconds=121))).total_seconds(), 120)

    def test_demo_is_fixed(self):
        with mock.patch.object(reader, "_read_codex", side_effect=AssertionError), \
             mock.patch.object(reader, "_read_claude", side_effect=AssertionError), \
             mock.patch.object(reader, "_read_cursor", side_effect=AssertionError), \
             mock.patch.object(reader, "purge_provider_cache", side_effect=AssertionError):
            first = reader.read_document(["codex", "claude"], demo=True)
            second = reader.read_document(["codex", "claude"], demo=True)
        self.assertEqual(first, second)
        self.assertTrue(all(item["source"] == "Demo" for item in first["providers"]))


class ProcessTests(unittest.TestCase):
    def test_reader_sigterm_stops_active_app_server(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            pid_file = folder / 'server.pid'
            fake = folder / 'fake-codex'
            fake.write_text('#!/usr/bin/python3\nimport os,time\n'
                            f'open({str(pid_file)!r},"w").write(str(os.getpid()))\n'
                            'time.sleep(30)\n')
            fake.chmod(0o700)
            env = dict(os.environ, HOME=directory, CODEX_HOME=str(folder / 'codex'),
                       XDG_CACHE_HOME=str(folder / 'cache'), LEDGE_CODEX_BIN=str(fake))
            proc = subprocess.Popen(['/usr/bin/python3', str(MODULE_PATH), '--providers', 'codex'],
                                    env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 2
                while not pid_file.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(pid_file.exists(), 'fake server started')
                server_pid = int(pid_file.read_text())
                proc.terminate()
                proc.wait(timeout=3)
                path = Path(f'/proc/{server_pid}/stat')
                self.assertTrue(not path.exists() or path.read_text().split()[2] == 'Z')
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()

    def test_app_server_prepends_command_directory_to_child_path(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            path_file = folder / "child-path"
            script = folder / "fake-codex"
            script.write_text(textwrap.dedent("""\
                #!/usr/bin/python3
                import json, os, sys, time
                with open(%r, 'w') as stream:
                    stream.write(os.environ.get('PATH', ''))
                for _ in range(3):
                    sys.stdin.readline()
                print(json.dumps({'jsonrpc':'2.0','id':2,'result':{'rateLimits':{
                    'primary':{'usedPercent':0}
                }}}), flush=True)
                time.sleep(30)
            """) % str(path_file))
            script.chmod(script.stat().st_mode | stat.S_IXUSR)
            reader.codex_app_server(str(script), timeout=1)
            self.assertTrue(path_file.read_text().startswith(str(folder)))

    def test_app_server_timeout_terminates_and_reaps_child(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            pid_file = folder / "pids"
            script = folder / "fake-codex"
            script.write_text(textwrap.dedent("""\
                #!/usr/bin/python3
                import os, time
                child = os.fork()
                if child == 0:
                    time.sleep(30)
                    os._exit(0)
                with open(%r, 'w') as stream:
                    stream.write(str(os.getpid()) + '\\n' + str(child) + '\\n')
                    stream.flush()
                time.sleep(30)
            """) % str(pid_file))
            script.chmod(script.stat().st_mode | stat.S_IXUSR)
            started = dt.datetime.now(tz=UTC)
            with self.assertRaises(reader.ProviderProblem) as error:
                reader.codex_app_server(str(script), timeout=0.2)
            self.assertIn("timed out", error.exception.message)
            self.assertLess((dt.datetime.now(tz=UTC) - started).total_seconds(), 3)
            pids = [int(item) for item in pid_file.read_text().splitlines()]
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                live = []
                for pid in pids:
                    try:
                        state = Path(f"/proc/{pid}/stat").read_text().split()[2]
                        if state != "Z":
                            live.append(pid)
                    except FileNotFoundError:
                        pass
                if not live:
                    break
                time.sleep(0.02)
            self.assertEqual(live, [])


if __name__ == "__main__":
    unittest.main()
