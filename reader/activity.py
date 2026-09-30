#!/usr/bin/env python3
"""Read local agent activity for Ledge.

This module is deliberately separate from the usage reader.  Activity is a
local, read-only signal and must never open a credential store, use a cache,
contact a service, or walk an application's whole home directory.

The command line interface prints one small JSON document::

    python3 reader/activity.py --providers claude,cursor,codex

The provider readers are also public so the GNOME-facing reader and tests can
pass isolated paths and a deterministic clock.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import math
import os
from pathlib import Path
import sqlite3
import sys
import time
from typing import Any, Iterable, Mapping, Optional, Sequence
from urllib.parse import quote


VERSION = 1
PROVIDERS = ("claude", "cursor", "codex")

CLAUDE_MAX_FILES = 128
CLAUDE_MAX_FILE_BYTES = 64 * 1024
CURSOR_MAX_ROWS = 40
CURSOR_STALE_SECONDS = 15 * 60
CODEX_MAX_ROLLOUT_PATHS = 8
CODEX_STALE_SECONDS = 8
# Claude registers a session shortly after its process starts.  A few seconds
# covers that registration gap while still rejecting a recycled pid promptly.
PROCESS_REUSE_TOLERANCE = 5.0
MAX_TEXT = 200
MAX_HEADER_BYTES = 256 * 1024
MAX_PROC_FILE_BYTES = 64 * 1024

_UNSET = object()
_UTC = _dt.timezone.utc


def _finite(value: Any) -> Optional[float]:
    """Return a finite number, accepting numeric strings for local stores."""

    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        result = float(value)
    elif isinstance(value, str):
        try:
            result = float(value.strip())
        except (TypeError, ValueError):
            return None
    else:
        return None
    return result if math.isfinite(result) else None


def _epoch(value: Any, *, milliseconds: bool = False) -> Optional[float]:
    """Convert a timestamp value to epoch seconds without accepting booleans."""

    if isinstance(value, _dt.datetime):
        parsed = value
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=_UTC)
        result = parsed.astimezone(_UTC).timestamp()
    else:
        result = _finite(value)
        if result is None:
            return None
    if milliseconds:
        result /= 1000.0
    return result if math.isfinite(result) else None


def _claude_started_at(value: Any) -> Optional[float]:
    """Claude stores ``startedAt`` in milliseconds."""

    result = _finite(value)
    if result is None:
        return None
    return result / 1000.0


def _now_epoch(now: Any = None) -> float:
    result = _epoch(now)
    return time.time() if result is None else result


def isoformat(value: Any) -> str:
    """Format an epoch timestamp as a stable UTC ISO-8601 string."""

    epoch = _epoch(value)
    if epoch is None:
        epoch = time.time()
    try:
        parsed = _dt.datetime.fromtimestamp(epoch, tz=_UTC)
    except (OverflowError, OSError, ValueError):
        parsed = _dt.datetime.now(_UTC)
    return parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _clean_text(value: Any, fallback: str = "", limit: int = MAX_TEXT) -> str:
    """Keep display metadata short and single-line.

    Activity files are written by other applications.  Treat their labels as
    untrusted display text: do not let a newline, terminal control character,
    or an unbounded title reach the GNOME process.
    """

    text = value if isinstance(value, str) else fallback
    chars: list[str] = []
    for char in text:
        if char in "\r\n\t":
            chars.append(" ")
        elif ord(char) < 32 or ord(char) == 127:
            continue
        else:
            chars.append(char)
    result = " ".join("".join(chars).split())
    if not result:
        result = fallback
    return result[:limit]


def _path_from(value: Any, env: Mapping[str, str]) -> Optional[Path]:
    if not isinstance(value, (str, os.PathLike)):
        return None
    try:
        raw = os.fspath(value)
    except TypeError:
        return None
    if not isinstance(raw, str) or not raw:
        return None
    if raw == "~" or raw.startswith("~/"):
        home = env.get("HOME") or str(Path.home())
        raw = home + raw[1:]
    try:
        return Path(raw).expanduser()
    except (OSError, RuntimeError, ValueError):
        return None


def _home(env: Mapping[str, str]) -> Path:
    return _path_from(env.get("HOME"), env) or Path.home()


def _reject_json_constant(token: str) -> None:
    raise ValueError(f"invalid JSON constant {token}")


def _decode_json(data: bytes) -> Any:
    if len(data) > 0:
        text = data.decode("utf-8")
    else:
        text = ""
    return json.loads(text, parse_constant=_reject_json_constant)


def _read_json_file(path: Path, limit: int) -> Optional[Any]:
    try:
        with path.open("rb") as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            return None
        return _decode_json(data)
    except (OSError, UnicodeDecodeError, ValueError, TypeError, json.JSONDecodeError):
        return None


def _proc_path(proc_root: Path | str, pid: int) -> Path:
    return Path(proc_root) / str(pid)


def _read_limited(path: Path, limit: int = MAX_PROC_FILE_BYTES) -> Optional[bytes]:
    try:
        with path.open("rb") as stream:
            data = stream.read(limit + 1)
        return None if len(data) > limit else data
    except (OSError, ValueError):
        return None


def _proc_uid(pid_dir: Path) -> Optional[int]:
    """Read a process's real uid, falling back to its proc directory owner."""

    status = _read_limited(pid_dir / "status")
    if status is not None:
        try:
            for line in status.decode("utf-8", "replace").splitlines():
                if line.startswith("Uid:"):
                    fields = line.split()[1:]
                    if not fields:
                        return None
                    return int(fields[0])
        except (TypeError, ValueError):
            return None
    try:
        return int(pid_dir.stat().st_uid)
    except (OSError, ValueError):
        return None


