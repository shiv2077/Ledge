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
