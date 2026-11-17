import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {CHIP, MOTION, stripMode, urgency} from '../design.js';
import {BADGES} from '../model.js';
import {panelPalette, toHex} from '../themes.js';
import {Strip} from './strip.js';
import {Deck} from './deck.js';
import {holds, lightColor} from './ui.js';

const ROLE = 'ledge';

const once = (ms, callback) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    callback();
    return GLib.SOURCE_REMOVE;
});

// A popup menu whose only content is the deck. Its own chrome is styled
// away (stylesheet.css, .ledge-deck-menu) and it opens and closes without
// the box pointer's motion, so the deck's own motion is the only one.
class DeckMenu extends PopupMenu.PopupMenu {
    constructor(source, onOpening) {
        super(source, 0, St.Side.TOP);
        this._onOpening = onOpening;
        this.actor.add_style_class_name('ledge-deck-menu');
    }

    // The deck is shown by the opening hook, so the menu is never empty.
    isEmpty() { return false; }

    open() {
        if (this.isOpen) return;
        this._onOpening();
        super.open(BoxPointer.PopupAnimation.NONE);
    }

    close() { super.close(BoxPointer.PopupAnimation.NONE); }

    // Aligns the deck's left edge with `share` (0..1) of the source width.
    align(share) { this._boxPointer.setSourceAlignment(share); }
}

const Button = GObject.registerClass(
class LedgePanelButton extends PanelMenu.Button {
    _init() {
        super._init(0, 'Ledge', false);
        this.add_style_class_name('ledge-panel-button');
    }
});

// Top bar placement: one panel button holding the chip strip, with the deck
// in its popup menu, flush under the bar and aligned to the open chip.
// host: {settings, theme(), cells(), openPreferences()}
export class Panel {
    constructor(host) {
        this.host = host;
        this._settings = host.settings;
        this._mode = 'full';
        this.button = new Button();
        // Chips fill the bar's height, so the open chip meets its deck.
        this.strip = new Strip({vertical: false, height: CHIP.panelHeight, palette: () => this._palette(),
            separators: true, button: false, readoutClass: 'ledge-panel-readout', fill: true,
            width: CHIP.panelWidth, gap: CHIP.panelGap, corner: null,
            handlers: {
                hover: key => this._chipHover(key),
                focus: key => { if (this.menu.isOpen) this.open(key); },
                key: event => this.key(event),
            }});
        this.button.add_child(this.strip.actor);
        this.deck = new Deck({theme: host.theme, openPreferences: () => {
            this.menu.close();
            host.openPreferences();
        }, key: event => this.key(event)});
        this.menu = new DeckMenu(this.button, () => this._opening());
        this.menu.box.add_child(this.deck.actor);
        this.button.setMenu(this.menu);
        this._capturedSignal = this.menu.actor.connect('captured-event', (_a, event) => this._captured(event));
        this._menuSignal = this.menu.connect('open-state-changed', (_m, open) => {
            // A menu opened under the pointer starts with the pointer inside.
            this._pointerInside = open;
            if (!open) {
                this.deck.hide();
                this.strip.setOpen(null);
                this.strip.setSummaryOpen(false);
            }
        });
        this._buttonHover = this.button.connect('notify::hover', () => this._hover());
        this._deckHover = this.deck.actor.connect('notify::hover', () => this._hover());
        this._monitorSignal = Main.layoutManager.connect('monitors-changed', () => this._fit());
        this._overviewSignal = Main.overview.connect('showing', () => this.menu.close());
        // The panel's own colors change with the shell theme and in Overview.
        this._panelStyle = Main.panel.connect('style-changed', () => this._paletteChanged());
        this._insert();
        this.applyTheme();
    }

    // Chip colors fitted to the top bar's background and text color.
    _palette() {
        if (!this._paletteCache) {
            const node = Main.panel.get_theme_node();
            const color = c => toHex([c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255]);
            this._paletteCache = panelPalette(this.host.theme(), color(node.get_background_color()), color(node.get_foreground_color()));
        }
        return this._paletteCache;
    }

    _paletteChanged() {
        if (this._destroyed) return;
        this._paletteCache = null;
        this.strip.repaint();
        this._summary();
    }

