// Run with: gjs -m tests/helpers.gjs.js
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import {run} from '../lib/subprocess.js';
import {getJson, closeHttp} from '../lib/http.js';

const assert = (value, message) => { if (!value) throw new Error(message); };
const alive = tag => new TextDecoder().decode(GLib.spawn_command_line_sync(`pgrep -f "^/bin/sleep ${tag}$"`)[1]).trim() !== '';
const later = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE; }));

let r = await run(['/bin/echo', 'hi']);
assert(r.ok && r.status === 0 && r.stdout === 'hi\n', 'echo succeeds');
r = await run(['/bin/sh', '-c', 'echo oops >&2; exit 4'], {stderr: true});
assert(!r.ok && r.status === 4 && r.stderr === 'oops\n', 'exit status and stderr are reported');
r = await run(['/nonexistent/ledge-test']);
assert(!r.ok && r.error, 'missing binary resolves with an error');

const started = Date.now();
r = await run(['/bin/sleep', '41'], {timeout: 1});
assert(!r.ok && Date.now() - started < 3000, 'timeout ends the process');
await later(100);
assert(!alive(41), 'timed out process is gone');

const cancel = new Gio.Cancellable();
const pending = run(['/bin/sleep', '42'], {cancellable: cancel});
await later(200);
cancel.cancel();
r = await pending;
await later(100);
assert(!r.ok && !alive(42), 'cancel kills the process');

const early = new Gio.Cancellable();
early.cancel();
r = await run(['/bin/sleep', '43'], {cancellable: early});
await later(100);
assert(!r.ok && !alive(43), 'an already cancelled run does not leak a process');

const server = new Soup.Server();
server.add_handler('/ok', (_s, msg) => {
    msg.set_status(200, null);
    msg.set_response('application/json', Soup.MemoryUse.COPY, new TextEncoder().encode('{"hello":1}'));
});
server.add_handler('/moved', (_s, msg) => {
    msg.set_redirect(302, 'http://example.com/');
});
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
const port = GLib.Uri.parse(server.get_uris()[0].to_string(), GLib.UriFlags.NONE).get_port();

r = await getJson(`http://127.0.0.1:${port}/ok`);
assert(r.ok && r.data.hello === 1, 'local JSON is read');
r = await getJson(`http://localhost:${port}/moved`);
assert(!r.ok && r.status === 302, 'redirects are not followed');
r = await getJson('https://example.com/');
assert(!r.ok && /Refused/.test(r.error.message), 'non-local hosts are refused');
r = await getJson('http://127.0.0.1:1/', {timeout: 2});
assert(!r.ok && r.error, 'closed port resolves with an error');
server.disconnect();
closeHttp();
print('helpers: ok');
