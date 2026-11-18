import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {CHIP, SHELF, roundedRects, urgency} from '../design.js';
import {drawBadge, drawGlass, drawTrace, drawTube} from '../draw.js';
import {cssColor, railPalette} from '../themes.js';
import {setGlass} from './glass.js';
import {Deck} from './deck.js';
import {animations, box, canvas, holds, light, lightColor, setLight} from './ui.js';

const CHROME = {affectsStruts: false, trackFullscreen: true};
// Sources drawn as tubes; every other cell is a row in the side list.
const TUBES = new Set(['claude', 'cursor', 'codex', 'copilot', 'models']);
// Short names under the tubes.
const SHORT = {claude: 'claude', cursor: 'cursor', codex: 'codex', copilot: 'copilot', models: 'models'};
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
        this._glass = canvas((cr, w, h) => {
            const t = this.host.theme();
            drawGlass(cr, w, h, SHELF.radius, t.deck, t.glass ? 0 : SHELF.tint, SHELF.sheen, SHELF.rim);
        });
        this._content = box(true, {style: `padding: ${SHELF.padding}px; spacing: ${SHELF.gap}px;`});
        this._top = box(false, {style: `spacing: ${SHELF.gap}px;`});
        this._tubes = box(false, {style: `spacing: ${SHELF.gap / 4}px;`});
        this._list = box(true, {width: SHELF.statWidth, style: `spacing: ${SHELF.gap / 4}px;`, y_align: Clutter.ActorAlign.CENTER});
        this._top.add_child(this._tubes);
        this._top.add_child(this._list);
        this._detail = box(true, {style: `spacing: ${SHELF.gap}px;`, visible: false});
        this._rule = new St.Widget({style_class: 'ledge-hairline', height: 1, x_expand: true});
        this.deck = new Deck({theme: host.theme, openPreferences: host.openPreferences, key: event => this.key(event),
            frameless: true, width: SHELF.detailWidth});
        this._detail.add_child(this._rule);
        this._detail.add_child(this.deck.actor);
        this._content.add_child(this._top);
        this._content.add_child(this._detail);
        this.sheet.add_child(this._glass);
        this.sheet.add_child(this._content);
        this.sheet.connect('notify::hover', () => this._hover());
        this.sheet.connect('key-press-event', (_a, event) => this.key(event));
        // A plain layer, as for the edge deck: the sheet joins chrome only while open.
        this._layer = new Clutter.Actor();
        Main.uiGroup.add_child(this._layer);
        this._layer.add_child(this.sheet);

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

    _build() {
        this._tubes.destroy_all_children();
        this._list.destroy_all_children();
        this._items.clear();
        for (const cell of this._cells) {
            const item = TUBES.has(cell.module.id) ? new Tube(this, cell.key) : new Row(this, cell.key);
            (item instanceof Tube ? this._tubes : this._list).add_child(item.actor);
            this._items.set(cell.key, item);
        }
        this._list.visible = this._list.get_n_children() > 0;
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
        const inside = this.lens.hover || this.sheet.hover;
        for (const name of ['_intent', '_grace']) if (this[name]) { GLib.Source.remove(this[name]); this[name] = 0; }
        if (inside && !this._open) this._intent = once(SHELF.intent, () => { this._intent = 0; if (this.lens.hover || this.sheet.hover) this.open(); });
        if (!inside && this._open) {
            this._grace = once(SHELF.grace, () => {
                this._grace = 0;
                const typing = holds(this.sheet, global.stage.get_key_focus());
                if (!this.lens.hover && !this.sheet.hover && !typing && !this._keyboard) this.close();
            });
        }
    }

    open() {
        if (this._destroyed || this._open || Main.overview.visible) return;
        this._open = true;
        for (const item of this._items.values()) item.reset?.();
        Main.layoutManager.trackChrome(this.sheet, CHROME);
        this.sheet.show();
        this._place();
        this.lens.add_style_pseudo_class('checked');
        if (animations()) {
            this.sheet.set_pivot_point(0.5, 0);
            this.sheet.scale_y = 0.86;
            this.sheet.translation_y = -SHELF.sheetGap * 2;
            this.sheet.ease({scale_y: 1, translation_y: 0, duration: SHELF.open, mode: Clutter.AnimationMode.EASE_OUT_BACK});
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
        const y = Main.panel.get_transformed_position()[1] + Main.panel.height + SHELF.sheetGap;
        this.sheet.set_position(x, Math.round(y));
    }

    // ---- selection ----

    _select(key) {
        if (key === this._selected) key = null;
        this._selected = key;
        for (const [itemKey, item] of this._items) item.setSelected(itemKey === key);
        this._showDetail(false);
    }

    _showDetail(refresh) {
        const cell = this._cells.find(candidate => candidate.key === this._selected);
        if (!cell) {
            this.deck.hide();
            this._detail.visible = false;
            if (this._open) this._place();
            return;
        }
        this._detail.visible = true;
        this.deck.show(cell, 'top');
        if (this._open) this._place();
        if (!refresh && animations()) {
            this._detail.opacity = 0;
            this._detail.translation_y = -SHELF.gap / 2;
            this._detail.ease({opacity: 255, translation_y: 0, duration: SHELF.open, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        }
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
        setGlass(this.sheet, (w, h) => roundedRects(w, h, SHELF.radius), theme.glassParams ?? {radius: SHELF.blur, brightness: SHELF.brightness});
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
        for (const name of ['_intent', '_grace', '_peek']) if (this[name]) GLib.Source.remove(this[name]);
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

// A source as a glass tube: liquid at its level, a ripple while working,
// the figure below, then its monogram.
class Tube {
    constructor(shelf, key) {
        this.shelf = shelf;
        this.key = key;
        this.info = null;
        this._shown = 0;
        this._tube = canvas((cr, w, h) => this._draw(cr, w, h), {width: SHELF.tube.width, height: SHELF.tube.height,
            x_expand: false, y_expand: false, x_align: Clutter.ActorAlign.CENTER});
        this._figure = new St.Label({style_class: 'ledge-shelf-figure', x_align: Clutter.ActorAlign.CENTER});
        this._tag = new St.Label({style_class: 'ledge-shelf-tag', x_align: Clutter.ActorAlign.CENTER});
        const column = box(true, {style: `spacing: ${SHELF.gap / 2}px;`});
        column.add_child(this._tube);
        column.add_child(this._figure);
        column.add_child(this._tag);
        this.actor = new St.Button({style_class: 'ledge-shelf-item', child: column, width: SHELF.tubeColumn,
            can_focus: true, track_hover: true, reactive: true});
        this.actor.connect('clicked', () => shelf._select(key));
        this.actor.connect('key-press-event', (_a, event) => shelf.key(event));
    }

    _target() { return typeof this.info?.fraction === 'number' ? this.info.fraction : 0; }

    update(info) {
        this.info = info;
        const theme = this.shelf.host.theme();
        this.actor.accessible_name = info.accessibleName;
        const [id, account] = this.key.split(':');
        this._tag.text = account ? `${SHORT[id] ?? id} ${account}` : SHORT[id] ?? id;
        this._tag.set_style(`color: ${cssColor(theme.accentText(info.accent, 'deck'))};`);
        this._figureText();
        this._tube.queue_repaint();
    }

    _figureText() {
        // While filling, a percentage counts up with the liquid.
        const counting = this.info?.label?.endsWith('%') && this.moving() && typeof this.info.fraction === 'number';
        const text = counting ? `${Math.round(this._shown * 100)}%` : this.info?.label ?? '—';
        if (this._figure.text !== text) this._figure.text = text;
    }

    reset() { this._shown = animations() ? 0 : this._target(); }
    moving() { return Math.abs(this._shown - this._target()) > 0.002 || this.info?.light === 'working'; }

    step(dt) {
        const target = this._target();
        this._shown += (target - this._shown) * Math.min(1, dt * SHELF.fill);
        if (Math.abs(target - this._shown) < 0.002) this._shown = target;
        this._figureText();
        this._tube.queue_repaint();
    }

    _draw(cr, w, h) {
        const theme = this.shelf.host.theme();
        const info = this.info ?? {};
        const working = info.light === 'working';
        const amplitude = !animations() ? 0 : working ? SHELF.tube.wave : SHELF.tube.still;
        drawTube(cr, w, h, this._shown, this.shelf._phase * (working ? 1 : 0.4), amplitude, SHELF.tube.waveLength,
            theme.accent(info.accent ?? 'textPrimary', 'deck'), theme.meterOff, info.stale);
        // Waiting or failed shows as a small light on the tube's cap.
        if (info.light === 'waiting' || info.light === 'failed') {
            const color = lightColor(info.light, theme.accent(info.accent, 'deck'), railPalette(theme));
            const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255);
            cr.arc(w / 2, w / 2, 3, 0, 2 * Math.PI);
            cr.setSourceRGBA(r, g, b, 1);
            cr.fill();
        }
    }

    setSelected(selected) {
        if (selected) this.actor.add_style_pseudo_class('checked');
        else this.actor.remove_style_pseudo_class('checked');
    }

    repaint() { if (this.info) this.update(this.info); }
    canvases() { return [this._tube]; }
}

// Any other source as a row: badge, name, value and its light.
class Row {
    constructor(shelf, key) {
        this.shelf = shelf;
        this.key = key;
        this.info = null;
        this._badge = new St.Bin({width: CHIP.badge, height: CHIP.badge, y_align: Clutter.ActorAlign.CENTER});
        this._name = new St.Label({style_class: 'ledge-shelf-name', y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._value = new St.Label({style_class: 'ledge-shelf-value', y_align: Clutter.ActorAlign.CENTER});
        this._light = light();
        const line = box(false, {style: `spacing: ${SHELF.gap / 2}px;`, height: SHELF.statHeight, x_expand: true});
        for (const child of [this._badge, this._name, this._value, this._light]) line.add_child(child);
        this.actor = new St.Button({style_class: 'ledge-shelf-item ledge-shelf-row', child: line, x_expand: true, x_align: Clutter.ActorAlign.FILL,
            can_focus: true, track_hover: true, reactive: true});
        this.actor.connect('clicked', () => shelf._select(key));
        this.actor.connect('key-press-event', (_a, event) => shelf.key(event));
    }

    update(info) {
        this.info = info;
        const theme = this.shelf.host.theme();
        const cell = this.shelf._cells.find(candidate => candidate.key === this.key);
        this._name.text = cell?.module.heading(this.key) ?? this.key;
        this._value.text = info.label ?? '—';
        this.actor.accessible_name = info.accessibleName;
        const letters = theme.accentText(info.accent, 'deck');
        const lead = `${info.badge} ${letters}`;
        if (lead !== this._lead) {
            this._lead = lead;
            this._badge.set_child(canvas(cr => drawBadge(cr, CHIP.badge, info.badge ?? '', letters), {width: CHIP.badge, height: CHIP.badge}));
        }
        setLight(this._light, info.light, lightColor(info.light, theme.accent(info.accent, 'deck'), railPalette(theme)));
    }

    setSelected(selected) {
        if (selected) this.actor.add_style_pseudo_class('checked');
        else this.actor.remove_style_pseudo_class('checked');
    }

    repaint() { this._lead = ''; this._light._ledgeLight = ''; if (this.info) this.update(this.info); }
    canvases() { return []; }
}
