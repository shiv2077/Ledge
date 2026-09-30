import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];
const MAX_BYTES = 1 << 20;
let session = null;

// Localhost-only JSON over HTTP. Resolves, never rejects, with
// {ok, status, data, error}. Other hosts and redirects are refused, and the
// system proxy is bypassed so requests never leave the machine.
export function request(method, url, {body = null, timeout = 10, cancellable = null} = {}) {
    return new Promise(resolve => {
        let uri;
        try {
            uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
        } catch (error) {
            resolve({ok: false, status: 0, data: null, error});
            return;
        }
        if (uri.get_scheme() !== 'http' || !LOCAL_HOSTS.includes(uri.get_host())) {
            resolve({ok: false, status: 0, data: null, error: new Error(`Refused non-local URL ${url}`)});
            return;
        }
        session ??= new Soup.Session({proxy_resolver: Gio.SimpleProxyResolver.new(null, null)});
        const message = Soup.Message.new_from_uri(method, uri);
        message.set_flags(Soup.MessageFlags.NO_REDIRECT);
        if (body !== null)
            message.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
        // A private cancellable lets the timeout abort this request alone.
        const cancel = new Gio.Cancellable();
        const parent = cancellable?.connect(() => cancel.cancel()) ?? 0;
        let timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeout, () => {
            timer = 0;
            cancel.cancel();
            return GLib.SOURCE_REMOVE;
        });
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancel, (s, result) => {
            if (timer) GLib.Source.remove(timer);
            timer = 0;
            if (parent) cancellable.disconnect(parent);
            try {
                const bytes = s.send_and_read_finish(result);
                if (bytes.get_size() > MAX_BYTES) throw new Error('Response too large');
                const status = message.get_status();
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data() ?? new Uint8Array()));
                resolve({ok: status >= 200 && status < 300, status, data, error: null});
            } catch (error) {
                resolve({ok: false, status: message.get_status(), data: null, error});
            }
        });
    });
}

export const getJson = (url, options) => request('GET', url, options);
export const postJson = (url, body, options) => request('POST', url, {...options, body});

// Called from disable(): drops pooled connections.
export function closeHttp() {
    session?.abort();
    session = null;
}
