// Theme tokens, built-in themes and runtime resolution. Pure: no GNOME
// imports, so Node tests can check every theme's contrast.
//
// Colors are '#rrggbb' or '#rrggbbaa' strings.

export const THEME_IDS = ['midnight', 'graphite', 'nord', 'mocha', 'dracula', 'ocean', 'snow',
    'frosted-dark', 'frosted-light', 'system', 'custom'];

export const THEME_NAMES = {
    'midnight': 'Midnight', 'graphite': 'Graphite', 'nord': 'Nord', 'mocha': 'Catppuccin Mocha',
    'dracula': 'Dracula', 'ocean': 'Ocean', 'snow': 'Snow', 'frosted-dark': 'Frosted Dark',
    'frosted-light': 'Frosted Light', 'system': 'System', 'custom': 'Custom',
};

// Status colors that read on dark and on light backgrounds.
const DARK_STATUS = {ample: '#3DDC97', watch: '#FFB020', critical: '#FF5A4D', warning: '#FF6B6B'};
const LIGHT_STATUS = {ample: '#0f8a3c', watch: '#A86400', critical: '#c62a1b', warning: '#B3261E'};

// Tokens: rail and deck backgrounds, control (buttons, entries, hovered
// chips), text primary and secondary, border (hairlines), highlight (focus
// outlines, active rows), shadow, meterOff (unlit meter segments), led (an unlit
// status light) and the status colors. Hover, focus, dim and selection shades
// are derived.
export const BUILT_IN = {
    'midnight': {rail: '#0B0E12', deck: '#0A0D12', control: '#161B22', textPrimary: '#E8ECF2', textSecondary: '#7E8794',
        border: '#232A33', highlight: '#9AA4B2', shadow: '#00000066', meterOff: '#232A33', led: '#495566', ...DARK_STATUS},
    'graphite': {rail: '#1B1D21', deck: '#1F2226', control: '#2B2F35', textPrimary: '#ECEEF2', textSecondary: '#A3A9B3',
        border: '#383D45', highlight: '#9AA4B2', shadow: '#00000059', meterOff: '#3b4149', led: '#59626d', ...DARK_STATUS},
    'nord': {rail: '#2e3440', deck: '#3b4252', control: '#434c5e', textPrimary: '#eceff4', textSecondary: '#b8c1d1',
        border: '#4c566a', highlight: '#88c0d0', shadow: '#00000059', meterOff: '#535e74', led: '#75819a',
        ample: '#a3be8c', watch: '#ebcb8b', critical: '#d9747e', warning: '#daa08e'},
    'mocha': {rail: '#11111b', deck: '#1e1e2e', control: '#313244', textPrimary: '#cdd6f4', textSecondary: '#a6adc8',
        border: '#45475a', highlight: '#b4befe', shadow: '#00000066', meterOff: '#45475a', led: '#5b5e73',
        ample: '#a6e3a1', watch: '#f9e2af', critical: '#f38ba8', warning: '#fab387'},
    'dracula': {rail: '#21222c', deck: '#282a36', control: '#44475a', textPrimary: '#f8f8f2', textSecondary: '#bfc2d6',
        border: '#44475a', highlight: '#bd93f9', shadow: '#00000066', meterOff: '#44475a', led: '#616681',
        ample: '#50fa7b', watch: '#f1fa8c', critical: '#ff5555', warning: '#ffb86c'},
    'ocean': {rail: '#0b1628', deck: '#0f1e36', control: '#1a2c4a', textPrimary: '#e6eef9', textSecondary: '#a3b6d1',
        border: '#22385c', highlight: '#5aa9ff', shadow: '#00000066', meterOff: '#253d64', led: '#3f5c9b',
        ample: '#3ddc97', watch: '#ffd166', critical: '#ff5c5c', warning: '#ff9f6b'},
    'snow': {rail: '#f5f5f7', deck: '#ffffff', control: '#ececf0', textPrimary: '#1d1d1f', textSecondary: '#55555c',
        border: '#d8d8de', highlight: '#0a64d8', shadow: '#0000002e', meterOff: '#c8c8d2', led: '#9999a7', ...LIGHT_STATUS},
    // Glass themes: rail and deck are the tint, drawn over the blur at the
    // user's tint opacity; controls and unlit marks are translucent overlays.
    'frosted-dark': {rail: '#14181d', deck: '#14181d', control: '#ffffff1f', textPrimary: '#ffffff', textSecondary: '#d4d8de',
        border: '#ffffff3d', highlight: '#e0e4ea', shadow: '#00000059', meterOff: '#ffffff33', led: '#ffffff5f', ...DARK_STATUS},
    'frosted-light': {rail: '#f2f2f5', deck: '#f2f2f5', control: '#00000014', textPrimary: '#111114', textSecondary: '#333338',
        border: '#ffffffb3', highlight: '#0a64d8', shadow: '#00000038', meterOff: '#00000031', led: '#00000069', ...LIGHT_STATUS},
};

