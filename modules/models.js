import {Module} from '../lib/module.js';
import {run} from '../lib/subprocess.js';
import {getJson, postJson, getText} from '../lib/http.js';
import {BADGES, formatBytes, tokensPerSecond, ollamaModels, lmStudioModels, llamaSlots, llamaMetrics, tokenRate} from '../model.js';
import {MODULE_COLORS} from '../design.js';

const OLLAMA = 'http://127.0.0.1:11434';
const LM_STUDIO = 'http://127.0.0.1:1234';
const LM_STUDIO_PATHS = ['/api/v1/models', '/api/v0/models'];
const MEASURE_PROMPT = 'Write two sentences about the sea.';
const MEASURE_TOKENS = 64;
const MEASURE_TIMEOUT = 120;
const LOG_TIMEOUT = 10;
const GIB = 1024 ** 3;

// Demo readings: no local server is asked while `demo` is on.
const DEMO = {
    ollama: {models: [{backend: 'Ollama', name: 'qwen3:8b', size: 6.2 * GIB, vram: 5.1 * GIB, context: 8192, quant: 'Q4_K_M', expiresAt: null}], message: ''},
    lmStudio: {models: [], message: 'LM Studio server is off'},
    llama: {healthy: true, slots: {total: 2, busy: 1, context: 16384}, metrics: {promptSpeed: 812.4, generateSpeed: 41.7, processing: 1, deferred: 0}, message: ''},
    logs: {today: 42, week: 230, endpoints: {'/v1/chat/completions': 38, '/v1/completions': 4}, logs: true},
    vram: 6 * GIB,
};

export class ModelsModule extends Module {
    static id = 'models';
    static title = 'Local models';

    start() {
        this._ollama = null;
        this._lmStudio = null;
        this._totalVram = null;
        this._speeds = new Map();
        this._measuring = new Set();
        this._llama = null;
        this._logs = null;
        if (this._demo()) this._totalVram = DEMO.vram;
        else this._readGpuMemory();
        this._poll();
        this._schedule();
        this._settingsSignal = this.settings.connect('changed', (_s, key) => {
            if (key === 'models-poll-seconds') this._schedule();
            if (['demo', 'llamacpp', 'llamacpp-port', 'lmstudio-logs'].includes(key)) this._poll();
        });
    }

    _schedule() {
        this._timer = this.clearTimer(this._timer);
        this._timer = this.every(this.settings.get_int('models-poll-seconds'), () => this._poll());
    }

    // Total GPU memory, read once: it may wake a sleeping dGPU. Missing
    // nvidia-smi leaves the meter unlit.
    async _readGpuMemory() {
        const result = await run(['nvidia-smi', '--query-gpu=memory.total', '--format=csv,noheader,nounits'],
            {timeout: 15, cancellable: this.cancellable});
        const mib = parseInt(result.stdout.split('\n')[0], 10);
        if (result.ok && Number.isFinite(mib) && mib > 0) {
            this._totalVram = mib * 1024 * 1024;
            this.changed();
        }
    }

    _demo() { return this.settings.get_boolean('demo'); }

    async _poll() {
        if (this._polling) return;
        this._polling = true;
        const read = this._demo()
            ? [DEMO.ollama, DEMO.lmStudio, this.settings.get_boolean('llamacpp') ? DEMO.llama : null,
                this.settings.get_boolean('lmstudio-logs') ? DEMO.logs : null]
            : await Promise.all([this._readOllama(), this._readLmStudio(), this._readLlama(), this._readLogs()]);
        this._polling = false;
        if (this.cancellable.is_cancelled()) return;
        const state = [this._ollama, this._lmStudio, this._llama, this._logs];
        if (JSON.stringify(read) === JSON.stringify(state)) return;
        [this._ollama, this._lmStudio, this._llama, this._logs] = read;
        this.changed();
    }

    // llama.cpp's server on `llamacpp-port`: health, slots and metrics. The
    // last two need `--slots` and `--metrics`; without them they stay blank.
    async _readLlama() {
        if (!this.settings.get_boolean('llamacpp')) return null;
        const base = `http://127.0.0.1:${this.settings.get_int('llamacpp-port')}`;
        const options = {timeout: 3, cancellable: this.cancellable};
        const health = await getJson(`${base}/health`, options);
        if (!health.status) return {healthy: false, slots: null, metrics: {}, message: 'llama.cpp server is not running'};
        if (!health.ok) return {healthy: false, slots: null, metrics: {}, message: health.status === 503 ? 'llama.cpp is loading a model' : `llama.cpp answered ${health.status}`};
        const [slots, metrics] = await Promise.all([getJson(`${base}/slots`, options), getText(`${base}/metrics`, options)]);
        return {healthy: true, slots: slots.ok ? llamaSlots(slots.data) : null, metrics: metrics.ok ? llamaMetrics(metrics.data) : {}, message: ''};
    }

    async _readLogs() {
        if (!this.settings.get_boolean('lmstudio-logs')) return null;
        const result = await run(['/usr/bin/nice', '-n', '19', '/usr/bin/python3', `${this.host.path}/reader/lmstudio.py`],
            {timeout: LOG_TIMEOUT, cancellable: this.cancellable});
        try {
            const data = JSON.parse(result.stdout);
            if (result.ok && data?.version === 1) return {today: data.today, week: data.week, endpoints: data.endpoints ?? {}, logs: data.logs === true};
        } catch { /* Counts stay unknown. */ }
        return null;
    }

