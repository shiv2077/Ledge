#!/usr/bin/env python3
"""Build the README images from `make smoke` screenshots, with ffmpeg."""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SMOKE = ROOT / '.smoke'
DOCS = ROOT / 'docs'
QUALITY = '90'
# The smoke desktop colour, used to pad the unfold frames to one size.
BACKDROP = '0x1d4f91'
FRAME_SECONDS = '0.7'

STILLS = {
    'hero.webp': 'panel-deck-claude.png',
    'screenshots/panel.webp': 'panel.png',
    'screenshots/usage-claude.webp': 'deck-claude-depth.png',
    'screenshots/usage-codex.webp': 'deck-right-codex.png',
    'screenshots/models.webp': 'deck-right-models.png',
    'screenshots/copilot.webp': 'panel-deck-copilot.png',
    'screenshots/github.webp': 'deck-right-github.png',
    'screenshots/power.webp': 'deck-right-power.png',
    'screenshots/todo.webp': 'deck-right-todo.png',
    'screenshots/training.webp': 'deck-right-training.png',
    'screenshots/rail.webp': 'rail-right.png',
    'screenshots/accounts.webp': 'rail-accounts.png',
    'screenshots/summary.webp': 'panel-summary.png',
    'screenshots/theme-frosted-dark.webp': 'theme-frosted-dark.png',
    'screenshots/theme-snow.webp': 'theme-snow.png',
}
UNFOLD = ['tick-right.png', 'unfold-right.png', 'rail-right.png', 'deck-right-claude.png']


def ffmpeg(*args: str) -> None:
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *args], check=True)


def size(path: Path) -> tuple[int, int]:
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                          '-of', 'csv=p=0', str(path)], check=True, capture_output=True, text=True).stdout
    width, height = out.strip().split(',')
    return int(width), int(height)


def main() -> int:
    if not shutil.which('ffmpeg'):
        raise SystemExit('ffmpeg is needed: sudo apt install ffmpeg')
    needed = list(STILLS.values()) + UNFOLD
    missing = [name for name in needed if not (SMOKE / name).exists()]
    if missing:
        raise SystemExit(f'Run make smoke first. Missing: {", ".join(missing)}')
    for target, source in STILLS.items():
        out = DOCS / target
        out.parent.mkdir(parents=True, exist_ok=True)
        ffmpeg('-i', str(SMOKE / source), '-c:v', 'libwebp', '-lossless', '0', '-quality', QUALITY, str(out))
    # The rail unfolding: tick, mid-unfold, rail, deck, padded to one size
    # with the rail kept against the right edge.
    width = max(size(SMOKE / name)[0] for name in UNFOLD)
    height = max(size(SMOKE / name)[1] for name in UNFOLD)
    inputs: list[str] = []
    for name in UNFOLD:
        inputs += ['-loop', '1', '-t', FRAME_SECONDS, '-i', str(SMOKE / name)]
    pads = ''.join(f'[{i}:v]pad={width}:{height}:{width}-iw:({height}-ih)/2:color={BACKDROP},setsar=1[f{i}];'
                   for i in range(len(UNFOLD)))
    joined = ''.join(f'[f{i}]' for i in range(len(UNFOLD)))
    ffmpeg(*inputs, '-filter_complex', f'{pads}{joined}concat=n={len(UNFOLD)}:v=1:a=0,fps=10[v]', '-map', '[v]',
           '-c:v', 'libwebp_anim', '-loop', '0', '-quality', QUALITY, str(DOCS / 'rail-unfold.webp'))
    print(f'Wrote {len(STILLS) + 1} images to {DOCS}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
