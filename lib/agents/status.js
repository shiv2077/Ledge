import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {readText} from '../files.js';
import {agentStatus} from '../../model.js';
import {children} from '../windows.js';

const TTL_MS = 12 * 3600e3;
const SWEEP_SECONDS = 30;
const MAX_FILES = 64;

export const agentsDir = () => `${GLib.get_user_data_dir()}/ledge/agents`;

// Agents that report themselves: one JSON file each in agentsDir(), written
// by tools/ledge_agent.py (Claude Code hooks) or any script. A file counts
// while its pid lives (or, without a pid, for 12 hours).
export class StatusSource {
    constructor(changed) {
        this._changed = changed;
        this.agents = [];
        this.state = 'ok';
    }

    start(cancellable) {
        this._cancellable = cancellable;
        const dir = Gio.File.new_for_path(agentsDir());
        try {
            this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitorSignal = this._monitor.connect('changed', () => this._queue());
        } catch {
            this._monitor = null;
        }
        this._sweep = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SWEEP_SECONDS, () => { this._read(); return GLib.SOURCE_CONTINUE; });
        this._read();
    }

    // Coalesce bursts of file events into one read.
    _queue() {
        if (this._idle) return;
        this._idle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => { this._idle = 0; this._read(); return GLib.SOURCE_REMOVE; });
    }

    async _read() {
        if (this._reading) { this._again = true; return; }
        this._reading = true;
        const now = Date.now();
        const agents = [];
        const infos = (await children(Gio.File.new_for_path(agentsDir()), this._cancellable))
            .filter(info => info.get_name().endsWith('.json')).slice(0, MAX_FILES);
        for (const info of infos) {
            const {text} = await readText(`${agentsDir()}/${info.get_name()}`, this._cancellable);
            let agent = null;
            try { agent = agentStatus(JSON.parse(text ?? 'null'), now, TTL_MS); } catch { agent = null; }
            if (!agent) continue;
            // The pid is the main rule: a finished process takes its file with it.
            if (agent.pid && !GLib.file_test(`/proc/${agent.pid}`, GLib.FileTest.IS_DIR)) continue;
            agent.id ||= info.get_name();
            agents.push(agent);
        }
        this._reading = false;
        if (this._cancellable?.is_cancelled()) return;
        this.agents = agents;
        this._changed();
        if (this._again) { this._again = false; this._read(); }
    }

    stop() {
        if (this._monitor) {
            this._monitor.disconnect(this._monitorSignal);
            this._monitor.cancel();
        }
        for (const id of [this._sweep, this._idle]) if (id) GLib.Source.remove(id);
        this._sweep = this._idle = 0;
        this._monitor = null;
    }
}
