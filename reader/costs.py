#!/usr/bin/env python3
"""Estimated spend from local Claude Code and Codex transcripts.

Reads token counts only: model ids, timestamps, the working folder's last
path part and usage numbers. Message text is never kept. An index in
``~/.cache/ledge/costs.json`` remembers how far each file was read, so a
warm run reads only appended lines.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

VERSION = 1
INDEX_VERSION = 1
PRICED_AT = "2026-11-03"
LABEL = f"estimate at API list prices, {PRICED_AT}"
MAX_LINES = 200_000          # per run, across all files
MAX_LINE_BYTES = 4 << 20     # a longer line is skipped
MAX_FILES = 4096
RECENT_IDS = 64              # Claude message ids kept per file for dedupe
DAYS_KEPT = 35
TOP_PROJECTS = 3

# USD per million tokens. Claude: (input, cache read, cache write 5 min,
# output). OpenAI: (input, cached input, output); cached input is a part of
# input and reasoning a part of output.
CLAUDE_PRICES = {
    "claude-fable-5-2": (8.0, 0.20, 10.0, 40.0),
    "claude-fable-5-1": (10.0, 1.0, 12.5, 50.0),
    "claude-fable-5": (10.0, 1.0, 12.5, 50.0),
    "claude-opus-5-5": (4.0, 0.20, 5.0, 20.0),
    "claude-opus-5": (5.0, 0.50, 6.25, 25.0),
    "claude-opus-4": (5.0, 0.50, 6.25, 25.0),
    "claude-sonnet-5-5": (2.0, 0.10, 2.5, 10.0),
    "claude-sonnet-5": (2.0, 0.20, 2.5, 10.0),
    "claude-sonnet-4": (3.0, 0.30, 3.75, 15.0),
    "claude-haiku-5-5": (0.10, 0.01, 0.125, 0.50),
    "claude-haiku-4": (1.0, 0.10, 1.25, 5.0),
}
OPENAI_PRICES = {
    "gpt-5": (1.25, 0.125, 10.0),
    "gpt-5-mini": (0.25, 0.025, 2.0),
    "codex-mini": (1.5, 0.375, 6.0),
}


def price(table: Mapping[str, tuple], model: str) -> Optional[tuple]:
    """The longest table key that `model` starts with, so dated or minor
    variants share their family's price."""

    for key in sorted(table, key=len, reverse=True):
        if model == key or model.startswith(key + "-") or model.startswith(key + "."):
            return table[key]
    return None


def claude_cost(model: str, usage: Mapping[str, int]) -> Optional[float]:
    """Cache reads and writes are billed apart from input."""

    p = price(CLAUDE_PRICES, model)
    if p is None:
        return None
    return (usage.get("input", 0) * p[0] + usage.get("cache_read", 0) * p[1]
            + usage.get("cache_write", 0) * p[2] + usage.get("output", 0) * p[3]) / 1e6


def openai_cost(model: str, usage: Mapping[str, int]) -> Optional[float]:
    """Cached input is part of input; reasoning is already part of output."""

    p = price(OPENAI_PRICES, model)
    if p is None:
        return None
    cached = min(usage.get("cached", 0), usage.get("input", 0))
    return ((usage.get("input", 0) - cached) * p[0] + cached * p[1] + usage.get("output", 0) * p[2]) / 1e6


def _int(value: Any) -> int:
    return value if isinstance(value, int) and value > 0 else 0


def _day(timestamp: Any) -> Optional[str]:
    if not isinstance(timestamp, str):
        return None
    try:
        moment = _dt.datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=_dt.timezone.utc)
    return moment.astimezone().date().isoformat()


def _project(cwd: Any) -> str:
    return Path(cwd).name[:64] if isinstance(cwd, str) and cwd else "unknown"


def _add(buckets: dict, day: str, project: str, model: str, usage: Mapping[str, int]) -> None:
    key = f"{day}|{project}|{model}"
    row = buckets.setdefault(key, {})
    for name, value in usage.items():
        if value:
            row[name] = row.get(name, 0) + value


