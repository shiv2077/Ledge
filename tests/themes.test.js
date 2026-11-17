import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OFF_CONTRAST, BUILT_IN, THEME_IDS, GLASS_THEMES, GLASS_DEFAULTS, GLASS_TINT_MIN, TEXT_CONTRAST, MARK_CONTRAST, resolveTheme,
    contrast, over, withAlpha, glassBackdrops, ensureContrast, parseYaru, systemPalette, themeCss, rgba, mix} from '../themes.js';
import {PROVIDER_COLORS, MODULE_COLORS} from '../design.js';

const resolve = (theme, extra = {}) => resolveTheme({theme, glass: GLASS_DEFAULTS,
    custom: {background: '#000000', card: '#101010', text: '#ffffff', highlight: '#3584e4', opacity: 1},
    desktop: {colorScheme: 'prefer-dark', gtkTheme: 'Yaru-blue-dark', accentColor: null}, ...extra});

test('midnight carries the Deck colors', () => {
    const t = resolve('midnight');
    assert.deepEqual([t.rail, t.deck, t.border, t.meterOff, t.textPrimary, t.textSecondary],
        ['#0B0E12', '#0A0D12', '#232A33', '#232A33', '#E8ECF2', '#7E8794']);
    assert.notEqual(t.rail, '#000000', 'the default look is not a black slab');
    assert.equal(resolve('bogus').id, 'midnight');
    for (const id of THEME_IDS)
        for (const token of ['rail', 'deck', 'control', 'textPrimary', 'textSecondary', 'border', 'highlight', 'shadow', 'meterOff', 'led'])
            assert.match(resolve(id)[token], /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, `${id} ${token}`);
});

test('solid themes are readable as designed, without runtime correction', () => {
    for (const id of Object.keys(BUILT_IN).filter(id => !GLASS_THEMES.includes(id))) {
        const theme = BUILT_IN[id];
        for (const bg of [theme.deck, theme.rail]) {
            assert.ok(contrast(theme.textPrimary, bg) >= TEXT_CONTRAST, `${id} primary on ${bg}`);
            assert.ok(contrast(theme.warning, theme.deck) >= TEXT_CONTRAST, `${id} warning`);
        }
        for (const bg of [theme.deck, theme.rail])
            assert.ok(contrast(theme.textSecondary, bg) >= TEXT_CONTRAST, `${id} secondary ${contrast(theme.textSecondary, bg)}`);
        const t = resolve(id);
        assert.equal(t.textPrimary, theme.textPrimary, `${id} primary unchanged`);
        assert.equal(t.textSecondary, theme.textSecondary, `${id} secondary unchanged`);
    }
});

test('glass text is readable over any backdrop at default and minimum tint', () => {
    for (const id of GLASS_THEMES) {
        for (const tint of [GLASS_DEFAULTS.tint, GLASS_TINT_MIN]) {
            for (const bg of glassBackdrops(BUILT_IN[id].deck, tint, GLASS_DEFAULTS.brightness)) {
                assert.ok(contrast(BUILT_IN[id].textPrimary, bg) >= TEXT_CONTRAST, `${id} primary @${tint} on ${bg}: ${contrast(BUILT_IN[id].textPrimary, bg).toFixed(2)}`);
                if (tint === GLASS_DEFAULTS.tint)
                    assert.ok(contrast(BUILT_IN[id].textSecondary, bg) >= TEXT_CONTRAST, `${id} secondary on ${bg}: ${contrast(BUILT_IN[id].textSecondary, bg).toFixed(2)}`);
            }
        }
        const t = resolve(id, {glass: {...GLASS_DEFAULTS, tint: 0.1}});
        assert.equal(rgba(t.rail)[3].toFixed(2), GLASS_TINT_MIN.toFixed(2), 'tint never drops below the readable minimum');
        assert.ok(t.glass && t.glassParams.radius === GLASS_DEFAULTS.blur);
    }
});

test('every theme resolves readable text and visible accents', () => {
    for (const id of THEME_IDS) {
        const t = resolve(id);
        const bgs = t.glass ? glassBackdrops(BUILT_IN[id].deck, GLASS_DEFAULTS.tint, GLASS_DEFAULTS.brightness)
            : [over(t.deck, '#000000'), over(t.deck, '#ffffff')].slice(0, rgba(t.deck)[3] < 1 ? 2 : 1);
        for (const bg of bgs) {
            assert.ok(contrast(t.textPrimary, bg) >= TEXT_CONTRAST - 0.01, `${id} primary`);
            assert.ok(contrast(t.textSecondary, bg) >= TEXT_CONTRAST - 0.01, `${id} secondary`);
        }
        for (const accent of [...Object.values(PROVIDER_COLORS), ...Object.values(MODULE_COLORS), 'critical', 'watch', 'ample'])
            assert.ok(contrast(t.accent(accent, 'deck'), t.glass ? bgs[1] : bgs[0]) >= MARK_CONTRAST - 0.01, `${id} accent ${accent}`);
        if (!t.glass && rgba(t.rail)[3] === 1) {
            for (const accent of [...Object.values(PROVIDER_COLORS), ...Object.values(MODULE_COLORS), 'critical', 'watch'])
                assert.ok(contrast(t.accent(accent, 'rail'), t.rail) >= MARK_CONTRAST - 0.01, `${id} rail accent ${accent}`);
        }
        const sheet = themeCss(t);
        assert.ok(!/NaN|undefined/.test(sheet), `${id} stylesheet is complete`);
    }
});

