import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sessionEvents, limitAlerts, parentPid, matchCodexPid} from '../lib/alerts.js';

const s = (id, state, extra = {}) => ({id, name: id, state, ...extra});

test('the first reading only records history', () => {
    const {events, next} = sessionEvents(null, [s('a', 'waiting'), s('b', 'busy')]);
    assert.deepEqual(events, []);
    assert.equal(next.get('a'), 'waiting');
});

test('waiting, then busy, then idle announces needs-you and finished once each', () => {
    let history = sessionEvents(null, [s('a', 'busy')]).next;
    let step = sessionEvents(history, [s('a', 'waiting')]);
    assert.deepEqual(step.events.map(e => e.kind), ['waiting']);
    step = sessionEvents(step.next, [s('a', 'waiting')]);
    assert.deepEqual(step.events, [], 'still waiting is not announced again');
    step = sessionEvents(step.next, [s('a', 'busy')]);
    assert.deepEqual(step.events, []);
    step = sessionEvents(step.next, [s('a', 'idle')]);
    assert.deepEqual(step.events.map(e => e.kind), ['finished']);
    step = sessionEvents(step.next, [s('a', 'idle')]);
    assert.deepEqual(step.events, []);
});

test('a session that vanishes while busy is the user quitting', () => {
    const history = sessionEvents(null, [s('a', 'busy')]).next;
    assert.deepEqual(sessionEvents(history, []).events, []);
});

test('a new session that already waits is announced; estimates never are', () => {
    const history = sessionEvents(null, []).next;
    assert.deepEqual(sessionEvents(history, [s('n', 'waiting')]).events.map(e => e.kind), ['waiting']);
    const derived = sessionEvents(sessionEvents(null, [s('c', 'busy', {derived: true})]).next, [s('c', 'idle', {derived: true})]);
    assert.deepEqual(derived.events, []);
    assert.deepEqual(sessionEvents(sessionEvents(null, [s('i', 'idle')]).next, [s('i', 'idle')]).events, [], 'idle to idle is quiet');
});

test('limit alerts fire at 80 and at 100, once each, and re-arm on rollover', () => {
    const w = (used, resetsAt = '2026-11-17T10:00:00Z') => ({usedPercent: used, resetsAt});
    let r = limitAlerts(null, w(50));
    assert.deepEqual(r.alerts, [], 'first reading records only');
    r = limitAlerts(r.state, w(79));
    assert.deepEqual(r.alerts, []);
    r = limitAlerts(r.state, w(81));
    assert.deepEqual(r.alerts, [80]);
    r = limitAlerts(r.state, w(90));
    assert.deepEqual(r.alerts, []);
    r = limitAlerts(r.state, w(100));
    assert.deepEqual(r.alerts, [100]);
    for (const used of [104, 100, 120]) {
        r = limitAlerts(r.state, w(used));
        assert.deepEqual(r.alerts, [], 'staying above 100 stays quiet');
    }
    r = limitAlerts(r.state, w(85, '2026-11-17T15:00:00Z'));
    assert.deepEqual(r.alerts, [80], 'rollover re-arms');
    r = limitAlerts(r.state, w(101, '2026-11-17T15:00:00Z'));
    assert.deepEqual(r.alerts, [100]);
});

test('jumping straight past both steps announces both; a first reading above 80 is not a crossing', () => {
    let r = limitAlerts(null, {usedPercent: 10, resetsAt: null});
    r = limitAlerts(r.state, {usedPercent: 100, resetsAt: null});
    assert.deepEqual(r.alerts, [80, 100]);
    r = limitAlerts(null, {usedPercent: 85, resetsAt: null});
    assert.deepEqual(r.alerts, []);
    assert.deepEqual(limitAlerts(r.state, {usedPercent: 99, resetsAt: null}).alerts, []);
    assert.deepEqual(limitAlerts(r.state, {usedPercent: null, resetsAt: null}).alerts, [], 'no reading, no alert');
});

test('parent pid survives command names with spaces and parentheses', () => {
    assert.equal(parentPid('4242 (node) S 4100 4242 4242 0 -1'), 4100);
    assert.equal(parentPid('77 (my (odd) name) R 12 77 77'), 12);
    assert.equal(parentPid('1 (systemd) S 0 1 1'), null);
    assert.equal(parentPid('garbage'), null);
});

test('a Codex session finds its process by working folder', () => {
    const candidates = [{pid: 900, cwd: '/a'}, {pid: 700, cwd: '/b'}, {pid: 650, cwd: '/b'}];
    assert.equal(matchCodexPid(candidates, '/b'), 650);
    assert.equal(matchCodexPid(candidates, '/c'), null);
    assert.equal(matchCodexPid(candidates, ''), null);
});
