import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import {CHAMFER, CHIP, DECK, METER, MOTION, SPACE, HAIRLINE, chamferRects, meterSegments} from '../design.js';
import {drawBadge, drawPanel, drawMeter} from '../draw.js';
import {setGlass} from './glass.js';
import {stampText} from '../model.js';
import {cssColor} from '../themes.js';
import {animations, box, canvas, holds, light, lightColor, setLight} from './ui.js';

// The deck: one panel showing the open module. It docks flush against the
// rail or under the top bar, with `side` naming the side that touches.
// params: {theme(), openPreferences(), key(event)}
export class Deck {
    constructor(params) {
        this._params = params;
        this.key = null;
        this.side = 'right';
        this.autofocus = null;
        this._canvases = new Set();
        this.actor = new St.Widget({style_class: 'ledge-deck', layout_manager: new Clutter.BinLayout(),
            reactive: true, track_hover: true, visible: false, width: DECK.width});
        this._background = canvas((cr, w, h) => {
            const theme = params.theme();
            drawPanel(cr, this.side, w, h, CHAMFER.large, theme.deck, theme.border,
                {rule: this._accent ? {color: this._accent, width: DECK.rule, start: this._rule?.start ?? 0,
                    length: this._rule?.length ?? Infinity} : null});
        });
        this._content = box(true, {x_expand: true, y_expand: true, style: `padding: ${DECK.padding}px; spacing: ${DECK.spacing}px;`});
        this.actor.add_child(this._background);
        this.actor.add_child(this._content);
        this.actor.connect('key-press-event', (_a, event) => params.key(event));
    }

    get visible() { return this.actor.visible; }

    // Where the accent rule runs along the attached side, in deck pixels.
    setRule(start, length) {
        if (this._rule?.start === start && this._rule?.length === length) return;
        this._rule = {start, length};
        this._background.queue_repaint();
    }

    applyTheme() {
        const theme = this._params.theme();
        setGlass(this.actor, theme.glass ? (w, h) => chamferRects(this.side, w, h, CHAMFER.large) : null, theme.glassParams);
        this._background.queue_repaint();
    }

