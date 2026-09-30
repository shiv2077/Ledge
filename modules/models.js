import {Module} from '../lib/module.js';
import {run} from '../lib/subprocess.js';
import {getJson, postJson} from '../lib/http.js';
import {formatBytes, tokensPerSecond, ollamaModels, lmStudioModels} from '../model.js';
import {MODULE_COLORS} from '../design.js';

const OLLAMA = 'http://127.0.0.1:11434';
const LM_STUDIO = 'http://127.0.0.1:1234';
const LM_STUDIO_PATHS = ['/api/v1/models', '/api/v0/models'];
const MEASURE_PROMPT = 'Write two sentences about the sea.';
const MEASURE_TOKENS = 64;
const MEASURE_TIMEOUT = 120;

export class ModelsModule extends Module {
    static id = 'models';
    static title = 'Local Models';

    start() {
        this._ollama = null;
        this._lmStudio = null;
        this._totalVram = null;
        this._speeds = new Map();
        this._measuring = new Set();
        this._readGpuMemory();
        this._poll();
        this._schedule();
        this._settingsSignal = this.settings.connect('changed::models-poll-seconds', () => this._schedule());
    }

    _schedule() {
        this._timer = this.clearTimer(this._timer);
        this._timer = this.every(this.settings.get_int('models-poll-seconds'), () => this._poll());
    }

    // Total GPU memory, read once: it may wake a sleeping dGPU. Missing
    // nvidia-smi leaves the ring empty.
    async _readGpuMemory() {
        const result = await run(['nvidia-smi', '--query-gpu=memory.total', '--format=csv,noheader,nounits'],
            {timeout: 15, cancellable: this.cancellable});
        const mib = parseInt(result.stdout.split('\n')[0], 10);
        if (result.ok && Number.isFinite(mib) && mib > 0) {
            this._totalVram = mib * 1024 * 1024;
            this.changed();
        }
    }

    async _poll() {
        if (this._polling) return;
        this._polling = true;
        const [ollama, lmStudio] = await Promise.all([this._readOllama(), this._readLmStudio()]);
        this._polling = false;
        if (this.cancellable.is_cancelled()) return;
        if (JSON.stringify([ollama, lmStudio]) === JSON.stringify([this._ollama, this._lmStudio])) return;
        this._ollama = ollama;
        this._lmStudio = lmStudio;
        this.changed();
    }

    async _readOllama() {
        const r = await getJson(`${OLLAMA}/api/ps`, {timeout: 3, cancellable: this.cancellable});
        if (r.ok) return {models: ollamaModels(r.data), message: ''};
        return {models: [], message: r.status ? `Ollama answered ${r.status}.` : 'Ollama is not running.'};
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
            if (!r.status) return {models: [], message: 'LM Studio server is off.'};
        }
        this._lmStudioPath = null;
        return {models: [], message: 'LM Studio server did not list models.'};
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

    _models() { return [...this._ollama?.models ?? [], ...this._lmStudio?.models ?? []]; }

    cell() {
        const models = this._models();
        const vram = (this._ollama?.models ?? []).reduce((sum, m) => sum + (m.vram ?? 0), 0);
        const fraction = this._totalVram ? Math.min(1, vram / this._totalVram) : null;
        return {...super.cell(), icon: 'computer-chip-symbolic', accent: MODULE_COLORS.models,
            fraction, label: this._ollama ? String(models.length) : '—', stale: !this._ollama,
            accessibleName: `Local models: ${models.length} loaded${fraction === null ? '' : `, ${Math.round(fraction * 100)}% of GPU memory`}`};
    }

    card(body, ui) {
        if (!this._ollama) {
            body.add_child(ui.label('Checking Ollama and LM Studio…', 'ledge-muted'));
            return [['Refresh', () => this._poll()]];
        }
        const vram = this._ollama.models.reduce((sum, m) => sum + (m.vram ?? 0), 0);
        if (this._totalVram)
            body.add_child(ui.bar('GPU memory', `${formatBytes(vram)} of ${formatBytes(this._totalVram)}`,
                vram / this._totalVram, false, MODULE_COLORS.models, 'Used by Ollama models'));
        for (const [backend, state] of [['Ollama', this._ollama], ['LM Studio', this._lmStudio]]) {
            body.add_child(ui.label(backend, 'ledge-section'));
            if (state.message) body.add_child(ui.label(state.message, 'ledge-muted'));
            else if (!state.models.length) body.add_child(ui.label('No models loaded.', 'ledge-muted'));
            for (const m of state.models) {
                const parts = [`Size ${formatBytes(m.size)}`];
                if (backend === 'Ollama') parts.push(`VRAM ${formatBytes(m.vram)}`);
                if (this._speeds.has(m.name)) parts.push(this._speeds.get(m.name));
                const trailing = backend === 'Ollama'
                    ? [ui.button(this._measuring.has(m.name) ? 'Measuring…' : 'Measure speed', () => this._measure(m.name), 'ledge-small-action')]
                    : [];
                body.add_child(ui.row(m.name, {detail: parts.join(' · '), trailing}));
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
