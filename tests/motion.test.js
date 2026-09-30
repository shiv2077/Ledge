import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LAYOUT, springSample, notchGeometry} from '../design.js';
import {traceNotchPath} from '../draw.js';

test('closed handle retains the two inverse bezel joins', () => {
    const arcs = [];
    const context = {newSubPath() {}, moveTo() {}, lineTo() {}, closePath() {},
        arc(...args) { arcs.push(args); }, arcNegative() {}};
    traceNotchPath(context, 10, 79, 'right');
    assert.equal(arcs.length, 2, 'The handle has inverse joins, not a capsule with four round corners');
    assert.deepEqual(arcs.map(a => a.slice(0, 3)), [[5, 0, 5], [5, 79, 5]]);
    assert.ok(Math.abs(LAYOUT.pillWidth - 10) < 0.5 && Math.abs(LAYOUT.pillHeight - 79) < 0.5);
});

test('folding geometry stays valid continuously down to the handle', () => {
    for (let depth = 10; depth <= 72; depth += 0.25) {
        const {curl, corner} = notchGeometry(depth, 79 + (depth - 10) * 5);
        assert.ok(curl > 0 && corner > 0);
        assert.ok(curl + corner <= depth + 1e-9);
    }
});

test('reversing a live spring preserves position and velocity, then settles', () => {
    const opening = springSample(0, 1, 0, 0.12);
    const reversal = springSample(opening.value, 0, opening.velocity, 0);
    assert.ok(Math.abs(reversal.value - opening.value) < 1e-12);
    assert.ok(Math.abs(reversal.velocity - opening.velocity) < 1e-12);
    const end = springSample(opening.value, 0, opening.velocity, 0.8);
    assert.ok(Math.abs(end.value) < 0.001);
    assert.ok(Math.abs(end.velocity) < 0.01);
    assert.ok(springSample(0, 1, 0, 0.08).value < 0.6, 'Opening must pass through intermediate sizes');
});
