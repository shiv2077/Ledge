import {LAYOUT, notchGeometry, clampUnit} from './design.js';
import {rgba} from './themes.js';
import {GLYPH_OUTLINES, GLYPH_SCALE, GLYPHS} from './glyphs.js';

export function traceNotchPath(cr, w, h, edge) {
    const depth = edge === 'left' || edge === 'right' ? w : h;
    const length = edge === 'left' || edge === 'right' ? h : w;
    const {curl, corner} = notchGeometry(depth, length);
    const bodyTop = curl;
    const bodyBottom = length - curl;
    const bezel = depth;

    cr.newSubPath();
    cr.moveTo(bezel, 0);
    if (curl > 0)
        cr.arc(bezel - curl, 0, curl, 0, Math.PI / 2);
    cr.lineTo(corner, bodyTop);
    cr.arcNegative(corner, bodyTop + corner, corner, -Math.PI / 2, -Math.PI);
    cr.lineTo(0, bodyBottom - corner);
    cr.arcNegative(corner, bodyBottom - corner, corner, Math.PI, Math.PI / 2);
    cr.lineTo(bezel - curl, bodyBottom);
    if (curl > 0)
        cr.arc(bezel - curl, bodyBottom + curl, curl, -Math.PI / 2, 0);
    cr.lineTo(bezel, length);
    cr.closePath();
}

// Source color with its own alpha scaled by `alpha`.
function source(cr, color, alpha = 1) {
    const [r, g, b, a] = rgba(color);
    cr.setSourceRGBA(r, g, b, a * alpha);
}

// Applies the edge's orientation so pathFn can always trace a right-edge
// shape; returns that shape's depth and length.
function orient(cr, w, h, edge) {
    if (edge === 'left') {
        cr.translate(w, 0);
        cr.scale(-1, 1);
        return [w, h];
    }
    if (edge === 'top') {
        cr.translate(0, h);
        cr.rotate(-Math.PI / 2);
        return [h, w];
    }
    if (edge === 'bottom') {
        cr.translate(w, 0);
        cr.rotate(Math.PI / 2);
        return [h, w];
    }
    return [w, h];
}

// Fills the notch shape. With `border`, also draws a 1px line just inside the
// outline, except along the screen edge: the bright rim of the glass style.
export function drawFilledPath(cr, pathFn, w, h, edge, fill, border = null) {
    cr.save();
    const [depth, length] = orient(cr, w, h, edge);
    pathFn(cr, depth, length, 'right');
    source(cr, fill);
    if (!border) {
        cr.fill();
        cr.restore();
        return;
    }
    cr.fillPreserve();
    cr.clip();
    // Keep the rim off the bezel line, where the notch meets the screen edge.
    cr.rectangle(-1, -1, depth, length + 2);
    cr.clip();
    pathFn(cr, depth, length, 'right');
    cr.setLineWidth(2);
    source(cr, border);
    cr.stroke();
    cr.restore();
}

export function drawGlyph(cr, providerId, cx, cy, size, color = '#ffffff') {
    const key = GLYPHS[providerId];
    const loops = GLYPH_OUTLINES[key];
    if (!loops?.length) return;
    const scale = (GLYPH_SCALE[key] ?? 1) * size;
    const ox = cx - scale / 2;
    const oy = cy - scale / 2;
    cr.save();
    cr.translate(ox, oy);
    cr.scale(scale, scale);
    source(cr, color);
    for (const loop of loops) {
        if (!loop.length) continue;
        cr.newSubPath();
        cr.moveTo(loop[0][0], loop[0][1]);
        for (let i = 1; i < loop.length; i++)
            cr.lineTo(loop[i][0], loop[i][1]);
        cr.closePath();
    }
    cr.fill();
    cr.restore();
}

// fraction is the filled share of the ring, 0..1, or null for no reading.
// cell.accent is already resolved to a color for the theme.
export function drawRing(cr, w, h, fraction, cell, phase, theme) {
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) / 2 - LAYOUT.trackStroke / 2;
    cr.setLineWidth(LAYOUT.trackStroke);
    cr.setLineCap(1); // round
    source(cr, theme.ringTrack);
    cr.arc(cx, cy, radius, 0, Math.PI * 2);
    cr.stroke();

    if (typeof fraction === 'number' && fraction > 0) {
        cr.setLineWidth(LAYOUT.progressStroke);
        source(cr, cell.accent ?? theme.textPrimary, cell.stale ? 0.45 : 1);
        cr.arc(cx, cy, radius - (LAYOUT.trackStroke - LAYOUT.progressStroke) / 2,
            -Math.PI / 2, -Math.PI / 2 + Math.min(fraction, 1) * Math.PI * 2);
        cr.stroke();
    }

    const waiting = cell.sessions?.some(s => s.state === 'waiting');
    const busy = cell.sessions?.some(s => s.state === 'busy');
    if (waiting || busy) {
        const inset = (LAYOUT.ringDiameter - LAYOUT.activityDiameter) / 2;
        const ir = radius - inset;
        cr.setLineWidth(LAYOUT.activityStroke);
        if (waiting) {
            const pulse = 0.55 + Math.sin(phase * 2) * 0.35;
            source(cr, theme.watch, pulse);
            cr.arc(cx, cy, ir, 0, Math.PI * 2);
            cr.stroke();
        } else {
            const start = phase % (Math.PI * 2);
            source(cr, theme.ample, 0.95);
            cr.arc(cx, cy, ir, start, start + Math.PI * 0.5);
            cr.stroke();
        }
    }

    if (cell.glyph) drawGlyph(cr, cell.glyph, cx, cy, LAYOUT.glyphSize, theme.textPrimary);
}

