// Pure geometry and presentation helpers, also exercised by Node tests.
export const PROVIDERS = ['claude', 'cursor', 'codex'];
export const NAMES = {claude: 'Claude Code', cursor: 'Cursor', codex: 'Codex'};
// Two-letter monograms drawn on chip badges.
export const BADGES = {claude: 'CL', cursor: 'CU', codex: 'CX', power: 'PW', todo: 'TD', models: 'LM', github: 'GH', copilot: 'CP', training: 'TR'};

const pad = value => String(value).padStart(2, '0');

// Deck header timestamp: `live 09:39` for a current reading, `stale 14m` for
// an old one, nothing when the module has never read.
export function stampText(info, now = Date.now()) {
    if (!Number.isFinite(info?.updatedAt)) return '';
    if (!info.stale) {
        const date = new Date(info.updatedAt);
        return `live ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
    const minutes = Math.max(0, Math.round((now - info.updatedAt) / 60000));
    return minutes < 60 ? `stale ${minutes}m` : minutes < 1440 ? `stale ${Math.floor(minutes / 60)}h` : `stale ${Math.floor(minutes / 1440)}d`;
}

export function remainingPercent(usedPercent) {
    return typeof usedPercent === 'number' && Number.isFinite(usedPercent) && usedPercent >= 0
        ? Math.max(0, 100 - usedPercent) : null;
}

export function usageSummary(usedPercent) {
    const remaining = remainingPercent(usedPercent);
    if (remaining === null) return '';
    const over = usedPercent > 100 ? ` · ${Math.round(usedPercent - 100)}% over limit` : '';
    return `${percentage(remaining)} left${over}`;
}

export function position(edge, area, width, height) {
    const centerX = area.x + (area.width - width) / 2;
    const centerY = area.y + (area.height - height) / 2;
    return {
        x: Math.round(Math.max(area.x, edge === 'left' ? area.x : edge === 'right' ? area.x + area.width - width : centerX)),
        y: Math.round(Math.max(area.y, edge === 'top' ? area.y : edge === 'bottom' ? area.y + area.height - height : centerY)),
    };
}

export function percentage(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? `${Math.round(value)}%` : '—';
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_MINUTES = 1440;

// `format` is 'countdown' (resets in 2h 14m) or 'clock' (resets 14:30, or
// resets Fri 09:00 beyond a day), in local time.
export function resetText(value, now = Date.now(), format = 'countdown') {
    if (!value || !Number.isFinite(Date.parse(value)))
        return 'reset time unavailable';
    const minutes = Math.ceil((Date.parse(value) - now) / 60000);
    if (minutes <= 0)
        return 'reset due · refresh for latest';
    if (format === 'clock') {
        const at = new Date(Date.parse(value));
        const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
        return minutes < DAY_MINUTES ? `resets ${time}` : `resets ${WEEKDAYS[at.getDay()]} ${time}`;
    }
    if (minutes < 60)
        return `resets in ${minutes}m`;
    if (minutes < 1440)
        return `resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    return `resets in ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const STATUSES = ['ok', 'stale', 'needsAuth', 'error', 'unavailable'];

// One reading per enabled provider's default sign-in, then its extra
// accounts by slug (`account` is null for the default).
// A reset time in a few characters: 45m, 2h 14m, 3d 4h; empty when unknown.
export function resetShort(value, now = Date.now()) {
    const minutes = Math.ceil((Date.parse(value) - now) / 60000);
    if (!Number.isFinite(minutes)) return '';
    if (minutes <= 0) return 'now';
    if (minutes < 60) return `${minutes}m`;
    if (minutes < DAY_MINUTES) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    return `${Math.floor(minutes / DAY_MINUTES)}d ${Math.floor(minutes % DAY_MINUTES / 60)}h`;
}

export function normalize(data, enabled) {
    if (data?.version !== 1 || !Array.isArray(data.providers))
        throw new Error('Invalid reader response');
    const rows = [];
    for (const id of enabled) {
        const items = data.providers.filter(p => p?.id === id && (!p.account || SLUG.test(p.account)));
        if (!items.some(item => !item.account))
            rows.push({id, account: null, name: NAMES[id], status: 'error', message: 'No reading returned. Try Refresh.', windows: []});
        rows.push(...items.map(item => reading(id, item)));
    }
    return rows.sort((a, b) => enabled.indexOf(a.id) - enabled.indexOf(b.id) || (a.account ?? '').localeCompare(b.account ?? ''));
}

function reading(id, item) {
    {
        return {
            id, account: item.account || null, name: NAMES[id], status: STATUSES.includes(item.status) ? item.status : 'error',
            message: typeof item.message === 'string' ? item.message.slice(0, 240) : '',
            source: typeof item.source === 'string' ? item.source.slice(0, 80) : '',
            updatedAt: item.updatedAt,
            windows: (Array.isArray(item.windows) ? item.windows : []).filter(w =>
                w && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) && w.usedPercent >= 0
            ).slice(0, 8).map(w => ({...w, label: String(w.label || 'Usage').slice(0, 80),
                windowMinutes: Number.isInteger(w.windowMinutes) && w.windowMinutes > 0 ? w.windowMinutes : null})),
        };
    }
}

// The cell key of a reading: `claude`, or `claude:work` for an extra account.
export const accountKey = r => r.account ? `${r.id}:${r.account}` : r.id;
export const accountName = slug => slug ? slug.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ') : '';

// How far use runs ahead of an even spend over the window: used percent
// minus elapsed percent. Null without a window length or reset time.
export function paceDeficit(window, now = Date.now()) {
    const reset = Date.parse(window?.resetsAt);
    const minutes = window?.windowMinutes;
    if (!Number.isFinite(reset) || !minutes || typeof window.usedPercent !== 'number') return null;
    const elapsed = 1 - (reset - now) / (minutes * 60000);
    if (elapsed < 0 || elapsed > 1) return null;
    return window.usedPercent - elapsed * 100;
}

const ON_PACE = 5;

export function paceText(deficit) {
    if (deficit === null) return '';
    if (Math.abs(deficit) < ON_PACE) return 'on pace';
    return `${Math.round(Math.abs(deficit))}% ${deficit > 0 ? 'ahead of' : 'under'} pace`;
}

// The window a chip shows: 'session' (the first), 'weekly' (the longest)
// or 'tightest' (the most used).
export function headlineWindow(windows, choice) {
    if (!windows?.length) return null;
    if (choice === 'weekly')
        return windows.reduce((best, w) => (w.windowMinutes ?? 0) > (best.windowMinutes ?? 0) ? w : best, windows[0]);
    if (choice === 'tightest')
        return windows.reduce((best, w) => w.usedPercent > best.usedPercent ? w : best, windows[0]);
    return windows[0];
}

const known = value => typeof value === 'number' && Number.isFinite(value);

// Reorders usage cells among their own slots: 'fixed' keeps them,
// 'remaining' puts the least left first, 'deficit' the furthest ahead of
// pace first. Cells without a value follow, in their own order.
export function orderUsage(cells, mode) {
    if (mode !== 'remaining' && mode !== 'deficit') return cells;
    const slots = cells.map((cell, index) => cell.info.usage ? index : -1).filter(index => index >= 0);
    const value = cell => mode === 'remaining' ? cell.info.usage.remaining : known(cell.info.usage.deficit) ? -cell.info.usage.deficit : null;
    const sorted = slots.map((slot, order) => ({cell: cells[slot], order})).sort((a, b) => {
        const x = value(a.cell), y = value(b.cell);
        if (known(x) && known(y) && x !== y) return x - y;
        if (known(x) !== known(y)) return known(x) ? -1 : 1;
        return a.order - b.order;
    });
    const result = [...cells];
    slots.forEach((slot, i) => { result[slot] = sorted[i].cell; });
    return result;
}

export function money(value) {
    if (!known(value)) return '—';
    return value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
}

// Todos: [{id, text, done, created}], open items first, each group oldest first.
export function parseTodos(text) {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error('Todo file is not a list');
    return data.filter(t => t && typeof t.text === 'string' && t.text.trim()).map((t, i) => ({
        id: typeof t.id === 'string' && t.id ? t.id : `t${i}-${Number(t.created) || 0}`,
        text: t.text.trim().slice(0, 500), done: t.done === true,
        created: Number.isFinite(t.created) ? t.created : 0,
    }));
}

export function sortTodos(todos) {
    return [...todos].sort((a, b) => Number(a.done) - Number(b.done) || a.created - b.created);
}

export function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// eval_duration is in nanoseconds.
export function tokensPerSecond(evalCount, evalDuration) {
    return Number.isFinite(evalCount) && Number.isFinite(evalDuration) && evalCount > 0 && evalDuration > 0
        ? evalCount / (evalDuration / 1e9) : null;
}

export function ollamaModels(data) {
    return (Array.isArray(data?.models) ? data.models : []).filter(m => typeof m?.name === 'string').map(m => ({
        backend: 'Ollama', name: m.name.slice(0, 120),
        size: Number.isFinite(m.size) ? m.size : null,
        vram: Number.isFinite(m.size_vram) ? m.size_vram : null,
        context: Number.isInteger(m.context_length) && m.context_length > 0 ? m.context_length : null,
        quant: typeof m.details?.quantization_level === 'string' ? m.details.quantization_level.slice(0, 16) : null,
        expiresAt: Number.isFinite(Date.parse(m.expires_at)) ? m.expires_at : null,
    }));
}

// llama.cpp server /slots: newer builds say `is_processing`, older `state` 1.
export function llamaSlots(data) {
    if (!Array.isArray(data)) return null;
    const slots = data.filter(slot => slot && typeof slot === 'object');
    return {
        total: slots.length,
        busy: slots.filter(slot => slot.is_processing === true || slot.state === 1).length,
        context: Number.isInteger(slots[0]?.n_ctx) ? slots[0].n_ctx : null,
    };
}

// llama.cpp server /metrics (Prometheus text, `--metrics`). Only the
// `llamacpp:` gauges and counters below are read.
const LLAMA_METRICS = {
    'llamacpp:prompt_tokens_seconds': 'promptSpeed',
    'llamacpp:predicted_tokens_seconds': 'generateSpeed',
    'llamacpp:requests_processing': 'processing',
    'llamacpp:requests_deferred': 'deferred',
    'llamacpp:tokens_predicted_total': 'predictedTotal',
};

export function llamaMetrics(text) {
    const result = {};
    for (const line of String(text ?? '').split('\n')) {
        if (!line.startsWith('llamacpp:')) continue;
        const [name, raw] = line.trim().split(/\s+/);
        const key = LLAMA_METRICS[name.replace(/\{.*$/, '')];
        const value = Number(raw);
        if (key && Number.isFinite(value)) result[key] = value;
    }
    return result;
}

export const tokenRate = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? `${value.toFixed(1)} tok/s` : '—';

// GitHub Copilot quota from `gh api /copilot_internal/user`. Only quota
// fields are read. Null when the account has no snapshots (no plan).
const COPILOT_QUOTAS = [['premium_interactions', 'Premium requests'], ['chat', 'Chat'], ['completions', 'Completions']];

export function copilotQuota(data) {
    const snapshots = data?.quota_snapshots;
    if (!snapshots || typeof snapshots !== 'object') return null;
    const reset = [data.quota_reset_date_utc, data.quota_reset_date].find(value => Number.isFinite(Date.parse(value))) ?? null;
    const windows = [];
    for (const [id, label] of COPILOT_QUOTAS) {
        const q = snapshots[id];
        if (!q || typeof q !== 'object') continue;
        if (q.unlimited === true) { windows.push({id, label, unlimited: true, usedPercent: 0, resetsAt: reset}); continue; }
        const left = typeof q.percent_remaining === 'number' && Number.isFinite(q.percent_remaining) ? q.percent_remaining : null;
        if (left === null) continue;
        windows.push({id, label, unlimited: false, usedPercent: Math.min(100, Math.max(0, 100 - left)), resetsAt: reset,
            remaining: Number.isFinite(q.remaining) ? q.remaining : null, entitlement: Number.isFinite(q.entitlement) ? q.entitlement : null,
            overage: Number.isFinite(q.overage_count) ? q.overage_count : 0});
    }
    return {plan: typeof data.copilot_plan === 'string' ? data.copilot_plan.slice(0, 40) : '', resetsAt: reset, windows};
}

// LM Studio: /api/v1/models lists models with loaded_instances (0.4+);
// /api/v0/models lists them with state 'loaded' (0.3.x).
export function lmStudioModels(data) {
    if (Array.isArray(data?.models)) {
        return data.models.filter(m => Array.isArray(m?.loaded_instances) && m.loaded_instances.length).map(m => ({
            backend: 'LM Studio', name: String(m.display_name || m.key || 'Model').slice(0, 120),
            size: Number.isFinite(m.size_bytes) ? m.size_bytes : null, vram: null,
        }));
    }
    return (Array.isArray(data?.data) ? data.data : []).filter(m => m?.state === 'loaded').map(m => ({
        backend: 'LM Studio', name: String(m.id || 'Model').slice(0, 120), size: null, vram: null,
    }));
}

const REPO = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*\/[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
export function parseRepos(text) {
    return [...new Set(String(text).split(/[\s,]+/).filter(r => REPO.test(r)))];
}

export const isGithubUrl = url => typeof url === 'string' && url.startsWith('https://github.com/');

export function pullRequests(data) {
    return (Array.isArray(data) ? data : []).filter(pr => isGithubUrl(pr?.url)).map(pr => ({
        title: String(pr.title || 'Pull request').slice(0, 200), url: pr.url, number: pr.number,
        repo: String(pr.repository?.nameWithOwner || pr.repository?.name || '').slice(0, 100),
    }));
}

const FAILING = ['failure', 'timed_out', 'startup_failure'];
// Only a completed run with a failing conclusion counts as failed.
export function ciState(run) {
    if (!run) return 'none';
    if (run.status !== 'completed') return 'running';
    if (FAILING.includes(run.conclusion)) return 'failed';
    return run.conclusion === 'success' ? 'passed' : run.conclusion || 'unknown';
}

// Training run status files written by tools/ledge_status.py.
export function parseRun(text) {
    const r = JSON.parse(text);
    if (!r || typeof r.name !== 'string' || !['running', 'done', 'crashed'].includes(r.state) || !Number.isFinite(r.updated_at))
        throw new Error('Invalid run status');
    const num = v => Number.isFinite(v) ? v : null;
    return {name: r.name.slice(0, 120), state: r.state, epoch: num(r.epoch), totalEpochs: num(r.total_epochs),
        step: num(r.step), loss: num(r.loss), eta: num(r.eta_seconds), updatedAt: r.updated_at};
}

export function runState(run, now, stallSeconds) {
    return run.state === 'running' && now - run.updatedAt > stallSeconds ? 'stalled' : run.state;
}

export function runProgress(run) {
    return run.epoch !== null && run.totalEpochs > 0 ? Math.max(0, Math.min(1, run.epoch / run.totalEpochs)) : null;
}

export function formatLoss(loss) {
    if (typeof loss !== 'number' || !Number.isFinite(loss)) return '—';
    return Math.abs(loss) >= 100 ? loss.toFixed(0) : Math.abs(loss) >= 10 ? loss.toFixed(1) : loss.toFixed(3);
}

export function formatDuration(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// ---- agents ----

export const AGENT_STATES = ['working', 'waiting', 'idle', 'finished', 'error', 'running'];
export const WAITING_FOR = ['permission', 'input', 'unknown'];
// Which source knows an agent's state best: a hook's status file, then
// the multi-agent workspace, then the Claude/Codex readers' heuristics, then a bare process.
export const AGENT_SOURCES = ['status', 'workspace', 'claude', 'codex', 'process'];
const AGENT_TEXT = 120;
const AGENT_PATH = 4096;

const clean = (value, limit) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit) : '';
const positivePid = value => Number.isInteger(value) && value > 1 ? value : null;

// A status file's contents, checked: version 1, known state, capped
// strings, no message text. Null when invalid or older than `ttlMs`.
export function agentStatus(data, now = Date.now(), ttlMs = 12 * 3600e3) {
    if (!data || typeof data !== 'object' || data.version !== 1) return null;
    const state = AGENT_STATES.includes(data.state) ? data.state : null;
    const updated = Date.parse(data.updatedAt);
    if (!state || !Number.isFinite(updated) || now - updated > ttlMs) return null;
    return {
        source: 'status', id: clean(data.id, AGENT_TEXT), name: clean(data.name, AGENT_TEXT), tool: clean(data.tool, 32).toLowerCase(),
        state, cwd: clean(data.cwd, AGENT_PATH), pid: positivePid(data.pid),
        waitingFor: state === 'waiting' ? (WAITING_FOR.includes(data.waitingFor) ? data.waitingFor : 'unknown') : null,
        since: updated, exact: true,
    };
}

// The workspace's `api schema` text: the protocol and schema numbers, or null.
export function workspaceSchema(text) {
    const protocol = /protocol:\s*(\d+)/.exec(String(text ?? ''));
    const schema = /schema_version:\s*(\d+)/.exec(String(text ?? ''));
    return protocol && schema ? {protocol: Number(protocol[1]), schema: Number(schema[1])} : null;
}

const WORKSPACE_STATES = {working: 'working', blocked: 'waiting', idle: 'idle', done: 'finished', unknown: 'running'};

// Agents from the workspace's `api snapshot` JSON. Only identity, folder and state
// fields are read; titles and labels are not.
export function workspaceAgents(data, now = Date.now()) {
    const agents = data?.result?.snapshot?.agents;
    if (!Array.isArray(agents)) return null;
    return agents.filter(a => a && typeof a.pane_id === 'string').map(a => ({
        source: 'workspace', id: `pane:${clean(a.pane_id, AGENT_TEXT)}`, name: '', tool: clean(a.agent ?? '', 32).toLowerCase() || 'agent',
        state: WORKSPACE_STATES[a.agent_status] ?? 'running', cwd: clean(a.foreground_cwd || a.cwd || '', AGENT_PATH), pid: null,
        waitingFor: a.agent_status === 'blocked' ? 'unknown' : null, since: now, exact: true, pane: clean(a.pane_id, AGENT_TEXT),
        // The agent's own session id (Claude Code's), when the workspace knows it.
        session: clean(a.agent_session?.value ?? '', AGENT_TEXT) || null,
    }));
}

// The agent CLI a command line runs, from argv[0] or (for `node <cli>`)
// argv[1] basename, or null.
export function agentTool(cmdline, known) {
    const args = String(cmdline ?? '').split('\0');
    for (const arg of args.slice(0, 2)) {
        const base = arg.split('/').pop().replace(/\.(js|mjs|cjs)$/, '');
        if (known.includes(base)) return base;
    }
    return null;
}

// One list of agents from every source. Same pid = same agent. Without a
// pid on one side, cwd + tool joins only when exactly one candidate fits,
// so two agents in one tree stay two. Per field: state from the most exact
// source, the pane from the workspace.
export function mergeAgents(lists) {
    const rank = agent => AGENT_SOURCES.indexOf(agent.source);
    const all = lists.flat().filter(Boolean).sort((a, b) => rank(a) - rank(b));
    const merged = [];
    const join = (match, agent) => {
        match.sources.push(agent.source);
        if (rank(agent) < match.rank) {
            // A more exact source: its state, wait reason and start win.
            Object.assign(match, {state: agent.state, waitingFor: agent.waitingFor, since: agent.since, exact: agent.exact, rank: rank(agent)});
        }
        match.pid ??= agent.pid;
        match.pane ??= agent.pane;
        match.cwd ||= agent.cwd;
        match.name ||= agent.name;
    };
    // Agents with a pid first, joined by pid only.
    for (const agent of all.filter(a => a.pid)) {
        const match = merged.find(m => m.pid === agent.pid);
        if (match) join(match, agent);
        else merged.push({...agent, sources: [agent.source], rank: rank(agent)});
    }
    // Then agents without one: by session id when both know it, else
    // cwd + tool, and only when exactly one fits.
    for (const agent of all.filter(a => !a.pid)) {
        const bySession = agent.session ? merged.filter(m => m.id === agent.session || m.id === `claude:${agent.session}`) : [];
        const candidates = bySession.length ? bySession
            : merged.filter(m => m.cwd && m.cwd === agent.cwd && m.tool === agent.tool && !m.sources.includes(agent.source));
        if (candidates.length === 1) join(candidates[0], agent);
        else merged.push({...agent, sources: [agent.source], rank: rank(agent)});
    }
    return merged.map(({rank: _rank, ...agent}) => agent);
}

// A branch from .git/HEAD text ("ref: refs/heads/x" or a commit), and the
// git dir a worktree's .git file points to.
export function gitHeadBranch(text) {
    const value = String(text ?? '').trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(value);
    if (ref) return ref[1];
    return /^[0-9a-f]{7,40}$/.test(value) ? value.slice(0, 7) : null;
}

export function gitDirFile(text) {
    const match = /^gitdir:\s*(.+)$/m.exec(String(text ?? ''));
    return match ? match[1].trim() : null;
}

// Trees where two or more agents are working or waiting: tree -> count.
export function agentCollisions(agents) {
    const counts = new Map();
    for (const a of agents) if (a.tree && (a.state === 'working' || a.state === 'waiting')) counts.set(a.tree, (counts.get(a.tree) ?? 0) + 1);
    return new Map([...counts].filter(([, n]) => n >= 2));
}

// Waiting agents, longest waiting first.
export const waitingQueue = agents => agents.filter(a => a.state === 'waiting').sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
