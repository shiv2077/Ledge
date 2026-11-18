#!/usr/bin/env python3
"""Generate Ledge's system diagrams in docs/diagrams.

Two diagrams, each written as an SVG (for the README) and an Excalidraw
scene (to edit): the loop Ledge closes between a developer and their agents,
and the agent pipeline. Dark, to sit on GitHub's dark page. Re-running
writes identical files.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'docs' / 'diagrams'
INK = {'bg': '#0d1117', 'node': '#161b22', 'edge': '#30363d', 'text': '#e6edf3', 'dim': '#8b949e',
       'accent': '#ff4d4d', 'stage': '#1f2630'}
FONT = "-apple-system, 'Segoe UI', 'Ubuntu', 'Helvetica Neue', Arial, sans-serif"
TITLE, SUB, HEAD = 15, 12, 11


class Diagram:
    def __init__(self, width: int, height: int, title: str):
        self.width, self.height, self.title = width, height, title
        self.nodes: list[dict] = []
        self.arrows: list[dict] = []
        self.labels: list[dict] = []

    def node(self, x, y, w, h, title, lines=(), accent=False, stage=False) -> int:
        self.nodes.append({'x': x, 'y': y, 'w': w, 'h': h, 'title': title, 'lines': list(lines), 'accent': accent, 'stage': stage})
        return len(self.nodes) - 1

    def arrow(self, points, accent=False):
        self.arrows.append({'points': points, 'accent': accent})

    def label(self, x, y, text, size=HEAD, color='dim', anchor='middle', weight=600, spacing=1.5):
        self.labels.append({'x': x, 'y': y, 'text': text, 'size': size, 'color': color, 'anchor': anchor, 'weight': weight, 'spacing': spacing})

    # ---- SVG ----

    def svg(self) -> str:
        out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}" viewBox="0 0 {self.width} {self.height}" '
               f'font-family="{escape(FONT)}"><title>{escape(self.title)}</title>',
               '<defs>'
               f'<marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{INK["dim"]}"/></marker>'
               f'<marker id="r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{INK["accent"]}"/></marker>'
               '</defs>',
               f'<rect width="100%" height="100%" rx="14" fill="{INK["bg"]}"/>']
        for n in self.nodes:
            if n['stage']:
                out.append(f'<rect x="{n["x"]}" y="{n["y"]}" width="{n["w"]}" height="{n["h"]}" rx="12" fill="{INK["stage"]}" fill-opacity="0.35" '
                           f'stroke="{INK["edge"]}" stroke-dasharray="3 5"/>')
        for a in self.arrows:
            pts = a['points']
            if len(pts) == 3:
                d = f'M{pts[0][0]:.1f},{pts[0][1]:.1f} Q{pts[1][0]:.1f},{pts[1][1]:.1f} {pts[2][0]:.1f},{pts[2][1]:.1f}'
            else:
                d = f'M{pts[0][0]:.1f},{pts[0][1]:.1f} ' + ' '.join(f'L{x:.1f},{y:.1f}' for x, y in pts[1:])
            color, marker = (INK['accent'], 'r') if a['accent'] else (INK['dim'], 'a')
            out.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="1.6" marker-end="url(#{marker})"/>')
        for n in self.nodes:
            if n['stage']:
                continue
            stroke = INK['accent'] if n['accent'] else INK['edge']
            out.append(f'<rect x="{n["x"]:.1f}" y="{n["y"]:.1f}" width="{n["w"]}" height="{n["h"]}" rx="10" fill="{INK["node"]}" '
                       f'stroke="{stroke}" stroke-width="1.2"/>')
            lines = [(n['title'], TITLE, INK['text'], 600)] + [(t, SUB, INK['dim'], 400) for t in n['lines']]
            total = sum(size * 1.45 for _, size, _, _ in lines)
            y = n['y'] + (n['h'] - total) / 2
            for text, size, color, weight in lines:
                y += size * 1.45
                out.append(f'<text x="{n["x"] + n["w"] / 2:.1f}" y="{y - size * 0.35:.1f}" text-anchor="middle" font-size="{size}" '
                           f'font-weight="{weight}" fill="{color}">{escape(text)}</text>')
        for t in self.labels:
            out.append(f'<text x="{t["x"]}" y="{t["y"]}" text-anchor="{t["anchor"]}" font-size="{t["size"]}" font-weight="{t["weight"]}" '
                       f'letter-spacing="{t["spacing"]}" fill="{INK[t["color"]]}">{escape(t["text"])}</text>')
        out.append('</svg>\n')
        return '\n'.join(out)

    # ---- Excalidraw ----

    def excalidraw(self) -> str:
        elements = []
        seed = [1]

        def base(kind, x, y, w, h, **extra):
            seed[0] += 1
            item = {'type': kind, 'id': f'{kind}{seed[0]}', 'x': x, 'y': y, 'width': w, 'height': h, 'angle': 0,
                    'strokeColor': INK['edge'], 'backgroundColor': 'transparent', 'fillStyle': 'solid', 'strokeWidth': 1,
                    'strokeStyle': 'solid', 'roughness': 0, 'opacity': 100, 'groupIds': [], 'frameId': None, 'seed': seed[0],
                    'version': 1, 'versionNonce': seed[0], 'isDeleted': False, 'boundElements': None, 'updated': 1,
                    'link': None, 'locked': False, 'roundness': {'type': 3}}
            item.update(extra)
            return item

        def text(x, y, w, value, size, color):
            return base('text', x, y, w, size * 1.3 * (value.count('\n') + 1), text=value, originalText=value, fontSize=size,
                        fontFamily=2, textAlign='center', verticalAlign='middle', containerId=None, strokeColor=color,
                        lineHeight=1.3, autoResize=True, roundness=None)

        for n in self.nodes:
            if n['stage']:
                elements.append(base('rectangle', n['x'], n['y'], n['w'], n['h'], strokeStyle='dashed', backgroundColor=INK['stage']))
                continue
            elements.append(base('rectangle', n['x'], n['y'], n['w'], n['h'], backgroundColor=INK['node'],
                                 strokeColor=INK['accent'] if n['accent'] else INK['edge']))
            elements.append(text(n['x'] + 8, n['y'] + 10, n['w'] - 16, '\n'.join([n['title'], *n['lines']]), SUB + 1, INK['text']))
        for a in self.arrows:
            pts = a['points']
            x0, y0 = pts[0]
            rel = [[x - x0, y - y0] for x, y in pts]
            xs, ys = [p[0] for p in rel], [p[1] for p in rel]
            elements.append(base('arrow', x0, y0, max(xs) - min(xs), max(ys) - min(ys), points=rel, startArrowhead=None,
                                 endArrowhead='arrow', strokeColor=INK['accent'] if a['accent'] else INK['dim'],
                                 startBinding=None, endBinding=None, lastCommittedPoint=None, roundness={'type': 2}))
        for t in self.labels:
            w = len(t['text']) * t['size'] * 0.62
            x = t['x'] - w / 2 if t['anchor'] == 'middle' else t['x']
            elements.append(text(x, t['y'] - t['size'], w, t['text'], t['size'], INK[t['color']]))
        scene = {'type': 'excalidraw', 'version': 2, 'source': 'scripts/diagrams.py', 'elements': elements,
                 'appState': {'viewBackgroundColor': INK['bg'], 'gridSize': None}, 'files': {}}
        return json.dumps(scene, indent=1) + '\n'


def edge_point(n: dict, toward: tuple[float, float]) -> tuple[float, float]:
    """Where the line from a node's centre toward a point leaves its box."""
    cx, cy = n['x'] + n['w'] / 2, n['y'] + n['h'] / 2
    dx, dy = toward[0] - cx, toward[1] - cy
    scale = min((n['w'] / 2) / abs(dx) if dx else math.inf, (n['h'] / 2) / abs(dy) if dy else math.inf)
    return cx + dx * scale * 1.04, cy + dy * scale * 1.04


