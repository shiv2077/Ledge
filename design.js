// Design tokens. px() converts design units to screen pixels with SCALE.

export const SCALE = 44 / 117;
export const px = pixels => pixels * SCALE;
const capRatio = 0.714;
export const fontSize = capPixels => px(capPixels) / capRatio;

export const PALETTE = {
    notch: '#000000',
    card: '#000000',
    ringTrack: '#303030',
    barTrack: '#2D2D2D',
    ample: '#00FF88',
    watch: '#F2FF00',
    critical: '#FF3F00',
    textPrimary: '#ffffff',
    textSecondary: '#808080',
};

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

export function usageBand(fraction) {
    if (fraction < 0.5) return 'ample';
    if (fraction < 0.7) return 'watch';
    if (fraction < 1.0) return 'critical';
    return 'exhausted';
}

export function bandColor(band) {
    return band === 'ample' ? PALETTE.ample : band === 'watch' ? PALETTE.watch : PALETTE.critical;
}

export function activityColor(state) {
    if (state === 'busy') return PALETTE.ample;
    if (state === 'waiting') return PALETTE.watch;
    return PALETTE.textSecondary;
}

export function hexToRgb(hex) {
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
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
