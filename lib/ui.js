import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {LIGHT} from '../design.js';
import {cssColor} from '../themes.js';

export const animations = () => St.Settings.get().enable_animations;

// Clutter rejects contains(null), and the key focus is null when nothing holds it.
export const holds = (actor, focus) => !!focus && actor.contains(focus);

// A box layout. The orientation is set on the layout manager, which works on
// every supported shell version.
export function box(vertical, params = {}) {
    const actor = new St.BoxLayout(params);
    actor.layout_manager.orientation = vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
    return actor;
}

// A drawing area that calls draw(cr, width, height) on repaint.
export function canvas(draw, params = {}) {
    const area = new St.DrawingArea({x_expand: true, y_expand: true, ...params});
    area.connect('repaint', () => {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        draw(cr, width, height);
        cr.$dispose();
    });
    return area;
}

export function light() {
    return new St.Widget({width: LIGHT.size, height: LIGHT.size, y_align: Clutter.ActorAlign.CENTER, x_align: Clutter.ActorAlign.CENTER});
}

// Light color for a state: off, working (the module accent), waiting, failed.
export function lightColor(state, accent, theme, where = 'rail') {
    if (state === 'working') return accent;
    if (state === 'waiting') return theme.accent('watch', where);
    if (state === 'failed') return theme.accent('critical', where);
    return theme.led;
}

// Shows `state` on a light. Only a state or color change touches the actor.
// Working breathes slowly; entering waiting blinks three times and stays
// lit; leaving working for off blinks twice in the old color, then goes off.
export function setLight(actor, state, color) {
    const key = `${state} ${color}`;
    if (actor._ledgeLight === key) return;
    const previous = actor._ledgeState;
    const previousColor = actor._ledgeColor;
    actor._ledgeLight = key;
    actor._ledgeState = state;
    actor._ledgeColor = color;
    actor._ledgeBlink?.stop();
    actor._ledgeBlink = null;
    actor.remove_all_transitions();
    actor.opacity = 255;
    const paint = fill => { actor.style = `background-color: ${cssColor(fill)}; border-radius: ${LIGHT.size / 2}px;`; };
    paint(color);
    if (!animations() || !actor.mapped || previous === undefined) {
        if (state === 'working' && animations()) breathe(actor);
        return;
    }
    if (state === 'waiting' && previous !== 'waiting') blink(actor, LIGHT.waitingBlinks, () => {});
    else if (state === 'off' && previous === 'working') {
        paint(previousColor);
        blink(actor, LIGHT.doneBlinks, () => paint(color));
    } else if (state === 'working') breathe(actor);
}

function breathe(actor) {
    actor.ease({opacity: Math.round(255 * LIGHT.breathMin), duration: LIGHT.breathPeriod / 2,
        mode: Clutter.AnimationMode.EASE_IN_OUT_SINE, repeatCount: -1, autoReverse: true});
}

// `count` on and off cycles with hard steps, then `done()`.
function blink(actor, count, done) {
    const cycle = LIGHT.blinkOn + LIGHT.blinkOff;
    const timeline = actor._ledgeBlink = new Clutter.Timeline({actor, duration: count * cycle});
    timeline.connect('new-frame', (_t, ms) => { actor.opacity = ms % cycle < LIGHT.blinkOn ? 255 : 0; });
    timeline.connect('stopped', (_t, finished) => {
        actor.opacity = 255;
        if (finished) {
            actor._ledgeBlink = null;
            done();
        }
    });
    timeline.start();
}
