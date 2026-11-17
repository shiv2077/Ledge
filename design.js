// Design tokens and pure geometry. Sizes are logical pixels, times are
// milliseconds. No GNOME imports, so Node tests can exercise everything here.

// Accents stay the same in every theme; a theme only adjusts their lightness
// when contrast would be too low.
export const PROVIDER_COLORS = {claude: '#E9956C', cursor: '#B59AFF', codex: '#63D9AE'};

export const MODULE_COLORS = {power: '#FFC857', todo: '#7AB8FF', models: '#9BE564', github: '#C9D1D9', training: '#FF8FB1'};

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

export const CHIP = {panelHeight: 24, railHeight: 36, railWidth: 96, badge: 14, badgeAlpha: 0.18, meterGap: 2};
export const TICK = {thickness: 4, length: 44, hotZone: 8, alpha: 0.85};
export const RAIL = {padding: SPACE.xs, endPadding: SPACE.md, chipGap: SPACE.xs};
export const DECK = {width: 340, padding: SPACE.lg, spacing: SPACE.md, rule: 2, bracket: 12, rowIcon: 16, actionIcon: 14};

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