def loop() -> Diagram:
    """The loop Ledge closes: agents work, Ledge observes and understands,
    the top bar surfaces it, the developer acts, the agents go on."""
    d = Diagram(1080, 660, 'Ledge system design: the agent loop')
    d.label(540, 44, 'LEDGE · SYSTEM DESIGN', size=13, color='text', spacing=3)
    d.label(540, 66, 'A local loop between you and your coding agents', size=12, color='dim', weight=400, spacing=0)
    cx, cy, rx, ry, w, h = 540, 360, 380, 210, 280, 92
    steps = [
        ('You', ['run several AI coding agents', 'across terminals and worktrees'], False),
        ('Coding agents', ['Claude Code · Codex · other CLIs', 'they work, ask and finish'], False),
        ('Observe', ['agent hooks · session files', 'workspace panes · provider limits'], False),
        ('Understand', ['one entry per agent · worktree', 'clashes · waiting queue · pace'], False),
        ('Surface', ['lens · dot strip · dropdowns', 'red when something needs you'], True),
        ('Act', ['jump to the waiting agent', 'approve, answer, or pace work'], False),
    ]
    ids = []
    for i, (title, lines, accent) in enumerate(steps):
        angle = -math.pi / 2 + i * 2 * math.pi / len(steps)
        ids.append(d.node(cx + rx * math.cos(angle) - w / 2, cy + ry * math.sin(angle) - h / 2, w, h, title, lines, accent=accent))
    for i, a in enumerate(ids):
        na, nb = d.nodes[a], d.nodes[ids[(i + 1) % len(ids)]]
        ca = (na['x'] + na['w'] / 2, na['y'] + na['h'] / 2)
        cb = (nb['x'] + nb['w'] / 2, nb['y'] + nb['h'] / 2)
        mid = ((ca[0] + cb[0]) / 2, (ca[1] + cb[1]) / 2)
        # Bow each arrow outward from the loop's centre.
        out = (mid[0] - cx, mid[1] - cy)
        length = math.hypot(*out) or 1
        ctrl = (mid[0] + out[0] / length * 50, mid[1] + out[1] / length * 50)
        d.arrow([edge_point(na, ctrl), ctrl, edge_point(nb, ctrl)], accent=i in (3, 4))
    d.label(cx, cy - 10, 'OBSERVE → UNDERSTAND', size=12, color='dim')
    d.label(cx, cy + 14, 'SURFACE → ACT', size=12, color='accent')
    d.label(cx, cy + 44, 'on your machine · no telemetry · no message text', size=11, color='dim', weight=400, spacing=0)
    return d