    // Puts the button in the configured box; position -1 means right after
    // the clock in the centre box, or at the end of any other box.
    _insert() {
        const box = this._settings.get_string('panel-box');
        let position = this._settings.get_int('panel-position');
        const clock = Main.panel.statusArea.dateMenu?.container;
        const centre = Main.panel._centerBox;
        const afterClock = position < 0 && box === 'center' && clock?.get_parent() === centre;
        if (position < 0) position = afterClock ? centre.get_children().indexOf(clock) + 1 : Main.panel[`_${box}Box`].get_n_children();
        Main.panel.addToStatusArea(ROLE, this.button, position, box);
        // Right after the clock, an empty twin of the strip goes before the
        // clock, so the centre box stays balanced and the clock centred.
        if (afterClock) {
            this._spacer = new St.Widget({reactive: false});
            centre.insert_child_below(this._spacer, clock);
            this.button.container.bind_property('width', this._spacer, 'width', GObject.BindingFlags.SYNC_CREATE);
        }
    }

    // ---- opening and switching ----

    // The chip under the pointer or with key focus, else the open one, else the first.
    _target() {
        const chips = [...this.strip.chips.values()];
        const focus = global.stage.get_key_focus();
        return (chips.find(chip => chip.actor.hover) ?? chips.find(chip => holds(chip.actor, focus))
            ?? this.strip.chips.get(this._last) ?? chips[0])?.key;
    }

    // The summary chip opens on the module its light stands for, so the
    // light and the deck agree.
    _opening() {
        const key = this._mode === 'summary' ? this._urgent() ?? this._last ?? this.strip.keys()[0] : this._target();
        if (key) this._show(key);
        this.strip.setSummaryOpen(this._mode === 'summary');
    }

    _urgent() {
        const cells = this.host.cells();
        const state = urgency(cells.map(cell => cell.info.light));
        return state === 'off' ? null : cells.find(cell => cell.info.light === state)?.key;
    }

    _show(key, refresh = false) {
        const cell = this.host.cells().find(candidate => candidate.key === key);
        if (!cell) return;
        if (this.deck.visible && this.deck.key === key && !refresh) return;
        this._last = key;
        this.deck.show(cell, 'top', this._mode === 'summary' ? this._switcher(key) : null);
        this.strip.setOpen(this._mode === 'summary' ? null : key);
        this._align(key);
    }

    _align(key) {
        const chip = this._mode === 'summary' ? {actor: this.strip.summaryActor} : this.strip.chips.get(key);
        const width = this.button.width;
        if (!chip?.actor || !width) {
            this.menu.align(0);
            return;
        }
        const [buttonX] = this.button.get_transformed_position();
        const [chipX] = chip.actor.get_transformed_position();
        const node = this.button.get_theme_node();
        const content = node.get_content_box(this.button.get_allocation_box());
        this.menu.align(Math.max(0, Math.min(1, (chipX - buttonX - content.x1) / Math.max(1, content.x2 - content.x1))));
    }

    open(key) {
        if (!this.menu.isOpen) {
            this._last = key;
            this.menu.open();
        } else {
            this._show(key);
        }
    }

    close() { this.menu.close(); }

    // While the deck is open, hovering another chip switches to it, as
    // between panel menus. With panel-open-on-hover, hovering also opens.
    _chipHover(key) {
        if (this.menu.isOpen) {
            this._show(key);
            return;
        }
        this._hover();
    }

    _clearTimers() {
        for (const name of ['_intent', '_grace']) {
            if (this[name]) GLib.Source.remove(this[name]);
            this[name] = 0;
        }
    }

    // While the menu holds its grab, actors outside it get no crossing
    // events, so hover over the chips comes from the menu's captured
    // events instead, as the shell's own menu manager does.
    _captured(event) {
        if (event.type() !== Clutter.EventType.ENTER || (event.get_flags() & Clutter.EventFlags.FLAG_GRAB_NOTIFY) !== 0)
            return Clutter.EVENT_PROPAGATE;
        const target = global.stage.get_event_actor(event);
        this._pointerInside = !!target && (this.button.contains(target) || this.deck.actor.contains(target));
        const chip = [...this.strip.chips.values()].find(candidate => target && candidate.actor.contains(target));
        if (chip && chip.actor.visible) this._show(chip.key);
        this._hover();
        return Clutter.EVENT_PROPAGATE;
    }

    _inside() {
        return this.menu.isOpen ? this._pointerInside : this.button.hover;
    }

    _hover() {
        if (this._destroyed || !this._settings.get_boolean('panel-open-on-hover')) return;
        const inside = this._inside();
        this._clearTimers();
        if (inside && !this.menu.isOpen) {
            this._intent = once(MOTION.hoverIntent, () => {
                this._intent = 0;
                if (this._inside()) this.menu.open();
            });
        } else if (!inside && this.menu.isOpen) {
            this._grace = once(MOTION.foldGrace, () => {
                this._grace = 0;
                const typing = holds(this.deck.actor, global.stage.get_key_focus());
                if (!typing && !this._inside()) this.menu.close();
            });
        }
    }