export const GLASS_THEMES = ['frosted-dark', 'frosted-light'];

// Ubuntu 24.04 Yaru accents, keyed by the gtk-theme variant name.
export const YARU_ACCENTS = {
    '': '#E95420', 'bark': '#787859', 'sage': '#657B69', 'olive': '#4B8501', 'viridian': '#03875B',
    'prussiangreen': '#308280', 'blue': '#0073E5', 'purple': '#7764D8', 'magenta': '#B34CB3', 'red': '#DA3450',
};

// GNOME 47+ org.gnome.desktop.interface accent-color values.
export const GNOME_ACCENTS = {
    blue: '#3584e4', teal: '#2190a4', green: '#3a944a', yellow: '#c88800', orange: '#ed5b00',
    red: '#e62d42', pink: '#d56199', purple: '#9141ac', slate: '#6f8396',
};

// Contrast targets (WCAG): body text 4.5:1, meters and other marks 3:1.
export const TEXT_CONTRAST = 4.5;
export const MARK_CONTRAST = 3;
// Unlit marks stay visible but quieter than any reading: unlit meter
// segments and the off status light.
export const OFF_CONTRAST = {meterOff: 1.3, led: 2.5};

// Glass: the tint sits over a blurred backdrop that can be anything, so text
// is checked against the tint over black and over white at this brightness.
export const GLASS_DEFAULTS = {blur: 30, tint: 0.7, brightness: 0.85};
export const GLASS_TINT_MIN = 0.55;

// ---- color math ----

export function rgba(color) {
    const hex = String(color).replace('#', '');
    const n = i => parseInt(hex.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), hex.length >= 8 ? n(6) : 1];
}

const to2 = v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
export function toHex([r, g, b, a = 1]) {
    return `#${to2(r)}${to2(g)}${to2(b)}${a < 1 ? to2(a) : ''}`;
}

export function withAlpha(color, alpha) {
    const [r, g, b] = rgba(color);
    return toHex([r, g, b, alpha]);
}

// Linear blend of two colors, alpha included; t = 0 gives a.
export function mix(a, b, t) {
    const x = rgba(a), y = rgba(b);
    return toHex(x.map((v, i) => v + (y[i] - v) * t));
}

// Paints `top` (possibly translucent) over opaque `bottom`.
export function over(top, bottom) {
    const [r, g, b, a] = rgba(top);
    const [R, G, B] = rgba(bottom);
    return toHex([r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)]);
}

