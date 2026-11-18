import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {DOT_ICONS, SHELF, logoDots, urgency} from '../design.js';
import {drawCard, drawDial, drawDotIcon, drawStrip, drawTrace} from '../draw.js';
import {railPalette, toHex} from '../themes.js';
import {setGlass} from './glass.js';
import {Deck} from './deck.js';
import {animations, box, canvas, holds, light, lightColor, setLight} from './ui.js';

const CHROME = {affectsStruts: false, trackFullscreen: true};
// Sources drawn as tubes; every other cell is a row in the side list.
const TUBES = new Set(['claude', 'cursor', 'codex', 'copilot', 'models']);
// Short names under the tubes.
const SHORT = {claude: 'claude', cursor: 'cursor', codex: 'codex', copilot: 'copilot', models: 'models',
    power: 'power', todo: 'todo', github: 'github', training: 'training'};
const once = (ms, callback) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { callback(); return GLib.SOURCE_REMOVE; });

// Top bar placement. A small glass lens sits right after the clock: a live
// trace (moving while a session works) and the lowest quota left. Hover or
// click opens one glass sheet under it: sources as liquid tubes, the rest
// as a list, and the selected source's detail below them.
export class Shelf {
    constructor(host) {
        this.host = host;
        this._settings = host.settings;
        this._cells = [];
        this._items = new Map();
        this._selected = null;
        this._phase = 0;

        this._trace = canvas((cr, w, h) => this._drawTrace(cr, w, h), {width: SHELF.lensWidth, height: SHELF.lensTrace,
            y_align: Clutter.ActorAlign.CENTER, x_expand: false, y_expand: false});
        this._figure = new St.Label({style_class: 'ledge-lens-figure', y_align: Clutter.ActorAlign.CENTER});
        const lensBox = box(false, {style: `spacing: ${SHELF.lensMargin * 2}px;`, y_align: Clutter.ActorAlign.CENTER});
        lensBox.add_child(this._trace);
        lensBox.add_child(this._figure);
        this.lens = new St.Button({style_class: 'ledge-lens', child: lensBox, reactive: true, can_focus: true, track_hover: true,
            y_align: Clutter.ActorAlign.CENTER, accessible_name: 'Ledge'});
        this.lens.connect('clicked', () => (this._open ? this.close() : this.open()));
        this.lens.connect('notify::hover', () => this._hover());
        this._insert();

        // The sheet: glass background, then content.
        this.sheet = new St.Widget({style_class: 'ledge-shelf', layout_manager: new Clutter.BinLayout(),
            reactive: true, track_hover: true, visible: false});
        this._glass = canvas((cr, w, h) => drawStrip(cr, w, h, SHELF.flare, SHELF.radius, this.ink().fill, SHELF.rim));
        // Inside the flares: padding clears the curved top corners.
        this._content = box(true, {style: `padding: 0 ${SHELF.flare + SHELF.padding}px ${SHELF.cellGap}px; spacing: ${SHELF.gap}px;`});
        this._top = box(false, {style: `spacing: ${SHELF.cellGap}px;`, x_align: Clutter.ActorAlign.CENTER});
        // The dropdown: a separate card under the strip, below the hovered source.
        this.drop = new St.Widget({style_class: 'ledge-shelf', layout_manager: new Clutter.BinLayout(),
            reactive: true, track_hover: true, visible: false});
        this._dropBack = canvas((cr, w, h) => drawCard(cr, w, h, SHELF.cardRadius, this.ink().fill, SHELF.rim));
        this._detail = box(true, {style: `padding: ${SHELF.padding}px;`});
        this.deck = new Deck({theme: host.theme, openPreferences: host.openPreferences, key: event => this.key(event),
            frameless: true, dots: () => this.ink(), width: SHELF.detailWidth});
        this._detail.add_child(this.deck.actor);
        this.drop.add_child(this._dropBack);
        this.drop.add_child(this._detail);
        this.drop.connect('notify::hover', () => this._hover());
        this.drop.connect('key-press-event', (_a, event) => this.key(event));
        this._content.add_child(this._top);
        this.sheet.add_child(this._glass);
        this.sheet.add_child(this._content);
        this.sheet.connect('notify::hover', () => this._hover());
        this.sheet.connect('key-press-event', (_a, event) => this.key(event));
        // A plain layer, as for the edge deck: the sheet joins chrome only while open.
        this._layer = new Clutter.Actor();
        Main.uiGroup.add_child(this._layer);
        this._layer.add_child(this.sheet);
        this._layer.add_child(this.drop);

        this._overviewSignal = Main.overview.connect('showing', () => this.close());
        this.applyTheme();
    }

