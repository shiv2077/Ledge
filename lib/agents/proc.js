import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {readText} from '../files.js';
import {agentTool} from '../../model.js';
import {children, linkTarget} from '../windows.js';

const SCAN_SECONDS = 15;
export const KNOWN_AGENTS = ['claude', 'codex', 'opencode', 'pi', 'amp', 'gemini', 'aider'];

// Agent CLIs found running in /proc, by argv[0] or argv[1] basename (so
// `node .../codex.js` counts). These report "running" only: a process says
// nothing about whether the agent works or waits.
export class ProcessSource {
    constructor(changed) {
        this._changed = changed;
        this.agents = [];
        this.state = 'ok';
    }

    start(cancellable) {
        this._cancellable = cancellable;
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, SCAN_SECONDS, () => { this._scan(); return GLib.SOURCE_CONTINUE; });
        this._scan();
    }

    async _scan() {
        if (this._scanning) return;
        this._scanning = true;
        const uid = new Gio.Credentials().get_unix_user();
        const found = new Map();
        for (const info of await children(Gio.File.new_for_path('/proc'), this._cancellable)) {
            const pid = Number(info.get_name());
            if (!Number.isInteger(pid) || pid <= 1 || info.get_attribute_uint32('unix::uid') !== uid) continue;
            const {text} = await readText(`/proc/${pid}/cmdline`, this._cancellable);
            const tool = agentTool(text, KNOWN_AGENTS);
            if (!tool) continue;
            const {text: stat} = await readText(`/proc/${pid}/stat`, this._cancellable);
            const ppid = Number(String(stat ?? '').slice(String(stat ?? '').lastIndexOf(')') + 2).split(' ')[1]);
            found.set(pid, {pid, ppid, tool, cwd: await linkTarget(`/proc/${pid}/cwd`, this._cancellable) ?? ''});
        }
        this._scanning = false;
        if (this._cancellable?.is_cancelled()) return;
        // A wrapper and its child (node -> agent) are one agent: keep the outer one.
        this.agents = [...found.values()].filter(p => !(found.get(p.ppid)?.tool === p.tool)).map(p => ({
            source: 'process', id: `process:${p.pid}`, name: '', tool: p.tool, state: 'running', cwd: p.cwd, pid: p.pid,
            waitingFor: null, since: null, exact: false,
        }));
        this._changed();
    }

    stop() {
        if (this._timer) GLib.Source.remove(this._timer);
        this._timer = 0;
    }
}
