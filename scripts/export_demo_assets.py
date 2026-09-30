#!/usr/bin/env python3
"""Build README demo images and video from make smoke screenshots."""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SMOKE = ROOT / '.smoke'
OUT = ROOT / 'docs' / 'demo'


def require_smoke() -> None:
    needed = [
        'closed-handle.png', 'unfold-intermediate.png', 'right.png',
        'claude-card.png', 'cursor-card.png', 'codex-card.png',
        'settings-arc.png', 'settings-gear.png', 'settings-return.png', 'top.png',
    ]
    missing = [name for name in needed if not (SMOKE / name).exists()]
    if missing:
        raise SystemExit(f'Run make smoke first. Missing: {", ".join(missing)}')


def save_crop(src: Path, dest: Path, box: tuple[int, int, int, int], scale: int | None = None) -> None:
    cropped = Image.open(src).crop(box)
    if scale:
        cropped = cropped.resize(
            (scale, int(cropped.height * scale / cropped.width)),
            Image.LANCZOS,
        )
    dest.parent.mkdir(parents=True, exist_ok=True)
    cropped.save(dest)


def collapsed_crop() -> None:
    im = Image.open(SMOKE / 'closed-handle.png').convert('RGB')
    w, h = im.size
    best = None
    for x0 in range(w - 20, w - 10):
        for y0 in range(0, h - 100):
            count = sum(
                1 for x in range(x0, x0 + 10) for y in range(y0, y0 + 79)
                if all(v < 40 for v in im.getpixel((x, y)))
            )
            if count > 500 and (not best or count > best[0]):
                best = (count, x0, y0)
    if not best:
        raise SystemExit('Could not locate collapsed handle in closed-handle.png')
    _, x0, y0 = best
    save_crop(SMOKE / 'closed-handle.png', OUT / 'collapsed.png', (x0 - 40, y0 - 40, x0 + 50, y0 + 119), 640)


def stills() -> None:
    save_crop(SMOKE / 'unfold-intermediate.png', OUT / 'unfolding.png', (1145, 175, 1280, 620), 520)
    save_crop(SMOKE / 'right.png', OUT / 'expanded-detail.png', (730, 100, 1280, 650), 1040)
    save_crop(SMOKE / 'settings-gear.png', OUT / 'settings.png', (1145, 150, 1280, 620), 520)
    save_crop(SMOKE / 'top.png', OUT / 'top-edge.png', (350, 10, 930, 130), 1040)


def video() -> None:
    frames = [
        ('closed-handle.png', 1200),
        ('unfold-intermediate.png', 600),
        ('right.png', 1800),
        ('claude-card.png', 2200),
        ('cursor-card.png', 1400),
        ('codex-card.png', 1400),
        ('settings-arc.png', 800),
        ('settings-gear.png', 1200),
        ('settings-return.png', 800),
        ('closed-handle.png', 1000),
    ]
    with tempfile.TemporaryDirectory(prefix='ledge-demo-') as tmp:
        seq = Path(tmp) / 'seq'
        seq.mkdir()
        idx = 0
        for name, ms in frames:
            im = Image.open(SMOKE / name).convert('RGB')
            for _ in range(max(1, round(ms / 100))):
                im.save(seq / f'seq-{idx:04d}.png')
                idx += 1
        dest = OUT / 'demo.webm'
        cmd = (
            f'gst-launch-1.0 -q multifilesrc location={seq}/seq-%04d.png index=0 '
            f'caps="image/png,framerate=10/1" ! pngdec ! videoconvert ! video/x-raw,format=I420 ! '
            f'vp8enc deadline=1 cpu-used=4 ! webmmux ! filesink location={dest}'
        )
        subprocess.run(cmd, shell=True, check=True)


def main() -> None:
    require_smoke()
    OUT.mkdir(parents=True, exist_ok=True)
    collapsed_crop()
    stills()
    video()
    print(f'Wrote demo assets under {OUT.relative_to(ROOT)}/')


if __name__ == '__main__':
    main()
