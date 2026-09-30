#!/usr/bin/python3
"""Bounded, read-only usage reader for the Ledge GNOME Shell extension.

The program deliberately has a small surface.  It reads the local state that
Claude Code, Cursor, and Codex already maintain, asks the vendor endpoints
when a borrowed credential is available, and prints one JSON document.  It
does not refresh credentials, write to another application's database, or
emit diagnostic text on stdout.

The parser functions are kept public because the vendor payloads change more
often than the rest of the reader and are easiest to exercise independently.
"""

from __future__ import annotations

import argparse
import ctypes
import datetime as _dt
import email.utils
import json
import math
import os
from pathlib import Path
import selectors
import shutil
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time
from typing import Any, Callable, Iterable, Mapping, Optional
import urllib.error
import urllib.request


VERSION = 1
MAX_FILE_BYTES = 256 * 1024
MAX_HTTP_BYTES = 512 * 1024
MAX_PROTOCOL_BYTES = 512 * 1024
CODEX_STALE_SECONDS = 5 * 60
NETWORK_TIMEOUT = 10.0

PROVIDER_NAMES = {
    "codex": "Codex",
    "claude": "Claude Code",
    "cursor": "Cursor",
}

_MISSING = object()


class UsageParseError(ValueError):
    """The vendor returned a shape that this reader cannot safely use."""


class ProviderProblem(Exception):
    """An expected provider failure with a safe, user-facing message."""

    def __init__(self, status: str, message: str, retry_after: Optional[float] = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.retry_after = retry_after


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject every redirect so a credential never follows another origin."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None

    def http_error_301(self, req, fp, code, msg, headers):
        raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)

    http_error_302 = http_error_301
    http_error_303 = http_error_301
    http_error_307 = http_error_301
    http_error_308 = http_error_301


def _utc_now() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc)


def isoformat(value: _dt.datetime) -> str:
    """Return one stable UTC ISO-8601 spelling for the JSON contract."""

    if value.tzinfo is None:
        value = value.replace(tzinfo=_dt.timezone.utc)
    value = value.astimezone(_dt.timezone.utc)
    # Milliseconds keep vendor timestamps readable while avoiding float noise.
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_iso(value: Any) -> Optional[_dt.datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z") or text.endswith("z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = _dt.datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_dt.timezone.utc)
    return parsed.astimezone(_dt.timezone.utc)


def _finite_number(value: Any, field: str = "number") -> Optional[float]:
    """Read a JSON number while keeping null/missing distinct from zero."""

    if value is _MISSING or value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise UsageParseError(f"{field} is not a number")
    number = float(value)
    if not math.isfinite(number):
        raise UsageParseError(f"{field} is not finite")
    return number


def _percent(value: Any, field: str) -> Optional[float]:
    number = _finite_number(value, field)
    if number is None:
        return None
    # Vendor dashboards can report an allowance overspend.  It is still a
    # real reading; the UI decides how to draw values above a full ring.
    if number < 0:
        raise UsageParseError(f"{field} is negative")
    return number