def _proc_start_ticks(pid_dir: Path) -> Optional[int]:
    """Read Linux ``/proc/<pid>/stat`` field 22 safely.

    The command name can contain spaces and parentheses, so splitting the
    complete line is unsafe.  The final closing parenthesis before the state
    field is the delimiter used by procps as well.
    """

    raw = _read_limited(pid_dir / "stat")
    if raw is None:
        return None
    text = raw.decode("utf-8", "replace")
    closing = text.rfind(")")
    if closing < 0:
        return None
    fields = text[closing + 1 :].split()
    # Tail starts at field 3; field 22 is index 19.
    if len(fields) <= 19:
        return None
    try:
        return int(fields[19])
    except (TypeError, ValueError):
        return None


def _proc_state(pid_dir: Path) -> Optional[str]:
    raw = _read_limited(pid_dir / "stat")
    if raw is None:
        return None
    text = raw.decode("utf-8", "replace")
    closing = text.rfind(")")
    if closing < 0:
        return None
    fields = text[closing + 1 :].split()
    return fields[0] if fields else None


def _proc_boot_time(proc_root: Path) -> Optional[float]:
    raw = _read_limited(proc_root / "stat")
    if raw is None:
        return None
    try:
        for line in raw.decode("utf-8", "replace").splitlines():
            fields = line.split()
            if fields and fields[0] == "btime" and len(fields) > 1:
                return _finite(fields[1])
    except (TypeError, ValueError):
        return None
    return None


def _proc_start_epoch(pid_dir: Path, proc_root: Path | str) -> Optional[float]:
    """Return a process start epoch when proc exposes enough information."""

    root = Path(proc_root)
    ticks = _proc_start_ticks(pid_dir)
    if ticks is None:
        return None
    boot = _proc_boot_time(root)
    if boot is None:
        return None
    try:
        hertz = float(os.sysconf("SC_CLK_TCK"))
    except (AttributeError, OSError, TypeError, ValueError):
        return None
    if not math.isfinite(hertz) or hertz <= 0:
        return None
    return boot + ticks / hertz


