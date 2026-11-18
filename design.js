// Design tokens and pure geometry. Sizes are logical pixels, times are
// milliseconds. No GNOME imports, so Node tests can exercise everything here.

// Accents stay the same in every theme; a theme only adjusts their lightness
// when contrast would be too low.
export const PROVIDER_COLORS = {claude: '#E9956C', cursor: '#B59AFF', codex: '#63D9AE'};

export const MODULE_COLORS = {power: '#FFC857', todo: '#7AB8FF', models: '#9BE564', github: '#C9D1D9', copilot: '#5FD3F3', training: '#FF8FB1'};

// 4 px grid: the only spacing values in use.
export const SPACE = {xs: 4, sm: 8, md: 12, lg: 16, xl: 24};
export const CHAMFER = {small: 4, large: 10};
export const HAIRLINE = 1;

// Font sizes; stylesheet.css mirrors these.
export const TYPE = {readout: 12, title: 13, body: 12, caption: 11, section: 10, badge: 9};

export const METER = {
    chip: {segments: 10, width: 3, height: 3, gap: 1.5},
    deck: {segments: 20, height: 7, gap: 2},
    staleAlpha: 0.45,
};
export const chipMeterWidth = () => METER.chip.segments * METER.chip.width + (METER.chip.segments - 1) * METER.chip.gap;

export const LIGHT = {size: 6, breathMin: 0.45, breathPeriod: 1600, blinkOn: 120, blinkOff: 120, waitingBlinks: 3, doneBlinks: 2};

// Chip widths: padding, badge, readout column and light, with `gap`
// between them; compact drops the column; the summary chip holds a tick
// mark and one light. Rail chips use 8 px gaps, top bar chips 4 px.
export const chipWidth = (gap, compact = false) => 2 * gap + 14 + gap + (compact ? 0 : 44 + gap) + 6;
export const CHIP = {panelHeight: 24, railHeight: 36, railGap: SPACE.sm, panelGap: SPACE.xs,
    railWidth: chipWidth(SPACE.sm), panelWidth: chipWidth(SPACE.xs), compactWidth: chipWidth(SPACE.xs, true),
    summaryWidth: 2 * SPACE.xs + 4 + SPACE.xs + 6, badge: 14, badgeAlpha: 0.18, meterGap: 2};

// Which top bar strip fits `available` px: full chips, compact chips (badge
// and light only), or one summary chip. Separators are 1 px.
export function stripMode(count, available) {
    const width = chip => count * chip + Math.max(0, count - 1);
    if (width(CHIP.panelWidth) <= available) return 'full';
    if (width(CHIP.compactWidth) <= available) return 'compact';
    return 'summary';
}
export const TICK = {thickness: 4, length: 44, hotZone: 8, alpha: 0.85};
export const RAIL = {padding: SPACE.xs, endPadding: SPACE.md, chipGap: SPACE.xs};
export const DECK = {width: 340, padding: SPACE.lg, spacing: SPACE.md, rule: 2, bracket: 12, rowIcon: 16, actionIcon: 14};

// The shelf: a glass lens in the top bar that opens into one glass sheet.
// A 5 x 7 dot font for figures: each glyph is seven rows of five bits.
export const DOT_FONT = {
    '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31],
    '3': [30, 1, 1, 14, 1, 1, 30], '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14],
    '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8], '8': [14, 17, 17, 14, 17, 17, 14],
    '9': [14, 17, 17, 15, 1, 2, 12], '%': [24, 25, 2, 4, 8, 19, 3], '.': [0, 0, 0, 0, 0, 12, 12],
    '-': [0, 0, 0, 31, 0, 0, 0], '∞': [0, 0, 10, 21, 10, 0, 0], ' ': [0, 0, 0, 0, 0, 0, 0],
};
export const DOT_ROWS = 7;

