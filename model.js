// Pure geometry and presentation helpers, also exercised by Node tests.
export const PROVIDERS = ['claude', 'cursor', 'codex'];
export const NAMES = {claude: 'Claude Code', cursor: 'Cursor', codex: 'Codex'};

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

export function resetText(value, now = Date.now()) {
    if (!value || !Number.isFinite(Date.parse(value)))
        return 'Reset time unavailable';
    const minutes = Math.ceil((Date.parse(value) - now) / 60000);
    if (minutes <= 0)
        return 'Reset due · refresh for latest';
    if (minutes < 60)
        return `Resets in ${minutes}m`;
    if (minutes < 1440)
        return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    return `Resets in ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
}

export function normalize(data, enabled) {
    if (data?.version !== 1 || !Array.isArray(data.providers))
        throw new Error('Invalid reader response');
    return enabled.map(id => {
        const item = data.providers.find(p => p?.id === id);
        if (!item)
            return {id, name: NAMES[id], status: 'error', message: 'No reading returned. Try Refresh.', windows: []};
        const statuses = ['ok', 'stale', 'needsAuth', 'error', 'unavailable'];
        return {
            id, name: NAMES[id], status: statuses.includes(item.status) ? item.status : 'error',
            message: typeof item.message === 'string' ? item.message.slice(0, 240) : '',
            source: typeof item.source === 'string' ? item.source.slice(0, 80) : '',
            updatedAt: item.updatedAt,
            windows: (Array.isArray(item.windows) ? item.windows : []).filter(w =>
                w && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) && w.usedPercent >= 0
            ).slice(0, 8).map(w => ({...w, label: String(w.label || 'Usage').slice(0, 80)})),
        };
    });
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
    }));
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