def claude_line(record: Any, state: dict, buckets: dict) -> None:
    """One Claude transcript record. Repeated message ids are counted once."""

    if not isinstance(record, dict):
        return
    message = record.get("message")
    if not isinstance(message, dict) or not isinstance(message.get("usage"), dict):
        return
    model = message.get("model")
    day = _day(record.get("timestamp"))
    if not isinstance(model, str) or model.startswith("<") or day is None:
        return
    ident = f"{message.get('id')}:{record.get('requestId')}"
    recent = state.setdefault("recent", [])
    if message.get("id") and ident in recent:
        return
    recent.append(ident)
    del recent[:-RECENT_IDS]
    u = message["usage"]
    _add(buckets, day, _project(record.get("cwd")), model[:64], {
        "input": _int(u.get("input_tokens")), "cache_read": _int(u.get("cache_read_input_tokens")),
        "cache_write": _int(u.get("cache_creation_input_tokens")), "output": _int(u.get("output_tokens"))})


CODEX_FIELDS = (("input", "input_tokens"), ("cached", "cached_input_tokens"), ("output", "output_tokens"))


def codex_line(record: Any, state: dict, buckets: dict) -> None:
    """One Codex rollout record. Token events repeat, so the change in
    `total_token_usage` is counted; `last_token_usage` only when no total."""

    if not isinstance(record, dict) or not isinstance(record.get("payload"), dict):
        return
    payload = record["payload"]
    kind = record.get("type")
    if kind == "session_meta":
        state["project"] = _project(payload.get("cwd"))
        return
    if kind == "turn_context" and isinstance(payload.get("model"), str):
        state["model"] = payload["model"][:64]
        return
    if payload.get("type") != "token_count" or not isinstance(payload.get("info"), dict):
        return
    info = payload["info"]
    total = info.get("total_token_usage")
    if isinstance(total, dict):
        before = state.get("total", {})
        now = {name: _int(total.get(field)) for name, field in CODEX_FIELDS}
        usage = {name: max(0, now[name] - before.get(name, 0)) for name in now}
        state["total"] = now
    elif isinstance(info.get("last_token_usage"), dict):
        last = info["last_token_usage"]
        usage = {name: _int(last.get(field)) for name, field in CODEX_FIELDS}
    else:
        return
    day = _day(record.get("timestamp"))
    if day and any(usage.values()):
        _add(buckets, day, state.get("project", "unknown"), state.get("model", "gpt-5"), usage)


def _files(provider: str, env: Mapping[str, str]) -> list[Path]:
    home = Path(env.get("HOME") or Path.home())
    if provider == "claude":
        root = Path(env.get("CLAUDE_CONFIG_DIR") or home / ".claude") / "projects"
        pattern = "**/*.jsonl"
    else:
        root = Path(env.get("CODEX_HOME") or home / ".codex") / "sessions"
        pattern = "**/rollout-*.jsonl"
    try:
        return sorted(root.glob(pattern))[-MAX_FILES:]
    except OSError:
        return []


def scan(index: dict, env: Mapping[str, str], budget: list) -> None:
    """Reads new lines of every transcript into `index`, in place."""

    files = index.setdefault("files", {})
    seen = set()
    for provider, handle in (("claude", claude_line), ("codex", codex_line)):
        for path in _files(provider, env):
            key = str(path)
            seen.add(key)
            try:
                info = path.stat()
            except OSError:
                continue
            entry = files.get(key)
            if not entry or entry.get("provider") != provider or info.st_size < entry.get("offset", 0):
                entry = {"provider": provider, "offset": 0, "state": {}, "buckets": {}}
            files[key] = entry
            if info.st_size == entry["offset"] and entry.get("mtime") == info.st_mtime:
                continue
            _read(path, entry, handle, budget)
            entry["mtime"] = info.st_mtime
    for key in list(files):
        if key not in seen:
            del files[key]


