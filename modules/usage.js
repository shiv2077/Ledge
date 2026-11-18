import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Module} from '../lib/module.js';
import {run} from '../lib/subprocess.js';
import {sessionEvents, limitAlerts} from '../lib/alerts.js';
import {raiseSession} from '../lib/windows.js';
import {PROVIDERS, NAMES, BADGES, percentage, resetText, normalize, usageSummary, remainingPercent,
    accountKey, accountName, paceDeficit, paceText, headlineWindow, money, resetShort} from '../model.js';
import {PROVIDER_COLORS} from '../design.js';

const MAX_OUTPUT = 131072;
const SIGTERM = 15;
// Spend is re-read every ten minutes; a warm read takes well under a second.
const COST_SECONDS = 600;
const COST_TIMEOUT = 30;
const COST_PROVIDERS = ['claude', 'codex'];

// One reader process serves every enabled usage cell. Created by the first
// usage module to start and destroyed when the last one stops.
let source = null;
export const usageSource = () => source;

// Which limit steps each provider's headline window has reached. Kept at
// module scope: the extension is disabled while the screen is locked, and
// a crossing must not be announced again after unlocking.
const limits = new Map();

function notify(title, body) {
    const tray = MessageTray.getSystemSource();
    tray.addNotification(new MessageTray.Notification({source: tray, title, body}));
}

class UsageSource {
    constructor(host) {
        this.host = host;
        this.settings = host.settings;
        this.members = new Map();
        this.readings = [];
        this.activities = [];
        this.refreshing = new Set();
        // Last state of each session, per provider; empty until the first reading.
        this._history = new Map();
        this._generation = 0;
        this._activityGeneration = 0;
        this.costs = null;
        this._settingsSignal = this.settings.connect('changed', (_s, key) => {
            if (key === 'demo') this._queueRestart();
            if (key === 'poll-seconds') this._schedule();
            if (key === 'costs') this.refreshCosts();
            if (key === 'headline-window') this._checkLimits();
        });
        this._costPoll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, COST_SECONDS, () => {
            this.refreshCosts();
            return GLib.SOURCE_CONTINUE;
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
            this.refreshCosts();
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
                this._checkLimits();
            } catch {
                this._readerFailed();
            }
            this._notify();
        });
    }

    // One notification per crossing of 80 and 100 % used on a provider's
    // headline window, unless the provider is muted.
    _checkLimits() {
        const muted = this.settings.get_strv('alerts-muted');
        const choice = this.settings.get_string('headline-window');
        for (const reading of this.readings) {
            const window = headlineWindow(reading.windows, choice);
            if (reading.status !== 'ok' || !window) continue;
            const key = accountKey(reading);
            const {alerts, state} = limitAlerts(limits.get(key) ?? null, window);
            limits.set(key, state);
            if (!this.settings.get_boolean('limit-notifications') || muted.includes(reading.id) || muted.includes(key) || !alerts.length) continue;
            const step = Math.max(...alerts);
            const name = reading.account ? `${NAMES[reading.id]} (${accountName(reading.account)})` : NAMES[reading.id];
            notify(step >= 100 ? `${name} limit reached` : `${name} at ${step}%`,
                `${window.label}: ${usageSummary(window.usedPercent)} · ${resetText(window.resetsAt, Date.now(), this.settings.get_string('reset-format'))}`);
        }
    }

    _readerFailed() {
        const ids = this.ids();
        const kept = this.readings.filter(p => ids.includes(p.id));
        for (const id of ids)
            if (!kept.some(p => p.id === id && !p.account)) kept.push({id, account: null, name: NAMES[id], windows: []});
        this.readings = kept.map(p => ({...p,
            status: 'stale', message: 'usage reader failed · check that Python 3 is installed, then refresh'}));
    }

    // Estimated spend from local transcripts, at low priority. Off, or with
    // neither Claude nor Codex on, it reads nothing.
    refreshCosts() {
        const wanted = this.settings.get_boolean('costs') && COST_PROVIDERS.some(id => this.members.has(id));
        if (!wanted) {
            this._costCancel?.cancel();
            this._costCancel = null;
            if (this.costs) { this.costs = null; this._notify(); }
            return;
        }
        if (this._costCancel) return;
        const cancellable = this._costCancel = new Gio.Cancellable();
        const args = ['/usr/bin/nice', '-n', '19', '/usr/bin/python3', `${this.host.path}/reader/costs.py`];
        if (this.settings.get_boolean('demo')) args.push('--demo');
        run(args, {timeout: COST_TIMEOUT, cancellable}).then(result => {
            if (cancellable !== this._costCancel) return;
            this._costCancel = null;
            let costs = null;
            try {
                if (!result.ok || result.stdout.length > MAX_OUTPUT) throw new Error('Cost reader failed');
                const data = JSON.parse(result.stdout);
                if (data?.version === 1 && data.providers && typeof data.label === 'string') costs = data;
            } catch { /* Spend stays unknown. */ }
            this.costs = costs;
            this._notify();
        });
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
            let data = null;
            try {
                if (!result.ok || result.stdout.length > MAX_OUTPUT) throw new Error('Activity reader failed');
                data = JSON.parse(result.stdout);
            } catch { /* Missing activity is unknown. */ }
            this.ingestActivity(data);
        });
    }

    // Applies an activity document and announces session changes. The
    // smoke test feeds scripted documents through here too.
    ingestActivity(data) {
        let activities = [];
        if (data?.version === 1 && Array.isArray(data.providers)) {
            activities = data.providers.filter(row => this.members.has(row?.id)).map(row => ({
                id: row.id,
                sessions: (Array.isArray(row.sessions) ? row.sessions : []).filter(s => ['busy', 'waiting', 'idle'].includes(s?.state)).slice(0, 12)
                    .map(s => ({id: String(s.id || '').slice(0, 128), state: s.state,
                        pid: Number.isInteger(s.pid) && s.pid > 0 ? s.pid : null, cwd: typeof s.cwd === 'string' ? s.cwd.slice(0, 4096) : '',
                        name: String(s.name || 'Session').slice(0, 100), detail: String(s.detail || '').slice(0, 160),
                        waitingFor: s.waitingFor ? String(s.waitingFor).slice(0, 160) : '', derived: s.derived === true})),
            }));
        }
        for (const id of this.ids()) {
            const sessions = activities.find(row => row.id === id)?.sessions;
            // A provider with no reading keeps its history; its sessions are unknown, not gone.
            if (!sessions) continue;
            const {events, next} = sessionEvents(this._history.get(id) ?? null, sessions);
            this._history.set(id, next);
            for (const event of events) this.host.alert?.({...event, key: id});
        }
        if (JSON.stringify(activities) !== JSON.stringify(this.activities)) {
            this.activities = activities;
            this._notify();
        }
    }

    sessions(id) { return this.activities.find(p => p.id === id)?.sessions ?? []; }

    destroy() {
        this._cancelRead();
        this._cancelActivity();
        this._costCancel?.cancel();
        this._costCancel = null;
        for (const timer of [this._poll, this._activityPoll, this._restartIdle, this._costPoll])
            if (timer) GLib.Source.remove(timer);
        this._poll = this._activityPoll = this._restartIdle = this._costPoll = 0;
        this.settings.disconnect(this._settingsSignal);
        this.members.clear();
    }
}

