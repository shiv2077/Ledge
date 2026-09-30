#!/usr/bin/env python3
"""User-local installation, preserving an existing install in a sibling backup."""
from datetime import datetime, timezone
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
subprocess.run(['/usr/bin/python3', str(ROOT / 'scripts/package.py')], check=True)
base = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share')))
parent = base / 'gnome-shell/extensions'
parent.mkdir(parents=True, exist_ok=True)
target = parent / 'ledge@shiv2077'
staging = Path(tempfile.mkdtemp(prefix='.ledge-', dir=parent))
try:
    with zipfile.ZipFile(ROOT / 'dist/ledge@shiv2077.shell-extension.zip') as archive:
        archive.extractall(staging)
    if target.exists() or target.is_symlink():
        backup = base / 'ledge/backups' / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
        backup.parent.mkdir(parents=True, exist_ok=True)
        target.rename(backup)
        print(f'Previous install preserved: {backup}')
    staging.rename(target)
finally:
    if staging.exists():
        shutil.rmtree(staging)
print(f'Installed: {target}')
print('Log out and back in on Wayland, then run: gnome-extensions enable ledge@shiv2077')
print('Settings: gnome-extensions prefs ledge@shiv2077')