def agents() -> Diagram:
    """How agents travel from where they run to the top bar."""
    d = Diagram(1080, 540, 'Ledge agent pipeline')
    d.label(540, 40, 'MULTIPLE AGENTS · PIPELINE', size=13, color='text', spacing=3)
    stages = [(40, 'SIGNALS'), (300, 'COLLECT'), (560, 'UNDERSTAND'), (820, 'SURFACE')]
    for x, name in stages:
        d.node(x - 12, 70, 244, 440, '', stage=True)
        d.label(x + 110, 98, name, size=11, color='dim')
    w, h = 220, 72
    signals = [('Agent hooks', ['working · waiting · done']), ('Session files', ['Claude Code and Codex']),
               ('Agent workspace', ['panes running agents']), ('Running processes', ['any agent CLI'])]
    collectors = [('Status reader', ['exact states']), ('Session reader', ['estimated states']),
                  ('Workspace reader', ['read only, every few s']), ('Process scan', ['shown as running'])]
    sig = [d.node(40, 125 + i * 92, w, h, t, l) for i, (t, l) in enumerate(signals)]
    col = [d.node(300, 125 + i * 92, w, h, t, l) for i, (t, l) in enumerate(collectors)]
    merge = d.node(560, 150, w, 96, 'Merge', ['one entry per agent', 'by process, session or folder', 'most exact state wins'])
    context = d.node(560, 320, w, 96, 'Context', ['git worktree and branch', 'clash: 2+ active, same tree', 'waiting queue, oldest first'])
    outs = [('Dot constellation', ['white working · red waiting', 'count in the strip']),
            ('Agents dropdown', ['waiting first, then by tree', 'click a row to jump']),
            ('Jump shortcut', ['Super+Shift+N raises the', 'agent that waited longest'])]
    out = [d.node(820, 125 + i * 125, w, 86, t, l, accent=i == 0) for i, (t, l) in enumerate(outs)]
    for a, b in zip(sig, col):
        na, nb = d.nodes[a], d.nodes[b]
        d.arrow([(na['x'] + w + 2, na['y'] + h / 2), (nb['x'] - 4, nb['y'] + h / 2)])
    m, c = d.nodes[merge], d.nodes[context]
    for i in col:
        n = d.nodes[i]
        d.arrow([(n['x'] + w + 2, n['y'] + h / 2), (m['x'] - 20, m['y'] + 48), (m['x'] - 4, m['y'] + 48)])
    d.arrow([(m['x'] + w / 2, m['y'] + 98), (c['x'] + w / 2, c['y'] - 4)])
    for i, o in enumerate(out):
        n = d.nodes[o]
        d.arrow([(c['x'] + w + 2, c['y'] + 48), (n['x'] - 20, n['y'] + 43), (n['x'] - 4, n['y'] + 43)], accent=i == 0)
    return d


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, diagram in {'loop': loop(), 'agents': agents()}.items():
        (OUT / f'{name}.svg').write_text(diagram.svg())
        (OUT / f'{name}.excalidraw').write_text(diagram.excalidraw())
    print(f'Wrote 2 diagrams to {OUT}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
