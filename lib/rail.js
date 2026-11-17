import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {position} from '../model.js';
import {CHAMFER, CHIP, DECK, MOTION, RAIL, SPACE, TICK, LIGHT, railSize, deckSpan, unfoldFrame, unfoldDuration, foldFrame, foldDuration,
    chamferRects, urgency} from '../design.js';
import {drawPanel} from '../draw.js';
import {rgba, toHex, railPalette} from '../themes.js';
import {Strip} from './strip.js';
import {Deck} from './deck.js';
import {setGlass} from './glass.js';
import {animations, canvas, holds, light, lightColor, setLight} from './ui.js';

const CHROME = {affectsStruts: false, trackFullscreen: true};

// The chip corner that faces away from each screen edge, the one that is cut.
const CHIP_CORNER = {right: 'tl', left: 'tr', top: 'bl', bottom: 'tl'};

const once = (ms, callback) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    callback();
    return GLib.SOURCE_REMOVE;
});

// Edge placement. At rest a tick sits flush with the screen edge; resting the
// pointer on it unfolds the rail of chips, and a chip opens the deck beside it.
// host: {settings, theme(), cells(), openPreferences()}
export class Rail {
    constructor(host) {
        this.host = host;
        this._settings = host.settings;
        this._expanded = this._settings.get_boolean('always-show');
        this._length = this._depth = this._expanded ? 1 : 0;
        this._motion = new Map();   // chip key -> {enter, power}
        this._ignoreHover = false;
        this._keyboardOpen = false;
        this._deckMounted = false;

        this.strip = new Strip({vertical: this._vertical(), height: CHIP.railHeight, palette: () => railPalette(host.theme()),
            corner: CHIP_CORNER[this._edge()],
            handlers: {
                hover: key => { if (!this._overview()) this.open(key); },
                focus: key => { if (!this._overview()) this.open(key); },
                activate: key => {
                    if (this._overview()) return;
                    this.open(key);
                    if (this.deck.autofocus?.get_stage()) this.deck.autofocus.grab_key_focus();
                },
                key: event => this.key(event),
            }});
        this.deck = new Deck({theme: host.theme, openPreferences: host.openPreferences, key: event => this.key(event)});

        this.actor = new St.Widget({reactive: true, track_hover: true, clip_to_allocation: true});
        this._background = canvas((cr, w, h) => this._draw(cr, w, h));
        this.actor.add_child(this._background);
        this.actor.add_child(this.strip.actor);
        // The hot zone reaches a little past the tick and carries its light.
        this.sensor = new St.Widget({reactive: true, track_hover: true});
        this._tickLight = light();
        this.sensor.add_child(this._tickLight);
        Main.layoutManager.addChrome(this.sensor, CHROME);
        Main.layoutManager.addChrome(this.actor, CHROME);
        // The hidden deck lives on stage from the start, so it always has a
        // theme; it becomes tracked chrome only while it is open. A plain
        // layer holds it: St parents remember their last visible child for
        // styling and would touch a deck destroyed in the frame it opened.
        this._deckLayer = new Clutter.Actor();
        Main.uiGroup.add_child(this._deckLayer);
        this._deckLayer.add_child(this.deck.actor);

        for (const actor of [this.sensor, this.actor, this.deck.actor]) actor.connect('notify::hover', () => this._hover());
        this.actor.connect('key-press-event', (_a, event) => this.key(event));
        this.deck.actor.connect('notify::allocation', () => this._placeDeck());

        this._signals = [
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._place())],
            [global.display, global.display.connect('workareas-changed', () => {
                this._place();
                this._later(() => { if (this._overview()) this.close(); });
            })],
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', () => {
                this._keyboardOpen = false;
                this.close();
                this._hover();
            })],
            // Typing in a deck holds the rail open; focus moving elsewhere releases it.
            [global.stage, global.stage.connect('notify::key-focus', () => {
                if (this.deck.visible && !holds(this.deck.actor, global.stage.get_key_focus())) this._hover();
            })],
            [Main.overview, Main.overview.connect('showing', () => this._overviewShowing())],
            [Main.overview, Main.overview.connect('hiding', () => this.close())],
            [Main.overview, Main.overview.connect('hidden', () => { this._ignoreHover = false; this._place(); })],
        ];
        if (Main.overview.visibleTarget) this._overviewShowing();
        this.applyTheme();
    }

    _edge() { return this._settings.get_string('edge'); }
    _vertical() { const edge = this._edge(); return edge === 'left' || edge === 'right'; }

    _overview() {
        const overview = Main.overview;
        return this._ignoreHover || ((Main.actionMode ?? 0) & Shell.ActionMode.OVERVIEW) !== 0
            || overview.visible || overview.visibleTarget || overview.animationInProgress;
    }

    _later(callback) {
        if (this._idle) GLib.Source.remove(this._idle);
        this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idle = 0;
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- drawing and layout ----

    _draw(cr, width, height) {
        const theme = this.host.theme();
        const [r, g, b, a] = rgba(theme.rail);
        // The tick is slightly translucent; the rail has the theme's own alpha.
        const fill = toHex([r, g, b, a * (TICK.alpha + (1 - TICK.alpha) * Math.min(1, this._depth))]);
        const chip = this.deck.visible ? this.strip.chips.get(this.deck.key) : null;
        let mark = null;
        if (chip) {
            const vertical = this._vertical();
            const at = vertical ? this.strip.actor.y + chip.actor.y + chip.actor.height / 2
                : this.strip.actor.x + chip.actor.x + chip.actor.width / 2;
            mark = {color: theme.accent(chip.info.accent, 'rail'), at, length: DECK.bracket};
        }
        drawPanel(cr, this._edge(), width, height, CHAMFER.large, fill, theme.border, {mark});
    }

    _size() {
        const full = railSize(this.strip.chips.size, this._vertical());
        const length = Math.round(TICK.length + (full.length - TICK.length) * this._length);
        const depth = Math.round(TICK.thickness + (full.depth - TICK.thickness) * this._depth);
        return this._vertical() ? {width: depth, height: length, full} : {width: length, height: depth, full};
    }

    // Applies the current motion state to the actors.
    _apply() {
        const edge = this._edge();
        const vertical = this._vertical();
        const {width, height, full} = this._size();
        this.actor.set_size(width, height);
        this._background.set_size(width, height);
        this._background.queue_repaint();
        // Chips keep their full layout, anchored to the edge and centred
        // along it, while the outline grows over them.
        const along = Math.round(((vertical ? height : width) - full.length) / 2) + RAIL.endPadding;
        const across = edge === 'right' || edge === 'bottom' ? (vertical ? width : height) - full.depth + RAIL.padding : RAIL.padding;
        this.strip.actor.set_position(vertical ? across : along, vertical ? along : across);
        this.strip.actor.visible = this._length > 0.001;
        const interactive = this._expanded && this._length > 0.6;
        for (const [key, chip] of this.strip.chips) {
            const motion = this._motion.get(key) ?? {enter: this._length, power: this._length};
            chip.setMotion(motion.enter, motion.power, edge);
            chip.actor.reactive = interactive;
            chip.actor.can_focus = this._expanded;
        }
        this._tickLight.visible = this._length < 0.5;
        this._place();
    }

    _area() {
        const requested = this._settings.get_int('monitor');
        const monitors = Main.layoutManager.monitors;
        const index = requested >= 0 && requested < monitors.length ? requested : Main.layoutManager.primaryIndex;
        return index < 0 ? null : Main.layoutManager.getWorkAreaForMonitor(index);
    }

    _place() {
        if (this._overview()) this.close();
        const area = this._area();
        if (!area) return;
        const edge = this._edge();
        const vertical = this._vertical();
        const spot = position(edge, area, this.actor.width, this.actor.height);
        this.actor.set_position(spot.x, spot.y);
        const reach = TICK.thickness + TICK.hotZone;
        const sensor = vertical ? {width: reach, height: TICK.length} : {width: TICK.length, height: reach};
        const sensorSpot = position(edge, area, sensor.width, sensor.height);
        this.sensor.set_size(sensor.width, sensor.height);
        this.sensor.set_position(sensorSpot.x, sensorSpot.y);
        // The light sits on the middle of the tick, flush with the edge, in
        // a ring of the rail color: a bead mounted on the bar.
        const size = LIGHT.size + 2;
        const along = (TICK.length - size) / 2;
        const flush = edge === 'right' || edge === 'bottom' ? reach - size : 0;
        this._tickLight.set_size(size, size);
        this._tickLight.set_position(vertical ? flush : along, vertical ? along : flush);
        this._placeDeck();
    }

    // ---- fold and unfold ----

    _setExpanded(expanded) {
        if (expanded === this._expanded) return;
        this._expanded = expanded;
        this._animate();
    }

    _animate() {
        this._timeline?.stop();
        this._timeline = null;
        const open = this._expanded;
        const keys = this.strip.keys();
        const settle = () => {
            this._length = this._depth = open ? 1 : 0;
            // A folded rail forgets its power-on, so the next unfold plays it again.
            for (const key of keys) this._motion.set(key, {enter: open ? 1 : 0, power: open ? 1 : 0});
            this._apply();
        };
        if (!animations() || this._overview() || !this.actor.mapped) {
            settle();
            return;
        }
        const from = {length: this._length, depth: this._depth, chips: new Map(this._motion)};
        const duration = open ? unfoldDuration(keys.length) : foldDuration();
        const timeline = this._timeline = new Clutter.Timeline({actor: this.actor, duration});
        timeline.connect('new-frame', (_t, ms) => {
            if (open) {
                const frame = unfoldFrame(ms, keys.length);
                this._length = from.length + (1 - from.length) * frame.length;
                this._depth = from.depth + (1 - from.depth) * frame.depth;
                keys.forEach((key, i) => {
                    const start = from.chips.get(key) ?? {enter: 0, power: 0};
                    this._motion.set(key, {enter: start.enter + (1 - start.enter) * frame.chips[i].enter,
                        power: start.power + (1 - start.power) * frame.chips[i].power});
                });
            } else {
                const frame = foldFrame(ms);
                this._length = from.length * (1 - frame.length);
                this._depth = from.depth * (1 - frame.depth);
                for (const key of keys) {
                    const start = from.chips.get(key) ?? {enter: 0, power: 0};
                    this._motion.set(key, {enter: start.enter * (1 - frame.chips), power: start.power});
                }
            }
            this._apply();
        });
        timeline.connect('completed', () => {
            if (this._timeline !== timeline) return;
            this._timeline = null;
            settle();
        });
        timeline.start();
    }

    _clearTimers() {
        for (const name of ['_intent', '_grace', '_peek']) {
            if (this[name]) GLib.Source.remove(this[name]);
            this[name] = 0;
        }
    }

    _inside() { return this.sensor.hover || this.actor.hover || this.deck.actor.hover; }

    _hover() {
        if (this._destroyed) return;
        if (this._overview()) { this.close(); return; }
        const inside = this._inside();
        if (this._grace) GLib.Source.remove(this._grace);
        this._grace = 0;
        if (inside) {
            // A pointer that only crosses the edge leaves before this fires.
            if (!this._expanded && !this._intent) {
                this._intent = once(MOTION.hoverIntent, () => {
                    this._intent = 0;
                    if (this._inside() && !this._overview()) this._setExpanded(true);
                });
            }
            return;
        }
        if (this._intent) GLib.Source.remove(this._intent);
        this._intent = 0;
        this._grace = once(MOTION.foldGrace, () => {
            this._grace = 0;
            const typing = this.deck.visible && holds(this.deck.actor, global.stage.get_key_focus());
            if (this._keyboardOpen || typing || this._inside()) return;
            this.close(true);
            this._setExpanded(this._settings.get_boolean('always-show'));
        });
    }

    // ---- deck ----

    _mountDeck() {
        if (this._deckMounted) return;
        Main.layoutManager.trackChrome(this.deck.actor, CHROME);
        this._deckMounted = true;
    }

    open(key, refresh = false) {
        const cell = this.host.cells().find(candidate => candidate.key === key);
        if (this._overview() || !cell) { this.close(); return; }
        if (this.deck.visible && this.deck.key === key && !refresh && !this._closing) return;
        this._closing = false;
        if (!this.deck.visible) this._deckPlaced = false;
        this._mountDeck();
        this.deck.show(cell, this._edge());
        this.strip.setOpen(key);
        this._background.queue_repaint();
        this._placeDeck();
    }

    // Closes the deck. With `fade` its content fades first; a dismissal by
    // the shell (Overview, workspace switch, Escape) is immediate.
    close(fade = false) {
        if (fade && this.deck.visible && animations() && !this._closing) {
            this._closing = true;
            this.deck.fadeOut(MOTION.deckClose, () => { if (this._closing) this.close(); });
            return;
        }
        this._closing = false;
        const wasOpen = this.deck.visible;
        this.deck.hide();
        this._deckPlaced = false;
        this.strip.setOpen(null);
        if (wasOpen) this._background.queue_repaint();
        // Shell may show tracked chrome again on workspace or fullscreen
        // changes. A dismissed deck must leave chrome, not merely hide; the
        // hidden root stays on stage so pending allocations keep a theme.
        if (this._deckMounted) {
            this._deckMounted = false;
            Main.layoutManager.untrackChrome(this.deck.actor);
        }
    }

    _placeDeck() {
        if (this._destroyed) return;
        if (this._overview()) { this.close(); return; }
        if (!this.deck.visible) return;
        const area = this._area();
        const chip = this.strip.chips.get(this.deck.key);
        if (!area || !chip) return;
        const edge = this._edge();
        const rail = this.actor;
        const deck = this.deck.actor;
        const height = deck.get_preferred_height(DECK.width)[1];
        const [chipX, chipY] = chip.actor.get_transformed_position();
        const vertical = this._vertical();
        // Flush against the rail. Along the rail, centred on the open chip
        // but kept within the rail's span, so it never overhangs an end while
        // it fits; a deck longer than the rail starts where the rail starts.
        const span = deckSpan(vertical ? rail.y : rail.x, vertical ? rail.height : rail.width,
            vertical ? chipY + chip.actor.height / 2 : chipX + chip.actor.width / 2, vertical ? height : DECK.width);
        let x = edge === 'right' ? rail.x - DECK.width : edge === 'left' ? rail.x + rail.width : span;
        let y = edge === 'top' ? rail.y + rail.height : edge === 'bottom' ? rail.y - height : span;
        // Chips rebuilt this frame have no position yet; the deck's own
        // allocation signal places it again once layout has run.
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        x = Math.round(Math.max(area.x, Math.min(x, area.x + area.width - DECK.width)));
        y = Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height)));
        // The accent rule runs only where the deck touches the rail's straight side.
        const along = vertical ? y : x;
        const start = Math.max(0, (vertical ? rail.y : rail.x) + CHAMFER.large - along);
        const end = Math.min(vertical ? height : DECK.width, (vertical ? rail.y + rail.height : rail.x + rail.width) - CHAMFER.large - along);
        this.deck.setRule(start, Math.max(0, end - start));
        if (x === deck.x && y === deck.y && this._deckPlaced) return;
        const moving = animations();
        const entering = !this._deckPlaced;
        const oldX = deck.x + deck.translation_x, oldY = deck.y + deck.translation_y;
        deck.remove_all_transitions();
        deck.set_position(x, y);
        // Entering slides out of the rail; switching glides from the last chip.
        const slide = {right: [MOTION.deckSlide, 0], left: [-MOTION.deckSlide, 0], top: [0, -MOTION.deckSlide], bottom: [0, MOTION.deckSlide]}[edge];
        deck.translation_x = !moving ? 0 : entering ? slide[0] : oldX - x;
        deck.translation_y = !moving ? 0 : entering ? slide[1] : oldY - y;
        this._deckPlaced = true;
        if (moving) {
            deck.ease({translation_x: 0, translation_y: 0, duration: entering ? MOTION.deckOpen : MOTION.deckGlide,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        }
    }

    // ---- keyboard ----

    focusTargets() {
        const chips = [...this.strip.chips.values()].map(chip => chip.actor).filter(actor => actor.can_focus);
        return [...chips, ...this.deck.focusTargets()];
    }

    key(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab) {
            const targets = this.focusTargets();
            if (targets.length) {
                const focus = global.stage.get_key_focus();
                const current = targets.findIndex(target => holds(target, focus));
                const backwards = symbol === Clutter.KEY_ISO_Left_Tab || Boolean(event.get_state() & Clutter.ModifierType.SHIFT_MASK);
                targets[(current + (backwards ? -1 : 1) + targets.length) % targets.length].grab_key_focus();
            }
            return Clutter.EVENT_STOP;
        }
        if (symbol !== Clutter.KEY_Escape) return Clutter.EVENT_PROPAGATE;
        this._keyboardOpen = false;
        this.close();
        this._setExpanded(this._settings.get_boolean('always-show'));
        global.stage.set_key_focus(null);
        return Clutter.EVENT_STOP;
    }

    // Unfolds the folded rail for `seconds` to show a session's new state.
    // A pointer or keyboard already on the rail keeps it as it is.
    peek(_key, seconds) {
        if (this._destroyed || this._expanded || this._overview()) return;
        this._setExpanded(true);
        if (this._peek) GLib.Source.remove(this._peek);
        this._peek = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._peek = 0;
            if (!this._keyboardOpen && !this._inside() && !this.deck.visible)
                this._setExpanded(this._settings.get_boolean('always-show'));
            return GLib.SOURCE_REMOVE;
        });
    }

    // The keyboard shortcut: unfold and focus the first chip, or fold.
    toggle() {
        if (this._overview()) return;
        this._keyboardOpen = !this._keyboardOpen;
        this._setExpanded(this._keyboardOpen || this._settings.get_boolean('always-show'));
        this._apply();
        if (this._keyboardOpen) this.focusTargets()[0]?.grab_key_focus();
        else this.close();
    }

    _overviewShowing() {
        this._ignoreHover = true;
        this._keyboardOpen = false;
        this.close();
        this._clearTimers();
        // Settle a transient unfold before Overview starts moving windows.
        this._expanded = this._settings.get_boolean('always-show');
        this._animate();
        const focus = global.stage.get_key_focus();
        if (holds(this.actor, focus) || holds(this.deck.actor, focus)) global.stage.set_key_focus(null);
    }

    // ---- host interface ----

    // cells: [{key, module, info}]; changed: keys whose module pushed an update.
    update(cells, changed = new Set()) {
        const before = this.strip.keys().join('\n');
        this.strip.update(cells);
        for (const key of this._motion.keys()) if (!this.strip.chips.has(key)) this._motion.delete(key);
        const state = urgency(cells.map(cell => cell.info.light));
        const lead = cells.find(cell => cell.info.light === state);
        const theme = this.host.theme();
        setLight(this._tickLight, state, lightColor(state, lead ? theme.accent(lead.info.accent, 'rail') : theme.led, railPalette(theme)));
        if (this.strip.keys().join('\n') !== before) this._apply();
        if (!this.deck.visible) return;
        if (!this.strip.chips.has(this.deck.key)) this.close();
        else if (changed.has(this.deck.key)) this.open(this.deck.key, true);
    }

    settingsChanged() {
        this.close();
        this.strip.setVertical(this._vertical());
        this.strip.corner = CHIP_CORNER[this._edge()];
        this._expanded = this._keyboardOpen || this._settings.get_boolean('always-show');
        this.applyTheme();
        this._animate();
    }

    applyTheme() {
        const theme = this.host.theme();
        const edge = this._edge();
        setGlass(this.actor, theme.glass ? (w, h) => chamferRects(edge, w, h, CHAMFER.large) : null, theme.glassParams);
        this._tickLight._ledgeLight = '';
        this._tickLight._ledgeRing = toHex([...rgba(theme.rail).slice(0, 3), 1]);
        this.strip.repaint();
        this.update(this.host.cells());
        this._apply();
        if (!this._overview() && this.deck.visible) this.open(this.deck.key, true);
    }

    // Drawing areas whose repaints the smoke test counts.
    canvases() {
        return [this._background, ...[...this.strip.chips.values()].flatMap(chip => chip.canvases()), ...this.deck.canvases()];
    }

    destroy() {
        // Actors emit hover and allocation changes while they are torn down.
        this._destroyed = true;
        this._timeline?.stop();
        this._timeline = null;
        this._clearTimers();
        if (this._idle) GLib.Source.remove(this._idle);
        this._idle = 0;
        for (const [object, id] of this._signals) object.disconnect(id);
        this._signals = [];
        this.close();
        Main.layoutManager.removeChrome(this.actor);
        Main.layoutManager.removeChrome(this.sensor);
        setGlass(this.actor, null, null);
        this.strip.destroy();
        this.deck.destroy();
        this._deckLayer.destroy();
        this.actor.destroy();
        this.sensor.destroy();
    }
}
