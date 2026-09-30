import GLib from 'gi://GLib';
import {Module} from '../lib/module.js';
import {readText, writeText, ensureDir, dataDir} from '../lib/files.js';
import {parseTodos, sortTodos} from '../model.js';
import {MODULE_COLORS} from '../design.js';

export class TodoModule extends Module {
    static id = 'todo';
    static title = 'Todo';

    start() {
        this._path = `${dataDir()}/todos.json`;
        this._todos = null;
        this._message = '';
        this._load();
    }

    async _load() {
        const {text, missing, error} = await readText(this._path, this.cancellable);
        if (this.cancellable.is_cancelled()) return;
        this._todos = [];
        if (!missing && error) this._message = `Could not read todos: ${error.message}`.slice(0, 200);
        else if (!missing) {
            try {
                this._todos = parseTodos(text);
            } catch {
                // Keep the unreadable file for the user and start empty.
                const backup = `${this._path}.bad-${Math.floor(Date.now() / 1000)}`;
                const failed = await writeText(backup, text, this.cancellable);
                this._message = failed ? 'The todo file was unreadable and could not be backed up.'
                    : `The todo file was unreadable. It was saved as ${GLib.path_get_basename(backup)}.`;
            }
        }
        this.changed();
    }

    // Writes are serialised; edits made during a write are saved right after.
    async _save() {
        if (this._saving) { this._dirty = true; return; }
        this._saving = true;
        do {
            this._dirty = false;
            // Not cancellable: a todo added just before disable must still be saved.
            const error = await ensureDir(dataDir()) ?? await writeText(this._path, JSON.stringify(this._todos, null, 1));
            if (this.cancellable.is_cancelled()) return;
            const message = error ? `Could not save todos: ${error.message}`.slice(0, 200) : '';
            if (message !== this._message) { this._message = message; this.changed(); }
        } while (this._dirty);
        this._saving = false;
    }

    _edit(update) {
        if (!this._todos) return;
        this._todos = update(this._todos);
        this.changed();
        this._save();
    }

    _add(text) {
        text = text.trim().slice(0, 500);
        if (!text) return;
        const now = Date.now();
        this._edit(todos => [...todos, {id: `${now}-${Math.random().toString(36).slice(2, 8)}`, text, done: false, created: now}]);
    }

    _open() { return this._todos?.filter(t => !t.done).length ?? 0; }

    cell() {
        const open = this._open();
        return {...super.cell(), icon: 'checkbox-checked-symbolic', accent: MODULE_COLORS.todo,
            label: this._todos ? String(open) : '—', stale: !this._todos,
            accessibleName: `Todo: ${this._todos ? `${open} open` : 'loading'}`};
    }

    card(body, ui) {
        if (this._message) body.add_child(ui.label(this._message, 'ledge-warning'));
        if (!this._todos) {
            body.add_child(ui.label('Loading…', 'ledge-muted'));
            return [];
        }
        const entry = ui.entry('Add a todo and press Enter', text => this._add(text));
        body.add_child(entry);
        ui.autofocus(entry);
        if (!this._todos.length) body.add_child(ui.label('Nothing to do.', 'ledge-muted'));
        for (const todo of sortTodos(this._todos)) {
            const tick = ui.iconButton(todo.done ? 'checkbox-checked-symbolic' : 'checkbox-symbolic',
                todo.done ? `Mark "${todo.text}" open` : `Mark "${todo.text}" done`,
                () => this._edit(todos => todos.map(t => t.id === todo.id ? {...t, done: !t.done} : t)));
            const remove = ui.iconButton('edit-delete-symbolic', `Delete "${todo.text}"`,
                () => this._edit(todos => todos.filter(t => t.id !== todo.id)));
            body.add_child(ui.row(todo.text, {dim: todo.done, leading: [tick], trailing: [remove]}));
        }
        const done = this._todos.length - this._open();
        return done ? [['Clear done', () => this._edit(todos => todos.filter(t => !t.done))]] : [];
    }
}
