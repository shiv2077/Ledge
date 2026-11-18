import GLib from 'gi://GLib';
import {run} from '../subprocess.js';
import {workspaceSchema, workspaceAgents} from '../../model.js';

const PROTOCOLS = [22];
const SCHEMA = 1;
const BUSY_SECONDS = 3;
const IDLE_SECONDS = 15;
const TIMEOUT = 3;
const MAX_OUTPUT = 1 << 20;

// The multi-agent terminal workspace's command and its socket.
const CLI = 'herdr';
const socketPath = () => `${GLib.get_user_config_dir()}/${CLI}/${CLI}.sock`;

// Agents in the multi-agent workspace's panes, from its `api snapshot`:
// every 3 s while one works, 15 s otherwise. Nothing is spawned unless its socket
// exists; a protocol this code was not written for shows "unavailable".
export {CLI as WORKSPACE_CLI};

export class WorkspaceSource {
    constructor(changed) {
        this._changed = changed;
        this.agents = [];
        this.state = 'off';
    }

    start(cancellable) {
        this._cancellable = cancellable;
        this._poll();
    }

    _schedule(seconds) {
        if (this._timer) GLib.Source.remove(this._timer);
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => { this._timer = 0; this._poll(); return GLib.SOURCE_REMOVE; });
    }

    _set(state, agents) {
        // Keep when each agent entered its state, across polls.
        const next = agents.map(a => {
            const old = this.agents.find(b => b.id === a.id && b.state === a.state);
            return old ? {...a, since: old.since} : a;
        });
        const changed = state !== this.state || JSON.stringify(next) !== JSON.stringify(this.agents);
        this.state = state;
        this.agents = next;
        if (changed) this._changed();
    }

    async _poll() {
        if (this._cancellable?.is_cancelled()) return;
        if (!GLib.file_test(socketPath(), GLib.FileTest.EXISTS)) {
            this._set('off', []);
            this._schedule(IDLE_SECONDS);
            return;
        }
        if (!this._checked) {
            const schema = await run([CLI, 'api', 'schema'], {timeout: TIMEOUT, cancellable: this._cancellable});
            const version = schema.ok ? workspaceSchema(schema.stdout) : null;
            if (!version || !PROTOCOLS.includes(version.protocol) || version.schema !== SCHEMA) {
                this._set('unavailable', []);
                this._schedule(IDLE_SECONDS * 4);
                return;
            }
            this._checked = true;
        }
        const result = await run([CLI, 'api', 'snapshot'], {timeout: TIMEOUT, cancellable: this._cancellable});
        if (this._cancellable?.is_cancelled()) return;
        let agents = null;
        try {
            if (result.ok && result.stdout.length < MAX_OUTPUT) agents = workspaceAgents(JSON.parse(result.stdout));
        } catch { agents = null; }
        if (agents) this._set('ok', agents);
        else this._set(result.stdout.includes('server_not_running') ? 'off' : 'unavailable', []);
        this._schedule(this.agents.some(a => a.state === 'working') ? BUSY_SECONDS : IDLE_SECONDS);
    }

    // Focus the agent's pane through the workspace's own command.
    async focus(pane) {
        const result = await run([CLI, 'agent', 'focus', pane], {timeout: TIMEOUT, cancellable: this._cancellable});
        return result.ok;
    }

    stop() {
        if (this._timer) GLib.Source.remove(this._timer);
        this._timer = 0;
    }
}
