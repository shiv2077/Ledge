// Cairo drawing for the Deck look: chamfered panels, segmented meters and
// monogram badges. Colors arrive resolved from the theme.
import Cairo from 'cairo';
import {CHAMFER, METER, TYPE, CHIP, chamferPoints, dotGlyphs, dotOrder} from './design.js';
import {rgba} from './themes.js';

// Source color with its own alpha scaled by `alpha`.
function source(cr, color, alpha = 1) {
    const [r, g, b, a] = rgba(color);
    cr.setSourceRGBA(r, g, b, a * alpha);
}

function trace(cr, points, close) {
    cr.newPath();
    points.forEach(([x, y], i) => i ? cr.lineTo(x, y) : cr.moveTo(x, y));
    if (close) cr.closePath();
}

// Outline of a shape attached to `edge`, both far corners cut.
export function traceChamfer(cr, edge, width, height, cut) {
    trace(cr, chamferPoints(edge, width, height, cut), true);
}

// Clears the area, then fills the chamfered shape and strokes a hairline on
// the three sides away from `edge`. Options:
//   rule: {color, width, start, length}  accent line along the attached side
//   mark: {color, at, length}  accent segment on the far side, centred at `at`
//                              along the edge (the bracket to an open deck)
export function drawPanel(cr, edge, width, height, cut, fill, border, {rule = null, mark = null} = {}) {
    cr.save();
    cr.setOperator(0); // clear
    cr.paint();
    cr.setOperator(2); // over
    const points = chamferPoints(edge, width, height, cut);
    trace(cr, points, true);
    source(cr, fill);
    cr.fill();
    if (border) {
        // Half a pixel inside, so the hairline is crisp and inside the fill.
        const inset = chamferPoints(edge, width, height, cut).map(([x, y]) => [
            Math.min(width - 0.5, Math.max(0.5, x)), Math.min(height - 0.5, Math.max(0.5, y))]);
        const vertical = edge === 'left' || edge === 'right';
        // The two end points sit on the attached side; push them back out so
        // the stroke runs to the screen edge.
        for (const i of [0, inset.length - 1]) {
            if (vertical) inset[i][0] = points[i][0];
            else inset[i][1] = points[i][1];
        }
        trace(cr, inset, false);
        cr.setLineWidth(1);
        source(cr, border);
        cr.stroke();
    }
    if (rule) {
        source(cr, rule.color);
        const vertical = edge === 'left' || edge === 'right';
        const from = Math.max(0, rule.start ?? 0);
        const span = Math.min((vertical ? height : width) - from, rule.length ?? Infinity);
        if (edge === 'right') cr.rectangle(width - rule.width, from, rule.width, span);
        else if (edge === 'left') cr.rectangle(0, from, rule.width, span);
        else if (edge === 'top') cr.rectangle(from, 0, span, rule.width);
        else cr.rectangle(from, height - rule.width, span, rule.width);
        cr.fill();
    }
    if (mark) {
        source(cr, mark.color);
        const start = Math.round(mark.at - mark.length / 2);
        if (edge === 'right') cr.rectangle(0, start, 1, mark.length);
        else if (edge === 'left') cr.rectangle(width - 1, start, 1, mark.length);
        else if (edge === 'top') cr.rectangle(start, height - 1, mark.length, 1);
        else cr.rectangle(start, 0, mark.length, 1);
        cr.fill();
    }
    cr.restore();
}

// A box with its top right corner cut: chip hover and focus backgrounds.
function traceCut(cr, x, y, width, height, cut) {
    trace(cr, [[x, y], [x + width - cut, y], [x + width, y + cut], [x + width, y + height], [x, y + height]], true);
}

// A box with one corner cut, 'tl', 'tr', 'bl' or 'br', or none for null.
function traceCorner(cr, x, y, width, height, cut, corner) {
    const c = corner ? cut : 0;
    const [l, t, r, b] = [x, y, x + width, y + height];
    trace(cr, [
        [l + (corner === 'tl' ? c : 0), t], [r - (corner === 'tr' ? c : 0), t], [r, t + (corner === 'tr' ? c : 0)],
        [r, b - (corner === 'br' ? c : 0)], [r - (corner === 'br' ? c : 0), b], [l + (corner === 'bl' ? c : 0), b],
        [l, b - (corner === 'bl' ? c : 0)], [l, t + (corner === 'tl' ? c : 0)],
    ], true);
}

