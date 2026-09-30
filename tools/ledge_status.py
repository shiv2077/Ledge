#!/usr/bin/env python3
"""Report training progress to the Ledge notch.

Copy this file next to a training script or put it on PYTHONPATH. It has no
dependencies beyond the standard library.

    from ledge_status import RunStatus

    with RunStatus("resnet-cifar", total_epochs=10) as status:
        for epoch in range(1, 11):
            for step, batch in enumerate(loader):
                loss = train_step(batch)
                status.update(epoch=epoch, step=step, loss=loss, eta_seconds=eta)
    # Leaving the block marks the run done; an exception marks it crashed.

Each run is one JSON file in ~/.local/share/ledge/runs/ (or
$XDG_DATA_HOME/ledge/runs/), replaced atomically so Ledge never reads a
partial file.
"""

from __future__ import annotations

import json
import math
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Optional


def runs_dir() -> Path:
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local/share")
    return Path(base) / "ledge" / "runs"


def _number(value: object) -> Optional[float]:
    """JSON-safe float, or None for missing, NaN or infinite values."""
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


class RunStatus:
    """Writes one run's status file. Safe to call update() every step."""

    def __init__(self, name: str, total_epochs: Optional[int] = None, every: int = 10,
                 directory: Optional[Path] = None) -> None:
        self.name = name
        self.every = max(1, int(every))
        self.directory = Path(directory) if directory else runs_dir()
        slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", name).strip(".-") or "run"
        self.path = self.directory / f"{slug}.json"
        self._calls = 0
        self._fields: dict = {"name": name, "state": "running", "epoch": None,
                              "total_epochs": total_epochs, "step": None, "loss": None,
                              "eta_seconds": None}
        self._write()

    def update(self, epoch: Optional[int] = None, step: Optional[int] = None,
               loss: Optional[float] = None, eta_seconds: Optional[float] = None,
               total_epochs: Optional[int] = None, force: bool = False) -> None:
        """Record progress; the file is written every `every` calls or when forced."""
        for key, value in (("epoch", epoch), ("step", step), ("loss", loss),
                           ("eta_seconds", eta_seconds), ("total_epochs", total_epochs)):
            if value is not None:
                self._fields[key] = _number(value)
        self._calls += 1
        if force or self._calls % self.every == 0:
            self._write()

    def done(self) -> None:
        self._fields["state"] = "done"
        self._fields["eta_seconds"] = 0
        self._write()

    def crashed(self) -> None:
        """Mark the run crashed; call from an except block or signal handler."""
        self._fields["state"] = "crashed"
        self._write()

    def __enter__(self) -> "RunStatus":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        if exc_type is None:
            self.done()
        else:
            self.crashed()
        return False

    def _write(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        document = dict(self._fields, updated_at=time.time())
        # Write beside the target, then rename over it in one step.
        handle, temp = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=self.directory)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(document, stream)
            os.replace(temp, self.path)
        except BaseException:
            try:
                os.unlink(temp)
            except OSError:
                pass
            raise