    // Shows `cell` ({key, module, info}). A rebuilt deck keeps keyboard focus
    // at the same control position.
    // `switcher`, when given, is a row of module buttons at the top:
    // [{key, label, active, activate()}].
    show(cell, side, switcher = null) {
        const theme = this._params.theme();
        const switching = this.visible && this.key !== cell.key;
        const entering = !this.visible;
        const focus = global.stage.get_key_focus();
        const focusIndex = !entering && !switching && holds(this.actor, focus)
            ? this.focusTargets().findIndex(target => holds(target, focus)) : -1;
        this.key = cell.key;
        this.side = side;
        this.autofocus = null;
        this._accent = theme.accent(cell.info.accent, 'deck');
        this._canvases.clear();
        this._content.remove_all_transitions();
        this._content.opacity = 255;
        this._content.destroy_all_children();

        if (switcher) {
            const row = box(false, {style: `spacing: ${SPACE.xs}px;`});
            // Each module: its badge and its light, spread across the deck;
            // the open one is filled like an open chip.
            const palette = {accent: color => theme.accent(color, 'deck'), led: theme.led};
            for (const item of switcher) {
                const content = box(false, {style: `spacing: ${SPACE.xs}px;`, x_align: Clutter.ActorAlign.CENTER});
                const letters = theme.accentText(item.accent, 'deck');
                content.add_child(canvas(cr => drawBadge(cr, CHIP.badge, item.label, letters),
                    {width: CHIP.badge, height: CHIP.badge, x_expand: false, y_expand: false, y_align: Clutter.ActorAlign.CENTER}));
                const lamp = light();
                setLight(lamp, item.light, lightColor(item.light, theme.accent(item.accent, 'deck'), palette));
                content.add_child(lamp);
                const button = new St.Button({child: content, style_class: item.active ? 'ledge-switch ledge-switch-active' : 'ledge-switch',
                    can_focus: true, x_expand: true, accessible_name: item.name ?? item.label});
                button.connect('clicked', () => item.activate());
                row.add_child(button);
            }
            this._content.add_child(row);
        }
        const header = box(false, {style: `spacing: ${SPACE.sm}px;`});
        // Title and context stay on one line; a long context is shortened.
        const title = new St.Label({text: cell.module.heading(cell.key), style_class: 'ledge-deck-title',
            y_align: Clutter.ActorAlign.CENTER});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        header.add_child(title);
        const context = cell.module.context(cell.key);
        const detail = new St.Label({text: context ? `· ${context}` : '', style_class: 'ledge-caption',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        detail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        header.add_child(detail);
        const time = new St.Label({text: stampText(cell.info), style_class: 'ledge-stamp',
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
        header.add_child(time);
        this._content.add_child(header);

        const body = box(true, {style: `spacing: ${DECK.spacing}px;`});
        this._content.add_child(body);
        const moduleActions = cell.module.card(body, this._ui(), cell.key) ?? [];

        const footer = box(false, {style_class: 'ledge-actions'});
        for (const [label, action] of [...moduleActions, ...this._params.actions?.() ?? []])
            footer.add_child(this._action(label, action));
        const settings = this._action('settings', () => this._params.openPreferences());
        settings.x_expand = true;
        settings.x_align = Clutter.ActorAlign.END;
        footer.add_child(settings);
        this._content.add_child(footer);

        this.applyTheme();
        this.actor.show();
        if ((switching || entering) && animations()) {
            // Only the content fades: glass needs its actor fully opaque.
            this._content.opacity = 0;
            this._content.ease({opacity: 255, duration: entering ? MOTION.deckOpen : MOTION.deckSwitch,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        }
        if (focusIndex >= 0) {
            const targets = this.focusTargets();
            (targets[Math.min(focusIndex, targets.length - 1)] ?? this.autofocus)?.grab_key_focus();
        }
    }

    hide() {
        this.actor.hide();
        this.actor.remove_all_transitions();
        this._content.remove_all_transitions();
        this._content.opacity = 255;
        this.actor.translation_x = this.actor.translation_y = 0;
        this._content.destroy_all_children();
        this._canvases.clear();
        this.key = null;
        this.autofocus = null;
    }

    // Fades the content out, then calls done() unless a show() interrupted.
    fadeOut(duration, done) {
        this._content.ease({opacity: 0, duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: finished => { if (finished) done(); }});
    }

    // Focusable controls in reading order, so Tab reaches entries and rows.
    focusTargets() {
        const targets = [];
        const walk = actor => {
            for (const child of actor.get_children()) {
                if (!child.visible) continue;
                if (child instanceof St.Widget && child.can_focus) targets.push(child);
                else walk(child);
            }
        };
        if (this.visible) walk(this._content);
        return targets;
    }

    // Drawing areas whose repaints the smoke test counts.
    canvases() { return [this._background, ...this._canvases]; }

    destroy() {
        setGlass(this.actor, null, null);
        this.actor.destroy();
    }

    _label(text, style) {
        const label = new St.Label({text, style_class: style});
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        return label;
    }

    _action(label, callback) {
        const button = new St.Button({label: label.toLowerCase(), style_class: 'ledge-action', can_focus: true});
        button.connect('clicked', () => callback());
        return button;
    }

    _splitRow(leading, trailing, trailingClass = 'ledge-caption') {
        const row = box(false, {style: `spacing: ${SPACE.sm}px;`});
        row.add_child(this._label(leading, 'ledge-body'));
        const end = this._label(trailing, trailingClass);
        end.x_expand = true;
        end.x_align = Clutter.ActorAlign.END;
        row.add_child(end);
        return row;
    }

    // A labelled deck meter: leading and trailing text, meter, caption below.
    _meter(leading, trailing, fraction, stale, color, caption) {
        const block = box(true, {style: `spacing: ${SPACE.xs}px;`});
        block.add_child(this._splitRow(leading, trailing, 'ledge-figure'));
        const meter = canvas((cr, w) => {
            const theme = this._params.theme();
            drawMeter(cr, 0, 0, w, METER.deck.height, METER.deck.gap, meterSegments(fraction, METER.deck.segments),
                theme.accent(color, 'deck'), theme.meterOff, stale);
        }, {width: DECK.width - 2 * DECK.padding, height: METER.deck.height});
        this._canvases.add(meter);
        block.add_child(meter);
        if (caption) block.add_child(this._label(caption, 'ledge-figure'));
        return block;
    }

    // Factories modules build their deck content with.
    _ui() {
        return {
            label: (text, style) => this._label(text, style),
            splitRow: (...args) => this._splitRow(...args),
            bar: (...args) => this._meter(...args),
            box: style => box(true, {style}),
            // A labelled group: the label sits close to its own rows.
            section: title => {
                const group = box(true, {style: `spacing: ${SPACE.xs}px;`});
                group.add_child(this._label(title.toLowerCase(), 'ledge-section'));
                return group;
            },
            hairline: () => new St.Widget({height: HAIRLINE, style_class: 'ledge-hairline'}),
            button: (label, callback, style = 'ledge-action') => {
                const button = new St.Button({label, style_class: style, can_focus: true});
                button.connect('clicked', () => callback());
                return button;
            },
            iconButton: (iconName, accessibleName, callback) => {
                const button = new St.Button({style_class: 'ledge-icon-button', can_focus: true, accessible_name: accessibleName,
                    child: new St.Icon({icon_name: iconName, icon_size: DECK.actionIcon}), y_align: Clutter.ActorAlign.CENTER});
                button.connect('clicked', () => callback());
                return button;
            },
            // A list row: leading actors, optional icon, title, caption, trailing actors.
            // With onClick the whole row is one focusable button instead.
            row: (title, {icon = null, detail = '', mono = false, active = false, dim = false, onClick = null, leading = [], trailing = []} = {}) => {
                const line = box(false, {style: `spacing: ${SPACE.sm}px;`, x_expand: true});
                for (const actor of leading) line.add_child(actor);
                if (icon) line.add_child(new St.Icon({icon_name: icon, icon_size: DECK.rowIcon, y_align: Clutter.ActorAlign.CENTER}));
                const text = box(true, {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
                text.add_child(this._label(title, dim ? 'ledge-row-title ledge-dim' : 'ledge-row-title'));
                if (detail) text.add_child(this._label(detail, mono ? 'ledge-figure' : 'ledge-caption'));
                line.add_child(text);
                if (active) line.add_child(new St.Icon({icon_name: 'object-select-symbolic', icon_size: DECK.actionIcon, y_align: Clutter.ActorAlign.CENTER}));
                for (const actor of trailing) line.add_child(actor);
                if (!onClick) return line;
                const button = new St.Button({style_class: active ? 'ledge-row ledge-row-active' : 'ledge-row',
                    can_focus: true, x_expand: true, child: line, accessible_name: title});
                button.connect('clicked', () => onClick());
                return button;
            },
            // Text entry; Enter calls onActivate(text, entry).
            entry: (hint, onActivate) => {
                const entry = new St.Entry({hint_text: hint, style_class: 'ledge-entry', can_focus: true, x_expand: true});
                entry.clutter_text.connect('activate', () => onActivate(entry.get_text(), entry));
                return entry;
            },
            // The control a click on the chip focuses, such as an entry.
            autofocus: actor => { this.autofocus = actor; },
        };
    }
}
