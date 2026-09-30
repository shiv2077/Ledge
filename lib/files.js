import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MAX_BYTES = 1 << 20;

// Resolves {text, missing, error}; never rejects.
export function readText(path, cancellable = null) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).load_contents_async(cancellable, (file, result) => {
            try {
                const [, bytes] = file.load_contents_finish(result);
                if (bytes.length > MAX_BYTES) throw new Error('File too large');
                resolve({text: new TextDecoder().decode(bytes), missing: false, error: null});
            } catch (error) {
                resolve({text: null, missing: error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) ?? false, error});
            }
        });
    });
}

// Atomic write: GIO writes a temporary file beside the target and renames it
// over the target on success, so readers never see a partial file.
export function writeText(path, text, cancellable = null) {
    return new Promise(resolve => {
        const bytes = new GLib.Bytes(new TextEncoder().encode(text));
        Gio.File.new_for_path(path).replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.PRIVATE, cancellable, (file, result) => {
                try {
                    file.replace_contents_finish(result);
                    resolve(null);
                } catch (error) {
                    resolve(error);
                }
            });
    });
}

// Creates the directory and any missing parents. Resolves an error or null.
export function ensureDir(path, cancellable = null) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).make_directory_async(GLib.PRIORITY_DEFAULT, cancellable, async (file, result) => {
            try {
                file.make_directory_finish(result);
                resolve(null);
            } catch (error) {
                if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) resolve(null);
                else if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) && file.get_parent())
                    resolve(await ensureDir(file.get_parent().get_path(), cancellable) ?? await ensureDir(path, cancellable));
                else resolve(error);
            }
        });
    });
}

export const dataDir = () => `${GLib.get_user_data_dir()}/ledge`;