// 7 x 7 dot icons for the shelf, drawn for Ledge: rows of seven bits.
export const DOT_ICONS = {
    claude: [8, 73, 42, 28, 42, 73, 8],          // a spark
    codex: [0, 64, 32, 16, 32, 71, 0],           // a prompt
    cursor: [64, 96, 112, 120, 124, 104, 4],     // a pointer
    copilot: [0, 62, 107, 107, 62, 34, 0],       // a visor
    models: [42, 127, 34, 99, 34, 127, 42],      // a chip
    power: [6, 12, 24, 62, 12, 24, 48],          // a bolt
    todo: [127, 65, 67, 101, 89, 65, 127],       // a ticked box
    github: [34, 34, 36, 56, 32, 32, 32],        // a branch
    training: [1, 3, 7, 15, 47, 127, 0],         // a rising curve
};
export const DOT_COLUMNS = 5;

// The dots of `text` as [column, row] pairs, with one blank column between
// glyphs. Unknown characters are blank. Returns {dots, columns}.
export function dotGlyphs(text) {
    const dots = [];
    let column = 0;
    for (const char of String(text).replace('—', '-')) {
        const rows = DOT_FONT[char] ?? DOT_FONT[' '];
        rows.forEach((bits, row) => {
            for (let c = 0; c < DOT_COLUMNS; c++) if (bits & (1 << (DOT_COLUMNS - 1 - c))) dots.push([column + c, row]);
        });
        column += DOT_COLUMNS + 1;
    }
    return {dots, columns: Math.max(0, column - 1)};
}

// Order in which a figure's dots switch on: a fixed scatter, so a reveal
// looks like a display settling rather than a wipe.
export const dotOrder = (column, row) => ((column * 7 + row * 13) % 17) / 17;

// Provider marks as dots placed along their strokes, in a unit circle
// (x, y in -1..1): the Claude spark as rays, the OpenAI knot as six
// interlocking arcs. Returns [[x, y], ...].
export function logoDots(id) {
    const points = [];
    // Dots this far apart (in radius units) read as a continuous stroke.
    const step = 0.16;
    if (id === 'claude') {
        // The spark: twelve rays of uneven length from a small open centre.
        const lengths = [1, 0.68, 0.9, 0.62, 1, 0.72, 0.86, 0.6, 1, 0.7, 0.94, 0.64];
        lengths.forEach((length, i) => {
            const angle = i * Math.PI / 6 - Math.PI / 2 + 0.12;
            for (let r = 0.22; r <= length + 1e-6; r += step) points.push([r * Math.cos(angle), r * Math.sin(angle)]);
        });
    } else if (id === 'codex') {
        // The knot: six arcs, each turned 60 degrees, interlocking round the centre.
        for (let k = 0; k < 6; k++) {
            const t = k * Math.PI / 3;
            const [cx, cy, radius] = [0.42 * Math.cos(t), 0.42 * Math.sin(t), 0.5];
            const count = Math.round(radius * Math.PI * 0.8 / step);
            for (let j = 0; j <= count; j++) {
                const a = t + Math.PI * (0.5 + 0.8 * j / count);
                points.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
            }
        }
    }
    return points;
}

export const SHELF = {
    lensWidth: 40, lensTrace: 14, lensRadius: 9, lensMargin: 4,
    dot: 4, dotGap: 2, barDots: 12, barDot: 4, barGap: 3, gaugeWidth: 96,
    flare: 14, figDot: 3, figGap: 1, iconDot: 2.4, iconGap: 1.2, dial: {size: 34, dots: 28, dot: 2}, logoDot: 1.5, logoRadius: 13, glyphSize: 22, glyphStep: 1.9, cardRadius: 8, cellGap: 4, divider: 3, reveal: 520, stagger: 70, low: 0.2, scan: 1400,
    radius: 14, padding: 16, gap: 14, sheetGap: 6, itemRadius: 12,
    tube: {width: 28, height: 78, wall: 1.5, wave: 2.2, waveLength: 7, speed: 2.6, still: 0.6},
    tubeColumn: 62, statWidth: 168, statHeight: 30, detailWidth: 520,
    rim: 0.06,
    open: 280, close: 160, intent: 120, grace: 420, fill: 0.006, lensFrame: 50,
};