def parse_proc_start(value: Any) -> Optional[float]:
    """Parse Claude's UTC ctime-style ``procStart`` value."""

    if not isinstance(value, str):
        return None
    parts = value.split()
    if len(parts) != 5:
        return None
    _weekday, month, day, clock, year = parts
    months = {
        "Jan": 1,
        "Feb": 2,
        "Mar": 3,
        "Apr": 4,
        "May": 5,
        "Jun": 6,
        "Jul": 7,
        "Aug": 8,
        "Sep": 9,
        "Oct": 10,
        "Nov": 11,
        "Dec": 12,
    }
    if month not in months:
        return None
    try:
        parsed = _dt.datetime.strptime(
            f"{year}-{months[month]:02d}-{int(day):02d} {clock}",
            "%Y-%m-%d %H:%M:%S",
        )
        return parsed.replace(tzinfo=_UTC).timestamp()
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def process_is_live(
    pid: Any,
    started_at: Any = None,
    proc_start: Any = None,
    *,
    proc_root: Path | str = "/proc",
    current_uid: Optional[int] = None,
    tolerance: float = PROCESS_REUSE_TOLERANCE,
) -> bool:
    """Check same-UID process liveness without sending a signal.

    If proc cannot provide a start timestamp, the conservative behavior
    is retained: a same-UID live pid is trusted rather than hidden.  When both
    timestamps exist, a five-second timestamp tolerance is allowed and a recycled
    pid is rejected.
    """

    number = _finite(pid)
    if number is None or number <= 0 or number != int(number):
        return False
    pid_number = int(number)
    pid_dir = _proc_path(proc_root, pid_number)
    try:
        if not pid_dir.is_dir():
            return False
    except OSError:
        return False
    uid = os.getuid() if current_uid is None else int(current_uid)
    if _proc_uid(pid_dir) != uid:
        return False
    if _proc_state(pid_dir) == "Z":
        return False

    recorded = _epoch(started_at)
    if recorded is None:
        recorded = parse_proc_start(proc_start)
    if recorded is None:
        return True
    actual = _proc_start_epoch(pid_dir, Path(proc_root))
    if actual is None:
        return True
    gap = _finite(tolerance)
    if gap is None or gap < 0:
        gap = PROCESS_REUSE_TOLERANCE
    return abs(actual - recorded) <= gap


# Alias kept for callers that use the shorter name.
is_process_live = process_is_live


def _claude_config_dir(env: Mapping[str, str], config_dir: Any = None) -> Optional[Path]:
    if config_dir is not None:
        return _path_from(config_dir, env)
    configured = env.get("CLAUDE_CONFIG_DIR")
    if configured:
        return _path_from(configured, env)
    return _home(env) / ".claude"


def _claude_surface(entrypoint: Any) -> str:
    if entrypoint in ("claude-desktop", "claude-desktop-3p"):
        return "Desktop"
    if entrypoint == "claude-vscode":
        return "VS Code"
    if entrypoint == "local-agent":
        return "Agent"
    return "Terminal"


def _claude_folder(cwd: str) -> str:
    stripped = cwd.rstrip("/")
    if not stripped:
        return "Claude"
    return _clean_text(stripped.rsplit("/", 1)[-1], "Claude") or "Claude"


def _claude_session(
    record: Mapping[str, Any],
    *,
    now: float,
    proc_root: Path | str,
    current_uid: Optional[int],
) -> Optional[dict[str, Any]]:
    pid = record.get("pid")
    pid_number = _finite(pid)
    cwd = record.get("cwd")
    if (
        pid_number is None
        or pid_number <= 0
        or pid_number != int(pid_number)
        or not isinstance(cwd, str)
    ):
        return None

    if not process_is_live(
        int(pid_number),
        _claude_started_at(record.get("startedAt")),
        record.get("procStart"),
        proc_root=proc_root,
        current_uid=current_uid,
    ):
        return None

    tempo = record.get("tempo") if isinstance(record.get("tempo"), str) else None
    raw_status = record.get("status") if isinstance(record.get("status"), str) else None
    if tempo == "blocked" or raw_status == "waiting":
        state = "waiting"
    elif tempo == "active" or raw_status == "busy":
        state = "busy"
    elif tempo == "idle" or raw_status == "idle":
        state = "idle"
    else:
        # An unknown or missing state is not evidence of an idle session.  It
        # is omitted so the UI can honestly say that activity is unknown.
        return None

    millis = record.get("statusUpdatedAt", _UNSET)
    if millis is _UNSET or _finite(millis) is None:
        millis = record.get("updatedAt", _UNSET)
    since = _epoch(millis, milliseconds=True)
    if since is None:
        since = now

    folder = _claude_folder(cwd)
    name = _clean_text(record.get("name"), folder) or folder
    detail = _clean_text(f"{_claude_surface(record.get('entrypoint'))} · {folder}", "Claude")
    waiting_for = None
    if state == "waiting":
        waiting_for = _clean_text(record.get("waitingFor"), "")
        if not waiting_for:
            waiting_for = _clean_text(record.get("needs"), "") or None

    return {
        "name": name,
        "detail": detail,
        "state": state,
        "since": isoformat(since),
        "waitingFor": waiting_for,
        "derived": False,
    }