def _read(path: Path, entry: dict, handle, budget: list) -> None:
    try:
        with path.open("rb") as stream:
            stream.seek(entry["offset"])
            while budget[0] > 0:
                line = stream.readline(MAX_LINE_BYTES + 1)
                if not line or not line.endswith(b"\n"):
                    break  # an unfinished line is read on the next run
                entry["offset"] += len(line)
                budget[0] -= 1
                if len(line) > MAX_LINE_BYTES:
                    stream.readline()  # skip the rest of an oversized line
                    entry["offset"] = stream.tell()
                    continue
                if b'"usage"' not in line and b"token_count" not in line and b"session_meta" not in line \
                        and b"turn_context" not in line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                handle(record, entry["state"], entry["buckets"])
    except OSError:
        return


def _prune(index: dict, today: _dt.date) -> None:
    first = (today - _dt.timedelta(days=DAYS_KEPT)).isoformat()
    for entry in index.get("files", {}).values():
        entry["buckets"] = {k: v for k, v in entry.get("buckets", {}).items() if k.split("|", 1)[0] >= first}


def summary(index: Mapping[str, Any], today: _dt.date) -> dict[str, Any]:
    week_start = (today - _dt.timedelta(days=6)).isoformat()
    day = today.isoformat()
    result: dict[str, Any] = {}
    for provider, cost in (("claude", claude_cost), ("codex", openai_cost)):
        today_cost = week_cost = 0.0
        unpriced = 0
        projects: dict[str, float] = {}
        for entry in index.get("files", {}).values():
            if entry.get("provider") != provider:
                continue
            for key, usage in entry.get("buckets", {}).items():
                when, project, model = key.split("|", 2)
                if when < week_start:
                    continue
                value = cost(model, usage)
                if value is None:
                    unpriced += sum(usage.values())
                    continue
                week_cost += value
                projects[project] = projects.get(project, 0.0) + value
                if when == day:
                    today_cost += value
        top = sorted(projects.items(), key=lambda item: (-item[1], item[0]))[:TOP_PROJECTS]
        result[provider] = {"today": round(today_cost, 4), "week": round(week_cost, 4),
                            "projects": [{"name": name, "cost": round(value, 4)} for name, value in top],
                            "unpricedTokens": unpriced}
    return result


def demo_document() -> dict[str, Any]:
    return {"version": VERSION, "label": LABEL, "providers": {
        "claude": {"today": 4.82, "week": 31.4, "unpricedTokens": 0, "projects": [
            {"name": "ledge", "cost": 18.2}, {"name": "notes", "cost": 9.75}, {"name": "site", "cost": 3.45}]},
        "codex": {"today": 0.61, "week": 2.9, "unpricedTokens": 0, "projects": [{"name": "ledge", "cost": 2.9}]},
    }}


def _index_path(env: Mapping[str, str]) -> Path:
    base = env.get("XDG_CACHE_HOME") or str(Path(env.get("HOME") or Path.home()) / ".cache")
    return Path(base) / "ledge" / "costs.json"


def _load(path: Path) -> dict:
    try:
        data = json.loads(path.read_text())
        if isinstance(data, dict) and data.get("version") == INDEX_VERSION:
            return data
    except (OSError, ValueError):
        pass
    return {"version": INDEX_VERSION, "files": {}}


def _save(path: Path, index: Mapping[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=path.parent, prefix=".costs-")
    try:
        os.fchmod(handle, 0o600)
        with os.fdopen(handle, "w") as stream:
            json.dump(index, stream, separators=(",", ":"))
        os.replace(temp, path)
    except OSError:
        try:
            os.unlink(temp)
        except OSError:
            pass


def read_document(env: Mapping[str, str], today: Optional[_dt.date] = None) -> dict[str, Any]:
    today = today or _dt.date.today()
    path = _index_path(env)
    index = _load(path)
    scan(index, env, [MAX_LINES])
    _prune(index, today)
    _save(path, index)
    return {"version": VERSION, "label": LABEL, "providers": summary(index, today)}


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", action="store_true")
    args = parser.parse_args(list(argv) if argv is not None else None)
    document = demo_document() if args.demo else read_document(os.environ)
    json.dump(document, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
