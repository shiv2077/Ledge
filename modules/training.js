import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Module} from '../lib/module.js';
import {readText, ensureDir, dataDir} from '../lib/files.js';
import {parseRun, runState, runProgress, formatLoss, formatDuration} from '../model.js';
import {MODULE_COLORS} from '../design.js';

const STALL_CHECK_SECONDS = 60;
const MAX_RUNS = 50;
const CARD_RUNS = 6;
const ICON = 'system-run-symbolic';

// Last seen state per run file and announced stalls. Kept at module scope so
// a run that finishes while the screen is locked (and the extension disabled)
// is still announced after unlock, and a stall is announced only once.
const seenStates = new Map();
const announcedStalls = new Set();

// Watches ~/.local/share/ledge/runs/*.json, written by tools/ledge_status.py.
export class TrainingModule extends Module {
    static id = 'training';
    static title = 'Training';

    start() {
        this._dir = `${dataDir()}/runs`;
        this._runs = new Map();        // file name -> run
        this._message = '';
        this._ready = false;
        this._watch();
        // No disk reads here: stalls are judged from the last known update time.
        this.every(STALL_CHECK_SECONDS, () => this._checkStalls());
        this._settingsSignal = this.settings.connect('changed::training-stall-minutes', () => this._checkStalls());
    }

    async _watch() {
        const error = await ensureDir(this._dir, this.cancellable);
        if (this.cancellable.is_cancelled()) return;
        if (error) {
            this._message = `Cannot use ${this._dir}: ${error.message}`.slice(0, 200);
            this._ready = true;
            this.changed();
            return;
        }
        const dir = Gio.File.new_for_path(this._dir);
        try {
            this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, this.cancellable);
            this._monitorSignal = this._monitor.connect('changed', (_m, file, other, event) => this._onEvent(file, other, event));
        } catch (e) {
            this._message = `Cannot watch runs: ${e.message}`.slice(0, 200);
        }
        dir.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, this.cancellable,
            (_d, result) => {
                let names = [];
                try {
                    const enumerator = dir.enumerate_children_finish(result);
                    // One batch is plenty: the card shows the newest few runs.
                    enumerator.next_files_async(MAX_RUNS, GLib.PRIORITY_DEFAULT, this.cancellable, (_e, res) => {
                        try { names = enumerator.next_files_finish(res).map(info => info.get_name()); } catch { /* Empty. */ }
                        enumerator.close_async(GLib.PRIORITY_DEFAULT, null, null);
                        Promise.all(names.filter(isRunFile).map(name => this._read(name))).then(() => {
                            if (this.cancellable.is_cancelled()) return;
                            this._ready = true;
                            this.changed();
                        });
                    });
                } catch {
                    this._ready = true;
                    this.changed();
                }
            });
    }

    _onEvent(file, other, event) {
        const E = Gio.FileMonitorEvent;
        if (event === E.RENAMED) {
            this._forget(file.get_basename());
            if (isRunFile(other?.get_basename())) this._read(other.get_basename()).then(() => this.changed());
        } else if (event === E.CHANGES_DONE_HINT || event === E.MOVED_IN || event === E.CREATED) {
            if (isRunFile(file.get_basename())) this._read(file.get_basename()).then(() => this.changed());
        } else if (event === E.DELETED || event === E.MOVED_OUT) {
            this._forget(file.get_basename());
        }
    }

    _forget(name) {
        if (this._runs.delete(name)) this.changed();
    }

    async _read(name) {
        const {text} = await readText(`${this._dir}/${name}`, this.cancellable);
        if (this.cancellable.is_cancelled() || text === null) return;
        let run;
        try { run = parseRun(text); } catch { return; } // Partial or foreign file; wait for the next write.
        this._runs.set(name, run);
        if (seenStates.get(name) === 'running' && run.state !== 'running')
            this._notify(run.state === 'done' ? `Training finished: ${run.name}` : `Training crashed: ${run.name}`, this._summary(run));
        seenStates.set(name, run.state);
    }

    _stallSeconds() { return this.settings.get_int('training-stall-minutes') * 60; }

    _checkStalls() {
        const now = Date.now() / 1000;
        let stalled = false;
        for (const [name, run] of this._runs) {
            if (runState(run, now, this._stallSeconds()) !== 'stalled') continue;
            stalled = true;
            const key = `${name}:${run.updatedAt}`;
            if (announcedStalls.has(key)) continue;
            announcedStalls.add(key);
            this._notify(`Training stalled: ${run.name}`, `No update for ${formatDuration(now - run.updatedAt)}.`);
        }
        if (stalled || this._wasStalled) this.changed();
        this._wasStalled = stalled;
    }

    // The shell's system source owns the notification, so it outlives this
    // module and needs no cleanup; unlike Main.notify it is not transient.
    _notify(title, body) {
        const source = MessageTray.getSystemSource();
        source.addNotification(new MessageTray.Notification({source, title, body}));
    }

    _summary(run) {
        const parts = [];
        if (run.epoch !== null) parts.push(`Epoch ${run.epoch}${run.totalEpochs ? `/${run.totalEpochs}` : ''}`);
        if (run.loss !== null) parts.push(`loss ${formatLoss(run.loss)}`);
        return parts.join(' · ');
    }

    // Newest first.
    _sorted() { return [...this._runs.values()].sort((a, b) => b.updatedAt - a.updatedAt); }

    _active() {
        return this._sorted().find(run => run.state === 'running');
    }

    cell() {
        const run = this._active();
        const state = run ? runState(run, Date.now() / 1000, this._stallSeconds()) : null;
        return {...super.cell(), icon: ICON, fraction: run ? runProgress(run) : null,
            accent: state === 'stalled' ? 'watch' : MODULE_COLORS.training,
            label: run ? formatLoss(run.loss) : '—', stale: state === 'stalled',
            accessibleName: run ? `Training ${run.name}: ${state}, loss ${formatLoss(run.loss)}` : 'Training: no active run'};
    }

    card(body, ui) {
        if (this._message) body.add_child(ui.label(this._message, 'ledge-warning'));
        if (!this._ready) {
            body.add_child(ui.label('Reading runs…', 'ledge-muted'));
            return [];
        }
        const runs = this._sorted();
        if (!runs.length) body.add_child(ui.label('No runs yet. Use tools/ledge_status.py in a training script.', 'ledge-muted'));
        const now = Date.now() / 1000;
        for (const run of runs.slice(0, CARD_RUNS)) {
            const state = runState(run, now, this._stallSeconds());
            const parts = [this._summary(run)];
            if (state === 'running' && run.eta !== null) parts.push(`ETA ${formatDuration(run.eta)}`);
            parts.push(state === 'stalled' ? `stalled ${formatDuration(now - run.updatedAt)}` : state);
            body.add_child(ui.row(run.name, {detail: parts.filter(Boolean).join(' · ')}));
        }
        return [];
    }

    stop() {
        if (this._monitorSignal) this._monitor.disconnect(this._monitorSignal);
        this._monitor?.cancel();
        this._monitor = null;
        this._monitorSignal = 0;
        if (this._settingsSignal) this.settings.disconnect(this._settingsSignal);
        this._settingsSignal = 0;
        super.stop();
    }
}

const isRunFile = name => typeof name === 'string' && name.endsWith('.json') && !name.startsWith('.');
