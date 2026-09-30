import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseTodos, sortTodos, formatBytes, tokensPerSecond, ollamaModels, lmStudioModels, parseRepos,
    isGithubUrl, pullRequests, ciState, parseRun, runState, runProgress, formatLoss, formatDuration} from '../model.js';

test('todos parse defensively and sort open first', () => {
    const todos = parseTodos(JSON.stringify([
        {id: 'a', text: ' done old ', done: true, created: 1},
        {id: 'b', text: 'open new', created: 3},
        {id: 'c', text: 'open old', created: 2},
        {text: '   '}, null, 'junk',
    ]));
    assert.equal(todos.length, 3);
    assert.equal(todos[0].text, 'done old');
    assert.deepEqual(sortTodos(todos).map(t => t.id), ['c', 'b', 'a']);
    assert.throws(() => parseTodos('{"not": "a list"}'));
    assert.throws(() => parseTodos('{broken'));
});

test('bytes and token speed', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(4.5 * 1024 ** 3), '4.5 GB');
    assert.equal(formatBytes(12 * 1024 ** 3), '12 GB');
    assert.equal(formatBytes(null), '—');
    assert.equal(tokensPerSecond(100, 2e9), 50);
    assert.equal(tokensPerSecond(0, 1e9), null);
    assert.equal(tokensPerSecond(10, 0), null);
});

test('ollama and lm studio model lists', () => {
    assert.deepEqual(ollamaModels({models: [{name: 'llama3:8b', size: 5e9, size_vram: 4e9}, {size: 1}]}),
        [{backend: 'Ollama', name: 'llama3:8b', size: 5e9, vram: 4e9}]);
    assert.deepEqual(ollamaModels(null), []);
    const v1 = {models: [{key: 'qwen', display_name: 'Qwen 7B', size_bytes: 4e9, loaded_instances: [{id: 'qwen'}]},
        {key: 'idle', loaded_instances: []}]};
    assert.deepEqual(lmStudioModels(v1), [{backend: 'LM Studio', name: 'Qwen 7B', size: 4e9, vram: null}]);
    const v0 = {data: [{id: 'qwen', state: 'loaded'}, {id: 'idle', state: 'not-loaded'}]};
    assert.deepEqual(lmStudioModels(v0).map(m => m.name), ['qwen']);
});

test('github repos, urls and ci state', () => {
    assert.deepEqual(parseRepos('shiv2077/ledge, --evil/x bad a/b a/b\nfoo'), ['shiv2077/ledge', 'a/b']);
    assert.ok(isGithubUrl('https://github.com/a/b/pull/1'));
    assert.ok(!isGithubUrl('https://evil.com/github.com'));
    assert.deepEqual(pullRequests([{title: 'Fix', url: 'https://github.com/a/b/pull/2', number: 2,
        repository: {nameWithOwner: 'a/b'}}, {url: 'http://x'}]), [{title: 'Fix', url: 'https://github.com/a/b/pull/2', number: 2, repo: 'a/b'}]);
    assert.equal(ciState({status: 'in_progress', conclusion: ''}), 'running');
    assert.equal(ciState({status: 'queued', conclusion: null}), 'running');
    assert.equal(ciState({status: 'completed', conclusion: 'failure'}), 'failed');
    assert.equal(ciState({status: 'completed', conclusion: 'timed_out'}), 'failed');
    assert.equal(ciState({status: 'completed', conclusion: 'success'}), 'passed');
    assert.equal(ciState({status: 'completed', conclusion: 'cancelled'}), 'cancelled');
    assert.equal(ciState(undefined), 'none');
});

test('training run files', () => {
    const run = parseRun(JSON.stringify({name: 'gpt', state: 'running', epoch: 3, total_epochs: 10, step: 50,
        loss: 0.12345, eta_seconds: 3700, updated_at: 1000}));
    assert.equal(runProgress(run), 0.3);
    assert.equal(runState(run, 1000 + 599, 600), 'running');
    assert.equal(runState(run, 1000 + 601, 600), 'stalled');
    assert.equal(runState({...run, state: 'done'}, 1e9, 600), 'done');
    assert.equal(runProgress({...run, totalEpochs: null}), null);
    assert.throws(() => parseRun('{"name": "x", "state": "exploded", "updated_at": 1}'));
    assert.throws(() => parseRun('{"name": "x", "state": "done"}'));
    assert.equal(formatLoss(0.12345), '0.123');
    assert.equal(formatLoss(12.34), '12.3');
    assert.equal(formatLoss(null), '—');
    assert.equal(formatDuration(3700), '1h 2m');
    assert.equal(formatDuration(90), '2m');
    assert.equal(formatDuration(null), '—');
});
