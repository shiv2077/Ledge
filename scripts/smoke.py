#!/usr/bin/env python3
"""Exercise the real extension in an isolated GNOME Shell with demo data."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / '.smoke'
OUTPUT.mkdir(exist_ok=True)
report = OUTPUT / 'result.json'
report.unlink(missing_ok=True)
(OUTPUT / 'prefs.json').unlink(missing_ok=True)
subprocess.run(['glib-compile-schemas', '--strict', str(ROOT / 'schemas')], check=True)
with tempfile.TemporaryDirectory(prefix='ledge-smoke-') as folder:
    base = Path(folder)
    extension = base / 'data/gnome-shell/extensions/ledge@shiv2077'
    extension.mkdir(parents=True)
    for name in ['metadata.json', 'extension.js', 'model.js', 'design.js', 'draw.js', 'glyphs.js',
                 'prefs.js', 'stylesheet.css']:
        shutil.copy2(ROOT / name, extension / name)
    for name in ['lib', 'modules', 'reader', 'schemas']:
        shutil.copytree(ROOT / name, extension / name)
    shutil.copy2(ROOT / 'tests/prefs-smoke.js', extension / 'prefs-smoke.js')
    (extension / 'extension.js').rename(extension / 'implementation.js')
    (extension / 'extension.js').write_text('''
import Ledge from './implementation.js';
import {usageSource} from './modules/usage.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
const output = GLib.getenv('LEDGE_SMOKE_OUTPUT');
const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE; }));
const assert = (value, message) => { if (!value) throw new Error(message); };
export default class Smoke extends Ledge {
    enable() {
        this.getSettings().set_boolean('demo', true);
        this.getSettings().set_boolean('always-show', true);
        super.enable();
        this.runSmoke().catch(error => GLib.file_set_contents(`${output}/result.json`, JSON.stringify({ok:false,error:String(error),stack:error.stack})));
    }
    async capture(name) {
        const stream = Gio.File.new_for_path(`${output}/${name}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
        const shot = new Shell.Screenshot();
        await new Promise((resolve, reject) => shot.screenshot(false, stream, (object, result) => {
            try { object.screenshot_finish(result); stream.close(null); resolve(); } catch (error) { reject(error); }
        }));
    }
    async checkWorkspaceDismissal() {
        const manager = global.workspace_manager;
        const first = manager.get_workspace_by_index(0);
        const second = manager.get_workspace_by_index(1);
        assert(second, 'Workspace fixture has a second workspace');
        for (const initiallyOpen of [false, true]) {
            this._showDetail('claude', true);
            await delay(100);
            if (!initiallyOpen) {
                this._hideDetail();
                // Shell revisits tracked chrome visibility after fullscreen/Overview changes.
                Main.layoutManager._updateVisibility();
                assert(!this._detail.visible, 'Shell visibility update must not resurrect a dismissed popup');
            }
            second.activate(global.get_current_time());
            await delay(650);
            assert(manager.get_active_workspace() === second, 'Switched to second workspace');
            assert(!this._detail.visible, `${initiallyOpen ? 'Open' : 'Dismissed'} popup must stay closed after workspace switch`);
            first.activate(global.get_current_time());
            await delay(650);
            assert(!this._detail.visible, 'Returning to workspace must not resurrect popup');
        }
    }
    async checkWidgets() {
        const ids = ['claude', 'cursor', 'codex', 'power', 'todo', 'models', 'github', 'training'];
        assert(this._stack.get_n_children() === ids.length && ids.every(id => this._modules.has(id)), 'Every widget has a cell');
        const data = `${GLib.get_user_data_dir()}/ledge`;
        // Todo: typing into the card entry and Enter add an item that is saved.
        const todo = this._modules.get('todo');
        this._showDetail('todo');
        await delay(200);
        const entry = this._autofocus;
        assert(entry instanceof St.Entry && this._focusTargets().includes(entry), 'Todo entry is keyboard reachable');
        entry.grab_key_focus();
        entry.set_text('smoke item');
        entry.clutter_text.emit('activate');
        await delay(400);
        assert(todo.cell().label === '1', `Todo count follows adds, got ${todo.cell().label}`);
        assert(this._autofocus !== entry && this._autofocus.contains(global.stage.get_key_focus()), 'New entry keeps focus after the card rebuilds');
        const saved = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${data}/todos.json`)[1]));
        assert(saved.length === 1 && saved[0].text === 'smoke item', 'Todo saved to disk');
        global.stage.set_key_focus(null);
        // Training: an atomic rename into runs/ is picked up by the monitor.
        const writeRun = (fields) => {
            const tmp = `${data}/runs/.smoke.json.tmp`;
            GLib.file_set_contents(tmp, JSON.stringify({name: 'smoke', epoch: 2, total_epochs: 4, step: 10, loss: 0.5,
                eta_seconds: 120, updated_at: Date.now() / 1000, ...fields}));
            Gio.File.new_for_path(tmp).move(Gio.File.new_for_path(`${data}/runs/smoke.json`), Gio.FileCopyFlags.OVERWRITE, null, null);
        };
        writeRun({state: 'running'});
        await delay(600);
        const training = this._modules.get('training');
        assert(training.cell().label === '0.500' && training.cell().fraction === 0.5, `Training cell shows the run, got ${JSON.stringify(training.cell())}`);
        writeRun({state: 'done', epoch: 4});
        await delay(600);
        assert(training.cell().label === '—', 'Finished run leaves the cell idle');
        // Every card renders with its footer inside the padding.
        for (const id of ids) {
            this._showDetail(id, true);
            await delay(150);
            const card = this._detail.get_first_child().get_children().find(child => child.has_style_class_name('ledge-detail'));
            const actions = card.get_last_child();
            assert(Math.abs(card.height - actions.y - actions.height - 16) <= 1, `${id}: card footer inset`);
            await this.capture(`${id}-card`);
        }
        this._hideDetail();
    }
    async runSmoke() {
        await delay(2200);
        Main.overview.hide();
        await delay(700);
        assert(usageSource().readings.length === 3, 'Three providers must render');
        assert(usageSource().readings.every(p => p.windows.length && p.status === 'ok'), 'Demo readings must succeed');
        assert(usageSource().activities.length === 3, 'Activity demo reader succeeds');
        await this.checkWidgets();
        await this.checkWorkspaceDismissal();
        // Wrapped provider warnings must participate in the card's natural height.
        const savedReadings = usageSource().readings;
        const savedSessions = usageSource().sessions;
        usageSource().sessions = () => []; // Keep background activity polling out of this layout fixture.
        const warning = 'Claude Code credentials have expired; use Claude Code to refresh them';
        for (const edge of ['right', 'top', 'left', 'bottom']) {
            this._settings.set_string('edge', edge);
            await delay(100);
            const heights = [];
            for (const message of [warning, `${warning}. ${warning}.`, 'Usage unavailable']) {
                usageSource().readings = savedReadings.map(p => p.id === 'claude' ? {...p,
                    status: 'stale', message,
                } : p);
                this._showDetail('claude', true);
                await delay(200);
                const card = this._detail.get_first_child().get_children()
                    .find(child => child.has_style_class_name('ledge-detail'));
                const actions = card.get_last_child();
                const footerInset = card.height - actions.y - actions.height;
                assert(Math.abs(footerInset - 16) <= 1,
                    `${edge}: wrapped warning preserves 16px footer inset, got ${footerInset}`);
                heights.push(card.height);
                if (edge === 'right' && message === warning) await this.capture('wrapped-warning');
            }
            assert(heights[1] > heights[0] && heights[2] < heights[0],
                `${edge}: popup grows and shrinks with wrapped content (${heights})`);
        }
        usageSource().readings = savedReadings;
        usageSource().sessions = savedSessions;
        this._hideDetail();
        // Real pointer input exercises picking across the separately tracked
        // arc and notch actors, rather than assigning their hover flags.
        const pointer = Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const move = (x, y) => pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        this._settings.set_string('edge', 'right');
        await delay(850);
        global.stage.set_key_focus(null);
        move(400, 400);
        await delay(100);
        await this.capture('settings-arc');
        const orbX = this._orbChrome.x + this._orb.width / 2;
        const orbY = this._orbChrome.y + this._orb.height / 2;
        move(orbX, orbY);
        await delay(90);
        assert(this._orb.hover && this._orbT > 0 && this._orbT < 1, 'Pointer starts a continuous arc-to-gear transition');
        await this.capture('settings-transition');
        await delay(650);
        assert(this._orbT === 1 && this._orbGlyph.opacity === 255, 'Hovered settings gear settles fully visible');
        await this.capture('settings-gear');
        let settingsOpened = false;
        const openPreferences = this.openPreferences;
        this.openPreferences = () => { settingsOpened = true; };
        this._orb.emit('clicked', 1);
        assert(settingsOpened, 'Settings control still opens preferences');
        this.openPreferences = openPreferences;
        move(400, 400);
        await delay(90);
        await this.capture('settings-return');
        await delay(650);
        assert(this._orbT === 0 && this._orbGlyph.opacity === 0, 'Leaving settings restores only the arc');
        this._settings.set_boolean('always-show', false);
        await delay(850);
        assert(this._host.width === 10 && this._host.height === 79, 'Collapsed handle is 10 by 79');
        assert(!this._orb.visible && !this._orbDrawing.visible, 'Collapsed handle has no settings residue');
        await this.capture('closed-handle');
        const firstCell = this._stack.get_first_child();
        move(1918, this._host.y + this._host.height / 2);
        await delay(80);
        assert(this._host.width > 10 && this._host.width < 70, 'Unfold interpolates size instead of snapping');
        assert(this._stack.get_first_child() === firstCell, 'Animation preserves provider actors');
        await this.capture('unfold-intermediate');
        await delay(850);
        assert(this._host.width === 70 && this._orb.visible, 'Hover unfolds the whole notch');
        // Reverse the fold while it is still in flight.
        move(400, 400);
        await delay(380);
        assert(this._expandT > 0 && this._expandT < 1, 'Pointer departure starts folding after grace period');
        move(1918, this._host.y + this._host.height / 2);
        await delay(850);
        assert(this._expandT === 1 && !this._motionTimer, 'Re-entry reverses and settles the spring');
        this._settings.set_boolean('always-show', true);
        move(400, 400);
        await delay(850);
        this._keyboardOpen = true;
        const buttons = this._stack.get_children().map(c => c.get_first_child()).filter(Boolean);
        buttons[0].grab_key_focus();
        this._key({get_key_symbol: () => Clutter.KEY_Tab, get_state: () => 0});
        assert(global.stage.get_key_focus() === buttons[1], 'Tab moves between providers');
        this._keyboardOpen = false;
        const placements = [];
        for (const edge of ['right', 'top', 'left', 'bottom']) {
            this._settings.set_string('edge', edge);
            await delay(600);
            this._showDetail('claude');
            await delay(200);
            const a = this._area();
            assert(this._host.width > 10 && this._host.height > 10, 'Notch has size');
            assert(this._host.x >= a.x && this._host.y >= a.y, 'Notch begins inside work area');
            assert(this._host.x + this._host.width <= a.x + a.width + 1, 'Notch fits horizontally');
            assert(this._host.y + this._host.height <= a.y + a.height + 1, 'Notch fits vertically');
            const wrap = this._detail.get_first_child();
            const card = wrap.get_children().find(child => child.has_style_class_name('ledge-detail'));
            const tail = wrap.get_children().find(child => child !== card);
            assert(tail.width <= 24 && tail.height <= 24, 'Tooltip pointer must not stretch with its card');
            const actions = card.get_last_child();
            assert(actions.y + actions.height <= card.height - 12, 'Actions remain inside card padding');
            for (const child of card.get_children())
                assert(child.x >= 12 && child.x + child.width <= card.width - 12, 'Card content respects horizontal padding');
            assert(this._focusTargets().includes(actions.get_first_child()), 'Card actions remain keyboard accessible');
            if (edge === 'top') assert(tail.y < card.y, 'Top-edge pointer faces the notch');
            if (edge === 'bottom') assert(tail.y > card.y, 'Bottom-edge pointer faces the notch');
            placements.push({edge, x:this._host.x,y:this._host.y,width:this._host.width,height:this._host.height});
            if (['right', 'top', 'left', 'bottom'].includes(edge)) {
                const stream = Gio.File.new_for_path(`${output}/${edge}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
                const shot = new Shell.Screenshot();
                await new Promise((resolve,reject) => shot.screenshot(false, stream, (object,result) => {
                    try { object.screenshot_finish(result); stream.close(null); resolve(); } catch(error) { reject(error); }
                }));
            }
        }
        this._settings.set_string('edge', 'right');
        await delay(400);
        this._showDetail('claude');
        await delay(250);
        for (const provider of ['claude', 'cursor', 'codex']) {
            this._showDetail(provider);
            await delay(220);
            const card = this._detail.get_first_child().get_children().find(child => child.has_style_class_name('ledge-detail'));
            const actions = card.get_last_child();
            assert(Math.abs(card.height - actions.y - actions.height - 16) <= 1, `${provider}: consistent 16px footer inset, got ${card.height - actions.y - actions.height} (${card.height}, ${actions.y}, ${actions.height})`);
            const stream = Gio.File.new_for_path(`${output}/${provider}-card.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
            const shot = new Shell.Screenshot();
            await new Promise((resolve, reject) => shot.screenshot(false, stream, (object, result) => {
                try { object.screenshot_finish(result); stream.close(null); resolve(); } catch (error) { reject(error); }
            }));
        }
        this._showDetail('claude');
        await delay(250);
        const originalY = this._detail.y;
        this._showDetail('cursor');
        await delay(40);
        this._showDetail('codex');
        await delay(260);
        assert(this._selected === 'codex' && this._detail.visible, 'Rapid switching selects latest provider');
        assert(this._detail.y !== originalY, 'Popup follows selected provider');
        assert(this._detail.translation_x === 0 && this._detail.translation_y === 0, 'Popup motion settles');
        const interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const animations = interfaceSettings.get_boolean('enable-animations');
        interfaceSettings.set_boolean('enable-animations', false);
        await delay(100);
        assert(!St.Settings.get().enable_animations, 'GNOME reduced motion setting propagates');
        this._orb.grab_key_focus();
        this._animateSettings();
        assert(this._orbT === 1 && !this._orbTimer, 'Reduced motion reveals focused gear immediately');
        global.stage.set_key_focus(null);
        this._animateSettings();
        assert(this._orbT === 0 && !this._orbTimer, 'Reduced motion restores arc immediately');
        this._showDetail('claude');
        await delay(60);
        assert(this._detail.translation_x === 0 && this._detail.translation_y === 0, 'Reduced motion places popup immediately');
        interfaceSettings.set_boolean('enable-animations', animations);
        await delay(100);
        this._showDetail('cursor');
        Main.overview.show();
        await delay(100);
        assert(!this._detail.visible && !this._detailMounted, 'Overview cancels and unmounts moving popup');
        assert(this._detail.get_n_children() === 0, 'Overview releases detached popup content');
        this._showDetail('codex');
        assert(!this._detail.visible, 'Overview blocks reopening');
        Main.overview.hide();
        await delay(600);
        assert(!this._detail.visible, 'Leaving Overview does not reopen popup');
        this._settings.set_string('edge', 'bottom');
        this._settings.set_boolean('cursor', false);
        await delay(600);
        assert(usageSource().readings.length === 2 && !usageSource().readings.some(p => p.id === 'cursor'), 'Disabled provider disappears');
        this._settings.set_boolean('always-show', false);
        await delay(500);
        assert(this._host.height <= 12, 'Bottom pill collapses');
        // Reproduce the video: collapse while entering Overview, then return.
        this._settings.set_string('edge', 'right');
        this._expanded = true;
        this._expandT = this._expandTarget = 1;
        this._render();
        await delay(100);
        this._expanded = false;
        this._expandTarget = 0;
        this._animateMotion();
        Main.overview.show();
        await delay(100);
        assert(!this._motionTimer && this._expandT === 0, 'Overview settles transient expansion and cancels motion');
        assert(!this._orb.visible && !this._orbDrawing.visible, 'Overview must not revive the collapsed settings button');
        const overviewArea = this._area();
        assert(Math.abs(this._host.x + this._host.width - overviewArea.x - overviewArea.width) <= 1,
            'Collapsed handle stays attached to the edge during Overview');
        await delay(550);
        Main.overview.hide();
        await delay(650);
        const area = this._area();
        assert(Math.abs(this._host.x + this._host.width - area.x - area.width) <= 1,
            `Collapsed handle must return to screen edge: x=${this._host.x}, width=${this._host.width}, edge=${area.x + area.width}`);
        assert(!this._orb.visible, 'Closed handle must not leave an orphan settings button after Overview');
        // Visibility updates recur on every Overview cycle, even without a render.
        for (const edge of ['right', 'top', 'left', 'bottom']) {
            this._settings.set_string('edge', edge);
            await delay(100);
            Main.overview.show();
            await delay(350);
            assert(!this._orb.visible && !this._detail.visible, `${edge}: no orphan controls in Overview`);
            Main.overview.hide();
            await delay(400);
            const a = this._area();
            const h = this._host;
            const attached = edge === 'right' ? Math.abs(h.x + h.width - a.x - a.width) :
                edge === 'left' ? Math.abs(h.x - a.x) :
                edge === 'top' ? Math.abs(h.y - a.y) : Math.abs(h.y + h.height - a.y - a.height);
            assert(attached <= 1 && !this._orb.visible, `${edge}: closed handle stays attached after Overview`);
        }
        this._settings.set_boolean('always-show', true);
        await delay(500);
        Main.overview.show();
        await delay(350);
        assert(this._expanded && this._expandT === 1 && this._orb.visible, 'Overview preserves always-show mode');
        Main.overview.hide();
        await delay(400);
        assert(this._orb.visible && !this._detail.visible, 'Always-show restores without reopening a popup');
        const prefs = Gio.Subprocess.new(['/usr/bin/gjs', '-m', `${this.path}/prefs-smoke.js`, this.path], Gio.SubprocessFlags.NONE);
        await new Promise((resolve, reject) => prefs.wait_check_async(null, (p, result) => {
            try { p.wait_check_finish(result); resolve(); } catch (error) { reject(error); }
        }));
        assert(GLib.file_test(`${output}/prefs.json`, GLib.FileTest.EXISTS), 'Preferences constructed and presented');
        this._orb.grab_key_focus();
        await delay(80);
        assert(this._orbTimer, 'Exercise disable while the focused gear is moving');
        super.disable();
        assert(!this._orbTimer && !this._motionTimer && !this._animation && !this._changeIdle && !usageSource() && !this._modules.size && !this._host, 'Disable releases owned resources');
        super.enable();
        await delay(600);
        assert(usageSource().readings.length === 2, 'Re-enable works');
        await this.checkWorkspaceDismissal();
        super.disable();
        GLib.file_set_contents(`${output}/result.json`, JSON.stringify({ok:true, placements, checks:['workspace switch dismissal and return','dismissed chrome visibility','wrapped warning padding and dynamic height across four edges','reference handle dimensions','pointer arc-to-gear transition','settings click','continuous unfold','animation actor identity','interrupted fold reversal','demo reader','four edges','tooltip','rapid popup switching','reduced motion','Overview dismissal','Overview collapse race','Overview visibility across four edges','always-show Overview','provider disable','collapse','preferences window','disable','re-enable']}));
    }
}
''')
    env = dict(os.environ, XDG_DATA_HOME=str(base / 'data'), XDG_CONFIG_HOME=str(base / 'config'),
               XDG_CACHE_HOME=str(base / 'cache'), GSETTINGS_BACKEND='keyfile',
               LEDGE_SMOKE_OUTPUT=str(OUTPUT), GNOME_SHELL_SESSION_MODE='user',
               NO_AT_BRIDGE='1')
    # Isolated keyfile settings, never the user's dconf database.
    subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', "['ledge@shiv2077']"], env=env, check=True)
    subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'disable-user-extensions', 'false'], env=env, check=True)
    subprocess.run(['gsettings', 'set', 'org.gnome.mutter', 'dynamic-workspaces', 'false'], env=env, check=True)
    subprocess.run(['gsettings', 'set', 'org.gnome.desktop.wm.preferences', 'num-workspaces', '2'], env=env, check=True)
    with (OUTPUT / 'shell.log').open('w') as log:
        process = subprocess.Popen(['dbus-run-session', '--', 'gnome-shell', '--headless', '--wayland', '--no-x11',
                                    '--virtual-monitor', '1920x1080'], env=env, stdout=log, stderr=log, start_new_session=True)
        try:
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline and process.poll() is None and not report.exists():
                time.sleep(0.25)
        finally:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
    if not report.exists():
        raise SystemExit(f'Smoke did not finish. See {OUTPUT / "shell.log"}')
    result = json.loads(report.read_text())
    print(json.dumps(result, indent=2))
    if not result.get('ok'):
        raise SystemExit(1)
