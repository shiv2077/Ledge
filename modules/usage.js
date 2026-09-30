import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Module} from '../lib/module.js';
import {run} from '../lib/subprocess.js';
import {PROVIDERS, NAMES, percentage, resetText, normalize, usageSummary, remainingPercent} from '../model.js';
import {PROVIDER_COLORS} from '../design.js';

const MAX_OUTPUT = 131072;
const SIGTERM = 15;

// One reader process serves every enabled usage cell. Created by the first
// usage module to start and destroyed when the last one stops.
let source = null;
export const usageSource = () => source;

class UsageSource {
    constructor(host) {
        this.host = host;
        this.settings = host.settings;
        this.members = new Map();
        this.readings = [];
        this.activities = [];
        this.refreshing = new Set();
        this._generation = 0;
        this._activityGeneration = 0;
        this._settingsSignal = this.settings.connect('changed', (_s, key) => {
            if (key === 'demo') this._queueRestart();
            if (key === 'poll-seconds') this._schedule();
        });
        this._schedule();
        this._activityPoll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this.refreshActivity();
            return GLib.SOURCE_CONTINUE;
        });
    }

    ids() { return PROVIDERS.filter(id => this.members.has(id)); }

    add(module) {
        this.members.set(module.id, module);
        this._queueRestart();
    }

    remove(module) {
        this.members.delete(module.id);
        // A provider switched off drops its cache; extension disable keeps it.
        if (this.settings.get_boolean(module.id)) return;
        for (const suffix of ['.json', '.backoff.json']) {
            const file = Gio.File.new_for_path(`${GLib.get_user_cache_dir()}/ledge/${module.id}${suffix}`);
            file.delete_async(GLib.PRIORITY_DEFAULT, null, (f, r) => {
                try { f.delete_finish(r); } catch { /* Cache may not exist. */ }
            });
        }
        if (this.members.size) this._queueRestart();
    }

    // Coalesces the starts of several usage modules into one read.
    _queueRestart() {
        if (this._restartIdle) return;
        this._restartIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._restartIdle = 0;
            this._cancelRead();
            this._cancelActivity();
            this.readings = [];
            this.activities = [];
            this._notify();
            this.refresh();
            this.refreshActivity();
            return GLib.SOURCE_REMOVE;
        });
    }

    _schedule() {
        if (this._poll) GLib.Source.remove(this._poll);
        this._poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this.settings.get_int('poll-seconds'), () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _notify() {
        for (const module of this.members.values()) module.changed();
    }

    _args(script) {
        const args = ['/usr/bin/python3', `${this.host.path}/reader/${script}`, '--providers', this.ids().join(',')];
        if (this.settings.get_boolean('demo')) args.push('--demo');
        return args;
    }

    _cancelRead() {
        this._generation++;
        this._readCancel?.cancel();
        this._readCancel = null;
        this.refreshing.clear();
    }

    refresh() {
        if (this._readCancel || !this.members.size) return;
        const generation = ++this._generation;
        for (const id of this.ids()) this.refreshing.add(id);
        this._readCancel = new Gio.Cancellable();
        run(this._args('usage_reader.py'), {timeout: 55, signal: SIGTERM, cancellable: this._readCancel}).then(result => {
            if (generation !== this._generation) return;
            this._readCancel = null;
            this.refreshing.clear();
            try {
                if (!result.ok || result.stdout.length > MAX_OUTPUT) throw new Error('Reader failed');
                this.readings = normalize(JSON.parse(result.stdout), this.ids());
            } catch {
                this._readerFailed();
            }
            this._notify();
        });
    }

    _readerFailed() {
        this.readings = this.ids().map(id => ({
            ...(this.readings.find(p => p.id === id) ?? {id, name: NAMES[id], windows: []}),
            status: 'stale', message: 'Usage reader failed. Check Python 3 is installed, then refresh.',
        }));
    }

    _cancelActivity() {
        this._activityGeneration++;
        this._activityCancel?.cancel();
        this._activityCancel = null;
    }

    refreshActivity() {
        if (this._activityCancel || !this.members.size) return;
        const generation = ++this._activityGeneration;
        this._activityCancel = new Gio.Cancellable();
        run(this._args('activity.py'), {timeout: 4, cancellable: this._activityCancel}).then(result => {
            if (generation !== this._activityGeneration) return;
            this._activityCancel = null;
            let activities = [];
            try {
                if (!result.ok || result.stdout.length > MAX_OUTPUT) throw new Error('Activity reader failed');
                const data = JSON.parse(result.stdout);
                if (data.version !== 1 || !Array.isArray(data.providers)) throw new Error('Invalid activity');
                activities = data.providers.filter(row => this.members.has(row.id)).map(row => ({
                    id: row.id,
                    sessions: (Array.isArray(row.sessions) ? row.sessions : []).filter(s => ['busy', 'waiting', 'idle'].includes(s?.state)).slice(0, 12)
                        .map(s => ({state: s.state, name: String(s.name || 'Session').slice(0, 100), detail: String(s.detail || '').slice(0, 160),
                            waitingFor: s.waitingFor ? String(s.waitingFor).slice(0, 160) : '', derived: s.derived === true})),
                }));
            } catch { /* Missing activity is unknown. */ }
            if (JSON.stringify(activities) !== JSON.stringify(this.activities)) {
                this.activities = activities;
                this._notify();
            }
        });
    }

    sessions(id) { return this.activities.find(p => p.id === id)?.sessions ?? []; }

    destroy() {
        this._cancelRead();
        this._cancelActivity();
        for (const timer of [this._poll, this._activityPoll, this._restartIdle])
            if (timer) GLib.Source.remove(timer);
        this._poll = this._activityPoll = this._restartIdle = 0;
        this.settings.disconnect(this._settingsSignal);
        this.members.clear();
    }
}