    // Right after the clock in the centre box, with an empty twin before the
    // clock so the clock stays centred.
    _insert() {
        const centre = Main.panel._centerBox;
        const clock = Main.panel.statusArea.dateMenu?.container;
        const index = clock?.get_parent() === centre ? centre.get_children().indexOf(clock) + 1 : centre.get_n_children();
        centre.insert_child_at_index(this.lens, index);
        if (clock?.get_parent() === centre) {
            this._spacer = new St.Widget({reactive: false});
            centre.insert_child_below(this._spacer, clock);
            this.lens.bind_property('width', this._spacer, 'width', GObject.BindingFlags.SYNC_CREATE);
        }
    }

    // Monochrome: white dots on the bar's own black, red only for what needs
    // attention. The sheet takes the top bar's color so it reads as the bar
    // growing down; a see-through bar falls back to the theme's rail.
    ink() {
        if (!this._inkCache) {
            const t = this.host.theme();
            const c = Main.panel.get_theme_node().get_background_color();
            const panel = c.alpha > 200 ? toHex([c.red / 255, c.green / 255, c.blue / 255, 1]) : t.rail;
            this._inkCache = {fill: panel, lit: t.textPrimary, off: t.meterOff, dim: t.textSecondary, red: t.accent('critical', 'deck')};
        }
        return this._inkCache;
    }

    // ---- cells ----

    update(cells, changed = new Set()) {
        this._cells = cells;
        const keys = cells.map(cell => cell.key).join('\n');
        if (keys !== this._keys) {
            this._keys = keys;
            this._build();
        }
        for (const cell of cells) this._items.get(cell.key)?.update(cell.info);
        this._updateLens();
        if (this._selected && !cells.some(cell => cell.key === this._selected)) this._select(null);
        else if (this._selected && changed.has(this._selected)) this._showDetail(true);
        this._animate();
    }

    // One row: dials for the sources, a dotted divider, then the stats.
    _build() {
        this._top.destroy_all_children();
        this._items.clear();
        const gauges = this._cells.filter(cell => TUBES.has(cell.module.id));
        const stats = this._cells.filter(cell => !TUBES.has(cell.module.id));
        for (const cell of gauges) this._add(new Gauge(this, cell.key, cell.module.id));
        if (gauges.length && stats.length) {
            this._top.add_child(canvas((cr, w, h) => {
                const ink = this.ink();
                const [r, g, b] = [1, 3, 5].map(i => parseInt(ink.off.slice(i, i + 2), 16) / 255);
                for (let y = SHELF.divider; y < h - SHELF.divider; y += SHELF.divider * 2) cr.rectangle(Math.floor(w / 2), y, 1.5, 1.5);
                cr.setSourceRGBA(r, g, b, 1);
                cr.fill();
            }, {width: SHELF.gap, x_expand: false, y_expand: true}));
        }
        for (const cell of stats) this._add(new Stat(this, cell.key, cell.module.id));
    }

    _add(item) {
        this._top.add_child(item.actor);
        this._items.set(item.key, item);
    }

    _updateLens() {
        const theme = this.host.theme();
        const usage = this._cells.filter(cell => typeof cell.info.usage?.remaining === 'number');
        const lowest = usage.reduce((best, cell) => !best || cell.info.usage.remaining < best.info.usage.remaining ? cell : best, null);
        this._figure.text = lowest ? `${lowest.info.usage.remaining}` : '—';
        const state = urgency(this._cells.map(cell => cell.info.light));
        const lead = this._cells.find(cell => cell.info.light === state) ?? lowest;
        this._traceColor = state === 'off' ? theme.textSecondary : lightColor(state, theme.accent(lead?.info.accent ?? 'textPrimary', 'rail'), railPalette(theme));
        this._working = this._cells.some(cell => cell.info.light === 'working' || cell.info.light === 'waiting');
        this.lens.accessible_name = `Ledge: ${lowest ? `${lowest.info.usage.remaining}% left at the lowest` : 'no usage reading'}`;
        this._trace.queue_repaint();
    }