def _claude_json_paths(directory: Path) -> list[Path]:
    found: list[Path] = []
    try:
        with os.scandir(directory) as entries:
            for entry in entries:
                if len(found) >= CLAUDE_MAX_FILES:
                    break
                if not entry.name.endswith(".json"):
                    continue
                try:
                    if not entry.is_file(follow_symlinks=False):
                        continue
                except OSError:
                    continue
                found.append(Path(entry.path))
    except (OSError, ValueError):
        return []
    return found


def read_claude_sessions(
    *,
    env: Optional[Mapping[str, str]] = None,
    config_dir: Any = None,
    now: Any = None,
    proc_root: Path | str = "/proc",
    current_uid: Optional[int] = None,
) -> list[dict[str, Any]]:
    """Read at most 128 Claude session records of at most 64 KiB each."""

    values = os.environ if env is None else env
    root = _claude_config_dir(values, config_dir)
    if root is None:
        return []
    directory = root / "sessions"
    current = _now_epoch(now)
    sessions: list[dict[str, Any]] = []
    for path in _claude_json_paths(directory):
        value = _read_json_file(path, CLAUDE_MAX_FILE_BYTES)
        if not isinstance(value, dict):
            continue
        try:
            session = _claude_session(
                value,
                now=current,
                proc_root=proc_root,
                current_uid=current_uid,
            )
        except (OSError, TypeError, ValueError, OverflowError):
            session = None
        if session is not None:
            sessions.append(session)
    # Stable newest-first ordering matches ClaudeSessionMonitor.
    sessions.sort(key=lambda item: item.get("since", ""), reverse=True)
    return sessions


def _sqlite_connect_ro(path: Path) -> Optional[sqlite3.Connection]:
    """Open a local SQLite store read-only, preserving WAL visibility."""

    try:
        if not path.is_file():
            return None
        # mode=ro can see a live writer's WAL sidecar.  immutable=1 is not a
        # fallback here: it can silently hide the newest activity in a WAL.
        encoded = quote(str(path), safe="/")
        connection: Optional[sqlite3.Connection] = None
        try:
            connection = sqlite3.connect(
                f"file:{encoded}?mode=ro",
                uri=True,
                timeout=0.2,
            )
            return connection
        except (sqlite3.Error, OSError, ValueError):
            if connection is not None:
                try:
                    connection.close()
                except sqlite3.Error:
                    pass
            return None
    except (OSError, ValueError, TypeError):
        return None


def _millis_field(value: Any) -> Optional[float]:
    return _epoch(value, milliseconds=True)


def _cursor_date(head: Mapping[str, Any], *names: str) -> Optional[float]:
    for name in names:
        if name in head:
            parsed = _millis_field(head.get(name))
            if parsed is not None:
                return parsed
    return None


def _cursor_session(
    head: Mapping[str, Any],
    *,
    cursor_running: bool,
    cursor_launched_at: Optional[float],
    stale_after: float,
    now: float,
) -> Optional[dict[str, Any]]:
    composer_id = head.get("composerId")
    if not isinstance(composer_id, str) or not composer_id:
        return None
    # Do not inspect message/prompt fields.  composerHeaders are metadata rows;
    # only the status bits and timestamps below are read.
    blocked = (
        head.get("hasBlockingPendingActions") is True
        or head.get("hasPendingPlan") is True
    )
    run_start = _cursor_date(head, "unfinishedRunAt")
    last_write = _cursor_date(
        head,
        "conversationCheckpointLastUpdatedAt",
        "lastUpdatedAt",
    )
    created = _cursor_date(head, "createdAt")
    touched = last_write if last_write is not None else run_start
    if touched is None:
        # A row with no timestamp has no age evidence.  Treating it as touched
        # at every poll would fabricate a live session indefinitely.
        touched = created
    if touched is None:
        return None

    age = _finite(stale_after)
    if age is None or age < 0:
        age = CURSOR_STALE_SECONDS
    if not cursor_running:
        # A pending row belongs to the editor too; a closed Cursor must not
        # leave a stale waiting badge behind after a crash or restart.
        return None
    if cursor_launched_at is not None and math.isfinite(cursor_launched_at):
        if touched < cursor_launched_at:
            return None
    if not -5 <= now - touched <= age:
        return None

    if blocked:
        state = "waiting"
        since = last_write if last_write is not None else created
        if since is None:
            since = now
        waiting_for = "needs your input"
    else:
        # unfinishedRunAt is Cursor's explicit in-flight bit.  Without it,
        # ordinary chat history is not an activity session.
        if run_start is None:
            return None
        state = "busy"
        # Busy rows are dated from the composer start, while the checkpoint
        # decides whether that run is still alive.
        since = run_start
        waiting_for = None

    return {
        "name": _clean_text(head.get("name"), "Untitled chat") or "Untitled chat",
        "detail": _clean_text(head.get("subtitle"), "Cursor") or "Cursor",
        "state": state,
        "since": isoformat(since),
        "waitingFor": waiting_for,
        "derived": False,
    }