// Chip hover and focus backgrounds. `corner` is the cut corner, the one
// facing away from the screen edge, or null for none.
export function drawChipBackground(cr, width, height, fill, outline, corner) {
    cr.setOperator(0);
    cr.paint();
    cr.setOperator(2);
    if (fill) {
        traceCorner(cr, 0, 0, width, height, CHAMFER.small, corner);
        source(cr, fill);
        cr.fill();
    }
    if (outline) {
        traceCorner(cr, 0.5, 0.5, width - 1, height - 1, CHAMFER.small, corner);
        cr.setLineWidth(1);
        source(cr, outline);
        cr.stroke();
    }
}

// The tick as a small mark, for the summary chip.
export function drawTickMark(cr, width, height, color) {
    cr.setOperator(0);
    cr.paint();
    cr.setOperator(2);
    trace(cr, chamferPoints('left', width, height, CHAMFER.small), true);
    source(cr, color);
    cr.fill();
}

// A row of segments. `fills` holds each segment's lit share, 0..1.
export function drawMeter(cr, x, y, width, height, gap, fills, lit, off, stale = false) {
    const count = fills.length;
    const segment = (width - gap * (count - 1)) / count;
    fills.forEach((fill, i) => {
        const left = x + i * (segment + gap);
        source(cr, off);
        cr.rectangle(left, y, segment, height);
        cr.fill();
        if (fill > 0) {
            source(cr, lit, stale ? METER.staleAlpha : 1);
            cr.rectangle(left, y, segment * fill, height);
            cr.fill();
        }
    });
}