export function luminance(color) {
    const lin = v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    const [r, g, b] = rgba(color);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a, b) {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

function toHsl(color) {
    const [r, g, b] = rgba(color);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
}

function fromHsl(h, s, l) {
    if (s === 0) return toHex([l, l, l]);
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const hue = t => {
        t = (t + 1) % 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return toHex([hue(h + 1 / 3), hue(h), hue(h - 1 / 3)]);
}

// Moves only the lightness of `color` away from `background` until the
// contrast reaches `target`. Hue and saturation stay, so accents keep their
// identity; alpha is kept too.
export function ensureContrast(color, background, target) {
    if (contrast(color, background) >= target) return color;
    const [h, s, l] = toHsl(color);
    const alpha = rgba(color)[3];
    const darker = luminance(background) > 0.18;
    for (let step = 1; step <= 100; step++) {
        const candidate = fromHsl(h, s, darker ? l * (1 - step / 100) : l + (1 - l) * step / 100);
        if (contrast(candidate, background) >= target)
            return alpha < 1 ? withAlpha(candidate, alpha) : candidate;
    }
    return darker ? '#000000' : '#ffffff';
}

// ---- resolution ----

// Worst-case opaque backgrounds for glass text: the tint over a blurred
// black backdrop and over a blurred white one dimmed by `brightness`.
export function glassBackdrops(tint, opacity, brightness) {
    const white = toHex([brightness, brightness, brightness]);
    return [over(withAlpha(tint, opacity), '#000000'), over(withAlpha(tint, opacity), white)];
}

// Parses the Yaru gtk-theme name, e.g. 'Yaru-blue-dark' -> blue, dark.
export function parseYaru(gtkTheme) {
    const match = /^Yaru(?:-([a-z]+))?(?:-(dark|light))?$/.exec(String(gtkTheme));
    if (!match) return {accent: null, dark: /dark/i.test(String(gtkTheme))};
    const variant = match[1] && match[1] !== 'dark' && match[1] !== 'light' ? match[1] : '';
    return {accent: YARU_ACCENTS[variant] ?? YARU_ACCENTS[''], dark: match[2] === 'dark' || match[1] === 'dark'};
}

// desktop: {colorScheme, gtkTheme, accentColor (GNOME 47+ or null)}
export function systemPalette(desktop) {
    const yaru = parseYaru(desktop.gtkTheme);
    const dark = desktop.colorScheme === 'prefer-dark' || (desktop.colorScheme !== 'prefer-light' && yaru.dark);
    const accent = GNOME_ACCENTS[desktop.accentColor] ?? yaru.accent ?? '#3584e4';
    const base = BUILT_IN[dark ? 'graphite' : 'snow'];
    return {...base, highlight: accent};
}

// A color meeting `target` against every background: the color itself, a
// lightness-adjusted version, or failing those whichever of black or white
// reads best.
export function fitAll(color, backgrounds, target) {
    const least = c => Math.min(...backgrounds.map(bg => contrast(c, bg)));
    if (least(color) >= target) return color;
    for (const bg of backgrounds) {
        const candidate = ensureContrast(color, bg, target);
        if (least(candidate) >= target) return candidate;
    }
    return least('#ffffff') >= least('#000000') ? '#ffffff' : '#000000';
}

const desktops = color => rgba(color)[3] < 1 ? [over(color, '#000000'), over(color, '#ffffff')] : [over(color, '#000000')];

// custom: {background, card, text, highlight, opacity}. A translucent deck
// shows the desktop through it, so the opacity is raised until some text
// color reads over both a black and a white desktop.
export function customPalette(custom) {
    const deck = custom.card, rail = custom.background;
    const readable = op => [deck, rail].every(c => {
        const bgs = desktops(withAlpha(c, op));
        return Math.max(...['#ffffff', '#000000'].map(t => Math.min(...bgs.map(bg => contrast(t, bg))))) >= TEXT_CONTRAST;
    });
    let opacity = Math.max(0.3, Math.min(1, custom.opacity));
    while (opacity < 1 && !readable(opacity)) opacity = Math.min(1, opacity + 0.05);
    const text = fitAll(custom.text, desktops(withAlpha(deck, opacity)), TEXT_CONTRAST);
    const light = luminance(deck) > 0.4;
    return {
        rail: withAlpha(rail, opacity), deck: withAlpha(deck, opacity),
        control: mix(deck, text, 0.1), textPrimary: text,
        textSecondary: ensureContrast(mix(text, deck, 0.35), deck, TEXT_CONTRAST),
        border: mix(deck, text, 0.18), highlight: custom.highlight,
        shadow: light ? '#0000002e' : '#00000066',
        meterOff: ensureContrast(mix(deck, text, 0.16), deck, OFF_CONTRAST.meterOff), led: ensureContrast(mix(deck, text, 0.26), deck, OFF_CONTRAST.led),
        ...(light ? LIGHT_STATUS : DARK_STATUS),
    };
}

// params: {theme, custom, glass: {blur, tint, brightness}, desktop}
// Returns the tokens plus derived shades and flags the host needs.
export function resolveTheme(params) {
    const id = THEME_IDS.includes(params.theme) ? params.theme : 'midnight';
    const glass = GLASS_THEMES.includes(id);
    let t;
    if (id === 'system') t = systemPalette(params.desktop ?? {});
    else if (id === 'custom') t = customPalette(params.custom);
    else t = {...BUILT_IN[id]};

    // Backgrounds text and marks are judged against.
    let deckBg = desktops(t.deck), railBg = desktops(t.rail);
    if (glass) {
        const tint = Math.max(GLASS_TINT_MIN, params.glass.tint);
        t.rail = withAlpha(t.rail, tint);
        t.deck = withAlpha(t.deck, tint);
        deckBg = railBg = glassBackdrops(BUILT_IN[id].deck, tint, params.glass.brightness);
    }
    t.textPrimary = fitAll(t.textPrimary, [...deckBg, ...railBg], TEXT_CONTRAST);
    t.textSecondary = fitAll(t.textSecondary, [...deckBg, ...railBg], TEXT_CONTRAST);
    t.warning = fitAll(t.warning, deckBg, TEXT_CONTRAST);

    // Light when dark text is what reads.
    const light = luminance(t.textPrimary) < 0.2;
    return {
        ...t, id, glass, light,
        glassParams: glass ? {radius: params.glass.blur, brightness: params.glass.brightness} : null,
        controlHover: mix(t.control, t.textPrimary, 0.073),
        controlFocus: mix(t.control, t.textPrimary, 0.128),
        selection: mix(t.control, t.textPrimary, 0.2),
        textDim: mix(t.textSecondary, over(t.deck, light ? '#ffffff' : '#000000'), 0.3),
        // Accents keep their hue; only lightness moves when contrast is low.
        accent: (color, where = 'rail') => fitAll(t[color] ?? color, where === 'deck' ? deckBg : railBg, MARK_CONTRAST),
        // The same accent at text contrast, for letters such as badge monograms.
        accentText: (color, where = 'rail') => fitAll(t[color] ?? color, where === 'deck' ? deckBg : railBg, TEXT_CONTRAST),
    };
}

// Colors for chips drawn on the rail.
export function railPalette(t) {
    return {
        accent: color => t.accent(color, 'rail'), accentText: color => t.accentText(color, 'rail'),
        meterOff: t.meterOff, led: t.led, hover: t.controlHover, focus: t.highlight, border: t.border, mark: t.textSecondary,
    };
}

// Colors for chips drawn on the shell's top bar, whose background and text
// color belong to the shell theme. Accents keep their hue and are fitted to
// that background; unlit marks are mixed from it with the same floors.
export function panelPalette(t, background, foreground) {
    const bg = rgba(background)[3] < 0.5 ? '#000000' : over(background, '#000000');
    const fit = (color, target) => fitAll(t[color] ?? color, [bg], target);
    return {
        accent: color => fit(color, MARK_CONTRAST), accentText: color => fit(color, TEXT_CONTRAST),
        meterOff: ensureContrast(mix(bg, foreground, 0.18), bg, OFF_CONTRAST.meterOff),
        led: ensureContrast(mix(bg, foreground, 0.3), bg, OFF_CONTRAST.led),
        hover: mix(bg, foreground, 0.12), focus: fit(t.highlight, MARK_CONTRAST),
        border: mix(bg, foreground, 0.2), mark: ensureContrast(mix(bg, foreground, 0.6), bg, MARK_CONTRAST),
    };
}

// Swatch colors for the prefs picker: rail, deck, highlight, text.
export function swatch(tokens) {
    return [tokens.rail, tokens.deck, tokens.highlight, tokens.textPrimary];
}

// ---- stylesheet ----

export const cssColor = color => {
    const [r, g, b, a] = rgba(color);
    return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${+a.toFixed(3)})`;
};

// Every color rule in the UI. stylesheet.css keeps sizes, spacing and the
// Midnight colors as a fallback. St lets an extension's own sheet win ties,
// so each class is doubled here (.a.a) to outrank it by specificity.
export function themeCss(t) {
    return themeRules(t).replace(/^[^{\n]+/gm, selector => selector.replace(/\.([a-z][a-z-]*)/g, '.$1.$1'));
}

function themeRules(t) {
    const focusRing = `box-shadow: inset 0 0 0 1px ${cssColor(t.highlight)};`;
    return `
.ledge-readout, .ledge-deck-title, .ledge-body, .ledge-row-title, .ledge-chip-icon { color: ${cssColor(t.textPrimary)}; }
.ledge-deck { color: ${cssColor(t.textPrimary)}; box-shadow: 0 8px 24px 0 ${cssColor(t.shadow)}; }
.ledge-caption, .ledge-section, .ledge-stamp, .ledge-figure { color: ${cssColor(t.textSecondary)}; }
.ledge-warning { color: ${cssColor(t.warning)}; }
.ledge-watch { color: ${cssColor(t.accent('watch', 'deck'))}; }
.ledge-hairline { background-color: ${cssColor(t.border)}; }
.ledge-action { color: ${cssColor(t.textSecondary)}; }
.ledge-action:hover, .ledge-action:focus { color: ${cssColor(t.textPrimary)}; }
.ledge-switch:hover, .ledge-switch-active { background-color: ${cssColor(t.controlHover)}; }
.ledge-switch:focus { ${focusRing} }
.ledge-small-action { background-color: ${cssColor(t.control)}; color: ${cssColor(t.textPrimary)}; }
.ledge-small-action:hover { background-color: ${cssColor(t.controlHover)}; }
.ledge-small-action:focus { background-color: ${cssColor(t.controlFocus)}; ${focusRing} }
.ledge-row { color: ${cssColor(t.textPrimary)}; }
.ledge-row:hover, .ledge-row-active { background-color: ${cssColor(t.control)}; }
.ledge-row:focus { background-color: ${cssColor(t.controlHover)}; ${focusRing} }
.ledge-dim { color: ${cssColor(t.textDim)}; }
.ledge-entry { background-color: ${cssColor(t.control)}; color: ${cssColor(t.textPrimary)}; caret-color: ${cssColor(t.textPrimary)}; selection-background-color: ${cssColor(t.selection)}; selected-color: ${cssColor(t.textPrimary)}; }
.ledge-entry .hint-text { color: ${cssColor(t.textSecondary)}; }
.ledge-entry:focus { ${focusRing} }
.ledge-icon-button { color: ${cssColor(t.textSecondary)}; }
.ledge-icon-button:hover { background-color: ${cssColor(t.controlHover)}; color: ${cssColor(t.textPrimary)}; }
.ledge-icon-button:focus { background-color: ${cssColor(t.controlFocus)}; color: ${cssColor(t.textPrimary)}; }
`;
}
