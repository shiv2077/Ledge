import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Module} from '../lib/module.js';
import {readText} from '../lib/files.js';
import {raiseSession, windowForPid, children} from '../lib/windows.js';
import {StatusSource} from '../lib/agents/status.js';
import {SessionSource} from '../lib/agents/sessions.js';
import {HerdrSource} from '../lib/agents/herdr.js';
import {ProcessSource} from '../lib/agents/proc.js';
import {mergeAgents, agentCollisions, waitingQueue, gitHeadBranch, gitDirFile, formatDuration, agentTool} from '../model.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TREE_SECONDS = 30;
const MAX_DEPTH = 32;
const SHOWN = 12;
const TOOL_NAMES = {claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi', amp: 'Amp', gemini: 'Gemini', aider: 'Aider'};
const STATE_TEXT = {working: 'working', waiting: 'waiting', idle: 'idle', finished: 'done', error: 'error', running: 'running'};
const WAIT_TEXT = {permission: 'permission', input: 'input', unknown: 'waiting'};
const SOURCE_TEXT = {status: 'hook', herdr: 'herdr', claude: 'session', codex: 'session', process: 'process'};

// Demo agents: two in one tree (a collision), one waiting.
const minutesAgo = m => Date.now() - m * 60e3;
const DEMO = () => [
    {id: 'd1', tool: 'claude', state: 'working', cwd: '/home/demo/ledge', tree: '/home/demo/ledge', branch: 'main', sources: ['herdr'], since: minutesAgo(12), exact: true},
    {id: 'd2', tool: 'claude', state: 'waiting', waitingFor: 'permission', cwd: '/home/demo/ledge', tree: '/home/demo/ledge', branch: 'main', sources: ['status'], since: minutesAgo(3), exact: true},
    {id: 'd3', tool: 'codex', state: 'working', cwd: '/home/demo/site', tree: '/home/demo/site', branch: 'feat/nav', sources: ['codex'], since: minutesAgo(25), exact: false},
    {id: 'd4', tool: 'opencode', state: 'running', cwd: '/home/demo/notes', tree: '/home/demo/notes', branch: 'main', sources: ['process'], since: null, exact: false},
    {id: 'd5', tool: 'claude', state: 'idle', cwd: '/home/demo/api', tree: '/home/demo/api', branch: 'fix/auth', sources: ['claude'], since: minutesAgo(40), exact: false},
];

const exists = (path, cancellable) => new Promise(resolve => {
    Gio.File.new_for_path(path).query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable, (file, result) => {
        try { resolve(file.query_info_finish(result).get_file_type()); } catch { resolve(null); }
    });
});

// Every coding agent at a glance: merged from hook status files, Herdr,
// Claude Code and Codex sessions and a process scan, grouped by worktree.
export class AgentsModule extends Module {
    static id = 'agents';
    static title = 'Agents';

    start() {
        this.agents = [];
        this._trees = new Map();
        const changed = () => this._refresh();
        this._sources = {
            'agents-status': new StatusSource(changed),
            'agents-herdr': new HerdrSource(changed),
            'agents-claude': new SessionSource(changed, 'claude'),
            'agents-codex': new SessionSource(changed, 'codex'),
            'agents-processes': new ProcessSource(changed),
        };
        this._running = new Set();
        this._sync();
        // Claude and Codex arrive through the usage readers; look again as they update.
        this.every(3, () => this._refresh());
        this._settingsSignal = this.settings.connect('changed', (_s, key) => {
            if (key in this._sources || key === 'demo') this._sync();
        });
    }

    _sync() {
        for (const [key, source] of Object.entries(this._sources)) {
            const wanted = this.settings.get_boolean(key) && !this.settings.get_boolean('demo');
            if (wanted && !this._running.has(key)) { source.start(this.cancellable); this._running.add(key); }
            if (!wanted && this._running.has(key)) { source.stop(); this._running.delete(key); }
        }
        this._refresh();
    }

    _refresh() {
        if (this.cancellable.is_cancelled()) return;
        if (this.settings.get_boolean('demo')) {
            this._set(DEMO());
            return;
        }
        const lists = [...this._running].map(key => this._sources[key].agents);
        const merged = mergeAgents(lists);
        for (const agent of merged) Object.assign(agent, this._trees.get(agent.cwd)?.value ?? {});
        this._set(merged);
        this._resolveTrees(merged);
    }

    _set(agents) {
        const signature = JSON.stringify(agents.map(a => [a.id, a.state, a.tree, a.branch, a.waitingFor]));
        this.agents = agents;
        if (signature !== this._signature) {
            this._signature = signature;
            this.changed();
        }
    }

    // Worktree top level and branch per folder: walk up to .git, read HEAD
    // (following a worktree's .git file). Cached; no git subprocess.
    async _resolveTrees(agents) {
        const now = Date.now();
        const stale = [...new Set(agents.map(a => a.cwd).filter(Boolean))]
            .filter(cwd => !this._trees.has(cwd) || now - this._trees.get(cwd).at > TREE_SECONDS * 1000);
        if (!stale.length || this._resolving) return;
        this._resolving = true;
        for (const cwd of stale) {
            let dir = cwd;
            let value = {tree: cwd, branch: ''};
            for (let depth = 0; depth < MAX_DEPTH && dir && dir !== '/'; depth++) {
                const type = await exists(`${dir}/.git`, this.cancellable);
                if (type === Gio.FileType.DIRECTORY || type === Gio.FileType.REGULAR) {
                    let gitDir = `${dir}/.git`;
                    if (type === Gio.FileType.REGULAR) gitDir = gitDirFile((await readText(gitDir, this.cancellable)).text) ?? gitDir;
                    const head = (await readText(`${gitDir}/HEAD`, this.cancellable)).text;
                    value = {tree: dir, branch: gitHeadBranch(head) ?? ''};
                    break;
                }
                dir = GLib.path_get_dirname(dir);
            }
            this._trees.set(cwd, {value, at: now});
        }
        this._resolving = false;
        if (!this.cancellable.is_cancelled()) this._refresh();
    }

