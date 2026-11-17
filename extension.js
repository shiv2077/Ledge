import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {closeHttp} from './lib/http.js';
import {Appearance} from './lib/appearance.js';
import {Rail} from './lib/rail.js';
import {Panel} from './lib/panel.js';
import {USAGE_MODULES} from './modules/usage.js';
import {PowerModule} from './modules/power.js';
import {TodoModule} from './modules/todo.js';
import {ModelsModule} from './modules/models.js';
import {GithubModule} from './modules/github.js';
import {TrainingModule} from './modules/training.js';

// Chip order.
const MODULES = [...USAGE_MODULES, PowerModule, TodoModule, ModelsModule, GithubModule, TrainingModule];

// Keys that move Ledge to another placement; the old one is torn down.
const PLACEMENT_KEYS = ['placement', 'panel-box', 'panel-position'];

// The host: owns the modules and the theme, and hands their cells to the
// placement (top bar or screen edge), which draws the chips and the deck.
export default class Ledge extends Extension {
    enable() {
        this._alive = true;
        this._modules = new Map();
        this._pendingChanges = new Set();
        this._settings = this.getSettings();
        // Resolved before any actor exists; later changes redraw in place, so
        // an open deck follows the theme. Its keys are skipped below.
        this._appearance = new Appearance(this._settings, theme => {
            this._theme = theme;
            this._placement?.applyTheme();
        });
        this._moduleHost = {
            settings: this._settings,
            path: this.path,
            changed: module => this._changed(module),
            openPreferences: () => this.openPreferences(),
        };
        this._placement = this._createPlacement();
        this._settingsSignal = this._settings.connect('changed', (_s, key) => {
            if (/^(theme|custom-|glass-)/.test(key)) return;
            if (MODULES.some(M => M.id === key)) this._syncModules();
            if (PLACEMENT_KEYS.includes(key)) {
                this._placement.destroy();
                this._placement = this._createPlacement();
            }
            this._placement.update(this._cells());
            this._placement.settingsChanged(key);
        });
        Main.wm.addKeybinding('toggle-notch', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL, () => this._placement.toggle());
        this._syncModules();
        this._placement.update(this._cells());
        this._placement.settingsChanged();
    }

    _createPlacement() {
        const Placement = this._settings.get_string('placement') === 'edge' ? Rail : Panel;
        return new Placement({
            settings: this._settings,
            theme: () => this._theme,
            cells: () => this._cells(),
            openPreferences: () => this.openPreferences(),
        });
    }

    // Starts modules whose key is on and stops the rest.
    _syncModules() {
        for (const M of MODULES) {
            const running = this._modules.get(M.id);
            const wanted = this._settings.get_boolean(M.id);
            if (wanted && !running) {
                const module = new M(this._moduleHost);
                this._modules.set(M.id, module);
                module.start();
            } else if (!wanted && running) {
                this._modules.delete(M.id);
                running.stop();
            }
        }
    }

    // One cell per running module, in chip order: {key, module, info}.
    _cells() {
        return MODULES.filter(M => this._modules.has(M.id)).map(M => {
            const module = this._modules.get(M.id);
            return {key: M.id, module, info: module.cell()};
        });
    }

    // Coalesces updates from several modules into one redraw before paint.
    _changed(module) {
        if (!this._alive || !this._modules.has(module.id)) return;
        this._pendingChanges.add(module.id);
        if (this._changeIdle) return;
        this._changeIdle = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this._changeIdle = 0;
            const changed = this._pendingChanges;
            this._pendingChanges = new Set();
            this._placement.update(this._cells(), changed);
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (!this._alive) return;
        this._alive = false;
        for (const module of this._modules.values()) module.stop();
        this._modules.clear();
        closeHttp();
        if (this._changeIdle) GLib.Source.remove(this._changeIdle);
        this._changeIdle = 0;
        Main.wm.removeKeybinding('toggle-notch');
        this._settings.disconnect(this._settingsSignal);
        this._placement.destroy();
        this._appearance.destroy();
        this._placement = this._appearance = this._settings = this._moduleHost = this._theme = null;
    }
}
