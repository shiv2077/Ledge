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
const DARK_STATUS = {ample: '#00FF88', watch: '#F2FF00', critical: '#FF3F00', warning: '#ff855c'};
const LIGHT_STATUS = {ample: '#0f8a3c', watch: '#8a6d00', critical: '#c62a1b', warning: '#b3400a'};

// Tokens: notch and card backgrounds, control (buttons, entries, focused
// cells), text primary and secondary, border (hairlines, glass edge),
// highlight (focus rings, active rows), shadow, ring and bar tracks, and the
// status colors. Hover, focus, dim and selection shades are derived.
export const BUILT_IN = {
    'midnight': {notch: '#000000', card: '#000000', control: '#242424', textPrimary: '#ffffff', textSecondary: '#a0a0a0',
        border: '#303030', highlight: '#a0a0a0', shadow: '#00000052', ringTrack: '#303030', barTrack: '#2D2D2D', ...DARK_STATUS},
    'graphite': {notch: '#1c1c1e', card: '#232326', control: '#303034', textPrimary: '#f2f2f7', textSecondary: '#a9a9b0',
        border: '#3a3a3e', highlight: '#9a9aa2', shadow: '#00000059', ringTrack: '#3a3a3e', barTrack: '#36363a', ...DARK_STATUS},
    'nord': {notch: '#2e3440', card: '#3b4252', control: '#434c5e', textPrimary: '#eceff4', textSecondary: '#b8c1d1',
        border: '#4c566a', highlight: '#88c0d0', shadow: '#00000059', ringTrack: '#4c566a', barTrack: '#434c5e',
        ample: '#a3be8c', watch: '#ebcb8b', critical: '#bf616a', warning: '#daa08e'},
    'mocha': {notch: '#11111b', card: '#1e1e2e', control: '#313244', textPrimary: '#cdd6f4', textSecondary: '#a6adc8',
        border: '#45475a', highlight: '#b4befe', shadow: '#00000066', ringTrack: '#45475a', barTrack: '#313244',
        ample: '#a6e3a1', watch: '#f9e2af', critical: '#f38ba8', warning: '#fab387'},
    'dracula': {notch: '#21222c', card: '#282a36', control: '#44475a', textPrimary: '#f8f8f2', textSecondary: '#bfc2d6',
        border: '#44475a', highlight: '#bd93f9', shadow: '#00000066', ringTrack: '#44475a', barTrack: '#3a3c4e',
        ample: '#50fa7b', watch: '#f1fa8c', critical: '#ff5555', warning: '#ffb86c'},
    'ocean': {notch: '#0b1628', card: '#0f1e36', control: '#1a2c4a', textPrimary: '#e6eef9', textSecondary: '#a3b6d1',
        border: '#22385c', highlight: '#5aa9ff', shadow: '#00000066', ringTrack: '#22385c', barTrack: '#1c3050',
        ample: '#3ddc97', watch: '#ffd166', critical: '#ff5c5c', warning: '#ff9f6b'},
    'snow': {notch: '#f5f5f7', card: '#ffffff', control: '#ececf0', textPrimary: '#1d1d1f', textSecondary: '#55555c',
        border: '#d8d8de', highlight: '#0a64d8', shadow: '#0000002e', ringTrack: '#dcdce2', barTrack: '#e4e4ea', ...LIGHT_STATUS},
    // Glass themes: notch and card are the tint, drawn over the blur at the
    // user's tint opacity; controls and tracks are translucent overlays.
    'frosted-dark': {notch: '#1c1c1e', card: '#1c1c1e', control: '#ffffff1f', textPrimary: '#ffffff', textSecondary: '#d4d4da',
        border: '#ffffff3d', highlight: '#e0e0e6', shadow: '#00000059', ringTrack: '#ffffff33', barTrack: '#ffffff26', ...DARK_STATUS},
    'frosted-light': {notch: '#f2f2f5', card: '#f2f2f5', control: '#00000014', textPrimary: '#111114', textSecondary: '#333338',
        border: '#ffffffb3', highlight: '#0a64d8', shadow: '#00000038', ringTrack: '#0000001f', barTrack: '#00000017', ...LIGHT_STATUS},
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

// Contrast targets (WCAG): body text 4.5:1, rings and other marks 3:1.
export const TEXT_CONTRAST = 4.5;
export const MARK_CONTRAST = 3;

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
    return {...base, highlight: accent, ringTrack: mix(base.ringTrack, accent, 0.3)};
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

// custom: {background, card, text, highlight, opacity}. A translucent card
// shows the desktop through it, so the opacity is raised until some text
// color reads over both a black and a white desktop.
export function customPalette(custom) {
    const card = custom.card, notch = custom.background;
    const readable = op => [card, notch].every(c => {
        const bgs = desktops(withAlpha(c, op));
        return Math.max(...['#ffffff', '#000000'].map(t => Math.min(...bgs.map(bg => contrast(t, bg))))) >= TEXT_CONTRAST;
    });
    let opacity = Math.max(0.3, Math.min(1, custom.opacity));
    while (opacity < 1 && !readable(opacity)) opacity = Math.min(1, opacity + 0.05);
    const text = fitAll(custom.text, desktops(withAlpha(card, opacity)), TEXT_CONTRAST);
    const light = luminance(card) > 0.4;
    return {
        notch: withAlpha(notch, opacity), card: withAlpha(card, opacity),
        control: mix(card, text, 0.1), textPrimary: text,
        textSecondary: ensureContrast(mix(text, card, 0.35), card, TEXT_CONTRAST),
        border: mix(card, text, 0.18), highlight: custom.highlight,
        shadow: light ? '#0000002e' : '#00000066', ringTrack: mix(notch, text, 0.2), barTrack: mix(card, text, 0.14),
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
    let cardBg = desktops(t.card), notchBg = desktops(t.notch);
    if (glass) {
        const tint = Math.max(GLASS_TINT_MIN, params.glass.tint);
        t.notch = withAlpha(t.notch, tint);
        t.card = withAlpha(t.card, tint);
        cardBg = notchBg = glassBackdrops(BUILT_IN[id].card, tint, params.glass.brightness);
    }
    t.textPrimary = fitAll(t.textPrimary, [...cardBg, ...notchBg], TEXT_CONTRAST);
    t.textSecondary = fitAll(t.textSecondary, cardBg, TEXT_CONTRAST);
    t.warning = fitAll(t.warning, cardBg, TEXT_CONTRAST);

    // Light when dark text is what reads.
    const light = luminance(t.textPrimary) < 0.2;
    return {
        ...t, id, glass, light,
        glassParams: glass ? {radius: params.glass.blur, brightness: params.glass.brightness} : null,
        controlHover: mix(t.control, t.textPrimary, 0.073),
        controlFocus: mix(t.control, t.textPrimary, 0.128),
        selection: mix(t.control, t.textPrimary, 0.2),
        textDim: mix(t.textSecondary, over(t.card, light ? '#ffffff' : '#000000'), 0.3),
        // Accents keep their hue; only lightness moves when contrast is low.
        accent: (color, where = 'notch') => fitAll(t[color] ?? color, where === 'card' ? cardBg : notchBg, MARK_CONTRAST),
    };
}

// Swatch colors for the prefs picker: background, card, accent line, text.
export function swatch(tokens) {
    return [tokens.notch, tokens.card, tokens.highlight, tokens.textPrimary];
}

// ---- stylesheet ----

const css = color => {
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
    const focusRing = `box-shadow: inset 0 0 0 1px ${css(t.highlight)};`;
    const cardBorder = t.glass ? `border: 1px solid ${css(t.border)};` : '';
    return `
.ledge-cell:focus { background-color: ${css(t.control)}; }
.ledge-percent, .ledge-title, .ledge-window-title, .ledge-row-title, .ledge-settings, .ledge-cell-icon { color: ${css(t.textPrimary)}; }
.ledge-detail { background-color: ${css(t.card)}; color: ${css(t.textPrimary)}; box-shadow: 0 6px 18px 0 ${css(t.shadow)}; ${cardBorder} }
.ledge-muted, .ledge-section { color: ${css(t.textSecondary)}; }
.ledge-warning { color: ${css(t.warning)}; }
.ledge-hairline { background-color: ${css(t.border)}; }
.ledge-action, .ledge-small-action { background-color: ${css(t.control)}; color: ${css(t.textPrimary)}; }
.ledge-action:hover, .ledge-small-action:hover { background-color: ${css(t.controlHover)}; }
.ledge-action:focus, .ledge-small-action:focus { background-color: ${css(t.controlFocus)}; ${focusRing} }
.ledge-row { color: ${css(t.textPrimary)}; }
.ledge-row:hover, .ledge-row-active { background-color: ${css(t.control)}; }
.ledge-row:focus { background-color: ${css(t.controlHover)}; ${focusRing} }
.ledge-dim { color: ${css(t.textDim)}; }
.ledge-entry { background-color: ${css(t.control)}; color: ${css(t.textPrimary)}; caret-color: ${css(t.textPrimary)}; selection-background-color: ${css(t.selection)}; selected-color: ${css(t.textPrimary)}; }
.ledge-entry .hint-text { color: ${css(t.textSecondary)}; }
.ledge-entry:focus { ${focusRing} }
.ledge-icon-button { color: ${css(t.textSecondary)}; }
.ledge-icon-button:hover { background-color: ${css(t.controlHover)}; color: ${css(t.textPrimary)}; }
.ledge-icon-button:focus { background-color: ${css(t.controlFocus)}; color: ${css(t.textPrimary)}; }
`;
}