// Monogram badge: a square with one cut corner in a faint accent wash, and
// two letters in the accent.
function roundedPath(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// The shelf's glass: a tinted rounded sheet with a soft sheen from the top
// and a light rim. Under it, the actor's blur shows the desktop.
export function drawGlass(cr, w, h, radius, tint, alpha, sheen, rim) {
    const [r, g, b] = rgba(tint);
    roundedPath(cr, 0.5, 0.5, w - 1, h - 1, radius);
    cr.setSourceRGBA(r, g, b, alpha);
    cr.fillPreserve();
    const light = new Cairo.LinearGradient(0, 0, 0, h);
    light.addColorStopRGBA(0, 1, 1, 1, sheen);
    light.addColorStopRGBA(0.45, 1, 1, 1, 0);
    cr.setSource(light);
    cr.fillPreserve();
    const edge = new Cairo.LinearGradient(0, 0, 0, h);
    edge.addColorStopRGBA(0, 1, 1, 1, rim);
    edge.addColorStopRGBA(1, 1, 1, 1, rim / 3);
    cr.setSource(edge);
    cr.setLineWidth(1);
    cr.stroke();
}

// A smooth rounded track with a rounded fill, for meters in the shelf.
export function drawTrack(cr, w, h, fraction, color, off, stale = false) {
    const [r, g, b] = rgba(off);
    roundedPath(cr, 0, 0, w, h, h / 2);
    cr.setSourceRGBA(r, g, b, 1);
    cr.fill();
    if (typeof fraction !== 'number' || fraction <= 0) return;
    const [fr, fg, fb] = rgba(color);
    roundedPath(cr, 0, 0, Math.max(h, w * Math.min(1, fraction)), h, h / 2);
    const fill = new Cairo.LinearGradient(0, 0, w, 0);
    fill.addColorStopRGBA(0, fr, fg, fb, stale ? 0.3 : 0.55);
    fill.addColorStopRGBA(1, fr, fg, fb, stale ? 0.45 : 1);
    cr.setSource(fill);
    cr.fill();
}

// A glass tube holding `level` (0..1) of liquid whose surface is a wave at
// `phase`. The tube is a capsule; the liquid brightens toward its surface.
export function drawTube(cr, w, h, level, phase, amplitude, waveLength, color, glass, stale = false) {
    const [r, g, b] = rgba(color);
    const [gr, gg, gb] = rgba(glass);
    roundedPath(cr, 0.75, 0.75, w - 1.5, h - 1.5, w / 2 - 0.75);
    cr.setSourceRGBA(gr, gg, gb, 0.55);
    cr.fillPreserve();
    cr.save();
    cr.clip();
    if (typeof level === 'number' && level > 0) {
        const top = h - level * h;
        cr.moveTo(0, h);
        for (let x = 0; x <= w; x += 1) cr.lineTo(x, top + amplitude * Math.sin(x / waveLength + phase));
        cr.lineTo(w, h);
        cr.closePath();
        const fill = new Cairo.LinearGradient(0, top, 0, h);
        fill.addColorStopRGBA(0, r, g, b, stale ? 0.45 : 0.95);
        fill.addColorStopRGBA(1, r, g, b, stale ? 0.15 : 0.35);
        cr.setSource(fill);
        cr.fill();
    }
    cr.restore();
    roundedPath(cr, 0.75, 0.75, w - 1.5, h - 1.5, w / 2 - 0.75);
    cr.setSourceRGBA(1, 1, 1, 0.14);
    cr.setLineWidth(1);
    cr.stroke();
    // A highlight down the left wall, as on curved glass.
    cr.rectangle(w * 0.24, h * 0.12, 1.5, h * 0.5);
    cr.setSourceRGBA(1, 1, 1, 0.12);
    cr.fill();
}

// Figures in dot matrix. `reveal` (0..1) switches dots on in their scatter
// order; unlit dots show faintly.
export function drawDotText(cr, text, x, y, dot, gap, color, off, reveal = 1) {
    const {dots} = dotGlyphs(text);
    const [r, g, b] = rgba(color);
    const [or, og, ob] = rgba(off);
    const step = dot + gap;
    for (const [column, row] of dots) {
        const lit = dotOrder(column, row) < reveal;
        cr.arc(x + column * step + dot / 2, y + row * step + dot / 2, dot / 2, 0, 2 * Math.PI);
        if (lit) cr.setSourceRGBA(r, g, b, 1);
        else cr.setSourceRGBA(or, og, ob, 1);
        cr.fill();
    }
}

export const dotTextWidth = (text, dot, gap) => dotGlyphs(text).columns * (dot + gap) - gap;

// A row of round dots: `fraction` of them lit, lit dots switching on left
// to right as `reveal` goes 0..1. `scan` (0..1 or null) is a moving dot in
// `pulse` color, for a working session.
export function drawDotBar(cr, x, y, count, dot, gap, fraction, color, off, reveal = 1, scan = null, pulse = color) {
    const lit = typeof fraction === 'number' ? Math.round(Math.max(0, Math.min(1, fraction)) * count) : 0;
    const shown = Math.min(lit, Math.ceil(lit * reveal));
    const scanAt = scan === null ? -1 : Math.floor(scan * count) % count;
    for (let i = 0; i < count; i++) {
        const color_ = i === scanAt ? pulse : i < shown ? color : off;
        const [r, g, b] = rgba(color_);
        cr.arc(x + i * (dot + gap) + dot / 2, y + dot / 2, dot / 2, 0, 2 * Math.PI);
        cr.setSourceRGBA(r, g, b, 1);
        cr.fill();
    }
}

// The shelf sheet: square where it leaves the bar, rounded below, with a
// faint rim so it reads on a dark wallpaper.
export function drawSheet(cr, w, h, radius, fill, rim) {
    const [r, g, b, a] = rgba(fill);
    const rr = Math.min(radius, w / 2, h);
    cr.moveTo(0, 0);
    cr.lineTo(w, 0);
    cr.lineTo(w, h - rr);
    cr.arc(w - rr, h - rr, rr, 0, Math.PI / 2);
    cr.lineTo(rr, h);
    cr.arc(rr, h - rr, rr, Math.PI / 2, Math.PI);
    cr.closePath();
    cr.setSourceRGBA(r, g, b, a ?? 1);
    cr.fillPreserve();
    cr.setSourceRGBA(1, 1, 1, rim);
    cr.setLineWidth(1);
    cr.stroke();
}

// A rounded card with a faint rim, for the shelf's dropdown.
export function drawCard(cr, w, h, radius, fill, rim) {
    const [r, g, b] = rgba(fill);
    roundedPath(cr, 0.5, 0.5, w - 1, h - 1, radius);
    cr.setSourceRGBA(r, g, b, 1);
    cr.fillPreserve();
    cr.setSourceRGBA(1, 1, 1, rim);
    cr.setLineWidth(1);
    cr.stroke();
}

// The shelf strip: it leaves the bar with outward curves at the top
// corners, runs straight down and ends in rounded lower corners.
export function drawStrip(cr, w, h, flare, radius, fill, rim) {
    const [r, g, b] = rgba(fill);
    const f = Math.min(flare, w / 4, h / 2);
    const rr = Math.min(radius, (w - 2 * f) / 2, h - f);
    cr.moveTo(0, 0);
    cr.arc(0, f, f, -Math.PI / 2, 0);
    cr.lineTo(f, h - rr);
    cr.arcNegative(f + rr, h - rr, rr, Math.PI, Math.PI / 2);
    cr.lineTo(w - f - rr, h);
    cr.arcNegative(w - f - rr, h - rr, rr, Math.PI / 2, 0);
    cr.lineTo(w - f, f);
    cr.arc(w, f, f, Math.PI, 1.5 * Math.PI);
    cr.closePath();
    cr.setSourceRGBA(r, g, b, 1);
    cr.fillPreserve();
    cr.setSourceRGBA(1, 1, 1, rim);
    cr.setLineWidth(1);
    cr.stroke();
}

// A dial of `count` dots around (cx, cy), lit clockwise from the top for
// `fraction`; `reveal` switches them on in turn; `orbit` (0..1 or null) is
// a moving dot in `pulse`.
export function drawDial(cr, cx, cy, radius, count, dot, fraction, lit, off, reveal = 1, orbit = null, pulse = lit) {
    const on = typeof fraction === 'number' ? Math.round(Math.max(0, Math.min(1, fraction)) * count) : 0;
    const shown = Math.min(on, Math.ceil(on * reveal));
    const at = orbit === null ? -1 : Math.floor(orbit * count) % count;
    for (let i = 0; i < count; i++) {
        const angle = -Math.PI / 2 + i / count * 2 * Math.PI;
        const [r, g, b] = rgba(i === at ? pulse : i < shown ? lit : off);
        const size = i === at ? dot * 1.4 : dot;
        cr.arc(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), size / 2, 0, 2 * Math.PI);
        cr.setSourceRGBA(r, g, b, 1);
        cr.fill();
    }
}

