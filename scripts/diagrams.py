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
    (r"lib/agents/([a-z]+)\.js", lambda m: {'status': 'hook status files', 'workspace': 'workspace snapshot',
        'sessions': 'Claude / Codex sessions', 'proc': '/proc agent scan'}.get(m.group(1), m.group(1))),
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


def wobble(a: float, b: float, amount: float = 1.6) -> float:
    """A small offset that depends only on its inputs, so output is stable."""
    return ((int(a * 7 + b * 13) % 17) / 17 - 0.5) * amount


def sketch_rect(x: float, y: float, w: float, h: float, pass_: int) -> str:
    """A hand-drawn rectangle: corners nudged, edges slightly bowed."""
    k = pass_ + 1
    pts = [(x + wobble(x, y * k), y + wobble(y, x * k)), (x + w + wobble(w, y * k), y + wobble(x * k, w)),
           (x + w + wobble(h, x * k), y + h + wobble(w * k, h)), (x + wobble(y * k, h), y + h + wobble(h * k, x))]
    d = f'M{pts[0][0]:.1f},{pts[0][1]:.1f}'
    for i in range(1, 5):
        (ax, ay), (bx, by) = pts[i - 1], pts[i % 4]
        cx, cy = (ax + bx) / 2 + wobble(ax, by * k, 2.4), (ay + by) / 2 + wobble(ay * k, bx, 2.4)
        d += f' Q{cx:.1f},{cy:.1f} {bx:.1f},{by:.1f}'
    return d


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
        # A box to the left: leave from the left edge.
        if self.boxes[b]['x'] < self.boxes[a]['x']:
            return (self.boxes[a]['x'], self.boxes[a]['y'] + BOX_H / 2,
                    self.boxes[b]['x'] + BOX_W, self.boxes[b]['y'] + BOX_H / 2)
        # Boxes in one column connect bottom to top.
        if self.boxes[a]['x'] == self.boxes[b]['x']:
            x = self.boxes[a]['x'] + BOX_W / 2
            return x, self.boxes[a]['y'] + BOX_H, x, self.boxes[b]['y']
        x1 = self.boxes[a]['x'] + BOX_W
        y1 = self.boxes[a]['y'] + BOX_H / 2
        x2 = self.boxes[b]['x']
        y2 = self.boxes[b]['y'] + BOX_H / 2
        return x1, y1, x2, y2

    def svg(self, title: str) -> str:
        width, height = self.size()
        parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" '
                 f'font-family="Virgil, \'Comic Neue\', \'Comic Sans MS\', cursive" font-size="{FONT}"><title>{escape(title)}</title>',
                 '<defs><marker id="head" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto">'
                 f'<path d="M0,0 L10,5 L0,10 z" fill="{COLORS["stroke"]}"/></marker></defs>',
                 f'<rect width="{width}" height="{height}" fill="#FFFFFF"/>']
        for a, b in self.arrows:
            x1, y1, x2, y2 = self._ends(a, b)
            mx, my = (x1 + x2) / 2 + wobble(x1, y2, 6), (y1 + y2) / 2 + wobble(y1, x2, 6)
            parts.append(f'<path d="M{x1:.1f},{y1:.1f} Q{mx:.1f},{my:.1f} {x2:.1f},{y2:.1f}" fill="none" stroke="{COLORS["stroke"]}" '
                         f'stroke-width="1.3" stroke-linecap="round" marker-end="url(#head)"/>')
        for b in self.boxes:
            # Excalidraw-style: a fill, then two slightly wobbly outlines.
            parts.append(f'<rect x="{b["x"]}" y="{b["y"]}" width="{BOX_W}" height="{BOX_H}" fill="{COLORS[b["kind"]]}"/>')
            for pass_ in range(2):
                parts.append(f'<path d="{sketch_rect(b["x"], b["y"], BOX_W, BOX_H, pass_)}" fill="none" '
                             f'stroke="{COLORS["stroke"]}" stroke-width="1.3" stroke-linecap="round"/>')
            parts.append(f'<text x="{b["x"] + BOX_W / 2}" y="{b["y"] + BOX_H / 2 + FONT / 3}" text-anchor="middle" '
                         f'fill="{COLORS["stroke"]}">{escape(b["text"])}</text>')
        parts.append('</svg>\n')
        return '\n'.join(parts)

    def excalidraw(self) -> str:
        elements = []
        for i, b in enumerate(self.boxes):
            elements.append({'type': 'rectangle', 'id': f'box{i}', 'x': b['x'], 'y': b['y'], 'width': BOX_W, 'height': BOX_H,
                             'strokeColor': COLORS['stroke'], 'backgroundColor': COLORS[b['kind']], 'fillStyle': 'solid',
                             'strokeWidth': 1, 'roughness': 1, 'opacity': 100, 'angle': 0, 'seed': i + 1, 'version': 1,
                             'versionNonce': i + 1, 'isDeleted': False, 'groupIds': [], 'boundElements': [{'type': 'text', 'id': f'text{i}'}],
                             'roundness': None, 'locked': False, 'link': None, 'updated': 1, 'frameId': None, 'strokeStyle': 'solid'})
            elements.append({'type': 'text', 'id': f'text{i}', 'x': b['x'] + 8, 'y': b['y'] + BOX_H / 2 - FONT * 0.65,
                             'width': BOX_W - 16, 'height': FONT * 1.3, 'text': b['text'], 'originalText': b['text'],
                             'fontSize': FONT, 'fontFamily': 1, 'textAlign': 'center', 'verticalAlign': 'middle', 'containerId': f'box{i}',
                             'strokeColor': COLORS['stroke'], 'backgroundColor': 'transparent', 'fillStyle': 'solid', 'strokeWidth': 1,
                             'roughness': 1, 'opacity': 100, 'angle': 0, 'seed': 1000 + i, 'version': 1, 'versionNonce': 1000 + i,
                             'isDeleted': False, 'groupIds': [], 'boundElements': None, 'roundness': None, 'locked': False,
                             'link': None, 'updated': 1, 'frameId': None, 'strokeStyle': 'solid', 'lineHeight': 1.25, 'autoResize': True})
        for j, (a, b) in enumerate(self.arrows):
            x1, y1, x2, y2 = self._ends(a, b)
            elements.append({'type': 'arrow', 'id': f'arrow{j}', 'x': x1, 'y': y1, 'width': x2 - x1, 'height': y2 - y1,
                             'points': [[0, 0], [x2 - x1, y2 - y1]], 'startBinding': {'elementId': f'box{a}', 'focus': 0, 'gap': 1},
                             'endBinding': {'elementId': f'box{b}', 'focus': 0, 'gap': 1}, 'endArrowhead': 'arrow', 'startArrowhead': None,
                             'strokeColor': COLORS['stroke'], 'backgroundColor': 'transparent', 'fillStyle': 'solid', 'strokeWidth': 1,
                             'roughness': 1, 'opacity': 100, 'angle': 0, 'seed': 2000 + j, 'version': 1, 'versionNonce': 2000 + j,
                             'isDeleted': False, 'groupIds': [], 'boundElements': None, 'roundness': None, 'locked': False,
                             'link': None, 'updated': 1, 'frameId': None, 'strokeStyle': 'solid', 'lastCommittedPoint': None})
        scene = {'type': 'excalidraw', 'version': 2, 'source': 'scripts/diagrams.py', 'elements': elements,
                 'appState': {'viewBackgroundColor': '#ffffff', 'gridSize': None}, 'files': {}}
        return json.dumps(scene, indent=1) + '\n'


