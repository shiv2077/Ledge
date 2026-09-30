import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GIRepository from 'gi://GIRepository';

GIRepository.Repository.prepend_search_path('/usr/lib/gnome-shell/girepository-1.0');
GIRepository.Repository.prepend_library_path('/usr/lib/gnome-shell');
Gio.resources_register(Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource'));
const root = ARGV[0];
const {default: Preferences} = await import(`file://${root}/prefs.js`);
const [, bytes] = GLib.file_get_contents(`${root}/metadata.json`);
const metadata = {...JSON.parse(new TextDecoder().decode(bytes)), path: root, dir: Gio.File.new_for_path(root)};
const app = new Adw.Application({application_id: 'local.ledge.Smoke'});
app.connect('activate', () => {
    const window = new Adw.PreferencesWindow({application: app, default_width: 640, default_height: 720});
    new Preferences(metadata).fillPreferencesWindow(window);
    window.present();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
        GLib.file_set_contents(`${GLib.getenv('LEDGE_SMOKE_OUTPUT')}/prefs.json`, '{"ok":true}');
        window.close();
        app.quit();
        return GLib.SOURCE_REMOVE;
    });
});
app.run([]);
