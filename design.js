// Design tokens. px() converts design units to screen pixels with SCALE.

export const SCALE = 44 / 117;
export const px = pixels => pixels * SCALE;
const capRatio = 0.714;
export const fontSize = capPixels => px(capPixels) / capRatio;

// Accents stay the same in every theme; a theme only adjusts their lightness
// when contrast would be too low.
export const PROVIDER_COLORS = {claude: '#E9956C', cursor: '#B59AFF', codex: '#63D9AE'};

export const MODULE_COLORS = {power: '#FFC857', todo: '#7AB8FF', models: '#9BE564', github: '#C9D1D9', training: '#FF8FB1'};

export const LAYOUT = {
    sideBodyDepth: px(186),
    curlRadius: px(103),
    cornerRadius: px(78.8),
    bezelFillet: px(28),
    padTop: px(69.5),
    padBottom: px(50.1),
    cellSpacing: px(83.5),
    pillWidth: px(26),
    pillHeight: px(210),
    pillHotZone: px(90),
    ringDiameter: px(117),
    trackStroke: px(15.5),
    progressStroke: px(8),
    glyphSize: px(46),
    ringLabelGap: px(26.9),
    activityDiameter: px(72),
    activityStroke: px(5.5),
    settingsSize: px(124),
    settingsStroke: px(18),
    settingsGap: px(27),
    settingsGlyph: px(56),
    settingsHotZone: px(152),
    cardWidth: 300,
    cardCorner: px(49.5),
    cardPadding: 16,
    tailLength: 16,
    tailHeight: 24,
    tailGap: px(28),
    barHeight: px(10.5),
    headerGap: px(17),
    headerToBlock: px(21),
    labelToBar: px(16.8),
    barToUsed: px(17.8),
    blockSpacing: 12,
    sessionRowGap: px(10),
    hairline: px(2.5),
    statusDot: px(17),
    statusDotStroke: px(3.4),
    statusDotGap: px(11),
};

export function percentLineHeight() {
    return Math.ceil(fontSize(27) * 1.15);
}

export function cellExtent(vertical = true) {
    return vertical
        ? LAYOUT.ringDiameter + LAYOUT.ringLabelGap + percentLineHeight()
        : LAYOUT.ringDiameter + LAYOUT.ringLabelGap + 36;
}

export function bodyLength(cellCount, vertical = true) {
    const start = LAYOUT.padTop;
    const end = LAYOUT.padBottom;
    const along = cellExtent(vertical);
    if (cellCount <= 0) return start + end;
    return start + cellCount * along + (cellCount - 1) * LAYOUT.cellSpacing + end;
}

export function shapeLength(cellCount, vertical = true) {
    return bodyLength(cellCount, vertical) + 2 * LAYOUT.curlRadius;
}

// Damped spring with velocity carried across pointer reversals. Response and
// damping are tuned for the notch unfold; time is in seconds.
export function springSample(value, target, velocity, time, response = 0.42, damping = 0.78) {
    const omega = 2 * Math.PI / response;
    const decay = damping * omega;
    const frequency = omega * Math.sqrt(1 - damping * damping);
    const displacement = value - target;
    const sine = (velocity + decay * displacement) / frequency;
    const envelope = Math.exp(-decay * time);
    const wave = displacement * Math.cos(frequency * time) + sine * Math.sin(frequency * time);
    return {
        value: target + envelope * wave,
        velocity: envelope * (-decay * wave - displacement * frequency * Math.sin(frequency * time)
            + sine * frequency * Math.cos(frequency * time)),
    };
}

export const clampUnit = value => Math.max(0, Math.min(1, value));

export function notchGeometry(depth, length) {
    const wanted = Math.max(0, Math.min(LAYOUT.cornerRadius, depth / 2));
    const curl = Math.max(0, Math.min(LAYOUT.curlRadius, length / 2, depth - wanted));
    const corner = Math.max(0, Math.min(wanted, (length - 2 * curl) / 2));
    return {curl, corner};
}

// Pixel rectangles covering the notch shape drawn by traceNotchPath, in the
// actor's own coordinates. Rows with the same span merge into one rectangle.
// Used as a stencil clip so the glass blur follows the curls and corners.
export function notchRects(edge, width, height) {
    const vertical = edge === 'left' || edge === 'right';
    const depth = vertical ? width : height;
    const length = vertical ? height : width;
    const {curl, corner} = notchGeometry(depth, length);
    // Distance of the shape's inner boundary from the far (non-bezel) side.
    const inset = along => {
        const y = along + 0.5;
        const fromEnd = Math.min(y, length - y);
        // Concave flare: arc centred on the bezel line, one curl from the end.
        if (fromEnd < curl) return depth - curl + Math.sqrt(Math.max(0, curl * curl - fromEnd * fromEnd));
        // Convex rounded corner of the body.
        if (fromEnd < curl + corner) return corner - Math.sqrt(Math.max(0, corner * corner - (curl + corner - fromEnd) ** 2));
        return 0;
    };
    return mergeSpans(Math.round(length), inset, depth).map(({start, end, x0}) => {
        const span = Math.round(depth) - x0;
        if (edge === 'right') return [x0, start, span, end - start];
        if (edge === 'left') return [0, start, span, end - start];
        if (edge === 'top') return [start, 0, end - start, span];
        return [start, x0, end - start, span];
    }).filter(([, , w, h]) => w > 0 && h > 0);
}

// Rounded rectangle as pixel rectangles, for glass cards.
export function roundedRectRects(width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    const inset = along => {
        const y = along + 0.5;
        const fromEnd = Math.min(y, height - y);
        return fromEnd < r ? r - Math.sqrt(Math.max(0, r * r - (r - fromEnd) ** 2)) : 0;
    };
    return mergeSpans(Math.round(height), inset, width).map(({start, end, x0}) =>
        [x0, start, Math.round(width) - 2 * x0, end - start]).filter(([, , w, h]) => w > 0 && h > 0);
}

function mergeSpans(rows, inset, depth) {
    const spans = [];
    for (let along = 0; along < rows; along++) {
        const x0 = Math.min(Math.round(depth), Math.max(0, Math.round(inset(along))));
        const last = spans[spans.length - 1];
        if (last && last.x0 === x0 && last.end === along) last.end = along + 1;
        else spans.push({start: along, end: along + 1, x0});
    }
    return spans;
}
