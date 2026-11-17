// Cairo drawing for the Deck look: chamfered panels, segmented meters and
// monogram badges. Colors arrive resolved from the theme.
import {CHAMFER, METER, TYPE, CHIP, chamferPoints} from './design.js';
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

export function drawChipBackground(cr, width, height, fill, outline) {
    cr.setOperator(0);
    cr.paint();
    cr.setOperator(2);
    if (fill) {
        traceCut(cr, 0, 0, width, height, CHAMFER.small);
        source(cr, fill);
        cr.fill();
    }
    if (outline) {
        traceCut(cr, 0.5, 0.5, width - 1, height - 1, CHAMFER.small);
        cr.setLineWidth(1);
        source(cr, outline);
        cr.stroke();
    }
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
