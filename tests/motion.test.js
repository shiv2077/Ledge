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

test('glass clip rectangles follow the notch outline', async () => {
    const {notchRects, roundedRectRects} = await import('../design.js');
    const [w, h] = [70, 400];
    const rects = notchRects('right', w, h);
    const covered = (x, y) => rects.some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh);
    const {curl, corner} = notchGeometry(w, h);
    const mid = Math.floor(curl / 2);
    const flareX = w - curl + Math.sqrt(curl * curl - (mid + 0.5) ** 2);
    assert.ok(covered(Math.ceil(flareX) + 1, mid) && !covered(Math.floor(flareX) - 2, mid), 'flare follows its arc');
    assert.ok(!covered(0, 1), 'far side of the flare is outside');
    assert.ok(covered(w - 1, curl + 1), 'bezel side inside after the flare');
    assert.ok(!covered(0, curl + 1), 'rounded corner cuts the far side');
    assert.ok(covered(0, h / 2) && covered(w - 1, h / 2), 'body spans the full depth');
    assert.ok(covered(0, curl + corner + 1), 'full width once past the corner');
    assert.ok(rects.length < 2 * (curl + corner) + 3, 'body rows merge into one rectangle');
    // Mirrored and rotated edges cover the same area.
    const area = list => list.reduce((sum, [, , rw, rh]) => sum + rw * rh, 0);
    assert.equal(area(notchRects('left', w, h)), area(rects));
    assert.equal(area(notchRects('top', h, w)), area(rects));
    assert.equal(area(notchRects('bottom', h, w)), area(rects));
    assert.ok(notchRects('top', h, w).every(([x, y]) => y === 0), 'top notch hangs from the top edge');
    const card = roundedRectRects(300, 200, 16);
    const cardCovered = (x, y) => card.some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh);
    assert.ok(!cardCovered(0, 0) && cardCovered(150, 0) && cardCovered(0, 100) && !cardCovered(299, 199));
});
