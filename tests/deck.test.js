import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CHAMFER, METER, MOTION, SPACE, TICK, CHIP, chamferPoints, chamferRects, meterSegments, poweredSegments, urgency,
    approach, settle, unfoldFrame, unfoldDuration, foldFrame, foldDuration, railSize, chipMeterWidth} from '../design.js';
import {stampText} from '../model.js';

const EDGES = ['right', 'left', 'top', 'bottom'];
const polygonArea = points => Math.abs(points.reduce((sum, [x, y], i) => {
    const [nx, ny] = points[(i + 1) % points.length];
    return sum + x * ny - nx * y;
}, 0)) / 2;
const rectArea = rects => rects.reduce((sum, [, , w, h]) => sum + w * h, 0);

test('spacing stays on the 4 px grid', () => {
    assert.deepEqual(Object.values(SPACE), [4, 8, 12, 16, 24]);
    assert.deepEqual([CHAMFER.small, CHAMFER.large], [4, 10]);
    assert.equal(chipMeterWidth(), 43.5);
    assert.ok(Math.ceil(chipMeterWidth()) + CHIP.badge + 6 + 4 * SPACE.sm === CHIP.railWidth, 'chip contents fill the chip exactly');
});

test('chamfer rectangles match the polygon within 1 % and stay inside the bounds', () => {
    for (const [w, h, cut] of [[104, 372, CHAMFER.large], [340, 260, CHAMFER.large], [800, 44, CHAMFER.large], [4, 44, CHAMFER.small]]) {
        for (const edge of EDGES) {
            const vertical = edge === 'left' || edge === 'right';
            const [width, height] = vertical ? [w, h] : [h, w];
            const rects = chamferRects(edge, width, height, cut);
            const want = polygonArea(chamferPoints(edge, width, height, cut));
            assert.ok(Math.abs(rectArea(rects) - want) / want <= 0.01, `${edge} ${width}x${height}: ${rectArea(rects)} vs ${want}`);
            for (const [x, y, rw, rh] of rects)
                assert.ok(x >= 0 && y >= 0 && x + rw <= width && y + rh <= height, `${edge}: rectangle inside bounds`);
        }
    }
});

test('only the corners away from the edge are cut', () => {
    const covered = (rects, x, y) => rects.some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh);
    const right = chamferRects('right', 100, 200, 10);
    assert.ok(covered(right, 99, 0) && covered(right, 99, 199), 'corners against the right edge stay square');
    assert.ok(!covered(right, 0, 0) && !covered(right, 0, 199) && covered(right, 0, 100), 'far corners are cut');
    const top = chamferRects('top', 200, 100, 10);
    assert.ok(covered(top, 0, 0) && covered(top, 199, 0) && !covered(top, 0, 99) && !covered(top, 199, 99));
    const bottom = chamferRects('bottom', 200, 100, 10);
    assert.ok(covered(bottom, 0, 99) && !covered(bottom, 0, 0));
    assert.ok(right.length <= 2 * 10 + 1, 'body rows merge into one rectangle');
    // A cut is at 45 degrees: the outline has exactly two diagonal segments.
    const points = chamferPoints('right', 100, 200, 10);
    const diagonals = points.filter(([x, y], i) => {
        const [nx, ny] = points[(i + 1) % points.length];
        return x !== nx && y !== ny;
    });
    assert.equal(diagonals.length, 2);
    // The tick is thinner than its cut, so the cut shrinks to half the depth.
    assert.deepEqual(chamferPoints('right', TICK.thickness, TICK.length, CHAMFER.small)[2], [0, 2]);
});