test('accents keep hue and only change lightness', () => {
    const snow = resolve('snow');
    const claude = snow.accent(PROVIDER_COLORS.claude);
    assert.notEqual(claude, PROVIDER_COLORS.claude);
    assert.ok(contrast(claude, BUILT_IN.snow.rail) >= MARK_CONTRAST);
    const [r, g, b] = rgba(claude);
    assert.ok(r > g && g > b, 'still orange');
    assert.equal(resolve('midnight').accent(PROVIDER_COLORS.claude), PROVIDER_COLORS.claude, 'unchanged when readable');
    assert.equal(ensureContrast('#777777', '#000000', 1), '#777777');
});

test('system theme follows yaru accent and light or dark', () => {
    assert.deepEqual(parseYaru('Yaru-blue-dark'), {accent: '#0073E5', dark: true});
    assert.deepEqual(parseYaru('Yaru'), {accent: '#E95420', dark: false});
    assert.deepEqual(parseYaru('Yaru-dark'), {accent: '#E95420', dark: true});
    assert.deepEqual(parseYaru('Yaru-prussiangreen'), {accent: '#308280', dark: false});
    assert.equal(parseYaru('Adwaita-dark').dark, true);
    assert.equal(systemPalette({colorScheme: 'prefer-dark', gtkTheme: 'Yaru-purple-dark'}).highlight, '#7764D8');
    assert.equal(systemPalette({colorScheme: 'default', gtkTheme: 'Yaru-red'}).rail, BUILT_IN.snow.rail);
    assert.equal(systemPalette({colorScheme: 'prefer-dark', gtkTheme: 'Yaru-red', accentColor: 'teal'}).highlight, '#2190a4');
    const light = resolve('system', {desktop: {colorScheme: 'prefer-light', gtkTheme: 'Yaru-sage'}});
    assert.ok(light.light && contrast(light.textPrimary, light.deck) >= TEXT_CONTRAST);
});

test('custom theme repairs unreadable text and keeps translucency readable', () => {
    for (const card of ['#303030', '#808080', '#f0f0f0', '#3050a0'])
        for (const opacity of [0.3, 0.6, 1]) {
            const t = resolve('custom', {custom: {background: card, card, text: '#777777', highlight: '#ff00ff', opacity}});
            for (const desktop of ['#000000', '#ffffff'])
                assert.ok(contrast(t.textPrimary, over(t.deck, desktop)) >= TEXT_CONTRAST, `${card} @${opacity} over ${desktop}`);
            assert.ok(rgba(t.deck)[3] >= opacity - 0.001, 'opacity is only ever raised');
        }
    assert.equal(rgba(resolve('custom', {custom: {background: '#000000', card: '#000000', text: '#ffffff', highlight: '#fff', opacity: 0.6}}).deck)[3].toFixed(1), '0.6',
        'a dark deck keeps the chosen opacity when white text still reads');
    assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
    assert.equal(withAlpha('#ff0000', 0.5), '#ff000080');
});

test('unlit segments and off lights stay visible on rail and deck', () => {
    for (const id of THEME_IDS) {
        const t = resolve(id);
        const bgs = t.glass ? glassBackdrops(BUILT_IN[id].deck, GLASS_DEFAULTS.tint, GLASS_DEFAULTS.brightness)
            : [t.rail, t.deck].flatMap(bg => [over(bg, '#000000'), over(bg, '#ffffff')].slice(0, rgba(bg)[3] < 1 ? 2 : 1));
        for (const bg of bgs) {
            assert.ok(contrast(over(t.meterOff, bg), bg) >= OFF_CONTRAST.meterOff - 0.01, `${id} meterOff on ${bg}: ${contrast(over(t.meterOff, bg), bg).toFixed(2)}`);
            assert.ok(contrast(over(t.led, bg), bg) >= OFF_CONTRAST.led - 0.01, `${id} led on ${bg}: ${contrast(over(t.led, bg), bg).toFixed(2)}`);
        }
    }
    assert.equal(resolve('system').meterOff, BUILT_IN.graphite.meterOff, 'the desktop accent never tints other modules\' meters');
});