    cell() {
        const waiting = this.agents.filter(a => a.state === 'waiting').length;
        const working = this.agents.filter(a => a.state === 'working').length;
        return {...super.cell(), badge: 'AG', meter: false, label: String(this.agents.length), agents: this.agents.slice(0, SHOWN),
            waiting, light: waiting ? 'waiting' : working ? 'working' : 'off',
            accessibleName: `Agents: ${this.agents.length}, ${working} working, ${waiting} waiting`};
    }

    context() {
        const waiting = this.agents.filter(a => a.state === 'waiting').length;
        return waiting ? `${waiting} waiting` : `${this.agents.length} running`;
    }

    _row(ui, agent, collisions) {
        const folder = GLib.path_get_basename(agent.cwd || agent.tree || '') || '—';
        const where = agent.branch ? `${folder} · ${agent.branch}` : folder;
        const elapsed = agent.since ? formatDuration((Date.now() - agent.since) / 1000) : '';
        const state = agent.state === 'waiting' ? WAIT_TEXT[agent.waitingFor] ?? 'waiting' : STATE_TEXT[agent.state];
        // A hollow mark: the state is a guess from session files or a bare process.
        const how = `${agent.exact ? '' : '◦ '}${SOURCE_TEXT[agent.sources?.[0]] ?? ''}`;
        return ui.row(`${TOOL_NAMES[agent.tool] ?? agent.tool} · ${where}`, {
            mono: true,
            detail: [elapsed, how].filter(Boolean).join(' · '),
            // Red: waiting on you, or active in a tree another agent also works in.
            trailing: [ui.label(state, agent.state === 'waiting' || (agent.state === 'working' && collisions.has(agent.tree))
                ? 'ledge-warning' : 'ledge-caption')],
            onClick: () => this.raise(agent),
        });
    }

    card(body, ui) {
        if (this.settings.get_boolean('demo')) body.add_child(ui.label('demo · sample agents', 'ledge-caption'));
        const unavailable = Object.entries(this._sources).filter(([key, s]) => this._running.has(key) && s.state === 'unavailable').map(([key]) => key.slice(7));
        if (unavailable.length) body.add_child(ui.label(`unavailable · ${unavailable.join(', ')}`, 'ledge-caption'));
        if (!this.agents.length) {
            body.add_child(ui.label('no agents running', 'ledge-caption'));
            return [];
        }
        const collisions = agentCollisions(this.agents);
        const queue = waitingQueue(this.agents);
        if (queue.length) {
            const section = ui.section(`Waiting · ${queue.length}`);
            for (const agent of queue) section.add_child(this._row(ui, agent, collisions));
            body.add_child(section);
        }
        const trees = new Map();
        for (const agent of this.agents.filter(a => a.state !== 'waiting')) {
            const key = agent.tree || agent.cwd || '';
            if (!trees.has(key)) trees.set(key, []);
            trees.get(key).push(agent);
        }
        for (const [tree, agents] of trees) {
            const name = GLib.path_get_basename(tree) || 'elsewhere';
            const clash = collisions.get(tree);
            const section = ui.section(clash ? `${name} · ${clash} active · same tree` : name);
            for (const agent of agents) section.add_child(this._row(ui, agent, collisions));
            body.add_child(section);
        }
        return queue.length ? [['Next waiting', () => this.raiseNext()]] : [];
    }

    // The oldest waiting agent's pane or window.
    raiseNext() {
        const next = waitingQueue(this.agents)[0];
        if (next) this.raise(next);
        return next ?? null;
    }

    async raise(agent) {
        const herdr = this._sources['agents-herdr'];
        if (agent.pane && this._running.has('agents-herdr') && await herdr.focus(agent.pane)) {
            // Then the terminal that shows Herdr.
            const pid = await this._herdrClient();
            if (pid) {
                const window = await windowForPid(pid, this.cancellable);
                if (window) Main.activateWindow(window);
            }
            return true;
        }
        if (agent.pid) return raiseSession({pid: agent.pid}, this.cancellable);
        if (agent.tool === 'codex' && agent.cwd) return raiseSession({cwd: agent.cwd}, this.cancellable);
        return false;
    }

    async _herdrClient() {
        for (const info of await children(Gio.File.new_for_path('/proc'), this.cancellable)) {
            const pid = Number(info.get_name());
            if (!Number.isInteger(pid)) continue;
            const {text} = await readText(`/proc/${pid}/cmdline`, this.cancellable);
            if (agentTool(text, ['herdr'])) return pid;
        }
        return null;
    }

    stop() {
        for (const key of this._running) this._sources[key].stop();
        this._running.clear();
        if (this._settingsSignal) this.settings.disconnect(this._settingsSignal);
        this._settingsSignal = 0;
        super.stop();
    }
}
