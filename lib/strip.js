import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {CHIP, METER, MOTION, RAIL, SPACE, chipMeterWidth, meterSegments, poweredSegments} from '../design.js';
import {drawBadge, drawChipBackground, drawMeter} from '../draw.js';
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
        this.actor = new St.Button({style_class: 'ledge-chip', can_focus: true, track_hover: true,
            width: CHIP.railWidth, height: strip.height});
        this._background = canvas((cr, w, h) => {
            const theme = strip.theme();
            const active = this.actor.hover || this.open;
            drawChipBackground(cr, w, h, active ? theme.controlHover : null, this.actor.has_key_focus() ? theme.highlight : null);
        });
        this._lead = new St.Bin({width: CHIP.badge, height: CHIP.badge, y_align: Clutter.ActorAlign.CENTER});
        this._readout = new St.Label({style_class: 'ledge-readout', x_align: Clutter.ActorAlign.START});
        this._meter = canvas((cr, w) => {
            const theme = strip.theme();
            const fills = poweredSegments(meterSegments(this._shown, METER.chip.segments), this._power);
            drawMeter(cr, 0, 0, Math.min(w, chipMeterWidth()), METER.chip.height, METER.chip.gap, fills,
                theme.accent(this.info.accent, strip.where), theme.meterOff, this.info.stale);
        }, {width: Math.ceil(chipMeterWidth()), height: METER.chip.height, x_align: Clutter.ActorAlign.START});
        const column = box(true, {x_expand: true, y_align: Clutter.ActorAlign.CENTER, width: Math.ceil(chipMeterWidth()),
            style: `spacing: ${CHIP.meterGap}px;`});
        column.add_child(this._readout);
        column.add_child(this._meter);
        this._light = light();
        const content = box(false, {x_expand: true, y_expand: true, style: `spacing: ${SPACE.sm}px; padding: 0 ${SPACE.sm}px;`});
        content.add_child(this._lead);
        content.add_child(column);
        content.add_child(this._light);
        const layers = new St.Widget({layout_manager: new Clutter.BinLayout()});
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
        this.actor.connect('clicked', () => handlers.activate?.(key));
        this.actor.connect('key-press-event', (_a, event) => handlers.key?.(event) ?? Clutter.EVENT_PROPAGATE);
    }

    update(info) {
        const theme = this.strip.theme();
        const accent = theme.accent(info.accent, this.strip.where);
        const letters = theme.accentText(info.accent, this.strip.where);
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
        this._meter.visible = info.meter;
        setLight(this._light, info.light, lightColor(info.light, accent, theme, this.strip.where));
        if (!previous || previous.fraction !== info.fraction) this._moveMeter(info.fraction);
        // Repaint only when something the meter draws has changed.
        const signature = `${accent} ${theme.meterOff} ${info.stale}`;
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
// params: {vertical, height, where, theme(), handlers: {hover, focus, activate, key}}
export class Strip {
    constructor(params) {
        Object.assign(this, params);
        this.chips = new Map();
        this.actor = box(params.vertical, {style: `spacing: ${RAIL.chipGap}px;`});
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
            const next = new Map();
            for (const key of keys) {
                const chip = this.chips.get(key) ?? new Chip(this, key);
                next.set(key, chip);
                this.actor.add_child(chip.actor);
            }
            this.chips = next;
            if (focused >= 0) [...next.values()][Math.min(focused, next.size - 1)]?.actor.grab_key_focus();
        }
        for (const {key, info} of cells) this.chips.get(key).update(info);
    }

    setVertical(vertical) {
        this.vertical = vertical;
        this.actor.layout_manager.orientation = vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
    }

    setOpen(key) {
        for (const chip of this.chips.values()) chip.setOpen(chip.key === key);
    }

    repaint() {
        for (const chip of this.chips.values()) chip.repaint();
    }

    destroy() {
        for (const chip of this.chips.values()) chip.destroy();
        this.chips.clear();
        this.actor.destroy();
    }
}