def _field(obj: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        if name in obj:
            return obj[name]
    return _MISSING


def _json_loads(value: Any) -> Any:
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    if isinstance(value, str):
        def reject_constant(token: str):
            raise ValueError(f"invalid JSON constant {token}")

        return json.loads(value, parse_constant=reject_constant)
    return value


def _object(value: Any, name: str) -> Mapping[str, Any]:
    try:
        result = _json_loads(value)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise UsageParseError(f"{name} is malformed JSON") from exc
    if not isinstance(result, dict):
        raise UsageParseError(f"{name} is not an object")
    return result


def _reset(value: Any, field: str = "resetsAt") -> Optional[_dt.datetime]:
    """Parse ISO strings or epoch seconds; null and unknown stay unknown."""

    if value is _MISSING or value is None:
        return None
    if isinstance(value, str):
        return _parse_iso(value)
    number = _finite_number(value, field)
    if number is None:
        return None
    # Epoch milliseconds are used by credentials, while usage windows use
    # seconds.  Accepting both is safe and keeps the output honest.
    if abs(number) >= 100_000_000_000:
        number /= 1000.0
    try:
        return _dt.datetime.fromtimestamp(number, tz=_dt.timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def _window(window_id: str, label: str, percent: float,
            reset: Optional[_dt.datetime]) -> dict[str, Any]:
    return {
        "id": window_id,
        "label": label,
        "usedPercent": float(percent),
        "resetsAt": isoformat(reset) if reset is not None else None,
    }


def _kind_label(kind: str) -> str:
    return {
        "session": "Current session",
        "weekly_all": "All models",
        "weekly_opus": "Opus",
        "weekly_sonnet": "Sonnet",
    }.get(kind, kind.replace("weekly_", "").replace("_", " ").title())


def _claude_order(item: Mapping[str, Any]) -> tuple[int, str]:
    window_id = str(item.get("id", ""))
    rank = {"session": 0, "weekly_all": 1}.get(window_id, 2)
    return rank, window_id


def parse_claude_usage(payload: Any) -> list[dict[str, Any]]:
    """Translate Claude Code's ``/api/oauth/usage`` payload into windows."""

    root = _object(payload, "Claude usage response")
    windows: list[dict[str, Any]] = []
    limits = root.get("limits", _MISSING)
    if limits is not _MISSING and limits is not None:
        if not isinstance(limits, list):
            raise UsageParseError("Claude limits is not an array")
        for entry in limits:
            if not isinstance(entry, dict):
                raise UsageParseError("Claude limit is not an object")
            kind = entry.get("kind")
            if not isinstance(kind, str) or not kind.strip():
                continue
            percent = _percent(_field(entry, "percent", "usedPercent", "used_percent"),
                               "Claude percent")
            if percent is None:
                continue
            reset = _reset(_field(entry, "resetsAt", "resets_at"), "Claude resetsAt")
            windows.append(_window(kind, _kind_label(kind), percent, reset))

    # Older Claude Code responses expose the same readings under named keys.
    for value, window_id, label in (
        (_field(root, "fiveHour", "five_hour"), "session", "Current session"),
        (_field(root, "sevenDay", "seven_day"), "weekly_all", "All models"),
    ):
        if value is _MISSING or value is None:
            continue
        if not isinstance(value, dict):
            raise UsageParseError("Claude named window is not an object")
        percent = _percent(_field(value, "utilization", "percent", "usedPercent", "used_percent"),
                          f"Claude {window_id} percent")
        if percent is None:
            continue
        if any(item.get("id") == window_id for item in windows):
            continue
        reset = _reset(_field(value, "resetsAt", "resets_at"),
                       f"Claude {window_id} resetsAt")
        windows.append(_window(window_id, label, percent, reset))

    if not windows:
        raise UsageParseError("Claude reported no usage windows")
    return sorted(windows, key=_claude_order)


def parse_cursor_usage(payload: Any) -> list[dict[str, Any]]:
    """Translate Cursor's ``/api/usage-summary`` payload into windows."""

    root = _object(payload, "Cursor usage response")
    reset = _reset(root.get("billingCycleEnd", _MISSING), "Cursor billingCycleEnd")
    usage = root.get("individualUsage", {})
    if usage is None:
        usage = {}
    if not isinstance(usage, dict):
        raise UsageParseError("Cursor individualUsage is not an object")
    plan = usage.get("plan", {})
    if plan is None:
        plan = {}
    if not isinstance(plan, dict):
        raise UsageParseError("Cursor plan is not an object")

    windows: list[dict[str, Any]] = []
    total = _percent(plan.get("totalPercentUsed", _MISSING),
                     "Cursor totalPercentUsed")
    if total is not None:
        windows.append(_window("included", "Included usage", total, reset))

    # Match Cursor's own dashboard: an API bucket is useful when non-zero,
    # while an explicit total of zero remains a real reading above.
    api = _percent(plan.get("apiPercentUsed", _MISSING), "Cursor apiPercentUsed")
    if api is not None and api > 0:
        windows.append(_window("api", "API usage", api, reset))

    on_demand = usage.get("onDemand", _MISSING)
    if on_demand is not _MISSING and on_demand is not None:
        if not isinstance(on_demand, dict):
            raise UsageParseError("Cursor onDemand is not an object")
        enabled = on_demand.get("enabled", False)
        if enabled is not False and not isinstance(enabled, bool):
            raise UsageParseError("Cursor onDemand enabled is not boolean")
        limit = _finite_number(on_demand.get("limit", _MISSING), "Cursor onDemand limit")
        used = _finite_number(on_demand.get("used", _MISSING), "Cursor onDemand used")
        if enabled is True and limit is not None and limit > 0 and used is not None:
            if used < 0:
                raise UsageParseError("Cursor onDemand used is negative")
            ratio = used / limit * 100
            if not math.isfinite(ratio) or ratio < 0:
                raise UsageParseError("Cursor onDemand percentage is invalid")
            windows.append(_window("on_demand", "On demand", ratio, reset))

    if windows:
        return windows

    membership = root.get("membershipType", "this")
    if not isinstance(membership, str) or not membership.strip():
        membership = "this"
    if root.get("isUnlimited") is True:
        raise UsageParseError(f"Unlimited on the {membership} plan - nothing to meter")
    raise UsageParseError(f"The {membership} plan has nothing for Cursor to meter yet")


def _codex_rate_limits(value: Any) -> Optional[Mapping[str, Any]]:
    if not isinstance(value, dict):
        return None
    candidate = value.get("rate_limits", _MISSING)
    if isinstance(candidate, dict):
        return candidate
    candidate = value.get("rateLimits", _MISSING)
    if isinstance(candidate, dict):
        return candidate
    payload = value.get("payload")
    if isinstance(payload, dict):
        candidate = payload.get("rate_limits", _MISSING)
        if isinstance(candidate, dict):
            return candidate
        candidate = payload.get("rateLimits", _MISSING)
        if isinstance(candidate, dict):
            return candidate
        # A few rollout versions frame rate_limits below info.
        info = payload.get("info")
        if isinstance(info, dict):
            candidate = info.get("rate_limits", _MISSING)
            if isinstance(candidate, dict):
                return candidate
    return None


def _codex_label(minutes_value: Any, fallback: str) -> str:
    minutes = _finite_number(minutes_value, "Codex windowDurationMins")
    if minutes is None or minutes <= 0:
        return "Current session" if fallback == "primary" else "Longer window"
    if minutes < 60:
        return f"{int(minutes)}m limit"
    if minutes < 60 * 24:
        return f"{int(minutes / 60)}h limit"
    days = int(round(minutes / (60 * 24)))
    if days == 7:
        return "Weekly limit"
    if days == 30:
        return "Monthly limit"
    return f"{days}d limit"


def _codex_windows(limits: Mapping[str, Any], now: Optional[_dt.datetime] = None,
                   countdown: bool = True) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for window_id in ("primary", "secondary"):
        bucket = limits.get(window_id, _MISSING)
        if bucket is _MISSING or bucket is None:
            continue
        if not isinstance(bucket, dict):
            raise UsageParseError(f"Codex {window_id} window is not an object")
        percent = _percent(_field(bucket, "usedPercent", "used_percent"),
                           f"Codex {window_id} used percent")
        if percent is None:
            continue
        reset_value = _field(bucket, "resetsAt", "resets_at")
        reset = _reset(reset_value, f"Codex {window_id} resetsAt")
        if reset is None and countdown:
            countdown_value = _field(bucket, "resetsInSeconds", "resets_in_seconds")
            seconds = _finite_number(countdown_value,
                                     f"Codex {window_id} resetsInSeconds")
            if seconds is not None and now is not None:
                if seconds < 0:
                    raise UsageParseError("Codex reset countdown is negative")
                reset = now + _dt.timedelta(seconds=seconds)
        label = _codex_label(_field(bucket, "windowDurationMins", "window_duration_mins",
                                     "window_minutes"),
                             window_id)
        result.append(_window(window_id, label, percent, reset))
    if not result:
        raise UsageParseError("Codex reported no usage windows")
    return result


def parse_codex_response(payload: Any,
                         now: Optional[_dt.datetime] = None) -> list[dict[str, Any]]:
    """Translate an app-server ``account/rateLimits/read`` reply."""

    root = _object(payload, "Codex app-server response")
    result = root.get("result")
    if not isinstance(result, dict):
        raise UsageParseError("Codex app-server result is missing")
    limits = result.get("rateLimits", result.get("rate_limits"))
    if not isinstance(limits, dict):
        raise UsageParseError("Codex app-server rate limits are missing")
    return _codex_windows(limits, now=now, countdown=False)


def _timestamp_from_object(value: Mapping[str, Any]) -> Optional[_dt.datetime]:
    stamp = _field(value, "timestamp", "recordedAt", "recorded_at")
    parsed = _reset(stamp, "Codex timestamp") if stamp is not _MISSING else None
    if parsed is not None:
        return parsed
    payload = value.get("payload")
    if isinstance(payload, dict):
        stamp = _field(payload, "timestamp", "recordedAt", "recorded_at")
        if stamp is not _MISSING:
            return _reset(stamp, "Codex timestamp")
    return None


def _codex_snapshot_candidates(text: str) -> list[tuple[Optional[_dt.datetime], Mapping[str, Any], int]]:
    candidates: list[tuple[Optional[_dt.datetime], Mapping[str, Any], int]] = []
    for index, line in enumerate(text.splitlines()):
        if "rate_limits" not in line and "rateLimits" not in line:
            continue
        try:
            parsed = _json_loads(line)
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        if not isinstance(parsed, dict):
            continue
        limits = _codex_rate_limits(parsed)
        if limits is None:
            continue
        stamp = _timestamp_from_object(parsed)
        candidates.append((stamp, limits, index))
    return candidates


def codex_recorded_at(text: str) -> Optional[_dt.datetime]:
    """Return the newest actual timestamp in a rollout, if one exists."""

    candidates = _codex_snapshot_candidates(text)
    dated = [item for item in candidates if item[0] is not None]
    if not dated:
        return None
    return max(dated, key=lambda item: (item[0], item[2]))[0]


def parse_codex_rollout(text: str,
                        now: Optional[_dt.datetime] = None) -> list[dict[str, Any]]:
    """Translate the newest valid rate-limit snapshot in a rollout JSONL."""

    candidates = _codex_snapshot_candidates(text)
    if not candidates:
        raise UsageParseError("Codex has not recorded a usage snapshot yet")
    dated = [item for item in candidates if item[0] is not None]
    chosen = max(dated, key=lambda item: (item[0], item[2])) if dated else max(
        candidates, key=lambda item: item[2]
    )
    # A countdown is meaningful only relative to the instant Codex recorded
    # the snapshot.  Anchoring it to this fetch would make an old rollout look
    # as though its reset moved every time Ledge polled.
    return _codex_windows(chosen[1], now=chosen[0], countdown=True)


# Friendly aliases for callers embedding the helper.
claude_windows = parse_claude_usage
cursor_windows = parse_cursor_usage
codex_windows_from_rollout = parse_codex_rollout
codex_windows_from_response = parse_codex_response


def _read_bounded(handle: Any, limit: int) -> bytes:
    try:
        data = handle.read(limit + 1)
    except TypeError:
        data = handle.read()
    if not isinstance(data, (bytes, bytearray)):
        data = str(data).encode("utf-8", "replace")
    if len(data) > limit:
        raise ProviderProblem("error", "Provider response was too large")
    return bytes(data)


def _http_json(url: str, headers: Mapping[str, str]) -> tuple[int, bytes, Mapping[str, str], Optional[float]]:
    request = urllib.request.Request(url, headers=dict(headers), method="GET")
    opener = urllib.request.build_opener(_NoRedirectHandler())
    response = None
    try:
        response = opener.open(request, timeout=NETWORK_TIMEOUT)
        status = int(response.getcode() or 0)
        body = _read_bounded(response, MAX_HTTP_BYTES)
        response_headers = getattr(response, "headers", {}) or {}
        return status, body, response_headers, _retry_after(response_headers)
    except urllib.error.HTTPError as exc:
        # HTTPError is also a bounded file-like response.  Reading it is useful
        # only for enforcing the bound; its body is never surfaced or logged.
        try:
            _read_bounded(exc, MAX_HTTP_BYTES)
        except ProviderProblem:
            raise
        headers_out = getattr(exc, "headers", {}) or {}
        return int(exc.code), b"", headers_out, _retry_after(headers_out)
    except (TimeoutError, socket.timeout):
        raise ProviderProblem("error", "Provider request timed out")
    except urllib.error.URLError as exc:
        if isinstance(getattr(exc, "reason", None), (TimeoutError, socket.timeout)):
            raise ProviderProblem("error", "Provider request timed out")
        raise ProviderProblem("error", "Provider request failed")
    except ProviderProblem:
        raise
    except (OSError, ValueError):
        raise ProviderProblem("error", "Provider request failed")
    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                pass


def _retry_after(headers: Mapping[str, Any]) -> Optional[float]:
    value = None
    try:
        value = headers.get("Retry-After")
    except AttributeError:
        return None
    if value is None:
        return None
    text = str(value).strip()
    try:
        seconds = float(text)
        return max(0.0, seconds) if math.isfinite(seconds) else None
    except ValueError:
        pass
    try:
        parsed = email.utils.parsedate_to_datetime(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=_dt.timezone.utc)
        return max(0.0, (parsed - _utc_now()).total_seconds())
    except (TypeError, ValueError, OverflowError):
        return None


def claude_backoff(attempt: int, retry_after: Optional[float] = None) -> float:
    """Return the next wait: 60s exponential, capped at 900s, hint a floor."""

    try:
        count = max(0, int(attempt))
    except (TypeError, ValueError):
        count = 0
    base = min(900.0, 60.0 * (2 ** min(count, 4)))
    hint = retry_after if retry_after is not None and math.isfinite(retry_after) else 0.0
    # The server hint is a floor.  The exponential component itself never grows
    # beyond 15 minutes, while a longer explicit server deadline is retained.
    return max(base, hint, 60.0)


def _env_path(env: Mapping[str, str], key: str, fallback: str) -> Path:
    value = env.get(key)
    if value:
        return Path(value).expanduser()
    return Path(fallback).expanduser()


def _home(env: Mapping[str, str]) -> Path:
    return Path(env.get("HOME") or str(Path.home())).expanduser()


def cache_dir(env: Optional[Mapping[str, str]] = None) -> Path:
    values = os.environ if env is None else env
    return _env_path(values, "XDG_CACHE_HOME", str(_home(values) / ".cache")) / "ledge"


def _cache_path(provider_id: str, env: Mapping[str, str]) -> Path:
    return cache_dir(env) / f"{provider_id}.json"


def _backoff_path(provider_id: str, env: Mapping[str, str]) -> Path:
    return cache_dir(env) / f"{provider_id}.backoff.json"


def _sanitize_message(message: Any, fallback: str = "Provider read failed") -> str:
    # Messages passed by this module are constants.  Keep this guard in front
    # of future changes so a path, token, or HTTP body cannot reach stdout.
    text = str(message) if isinstance(message, str) else fallback
    text = " ".join(text.split())
    if len(text) > 180:
        text = text[:177] + "..."
    return text or fallback


def _ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def _atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    directory = path.parent
    _ensure_private_dir(directory)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(directory))
    temporary_path = Path(temporary)
    try:
        os.fchmod(fd, 0o600)
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                             allow_nan=False).encode("utf-8")
        with os.fdopen(fd, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            temporary_path.unlink()
        except OSError:
            pass


def _valid_cached_window(value: Any) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    window_id = value.get("id")
    label = value.get("label")
    if not isinstance(window_id, str) or not window_id:
        return None
    if not isinstance(label, str):
        return None
    number = _finite_number(value.get("usedPercent", _MISSING), "cached usedPercent")
    if number is None or number < 0:
        return None
    reset = value.get("resetsAt", None)
    if reset is not None and _parse_iso(reset) is None:
        return None
    return {
        "id": window_id,
        "label": label,
        "usedPercent": float(number),
        "resetsAt": reset if reset is None else isoformat(_parse_iso(reset)),
    }


def _load_cache(provider_id: str, env: Mapping[str, str]) -> Optional[dict[str, Any]]:
    path = _cache_path(provider_id, env)
    try:
        if not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
            return None
        with path.open("rb") as stream:
            raw = stream.read(MAX_FILE_BYTES + 1)
            if len(raw) > MAX_FILE_BYTES:
                return None
            data = _json_loads(raw)
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or data.get("version") != VERSION:
        return None
    updated = _parse_iso(data.get("updatedAt"))
    windows_raw = data.get("windows")
    if updated is None or not isinstance(windows_raw, list):
        return None
    windows = []
    try:
        for item in windows_raw:
            checked = _valid_cached_window(item)
            if checked is None:
                return None
            windows.append(checked)
    except (TypeError, ValueError):
        return None
    if not windows:
        return None
    return {
        "updatedAt": isoformat(updated),
        "windows": windows,
        "source": data.get("source") if isinstance(data.get("source"), str) else "Cache",
    }


def _save_cache(provider_id: str, reading: Mapping[str, Any], env: Mapping[str, str]) -> None:
    try:
        # An undated local snapshot is useful as stale data for this invocation
        # but must never be promoted to a last-good cache with a made-up time.
        if not isinstance(reading.get("updatedAt"), str) or _parse_iso(reading["updatedAt"]) is None:
            return
        value = {
            "version": VERSION,
            "provider": provider_id,
            "updatedAt": reading["updatedAt"],
            "source": _sanitize_message(reading.get("source", "Provider"), "Provider"),
            "windows": reading["windows"],
        }
        _atomic_json(_cache_path(provider_id, env), value)
    except Exception:
        # A read must remain useful if a read-only home or a full disk prevents
        # the optional cache from being updated.
        return


def _load_backoff(provider_id: str, env: Mapping[str, str], now: _dt.datetime) -> tuple[Optional[_dt.datetime], int]:
    path = _backoff_path(provider_id, env)
    try:
        if not path.is_file() or path.stat().st_size > 16 * 1024:
            return None, 0
        with path.open("rb") as stream:
            raw = stream.read(16 * 1024 + 1)
            if len(raw) > 16 * 1024:
                return None, 0
            data = _json_loads(raw)
        until = _parse_iso(data.get("retryUntil")) if isinstance(data, dict) else None
        attempt = data.get("attempt", 0) if isinstance(data, dict) else 0
        if isinstance(attempt, bool) or not isinstance(attempt, int):
            attempt = 0
        if until is None:
            return None, 0
        # Keep the consecutive count after the deadline.  A second 429 after
        # waiting out the first one must back off longer; only a successful
        # response clears this state.
        if until <= now:
            return None, max(0, attempt)
        return until, max(0, attempt)
    except (OSError, ValueError, json.JSONDecodeError):
        return None, 0


def _save_backoff(provider_id: str, env: Mapping[str, str], until: _dt.datetime, attempt: int) -> None:
    try:
        _atomic_json(_backoff_path(provider_id, env), {
            "version": VERSION,
            "provider": provider_id,
            "retryUntil": isoformat(until),
            "attempt": int(max(1, attempt)),
        })
    except Exception:
        return


def _clear_backoff(provider_id: str, env: Mapping[str, str]) -> None:
    try:
        _backoff_path(provider_id, env).unlink()
    except OSError:
        pass


def purge_provider_cache(provider_id: str, env: Optional[Mapping[str, str]] = None) -> None:
    values = os.environ if env is None else env
    for path in (_cache_path(provider_id, values), _backoff_path(provider_id, values)):
        try:
            path.unlink()
        except OSError:
            pass


def find_codex_command(env: Optional[Mapping[str, str]] = None) -> Optional[str]:
    values = os.environ if env is None else env
    configured = values.get("LEDGE_CODEX_BIN")
    if configured:
        path = str(Path(configured).expanduser())
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    found = shutil.which("codex")
    if found:
        return found
    local = _home(values) / ".local" / "bin" / "codex"
    if local.is_file() and os.access(local, os.X_OK):
        return str(local)
    # GNOME often starts without a shell's nvm PATH.  Inspect only the newest
    # twenty explicitly versioned Node bin directories so discovery remains
    # bounded on a long-lived development machine.
    nvm_root = _home(values) / ".nvm" / "versions" / "node"
    try:
        versions = [entry for entry in os.scandir(nvm_root)
                    if entry.is_dir(follow_symlinks=False)]
        versions.sort(key=lambda entry: entry.stat(follow_symlinks=False).st_mtime,
                      reverse=True)
    except OSError:
        versions = []
    for entry in versions[:20]:
        candidate = Path(entry.path) / "bin" / "codex"
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def _set_parent_death_signal() -> None:
    """Ask Linux to terminate the child when this short-lived reader dies."""

    if os.name != "posix":
        return
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        # Linux PR_SET_PDEATHSIG = 1.  If unavailable, the normal watchdog in
        # the parent still bounds a live request.
        libc.prctl(1, signal.SIGTERM, 0, 0, 0)
    except Exception:
        return


def _stop_process(process: Any, kill_group: bool = False) -> None:
    if process is None:
        return
    try:
        running = process.poll() is None
    except Exception:
        running = True
    signalled_group = False
    pid = getattr(process, "pid", None)
    if kill_group and os.name == "posix" and isinstance(pid, int) and pid > 0:
        try:
            # app-server may launch helpers of its own.  It is a new
            # session, so the entire process group belongs to this read.
            os.killpg(pid, signal.SIGTERM)
            signalled_group = True
        except (OSError, ProcessLookupError):
            pass
    if running:
        if not signalled_group:
            try:
                process.terminate()
            except Exception:
                pass
        try:
            process.wait(timeout=0.75)
        except Exception:
            if signalled_group:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except (OSError, ProcessLookupError):
                    pass
            try:
                process.kill()
            except Exception:
                pass
            try:
                process.wait(timeout=0.75)
            except Exception:
                pass
    # The group leader can exit while a shell/helper remains.  Recheck after
    # the grace period even on the successful-response path.
    if signalled_group:
        try:
            os.killpg(pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            pass
    for stream_name in ("stdin", "stdout", "stderr"):
        stream = getattr(process, stream_name, None)
        if stream is not None:
            try:
                stream.close()
            except Exception:
                pass


def _install_process_signal_handlers(process: Any) -> dict[int, Any]:
    """Make SIGTERM/SIGPIPE tear down an active app-server synchronously."""

    previous: dict[int, Any] = {}

    def stop(signum: int, _frame: Any) -> None:
        _stop_process(process, kill_group=True)
        if signum == getattr(signal, "SIGPIPE", object()):
            raise ProviderProblem("error", "Codex app-server closed its input")
        raise SystemExit(128 + signum)

    for signal_number in (getattr(signal, "SIGTERM", None),
                          getattr(signal, "SIGPIPE", None)):
        if signal_number is None:
            continue
        try:
            previous[signal_number] = signal.getsignal(signal_number)
            signal.signal(signal_number, stop)
        except (ValueError, OSError):
            # signal.signal is restricted to the main thread.  The process
            # parent-death signal and request deadline still cover workers.
            continue
    return previous


def _restore_process_signal_handlers(previous: Mapping[int, Any]) -> None:
    for signal_number, handler in previous.items():
        try:
            signal.signal(signal_number, handler)
        except (ValueError, OSError):
            pass


def _protocol_response(buffer: bytes) -> tuple[Optional[dict[str, Any]], Optional[str]]:
    for line in buffer.splitlines():
        try:
            value = _json_loads(line)
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        if not isinstance(value, dict) or value.get("id") != 2:
            continue
        if "result" in value:
            return value, None
        if "error" in value:
            return None, "Codex app-server returned an error"
    return None, None


def codex_app_server(command: str, timeout: float = NETWORK_TIMEOUT) -> bytes:
    """Run one bounded JSONL handshake and return the matching id=2 reply."""

    timeout = min(NETWORK_TIMEOUT, max(0.01, float(timeout)))
    handshake = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "clientInfo": {"name": "ledge", "title": "Ledge", "version": "1"}
        }},
        {"jsonrpc": "2.0", "method": "initialized", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read", "params": None},
    ]
    encoded = b"".join(json.dumps(item, separators=(",", ":")).encode("utf-8") + b"\n"
                        for item in handshake)
    process = None
    previous_handlers: dict[int, Any] = {}
    try:
        kwargs: dict[str, Any] = {
            "stdin": subprocess.PIPE,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.DEVNULL,
            "start_new_session": True,
        }
        child_env = os.environ.copy()
        command_parent = str(Path(command).expanduser().absolute().parent)
        child_env["PATH"] = command_parent + os.pathsep + child_env.get("PATH", "")
        # A version-manager wrapper commonly starts with /usr/bin/env node;
        # prepend its sibling bin directory so the wrapper works from GNOME's
        # sparse login environment as well as from an interactive shell.
        kwargs["env"] = child_env
        if os.name == "posix":
            kwargs["preexec_fn"] = _set_parent_death_signal
        process = subprocess.Popen([command, "app-server"], **kwargs)
        previous_handlers = _install_process_signal_handlers(process)
        if process.stdin is None or process.stdout is None:
            raise ProviderProblem("error", "Codex app-server pipes unavailable")
        try:
            process.stdin.write(encoded)
            process.stdin.flush()
        except (BrokenPipeError, OSError):
            raise ProviderProblem("error", "Codex app-server closed its input")

        output = process.stdout
        buffer = bytearray()
        deadline = time.monotonic() + timeout
        selector = None
        try:
            try:
                selector = selectors.DefaultSelector()
                selector.register(output, selectors.EVENT_READ)
            except (OSError, ValueError):
                selector = None
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ProviderProblem("error", "Codex app-server timed out")
                if selector is None:
                    try:
                        stdout_data, _ = process.communicate(timeout=remaining)
                    except subprocess.TimeoutExpired as exc:
                        raise ProviderProblem("error", "Codex app-server timed out") from exc
                    buffer.extend(stdout_data or b"")
                    answer, protocol_error = _protocol_response(bytes(buffer))
                    if answer is not None:
                        return json.dumps(answer, separators=(",", ":")).encode("utf-8")
                    raise ProviderProblem("error", protocol_error or "Codex app-server gave no usage answer")
                events = selector.select(remaining)
                if not events:
                    raise ProviderProblem("error", "Codex app-server timed out")
                chunk = os.read(output.fileno(), 64 * 1024)
                if not chunk:
                    answer, protocol_error = _protocol_response(bytes(buffer))
                    if answer is not None:
                        return json.dumps(answer, separators=(",", ":")).encode("utf-8")
                    raise ProviderProblem("error", protocol_error or "Codex app-server gave no usage answer")
                buffer.extend(chunk)
                if len(buffer) > MAX_PROTOCOL_BYTES:
                    raise ProviderProblem("error", "Codex app-server response was too large")
                answer, protocol_error = _protocol_response(bytes(buffer))
                if answer is not None:
                    return json.dumps(answer, separators=(",", ":")).encode("utf-8")
                if protocol_error:
                    raise ProviderProblem("error", protocol_error)
        finally:
            if selector is not None:
                try:
                    selector.close()
                except Exception:
                    pass
    except ProviderProblem:
        raise
    except (OSError, ValueError, subprocess.SubprocessError):
        raise ProviderProblem("error", "Codex app-server could not be started")
    finally:
        _restore_process_signal_handlers(previous_handlers)
        _stop_process(process, kill_group=True)


