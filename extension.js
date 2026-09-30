import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {position} from './model.js';
import {LAYOUT, shapeLength, springSample, clampUnit, notchGeometry} from './design.js';
import {drawFilledPath, traceNotchPath, drawRing, drawProgressBar, drawTooltipTail, drawGlyph, drawSettings, drawSettingsGlyph} from './draw.js';
import {closeHttp} from './lib/http.js';
import {Appearance} from './lib/appearance.js';
import {setGlass} from './lib/glass.js';
import {notchRects, roundedRectRects} from './design.js';
import {USAGE_MODULES} from './modules/usage.js';
import {PowerModule} from './modules/power.js';
import {TodoModule} from './modules/todo.js';
import {ModelsModule} from './modules/models.js';
import {GithubModule} from './modules/github.js';
import {TrainingModule} from './modules/training.js';

// Cell order in the notch.
const MODULES = [...USAGE_MODULES, PowerModule, TodoModule, ModelsModule, GithubModule, TrainingModule];

export default class Ledge extends Extension {
    enable() {
        this._alive = true;
        this._modules = new Map();
        this._pendingChanges = new Set();
        this._rings = [];
        this._displayFractions = {};
        this._settings = this.getSettings();
        // Resolved before any actor exists; later changes redraw in place, so
        // an open card follows the theme. Its keys are skipped below.
        this._appearance = new Appearance(this._settings, theme => this._applyTheme(theme));
        this._moduleHost = {
            settings: this._settings,
            path: this.path,
            changed: module => this._changed(module),
            openPreferences: () => this.openPreferences(),
        };
        this._ignoreHover = false;
        this._detailMounted = false;
        this._expanded = this._settings.get_boolean('always-show');
        this._expandT = this._expanded ? 1 : 0;
        this._expandTarget = this._expandT;
        this._orbHover = false;
        this._orbT = 0;
        this._orbVelocity = 0;
        this._expandVelocity = 0;
        this._orbReveal = this._expandT;
        this._orbRevealVelocity = 0;
        this._cellMotion = new Map();

        this._host = new St.Widget({reactive: true, track_hover: true, clip_to_allocation: true});
        this._notchBg = new St.DrawingArea({reactive: false});
        this._stack = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.START});
        this._host.add_child(this._notchBg);
        this._host.add_child(this._stack);
        this._detail = new St.BoxLayout({style_class: 'ledge-detail-wrap', reactive: true, track_hover: true, visible: false});
        // Horizontal boxes default to width-for-height. This popup instead needs
        // its constrained card width to determine wrapped text's natural height.
        this._detail.request_mode = Clutter.RequestMode.HEIGHT_FOR_WIDTH;
        this._orb = new St.Button({
            style_class: 'ledge-settings', can_focus: true, track_hover: true,
            accessible_name: 'Ledge settings', visible: false,
        });
        this._orbDrawing = new St.DrawingArea({width: 104, height: 104,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._orbGlyph = new St.DrawingArea({width: Math.round(LAYOUT.settingsGlyph),
            height: Math.round(LAYOUT.settingsGlyph), opacity: 0,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._orbGlyph.connect('repaint', area => {
            const cr = area.get_context();
            drawSettingsGlyph(cr, area.get_surface_size()[0], this._theme.textPrimary);
            cr.$dispose();
        });
        this._orbGlyph.set_pivot_point(0.5, 0.5);
        this._orb.set_child(this._orbGlyph);
        this._orbDrawing.connect('repaint', area => {
            const cr = area.get_context();
            drawSettings(cr, area.get_surface_size()[0], this._edge(), this._orbT, this._orbReveal, this._theme.notch);
            cr.$dispose();
        });

        Main.layoutManager.addChrome(this._host, {affectsStruts: false, trackFullscreen: true});
        // Shell owns fullscreen visibility on the wrapper; only we own whether
        // the settings button is shown. Overview may show tracked chrome again.
        this._orbChrome = new St.Widget();
        this._orbChrome.add_child(this._orbDrawing);
        this._orbChrome.add_child(this._orb);
        Main.layoutManager.addChrome(this._orbChrome, {affectsStruts: false, trackFullscreen: true});
        this._host.connect('notify::hover', () => this._hover());
        this._detail.connect('notify::hover', () => this._hover());
        this._orb.connect('notify::hover', () => {
            this._orbHover = this._orb.hover;
            this._animateSettings();
            if (this._orbHover) this._hideDetail();
            this._hover();
        });
        this._orb.connect('key-focus-in', () => this._animateSettings());
        this._orb.connect('key-focus-out', () => this._animateSettings());
        this._orb.connect('clicked', () => this.openPreferences());
        this._orb.connect('key-press-event', (_a, e) => this._key(e));
        this._notchBg.connect('repaint', area => {
            const cr = area.get_context();
            const [w, h] = area.get_surface_size();
            cr.setOperator(3);
            cr.paint();
            cr.setOperator(2);
            drawFilledPath(cr, traceNotchPath, w, h, this._edge(), this._theme.notch, this._theme.glass ? this._theme.border : null);
            cr.$dispose();
        });
        this._host.connect('notify::allocation', () => this._place());
        this._orb.connect('notify::allocation', () => this._place());
        this._detail.connect('notify::allocation', () => this._placeDetail());
        this._host.connect('key-press-event', (_a, e) => this._key(e));
        this._detail.connect('key-press-event', (_a, e) => this._key(e));

        this._monitorSignal = Main.layoutManager.connect('monitors-changed', () => this._place());
        this._workSignal = global.display.connect('workareas-changed', () => {
            this._place();
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (this._alive && this._overviewActive()) this._hideDetail();
                return GLib.SOURCE_REMOVE;
            });
        });
        this._workspaceSignal = global.workspace_manager.connect('active-workspace-changed', () => {
            this._keyboardOpen = false;
            this._hideDetail();
            this._hover();
        });
        // Typing in a card holds the notch open; focus moving elsewhere releases it.
        this._focusSignal = global.stage.connect('notify::key-focus', () => {
            if (this._detail?.visible && !this._detail.contains(global.stage.get_key_focus())) this._hover();
        });
        this._overviewShowingSignal = Main.overview.connect('showing', () => this._onOverviewShowing());
        this._overviewHidingSignal = Main.overview.connect('hiding', () => this._onOverviewHiding());
        this._overviewHiddenSignal = Main.overview.connect('hidden', () => this._onOverviewHidden());
        if (Main.overview.visibleTarget) this._onOverviewShowing();

        this._settingsSignal = this._settings.connect('changed', (_s, key) => {
            if (/^(theme|custom-|glass-)/.test(key)) return;
            this._hideDetail();
            if (key === 'edge') this._applyGlass();
            this._expanded = this._settings.get_boolean('always-show');
            this._expandTarget = this._expanded ? 1 : 0;
            if (MODULES.some(M => M.id === key)) this._syncModules();
            this._render();
            if (key === 'always-show') this._expandTarget = this._expanded ? 1 : 0;
            this._animateMotion();
        });

        Main.wm.addKeybinding('toggle-notch', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL, () => {
                if (this._overviewActive()) return;
                this._keyboardOpen = !this._keyboardOpen;
                this._expanded = this._keyboardOpen || this._settings.get_boolean('always-show');
                this._expandTarget = this._expanded ? 1 : 0;
                this._animateMotion();
                this._render();
                if (this._keyboardOpen) this._focusTargets()[0]?.grab_key_focus();
                else this._hideDetail();
            });

        this._applyGlass();
        this._syncModules();
        this._render();
        this._animateMotion();
    }

    // Glass on the notch, clipped to its current shape, or none.
    _applyGlass() {
        if (!this._host) return;
        const edge = this._edge();
        setGlass(this._host, (w, h) => notchRects(edge, w, h), this._theme.glassParams);
    }

    _applyTheme(theme) {
        this._theme = theme;
        if (!this._host) return;
        this._applyGlass();
        this._render();
        for (const area of [this._notchBg, this._orbDrawing, this._orbGlyph]) area.queue_repaint();
        if (!this._overviewActive() && this._detail.visible && this._selected) this._showDetail(this._selected, true);
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
                delete this._displayFractions[M.id];
            }
        }
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
            this._render();
            if (!this._overviewActive() && this._detail.visible && changed.has(this._selected))
                this._showDetail(this._selected, true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _edge() { return this._settings.get_string('edge'); }
    _vertical() { const e = this._edge(); return e === 'left' || e === 'right'; }
    _tooltipDirection() {
        return {right: 'leading', left: 'trailing', top: 'up', bottom: 'down'}[this._edge()];
    }

    _animateMotion() {
        if (this._motionTimer) GLib.Source.remove(this._motionTimer);
        this._motionTimer = 0;
        const target = this._expandTarget;
        if (this._overviewActive() || !St.Settings.get().enable_animations) {
            this._expandT = this._orbReveal = target;
            this._expandVelocity = this._orbRevealVelocity = 0;
            for (const id of this._enabled()) this._cellMotion.set(id, {value: target, velocity: 0});
            this._updateMotion();
            return;
        }
        const start = {value: this._expandT, velocity: this._expandVelocity};
        const reveal = {value: this._orbReveal, velocity: this._orbRevealVelocity};
        const cells = new Map(this._cellMotion);
        const t0 = GLib.get_monotonic_time();
        this._motionTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            const seconds = (GLib.get_monotonic_time() - t0) / 1000000;
            const shape = springSample(start.value, target, start.velocity, seconds);
            this._expandT = shape.value;
            this._expandVelocity = shape.velocity;
            this._enabled().forEach((id, index) => {
                const from = cells.get(id) ?? start;
                const time = Math.max(0, seconds - Math.min(index * 0.045, 0.18));
                this._cellMotion.set(id, springSample(from.value, target, from.velocity, time, 0.36, 0.82));
            });
            if (target === 0) {
                const t = Math.min(1, seconds / 0.2);
                this._orbReveal = reveal.value * (1 - t * t);
                this._orbRevealVelocity = 0;
            } else {
                const time = Math.max(0, seconds - Math.min(this._enabled().length * 0.045, 0.18));
                const sample = springSample(reveal.value, target, reveal.velocity, time, 0.36, 0.82);
                this._orbReveal = sample.value;
                this._orbRevealVelocity = sample.velocity;
            }
            if (seconds >= 0.8) {
                this._expandT = this._orbReveal = target;
                this._expandVelocity = this._orbRevealVelocity = 0;
                for (const id of this._enabled()) this._cellMotion.set(id, {value: target, velocity: 0});
                this._motionTimer = 0;
            }
            this._updateMotion();
            return this._motionTimer ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
    }

    _animateSettings() {
        if (!this._alive) return;
        if (this._orbTimer) GLib.Source.remove(this._orbTimer);
        this._orbTimer = 0;
        const target = !this._overviewActive() && (this._orbHover || this._orb.has_key_focus()) ? 1 : 0;
        if (!St.Settings.get().enable_animations || this._overviewActive()) {
            this._orbT = target;
            this._orbVelocity = 0;
            this._updateSettings();
            return;
        }
        const start = this._orbT, velocity = this._orbVelocity;
        const t0 = GLib.get_monotonic_time();
        this._orbTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            const seconds = (GLib.get_monotonic_time() - t0) / 1000000;
            const sample = springSample(start, target, velocity, seconds, 0.36, 0.7);
            this._orbT = sample.value;
            this._orbVelocity = sample.velocity;
            if (seconds >= 0.65) {
                this._orbT = target;
                this._orbVelocity = this._orbTimer = 0;
            }
            this._updateSettings();
            return this._orbTimer ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
    }

    _updateSettings() {
        this._orbDrawing.visible = this._orb.visible;
        this._orbDrawing.queue_repaint();
        this._orbGlyph.opacity = Math.round(255 * clampUnit(this._orbT) * clampUnit(this._orbReveal));
        const scale = 0.5 + 0.5 * this._orbT;
        this._orbGlyph.set_scale(scale, scale);
        this._orbGlyph.rotation_angle_z = -60 * (1 - this._orbT);
    }

    _updateMotion() {
        const enabled = this._enabled();
        const size = this._notchSize(enabled.length);
        const vertical = this._vertical();
        const fullLength = Math.round(shapeLength(enabled.length, vertical));
        const fullDepth = Math.round(LAYOUT.sideBodyDepth);
        this._host.set_size(size.width, size.height);
        this._notchBg.set_size(size.width, size.height);
        this._notchBg.queue_repaint();
        this._stack.set_size(vertical ? fullDepth : fullLength, vertical ? fullLength : fullDepth);
        this._stack.set_position(this._edge() === 'right' ? size.width - fullDepth : 0,
            this._edge() === 'bottom' ? size.height - fullDepth : 0);
        // Contents retain their full layout while the outline swallows them.
        const {curl} = notchGeometry(vertical ? size.width : size.height, vertical ? size.height : size.width);
        const clipX = vertical ? -this._stack.x : curl;
        const clipY = vertical ? curl : -this._stack.y;
        this._stack.set_clip(clipX, clipY,
            vertical ? size.width : Math.max(0, size.width - 2 * curl),
            vertical ? Math.max(0, size.height - 2 * curl) : size.height);
        this._stack.visible = this._expanded || this._expandT > 0.001;
        this._stack.get_children().forEach((cell, index) => {
            const progress = this._cellMotion.get(enabled[index])?.value ?? this._expandT;
            cell.opacity = Math.round(255 * clampUnit(progress));
            const offset = LAYOUT.bezelFillet * (1 - progress);
            cell.translation_x = this._edge() === 'right' ? offset : this._edge() === 'left' ? -offset : 0;
            cell.translation_y = this._edge() === 'bottom' ? offset : this._edge() === 'top' ? -offset : 0;
            const button = cell.get_first_child();
            button.reactive = this._expanded && this._expandT > 0.6;
            button.can_focus = this._expanded;
        });
        this._orb.visible = this._orbReveal > 0.001 && enabled.length > 0;
        this._orb.reactive = this._expanded && this._orbReveal > 0.5;
        this._orb.can_focus = this._expanded;
        this._updateSettings();
        this._place();
    }

    _animateRings() {
        if (this._animation) GLib.Source.remove(this._animation);
        this._animation = 0;
        const needsMotion = this._expandT > 0.5 || this._orbHover ||
            [...this._modules.values()].some(m => m.cell().animating);
        if (!needsMotion || !St.Settings.get().enable_animations) return;
        // Stops once rings have eased to their values and nothing spins, so an
        // idle expanded notch (and any glass behind it) is not repainted.
        this._animation = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            let moving = false;
            for (const [id, module] of this._modules) {
                const cell = module.cell();
                moving ||= cell.animating;
                if (typeof cell.fraction === 'number') {
                    const cur = this._displayFractions[id] ?? cell.fraction;
                    const next = cur + (cell.fraction - cur) * 0.12;
                    const settled = Math.abs(cell.fraction - next) < 0.001;
                    this._displayFractions[id] = settled ? cell.fraction : next;
                    moving ||= !settled;
                }
            }
            for (const ring of this._rings) ring.queue_repaint();
            if (moving) return GLib.SOURCE_CONTINUE;
            this._animation = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _focusTargets() {
        const targets = [];
        for (const cell of this._stack.get_children()) {
            const button = cell.get_first_child();
            if (button?.can_focus) targets.push(button);
        }
        if (this._detail.visible) {
            const card = this._detail.get_first_child()?.get_children()
                .find(child => child.has_style_class_name('ledge-detail'));
            // Card controls in reading order, so Tab reaches entries and rows too.
            const walk = actor => {
                for (const child of actor.get_children()) {
                    if (!child.visible) continue;
                    if (child instanceof St.Widget && child.can_focus) targets.push(child);
                    else walk(child);
                }
            };
            if (card) walk(card);
        }
        if (this._orb.visible) targets.push(this._orb);
        return targets;
    }

    _key(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab) {
            const targets = this._focusTargets();
            if (targets.length) {
                const current = targets.indexOf(global.stage.get_key_focus());
                const backwards = symbol === Clutter.KEY_ISO_Left_Tab || Boolean(event.get_state() & Clutter.ModifierType.SHIFT_MASK);
                targets[(current + (backwards ? -1 : 1) + targets.length) % targets.length].grab_key_focus();
            }
            return Clutter.EVENT_STOP;
        }
        if (symbol !== Clutter.KEY_Escape) return Clutter.EVENT_PROPAGATE;
        this._keyboardOpen = false;
        this._hideDetail();
        this._expanded = this._settings.get_boolean('always-show');
        this._expandTarget = this._expanded ? 1 : 0;
        this._animateMotion();
        this._render();
        global.stage.set_key_focus(null);
        return Clutter.EVENT_STOP;
    }

    _enabled() { return MODULES.filter(M => this._modules.has(M.id)).map(M => M.id); }

    _overviewActive() {
        const overview = Main.overview;
        const mode = Main.actionMode ?? 0;
        return this._ignoreHover || (mode & Shell.ActionMode.OVERVIEW) !== 0
            || overview.visible || overview.visibleTarget || overview.animationInProgress;
    }

    _mountDetail() {
        if (this._detailMounted) return;
        const params = {affectsStruts: false, trackFullscreen: true};
        if (this._detail.get_parent()) Main.layoutManager.trackChrome(this._detail, params);
        else Main.layoutManager.addChrome(this._detail, params);
        this._detailMounted = true;
    }

    _unmountDetail() {
        if (!this._detailMounted) return;
        // Release content and chrome visibility ownership, but keep the hidden
        // root on-stage so pending Clutter allocations still have a theme context.
        this._detail.destroy_all_children();
        this._detailMounted = false;
        Main.layoutManager.untrackChrome(this._detail);
    }

    _hideDetail() {
        if (this._hideTimer) GLib.Source.remove(this._hideTimer);
        this._hideTimer = 0;
        this._detail.hide();
        this._detail.get_first_child()?.remove_all_transitions();
        this._detail.remove_all_transitions();
        this._detail.translation_x = 0;
        this._detail.translation_y = 0;
        this._detailPositioned = false;
        // Shell may set tracked chrome visible again on workspace/fullscreen
        // changes. A dismissed popup must leave chrome, not merely hide.
        this._unmountDetail();
    }

    _onOverviewShowing() {
        this._ignoreHover = true;
        this._keyboardOpen = false;
        this._hideDetail();
        // Settle transient hover expansion before Overview starts moving windows.
        if (this._motionTimer) GLib.Source.remove(this._motionTimer);
        this._motionTimer = 0;
        this._expanded = this._settings.get_boolean('always-show');
        this._expandT = this._expandTarget = this._expanded ? 1 : 0;
        this._orb.remove_all_transitions();
        this._orbHover = false;
        if (this._orbTimer) GLib.Source.remove(this._orbTimer);
        this._orbTimer = 0;
        this._orbT = this._orbVelocity = this._expandVelocity = this._orbRevealVelocity = 0;
        this._orbReveal = this._expandT;
        for (const id of this._enabled()) this._cellMotion.set(id, {value: this._expandT, velocity: 0});
        this._render();
        const focus = global.stage.get_key_focus();
        if (focus && (this._host.contains(focus) || this._detail.contains(focus) || this._orb.contains(focus)))
            global.stage.set_key_focus(null);
    }

    _onOverviewHiding() { this._hideDetail(); }
    _onOverviewHidden() {
        this._ignoreHover = false;
        this._place();
    }

    _hover() {
        if (!this._alive) return;
        if (this._overviewActive()) { this._hideDetail(); return; }
        if (this._hideTimer) GLib.Source.remove(this._hideTimer);
        this._hideTimer = 0;
        if (this._host.hover || this._detail.hover || this._orb.hover) {
            if (!this._expanded) {
                this._expanded = true;
                this._expandTarget = 1;
                this._animateMotion();
            }
        } else {
            this._hideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                this._hideTimer = 0;
                const typing = this._detail.visible && this._detail.contains(global.stage.get_key_focus());
                if (!this._keyboardOpen && !typing && !this._host.hover && !this._detail.hover && !this._orb.hover) {
                    this._hideDetail();
                    this._expanded = this._settings.get_boolean('always-show');
                    this._expandTarget = this._expanded ? 1 : 0;
                    this._animateMotion();
                    this._render();
                }
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _notchSize(count) {
        const vertical = this._vertical();
        const t = Math.max(0, this._expandT);
        const length = Math.round(LAYOUT.pillHeight + (shapeLength(count, vertical) - LAYOUT.pillHeight) * t);
        const depth = Math.round(LAYOUT.pillWidth + (LAYOUT.sideBodyDepth - LAYOUT.pillWidth) * t);
        return vertical ? {width: depth, height: length} : {width: length, height: depth};
    }

    _render() {
        const focused = this._stack.get_children().findIndex(cell => cell.contains(global.stage.get_key_focus()));
        const vertical = this._vertical();
        const enabled = this._enabled();
        this._rings = [];
        this._stack.destroy_all_children();
        this._stack.vertical = vertical;
        this._stack.x_align = Clutter.ActorAlign.CENTER;
        this._stack.y_align = Clutter.ActorAlign.CENTER;
        const start = Math.round(LAYOUT.curlRadius + LAYOUT.padTop);
        const end = Math.round(LAYOUT.curlRadius + LAYOUT.padBottom);
        this._stack.set_style(`padding: ${vertical ? `${start}px 0 ${end}px` : `0 ${end}px 0 ${start}px`}; spacing: ${Math.round(LAYOUT.cellSpacing)}px;`);

        enabled.forEach(id => {
            const info = this._modules.get(id).cell();
            const cellTheme = {...info, accent: this._theme.accent(info.accent)};
            // The last shown value persists while a reading is briefly missing.
            if (typeof info.fraction === 'number') this._displayFractions[id] ??= info.fraction;

            const cell = new St.BoxLayout({
                vertical: vertical, x_align: Clutter.ActorAlign.CENTER,
                opacity: 255,
                style: `spacing: ${Math.round(LAYOUT.ringLabelGap)}px;`,
            });
            const button = new St.Button({
                style_class: 'ledge-cell', can_focus: true, track_hover: true,
                accessible_name: info.accessibleName,
            });
            const inner = new St.BoxLayout({vertical: vertical, x_align: Clutter.ActorAlign.CENTER, style: `spacing: ${Math.round(LAYOUT.ringLabelGap)}px;`});
            const ring = new St.DrawingArea({width: LAYOUT.ringDiameter, height: LAYOUT.ringDiameter, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            ring.connect('repaint', area => {
                const cr = area.get_context();
                const [w, h] = area.get_surface_size();
                drawRing(cr, w, h, this._displayFractions[id] ?? info.fraction, cellTheme, GLib.get_monotonic_time() / 1000000, this._theme);
                cr.$dispose();
            });
            this._rings.push(ring);
            if (info.icon) {
                const holder = new St.Widget({layout_manager: new Clutter.BinLayout(),
                    x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
                holder.add_child(ring);
                holder.add_child(new St.Icon({icon_name: info.icon, icon_size: Math.round(LAYOUT.glyphSize),
                    style_class: 'ledge-cell-icon', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
                inner.add_child(holder);
            } else {
                inner.add_child(ring);
            }
            inner.add_child(new St.Label({text: info.label, style_class: 'ledge-percent', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
            button.set_child(inner);
            button.connect('notify::hover', () => { if (button.hover && !this._overviewActive()) this._showDetail(id); });
            button.connect('key-focus-in', () => { if (!this._overviewActive()) this._showDetail(id); });
            button.connect('clicked', () => {
                if (this._overviewActive()) return;
                this._showDetail(id);
                if (this._autofocus?.get_stage()) this._autofocus.grab_key_focus();
            });
            cell.add_child(button);
            this._stack.add_child(cell);
        });
        const orbSize = Math.ceil(LAYOUT.settingsHotZone);
        this._orb.set_size(orbSize, orbSize);
        this._orbChrome.set_size(orbSize, orbSize);
        this._orbDrawing.set_position((orbSize - 104) / 2, (orbSize - 104) / 2);
        for (const id of enabled)
            if (!this._cellMotion.has(id)) this._cellMotion.set(id, {value: this._expandT, velocity: 0});

        if (focused >= 0 && this._keyboardOpen)
            this._stack.get_children()[Math.min(focused, this._stack.get_n_children() - 1)]?.get_first_child()?.grab_key_focus();
        this._updateMotion();
        this._animateRings();
    }

    _area() {
        const requested = this._settings.get_int('monitor');
        const index = requested >= 0 && requested < Main.layoutManager.monitors.length ? requested : Main.layoutManager.primaryIndex;
        if (index < 0) return null;
        return Main.layoutManager.getWorkAreaForMonitor(index);
    }

    _place() {
        if (this._overviewActive()) this._hideDetail();
        const area = this._area();
        if (!area) return;
        const size = this._notchSize(this._enabled().length);
        const p = position(this._edge(), area, size.width, size.height);
        this._host.set_position(p.x, p.y);

        if (this._orb.visible) {
            const edge = this._edge();
            let ox = p.x, oy = p.y;
            const vertical = this._vertical();
            const {curl} = notchGeometry(vertical ? size.width : size.height, vertical ? size.height : size.width);
            // Same centre as the far inverse corner, not the body centreline.
            if (edge === 'right') { ox += size.width - curl; oy += size.height; }
            else if (edge === 'left') { ox += curl; oy += size.height; }
            else if (edge === 'top') { ox += size.width; oy += curl; }
            else { ox += size.width; oy += size.height - curl; }
            ox -= this._orb.width / 2;
            oy -= this._orb.height / 2;
            this._orbChrome.set_position(Math.round(ox), Math.round(oy));
        }
        this._placeDetail();
    }

    _label(text, style) {
        const label = new St.Label({text, style_class: style});
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        return label;
    }

    _splitRow(leading, trailing, trailingClass = 'ledge-muted') {
        const row = new St.BoxLayout({style: 'spacing: 8px;'});
        row.add_child(this._label(leading, 'ledge-window-title'));
        const tail = this._label(trailing, trailingClass);
        tail.x_expand = true;
        tail.x_align = Clutter.ActorAlign.END;
        row.add_child(tail);
        return row;
    }

    // A labelled progress bar: leading and trailing text, bar, caption below.
    _barRow(leading, trailing, fraction, stale, color, caption) {
        const block = new St.BoxLayout({vertical: true, style_class: 'ledge-window'});
        block.add_child(this._splitRow(leading, trailing));
        const bar = new St.DrawingArea({
            width: LAYOUT.cardWidth - 2 * LAYOUT.cardPadding,
            height: LAYOUT.barHeight + 2,
            style: `margin-top: ${Math.round(LAYOUT.labelToBar)}px; margin-bottom: ${Math.round(LAYOUT.barToUsed)}px;`,
        });
        bar.connect('repaint', area => {
            const cr = area.get_context();
            const [w] = area.get_surface_size();
            drawProgressBar(cr, 0, 1, w, fraction, stale, this._theme.accent(color, 'card'), this._theme.barTrack);
            cr.$dispose();
        });
        block.add_child(bar);
        block.add_child(this._label(caption, 'ledge-window-title'));
        return block;
    }

    _cardUi() {
        return {
            label: (text, style) => this._label(text, style),
            splitRow: (...args) => this._splitRow(...args),
            bar: (...args) => this._barRow(...args),
            box: style => new St.BoxLayout({vertical: true, style}),
            hairline: () => new St.Widget({height: LAYOUT.hairline, style_class: 'ledge-hairline'}),
            button: (label, callback, style = 'ledge-action') => {
                const button = new St.Button({label, style_class: style, can_focus: true});
                button.connect('clicked', () => callback());
                return button;
            },
            iconButton: (iconName, accessibleName, callback) => {
                const button = new St.Button({style_class: 'ledge-icon-button', can_focus: true, accessible_name: accessibleName,
                    child: new St.Icon({icon_name: iconName, icon_size: 14}), y_align: Clutter.ActorAlign.CENTER});
                button.connect('clicked', () => callback());
                return button;
            },
            // A list row: leading actors, optional icon, title, muted detail, trailing actors.
            // With onClick the whole row is one focusable button instead.
            row: (title, {icon = null, detail = '', active = false, dim = false, onClick = null, leading = [], trailing = []} = {}) => {
                const box = new St.BoxLayout({style: 'spacing: 8px;', x_expand: true});
                for (const actor of leading) box.add_child(actor);
                if (icon) box.add_child(new St.Icon({icon_name: icon, icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
                const text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
                text.add_child(this._label(title, dim ? 'ledge-row-title ledge-dim' : 'ledge-row-title'));
                if (detail) text.add_child(this._label(detail, 'ledge-muted'));
                box.add_child(text);
                if (active) box.add_child(new St.Icon({icon_name: 'object-select-symbolic', icon_size: 14, y_align: Clutter.ActorAlign.CENTER}));
                for (const actor of trailing) box.add_child(actor);
                if (!onClick) return box;
                const button = new St.Button({style_class: active ? 'ledge-row ledge-row-active' : 'ledge-row',
                    can_focus: true, x_expand: true, child: box, accessible_name: title});
                button.connect('clicked', () => onClick());
                return button;
            },
            // Text entry; Enter calls onActivate(text, entry).
            entry: (hint, onActivate) => {
                const entry = new St.Entry({hint_text: hint, style_class: 'ledge-entry', can_focus: true, x_expand: true});
                entry.clutter_text.connect('activate', () => onActivate(entry.get_text(), entry));
                return entry;
            },
            // The control a click on the cell focuses, such as an entry.
            autofocus: actor => { this._autofocus = actor; },
        };
    }

    _showDetail(id, refresh = false) {
        const module = this._modules.get(id);
        if (this._overviewActive() || !module) { this._hideDetail(); return; }
        if (this._detail.visible && this._selected === id && !refresh) return;
        const switching = this._detail.visible && this._selected !== id;
        const entering = !this._detail.visible;
        if (entering) this._detailPositioned = false;
        // A rebuilt card keeps keyboard focus on the same control position.
        // St.Entry focuses its inner text actor, so match by containment.
        const focus = global.stage.get_key_focus();
        const focusIndex = refresh && this._detail.contains(focus)
            ? this._focusTargets().findIndex(target => target.contains(focus)) : -1;
        this._mountDetail();
        this._selected = id;
        this._autofocus = null;
        this._detail.destroy_all_children();

        const direction = this._tooltipDirection();
        const horizontal = direction === 'leading' || direction === 'trailing';
        const wrap = new St.BoxLayout({vertical: !horizontal});
        wrap.request_mode = Clutter.RequestMode.HEIGHT_FOR_WIDTH;
        const tail = new St.DrawingArea({
            width: horizontal ? LAYOUT.tailLength : LAYOUT.tailHeight,
            height: horizontal ? LAYOUT.tailHeight : LAYOUT.tailLength,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        tail.connect('repaint', area => {
            const cr = area.get_context();
            const [w, h] = area.get_surface_size();
            drawTooltipTail(cr, w, h, direction, this._theme.card);
            cr.$dispose();
        });

        const card = new St.BoxLayout({vertical: true, style_class: 'ledge-detail',
            width: LAYOUT.cardWidth, style: `spacing: ${LAYOUT.blockSpacing}px; padding: ${LAYOUT.cardPadding}px;`});
        const body = new St.BoxLayout({vertical: true, style: `spacing: ${LAYOUT.blockSpacing}px;`});
        card.add_child(body);
        const header = new St.BoxLayout({style: `spacing: ${Math.round(LAYOUT.headerGap)}px;`});
        const {glyph: glyphKey, icon} = module.cell();
        if (icon) {
            header.add_child(new St.Icon({icon_name: icon, icon_size: Math.round(LAYOUT.glyphSize),
                style_class: 'ledge-cell-icon', y_align: Clutter.ActorAlign.CENTER}));
        } else if (glyphKey) {
            const glyph = new St.DrawingArea({width: LAYOUT.glyphSize, height: LAYOUT.glyphSize, y_align: Clutter.ActorAlign.CENTER});
            glyph.connect('repaint', area => {
                const cr = area.get_context();
                const [w, h] = area.get_surface_size();
                drawGlyph(cr, glyphKey, w / 2, h / 2, LAYOUT.glyphSize, this._theme.textPrimary);
                cr.$dispose();
            });
            header.add_child(glyph);
        }
        header.add_child(this._label(module.heading(), 'ledge-title'));
        body.add_child(header);
        const moduleActions = module.card(body, this._cardUi());

        const actions = new St.BoxLayout({style_class: 'ledge-actions'});
        for (const [label, action] of [...moduleActions, ['Settings', () => this.openPreferences()]]) {
            const button = new St.Button({label, style_class: 'ledge-action', can_focus: true, x_expand: true});
            button.connect('clicked', action);
            actions.add_child(button);
        }
        card.add_child(actions);

        if (direction === 'leading' || direction === 'down') {
            wrap.add_child(card);
            wrap.add_child(tail);
        } else {
            wrap.add_child(tail);
            wrap.add_child(card);
        }
        this._detail.add_child(wrap);
        // Glass cards skip the fade: a translucent parent is painted offscreen,
        // where a background blur would only see an empty buffer.
        if (this._theme.glass) {
            setGlass(card, (w, h) => roundedRectRects(w, h, card.get_theme_node().get_border_radius(St.Corner.TOPLEFT)),
                this._theme.glassParams);
        } else if ((switching || entering) && St.Settings.get().enable_animations) {
            wrap.opacity = 150;
            wrap.ease({opacity: 255, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        }
        this._detail.show();
        this._placeDetail();
        if (focusIndex >= 0) {
            const targets = this._focusTargets();
            (targets[Math.min(focusIndex, targets.length - 1)] ?? this._autofocus)?.grab_key_focus();
        }
    }

    _placeDetail() {
        if (this._overviewActive()) { this._hideDetail(); return; }
        if (!this._detail.visible) return;
        const area = this._area();
        if (!area) return;
        const edge = this._edge();
        const host = this._host;
        let x = host.x, y = host.y;
        const gap = LAYOUT.tailGap;
        if (edge === 'right') x = host.x - this._detail.width - gap;
        else if (edge === 'left') x = host.x + host.width + gap;
        else if (edge === 'top') y = host.y + host.height + gap;
        else y = host.y - this._detail.height - gap;

        if (edge === 'left' || edge === 'right') {
            const idx = this._enabled().indexOf(this._selected);
            const cells = this._stack.get_children();
            if (idx >= 0 && cells[idx]) {
                const cell = cells[idx];
                y = cell.get_transformed_position()[1] + LAYOUT.ringDiameter / 2 - this._detail.height / 2;
            } else {
                y = host.y + host.height / 2 - this._detail.height / 2;
            }
        } else {
            const cell = this._stack.get_children()[this._enabled().indexOf(this._selected)];
            x = cell ? cell.get_transformed_position()[0] + LAYOUT.ringDiameter / 2 - this._detail.width / 2
                : host.x + host.width / 2 - this._detail.width / 2;
        }
        // Cells rebuilt this frame have no position yet; the card's own
        // allocation signal places it again once layout has run.
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const nextX = Math.round(Math.max(area.x, Math.min(x, area.x + area.width - this._detail.width)));
        const nextY = Math.round(Math.max(area.y, Math.min(y, area.y + area.height - this._detail.height)));
        if (nextX === this._detail.x && nextY === this._detail.y && this._detailPositioned) return;
        const oldX = this._detail.x + this._detail.translation_x;
        const oldY = this._detail.y + this._detail.translation_y;
        const animate = this._detailPositioned && St.Settings.get().enable_animations;
        this._detail.remove_all_transitions();
        this._detail.set_position(nextX, nextY);
        this._detail.translation_x = animate ? oldX - nextX : 0;
        this._detail.translation_y = animate ? oldY - nextY : 0;
        this._detailPositioned = true;
        if (animate) this._detail.ease({translation_x: 0, translation_y: 0,
            duration: 200, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    }

    disable() {
        if (!this._alive) return;
        this._alive = false;
        for (const module of this._modules.values()) module.stop();
        this._modules.clear();
        closeHttp();
        for (const timer of [this._hideTimer, this._animation, this._motionTimer, this._orbTimer, this._changeIdle])
            if (timer) GLib.Source.remove(timer);
        this._hideTimer = this._animation = this._motionTimer = this._orbTimer = this._changeIdle = 0;
        Main.wm.removeKeybinding('toggle-notch');
        if (this._monitorSignal) Main.layoutManager.disconnect(this._monitorSignal);
        if (this._workSignal) global.display.disconnect(this._workSignal);
        if (this._workspaceSignal) global.workspace_manager.disconnect(this._workspaceSignal);
        this._workspaceSignal = 0;
        if (this._overviewShowingSignal) Main.overview.disconnect(this._overviewShowingSignal);
        if (this._overviewHidingSignal) Main.overview.disconnect(this._overviewHidingSignal);
        if (this._overviewHiddenSignal) Main.overview.disconnect(this._overviewHiddenSignal);
        if (this._settingsSignal) this._settings.disconnect(this._settingsSignal);
        if (this._focusSignal) global.stage.disconnect(this._focusSignal);
        this._focusSignal = 0;
        if (this._detailMounted) Main.layoutManager.removeChrome(this._detail);
        Main.layoutManager.removeChrome(this._orbChrome);
        this._appearance?.destroy();
        this._appearance = null;
        if (this._host) setGlass(this._host, null, null);
        this._host?.destroy();
        this._detail?.destroy();
        this._orbChrome?.destroy();
        this._host = this._detail = this._orb = this._orbChrome = this._settings = null;
        this._moduleHost = null;
        this._displayFractions = {};
        this._rings = [];
        this._keyboardOpen = false;
    }
}
