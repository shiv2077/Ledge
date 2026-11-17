import GLib from 'gi://GLib';
import {Module} from '../lib/module.js';
import {run} from '../lib/subprocess.js';
import {BADGES, copilotQuota, percentage, remainingPercent, resetText, usageSummary} from '../model.js';
import {MODULE_COLORS} from '../design.js';

const GH_TIMEOUT = 20;
const GH_AUTH_REQUIRED = 4;
const SIGTERM = 15;
const MAX_OUTPUT = 65536;

// Demo readings: `gh` is not run while `demo` is on.
const DEMO = {
    copilot_plan: 'individual',
    quota_reset_date_utc: new Date(Date.now() + 12 * 86400e3).toISOString(),
    quota_snapshots: {
        premium_interactions: {percent_remaining: 64, remaining: 192, entitlement: 300, unlimited: false, overage_count: 0},
        chat: {unlimited: true},
        completions: {unlimited: true},
    },
};

// GitHub Copilot quota through `gh api /copilot_internal/user`. Ledge holds
// no token: `gh` signs the request. Only quota fields are parsed.
export class CopilotModule extends Module {
    static id = 'copilot';
    static title = 'GitHub Copilot';

    start() {
        this._state = null;
        this._poll();
        this._schedule();
        this._settingsSignal = this.settings.connect('changed', (_s, key) => {
            if (key === 'github-poll-seconds') this._schedule();
            if (key === 'demo') this._poll();
        });
    }

    _schedule() {
        this._timer = this.clearTimer(this._timer);
        this._timer = this.every(this.settings.get_int('github-poll-seconds'), () => this._poll());
    }

    async _poll() {
        if (this._polling) return;
        this._polling = true;
        const state = this.settings.get_boolean('demo') ? {quota: copilotQuota(DEMO), error: ''} : await this._read();
        this._polling = false;
        if (this.cancellable.is_cancelled()) return;
        this._state = {...state, updatedAt: Date.now()};
        this.changed();
    }

    async _read() {
        const r = await run(['gh', 'api', '/copilot_internal/user'],
            {timeout: GH_TIMEOUT, signal: SIGTERM, cancellable: this.cancellable, stderr: true});
        if (r.error?.matches?.(GLib.SpawnError, GLib.SpawnError.NOENT)) return {quota: null, error: 'GitHub CLI (gh) is not installed'};
        if (r.status === GH_AUTH_REQUIRED || /gh auth login/.test(r.stderr)) return {quota: null, error: 'gh is not logged in · run gh auth login in a terminal'};
        if (/HTTP 40[34]/.test(r.stderr)) return {quota: null, error: 'no Copilot plan on this GitHub account'};
        if (!r.ok) return {quota: null, error: r.status === -1 ? 'gh did not answer in time' : 'gh could not read the Copilot quota'};
        if (r.stdout.length > MAX_OUTPUT) return {quota: null, error: 'gh returned too much data'};
        try {
            const quota = copilotQuota(JSON.parse(r.stdout));
            return quota ? {quota, error: ''} : {quota: null, error: 'no Copilot plan on this GitHub account'};
        } catch {
            return {quota: null, error: 'gh returned unreadable output'};
        }
    }

    // The chip shows the first limited quota, normally premium requests.
    _headline() { return this._state?.quota?.windows.find(w => !w.unlimited) ?? null; }

    cell() {
        const window = this._headline();
        const remaining = remainingPercent(window?.usedPercent);
        const unlimited = !window && this._state?.quota?.windows.length;
        return {...super.cell(), badge: BADGES.copilot, accent: MODULE_COLORS.copilot, meter: true,
            fraction: remaining === null ? null : remaining / 100, label: unlimited ? '∞' : percentage(remaining),
            stale: !this._state?.quota, updatedAt: this._state?.updatedAt ?? null,
            accessibleName: `GitHub Copilot: ${unlimited ? 'unlimited' : `${percentage(remaining)} left`}`};
    }

    context() { return this._state?.quota?.plan ?? ''; }

    card(body, ui) {
        if (this.settings.get_boolean('demo')) body.add_child(ui.label('demo · sample readings', 'ledge-caption'));
        if (!this._state) body.add_child(ui.label('reading Copilot quota…', 'ledge-caption'));
        else if (this._state.error) body.add_child(ui.label(this._state.error, 'ledge-warning'));
        for (const w of this._state?.quota?.windows ?? []) {
            if (w.unlimited) {
                body.add_child(ui.splitRow(w.label, 'unlimited', 'ledge-figure'));
                continue;
            }
            const remaining = remainingPercent(w.usedPercent);
            const counts = w.entitlement ? `${w.remaining} of ${w.entitlement} left` : usageSummary(w.usedPercent);
            body.add_child(ui.bar(w.label, resetText(w.resetsAt, Date.now(), this.settings.get_string('reset-format')),
                remaining / 100, false, MODULE_COLORS.copilot, w.overage ? `${counts} · ${w.overage} over` : counts));
        }
        return [['Refresh', () => this._poll()]];
    }

    stop() {
        if (this._settingsSignal) this.settings.disconnect(this._settingsSignal);
        this._settingsSignal = 0;
        super.stop();
    }
}
