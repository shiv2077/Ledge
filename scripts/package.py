#!/usr/bin/env python3
"""Build an extension zip with an explicit file list; never package account data."""
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent
subprocess.run(['glib-compile-schemas', '--strict', str(ROOT / 'schemas')], check=True)
files = ['metadata.json', 'extension.js', 'model.js', 'design.js', 'draw.js', 'glyphs.js',
         'prefs.js', 'stylesheet.css', 'LICENSE', 'THIRD_PARTY_LICENSES', 'README.md',
         'lib/module.js', 'lib/subprocess.js', 'lib/http.js', 'lib/files.js',
         'modules/usage.js', 'modules/power.js', 'modules/todo.js', 'modules/models.js',
         'modules/github.js', 'modules/training.js', 'tools/ledge_status.py',
         'reader/usage_reader.py', 'reader/activity.py',
         'schemas/org.gnome.shell.extensions.ledge.gschema.xml', 'schemas/gschemas.compiled']
target = ROOT / 'dist/ledge@shiv2077.shell-extension.zip'
target.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(ROOT / name, name)
print(target)
