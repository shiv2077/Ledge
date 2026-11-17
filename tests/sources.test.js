import test from 'node:test';
import assert from 'node:assert/strict';
import {ollamaModels, llamaSlots, llamaMetrics, tokenRate, copilotQuota} from '../model.js';

test('Ollama /api/ps details', () => {
    const [m] = ollamaModels({models: [{name: 'qwen3:8b', size: 10, size_vram: 8, context_length: 8192,
        expires_at: '2030-01-01T00:00:00Z', details: {quantization_level: 'Q4_K_M'}}]});
    assert.deepEqual([m.context, m.quant, m.expiresAt], [8192, 'Q4_K_M', '2030-01-01T00:00:00Z']);
    const [bare] = ollamaModels({models: [{name: 'x'}]});
    assert.deepEqual([bare.context, bare.quant, bare.expiresAt], [null, null, null]);
});

test('llama.cpp slots, old and new fields', () => {
    assert.deepEqual(llamaSlots([{n_ctx: 4096, is_processing: true}, {is_processing: false}]), {total: 2, busy: 1, context: 4096});
    assert.deepEqual(llamaSlots([{state: 1}, {state: 0}, {state: 1}]), {total: 3, busy: 2, context: null});
    assert.equal(llamaSlots({error: 'slots disabled'}), null);
});

test('llama.cpp metrics', () => {
    const text = [
        '# HELP llamacpp:prompt_tokens_seconds Average prompt throughput in tokens/s.',
        '# TYPE llamacpp:prompt_tokens_seconds gauge',
        'llamacpp:prompt_tokens_seconds 812.4',
        'llamacpp:predicted_tokens_seconds 41.7',
        'llamacpp:requests_processing 1',
        'llamacpp:tokens_predicted_total 12345',
        'other_metric 3',
        'llamacpp:predicted_tokens_seconds{slot="0"} NaN',
    ].join('\n');
    assert.deepEqual(llamaMetrics(text), {promptSpeed: 812.4, generateSpeed: 41.7, processing: 1, predictedTotal: 12345});
    assert.deepEqual(llamaMetrics(null), {});
    assert.equal(tokenRate(41.73), '41.7 tok/s');
    assert.equal(tokenRate(0), '—');
});

test('Copilot quota keeps quota fields only', () => {
    const quota = copilotQuota({copilot_plan: 'individual', quota_reset_date: '2030-02-01', analytics_tracking_id: 'x',
        endpoints: {api: 'https://example.invalid'},
        quota_snapshots: {premium_interactions: {percent_remaining: 64, remaining: 192, entitlement: 300, unlimited: false, overage_count: 2},
            chat: {unlimited: true}, completions: {percent_remaining: 'bad'}}});
    assert.equal(quota.plan, 'individual');
    assert.equal(quota.resetsAt, '2030-02-01');
    assert.deepEqual(quota.windows.map(w => [w.id, w.usedPercent, w.unlimited]), [['premium_interactions', 36, false], ['chat', 0, true]]);
    assert.equal(quota.windows[0].overage, 2);
    assert.ok(!JSON.stringify(quota).includes('example.invalid'));
    assert.equal(copilotQuota({copilot_plan: 'free'}), null);
});
