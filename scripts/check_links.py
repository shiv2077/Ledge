#!/usr/bin/env python3
"""Fail when a Markdown file links to a repository path that does not exist."""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = ['README.md', 'DECISIONS.md', 'docs/ARCHITECTURE.md', 'docs/TESTING.md']
LINK = re.compile(r'\]\(([^)\s#]+)(?:#[^)]*)?\)|src="([^"]+)"')


def broken(path: Path) -> list[str]:
    missing = []
    for match in LINK.finditer(path.read_text()):
        target = match.group(1) or match.group(2)
        if re.match(r'[a-z]+:', target):
            continue
        if not (path.parent / target).exists():
            missing.append(f'{path.relative_to(ROOT)}: {target}')
    return missing


def main() -> int:
    missing = [line for name in FILES if (ROOT / name).exists() for line in broken(ROOT / name)]
    absent = [name for name in FILES if not (ROOT / name).exists()]
    for line in missing + [f'missing file: {name}' for name in absent]:
        print(line)
    return 1 if missing or absent else 0


if __name__ == '__main__':
    sys.exit(main())
