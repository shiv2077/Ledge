// Smoke harness: wraps the real extension inside a headless GNOME Shell and
// drives it with demo data. scripts/smoke.py installs this as extension.js.
import Ledge from './implementation.js';
import {usageSource} from './modules/usage.js';
import {rgba} from './themes.js';
import {CHAMFER, CHIP, DECK, TICK, MOTION, railSize} from './design.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const output = GLib.getenv('LEDGE_SMOKE_OUTPUT');
const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE; }));
const assert = (value, message) => { if (!value) throw new Error(message); };
const EDGES = ['right', 'top', 'left', 'bottom'];
const IDS = ['claude', 'cursor', 'codex', 'power', 'todo', 'models', 'github', 'copilot', 'training'];
const PAD = 48;
const checks = [];
const crops = {};
const done = name => { checks.push(name); console.log(`SMOKE done: ${name}`); };

export default class Smoke extends Ledge {
    enable() {
        this.getSettings().set_boolean('demo', true);
        this.getSettings().set_boolean('always-show', true);
        // The rail checks run first; checkPanel covers the top bar.
        this.getSettings().set_string('placement', 'edge');
        // The demo's second Claude account stays hidden until checkAccounts.
        this.getSettings().set_strv('hidden-accounts', ['claude:work']);
        this.getSettings().set_boolean('copilot', true);
        super.enable();
        this.runSmoke().catch(error => GLib.file_set_contents(`${output}/result.json`,
            JSON.stringify({ok: false, error: String(error), stack: error.stack, passed: checks, crops})));
    }

    get R() { return this._placement; }

