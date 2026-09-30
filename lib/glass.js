import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';

// Frosted glass: a background blur confined to an arbitrary shape.
//
// Shell.BlurEffect in BACKGROUND mode blurs whatever is already on screen
// under the actor's rectangle. To follow the notch's curls and corners, the
// actor carries three effects, painted outermost first:
//
//   ClipStart  pushes a stencil region clip in the actor's exact shape
//   blur       paints the blurred backdrop, confined by that clip
//   ClipEnd    pops the clip, lets the actor paint its own tint, border and
//              shadow unclipped, then restores the clip for ClipStart to pop
//
// A shader mask would need an offscreen redirect, and background blur inside
// an offscreen buffer only sees that empty buffer, so a stencil clip it is.
// The stencil edge is pixel-stepped; the anti-aliased border drawn on top
// covers it.
const NAMES = ['ledge-clip-start', 'ledge-blur', 'ledge-clip-end'];

// Framebuffer origin and scale for the view being painted.
function viewTransform(framebuffer) {
    for (const view of global.stage.peek_stage_views()) {
        if (view.get_framebuffer() !== framebuffer) continue;
        const layout = new Mtk.Rectangle();
        view.get_layout(layout);
        return {x: layout.x, y: layout.y, scale: view.get_scale()};
    }
    // Offscreen stage paints, such as screenshots, cover the whole stage.
    return {x: 0, y: 0, scale: framebuffer.get_width() / Math.max(1, global.stage.width)};
}

const ClipStart = GObject.registerClass(
class LedgeClipStart extends Clutter.Effect {
    _init() {
        super._init();
        this.shape = null;      // (width, height) => [[x, y, w, h], ...] in actor pixels
        this.region = null;     // the region currently pushed, for ClipEnd
        this._cacheKey = '';
        this._rects = [];
    }

    _localRects(actor) {
        const key = `${Math.round(actor.width)}x${Math.round(actor.height)}`;
        if (key !== this._cacheKey) {
            this._cacheKey = key;
            this._rects = this.shape?.(actor.width, actor.height) ?? [];
        }
        return this._rects;
    }

    vfunc_paint(_node, paintContext, _flags) {
        const actor = this.get_actor();
        const framebuffer = paintContext.get_framebuffer();
        const rects = this._localRects(actor);
        if (rects.length) {
            const [ax, ay] = actor.get_transformed_position();
            const view = viewTransform(framebuffer);
            const px = v => Math.round(v * view.scale);
            this.region = Mtk.Region.create();
            for (const [x, y, w, h] of rects) {
                const x1 = px(ax + x - view.x), y1 = px(ay + y - view.y);
                this.region.union_rectangle(new Mtk.Rectangle({x: x1, y: y1,
                    width: px(ax + x + w - view.x) - x1, height: px(ay + y + h - view.y) - y1}));
            }
            framebuffer.push_region_clip(this.region);
        }
        actor.continue_paint(paintContext);
        if (this.region) framebuffer.pop_clip();
        this.region = null;
    }
});

const ClipEnd = GObject.registerClass(
class LedgeClipEnd extends Clutter.Effect {
    _init(start) {
        super._init();
        this._start = start;
    }

    vfunc_paint(_node, paintContext, _flags) {
        const framebuffer = paintContext.get_framebuffer();
        const region = this._start.region;
        if (region) framebuffer.pop_clip();
        this.get_actor().continue_paint(paintContext);
        if (region) framebuffer.push_region_clip(region);
    }
});

// Adds, updates or (with params null) removes glass on an actor.
// params: {radius, brightness}; shape as for ClipStart.
export function setGlass(actor, shape, params) {
    if (!params) {
        for (const name of NAMES) actor.remove_effect_by_name(name);
        return;
    }
    let start = actor.get_effect(NAMES[0]);
    let blur = actor.get_effect(NAMES[1]);
    if (!start || !blur) {
        for (const name of NAMES) actor.remove_effect_by_name(name);
        start = new ClipStart();
        blur = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND});
        actor.add_effect_with_name(NAMES[0], start);
        actor.add_effect_with_name(NAMES[1], blur);
        actor.add_effect_with_name(NAMES[2], new ClipEnd(start));
    }
    if (start.shape !== shape) {
        start.shape = shape;
        start._cacheKey = '';
    }
    blur.radius = params.radius;
    blur.brightness = params.brightness;
    actor.queue_redraw();
}
