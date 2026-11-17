import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {CHIP, METER, MOTION, RAIL, SPACE, TICK, chipMeterWidth, meterSegments, poweredSegments} from '../design.js';
import {drawBadge, drawChipBackground, drawMeter, drawTickMark} from '../draw.js';
import {cssColor} from '../themes.js';
import {animations, box, canvas, light, lightColor, setLight} from './ui.js';

// One module's chip: badge or icon, mono readout over a chip meter, and a
// status light. The actor is kept across updates so hover, focus and motion
// carry on while readings change.
class Chip {
    constructor(strip, key) {
        this.strip = strip;
        this.key = key;
        this.open = false;
        this._shown = null;     // fraction the meter currently draws
        this._power = 1;        // share of the power-on already played
        this._signature = '';
        // Rail chips are buttons. Panel chips are plain widgets: the panel
        // button they sit in owns clicks and opens its menu.
        const Actor = strip.button ? St.Button : St.Bin;
        this.actor = new Actor({style_class: 'ledge-chip', reactive: true, can_focus: true, track_hover: true,
            width: strip.width, ...strip.fill ? {} : {height: strip.height},
            y_align: strip.fill ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.CENTER});
        this._background = canvas((cr, w, h) => {
            const palette = strip.palette();
            const active = this.actor.hover || this.open;
            drawChipBackground(cr, w, h, active ? palette.hover : null, this.actor.has_key_focus() ? palette.focus : null, strip.corner);
        });
        this._lead = new St.Bin({width: CHIP.badge, height: CHIP.badge, y_align: Clutter.ActorAlign.CENTER});
        this._readout = new St.Label({style_class: strip.readoutClass, x_align: Clutter.ActorAlign.START});
        this._meter = canvas((cr, w) => {
            const palette = strip.palette();
            const fills = poweredSegments(meterSegments(this._shown, METER.chip.segments), this._power);
            drawMeter(cr, 0, 0, Math.min(w, chipMeterWidth()), METER.chip.height, METER.chip.gap, fills,
                palette.accent(this.info.accent), palette.meterOff, this.info.stale);
        }, {width: Math.ceil(chipMeterWidth()), height: METER.chip.height, x_align: Clutter.ActorAlign.START});
        this._column = box(true, {x_expand: true, y_align: Clutter.ActorAlign.CENTER, width: Math.ceil(chipMeterWidth()),
            style: `spacing: ${CHIP.meterGap}px;`});
        this._column.add_child(this._readout);
        this._column.add_child(this._meter);
        const column = this._column;
        this._light = light();
        const content = box(false, {x_expand: true, y_expand: true, style: `spacing: ${strip.gap}px; padding: 0 ${strip.gap}px;`});
        content.add_child(this._lead);
        content.add_child(column);
        content.add_child(this._light);
        const layers = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL});
        layers.add_child(this._background);
        layers.add_child(content);
        this.actor.set_child(layers);

        const handlers = strip.handlers;
        this.actor.connect('notify::hover', () => {
            this._background.queue_repaint();
            if (this.actor.hover) handlers.hover?.(key);
        });
        this.actor.connect('key-focus-in', () => { this._background.queue_repaint(); handlers.focus?.(key); });
        this.actor.connect('key-focus-out', () => this._background.queue_repaint());
        if (strip.button) {
            this.actor.button_mask = St.ButtonMask.ONE | St.ButtonMask.THREE;
            this.actor.connect('clicked', (_a, button) => button === Clutter.BUTTON_SECONDARY
                ? handlers.secondary?.(key) : handlers.activate?.(key));
        }
        this.actor.connect('key-press-event', (_a, event) => handlers.key?.(event) ?? Clutter.EVENT_PROPAGATE);
    }

    update(info) {
        const palette = this.strip.palette();
        const accent = palette.accent(info.accent);
        const letters = palette.accentText(info.accent);
        const previous = this.info;
        this.info = info;
        this.actor.accessible_name = info.accessibleName;
        const lead = info.badge ? `badge ${info.badge} ${letters}` : `icon ${info.icon}`;
        if (lead !== this._leadKey) {
            this._leadKey = lead;
            this._lead.set_child(info.badge
                ? canvas(cr => drawBadge(cr, CHIP.badge, info.badge, letters), {width: CHIP.badge, height: CHIP.badge})
                : new St.Icon({icon_name: info.icon, icon_size: CHIP.badge, style_class: 'ledge-chip-icon'}));
        }
        if (this._readout.text !== info.label) this._readout.text = info.label;
        // A chip without a meter centres its readout on the badge.
        this._meter.visible = Boolean(info.meter);
        setLight(this._light, info.light, lightColor(info.light, accent, palette));
        if (!previous || previous.fraction !== info.fraction) this._moveMeter(info.fraction);
        // Repaint only when something the meter draws has changed.
        const signature = `${accent} ${palette.meterOff} ${info.stale}`;
        if (signature !== this._signature) {
            this._signature = signature;
            this._meter.queue_repaint();
        }
    }

    // A value change steps the lit segments up or down; no other motion.
    _moveMeter(target) {
        this._timeline?.stop();
        this._timeline = null;
        const from = this._shown;
        const still = typeof from !== 'number' || typeof target !== 'number' || !animations() || !this.actor.mapped;
        if (still) {
            this._shown = target;
            this._meter.queue_repaint();
            return;
        }
        const segments = METER.chip.segments;
        const timeline = this._timeline = new Clutter.Timeline({actor: this._meter, duration: MOTION.meterChange});
        timeline.connect('new-frame', (_t, ms) => {
            const next = Math.round((from + (target - from) * ms / MOTION.meterChange) * segments) / segments;
            if (next === this._shown) return;
            this._shown = next;
            this._meter.queue_repaint();
        });
        timeline.connect('completed', () => {
            this._timeline = null;
            this._shown = target;
            this._meter.queue_repaint();
        });
        timeline.start();
    }

    // Entry motion: `enter` 0..1 fades and slides the chip in from `edge`;
    // `power` 0..1 lights the meter's segments one after another.
    setMotion(enter, power, edge) {
        this.actor.opacity = Math.round(255 * enter);
        const offset = MOTION.chipSlide * (1 - enter);
        this.actor.translation_x = edge === 'right' ? offset : edge === 'left' ? -offset : 0;
        this.actor.translation_y = edge === 'bottom' ? offset : edge === 'top' ? -offset : 0;
        // Repaint only when another segment lights.
        const lit = Math.ceil(power * METER.chip.segments);
        this._power = power;
        if (lit !== this._litSteps) {
            this._litSteps = lit;
            this._meter.queue_repaint();
        }
    }

    // Compact chips keep the badge and light and drop the readout and meter.
    setCompact(compact) {
        this._column.visible = !compact;
        this.actor.width = compact ? CHIP.compactWidth : this.strip.width;
    }

    setOpen(open) {
        if (open === this.open) return;
        this.open = open;
        this._background.queue_repaint();
    }

    repaint() {
        this._leadKey = '';
        this._signature = '';
        this._light._ledgeLight = '';
        this._background.queue_repaint();
        this.update(this.info);
    }

    // Drawing areas whose repaints the smoke test counts.
    canvases() { return [this._background, this._meter]; }

    destroy() {
        this._timeline?.stop();
        this._timeline = null;
        this.actor.destroy();
    }
}