# Alias useful to tests and embedding callers.
run_codex_app_server = codex_app_server


def _sqlite_open(path: Path) -> Optional[sqlite3.Connection]:
    if not path.is_file():
        return None
    # mode=ro sees the WAL.  Do not fall back to immutable=1: that silently
    # ignores a live WAL and can return a rotated, invalid Cursor credential.
    try:
        uri = path.absolute().as_uri() + "?mode=ro"
    except (ValueError, OSError):
        return None
    connection = None
    try:
        connection = sqlite3.connect(uri, uri=True, timeout=0.5)
        connection.execute("PRAGMA query_only=ON")
        return connection
    except (sqlite3.Error, OSError):
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass
        return None


def _sqlite_value(connection: sqlite3.Connection, key: str) -> Optional[str]:
    try:
        row = connection.execute(
            "SELECT value FROM ItemTable WHERE key = ? LIMIT 1", (key,)
        ).fetchone()
    except sqlite3.Error:
        return None
    if not row or row[0] is None:
        return None
    value = row[0]
    if isinstance(value, bytes):
        try:
            value = value.decode("utf-8")
        except UnicodeDecodeError:
            return None
    return value if isinstance(value, str) else str(value)


def cursor_store_path(env: Optional[Mapping[str, str]] = None) -> Path:
    values = os.environ if env is None else env
    config = _env_path(values, "XDG_CONFIG_HOME", str(_home(values) / ".config"))
    return config / "Cursor" / "User" / "globalStorage" / "state.vscdb"


