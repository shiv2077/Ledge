import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {parseRepos} from './model.js';

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
}