    // Screenshot of the rail and deck with some padding, or of `box`. The
    // whole stage is captured and scripts/smoke.py crops it afterwards: an
    // area capture paints offscreen, where a background blur reads nothing.
    async capture(name, box = null) {
        const actors = [this.R.actor, this.R.sensor, ...this.R.deck.visible ? [this.R.deck.actor] : []];
        const x0 = box?.x ?? Math.min(...actors.map(a => a.x)) - PAD;
        const y0 = box?.y ?? Math.min(...actors.map(a => a.y)) - PAD;
        const x1 = box ? box.x + box.width : Math.max(...actors.map(a => a.x + a.width)) + PAD;
        const y1 = box ? box.y + box.height : Math.max(...actors.map(a => a.y + a.height)) + PAD;
        const x = Math.max(0, Math.round(x0)), y = Math.max(0, Math.round(y0));
        const width = Math.min(global.stage.width, Math.round(x1)) - x, height = Math.min(global.stage.height, Math.round(y1)) - y;
        crops[name] = {x, y, width, height};
        const stream = Gio.File.new_for_path(`${output}/${name}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
        const shot = new Shell.Screenshot();
        await new Promise((resolve, reject) => shot.screenshot(false, stream, (object, result) => {
            try { object.screenshot_finish(result); stream.close(null); resolve(); } catch (error) { reject(error); }
        }));
    }

    footerInset() {
        const content = this.R.deck._content;
        const footer = content.get_last_child();
        return this.R.deck.actor.height - footer.y - footer.height;
    }

    // The deck sits flush against the rail on the side that touches it.
    deckFlush(edge) {
        const rail = this.R.actor, deck = this.R.deck.actor;
        if (edge === 'right') return deck.x + deck.width === rail.x;
        if (edge === 'left') return deck.x === rail.x + rail.width;
        if (edge === 'top') return deck.y === rail.y + rail.height;
        return deck.y + deck.height === rail.y;
    }

    attached(edge) {
        const a = this.R._area(), h = this.R.actor;
        return edge === 'right' ? Math.abs(h.x + h.width - a.x - a.width) : edge === 'left' ? Math.abs(h.x - a.x)
            : edge === 'top' ? Math.abs(h.y - a.y) : Math.abs(h.y + h.height - a.y - a.height);
    }

    async checkWorkspaceDismissal() {
        const manager = global.workspace_manager;
        const first = manager.get_workspace_by_index(0);
        const second = manager.get_workspace_by_index(1);
        assert(second, 'Workspace fixture has a second workspace');
        for (const initiallyOpen of [false, true]) {
            this.R.open('claude', true);
            await delay(100);
            if (!initiallyOpen) {
                this.R.close();
                // Shell revisits tracked chrome visibility after fullscreen/Overview changes.
                Main.layoutManager._updateVisibility();
                assert(!this.R.deck.visible, 'Shell visibility update must not resurrect a dismissed deck');
            }
            second.activate(global.get_current_time());
            await delay(650);
            assert(manager.get_active_workspace() === second, 'Switched to second workspace');
            assert(!this.R.deck.visible, `${initiallyOpen ? 'Open' : 'Dismissed'} deck must stay closed after workspace switch`);
            first.activate(global.get_current_time());
            await delay(650);
            assert(!this.R.deck.visible, 'Returning to workspace must not resurrect the deck');
        }
        done('workspace switch dismissal and return');
    }

    async checkModules() {
        assert(this.R.strip.keys().join() === IDS.join() && IDS.every(id => this._modules.has(id)), 'Every module has a chip, in order');
        const chip = id => this.R.strip.chips.get(id);
        assert(chip('claude').info.badge === 'CL' && chip('cursor').info.badge === 'CU' && chip('codex').info.badge === 'CX', 'Providers show monogram badges');
        assert(chip('claude')._meter.visible && !chip('power')._meter.visible, 'Only modules with a fraction show a chip meter');
        const top = id => Math.round(chip(id)._readout.get_transformed_position()[1] - chip(id).actor.get_transformed_position()[1]);
        const metered = IDS.filter(id => chip(id).info.meter);
        assert(new Set(metered.map(top)).size === 1, 'Readouts over a meter share one baseline');
        for (const id of IDS.filter(id => !chip(id).info.meter))
            assert(Math.abs(top(id) + chip(id)._readout.height / 2 - chip(id).actor.height / 2) <= 1, `${id}: meterless readout is centred`);
        assert(chip('cursor').info.light === 'waiting' && chip('claude').info.light === 'working' && chip('power').info.light === 'off', 'Lights follow session state');
        for (const id of IDS) assert(chip(id).actor.width === 96 && chip(id).actor.height === 36, `${id}: chip is 96 by 36`);
        const icons = new St.IconTheme();
        for (const id of IDS) {
            const icon = chip(id).info.icon;
            assert(!icon || icons.has_icon(icon), `${id}: icon ${icon} exists in the icon theme`);
        }
        const header = () => this.R.deck._content.get_first_child();
        this.R.open('claude', true);
        await delay(200);
        const [title, context] = header().get_children();
        assert(title.text === 'Claude Code' && context.text === '· 1 session', `Deck header names the module and its context, got ${title.text} ${context.text}`);
        assert(title.width >= title.get_preferred_width(-1)[1] - 0.5, 'Deck title gets its full width');
        this.R.close();
        // Mono readouts: digits share one width, so values do not jitter.
        const widths = ['111%', '000%', '888%'].map(text => {
            const label = new St.Label({text, style_class: 'ledge-readout'});
            Main.uiGroup.add_child(label);
            const width = label.get_preferred_width(-1)[1];
            label.destroy();
            return width;
        });
        assert(widths[0] === widths[1] && widths[1] === widths[2], `Readout digits share one width, got ${widths}`);
        // Lights: waiting blinks three times then stays lit; done blinks twice then goes off.
        const savedSessions = usageSource().sessions;
        const light = chip('claude')._light;
        const setSessions = state => {
            usageSource().sessions = id => id === 'claude' ? [{state, name: 'Smoke', detail: '', waitingFor: '', derived: false}] : savedSessions.call(usageSource(), id);
            this._changed(this._modules.get('claude'));
        };
        setSessions('waiting');
        await delay(60);
        assert(chip('claude').info.light === 'waiting' && light._ledgeBlink, 'Entering waiting starts a blink');
        await delay(900);
        assert(!light._ledgeBlink && light.opacity === 255, 'Waiting light stays lit after three blinks');
        setSessions('busy');
        await delay(60);
        setSessions('idle');
        await delay(60);
        assert(chip('claude').info.light === 'off' && light._ledgeBlink, 'Finishing work blinks the light');
        await delay(700);
        const off = light.get_theme_node().get_background_color();
        const led = rgba(this._theme.led).map(v => Math.round(v * 255));
        assert(!light._ledgeBlink && [off.red, off.green, off.blue].every((v, i) => Math.abs(v - led[i]) <= 2), 'Done light ends off');
        usageSource().sessions = savedSessions;
        this._changed(this._modules.get('claude'));
        await delay(100);
        done('chips, badges, meters and lights');

        const data = `${GLib.get_user_data_dir()}/ledge`;
        // Todo: typing into the deck entry and Enter add an item that is saved.
        const todo = this._modules.get('todo');
        this.R.open('todo');
        await delay(250);
        const entry = this.R.deck.autofocus;
        assert(entry instanceof St.Entry && this.R.focusTargets().includes(entry), 'Todo entry is keyboard reachable');
        entry.grab_key_focus();
        entry.set_text('smoke item');
        entry.clutter_text.emit('activate');
        await delay(400);
        assert(todo.cell().label === '1', `Todo count follows adds, got ${todo.cell().label}`);
        assert(this.R.deck.autofocus !== entry && this.R.deck.autofocus.contains(global.stage.get_key_focus()), 'New entry keeps focus after the deck rebuilds');
        const saved = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${data}/todos.json`)[1]));
        assert(saved.length === 1 && saved[0].text === 'smoke item', 'Todo saved to disk');
        global.stage.set_key_focus(null);
        done('todo typing and save');
        // Training: an atomic rename into runs/ is picked up by the monitor.
        const writeRun = fields => {
            const tmp = `${data}/runs/.smoke.json.tmp`;
            GLib.file_set_contents(tmp, JSON.stringify({name: 'smoke', epoch: 2, total_epochs: 4, step: 10, loss: 0.5,
                eta_seconds: 120, updated_at: Date.now() / 1000, ...fields}));
            Gio.File.new_for_path(tmp).move(Gio.File.new_for_path(`${data}/runs/smoke.json`), Gio.FileCopyFlags.OVERWRITE, null, null);
        };
        writeRun({state: 'running'});
        await delay(600);
        const training = this._modules.get('training');
        assert(training.cell().label === '0.500' && training.cell().fraction === 0.5 && training.cell().light === 'working',
            `Training chip shows the run, got ${JSON.stringify(training.cell())}`);
        this.R.open('training', true);
        await delay(200);
        await this.capture('deck-training-running');
        writeRun({state: 'done', epoch: 4});
        await delay(600);
        assert(training.cell().label === '0.500' && training.cell().fraction === 1 && training.cell().light === 'off',
            `Finished run stays on the chip with its light off, got ${JSON.stringify(training.cell())}`);
        writeRun({state: 'crashed', epoch: 3});
        await delay(600);
        assert(training.cell().light === 'failed' && training.cell().stale, 'Crashed run lights the chip as failed');
        writeRun({state: 'done', epoch: 4});
        await delay(600);
        done('training file events');
        // Every deck renders with its footer inside the padding.
        for (const id of IDS) {
            this.R.open(id, true);
            await delay(150);
            assert(this.R.deck.actor.width === DECK.width, `${id}: deck is ${DECK.width} wide`);
            assert(Math.abs(this.footerInset() - DECK.padding) <= 1, `${id}: deck footer inset, got ${this.footerInset()}`);
            assert(this.deckFlush('right'), `${id}: deck is flush against the rail`);
            const footer = this.R.deck._content.get_last_child();
            assert(footer.get_last_child().label === 'settings', `${id}: settings is the last footer action`);
        }
        this.R.close();
        done('every deck');
    }

    async checkThemes() {
        // A striped backdrop makes glass and contrast visible in the screenshots.
        const stripes = new St.Widget({x: 1300, y: 0, width: 620, height: 1080,
            style: 'background-gradient-direction: horizontal; background-gradient-start: #ff3b30; background-gradient-end: #34c759;'});
        for (let i = 0; i < 60; i++)
            stripes.add_child(new St.Widget({x: 0, y: i * 18, width: 620, height: 9, style: 'background-color: #ffffff;'}));
        global.window_group.add_child(stripes);
        const same = (color, want) => ['red', 'green', 'blue', 'alpha'].every((c, i) => Math.abs(color[c] - want[i]) <= 2);
        for (const theme of ['graphite', 'snow', 'nord', 'mocha', 'dracula', 'ocean', 'frosted-dark', 'frosted-light', 'system', 'custom', 'midnight']) {
            this._settings.set_string('theme', theme);
            await delay(500);
            assert(this._theme.id === theme, `${theme} resolved`);
            this.R.open('claude', true);
            await delay(300);
            const title = this.R.deck._content.get_first_child().get_first_child();
            const want = rgba(this._theme.textPrimary).map(v => Math.round(v * 255));
            const got = title.get_theme_node().get_foreground_color();
            assert(same(got, want), `${theme}: generated stylesheet wins, title ${[got.red, got.green, got.blue, got.alpha]} want ${want}`);
            assert(Boolean(this.R.actor.get_effect('ledge-blur')) === this._theme.glass && Boolean(this.R.deck.actor.get_effect('ledge-blur')) === this._theme.glass,
                `${theme}: glass effects exactly when frosted`);
            await this.capture(`theme-${theme}`);
        }
        // An open deck follows a theme change without closing.
        this.R.open('power', true);
        await delay(200);
        this._settings.set_string('theme', 'snow');
        await delay(400);
        assert(this.R.deck.visible && this.R.deck.key === 'power', 'Open deck survives a theme change');
        this._settings.set_string('theme', 'midnight');
        await delay(400);
        this.R.close();
        stripes.destroy();
        done('every theme, generated stylesheet, glass presence');
    }

    async checkWrappedWarnings() {
        // Wrapped provider warnings must take part in the deck's natural height.
        const savedReadings = usageSource().readings;
        const savedSessions = usageSource().sessions;
        usageSource().sessions = () => []; // Keep background activity polling out of this layout fixture.
        const warning = 'Claude Code credentials have expired; use Claude Code to refresh them';
        for (const edge of EDGES) {
            this._settings.set_string('edge', edge);
            await delay(150);
            const heights = [];
            for (const message of [warning, `${warning}. ${warning}.`, 'Usage unavailable']) {
                usageSource().readings = savedReadings.map(p => p.id === 'claude' ? {...p, status: 'stale', message} : p);
                this._changed(this._modules.get('claude'));
                await delay(50);
                this.R.open('claude', true);
                await delay(200);
                assert(Math.abs(this.footerInset() - DECK.padding) <= 1, `${edge}: wrapped warning keeps the footer inset, got ${this.footerInset()}`);
                heights.push(this.R.deck.actor.height);
                if (edge === 'right' && message === warning) await this.capture('wrapped-warning');
            }
            assert(heights[1] > heights[0] && heights[2] < heights[0], `${edge}: deck grows and shrinks with wrapped content (${heights})`);
        }
        usageSource().readings = savedReadings;
        usageSource().sessions = savedSessions;
        this._changed(this._modules.get('claude'));
        this.R.close();
        this._settings.set_string('edge', 'right');
        await delay(300);
        done('wrapped warning height across four edges');
    }

    // Tick, mid-unfold, full rail and every deck, on each edge.
    async checkEdges(move) {
        const placements = [];
        for (const edge of EDGES) {
            const vertical = edge === 'left' || edge === 'right';
            this._settings.set_string('edge', edge);
            this._settings.set_boolean('always-show', false);
            move(900, 500);
            await delay(700);
            const rail = this.R.actor;
            const [depth, length] = vertical ? [rail.width, rail.height] : [rail.height, rail.width];
            assert(depth === TICK.thickness && length === TICK.length, `${edge}: tick is 4 by 44, got ${depth} by ${length}`);
            assert(this.attached(edge) <= 1, `${edge}: tick sits flush with the edge`);
            assert(this.R._tickLight.visible && !this.R.strip.actor.visible, `${edge}: tick shows one light and no chips`);
            await this.capture(`tick-${edge}`);
            const sensor = this.R.sensor;
            move(sensor.x + sensor.width / 2, sensor.y + sensor.height / 2);
            await delay(MOTION.hoverIntent + 110);
            const mid = vertical ? rail.width : rail.height;
            const full = railSize(IDS.length, vertical);
            assert((vertical ? rail.height : rail.width) > TICK.length && mid < full.depth, `${edge}: unfold passes through intermediate sizes`);
            await this.capture(`unfold-${edge}`);
            await delay(700);
            assert((vertical ? rail.width : rail.height) === full.depth && (vertical ? rail.height : rail.width) === full.length,
                `${edge}: rail unfolds to ${full.depth} by ${full.length}`);
            for (const chip of this.R.strip.chips.values())
                assert(chip.actor.opacity === 255 && chip.actor.translation_x === 0 && chip.actor.translation_y === 0 && chip._power === 1,
                    `${edge}: chips land and meters finish powering on`);
            const a = this.R._area();
            assert(rail.x >= a.x && rail.y >= a.y && rail.x + rail.width <= a.x + a.width + 1 && rail.y + rail.height <= a.y + a.height + 1, `${edge}: rail fits the work area`);
            await this.capture(`rail-${edge}`);
            this._settings.set_boolean('always-show', true);
            // Decks open by call here; a pointer resting on a chip would reopen its own.
            move(a.x + 2, a.y + 2);
            await delay(200);
            for (const id of IDS) {
                this.R._pinned = true;
                this.R.open(id);
                await delay(260);
                const deck = this.R.deck.actor;
                assert(this.deckFlush(edge), `${edge} ${id}: deck is flush against the rail, no gap and no tail`);
                const vert = edge === 'left' || edge === 'right';
                const [rs, rl, ds, dl] = vert ? [rail.y, rail.height, deck.y, deck.height] : [rail.x, rail.width, deck.x, deck.width];
                assert(ds >= rs + CHAMFER.large && (dl > rl - 2 * CHAMFER.large || ds + dl <= rs + rl - CHAMFER.large),
                    `${edge} ${id}: deck stays on the rail's straight side (${ds}+${dl} on ${rs}+${rl})`);
                assert(deck.x >= a.x && deck.y >= a.y && deck.x + deck.width <= a.x + a.width && deck.y + deck.height <= a.y + a.height, `${edge} ${id}: deck stays inside the work area`);
                for (let wait = 0; wait < 6 && (deck.translation_x || deck.translation_y); wait++) await delay(100);
                assert(deck.translation_x === 0 && deck.translation_y === 0, `${edge} ${id}: deck motion settles (${deck.translation_x}, ${deck.translation_y})`);
                assert(this.R.deck.side === edge && this.R.strip.chips.get(id).open, `${edge} ${id}: deck docks on the rail side and marks its chip (visible ${this.R.deck.visible} key ${this.R.deck.key} side ${this.R.deck.side} open ${this.R.strip.chips.get(id)?.open} chips ${this.R.strip.keys().length})`);
                for (const child of this.R.deck._content.get_children())
                    assert(child.x >= DECK.padding - 1 && child.x + child.width <= deck.width - DECK.padding + 1, `${edge} ${id}: content respects the padding`);
                assert(this.R.focusTargets().includes(this.R.deck._content.get_last_child().get_first_child()), `${edge} ${id}: footer actions are keyboard reachable`);
                await this.capture(`deck-${edge}-${id}`);
            }
            placements.push({edge, x: rail.x, y: rail.y, width: rail.width, height: rail.height});
            this.R.close();
        }
        this._settings.set_string('edge', 'right');
        await delay(400);
        done('tick, unfold, rail and every deck on four edges');
        return placements;
    }

    async checkPointer(move) {
        this._settings.set_boolean('always-show', false);
        move(900, 500);
        await delay(700);
        const rail = this.R.actor;
        assert(rail.width === TICK.thickness && rail.height === TICK.length, 'Folded rail is the tick');
        // An idle, folded Ledge draws nothing: count repaints of its own canvases.
        let repaints = 0;
        const watched = this.R.canvases().map(area => [area, area.connect('repaint', () => repaints++)]);
        await delay(2000);
        for (const [area, id] of watched) area.disconnect(id);
        assert(repaints === 0, `Idle folded Ledge must not repaint, saw ${repaints} repaints`);
        done('idle folded repaint count is zero');
        // A pointer crossing the edge leaves before the hover intent fires.
        const sensor = this.R.sensor;
        const tick = [sensor.x + sensor.width / 2, sensor.y + sensor.height / 2];
        move(...tick);
        await delay(30);
        move(900, 500);
        await delay(400);
        assert(!this.R._expanded && rail.width === TICK.thickness, 'A crossing pointer does not unfold the rail');
        // The hot zone reaches 8 px past the tick.
        move(sensor.x + 1, tick[1]);
        await delay(MOTION.hoverIntent + 60);
        assert(this.R._expanded, 'Resting in the hot zone unfolds the rail');
        const firstChip = this.R.strip.actor.get_first_child();
        await delay(700);
        assert(this.R.strip.actor.get_first_child() === firstChip, 'Animation preserves chip actors');
        assert(rail.width === railSize(IDS.length, true).depth && !this.R._timeline, 'Unfold settles at full size');
        // Reverse the fold while it is still in flight.
        move(900, 500);
        await delay(MOTION.foldGrace + 170);
        assert(this.R._length > 0 && this.R._length < 1, `Pointer departure starts folding after the grace period, length ${this.R._length}`);
        move(rail.x + rail.width - 2, rail.y + rail.height / 2);
        await delay(800);
        assert(this.R._length === 1 && !this.R._timeline, 'Re-entry reverses and settles');
        // Hovering a chip opens its deck; moving along the rail switches it.
        const centre = id => {
            const actor = this.R.strip.chips.get(id).actor;
            const [x, y] = actor.get_transformed_position();
            return [x + actor.width / 2, y + actor.height / 2];
        };
        move(...centre('cursor'));
        await delay(300);
        assert(this.R.deck.visible && this.R.deck.key === 'cursor', 'Hovering a chip opens its deck');
        const y0 = this.R.deck.actor.y;
        move(...centre('models'));
        await delay(40);
        move(...centre('training'));
        await delay(320);
        assert(this.R.deck.key === 'training' && this.R.deck.visible, 'Rapid switching selects the latest chip');
        assert(this.R.deck.actor.y !== y0, 'Deck follows the selected chip');
        assert(this.R.deck.actor.translation_x === 0 && this.R.deck.actor.translation_y === 0, 'Deck motion settles');
        await this.capture('hover-deck');
        // The deck holds the rail open; leaving both folds after the grace period.
        move(this.R.deck.actor.x + 40, this.R.deck.actor.y + 40);
        await delay(MOTION.foldGrace + 300);
        assert(this.R.deck.visible && this.R._expanded, 'Pointer inside the deck keeps it open');
        move(900, 500);
        await delay(MOTION.foldGrace + 700);
        assert(!this.R.deck.visible && !this.R._deckMounted && rail.width === TICK.thickness, 'Leaving folds the rail and closes the deck');
        done('hover intent, hot zone, unfold, interrupted fold, chip hover');
        // Keyboard: Tab walks chips and deck controls, Escape closes.
        this._settings.set_boolean('always-show', true);
        await delay(600);
        this.R.toggle();
        await delay(700);
        const chips = [...this.R.strip.chips.values()].map(chip => chip.actor);
        assert(global.stage.get_key_focus() === chips[0] && this.R.deck.key === 'claude', 'Shortcut focuses the first chip and opens its deck');
        const tab = {get_key_symbol: () => Clutter.KEY_Tab, get_state: () => 0};
        this.R.key(tab);
        assert(global.stage.get_key_focus() === chips[1], 'Tab moves between chips');
        for (let i = 0; i < chips.length - 1; i++) this.R.key(tab);
        assert(this.R.deck.actor.contains(global.stage.get_key_focus()), 'Tab reaches the deck controls');
        this.R.key({get_key_symbol: () => Clutter.KEY_Escape, get_state: () => 0});
        assert(!this.R.deck.visible && !global.stage.get_key_focus(), 'Escape closes the deck and drops focus');
        done('keyboard shortcut, Tab order, Escape');
    }

    async checkReducedMotion() {
        const desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const animations = desktop.get_boolean('enable-animations');
        desktop.set_boolean('enable-animations', false);
        await delay(100);
        assert(!St.Settings.get().enable_animations, 'GNOME reduced motion setting propagates');
        this._settings.set_boolean('always-show', false);
        assert(this.R._length === 0 && !this.R._timeline, 'Reduced motion folds immediately');
        this._settings.set_boolean('always-show', true);
        assert(this.R._length === 1 && !this.R._timeline, 'Reduced motion unfolds immediately');
        await delay(100);
        this.R.open('claude');
        await delay(60);
        assert(this.R.deck.actor.translation_x === 0 && this.R.deck._content.opacity === 255, 'Reduced motion places the deck immediately');
        this.R.close(true);
        assert(!this.R.deck.visible, 'Reduced motion closes the deck immediately');
        desktop.set_boolean('enable-animations', animations);
        await delay(100);
        done('reduced motion');
    }

    async checkOverview() {
        this.R.open('cursor');
        Main.overview.show();
        await delay(100);
        assert(!this.R.deck.visible && !this.R._deckMounted, 'Overview cancels and unmounts the deck');
        this.R.open('codex');
        assert(!this.R.deck.visible, 'Overview blocks reopening');
        Main.overview.hide();
        await delay(600);
        assert(!this.R.deck.visible, 'Leaving Overview does not reopen the deck');
        // Fold while entering Overview, then return.
        this._settings.set_boolean('always-show', false);
        await delay(100);
        this.R._setExpanded(true);
        await delay(60);
        Main.overview.show();
        await delay(100);
        assert(!this.R._timeline && this.R._length === 0, 'Overview settles a transient unfold and cancels motion');
        await delay(550);
        Main.overview.hide();
        await delay(650);
        assert(this.attached('right') <= 1 && this.R.actor.width === TICK.thickness, 'Tick returns to the screen edge after Overview');
        for (const edge of EDGES) {
            this._settings.set_string('edge', edge);
            await delay(100);
            Main.overview.show();
            await delay(350);
            assert(!this.R.deck.visible, `${edge}: no deck in Overview`);
            Main.overview.hide();
            await delay(400);
            assert(this.attached(edge) <= 1, `${edge}: tick stays attached after Overview`);
        }
        this._settings.set_string('edge', 'right');
        this._settings.set_boolean('always-show', true);
        await delay(700);
        Main.overview.show();
        await delay(350);
        assert(this.R._expanded && this.R._length === 1, 'Overview preserves always-show mode');
        Main.overview.hide();
        await delay(400);
        assert(!this.R.deck.visible, 'Always-show restores without reopening a deck');
        done('Overview dismissal, fold race, four edges, always-show');
    }

    // Top bar placement: one status area button with the strip, the deck in
    // its menu flush under the bar, aligned to the open chip.
    async checkPanel(pointer, keyboard) {
        const move = (x, y) => pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        const click = () => {
            pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
            pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        };
        const key = keyval => {
            keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.PRESSED);
            keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.RELEASED);
        };
        const centre = actor => {
            const [x, y] = actor.get_transformed_position();
            return [x + actor.width / 2, y + actor.height / 2];
        };
        const chrome = () => ({ui: Main.uiGroup.get_n_children(), tracked: Main.layoutManager._trackedActors.length,
            boxes: ['_leftBox', '_centerBox', '_rightBox'].map(b => Main.panel[b].get_n_children()).join()});
        const edgeChrome = chrome();
        this._settings.set_string('placement', 'panel');
        await delay(600);
        const P = this.R;
        assert(Main.panel.statusArea.ledge === P.button, 'Top bar mode adds one status area button');
        const centreBox = Main.panel._centerBox.get_children();
        assert(centreBox.indexOf(P.button.container) === centreBox.indexOf(Main.panel.statusArea.dateMenu.container) + 1, 'Chips sit right after the clock');
        assert(P.strip.chips.size === IDS.length && [...P.strip.chips.values()].every(c => c.actor.height === Main.panel.height && c.actor.width === CHIP.panelWidth),
            `Every module has a bar-height ${CHIP.panelWidth} px chip, got ${[...P.strip.chips.values()].map(c => `${c.actor.width}x${c.actor.height}`)}; panel ${Main.panel.height}`);
        const clock = Main.panel.statusArea.dateMenu.container;
        const clockCentre = clock.get_transformed_position()[0] + clock.width / 2;
        assert(Math.abs(clockCentre - Main.panel.width / 2) <= 2, `The clock stays centred, at ${clockCentre} of ${Main.panel.width}`);
        const separators = P.strip.actor.get_children().filter(c => c.has_style_class_name('ledge-separator'));
        assert(separators.length === IDS.length - 1 && separators.every(s => s.width === 1), 'Chips are separated by 1 px hairlines');
        const chips = P.strip.chips;
        // The menu paints nothing of its own: no arrow, padding, border, fill or shadow.
        const pointerNode = P.menu.actor.get_theme_node();
        const boxNode = P.menu.box.get_theme_node();
        assert(['-arrow-rise', '-arrow-base', '-arrow-border-radius', '-arrow-border-width', '-boxpointer-gap'].every(p => pointerNode.get_length(p) === 0), 'Box pointer has no arrow or gap');
        const fill = boxNode.get_background_color();
        assert(fill.alpha === 0 && !boxNode.get_box_shadow() && [St.Side.TOP, St.Side.RIGHT, St.Side.BOTTOM, St.Side.LEFT].every(side =>
            boxNode.get_padding(side) === 0 && boxNode.get_border_width(side) === 0), 'Menu box has no fill, shadow, padding or border');
        await this.capture('panel', {x: 0, y: 0, width: 1920, height: Main.panel.height + PAD});
        // Hovered, focused or open, the button itself stays unfilled.
        for (const pseudo of ['hover', 'active', 'focus', 'checked']) {
            P.button.add_style_pseudo_class(pseudo);
            const node = P.button.get_theme_node();
            assert(node.get_background_color().alpha === 0 && !node.get_box_shadow(), `Top bar button paints nothing when ${pseudo}`);
            P.button.remove_style_pseudo_class(pseudo);
        }
        done('top bar strip after the clock, menu without chrome');

        // Click opens the deck flush under the bar, aligned to the chip.
        move(...centre(chips.get('cursor').actor));
        await delay(120);
        click();
        await delay(300);
        assert(P.menu.isOpen && P.deck.visible && P.deck.key === 'cursor', 'Clicking a chip opens its deck');
        const deck = P.deck.actor;
        const [dx, dy] = deck.get_transformed_position();
        const panelBottom = Main.panel.get_transformed_position()[1] + Main.panel.height;
        assert(Math.abs(dy - panelBottom) <= 1, `Deck sits flush under the top bar, ${dy} vs ${panelBottom}`);
        assert(Math.abs(dx - chips.get('cursor').actor.get_transformed_position()[0]) <= 1, 'Deck aligns with its chip');
        assert(P.deck.side === 'top' && chips.get('cursor').open, 'Deck rule faces the bar and the chip is marked open');
        const chipFill = chips.get('cursor')._background;
        const chipBottom = chipFill.get_transformed_position()[1] + chipFill.height;
        assert(Math.abs(chipBottom - dy) <= 1, `The open chip meets its deck, chip ends at ${chipBottom}, deck starts at ${dy}`);
        // Hovering another chip switches the open deck, as between panel menus.
        move(...centre(chips.get('github').actor));
        await delay(300);
        assert(P.deck.key === 'github' && P.menu.isOpen, `Hovering another chip switches the deck: key ${P.deck.key}, open ${P.menu.isOpen}, chip hover ${chips.get('github').actor.hover}, button hover ${P.button.hover}, grab ${global.stage.get_grab_actor()}`);
        assert(Math.abs(deck.get_transformed_position()[0] - chips.get('github').actor.get_transformed_position()[0]) <= 1, 'Deck follows the hovered chip');
        key(Clutter.KEY_Escape);
        await delay(200);
        assert(!P.menu.isOpen && !P.deck.visible, 'Escape closes the deck');
        done('click opens, hover switches, Escape closes');

        for (const id of IDS) {
            move(...centre(chips.get(id).actor));
            await delay(100);
            click();
            await delay(300);
            assert(P.deck.visible && P.deck.key === id, `${id}: panel deck opens`);
            const [x, y] = deck.get_transformed_position();
            const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
            assert(x >= area.x && x + deck.width <= area.x + area.width, `${id}: panel deck stays on the monitor`);
            assert(Math.abs(this.footerInsetOf(P.deck) - DECK.padding) <= 1, `${id}: panel deck footer inset`);
            await this.capture(`panel-deck-${id}`, {x: Math.max(0, x - PAD), y: 0, width: DECK.width + 2 * PAD, height: y + deck.height + PAD});
            P.close();
            await delay(150);
        }
        // A click outside closes the deck.
        move(...centre(chips.get('claude').actor));
        await delay(100);
        click();
        await delay(250);
        move(900, 700);
        await delay(100);
        click();
        await delay(250);
        assert(!P.menu.isOpen, 'A click outside closes the deck');
        done('every deck under the top bar');

        // Narrow panels: readouts go first, then one summary chip.
        P.setAvailable(IDS.length * CHIP.compactWidth + IDS.length);
        await delay(200);
        assert(P.strip.mode === 'compact' && [...chips.values()].every(c => c.actor.width === CHIP.compactWidth && !c._column.visible), 'Compact chips keep badge and light');
        await this.capture('panel-compact', {x: 0, y: 0, width: 1920, height: Main.panel.height + PAD});
        P.setAvailable(200);
        await delay(200);
        assert(P.strip.mode === 'summary' && P.strip.summaryActor?.visible && [...chips.values()].every(c => !c.actor.visible), 'Narrow bar shows one summary chip');
        move(...centre(P.strip.summaryActor));
        await delay(100);
        click();
        await delay(300);
        const switcher = P.deck._content.get_first_child();
        assert(P.deck.key === 'cursor' && P.strip._summary.open, `Summary chip opens on the module its light stands for, got ${P.deck.key}`);
        assert(Math.abs(deck.get_transformed_position()[0] - P.strip.summaryActor.get_transformed_position()[0]) <= 1, 'Summary deck aligns with the summary chip');
        assert(P.deck.visible && switcher.get_n_children() === IDS.length && switcher.get_children().every(b => b.has_style_class_name('ledge-switch')), 'Summary deck has a module switcher row');
        switcher.get_child_at_index(5).emit('clicked', 1);
        await delay(250);
        assert(P.deck.key === 'models', 'Switcher changes module');
        const [sx, sy] = deck.get_transformed_position();
        await this.capture('panel-summary', {x: Math.max(0, sx - PAD), y: 0, width: DECK.width + 2 * PAD, height: sy + deck.height + PAD});
        P.close();
        P.setAvailable(null);
        await delay(200);
        assert(P.strip.mode === 'full', 'Wide bar restores full chips');
        done('narrow top bar: compact chips, summary chip, switcher');

        // An idle top bar strip repaints nothing.
        move(900, 700);
        await delay(400);
        let repaints = 0;
        const watched = P.canvases().map(area => [area, area.connect('repaint', () => repaints++)]);
        await delay(2000);
        for (const [area, id] of watched) area.disconnect(id);
        assert(repaints === 0, `Idle top bar strip must not repaint, saw ${repaints}`);
        done('idle top bar repaint count is zero');

        // Switching placement both ways leaves nothing behind.
        const panelChrome = chrome();
        for (let i = 0; i < 5; i++) {
            this._settings.set_string('placement', 'edge');
            await delay(250);
            assert(!Main.panel.statusArea.ledge && this.R.sensor, `Switch ${i}: edge mode has no top bar button`);
            assert(JSON.stringify(chrome()) === JSON.stringify(edgeChrome), `Switch ${i}: edge chrome ${JSON.stringify(chrome())} vs ${JSON.stringify(edgeChrome)}`);
            this._settings.set_string('placement', 'panel');
            await delay(250);
            assert(Main.panel.statusArea.ledge === this.R.button, `Switch ${i}: top bar button is back`);
            assert(JSON.stringify(chrome()) === JSON.stringify(panelChrome), `Switch ${i}: panel chrome ${JSON.stringify(chrome())} vs ${JSON.stringify(panelChrome)}`);
        }
        await this.capture('switch-panel', {x: 0, y: 0, width: 1920, height: Main.panel.height + PAD});
        this._settings.set_string('placement', 'edge');
        await delay(900);
        await this.capture('switch-edge');
        done('placement switch both ways, five times, no leaks');
    }

    footerInsetOf(deck) {
        const footer = deck._content.get_last_child();
        return deck.actor.height - footer.y - footer.height;
    }

    // Session alerts: sound and a short peek of the folded rail; limit
    // notifications at 80 and 100 %; Do Not Disturb silences both.
    async checkAlerts() {
        const src = usageSource();
        const R = this.R;
        // Scripted documents only: the demo reader's own polls could raise alerts too.
        GLib.Source.remove(src._activityPoll);
        src._cancelActivity();
        R.close();
        const alwaysShow = this._settings.get_boolean('always-show');
        this._settings.set_boolean('always-show', false);
        R._setExpanded(false);
        await delay(400);
        const played = [];
        const play = this._play;
        this._play = name => { played.push(name); play.call(this, name); };
        this._settings.set_int('peek-seconds', 1);
        const feed = state => src.ingestActivity({version: 1, providers: [{id: 'claude', sessions: [{id: 'smoke-1', name: 'Smoke', state}]}]});
        feed('busy');
        assert(!played.length && !R._expanded, 'A new busy session raises no alert');
        feed('idle');
        assert(played.join() === 'complete' && R._expanded, 'A finished session plays its sound and peeks the rail');
        await delay(2600);
        assert(R._expanded === R._inside(), `The peek folds again after its seconds: expanded ${R._expanded} inside ${R._inside()} keyboard ${R._keyboardOpen} deck ${R.deck.visible} peek ${R._peek}`);
        feed('waiting');
        assert(played.join() === 'complete,message-new-instant', 'A waiting session plays the waiting sound');
        const banners = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        banners.set_boolean('show-banners', false);
        feed('busy');
        feed('idle');
        assert(played.length === 2, 'Do Not Disturb silences session alerts');
        banners.set_boolean('show-banners', true);
        this._settings.set_string('sound-preview', 'bell');
        assert(played[2] === 'bell' && this._settings.get_string('sound-preview') === '', 'A sound preview plays once and resets');
        this._play = play;

        const tray = MessageTray.getSystemSource();
        const count = () => tray.notifications.filter(n => /^Claude Code (at|limit)/.test(n.title)).length;
        const window = src.readings.find(r => r.id === 'claude').windows[0];
        const used = window.usedPercent;
        const resetsAt = window.resetsAt;
        const before = count();
        for (const percent of [85, 90, 100, 100]) {
            window.usedPercent = percent;
            src._checkLimits();
        }
        assert(count() - before === 2, `Limit alerts fire once at 80 and once at 100, got ${count() - before}`);
        window.usedPercent = used;
        window.resetsAt = new Date(Date.now() + 7 * 86400e3).toISOString();
        src._checkLimits();
        this._settings.set_strv('alerts-muted', ['claude']);
        window.usedPercent = 95;
        src._checkLimits();
        assert(count() - before === 2, 'A muted provider raises no limit alert');
        this._settings.set_strv('alerts-muted', []);
        window.usedPercent = used;
        window.resetsAt = resetsAt;
        this._settings.set_boolean('always-show', alwaysShow);
        src._activityPoll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            src.refreshActivity();
            return GLib.SOURCE_CONTINUE;
        });
        await delay(400);
        done('alerts');
    }

    // Usage depth: an extra account gets its own chip after the default,
    // chips reorder by the chosen mode, decks show pace and spend, and a
    // pinned deck stays open after the pointer leaves.
    async checkAccounts(move) {
        const R = this.R;
        const keys = () => R.strip.keys().slice(0, 4).join();
        this._settings.set_strv('hidden-accounts', []);
        await delay(300);
        assert(keys() === 'claude,claude:work,cursor,codex', `An extra account follows its default sign-in, got ${keys()}`);
        assert(R.strip.chips.get('claude:work').info.badge === 'CW', 'An extra account has its own monogram');
        this._settings.set_string('usage-order', 'remaining');
        await delay(300);
        // Demo: work 22 % left, cursor 83, claude 69, codex 77.
        assert(keys() === 'claude:work,claude,codex,cursor', `Least left first, got ${keys()}`);
        this._settings.set_string('usage-order', 'deficit');
        await delay(300);
        const deficits = R.strip.keys().slice(0, 4).map(key => R.strip.chips.get(key).info.usage.deficit);
        assert(deficits.every((d, i) => i === 0 || d === null || deficits[i - 1] === null || deficits[i - 1] >= d), `Furthest ahead of pace first, got ${deficits}`);
        this._settings.set_string('usage-order', 'fixed');
        await delay(300);
        assert(keys() === 'claude,claude:work,cursor,codex', 'Fixed order returns');
        await this.capture('rail-accounts', R.actor);

        R.open('claude:work');
        await delay(400);
        const texts = actor => actor instanceof St.Label ? [actor.text]
            : [...actor instanceof St.Button && actor.label ? [actor.label] : [], ...actor.get_children().flatMap(texts)];
        let shown = texts(R.deck.actor);
        assert(shown.includes('work') || shown.some(t => t.includes('work')), 'The account deck names its account');
        assert(!shown.includes('Spend'), 'Spend shows on the default sign-in only');
        R.open('claude');
        await delay(400);
        shown = texts(R.deck.actor);
        assert(shown.some(t => /pace/.test(t)), 'Deck meters carry a pace caption');
        assert(shown.some(t => t.toLowerCase() === 'spend') && shown.some(t => t.startsWith('estimate at API list prices')), 'Claude deck shows estimated spend');
        this._settings.set_string('reset-format', 'clock');
        await delay(300);
        R.open('claude', true);
        await delay(300);
        assert(texts(R.deck.actor).some(t => /^resets \d\d:\d\d$|^resets [A-Z][a-z]{2} \d\d:\d\d$/.test(t)), 'Clock reset format');
        await this.capture('deck-claude-depth', R.deck.actor);
        this._settings.set_string('reset-format', 'countdown');

        R.open('claude', true);
        await delay(100);
        assert(R.deck.visible, 'Deck open before pinning');
        R.togglePin();
        await delay(400);
        assert(R._pinned && texts(R.deck.actor).includes('unpin'), `Pin shows in the footer: ${R._pinned} ${texts(R.deck.actor).slice(-4)}`);
        move(5, 5);
        await delay(MOTION.foldGrace + 400);
        assert(R.deck.visible, 'A pinned deck stays open after the pointer leaves');
        R.togglePin();
        await delay(MOTION.foldGrace + 600);
        assert(!R.deck.visible, 'Unpinned, it closes once the pointer is away');
        this._settings.set_strv('hidden-accounts', ['claude:work']);
        await delay(300);
        assert(!R.strip.chips.has('claude:work'), 'Hidden accounts leave the strip');
        done('accounts');
    }

    // Local models and Copilot from their demo readings: no server or gh call.
    async checkSources() {
        const R = this.R;
        const texts = actor => actor instanceof St.Label ? [actor.text]
            : [...actor instanceof St.Button && actor.label ? [actor.label] : [], ...actor.get_children().flatMap(texts)];
        R.open('models', true);
        await delay(400);
        let shown = texts(R.deck.actor);
        for (const want of ['llama.cpp', 'slots busy', '1 of 2', '41.7 tok/s', 'requests today · 7 days', '42 · 230'])
            assert(shown.includes(want), `Models deck shows ${want}`);
        assert(R.strip.chips.get('models').info.light === 'working', 'A busy llama.cpp slot lights the models chip');
        R.open('copilot', true);
        await delay(400);
        shown = texts(R.deck.actor);
        assert(shown.includes('Premium requests') && shown.some(t => t.startsWith('192 of 300 left')) && shown.includes('unlimited'), 'Copilot deck shows its quotas');
        assert(R.strip.chips.get('copilot').info.label === '64%', 'Copilot chip shows premium requests left');
        R.open('github', true);
        await delay(400);
        assert(texts(R.deck.actor).some(t => t.includes('Tighten chip spacing')), 'GitHub demo lists pull requests');
        R.close();
        done('sources');
    }

    async runSmoke() {
        await delay(2200);
        Main.overview.hide();
        await delay(700);
        assert(usageSource().readings.filter(p => !p.account).length === 3, 'Three providers must render');
        assert(usageSource().readings.every(p => p.windows.length && p.status === 'ok'), 'Demo readings must succeed');
        assert(usageSource().activities.length === 3, 'Activity demo reader succeeds');
        done('demo reader');
        await this.checkModules();
        await this.checkSources();
        await this.checkThemes();
        await this.checkWorkspaceDismissal();
        await this.checkWrappedWarnings();
        // Real pointer input exercises picking rather than assigned hover flags.
        const pointer = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const move = (x, y) => pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        await this.checkPointer(move);
        const placements = await this.checkEdges(move);
        await this.checkReducedMotion();
        await this.checkOverview();
        await this.checkAlerts();
        await this.checkAccounts(move);
        const keyboard = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        await this.checkPanel(pointer, keyboard);

        this._settings.set_boolean('cursor', false);
        await delay(600);
        assert(usageSource().readings.filter(p => !p.account).length === 2 && !usageSource().readings.some(p => p.id === 'cursor'), 'Disabled provider disappears');
        assert(!this.R.strip.chips.has('cursor') && this.R.strip.chips.size === IDS.length - 1, 'Disabled module loses its chip');
        assert(this.R.actor.height === railSize(IDS.length - 1, true).length, 'Rail shortens to fit');
        done('provider disable');

        this._settings.set_string('theme', 'frosted-dark');
        const prefs = Gio.Subprocess.new(['/usr/bin/gjs', '-m', `${this.path}/prefs-smoke.js`, this.path], Gio.SubprocessFlags.NONE);
        await delay(1000);
        await this.capture('prefs', {x: 0, y: 0, width: global.stage.width, height: global.stage.height});
        this._settings.set_string('theme', 'midnight');
        await new Promise((resolve, reject) => prefs.wait_check_async(null, (p, result) => {
            try { p.wait_check_finish(result); resolve(); } catch (error) { reject(error); }
        }));
        assert(GLib.file_test(`${output}/prefs.json`, GLib.FileTest.EXISTS), 'Preferences constructed and presented');
        done('preferences window');

        // Disable while the rail is moving and a deck is open.
        this._settings.set_boolean('always-show', false);
        await delay(40);
        this.R.open('claude');
        const rail = this.R;
        super.disable();
        assert(!rail._timeline && !rail._intent && !rail._grace && !rail._idle && !this._changeIdle && !usageSource() && !this._modules.size && !this._placement,
            'Disable releases owned resources');
        done('disable');
        super.enable();
        await delay(600);
        assert(usageSource().readings.filter(p => !p.account).length === 2, 'Re-enable works');
        this._settings.set_boolean('always-show', true);
        await delay(700);
        await this.checkWorkspaceDismissal();
        super.disable();
        done('re-enable');
        GLib.file_set_contents(`${output}/result.json`, JSON.stringify({ok: true, placements, checks, crops}));
    }
}