def cursor_credentials(env: Optional[Mapping[str, str]] = None) -> tuple[str, str]:
    values = os.environ if env is None else env
    store = cursor_store_path(values)
    connection = _sqlite_open(store)
    if connection is None:
        raise ProviderProblem("needsAuth", "Cursor credentials are unavailable")
    try:
        token = _sqlite_value(connection, "cursorAuth/accessToken")
        account = _sqlite_value(connection, "cursorAuth/stripeMembershipAuthId")
    finally:
        connection.close()
    if not token or not account:
        raise ProviderProblem("needsAuth", "Cursor credentials are unavailable")
    return account, token


def claude_credentials(env: Optional[Mapping[str, str]] = None,
                       now: Optional[_dt.datetime] = None) -> str:
    values = os.environ if env is None else env
    if now is None:
        now = _utc_now()
    config = _env_path(values, "CLAUDE_CONFIG_DIR", str(_home(values) / ".claude"))
    path = config / ".credentials.json"
    try:
        if not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
            raise ProviderProblem("needsAuth", "Claude Code credentials are unavailable")
        with path.open("rb") as stream:
            raw = stream.read(MAX_FILE_BYTES + 1)
            if len(raw) > MAX_FILE_BYTES:
                raise ProviderProblem("needsAuth", "Claude Code credentials are unavailable")
            root = _object(raw, "Claude credentials")
    except ProviderProblem:
        raise
    except (OSError, UsageParseError):
        raise ProviderProblem("needsAuth", "Claude Code credentials are unavailable")
    oauth = root.get("claudeAiOauth")
    if not isinstance(oauth, dict):
        raise ProviderProblem("needsAuth", "Claude Code credentials are unavailable")
    token = oauth.get("accessToken")
    if not isinstance(token, str) or not token.strip():
        raise ProviderProblem("needsAuth", "Claude Code credentials are unavailable")
    expires = oauth.get("expiresAt", _MISSING)
    try:
        expires_number = _finite_number(expires, "Claude expiresAt")
    except UsageParseError as exc:
        raise ProviderProblem("needsAuth", "Claude Code credentials are unavailable") from exc
    if expires_number is None:
        raise ProviderProblem("needsAuth", "Claude Code credentials are unavailable")
    if abs(expires_number) >= 100_000_000_000:
        expires_number /= 1000.0
    try:
        expiry = _dt.datetime.fromtimestamp(expires_number, tz=_dt.timezone.utc)
    except (OverflowError, OSError, ValueError) as exc:
        raise ProviderProblem("needsAuth", "Claude Code credentials are unavailable") from exc
    if expiry <= now:
        raise ProviderProblem("needsAuth", "Claude Code credentials have expired; use Claude Code to refresh them")
    return token.strip()


