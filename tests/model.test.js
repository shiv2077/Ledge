import {test} from 'node:test';
import assert from 'node:assert/strict';
import {position, percentage, resetText, normalize, usageSummary, remainingPercent} from '../model.js';

test('edges respect work area origin and dimensions', () => {
    const a = {x: 1920, y: 32, width: 1280, height: 968};
    assert.deepEqual(position('right', a, 60, 200), {x: 3140, y: 416});
    assert.deepEqual(position('left', a, 60, 200), {x: 1920, y: 416});
    assert.deepEqual(position('top', a, 200, 60), {x: 2460, y: 32});
    assert.deepEqual(position('bottom', a, 200, 60), {x: 2460, y: 940});
});
test('unknown values never become zero and overspend remains visible', () => {
    for (const value of [null, undefined, NaN, Infinity, -1, true, '0']) assert.equal(percentage(value), '—');
    assert.equal(percentage(0), '0%');
    assert.equal(percentage(110), '110%');
});
test('expired reset does not claim allowance replenished', () => {
    assert.equal(resetText('2026-01-01T00:00:00Z', Date.parse('2026-01-02')), 'Reset due · refresh for latest');
    assert.equal(resetText(null), 'Reset time unavailable');
});
test('remaining summary matches tooltip copy and preserves overspend', () => {
    assert.equal(usageSummary(73), '27% left');
    assert.equal(usageSummary(0), '100% left');
    assert.equal(usageSummary(100), '0% left');
    assert.equal(usageSummary(110), '0% left · 10% over limit');
    for (const value of [null, undefined, NaN, Infinity, -1, true, '0'])
        assert.equal(remainingPercent(value), null);
    assert.equal(usageSummary(null), '');
});
test('reader boundary drops disabled and invalid readings', () => {
    const rows = normalize({version: 1, providers: [{id: 'codex', status: 'ok', windows: [{usedPercent: null}, {usedPercent: 0, label: 'Session'}]}, {id: 'claude'}]}, ['codex', 'cursor']);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].windows.length, 1);
    assert.equal(rows[0].windows[0].usedPercent, 0);
    assert.equal(rows[1].status, 'error');
    assert.throws(() => normalize({}, []));
});