// A rounded rectangle as whole-pixel rows, for the glass stencil clip.
export function roundedRects(width, height, radius) {
    const w = Math.round(width), h = Math.round(height);
    const r = Math.max(0, Math.min(radius, w / 2, h / 2));
    const spans = [];
    for (let y = 0; y < h; y++) {
        const dy = Math.max(0, r - Math.min(y + 0.5, h - y - 0.5));
        const inset = Math.round(r - Math.sqrt(Math.max(0, r * r - dy * dy)));
        const last = spans[spans.length - 1];
        if (last && last.inset === inset) last.end = y + 1;
        else spans.push({start: y, end: y + 1, inset});
    }
    return spans.map(({start, end, inset}) => [inset, start, w - 2 * inset, end - start]).filter(([, , rw]) => rw > 0);
}

// Liquid surface height at x: a travelling wave, flat when amplitude is 0.
export const waveAt = (x, phase, amplitude, length) => amplitude * Math.sin(x / length + phase);

export const MOTION = {
    hoverIntent: 80,
    foldGrace: 300,
    unfoldLength: 160,
    unfoldDepthStart: 100,
    unfoldDepth: 160,
    unfoldDepthDamping: 0.85,
    chipStart: 140,
    chipStagger: 18,
    chipEnter: 140,
    chipSlide: 6,
    meterPower: 120,
    meterChange: 120,
    foldChips: 90,
    foldDepthStart: 60,
    foldDepth: 120,
    foldLengthStart: 120,
    foldLength: 120,
    deckOpen: 160,
    deckSlide: 8,
    deckSwitch: 90,
    deckGlide: 180,
    deckClose: 120,
};

export const clampUnit = value => Math.max(0, Math.min(1, value));

// Rail extent for `count` chips: length runs along the screen edge.
export function railSize(count, vertical) {
    const along = vertical ? CHIP.railHeight : CHIP.railWidth;
    const across = vertical ? CHIP.railWidth : CHIP.railHeight;
    return {
        length: 2 * RAIL.endPadding + Math.max(0, count) * along + Math.max(0, count - 1) * RAIL.chipGap,
        depth: across + 2 * RAIL.padding,
    };
}

// Start of a deck along the rail: centred on the open chip and kept on the
// rail's straight side, between its two chamfers; a deck longer than that
// starts where the straight side starts.
export function deckSpan(railStart, railLength, chipCentre, deckLength, cut = CHAMFER.large) {
    const start = railStart + cut, length = railLength - 2 * cut;
    if (deckLength >= length) return start;
    return Math.max(start, Math.min(chipCentre - deckLength / 2, start + length - deckLength));
}

// ---- motion curves, all 0..1 over a 0..1 time ----

const STIFFNESS = 9;

// Critically damped approach: no overshoot.
export function approach(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return 1 - (1 + STIFFNESS * t) * Math.exp(-STIFFNESS * t);
}

// Under-damped approach with a light settle past the target.
export function settle(t, damping = MOTION.unfoldDepthDamping) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const decay = damping * STIFFNESS;
    const frequency = STIFFNESS * Math.sqrt(1 - damping * damping);
    return 1 - Math.exp(-decay * t) * (Math.cos(frequency * t) + decay / frequency * Math.sin(frequency * t));
}

export function unfoldDuration(count) {
    return Math.max(MOTION.unfoldDepthStart + MOTION.unfoldDepth,
        MOTION.chipStart + Math.max(0, count - 1) * MOTION.chipStagger + MOTION.chipEnter + MOTION.meterPower);
}

