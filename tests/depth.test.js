import test from 'node:test';
import assert from 'node:assert/strict';
import {resetText, normalize, accountKey, accountName, paceDeficit, paceText, headlineWindow, orderUsage, money} from '../model.js';

const HOUR = 3600e3;
const NOW = Date.parse('2030-01-01T12:00:00Z');

test('clock reset format shows local time, with a weekday beyond a day', () => {
    const soon = new Date(NOW + 2 * HOUR + 30 * 60e3);
    const pad = n => String(n).padStart(2, '0');
    assert.equal(resetText(soon.toISOString(), NOW, 'clock'), `resets ${pad(soon.getHours())}:${pad(soon.getMinutes())}`);
    const later = new Date(NOW + 50 * HOUR);
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][later.getDay()];
    assert.equal(resetText(later.toISOString(), NOW, 'clock'), `resets ${day} ${pad(later.getHours())}:${pad(later.getMinutes())}`);
    assert.equal(resetText(soon.toISOString(), NOW), 'resets in 2h 30m');
});

test('extra accounts follow the default, by slug, and bad slugs are dropped', () => {
    const rows = normalize({version: 1, providers: [
        {id: 'claude', account: 'work', status: 'ok', windows: []},
        {id: 'claude', account: 'Bad Slug', status: 'ok', windows: []},
        {id: 'claude', account: 'alt', status: 'ok', windows: []},
        {id: 'codex', status: 'ok', windows: [{usedPercent: 3, windowMinutes: 300}, {usedPercent: 1, windowMinutes: 'x'}]},
    ]}, ['claude', 'codex']);
    assert.deepEqual(rows.map(accountKey), ['claude', 'claude:alt', 'claude:work', 'codex']);
    assert.equal(rows[0].status, 'error');
    assert.deepEqual(rows[3].windows.map(w => w.windowMinutes), [300, null]);
    assert.equal(accountName('side-work'), 'Side Work');
});

test('pace compares use with elapsed time in the window', () => {
    const window = {usedPercent: 60, windowMinutes: 300, resetsAt: new Date(NOW + 150 * 60e3).toISOString()};
    assert.equal(paceDeficit(window, NOW), 10);
    assert.equal(paceText(10), '10% ahead of pace');
    assert.equal(paceText(-20), '20% under pace');
    assert.equal(paceText(3), 'on pace');
    assert.equal(paceDeficit({...window, windowMinutes: null}, NOW), null);
    assert.equal(paceDeficit({...window, resetsAt: new Date(NOW + 400 * 60e3).toISOString()}, NOW), null);
    assert.equal(paceText(null), '');
});

test('headline window choice', () => {
    const windows = [{usedPercent: 10, windowMinutes: 300}, {usedPercent: 70, windowMinutes: 10080}, {usedPercent: 90, windowMinutes: null}];
    assert.equal(headlineWindow(windows, 'session'), windows[0]);
    assert.equal(headlineWindow(windows, 'weekly'), windows[1]);
    assert.equal(headlineWindow(windows, 'tightest'), windows[2]);
    assert.equal(headlineWindow([], 'session'), null);
});

test('usage order moves only usage cells', () => {
    const cell = (key, remaining, deficit) => ({key, info: remaining === undefined ? {} : {usage: {remaining, deficit}}});
    const cells = [cell('a', 50, 0), cell('b', 10, -30), cell('power'), cell('c', null, null), cell('d', 30, 20)];
    assert.deepEqual(orderUsage(cells, 'fixed').map(c => c.key), ['a', 'b', 'power', 'c', 'd']);
    assert.deepEqual(orderUsage(cells, 'remaining').map(c => c.key), ['b', 'd', 'power', 'a', 'c']);
    assert.deepEqual(orderUsage(cells, 'deficit').map(c => c.key), ['d', 'a', 'power', 'b', 'c']);
});

test('money', () => {
    assert.equal(money(4.5), '$4.50');
    assert.equal(money(123.4), '$123');
    assert.equal(money(null), '—');
});

test('short reset text', async () => {
    const {resetShort} = await import('../model.js');
    const now = Date.parse('2030-01-01T00:00:00Z');
    assert.equal(resetShort('2030-01-01T00:45:00Z', now), '45m');
    assert.equal(resetShort('2030-01-01T02:14:00Z', now), '2h 14m');
    assert.equal(resetShort('2030-01-04T04:00:00Z', now), '3d 4h');
    assert.equal(resetShort(null, now), '');
});
