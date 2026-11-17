#!/usr/bin/env python3
"""Exercise the real extension in an isolated GNOME Shell with demo data."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / '.smoke'
DEADLINE = 300  # seconds for the whole run
OUTPUT.mkdir(exist_ok=True)
for old in OUTPUT.glob('*.png'):
    old.unlink()
report = OUTPUT / 'result.json'
report.unlink(missing_ok=True)
(OUTPUT / 'prefs.json').unlink(missing_ok=True)
subprocess.run(['glib-compile-schemas', '--strict', str(ROOT / 'schemas')], check=True)
with tempfile.TemporaryDirectory(prefix='ledge-smoke-') as folder:
    base = Path(folder)
    extension = base / 'data/gnome-shell/extensions/ledge@shiv2077'
    extension.mkdir(parents=True)
    for name in ['metadata.json', 'extension.js', 'model.js', 'design.js', 'themes.js', 'draw.js',
                 'prefs.js', 'stylesheet.css']:
        shutil.copy2(ROOT / name, extension / name)
    for name in ['lib', 'modules', 'reader', 'schemas']:
        shutil.copytree(ROOT / name, extension / name)
    shutil.copy2(ROOT / 'tests/prefs-smoke.js', extension / 'prefs-smoke.js')
    (extension / 'extension.js').rename(extension / 'implementation.js')
    shutil.copy2(ROOT / 'tests/smoke.js', extension / 'extension.js')
    env = dict(os.environ, XDG_DATA_HOME=str(base / 'data'), XDG_CONFIG_HOME=str(base / 'config'),
               XDG_CACHE_HOME=str(base / 'cache'), GSETTINGS_BACKEND='keyfile',
               LEDGE_SMOKE_OUTPUT=str(OUTPUT), GNOME_SHELL_SESSION_MODE='user',
               NO_AT_BRIDGE='1')
    # Isolated keyfile settings, never the user's dconf database.
    subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', "['ledge@shiv2077']"], env=env, check=True)
    subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'disable-user-extensions', 'false'], env=env, check=True)
    subprocess.run(['gsettings', 'set', 'org.gnome.mutter', 'dynamic-workspaces', 'false'], env=env, check=True)
    subprocess.run(['gsettings', 'set', 'org.gnome.desktop.wm.preferences', 'num-workspaces', '2'], env=env, check=True)
    # A new virtual pointer starts at the origin, where the hot corner opens the Overview.
    subprocess.run(['gsettings', 'set', 'org.gnome.desktop.interface', 'enable-hot-corners', 'false'], env=env, check=True)
    with (OUTPUT / 'shell.log').open('w') as log:
        process = subprocess.Popen(['dbus-run-session', '--', 'gnome-shell', '--headless', '--wayland', '--no-x11',
                                    '--virtual-monitor', '1920x1080'], env=env, stdout=log, stderr=log, start_new_session=True)
        try:
            deadline = time.monotonic() + DEADLINE
            while time.monotonic() < deadline and process.poll() is None and not report.exists():
                time.sleep(0.25)
        finally:
            # Stop the shell before the session services it talks to, so it
            # never sees them vanish while it is shutting down.
            subprocess.run(['pkill', '-TERM', '-g', str(process.pid), '-x', 'gnome-shell'], check=False)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and subprocess.run(
                    ['pgrep', '-g', str(process.pid), '-x', 'gnome-shell'], capture_output=True).returncode == 0:
                time.sleep(0.1)
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
    if not report.exists():
        raise SystemExit(f'Smoke did not finish. See {OUTPUT / "shell.log"}')
    result = json.loads(report.read_text())
    # Crop each full-stage capture to its subject.
    for name, box in result.pop('crops', {}).items():
        image = OUTPUT / f'{name}.png'
        if image.exists():
            cropped = OUTPUT / f'{name}.crop.png'
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(image), '-vf',
                            f"crop={box['width']}:{box['height']}:{box['x']}:{box['y']}", str(cropped)], check=True)
            cropped.replace(image)
    print(json.dumps(result, indent=2))
    if not result.get('ok'):
        raise SystemExit(1)
