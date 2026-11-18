import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {parseRepos} from './model.js';
import {THEME_IDS, THEME_NAMES, GLASS_THEMES, resolveTheme, swatch, rgba, toHex} from './themes.js';

export default class LedgePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        const page = new Adw.PreferencesPage({title: 'Ledge', icon_name: 'utilities-system-monitor-symbolic'});
        window.add(page);

        const group = (title, description = null) => {
            const g = new Adw.PreferencesGroup({title, description});
            page.add(g);
            return g;
        };
        const addSwitch = (g, key, title, subtitle = null) => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            g.add(row);
            return row;
        };
        const addSpin = (g, key, title, subtitle, lower, upper, step, enabledBy = null) => {
            const row = new Adw.SpinRow({title, subtitle, digits: 0,
                adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5})});
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            if (enabledBy) settings.bind(enabledBy, row, 'sensitive', Gio.SettingsBindFlags.GET);
            g.add(row);
            return row;
        };

        this._appearance(page, settings, group);

        const placement = group('Where Ledge lives', 'Super+Shift+L opens Ledge; Escape closes it. Switched-off modules do no work and take no space.');
        // A choice row: `values` are stored in `key`, `labels` are shown.
        const addChoice = (g, key, title, values, labels, subtitle = null) => {
            const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(labels),
                selected: Math.max(0, values.indexOf(settings.get_string(key)))});
            row.connect('notify::selected', () => settings.set_string(key, values[row.selected]));
            g.add(row);
            return row;
        };
        addChoice(placement, 'placement', 'Place', ['shelf', 'panel', 'edge'], ['Top bar lens', 'Top bar chips', 'Screen edge']);
        const panelRows = [
            addChoice(placement, 'panel-box', 'Top bar section', ['left', 'center', 'right'], ['Left', 'Centre', 'Right']),
            addSpin(placement, 'panel-position', 'Position in section', '−1 places it right after the clock in the centre, or last in other sections.', -1, 64, 1),
            addSwitch(placement, 'panel-open-on-hover', 'Open on hover', 'Otherwise, click a chip to open its deck.'),
        ];
        const edgeRows = [
            addChoice(placement, 'edge', 'Screen edge', ['top', 'right', 'bottom', 'left'], ['Top', 'Right', 'Bottom', 'Left']),
            addSpin(placement, 'monitor', 'Monitor', '−1 follows the primary monitor; 0 is the first monitor.', -1, 32, 1),
            addSwitch(placement, 'always-show', 'Always unfolded', 'Otherwise, rest the pointer on the tick at the screen edge to unfold the rail.'),
        ];
        // Only the options for the chosen place are shown.
        const syncPlacement = () => {
            const place = settings.get_string('placement');
            for (const row of panelRows) row.visible = place === 'panel';
            for (const row of edgeRows) row.visible = place === 'edge';
        };
        settings.connect('changed::placement', syncPlacement);
        syncPlacement();

        const usage = group('Coding usage', 'Uses existing tool sign-ins. Turning a source off stops reads and removes its cached reading.');
        addSwitch(usage, 'claude', 'Claude Code', 'Reads the local Claude OAuth credential; run Claude to refresh an expired sign-in.');
        addSwitch(usage, 'cursor', 'Cursor', 'Reads the signed-in editor’s local session, without a second login.');
        addSwitch(usage, 'codex', 'Codex', 'Asks the local Codex app server; falls back to dated rollout readings.');
        addSpin(usage, 'poll-seconds', 'Refresh interval', 'Seconds. Provider rate-limit backoff still applies.', 60, 1800, 60);
        addSwitch(usage, 'demo', 'Demo readings', 'Uses sample data. No accounts or network are read while enabled.');
        addChoice(usage, 'headline-window', 'Chip shows', ['session', 'weekly', 'tightest'], ['First window', 'Longest window', 'Most used window']);
        addChoice(usage, 'usage-order', 'Chip order', ['fixed', 'remaining', 'deficit'], ['Fixed', 'Least left first', 'Furthest ahead of pace first']);
        addChoice(usage, 'reset-format', 'Reset times', ['countdown', 'clock'], ['Countdown', 'Clock time']);
        addSwitch(usage, 'grey-when-spent', 'Grey out spent chips', 'When the window a chip shows is used up.');
        addSwitch(usage, 'costs', 'Spend estimate', 'Reads token counts from local Claude Code and Codex transcripts, never their text.');
        const hiddenRow = new Adw.EntryRow({title: 'Hidden accounts (keys such as claude:work, comma separated)',
            text: settings.get_strv('hidden-accounts').join(', ')});
        hiddenRow.connect('changed', () => settings.set_strv('hidden-accounts',
            hiddenRow.text.split(',').map(key => key.trim()).filter(Boolean)));
        usage.add(hiddenRow);

        const alerts = group('Alerts', 'When a coding session finishes or needs you. Do Not Disturb silences both.');
        addSwitch(alerts, 'alert-sounds', 'Sounds', 'Play a sound when a session finishes or needs you.');
        addSwitch(alerts, 'limit-notifications', 'Limit notifications', 'Notify at 80 % and 100 % of a usage limit.');
        addSpin(alerts, 'peek-seconds', 'Peek', 'Seconds the edge rail unfolds to show the session; 0 turns it off.', 0, 30, 1);
        const SOUNDS = ['complete', 'message-new-instant', 'bell', 'dialog-information', ''];
        const SOUND_NAMES = ['Complete', 'Message', 'Bell', 'Information', 'None'];
        for (const [key, title] of [['sound-finished', 'Finished sound'], ['sound-waiting', 'Waiting sound']]) {
            const row = addChoice(alerts, key, title, SOUNDS, SOUND_NAMES);
            const play = new Gtk.Button({icon_name: 'media-playback-start-symbolic', valign: Gtk.Align.CENTER,
                tooltip_text: 'Play', css_classes: ['flat']});
            play.connect('clicked', () => settings.set_string('sound-preview', settings.get_string(key)));
            row.add_suffix(play);
        }
        const mutedRow = new Adw.EntryRow({title: 'Muted limit alerts (ids, comma separated: claude, cursor, codex)',
            text: settings.get_strv('alerts-muted').join(', ')});
        mutedRow.connect('changed', () => settings.set_strv('alerts-muted',
            mutedRow.text.split(',').map(id => id.trim()).filter(Boolean)));
        alerts.add(mutedRow);

        const agents = group('Agents', 'Every coding agent at a glance. Super+Shift+N jumps to the one that has waited longest.');
        addSwitch(agents, 'agents', 'Agents', 'Shows working, waiting and idle agents, grouped by worktree.');
        addSwitch(agents, 'agents-status', 'Hook status files', 'Exact states from Claude Code hooks or any script using tools/ledge_agent.py.');
        addSwitch(agents, 'agents-herdr', 'Herdr', 'Agents in Herdr panes, read with herdr api snapshot when Herdr is running.');
        addSwitch(agents, 'agents-claude', 'Claude Code sessions', 'States guessed from session files when no hook reports them.');
        addSwitch(agents, 'agents-codex', 'Codex sessions', 'States guessed from Codex session files.');
        addSwitch(agents, 'agents-processes', 'Running agent tools', 'Agent command-line tools found among your processes; shown as running only.');
        // Read only: Ledge never edits another tool's settings.
        const hooks = new Adw.ActionRow({title: 'Claude Code hooks', subtitle: 'Not checked yet'});
        const check = new Gtk.Button({label: 'Check', valign: Gtk.Align.CENTER});
        check.connect('clicked', () => {
            const file = Gio.File.new_for_path(`${GLib.get_home_dir()}/.claude/settings.json`);
            file.load_contents_async(null, (f, result) => {
                let text = '';
                try { text = new TextDecoder().decode(f.load_contents_finish(result)[1]); } catch { text = ''; }
                const events = ['UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'];
                let missing = events;
                try {
                    const hooksConfig = JSON.parse(text).hooks ?? {};
                    missing = events.filter(e => !JSON.stringify(hooksConfig[e] ?? '').includes('ledge_agent.py'));
                } catch { missing = events; }
                hooks.subtitle = !text ? 'No ~/.claude/settings.json found'
                    : missing.length ? `Missing: ${missing.join(', ')}. Copy tools/hooks/claude-code-settings.json into it.`
                        : 'All four hooks report to Ledge';
            });
        });
        hooks.add_suffix(check);
        agents.add(hooks);

        addSwitch(group('Power'), 'power', 'Power profile', 'Shows and switches the power-profiles-daemon profile.');

        addSwitch(group('Todo'), 'todo', 'Todo list', 'Stored in ~/.local/share/ledge/todos.json.');

        const models = group('Local models');
        addSwitch(models, 'models', 'Loaded models', 'Ollama on port 11434 and the LM Studio server on port 1234, localhost only.');
        addSpin(models, 'models-poll-seconds', 'Check interval', 'Seconds.', 5, 300, 5, 'models');
        addSwitch(models, 'llamacpp', 'llama.cpp server', 'Health, slots and speeds; start llama-server with --slots and --metrics.');
        addSpin(models, 'llamacpp-port', 'llama.cpp port', 'On localhost.', 1, 65535, 1, 'llamacpp');
        addSwitch(models, 'lmstudio-logs', 'LM Studio request counts', 'Counts requests in ~/.lmstudio/server-logs; request text is never read into Ledge.');

        const github = group('GitHub', 'Uses the gh command line tool and its sign-in. Ledge stores no token.');
        addSwitch(github, 'copilot', 'Copilot quota', 'Premium requests left this month, read with gh api.');
        addSwitch(github, 'github', 'Pull requests and CI', 'Review requests, your open pull requests, and the latest CI run per watched repository.');
        const repos = new Adw.EntryRow({title: 'Watched repositories (owner/name, comma separated)',
            text: settings.get_strv('github-repos').join(', '), show_apply_button: true});
        repos.connect('apply', () => {
            const valid = parseRepos(repos.text);
            settings.set_strv('github-repos', valid);
            repos.text = valid.join(', ');
        });
        settings.bind('github', repos, 'sensitive', Gio.SettingsBindFlags.GET);
        github.add(repos);
        addSpin(github, 'github-poll-seconds', 'Check interval', 'Seconds.', 60, 3600, 60, 'github');

        const training = group('Training runs', 'Training scripts report progress with tools/ledge_status.py to ~/.local/share/ledge/runs/.');
        addSwitch(training, 'training', 'Training watcher', 'Notifies when a run finishes, crashes or stalls.');
        addSpin(training, 'training-stall-minutes', 'Stalled after', 'Minutes without an update while running.', 1, 240, 1, 'training');
    }

    // Theme picker with swatches, then options for the selected theme only.
    _appearance(page, settings, group) {
        const appearance = group('Appearance', 'Changes apply immediately, including to an open deck.');
        const desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const hasAccent = desktop.settings_schema.has_key('accent-color');
        const tokensFor = theme => resolveTheme({
            theme,
            custom: {background: settings.get_string('custom-background'), card: settings.get_string('custom-card'),
                text: settings.get_string('custom-text'), highlight: settings.get_string('custom-highlight'), opacity: settings.get_double('custom-opacity')},
            glass: {blur: settings.get_int('glass-blur'), tint: settings.get_double('glass-tint'), brightness: settings.get_double('glass-brightness')},
            desktop: {colorScheme: desktop.get_string('color-scheme'), gtkTheme: desktop.get_string('gtk-theme'),
                accentColor: hasAccent ? desktop.get_string('accent-color') : null},
        });

        // Swatch: rail, deck, highlight and text as four stripes with a cut corner.
        const swatches = [];
        const makeSwatch = () => {
            const area = new Gtk.DrawingArea({content_width: 44, content_height: 18, valign: Gtk.Align.CENTER});
            area.set_draw_func((_a, cr, w, h) => {
                const colors = swatch(tokensFor(area._theme ?? 'midnight'));
                cr.moveTo(0, 0);
                cr.lineTo(w - 4, 0);
                cr.lineTo(w, 4);
                cr.lineTo(w, h);
                cr.lineTo(0, h);
                cr.closePath();
                cr.clip();
                colors.forEach((color, i) => {
                    cr.setSourceRGBA(...rgba(color));
                    cr.rectangle(i * w / colors.length, 0, w / colors.length + 1, h);
                    cr.fill();
                });
            });
            swatches.push(area);
            return area;
        };
        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (_f, item) => {
            const box = new Gtk.Box({spacing: 10});
            box.append(makeSwatch());
            box.append(new Gtk.Label({xalign: 0}));
            item.set_child(box);
        });
        factory.connect('bind', (_f, item) => {
            // The item, not its position: the row's current-value display is
            // not at the item's list position.
            const name = item.get_item().get_string();
            const id = THEME_IDS.find(theme => THEME_NAMES[theme] === name);
            const [area, label] = [item.get_child().get_first_child(), item.get_child().get_last_child()];
            area._theme = id;
            area.queue_draw();
            label.label = THEME_NAMES[id];
        });
        const picker = new Adw.ComboRow({title: 'Theme', model: Gtk.StringList.new(THEME_IDS.map(id => THEME_NAMES[id])), factory,
            selected: Math.max(0, THEME_IDS.indexOf(settings.get_string('theme')))});
        picker.connect('notify::selected', () => settings.set_string('theme', THEME_IDS[picker.selected]));
        appearance.add(picker);

        const custom = [];
        const addColor = (key, title) => {
            const button = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog({with_alpha: false}), valign: Gtk.Align.CENTER});
            const color = new Gdk.RGBA();
            if (color.parse(settings.get_string(key))) button.rgba = color;
            button.connect('notify::rgba', () => settings.set_string(key, toHex([button.rgba.red, button.rgba.green, button.rgba.blue])));
            const row = new Adw.ActionRow({title, activatable_widget: button});
            row.add_suffix(button);
            appearance.add(row);
            custom.push(row);
        };
        const addScale = (key, title, subtitle, lower, upper, step, digits) => {
            const adjustment = new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5});
            settings.bind(key, adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
            const scale = new Gtk.Scale({adjustment, digits, draw_value: true, value_pos: Gtk.PositionType.RIGHT,
                hexpand: true, width_request: 220, valign: Gtk.Align.CENTER});
            const row = new Adw.ActionRow({title, subtitle});
            row.add_suffix(scale);
            appearance.add(row);
            return row;
        };
        addColor('custom-background', 'Rail background');
        addColor('custom-card', 'Deck background');
        addColor('custom-text', 'Text');
        addColor('custom-highlight', 'Highlight');
        custom.push(addScale('custom-opacity', 'Background opacity', 'Raised automatically if text would be hard to read.', 0.3, 1, 0.05, 2));

        const glass = [
            addScale('glass-blur', 'Blur strength', 'Blur radius in pixels.', 0, 100, 1, 0),
            addScale('glass-tint', 'Tint opacity', 'How much of the theme color covers the blur.', 0.55, 0.95, 0.05, 2),
            addScale('glass-brightness', 'Backdrop brightness', 'Dims what shows through the glass.', 0.5, 1, 0.05, 2),
        ];

        const sync = () => {
            const theme = settings.get_string('theme');
            for (const row of custom) row.visible = theme === 'custom';
            for (const row of glass) row.visible = GLASS_THEMES.includes(theme);
            for (const area of swatches) area.queue_draw();
        };
        settings.connect('changed', (_s, key) => { if (/^(theme|custom-|glass-)/.test(key)) sync(); });
        desktop.connect('changed', () => sync());
        page._desktopSettings = desktop;
        sync();
    }
}