test('meter lights in proportion and never rounds a reading up', () => {
    assert.deepEqual(meterSegments(0.5, 10), [1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
    const partial = meterSegments(0.27, 10);
    assert.deepEqual(partial.slice(0, 2), [1, 1]);
    assert.ok(Math.abs(partial[2] - 0.7) < 1e-9 && partial[3] === 0, 'partial segment is proportional');
    assert.deepEqual(meterSegments(1.4, 4), [1, 1, 1, 1]);
    for (const none of [null, undefined, NaN, '0.5'])
        assert.deepEqual(meterSegments(none, 4), [0, 0, 0, 0], 'no reading lights nothing');
    assert.deepEqual(meterSegments(0, 4), [0, 0, 0, 0]);
    assert.equal(METER.staleAlpha, 0.45);
});

test('power-on lights whole segments one after another', () => {
    const fills = meterSegments(0.45, 10);
    assert.deepEqual(poweredSegments(fills, 0), Array(10).fill(0));
    assert.deepEqual(poweredSegments(fills, 0.5).filter(f => f > 0).length, 3);
    assert.deepEqual(poweredSegments(fills, 1), fills);
});

test('the most urgent state wins: failed, waiting, working, off', () => {
    assert.equal(urgency([]), 'off');
    assert.equal(urgency(['off', 'working']), 'working');
    assert.equal(urgency(['working', 'waiting', 'off']), 'waiting');
    assert.equal(urgency(['waiting', 'failed', 'working']), 'failed');
});

test('unfold stretches, then grows, then chips enter in order and power on', () => {
    assert.equal(approach(0), 0);
    assert.equal(approach(1), 1);
    for (let t = 0; t <= 1; t += 0.05) assert.ok(approach(t) <= 1, 'length never overshoots');
    let peak = 0;
    for (let t = 0; t <= 1; t += 0.01) peak = Math.max(peak, settle(t));
    assert.ok(peak > 1 && peak < 1.02, `depth settles lightly past the target, peak ${peak}`);

    const early = unfoldFrame(80, 8);
    assert.ok(early.length > 0.5 && early.depth === 0 && early.chips.every(c => c.enter === 0), 'the tick stretches first');
    const mid = unfoldFrame(200, 8);
    assert.ok(mid.length === 1 && mid.depth > 0.5 && mid.chips[0].enter > mid.chips[3].enter, 'chips enter in order');
    assert.equal(unfoldFrame(MOTION.chipStart + MOTION.chipStagger, 8).chips[1].enter, 0, '18 ms stagger');
    const landed = unfoldFrame(MOTION.chipStart + MOTION.chipEnter + MOTION.meterPower / 2, 8).chips[0];
    assert.deepEqual([landed.enter, landed.power], [1, 0.5], 'a meter powers on once its chip has landed');
    const end = unfoldFrame(unfoldDuration(8), 8);
    assert.ok(end.length === 1 && end.depth === 1 && end.chips.every(c => c.enter === 1 && c.power === 1));
    assert.equal(MOTION.unfoldDepthStart + MOTION.unfoldDepth, 260);
});

test('fold is faster than unfold and removes chips, depth, then length', () => {
    assert.ok(foldDuration() < unfoldDuration(1));
    const start = foldFrame(MOTION.foldChips);
    assert.ok(start.chips === 1 && start.depth < 1 && start.length === 0);
    assert.deepEqual(foldFrame(foldDuration()), {chips: 1, depth: 1, length: 1});
});

test('rail size follows the chip count and orientation', () => {
    assert.deepEqual(railSize(8, true), {length: 2 * 12 + 8 * 36 + 7 * 4, depth: 104});
    assert.deepEqual(railSize(3, false), {length: 2 * 12 + 3 * 96 + 2 * 4, depth: 44});
    assert.deepEqual(railSize(0, true), {length: 24, depth: 104});
});

test('deck timestamp says live with the time or stale with the age', () => {
    const at = new Date(2026, 0, 5, 9, 39).getTime();
    assert.equal(stampText({updatedAt: at, stale: false}), 'live 09:39');
    assert.equal(stampText({updatedAt: at, stale: true}, at + 14 * 60000), 'stale 14m');
    assert.equal(stampText({updatedAt: at, stale: true}, at + 5 * 3600000), 'stale 5h');
    assert.equal(stampText({updatedAt: null, stale: true}), '');
});

test('a deck stays within the rail span, centred on its chip', async () => {
    const {deckSpan} = await import('../design.js');
    assert.equal(deckSpan(100, 400, 300, 200, 0), 200, 'centred on the chip');
    assert.equal(deckSpan(100, 400, 130, 200, 0), 100, 'never starts before the rail');
    assert.equal(deckSpan(100, 400, 490, 200, 0), 300, 'never runs past the rail end');
    assert.equal(deckSpan(100, 300, 250, 340, 0), 100, 'a longer deck starts with the rail');
    assert.equal(deckSpan(100, 400, 130, 200), 110, 'stays clear of the rail chamfer');
    assert.equal(deckSpan(100, 400, 490, 200), 290, 'at both ends');
});

test('the top bar strip falls back to compact chips, then one summary chip', async () => {
    const {stripMode, CHIP} = await import('../design.js');
    assert.equal(stripMode(8, 8 * CHIP.panelWidth + 7), 'full');
    assert.equal(stripMode(8, 8 * CHIP.panelWidth + 6), 'compact');
    assert.equal(stripMode(8, 8 * CHIP.compactWidth + 7), 'compact');
    assert.equal(stripMode(8, 8 * CHIP.compactWidth + 6), 'summary');
    assert.equal(stripMode(0, 0), 'full');
    assert.deepEqual([CHIP.railWidth, CHIP.panelWidth, CHIP.compactWidth, CHIP.summaryWidth], [96, 80, 32, 22]);
    for (const width of [CHIP.railWidth, CHIP.panelWidth, CHIP.compactWidth]) assert.equal(width % 4, 0, 'chip widths stay on the grid');
});