def _proc_cmdline(pid_dir: Path) -> list[str]:
    raw = _read_limited(pid_dir / "cmdline", 16 * 1024)
    if raw is None:
        return []
    return [part.decode("utf-8", "replace") for part in raw.split(b"\0") if part]


def _proc_exe(pid_dir: Path) -> str:
    try:
        return os.readlink(pid_dir / "exe")
    except (OSError, ValueError):
        return ""


def _looks_like_cursor(value: str) -> bool:
    if not value:
        return False
    try:
        basename = Path(value.rstrip("/")).name.casefold()
    except (ValueError, OSError):
        basename = value.casefold().rsplit("/", 1)[-1]
    # Cursor's Linux binary is named Cursor/cursor.  Keep this exact so an
    # unrelated argument or document containing the word "cursor" cannot make
    # the helper believe an editor is running.
    return basename in {
        "cursor",
        "cursor-bin",
        "cursor.appimage",
        "cursor.exe",
    }


def _cursor_process_info(
    *,
    proc_root: Path | str = "/proc",
    current_uid: Optional[int] = None,
) -> tuple[bool, Optional[float]]:
    """Return (editor found, earliest known editor start epoch)."""

    root = Path(proc_root)
    uid = os.getuid() if current_uid is None else int(current_uid)
    found = False
    starts: list[float] = []
    try:
        entries = os.scandir(root)
    except (OSError, ValueError):
        return False, None
    try:
        for entry in entries:
            if not entry.name.isdigit():
                continue
            try:
                pid_dir = Path(entry.path)
                pid = int(entry.name)
            except (TypeError, ValueError):
                continue
            if pid <= 0 or _proc_uid(pid_dir) != uid:
                continue
            if _proc_state(pid_dir) == "Z":
                continue
            command = _proc_cmdline(pid_dir)
            if not (_looks_like_cursor(_proc_exe(pid_dir)) or (
                command and _looks_like_cursor(command[0])
            )):
                continue
            found = True
            start = _proc_start_epoch(pid_dir, root)
            if start is not None and math.isfinite(start):
                starts.append(start)
    finally:
        try:
            entries.close()
        except OSError:
            pass
    return found, min(starts) if starts else None


def cursor_launch_date(found: bool, launch_date: Any = None) -> Optional[float]:
    """Two-state launch-date behavior, kept public for test callers."""

    if not found:
        return None
    parsed = _epoch(launch_date)
    # A running process without a launch timestamp is represented by a distant
    # past value, allowing the freshness window to decide.
    return parsed if parsed is not None else float("-inf")


def find_cursor_launch_date(
    *,
    proc_root: Path | str = "/proc",
    current_uid: Optional[int] = None,
) -> Optional[float]:
    """Find the current same-UID Cursor process start time, if any."""

    found, start = _cursor_process_info(proc_root=proc_root, current_uid=current_uid)
    return cursor_launch_date(found, start)