class UsageModule extends Module {
    // Raises the window that runs `session`, or says it cannot be found.
    async raise(session) {
        const id = session.id || session.name;
        const raised = await raiseSession(session, this.cancellable);
        if (this.cancellable.is_cancelled()) return raised;
        if (raised === this._lost.has(id)) {
            if (raised) this._lost.delete(id);
            else this._lost.add(id);
            this.changed();
        }
        return raised;
    }

    start() {
        this._lost = new Set();
        source ??= new UsageSource(this.host);
        source.add(this);
    }

    stop() {
        source?.remove(this);
        if (source && !source.members.size) {
            source.destroy();
            source = null;
        }
        super.stop();
    }

    // This provider's readings: the default sign-in first, then extra
    // accounts not hidden in preferences.
    _readings() {
        const hidden = this.settings.get_strv('hidden-accounts');
        return (source?.readings ?? []).filter(p => p.id === this.id && !(p.account && hidden.includes(accountKey(p))));
    }

    _reading(key = this.id) {
        return this._readings().find(p => accountKey(p) === key)
            ?? (key === this.id ? {id: this.id, account: null, name: NAMES[this.id], status: 'loading', windows: []} : null);
    }

    cells() {
        const readings = this._readings();
        if (!readings.some(p => !p.account)) readings.unshift(this._reading());
        return readings.map(reading => ({key: accountKey(reading), info: this._info(reading)}));
    }

    cell() { return this._info(this._reading()); }