export function drawProgressBar(cr, x, y, width, fraction, stale, color, track) {
    const h = LAYOUT.barHeight;
    source(cr, track);
    cr.newSubPath();
    cr.arc(x + h / 2, y + h / 2, h / 2, Math.PI / 2, Math.PI * 1.5);
    cr.arc(x + width - h / 2, y + h / 2, h / 2, -Math.PI / 2, Math.PI / 2);
    cr.closePath();
    cr.fill();
    if (typeof fraction === 'number' && fraction > 0) {
        const fillW = Math.max(h, width * Math.min(fraction, 1));
        source(cr, color, stale ? 0.45 : 1);
        cr.newSubPath();
        cr.arc(x + h / 2, y + h / 2, h / 2, Math.PI / 2, Math.PI * 1.5);
        cr.arc(x + fillW - h / 2, y + h / 2, h / 2, -Math.PI / 2, Math.PI / 2);
        cr.closePath();
        cr.fill();
    }
}

export function drawTooltipTail(cr, w, h, direction, color) {
    source(cr, color);
    cr.newSubPath();
    if (direction === 'leading') {
        cr.moveTo(0, 0);
        cr.lineTo(w, h / 2);
        cr.lineTo(0, h);
    } else if (direction === 'trailing') {
        cr.moveTo(w, 0);
        cr.lineTo(0, h / 2);
        cr.lineTo(w, h);
    } else if (direction === 'down') {
        cr.moveTo(0, 0);
        cr.lineTo(w / 2, h);
        cr.lineTo(w, 0);
    } else {
        cr.moveTo(0, h);
        cr.lineTo(w / 2, 0);
        cr.lineTo(w, h);
    }
    cr.closePath();
    cr.fill();
}


// Arc and disc share the lower flare's centre. The canvas is deliberately
// larger than the hit target so the closing arc can grow into the notch.
export function drawSettings(cr, size, edge, hover, reveal, color) {
    const h = clampUnit(hover);
    const visible = clampUnit(reveal);
    const radius = LAYOUT.curlRadius - LAYOUT.settingsGap;
    const merge = 1 + (1 - reveal) * ((LAYOUT.curlRadius + LAYOUT.settingsStroke) / radius - 1);
    const start = {right: -Math.PI / 2, left: Math.PI, top: Math.PI, bottom: Math.PI / 2}[edge];
    cr.save();
    cr.translate(size / 2, size / 2);
    cr.scale(merge, merge);
    source(cr, color, (1 - h) * visible);
    cr.setLineWidth(LAYOUT.settingsStroke);
    cr.setLineCap(1);
    cr.arc(0, 0, radius * (1 - 0.14 * h), start, start + Math.PI / 2);
    cr.stroke();
    source(cr, color, h * visible);
    cr.arc(0, 0, LAYOUT.settingsSize / 2 * (1.1 - 0.1 * hover), 0, Math.PI * 2);
    cr.fill();
    cr.restore();
}

// Eight outlined teeth and a circular hub.
export function drawSettingsGlyph(cr, size, color = '#ffffff') {
    const radius = size / 2 - 1;
    const root = radius * 0.76;
    cr.save();
    cr.translate(size / 2, size / 2);
    source(cr, color);
    cr.setLineWidth(1.5);
    cr.setLineJoin(1);
    cr.newSubPath();
    for (let tooth = 0; tooth < 8; tooth++) {
        for (const [phase, r] of [[-0.5, root], [-0.3, root], [-0.16, radius], [0.16, radius], [0.3, root]]) {
            const angle = (tooth + phase) * Math.PI / 4;
            const x = Math.cos(angle) * r, y = Math.sin(angle) * r;
            if (tooth === 0 && phase === -0.5) cr.moveTo(x, y);
            else cr.lineTo(x, y);
        }
    }
    cr.closePath();
    cr.stroke();
    cr.arc(0, 0, size * 0.16, 0, Math.PI * 2);
    cr.stroke();
    cr.restore();
}