def read_cursor_sessions(
    *,
    env: Optional[Mapping[str, str]] = None,
    store: Any = None,
    now: Any = None,
    stale_after: float = CURSOR_STALE_SECONDS,
    proc_root: Path | str = "/proc",
    current_uid: Optional[int] = None,
    cursor_launched_at: Any = _UNSET,
) -> list[dict[str, Any]]:
    """Read live Cursor ``composerHeaders`` rows from a WAL-aware store."""

    values = os.environ if env is None else env
    if store is None:
        config = _path_from(values.get("XDG_CONFIG_HOME"), values) or (_home(values) / ".config")
        store = config / "Cursor" / "User" / "globalStorage" / "state.vscdb"
    store_path = _path_from(store, values)
    if store_path is None:
        return []

    if cursor_launched_at is _UNSET:
        running, launch = _cursor_process_info(
            proc_root=proc_root,
            current_uid=current_uid,
        )
        launched = launch
    else:
        parsed = _epoch(cursor_launched_at)
        running = cursor_launched_at is not None
        launched = parsed
        if parsed is not None and parsed < -1e15:
            launched = None

    connection = _sqlite_connect_ro(store_path)
    if connection is None:
        return []
    current = _now_epoch(now)
    rows: list[Any] = []
    try:
        cursor = connection.execute(
            "SELECT value FROM composerHeaders WHERE isArchived = 0 "
            "ORDER BY recency DESC LIMIT 40"
        )
        rows = cursor.fetchmany(CURSOR_MAX_ROWS)
    except (sqlite3.Error, OSError, ValueError, TypeError):
        return []
    finally:
        try:
            connection.close()
        except sqlite3.Error:
            pass

    sessions: list[dict[str, Any]] = []
    for row in rows:
        if not row:
            continue
        raw = row[0]
        if isinstance(raw, bytes):
            data = raw
        elif isinstance(raw, str):
            data = raw.encode("utf-8", "replace")
        else:
            continue
        if len(data) > MAX_HEADER_BYTES:
            continue
        try:
            head = _decode_json(data)
        except (UnicodeDecodeError, ValueError, TypeError, json.JSONDecodeError):
            continue
        if not isinstance(head, dict):
            continue
        try:
            session = _cursor_session(
                head,
                cursor_running=running,
                cursor_launched_at=launched,
                stale_after=stale_after,
                now=current,
            )
        except (TypeError, ValueError, OverflowError):
            session = None
        if session is not None:
            sessions.append(session)
    sessions.sort(key=lambda item: item.get("since", ""), reverse=True)
    return sessions


def _codex_home(env: Mapping[str, str]) -> Path:
    configured = env.get("CODEX_HOME")
    if configured:
        return _path_from(configured, env) or (_home(env) / ".codex")
    return _home(env) / ".codex"


def _newest_rollout_path(store: Path, env: Mapping[str, str]) -> Optional[Path]:
    connection = _sqlite_connect_ro(store)
    if connection is None:
        return None
    rows: list[Any] = []
    try:
        cursor = connection.execute(
            "SELECT rollout_path FROM threads WHERE archived = 0 "
            "ORDER BY updated_at_ms DESC LIMIT 8"
        )
        rows = cursor.fetchmany(CODEX_MAX_ROLLOUT_PATHS)
    except (sqlite3.Error, OSError, ValueError, TypeError):
        return None
    finally:
        try:
            connection.close()
        except sqlite3.Error:
            pass

    for row in rows:
        if not row or not isinstance(row[0], (str, os.PathLike)):
            continue
        path = _path_from(row[0], env)
        if path is None:
            continue
        try:
            if path.is_file():
                return path
        except OSError:
            continue
    return None


def _newest_desktop_thread(store: Path) -> Optional[tuple[str, float]]:
    connection = _sqlite_connect_ro(store)
    if connection is None:
        return None
    row: Optional[Sequence[Any]] = None
    try:
        cursor = connection.execute(
            "SELECT source_updated_at, display_title, thread_id "
            "FROM local_thread_catalog ORDER BY source_updated_at DESC LIMIT 1"
        )
        row = cursor.fetchone()
    except (sqlite3.Error, OSError, ValueError, TypeError):
        return None
    finally:
        try:
            connection.close()
        except sqlite3.Error:
            pass
    if row is None or len(row) < 2:
        return None
    updated = _finite(row[0])
    if updated is None:
        return None
    title = row[1] if isinstance(row[1], str) else ""
    return _clean_text(title, "Codex") or "Codex", updated