    async _readOllama() {
        const r = await getJson(`${OLLAMA}/api/ps`, {timeout: 3, cancellable: this.cancellable});
        if (r.ok) return {models: ollamaModels(r.data), message: ''};
        return {models: [], message: r.status ? `Ollama answered ${r.status}` : 'Ollama is not running'};
    }

    // Newer LM Studio serves /api/v1, older /api/v0; remember whichever works.
    async _readLmStudio() {
        const paths = this._lmStudioPath ? [this._lmStudioPath] : LM_STUDIO_PATHS;
        for (const path of paths) {
            const r = await getJson(`${LM_STUDIO}${path}`, {timeout: 3, cancellable: this.cancellable});
            if (r.ok) {
                this._lmStudioPath = path;
                return {models: lmStudioModels(r.data), message: ''};
            }
            if (!r.status) return {models: [], message: 'LM Studio server is off'};
        }
        this._lmStudioPath = null;
        return {models: [], message: 'LM Studio server did not list models'};
    }

    async _measure(name) {
        if (this._measuring.has(name)) return;
        this._measuring.add(name);
        this.changed();
        const r = await postJson(`${OLLAMA}/api/generate`,
            {model: name, prompt: MEASURE_PROMPT, stream: false, options: {num_predict: MEASURE_TOKENS}},
            {timeout: MEASURE_TIMEOUT, cancellable: this.cancellable});
        if (this.cancellable.is_cancelled()) return;
        this._measuring.delete(name);
        const speed = r.ok ? tokensPerSecond(r.data?.eval_count, r.data?.eval_duration) : null;
        this._speeds.set(name, speed === null ? 'failed' : `${speed.toFixed(1)} tok/s`);
        this.changed();
    }

    _models() { return [...this._ollama?.models ?? [], ...this._lmStudio?.models ?? [], ...this._llama?.healthy ? [{name: 'llama.cpp'}] : []]; }

    cell() {
        const models = this._models();
        const vram = (this._ollama?.models ?? []).reduce((sum, m) => sum + (m.vram ?? 0), 0);
        const fraction = this._totalVram ? Math.min(1, vram / this._totalVram) : null;
        const busy = this._measuring.size || this._llama?.slots?.busy || this._llama?.metrics?.processing;
        return {...super.cell(), badge: BADGES.models, accent: MODULE_COLORS.models, meter: true,
            light: busy ? 'working' : 'off',
            fraction, label: this._ollama ? String(models.length) : '—', stale: !this._ollama,
            accessibleName: `Local models: ${models.length} loaded${fraction === null ? '' : `, ${Math.round(fraction * 100)}% of GPU memory`}`};
    }

    card(body, ui) {
        if (!this._ollama) {
            body.add_child(ui.label('checking local model servers…', 'ledge-caption'));
            return [['Refresh', () => this._poll()]];
        }
        const vram = this._ollama.models.reduce((sum, m) => sum + (m.vram ?? 0), 0);
        if (this._totalVram)
            body.add_child(ui.bar('GPU memory', `${formatBytes(vram)} of ${formatBytes(this._totalVram)}`,
                vram / this._totalVram, false, MODULE_COLORS.models, 'used by Ollama models'));
        for (const [backend, state] of [['Ollama', this._ollama], ['LM Studio', this._lmStudio]]) {
            const section = ui.section(backend);
            body.add_child(section);
            if (state.message) section.add_child(ui.label(state.message, 'ledge-caption'));
            else if (!state.models.length) section.add_child(ui.label('no models loaded', 'ledge-caption'));
            if (backend === 'LM Studio' && this._logs?.logs)
                section.add_child(ui.splitRow('requests today · 7 days', `${this._logs.today} · ${this._logs.week}`, 'ledge-figure'));
            for (const m of state.models) {
                const parts = [`size ${formatBytes(m.size)}`];
                if (backend === 'Ollama') parts.push(`vram ${formatBytes(m.vram)}`);
                if (m.context) parts.push(`ctx ${m.context}`);
                if (m.quant) parts.push(m.quant);
                if (this._speeds.has(m.name)) parts.push(this._speeds.get(m.name));
                const trailing = backend === 'Ollama'
                    ? [ui.button(this._measuring.has(m.name) ? 'measuring…' : 'measure speed', () => this._measure(m.name), 'ledge-small-action')]
                    : [];
                section.add_child(ui.row(m.name, {detail: parts.join(' · '), trailing, mono: true}));
            }
        }
        if (this._llama) {
            const section = ui.section('llama.cpp');
            body.add_child(section);
            if (this._llama.message) section.add_child(ui.label(this._llama.message, 'ledge-caption'));
            else {
                const slots = this._llama.slots;
                section.add_child(ui.splitRow('slots busy', slots ? `${slots.busy} of ${slots.total}` : 'start with --slots', 'ledge-figure'));
                if (slots?.context) section.add_child(ui.splitRow('context', String(slots.context), 'ledge-figure'));
                const m = this._llama.metrics;
                if (Object.keys(m).length) {
                    section.add_child(ui.splitRow('prompt', tokenRate(m.promptSpeed), 'ledge-figure'));
                    section.add_child(ui.splitRow('generate', tokenRate(m.generateSpeed), 'ledge-figure'));
                } else section.add_child(ui.label('start with --metrics for speeds', 'ledge-caption'));
            }
        }
        return [['Refresh', () => this._poll()]];
    }

    stop() {
        if (this._settingsSignal) this.settings.disconnect(this._settingsSignal);
        this._settingsSignal = 0;
        super.stop();
    }
}
