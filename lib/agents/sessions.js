import {usageSource} from '../../modules/usage.js';

const STATES = {busy: 'working', waiting: 'waiting', idle: 'idle'};

// Claude Code and Codex sessions as the usage widgets already read them
// (reader/activity.py): heuristic states from session files and event types.
// No reads of its own; unavailable while that provider's widget is off.
export class SessionSource {
    constructor(changed, provider) {
        this._changed = changed;
        this.provider = provider;
        this.state = 'ok';
    }

    start() {}
    stop() {}

    get agents() {
        const source = usageSource();
        const sessions = source?.members.has(this.provider) ? source.sessions(this.provider) : null;
        this.state = sessions ? 'ok' : 'unavailable';
        return (sessions ?? []).filter(s => !s.derived).map(s => ({
            source: this.provider, id: `${this.provider}:${s.id || s.name}`, name: s.name, tool: this.provider,
            state: STATES[s.state] ?? 'running', cwd: s.cwd || '', pid: s.pid ?? null,
            waitingFor: s.state === 'waiting' ? 'unknown' : null, since: Date.parse(s.since) || null, exact: false,
        }));
    }
}
