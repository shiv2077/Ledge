import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Runs argv without blocking the shell. Resolves, never rejects, with
// {ok, status, stdout, stderr, error}. The process receives `signal` when the
// timeout expires or the cancellable fires; status is -1 unless it exited.
export function run(argv, {timeout = 10, signal = 9, cancellable = null, stderr = false} = {}) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE |
                (stderr ? Gio.SubprocessFlags.STDERR_PIPE : Gio.SubprocessFlags.STDERR_SILENCE));
        } catch (error) {
            resolve({ok: false, status: -1, stdout: '', stderr: '', error});
            return;
        }
        let watchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeout, () => {
            watchdog = 0;
            proc.send_signal(signal);
            return GLib.SOURCE_REMOVE;
        });
        // GJS maps this to g_cancellable_connect, which also fires if already cancelled.
        const cancelled = cancellable?.connect(() => proc.send_signal(signal)) ?? 0;
        proc.communicate_utf8_async(null, cancellable, (p, result) => {
            if (watchdog) GLib.Source.remove(watchdog);
            watchdog = 0;
            if (cancelled) cancellable.disconnect(cancelled);
            try {
                const [, out, err] = p.communicate_utf8_finish(result);
                resolve({ok: p.get_successful(), status: p.get_if_exited() ? p.get_exit_status() : -1,
                    stdout: out ?? '', stderr: err ?? '', error: null});
            } catch (error) {
                resolve({ok: false, status: -1, stdout: '', stderr: '', error});
            }
        });
    });
}