def _read_bounded_text(path: Path, limit: int = MAX_FILE_BYTES) -> str:
    try:
        if not path.is_file() or path.stat().st_size > limit:
            raise OSError
        with path.open("rb") as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise OSError
        return data.decode("utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise ProviderProblem("error", "Local usage file could not be read") from exc


def _tail(path: Path, limit: int = MAX_FILE_BYTES) -> str:
    try:
        if not path.is_file():
            raise OSError
        with path.open("rb") as stream:
            stream.seek(0, os.SEEK_END)
            size = stream.tell()
            stream.seek(max(0, size - limit), os.SEEK_SET)
            return stream.read(limit).decode("utf-8", "replace")
    except OSError as exc:
        raise ProviderProblem("error", "Codex rollout could not be read") from exc


def codex_state_path(env: Optional[Mapping[str, str]] = None) -> Path:
    values = os.environ if env is None else env
    return _env_path(values, "CODEX_HOME", str(_home(values) / ".codex")) / "state_5.sqlite"


def _rollout_paths_from_state(state: Path, env: Mapping[str, str]) -> list[Path]:
    connection = _sqlite_open(state)
    if connection is None:
        return []
    paths: list[Path] = []
    try:
        rows = connection.execute(
            "SELECT rollout_path FROM threads WHERE archived = 0 "
            "ORDER BY updated_at_ms DESC LIMIT 8"
        ).fetchall()
        base = state.parent
        for row in rows:
            if not row or not isinstance(row[0], str) or not row[0].strip():
                continue
            value = Path(row[0]).expanduser()
            if not value.is_absolute():
                value = base / value
            if value.is_file() and not value.is_symlink():
                paths.append(value)
    except sqlite3.Error:
        return []
    finally:
        connection.close()
    return paths


def _session_paths(home: Path, max_files: int = 512, max_dirs: int = 256) -> list[Path]:
    root = home / "sessions"
    if not root.is_dir() or root.is_symlink():
        return []
    paths: list[Path] = []
    pending = [root]
    seen_dirs = 0
    while pending and seen_dirs < max_dirs and len(paths) < max_files:
        current = pending.pop()
        seen_dirs += 1
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        entries.sort(key=lambda entry: entry.name, reverse=True)
        child_dirs: list[Path] = []
        child_files: list[Path] = []
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    child_dirs.append(Path(entry.path))
                elif entry.is_file(follow_symlinks=False) and entry.name.endswith((".jsonl", ".json")):
                    child_files.append(Path(entry.path))
            except OSError:
                continue
        # `pending` is a LIFO stack: push oldest first so newest directories
        # are visited first.  Files are already newest-first by name.
        pending.extend(reversed(child_dirs))
        for path in child_files:
            if len(paths) >= max_files:
                break
            paths.append(path)
    return paths


def _codex_local_reading(env: Mapping[str, str], now: _dt.datetime) -> dict[str, Any]:
    state = codex_state_path(env)
    paths = _rollout_paths_from_state(state, env)
    if not paths:
        paths = _session_paths(state.parent)
    candidates: list[tuple[Optional[_dt.datetime], Path, list[dict[str, Any]], int]] = []
    for index, path in enumerate(paths):
        try:
            text = _tail(path)
            windows = parse_codex_rollout(text, now=now)
        except (ProviderProblem, UsageParseError):
            continue
        stamp = codex_recorded_at(text)
        candidates.append((stamp, path, windows, index))
    if not candidates:
        if not state.is_file() and not (state.parent / "sessions").is_dir():
            raise ProviderProblem("unavailable", "Codex is not installed or has no local usage yet")
        raise ProviderProblem("error", "Codex has no readable usage snapshot yet")
    dated = [candidate for candidate in candidates if candidate[0] is not None]
    chosen = max(dated, key=lambda item: (item[0], -item[3])) if dated else max(
        candidates, key=lambda item: item[3]
    )
    stamp, _path, windows, _index = chosen
    if stamp is None:
        updated = None
        status = "stale"
        message = "Codex rollout timestamp is unavailable"
    else:
        updated = isoformat(stamp)
        age = (now - stamp).total_seconds()
        status = "ok" if age <= CODEX_STALE_SECONDS else "stale"
        message = "" if status == "ok" else "Codex rollout reading is older than 5 minutes"
    return {
        "status": status,
        "message": message,
        "source": "Codex rollout",
        "updatedAt": updated,
        "windows": windows,
    }


def _provider_ok(provider_id: str, source: str, windows: list[dict[str, Any]],
                 updated: _dt.datetime, status: str = "ok", message: str = "") -> dict[str, Any]:
    return {
        "status": status,
        "message": _sanitize_message(message, ""),
        "source": _sanitize_message(source, PROVIDER_NAMES.get(provider_id, provider_id)),
        "updatedAt": isoformat(updated),
        "windows": windows,
    }


def _cached_failure(provider_id: str, problem: ProviderProblem,
                    cache: Optional[Mapping[str, Any]], now: _dt.datetime) -> dict[str, Any]:
    if cache:
        return {
            "status": "stale",
            "message": _sanitize_message(problem.message),
            "source": "Cache",
            "updatedAt": cache["updatedAt"],
            "windows": cache["windows"],
        }
    return {
        "status": problem.status if problem.status in {"needsAuth", "error", "unavailable"} else "error",
        "message": _sanitize_message(problem.message),
        "source": PROVIDER_NAMES.get(provider_id, provider_id),
        "updatedAt": isoformat(now),
        "windows": [],
    }


def _read_codex(env: Mapping[str, str], now: _dt.datetime) -> dict[str, Any]:
    command = find_codex_command(env)
    if command:
        try:
            answer = codex_app_server(command)
            windows = parse_codex_response(answer, now=now)
            reading = _provider_ok("codex", "Codex app-server", windows, now)
            _save_cache("codex", reading, env)
            return reading
        except (ProviderProblem, UsageParseError):
            pass
    try:
        reading = _codex_local_reading(env, now)
        if reading["status"] == "ok":
            _save_cache("codex", reading, env)
        elif reading["windows"]:
            _save_cache("codex", reading, env)
        return reading
    except ProviderProblem as local_problem:
        cache = _load_cache("codex", env)
        return _cached_failure("codex", local_problem, cache, now)


def _read_claude(env: Mapping[str, str], now: _dt.datetime) -> dict[str, Any]:
    cache = _load_cache("claude", env)
    until, attempt = _load_backoff("claude", env, now)
    if until is not None:
        return _cached_failure("claude", ProviderProblem(
            "error", "Claude usage is rate limited; retry after the backoff window"), cache, now)
    try:
        token = claude_credentials(env, now)
        status, body, headers, retry_after = _http_json(
            "https://api.anthropic.com/api/oauth/usage",
            {"Authorization": f"Bearer {token}", "Accept": "application/json",
             "anthropic-beta": "oauth-2025-04-20"},
        )
        if status in (401, 403):
            raise ProviderProblem("needsAuth", "Claude Code credentials were rejected")
        if status == 429:
            delay = claude_backoff(attempt, retry_after)
            _save_backoff("claude", env, now + _dt.timedelta(seconds=delay), attempt + 1)
            raise ProviderProblem("error", "Claude usage is rate limited; retry after the backoff window")
        if status < 200 or status >= 300:
            raise ProviderProblem("error", "Claude usage endpoint returned an error")
        windows = parse_claude_usage(body)
        reading = _provider_ok("claude", "Claude OAuth usage", windows, now)
        _save_cache("claude", reading, env)
        _clear_backoff("claude", env)
        return reading
    except ProviderProblem as problem:
        return _cached_failure("claude", problem, cache, now)
    except UsageParseError:
        return _cached_failure("claude", ProviderProblem("error", "Claude usage response was malformed"), cache, now)


def _read_cursor(env: Mapping[str, str], now: _dt.datetime) -> dict[str, Any]:
    cache = _load_cache("cursor", env)
    try:
        account, token = cursor_credentials(env)
        cookie = f"WorkosCursorSessionToken={account}::{token}"
        status, body, _headers, _retry = _http_json(
            "https://cursor.com/api/usage-summary",
            {"Cookie": cookie, "Accept": "application/json"},
        )
        if status in (401, 403):
            raise ProviderProblem("needsAuth", "Cursor credentials were rejected")
        if status < 200 or status >= 300:
            raise ProviderProblem("error", "Cursor usage endpoint returned an error")
        windows = parse_cursor_usage(body)
        reading = _provider_ok("cursor", "Cursor usage API", windows, now)
        _save_cache("cursor", reading, env)
        return reading
    except ProviderProblem as problem:
        return _cached_failure("cursor", problem, cache, now)
    except UsageParseError:
        return _cached_failure("cursor", ProviderProblem("error", "Cursor usage response was malformed"), cache, now)


_DEMO_WINDOWS = {
    "codex": [
        {"id": "primary", "label": "5h limit", "usedPercent": 23.0,
         "resetsAt": "2030-01-01T05:00:00.000Z"},
        {"id": "secondary", "label": "Weekly limit", "usedPercent": 8.0,
         "resetsAt": "2030-01-07T00:00:00.000Z"},
    ],
    "claude": [
        {"id": "session", "label": "Current session", "usedPercent": 31.0,
         "resetsAt": "2030-01-01T05:00:00.000Z"},
        {"id": "weekly_all", "label": "All models", "usedPercent": 12.0,
         "resetsAt": "2030-01-07T00:00:00.000Z"},
    ],
    "cursor": [
        {"id": "included", "label": "Included usage", "usedPercent": 17.0,
         "resetsAt": "2030-01-31T00:00:00.000Z"},
    ],
}


def demo_document(provider_ids: Iterable[str],
                  now: Optional[_dt.datetime] = None) -> dict[str, Any]:
    if now is None:
        now = _utc_now()
    # Keep the synthetic readings stable for the lifetime of an hour while
    # making the tooltip useful instead of showing a historical reset date.
    now = now.astimezone(_dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    demo_time = isoformat(now)
    demo_resets = {
        "codex_primary": isoformat(now + _dt.timedelta(hours=3)),
        "codex_secondary": isoformat(now + _dt.timedelta(days=3)),
        "claude_session": isoformat(now + _dt.timedelta(hours=3)),
        "claude_weekly": isoformat(now + _dt.timedelta(days=3)),
        "cursor_included": isoformat(now + _dt.timedelta(days=30)),
    }
    providers = []
    for provider_id in provider_ids:
        windows = [dict(window) for window in _DEMO_WINDOWS.get(provider_id, [])]
        reset_names = {
            "codex": ("codex_primary", "codex_secondary"),
            "claude": ("claude_session", "claude_weekly"),
            "cursor": ("cursor_included",),
        }.get(provider_id, ())
        for window, reset_name in zip(windows, reset_names):
            window["resetsAt"] = demo_resets[reset_name]
        providers.append({
            "id": provider_id,
            "name": PROVIDER_NAMES.get(provider_id, provider_id.title()),
            "status": "ok",
            "message": "",
            "source": "Demo",
            "updatedAt": demo_time,
            "windows": windows,
        })
    return {"version": VERSION, "updatedAt": demo_time, "providers": providers}


def parse_provider_list(raw: Optional[str]) -> list[str]:
    if raw is None:
        return list(PROVIDER_NAMES)
    if not raw.strip():
        return []
    result: list[str] = []
    for token in raw.split(","):
        provider_id = token.strip().lower()
        if provider_id and provider_id not in result:
            result.append(provider_id)
    return result


def read_document(provider_ids: Iterable[str], demo: bool = False,
                  env: Optional[Mapping[str, str]] = None,
                  now: Optional[_dt.datetime] = None) -> dict[str, Any]:
    """Read exactly the requested providers and return the JSON object."""

    values: Mapping[str, str] = os.environ if env is None else env
    if demo:
        # Demo mode intentionally returns before cache purging or any local
        # path inspection: it is safe to run in a credential-free test.
        return demo_document(provider_ids, now=now)
    if now is None:
        now = _utc_now()
    ids = list(provider_ids)
    enabled = set(ids)
    for provider_id in PROVIDER_NAMES:
        if provider_id not in enabled:
            purge_provider_cache(provider_id, values)
    providers = []
    for provider_id in ids:
        try:
            if provider_id == "codex":
                reading = _read_codex(values, now)
            elif provider_id == "claude":
                reading = _read_claude(values, now)
            elif provider_id == "cursor":
                reading = _read_cursor(values, now)
            else:
                reading = {
                    "status": "unavailable",
                    "message": "Provider is not supported on Ubuntu",
                    "source": provider_id,
                    "updatedAt": isoformat(now),
                    "windows": [],
                }
        except Exception:
            # A single provider's local schema or permissions must not remove
            # the other requested rows from the one-shot contract.
            reading = {
                "status": "error",
                "message": "Provider read failed",
                "source": PROVIDER_NAMES.get(provider_id, provider_id),
                "updatedAt": isoformat(now),
                "windows": [],
            }
        providers.append({
            "id": provider_id,
            "name": PROVIDER_NAMES.get(provider_id, provider_id.title()),
            "status": reading["status"],
            "message": _sanitize_message(reading.get("message", ""), ""),
            "source": _sanitize_message(reading.get("source", provider_id), provider_id),
            "updatedAt": reading["updatedAt"],
            "windows": reading.get("windows", []),
        })
    return {"version": VERSION, "updatedAt": isoformat(now), "providers": providers}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read Ledge provider usage")
    parser.add_argument("--providers", default="codex,claude,cursor",
                        help="comma-separated provider ids; empty selects none")
    parser.add_argument("--demo", action="store_true",
                        help="emit fixed synthetic readings without local or network I/O")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    ids = parse_provider_list(args.providers)
    try:
        document = read_document(ids, demo=args.demo)
        print(json.dumps(document, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
        return 0
    except BrokenPipeError:
        # A GNOME caller closing stdout must not leave a child app-server alive;
        # the app-server function's finally block has already reaped it.
        return 0
    except Exception:
        # Keep the one-shot contract intact even if an unforeseen error occurs
        # before provider iteration starts.
        now = _utc_now()
        fallback = {
            "version": VERSION,
            "updatedAt": isoformat(now),
            "providers": [{
                "id": provider_id,
                "name": PROVIDER_NAMES.get(provider_id, provider_id.title()),
                "status": "error",
                "message": "Provider read failed",
                "source": PROVIDER_NAMES.get(provider_id, provider_id),
                "updatedAt": isoformat(now),
                "windows": [],
            } for provider_id in ids],
        }
        print(json.dumps(fallback, separators=(",", ":")))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