class UsageModule extends Module {
    start() {
        source ??= new UsageSource(this.host);
        source.add(this);
    }

    stop() {
        source?.remove(this);
        if (source && !source.members.size) {
            source.destroy();
            source = null;
        }
    }

    _reading() { return source?.readings.find(p => p.id === this.id); }

    cell() {
        const reading = this._reading();
        const remaining = remainingPercent(reading?.windows?.[0]?.usedPercent);
        const stale = reading?.status !== 'ok';
        const sessions = source?.sessions(this.id) ?? [];
        return {
            fraction: remaining === null ? null : remaining / 100,
            label: percentage(remaining), stale, accent: PROVIDER_COLORS[this.id], glyph: this.id, sessions,
            animating: sessions.some(s => s.state !== 'idle') || (source?.refreshing.size ?? 0) > 0,
            accessibleName: `${NAMES[this.id]}: ${percentage(remaining)} left${stale ? ', reading unavailable or stale' : ''}`,
        };
    }

    heading() { return `${NAMES[this.id]} Usage`; }

    card(body, ui) {
        if (this.host.settings.get_boolean('demo'))
            body.add_child(ui.label('Demo · sample readings', 'ledge-warning'));
        const p = this._reading();
        const stale = p?.status !== 'ok';
        if (!p) body.add_child(ui.label('Reading usage…', 'ledge-muted'));
        else {
            if (stale || p.message)
                body.add_child(ui.label(`${p.status === 'stale' ? 'Stale · ' : ''}${p.message || 'Usage unavailable'}`, 'ledge-warning'));
            for (const w of p.windows) {
                const remaining = remainingPercent(w.usedPercent);
                body.add_child(ui.bar(w.label, resetText(w.resetsAt), remaining === null ? null : remaining / 100,
                    stale, PROVIDER_COLORS[this.id], usageSummary(w.usedPercent)));
            }
            const metadata = ui.box('spacing: 4px;');
            if (p.source) metadata.add_child(ui.label(p.source, 'ledge-muted'));
            if (p.updatedAt && Number.isFinite(Date.parse(p.updatedAt)))
                metadata.add_child(ui.label(`Read ${new Date(p.updatedAt).toLocaleString()}`, 'ledge-muted'));
            if (metadata.get_n_children()) body.add_child(metadata);
            else metadata.destroy();
        }

        const sessions = source?.sessions(this.id) ?? [];
        if (sessions.length) {
            body.add_child(ui.hairline());
            for (const session of sessions.slice(0, 4)) {
                const state = session.state === 'waiting' ? 'waiting' : session.state === 'busy' ? 'working' : 'idle';
                body.add_child(ui.splitRow(session.name, state, state === 'waiting' ? 'ledge-warning' : 'ledge-window-title'));
                if (session.waitingFor || session.detail)
                    body.add_child(ui.label(session.waitingFor || session.detail, 'ledge-muted'));
            }
            if (sessions.length > 4)
                body.add_child(ui.label(`and ${sessions.length - 4} more`, 'ledge-muted'));
        }
        return [['Refresh', () => source?.refresh()]];
    }
}

const usageModule = id => class extends UsageModule {
    static id = id;
    static title = NAMES[id];
};

export const USAGE_MODULES = PROVIDERS.map(usageModule);