// The row or column of chips shared by both placements.
// params: {vertical, height, palette(), handlers: {hover, focus, activate, key},
//          button (chips are buttons), separators (1 px hairlines between chips),
//          readoutClass, corner (chip cut corner or null), width (chip width)}
// palette(): {accent(color), accentText(color), meterOff, led, hover, focus, border, watch, critical}
export class Strip {
    constructor(params) {
        Object.assign(this, {button: true, separators: false, readoutClass: 'ledge-readout', corner: null,
            width: CHIP.railWidth, gap: CHIP.railGap, fill: false}, params);
        this.mode = 'full';
        this.chips = new Map();
        this.actor = box(params.vertical, {style: `spacing: ${this.separators ? 0 : RAIL.chipGap}px;`});
    }

    _separator() {
        return new St.Widget({width: 1, height: Math.round(this.height * 2 / 3), y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ledge-separator', style: `background-color: ${cssColor(this.palette().border)};`});
    }

    keys() { return [...this.chips.keys()]; }

    // cells: [{key, info}] in display order.
    update(cells) {
        const keys = cells.map(cell => cell.key);
        if (keys.join('\n') !== this.keys().join('\n')) {
            const focused = this.keys().findIndex(key => this.chips.get(key).actor.has_key_focus());
            for (const [key, chip] of this.chips) {
                if (keys.includes(key)) this.actor.remove_child(chip.actor);
                else chip.destroy();
            }
            // Separators and the summary chip are rebuilt with the order.
            this.actor.destroy_all_children();
            this._summary = null;
            const next = new Map();
            for (const key of keys) {
                const chip = this.chips.get(key) ?? new Chip(this, key);
                if (this.separators && next.size) this.actor.add_child(this._separator());
                next.set(key, chip);
                this.actor.add_child(chip.actor);
            }
            this.chips = next;
            this._applyMode();
            if (focused >= 0) [...next.values()][Math.min(focused, next.size - 1)]?.actor.grab_key_focus();
        }
        for (const {key, info} of cells) this.chips.get(key).update(info);
    }

    // 'full', 'compact' (no readouts) or 'summary' (one chip with the most
    // urgent light; see setSummary).
    setMode(mode) {
        this.mode = mode;
        this._applyMode();
    }

    _applyMode() {
        const summary = this.mode === 'summary';
        for (const child of this.actor.get_children()) if (child !== this._summary?.actor) child.visible = !summary;
        for (const chip of this.chips.values()) chip.setCompact(this.mode === 'compact');
        if (summary && !this._summary) {
            const actor = new St.Widget({style_class: 'ledge-chip', reactive: true, can_focus: true, track_hover: true,
                width: CHIP.summaryWidth, ...this.fill ? {} : {height: this.height}, accessible_name: 'Ledge',
                y_align: this.fill ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.CENTER,
                layout_manager: new Clutter.BinLayout()});
            const summary = {actor, open: false};
            const fill = canvas((cr, w, h) => {
                const palette = this.palette();
                drawChipBackground(cr, w, h, actor.hover || summary.open ? palette.hover : null, actor.has_key_focus() ? palette.focus : null, this.corner);
            });
            const content = box(false, {x_expand: true, y_expand: true, style: `spacing: ${this.gap}px; padding: 0 ${this.gap}px;`});
            const mark = canvas((cr, w, h) => drawTickMark(cr, w, h, this.palette().mark),
                {width: TICK.thickness, height: CHIP.badge, x_expand: false, y_expand: false, y_align: Clutter.ActorAlign.CENTER});
            summary.lamp = light();
            content.add_child(mark);
            content.add_child(summary.lamp);
            actor.add_child(fill);
            actor.add_child(content);
            for (const signal of ['notify::hover', 'key-focus-in', 'key-focus-out']) actor.connect(signal, () => fill.queue_repaint());
            summary.fill = fill;
            this.actor.add_child(actor);
            this._summary = summary;
        }
        if (this._summary) this._summary.actor.visible = summary;
    }

    // The summary chip's light: the most urgent state and its color.
    setSummary(state, color) {
        if (this._summary) setLight(this._summary.lamp, state, color);
    }

    setSummaryOpen(open) {
        if (!this._summary || this._summary.open === open) return;
        this._summary.open = open;
        this._summary.fill.queue_repaint();
    }

    get summaryActor() { return this._summary?.actor ?? null; }

    setVertical(vertical) {
        this.vertical = vertical;
        this.actor.layout_manager.orientation = vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
    }

    setOpen(key) {
        for (const chip of this.chips.values()) chip.setOpen(chip.key === key);
    }

    repaint() {
        for (const chip of this.chips.values()) chip.repaint();
        const border = cssColor(this.palette().border);
        for (const child of this.actor.get_children())
            if (child.has_style_class_name('ledge-separator')) child.style = `background-color: ${border};`;
        if (this._summary) this._summary.actor.get_first_child().get_first_child().queue_repaint();
    }

    destroy() {
        for (const chip of this.chips.values()) chip.destroy();
        this.chips.clear();
        this.actor.destroy();
    }
}
