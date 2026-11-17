#!/usr/bin/env python3
"""Request counts from LM Studio's local server logs.

Reads ``~/.lmstudio/server-logs/<YYYY-MM>/<YYYY-MM-DD>.<n>.log`` from where
the last run stopped. Only each line's timestamp and request path are
matched; request bodies and replies are never parsed or kept. Embedding
requests are not counted. Built against the documented log layout; not yet
checked against a live LM Studio install.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Mapping, Optional

VERSION = 1
MAX_LINES = 100_000
MAX_LINE_BYTES = 1 << 20
REQUEST = re.compile(rb"^\[?(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})[^\]]*\]?.*?Received (GET|POST) request to (/v1/[a-z/_]+|/api/v\d/[a-z/_]+)")
EXCLUDED = ("embeddings",)


def parse_line(line: bytes) -> Optional[tuple[str, str, str]]:
    """(day, time, endpoint) of a request line, or None."""

    match = REQUEST.match(line)
    if not match:
        return None
    endpoint = match.group(4).decode("ascii")
    if any(word in endpoint for word in EXCLUDED):
        return None
    return match.group(1).decode(), match.group(2).decode(), endpoint


def _logs(env: Mapping[str, str]) -> list[Path]:
    root = Path(env.get("HOME") or Path.home()) / ".lmstudio" / "server-logs"
    try:
        return sorted(root.glob("*/*.log"))[-62:]
    except OSError:
        return []


def scan(index: dict, env: Mapping[str, str]) -> None:
    files = index.setdefault("files", {})
    days = index.setdefault("days", {})
    budget = MAX_LINES
    seen = set()
    for path in _logs(env):
        key = str(path)
        seen.add(key)
        try:
            size = path.stat().st_size
        except OSError:
            continue
        offset = files.get(key, 0)
        if size < offset:
            offset = 0
        try:
            with path.open("rb") as stream:
                stream.seek(offset)
                while budget > 0:
                    line = stream.readline(MAX_LINE_BYTES + 1)
                    if not line.endswith(b"\n"):
                        break
                    budget -= 1
                    offset = stream.tell()
                    found = parse_line(line)
                    if found:
                        day, time, endpoint = found
                        row = days.setdefault(day, {"requests": 0, "endpoints": {}, "last": ""})
                        row["requests"] += 1
                        row["endpoints"][endpoint] = row["endpoints"].get(endpoint, 0) + 1
                        row["last"] = max(row["last"], f"{day}T{time}")
        except OSError:
            continue
        files[key] = offset
    for key in list(files):
        if key not in seen:
            del files[key]


def summary(index: Mapping[str, Any], today: _dt.date) -> dict[str, Any]:
    row = index.get("days", {}).get(today.isoformat(), {})
    week = [(today - _dt.timedelta(days=n)).isoformat() for n in range(7)]
    return {"version": VERSION, "today": row.get("requests", 0),
            "week": sum(index.get("days", {}).get(day, {}).get("requests", 0) for day in week),
            "endpoints": dict(sorted(row.get("endpoints", {}).items(), key=lambda item: -item[1])[:4]),
            "last": row.get("last") or None, "logs": bool(index.get("files"))}


def _index_path(env: Mapping[str, str]) -> Path:
    base = env.get("XDG_CACHE_HOME") or str(Path(env.get("HOME") or Path.home()) / ".cache")
    return Path(base) / "ledge" / "lmstudio.json"


def read_document(env: Mapping[str, str], today: Optional[_dt.date] = None) -> dict[str, Any]:
    today = today or _dt.date.today()
    path = _index_path(env)
    try:
        index = json.loads(path.read_text())
        if not isinstance(index, dict):
            raise ValueError
    except (OSError, ValueError):
        index = {}
    scan(index, env)
    first = (today - _dt.timedelta(days=35)).isoformat()
    index["days"] = {day: row for day, row in index.get("days", {}).items() if day >= first}
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        handle, temp = tempfile.mkstemp(dir=path.parent, prefix=".lmstudio-")
        os.fchmod(handle, 0o600)
        with os.fdopen(handle, "w") as stream:
            json.dump(index, stream)
        os.replace(temp, path)
    except OSError:
        pass
    return summary(index, today)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", action="store_true")
    args = parser.parse_args(argv)
    if args.demo:
        document = {"version": VERSION, "today": 42, "week": 230, "logs": True,
                    "endpoints": {"/v1/chat/completions": 38, "/v1/completions": 4}, "last": None}
    else:
        document = read_document(os.environ)
    json.dump(document, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
