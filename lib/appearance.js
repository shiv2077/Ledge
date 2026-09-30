import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {resolveTheme, themeCss} from '../themes.js';
import {writeText, ensureDir} from './files.js';

const INTERFACE = 'org.gnome.desktop.interface';
const KEYS = /^(theme|custom-|glass-)/;

const remove = file => file.delete_async(GLib.PRIORITY_DEFAULT, null, (f, r) => {
    try { f.delete_finish(r); } catch { /* Already gone. */ }
});

// Resolves the active theme and keeps it current. onChange(tokens) runs
// synchronously on every change so drawn parts repaint at once; the matching
// stylesheet follows as soon as it is written.
export class Appearance {
    constructor(settings, onChange) {
        this._settings = settings;
        this._onChange = onChange;
        this._sequence = 0;
        this._desktop = new Gio.Settings({schema_id: INTERFACE});
        // accent-color only exists from GNOME 47; ask the schema, never guess.
        this._hasAccent = Gio.SettingsSchemaSource.get_default()?.lookup(INTERFACE, true)?.has_key('accent-color') ?? false;
        this._settingsSignal = settings.connect('changed', (_s, key) => { if (KEYS.test(key)) this.update(); });
        this._desktopSignals = ['gtk-theme', 'color-scheme', ...this._hasAccent ? ['accent-color'] : []]
            .map(key => this._desktop.connect(`changed::${key}`, () => {
                if (this._settings.get_string('theme') === 'system') this.update();
            }));
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        // A new shell theme (for example high contrast) drops custom sheets.
        this._contextSignal = this._themeContext.connect('changed', () => {
            if (this._loadedInto && this._loadedInto !== this._themeContext.get_theme()) this._load(this._css, true);
        });
        this.update();
    }

    update() {
        const s = this._settings;
        this.tokens = resolveTheme({
            theme: s.get_string('theme'),
            custom: {background: s.get_string('custom-background'), card: s.get_string('custom-card'),
                text: s.get_string('custom-text'), highlight: s.get_string('custom-highlight'), opacity: s.get_double('custom-opacity')},
            glass: {blur: s.get_int('glass-blur'), tint: s.get_double('glass-tint'), brightness: s.get_double('glass-brightness')},
            desktop: {colorScheme: this._desktop.get_string('color-scheme'), gtkTheme: this._desktop.get_string('gtk-theme'),
                accentColor: this._hasAccent ? this._desktop.get_string('accent-color') : null},
        });
        this._onChange(this.tokens);
        this._load(themeCss(this.tokens));
    }

    // Writes the sheet to a fresh file (St caches sheets by file) and swaps
    // it in. Only the newest request loads if several overlap.
    async _load(css, force = false) {
        if (css === this._css && !force) return;
        this._css = css;
        const sequence = ++this._sequence;
        const dir = `${GLib.get_user_cache_dir()}/ledge`;
        const path = `${dir}/theme-${GLib.get_monotonic_time()}.css`;
        const error = await ensureDir(dir) ?? await writeText(path, css);
        if (sequence !== this._sequence || !this._themeContext) {
            if (!error) remove(Gio.File.new_for_path(path));
            return;
        }
        if (error) {
            console.warn(`Ledge: could not write theme stylesheet: ${error.message}`);
            return;
        }
        this._unload();
        const theme = this._themeContext.get_theme();
        this._file = Gio.File.new_for_path(path);
        try {
            theme.load_stylesheet(this._file);
            this._loadedInto = theme;
        } catch (e) {
            console.warn(`Ledge: could not load theme stylesheet: ${e.message}`);
        }
    }

    _unload() {
        if (!this._file) return;
        this._loadedInto?.unload_stylesheet(this._file);
        remove(this._file);
        this._file = this._loadedInto = null;
    }

    destroy() {
        this._sequence++;
        this._settings.disconnect(this._settingsSignal);
        for (const id of this._desktopSignals) this._desktop.disconnect(id);
        this._themeContext.disconnect(this._contextSignal);
        this._unload();
        this._themeContext = this._desktop = null;
    }
}
