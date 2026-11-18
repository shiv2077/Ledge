import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {readText} from './files.js';
import {parentPid, matchCodexPid} from './alerts.js';

// How far up the process tree a session's window is looked for.
const MAX_STEPS = 32;
const CODEX = /(^|\/)codex(\.js)?$/;
const PROC_ATTRIBUTES = 'standard::name,unix::uid';

const windowFor = pid => global.get_window_actors().map(actor => actor.meta_window)
    .find(window => window.get_pid() === pid) ?? null;

// The window that runs `pid`, found by walking up its parents: a terminal
// or editor owns the window, the session is a child process of it.
export async function windowForPid(pid, cancellable = null) {
    let current = pid;
    for (let step = 0; step < MAX_STEPS && current > 1; step++) {
        const window = windowFor(current);
        if (window) return window;
        const {text} = await readText(`/proc/${current}/stat`, cancellable);
        if (text === null) return null;
        current = parentPid(text);
        if (current === null) return null;
    }
    return null;
}

export function children(directory, cancellable) {
    return new Promise(resolve => {
        directory.enumerate_children_async(PROC_ATTRIBUTES, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_LOW, cancellable, (file, result) => {
                try {
                    const enumerator = file.enumerate_children_finish(result);
                    const infos = [];
                    const next = () => enumerator.next_files_async(64, GLib.PRIORITY_LOW, cancellable, (e, r) => {
                        try {
                            const batch = e.next_files_finish(r);
                            if (!batch.length) {
                                e.close_async(GLib.PRIORITY_LOW, null, null);
                                resolve(infos);
                                return;
                            }
                            infos.push(...batch);
                            next();
                        } catch {
                            resolve(infos);
                        }
                    });
                    next();
                } catch {
                    resolve([]);
                }
            });
    });
}

export function linkTarget(path, cancellable) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).query_info_async('standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_LOW, cancellable, (file, result) => {
                try { resolve(file.query_info_finish(result).get_symlink_target()); } catch { resolve(null); }
            });
    });
}

// The pid of this user's Codex process working in `cwd`, or null. Only the
// command line's first word and the working folder are read.
export async function codexPid(cwd, cancellable = null) {
    if (!cwd) return null;
    const uid = new Gio.Credentials().get_unix_user();
    const candidates = [];
    for (const info of await children(Gio.File.new_for_path('/proc'), cancellable)) {
        const pid = Number(info.get_name());
        if (!Number.isInteger(pid) || pid <= 0 || info.get_attribute_uint32('unix::uid') !== uid) continue;
        const {text} = await readText(`/proc/${pid}/cmdline`, cancellable);
        const args = (text ?? '').split('\0');
        // `node /path/to/codex` runs the CLI through its interpreter.
        if (!CODEX.test(args[0]) && !CODEX.test(args[1] ?? '')) continue;
        const folder = await linkTarget(`/proc/${pid}/cwd`, cancellable);
        if (folder) candidates.push({pid, cwd: folder});
    }
    return matchCodexPid(candidates, cwd);
}

// Raises the window that runs `session` ({pid} or, for Codex, {cwd}).
// Resolves true when a window was activated.
export async function raiseSession(session, cancellable = null) {
    const pid = Number.isInteger(session?.pid) && session.pid > 0 ? session.pid : await codexPid(session?.cwd, cancellable);
    if (!pid || cancellable?.is_cancelled()) return false;
    const window = await windowForPid(pid, cancellable);
    if (!window || cancellable?.is_cancelled()) return false;
    Main.activateWindow(window);
    return true;
}