def read_codex_sessions(
    *,
    env: Optional[Mapping[str, str]] = None,
    state_store: Any = None,
    desktop_store: Any = None,
    now: Any = None,
    stale_after: float = CODEX_STALE_SECONDS,
) -> list[dict[str, Any]]:
    """Read the newest indexed Codex rollout or desktop thread metadata."""

    values = os.environ if env is None else env
    home = _codex_home(values)
    state_path = _path_from(state_store, values) if state_store is not None else home / "state_5.sqlite"
    desktop_path = (
        _path_from(desktop_store, values)
        if desktop_store is not None
        else home / "sqlite" / "codex-dev.db"
    )
    current = _now_epoch(now)
    candidates: list[tuple[float, str]] = []

    if state_path is not None:
        rollout = _newest_rollout_path(state_path, values)
        if rollout is not None:
            try:
                modified = float(rollout.stat().st_mtime)
                if math.isfinite(modified):
                    candidates.append((modified, "Codex"))
            except (OSError, ValueError, TypeError):
                pass

    if desktop_path is not None:
        desktop = _newest_desktop_thread(desktop_path)
        if desktop is not None:
            candidates.append((desktop[1], desktop[0]))

    if not candidates:
        return []
    modified, name = max(candidates, key=lambda item: item[0])
    age = _finite(stale_after)
    if age is None or age < 0:
        age = CODEX_STALE_SECONDS
    if not -5 <= current - modified <= age:
        return []
    return [{
        "name": _clean_text(name, "Codex") or "Codex",
        "detail": "Recent activity (estimated)",
        "state": "busy",
        "since": isoformat(modified),
        "waitingFor": None,
        "derived": True,
    }]


def enabled_providers(value: Any) -> list[str]:
    """Normalize a provider list while preserving the requested order."""

    if isinstance(value, str):
        raw: Iterable[Any] = value.split(",")
    elif isinstance(value, Iterable):
        raw = value
    else:
        raw = ()
    result: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        provider = item.strip().lower()
        if provider in PROVIDERS and provider not in result:
            result.append(provider)
    return result


def _demo_session(provider: str, now: float) -> dict[str, Any]:
    names = {"claude": "Claude Code", "cursor": "Cursor", "codex": "Codex"}
    waiting = provider == "cursor"
    return {
        "name": names[provider],
        "detail": "Demo session" if not waiting else "Demo session needs input",
        "state": "waiting" if waiting else "busy",
        "since": isoformat(now),
        "waitingFor": "needs your input" if waiting else None,
        "derived": provider == "codex",
    }


def read_activity(
    providers: Any,
    *,
    demo: bool = False,
    env: Optional[Mapping[str, str]] = None,
    now: Any = None,
    config_dir: Any = None,
    cursor_store: Any = None,
    codex_state_store: Any = None,
    codex_desktop_store: Any = None,
    proc_root: Path | str = "/proc",
    current_uid: Optional[int] = None,
    cursor_launched_at: Any = _UNSET,
) -> dict[str, Any]:
    """Return the versioned activity payload for enabled providers."""

    requested = enabled_providers(providers)
    # This early return is intentional: an empty enablement set performs no
    # environment lookup, proc scan, directory read, or SQLite open.
    if not requested:
        return {"version": VERSION, "providers": []}

    current = _now_epoch(now)
    if demo:
        return {
            "version": VERSION,
            "providers": [
                {"id": provider, "sessions": [_demo_session(provider, current)]}
                for provider in requested
            ],
        }

    values = os.environ if env is None else env
    result: list[dict[str, Any]] = []
    for provider in requested:
        try:
            if provider == "claude":
                sessions = read_claude_sessions(
                    env=values,
                    config_dir=config_dir,
                    now=current,
                    proc_root=proc_root,
                    current_uid=current_uid,
                )
            elif provider == "cursor":
                sessions = read_cursor_sessions(
                    env=values,
                    store=cursor_store,
                    now=current,
                    proc_root=proc_root,
                    current_uid=current_uid,
                    cursor_launched_at=cursor_launched_at,
                )
            else:
                sessions = read_codex_sessions(
                    env=values,
                    state_store=codex_state_store,
                    desktop_store=codex_desktop_store,
                    now=current,
                )
        except Exception:
            # A malformed local database/file is an unknown activity reading;
            # it must not make the helper fail for the other enabled providers.
            sessions = []
        result.append({"id": provider, "sessions": sessions})
    return {"version": VERSION, "providers": result}


# Friendly aliases for embedding callers.
build_payload = read_activity
read = read_activity


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Read local Ledge agent activity")
    parser.add_argument(
        "--providers",
        default="",
        help="comma-separated enabled providers: claude,cursor,codex",
    )
    parser.add_argument("--demo", action="store_true", help="emit synthetic sessions without I/O")
    args = parser.parse_args(argv)
    payload = read_activity(args.providers, demo=args.demo)
    json.dump(payload, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