    _info(reading) {
        const window = headlineWindow(reading?.windows, this.settings.get_string('headline-window'));
        const remaining = remainingPercent(window?.usedPercent);
        const spent = remaining === 0 && this.settings.get_boolean('grey-when-spent');
        const stale = reading?.status !== 'ok' || spent;
        // Sessions and their light belong to the default sign-in.
        const sessions = reading?.account ? [] : source?.sessions(this.id) ?? [];
        const updated = Date.parse(reading?.updatedAt);
        const account = reading?.account ? ` ${accountName(reading.account)}` : '';
        return {
            ...super.cell(), meter: true, fraction: remaining === null ? null : remaining / 100,
            label: percentage(remaining), stale, accent: PROVIDER_COLORS[this.id], sessions,
            badge: reading?.account ? `${BADGES[this.id][0]}${reading.account[0].toUpperCase()}` : BADGES[this.id],
            light: sessions.some(s => s.state === 'waiting') ? 'waiting' : sessions.some(s => s.state === 'busy') ? 'working' : 'off',
            updatedAt: Number.isFinite(updated) ? updated : null,
            usage: {remaining, deficit: window ? paceDeficit(window) : null},
            caption: window?.resetsAt ? resetShort(window.resetsAt) : '',
            accessibleName: `${NAMES[this.id]}${account}: ${percentage(remaining)} left${stale ? ', reading unavailable, stale or spent' : ''}`,
        };
    }

    context(key = this.id) {
        const reading = this._reading(key);
        const parts = [];
        if (reading?.account) parts.push(accountName(reading.account).toLowerCase());
        const count = reading?.account ? 0 : source?.sessions(this.id).length ?? 0;
        if (count) parts.push(`${count} session${count === 1 ? '' : 's'}`);
        return parts.join(' · ');
    }

    card(body, ui, key = this.id) {
        const demo = this.host.settings.get_boolean('demo');
        if (demo) body.add_child(ui.label('demo · sample readings', 'ledge-caption'));
        const p = this._reading(key);
        const format = this.settings.get_string('reset-format');
        const stale = p?.status !== 'ok';
        if (!p || p.status === 'loading') body.add_child(ui.label('reading usage…', 'ledge-caption'));
        else {
            if (stale || p.message)
                body.add_child(ui.label(`${p.status === 'stale' ? 'stale · ' : ''}${p.message || 'usage unavailable'}`, 'ledge-warning'));
            for (const w of p.windows) {
                const remaining = remainingPercent(w.usedPercent);
                const caption = [usageSummary(w.usedPercent), paceText(paceDeficit(w))].filter(Boolean).join(' · ');
                body.add_child(ui.bar(w.label, resetText(w.resetsAt, Date.now(), format), remaining === null ? null : remaining / 100,
                    stale, PROVIDER_COLORS[this.id], caption));
            }
            // The demo line already says where demo readings come from.
            if (p.source && !demo) body.add_child(ui.label(`source · ${p.source}`, 'ledge-caption'));
        }

        const spend = !p?.account ? source?.costs?.providers?.[this.id] : null;
        if (spend) {
            const section = ui.section('Spend');
            section.add_child(ui.splitRow('today', money(spend.today), 'ledge-figure'));
            section.add_child(ui.splitRow('last 7 days', money(spend.week), 'ledge-figure'));
            for (const project of spend.projects ?? [])
                section.add_child(ui.splitRow(project.name, money(project.cost), 'ledge-figure'));
            section.add_child(ui.label(source.costs.label, 'ledge-caption'));
            body.add_child(section);
        }

        const sessions = p?.account ? [] : source?.sessions(this.id) ?? [];
        if (sessions.length) {
            const section = ui.section('Sessions');
            // A session row raises the window that runs it.
            for (const session of sessions.slice(0, 4)) {
                const state = session.state === 'waiting' ? 'waiting on you' : session.state === 'busy' ? 'working' : 'idle';
                const lost = this._lost.has(session.id || session.name);
                section.add_child(ui.row(session.name, {
                    detail: lost ? 'can\'t find the window for this session' : session.waitingFor || session.detail,
                    trailing: [ui.label(state, session.state === 'waiting' ? 'ledge-watch' : 'ledge-caption')],
                    onClick: () => this.raise(session),
                }));
            }
            if (sessions.length > 4)
                section.add_child(ui.label(`and ${sessions.length - 4} more`, 'ledge-caption'));
            body.add_child(section);
        }
        return [['Refresh', () => { source?.refresh(); source?.refreshCosts(); }]];
    }
}

const usageModule = id => class extends UsageModule {
    static id = id;
    static title = NAMES[id];
};

export const USAGE_MODULES = PROVIDERS.map(usageModule);
