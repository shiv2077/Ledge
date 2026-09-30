import {PALETTE} from '../design.js';

// A notch widget. The host constructs one only while the GSettings boolean
// named by `id` is on, calls start(), and calls stop() when the key turns off
// or the extension is disabled. stop() must leave no timers, processes,
// monitors, signals or proxies behind.
export class Module {
    static id = '';
    static title = '';

    // host: {settings, path, changed(module), openPreferences()}
    constructor(host) {
        this.host = host;
    }

    get id() { return this.constructor.id; }

    start() {}
    stop() {}

    // Cell for the notch. fraction is 0..1 or null for an empty ring; glyph is
    // a key in glyphs.js; animating keeps the ring repainting.
    cell() {
        return {fraction: null, label: '—', stale: false, accent: PALETTE.textPrimary,
            glyph: null, sessions: [], animating: false, accessibleName: this.constructor.title};
    }

    heading() { return this.constructor.title; }

    // Adds card content to `body` using the host's `ui` factories and returns
    // extra footer actions as [label, callback] pairs.
    card(_body, _ui) { return []; }

    // Push an update: the host redraws cells and the open card.
    changed() { this.host.changed(this); }
}