    // ---- narrow panels ----

    // Chips lose readouts first, then fold into one summary chip.
    _fit() {
        if (this._destroyed) return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        // What the rest of the bar needs, without the strip and its twin.
        const own = (this.button.get_parent() ? this.button.container.width : 0) * (this._spacer ? 2 : 1);
        const others = [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox]
            .reduce((sum, box) => sum + box.get_preferred_width(-1)[1], 0) - own;
        // With the twin, the strip gets half of what is left.
        const available = this._available ?? (monitor.width - others) / (this._spacer ? 2 : 1);
        const mode = stripMode(this.strip.keys().length, available);
        if (mode === this._mode) return;
        this._mode = mode;
        this.menu.close();
        this.strip.setMode(mode);
        this._summary();
    }

    // Test hook: pretend the panel leaves `width` px for the strip, or null.
    setAvailable(width) {
        this._available = width;
        this._fit();
    }

    _summary() {
        if (this._mode !== 'summary') return;
        const cells = this.host.cells();
        const state = urgency(cells.map(cell => cell.info.light));
        const lead = cells.find(cell => cell.info.light === state);
        const palette = this._palette();
        this.strip.setSummary(state, lightColor(state, lead ? palette.accent(lead.info.accent) : palette.led, palette));
    }

    // A row of module buttons at the top of the deck, for the summary chip.
    _switcher(active) {
        return this.host.cells().map(cell => ({key: cell.key, label: cell.info.badge ?? BADGES[cell.key] ?? cell.key,
            name: cell.module.heading(cell.key), accent: cell.info.accent, light: cell.info.light,
            active: cell.key === active, activate: () => this._show(cell.key, true)}));
    }

    // ---- keyboard ----

    key(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab) {
            const targets = this.deck.focusTargets();
            if (targets.length) {
                const focus = global.stage.get_key_focus();
                const current = targets.findIndex(target => holds(target, focus));
                const backwards = symbol === Clutter.KEY_ISO_Left_Tab || Boolean(event.get_state() & Clutter.ModifierType.SHIFT_MASK);
                targets[(current + (backwards ? -1 : 1) + targets.length) % targets.length].grab_key_focus();
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // The keyboard shortcut opens the deck on the first chip and focuses it.
    toggle() {
        if (this.menu.isOpen) {
            this.menu.close();
            return;
        }
        this._last = this.strip.keys()[0];
        this.menu.open();
        (this.deck.focusTargets()[0] ?? this.deck.actor).grab_key_focus();
    }

    // ---- host interface ----

    update(cells, changed = new Set()) {
        const before = this.strip.keys().join('\n');
        this.strip.update(cells);
        if (this.strip.keys().join('\n') !== before) this._later(() => this._fit());
        this._summary();
        if (!this.menu.isOpen) return;
        if (!this.strip.chips.has(this.deck.key)) this.menu.close();
        else if (changed.has(this.deck.key)) this._show(this.deck.key, true);
    }

    _later(callback) {
        if (this._idle) GLib.Source.remove(this._idle);
        this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idle = 0;
            if (!this._destroyed) callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    settingsChanged() {
        this._clearTimers();
        this.menu.close();
    }

    applyTheme() {
        this._paletteCache = null;
        this.strip.repaint();
        this.update(this.host.cells());
        if (this.menu.isOpen) this._show(this.deck.key, true);
        this.deck.applyTheme();
    }

    canvases() {
        return [...[...this.strip.chips.values()].flatMap(chip => chip.canvases()), ...this.deck.canvases()];
    }

    destroy() {
        this._destroyed = true;
        this._clearTimers();
        if (this._idle) GLib.Source.remove(this._idle);
        this._idle = 0;
        Main.layoutManager.disconnect(this._monitorSignal);
        Main.overview.disconnect(this._overviewSignal);
        Main.panel.disconnect(this._panelStyle);
        this.menu.disconnect(this._menuSignal);
        this.menu.actor.disconnect(this._capturedSignal);
        this.button.disconnect(this._buttonHover);
        this.deck.actor.disconnect(this._deckHover);
        this.menu.close();
        this.strip.destroy();
        this.deck.destroy();
        // Destroying the button destroys its menu and removes the status area role.
        this.button.destroy();
        this._spacer?.destroy();
        this._spacer = null;
    }
}
