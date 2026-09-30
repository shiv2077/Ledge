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