// A 7 x 7 dot icon (rows of seven bits) with its top left at (x, y).
export function drawDotIcon(cr, rows, x, y, dot, gap, color) {
    const [r, g, b] = rgba(color);
    // Round dots, like the marks and the dials.
    rows.forEach((bits, row) => {
        for (let c = 0; c < 7; c++) {
            if (!(bits & (1 << (6 - c)))) continue;
            cr.newSubPath();
            cr.arc(x + c * (dot + gap) + dot / 2, y + row * (dot + gap) + dot / 2, dot / 2, 0, 2 * Math.PI);
        }
    });
    cr.setSourceRGBA(r, g, b, 1);
    cr.fill();
}

// The lens trace: a short line in `color`, moving when `amplitude` > 0.
export function drawTrace(cr, w, h, phase, amplitude, color) {
    const [r, g, b] = rgba(color);
    cr.setLineWidth(1.5);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.moveTo(1, h / 2);
    for (let x = 1; x <= w - 1; x++) {
        const k = x / w;
        cr.lineTo(x, h / 2 + amplitude * Math.sin(Math.PI * k) * Math.sin(x / 2.6 - phase) * Math.sin(phase / 7 + x / 9));
    }
    cr.setSourceRGBA(r, g, b, 1);
    cr.stroke();
}

export function drawBadge(cr, size, text, accent) {
    traceCut(cr, 0, 0, size, size, CHAMFER.small);
    source(cr, accent, CHIP.badgeAlpha);
    cr.fill();
    cr.selectFontFace('Sans', 0, 1); // normal slant, bold
    cr.setFontSize(TYPE.badge);
    const extents = cr.textExtents(text);
    source(cr, accent);
    cr.moveTo(Math.round((size - extents.width) / 2 - extents.xBearing), Math.round((size - extents.height) / 2 - extents.yBearing));
    cr.showText(text);
}
