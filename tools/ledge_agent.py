#!/usr/bin/env python3
"""Report a coding agent's state to Ledge.

As a Claude Code hook it reads the hook's JSON on stdin and writes
``~/.local/share/ledge/agents/<session_id>.json``:

    UserPromptSubmit -> working
    Notification     -> waiting (permission | input | unknown)
    Stop             -> finished
    SessionEnd       -> the file is deleted

Only the session id, folder, state, the agent's pid and a time are written.
Message text is never stored. Any script can also report directly:

    ledge_agent.py --id build-bot --tool mybot --state working --cwd .

Python standard library only.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Mapping, Optional

VERSION = 1
STATES = ('working', 'waiting', 'idle', 'finished', 'error', 'running')
EVENTS = {'UserPromptSubmit': 'working', 'Notification': 'waiting', 'Stop': 'finished'}
MAX_STEPS = 32
MAX_INPUT = 1 << 20
SAFE_ID = re.compile(r'[^A-Za-z0-9._-]')


def agents_dir(env: Mapping[str, str] = os.environ) -> Path:
    base = env.get('XDG_DATA_HOME') or str(Path(env.get('HOME') or Path.home()) / '.local' / 'share')
    return Path(base) / 'ledge' / 'agents'


def waiting_for(event: Mapping[str, Any]) -> str:
    """permission | input | unknown, decided from the notification without keeping its text."""
    kind = str(event.get('notification_type') or '').lower()
    text = str(event.get('message') or '').lower()
    if 'permission' in kind or 'permission' in text:
        return 'permission'
    if 'idle' in kind or 'input' in kind or 'waiting for your input' in text:
        return 'input'
    return 'unknown'


def _cmdline(pid: int, proc: Path) -> list[str]:
    try:
        return (proc / str(pid) / 'cmdline').read_bytes().decode(errors='replace').split('\0')
    except OSError:
        return []


def _parent(pid: int, proc: Path) -> Optional[int]:
    try:
        stat = (proc / str(pid) / 'stat').read_text()
        return int(stat[stat.rindex(')') + 2:].split()[1])
    except (OSError, ValueError, IndexError):
        return None


def agent_pid(tool: str, start: int, proc: Path = Path('/proc')) -> Optional[int]:
    """The nearest ancestor of `start` whose argv[0] or argv[1] basename is `tool`."""
    pid = start
    for _ in range(MAX_STEPS):
        if pid is None or pid <= 1:
            return None
        args = _cmdline(pid, proc)
        names = [Path(a).name.removesuffix('.js') for a in args[:2]]
        if tool in names:
            return pid
        pid = _parent(pid, proc)
    return None


def record(session: str, tool: str, state: str, cwd: str, pid: Optional[int], wait: Optional[str], now: dt.datetime) -> dict:
    return {'version': VERSION, 'id': session, 'tool': tool, 'state': state, 'cwd': cwd, 'pid': pid,
            'waitingFor': wait if state == 'waiting' else None, 'updatedAt': now.astimezone(dt.timezone.utc).isoformat()}


def write(directory: Path, data: Mapping[str, Any]) -> Path:
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / f"{SAFE_ID.sub('_', data['id'])[:100]}.json"
    handle, temp = tempfile.mkstemp(dir=directory, prefix='.agent-')
    try:
        os.fchmod(handle, 0o600)
        with os.fdopen(handle, 'w') as stream:
            json.dump(data, stream)
        os.replace(temp, path)
    except OSError:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise
    return path


def remove(directory: Path, session: str) -> None:
    try:
        (directory / f"{SAFE_ID.sub('_', session)[:100]}.json").unlink()
    except OSError:
        pass


def from_hook(event: Mapping[str, Any], env: Mapping[str, str], now: dt.datetime, start_pid: int,
              proc: Path = Path('/proc')) -> Optional[Path]:
    """Handles one Claude Code hook event. Returns the path written, if any."""
    session = str(event.get('session_id') or '')
    name = event.get('hook_event_name')
    if not session:
        return None
    directory = agents_dir(env)
    if name == 'SessionEnd':
        remove(directory, session)
        return None
    state = EVENTS.get(name)
    if not state:
        return None
    wait = waiting_for(event) if state == 'waiting' else None
    pid = agent_pid('claude', start_pid, proc)
    return write(directory, record(session, 'claude', state, str(event.get('cwd') or '')[:4096], pid, wait, now))


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--id')
    parser.add_argument('--tool', default='agent')
    parser.add_argument('--state', choices=STATES)
    parser.add_argument('--cwd', default='.')
    parser.add_argument('--pid', type=int)
    parser.add_argument('--waiting-for', choices=('permission', 'input', 'unknown'))
    parser.add_argument('--remove', action='store_true')
    args = parser.parse_args(argv)
    now = dt.datetime.now(dt.timezone.utc)
    if args.id:
        if args.remove:
            remove(agents_dir(), args.id)
        elif args.state:
            write(agents_dir(), record(args.id, args.tool, args.state, os.path.abspath(args.cwd), args.pid or os.getppid(),
                                       args.waiting_for or 'unknown', now))
        return 0
    try:
        event = json.loads(sys.stdin.read(MAX_INPUT) or '{}')
    except ValueError:
        return 0
    # A hook must never break the agent: any failure is silent.
    try:
        from_hook(event if isinstance(event, dict) else {}, os.environ, now, os.getppid())
    except OSError:
        pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