def architecture() -> Scene:
    """Placements on the left of the host, modules on its right, each one
    level with its own sources."""
    scene = Scene()
    order = module_order()
    rows: list[tuple[str, str, int, list[str]]] = []
    next_row = 0
    seen: set[str] = set()
    for name, path in order:
        own = [source for source in sources(path) if source not in seen]
        seen.update(own)
        rows.append((name, path, next_row, sources(path)))
        next_row += max(1, len(own))
    host = scene.box(1, (next_row - 1) / 2, 'extension.js (host)', 'host')
    places = ['lib/shelf.js (lens + strip)', 'lib/rail.js (edge rail)', 'lib/panel.js (top bar chips)', 'lib/deck.js (dropdown)']
    for i, label in enumerate(places):
        scene.arrow(host, scene.box(0, (next_row - len(places)) / 2 + i, label, 'place'))
    sources_at: dict[str, int] = {}
    for name, path, row, own in rows:
        module = scene.box(2, row, f'{label_of(name)} · {Path(path).name}', 'module')
        scene.arrow(host, module)
        offset = 0
        for source in own:
            if source not in sources_at:
                sources_at[source] = scene.box(3, row + offset, source, 'source')
                offset += 1
            scene.arrow(module, sources_at[source])
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


def agents() -> Scene:
    """Where agents come from, how they are merged, and where they show."""
    scene = Scene()
    hooks = scene.box(0, 0, 'Claude Code hooks', 'source')
    workspace = scene.box(0, 2, 'multi-agent workspace panes', 'source')
    sessions = scene.box(0, 3, 'Claude / Codex session files', 'source')
    procs = scene.box(0, 4, 'running agent CLIs', 'source')
    writer = scene.box(1, 0, 'tools/ledge_agent.py', 'place')
    files = scene.box(1, 1, '~/.local/share/ledge/agents', 'host')
    status = scene.box(2, 1, 'lib/agents/status.js', 'module')
    workspace_js = scene.box(2, 2, 'lib/agents/workspace.js', 'module')
    sessions_js = scene.box(2, 3, 'lib/agents/sessions.js', 'module')
    proc_js = scene.box(2, 4, 'lib/agents/proc.js', 'module')
    merge = scene.box(3, 2, 'mergeAgents (by pid)', 'place')
    trees = scene.box(3, 3, 'worktree, branch, collisions', 'place')
    module = scene.box(4, 2, 'modules/agents.js', 'host')
    shelf = scene.box(5, 1, 'strip: dot constellation', 'place')
    card = scene.box(5, 2, 'card: waiting first, by tree', 'place')
    jump = scene.box(5, 3, 'Super+Shift+N: raise', 'place')
    for a, b in [(hooks, writer), (writer, files), (files, status), (workspace, workspace_js), (sessions, sessions_js),
                 (procs, proc_js), (status, merge), (workspace_js, merge), (sessions_js, merge), (proc_js, merge),
                 (merge, module), (trees, module), (module, shelf), (module, card), (module, jump)]:
        scene.arrow(a, b)
    return scene


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    diagrams = {'architecture': ('Ledge architecture', architecture()), 'readers': ('Ledge readers', readers()),
                'agents': ('Ledge agent radar', agents())}
    for name, (title, scene) in diagrams.items():
        (OUT / f'{name}.svg').write_text(scene.svg(title))
        (OUT / f'{name}.excalidraw').write_text(scene.excalidraw())
    print(f'Wrote {len(diagrams)} diagrams to {OUT}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
