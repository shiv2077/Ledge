// Alert rules. Pure: no GNOME imports, so Node tests cover them.

// Which session changes are announced. `previous` maps session ids to their
// last state, or is null on the first reading after start, which only
// records history: sessions already running then have none. Announced:
// busy to idle ('finished') and any state to waiting ('waiting'). A session
// that disappears is the user quitting, and derived sessions are estimates,
// so neither is announced.
export function sessionEvents(previous, sessions) {
    const next = new Map();
    const events = [];
    for (const session of sessions) {
        const id = session.id || session.name;
        next.set(id, session.state);
        if (!previous || session.derived) continue;
        const before = previous.get(id);
        if (session.state === 'waiting' && before !== 'waiting') events.push({id, kind: 'waiting', session});
        else if (session.state === 'idle' && before === 'busy') events.push({id, kind: 'finished', session});
    }
    return {events, next};
}

export const LIMIT_STEPS = [80, 100];

// Limit alerts for one window. `state` is {resetsAt, reached} from the last
// reading, or null for the first, which only records how far usage already
// is. Each step is announced once and re-arms only when the window rolls
// over, which shows as resetsAt moving forward.
export function limitAlerts(state, window) {
    const used = Number.isFinite(window?.usedPercent) ? window.usedPercent : null;
    const reset = Date.parse(window?.resetsAt);
    const rolled = state && Number.isFinite(reset) && Number.isFinite(Date.parse(state.resetsAt))
        && reset > Date.parse(state.resetsAt);
    const reached = rolled ? 0 : state?.reached ?? null;
    const now = used === null ? 0 : Math.max(0, ...LIMIT_STEPS.filter(step => used >= step));
    const alerts = reached === null ? [] : LIMIT_STEPS.filter(step => used !== null && used >= step && step > reached);
    return {alerts, state: {resetsAt: window?.resetsAt ?? state?.resetsAt ?? null, reached: Math.max(reached ?? 0, now)}};
}

// The parent pid from the text of /proc/<pid>/stat. The command name may
// hold spaces or parentheses, so fields are counted after the last ')'.
export function parentPid(stat) {
    const end = String(stat).lastIndexOf(')');
    if (end < 0) return null;
    const ppid = parseInt(String(stat).slice(end + 1).trim().split(/\s+/)[1], 10);
    return Number.isFinite(ppid) && ppid > 0 ? ppid : null;
}

// The Codex process working in `cwd`, from [{pid, cwd}]: the oldest (lowest
// pid) of the matches, or null.
export function matchCodexPid(candidates, cwd) {
    if (!cwd) return null;
    const pids = candidates.filter(c => c.cwd === cwd).map(c => c.pid).sort((a, b) => a - b);
    return pids[0] ?? null;
}
