import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
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

        const placement = group('Placement', 'Super+Shift+L opens the notch; Escape closes it. Switched-off widgets do no work and the notch shortens to fit.');
        const edges = ['top', 'right', 'bottom', 'left'];
        const edge = new Adw.ComboRow({title: 'Screen edge', model: Gtk.StringList.new(['Top', 'Right', 'Bottom', 'Left']), selected: edges.indexOf(settings.get_string('edge'))});
        edge.connect('notify::selected', () => settings.set_string('edge', edges[edge.selected]));
        placement.add(edge);
        addSpin(placement, 'monitor', 'Monitor', '−1 follows the primary monitor; 0 is the first monitor.', -1, 32, 1);
        addSwitch(placement, 'always-show', 'Always expanded', 'Otherwise, hover over the small edge pill to unfold it.');

        const usage = group('Coding usage', 'Uses existing tool sign-ins. Turning a source off stops reads and removes its cached reading.');
        addSwitch(usage, 'claude', 'Claude Code', 'Reads the local Claude OAuth credential; run Claude to refresh an expired sign-in.');
        addSwitch(usage, 'cursor', 'Cursor', 'Reads the signed-in editor’s local session, without a second login.');
        addSwitch(usage, 'codex', 'Codex', 'Asks the local Codex app server; falls back to dated rollout readings.');
        addSpin(usage, 'poll-seconds', 'Refresh interval', 'Seconds. Provider rate-limit backoff still applies.', 60, 1800, 60);
        addSwitch(usage, 'demo', 'Demo readings', 'Uses sample data. No accounts or network are read while enabled.');

        addSwitch(group('Power'), 'power', 'Power profile', 'Shows and switches the power-profiles-daemon profile.');

        addSwitch(group('Todo'), 'todo', 'Todo list', 'Stored in ~/.local/share/ledge/todos.json.');

        const models = group('Local models');
        addSwitch(models, 'models', 'Loaded models', 'Ollama on port 11434 and the LM Studio server on port 1234, localhost only.');
        addSpin(models, 'models-poll-seconds', 'Check interval', 'Seconds.', 5, 300, 5, 'models');

        const github = group('GitHub', 'Uses the gh command line tool and its sign-in. Ledge stores no token.');
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
        const appearance = group('Appearance', 'Changes apply immediately, including to an open card.');
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

        // Swatch: notch, card, highlight and text as four rounded stripes.
        const swatches = [];
        const makeSwatch = () => {
            const area = new Gtk.DrawingArea({content_width: 44, content_height: 18, valign: Gtk.Align.CENTER});
            area.set_draw_func((_a, cr, w, h) => {
                const colors = swatch(tokensFor(area._theme ?? 'midnight'));
                cr.arc(h / 2, h / 2, h / 2, Math.PI / 2, Math.PI * 1.5);
                cr.arc(w - h / 2, h / 2, h / 2, -Math.PI / 2, Math.PI / 2);
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
        addColor('custom-background', 'Notch background');
        addColor('custom-card', 'Card background');
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