// Unfold at `ms`: the tick stretches, the rail grows out, chips enter in
// order and each meter powers on as its chip lands.
export function unfoldFrame(ms, count) {
    const chips = [];
    for (let i = 0; i < count; i++) {
        const start = MOTION.chipStart + i * MOTION.chipStagger;
        chips.push({
            enter: clampUnit((ms - start) / MOTION.chipEnter),
            power: clampUnit((ms - start - MOTION.chipEnter) / MOTION.meterPower),
        });
    }
    return {
        length: approach(ms / MOTION.unfoldLength),
        depth: settle((ms - MOTION.unfoldDepthStart) / MOTION.unfoldDepth),
        chips,
    };
}

export const foldDuration = () => MOTION.foldLengthStart + MOTION.foldLength;

// Fold at `ms`, as the share of each quantity already removed.
export function foldFrame(ms) {
    return {
        chips: clampUnit(ms / MOTION.foldChips),
        depth: approach((ms - MOTION.foldDepthStart) / MOTION.foldDepth),
        length: approach((ms - MOTION.foldLengthStart) / MOTION.foldLength),
    };
}

// ---- meters and lights ----

// Fill of each segment, 0..1. The last lit segment fills in proportion, so a
// reading is never rounded up. No reading lights nothing.
export function meterSegments(fraction, count) {
    const lit = typeof fraction === 'number' && Number.isFinite(fraction) ? clampUnit(fraction) * count : 0;
    return Array.from({length: count}, (_v, i) => clampUnit(lit - i));
}

// Segments lit after `power` (0..1) of the power-on, which lights whole
// segments one after another with no easing.
export function poweredSegments(fills, power) {
    const lit = fills.filter(fill => fill > 0).length;
    const allowed = Math.ceil(clampUnit(power) * lit);
    return fills.map((fill, i) => i < allowed ? fill : 0);
}

const URGENCY = ['off', 'working', 'waiting', 'failed'];
// The most urgent light state of several: failed, waiting, working, off.
export function urgency(states) {
    return URGENCY[Math.max(0, ...states.map(state => URGENCY.indexOf(state)))];
}

// ---- chamfered shapes ----

// A shape attached to `edge` of its own box: square corners on that side,
// both far corners cut at 45 degrees. Returns the outline, starting and
// ending on the attached side, so the closing segment is the attached side.
export function chamferPoints(edge, width, height, cut) {
    const vertical = edge === 'left' || edge === 'right';
    const depth = vertical ? width : height;
    const length = vertical ? height : width;
    const c = Math.max(0, Math.min(cut, depth / 2, length / 2));
    const outline = [[0, 0], [depth - c, 0], [depth, c], [depth, length - c], [depth - c, length], [0, length]];
    return outline.map(([d, l]) => {
        if (edge === 'right') return [width - d, l];
        if (edge === 'left') return [d, l];
        if (edge === 'top') return [l, d];
        return [l, height - d];
    });
}

// The same shape as whole-pixel rectangles, for the glass stencil clip. Rows
// with the same span merge into one rectangle.
export function chamferRects(edge, width, height, cut) {
    const vertical = edge === 'left' || edge === 'right';
    const depth = Math.round(vertical ? width : height);
    const length = Math.round(vertical ? height : width);
    const c = Math.max(0, Math.min(cut, depth / 2, length / 2));
    const spans = [];
    for (let along = 0; along < length; along++) {
        const fromEnd = Math.min(along + 0.5, length - along - 0.5);
        // Half-pixel rows round to even, so the stepped edge keeps the cut's area.
        const exact = Math.max(0, c - fromEnd);
        const inset = exact % 1 === 0.5 ? 2 * Math.round(exact / 2) : Math.round(exact);
        const last = spans[spans.length - 1];
        if (last && last.inset === inset) last.end = along + 1;
        else spans.push({start: along, end: along + 1, inset});
    }
    return spans.map(({start, end, inset}) => {
        const span = depth - inset;
        if (edge === 'right') return [inset, start, span, end - start];
        if (edge === 'left') return [0, start, span, end - start];
        if (edge === 'top') return [start, 0, end - start, span];
        return [start, inset, end - start, span];
    }).filter(([, , w, h]) => w > 0 && h > 0);
}
