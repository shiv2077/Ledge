import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// A Ledge widget. The host constructs one only while the GSettings boolean
// named by `id` is on, calls start(), and calls stop() when the key turns off
// or the extension is disabled. stop() must leave no timers, processes,
// monitors, signals or proxies behind; the base stop() cancels
// this.cancellable and removes timers made with every().
export class Module {
    static id = '';
    static title = '';

    // host: {settings, path, changed(module), openPreferences()}
    constructor(host) {
        this.host = host;
        this.settings = host.settings;
        this.cancellable = new Gio.Cancellable();
        this._timers = new Set();
    }

    get id() { return this.constructor.id; }

    start() {}

    stop() {
        this.cancellable.cancel();
        for (const timer of this._timers) GLib.Source.remove(timer);
        this._timers.clear();
    }

    // Repeating timer, removed by stop() or clearTimer().
    every(seconds, callback) {
        const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.max(1, seconds), () => {
            callback();
            return GLib.SOURCE_CONTINUE;
        });
        this._timers.add(timer);
        return timer;
    }

    clearTimer(timer) {
        if (timer && this._timers.delete(timer)) GLib.Source.remove(timer);
        return 0;
    }

    // What the chip shows. label is the readout; meter says whether the chip
    // has a meter and fraction (0..1, or null for no reading) fills it; accent
    // is a hex color or a theme token; badge is a two-letter monogram and icon
    // a symbolic icon name; light is 'off', 'working', 'waiting' or 'failed';
    // updatedAt (epoch ms) and stale feed the deck's timestamp.
    cell() {
        return {fraction: null, meter: false, label: '—', stale: false, accent: 'textPrimary', badge: null, icon: null,
            light: 'off', sessions: [], updatedAt: this._changedAt ?? null, accessibleName: this.constructor.title};
    }

    // Deck header: the title, then a short context such as `2 sessions`.
    heading() { return this.constructor.title; }
    context() { return ''; }

    // Adds deck content to `body` using the host's `ui` factories and returns
    // extra footer actions as [label, callback] pairs.
    card(_body, _ui) { return []; }

    // Push an update: the host redraws the chip and the open deck.
    changed() {
        this._changedAt = Date.now();
        this.host.changed(this);
    }
}
