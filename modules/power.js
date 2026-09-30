import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Module} from '../lib/module.js';
import {MODULE_COLORS} from '../design.js';

// power-profiles-daemon exports the same interface under a new and a legacy
// name; the bus name doubles as the interface name.
const BUSES = [
    ['org.freedesktop.UPower.PowerProfiles', '/org/freedesktop/UPower/PowerProfiles'],
    ['net.hadess.PowerProfiles', '/net/hadess/PowerProfiles'],
];

const PROFILES = {
    'power-saver': {name: 'Power Saver', short: 'Saver', icon: 'power-profile-power-saver-symbolic'},
    'balanced': {name: 'Balanced', short: 'Bal', icon: 'power-profile-balanced-symbolic'},
    'performance': {name: 'Performance', short: 'Perf', icon: 'power-profile-performance-symbolic'},
};
const ORDER = ['power-saver', 'balanced', 'performance'];

export class PowerModule extends Module {
    static id = 'power';
    static title = 'Power';

    start() {
        this._message = 'Connecting to power-profiles-daemon…';
        this._connect(0);
    }

    _connect(index) {
        const [name, path] = BUSES[index];
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null,
            name, path, name, this.cancellable, (_o, result) => {
                let proxy = null;
                try { proxy = Gio.DBusProxy.new_for_bus_finish(result); } catch { /* Try the next name. */ }
                if (this.cancellable.is_cancelled()) return;
                if (!proxy?.get_name_owner()) {
                    if (index + 1 < BUSES.length) this._connect(index + 1);
                    else this._fail('power-profiles-daemon is not running.');
                    return;
                }
                this._proxy = proxy;
                this._propertiesSignal = proxy.connect('g-properties-changed', () => this._sync());
                this._ownerSignal = proxy.connect('notify::g-name-owner', () => this._sync());
                this._sync();
            });
    }

    _fail(message) {
        this._message = message;
        this.changed();
    }

    _property(name) {
        return this._proxy?.get_cached_property(name)?.recursiveUnpack();
    }

    _sync() {
        if (!this._proxy?.get_name_owner()) {
            this._fail('power-profiles-daemon stopped.');
            return;
        }
        this._message = '';
        this.changed();
    }

    _active() { return this._proxy?.get_name_owner() ? this._property('ActiveProfile') : null; }

    _available() {
        const listed = (this._property('Profiles') ?? []).map(p => p?.Profile).filter(p => PROFILES[p]);
        return ORDER.filter(p => listed.includes(p));
    }

    _switch(profile) {
        if (!this._proxy || profile === this._active()) return;
        const iface = this._proxy.get_interface_name();
        this._proxy.call('org.freedesktop.DBus.Properties.Set',
            new GLib.Variant('(ssv)', [iface, 'ActiveProfile', new GLib.Variant('s', profile)]),
            Gio.DBusCallFlags.NONE, 5000, this.cancellable, (proxy, result) => {
                try {
                    proxy.call_finish(result);
                } catch (error) {
                    if (this.cancellable.is_cancelled()) return;
                    this._fail(`Could not switch profile: ${error.message}`.slice(0, 200));
                }
            });
    }

    cell() {
        const profile = PROFILES[this._active()];
        return {...super.cell(), icon: profile?.icon ?? 'power-profile-balanced-symbolic', label: profile?.short ?? '—',
            accent: MODULE_COLORS.power, stale: !profile,
            accessibleName: `Power profile: ${profile?.name ?? 'unavailable'}`};
    }

    card(body, ui) {
        if (this._message) body.add_child(ui.label(this._message, this._proxy ? 'ledge-warning' : 'ledge-muted'));
        const active = this._active();
        for (const id of this._available())
            body.add_child(ui.row(PROFILES[id].name, {icon: PROFILES[id].icon, active: id === active, onClick: () => this._switch(id)}));
        const degraded = this._property('PerformanceDegraded');
        if (degraded) body.add_child(ui.label(`Performance limited: ${degraded}`, 'ledge-warning'));
        return [];
    }

    stop() {
        if (this._propertiesSignal) this._proxy.disconnect(this._propertiesSignal);
        if (this._ownerSignal) this._proxy.disconnect(this._ownerSignal);
        this._propertiesSignal = this._ownerSignal = 0;
        this._proxy = null;
        super.stop();
    }
}