    _drawTrace(cr, w, h) {
        const moving = this._working && animations();
        drawTrace(cr, w, h, this._phase, moving ? h / 3 : 0, this._traceColor ?? this.host.theme().textSecondary);
    }

    // ---- motion ----

    // One frame-clock timeline drives the tubes while the sheet is open and
    // the lens trace while a session works. It stops when nothing moves.
    _animate() {
        const needed = animations() && (this._working || (this._open && [...this._items.values()].some(item => item.moving?.())));
        if (!needed) {
            this._timeline?.stop();
            this._timeline = null;
            return;
        }
        if (this._timeline) return;
        this._timeline = new Clutter.Timeline({actor: this.lens, duration: 1000, repeat_count: -1});
        let last = null;
        this._timeline.connect('new-frame', () => {
            const now = GLib.get_monotonic_time() / 1000;
            const dt = last === null ? 16 : Math.min(64, now - last);
            // The lens moves at a calm rate; the sheet runs at frame rate.
            if (!this._open && last !== null && dt < SHELF.lensFrame) return;
            last = now;
            this._phase += dt / 1000 * SHELF.tube.speed;
            this._trace.queue_repaint();
            if (this._open) for (const item of this._items.values()) item.step?.(dt);
            if (!this._working && !(this._open && [...this._items.values()].some(item => item.moving?.()))) this._animate();
        });
        this._timeline.start();
    }

    // ---- opening ----

    _hover() {
        if (this._destroyed) return;
        const inside = () => this.lens.hover || this.sheet.hover || this.drop.hover;
        for (const name of ['_intent', '_grace']) if (this[name]) { GLib.Source.remove(this[name]); this[name] = 0; }
        if (inside() && !this._open) this._intent = once(SHELF.intent, () => { this._intent = 0; if (inside()) this.open(); });
        if (!inside() && this._open) {
            this._grace = once(SHELF.grace, () => {
                this._grace = 0;
                const focus = global.stage.get_key_focus();
                const typing = holds(this.sheet, focus) || holds(this.drop, focus);
                if (!inside() && !typing && !this._keyboard) this.close();
            });
        }
        // Leaving the dropdown for the lens folds the detail away.
        if (this.lens.hover && this._selected) this._show(null);
    }

    // Hovering a source drops its detail down under it.
    _itemHover(key, hovered) {
        if (this._itemIntent) GLib.Source.remove(this._itemIntent);
        this._itemIntent = 0;
        if (!hovered || key === this._selected) return;
        this._itemIntent = once(SHELF.intent, () => {
            this._itemIntent = 0;
            if (this._items.get(key)?.actor.hover) this._show(key);
        });
    }

