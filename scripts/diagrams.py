#!/usr/bin/env python3
"""Generate the architecture diagrams in docs/diagrams from the code.

Reads the module order from extension.js, each module's data sources from
its file, and the placements from lib/. Writes an Excalidraw scene and an
SVG for each diagram. Re-running with unchanged code writes identical files.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'docs' / 'diagrams'
BOX_W, BOX_H, GAP_X, GAP_Y, PAD = 220, 44, 90, 14, 24
FONT = 15
COLORS = {'host': '#E8ECF2', 'place': '#D7E3FC', 'module': '#E2F5D8', 'source': '#FCE7D2', 'stroke': '#232A33'}

SOURCE_PATTERNS = [
    (r"reader/([a-z_]+\.py)", lambda m: f'reader/{m.group(1)}'),
    (r"_args\('([a-z_]+\.py)'\)", lambda m: f'reader/{m.group(1)}'),
    (r"\[\s*'gh'|run\(\['gh'", lambda m: 'gh CLI'),
    (r"127\.0\.0\.1:(\d+)", lambda m: f'localhost:{m.group(1)}'),
    (r"llamacpp-port", lambda m: 'localhost:llamacpp-port'),
    (r"'nvidia-smi'", lambda m: 'nvidia-smi'),
    (r"PowerProfiles|net\.hadess|UPower", lambda m: 'power-profiles-daemon (D-Bus)'),
    (r"FileMonitor|monitor_directory", lambda m: '~/.local/share/ledge/runs'),
    (r"todos\.json", lambda m: '~/.local/share/ledge/todos.json'),
]


def module_order() -> list[tuple[str, str]]:
    """(class name, file) in chip order, from extension.js."""

    text = (ROOT / 'extension.js').read_text()
    imports = dict((name, path) for names, path in re.findall(r"import \{([^}]+)\} from '\./(modules/[a-z]+\.js)'", text)
                   for name in [n.strip() for n in names.split(',')])
    order = re.search(r"const MODULES = \[([^\]]+)\]", text).group(1)
    result = []
    for token in [t.strip() for t in order.split(',') if t.strip()]:
        name = token.lstrip('.')
        result.append((name, imports[name]))
    return result


def sources(path: str) -> list[str]:
    text = (ROOT / path).read_text()
    found: list[str] = []
    for pattern, label in SOURCE_PATTERNS:
        for match in re.finditer(pattern, text):
            value = label(match)
            if value not in found:
                found.append(value)
    return found


def label_of(name: str) -> str:
    if name == 'USAGE_MODULES':
        return 'Claude, Cursor, Codex'
    return {'GithubModule': 'GitHub', 'CopilotModule': 'Copilot'}.get(name, re.sub(r'Module$', '', name))


class Scene:
    def __init__(self) -> None:
        self.boxes: list[dict] = []
        self.arrows: list[tuple[int, int]] = []

    def box(self, column: int, row: int, text: str, kind: str) -> int:
        self.boxes.append({'x': PAD + column * (BOX_W + GAP_X), 'y': PAD + row * (BOX_H + GAP_Y), 'text': text, 'kind': kind})
        return len(self.boxes) - 1

    def arrow(self, a: int, b: int) -> None:
        if (a, b) not in self.arrows:
            self.arrows.append((a, b))

    def size(self) -> tuple[int, int]:
        width = max(b['x'] for b in self.boxes) + BOX_W + PAD
        height = max(b['y'] for b in self.boxes) + BOX_H + PAD
        return width, height

    def _ends(self, a: int, b: int) -> tuple[float, float, float, float]:
        x1 = self.boxes[a]['x'] + BOX_W
        y1 = self.boxes[a]['y'] + BOX_H / 2
        x2 = self.boxes[b]['x']
        y2 = self.boxes[b]['y'] + BOX_H / 2
        return x1, y1, x2, y2

    def svg(self, title: str) -> str:
        width, height = self.size()
        parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" '
                 f'font-family="sans-serif" font-size="{FONT}"><title>{escape(title)}</title>',
                 '<defs><marker id="head" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto">'
                 f'<path d="M0,0 L10,5 L0,10 z" fill="{COLORS["stroke"]}"/></marker></defs>',
                 f'<rect width="{width}" height="{height}" fill="#FFFFFF"/>']
        for a, b in self.arrows:
            x1, y1, x2, y2 = self._ends(a, b)
            parts.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{COLORS["stroke"]}" stroke-width="1.2" marker-end="url(#head)"/>')
        for b in self.boxes:
            parts.append(f'<rect x="{b["x"]}" y="{b["y"]}" width="{BOX_W}" height="{BOX_H}" fill="{COLORS[b["kind"]]}" '
                         f'stroke="{COLORS["stroke"]}" stroke-width="1"/>')
            parts.append(f'<text x="{b["x"] + BOX_W / 2}" y="{b["y"] + BOX_H / 2 + FONT / 3}" text-anchor="middle" '
                         f'fill="{COLORS["stroke"]}">{escape(b["text"])}</text>')
        parts.append('</svg>\n')
        return '\n'.join(parts)

    def excalidraw(self) -> str:
        elements = []
        for i, b in enumerate(self.boxes):
            elements.append({'type': 'rectangle', 'id': f'box{i}', 'x': b['x'], 'y': b['y'], 'width': BOX_W, 'height': BOX_H,
                             'strokeColor': COLORS['stroke'], 'backgroundColor': COLORS[b['kind']], 'fillStyle': 'solid',
                             'strokeWidth': 1, 'roughness': 0, 'opacity': 100, 'angle': 0, 'seed': i + 1, 'version': 1,
                             'versionNonce': i + 1, 'isDeleted': False, 'groupIds': [], 'boundElements': [{'type': 'text', 'id': f'text{i}'}],
                             'roundness': None, 'locked': False, 'link': None, 'updated': 1, 'frameId': None, 'strokeStyle': 'solid'})
            elements.append({'type': 'text', 'id': f'text{i}', 'x': b['x'] + 8, 'y': b['y'] + BOX_H / 2 - FONT * 0.65,
                             'width': BOX_W - 16, 'height': FONT * 1.3, 'text': b['text'], 'originalText': b['text'],
                             'fontSize': FONT, 'fontFamily': 2, 'textAlign': 'center', 'verticalAlign': 'middle', 'containerId': f'box{i}',
                             'strokeColor': COLORS['stroke'], 'backgroundColor': 'transparent', 'fillStyle': 'solid', 'strokeWidth': 1,
                             'roughness': 0, 'opacity': 100, 'angle': 0, 'seed': 1000 + i, 'version': 1, 'versionNonce': 1000 + i,
                             'isDeleted': False, 'groupIds': [], 'boundElements': None, 'roundness': None, 'locked': False,
                             'link': None, 'updated': 1, 'frameId': None, 'strokeStyle': 'solid', 'lineHeight': 1.25, 'autoResize': True})
        for j, (a, b) in enumerate(self.arrows):
            x1, y1, x2, y2 = self._ends(a, b)
            elements.append({'type': 'arrow', 'id': f'arrow{j}', 'x': x1, 'y': y1, 'width': x2 - x1, 'height': y2 - y1,
                             'points': [[0, 0], [x2 - x1, y2 - y1]], 'startBinding': {'elementId': f'box{a}', 'focus': 0, 'gap': 1},
                             'endBinding': {'elementId': f'box{b}', 'focus': 0, 'gap': 1}, 'endArrowhead': 'arrow', 'startArrowhead': None,
                             'strokeColor': COLORS['stroke'], 'backgroundColor': 'transparent', 'fillStyle': 'solid', 'strokeWidth': 1,
                             'roughness': 0, 'opacity': 100, 'angle': 0, 'seed': 2000 + j, 'version': 1, 'versionNonce': 2000 + j,
                             'isDeleted': False, 'groupIds': [], 'boundElements': None, 'roundness': None, 'locked': False,
                             'link': None, 'updated': 1, 'frameId': None, 'strokeStyle': 'solid', 'lastCommittedPoint': None})
        scene = {'type': 'excalidraw', 'version': 2, 'source': 'scripts/diagrams.py', 'elements': elements,
                 'appState': {'viewBackgroundColor': '#ffffff', 'gridSize': None}, 'files': {}}
        return json.dumps(scene, indent=1) + '\n'


def architecture() -> Scene:
    scene = Scene()
    host = scene.box(0, 3, 'extension.js (host)', 'host')
    rail = scene.box(1, 1, 'lib/rail.js (edge)', 'place')
    panel = scene.box(1, 2, 'lib/panel.js (top bar)', 'place')
    strip = scene.box(1, 4, 'lib/strip.js (chips)', 'place')
    deck = scene.box(1, 5, 'lib/deck.js (deck)', 'place')
    for target in (rail, panel):
        scene.arrow(host, target)
    for placement in (rail, panel):
        scene.arrow(placement, strip)
        scene.arrow(placement, deck)
    source_rows: dict[str, int] = {}
    for row, (name, path) in enumerate(module_order()):
        module = scene.box(2, row, f'{label_of(name)} · {Path(path).name}', 'module')
        scene.arrow(host, module)
        for source in sources(path):
            if source not in source_rows:
                source_rows[source] = scene.box(3, len(source_rows), source, 'source')
            scene.arrow(module, source_rows[source])
    return scene


def readers() -> Scene:
    scene = Scene()
    flows = [
        ('modules/usage.js', ['reader/usage_reader.py', 'reader/activity.py', 'reader/costs.py'],
         [['usage endpoints, sign-ins'], ['~/.claude/sessions, Cursor, Codex'], ['~/.claude/projects, ~/.codex/sessions']]),
        ('modules/models.js', ['reader/lmstudio.py'], [['~/.lmstudio/server-logs']]),
    ]
    row = 0
    for module, scripts, inputs in flows:
        m = scene.box(0, row, module, 'module')
        for script, files in zip(scripts, inputs):
            s = scene.box(1, row, script, 'place')
            scene.arrow(m, s)
            for item in files:
                scene.arrow(s, scene.box(2, row, item, 'source'))
            row += 1
    cache = scene.box(3, 1, '~/.cache/ledge (0600)', 'host')
    for i, b in enumerate(scene.boxes):
        if b['text'] in ('reader/usage_reader.py', 'reader/costs.py', 'reader/lmstudio.py'):
            scene.arrow(i, cache)
    return scene


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    diagrams = {'architecture': ('Ledge architecture', architecture()), 'readers': ('Ledge readers', readers())}
    for name, (title, scene) in diagrams.items():
        (OUT / f'{name}.svg').write_text(scene.svg(title))
        (OUT / f'{name}.excalidraw').write_text(scene.excalidraw())
    print(f'Wrote {len(diagrams)} diagrams to {OUT}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
