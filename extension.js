import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {PROVIDERS, NAMES, position, percentage, resetText, normalize, usageSummary, remainingPercent} from './model.js';
import {LAYOUT, shapeLength, springSample, clampUnit, notchGeometry} from './design.js';
import {drawFilledPath, traceNotchPath, drawRing, drawProgressBar, drawTooltipTail, drawGlyph, drawSettings, drawSettingsGlyph} from './draw.js';

export default class Ledge extends Extension {
    enable() {
        this._alive = true;
        this._generation = 0;
        this._readings = [];
        this._activities = [];
        this._rings = [];
        this._displayPercents = {};
        this._settings = this.getSettings();
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
        this._refreshing = new Set();

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
            drawSettingsGlyph(cr, area.get_surface_size()[0]);
            cr.$dispose();
        });
        this._orbGlyph.set_pivot_point(0.5, 0.5);
        this._orb.set_child(this._orbGlyph);
        this._orbDrawing.connect('repaint', area => {
            const cr = area.get_context();
            drawSettings(cr, area.get_surface_size()[0], this._edge(), this._orbT, this._orbReveal);
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
            drawFilledPath(cr, traceNotchPath, w, h, this._edge());
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
        this._overviewShowingSignal = Main.overview.connect('showing', () => this._onOverviewShowing());
        this._overviewHidingSignal = Main.overview.connect('hiding', () => this._onOverviewHiding());
        this._overviewHiddenSignal = Main.overview.connect('hidden', () => this._onOverviewHidden());
        if (Main.overview.visibleTarget) this._onOverviewShowing();

        this._settingsSignal = this._settings.connect('changed', (_s, key) => {
            this._hideDetail();
            this._expanded = this._settings.get_boolean('always-show');
            this._expandTarget = this._expanded ? 1 : 0;
            if (PROVIDERS.includes(key) || key === 'demo') {
                this._cancelRead();
                this._cancelActivity();
                this._readings = [];
                this._activities = [];
                if (PROVIDERS.includes(key) && !this._settings.get_boolean(key)) {
                    for (const suffix of ['.json', '.backoff.json']) {
                        const file = Gio.File.new_for_path(`${GLib.get_user_cache_dir()}/ledge/${key}${suffix}`);
                        file.delete_async(GLib.PRIORITY_DEFAULT, null, (f, r) => {
                            try { f.delete_finish(r); } catch { /* Cache may not exist. */ }
                        });
                    }
                }
                this._refresh();
                this._refreshActivity();
            }
            this._render();
            if (key === 'poll-seconds') this._schedule();
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

        this._render();
        this._schedule();
        this._refresh();
        this._refreshActivity();
        this._activityPoll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._refreshActivity();
            return GLib.SOURCE_CONTINUE;
        });
        this._animateMotion();
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

    _cancelActivity() {
        this._activityGeneration = (this._activityGeneration ?? 0) + 1;
        this._activityCancel?.cancel();
        this._activityProcess?.force_exit();
        this._activityProcess = this._activityCancel = null;
        if (this._activityWatchdog) GLib.Source.remove(this._activityWatchdog);
        this._activityWatchdog = 0;
    }

    _refreshActivity() {
        if (!this._alive || this._activityProcess) return;
        const generation = this._activityGeneration = (this._activityGeneration ?? 0) + 1;
        const args = ['/usr/bin/python3', `${this.path}/reader/activity.py`, '--providers', this._enabled().join(',')];
        if (this._settings.get_boolean('demo')) args.push('--demo');
        try {
            const proc = Gio.Subprocess.new(args, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._activityProcess = proc;
            this._activityCancel = new Gio.Cancellable();
            this._activityWatchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
                this._activityWatchdog = 0;
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            proc.communicate_utf8_async(null, this._activityCancel, (p, result) => {
                if (!this._alive || generation !== this._activityGeneration) return;
                if (this._activityWatchdog) GLib.Source.remove(this._activityWatchdog);
                this._activityWatchdog = 0;
                this._activityProcess = this._activityCancel = null;
                let activities = [];
                try {
                    const [, stdout] = p.communicate_utf8_finish(result);
                    if (!p.get_successful() || stdout.length > 131072) throw new Error('Activity reader failed');
                    const data = JSON.parse(stdout);
                    if (data.version !== 1 || !Array.isArray(data.providers)) throw new Error('Invalid activity');
                    activities = data.providers.filter(row => this._enabled().includes(row.id)).map(row => ({
                        id: row.id,
                        sessions: (Array.isArray(row.sessions) ? row.sessions : []).filter(s => ['busy', 'waiting', 'idle'].includes(s?.state)).slice(0, 12)
                            .map(s => ({state: s.state, name: String(s.name || 'Session').slice(0, 100), detail: String(s.detail || '').slice(0, 160),
                                waitingFor: s.waitingFor ? String(s.waitingFor).slice(0, 160) : '', derived: s.derived === true})),
                    }));
                } catch { /* Missing activity is unknown. */ }
                if (JSON.stringify(activities) !== JSON.stringify(this._activities)) {
                    this._activities = activities;
                    this._render();
                    if (!this._overviewActive() && this._detail.visible && this._selected) this._showDetail(this._selected, true);
                }
            });
        } catch { this._activityProcess = null; }
    }

    _sessions(id) { return this._activities.find(p => p.id === id)?.sessions ?? []; }

    _animateRings() {
        if (this._animation) GLib.Source.remove(this._animation);
        this._animation = 0;
        const needsMotion = this._expandT > 0.5 || this._orbHover ||
            this._activities.some(p => p.sessions.some(s => s.state !== 'idle')) ||
            this._refreshing.size > 0;
        if (!needsMotion || !St.Settings.get().enable_animations) return;
        this._animation = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            for (const id of this._enabled()) {
                const reading = this._readings.find(p => p.id === id);
                const target = reading?.windows?.[0]?.usedPercent;
                if (typeof target === 'number') {
                    const cur = this._displayPercents[id] ?? target;
                    this._displayPercents[id] = cur + (target - cur) * 0.12;
                }
            }
            this._notchBg.queue_repaint();
            for (const ring of this._rings) ring.queue_repaint();
            return GLib.SOURCE_CONTINUE;
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
            const actions = card?.get_last_child();
            if (actions)
                targets.push(...actions.get_children().filter(a => a.can_focus));
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

    _enabled() { return PROVIDERS.filter(id => this._settings.get_boolean(id)); }

    _schedule() {
        if (this._poll) GLib.Source.remove(this._poll);
        this._poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._settings.get_int('poll-seconds'), () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _cancelRead() {
        this._generation++;
        if (this._watchdog) GLib.Source.remove(this._watchdog);
        this._watchdog = 0;
        this._cancel?.cancel();
        this._process?.send_signal(15);
        this._process = null;
        this._cancel = null;
        this._refreshing.clear();
    }

    _refresh() {
        if (!this._alive || this._process) return;
        const generation = ++this._generation;
        for (const id of this._enabled()) this._refreshing.add(id);
        const args = ['/usr/bin/python3', `${this.path}/reader/usage_reader.py`, '--providers', this._enabled().join(',')];
        if (this._settings.get_boolean('demo')) args.push('--demo');
        try {
            const process = new Gio.Subprocess({argv: args, flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE});
            process.init(null);
            this._process = process;
            this._cancel = new Gio.Cancellable();
            this._watchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 55, () => {
                this._watchdog = 0;
                process.send_signal(15);
                return GLib.SOURCE_REMOVE;
            });
            process.communicate_utf8_async(null, this._cancel, (proc, result) => {
                if (!this._alive || generation !== this._generation) return;
                if (this._watchdog) GLib.Source.remove(this._watchdog);
                this._watchdog = 0;
                this._process = null;
                this._cancel = null;
                this._refreshing.clear();
                try {
                    const [, stdout] = proc.communicate_utf8_finish(result);
                    if (!proc.get_successful() || stdout.length > 131072) throw new Error('Reader failed');
                    this._readings = normalize(JSON.parse(stdout), this._enabled());
                } catch {
                    this._readerFailed();
                }
                this._render();
                if (!this._overviewActive() && this._detail.visible && this._selected)
                    this._showDetail(this._selected, true);
            });
        } catch {
            this._process = null;
            this._refreshing.clear();
            this._readerFailed();
            this._render();
        }
    }

    _readerFailed() {
        this._readings = this._enabled().map(id => ({
            ...(this._readings.find(p => p.id === id) ?? {id, name: NAMES[id], windows: []}),
            status: 'stale', message: 'Usage reader failed. Check Python 3 is installed, then refresh.',
        }));
    }

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
                if (!this._keyboardOpen && !this._host.hover && !this._detail.hover && !this._orb.hover) {
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
            const reading = this._readings.find(p => p.id === id);
            const value = reading?.windows?.[0]?.usedPercent;
            const stale = reading?.status !== 'ok';
            const display = this._displayPercents[id] ?? value;
            if (typeof value === 'number') this._displayPercents[id] = display ?? value;

            const cell = new St.BoxLayout({
                vertical: vertical, x_align: Clutter.ActorAlign.CENTER,
                opacity: 255,
                style: `spacing: ${Math.round(LAYOUT.ringLabelGap)}px;`,
            });
            const button = new St.Button({
                style_class: 'ledge-cell', can_focus: true, track_hover: true,
                accessible_name: `${NAMES[id]}: ${percentage(remainingPercent(value))} left${stale ? ', reading unavailable or stale' : ''}`,
            });
            const inner = new St.BoxLayout({vertical: vertical, x_align: Clutter.ActorAlign.CENTER, style: `spacing: ${Math.round(LAYOUT.ringLabelGap)}px;`});
            const ring = new St.DrawingArea({width: LAYOUT.ringDiameter, height: LAYOUT.ringDiameter, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            ring.connect('repaint', area => {
                const cr = area.get_context();
                const [w, h] = area.get_surface_size();
                drawRing(cr, w, h, this._displayPercents[id] ?? value, stale, GLib.get_monotonic_time() / 1000000, this._sessions(id), id);
                cr.$dispose();
            });
            this._rings.push(ring);
            inner.add_child(ring);
            inner.add_child(new St.Label({text: percentage(remainingPercent(value)), style_class: 'ledge-percent', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
            button.set_child(inner);
            button.connect('notify::hover', () => { if (button.hover && !this._overviewActive()) this._showDetail(id); });
            button.connect('key-focus-in', () => { if (!this._overviewActive()) this._showDetail(id); });
            button.connect('clicked', () => { if (!this._overviewActive()) this._showDetail(id); });
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

    _barRow(window, stale, providerId) {
        const block = new St.BoxLayout({vertical: true, style_class: 'ledge-window'});
        block.add_child(this._splitRow(window.label, resetText(window.resetsAt)));
        const bar = new St.DrawingArea({
            width: LAYOUT.cardWidth - 2 * LAYOUT.cardPadding,
            height: LAYOUT.barHeight + 2,
            style: `margin-top: ${Math.round(LAYOUT.labelToBar)}px; margin-bottom: ${Math.round(LAYOUT.barToUsed)}px;`,
        });
        const fraction = remainingPercent(window.usedPercent) === null ? null : remainingPercent(window.usedPercent) / 100;
        bar.connect('repaint', area => {
            const cr = area.get_context();
            const [w] = area.get_surface_size();
            drawProgressBar(cr, 0, 1, w, fraction, stale, providerId);
            cr.$dispose();
        });
        block.add_child(bar);
        block.add_child(this._label(usageSummary(window.usedPercent), 'ledge-window-title'));
        return block;
    }

    _showDetail(id, refresh = false) {
        if (this._overviewActive()) { this._hideDetail(); return; }
        if (this._detail.visible && this._selected === id && !refresh) return;
        const switching = this._detail.visible && this._selected !== id;
        const entering = !this._detail.visible;
        if (entering) this._detailPositioned = false;
        this._mountDetail();
        this._selected = id;
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
            drawTooltipTail(cr, w, h, direction);
            cr.$dispose();
        });

        const card = new St.BoxLayout({vertical: true, style_class: 'ledge-detail',
            width: LAYOUT.cardWidth, style: `spacing: ${LAYOUT.blockSpacing}px; padding: ${LAYOUT.cardPadding}px;`});
        const body = new St.BoxLayout({vertical: true, style: `spacing: ${LAYOUT.blockSpacing}px;`});
        card.add_child(body);
        const p = this._readings.find(r => r.id === id);
        const stale = p?.status !== 'ok';

        const header = new St.BoxLayout({style: `spacing: ${Math.round(LAYOUT.headerGap)}px;`});
        const glyph = new St.DrawingArea({width: LAYOUT.glyphSize, height: LAYOUT.glyphSize, y_align: Clutter.ActorAlign.CENTER});
        glyph.connect('repaint', area => {
            const cr = area.get_context();
            const [w, h] = area.get_surface_size();
            drawGlyph(cr, id, w / 2, h / 2, LAYOUT.glyphSize);
            cr.$dispose();
        });
        header.add_child(glyph);
        header.add_child(this._label(`${NAMES[id]} Usage`, 'ledge-title'));
        body.add_child(header);

        if (this._settings.get_boolean('demo'))
            body.add_child(this._label('Demo · sample readings', 'ledge-warning'));
        if (!p) body.add_child(this._label('Reading usage…', 'ledge-muted'));
        else {
            if (stale || p.message)
                body.add_child(this._label(`${p.status === 'stale' ? 'Stale · ' : ''}${p.message || 'Usage unavailable'}`, 'ledge-warning'));
            for (const w of p.windows)
                body.add_child(this._barRow(w, stale, id));
            const metadata = new St.BoxLayout({vertical: true, style: 'spacing: 4px;'});
            if (p.source) metadata.add_child(this._label(p.source, 'ledge-muted'));
            if (p.updatedAt && Number.isFinite(Date.parse(p.updatedAt)))
                metadata.add_child(this._label(`Read ${new Date(p.updatedAt).toLocaleString()}`, 'ledge-muted'));
            if (metadata.get_n_children()) body.add_child(metadata);
            else metadata.destroy();
        }

        const sessions = this._sessions(id);
        if (sessions.length) {
            const rule = new St.Widget({height: LAYOUT.hairline, style_class: 'ledge-hairline'});
            body.add_child(rule);
            for (const session of sessions.slice(0, 4)) {
                const state = session.state === 'waiting' ? 'waiting' : session.state === 'busy' ? 'working' : 'idle';
                body.add_child(this._splitRow(session.name, state, state === 'waiting' ? 'ledge-warning' : 'ledge-window-title'));
                if (session.waitingFor || session.detail)
                    body.add_child(this._label(session.waitingFor || session.detail, 'ledge-muted'));
            }
            if (sessions.length > 4)
                body.add_child(this._label(`and ${sessions.length - 4} more`, 'ledge-muted'));
        }

        const actions = new St.BoxLayout({style_class: 'ledge-actions'});
        for (const [label, action] of [['Refresh', () => this._refresh()], ['Settings', () => this.openPreferences()]]) {
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
        if ((switching || entering) && St.Settings.get().enable_animations) {
            wrap.opacity = 150;
            wrap.ease({opacity: 255, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        }
        this._detail.show();
        this._placeDetail();
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
        this._cancelRead();
        this._cancelActivity();
        for (const timer of [this._poll, this._hideTimer, this._activityPoll, this._animation, this._motionTimer, this._orbTimer])
            if (timer) GLib.Source.remove(timer);
        this._poll = this._hideTimer = this._activityPoll = this._animation = this._motionTimer = this._orbTimer = 0;
        Main.wm.removeKeybinding('toggle-notch');
        if (this._monitorSignal) Main.layoutManager.disconnect(this._monitorSignal);
        if (this._workSignal) global.display.disconnect(this._workSignal);
        if (this._workspaceSignal) global.workspace_manager.disconnect(this._workspaceSignal);
        this._workspaceSignal = 0;
        if (this._overviewShowingSignal) Main.overview.disconnect(this._overviewShowingSignal);
        if (this._overviewHidingSignal) Main.overview.disconnect(this._overviewHidingSignal);
        if (this._overviewHiddenSignal) Main.overview.disconnect(this._overviewHiddenSignal);
        if (this._settingsSignal) this._settings.disconnect(this._settingsSignal);
        if (this._detailMounted) Main.layoutManager.removeChrome(this._detail);
        Main.layoutManager.removeChrome(this._orbChrome);
        this._host?.destroy();
        this._detail?.destroy();
        this._orbChrome?.destroy();
        this._host = this._detail = this._orb = this._orbChrome = this._settings = null;
        this._readings = [];
        this._activities = [];
        this._rings = [];
        this._keyboardOpen = false;
    }
}