    open() {
        if (this._destroyed || this._open || Main.overview.visible) return;
        this._open = true;
        [...this._items.values()].forEach((item, index) => item.reset?.(index));
        Main.layoutManager.trackChrome(this.sheet, CHROME);
        this.sheet.show();
        this._place();
        this.lens.add_style_pseudo_class('checked');
        if (animations()) {
            // The bar grows down: the sheet unrolls from its top edge.
            this.sheet.set_pivot_point(0.5, 0);
            this.sheet.scale_y = 0;
            this.sheet.ease({scale_y: 1, duration: SHELF.open, mode: Clutter.AnimationMode.EASE_OUT_EXPO});
            this._content.opacity = 0;
            this._content.ease({opacity: 255, duration: SHELF.open, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this._animate();
    }

    close() {
        if (!this._open) return;
        this._open = false;
        this._keyboard = false;
        this._select(null);
        this.sheet.remove_all_transitions();
        this._content.remove_all_transitions();
        this.sheet.scale_y = 1;
        this.sheet.translation_y = 0;
        this._content.opacity = 255;
        this.sheet.hide();
        Main.layoutManager.untrackChrome(this.sheet);
        this.lens.remove_style_pseudo_class('checked');
        this._animate();
    }

    // Under the lens, centred on it and kept on its monitor.
    _place() {
        const monitor = Main.layoutManager.findMonitorForActor(this.lens) ?? Main.layoutManager.primaryMonitor;
        const [lx] = this.lens.get_transformed_position();
        const [, width] = this.sheet.get_preferred_width(-1);
        const centre = lx + this.lens.width / 2;
        const x = Math.round(Math.max(monitor.x + SHELF.sheetGap, Math.min(centre - width / 2, monitor.x + monitor.width - width - SHELF.sheetGap)));
        const y = Main.panel.get_transformed_position()[1] + Main.panel.height;
        this.sheet.set_position(x, Math.round(y));
    }

    // ---- selection ----

    // A click toggles; hover only shows.
    _select(key) { this._show(key === this._selected ? null : key); }

    _show(key) {
        if (key === this._selected) return;
        this._selected = key;
        for (const [itemKey, item] of this._items) item.setSelected(itemKey === key);
        this._showDetail(false);
    }

    _showDetail(refresh) {
        const cell = this._cells.find(candidate => candidate.key === this._selected);
        if (!cell || !this._open) {
            this.deck.hide();
            if (this.drop.visible) {
                this._dropPlaced = false;
                this.drop.remove_all_transitions();
                this.drop.hide();
                Main.layoutManager.untrackChrome(this.drop);
            }
            return;
        }
        const entering = !this.drop.visible;
        this.deck.show(cell, 'top');
        if (entering) {
            Main.layoutManager.trackChrome(this.drop, CHROME);
            this.drop.show();
        }
        this._placeDrop();
        if (!refresh && animations()) {
            // Drops down from the strip; between sources it glides across.
            this.drop.set_pivot_point(0.5, 0);
            if (entering) {
                this.drop.scale_y = 0.6;
                this.drop.opacity = 0;
                this.drop.ease({scale_y: 1, opacity: 255, duration: SHELF.open, mode: Clutter.AnimationMode.EASE_OUT_EXPO});
            } else {
                this._detail.opacity = 0;
                this._detail.ease({opacity: 255, duration: SHELF.open / 2, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
        }
    }

    // Under the hovered source, a small gap below the strip, kept on the monitor.
    _placeDrop() {
        const item = this._items.get(this._selected);
        if (!item) return;
        const monitor = Main.layoutManager.findMonitorForActor(this.lens) ?? Main.layoutManager.primaryMonitor;
        const [ix] = item.actor.get_transformed_position();
        const [, width] = this.drop.get_preferred_width(-1);
        const centre = ix + item.actor.width / 2;
        const x = Math.round(Math.max(monitor.x + SHELF.sheetGap, Math.min(centre - width / 2, monitor.x + monitor.width - width - SHELF.sheetGap)));
        const [, sy] = this.sheet.get_transformed_position();
        const y = Math.round(sy + this.sheet.height + SHELF.sheetGap);
        if (this.drop.visible && this._dropPlaced && animations()) this.drop.ease({x, y, duration: SHELF.open / 1.5, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        else this.drop.set_position(x, y);
        this._dropPlaced = true;
    }

    // ---- keyboard ----

    focusTargets() {
        return [...this._items.values()].map(item => item.actor).concat(this.deck.visible ? this.deck.focusTargets() : []);
    }

    key(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Escape) {
            this.close();
            global.stage.set_key_focus(null);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab) {
            const targets = this.focusTargets();
            const index = targets.findIndex(target => holds(target, global.stage.get_key_focus()));
            const step = symbol === Clutter.KEY_Tab ? 1 : -1;
            targets[(index + step + targets.length) % targets.length]?.grab_key_focus();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    toggle() {
        if (this._open) { this.close(); return; }
        this.open();
        this._keyboard = true;
        this.focusTargets()[0]?.grab_key_focus();
    }

    // A session alert: open for `seconds` unless the pointer is already here.
    peek(_key, seconds) {
        if (this._open) return;
        this.open();
        if (this._peek) GLib.Source.remove(this._peek);
        this._peek = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._peek = 0;
            if (!this.lens.hover && !this.sheet.hover && !this._keyboard) this.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    settingsChanged() {}

    applyTheme() {
        const theme = this.host.theme();
        this._inkCache = null;
        setGlass(this.sheet, null, null);
        this.lens.set_style(`border-radius: ${SHELF.lensRadius}px; padding: ${SHELF.lensMargin}px ${SHELF.lensMargin * 2}px;`);
        this._glass.queue_repaint();
        for (const item of this._items.values()) item.repaint();
        this.deck.applyTheme();
        if (this._selected) this._showDetail(true);
        this._updateLens();
    }

    canvases() { return [this._trace, this._glass, ...[...this._items.values()].flatMap(item => item.canvases())]; }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        for (const name of ['_intent', '_grace', '_peek', '_itemIntent']) if (this[name]) GLib.Source.remove(this[name]);
        if (this.drop.visible) Main.layoutManager.untrackChrome(this.drop);
        this._timeline?.stop();
        this._timeline = null;
        Main.overview.disconnect(this._overviewSignal);
        if (this._open) Main.layoutManager.untrackChrome(this.sheet);
        this._layer.destroy();
        this._spacer?.destroy();
        this.lens.destroy();
        this._items.clear();
    }
}

// A source as a dial of dots with its icon inside, its figure in dot matrix
// beside it, and its name and reset below. Opening switches the dots on
// around the dial; a working session sends a red dot round it; a low or
// waiting source turns red.
class Gauge {
    constructor(shelf, key, id) {
        this.shelf = shelf;
        this.key = key;
        this.id = id;
        this.info = null;
        this._start = 0;
        // The mark in its dial, the percentage small underneath.
        const side = SHELF.dial.size + SHELF.dial.dot * 2;
        this._canvas = canvas((cr, w, h) => this._draw(cr, w, h), {width: side, height: side, x_expand: false, y_expand: false,
            y_align: Clutter.ActorAlign.CENTER});
        this._value = new St.Label({style_class: 'ledge-shelf-tag', y_align: Clutter.ActorAlign.CENTER});
        const column = box(false, {style: `spacing: ${SHELF.cellGap * 2}px;`});
        column.add_child(this._canvas);
        column.add_child(this._value);
        this.actor = new St.Button({style_class: 'ledge-shelf-item', child: column, can_focus: true, track_hover: true, reactive: true});
        this.actor.connect('clicked', () => shelf._select(key));
        this.actor.connect('notify::hover', () => shelf._itemHover(key, this.actor.hover));
        this.actor.connect('key-press-event', (_a, event) => shelf.key(event));
    }

    update(info) {
        this.info = info;
        this.actor.accessible_name = info.accessibleName;
        if (info.caption) this.actor.accessible_name = `${info.accessibleName}, resets in ${info.caption}`;
        this._value.text = String(info.label ?? '—').toUpperCase();
        const ink = this.shelf.ink();
        this._value.set_style(`color: ${this._alert() ? ink.red : ink.lit};`);
        this._canvas.queue_repaint();
    }

    reset(index = 0) { this._start = GLib.get_monotonic_time() / 1000 + index * SHELF.stagger; }
    _reveal() { return animations() ? Math.max(0, Math.min(1, (GLib.get_monotonic_time() / 1000 - this._start) / SHELF.reveal)) : 1; }
    moving() { return this._reveal() < 1 || this.info?.light === 'working'; }
    step() { this._canvas.queue_repaint(); }

    _alert() {
        const info = this.info ?? {};
        return info.light === 'waiting' || info.light === 'failed' || (typeof info.fraction === 'number' && info.fraction < SHELF.low);
    }

    _draw(cr, w, h) {
        const ink = this.shelf.ink();
        const info = this.info ?? {};
        const reveal = this._reveal();
        const color = this._alert() ? ink.red : ink.lit;
        const [cx, cy] = [w / 2, h / 2];
        const orbit = info.light === 'working' && animations() ? (this.shelf._phase / SHELF.tube.speed * 1000 / SHELF.scan) % 1 : null;
        drawDial(cr, cx, cy, SHELF.dial.size / 2, SHELF.dial.dots, SHELF.dial.dot, info.fraction, color, ink.off, reveal, orbit, ink.red);
        const mark = info.light === 'waiting' ? ink.red : ink.lit;
        const dots = logoDots(this.id);
        if (dots.length) {
            const [r, g, b] = [1, 3, 5].map(i => parseInt(mark.slice(i, i + 2), 16) / 255);
            for (const [x, y] of dots) {
                cr.newSubPath();
                cr.arc(cx + x * SHELF.logoRadius, cy + y * SHELF.logoRadius, SHELF.logoDot / 2, 0, 2 * Math.PI);
            }
            cr.setSourceRGBA(r, g, b, 1);
            cr.fill();
        } else {
            const icon = DOT_ICONS[this.id] ?? DOT_ICONS.models;
            const size = 7 * (SHELF.iconDot + SHELF.iconGap) - SHELF.iconGap;
            drawDotIcon(cr, icon, Math.round(cx - size / 2), Math.round(cy - size / 2), SHELF.iconDot, SHELF.iconGap, mark);
        }
    }

    setSelected(selected) {
        if (selected) this.actor.add_style_pseudo_class('checked');
        else this.actor.remove_style_pseudo_class('checked');
    }

    repaint() { if (this.info) this.update(this.info); }
    canvases() { return [this._canvas]; }
}

// Any other source as a stat: its dot icon, the value, then its name; a
// light shows its state.
class Stat {
    constructor(shelf, key, id) {
        this.shelf = shelf;
        this.key = key;
        this.id = id;
        this.info = null;
        const iconSize = 7 * (SHELF.iconDot + SHELF.iconGap) - SHELF.iconGap;
        this._icon = canvas((cr, w, h) => {
            const ink = this.shelf.ink();
            const alert = this.info?.light === 'waiting' || this.info?.light === 'failed';
            drawDotIcon(cr, DOT_ICONS[this.id] ?? DOT_ICONS.models, 0, 0, SHELF.iconDot, SHELF.iconGap, alert ? ink.red : ink.lit);
        }, {width: iconSize, height: iconSize, x_expand: false, y_expand: false});
        this._icon.x_align = Clutter.ActorAlign.CENTER;
        this._light = light();
        this._value = new St.Label({style_class: 'ledge-shelf-tag', y_align: Clutter.ActorAlign.CENTER});
        // Same build as a dial: the mark, the value small beside it.
        const top = new St.Widget({layout_manager: new Clutter.BinLayout(), height: SHELF.dial.size + SHELF.dial.dot * 2});
        top.add_child(this._icon);
        this._icon.y_align = Clutter.ActorAlign.CENTER;
        this._light.x_align = Clutter.ActorAlign.END;
        this._light.y_align = Clutter.ActorAlign.START;
        top.add_child(this._light);
        const line = box(false, {style: `spacing: ${SHELF.cellGap * 2}px;`});
        line.add_child(top);
        line.add_child(this._value);
        this.actor = new St.Button({style_class: 'ledge-shelf-item', child: line, can_focus: true, track_hover: true, reactive: true});
        this.actor.connect('clicked', () => shelf._select(key));
        this.actor.connect('notify::hover', () => shelf._itemHover(key, this.actor.hover));
        this.actor.connect('key-press-event', (_a, event) => shelf.key(event));
    }

    update(info) {
        this.info = info;
        const ink = this.shelf.ink();
        this._value.text = String(info.label ?? '—').toUpperCase();
        this._value.set_style(`color: ${ink.lit};`);
        this.actor.accessible_name = info.accessibleName;
        setLight(this._light, info.light, info.light === 'off' ? ink.off : info.light === 'working' ? ink.lit : ink.red);
        this._icon.queue_repaint();
    }

    setSelected(selected) {
        if (selected) this.actor.add_style_pseudo_class('checked');
        else this.actor.remove_style_pseudo_class('checked');
    }

    repaint() { this._light._ledgeLight = ''; if (this.info) this.update(this.info); }
    canvases() { return [this._icon]; }
}
